// What the machine is doing, for the studio's status bar: its CPU (all its cores) and each GPU's use, where the system or
// the GPU's driver says, read the way this machine allows (found when watching starts; a GPU none of them reads is left
// out, not guessed):
//   Linux: a card's own busy figure (gpu_busy_percent: amdgpu), else its clients' engine time in /proc/<pid>/fdinfo
//          (drm-usage-stats: Intel, nouveau and others), else for NVIDIA's cards, whose driver reports neither,
//          nvidia-smi (one process for as long as it is watched, a reading a second).
//   macOS: IOKit's registry (ioreg), every 2 s.
// And what the studio itself takes, every process under it counted once (appMeter, where the system says: Linux and macOS).
// Commands run without a shell, with fixed arguments.
//
//   const stop = watchMachine((m) => …, { root, renderers });
//   // m: { cpu: % (0–100), gpus: [{ name, use: % }], app: { cpu: % of all cores, ram: bytes, parts } | null }, about once a second
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const EVERY = 1000;

// ---------- the CPU: the share of its cores' time not idle since the last reading
function cpuMeter() {
  const total = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
  let last = total();
  return () => { const now = total(), d = now.all - last.all, u = d > 0 ? (100 * (now.busy - last.busy)) / d : 0; last = now; return Math.round(u); };
}

// ---------- Linux: the cards under /sys/class/drm, each read its own way
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
// a card's name from the PCI ids database, where the system has one (else its driver's)
function pciName(id, driver) {
  const [ven, dev] = (id ?? '').toLowerCase().split(':');
  for (const f of ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids', '/usr/share/pci.ids']) {
    const t = read(f); if (!t || !ven) continue;
    const at = t.indexOf(`\n${ven}  `); if (at < 0) break;
    const vendor = t.slice(at + 7, t.indexOf('\n', at + 1)).trim();
    for (const line of t.slice(t.indexOf('\n', at + 1) + 1).split('\n')) {
      if (line.startsWith('#') || !line) continue;   // (its comments)
      if (!line.startsWith('\t')) break;
      if (line.startsWith(`\t${dev}  `)) return `${(/\[([^\]/]+)/.exec(vendor) ?? [])[1] ?? vendor.split(/[ ,]/)[0]} ${line.slice(dev.length + 3).trim()}`;   // (its vendor's short name)
    }
    break;
  }
  return `GPU (${driver})`;
}
function linuxCards() {
  const cards = [];
  for (const n of fs.readdirSync('/sys/class/drm').filter((x) => /^card\d+$/.test(x)).sort((a, b) => a.slice(4) - b.slice(4))) {
    const dev = path.join('/sys/class/drm', n, 'device'), ue = read(path.join(dev, 'uevent')) ?? '';
    const driver = (/DRIVER=(.*)/.exec(ue) ?? [])[1], slot = (/PCI_SLOT_NAME=(.*)/.exec(ue) ?? [])[1];
    if (!driver) continue;
    cards.push({ name: pciName((/PCI_ID=(.*)/.exec(ue) ?? [])[1], driver), driver, slot, busy: fs.existsSync(path.join(dev, 'gpu_busy_percent')) ? path.join(dev, 'gpu_busy_percent') : null });
  }
  return cards;
}
// the engine time of every DRM client of the card at PCI slot `slot` that this user can see (each client once, by its
// id), as ns per engine → the busiest engine's share of the time since the last reading
function fdinfoMeter(slot) {
  let last = null, at = 0;
  const sample = () => {
    const per = new Map(), seen = new Set();
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let fds; try { fds = fs.readdirSync(`/proc/${pid}/fdinfo`); } catch { continue; }
      for (const fd of fds) {
        const t = read(`/proc/${pid}/fdinfo/${fd}`);
        if (!t || !t.includes('drm-pdev:') || !t.includes(slot)) continue;
        const id = (/drm-client-id:\s*(\d+)/.exec(t) ?? [])[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        for (const [, e, ns] of t.matchAll(/drm-engine-([\w-]+):\s*(\d+) ns/g)) per.set(e, (per.get(e) ?? 0) + Number(ns));
      }
    }
    return per;
  };
  return () => {
    const now = sample(), t = process.hrtime.bigint();
    let use = null;
    if (last) {
      const dt = Number(t - at);
      use = 0;
      for (const [e, ns] of now) use = Math.max(use, (100 * Math.max(0, ns - (last.get(e) ?? ns))) / dt);
    }
    last = now; at = t;
    return use == null ? null : Math.min(100, Math.round(use));
  };
}
// NVIDIA's cards: one nvidia-smi giving each card's use every second, for as long as it is watched
function nvidiaSmi(onLine) {
  const p = spawn('nvidia-smi', ['--query-gpu=index,name,utilization.gpu', '--format=csv,noheader,nounits', `-lms`, String(EVERY)], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => {});   // (none on this machine)
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  return () => { try { p.kill(); } catch {} };
}

/**
 * The memory of the GPU with the most of it (the one render workers take: WebGPU's high-performance adapter), where this
 * machine says, read the way the status bar reads its use: an AMD card's own figures (mem_info_vram_*), NVIDIA's from
 * nvidia-smi (Linux and Windows). A promise of { total, used } in bytes, or null where none says (Intel's, a Mac's
 * shared memory): then nothing is held back for it.
 */
export async function gpuMemory() {
  const all = [];
  if (process.platform === 'linux') {
    for (const n of fs.readdirSync('/sys/class/drm').filter((x) => /^card\d+$/.test(x))) {
      const dev = path.join('/sys/class/drm', n, 'device'), total = Number(read(path.join(dev, 'mem_info_vram_total'))), used = Number(read(path.join(dev, 'mem_info_vram_used')));
      if (total > 0 && used >= 0) all.push({ total, used });
    }
  }
  if (process.platform === 'linux' || process.platform === 'win32') {
    const out = await new Promise((done) => execFile('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 3000 }, (e, o) => done(e ? '' : o)));
    for (const line of out.split('\n')) {
      const [total, used] = line.split(',').map((s) => Number(s.trim()) * 2 ** 20);
      if (total > 0 && used >= 0) all.push({ total, used });
    }
  }
  return all.sort((a, b) => b.total - a.total)[0] ?? null;
}

// ---------- macOS: each accelerator's model and Device Utilization % in IOKit's registry
function ioreg(done) {
  execFile('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000 }, (e, out) => {
    if (e) return done([]);
    done(out.split(/\n(?=\+-o )/).map((b) => ({ name: (/"model" = "([^"]+)"/.exec(b) ?? [])[1] ?? 'GPU', use: Number((/"Device Utilization %"=(\d+)/.exec(b) ?? [])[1]) })).filter((g) => Number.isFinite(g.use)));
  });
}

// ---------- what the studio takes: the processes under `root`, by what they are for
// Linux: every process's parent and CPU time from /proc/<pid>/stat, and its memory from smaps_rollup: Pss, which splits
// what processes share between them (a Chromium's processes share most of what they map: their sum of RSS came to 9.3 GB
// where this says 4.3). macOS: ps, and top's MEM, the footprint Activity Monitor shows (top takes half a second of CPU, so
// less often). Read off the studio's thread: the processes number in the hundreds, each a read.
const SAMPLE_EVERY = 2000;
const readFile = (f) => fs.promises.readFile(f, 'latin1').catch(() => null);
const run = (cmd, args) => new Promise((done) => execFile(cmd, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => done(e ? '' : out)));
const SYSTEMS = {
  linux: {
    memoryEvery: 3,
    async processes() {
      const all = new Map();
      await Promise.all((await fs.promises.readdir('/proc')).filter((p) => /^\d+$/.test(p)).map(async (p) => {
        const t = await readFile(`/proc/${p}/stat`);
        if (!t) return;   // (ended)
        const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
        all.set(+p, { ppid: +f[1], cpu: (+f[11] + +f[12]) / 100 });   // (utime, stime: in hundredths of a second, as Linux gives them)
      }));
      return all;
    },
    async memory(pids) {
      const by = new Map();
      await Promise.all(pids.map(async (p) => { const kb = /^Pss:\s+(\d+)/m.exec((await readFile(`/proc/${p}/smaps_rollup`)) ?? ''); if (kb) by.set(p, kb[1] * 1024); }));
      return by;
    },
    // (what it was started with, as one line: Chromium's own processes write theirs over their arguments as one string,
    // setproctitle)
    async command(p) { return ((await readFile(`/proc/${p}/cmdline`)) ?? '').replace(/\0/g, ' '); },
  },
  darwin: {
    memoryEvery: 8,
    async processes() {
      const all = new Map();
      for (const line of (await run('ps', ['-axo', 'pid=,ppid=,time='])).split('\n')) {
        const [pid, ppid, time] = line.trim().split(/\s+/);
        if (time) all.set(+pid, { ppid: +ppid, cpu: time.split(':').reduce((a, v) => a * 60 + +v, 0) });
      }
      return all;
    },
    async memory() {
      const by = new Map(), UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
      for (const m of (await run('top', ['-l', '1', '-stats', 'pid,mem'])).matchAll(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/gm)) by.set(+m[1], m[2] * UNIT[m[3]]);
      return by;
    },
  },
};
/** → a function giving the last reading ({ cpu: % of all cores, ram: bytes, parts: { window, viewport, studio, workers, tools }: each
 *  { cpu, ram }, workers: how many }, null before there is one) and stop(), or null where the system has no way to tell.
 *  renderers: the render workers' browsers' own processes; root: the top of it all. */
function appMeter(root, renderers) {
  const system = SYSTEMS[process.platform];
  if (!system) return null;
  const cores = os.cpus().length || 1, used = new Map(), ram = new Map();
  let at = 0, n = 0, app = null, stopped = false;
  const sample = async () => {
    const all = await system.processes(), now = performance.now(), kids = new Map();
    for (const [p, x] of all) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(p); }
    // (each process's part: the window's, the viewport's (the editor's film in a browser of its own, app/viewport.cjs: one
    // the window started, where the system says what it was started with), this process, a render browser's, or anything
    // else this process started)
    const viewport = new Set();
    if (system.command) await Promise.all((kids.get(root) ?? []).map(async (p) => { if (/(^| )--viewport-worker( |$)/.test(await system.command(p))) viewport.add(p); }));
    const of = new Map(), walk = (p, from) => {
      const part = p === process.pid ? 'studio' : from === 'studio' ? (renderers.has(p) ? 'workers' : 'tools') : from === 'window' && viewport.has(p) ? 'viewport' : from;
      of.set(p, part);
      for (const k of kids.get(p) ?? []) walk(k, part);
    };
    walk(root, 'window');
    if (n++ % system.memoryEvery === 0) { const by = await system.memory([...of.keys()]); ram.clear(); for (const [p, b] of by) if (of.has(p)) ram.set(p, b); }
    const parts = {};
    const part = (k) => (parts[k] ??= { cpu: 0, ram: 0 }), share = (s) => (100 * s) / (((now - at) / 1000) * cores);
    for (const [p, k] of of) {
      // (a process new since the last reading used all it has since then)
      if (at) part(k).cpu += share(Math.max(0, all.get(p).cpu - (used.get(p) ?? 0)));
      part(k).ram += ram.get(p) ?? 0;
    }
    used.clear();
    for (const p of of.keys()) used.set(p, all.get(p).cpu);
    if (at) {
      const sum = (key) => Object.values(parts).reduce((a, x) => a + x[key], 0);
      app = { cpu: Math.round(sum('cpu')), ram: sum('ram'), cores, parts: { ...parts, ...(parts.workers && { workers: { ...parts.workers, n: renderers.size } }) } };
    }
    at = now;
  };
  const loop = async () => { while (!stopped) { await sample().catch(() => {}); await new Promise((r) => setTimeout(r, SAMPLE_EVERY)); } };
  loop();
  return { last: () => app, stop: () => { stopped = true; } };
}

/** Calls onSample({ cpu, gpus, app }) about once a second until the returned stop() is called (root and renderers: appMeter's). */
export function watchMachine(onSample, { root = process.pid, renderers = new Set() } = {}) {
  const cpu = cpuMeter(), stops = [], app = appMeter(root, renderers);
  if (app) stops.push(app.stop);
  let gpus = () => [];
  if (process.platform === 'linux') {
    const cards = linuxCards(), nv = new Map();
    if (cards.some((c) => c.driver === 'nvidia')) stops.push(nvidiaSmi((line) => { const [i, name, use] = line.split(',').map((s) => s.trim()); if (Number.isFinite(+use)) nv.set(i, { name, use: +use }); }));
    // (in the system's order of its cards; NVIDIA's numbered among themselves as nvidia-smi numbers them)
    let k = 0;
    const meters = cards.map((c) => (c.driver === 'nvidia' ? { nv: String(k++) } : { c, meter: c.busy ? () => Number(read(c.busy)) : fdinfoMeter(c.slot) }));
    gpus = () => meters.map((x) => (x.nv != null ? nv.get(x.nv) : { name: x.c.name, use: x.meter() })).filter((g) => g && Number.isFinite(g.use));
  } else if (process.platform === 'darwin') {
    let last = [], n = 0;
    gpus = () => { if (n++ % 2 === 0) ioreg((g) => { last = g; }); return last; };
  }
  const timer = setInterval(() => onSample({ cpu: cpu(), gpus: gpus(), app: app?.last() ?? null }), EVERY);
  return () => { clearInterval(timer); for (const s of stops) s(); };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const stop = watchMachine((m) => console.log(JSON.stringify(m)));
  setTimeout(stop, Number(process.argv[2] ?? 5) * 1000);
}

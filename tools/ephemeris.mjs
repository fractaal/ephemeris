// The Ephemeris command line: the studio's tools by project name, with each timeline's own settings (its film page,
// frame rate, shutter and music all come from timelines/<id>.json). <name> is a project's main timeline;
// <name>/<timeline> another of its timelines (e.g. `master my-film/social`).
//
//   ./ephemeris new <name>                 a project from templates/film, its history begun
//   ./ephemeris history <name> [n]         the project's versions (each its timelines and code together), newest first;
//                                          n: what version n changed (--since n: all that changed from it on; --path
//                                          <file>: one file's alone); --restore n: the project brought back to it;
//                                          --tag <tag> [n] [--force]: a version named (the latest where n is left
//                                          out), as a git tag; --untag <tag>. A tag stands for its version anywhere
//   ./ephemeris serve [--port 5320]        the dev server for projects that need nothing but Ephemeris
//   ./ephemeris [studio]                   the studio (http://localhost:5340): the project picker, and each project's editor
//   ./ephemeris nle <name> [--port 5340]   the studio, with <name> open: block out against the music, a live viewer, history
//   ./ephemeris app                        the studio in a window of its own (the desktop app, from this checkout;
//                                          npm run dist builds it whole, Node included: app/build.mjs)
//   ./ephemeris stills <name> <t,t,…>      stills into projects/<name>/renders/stills (--look fast|solid|wire: the viewer's)
//   ./ephemeris check <name> [--momentum] [--pacing]   the quality gates (and two a style can ask for)
//   ./ephemeris profile <name> [t]         what drawing the frame at t takes: the film's code, its layers, each of the
//                                          GPU's passes (tools/profile.mjs), at the timeline's viewer samples, whole
//                                          (--master: its master samples)
//   ./ephemeris master <name>              the full-quality render, with the timeline's music, and a copy to send
//                                          (-share.mp4); its .json is written last, when both are done
//   ./ephemeris snapshot <name>            reference frames (each cue, and every 2.5 s) for compare
//   ./ephemeris compare <name>|--all       did a change to Ephemeris alter a film? (same machine as the snapshot)
//   ./ephemeris take <name> <piece>        a piece of the renderer copied into the film to change as it likes: one of its
//                                          passes (engine/render/passes/<piece>.js) or the WGSL they share (shaders,
//                                          trace), into projects/<name>/render/, its imports pointed back at the studio
//   ./ephemeris mcp [--studio <url>]       the studio's tools for any agent, over MCP (stdio): see tools/mcp.mjs
//   ./ephemeris pi [args]                  Pi, the one the studio's agent can run on, in the workspace: /login signs it in
//                                          (ChatGPT for Codex, or another provider) without a Pi of your own installed
//   ./ephemeris sound <files or folders>   what sounds are like, by numbers (tools/sound.mjs: --tags, --min, --max, --sort, --json)
//   ./ephemeris music <file>               a song's tempo, bars, drops and parts (tools/music.mjs; --json)
//   ./ephemeris pitch <files or folders>   the notes a recording plays, and their tuning (tools/pitch.mjs: --from, --to, --json)
//   ./ephemeris levels <name>              the mix's loudness: the film's, each track's, a voice over the rest; by octave and
//                                          what drives the master (tools/levels.mjs: --spans 0-8,8-24, --bands, --peaks)
//   ./ephemeris depth <name> <images…>     photos cut by depth into layers, into the film's assets/depth (tools/depth.mjs;
//                                          --name, --crop x,y,w,h for one image)
// Extra flags pass through to the tool (e.g. `master my-film --from 20 --to 30`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rendererVersion } from './browser.mjs';
import { workspace, version } from './workspace.mjs';
import { clipEnd, filmPage, samplesOf } from '../nle/model.js';
import { record, versions, changes, diff, restore, when, tags, tag, untag, resolve } from './history.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { migrate } from './migrations/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'studio', name, ...rest] = process.argv.slice(2);
// the films: in the workspace (this checkout, or the folder chosen for them: see workspace.mjs)
const WS = workspace();
const run = (args, o = {}) => process.exit(spawnSync(args[0], args.slice(1), { stdio: 'inherit', cwd: ROOT, ...o }).status ?? 1);
// <name>[/<timeline>]: the project, and which of its timelines (main by default)
const [pname, tid = 'main'] = (name ?? '').split('/');
const dir = (n = pname) => {
  const d = path.join(WS, 'projects', n ?? '');
  if (!n || !fs.existsSync(d)) { console.error(`no project "${n ?? ''}" in ${path.join(WS, 'projects')}`); process.exit(1); }
  return d;
};
const timelineFile = (d) => path.join(d, 'timelines', `${tid}.json`);
const timeline = (d) => {
  try { return migrate(JSON.parse(fs.readFileSync(timelineFile(d), 'utf8'))).doc; } catch { console.error(`no timeline ${path.relative(WS, timelineFile(d))}`); process.exit(1); }   // (in the format of now: tools/migrations)
};
const page = (tl) => filmPage(tl, tl.url, tid);
const tool = (t) => path.join(ROOT, 'tools', t);
const sh = (args) => spawnSync(args[0], args.slice(1), { stdio: 'inherit', cwd: ROOT }).status;
/** The film's page must be served before anything renders it; say how, rather than fail inside the renderer. */
async function served(d, url) {
  try { if ((await fetch(url, { signal: AbortSignal.timeout(4000) })).ok) return; } catch { /* not up */ }
  let how = './ephemeris serve';
  try { const p = JSON.parse(fs.readFileSync(path.join(d, 'project.json'), 'utf8')); if (p.serve) how = `projects/${path.basename(d)}/${p.serve}`; } catch { /* default */ }
  console.error(`the film's page is not being served: ${url}\nstart it first: ${how}`);
  process.exit(1);
}
/** Reference frames: one a beat into every cue, and one every 2.5 s, across the film. */
function referenceTimes(tl) {
  const music = Math.max(0, ...tl.tracks.flatMap((tr) => tr.clips.map(clipEnd)));
  const len = music || Math.max(2, ...tl.cues.map((c) => c.t + c.dur)) + 1;
  const ts = [...tl.cues.map((c) => c.t + 0.3), ...Array.from({ length: Math.floor(len / 2.5) }, (_, k) => 1 + k * 2.5)];
  return [...new Set(ts.filter((t) => t > 0 && t < len - 0.05).map((t) => +t.toFixed(2)))].sort((a, b) => a - b);
}
const stills = (tl, times, out) => sh([process.execPath, tool('render.mjs'), '--url', page(tl), '--stills', times.join(','), '--dir', out, '--fps', String(tl.fps ?? 60), '--sub', '2']);
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const png = (t) => `f${t.toFixed(2).padStart(6, '0')}.png`;

switch (cmd) {
  case 'new': {
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error('usage: ephemeris new <name>  (lowercase, digits, dashes)'); process.exit(1); }
    const d = path.join(WS, 'projects', name);
    if (fs.existsSync(d)) { console.error(`projects/${name} exists`); process.exit(1); }
    await fs.promises.cp(path.join(ROOT, 'templates', 'film'), d, { recursive: true });
    const sha = version();
    for (const f of ['project.json', 'timelines/main.json', 'README.md', 'index.html']) {
      const p = path.join(d, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('{{name}}', name).replaceAll('{{ephemeris}}', sha));
    }
    record(d, `new film from Ephemeris ${sha}`);
    console.log(`projects/${name}: ./ephemeris serve, then ./ephemeris nle ${name}`);
    break;
  }
  case 'history': {
    // (a version by its number or a tag)
    const d = dir(), all = versions(d), at = (x) => all.find((v) => v.n === resolve(d, x));
    const flag = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; }, since = flag('--since');
    const n = rest[0] && !rest[0].startsWith('--') ? (at(rest[0])?.n ?? rest[0]) : null;
    if (flag('--tag') || flag('--untag')) {
      try {
        if (flag('--untag')) { untag(d, flag('--untag')); console.log(`${pname}: the tag "${flag('--untag')}" removed`); break; }
        const name = flag('--tag'), on = rest[rest.indexOf('--tag') + 2], ref = on && !on.startsWith('--') ? (resolve(d, on) ?? on) : undefined;
        console.log(`${pname}: version ${tag(d, name, ref, rest.includes('--force'))[name]} tagged "${name}"`);
      } catch (e) { console.error(`${pname}: ${e.message}`); process.exit(1); }
      break;
    }
    if (flag('--restore')) {
      const to = at(flag('--restore'))?.n;
      if (!to) { console.error(`${pname} has no version ${flag('--restore')}`); process.exit(1); }
      const v = restore(d, to, 'Before restoring a version');
      console.log(v ? `${pname}: version ${to} restored, as version ${v.n}` : `${pname} already is as version ${to} keeps it`);
      break;
    }
    if (n == null && since == null) {
      const named = Object.entries(tags(d));
      for (const [i, v] of [...all.entries()].reverse()) {
        const c = changes(all[i - 1] ?? null, v), t = named.filter(([, x]) => x === v.n).map(([k]) => k);
        console.log(`${String(v.n).padStart(4)}  ${when(v)}  ${t.length ? `(${t.join(', ')})  ` : ''}${v.message.split('\n')[0]}  [${[...c.changed, ...c.added.map((f) => `+${f}`), ...c.removed.map((f) => `-${f}`)].join(', ')}]`);
      }
      break;
    }
    const [a, b] = n != null ? [at(n - 1) ?? null, at(n)] : [at(since), all.at(-1)];
    if (!b || a === undefined) { console.error(`${pname} has no version ${n ?? since}`); process.exit(1); }
    process.stdout.write(diff(d, a, b, flag('--path')));
    break;
  }
  case 'take': {
    // (what can be taken: each pass's file, and the shared WGSL a film's render.lib may replace parts of)
    const R = path.join(ROOT, 'engine', 'render'), piece = rest[0];
    const pieces = [...fs.readdirSync(path.join(R, 'passes')).filter((f) => f.endsWith('.js')).map((f) => `passes/${f}`), 'shaders.js', 'trace.js'];
    const src = pieces.find((f) => path.basename(f, '.js') === piece);
    const d = dir();
    if (!src) { console.error(`usage: ephemeris take <name> <piece>: one of ${pieces.map((f) => path.basename(f, '.js')).join(', ')}`); process.exit(1); }
    const out = path.join(d, 'render', path.basename(src));
    if (fs.existsSync(out)) { console.error(`projects/${pname}/render/${path.basename(src)} is the film's already: change it there (or move it aside to take the studio's again)`); process.exit(1); }
    // its relative imports, to the same files in the studio, from where the copy is (the workspace links engine/ in)
    const code = fs.readFileSync(path.join(R, src), 'utf8').replace(/(from\s+')(\.{1,2}\/[^']+)(')/g, (_, a, rel, c) => {
      const to = path.relative(path.dirname(out), path.join(WS, 'engine', 'render', path.dirname(src), rel)).split(path.sep).join('/');
      return a + (to.startsWith('.') ? to : `./${to}`) + c;
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `// The film's own copy of the studio's engine/render/${src}, taken at Ephemeris ${version()} (./ephemeris take): change it
// as the film needs. The studio's own goes on changing without it; compare the two to take a fix across.
${code}`);
    console.log(`projects/${pname}/render/${path.basename(src)}: import it in the film and give it to F.run's render ({ passes: [...] } with it in place of the studio's, or { lib: { … } }: see engine/render/index.js, PASSES and LIB)`);
    break;
  }
  case 'snapshot': {
    const d = dir(), tl = timeline(d), ref = path.join(d, 'renders', 'reference'), times = referenceTimes(tl);
    await served(d, tl.url);
    fs.rmSync(ref, { recursive: true, force: true });
    if (stills(tl, times, ref) !== 0) process.exit(1);
    const sha = version();
    // frames are byte-identical however they are reached, but only on one machine (GPU, driver) and one renderer
    fs.writeFileSync(path.join(ref, 'reference.json'), JSON.stringify({ times, ephemeris: sha, renderer: rendererVersion(), host: os.hostname(), made: new Date().toISOString() }, null, 2));
    console.log(`${times.length} reference frames of ${name} (Ephemeris ${sha}) in projects/${name}/renders/reference`);
    break;
  }
  case 'compare': {
    const names = name === '--all' ? fs.readdirSync(path.join(WS, 'projects')).filter((n) => fs.existsSync(path.join(WS, 'projects', n, 'renders', 'reference', 'reference.json'))) : [name];
    let changed = 0;
    for (const n of names) {
      const d = dir(n), tl = timeline(d), ref = path.join(d, 'renders', 'reference'), out = path.join(d, 'renders', 'compare');
      if (!fs.existsSync(path.join(ref, 'reference.json'))) { console.error(`${n}: no reference yet (./ephemeris snapshot ${n})`); process.exit(1); }
      const R = JSON.parse(fs.readFileSync(path.join(ref, 'reference.json'), 'utf8'));
      const runtime = R.renderer ?? `Chrome ${R.chrome}`;
      if (R.host !== os.hostname() || runtime !== rendererVersion()) console.log(`${n}: the reference was made on ${R.host} with ${runtime}; frames only match on the same machine and renderer`);
      await served(d, tl.url);
      fs.rmSync(out, { recursive: true, force: true });
      if (stills(tl, R.times, out) !== 0) process.exit(1);
      // Chrome draws some text and images a level differently depending on what a worker rendered before (accepted:
      // invisible), so a frame has changed when a pixel moves more than 2 levels, or more than 1000 pixels move at all
      const noise = [];
      const diff = R.times.filter((t) => {
        const a = path.join(ref, png(t)), b = path.join(out, png(t));
        if (hash(a) === hash(b)) return false;
        const [pa, pb] = [a, b].map((f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 }).stdout);
        let moved = 0, most = 0;
        for (let i = 0; i < pa.length; i += 3) { const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])); if (d) { moved++; most = Math.max(most, d); } }
        if (pa.length === pb.length && most <= 2 && moved <= 1000) { noise.push(t); return false; }
        return true;
      });
      for (const t of diff) {
        // what changed, made visible: the difference, brightened
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(ref, png(t)), '-i', path.join(out, png(t)), '-filter_complex', 'blend=all_mode=difference,lutrgb=r=val*8:g=val*8:b=val*8', path.join(out, `diff-${png(t)}`)]);
      }
      changed += diff.length;
      const within = noise.length ? ` (${noise.length} within raster noise: ${noise.map((t) => `${t}s`).join(', ')})` : '';
      console.log(diff.length ? `${n}: ${diff.length} of ${R.times.length} frames changed since Ephemeris ${R.ephemeris}: ${diff.map((t) => `${t}s`).join(', ')}${within}\n  (side by side: renders/reference vs renders/compare; differences: renders/compare/diff-*.png)` : `${n}: identical to its reference (Ephemeris ${R.ephemeris}), ${R.times.length} frames${within}`);
    }
    process.exit(changed ? 1 : 0);
  }
  // (the workspace served, by this studio's Vite: its films' pages at /projects/<name>/)
  case 'serve': run([process.execPath, path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(ROOT, 'vite.config.js'), '--configLoader', 'native', ...[name, ...rest].filter(Boolean)], { cwd: WS }); break;
  case 'studio': run([process.execPath, tool('nle.mjs'), ...[name, ...rest].filter(Boolean)]); break;
  // (the electron package is the path of its binary)
  case 'app': run([createRequire(import.meta.url)('electron'), path.join(ROOT, 'app', 'main.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }); break;
  case 'mcp': run([process.execPath, tool('mcp.mjs'), ...[name, ...rest].filter(Boolean)]); break;
  case 'pi': run([process.execPath, path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'), ...[name, ...rest].filter(Boolean)], { cwd: WS }); break;
  // (files as named where the command was typed)
  case 'sound': case 'music': case 'pitch': run([process.execPath, tool(`${cmd}.mjs`), ...[name, ...rest].filter(Boolean).map((a) => (fs.existsSync(a) ? path.resolve(a) : a))]); break;
  case 'depth': { const d = dir(); run([process.execPath, tool('depth.mjs'), '--out', path.join(d, 'assets', 'depth'), ...rest.map((a) => (fs.existsSync(path.join(d, a)) ? path.join(d, a) : a))]); break; }
  case 'levels': { const d = dir(); timeline(d); run([process.execPath, tool('levels.mjs'), timelineFile(d), ...rest]); break; }
  case 'nle': run([process.execPath, tool('nle.mjs'), ...(name && !name.startsWith('--') ? ['--project', path.join(path.relative(ROOT, dir()), ...(name.includes('/') ? [tid] : []))] : [name].filter(Boolean)), ...rest]); break;
  case 'check': { const d = dir(); await served(d, timeline(d).url); run([process.execPath, tool('check.mjs'), '--url', page(timeline(d)), ...rest]); break; }
  case 'profile': {
    const d = dir(), tl = timeline(d), [t = '0'] = rest.filter((a) => !a.startsWith('--'));
    await served(d, tl.url);
    run([process.execPath, tool('profile.mjs'), '--url', page(tl), '--t', t, '--fps', String(tl.fps ?? 60), '--shutter', String((tl.shutter ?? 180) / 360), '--samples', String(samplesOf(tl)[rest.includes('--master') ? 'master' : 'viewer'])]);
    break;
  }
  case 'stills': {
    const d = dir(), [times, ...more] = rest, tl = timeline(d);
    await served(d, tl.url);
    run([process.execPath, tool('render.mjs'), '--url', page(tl), '--stills', times, '--dir', path.join(d, 'renders', 'stills'), '--fps', String(tl.fps ?? 60), '--sub', '1', ...more]);
    break;
  }
  case 'master': {
    // the recipe for a finished film: its frame rate, shutter and samples (full motion blur and antialiasing), its own
    // music mix
    const d = dir(), tl = timeline(d), d0 = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d0.getFullYear()}${p2(d0.getMonth() + 1)}${p2(d0.getDate())}-${p2(d0.getHours())}${p2(d0.getMinutes())}`;   // local time
    const out = path.join(d, 'renders', `${pname}${tid === 'main' ? '' : `-${tid}`}-${stamp}.mp4`);
    await served(d, tl.url);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    run([process.execPath, tool('render.mjs'), '--url', page(tl), '--out', out, '--share', out.replace(/\.mp4$/, '-share.mp4'), '--meta', out.replace(/\.mp4$/, '.json'), '--fps', String(tl.fps ?? 60),
      '--shutter', String((tl.shutter ?? 180) / 360), '--sub', String(samplesOf(tl).master), '--crf', '14', '--audio', timelineFile(d), ...rest]);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

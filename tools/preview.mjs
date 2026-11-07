// The NLE's viewer, rendered live, the way After Effects keeps a preview cache. Render workers (worker.mjs) render
// frames on demand and keep them without loss (PNGs: frames.mjs) in the machine's caches, out of the film (tools/cache.mjs:
// ~/.cache/ephemeris/previews/<film>-<its folder's hash>/<timeline>/preview/): the frame under the playhead first, then the frames
// ahead of it while playing, then the rest of the film outward from the playhead. That last fill is the editor's
// Pre-render, on unless it is turned off (prerender()): then only the frame under the playhead, what playing needs, what
// an agent asked to see and a draft's range are drawn, and the GPU is left alone (to measure the renderer, say). When
// the film changes (its code, Ephemeris, or the timeline), the workers reload it and render every frame again; meanwhile the viewer shows the
// previous version, marked stale. A change to the timeline's overrides alone (the director's edits) is taken in by the
// open pages as it is, without loading the film again (~2 s for launch, where a frame takes ~0.1 s). A frame whose new version differs from the one it replaced is marked changed, so the
// editor can show what an edit altered. As many workers render as make it faster (see crew), and they close when there
// is nothing left to render, giving the GPU back.
//
// The same frames make the draft file (R): renders/<timeline>/draft.mp4, with the timeline's music. Each frame stored is
// also handed to the editor's viewer at once (onFrame): nle.mjs sends it over the viewer's socket.
//
// Frames are drawn at the size the viewer shows them (size(): of the film's frame, a step of 1/8 from a quarter to
// whole; the editor's Preview size, Dynamic by default: as many pixels as the viewer has), so a smaller viewer is quicker
// to fill; each frame remembers the size it was drawn at, and one smaller than the viewer now wants is drawn again
// (shown meanwhile, as it is). The draft's frames are whole.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openWorker, crew } from './worker.mjs';
import { gpuMemory } from './machine.mjs';
import { rendererVersion } from './browser.mjs';
import { encode as keepFrame, jpeg as jpegOf } from './frames.mjs';
import { mixTimeline } from './mix.mjs';
import { strip as withoutCode, filmSees, followed } from '../nle/anchors.js';
import { liveEdits } from '../engine/site.js';

// (FORMAT: what the frames are kept as; a cache kept as anything else, JPEGs before, is made again)
const IDLE = 30_000, FORMAT = 'png';
// per frame: none yet, stale (an earlier version of the film), fresh, fresh and different from the version it replaced
const NONE = 0, STALE = 1, FRESH = 2, CHANGED = 3;
// a frame that takes longer than SLOW_MS to draw for the viewer (one comes that often, the workers together), SLOW_RUN in
// a row, past each worker's first (its shaders compiled, its scene built): the film is slow to draw there. It is said
// once (onSlow) until frames come quicker again, or take twice as long as when it was said, and shown while it lasts
// (state().slow). The time is this machine's, on its GPU: slow here is slow for whoever waits on it here.
const SLOW_MS = 1000, SLOW_RUN = 3;

/**
 * out: where the timeline's draft goes (renders/<timeline>/); cache: where its frames go (cache.mjs previewsOf);
 * url(): the film's page; settings(): { fps, shutter (degrees), samples (a frame's) }; timeline: its file; workers: at most how many;
 * send(type, data): events to the editor; engine: the Ephemeris version (for the draft's sidecar). look: how its frames
 * are drawn (the viewer's, see LOOKS in engine/render/index.js: 'accurate', the film as it renders, keeps preview/;
 * another its own preview-<look>/); active(): whether it is the look the viewer shows (else it renders only what an
 * agent wants and a draft's range, and its workers close). prerender(): whether it fills the rest of the film around
 * the playhead (see above). onFrame({ f, look, gen, state, z, png, profile }): a frame
 * stored. stats(): whether the frames drawn now keep what drawing them took (an editor shows it: their profile,
 * engine/render/profile.js, and the time to keep the PNG), with them while the studio runs. onSlow(slow): frames are
 * slow to draw ({ ms, from, to (s), size, samples }: see SLOW_MS), or (null) quick again. onCompiling(k, state): what worker
 * k's shaders are doing (tools/worker.mjs). onWork(who, what, t): what a worker is on, for the viewer to say: 'loading' the
 * film, 'warming' (its shaders), 'drawing' or 'storing' the frame at t; nothing: nothing. shaders(): a fingerprint of what
 * Ephemeris makes its shaders from (its files), added to the one each page reports of the film's own. drawn(): whether
 * an editor's own film draws the viewer's frames (engine/runtime.js preview: the playhead's, those ahead, the rest when it
 * is idle), giving the cache each it draws (put). It is then the first of the workers this machine renders with (the
 * crew: worker.mjs workerCount, "1 worker" being it alone): the studio's own fill the cache beside it (never the frame
 * under the playhead, which it draws), and one draws what only they can, whole: what an agent asks to see, a draft's
 * range, and what the film says of itself before any page has loaded it.
 */
export function createPreview({ out, cache, url, settings, timeline, workers, send, engine, onCompiling, onWork, shaders = () => '', stamp = () => null, newest = () => Infinity, look = 'accurate', active = () => true, prerender = () => true, size = () => 1, serve = () => {}, onFrame = () => {}, onSlow = () => {}, stats = () => false, drawn = () => false }) {
  const CACHE = path.join(cache, look === 'accurate' ? 'preview' : `preview-${look}`), INDEX = path.join(CACHE, 'preview.json');
  const DRAFT = path.join(out, 'draft.mp4');
  // gen: the version of the film the frames are of; loaded: the version a page must be loaded again for (its code, its
  // cues…: not an edit of the overrides alone, which pages take in as they are: ovs); key: the timeline as the film
  // sees it (anchors.js filmSees), for the editor to tell whether the frames show its timeline, and base, without its
  // overrides (what the pages have loaded: the editor's own overrides drawn over it are its timeline)
  let gen = 0, loaded = 0, metaLoaded = -1, meta = null, error = '', fps = settings().fps, status = new Uint8Array(0), ovs = null, key = null, base = null;
  let sizes = new Float32Array(0);   // (the size each frame was drawn at: of the film's frame)
  let at = { f: 0, playing: false, every: false }, exp = null, running = 0, wakers = [], polling = false, took = 150;
  let warmed = 0;   // (how many workers have drawn a frame since their page loaded)
  // (bytes: what its frames take on disk; full: some were dropped to keep the caches under their limit (tools/cache.mjs),
  // so it renders no more than near the playhead, a draft's and what an agent asks for, until there is room again)
  let bytes = 0, full = false;
  let wanted = [];   // (frames an agent asked for: want)
  let slow = null, slowRun = [], slowSaid = 0;   // (frames slow to draw: see SLOW_MS)
  // Room on the GPU for another worker (crew): its free memory, as last read, against what a worker of this film takes
  // (each new one measured: the GPU's memory before it started and once it drew), a margin, and, while no editor's own
  // film is drawing (it loads one more of the film when it opens), as much again. Where the machine does not say, no
  // check: the GPU running out still takes one away (gpuFull).
  let mem = null, memAt = 0, takes = 0;
  const readMem = () => { if (Date.now() - memAt < 1500) return; memAt = Date.now(); gpuMemory().then((m) => { mem = m; }); };
  const room = () => {
    if (!mem || !takes) return true;
    const free = mem.total - mem.used, need = takes * (drawn() ? 1 : 2) + Math.max(2 ** 30, mem.total / 10), gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
    if (free >= need) return true;
    console.log(`viewer: no room on the GPU for another worker: ${gb(free)} free, a worker takes ${gb(takes)}; rendering with ${team.n}`);
    return false;
  };
  const team = crew(workers, () => ensure(), room);
  // (the studio's workers that draw the viewer's frames: the crew, less an editor's own film where it draws them)
  const share = () => team.n - (drawn() ? 1 : 0);
  const busy = new Set(), failed = new Set(), open = new Set(), profiles = new Map();   // (profiles: frame → what drawing the one kept took)
  let asked = null;   // (the paths its pages asked the film's server for since the film last changed, those closed since: null, none yet)

  // frames from an earlier session are shown (stale) until rendered again, if they were made at the same frame rate;
  // those made from what the film is made of now (the same fingerprint: its code, Ephemeris's, its timeline) are kept
  let made = stamp();
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    const was = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (was.fps !== fps || was.format !== FORMAT) throw new Error('other fps or format');
    const fs_ = fs.readdirSync(CACHE).map((f) => /^(\d+)\.png$/.exec(f)?.[1]).filter(Boolean).map(Number);
    status = new Uint8Array(Math.max(0, ...fs_.map((f) => f + 1)));
    sizes = new Float32Array(status.length).fill(1);   // (a frame kept from before sizes were remembered: whole)
    for (const [f, z] of was.sizes ?? []) if (f < sizes.length) sizes[f] = z;
    // (a cache from before fingerprints: the frames rendered after the last change to anything they are made from)
    const last = was.stamp ? 0 : newest() + 1000;
    const same = made && was.stamp === made ? new Set(was.fresh ?? []) : was.stamp ? new Set() : new Set(fs_.filter((f) => { try { return fs.statSync(path.join(CACHE, `${f}.png`)).mtimeMs > last; } catch { return false; } }));
    for (const f of fs_) { status[f] = same.has(f) ? FRESH : STALE; try { bytes += fs.statSync(path.join(CACHE, `${f}.png`)).size; } catch { /* gone */ } }
    if (same.size) { console.log(`preview: ${same.size} frames kept (nothing they are made from changed)`); setTimeout(keep, 0); }
    // (and what the film's pages said of it, its length, cuts, cues and parts: no page loads the film to say it again)
    if (made && was.stamp === made && was.meta) fit(was.meta);
  } catch { wipe(); }
  function wipe() {
    fs.rmSync(CACHE, { recursive: true, force: true }); fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(INDEX, JSON.stringify({ fps, format: FORMAT }));
    status = new Uint8Array(0); sizes = new Float32Array(0); meta = null; bytes = 0; profiles.clear();
  }
  // which frames are current, and what they were made from (written a moment after they change)
  let keepTimer = null;
  function keep() {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      const fresh = [], small = [];
      for (let i = 0; i < status.length; i++) { if (status[i] >= FRESH) fresh.push(i); if (sizes[i] < 1) small.push([i, sizes[i]]); }
      try { fs.writeFileSync(INDEX, JSON.stringify({ fps, format: FORMAT, stamp: made, fresh, sizes: small, ...(metaLoaded === loaded && meta && { meta }) })); } catch { /* the cache went */ }
    }, 1500);
  }

  // ---------- what to render next
  // (the size frame i should be drawn at: the draft's and what an agent wants to see whole, the viewer's what it shows;
  // one drawn smaller is not done)
  const goal = (i) => { if (wanted.includes(i)) return 1; if (exp) { const [a, b] = range(); if (i >= a && i < b) return 1; } return size(); };
  const free = (i) => (status[i] < FRESH || sizes[i] < goal(i) - 1e-6) && !busy.has(i) && !failed.has(i);
  function pick() {
    const F = status.length;
    if (!F || metaLoaded !== loaded || Date.now() < heldUntil) return null;
    // (not the look shown: what an agent asked to see, and a draft's frames, alone)
    if (!active()) { for (const w of wanted) if (w < F && free(w)) return w; if (exp) { const [a, b] = range(); for (let i = a; i < b; i++) if (free(i)) return i; } return null; }
    // (the viewer's frames, by the studio's share of the crew: the playhead's, where no editor's own film draws it; those
    // ahead while playing, and the rest)
    const viewer = share() > 0, f = Math.max(0, Math.min(at.f, F - 1));
    if (viewer && !drawn() && free(f)) return f;
    // playing: the frames ahead, from where the playhead will be when one is done (dropping frames: those it will have
    // passed are skipped for now); playing every frame, the next, which it waits for
    if (viewer && at.playing) for (let i = f + (at.every ? 1 : Math.ceil((took / 1000) * fps * 1.25) + 1); i < F; i++) if (free(i)) return i;
    // the frames an agent asked to see (want): next, never instead of the director's
    for (const w of wanted) if (w < F && free(w)) return w;
    if (exp) { const [a, b] = range(); for (let i = a; i < b; i++) if (free(i)) return i; }
    // outward from the playhead, forward first: two frames ahead for each one behind (all of them, while there is room;
    // none with Pre-render off)
    if (!viewer || full || !prerender()) return null;
    for (let a = f + 1, b = f - 1; a < F || b >= 0;) {
      for (let n = 0; n < 2 && a < F; n++, a++) if (free(a)) return a;
      if (b >= 0 && free(b)) return b;
      b--;
    }
    return null;
  }

  // the director's view goes first: while it is being moved, no new frame starts (those under way finish)
  let heldUntil = 0, holdTimer = null;
  function hold(ms) {
    heldUntil = Date.now() + ms;
    clearTimeout(holdTimer); holdTimer = setTimeout(ensure, ms + 10);
  }
  // frames drawn now while the film plays (Preview over an edit not rendered yet) take k of its workers for ms: it draws
  // with the rest, and at least one, as it is what they wait for; those over that wait, their pages kept, and how many
  // make it faster is not judged meanwhile (see crew)
  let lent = 0, lentUntil = 0, lendTimer = null, drawing = 0;
  const lentNow = () => (Date.now() < lentUntil ? lent : 0);
  const allowed = () => Math.max(1, share() - lentNow());
  function lend(k, ms) {
    lent = k; lentUntil = Date.now() + ms;
    clearTimeout(lendTimer); lendTimer = setTimeout(() => { team.remeasure(); ensure(); }, ms + 10);
  }

  // ---------- workers
  const wake = () => { const w = wakers; wakers = []; for (const r of w) r(true); };
  const idle = (ms = IDLE) => new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { wakers = wakers.filter((x) => x !== done); resolve(false); }, ms);
    wakers.push(done);
  });
  /** Starts workers if there is anything to render. */
  function ensure() {
    wake();
    if (!url() || (metaLoaded === loaded && pick() == null)) return;
    // a new run measures again how many workers make it faster (an editor's own film drawing, the crew's first, it is
    // one run until the film changes: again)
    if (!running && !drawn()) team.reset();
    for (let k = running; k < allowed(); k++) work(k);
  }
  async function work(k) {
    running++;
    // (warm: it has drawn a frame since its page loaded; ready: its shaders are made, see below)
    let w = null, wurl = null, wgen = -1, wloaded = -1, warm = false, ready = false, before = null, last = 0;   // (before: the GPU's memory in use as it started; last: when it last drew)
    try {
      for (;;) {
        if (wloaded !== loaded || wurl !== url()) {
          const g = gen, l = loaded;
          if (!url() || !(await served())) break;
          onWork?.(k, 'loading');
          try {
            if (w && wurl === url()) await w.reload();
            else { await w?.close(); open.delete(w); w = null; wurl = url(); before = (await gpuMemory())?.used ?? null; w = await openWorker(wurl, `v${k}`, (c) => onCompiling?.(k, c)); open.add(w); }
          } catch (e) {
            // one that fails to start beside others rendering the same film (an editor's own film among them): the machine
            // has no room for another (the GPU refused it), not a film that fails, so those render on
            if ((running > 1 || drawn()) && metaLoaded === loaded) { team.full(); console.log(`viewer: a worker did not start (${String(e.message).slice(0, 120)}); rendering with ${team.n}`); break; }
            if (g === gen) setError(e.boot ? `The film failed to start:\n\n${e.boot}` : String(e.message || e));
            break;   // the next change to the film starts the workers again
          } finally { onWork?.(k); }
          wgen = g; wloaded = l; w.as = l; warmed -= warm; warm = false; ready = false;
          if (l === loaded) adopt(w.meta);
          continue;
        }
        // (the overrides edited since: taken in as they are)
        if (wgen !== gen) { const g = gen; await w.overrides(ovs ?? []); wgen = g; continue; }
        if (running > Math.max(1, share())) break;   // (more are running than make it faster)
        if (drawing >= allowed()) { await idle(); continue; }   // (some lent: lend)
        // its shaders made before it takes a frame, so that it never holds one the playhead waits for while it compiles
        // (a new worker took 32 s over the next frame on gi-test, others drawing past it). The film's first worker draws
        // a frame first: there is nothing to show until one does, and no one else to draw it meanwhile. A browser that
        // has made the same shaders ready has them in its caches (a page loaded again for its timeline, or for code that
        // changed none of them), and is not made ready again: on spring-brutalist that took 52 s, 43 of them drawing,
        // where its frames then come in 7 s for the first (as before) and at most 2 s for the first at another shot
        // (and only once there is a frame for it: one opened to learn what the film says of itself, or whose frames an
        // editor's own film took meanwhile, makes none ready, which is minutes of the GPU on a heavy film). None while an
        // editor's own film draws the viewer's frames: the director waits on that one, which makes its own ready
        // (engine/runtime.js warm), and on no frame of these (87 s of the GPU on spring-brutalist before a first frame)
        if (!ready && !drawn() && (warm || warmed > 0) && pick() != null) {
          ready = true;
          const set = w.meta?.shaders ? `${shaders()}|${look}|${w.meta.shaders}` : null;
          if (set && w.warmed(set)) { if (!warm) { warm = true; warmed++; } continue; }
          onWork?.(k, 'warming');
          const w0 = Date.now(), r = await w.warm(fps, look).catch((e) => ({ error: String(e.message || e) }));
          onWork?.(k);
          console.log(`viewer: a worker made ready: ${r.error ?? `${r.moments} moments`} in ${((Date.now() - w0) / 1000).toFixed(1)} s`);
          if (set && !r.error) w.madeReady(set);
          if (!warm) { warm = true; warmed++; }
          continue;
        }
        const f = pick();
        // (nothing to draw. A look not shown gives its GPU back now. A worker past the studio's share of the crew (an
        // editor's own film drawing the viewer's frames, "1 worker" being it alone) was opened for what only the studio's
        // workers draw: having drawn nothing, it was opened only to load the film, and closes now, its frames and what it
        // is made of known; having drawn, it closes IDLE after its last frame, for an agent's next look, however often
        // the playhead wakes it meanwhile. The others wait IDLE for more)
        if (f == null) {
          const past = drawn() && running > share();
          if (active() && (!past || (warm && Date.now() - last < IDLE)) && (await idle(past ? IDLE - (Date.now() - last) : IDLE))) continue;
          break;
        }
        const g = gen, { shutter, samples } = settings(), t0 = Date.now(), z = goal(f);
        busy.add(f);
        // (kept on the codec's threads while this worker draws its next: the frame stays busy until it is)
        let storing = null;
        try {
          // drafts' quality: the timeline's samples, its motion blur and antialiasing
          drawing++;
          onWork?.(k, 'drawing', f / fps);
          const fr = await w.frame(f / fps, { sub: samples, shutter: shutter / 360, fps, look, scale: z, profile: stats() }).finally(() => { drawing--; onWork?.(k); });
          last = Date.now();
          const ms = (Date.now() - t0) / Math.min(running, allowed());   // (a frame's time, the workers together)
          took = 0.8 * took + 0.2 * ms;
          if (warm && g === gen) judge(f, ms, z, samples);
          if (!warm) { warm = true; warmed++; }
          // (what it took of the GPU, once it has drawn: the most any worker of this run took)
          if (before != null) { const b = before; before = null; gpuMemory().then((m) => { if (m && m.used - b > 2 ** 28) takes = Math.max(takes, m.used - b); }); }
          readMem();
          if (g === gen) { onWork?.(`${k} storing`, 'storing', f / fps); storing = store(f, fr, z, g).finally(() => { busy.delete(f); onWork?.(`${k} storing`); }); }   // a frame of a version that has since changed is dropped
          // (counted as the crew's: past an editor's own film, its first; not a frame of what only the studio draws)
          if (!lentNow() && running <= share()) team.done(drawn() ? k + 1 : k);
        } catch (e) {
          if (/OUT_OF_DEVICE_MEMORY|out of memory/i.test(String(e.message)) && team.n > 1) {
            // the GPU is full: one worker fewer, and the frame goes to another
            gpuFull();
          } else if (g === gen) { failed.add(f); setError(`Frame ${f} (${(f / fps).toFixed(2)} s) failed:\n\n${e.message || e}`); }
          break;
        } finally { if (!storing) busy.delete(f); }
      }
    } finally {
      running--; warmed -= warm;
      if (w?.as === loaded) for (const f of w.files) (asked ??= new Set()).add(f);
      open.delete(w); await w?.close();
      publish();
    }
  }
  function gpuFull() {
    team.full();
    console.log(`viewer: GPU memory is full; rendering with ${team.n} worker${team.n > 1 ? 's' : ''}`);
  }
  // a frame drawn for the viewer, ms (the workers together): slow to draw where SLOW_RUN in a row take SLOW_MS or longer
  function judge(f, ms, z, samples) {
    if (ms < SLOW_MS) { slowRun = []; if (slow) { slow = null; slowSaid = 0; publish(); onSlow(null); } return; }
    slowRun = [...slowRun.slice(1 - SLOW_RUN), { f, ms }];
    if (slowRun.length < SLOW_RUN) return;
    const times = slowRun.map((x) => x.ms).sort((a, b) => a - b), at = slowRun.map((x) => x.f / fps), mid = times[Math.floor(times.length / 2)];
    slow = { ms: Math.round(mid), from: Math.min(...at), to: Math.max(...at), size: z, samples };
    publish();
    if (!slowSaid || mid >= 2 * slowSaid) { slowSaid = mid; onSlow(slow); }
  }
  // what a page said of the film as it is loaded (its length, cuts, cues, parts: meta), the frames as many as it is long
  function adopt(m) {
    if (metaLoaded === loaded && JSON.stringify(m) === JSON.stringify(meta)) return;
    fit(m); keep(); publish(); wake(); finishExport();
  }
  function fit(m) {
    metaLoaded = loaded; meta = m; keyOf();
    const F = Math.max(0, Math.round(m.duration * fps)), s = new Uint8Array(F), z = new Float32Array(F).fill(1);
    s.set(status.subarray(0, Math.min(F, status.length)));
    z.set(sizes.subarray(0, Math.min(F, sizes.length)));
    status = s; sizes = z;
  }
  async function store(f, fr, z, g) {
    let png;
    const coding = performance.now();
    try { png = await keepFrame(fr.data, fr.w, fr.h); } catch (e) { console.log(`preview: frame ${f} not kept: ${e.message}`); return; }
    if (g !== gen) return;   // (the film changed while it was coded)
    const profile = fr.profile && { ...fr.profile, stages: [...fr.profile.stages, { name: 'Saving', ms: +(performance.now() - coding).toFixed(2), n: 1 }] };
    if (profile) profiles.set(f, profile); else profiles.delete(f);
    const file = path.join(CACHE, `${f}.png`);
    let old = null;
    // (changed: what the film draws there, compared at the same size, the same pixels coding the same; a frame drawn
    // again only larger is not changed)
    if (status[f] === STALE && sizes[f] === z) try { old = fs.readFileSync(file); } catch { /* gone */ }
    let had = 0;
    try { had = fs.statSync(file).size; } catch { /* none yet */ }
    fs.writeFileSync(`${file}.tmp`, png); fs.renameSync(`${file}.tmp`, file);   // never a half-written frame
    bytes += png.length - had;
    status[f] = old && !old.equals(png) ? CHANGED : status[f] === CHANGED ? CHANGED : FRESH;
    sizes[f] = z;
    onFrame({ f, look, gen, state: status[f], z, png, profile });
    publish(); finishExport(); keep();
  }
  /** Whether the film's page is up; if not, says so, asks for it to be served (serve(): again every ~10 s, as a server
   *  that held its port may have gone), and starts the workers once it is. */
  async function served() {
    const ok = () => fetch(url(), { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
    if (await ok()) return true;
    setError(`The film's page is not being served:\n${url()}\n\nStart it (./ephemeris serve, or the project's own server); the viewer picks it up.`);
    if (!polling) {
      polling = true;
      let tries = 0;
      (async function poll() {
        if (await ok()) { polling = false; error = ''; publish(); ensure(); return; }   // (the editor told it is up)
        if (tries++ % 5 === 0) serve();
        setTimeout(poll, 2000);
      })();
    }
    return false;
  }
  function setError(e) { if (!error) { error = e; console.log(`preview: ${e.split('\n')[0]}`); } if (exp) failExport(error); publish(); }

  // ---------- changes
  /** The film changed: every frame is rendered again (each shown stale until then), by pages loaded again. */
  function invalidate() { loaded = gen + 1; asked = null; if (drawn()) team.reset(); again(); }
  /** The paths of the film's server its pages have asked for, as the film is now: what it is made of (null: no page has
   *  loaded it since it last changed, so not known). */
  function files() {
    const pages = [...open].filter((w) => w.as === loaded);
    return asked || pages.length ? new Set([...(asked ?? []), ...pages.flatMap((w) => [...w.files])]) : null;
  }
  // every frame again, of a new version of the film
  function again() {
    gen++; failed.clear(); error = '';
    made = stamp(); keep(); keyOf();
    for (let i = 0; i < status.length; i++) if (status[i] >= FRESH) status[i] = STALE;
    publish(); ensure();
  }
  /** The timeline changed: films read it (cues, music length, tempo), but not the cues they do not follow, nor the code
   *  its changes remember they are on (nle/anchors.js); and its overrides alone the pages take in as they are. */
  function timelineChanged(before, after) {
    let A, B;
    try { A = JSON.parse(before); B = JSON.parse(after); } catch { return invalidate(); }
    if ((B.fps || 60) !== fps) { fps = B.fps || 60; wipe(); return invalidate(); }
    if (!meta) return invalidate();
    const follows = followed(meta);
    if (filmSees(A, follows) === filmSees(B, follows)) return restamp();
    if (filmSees(A, follows, { overrides: false }) !== filmSees(B, follows, { overrides: false })) return invalidate();
    ovs = liveEdits(withoutCode(B));
    again();
  }
  // what the frames are of, as the editor compares it (once the film has said which cues it follows)
  function keyOf() {
    key = base = null;
    if (!meta) return;
    try {
      const d = JSON.parse(fs.readFileSync(timeline, 'utf8')), follows = followed(meta);
      key = filmSees(d, follows); base = filmSees(d, follows, { overrides: false });
    } catch { /* mid-write: the next change */ }
  }
  /** The timeline was written again, the same to the film (only the code its changes are on remembered): frames kept. */
  function restamp() { made = stamp(); keep(); keyOf(); publish(); }

  // ---------- the editor
  let pubTimer = null;
  function publish() { if (!pubTimer) pubTimer = setTimeout(() => { pubTimer = null; send('preview', state()); }, 150); }
  function state() {
    // (sizes: each frame's, in eighths of the film's frame, a digit each: the viewer fetches a frame again when it is
    // drawn larger)
    return { look, gen, loaded, key, base, fps, duration: meta?.duration ?? null, cuts: meta?.cuts ?? [], cues: meta?.cues ?? [], parts: meta?.parts ?? [], frames: Array.from(status).join(''),
      sizes: Array.from(sizes, (z) => Math.round(z * 8)).join(''), size: size(), error, prerender: prerender(), working: running > 0 && !error && (metaLoaded !== loaded || pick() != null || busy.size > 0), workers: running, busy: busy.size, rate: took > 0 ? Math.round(10000 / took) / 10 : null, slow };
  }
  /** Frames an agent wants to see (the frames tool): rendered whole, after the director's playhead, not in its place. */
  function want(list) { wanted = [...new Set([...wanted.filter((f) => status[f] < FRESH || sizes[f] < 1), ...list.map((f) => Math.max(0, Math.round(f) || 0))])]; ensure(); }
  function playhead(f, playing, every) {
    if (playing && !at.playing) heldUntil = 0;   // (playing: the viewer's frames are the cache's again)
    at = { f: Math.max(0, Math.round(f) || 0), playing: !!playing, every: !!every }; ensure();
  }

  // ---------- the draft file (R): every frame of the range made current, then encoded with the music. Its steps: frames
  // (made current), sound (the timeline mixed), video (encoded), each with how far it is (progress, 0 to 1)
  let render = { phase: 'idle', progress: 0, error: '' };
  const sendRender = () => send('render', render);
  const advance = (f) => { if (f - render.progress > 0.01 || f < render.progress) { render.progress = f; sendRender(); } };
  const step = (name) => { render = { ...render, step: name, progress: 0 }; sendRender(); };
  function range() {
    const F = status.length;
    return [Math.max(0, Math.round(exp.from * fps)), Math.min(F, exp.to != null ? Math.round(exp.to * fps) : F)];
  }
  function exportDraft(from, to) {
    if (exp) return;
    if (!url()) { render = { phase: 'error', progress: 0, error: 'no film url: set one in the timeline settings or pass --url' }; return sendRender(); }
    exp = { from: from ?? 0, to: to ?? null, started: Date.now() };
    render = { phase: 'rendering', step: 'frames', progress: 0, error: '', from: exp.from, to: exp.to, started: exp.started };
    sendRender();
    if (error) { failed.clear(); error = ''; }   // try again
    ensure(); finishExport();
  }
  function cancelExport() { if (exp && !exp.encoding) { exp = null; render = { phase: 'idle', progress: 0, error: '' }; sendRender(); } }
  function failExport(e) { if (exp && !exp.encoding) { exp = null; render = { phase: 'error', progress: 0, error: e }; sendRender(); } }
  function finishExport() {
    if (!exp || exp.encoding || metaLoaded !== loaded) return;
    const [a, b] = range();
    let done = 0;
    for (let i = a; i < b; i++) if (status[i] >= FRESH && sizes[i] >= 1) done++;
    advance(b > a ? done / (b - a) : 0);
    if (done < b - a || b <= a) return;
    exp.encoding = true;
    encode(a, b).then(() => {
      console.log(`draft ready in ${((Date.now() - exp.started) / 1000).toFixed(0)}s`);
      render = { phase: 'ready', progress: 1, error: '' };
      send('draft', readDraft());
    }, (e) => { render = { phase: 'error', progress: 0, error: String(e.message || e) }; })
      .finally(() => { exp = null; sendRender(); });
  }
  async function encode(a, b) {
    // the frames are linked, not read in place: a frame re-rendered meanwhile is a new file, and this draft keeps its own
    // (linked in the cache, and the file made beside the draft it replaces: neither a link nor a rename crosses from
    // one file system, or btrfs subvolume, to another, and the cache and the film can be on different ones)
    const tmp = fs.mkdtempSync(path.join(cache, '.draft-'));
    fs.mkdirSync(out, { recursive: true });
    const made = DRAFT.replace(/\.mp4$/, '.part.mp4');
    try {
      for (let i = a; i < b; i++) fs.linkSync(path.join(CACHE, `${i}.png`), path.join(tmp, `${i - a}.png`));
      const mix = path.join(tmp, 'mix.wav'), from = a / fps, to = b / fps;
      step('sound');
      const audio = (await mixTimeline(timeline, mix, { progress: advance })).duration > 0 ? ['-ss', String(from), '-t', String(to - from), '-i', mix] : [];
      step('video');
      await new Promise((resolve, reject) => {
        let err = '';
        const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-framerate', String(fps), '-i', path.join(tmp, '%d.png'), ...audio,
          '-map', '0:v', ...(audio.length ? ['-map', '1:a', '-af', 'apad', '-c:a', 'aac', '-b:a', '320k', '-t', String(to - from)] : []),   // (as render.mjs)
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', made]);
        p.stdout.on('data', (d) => { const f = String(d).match(/frame=(\d+)/g)?.pop(); if (f) advance(+f.slice(6) / (b - a)); });   // (-progress: what it has encoded)
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim()}`))));
      });
      fs.renameSync(made, DRAFT);
      const { shutter } = settings();
      fs.writeFileSync(DRAFT.replace(/\.mp4$/, '.json'), JSON.stringify({ url: url(), fps, shutter: shutter / 360, from, to, duration: meta.duration, cuts: meta.cuts, cues: meta.cues, ephemeris: engine, renderer: rendererVersion() }));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(made, { force: true }); }
  }
  function readDraft() { try { return { ...JSON.parse(fs.readFileSync(DRAFT.replace(/\.mp4$/, '.json'), 'utf8')), made: fs.statSync(DRAFT).mtimeMs }; } catch { return null; } }

  // (to start: what was kept stays current; the rest renders)
  gen++; publish(); ensure();
  return {
    state, playhead, want, invalidate, timelineChanged, restamp, files, exportDraft, cancelExport, readDraft, hold, lend,
    /** The GPU refused what the director is waiting on: its render workers make room, one fewer while any more are drawing. */
    makeRoom: () => { if (running > 1) gpuFull(); },
    /** It became the look shown (or stopped being it): renders as it should now, and says where it is. */
    shown: () => { wake(); ensure(); publish(); },
    /** A frame an editor's own film drew (drawn()), its pixels ({ data: RGBA rows, w, h }) at size z, kept as a worker's
     *  is, where it is of the film as it is now (g: its version; k: the timeline as the film saw it) and no worker is
     *  drawing it; whether it was taken. */
    put(f, fr, z, g, k) {
      if (g !== gen || k !== key || metaLoaded !== loaded || !Number.isInteger(f) || f < 0 || f >= status.length || busy.has(f)) return false;
      busy.add(f);
      store(f, fr, z, g).finally(() => busy.delete(f));
      team.done(0);   // (the crew's first: see share)
      return true;
    },
    /** Whether an editor's own film draws the viewer's frames changed (drawn()): the workers draw as it now says, how many
     *  make it faster measured again. */
    drawnChanged: () => { team.reset(); wake(); ensure(); publish(); },
    /** The viewer's size changed (size()): frames drawn smaller than it now wants are drawn again. */
    resized: () => { wake(); ensure(); publish(); },
    /** Pre-render was turned on (the rest of the film renders again) or off (the workers finish their frames, then close when idle). */
    prerenderChanged: () => { wake(); ensure(); publish(); },
    /** What a page needs to draw the film as its frames are now: loaded again (`loaded` moved on), or given `overrides`;
     *  and what it is made of (`made`: the stamp its frames are kept by). */
    film: () => ({ gen, loaded, overrides: ovs, made }),
    get render() { return render; },
    /** Frame f as kept (a PNG), or null; and as a JPEG (for agents), or null. */
    file: (f) => (Number.isInteger(f) && f >= 0 ? fs.promises.readFile(path.join(CACHE, `${f}.png`)).catch(() => null) : Promise.resolve(null)),
    jpeg: (f, quality = 0.9) => (Number.isInteger(f) && f >= 0 ? fs.promises.readFile(path.join(CACHE, `${f}.png`)).then((b) => jpegOf(b, quality), () => null) : Promise.resolve(null)),
    /** What the viewer holds of frame f with it: its version (gen), state and size (in eighths), and what drawing it
     *  took where that was kept. */
    info: (f) => ({ gen, state: status[f] ?? NONE, size: Math.round((sizes[f] ?? 1) * 8), ...(profiles.has(f) && { profile: profiles.get(f) }) }),
    /** This machine's worker setting changed (worker.mjs, workerCount): as many render as it now says. */
    rechoose: () => team.rechoose(),
    // ---------- its place in the caches' limit (tools/cache.mjs)
    dir: CACHE,
    bytes: () => bytes,
    /** Drops its frames farthest from the playhead until `excess` bytes have gone (all: every one), not those a draft
     *  is being made of; returns the bytes freed. Shed for the limit, it renders no more than near the playhead. */
    shed(excess, all = false) {
      const [a, b] = exp ? range() : [-1, -1], f0 = at.f;
      const order = [...status.keys()].filter((i) => status[i] !== NONE && !busy.has(i) && !wanted.includes(i) && !(i >= a && i < b)).sort((x, y) => Math.abs(y - f0) - Math.abs(x - f0));
      let freed = 0;
      for (const i of order) {
        if (!all && freed >= excess) break;
        const file = path.join(CACHE, `${i}.png`);
        try { freed += fs.statSync(file).size; fs.rmSync(file); } catch { /* gone */ }
        profiles.delete(i);
        status[i] = NONE; sizes[i] = 1;
      }
      bytes -= freed; if (!all) full = true;
      keep(); publish();
      return freed;
    },
    /** The limit was raised: it renders the whole film again. */
    roomy: () => { full = false; ensure(); },
    /** Closes the workers (the editor is quitting). */
    close: () => Promise.all([...open].map((w) => w.close())),
  };
}

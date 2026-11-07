// Claude, where it works: a small avatar (the studio's orbit, as on its icon) that goes to what Claude looks at or
// changes as it works, with a line saying what it is doing, and lights it up (glow.js): the viewer for the film's frames,
// the thing it picked or found (where it is in the frame on screen), the moments it looked at on the ruler, the timeline
// it read, the notes clips and the mixer it read; and when the timeline changes, each thing that changed (its cues, clips,
// settings, the camera's properties; the clips that play notes that changed, and those notes in the piano roll where it
// shows them; on the mixer, each strip's fader, pan, mute, solo, send and effect that changed, and the effect's own
// controls where its drawer is open), with the avatar there if Claude changed it. What is on a panel behind another's
// tab (the Mixer behind the Timeline) lights its tab instead.
// Between steps it waits by the composer; when Claude is done it goes back there and leaves. Where each thing is comes
// from the editor (app.js): a function giving its box in the window, or null while it is not on screen.
// In its hand, what it is doing (prop): a magnifying glass it fiddles with while it reads or looks, a pencil scribbling
// as it writes, a bin a page drops into as it deletes, a finger poking at what it shows you, a test tube it shakes as it
// runs the checks, a clapperboard for a draft, a gear for any other command, an envelope as it reads your message, a
// hand waving while it waits for your answer, and a thumbs up when it is done. What it shows you it pokes at, once it is
// there, three times, the thing pulsing with each poke (glow.js, pulse); done, back by the composer, a bright pulse
// rings out from it and it holds its thumbs up big to the camera, then shrinks it and pops it away.
import { glow } from './glow.js';
import { say } from './agent.js';
import { isVisual, isNotes } from './model.js';

const ORBIT = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="ring" cx="32" cy="32" r="20"/><circle class="body" cx="32" cy="32" r="6"/><g class="moon"><circle cx="52" cy="32" r="5"/></g></svg>';
const MAX = 6;   // the most it lights at once
const SCALE = 1.5;   // its size: drawn at 1.5 times its 24 px (nle.css, .claude-av .av-s), as the studio's zoom scales everything
const SAFE = 30 * SCALE;   // how far its orb's centre keeps from the window's edges, so what it holds and does stays on screen
// what it holds for each kind of step (its motion: nle.css, .claude-av .prop)
const PROPS = { look: '🔍', write: '✏️', delete: '🗑️', point: '👉', test: '🧪', film: '🎬', run: '⚙️', mail: '📩', ask: '✋', done: '👍' };
const LOOK = new Set(['frames', 'view', 'pick', 'locate', 'stacks', 'camera', 'track', 'timeline', 'history', 'status', 'manual', 'reference', 'media', 'projects', 'open', 'notes', 'instruments', 'levels', 'music', 'sounds', 'pitch']);
const WRITE = new Set(['write_timeline', 'retime', 'reattach', 'write_notes', 'set_instrument']);
// (the mixer tool changes the mixer when it is given changes; else it reads it)
const mixes = (input) => !!(input.set || input.add_buses?.length || input.remove_buses?.length);
/** What kind of step a tool call is (PROPS), by the tool and, for a command, by what it runs. */
export function kindOf(name, input = {}) {
  const m = /^mcp__ephemeris__(.+)$/.exec(name)?.[1];
  if (m) return m === 'show' ? 'point' : m === 'check' ? 'test' : m === 'render_draft' ? 'film' : WRITE.has(m) || (m === 'mixer' && mixes(input)) ? 'write' : LOOK.has(m) || m === 'mixer' ? 'look' : 'run';
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'].includes(name)) return 'look';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'write';
  if (name !== 'Bash') return 'run';
  const c = String(input.command ?? ''), cmd = (re) => new RegExp(`(^|[;&|(]\\s*|\\bxargs\\s+)(${re})\\b`).test(c);
  if (cmd('rm|rmdir|unlink|git rm|trash')) return 'delete';
  if (/ephemeris\S*\s+check\b|check\.mjs/.test(c)) return 'test';
  if (/sed -i|\btee\b|>>?\s*(?!\/dev\/null)[^&\s|]|python3?\s+-|\bcp\s|\bmv\s|\bmkdir\b|\btouch\b|git (add|commit|apply)|\bpatch\b/.test(c)) return 'write';
  if (cmd('grep|rg|cat|less|ls|head|tail|find|fd|sed -n|awk|wc|jq|file|stat|readlink|tree|git (log|show|status|diff|blame)')) return 'look';
  return 'run';
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const onScreen = (r) => r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const still = matchMedia('(prefers-reduced-motion: reduce)');

// Its flight, the films' pointer's cousin (a paper airplane): a lead point runs an arc to where it is going (bowed up;
// a longer hop higher and longer), and the avatar follows it on a spring, a little behind and a little past on landing.
// A new place mid-flight bends the path, its speed kept. Fast, it stretches along its way with a short trail, its moon
// spinning faster (once round in 4.5 s at rest); it dips before it takes off; landed, a ring pulses (onLand); parked, it
// floats.
const K = 240, C = 2 * 0.68 * Math.sqrt(K);   // the spring: stiffness, and damping a little under critical
function flier(av, onLand) {
  const orb = av.querySelector('.orb'), trail = av.querySelector('.trail'), moon = av.querySelector('.moon');
  const p = { x: 0, y: 0 }, v = { x: 0, y: 0 };
  let where = () => null, goal = p, arc = null, spin = 0, last = 0, raf = 0, flying = false, launched = -1e9;
  const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
  // where the lead is: on its arc (a quadratic curve to the place as it is now), or at the place
  function lead(now, end) {
    if (!arc) return end;
    const u = clamp((now - arc.t0) / arc.dur, 0, 1), e = smoother(u);
    if (u >= 1) { arc = null; return end; }
    const c = { x: (arc.from.x + end.x) / 2 + arc.n.x * arc.bow, y: (arc.from.y + end.y) / 2 + arc.n.y * arc.bow };
    return { x: (1 - e) ** 2 * arc.from.x + 2 * (1 - e) * e * c.x + e * e * end.x, y: (1 - e) ** 2 * arc.from.y + 2 * (1 - e) * e * c.y + e * e * end.y };
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    goal = where() ?? goal;   // (gone from the screen: where it last was)
    const end = goal, L = lead(now, end);
    for (let i = 0; i < 2; i++) {   // (two steps a frame: steady at any frame rate)
      const h = dt / 2;
      v.x += (K * (L.x - p.x) - C * v.x) * h; v.y += (K * (L.y - p.y) - C * v.y) * h;
      p.x += v.x * h; p.y += v.y * h;
    }
    const speed = Math.hypot(v.x, v.y), a = Math.atan2(v.y, v.x);
    if (flying && !arc && speed < 40 && Math.hypot(end.x - p.x, end.y - p.y) < 2) { flying = false; av.classList.remove('flying'); onLand(); }
    // stretched along its way, with a dip as it takes off
    const s = Math.min(0.3, speed / 2600), k = now - launched < 150 ? 1 - 0.14 * Math.sin((Math.PI * (now - launched)) / 150) : 1;
    orb.style.transform = `rotate(${a}rad) scale(${(1 + s) * k}, ${(1 - 0.55 * s) * k}) rotate(${-a}rad)`;
    trail.style.opacity = speed < 80 ? 0 : Math.min(0.85, speed / 1100);
    trail.style.width = `${Math.min(64, speed * 0.04)}px`;
    trail.style.transform = `rotate(${a}rad)`;
    spin += dt * ((2 * Math.PI) / 4.5 + speed * 0.004);
    moon.style.transform = `rotate(${spin}rad)`;
    const bob = flying ? 0 : Math.sin(now / 650) * 1.2;
    av.style.transform = `translate(${p.x}px, ${p.y + bob}px)`;
  }
  return {
    /** Flies to where `w()` says ({ x, y }, or null: where it was going), or (now) is there at once. */
    to(w, now = false) {
      where = w;
      const end = w();
      if (!end) return;
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
      const dist = Math.hypot(end.x - p.x, end.y - p.y);
      if (now || still.matches) { Object.assign(p, end); v.x = v.y = 0; arc = null; return; }
      if (dist < 3) return;
      // bowed up (a hop that is mostly up or down: away from the window's nearer side)
      let n = { x: -(end.y - p.y) / dist, y: (end.x - p.x) / dist };
      if (n.y > 0) n = { x: -n.x, y: -n.y };
      if (Math.abs(n.y) < 0.25 && (n.x > 0) === (p.x > innerWidth / 2)) n = { x: -n.x, y: -n.y };
      arc = dist < 40 ? null : { from: { ...p }, t0: performance.now(), dur: clamp(420 + dist / 2.6, 450, 950), bow: Math.min(140, dist * 0.24), n };
      if (!flying) launched = performance.now();
      flying = true; av.classList.add('flying');
    },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    get flying() { return flying; },
  };
}

export function createPresence(at) {
  const av = document.createElement('div');
  av.className = 'claude-av'; av.hidden = true;
  av.innerHTML = `<span class="av-s"><span class="trail"></span><span class="pulse"></span><span class="orb">${ORBIT}</span><span class="prop"></span><span class="cap" hidden></span></span>`;
  document.body.append(av);
  const cap = av.querySelector('.cap'), pulse = av.querySelector('.pulse'), held = av.querySelector('.prop'), orb = av.querySelector('.orb');
  const fly = flier(av, () => { ring('land'); arrived?.(); });
  // the ring round it: as it lands, or done's brighter one
  const ring = (kind) => { pulse.className = 'pulse'; void pulse.offsetWidth; pulse.classList.add(kind); };
  // fn once it is where it is going: as it lands, or now if it is not flying (or after `ms`, whichever is first)
  let arrived = null, arriveTimer = 0;
  const arrive = (fn, ms = 1100) => {
    clearTimeout(arriveTimer);
    const once = () => { if (arrived !== once) return; arrived = null; clearTimeout(arriveTimer); fn(); };
    arrived = once;
    if (fly.flying) arriveTimer = setTimeout(once, ms); else requestAnimationFrame(once);
  };
  let here = null, leaving = 0, working = false, halo = null, holding = null;   // (halo: its light, the composer's, round it while it is here)
  let wrote = false;   // (its last step wrote the timeline: what changed keeps that step's line)
  const calls = new Map();   // Claude's steps under way, by id (what each was, for its result)

  // what it holds (PROPS: null, nothing), brought out with a little pop; a finger points at the box it is at (down and
  // to its left: a hand turned the way it points, never upside down), a bin has its page, a thumbs up its sparkles
  function prop(kind, act = '') {
    if (kind === holding && kind !== 'point' && !act) return;
    holding = kind;
    held.className = `prop${kind ? ` ${kind}` : ''}${act ? ` ${act}` : ''}`;
    if (!kind) { held.innerHTML = ''; return; }
    let face = PROPS[kind];
    if (kind === 'point') {
      const r = here?.(), s = av.getBoundingClientRect(), a = r ? Math.atan2(r.top + r.height / 2 - (s.top + 12), r.left + r.width / 2 - (s.left + 12)) : Math.PI * 0.75;
      const left = Math.abs(a) > Math.PI / 2;
      face = left ? '👈' : '👉';
      held.style.setProperty('--aim', `${left ? a - Math.PI * Math.sign(a) : a}rad`); held.style.setProperty('--poke', `${a}rad`);
    }
    // (held up big: up and to the left, or down where the window's top is near)
    if (act === 'cheer') { const s = av.getBoundingClientRect(); held.style.setProperty('--up', s.top < 120 ? '1' : '-1'); held.style.setProperty('--side', s.left < 120 ? '1' : '-1'); }
    held.innerHTML = `<i>${face}</i>${kind === 'delete' ? '<b>📄</b>' : kind === 'done' ? '<b>✨</b><b>✨</b><b>✨</b>' : ''}`;
  }

  // its place: at the top right corner of the box (its line beside it, or to its left near the window's right edge)
  // (its orb centred on the corner, kept SAFE inside the window's edges)
  const spot = () => { const r = here?.() ?? at.dock(); return onScreen(r) ? { x: clamp(r.right, SAFE, innerWidth - SAFE) - 12, y: clamp(r.top, SAFE, innerHeight - SAFE) - 12 } : null; };
  /** Goes to what `rect()` gives (the composer: null), saying `text` (null: what it said). */
  function go(rect, text) {
    clearTimeout(leaving);
    const was = here;
    here = rect;
    const s = spot();
    if (!s) { here = was; return; }
    av.classList.toggle('left', s.x > innerWidth - 320 * SCALE);
    if (av.hidden) { av.hidden = false; fly.to(spot, true); requestAnimationFrame(() => av.classList.add('on')); } else { av.classList.add('on'); fly.to(spot); }
    halo ??= glow(() => (av.hidden ? null : orb.getBoundingClientRect()), { mode: 'spin', radius: 12 * SCALE });
    if (text != null) { cap.textContent = text; cap.hidden = !text; }
  }
  function leave(text, kind = null) {
    go(null, text);
    prop(kind);
    const away = () => { leaving = setTimeout(() => { av.classList.remove('on'); halo?.stop(); halo = null; leaving = setTimeout(() => { av.hidden = true; fly.stop(); prop(null); }, 350); }, kind === 'done' ? 2400 : 1800); };
    // (done: back by the composer, it rings and cheers, then goes)
    if (kind === 'done') arrive(() => { ring('done'); prop('done', 'cheer'); away(); }); else away();
  }
  // shows you `rects`: there, it pokes at the first three times, each lit with a pulse as it pokes
  function point(rects, text) {
    const shown = [...new Set(rects)].filter((f) => onScreen(f())).slice(0, MAX);
    if (working) go(shown[0] ?? null, text);
    prop('point');
    // (each beat of the pulse on a thrust: the first 0.33 s into the poke, as nle.css's prop-point has it)
    arrive(() => { prop('point', 'poke'); setTimeout(() => { if (holding === 'point') for (const f of shown) glow(f, { mode: 'pulse', radius: 3 }); }, 330); });
  }
  // lights what is on screen of `rects` (each once), the avatar going to the first (with Claude working)
  function light(rects, text, kind = 'look') {
    const shown = [...new Set(rects)].filter((f) => onScreen(f())).slice(0, MAX);
    for (const f of shown) glow(f, { mode: 'flash', radius: 3, strength: kind === 'change' ? 1 : 0.7 });
    if (working) go(shown[0] ?? null, text);
  }

  // what is on screen of `rects`, or (none of them: their panel behind another's tab) that panel's tab
  const orTab = (rects, panel) => (rects.some((f) => onScreen(f())) ? rects : [() => at.tab(panel)]);
  // the clips that play notes medium `id` (those of them that play `notes`, its own times, where any does)
  function clipsOf(doc, id, notes = []) {
    const all = (doc.tracks ?? []).flatMap((t) => t.clips).filter((c) => c.media === id);
    const hit = all.filter((c) => notes.some((n) => n.t + n.dur > c.in && n.t < c.out));
    return (hit.length ? hit : all).map((c) => c.id);
  }

  // a step Claude takes: where it is looking, or (reading, searching, running) by the composer
  function tool(name, input = {}) {
    const [verb, what] = say(name, input), text = what ? `${verb} · ${what}` : verb;
    if (kindOf(name, input) !== 'point') queueMicrotask(() => prop(kindOf(name, input)));   // (a finger: point)
    const m = /^mcp__ephemeris__(.+)$/.exec(name)?.[1];
    wrote = !!m && kindOf(name, input) === 'write';
    const ruler = (t) => () => at.ruler(+t);
    const times = String(input.times ?? '').split(',').map(Number).filter(Number.isFinite);
    if (m === 'frames') return light([...times.map(ruler), at.viewer], text);
    if (['view', 'pick', 'locate', 'stacks'].includes(m)) return light([at.viewer, ...(input.t != null ? [ruler(input.t)] : [])], text);
    if (m === 'camera') return light([() => at.lanesOf('camera'), at.viewer], text);
    if (m === 'timeline') return light([at.timeline], text);
    if (m === 'history') return light([at.history], text);
    if (m === 'check') return light([at.status, at.viewer], text);
    if (m === 'render_draft') return light([at.render], text);
    if (m === 'manual') return light([at.help], text);
    if (m === 'mixer' && !mixes(input)) return light(orTab([() => at.mixer()], 'mixer'), text);
    if (m === 'levels') return light(orTab([() => at.mixer('master')], 'mixer'), text);
    if (['notes', 'instruments'].includes(m) && input.media) return light(orTab(clipsOf(at.doc(), input.media).map((id) => () => at.clip(id)), 'timeline'), text);
    // (a thing it shows is found first, then pointed at: result)
    if (m === 'show') { const r = [...(input.property ? [() => at.prop(input.camera ? 'camera' : 'sel', input.property)] : []), ...(input.camera ? [at.viewer] : []), ...(input.t != null ? [ruler(input.t)] : [])]; if (input.select) { go(at.viewer, text); return; } return point(r.length ? r : [at.viewer], text); }
    if (['Edit', 'MultiEdit', 'Write'].includes(name) && /\.(js|css|html|wgsl)$/.test(input.file_path ?? '')) return light([at.viewer], text, 'change');
    // (writing the timeline: it stays where it is until what changed shows, and goes there)
    go(wrote ? here : null, text);
  }

  // what changed on the mixer: each strip's fader, pan, mute, solo and sends, each effect in its chain (the effect's own
  // controls too, where its drawer shows it; the chain where one was taken out), a strip that is new; [rects]
  function mixerChanged(was, now) {
    const strips = (d) => new Map([...(d.tracks ?? []).filter((t) => !isVisual(t)).map((t) => [t.id, t]), ...(d.buses ?? []).map((b) => [`bus:${b.id}`, b]), ['master', d.master ?? {}]]);
    const before = strips(was), out = [];
    for (const [id, o] of strips(now)) {
      const p = before.get(id), part = (sel) => () => at.mixer(id, sel), control = (i, sel) => () => at.fxControl(id, i, sel);
      if (!p) { out.push(part()); continue; }
      for (const k of ['volume', 'pan', 'mute', 'solo']) if (!same(p[k], o[k])) out.push(part(`[data-part="${k}"]`));
      for (const b of new Set([...Object.keys(p.sends ?? {}), ...Object.keys(o.sends ?? {})])) if (!same(p.sends?.[b], o.sends?.[b])) out.push(part(`[data-send="${CSS.escape(b)}"]`));
      const fa = p.fx ?? [], fb = o.fx ?? [];
      fb.forEach((f, i) => {
        if (same(fa[i], f)) return;
        out.push(part(`[data-fx="${i}"]`));
        for (const k of new Set([...Object.keys(fa[i] ?? {}), ...Object.keys(f)])) {
          if (same(fa[i]?.[k], f[k])) continue;
          if (k === 'bands') (f.bands ?? []).forEach((b, j) => { if (!same(fa[i]?.bands?.[j], b)) out.push(control(i, `[data-band="${j}"]`)); });
          else out.push(control(i, `[data-k="${CSS.escape(k)}"]`));
        }
      });
      if (fb.length < fa.length) out.push(part('[data-part="fx"]'));
    }
    return out;
  }

  // what changed between two versions of the timeline: its settings, cues, clips (and the clips that play notes that
  // changed, or whose track's instrument did; the notes written lit in the piano roll, where it shows them), the mixer, and its
  // overrides (the camera's by property, in its lanes; anything else's in the film). Lit once the editor has drawn it.
  function changed(was, now) {
    const lit = [], notes = [], hit = new Set(), all = (now.tracks ?? []).flatMap((t) => t.clips);
    for (const k of ['url', 'fps', 'shutter', 'gi', 'shadows', 'reflections', 'pixelFilter', 'pixelFilterType']) if (!same(was[k], now[k])) lit.push(() => at.field(k));
    for (const what of new Set([...Object.keys(was.rendering ?? {}), ...Object.keys(now.rendering ?? {})])) {
      for (const f of new Set([...Object.keys(was.rendering?.[what] ?? {}), ...Object.keys(now.rendering?.[what] ?? {})])) if (!same(was.rendering?.[what]?.[f], now.rendering?.[what]?.[f])) lit.push(() => at.field(`rendering.${what}.${f}`));
    }
    for (const k of ['viewer', 'master']) if (!same(was.samples?.[k], now.samples?.[k])) lit.push(() => at.field(k === 'viewer' ? 'samplesViewer' : 'samplesMaster'));
    for (const [i, k] of ['width', 'height'].entries()) if (!same(was.size?.[i], now.size?.[i])) lit.push(() => at.field(k));
    for (const k of ['bpm', 'offset', 'beatsPerBar']) if (!same(was.grid?.[k], now.grid?.[k])) lit.push(() => at.field(k));
    const cues = new Map((was.cues ?? []).map((q) => [q.id, q]));
    for (const q of now.cues ?? []) if (!same(cues.get(q.id), q)) lit.push(() => at.cue(q.id), () => at.cueRow(q.id));
    const clips = new Map((was.tracks ?? []).flatMap((t) => t.clips).map((c) => [c.id, c]));
    for (const c of all) if (!same(clips.get(c.id), c)) hit.add(c.id);
    const tracks = new Map((was.tracks ?? []).map((t) => [t.id, t]));
    for (const t of now.tracks ?? []) if (tracks.has(t.id) && !same(tracks.get(t.id).instrument, t.instrument)) for (const c of t.clips) hit.add(c.id);
    // (a note is its time, length, pitch and velocity: one changed is one taken out and one written)
    const sig = (n) => `${n.t}|${n.dur}|${n.note}|${n.vel}`;
    for (const [id, m] of Object.entries(now.media ?? {})) {
      if (!isNotes(m)) continue;
      const old = isNotes(was.media?.[id]) ? was.media[id].notes : [], a = new Set(old.map(sig)), b = new Set(m.notes.map(sig));
      const written = m.notes.filter((n) => !a.has(sig(n))), touched = [...written, ...old.filter((n) => !b.has(sig(n)))];
      if (!touched.length) continue;
      for (const c of clipsOf(now, id, touched)) hit.add(c);
      const f = written.length && at.notes(id, written);
      if (f) notes.push(f);
    }
    const mixer = mixerChanged(was, now);
    const rest = [], tracksWere = new Map((was.tracks ?? []).map((t) => [t.id, t]));
    // (a track muted or soloed: its flag in the timeline's head too)
    for (const t of now.tracks ?? []) for (const k of ['mute', 'solo']) if (!isVisual(t) && !!tracksWere.get(t.id)?.[k] !== !!t[k]) rest.push(() => at.trackFlag(t.id, k));
    const ovs = (d) => new Map((d.overrides ?? []).map((o) => [JSON.stringify(o.on ?? o.stack), o]));
    const before = ovs(was), after = ovs(now);
    for (const [key, o] of after) {
      const b = before.get(key);
      if (same(b, o)) continue;
      if (!o.on?.camera) { rest.push(at.viewer); continue; }
      for (const k of Object.keys(o.props ?? {})) if (!same(b?.props?.[k], o.props[k])) rest.push(() => at.prop('camera', k));
    }
    for (const [key, o] of before) if (!after.has(key)) rest.push(o.on?.camera ? () => at.lanesOf('camera') : at.viewer);
    if (!notes.length && !lit.length && !hit.size && !mixer.length && !rest.length) return;
    // (taking things out of it: the bin)
    const gone = (a, b) => [...a].some((k) => !b.has(k));
    const binned = gone(cues.keys(), new Set((now.cues ?? []).map((q) => q.id))) || gone(clips.keys(), new Set(all.map((c) => c.id))) || gone(before.keys(), after);
    // (the notes first: what it wrote, where the avatar goes; a panel behind another's tab lights its tab)
    requestAnimationFrame(() => {
      const cl = [...hit].map((id) => () => at.clip(id));
      light([...notes, ...lit, ...(cl.length ? orTab(cl, 'timeline') : []), ...(mixer.length ? orTab(mixer, 'mixer') : []), ...rest], working && !wrote ? 'Changed the timeline' : null, 'change');
      if (working) prop(binned ? 'delete' : 'write');
    });
  }

  // a step's result: the thing it picked, found or showed, lit where it is in the frame on screen
  async function result(e) {
    const c = calls.get(e.id);
    calls.delete(e.id);
    const m = /^mcp__ephemeris__(.+)$/.exec(c?.name ?? '')?.[1];
    if (!e.ok || !working || !['pick', 'locate', 'show'].includes(m)) return;
    let sel = m === 'show' ? c.input.select : null, label = c.input.note ?? '';
    if (m !== 'show') try { const r = JSON.parse(e.text); if (r?.at) { sel = { at: r.at, nth: r.nth, key: r.key, like: r.like, copy: r.copy }; label = r.label || r.kind || ''; } } catch { /* not a thing */ }
    const f = sel && (await at.located(sel)), text = `${say(c.name, c.input)[0]}${label ? ` · ${label}` : ''}`;
    if (f && working) { if (m === 'show') point([f], text); else light([f], text); }
    else if (m === 'show' && working) point([at.viewer], text);   // (not in the frame on screen: the viewer)
  }

  return {
    changed,
    /** The panel's events, as they happen (agent.js). */
    event(e) {
      if (e.type === 'you') { working = true; go(null, 'Reading your message'); prop('mail'); }
      else if (e.type === 'tool') { calls.set(e.id, e); tool(e.name, e.input); }
      else if (e.type === 'result') result(e);
      else if (e.type === 'ask') { go(null, 'Waiting for your answer'); prop('ask'); }
      else if (['done', 'error', 'ended'].includes(e.type) && working) { working = false; const ok = e.type === 'done' && e.ok !== false; leave(ok ? 'Done' : 'Stopped', ok ? 'done' : null); }
    },
  };
}

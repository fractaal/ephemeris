// What a frame of the editor costs its main thread while the timeline plays: attaches to the studio's window over CDP,
// plays a few seconds, traces them, and prints the cost per display frame by phase, how busy the main thread was, and
// (--why) what changed the page each frame and which reads forced a layout. It leaves the playhead, the tab and the page
// as they were.
//
//   node .agents/skills/editor-performance/frame-cost.mjs [--port 9229] [--seconds 4] [--at 3] [--tab Mixer]
//        [--css '<a stylesheet to try, removed after>'] [--why]
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const PORT = +arg('port', 9229), SECS = +arg('seconds', 4), AT = arg('at'), TAB = arg('tab'), CSS = arg('css', ''), WHY = process.argv.includes('--why');

// (a bare CDP connection to the editor's page: send(method, params), once(event), and evaluate(fn, arg) as the page's code)
const target = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /\/p\/[^/]+\/[^/]+\/?$/.test(new URL(t.url).pathname));
if (!target) { console.error('No editor page: open a film in the studio.'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`no CDP on port ${PORT}`)); });
let lastId = 0;
const waiting = new Map(), events = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w?.no(new Error(m.error.message)); else w?.ok(m.result); }
  else { const f = events.get(m.method); if (f) { events.delete(m.method); f(m.params); } }
};
const cdp = {
  send: (method, params = {}) => new Promise((ok, no) => { const id = ++lastId; waiting.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); }),
  once: (method, f) => events.set(method, f),
};
const page = {
  async evaluate(fn, a) {
    const r = await cdp.send('Runtime.evaluate', { expression: `(${fn})(${a === undefined ? '' : JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  },
};

const was = await page.evaluate(([css, at, tab]) => {
  const want = tab && [...document.querySelectorAll('.lay-tabs button')].find((b) => b.textContent.trim() === tab);
  const was = { t: window.__nle.t, tab: want?.parentElement.querySelector('button.on')?.textContent.trim() };
  if (css) { const s = document.createElement('style'); s.id = '__frameCost'; s.textContent = css; document.head.append(s); }
  want?.click();
  if (at != null) window.__nle.t = +at;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return was;
}, [CSS, AT, TAB]);
await new Promise((r) => setTimeout(r, 1200));   // (the frames around the playhead come first)
// (Space is dispatched in the page, not sent over CDP: CDP's input waits until a busy main thread takes it)

const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'toplevel', 'v8.execute',
  ...(WHY ? ['disabled-by-default-devtools.timeline.invalidationTracking', 'disabled-by-default-devtools.timeline.stack'] : [])];
await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: categories } });
// (stamped in the trace once it plays: playing waits for the plugin instruments' first sound)
await page.evaluate(() => new Promise((ok) => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  const t0 = performance.now(), wait = () => (document.body.classList.contains('playing') || performance.now() - t0 > 3000 ? ok(console.timeStamp('frame-cost:play')) : requestAnimationFrame(wait));
  wait();
}));
await new Promise((r) => setTimeout(r, SECS * 1000));
await page.evaluate(() => { console.timeStamp('frame-cost:stop'); if (document.body.classList.contains('playing')) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); });
const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.end');
const { stream } = await done, chunks = [];
for (;;) { const { data, eof, base64Encoded } = await cdp.send('IO.read', { handle: stream, size: 1 << 20 }); chunks.push(base64Encoded ? Buffer.from(data, 'base64').toString() : data); if (eof) break; }
await cdp.send('IO.close', { handle: stream });
await page.evaluate(([was, tab]) => {
  document.getElementById('__frameCost')?.remove();
  if (tab && was.tab) [...document.querySelectorAll('.lay-tabs button')].find((b) => b.textContent.trim() === was.tab)?.click();
  window.__nle.t = was.t;
}, [was, TAB]);

const raw = JSON.parse(chunks.join('')), all = raw.traceEvents ?? raw;
const names = new Map(all.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]));
const stamps = all.filter((e) => e.name === 'TimeStamp' && /^frame-cost:/.test(e.args?.data?.message ?? ''));
const play = stamps.find((e) => e.args.data.message === 'frame-cost:play'), stop = stamps.find((e) => e.args.data.message === 'frame-cost:stop');
const main = (e) => e.pid === play.pid && e.tid === play.tid;
const A = play.ts, B = stop.ts;
const ev = all.filter((e) => main(e) && e.ts >= A && e.ts <= B);
const frames = ev.filter((e) => e.name === 'ProxyMain::BeginMainFrame' && e.dur), span = (B - A) / 1e3;
const per = (n) => ev.filter((e) => e.name === n && e.dur).reduce((s, e) => s + e.dur, 0) / 1e3 / Math.max(1, frames.length);
const busy = ev.filter((e) => e.name === 'ThreadControllerImpl::RunTask' && e.dur).reduce((s, e) => s + e.dur, 0) / 1e3 / span;
console.log(`${names.get(`${play.pid}:${play.tid}`)} · ${TAB ? `${TAB} shown · ` : ''}${CSS ? 'with the stylesheet given · ' : ''}${(span / 1000).toFixed(1)} s playing`);
console.log(`  ${frames.length} frames (${((frames.length / span) * 1000).toFixed(0)} a second), main thread busy ${(busy * 100).toFixed(0)}%`);
console.log(`  per frame, ms: whole ${per('ProxyMain::BeginMainFrame').toFixed(2)} · script (rAF) ${per('FireAnimationFrame').toFixed(2)} · style ${per('UpdateLayoutTree').toFixed(2)} · layout ${per('Layout').toFixed(2)} · prepaint ${per('PrePaint').toFixed(2)} · paint ${per('Paint').toFixed(2)} · layerize ${per('Layerize').toFixed(2)} · commit ${per('Commit').toFixed(2)}`);
const other = new Map();
for (const e of ev) if (e.name === 'FunctionCall' && e.dur) { const d = e.args?.data ?? {}, k = `${d.functionName || '(anonymous)'} ${(d.url || '').split('/').pop()}:${d.lineNumber}`; const v = other.get(k) ?? [0, 0]; v[0] += e.dur; v[1]++; other.set(k, v); }
console.log('  script entry points, ms a second (calls a second):');
for (const [k, [d, n]] of [...other].sort((a, b) => b[1][0] - a[1][0]).slice(0, 6)) console.log(`    ${((d / 1e3 / span) * 1000).toFixed(1).padStart(7)} (${((n / span) * 1000).toFixed(0)}) ${k}`);

if (WHY) {
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const at = (st) => (st?.length ? st.slice(0, 3).map((f) => `${f.functionName || '(anonymous)'}@${(f.url || '').split('/').pop()}:${f.lineNumber}`).join(' ← ') : '');
  const changed = new Map(), forced = new Map();
  for (const e of ev) {
    if (/InvalidationTracking$/.test(e.name)) { const d = e.args?.data ?? {}, k = `${d.nodeName ?? ''} · ${d.reason ?? e.name} · ${at(d.stackTrace)}`; changed.set(k, (changed.get(k) ?? 0) + 1); }
    if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.dur) { const st = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace; if (st?.length) { const k = `${e.name} ← ${at(st)}`; forced.set(k, (forced.get(k) ?? 0) + e.dur / 1e3); } }
  }
  console.log('  what changed the page, a second:');
  for (const [k, n] of top(changed, 14)) console.log(`    ${((n / span) * 1000).toFixed(0).padStart(5)}  ${k}`);
  console.log('  layouts forced by script, ms a second:');
  for (const [k, ms] of top(forced, 8)) console.log(`    ${((ms / span) * 1000).toFixed(1).padStart(7)}  ${k}`);
}
process.exit(0);

// Knobs, for the editor's sound panels (the mixer, effects, instruments): each control made from a param's description,
// as engine/sound's modules give them ({ value, min, max, step, unit, curve: 'log', options }: their PARAMS,
// PATCH_PARAMS), so a panel needs no list of its own. A knob is flat: its name over it, an arc of its range with the
// value's part in the accent and a needle to it, its value under it. Drag it up or down (shift: finer), click it and
// scroll it (scrolling over a knob not clicked scrolls the panel: a panel full of knobs can be scrolled through without
// turning them), click its value to type one, double-click it back to its default; onChange(value, final) — final once a drag ends, or a scroll (when
// the pointer leaves the knob, or after a pause), so a panel can make an edit only then.
//   rack(title, spec, values, (key, value, final) => …, [header buttons])   a titled box of a control per param
//   knob(name, d, value, onChange) · choice(name, d, value, onChange)        one control
//   seg(options, value, onChange, { labels, titles })                       one of a few, side by side

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
  const e = ['svg', 'path', 'circle', 'line'].includes(tag) ? document.createElementNS(SVG, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'class') e.setAttribute('class', v); else if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

/** A param's value as a few characters (with its unit). */
export function fmt(v, d = {}) {
  if (typeof v !== 'number') return String(v);
  // (as many decimals as its step has, at most: a whole-number param shows whole numbers)
  const most = d.step ? Math.max(0, Math.min(3, Math.ceil(-Math.log10(d.step) - 1e-9))) : 3;
  const a = Math.abs(v), s = a >= 1000 ? `${+(v / 1000).toFixed(a >= 10000 ? 1 : 2)}k` : v.toFixed(Math.min(most, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3));
  return d.unit === '%' ? `${Math.round(v * 100)}%` : `${s}${d.unit && d.unit !== '%' ? ` ${d.unit}` : ''}`;
}
// a point on the knob's arc (x 0–1 from its lowest to its highest), and the arc between two
const R = 12;
const at = (x, r) => { const a = ((-135 + 270 * x - 90) * Math.PI) / 180; return [16 + Math.cos(a) * r, 16 + Math.sin(a) * r]; };
function arc(x0, x1) {
  const [ax, ay] = at(x0, R), [bx, by] = at(Math.max(x1, x0 + 1e-4), R);
  return `M${ax} ${ay} A${R} ${R} 0 ${270 * (x1 - x0) > 180 ? 1 : 0} 1 ${bx} ${by}`;
}

/** A knob for param description d (its value: `value`, else d.value). A param that can be negative and positive (pan,
 *  gain) draws its arc from zero. */
export function knob(name, d, value, onChange) {
  const lo = d.min ?? 0, hi = d.max ?? 1, log = d.curve === 'log' && lo > 0;
  const toX = (v) => (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo || 1));
  const toV = (x) => { let v = log ? lo * (hi / lo) ** x : lo + x * (hi - lo); if (d.step) v = Math.round(v / d.step) * d.step; return Math.min(hi, Math.max(lo, +v.toFixed(6))); };
  let v = value ?? d.value;
  const fill = el('path', { class: 'knob-arc' }), needle = el('line', { class: 'knob-needle' });
  const svg = el('svg', { viewBox: '0 0 32 32' }, el('path', { d: arc(0, 1), class: 'knob-track' }), fill, needle);
  const val = el('div', { class: 'knob-val' });
  const box = el('div', { class: 'knob', title: `${name}: drag up or down (shift: finer) · click, then scroll · click the value to type · double-click: ${fmt(d.value, d)}` }, el('div', { class: 'knob-name' }, name), svg, val);
  const draw = () => {
    const x = Math.min(1, Math.max(0, toX(v))), z = lo < 0 && hi > 0 ? toX(0) : 0, [x1, y1] = at(x, 2.5), [x2, y2] = at(x, R);
    fill.setAttribute('d', arc(Math.min(z, x), Math.max(z, x)));
    needle.setAttribute('x1', x1); needle.setAttribute('y1', y1); needle.setAttribute('x2', x2); needle.setAttribute('y2', y2);
    val.textContent = fmt(v, d);
  };
  // its value clicked (not dragged): a field to type one in, a percentage as the number it shows; Enter keeps it, Esc or leaving it with nothing typed puts it back
  const typeIn = () => {
    const pct = d.unit === '%', input = el('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': name });
    input.value = String(+(pct ? v * 100 : v).toFixed(4));
    let done = false;
    const finish = (keep) => {
      if (done) return; done = true;
      const x = parseFloat(input.value.replace(',', '.')) / (pct ? 100 : 1);
      input.remove(); draw();
      if (keep && Number.isFinite(x) && Math.min(hi, Math.max(lo, x)) !== v) { v = Math.min(hi, Math.max(lo, +x.toFixed(6))); draw(); onChange(v, true); }
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    for (const t of ['pointerdown', 'dblclick', 'wheel']) input.addEventListener(t, (e) => e.stopPropagation());
    val.textContent = ''; val.append(input); input.focus(); input.select();
  };
  let drag = null, armed = false, scrolled = 0, onVal = false, still = true;   // (armed: clicked, until the pointer leaves it; only then does it take the wheel)
  const settle = () => { if (scrolled) { clearTimeout(scrolled); scrolled = 0; onChange(v, true); } };
  box.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; armed = true; onVal = e.target === val; still = true; drag = { y: e.clientY, x: toX(v), v }; box.setPointerCapture(e.pointerId); box.classList.add('on'); e.preventDefault(); });
  box.addEventListener('pointerleave', () => { armed = false; settle(); });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 3) still = false;
    const nv = toV(Math.min(1, Math.max(0, drag.x + (drag.y - e.clientY) / (e.shiftKey ? 900 : 180))));
    if (nv !== v) { v = nv; draw(); onChange(v, false); }
  });
  box.addEventListener('pointerup', () => { box.classList.remove('on'); if (drag) { const was = drag.v; drag = null; if (v !== was) onChange(v, true); else if (onVal && still) typeIn(); } });   // (a click is no edit)
  box.addEventListener('dblclick', () => { v = d.value; draw(); onChange(v, true); });
  box.addEventListener('wheel', (e) => {
    if (!armed) return;
    e.preventDefault(); v = toV(Math.min(1, Math.max(0, toX(v) - Math.sign(e.deltaY) / 60))); draw(); onChange(v, false);
    clearTimeout(scrolled); scrolled = setTimeout(settle, 1500);   // (an edit can redraw the panel: not while it is being scrolled)
  }, { passive: false });
  draw();
  box.set = (nv) => { v = nv; draw(); };   // (a panel showing a value that changed elsewhere)
  return box;
}
/** A choice among d.options (or on/off for a boolean), each shown as d.labels names it, if it does. */
export function choice(name, d, value, onChange) {
  const opts = d.options ?? [true, false], s = el('select', {}, opts.map((o) => el('option', { value: String(o) }, d.labels?.[o] ?? (typeof o === 'boolean' ? (o ? 'on' : 'off') : String(o)))));
  s.value = String(value ?? d.value);
  s.addEventListener('change', () => onChange(opts.find((o) => String(o) === s.value) ?? s.value, true));
  return el('label', { class: 'knob-choice' }, el('span', {}, name), s);
}
/** One of a few options, side by side (the timeline's Show: Animated | Changed | All); labels[o] may be an element. */
export function seg(options, value, onChange, { labels = {}, titles = {}, cls = '' } = {}) {
  const box = el('div', { class: `seg ${cls}`.trim(), role: 'radiogroup' });
  for (const o of options) {
    const b = el('button', { class: o === value ? 'on' : null, role: 'radio', 'aria-checked': String(o === value), title: titles[o] ?? null }, labels[o] ?? String(o));
    b.addEventListener('click', () => { if (o !== value) onChange(o); });
    box.append(b);
  }
  return box;
}
/** A titled box with a control for each param in spec (values: current, else each default). onChange(key, value, final). */
export function rack(title, spec, values, onChange, extra = []) {
  const body = el('div', { class: 'rack-body' });
  for (const [k, d] of Object.entries(spec)) {
    if (!d || d.list || (d.value != null && typeof d.value === 'object')) continue;   // (lists and objects have no knob)
    const v = values?.[k];
    const name = d.label ?? k[0].toUpperCase() + k.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();   // ('preDelay' → 'Pre delay')
    const c = d.options || typeof d.value === 'boolean' ? choice(name, d, v, (x, f) => onChange(k, x, f)) : knob(name, d, v, (x, f) => onChange(k, x, f));
    c.dataset.k = k;   // (its param: where Claude's light finds it)
    body.append(c);
  }
  return el('div', { class: 'rack' }, el('div', { class: 'rack-head' }, el('b', {}, title), el('span', { class: 'grow' }), ...extra), body);
}

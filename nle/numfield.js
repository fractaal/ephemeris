// Number fields, Blender's way: every <input type=number> in the page, those made later too, takes
//   hover       the pointer becomes an up/down arrow (nle.css)
//   drag        up or down changes the value; shift: finer (a tenth), ctrl: snapped to a coarse grid; Esc puts it back
//   click       types into the field, its number selected; Enter or leaving it keeps what was typed, Esc puts it back
// A field is still the browser's own input: a drag sets its value as it goes (an `input` event) and ends with one
// `change`, as typing does, so the code that reads a field needs nothing of its own. One drag is one edit.
// A field's `step` says how far a pixel goes (a field of large numbers goes further, so a long way needs no long drag);
// its `min` and `max` hold the value.

const isField = (e) => e?.matches?.('input[type=number]:not(:disabled):not([readonly])');
const places = (x) => { const s = String(+x.toFixed(10)), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const PX = 3;   // (a press that moves less than this is a click)

/** The number of units a pixel of drag is worth for a field starting at v: its step, times ten for each ten times
 *  that the value is past 200 steps (a position in the thousands is not dragged a step at a time). */
export function perPixel(step, v) {
  const s = step > 0 ? step : 0.01;
  return s * 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(v) / (s * 200) || 1)));
}

export function numberFields(doc = document) {
  const body = doc.body;
  let drag = null;
  const end = (keep) => {
    if (!drag) return;
    const { input, from, id } = drag;
    drag = null;
    body.classList.remove('numdrag');
    try { input.releasePointerCapture(id); } catch { /* (gone with its field) */ }
    if (!keep) { input.value = from.text; return; }
    if (input.value !== from.text) input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  doc.addEventListener('pointerdown', (e) => {
    const input = e.target;
    if (e.button !== 0 || !isField(input) || doc.activeElement === input) return;   // (a field being typed in is the browser's)
    const v = parseFloat(input.value || input.placeholder), step = parseFloat(input.step);   // (empty: from what it shows)
    e.preventDefault();   // (no focus yet, nor a selection: a click focuses it below, a drag never does)
    input.setPointerCapture(e.pointerId);
    drag = { input, id: e.pointerId, x: e.clientX, y: e.clientY, last: e.clientY, moved: false, acc: 0, from: { text: input.value, v: Number.isFinite(v) ? v : 0 }, step };
    drag.per = perPixel(step, drag.from.v);
  });
  doc.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < PX) return;
      d.moved = true; d.last = d.y; body.classList.add('numdrag');
    }
    const fine = e.shiftKey ? 0.1 : 1;
    d.acc += (d.last - e.clientY) * d.per * fine; d.last = e.clientY;
    let v = d.from.v + d.acc;
    if (e.ctrlKey || e.metaKey) { const grid = d.per * 10; v = Math.round(v / grid) * grid; }
    const { min, max } = d.input;
    if (min !== '' && Number.isFinite(+min)) v = Math.max(+min, v);
    if (max !== '' && Number.isFinite(+max)) v = Math.min(+max, v);
    const text = String(+v.toFixed(Math.max(places(d.per * fine), places(d.per))));
    if (text === d.input.value) return;
    d.input.value = text;
    d.input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  doc.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { input, moved } = drag;
    end(moved);
    if (!moved) { input.focus(); input.select(); }   // (a click: type)
  });
  doc.addEventListener('pointercancel', () => end(false));
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) { e.stopPropagation(); end(false); return; }
    if (!isField(e.target)) return;
    // (Enter keeps the number, as the browser does, then leaves the field, after the browser's own handling of the key;
    // Esc: back to what it was when typing began)
    if (e.key === 'Enter') { const f = e.target; setTimeout(() => f.blur()); }
    else if (e.key === 'Escape') { e.target.value = e.target.dataset.was ?? e.target.value; e.target.blur(); }
  }, true);
  doc.addEventListener('focusin', (e) => { if (isField(e.target)) e.target.dataset.was = e.target.value; });
}

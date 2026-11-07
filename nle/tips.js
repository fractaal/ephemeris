// Tooltips: any element's title, on hover, in the studio's own popover (a browser's comes late and looks like no part of the
// studio). The title moves to data-tip as the pointer reaches it, so the browser's own never shows. A canvas keeps its own: its
// title changes with what is under the pointer. data-tip-fast: sooner. pinTip keeps one up until a click elsewhere.
const SHOW_MS = 350, FAST_MS = 150, HIDE_MS = 120;
let tip = null, showing = 0, hiding = 0, pinned = null;

function hide() { clearTimeout(showing); clearTimeout(hiding); pinned = null; if (tip) tip.hidden = true; }
function show(el) {
  const doc = el.ownerDocument, win = doc.defaultView;
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); }
  doc.body.append(tip);   // (in the element's window: a panel can have its own)
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const a = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(win.innerWidth - w - 8, a.left))}px`;
  tip.style.top = `${a.bottom + h + 6 > win.innerHeight ? Math.max(8, a.top - h - 4) : a.bottom + 4}px`;
}

/** Keeps an element's tooltip up until a click elsewhere, or takes it down if it is up already. */
export function pinTip(el) { clearTimeout(showing); if (pinned === el) hide(); else { show(el); pinned = el; } }

/** Starts them, listening with `on` (addEventListener, or one that reaches other windows too). */
export function startTips(on) {
  on('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    if (tip?.contains(e.target)) { clearTimeout(hiding); return; }
    const el = e.target.closest?.('[title], [data-tip]');
    clearTimeout(showing);
    if (el?.tagName === 'CANVAS') return;
    if (el?.title) { el.dataset.tip = el.title; el.removeAttribute('title'); }
    if (!el?.dataset.tip) { if (!pinned && tip && !tip.hidden) { clearTimeout(hiding); hiding = setTimeout(hide, HIDE_MS); } return; }
    clearTimeout(hiding);
    showing = setTimeout(() => show(el), 'tipFast' in el.dataset ? FAST_MS : SHOW_MS);
  });
  on('pointerdown', (e) => { if (!tip?.contains(e.target) && !e.target.closest?.('[data-tip-fast]')) hide(); }, true);
  on('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// A film's scene as it is now. A frame keeps the scenes the film's code made for its moments (runtime.js), and the code may
// write a buffer in place each time it runs (doctor-who fills one Float32Array with its lightning): a kept scene would then
// hold whichever moment ran last, so what is written in place is copied.
const plain = (x) => { if (!x || typeof x !== 'object') return false; const p = Object.getPrototypeOf(x); return p === Object.prototype || p === null; };

/** v with each typed array in it copied, and every other object the same one where nothing in it was copied. A list of copies is left as it is. */
export function frozen(v, depth = 0) {
  if (ArrayBuffer.isView(v)) return v.slice();
  if (depth > 8) return v;
  if (Array.isArray(v)) {
    let out = null;
    for (let i = 0; i < v.length; i++) { const f = frozen(v[i], depth + 1); if (f !== v[i]) (out ??= [...v])[i] = f; }
    return out ?? v;
  }
  if (!plain(v)) return v;
  let out = null;
  for (const k in v) { if (k === 'instances' || k === 'options') continue; const f = frozen(v[k], depth + 1); if (f !== v[k]) (out ??= { ...v })[k] = f; }
  return out ?? v;
}

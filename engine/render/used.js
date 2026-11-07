// A shader's WGSL as the GPU is given it: only what its entry points use, without its comments. The scene's shared code
// (shaders.js: the camera, the world, materials, the ray walk) is in every shader of the renderer's that reads the scene,
// and a film's pass is given all of it, so a film's modules came to 1.4 MB, most of it unused (on spring-brutalist a
// pass reached 2 to 10 % of its 150 KB, and a third of all of it was comments), which the GPU's process parses before it
// compiles anything. Each line stays where it was, so that a compiler's line is the source's.

// (a declaration at the top of a module: its attributes, its kind, its name)
const DECL = /^\s*((?:@\w+\s*(?:\([^)]*\))?\s*)*)(fn|struct|var\s*(?:<[^>]*>)?|const|override|alias)\s+([A-Za-z_]\w*)/;
const STAGE = /@(?:compute|vertex|fragment)\b/;

/** `code` without its comments and the declarations no entry point reaches left out (blank lines in their place). */
export function used(code) {
  const src = blankComments(code), n = src.length, items = [];
  // the module's top-level items: a function or a struct to its closing brace, anything else to its semicolon
  let start = 0, depth = 0;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === '{' || c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '}') {
      if (--depth > 0) continue;
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === ';') i = j;   // (a struct may end with one)
      items.push([start, i + 1]); start = i + 1;
    } else if (c === ';' && depth === 0) { items.push([start, i + 1]); start = i + 1; }
  }
  if (src.slice(start).trim()) items.push([start, n]);
  // what each declares, and what must stay whatever uses it: the entry points, the constants a pipeline sets
  // (override), and what declares nothing (enable, requires, diagnostic, const_assert)
  const named = new Map(), keep = new Set(), todo = [];
  items.forEach(([a, b], k) => {
    const m = DECL.exec(src.slice(a, b));
    if (!m) { keep.add(k); return; }
    if (!named.has(m[3])) named.set(m[3], []);
    named.get(m[3]).push(k);
    if (m[2] === 'override' || STAGE.test(m[1])) todo.push(k);
  });
  // and what they name, and what that names
  while (todo.length) {
    const k = todo.pop();
    if (keep.has(k)) continue;
    keep.add(k);
    const [a, b] = items[k];
    for (const [w] of src.slice(a, b).matchAll(/[A-Za-z_]\w*/g)) for (const d of named.get(w) ?? []) if (!keep.has(d)) todo.push(d);
  }
  let out = '', at = 0;
  items.forEach(([a, b], k) => {
    out += lines(src.slice(at, a));
    const text = src.slice(a, b);
    out += keep.has(k) ? text.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n') : lines(text);
    at = b;
  });
  return out + lines(src.slice(at));
}

// (only the line breaks of what is left out)
const lines = (s) => s.replace(/[^\n]+/g, '');

// the code without its comments (block comments nest), their line breaks kept, a block comment a space at least
function blankComments(code) {
  const parts = [], n = code.length;
  let i = 0, from = 0;
  while ((i = code.indexOf('/', i)) >= 0) {
    if (code[i + 1] === '/') { const e = code.indexOf('\n', i); parts.push(code.slice(from, i)); i = from = e < 0 ? n : e; continue; }
    if (code[i + 1] !== '*') { i++; continue; }
    let j = i, depth = 0;
    do {
      if (code[j] === '/' && code[j + 1] === '*') { depth++; j += 2; }
      else if (code[j] === '*' && code[j + 1] === '/') { depth--; j += 2; }
      else j++;
    } while (j < n && depth > 0);
    parts.push(code.slice(from, i), ' ', lines(code.slice(i, j)));
    i = from = j;
  }
  parts.push(code.slice(from));
  return parts.join('');
}

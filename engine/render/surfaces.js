// The film's surfaces (F.surface, see surface.js) compiled into the shaders that shade meshes: their code, each apart
// from the others, and surfaceOf / shadeOf, which run the one a material names (its number and its mesh's place in
// the params' table: the material's `surface`, number + 256 × place). Seen everywhere the mesh is, since the camera's
// shader and every ray shade through surfaceAt.
export const STRIDE = 8;   // vec4s of params a mesh's surface has (32 floats)

// a surface's code with the names it declares made its own (k: its number): its functions, structs, consts, vars, its
// params (p) and its entry point (not after a '.': a field)
function apart(S, k) {
  // (only what it declares at the top of its code: a function's own lets and vars are its own already)
  const names = new Set(['p', S.mode]);
  let depth = 0, top = '';
  for (const ch of S.code) { if (ch === '{') depth++; top += depth === 0 ? ch : ch === '\n' ? '\n' : ' '; if (ch === '}') depth--; }
  for (const m of top.matchAll(/\b(?:fn|struct|const|alias|override)\s+([A-Za-z_]\w*)|\bvar\s*(?:<[^>]*>)?\s+([A-Za-z_]\w*)/g)) names.add(m[1] ?? m[2]);
  for (const r of ['SurfaceIn', 'SurfaceOut', 'asIs', 'hash3', 'noise3']) names.delete(r);
  const re = names.size ? new RegExp(`(?<![\\w.])(${[...names].join('|')})\\b`, 'g') : null;
  // its params, read from the table (each field where WGSL's layout puts it: never across a vec4)
  const sw = ['x', 'y', 'z', 'w'], read = S.layout.fields.map((f) => `sp[b + ${Math.floor(f.off / 4)}].${f.n === 4 ? 'xyzw' : sw.slice(f.off % 4, (f.off % 4) + f.n).join('')}`);
  return `${S.layout.struct.replace(/\bParams\b/, `Params_${k}`)}
var<private> p_${k}: Params_${k};
fn load_${k}(b: i32) -> Params_${k} { return Params_${k}(${read.length ? read.join(', ') : '0.0'}); }
${re ? S.code.replace(re, (n) => `${n}_${k}`) : S.code}`;
}

/** The WGSL for the surfaces a scene uses (`list`, numbered from 1 in order). */
export function surfacesWGSL(list) {
  const cases = (mode, call) => list.map((S, i) => (S.mode === mode ? `case ${i + 1}: { p_${i + 1} = load_${i + 1}(b); ${call(i + 1)} }` : '')).join(' ');
  return /* wgsl */`
struct SurfaceIn { world: vec3f, local: vec3f, normal: vec3f, view: vec3f, uv: vec2f, uvdx: vec2f, uvdy: vec2f, base: vec3f, rough: f32, metal: f32, emit: vec3f, t: f32 };
// one of the surface's pictures (its params' handle: p.<name>) where the point is, at the level its footprint asks for
fn surfaceTexture(h: f32, s: SurfaceIn) -> vec4f { if (h < 0.0) { return vec4f(1.0); } return texRead(h, s.uv, s.uvdx, s.uvdy); }
struct SurfaceOut { base: vec3f, rough: f32, metal: f32, normal: vec3f, emit: vec3f };
fn asIs(s: SurfaceIn) -> SurfaceOut { return SurfaceOut(s.base, s.rough, s.metal, s.normal, s.emit); }
fn noise3(x: vec3f) -> f32 {
  let i = floor(x); let f = fract(x); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
${list.map((S, i) => apart(S, i + 1)).join('\n')}
fn surfaceNumber(id: f32) -> i32 { return i32(id + 0.5) % 256; }
fn surfaceParams(id: f32) -> i32 { return 1 + (i32(id + 0.5) / 256) * ${STRIDE}; }
fn surfaceOf(id: f32, s: SurfaceIn) -> SurfaceOut {
  let b = surfaceParams(id);
  switch surfaceNumber(id) { ${cases('surface', (k) => `return surface_${k}(s);`)} default: { return asIs(s); } }
}
fn shadesItself(id: f32) -> bool { switch surfaceNumber(id) { ${list.map((S, i) => (S.mode === 'shade' ? `case ${i + 1}: { return true; }` : '')).join(' ')} default: { return false; } } }
fn shadeOf(id: f32, s: SurfaceIn) -> vec3f {
  let b = surfaceParams(id);
  switch surfaceNumber(id) { ${cases('shade', (k) => `return shade_${k}(s);`)} default: { return s.base; } }
}`;
}

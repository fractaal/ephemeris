// A photo in depth. Depth Anything V2 Small (tools/models.mjs, on the GPU) measures how far away each pixel is, and the
// photo is cut by that into layers that can stand apart in the world (elements/depth.js places them):
//   far   the whole photo, with what is nearer painted out
//   mid   what is between (only when the photo has three depths: a group standing at one depth has two layers)
//   near  the nearest: usually the people
// The cut follows depth, not things: a person reaching towards the camera can fall across two layers, and what is
// painted out is filled by LaMa (big-lama, tools/models.mjs), which carries on what is around it (the ground, a wall)
// where it shows, as the camera moves; it is soft, from the photo at 512 × 512.
//
//   node tools/depth.mjs <image> [--out <dir>] [--name <name>] [--crop x,y,w,h]
//   ./ephemeris depth <film> <image> [--name …] [--crop …]     into the film's assets/depth
//
// Writes <name>-far.jpg, <name>-mid.webp (three layers only), <name>-near.webp, <name>-depth.png (0 far … 255 near) and
// <name>.json: { w, h, layers, depth: { far, mid, near } (each layer's mean, 0 far … 1 near), cuts, source, crop, model, fill }.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { model, closeModels } from './models.mjs';

const MODEL = 'depth-anything-v2-small';
const SIZE = 518, MULTIPLE = 14, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];   // (its preprocessing)

const ff = (args, input) => new Promise((ok, fail) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]), out = [], err = [];
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => err.push(d));
  p.on('error', fail);
  p.on('close', (c) => (c === 0 ? ok(Buffer.concat(out)) : fail(new Error(`ffmpeg: ${Buffer.concat(err).toString().trim()}`))));
  p.stdin.on('error', () => {});
  p.stdin.end(input ?? null);
});
const raw = (fmt, w, h) => ['-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${w}x${h}`, '-i', '-'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------- blur: a Gaussian as three box blurs (each a running sum along rows, then columns; edges clamped)
function boxSizes(sigma) {
  const ideal = Math.sqrt(4 * sigma * sigma + 1);
  let lo = Math.floor(ideal); if (lo % 2 === 0) lo--;
  const m = Math.round((12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4));
  return [0, 1, 2].map((i) => (i < m ? lo : lo + 2));
}
function boxPass(src, dst, w, h, ch, r, vertical) {
  const n = 2 * r + 1, len = vertical ? h : w, lines = vertical ? w : h;
  const step = vertical ? w * ch : ch, lineStep = vertical ? ch : w * ch;
  for (let l = 0; l < lines; l++) for (let c = 0; c < ch; c++) {
    const base = l * lineStep + c;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, len - 1) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc / n;
      acc += src[base + Math.min(i + r + 1, len - 1) * step] - src[base + Math.max(i - r, 0) * step];
    }
  }
}
function blur(src, w, h, sigma, ch = 1) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) / 2;
    boxPass(a, b, w, h, ch, r, false); boxPass(b, a, w, h, ch, r, true);
  }
  return a;
}

// ---------- grow a mask by a disc of radius r: the squared distance to the nearest set pixel (Felzenszwalb's exact
// distance transform, by columns then rows), within r²
function edt1(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while ((s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])) <= z[k]) k--;
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
function grow(mask, w, h, r) {
  const g = new Float64Array(w * h), n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : 1e20;
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[y * w + x]; edt1(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]; edt1(f, w, d, v, z); for (let x = 0; x < w; x++) g[y * w + x] = d[x]; }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = g[i] <= r * r ? 1 : 0;
  return out;
}

// ---------- paint out: LaMa (big-lama) fills what the mask covers, from the whole photo squeezed to its 512 × 512
const FILL = 'big-lama', SIDE = 512;
/** The photo with `mask` (grown by a disc `radius` px, then feathered) painted out. */
async function paintOut(lama, rgb, mask, w, h, radius) {
  const m = grow(mask.map((v) => (v > 0.12 ? 1 : 0)), w, h, radius), k = blur(m, w, h, 5);
  const small = await ff([...raw('rgb24', w, h), '-vf', `scale=${SIDE}:${SIDE}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], rgb);
  // (a pixel of its mask is a hole if any of the photo's pixels under it is)
  const hole = await ff([...raw('gray', w, h), '-vf', `scale=${SIDE}:${SIDE}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], Uint8Array.from(m, (v) => v * 255));
  const N = SIDE * SIDE, image = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) image[c * N + i] = small[i * 3 + c] / 255;
  const { output } = await lama.run({ image: { data: image, dims: [1, 3, SIDE, SIDE] }, mask: { data: Float32Array.from(hole, (v) => (v > 0 ? 1 : 0)), dims: [1, 1, SIDE, SIDE] } });
  const filled = new Uint8Array(3 * N);   // (its output is 0 … 255)
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) filled[i * 3 + c] = clamp(Math.round(output.data[c * N + i]), 0, 255);
  const fill = await ff([...raw('rgb24', SIDE, SIDE), '-vf', `scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], filled);
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgb[i * 3 + c] * (1 - k[i]) + fill[i * 3 + c] * k[i]);
  return out;
}

// ---------- the cuts: the two thresholds that split the depths into three classes with the most variance between them
// (multi-Otsu, over 256 bins)
function cuts(d) {
  let lo = Infinity, hi = -Infinity;
  for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const N = 256, bin = (hi - lo) / N || 1, count = new Float64Array(N + 1), sum = new Float64Array(N + 1);
  for (const v of d) { const i = Math.min(N - 1, Math.floor((v - lo) / bin)); count[i + 1]++; sum[i + 1] += lo + (i + 0.5) * bin; }
  for (let i = 1; i <= N; i++) { count[i] += count[i - 1]; sum[i] += sum[i - 1]; }
  const part = (a, b) => { const n = count[b] - count[a], s = sum[b] - sum[a]; return n > 0 ? (s * s) / n : 0; };
  let best = -1, ti = 0, tj = 1;
  for (let i = 1; i < N - 1; i++) for (let j = i + 1; j < N; j++) {
    const v = part(0, i) + part(i, j) + part(j, N);
    if (v > best) { best = v; ti = i; tj = j; }
  }
  return [lo + (ti - 0.5) * bin, lo + (tj - 0.5) * bin];
}
const soft = (d, t, w, h, width = 0.025) => blur(d.map((v) => { const a = clamp((v - (t - width)) / (2 * width), 0, 1); return a * a * (3 - 2 * a); }), w, h, 1.5);
const percentile = (sorted, p) => { const i = (p / 100) * (sorted.length - 1), a = Math.floor(i); return sorted[a] + (sorted[Math.min(a + 1, sorted.length - 1)] - sorted[a]) * (i - a); };
const mean = (d, keep) => { let s = 0, n = 0; for (const v of d) if (keep(v)) { s += v; n++; } return n ? s / n : null; };

/** Cuts `file` (`crop`: [x, y, w, h] of it) into layers in `out`, named `name`; returns what it wrote (the .json's). */
export async function depthLayers(file, { out, name = path.parse(file).name, crop = null }) {
  const [fw, fh] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim().split('x').map(Number);
  const [cx, cy, w, h] = crop ?? [0, 0, fw, fh];
  if (!(w > 0 && h > 0 && cx >= 0 && cy >= 0 && cx + w <= fw && cy + h <= fh)) throw new Error(`${path.basename(file)} is ${fw}×${fh}: no crop ${crop}`);
  const rgb = await ff(['-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=${w}:${h}:${cx}:${cy}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);

  // the model sees the photo with its shorter side at 518 (each side a multiple of 14), as it was trained
  let sw = SIZE / w, sh = SIZE / h;
  if (Math.abs(1 - sw) < Math.abs(1 - sh)) sh = sw; else sw = sh;
  const mw = Math.round((w * sw) / MULTIPLE) * MULTIPLE, mh = Math.round((h * sh) / MULTIPLE) * MULTIPLE;
  const small = await ff([...raw('rgb24', w, h), '-vf', `scale=${mw}:${mh}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], rgb);
  const input = new Float32Array(3 * mw * mh);
  for (let i = 0; i < mw * mh; i++) for (let c = 0; c < 3; c++) input[c * mw * mh + i] = (small[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const m = await model(MODEL);
  const { predicted_depth: pd } = await m.run({ pixel_values: { data: input, dims: [1, 3, mh, mw] } });
  // to the photo's size (ffmpeg clamps float pixels to 0 … 1 as it scales: the depths are brought within 0.1 … 0.9 first)
  const [dh, dw] = pd.dims.slice(-2);
  let lo = Infinity, hi = -Infinity;
  for (const v of pd.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const unit = pd.data.map((v) => 0.1 + (0.8 * (v - lo)) / (hi - lo || 1));
  const up = await ff([...raw('grayf32le', dw, dh), '-vf', `scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'grayf32le', '-'], Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength));
  const d = new Float32Array(up.buffer.slice(up.byteOffset, up.byteOffset + up.byteLength));

  // its depths (relative: larger is nearer), 0 … 1 between its 1st and 99.5th percentiles
  const sorted = Float32Array.from(d).sort(), p0 = percentile(sorted, 1), p1 = percentile(sorted, 99.5);
  for (let i = 0; i < d.length; i++) d[i] = clamp((d[i] - p0) / (p1 - p0 + 1e-6), 0, 1);
  let [t1, t2] = cuts(d);
  // three layers only where the nearest stands well clear of the middle (a group at one depth: people, and the rest)
  const layers = mean(d, (v) => v >= t2) - mean(d, (v) => v >= t1 && v < t2) > 0.3 ? 3 : 2;
  if (layers === 2) t2 = t1;
  const near = soft(d, t2, w, h), mid = soft(d, t1, w, h);
  const alpha = (a, colour) => { const o = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { o.set(colour.subarray(i * 3, i * 3 + 3), i * 4); o[i * 4 + 3] = clamp(Math.round(a[i] * 255), 0, 255); } return o; };

  fs.mkdirSync(out, { recursive: true });
  const at = (part) => path.join(out, `${name}-${part}`);
  const lama = await model(FILL);
  const far = await paintOut(lama, rgb, mid, w, h, 15), between = layers === 3 ? alpha(mid, await paintOut(lama, rgb, near, w, h, 10)) : null;
  if (!between) fs.rmSync(at('mid.webp'), { force: true });
  await Promise.all([
    ff([...raw('rgb24', w, h), '-q:v', '2', at('far.jpg')], far),
    between && ff([...raw('rgba', w, h), '-c:v', 'libwebp', '-quality', '92', at('mid.webp')], between),
    ff([...raw('rgba', w, h), '-c:v', 'libwebp', '-quality', '92', at('near.webp')], alpha(near, rgb)),
    ff([...raw('gray', w, h), at('depth.png')], Uint8Array.from(d, (v) => Math.round(v * 255))),
  ]);
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const meta = {
    w, h, layers, depth: { far: r3(mean(d, (v) => v < t1)), mid: layers === 3 ? r3(mean(d, (v) => v >= t1 && v < t2)) : null, near: r3(mean(d, (v) => v >= t2)) },
    cuts: [r3(t1), r3(t2)], source: path.relative(out, file), crop, model: MODEL, fill: FILL, on: m.on,
  };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(meta, null, 1) + '\n');
  return { name, ...meta };
}

/** One line for what depthLayers wrote. */
export const describe = (r) => `${r.name}: ${r.w}×${r.h}, ${r.layers} layers (far ${r.depth.far}${r.depth.mid != null ? `, mid ${r.depth.mid}` : ''}, near ${r.depth.near}; 0 far … 1 near), on ${r.on}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = opt('out') ?? 'depth', name = opt('name'), crop = opt('crop')?.split(',').map(Number);
  if (!args.length) { console.error('usage: node tools/depth.mjs <image…> [--out <dir>] [--name <name>] [--crop x,y,w,h]'); process.exit(1); }
  if (args.length > 1 && (name || crop)) { console.error('--name and --crop are for one image'); process.exit(1); }
  try { for (const f of args) console.log(describe(await depthLayers(path.resolve(f), { out: path.resolve(out), name, crop }))); }
  finally { await closeModels(); }
}

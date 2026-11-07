// Dumps one moment of an Ephemeris film's scene (its meshes in world space, materials, lights, environment, camera) as
// JSON for a Blender/Cycles ground truth. World positions are computed as instanceData does (R = Rz·Ry·Rx, scaled, then
// moved); normals by R·S⁻¹. Colours given as hex are sRGB and are converted to linear.
//   node dump.mjs <film page url> <t> <out.json>
import fs from 'node:fs';
import { openBrowser } from '../../tools/browser.mjs';

const [,, url, t = '0', out = 'scene.json'] = process.argv;
const br = await openBrowser();
const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 120000 });
const scene = await p.evaluate((t) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const hex = (h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  const colour = (c) => (typeof c === 'string' ? hex(c) : Array.isArray(c) ? c : null);
  const r = (d) => ((d ?? 0) * Math.PI) / 180;
  const s = window.__ephemeris.film.scene(t);
  const meshes = [], lights = [];
  for (const n of s.nodes) {
    if (!n) continue;
    if (n.light) {
      const at = [n.x ?? 0, n.y ?? 0, n.z ?? 0];
      let dir = n.dir ?? null;
      if (!dir && n.aim) { const d = n.aim.map((v, i) => v - at[i]); const l = Math.hypot(...d); dir = d.map((v) => v / l); }
      lights.push({ kind: n.light, at, dir, color: colour(n.color ?? '#ffffff'), intensity: typeof n.intensity === 'number' ? n.intensity : 1, angle: n.angle, radius: n.radius });
      continue;
    }
    if (!n.mesh?.geo) continue;
    const g = n.mesh.geo, V = g.pos.length / 3;
    const pos = [], nrm = [], tint = [], idx = [];
    for (const it of n.instances) {
      const S = Array.isArray(it.s) ? it.s : [it.s ?? 1, it.s ?? 1, it.s ?? 1];
      const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(it.rx)), Math.sin(r(it.rx)), Math.cos(r(it.ry)), Math.sin(r(it.ry)), Math.cos(r(it.rz)), Math.sin(r(it.rz))];
      const R = [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx], [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]];
      const base = pos.length / 3;
      for (let v = 0; v < V; v++) {
        const q = [g.pos[v * 3] * S[0], g.pos[v * 3 + 1] * S[1], g.pos[v * 3 + 2] * S[2]];
        const m = [g.nrm[v * 3] / S[0], g.nrm[v * 3 + 1] / S[1], g.nrm[v * 3 + 2] / S[2]];
        for (let i = 0; i < 3; i++) pos.push(R[i][0] * q[0] + R[i][1] * q[1] + R[i][2] * q[2] + [it.x ?? 0, it.y ?? 0, it.z ?? 0][i]);
        const w = [0, 1, 2].map((i) => R[i][0] * m[0] + R[i][1] * m[1] + R[i][2] * m[2]); const l = Math.hypot(...w) || 1;
        nrm.push(...w.map((c) => c / l));
      }
      for (const i of g.idx) idx.push(base + i);
      tint.push(...(it.baseColor ? colour(it.baseColor) : [1, 1, 1]));
    }
    meshes.push({ label: n.mesh.label, material: n.material, verts: V, pos, nrm, idx, tint });
  }
  const env = s.environment ?? {};
  return { t, camera: s.camera, environment: { zenith: colour(env.zenith), horizon: colour(env.horizon), nadir: colour(env.nadir), intensity: env.intensity ?? 1 }, view: s.view, lights, meshes };
}, +t);
fs.writeFileSync(out, JSON.stringify(scene));
console.log(`${scene.meshes.length} meshes, ${scene.meshes.reduce((a, m) => a + m.idx.length / 3, 0)} triangles, ${scene.lights.length} lights → ${out}`);
await br.close();

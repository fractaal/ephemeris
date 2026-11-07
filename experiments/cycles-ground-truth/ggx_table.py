#!/usr/bin/env python3
# Writes engine/render/ggx.js: GGX's directional albedo by numerical integration, for each roughness and cosine of the view
# angle. Each sample is a normal drawn from those the viewer sees (Heitz 2018, "Sampling the GGX Distribution of Visible
# Normals"), whose weight is G2 / G1 (Heitz 2014, height-correlated Smith), so nothing is fitted. Run from the studio's root.
import numpy as np

N, SAMPLES = 32, 512
u1, u2 = np.meshgrid((np.arange(SAMPLES) + 0.5) / SAMPLES, (np.arange(SAMPLES) + 0.5) / SAMPLES)
u1, u2 = u1.ravel(), u2.ravel()

def lam(c, a):
    c2 = np.maximum(c * c, 1e-12)
    return 0.5 * (-1.0 + np.sqrt(1.0 + a * a * (1.0 - c2) / c2))

def dielectric(c, eta=1.5):
    """A dielectric's Fresnel reflectance at cosine c, unpolarised (what Cycles' fresnel_dielectric_cos computes)."""
    g = np.sqrt(np.maximum(eta * eta - 1 + c * c, 0))
    a = (g - c) / (g + c); b = (c * (g + c) - 1) / (c * (g - c) + 1)
    return 0.5 * a * a * (1 + b * b)

F0_15 = ((1.5 - 1) / (1.5 + 1)) ** 2

def albedo(rough, mu):
    """→ x, y, d: the integral of the BSDF without its Fresnel, times 1 - (1 - V.H)^5 and (1 - V.H)^5 (Schlick's F = F0 x + F90 y), and
    times how far an actual dielectric of index 1.5 goes from its F0 to 1 at V.H, the same for a dielectric: F = F0 (x + y - d) + F90 d."""
    a = max(rough * rough, 1e-4)
    mu = max(mu, 1e-3)
    V = np.array([np.sqrt(1.0 - mu * mu), 0.0, mu])
    Vh = np.array([a * V[0], 0.0, V[2]]); Vh /= np.linalg.norm(Vh)
    l2 = Vh[0] ** 2
    T1 = np.array([0.0, 1.0, 0.0]) if l2 > 0 else np.array([1.0, 0.0, 0.0])
    T2 = np.cross(Vh, T1)
    r = np.sqrt(u1); phi = 2 * np.pi * u2
    t1 = r * np.cos(phi); s = 0.5 * (1 + Vh[2])
    t2 = (1 - s) * np.sqrt(np.maximum(1 - t1 * t1, 0)) + s * r * np.sin(phi)
    nz = np.sqrt(np.maximum(1 - t1 * t1 - t2 * t2, 0))
    Nh = t1[..., None] * T1 + t2[..., None] * T2 + nz[..., None] * Vh
    Ne = np.stack([a * Nh[..., 0], a * Nh[..., 1], np.maximum(Nh[..., 2], 0)], axis=-1)
    Ne /= np.linalg.norm(Ne, axis=-1, keepdims=True)
    VoH = np.maximum((Ne * V).sum(axis=-1), 0)
    Lz = 2 * VoH * Ne[..., 2] - V[2]
    w = np.where(Lz > 0, (1 + lam(mu, a)) / (1 + lam(mu, a) + lam(np.maximum(Lz, 1e-6), a)), 0.0)
    c = (1 - VoH) ** 5
    return (w * (1 - c)).mean(), (w * c).mean(), (w * (dielectric(VoH) - F0_15) / (1 - F0_15)).mean()

rows = []
for j in range(N):
    rough = j / (N - 1)
    fine = [(mu, sum(albedo(rough, mu)[:2])) for mu in (np.arange(64) + 0.5) / 64]
    avg = 2 * sum(mu * E for mu, E in fine) / 64   # (Kulla and Conty 2017's E_avg: the albedo over the hemisphere, by the cosine)
    cells = []
    for i in range(N):
        x, y, d = albedo(rough, i / (N - 1))
        cells.append(f'{x:.5g},{y:.5g},{avg:.5g},{d:.5g}')
    rows.append('  ' + ', '.join(cells) + ',')
    print(f'roughness {rough:.3f}: E head-on {sum(albedo(rough, 1.0)[:2]):.4f}, E_avg {avg:.4f}', flush=True)
head = """// GGX's directional albedo, by numerical integration (experiments/cycles-ground-truth/ggx_table.py), as Cycles keeps its own
// (intern/cycles/scene/shader.tables, table_ggx_E): for each roughness (32 rows, 0 to 1) and cosine of the view angle (32
// columns, 0 to 1), a vec4: what the BSDF reflects as F0 · x + F90 · y under Schlick's Fresnel (x, y; x + y its albedo with
// F = 1), its albedo over the hemisphere (E_avg), and the y of an actual dielectric of index 1.5, which goes from F0 to 1 as
// Schlick's does not (d: F0 · (x + y - d) + F90 · d, for what Cycles' dielectrics reflect: Schlick's is 9% under at 38 degrees).
// The second table in the scene's tables (scene.js), after the sheen's, where the BSDF reads it (shaders.js, ggxAt). It takes
// the place of Karis 2014's fit, whose y on a glossy surface (0.0094 at roughness 0.1 seen at 38 degrees, where this has
// 0.0006) made every dielectric's reflection and highlight about 20% too bright, and whose albedo at roughness 0.6 is 15% low.
export const GGX_LUT = new Float32Array([
"""
open('engine/render/ggx.js', 'w').write(head + '\n'.join(rows) + '\n]);\n')

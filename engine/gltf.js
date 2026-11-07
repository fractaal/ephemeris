// glTF models (.gltf with its .bin and textures, or .glb): what Blender and model libraries export. Loaded into one
// mesh in world px — y down like the rest of the world (the model turned 180° about z, so it is not mirrored and still
// faces the camera), centred on its bounding box, its largest side `size` px — with its base colour texture, its normal
// map and factors.
// Supported: triangle primitives with POSITION (and NORMAL, TEXCOORD_0), node transforms, one material's base colour
// texture and normal map.
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

export async function loadGLTF(url, { size = 400 } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model ${url}: ${res.status}`);
  let json, bin = null;
  const raw = await res.arrayBuffer(), head = new DataView(raw);
  if (head.getUint32(0, true) === 0x46546c67) {   // 'glTF': binary, a JSON chunk then a BIN chunk
    const jl = head.getUint32(12, true);
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 20, jl)));
    bin = raw.slice(28 + jl, 28 + jl + head.getUint32(20 + jl, true));
  } else json = JSON.parse(new TextDecoder().decode(raw));
  const base = new URL(url, location.href);
  const buffers = await Promise.all((json.buffers ?? []).map(async (b) => (b.uri ? (await fetch(new URL(b.uri, base))).arrayBuffer() : bin)));
  const read = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], n = COMPONENTS[a.type], T = TYPES[a.componentType];
    const stride = v.byteStride ?? 0, off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), buf = buffers[v.buffer];
    if (!stride || stride === n * T.BYTES_PER_ELEMENT) return new T(buf.slice(off, off + a.count * n * T.BYTES_PER_ELEMENT));
    const out = new T(a.count * n), src = new DataView(buf);
    const get = { 5126: 'getFloat32', 5125: 'getUint32', 5123: 'getUint16', 5121: 'getUint8', 5122: 'getInt16', 5120: 'getInt8' }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = src[get](off + k * stride + c * T.BYTES_PER_ELEMENT, true);
    return out;
  };
  // every mesh node of the default scene, with its world transform
  const pos = [], nrm = [], uv = [], idx = [];
  let material = null;
  const visit = (ni, parent) => {
    const node = json.nodes[ni], M = mul(parent, local(node));
    if (node.mesh != null) for (const p of json.meshes[node.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const P = read(p.attributes.POSITION), N = p.attributes.NORMAL != null ? read(p.attributes.NORMAL) : null, U = p.attributes.TEXCOORD_0 != null ? read(p.attributes.TEXCOORD_0) : null;
      const first = pos.length / 3, count = P.length / 3;
      for (let k = 0; k < count; k++) {
        pos.push(...apply(M, [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]], 1));
        const nn = N ? apply(M, [N[k * 3], N[k * 3 + 1], N[k * 3 + 2]], 0) : [0, 0, 1], l = Math.hypot(...nn) || 1;
        nrm.push(nn[0] / l, nn[1] / l, nn[2] / l);
        uv.push(U ? U[k * 2] : 0, U ? U[k * 2 + 1] : 0);
      }
      const I = p.indices != null ? read(p.indices) : Array.from({ length: count }, (_, k) => k);
      for (const i of I) idx.push(first + i);
      material ??= json.materials?.[p.material ?? -1] ?? null;
    }
    for (const c of node.children ?? []) visit(c, M);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const ni of scene?.nodes ?? json.nodes.map((_, i) => i)) visit(ni, IDENTITY);
  // into the world: turned 180° about z (y up → y down, x mirrored back), centred, scaled to size
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const c = lo.map((v, k) => (v + hi[k]) / 2), s = size / Math.max(...hi.map((v, k) => v - lo[k]));
  const P = new Float32Array(pos.length), N = new Float32Array(nrm);
  for (let i = 0; i < pos.length; i += 3) {
    P[i] = -(pos[i] - c[0]) * s; P[i + 1] = -(pos[i + 1] - c[1]) * s; P[i + 2] = (pos[i + 2] - c[2]) * s;
    N[i] = -nrm[i]; N[i + 1] = -nrm[i + 1];
  }
  // a texture of the material's (its textureInfo), as its mip chain; one beside the model that is not there is an error,
  // but a missing normal map (optional) a warning: the model loads without it
  const picture = async (info, optional = false) => {
    if (!info) return null;
    const img = json.images[json.textures[info.index].source];
    let blob;
    if (img.uri) {
      const r = await fetch(new URL(img.uri, base));
      if (!r.ok) {
        const why = `model ${url}: its ${img.uri} is not there (${r.status})`;
        if (optional) { console.warn(`${why}: loaded without its normal map`); return null; }
        throw new Error(why);
      }
      blob = await r.blob();
    } else {
      const v = json.bufferViews[img.bufferView];
      blob = new Blob([buffers[v.buffer].slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)], { type: img.mimeType });
    }
    return mips(blob);
  };
  const [texture, normalMap] = await Promise.all([picture(material?.pbrMetallicRoughness?.baseColorTexture), picture(material?.normalTexture, true)]);
  return { geo: { pos: P, nrm: N, uv: new Float32Array(uv), idx: new Uint32Array(idx) }, texture, normalMap, material: principled(material, s) };
}

// a texture's mip chain as image bitmaps (each half the last), so a model seen small does not shimmer
export async function mips(blob) {
  const top = await createImageBitmap(blob, { colorSpaceConversion: 'none' }), levels = [top];
  for (let w = top.width, h = top.height; w > 1 || h > 1;) {
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    levels.push(await createImageBitmap(top, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }));
  }
  return levels;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// column-major 4x4, as glTF stores them
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }
function local(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
// normals (w = 0) through the matrix's rotation and scale (exact for rotations and uniform scale)
function apply(M, [x, y, z], w) { return [0, 1, 2].map((r) => M[r] * x + M[4 + r] * y + M[8 + r] * z + M[12 + r] * w); }

/**
 * A glTF material's factors as material options (Blender's Principled BSDF names: see material() in mesh.js), from its
 * metallic-roughness core and the extensions Blender's exporter writes Principled BSDF into (glTF colours are linear:
 * back to sRGB; lengths are in the model's units: scaled as the model is, by s).
 */
function principled(m, s) {
  if (!m) return {};
  const pbr = m.pbrMetallicRoughness ?? {}, x = m.extensions ?? {}, o = {};
  const srgb = (c) => c.slice(0, 3).map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  o.baseColor = srgb(pbr.baseColorFactor ?? [1, 1, 1]);
  o.metallic = pbr.metallicFactor ?? (pbr.metallicRoughnessTexture ? 0 : 1);
  o.roughness = pbr.roughnessFactor ?? 0.5;
  if (m.normalTexture?.scale != null) o.normalStrength = m.normalTexture.scale;
  if (m.emissiveFactor?.some((v) => v > 0)) { o.emissionColor = srgb(m.emissiveFactor); o.emissionStrength = x.KHR_materials_emissive_strength?.emissiveStrength ?? 1; }
  if (x.KHR_materials_ior) o.ior = x.KHR_materials_ior.ior ?? 1.5;
  if (x.KHR_materials_transmission) o.transmissionWeight = x.KHR_materials_transmission.transmissionFactor ?? 0;
  if (x.KHR_materials_dispersion) o.dispersion = x.KHR_materials_dispersion.dispersion ?? 0;
  const sp = x.KHR_materials_specular;
  if (sp) { o.specularIorLevel = 0.5 * (sp.specularFactor ?? 1); if (sp.specularColorFactor) o.specularTint = srgb(sp.specularColorFactor); }
  const cc = x.KHR_materials_clearcoat;
  if (cc) { o.coatWeight = cc.clearcoatFactor ?? 0; o.coatRoughness = cc.clearcoatRoughnessFactor ?? 0; }
  const sh = x.KHR_materials_sheen;
  if (sh?.sheenColorFactor?.some((v) => v > 0)) { o.sheenWeight = 1; o.sheenTint = srgb(sh.sheenColorFactor); o.sheenRoughness = sh.sheenRoughnessFactor ?? 0; }
  const ir = x.KHR_materials_iridescence;
  if (ir?.iridescenceFactor > 0) { o.thinFilmThickness = ir.iridescenceThicknessMaximum ?? 400; o.thinFilmIor = ir.iridescenceIor ?? 1.3; }
  const vol = x.KHR_materials_volume;
  if (vol) {
    if (vol.attenuationColor) o.attenuationColor = srgb(vol.attenuationColor);
    if (vol.attenuationDistance) o.attenuationDistance = vol.attenuationDistance * s;
    if (vol.thicknessFactor) o.thickness = vol.thicknessFactor * s;
  }
  return o;
}

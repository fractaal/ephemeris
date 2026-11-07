// Benchmark transport, not an engine API. Static renderer inputs retain identity across frames;
// scene values are frozen at the actual renderSub boundary. No functions or GPU commands cross it.
export class Encoder {
  constructor() { this.ids = new WeakMap(); this.objects = new Map(); this.next = 1; this.pending = []; this.layers = new Map(); this.bitmaps = new Map(); }
  resource(x, kind, data) {
    let id = this.ids.get(x);
    if (!id) {
      id = this.next++; this.ids.set(x, id); this.objects.set(id, x);
      this.pending.push({ id, kind, data: data() });
    }
    return { $ref: id };
  }
  value(x, key = '') {
    if (typeof x === 'number' && !Number.isFinite(x)) return { $number: String(x) };
    if (x == null || ['number', 'string', 'boolean'].includes(typeof x)) return x;
    if (typeof x === 'function') throw new Error(`Cannot transfer function at ${key}`);
    if (ArrayBuffer.isView(x)) return { $array: x.constructor.name, data: Array.from(x) };
    if (Array.isArray(x)) return x.map((v) => this.value(v));
    if (x.capture && x.width && x.height) {
      const r = this.resource(x, 'Layer', () => ({ width: x.width, height: x.height }));
      this.layers.set(r.$ref, x); return r;
    }
    const kind = x.constructor?.name;
    if (['Pass', 'Surface', 'Texture', 'Target', 'Mesh'].includes(kind)) {
      return this.resource(x, kind, () => this.plain(x));
    }
    if (x.pos && x.idx && ArrayBuffer.isView(x.pos)) return this.resource(x, 'Geometry', () => this.plain(x));
    if (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) {
      const r = this.resource(x, 'Image', () => ({ width: x.width, height: x.height }));
      this.bitmaps.set(r.$ref, x); return r;
    }
    if (kind?.startsWith('GPU')) throw new Error(`Unexpected GPU object at ${key}: ${kind}`);
    return this.plain(x);
  }
  plain(x) {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      // Runtime/editor metadata and renderer-owned caches are not inputs to drawing.
      if (['gpu', 'renderPipes', 'pickPipes', 'texLayout', 'texBG', 'texBGKey', 'pickTo', 'site', 'site0'].includes(k)) continue;
      if (k === 'layer') { out.layer = { worldW: v.worldW, worldH: v.worldH }; continue; }
      out[k] = this.value(v, k);
    }
    return out;
  }
  drain() { return this.pending.splice(0); }
}

export class Decoder {
  constructor(classes = {}, layer = (d) => d) { this.classes = classes; this.layer = layer; this.objects = new Map(); }
  add(resources) {
    for (const { id, kind, data } of resources) {
      this.objects.set(id, kind === 'Layer' ? this.layer(data) : this.classes[kind] ? Object.create(this.classes[kind].prototype) : {});
    }
    for (const { id, kind, data } of resources) if (kind !== 'Layer') Object.assign(this.objects.get(id), this.value(data));
  }
  value(x) {
    if (x == null || typeof x !== 'object') return x;
    if ('$ref' in x) { if (!this.objects.has(x.$ref)) throw new Error(`Missing resource ${x.$ref}`); return this.objects.get(x.$ref); }
    if ('$number' in x) return Number(x.$number);
    if ('$array' in x) return new globalThis[x.$array](x.data);
    if (Array.isArray(x)) return x.map((v) => this.value(v));
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.value(v)]));
  }
}

// One binary message: JSON metadata followed by raw, tightly packed RGBA layer images.
export function pack(meta, images) {
  let offset = 0;
  meta.images = images.map(({ id, width, height, version, data }) => {
    const r = { id, width, height, version, offset, length: data.byteLength }; offset += data.byteLength; return r;
  });
  const json = new TextEncoder().encode(JSON.stringify(meta)), out = new Uint8Array(4 + json.length + offset);
  new DataView(out.buffer).setUint32(0, json.length, true); out.set(json, 4);
  offset = 4 + json.length;
  for (const { data } of images) { out.set(data, offset); offset += data.byteLength; }
  return out;
}
export function unpack(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
  return { meta, images: meta.images.map((d) => ({ ...d, data: bytes.subarray(4 + n + d.offset, 4 + n + d.offset + d.length) })) };
}

// A photo in depth: the layers tools/depth.mjs cut it into (assets/depth/<name>-far, -mid, -near and <name>.json), stood
// apart in the world and scaled so that from the camera's rest they line up as the photo. As the camera turns round,
// what is near comes away from what is behind it.
//
//   const P = await depthPhoto(F, 'party', { frame: { x: 0.42, y: 0.3, zoom: 1.35 } });
//   rig(t0, cam({ x: X, z: P.pivot, yaw: -12 }), { drift: { yaw: 8 } })   // a camera that turns round it
//   draw(t, push) { P.draw(push, X, 0); }                                 // the photo at X, 0 in the world
//
// The rest: an orbit camera looking at (x, y, pivot), unturned, at zoom 1, whose lens is `focal`. Each layer is a
// layer the director can select, named `<label> far`, `<label> mid`, `<label> near`.
import { FOCAL, W, H } from '../engine/camera.js';
import { clamp } from '../engine/time.js';

// where the photo ends, it fades: no hard edge when the camera shows it
const EDGE = 'linear-gradient(to right, transparent, #000 5%, #000 95%, transparent), linear-gradient(to bottom, transparent, #000 5%, #000 95%, transparent)';

/**
 * frame: the part of the photo the frame shows, centred on (x, y) of it (0–1), zoom times tighter than the whole photo
 * fits the frame. room: how much more of the photo each layer holds than the frame shows (room for the camera to move).
 * deep: how far behind the nearest layer the farthest stands. pivot: the depth the camera turns round (between what is
 * near and what is behind it). cover: how much larger each layer is drawn, so a farther one's edge never shows.
 */
export async function depthPhoto(F, name, {
  dir = './assets/depth', frame: { x: fx = 0.5, y: fy = 0.5, zoom = 1 } = {}, room = 1.3, deep = 1000, pivot = -300,
  cover = { far: 1.1, mid: 1.05, near: 1 }, focal = FOCAL, label = name,
} = {}) {
  const meta = await (await fetch(`${dir}/${name}.json`)).json(), { w, h } = meta;
  const sw = Math.min(w, (h * W) / H) / zoom, sh = (sw * H) / W, k = W / sw;
  const cx = clamp(fx * w, sw / 2, w - sw / 2), cy = clamp(fy * h, sh / 2, h - sh / 2);
  const d = meta.depth, z = { far: -deep, mid: d.mid == null ? null : (-deep * (d.near - d.mid)) / (d.near - d.far), near: 0 };
  const scale = (at) => (pivot + focal - at) / focal;   // (a layer at depth `at`, so that it shows at 1:1 from the rest)
  const layers = (meta.layers === 3 ? ['far', 'mid', 'near'] : ['far', 'near']).map((part) => {
    const el = document.createElement('div'), img = document.createElement('img');
    img.src = `${dir}/${name}-${part}.${part === 'far' ? 'jpg' : 'webp'}`;
    el.style.overflow = 'hidden';
    Object.assign(img.style, { position: 'absolute', left: `${(W * room) / 2 - cx * k}px`, top: `${(H * room) / 2 - cy * k}px`,
      width: `${w * k}px`, height: `${h * k}px`, maskImage: EDGE, maskComposite: 'intersect' });
    el.append(img);
    const L = F.layer(el, { w: W * room, h: H * room, pad: 2, res: part === 'far' ? 1 : 1.15, label: `${label} ${part}` });
    return { part, L, z: z[part], s: scale(z[part]) * cover[part] };
  });
  return {
    name, meta, pivot, layers,
    /** Pushes its layers at x, y in the world (`o`: more of each layer's options, as .at takes them). */
    draw(push, x = 0, y = 0, o = {}) { for (const l of layers) push(l.L.at(x, y, l.z, { ...o, s: l.s * (o.s ?? 1) })); },
    /** Its far layer again, blurred and dimmed far behind: a fast camera move (a whip) never shows past its edge. */
    backdrop(push, x = 0, y = 0) { const at = -deep - 900; push(layers[0].L.at(x, y, at, { s: scale(at) * 1.3, blur: 40, bright: 0.5 })); },
  };
}

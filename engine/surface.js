// Surfaces: a mesh's look written in the film's own WGSL, instead of (or on top of) the Principled material. Made with
// F.surface(code, { params, textures, label }) and given to a mesh where it is placed, its params beside it (any of them a motion,
// each a lane in the editor):
//
//   const TILES = F.surface(/* wgsl */`
//   fn surface(s: SurfaceIn) -> SurfaceOut {
//     var o = asIs(s);                                        // the material's own inputs, as the mesh has them
//     let cell = floor(s.world.xz / 60.0);
//     let worn = smoothstep(0.55, 0.63, noise3(vec3f(s.world.xz * 0.002, 0.0))) * p.worn;
//     o.base *= (0.85 + 0.3 * hash3(vec3f(cell, 0.0))) * mix(1.0, 0.85, worn);
//     o.rough = mix(o.rough, 0.15, worn);
//     return o;
//   }`, { label: 'tiles', params: { worn: { value: 0.6, min: 0, max: 1 } } });
//   nodes.push(FLOOR.at(0, 0, 0, { surface: TILES, worn: motion(0.6).to(12, 2, 1), roughness: 0.8 }));
//
// Two kinds, by the function the code defines:
//   fn surface(s: SurfaceIn) -> SurfaceOut   its outputs (base colour, roughness, metallic, normal, emission) are lit
//                                            as the Principled material is: the environment, the scene's lights, traced
//                                            shadows and reflections where the scene asks for them, GI, the denoiser
//   fn shade(s: SurfaceIn) -> vec3f          its own light: what the surface shows (linear light, before the view
//                                            transform), lit however the code likes, or not at all (unlit)
// SurfaceIn: world (its point, px), local (the same in the mesh's own space), normal (unit, facing the eye, bent by the
// mesh's normal map if it has one), view (unit, toward the eye), uv, and how fast it changes across what is drawn
// (uvdx, uvdy), base (the material's base colour × the copy's × its texture, linear), rough, metal, emit (its emission),
// t (the film's moment). asIs(s) is a SurfaceOut of the material as it is. p.<name> are its params (as a pass's:
// numbers, vectors, colours; up to 32 floats); its textures ({ textures: { name: F.texture(…) } }: images) are params
// too, read where the point is with surfaceTexture(p.name, s) — an occlusion map, a mask, a decal on the mesh's uv. It
// sees the scene as the renderer's shaders do (engine/render/shaders.js): hash3, noise3 (smooth value noise, 0–1),
// lightCount(), world.lights[i], environment(R, spread), irradiance(N).
//
// It is drawn everywhere the mesh is seen: to the camera, in reflections, GI's light and what glass shows through, since
// the camera's shader and every ray shade a point with the same code, the film's surfaces compiled in (a pipeline for
// each set of surfaces a scene uses, made once; engine/render/surfaces.js). Not on glass (a material with transmission
// keeps its own look), and without displacement: a surface changes how the mesh looks, not where it is (displace a
// mesh's geometry where it is made, and it is displaced everywhere, shadows and reflections too). The WGSL names a
// surface's code declares are its own (each is renamed apart from the others' in the shader).
import { paramsOf, Texture } from './pass.js';
import { STRIDE } from './render/surfaces.js';

let made = 0;
/** Every surface the film has made, in the order it made them: what the renderer's shaders are compiled with. */
export const everySurface = [];
export class Surface {
  constructor(code, { params = {}, textures = {}, label = 'surface' } = {}) {
    const shade = /fn\s+shade\s*\(/.test(code), surface = /fn\s+surface\s*\(/.test(code);
    if (!shade && !surface) throw new Error(`surface "${label}": its code defines fn surface(s: SurfaceIn) -> SurfaceOut, or fn shade(s: SurfaceIn) -> vec3f`);
    for (const [k, t] of Object.entries(textures)) {
      if (!(t instanceof Texture) || !t.url) throw new Error(`surface "${label}": texture "${k}" is an image F.texture() loads`);
      if (k in params) throw new Error(`surface "${label}": "${k}" names both a param and a texture`);
    }
    this.code = code;
    this.label = label;
    this.mode = shade ? 'shade' : 'surface';
    this.id = ++made;
    everySurface.push(this);
    // (its pictures are params too: each a handle into the renderer's texture store, the picture given where a mesh is
    // placed, or this one)
    this.textures = textures;
    Object.assign(this, paramsOf({ ...params, ...Object.fromEntries(Object.keys(textures).map((k) => [k, -1])) }, label));   // (defaults, ranges, layout)
    Object.assign(this.defaults, textures);
    if (this.layout.bytes > STRIDE * 16) throw new Error(`surface "${label}": its params take ${this.layout.bytes} bytes; a surface has ${STRIDE * 16}`);
  }
}

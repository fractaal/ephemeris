// Tests for the editor's changes to whole objects (overrides.js, on: { sites }) and to the scene's own settings (on:
// { scene: true }): `node engine/overrides.test.mjs`. An object is what the code defines and every line that places it;
// a change to it changes every copy, each as one would be, and a copy's own change applies over it. The scene's
// settings are how it is seen, the lens's glow and the light around: a change replaces the code's, or goes over it.
const { applyOverrides, applyScene } = await import('./overrides.js');
const { Mesh, box, rgb } = await import('./mesh.js');
const { Light } = await import('./light.js');

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`  FAIL ${what}`); } return ok; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
// a node as the code placed it, from a line of its own (what the editor names it by)
const from = (at, n) => ({ ...n, site: { at } });
const PILLAR = new Mesh(box({ w: 10 }), { label: 'pillars' });
// a field of pillars placed by two lines (near and far), and one more mesh by a third
const scene = () => [
  from('film.js:10:5', PILLAR.many([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 100, y: 0, z: 0, s: 2 }, { id: 'c', x: 200, y: 0, z: 0, baseColor: '#808080' }], { roughness: 0.3 })),
  from('film.js:10:40', PILLAR.many([{ id: 'd', x: 300, y: 0, z: 0 }, { id: 'e', x: 400, y: 0, z: 0 }], { roughness: 0.3 })),
  from('film.js:20:5', PILLAR.at(500, 0, 0, { roughness: 0.3 })),
];
const OBJECT = ['film.js:10:5', 'film.js:10:40'];
const lane = (mode, keys) => ({ lanes: [{ id: 'y1', kind: 'keys', mode, keys }] });
const copies = (nodes, at) => nodes.filter((n) => n.site.at === at).flatMap((n) => n.instances.map((it) => ({ n, it })));
const byId = (nodes) => Object.fromEntries(nodes.flatMap((n) => n.instances.map((it) => [it.id ?? 'other', { n, it }])));

{
  const out = byId(applyOverrides(scene(), [{ id: 'o1', on: { sites: OBJECT }, props: { x: lane('add', [[0, 50]]) } }], 0));
  check(['a', 'b', 'c', 'd', 'e'].every((id, i) => near(out[id].it.x, i * 100 + 50)), 'moving an object moves every copy of it, from every line that places it, by the same amount');
  check(near(out.other.it.x, 500), 'moving an object leaves what another line places where the code has it');
}
{
  const out = byId(applyOverrides(scene(), [{ id: 'o1', on: { sites: OBJECT }, props: { s: lane('multiply', [[0, 3]]) } }], 0));
  check(near(out.a.it.s, 3) && near(out.b.it.s, 6), 'scaling an object scales each copy by the factor, from its own scale');
  check(near(out.b.it.x, 100), 'scaling an object scales each copy where it stands');
}
{
  const out = applyOverrides(scene(), [{ id: 'o1', on: { sites: OBJECT }, props: { roughness: lane('replace', [[0, 0.9]]) } }], 0);
  check([...copies(out, OBJECT[0]), ...copies(out, OBJECT[1])].length === 5, 'an object\'s material change keeps every copy');
  check([...copies(out, OBJECT[0]), ...copies(out, OBJECT[1])].every(({ n }) => near(n.material.roughness, 0.9)), 'an object\'s material change is the material every copy is drawn with');
  check(copies(out, 'film.js:20:5').every(({ n }) => near(n.material.roughness, 0.3)), 'an object\'s material change leaves another line\'s things as the code has them');
}
{
  const out = applyOverrides(scene(), [{ id: 'o1', on: { sites: OBJECT }, props: { baseColor: '#ff0000' } }], 0);
  const all = [...copies(out, OBJECT[0]), ...copies(out, OBJECT[1])];
  // (a copy is drawn in its material's colour times its own tint)
  const drawn = ({ n, it }) => n.material.baseColor.map((v, c) => v * (it.baseColor ? rgb(it.baseColor)[c] : 1));
  check(all.every((x) => drawn(x).every((v, c) => near(v, [1, 0, 0][c]))), 'a colour set on an object is the colour every copy is drawn in, a tinted copy too');
}
{
  const out = byId(applyOverrides(scene(), [
    { id: 'o1', on: { sites: OBJECT }, props: { x: lane('add', [[0, 50]]) } },
    { id: 'o2', on: { at: OBJECT[0], nth: 0, key: 'b' }, props: { x: lane('add', [[0, 10]]) } },
  ], 0));
  check(near(out.b.it.x, 160), 'a copy\'s own change applies over its object\'s');
  check(near(out.a.it.x, 50) && near(out.d.it.x, 350), 'a copy\'s own change leaves the object\'s other copies with the object\'s');
}
{
  // a key that lands the object on a value: every copy lands there, each from where its own code puts it
  const out = byId(applyOverrides(scene(), [{ id: 'o1', on: { sites: OBJECT }, props: { x: lane('aim', [[1, 250]]) } }], 1, () => ({ nodes: scene() })));
  check(['a', 'b', 'c', 'd', 'e'].every((id) => near(out[id].it.x, 250)), 'an Aim key on an object lands every copy on its value');
}
{
  // lights a loop places from one line
  const LAMP = new Light('point', { intensity: 1, label: 'lamp' });
  const lamps = () => [0, 1, 2].map((i) => from('film.js:30:7', LAMP.at(i * 100, 0, 0))).concat(from('film.js:31:7', LAMP.at(900, 0, 0)));
  const out = applyOverrides(lamps(), [{ id: 'o1', on: { sites: ['film.js:30:7'] }, props: { intensity: lane('replace', [[0, 4]]), y: lane('add', [[0, -20]]) } }], 0);
  check(out.slice(0, 3).every((n) => near(n.intensity, 4) && near(n.y, -20)), 'a change to the lights a loop places changes each of them');
  check(near(out[3].intensity, 1) && near(out[3].y, 0), 'a change to the lights a loop places leaves a light another line places as the code has it');
}

{
  // the scene's own settings, as a film's scene() returns them
  const film = () => ({ nodes: [], view: { transform: 'agx' }, post: { bloom: 0.03, vignette: 0.3 },
    environment: { zenith: '#3a62c4', intensity: 0.5, backdrop: { color: '#000000', glows: [{ x: 960, y: 540, r: 800, color: '#0a120a' }] } } });
  const scene = (props) => applyScene(film(), [{ id: 's1', on: { scene: true }, props }], 1, film);
  check(near(scene({ bloom: lane('replace', [[0, 0.08]]) }).post.bloom, 0.08), 'the bloom the director keys replaces the film\'s');
  check(near(scene({ vignette: lane('replace', [[0, 0]]) }).post.vignette, 0), 'the vignette the director keys replaces the film\'s');
  check(near(scene({ exposure: lane('add', [[0, 0.5]]) }).view.exposure, 1.5), 'exposure the film does not set changes from what is seen without one (1)');
  check(near(scene({ intensity: lane('multiply', [[0, 2]]) }).environment.intensity, 1), 'the light around, scaled, scales the film\'s');
  check(scene({ transform: 'neutral' }).view.transform === 'neutral', 'the view transform the director picks is the one the frame is seen through');
  check(scene({ zenith: '#ff8800' }).environment.zenith === '#ff8800', 'a sky colour the director picks replaces the film\'s');
  const b = scene({ backdrop: '#112233' }).environment.backdrop;
  check(b.color === '#112233' && b.glows.length === 1 && b.glows[0].r === 800, 'a backdrop colour the director picks keeps the film\'s glows on it');
  const same = applyScene(film(), [{ id: 'c1', on: { camera: true }, props: { zoom: lane('replace', [[0, 2]]) } }], 1, film);
  check(JSON.stringify([same.view, same.post, same.environment]) === JSON.stringify([film().view, film().post, film().environment]), 'without changes to the scene, its settings are the film\'s');
}

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('ok');

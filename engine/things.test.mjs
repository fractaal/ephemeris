// What the director adds by hand (engine/things.js) and what they can change on things (engine/overrides.js): each shape
// is what it says, a linked copy follows what it copies, and a thing hidden, scaled along an axis or turned comes out so.
// `node --test engine/things.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { thingNodes, SHAPES } from './things.js';
import { applyOverrides } from './overrides.js';
import { Mesh, box } from './mesh.js';
import { Light } from './light.js';
import { matchCopy } from './pick.js';
import { liveEdits } from './site.js';
import { filmSees } from '../nle/anchors.js';
import { thingChanges } from '../nle/model.js';

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);
const clip = (thing, id = 'c1') => ({ id, at: 0, in: 0, out: 5, thing });
const lane = (mode, v) => ({ lanes: [{ id: 'y1', kind: 'keys', mode, keys: [[0, v]], static: true }] });
const one = (thing) => thingNodes(clip(thing), [], matchCopy)[0];

test('each shape is 100 px across, centred, before its scale', () => {
  for (const type of Object.keys(SHAPES)) {
    const [lo, hi] = one({ type }).mesh.bounds, wide = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    near(wide, 100, `${type}'s widest`);
    for (const a of [0, 1, 2]) near(lo[a] + hi[a], 0, `${type}'s centre on axis ${a}`);
  }
});

test('a plane lies flat, facing up', () => {
  const m = one({ type: 'plane' }).mesh, { pos, nrm } = m.geo;
  for (let i = 1; i < pos.length; i += 3) assert.equal(pos[i], 0);
  for (let i = 1; i < nrm.length; i += 3) assert.equal(nrm[i], -1);   // (y up is negative)
});

test('a cone has its tip up, its sides facing outward and its base closed', () => {
  const { pos, nrm, idx } = one({ type: 'cone' }).mesh.geo;
  let sides = 0, base = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const [x, y, z, nx, ny, nz] = [pos[i], pos[i + 1], pos[i + 2], nrm[i], nrm[i + 1], nrm[i + 2]];
    if (y === -50) assert.ok(Math.hypot(x, z) < 1e-9, 'all that is at the top is its tip');
    if (ny > 0) { base++; assert.equal(y, 50); continue; }
    sides++;
    assert.ok(ny < 0, 'its sides lean up');
    if (Math.hypot(x, z) > 1) assert.ok(x * nx + z * nz > 0, 'its sides face outward');
  }
  assert.ok(sides && base && idx.length > 0);
});

test('a shape is where the thing says, scaled along each axis, with its material and its name', () => {
  const n = one({ type: 'cube', label: 'Wall', x: 10, y: 20, z: 30, rx: 45, sx: 2, sy: 3, sz: 4, roughness: 0.2 });
  assert.equal(n.label, 'Wall');
  assert.deepEqual(n.instances[0].s, [2, 3, 4]);
  assert.deepEqual([n.instances[0].x, n.instances[0].y, n.instances[0].z, n.instances[0].rx], [10, 20, 30, 45]);
  near(n.material.roughness, 0.2, 'roughness');
  assert.equal(n.site.at, 'clip:c1');
});

test('a light shines straight down, or as it is turned', () => {
  const down = one({ type: 'spot', x: 1, y: 2, z: 3 }), turned = one({ type: 'spot', rx: 90 });
  assert.equal(down.light, 'spot');
  assert.deepEqual([down.x, down.y, down.z], [1, 2, 3]);
  assert.deepEqual(down.dir, [0, 1, 0]);
  near(turned.dir[1], 0, 'turned 90° about x: nothing left going down'); near(turned.dir[2], 1, 'turned 90° about x: its way along z');
});

test('two things of one shape are told apart by their clips', () => {
  const a = thingNodes(clip({ type: 'cube' }, 'c1'), [], matchCopy)[0], b = thingNodes(clip({ type: 'cube' }, 'c2'), [], matchCopy)[0];
  assert.notEqual(a.site.at, b.site.at);
});

const BRICK = new Mesh(box({ w: 10 }), { label: 'brick' }), LAMP = new Light('spot', { label: 'lamp' });
const placed = () => [
  { ...BRICK.many([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 100, y: 0, z: 0 }]), site: { at: 'film.js:1:1' } },
  { ...LAMP.at(0, 0, 0, { aim: [0, 100, 0] }), site: { at: 'film.js:2:1' } },
];

test('a linked copy of an object is every copy of it, moved by its offset, under its own name', () => {
  const [n] = thingNodes(clip({ of: { sites: ['film.js:1:1'] }, label: 'bricks 2', x: 5, y: 6, z: 7 }), placed(), matchCopy);
  assert.deepEqual(n.instances.map((it) => [it.x, it.y, it.z]), [[5, 6, 7], [105, 6, 7]]);
  assert.equal(n.label, 'bricks 2');
  assert.equal(n.site.at, 'clip:c1');
});

test('a linked copy of one copy is that copy alone', () => {
  const [n] = thingNodes(clip({ of: { at: 'film.js:1:1', nth: 0, key: 'b' }, x: 5 }), placed(), matchCopy);
  assert.deepEqual(n.instances.map((it) => it.x), [105]);
});

test('a linked copy of a light still shines where that light shines', () => {
  const [n] = thingNodes(clip({ of: { at: 'film.js:2:1', nth: 0 }, x: 50 }), placed(), matchCopy);
  assert.equal(n.x, 50);
  assert.deepEqual(n.aim, [50, 100, 0]);
});

test('a linked copy is not there where what it copies is not', () => {
  assert.deepEqual(thingNodes(clip({ of: { sites: ['film.js:9:9'] } }), placed(), matchCopy), []);
});

const at = 'clip:c1', on = { at, nth: 0 };
const added = (thing) => thingNodes(clip(thing), [], matchCopy);

test('a hidden thing is not in the scene', () => {
  assert.deepEqual(applyOverrides(added({ type: 'cube' }), [{ id: 'o', on, props: { hidden: true } }], 0), []);
});
test('a hidden copy is gone, and the others stay', () => {
  const out = applyOverrides(placed(), [{ id: 'o', on: { at: 'film.js:1:1', nth: 0, key: 'a' }, props: { hidden: true } }], 0);
  assert.deepEqual(out.find((n) => n.mesh).instances.map((it) => it.id), ['b']);
  assert.ok(out.some((n) => n.light), 'and the rest of the scene');
});
test('a hidden object is gone, every copy', () => {
  const out = applyOverrides(placed(), [{ id: 'o', on: { sites: ['film.js:1:1'] }, props: { hidden: true } }], 0);
  assert.equal(out.filter((n) => n.mesh).length, 0);
});
test('scaling along one axis leaves the others', () => {
  const [n] = applyOverrides(added({ type: 'cube', sx: 2, sy: 3, sz: 4 }), [{ id: 'o', on, props: { sy: lane('multiply', 2) } }], 0);
  assert.deepEqual(n.instances[0].s, [2, 6, 4]);
});
test('a light turned shines its new way, its own aim given up', () => {
  const lamp = placed()[1], [n] = applyOverrides([lamp], [{ id: 'o', on: { at: 'film.js:2:1', nth: 0 }, props: { rx: lane('add', 90) } }], 0);
  near(n.dir[1], 0, 'nothing left going down'); near(n.dir[2], 100, 'its way along z');
  assert.equal(n.aim, undefined);
});
test('an added light turned goes from straight down, however it was turned before', () => {
  const [n] = applyOverrides(added({ type: 'spot', rx: 30 }), [{ id: 'o', on, props: { rx: lane('add', 60) } }], 0);
  near(n.dir[1], 0, 'turned to 90° in all: nothing left going down'); near(n.dir[2], 1, 'its way along z');
});
test('a light\'s shadows can be switched either way', () => {
  const [off] = applyOverrides(added({ type: 'point', shadows: true }), [{ id: 'o', on, props: { shadows: false } }], 0);
  const [onn] = applyOverrides(added({ type: 'point' }), [{ id: 'o', on, props: { shadows: true } }], 0);
  assert.equal(off.shadows, false); assert.equal(onn.shadows, true);
});
test('a glow set by its strength and colour lights up in that colour', () => {
  const [n] = applyOverrides(added({ type: 'cube' }), [{ id: 'o', on, props: { emissionStrength: lane('replace', 4), emissionColor: '#ff0000' } }], 0);
  near(n.material.emission[0], 4, 'red'); near(n.material.emission[1], 0, 'green'); near(n.material.emission[2], 0, 'blue');
});

const timeline = (clips = [], media = {}, tracks = []) => ({ version: 2, media, cues: [], tracks: [...tracks, { id: 'things', kind: 'visual', things: true, clips }] });
test('adding or moving a thing changes what the frames show, without loading the film again', () => {
  const none = new Set(), a = timeline(), b = timeline([clip({ type: 'cube' })]), c = timeline([{ ...clip({ type: 'cube' }), at: 1 }]);
  assert.notEqual(filmSees(a, none), filmSees(b, none));
  assert.notEqual(filmSees(b, none), filmSees(c, none));
  assert.equal(filmSees(a, none, { overrides: false }), filmSees(b, none, { overrides: false }));
  assert.equal(filmSees(b, none, { overrides: false }), filmSees(c, none, { overrides: false }));
});
test('a picture clip still loads the film again', () => {
  const none = new Set(), pic = { id: 'c2', media: 'p', at: 0, in: 0, out: 1 }, media = { p: { kind: 'image', src: 'x.png', w: 10, h: 10 } };
  const a = timeline([], media, [{ id: 'v1', kind: 'visual', clips: [] }]), b = timeline([], media, [{ id: 'v1', kind: 'visual', clips: [pic] }]);
  assert.notEqual(filmSees(a, none, { overrides: false }), filmSees(b, none, { overrides: false }));
});
test('a film\'s pages are told of its changes and its added things, its pictures not', () => {
  const doc = { overrides: [{ id: 'o1' }], tracks: [{ id: 'things', kind: 'visual', things: true, clips: [clip({ type: 'cube' })] }, { id: 'v1', kind: 'visual', clips: [{ id: 'c2', media: 'p' }] }] };
  assert.deepEqual(liveEdits(doc).map((x) => x.id ?? x.thing.id), ['o1', 'c1']);
});
test('a copy of an added thing has what was changed on the thing, on itself', () => {
  const doc = { overrides: [{ id: 'o1', on: { at: 'clip:c1', nth: 0 }, props: { x: 5 } }, { id: 'o2', on: { at: 'clip:c9', nth: 0 }, props: { x: 6 } }] };
  const copies = thingChanges(doc, 'c1', 'c2');
  assert.deepEqual(copies.map((o) => [o.on.at, o.props.x]), [['clip:c2', 5]]);
  assert.notEqual(copies[0].id, 'o1');
});

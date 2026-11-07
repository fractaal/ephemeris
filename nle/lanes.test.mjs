// Where a change from the viewer (the gizmo, Lock to view) goes: into the lane selected, at the playhead, and the film's
// camera is then where it was put. node --test nle/lanes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the editor's modules reach the engine at the path the studio serves it from)
registerHooks({ resolve: (s, c, next) => next(s.startsWith('/files/') ? new URL(`../${s.slice(7)}`, import.meta.url).href : s, c) });
const { createLanes } = await import('./lanes.js');
const { rig, cam } = await import('../engine/camera.js');
const { setOverrides } = await import('../engine/motion.js');

const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.01, `${what}: ${got}, wanted ${want}`);
const CH = ['x', 'y', 'z', 'zoom', 'yaw', 'pitch', 'roll'];

// a film whose camera eases to x 300, y 100 from 1 to 2 s, then to x 600 from 3 to 4 s; and the studio's lanes of it,
// as the editor has them (a changed timeline taken in at once)
async function studio(more = (r) => r) {
  const r = more(rig(0, cam({ x: 0, y: 0, z: 0, zoom: 1 })).to(1, 1, { x: 300, y: 100 }).to(3, 1, { x: 600 }));
  const desc = r.stack.describe(), pose = r.at(0);
  const answer = { kind: 'camera', label: 'Camera', stacks: { [desc.id]: desc }, props: CH.map((k) => ({ k, runs: [{ t0: 0, t1: null, id: desc.id, ch: k, after: false, v: pose[k] }], varies: true })) };
  const S = { t: 0, name: 'f', timeline: 'main', doc: { overrides: [], cues: [], tracks: [], media: {} }, film: { duration: 6, fps: 24, cuts: [], gen: 1 }, end: () => 6, view: { pps: 100 } };
  const lanes = createLanes({
    S, toast() {}, relayout() {}, panels() {}, selection: () => null, names: () => false, onOf: () => ({}),
    post: async () => ({ json: async () => [answer, { kind: 'scene', label: 'Scene', stacks: {}, props: [] }] }),
    edit: (desc, fn) => { fn(S.doc); lanes.sync(); },
  });
  await lanes.refresh();
  // the camera as the film renders it at t, with the timeline's changes
  const camera = (t) => { setOverrides(S.doc.overrides); return r.at(t); };
  // the viewer putting the camera at `vals` at t, with the lane holding the first of them's point at `at` selected
  const put = (t, vals, at) => {
    if (at != null) { S.t = at; lanes.selectPoint(lanes.points('camera').find((p) => Math.abs(p.t - at) < 1e-6 && p.at.k === Object.keys(vals)[0])); }
    S.t = t;
    const e = lanes.valueEdits('camera', vals, { into: true });
    if (e?.fn) { e.fn(S.doc); lanes.sync(); }
    return e;
  };
  return { S, lanes, camera, put };
}

test('moved where a move of the code lands, the camera lands there, and its next move still lands where it did', async () => {
  const { camera, put } = await studio();
  put(2, { x: 400, y: 150 }, 2);
  near(camera(2).x, 400, 'x where the move lands'); near(camera(2).y, 150, 'y there');
  near(camera(4).x, 600, 'x where the next move lands'); near(camera(4).y, 150, 'y then');
  near(camera(0.5).x, 0, 'x before the move');
});

test('moved where a move that names only x lands, the camera is there in y too, getting there over that move’s time', async () => {
  const { camera, put } = await studio();
  put(4, { x: 650, y: 0 }, 4);
  near(camera(4).x, 650, 'x where the move lands'); near(camera(4).y, 0, 'y there');
  near(camera(3).y, 100, 'y as the move starts'); near(camera(2).y, 100, 'y before it');
  near(camera(2).x, 300, 'x where the move before lands');
});

test('moved between two landings, the camera passes where it was put, and still lands where the next move does', async () => {
  const { camera, put } = await studio();
  put(2.5, { x: 450 }, 2);
  near(camera(2.5).x, 450, 'x where it was put');
  near(camera(4).x, 600, 'x where the next move lands');
  near(camera(2).x, 300, 'x where the move before lands');
  near(camera(0.5).x, 0, 'x before either');
});

test('moved between two of a lane’s keys, the camera is there, and its keys before and after keep their values', async () => {
  const { camera, put } = await studio((r) => r.stack.keys({ z: [[1, 0], [5, 200]] }, { mode: 'add' }) && r);
  put(3, { z: 40 }, 1);
  near(camera(3).z, 40, 'z where it was put');
  near(camera(1).z, 0, 'z at the key before'); near(camera(5).z, 200, 'z at the key after');
});

test('with a lane that has no point to put it at selected, it says why and the camera stays as it was', async () => {
  const { camera, put, lanes, S } = await studio((r) => r.stack.rate({ x: 10 }) && r);
  S.t = 1;
  // (its X's Rate lane clicked, as the timeline shows it: the camera, its Position and its X opened)
  const th = lanes.M.things.find((x) => x.id === 'camera');
  th.open = true; lanes.rows(); for (const V of Object.values(th.vecs ?? {})) V.open = true;
  th.props.find((P) => P.k === 'x').open = true;
  const row = lanes.rows().find((r) => r.kind === 'mlane' && r.P.k === 'x' && r.lane.kind === 'rate');
  lanes.selectAt(row, row.lane.cells[0]);
  const e = put(1, { x: 999 });
  assert.match(e.error, /Rate/);
  near(camera(1).x, 10, 'x at 1 s');
});

test('↑ ↓ step through the lane selected: where its moves land', async () => {
  const { lanes, S } = await studio();
  S.t = 2; lanes.selectPoint(lanes.points('camera').find((p) => p.t === 2 && p.at.k === 'x'));
  assert.deepEqual(lanes.points('camera').filter((p) => p.sel).map((p) => p.t), [2, 4]);
});

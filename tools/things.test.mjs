// What the director adds lands where they can see it and grab it, whatever the camera and however the view crops the frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the editor's modules reach the engine at the path the studio serves it from)
registerHooks({ resolve: (s, c, next) => next(s.startsWith('/files/') ? new URL(`../${s.slice(7)}`, import.meta.url).href : s, c) });
const { newThing } = await import('../nle/things.js');
const { basis, project } = await import('../engine/lens.js');

const CAMERAS = {
  'level': { x: 0, y: 0, z: 0, zoom: 1 },
  'looking down': { x: 200, y: -100, z: 300, zoom: 1, pitch: -35, yaw: 40 },
  'looking straight down': { x: 0, y: 0, z: 0, zoom: 1, pitch: -89 },
  'looking up': { x: 0, y: -200, z: 0, zoom: 1, pitch: 30 },
  'close': { x: 0, y: 0, z: 0, zoom: 4 },
  'far': { x: 0, y: 0, z: 0, zoom: 0.25 },
  'a wide lens': { x: 0, y: 0, z: 0, zoom: 1, focal: 500 },
  'a very wide lens, close': { x: 0, y: 0, z: 0, zoom: 2, focal: 300 },
  'a long lens': { x: 0, y: 0, z: 0, zoom: 1, focal: 8000 },
  'a free camera': { kind: 'free', x: 100, y: -50, z: 2200, zoom: 1, yaw: 20 },
  'a target camera': { kind: 'target', x: 400, y: -300, z: 1800, tx: 0, ty: 0, tz: 0, zoom: 1 },
};
// (what shows of a 1920 x 1080 frame: Preview shows it whole; the Director view crops it to fill its panel)
const VIEWS = { 'the whole frame': { w: 1920, h: 1080 }, 'a wide short panel': { w: 1920, h: 500 }, 'a tall narrow panel': { w: 600, h: 1080 } };

for (const type of ['point', 'spot', 'sun']) {
  test(`a new ${type} light shows inside the view, whatever the camera and the crop`, () => {
    for (const [cameraName, cam] of Object.entries(CAMERAS)) {
      for (const [viewName, seen] of Object.entries(VIEWS)) {
        const th = newThing(type, cam, 1080, seen), at = project([th.x, th.y, th.z], basis(cam)), where = `${cameraName}, ${viewName}: at ${at.x.toFixed(0)}, ${at.y.toFixed(0)}, depth ${at.depth.toFixed(0)}`;
        assert.ok(at.depth > 0, `behind the lens (${where})`);
        assert.ok(Math.abs(at.x - 960) < seen.w / 2, `off the side (${where})`);
        assert.ok(Math.abs(at.y - 540) < seen.h / 2, `off the top or bottom (${where})`);
      }
    }
  });
}

test('a spot light still points at what the camera looks at', () => {
  // (level camera: the frame's centre is the world's origin; a light's way, by its turn, as engine/things.js aims it)
  const { x, y, z, rx, rz } = newThing('spot', CAMERAS.level, 1080, VIEWS['a wide short panel']), r = (d) => (d * Math.PI) / 180;
  const way = [-Math.sin(r(rz)) * Math.cos(r(rx)), Math.cos(r(rz)) * Math.cos(r(rx)), Math.sin(r(rx))], l = Math.hypot(x, y, z);
  way.forEach((v, k) => assert.ok(Math.abs(v - [-x, -y, -z][k] / l) < 0.01, `way ${way} from ${[x, y, z]}`));
});

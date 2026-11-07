// Tests for what the timeline's changes to motions land on (motion.js, camera.js): `node engine/motion.test.mjs`.
// Several cameras or motions made by one line (a loop's) are told apart, so a change to one changes that one only —
// those made as the film sets up, and those made each time a scene is evaluated; a named one keeps its changes by its
// name; and the editor's copy of a motion (describe → Stack.from) moves as the motion does, whatever its eases.
// A motion adds up (integral) to the area under it, following the timeline's changes to it.
globalThis.location = { href: import.meta.url };   // (where the film's code is: what a motion is named by)
const { motion, setOverrides, atMoment, Stack } = await import('./motion.js');
const { rig, cam } = await import('./camera.js');

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`  FAIL ${what}`); } return ok; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

{
  // a camera for each of three shots, from one line
  const cams = [0, 1, 2].map((i) => rig(i, cam({ x: i * 5000, yaw: i * 5 })));
  setOverrides([{ stack: cams[1].stack.describe().id, base: { yaw: 40 } }]);
  check(near(cams[1].at(1.5).yaw, 40), 'a change to one of the cameras a loop makes changes that camera');
  check(near(cams[0].at(0.5).yaw, 0) && near(cams[2].at(2.5).yaw, 10), 'a change to one of the cameras a loop makes leaves the others as the code has them');
  setOverrides([]);
}
{
  // a scene that makes two motions each time it is evaluated, from one line
  const scene = (t) => [1, 2].map((v) => motion(v));
  const second = atMoment(0, () => scene(0))[1].describe().id;
  setOverrides([{ stack: second, base: { value: 7 } }]);
  const at = (t) => atMoment(t, () => scene(t).map((m) => m.at(t)));
  check([0, 1, 2].every((t) => near(at(t)[1], 7)), 'a change to a motion a scene makes applies at every moment the scene is evaluated');
  check([0, 1, 2].every((t) => near(at(t)[0], 1)), 'a change to one of the motions a scene makes leaves the others as the code has them');
  setOverrides([]);
}
{
  const a = rig(0, cam({ x: 0 }), { name: 'photo 3' }), b = rig(0, cam({ x: 100 }), { name: 'photo 4' });
  setOverrides([{ stack: 'photo 3', base: { x: 25 } }]);
  check(near(a.at(1).x, 25) && near(b.at(1).x, 100), 'a named camera takes the changes made to it by its name, and only it');
  setOverrides([]);
}
{
  // the film's own ease on a move, a named one, and a camera's swish out of its shot
  const m = motion(0).by(0, 1, 10, (p) => p ** 5).to(1.2, 0.6, 3);
  const r = rig(0, cam({ x: 0, zoom: 1.2 }), { drift: { yaw: 3 } }).by(0.5, 0.8, { x: 400 }, (p) => Math.sin((p * Math.PI) / 2));
  r.swishOut(2, { px: [-2400, 0], dur: 0.4 });
  const mc = Stack.from(m.describe()), rc = Stack.from(r.stack.describe());
  let worst = 0;
  for (let i = 0; i <= 500; i++) {
    const t = (i / 500) * 2.5;
    worst = Math.max(worst, Math.abs(mc.value('value', t) - m.value('value', t)) / 10);
    for (const ch of ['x', 'y', 'zoom', 'yaw']) worst = Math.max(worst, Math.abs(rc.value(ch, t) - r.stack.value(ch, t)) / (ch === 'x' || ch === 'y' ? 2400 : 1));
  }
  check(worst < 1e-5, `the editor's copy of a motion moves as the motion does, whatever eases it has (off by ${worst.toExponential(1)} of its moves)`);
}

{
  // a pulse on each hit (a part's notes: score.js hits), as the film moves with them, and changed in the timeline
  const { hits } = await import('./score.js');
  const TL = { media: { drums: { notes: [{ t: 0, dur: 0.1, note: 36, vel: 1 }, { t: 0.5, dur: 0.1, note: 36, vel: 1 }, { t: 0.75, dur: 0.1, note: 38, vel: 1 }, { t: 1.5, dur: 0.1, note: 36, vel: 0.5 }] } },
    tracks: [{ id: 'a', clips: [{ id: 'c', media: 'drums', at: 10, in: 0.5, out: 2, speed: 2 }] }] };
  check(JSON.stringify(hits(TL, 'drums', { note: 36 }).map((h) => [h.t, h.vel])) === JSON.stringify([[10, 1], [10.5, 0.5]]), 'a part\'s hits are its notes where its clip plays them (its in, out and speed), of the notes asked for');
  const m = motion(1).hits([{ t: 1, vel: 1 }, { t: 2, vel: 0.5 }], { amount: 0.2, attack: 0.01, decay: 0.2 });
  check(near(m.at(0.5), 1) && near(m.at(1.01), 1.2) && near(m.at(1.21), 1 + 0.2 * Math.exp(-1)) && near(m.at(2.01), 1.1 + 0.2 * Math.exp(-5)) && near(m.at(9), 1, 1e-6),
    'a hit pulses: its amount times its velocity at its peak, an attack after it, falling away over its decay, gone long after');
  const d = m.describe();
  setOverrides([{ stack: d.id, ops: { [d.ops[0].id]: { amp: { value: 0.5 }, decay: 0.4 } } }]);
  check(near(m.at(1.01), 1.5) && near(m.at(1.41), 1 + 0.5 * Math.exp(-1)) && near(Stack.from(d).at(1.41), m.at(1.41)), 'a hit\'s amount and decay changed in the timeline: the film and the editor\'s copy move with them');
  setOverrides([]);
}

{
  // how far a speed has gone: what it adds up to from 0, asked at any moment in any order, following the timeline
  const speed = motion(0, { name: 'speed' }).keys([[0, 0], [2, 100, 'lin']]);   // (50 px/s more each second, then 100)
  check(near(speed.integral(5), 400, 1e-6) && near(speed.integral(1), 25, 1e-6) && near(speed.integral(2), 100, 1e-6), 'a motion adds up to the area under it, asked later or earlier');
  check(near(motion(200).integral(3), 600, 1e-6), 'a steady motion adds up to its value times the time');
  setOverrides([{ stack: 'speed', ops: { [speed.describe().ops[0].id]: { keys: { value: [[0, 0], [2, 200, 'lin']] } } } }]);
  check(near(speed.integral(5), 800, 1e-6), 'a motion changed in the timeline adds up to its changed values');
  setOverrides([]);
  check(near(speed.integral(5), 400, 1e-6), 'and to the code\'s again once the change is gone');
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

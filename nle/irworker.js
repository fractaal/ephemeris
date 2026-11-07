// The live engine's reverbs' impulse responses (live.js irsFrom), made here, off the audio thread: each reverb asks on
// the engine's port for the one it needs now, and of each reverb's asks the newest is made (a knob still turning asks
// again before the last is made), one at a time, and sent back with its buffers moved, not copied.
import { reverbReady } from '../engine/sound/fx.js';

let port = null, sr = 48000, busy = false;
const wants = new Map();   // a reverb's id → what it asks for now (the oldest asker first)

function next() {
  busy = false;
  const first = wants.entries().next().value;
  if (!first) return;
  const [id, w] = first;
  wants.delete(id); busy = true;
  try {
    const ir = reverbReady(w.spec, sr, w.ch ? { [w.spec.ir]: { channels: w.ch } } : {}), moved = new Set();
    for (const a of [...ir.head, ...ir.levels.flatMap(Object.values)]) if (ArrayBuffer.isView(a)) moved.add(a.buffer);   // (a mono one's spectra are the same arrays on both sides: moved once)
    port.postMessage({ id, key: w.key, ir }, [...moved]);
  } catch (e) { console.warn(`reverb ${w.key}: ${e.message}`); }
  setTimeout(next);   // (the asks that came while it was made first)
}

onmessage = ({ data }) => {
  ({ sr } = data);
  port = data.port;
  port.onmessage = ({ data: { want } }) => { wants.delete(want.id); wants.set(want.id, want); if (!busy) next(); };
};

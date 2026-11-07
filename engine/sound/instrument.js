// Live instruments: a sampler instrument as something the live engine (nle/live.js) plays as the sound streams — notes
// started and stopped at exact samples inside a block — in the editor's voice workers while it plays, and in a render
// from the start. (Synth sounds are Vial's, a plugin: tools/plugins.mjs.)
//
//   const inst = createInstrument(spec, { sr });
//     spec: { sampler: <instrument data> (sampler.js), samples: { [region.sample]: sound } }
//   inst.noteOn(note, vel, offset)   // MIDI note, velocity 0–1, at sample `offset` into the next process() block
//   inst.noteOff(note, offset)       // its release begins there
//   inst.process(L, R, n)            // adds the next n samples into L and R (Float32Arrays)
//   inst.set(spec)                   // a changed instrument: sounding voices carry on, new ones use it
//   inst.cc(number, value, offset)   // a controller change at that sample (samplers; others may ignore it)
//   inst.control({ <param>: value }) // its params moved (automation: nle/automation.js), each by its path in the
//                                    // sampler's data ('gain', 'env.a'), in its units: from the next block, over the spec
//                                    // set() gave
//   inst.reset(atSample = 0)         // silence, all voices gone (a seek); the stream's clock restarts at that sample
//   inst.tail                        // seconds a released note may still sound
//
// Rules: what it outputs does not depend on how the stream is cut into blocks; deterministic (seeded randomness, chosen
// from the notes alone, as the offline instruments are); no allocation in process() once its voices exist; cheap
// enough for many voices in real time. The offline sampler (sampler(…).render(notes)) is this, run over the whole of its
// notes: one implementation.

import { SR } from './core.js';

// ---------- a param's path in an instrument's data ('env.a')
const tokens = (path) => path.match(/[^.[\]]+/g).map((t) => (/^\d+$/.test(t) ? +t : t));
/** The value at path in o. */
export const getPath = (o, path) => tokens(path).reduce((x, k) => (x == null ? undefined : x[k]), o);
/** o with the value at path set (a copy of what lies on the path; the rest shared). */
export const setPath = (o, path, v) => setTokens(o, tokens(path), v);
function setTokens(o, [k, ...rest], v) {
  const c = Array.isArray(o) ? [...o] : { ...(o ?? {}) };
  c[k] = rest.length ? setTokens(o?.[k] ?? (typeof rest[0] === 'number' ? [] : {}), rest, v) : v;
  return c;
}
import { createSampler } from './sampler.js';

/** A live instrument for a spec, or null for one it does not know. */
export function createInstrument(spec, { sr = SR } = {}) {
  if (spec?.sampler) {
    const live = createSampler(spec.sampler, spec.samples, { sr }), change = live.set;   // (its own set, kept: ours takes the spec's form)
    return Object.assign(live, { set(next) { change(next.sampler, next.samples); } });
  }
  return null;
}

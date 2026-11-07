// The director's cues, as the film reads them. A film holds onto a cue by its name — "this moment happens wherever
// that cue is" — so moving the cue in the NLE moves the moment. The cues a film reads are reported to the tools: the
// NLE marks them ("the film uses this") and asks before one is deleted, and `check` warns when the film asks for a cue
// the timeline does not have (the film then uses its fallback, silently).
//
//   const C = cues(F, TL);
//   const T = { drop: C.at('drop', 20.69), glide: [C.at('glide', 26.5), C.end('glide', 28.6)] };
export function cues(F, TL) {
  const byId = new Map(TL.cues.map((c) => [c.id, c]));
  // (whole: it read more of the cue than its time and length, so a change to its note or label changes the film too)
  const read = (id, whole = false) => { F.cueRefs?.set(id, { found: byId.has(id), whole: whole || !!F.cueRefs.get(id)?.whole }); return byId.get(id); };
  return {
    /** The cue's time, or the fallback if the timeline has no such cue. */
    at: (id, fallback) => read(id)?.t ?? fallback,
    /** A range cue's end (its time + length), or the fallback if it is missing or a point. */
    end: (id, fallback) => { const c = read(id); return c?.dur ? c.t + c.dur : fallback; },
    /** The cue itself (or undefined), for its label, note or length. */
    get: (id) => read(id, true),
  };
}

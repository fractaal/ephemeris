// Format 2: a track's instrument plays its notes clips (track.instrument, as Bitwig's hybrid tracks); before, each notes
// medium had its own (media[id].instrument), so a clip took its instrument with it to another track, and one track could
// play several. Each track takes the instrument its notes clips' media had. A track whose clips' media had several is
// split: the instrument of its first notes clip stays on it, and each other one is a track of its own right under it,
// named for its instrument, with its clips, the same mix (fader, pan, mute, solo, sends, effects) and the automation of
// its media. Its automation of each medium (track.automation[medium]) is its instrument's (track.automation.instrument);
// two of its media automating the same parameter keep the first's. Media lose their instrument; one no track played
// keeps its notes (a track it is placed on plays them).
export const version = 2;
export const what = 'instruments on tracks';

const isNotes = (m) => Array.isArray(m?.notes);
const keyOf = (spec) => JSON.stringify(spec ?? null);
const base = (p) => String(p ?? '').split('/').pop().replace(/\.(vital|json|sfz|vstpreset|state)$/i, '');
// an instrument in a word or two, for a split track's name: a plugin's preset (808-slide), else the plugin; a sampler's file
const nameOf = (spec) => (spec?.plugin ? (spec.state ? base(spec.state) : spec.plugin) : base(spec?.sampler ?? spec?.sfz ?? spec?.named) || 'instrument');

export function migrate(doc) {
  const d = structuredClone(doc), media = d.media ?? {}, said = [], tracks = [];
  const ids = new Set((d.tracks ?? []).flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]));
  const fresh = (from) => { let n = 2, id; do { id = `${from}-${n++}`; } while (ids.has(id)); ids.add(id); return id; };
  for (const t of d.tracks ?? []) {
    tracks.push(t);
    for (const c of t.clips) if ('trackId' in c) { delete c.trackId; said.push(`a clip on "${t.name}" no longer names a track of its own (a paste left it)`); }
    if (t.kind === 'visual') continue;
    // its notes media by instrument, in the order their first clips play
    const groups = new Map();
    for (const c of [...t.clips].sort((a, b) => a.at - b.at)) {
      const m = media[c.media];
      if (!isNotes(m)) continue;
      const k = keyOf(m.instrument);
      if (!groups.has(k)) groups.set(k, { spec: m.instrument ?? null, ids: new Set() });
      groups.get(k).ids.add(c.media);
    }
    const old = t.automation ?? {}, automationOf = (mediaIds, on) => {
      const a = {};
      for (const id of mediaIds) for (const [k, p] of Object.entries(old[id] ?? {})) {
        if (a[k]) { said.push(`"${on}": the automation of ${k} by "${id}" left out (another of its patterns automated it first)`); continue; }
        a[k] = p;
      }
      return Object.keys(a).length ? a : null;
    };
    const [first, ...others] = groups.values(), placed = new Set([...groups.values()].flatMap((g) => [...g.ids]));
    for (const id of Object.keys(old)) if (!placed.has(id)) said.push(`"${t.name}": the automation of "${id}", which it does not play, left out`);
    delete t.automation;
    if (!first) continue;
    if (first.spec) t.instrument = first.spec;
    const a = automationOf(first.ids, t.name);
    if (a) t.automation = { instrument: a };
    // (each other instrument: a track of its own, right under it, with its clips and the same mix)
    for (const g of others) {
      const { id: _id, name: _name, clips, automation: _a, instrument: _i, ...mix } = t, name = `${t.name} · ${nameOf(g.spec)}`;
      const nt = { id: fresh(t.id), name, ...structuredClone(mix), ...(g.spec && { instrument: g.spec }), clips: clips.filter((c) => g.ids.has(c.media)) };
      const na = automationOf(g.ids, name);
      if (na) nt.automation = { instrument: na };
      t.clips = t.clips.filter((c) => !g.ids.has(c.media));
      tracks.push(nt);
      said.push(`"${t.name}" played ${groups.size} instruments: ${[...g.ids].map((x) => `"${x}"`).join(', ')} (${nameOf(g.spec)}) moved to a track of its own, "${name}", with the same mix`);
    }
  }
  d.tracks = tracks;
  for (const [id, m] of Object.entries(media)) {
    if (!isNotes(m) || !('instrument' in m)) continue;
    if (!tracks.some((t) => t.clips.some((c) => c.media === id))) said.push(`"${id}", on no track, no longer has an instrument of its own (${nameOf(m.instrument)}): a track it is placed on plays it`);
    delete m.instrument;
  }
  return { doc: d, said };
}

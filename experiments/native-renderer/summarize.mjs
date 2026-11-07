// Summarize only completed run directories; raw measurements remain in each results.json.
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Use summarize.mjs <measurement directory>');
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], mean: s.reduce((a, b) => a + b, 0) / s.length, min: s[0], max: s.at(-1), p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] };
};
const runs = [];
for (const name of await fs.readdir(root)) {
  try { runs.push({ name, ...JSON.parse(await fs.readFile(path.join(root, name, 'results.json'), 'utf8')) }); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
}
const groups = new Map();
for (const run of runs) for (const row of run.rows) {
  const key = `${run.film} scale=${run.settings.scale} samples=${run.settings.sub} t=${row.t}`;
  if (!groups.has(key)) groups.set(key, { key, film: run.film, scale: run.settings.scale, samples: run.settings.sub, t: row.t, compare: [], baseline: [], hybrid: [] });
  groups.get(key)[run.mode].push({ run, row });
}
const summary = [];
for (const g of groups.values()) {
  const result = { key: g.key };
  if (g.compare.length) {
    const s = g.compare.flatMap(({ row }) => row.samples);
    result.renderer = { runs: g.compare.map(({ run }) => run.name), browserMs: stats(s.map((x) => x.browserMs)), nativeMs: stats(s.map((x) => x.nativeMs)),
      browserPssMiB: g.compare.map(({ row }) => row.resources.afterBrowser.pssKB / 1024),
      nativePssMiB: g.compare.map(({ row }) => row.resources.afterNative.pssKB / 1024),
      pixelComparisons: g.compare.map(({ run, row }) => ({ run: run.name, ...row.quality })) };
  }
  for (const mode of ['baseline', 'hybrid']) if (g[mode].length) {
    const s = g[mode].flatMap(({ row }) => row.samples), elapsed = g[mode].reduce((n, { row }) => n + row.elapsedMs, 0);
    result[mode] = { runs: g[mode].map(({ run }) => run.name), wallMs: stats(s.map((x) => x.wallMs)), fps: s.length * 1000 / elapsed,
      runFps: g[mode].map(({ row }) => row.fps), pssMiB: g[mode].map(({ row }) => row.after.pssKB / 1024),
      cpuMsPerFrame: g[mode].map(({ run, row }) => (row.after.ticks - row.before.ticks) * 1000 / (run.clockTicks ?? 100) / row.samples.length),
      schedule: g[mode].map(({ row }) => [...new Set(row.after.processes.map((p) => `${p.policy}:${p.nice}`))]),
      renderMs: stats(s.map((x) => x.renderMs)), subs: [...new Set(s.map((x) => x.subs))],
      ...(mode === 'hybrid' && { prepareMs: stats(s.map((x) => x.prepareMs)), layerReadbackMs: stats(s.map((x) => x.layerReadbackMs)),
        serializeMs: stats(s.map((x) => x.serializeMs)), browserWallMs: stats(s.map((x) => x.browserWallMs)), nativeMs: stats(s.map((x) => x.nativeMs)),
        captures: [...new Set(s.map((x) => x.captures))], imageBytes: [...new Set(s.map((x) => x.imageBytes))], packetBytes: stats(s.map((x) => x.bytes)) }),
    };
  }
  // Compare one independently-rendered baseline sequence with each native-hybrid sequence.
  if (g.baseline.length && g.hybrid.length) {
    const baseline = g.baseline.find(({ row }) => row.samples.every((x) => x.hash)) ?? g.baseline[0];
    const source = new Map(baseline.row.samples.map((x) => [x.time, x]));
    result.endToEndQuality = [];
    for (const { run, row } of g.hybrid) {
      let equalHashes = 0, unequalHashes = 0, missingHashes = 0, sampleCountMismatch = 0;
      for (const x of row.samples) {
        const b = source.get(x.time);
        if (!b?.hash || !x.hash) missingHashes++;
        else if (b.hash === x.hash) equalHashes++; else unequalHashes++;
        if (b?.subs !== undefined && b.subs !== x.subs) sampleCountMismatch++;
      }
      const b = await fs.readFile(path.join(root, baseline.run.name, `baseline-${row.t}.rgba`));
      const n = await fs.readFile(path.join(root, run.name, `hybrid-${row.t}.rgba`));
      if (b.length !== n.length) throw new Error(`Image size mismatch: ${g.key}`);
      let max = 0, abs = 0, changed = 0;
      for (let i = 0; i < b.length; i++) { const d = Math.abs(b[i] - n[i]); max = Math.max(max, d); abs += d; changed += d > 0; }
      result.endToEndQuality.push({ baseline: baseline.run.name, hybrid: run.name, equalHashes, unequalHashes, missingHashes, sampleCountMismatch,
        firstFrame: { max, maeRGBA: abs / b.length, changedBytes: changed } });
    }
  }
  summary.push(result);
}
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
for (const x of summary) {
  console.log(x.key);
  if (x.renderer) console.log(`  renderer median ms: Chrome ${x.renderer.browserMs.median.toFixed(2)} → native ${x.renderer.nativeMs.median.toFixed(2)} (n=${x.renderer.browserMs.n})`);
  if (x.baseline && x.hybrid) console.log(`  end-to-end fps: Chrome ${x.baseline.fps.toFixed(2)} → hybrid ${x.hybrid.fps.toFixed(2)}; PSS MiB ${x.baseline.pssMiB.map(Math.round)} → ${x.hybrid.pssMiB.map(Math.round)}`);
  for (const q of x.endToEndQuality ?? []) console.log(`  ${q.hybrid}: equal frame hashes ${q.equalHashes}, unequal ${q.unequalHashes}, unrecorded ${q.missingHashes}; first frame max difference ${q.firstFrame.max}; sample-count mismatches ${q.sampleCountMismatch}`);
}

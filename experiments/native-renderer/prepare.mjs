// Freeze the two real films and engine inputs without touching the director's workspace.
// --record-existing records the already-frozen inputs (and verifies their engine against --ref).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) => x.startsWith('--') ? [...a, [x.slice(2), xs[i + 1] ?? true]] : a, []));
if (!args.workspace || !args.out || !args.ref) throw new Error('Use --workspace <films workspace> --out <frozen directory> --ref <engine commit> [--record-existing yes]');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.resolve(args.out);
const films = ['motion-design-test-claude-2', 'doctor-who-intro-max'];
const ref = execFileSync('git', ['rev-parse', args.ref], { cwd: repo, encoding: 'utf8' }).trim();
const excluded = new Set(['.git', 'history', 'renders']);
const compatibility = { file: 'projects/motion-design-test-claude-2/look.js', changes: [
  'Remove local PI=3.14159265 and TAU=6.2831853 declarations; current renderer supplies the identical constants.',
  'Rename three cam.k.x reads to cam.focal. Old compositor Cam.k.x is explicitly documented as focal (0afb067^:engine/compositor.js).',
] };
if (!args['record-existing']) {
  await fs.mkdir(out); // Refuse to overwrite any existing experiment.
  const archive = execFileSync('git', ['archive', ref, 'engine', 'elements', 'assets'], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', out], { input: archive });
  await fs.mkdir(path.join(out, 'projects'));
  for (const film of films) await fs.cp(path.join(args.workspace, 'projects', film), path.join(out, 'projects', film), {
    recursive: true, filter: (source) => !excluded.has(path.basename(source)),
  });
  const p = path.join(out, compatibility.file); let source = await fs.readFile(p, 'utf8');
  const constants = 'const PI = 3.14159265;\nconst TAU = 6.2831853;\n';
  if (source.split(constants).length !== 2 || source.split('cam.k.x').length !== 4) throw new Error('The DOM film changed; review its compatibility adaptation before continuing');
  source = source.replace(constants, '').replaceAll('cam.k.x', 'cam.focal');
  await fs.writeFile(p, source);
  await fs.writeFile(path.join(out, 'package.json'), '{"type":"module"}\n');
  await fs.symlink(path.join(repo, 'node_modules'), path.join(out, 'node_modules'));
}
// Verify the frozen engine is the stated Git version, not a moving link to the checkout.
const tree = execFileSync('git', ['ls-tree', '-r', '-z', ref, '--', 'engine', 'elements', 'assets'], { cwd: repo, encoding: 'utf8' });
for (const entry of tree.split('\0').filter(Boolean)) {
  const [head, name] = entry.split('\t'), [mode, , expected] = head.split(' '), file = path.join(out, name);
  const data = mode === '120000' ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
  const actual = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (actual !== expected) throw new Error(`Frozen engine differs from ${ref}: ${name}`);
}
const hashes = {};
async function walk(dir) {
  for (const entry of await fs.readdir(path.join(out, dir), { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isSymbolicLink()) hashes[file] = { link: await fs.readlink(path.join(out, file)) };
    else hashes[file] = createHash('sha256').update(await fs.readFile(path.join(out, file))).digest('hex');
  }
}
for (const dir of ['engine', 'elements', 'assets', ...films.map((f) => `projects/${f}`)]) await walk(dir);
const manifest = { recordedAt: new Date().toISOString(), engine: ref, films, compatibility, files: hashes };
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Frozen ${films.join(', ')} and engine ${ref}; ${Object.keys(hashes).length} hashed inputs in ${out}/manifest.json`);

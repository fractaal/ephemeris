// A film's versions (tools/history.mjs): node tools/history.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record, versions, version, textAt, changes, diff, restore, unkept, tags, tag, untag, resolve } from './history.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : null);

try {
  put('film.js', 'const a = 1;\nconst b = 2;\n');
  put('timelines/main.json', '{"cues":[]}\n');
  put('media/song.wav', 'RIFF\0\0\0\0WAVE');
  put('assets/model.json', '{"big":true}\n');
  put('vendor/product/.git/HEAD', 'ref: refs/heads/main\n');
  put('vendor/product/app.js', 'export {};\n');
  put('sprite.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  put('notes.txt', 'x'.repeat((1 << 20) + 1));
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'library'), process.platform === 'win32' ? 'junction' : 'dir');

  // a version holds the film's timelines and code, and not what is brought in, made, another's, binary or too big
  const v1 = record(dir, 'first');
  assert.deepEqual(Object.keys(v1.files).sort(), ['film.js', 'timelines/main.json']);
  assert.equal(textAt(dir, v1, 'film.js'), 'const a = 1;\nconst b = 2;\n');

  // nothing changed: no new version
  assert.equal(record(dir, 'again'), null);
  assert.equal(versions(dir).length, 1);

  // a change to the code and the timeline together is one version, which says what changed
  put('film.js', 'const a = 1;\nconst b = 3;\n');
  put('timelines/main.json', '{"cues":[{"id":"q1"}]}\n');
  put('look.js', 'export const look = {};\n');
  const v2 = record(dir, 'brighter');
  assert.deepEqual(changes(v1, v2), { added: ['look.js'], changed: ['film.js', 'timelines/main.json'], removed: [] });
  assert.equal(diff(dir, v1, v2), [
    '--- a/film.js', '+++ b/film.js', '@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;',
    '--- /dev/null', '+++ b/look.js', '@@ -0,0 +1 @@', '+export const look = {};',
    '--- a/timelines/main.json', '+++ b/timelines/main.json', '@@ -1 +1 @@', '-{"cues":[]}', '+{"cues":[{"id":"q1"}]}', '',
  ].join('\n'));

  // restoring a version brings back its code and timelines together, removes what it did not hold, leaves media alone,
  // and keeps the restore as a version of its own
  put('film.js', 'const a = 9;\n');   // (not kept yet: kept before the restore)
  fs.rmSync(path.join(dir, 'media/song.wav'));
  const r = restore(dir, 1);
  assert.equal(read('film.js'), 'const a = 1;\nconst b = 2;\n');
  assert.equal(read('timelines/main.json'), '{"cues":[]}\n');
  assert.equal(read('look.js'), null);
  assert.equal(read('media/song.wav'), null);
  assert.equal(read('assets/model.json'), '{"big":true}\n');
  assert.equal(textAt(dir, version(dir, r.n - 1), 'film.js'), 'const a = 9;\n');
  assert.match(r.message, /^Restored version 1 \(first\)/);

  // restoring the version the project already is makes none
  assert.equal(restore(dir, r.n), null);

  // what is not as the last version holds it: a file changed, made or taken away, a folder's files with it; not a file a
  // tool wrote and took away again, nor what a version does not hold
  record(dir, 'now');
  assert.deepEqual(unkept(dir, ['film.js', 'timelines/main.json']), { added: [], changed: [], removed: [] });
  put('film.js', 'const a = 3;\n');
  put('parts/sky.js', 'export {};\n');
  put('parts/sea.js', 'export {};\n');
  fs.rmSync(path.join(dir, 'timelines/main.json'));
  put('media/song.wav', 'RIFF');
  assert.deepEqual(unkept(dir, ['film.js', 'parts', 'timelines/main.json', 'sed9EYdps', 'media/song.wav']),
    { added: ['parts/sea.js', 'parts/sky.js'], changed: ['film.js'], removed: ['timelines/main.json'] });
  record(dir, 'parts');
  fs.rmSync(path.join(dir, 'parts'), { recursive: true });
  assert.deepEqual(unkept(dir, ['parts']), { added: [], changed: [], removed: ['parts/sea.js', 'parts/sky.js'] });

  // a version cut short as it was written (a crash) is left out; the next one still follows the last whole one
  const whole = versions(dir).at(-1).n;
  fs.appendFileSync(path.join(dir, 'history', 'versions.jsonl'), '{"n":99,"at":"2026');
  put('film.js', 'const a = 2;\n');
  assert.equal(record(dir, 'after a crash').n, whole + 1);
  assert.equal(versions(dir).at(-1).message, 'after a crash');
  // tags name versions as git's do: a version found by its tag, a name kept to its version unless moved on purpose, a
  // restore leaving them where they are, and names a number or a ref could be mistaken for refused
  const last = versions(dir).at(-1).n;
  tag(dir, 'sent', 1);
  tag(dir, 'now');
  assert.deepEqual(tags(dir), { sent: 1, now: last });
  assert.equal(resolve(dir, 'sent'), 1);
  assert.equal(resolve(dir, String(last)), last);
  assert.equal(resolve(dir, 'gone'), null);
  assert.throws(() => tag(dir, 'sent', last), /version 1/);
  tag(dir, 'sent', last, true);
  assert.equal(resolve(dir, 'sent'), last);
  for (const bad of ['two words', '42', '-f', 'a:b', '']) assert.throws(() => tag(dir, bad));
  assert.throws(() => tag(dir, 'later', last + 1), /no version/);
  restore(dir, 1);
  assert.deepEqual(tags(dir), { sent: last, now: last });
  untag(dir, 'now');
  assert.deepEqual(tags(dir), { sent: last });
  assert.throws(() => untag(dir, 'now'));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

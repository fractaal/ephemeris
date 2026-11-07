// Conversation behavior at the harness boundary; no paid model calls or access to the person's conversations.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agents-'));
process.env.HOME = process.env.USERPROFILE = home;
const { createAgents } = await import('./agent.mjs');
const { configure } = await import('./workspace.mjs');
const { imageFile } = await import('./agents/images.mjs');
const { encode } = await import('./frames.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

function fixture(t) {
  configure({ agentHarness: 'claude', agentPermissions: 'auto', agentModel: 'first', agentEffort: null });
  const transcripts = new Map(), events = [], sent = [], looked = {};
  const make = (id) => ({ emit, ask, permissions, settings, setSettings, project }) => ({
    id, label: id, model: () => settings().agentModel, effort: () => settings().agentEffort,
    permissionModes: () => id === 'pi' ? ['auto', 'ask', 'bypass'] : ['auto', 'ask'],
    efforts: () => ['low', 'high'], home: () => 'test', models: async () => [],
    setModel: async (model) => setSettings({ agentModel: model }),
    setEffort: async (effort) => setSettings({ agentEffort: effort }),
    conversations: async () => [...transcripts.values()],
    transcript: async (id) => transcripts.get(id)?.events ?? [{ type: 'text', text: transcripts.get(id)?.title }],
    rename: async (id, title) => { transcripts.get(id).title = title; },
    remove: async (id) => transcripts.delete(id),
    start({ resume }) {
      const abort = new AbortController();
      let finish;
      const s = { id: resume || randomUUID(), busy: false, over: new Promise((r) => { finish = r; }),
        send({ text }, when) {
          sent.push({ id: s.id, text, when });
          if (looked.frame && text.includes('look at the frame')) { emit({ type: 'tool', id: 't1', name: 'mcp__ephemeris__frames', input: {} }); emit({ type: 'result', id: 't1', ok: true, text: '1.00 s · frame 24', images: [looked.frame] }); }
          transcripts.set(s.id, { id: s.id, title: text, project: project(), at: Date.now() });
          emit({ type: 'session', id: s.id, model: settings().agentModel });
          const choices = text.includes('choose a direction') ? [{ id: 'blue', name: 'Blue' }, { id: 'red', name: 'Red' }] : null;
          ask(choices ? 'question' : 'Bash', choices ? { question: text } : { command: text }, { signal: abort.signal, ...(choices && { options: choices }) }).then((answer) => {
            s.busy = false;
            emit({ type: 'text', text: `${project()}: ${answer.reconsider ? `reconsidered in ${permissions()}` : answer.allow ? 'allowed' : 'denied'}` });
            emit({ type: 'done', ok: answer.allow });
          });
        },
        stop: async () => abort.abort(), setPermissions: async () => {},
        end: async () => { abort.abort(); finish(); },
      };
      return s;
    },
  });
  const registry = createAgents({ root: home, studio: 'http://studio', factories: { claude: make('claude'), pi: make('pi') },
    open: async (name, tid) => ({ name, tid, url: `http://film/${name}/${tid}` }),
    emit: (project, type, data) => events.push({ project, type, data }),
  });
  t.after(() => registry.closeAll());
  return { registry, events, sent, transcripts, looked };
}
const tick = () => new Promise((r) => setImmediate(r));
const question = (a) => a.state().events.findLast((e) => e.type === 'ask').id;

test('agents in the same and different projects work independently, including approvals and stop', async (t) => {
  const { registry, events } = fixture(t);
  const a = registry.add('alpha', 'main'), b = registry.add('alpha', 'main'), c = registry.add('beta', 'main');
  await Promise.all([a.send({ text: 'music', frame: false }), b.send({ text: 'visuals', frame: false }), c.send({ text: 'titles', frame: false })]);
  assert.equal(registry.list('alpha').length, 2);
  assert.equal(registry.list('beta').length, 1);
  assert.ok(registry.list().every((a) => a.busy && a.waiting));
  a.answer({ id: question(a), allow: true });
  await tick();
  assert.equal(a.state().busy, false);
  assert.equal(b.state().waiting, true);
  assert.equal(c.state().waiting, true);
  assert.ok(a.state().events.some((e) => e.text === 'alpha: allowed'));
  await b.stop(); await tick();
  assert.equal(b.state().busy, false);
  assert.equal(c.state().busy, true);
  assert.ok(events.filter((e) => e.type === 'agent' && e.data.agent === c.id).every((e) => e.project === 'beta'));
  assert.throws(() => registry.get('beta', a.id), /open in this project/);
});

test('model, effort and permissions change only the selected agent and defaults for new ones', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main'), b = registry.add('alpha', 'main');
  await a.setModel({ model: 'second', harness: 'pi' });
  await a.setEffort({ effort: 'high' });
  await a.setPermissions({ permissions: 'ask' });
  assert.deepEqual([a.state().harness, a.state().model, a.state().effort, a.state().permissions], ['pi', 'second', 'high', 'ask']);
  assert.deepEqual([b.state().harness, b.state().model, b.state().effort, b.state().permissions], ['claude', 'first', null, 'auto']);
  const c = registry.add('beta', 'main');
  assert.deepEqual([c.state().harness, c.state().model, c.state().effort, c.state().permissions], ['pi', 'second', 'high', 'ask']);
});

test('reopening a live conversation keeps its work and a closed conversation resumes in its own project', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main');
  await a.send({ text: 'continue me', frame: false });
  const id = a.state().session;
  const reopened = await registry.resume('alpha', 'other', { id, harness: 'claude' });
  assert.equal(reopened.id, a.id);
  assert.equal(reopened.state().waiting, true);
  await registry.rename('alpha', { id, harness: 'claude', title: 'Music direction' });
  assert.equal(registry.list('alpha')[0].title, 'Music direction');
  assert.deepEqual(reopened.target(), { name: 'alpha', tid: 'main' });
  await registry.close('alpha', a.id);
  assert.equal(registry.list('alpha').length, 0);
  const [resumed, again] = await Promise.all([registry.resume('alpha', 'main', { id, harness: 'claude' }), registry.resume('alpha', 'main', { id, harness: 'claude' })]);
  assert.equal(again.id, resumed.id);
  assert.equal(registry.list('alpha').length, 1);
  assert.equal(resumed.state().session, id);
  assert.ok(resumed.state().events.some((e) => e.type === 'resumed'));
  await assert.rejects(registry.resume('beta', 'main', { id, harness: 'claude' }), /not in this project/);
  assert.equal(registry.list('beta').length, 0);
});

test('message context and tool targets stay with the agent rather than another project’s view', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main');
  await a.send({ text: 'first task', frame: false });
  registry.add('beta', 'main');
  a.setTarget('alternate');
  await a.send({ text: 'look here', context: { timeline: 'main', t: 3 }, frame: false });
  assert.deepEqual(a.target(), { name: 'alpha', tid: 'alternate' });
  const prompt = a.state().events.findLast((e) => e.type === 'ask').input.command;
  assert.match(prompt, /Open: alpha\/main/);
  assert.match(prompt, /Playhead: 3.00 s/);
  assert.ok(a.state().events.every((e) => e.project === 'alpha'));
});

test('bypass is retained for Pi agents without becoming an unsupported mode in another harness', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main');
  await a.setModel({ model: 'pi-model', harness: 'pi' });
  await a.setPermissions({ permissions: 'bypass' });
  assert.equal(a.state().permissions, 'bypass');
  assert.equal(registry.add('beta', 'main').state().permissions, 'bypass');
  await a.setModel({ model: 'claude-model', harness: 'claude' });
  assert.equal(a.state().permissions, 'auto');
});

test('switching away from Ask first releases waiting tool approvals under the new mode', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main');
  await a.setModel({ model: 'pi-model', harness: 'pi' });
  for (const mode of ['auto', 'bypass']) {
    await a.setPermissions({ permissions: 'ask' });
    await a.send({ text: 'run a command', frame: false });
    assert.equal(a.state().waiting, true);
    await a.setPermissions({ permissions: mode });
    await tick();
    assert.equal(a.state().waiting, false);
    assert.ok(a.state().events.some((e) => e.text === `alpha: reconsidered in ${mode}`));
  }
});

test('changing permission mode does not answer a creative question on the director’s behalf', async (t) => {
  const { registry } = fixture(t);
  const a = registry.add('alpha', 'main');
  await a.setModel({ model: 'pi-model', harness: 'pi' });
  await a.send({ text: 'choose a direction', frame: false });
  await a.setPermissions({ permissions: 'bypass' });
  assert.equal(a.state().waiting, true);
  a.answer({ id: question(a), option: 'blue' });
  await tick();
  assert.equal(a.state().waiting, false);
  assert.ok(a.state().events.some((e) => e.text === 'alpha: allowed'));
});

test("the studio's note reaches its project's agents: one at work after its step, one idle with the director's next message", async (t) => {
  const { registry, sent } = fixture(t);
  const a = registry.add('alpha', 'main'), other = registry.add('beta', 'main');
  registry.note('alpha', 'Frames are slow to draw.');
  assert.ok(a.state().events.some((e) => e.type === 'studio' && e.text === 'Frames are slow to draw.'), 'shown in its panel');
  assert.ok(!other.state().events.some((e) => e.type === 'studio'), 'not in another project');
  assert.equal(sent.length, 0, 'an idle agent is not started for it');
  await a.send({ text: 'make it pinker' });
  await tick();
  assert.match(sent.at(-1).text, /<studio>[\s\S]*Frames are slow to draw\.[\s\S]*<\/studio>[\s\S]*make it pinker/, "read with the director's next message");
  // (at work now, waiting on its ask: the next note comes after its current step)
  registry.note('alpha', 'Slower still.');
  assert.deepEqual([sent.at(-1).when, /<studio>\nSlower still\.\n<\/studio>/.test(sent.at(-1).text)], ['next', true]);
  await a.send({ text: 'and bluer' });
  await tick();
  assert.doesNotMatch(sent.at(-1).text, /Slower still|Frames are slow/, 'a note is read once');
});

// a picture as an agent's tools return one: a PNG w x h, as a data URL
async function picture(w, h) {
  const rgba = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 251));
  return `data:image/png;base64,${(await encode(rgba, w, h)).toString('base64')}`;
}
// a JPEG's width, from its frame header
function jpegWidth(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return b.readUInt16BE(i + 7);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

test('a frame an agent looked at reaches its editors as a name the studio serves, not as the picture itself', async (t) => {
  const { registry, events, looked } = fixture(t);
  looked.frame = await picture(64, 36);
  const a = registry.add('alpha', 'main');
  await a.send({ text: 'look at the frame', frame: false });
  const result = events.find((e) => e.type === 'agent' && e.data.type === 'result').data;
  assert.ok(!JSON.stringify(result).includes('base64'), 'no picture in what the editors are sent');
  const kept = await imageFile(result.images[0].image);
  assert.equal(fs.readFileSync(kept.file).toString('base64'), looked.frame.split(',')[1]);
  assert.equal(kept.type, 'image/png');
});

test('a thumbnail of a kept picture is a JPEG as wide as asked', async (t) => {
  const { registry, events, looked } = fixture(t);
  looked.frame = await picture(640, 360);
  await registry.add('alpha', 'main').send({ text: 'look at the frame', frame: false });
  const { image } = events.find((e) => e.type === 'agent' && e.data.type === 'result').data.images[0];
  const small = fs.readFileSync((await imageFile(image, 240)).file);
  assert.deepEqual([small[0], small[1]], [0xff, 0xd8]);
  assert.equal(jpegWidth(small), 240);
  assert.equal(await imageFile('../../etc/passwd'), null);
});

test('continuing a long conversation sends its editors a few events, and the agent shows all of it', async (t) => {
  const { registry, events, transcripts } = fixture(t);
  const id = randomUUID();
  transcripts.set(id, { id, title: 'Long one', project: 'alpha', at: Date.now(), events: Array.from({ length: 300 }, (_, i) => ({ type: 'text', text: `step ${i}` })) });
  const a = await registry.resume('alpha', 'main', { id, harness: 'claude' });
  assert.ok(events.filter((e) => e.type === 'agent' && e.data.agent === a.id).length < 10);
  const said = a.state().events.filter((e) => e.type === 'text').map((e) => e.text);
  assert.equal(said.length, 300);
  assert.equal(said[0], 'step 0');
  assert.equal(said.at(-1), 'step 299');
});

// Real Pi SDK and Bash execution, with a loopback model API instead of paid calls or the person's credentials.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pi-permissions-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, '.pi', 'agent');
process.env.PI_OFFLINE = '1';
const { piHarness } = await import('./pi.mjs');
let verdict = 'DENY';
const server = http.createServer(async (req, res) => {
  let data = '';
  for await (const chunk of req) data += chunk;
  const body = JSON.parse(data), toolResult = body.messages.findLast((m) => m.role === 'tool');
  const main = body.tools?.length;
  const delta = !main ? { content: verdict } : toolResult ? { content: `Tool result: ${toolResult.content}` }
    : { tool_calls: [{ index: 0, id: 'command', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf executed > permission-result.txt' }) } }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: main && !toolResult ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { local: {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'test-only', models: [{ id: 'permissions' }],
} } }));
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); });

function fixture(t, mode, decide) {
  const root = fs.mkdtempSync(path.join(home, 'workspace-')), events = [];
  let finish;
  const done = new Promise((r) => { finish = r; });
  // The SDK owns a real, empty MCP transport. Keep its test process identifiable for cleanup.
  const pidFile = path.join(root, 'mcp.pid');
  const mcpCode = `import fs from 'node:fs'; import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))}; import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new McpServer({ name: 'test', version: '1' }).connect(new StdioServerTransport());`;
  const harness = piHarness({
    root, permissions: () => mode, prompt: () => 'Run the requested command, then report its tool result.', project: () => 'test',
    settings: () => ({ piModel: 'local/permissions', piEffort: 'off' }), setSettings: () => {},
    mcp: { command: process.execPath, args: ['--input-type=module', '-e', mcpCode] },
    ask: decide ?? (async () => { throw new Error('Auto and bypass must not ask for human approval.'); }),
    emit: (e) => { events.push(e); if (e.type === 'done' || e.type === 'error') finish(); },
  });
  const session = harness.start({});
  t.after(async () => {
    await session.end();
    if (fs.existsSync(pidFile)) try { process.kill(+fs.readFileSync(pidFile, 'utf8')); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  session.send({ text: 'Run the command to write permission-result.txt.', frame: null, images: [] });
  return { done, events, file: path.join(root, 'permission-result.txt') };
}

test('Pi Auto runs an approved command without a human permission prompt', { timeout: 30000 }, async (t) => {
  verdict = 'ALLOW';
  const f = fixture(t, 'auto');
  await f.done;
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'executed');
  assert.ok(f.events.some((e) => e.type === 'done' && e.ok));
});

test('Pi Auto returns a security denial to the operating model instead of asking the director', { timeout: 30000 }, async (t) => {
  verdict = 'DENY';
  const f = fixture(t, 'auto');
  await f.done;
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(f.events.some((e) => e.type === 'text' && e.text.includes('The security system denied this tool call.')));
});

test('Pi bypass runs the command even when the permission judge would deny it', { timeout: 30000 }, async (t) => {
  verdict = 'DENY';
  const f = fixture(t, 'bypass');
  await f.done;
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'executed');
});

test('Pi Ask first waits for approval before executing the command', { timeout: 30000 }, async (t) => {
  let approve, asked;
  const waiting = new Promise((r) => { asked = r; });
  const f = fixture(t, 'ask', () => { asked(); return new Promise((r) => { approve = r; }); });
  await Promise.race([waiting, f.done]);
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(approve, 'the command must request approval');
  approve({ allow: true });
  await f.done;
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'executed');
});

test('Pi returns an exhausted judge failure to the operating model as retriable, not as a denial', { timeout: 60000 }, async (t) => {
  verdict = 'not a verdict';
  const f = fixture(t, 'auto');
  await f.done;
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(f.events.some((e) => e.type === 'text' && e.text.includes('The security system failed to evaluate this tool call. This is not indicative of a block. You may retry shortly.')));
});

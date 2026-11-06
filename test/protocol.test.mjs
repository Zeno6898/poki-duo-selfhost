import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import { hidPoint } from '../src/device.mjs';
import { fixture, value } from './fixture.mjs';

test('fill asks for a daemon restart after native or JavaScript updates and recovers after restart', async t => {
  for (const updated of ['native', 'JavaScript']) await t.test(updated, async t => {
    let currentInteraction;
    const f = await fixture(t, { beforeStart: async dir => {
      const file = join(dir, 'src/interaction.mjs');
      currentInteraction = await readFile(file, 'utf8');
      const legacy = currentInteraction.replace('target: { object_id, role: here.role ?? here.type, label, placeholder, value }', 'x: 30, y: 50');
      assert.notEqual(legacy, currentInteraction, 'The fixture must reproduce the old fill request.');
      await writeFile(file, legacy);
    } });
    await f.set({ phone: { keyboard: true, rows: [{ id: 'name-field', placeholder: 'Name', value: '', editing: true, up: 40, down: 40 }] } });
    const before = await f.call('fill', { field: 'Name', text: 'before update' });
    assert.ok(!before.isError, JSON.stringify(before));
    if (updated === 'native') {
      const file = join(f.dir, 'build/poki-native');
      const program = await readFile(file, 'utf8');
      await writeFile(file, program.replace("if(state.block===req.op)", "if(req.op==='type_text'&&'x' in req){console.error('unknown field `x`, expected one of `text`, `clear`, `submit`, `target`');process.exit(1);}\n if(state.block===req.op)"));
    } else await writeFile(join(f.dir, 'src/interaction.mjs'), currentInteraction);

    const result = await f.call('fill', { field: 'Name', text: 'after update' });
    const reply = result.content.find(c => c.type === 'text').text;
    t.diagnostic(`${updated} update: ${reply}`);
    assert.equal(result.isError, true);
    assert.match(reply, /service is running old code.*restart.*npm start/i);
    assert.doesNotMatch(reply, /unknown field|missing field/);
    assert.ok(!reply.includes(f.dir), 'The restart instruction must not expose a local path.');

    await f.daemon.stop();
    await writeFile(join(f.dir, 'src/interaction.mjs'), currentInteraction);
    await f.startDaemon();
    const recovered = await f.call('fill', { field: 'Name', text: 'after restart' });
    assert.ok(!recovered.isError, JSON.stringify(recovered));
    assert.equal(value(recovered).text_verified, true);
    const screen = value(await f.call('list_elements'));
    assert.equal(screen.elements.find(e => e.type === 'TextField').value, 'after restart');
    t.diagnostic(`${updated} update after restart: field value="after restart"`);
  });
});

test('stdio reaches the authenticated local MCP service and rejects an absent device', { timeout: 20000 }, async t => {
    const f = await fixture(t, { staleNative: true }), client = f.a;
    assert.equal(f.stderr.trim().split('\n').length, 1);
    assert.match(f.stderr, /older than its source/);
    const endpoint = JSON.parse(await readFile(join(f.dir, 'state/mcp.json'), 'utf8'));
    assert.equal((await stat(join(f.dir, 'state/mcp.json'))).mode & 0o777, 0o600);
    assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal(client.getServerVersion().name, 'poki-mcp');
    assert.equal(client.getServerVersion().version, '0.1.0');
    assert.match(client.getInstructions(), /batch_commands/);
    const httpClient = new Client({ name: 'discovery-contract', version: '1' });
    try {
      await httpClient.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}`, 'x-poki-mcp-session': 'discovery-contract' } } }));
      for (const transportClient of [client, httpClient]) {
        const { tools } = await transportClient.listTools();
        t.diagnostic(`default tools/list: ${tools.length} tools, ${JSON.stringify({ tools }).length} characters`);
        assert.deepEqual(tools.map(tool => tool.name).sort(), [
          'poki_mcp_status', 'list_devices', 'select_device', 'list_elements', 'take_screenshot',
          'get_foreground_app', 'launch_app', 'open_url', 'tap', 'tap_text', 'fill', 'type_text',
          'scroll', 'swipe', 'press_key', 'go_back', 'wait_for', 'handle_alert', 'batch_commands',
          'long_press', 'double_tap', 'drag', 'hide_keyboard', 'press_button',
          'scroll_to', 'terminate_app', 'pinch', 'list_apps', 'get_clipboard',
        ].sort());
        const status = await transportClient.callTool({ name: 'poki_mcp_status', arguments: {} });
        assert.ok(!status.isError);
        const statusValue = JSON.parse(status.content[0].text);
        assert.equal(typeof statusValue.devices, 'number');
        assert.equal(statusValue.total_tools, 56);
        assert.equal(statusValue.implementation, 'Poki MCP 0.1.0');
        assert.equal(statusValue.commit, 'unknown', 'A packaged copy outside Git must report unknown');
        assert.equal(statusValue.native_build, (await stat(join(f.dir, 'build/poki-native'))).mtime.toISOString());
        assert.equal(value(await transportClient.callTool({ name: 'wait', arguments: { seconds: 0 } })).waited, 0);
      }
    } finally { await httpClient.close(); }
    const fullClient = await f.connect('all');
    const full = await fullClient.listTools();
    assert.equal(full.tools.length, 56);
    for (const tool of (await client.listTools()).tools) {
      assert.deepEqual(tool, full.tools.find(candidate => candidate.name === tool.name));
    }
    t.diagnostic(`all tools/list: ${full.tools.length} tools, ${JSON.stringify(full).length} characters`);
    assert.ok(!(await client.callTool({ name: 'select_device', arguments: { device: 'fixture-phone' } })).isError);
    const screen = value(await client.callTool({ name: 'list_elements', arguments: {} }));
    assert.equal(screen.elements[0].label, 'First');
    assert.ok(!(await client.callTool({ name: 'tap', arguments: { ref: screen.elements[0].ref } })).isError);
    assert.equal(value(await client.callTool({ name: 'list_elements', arguments: {} })).elements[0].label, 'First');
    const invalid = await client.callTool({ name: 'select_device', arguments: { device: 'contract-test-absent-device' } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /not connected/);
    const unicode = await client.callTool({ name: 'type_text', arguments: { text: '中文', device: 'contract-test-absent-device' } });
    assert.equal(unicode.isError, true);
    assert.match(unicode.content[0].text, /not connected/);
    const batch = await client.callTool({ name: 'batch_commands', arguments: { commands: Array.from({ length: 30 }, () => ({ tool: 'wait', arguments: { seconds: 0 } })) } });
    assert.ok(!batch.isError);
    assert.equal(batch.content.filter(c => c.type === 'text' && c.text.includes('"waited"')).length, 30);
    const batchSteps = result => result.content.flatMap(block => {
      if (block.type !== 'text') return [];
      try { const value = JSON.parse(block.text); return typeof value.step === 'number' ? [value] : []; }
      catch { return []; }
    });
    const steps = batchSteps(batch);
    assert.equal(steps.length, 30);
    assert.ok(steps.every(step => Number.isFinite(step.elapsed_ms) && step.elapsed_ms >= 0));
    const stopped = await client.callTool({ name: 'batch_commands', arguments: { commands: [{ tool: 'missing_tool' }, { tool: 'wait', arguments: { seconds: 0 } }] } });
    assert.equal(stopped.isError, true);
    assert.equal(stopped.content.filter(c => c.type === 'text' && c.text.includes('"waited"')).length, 0);
    const stoppedSteps = batchSteps(stopped);
    assert.equal(stoppedSteps.length, 1);
    assert.equal(stoppedSteps[0].isError, true);
    assert.ok(Number.isFinite(stoppedSteps[0].elapsed_ms) && stoppedSteps[0].elapsed_ms >= 0);
    const emptySubmit = await client.callTool({ name: 'type_text', arguments: { text: '', submit: true } });
    assert.equal(emptySubmit.isError, true);
    assert.match(emptySubmit.content[0].text, /press_key/);
    const continued = await client.callTool({ name: 'batch_commands', arguments: { stop_on_error: false, commands: [{ tool: 'wait', arguments: { seconds: 0 } }, { tool: 'missing_tool' }, { tool: 'batch_commands', arguments: { commands: [] } }, { tool: 'wait', arguments: { seconds: 0 } }] } });
    assert.equal(continued.isError, true);
    assert.equal(continued.content.filter(c => c.type === 'text' && c.text.includes('"waited"')).length, 2);
    const continuedSteps = batchSteps(continued);
    assert.deepEqual(continuedSteps.map(step => step.isError), [false, true, true, false]);
    assert.ok(continuedSteps.every(step => Number.isFinite(step.elapsed_ms) && step.elapsed_ms >= 0));
    assert.ok(continued.content.some(c => c.type === 'text' && c.text.includes('Nested batches are not supported')));

});

test('an all-profile HTTP service still lets each stdio client choose its own list', { timeout: 20000 }, async t => {
  const f = await fixture(t, { toolsProfile: 'all' });
  const endpoint = JSON.parse(await readFile(join(f.dir, 'state/mcp.json'), 'utf8'));
  const httpClient = new Client({ name: 'all-profile-contract', version: '1' });
  t.after(() => httpClient.close());
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}`, 'x-poki-mcp-session': 'all-profile-contract' } },
  }));
  const full = await httpClient.listTools();
  assert.equal(full.tools.length, 56);
  assert.deepEqual(await f.a.listTools(), full);
  const defaultClient = await f.connect('');
  assert.equal((await defaultClient.listTools()).tools.length, 29);
  assert.deepEqual(await httpClient.listTools(), full);
  assert.equal(value(await defaultClient.callTool({ name: 'wait', arguments: { seconds: 0 } })).waited, 0);
});

test('Poki Agent opens its own MCP with the complete catalog even when the parent uses the default profile', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const entry = new URL('../agent/poki-client.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { PokiClient } from ${JSON.stringify(entry)};
    const client = new PokiClient();
    try {
      const tools = await client.open('agent-profile-contract');
      const result = await client.call('wait', { seconds: 0 });
      console.log(JSON.stringify({ tools, result }));
    } finally { await client.close(); }
  `], { env: f.env });
  const { tools, result } = JSON.parse(stdout);
  assert.equal(tools.length, 56);
  for (const name of ['list_apps', 'observe_device', 'hide_keyboard', 'acquire_device']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  assert.equal(value(result).waited, 0);
  t.diagnostic(`PokiClient.open -> src/stdio.mjs -> local HTTP daemon: ${tools.length} tools; hidden wait executed`);
});

test('screenshot coordinates preserve HID corners and reject out-of-frame input', () => {
  assert.deepEqual(hidPoint(0, 0, 101, 201), [0, 0]);
  assert.deepEqual(hidPoint(100, 200, 101, 201), [65535, 65535]);
  assert.deepEqual(hidPoint(50, 100, 101, 201), [32768, 32768]);
  for (const [x, y] of [[-1, 0], [101, 0], [0, 201], [NaN, 0]]) {
    assert.throws(() => hidPoint(x, y, 101, 201), /Coordinates/);
  }
});

const endpointFile = f => join(f.dir, 'state/mcp.json');
const endpointOf = async f => JSON.parse(await readFile(endpointFile(f), 'utf8'));
const probe = f => f.call('wait', { seconds: 0 });

for (const samePort of [true, false]) {
  test(`a connected client keeps working when the service restarts on ${samePort ? 'the same port' : 'another port'} with a new token`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    assert.ok(!(await probe(f)).isError);
    const before = await endpointOf(f);
    await f.daemon.stop();
    await f.startDaemon(samePort ? before.port : 0);
    const after = await endpointOf(f);
    assert.notEqual(after.token, before.token);
    assert.equal(after.port === before.port, samePort);
    const result = await probe(f);
    assert.ok(!result.isError, result.content[0].text);
  });
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`a connected client says to run npm start while the service is down after ${signal}, and works again once it is back`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const { token } = await endpointOf(f);
    await f.daemon.stop(signal);
    const down = await probe(f);
    assert.equal(down.isError, true);
    assert.match(down.content[0].text, /npm start/);
    assert.ok(!down.content[0].text.includes(token));
    await f.startDaemon();
    const back = await probe(f);
    assert.ok(!back.isError, back.content[0].text);
  });
}

test('a client started with no service says to run npm start, with the endpoint file left behind or gone', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const { token } = await endpointOf(f);
  await f.daemon.stop('SIGKILL');
  const start = () => promisify(execFile)(process.execPath, [join(f.dir, 'src/stdio.mjs')], { env: f.env, timeout: 10000 }).then(() => assert.fail('stdio kept running'), error => error.stderr);
  for (const stderr of [await start(), await rm(endpointFile(f)).then(start)]) {
    assert.match(stderr, /npm start/);
    assert.ok(!stderr.includes(token));
  }
});

test('a token the service still rejects after the re-read is reported without printing any token', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(f.dir, 'src/stdio.mjs')], env: f.env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'rejected-token', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const before = await endpointOf(f), wrong = 'f'.repeat(64);
  await f.daemon.stop();
  await f.startDaemon(before.port);
  const endpoint = await endpointOf(f);
  await writeFile(endpointFile(f), JSON.stringify({ ...endpoint, token: wrong }));
  const result = await client.callTool({ name: 'wait', arguments: { seconds: 0 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rejected/);
  for (const text of [result.content[0].text, stderr]) for (const token of [before.token, endpoint.token, wrong]) assert.ok(!text.includes(token));
});

test('a call cut off by a restart is not sent again, because the phone may already have acted', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.set({ block: 'key' });
  const pending = f.call('press_key', { key: 'return' });
  await f.until(log => log.includes('"op":"key"'));
  await f.startDaemon();
  await f.set({});
  await f.daemon.stop();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /may already/);
  assert.ok(!(await probe(f)).isError);
  assert.equal((await f.events()).filter(e => e.op === 'key').length, 1);
});

test('bin/call.mjs says a select_device choice lasts for that run only', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.set({ simulatorOnly: true, simulatorBooted: true });
  const call = (...args) => spawnSync(process.execPath, [join(root, 'bin/call.mjs'), ...args], { env: f.env, encoding: 'utf8' });
  const chosen = call('select_device', '{"device":"fixture-sim"}');
  assert.equal(chosen.status, 0);
  assert.deepEqual(JSON.parse(chosen.stdout), { selected: 'fixture-sim', name: 'Fixture Simulator' });
  assert.match(chosen.stderr, /only for this run/);
  assert.equal(JSON.parse(call('poki_mcp_status').stdout).selected, null);
  const absent = call('select_device', '{"device":"absent-device"}');
  assert.equal(absent.status, 1);
  assert.doesNotMatch(absent.stderr, /only for this run/);
});

test('bin/setup says what to install for a missing prerequisite', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const present = ['git', 'node', 'npm', 'cargo', 'rustc', 'python3', 'xcrun', 'xcodebuild', 'ffmpeg', 'ffprobe'];
  for (const [missing, install] of [['xcodebuild', /full Xcode/], ['node', /Node\.js 24/], ['cargo', /rustup\.rs/], ['ffmpeg', /brew install ffmpeg/]]) {
    const bin = join(dir, missing);
    await mkdir(bin);
    // The prerequisite checks are the macOS path, so uname reports Darwin on any test host.
    await symlink('/usr/bin/dirname', join(bin, 'dirname'));
    await writeFile(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    for (const tool of present.filter(tool => tool !== missing)) await writeFile(join(bin, tool), '', { mode: 0o755 });
    const setup = spawnSync(join(root, 'bin/setup'), { env: { PATH: bin }, encoding: 'utf8' });
    assert.equal(setup.status, 1, missing);
    assert.match(setup.stderr, new RegExp(`Missing prerequisite: ${missing}\\.`));
    assert.match(setup.stderr, install);
  }
});

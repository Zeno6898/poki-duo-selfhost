// Fork-only (poki-remote): the POKI_BRIDGE_DAEMON client in src/bridge-daemon.mjs, against a fake
// poki-bridged that speaks the socket protocol without a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import { BridgeDaemon, routes, repeatable, socketPath } from '../src/bridge-daemon.mjs';
import { Devices } from '../src/device.mjs';

const native = join(root, 'build/poki-native');
const fake = join(root, 'test/fixtures/fake-bridged.mjs');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pbd-'));
  const program = join(dir, 'fake-bridged.mjs');
  copyFileSync(fake, program);
  const record = join(dir, 'record.ndjson');
  const env = { ...process.env, POKI_BRIDGED: program, POKI_BRIDGED_SOCKET_DIR: dir, FAKE_BRIDGED_RECORD: record };
  const requests = () => { try { return readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { dir, program, env, requests };
}

async function stop(daemon) {
  try { await (await import('node:net')).createConnection(daemon.path).end('{"op":"shutdown"}\n'); } catch {}
}

test('the daemon path is off unless POKI_BRIDGE_DAEMON=1, and covers only poki-native ops it runs', () => {
  const input = JSON.stringify({ op: 'tap', x: 1, y: 2 });
  assert.equal(routes(native, input, {}), false);
  assert.equal(routes(native, input, { POKI_BRIDGE_DAEMON: '0' }), false);
  const on = { POKI_BRIDGE_DAEMON: '1', POKI_BRIDGED: fake };
  assert.equal(routes(native, input, { ...on, POKI_BRIDGED: '/nonexistent/poki-bridged' }), false, 'no daemon binary, no daemon path');
  assert.equal(routes(native, input, on), true);
  assert.equal(routes(native, JSON.stringify({ op: 'ax_tree' }), on), true);
  assert.equal(routes('/usr/bin/python3', input, on), false);
  assert.equal(routes(native, undefined, on), false);
  assert.equal(routes(native, 'not json', on), false);
  for (const op of ['install_app', 'uninstall_app', 'location']) assert.equal(routes(native, JSON.stringify({ op }), on), false, op);
});

test('only reads are sent twice', () => {
  for (const request of [{ op: 'ax_tree' }, { op: 'screenshot', path: '/tmp/x.png' }, { op: 'pasteboard', action: 'get' }, { op: 'configuration', method: 'get_appearance' }]) assert.equal(repeatable(request), true, JSON.stringify(request));
  for (const request of [{ op: 'tap' }, { op: 'type_text' }, { op: 'pasteboard', action: 'set' }, { op: 'configuration', method: 'set_appearance' }, { op: 'launch_app' }, { op: 'rotate' }]) assert.equal(repeatable(request), false, JSON.stringify(request));
});

test('socket names hide the target arguments and stay short', () => {
  const args = ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist'];
  const path = socketPath(args, { POKI_BRIDGED_SOCKET_DIR: '/run/poki' });
  assert.match(path, /^\/run\/poki\/[0-9a-f]{16}\.sock$/);
  assert.equal(path, socketPath([...args], { POKI_BRIDGED_SOCKET_DIR: '/run/poki' }));
  assert.notEqual(path, socketPath(['--udid', 'X'], { POKI_BRIDGED_SOCKET_DIR: '/run/poki' }));
  assert.ok(!path.includes('rp.plist'));
  assert.ok(Buffer.byteLength(socketPath(args, { POKI_BRIDGED_SOCKET_DIR: `/${'d'.repeat(120)}` })) <= 104);
});

test('one daemon is started and reused, and its answers read like poki-native output', async () => {
  const { dir, env, requests } = setup();
  const daemon = new BridgeDaemon(['--udid', 'A'], env);
  try {
    const first = await daemon.run({ op: 'tap', x: 1, y: 2 });
    assert.deepEqual(first, { stdout: '{"sent":true,"screen_change_verified":false}', stderr: '' });
    const times = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const { stdout } = await daemon.run({ op: 'ax_tree', include_offscreen: false });
      times.push(performance.now() - started);
      assert.equal(JSON.parse(stdout).elements[0].x, 1.5);
    }
    times.sort((a, b) => a - b);
    console.log(`client round trip through a warm (fake) daemon: median ${times[10].toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
    assert.equal(daemon.started, 1);
    assert.equal(new Set(requests().map(r => r.pid)).size, 1);
    assert.deepEqual(requests()[0].request, { op: 'tap', x: 1, y: 2 });
    assert.deepEqual(daemon.last, { total_ms: 1, reused_tunnel: true });
    // A second client (another MCP process) finds the same daemon instead of starting one.
    const other = new BridgeDaemon(['--udid', 'A'], env);
    await other.run({ op: 'lockdown_get', key: 'DeviceName' });
    assert.equal(other.started, 0);
    await assert.rejects(daemon.run({ op: 'rotate' }), error => {
      assert.equal(error.message, 'Command did not complete: {"error":"unknown op rotate","screen_change_verified":false}. An input may already have been delivered; inspect before retrying.');
      assert.equal(error.stderr, '{"error":"unknown op rotate","screen_change_verified":false}');
      return true;
    });
  } finally { await stop(daemon); rmSync(dir, { recursive: true, force: true }); }
});

test('a daemon that dies is restarted; a read is sent again, an input is not', async () => {
  const { dir, env, requests } = setup();
  const marker = join(dir, 'crash');
  const daemon = new BridgeDaemon(['--udid', 'B'], { ...env, FAKE_BRIDGED_CRASH: marker, FAKE_BRIDGED_CRASH_OP: 'ax_tree' });
  try {
    await daemon.run({ op: 'tap', x: 1, y: 1 });
    writeFileSync(marker, '');
    const { stdout } = await daemon.run({ op: 'ax_tree' });
    assert.equal(JSON.parse(stdout).foreground_app, 'com.example');
    assert.equal(daemon.started, 2);
    assert.equal(requests().filter(r => r.request.op === 'ax_tree').length, 2);

    const tapping = new BridgeDaemon(['--udid', 'C'], { ...env, FAKE_BRIDGED_CRASH: marker, FAKE_BRIDGED_CRASH_OP: 'tap' });
    await tapping.run({ op: 'ax_tree' });
    writeFileSync(marker, '');
    await assert.rejects(tapping.run({ op: 'tap', x: 5, y: 5 }), /Command did not complete: poki-bridged closed the connection without answering\. An input may already have been delivered/);
    assert.equal(requests().filter(r => r.request.op === 'tap' && r.request.x === 5).length, 1, 'the tap was not repeated');
    // The next call starts a new daemon.
    await tapping.run({ op: 'tap', x: 6, y: 6 });
    assert.equal(tapping.started, 2);
    await stop(tapping);
  } finally { await stop(daemon); rmSync(dir, { recursive: true, force: true }); }
});

test('a daemon older than its executable is replaced', async () => {
  const { dir, program, env, requests } = setup();
  const daemon = new BridgeDaemon(['--udid', 'D'], env);
  try {
    await daemon.run({ op: 'tap', x: 1, y: 1 });
    const later = new Date(Date.now() + 5000);
    utimesSync(program, later, later);
    const fresh = new BridgeDaemon(['--udid', 'D'], env);
    await fresh.run({ op: 'tap', x: 2, y: 2 });
    assert.equal(fresh.started, 1);
    assert.equal(new Set(requests().map(r => r.pid)).size, 2);
    await stop(fresh);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Devices.run hands poki-native calls to the daemon only when enabled', async () => {
  const { dir, env } = setup();
  const saved = { ...process.env };
  Object.assign(process.env, { POKI_BRIDGED: env.POKI_BRIDGED, POKI_BRIDGED_SOCKET_DIR: dir, POKI_BRIDGE_DAEMON: '1' });
  try {
    const devices = new Devices();
    const result = await devices.run(native, ['--udid', 'E'], 95000, JSON.stringify({ op: 'tap', x: 3, y: 4 }));
    assert.deepEqual(result, { stdout: '{"sent":true,"screen_change_verified":false}', stderr: '' });
    // Another program still runs as a process.
    const echo = await devices.run(process.execPath, ['-e', 'process.stdout.write("hi\\n")'], 5000);
    assert.deepEqual(echo, { stdout: 'hi', stderr: '' });
    const daemon = new BridgeDaemon(['--udid', 'E'], env);
    await stop(daemon);
  } finally {
    for (const key of ['POKI_BRIDGED', 'POKI_BRIDGED_SOCKET_DIR', 'POKI_BRIDGE_DAEMON']) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real binaries, when they are built (cargo build in native/bridge): poki-bridged answers a request
// with the same text poki-native prints for it. The target cannot be reached, so no phone is needed.
const built = ['debug', 'release'].map(profile => [join(root, `build/native-target/${profile}/poki-native`), join(root, `build/native-target/${profile}/poki-bridged`)])
  .find(pair => pair.every(file => existsSync(file)));
test('poki-bridged and poki-native print the same failure for the same request', { skip: !built && 'native binaries are not built' }, async () => {
  const [nativeBinary, bridged] = built;
  const dir = mkdtempSync(join(tmpdir(), 'pbd-real-'));
  const args = ['--host', '127.0.0.1', '--rp-pairing-file', join(dir, 'missing.plist')];
  const daemon = new BridgeDaemon(args, { ...process.env, POKI_BRIDGED: bridged, POKI_BRIDGED_SOCKET_DIR: dir });
  const { execFileSync } = await import('node:child_process');
  try {
    for (const request of [{ op: 'ax_tree' }, { op: 'tap', x: 1, y: 2 }, { op: 'tap', x: 1 }]) {
      let spawned;
      try { execFileSync(nativeBinary, args, { input: JSON.stringify(request), stdio: 'pipe' }); } catch (error) { spawned = error.stderr.toString().trimEnd(); }
      await assert.rejects(daemon.run(request), error => {
        if (request.x === 1 && request.y === undefined) assert.match(error.stderr, /missing field `y`/);
        else assert.equal(error.stderr, spawned, JSON.stringify(request));
        return true;
      });
    }
    const { pong } = await daemon.ping();
    assert.equal(pong.tunnel, false);
  } finally { await stop(daemon); rmSync(dir, { recursive: true, force: true }); }
});

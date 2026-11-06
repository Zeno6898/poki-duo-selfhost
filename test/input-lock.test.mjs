import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Coordination } from '../src/coordination.mjs';
import { InputLock, inputLockFromEnv, deviceKey } from '../src/input-lock.mjs';

// A session stand-in: dispatch records when each tool starts and ends and takes `ms` to run.
function session(label, log, ms = 40) {
  return {
    label, selected: 'phone-a', backgroundDevices: new Map(),
    async dispatch(name, args) {
      log.push(`${label}:${name}:start`);
      await sleep(args?.ms ?? ms);
      log.push(`${label}:${name}:end`);
      return { content: [{ type: 'text', text: name }] };
    },
    async cleanup() { return {}; },
  };
}

test('input lock is off unless POKI_INPUT_LOCK=1, and reads its limits from the environment', () => {
  assert.equal(inputLockFromEnv({}), undefined);
  const lock = inputLockFromEnv({ POKI_INPUT_LOCK: '1', POKI_INPUT_LOCK_WAIT_MS: '250', POKI_MAX_CONCURRENT_READS: '2' });
  assert.equal(lock.waitMs, 250);
  assert.equal(lock.maxReads, 2);
  assert.equal(inputLockFromEnv({ POKI_INPUT_LOCK: '1' }).waitMs, 30000);
  assert.equal(inputLockFromEnv({ POKI_INPUT_LOCK: '1' }).maxReads, 4);
  assert.throws(() => inputLockFromEnv({ POKI_INPUT_LOCK: '1', POKI_INPUT_LOCK_WAIT_MS: 'soon' }), /POKI_INPUT_LOCK_WAIT_MS/);
});

test('device key prefers the explicit device, then a batch device, then the selected device', () => {
  assert.equal(deviceKey({ selected: 'b' }, { device: 'a' }), 'a');
  assert.equal(deviceKey({ selected: 'b' }, { commands: [{ tool: 'tap', arguments: { device: 'c' } }] }), 'c');
  assert.equal(deviceKey({ selected: 'b' }, { commands: [{ arguments: { device: 'c' } }, { arguments: { device: 'd' } }] }), '*');
  assert.equal(deviceKey({ selected: 'b' }, {}), 'b');
  assert.equal(deviceKey({}, {}), '*');
});

test('without the lock every session shares one queue, as before', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = undefined;
  const log = [], a = session('a', log), b = session('b', log);
  await Promise.all([coordinator.call(a, 'tap', {}), coordinator.call(b, 'take_screenshot', {})]);
  assert.deepEqual(log, ['a:tap:start', 'a:tap:end', 'b:take_screenshot:start', 'b:take_screenshot:end']);
});

test('with the lock, a read from another session runs while input holds the device', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 1000 });
  const log = [], a = session('a', log, 80), b = session('b', log, 10);
  await Promise.all([coordinator.call(a, 'tap', {}), sleep(5).then(() => coordinator.call(b, 'take_screenshot', {}))]);
  assert.deepEqual(log, ['a:tap:start', 'b:take_screenshot:start', 'b:take_screenshot:end', 'a:tap:end']);
});

test('with the lock, input from two sessions to one device runs one at a time', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 1000 });
  const log = [], a = session('a', log), b = session('b', log);
  await Promise.all([coordinator.call(a, 'tap', {}), coordinator.call(b, 'type_text', { text: 'x' })]);
  assert.deepEqual(log, ['a:tap:start', 'a:tap:end', 'b:type_text:start', 'b:type_text:end']);
});

test('with the lock, input to two different devices runs side by side', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 1000 });
  const log = [], a = session('a', log), b = session('b', log);
  b.selected = 'phone-b';
  await Promise.all([coordinator.call(a, 'tap', {}), coordinator.call(b, 'tap', {})]);
  assert.deepEqual(log.slice(0, 2), ['a:tap:start', 'b:tap:start']);
});

test('with the lock, one session keeps its own order even for reads', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 1000 });
  const log = [], a = session('a', log);
  await Promise.all([coordinator.call(a, 'tap', { ms: 40 }), coordinator.call(a, 'take_screenshot', { ms: 5 })]);
  assert.deepEqual(log, ['a:tap:start', 'a:tap:end', 'a:take_screenshot:start', 'a:take_screenshot:end']);
});

test('a session that waits too long gets an error naming the holder and its tool', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 50 });
  const log = [], a = session('agent-a', log, 300), b = session('agent-b', log);
  const first = coordinator.call(a, 'drag', {});
  await sleep(5);
  await assert.rejects(coordinator.call(b, 'tap', {}), error => {
    assert.equal(error.name, 'InputLockTimeout');
    assert.match(error.message, /Device phone-a is busy/);
    assert.match(error.message, /Session agent-a is running drag/);
    assert.match(error.message, /Waited 50 ms/);
    return true;
  });
  assert.ok(!log.includes('agent-b:tap:start'));
  await first;
  // The failed wait leaves the lock usable.
  await coordinator.call(b, 'tap', { ms: 1 });
  assert.ok(log.includes('agent-b:tap:end'));
});

test('an unknown device excludes input to every device', async () => {
  const lock = new InputLock({ waitMs: 1000 });
  const releaseAny = await lock.acquire('*', { session: 's', tool: 'launch_app' });
  let got = false;
  const pending = lock.acquire('phone-a', { session: 't', tool: 'tap' }).then(release => { got = true; return release; });
  await sleep(10);
  assert.equal(got, false);
  releaseAny();
  (await pending)();
  assert.equal(got, true);
  assert.equal(lock.holders.size, 0);
});

test('reads are capped at POKI_MAX_CONCURRENT_READS', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ maxReads: 2 });
  const log = [], sessions = ['a', 'b', 'c'].map(name => session(name, log, 30));
  let peak = 0, running = 0;
  for (const s of sessions) { const run = s.dispatch.bind(s); s.dispatch = async (...args) => { peak = Math.max(peak, ++running); try { return await run(...args); } finally { running--; } }; }
  await Promise.all(sessions.map(s => coordinator.call(s, 'take_screenshot', {})));
  assert.equal(peak, 2);
  assert.equal(log.filter(entry => entry.endsWith(':end')).length, 3);
});

test('an aborted wait leaves the queue and does not run', async () => {
  const coordinator = new Coordination(); coordinator.inputLock = new InputLock({ waitMs: 1000 });
  const log = [], a = session('a', log, 100), b = session('b', log);
  const first = coordinator.call(a, 'tap', {});
  const controller = new AbortController();
  const second = coordinator.call(b, 'tap', {}, controller.signal);
  await sleep(10);
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(second, /stop/);
  await first;
  assert.ok(!log.includes('b:tap:start'));
  assert.equal(coordinator.inputLock.waiters.size, 0);
});

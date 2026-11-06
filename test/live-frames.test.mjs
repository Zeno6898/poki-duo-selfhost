import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { LiveScreen, enabled } from '../src/live-frames.mjs';

// A poki-bridged stand-in: records requests and answers from a table, as BridgeDaemon.run does.
function fakeDaemon(answers) {
  const requests = [];
  return { requests, async run(request) { requests.push(request); return { stdout: JSON.stringify(answers[request.op](request)), stderr: '' }; } };
}
const jpeg = await sharp({ create: { width: 8, height: 16, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
const picture = extra => ({ captured_at: '2026-11-06T03:30:00.000Z', age_ms: 12, width: 8, height: 16, bytes: jpeg.length, settled: true, quiet_ms: 400,
  last_change: { changed: true, changed_fraction: 0.21, region: [0, 0.1, 1, 0.5], ms_ago: 400 }, last_input_ms_ago: 700, changed_since_input: true, picture_after_input: true,
  screen_change_verified: false, jpeg_base64: jpeg.toString('base64'), ...extra });

test('the live screen needs both the bridge daemon and live frames', () => {
  assert.equal(enabled({ POKI_LIVE_FRAMES: '1' }), false);
  assert.equal(enabled({ POKI_LIVE_FRAMES: '1', POKI_BRIDGE_DAEMON: '1' }), true);
  assert.equal(enabled({ POKI_BRIDGE_DAEMON: '1' }), false);
});

test('latestFrame returns the JPEG, its timing and the screen state, and RGB on request', async () => {
  const daemon = fakeDaemon({ latest_frame: () => picture() });
  const screen = new LiveScreen(['--udid', 'x'], { daemon });
  const frame = await screen.latestFrame({ maxWidth: 402, rgb: true });
  assert.deepEqual(daemon.requests[0], { op: 'latest_frame', max_width: 402, quality: 5, wait_ms: 3000 });
  assert.ok(frame.jpeg.equals(jpeg));
  assert.equal(frame.capturedAt, '2026-11-06T03:30:00.000Z');
  assert.equal(frame.ageMs, 12);
  assert.equal(frame.settled, true);
  assert.equal(frame.changedSinceInput, true);
  assert.equal(frame.rgb.length, 8 * 16 * 3);
});

test('waitSettled asks for the first settled picture from now and reports how long it waited', async () => {
  const daemon = fakeDaemon({ wait_settled: () => picture({ waited_ms: 180, settled: true }) });
  const frame = await new LiveScreen([], { daemon }).waitSettled({ timeoutMs: 2500, settleMs: 120, maxWidth: 64 });
  assert.deepEqual(daemon.requests[0], { op: 'wait_settled', timeout_ms: 2500, max_width: 64, settle_ms: 120 });
  assert.equal(frame.waitedMs, 180);
  assert.equal(frame.settled, true);
});

test('frameDiff takes moments or frames and returns a score and a box', async () => {
  const daemon = fakeDaemon({ frame_diff: () => ({ changed: true, changed_fraction: 0.05, region: [0.1, 0.2, 0.3, 0.1], a_at: 'a', b_at: 'b' }) });
  const screen = new LiveScreen([], { daemon });
  assert.deepEqual(await screen.frameDiff(800, 0), { changed: true, score: 0.05, bbox: [0.1, 0.2, 0.3, 0.1], aAt: 'a', bAt: 'b' });
  assert.deepEqual(daemon.requests[0], { op: 'frame_diff', a_ms_ago: 800, b_ms_ago: 0 });
  await screen.frameDiff({ capturedAt: new Date(Date.now() - 1500).toISOString() }, 0);
  assert.ok(Math.abs(daemon.requests[1].a_ms_ago - 1500) < 200);
});

test('health is ok only while pictures decode, and never throws', async () => {
  const report = { decoding: true, decoder_error: null, latest_age_ms: 40, decoded_per_s: 31.5 };
  const healthy = await new LiveScreen([], { daemon: fakeDaemon({ frames: () => report }) }).health({ seconds: 1 });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.fps, 31.5);
  const stalled = await new LiveScreen([], { daemon: fakeDaemon({ frames: () => ({ ...report, decoding: false }) }) }).health();
  assert.equal(stalled.ok, false);
  const broken = await new LiveScreen([], { daemon: { run: async () => { throw new Error('daemon gone'); } } }).health();
  assert.deepEqual([broken.ok, broken.error], [false, 'daemon gone']);
});

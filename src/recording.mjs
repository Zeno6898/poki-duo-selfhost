import { spawn } from 'node:child_process';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { idevice } from './config.mjs';
import { isNetworkId } from './network-device.mjs';
import { checkWork, execute, signal, work } from './work.mjs';

const sessions = new WeakMap();
const MAX_AUTOMATIC_RETRIES = 3;
function recordings(ctx) {
  if (!sessions.has(ctx)) sessions.set(ctx, new Map());
  return sessions.get(ctx);
}
function track(child) {
  const process = { child, stderr: '', closed: false };
  process.done = new Promise(resolve => {
    child.once('error', error => { process.error = error; });
    child.once('close', (code, signal) => { process.code = code; process.signal = signal; process.closed = true; resolve(); });
  });
  child.stderr?.on('data', chunk => { process.stderr = (process.stderr + chunk).slice(-5000); });
  return process;
}
async function finish(process, signal = 'SIGINT') {
  if (!process || process.closed) return;
  process.child.kill(signal);
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 1000);
  try { await process.done; } finally { clearTimeout(timer); }
}
function firstOutput(process, stream, pattern, requestSignal) {
  requestSignal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); stream.off('data', receive); requestSignal?.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => fail(requestSignal.reason);
    const receive = chunk => { if (!pattern || pattern.test(chunk.toString())) { cleanup(); resolve(); } };
    const timer = setTimeout(() => fail(new Error(`Recording first-frame deadline exceeded: ${process.stderr}`)), 5000);
    stream.on('data', receive); requestSignal?.addEventListener('abort', abort, { once: true });
    process.done.then(() => fail(new Error(`Recording process exited before its first frame: ${process.stderr || process.error?.message || process.code}`)));
  });
}
function connect(session) {
  if (session.stopping || session.encoder.closed) throw new Error('Recording is stopped.');
  const receiver = track(spawn(idevice, ['--udid', session.target.id, 'screencapture', '--stdout'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  session.receiver = receiver;
  receiver.child.stdout.pipe(session.encoder.child.stdin, { end: false });
  receiver.done.then(() => {
    receiver.child.stdout.unpipe(session.encoder.child.stdin);
    if (session.stopping || session.inputPending || session.recovery || receiver !== session.receiver || session.encoder.closed) return;
    if (session.automaticRetries >= MAX_AUTOMATIC_RETRIES) { session.error = 'Automatic recording retry limit reached (3).'; return; }
    session.retry = setTimeout(() => work.run(undefined, () => {
      void recover(session, undefined, true).catch(error => { session.error = error.message; });
    }), 1000);
  });
  return receiver;
}
async function recover(session, requestSignal, automatic = false) {
  if (session.recovery) return session.recovery;
  clearTimeout(session.retry);
  if (session.stopping) throw new Error('Recording is stopped.');
  if (session.encoder.closed) throw new Error(`Video encoder exited: ${session.encoder.stderr}`);
  if (automatic && session.automaticRetries >= MAX_AUTOMATIC_RETRIES) throw new Error('Automatic recording retry limit reached (3). Stop and start a new recording.');
  const combined = requestSignal ? AbortSignal.any([requestSignal, session.controller.signal]) : session.controller.signal;
  session.recovery = (async () => {
    await finish(session.receiver, 'SIGTERM'); combined.throwIfAborted();
    if (automatic) session.automaticRetries++;
    else session.inputReconnects++;
    const receiver = connect(session);
    try { await firstOutput(receiver, receiver.child.stdout, undefined, combined); }
    catch (error) { await finish(receiver, 'SIGTERM'); session.error = error.message; throw error; }
  })();
  try { await session.recovery; } finally { session.recovery = undefined; }
}
export async function startRecording(ctx, target) {
  checkWork();
  const active = recordings(ctx);
  if (active.has(target.id)) throw new Error('This device is already recording. Call stop_recording first.');
  // Recording streams from idevice-tools screencapture, which cannot reach a network device yet.
  if (isNetworkId(target.id)) throw new Error('Recording is not available yet for a network device configured with POKI_DEVICE_HOST; it needs USB or usbmuxd.');
  const directory = join(homedir(), 'Movies', 'Poki MCP');
  await mkdir(directory, { recursive: true, mode: 0o700 }); checkWork();
  const path = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.mov`);
  const session = { target, path, stopping: false, inputReconnects: 0, automaticRetries: 0, controller: new AbortController() };
  active.set(target.id, session); ctx.ownBackground(target.id, 'recording');
  try {
    const requestSignal = signal();
    if (target.kind === 'simulator') {
      session.encoder = track(spawn('xcrun', ['simctl', 'io', target.id, 'recordVideo', '--codec=h264', path], { stdio: ['ignore', 'ignore', 'pipe'] }));
      await firstOutput(session.encoder, session.encoder.child.stderr, /Recording started/, requestSignal);
    } else {
      session.encoder = track(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-n', '-use_wallclock_as_timestamps', '1', '-f', 'hevc', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '30', '-fps_mode', 'cfr', '-movflags', '+faststart', path], { stdio: ['pipe', 'ignore', 'pipe'] }));
      session.encoder.child.stdin.on('error', error => { if (!session.stopping) session.error = error.message; });
      const receiver = connect(session);
      await firstOutput(receiver, receiver.child.stdout, undefined, requestSignal);
      if (session.encoder.closed) throw new Error(`Video encoder exited: ${session.encoder.stderr}`);
    }
    return { recording: true, path, codec: 'H.264', device: target.id, max_automatic_retries: MAX_AUTOMATIC_RETRIES, reconnect_first_frame_timeout_ms: 5000 };
  } catch (error) {
    session.stopping = true; session.controller.abort(); clearTimeout(session.retry);
    await finish(session.receiver, 'SIGTERM'); await finish(session.encoder);
    active.delete(target.id); ctx.unownBackground(target.id, 'recording'); throw error;
  }
}
export async function prepareRecordingInput(ctx, target) {
  const session = recordings(ctx).get(target.id);
  if (!session || target.kind === 'simulator') return;
  // Native input deliberately interrupts the stream. Do not classify that
  // interval as an unexpected disconnect or spend background retry attempts.
  session.inputPending = true;
  clearTimeout(session.retry);
  try { await session.recovery?.catch(() => {}); checkWork(); }
  catch (error) { session.inputPending = false; throw error; }
}
export async function resumeRecordings(ctx, target) {
  const session = recordings(ctx).get(target.id);
  if (!session || target.kind === 'simulator') return;
  try { checkWork(); await recover(session, signal()); }
  finally { session.inputPending = false; }
}
export async function stopRecording(ctx, target) {
  const session = recordings(ctx).get(target.id);
  if (!session) throw new Error('This device is not recording. Call start_recording first.');
  if (session.finishing) return session.finishing;
  session.stopping = true; session.controller.abort(new DOMException('Recording stopped', 'AbortError')); clearTimeout(session.retry);
  session.finishing = (async () => {
    try {
      await session.recovery?.catch(() => {});
      await finish(session.receiver, 'SIGTERM');
      if (session.receiver) {
        session.encoder.child.stdin.end();
        const timer = setTimeout(() => session.encoder.child.kill('SIGINT'), 1000);
        const kill = setTimeout(() => session.encoder.child.kill('SIGKILL'), 2000);
        try { await session.encoder.done; } finally { clearTimeout(timer); clearTimeout(kill); }
      } else await finish(session.encoder);
      if (session.encoder.code !== 0) throw new Error(`Recording could not be finalized: ${session.encoder.stderr || session.encoder.error?.message}`);
      await chmod(session.path, 0o600);
      const info = await stat(session.path);
      if (info.size === 0) throw new Error('Recording contains no video data.');
      const probe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', session.path], { timeout: 5000 })).stdout);
      if (!probe.streams?.some(stream => stream.codec_name === 'h264')) throw new Error('Saved movie has no H.264 video stream.');
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Saved movie has no positive playable duration.');
      return { recording: false, path: session.path, duration_seconds: duration, bytes: info.size, streams: probe.streams, reconnects: session.inputReconnects + session.automaticRetries, input_reconnects: session.inputReconnects, automatic_retries: session.automaticRetries, ...(session.error ? { recovery_error: session.error } : {}) };
    } finally { recordings(ctx).delete(target.id); ctx.unownBackground(target.id, 'recording'); }
  })();
  return session.finishing;
}
export async function closeRecordings(ctx, onlyDevice) {
  const outcomes = await Promise.allSettled([...recordings(ctx).values()].filter(session => !onlyDevice || (typeof onlyDevice === 'string' ? session.target.id === onlyDevice : onlyDevice.has(session.target.id))).map(session => stopRecording(ctx, session.target)));
  return outcomes.map(result => result.status === 'fulfilled' ? result.value : { error: result.reason.message });
}

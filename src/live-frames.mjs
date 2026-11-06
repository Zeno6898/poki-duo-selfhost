// The live screen, enabled with POKI_LIVE_FRAMES=1 next to POKI_BRIDGE_DAEMON=1. Fork-only (poki-remote).
//
// poki-bridged keeps the device's screen video open and decodes it in-process (see
// native/bridge/src/bin/poki-bridged/live.rs), so the newest picture, whether the screen has
// settled, and whether it changed after the last input are known without a device round trip.
// This module is the daemon side's client of those ops:
//
//   latestFrame({ maxWidth })            the newest picture (JPEG; RGB on request) and the screen's state
//   waitSettled({ timeoutMs, settleMs }) the first settled picture from now
//   frameDiff(a, b)                      how the screen changed between two moments or two frames
//   health({ seconds })                  whether pictures are arriving, and at what rate
//
// Accessibility still supplies labels and refs. The pictures decide what the screen shows now.
import { createConnection } from 'node:net';
import sharp from 'sharp';
import { daemonFor, socketPath, enabled as bridgeDaemonEnabled } from './bridge-daemon.mjs';

export const enabled = (env = process.env) => env.POKI_LIVE_FRAMES === '1' && bridgeDaemonEnabled(env);

// A picture answer from poki-bridged in this module's shape.
export async function frameFromAnswer(answer, { rgb = false } = {}) {
  const jpeg = answer.jpeg_base64 ? Buffer.from(answer.jpeg_base64, 'base64') : undefined;
  const frame = {
    jpeg, width: answer.width, height: answer.height,
    capturedAt: answer.captured_at, ageMs: answer.age_ms, settled: Boolean(answer.settled),
    quietMs: answer.quiet_ms ?? null, lastChange: answer.last_change ?? null,
    changedSinceInput: answer.changed_since_input ?? null, pictureAfterInput: answer.picture_after_input ?? null,
    ...(answer.waited_ms !== undefined ? { waitedMs: answer.waited_ms } : {}),
    // Upstream's frame identity, and whether the frame is newer than the last input (after_input,
    // unverified or no_input), when the bridge sends them.
    ...(answer.frame ? { identity: answer.frame } : {}),
    ...(Number.isInteger(answer.frame?.seq ?? answer.epoch) ? { epoch: answer.frame?.seq ?? answer.epoch } : {}),
    ...(answer.observation ? { observation: answer.observation } : {}),
    // Packets arrive but nothing decodes: the picture is older than the screen.
    ...(answer.video_stalled ? { videoStalled: true, stalledMs: answer.stalled_ms ?? null } : {}),
  };
  if (rgb && jpeg) frame.rgb = await sharp(jpeg).removeAlpha().raw().toBuffer();
  return frame;
}

// poki-bridged's subscribe_frames feed (docs/live-screen.md): whether the screen is moving or still,
// which picture it settled on, and the last input, kept current without a request. It is a hint, not a
// source of pictures: until a settled event has been seen since (re)connecting, and after a gap in the
// feed or a new media session, `known` is false and callers ask the daemon as before.
export class LiveFeed {
  known = false; moving = false; stalled = false; settled; input; generation; seq; connected = false; closed = false;
  constructor(path, { connect = createConnection, backoffMs = [200, 500, 1000, 2000] } = {}) {
    this.path = path; this.connect = connect; this.backoffMs = backoffMs; this.attempt = 0;
  }
  // The daemon has to be running already: a request starts it, the feed does not.
  start() {
    if (this.socket || this.closed || this.timer) return;
    const socket = this.socket = this.connect(this.path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'feed', op: 'subscribe_frames' })}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
        try { this.handle(JSON.parse(buffer.slice(0, end))); } catch { this.known = false; }
      }
    });
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.connected = false; this.known = false; this.seq = undefined;
      if (this.closed) return;
      // Events while disconnected are lost, so the state is unknown until the next settled.
      const wait = this.backoffMs[Math.min(this.attempt++, this.backoffMs.length - 1)];
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, wait);
      this.timer.unref?.();
    };
    socket.on('error', lost);
    socket.on('close', lost);
  }
  handle(event) {
    if (event.event === 'subscribed') { this.connected = true; this.attempt = 0; return; }
    // A skipped line or another media session means events were missed.
    if (Number.isInteger(event.seq)) { if (this.seq !== undefined && event.seq !== this.seq + 1) this.known = false; this.seq = event.seq; }
    if (event.generation !== undefined) { if (this.generation !== undefined && event.generation !== this.generation) this.known = false; this.generation = event.generation; }
    switch (event.event) {
      case 'input': this.input = { epoch: event.epoch, sentAt: event.sent_at }; this.moving = true; break;
      case 'changed': this.moving = true; break;
      case 'settled': this.settled = { epoch: event.frame?.seq ?? event.epoch, capturedAt: event.captured_at, quietMs: event.quiet_ms }; this.moving = false; this.known = true; break;
      case 'media': if (event.state !== 'open') this.known = false; break;
      // A stalled video says nothing about the screen until pictures flow and it settles again.
      case 'video': this.stalled = event.state === 'stalled'; if (this.stalled) { this.known = false; this.stalledAt = event.at; } break;
    }
  }
  // Still on the picture numbered `epoch`, with no input or change since it.
  stillOn(epoch) {
    return this.known && !this.moving && this.settled?.epoch === epoch && !(this.input?.epoch >= epoch);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.socket?.destroy(); }
}
export const feedEnabled = (env = process.env) => env.POKI_LIVE_FEED !== '0';

export class LiveScreen {
  constructor(args, { env = process.env, daemon = daemonFor(args, env) } = {}) {
    this.args = args; this.env = env; this.daemon = daemon;
  }
  async op(request, timeout) {
    const { stdout } = await this.daemon.run(request, { timeout });
    // A request has started the daemon, so the feed can connect to it.
    if (feedEnabled(this.env)) this.feed().start();
    return JSON.parse(stdout);
  }
  feed() { return this.liveFeed ??= new LiveFeed(socketPath(this.args, this.env)); }
  // The daemon's own verdict on the connection: { ok, reasons: [video_stalled | media_closed | ...] }.
  async status() {
    const { pong } = await this.daemon.ping(1000);
    return pong?.health ?? { ok: true, reasons: [] };
  }
  async latestFrame({ maxWidth = 600, quality = 5, waitMs = 3000, rgb = false } = {}) {
    return frameFromAnswer(await this.op({ op: 'latest_frame', max_width: Math.round(maxWidth), quality, wait_ms: waitMs }, waitMs + 5000), { rgb });
  }
  // The daemon counts from this moment, and an input it carried makes the screen unsettled at once,
  // so a wait that starts after an input never returns the picture from before it.
  async waitSettled({ timeoutMs = 3000, settleMs, maxWidth = 600, rgb = false } = {}) {
    const request = { op: 'wait_settled', timeout_ms: Math.round(timeoutMs), max_width: Math.round(maxWidth), ...(settleMs ? { settle_ms: Math.round(settleMs) } : {}) };
    return frameFromAnswer(await this.op(request, timeoutMs + 5000), { rgb });
  }
  // Two moments as milliseconds ago, or two frames from this module (compared by when they arrived).
  async frameDiff(a = 1000, b = 0) {
    const ago = value => typeof value === 'number' ? value : Math.max(0, Date.now() - Date.parse(value.capturedAt));
    const answer = await this.op({ op: 'frame_diff', a_ms_ago: Math.round(ago(a)), b_ms_ago: Math.round(ago(b)) }, 10000);
    return { changed: Boolean(answer.changed), score: answer.changed_fraction ?? 0, bbox: answer.region ?? null, aAt: answer.a_at, bAt: answer.b_at };
  }
  // seconds 0 reads the counters without waiting, so no rate is known; a rate needs a short window.
  async health({ seconds = 0 } = {}) {
    try {
      const report = await this.op({ op: 'frames', seconds }, seconds * 1000 + 10000);
      const age = report.latest_age_ms;
      const ok = Boolean(report.decoding) && !report.decoder_error && age !== null && age !== undefined;
      return { ok, fps: report.decoded_per_s ?? null, lastFrameAt: age === null || age === undefined ? null : new Date(Date.now() - age).toISOString(), report };
    } catch (error) {
      return { ok: false, fps: null, lastFrameAt: null, error: error.message };
    }
  }
}

const screens = new Map();
export function liveScreenFor(args, env = process.env) {
  if (!enabled(env)) return undefined;
  const key = JSON.stringify(args);
  if (!screens.has(key)) screens.set(key, new LiveScreen(args, { env }));
  return screens.get(key);
}

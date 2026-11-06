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
import sharp from 'sharp';
import { daemonFor, enabled as bridgeDaemonEnabled } from './bridge-daemon.mjs';

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
  };
  if (rgb && jpeg) frame.rgb = await sharp(jpeg).removeAlpha().raw().toBuffer();
  return frame;
}

export class LiveScreen {
  constructor(args, { env = process.env, daemon = daemonFor(args, env) } = {}) {
    this.args = args; this.env = env; this.daemon = daemon;
  }
  async op(request, timeout) {
    const { stdout } = await this.daemon.run(request, { timeout });
    return JSON.parse(stdout);
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

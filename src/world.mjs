// What is on a device's screen, kept as state rather than captured per call. Pixels are the clock:
// a frame says when the screen last changed, and a tree or OCR text is attached to a frame only when
// it was read after that change, so a result never pairs a new picture with an old description.
//
// Two frame sources share one interface. With the live screen on (POKI_LIVE_FRAMES=1 beside
// POKI_BRIDGE_DAEMON=1, see live-frames.mjs) the long-lived bridge decodes the screen video and
// answers latest_frame and wait_settled in milliseconds; otherwise each frame is a developer-service
// screenshot, and "settled" means two captures in a row look the same.
//
// A frame source is the only thing World needs from a screen, so it runs on any frame cache:
//   frame()                      the newest frame: { image, capturedMs, startedMs?, width?, height?, bridgeEpoch? }
//   settled({ timeoutMs })       the first frame after now that stopped changing, with settled: true,
//                                or the newest one with settled: false when time ran out; a source that
//                                watched the screen the whole time may add changedSinceInput
//   screen.op({ op: 'ocr_region' }) optional: OCR of a box of the newest frame, kept warm by the source
// A frame from before an input is never passed off as one after it: settle() marks each frame with
// whether it is proven to show the screen after the last input (see `proven`).
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { pause, remaining, checkWork } from './work.mjs';
import { stateDir } from './config.mjs';
import { ocrStatus, ocrPath } from './build-info.mjs';
import { promptWarning } from './interaction.mjs';
import { screenIdentity } from './screen-identity.mjs';

const thumbWidth = 64, pixelDelta = 16, changedAbove = 0.002, statusBar = 0.07, quietMs = 150, imageWidth = 360;

// A small grayscale copy, which is all a comparison needs.
export async function thumb(image) {
  const { data, info } = await sharp(image).resize({ width: thumbWidth }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { pixels: data, width: info.width, height: info.height };
}

// The share of pixels that moved and the box around them, as fractions of the screen. The status
// bar changes on its own (clock, signal), so it never counts as the screen changing.
export function compare(a, b) {
  if (!a || !b) return undefined;
  if (a.width !== b.width || a.height !== b.height) return { changed: true, fraction: 1, region: [0, 0, 1, 1] };
  const { width: w, height: h } = a, top = Math.ceil(h * statusBar);
  let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = top; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.abs(a.pixels[y * w + x] - b.pixels[y * w + x]) <= pixelDelta) continue;
    count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const fraction = count / (w * (h - top));
  return { changed: fraction > changedAbove, fraction: Math.round(fraction * 10000) / 10000, region: count ? [x0 / w, y0 / h, (x1 + 1 - x0) / w, (y1 + 1 - y0) / h] : null };
}

class CaptureSource {
  kind = 'capture';
  constructor(devices) { this.devices = devices; }
  async frame() {
    const f = await this.devices.capture();
    const at = Date.parse(f.capture_completed_at);
    return { capturedMs: at, startedMs: Date.parse(f.capture_started_at ?? f.capture_completed_at), changedMs: at, image: f.data, width: f.width, height: f.height };
  }
  // Two captures that look alike; the first is the earliest the screen can have stopped changing.
  async settled({ timeoutMs }) {
    const until = performance.now() + timeoutMs;
    await this.devices.settle();
    let previous = await withThumb(await this.frame());
    for (;;) {
      if (performance.now() >= until || remaining() < 2 * this.devices.captureCost()) return { ...previous, settled: false };
      await pause(quietMs);
      const next = await withThumb(await this.frame());
      if (!compare(previous.thumb, next.thumb).changed) return { ...next, changedMs: previous.capturedMs, settled: true, quietMs: next.capturedMs - previous.capturedMs };
      previous = next;
    }
  }
}

class LiveSource {
  kind = 'live';
  constructor(screen) { this.screen = screen; }
  async frame() { return fromLive(await this.screen.latestFrame({ maxWidth: 600 })); }
  async settled({ timeoutMs, settleMs, maxWidth = 600 }) { return fromLive(await this.screen.waitSettled({ timeoutMs, settleMs, maxWidth })); }
}

// A picture from live-frames.mjs in this module's shape. The newest picture's arrival is the last
// time the screen changed, since the phone sends pictures only while it moves.
function fromLive(picture) {
  if (!picture?.jpeg) throw new Error('The live screen returned no picture.');
  const capturedMs = Date.parse(picture.capturedAt);
  return { capturedMs, changedMs: capturedMs, capturedAt: picture.capturedAt, image: picture.jpeg, settled: picture.settled, quietMs: picture.quietMs ?? undefined,
    changedSinceInput: picture.changedSinceInput, pictureAfterInput: picture.pictureAfterInput, observation: picture.observation, identity: picture.identity, ...(picture.videoStalled ? { videoStalled: true, stalledMs: picture.stalledMs } : {}),
    ...(picture.source ? { pictureSource: picture.source } : {}), ...(picture.fallbackReason ? { fallbackReason: picture.fallbackReason } : {}), ...(picture.foreground ? { foreground: picture.foreground } : {}), lastChange: picture.lastChange, waitedMs: picture.waitedMs, ...(Number.isInteger(picture.epoch) ? { bridgeEpoch: picture.epoch } : {}) };
}

// A failure inside a read is not the call being stopped: only the caller's own deadline or cancel is.
// Read failures (a bridge op timing out, a tree read that died) are absorbed and the caller goes on.
export const absorb = () => { checkWork(); };
// Runs fn for at most ms and returns fallback if it is not done by then or fails on its own. What it
// started keeps running, so this is only for reads, never for input.
export async function within(ms, fn, fallback) {
  if (!(ms > 0)) return fallback;
  if (!Number.isFinite(ms)) { try { return await fn(); } catch { checkWork(); return fallback; } }
  let timer;
  const run = Promise.resolve().then(fn);
  run.catch(() => {});
  try { return await Promise.race([run, new Promise(done => { timer = setTimeout(done, ms, fallback); })]); }
  catch { checkWork(); return fallback; }
  finally { clearTimeout(timer); }
}

async function withThumb(frame) { return frame.thumb ? frame : { ...frame, thumb: await thumb(frame.image) }; }

// A read of the screen, tied to the frame it describes.
const lineOf = e => {
  const label = e.label ?? e.text, value = typeof e.value === 'string' && e.value !== e.placeholder && e.value !== label ? e.value : undefined;
  const parts = [label, value].filter(part => typeof part === 'string' && part.trim());
  return parts.length ? `${e.type ?? e.role ?? 'Text'}: ${parts.join(' = ')}` : undefined;
};
const treeKey = (elements, foreground) => JSON.stringify([foreground?.pid ?? null, elements.map(e => { const f = e.frame ?? e; return [e.type ?? e.role, e.label, e.text, e.value, Boolean(e.selected), f.x, f.y, f.width, f.height]; })]);
// Only a change this large can be a page the tree has not caught up with: a spinner or a clock is not.
const treeLagMs = 2500, lagFraction = 0.02;
const lostText = {
  wifi_required: 'The device tunnel is lost, and iOS accepts new developer connections only on Wi-Fi or USB. Put the phone on Wi-Fi or USB; inputs are held until it is back.',
  tunnel_down: 'The device tunnel is down and being reopened. Inputs are held until it is back.',
  media_closed: 'The screen video is closed, so the result of an input cannot be seen. Inputs are held until it reopens.',
  unreachable: 'The device bridge is not answering. Inputs are held until it does.',
};
lostText.needs_wifi = lostText.wifi_required;
// Reasons that are about the phone itself rather than the connection to it.
const deviceReasons = new Set(['device_locked', 'screen_locked', 'locked', 'screen_off']);
for (const reason of deviceReasons) lostText[reason] = 'The phone is locked or its screen is off; unlock it. Inputs are held until it is unlocked.';
// Reasons the picture may be old while inputs still work: reported as unverified, not blocked.
const degraded = new Set(['video_stalled', 'decode_backlog', 'picture_damaged']);
const visible = e => e.visible !== false && e.visible !== 0 && (e.type ?? e.role) !== 'Application';
const inside = (box, [x, y, w, h], size) => {
  const f = box.frame ?? box, cx = (f.x + f.width / 2) / size.width, cy = (f.y + f.height / 2) / size.height;
  return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
};

// Epochs count changes: every input and every frame that differs from the one before starts a new
// epoch. A tree or OCR text carries the epoch of the frame it was read for, and is current only while
// no later change has been seen. The bridge's own epoch numbers are used when it sends them.
export class World {
  epoch = 0; lastFrame; lastSettle; settledFrame; tree; pendingTree;
  constructor(devices, screen) { this.devices = devices; this.source = screen ? new LiveSource(screen) : new CaptureSource(devices); }
  get live() { return this.source.kind === 'live'; }
  noteInput(tool) { this.epoch++; this.lastInput = { tool, sentMs: Date.now(), epoch: this.epoch }; }
  async stamp(frame) {
    frame = await withThumb(frame);
    if (frame.bridgeEpoch !== undefined) this.epoch = Math.max(this.epoch, frame.bridgeEpoch);
    else if (!this.lastFrame || compare(this.lastFrame.thumb, frame.thumb).changed) this.epoch++;
    this.lastFrame = { ...frame, epoch: this.epoch };
    return this.lastFrame;
  }
  // The newest frame, without waiting for the screen to stop. When the live feed says the screen is
  // still on the last frame seen, with no input since, that frame is the answer and nothing is asked.
  async current() {
    const feed = this.live ? this.source.screen.liveFeed : undefined;
    if (feed && this.lastFrame && Number.isInteger(this.lastFrame.bridgeEpoch) && feed.stillOn(this.lastFrame.bridgeEpoch) && !(this.lastInput?.epoch > this.lastFrame.epoch)) return this.lastFrame;
    return this.stamp(await this.source.frame());
  }
  // The first settled frame after the last input. A launch or navigation is judged only on one.
  async settle(timeoutMs = 3000, settleMs, maxWidth) {
    const started = performance.now(), input = this.lastInput;
    const frame = await this.stamp(await this.source.settled({ timeoutMs, settleMs, maxWidth }));
    const settled = { ...frame, settleMs: Math.round(performance.now() - started), afterInput: input?.epoch, proven: this.proven(frame, input) };
    this.lastSettle = settled;
    if (settled.settled) this.settledFrame = settled;
    return settled;
  }
  // Whether a frame is known to show the screen after the last input: it was captured after the input
  // was sent, or the source watched the screen since the input and saw it settle without a change.
  // A frame that is neither may be the screen the input was sent to, so it proves nothing about it.
  proven(frame, input = this.lastInput) {
    // A picture from a stalled video is older than the screen, whatever its number says.
    if (frame.videoStalled) return false;
    if (!input) return true;
    // A source that watched the screen since the input and saw it settle without moving has proven
    // it unchanged, with no newer picture needed.
    if (frame.settled === true && frame.changedSinceInput === false && frame.observation) return true;
    // A source that numbers its frames says itself whether one is newer than the input (upstream's rule).
    if (frame.observation) return frame.observation !== 'unverified';
    if ((frame.startedMs ?? frame.capturedMs) >= input.sentMs || frame.pictureAfterInput === true) return true;
    return frame.settled === true && frame.changedSinceInput === false;
  }
  // What stands between the agent and the screen, from the source's own health report: a video that
  // stopped decoding (stalled: the picture is old, inputs still work) or a connection that is gone
  // (lost: inputs would not arrive, or their result could not be seen). Undefined when all is well.
  async condition(frame) {
    const screen = this.live ? this.source.screen : undefined;
    if (typeof screen?.status !== 'function') return undefined;
    let health;
    try { health = await screen.status(); } catch { absorb(); health = { ok: false, reasons: ['unreachable'] }; }
    const reasons = health?.reasons ?? [];
    const stalled = frame?.videoStalled || screen.liveFeed?.stalled || reasons.some(reason => degraded.has(reason));
    const lost = reasons.find(reason => !degraded.has(reason));
    if (!stalled && !lost) return undefined;
    return {
      ...(stalled ? { stalled: { ms: frame?.stalledMs ?? null, lastPictureAt: frame ? new Date(frame.capturedMs).toISOString() : null } } : {}),
      ...(lost ? { lost: { kind: deviceReasons.has(lost) ? 'device' : 'connection', reason: lost, text: lostText[lost] ?? `The device connection reports ${lost}. Inputs are held until it recovers.` } } : {}),
    };
  }
  // Whether this frame is the same picture as one seen earlier (same epoch, or no pixel change).
  same(a, b) { return Boolean(a && b) && (a.epoch === b.epoch || !compare(a.thumb, b.thumb).changed); }
  // Reads the tree for a frame, and accepts it only when the read began after the frame's last change.
  // Without a tree, OCR of the frame, or of just the changed region on top of the last good tree,
  // describes it, and the elements inside that region are not offered as targets.
  // waitMs bounds how long the tree may take before the result goes out without it (live frames only:
  // a screenshot-based frame already took longer than the tree).
  // budgetMs bounds the whole read, OCR included, so a dead accessibility service never holds a reply.
  async read(frame, { waitMs = Infinity, budgetMs = Infinity } = {}) {
    const end = performance.now() + budgetMs;
    waitMs = Math.min(waitMs, budgetMs);
    const size = this.devices.size ?? { width: frame.width, height: frame.height };
    if (this.tree?.epoch === frame.epoch) return this.view(frame, { source: 'accessibility', elements: this.tree.elements, foreground: this.tree.foreground, tree: 'current' });
    const startedMs = Date.now(), epoch = frame.epoch;
    const reading = this.devices.structure(0).then(seen => {
      // Read after the frame's last change, and nothing has changed since: it describes this frame.
      // A tree identical to the last one although the pixels moved is the tree lagging the screen, until
      // treeLagMs after the input: only then are the same words on a new picture believed (an image or
      // canvas can change without the tree changing).
      const elements = seen?.elements.filter(visible) ?? [], key = treeKey(elements, seen?.foreground);
      const lagging = this.tree && this.tree.epoch !== epoch && this.tree.key === key && (compare(this.tree.thumb, frame.thumb)?.fraction ?? 0) > lagFraction && startedMs - (this.lastInput?.sentMs ?? 0) < treeLagMs;
      if (elements.length && !lagging && startedMs >= frame.changedMs && this.epoch === epoch) this.tree = { elements, foreground: seen.foreground, epoch, thumb: frame.thumb, key };
      return this.tree?.epoch === epoch ? this.tree : undefined;
    }, absorb);
    const timer = Number.isFinite(waitMs) ? new Promise(done => setTimeout(done, waitMs, 'late')) : undefined;
    const tree = await (timer ? Promise.race([reading, timer]) : reading);
    if (tree === 'late') this.pendingTree = reading.catch(() => {});
    if (tree && tree !== 'late') return this.view(frame, { source: 'accessibility', elements: tree.elements, foreground: tree.foreground, tree: 'current' });
    // Where the pixels did not move since the last tree, it still describes them; the changed region is read by OCR.
    const region = this.tree ? compare(this.tree.thumb, frame.thumb)?.region : null;
    const kept = region && this.tree ? this.tree.elements.filter(e => !inside(e, region, size)) : [];
    const recognized = await within(end - performance.now(), () => this.ocr(frame, kept.length ? region : null, size), []);
    return this.view(frame, { source: kept.length ? 'accessibility+region_ocr' : 'ocr', elements: [...kept, ...recognized], foreground: this.tree?.foreground, tree: tree === 'late' ? 'pending' : 'unavailable', ocrOnly: recognized });
  }
  async ocr(frame, region, size) {
    // The bridge keeps an OCR worker warm on the live frames; otherwise the helper reads a cropped PNG.
    if (this.live) {
      try {
        // Boxes come back as fractions of the screen; text read from a later picture than this frame is not used.
        const request = region ? { op: 'ocr_region', box: region } : { op: 'ocr_frame' };
        const answer = await this.source.screen.op({ ...request, ...(Number.isInteger(frame.bridgeEpoch) ? { epoch: frame.bridgeEpoch } : {}) }, 5000);
        const point = e => { const [x, y, w, h] = e.region ?? [e.x, e.y, e.width, e.height]; return { x: x * size.width, y: y * size.height, width: w * size.width, height: h * size.height }; };
        if (Array.isArray(answer?.elements) && answer.epoch_matches !== false) return answer.elements.map(e => ({ label: e.text, text: e.text, type: 'StaticText', frame: point(e), ocr: true }));
      } catch { absorb(); }
    }
    if (!(await ocrStatus()).available) return [];
    const meta = await sharp(frame.image).metadata();
    const box = region ? [region[0] - 0.02, region[1] - 0.02, region[2] + 0.04, region[3] + 0.04].map(v => Math.max(0, v)) : [0, 0, 1, 1];
    const left = Math.floor(box[0] * meta.width), top = Math.floor(box[1] * meta.height);
    const width = Math.max(1, Math.min(meta.width - left, Math.ceil(box[2] * meta.width))), height = Math.max(1, Math.min(meta.height - top, Math.ceil(box[3] * meta.height)));
    const crop = await sharp(frame.image).extract({ left, top, width, height }).png().toBuffer();
    await mkdir(join(stateDir, 'frames'), { recursive: true, mode: 0o700 });
    const file = join(stateDir, 'frames', `${randomUUID()}-region.png`);
    try {
      await writeFile(file, crop, { mode: 0o600 });
      const { stdout } = await this.devices.run(ocrPath, [file]);
      const sx = size.width / meta.width, sy = size.height / meta.height;
      return JSON.parse(stdout).map(e => ({ label: e.text, text: e.text, type: 'StaticText', frame: { x: (e.x + left) * sx, y: (e.y + top) * sy, width: e.width * sx, height: e.height * sy }, ocr: true }));
    } finally { await unlink(file).catch(() => {}); }
  }
  view(frame, { source, elements, foreground, tree, ocrOnly = [] }) {
    const lines = [...new Set(elements.map(lineOf).filter(Boolean))];
    const prompt = promptWarning(elements);
    const page = screenIdentity({ foreground, elements, prompt });
    // Without a tree, the app in front is the one the bridge named with the picture.
    foreground ??= frame.foreground;
    return { frame, source, elements, foreground: foreground ? { bundle_id: foreground.bundle_id ?? null, pid: foreground.pid ?? null } : null, tree, lines, prompt, page, ocrOnly };
  }
  // How a session's last look differs from this one, so a result can lead with what is new.
  sinceLastLook(session, view) {
    const last = session.lastLook;
    session.lastLook = { lines: new Set(view.lines), foreground: view.foreground?.pid ?? null, page: view.page?.id ?? null };
    if (!last) return undefined;
    const appeared = view.lines.filter(line => !last.lines.has(line)), vanished = [...last.lines].filter(line => !view.lines.includes(line));
    return {
      ...(appeared.length ? { appeared: appeared.slice(0, 12), ...(appeared.length > 12 ? { more_appeared: appeared.length - 12 } : {}) } : {}),
      ...(vanished.length ? { vanished: vanished.slice(0, 8), ...(vanished.length > 8 ? { more_vanished: vanished.length - 8 } : {}) } : {}),
      ...(last.foreground !== (view.foreground?.pid ?? null) ? { foreground_changed: true } : {}),
      ...(last.page !== (view.page?.id ?? null) ? { new_page: true } : {}),
    };
  }
  // A small JPEG of the frame: enough to see, cheap enough to send every time.
  async picture(frame, full = false) {
    return sharp(frame.image).resize({ width: full ? 600 : imageWidth }).jpeg({ quality: full ? 80 : 60 }).toBuffer();
  }
}

// observe, act and run: the screen as state, an action with what it should produce, and a chain of
// actions that runs at device speed and comes back to the model only where something needs a decision
// (an expectation missed, a system prompt, a destructive step it did not allow, an error).
//
// Every result ends with `now`, built from the device's World (world.mjs): one frame, the text read
// for that frame and nothing older, and one verdict on the last action. The steps are the existing
// single-step tools, sent through Devices.dispatch, so they keep their arguments and their checks.
// Nothing here knows any app.
import { randomUUID } from 'node:crypto';
import { matching, whatMoved } from './interaction.mjs';
import { compare, within } from './world.mjs';
import { checkWork, stoppingReason } from './work.mjs';

export const names = ['observe', 'act', 'run'];
// Steps a run may contain. wait_for is an expectation with no input; select_items is handled here.
export const stepTools = ['launch_app', 'terminate_app', 'open_url', 'tap', 'double_tap', 'long_press', 'tap_text', 'fill', 'type_text', 'scroll', 'scroll_to', 'swipe', 'drag', 'pinch', 'press_key', 'press_button', 'go_back', 'hide_keyboard', 'handle_alert', 'wait_for', 'select_items'];
const appTools = new Set(['launch_app', 'terminate_app', 'open_url']);
const coordinateTouches = new Set(['tap', 'double_tap', 'long_press']);
// Words that mark a step whose effect may not be undone. A run stops before such a step unless the
// caller allowed it. This is a generic pattern over the target's label, not a list of apps.
export const destructive = /\b(delete|remove|erase|send|pay|purchase|buy|confirm|sign out|log out|reset|discard)\b/i;
// A wait after an input is cut into slices, so an expectation is checked while a screen keeps moving.
const sliceMs = 800, lookMs = 3000;
// Whether the call itself was stopped (its deadline or a cancel), as opposed to one read failing.
const cancelled = () => { try { checkWork(); return false; } catch { return true; } };
const stepTimeoutMs = 3000, maxTimeoutMs = 30000, runKeptMs = 10 * 60 * 1000, lineLimit = 40, treeWaitMs = 400;

const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase().trim();
const box = element => element.frame ?? element;
const centerOf = element => { const f = box(element); return { x: f.x + f.width / 2, y: f.y + f.height / 2 }; };
const labelOf = element => element.label ?? element.text ?? element.value ?? element.placeholder ?? element.identifier;
const roleOf = element => String(element.type ?? element.role ?? '');
const covers = (element, { x, y }) => { const f = box(element); return x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height; };
const insideOf = (element, container) => covers(container, centerOf(element)) && element !== container;
// Reading order: rows top to bottom (centers within 8 points share a row), then left to right.
const readingOrder = (a, b) => { const p = centerOf(a), q = centerOf(b); return Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x; };

function state(ctx) {
  ctx.agent ??= { runs: new Map() };
  const now = Date.now();
  for (const [id, saved] of ctx.agent.runs) if (now - saved.at > runKeptMs) ctx.agent.runs.delete(id);
  return ctx.agent;
}

// Refs name elements of one frame. Once the screen has changed they name nothing, so a stale ref is
// refused instead of being tapped where the element used to be.
function giveRefs(agent, view) {
  agent.refs = { epoch: view.frame.epoch, thumb: view.frame.thumb, byRef: new Map() };
  agent.counter ??= 0;
  return view.elements.filter(e => labelOf(e) || e.ocr).map(e => {
    const ref = `e${++agent.counter}`;
    agent.refs.byRef.set(ref, e);
    const f = box(e);
    return { ref, role: roleOf(e) || 'Text', label: labelOf(e) ?? '', frame: [f.x, f.y, f.width, f.height].map(Math.round) };
  });
}
class StaleRef extends Error {}
// A ref stays good while the pixels under its element hold: a spinner or a clock elsewhere on the
// screen does not retire it, a change that reaches it does. Its frame has to be seen after the last input.
function resolveRef(agent, world, ref) {
  const element = agent.refs?.byRef.get(String(ref).toLowerCase());
  const stale = () => new StaleRef(`Ref ${ref} is from an earlier screen. Use the refs in this result, or the visible text with tap_text.`);
  if (!element) throw stale();
  if (agent.refs.epoch === world.epoch) return element;
  const latest = world.lastFrame, size = world.devices.size;
  if (!latest || !size || !agent.refs.thumb || latest.epoch < (world.lastInput?.epoch ?? 0)) throw stale();
  const change = compare(agent.refs.thumb, latest.thumb);
  if (!change?.changed) return element;
  const f = box(element), [x, y, w, h] = change.region;
  const fx = f.x / size.width, fy = f.y / size.height, fw = f.width / size.width, fh = f.height / size.height;
  if (fx < x + w && x < fx + fw && fy < y + h && y < fy + fh) throw stale();
  return element;
}

// What a step will touch, as a label, so the destructive check sees the same thing the tap will.
function targetOf(step, view, agent) {
  const a = step.arguments ?? {};
  if (step.tool === 'tap_text' || step.tool === 'handle_alert') return a.text ?? a.button ?? (a.action === 'accept' ? 'accept' : undefined);
  if (step.tool === 'fill' || step.tool === 'type_text') return a.submit ? a.field ?? 'submit' : undefined;
  if (step.tool === 'press_key') return undefined;
  if (step.tool === 'select_items') return undefined;
  if (coordinateTouches.has(step.tool)) {
    if (a.ref) return labelOf(agent.refs?.byRef.get(String(a.ref).toLowerCase()) ?? {});
    if (Number.isFinite(a.x) && view) return labelOf(view.elements.filter(e => covers(e, a)).sort((p, q) => box(p).width * box(p).height - box(q).width * box(q).height)[0] ?? {});
  }
  return undefined;
}
const allowed = (label, allow = []) => allow.some(entry => normalize(label).includes(normalize(entry)));

// Whether the expectation holds on this view. Text is matched only against what was read for this
// frame, and a foreground or "gone" only against a tree read for it.
function holds(expect, view, base) {
  if (!expect) return undefined;
  if (expect.text !== undefined) return matching(view.elements, expect.text, expect.exact).length > 0;
  // "Gone" needs a complete reading of this frame: its tree, or OCR of the whole picture.
  if (expect.gone !== undefined) return (view.tree === 'current' || view.ocrComplete) && matching(view.elements, expect.gone, expect.exact).length === 0;
  if (expect.foreground !== undefined) return view.foregroundFresh && view.foreground?.bundle_id === expect.foreground;
  if (expect.page_identity !== undefined) return view.tree === 'current' && (expect.page_identity === 'new' ? view.page?.id !== base.page : view.page?.id === expect.page_identity);
  if (expect.change !== undefined) {
    const change = compare(base.frame?.thumb, view.frame.thumb);
    if (!change?.changed) return false;
    if (!Array.isArray(expect.change)) return true;
    const [x, y, w, h] = expect.change, [cx, cy, cw, ch] = change.region;
    return cx < x + w && x < cx + cw && cy < y + h && y < cy + ch;
  }
  return undefined;
}
const describeExpect = expect => expect.text !== undefined ? `text ${JSON.stringify(expect.text)}` : expect.gone !== undefined ? `${JSON.stringify(expect.gone)} gone` : expect.foreground !== undefined ? `${expect.foreground} in front` : expect.page_identity !== undefined ? `page ${expect.page_identity}` : 'a change';

const treeKey = view => view.tree === 'current' ? JSON.stringify(view.lines) : undefined;

// The screen the next input is sent to, as the comparison base for its verdict.
async function baseOf(world) {
  const frame = world.lastFrame && world.lastFrame.epoch === world.epoch ? world.lastFrame : await within(lookMs, () => world.current(), world.lastFrame) ?? await world.current();
  const tree = world.tree?.epoch === frame.epoch ? world.tree : undefined;
  return { frame, elements: tree?.elements, foreground: tree?.foreground?.pid ?? null, key: tree ? JSON.stringify(world.view(frame, { elements: tree.elements, foreground: tree.foreground }).lines) : undefined, page: tree ? world.view(frame, { elements: tree.elements, foreground: tree.foreground }).page?.id : undefined };
}

// Waits for the screen after an input: until the expectation holds on a settled frame, the screen
// settles without it, a system prompt is up, or time runs out. Without an expectation, until the
// first settled frame.
async function judge(world, base, { expect, timeoutMs }) {
  // A hard deadline: every settle, picture, tree and OCR read races it, and the answer at the end is
  // whatever the World has then.
  const until = performance.now() + timeoutMs, left = () => until - performance.now();
  let previous, frame, view;
  for (;;) {
    checkWork();
    const settled = await within(left(), () => world.settle(Math.max(150, Math.min(left(), sliceMs))), undefined);
    frame = settled ?? frame;
    // Never a picture older than the newest: a screen that does not settle is shown as it is now.
    if (!settled?.settled) frame = await within(Math.max(300, left()), () => world.current(), frame) ?? frame ?? world.lastFrame ?? base.frame;
    view = await within(Math.max(300, left()), () => world.read(frame, { waitMs: world.live ? treeWaitMs : left(), budgetMs: Math.max(300, left()) }), undefined)
      ?? world.view(frame, { source: 'none', elements: [], foreground: null, tree: 'unavailable' });
    const met = holds(expect, view, base);
    // A screen that keeps animating (a spinner, a clock) never settles; its text holding still across
    // two reads of a tree current for each frame is as good a sign that it has arrived.
    const textStill = Boolean(previous) && view.tree === 'current' && previous.view.tree === 'current' && JSON.stringify(view.lines) === JSON.stringify(previous.view.lines);
    const still = frame.settled || textStill;
    if (met && still) return { expectation: 'met', frame, view };
    if (view.prompt) return { expectation: expect ? 'blocked' : undefined, frame, view };
    if (!expect && still) return { frame, view };
    // A settled screen that never moved is the answer; one that moved may still be on its way (a
    // spinner, a page sliding in), so it is believed when it settles twice on the same picture.
    const moved = compare(base.frame.thumb, frame.thumb)?.changed;
    // Only a tree read for this frame can say what is missing: a lagging one is waited out.
    if (expect && view.tree === 'current' && (frame.settled && (!moved || previous?.frame.settled && world.same(previous.frame, frame)) || textStill)) return { expectation: 'missed', frame, view };
    if (left() <= 0) return { expectation: expect ? (met ? 'met' : 'timeout') : undefined, frame, view };
    previous = { frame, view };
  }
}

// One verdict on the last input, from pixels, then the app in front, then the tree.
function outcomeOf(judged, base, inputSent) {
  const { frame, view } = judged;
  if (judged.expectation === 'met') return { outcome: 'as_expected' };
  if (!inputSent) return { outcome: 'unchanged', reason: 'no input was sent' };
  if (!frame.proven) return { outcome: 'unverified', reason: 'no frame newer than the input arrived: the screen may not have changed, or the picture may be the one the input was sent to' };
  // The bridge's own verdict from the video's activity: nothing moved after the input.
  const quiet = frame.settled && frame.changedSinceInput === false;
  const moved = !quiet && compare(base.frame.thumb, frame.thumb)?.changed;
  const app = view.tree === 'current' && base.foreground !== null && (view.foreground?.pid ?? null) !== base.foreground;
  const tree = base.key !== undefined && treeKey(view) !== undefined && treeKey(view) !== base.key;
  if (!frame.settled) return { outcome: 'unknown', reason: `the screen was still changing when time ran out${moved ? ' (it did change after the input)' : ''}` };
  if (moved || app || tree) return { outcome: 'changed' };
  return { outcome: 'unchanged', reason: 'the settled screen after the input is the picture it was sent to' };
}

// The `now` block, the last thing in every result: what is on the screen, read for one frame.
async function nowBlock(ctx, world, judged, { base, sentMs, verdict, full = false, refsInvalid = false, typed, stop }) {
  const agent = state(ctx), { frame, view } = judged;
  // A stalled video or a lost connection comes first: everything below it is read in that light.
  const condition = await world.condition(frame);
  if (condition?.stalled) verdict = { ...verdict, outcome: 'unverified', reason: 'the screen video is stalled, so no picture after the input exists' };
  const since = world.sinceLastLook(agent, view);
  const lines = view.lines.slice(0, lineLimit);
  const app = view.foreground?.bundle_id ?? 'unknown app';
  const fresh = since?.appeared?.slice(0, 3).map(line => line.replace(/^[^:]+: /, '')).join(', ');
  const word = verdict ? { as_expected: 'as expected', changed: 'changed', unchanged: 'unchanged', unknown: 'still animating', unverified: 'unverified' }[verdict.outcome] : frame.settled === false ? 'current screen, still animating' : 'current screen';
  const stall = condition?.stalled ? `Screen feed stalled${condition.stalled.ms ? ` ${Math.round(condition.stalled.ms / 1000)} s` : ''}; last picture is from ${condition.stalled.lastPictureAt}. ` : '';
  const summary = `${condition?.lost ? `${condition.lost.text} ` : ''}${stall}${app}: ${stop ? `stopped before step ${stop.step} (${stop.reason}), last step ` : ''}${word}${verdict?.expectation && verdict.expectation !== 'met' ? ` (expected ${verdict.expected}: ${verdict.expectation})` : ''}${fresh ? `. New: ${fresh}` : ''}${view.prompt ? `. System prompt: ${view.prompt.kind}` : ''}${view.ax === 'unavailable' ? '. Accessibility unavailable: text is read from the picture, and refs are OCR boxes' : ''}.`;
  const elements = giveRefs(agent, view);
  return {
    summary,
    ...(verdict ? { outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}) } : {}),
    frame: { captured_at: new Date(frame.capturedMs).toISOString(), ...(sentMs ? { action_sent_at: new Date(sentMs).toISOString() } : {}), age_ms: Math.max(0, Date.now() - frame.capturedMs), settled: Boolean(frame.settled), ...(condition?.stalled ? { stalled: true } : {}) },
    ...(since && Object.keys(since).length ? { since_last_look: since } : {}),
    foreground: view.foreground,
    // With the video stalled the text comes from a read of the screen made now, not from the old picture.
    text: { of: condition?.stalled ? new Date().toISOString() : new Date(frame.capturedMs).toISOString(), source: view.source, lines, ...(view.lines.length > lines.length ? { more: view.lines.length - lines.length } : {}) },
    ...(view.tree === 'pending' ? { tree: 'pending' } : {}),
    ...(full || refsInvalid ? { elements } : {}),
    ...(condition?.lost ? { blocked: { kind: condition.lost.kind ?? 'connection', reason: condition.lost.reason, text: [condition.lost.text] } } : view.prompt ? { blocked: { kind: view.prompt.kind, text: lines.slice(0, 6) } } : {}),
    ...(typed ? { typed } : {}),
  };
}

// The picture goes with the text, except an old one from a stalled video, which would pass for the screen.
async function reply(ctx, world, body, frame, full) {
  const content = [{ type: 'text', text: JSON.stringify(body) }];
  if (!body.now?.frame?.stalled) content.push({ type: 'image', data: (await world.picture(frame, full)).toString('base64'), mimeType: 'image/jpeg' });
  return { content, _meta: { verdict: body.now?.outcome ?? null } };
}

// Before an input: a connection that is gone holds it back, and the result says why.
async function heldBack(world) {
  const condition = await world.condition(world.lastFrame);
  return condition?.lost;
}

// The step's own answer, as the single-step tool gave it.
function answerOf(result) {
  const text = result.content?.find(block => block.type === 'text')?.text ?? '';
  try { return { ...JSON.parse(text), isError: Boolean(result.isError) }; } catch { return { message: text, isError: Boolean(result.isError) }; }
}
// How typed text was confirmed, and a later read-back that disagreed with it (the bridge reports that
// on the next answer of any op, as warnings), carried into `now`.
const typedOf = answer => {
  const mismatch = (answer.warnings ?? []).filter(w => w?.warning === 'text_mismatch' || w?.warning === 'other_field_changed').map(({ warning, op, field, reason, instruction }) => ({ warning, op, field, reason, instruction }));
  if (answer.text_mismatch !== undefined) mismatch.push({ warning: 'text_mismatch', reason: answer.text_mismatch });
  if (answer.verified === undefined && !mismatch.length) return undefined;
  return { ...(answer.verified !== undefined ? { verified: answer.verified } : {}), ...(mismatch.length ? { text_mismatch: mismatch } : {}) };
};

// Sends one step through the single-step tool of that name, with no read before or after it: the
// World judges the result. A ref becomes the point it names on the current frame.
async function send(ctx, world, agent, step) {
  let args = { ...(step.arguments ?? {}) };
  if (args.ref && (coordinateTouches.has(step.tool) || step.tool === 'fill')) {
    const { ref, ...rest } = args;
    args = { ...rest, ...centerOf(resolveRef(agent, world, ref)) };
  }
  const saved = { inBatch: ctx.inBatch, batchStep: ctx.batchStep };
  // As in a batch: one device lookup and one screen size for all steps, and no per-step readback.
  ctx.inBatch = true; ctx.batchStep = { stopOnError: false };
  try { return answerOf(await ctx.dispatch(step.tool, args)); }
  finally { ctx.inBatch = saved.inBatch; ctx.batchStep = saved.batchStep; }
}

// Taps the first `count` elements that match, in reading order, inside a container when one is named.
async function selectItems(ctx, world, agent, args) {
  let view = await world.read(world.lastFrame?.epoch === world.epoch ? world.lastFrame : await world.current(), { budgetMs: lookMs });
  if (view.tree !== 'current') view = await world.read(await world.current(), { budgetMs: lookMs });
  let pool = view.elements;
  if (args.in) {
    const container = args.in.ref ? resolveRef(agent, world, args.in.ref) : matching(pool, args.in.label, true)[0] ?? matching(pool, args.in.label)[0];
    if (!container) return { isError: true, message: `No container ${JSON.stringify(args.in.label ?? args.in.ref)} on screen.` };
    pool = pool.filter(e => insideOf(e, container));
  }
  const match = args.match ?? {};
  const label = match.label === undefined ? () => true : /^\/.+\/[a-z]*$/.test(match.label) ? (() => { const [, body, flags] = match.label.match(/^\/(.+)\/([a-z]*)$/); const re = new RegExp(body, flags); return e => re.test(labelOf(e) ?? ''); })() : e => normalize(labelOf(e) ?? '').includes(normalize(match.label));
  const role = match.role === undefined ? () => true : e => normalize(roleOf(e)).includes(normalize(match.role));
  const found = pool.filter(e => role(e) && label(e) && roleOf(e) !== 'Application').sort(readingOrder).slice(0, args.count);
  if (found.length < args.count) return { isError: true, sent: false, message: `Only ${found.length} visible element${found.length === 1 ? '' : 's'} match ${JSON.stringify(match)}; nothing was tapped.` };
  const tapped = [];
  for (const element of found) {
    const answer = await send(ctx, world, agent, { tool: 'tap', arguments: centerOf(element) });
    if (answer.isError) return { ...answer, tapped };
    tapped.push(labelOf(element) ?? '');
  }
  return { sent: true, tapped };
}

async function step(ctx, world, agent, item, { timeoutMs }) {
  const base = await baseOf(world);
  const started = Date.now();
  if (item.tool === 'wait_for') {
    const a = item.arguments ?? {};
    const expect = a.gone ? { gone: a.text, exact: a.exact } : { text: a.text, exact: a.exact };
    const judged = await judge(world, base, { expect, timeoutMs: (a.timeout_seconds ?? a.timeout ?? timeoutMs / 1000) * 1000 });
    return { base, judged, sent: false, answer: {}, expect, sentMs: undefined };
  }
  const answer = item.tool === 'select_items' ? await selectItems(ctx, world, agent, item.arguments ?? {}) : await send(ctx, world, agent, item);
  // Launching goes to the device's app service, not its input, so the World is told here.
  // A launch that returned a pid reached the device even when its app did not come to the front, and
  // one whose outcome is unknown may have: neither is reported as not sent.
  const delivered = appTools.has(item.tool) && (!answer.isError || Number.isSafeInteger(answer.pid) || answer.outcome === 'unknown');
  if (delivered && !(world.lastInput?.sentMs >= started)) world.noteInput(item.tool);
  const sent = answer.sent === true || delivered || world.lastInput?.sentMs >= started;
  // The app service started the app, yet it is not in front: on a phone that is mostly a lock screen.
  if (item.tool === 'launch_app' && answer.isError && Number.isSafeInteger(answer.pid)) answer.message = `${String(answer.error ?? 'The launched app did not come to the front').replace(/\.$/, '')}, although the app service launched it as pid ${answer.pid}. If the phone is locked or its screen is off, unlock it.`;
  const judged = await judge(world, base, { expect: item.expect, timeoutMs });
  return { base, judged, sent, answer, expect: item.expect, sentMs: sent ? world.lastInput?.sentMs : undefined };
}

export async function observe(ctx, args = {}) {
  const world = await ctx.world();
  const frame = await within(lookMs, () => world.current(), world.lastFrame) ?? await world.current();
  const view = await within(lookMs, () => world.read(frame, { waitMs: lookMs - 500, budgetMs: lookMs }), undefined) ?? world.view(frame, { source: 'none', elements: [], foreground: null, tree: 'unavailable' });
  const now = await nowBlock(ctx, world, { frame, view }, { full: args.full });
  return reply(ctx, world, { now, next: 'Act with act {action, expect}, or chain known steps with run {steps}; each reply ends with the screen as now.' }, frame, args.full);
}

export async function act(ctx, args) {
  const agent = state(ctx), world = await ctx.world();
  const timeoutMs = Math.min(args.timeout_ms ?? stepTimeoutMs, maxTimeoutMs);
  const lost = await heldBack(world);
  if (lost) {
    const frame = await world.current(), view = await world.read(frame, { waitMs: treeWaitMs });
    return { isError: true, ...await reply(ctx, world, { sent: false, expectation: args.expect ? 'blocked' : undefined, now: await nowBlock(ctx, world, { frame, view }, {}) }, frame) };
  }
  let done;
  try { done = await step(ctx, world, agent, { ...args.action, expect: args.expect }, { timeoutMs }); }
  catch (error) {
    if (cancelled()) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ stopped: true, stop_reason: stoppingReason(error) }) }], _meta: { stop_reason: stoppingReason(error) } };
    if (!(error instanceof StaleRef)) throw error;
    const frame = await within(lookMs, () => world.current(), world.lastFrame) ?? await world.current(), view = await world.read(frame, { waitMs: lookMs - 500, budgetMs: lookMs });
    const now = await nowBlock(ctx, world, { frame, view }, { refsInvalid: true });
    return { isError: true, ...await reply(ctx, world, { sent: false, error: error.message, now }, frame) };
  }
  const { base, judged, sent, answer, sentMs } = done;
  const verdict = { ...outcomeOf(judged, base, sent), expectation: judged.expectation, expected: args.expect ? describeExpect(args.expect) : undefined };
  const now = await nowBlock(ctx, world, judged, { base, sentMs, verdict, full: args.full, typed: typedOf(answer) });
  const body = {
    sent, ...(args.expect ? { expectation: judged.expectation } : {}), waited_ms: sentMs ? Math.max(0, Date.now() - sentMs) : 0,
    ...(answer.isError ? { error: answer.message ?? answer.error ?? 'The step failed.' } : {}),
    // Which list a scroll moved, from the trees read for the frames on either side of it.
    ...(/^scroll/.test(args.action.tool) && base.elements && judged.view.tree === 'current' ? { moved: whatMoved(base.elements, judged.view.elements) } : {}),
    ...(answer.outcome === 'unknown' && !Number.isSafeInteger(answer.pid) ? { delivery: 'unknown', instruction: 'The input may have been delivered. Do not send it again before checking now.' } : {}),
    now,
  };
  return { ...(answer.isError ? { isError: true } : {}), ...await reply(ctx, world, body, judged.frame, args.full) };
}

export async function run(ctx, args) {
  const agent = state(ctx), world = await ctx.world();
  let saved;
  if (args.resume) {
    saved = agent.runs.get(args.resume);
    if (!saved) throw new Error(`No run ${args.resume} to resume in this session (runs are kept for ${runKeptMs / 60000} minutes). Send the remaining steps as a new run.`);
    saved.allow = [...saved.allow, ...(args.allow ?? [])];
  } else {
    if (!args.steps?.length) throw new Error('Provide steps, or resume with a run_id.');
    saved = { id: randomUUID().slice(0, 8), steps: args.steps, next: 0, allow: args.allow ?? [] };
  }
  saved.at = Date.now();
  agent.runs.set(saved.id, saved);
  let last, stoppedAt = null, typed;
  for (; saved.next < saved.steps.length; saved.next++) {
    const index = saved.next, item = saved.steps[index];
    if (!stepTools.includes(item.tool)) { stoppedAt = { step: index + 1, tool: item.tool, reason: 'error', detail: `${item.tool} is not a run step. Steps: ${stepTools.join(', ')}.` }; break; }
    const lost = await heldBack(world);
    if (lost) { stoppedAt = { step: index + 1, tool: item.tool, reason: 'blocked', detail: `${lost.text} Step ${index + 1} was not sent.` }; break; }
    // The destructive check reads the label the step will touch, on the screen it will touch it on.
    const current = world.tree?.epoch === world.epoch && world.lastFrame ? world.view(world.lastFrame, { elements: world.tree.elements, foreground: world.tree.foreground }) : undefined;
    const target = targetOf(item, current, agent);
    if (target && destructive.test(target) && !allowed(target, saved.allow)) {
      stoppedAt = { step: index + 1, tool: item.tool, reason: 'checkpoint', detail: `Step ${index + 1} touches ${JSON.stringify(target)}, which may not be undoable. Nothing was sent. If the user asked for it, continue with run {resume: "${saved.id}", allow: [${JSON.stringify(target)}]}.` };
      break;
    }
    try {
      last = await step(ctx, world, agent, item, { timeoutMs: Math.min(item.timeout_ms ?? stepTimeoutMs, maxTimeoutMs) });
    } catch (error) {
      if (cancelled()) throw error;
      stoppedAt = { step: index + 1, tool: item.tool, reason: 'error', detail: error.message };
      break;
    }
    typed = typedOf(last.answer) ?? typed;
    const { judged, answer } = last;
    if (answer.isError) {
      // An input whose delivery is unknown is never sent again: a resume starts after it.
      const unknown = answer.outcome === 'unknown';
      stoppedAt = { step: index + 1, tool: item.tool, reason: judged.view.prompt ? 'blocked' : 'error', detail: answer.message ?? answer.error ?? 'The step failed.', ...(unknown ? { delivery: 'unknown' } : {}) };
      if (unknown) saved.next++;
      break;
    }
    if (judged.view.prompt) { stoppedAt = { step: index + 1, tool: item.tool, reason: 'blocked', detail: `A system prompt (${judged.view.prompt.kind}) is on screen.` }; saved.next++; break; }
    if (item.expect && judged.expectation !== 'met') {
      stoppedAt = { step: index + 1, tool: item.tool, reason: 'missed', detail: `Expected ${describeExpect(item.expect)}; ${judged.expectation === 'timeout' ? 'the screen kept changing' : 'the screen settled without it'}. The step was ${last.sent ? 'sent' : 'not sent'}; the steps after it did not run.` };
      saved.next++;
      break;
    }
  }
  const finished = saved.next >= saved.steps.length && !stoppedAt;
  if (finished) agent.runs.delete(saved.id);
  // The last step's frame, or the screen now when the run stopped before sending anything.
  const judged = last?.judged ?? await (async () => { const frame = await within(lookMs, () => world.current(), world.lastFrame) ?? await world.current(); return { frame, view: await world.read(frame, { waitMs: lookMs - 500, budgetMs: lookMs }) }; })();
  const verdict = last ? { ...outcomeOf(judged, last.base, last.sent), expectation: judged.expectation, expected: last.expect ? describeExpect(last.expect) : undefined } : undefined;
  const now = await nowBlock(ctx, world, judged, { base: last?.base, sentMs: last?.sentMs, verdict, full: args.full, typed, stop: stoppedAt?.reason === 'checkpoint' ? stoppedAt : undefined });
  const body = { run_id: saved.id, completed_steps: stoppedAt ? stoppedAt.step - 1 : saved.steps.length, stopped: stoppedAt, now };
  return { ...(stoppedAt && stoppedAt.reason !== 'checkpoint' ? { isError: true } : {}), ...await reply(ctx, world, body, judged.frame, args.full) };
}

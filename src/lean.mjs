// The lean agent tools (POKI_TOOL_PROFILE=lean): act, then read once. `step` sends its actions back
// to back, waits for the phone's packet clock to go quiet, then reads the screen once (accessibility,
// capped) while a small screenshot is taken beside it, and answers with facts: what was sent and when,
// how long it waited, what appeared, vanished or changed since the last read, with numbered refs, the
// app in front, and the picture. It passes no verdict: the model judges the result from the facts.
// `look` is the same read without actions.
//
// A step never throws for trouble on the device: a failed action is reported and the read still runs;
// a failed tree read falls back to OCR of the screenshot; a failed screenshot leaves its reason in
// one short field. Every step has a hard cap of stepCapMs of device time.
import sharp from 'sharp';
import { checkWork } from './work.mjs';
import { within } from './world.mjs';
import { whatMoved } from './interaction.mjs';

const stepCapMs = 4000, readCapMs = 2000, quietMinMs = 150, quietMaxMs = 1500, stalledClockMs = 400, shotWidth = 400;
const diffLimit = 40, fullLimit = 80, goneLimit = 20;
const pause = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const cancelled = () => { try { checkWork(); return false; } catch { return true; } };
const box = e => e.frame ?? e;
const labelOf = e => e.label ?? e.text ?? e.placeholder ?? e.identifier ?? '';
const roleOf = e => String(e.type ?? e.role ?? 'Text').replace(/^(?:AX|XCUIElementType)/, '');
const interactive = e => /button|cell|link|field|switch|slider|tab|icon|key|menuitem|segment|picker|textview|toggle|stepper/i.test(roleOf(e));
const isTextInput = e => /^(?:Secure)?(?:TextField|TextArea|TextView|SearchField)$/i.test(roleOf(e));
const visible = e => e.visible !== false && e.visible !== 0 && roleOf(e) !== 'Application' && box(e).width > 0 && box(e).height > 0;
const readingOrder = (a, b) => { const p = box(a), q = box(b); return Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x; };
const valueOf = e => typeof e.value === 'string' && e.value !== labelOf(e) && e.value !== e.placeholder ? e.value : typeof e.value === 'number' ? String(e.value) : undefined;
const stateOf = e => [e.selected && 'selected', e.focused && 'focused', e.enabled === false && 'disabled'].filter(Boolean);
const centre = e => { const f = box(e); return { x: f.x + f.width / 2, y: f.y + f.height / 2 }; };
const errorText = error => String(error?.message ?? error ?? 'failed').split('\n')[0].slice(0, 300);

// Per session: the refs of the latest read, and that read, for the next diff.
function state(ctx) { return ctx.lean ??= { counter: 0, refOf: new Map(), byRef: new Map(), last: undefined }; }

// Elements of a read, keyed by what they are (role, label, and their place among namesakes), so an
// element that stays on screen keeps its ref from one read to the next.
function keyed(elements) {
  const seen = new Map();
  return elements.filter(e => visible(e) && (labelOf(e) || valueOf(e) || isTextInput(e))).sort(readingOrder).map(e => {
    const name = `${roleOf(e)}|${labelOf(e)}`, n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { key: `${name}#${n}`, element: e };
  });
}
const describe = (ref, e) => {
  const f = box(e), value = valueOf(e), flags = stateOf(e);
  return { ref, role: roleOf(e), label: labelOf(e), ...(value !== undefined ? { value } : {}), ...(flags.length ? { state: flags } : {}), frame: [f.x, f.y, f.width, f.height].map(Math.round) };
};
const shortList = (items, limit) => [...items.filter(i => interactive(i.element)), ...items.filter(i => !interactive(i.element))].slice(0, limit);

// Numbers this read's elements and compares them with the last read: the refs of the latest read
// are the only ones accepted.
function account(lean, read, full) {
  const items = keyed(read.elements), refOf = new Map(), byRef = new Map();
  for (const item of items) {
    const ref = lean.refOf.get(item.key) ?? `e${++lean.counter}`;
    refOf.set(item.key, ref); byRef.set(ref, item.element); item.ref = ref;
  }
  const last = lean.last, before = new Map(last?.items.map(i => [i.key, i]) ?? []), now = new Set(items.map(i => i.key));
  lean.refOf = refOf; lean.byRef = byRef; lean.last = { items, foreground: read.foreground };
  const listed = list => list.map(i => describe(i.ref, i.element));
  if (full || !last) return { elements: listed(shortList(items, fullLimit)), ...(items.length > fullLimit ? { more: items.length - fullLimit } : {}) };
  const appeared = items.filter(i => !before.has(i.key));
  const changed = items.filter(i => before.has(i.key) && (valueOf(before.get(i.key).element) !== valueOf(i.element) || stateOf(before.get(i.key).element).join() !== stateOf(i.element).join()));
  const vanished = last.items.filter(i => !now.has(i.key));
  return {
    diff: {
      appeared: listed(shortList(appeared, diffLimit)), ...(appeared.length > diffLimit ? { more_appeared: appeared.length - diffLimit } : {}),
      vanished: vanished.slice(0, goneLimit).map(i => ({ ref: lean.refOf.get(i.key) ?? null, role: roleOf(i.element), label: labelOf(i.element) })), ...(vanished.length > goneLimit ? { more_vanished: vanished.length - goneLimit } : {}),
      changed: listed(changed.slice(0, goneLimit)),
      unchanged: items.length - appeared.length - changed.length,
    },
  };
}

// The live screen of the device, when it has one: its packet clock and its screenshot service.
async function screenOf(ctx) {
  try { const target = await ctx.target(); return ctx.liveScreen?.(target); } catch { return undefined; }
}

// Waits for the screen to go quiet after the last action, by the phone's packet clock: at least
// quietMinMs, at most quietMaxMs. A clock that does not answer gets a fixed stalledClockMs.
async function quiet(screen, budget) {
  const started = performance.now();
  if (!screen?.waitSettled) { await pause(Math.min(stalledClockMs, budget)); return { wait_ms: Math.round(performance.now() - started), clock: 'none' }; }
  await pause(Math.min(quietMinMs, budget));
  const left = Math.min(quietMaxMs, budget) - (performance.now() - started);
  const settled = await within(left, () => screen.waitSettled({ timeoutMs: Math.max(50, Math.round(left)), maxWidth: 64 }), undefined);
  if (!settled) {
    const rest = Math.min(stalledClockMs, budget) - (performance.now() - started);
    if (rest > 0) await pause(rest);
    return { wait_ms: Math.round(performance.now() - started), clock: 'stalled' };
  }
  return { wait_ms: Math.round(performance.now() - started), clock: settled.settled ? 'quiet' : 'moving' };
}

// A small picture of the screen as it is now: the screenshot service on the held tunnel (or the newest
// decoded picture, when video decoding is on), otherwise an ordinary capture.
async function screenshot(ctx, screen, budget) {
  const started = performance.now();
  try {
    let jpeg;
    if (screen?.latestFrame) {
      const picture = await within(budget, () => screen.latestFrame({ maxWidth: shotWidth, waitMs: Math.min(1500, budget) }), undefined);
      if (!picture?.jpeg) throw new Error('the screenshot service did not answer in time');
      jpeg = picture.jpeg;
    } else {
      const frame = await within(budget, () => ctx.capture(), undefined);
      if (!frame) throw new Error('the capture did not answer in time');
      jpeg = await sharp(frame.data).resize({ width: shotWidth }).jpeg({ quality: 60 }).toBuffer();
    }
    if ((await sharp(jpeg).metadata()).width > shotWidth) jpeg = await sharp(jpeg).resize({ width: shotWidth }).jpeg({ quality: 60 }).toBuffer();
    return { jpeg, ms: Math.round(performance.now() - started), at: new Date().toISOString() };
  } catch (error) {
    if (cancelled()) throw error;
    return { error: errorText(error), ms: Math.round(performance.now() - started) };
  }
}

// One fresh tree read, capped. A read that began before the last action ended is redone once.
async function tree(ctx, budget, sinceMs) {
  const started = performance.now(), at = new Date().toISOString();
  try {
    const seen = await within(budget, () => ctx.structure(0), undefined);
    if (!seen) return { error: `the accessibility read took over ${Math.round(budget)} ms`, ms: Math.round(performance.now() - started), at };
    if (seen.startedAt !== undefined && seen.startedAt < sinceMs && budget - (performance.now() - started) > 300) return tree(ctx, budget - (performance.now() - started), sinceMs);
    if (!seen.elements?.length) return { error: 'the accessibility tree was empty', ms: Math.round(performance.now() - started), at, foreground: seen.foreground };
    return { elements: seen.elements, foreground: seen.foreground, ms: Math.round(performance.now() - started), at };
  } catch (error) {
    if (cancelled()) throw error;
    return { error: errorText(error), ms: Math.round(performance.now() - started), at };
  }
}

// Text read from the screenshot, in the shape of tree elements.
async function ocrOf(ctx, jpeg) {
  try {
    const world = await ctx.world(), meta = await sharp(jpeg).metadata();
    const size = ctx.size?.width ? ctx.size : { width: meta.width, height: meta.height };
    return await world.ocr({ image: jpeg, screenshot: true }, null, size);
  } catch (error) { if (cancelled()) throw error; return []; }
}

// The read every reply ends with: the tree and the screenshot side by side, OCR when the tree fails.
async function read(ctx, { full, image = true, sinceMs = performance.now(), budget }) {
  const lean = state(ctx), screen = await screenOf(ctx), cap = Math.min(readCapMs, budget);
  const [seen, shot] = await Promise.all([tree(ctx, cap, sinceMs), screenshot(ctx, screen, Math.max(cap, 1500))]);
  let source = 'accessibility', elements = seen.elements, ocrMs;
  if (!elements) {
    source = 'ocr';
    const started = performance.now();
    elements = shot?.jpeg ? await within(Math.max(500, budget - cap), () => ocrOf(ctx, shot.jpeg), []) : [];
    ocrMs = Math.round(performance.now() - started);
    elements = elements.map(e => ({ ...e, type: 'Text' }));
  }
  const listing = account(lean, { elements, foreground: seen.foreground }, full);
  const foreground = seen.foreground ? { bundle_id: seen.foreground.bundle_id ?? null, ...(seen.foreground.name ? { name: seen.foreground.name } : {}), ...(seen.foreground.pid ? { pid: seen.foreground.pid } : {}) } : null;
  const facts = {
    source, foreground, ...listing,
    read: { started_at: seen.at, ms: seen.ms, ...(seen.error ? { accessibility_error: seen.error } : {}), ...(ocrMs !== undefined ? { ocr_ms: ocrMs } : {}) },
    screenshot: shot?.jpeg ? { taken_at: shot.at, ms: shot.ms } : { error: shot?.error ?? 'not taken' },
  };
  return { facts, image: image && shot?.jpeg ? shot.jpeg : undefined };
}

// The pasteboard as it is, when it can be put back exactly: empty, or one plain text item.
async function savedClipboard(ctx) {
  try {
    const { items } = await ctx.bridge({ op: 'pasteboard', action: 'items' });
    if (!Array.isArray(items)) return undefined;
    if (!items.length) return { empty: true };
    if (items.some(i => i.state !== 'inline' || !/text|string/i.test(i.uti ?? ''))) return undefined;
    const { text } = await ctx.bridge({ op: 'pasteboard', action: 'get' });
    return typeof text === 'string' ? { text } : undefined;
  } catch (error) { if (cancelled()) throw error; return undefined; }
}
async function restoreClipboard(ctx, saved) {
  if (saved.empty) return 'was_empty';
  try {
    const { text } = await ctx.bridge({ op: 'pasteboard', action: 'get' });
    if (text === saved.text) return 'restored';
    await ctx.bridge({ op: 'pasteboard', action: 'set', text: saved.text });
    return 'restored';
  } catch (error) { if (cancelled()) throw error; return 'restore_failed'; }
}

// Text into the field being edited: hardware key presses for the whole string, and the pasteboard
// only when typing fails, with the user's clipboard saved first and put back after. A clipboard that
// cannot be read back exactly is never pasted over.
async function enter(ctx, text, { clear }) {
  const typed = await ctx.input({ op: 'type_keys', text, clear: Boolean(clear) });
  if (!typed?.isError && typed?.sent !== false) return { via: 'typed' };
  // Keys may have gone out before a failure: pasting then would enter the text twice, unless the
  // paste clears the field first or the bridge refused the request before sending anything.
  const refusedBeforeSending = /cannot type|unknown variant|at most 2000/i.test(String(typed?.error ?? ''));
  if (!clear && !refusedBeforeSending) return { via: 'none', error: `typing failed part way (${errorText(typed?.error ?? 'no answer')}); not pasted, so the text is not entered twice` };
  const saved = await savedClipboard(ctx);
  if (!saved) return { via: 'none', error: `typing failed (${errorText(typed?.error ?? 'no answer')}) and the clipboard cannot be saved, so it was not pasted over` };
  let pasted, restored;
  try { pasted = await ctx.input({ op: 'type_text', text, clear: Boolean(clear), submit: false }); }
  finally { restored = await restoreClipboard(ctx, saved); }
  if (pasted?.isError || pasted?.outcome === 'not_sent') return { via: 'none', error: `typing failed, and pasting failed: ${errorText(pasted?.error ?? pasted?.outcome)}`, clipboard: restored };
  return { via: 'pasted', clipboard: restored };
}

// AX set-value, when the bridge offers it; remembered per session when it does not.
async function setValue(ctx, element, text) {
  const lean = state(ctx);
  if (lean.setValue === false || !element.object_id) return false;
  try {
    const answer = await ctx.bridge({ op: 'ax_set_value', object_id: element.object_id, value: text });
    if (answer?.set === true) return true;
    return false;
  } catch (error) {
    if (cancelled()) throw error;
    if (/unknown variant|unknown op|No implementation/i.test(errorText(error))) lean.setValue = false;
    return false;
  }
}

// Gestures are named verbs with defaults: the model names a direction or a target, never a path.
// A point is a ref (its centre) or x, y in the same points as the frames in replies.
const pointOf = (lean, spec, name) => {
  if (spec && typeof spec === 'object' && spec.ref) {
    const e = lean.byRef.get(String(spec.ref).toLowerCase());
    if (!e) throw new Error(`${name}: ref ${spec.ref} is not in the latest read`);
    return centre(e);
  }
  if (spec && Number.isFinite(spec.x) && Number.isFinite(spec.y)) return { x: spec.x, y: spec.y };
  throw new Error(`${name} takes ref, or x and y`);
};
// The area a swipe moves: the element named by in, or the screen.
const areaOf = (lean, ref, size) => {
  if (!ref) return { x: 0, y: 0, width: size.width, height: size.height };
  const e = lean.byRef.get(String(ref).toLowerCase());
  if (!e) throw new Error(`in: ref ${ref} is not in the latest read`);
  return box(e);
};
// direction is where the finger moves; the content moves with it.
function swipePath(area, direction = 'up', distance = 'short') {
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
  if (!d) throw new Error('swipe direction is up, down, left or right');
  const half = (d[0] ? area.width : area.height) * (distance === 'long' ? 0.4 : 0.2);
  const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
  return { x1: cx - d[0] * half, y1: cy - d[1] * half, x2: cx + d[0] * half, y2: cy + d[1] * half };
}
const fingerFor = { down: 'up', up: 'down', right: 'left', left: 'right' };
const shows = (e, text) => [labelOf(e), valueOf(e)].some(v => typeof v === 'string' && v.toLocaleLowerCase().includes(text.toLocaleLowerCase()));
const onScreen = (e, size) => { const f = box(e); return f.y >= 0 && f.x >= 0 && f.y + f.height <= size.height && f.x + f.width <= size.width; };

// Swipes until the target is on screen, with a quick tree read after each swipe: one action for the
// model, however many swipes it takes. Stops at the end of the list (a swipe that changed nothing).
async function scrollTo(ctx, lean, a, budget) {
  const size = await ctx.screenSize(), area = areaOf(lean, a.in, size), until = performance.now() + budget;
  const target = a.ref ? lean.last?.items.find(i => i.ref === String(a.ref).toLowerCase()) : undefined;
  if (a.ref && !target) throw new Error(`scroll_to: ref ${a.ref} is not in the latest read`);
  const found = elements => {
    if (target) return keyed(elements).find(i => i.key === target.key && onScreen(i.element, size))?.element;
    return elements.filter(e => visible(e) && shows(e, a.text) && onScreen(e, size)).sort(readingOrder)[0];
  };
  if (!a.ref && typeof a.text !== 'string') throw new Error('scroll_to takes text or ref');
  let elements = lean.last?.items.map(i => i.element) ?? [], swipes = 0, last;
  const max = Math.min(12, a.max_swipes ?? 6);
  while (!found(elements) && swipes < max && until - performance.now() > 900) {
    await ctx.input({ op: 'drag', ...swipePath(area, fingerFor[a.direction ?? 'down'], 'long'), duration_ms: 250, hold_ms: 0, end_hold_ms: 100 });
    swipes++;
    await pause(250);
    const seen = await within(Math.min(1200, until - performance.now()), () => ctx.structure(0), undefined).catch(() => undefined);
    if (!seen?.elements?.length) continue;
    const key = JSON.stringify(seen.elements.map(e => [labelOf(e), box(e).y | 0]));
    if (key === last) return { swipes, found: false, end_of_list: true };
    last = key; elements = seen.elements;
  }
  const hit = found(elements);
  return { swipes, found: Boolean(hit), ...(hit ? { at: [box(hit).x, box(hit).y].map(Math.round) } : {}), ...(!hit && swipes >= max ? { gave_up_after: max } : {}) };
}

const verbs = new Set(['tap', 'fill', 'type', 'launch', 'button', 'swipe', 'scroll_to', 'long_press', 'drag', 'pinch', 'wait']);
const moves = new Set(['swipe', 'scroll_to', 'drag']);
// One action, as sent. Answers what was done, or throws with why it could not be.
async function perform(ctx, lean, action) {
  const kind = Object.keys(action).find(k => verbs.has(k));
  const a = action[kind] ?? action;
  const element = a.ref ? lean.byRef.get(String(a.ref).toLowerCase()) : undefined;
  const sent = answer => { if (answer?.isError) throw new Error(answer.error ?? answer.message ?? 'the device refused the input'); return answer; };
  switch (kind) {
    case 'tap': {
      const p = element ? centre(element) : { x: a.x, y: a.y };
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('tap takes ref, or x and y');
      sent(await ctx.input({ op: 'tap', x: p.x, y: p.y, duration_ms: 50 }));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    case 'fill': {
      if (typeof a.text !== 'string') throw new Error('fill takes ref and text');
      if (element && await setValue(ctx, element, a.text)) return { fill_via: 'set_value' };
      const p = element ? centre(element) : Number.isFinite(a.x) ? { x: a.x, y: a.y } : undefined;
      if (p && !element?.focused) { sent(await ctx.input({ op: 'tap', x: p.x, y: p.y, duration_ms: 50 })); await pause(250); }
      const entered = await enter(ctx, a.text, { clear: a.clear ?? true });
      if (entered.via === 'none') throw Object.assign(new Error(entered.error), { facts: { fill_via: 'none', ...(entered.clipboard ? { clipboard: entered.clipboard } : {}) } });
      return { fill_via: entered.via, ...(entered.clipboard ? { clipboard: entered.clipboard } : {}) };
    }
    case 'type': {
      if (typeof a.text !== 'string' || !a.text) throw new Error('type takes text');
      const entered = await enter(ctx, a.text, { clear: false });
      if (entered.via === 'none') throw Object.assign(new Error(entered.error), { facts: { type_via: 'none' } });
      return { type_via: entered.via, ...(entered.clipboard ? { clipboard: entered.clipboard } : {}) };
    }
    case 'launch': {
      const bundle = typeof a === 'string' ? a : a.bundle ?? a.bundle_id;
      if (!bundle) throw new Error('launch takes bundle');
      const answer = await ctx.dispatch('launch_app', { bundle_id: bundle });
      const text = answer.content?.find(b => b.type === 'text')?.text ?? '{}';
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
      if (answer.isError && !Number.isSafeInteger(parsed.pid)) throw new Error(parsed.error ?? parsed.message ?? 'launch failed');
      return { ...(parsed.pid ? { pid: parsed.pid } : {}), ...(answer.isError ? { note: errorText(parsed.error ?? parsed.message) } : {}) };
    }
    case 'button': {
      const button = typeof a === 'string' ? a : a.name ?? a.button;
      sent(await ctx.input({ op: 'button', button }));
      return { button };
    }
    case 'swipe': {
      const size = await ctx.screenSize(), path = swipePath(areaOf(lean, a.in, size), a.direction, a.distance);
      sent(await ctx.input({ op: 'drag', ...path, duration_ms: 300, hold_ms: 0 }));
      return { direction: a.direction ?? 'up', distance: a.distance ?? 'short' };
    }
    case 'scroll_to': return scrollTo(ctx, lean, a, action.budget ?? stepCapMs);
    case 'long_press': {
      const p = pointOf(lean, a, 'long_press'), ms = Math.min(5000, Math.max(100, a.ms ?? 600));
      sent(await ctx.input({ op: 'long_press', x: p.x, y: p.y, duration_ms: ms }));
      return { x: Math.round(p.x), y: Math.round(p.y), ms };
    }
    case 'drag': {
      const from = pointOf(lean, a.from, 'drag from'), to = pointOf(lean, a.to, 'drag to'), ms = Math.min(3000, Math.max(100, a.ms ?? 400));
      sent(await ctx.input({ op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration_ms: ms, hold_ms: 300 }));
      return { from: [from.x, from.y].map(Math.round), to: [to.x, to.y].map(Math.round), ms };
    }
    case 'pinch': {
      const p = pointOf(lean, a, 'pinch'), size = await ctx.screenSize(), scale = Math.min(4, Math.max(0.25, a.scale ?? 2));
      const start = Math.min(size.width, size.height) * (scale > 1 ? 0.12 : 0.3);
      sent(await ctx.input({ op: 'pinch', x: p.x, y: p.y, start_distance: start, end_distance: start * scale, duration_ms: 500 }));
      return { x: Math.round(p.x), y: Math.round(p.y), scale };
    }
    case 'wait': {
      const ms = Math.min(3000, Math.max(0, typeof a === 'number' ? a : a.ms ?? (a.seconds ?? 0.5) * 1000));
      await pause(ms);
      return { ms };
    }
    default: throw new Error(`unknown action ${JSON.stringify(Object.keys(action))}; use one of ${[...verbs].join(', ')}`);
  }
}

function reply(body, image) {
  const content = [{ type: 'text', text: JSON.stringify(body) }];
  if (image) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' });
  return { content };
}

// Every ref an action names: its own, in, and drag's from and to.
const refsIn = actions => actions.flatMap(action => Object.values(action).flatMap(v => v && typeof v === 'object' ? [v.ref, v.in, v.from?.ref, v.to?.ref] : []).filter(Boolean).map(ref => String(ref).toLowerCase()));

export async function step(ctx, args = {}) {
  const lean = state(ctx), started = performance.now(), budget = () => stepCapMs - (performance.now() - started);
  const actions = Array.isArray(args.actions) ? args.actions : [];
  // Refs come from the latest read only. One that is not in it is refused before anything is sent.
  const unknown = refsIn(actions).filter(ref => !lean.byRef.has(ref));
  if (unknown.length) {
    const { facts, image } = await read(ctx, { full: true, budget: budget() });
    return { isError: true, ...reply({ refused: `ref ${unknown.join(', ')} is not in the latest read; nothing was sent. Use the refs below.`, ...facts }, image) };
  }
  const saved = { inBatch: ctx.inBatch, batchStep: ctx.batchStep };
  ctx.inBatch = true; ctx.batchStep = { stopOnError: false };
  const done = [];
  let lastEnd = performance.now();
  try {
    for (const [index, action] of actions.entries()) {
      if (budget() < 500) { done.push({ i: index, skipped: 'step time cap reached' }); break; }
      const at = new Date().toISOString(), began = performance.now();
      try {
        const facts = await within(budget() - 400, () => perform(ctx, lean, action.scroll_to ? { ...action, budget: budget() - readCapMs } : action), { timed_out: true });
        if (facts?.timed_out) throw new Error('the action did not answer within the step time cap');
        done.push({ i: index, action, ok: true, at, ms: Math.round(performance.now() - began), ...facts });
      } catch (error) {
        if (cancelled()) throw error;
        done.push({ i: index, action, ok: false, at, ms: Math.round(performance.now() - began), error: errorText(error), ...(error.facts ?? {}) });
        lastEnd = performance.now();
        break;
      }
      lastEnd = performance.now();
    }
  } finally { ctx.inBatch = saved.inBatch; ctx.batchStep = saved.batchStep; }
  const screen = await screenOf(ctx);
  const waited = actions.length ? await quiet(screen, Math.max(0, budget() - readCapMs)) : { wait_ms: 0 };
  const before = lean.last?.items.map(i => i.element);
  const { facts, image } = await read(ctx, { full: args.full, sinceMs: lastEnd, budget: Math.max(500, budget()) });
  const failed = done.find(d => d.ok === false);
  // What a gesture moved, from the reads on either side of the step (a list and how far it went).
  const moved = before?.length && facts.source === 'accessibility' && actions.some(action => Object.keys(action).some(k => moves.has(k))) ? whatMoved(before, lean.last.items.map(i => i.element)) : undefined;
  return reply({ actions: done, ...(failed ? { failed_action: failed.i } : {}), ...waited, ...(moved ? { moved } : {}), ...facts, step_ms: Math.round(performance.now() - started) }, image);
}

export async function look(ctx, args = {}) {
  const started = performance.now();
  const { facts, image } = await read(ctx, { full: args.full, image: Boolean(args.image), budget: stepCapMs });
  return reply({ ...facts, look_ms: Math.round(performance.now() - started) }, image);
}

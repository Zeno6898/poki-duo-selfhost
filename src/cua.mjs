// The computer-use profile (POKI_TOOL_PROFILE=cua). Fork-only (poki-remote).
//
// Modeled on how desktop computer-use tools work: one call does some actions and then reads the
// screen once. The answer is facts only: the numbered elements of that one read (marked new when
// they were not in the previous read), the app in front, timings, and a screenshot as visual
// confirmation. There is no verdict, no expectation engine and no live video; the model looks at
// the facts and decides what happened. Refs are numbers from the latest read and are replaced by
// the next one.
//
//   look {full?}            read the screen now
//   do {actions: [...]}     run actions in order, then read the screen
//
// An action is one of
//   {tap: ref} | {tap: [x, y]}                 touch an element's centre, or a point in screen points
//   {type: "text", ref?, clear?}               tap ref first if given, then type the whole text as key
//                                              presses; text a keyboard cannot type is pasted, with the
//                                              clipboard saved and put back (never over one that can't be)
//   {key: "return" | "delete" | ...}           one key
//   {swipe: "up"} | {swipe: {direction, in?: n, distance?: "short" | "long"}}   direction is the finger's
//   {scroll_to: "text"} | {scroll_to: {text | ref, in?, direction?, max_swipes?: 6}}   swipes until it is on screen
//   {long_press: n | [x, y] | {ref | x, y, ms?: 600}}
//   {drag: {from: n | [x, y], to: n | [x, y], ms?: 400}} | {drag: [x1, y1, x2, y2]}   in screen points
//   {pinch: {ref | x, y, scale}}
//   {button: "home" | "lock"}                  a hardware button
//   {launch: "bundle id"}                      bring an app to the front
//   {wait: ms}                                 pause
// When accessibility returns nothing, the elements come from OCR of the screenshot, in the same shape.
// Each action is reported as sent, not_sent or unknown (it may have been delivered); an unknown one is
// never sent again by us, and nothing after a failed action is sent. Element numbers not in the latest
// read are refused before anything is sent. Actions and the wait after them get at most
// POKI_CUA_ACTION_CAP_MS (4000). A locked or dark phone, or Poki's own app in front, stops dispatching.
import sharp from 'sharp';
import { pause, stopped } from './work.mjs';

const settleAfterMs = { tap: 450, type: 250, key: 300, swipe: 600, drag: 600, button: 700, launch: 900, wait: 0 };
const imageWidth = 300, lineLimit = 120;
// A read waits this long for accessibility; after that the screenshot's OCR answers instead, so a
// silent accessibility service costs seconds, not tens of seconds.
const treeWaitMs = Number(process.env.POKI_CUA_TREE_MS) || 2500;

const roleName = element => String(element.type ?? element.role ?? 'Text').replace(/^XCUIElementType/, '');
const labelOf = element => [element.label ?? element.text, element.value].filter(value => value !== undefined && value !== null && value !== '').map(String).join(' = ');
const box = element => element.frame ?? element;
const keyOf = element => `${roleName(element)}|${labelOf(element)}`;

function state(ctx) {
  ctx.cua ??= { refs: new Map(), previous: new Set() };
  return ctx.cua;
}

// Elements worth listing: on screen, not the application root, with something to say.
function listable(elements, size) {
  return elements.filter(element => {
    if ((element.depth === 0 && roleName(element) === 'Application') || !labelOf(element)) return false;
    const f = box(element);
    return f.width > 0 && f.height > 0 && f.x + f.width > 0 && f.y + f.height > 0 && f.x < size.width && f.y < size.height;
  });
}

// One read of the screen: a screenshot, then the accessibility tree; OCR of that
// screenshot when the tree is empty or fails.
async function read(ctx) {
  const started = performance.now();
  // The screenshot first: the bridge serves one device op at a time, and a slow accessibility read
  // must not hold the picture back.
  const [frameResult] = await Promise.allSettled([ctx.capture()]);
  const tree = ctx.bridge({ op: 'ax', include_offscreen: false });
  tree.catch(() => {});
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error(`accessibility did not answer within ${treeWaitMs} ms`)), treeWaitMs).unref?.());
  const [treeResult] = await Promise.allSettled([Promise.race([tree, late])]);
  if (frameResult.status === 'rejected') throw frameResult.reason;
  const frame = frameResult.value;
  let elements = [], source = 'accessibility', foreground, note;
  // A dark, uniform picture is a locked or sleeping display: say so instead of reading it.
  const { channels } = await sharp(frame.data).stats();
  const dark = channels.slice(0, 3).every(c => c.mean < 12 && c.stdev < 6);
  if (dark && !(treeResult.status === 'fulfilled' && treeResult.value.elements?.length)) {
    return { frame, elements: [], source: 'none', note: 'screen: dark (the phone is locked or its display is off)', ms: Math.round(performance.now() - started) };
  }
  if (treeResult.status === 'fulfilled' && treeResult.value.elements?.length) {
    elements = treeResult.value.elements; foreground = treeResult.value.foreground;
  } else {
    if (treeResult.status === 'rejected' && stopped(treeResult.reason)) throw treeResult.reason;
    note = treeResult.status === 'rejected' ? treeResult.reason.message : 'accessibility returned no elements';
    try { elements = await ctx.ocr(frame); source = 'ocr'; }
    catch (error) { if (stopped(error)) throw error; note += `; OCR failed too: ${error.message}`; source = 'none'; }
  }
  return { frame, elements: listable(elements, frame), source, foreground, note, ms: Math.round(performance.now() - started) };
}

async function reply(ctx, seen, { full = false, actions = [], error } = {}) {
  const memory = state(ctx);
  memory.refs = new Map();
  const keysNow = new Set();
  const lines = seen.elements.map((element, index) => {
    const ref = index + 1, key = keyOf(element), f = box(element);
    memory.refs.set(ref, element); keysNow.add(key);
    const isNew = memory.previous.size > 0 && !memory.previous.has(key);
    return { isNew, text: `${isNew ? '+' : ' '}${ref} ${roleName(element)} "${labelOf(element)}" [${[f.x, f.y, f.width, f.height].map(Math.round).join(',')}]` };
  });
  const gone = [...memory.previous].filter(key => !keysNow.has(key)).slice(0, 20).map(key => key.replace('|', ' "') + '"');
  const fresh = memory.previous.size === 0;
  memory.previous = keysNow;
  const shown = full || fresh ? lines : lines.filter((line, index) => line.isNew || index < lineLimit);
  const app = seen.foreground ? (seen.foreground.name ?? seen.foreground.bundle_id ?? `pid ${seen.foreground.pid}`) : 'unknown';
  const header = [
    `app: ${app}   read: ${new Date().toISOString()} (${seen.ms} ms, ${seen.source})${seen.note ? `   note: ${seen.note}` : ''}`,
    ...actions.map(a => `did: ${a}`),
    ...(error ? [`error: ${error}`] : []),
    fresh ? `elements (${lines.length}):` : `elements (${lines.length}; + = new since the last read):`,
  ];
  const footer = gone.length ? [`gone since the last read: ${gone.join(', ')}`] : [];
  const image = await sharp(seen.frame.data).resize({ width: imageWidth }).jpeg({ quality: 60 }).toBuffer();
  return { content: [
    { type: 'text', text: [...header, ...shown.slice(0, full ? 1000 : lineLimit).map(l => l.text), ...footer].join('\n') },
    { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
  ] };
}

const centre = element => { const f = box(element); return { x: f.x + f.width / 2, y: f.y + f.height / 2 }; };
// The device time one do call may spend on its actions and the wait after them; the read has its own cap.
const actionCapMs = Number(process.env.POKI_CUA_ACTION_CAP_MS) || 4000;
const quietMinMs = 150, quietMaxMs = 1500, stalledClockMs = 400;

class NotSent extends Error {}
function elementOf(ctx, ref) {
  const element = state(ctx).refs.get(Number(ref));
  if (!element) throw new NotSent(`No element ${ref} in the latest read; use a number from the last list.`);
  return element;
}
function pointOf(ctx, target) {
  if (Array.isArray(target)) return { x: Number(target[0]), y: Number(target[1]) };
  if (target && typeof target === 'object') return target.ref !== undefined ? centre(elementOf(ctx, target.ref)) : { x: Number(target.x), y: Number(target.y) };
  return centre(elementOf(ctx, target));
}
// Every element number an action names, so a stale one is refused before anything is sent.
function refsIn(action) {
  const refs = [];
  const add = value => { if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) refs.push(Number(value)); else if (value && typeof value === 'object' && !Array.isArray(value) && value.ref !== undefined) refs.push(Number(value.ref)); };
  for (const key of ['tap', 'long_press', 'pinch']) if (key in action) add(action[key]);
  if (action.ref !== undefined) add(action.ref);
  if (action.in !== undefined) add(action.in);
  if (action.drag && !Array.isArray(action.drag)) { add(action.drag.from); add(action.drag.to); }
  if (action.scroll_to && typeof action.scroll_to === 'object' && action.scroll_to.ref !== undefined) add(action.scroll_to.ref);
  return refs;
}

// One input to the device, and what is known about its delivery: sent, not_sent (refused before
// anything reached the phone) or unknown (it may have been delivered).
async function send(ctx, request) {
  const answer = await ctx.input(request);
  if (!answer?.isError && answer?.sent !== false && answer?.outcome !== 'not_sent') return answer;
  const why = answer?.error ?? answer?.message ?? answer?.outcome ?? 'the device refused the input';
  const failure = new Error(why);
  failure.delivery = answer?.outcome === 'unknown' ? 'unknown' : 'not_sent';
  throw failure;
}

// The pasteboard as it is, when it can be put back exactly: empty, or one plain text item.
async function savedClipboard(ctx) {
  try {
    const { items } = await ctx.bridge({ op: 'pasteboard', action: 'items' });
    if (!Array.isArray(items)) return undefined;
    if (!items.length) return { empty: true };
    if (items.length !== 1 || items[0].state !== 'inline' || !/text|string/i.test(items[0].uti ?? '')) return undefined;
    const { text } = await ctx.bridge({ op: 'pasteboard', action: 'get' });
    return typeof text === 'string' ? { text } : undefined;
  } catch (error) { if (stopped(error)) throw error; return undefined; }
}
async function restoreClipboard(ctx, saved) {
  if (saved.empty) return 'was empty';
  try {
    const { text } = await ctx.bridge({ op: 'pasteboard', action: 'get' });
    if (text !== saved.text) await ctx.bridge({ op: 'pasteboard', action: 'set', text: saved.text });
    return 'restored';
  } catch (error) { if (stopped(error)) throw error; return 'restore failed'; }
}

// Text into the field being edited: the whole string as hardware key presses in one request; the
// pasteboard only when the keyboard cannot type it, with the user's clipboard saved first and put
// back afterwards. A clipboard that cannot be read back exactly is never pasted over.
async function typeText(ctx, text, clear = false) {
  const typed = await ctx.input({ op: 'type_keys', text, clear });
  if (!typed?.isError && typed?.sent !== false) return 'keys';
  // Only a request the bridge refused before sending (a character with no key, an older bridge) may
  // be pasted instead: after a failure part way, a paste would enter the text twice.
  const refused = /cannot type|unknown variant|at most 2000/i.test(String(typed?.error ?? ''));
  if (!refused && !clear) { const e = new Error(`typing failed part way (${typed?.error ?? 'no answer'}); not pasted, so the text is not entered twice`); e.delivery = 'unknown'; throw e; }
  const saved = await savedClipboard(ctx);
  if (!saved) { const e = new Error('the keyboard cannot type this text, and the clipboard cannot be saved and put back, so it was not pasted over'); e.delivery = refused ? 'not_sent' : 'unknown'; throw e; }
  let restored;
  try { await send(ctx, { op: 'type_text', text, clear, submit: false }); }
  finally { restored = await restoreClipboard(ctx, saved); }
  return `pasted, clipboard ${restored}`;
}

// Gestures are named verbs with defaults: the model names a direction or a target, never a path.
// The area a swipe moves is the element named by in, or the screen. direction is where the finger goes.
function areaOf(ctx, ref, size) { return ref === undefined ? { x: 0, y: 0, width: size.width, height: size.height } : box(elementOf(ctx, ref)); }
function swipePath(area, direction, distance = 'long') {
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
  if (!d) throw new NotSent('swipe must be up, down, left or right');
  const half = (d[0] ? area.width : area.height) * (distance === 'short' ? 0.2 : 0.35);
  const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
  return { x1: cx - d[0] * half, y1: cy - d[1] * half, x2: cx + d[0] * half, y2: cy + d[1] * half };
}
const finger = { down: 'up', up: 'down', right: 'left', left: 'right' };
const onScreen = (e, size) => { const f = box(e); return f.x >= 0 && f.y >= 0 && f.x + f.width <= size.width && f.y + f.height <= size.height; };
const shows = (e, text) => labelOf(e).toLocaleLowerCase().includes(text.toLocaleLowerCase());

// Swipes until the target is fully on screen, with a quick tree read after each swipe: one action
// for the model however many swipes it takes. Stops at the end of the list, at max_swipes, or when
// the action time runs out.
async function scrollTo(ctx, spec, size, until) {
  const target = typeof spec === 'string' ? { text: spec } : spec;
  const wanted = target.ref !== undefined ? keyOf(elementOf(ctx, target.ref)) : undefined;
  if (!wanted && typeof target.text !== 'string') throw new NotSent('scroll_to takes text or ref');
  const area = areaOf(ctx, target.in, size), max = Math.min(12, target.max_swipes ?? 6);
  const hit = elements => elements.find(e => (wanted ? keyOf(e) === wanted : shows(e, target.text)) && onScreen(e, size));
  let elements = [...state(ctx).refs.values()], swipes = 0, last;
  while (!hit(elements) && swipes < max && until - performance.now() > 900) {
    await send(ctx, { op: 'drag', ...swipePath(area, finger[target.direction ?? 'down']), duration_ms: 250, hold_ms: 0, end_hold_ms: 100 });
    swipes++;
    await pause(250);
    let seen;
    try { seen = await Promise.race([ctx.bridge({ op: 'ax', include_offscreen: false }), new Promise(done => setTimeout(done, Math.max(200, Math.min(1200, until - performance.now()))))]); }
    catch (error) { if (stopped(error)) throw error; }
    if (!seen?.elements?.length) continue;
    const key = seen.elements.map(e => `${keyOf(e)}@${Math.round(box(e).y)}`).join(';');
    if (key === last) return `${swipes} swipes, not found: the list stopped moving`;
    last = key; elements = seen.elements;
  }
  const found = hit(elements);
  return found ? `${swipes} swipes, found at [${[box(found).x, box(found).y].map(Math.round).join(',')}]` : `${swipes} swipes, not found${swipes >= max ? ` within ${max} swipes` : ''}`;
}

async function perform(ctx, action, size, until) {
  if ('tap' in action) { const p = pointOf(ctx, action.tap); await send(ctx, { op: 'tap', x: p.x, y: p.y, duration_ms: 50 }); return ['tap', `tap ${JSON.stringify(action.tap)}`]; }
  if ('type' in action) {
    if (action.ref !== undefined) { const p = pointOf(ctx, action.ref); await send(ctx, { op: 'tap', x: p.x, y: p.y, duration_ms: 50 }); await pause(250); }
    const how = await typeText(ctx, String(action.type), Boolean(action.clear));
    return ['type', `type ${JSON.stringify(action.type)} (${how})`];
  }
  if ('key' in action) { await send(ctx, { op: 'key', key: String(action.key) }); return ['key', `key ${action.key}`]; }
  if ('swipe' in action) {
    const spec = typeof action.swipe === 'string' ? { direction: action.swipe } : action.swipe ?? {};
    const path = swipePath(areaOf(ctx, spec.in ?? action.in, size), spec.direction, spec.distance);
    await send(ctx, { op: 'drag', ...path, duration_ms: 300 }); return ['swipe', `swipe ${spec.direction}${spec.in ?? action.in ? ` in ${spec.in ?? action.in}` : ''}`];
  }
  if ('scroll_to' in action) return ['scroll_to', `scroll_to ${JSON.stringify(action.scroll_to)}: ${await scrollTo(ctx, action.scroll_to, size, until)}`];
  if ('long_press' in action) {
    const spec = action.long_press, p = pointOf(ctx, spec), ms = Math.min(5000, Math.max(100, spec?.ms ?? action.ms ?? 600));
    await send(ctx, { op: 'long_press', x: p.x, y: p.y, duration_ms: ms }); return ['long_press', `long_press ${JSON.stringify(spec)} ${ms} ms`];
  }
  if ('drag' in action) {
    const spec = action.drag;
    const [from, to] = Array.isArray(spec) ? [{ x: spec[0], y: spec[1] }, { x: spec[2], y: spec[3] }] : [pointOf(ctx, spec.from), pointOf(ctx, spec.to)];
    const ms = Math.min(3000, Math.max(100, spec.ms ?? 400));
    await send(ctx, { op: 'drag', x1: Number(from.x), y1: Number(from.y), x2: Number(to.x), y2: Number(to.y), duration_ms: ms, hold_ms: Array.isArray(spec) ? 0 : 300 });
    return ['drag', `drag ${JSON.stringify(spec)}`];
  }
  if ('pinch' in action) {
    const spec = action.pinch, p = pointOf(ctx, spec), scale = Math.min(4, Math.max(0.25, Number(spec?.scale ?? action.scale ?? 2)));
    const start = Math.min(size.width, size.height) * (scale > 1 ? 0.12 : 0.3);
    await send(ctx, { op: 'pinch', x: p.x, y: p.y, start_distance: start, end_distance: start * scale, duration_ms: 500 }); return ['pinch', `pinch ${JSON.stringify(spec)} x${scale}`];
  }
  if ('button' in action) { await send(ctx, { op: 'button', button: String(action.button) }); return ['button', `button ${action.button}`]; }
  if ('launch' in action) { await ctx.bridge({ op: 'launch_app', bundle_id: String(action.launch) }); return ['launch', `launch ${action.launch}`]; }
  if ('wait' in action) { await pause(Math.min(Number(action.wait) || 0, 3000)); return ['wait', `wait ${action.wait} ms`]; }
  throw new NotSent(`Unknown action ${JSON.stringify(action)}`);
}

// After the last action: until the phone's packet clock goes quiet (at least quietMinMs, at most
// quietMaxMs, a fixed stalledClockMs when the clock does not answer), or a fixed pause per action
// kind without a live screen.
async function quiet(ctx, kind, budget) {
  const started = performance.now();
  let screen;
  try { screen = ctx.liveScreen?.(await ctx.target()); } catch (error) { if (stopped(error)) throw error; }
  if (!screen?.waitSettled) { await pause(Math.min(budget, settleAfterMs[kind] ?? 400)); return `${Math.round(performance.now() - started)} ms (fixed)`; }
  await pause(Math.min(quietMinMs, budget));
  const left = Math.min(quietMaxMs, budget) - (performance.now() - started);
  let settled;
  try { settled = await Promise.race([screen.waitSettled({ timeoutMs: Math.max(50, Math.round(left)), maxWidth: 64 }), new Promise(done => setTimeout(done, left + 200))]); }
  catch (error) { if (stopped(error)) throw error; }
  if (!settled) { const rest = Math.min(stalledClockMs, budget) - (performance.now() - started); if (rest > 0) await pause(rest); return `${Math.round(performance.now() - started)} ms (packet clock silent)`; }
  return `${Math.round(performance.now() - started)} ms (${settled.settled ? 'quiet' : 'still moving'})`;
}

// What stops dispatching: a phone that is locked or dark, or Poki's own app in front.
function holdReason(memory) {
  if (memory.lastNote && /dark|locked/i.test(memory.lastNote)) return 'the phone is locked or its display is off; unlock it';
  if (/poki/i.test(memory.lastForeground?.bundle_id ?? '')) return "Poki's own app is in front";
  return undefined;
}

async function readAndReply(ctx, options) {
  const memory = state(ctx);
  let seen;
  try { seen = await read(ctx); }
  catch (error) {
    if (stopped(error)) throw error;
    // No read: what was sent is reported, with each sent action's result unknown, and nothing else.
    const actions = (options.actions ?? []).map(line => line.replace(/\(sent,/, '(unknown: no read after it,'));
    return { isError: true, content: [{ type: 'text', text: [`read: failed: ${error.message}`, ...actions.map(a => `did: ${a}`), ...(options.error ? [`error: ${options.error}`] : [])].join('\n') }] };
  }
  memory.lastNote = seen.note; memory.lastForeground = seen.foreground;
  return reply(ctx, seen, options);
}

export async function look(ctx, args = {}) {
  return readAndReply(ctx, { full: args.full });
}

export async function act(ctx, args = {}) {
  const memory = state(ctx), actions = args.actions ?? [], done = [];
  // A number that is not in the latest read is refused before anything is sent, with the list now.
  const stale = actions.flatMap(refsIn).filter(ref => !memory.refs.has(ref));
  if (stale.length) return { isError: true, ...await readAndReply(ctx, { full: true, error: `element ${[...new Set(stale)].join(', ')} is not in the latest read; nothing was sent. The current elements are below.` }) };
  let error, last;
  const started = performance.now(), until = started + actionCapMs;
  const size = ctx.size ?? await ctx.screenSize();
  for (const [index, action] of actions.entries()) {
    const held = holdReason(memory);
    if (held) { error = `stopped before action ${index + 1}: ${held}; nothing more was sent`; break; }
    if (until - performance.now() < 300) { error = `stopped before action ${index + 1}: the ${actionCapMs} ms action time ran out; nothing more was sent`; break; }
    const began = performance.now();
    try {
      const [kind, text] = await perform(ctx, action, size, until);
      last = kind;
      done.push(`${text} (sent, ${Math.round(performance.now() - began)} ms)`);
    } catch (e) {
      if (stopped(e)) throw e;
      const delivery = e instanceof NotSent ? 'not_sent' : e.delivery ?? 'unknown';
      done.push(`${JSON.stringify(action)} (${delivery}, ${Math.round(performance.now() - began)} ms)`);
      // An action that may have been delivered is never sent again by us, and nothing after it is sent.
      error = `action ${index + 1} ${delivery === 'unknown' ? 'may have been delivered' : 'was not sent'}: ${e.message}${index + 1 < actions.length ? '; the actions after it were not sent' : ''}`;
      break;
    }
  }
  if (last) done.push(`waited ${await quiet(ctx, last, Math.max(0, until - performance.now()))}`);
  return { ...(error ? { isError: true } : {}), ...await readAndReply(ctx, { full: args.full, actions: done, error }) };
}

export const definitions = [
  ['look', 'Read the screen now: the app in front, the numbered elements (role, label = value, [x,y,w,h] in screen points; + marks elements new since the last read), and a screenshot. full=true lists every element. Numbers refer to this read only.', { type: 'object', properties: { full: { type: 'boolean' } }, additionalProperties: false }, true],
  ['do', 'Run actions in order, then read the screen once and return the same facts as look, with a screenshot. Actions: {tap: n} or {tap: [x, y]}; {type: "text", ref?: n, clear?} (taps n first, then types the text as key presses; text the keyboard cannot type is pasted with your clipboard saved and put back); {key: "return"|"delete"|...}; {swipe: "up"|"down"|"left"|"right"} or {swipe: {direction, in?: n, distance?: "short"|"long"}} (direction is where the finger moves); {scroll_to: "text"} or {scroll_to: {text or ref, in?: n, direction?: "down", max_swipes?: 6}} (swipes until it is fully on screen); {long_press: n or [x, y] or {ref, ms?}}; {drag: {from: n or [x, y], to: n or [x, y], ms?}}; {pinch: {ref or x, y, scale}}; {button: "home"|"lock"}; {launch: "bundle id"}; {wait: ms}. Points are in the same screen points as the element frames. Each action is reported as sent, not_sent or unknown; it stops at the first action that fails and never re-sends one that may have been delivered. Several known steps can go in one call; you judge the result from the elements and the screenshot.', { type: 'object', properties: { actions: { type: 'array', items: { type: 'object' }, minItems: 0, maxItems: 20 }, full: { type: 'boolean' } }, required: ['actions'], additionalProperties: false }, false],
];
export const tools = new Set(['look', 'do', 'list_apps', 'list_devices', 'select_device', 'poki_mcp_status']);
export const instructions = 'look reads the screen; do runs actions and then reads it. Both return the numbered elements and a screenshot. Use the numbers from the latest answer. Decide what happened from the elements and the picture.';

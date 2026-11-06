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
//   {type: "text", ref?}                       tap ref first if given, then type with key presses;
//                                              text a keyboard cannot type is pasted instead
//   {key: "return" | "delete" | ...}           one key
//   {swipe: "up" | "down" | "left" | "right"}  a page swipe through the middle of the screen
//   {drag: [x1, y1, x2, y2]}                   in screen points
//   {button: "home" | "lock"}                  a hardware button
//   {launch: "bundle id"}                      bring an app to the front
//   {wait: ms}                                 pause
// When accessibility returns nothing, the elements come from OCR of the screenshot, in the same shape.
import sharp from 'sharp';
import { pause, stopped } from './work.mjs';

const settleAfterMs = { tap: 450, type: 250, key: 300, swipe: 600, drag: 600, button: 700, launch: 900, wait: 0 };
const imageWidth = 300, lineLimit = 120;
// A read waits this long for accessibility; after that the screenshot's OCR answers instead, so a
// silent accessibility service costs seconds, not tens of seconds.
const treeWaitMs = Number(process.env.POKI_CUA_TREE_MS) || 2500;
const keys = new Set('abcdefghijklmnopqrstuvwxyz0123456789'.split(''));

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
function pointOf(ctx, target) {
  if (Array.isArray(target)) return { x: Number(target[0]), y: Number(target[1]) };
  const element = state(ctx).refs.get(Number(target));
  if (!element) throw new Error(`No element ${target} in the latest read; use a number from the last list.`);
  return centre(element);
}

async function typeText(ctx, text) {
  // Direct key presses first; the pasteboard only when a character has no key here.
  if ([...text].every(ch => keys.has(ch.toLowerCase()) || ch === ' ')) {
    for (const ch of text) {
      if (ch === ' ') await ctx.input({ op: 'key', key: 'space' });
      else await ctx.input({ op: 'key', key: ch.toLowerCase(), modifiers: ch !== ch.toLowerCase() ? ['shift'] : [] });
    }
    return 'keys';
  }
  await ctx.input({ op: 'type_text', text, clear: false, submit: false });
  return 'paste';
}

async function perform(ctx, action, size) {
  if ('tap' in action) { const p = pointOf(ctx, action.tap); await ctx.input({ op: 'tap', x: p.x, y: p.y, duration_ms: 50 }); return ['tap', `tap ${JSON.stringify(action.tap)}`]; }
  if ('type' in action) {
    if (action.ref !== undefined) { const p = pointOf(ctx, action.ref); await ctx.input({ op: 'tap', x: p.x, y: p.y, duration_ms: 50 }); await pause(250); }
    const how = await typeText(ctx, String(action.type));
    return ['type', `type ${JSON.stringify(action.type)} (${how})`];
  }
  if ('key' in action) { await ctx.input({ op: 'key', key: String(action.key) }); return ['key', `key ${action.key}`]; }
  if ('swipe' in action) {
    const { width: w, height: h } = size, cx = w / 2, cy = h / 2;
    const vectors = { up: [cx, h * 0.75, cx, h * 0.3], down: [cx, h * 0.3, cx, h * 0.75], left: [w * 0.85, cy, w * 0.15, cy], right: [w * 0.15, cy, w * 0.85, cy] };
    const v = vectors[action.swipe]; if (!v) throw new Error(`swipe must be up, down, left or right`);
    await ctx.input({ op: 'drag', x1: v[0], y1: v[1], x2: v[2], y2: v[3], duration_ms: 300 }); return ['swipe', `swipe ${action.swipe}`];
  }
  if ('drag' in action) { const [x1, y1, x2, y2] = action.drag.map(Number); await ctx.input({ op: 'drag', x1, y1, x2, y2, duration_ms: 400 }); return ['drag', `drag ${action.drag.join(',')}`]; }
  if ('button' in action) { await ctx.input({ op: 'button', button: String(action.button) }); return ['button', `button ${action.button}`]; }
  if ('launch' in action) { await ctx.bridge({ op: 'launch_app', bundle_id: String(action.launch) }); return ['launch', `launch ${action.launch}`]; }
  if ('wait' in action) { await pause(Math.min(Number(action.wait) || 0, 10000)); return ['wait', `wait ${action.wait} ms`]; }
  throw new Error(`Unknown action ${JSON.stringify(action)}`);
}

export async function look(ctx, args = {}) {
  return reply(ctx, await read(ctx), { full: args.full });
}

export async function act(ctx, args = {}) {
  const done = [];
  let error, last;
  const size = ctx.size ?? await ctx.screenSize();
  for (const action of args.actions ?? []) {
    const started = performance.now();
    try {
      const [kind, text] = await perform(ctx, action, size);
      last = kind;
      done.push(`${text} (${Math.round(performance.now() - started)} ms)`);
    } catch (e) {
      if (stopped(e)) throw e;
      error = `${JSON.stringify(action)}: ${e.message}`;
      break;
    }
  }
  if (last) await pause(settleAfterMs[last] ?? 400);
  return reply(ctx, await read(ctx), { full: args.full, actions: done, error });
}

export const definitions = [
  ['look', 'Read the screen now: the app in front, the numbered elements (role, label = value, [x,y,w,h] in screen points; + marks elements new since the last read), and a screenshot. full=true lists every element. Numbers refer to this read only.', { type: 'object', properties: { full: { type: 'boolean' } }, additionalProperties: false }, true],
  ['do', 'Run actions in order, then read the screen once and return the same facts as look, with a screenshot. Actions: {tap: n} or {tap: [x, y]}; {type: "text", ref?: n} (taps n first, then types with key presses, pasting only text the keyboard cannot type); {key: "return"|"delete"|...}; {swipe: "up"|"down"|"left"|"right"}; {drag: [x1, y1, x2, y2]}; {button: "home"|"lock"}; {launch: "bundle id"}; {wait: ms}. It stops at the first action that fails and says why. Several known steps can go in one call; you judge the result from the elements and the screenshot.', { type: 'object', properties: { actions: { type: 'array', items: { type: 'object' }, minItems: 0, maxItems: 20 }, full: { type: 'boolean' } }, required: ['actions'], additionalProperties: false }, false],
];
export const tools = new Set(['look', 'do', 'list_apps', 'list_devices', 'select_device', 'poki_mcp_status']);
export const instructions = 'look reads the screen; do runs actions and then reads it. Both return the numbered elements and a screenshot. Use the numbers from the latest answer. Decide what happened from the elements and the picture.';

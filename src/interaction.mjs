import { readFileSync } from 'node:fs';
import { askHuman } from './human.mjs';
import { screenIdentity } from './screen-identity.mjs';

const behavior = JSON.parse(readFileSync(new URL('./data/interaction.json', import.meta.url), 'utf8'));
import { pause, deadline, checkWork, stopped, remaining } from './work.mjs';
export { pause } from './work.mjs';
export const justReadMs = 500;
const patienceMs = 5000, ocrAfterMs = 1000, ocrEveryMs = 2000, pollMs = 100, quietMs = 3000, stableWithinMs = 2500, focusWithinMs = 2000, screenTextLimit = 80;
const strings = e => [e.label, e.text, e.value, e.identifier, e.placeholder].filter(v => typeof v === 'string');
const normalize = v => v.normalize('NFKC').toLocaleLowerCase().trim();
const visible = e => e.visible !== false && e.visible !== 0;
const alertText = v => v.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim().replace(/’/g, "'");

export function promptWarning(elements) {
  const texts = elements.flatMap(strings).map(t => t.toLocaleLowerCase().trim());
  const rule = behavior.prompt_detector.find(rule => texts.some(t => rule.exact.includes(t) || rule.contains.some(part => t.includes(part))));
  return rule ? { kind: rule.name } : null;
}

export function matching(elements, value, exact = false) {
  const needle = normalize(value);
  if (!needle) throw new Error('Text must not be empty.');
  // A phone lists the application itself first, covering the whole screen and named after the app.
  elements = elements.filter(e => visible(e) && (e.type ?? e.role) !== 'Application');
  const full = elements.filter(e => strings(e).some(s => normalize(s) === needle));
  return full.length || exact ? full : elements.filter(e => strings(e).some(s => normalize(s).includes(needle)));
}

const center = element => { const box = element.frame ?? element; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
const place = element => { const box = element.frame ?? element; return [box.x, box.y, box.width, box.height].join(); };
const covers = (element, { x, y }) => { const box = element.frame ?? element; return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height; };
const isTextInput = element => /^(?:AX|XCUIElementType)?(?:Secure)?(?:TextField|TextArea|TextView|SearchField)$/i.test(element.type ?? element.role ?? '');

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export function closestTo(value, candidates) {
  const needle = normalize(value);
  return [...new Set(candidates)]
    .map(candidate => ({ candidate, distance: editDistance(needle, normalize(candidate)) }))
    .filter(({ distance }) => distance <= Math.ceil(needle.length / 2))
    .sort((a, b) => a.distance - b.distance).slice(0, 3).map(({ candidate }) => candidate);
}

const names = elements => [...new Set(elements.filter(visible).map(e => e.label ?? e.text ?? e.value ?? e.placeholder).filter(name => typeof name === 'string' && name.trim()))];
const quoted = list => list.map(item => JSON.stringify(item)).join(', ');

function missingText(value, seen) {
  const onScreen = names(seen.elements);
  if (!onScreen.length) return `${JSON.stringify(value)} is not on screen, and nothing readable appeared within ${patienceMs / 1000} seconds (foreground: ${seen.foreground?.bundle_id ?? 'unknown'}). Nothing was tapped. The app may still be loading: use wait_for with a longer timeout, or take_screenshot to look.`;
  const closest = closestTo(value, onScreen);
  return `No visible element matches ${JSON.stringify(value)} after ${patienceMs / 1000} seconds. Nothing was tapped.${closest.length ? ` Closest on screen: ${quoted(closest)}.` : ''} On screen: ${quoted(onScreen.slice(0, 40))}. If it is further along the page, use scroll_to first.`;
}

function tooMany(value, found) {
  const brief = found.map(e => ({ type: e.type ?? e.role, label: e.label ?? e.text ?? e.value, ...center(e) }));
  return `Expected one match for ${JSON.stringify(value)}; found ${found.length}. Nothing was tapped. Use tap with x and y to choose one: ${JSON.stringify(brief)}`;
}

// A failed accessibility read counts as an empty tree, so OCR still gets its turn.
async function readStructure(ctx, maxAge) {
  try { return await ctx.structure(maxAge); }
  catch (error) { if (stopped(error)) throw error; return { elements: [], unreadable: error.message }; }
}

const fieldKey = e => e.identifier ?? e.label ?? e.placeholder ?? '';
// A field with nothing in it can report its own name as its value.
const heldText = e => e.value === e.placeholder || e.value === e.label ? '' : e.value ?? '';
// Rows of a list can share a field name, and cells get reused, so it takes the id, or the name where
// there is no id, and what the field holds. A phone's fuller trees add names its first tree lacks.
const sameField = (a, b) => (a.object_id ?? fieldKey(a)) === (b.object_id ?? fieldKey(b)) && heldText(a) === heldText(b);

// Waits for `find` to name one element that has stopped moving. Accessibility is read on every
// attempt; a screenshot and OCR join in only when it keeps missing, because only OCR sees canvases.
// The five seconds cover all of it, and a read still running when they end is stopped: coordinates
// that were not confirmed in time are not worth sending input to. A target that `mustHold` selects
// takes two matching reads even on a quiet screen.
async function locate(ctx, find, describe, mustHold) {
  let previous, seen = { elements: [] }, last = [];
  try {
    return await deadline(patienceMs, async () => {
      const started = performance.now();
      let nextOcr = ocrAfterMs;
      for (let attempt = 0; ; attempt++) {
        checkWork();
        seen = await readStructure(ctx, attempt === 0 ? justReadMs : 0);
        checkWork();
        let found = find(seen.elements);
        const elapsed = performance.now() - started, quiet = performance.now() - ctx.lastInputAt > quietMs;
        if (!found.length && (elapsed >= nextOcr || !seen.elements.length && quiet)) {
          nextOcr = elapsed + ocrEveryMs;
          seen = { ...seen, ...await ctx.recognize({ source: 'ocr', max_elements: Number.MAX_SAFE_INTEGER }) };
          checkWork();
          found = find(seen.elements);
          if (found.length) nextOcr = elapsed;
        }
        last = found;
        const position = found.map(place).join(';');
        // Right after input the screen may still be sliding, so a target has to hold its place across two reads.
        if (found.length && (position === previous || attempt === 0 && quiet && !mustHold?.(found))) {
          if (found.length > 1) throw new Error(describe.many(found));
          return found[0];
        }
        previous = position;
        await pause(pollMs);
        // An alert reports its final place at once but ignores touches for about 500 ms, so the read that
        // decides comes after the app has had time to react to the last input.
        await ctx.settle();
      }
    });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    // The caller's own cancellation or deadline is not this one.
    checkWork();
    if (last.length > 1) throw new Error(describe.many(last));
    if (last.length) throw new Error(`The target kept moving for ${patienceMs / 1000} seconds. Nothing was sent to it. Look at the screen before retrying.`);
    throw new Error(describe.missing(seen));
  }
}

const describeElement = element => {
  const value = typeof element.value === 'string' && element.value !== element.placeholder ? element.value : undefined;
  const label = element.label ?? element.text;
  const parts = [label, value !== label ? value : undefined].filter(part => typeof part === 'string' && part);
  if (isTextInput(element) && !value && element.placeholder) parts.push(`(empty, placeholder ${JSON.stringify(element.placeholder)})`);
  if (!parts.length) return undefined;
  return `${element.type ?? element.role ?? 'Element'}: ${parts.join(' = ')}${element.focused ? ' (focused)' : ''}`;
};

// The reply's view of one read: what is visible, in which app, and any system prompt on it.
export function describeScreen(seen, elements = seen.elements, source = 'accessibility') {
  const text = [...new Set(elements.filter(visible).map(describeElement).filter(Boolean))];
  const warning = promptWarning(elements);
  return {
    foreground: seen.foreground?.bundle_id ?? seen.foreground?.name ?? null,
    source,
    page_identity: screenIdentity({ foreground: seen.foreground, elements, prompt: warning }),
    text: text.slice(0, screenTextLimit),
    ...(text.length > screenTextLimit ? { more: text.length - screenTextLimit } : {}),
    ...(warning ? { prompt: warning } : {}),
  };
}

// What the screen shows once it has stopped changing: a list still coasting after a scroll would
// otherwise report a position it is about to leave. `compared` is false when accessibility could not
// read it, because OCR text alone cannot say whether anything moved. Over a slow connection one read
// can take seconds, so the reads stop when another would not finish inside the caller's deadline, and
// the last one is reported with screen_stable false rather than lost.
export async function readScreen(ctx, { before, confirmation } = {}) {
  await ctx.settle();
  const started = performance.now();
  const cost = () => ctx.readCost?.() ?? 0;
  // A batch that ends on a touch has just read the screen to see whether it changed.
  let seen = await readStructure(ctx, justReadMs), stable = false;
  const window = Math.max(stableWithinMs, 2 * cost() + pollMs);
  while (performance.now() - started < window) {
    if (remaining() < cost() + pollMs) break;
    await pause(pollMs);
    const next = await readStructure(ctx, 0);
    const same = next.signature === seen.signature;
    seen = next;
    if (same) { stable = true; break; }
  }
  if (before !== undefined && seen.elements.length && seen.signature === before) {
    const confirmed = await confirmUnchanged(ctx, before, seen, confirmation);
    if (confirmed !== seen) { seen = confirmed; stable = false; }
  }
  const compared = seen.elements.length > 0;
  const elements = compared ? seen.elements : (await ctx.recognize({ source: 'ocr', max_elements: Number.MAX_SAFE_INTEGER })).elements;
  return {
    signature: compared ? seen.signature : undefined,
    screen: { ...describeScreen(seen, elements, compared ? 'accessibility' : 'ocr'), ...(compared && !stable ? { screen_stable: false } : {}) },
  };
}

// Whether the screen differs from the one an input was sent to. One differing read settles it; a
// matching read is confirmed by a second, the same two reads readScreen needs to call a screen still.
export async function screenChanged(ctx, before, confirmation) {
  await ctx.settle();
  let seen;
  for (let read = 0; read < 2; read++) {
    if (read) await pause(pollMs);
    seen = await readStructure(ctx, 0);
    if (!seen.elements.length) return undefined;
    if (seen.signature !== before) return true;
  }
  return (await confirmUnchanged(ctx, before, seen, confirmation)).signature !== before;
}

// Two matching reads can still be the old screen: an app opening from the Home Screen keeps
// reporting the Home Screen's tree for a moment after the touch. So "unchanged" waits once more,
// and longer, polling, when the touch was on an app icon. It costs time only when nothing changed.
export const confirmAfterMs = 700, launchWithinMs = 2500, launchPollMs = 300;
async function confirmUnchanged(ctx, before, seen, { intervalMs = confirmAfterMs, withinMs = confirmAfterMs } = {}) {
  const started = performance.now(), cost = ctx.readCost?.() ?? 0;
  while (seen.signature === before && performance.now() - started < withinMs) {
    if (remaining() < intervalMs + cost) break;
    await pause(intervalMs);
    const next = await readStructure(ctx, 0);
    if (next.elements.length) seen = next;
  }
  return seen;
}

// An app icon is a touch that should bring another app to the front.
const opensApp = (element, seen) => {
  const role = element.type ?? element.role ?? '';
  return /^(?:AX|XCUIElementType)?Icon$/i.test(role) || seen?.foreground?.bundle_id === 'com.apple.springboard' && /^(?:AX|XCUIElementType)?Button$/i.test(role);
};

export async function interaction(ctx, name, args) {
  const frame = () => ctx.screenSize();
  const point = async a => {
    if (a.ref) {
      await ctx.viewport();
      const e = ctx.elements.find(e => e.ref === a.ref.toLowerCase());
      if (!e || Date.now() - ctx.elementsAt > 30000) throw new Error('Element ref is stale. Use tap_text with its label, or call list_elements again.');
      ctx.expectsForeground = opensApp(e, ctx.seen);
      const f = e.frame ?? e;
      return { x: f.x + f.width / 2, y: f.y + f.height / 2 };
    }
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error('Provide ref or both x and y.');
    return { x: a.x, y: a.y };
  };
  const tap = async (a, op = 'tap') => {
    const p = await point(a);
    return ctx.input({ op, ...p, duration_ms: op === 'long_press' ? Math.max(1, Math.round((a.duration ?? 1) * 1000)) : 50 });
  };
  const read = (a, current = false) => ctx.recognize(a ?? {}, current ? ctx.frame : undefined);
  const readComplete = async () => {
    let result = await read({ max_elements: Number.MAX_SAFE_INTEGER });
    if (result.source === 'accessibility' && result.elements.length === 0) {
      result = await read({ source: 'ocr', max_elements: Number.MAX_SAFE_INTEGER }, true);
    }
    return result;
  };
  const findText = async (value, exact) => {
    let result = await readComplete();
    let matches = matching(result.elements, value, exact);
    if (!matches.length && result.source === 'accessibility') {
      result = await read({ source:'ocr', max_elements:Number.MAX_SAFE_INTEGER }, true);
      matches = matching(result.elements, value, exact);
    }
    return { ...result, matches };
  };
  switch (name) {
    case 'tap': case 'double_tap': case 'long_press': return tap(args, name);
    case 'tap_text': {
      const element = await locate(ctx, elements => matching(elements, args.text, args.exact), { missing: seen => missingText(args.text, seen), many: found => tooMany(args.text, found) });
      ctx.expectsForeground = opensApp(element, ctx.seen);
      return ctx.input({ op: 'tap', ...center(element), duration_ms: 50 });
    }
    case 'swipe': case 'drag': return ctx.input({
      op: 'drag', x1: args.from_x, y1: args.from_y, x2: args.to_x, y2: args.to_y,
      duration_ms: Math.max(1, Math.round(args.duration_ms ?? (name === 'drag' ? 800 : 300))),
      hold_ms: name === 'drag' ? Math.round((args.hold_seconds ?? 0.6) * 1000) : 0,
    });
    case 'scroll': {
      const f = await frame();
      const x = (args.x ?? f.width / 2) / f.width, y = (args.y ?? f.height / 2) / f.height;
      const horizontal = ['left', 'right'].includes(args.direction);
      const direction = ['down', 'right'].includes(args.direction) ? -1 : 1;
      const clamp = n => Math.max(0, Math.min(1, n));
      return ctx.input({ op: 'drag',
        x1: clamp(x - (horizontal ? direction * .15 : 0)) * (f.width - 1),
        y1: clamp(y - (horizontal ? 0 : direction * .15)) * (f.height - 1),
        x2: clamp(x + (horizontal ? direction * .15 : 0)) * (f.width - 1),
        y2: clamp(y + (horizontal ? 0 : direction * .15)) * (f.height - 1),
        duration_ms: 350, hold_ms: 0,
      });
    }
    case 'scroll_to': {
      let previous;
      const maximum = Math.min(args.max_scrolls ?? args.max_swipes ?? 10, 50);
      for (let count = 0; count <= maximum; count++) {
        const result = await findText(args.text, args.exact);
        const matches = result.matches;
        if (matches.length) return { found: true, scrolls: count, elements: matches, source: result.source };
        const signature = JSON.stringify(result.elements.filter(visible).flatMap(e => [e.label, e.text, e.value].filter(t => typeof t === 'string')));
        const unchanged = signature === previous;
        if (count === maximum || unchanged) throw new Error(`Text ${JSON.stringify(args.text)} was not found after ${count} scrolls${unchanged ? '; visible content stopped changing' : ''}.`);
        previous = signature;
        await interaction(ctx, 'scroll', { ...args, direction: args.direction ?? 'down' });
        await pause(200);
      }
      break;
    }
    case 'pinch': {
      const f = await frame();
      const p = { x: args.x ?? f.width / 2, y: args.y ?? f.height / 2 };
      const available = Math.min(p.x, f.width - p.x - 1) * 1.7;
      const scale = args.scale;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('scale must be greater than zero.');
      const start = Math.min(f.width * 0.35, available / Math.max(1, scale));
      if (start < 2) throw new Error('Pinch center is too close to the screen edge.');
      return ctx.input({ op: 'pinch', ...p, start_distance: start, end_distance: start * scale, duration_ms: args.duration_ms ?? 500 });
    }
    case 'type_text':
      if (!args.text && !args.clear) throw new Error('Provide text, or clear=true to empty the field. To send existing text, use press_key with key="return" instead of type_text.');
      return ctx.input({ op: 'type_text', text: args.text ?? '', clear: args.clear ?? false, submit: args.submit ?? false });
    case 'fill': {
      const named = args.ref || Number.isFinite(args.x);
      // OCR text has no element type, so it stands in for a field only on a screen accessibility cannot read.
      const recognized = e => e.text !== undefined && e.type === 'StaticText';
      let readable = false;
      const namedInputs = elements => {
        if (!elements.some(recognized)) readable ||= elements.length > 0;
        return matching(elements.filter(e => isTextInput(e) || !readable && recognized(e)), args.field);
      };
      const inputs = args.field ? namedInputs : elements => elements.filter(e => visible(e) && isTextInput(e));
      const physical = (await ctx.target()).kind === 'physical';
      if (ctx.inBatch && args.field && !named) {
        const seen = await readStructure(ctx, justReadMs);
        const fields = seen.elements.filter(e => visible(e) && isTextInput(e));
        if (fields.length === 1 && fields[0].focused && !namedInputs(seen.elements).length) {
          throw new Error(`Requested field is not visible: ${JSON.stringify(args.field)}. The current focused text field is ${JSON.stringify(fieldKey(fields[0]))}. Nothing was typed. Use its exact observed label with fill if it is the intended field; field names are not translated.`);
        }
      }
      let aim = named ? await point(args) : undefined;
      let shown = named ? (await readStructure(ctx, 0)).elements : [];
      const referred = args.ref && ctx.elements.find(e => e.ref === args.ref.toLowerCase())?.object_id;
      // A ref names a field even after it has moved; coordinates name whatever is there now.
      let target = named
        ? shown.find(e => isTextInput(e) && (referred ? e.object_id === referred : covers(e, aim)))
        : await locate(ctx, elements => inputs(shown = elements), args.field
          ? { missing: seen => missingText(args.field, seen), many: found => `${tooMany(args.field, found)} Nothing was typed. After the tap, use type_text to enter text at the cursor.` }
          : {
            missing: seen => `No text field is on screen after ${patienceMs / 1000} seconds. Nothing was typed. On screen: ${quoted(names(seen.elements).slice(0, 40))}.`,
            many: found => `fill needs field when several text fields are visible; found ${found.length}: ${quoted(names(found))}. Nothing was typed.`,
          // A tap goes to coordinates, and a list keeps sliding while the keyboard comes up. A field already being edited takes no tap.
          }, ([field]) => isTextInput(field) && !field.focused);
      const known = target && isTextInput(target) ? target : undefined;
      // Key presses go to whatever is being edited, so a phone needs to know which field it means before anything else.
      if (physical && !known) throw new Error(`${named ? `No text field is at ${args.ref ? `ref ${args.ref}` : `${args.x}, ${args.y}`}` : 'The target is not a readable text field'}. Nothing was typed. Call list_elements and aim at a field it lists.`);
      if (args.ref && known) aim = center(known);
      // Without an id, a field is its name and what it holds. A place proves nothing once a list can move, so two alike get nothing.
      const refuseLookalikes = elements => {
        if (known && !known.object_id && elements.filter(e => isTextInput(e) && visible(e) && sameField(e, known)).length > 1) throw new Error(`More than one text field is named ${JSON.stringify(fieldKey(known))} and holds the same text, and none has an id, so fill cannot tell them apart. Nothing was typed or submitted. Tap the field you want, then use type_text to enter text at the cursor.`);
      };
      refuseLookalikes(shown);
      // A field already being edited needs no touch, and a touch is what can land on the row beside it.
      let here = target?.focused && isTextInput(target) ? target : undefined;
      if (!here) {
        aim ??= center(target);
        const isAimed = known ? e => isTextInput(e) && sameField(e, known) : e => covers(e, aim);
        const focusedElements = async () => {
          const { elements } = await readStructure(ctx, 0);
          refuseLookalikes(elements);
          return elements.filter(e => e.focused);
        };
        let focused = await focusedElements();
        here = focused.find(isAimed);
        // A device can lose a tap, so the field gets a second one, unless the first gave focus to something else.
        for (let taps = 0; !here && taps < 2; taps++) {
          const before = focused.map(fieldKey).join();
          await ctx.input({ op: 'tap', ...aim, duration_ms: 50 });
          let moved = false;
          for (const started = performance.now(); !here && !moved && performance.now() - started < focusWithinMs; await pause(pollMs)) {
            focused = await focusedElements();
            here = focused.find(isAimed);
            moved = focused.map(fieldKey).join() !== before;
          }
          if (!here && moved && known && focused.some(isTextInput)) throw new Error(`The tap gave focus to ${quoted(names(focused))}, which is not the requested field. Nothing was typed. Look at the screen before retrying.`);
        }
        // On a simulator, coordinates may aim beside a field on purpose.
        if (!here && focused.length && !Number.isFinite(args.x)) throw new Error(`The field did not take focus after two taps; ${quoted(names(focused)) || 'another element'} still has it. Nothing was typed. Look at the screen before retrying.`);
        if (!here && known) throw new Error(`${quoted(names([known])) || 'The text field'} did not take focus after two taps. Nothing was typed. Look at the screen before retrying.`);
      }
      if (physical) {
        // Clearing, pasting, reading back and Return stay in one native request: each separate request costs seconds, and only native can check the field right before the first key press.
        const { object_id, label, placeholder, value = '' } = here;
        const typed = await ctx.input({ op: 'type_text', text: args.text, clear: true, submit: args.submit ?? false, target: { object_id, role: here.role ?? here.type, label, placeholder, value } });
        if (!typed.isError || !typed.sent) return typed;
        const aimed = (await readStructure(ctx, 0)).elements.find(e => isTextInput(e) && e.object_id === object_id);
        const held = aimed && !/secure/i.test(aimed.type ?? '') ? heldText(aimed) : undefined;
        return held === undefined ? typed : { ...typed, instruction: `The field holds ${JSON.stringify(held)} instead of the requested text. ${typed.instruction}` };
      }
      // Submit waits for the checks below, so it never runs on text that went astray.
      const typed = await ctx.input({ op: 'type_text', text: args.text, clear: true, submit: false });
      if (typed.isError) return typed;
      const seen = (await readStructure(ctx, 0)).elements;
      const aimedPlace = aim ?? center(target);
      const aimed = seen.find(e => isTextInput(e) && (known ? fieldKey(e) === fieldKey(known) : covers(e, aimedPlace)));
      const failed = instruction => ({ ...typed, isError: true, stop_reason: 'error', instruction });
      if (typed.text_verified === false) {
        // Without a focused field the input layer has no value to report, so the aimed field is the only evidence.
        const held = 'field_value' in typed ? typed.field_value : aimed && !/secure/i.test(aimed.type ?? '') ? heldText(aimed) : undefined;
        if (held !== undefined) return failed(`The field holds ${JSON.stringify(held)} instead of the requested text. Nothing was submitted. Look at it before continuing.`);
        // A field seen with focus before typing and gone now took the text somewhere unknown. A secure field is still there, and a field accessibility never saw has nothing to compare.
        if (here && !aimed && !('field_value' in typed)) return failed('The field disappeared while typing, so the text could not be verified. Nothing was submitted. Look at the screen before continuing.');
        return typed;
      }
      const holder = seen.find(e => e.focused && isTextInput(e));
      // A field that still looks like the target did not take the text, whatever is being edited now.
      if (known && holder && (fieldKey(holder) !== fieldKey(known) || seen.some(e => e !== holder && isTextInput(e) && sameField(e, known)))) return failed(`The text went into ${quoted(names([holder]))}, not the requested field. Nothing was submitted. Look at it before continuing.`);
      if (!args.submit) return typed;
      await ctx.input({ op: 'key', key: 'return', modifiers: [], count: 1 });
      return { ...typed, submit_sent: true };
    }
    case 'press_key': return ctx.input({ op: 'key', key: args.key, modifiers: args.modifiers ?? [], count: args.count ?? 1 });
    case 'press_button': return ctx.input({ op: 'button', button: args.button });
    case 'hide_keyboard': {
      const keyboardVisible = async () => {
        let result = await read({ max_elements: Number.MAX_SAFE_INTEGER });
        if (result.elements.filter(visible).some(e => {
          const f = e.frame ?? e;
          return [e.type, e.role].some(type => typeof type === 'string' &&
            (/keyboard/i.test(type) && f.y + f.height > result.height * .5 || /^(?:AX|XCUIElementType)?key$/i.test(type) && f.y > result.height * .5));
        })) return true;
        if (result.source === 'accessibility') {
          const keys = result.elements.filter(e => visible(e) && (e.frame ?? e).y > result.height * .5 && /^(?:AX|XCUIElementType)?button$/i.test(e.type ?? e.role ?? ''));
          const deleteKey = keys.some(e => e.identifier === 'delete');
          const dictation = keys.some(e => e.identifier === 'dictation');
          const switcher = keys.some(e => typeof e.label === 'string' && normalize(e.label) === 'next keyboard');
          const emojiKeys = new Set(keys.map(e => e.identifier).filter(id => typeof id === 'string' && id.length <= 32 && /\p{Extended_Pictographic}/u.test(id)));
          // Emoji keys are generic AX buttons on this runtime, not Key nodes.
          // Require keyboard controls plus a grid of distinct emoji identifiers.
          if (deleteKey && (dictation || switcher) && emojiKeys.size >= 6) return true;
        }
        if (result.source !== 'ocr') result = await read({ source: 'ocr' }, true);
        const lower = result.elements.filter(e => visible(e) && (e.frame ?? e).y > result.height * .5);
        const letters = new Set(lower.flatMap(strings).filter(t => /^[qwertyuiopasdfghjklzxcvbnm]$/i.test(t)).map(normalize));
        return letters.size >= 8;
      };
      if (!await keyboardVisible()) return { hidden: true, already_hidden: true };
      await ctx.input({ op: 'button', button: 'keyboard' });
      if (await keyboardVisible()) throw new Error("The keyboard is still visible after the toggle. Use its hide control, or tap outside the field if the app supports dismissing it that way.");
      return { hidden: true, screen_change: 'changed', screen_change_verified: true };
    }
    case 'system_gesture': {
      if (args.gesture === 'go_home') return ctx.input({ op: 'button', button: 'home' });
      if (args.gesture === 'app_switcher' && (await ctx.target()).kind === 'physical') return ctx.input({ op: 'button', button: 'home', count: 2, interval_ms: 120 });
      const f = await frame();
      const coordinates = {
        app_switcher: [.5, .999, .5, .6, 450],
        control_center: [.97, .001, .9, .5, 300],
        notification_center: [.3, .001, .3, .6, 300],
        spotlight: [.5, .3, .5, .55, 300],
      }[args.gesture];
      if (!coordinates) throw new Error('Unknown system gesture.');
      return ctx.input({ op: 'drag', x1: coordinates[0] * (f.width - 1), y1: coordinates[1] * (f.height - 1), x2: coordinates[2] * (f.width - 1), y2: coordinates[3] * (f.height - 1), duration_ms: coordinates[4], end_hold_ms: args.gesture === 'app_switcher' ? 700 : 0 });
    }
    case 'go_back': {
      const f = await frame();
      await ctx.settle();
      const { elements } = await readStructure(ctx, 0);
      const back = elements.filter(e => /^(back|返回|上一页|上一頁)$/i.test(e.label ?? e.text ?? '') && (e.frame?.x ?? e.x) < f.width / 2);
      if (back.length === 1) return ctx.input({ op: 'tap', ...center(back[0]), duration_ms: 50 });
      return ctx.input({ op: 'drag', x1: 1, y1: f.height / 2, x2: f.width * .8, y2: f.height / 2, duration_ms: 400, hold_ms: 0 });
    }
    case 'handle_alert': {
      if (!args.button && !['accept', 'dismiss'].includes(args.action)) throw new Error('Provide action=accept/dismiss or button.');
      if (args.button !== undefined && !alertText(args.button)) throw new Error('Button text must not be empty.');
      const labels = args.action === 'accept'
        ? [...behavior.alert_accept_priority, '使用app时允许', '使用 App 时允许', '允许', '好', '确定', '继续']
        : [...behavior.alert_dismiss_priority, '不允许', '要求 App 不跟踪', '暂不', '取消'];
      let warning, purchase;
      const button = await locate(ctx, elements => {
        const shown = elements.filter(visible);
        warning = promptWarning(shown);
        purchase = warning?.kind === 'purchase' && args.action === 'accept' && !args.button
          ? { isError: true, stop_reason: 'error', sent: false, prompt: warning,
              buttons: names(shown.filter(e => /^(?:AX|XCUIElementType)?button$/i.test(e.type ?? e.role ?? ''))),
              instruction: 'Nothing was tapped. Confirm a purchase only when the user explicitly requested it, using button with the visible button text. Otherwise dismiss the prompt.' }
          : undefined;
        if (purchase) return shown.slice(0, 1);
        const exact = label => shown.filter(e => strings(e).some(t => alertText(t) === alertText(label)));
        if (args.button) {
          const candidates = exact(args.button);
          return candidates.length ? candidates : shown.filter(e => strings(e).some(t => alertText(t).startsWith(alertText(args.button))));
        }
        for (const label of labels) {
          const candidates = exact(label);
          if (candidates.length) return candidates;
        }
        return [];
      }, {
        missing: seen => `Could not identify ${args.button ? `one alert button for ${JSON.stringify(args.button)}` : 'an alert button'} after ${patienceMs / 1000} seconds. Nothing was tapped. On screen: ${quoted(names(seen.elements).slice(0, 40))}.`,
        many: found => `More than one alert button matches. Nothing was tapped. ${JSON.stringify(found.map(e => ({ label: e.label ?? e.text, ...center(e) })))}`,
      });
      if (purchase) return purchase;
      const result = await ctx.input({ op: 'tap', ...center(button), duration_ms: 50 });
      return { ...result, ...(warning ? { prompt: warning } : {}) };
    }
    case 'wait_for': {
      const started = performance.now(), timeout = (args.timeout ?? args.timeout_seconds ?? 10) * 1000;
      return deadline(timeout, async () => {
        while (performance.now() - started < timeout) {
          checkWork();
          const result = await findText(args.text, args.exact);
          checkWork();
          if (performance.now() - started >= timeout) break;
          const found = result.matches;
          const complete = result.truncated === false && (result.source === 'ocr' || result.source === 'accessibility' && result.elements.length > 0);
          if (args.gone ? complete && found.length === 0 : found.length > 0) return { matched: true, gone: args.gone ?? false, elapsed_seconds: (performance.now() - started) / 1000, elements: found, source: result.source, observation: result.observation };
          await pause(Math.min(400, Math.max(0, timeout - (performance.now() - started))));
        }
        throw new DOMException('Timed out waiting for the requested text condition.', 'TimeoutError');
      });
    }
    case 'request_human_action': return askHuman(args.reason, args.timeout_seconds ?? 300);
    case 'wait': await pause(args.seconds * 1000); return { waited: args.seconds };
    default: return undefined;
  }
}

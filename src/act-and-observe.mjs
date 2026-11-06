// Fork-only (poki-remote): act_and_observe, one input action and the accessibility tree after it in
// a single tool call. Registered only with POKI_BRIDGE_DAEMON=1, where the warm bridge makes the read
// that follows the action cheap. The action runs through the same code as the single-step tool of
// that name; what differs is that no screen is read before it and that the reply is the tree itself
// rather than a summary of the visible text.
import { z } from 'zod';
import { enabled } from './bridge-daemon.mjs';
import { interaction } from './interaction.mjs';
import { pause, phase, stopped, stoppingReason } from './work.mjs';

export const name = 'act_and_observe';
export const actions = ['tap', 'double_tap', 'long_press', 'tap_text', 'swipe', 'drag', 'scroll', 'type_text', 'fill', 'press_key', 'press_button', 'go_back', 'hide_keyboard'];
export const registered = (env = process.env) => enabled(env);

const description = `Perform one input action and return the accessibility tree read after it, in one call. action names a single-step tool (${actions.join(', ')}) and arguments are that tool's arguments. After the action the call waits settle_ms, then reads the screen once. The reply has the action's own result and the elements on screen with their frames in screen points; tap them by coordinates or by label with tap_text. It does not take a screenshot and does not hand out refs.`;

export const schema = z.object({
  device: z.string().optional(),
  action: z.enum(actions),
  arguments: z.record(z.string(), z.unknown()).default({}),
  settle_ms: z.number().int().min(0).max(5000).default(600),
  max_elements: z.number().int().min(1).max(400).default(200),
});

// The tools.mjs entry: [name, description, input schema, read-only].
export const definition = [name, description, schema, false];

const compact = element => {
  const box = element.frame ?? element;
  const out = { type: element.type ?? element.role };
  for (const key of ['label', 'value', 'text', 'identifier', 'placeholder']) if (element[key] !== undefined && element[key] !== '') out[key] = element[key];
  for (const key of ['focused', 'selected']) if (element[key]) out[key] = true;
  if (element.enabled === false) out.enabled = false;
  Object.assign(out, { x: box.x, y: box.y, width: box.width, height: box.height });
  return out;
};

// `parse(tool, args)` validates the action's arguments with that tool's own schema.
export async function actAndObserve(ctx, args, parse) {
  const inner = parse(args.action, { ...args.arguments, ...(args.device ? { device: args.device } : {}) });
  ctx.beforeInput = undefined;
  const started = performance.now();
  let action;
  try { action = await phase('act', () => interaction(ctx, args.action, inner)); }
  catch (error) {
    if (stopped(error)) return { isError: true, ...reply({ action: { stopped: true, stop_reason: stoppingReason(error) } }), _meta: { stop_reason: stoppingReason(error) } };
    throw error;
  }
  if (action === undefined) throw new Error(`No implementation for ${args.action}`);
  const actedMs = Math.round(performance.now() - started);
  if (action.isError || action.stopped) return { isError: true, ...reply({ action }), _meta: { stop_reason: action.stop_reason ?? (action.stopped ? 'cancelled' : 'unknown') } };
  const remaining = ctx.lastInputAt + args.settle_ms - performance.now();
  if (remaining > 0) await pause(remaining);
  const observed = performance.now();
  let screen;
  try {
    const seen = await phase('observe', () => ctx.structure(0));
    const elements = seen.elements.slice(0, args.max_elements).map(compact);
    screen = { foreground: seen.foreground ?? null, source: 'accessibility', elements, total: seen.elements.length, truncated: seen.elements.length > elements.length };
  } catch (error) {
    if (stopped(error)) return { isError: true, ...reply({ action, screen: { stopped: true } }), _meta: { stop_reason: stoppingReason(error) } };
    // The action has happened; only the read failed.
    screen = { unavailable: error.message };
  }
  return reply({ action, screen, timings_ms: { act: actedMs, settle: args.settle_ms, observe: Math.round(performance.now() - observed) } });
}

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

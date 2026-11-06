import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { version } from './build-info.mjs';
import { humanChannel } from './human.mjs';

const catalog = JSON.parse(readFileSync(new URL('./data/tools.json', import.meta.url), 'utf8'));
const defaultTools = new Set([
  'poki_mcp_status', 'list_devices', 'select_device', 'list_elements', 'take_screenshot',
  'get_foreground_app', 'launch_app', 'open_url', 'tap', 'tap_text', 'fill', 'type_text',
  'scroll', 'swipe', 'press_key', 'go_back', 'wait_for', 'handle_alert', 'batch_commands',
  'long_press', 'double_tap', 'drag', 'hide_keyboard', 'press_button',
  'scroll_to', 'terminate_app', 'pinch', 'list_apps', 'get_clipboard',
]);
const instructions = 'When the request already says what to do on the device, use batch_commands for launch_app and steps whose targets are already known; use fill without field for a single visible input, and use exact observed labels when a selector is needed; it is usually the only device call needed. Tapping steps wait for their target, and the reply ends with the visible text. With one device available, skip list_devices and select_device; use them when a call reports several devices. Consecutive calls do not require an explicit device lease. Single-step tools remain for exploring an unknown screen.';
const readOnly = new Set(['observe_device','list_devices', 'get_device_info', 'take_screenshot', 'get_foreground_app', 'list_elements', 'list_apps', 'get_clipboard', 'list_crashes', 'get_crash', 'wait_for', 'wait']);
const guidance = {
  acquire_device: 'Only needed to keep other sessions off a device across several calls. One batch_commands call already runs without interruption, so a single-call task needs no lease. If you take one, keep the returned lease_id, renew before expiry, then release.',
  wait_for: 'The timeout covers device capture, AX, OCR and polling. Success includes the matching observation and its image, so a second screenshot is not needed to inspect the matched state.',
  batch_commands: `Batch known operations. A single visible input can be filled without field. Field and button labels come from observed screen text, in its original language; guesses such as a translated Search label or an unobserved New Tab button require an observation first.

Example:
{"commands":[
  {"tool":"launch_app","arguments":{"bundle_id":"com.example.app"}},
  {"tool":"fill","arguments":{"text":"hello","submit":true}},
  {"tool":"tap_text","arguments":{"text":"Open"}},
  {"tool":"go_back","arguments":{}},
  {"tool":"tap_text","arguments":{"text":"Show Alert"}},
  {"tool":"handle_alert","arguments":{"button":"OK"}}
]}

Arguments of common steps: launch_app {bundle_id or name}; tap_text {text}; tap {x, y}; fill {text, field (optional when one text field is visible), submit}; type_text {text}; press_key {key, modifiers, count}; scroll {direction}; scroll_to {text, direction}; swipe {from_x, from_y, to_x, to_y}; go_back {}; handle_alert {button or action}; wait_for {text, gone, timeout_seconds}; wait {seconds}; take_screenshot {}. Use tool names without any client prefix.`,
  fill: 'Omit field when only one text input is visible. When selecting among fields, copy the exact observed label or use a current ref; field labels are not translated. Prefer fill over separate tap + type_text when the target field is known: it uses the field already being edited or taps it once, confirms that exact field before clearing anything, and reads the text back from it before any Return. When the field cannot be confirmed, nothing is typed. Use submit=true only when sending is already authorized; otherwise inspect the draft first.',
  type_text: 'Requires an already focused field. When the target field is known, use fill instead to avoid focus mistakes. To send text already entered, use press_key key=return; do not call type_text with empty text. text_verified confirms input only, not delivery.',
  press_key: 'Use key=return to submit existing text after it has been checked; do not re-enter the text. A sent result only confirms key dispatch, so verify the app result before reporting delivery.',
  launch_app: 'On a simulator it returns once the app shows readable elements, and on a physical device once the app is in front; either way its text is in screen, so there is no need to look again. resumed=true means the app was already running and kept its state; use fresh=true to start it anew. If launch fails with CoreDeviceError 4016, inspect the current screen and use the observed Home Screen or app switcher controls. Avoid repeating the same failing launch until device conditions change.',
};
export const definitions = catalog.tools.map(tool => [tool.name, [tool.description, guidance[tool.name]].filter(Boolean).join('\n\n'), z.fromJSONSchema(tool.inputSchema), readOnly.has(tool.name)]);
definitions.push(['poki_mcp_status', 'Report Poki MCP version, current Git commit, native bridge build time, tool count, connected-device count, selected device, and approval mode for this session.', z.object({}), true]);

export function createServer(call) {
  const server = new McpServer({ name: 'poki-mcp', version }, { instructions });
  for (const [name, description, inputSchema, readOnlyHint] of definitions) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint } }, async (args, extra) => {
      const elicit = extra.mcpReq?.elicitInput;
      try { return await humanChannel.run({ elicit }, () => call(name, args, { signal: extra.mcpReq?.signal ?? extra.signal, requestId: extra.mcpReq?._meta?.['poki/request_id'] })); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  if (process.env.POKI_MCP_TOOLS !== 'all') {
    server.server.setRequestHandler('tools/list', () => ({
      tools: definitions.filter(([name]) => defaultTools.has(name)).map(([name, description, inputSchema, readOnlyHint]) => ({
        name, description, inputSchema: z.toJSONSchema(inputSchema, { io: 'input', target: 'draft-2020-12' }),
        annotations: { readOnlyHint },
      })),
    }));
  }
  return server;
}

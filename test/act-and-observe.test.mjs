// Fork-only (poki-remote): the act_and_observe tool in src/act-and-observe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { root } from '../src/config.mjs';
import { actAndObserve, schema } from '../src/act-and-observe.mjs';

const listed = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { definitions, createServer } = await import(${JSON.stringify(`${root}/src/tools.mjs`)});
  const server = createServer(async () => ({ content: [] }));
  const handler = server.server._requestHandlers.get('tools/list');
  const listed = handler ? (await handler({ method: 'tools/list', params: {} }, {})).tools.map(t => t.name) : [];
  console.log(JSON.stringify({ defined: definitions.some(d => d[0] === 'act_and_observe'), listed: listed.includes('act_and_observe') }));
`], { env: { ...process.env, ...env }, encoding: 'utf8' }));

test('act_and_observe exists only with POKI_BRIDGE_DAEMON=1', () => {
  const env = { POKI_BRIDGE_DAEMON: '' };
  assert.equal(listed(env).defined, false);
  const on = listed({ POKI_BRIDGE_DAEMON: '1' });
  assert.equal(on.defined, true);
  assert.equal(on.listed, true);
});

const element = (label, x, y, extra = {}) => ({ role: 'Button', type: 'Button', label, x, y, width: 40, height: 20, ...extra });
function fakeDevice({ input, structure } = {}) {
  const ctx = {
    calls: [], lastInputAt: -Infinity,
    screenSize: async () => ({ width: 400, height: 800 }),
    input: async request => { ctx.calls.push(request); ctx.lastInputAt = performance.now(); return input ? input(request) : { sent: true, screen_change_verified: false }; },
    structure: async maxAge => { ctx.calls.push({ read: maxAge }); return structure ? structure() : { foreground: { bundle_id: 'com.example' }, elements: [element('OK', 10, 20, { focused: true }), element('Cancel', 60, 20, { enabled: false, value: '' })] }; },
  };
  return ctx;
}
const parse = (tool, values) => ({ tool, ...values });
const body = result => JSON.parse(result.content[0].text);

test('one action, then one read of the tree after the settle time', async () => {
  const ctx = fakeDevice();
  const started = performance.now();
  const result = await actAndObserve(ctx, schema.parse({ action: 'tap', arguments: { x: 10, y: 20 }, settle_ms: 80 }), parse);
  assert.ok(performance.now() - started >= 75, 'waits settle_ms after the input');
  assert.equal(result.isError, undefined);
  assert.deepEqual(ctx.calls, [{ op: 'tap', x: 10, y: 20, duration_ms: 50 }, { read: 0 }]);
  const reply = body(result);
  assert.deepEqual(reply.action, { sent: true, screen_change_verified: false });
  assert.deepEqual(reply.screen, {
    foreground: { bundle_id: 'com.example' }, source: 'accessibility', total: 2, truncated: false,
    elements: [{ type: 'Button', label: 'OK', focused: true, x: 10, y: 20, width: 40, height: 20 }, { type: 'Button', label: 'Cancel', enabled: false, x: 60, y: 20, width: 40, height: 20 }],
  });
  assert.equal(reply.timings_ms.settle, 80);
  console.log(`act_and_observe on a fake device: ${JSON.stringify(reply.timings_ms)}`);
});

test('defaults, limits and argument checks', async () => {
  assert.equal(schema.parse({ action: 'tap' }).settle_ms, 600);
  assert.throws(() => schema.parse({ action: 'list_elements' }));
  assert.throws(() => schema.parse({ action: 'tap', settle_ms: 6000 }));
  const ctx = fakeDevice();
  const reply = body(await actAndObserve(ctx, schema.parse({ action: 'tap', arguments: { x: 1, y: 1 }, settle_ms: 0, max_elements: 1 }), parse));
  assert.equal(reply.screen.elements.length, 1);
  assert.equal(reply.screen.truncated, true);
  // The action's arguments go through that tool's own schema, with the device added.
  const seen = [];
  await actAndObserve(fakeDevice(), schema.parse({ device: 'phone', action: 'tap', arguments: { x: 1, y: 1 }, settle_ms: 0 }), (tool, values) => { seen.push([tool, values]); return values; });
  assert.deepEqual(seen, [['tap', { x: 1, y: 1, device: 'phone' }]]);
});

test('a failed action is not followed by a read, and a failed read keeps the action result', async () => {
  const failing = fakeDevice({ input: () => ({ outcome: 'unknown', isError: true, error: 'tunnel closed' }) });
  const result = await actAndObserve(failing, schema.parse({ action: 'tap', arguments: { x: 1, y: 1 }, settle_ms: 0 }), parse);
  assert.equal(result.isError, true);
  assert.equal(failing.calls.length, 1);
  const unreadable = fakeDevice({ structure: () => { throw new Error('no tree'); } });
  const reply = body(await actAndObserve(unreadable, schema.parse({ action: 'tap', arguments: { x: 1, y: 1 }, settle_ms: 0 }), parse));
  assert.equal(reply.action.sent, true);
  assert.deepEqual(reply.screen, { unavailable: 'no tree' });
});

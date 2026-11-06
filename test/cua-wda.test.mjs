import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { Devices } from '../src/device.mjs';
import { flatten } from '../src/cua-wda.mjs';

// A stand-in for WebDriverAgent on a phone: W3C sessions plus the WDA routes the backend uses, over
// a two-screen app (a home screen with its icon, a note with a title field).
async function fakeWda(t) {
  const state = { page: 'home', title: '', focused: false, sessions: new Set(), calls: [], forget: false };
  const node = (type, label, x, y, width, height, extra = {}) => ({ type: `XCUIElementType${type}`, label, name: label, rect: { x, y, width, height }, isEnabled: '1', isVisible: '1', ...extra });
  const tree = () => ({ type: 'XCUIElementTypeApplication', label: state.page === 'home' ? 'SpringBoard' : 'Jot', rect: { x: 0, y: 0, width: 200, height: 400 }, children: state.page === 'home'
    ? [node('Icon', 'Jot', 20, 80, 50, 50), node('Icon', 'Hidden', 90, 80, 50, 50, { isVisible: '0' })]
    : [node('TextField', 'Title', 10, 50, 180, 30, { value: state.title }), node('Button', 'Save', 150, 90, 40, 30)] });
  const png = (await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } }).png().toBuffer()).toString('base64');
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = body ? JSON.parse(body) : {};
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value })); };
    const path = req.url.replace(/^\/session\/([^/]+)/, (_, id) => { req.session = id; return ''; });
    state.calls.push(`${req.method} ${path}`);
    if (req.method === 'POST' && req.url === '/session') { const id = `s${state.sessions.size + 1}`; state.sessions.add(id); return send({ sessionId: id, capabilities: {} }); }
    if (req.session && (!state.sessions.has(req.session) || state.forget)) { state.forget = false; state.sessions.delete(req.session); return send({ error: 'invalid session id', message: 'Session does not exist' }, 404); }
    if (path === '/window/size') return send({ width: 200, height: 400 });
    if (path === '/screenshot') return send(png);
    if (path.startsWith('/source')) { assert.match(req.url, /excluded_attributes=visible/); return send(tree()); }
    if (path === '/wda/activeAppInfo') return send(state.page === 'home' ? { bundleId: 'com.apple.springboard', name: 'SpringBoard', pid: 30 } : { bundleId: 'local.jot', name: 'Jot', pid: 700 });
    if (path === '/wda/tap') { if (state.page === 'home' && args.x >= 20 && args.x <= 70 && args.y >= 80 && args.y <= 130) state.page = 'note'; else if (state.page === 'note' && args.y >= 50 && args.y <= 80) state.focused = true; return send(null); }
    if (path === '/wda/keys') { if (state.focused) state.title += args.value.join(''); return send(null); }
    if (path === '/element/active') return send({ ELEMENT: 'field-1' });
    if (path === '/element/field-1/clear') { state.title = ''; return send(null); }
    if (path === '/wda/homescreen') { state.page = 'home'; return send(null); }
    if (path === '/wda/apps/launch') { state.page = args.bundleId === 'local.jot' ? 'note' : state.page; return send(null); }
    if (path === '/wda/dragfromtoforduration' || path === '/wda/touchAndHold' || path === '/actions') return send(null);
    return send({ error: 'unknown command', message: `no route ${req.method} ${path}` }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

class AnyPhone extends Devices {
  async inventory() { return [{ id: 'phone-1', kind: 'physical', name: 'Test Phone', state: 'Booted' }]; }
  liveScreen() { return undefined; }
  async bridge() { throw new Error('the bridge is not used with the WebDriverAgent backend'); }
}

const text = result => result.content.find(block => block.type === 'text').text;
const numberOf = (result, label) => Number(text(result).split('\n').find(line => line.includes(`"${label}`))?.match(/^[+ ](\d+) /)?.[1]);

test('WDA source flattens to visible elements in points, without the application root', () => {
  const elements = flatten({ type: 'XCUIElementTypeApplication', rect: { x: 0, y: 0, width: 10, height: 10 }, children: [
    { type: 'XCUIElementTypeButton', label: '7', rect: { x: 1, y: 2, width: 3, height: 4 }, isVisible: '1' },
    { type: 'XCUIElementTypeOther', label: 'gone', rect: { x: 1, y: 2, width: 3, height: 4 }, isVisible: '0' },
    { type: 'XCUIElementTypeStaticText', label: 'flat', rect: { x: 0, y: 0, width: 0, height: 4 } }] });
  assert.deepEqual(elements.map(e => [e.type, e.label, e.x, e.y, e.width, e.height]), [['Button', '7', 1, 2, 3, 4]]);
});

test('look and do answer the same way on WebDriverAgent: numbered elements, screenshot, actions sent', { timeout: 20000 }, async t => {
  const wda = await fakeWda(t);
  const saved = { backend: process.env.POKI_CUA_BACKEND, url: process.env.POKI_WDA_URL };
  process.env.POKI_CUA_BACKEND = 'wda'; process.env.POKI_WDA_URL = wda.url;
  t.after(() => { for (const [k, v] of [['POKI_CUA_BACKEND', saved.backend], ['POKI_WDA_URL', saved.url]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const phone = new AnyPhone();
  const home = await phone.call('look', {});
  assert.match(text(home), /^app: SpringBoard/m);
  assert.match(text(home), /Icon "Jot" \[20,80,50,50\]/);
  assert.doesNotMatch(text(home), /Hidden/);
  assert.ok(home.content.some(block => block.type === 'image'));
  const note = await phone.call('do', { actions: [{ tap: numberOf(home, 'Jot') }] });
  assert.match(text(note), /did: tap \d+ \(sent/);
  assert.match(text(note), /^app: Jot/m);
  assert.match(text(note), /^\+\d+ TextField "Title"/m);
  const typed = await phone.call('do', { actions: [{ type: 'Milk', ref: numberOf(note, 'Title') }] });
  assert.match(text(typed), /type "Milk" \(keys\) \(sent/);
  assert.equal(wda.state.title, 'Milk');
  const cleared = await phone.call('do', { actions: [{ type: 'Tea', ref: numberOf(typed, 'Title = Milk'), clear: true }] });
  assert.match(text(cleared), /TextField "Title = Tea"/);
  // WDA forgot the session: the next request opens a new one and goes through once.
  wda.state.forget = true;
  const home2 = await phone.call('do', { actions: [{ button: 'home' }] });
  assert.match(text(home2), /button home \(sent/);
  assert.equal(wda.state.page, 'home');
  assert.equal(wda.state.sessions.size, 1);
  assert.equal(wda.state.calls.filter(c => c === 'POST /session').length, 2);
  const swiped = await phone.call('do', { actions: [{ swipe: 'up' }, { long_press: [50, 50] }, { launch: 'local.jot' }] });
  assert.match(text(swiped), /swipe up \(sent[\s\S]*long_press[\s\S]*launch local.jot \(sent/);
});

test('an input WDA refuses is not_sent, and one it never answered is unknown', { timeout: 20000 }, async t => {
  const wda = await fakeWda(t);
  process.env.POKI_CUA_BACKEND = 'wda'; process.env.POKI_WDA_URL = wda.url;
  t.after(() => { delete process.env.POKI_CUA_BACKEND; delete process.env.POKI_WDA_URL; });
  const phone = new AnyPhone();
  await phone.call('look', {});
  const refused = await phone.call('do', { actions: [{ button: 'siri' }] });
  assert.match(text(refused), /\(not_sent, \d+ ms\)/);
  const view = phone.wdaView;
  // A request with no answer at all may have reached the phone.
  view.wda.fetch = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  const lost = await view.input({ op: 'tap', x: 1, y: 1 });
  assert.equal(lost.outcome, 'unknown');
});

test('a runner that refuses connections is reported as down, and nothing is retried', { timeout: 20000 }, async () => {
  const { Wda } = await import('../src/cua-wda.mjs');
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const port = closed.address().port; closed.close(); await once(closed, 'close');
  const wda = new Wda(`http://127.0.0.1:${port}`);
  await assert.rejects(wda.call('GET', '/window/size'), error => /not running.*connection refused/.test(error.message) && error.delivered === 'not_sent');
});

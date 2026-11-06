import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Devices } from '../src/device.mjs';

// "Jot", an app invented for these tests: a home screen with its icon, a note with a title field and
// a long list that scrolls. Drawn as blocks so a screenshot exists; no live screen, so do waits a fixed
// time after its actions and its screenshot is an ordinary capture.
const W = 200, H = 400;
const springboard = { pid: 30, bundle_id: 'com.apple.springboard' }, jot = { pid: 700, bundle_id: 'local.jot' };
const el = (role, label, x, y, width, height, extra = {}) => ({ role, label, x, y, width, height, ...extra });

class Jot {
  page = 'home'; title = ''; focused = false; offset = 0;
  screen() {
    if (this.page === 'locked') return { foreground: springboard, elements: [] };
    if (this.page === 'home') return { foreground: springboard, elements: [el('Icon', 'Jot', 20, 80, 50, 50), el('Icon', 'Clock', 90, 80, 50, 50)] };
    const rows = Array.from({ length: 30 }, (_, i) => el('Cell', `Item ${i + 1}`, 0, 140 + i * 40 + this.offset, 200, 40)).filter(e => e.y > 100 && e.y < H);
    return { foreground: jot, elements: [el('TextField', 'Title', 10, 50, 180, 30, { value: this.title, focused: this.focused, object_id: 'f1' }), el('Button', 'Save', 150, 90, 40, 30), el('Table', 'Items', 0, 120, 200, 280), ...rows] };
  }
  touch(x, y) {
    const hit = this.screen().elements.filter(e => x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height).at(-1);
    if (hit?.label === 'Jot') this.page = 'note';
    if (hit?.label === 'Title') this.focused = true;
  }
  async render() {
    if (this.page === 'locked') return sharp({ create: { width: W, height: H, channels: 3, background: 'black' } }).png().toBuffer();
    const blocks = await Promise.all(this.screen().elements.map(async e => ({ input: await sharp({ create: { width: Math.max(4, e.width), height: Math.max(4, Math.min(e.height, H - Math.max(0, e.y))), channels: 3, background: { r: e.label.length * 9 % 200, g: 90, b: 90 } } }).png().toBuffer(), left: e.x, top: Math.max(0, e.y) })));
    return sharp({ create: { width: W, height: H, channels: 3, background: 'white' } }).composite(blocks).png().toBuffer();
  }
}

class JotPhone extends Devices {
  constructor() { super(); this.app = new Jot(); this.size = { device: 'phone-1', width: W, height: H }; this.sent = []; this.clipboard = { items: [{ index: 0, uti: 'public.utf8-plain-text', state: 'inline', size: 5 }], text: 'mine!' }; }
  async inventory() { return [{ id: 'phone-1', kind: 'physical', name: 'Test Phone', state: 'Booted' }]; }
  liveScreen() { return undefined; }
  async bridge(request) {
    if (request.op === 'ax') {
      if (this.axFails) { await new Promise(r => setTimeout(r, 100)); throw new Error('accessibility is down'); }
      if (this.axDelayMs) await new Promise(r => setTimeout(r, this.axDelayMs));
      const tree = this.app.screen(); return { foreground: tree.foreground, elements: tree.elements.map(e => ({ ...e, type: e.role })) };
    }
    if (request.op === 'pasteboard') {
      if (request.action === 'items') return { items: this.clipboard.items };
      if (request.action === 'get') return { text: this.clipboard.text };
      if (request.action === 'set') { this.clipboard = { items: [{ uti: 'public.utf8-plain-text', state: 'inline' }], text: request.text }; return { copied: true }; }
    }
    this.sent.push(request.op);
    if (request.op === 'tap') { this.app.touch(request.x / 65535 * (W - 1), request.y / 65535 * (H - 1)); return { sent: true }; }
    if (request.op === 'type_keys') {
      if (this.keysFail) throw new Error('unknown variant `type_keys`');
      if (this.keysBreak) throw new Error('connection reset');
      if (!this.app.focused) return { sent: true };
      this.app.title = (request.clear ? '' : this.app.title) + request.text; return { sent: true };
    }
    if (request.op === 'type_text') { this.clipboard = { items: [{ uti: 'public.utf8-plain-text', state: 'inline' }], text: request.text }; this.app.title = request.clear ? request.text : this.app.title + request.text; return { sent: true, clipboard_restore_status: 'unavailable' }; }
    if (request.op === 'drag') { const dy = (request.y2 - request.y1) / 65535 * (H - 1); this.app.offset = Math.max(-30 * 40 + 260, Math.min(0, this.app.offset + Math.round(dy))); return { sent: true }; }
    return { sent: true };
  }
  async captureFrame() {
    const data = await this.app.render();
    this.frame = { id: String(Math.random()), device: 'phone-1', revision: this.coordinator.revision('phone-1'), width: W, height: H, scale: 1, data, original: data, at: Date.now() };
    return this.frame;
  }
}

const text = result => result.content.find(block => block.type === 'text').text;
const image = result => result.content.some(block => block.type === 'image');
const numberOf = (result, label) => Number(text(result).split('\n').find(line => line.includes(`"${label}`))?.match(/^[+ ](\d+) /)?.[1]);

test('do reports each action as sent, waits, and reads once with a screenshot', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  const home = await phone.call('look', {});
  const opened = await phone.call('do', { actions: [{ tap: numberOf(home, 'Jot') }] });
  assert.match(text(opened), /did: tap \d+ \(sent, \d+ ms\)/);
  assert.match(text(opened), /did: waited \d+ ms \(fixed\)/);
  assert.match(text(opened), /^\+\d+ TextField "Title/m);
  assert.equal(image(opened), true);
  assert.equal(phone.app.page, 'note');
});

test('type sends the whole text as key presses in one request, and pastes only with the clipboard saved and put back', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = await phone.call('do', { actions: [{ tap: [45, 105] }] });
  const typed = await phone.call('do', { actions: [{ type: 'Milk & eggs!', ref: numberOf(note, 'Title') }] });
  assert.match(text(typed), /type "Milk & eggs!" \(keys\) \(sent/);
  assert.equal(phone.app.title, 'Milk & eggs!');
  assert.equal(phone.sent.filter(op => op === 'type_keys').length, 1);
  assert.equal(phone.sent.includes('type_text'), false);
  // A bridge without type_keys: the paste runs and the user's clipboard comes back.
  phone.keysFail = true;
  const pasted = await phone.call('do', { actions: [{ type: 'Bread', ref: numberOf(typed, 'Title'), clear: true }] });
  assert.match(text(pasted), /\(pasted, clipboard restored\) \(sent/);
  assert.equal(phone.clipboard.text, 'mine!');
  assert.equal(phone.app.title, 'Bread');
  // A clipboard that cannot be put back exactly is never pasted over.
  phone.clipboard = { items: [{ uti: 'public.png', state: 'promised' }] };
  const kept = await phone.call('do', { actions: [{ type: 'Jam', ref: numberOf(pasted, 'Title'), clear: true }, { tap: [170, 105] }] });
  assert.equal(kept.isError, true);
  assert.match(text(kept), /\(not_sent, \d+ ms\)/);
  assert.match(text(kept), /clipboard cannot be saved/);
  assert.match(text(kept), /the actions after it were not sent/);
  assert.equal(phone.sent.filter(op => op === 'type_text').length, 1);
  assert.match(text(kept), /^app: local.jot/m, 'a failed action still ends with the read');
});

test('typing that fails part way is unknown, is not pasted on top, and stops the call', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = await phone.call('do', { actions: [{ tap: [45, 105] }] });
  phone.keysBreak = true;
  const broken = await phone.call('do', { actions: [{ type: 'Tea', ref: numberOf(note, 'Title') }, { tap: [170, 105] }] });
  assert.match(text(broken), /\(unknown, \d+ ms\)/);
  assert.match(text(broken), /may have been delivered/);
  assert.equal(phone.sent.filter(op => op === 'type_text').length, 0);
  assert.equal(phone.sent.filter(op => op === 'type_keys').length, 1, 'never sent again');
});

test('an element number that is not in the latest read is refused with the current list, and nothing is sent', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const result = await phone.call('do', { actions: [{ tap: [45, 105] }, { tap: 99 }] });
  assert.equal(result.isError, true);
  assert.match(text(result), /element 99 is not in the latest read; nothing was sent/);
  assert.match(text(result), /Icon "Jot"/);
  assert.deepEqual(phone.sent, []);
});

test('scroll_to swipes until the target is on screen, in one action', { timeout: 30000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = await phone.call('do', { actions: [{ tap: [45, 105] }] });
  const found = await phone.call('do', { actions: [{ scroll_to: { text: 'Item 12', in: numberOf(note, 'Items') } }] });
  assert.match(text(found), /scroll_to .*: \d+ swipes, found at/);
  assert.match(text(found), /Cell "Item 12"/);
  const end = await phone.call('do', { actions: [{ scroll_to: 'Item 99' }] });
  assert.match(text(end), /not found/);
});

test('long_press, drag and pinch take element numbers or points, with defaults', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = await phone.call('do', { actions: [{ tap: [45, 105] }] });
  const save = numberOf(note, 'Save'), items = numberOf(note, 'Items');
  const done = await phone.call('do', { actions: [{ long_press: save }, { drag: { from: items, to: [100, 300] } }, { pinch: { ref: items, scale: 0.5 } }] });
  assert.match(text(done), /long_press \d+ 600 ms \(sent/);
  assert.match(text(done), /drag .*\(sent/);
  assert.match(text(done), /pinch .* x0.5 \(sent/);
  assert.deepEqual(phone.sent.slice(-3), ['long_press', 'drag', 'pinch']);
});

test('a dark, locked screen stops dispatching', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  phone.app.page = 'locked';
  const dark = await phone.call('look', {});
  assert.match(text(dark), /screen: dark/);
  const held = await phone.call('do', { actions: [{ tap: [45, 105] }] });
  assert.match(text(held), /stopped before action 1: the phone is locked/);
  assert.deepEqual(phone.sent, []);
});

test('the actions of one call stop at the action time cap', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const started = performance.now();
  const capped = await phone.call('do', { actions: [{ wait: 2000 }, { wait: 2000 }, { wait: 2000 }] });
  assert.match(text(capped), /the 4000 ms action time ran out/);
  assert.ok(performance.now() - started < 7000);
});

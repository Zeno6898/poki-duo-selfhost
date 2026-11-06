import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Devices } from '../src/device.mjs';

// "Jot", an app invented for these tests: a home screen with its icon, a note with a title field and
// a long list that scrolls. Drawn as blocks so a screenshot exists; no live screen, so the step waits
// a fixed time and its screenshot is an ordinary capture.
const W = 200, H = 400;
const springboard = { pid: 30, bundle_id: 'com.apple.springboard' }, jot = { pid: 700, bundle_id: 'local.jot' };
const el = (role, label, x, y, width, height, extra = {}) => ({ role, label, x, y, width, height, ...extra });

class Jot {
  page = 'home'; title = ''; focused = false; offset = 0;
  screen() {
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

const body = result => JSON.parse(result.content.find(block => block.type === 'text').text);
const image = result => result.content.some(block => block.type === 'image');
const refOf = (reply, label) => [...(reply.elements ?? []), ...(reply.diff?.appeared ?? []), ...(reply.diff?.changed ?? [])].find(e => e.label === label)?.ref;

test('look lists the screen with refs and the app in front, and no picture unless asked', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  const first = await phone.call('look', {});
  const seen = body(first);
  assert.equal(seen.source, 'accessibility');
  assert.equal(seen.foreground.bundle_id, 'com.apple.springboard');
  assert.deepEqual(seen.elements.map(e => e.label), ['Jot', 'Clock']);
  assert.match(seen.elements[0].ref, /^e\d+$/);
  assert.deepEqual(seen.elements[0].frame, [20, 80, 50, 50]);
  assert.equal(image(first), false);
  assert.equal(image(await phone.call('look', { image: true })), true);
});

test('a step sends its actions, reads once, and answers with facts and a screenshot, no verdict', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  const home = body(await phone.call('look', {}));
  const opened = await phone.call('step', { actions: [{ tap: { ref: refOf(home, 'Jot') } }] });
  const facts = body(opened);
  assert.equal(image(opened), true, 'every step carries a screenshot');
  assert.equal(facts.actions[0].ok, true);
  assert.ok(facts.actions[0].at && Number.isFinite(facts.actions[0].ms));
  assert.ok(facts.wait_ms >= 0);
  assert.equal(facts.foreground.bundle_id, 'local.jot');
  assert.ok(facts.diff.appeared.some(e => e.label === 'Title' && e.role === 'TextField'));
  assert.ok(facts.diff.vanished.some(e => e.label === 'Jot'));
  for (const verdict of ['outcome', 'expectation', 'verdict', 'proven']) assert.equal(facts[verdict], undefined);
  // An unchanged element keeps its ref from one read to the next.
  const again = body(await phone.call('step', { actions: [{ wait: { ms: 10 } }] }));
  assert.equal(again.diff.appeared.length, 0);
  assert.equal(again.diff.unchanged > 0, true);
});

test('fill types the text as keys, and pastes only with the clipboard saved and put back', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = body(await phone.call('step', { actions: [{ tap: { x: 45, y: 105 } }] }));
  const title = refOf(note, 'Title');
  const typed = body(await phone.call('step', { actions: [{ fill: { ref: title, text: 'Groceries' } }] }));
  assert.equal(typed.actions[0].fill_via, 'typed');
  assert.ok(typed.diff.changed.some(e => e.ref === title && e.value === 'Groceries'), JSON.stringify(typed.diff));
  assert.equal(phone.sent.includes('type_text'), false, 'the clipboard is not touched when typing works');
  // Typing is refused by this bridge: the paste runs, and the user's clipboard comes back.
  phone.keysFail = true;
  const pasted = body(await phone.call('step', { actions: [{ fill: { ref: title, text: 'Hardware' } }] }));
  assert.equal(pasted.actions[0].fill_via, 'pasted');
  assert.equal(pasted.actions[0].clipboard, 'restored');
  assert.equal(phone.clipboard.text, 'mine!');
  assert.equal(phone.app.title, 'Hardware');
  // A clipboard that cannot be read back exactly is never pasted over.
  phone.clipboard = { items: [{ uti: 'public.png', state: 'promised' }] };
  const before = phone.sent.filter(op => op === 'type_text').length;
  const refused = body(await phone.call('step', { actions: [{ fill: { ref: title, text: 'Other' } }] }));
  assert.equal(refused.actions[0].ok, false);
  assert.match(refused.actions[0].error, /clipboard cannot be saved/);
  assert.equal(phone.sent.filter(op => op === 'type_text').length, before);
  assert.equal(refused.source, 'accessibility', 'a failed action still ends with the read');
});

test('a ref that is not in the latest read is refused with the current list, and nothing is sent', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const result = await phone.call('step', { actions: [{ tap: { ref: 'e999' } }] });
  const answer = body(result);
  assert.equal(result.isError, true);
  assert.match(answer.refused, /e999/);
  assert.ok(answer.elements.some(e => e.label === 'Jot'));
  assert.deepEqual(phone.sent, []);
});

test('without accessibility the step still answers from the screenshot, within the step cap', { timeout: 20000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  phone.axFails = true;
  const blind = await phone.call('step', { actions: [{ tap: { x: 45, y: 105 } }] });
  const facts = body(blind);
  assert.equal(facts.source, 'ocr');
  assert.match(facts.read.accessibility_error, /accessibility is down/);
  assert.equal(image(blind), true);
  assert.equal(phone.app.page, 'note');
  phone.axFails = false; phone.axDelayMs = 6000;
  const started = performance.now();
  const slow = body(await phone.call('step', { actions: [{ wait: { ms: 10 } }] }));
  assert.ok(performance.now() - started < 4600, `${Math.round(performance.now() - started)} ms`);
  assert.equal(slow.source, 'ocr');
});

test('scroll_to swipes until the target is on screen, in one action, and says what moved', { timeout: 30000 }, async () => {
  const phone = new JotPhone();
  await phone.call('look', {});
  const note = body(await phone.call('step', { actions: [{ tap: { x: 45, y: 105 } }] }));
  const found = body(await phone.call('step', { actions: [{ scroll_to: { text: 'Item 12', in: refOf(note, 'Items') } }] }));
  assert.equal(found.actions[0].found, true, JSON.stringify(found.actions[0]));
  assert.ok(found.actions[0].swipes >= 1);
  assert.ok(found.diff.appeared.some(e => e.label === 'Item 12'));
  assert.ok(found.moved?.shift?.y < 0, JSON.stringify(found.moved));
});

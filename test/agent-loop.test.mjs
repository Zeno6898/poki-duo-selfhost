import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Devices } from '../src/device.mjs';

// "Ledger", an app invented for these tests: a list of entries that can be selected and deleted
// behind a confirmation sheet. It is drawn as blocks, so pixels change exactly when the screen does.
const springboard = { pid: 30, bundle_id: 'com.apple.springboard' }, ledger = { pid: 501, bundle_id: 'local.ledger' };
const W = 200, H = 400;
const el = (role, label, x, y, width, height, extra = {}) => ({ role, label, x, y, width, height, ...extra });

class LedgerApp {
  page = 'home'; entries = ['Coffee 4.50', 'Rent 1200', 'Book 18', 'Lunch 12', 'Taxi 22']; selected = new Set(); selecting = false; sheet = false; offset = 0;
  constructor({ axLag = 0 } = {}) { this.axLag = axLag; this.lagged = 0; this.previous = undefined; }
  screen() {
    if (this.page === 'home') return { foreground: springboard, elements: [el('Icon', 'Ledger', 20, 80, 50, 50), el('Icon', 'Clock', 90, 80, 50, 50)] };
    if (this.page === 'accounts') return { foreground: ledger, elements: [el('StaticText', 'Accounts', 10, 40, 100, 20), el('Button', 'Entries', 10, 100, 180, 40), el('Button', 'Settings', 10, 150, 180, 40),
      // A sideways row of chips that pages under a drag.
      el('CollectionView', 'Recent', 0, 200, 200, 60), ...[1, 2, 3, 4, 5, 6].map(n => el('Cell', `Chip ${n}`, 10 + (n - 1) * 70 + this.offset, 210, 60, 40)).filter(e => e.x < W && e.x + e.width > 0)] };
    const elements = [el('Button', 'Back', 5, 40, 30, 20), el('StaticText', 'Entries', 60, 40, 80, 20), el('Button', this.selecting ? 'Done' : 'Select', 150, 40, 45, 20),
      ...this.entries.map((entry, i) => el('Cell', entry, 10, 80 + i * 44, 180, 40, { selected: this.selected.has(entry) }))];
    if (this.selecting) elements.push(el('Button', 'Delete', 60, 360, 80, 30));
    if (this.sheet) elements.push(el('StaticText', `Delete ${this.selected.size} entries?`, 20, 250, 160, 20), el('Button', `Delete ${this.selected.size} Entries`, 20, 280, 160, 30), el('Button', 'Cancel', 20, 320, 160, 30));
    return { foreground: ledger, elements };
  }
  // A real tree can trail the screen: for axLag reads after a change, it still describes the old one.
  tree() {
    if (this.lagged < this.axLag && this.previous) { this.lagged++; return this.previous; }
    return this.screen();
  }
  touch(x, y) {
    const hit = this.screen().elements.filter(e => x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height).at(-1);
    if (!hit) return;
    const before = this.screen();
    const label = hit.label;
    if (label === 'Ledger') this.page = 'accounts';
    else if (label === 'Entries' && this.page === 'accounts') this.page = 'entries';
    else if (label === 'Back') this.page = 'accounts';
    else if (label === 'Select' || label === 'Done') { this.selecting = label === 'Select'; this.selected.clear(); }
    else if (hit.role === 'Cell' && this.selecting && !this.sheet) this.selected.has(label) ? this.selected.delete(label) : this.selected.add(label);
    else if (label === 'Delete' && this.selected.size) this.sheet = true;
    else if (/^Delete \d+ Entries$/.test(label)) { this.entries = this.entries.filter(e => !this.selected.has(e)); this.selected.clear(); this.sheet = false; this.selecting = false; }
    else if (label === 'Cancel') this.sheet = false;
    else return;
    this.previous = before; this.lagged = 0;
  }
  async render() {
    const blocks = await Promise.all(this.screen().elements.flatMap(e => {
      const shade = [...e.label].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 120;
      const parts = [[e.x, e.y, Math.max(4, Math.min(e.width, 4 + e.label.length * 6)), e.height, shade]];
      if (e.selected) parts.push([e.x + e.width - 14, e.y + 12, 10, 10, 0]);
      return parts.map(async ([left, top, width, height, v]) => ({ input: await sharp({ create: { width, height, channels: 3, background: { r: v, g: v, b: v } } }).png().toBuffer(), left, top }));
    }));
    // A spinner that never stops, below the status bar.
    if (this.spinner) blocks.push({ input: await sharp({ create: { width: 12, height: 12, channels: 3, background: 'black' } }).png().toBuffer(), left: 150 + (this.spin = ((this.spin ?? 0) + 7) % 40), top: 32 });
    return sharp({ create: { width: W, height: H, channels: 3, background: 'white' } }).composite(blocks).png().toBuffer();
  }
}

// The real Devices with the phone replaced by the app above: dispatch, the single-step tools, the
// World and the new tools all run as they do against a device.
class LedgerPhone extends Devices {
  constructor(options = {}) { super(); this.app = new LedgerApp(options); this.size = { device: 'phone-1', width: W, height: H }; this.live = options.live; this.drags = []; this.pidOnly = options.pidOnly; }
  async inventory() { return [{ id: 'phone-1', kind: 'physical', name: 'Test Phone', state: 'Booted' }]; }
  liveScreen() { return this.live?.(this); }
  async bridge(request) {
    if (request.op === 'ax' && this.axFails) { await new Promise(r => setTimeout(r, 300)); throw new DOMException('External process deadline exceeded', 'TimeoutError'); }
    if (request.op === 'ax' && this.axDelayMs) await new Promise(r => setTimeout(r, this.axDelayMs));
    if (request.op === 'ax') { const tree = this.app.tree(); return { foreground: this.pidOnly ? { pid: tree.foreground.pid } : tree.foreground, elements: tree.elements.map(e => ({ ...e, type: e.role })) }; }
    if (request.op === 'app_for_pid') { this.lookups = (this.lookups ?? 0) + 1; return request.pid === ledger.pid ? { bundle_id: ledger.bundle_id, name: 'Ledger' } : { executable: '/System/Library/CoreServices/SpringBoard.app/SpringBoard' }; }
    if (request.op === 'launch_app') { if (request.bundle_id !== ledger.bundle_id) return { isError: true, error: 'not installed' }; if (this.locked) return { pid: ledger.pid, bundle_id: ledger.bundle_id }; if (this.app.page === 'home') { this.app.previous = this.app.screen(); this.app.lagged = 0; this.app.page = 'accounts'; } return { pid: ledger.pid, bundle_id: ledger.bundle_id }; }
    if (request.op === 'drag') {
      this.drags.push(request);
      const [x1, y1, x2] = [request.x1 / 65535 * (W - 1), request.y1 / 65535 * (H - 1), request.x2 / 65535 * (W - 1)];
      if (this.app.page === 'accounts' && y1 >= 200 && y1 <= 260) { this.app.previous = this.app.screen(); this.app.lagged = 0; this.app.offset = Math.max(-280, Math.min(0, this.app.offset + Math.round(x2 - x1))); }
      return { sent: true, screen_change_verified: false };
    }
    if (request.op === 'tap') { this.app.touch(request.x / 65535 * (W - 1), request.y / 65535 * (H - 1)); return { sent: true, screen_change_verified: false }; }
    return { sent: true, screen_change_verified: false };
  }
  async captureFrame() {
    const started = new Date().toISOString(), data = await this.app.render();
    this.frame = { id: String(Math.random()), device: 'phone-1', revision: this.coordinator.revision('phone-1'), width: W, height: H, scale: 1, data, original: data, at: Date.now(), capture_started_at: started, capture_completed_at: new Date().toISOString() };
    return this.frame;
  }
}

const body = result => JSON.parse(result.content.find(block => block.type === 'text').text);
const tokens = result => Math.ceil(result.content.find(block => block.type === 'text').text.length / 4);

test('a cold agent deletes three entries in an app it has never seen, in at most five calls', { timeout: 60000 }, async t => {
  const phone = new LedgerPhone();
  const calls = [];
  const call = async (name, args) => { const started = performance.now(); const result = await phone.call(name, args); calls.push({ name, result }); t.diagnostic(`${name}: ${Math.round(performance.now() - started)} ms, ${tokens(result)} text tokens: ${body(result).now.summary}`); return result; };

  const first = body(await call('observe', {}));
  assert.match(first.now.summary, /springboard/);
  assert.ok(first.now.text.lines.includes('Icon: Ledger'), JSON.stringify(first.now.text));

  // What a first-time agent writes from that one look: open the app, the list, pick three, delete.
  const steps = [
    { tool: 'launch_app', arguments: { bundle_id: 'local.ledger' }, expect: { text: 'Entries' } },
    { tool: 'tap_text', arguments: { text: 'Entries' }, expect: { text: 'Select' } },
    { tool: 'tap_text', arguments: { text: 'Select' }, expect: { text: 'Done' } },
    { tool: 'select_items', arguments: { match: { role: 'Cell' }, count: 3 } },
    { tool: 'tap_text', arguments: { text: 'Delete', exact: true }, expect: { text: 'Delete 3 Entries' } },
    { tool: 'tap_text', arguments: { text: 'Delete 3 Entries' }, expect: { gone: 'Coffee' } },
  ];
  const held = await call('run', { steps });
  const stop = body(held);
  assert.equal(stop.stopped.reason, 'checkpoint', JSON.stringify(stop.stopped));
  assert.equal(stop.stopped.step, 5);
  assert.equal(stop.completed_steps, 4);
  assert.equal(phone.app.selected.size, 3, 'the selection ran, the delete did not');
  assert.equal(phone.app.entries.length, 5);

  const done = body(await call('run', { resume: stop.run_id, allow: ['Delete'] }));
  assert.equal(done.stopped, null, JSON.stringify(done.stopped));
  assert.equal(done.now.outcome, 'as_expected');
  assert.deepEqual(phone.app.entries, ['Lunch 12', 'Taxi 22']);
  assert.ok(done.now.text.lines.includes('Cell: Lunch 12') && !done.now.text.lines.some(line => /Coffee|Rent|Book/.test(line)), JSON.stringify(done.now.text.lines));
  assert.match(done.now.summary, /^local\.ledger: as expected/);

  assert.ok(calls.length <= 5, `${calls.length} calls`);
  for (const { name, result } of calls) {
    const text = result.content.find(block => block.type === 'text').text;
    // One verdict: none of the earlier two-field form, and no advice to look again when all went as expected.
    assert.doesNotMatch(text, /screen_change_verified|screen_changed/, name);
    if (body(result).now.outcome === 'as_expected') assert.doesNotMatch(text, /instruction|check|again/i, name);
    assert.ok(tokens(result) < 1500, `${name}: ${tokens(result)} tokens`);
    assert.equal(result.content.at(-1).type, 'image');
    assert.equal(result.content.at(-1).mimeType, 'image/jpeg');
  }
});

test('allowing the destructive label up front runs the whole task in one call', { timeout: 60000 }, async () => {
  const phone = new LedgerPhone();
  const result = body(await phone.call('run', { allow: ['delete'], steps: [
    { tool: 'launch_app', arguments: { bundle_id: 'local.ledger' }, expect: { foreground: 'local.ledger' } },
    { tool: 'tap_text', arguments: { text: 'Entries' }, expect: { text: 'Select' } },
    { tool: 'tap_text', arguments: { text: 'Select' }, expect: { text: 'Done' } },
    { tool: 'select_items', arguments: { match: { label: '/^(Rent|Taxi)/' }, count: 2 } },
    { tool: 'tap_text', arguments: { text: 'Delete', exact: true }, expect: { text: 'Delete 2 Entries' } },
    { tool: 'tap_text', arguments: { text: 'Delete 2 Entries' }, expect: { gone: 'Rent' } },
  ] }));
  assert.equal(result.stopped, null, JSON.stringify(result.stopped));
  assert.deepEqual(phone.app.entries, ['Coffee 4.50', 'Book 18', 'Lunch 12']);
});

test('unchanged only when the settled screen, the app in front and the tree are what the input was sent to', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  await phone.call('observe', {});
  const blank = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } } }));
  assert.equal(blank.sent, true);
  assert.equal(blank.now.outcome, 'unchanged', JSON.stringify(blank.now));
  const opened = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Ledger' } } }));
  assert.equal(opened.now.outcome, 'changed');
  assert.equal(opened.now.foreground.bundle_id, 'local.ledger');
  assert.ok(opened.now.since_last_look.foreground_changed);
  // A missed expectation is a verdict on the screen, not a warning to look again.
  const missed = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, expect: { text: 'Entries list' } }));
  assert.equal(missed.expectation, 'missed');
  assert.equal(missed.now.outcome, 'unchanged');
});

test('a text expectation never matches a tree that still shows the screen before the input', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone({ axLag: 3 });
  await phone.call('run', { steps: [{ tool: 'launch_app', arguments: { bundle_id: 'local.ledger' } }] });
  await phone.call('observe', {});
  // "Settings" is on the page the tap leaves. The tree keeps reporting it for three reads after the tap.
  const result = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Entries' } }, expect: { text: 'Settings' }, timeout_ms: 5000 }));
  assert.notEqual(result.expectation, 'met', JSON.stringify(result.now));
  assert.equal(result.now.outcome, 'changed');
  const select = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Back' } }, expect: { text: 'Settings' }, timeout_ms: 5000 }));
  assert.equal(select.expectation, 'met');
});

test('refs name elements of one frame, and an earlier screen\'s ref is refused with the current elements', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  const look = body(await phone.call('observe', { full: true }));
  const icon = look.now.elements.find(e => e.label === 'Ledger');
  const opened = body(await phone.call('act', { action: { tool: 'tap', arguments: { ref: icon.ref } }, expect: { foreground: 'local.ledger' } }));
  assert.equal(opened.expectation, 'met');
  const stale = await phone.call('act', { action: { tool: 'tap', arguments: { ref: icon.ref } } });
  assert.equal(stale.isError, true);
  const answer = body(stale);
  assert.equal(answer.sent, false);
  assert.ok(answer.now.elements.some(e => e.label === 'Entries'), 'the current refs come with the refusal');
});

test('a picture from before the input never yields a verdict, whatever the bridge says with it', { timeout: 30000 }, async () => {
  // Every picture is two seconds old, and no screenshot can be had: nothing newer than the input exists.
  let extra = { observation: 'no_input' }, fresh = false;
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date(Date.now() - (fresh ? 0 : 2000)).toISOString(), settled: true, quietMs: 2000, ...extra });
  const live = phone => ({ latestFrame: ({ source } = {}) => source === 'screenshot' && !fresh ? Promise.reject(new Error('no screenshot service')) : picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); } });
  const phone = new LedgerPhone({ live });
  await phone.call('observe', {});
  for (extra of [{ observation: 'unverified' }, { observation: 'after_input', changedSinceInput: false }, { observation: 'after_input', changedSinceInput: true }]) {
    const result = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, timeout_ms: 1500 }));
    assert.equal(result.now.outcome, 'unverified', JSON.stringify(extra));
    assert.equal(result.now.reason, 'no picture newer than the input');
    assert.ok(Date.parse(result.now.frame.captured_at) < Date.parse(result.now.frame.action_sent_at));
  }
  fresh = true; extra = { observation: 'after_input' };
  const opened = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } }, expect: { foreground: 'local.ledger' } }));
  assert.equal(opened.now.outcome, 'as_expected');
});

test('the agent profile lists the screen-as-state tools, and the default profile is unchanged', { timeout: 30000 }, async t => {
  const { fixture } = await import('./fixture.mjs');
  const agent = await fixture(t, { extraEnv: () => ({ POKI_TOOL_PROFILE: 'agent' }) });
  const listed = (await agent.a.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(listed, ['act', 'list_apps', 'list_devices', 'observe', 'poki_mcp_status', 'run', 'select_device']);
  assert.match(agent.a.getInstructions(), /observe once on an unfamiliar screen/);
  const plain = await fixture(t);
  const names = (await plain.a.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 29);
  assert.ok(!names.includes('observe') && names.includes('batch_commands'));
});

test('the profile and the count of listed tools follow the environment', async () => {
  const { listedNames, profile } = await import('../src/tools.mjs');
  assert.equal(profile({ POKI_LIVE_FRAMES: '1' }), 'agent');
  assert.equal(profile({ POKI_LIVE_FRAMES: '1', POKI_TOOL_PROFILE: 'default' }), 'default');
  assert.equal(listedNames({ POKI_TOOL_PROFILE: 'agent' }).length, 7);
  assert.equal(listedNames({}).length, 29);
  assert.equal(listedNames({ POKI_MCP_TOOLS: 'all' }).length, 59);
});

test('a stalled screen video with no screenshot to be had is said first, the outcome is unverified, and the old picture is marked as such', { timeout: 30000 }, async () => {
  const old = new Date(Date.now() - 90000).toISOString();
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: old, settled: true, observation: 'unverified', videoStalled: true, stalledMs: 90000 });
  const live = phone => ({ latestFrame: () => picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: false, reasons: ['video_stalled'] }) });
  const phone = new LedgerPhone({ live });
  const look = await phone.call('observe', {});
  const seen = body(look);
  assert.match(seen.now.summary, new RegExp(`^Screen video stalled 90 s and no screenshot could be taken; this picture is from ${old.replace(/[.]/g, '[.]')} and may be behind the screen`));
  assert.equal(seen.now.outcome, 'unverified');
  assert.equal(seen.now.frame.stalled, true);
  assert.ok(look.content.some(block => block.type === 'image'), 'every reply carries a picture');
  assert.ok(seen.now.text.lines.length, 'and text');
  const tapped = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } } }));
  assert.equal(tapped.sent, true, 'inputs still go through a stalled video');
  assert.equal(tapped.now.outcome, 'unverified');
  assert.equal(phone.app.page, 'accounts');
});

test('a lost device connection blocks inputs and says why', { timeout: 30000 }, async () => {
  let reasons = [];
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true, observation: 'no_input' });
  const live = phone => ({ latestFrame: () => picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: !reasons.length, reasons }) });
  const phone = new LedgerPhone({ live });
  await phone.call('observe', {});
  reasons = ['wifi_required'];
  const held = await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } } });
  assert.equal(held.isError, true);
  const answer = body(held);
  assert.equal(answer.sent, false);
  assert.equal(answer.now.blocked.kind, 'connection');
  assert.match(answer.now.summary, /^The device tunnel is lost, and iOS accepts new developer connections only on Wi-Fi or USB/);
  assert.equal(phone.app.page, 'home', 'nothing was sent');
  const run = body(await phone.call('run', { steps: [{ tool: 'tap', arguments: { x: 45, y: 105 } }] }));
  assert.equal(run.stopped.reason, 'blocked');
  assert.equal(run.completed_steps, 0);
  assert.equal(phone.app.page, 'home');
  reasons = [];
  assert.equal(body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } } })).sent, true);
});

test('a one-page scroll inside a named row moves only that row, without coasting, and says which container moved', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  await phone.call('run', { steps: [{ tool: 'launch_app', arguments: { bundle_id: 'local.ledger' } }] });
  await phone.call('observe', {});
  const result = body(await phone.call('act', { action: { tool: 'scroll', arguments: { direction: 'right', container: 'Recent', pages: 1 } }, expect: { text: 'Chip 4' } }));
  const drag = phone.drags.at(-1);
  assert.ok(drag.end_hold_ms > 0, 'held before lifting, so the row does not coast');
  const y = drag.y1 / 65535 * (H - 1);
  assert.ok(y >= 200 && y <= 260, `dragged inside the row, at y ${y}`);
  assert.ok(drag.x1 > drag.x2, 'the finger moves left to reveal what is to the right');
  assert.equal(result.expectation, 'met');
  assert.equal(result.moved.container, 'Recent');
  assert.ok(result.moved.shift.x < -100 && result.moved.shift.y === 0, JSON.stringify(result.moved));
  // The single-step tool says the same.
  const raw = await phone.call('scroll', { direction: 'left', container: 'Recent', pages: 1 });
  const single = JSON.parse(raw.content[0].text);
  assert.equal(single.moved.container, 'Recent');
  assert.ok(single.moved.shift.x > 100);
  const found = JSON.parse((await phone.call('scroll_to', { text: 'Chip 6', direction: 'right', container: 'Recent' })).content[0].text);
  assert.equal(found.found, true);
  assert.ok(phone.drags.at(-1).end_hold_ms > 0, 'scroll_to pages sideways lists');
});

test('whatMoved names the container whose items shifted together', async () => {
  const { whatMoved } = await import('../src/interaction.mjs');
  const row = el('CollectionView', 'Media Types', 0, 300, 390, 120);
  const before = [row, el('StaticText', 'Header', 10, 40, 100, 20), el('Cell', 'Videos', 10, 310, 100, 100), el('Cell', 'Selfies', 120, 310, 100, 100), el('Cell', 'Live', 230, 310, 100, 100)];
  const after = [row, el('StaticText', 'Header', 10, 40, 100, 20), el('Cell', 'Selfies', 10, 310, 100, 100), el('Cell', 'Live', 120, 310, 100, 100), el('Cell', 'Portrait', 230, 310, 100, 100)];
  assert.deepEqual(whatMoved(before, after), { container: 'Media Types', frame: [0, 300, 390, 120], shift: { x: -110, y: 0 }, items_moved: 2, appeared: 1 });
  assert.equal(whatMoved(before, before), null);
});

test('an accessibility root with only a pid is named from the app service, once per process', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone({ pidOnly: true });
  assert.match(body(await phone.call('observe', {})).now.summary, /^com\.apple\.springboard: /);
  const opened = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Ledger' } }, expect: { foreground: 'local.ledger' } }));
  assert.equal(opened.expectation, 'met');
  assert.match(opened.now.summary, /^local\.ledger: as expected/);
  await phone.call('observe', {});
  assert.equal(phone.lookups, 2, 'one lookup per process');
});

test('a screen that never stops animating: the expectation is met once its text holds, at the newest picture', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  phone.app.spinner = true;
  await phone.call('observe', {});
  const started = performance.now();
  const opened = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Ledger' } }, expect: { text: 'Entries' } }));
  assert.equal(opened.expectation, 'met');
  assert.ok(performance.now() - started < 4500, `${Math.round(performance.now() - started)} ms`);
  assert.ok(opened.now.frame.age_ms < 1500, `picture ${opened.now.frame.age_ms} ms old`);
  // Without an expectation it still answers inside the step's time, and says the screen is animating.
  const tapped = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, timeout_ms: 2000 }));
  assert.ok(tapped.now.frame.age_ms < 1500);
  const missed = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, expect: { text: 'Nowhere' }, timeout_ms: 2500 }));
  assert.equal(missed.expectation, 'missed', 'text that holds still without the expectation is a miss, not a timeout');
});

test('a step returns at its deadline with what the World has, and a dead accessibility read is not an error', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  await phone.call('observe', {});
  phone.axFails = true;
  const started = performance.now();
  const result = await phone.call('run', { steps: [{ tool: 'tap', arguments: { x: 45, y: 105 }, timeout_ms: 2000 }] });
  const answer = body(result);
  assert.equal(answer.stopped, null, JSON.stringify(answer.stopped));
  assert.equal(phone.app.page, 'accounts');
  assert.ok(performance.now() - started < 5000, `${Math.round(performance.now() - started)} ms`);
  assert.equal(answer.now.outcome, 'changed', 'the pictures still say what happened');
  phone.axFails = false; phone.axDelayMs = 6000;
  const slow = performance.now();
  const late = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, timeout_ms: 2000 }));
  assert.ok(performance.now() - slow < 4500, `a 6 s tree read held the reply for ${Math.round(performance.now() - slow)} ms`);
  assert.equal(late.sent, true);
});

test('when the video brings nothing newer than the input, one screenshot decides the verdict before the deadline', { timeout: 30000 }, async () => {
  // A broken video: its newest picture is ten seconds old. The screenshot service still works.
  let shots = 0;
  const picture = async (phone, at) => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date(at).toISOString(), settled: true, observation: 'unverified' });
  const live = phone => ({ latestFrame: ({ source } = {}) => source === 'screenshot' ? (shots++, picture(phone, Date.now())) : picture(phone, Date.now() - 10000), waitSettled: () => picture(phone, Date.now() - 10000), op: async () => { throw new Error('no OCR'); } });
  const phone = new LedgerPhone({ live });
  await phone.call('observe', {});
  const started = performance.now();
  const blank = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } }, timeout_ms: 2000 }));
  assert.equal(blank.now.outcome, 'unchanged', JSON.stringify(blank.now));
  assert.ok(Date.parse(blank.now.frame.captured_at) >= Date.parse(blank.now.frame.action_sent_at));
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
  assert.equal(shots, 1);
  const opened = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } }, expect: { text: 'Entries' }, timeout_ms: 2000 }));
  assert.equal(opened.now.outcome, 'as_expected');
  assert.equal(shots, 2);
});

test('a screenshot taken in place of a stalled video is a current picture, and names the app without a tree', async () => {
  const { frameFromAnswer } = await import('../src/live-frames.mjs');
  const shot = await frameFromAnswer({ jpeg_base64: Buffer.from('x').toString('base64'), captured_at: new Date().toISOString(), settled: true, observation: 'after_input', video_stalled: true, source: 'screenshot', fallback_reason: 'video_stalled', foreground: { pid: 501, bundle_id: 'local.ledger' }, frame: { seq: null } });
  assert.equal(shot.videoStalled, undefined);
  assert.equal(shot.source, 'screenshot');
  assert.equal(shot.foreground.bundle_id, 'local.ledger');
  const video = await frameFromAnswer({ jpeg_base64: Buffer.from('x').toString('base64'), captured_at: new Date().toISOString(), video_stalled: true, stalled_ms: 4000, source: 'video' });
  assert.equal(video.videoStalled, true);
  const picture = { ...shot, jpeg: await sharp({ create: { width: 10, height: 20, channels: 3, background: 'white' } }).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true };
  const { World } = await import('../src/world.mjs');
  const world = new World({ size: { width: 10, height: 20 }, structure: async () => { throw new Error('accessibility is down'); } }, { latestFrame: async () => picture, waitSettled: async () => picture, op: async () => { throw new Error('no OCR'); } });
  world.noteInput('tap');
  const frame = await world.settle(1000);
  assert.equal(frame.proven, true);
  assert.equal((await world.read(frame, { budgetMs: 500 })).foreground.bundle_id, 'local.ledger');
});

test('a launch the app service accepted is reported as sent even when the app stays behind a lock screen', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  phone.locked = true;
  await phone.call('observe', {});
  const result = await phone.call('act', { action: { tool: 'launch_app', arguments: { bundle_id: 'local.ledger' } }, expect: { foreground: 'local.ledger' } });
  const answer = body(result);
  assert.equal(answer.sent, true);
  assert.match(answer.error, /launched it as pid 501\. If the phone is locked or its screen is off, unlock it/);
  assert.equal(answer.now.outcome, 'unchanged');
  assert.doesNotMatch(answer.now.reason, /no input was sent/);
  assert.equal(answer.delivery, undefined);
});

test('a locked phone reported by the bridge blocks inputs as a device problem', { timeout: 30000 }, async () => {
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true, observation: 'no_input' });
  const live = phone => ({ latestFrame: () => picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: false, reasons: ['device_locked'] }) });
  const phone = new LedgerPhone({ live });
  const answer = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } } }));
  assert.equal(answer.sent, false);
  assert.equal(answer.now.blocked.kind, 'device');
  assert.match(answer.now.summary, /^The phone is locked or its screen is off; unlock it/);
  assert.equal(phone.app.page, 'home');
});

test('with accessibility down, the picture and OCR answer, and the summary says so once', { timeout: 30000 }, async () => {
  let reads = 0;
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true, observation: 'after_input', foreground: phone.app.screen().foreground });
  // The bridge's OCR worker reads the picture: here, the labels of what is drawn, as screen fractions.
  const ocr = phone => async request => ({ elements: phone.app.screen().elements.map(e => ({ text: e.label, region: [e.x / W, e.y / H, e.width / W, e.height / H] })), epoch_matches: true, request });
  const live = phone => ({ latestFrame: () => picture(phone), waitSettled: () => picture(phone), op: ocr(phone) });
  const phone = new LedgerPhone({ live });
  phone.bridge = (original => async function (request) { if (request.op === 'ax') { reads++; return { foreground: { pid: 30 }, elements: [] }; } return original.call(this, request); })(phone.bridge);
  const look = body(await phone.call('observe', {}));
  assert.equal(look.now.summary.match(/Accessibility unavailable/g)?.length, 1, look.now.summary);
  assert.ok(look.now.text.lines.some(line => /Ledger/.test(line)), JSON.stringify(look.now.text));
  const opened = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } }, expect: { foreground: 'local.ledger' } }));
  assert.equal(opened.expectation, 'met', 'the app named with the picture is enough');
  const entries = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 100, y: 120 } }, expect: { text: 'Select' } }));
  assert.equal(entries.expectation, 'met');
  assert.ok(reads <= 3, `${reads} accessibility reads while it was down`);
});

test('a stalled video is replaced by a screenshot in every reply, and the stall is asked afresh on every call', { timeout: 30000 }, async () => {
  // The bridge reports a stall (here a decode backlog) and its video pictures are old; the screenshot service works.
  let reasons = ['decode_backlog'], shots = 0;
  const picture = async (phone, extra) => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), settled: true, ...extra });
  const video = phone => reasons.length ? picture(phone, { capturedAt: new Date(Date.now() - 40000).toISOString(), observation: 'unverified', videoStalled: true, stalledMs: 40000 }) : picture(phone, { capturedAt: new Date().toISOString(), observation: 'after_input' });
  const live = phone => ({ latestFrame: ({ source } = {}) => source === 'screenshot' ? (shots++, picture(phone, { capturedAt: new Date().toISOString(), source: 'screenshot', observation: 'after_input' })) : video(phone), waitSettled: () => video(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: true, reasons }) });
  const phone = new LedgerPhone({ live });
  const look = await phone.call('observe', {});
  const seen = body(look);
  assert.equal(shots, 1, 'observe takes the screenshot');
  assert.equal(seen.now.frame.source, 'screenshot');
  assert.equal(seen.now.frame.stalled, undefined);
  assert.match(seen.now.summary, /^Screen video is behind; this picture is a screenshot taken at /);
  assert.ok(look.content.some(block => block.type === 'image'));
  assert.ok(seen.now.text.lines.includes('Icon: Ledger'), JSON.stringify(seen.now.text));
  const opened = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 45, y: 105 } }, expect: { text: 'Entries' }, timeout_ms: 4000 }));
  assert.equal(opened.now.outcome, 'as_expected', JSON.stringify(opened.now));
  assert.equal(opened.now.frame.source, 'screenshot');
  assert.equal(phone.app.page, 'accounts');
  // The stall clears: the next call trusts the video again and takes no screenshot.
  reasons = []; const before = shots;
  const clear = body(await phone.call('observe', {}));
  assert.equal(shots, before);
  assert.equal(clear.now.frame.source, 'video');
  assert.doesNotMatch(clear.now.summary, /stalled|behind|screenshot/);
});

test('a video that has sent no packet for seconds is not taken as current, whatever the health says', { timeout: 30000 }, async () => {
  let shots = 0, silent = 5000;
  const picture = async (phone, source) => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true, observation: 'no_input', ...(source ? { source } : {}) });
  const live = phone => ({ latestFrame: ({ source } = {}) => source === 'screenshot' ? (shots++, picture(phone, 'screenshot')) : picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: true, reasons: [], msSinceLastPacket: silent }) });
  const phone = new LedgerPhone({ live });
  const seen = body(await phone.call('observe', {}));
  assert.equal(shots, 1);
  assert.equal(seen.now.frame.source, 'screenshot');
  assert.match(seen.now.summary, /^Screen video is silent; this picture is a screenshot/);
  silent = 30;
  assert.equal(body(await phone.call('observe', {})).now.frame.source, 'video');
  assert.equal(shots, 1);
  // The bridge saying its picture is not current is reason enough on its own.
  const { frameFromAnswer } = await import('../src/live-frames.mjs');
  const frame = await frameFromAnswer({ jpeg_base64: Buffer.from('x').toString('base64'), captured_at: new Date().toISOString(), picture_current: false, ms_since_unit: 12 });
  assert.equal(frame.pictureCurrent, false);
  assert.equal(frame.msSinceUnit, 12);
});

test('tap_text finds its target in what the World read of the screen, even when a fresh read fails', { timeout: 30000 }, async () => {
  const phone = new LedgerPhone();
  const seen = body(await phone.call('observe', {}));
  assert.ok(seen.now.text.lines.includes('Icon: Ledger'));
  // Accessibility dies after the look: the single-step tool alone would find nothing to tap.
  phone.axFails = true;
  await new Promise(r => setTimeout(r, 600));
  const started = performance.now();
  const tapped = body(await phone.call('act', { action: { tool: 'tap_text', arguments: { text: 'Ledger' } }, timeout_ms: 2000 }));
  assert.equal(tapped.sent, true, JSON.stringify(tapped));
  assert.equal(tapped.error, undefined);
  assert.equal(phone.app.page, 'accounts');
  assert.ok(performance.now() - started < 4000, `${Math.round(performance.now() - started)} ms`);
});

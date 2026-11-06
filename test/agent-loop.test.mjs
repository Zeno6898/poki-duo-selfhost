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
    return sharp({ create: { width: W, height: H, channels: 3, background: 'white' } }).composite(blocks).png().toBuffer();
  }
}

// The real Devices with the phone replaced by the app above: dispatch, the single-step tools, the
// World and the new tools all run as they do against a device.
class LedgerPhone extends Devices {
  constructor(options = {}) { super(); this.app = new LedgerApp(options); this.size = { device: 'phone-1', width: W, height: H }; this.live = options.live; this.drags = []; }
  async inventory() { return [{ id: 'phone-1', kind: 'physical', name: 'Test Phone', state: 'Booted' }]; }
  liveScreen() { return this.live?.(this); }
  async bridge(request) {
    if (request.op === 'ax') { const tree = this.app.tree(); return { foreground: tree.foreground, elements: tree.elements.map(e => ({ ...e, type: e.role })) }; }
    if (request.op === 'launch_app') { if (request.bundle_id !== ledger.bundle_id) return { isError: true, error: 'not installed' }; if (this.app.page === 'home') { this.app.previous = this.app.screen(); this.app.lagged = 0; this.app.page = 'accounts'; } return { pid: ledger.pid, bundle_id: ledger.bundle_id }; }
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

test('with frames that cannot be shown to be newer than the input, the outcome is unverified', { timeout: 30000 }, async () => {
  // A live source that numbers its frames: after the input, nothing newer than it arrived.
  const picture = async (phone, observation) => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: new Date(Date.now() - 2000).toISOString(), settled: true, quietMs: 2000, observation });
  let observation = 'no_input';
  const live = phone => ({ latestFrame: () => picture(phone, observation), waitSettled: () => picture(phone, observation), op: async () => { throw new Error('no OCR'); } });
  const phone = new LedgerPhone({ live });
  await phone.call('observe', {});
  observation = 'unverified';
  const result = body(await phone.call('act', { action: { tool: 'tap', arguments: { x: 150, y: 300 } } }));
  assert.equal(result.now.outcome, 'unverified');
  assert.match(result.now.reason, /no frame newer than the input/);
  observation = 'after_input';
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

test('a stalled screen video is said first, the outcome is unverified, and the old picture is not sent', { timeout: 30000 }, async () => {
  const old = new Date(Date.now() - 90000).toISOString();
  const picture = async phone => ({ jpeg: await sharp(await phone.app.render()).jpeg().toBuffer(), capturedAt: old, settled: true, observation: 'unverified', videoStalled: true, stalledMs: 90000 });
  const live = phone => ({ latestFrame: () => picture(phone), waitSettled: () => picture(phone), op: async () => { throw new Error('no OCR'); }, status: async () => ({ ok: false, reasons: ['video_stalled'] }) });
  const phone = new LedgerPhone({ live });
  const look = await phone.call('observe', {});
  const seen = body(look);
  assert.match(seen.now.summary, new RegExp(`^Screen feed stalled 90 s; last picture is from ${old}`));
  assert.equal(seen.now.outcome, 'unverified');
  assert.equal(seen.now.frame.stalled, true);
  assert.ok(!look.content.some(block => block.type === 'image'), 'no picture that would pass for the screen');
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

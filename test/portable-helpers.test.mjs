import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { build, buildBinary } from 'plist';
import { defaultStateDir } from '../src/config.mjs';
import { jsonToXmlPlist, plistToJson, plistValue, setPlistBooleans } from '../src/plist.mjs';
import { unzipArchive, zipDirectory } from '../src/zip.mjs';
import { askHuman } from '../src/human.mjs';
import { createServer } from '../src/tools.mjs';
import { fixture, value } from './fixture.mjs';

// The Node paths are forced with platform: 'linux' so they run on every host, macOS included.
const node = { platform: 'linux' };
const scratch = async t => { const dir = await mkdtemp(join(tmpdir(), 'poki-portable-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const sample = { CFBundleIdentifier: 'local.sample', CFBundleName: 'Sample', Count: 3, Ratio: 0.5, Enabled: true, Off: false, List: ['a', 'b'], Nested: { Key: 'value' } };

test('plist round-trips XML and binary lists and serializes JSON back to XML', async t => {
  assert.deepEqual(await plistToJson(build(sample), node), sample);
  assert.deepEqual(await plistToJson(Buffer.from(buildBinary(sample)), node), sample);
  assert.deepEqual(await plistToJson(await jsonToXmlPlist(sample, node), node), sample);
  const dated = await plistToJson('<?xml version="1.0"?><plist version="1.0"><dict><key>When</key><date>2026-01-02T03:04:05Z</date><key>Blob</key><data>AQID</data></dict></plist>', node);
  assert.deepEqual(dated, { When: '2026-01-02T03:04:05.000Z', Blob: 'AQID' });
});

test('plist reads the OpenStep listing simctl listapps prints', async () => {
  const listing = '{\n    "local.fixture" =     {\n        ApplicationType = User;\n        CFBundleDisplayName = Fixture;\n        CFBundleShortVersionString = "2.0";\n    };\n}';
  assert.deepEqual(await plistToJson(listing, node), { 'local.fixture': { ApplicationType: 'User', CFBundleDisplayName: 'Fixture', CFBundleShortVersionString: '2.0' } });
});

test('plist extracts a bundle identifier from XML and binary Info.plist files', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'xml.plist'), build(sample));
  await writeFile(join(dir, 'binary.plist'), buildBinary(sample));
  for (const file of ['xml.plist', 'binary.plist']) {
    assert.equal(await plistValue(join(dir, file), 'CFBundleIdentifier', node), 'local.sample');
    assert.equal(await plistValue(join(dir, file), 'Enabled', node), 'true');
    await assert.rejects(plistValue(join(dir, file), 'Missing', node), /no Missing value/);
    await assert.rejects(plistValue(join(dir, file), 'Nested', node), /no Nested value/);
  }
});

test('plist sets accessibility booleans in a new binary list and keeps an existing list and its format', async t => {
  const dir = await scratch(t), keys = ['ApplicationAccessibilityEnabled', 'AutomationEnabled'];
  const fresh = join(dir, 'fresh.plist');
  await setPlistBooleans(fresh, keys, { ...node, create: true });
  assert.equal((await readFile(fresh)).subarray(0, 8).toString(), 'bplist00');
  assert.deepEqual(await plistToJson(await readFile(fresh), node), { ApplicationAccessibilityEnabled: true, AutomationEnabled: true });
  for (const [name, bytes, magic] of [['binary.plist', buildBinary({ Other: 'kept', AutomationEnabled: false }), 'bplist00'], ['xml.plist', build({ Other: 'kept', AutomationEnabled: false }), '<?xml ve']]) {
    await writeFile(join(dir, name), bytes);
    await setPlistBooleans(join(dir, name), keys, node);
    const written = await readFile(join(dir, name));
    assert.equal(written.subarray(0, 8).toString(), magic, name);
    assert.deepEqual(await plistToJson(written, node), { Other: 'kept', AutomationEnabled: true, ApplicationAccessibilityEnabled: true }, name);
  }
});

test('plist matches plutil where plutil exists', { skip: process.platform !== 'darwin' && 'plutil is macOS only' }, async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'binary.plist'), buildBinary(sample));
  assert.deepEqual(await plistToJson(build(sample), { platform: 'darwin' }), await plistToJson(build(sample), node));
  assert.equal(await plistValue(join(dir, 'binary.plist'), 'CFBundleIdentifier', { platform: 'darwin' }), await plistValue(join(dir, 'binary.plist'), 'CFBundleIdentifier', node));
  assert.deepEqual(await plistToJson(await jsonToXmlPlist(sample, { platform: 'darwin' }), node), sample);
});

test('the state directory stays in Application Support on macOS and follows XDG elsewhere', () => {
  assert.equal(defaultStateDir({ platform: 'darwin', env: { XDG_STATE_HOME: '/xdg' }, home: '/home/a' }), '/home/a/Library/Application Support/PokiMCP');
  assert.equal(defaultStateDir({ platform: 'linux', env: { XDG_STATE_HOME: '/xdg' }, home: '/home/a' }), '/xdg/poki');
  assert.equal(defaultStateDir({ platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.local/state/poki');
  assert.equal(defaultStateDir({ platform: 'linux', env: { XDG_STATE_HOME: 'relative' }, home: '/home/a' }), '/home/a/.local/state/poki');
});

test('an app bundle zips and unzips with its modes and symbolic links intact', async t => {
  const dir = await scratch(t), app = join(dir, 'Payload/Sample.app');
  await mkdir(join(app, 'Frameworks/Kit.framework/Versions/A'), { recursive: true });
  await writeFile(join(app, 'Info.plist'), buildBinary(sample));
  await writeFile(join(app, 'Sample'), Buffer.alloc(70000, 7), { mode: 0o755 });
  await writeFile(join(app, 'Empty'), '');
  await writeFile(join(app, 'Frameworks/Kit.framework/Versions/A/Kit'), 'kit', { mode: 0o755 });
  await symlink('Versions/A/Kit', join(app, 'Frameworks/Kit.framework/Kit'));
  const archive = join(dir, 'package.ipa');
  await zipDirectory(join(dir, 'Payload'), archive, node);
  const out = join(dir, 'out'); await mkdir(out);
  await unzipArchive(archive, out, node);
  const back = join(out, 'Payload/Sample.app');
  assert.equal(await plistValue(join(back, 'Info.plist'), 'CFBundleIdentifier', node), 'local.sample');
  assert.deepEqual(await readFile(join(back, 'Sample')), Buffer.alloc(70000, 7));
  assert.equal((await stat(join(back, 'Sample'))).mode & 0o777, 0o755);
  assert.equal((await readFile(join(back, 'Empty'))).length, 0);
  assert.ok((await lstat(join(back, 'Frameworks/Kit.framework/Kit'))).isSymbolicLink());
  assert.equal(await readlink(join(back, 'Frameworks/Kit.framework/Kit')), 'Versions/A/Kit');
  assert.equal(await readFile(join(back, 'Frameworks/Kit.framework/Kit'), 'utf8'), 'kit');
  if (existsSync('/usr/bin/unzip')) assert.ok(execFileSync('/usr/bin/unzip', ['-p', archive, 'Payload/Sample.app/Info.plist']).subarray(0, 8).equals(Buffer.from('bplist00')));
});

test('unzipping refuses entries that would land outside the destination', async t => {
  const dir = await scratch(t);
  for (const [label, prepare] of [
    ['parent path', async root => { await mkdir(join(root, 'x')); await writeFile(join(root, 'x/evil'), 'no'); }],
    ['through a link', async root => { await mkdir(join(root, 'x')); await symlink(dir, join(root, 'x/link')); await mkdir(join(root, 'x/linkdir')); await writeFile(join(root, 'x/linkdir/evil'), 'no'); }],
  ]) {
    const root = await mkdtemp(join(dir, 'src-')); await prepare(root);
    const archive = join(dir, `${label.replaceAll(' ', '-')}.zip`);
    await zipDirectory(join(root, 'x'), archive, node);
    const zip = await readFile(archive);
    // Rename entries in place to the hostile names; the lengths match, so the archive stays valid.
    const hostile = label === 'parent path' ? zip.toString('latin1').replaceAll('x/evil', '../evi') : zip.toString('latin1').replaceAll('x/linkdir/evil', 'x/link/abcdefg');
    await writeFile(archive, Buffer.from(hostile, 'latin1'));
    const out = await mkdtemp(join(dir, 'out-'));
    await assert.rejects(unzipArchive(archive, out, node), /outside the destination/, label);
    assert.equal(existsSync(join(dir, 'evi')) || existsSync(join(dir, 'abcdefg')), false, label);
  }
});

const humanServer = async (t, capabilities, onElicit) => {
  const server = createServer(async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify(await askHuman(args.reason, args.timeout_seconds)) }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'human-test', version: '1' }, { capabilities });
  if (onElicit) client.setRequestHandler('elicitation/create', onElicit);
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return async () => value(await client.callTool({ name: 'request_human_action', arguments: { reason: 'Unlock the phone', timeout_seconds: 5 } }));
};

test('off macOS, request_human_action asks the MCP client and counts only an accepted Done', { skip: process.platform === 'darwin' && 'macOS keeps its dialog' }, async t => {
  const asked = [];
  for (const [reply, status] of [[{ action: 'accept', content: { done: true } }, 'done'], [{ action: 'accept', content: { done: false } }, 'cancelled'], [{ action: 'decline' }, 'cancelled'], [{ action: 'cancel' }, 'cancelled']]) {
    const ask = await humanServer(t, { elicitation: { form: {} } }, request => { asked.push(request.params); return reply; });
    const result = await ask();
    assert.equal(result.status, status); assert.equal(result.completed, status === 'done');
  }
  assert.equal(asked.length, 4);
  assert.match(asked[0].message, /Unlock the phone/);
  assert.deepEqual(asked[0].requestedSchema.required, ['done']);
});

test('off macOS, with no elicitation and no dialog, nobody is reported as having confirmed', { skip: process.platform === 'darwin' && 'macOS keeps its dialog' }, async t => {
  const path = process.env.PATH; process.env.PATH = await scratch(t); t.after(() => { process.env.PATH = path; });
  const ask = await humanServer(t, {});
  const result = await ask();
  assert.equal(result.status, 'unavailable'); assert.equal(result.completed, false);
  assert.match(result.message, /Ask the user in your conversation/);
});

test('off macOS, get_clipboard on a phone returns the text without the macOS image-type probe', { skip: process.platform === 'darwin' && 'macOS runs the probe' }, async t => {
  const f = await fixture(t, { approvalMode: 'allow' });
  const result = await f.call('get_clipboard');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const clipboard = value(result);
  assert.equal(typeof clipboard.text, 'string');
  assert.ok(Array.isArray(clipboard.types));
  assert.equal(clipboard.image_check, 'unavailable');
  assert.equal('contains_image' in clipboard, false);
  assert.equal((await f.events()).some(e => e.request?.op === 'image_types'), false);
});

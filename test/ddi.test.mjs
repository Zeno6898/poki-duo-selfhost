// The developer disk image flow in src/ddi.mjs, with a fake device, a fake mirror and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import {
  parsePlist, cryptexPayloads, verifyDdiDir, resolveDdiSource, downloadDdi, ensureDdi,
  networkDeviceDdi, usbmuxdDeviceDdi, prepareDdi, bridgeArgs, MIRROR, MIRROR_FILES, XCODE_RESTORE, DISPLAY_SERVICE,
} from '../src/ddi.mjs';

// Small stand-ins for the mirror's payloads, and a BuildManifest.plist that declares their digests
// the way Apple's does (one mounter identity first, then the Cryptex1 identity).
const payloads = {
  'Image.dmg': Buffer.from('apfs image'),
  'Image.dmg.trustcache': Buffer.from('trust cache'),
  'Image.dmg.cryptex_info': Buffer.from('<plist/>'),
  'Image.dmg.root_hash': Buffer.from('root hash'),
};
const keys = { 'Cryptex1,GenericDmg': 'Image.dmg', 'Cryptex1,GenericTrustCache': 'Image.dmg.trustcache', 'Cryptex1,CryptexInfoPlist': 'Image.dmg.cryptex_info', 'Cryptex1,GenericVolume': 'Image.dmg.root_hash' };
const digest = bytes => createHash('sha384').update(bytes).digest('base64');
function manifest(files = payloads) {
  const entries = Object.entries(keys).map(([key, path]) => `
        <key>${key}</key>
        <dict>
          <key>Digest</key>
          <data>
          ${digest(files[path])}
          </data>
          <key>Info</key>
          <dict><key>Path</key><string>${path}</string><key>Personalize</key><true/></dict>
        </dict>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>BuildIdentities</key>
  <array>
    <dict>
      <key>ApChipID</key><string>0x8010</string>
      <key>Manifest</key>
      <dict><key>PersonalizedDMG</key><dict><key>Digest</key><data>AAAA</data></dict></dict>
    </dict>
    <dict>
      <key>Cryptex1,NonceDomain</key><integer>4</integer>
      <key>Cryptex1,UseProductClass</key><true/>
      <key>Manifest</key>
      <dict>${entries}
      </dict>
    </dict>
  </array>
  <key>ManifestVersion</key><integer>0</integer>
  <key>ProductBuildVersion</key><string>27A5228h</string>
</dict>
</plist>`;
}

async function scratch() { return mkdtemp(join(tmpdir(), 'poki-ddi-')); }
async function ddiDir(parent, files = payloads, text = manifest()) {
  const dir = join(parent, 'Xcode_iOS_DDI_Cryptex');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'BuildManifest.plist'), text);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  return dir;
}

// Serves the mirror's files from memory, and records the URLs asked for.
function fakeMirror(files = { 'BuildManifest.plist': Buffer.from(manifest()), ...payloads }, { status = {} } = {}) {
  const urls = [];
  const fetch = async url => {
    urls.push(url);
    const name = url.split('/').pop(), code = status[name] ?? (files[name] ? 200 : 404);
    return { ok: code === 200, status: code, arrayBuffer: async () => files[name] };
  };
  return { fetch, urls };
}

// A device whose display service turns on once install() is called (or never, with `works: false`).
function fakeDevice({ mounted = false, works = true, installResult = { installed: true } } = {}) {
  const calls = [];
  return {
    calls,
    async available() { calls.push('available'); return mounted; },
    async install(dir) { calls.push(['install', dir]); if (works) mounted = true; return installResult; },
  };
}

test('parsePlist reads the value types BuildManifest.plist uses', () => {
  const value = parsePlist(`<?xml version="1.0"?><plist version="1.0"><dict>
    <key>s</key><string>a &amp; b &lt;c&gt;</string><key>e</key><string/>
    <key>i</key><integer>-12</integer><key>big</key><integer>18446744073709551615</integer>
    <key>r</key><real>1.5</real><key>t</key><true/><key>f</key><false/>
    <key>d</key><data>
      aGVs
      bG8=
    </data><key>a</key><array><integer>1</integer><dict/><array/></array>
    <!-- a comment --><key>date</key><date>2026-11-06T00:00:00Z</date>
  </dict></plist>`);
  assert.equal(value.s, 'a & b <c>');
  assert.equal(value.e, '');
  assert.equal(value.i, -12);
  assert.equal(value.big, 18446744073709551615n);
  assert.equal(value.r, 1.5);
  assert.equal(value.t, true);
  assert.equal(value.f, false);
  assert.equal(value.d.toString(), 'hello');
  assert.deepEqual(value.a, [1, {}, []]);
  assert.equal(value.date.toISOString(), '2026-11-06T00:00:00.000Z');
  assert.throws(() => parsePlist('<plist><dict><string>x</string></dict></plist>'), /expected <key>/);
  assert.throws(() => parsePlist('<plist><string>x</plist>'), /not closed/);
});

test('cryptexPayloads picks the Cryptex1 identity and refuses unsafe or missing entries', () => {
  const found = cryptexPayloads(parsePlist(manifest()));
  assert.deepEqual(found.map(p => p.path), ['Image.dmg', 'Image.dmg.trustcache', 'Image.dmg.cryptex_info', 'Image.dmg.root_hash']);
  assert.equal(found[0].digest.length, 48);
  assert.throws(() => cryptexPayloads({ BuildIdentities: [{ Manifest: { PersonalizedDMG: {} } }] }), /no Cryptex1 build identity/);
  const escape = parsePlist(manifest().replace('<string>Image.dmg</string>', '<string>../../etc/passwd</string>'));
  assert.throws(() => cryptexPayloads(escape), /no usable path for Cryptex1,GenericDmg/);
});

test('verifyDdiDir checks every payload against its SHA-384 digest', async () => {
  const parent = await scratch();
  try {
    const dir = await ddiDir(parent);
    assert.deepEqual(await verifyDdiDir(dir), { build: '27A5228h' });
    await writeFile(join(dir, 'Image.dmg.trustcache'), 'tampered');
    await assert.rejects(verifyDdiDir(dir), /Image\.dmg\.trustcache does not match the SHA-384 digest/);
    await rm(join(dir, 'Image.dmg'));
    await assert.rejects(verifyDdiDir(dir), /Image\.dmg is missing/);
    await assert.rejects(verifyDdiDir(join(parent, 'nowhere')), /BuildManifest\.plist is missing/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('the DDI source is POKI_DDI_DIR, then Xcode on macOS, then the downloaded copy', async () => {
  const stateDir = '/var/lib/poki';
  const present = async path => path === join(XCODE_RESTORE, 'BuildManifest.plist');
  assert.deepEqual(await resolveDdiSource({ env: { POKI_DDI_DIR: ' /srv/ddi ' }, platform: 'darwin', stateDir, present }), { kind: 'override', dir: '/srv/ddi' });
  assert.deepEqual(await resolveDdiSource({ env: {}, platform: 'darwin', stateDir, present }), { kind: 'xcode', dir: XCODE_RESTORE });
  assert.deepEqual(await resolveDdiSource({ env: {}, platform: 'linux', stateDir, present }), { kind: 'download', dir: '/var/lib/poki/ddi/Xcode_iOS_DDI_Cryptex' });
  assert.deepEqual(await resolveDdiSource({ env: { POKI_DDI_DIR: '' }, platform: 'darwin', stateDir, present: async () => false }), { kind: 'download', dir: '/var/lib/poki/ddi/Xcode_iOS_DDI_Cryptex' });
});

test('downloadDdi fetches the mirror once, verifies it, and keeps it', async () => {
  const parent = await scratch();
  try {
    const dir = join(parent, 'state', 'ddi', 'Xcode_iOS_DDI_Cryptex');
    const mirror = fakeMirror();
    assert.deepEqual(await downloadDdi(dir, { fetch: mirror.fetch }), { downloaded: true, build: '27A5228h' });
    assert.deepEqual(mirror.urls, MIRROR_FILES.map(name => `${MIRROR}/${name}`));
    assert.deepEqual((await readdir(dir)).sort(), [...MIRROR_FILES].sort());
    assert.deepEqual(await readdir(join(parent, 'state', 'ddi')), ['Xcode_iOS_DDI_Cryptex']);
    // A verified copy is reused without touching the network.
    const again = fakeMirror();
    assert.deepEqual(await downloadDdi(dir, { fetch: again.fetch }), { downloaded: false, build: '27A5228h' });
    assert.deepEqual(again.urls, []);
    // A damaged copy is downloaded again.
    await writeFile(join(dir, 'Image.dmg'), 'damaged');
    const logs = [];
    assert.equal((await downloadDdi(dir, { fetch: fakeMirror().fetch, log: line => logs.push(line) })).downloaded, true);
    assert.match(logs[0], /failed its check/);
    assert.deepEqual(await readFile(join(dir, 'Image.dmg')), payloads['Image.dmg']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a failed or corrupt download leaves nothing behind and names the fix', async () => {
  const parent = await scratch();
  try {
    const dir = join(parent, 'ddi', 'Xcode_iOS_DDI_Cryptex');
    await assert.rejects(downloadDdi(dir, { fetch: fakeMirror(undefined, { status: { 'Image.dmg': 404 } }).fetch }), /HTTP 404\. Set POKI_DDI_DIR/);
    await assert.rejects(downloadDdi(dir, { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }), /ENOTFOUND\. Check the network, or set POKI_DDI_DIR/);
    const corrupt = fakeMirror({ 'BuildManifest.plist': Buffer.from(manifest()), ...payloads, 'Image.dmg.root_hash': Buffer.from('wrong') });
    await assert.rejects(downloadDdi(dir, { fetch: corrupt.fetch }), /root_hash does not match/);
    assert.deepEqual(await readdir(join(parent, 'ddi')), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('ensureDdi uses POKI_DDI_DIR as given and never downloads for it', async () => {
  const parent = await scratch();
  try {
    const dir = await ddiDir(parent);
    assert.deepEqual(await ensureDdi({ kind: 'override', dir }, { fetch: () => assert.fail('no download') }), { downloaded: false, build: '27A5228h' });
    await assert.rejects(ensureDdi({ kind: 'override', dir: join(parent, 'missing') }), /POKI_DDI_DIR points to .*missing, which does not exist/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('prepareDdi stops early when displayservice is already offered', async () => {
  const device = fakeDevice({ mounted: true });
  const logs = [];
  assert.deepEqual(await prepareDdi(device, { source: { kind: 'override', dir: '/nowhere' }, log: line => logs.push(line) }), { status: 'already_available' });
  assert.deepEqual(device.calls, ['available']);
  assert.deepEqual(logs, ['Device display service is already available.']);
});

test('prepareDdi downloads, installs and checks again on a new connection', async () => {
  const parent = await scratch();
  try {
    const device = fakeDevice();
    const mirror = fakeMirror();
    const result = await prepareDdi(device, { env: {}, platform: 'linux', stateDir: parent, fetch: mirror.fetch, log: () => {} });
    assert.deepEqual(result, { status: 'installed', build: '27A5228h' });
    const dir = join(parent, 'ddi', 'Xcode_iOS_DDI_Cryptex');
    assert.deepEqual(device.calls, ['available', ['install', dir], 'available']);
    assert.equal(mirror.urls.length, MIRROR_FILES.length);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('prepareDdi fails when the image installs but displayservice stays missing', async () => {
  const parent = await scratch();
  try {
    const dir = await ddiDir(parent);
    await assert.rejects(prepareDdi(fakeDevice({ works: false }), { source: { kind: 'override', dir }, log: () => {} }), /installed, but displayservice is still unavailable/);
    // A device whose display service appeared meanwhile is not checked again.
    const raced = fakeDevice({ works: false, installResult: { installed: false, already_available: true } });
    assert.deepEqual(await prepareDdi(raced, { source: { kind: 'override', dir }, log: () => {} }), { status: 'already_available' });
    assert.equal(raced.calls.length, 2);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a bad DDI never reaches the device', async () => {
  const parent = await scratch();
  try {
    const dir = await ddiDir(parent, { ...payloads, 'Image.dmg': Buffer.from('other') }, manifest());
    const device = fakeDevice();
    await assert.rejects(prepareDdi(device, { source: { kind: 'override', dir }, log: () => {} }), /Image\.dmg does not match/);
    assert.deepEqual(device.calls, ['available']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('the network device is prepared through bridge ops over the remote pairing tunnel', async () => {
  const target = { id: 'network-100.64.0.7', host: '100.64.0.7', rpPairingFile: '/srv/poki/rp.plist', hostName: 'us-light' };
  const calls = [];
  let mounted = false;
  const run = async (file, args, options) => {
    const request = JSON.parse(options.input);
    calls.push({ file, args, request, timeout: options.timeout });
    if (request.op === 'install_ddi') { mounted = true; return { stdout: JSON.stringify({ installed: true, already_available: false, identifier: 'com.apple.MobileAsset.DDI', version: '1' }) }; }
    return { stdout: JSON.stringify({ displayservice: mounted, cryptexd: true, services: 80, installed: null }) };
  };
  const device = networkDeviceDdi(run, target);
  assert.equal(await device.available(), false);
  assert.equal((await device.install('/srv/ddi')).installed, true);
  assert.equal(await device.available(), true);
  assert.deepEqual(calls.map(c => c.request), [{ op: 'ddi_status' }, { op: 'install_ddi', dir: '/srv/ddi' }, { op: 'ddi_status' }]);
  for (const call of calls) {
    assert.equal(call.file, join(root, 'build/poki-native'));
    assert.deepEqual(call.args, ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist', '--rp-host-name', 'us-light']);
  }
  // The install covers an upload and a round trip to Apple's signing server, under the bridge's 300 s limit.
  assert.ok(calls[1].timeout > 300000);
  assert.deepEqual(bridgeArgs({ host: '100.64.0.7', rpPairingFile: '/p' }), ['--host', '100.64.0.7', '--rp-pairing-file', '/p']);
});

test('a bridge failure is reported with the bridge\'s own message', async () => {
  const run = async () => { throw Object.assign(new Error('Command failed'), { stderr: '{"error":"The device does not offer com.apple.security.cryptexd.remote.","screen_change_verified":false}\n' }); };
  const device = networkDeviceDdi(run, { host: '100.64.0.7', rpPairingFile: '/p' });
  await assert.rejects(device.install('/srv/ddi'), /poki-native install_ddi failed: The device does not offer com\.apple\.security\.cryptexd\.remote/);
  const plain = networkDeviceDdi(async () => { throw new Error('spawn ENOENT'); }, { host: '100.64.0.7', rpPairingFile: '/p' });
  await assert.rejects(plain.available(), /poki-native ddi_status failed: spawn ENOENT/);
});

test('a usbmuxd device keeps the idevice-tools commands and checks their output', async () => {
  const calls = [];
  let mounted = false, confirm = true;
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[2] === 'remotexpc') return { stdout: mounted ? `${DISPLAY_SERVICE}\n` : 'com.apple.mobile.lockdown.remote.trusted\n', stderr: '' };
    mounted = confirm;
    return { stdout: confirm ? 'installed com.apple.MobileAsset.DDI 1\n' : '', stderr: confirm ? '' : 'TSS rejected the request\n' };
  };
  const device = usbmuxdDeviceDdi(run, '/opt/idevice-tools', '00008150-ABC');
  assert.equal(await device.available(), false);
  await device.install('/srv/ddi');
  assert.equal(await device.available(), true);
  assert.deepEqual(calls, [
    ['/opt/idevice-tools', '--udid', '00008150-ABC', 'remotexpc'],
    ['/opt/idevice-tools', '--udid', '00008150-ABC', 'cryptexd', 'install-ddi', '/srv/ddi'],
    ['/opt/idevice-tools', '--udid', '00008150-ABC', 'remotexpc'],
  ]);
  confirm = false;
  await assert.rejects(device.install('/srv/ddi'), /did not confirm installation\. TSS rejected the request/);
});

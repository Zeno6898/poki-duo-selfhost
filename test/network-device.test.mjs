import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import { networkTarget, networkDevice, nativeArgs, translate, runIdeviceTool, holdLocation } from '../src/network-device.mjs';
import { Devices } from '../src/device.mjs';

const env = { POKI_DEVICE_HOST: '100.64.0.7', POKI_RP_PAIRING_FILE: '/srv/poki/rp.plist' };
const id = 'network-100.64.0.7';
const native = join(root, 'build/poki-native');

function withEnv(values, body) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const restore = () => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; };
  return Promise.resolve().then(body).finally(restore);
}

// Answers a bridge call the way poki-native would, and records it.
function fakeBridge(responses) {
  const calls = [];
  const run = async (file, args, options) => {
    const request = JSON.parse(options.input);
    calls.push({ file, args, request, timeout: options.timeout });
    return { stdout: JSON.stringify(responses[request.op](request)), stderr: '' };
  };
  return { run, calls };
}

test('a network device needs both the host and the remote pairing file', () => {
  assert.deepEqual(networkTarget(env), { id, host: '100.64.0.7', rpPairingFile: '/srv/poki/rp.plist' });
  assert.equal(networkTarget({ POKI_DEVICE_HOST: '100.64.0.7' }), undefined);
  assert.equal(networkTarget({ POKI_RP_PAIRING_FILE: '/srv/poki/rp.plist' }), undefined);
  assert.equal(networkTarget({ POKI_DEVICE_HOST: ' ', POKI_RP_PAIRING_FILE: '/srv/poki/rp.plist' }), undefined);
  assert.equal(networkTarget({ ...env, POKI_RP_HOST_NAME: 'us-light' }).hostName, 'us-light');
  // Listings are shown to callers, so the inventory entry leaves the pairing file out.
  assert.deepEqual(networkDevice(env), { id, kind: 'physical', connection: 'Network', transport: 'remote_pairing', host: '100.64.0.7' });
  assert.equal(networkDevice({}), undefined);
});

test('usbmuxd devices keep the --udid bridge arguments', () => {
  assert.deepEqual(nativeArgs({ id: '00008150-ABC' }, env), ['--udid', '00008150-ABC']);
  assert.deepEqual(nativeArgs({ id }, {}), ['--udid', id]);
  assert.deepEqual(nativeArgs({ id }, env), ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist']);
  assert.deepEqual(nativeArgs({ id }, { ...env, POKI_RP_HOST_NAME: 'us-light' }), ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist', '--rp-host-name', 'us-light']);
});

test('every idevice-tools call Poki makes maps to a bridge request', () => {
  const cases = [
    [['lockdown', 'get', 'DeviceName'], { op: 'lockdown_get', key: 'DeviceName' }],
    [['lockdown', '--domain', 'com.apple.mobile.iTunes', 'get', 'ScreenScaleFactor'], { op: 'lockdown_get', domain: 'com.apple.mobile.iTunes', key: 'ScreenScaleFactor' }],
    [['screenshot', '/tmp/frame.png'], { op: 'screenshot', path: '/tmp/frame.png' }],
    [['rotate', 'left'], { op: 'rotate', direction: 'left' }],
    [['pasteboard', 'paste'], { op: 'pasteboard', action: 'get' }],
    [['pasteboard', 'items'], { op: 'pasteboard', action: 'items' }],
    [['location_simulation', 'clear'], { op: 'location', action: 'clear' }],
    [['configuration', 'appearance'], { op: 'configuration', method: 'get_appearance' }],
    [['configuration', 'appearance', 'dark'], { op: 'configuration', method: 'set_appearance', value: 'dark' }],
    [['configuration', 'text-size'], { op: 'configuration', method: 'get_text_size' }],
    [['configuration', 'text-size', 'accessibilityLarge'], { op: 'configuration', method: 'set_text_size', value: 'accessibilityLarge' }],
    [['configuration', 'reduce-motion'], { op: 'configuration', method: 'get_reduce_motion' }],
    [['configuration', 'reduce-motion', 'on'], { op: 'configuration', method: 'set_reduce_motion', value: true }],
    [['configuration', 'reduce-transparency'], { op: 'configuration', method: 'get_reduce_transparency' }],
    [['configuration', 'reduce-transparency', 'off'], { op: 'configuration', method: 'set_reduce_transparency', value: false }],
    [['configuration', 'increase-contrast', 'on'], { op: 'configuration', method: 'set_increase_contrast', value: true }],
  ];
  for (const [args, request] of cases) assert.deepEqual(translate(args).request, request, args.join(' '));
  assert.deepEqual(translate(['pasteboard', 'copy'], 'héllo').request, { op: 'pasteboard', action: 'set', text: 'héllo' });
});

test('calls the bridge does not cover say so instead of guessing', () => {
  for (const args of [['screencapture', '--stdout'], ['location_simulation', 'set', '1', '2'], ['lockdown', 'set', 'x', 'y'], ['configuration', 'increase-contrast'], ['configuration', 'opacity', '0.5'], ['rotate', 'left', 'extra'], []]) {
    assert.throws(() => translate(args), /not available for a network device/, args.join(' '));
  }
  assert.throws(() => translate(['configuration', 'reduce-motion', 'maybe']), /expected 'on' or 'off'/);
});

test('bridge results print the way idevice-tools does, so the existing parsers still match', async () => {
  const { run, calls } = fakeBridge({
    lockdown_get: r => ({ key: r.key, domain: r.domain ?? null, value: r.key === 'ScreenScaleFactor' ? 3 : 'Test Phone' }),
    screenshot: r => ({ path: r.path, bytes: 10 }),
    rotate: () => ({ orientation: 'LandscapeLeft', non_flat_orientation: 'LandscapeLeft', locked: false }),
    pasteboard: r => r.action === 'get' ? { text: null } : r.action === 'items' ? { items: [{ index: 0, uti: 'public.utf8-plain-text', state: 'inline', size: 5 }, { index: 1, uti: 'public.png', state: 'promised', size: null }] } : { copied: true, bytes: Buffer.byteLength(r.text) },
    location: () => ({ cleared: true }),
    configuration: r => r.method === 'get_appearance' ? { appearance: 'dark' } : r.method === 'get_text_size' ? { text_size: 'accessibilityLarge' } : r.method === 'set_appearance' ? { appearance: r.value } : r.method === 'set_text_size' ? { text_size: r.value } : { enabled: r.value ?? true },
  });
  const call = (args, input) => runIdeviceTool(run, id, args, { env, input });
  assert.equal(JSON.parse((await call(['lockdown', 'get', 'DeviceName'])).stdout), 'Test Phone');
  assert.equal(Number((await call(['lockdown', '--domain', 'com.apple.mobile.iTunes', 'get', 'ScreenScaleFactor'])).stdout), 3);
  assert.match((await call(['screenshot', '/tmp/frame.png'])).stdout, /Screenshot saved to:/);
  const rotation = (await call(['rotate', 'left'])).stdout;
  assert.equal(rotation.match(/non_flat_orientation:\s*(\w+)/)?.[1], 'LandscapeLeft');
  assert.doesNotMatch(rotation, /locked:\s*true/);
  assert.equal((await call(['pasteboard', 'paste'])).stdout, '');
  const items = (await call(['pasteboard', 'items'])).stdout;
  assert.deepEqual([...items.matchAll(/^\[\d+\] ([^:]+):/gm)].map(match => match[1]), ['public.utf8-plain-text', 'public.png']);
  assert.match((await call(['pasteboard', 'copy'], 'héllo')).stderr, /copied 6 byte/);
  assert.match((await call(['location_simulation', 'clear'])).stdout, /Location cleared!/);
  assert.equal((await call(['configuration', 'appearance'])).stdout, 'dark');
  assert.match((await call(['configuration', 'appearance', 'light'])).stdout, /appearance/);
  assert.equal((await call(['configuration', 'text-size'])).stdout.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), 'accessibility_large');
  for (const args of [['configuration', 'text-size', 'large'], ['configuration', 'reduce-motion', 'on'], ['configuration', 'increase-contrast', 'off'], ['configuration', 'reduce-transparency', 'on']]) {
    assert.match((await call(args)).stdout, /text size set|reduce motion|increase contrast|reduce transparency/, args.join(' '));
  }
  assert.equal((await call(['configuration', 'reduce-motion'])).stdout, 'true');
  for (const c of calls) {
    assert.equal(c.file, native);
    assert.deepEqual(c.args, ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist']);
    // Each call opens a new tunnel, so a short local deadline is raised.
    assert.ok(c.timeout >= 30000);
  }
});

test('a held location runs the bridge with the request on standard input', () => {
  const hold = holdLocation(id, 37.33, -122.03, env);
  assert.equal(hold.file, native);
  assert.deepEqual(hold.args, ['--host', '100.64.0.7', '--rp-pairing-file', '/srv/poki/rp.plist']);
  assert.deepEqual(JSON.parse(hold.input), { op: 'location', action: 'set', latitude: 37.33, longitude: -122.03 });
  assert.ok('{"location_set":true,"latitude":37.33,"longitude":-122.03}'.includes(hold.ready));
});

test('the configured device is the inventory, without usbmuxd discovery', () => withEnv(env, async () => {
  const devices = new Devices(), runs = [];
  devices.run = async (file, args) => { runs.push(file); throw new Error(`unexpected ${file}`); };
  const list = await devices.inventory(true);
  assert.deepEqual(list.filter(d => d.kind === 'physical'), [{ id, kind: 'physical', connection: 'Network', transport: 'remote_pairing', host: '100.64.0.7', name: id }]);
  assert.ok(!runs.includes('python3'));
}));

test('device calls go to the bridge for the network device and to idevice-tools otherwise', () => withEnv(env, async () => {
  const devices = new Devices(), runs = [];
  devices.run = async (file, args, timeout, input) => {
    runs.push({ file, args, input });
    if (file === native) return { stdout: JSON.stringify({ key: 'DeviceName', domain: null, value: 'Test Phone' }), stderr: '' };
    return { stdout: '"USB Phone"', stderr: '' };
  };
  devices.target = async () => ({ id, kind: 'physical' });
  assert.equal(JSON.parse((await devices.native(['lockdown', 'get', 'DeviceName'])).stdout), 'Test Phone');
  assert.equal(runs.at(-1).file, native);
  assert.deepEqual(JSON.parse(runs.at(-1).input), { op: 'lockdown_get', key: 'DeviceName' });
  devices.target = async () => ({ id: '00008150-ABC', kind: 'physical' });
  await devices.native(['lockdown', 'get', 'DeviceName']);
  assert.equal(runs.at(-1).file.endsWith('idevice-tools'), true);
  assert.deepEqual(runs.at(-1).args, ['--udid', '00008150-ABC', 'lockdown', 'get', 'DeviceName']);
}));

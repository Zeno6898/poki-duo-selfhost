// A phone configured by address instead of found through usbmuxd. POKI_DEVICE_HOST and
// POKI_RP_PAIRING_FILE (and optionally POKI_RP_HOST_NAME) name one device that the native bridge
// reaches through the phone's remote pairing service. idevice-tools cannot reach such a device: each
// subcommand starts CoreDeviceProxy over lockdown, which iOS closes on networks such as a tailnet.
// So the idevice-tools calls Poki makes are answered here by bridge ops, in the output format the
// callers already parse. Devices found through usbmuxd never come through this module.
import { join } from 'node:path';
import { root, networkTarget } from './config.mjs';

export { networkTarget };

export const transport = 'remote_pairing';

// The inventory entry. It carries no pairing file path, because device listings are shown to callers.
export function networkDevice(env = process.env) {
  const target = networkTarget(env);
  return target && { id: target.id, kind: 'physical', connection: 'Network', transport, host: target.host };
}

export function isNetworkId(id, env = process.env) {
  return id !== undefined && networkTarget(env)?.id === id;
}

// The poki-native arguments that select the device.
export function nativeArgs(target, env = process.env) {
  if (!isNetworkId(target.id, env)) return ['--udid', target.id];
  const { host, rpPairingFile, hostName } = networkTarget(env);
  return ['--host', host, '--rp-pairing-file', rpPairingFile, ...(hostName ? ['--rp-host-name', hostName] : [])];
}

// A call opens a new tunnel, which takes several round trips on a relayed path, so a caller's
// short deadline for a local idevice-tools call is raised to this.
const minimumTimeout = 30000;
const native = () => join(root, 'build/poki-native');

async function bridge(run, id, request, env, timeout = 95000) {
  const { stdout } = await run(native(), nativeArgs({ id }, env), { input: JSON.stringify(request), timeout });
  return JSON.parse(stdout);
}

const toggle = value => ({ on: true, off: false })[value];
const settings = { 'reduce-motion': ['reduce_motion', 'reduce motion'], 'reduce-transparency': ['reduce_transparency', 'reduce transparency'], 'increase-contrast': ['increase_contrast', 'increase contrast'] };

// The bridge request for an idevice-tools argument list (without --udid), and how to print its
// result the way idevice-tools does. Throws for a subcommand the bridge does not cover.
export function translate(args, input) {
  const [command, ...rest] = args;
  const unsupported = () => { throw new Error(`idevice-tools ${command ?? ''} is not available for a network device configured with POKI_DEVICE_HOST; it needs USB or usbmuxd.`); };
  switch (command) {
    case 'lockdown': {
      let domain, key;
      if (rest[0] === '--domain' && rest[2] === 'get' && rest.length === 4) [domain, key] = [rest[1], rest[3]];
      else if (rest[0] === 'get' && rest.length === 2) key = rest[1];
      else unsupported();
      return { request: { op: 'lockdown_get', ...(domain ? { domain } : {}), key }, print: result => JSON.stringify(result.value) };
    }
    case 'screenshot':
      if (rest.length !== 1) unsupported();
      return { request: { op: 'screenshot', path: rest[0] }, print: result => `Screenshot saved to: ${result.path}` };
    case 'rotate':
      if (rest.length > 1) unsupported();
      return {
        request: { op: 'rotate', direction: rest[0] ?? 'left' },
        print: r => `OrientationState {\n    orientation: ${r.orientation},\n    non_flat_orientation: ${r.non_flat_orientation},\n    locked: ${r.locked},\n}`,
      };
    case 'pasteboard':
      if (rest[0] === 'paste' && rest.length === 1) return { request: { op: 'pasteboard', action: 'get' }, print: r => r.text ?? '' };
      if (rest[0] === 'items' && rest.length === 1) return { request: { op: 'pasteboard', action: 'items' }, print: r => r.items.map(i => `[${i.index}] ${i.uti}: ${i.state}${i.size == null ? '' : ` ${i.size} bytes`}`).join('\n') };
      if (rest[0] === 'copy' && rest.length <= 2) {
        const text = rest[1] ?? input ?? '';
        return { request: { op: 'pasteboard', action: 'set', text }, print: () => '', stderr: r => `copied ${r.bytes} byte(s) to the device pasteboard` };
      }
      return unsupported();
    case 'location_simulation':
      if (rest[0] === 'clear' && rest.length === 1) return { request: { op: 'location', action: 'clear' }, print: () => 'Location cleared!' };
      return unsupported();
    case 'configuration': {
      const [name, value, ...extra] = rest;
      if (extra.length) unsupported();
      const configuration = (method, v, print) => ({ request: { op: 'configuration', method, ...(v === undefined ? {} : { value: v }) }, print });
      if (name === 'appearance') return value === undefined
        ? configuration('get_appearance', undefined, r => r.appearance)
        : configuration('set_appearance', value, r => `appearance set to ${r.appearance}`);
      if (name === 'text-size') return value === undefined
        ? configuration('get_text_size', undefined, r => r.text_size)
        : configuration('set_text_size', value, r => `text size set to ${r.text_size}`);
      const setting = settings[name];
      if (!setting) return unsupported();
      if (value === undefined) {
        if (name === 'increase-contrast') return unsupported();
        return configuration(`get_${setting[0]}`, undefined, r => String(r.enabled));
      }
      if (toggle(value) === undefined) throw new Error(`expected 'on' or 'off', got ${JSON.stringify(value)}`);
      return configuration(`set_${setting[0]}`, toggle(value), r => `${setting[1]} ${r.enabled}`);
    }
    default: return unsupported();
  }
}

// Runs an idevice-tools argument list against the network device and answers in idevice-tools'
// output format. `run(file, args, { input, timeout })` resolves to { stdout, stderr }.
export async function runIdeviceTool(run, id, args, { input, timeout, env = process.env } = {}) {
  const { request, print, stderr } = translate(args, input);
  const result = await bridge(run, id, request, env, Math.max(timeout ?? 95000, minimumTimeout));
  return { stdout: print(result), stderr: stderr ? stderr(result) : '' };
}

// The command that sets and holds a simulated location until it is killed, and the output that
// says the device accepted it.
export function holdLocation(id, latitude, longitude, env = process.env) {
  return {
    file: native(), args: nativeArgs({ id }, env),
    input: JSON.stringify({ op: 'location', action: 'set', latitude, longitude }),
    ready: '"location_set":true',
  };
}

// The developer disk image (DDI) that a phone needs before it offers developer services such as
// displayservice, screenshots and accessibility. bin/prepare-device.mjs drives the flow:
//
// 1. Ask the device whether displayservice is already there. If it is, stop.
// 2. Find a Cryptex1 DDI: POKI_DDI_DIR if set, else Xcode's on macOS, else a copy downloaded once to
//    the state directory from the doronz88/DeveloperDiskImage mirror (the files pymobiledevice3's
//    `mounter auto-mount` uses). Every payload is checked against the SHA-384 digest its
//    BuildManifest.plist declares.
// 3. Install it through cryptexd, which personalizes it with Apple's signing server (TSS) for this
//    device. Over the remote pairing tunnel the bridge does this (`install_ddi`); through usbmuxd
//    idevice-tools does (`cryptexd install-ddi`).
// 4. Ask again on a new connection, and fail unless displayservice is now offered.
//
// Phones of the iPhone 18 series have no image mounter build identity in Apple's DDI, so the
// mounter's personalized route cannot serve them; the Cryptex1 route serves every phone from
// iOS 17.4.
//
// Apple's files are downloaded at run time and never committed.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { root, stateDir as defaultStateDir, networkTarget } from './config.mjs';

export const DISPLAY_SERVICE = 'com.apple.coredevice.displayservice';
export const XCODE_RESTORE = '/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore';
export const MIRROR = 'https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/main/PersonalizedImages/Xcode_iOS_DDI_Cryptex';
export const MANIFEST = 'BuildManifest.plist';
export const PAYLOAD_KEYS = ['Cryptex1,GenericDmg', 'Cryptex1,GenericTrustCache', 'Cryptex1,CryptexInfoPlist', 'Cryptex1,GenericVolume'];
// The fixed names the mirror publishes the payloads under, which its BuildManifest.plist declares.
export const MIRROR_FILES = [MANIFEST, 'Image.dmg', 'Image.dmg.trustcache', 'Image.dmg.cryptex_info', 'Image.dmg.root_hash'];

// ---- XML property lists ----

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = text => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) =>
  name[0] === '#' ? String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : entities[name] ?? whole);

// Parses an XML property list into plain values: data becomes a Buffer, integers become numbers
// (or BigInt past 2^53), dates become Date. Enough for Apple's BuildManifest.plist.
export function parsePlist(xml) {
  const text = String(xml);
  const tag = /<(\/?)([a-zA-Z]+)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g;
  let match;
  const next = () => {
    while ((match = tag.exec(text))) if (match[2]) return { close: !!match[1], name: match[2], empty: !!match[3], end: tag.lastIndex };
    return undefined;
  };
  const body = (name, start) => {
    const close = text.indexOf(`</${name}>`, start);
    if (close < 0) throw new Error(`Malformed property list: <${name}> is not closed.`);
    tag.lastIndex = close + name.length + 3;
    return text.slice(start, close);
  };
  const value = token => {
    if (!token || token.close) throw new Error('Malformed property list: expected a value.');
    const { name, empty, end } = token;
    switch (name) {
      case 'dict': {
        const out = {};
        if (empty) return out;
        for (;;) {
          const key = next();
          if (key?.close && key.name === 'dict') return out;
          if (key?.name !== 'key') throw new Error('Malformed property list: expected <key> in <dict>.');
          const k = key.empty ? '' : unescape(body('key', key.end));
          out[k] = value(next());
        }
      }
      case 'array': {
        const out = [];
        if (empty) return out;
        for (;;) {
          const item = next();
          if (item?.close && item.name === 'array') return out;
          out.push(value(item));
        }
      }
      case 'string': return empty ? '' : unescape(body('string', end));
      case 'integer': {
        const raw = body('integer', end).trim();
        const big = BigInt(raw);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : big;
      }
      case 'real': return Number(body('real', end).trim());
      case 'true': return true;
      case 'false': return false;
      case 'data': return Buffer.from(empty ? '' : body('data', end).replace(/\s+/g, ''), 'base64');
      case 'date': return new Date(body('date', end).trim());
      case 'plist': {
        const inner = value(next());
        return inner;
      }
      default: throw new Error(`Malformed property list: unexpected <${name}>.`);
    }
  };
  return value(next());
}

// ---- The DDI directory ----

// The build identity carrying the Cryptex1 payloads, and the file and digest of each.
export function cryptexPayloads(manifest) {
  const identity = (manifest?.BuildIdentities ?? []).find(id => PAYLOAD_KEYS.every(key => id?.Manifest?.[key]));
  if (!identity) throw new Error('BuildManifest.plist has no Cryptex1 build identity. Use a DDI from Xcode 15.3 or later, or the mirror\'s Xcode_iOS_DDI_Cryptex directory.');
  return PAYLOAD_KEYS.map(key => {
    const entry = identity.Manifest[key];
    const path = entry.Info?.Path, digest = entry.Digest;
    if (typeof path !== 'string' || !path || path.split('/').includes('..') || path.startsWith('/')) throw new Error(`BuildManifest.plist gives no usable path for ${key}.`);
    if (!Buffer.isBuffer(digest)) throw new Error(`BuildManifest.plist gives no digest for ${key}.`);
    return { key, path, digest };
  });
}

const sha384 = bytes => createHash('sha384').update(bytes).digest();

// Checks every payload in `dir` against the digest in its BuildManifest.plist. Returns the DDI build.
export async function verifyDdiDir(dir) {
  const manifestPath = join(dir, MANIFEST);
  const manifest = parsePlist(await readFile(manifestPath, 'utf8').catch(error => {
    throw new Error(error.code === 'ENOENT' ? `${manifestPath} is missing. The DDI directory must hold an unpacked Cryptex1 Restore directory.` : `Cannot read ${manifestPath}: ${error.message}`);
  }));
  for (const { path, digest } of cryptexPayloads(manifest)) {
    const file = join(dir, path);
    const bytes = await readFile(file).catch(error => { throw new Error(error.code === 'ENOENT' ? `${file} is missing.` : `Cannot read ${file}: ${error.message}`); });
    if (!sha384(bytes).equals(digest)) throw new Error(`${file} does not match the SHA-384 digest in ${MANIFEST}. Delete the directory and run again.`);
  }
  return { build: manifest.ProductBuildVersion ?? 'unknown' };
}

const exists = path => access(path).then(() => true, () => false);

// Where the DDI comes from: POKI_DDI_DIR, Xcode's on macOS, or the downloaded copy.
export async function resolveDdiSource({ env = process.env, platform = process.platform, stateDir = defaultStateDir, present = exists } = {}) {
  const override = env.POKI_DDI_DIR?.trim();
  if (override) return { kind: 'override', dir: override };
  if (platform === 'darwin' && await present(join(XCODE_RESTORE, MANIFEST))) return { kind: 'xcode', dir: XCODE_RESTORE };
  return { kind: 'download', dir: join(stateDir, 'ddi', 'Xcode_iOS_DDI_Cryptex') };
}

// Downloads the mirror's Cryptex1 DDI into `dir` unless a verified copy is already there. Files land
// in a sibling directory first and move into place only after every digest matches.
export async function downloadDdi(dir, { fetch = globalThis.fetch, baseUrl = MIRROR, log = () => {} } = {}) {
  if (await exists(join(dir, MANIFEST))) {
    try { return { downloaded: false, ...(await verifyDdiDir(dir)) }; } catch (error) { log(`The saved developer disk image failed its check (${error.message}); downloading it again.`); }
  }
  const partial = `${dir}.partial-${process.pid}`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    for (const name of MIRROR_FILES) {
      const url = `${baseUrl}/${name}`;
      log(`Downloading ${name}…`);
      let response;
      try { response = await fetch(url); } catch (error) { throw new Error(`Cannot download ${url}: ${error.message}. Check the network, or set POKI_DDI_DIR to a DDI copied by hand.`); }
      if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}. Set POKI_DDI_DIR to a DDI copied by hand.`);
      await writeFile(join(partial, name), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    }
    const result = await verifyDdiDir(partial);
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    await rm(dir, { recursive: true, force: true });
    await rename(partial, dir);
    return { downloaded: true, ...result };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

// Makes sure `source.dir` holds a verified DDI, downloading it when it is the downloaded copy.
export async function ensureDdi(source, options = {}) {
  if (source.kind === 'download') return downloadDdi(source.dir, options);
  if (!await exists(source.dir)) throw new Error(source.kind === 'override' ? `POKI_DDI_DIR points to ${source.dir}, which does not exist.` : `${source.dir} does not exist.`);
  return { downloaded: false, ...(await verifyDdiDir(source.dir)) };
}

// ---- Talking to the device ----

const bridgePath = () => join(root, 'build/poki-native');

export function bridgeArgs(target) {
  return ['--host', target.host, '--rp-pairing-file', target.rpPairingFile, ...(target.hostName ? ['--rp-host-name', target.hostName] : [])];
}

// One bridge call. `run(file, args, { input, timeout })` resolves to { stdout } or rejects with an
// error carrying the bridge's stderr, whose JSON names the failure.
async function bridge(run, target, request, timeout) {
  try {
    const { stdout } = await run(bridgePath(), bridgeArgs(target), { input: JSON.stringify(request), timeout });
    return JSON.parse(stdout);
  } catch (error) {
    let message = error.message;
    try { message = JSON.parse(String(error.stderr ?? '').trim().split('\n').pop()).error ?? message; } catch {}
    throw new Error(`poki-native ${request.op} failed: ${message}`);
  }
}

// The device side of the flow for the network (remote pairing) target, through the bridge.
export function networkDeviceDdi(run, target) {
  return {
    async available() { return (await bridge(run, target, { op: 'ddi_status' }, 95000)).displayservice === true; },
    async install(dir) { return bridge(run, target, { op: 'install_ddi', dir }, 310000); },
  };
}

// The device side for a usbmuxd device, through idevice-tools as before. idevice-tools often exits 0
// on failure, so the install checks its output.
export function usbmuxdDeviceDdi(run, idevice, udid) {
  const call = args => run(idevice, ['--udid', udid, ...args], { timeout: 310000 });
  return {
    async available() { return (await call(['remotexpc'])).stdout.includes(DISPLAY_SERVICE); },
    async install(dir) {
      const { stdout, stderr } = await call(['cryptexd', 'install-ddi', dir]);
      if (!/installed com\.apple\.MobileAsset\.DDI|is already installed/.test(stdout)) throw new Error(`The device did not confirm installation.${stderr ? ` ${String(stderr).trim().split('\n').pop()}` : ''}`);
      return { installed: true };
    },
  };
}

// The whole flow. `device` is one of the two above.
export async function prepareDdi(device, { source, log = console.log, ...options } = {}) {
  if (await device.available()) {
    log('Device display service is already available.');
    return { status: 'already_available' };
  }
  const resolved = source ?? await resolveDdiSource(options);
  const { build, downloaded } = await ensureDdi(resolved, { log, ...options });
  log(`${downloaded ? 'Downloaded and verified' : 'Verified'} developer disk image ${build} (${resolved.kind === 'download' ? 'downloaded copy' : resolved.kind === 'override' ? 'POKI_DDI_DIR' : 'Xcode'}).`);
  log('Personalizing and installing the developer disk image on the device…');
  const result = await device.install(resolved.dir);
  if (result?.already_available) {
    log('The device already offers display service.');
    return { status: 'already_available' };
  }
  if (!await device.available()) throw new Error('The image is installed, but displayservice is still unavailable. Check that Developer Mode is on, then restart the phone and run this again.');
  log('Developer disk image installed; the device now exposes displayservice.');
  return { status: 'installed', build };
}

export { networkTarget };

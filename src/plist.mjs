import { readFile, writeFile } from 'node:fs/promises';
import { build, buildBinary, parse } from 'plist';
import { execute } from './work.mjs';

// Property lists without Apple's plutil. macOS keeps calling plutil with the same arguments
// as before, so its behavior does not change; every other host uses the plist package, which
// reads XML, binary (bplist00) and OpenStep lists and writes XML and binary ones.
const usePlutil = platform => platform === 'darwin';
const binaryMagic = Buffer.from('bplist00');
const isBinary = bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(binaryMagic);

function decode(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return isBinary(bytes) ? parse(new Uint8Array(bytes)) : parse(bytes.toString('utf8'));
}

// Plain JSON values. plutil -convert json refuses dates and data; here dates become ISO
// strings and data becomes base64.
function plain(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

// Parses a property list in any of its formats, as `plutil -convert json -o - -` does.
export async function plistToJson(data, { platform = process.platform } = {}) {
  if (usePlutil(platform)) return JSON.parse((await execute('plutil', ['-convert', 'json', '-o', '-', '-'], { input: data })).stdout);
  return plain(decode(data));
}

// Reads one top-level scalar, as `plutil -extract <key> raw -o - <path>` does.
export async function plistValue(path, key, { platform = process.platform } = {}) {
  if (usePlutil(platform)) return (await execute('plutil', ['-extract', key, 'raw', '-o', '-', path])).stdout.trim();
  const value = decode(await readFile(path))?.[key];
  if (value === undefined || value === null || typeof value === 'object') throw new Error(`${path} has no ${key} value.`);
  return String(value);
}

// Serializes a JSON object to an XML property list, as `plutil -convert xml1 -o - -` does.
export async function jsonToXmlPlist(object, { platform = process.platform } = {}) {
  if (usePlutil(platform)) return (await execute('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(object) })).stdout;
  return build(object);
}

// Sets top-level booleans to true in a property list file, creating an empty binary list when
// the file does not exist, as `plutil -create binary1` and `plutil -replace <key> -bool true` do.
// An existing list keeps its format.
export async function setPlistBooleans(path, keys, { create = false, platform = process.platform } = {}) {
  if (usePlutil(platform)) {
    if (create) await execute('plutil', ['-create', 'binary1', path]);
    for (const key of keys) await execute('plutil', ['-replace', key, '-bool', 'true', path]);
    return;
  }
  const bytes = create ? undefined : await readFile(path);
  const list = bytes ? decode(bytes) : {};
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error(`${path} is not a dictionary property list.`);
  for (const key of keys) list[key] = true;
  await writeFile(path, !bytes || isBinary(bytes) ? Buffer.from(buildBinary(list)) : build(list));
}

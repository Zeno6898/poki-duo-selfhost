import { readFileSync } from 'node:fs';
import { readdir, stat, access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root } from './config.mjs';

export const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const execute = promisify(execFile);
const bridge = join(root, 'build/poki-native');
export const ocrPath = join(root, 'build/ocr');
export const ocrMissing = `Text recognition is not installed on this server: ${ocrPath} is missing. Build it with bin/build-ocr-linux on Linux or bin/build-native on macOS. Without it there is no fallback when accessibility shows nothing; use take_screenshot and coordinates.`;

// The OCR helper is a separate build, so a deployment can lack it while everything else works.
export async function ocrStatus() {
  return { available: await access(ocrPath, constants.X_OK).then(() => true, () => false), path: ocrPath };
}
export async function warnIfOcrMissing() {
  if (!(await ocrStatus()).available) console.error(`Warning: ${ocrMissing}`);
}

async function codeMarker() {
  const files = (await readdir(join(root, 'src'), { recursive: true }))
    .filter(file => file.endsWith('.mjs')).map(file => join('src', file));
  files.push('package.json', 'build/poki-native');
  return JSON.stringify(await Promise.all(files.sort().map(async file => {
    const info = await stat(join(root, file)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return [file, info && [info.mtimeMs, info.ctimeMs, info.size, info.ino]];
  })));
}

const startupCode = await codeMarker();

export async function requireCurrentCode() {
  if (await codeMarker() !== startupCode) {
    throw new Error('The service is running old code. Stop the running service and restart it with npm start.');
  }
}

export async function buildInfo() {
  const [commit, native] = await Promise.all([
    execute('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 1000 }).then(result => result.stdout.trim(), () => 'unknown'),
    stat(bridge).catch(() => null),
  ]);
  return { commit, native_build: native?.mtime.toISOString() ?? 'unknown' };
}

export async function warnIfNativeStale() {
  const native = await stat(bridge).catch(() => null);
  if (!native) return;
  const directory = join(root, 'native/bridge');
  const files = await readdir(directory, { recursive: true }).catch(() => []);
  for (const file of files.filter(file => /(?:\.rs|Cargo\.toml|Cargo\.lock)$/.test(file) && !file.split('/').includes('target'))) {
    const source = await stat(join(directory, file)).catch(() => null);
    if (source?.mtimeMs > native.mtimeMs) {
      console.error('Warning: build/poki-native is older than its source; run ./bin/build-native when the device is available. Continuing with the existing bridge.');
      return;
    }
  }
}

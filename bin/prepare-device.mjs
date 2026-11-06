#!/usr/bin/env node
// Makes sure the phone exposes its developer services (displayservice) by installing the developer
// disk image when it is missing. See src/ddi.mjs for the flow and docs/physical-iphone.md for use.
//
// usage: node bin/prepare-device.mjs [DEVICE_ID]
//
// With POKI_DEVICE_HOST and POKI_RP_PAIRING_FILE set, it prepares that network device through the
// bridge. Otherwise it picks the one connected usbmuxd device, or DEVICE_ID.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root, idevice } from '../src/config.mjs';
import { networkTarget, networkDeviceDdi, usbmuxdDeviceDdi, prepareDdi } from '../src/ddi.mjs';

const execute = promisify(execFile);
const run = (file, args, { input, timeout } = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(Object.assign(error, { stdout, stderr }));
    resolve({ stdout, stderr });
  });
  child.stdin.end(input);
});

async function device() {
  const network = networkTarget();
  const selected = process.argv[2];
  if (network) {
    if (selected && selected !== network.id) throw new Error(`POKI_DEVICE_HOST selects ${network.id}; unset it to prepare ${selected}.`);
    return networkDeviceDdi(run, network);
  }
  const { stdout } = await execute('python3', [join(root, 'native/devices.py')], { timeout: 8000 });
  const ids = [...new Set(JSON.parse(stdout).map(d => d.id).filter(Boolean))];
  const udid = selected ?? (ids.length === 1 ? ids[0] : undefined);
  if (!udid || !ids.includes(udid)) throw new Error('Connect one unlocked, trusted iPhone, or pass a connected device id.');
  return usbmuxdDeviceDdi(run, idevice, udid);
}

try {
  await prepareDdi(await device());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

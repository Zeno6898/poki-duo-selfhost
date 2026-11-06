// Fork-only (poki-remote): spawn-per-op against poki-bridged on a real phone, with the timings
// printed. Skipped unless POKI_BRIDGE_DEVICE_TEST=1 and a network device is configured
// (POKI_DEVICE_HOST, POKI_RP_PAIRING_FILE, optionally POKI_RP_HOST_NAME). It taps
// POKI_BRIDGE_TEST_TAP (HID units "x,y", default the status bar clock, which only scrolls to the
// top) and reads the accessibility tree. POKI_NATIVE and POKI_BRIDGED name the binaries
// (default build/poki-native and build/poki-bridged). POKI_BRIDGE_DEVICE_ASSERT=0 prints without
// checking the targets: a warm tap under 500 ms and a warm ax_tree under 1000 ms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, networkTarget } from '../src/config.mjs';
import { nativeArgs } from '../src/network-device.mjs';
import { BridgeDaemon } from '../src/bridge-daemon.mjs';

const target = networkTarget();
const enabled = process.env.POKI_BRIDGE_DEVICE_TEST === '1' && target;
const nativeBinary = process.env.POKI_NATIVE ?? join(root, 'build/poki-native');
const [x, y] = (process.env.POKI_BRIDGE_TEST_TAP ?? '6000,1200').split(',').map(Number);

const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
async function timed(fn) { const started = performance.now(); await fn(); return Math.round(performance.now() - started); }

test('poki-bridged against spawn-per-op on the configured phone', { skip: !enabled && 'set POKI_BRIDGE_DEVICE_TEST=1 and POKI_DEVICE_HOST/POKI_RP_PAIRING_FILE', timeout: 600000 }, async () => {
  const args = nativeArgs({ id: target.id });
  const spawned = request => new Promise((resolve, reject) => {
    const child = execFile(nativeBinary, args, { timeout: 95000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin.end(JSON.stringify(request));
  });
  const dir = mkdtempSync(join(tmpdir(), 'pbd-device-'));
  const daemon = new BridgeDaemon(args, { ...process.env, POKI_BRIDGED_SOCKET_DIR: dir });
  const tap = { op: 'tap', x, y }, ax = { op: 'ax_tree', include_offscreen: false };
  const rows = [];
  try {
    const spawnTap = [], spawnAx = [];
    for (let i = 0; i < 3; i++) { spawnTap.push(await timed(() => spawned(tap))); spawnAx.push(await timed(() => spawned(ax))); }
    rows.push(['spawn-per-op tap', spawnTap], ['spawn-per-op ax_tree', spawnAx]);

    const coldAx = await timed(() => daemon.run(ax));
    const coldTap = await timed(() => daemon.run(tap));
    rows.push(['daemon cold ax_tree (start + tunnel)', [coldAx]], ['daemon first tap (media + HID open)', [coldTap]]);
    const warmTap = [], warmAx = [], steps = [];
    for (let i = 0; i < 5; i++) {
      warmTap.push(await timed(() => daemon.run(tap)));
      warmAx.push(await timed(() => daemon.run(ax)));
      // One agent step as tap does it today: tree, tap, settle, tree.
      steps.push(await timed(async () => { await daemon.run(ax); await daemon.run(tap); await new Promise(r => setTimeout(r, 600)); await daemon.run(ax); }));
    }
    rows.push(['daemon warm tap', warmTap], ['daemon warm ax_tree', warmAx], ['daemon tree+tap+600ms+tree', steps]);
    console.log('\nbridge timings (ms)');
    for (const [name, list] of rows) console.log(`  ${name.padEnd(40)} median ${String(median(list)).padStart(6)}   all ${list.join(', ')}`);
    console.log(`  last daemon op: ${JSON.stringify(daemon.last)}`);
    if (process.env.POKI_BRIDGE_DEVICE_ASSERT !== '0') {
      assert.ok(median(warmTap) < 500, `warm tap median ${median(warmTap)} ms`);
      assert.ok(median(warmAx) < 1000, `warm ax_tree median ${median(warmAx)} ms`);
    }
  } finally {
    await import('node:net').then(({ createConnection }) => createConnection(daemon.path).on('error', () => {}).end('{"op":"shutdown"}\n'));
    rmSync(dir, { recursive: true, force: true });
  }
});

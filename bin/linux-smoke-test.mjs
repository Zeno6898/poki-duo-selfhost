#!/usr/bin/env node
// Phase 0 smoke test: proves that this host reaches a phone's developer services over the network
// (for example a Tailscale tailnet) with a saved pairing file, with no USB cable attached.
//
// usage: node bin/linux-smoke-test.mjs --host IP --pairing-file PATH
//          [--tap-label Settings] [--taps 10] [--skip-lock-cycle] [--out FILE]
//
// Before running: the phone is unlocked on the home screen, and the icon named by --tap-label
// (default "Settings") is visible on the current home screen page.
//
// POKI_HID_OPEN_MS and POKI_HID_CLOSE_MS pass through to the bridge to try longer input waits.
//
// The script prints a Markdown table for docs/linux-smoke-test.md. It never prints the pairing file,
// the phone's address, its name, or screen contents, and deletes the screenshot it takes.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_SERVICES = ['com.apple.coredevice.displayservice', 'com.apple.accessibility.axAuditDaemon.remoteAXService'];
const usage = 'usage: node bin/linux-smoke-test.mjs --host IP --pairing-file PATH [--tap-label LABEL] [--taps N] [--skip-lock-cycle] [--out FILE] [--idevice-tools PATH] [--bridge PATH]';

function parseArgs(argv) {
  const options = {
    tapLabel: 'Settings', taps: 10, lockCycle: true,
    ideviceTools: process.env.IDEVICE_TOOLS ?? join(root, '.deps/idevice/target/release/idevice-tools'),
    bridge: join(root, 'build/poki-native'),
  };
  const names = { '--host': 'host', '--pairing-file': 'pairingFile', '--tap-label': 'tapLabel', '--taps': 'taps', '--out': 'out', '--idevice-tools': 'ideviceTools', '--bridge': 'bridge' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-lock-cycle') { options.lockCycle = false; continue; }
    if (argv[i] === '-h' || argv[i] === '--help') { console.log(usage); process.exit(0); }
    const key = names[argv[i]];
    if (!key || i + 1 >= argv.length) throw new Error(usage);
    options[key] = argv[++i];
  }
  if (!options.host || !options.pairingFile) throw new Error(usage);
  options.taps = Number(options.taps);
  if (!Number.isInteger(options.taps) || options.taps < 1 || options.taps > 100) throw new Error('--taps must be 1..100');
  return options;
}

const options = (() => { try { return parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); } })();
const target = ['--host', options.host, '--pairing-file', options.pairingFile];

// Keep the phone's address and the pairing file path out of everything this script prints.
const redact = text => String(text).split(options.host).join('<phone>').split(options.pairingFile).join('<pairing-file>').trim();
const brief = text => { const line = redact(text).split('\n').filter(Boolean).slice(-1)[0] ?? ''; return line.length > 160 ? `${line.slice(0, 157)}...` : line; };

function run(file, args, { input, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: error && typeof error.code !== 'number' ? error.message : undefined });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// idevice-tools reports many failures on standard error but still exits 0.
async function tools(args, timeout) {
  const result = await run(options.ideviceTools, [...target, ...args], { timeout });
  const failed = result.code !== 0 || result.error || /error|unable|panicked|failed/i.test(result.stderr);
  if (failed) throw new Error(brief(result.error ?? (result.stderr || result.stdout || `exit ${result.code}`)));
  return result.stdout.trim();
}

async function bridge(request, timeout = 95000) {
  const result = await run(options.bridge, target, { input: JSON.stringify(request), timeout });
  if (result.code !== 0 || result.error) {
    let message = result.error ?? result.stderr;
    try { message = JSON.parse(result.stderr).error ?? message; } catch {}
    throw new Error(brief(message));
  }
  return JSON.parse(result.stdout);
}

const plistString = text => text.trim().replace(/^"(.*)"$/s, '$1');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pngSize(data) {
  const signature = '89504e470d0a1a0a';
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== signature) throw new Error('Screenshot is not a PNG.');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

// Same mapping as hidPoint in src/device.mjs: logical points to the HID range 0..65535.
function hidPoint(x, y, width, height) {
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Point ${x},${y} is outside the ${width} × ${height} screen.`);
  return [Math.round(x / (width - 1) * 65535), Math.round(y / (height - 1) * 65535)];
}

function findElement(tree, label) {
  const elements = tree.elements ?? [];
  return elements.find(e => e.label === label && e.frame) ?? elements.find(e => e.label?.toLowerCase() === label.toLowerCase() && e.frame);
}

const rows = [];
const facts = {};
async function step(name, action) {
  const started = performance.now();
  let result, notes, ok;
  try { notes = await action(); ok = notes?.ok ?? true; notes = notes?.notes ?? notes; result = ok ? 'pass' : 'fail'; }
  catch (error) { ok = false; result = 'fail'; notes = brief(error.message); }
  const ms = Math.round(performance.now() - started);
  rows.push({ name, result, ms, notes: String(notes ?? '') });
  console.error(`${result === 'pass' ? '✓' : result === 'skip' ? '-' : '✗'} ${name} (${ms} ms) ${notes ?? ''}`);
  return ok;
}

async function lockdownStep(label) {
  return step(label, async () => {
    const name = plistString(await tools(['lockdown', 'get', 'DeviceName'], 20000));
    if (!name) throw new Error('DeviceName was empty.');
    for (const key of ['ProductVersion', 'ProductType', 'BuildVersion']) {
      facts[key] ??= await tools(['lockdown', 'get', key], 20000).then(plistString, () => 'unknown');
    }
    return `DeviceName returned (${name.length} characters)`;
  });
}

async function screenshotStep(label) {
  return step(label, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'poki-smoke-'));
    try {
      const file = join(dir, 'screen.png');
      await tools(['screenshot', file], 30000);
      const size = pngSize(await readFile(file));
      const scale = Number(plistString(await tools(['lockdown', '--domain', 'com.apple.mobile.iTunes', 'get', 'ScreenScaleFactor'], 20000)));
      if (!Number.isFinite(scale) || scale <= 0 || scale > 5) throw new Error('Could not read ScreenScaleFactor.');
      facts.screen = { width: Math.round(size.width / scale), height: Math.round(size.height / scale), scale };
      return `${size.width} × ${size.height} PNG, scale ${scale} (deleted)`;
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

async function tapStep(label) {
  return step(label, async () => {
    if (!facts.screen) throw new Error('Needs the screen size from a passing screenshot step.');
    const { width, height } = facts.screen;
    let landed = 0;
    const latencies = [], failures = [];
    for (let i = 1; i <= options.taps; i++) {
      try {
        await bridge({ op: 'button', button: 'home' });
        await sleep(1000);
        const before = await bridge({ op: 'ax_tree' });
        const icon = findElement(before, options.tapLabel);
        if (!icon) throw new Error(`"${options.tapLabel}" is not on the current home screen page`);
        const [x, y] = hidPoint(icon.frame.x + icon.frame.width / 2, icon.frame.y + icon.frame.height / 2, width, height);
        const started = performance.now();
        await bridge({ op: 'tap', x, y });
        latencies.push(performance.now() - started);
        let changed = false;
        for (let attempt = 0; attempt < 3 && !changed; attempt++) {
          await sleep(700);
          const after = await bridge({ op: 'ax_tree' });
          const was = before.foreground_app?.bundle_id, now = after.foreground_app?.bundle_id;
          changed = Boolean(now && now !== was) || ((after.elements?.length ?? 0) > 0 && !findElement(after, options.tapLabel));
        }
        if (changed) landed++; else failures.push(`tap ${i}: no change`);
      } catch (error) { failures.push(`tap ${i}: ${brief(error.message)}`); }
    }
    await bridge({ op: 'button', button: 'home' }).catch(() => {});
    facts.taps ??= [];
    facts.taps.push(`${landed}/${options.taps}`);
    const median = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
    const notes = `${landed}/${options.taps} landed${median ? `, median tap call ${Math.round(median)} ms` : ''}${failures.length ? `; ${failures.slice(0, 2).join('; ')}` : ''}`;
    return { ok: landed >= Math.ceil(options.taps * 0.9), notes };
  });
}

async function main() {
  console.error(`Phase 0 smoke test against <phone> (tap target "${options.tapLabel}", ${options.taps} taps)`);
  await lockdownStep('1 Lockdown');

  let missing;
  await step('2 Tunnel', async () => {
    const services = await tools(['remotexpc'], 60000);
    missing = REQUIRED_SERVICES.filter(name => !services.includes(name));
    const count = (services.match(/"com\.apple\.[^"]+"/g) ?? []).length;
    return { ok: missing.length === 0, notes: missing.length ? `missing ${missing.join(', ')}` : `RSD handshake done, ${count} services, both required present` };
  });
  rows.push(!missing ? { name: '3 DDI', result: 'skip', ms: 0, notes: 'Not checked: step 2 did not complete' }
    : missing.length ? { name: '3 DDI', result: 'fail', ms: 0, notes: 'Required services missing: mount the Developer Disk Image, then rerun' }
    : { name: '3 DDI', result: 'skip', ms: 0, notes: 'Not needed: services already present' });

  await screenshotStep('4 Screenshot');
  await step('5 AX read', async () => {
    const tree = await bridge({ op: 'ax_tree' });
    const framed = (tree.elements ?? []).filter(e => e.frame).length;
    if (!framed) throw new Error('No elements with frames.');
    return `${tree.elements.length} elements, ${framed} with frames, foreground ${tree.foreground_app?.bundle_id ?? 'unknown'}`;
  });
  await tapStep('6 Tap');

  if (options.lockCycle) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    await prompt.question('\nLock the phone with the side button, wait 10 seconds, unlock it, go to the home page with the tap target, then press Enter. ');
    prompt.close();
    await lockdownStep('7 Lock cycle: lockdown');
    await screenshotStep('7 Lock cycle: screenshot');
    await tapStep('7 Lock cycle: tap');
  } else rows.push({ name: '7 Lock cycle', result: 'skip', ms: 0, notes: '--skip-lock-cycle' });

  const passed = rows.every(row => row.result !== 'fail');
  const lines = [
    `## Phase 0 results, ${new Date().toISOString().slice(0, 10)}`,
    '',
    `- Result: ${passed ? 'pass' : 'fail'}`,
    `- Phone: ${facts.ProductType ?? 'unknown'}, iOS ${facts.ProductVersion ?? 'unknown'} (${facts.BuildVersion ?? 'unknown'})`,
    `- Host: ${process.platform} ${process.arch}, Node ${process.versions.node}, transport TCP with pairing file, no USB`,
    `- Tap landing: ${facts.taps?.join(', then after lock cycle ') ?? 'not run'} (target "${options.tapLabel}")`,
    '',
    '| Step | Result | Time (ms) | Notes |',
    '| --- | --- | ---: | --- |',
    ...rows.map(row => `| ${row.name} | ${row.result} | ${row.ms} | ${row.notes.replaceAll('|', '\\|')} |`),
    '',
  ];
  const table = lines.join('\n');
  console.log(table);
  if (options.out) await writeFile(options.out, table);
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => { console.error(brief(error.stack ?? error.message)); process.exit(1); });

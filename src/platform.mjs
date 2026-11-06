import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execute, pause, checkWork, signal, deadline, stopped, stoppingReason, phase } from './work.mjs';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { idevice, stateDir, root } from './config.mjs';
import { startRecording, stopRecording, closeRecordings } from './recording.mjs';
import { openInput, selectKeyboard } from './simulator-input.mjs';
import { holdLocation, isNetworkId, nativeArgs, runIdeviceTool } from './network-device.mjs';

const launchReadyMs = 10000;

const states = new WeakMap();
function state(ctx) {
  if (!states.has(ctx)) states.set(ctx, { locations: new Map(), builds: new Map() });
  return states.get(ctx);
}

export function platformRun(file, args, options) { return execute(file, args, options); }

const simctl = async args => (await platformRun('xcrun', ['simctl', ...args])).stdout.trim();
const physical = async (id, args, expect) => {
  const result = isNetworkId(id) ? await runIdeviceTool(platformRun, id, args) : await platformRun(idevice, ['--udid', id, ...args]);
  if (expect && !expect.test(result.stdout + '\n' + result.stderr)) throw new Error(`Device service did not confirm the action: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result;
};
async function configuration(target, method, value) {
  const { stdout } = await platformRun(join(root, 'build/poki-native'), nativeArgs(target), { input: JSON.stringify({ op: 'configuration', method, ...(value === undefined ? {} : { value }) }) });
  return JSON.parse(stdout);
}

async function devicectl(id, args, timeout = 60000) {
  const result = await platformRun('xcrun', ['devicectl', ...args.slice(0, 3), '--device', id, '--json-output', '-', ...args.slice(3)], { timeout });
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new Error(`devicectl returned no JSON: ${result.stderr.slice(-2000)}`); }
  if (response.info?.outcome !== 'success') throw new Error(JSON.stringify(response.error ?? response.info));
  return response.result;
}

function absolutePath(value) {
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error('Path must be absolute (or start with ~/).');
  return resolve(expanded);
}

async function newDirectory(parent, prefix) {
  const base = absolutePath(parent);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, prefix));
}

export async function inventorySimulators() {
  const listing = JSON.parse(await simctl(['list', 'devices', 'available', '--json']));
  return Object.entries(listing.devices).flatMap(([runtime, devices]) => devices.map(device => ({
    id: device.udid, name: device.name, kind: 'simulator', connection: 'Simulator', state: device.state,
    model: device.deviceTypeIdentifier?.split('.').at(-1), runtime,
    osVersion: runtime.split('.').at(-1).replace(/^iOS-/, '').replaceAll('-', '.'),
    dataPath: device.dataPath,
  })));
}

export async function simulatorModels() {
  const listing = JSON.parse(await simctl(['list', '--json']));
  const runtime = listing.runtimes.filter(r => r.isAvailable && r.identifier.includes('.iOS-'))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  return { runtime, models: listing.devicetypes.filter(d => /iPhone|iPad/.test(d.name)).map(d => ({ name: d.name, id: d.identifier })) };
}

async function prepareSimulatorAccessibility(target) {
  if (!target.dataPath) throw new Error('CoreSimulator did not report the simulator data directory.');
  const directory = join(target.dataPath, 'Library/Preferences');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'com.apple.Accessibility.plist');
  const temporary = await mkdtemp(join(directory, '.poki-mcp-accessibility-'));
  const staged = join(temporary, 'preferences.plist');
  try {
    try { await copyFile(path, staged, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await platformRun('plutil', ['-create', 'binary1', staged]); }
    for (const key of ['ApplicationAccessibilityEnabled', 'AutomationEnabled']) await platformRun('plutil', ['-replace', key, '-bool', 'true', staged]);
    await chmod(staged, 0o600);
    await rename(staged, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function waitForSimulatorAccessibility(target) {
  // A cold boot on a busy Mac can take longer than 20 seconds to report a foreground app, without needing a restart.
  const deadline = Date.now() + 60000;
  let lastError;
  do {
    try {
      const { stdout } = await platformRun(join(root, 'build/simulator'), [], { timeout: 45000, input: JSON.stringify({ id: target.id, op: 'ax' }) });
      const tree = JSON.parse(stdout);
      if (tree.pid > 0 && tree.elements?.length) return;
      lastError = 'No foreground accessibility elements were returned.';
    } catch (error) { lastError = error.message; }
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error(`Simulator ${target.id} booted, but accessibility is not ready. ${lastError} If accessibility was enabled after apps launched, restart this simulator to initialize their accessibility servers.`);
}

async function startSimulator(ctx, args) {
  let matches;
  let created = false;
  if (args.model) {
    const { runtime, models } = await simulatorModels();
    if (!runtime) throw new Error('No available iOS Simulator runtime. Install one in Xcode.');
    matches = models.filter(model => model.id === args.model || model.name.toLowerCase() === args.model.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected one simulator model; found ${matches.length}. Use list_devices include_all_simulators=true.`);
    checkWork();
    if (ctx.coordinator.owned(ctx)) throw new Error('Release the current device lease before creating another simulator.');
    ctx.access({ id: `simulator-model:${matches[0].id}` });
    const id = await simctl(['create', `Poki MCP ${matches[0].name}`, matches[0].id, runtime.identifier]);
    matches = [{ id, state: 'Shutdown' }];
    created = true;
  } else {
    const name = args.simulator ?? args.device;
    if (!name) throw new Error('Give simulator (name or UDID) or model.');
    matches = (await inventorySimulators()).filter(d => d.id === name || d.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected one simulator; found ${matches.length}. Specify its UDID.`);
  }
  const target = (await inventorySimulators()).find(device => device.id === matches[0].id);
  if (!target) throw new Error('The selected simulator disappeared before boot.');
  ctx.access(target); ctx.resolved = target;
  ctx.changed(target);
  if (target.state === 'Shutdown') {
    // SpringBoard reads ApplicationAccessibilityEnabled at launch, so setting it
    // after bootstatus is too late for the first foreground accessibility query.
    await prepareSimulatorAccessibility(target);
    await simctl(['boot', target.id]);
  } else if (!['Booted', 'Booting'].includes(target.state)) throw new Error(`Simulator is ${target.state}; wait for that transition to finish before starting it.`);
  await platformRun('xcrun', ['simctl', 'bootstatus', target.id, '-b'], { timeout: 180000 });
  await simctl(['spawn', target.id, 'defaults', 'write', 'com.apple.Accessibility', 'ApplicationAccessibilityEnabled', '-bool', 'true']);
  await simctl(['spawn', target.id, 'defaults', 'write', 'com.apple.Accessibility', 'AutomationEnabled', '-bool', 'true']);
  await waitForSimulatorAccessibility(target);
  ctx.selected = target.id;
  ctx.frame = undefined;
  ctx.elements = [];
  return { ...(await inventorySimulators()).find(d => d.id === target.id), created, selected: true, accessibility_ready: true };
}

async function apps(target, includeSystem = false) {
  if (target.kind === 'simulator') {
    const plist = await simctl(['listapps', target.id]);
    const { stdout } = await platformRun('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist });
    return Object.entries(JSON.parse(stdout)).map(([id, app]) => ({
      bundle_id: id, name: app.CFBundleDisplayName ?? app.CFBundleName ?? id,
      system: app.ApplicationType === 'System', version: app.CFBundleShortVersionString,
      path: app.Path, executable: app.CFBundleExecutable,
    })).filter(app => includeSystem || !app.system);
  }
  const { stdout } = await platformRun(join(root, 'build/poki-native'), nativeArgs(target), { input: JSON.stringify({ op: 'list_apps' }), timeout: 95000 });
  return JSON.parse(stdout).apps.filter(app => includeSystem || !app.system);
}

const appDirectories = new WeakMap();
function appDirectory(ctx) {
  if (!appDirectories.has(ctx.coordinator)) appDirectories.set(ctx.coordinator, new Map());
  return appDirectories.get(ctx.coordinator);
}
async function refreshApps(ctx, target) {
  let result;
  try { result = target.kind === 'physical' ? await ctx.bridge({ op: 'list_apps' }) : { apps: await apps(target, true) }; }
  catch (error) {
    if (stopped(error) || target.kind !== 'physical' || !/bad device|connection.*closed|disconnected/i.test(error.message)) throw error;
    result = await ctx.bridge({ op: 'list_apps' });
  }
  const directory = { apps: result.apps, localized_names: result.localized_names, at: performance.now() };
  appDirectory(ctx).set(target.id, directory);
  return directory;
}
async function launchAppMatch(ctx, target, query) {
  const directory = appDirectory(ctx), cached = directory.get(target.id);
  let cacheHit = Boolean(cached && performance.now() - cached.at < 300000);
  let all = (cacheHit ? cached : await refreshApps(ctx, target)).apps;
  const normalized = query.toLowerCase();
  const matches = list => {
    const names = app => [app.name, ...(app.aliases ?? [])].filter(name => typeof name === 'string').map(name => name.toLowerCase());
    const exact = list.filter(app => app.bundle_id === query || names(app).includes(normalized));
    return exact.length ? exact : list.filter(app => normalized && names(app).some(name => name.includes(normalized)));
  };
  let found = matches(all);
  if (found.length !== 1 && cacheHit) {
    cacheHit = false; all = (await refreshApps(ctx, target)).apps; found = matches(all);
  }
  if (!found.length) throw new Error('No installed app matches the given name.');
  if (found.length !== 1) throw new Error('Multiple installed apps match the given name; give an explicit bundle_id.');
  return { app: found[0], cache_hit: cacheHit };
}

async function resolveApp(target, args) {
  const all = await apps(target, true);
  const query = args.bundle_id ?? args.name ?? args.app;
  if (!query) throw new Error('Give bundle_id or name.');
  const matches = all.filter(app => app.bundle_id === query || app.name.toLowerCase() === query.toLowerCase());
  if (matches.length !== 1) throw new Error(`Expected one installed app matching ${JSON.stringify(query)}; found ${matches.length}.`);
  return matches[0];
}

async function launch(ctx, target, args) {
  const argv = [...(args.arguments ?? [])];
  if (args.language) argv.push('-AppleLanguages', `(${args.language})`);
  if (args.locale) argv.push('-AppleLocale', args.locale);
  const testLaunch = argv.length || Object.keys(args.environment ?? {}).length;
  let result;
  if (target.kind === 'physical') {
    const query = args.bundle_id ?? args.name ?? args.app;
    if (!query) throw new Error('Give bundle_id or name.');
    let lookup, bundle = args.bundle_id;
    if (!bundle) {
      try {
        lookup = await phase('app_lookup', () => launchAppMatch(ctx, target, query));
        bundle = lookup.app.bundle_id;
      } catch (error) {
        return { isError: true, outcome: 'not_sent', launched: false, foreground_verified: false, error: error.message,
          instruction: 'No app was launched. The application directory could not resolve this name. Retry list_apps when the device connection is ready, then use the verified bundle_id; do not guess an identifier.',
          ...(stopped(error) ? { stop_reason: stoppingReason(error) } : {}) };
      }
    }
    const metadata = lookup ? { _meta: { app_lookup: { cache_hit: lookup.cache_hit } } } : {};
    let launched = {};
    try {
      launched = await phase('app_launch', () => ctx.bridge({ op: 'launch_app', bundle_id: bundle,
        arguments: argv, environment: args.environment ?? {}, terminate_existing: Boolean(testLaunch) }));
      if (launched.isError) return { ...launched, ...metadata, foreground_verified: false, ...(launched.outcome === 'unknown' ? { stop_reason: 'unknown' } : {}) };
      if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0) throw new Error('Launch service returned no valid PID.');
      ctx.frame = undefined; ctx.elements = [];
      await phase('foreground_verification', () => deadline(8000, async () => {
        let lastError = new Error('The launched app did not become the observed foreground.');
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const tree = await deadline(2500, () => phase('foreground_query', () => ctx.bridge({ op: 'ax', include_offscreen: false })));
            if (tree.foreground?.pid === launched.pid) return;
          } catch (error) {
            checkWork();
            if (error.name !== 'TimeoutError') throw error;
            lastError = error;
          }
          if (attempt < 2) await pause(100);
        }
        throw lastError;
      }));
      return { ...launched, ...(lookup ? { name: lookup.app.name } : {}), ...metadata, foreground_verified: true };
    } catch (error) {
      return { ...launched, ...metadata, isError: true, outcome: 'unknown', foreground_verified: false,
        stop_reason: stopped(error) ? stoppingReason(error) : 'unknown', error: error.message,
        instruction: 'Launch may have occurred. Inspect the screen before deciding the next action; do not automatically relaunch.' };
    }
  }
  const app = await resolveApp(target, args);
  if (target.kind === 'simulator') {
    const env = { ...process.env };
    for (const [key, value] of Object.entries(args.environment ?? {})) env[`SIMCTL_CHILD_${key}`] = value;
    const command = ['simctl', 'launch', ...(testLaunch ? ['--terminate-running-process'] : []), target.id, app.bundle_id, ...argv];
    await selectKeyboard(target.id);
    openInput(target.id);
    const response = await platformRun('xcrun', command, { env });
    const pid = Number(response.stdout.trim().split(':').at(-1));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Launch returned no PID: ${response.stdout}`);
    result = { pid };
  }
  ctx.frame = undefined; ctx.elements = [];
  return { bundle_id: app.bundle_id, name: app.name, launched: true, ...result, ...await interfaceReady(ctx, result?.pid) };
}

// simctl returns before the app draws: SpringBoard stays in front, then the app reports no elements
// for a few seconds. A tap in that gap fails as if its target did not exist.
async function interfaceReady(ctx, pid) {
  const started = performance.now();
  while (performance.now() - started < launchReadyMs) {
    checkWork();
    const seen = await ctx.structure().catch(error => { if (stopped(error)) throw error; });
    if (seen?.foreground?.pid === pid && seen.elements.length) return { interface_ready: true, ...ctx.inBatch ? {} : { screen: (await ctx.readback()).screen } };
    await pause(100);
  }
  return { interface_ready: false, ...ctx.inBatch ? {} : { screen: (await ctx.readback()).screen }, instruction: `The app reported no readable elements within ${launchReadyMs / 1000} seconds. Use take_screenshot to look, or wait_for if it is still loading.` };
}

async function applicationMutation(target, request, verify) {
  let recovery;
  if (request.op === 'install_app') {
    request = { ...request, staging_id: randomUUID() };
    const directory = join(stateDir, 'install', 'operations');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${request.staging_id}.json`);
    const record = { bundle_id: request.bundle_id, device_id: target.id,
      device_staging_directory: `PublicStaging/poki-${request.staging_id}`, status: 'prepared' };
    await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    recovery = { path, record };
  }
  let receipt = {}, result;
  try {
    const { stdout } = await platformRun(join(root, 'build/poki-native'), nativeArgs(target), {
      input: JSON.stringify(request), timeout: request.op === 'install_app' ? 185000 : 95000,
    });
    receipt = JSON.parse(stdout);
    if (receipt.isError) result = { ...receipt, ...(receipt.outcome === 'unknown' ? { stop_reason: 'unknown' } : {}) };
    else {
      if (receipt.outcome !== 'completed') throw new Error('Application service returned no completion receipt.');
      result = { ...receipt, ...await verify(), inventory_verified: true };
    }
  } catch (error) {
    result = { ...receipt, isError: true, outcome: receipt.outcome ?? 'unknown', inventory_verified: false,
      ...(receipt.outcome === 'completed' ? { verification_outcome: 'unknown' } : {}),
      stop_reason: stopped(error) ? stoppingReason(error) : 'unknown', error: error.message,
      instruction: receipt.outcome === 'completed'
        ? 'The device service confirmed completion, but the installed app list could not be verified. Inspect the list; do not repeat the operation.'
        : 'The application operation may have occurred. Inspect the installed app list before taking another action; do not automatically repeat it.' };
  }
  if (recovery) {
    if (receipt.staging_cleanup?.removed === true) {
      try { await rm(recovery.path); }
      catch (error) { result = { ...result, recovery_record: recovery.path, recovery_record_cleanup_error: error.message }; }
    } else {
      result = { ...result, recovery_record: recovery.path, device_staging_directory: recovery.record.device_staging_directory,
        staging_cleanup: receipt.staging_cleanup ?? { removed: false, unconfirmed: true } };
      try { await writeFile(recovery.path, JSON.stringify({ ...recovery.record, status: receipt.outcome ?? 'unknown', cleanup_confirmed: false })); }
      catch (error) { result.recovery_record_update_error = error.message; }
    }
  }
  return result;
}

async function install(target, value) {
  const path = absolutePath(value);
  await access(path, constants.R_OK);
  let source = path;
  let temporary;
  try {
    if (extname(path).toLowerCase() === '.ipa') {
      if (target.kind === 'simulator') throw new Error('A simulator requires a simulator-built .app, not an .ipa.');
      temporary = await newDirectory(join(stateDir, 'install'), 'ipa-');
      await platformRun('ditto', ['-x', '-k', path, temporary]);
      const bundles = (await readdir(join(temporary, 'Payload'))).filter(f => f.endsWith('.app'));
      if (bundles.length !== 1) throw new Error('The .ipa must contain exactly one Payload/*.app.');
      source = join(temporary, 'Payload', bundles[0]);
    }
    if (extname(source).toLowerCase() !== '.app' || !(await stat(source)).isDirectory()) throw new Error('Install expects an .app directory or .ipa archive.');
    const { stdout } = await platformRun('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(source, 'Info.plist')]);
    const bundle = stdout.trim();
    if (target.kind === 'simulator') await simctl(['install', target.id, source]);
    else {
      let archive = path;
      if (extname(path).toLowerCase() !== '.ipa') {
        temporary = await newDirectory(join(stateDir, 'install'), 'app-');
        const payload = join(temporary, 'Payload');
        await mkdir(payload);
        await cp(source, join(payload, basename(source)), { recursive: true, verbatimSymlinks: true });
        archive = join(temporary, 'package.ipa');
        await platformRun('ditto', ['-c', '-k', '--keepParent', payload, archive]);
      }
      return await applicationMutation(target, { op: 'install_app', ipa_path: archive, bundle_id: bundle }, async () => {
        const app = (await apps(target, true)).find(app => app.bundle_id === bundle);
        if (!app) throw new Error('Install completed, but the installed app was not found.');
        return { installed: true, ...app };
      });
    }
    const app = (await apps(target, true)).find(app => app.bundle_id === bundle);
    if (!app) throw new Error('Install command completed, but the installed app was not found.');
    return { installed: true, ...app };
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

export async function readSettings(target) {
  if (target.kind === 'simulator') {
    return {
      appearance: await simctl(['ui', target.id, 'appearance']),
      text_size: (await simctl(['ui', target.id, 'content_size'])).replaceAll('-', '_'),
      increase_contrast: (await simctl(['ui', target.id, 'increase_contrast'])) === 'enabled',
      reduce_motion: null, reduce_transparency: null,
      note: 'Simulator external APIs cannot read/set Reduce Motion or Reduce Transparency; use its Settings app.',
    };
  }
  const read = async key => (await physical(target.id, ['configuration', key])).stdout.trim();
  const contrast = (await configuration(target, 'get_increase_contrast')).increaseContrast?.enabled;
  if (typeof contrast !== 'boolean') throw new Error('Device configuration returned no Increase Contrast state.');
  return { appearance: await read('appearance'), text_size: (await read('text-size')).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), reduce_motion: (await read('reduce-motion')) === 'true', reduce_transparency: (await read('reduce-transparency')) === 'true', increase_contrast: contrast };
}

const settingsPages = {
  wifi: 'WIFI', bluetooth: 'Bluetooth', cellular: 'MOBILE_DATA_SETTINGS_ID', personal_hotspot: 'INTERNET_TETHERING', vpn: 'VPN',
  notifications: 'NOTIFICATIONS_ID', sounds: 'Sounds', focus: 'DO_NOT_DISTURB', screen_time: 'SCREEN_TIME', general: 'General',
  about: 'General&path=About', software_update: 'General&path=SOFTWARE_UPDATE_LINK', keyboard: 'General&path=Keyboard',
  language_region: 'General&path=INTERNATIONAL', date_time: 'General&path=DATE_AND_TIME', device_management: 'General&path=ManagedConfigurationList',
  display: 'DISPLAY', accessibility: 'ACCESSIBILITY', wallpaper: 'Wallpaper', siri: 'SIRI', control_center: 'ControlCenter',
  camera: 'CAMERA', battery: 'BATTERY_USAGE', safari: 'SAFARI', privacy: 'Privacy', location: 'Privacy&path=LOCATION',
  privacy_photos: 'Privacy&path=PHOTOS', privacy_camera: 'Privacy&path=CAMERA', privacy_contacts: 'Privacy&path=CONTACTS',
  privacy_calendars: 'Privacy&path=CALENDARS', privacy_reminders: 'Privacy&path=REMINDERS', privacy_tracking: 'Privacy&path=USER_TRACKING', privacy_motion: 'Privacy&path=MOTION',
};

async function openURLTransport(target, url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('URL must include a scheme.'); }
  if (!parsed.protocol) throw new Error('URL must include a scheme.');
  if (target.kind === 'simulator') await simctl(['openurl', target.id, url]);
  else await devicectl(target.id, ['device', 'process', 'openURL', url]);
}

async function observeScreen(ctx) {
  const frame = await ctx.capture();
  const top = Math.min(64, frame.height - 1), bottom = Math.min(34, frame.height - top - 1);
  const pixels = await sharp(frame.data).extract({ left: 0, top, width: frame.width, height: frame.height - top - bottom }).resize(64, 96).removeAlpha().greyscale().raw().toBuffer();
  const foreground = await ctx.bridge({ op: 'ax' }).then(tree => tree.foreground, () => null);
  return { pixels, foreground };
}

function screenChanged(before, after) {
  let difference = 0;
  for (let index = 0; index < before.pixels.length; index++) difference += Math.abs(before.pixels[index] - after.pixels[index]);
  return difference / (before.pixels.length * 255) > 0.002;
}

async function observeAction(ctx, action) {
  const before = await observeScreen(ctx);
  const result = await action();
  ctx.frame = undefined; ctx.elements = [];
  const deadline = Date.now() + 3000;
  let after, changed = false;
  do {
    after = await observeScreen(ctx);
    changed = screenChanged(before, after);
    if (changed) break;
    await pause(200);
  } while (Date.now() < deadline);
  return { ...result, screen_change: changed ? 'changed' : 'unchanged', screen_changed: changed, screen_change_verified: true, foreground_before: before.foreground, foreground_after: after.foreground,
    ...(!changed ? { notice: 'The URL was accepted, but the screen did not visibly change afterwards.' } : {}) };
}

async function openURL(ctx, target, url) {
  return observeAction(ctx, async () => {
    try { await openURLTransport(target, url); }
    catch (error) {
      if (target.kind === 'simulator' && /^prefs:/i.test(url) && /LSApplicationWorkspaceErrorDomain.*115/s.test(error.message)) throw new Error(`${error.message}\nThis runtime rejects the private prefs: URL scheme. Use open_settings for pages with a verified navigation fallback.`);
      throw error;
    }
    return { opened: url };
  });
}

async function settingsTree(ctx, predicate) {
  // The first launch after a boot takes as long as any app, and reports no foreground app at first.
  const deadline = Date.now() + launchReadyMs;
  do {
    checkWork();
    const tree = await ctx.bridge({ op: 'ax' }).catch(error => { if (stopped(error)) throw error; });
    if (tree?.foreground?.bundle_id === 'com.apple.Preferences' && predicate(tree)) return tree;
    await pause(150);
  } while (Date.now() < deadline);
  throw new Error('Settings did not expose the requested navigation destination.');
}

async function simulatorSettingsFallback(ctx, target, page) {
  // These identifiers and page checks were observed on the iOS 27 runtime.
  // Its private prefs: scheme is rejected; App-prefs alone only opens the root.
  if (!['general', 'about'].includes(page)) throw new Error(`This simulator rejects the private prefs: scheme. The requested Settings page '${page}' has no verified navigation fallback on this runtime.`);
  await openURLTransport(target, 'App-prefs:');
  const visible = (tree, identifier) => tree.elements.find(element => element.visible !== false && element.identifier === identifier);
  const about = tree => visible(tree, 'NAME_CELL_ID') && visible(tree, 'SW_VERSION_SPECIFIER');
  const general = tree => visible(tree, 'com.apple.settings.general.featureDescription') && visible(tree, 'com.apple.settings.general.about');
  let tree = await settingsTree(ctx, tree => about(tree) || general(tree) || visible(tree, 'com.apple.settings.general'));
  const tap = async element => ctx.input({ op: 'tap', x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 });
  if (about(tree) && page === 'general') {
    const back = visible(tree, 'BackButton');
    if (!back) throw new Error('Settings About exposed no navigation back button.');
    await tap(back); tree = await settingsTree(ctx, general);
  } else if (!about(tree) && !general(tree)) {
    await tap(visible(tree, 'com.apple.settings.general')); tree = await settingsTree(ctx, general);
  }
  if (page === 'about' && !about(tree)) { await tap(visible(tree, 'com.apple.settings.general.about')); tree = await settingsTree(ctx, about); }
  const title = tree.elements.find(element => element.visible !== false && element.type === 'Heading')?.label;
  return { requested_page: page, page_verified: true, page_title: title, navigation_method: 'accessibility_after_private_scheme_rejection' };
}

async function openSettings(ctx, target, args) {
  if (!args.app && !args.page) {
    const open = () => launch(ctx, target, { bundle_id: 'com.apple.Preferences' });
    return target.kind === 'physical' ? open() : observeAction(ctx, open);
  }
  const route = args.app ? (await resolveApp(target, { app: args.app })).bundle_id : settingsPages[args.page];
  if (!route) throw new Error(`Unknown Settings page: ${args.page}`);
  const url = `prefs:root=${route}`;
  return observeAction(ctx, async () => {
    try { await openURLTransport(target, url); return { opened: url, requested_page: args.page ?? args.app }; }
    catch (error) {
      if (target.kind !== 'simulator' || !/LSApplicationWorkspaceErrorDomain.*115/s.test(error.message)) throw error;
      return simulatorSettingsFallback(ctx, target, args.page ?? args.app);
    }
  });
}

async function stopLocation(ctx, target) {
  ctx.changed(target);
  const active = state(ctx).locations.get(target.id);
  if (active) {
    active.child.kill('SIGTERM');
    const escalation = setTimeout(() => active.child.kill('SIGKILL'), 1000);
    try { await active.closed; } finally { clearTimeout(escalation); }
    state(ctx).locations.delete(target.id);
  }
  ctx.unownBackground(target.id, 'location');
  if (target.kind === 'simulator') await simctl(['location', target.id, 'clear']);
  else await physical(target.id, ['location_simulation', 'clear'], /Location cleared!/);
}

async function startLocation(ctx, target, args) {
  if (state(ctx).locations.has(target.id)) await stopLocation(ctx, target);
  if (target.kind === 'simulator') {
    await simctl(['location', target.id, 'set', `${args.latitude},${args.longitude}`]);
    state(ctx).locations.set(target.id, { target, child: { kill() {} }, closed: Promise.resolve() });
  } else {
    checkWork();
    const hold = isNetworkId(target.id) ? holdLocation(target.id, args.latitude, args.longitude) : undefined;
    const child = hold ? spawn(hold.file, hold.args, { stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(idevice, ['--udid', target.id, 'location_simulation', 'set', String(args.latitude), String(args.longitude)], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (hold) child.stdin.end(hold.input);
    const closed = new Promise(resolveClose => child.once('close', resolveClose));
    const requestSignal = signal();
    let escalation;
    const abort = () => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000); };
    requestSignal?.addEventListener('abort', abort, { once: true });
    state(ctx).locations.set(target.id, { target, child, closed });
    closed.then(() => { clearTimeout(escalation); requestSignal?.removeEventListener('abort', abort); });
    let output = '';
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Location service did not confirm the simulated location.')); }, 45000);
      const receive = chunk => { output = (output + chunk).slice(-3000); if (output.includes(hold?.ready ?? 'Location set!')) { clearTimeout(timer); resolveReady(); } };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Location service exited (${code}): ${output}`)); });
    });
    state(ctx).locations.set(target.id, { target, child, closed });
  }
  ctx.ownBackground(target.id, 'location');
  return { simulated: true, latitude: args.latitude, longitude: args.longitude, until: 'clear_location or this server session ends' };
}

async function listCrashes(target, args) {
  let reports;
  if (target.kind === 'simulator') {
    const directory = join(homedir(), 'Library/Logs/DiagnosticReports');
    const filenames = (await readdir(directory)).filter(name => /\.(ips|crash|spin|hang|diag|log|txt)$/.test(name));
    reports = await Promise.all(filenames.map(async name => ({ path: join(directory, name), name, modified: (await stat(join(directory, name))).mtime.toISOString() })));
  } else {
    const result = await devicectl(target.id, ['device', 'info', 'files', '--domain-type', 'systemCrashLogs']);
    reports = (result.files ?? []).filter(item => !item.resources?.isDirectory).map(item => ({ path: item.relativePath, name: item.name, modified: item.metadata?.lastModDate, size: item.metadata?.size }));
  }
  for (const report of reports) report.kind = /\.(ips|crash)$/.test(report.name) ? 'crash' : /\.(spin|hang)$/.test(report.name) ? 'spin' : /\.(log|txt)$/.test(report.name) ? 'log' : 'diagnostic';
  if ((args.kind ?? 'crash') !== 'all') reports = reports.filter(report => report.kind === (args.kind ?? 'crash'));
  if (args.process) {
    const app = (await apps(target, true)).find(app => app.bundle_id === args.process || app.name.toLowerCase() === args.process.toLowerCase());
    const names = app ? [app.executable, app.name, app.path ? basename(app.path).replace(/\.app\/?$/, '') : null].filter(Boolean) : [args.process];
    reports = reports.filter(report => names.some(name => (report.path ?? '').toLowerCase().includes(name.toLowerCase())));
  }
  reports.sort((a, b) => String(b.modified ?? b.modificationDate ?? b.path).localeCompare(String(a.modified ?? a.modificationDate ?? a.path)));
  return { source: target.kind === 'simulator' ? 'host DiagnosticReports (simulator app crashes are written here)' : 'device systemCrashLogs', reports: reports.slice(0, args.limit ?? 30) };
}

async function getCrash(ctx, target, args) {
  let reportPath = args.path;
  if (!reportPath) {
    if (!args.process) throw new Error('Give path or process.');
    reportPath = (await listCrashes(target, { process: args.process, limit: 1 })).reports[0]?.path;
    if (!reportPath) throw new Error('No crash report matched this process.');
  }
  const directory = await newDirectory(join(stateDir, 'crashes'), 'report-');
  const local = join(directory, basename(reportPath));
  if (target.kind === 'simulator') {
    const allowed = await realpath(join(homedir(), 'Library/Logs/DiagnosticReports'));
    const source = await realpath(absolutePath(reportPath));
    if (!source.startsWith(allowed + '/')) throw new Error('Simulator crash path must be in ~/Library/Logs/DiagnosticReports.');
    await copyFile(source, local, constants.COPYFILE_EXCL);
  } else {
    if (reportPath.split('/').includes('..')) throw new Error('Invalid crash report path.');
    await devicectl(target.id, ['device', 'copy', 'from', '--domain-type', 'systemCrashLogs', '--source', reportPath, '--destination', local]);
  }
  await chmod(local, 0o600);
  const raw = await readFile(local, 'utf8');
  let report;
  try { report = JSON.parse(raw); } catch {
    try { report = JSON.parse(raw.slice(raw.indexOf('\n') + 1)); } catch { /* Older .crash files are plain text. */ }
  }
  if (args.full) return { path: local, report: raw };
  if (!report) return { path: local, summary: raw.slice(0, 14000), truncated: raw.length > 14000 };
  const thread = report.threads?.find(t => t.triggered) ?? report.threads?.[report.faultingThread];
  const frames = thread?.frames?.map(frame => ({ ...frame, image: report.usedImages?.[frame.imageIndex]?.name, symbol_source: frame.symbol ? 'crash_report' : null })) ?? [];
  const build = state(ctx).builds.get(report.bundleInfo?.CFBundleIdentifier);
  let resolved = 0;
  let matchingBuild = false;
  if (build) {
    for (const [index, image] of (report.usedImages ?? []).entries()) {
      const uuid = image.uuid?.replaceAll('-', '').toUpperCase();
      const symbolFile = build.symbols.find(symbol => symbol.uuid === uuid && symbol.arch === image.arch);
      if (symbolFile) matchingBuild = true;
      const selected = frames.filter(frame => frame.imageIndex === index);
      if (!symbolFile || !selected.length) continue;
      const loadAddress = BigInt(image.base);
      const addresses = selected.map(frame => `0x${(loadAddress + BigInt(frame.imageOffset)).toString(16)}`);
      const { stdout } = await platformRun('xcrun', ['atos', '-o', symbolFile.path, '-arch', image.arch, '-l', `0x${loadAddress.toString(16)}`, ...addresses]);
      const lines = stdout.trimEnd().split('\n');
      selected.forEach((frame, position) => {
        if (!lines[position] || /^0x[0-9a-f]+$/i.test(lines[position].trim())) return;
        frame.symbolicated = lines[position]; frame.symbol_source = symbolFile.path; resolved += 1;
      });
    }
  }
  return { path: local, process: report.procName, bundle_id: report.bundleInfo?.CFBundleIdentifier, exception: report.exception, termination: report.termination, faulting_thread: report.faultingThread, frames, symbolication: { resolved_frames: resolved, method: 'atos with exact Mach-O UUID and architecture match', matching_build_available: matchingBuild } };
}

async function downloadContainer(target, args) {
  const app = await resolveApp(target, args);
  const base = absolutePath(args.output_directory ?? args.destination ?? join(stateDir, 'containers'));
  const holder = await newDirectory(base, `${app.bundle_id}-`);
  const packagePath = join(holder, `${app.name.replaceAll('/', '_')}.xcappdata`);
  const data = join(packagePath, 'AppData');
  await mkdir(packagePath, { mode: 0o700 });
  if (target.kind === 'simulator') {
    const source = await simctl(['get_app_container', target.id, app.bundle_id, 'data']);
    await cp(source, data, { recursive: true, errorOnExist: true, force: false, dereference: false });
  } else await devicectl(target.id, ['device', 'copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', app.bundle_id, '--source', '.', '--destination', data], 180000);
  const plist = { ApplicationBundleIdentifier: app.bundle_id, ApplicationName: app.name, ContainerType: 'AppData' };
  const converted = await platformRun('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(plist) });
  await writeFile(join(packagePath, 'AppDataInfo.plist'), converted.stdout, { mode: 0o600, flag: 'wx' });
  return { bundle_id: app.bundle_id, path: packagePath };
}

async function buildAndRun(ctx, target, args) {
  let project = absolutePath(args.project_path);
  if (!/\.(xcodeproj|xcworkspace)$/.test(project)) {
    const entries = await readdir(project);
    const choices = entries.filter(name => name.endsWith('.xcworkspace'));
    if (!choices.length) choices.push(...entries.filter(name => name.endsWith('.xcodeproj')));
    if (choices.length !== 1) throw new Error('Specify one .xcodeproj or .xcworkspace path.');
    project = join(project, choices[0]);
  }
  const projectArgs = [project.endsWith('.xcworkspace') ? '-workspace' : '-project', project];
  let scheme = args.scheme;
  if (!scheme) {
    const result = await platformRun('xcodebuild', [...projectArgs, '-list', '-json'], { timeout: 120000 });
    const listing = JSON.parse(result.stdout);
    const schemes = listing.project?.schemes ?? listing.workspace?.schemes ?? [];
    if (schemes.length !== 1) throw new Error('This project has multiple/no schemes; specify scheme.');
    scheme = schemes[0];
  }
  const derived = await newDirectory(join(stateDir, 'builds'), 'build-');
  const flags = [...projectArgs, '-scheme', scheme, '-configuration', args.configuration ?? 'Debug', '-destination', `platform=${target.kind === 'simulator' ? 'iOS Simulator' : 'iOS'},id=${target.id}`, '-derivedDataPath', derived, 'DEBUG_INFORMATION_FORMAT=dwarf-with-dsym'];
  if (target.kind === 'simulator') flags.push('CODE_SIGNING_ALLOWED=NO');
  const buildLog = join(derived, 'build.log');
  const queue = join(homedir(), '.claude/bin/buildq');
  const hasQueue = await access(queue, constants.X_OK).then(() => true, () => false);
  let result;
  try { result = await platformRun(hasQueue ? queue : 'xcodebuild', [...(hasQueue ? ['--', 'xcodebuild'] : []), ...flags, 'build'], { timeout: 600000 }); }
  catch (error) {
    await writeFile(buildLog, (error.stdout ?? '') + (error.stderr ?? error.message), { mode: 0o600 });
    throw new Error(`${error.message}\nBuild log: ${buildLog}`);
  }
  await writeFile(buildLog, result.stdout + result.stderr, { mode: 0o600 });
  const settingsResult = await platformRun('xcodebuild', [...flags, '-showBuildSettings', '-json'], { timeout: 120000 });
  const settings = JSON.parse(settingsResult.stdout).map(value => value.buildSettings).filter(value => value.WRAPPER_EXTENSION === 'app');
  if (settings.length !== 1) throw new Error(`Build finished but found ${settings.length} app products; choose an app scheme. Build log: ${buildLog}`);
  const setting = settings[0];
  const appPath = join(setting.TARGET_BUILD_DIR, setting.FULL_PRODUCT_NAME);
  const installed = await install(target, appPath);
  if (installed.isError) return { ...installed, build_log: buildLog };
  const symbols = [];
  for (const name of (await readdir(setting.DWARF_DSYM_FOLDER_PATH)).filter(name => name.endsWith('.dSYM'))) {
    const bundle = join(setting.DWARF_DSYM_FOLDER_PATH, name);
    const { stdout } = await platformRun('xcrun', ['dwarfdump', '--uuid', bundle]);
    for (const match of stdout.matchAll(/UUID: ([A-Fa-f0-9-]+) \(([^)]+)\) (.+)/g)) symbols.push({ uuid: match[1].replaceAll('-', '').toUpperCase(), arch: match[2], path: match[3] });
  }
  state(ctx).builds.set(installed.bundle_id, { derived, symbols, buildLog });
  const launched = await launch(ctx, target, { bundle_id: installed.bundle_id });
  return { ...launched, app_path: appPath, build_log: buildLog, derived_data: derived };
}

export async function platformTool(ctx, name, args = {}) {
  if (name === 'start_simulator') return startSimulator(ctx, args);
  const target = await ctx.target();
  if (!['list_apps', 'get_clipboard', 'list_crashes', 'get_crash', 'download_app_container', 'start_recording', 'stop_recording'].includes(name)) ctx.changed(target);
  const changesApps = ['install_app', 'uninstall_app', 'build_and_run'].includes(name);
  try {
  switch (name) {
    case 'shut_down_simulator': {
      if (target.kind !== 'simulator') throw new Error('shut_down_simulator requires a simulator.');
      await closeRecordings(ctx, target.id);
      if ((await inventorySimulators()).find(d => d.id === target.id)?.state !== 'Shutdown') await simctl(['shutdown', target.id]);
      ctx.frame = undefined; ctx.elements = [];
      return { id: target.id, state: 'Shutdown' };
    }
    case 'start_recording': return startRecording(ctx, target, args);
    case 'stop_recording': return stopRecording(ctx, target);
    case 'list_apps': {
      const directory = await refreshApps(ctx, target);
      return { apps: directory.apps.filter(app => args.include_system || !app.system), ...(directory.localized_names ? { localized_names: directory.localized_names } : {}) };
    }
    case 'launch_app': return launch(ctx, target, args);
    case 'install_app': return await install(target, args.path);
    case 'uninstall_app': {
      const app = await resolveApp(target, args);
      if (target.kind === 'simulator') await simctl(['uninstall', target.id, app.bundle_id]);
      else return await applicationMutation(target, { op: 'uninstall_app', bundle_id: app.bundle_id }, async () => {
        if ((await apps(target, true)).some(a => a.bundle_id === app.bundle_id)) throw new Error('The app remains installed after uninstall completed.');
        return { uninstalled: app.bundle_id };
      });
      if ((await apps(target, true)).some(a => a.bundle_id === app.bundle_id)) throw new Error('The app remains installed after uninstall returned.');
      return { uninstalled: app.bundle_id };
    }
    case 'terminate_app': {
      const app = await resolveApp(target, args);
      if (target.kind === 'simulator') await simctl(['terminate', target.id, app.bundle_id]);
      else {
        const result = await devicectl(target.id, ['device', 'info', 'processes']);
        const appPath = app.path.startsWith('file:') ? fileURLToPath(app.path) : app.path;
        const processes = result.runningProcesses.filter(process => process.executable.startsWith(appPath));
        if (!processes.length) return { bundle_id: app.bundle_id, already_stopped: true };
        for (const process of processes) await devicectl(target.id, ['device', 'process', 'terminate', '--pid', String(process.processIdentifier)]);
      }
      ctx.frame = undefined; ctx.elements = [];
      return { terminated: app.bundle_id };
    }
    case 'open_url': return openURL(ctx, target, args.url);
    case 'open_settings': return openSettings(ctx, target, args);
    case 'set_appearance': {
      const style = args.appearance ?? args.style;
      if (!['light', 'dark'].includes(style)) throw new Error('Appearance must be light or dark.');
      if (target.kind === 'simulator') await simctl(['ui', target.id, 'appearance', style]);
      else await physical(target.id, ['configuration', 'appearance', style], /appearance/);
      return { appearance: (await readSettings(target)).appearance };
    }
    case 'set_accessibility': {
      if (['text_size', 'reduce_motion', 'increase_contrast', 'reduce_transparency'].every(key => args[key] === undefined)) throw new Error('Give at least one of text_size, reduce_motion, increase_contrast, reduce_transparency.');
      if (target.kind === 'simulator' && (args.reduce_motion !== undefined || args.reduce_transparency !== undefined)) throw new Error('Reduce Motion and Reduce Transparency cannot be set externally on a simulator; change them in Settings > Accessibility.');
      let largerSizesTurnedOn = false;
      if (target.kind !== 'simulator' && args.text_size?.startsWith('accessibility_')) {
        try { await configuration(target, 'set_larger_accessibility_sizes', true); }
        catch (error) { throw new Error(`Larger Accessibility Sizes: ${error.message}`); }
        largerSizesTurnedOn = true;
      }
      for (const key of ['text_size', 'reduce_motion', 'increase_contrast', 'reduce_transparency']) {
        if (args[key] === undefined) continue;
        if (target.kind === 'simulator') await simctl(['ui', target.id, key === 'text_size' ? 'content_size' : key, key === 'text_size' ? args[key].replaceAll('_', '-') : args[key] ? 'enabled' : 'disabled']);
        else await physical(target.id, ['configuration', key.replaceAll('_', '-'), typeof args[key] === 'boolean' ? args[key] ? 'on' : 'off' : args[key].replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())], /text size set|reduce motion|increase contrast|reduce transparency/);
      }
      return { ...await readSettings(target), ...(largerSizesTurnedOn ? { larger_sizes_turned_on: true } : {}) };
    }
    case 'set_location': return startLocation(ctx, target, args);
    case 'clear_location': await stopLocation(ctx, target); return { simulated: false };
    case 'get_clipboard': {
      if (target.kind === 'simulator') return JSON.parse((await platformRun(join(root, 'build/simulator'), [], { input: JSON.stringify({ id: target.id, op: 'clipboard' }) })).stdout);
      const result = await physical(target.id, ['pasteboard', 'paste']);
      const listing = await physical(target.id, ['pasteboard', 'items']);
      const types = [...listing.stdout.matchAll(/^\[\d+\] ([^:]+):/gm)].map(match => match[1]);
      const imageInfo = JSON.parse((await platformRun(join(root, 'build/simulator'), [], { input: JSON.stringify({ op: 'image_types', types }) })).stdout);
      return { text: result.stdout, ...imageInfo, types };
    }
    case 'set_clipboard': {
      if (target.kind === 'simulator') await platformRun('xcrun', ['simctl', 'pbcopy', target.id], { input: args.text });
      else if (isNetworkId(target.id)) await runIdeviceTool(platformRun, target.id, ['pasteboard', 'copy'], { input: args.text });
      else await platformRun(idevice, ['--udid', target.id, 'pasteboard', 'copy'], { input: args.text });
      const readback = await platformTool(ctx, 'get_clipboard', {});
      if (readback.text !== args.text) throw new Error('Clipboard readback differs from requested text.');
      return { copied: true, bytes: Buffer.byteLength(args.text), verified: true };
    }
    case 'list_crashes': return listCrashes(target, args);
    case 'get_crash': return getCrash(ctx, target, args);
    case 'download_app_container': return downloadContainer(target, args);
    case 'build_and_run': return await buildAndRun(ctx, target, args);
    default: throw new Error(`Unknown platform tool: ${name}`);
  }
  } finally { if (changesApps) appDirectory(ctx).delete(target.id); }
}

export async function closePlatform(ctx, onlyDevices) {
  const recordings = await closeRecordings(ctx, onlyDevices);
  const locations = await Promise.allSettled([...state(ctx).locations.values()].filter(active => !onlyDevices || onlyDevices.has(active.target.id)).map(active => stopLocation(ctx, active.target)));
  return { recordings, locations: locations.map(result => result.status === 'rejected' ? { error: result.reason.message } : { stopped: true }) };
}

import { execute, checkWork, deadline, pause, phase, stopped, stoppingReason } from './work.mjs';
import { Coordination, managementTools } from './coordination.mjs';
import { runBatch } from './batch.mjs';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { root, stateDir, idevice } from './config.mjs';
import { definitions } from './tools.mjs';
import { platformTool, inventorySimulators, simulatorModels, readSettings, closePlatform } from './platform.mjs';
import { interaction, promptWarning, readScreen, screenChanged, justReadMs } from './interaction.mjs';
import { askHuman } from './human.mjs';
import { simulatorRequest } from './simulator.mjs';
import { prepareRecordingInput, resumeRecordings } from './recording.mjs';
import { version, buildInfo, requireCurrentCode } from './build-info.mjs';
import { isNetworkId, nativeArgs, networkDevice, runIdeviceTool } from './network-device.mjs';
import { routes as routesToBridgeDaemon, runThroughDaemon } from './bridge-daemon.mjs';
import { actAndObserve } from './act-and-observe.mjs';

export const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const usedSimulators = new Set();
const approvedTools = new Set(['install_app', 'uninstall_app', 'build_and_run', 'open_url', 'download_app_container', 'get_clipboard', 'set_clipboard']);
const platformTools = new Set(['start_simulator', 'shut_down_simulator', 'start_recording', 'stop_recording', 'set_appearance', 'set_accessibility', 'list_apps', 'launch_app', 'terminate_app', 'install_app', 'uninstall_app', 'open_settings', 'open_url', 'build_and_run', 'set_location', 'clear_location', 'get_clipboard', 'set_clipboard', 'list_crashes', 'get_crash', 'download_app_container']);

const settleMs = 600, readbackMs = 5000;
const reportsScreen = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'swipe', 'drag', 'scroll', 'pinch', 'type_text', 'fill', 'press_key', 'press_button', 'go_back', 'handle_alert', 'system_gesture']);
// These exist to act on a control, so the reply says when nothing was seen to change after one.
const touchesControl = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'go_back', 'handle_alert']);
const unchangedAdvice = 'The touch was sent, and no change was observed after it: accessibility reports the same elements, text, values, state (selected, enabled, focused) and positions. That is not proof it failed: its effect may be one accessibility does not report, such as a redrawn image or canvas, or may not have appeared yet. Nothing else was done. If a change was expected, check that the target is not covered or still loading before sending it again.';
const onScreen = ({ width, height }) => element => {
  const box = element.frame ?? element;
  return box.x < width && box.y < height && box.x + box.width > 0 && box.y + box.height > 0;
};

export function hidPoint(x, y, width, height) {
  if (![x,y,width,height].every(Number.isFinite) || width < 2 || height < 2 || x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Coordinates must be inside the screen (${width} × ${height} points).`);
  return [Math.round(x / (width - 1) * 65535), Math.round(y / (height - 1) * 65535)];
}

export class Devices {
  selected; requested; frame; size; seen; elements = []; elementsAt = 0; lastInputAt = -Infinity; inBatch = false;
  scales = new Map(); physicalNames = new Map(); backgroundDevices = new Map(); nextRef = 0;
  constructor(coordinator = new Coordination()) { this.coordinator = coordinator; }
  async run(file, args, timeout = 45000, input) {
    if (routesToBridgeDaemon(file, input)) return runThroughDaemon(args, { timeout, input });
    const result = await execute(file, args, { timeout, input });
    return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  }
  async cleanup(onlyDevices) {
    const result = await closePlatform(this, onlyDevices);
    if (onlyDevices) for (const id of onlyDevices) this.backgroundDevices.delete(id);
    else this.backgroundDevices.clear();
    if (!onlyDevices || onlyDevices.has(this.frame?.device)) { this.frame = undefined; this.elements = []; }
    return result;
  }
  close() { return this.coordinator.end(this, 'session_closed'); }
  async call(name, args = {}, requestSignal, requestId) {
    if (managementTools.has(name)) {
      const parsed = definitions.find(d => d[0] === name)[2].parse(args);
      if (name === 'renew_device') return text(this.coordinator.renew(this, parsed.lease_id, parsed.ttl_seconds ?? 120));
      if (name !== 'acquire_device') {
        if (name === 'release_device' || parsed.lease_id) this.coordinator.require(this, parsed.lease_id);
        return text(await this.coordinator.end(this, name === 'release_device' ? 'released' : 'cancelled'));
      }
      return this.coordinator.call(this, name, parsed, requestSignal, requestId);
    }
    return this.coordinator.call(this, name, args, requestSignal, requestId);
  }
  ownBackground(id, type) { if (!this.backgroundDevices.has(id)) this.backgroundDevices.set(id, new Set()); this.backgroundDevices.get(id).add(type); }
  unownBackground(id, type) { const owned = this.backgroundDevices.get(id); owned?.delete(type); if (!owned?.size) this.backgroundDevices.delete(id); }
  access(target) { this.coordinator.access(this, target); }
  changed(target) { this.coordinator.changed(target.id); this.elements = []; this.elementsAt = 0; this.frame = undefined; this.seen = undefined; }
  // A device configured with POKI_DEVICE_HOST answers the idevice-tools calls through the bridge.
  networkTool(id, args, timeout, input) {
    return runIdeviceTool((file, argv, options) => this.run(file, argv, options.timeout, options.input), id, args, { timeout, input });
  }
  async inventory(all = false) {
    // A configured network device replaces usbmuxd discovery.
    const configured = networkDevice();
    const { stdout } = configured ? { stdout: JSON.stringify([configured]) } : await this.run('python3', [join(root, 'native/devices.py')], 8000);
    const physical = new Map();
    for (const device of JSON.parse(stdout)) {
      if (!device.id || (physical.has(device.id) && device.connection !== 'USB')) continue;
      physical.set(device.id, { ...device, kind: 'physical', name: this.physicalNames.get(device.id) ?? device.id });
    }
    const simulators = await inventorySimulators().catch(() => []);
    return [...physical.values(), ...simulators.filter(d => all || d.state === 'Booted' || usedSimulators.has(d.id))];
  }
  async describeDevices(all) {
    const devices = await this.inventory(all);
    return Promise.all(devices.map(async device => {
      const occupancy = this.coordinator.status(device.id, this);
      if (device.kind === 'simulator' || occupancy.occupied && !occupancy.owned_by_session) return { ...device, ...occupancy, selected: device.id === this.selected };
      try {
        this.access(device);
        const values = await Promise.all(['DeviceName','ProductType','ProductVersion'].map(async key => {
          const response = isNetworkId(device.id) ? await this.networkTool(device.id, ['lockdown','get',key], 8000) : await this.run(idevice, ['--udid',device.id,'lockdown','get',key],8000);
          if (!response.stdout) throw new Error(response.stderr || `No ${key} response`);
          return JSON.parse(response.stdout);
        }));
        this.physicalNames.set(device.id,values[0]);
        return { ...device,name:values[0],model:values[1],osVersion:values[2],selected:device.id===this.selected,...occupancy,readiness:'paired device discovered; developer-service availability is checked when used' };
      } catch(error) {
        return { ...device,selected:device.id===this.selected,blocked:error.message,action:'Keep the device connected and unlocked, trust this Mac, and enable Developer Mode / UI Automation.' };
      }
    }));
  }
  async target(boot = true) {
    checkWork();
    if (this.resolved) { this.access(this.resolved); return this.resolved; }
    const list = await this.inventory(true);
    const query = this.requested ?? this.selected;
    let matches = query ? list.filter(d => d.id === query || d.name.toLocaleLowerCase() === query.toLocaleLowerCase()) : list.filter(d => d.kind === 'physical' || d.state === 'Booted');
    if (query && !matches.length) {
      for (const d of list.filter(d => d.kind === 'physical')) {
        const occupancy = this.coordinator.status(d.id, this);
        if (occupancy.occupied && !occupancy.owned_by_session) continue;
        this.access(d);
        const value = isNetworkId(d.id) ? await this.networkTool(d.id, ['lockdown', 'get', 'DeviceName']) : await this.run(idevice, ['--udid', d.id, 'lockdown', 'get', 'DeviceName']);
        try { d.name = JSON.parse(value.stdout); this.physicalNames.set(d.id, d.name); } catch { continue; }
      }
      matches = list.filter(d => d.name.toLocaleLowerCase() === query.toLocaleLowerCase());
    }
    if (!matches.length) throw new Error(query ? 'Device is not connected or the selected device disconnected. Use list_devices and select_device.' : 'No device is connected. Connect and trust an iPhone, or start a simulator.');
    if (matches.length !== 1) throw new Error(`Multiple devices match. Use select_device or specify device: ${matches.map(d => `${d.name} (${d.id})`).join(', ')}.`);
    const target = matches[0];
    this.access(target); this.resolved = target;
    if (!this.selected) this.selected = target.id;
    if (target.kind === 'simulator') {
      usedSimulators.add(target.id);
      if (boot && target.state !== 'Booted') {
        const selected = this.selected;
        await platformTool(this, 'start_simulator', { simulator: target.id });
        this.selected = selected;
        target.state = 'Booted';
      }
    }
    return target;
  }
  async device() { return (await this.target()).id; }
  async native(args, expected, timeout = 45000) {
    const target = await this.target();
    if (target.kind !== 'physical') throw new Error('This native command requires a physical device.');
    const result = isNetworkId(target.id) ? await this.networkTool(target.id, args, timeout) : await this.run(idevice, ['--udid', target.id, ...args], timeout);
    if (expected && !expected.test(result.stdout + '\n' + result.stderr)) throw new Error(`Device service did not confirm the action: ${(result.stderr || result.stdout).slice(-3000)}`);
    return result;
  }
  async bridge(request) {
    const target = await this.target();
    if (target.kind === 'simulator') return simulatorRequest(target.id, request);
    const nativeRequest = request.op === 'ax' ? { op: 'ax_tree', include_offscreen: request.include_offscreen ?? false } : request;
    const { stdout } = await this.run(join(root, 'build/poki-native'), nativeArgs(target), 95000, JSON.stringify(nativeRequest));
    const result = JSON.parse(stdout);
    if (request.op === 'ax') return { ...result, foreground: result.foreground_app, elements: result.elements?.map(e => ({ ...e, type: e.type ?? e.role })) };
    return result;
  }
  async scale(target) {
    if (this.scales.has(target.id)) return this.scales.get(target.id);
    let scale;
    if (target.kind === 'physical') {
      const result = await this.native(['lockdown', '--domain', 'com.apple.mobile.iTunes', 'get', 'ScreenScaleFactor']);
      scale = Number(result.stdout);
    } else {
      const info = await this.bridge({ op: 'info' });
      scale = info.scale;
    }
    if (!Number.isFinite(scale) || scale <= 0 || scale > 5) throw new Error('Could not read the screen scale. Refusing to guess touch coordinates.');
    this.scales.set(target.id, scale); return scale;
  }
  capture() { return phase('screen_capture', () => this.captureFrame()); }
  async captureFrame() {
    checkWork();
    const started = new Date().toISOString();
    const target = await this.target();
    const cache = join(stateDir, 'frames');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const path = join(cache, `${randomUUID()}.png`);
    try {
      // Unmasked, the area around the Dynamic Island differs between frames of a still screen, which would expire refs.
      if (target.kind === 'simulator') await this.run('xcrun', ['simctl', 'io', target.id, 'screenshot', '--type=png', '--mask=black', path]);
      else await this.native(['screenshot', path], /Screenshot saved to:/);
      const original = await readFile(path), meta = await sharp(original).metadata();
      const scale = await this.scale(target);
      const width = Math.round(meta.width / scale), height = Math.round(meta.height / scale);
      const data = await sharp(original).resize(width, height).png().toBuffer();
      this.coordinator.observeFrame(target.id, data);
      if (this.frame?.revision !== this.coordinator.revision(target.id) || this.frame?.device !== target.id || this.frame?.width !== width || this.frame?.height !== height || !this.frame.data.equals(data)) { this.elements=[]; this.elementsAt=0; }
      checkWork();
      this.frame = { id: randomUUID(), device: target.id, revision: this.coordinator.revision(target.id), width, height, scale, data, original, at: Date.now(), capture_started_at: started, capture_completed_at: new Date().toISOString() };
      this.size = { device: target.id, width, height };
      return this.frame;
    } finally { await unlink(path).catch(() => {}); }
  }
  async viewport() {
    const target = await this.target();
    if (this.frame && this.frame.revision !== this.coordinator.revision(target.id)) { this.frame = undefined; this.elements = []; }
    if (!this.frame || this.frame.device !== target.id) return this.capture();
    return this.frame;
  }
  async ocr(frame) {
    checkWork();
    return frame.ocr ??= phase('ocr', () => this.readOCR(frame));
  }
  async readOCR(frame) {
    const file = join(stateDir, 'frames', `${randomUUID()}-ocr.png`);
    try {
      await writeFile(file, frame.data, { mode: 0o600 });
      const { stdout } = await this.run(join(root, 'build/ocr'), [file]);
      return JSON.parse(stdout).map(e => ({ ...e, label: e.text, type: 'StaticText', frame: { x:e.x,y:e.y,width:e.width,height:e.height } }));
    } finally { await unlink(file).catch(() => {}); }
  }
  async recognize(args = {}, existingFrame) {
    checkWork();
    const frame = existingFrame ?? await this.capture();
    let elements, source, foreground, nativeError;
    if (args.source !== 'ocr') {
      try {
        const tree = await phase('accessibility', () => this.bridge({ op: 'ax', include_offscreen: args.include_offscreen ?? false }));
        if (!Array.isArray(tree.elements) || !tree.elements.length) throw new Error('No accessibility elements returned');
        elements = tree.elements; source = 'accessibility'; foreground = tree.foreground;
      } catch (error) { if (stopped(error)) throw error; nativeError = error.message; if (args.source === 'accessibility' || args.source === 'ax') throw error; }
    }
    if (!elements) {
      elements = await this.ocr(frame);
      source = 'ocr';
    }
    if (!args.include_offscreen) elements = elements.filter(onScreen(frame));
    const count = elements.length;
    this.elements = elements.slice(0, args.max_elements ?? 400).map(e => ({ ...e, ref:`e${++this.nextRef}` }));
    this.elementsAt = Date.now();
    frame.structure_completed_at = new Date().toISOString();
    frame.source = source;
    const observation = this.observation(frame);
    return { observation, source, width: frame.width, height: frame.height, units: 'points', foreground, elements: this.elements, total: count, truncated: count > this.elements.length, ...(source === 'ocr' && nativeError ? { fallback_reason: nativeError } : {}) };
  }
  // One accessibility read and no screenshot, so polling costs one helper process per attempt.
  async structure(maxAge = 0) {
    const target = await this.target();
    if (this.seen?.device === target.id && performance.now() - this.seen.at <= maxAge) return this.seen;
    const tree = await phase('accessibility', () => this.bridge({ op: 'ax', include_offscreen: false }));
    const elements = (tree.elements ?? []).filter(onScreen(this.size?.device === target.id ? this.size : await this.capture()));
    // A tree that leaves a state out compares equal to one that gives its default.
    const signature = JSON.stringify(elements.map(e => { const box = e.frame ?? e; return [e.type ?? e.role, e.label, e.text, e.value, e.focused, Boolean(e.selected), Boolean(e.enabled ?? true), box.x, box.y, box.width, box.height]; }));
    return this.seen = { device: target.id, foreground: tree.foreground, elements, signature, at: performance.now() };
  }
  // A simulator's size only changes when it rotates. A physical device maps touches through its
  // current orientation, so it keeps taking a fresh frame.
  async screenSize() {
    const target = await this.target();
    return target.kind === 'simulator' && this.size?.device === target.id ? this.size : this.viewport();
  }
  // Reading the result back saves the caller a round trip to look. The action has already happened,
  // so a failed read only loses the report; a stop request still surfaces as a stop.
  async readback(before) {
    try {
      const { signature, screen } = await deadline(readbackMs, () => readScreen(this));
      const compared = before !== undefined && signature !== undefined;
      return { screen, screen_change_verified: compared, ...(compared ? { screen_changed: signature !== before } : {}) };
    } catch (error) {
      try { checkWork(); } catch (stop) { return { stopped: true, stop_reason: stoppingReason(stop) }; }
      return { screen_change_verified: false, screen: { unavailable: error.message } };
    }
  }
  // The action does not depend on this read, so a slow read only costs the comparison.
  async readBefore(maxAge) {
    try { return await deadline(readbackMs, () => this.structure(maxAge)); } catch { checkWork(); }
  }
  // A batch step reports only whether its touch changed the screen; the batch ends with the screen itself.
  async changedSince(before) {
    try {
      const changed = await deadline(readbackMs, () => screenChanged(this, before));
      return changed === undefined ? {} : { screen_change_verified: true, screen_changed: changed };
    } catch {
      try { checkWork(); } catch (stop) { return { stopped: true, stop_reason: stoppingReason(stop) }; }
      return {};
    }
  }
  // Lets the app react to the last input, so a read shows the new page rather than the old one.
  async settle() {
    const remaining = this.lastInputAt + settleMs - performance.now();
    if (remaining > 0) await pause(remaining);
  }
  observation(frame = this.frame) {
    return { id: frame.id, device: frame.device, width: frame.width, height: frame.height, units: 'points', capture_started_at: frame.capture_started_at, capture_completed_at: frame.capture_completed_at, structure_completed_at: frame.structure_completed_at, structure_source: frame.source ?? null, atomic: false, revision: frame.revision };
  }
  async input(request) {
    const target = await this.target();
    const frame = 'x' in request || 'x1' in request || request.op === 'pinch' ? await this.screenSize() : undefined;
    const command = { ...request };
    if ('x' in command) {
      const p = hidPoint(command.x, command.y, frame.width, frame.height);
      if (target.kind === 'physical') { command.x = p[0]; command.y = p[1]; }
    }
    if ('x1' in command) {
      const a = hidPoint(command.x1, command.y1, frame.width, frame.height), b = hidPoint(command.x2, command.y2, frame.width, frame.height);
      if (target.kind === 'physical') [command.x1,command.y1,command.x2,command.y2] = [...a,...b];
    }
    if (command.op === 'pinch' && target.kind === 'physical') {
      command.start_distance *= 65535 / (frame.width - 1); command.end_distance *= 65535 / (frame.width - 1);
    }
    await phase('recording_recovery', () => prepareRecordingInput(this, target));
    // The last screen read before the first input of a call is the one its effect is measured against.
    if (this.seen?.device === target.id) this.beforeInput ??= this.seen;
    this.changed(target);
    let result;
    try { result = await phase('input', () => this.bridge(command)); }
    catch (error) { result = { outcome: 'unknown', error: error.message, stopped: Boolean(stopped(error)), stop_reason: stopped(error) ? stoppingReason(error) : 'unknown', instruction: 'Input may have been delivered. Inspect the screen before retrying.', isError: true }; }
    this.lastInputAt = performance.now();
    if (target.kind === 'physical') {
      try { await phase('recording_recovery', () => resumeRecordings(this, target)); }
      catch (error) { result = { ...result, recording: { resumed: false, error: error.message }, stopped: Boolean(stopped(error)), ...(stopped(error) ? { stop_reason: stoppingReason(error) } : {}) }; }
    }
    return result;
  }
  async dispatch(name, original = {}) {
    const def = definitions.find(d => d[0] === name);
    if (!def) throw new Error(`Unknown tool: ${name}`);
    const args = def[2].parse(original);
    const previous = this.requested, previousResolved = this.resolved;
    // Steps of one batch share a lookup, which runs a Python process and simctl each time.
    const sharesTarget = this.inBatch && args.device === undefined;
    if (!sharesTarget) this.resolved = undefined;
    this.requested = args.device ?? previous;
    try {
      checkWork();
      if (name !== 'poki_mcp_status' && name !== 'stop_recording') await requireCurrentCode();
      if (approvedTools.has(name)) await this.target();
      if (approvedTools.has(name) && process.env.POKI_MCP_APPROVAL_MODE !== 'allow') {
        const detail = args.path ?? args.project_path ?? args.bundle_id ?? args.url ?? (name === 'set_clipboard' ? `${Buffer.byteLength(args.text)} 字节的文本` : '');
        const action = { install_app: '安装应用', uninstall_app: '卸载应用', build_and_run: '构建并运行应用', open_url: '打开链接', download_app_container: '下载应用数据', get_clipboard: '读取剪贴板', set_clipboard: '写入剪贴板' }[name];
        const result = await askHuman(`是否允许${action}？\n设备：${args.device ?? this.selected ?? '当前选中的设备'}\n${detail}`, 120);
        if (!result.completed) return { isError: true, ...text({ ...result, executed: false }), _meta: { stop_reason: result.status === 'timeout' ? 'timeout' : 'cancelled' } };
      }
      if (platformTools.has(name)) {
        const { _meta, ...result } = await platformTool(this, name, args);
        if (name === 'start_simulator') usedSimulators.add(this.selected);
        return { ...text(result), ...(result.isError ? { isError: true } : {}), ...(_meta || result.stop_reason ? { _meta: { ..._meta, ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}) } } : {}) };
      }
      if (name === 'act_and_observe') return await actAndObserve(this, args, (tool, values) => definitions.find(d => d[0] === tool)[2].parse(values));
      switch (name) {
        case 'acquire_device': return text(await this.coordinator.acquire(this, await this.target(false), args.ttl_seconds ?? 120));
        case 'poki_mcp_status': return text({ implementation: `Poki MCP ${version}`, ...await buildInfo(), registered_device_tools: 50, observation_tools: 1, management_tools: 4, total_tools: definitions.length, devices: (await this.inventory()).length, selected: this.selected ?? null, approval_mode: process.env.POKI_MCP_APPROVAL_MODE === 'allow' ? 'operator-preapproved' : 'ask-human' });
        case 'list_devices': return text({ devices: await this.describeDevices(args.include_all_simulators), ...(args.include_all_simulators ? { simulator_models: await simulatorModels() } : {}) });
        case 'select_device': {
          this.requested = args.device;
          const target = await this.target(); this.selected = target.id; this.frame = undefined; this.elements = [];
          return text({ selected: target.id, name: target.name });
        }
        case 'get_device_info': {
          const target = await this.target(), frame = await this.capture();
          const info = { ...target, screen: { width: frame.width, height: frame.height, scale: frame.scale, units: 'points' } };
          if (target.kind === 'physical') for (const key of ['DeviceName', 'ProductType', 'ProductVersion']) {
            const result = await this.native(['lockdown', 'get', key]); info[key] = JSON.parse(result.stdout);
          }
          if (target.kind === 'physical') { info.name=info.DeviceName; info.model=info.ProductType; info.osVersion=info.ProductVersion; this.physicalNames.set(target.id,info.name); }
          info.engine=target.kind==='simulator'?'CoreSimulator':'CoreDevice'; info.mirror_status='screen capture available';
          if (args.include_settings) info.settings = await readSettings(target);
          return text(info);
        }
        case 'take_screenshot': {
          const frame = await this.capture();
          const width = Math.round(args.max_width ?? frame.width);
          const jpeg = await sharp(frame.data).resize({ width }).jpeg({ quality: 90 }).toBuffer();
          let prompt;
          try { prompt = { status:'checked', source:'ocr', warning:promptWarning(await this.ocr(frame)) }; }
          catch (error) { if (stopped(error)) throw error; prompt = { status:'unavailable', instruction:'Inspect the screenshot for system prompts before continuing.' }; }
          return { content: [...text({ observation: this.observation(frame) }).content, { type: 'text', text: `Screen: ${frame.width} × ${frame.height} points. Image width: ${width} pixels. Coordinates for tools are screen points. Source: lossless device capture.\nPrompt check: ${JSON.stringify(prompt)}` }, { type:'image',data:jpeg.toString('base64'),mimeType:'image/jpeg' }] };
        }
        case 'save_screenshot': {
          let path = args.path ?? join(homedir(), 'Pictures', 'Poki MCP');
          if (path.startsWith('~/')) path = join(homedir(),path.slice(2));
          if (!isAbsolute(path)) throw new Error('Screenshot path must be absolute.');
          const isDirectory = await stat(path).then(s=>s.isDirectory()).catch(()=>!extname(path));
          if (isDirectory) { const target=await this.target(); await mkdir(path,{recursive:true,mode:0o700}); path=join(path,`${target.name.replace(/[^\p{L}\p{N}._-]/gu,'_')}-${Date.now()}-${randomUUID().slice(0,8)}.png`); }
          const extension = extname(path).toLowerCase();
          if (!['.png','.jpg','.jpeg'].includes(extension)) throw new Error('Use a .png, .jpg or .jpeg path.');
          const frame = await this.capture();
          const data = extension === '.png' ? frame.original : await sharp(frame.original).jpeg({quality:95}).toBuffer();
          await writeFile(path,data,{flag:args.overwrite?'w':'wx',mode:0o600}); return text({path,bytes:data.length});
        }
        case 'list_elements': return text(await this.recognize(args));
        case 'observe_device': {
          const result = await this.recognize(args), frame = this.frame;
          let prompt;
          try { prompt = { status: 'checked', source: 'ocr', warning: promptWarning(await this.ocr(frame)) }; }
          catch (error) { if (stopped(error)) throw error; prompt = { status: 'unavailable', instruction: 'Inspect the image for system prompts before continuing.' }; }
          return { content: [...text({ ...result, prompt }).content, { type: 'image', data: frame.data.toString('base64'), mimeType: 'image/png' }] };
        }
        case 'get_foreground_app': {
          const tree = await this.bridge({ op:'ax', include_offscreen:false });
          if (!tree.foreground?.bundle_id && !tree.foreground?.pid) throw new Error('The accessibility service did not identify a foreground app.');
          // Some accessibility roots carry only a pid; AppService names the app running as it.
          if (!tree.foreground.bundle_id && (await this.target()).kind === 'physical') {
            try {
              const app = await this.bridge({ op: 'app_for_pid', pid: tree.foreground.pid });
              if (app.bundle_id) return text({ ...tree.foreground, bundle_id: app.bundle_id, name: tree.foreground.name ?? app.name, bundle_id_source: 'app_service' });
            } catch (error) { if (stopped(error)) throw error; }
          }
          return text(tree.foreground);
        }
        case 'rotate': {
          const target = await this.target(); this.changed(target);
          this.size = undefined;
          if (target.kind === 'simulator') { const result = await this.bridge({op:'rotate',orientation:args.orientation}); this.frame=undefined; this.elements=[]; return text(result); }
          const expected = {portrait:'Portrait',portrait_upside_down:'PortraitUpsideDown',landscape_left:'LandscapeLeft',landscape_right:'LandscapeRight'}[args.orientation];
          for(let i=0;i<4;i++) {
            const result = await this.native(['rotate','left']);
            const orientation = result.stdout.match(/non_flat_orientation:\s*(\w+)/)?.[1];
            if (!orientation) throw new Error(result.stderr || 'No orientation response');
            if (orientation === expected) { this.frame=undefined; this.elements=[]; return text({orientation:args.orientation,device_report:result.stdout}); }
            if (/locked:\s*true/.test(result.stdout)) throw new Error('Device rotation is locked.');
          }
          throw new Error('The requested orientation was not reported by the device.');
        }
        // Without await, the finally below restores the device state while the first step is still looking up its device.
        case 'batch_commands': return await runBatch(this, args);
        default: {
          const looks = reportsScreen.has(name) && !this.inBatch, touches = touchesControl.has(name);
          this.beforeInput = undefined;
          // A batch step may reuse the read its predecessor just took of the same screen.
          const before = looks || touches ? await this.readBefore(this.inBatch ? justReadMs : 0) : undefined;
          let result = await interaction(this,name,args);
          if(result===undefined) throw new Error(`No implementation for ${name}`);
          const delivered = result.sent === true && !result.isError && !result.stopped;
          // A target that had to be waited for is compared with the screen it was found on, not the one before the wait.
          const sentTo = this.beforeInput ?? before, signature = sentTo?.elements.length ? sentTo.signature : undefined;
          if (looks && delivered) result = { ...result, ...await this.readback(signature) };
          else if (touches && delivered && signature !== undefined) result = { ...result, ...await this.changedSince(signature) };
          const unchanged = touches && result.screen_changed === false && !result.stopped;
          if (unchanged) result = { ...result, instruction: unchangedAdvice };
          // The input layers always answer false here. Only a touch is compared inside a batch; the batch ends with the screen.
          if (this.inBatch && result.screen_change_verified === false) { const { screen_change_verified, ...rest } = result; result = rest; }
          // The user's answer is the result: a confirmed dialog is a success, and an unanswered one an ordinary failure for stop_on_error to decide.
          if (name === 'request_human_action') return { ...(result.completed ? {} : { isError: true, _meta: { stop_reason: 'error' } }), ...text(result) };
          if (result.stopped || result.isError) return { isError: true, ...text(result), _meta: { stop_reason: result.stop_reason ?? (result.stopped ? 'cancelled' : 'unknown') } };
          if (name === 'wait_for') return { content: [...text(result).content, { type: 'image', data: this.frame.data.toString('base64'), mimeType: 'image/png' }] };
          return { ...text(result), ...(unchanged ? { _meta: { stop_reason: 'no_change' } } : {}) };
        }
      }
    } finally { this.requested=previous; if (!sharesTarget) this.resolved=previousResolved; }
  }
}

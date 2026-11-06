// Fork-only (poki-remote). With POKI_BRIDGE_DAEMON=1, the poki-native requests that Devices.run would
// start a process for are sent instead to one long-lived poki-bridged process per device, which keeps
// the tunnel, the input services and their media session open between requests (see
// native/bridge/src/bin/poki-bridged/daemon.rs). The answers carry poki-native's own output, so the
// callers see the same stdout, and the same error text, as from a poki-native process.
//
// Off by default. Without the variable nothing here runs and every request starts poki-native as before.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, stateDir } from './config.mjs';
import { checkWork, phase, signal, work } from './work.mjs';

export const enabled = (env = process.env) => env.POKI_BRIDGE_DAEMON === '1';
const nativeFile = () => join(root, 'build/poki-native');
export const daemonFile = (env = process.env) => env.POKI_BRIDGED ?? join(root, 'build/poki-bridged');

// The ops poki-bridged runs. Installs keep their own process, and so does a held location.
const served = new Set(['display_info', 'list_apps', 'launch_app', 'configuration', 'ax_tree', 'app_for_pid', 'lockdown_get', 'screenshot', 'rotate', 'pasteboard', 'tap', 'double_tap', 'long_press', 'drag', 'pinch', 'key', 'button', 'type_text']);

// Ops that change nothing on the phone, which the client may send again when the daemon died
// while running one.
export function repeatable(request) {
  if (['display_info', 'list_apps', 'ax_tree', 'app_for_pid', 'lockdown_get', 'screenshot'].includes(request.op)) return true;
  if (request.op === 'pasteboard') return request.action !== 'set';
  if (request.op === 'configuration') return String(request.method).startsWith('get_');
  return false;
}

// Whether Devices.run should hand this call to the daemon. Without a built poki-bridged the call
// starts poki-native as usual.
export function routes(file, input, env = process.env) {
  if (!enabled(env) || file !== nativeFile() || typeof input !== 'string' || !existsSync(daemonFile(env))) return false;
  try { return served.has(JSON.parse(input)?.op); } catch { return false; }
}

const hash = args => createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);

// The socket for one device's target arguments. The name is a hash, so the pairing file path stays
// out of it. Unix socket paths are limited to about 104 bytes.
export function socketPath(args, env = process.env) {
  const name = `${hash(args)}.sock`;
  const preferred = env.POKI_BRIDGED_SOCKET_DIR ?? join(stateDir, 'bridged');
  if (Buffer.byteLength(join(preferred, name)) <= 100) return join(preferred, name);
  return join(tmpdir(), `poki-bridged-${process.getuid?.() ?? 'user'}`, name);
}

const incomplete = (detail, extra = {}) => Object.assign(new Error(`Command did not complete: ${String(detail).trim().slice(-4000)}. An input may already have been delivered; inspect before retrying.`), extra);
const deadlineError = () => new DOMException('External process deadline exceeded', 'TimeoutError');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sends one line on a new connection and resolves to the answer line. `sent` reports whether the
// request reached the socket, so a caller knows whether the daemon may have acted on it.
function exchange(path, request, { timeout = 95000, abortSignal } = {}) {
  return new Promise((resolve, reject) => {
    let sent = false, buffer = '', settled = false;
    const socket = createConnection(path);
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); abortSignal?.removeEventListener('abort', onAbort);
      socket.destroy();
      error ? reject(Object.assign(error, { sent })) : resolve(value);
    };
    const timer = setTimeout(() => finish(deadlineError()), timeout);
    const onAbort = () => finish(abortSignal.reason);
    if (abortSignal?.aborted) return finish(abortSignal.reason);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => { socket.write(`${JSON.stringify(request)}\n`, () => { sent = true; }); });
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Object.assign(new Error('poki-bridged closed the connection without answering'), { code: 'EBRIDGEDCLOSED' })));
  });
}

const unreachable = error => ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(error?.code) && !error.sent;

export class BridgeDaemon {
  #ready; #nextId = 1;
  constructor(args, env = process.env) {
    this.args = args; this.env = env; this.path = socketPath(args, env);
    this.log = this.path.replace(/\.sock$/, '.log');
    this.started = 0; // daemons this client started
    this.last = undefined; // the last answer's timings
  }
  ping(timeout = 2000) { return exchange(this.path, { op: 'ping' }, { timeout }); }
  // A running daemon, started here when there is none or when the executable changed since it began.
  ready() {
    this.#ready ??= this.#start(true).catch(error => { this.#ready = undefined; throw error; });
    return this.#ready;
  }
  async #start(checkVersion) {
    try {
      const { pong } = await this.ping();
      const version = Math.floor(statSync(daemonFile(this.env)).mtimeMs / 1000);
      if (!checkVersion || pong.version === version) return;
      await exchange(this.path, { op: 'shutdown' }, { timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 50 && await this.ping(200).then(() => true, () => false); i++) await wait(100);
    } catch (error) {
      if (!unreachable(error) && error.name !== 'TimeoutError') throw error;
    }
    await this.#spawn();
  }
  async #spawn() {
    const dir = this.path.slice(0, this.path.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = openSync(this.log, 'a', 0o600);
    let exited;
    try {
      const child = spawn(daemonFile(this.env), ['--socket', this.path, ...this.args], { detached: true, stdio: ['ignore', 'ignore', log], env: this.env });
      child.once('error', error => { exited = error; });
      // Code 3: another daemon won the race for this socket, which serves just as well.
      child.once('exit', code => { if (code !== 3) exited ??= new Error(`poki-bridged exited with code ${code}`); });
      child.unref();
      this.started++;
    } finally { closeSync(log); }
    const deadline = performance.now() + Number(this.env.POKI_BRIDGED_START_MS ?? 10000);
    while (performance.now() < deadline) {
      if (exited) throw incomplete(`${exited.message}: ${this.#logTail()}`);
      try { await this.ping(500); return; } catch { await wait(50); }
    }
    throw incomplete(`poki-bridged did not start within ${deadline} ms: ${this.#logTail()}`);
  }
  #logTail() { try { return readFileSync(this.log, 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return ''; } }
  // Sends one poki-native request and resolves to { stdout, stderr } as a poki-native process would.
  async run(request, { timeout = 95000, abortSignal } = {}) {
    this.last = undefined;
    await this.ready();
    let answer;
    for (let attempt = 0; ; attempt++) {
      try {
        answer = await exchange(this.path, { id: this.#nextId++, ...request }, { timeout, abortSignal });
        break;
      } catch (error) {
        if (abortSignal?.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
        // The daemon is gone. Start another; send the request again only when the first copy never
        // reached it, or when sending it twice is harmless.
        const again = attempt === 0 && (unreachable(error) || (error.code === 'EBRIDGEDCLOSED' && repeatable(request)));
        if (!again) throw incomplete(error.message);
        this.#ready = this.#start(false).catch(e => { this.#ready = undefined; throw e; });
        await this.#ready;
      }
    }
    this.last = answer.timings;
    if (answer.ok) return { stdout: String(answer.stdout ?? '').trimEnd(), stderr: '' };
    const stderr = String(answer.stderr ?? answer.error ?? '').trimEnd();
    throw incomplete(stderr, { stdout: '', stderr });
  }
}

const daemons = new Map();
export function daemonFor(args, env = process.env) {
  const key = JSON.stringify(args);
  if (!daemons.has(key)) daemons.set(key, new BridgeDaemon(args, env));
  return daemons.get(key);
}

// The daemon counterpart of execute() for one poki-native call: same arguments, same result shape.
export function runThroughDaemon(args, { timeout = 45000, input } = {}) {
  checkWork();
  const request = JSON.parse(input);
  return phase('bridge_daemon', async () => {
    const daemon = daemonFor(args);
    try { return await daemon.run(request, { timeout, abortSignal: signal() }); }
    finally {
      const context = work.getStore();
      if (context && daemon.last) context.timings.push({ id: context.timings.length, phase: 'bridge_daemon_op', parent: context.phase ?? null, elapsed_ms: daemon.last.total_ms, ...daemon.last });
    }
  });
}

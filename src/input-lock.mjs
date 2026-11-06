// Opt-in scheduling for a daemon shared by several MCP clients (POKI_INPUT_LOCK=1).
//
// Without it, Coordination runs every tool call from every session one after another. With it,
// each session keeps its own order, read-only tools run beside other sessions' work (capped by
// POKI_MAX_CONCURRENT_READS), and tools that change the screen take a lock on their device,
// because one phone has one screen. A call that cannot get the lock within
// POKI_INPUT_LOCK_WAIT_MS fails with an error that names the holder.
//
// The lock lives in this process. Two daemons driving one phone are not supported.

const ANY = '*';

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function inputLockFromEnv(env = process.env) {
  if (env.POKI_INPUT_LOCK !== '1') return undefined;
  return new InputLock({
    waitMs: positiveInteger(env.POKI_INPUT_LOCK_WAIT_MS, 30000, 'POKI_INPUT_LOCK_WAIT_MS'),
    maxReads: Math.max(1, positiveInteger(env.POKI_MAX_CONCURRENT_READS, 4, 'POKI_MAX_CONCURRENT_READS')),
  });
}

// The device a call will act on: its own device argument, a batch step's device argument, the
// session's selected device, or ANY when the device is chosen later. ANY excludes every device.
export function deviceKey(ctx, args) {
  if (typeof args?.device === 'string' && args.device) return args.device;
  if (Array.isArray(args?.commands)) {
    const devices = new Set(args.commands.map(step => step?.arguments?.device).filter(d => typeof d === 'string' && d));
    if (devices.size === 1) return [...devices][0];
    if (devices.size > 1) return ANY;
  }
  return ctx.selected ?? ANY;
}

export class InputLock {
  holders = new Map(); waiters = new Set(); reads = 0; readWaiters = [];
  constructor({ waitMs = 30000, maxReads = 4 } = {}) { this.waitMs = waitMs; this.maxReads = maxReads; }

  free(key) { return key === ANY ? this.holders.size === 0 : !this.holders.has(key) && !this.holders.has(ANY); }

  // Resolves to a release function. Rejects with the holder named after waitMs, or when signal aborts.
  acquire(key, holder, signal) {
    const take = () => { const entry = { ...holder, since: performance.now() }; this.holders.set(key, entry); return () => { if (this.holders.get(key) === entry) this.holders.delete(key); this.wake(); }; };
    if (this.free(key) && this.waiters.size === 0) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const waiter = { key, ready: () => { finish(); resolve(take()); } };
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { finish(); reject(signal.reason); this.wake(); };
      const timer = setTimeout(() => { finish(); reject(this.busy(key)); this.wake(); }, this.waitMs);
      timer.unref?.();
      signal?.addEventListener('abort', aborted, { once: true });
      this.waiters.add(waiter);
      this.wake();
    });
  }

  // First come, first served among waiters whose device is free; a waiter for a busy device does
  // not hold up a waiter for another device.
  wake() {
    const claimed = new Set();
    for (const waiter of [...this.waiters]) {
      const blockedByEarlier = claimed.has(ANY) || claimed.has(waiter.key) || (waiter.key === ANY && claimed.size > 0);
      if (!blockedByEarlier && this.free(waiter.key)) waiter.ready();
      else claimed.add(waiter.key);
    }
  }

  busy(key) {
    const holder = this.holders.get(key) ?? this.holders.get(ANY) ?? [...this.holders.values()][0];
    const device = key === ANY ? 'The device' : `Device ${key}`;
    const who = holder ? ` Session ${holder.session ?? 'unknown'} is running ${holder.tool} (held ${Math.round(performance.now() - holder.since)} ms).` : '';
    return Object.assign(new Error(`${device} is busy with input from another session.${who} Waited ${this.waitMs} ms; retry when it finishes.`), { name: 'InputLockTimeout' });
  }

  readSlot(signal) {
    if (this.reads < this.maxReads) { this.reads++; return Promise.resolve(() => this.releaseRead()); }
    return new Promise((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', aborted); this.reads++; resolve(() => this.releaseRead()); };
      const aborted = () => { this.readWaiters = this.readWaiters.filter(w => w !== waiter); reject(signal.reason); };
      signal?.addEventListener('abort', aborted, { once: true });
      this.readWaiters.push(waiter);
    });
  }
  releaseRead() { this.reads--; this.readWaiters.shift()?.(); }
}

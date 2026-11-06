import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const work = new AsyncLocalStorage();
export function checkWork() { const context = work.getStore(); context?.signal.throwIfAborted(); if (context?.deadline !== undefined && performance.now() >= context.deadline) throw new DOMException('Observation deadline exceeded', 'TimeoutError'); }
// Time left before the innermost deadline, so a caller can skip work that would not finish inside it.
export function remaining() { const end = work.getStore()?.deadline; return end === undefined ? Infinity : end - performance.now(); }
// The timing entries other layers recorded after `from`, such as how a long-lived bridge served a read.
export function timingCount() { return work.getStore()?.timings?.length ?? 0; }
export function timingsSince(from) { return work.getStore()?.timings?.slice(from) ?? []; }
export function signal() { return work.getStore()?.signal; }
export async function pause(ms) { checkWork(); const current = signal(); try { await delay(ms, undefined, { signal: current }); } catch (error) { throw current?.aborted ? current.reason : error; } }
export function stoppingReason(error) { return error?.stopReason ?? (error?.name === 'TimeoutError' ? 'timeout' : 'cancelled'); }
export function stopped(error) { return ['AbortError', 'TimeoutError'].includes(error?.name) || signal()?.aborted; }
export async function phase(name, fn) {
  const context = work.getStore();
  if (!context) return fn();
  const start = performance.now(), id = context.timings.length;
  const entry = { id, phase: name, parent: context.phase ?? null, elapsed_ms: 0 };
  context.timings.push(entry);
  try { return await work.run({ ...context, phase: id }, fn); }
  finally { entry.elapsed_ms = Math.round((performance.now() - start) * 100) / 100; }
}
export async function deadline(milliseconds, fn) {
  checkWork();
  const context = work.getStore();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Observation deadline exceeded', 'TimeoutError')), Math.max(0, milliseconds));
  const combined = context?.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  try { return await work.run({ ...context, signal: combined, deadline: Math.min(context?.deadline ?? Infinity, performance.now() + milliseconds) }, fn); }
  finally { clearTimeout(timer); }
}

// Keep the request alive until the owned child actually closes, including after
// an abort. Releasing a device must not hand it over while that child still runs.
export function execute(file, args, { timeout = 45000, input, env, maxBuffer = 32 * 1024 * 1024 } = {}) {
  checkWork();
  const callerSignal = signal();
  return phase('external_process', () => new Promise((resolve, reject) => {
    let outcome, escalation;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException('External process deadline exceeded', 'TimeoutError')), timeout);
    const requestSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutController.signal]) : timeoutController.signal;
    const child = execFile(file, args, { detached: true, env: env ?? process.env, maxBuffer, encoding: 'utf8', signal: requestSignal }, (error, stdout, stderr) => {
      outcome = error ? { error: requestSignal?.aborted ? requestSignal.reason : Object.assign(new Error(`Command did not complete: ${(stderr || stdout || error.message).trim().slice(-4000)}. An input may already have been delivered; inspect before retrying.`), { stdout, stderr }) } : { stdout, stderr };
    });
    const killOwnedGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); } } };
    const abort = () => { killOwnedGroup('SIGTERM'); escalation = setTimeout(() => killOwnedGroup('SIGKILL'), 1000); };
    requestSignal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => {
      clearTimeout(timer); clearTimeout(escalation); requestSignal?.removeEventListener('abort', abort);
      if (requestSignal.aborted) killOwnedGroup('SIGKILL');
      if (outcome?.error) reject(outcome.error);
      else if (requestSignal?.aborted) reject(requestSignal.reason);
      else resolve(outcome ?? { stdout: '', stderr: '' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }));
}

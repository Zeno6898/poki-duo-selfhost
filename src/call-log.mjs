// POKI_MCP_CALL_LOG=<path> appends one line per finished tool call, for measuring how agents use the
// tools: which tool, how long it took, its verdict when it has one, and whether it failed. Never the
// arguments, text or images, and the session only as a hash. A failed write never fails the call.
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const verdictOf = result => result?._meta?.verdict ?? null;

export async function withCallLog(session, tool, call) {
  const path = process.env.POKI_MCP_CALL_LOG;
  if (!path) return call();
  const started = performance.now();
  let result, error = false;
  try { result = await call(); error = Boolean(result?.isError); return result; }
  catch (failure) { error = true; throw failure; }
  finally {
    const line = { at: new Date().toISOString(), session: createHash('sha256').update(String(session)).digest('hex').slice(0, 12), tool, ms: Math.round(performance.now() - started), verdict: verdictOf(result), error };
    await appendFile(path, JSON.stringify(line) + '\n', { mode: 0o600 }).catch(() => {});
  }
}

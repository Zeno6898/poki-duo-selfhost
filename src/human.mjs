import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execute, signal } from './work.mjs';

// The MCP request that is being served, so a prompt can go back to the client that asked.
// tools.mjs fills it in for each tool call; it stays empty where the transport cannot carry
// a server-to-client request.
export const humanChannel = new AsyncLocalStorage();

const question = { type: 'object', properties: { done: { type: 'boolean', title: 'Done', description: 'Choose true only after the request has been completed.' } }, required: ['done'] };

const result = status => ({
  status, completed: status === 'done',
  message: status === 'done' ? 'The user confirmed the dialog. Inspect the device before continuing.'
    : status === 'unavailable' ? 'No person could be asked: this host has no macOS dialog and the MCP client did not accept an elicitation request. Ask the user in your conversation instead, or have the operator set POKI_MCP_APPROVAL_MODE=allow for actions that need approval.'
    : 'The user did not confirm completion.',
});

async function onPath(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { await access(join(directory, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

// A real macOS dialog is the acknowledgment. A successful notification alone is not.
async function askDialog(message, seconds) {
  const script = `on run argv
      set promptText to item 1 of argv
      set waitSeconds to (item 2 of argv) as integer
      try
        set response to display dialog promptText with title "Poki MCP" buttons {"取消", "确认"} default button "确认" cancel button "取消" giving up after waitSeconds
        if gave up of response then return "timeout"
        if button returned of response is "确认" then return "done"
        return "cancelled"
      on error number -128
        return "cancelled"
      end try
    end run`;
  const { stdout } = await execute('osascript', ['-e', script, '--', message, String(Math.ceil(seconds))], { timeout: (seconds + 10) * 1000 });
  return result(stdout.trim());
}

// The same question as an MCP form elicitation. Only an explicit accept with done=true counts.
async function askClient(elicit, message, seconds) {
  const caller = signal();
  const timeout = AbortSignal.timeout(Math.ceil(seconds) * 1000);
  try {
    const answer = await elicit({ mode: 'form', message: `Poki MCP\n${message}`, requestedSchema: question }, { signal: caller ? AbortSignal.any([caller, timeout]) : timeout, timeout: Math.ceil(seconds) * 1000 });
    return result(answer?.action === 'accept' && answer.content?.done === true ? 'done' : 'cancelled');
  } catch (error) {
    if (caller?.aborted) throw caller.reason;
    if (timeout.aborted || /timed? ?out/i.test(error.message)) return result('timeout');
    throw error;
  }
}

// macOS keeps its dialog. Elsewhere the MCP client is asked through elicitation; a host with
// neither reports that nobody was asked, and never counts that as a confirmation.
export async function askHuman(message, seconds = 120) {
  if (process.platform === 'darwin') return askDialog(message, seconds);
  const elicit = humanChannel.getStore()?.elicit;
  if (elicit) {
    try { return await askClient(elicit, message, seconds); }
    catch (error) { if (error?.name === 'AbortError' || signal()?.aborted) throw error; }
  }
  if (await onPath('osascript')) return askDialog(message, seconds);
  return result('unavailable');
}

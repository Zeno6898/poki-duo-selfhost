import { checkWork, phase, stopped, stoppingReason } from './work.mjs';
import { managementTools } from './coordination.mjs';
import { definitions } from './tools.mjs';
import { closestTo } from './interaction.mjs';

const json = value => ({ type: 'text', text: JSON.stringify(value) });
const receipt = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });
const offDevice = new Set(['wait', 'list_devices', 'poki_mcp_status', 'request_human_action']);
const changesDevice = new Set(['select_device', 'start_simulator', 'shut_down_simulator']);
// Clients show tools under a prefixed name, and models copy it into a step.
const stepTool = tool => tool.replace(/^mcp__poki-mcp__/, '');

function invalidStep(command) {
  if (command.tool === 'batch_commands') return 'Nested batches are not supported.';
  if (managementTools.has(command.tool)) return 'Call device management tools outside a batch.';
  const definition = definitions.find(([name]) => name === command.tool);
  if (!definition) {
    const closest = closestTo(command.tool, definitions.map(([name]) => name));
    return `Unknown tool: ${command.tool}.${closest.length ? ` Did you mean ${closest.join(', ')}?` : ''}`;
  }
  const schema = definition[2], parsed = schema.safeParse(command.arguments ?? {});
  if (parsed.success) return null;
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  return `Invalid arguments for ${command.tool}: ${issues}. It accepts: ${Object.keys(schema.shape ?? {}).join(', ')}.`;
}

function advice(reason, failedStep) {
  const earlier = failedStep > 1 ? `Steps 1-${failedStep - 1} already ran; do not repeat them.` : 'No earlier step ran.';
  if (reason === 'error') return `${earlier} Fix the failed step, then send only remaining_steps.`;
  if (reason === 'unknown') return `${earlier} Step ${failedStep} may have been delivered, so check the screen before resending it.`;
  if (reason === 'no_change') return `${failedStep > 1 ? `Steps 1-${failedStep - 1} already ran; do not repeat them. ` : ''}Step ${failedStep} was sent, and no change was observed after it (same elements, text, values, state and positions). That is not proof it failed, but the steps after it were written for the screen it should produce, so they did not run. Check screen: if it already shows that screen, send only remaining_steps; if not, send step ${failedStep} again followed by remaining_steps. stop_on_error=false runs a batch through such taps.`;
  return `${earlier} Work stopped (${reason}); check the screen before continuing.`;
}

// A batch is one queued operation, so its steps share a device lookup. A touch is compared with the
// screen before it when a later step depends on that (see Devices.checksStep); the screen itself is
// read back once, after the last step.
export async function runBatch(ctx, args) {
  const commands = args.commands.map(command => ({ ...command, tool: stepTool(command.tool) }));
  const stopOnError = args.stop_on_error !== false;
  const invalid = stopOnError ? commands.findIndex(invalidStep) : -1;
  if (invalid >= 0) {
    const error = invalidStep(commands[invalid]);
    return { isError: true, content: [json({ step: invalid + 1, tool: commands[invalid].tool, isError: true, elapsed_ms: 0 }), { type: 'text', text: error }, receipt({ completed_steps: 0, stop_reason: 'error', failed_step: { step: invalid + 1, ...commands[invalid], error }, remaining_steps: commands, next: 'Nothing ran. Fix the failed step and send the whole batch again.' })] };
  }
  const blocks = [];
  let stopReason, failed = false, ran = 0, failure, unchanged;
  ctx.inBatch = true;
  try {
    for (const [index, command] of commands.entries()) {
      const started = performance.now();
      ctx.batchStep = { next: commands[index + 1], stopOnError };
      let result;
      try {
        checkWork();
        const problem = invalidStep(command);
        if (problem) throw new Error(problem);
        result = await ctx.dispatch(command.tool, command.arguments ?? {});
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
        if (stopped(error)) stopReason = stoppingReason(error);
      }
      ran++;
      blocks.push(json({ step: ran, tool: command.tool, isError: Boolean(result.isError), elapsed_ms: Math.round(performance.now() - started) }), ...result.content);
      // A fill that typed the wrong text is an ordinary failure: stop_on_error decides, not this block.
      // A touch with no observed change may still have worked. The batch pauses only to hold back the steps
      // written for the screen it should produce, so with none left, or when the caller allows it, it goes on.
      const reason = result._meta?.stop_reason;
      if (reason === 'no_change') { if (stopOnError && ran < commands.length) { stopReason = reason; unchanged = { step: ran, ...command }; } }
      else if (reason && reason !== 'error') stopReason = reason;
      if (result.isError) {
        failed = true;
        failure = { step: ran, ...command, error: result.content.find(block => block.type === 'text')?.text };
        if (!stopReason && stopOnError) stopReason = 'error';
      } else failure = undefined;
      if (stopReason) break;
      if (changesDevice.has(command.tool)) ctx.resolved = undefined;
    }
  } finally { ctx.inBatch = false; ctx.batchStep = undefined; }
  const summary = {};
  // Reading a simulator that a step just shut down would boot it again.
  const last = commands.slice(0, ran).findLast(command => !offDevice.has(command.tool));
  if (last && last.tool !== 'shut_down_simulator') {
    // dispatch restores both when this batch ends.
    if (last.arguments?.device) { ctx.requested = last.arguments.device; ctx.resolved = undefined; }
    const { screen, stop_reason } = await phase('batch_readback', () => ctx.readback());
    stopReason ??= stop_reason;
    summary.screen = screen;
  }
  if (stopReason) {
    if (failure) {
      Object.assign(summary, { failed_step: failure, remaining_steps: commands.slice(failure.step - 1), next: advice(stopReason, failure.step) });
      if (failure.tool === 'fill' && /No visible element matches|Requested field is not visible/.test(failure.error ?? '')) {
        const fields = (ctx.seen?.elements ?? []).filter(element => element.visible !== false && element.visible !== 0 && /^(?:AX|XCUIElementType)?(?:Secure)?(?:TextField|TextArea|TextView|SearchField)$/i.test(element.type ?? element.role ?? ''))
          .map(element => element.identifier || element.label || element.placeholder);
        if (fields.length === 1 && fields[0]) {
          const { field: _field, ref: _ref, x: _x, y: _y, ...rest } = failure.arguments ?? {};
          summary.next_commands = [{ tool: 'fill', arguments: { ...rest, field: fields[0] } }, ...commands.slice(failure.step)];
          summary.next = `The current visible text field is ${JSON.stringify(fields[0])}. If this is the intended field, run next_commands with that exact label. No text was entered by the failed fill. Earlier completed steps, including launch_app, need not run again.`;
        }
      }
    }
    else if (unchanged) Object.assign(summary, { unchanged_step: unchanged, remaining_steps: commands.slice(ran), next: advice(stopReason, ran) });
    else Object.assign(summary, { remaining_steps: commands.slice(ran), next: advice(stopReason, ran + 1) });
  }
  return { ...(failed || stopReason ? { isError: true } : {}), content: [...blocks, receipt({ completed_steps: ran, stop_reason: stopReason ?? null, ...summary })] };
}

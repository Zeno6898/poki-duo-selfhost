#!/usr/bin/env node
// The fixed device suite for the computer-use profile (POKI_TOOL_PROFILE=cua): three generic tasks on
// built-in apps, driven the way a model drives the tools, one decision per tool call, each decision
// made only from the previous answer. Run it on the server after every build:
//
//   node test/suite/cua-suite.mjs                      the local daemon (its endpoint file)
//   node test/suite/cua-suite.mjs --url http://127.0.0.1:8846/mcp --token "$TOKEN"
//
// It prints one JSON line per task and a summary: wall time, decisions (tool calls), extra looks
// (look calls after the first of a task), failed or unknown actions, and the per-call times. The
// tasks change nothing that matters on the phone: they read Settings, open a web page, and run and
// reset the stopwatch. They are measurement, not tuning: nothing in src/ knows about them.
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { endpointFile } from '../../src/config.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
let url = arg('url'), token = arg('token') ?? process.env.POKI_SUITE_TOKEN;
if (!url) { const entry = JSON.parse(await readFile(endpointFile, 'utf8')); url = entry.url; token ??= entry.token; }
const only = arg('task');

const client = new Client({ name: 'cua-suite', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'x-poki-mcp-session': 'cua-suite', ...(token ? { Authorization: `Bearer ${token}` } : {}) } } }));
const listed = (await client.listTools()).tools.map(t => t.name);
if (!listed.includes('do') || !listed.includes('look')) { console.error(`This server does not list look and do (it lists ${listed.join(', ')}). Start it with POKI_TOOL_PROFILE=cua.`); process.exit(2); }

const textOf = result => result.content?.find(b => b.type === 'text')?.text ?? '';
// The element number of the first line whose label matches, as a model would pick it from the list.
const find = (answer, pattern) => { for (const line of answer.split('\n')) { const m = line.match(/^[+ ](\d+) (\S+) "(.*)" \[/); if (m && pattern.test(m[3])) return Number(m[1]); } return undefined; };
const has = (answer, pattern) => answer.split('\n').some(line => /^[+ ]\d+ /.test(line) && pattern.test(line));

async function task(name, body) {
  const calls = [];
  let looks = 0;
  const call = async (tool, args) => {
    const started = performance.now();
    const result = await client.callTool({ name: tool, arguments: args }, { timeout: 60000 });
    const answer = textOf(result);
    if (tool === 'look') looks++;
    calls.push({ tool, ms: Math.round(performance.now() - started), failed: Boolean(result.isError), unknown: /\(unknown,/.test(answer), source: answer.match(/read: \S+ \(\d+ ms, (\w+)\)/)?.[1] });
    return answer;
  };
  const started = performance.now();
  let ok = false, error;
  try { ok = await body(call); } catch (e) { error = e.message; }
  const report = { task: name, ok, wall_ms: Math.round(performance.now() - started), decisions: calls.length, extra_looks: Math.max(0, looks - 1), failed_actions: calls.filter(c => c.failed).length, unknown_actions: calls.filter(c => c.unknown).length, calls, ...(error ? { error } : {}) };
  console.log(JSON.stringify(report));
  return report;
}

const tasks = {
  // Read the iOS version from Settings > General > About.
  async settings_version(call) {
    let a = await call('do', { actions: [{ launch: 'com.apple.Preferences' }] });
    if (!find(a, /^General$/)) a = await call('do', { actions: [{ scroll_to: 'General' }] });
    const general = find(a, /^General$/);
    if (!general) return false;
    a = await call('do', { actions: [{ tap: general }] });
    const about = find(a, /^About$/);
    if (!about) return false;
    a = await call('do', { actions: [{ tap: about }] });
    return has(a, /iOS Version|Software Version/);
  },
  // Open a web page in Safari by typing its address.
  async safari_page(call) {
    let a = await call('do', { actions: [{ launch: 'com.apple.mobilesafari' }] });
    let field = find(a, /Address|Search or enter website name|URL/i);
    if (!field) { a = await call('look', {}); field = find(a, /Address|Search or enter website name|URL/i); }
    if (!field) return false;
    a = await call('do', { actions: [{ type: 'example.com', ref: field, clear: true }, { key: 'return' }, { wait: 1500 }] });
    if (has(a, /Example Domain/)) return true;
    a = await call('look', {});
    return has(a, /Example Domain/);
  },
  // Start the stopwatch, stop it after a moment, read it, and reset it.
  async stopwatch(call) {
    let a = await call('do', { actions: [{ launch: 'com.apple.mobiletimer' }] });
    const tab = find(a, /^Stopwatch$/);
    if (tab) a = await call('do', { actions: [{ tap: tab }] });
    const start = find(a, /^Start$/);
    if (!start) return false;
    a = await call('do', { actions: [{ tap: start }, { wait: 1500 }] });
    const stop = find(a, /^Stop$/);
    if (!stop) return false;
    a = await call('do', { actions: [{ tap: stop }] });
    const read = has(a, /\d\d:\d\d[,.]\d\d/);
    const reset = find(a, /^Reset$/);
    if (reset) await call('do', { actions: [{ tap: reset }] });
    return read;
  },
};

const reports = [];
for (const [name, body] of Object.entries(tasks)) if (!only || only === name) reports.push(await task(name, body));
console.log(JSON.stringify({ summary: true, ok: reports.filter(r => r.ok).length, of: reports.length, wall_ms: reports.reduce((s, r) => s + r.wall_ms, 0), decisions: reports.reduce((s, r) => s + r.decisions, 0), extra_looks: reports.reduce((s, r) => s + r.extra_looks, 0) }));
await client.close();

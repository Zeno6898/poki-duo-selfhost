#!/usr/bin/env node
// A stand-in for poki-bridged that speaks its socket protocol without a phone. It answers with the
// canned results below, records each request in FAKE_BRIDGED_RECORD, and exits mid-request for an op
// named in FAKE_BRIDGED_CRASH (once, then it clears the marker file).
import { createServer } from 'node:net';
import { appendFileSync, existsSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const socket = args[args.indexOf('--socket') + 1];
const version = Math.floor(statSync(fileURLToPath(import.meta.url)).mtimeMs / 1000);
const results = {
  tap: { sent: true, screen_change_verified: false },
  ax_tree: { foreground_app: 'com.example', elements: [{ role: 'Button', label: 'OK', x: 1.5, y: 2, width: 3, height: 4 }] },
  lockdown_get: { value: 'Phone' },
};
let ops = 0;
if (existsSync(socket)) unlinkSync(socket);
const server = createServer(connection => {
  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const { id, ...request } = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (request.op === 'ping') { connection.write(`${JSON.stringify({ id, ok: true, pong: { pid: process.pid, version, ops } })}\n`); continue; }
      if (request.op === 'shutdown') { connection.end(`${JSON.stringify({ id, ok: true })}\n`); server.close(); rmSync(socket, { force: true }); process.exit(0); }
      ops++;
      if (process.env.FAKE_BRIDGED_RECORD) appendFileSync(process.env.FAKE_BRIDGED_RECORD, `${JSON.stringify({ pid: process.pid, request })}\n`);
      const crash = process.env.FAKE_BRIDGED_CRASH;
      if (crash && existsSync(crash) && request.op === process.env.FAKE_BRIDGED_CRASH_OP) { rmSync(crash); rmSync(socket, { force: true }); process.exit(1); }
      const result = results[request.op];
      const answer = result
        ? { id, ok: true, stdout: JSON.stringify(result), timings: { total_ms: 1, reused_tunnel: ops > 1 } }
        : { id, ok: false, stderr: JSON.stringify({ error: `unknown op ${request.op}`, screen_change_verified: false }), timings: { total_ms: 0 } };
      connection.write(`${JSON.stringify(answer)}\n`);
    }
  });
});
server.listen(socket, () => process.stderr.write('fake poki-bridged ready\n'));

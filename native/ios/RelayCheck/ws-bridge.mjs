// One WebSocket for relay-check on Linux: messages in and out as JSON strings, one per line.
// The first line out is "\u0000open" once connected.
import { createInterface } from 'node:readline';
const ws = new WebSocket(process.argv[2]);
const out = text => process.stdout.write(JSON.stringify(text) + '\n');
ws.addEventListener('open', () => out('\u0000open'));
ws.addEventListener('message', event => out(String(event.data)));
ws.addEventListener('close', event => { process.stderr.write(`ws closed ${event.code} ${event.reason}\n`); process.exit(0); });
ws.addEventListener('error', () => {});
createInterface({ input: process.stdin }).on('line', line => ws.readyState === WebSocket.OPEN && ws.send(JSON.parse(line)));
process.stdin.on('end', () => ws.close(1000));

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rename, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { createServer, definitions } from './tools.mjs';
import { Coordination } from './coordination.mjs';
import { Devices } from './device.mjs';
import { stateDir, endpointFile } from './config.mjs';
import { warnIfNativeStale } from './build-info.mjs';

const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 47825 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
await warnIfNativeStale();
const sessions = new Map();
const coordinator = new Coordination();
const token = randomBytes(32).toString('hex');
const expected = Buffer.from(`Bearer ${token}`);
const validHost = localhostHostValidation();
const validOrigin = localhostOriginValidation();
const active = new Set();

const listener = http.createServer(async (req, res) => {
  if (!validHost(req, res) || !validOrigin(req, res)) return;
  const received = Buffer.from(req.headers.authorization ?? '');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization required' }));
    return;
  }
  if (!['/mcp', '/session/close', '/request/cancel'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  const session = req.headers['x-poki-mcp-session'];
  if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(session)) { res.writeHead(400); res.end('Invalid session'); return; }
  if (!sessions.has(session)) sessions.set(session, new Devices(coordinator));
  const devices = sessions.get(session);
  devices.peers = () => sessions.values();
  devices.label ??= session;
  if (req.url === '/session/close') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    await devices.close(); sessions.delete(session); res.end('{}'); return;
  }
  if (req.url === '/request/cancel') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const id = req.headers['x-poki-request'];
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) { res.writeHead(400); res.end(); return; }
    devices.cancelledRequests ??= new Set();
    devices.cancelledRequests.add(id);
    const expiration = setTimeout(() => devices.cancelledRequests.delete(id), 60000); expiration.unref();
    for (const operation of coordinator.operations) if (operation.owner === devices && operation.requestId === id) operation.controller.abort(new DOMException('Request cancelled', 'AbortError'));
    res.end('{}'); return;
  }
  const server = createServer((name, args, extra) => {
    if (devices.cancelledRequests?.delete(extra?.requestId)) throw new DOMException('Request cancelled', 'AbortError');
    return devices.call(name, args, extra?.signal, extra?.requestId);
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  active.add(server);
  res.once('close', () => { active.delete(server); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
  }
});

await mkdir(stateDir, { recursive: true, mode: 0o700 });
listener.listen(port, '127.0.0.1');
await once(listener, 'listening');
const actualPort = listener.address().port;
const entry = { url: `http://127.0.0.1:${actualPort}/mcp`, port: actualPort, token, enabled: true, pid: process.pid };
const temporary = `${endpointFile}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(entry, null, 2), { mode: 0o600, flag: 'wx' });
await rename(temporary, endpointFile);
await chmod(endpointFile, 0o600);
console.log(JSON.stringify({ event: 'ready', url: entry.url, endpointFile, tools: definitions.length }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise(resolve => listener.close(resolve));
  listener.closeAllConnections();
  await Promise.allSettled([...sessions.values()].map(devices => devices.close()));
  await Promise.allSettled([...active].map(server => server.close()));
  await closed;
  const entry = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => null);
  if (entry?.pid === process.pid) await unlink(endpointFile);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

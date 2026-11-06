// The daemon's front door: decides whether a request is local (bearer token from mcp.json, as
// before) or remote (OAuth 2.1 through the public HTTPS hostname), validates Host and Origin,
// and serves the OAuth discovery and authorization endpoints.
import { createHash, timingSafeEqual } from 'node:crypto';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { validateHostHeader, validateOriginHeader, localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { AuthorizationServer } from './authorization-server.mjs';
import { authenticate, builtinVerifier, externalVerifier, sendMetadata, servesMetadata } from './resource-server.mjs';
import { sendJson } from './http.mjs';

export const mcpPaths = ['/mcp', '/session/close', '/request/cancel'];
const forwardingHeaders = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'tailscale-user-login', 'tailscale-funnel-request'];
const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const sessionPattern = /^[a-zA-Z0-9_-]{1,80}$/;

// Resolves to a function (req, res) => { session, path, authInfo? } | undefined; undefined means
// the request was answered here.
export async function createFront(config, token, { authorizationServer } = {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();

  // The original local path, unchanged: localhost Host and Origin, the bearer token, the session header.
  function local(req, res) {
    if (!validHost(req, res) || !validOrigin(req, res)) return;
    const received = Buffer.from(req.headers.authorization ?? '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authorization required' }));
      return;
    }
    if (!mcpPaths.includes(req.url)) { res.writeHead(404); res.end(); return; }
    const session = req.headers['x-poki-mcp-session'];
    if (typeof session !== 'string' || !sessionPattern.test(session)) { res.writeHead(400); res.end('Invalid session'); return; }
    return { session, path: req.url };
  }
  if (config.mode === 'local') return local;

  const server = config.mode === 'builtin' ? authorizationServer ?? await AuthorizationServer.create(config) : undefined;
  const verifier = server ? builtinVerifier(config, server) : externalVerifier(config);
  const publicHostname = new URL(config.publicUrl).hostname;
  const allowedHosts = [publicHostname, ...config.allowedHosts];
  const localHosts = localhostAllowedHostnames();

  async function remote(req, res, path) {
    const origin = req.headers.origin;
    const originCheck = validateOriginHeader(origin, config.allowedOrigins);
    const cors = origin && originCheck.ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-Poki-Request', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' } : {};
    if (servesMetadata(req, res, path)) { sendMetadata(req, res, config); return; }
    if (server && !mcpPaths.includes(path) && await server.handle(req, res, path)) return;
    if (!mcpPaths.includes(path)) { res.writeHead(404); res.end(); return; }
    if (!originCheck.ok) { sendJson(res, 403, { error: 'Origin not allowed', hint: 'Add the site to POKI_MCP_ALLOWED_ORIGINS' }); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const authInfo = await authenticate(req, res, config, verifier, cors);
    if (!authInfo) return;
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
    // One device session per OAuth grant, so each connected agent keeps its own selection and lease.
    const grant = authInfo.extra?.grant ?? createHash('sha256').update(`${authInfo.extra?.subject}\0${authInfo.clientId}`).digest('base64url').slice(0, 32);
    return { session: `oauth-${grant}`.slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '_'), path, authInfo };
  }

  return async function front(req, res) {
    const forwarded = forwardingHeaders.some(name => req.headers[name] !== undefined);
    const peerLoopback = loopbackPeers.has(req.socket.remoteAddress);
    // A forwarded Host is trusted only from a proxy on this machine (Funnel, cloudflared).
    const hostHeader = forwarded && peerLoopback && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : req.headers.host;
    const host = validateHostHeader(hostHeader, [...allowedHosts, ...localHosts]);
    if (!host.ok) { sendJson(res, 403, { error: 'Host not allowed', hint: 'The daemon answers its POKI_MCP_PUBLIC_URL hostname and localhost' }); return; }
    // The bearer token in mcp.json is for this machine only: never through a proxy or from another host.
    if (localHosts.includes(host.hostname) && !allowedHosts.includes(host.hostname)) {
      if (forwarded || !peerLoopback) { sendJson(res, 403, { error: 'Local access is only for clients on this machine' }); return; }
      return local(req, res);
    }
    let path;
    try { path = new URL(req.url, config.publicUrl).pathname; } catch { res.writeHead(400); res.end(); return; }
    return remote(req, res, path);
  };
}

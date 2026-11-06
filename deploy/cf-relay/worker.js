var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
var enc = new TextEncoder();
var dec = new TextDecoder();
var LABEL = /^[a-z2-7]{52}$/;
var SECRET = /^[A-Za-z0-9_-]{43}$/;
var FORWARDED_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
var RETURNED_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];
var PROOF_CONTEXT = "poki-relay-v1";
var SCOPE = "poki";
var DEFAULTS = {
  MAX_BODY: 4194304,
  // relay frames v1; a received WebSocket message may be up to 32 MiB on Workers
  REQ_TIMEOUT_MS: 6e4,
  PER_MINUTE: 60,
  // MCP requests per label per minute
  CONCURRENT: 4,
  // in flight per label
  LABEL_DAILY: 5e3,
  // MCP requests per label per UTC day
  GLOBAL_DAILY: 8e3,
  // MCP requests for all labels per UTC day (240k/month; DEPLOY.md has the cost model)
  GLOBAL_DAILY_SECONDS: 8e4,
  // estimated Durable Object awake seconds per UTC day (10k GB-s at 128 MB)
  LEASE: 25,
  // requests a device object takes from the daily budget at a time
  ACCESS_TTL: 3600,
  REFRESH_TTL: 30 * 86400,
  REDIRECT_HOSTS: "claude.ai,claude.com,chatgpt.com,chat.openai.com,localhost,127.0.0.1"
};
var limit = /* @__PURE__ */ __name((env, name) => env[name] !== void 0 && env[name] !== "" ? typeof DEFAULTS[name] === "number" ? Number(env[name]) : env[name] : DEFAULTS[name], "limit");
var b64 = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))), "b64");
var b64u = /* @__PURE__ */ __name((bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64u");
var fromB64 = /* @__PURE__ */ __name((text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "fromB64");
var hex = /* @__PURE__ */ __name((bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var sha256 = /* @__PURE__ */ __name(async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data)), "sha256");
function base32(bytes) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[value << 5 - bits & 31];
  return out;
}
__name(base32, "base32");
var hmacKeys = /* @__PURE__ */ new Map();
async function hmacKey(env) {
  const secret = env.TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("TOKEN_SECRET must be set (32+ characters)");
  if (!hmacKeys.has(secret)) hmacKeys.set(secret, crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  return hmacKeys.get(secret);
}
__name(hmacKey, "hmacKey");
async function seal(env, claims) {
  const body = b64u(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body));
  return `${body}.${b64u(signature)}`;
}
__name(seal, "seal");
async function open(env, token2, kind) {
  if (typeof token2 !== "string" || token2.length > 4096) return void 0;
  const [body, signature, extra] = token2.split(".");
  if (!body || !signature || extra !== void 0) return void 0;
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64(signature), enc.encode(body));
  } catch {
    return void 0;
  }
  if (!valid) return void 0;
  const claims = JSON.parse(dec.decode(fromB64(body)));
  if (claims.k !== kind || claims.exp && claims.exp < Date.now() / 1e3) return void 0;
  return claims;
}
__name(open, "open");
var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id" };
var json = /* @__PURE__ */ __name((status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } }), "json");
var notFound = /* @__PURE__ */ __name(() => json(404, { error: "not found" }), "notFound");
var oauthError = /* @__PURE__ */ __name((status, error, description) => json(status, { error, ...description ? { error_description: description } : {} }), "oauthError");
var RPC_ERRORS = {
  offline: [503, -32001, "The phone is offline: open Poki on the phone, or check its network."],
  timeout: [504, -32002, "The phone did not answer in time."],
  limited: [429, -32003, "Too many requests: wait a little and try again."]
};
function rpcError(kind, body) {
  let id = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && !Array.isArray(parsed) && "id" in parsed) id = parsed.id;
  } catch {
  }
  const [status, code, message] = RPC_ERRORS[kind];
  return json(status, { jsonrpc: "2.0", id, error: { code, message } }, kind === "limited" ? { "Retry-After": "10" } : {});
}
__name(rpcError, "rpcError");
function bases(url, label, secret) {
  const base = `${url.origin}/v1/${label}/${secret}`;
  return { base, resource: `${base}/mcp`, issuer: base, prm: `${url.origin}/.well-known/oauth-protected-resource/v1/${label}/${secret}/mcp` };
}
__name(bases, "bases");
function resourceMetadata(b) {
  return { resource: b.resource, authorization_servers: [b.issuer], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] };
}
__name(resourceMetadata, "resourceMetadata");
function serverMetadata(b) {
  return {
    issuer: b.issuer,
    authorization_endpoint: `${b.base}/authorize`,
    token_endpoint: `${b.base}/token`,
    registration_endpoint: `${b.base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE]
  };
}
__name(serverMetadata, "serverMetadata");
function redirectAllowed(env, uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const hosts = String(limit(env, "REDIRECT_HOSTS")).split(",").map((h) => h.trim()).filter(Boolean);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:") return loopback;
  return url.protocol === "https:" && hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}
__name(redirectAllowed, "redirectAllowed");
async function readBody(request, max) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > max) return void 0;
  const buffer = await request.arrayBuffer();
  return buffer.byteLength > max ? void 0 : dec.decode(buffer);
}
__name(readBody, "readBody");
async function register(env, request, label, secretHash) {
  const text = await readBody(request, 16384);
  if (text === void 0) return oauthError(413, "invalid_client_metadata", "too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError(400, "invalid_client_metadata", "not JSON");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string" && redirectAllowed(env, u))) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be https on an allowed host, or http on loopback");
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 64) : "MCP client";
  const issued = Math.floor(Date.now() / 1e3);
  const clientId = await seal(env, { k: "client", l: label, s: secretHash, r: uris, n: name, iat: issued });
  return json(201, { client_id: clientId, client_id_issued_at: issued, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
}
__name(register, "register");
async function authorize(env, url, label, secretHash, b, device) {
  const p = url.searchParams;
  const client = await open(env, p.get("client_id"), "client");
  const redirect = p.get("redirect_uri") ?? client?.r?.[0];
  if (!client || client.l !== label || client.s !== secretHash) return new Response("Unknown client", { status: 400 });
  if (!client.r.includes(redirect)) return new Response("Unregistered redirect_uri", { status: 400 });
  const back = /* @__PURE__ */ __name((params) => {
    const target = new URL(redirect);
    for (const [k, v] of Object.entries({ ...params, state: p.get("state") ?? void 0, iss: b.issuer })) if (v !== void 0) target.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
  }, "back");
  if (p.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
  const challenge = p.get("code_challenge");
  if (p.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
  const resource = p.get("resource");
  if (resource && resource !== b.resource) return back({ error: "invalid_target" });
  const known = await device.fetch(new Request("https://do/knows", { method: "POST", body: JSON.stringify({ secretHash }) }));
  if (known.status === 503) return new Response("The phone is offline: open Poki on the phone, then try again.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (known.status !== 200) return back({ error: "access_denied" });
  const cid = hex(await sha256(p.get("client_id")));
  const code = await seal(env, { k: "code", l: label, s: secretHash, c: cid, r: redirect, cc: challenge, exp: Math.floor(Date.now() / 1e3) + 60 });
  return back({ code });
}
__name(authorize, "authorize");
async function token(env, request, label, secretHash, b) {
  const text = await readBody(request, 16384);
  if (text === void 0) return oauthError(413, "invalid_request");
  const form = new URLSearchParams(text);
  const clientId = form.get("client_id");
  const client = await open(env, clientId, "client");
  if (!client || client.l !== label || client.s !== secretHash) return oauthError(401, "invalid_client");
  const cid = hex(await sha256(clientId));
  let grant;
  if (form.get("grant_type") === "authorization_code") {
    const code = await open(env, form.get("code"), "code");
    if (!code || code.l !== label || code.s !== secretHash || code.c !== cid || code.r !== form.get("redirect_uri")) return oauthError(400, "invalid_grant");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64u(await sha256(verifier)) !== code.cc) return oauthError(400, "invalid_grant", "PKCE verification failed");
    grant = { l: label, s: secretHash, c: cid };
  } else if (form.get("grant_type") === "refresh_token") {
    const refresh = await open(env, form.get("refresh_token"), "refresh");
    if (!refresh || refresh.l !== label || refresh.s !== secretHash || refresh.c !== cid) return oauthError(400, "invalid_grant");
    grant = { l: label, s: secretHash, c: cid };
  } else {
    return oauthError(400, "unsupported_grant_type");
  }
  const now = Math.floor(Date.now() / 1e3);
  const accessTtl = limit(env, "ACCESS_TTL");
  return json(200, {
    access_token: await seal(env, { k: "access", ...grant, aud: b.resource, exp: now + accessTtl }),
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: await seal(env, { k: "refresh", ...grant, exp: now + limit(env, "REFRESH_TTL") }),
    scope: SCOPE
  });
}
__name(token, "token");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    let path = url.pathname;
    let wellKnown;
    const prefix = path.match(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/.*)$/);
    if (prefix) {
      wellKnown = prefix[1];
      path = prefix[2];
    }
    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "v1" || !LABEL.test(parts[1] ?? "")) {
      return env.ORIGIN_FALLBACK === "1" ? fetch(request) : notFound();
    }
    const label = parts[1];
    const device = env.DEVICE.get(env.DEVICE.idFromName(label));
    if (parts.length === 3 && parts[2] === "connect" && !wellKnown) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket only", { status: 426 });
      return device.fetch(new Request(`https://do/connect?label=${label}`, request));
    }
    if (!SECRET.test(parts[2] ?? "")) return notFound();
    const secret = parts[2];
    const secretHash = hex(await sha256(secret));
    const rest = parts.slice(3).join("/");
    const b = bases(url, label, secret);
    if (wellKnown === "oauth-protected-resource" && rest === "mcp") return json(200, resourceMetadata(b));
    if (wellKnown && rest === "") return wellKnown === "oauth-protected-resource" ? json(200, resourceMetadata(b)) : json(200, serverMetadata(b));
    if (wellKnown) return notFound();
    if (rest === ".well-known/oauth-protected-resource" || rest === "mcp/.well-known/oauth-protected-resource") return json(200, resourceMetadata(b));
    if (rest === ".well-known/oauth-authorization-server" || rest === ".well-known/openid-configuration") return json(200, serverMetadata(b));
    if (rest === "register" && request.method === "POST") return register(env, request, label, secretHash);
    if (rest === "authorize" && request.method === "GET") return authorize(env, url, label, secretHash, b, device);
    if (rest === "token" && request.method === "POST") return token(env, request, label, secretHash, b);
    if (rest !== "mcp") return notFound();
    if (!["POST", "GET", "DELETE"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "POST, GET, DELETE", ...CORS } });
    const authorization = request.headers.get("Authorization") ?? "";
    const access = await open(env, authorization.replace(/^Bearer\s+/i, ""), "access");
    if (!access || access.l !== label || access.s !== secretHash || access.aud !== b.resource) {
      if (env.ALLOW_SECRET_ONLY !== "1" || authorization) {
        return json(401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${b.prm}", scope="${SCOPE}"` });
      }
    }
    const max = limit(env, "MAX_BODY");
    const body = request.method === "POST" ? await readBody(request, max) : "";
    if (body === void 0) return json(413, { error: "request body too large", max_body: max });
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return device.fetch(new Request("https://do/mcp", {
      method: "POST",
      body: JSON.stringify({ method: request.method, headers, body, secretHash }),
      signal: request.signal
    }));
  }
};
var DeviceRelay = class extends DurableObject {
  static {
    __name(this, "DeviceRelay");
  }
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.pending = /* @__PURE__ */ new Map();
    this.next = 0;
    this.minute = { start: 0, count: 0 };
    this.lease = 0;
    this.spentMs = 0;
    this.lastEnd = 0;
  }
  phone() {
    return this.ctx.getWebSockets("phone").find((ws) => ws.deserializeAttachment()?.ready);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect(url.searchParams.get("label"));
    if (url.pathname === "/knows") {
      const { secretHash } = await request.json();
      const phone = this.phone();
      if (!phone) return new Response(null, { status: 503 });
      return new Response(null, { status: phone.deserializeAttachment().access.includes(secretHash) ? 200 : 404 });
    }
    if (url.pathname === "/mcp") return this.mcp(request);
    return new Response(null, { status: 404 });
  }
  connect(label) {
    const now = Date.now();
    const waiting = this.ctx.getWebSockets("phone").filter((ws) => !ws.deserializeAttachment()?.ready);
    for (const ws of waiting) if (now - (ws.deserializeAttachment()?.at ?? 0) > 1e4 || waiting.length >= 3) ws.close(4408, "no hello");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["phone"]);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    server.serializeAttachment({ label, nonce: b64(nonce), at: now, ready: false, access: [] });
    server.send(JSON.stringify({ t: "challenge", nonce: b64(nonce) }));
    return new Response(null, { status: 101, webSocket: client });
  }
  ready(ws) {
    ws.send(JSON.stringify({ t: "ready", max_body: limit(this.env, "MAX_BODY"), req_timeout_ms: limit(this.env, "REQ_TIMEOUT_MS") }));
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > limit(this.env, "MAX_BODY") + 65536) {
      ws.close(1009, "too large");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(message);
    } catch {
      ws.close(1007, "not JSON");
      return;
    }
    const state = ws.deserializeAttachment() ?? {};
    if (!state.ready) {
      if (frame.t !== "hello" || !await this.verifyHello(state, frame)) {
        ws.close(4401, "unauthorized");
        return;
      }
      ws.serializeAttachment({ label: state.label, at: state.at, ready: true, access: frame.access });
      for (const other of this.ctx.getWebSockets("phone")) if (other !== ws) other.close(4e3, "replaced");
      this.ready(ws);
      return;
    }
    if (frame.t === "access" && validAccess(frame.access)) {
      ws.serializeAttachment({ ...state, access: frame.access });
      this.ready(ws);
    } else if (frame.t === "res" && typeof frame.id === "string") {
      const waiter = this.pending.get(frame.id);
      if (waiter?.ws === ws) waiter.resolve(frame);
    }
  }
  async verifyHello(state, frame) {
    try {
      if (frame.v !== 1 || typeof frame.key !== "string" || typeof frame.sig !== "string" || !validAccess(frame.access)) return false;
      const raw = fromB64(frame.key);
      if (raw.length !== 32 || base32(raw) !== state.label) return false;
      const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      const message = new Uint8Array([...enc.encode(`${PROOF_CONTEXT}:${state.label}:`), ...fromB64(state.nonce)]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64(frame.sig), message);
    } catch {
      return false;
    }
  }
  webSocketClose(ws) {
    for (const [id, waiter] of this.pending) if (waiter.ws === ws) waiter.resolve(void 0);
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
  // Per-label minute window and concurrency here; daily caps through the Budget object.
  async admit() {
    const now = Date.now();
    if (now - this.minute.start >= 6e4) this.minute = { start: now, count: 0 };
    if (this.minute.count >= limit(this.env, "PER_MINUTE") || this.pending.size >= limit(this.env, "CONCURRENT")) return false;
    if (this.lease <= 0) {
      const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName("global"));
      const label = this.phone()?.deserializeAttachment().label ?? "unknown";
      const spent = Math.ceil(this.spentMs / 1e3);
      this.spentMs = 0;
      this.lease = await budget.take(hex(await sha256(label)).slice(0, 16), limit(this.env, "LEASE"), limit(this.env, "LABEL_DAILY"), limit(this.env, "GLOBAL_DAILY"), spent, limit(this.env, "GLOBAL_DAILY_SECONDS"));
      if (this.lease <= 0) return false;
    }
    this.lease -= 1;
    this.minute.count += 1;
    return true;
  }
  async mcp(request) {
    const { method, headers, body, secretHash } = await request.json();
    const phone = this.phone();
    if (!phone) return rpcError("offline", body);
    if (!phone.deserializeAttachment().access.includes(secretHash)) return notFound();
    if (!await this.admit()) return rpcError("limited", body);
    const id = `r${++this.next}`;
    const started = Date.now();
    if (started - this.lastEnd > 1e4) this.spentMs += 1e4;
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => finish("timeout"), limit(this.env, "REQ_TIMEOUT_MS"));
      const finish = /* @__PURE__ */ __name((value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      }, "finish");
      this.pending.set(id, { ws: phone, resolve: finish });
      request.signal?.addEventListener?.("abort", () => {
        try {
          phone.send(JSON.stringify({ t: "cancel", id }));
        } catch {
        }
        finish("cancelled");
      });
      try {
        phone.send(JSON.stringify({ t: "req", id, method, headers, body }));
      } catch {
        finish(void 0);
      }
    });
    this.lastEnd = Date.now();
    this.spentMs += this.lastEnd - started;
    if (reply === "timeout") {
      try {
        phone.send(JSON.stringify({ t: "cancel", id }));
      } catch {
      }
      return rpcError("timeout", body);
    }
    if (reply === "cancelled") return new Response(null, { status: 499 });
    if (!reply) return rpcError("offline", body);
    const out = { ...CORS };
    for (const name of RETURNED_HEADERS) if (typeof reply.headers?.[name] === "string") out[name] = reply.headers[name];
    const status = Number.isInteger(reply.status) && reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
    return new Response(status === 204 || status === 304 ? null : String(reply.body ?? ""), { status, headers: out });
  }
};
function validAccess(access) {
  return Array.isArray(access) && access.length <= 8 && access.every((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
}
__name(validAccess, "validAccess");
var Budget = class extends DurableObject {
  static {
    __name(this, "Budget");
  }
  // Takes up to `want` requests from today's budget for one label: what was granted.
  // `spentSeconds` is the awake time the caller used since its last call.
  async take(labelKey, want, labelDaily, globalDaily, spentSeconds = 0, globalSeconds = Infinity) {
    const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    let today = await this.ctx.storage.get("today");
    if (today?.day !== day) today = { day, total: 0, seconds: 0, labels: {} };
    today.seconds = (today.seconds ?? 0) + spentSeconds;
    const used = today.labels[labelKey] ?? 0;
    const granted = today.seconds >= globalSeconds ? 0 : Math.max(0, Math.min(want, labelDaily - used, globalDaily - today.total));
    today.total += granted;
    today.labels[labelKey] = used + granted;
    if (granted > 0 || spentSeconds > 0) await this.ctx.storage.put("today", today);
    return granted;
  }
};
export {
  Budget,
  DeviceRelay,
  RPC_ERRORS,
  base32,
  index_default as default,
  open,
  seal
};
//# sourceMappingURL=index.js.map

# Deploying the Poki relay Worker

`worker.js` is the bundled Worker, one ES module built from `src/index.js` with `npm run build`. Its only import is `cloudflare:workers`. `wrangler.toml` describes the same deployment for Wrangler. This file gives the same settings for an upload through the Cloudflare API or MCP.

## What it serves

| Path | Who | What |
|---|---|---|
| `wss://pokimcp.zheha.nz/v1/<label>/connect` | the phone | relay frames v1 (docs/ios-core.md on dev/ios-core) |
| `https://pokimcp.zheha.nz/v1/<label>/<secret>/mcp` | Claude, ChatGPT | Streamable HTTP MCP (POST; GET and DELETE are passed to the phone) |
| `/.well-known/oauth-protected-resource/v1/<label>/<secret>/mcp` | MCP client | RFC 9728 metadata |
| `/.well-known/oauth-authorization-server/v1/<label>/<secret>` | MCP client | RFC 8414 metadata (also under `<base>/.well-known/...`) |
| `<base>/register`, `<base>/authorize`, `<base>/token` | MCP client | dynamic registration, authorization code + PKCE (S256), refresh |

Routing is by path on one hostname. A free zone's Universal SSL covers only one level of subdomain, so `<label>.pokimcp.zheha.nz` would need Advanced Certificate Manager.

## OAuth design

The connector URL, meaning label plus secret, is the credential. The phone makes that secret, and the Worker never stores it. claude.ai requires OAuth before it will add a remote MCP, so the Worker runs the smallest compliant authorization server for each connector URL:

- **Metadata and registration.** Both are stateless. The `client_id` is an HMAC-signed blob holding the label, `sha256(secret)`, the redirect URIs and the client name. Redirect URIs must be https on `REDIRECT_HOSTS`, or http on loopback.
- **`/authorize`.** It asks the connected phone whether `sha256(secret)` is in its `access` list. If yes, it grants at once with a 302 carrying the code. If no, it returns `access_denied`; if the phone is offline, it returns 503. Codes are signed, bound to the client, the redirect and the PKCE challenge, and expire in 60 s.
- **`/token`.** It checks PKCE and issues signed tokens bound to the label and `sha256(secret)`: access tokens last 1 h and refresh tokens 30 d. Nothing is stored.
- **Revocation.** Every MCP request also checks the token's secret hash against the phone's live `access` list. Revoking a secret on the phone therefore ends every token issued for it at once.
- **Code replay.** A code is not tracked as used, since that would need storage. A replayed code still needs the PKCE verifier.

No sign-in page is needed, because pasting the URL is the act of authorization. If the phone should approve each new client as well, that needs a v2 frame pair: `{"t":"approve","id","client_name","redirect_host"}` sent to the phone, and `{"t":"approval","id","approved"}` back. It is not in relay frames v1.

Setting `ALLOW_SECRET_ONLY=1` also accepts MCP requests with no `Authorization` header, for clients without OAuth. The default is off.

## Bindings

| Kind | Name | Value |
|---|---|---|
| Durable Object namespace | `DEVICE` | class `DeviceRelay`, SQLite-backed, one per label, holds the phone's WebSocket via the Hibernation API; it writes nothing to storage |
| Durable Object namespace | `BUDGET` | class `Budget`, SQLite-backed, a single object `global` holding today's request counters (the only storage) |
| Secret | `TOKEN_SECRET` | 32+ random characters, e.g. `openssl rand -base64 48`. Changing it signs every client out. |
| Plain text | `MAX_BODY` | `4194304` |
| Plain text | `REQ_TIMEOUT_MS` | `60000` |
| Plain text | `PER_MINUTE` | `60` (MCP requests per label per minute) |
| Plain text | `CONCURRENT` | `4` (in flight per label) |
| Plain text | `LABEL_DAILY` | `5000` (per label per UTC day) |
| Plain text | `GLOBAL_DAILY` | `8000` (all labels per UTC day) |
| Plain text | `GLOBAL_DAILY_SECONDS` | `80000` (estimated Durable Object awake seconds per UTC day) |
| Plain text | `REDIRECT_HOSTS` | `claude.ai,claude.com,chatgpt.com,chat.openai.com,localhost,127.0.0.1` |

**Migration:** tag `v1`, `new_sqlite_classes = ["DeviceRelay", "Budget"]`.
**Compatibility date:** `2025-10-01`.
**Observability:** off. Do not enable Logpush, Tail Workers or Workers Logs for this script.

Script upload metadata for the API (`PUT /accounts/{account}/workers/scripts/poki-relay`, multipart, with `worker.js` as part `index.js`):

```json
{
  "main_module": "index.js",
  "compatibility_date": "2025-10-01",
  "bindings": [
    {"type": "durable_object_namespace", "name": "DEVICE", "class_name": "DeviceRelay"},
    {"type": "durable_object_namespace", "name": "BUDGET", "class_name": "Budget"},
    {"type": "secret_text", "name": "TOKEN_SECRET", "text": "<32+ random characters>"},
    {"type": "plain_text", "name": "MAX_BODY", "text": "4194304"},
    {"type": "plain_text", "name": "REQ_TIMEOUT_MS", "text": "60000"},
    {"type": "plain_text", "name": "PER_MINUTE", "text": "60"},
    {"type": "plain_text", "name": "CONCURRENT", "text": "4"},
    {"type": "plain_text", "name": "LABEL_DAILY", "text": "5000"},
    {"type": "plain_text", "name": "GLOBAL_DAILY", "text": "8000"},
    {"type": "plain_text", "name": "GLOBAL_DAILY_SECONDS", "text": "80000"},
    {"type": "plain_text", "name": "REDIRECT_HOSTS", "text": "claude.ai,claude.com,chatgpt.com,chat.openai.com,localhost,127.0.0.1"}
  ],
  "migrations": {"new_tag": "v1", "new_sqlite_classes": ["DeviceRelay", "Budget"]},
  "observability": {"enabled": false}
}
```

## Hostname

`pokimcp.zheha.nz` is currently the Cloudflare Tunnel hostname of the existing daemon. A Workers Custom Domain cannot share a hostname with an existing DNS record, so there are two ways to switch:

- **Test first (recommended).** Attach a Custom Domain such as `relay.zheha.nz`, and run the phone and claude.ai against it. Once that works, remove the tunnel's `pokimcp` DNS record and attach `pokimcp.zheha.nz` to the Worker. The old daemon's kill switch stays `poki-cloudflared`.
- **Or** add a route `pokimcp.zheha.nz/v1/*` on the zone. That routes only `/v1/` paths to the Worker and leaves the tunnel serving everything else during the move. A route needs the proxied DNS record to exist, and the tunnel's record does.

## Cost model (Workers Paid)

These are the included amounts per month, from [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/):
- Workers: 10M requests
- Durable Objects: 1M requests, where incoming WebSocket messages count 20:1
- Durable Objects duration: 400,000 GB-s, billed only while the object is active and not eligible to hibernate; outgoing WebSocket messages are free
- SQLite storage writes: 50M

**One phone at 2,000 tool calls a day (60,000 a month).** Each call is one Worker request, one DO request (the `fetch` into `DeviceRelay`) and one incoming `res` message. Every 25 calls add one `Budget` lease.

| Item | Per month | Share of included |
|---|---|---|
| Worker requests: 60k calls + about 1k OAuth refreshes and metadata | ~61k | 0.6% of 10M |
| DO requests: 60k fetches + 3k `res` messages (60k ÷ 20) + 2.4k leases | ~65k | 6.5% of 1M |
| Keepalive: the phone's text `ping` every 25 s, 104k messages a month, counted conservatively at 20:1 | ~5.2k | 0.5% |
| DO duration: about 2 s awake per call (phone time) at 128 MB | ~15k GB-s | 3.8% of 400k |
| DO duration, worst case: every call isolated, plus 10 s before hibernation | ~90k GB-s | 22% |
| Storage writes: one `Budget` write per 25 calls | ~2.4k | ~0% |

**The caps hold the whole account inside the included amounts:**
- `GLOBAL_DAILY = 8000` allows at most 240k calls a month. That is about 262k DO requests plus keepalives, under 1M.
- `GLOBAL_DAILY_SECONDS = 80000` caps estimated awake time at 10k GB-s a day, which is 300k GB-s a month, under 400k. The estimate is each request's wall time, plus 10 s whenever the object was idle more than 10 s.
- Device objects report usage when they take a new lease, so at most one lease (25 requests × 60 s) per phone can go unreported.
- Once a cap is hit, MCP requests get 429 (JSON-RPC -32003) until 00:00 UTC.
- A request never keeps an object awake longer than `REQ_TIMEOUT_MS`. There are no alarms and no polling.

**What the Worker cannot cap itself:** unauthenticated requests from the internet. Each one is a Worker request, but it is answered with 401 or 404 without touching a Durable Object, and the zone has 10M a month included. Add the free plan's one WAF rate-limiting rule as well, for example 100 requests per 10 s per IP on `/v1/`.

## Test locally

```sh
cd deploy/cf-relay
npm install --legacy-peer-deps   # the vitest peer graph needs it with npm 10
npm test                         # vitest + @cloudflare/vitest-plugin (Miniflare/workerd)
npm run build                    # wrangler deploy --dry-run; writes dist/ and worker.js
```

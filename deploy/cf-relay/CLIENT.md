# The phone's side of the relay

This is how the Poki app talks to the relay Worker. The normative spec is relay frames v1 in `docs/ios-core.md` on dev/ios-core; this guide is the practical version. `test/phone-sim.mjs` is a working reference in about 150 lines.

## 1. Identity and connector secrets (made once, on the phone)

- **Identity key.** An Ed25519 key pair; the private key stays in the keychain. `label` = RFC 4648 base32 of the raw 32-byte public key, lowercase, no padding: 52 characters of `a-z2-7`.
- **Connector secrets.** One per MCP client: 32 random bytes as base64url without padding, 43 characters. The phone shows the user the connector URL `https://pokimcp.zheha.nz/v1/<label>/<secret>/mcp` and keeps the secret. The relay only ever receives `sha256(secret)` as hex.

## 2. Connect

Open `wss://pokimcp.zheha.nz/v1/<label>/connect`.

1. The relay sends `{"t":"challenge","nonce":"<base64>"}`.
2. Sign the bytes `poki-relay-v1:<label>:` followed by the decoded nonce, and send:
   `{"t":"hello","v":1,"key":"<base64 raw public key>","sig":"<base64>","access":["<sha256 hex>",...],"app":"<version>"}`
   `access` holds at most 8 hashes, one per secret that is not revoked.
3. The relay answers `{"t":"ready","max_body":4194304,"req_timeout_ms":60000}`. Use these numbers rather than assuming them.

Close codes:
- `4401`: the key does not match the label, or the signature is wrong.
- `4000`: a newer connection for this label took over.
- `4408`: the hello was not sent within 10 s.
- `1009`: a frame was too large.

**Keepalive.** Send the bare text `ping` every 25 s; the relay answers `pong` without waking anything. If no `pong` arrives for 60 s, reconnect with backoff of 1, 2, 4 … 30 s plus jitter.

**Secrets changed.** When a secret is added or revoked, send `{"t":"access","access":[...]}` on the live connection; the relay answers `ready` again. Revoking a secret takes effect immediately: every OAuth token issued for it stops working on the next request.

## 3. Answer requests

Each MCP HTTP request arrives as:

```json
{"t":"req","id":"r12","method":"POST","headers":{"content-type":"application/json","accept":"application/json, text/event-stream","mcp-protocol-version":"2025-06-18","mcp-session-id":"..."},"body":"<UTF-8>"}
```

Answer each one exactly once:

```json
{"t":"res","id":"r12","status":200,"headers":{"content-type":"application/json","mcp-session-id":"..."},"body":"<UTF-8>"}
```

- **What comes through.** Only `content-type`, `mcp-session-id` and `mcp-protocol-version` from your headers reach the client. `body` is a string; MCP JSON is text, and screenshots go base64 inside it. Keep a response at or under `max_body` bytes.
- **Status codes.** Answer `GET` with 405 (no SSE), `DELETE` with 200 after ending the session, and a JSON-RPC notification with 202 and an empty body.
- **Cancel.** `{"t":"cancel","id":"r12"}` means the client gave up, or the relay timed out at `req_timeout_ms`. Stop the work and do not send a `res` for it.
- **Limits.** The relay allows up to 4 requests in flight and 60 per minute per label. Past that, the client gets 429 from the relay and nothing reaches the phone.

## 4. The user's side

1. In Poki, the user taps **Add connector** and copies the URL.
2. In claude.ai: Settings → Connectors → Add custom connector, paste the URL, Connect. ChatGPT works the same way in developer mode.
3. The client runs OAuth on its own: it discovers the metadata, registers itself and opens the authorize page. The relay asks the connected phone whether it knows this secret and grants at once. There is no password and no page to click through, because the URL itself is the credential. The phone must be online, otherwise the page says so.
4. The client now calls tools, and each call arrives at the phone as a `req`. To disconnect a client, the user revokes its secret in Poki.

Approving each new client on the phone, with a prompt that names the client, would need a v2 frame pair. DEPLOY.md has the proposal.

## Trying it without a phone

```sh
node test/phone-sim.mjs https://pokimcp.zheha.nz           # acts as a phone; prints the connector URL
node test/phone-sim.mjs https://pokimcp.zheha.nz --check   # also runs OAuth + initialize + tools/call; exit 0 = OK
```

The simulator keeps its key and secret in `./phone-sim.json`, or the file named by `PHONE_SIM_STATE`, so its URL stays the same between runs. It needs Node 22 or later. Locally, run it against `wrangler dev` with `TOKEN_SECRET` set in `.dev.vars`: `node test/phone-sim.mjs http://127.0.0.1:8787 --check`.

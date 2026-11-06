# What the Poki relay can see

The relay is a Cloudflare Worker between an MCP client (Claude, ChatGPT) and the Poki app on your phone. It is not end-to-end encrypted. TLS from the MCP client ends at Cloudflare, and the phone's WebSocket also ends there. So the Worker handles your MCP traffic in plaintext, in memory, while it passes it on: tool calls, their arguments, and their results, which include screenshots and text from your screen.

## What it keeps

- **Nothing about your traffic.** Requests and responses exist only in memory for as long as a call is in flight. There is no KV, no D1, no R2, no Durable Object storage of requests or responses, no logging, no analytics, and observability is turned off.
- **While the phone is connected.** The phone's object holds the phone's label (derived from its public key) and the SHA-256 hashes of its connector secrets, in the WebSocket's memory attachment. When the phone disconnects, they are gone.
- **The only storage** is one counter object: today's number of requests in total and per label, keyed by a hash of the label, plus an estimate of awake time. It exists to enforce the cost caps, and is replaced each day.
- **Tokens.** OAuth client ids, codes and tokens are signed by the Worker and not stored. Each one carries the label, the hash of the connector secret it was issued for, and an expiry.

## What it can see while working

- The full content of every MCP request and response, in memory, as it passes through.
- The connector secret in the URL path, which it hashes before comparing and never stores. Your phone's label, too.
- The MCP client's IP address and request headers. Only `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version` and `last-event-id` are forwarded to the phone; `Authorization`, cookies and the client IP are not.

## What Cloudflare can see

Cloudflare runs the Worker, so the same plaintext passes through Cloudflare's machines. Cloudflare's own edge systems may record request metadata such as time, path and IP for security and billing. The path includes the label and the connector secret. If that matters to you, revoke the secret on the phone at any time; every token for it stops working at once.

## Keeping the keys

The phone's identity key and the connector secrets are made on the phone and stay there. The private key lives in the keychain, and the secrets appear only in the connector URL you paste into your MCP client. The Worker's `TOKEN_SECRET` signs OAuth tokens. Whoever controls the Cloudflare account can change the Worker, and so could read the traffic it handles.

# Proposal: phone-side approval of new clients (relay frames v2)

Status: proposal only. Nothing here is implemented. Relay frames v1 (docs/ios-core.md on dev/ios-core) stay as they are.

## Why

In v1, the connector URL is the credential. Anyone who has the URL can run OAuth and call tools while the phone is online. v2 lets the phone ask the user once per new client, in the Live Activity, before any token is issued. "Client" here means claude.ai, ChatGPT, or anything else that registers. Automation must never answer this prompt. That matches the owner's rule that UI automation may not tap the Live Activity.

## Frames

The phone opts in through its hello, so v1 phones keep working unchanged:

```json
{"t":"hello","v":2,"approve":true, ...v1 fields...}
```

During `/authorize`, after the secret has been checked against the access list, the relay sends:

```json
{"t":"approve","id":"a7","client_name":"Claude","redirect_host":"claude.ai","secret":"<sha256 hex of the secret>","client":"<client_id fingerprint, 16 hex>"}
```

The phone answers once:

```json
{"t":"approval","id":"a7","approved":true,"remember":true}
```

- `client_name` comes from dynamic client registration and is untrusted text. The phone shows it next to `redirect_host`, which the relay has already checked against `REDIRECT_HOSTS`, and treats the host as the real identity.
- `remember: true` means the phone records the client fingerprint for that secret and answers later requests from the same client without asking. It also adds the fingerprint to the next `access` frame, as `clients: {"<secret hash>": ["<fp>", ...]}`. The relay then checks the fingerprint on every MCP request, as it already does for secret hashes. Revoking a client is then a phone-side edit, the same as revoking a secret.
- Timeout: the relay holds the authorize request for up to 90 s. On timeout, a deny, or the phone disconnecting, the relay redirects with `error=access_denied`. A pending approval counts toward `CONCURRENT`.
- The relay sends at most 3 open `approve` frames per label, and at most 10 a minute. Past that, the answer is `access_denied` without asking, so an outsider cannot flood the phone with prompts.

## Relay changes

- `DeviceRelay.authorize` waits for an `approval` frame, using the same pending map as `req` and `res`.
- `seal()` adds the client fingerprint to codes and tokens. `mcp()` checks it against the live `clients` list when the phone said `approve: true`.
- Nothing new is stored. The approved-client list lives on the phone and arrives in `hello` and `access`, the same as secrets. The relay stays zero-knowledge across restarts.

## Phone changes

- A Live Activity prompt: "Claude (claude.ai) wants to use this iPhone", with Allow and Deny buttons.
- While a prompt is showing, the runner refuses any `act` that targets the Live Activity or the Dynamic Island.

## Cost

One extra WebSocket round trip per new client, and nothing per tool call.

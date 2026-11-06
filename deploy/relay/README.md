# Blind relay

The relay lets a public client reach a Poki helper that has no public address, without the relay ever holding the helper's keys or seeing what passes between them. The user keeps the keys. There is no VPN on the phone.

```
client ──TLS (end to end)──▶ relay :443 ──raw bytes──▶ helper (dialed out to relay :8443)
                             reads SNI only            terminates TLS with its own key
```

## How it works

- **Public side, `:443`.** The relay reads the ClientHello until it finds the `server_name`, and does not terminate TLS. It looks up the helper registered for that hostname. If there is one, it pipes the raw bytes both ways, starting with the ClientHello it read. If the hostname is unknown, missing, or the bytes are not TLS, the connection is closed.
- **Helper side, `:8443`.** The helper dials out with TLS. This hop uses the relay's own certificate, which only protects the control messages; the public stream inside it is still the client's end-to-end TLS. Control messages are JSON lines:
  1. helper → `{"t":"hello","key":"<base64 raw Ed25519 public key>"}`
  2. relay → `{"t":"challenge","nonce":"<base64 32 bytes>"}`
  3. helper → `{"t":"proof","sig":"<base64 Ed25519 signature>"}`. The signature covers `poki-relay-v1:<label>:` followed by the nonce bytes.
  4. relay → `{"t":"ready","hostname":"<label>.<RELAY_DOMAIN>"}`
- **Hostnames.** `<label>` is the RFC 4648 base32 of the raw public key: lowercase, no padding, 52 characters, so it fits a DNS label. Nobody can register a hostname without the private key behind it. A second registration with the same key replaces the first.
- **Streams.** One public connection is one helper connection. The relay sends `{"t":"open","id":"<random 128-bit id>"}` on the control connection. The helper dials `:8443` again and sends `{"t":"stream","id":...}`, then the relay pipes. The id only ever travels inside the control TLS, and an unclaimed id expires after 10 s.
- **ACME TLS-ALPN-01** needs nothing special. The validation connection is just another TLS stream with ALPN `acme-tls/1`, and the helper answers it. HTTP-01 is not supported, because the relay only routes TLS.
- **Logging.** Payloads are never logged. Counters are logged every 60 s: connections, unknown hostnames, streams, bytes each way, helpers, auth failures.

## What the relay can and cannot see

It sees the client IP, the hostname in the SNI, connection times and byte counts. It cannot see the content: it has no key for any helper hostname, and the test checks that a plaintext marker never appears in the relayed bytes. Encrypted ClientHello would hide the hostname too, but only if the relay could decrypt the outer hello, which it deliberately cannot. ECH is therefore out of scope.

## Run

```sh
# The relay's own certificate for the helper side (any CA the helpers trust, or self-signed and
# pinned in the helper with `ca`).
docker build -t poki-relay deploy/relay
docker run -d --name poki-relay -p 443:443 -p 8443:8443 \
  -e RELAY_DOMAIN=relay.example.com \
  -v /etc/poki-relay:/certs:ro poki-relay
```

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_DOMAIN` | `relay.invalid` | Helpers get `<label>.<RELAY_DOMAIN>`. Point a wildcard DNS record `*.RELAY_DOMAIN` at the relay. |
| `RELAY_HELPER_KEY`, `RELAY_HELPER_CERT` | `/certs/helper-side.key`, `.crt` | The relay's certificate for `:8443`. |
| `RELAY_PUBLIC_PORT`, `RELAY_HELPER_PORT` | `443`, `8443` | Listen ports. |
| `RELAY_HOST` | `0.0.0.0` | Listen address. |

The image runs as `node`. Docker lets containers bind ports below 1024 by default (`ip_unprivileged_port_start=0`).

## Helper

`helper.js` is the reference client. It calls `connectHelper({relayHost, relayPort, tls: {ca}, publicKey, privateKey, onStream})`, and `onStream(socket)` gets each relayed connection as raw TLS. Hand it to your own TLS server with `server.emit('connection', socket)`. The server holds the certificate for the hostname, for example one obtained by TLS-ALPN-01 through the relay. Use `generateIdentity()` to make the key pair, and keep the private key with the user.

## Test

```sh
cd deploy/relay && npm test   # node --test; needs openssl for throwaway certificates
```

The test runs the relay, a fake helper and a fake client in one process. It checks:
- 1 MB passes through unmodified, and 8 parallel streams stay apart
- a plaintext marker never appears in the bytes the relay handled
- the relay's state holds no helper key
- ALPN `acme-tls/1` passes through
- unknown hostnames are closed, and a hostname claim signed with another key is refused
- the SNI parser handles a real ClientHello

## The daemon's side

The daemon has its own relay client in `src/relay-client.mjs`, fork-only. It does nothing unless `POKI_RELAY_URL` is set.

| Variable | Meaning |
|---|---|
| `POKI_RELAY_URL` | The relay's helper side, `host:port` (port defaults to 8443). |
| `POKI_RELAY_DOMAIN` | The relay's domain, if it is not the relay host. |
| `POKI_RELAY_CA` | A PEM file to trust for the relay's own certificate, if it is not publicly trusted. |
| `POKI_ACME_DIRECTORY` | Defaults to Let's Encrypt staging. Set `https://acme-v02.api.letsencrypt.org/directory` for real certificates. |
| `POKI_ACME_EMAIL` | An optional ACME contact. |
| `POKI_MCP_PUBLIC_URL` | Leave it unset; it is set to `https://<label>.<domain>`. If you do set it, it must be exactly that. |
| `POKI_OAUTH` | Still required. Use `builtin` (password + TOTP on the daemon) in front of `/mcp`. |

On first run the daemon creates `<stateDir>/relay/identity.key`, an Ed25519 key with mode 0600 that never leaves the machine. Its hostname follows from that key, and the daemon prints it at startup as `{"event":"relay","public_url":...}`.

Each relayed stream ends its TLS in the daemon, and requests go to the same HTTP handler as local ones. The front door treats them as remote, because their peer is not loopback. Until ACME has issued a certificate, the daemon serves a self-signed one, so registration can be tested.

ACME answers TLS-ALPN-01 through the relay: a ClientHello with ALPN `acme-tls/1` gets the RFC 8737 challenge certificate. The issued certificate and its key are written to `<stateDir>/relay/cert.pem` and `key.pem`, and the account key to `acme-account.key`, all mode 0600. The certificate is renewed when fewer than 30 days remain; the daemon checks every 12 h and retries hourly on failure. If the relay is unreachable, the daemon still starts and keeps reconnecting with backoff of up to 60 s.

Tests: `node --test test/relay-client.test.mjs` runs the in-process relay with a fake ACME server that checks every JWS and validates TLS-ALPN-01 through the relay. It also starts the real daemon behind the relay and checks that OAuth guards `/mcp` at the relay hostname.

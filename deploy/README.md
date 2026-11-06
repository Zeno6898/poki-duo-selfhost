# Running Poki MCP as a remote service

This folder runs the Poki daemon on a Linux server around the clock, so that MCP clients
anywhere (claude.ai, Claude Code on the web or in a terminal, other agents) can drive the phone.
The phone is a personal device, so the public endpoint accepts **only OAuth-authenticated
requests**: OAuth 2.1 access tokens, or a verified Cloudflare Access identity when Access is the
authorization server.
The bearer token in `mcp.json` still works, but only for clients on the server itself.

```
MCP client ──HTTPS──▶ Tailscale Funnel or Cloudflare Tunnel ──HTTP──▶ 127.0.0.1:47825  poki daemon ──tailnet──▶ iPhone
                      (TLS, public hostname)                          (OAuth resource server,
                                                                       optional built-in sign-in)
```

Nothing here changes the daemon when its variables are unset: it listens on 127.0.0.1 with a new
random token on every start, as on macOS.

## 1. Settings

Put these in `deploy/poki.env` (start from `poki.env.example`; the file is git-ignored).

| Variable | Default | Meaning |
| --- | --- | --- |
| `POKI_MCP_PUBLIC_URL` | unset | HTTPS origin the front serves, e.g. `https://poki.example.ts.net`. Clients connect to `<origin>/mcp`. Setting it turns on remote access and requires `POKI_OAUTH`. |
| `POKI_OAUTH` | unset | `cloudflare-access` (Cloudflare Access signs you in; recommended with Cloudflare), `builtin` (this daemon signs you in; no Cloudflare needed) or `external` (another authorization server issues JWT access tokens). |
| `POKI_CF_ACCESS_TEAM` / `POKI_CF_ACCESS_AUD` | unset | For `cloudflare-access`: the team name in `https://<team>.cloudflareaccess.com` and the Access application's AUD tag. |
| `POKI_OAUTH_ALLOWED_SUBJECTS` | unset | For `cloudflare-access` and `external`: the email (or `sub`) of the one account allowed to use the phone, comma-separated. |
| `POKI_MCP_BIND` | `127.0.0.1` | Listen address. A non-loopback address is refused unless remote access with OAuth is configured. Keep loopback behind a front on the same host. |
| `POKI_MCP_TOKEN` / `POKI_MCP_TOKEN_FILE` | random per start | Stable bearer token for clients on this machine (32+ characters, `openssl rand -hex 32`). Never accepted on the public hostname or through a proxy. |
| `POKI_MCP_ALLOWED_HOSTS` | none | Extra `Host` names to answer, comma-separated. The public hostname and localhost are always allowed. |
| `POKI_MCP_ALLOWED_ORIGINS` | none | Extra browser origins (hostnames) allowed on `/mcp`, e.g. an MCP inspector. Requests without `Origin` (server-side clients) are unaffected. |
| `POKI_OAUTH_REDIRECT_HOSTS` | `claude.ai,claude.com,localhost,127.0.0.1,[::1]` | Redirect hosts that client registration accepts. `*.example.com` matches subdomains. |
| `POKI_OAUTH_ACCOUNT_FILE` | `$POKI_MCP_STATE_DIR/oauth/account.json` | The one account for `builtin`. |
| `POKI_OAUTH_ACCESS_TTL` / `POKI_OAUTH_REFRESH_TTL` | `3600` / `2592000` | Token lifetimes in seconds. |
| `POKI_INPUT_LOCK` | unset | `1` lets several agents share the daemon: reads run side by side, input is serialized per device. |
| `POKI_INPUT_LOCK_WAIT_MS` | `30000` | How long input waits for another session's input before failing with the holder named. |
| `POKI_MAX_CONCURRENT_READS` | `4` | Cap on read-only calls in flight (each opens a bridge tunnel). |

Only one daemon may drive a phone. The input lock lives in the process, so two daemons on one
phone are not supported.

## 2. Create the sign-in account (`POKI_OAUTH=builtin`)

Run this in your own terminal on the server, never through an agent: it prints the TOTP secret.

```sh
# Docker
docker compose -f deploy/compose.yaml run --rm poki-mcp node bin/poki-oauth-account.mjs create owner
# Checkout
POKI_MCP_STATE_DIR=/var/lib/poki node bin/poki-oauth-account.mjs create owner
```

It asks for a password (12+ characters), shows an `otpauth://` URI and key for your
authenticator app, and checks one code before saving `oauth/account.json` with mode 0600.
`password` changes the password, `list` shows registered clients, and `revoke [client_id]` ends
grants; restart the daemon after any of them.

What the built-in server does:

- Authorization code flow with PKCE (S256 only), RFC 8707 `resource` checks, and the `iss`
  response parameter.
- Dynamic client registration, limited to `POKI_OAUTH_REDIRECT_HOSTS`. The sign-in page names
  the client and the host it will return to.
- Sign-in needs the account name, the password and a TOTP code that has not been used before.
  Five failures within 15 minutes lock sign-in for 15 minutes (for everyone: someone who
  finds the URL can delay your sign-in, but cannot get in).
- Access tokens are Ed25519 JWTs for `<origin>/mcp`, valid one hour. Refresh tokens rotate on
  every use; reusing an old one revokes the grant and its access tokens.
- Each grant is its own device session, so two agents keep separate selections and leases.
- Keys, clients and hashed refresh tokens live in `$POKI_MCP_STATE_DIR/oauth/` (mode 0600).

## 3. Put HTTPS in front

The daemon speaks plain HTTP on 127.0.0.1; the front terminates TLS. Both options below run on
the same host and keep the `Host` header (or send `X-Forwarded-Host`), which the daemon checks
against `POKI_MCP_PUBLIC_URL`.

### Tailscale Funnel

1. In the tailnet admin console, enable HTTPS certificates and allow Funnel for this node in the
   policy file (`nodeAttrs` with `funnel`).
2. On the server:

   ```sh
   tailscale funnel --bg 47825
   tailscale funnel status        # shows https://<node>.<tailnet>.ts.net (Funnel on)
   ```

   If tailscaled runs in a container with host networking, run the same command through
   `docker exec <container> tailscale ...` (add `--socket=...` if it uses a custom socket path).
3. Set `POKI_MCP_PUBLIC_URL=https://<node>.<tailnet>.ts.net`.

Funnel serves on ports 443, 8443 and 10000 only. Plain `tailscale serve` (tailnet only) also
works if every client is on your tailnet; cloud agents are not, so they need Funnel.

### Cloudflare Tunnel with Cloudflare Access (recommended with Cloudflare)

Here Cloudflare Access is the OAuth authorization server for MCP clients, and the daemon only
checks the identity Access hands it. Access issues its own tokens to the client; cloudflared then
forwards each request with a `Cf-Access-Jwt-Assertion` header, an RS256 JWT signed by your team.

1. `cloudflared tunnel create poki`, then route a hostname: `cloudflared tunnel route dns poki poki.example.com`.
2. In Zero Trust → Access → Applications, add a **self-hosted** application for that hostname,
   turn on its managed OAuth for MCP clients, and give it a policy that allows only your email.
   Copy the application's **AUD tag**. (Check the current dashboard wording; Cloudflare renames
   these settings from time to time.)
3. In the tunnel's config, make the origin refuse anything Access did not sign:

   ```yaml
   ingress:
     - hostname: poki.example.com
       service: http://127.0.0.1:47825
       originRequest:
         access:
           required: true
           teamName: <team>
           audTag: [<AUD tag>]
     - service: http_status:404
   ```

4. In `poki.env`:

   ```sh
   POKI_MCP_PUBLIC_URL=https://poki.example.com
   POKI_OAUTH=cloudflare-access
   POKI_CF_ACCESS_TEAM=<team>
   POKI_CF_ACCESS_AUD=<AUD tag>
   POKI_OAUTH_ALLOWED_SUBJECTS=you@example.com
   POKI_MCP_BIND=127.0.0.1
   ```

The daemon then accepts a request on the public hostname only when it comes from a loopback peer
(cloudflared on this host) and its assertion verifies: signature against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached, refetched for a new key),
issuer, AUD tag, expiry, and an allowed email. No `Authorization` header is needed. Each email
is one device session. The mode refuses to start with a non-loopback `POKI_MCP_BIND`, and the
daemon serves no OAuth endpoints of its own.

### Cloudflare Tunnel without Access (`builtin`)

Use the same tunnel without the `originRequest.access` block and without an Access application,
and set `POKI_OAUTH=builtin`. Do not put an Access login page in front of the hostname in this
mode: MCP clients must reach `/.well-known/*`, `/register`, `/authorize` and `/token` directly.

`external` (below) is for authorization servers that issue JWT access tokens to the client. It
does not work with Access's managed OAuth, whose client tokens are opaque; use
`cloudflare-access` for that.

### External authorization server (`POKI_OAUTH=external`)

The daemon then acts only as a resource server. It publishes the issuer in its protected
resource metadata and accepts that issuer's JWT access tokens.

| Variable | Meaning |
| --- | --- |
| `POKI_OAUTH_ISSUER` | Issuer URL (https). Must equal the tokens' `iss`. |
| `POKI_OAUTH_JWKS_URL` | Optional; otherwise discovered from the issuer's metadata. |
| `POKI_OAUTH_AUDIENCE` | Expected `aud`; defaults to `<origin>/mcp`. |
| `POKI_OAUTH_ALLOWED_SUBJECTS` | Required. Comma-separated `sub` or `email` values allowed to use the phone. |
| `POKI_OAUTH_REQUIRED_SCOPES` | Optional scopes every token must carry. |

Check against your provider that it supports dynamic client registration (or pre-register the
client) and issues JWT access tokens with the audience above.

## 4. Start it

Docker (the image builds idevice-tools at the pinned revision and the bridge):

```sh
cp deploy/poki.env.example deploy/poki.env && $EDITOR deploy/poki.env
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs -f   # look for "event":"ready" with public_url
```

Pairing files go in `deploy/pairing/` (or `POKI_PAIRING_DIR`) and are mounted read-only at
`/pairing`. They, `deploy/state/` and `deploy/poki.env` are git-ignored; never commit them.

Without Docker, install Node 24, Python 3 and ffmpeg, build the native tools as in `bin/setup`'s
header, then install `deploy/poki-mcp.service` as its header describes.

Check the public endpoint. With `builtin` or `external`, `curl -i -X POST https://<host>/mcp`
must answer `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` header, and
`curl https://<host>/.well-known/oauth-protected-resource/mcp` must name your issuer. With
`cloudflare-access`, the same `curl` must be stopped by Access before it reaches the daemon. A `403
Local access is only for clients on this machine` means the front rewrote `Host` to localhost;
make it pass the public hostname.

## 5. Connect clients

- **claude.ai**: Settings → Connectors → Add custom connector, URL `https://<host>/mcp`. Sign in
  on the page that opens (Cloudflare Access, or Poki's own page with `builtin`; its default
  redirect list includes `claude.ai`).
- **Claude Code**: `claude mcp add --transport http poki https://<host>/mcp`, then `/mcp` to sign
  in. It uses a localhost callback, which the default list allows.
- **On the server itself**: `node src/stdio.mjs` (or `bin/poki-mcp`) keeps using `mcp.json`.

To cut off every client at once: `node bin/poki-oauth-account.mjs revoke`, then restart, or
simply stop the service.

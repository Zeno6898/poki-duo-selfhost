# Running the Poki relay Worker

The Worker is `poki-relay` on the zheha.nz account. It is live at `pokimcp.zheha.nz` on zone routes `/v1/*` and `/.well-known/*`, with `ORIGIN_FALLBACK=1`. Path-scoped Cloudflare Access apps bypass `/v1` and `/.well-known`, and the old "Poki MCP" Access app still covers the rest of the host. DEPLOY.md explains the design. This file covers day-to-day changes.

Every command below needs an API token with Workers Scripts:Edit on the account, or `wrangler login`. Set `ACCOUNT=0b33d8900e842c048562a4b70d9ecee4` and `TOKEN=<your API token>`.

## Stop it now

Pick the step that matches how hard you need to stop it:

1. **Refuse all MCP traffic and keep phones connected.** Set `GLOBAL_DAILY=0`, as described under [Lower a cap](#lower-a-cap). Every MCP request then gets 429 and never reaches the phone. Requests still cost one Worker request, plus about one DO request each, until the lease runs out.
2. **Take the Worker off the hostname.** Delete the four `poki-relay` routes: Websites → zheha.nz → Workers Routes, or `DELETE /zones/<zone>/workers/routes/<id>`. Traffic goes back to the tunnel, and Access answers it.
3. **Remove it completely.** `wrangler delete poki-relay`. This also deletes both Durable Object namespaces and the daily counters in them.

## Lower a cap

The caps are plain-text variables. Lowering one takes effect on the next request and needs no code change.

| Variable | Default | What it limits |
|---|---|---|
| `PER_MINUTE` | 60 | MCP requests per phone per minute |
| `CONCURRENT` | 4 | requests in flight per phone |
| `LABEL_DAILY` | 5000 | MCP requests per phone per UTC day |
| `GLOBAL_DAILY` | 8000 | MCP requests for all phones per UTC day |
| `GLOBAL_DAILY_SECONDS` | 80000 | estimated Durable Object awake seconds per UTC day |
| `MAX_BODY` | 4194304 | bytes per request or response |

You can change a cap in three ways:

- **Dashboard.** Workers & Pages → poki-relay → Settings → Variables and Secrets. Edit the value and click Deploy.
- **Wrangler.** Edit `[vars]` in `wrangler.toml`, then run `npx wrangler deploy`. Secrets are kept.
- **API.** A settings PATCH replaces the whole binding list, so list every binding. Use `inherit` to keep the secret and both Durable Object namespaces:

```sh
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/poki-relay/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'settings={"bindings":[
    {"type":"inherit","name":"TOKEN_SECRET"},{"type":"inherit","name":"DEVICE"},{"type":"inherit","name":"BUDGET"},
    {"type":"plain_text","name":"GLOBAL_DAILY","text":"2000"},
    {"type":"inherit","name":"PER_MINUTE"},{"type":"inherit","name":"CONCURRENT"},{"type":"inherit","name":"LABEL_DAILY"},
    {"type":"inherit","name":"GLOBAL_DAILY_SECONDS"},{"type":"inherit","name":"MAX_BODY"},{"type":"inherit","name":"REQ_TIMEOUT_MS"},
    {"type":"inherit","name":"REDIRECT_HOSTS"},{"type":"inherit","name":"ORIGIN_FALLBACK"}]};type=application/json'
```

Raise a cap only after you redo the cost model in DEPLOY.md. **The Workers Paid allowance is shared across the whole account.** The account also runs `console-neo-relay`, `nanophoto` and `seatwatch-coord`, which together used about 8k Durable Object requests in 6 hours on Nov 6. The relay's caps assume it has most of the 1M requests and 400k GB-s included each month. Check the account total with the queries below before raising anything.

## Rotate TOKEN_SECRET

```sh
openssl rand -base64 48 | npx wrangler secret put TOKEN_SECRET
```

Or call the API: `PUT /accounts/$ACCOUNT/workers/scripts/poki-relay/secrets` with `{"name":"TOKEN_SECRET","text":"…","type":"secret_text"}`.

Rotating invalidates every OAuth artifact at once: client ids, codes, access tokens and refresh tokens. That is because they are all HMAC-sealed with this secret, and nothing about them is stored. Connector URLs and phone keys are not affected.

Clients then have to sign in again. claude.ai usually shows the connector as needing to reconnect, and the user clicks Connect. That succeeds at once while the phone is online.

Rotate when you suspect a leak, or on a schedule if you want one. There is no reason to rotate often.

## Read usage without logs

Observability is off, and the Worker logs nothing. Usage comes from GraphQL Analytics, which holds counts only and no request contents. Send this to `POST https://api.cloudflare.com/client/v4/graphql` with your token:

```graphql
query ($a: String!, $s: Time!, $u: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    worker: workersInvocationsAdaptive(limit: 20, filter: { scriptName: "poki-relay", datetime_geq: $s, datetime_leq: $u }) {
      sum { requests errors subrequests } dimensions { status }
    }
    doRequests: durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: { datetime_geq: $s, datetime_leq: $u }) {
      sum { requests } dimensions { namespaceId }
    }
    doTime: durableObjectsPeriodicGroups(limit: 20, filter: { datetime_geq: $s, datetime_leq: $u }) {
      sum { activeTime cpuTime inboundWebsocketMsgCount outboundWebsocketMsgCount } dimensions { namespaceId }
    }
  } }
}
```

Set the variables to `{"a":"<account>","s":"<ISO start>","u":"<ISO end>"}`. This query was checked against the live schema on Nov 6, 2026.

The relay's namespaces are `poki-relay_DeviceRelay` (`ed9e180c5df4453c898b191550e32d39`) and `poki-relay_Budget` (`2f4da2e971e44bb4b339cfa80921adab`). To read the totals against the Paid allowance:

- **DO requests.** Sum `doRequests.requests` over every namespace on the account, plus `inboundWebsocketMsgCount / 20`. Compare the total with 1M per month.
- **Duration.** `activeTime` is in microseconds. GB-s is roughly `activeTime / 1e6 × 0.128`. Compare it with 400k per month. A hibernated WebSocket is not billed for duration, so a large `activeTime` while no one is calling tools means something is keeping an object awake.
- **Worker requests.** `worker.requests` counts against the 10M included each month.

The account's billing page (Manage Account → Billing → Billable usage) shows the same numbers a day late. If you want warnings, set a Billing notification there for Workers usage.

## Cloudflare Access and the cut-over

Cloudflare Access is checked before the Worker runs. The old "Poki MCP" app covers the whole host, so the relay's paths have their own bypass apps, and the more specific path wins. Each bypass app has one policy that lets everyone through. There is no sign-in, because the relay does its own OAuth.

Zone `zheha.nz` is `b31403b7d3be18a6ad7689a364ad3fc2`.

| Access app | id | Covers |
|---|---|---|
| Poki relay v1 (bypass) | `e299a7cd-ba26-44c7-8ddc-1545bbe07ac0` | `pokimcp.zheha.nz/v1` |
| Poki relay well-known (bypass) | `9187a0b6-1974-4c99-a87c-227de0abd0fe` | `pokimcp.zheha.nz/.well-known` |
| Poki MCP (old daemon, "ZhehanZ Only" allow policy) | `6c6b4223-148b-4a02-bd3b-cc88cc448568` | `pokimcp.zheha.nz` |

### Recreate a bypass app

You need this on a new account, or if one of the apps was deleted. Run it once per path, with `/v1` or `/.well-known`:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Poki relay v1 (bypass)","type":"self_hosted",
       "domain":"pokimcp.zheha.nz/v1","destinations":[{"type":"public","uri":"pokimcp.zheha.nz/v1"}],
       "session_duration":"24h","app_launcher_visible":false,
       "policies":[{"name":"Everyone (bypass)","decision":"bypass","include":[{"everyone":{}}],"precedence":1}]}'
```

### Retire the old daemon (one-way; do it only once the phone app has replaced it)

Do these steps in order. Until step 2, the tunnel keeps serving everything outside `/v1` and `/.well-known`.

1. **Give the hostname a record that does not point at the tunnel.** Zone routes only run on a proxied record. Replace the tunnel CNAME (`99ffe9e8132b3ae3cf8b6a8cd4fa0382`) with a proxied placeholder. Create the new record first, then delete the CNAME:

   ```sh
   curl -X DELETE "https://api.cloudflare.com/client/v4/zones/b31403b7d3be18a6ad7689a364ad3fc2/dns_records/99ffe9e8132b3ae3cf8b6a8cd4fa0382" -H "Authorization: Bearer $TOKEN"
   curl -X POST   "https://api.cloudflare.com/client/v4/zones/b31403b7d3be18a6ad7689a364ad3fc2/dns_records" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"type":"AAAA","name":"pokimcp","content":"100::","proxied":true,"comment":"Workers routes only (poki-relay)"}'
   ```

   Cloudflare refuses a second record with the same name, so run the DELETE right before the POST. Expect a few seconds of errors in between. As an alternative, swap both routes for a Workers Custom Domain on `pokimcp.zheha.nz`, which creates its own record.
2. **Stop falling through to the origin.** Set `ORIGIN_FALLBACK` to `0`, as described under [Lower a cap](#lower-a-cap). Paths the Worker does not own then get 404 instead of the placeholder's error.
3. **Delete the old Access app.**

   ```sh
   curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps/6c6b4223-148b-4a02-bd3b-cc88cc448568" -H "Authorization: Bearer $TOKEN"
   ```

   Its policy "ZhehanZ Only" (`c028eee8-4a06-49d0-bb97-6c9e86194ef2`) is reusable, so it survives the delete. Remove it under Zero Trust → Access → Policies if nothing else uses it.
4. **Optionally remove the two bypass apps.** With no Access app covering the host, they do nothing. Keep them if you might put Access on the host again.
5. **Stop the tunnel.** Stop `poki-cloudflared` on us-light and delete the tunnel under Zero Trust → Networks → Tunnels.

To undo steps 1 to 3 before step 5, recreate the CNAME to `<tunnel id>.cfargotunnel.com` (proxied), set `ORIGIN_FALLBACK=1`, and recreate the Access app with an allow policy.

# Poki on the phone: interfaces

Poki runs entirely on the iPhone. Nothing at runtime depends on a server of ours except a relay that
carries MCP requests to the phone and stores nothing.

```
MCP client ──HTTPS──▶ Cloudflare Worker (relay) ──WebSocket (phone dialed out)──▶ Poki app
                                                                                   ├─ PokiCore (Swift): MCP, look/do, approvals
                                                                                   ├─ PokiLauncher (Rust): runner launch and keepalive
                                                                                   └─ app shell (SwiftUI): setup, Live Activity, approvals
Poki app ──TCP 10.7.0.1:* (loopback tunnel)──▶ the phone's own developer services ──▶ WebDriverAgent runner (127.0.0.1:8100)
```

Three interfaces, each owned by one side:

| Interface | Defined here, implemented by |
|---|---|
| 1. Relay frames (Worker ⇄ phone) | dev/cf-relay (Worker), PokiCore (phone) |
| 2. PokiCore Swift API | PokiCore; used by dev/ios-app |
| 3. PokiLauncher C ABI | PokiLauncher; used by PokiCore and dev/ios-app |
| 4. What the launcher needs from the loopback | dev/ios-app's packet tunnel, or the user's proxy module |

Version: 1.1 (2026-11-06: on-device pairing in §3, ToolFacts on toolFinished in §2, tunnel facts in §4, keep-alive). Every change to a section below bumps its version and is announced to the other threads.

## 1. Relay frames, v1

### Identity

- The phone makes an Ed25519 key pair once and keeps the private key in the keychain
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- `label` = RFC 4648 base32 of the raw 32-byte public key, lowercase, no padding (52 characters).
  The same label scheme as dev/relay, so either relay can serve a phone.
- The phone makes a **connector secret**: 32 random bytes, base64url without padding (43 characters).
  Several may exist (one per MCP client); each can be revoked on the phone.
- The MCP client's URL is
  `https://pokimcp.zheha.nz/v1/<label>/<secret>/mcp`.
  The Worker never stores the secret. The phone sends only `sha256(secret)` (hex), and only on a live
  connection, so when the phone is offline the Worker knows nothing about it.

### Phone ⇄ Worker (WebSocket)

The phone opens `wss://pokimcp.zheha.nz/v1/<label>/connect`. All frames are UTF-8 JSON text frames
except the keepalive.

1. Worker → `{"t":"challenge","nonce":"<base64 32 bytes>"}` immediately after the upgrade.
2. Phone → `{"t":"hello","v":1,"key":"<base64 raw public key>","sig":"<base64 signature>","access":["<hex sha256 of secret>", ...],"app":"<app version>"}`.
   `sig` signs the bytes of `poki-relay-v1:<label>:` followed by the raw nonce bytes.
   The Worker checks that base32(key) == label and that the signature verifies; otherwise it closes
   with 4401. `access` has at most 8 entries.
3. Worker → `{"t":"ready","max_body":4194304,"req_timeout_ms":60000}`.
4. A newer connection for the same label replaces the older one (close 4000, "replaced").
5. The phone may send `{"t":"access","access":[...]}` at any time to replace the list (a secret was
   added or revoked); the Worker answers `{"t":"ready",...}` again.

Requests (Worker → phone), one per HTTP request from the MCP client:

```json
{"t":"req","id":"<opaque, unique per connection>","method":"POST","headers":{"content-type":"application/json","accept":"application/json, text/event-stream","mcp-session-id":"...","mcp-protocol-version":"2025-06-18"},"body":"<the request body as a UTF-8 string>"}
```

- Only these headers are forwarded, lowercased, when present: `content-type`, `accept`,
  `mcp-session-id`, `mcp-protocol-version`, `last-event-id`. Never `authorization` or cookies, and
  never the client's IP.
- Methods: `POST`, `GET`, `DELETE`.

Responses (phone → Worker):

```json
{"t":"res","id":"<same id>","status":200,"headers":{"content-type":"application/json","mcp-session-id":"..."},"body":"<UTF-8 string>"}
```

- The phone answers every request exactly once. PokiCore answers MCP POSTs with
  `application/json` (no SSE), `GET` with 405, and `DELETE` with 200 after ending the session.
- Bodies are at most `max_body` bytes either way; the Worker answers 413 to a larger request, and the
  phone never sends a larger response (screenshots are JPEG, about 20 to 60 kB).
- `{"t":"cancel","id":"..."}` (Worker → phone) when the client went away; the phone may stop the work
  and must not send a `res` for it afterwards.

Keepalive: the phone sends the text frame `ping` (the bare word, not JSON) every 25 s; the Worker
answers `pong` with `setWebSocketAutoResponse`, so a hibernated Durable Object is not woken. The phone
reconnects with backoff (1, 2, 4 … 30 s, jittered) when no `pong` arrives for 60 s.

### What the Worker answers the MCP client itself

| Case | HTTP |
|---|---|
| Unknown label, or secret hash not in `access` (indistinguishable) | 404 `{"error":"not found"}` |
| Phone not connected | 503 with a JSON-RPC error body: `{"jsonrpc":"2.0","id":<request id or null>,"error":{"code":-32001,"message":"The phone is offline: open Poki on the phone, or check its network."}}` |
| No `res` within `req_timeout_ms` | 504 with the same JSON-RPC shape, code -32002 |
| Rate limit | 429 with the JSON-RPC shape, code -32003 |
| Body over `max_body` | 413 |

### Limits (cost)

The account is on Workers Paid, so overage can bill. The Worker keeps hard caps (exact numbers are
dev/cf-relay's): requests per label per minute, concurrent requests per label (PokiCore handles one tool
call at a time; 4 in flight is plenty), body size, and connections per label (one). The Worker stores
nothing: no KV, no D1, no Durable Object storage writes, and no logs of headers, bodies or IPs. The
Durable Object keeps only the hello's `access` list and label in the WebSocket attachment.

## 2. PokiCore Swift API, v1

A Swift package (`native/ios/PokiCore`) with no UIKit or SwiftUI dependency. It builds and tests on
Linux; iOS-only parts (JPEG encoding, keychain) come from the host protocol.

```swift
public struct CoreConfig: Sendable {
    public var relayURL: URL                 // wss://pokimcp.zheha.nz/v1
    public var runnerURL: URL                // http://127.0.0.1:8100
    public var sensitive: SensitivityRules   // what needs approval; see below
    public var approvalWait: Duration        // how long do() holds for an approval before answering (default 20 s)
    public var toolDeadline: Duration        // hard cap per tool call (default 25 s)
}

public protocol CoreHost: AnyObject, Sendable {
    /// Signs relay challenges with the device key (keychain on iOS).
    func signingKey() throws -> RelayKey
    /// The connector secrets' sha256 hashes, hex.
    func accessHashes() -> [String]
    /// A JPEG of the PNG screenshot scaled to `width` points (ImageIO on iOS).
    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data
    /// The runner launcher's state; PokiCore asks for a restart when the runner stops answering.
    func runnerState() -> RunnerState
    func restartRunner()
}

public final class PokiCore: Sendable {
    public init(config: CoreConfig, host: CoreHost)
    public func start()                       // connect to the relay, keep it connected
    public func stop()
    public var events: AsyncStream<CoreEvent> { get }
    public func resolveApproval(id: String, approved: Bool)
    public func handle(_ request: RelayRequest) async -> RelayResponse   // also for local tests
}

public enum CoreEvent: Sendable {
    case relay(RelayState)                    // connecting, ready, offline(reason)
    case toolStarted(ToolActivity)            // name, summary ("tap 'Send'"), started
    case toolFinished(ToolActivity, ToolOutcome, ToolFacts)   // ToolFacts: app name, ~96 px JPEG thumbnail
    case approvalRequested(Approval)          // id, app, summary, expires
    case approvalEnded(id: String, approved: Bool?)  // nil: expired
}
```

`ToolFacts.thumbnail` is a JPEG about 96 pixels wide (a few kB). ActivityKit's content state is
limited to 4 kB, so the app writes the thumbnail to its app group and the Live Activity reads it from
there.

The app shell maps `events` to the Live Activity and resolves approvals from the Live Activity's
buttons (App Intents). The automation can never grant an approval. A `do` with other actions first
withdraws the pending request, before anything of it is sent, so a tap on the Live Activity's Approve
button lands on a request that is already gone. Only the same actions, sent again, wait for the
decision.

### Tools

The computer-use profile, ported from `src/cua.mjs` and `src/cua-wda.mjs`:

- `look {full?}`: read the screen now.
- `do {actions: [...], full?}`: run actions in order, then read the screen.
- `status`: the relay, the runner and pending approvals, without touching the device.

Each answer is facts only: the app in front, numbered elements, `+` for new, what each action did
(`sent`, `not_sent`, `unknown`), timings and a JPEG screenshot. No verdicts.

### Deadlines (no hangs)

- Every runner HTTP call has its own timeout (reads 4 s, taps 3 s, typing 3 s plus 60 ms per
  character, launches 8 s) and the whole tool call has `toolDeadline`.
- At the deadline the tool answers anyway, saying which step did not finish and whether it may
  have been delivered, plus the last good read if any. A late runner answer is dropped.
- Two runner timeouts in a row, or a refused connection, mark the runner unhealthy: PokiCore calls
  `host.restartRunner()`, answers at once with `runner restarting` instead of waiting, and the next call
  sees the new runner.
- One tool call runs at a time per phone. A second one waits at most 2 s, then answers `busy` with what
  the first is doing.

### Sensitive actions

`SensitivityRules` (user-editable in the app, sensible defaults):

| Rule | Default |
|---|---|
| Typing into a secure text field | approval |
| Tapping an element whose label matches the payment words (Pay, Buy, Purchase, Subscribe, Transfer, Send money, 支付, 付款, 购买, 转账, …) | approval |
| Deleting (Delete, Remove, Erase, Reset, 删除, 移除, 抹掉, …) | approval |
| Sending a message or mail (Send, 发送 in Messages, Mail, WeChat, WhatsApp, Telegram, …) | approval |
| Apps on a list (banking, wallets; by bundle id) | approval for every input |

When an action matches, nothing in that `do` is sent. PokiCore emits `approvalRequested` and holds up
to `approvalWait`. If approved in time, the actions run and the answer says `approved on the phone`.
If not, it answers `not_sent: approval_required (id …)`, and the same actions in a later `do` within
2 minutes run once that approval is granted. Denied: `not_sent: the owner declined`.

## 3. PokiLauncher C ABI, v1

A Rust static library (`native/launcher`, crate `poki-launcher`, `staticlib`) on idevice. It gets
the runner up and keeps it up. Header `poki_launcher.h`:

```c
typedef struct PokiLauncher PokiLauncher;
typedef void (*poki_launcher_event_cb)(void *context, const char *event_json);

// config_json: {
//   "device_address": "10.7.0.1",
//   "pairing_file": "/path/in/app/container",    // RPPairing (remote pairing) or lockdown pairing plist
//   "host_name": "Poki",                        // optional; the name the pairing was made with
//   "ddi_dir": "/path/to/ddi",                  // Image.dmg, BuildManifest.plist, Image.dmg.trustcache
//   "runner_bundle": null,                      // null: the installed app whose id contains WebDriverAgentRunner and xctrunner
//   "wda_port": 8100
// }
PokiLauncher *poki_launcher_new(const char *config_json, poki_launcher_event_cb cb, void *context);
int  poki_launcher_start(PokiLauncher *launcher);     // 0 = started; runs on its own threads
void poki_launcher_restart(PokiLauncher *launcher);   // drop the session and launch again
void poki_launcher_stop(PokiLauncher *launcher);
char *poki_launcher_status(PokiLauncher *launcher);   // JSON, free with poki_string_free
void poki_string_free(char *s);
void poki_launcher_free(PokiLauncher *launcher);
```

On-device pairing (iOS 27, like StikPair). Poki plays the "pairable host":

```c
typedef struct PokiPairing PokiPairing;
// config_json: {"host_name": "Poki", "out_path": "<app container>/pairing.plist", "identity_path": "<app container>/pairing-host.key"}
PokiPairing *poki_pair_start(const char *config_json, poki_launcher_event_cb cb, void *context);
void poki_pair_cancel(PokiPairing *pairing);   // stops it if running, and frees it
```

Events, in order:
- `{"event":"advertise","service_type":"_remotepairing-pairable-host._tcp","instance":"<id>","port":n,"txt":{"name","identifier","authTag","model","flags","ver","minVer"}}`.
  The launcher listens on that TCP port; the app publishes the service with Bonjour (NetService or
  NWListener's service, with `instance` as the name and the TXT record). It needs
  `NSBonjourServices` = `_remotepairing-pairable-host._tcp` and `NSLocalNetworkUsageDescription`.
- `{"event":"pin","pin":"123456"}`: show it (Live Activity). The person types it on the phone.
- `{"event":"paired","path":"…"}`: the RPPairing file is saved; give it to `poki_launcher_new` as
  `pairing_file`.
- `{"event":"failed","detail":"…"}`.
`identity_path` keeps the host's 16-byte identity, so the phone recognizes Poki next time. One
pairing per call.

Events (and `status`) are JSON:
`{"state":"…","detail":"…","attempt":n,"since_ms":…,"ios":"26.1","pairing":"remote|lockdown"}`, with
state one of `idle`, `connecting`, `pairing`, `tunnel`, `mounting_ddi`, `launching`, `running`,
`waiting_network`, `failed`. `failed` carries a `fix` the app can show (for example "Turn on the
loopback in Shadowrocket: Settings → Other → Include route 10.7.0.1/32").

What it does:

1. Connects to `device_address`: RemotePairing on 49152 (RPPairing file), or lockdown on 62078
   (lockdown pairing plist) and then CoreDeviceProxy. The pairing file decides which.
2. Opens the CDTunnel in-process (userspace TCP/IP), then RSD.
3. Mounts the personalized DDI from `ddi_dir` if it is not mounted (needs internet once per boot for
   Apple's TSS signature).
4. Launches the runner via testmanagerd and dtservicehub, and holds those connections.
5. Watches the runner (`GET /status` on 127.0.0.1:`wda_port` every 5 s); after 2 misses, or when the
   session drops, it relaunches with backoff. It never exits by itself.

The launcher's process must stay alive for the runner to stay alive (the runner dies 23 to 32 s after
the session's connections close). Keeping the app alive in the background is the app shell's job
(a silent `AVAudioEngine` with `mixWithOthers`, plus the Live Activity); see `docs/single-bundle.md`
for one IPA vs two. The supervisor runs on its own thread with a single-threaded runtime;
callbacks arrive on that thread.

## 4. What the launcher needs from the loopback

Only this: TCP from the app to `10.7.0.1` on any port comes back to the phone itself, with source and
destination swapped. The phone needs nothing else from it: no UDP, no IPv6, no DNS, no default route,
no other addresses. The ports used are 49152 or 62078, plus one dynamic tunnel port per session that
the phone picks.

- The built-in packet tunnel (dev/ios-app): interface address 10.7.0.2/24, includedRoutes 10.7.0.1/32
  only, IPv4 only, no DNS settings, no IPv6, MTU 1500. Every packet to 10.7.0.1 goes back with source
  and destination swapped.
- Surge / Loon: `10.7.0.1 = reflect` with the route included and IPv6 VIF off. sing-box:
  `loopback_address: ["10.7.0.1"]`. Shadowrocket: "Include route 10.7.0.1/32".

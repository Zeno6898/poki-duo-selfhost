# Poki for iPhone

One app for everything a user does on the phone: setup (Developer Mode, on-device pairing, UI
Automation, the loopback, the first-session passcode), starting and stopping a session, the Live
Activity with Approve/Deny for sensitive actions, the MCP address for each client (text, QR, copy),
and a Debug tab (the former Poki Probe). Native SwiftUI on the iOS 26 SDK with Liquid Glass.

The runner (WebDriverAgent, built by `.github/workflows/ios-runner.yml`) is a second bundle for v1;
dev/ios-core `docs/single-bundle.md` explains why.

## Layout

| Path | What |
|---|---|
| `Poki/App` | App entry, tabs, Home, the app model (session, events, approvals, pairing) |
| `Poki/Setup` | The setup steps |
| `Poki/Loopback` | Built-in tunnel control, proxy app detection and one-tap module install |
| `Poki/Activity` | Live Activity controller (state, thumbnail in the App Group) |
| `Poki/Connect` | Relay identity (Ed25519 key, label, connector secrets in the keychain), MCP address with QR |
| `Poki/Runtime` | The shell's view of PokiCore and PokiLauncher, background keep-alive |
| `Poki/Debug` | 10.7.0.1 checks and the background hold test |
| `Shared` | Live Activity attributes and the Approve/Deny App Intents (app and widget) |
| `PokiTunnel` | Packet tunnel that routes only 10.7.0.1 and reflects it back to the phone |
| `PokiWidgets` | The Live Activity's lock screen and Dynamic Island views |

PokiCore (Swift) and PokiLauncher (Rust, C ABI) come from dev/ios-core (`docs/ios-core.md`). Until
they are linked, `Poki/Runtime/CoreBridge.swift` provides stand-ins that say so on screen, so the
whole shell builds and runs without them.

## Build

GitHub Actions (`.github/workflows/ios-app.yml`) builds `Poki-unsigned.ipa` on every push to
`dev/ios-app`. Locally on a Mac with Xcode 26 or later:

```sh
native/ios-app/scripts/make-assets.sh
xcodegen generate --spec native/ios-app/project.yml
open native/ios-app/Poki.xcodeproj
```

## Signing and entitlements

| Entitlement | Needed for | Notes |
|---|---|---|
| App Groups `group.nz.zheha.poki` | Live Activity thumbnail, approvals between widget and app | AltStore and SideStore rewrite group ids per Apple ID; that works as long as all three targets get the same rewritten group. |
| Network Extension `packet-tunnel-provider` | The built-in loopback | Needs a paid developer team. Free Apple ID signing (AltStore) strips it: the app still works with a proxy app's loopback module, and the built-in option shows the save error. With the paid team, sign the IPA with a profile that has the Network Extension capability for `nz.zheha.poki` and `nz.zheha.poki.tunnel` (the server session's `wda/sign-on-mac.sh` can be adapted). |

## Loopback choices

- **Built-in**: `PokiTunnel` routes only 10.7.0.1/32 (IPv4, no DNS, no default route, MTU 1500) and
  sends every packet for it back with source and destination swapped. The interface address is
  10.7.0.2. It takes the VPN slot.
- **Proxy app**: Surge (module, `surge:///install-module?url=`), Loon (plugin,
  `loon://import?plugin=`), Shadowrocket (its "Include route 10.7.0.1/32" toggle) or sing-box (one
  line in the tun inbound). Files in `deploy/proxy-modules/`, served from the fork's raw GitHub URL
  for now (`ProxyApps.modulesBase`).

## Device test checklist

For the first install on the phone. Each line is one thing to look at; note what happened.

Install and launch
- [ ] Install `Poki-unsigned.ipa` (and the runner IPA) with the paid-team signing; the Poki icon is the bear on blue, the runner's is the bear with the play triangle.
- [ ] Launch Poki: Home shows the bear, three status rows, Start; the tab bar is glass and shrinks on scroll.

Setup
- [ ] Developer Mode step: Open Settings works; the toggle ticks the step.
- [ ] Pairing step: Start pairing; (once PokiLauncher pairing lands) Settings > Privacy & Security > Developer Mode shows Pair with Poki; the PIN appears in the Live Activity; pairing completes and the step ticks.
- [ ] Import a pairing file (StikDebug/SideStore export): accepted; a non-plist file is refused with a message.
- [ ] UI Automation step: Settings > Developer > Enable UI Automation is there after Developer Mode.
- [ ] Loopback, built-in: Turn on asks to add a VPN configuration; status goes to On; Debug tab shows a 10.7.0.x interface with no IPv6, and 10.7.0.1:62078, :49152 and the random port all answer (connected, or refused for the random port).
- [ ] Loopback, proxy: with Surge/Loon/Shadowrocket installed, its card says Installed; Install module/plugin opens the proxy app with the import prompt; with the module on, the Debug checks pass as above.
- [ ] Passcode step reads clearly.

Session and Live Activity
- [ ] Start: the Live Activity appears (lock screen and Dynamic Island) with the bear and "Starting".
- [ ] Leave Poki for 5 minutes with a session on: Debug > Background hold (and the runner, once linked) shows no suspension gap; note how long it stays alive with and without the session's audio keep-alive.
- [ ] (Once PokiCore is linked) an agent's look/do updates the headline, last action and thumbnail.
- [ ] (Once PokiCore is linked) a sensitive action shows Approve/Deny in the Live Activity; Deny answers the agent "declined"; Approve on the lock screen asks for Face ID; while pending the agent's do calls return approval_pending.
- [ ] Stop ends the Live Activity and the keep-alive.

Connect
- [ ] Add a connector named Claude: the sheet shows the URL, a QR that scans to the same URL, and Copy works.
- [ ] Revoke by swiping: the connector disappears (and, once PokiCore is linked, the relay answers 404 for it).
- [ ] The device label stays the same across app restarts (keychain).

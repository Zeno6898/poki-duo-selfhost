# Poki runner (on-phone)

The runner is the part of Poki that runs on the iPhone itself: Appium's WebDriverAgent (BSD-3-Clause,
vendored as a submodule at `WebDriverAgent/`, pinned to v16.15.3, commit `02cb92f0`), built as the
`WebDriverAgentRunner` UI-test host and branded as Poki (icon, display name, launch screen) by
`branding/brand.sh`.

## Build

There is one build path: the GitHub Actions workflow `.github/workflows/ios-runner.yml` on macOS. It
runs `xcodebuild build-for-testing` for the iOS device SDK with signing off, brands the app, strips
dSYMs and uploads two unsigned IPAs with their SHA-256 sums as the `poki-runner-unsigned` artifact:

- `poki-runner-unsigned.ipa` leaves out the XCTest libraries Xcode copies into the runner, as
  WebDriverAgent's own real-device package does; they come from the phone's developer image.
- `poki-runner-unsigned-with-frameworks.ipa` keeps them.

It runs on every push to `dev/ios-runner` and on demand. The IPA is signed when it is installed (for
now AltStore with the user's Apple ID).

## Poki Probe

`PokiProbe/` is a one-screen SwiftUI app that answers whether the phone can reach its own developer
services. The primary checks connect with Network.framework to 10.7.0.1 on 62078 (lockdown) and
49152 (RemotePairing, the port poki-wda uses), and on a random port in 50000-59999, because the
tunnel's second connection goes to a port the phone picks (refused there means reachable, a timeout
means not): 10.7.0.1 is the address the user's own proxy app
reflects back to the phone (see [`deploy/proxy-modules/`](../../deploy/proxy-modules/)), so Poki
never takes the phone's VPN slot. Secondary rows connect to 49152 on en0's Wi-Fi IPv4 address, on
127.0.0.1 and on en0's link-local IPv6 address. Each row shows the raw result (connected, refused,
timeout or the error) and the first bytes received. The app also shows which interface carries a
10.7.0.x address and whether that interface has IPv6 too (it should not: tools that look for this
loopback skip interfaces with IPv6). A "Background hold" section measures the launcher's biggest risk: it holds one
TCP connection to 10.7.0.1 (49152 by default, any port) while the user leaves the app, and logs with
timestamps the app's state changes, the background task's time and expiry, a once-a-second heartbeat
whose gaps are time spent suspended, and when the connection closed. The log is also written to a
file, so it is shown again after the app was killed. As experiments only, not for shipping, the hold
can run with silent audio or location updates (the Info.plist declares both background modes) to
compare against none. The app needs no special entitlement. The project is generated
from `project.yml` with XcodeGen in the same workflow, which uploads `PokiProbe-unsigned.ipa` as the
`PokiProbe-unsigned` artifact.

## Design note: the runner dials out (not built yet)

Today the runner is reached at its WebDriver port over the tailnet. The end state is different, and
two rules from the user bound it.

**No listening socket, no unauthenticated control.** Poki's runner build must not listen on any
network interface. WebDriverAgent's HTTP server is bound to 127.0.0.1 (or replaced by an in-process
dispatcher), and all control arrives over the runner's own outbound connection:

1. On first launch the runner creates a device key (a keypair in the keychain, private key never
   leaving the phone) and shows a pairing code. The user pairs it with their Poki account once; the
   relay stores the public key, and the user can revoke it there at any time.
2. The runner opens one outbound WebSocket (TLS) to the relay and authenticates with a signature over
   a relay challenge. It keeps the connection up with pings and reconnects with backoff on network
   changes, so Wi-Fi to cellular needs nothing from the user.
3. The relay forwards WebDriver requests (method, path, body, request id) for that device over the
   socket; the runner hands each to its local WebDriver dispatcher on 127.0.0.1 and sends back the
   status and body. Only the WebDriver routes Poki uses are forwarded.
4. MCP clients reach the relay through OAuth per user, and a user's tokens reach only that user's
   paired devices.

**Minimal third-party tools.** The end state is a store-distributable Poki companion app that installs
and refreshes the runner itself with the user's Apple ID (the SideStore / StikDebug approach), connects
to the relay without Tailscale, and relaunches the runner after a reboot. A user needs only an Apple ID
and Developer Mode. AltStore and Tailscale are stand-ins until then.

The outbound client is the next step after the first green build.

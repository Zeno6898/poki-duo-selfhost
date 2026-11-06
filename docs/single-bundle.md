# One IPA or two: can the Poki app be the XCTest host?

Question: instead of the Poki app plus a separate WebDriverAgent runner, could users install one
IPA, with the `.xctest` bundle in the Poki app's `PlugIns` and the Poki app launched by
testmanagerd as the test host?

## Conclusion

Not in one process, and not for v1. Ship two bundles: the Poki app (launcher, MCP, UI) and the Poki
Runner (the WDA UI-test runner, Poki-branded). Both are listed in one AltStore source, so setup is
two "Get" taps, not two separate downloads.

One IPA is possible only with two processes from one IPA. The candidate is the app as test host plus
the launcher inside the app's packet-tunnel extension. It is worth a device experiment later, but
it fails for users who use a proxy module instead of our tunnel, so it cannot be the only design.

## Evidence

Measured on the owner's iPhone (2026-11-06, `wda-spike/lifetime.txt`):

1. The runner lives only while the launcher holds its testmanagerd and dtservicehub connections. With
   the launcher killed, the runner was gone 23 to 32 s later, in every trial.
2. Launching goes through `dtservicehub` process control with the runner's bundle id. idevice's
   `launch_and_authorize_test_runner` launches with `KillExisting`, then authorizes the new pid
   with testmanagerd (`_IDE_authorizeTestSessionWithProcessID`).

From the protocol, as implemented in `run_over_rsd` (`native/patches/idevice-xctest-run-over-rsd.patch`):

3. The order is fixed. The IDE side (the launcher) opens the testmanagerd control and main
   sessions, starts the daemon session, then launches the host, then authorizes its pid. The IDE
   side must exist before the host starts and must outlive it (point 1).
4. The host is a fresh process of the bundle id (point 2). If the host were the Poki app, launching
   it would end the running Poki app, and with it the launcher that holds the session, so the
   runner dies about 30 s later (point 1). One process cannot be both the IDE side and the host.

From the platform:

5. The launchable unit is an app bundle. iOS installs no nested apps (Watch apps aside), and app
   extensions cannot be launched through process control as a UI-test host. So a second launchable
   process inside one IPA can only be an extension that iOS starts by itself, with the app as host.
6. The only extension that is long-lived and not suspended is the packet tunnel (Network Extension).
   While the VPN is on, it runs without the app in front, within about 50 MB of memory. The
   launcher (Rust, idevice, a userspace TCP stack) fits comfortably.
7. UI testing needs the host to be authorized as a UI-test runner (point 2). An ordinary app with
   XCTest injected (`DYLD_INSERT_LIBRARIES` of `libXCTestBundleInject.dylib` plus
   `XCTestConfigurationFilePath`) is how Xcode runs unit tests in a host app. Whether XCUIApplication
   and XCUIDevice work in such a host once authorized is untested. WDA has only ever run in the
   XCTRunner-style `-Runner.app`.

## What a one-IPA experiment would need (later, on a device)

- Launcher in the packet-tunnel extension; the Poki app as the test host, launched with the
  injection environment and the WDA `.xctest` in its `PlugIns`.
- Checks: does the authorized Poki app get UI-testing rights (`/status`, `/source` of another app,
  a tap)? Does the extension keep the session through app relaunches, backgrounding and screen lock?
  How much memory does the extension use?
- It does not help proxy-module users (Surge, Loon, sing-box, Shadowrocket): with their VPN on, our
  extension is not running, so they still need the two-bundle path.

## v1 decision

- Two bundles: `Poki` (the app) and `Poki Runner` (WDA, same team, Poki icon and name, already
  built as `wda/build-poki-1`).
- The launcher runs in the Poki app's process, kept alive in the background by the app shell
  (background audio session plus the Live Activity).
- One AltStore source lists both.

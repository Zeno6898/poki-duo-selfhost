# Device test checklist (PokiCore and PokiLauncher)

Everything in dev/ios-core is tested on Linux and macOS only (Swift tests, Rust tests, iOS builds).
These checks need the phone. Run them in order: each step relies on the one before. Write the
result and the time next to each line.

## 0. Before

- [ ] Poki (dev/ios-app build) and Poki Runner installed from AltStore, both opened once.
- [ ] Developer Mode on (Settings → Privacy & Security → Developer Mode).
- [ ] Note the iOS version and whether the phone is on Wi-Fi or cellular for each step.

## 1. Loopback (one of these)

- [ ] Poki's own tunnel on (Settings → VPN shows Poki): `status` should leave `waiting_network`.
- [ ] Or Shadowrocket "Include route 10.7.0.1/32" on, with Shadowrocket connected.
- [ ] Or Surge Enhanced Mode with the Poki module (`10.7.0.1 = reflect`), or Loon's plugin, or sing-box `loopback_address`.
- [ ] With a proxy app: a web page still loads through the proxy (the proxy keeps working).

## 2. Pairing on the phone (iOS 27)

- [ ] Start pairing in Poki: the launcher emits `advertise`, and Poki appears in Settings' list of computers to pair with.
- [ ] Pick it: a PIN appears in Poki's Live Activity; type it on the phone.
- [ ] `paired` arrives with a path; the file is in the app's container (never print its contents).
- [ ] Older iOS, or if this fails: use a pairing file made on a Mac (RPPairing or lockdown plist) and note which kind worked.

## 3. Launcher

- [ ] States move: connecting → pairing → (mounting_ddi on the first run after a restart) → launching → running. Note the time of each.
- [ ] Mounting needs the internet: try it once with Wi-Fi and once on cellular.
- [ ] `running` within 60 s. Then `curl`-equivalent: PokiCore `look` answers.
- [ ] Kill Poki Runner from the app switcher: within about 10 s the launcher relaunches it (`launching`, then `running`).
- [ ] Background Poki and use other apps for 5 minutes: the runner stays up (this tests the keep-alive; the runner dies about 30 s after the launcher's connections close).
- [ ] Lock the phone for 2 minutes, unlock: does the runner survive? If not, how long until it is back?
- [ ] Switch Wi-Fi off and on, and to cellular: does the launcher keep or regain `running`? Earlier tests over Tailscale found new developer connections only on Wi-Fi; record whether the loopback changes that.
- [ ] Turn the loopback off: the state becomes `waiting_network` with the fix text, and back to `running` after it is turned on again.

## 4. PokiCore through the relay

- [ ] The relay state reaches `ready`; the connector URL (`https://pokimcp.zheha.nz/v1/<label>/<secret>/mcp`) is shown in Poki.
- [ ] Add it in Claude as a connector; `tools/list` shows look, do, status.
- [ ] `look` within 2 s, with a screenshot and elements.
- [ ] A Clock task (World Clock → add a city) and a Notes task, timed from the first call to the last.
- [ ] Force a hang: background Poki Runner's app during a `do` (or kill it); the call answers within 25 s, says what may have been delivered, and the next `look` answers `runner: starting` at once.
- [ ] Phone offline (airplane mode): the MCP client gets the relay's "The phone is offline" error, not a hang.

## 5. Approvals

- [ ] `do` tapping a Delete button in Photos: nothing happens on screen, the Live Activity asks, the answer says `approval_required`.
- [ ] Approve in the Live Activity within 20 s: the same call goes on and taps.
- [ ] Approve after 20 s, then send the same actions: it taps once; a third time asks again.
- [ ] Decline: `not_sent: the owner declined`.
- [ ] While an approval is pending, have the agent tap the Live Activity's Approve button (`do` with the button's point): the pending request is withdrawn first, so nothing is approved.
- [ ] Typing into a password field asks first, and the Live Activity hides the text.

## 6. Live Activity

- [ ] It shows the current call (tool and summary), then the app and the thumbnail after each call.
- [ ] It stays while Poki is in the background, and ends when Poki stops.

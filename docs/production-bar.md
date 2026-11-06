# Production bar for Poki (iPhone app, runner, relay)

Pass or fail, with evidence. "Phone" means a check that needs the owner's iPhone; everything else is
checked on CI or by reading the code. Updated each round with the commit that shows it.

| # | Item | How it is checked | State |
|---|------|-------------------|-------|
| 1 | Fresh user to a working Claude connector in under 5 min using only Poki's screens (runner install and trust, Developer Mode, loopback, pairing, disk image, connector); every failure screen names its own fix | Phone; failure screens on CI (home Issue cards, Setup steps) | Failure screens done; flow needs the phone |
| 2 | No hangs: every tool call answers within 25 s (46 s while an approval waits); a 200-call soak with runner kills, lock, Wi-Fi toggles and backgrounding needs no manual recovery | PokiCore soak test (server session, dev/ios-core); phone soak | Soak test being added; phone soak open |
| 3 | Speed: a first-time agent does the screenshot task under 20 s and the note task under 10 s, no task-specific hints | Phone | Open |
| 4 | Real life: background 10 min, lock 5 min, reboot (disk image remounts by itself), Wi-Fi to cellular; each recovers alone or says the one thing to do | Phone; recovery texts on CI | Open |
| 5 | Safety: payments, deletes, sending messages and passwords wait for a tap; the agent cannot approve its own request; Stop works from the Live Activity; revoking a connector cuts the client off | PokiCore tests (approvals, input blocked while pending); phone for the Live Activity | Tests green; Live Activity on phone open. Volume-button Stop not built (no public API outside an audio session; ask the owner) |
| 6 | Privacy and cost: pairing file, key and secrets in the keychain or protected files; the relay stores and logs nothing; Cloudflare caps hold | Code review; relay OPS.md | Holds as of dev/cf-relay f0af871 |
| 7 | Release hygiene: versioned builds, a changelog, docs/device-test-checklist.md passed and recorded | CHANGELOG-round.md; checklist on the phone | Changelog kept; no AltStore source (the owner ruled AltStore out) |
| 8 | UI: every screen HIG-clean in light and dark, no raw JSON, no blank or black screens, no jank | CI screenshots (ios-app simulator-smoke/shots, runner-host-check shots) reviewed every round | Reviewed each round |
| 9 | Runner lifecycle: the banner only while an agent works, idle stop, Stop ends the runner, long tasks keep it | Code and log (Debug > Log); phone | Built; phone confirmation open |

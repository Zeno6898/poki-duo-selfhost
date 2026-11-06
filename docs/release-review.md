# Release hygiene review (production bar item 7)

Reviewed 2026-11-06 against origin/dev/ios-app (ios-app.yml, ios-runner.yml, native/ios-app/project.yml)
and dev/ios-core. Nothing here was run on the phone.

## Findings

| # | What | Severity | Fix |
|---|---|---|---|
| 1 | No built-in loopback tunnel exists on any branch: no packet-tunnel extension target, no `com.apple.developer.networking.networkextension` entitlement in project.yml. The owner's rule is that people without Surge, Loon, sing-box or Shadowrocket need no other app. | Blocker | A PacketTunnel extension target (interface 10.7.0.2/24, route 10.7.0.1/32, reflect, no DNS, no IPv6; docs/ios-core.md §4), its entitlement in project.yml and in the AltStore source's `appPermissions`. Packet tunnels need a paid team's signing, so note that in setup. |
| 2 | Versions are fixed: `MARKETING_VERSION: "0.1.0"`, `CURRENT_PROJECT_VERSION: "1"`. The runner keeps WebDriverAgent's own version. AltStore offers an update only when `buildVersion` grows, so every build looks the same and people never get updates. | High | Stamp both apps in CI, before packaging: `CFBundleShortVersionString` from the tag (`v0.2.0` → `0.2.0`, otherwise the project's value) and `CFBundleVersion` = `${{ github.run_number }}` of the release workflow, with the same values in Poki and in Poki Runner (PlistBuddy on the built .app's Info.plist, before zipping). Print both into the job summary. |
| 3 | IPAs exist only as Actions artifacts. They need a GitHub login, come as zips and expire after 90 days, so AltStore cannot download them. | High | A release workflow on tag push: build both, attach `Poki-<version>-<build>.ipa`, `PokiRunner-<version>-<build>.ipa` and `SHA256SUMS` to a GitHub Release (the repo is public, so the URLs need no login). |
| 4 | No AltStore source. | High | `deploy/altstore/source.json.example` (added): Poki and Poki Runner, the Release URL pattern, minOSVersion 26.0, icons from docs/images, app-group entitlement. The release workflow fills `version`, `buildVersion`, `date`, `size` and `downloadURL`, prepends the new version to `versions`, and publishes the file at a fixed URL (an `altstore` branch with only source.json, or GitHub Pages). AltStore checks `appPermissions` against the IPA's entitlements, so they must match the signed app, tunnel included once finding 1 is done. |
| 5 | The runner's bundle id is WebDriverAgent's `com.facebook.WebDriverAgentRunner.xctrunner`; AltStore renames it with the team id. The launcher finds it by substring, so that works. The source lists the original id. | Low | Keep it, or give the runner its own id (for example `nz.zheha.poki.runner.xctrunner`) in brand.sh and match it in launch.rs's finder. |
| 6 | Two runner IPAs are built (`poki-runner-unsigned.ipa`, `…-with-frameworks.ipa`). Only one can be in the source. | Low | Release the one the launcher is tested with (without frameworks, using the developer image's XCTest), and name it PokiRunner-<version>-<build>.ipa. |
| 7 | CHANGELOG-round.md holds working notes per round; there is no per-release changelog. | Medium | `CHANGELOG.md` skeleton (added). Each release moves Unreleased under its version, and the same text goes into the source's `localizedDescription`. |
| 8 | Unsigned IPAs: AltStore signs with the person's Apple ID. A free Apple ID cannot sign a packet tunnel or (on some iOS versions) app groups, and is limited to 3 apps. | Medium | Setup says plainly: the built-in tunnel needs a paid developer account. With a free account, use a proxy app's loopback instead. Poki and Poki Runner count as 2 of the 3 app slots. |
| 9 | The relay URL, the DDI mirror and the version are not shown together anywhere a person can copy. | Low | Poki's Debug screen: the app version and build, the runner's version and build, the relay host, and the iOS version, in the copied log's header. |

## Release steps (for the workflow to follow)

1. Tag `vX.Y.Z` on the branch to release.
2. CI: tests (PokiCore, including the soak tests; launcher, including soak), then the device-SDK builds of Poki and Poki Runner, stamped as in finding 2.
3. Package: `Poki-X.Y.Z-N.ipa`, `PokiRunner-X.Y.Z-N.ipa`, `SHA256SUMS`.
4. GitHub Release `vX.Y.Z`, with the CHANGELOG section as its notes and the three files.
5. Update source.json (version entry, size, date, URLs) and publish it.
6. Device checklist on the owner's phone before the release is announced; the result goes into the changelog's "Device checks".

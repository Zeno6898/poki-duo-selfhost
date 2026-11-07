# Poki iPhone app: changes per round

What changed in each round, and what still needs the phone. Newest first.

## Round 5 (2026-11-07, after the 00:20Z phone test)

Changed:
- Events reach the screen for the app's whole life. After the first Turn off, no steps or approvals reached Home or the Live Activity (the event stream ended with the task that read it). One pump now lives in AppModel for the app's life.
- Stop really ends the runner: Poki ends the WDA session, asks the runner to shut down, the launcher ends its process, and Poki watches for up to 30 s. The "still running" notice only appears after 10 s and clears by itself once the runner is gone. The launcher reports what happened to the process.
- Live Activity (Live Activity thread): fits inside the system's height on every surface, 16 pt insets, no clipped corners; a silent small pop-up for each step; the large card for approvals; no gradients.
- Pairing is a real file check. Re-pair is always offered in Setup, a refused pairing is shown with "Pair again", the Agent tile and Setup agree, and a passcode hint shows while the runner takes long to start.
- Design: no gradients anywhere (Home, runner screens, Live Activity); rounded type on Home to match Poki Runner; the Agent tile says Idle or Working instead of Off; Copy log has an icon; the Live Activity preview link is gone from Debug.
- Runner opened by hand stays on its own screen with an Open Poki button (no automatic switch). Started by Poki it shows the in-use screen.
- Version 0.2.1 shows in Settings and the log header (was 1.0 (1)).
- Launcher: disk image mount capped at 120 s, failures named by cause (network, image refused, image bad, timeout) with the right fix; a bad image is downloaded again.

Needs the phone:
- Stop ends the runner within seconds and the notice clears.
- Each step pops up in the island and approvals show the large card with Allow and Deny.
- Scrolling and the element tree while an agent works (MCP thread's fixes land next).
- Re-pair from Setup and the passcode hint after a force quit.

## Round 4 (2026-11-06, after the 11:51Z phone test)

Changed:
- Steps are plain words everywhere (PokiCore StepLabels.swift), e.g. Tap “Send”, then type “hi”. No JSON on Home, the Live Activity or in approvals.
- Home redesigned: a hero card with live tiles for Agents, Runner and Loopback, an approval card with a countdown, a Now card (current step, latest screen, Stop), setup progress, a step timeline, runner settings, and Issue cards that each name one fix (runner stopped, loopback off, offline, location denied, approval ran out, Live Activity off).
- Approvals: the Live Activity pops up by itself (Live Activity thread). If it isn't running, a notification says to open Poki.
- Runner: the idle stop default is now 2 min, so long tasks keep the banner. Every restart request is logged with whether the runner answered. Stop checks 8 s later that the runner really ended, and says so if not.
- Runner screens: PokiRunnerHost draws a designed screen as soon as the scene is up, both in use and opened by hand, so it is never black. Opened by hand, it opens Poki after 1.2 s.
- Scrolling: the loopback check no longer redraws the screens every 3 s.
- Debug: Copy log and Share log (AppLog; it never holds what is typed into password fields).
- Merged dev/ios-core db52fe9 (WeChat Send hit-test; approval time no longer eats the actions' time).

Needs the phone:
- No flicker of the automation banner during a long task, and Stop ends it within a few seconds.
- The approval pop-up and its notification; Allow and Deny from the Lock Screen.
- Opening Poki Runner by hand shows its screen, then Poki.
- Scrolling on Home stays smooth while Poki is on.

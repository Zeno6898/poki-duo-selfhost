# Poki iPhone app: changes per round

What changed in each round, and what still needs the phone. Newest first.

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

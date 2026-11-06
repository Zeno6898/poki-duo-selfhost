# What still needs the real phone

PokiCore's look/do is tested three ways: Linux and macOS unit tests against a fake WebDriverAgent
(fault injection included), and `poki-sim-check` against the real WebDriverAgent in the iOS
Simulator (CI job `simulator`). These are the parts only an iPhone can confirm.

| What | Why the simulator cannot settle it | How to check on the phone |
|---|---|---|
| `animationCoolOffTimeout` 0 / `waitForIdleTimeout` 0.5 make drags fast in apps that never stop animating | The simulator has no X or WeChat, and its timing differs | In X, `drag` and `swipe` take well under 1 s each and never time out |
| Swipes land on the list, not the reply or input bar, in X and WeChat | Their trees are not in the simulator | `swipe up` in an X reply thread and a WeChat chat: `screen_changed: true` |
| Hit-test: a visible control inside an input bar or keyboard is hittable; a post under X's reply bar is `not_hittable` | Needs those apps' trees | Tap WeChat's Send by number; tap a post under X's reply bar by number |
| Vision OCR inside `[collapsed]` cells on `full=true`, and of the whole screen when the tree is late | Tested on macOS with rendered text, not on an iPhone screenshot | `look full=true` in an X thread lists the like and reply counts as `Text` elements |
| `via: "paste"`: the edit menu's Paste item is found and tapped, and the owner's clipboard comes back | WDA's pasteboard on a device may need the runner in front (iOS privacy rules) | Copy something, `type` with `via: "paste"` into Notes, then check the clipboard still holds it |
| `/wda/locked` on a locked phone | The simulator is never locked by a passcode | Lock the phone, call `do`: `screen: locked`, nothing sent |
| Approval: the action runs after the owner approves late in the wait | The Live Activity's buttons are the app's | Ask for a deletion, approve after ~15 s: the action is sent and the read follows |
| Typing CJK through `/wda/keys` on the phone's keyboard | The simulator's keyboard is not the phone's (third-party keyboards, input methods) | Type `你好 Poki 123` into WeChat: the reply's `the field now reads` matches |

# Tool behavior and conventions

**Poki MCP** is a local macOS MCP server that lets AI clients inspect and control an iPhone or iOS Simulator. By default it lists the tools for phone tasks, and it can expose a complete catalog for screenshots, accessibility and Vision OCR inspection, touch and keyboard input, application management, screen recording, and diagnostics.

- **Screen & UI Inspection**: Capture screenshots (`take_screenshot`, `save_screenshot`) and inspect UI hierarchies via Accessibility or Vision OCR (`list_elements`).
- **Touch & Keyboard Input**: Send taps, swipes, hardware keys, and Unicode text across simulators and paired physical devices.
- **App & Device Lifecycle**: Manage applications, open URLs, inspect containers, record video, and run diagnostic checks.
- **Local Daemon Architecture**: Runs a localhost-only service (`127.0.0.1:47825`) with serialized device execution, per-client session isolation, and interactive local approval gates for sensitive actions.

Tool names and input validation schemas live in [`src/data/tools.json`](../src/data/tools.json) and are served via MCP `tools/list`. `poki_mcp_status` returns the selected device, available device count, approval mode, and separate counts for device, observation, management, and total tools.

## MCP tool profiles

The default `tools/list` response contains the tools for phone tasks. Tool names, arguments, and execution behavior are unchanged.

| Use | Default tools |
| --- | --- |
| Service and devices | `poki_mcp_status`, `list_devices`, `select_device` |
| Read the screen | `list_elements`, `take_screenshot`, `get_foreground_app` |
| Apps and URLs | `list_apps`, `launch_app`, `terminate_app`, `open_url` |
| Touch and input | `tap`, `tap_text`, `long_press`, `double_tap`, `drag`, `pinch`, `fill`, `type_text`, `scroll`, `scroll_to`, `swipe`, `press_key`, `go_back`, `hide_keyboard`, `press_button`, `get_clipboard` |
| Wait, prompts, and batches | `wait_for`, `handle_alert`, `batch_commands` |

The runtime default list is defined in `src/tools.mjs`. The complete catalog includes simulator management, app installation, recording, location, appearance, and device leases.

### Complete catalog

`POKI_MCP_TOOLS=all` makes `tools/list` return the complete catalog. Any other value, including an unset or empty value, selects the default list.

For a stdio client, the variable belongs to the MCP process environment. This client configuration enables the complete catalog:

```json
{
  "mcpServers": {
    "poki": {
      "command": "node",
      "args": ["/absolute/path/to/poki-mcp/src/stdio.mjs"],
      "env": {
        "POKI_MCP_TOOLS": "all"
      }
    }
  }
}
```

The client needs to reconnect after a configuration change. Each stdio client has its own profile, independent of the daemon's profile.

Direct HTTP clients receive the daemon's profile. Starting the daemon with `POKI_MCP_TOOLS=all npm start` enables the complete catalog for those clients.

### Calls and device selection

Profiles affect discovery only. Every tool remains callable by name through `tools/call`, including tools absent from `tools/list`. The same applies to steps inside `batch_commands`. Argument validation, approvals, cancellation, and device arbitration still apply.

Consecutive device calls do not require `acquire_device`. With one available device, calls select it automatically. With multiple devices, `list_devices` and `select_device` identify the target. An explicit lease remains available for sessions that need exclusive access across several calls. Another session's lease can still block access.

Poki Agent starts its own stdio process with `POKI_MCP_TOOLS=all`. Its existing tool allowlist determines which tools reach its model.

## Ask in plain language

Ask your agent for the task you want done:

```text
Start an iPhone simulator, open Settings, and tell me the iOS version.
```

Three tools handle most interactions:

- `batch_commands` runs a known multi-step task in a single call and returns the visible on-screen text at the end, saving a screenshot round trip.
- `fill` focuses an input field, replaces its text, and verifies the new value.
- `tap_text` waits up to five seconds for its target to appear. If the target is not found, it aborts without tapping and returns what is currently on screen.

Installing apps, opening URLs, and reading the clipboard trigger a macOS approval dialog on your Mac. See [Approval & Clipboard Behavior](#approval--clipboard-behavior).

## All MCP tools

| Group | Tool | What it does |
| --- | --- | --- |
| Devices | `list_devices` | Find attached iOS devices and booted or previously used simulators. |
| Devices | `start_simulator` | Boot an existing simulator by id or name, or create one from an available model. |
| Devices | `shut_down_simulator` | Shut down the selected simulator. |
| Devices | `select_device` | Select one connected device by id or unambiguous name for this MCP session. |
| Devices | `get_device_info` | Read device identity, capture dimensions in logical points, and optionally platform settings. |
| Devices | `poki_mcp_status` | Report tool counts, connected-device count, selected device, and approval mode. |
| Coordination | `acquire_device` | Exclusively occupy one device across tool calls in this MCP session. |
| Coordination | `renew_device` | Extend this session’s active device lease by 1–600 seconds (default 120). |
| Coordination | `release_device` | Release this session’s device lease after cancelling accepted work and awaiting recording/location cleanup. |
| Coordination | `cancel_device` | Stop all previously accepted work and background recording/location in this MCP session, including calls without a lease. |
| Screen | `observe_device` | Capture one image with its structured observation, non-reused element references and prompt check. |
| Screen | `take_screenshot` | Capture the current display and return a JPEG image with screen dimensions and a prompt warning check. |
| Screen | `save_screenshot` | Save a full-resolution screenshot to an absolute PNG or JPEG path or directory. |
| Screen | `start_recording` | Start recording the selected device display to an H.264 movie. |
| Screen | `stop_recording` | Finalize the session recording and inspect the saved movie before returning its path and media details. |
| Screen | `get_foreground_app` | Read the current foreground application from accessibility services. |
| Screen | `list_elements` | Read accessibility elements, or OCR when auto mode cannot use accessibility. |
| Screen | `wait_for` | Poll visible text until it appears, or disappears when gone=true. |
| Screen | `wait` | Pause for seconds without interacting with a device. |
| Touch | `tap` | Tap at x/y in screen points or at the center of a current element ref. |
| Touch | `tap_text` | Find one visible element matching text, waiting up to five seconds for it to appear and hold still, trying OCR when needed, and tap it. |
| Touch | `double_tap` | Send two taps at x/y in logical screen points or at a current element ref. |
| Touch | `long_press` | Hold one touch at x/y or an element ref. |
| Touch | `swipe` | Move a touch from from_x/from_y to to_x/to_y in logical screen points. |
| Touch | `scroll` | Scroll up, down, left, or right around x/y, or the screen center when omitted. |
| Touch | `scroll_to` | Search for visible text and scroll until it is found, content stops changing, or max_scrolls is reached. |
| Touch | `drag` | Hold a touch, then move between the supplied logical-point endpoints. |
| Touch | `pinch` | Perform a two-finger gesture centered at x/y in screen points. |
| Text and keys | `fill` | Focus a field by ref, coordinates, or matching field label/placeholder/value/identifier, replace its text, and optionally submit after text verification. |
| Text and keys | `type_text` | Enter text into the focused field, optionally clearing it first and sending Return after verification. |
| Text and keys | `press_key` | Send a named keyboard key with optional modifiers and count (default one). |
| Text and keys | `hide_keyboard` | Detect a visible keyboard, send its toggle event, and verify dismissal. |
| Text and keys | `get_clipboard` | Read clipboard contents supported by the platform. |
| Text and keys | `set_clipboard` | Replace the selected device clipboard with text. |
| System | `press_button` | Send a hardware-style button event such as Home, lock, volume, mute, or Siri. |
| System | `system_gesture` | Send the requested system navigation gesture. |
| System | `go_back` | Tap a uniquely identified back control when available, otherwise swipe from the left edge. |
| System | `rotate` | Request a display orientation and invalidate cached coordinates. |
| System | `set_appearance` | Request light or dark appearance through the selected platform adapter. |
| System | `set_accessibility` | Change supported text-size or accessibility display settings. |
| System | `set_location` | Start a simulated latitude/longitude for the selected device. |
| System | `clear_location` | Stop the location simulation owned by this service for the selected device. |
| System | `handle_alert` | Choose a visible alert button by text or accept/dismiss action, waiting up to five seconds for it to appear. |
| System | `request_human_action` | Ask the user to complete a step on the device: a dialog on macOS, an MCP elicitation on other hosts. |
| Apps | `list_apps` | List installed applications, excluding system apps unless include_system=true. |
| Apps | `launch_app` | Launch an application by bundle_id or unambiguous name. |
| Apps | `terminate_app` | Stop an application identified by bundle_id on the selected device. |
| Apps | `install_app` | Install an application from a local path. |
| Apps | `uninstall_app` | Remove an installed application identified by bundle_id. |
| Apps | `open_settings` | Open a supported Settings page or an application settings page. |
| Apps | `open_url` | Ask the selected device to open a URL. |
| Apps | `build_and_run` | Build an Xcode project or workspace from project_path, install the result, and launch it. |
| Apps | `download_app_container` | Copy an accessible application container to a local destination, or the service state directory by default. |
| Apps | `list_crashes` | List available reports, optionally filtering by process name or bundle identifier and kind. |
| Apps | `get_crash` | Read a report by path from list_crashes, or find the newest report for process. |
| Batches | `batch_commands` | Do a whole known task in one call: launch the app, tap, fill, scroll, go back and answer alerts, each {tool, arguments}. |

## Agent skills

[Unlock an iPhone](../agent/skills/iphone-unlock/SKILL.md) packages an authorized passcode workflow, a calibrated portrait keypad, and a native helper that keeps one connection open for the entire input sequence. Poki Agent loads this skill and exposes the host-side `unlock_device` tool when the user has configured a passcode locally. It requires Poki device ownership; it does not add an MCP tool. The skill documents the physical-device evidence and supported layout.

## Coordinates, Screenshots, and Recordings

- All coordinates and element frames use **logical screen points**.
- `take_screenshot` returns JPEG data. Passing `max_width` scales the returned image without changing logical interaction coordinates.
- `save_screenshot` writes a full-resolution PNG or JPEG based on the file extension.
- The `lossless` parameter does not alter either screenshot rule.
- On a simulator, the screen's rounded corners and Dynamic Island area are black in screenshots. Without this mask, that area differs between frames of a still screen, which would expire element refs.
- Default output directories:
  - Screenshots: `~/Pictures/Poki MCP`
  - Recordings: `~/Movies/Poki MCP`

## Element Inspection & Delivery Flags

- `list_elements` prefers Accessibility in `auto` mode and falls back to Vision OCR when Accessibility cannot be read. Every response reports which source was used.
- Element `ref` identifiers are never reassigned within an MCP session. They expire after known input, a device change, a newly captured image showing a change, or **30 seconds**. Input and image changes observed by another session in the same daemon also invalidate the old observation. Re-fetch elements before acting on stale refs. Poki cannot detect an external touch or controller change until it observes that change; it does not continuously watch the display.
- In action responses, `sent=true` means the touch or key report was written to the connection. It does not mean the device acted on it. The device does not acknowledge reports, and a dropped report returns no error.
- A standalone action reads the screen back after it runs. `screen` lists the foreground app and visible text. When `screen_change_verified=true`, `screen_changed` indicates whether the accessibility output changed. This covers elements, text, values, positions, and selected, enabled, or focused states. `false` means no change was observed. It does not prove the action failed. The effect might not be exposed to accessibility, such as a canvas update, or might not have appeared yet. `true` does not prove the action caused the change, because another element may have updated at the same time. `screen_change_verified=false` means the before and after states could not be compared, such as in an app with no accessibility elements. In that case, inspect the screen directly.

## Device ownership and stopping work

Consecutive calls do not require a lease. For exclusive ownership across several calls, call `acquire_device` with an explicit device ID or unambiguous name. Acquisition resolves the device without booting it and returns `lease_id`, `device`, `state` and `expires_at`. Each session can hold one device lease. While holding it, release before switching to another device. Acquisition is serialized with ordinary operations; renewal, release and cancellation bypass that queue.

- `acquire_device({device, ttl_seconds?})`: default TTL 120 seconds, allowed integer range 1–600 seconds. Another session cannot acquire, observe or operate this device during the lease. Selection, aliases, automatic selection, batch steps and existing simulator startup all pass through the same device check. Creating a new simulator reserves its creation operation before running it; an existing lease must be released first.
- `renew_device({lease_id, ttl_seconds?})`: extend the matching session's active lease from the current time. Long operations do not renew automatically. Renew before expiry, including while a long tool is running.
- `release_device({lease_id})`: invalidate accepted work, stop recording and simulated location owned by this session, await cleanup, then make the device available. A lease stays `releasing` until cleanup finishes.
- `cancel_device({lease_id?})`: stop **all previously accepted work in this MCP session**, including queued calls made without a lease, and stop its background recording/location. If supplied, `lease_id` must match this session's active lease. Other sessions are unaffected. New work may be submitted after cleanup finishes; an old queued operation never resumes as an unleased operation.

The stop result identifies its scope, reason and cleanup outcomes. Cancellation stops owned local processes and waits; it cannot undo input already dispatched to the device. Inspect the screen before retrying an unknown outcome. The stdio bridge forwards SDK request cancellation to the corresponding daemon operation, including waits, device helpers and the local approval dialog. A normal HTTP response closing is not a session cancellation. Normal stdio EOF or termination requests session cleanup; a crashed client holding an explicit lease is bounded by its TTL. A client without a lease has no persistent ownership guarantee after an abnormal exit; use an explicit lease for recordings and multi-call tasks.

`list_devices` still reports discovery and occupancy (`occupied`, `owned_by_session`, `state`, `expires_at`) without exposing another session's task. Occupied physical devices are not queried for additional name/model information by other sessions. If an alias has not been discovered, use the displayed device ID. An unleased recording or location must be stopped by its owner before a different session can acquire that device.

This arbitration exists only in **one shared Poki daemon**. Different daemon instances and different `POKI_MCP_STATE_DIR` values are independent. It does not lock out other control software or a person touching the screen. Run one daemon for the clients that need to coordinate; do not start multiple daemons against the same endpoint directory. No persistent task database or recovery across daemon restarts is provided.

## Observations, deadlines and receipts

`observe_device` returns one PNG plus structured elements and a prompt check. Its observation records a unique ID, device, point dimensions, capture start/end, structure completion time and AX/OCR source. AX and image are collected sequentially and are explicitly **not atomic**. `list_elements`, `take_screenshot` and successful `wait_for` also identify the observation; successful `wait_for` includes its matching image so the caller need not capture a different moment. OCR is reused for the same image when checking prompts or falling back after an AX miss, with no persistent vision service.

`wait_for` uses a monotonic deadline covering capture, AX, OCR and polling. It starts no new read after that deadline, aborts in-flight external work and waits for owned processes to close. Consequently response delivery can include bounded process termination time after the deadline; the deadline is not a claim that the HTTP response arrives at the exact requested millisecond.

Input receipts retain `sent`, `text_verified`, `submit_sent` and other confirmed facts when recording recovery fails. The separate `recording` object reports recovery failure. Unconfirmed delivery remains `outcome: "unknown"`; it is never automatically replayed. Automatic recovery is suspended while native input intentionally interrupts the media stream. Normal reconnection after an explicit input is counted as `input_reconnects` and does not consume the automatic retry budget, so healthy multi-step recording is not limited to three inputs. Only background recovery from unexpected stream disconnects consumes `automatic_retries`, at most three per recording lifetime. Each reconnect still has a five-second first-frame deadline. `reconnects` is the total of these two counters. A failed reconnect leaves an explicit error; stop/start a recording to begin a new automatic budget. Stop, release, cancellation and session cleanup disable retries and await owned recording processes, and cleanup reports finalization errors separately.

Batch results retain the executed prefix and each step's `elapsed_ms`, then report `stop_reason`. A step's `device` applies to that step alone; steps without one use the session selection, and the screen read after the last step comes from the device that step used. Human handoff, cancellation, expiry, timeout and unknown input outcomes always stop subsequent steps even with `stop_on_error=false`. A successful action's receipt remains present if stopping occurs later. A detected human-only prompt in `handle_alert`, `take_screenshot`, `observe_device` or the screen read after the last step sets the same `needs_human_action` stop reason; observation tools retain their captured image and structure. With the default `stop_on_error`, every step is checked before any runs, so a mistyped step costs nothing. The last block carries `screen`, and after a stop also `failed_step`, `remaining_steps` and `next`, so the following call can fix one step and send only what is left.

Tool responses include `_meta.timing.stages` with queue, capture, AX, OCR, input, recording recovery and external-process durations where exercised. Each stage has an ID and parent ID. Parent durations include their children, so do not add parents and children. External-process time includes helper startup, connection and work inside the helper; those internal costs are not separately measured. Timing metadata contains no input text, device identifiers or image content, and it does not measure model reasoning or client round-trip time. No end-to-end speed multiplier is claimed.

## Efficient short workflows

- **Put the whole known task in one batch:** When the request already names what to do, send `launch_app` and every step in one `batch_commands` call. `launch_app` on a simulator returns once the interface is readable; `tap_text`, `fill` and `handle_alert` wait up to five seconds for their target to appear and hold still, so a batch can cross screens; the reply ends with the visible text, so a closing `take_screenshot` is only needed for pixels. Leave out a step when whether to do it depends on what an earlier step shows, or when it needs the user's decision. A wrong target stops the batch without tapping and reports the closest text on screen. Each step result reports `elapsed_ms`, which reflects server-side execution time only and excludes model reasoning and client round-trip overhead.
- **Use `fill` for known input fields:** Call `fill` directly instead of chaining `tap` and `type_text`; `field` can be left out when one text field is visible. On physical devices, `fill` focuses, replaces, and verifies text within a single native input session to avoid an extra connection wait. On simulators it taps, waits for focus and types, and a verified mismatch is an error. Plain text typed on a simulator first switches its keyboard to `en_US` (`simctl keyboard`), because a simulator created on a Chinese Mac types through Pinyin and rewrites Latin text and punctuation; the setting stays on that simulator. Because `fill` replaces existing field content, review your draft beforehand; reserve `type_text` for appending to an already-focused field.
- **Review and submit with `return`:** To inspect text before sending, `fill` and read the `screen` it returns. After verifying the draft, submit using `press_key` with `return` and inspect the resulting screen. Do not re-enter the full text or call `type_text` with an empty string to submit. Note that `text_verified` only confirms text entry into the field and `sent` only confirms the action was dispatched; neither guarantees application-level delivery.
- **Handle `CoreDeviceError` 4016 via observed UI:** If launching an app fails with `CoreDeviceError` 4016, inspect the current screen and continue through an observed Home Screen or App Switcher entry point. Do not repeatedly retry the same launch path unless device conditions change. This serves as invocation guidance and does not permanently mark the app as unavailable after a single failure.

## Approval & Clipboard Behavior

- **Local approval dialog**: Installing or uninstalling apps, building and running projects, opening URLs, downloading app containers, and reading or writing the clipboard trigger a local macOS approval dialog by default. On other hosts the approval is asked through MCP elicitation when the client supports it; when nobody can be asked, the action is not run and the reply says so.
- Setting `POKI_MCP_APPROVAL_MODE=allow` bypasses this local daemon prompt for preapproved workflows, but it **never** auto-completes iOS/macOS system authorization dialogs or makes `request_human_action` succeed automatically.
- **Unicode paste & clipboard restoration**:
  - Unicode text entry may use the device clipboard. On physical devices, Poki MCP attempts to save and restore a complete clipboard snapshot; if full restoration is not possible, the response explicitly reports restoration as unavailable.
  - The snapshot is held only in memory for the duration of that single operation and cannot be restored by a subsequent tool call after a human handoff.
  - If a paste prompt is pending or the target field cannot be verified, automatic submission stops and leaves the intended text on the clipboard.
  - Poki MCP **never** auto-accepts an iOS **Allow Paste** prompt. Note that a true first-time **Allow Paste** human-handoff flow remains unverified on hardware (prior successful paste checks did not trigger the system prompt).

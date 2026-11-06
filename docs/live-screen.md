# Live screen (fork-only, `dev/live-agent`)

Turn it on with `POKI_BRIDGE_DAEMON=1 POKI_LIVE_FRAMES=1` on a physical device. poki-bridged then
keeps the phone's screen video open and decodes it in-process (`native/bridge/src/bin/poki-bridged/live.rs`,
`frames.rs`, `libav.rs`; libavcodec and libswscale come from the system ffmpeg package). The daemon
uses it through `src/live-frames.mjs`:

| Call | Answer |
|---|---|
| `latestFrame({ maxWidth })` | newest picture as JPEG (`rgb` on request), `width`, `height`, `capturedAt`, `ageMs`, `settled`, `quietMs`, `changedSinceInput` |
| `waitSettled({ timeoutMs, settleMs })` | the first settled picture from now, plus `waitedMs` |
| `frameDiff(a, b)` | `{ changed, score, bbox }` between two moments (ms ago) or two frames |
| `health({ seconds })` | `{ ok, fps, lastFrameAt }` |

What changes in the tools when it is on:

- **Screenshots** come from the newest decoded picture, scaled to points, and carry the time it
  arrived (`capture_started_at` is the picture's arrival; `source: "live"`). The first screenshot of a
  session is still an ordinary one, because it gives the point size.
- **Settling after an input** waits for poki-bridged to see the picture stop changing
  (`wait_settled`), up to `POKI_LIVE_SETTLE_TIMEOUT_MS` (4000), instead of a fixed 600 ms.
- **Change detection** after a touch comes from the pictures (`screen_change_source: "pixels"`).
  No accessibility tree is read before the action. When the pictures changed but the tree still
  matches the old screen, the result says `accessibility_lagging: true` and its screen text is read
  off the new picture with OCR.
- **poki_mcp_status** includes `live_frames` (decode health and rate).

Nothing here is tuned to a particular app or task.

## Tested and untested

Tested on us-light without the phone: the client's request and answer mapping
(`test/live-frames.test.mjs`) and the full suite with the feature off. Not yet tested against the
phone (it was offline while this was written): picture latency and settle timing on real video,
the screenshot path's scaling against the real video size, the pixel verdict against real taps,
the OCR fallback on lagging trees, and orientation changes (the point size is not re-read when the
phone rotates).

The bridge's `subscribe_frames` event feed (05d9f82) is not used yet; the client polls
`wait_settled` and `latest_frame`.

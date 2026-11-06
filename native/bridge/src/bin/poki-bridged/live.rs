//! The live-screen ops (workstream J1, fork-only), with `POKI_LIVE_FRAMES=1`.
//!
//! The daemon then opens the media session as soon as it can and keeps it open: idle times do not
//! close it, and when an error closes it, the reaper opens it again. Its video is decoded all the
//! time (see frames.rs). These ops hold the session only to find the stream, so they answer while
//! another op runs:
//!
//! ```text
//! {"op":"latest_frame","max_width":600,"quality":5}      the newest picture, as base64 JPEG
//! {"op":"latest_frame","path":"/tmp/screen.jpg"}           ... written to a file instead
//! {"op":"wait_settled","timeout_ms":3000}                  the first settled picture from now
//! {"op":"frame_diff","a_ms_ago":1000,"b_ms_ago":0}         how the screen changed between two moments
//! {"op":"frames","seconds":10}                             stream, decode and CPU figures
//! {"op":"subscribe_frames"}                                this connection becomes an event feed
//! ```
//!
//! The feed is one JSON object per line. Times are UTC (2026-11-06T03:27:28.123Z); regions are
//! [x, y, width, height] as fractions of the screen. After the acknowledgement
//! `{"id":..,"ok":true,"event":"subscribed","settle_ms":150}` every event has `seq` (from 1) and
//! `at` (when it was sent). `epoch` is a picture number: it grows by one per decoded picture, across
//! media sessions, so comparing epochs tells which came first:
//!
//! - `media` {state: open | closed | unavailable, error?}: the stream started, ended (the media
//!   session closed) or cannot be opened; the feed follows the next session by itself.
//! - `input` {sent_at, epoch}: an input op ran; epoch is the latest picture number then.
//! - `changed` {epoch, captured_at, changed, changed_fraction, region}: a picture differs from the one
//!   before it.
//! - `settled` {epoch, captured_at, quiet_ms, size, since_last_settled?: {changed, changed_fraction,
//!   region}}: no change and no input for the settle time; sent once per quiet period.
//!
//! The client ends it by closing the connection.
//!
//! Every picture answer says when the picture arrived (`captured_at`, `age_ms`), whether the
//! screen is settled, how long it has been quiet, and whether it changed after the last input.
use super::*;
use crate::ax::watch::{stamp, stamp_at};
use crate::frames::{Live, settle_time};

pub fn enabled() -> bool {
    std::env::var("POKI_LIVE_FRAMES").as_deref() == Ok("1")
}

pub fn is_live_op(op: &str) -> bool {
    matches!(
        op,
        "latest_frame" | "wait_settled" | "frame_diff" | "frames"
    )
}

/// Opens the media session when it is not open and starts decoding; a view of the screen.
async fn live(state: &State, timings: &mut Timings) -> Result<Live> {
    let mut session = state.session.lock().await;
    session.last_used = Instant::now();
    if let Err(error) = Box::pin(session.prepare_input_or_retry(false, timings)).await {
        session.reset().await;
        return Err(error);
    }
    let live = session.input.as_ref().expect("open").frames.live();
    live.decode();
    match live.error() {
        Some(error) => Err(error.into()),
        None => Ok(live),
    }
}

pub async fn answer(
    op: &str,
    id: Value,
    object: Map<String, Value>,
    state: &State,
    mut closed: watch::Receiver<bool>,
) -> Option<Value> {
    let started = Instant::now();
    let mut timings = Timings::default();
    let work = async {
        let live = live(state, &mut timings).await?;
        match op {
            "latest_frame" => {
                let wait = number(&object, "wait_ms", 3000);
                picture(&live, &object, wait).await
            }
            "wait_settled" => {
                let timeout = Duration::from_millis(number(&object, "timeout_ms", 3000));
                let settle = object
                    .get("settle_ms")
                    .and_then(Value::as_u64)
                    .map_or_else(settle_time, Duration::from_millis);
                let waiting = Instant::now();
                let settled = live.wait_settled(settle, timeout).await;
                let mut answer = picture(&live, &object, 0).await?;
                answer["settled"] = settled.into();
                answer["waited_ms"] = ms(waiting).into();
                Ok(answer)
            }
            "frame_diff" => {
                let a = Duration::from_millis(number(&object, "a_ms_ago", 1000));
                let b = Duration::from_millis(number(&object, "b_ms_ago", 0));
                let (difference, a_at, b_at) = live.diff(a, b).ok_or("no picture decoded yet")?;
                let mut answer = difference.json();
                answer["a_at"] = stamp_at(a_at).into();
                answer["b_at"] = stamp_at(b_at).into();
                Ok(answer)
            }
            _ => {
                let seconds = object
                    .get("seconds")
                    .and_then(Value::as_f64)
                    .unwrap_or(10.0)
                    .clamp(0.0, 120.0);
                let mark = live.mark();
                tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
                let report = live.report(&mark);
                log(&format!("frames: {report}"));
                Ok(report)
            }
        }
    };
    let result: Result<Value> = tokio::select! {
        result = work => result,
        _ = closed.wait_for(|closed| *closed) => return None,
    };
    timings.total_ms = ms(started);
    if op != "latest_frame" {
        log(&format!(
            "{op}: {} in {} ms",
            if result.is_ok() { "ok" } else { "error" },
            timings.total_ms
        ));
    }
    Some(match result {
        Ok(output) => success(id, &output, timings),
        Err(error) => failure(id, &*error, timings),
    })
}

pub fn is_subscribe(line: &str) -> bool {
    split(line).is_ok_and(|(_, op, _)| op == "subscribe_frames")
}

/// Writes the event feed for `subscribe_frames` until the client leaves. When the media session
/// closes, the feed says so and follows the next one.
pub async fn subscribe(
    line: &str,
    state: &State,
    mut closed: watch::Receiver<bool>,
    write: &mut tokio::net::unix::OwnedWriteHalf,
) {
    let Ok((id, _, object)) = split(line) else {
        return;
    };
    let settle = object
        .get("settle_ms")
        .and_then(Value::as_u64)
        .map_or_else(settle_time, Duration::from_millis);
    let ack = json!({"id": id, "ok": true, "event": "subscribed", "settle_ms": settle.as_millis() as u64});
    if send(write, &ack).await.is_err() {
        return;
    }
    log("subscribe_frames: feed open");
    let mut seq = 0u64;
    let mut emit = async |write: &mut tokio::net::unix::OwnedWriteHalf, mut event: Value| {
        seq += 1;
        event["seq"] = seq.into();
        if event.get("at").is_none() {
            event["at"] = stamp().into();
        }
        send(write, &event).await
    };
    loop {
        // Find the stream, opening the media session when needed.
        let mut timings = Timings::default();
        let live = tokio::select! {
            found = live(state, &mut timings) => found,
            _ = closed.wait_for(|closed| *closed) => return,
        };
        let live = match live {
            Ok(live) => live,
            Err(error) => {
                let event =
                    json!({"event": "media", "state": "unavailable", "error": error.to_string()});
                if emit(write, event).await.is_err() {
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(REOPEN_AFTER) => continue,
                    _ = closed.wait_for(|closed| *closed) => return,
                }
            }
        };
        if emit(write, json!({"event": "media", "state": "open"}))
            .await
            .is_err()
        {
            return;
        }
        let mut watcher = live.watcher();
        let start = live.state(settle);
        let (mut change_seen, mut input_seen) = (start.last_change.map(|c| c.0), start.last_input);
        let mut settled_for = start.settled.then_some(start.quiet_since);
        let mut last_settled_at: Option<Instant> = start.settled.then(Instant::now);
        loop {
            watcher.mark_unchanged();
            let now = live.state(settle);
            let mut events = Vec::new();
            if now.last_input.is_some() && now.last_input != input_seen {
                input_seen = now.last_input;
                events.push(json!({
                    "event": "input",
                    "sent_at": now.last_input_wall.map(stamp_at),
                    "epoch": now.last_input_epoch,
                }));
            }
            if let Some((at, difference)) = now.last_change
                && change_seen != Some(at)
            {
                change_seen = Some(at);
                let mut event = difference.json();
                event["event"] = "changed".into();
                event["captured_at"] = now.last_change_wall.map(stamp_at).into();
                event["epoch"] = now.last_change_epoch.into();
                events.push(event);
            }
            if now.settled && settled_for != Some(now.quiet_since) {
                settled_for = Some(now.quiet_since);
                let mut event = json!({
                    "event": "settled",
                    "quiet_ms": now.quiet_since.map(|at| at.elapsed().as_millis() as u64),
                    "captured_at": now.latest.map(|l| stamp_at(l.1)),
                    "size": now.latest.map(|l| [l.2, l.3]),
                    "epoch": now.epoch,
                });
                if let Some(previous) = last_settled_at
                    && let Some((difference, _, _)) = live.diff(previous.elapsed(), Duration::ZERO)
                {
                    event["since_last_settled"] = difference.json();
                }
                last_settled_at = Some(Instant::now());
                events.push(event);
            }
            if now.closed {
                events.push(json!({"event": "media", "state": "closed"}));
            }
            for event in events {
                if emit(write, event).await.is_err() {
                    return;
                }
            }
            if now.closed {
                break;
            }
            let heartbeat = tokio::time::Instant::now() + Duration::from_secs(30);
            let wake = now
                .quiet_since
                .filter(|_| !now.settled)
                .map_or(heartbeat, |at| tokio::time::Instant::from_std(at + settle))
                .min(heartbeat);
            tokio::select! {
                _ = watcher.changed() => {},
                _ = tokio::time::sleep_until(wake) => {},
                _ = closed.wait_for(|closed| *closed) => {
                    log("subscribe_frames: feed closed");
                    return;
                }
            }
        }
        // Give the reaper or the next op a moment to open a new session.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            _ = closed.wait_for(|closed| *closed) => return,
        }
    }
}

async fn send(write: &mut tokio::net::unix::OwnedWriteHalf, value: &Value) -> std::io::Result<()> {
    let mut bytes = value.to_string().into_bytes();
    bytes.push(b'\n');
    write.write_all(&bytes).await
}

fn number(object: &Map<String, Value>, key: &str, default: u64) -> u64 {
    object.get(key).and_then(Value::as_u64).unwrap_or(default)
}

/// The newest picture and what the screen is doing, waiting up to `wait_ms` for a first picture.
async fn picture(live: &Live, object: &Map<String, Value>, wait_ms: u64) -> Result<Value> {
    let settle = settle_time();
    if live.state(settle).latest.is_none() {
        let since = Instant::now() - Duration::from_secs(3600);
        live.wait_picture_after(since, Duration::from_millis(wait_ms.max(1)))
            .await;
    }
    let width = number(object, "max_width", 600).clamp(64, 4096) as u32;
    let quality = number(object, "quality", 5).clamp(2, 31) as u32;
    let jpeg = live.jpeg(width, quality).await?;
    let state = live.state(settle);
    let ago = |at: Instant| at.elapsed().as_millis() as u64;
    let mut answer = json!({
        "captured_at": stamp_at(jpeg.wall),
        "age_ms": ago(jpeg.arrived),
        "width": jpeg.width,
        "height": jpeg.height,
        "bytes": jpeg.bytes.len(),
        "encode_ms": (jpeg.encode_ms * 10.0).round() / 10.0,
        "settled": state.settled,
        "quiet_ms": state.quiet_since.map(ago),
        "epoch": jpeg.epoch,
        "latest_epoch": state.epoch,
        "last_input_epoch": state.last_input_epoch,
        "last_change": state.last_change.map(|(at, difference)| {
            let mut change = difference.json();
            change["ms_ago"] = ago(at).into();
            change["epoch"] = state.last_change_epoch.into();
            change
        }),
        "last_input_ms_ago": state.last_input.map(ago),
        "changed_since_input": state.last_input.map(|input| state.last_change.is_some_and(|(at, _)| at > input)),
        "picture_after_input": state.last_input.map(|input| jpeg.arrived > input),
        "screen_change_verified": false,
    });
    match object.get("path").and_then(Value::as_str) {
        Some(path) => {
            std::fs::write(path, &jpeg.bytes)?;
            answer["path"] = path.into();
        }
        None => answer["jpeg_base64"] = base64(&jpeg.bytes).into(),
    }
    Ok(answer)
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// With live frames on, the reaper keeps the media session open; how long to wait between tries.
pub const REOPEN_AFTER: Duration = Duration::from_secs(3);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xd8, 0xff, 0xe0]), "/9j/4A==");
    }
}

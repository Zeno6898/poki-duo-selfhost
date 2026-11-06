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
//! ```
//!
//! Every picture answer says when the picture arrived (`captured_at`, `age_ms`), whether the
//! screen is settled, how long it has been quiet, and whether it changed after the last input.
use super::*;
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
                answer["a_at"] = crate::ax::watch::stamp_at(a_at).into();
                answer["b_at"] = crate::ax::watch::stamp_at(b_at).into();
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
        "captured_at": crate::ax::watch::stamp_at(jpeg.wall),
        "age_ms": ago(jpeg.arrived),
        "width": jpeg.width,
        "height": jpeg.height,
        "bytes": jpeg.bytes.len(),
        "encode_ms": (jpeg.encode_ms * 10.0).round() / 10.0,
        "settled": state.settled,
        "quiet_ms": state.quiet_since.map(ago),
        "last_change": state.last_change.map(|(at, difference)| {
            let mut change = difference.json();
            change["ms_ago"] = ago(at).into();
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

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

/// POKI_LIVE_DECODE=off: the media session stays open (input needs it, and the packet clock
/// reads it) but nothing is decoded; every picture comes from the screenshot service. For
/// servers that cannot spare the decoder's CPU (over a core while the phone streams).
pub fn decode_off() -> bool {
    std::env::var("POKI_LIVE_DECODE").as_deref() == Ok("off")
}

pub fn is_live_op(op: &str) -> bool {
    matches!(
        op,
        "latest_frame" | "wait_settled" | "frame_diff" | "frames" | "ocr_region" | "ocr_frame"
    )
}

/// Opens the media session when it is not open and starts decoding; a view of the screen.
async fn live(state: &State, timings: &mut Timings) -> Result<Live> {
    let mut session = state.session.lock().await;
    session.last_used = Instant::now();
    session.restart_media_if_asked().await;
    if let Err(error) = Box::pin(session.prepare_input_or_retry(false, timings)).await {
        session.reset().await;
        return Err(error);
    }
    let live = session.input.as_ref().expect("open").frames.live();
    if !decode_off() {
        live.decode();
    }
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
        let live = match live(state, &mut timings).await {
            Ok(live) => live,
            // No media session: a picture can still come from the screenshot service.
            Err(error) if matches!(op, "latest_frame" | "wait_settled") => {
                log(&format!(
                    "{op}: media session not available ({error}); taking a screenshot"
                ));
                let mut answer = screenshot_picture(state, None, &object, "media_closed").await?;
                answer["foreground"] = foreground_json(state);
                return Ok(answer);
            }
            Err(error) => return Err(error),
        };
        match op {
            "latest_frame" => {
                let wait = number(&object, "wait_ms", 3000);
                let mut answer = picture(state, &live, &object, wait).await?;
                answer["tree"] = tree_summary(&state.prefetch, &live);
                answer["foreground"] = foreground_json(state);
                answer["device_state"] = state.device.borrow().json();
                Ok(answer)
            }
            "wait_settled" => {
                let timeout = Duration::from_millis(number(&object, "timeout_ms", 3000));
                let settle = object
                    .get("settle_ms")
                    .and_then(Value::as_u64)
                    .map_or_else(settle_time, Duration::from_millis);
                let waiting = Instant::now();
                let settled = live.wait_settled(settle, timeout).await;
                let mut answer = picture(state, &live, &object, 0).await?;
                answer["settled"] = settled.into();
                answer["waited_ms"] = ms(waiting).into();
                answer["tree"] = tree_summary(&state.prefetch, &live);
                answer["foreground"] = foreground_json(state);
                answer["device_state"] = state.device.borrow().json();
                Ok(answer)
            }
            "ocr_region" | "ocr_frame" => read_text(&live, op, &object).await,
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
    // The media session the feed is following, for every event.
    let generation = std::cell::Cell::new(None::<u64>);
    let mut emit = async |write: &mut tokio::net::unix::OwnedWriteHalf, mut event: Value| {
        seq += 1;
        event["seq"] = seq.into();
        if event.get("generation").is_none()
            && let Some(generation) = generation.get()
        {
            event["generation"] = generation.into();
        }
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
        generation.set(Some(live.state(settle).session));
        if emit(write, json!({"event": "media", "state": "open"}))
            .await
            .is_err()
        {
            return;
        }
        let mut watcher = live.watcher();
        let mut trees = state.prefetch_events.subscribe();
        trees.mark_unchanged();
        let start = live.state(settle);
        let (mut change_seen, mut input_seen) = (start.last_change.map(|c| c.0), start.last_input);
        let mut settled_for = start.settled.then_some(start.quiet_since);
        let mut moving = start.moving;
        let mut stalled = false;
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
            // The packet clock: the screen started moving (decoded or not).
            if now.moving && !moving {
                events.push(json!({
                    "event": "moving",
                    "captured_at": now.activity.map(|a| stamp_at(a.wall)),
                    "after_input_ms": now.last_input.zip(now.activity).and_then(|(input, a)| a.at.checked_duration_since(input)).map(|d| d.as_millis() as u64),
                    "epoch": now.epoch,
                }));
            }
            moving = now.moving;
            if now.settled && settled_for != Some(now.quiet_since) {
                settled_for = Some(now.quiet_since);
                let mut event = json!({
                    "event": "settled",
                    "quiet_ms": now.quiet_since.map(|at| at.elapsed().as_millis() as u64),
                    // Nothing moved since the input: the input changed nothing on screen.
                    "changed_since_input": now.changed_since_input,
                    "animating_region": crate::frames::animating_json(now.animating_region),
                    "captured_at": now.latest.map(|l| stamp_at(l.1)),
                    "size": now.latest.map(|l| [l.2, l.3]),
                    "epoch": now.epoch,
                    "frame": live.latest_identity(),
                });
                if let Some(previous) = last_settled_at
                    && let Some((difference, _, _)) = live.diff(previous.elapsed(), Duration::ZERO)
                {
                    event["since_last_settled"] = difference.json();
                }
                last_settled_at = Some(Instant::now());
                events.push(event);
            }
            if trees.has_changed().unwrap_or(false) {
                trees.mark_unchanged();
                if let Some(read) = state.prefetch.borrow().ready.as_ref() {
                    let mut event = read.provenance(&live);
                    event["event"] = "tree".into();
                    event["read_ms"] = read.read_ms.into();
                    event["epoch"] = live.state(settle).epoch.into();
                    events.push(event);
                }
            }
            if now.stalled_since.is_some() != stalled {
                stalled = now.stalled_since.is_some();
                events.push(json!({
                    "event": "video",
                    "state": if stalled { "stalled" } else { "flowing" },
                    "epoch": now.epoch,
                }));
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
                .settles_at
                .filter(|_| !now.settled)
                .map_or(heartbeat, tokio::time::Instant::from_std)
                .min(heartbeat);
            tokio::select! {
                _ = watcher.changed() => {},
                _ = trees.changed() => {},
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

/// `ocr_region {box: [x, y, w, h] fractions, epoch?}` and `ocr_frame {epoch?}`: the text in the
/// newest picture, read by the persistent OCR worker. With `epoch`, a picture at least that new is
/// awaited for up to a second; `epoch` in the answer is the picture read, and `epoch_matches` says
/// whether it is the one asked for (only the newest picture is kept).
async fn read_text(live: &Live, op: &str, object: &Map<String, Value>) -> Result<Value> {
    let region = match object.get("box") {
        None | Some(Value::Null) if op == "ocr_frame" => None,
        None | Some(Value::Null) => {
            return Err("ocr_region needs box: [x, y, w, h] as fractions".into());
        }
        Some(value) => {
            let numbers: Vec<f64> = value
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let [x, y, w, h] = numbers[..] else {
                return Err("box must be [x, y, w, h] as fractions of the screen".into());
            };
            if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) || w <= 0.0 || h <= 0.0 {
                return Err("box must be [x, y, w, h] as fractions of the screen".into());
            }
            Some([x, y, w.min(1.0 - x), h.min(1.0 - y)])
        }
    };
    let wanted = object.get("epoch").and_then(Value::as_u64);
    if let Some(wanted) = wanted {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut watcher = live.watcher();
        while live.state(settle_time()).epoch < wanted && Instant::now() < deadline {
            watcher.mark_unchanged();
            let _ = tokio::time::timeout_at(deadline.into(), watcher.changed()).await;
        }
    }
    if !crate::ocr::enabled() {
        return Err("OCR is off: start the daemon with POKI_LIVE_OCR=1".into());
    }
    let ocr = crate::ocr::shared();
    let started = Instant::now();
    let (reading, picture) = ocr.read_live(live, region, Duration::from_secs(5)).await?;
    let state = live.state(settle_time());
    Ok(json!({
        "text": reading.text(),
        "elements": reading.json(),
        "box": region,
        "epoch": picture.epoch,
        "frame": live.identity(picture.epoch, picture.wall, picture.width, picture.height),
        "epoch_matches": wanted.map(|wanted| wanted == picture.epoch),
        "latest_epoch": state.epoch,
        "captured_at": stamp_at(picture.wall),
        "size": [picture.width, picture.height],
        "settled": state.settled,
        "ocr_ms": reading.ms,
        "total_ms": started.elapsed().as_millis() as u64,
    }))
}

/// The foreground app: from the newest accessibility tree (an op's or the prefetch's), with its
/// bundle id from app_for_pid when the tree has none. Resolved in the background and cached by
/// pid, so ping and latest_frame never wait for it.
#[derive(Default)]
pub struct Foreground {
    pub(crate) noted: Option<(Instant, Value)>,
    pub(crate) known: std::collections::HashMap<u64, Value>,
    /// When the last input that may change the screen was sent.
    pub(crate) last_input: Option<Instant>,
    wanted: Option<u64>,
    failed: Option<(u64, Instant)>,
}

pub type ForegroundCell = Rc<std::cell::RefCell<Foreground>>;

thread_local! {
    static FOREGROUND_WANTED: Rc<tokio::sync::Notify> = Rc::new(tokio::sync::Notify::new());
}

/// Notes the foreground app of a tree an op read.
pub fn note_tree(cell: &ForegroundCell, tree: &Value) {
    if let Some(app) = tree.get("foreground_app").filter(|app| app.is_object()) {
        cell.borrow_mut().noted = Some((Instant::now(), app.clone()));
    }
}

/// {pid, bundle_id, name, seen_ms_ago, via} or null when no tree was read yet.
pub fn foreground_json(state: &State) -> Value {
    let prefetched = state.prefetch.borrow().ready.as_ref().and_then(|read| {
        read.tree
            .get("foreground_app")
            .filter(|app| app.is_object())
            .map(|app| (read.requested, app.clone()))
    });
    let mut f = state.foreground.borrow_mut();
    let Some((at, app)) = [f.noted.clone(), prefetched]
        .into_iter()
        .flatten()
        .max_by_key(|(at, _)| *at)
    else {
        return Value::Null;
    };
    let pid = app.get("pid").and_then(Value::as_u64);
    let mut answer = json!({
        "pid": pid,
        "bundle_id": app.get("bundle_id").cloned().unwrap_or(Value::Null),
        "name": app.get("name").cloned().unwrap_or(Value::Null),
        "seen_ms_ago": at.elapsed().as_millis() as u64,
        "via": "tree",
    });
    // Read before the last input: the foreground may have changed since (a fresh tree, e.g.
    // the AX prefetch at each settle, brings it up to date). The same answer in ping and
    // latest_frame: the input time is kept here, not read from the session.
    answer["stale"] = f.last_input.is_some_and(|input| at < input).into();
    if let Some(pid) = pid {
        if let Some(known) = f.known.get(&pid) {
            if answer["bundle_id"].is_null() {
                answer["bundle_id"] = known["bundle_id"].clone();
                answer["via"] = "app_for_pid".into();
            }
            if answer["name"].is_null() {
                answer["name"] = known["name"].clone();
            }
        } else if answer["bundle_id"].is_null() {
            let retry = f
                .failed
                .is_none_or(|(failed, at)| failed != pid || at.elapsed() > Duration::from_secs(10));
            if retry {
                f.wanted = Some(pid);
                FOREGROUND_WANTED.with(|wanted| wanted.notify_one());
            }
            answer["resolving"] = true.into();
        }
    }
    answer
}

/// Looks up the pids foreground_json asks for, one at a time, on the held tunnel.
pub async fn resolve_foreground(state: Rc<State>) {
    let wanted = FOREGROUND_WANTED.with(Rc::clone);
    loop {
        wanted.notified().await;
        let Some(pid) = state.foreground.borrow_mut().wanted.take() else {
            continue;
        };
        if state.foreground.borrow().known.contains_key(&pid) {
            continue;
        }
        let answer = async {
            let mut session = state.session.lock().await;
            session.connect(&mut Timings::default()).await?;
            let link = session.link.as_mut().expect("connected");
            apps::app_for_pid(&mut link.device.adapter, &mut link.device.rsd, pid as u32).await
        }
        .await;
        let mut f = state.foreground.borrow_mut();
        match answer {
            Ok(app) if app["running"] == true => {
                f.known.insert(pid, app);
            }
            Ok(_) => f.failed = Some((pid, Instant::now())),
            Err(error) => {
                log(&format!("foreground: app_for_pid {pid} failed: {error}"));
                f.failed = Some((pid, Instant::now()));
            }
        }
    }
}

/// Why the newest decoded picture should not be served, if it should not.
fn video_unusable(live: &Live) -> Option<&'static str> {
    if decode_off() {
        return Some("decode_off");
    }
    let state = live.state(settle_time());
    if state.stalled_since.is_some() {
        Some("video_stalled")
    } else if live.damaged() {
        Some("picture_damaged")
    } else if state.latest.is_none() {
        Some("no_picture")
    } else if !state.picture_current
        && state
            .latest
            .is_some_and(|l| l.0.elapsed() > Duration::from_secs(1))
    {
        Some("decode_backlog")
    } else {
        None
    }
}

/// One picture from the screenshot service on the held tunnel (about 0.8 s on an iPhone 17 Pro),
/// as a JPEG answer shaped like a video one, with source=screenshot and why it was taken.
async fn screenshot_picture(
    state: &State,
    live: Option<&Live>,
    object: &Map<String, Value>,
    reason: &str,
) -> Result<Value> {
    use idevice::dvt::{remote_server::RemoteServerClient, screenshot::ScreenshotClient};
    let width = number(object, "max_width", 600).clamp(64, 4096) as u32;
    let quality = number(object, "quality", 5).clamp(2, 31) as u32;
    let requested = Instant::now();
    let png = {
        let mut session = state.session.lock().await;
        session.last_used = Instant::now();
        let shot = async {
            session.connect(&mut Timings::default()).await?;
            let link = session.link.as_mut().expect("connected");
            let mut server =
                RemoteServerClient::connect_rsd(&mut link.device.adapter, &mut link.device.rsd)
                    .await?;
            server.read_message(0).await?;
            let png = ScreenshotClient::new(&mut server)
                .await?
                .take_screenshot()
                .await?;
            Ok::<Vec<u8>, Box<dyn std::error::Error + Send + Sync>>(png)
        }
        .await;
        match shot {
            Ok(png) => png,
            Err(error) => {
                session.recover().await;
                return Err(format!("screenshot failed: {error}").into());
            }
        }
    };
    let received = Instant::now();
    let wall = std::time::SystemTime::now();
    let encoding = Instant::now();
    let (jpeg, out_width, out_height, png_width, png_height) =
        tokio::task::spawn_blocking(move || crate::libav::png_to_jpeg(&png, width, quality))
            .await
            .map_err(|e| e.to_string())??;
    let encode_ms = encoding.elapsed().as_secs_f64() * 1000.0;
    let ago = |at: Instant| at.elapsed().as_millis() as u64;
    let state_now = live.map(|live| live.state(settle_time()));
    let last_input = state_now.as_ref().and_then(|s| s.last_input);
    let mut frame = match live {
        Some(live) => live.identity(0, wall, png_width, png_height),
        None => json!({
            "generation": Value::Null,
            "captured_at": stamp_at(wall),
            "size": [png_width, png_height],
            "orientation": if png_width > png_height { "landscape" } else { "portrait" },
            "scale": Value::Null,
        }),
    };
    frame["seq"] = Value::Null;
    frame["source"] = "screenshot".into();
    frame["damaged"] = false.into();
    let mut answer = json!({
        "source": "screenshot",
        "fallback_reason": reason,
        // Taken between the request and the reply; captured_at is the reply.
        "captured_at": stamp_at(wall),
        "age_ms": ago(received),
        "screenshot_ms": received.duration_since(requested).as_millis() as u64,
        "width": out_width,
        "height": out_height,
        "bytes": jpeg.len(),
        "encode_ms": (encode_ms * 10.0).round() / 10.0,
        "picture_after_input": last_input.map(|input| requested > input),
        // The screenshot was asked for after the input: it shows the screen after it.
        "observation": match last_input {
            None => "no_input",
            Some(input) if requested > input => "after_input",
            Some(_) => "unverified",
        },
        "frame": frame,
        "screen_change_verified": false,
    });
    if let Some(state) = state_now {
        let extra = json!({
            "settled": state.settled,
            "quiet_ms": state.quiet_since.map(ago),
            "latest_epoch": state.epoch,
            "last_input_epoch": state.last_input_epoch,
            "last_input_ms_ago": state.last_input.map(ago),
            "changed_since_input": state.changed_since_input,
            "units_since_input": state.last_input.map(|_| state.units_since_input),
            "moving": state.moving,
            "ms_since_unit": state.activity.map(|a| ago(a.at)),
            "animating_region": crate::frames::animating_json(state.animating_region),
            "video_stalled": state.stalled_since.is_some(),
            "decoding": state.decoding,
        });
        if let (Value::Object(answer), Value::Object(extra)) = (&mut answer, extra) {
            answer.extend(extra);
        }
    }
    match object.get("path").and_then(Value::as_str) {
        Some(path) => {
            std::fs::write(path, &jpeg)?;
            answer["path"] = path.into();
        }
        None => answer["jpeg_base64"] = base64(&jpeg).into(),
    }
    Ok(answer)
}

/// The newest picture and what the screen is doing, waiting up to `wait_ms` for a first picture.
/// `source`: "auto" (default) serves the decoded picture unless it is stalled, damaged, behind
/// or missing, and takes a screenshot then; "video" never takes one; "screenshot" always does.
async fn picture(
    state: &State,
    live: &Live,
    object: &Map<String, Value>,
    wait_ms: u64,
) -> Result<Value> {
    let source = object
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if source == "screenshot" {
        return screenshot_picture(state, Some(live), object, "requested").await;
    }
    if source == "auto" && decode_off() {
        return screenshot_picture(state, Some(live), object, "decode_off").await;
    }
    let settle = settle_time();
    if live.state(settle).latest.is_none() && !decode_off() {
        let since = Instant::now() - Duration::from_secs(3600);
        live.wait_picture_after(since, Duration::from_millis(wait_ms.max(1)))
            .await;
    }
    if source == "auto"
        && let Some(reason) = video_unusable(live)
    {
        return screenshot_picture(state, Some(live), object, reason).await;
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
        // Pixels when decoding, unit sizes otherwise (see frames::UnitSizes).
        "changed_since_input": state.changed_since_input,
        "units_since_input": state.last_input.map(|_| state.units_since_input),
        "source": "video",
        "moving": state.moving,
        "ms_since_unit": state.activity.map(|a| ago(a.at)),
        "picture_current": state.picture_current,
        // Something keeps changing in place here (a spinner, a clock); settled ignores it.
        "animating_region": crate::frames::animating_json(state.animating_region),
        "picture_after_input": state.last_input.map(|input| jpeg.arrived > input),
        // Upstream's rule: after an action, a frame not proven newer than it is unverified.
        "observation": observation(jpeg.epoch, state.last_input_epoch),
        // Packets arrive but nothing decodes: this picture is older than the screen.
        "video_stalled": state.stalled_since.is_some(),
        "stalled_ms": state.stalled_since.map(ago),
        "frame": live.identity(jpeg.epoch, jpeg.wall, state.latest.map_or(jpeg.width, |l| l.2), state.latest.map_or(jpeg.height, |l| l.3)),
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

/// "after_input" when the frame is newer than the last input, "unverified" when it cannot be
/// shown to be, "no_input" before any input.
pub fn observation(seq: u64, last_input_epoch: Option<u64>) -> &'static str {
    match last_input_epoch {
        None => "no_input",
        Some(at_input) if seq > at_input => "after_input",
        Some(_) => "unverified",
    }
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

    /// The decoded picture is served only when it shows the screen; otherwise a screenshot is
    /// taken, and why is said.
    #[test]
    fn a_missing_picture_is_a_reason_for_a_screenshot() {
        let Some(screen) = crate::frames::fake::FakeScreen::start() else {
            println!("skipped: no libavcodec");
            return;
        };
        let Some(units) = crate::frames::fake::draw("unusable", "320x640", "null")
            .and_then(|picture| crate::frames::fake::encode(&[picture]))
        else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        if decode_off() {
            assert_eq!(video_unusable(&screen.live), Some("decode_off"));
            return;
        }
        assert_eq!(video_unusable(&screen.live), Some("no_picture"));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(screen.show(&units[0]));
        assert_eq!(video_unusable(&screen.live), None);
    }

    #[test]
    fn a_frame_is_after_an_input_only_when_its_number_is_newer() {
        assert_eq!(observation(7, None), "no_input");
        assert_eq!(observation(7, Some(7)), "unverified");
        assert_eq!(observation(8, Some(7)), "after_input");
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xd8, 0xff, 0xe0]), "/9j/4A==");
    }

    /// AX-on-settle against a fake screen and a fake phone whose reads take 300 ms: a read starts
    /// when the screen settles, a pixel change during it aborts it, the next settle starts a new
    /// one, and only that one lands, marked current with the epoch it was asked at. A later
    /// change makes it stale.
    #[test]
    fn a_read_the_screen_outran_is_dropped_and_redone_at_the_next_settle() {
        use crate::frames::fake::{FakeScreen, draw, encode};
        let pictures = [
            draw(
                "prefetch-a",
                "302x656",
                "drawbox=x=20:y=100:w=262:h=60:color=gray:t=fill",
            ),
            draw(
                "prefetch-b",
                "302x656",
                "drawbox=x=20:y=400:w=262:h=120:color=black:t=fill",
            ),
        ];
        let Some(pictures) = pictures.into_iter().collect::<Option<Vec<_>>>() else {
            println!("skipped: ffmpeg cannot draw pictures here");
            return;
        };
        let Some(units) = encode(&pictures) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        let Some(screen) = FakeScreen::start() else {
            println!("skipped: no libavcodec");
            return;
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let live = screen.live.clone();
            let prefetch = Prefetcher::default();
            let events = Rc::new(watch::channel(0u64).0);
            let calls = Rc::new(std::cell::Cell::new(0u32));
            let reader: TreeReader = {
                let calls = calls.clone();
                Rc::new(move || {
                    calls.set(calls.get() + 1);
                    let call = calls.get();
                    Box::pin(async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        Ok(json!({"elements": [], "call": call}))
                    })
                })
            };
            let running = tokio::task::spawn_local({
                let (live, prefetch, events, reader) = (
                    live.clone(),
                    prefetch.clone(),
                    events.clone(),
                    reader.clone(),
                );
                async move { prefetch_while_open(&live, &prefetch, &events, &reader).await }
            });
            let wait_for = async |what: &str, check: &dyn Fn() -> bool| {
                let started = Instant::now();
                while !check() {
                    assert!(started.elapsed() < Duration::from_secs(3), "{what}");
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            };
            screen.show(&units[0]).await;
            wait_for("a read starts on settle", &|| {
                prefetch.borrow().pending.is_some()
            })
            .await;
            assert_eq!(calls.get(), 1);
            assert_eq!(tree_summary(&prefetch, &live)["pending"], json!(true));
            // The screen moves while the phone is answering.
            tokio::time::sleep(Duration::from_millis(100)).await;
            screen.show(&units[1]).await;
            let moved_epoch = live.state(settle_time()).epoch;
            wait_for("the outrun read is dropped", &|| {
                prefetch.borrow().dropped == 1
            })
            .await;
            assert!(prefetch.borrow().ready.is_none());
            // The next settle reads again, and that read lands.
            let mut landed = events.subscribe();
            tokio::time::timeout(Duration::from_secs(3), landed.changed())
                .await
                .expect("a tree lands")
                .unwrap();
            assert_eq!(calls.get(), 2);
            {
                let p = prefetch.borrow();
                let read = p.ready.as_ref().expect("ready");
                assert_eq!(read.tree["call"], json!(2));
                assert_eq!(read.epoch, moved_epoch);
                assert_eq!((p.reads, p.dropped), (1, 1));
                let provenance = read.provenance(&live);
                assert_eq!(provenance["current"], json!(true));
                assert_eq!(provenance["request_epoch"], json!(moved_epoch));
            }
            let served = prefetched(&prefetch, &events, &live, Duration::ZERO).await;
            assert_eq!(served.map(|r| r.tree["call"].clone()), Some(json!(2)));
            // An input makes the tree stale; no read is served for the new screen until one lands.
            live.note_input();
            assert_eq!(tree_summary(&prefetch, &live)["current"], json!(false));
            assert!(
                prefetched(&prefetch, &events, &live, Duration::from_millis(50))
                    .await
                    .is_none_or(|r| r.tree["call"] != json!(2))
            );
            running.abort();
        });
    }
}

/// Accessibility reads made ahead of time (AX-on-settle): when the screen settles after a change
/// or an input, the daemon reads the tree on the held tunnel without waiting for anyone to ask, and
/// drops the read when the screen changes before it is answered. A read is current while no pixel
/// change and no input has happened since it was requested.
#[derive(Default)]
pub struct Prefetch {
    pending: Option<Pending>,
    ready: Option<TreeRead>,
    /// Bumped when a read lands, for the feed.
    generation: u64,
    reads: u64,
    dropped: u64,
    /// When the last failed read was asked for; the same screen is not read again.
    failed: Option<Instant>,
}

struct Pending {
    requested: Instant,
    wall: std::time::SystemTime,
    epoch: u64,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
pub struct TreeRead {
    pub tree: Value,
    pub requested: Instant,
    pub wall: std::time::SystemTime,
    pub epoch: u64,
    pub generation: u64,
    pub read_ms: u64,
}

impl TreeRead {
    /// request_started_at, request_epoch and current, as every tree answer carries them.
    pub fn provenance(&self, live: &Live) -> Value {
        json!({
            "request_started_at": stamp_at(self.wall),
            "request_epoch": self.epoch,
            "request_generation": self.generation,
            "current": live.unchanged_since(self.requested),
        })
    }
}

pub type Prefetcher = std::rc::Rc<std::cell::RefCell<Prefetch>>;

/// What latest_frame says about the accessibility tree: when the newest ready read was asked for,
/// whether it is still current, and whether a read is under way.
pub fn tree_summary(prefetch: &Prefetcher, live: &Live) -> Value {
    let p = prefetch.borrow();
    let ready = p.ready.as_ref();
    json!({
        "request_started_at": ready.map(|read| stamp_at(read.wall)),
        "request_epoch": ready.map(|read| read.epoch),
        "current": ready.is_some_and(|read| live.unchanged_since(read.requested)),
        "pending": p.pending.is_some(),
    })
}

/// The newest accessibility read after settle failed (and none succeeded since).
pub fn ax_unavailable(prefetch: &Prefetcher) -> bool {
    let p = prefetch.borrow();
    p.failed.is_some_and(|failed| {
        p.ready
            .as_ref()
            .is_none_or(|ready| ready.requested < failed)
    })
}

/// The prefetch's state for latest_frame and ping.
pub fn prefetch_json(prefetch: &Prefetcher, live: &Live) -> Value {
    let p = prefetch.borrow();
    json!({
        "pending": p.pending.as_ref().map(|pending| json!({
            "request_started_at": stamp_at(pending.wall),
            "request_epoch": pending.epoch,
            "current": live.unchanged_since(pending.requested),
        })),
        "ready": p.ready.as_ref().map(|read| read.provenance(live)),
        "reads": p.reads,
        "dropped": p.dropped,
    })
}

/// A current prefetched tree, waiting for a current pending read for up to `wait`.
pub async fn prefetched(
    prefetch: &Prefetcher,
    events: &watch::Sender<u64>,
    live: &Live,
    wait: Duration,
) -> Option<TreeRead> {
    let deadline = tokio::time::Instant::now() + wait;
    let mut watcher = events.subscribe();
    loop {
        watcher.mark_unchanged();
        {
            let p = prefetch.borrow();
            if let Some(read) = p
                .ready
                .as_ref()
                .filter(|r| live.unchanged_since(r.requested))
            {
                return Some(read.clone());
            }
            let pending = p
                .pending
                .as_ref()
                .filter(|p| live.unchanged_since(p.requested))?;
            let _ = pending;
        }
        if tokio::time::timeout_at(deadline, watcher.changed())
            .await
            .is_err()
        {
            return None;
        }
    }
}

/// Reads the on-screen accessibility tree; a seam so tests can stand in for the phone.
pub type TreeReader =
    Rc<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>>>>>;

/// Runs for the daemon's life with live frames on: starts a read whenever the screen settles
/// after a change or input and no current read exists, and drops reads the screen outran.
pub async fn prefetch_loop(state: Rc<State>) {
    // Opt-in: an accessibility read on every settle is extra load on the phone.
    if std::env::var("POKI_LIVE_AX_PREFETCH").as_deref() != Ok("1") {
        return;
    }
    loop {
        let found = state.session.try_lock().ok().and_then(|session| {
            let live = session.input.as_ref()?.frames.live();
            let device = &session.link.as_ref()?.device;
            (live.decoding() && live.error().is_none())
                .then(|| (live, device.adapter.clone(), device.rsd.clone()))
        });
        let Some((live, adapter, rsd)) = found else {
            tokio::time::sleep(Duration::from_millis(300)).await;
            continue;
        };
        let gate = state.ax_gate.clone();
        let reader: TreeReader = Rc::new(move || {
            let (mut adapter, rsd, gate) = (adapter.clone(), rsd.clone(), gate.clone());
            Box::pin(async move {
                let read = crate::ax::read_tree_with_timeout(
                    &mut adapter,
                    &rsd,
                    false,
                    Duration::from_secs(4),
                );
                super::ax_gate::through(&gate, read, || ()).await
            })
        });
        prefetch_while_open(&live, &state.prefetch, &state.prefetch_events, &reader).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// The prefetch for one media session, until its stream closes.
pub async fn prefetch_while_open(
    live: &Live,
    prefetch: &Prefetcher,
    events: &Rc<watch::Sender<u64>>,
    reader: &TreeReader,
) {
    let settle = settle_time();
    let mut watcher = live.watcher();
    loop {
        watcher.mark_unchanged();
        let now = live.state(settle);
        if now.closed {
            break;
        }
        {
            let mut p = prefetch.borrow_mut();
            // The screen moved after the request: its answer would show the old screen.
            if p.pending
                .as_ref()
                .is_some_and(|pending| !live.unchanged_since(pending.requested))
            {
                let pending = p.pending.take().expect("checked");
                pending.task.abort();
                p.dropped += 1;
            }
            let current = p
                .ready
                .as_ref()
                .is_some_and(|r| live.unchanged_since(r.requested));
            let failed_here = p.failed.is_some_and(|at| live.unchanged_since(at));
            if now.settled
                && p.pending.is_none()
                && !current
                && !failed_here
                && now.latest.is_some()
            {
                let requested = Instant::now();
                let wall = std::time::SystemTime::now();
                let epoch = now.epoch;
                let task = tokio::task::spawn_local(read_ahead(
                    prefetch.clone(),
                    events.clone(),
                    live.clone(),
                    reader(),
                    requested,
                    wall,
                    epoch,
                ));
                p.pending = Some(Pending {
                    requested,
                    wall,
                    epoch,
                    task,
                });
            }
        }
        let wake = now
            .settles_at
            .filter(|_| !now.settled)
            .map(tokio::time::Instant::from_std);
        let tick = tokio::time::Instant::now() + Duration::from_secs(2);
        tokio::select! {
            _ = watcher.changed() => {},
            _ = tokio::time::sleep_until(wake.unwrap_or(tick).min(tick)) => {},
        }
    }
    if let Some(pending) = prefetch.borrow_mut().pending.take() {
        pending.task.abort();
    }
}

async fn read_ahead(
    prefetch: Prefetcher,
    events: Rc<watch::Sender<u64>>,
    live: Live,
    read: std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>>>>,
    requested: Instant,
    wall: std::time::SystemTime,
    epoch: u64,
) {
    let result = read.await;
    let mut p = prefetch.borrow_mut();
    if p.pending
        .as_ref()
        .is_some_and(|pending| pending.requested == requested)
    {
        p.pending = None;
    }
    match result {
        Ok(tree) if live.unchanged_since(requested) => {
            live.note_points(&tree);
            p.reads += 1;
            p.ready = Some(TreeRead {
                tree,
                requested,
                wall,
                epoch,
                generation: live.state(settle_time()).session,
                read_ms: requested.elapsed().as_millis() as u64,
            });
        }
        Ok(_) => p.dropped += 1,
        Err(error) => {
            // A failed read says the screen is unknown: the tree before it is not served.
            p.failed = Some(requested);
            p.ready = None;
            log(&format!("accessibility read after settle failed: {error}"));
        }
    }
    p.generation += 1;
    let generation = p.generation;
    drop(p);
    events.send_replace(generation);
}

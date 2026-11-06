//! The daemon behind poki-bridged. It is a child of poki-native's crate root (see main.rs next to this
//! file), so `super` is poki-native's main.rs and every op below calls poki-native's own functions.
//!
//! # Protocol
//!
//! One JSON object per line on a Unix socket, answered by one JSON object per line, in order. A
//! request is the object poki-native reads on stdin, plus an optional `id` that the answer echoes:
//!
//! ```text
//! {"id":1,"op":"tap","x":30000,"y":40000}
//! ```
//!
//! An answer carries what poki-native would have printed, verbatim, so a caller can hand it on as if
//! poki-native had run: `stdout` on success, `stderr` (poki-native's error object) on failure.
//!
//! ```text
//! {"id":1,"ok":true,"stdout":"{\"screen_change_verified\":false,\"sent\":true}","timings":{...}}
//! {"id":1,"ok":false,"stderr":"{\"error\":\"...\",\"screen_change_verified\":false}","timings":{...}}
//! ```
//!
//! Control requests: `{"op":"ping"}`, `{"op":"reset"}` (close the tunnel and the input services) and
//! `{"op":"shutdown"}`.
//!
//! # What is held
//!
//! For its one device the daemon keeps the remote pairing (or CoreDeviceProxy) tunnel with its RSD
//! handshake, and, once an input op has run, the screen media session that the HID services need,
//! the touch connection and the button connection. The virtual keyboard is still added and removed
//! per op, because iOS hides the on-screen keyboard while a hardware keyboard is attached. The media
//! session streams video, which the daemon drains and discards; it is closed after
//! `POKI_BRIDGED_INPUT_IDLE_MS` (default 60000, 0 keeps it) without input, and the daemon exits after
//! `POKI_BRIDGED_EXIT_IDLE_MS` (default 1800000, 0 never) without any op.
//!
//! # Failures
//!
//! Ops run one at a time. A client that disconnects while its op runs cancels it, and the input
//! services are then closed so that no touch is left down. Any op error closes the tunnel and the
//! next op reconnects. An op that only reads is retried once on a fresh tunnel when it fails on a
//! reused one. An input op is retried only when nothing was sent: when opening its services or its
//! first touch report fails on a reused tunnel.
//!
//! `install_app` and `uninstall_app` run exactly as in poki-native, on their own connection. A held
//! `location` `set` keeps its process alive until it is killed, so it stays with poki-native.
use super::*;
use idevice::core_device::DisplayServiceClient;
use serde_json::Map;
use std::{path::Path, rc::Rc, time::Instant};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, watch},
    task::JoinHandle,
};

#[path = "live.rs"]
mod live;
#[path = "lock_state.rs"]
mod lock_state;
#[path = "media.rs"]
mod media;

const DAEMON_USAGE: &str = "usage: poki-bridged --socket PATH --udid ID\n       poki-bridged --socket PATH --host IP --pairing-file PATH\n       poki-bridged --socket PATH --host IP --rp-pairing-file PATH [--rp-host-name NAME]";
/// poki-native reads at most 2 MiB of request; the margin covers the `id`.
const LINE_LIMIT: u64 = 2 * 1024 * 1024 + 4096;

pub fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match parse_daemon_args(&args) {
        // One thread: ops run one at a time anyway, and the connection tasks need not be Send.
        Ok((socket, target)) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(Into::into)
            .and_then(|runtime| {
                runtime.block_on(tokio::task::LocalSet::new().run_until(run(socket, target)))
            }),
        Err(error) => Err(error),
    };
    if let Err(error) = code {
        log(&error.to_string());
        std::process::exit(if error.to_string() == ALREADY_RUNNING {
            3
        } else {
            1
        });
    }
}

const ALREADY_RUNNING: &str = "another poki-bridged already serves this socket";

/// `--socket PATH` followed by, or mixed with, poki-native's target arguments.
fn parse_daemon_args(args: &[String]) -> Result<(PathBuf, Target)> {
    let at = args
        .iter()
        .skip(1)
        .position(|a| a == "--socket")
        .map(|i| i + 1)
        .ok_or(DAEMON_USAGE)?;
    let socket = args
        .get(at + 1)
        .filter(|p| !p.is_empty() && !p.starts_with("--"))
        .ok_or(DAEMON_USAGE)?;
    let mut rest = args.to_vec();
    rest.drain(at..at + 2);
    if rest.iter().any(|a| a == "--socket") {
        return Err(DAEMON_USAGE.into());
    }
    let target = parse_args(&rest).map_err(|_| DAEMON_USAGE)?;
    Ok((PathBuf::from(socket), target))
}

fn idle_env(name: &str, default_ms: u64) -> Option<Duration> {
    let ms = std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default_ms);
    (ms > 0).then(|| Duration::from_millis(ms))
}

async fn run(socket: PathBuf, target: Target) -> Result<()> {
    let listener = bind(&socket).await?;
    let state = Rc::new(State::new(target));
    log(&format!("ready (pid {})", std::process::id()));
    let result = serve(listener, state.clone()).await;
    state.session.lock().await.reset().await;
    let _ = std::fs::remove_file(&socket);
    result
}

/// Binds the socket, replacing a stale file but never a live daemon.
async fn bind(socket: &Path) -> Result<UnixListener> {
    if socket.exists() {
        if UnixStream::connect(socket).await.is_ok() {
            return Err(ALREADY_RUNNING.into());
        }
        std::fs::remove_file(socket)?;
    }
    let listener = UnixListener::bind(socket)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

struct State {
    session: Mutex<Session>,
    /// Set to true to stop serving.
    stop: watch::Sender<bool>,
    started: Instant,
    version: u64,
    /// Accessibility reads made after the screen settles (live frames), and their arrivals.
    prefetch: live::Prefetcher,
    prefetch_events: Rc<watch::Sender<u64>>,
    /// The foreground app from the newest tree, and app_for_pid answers (see live::Foreground).
    foreground: live::ForegroundCell,
    /// Locked or awake, from SpringBoard's notifications (see device_state).
    device: lock_state::DeviceCell,
}

impl State {
    fn new(target: Target) -> Self {
        let prefetch = live::Prefetcher::default();
        let prefetch_events = Rc::new(watch::channel(0).0);
        let foreground = live::ForegroundCell::default();
        let mut session = Session::new(target, prefetch.clone(), prefetch_events.clone());
        session.foreground = foreground.clone();
        Self {
            session: Mutex::new(session),
            prefetch,
            prefetch_events,
            foreground,
            device: lock_state::DeviceCell::default(),
            stop: watch::channel(false).0,
            started: Instant::now(),
            version: executable_version(),
        }
    }
}

/// The modification time of this executable when it started, so a client can tell a daemon that
/// predates a rebuild.
fn executable_version() -> u64 {
    std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

async fn serve(listener: UnixListener, state: Rc<State>) -> Result<()> {
    let mut stop = state.stop.subscribe();
    let reaper = tokio::task::spawn_local(reap(state.clone()));
    let resolver = tokio::task::spawn_local(live::resolve_foreground(state.clone()));
    let device_watch = tokio::task::spawn_local(lock_state::watch(state.clone()));
    let prefetcher =
        live::enabled().then(|| tokio::task::spawn_local(live::prefetch_loop(state.clone())));
    // Load the OCR models before the first type_text or ocr_region needs them.
    if live::enabled() && crate::ocr::enabled() {
        tokio::task::spawn_local(async { crate::ocr::shared().warm().await });
    }
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                tokio::task::spawn_local(connection(stream, state.clone()));
            }
            _ = stop.wait_for(|stop| *stop) => break,
            _ = terminate.recv() => break,
            _ = interrupt.recv() => break,
        }
    }
    reaper.abort();
    resolver.abort();
    device_watch.abort();
    if let Some(prefetcher) = prefetcher {
        prefetcher.abort();
    }
    Ok(())
}

/// Keeps the tunnel: checks it while idle, and opens it again after it is lost (as soon as 49152
/// accepts, when the phone refused). Closes the input services after their idle time; exits after
/// POKI_BRIDGED_EXIT_IDLE_MS only when that is set (a tunnel cannot be rebuilt off Wi-Fi).
async fn reap(state: Rc<State>) {
    let input_idle = idle_env("POKI_BRIDGED_INPUT_IDLE_MS", 60_000);
    let exit_idle = idle_env("POKI_BRIDGED_EXIT_IDLE_MS", 0);
    let mut reopened: Option<Instant> = None;
    let mut checked = Instant::now();
    let mut next_attempt = Instant::now();
    let mut backoff = Duration::from_secs(1);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Ok(mut session) = state.session.try_lock() else {
            continue;
        };
        let idle = session.last_used.elapsed();
        // Keepalive: an idle tunnel is used every KEEPALIVE_EVERY, and dropped if it stopped working.
        if session.link.is_some() && checked.elapsed() >= KEEPALIVE_EVERY && idle >= KEEPALIVE_EVERY
        {
            checked = Instant::now();
            if !session.tunnel_alive().await {
                log("keepalive: the tunnel stopped carrying connections; dropping it");
                session.tunnels_lost += 1;
                session.close_input().await;
                session.ax = None;
                session.ax_link = None;
                session.link = None;
                session.tunnel_down = Some(TunnelDown {
                    state: "error",
                    since: std::time::SystemTime::now(),
                    error: "keepalive failed".into(),
                    attempts: 0,
                });
            }
        }
        // A lost tunnel is opened again. When 49152 refused, it is watched every second with a
        // plain TCP connect, and the tunnel is opened the moment it accepts.
        if session.link.is_none() && session.tunnel_down.is_some() && Instant::now() >= next_attempt
        {
            let refused = session
                .tunnel_down
                .as_ref()
                .is_some_and(|d| d.state == "wifi_required");
            let port_open = match (&session.target, refused) {
                (Target::RemotePairing { host, .. }, true) => {
                    let address = std::net::SocketAddr::new(*host, remote::REMOTE_PAIRING_PORT);
                    matches!(
                        tokio::time::timeout(
                            Duration::from_secs(1),
                            tokio::net::TcpStream::connect(address)
                        )
                        .await,
                        Ok(Ok(_))
                    )
                }
                _ => true,
            };
            if port_open {
                let mut timings = Timings::default();
                match Box::pin(session.connect(&mut timings)).await {
                    Ok(()) => {
                        backoff = Duration::from_secs(1);
                        log("tunnel reopened");
                    }
                    Err(error) => {
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                        log(&format!(
                            "tunnel still down ({error}); next try in {} s",
                            backoff.as_secs()
                        ));
                    }
                }
                next_attempt = Instant::now() + backoff;
            } else {
                next_attempt = Instant::now() + Duration::from_secs(1);
            }
        }
        if live::enabled() {
            // A stream that stays stuck after a key frame request: reopen the media session on
            // the same tunnel.
            if session.restart_media_if_asked().await {
                reopened = None;
            }
            // The live screen keeps the media session open, and opens it again after an error,
            // inside the tunnel while there is one (the tunnel itself is reopened above).
            if session.input.is_none()
                && (session.link.is_some() || session.tunnel_down.is_none())
                && reopened.is_none_or(|at: Instant| at.elapsed() >= live::REOPEN_AFTER)
            {
                reopened = Some(Instant::now());
                let mut timings = Timings::default();
                match Box::pin(session.prepare_input_or_retry(false, &mut timings)).await {
                    Ok(()) => {
                        if let Some(input) = session.input.as_ref()
                            && !live::decode_off()
                        {
                            input.frames.live().decode();
                        }
                        log(&format!(
                            "live frames: media session open in {} ms",
                            timings.input_open_ms.unwrap_or(0)
                        ));
                    }
                    Err(error) => {
                        session.recover().await;
                        log(&format!(
                            "live frames: cannot open the media session: {error}"
                        ));
                    }
                }
            }
            continue;
        }
        if input_idle.is_some_and(|limit| idle >= limit) && session.input.is_some() {
            log("input services idle; closing them");
            session.close_input().await;
        }
        if exit_idle.is_some_and(|limit| idle >= limit) {
            log("idle; exiting");
            let _ = state.stop.send(true);
            return;
        }
    }
}

fn log(message: &str) {
    eprintln!("{} poki-bridged: {message}", crate::ax::watch::stamp());
}

pub(crate) fn log_line(message: &str) {
    log(message);
}

/// One client. Its requests are answered in order; when it disconnects, a running op is cancelled.
async fn connection(stream: UnixStream, state: Rc<State>) {
    let (read, mut write) = stream.into_split();
    let (closed_tx, closed) = watch::channel(false);
    let (lines_tx, mut lines) =
        tokio::sync::mpsc::unbounded_channel::<std::result::Result<String, String>>();
    tokio::task::spawn_local(async move {
        let mut reader = BufReader::new(read);
        loop {
            let mut line = Vec::new();
            match (&mut reader)
                .take(LINE_LIMIT)
                .read_until(b'\n', &mut line)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) if !line.ends_with(b"\n") && line.len() as u64 >= LINE_LIMIT => {
                    let _ = lines_tx.send(Err("request line exceeds 2 MiB".into()));
                    break;
                }
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line).trim().to_owned();
                    if !text.is_empty() && lines_tx.send(Ok(text)).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = closed_tx.send(true);
    });
    while let Some(line) = lines.recv().await {
        if let Ok(text) = &line
            && live::is_subscribe(text)
        {
            // The connection now carries the event feed until the client leaves.
            Box::pin(live::subscribe(text, &state, closed.clone(), &mut write)).await;
            break;
        }
        let answer = match line {
            Ok(line) => Box::pin(answer(&line, &state, closed.clone())).await,
            Err(error) => Some(failure(
                Value::Null,
                &*Box::<dyn std::error::Error + Send + Sync>::from(error),
                Timings::default(),
            )),
        };
        let Some(answer) = answer else { break };
        let mut bytes = answer.to_string().into_bytes();
        bytes.push(b'\n');
        if write.write_all(&bytes).await.is_err() {
            break;
        }
    }
}

#[derive(Default, serde::Serialize)]
struct Timings {
    /// Time spent opening the tunnel, when this op opened it.
    #[serde(skip_serializing_if = "Option::is_none")]
    connect_ms: Option<u64>,
    /// Time spent opening the input media session and its wait, when this op opened them.
    #[serde(skip_serializing_if = "Option::is_none")]
    input_open_ms: Option<u64>,
    /// The whole op, including any connect.
    total_ms: u64,
    reused_tunnel: bool,
    reused_input: bool,
    retried: bool,
    /// When the tree answered was asked for, and whether the screen has changed since.
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<Value>,
    /// Where a quick type_text spent its time.
    #[serde(skip_serializing_if = "Option::is_none")]
    stages: Option<Value>,
    /// How an ax_tree read was served by the held subscription.
    #[serde(skip_serializing_if = "Option::is_none")]
    ax: Option<crate::ax::watch::Served>,
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

fn success(id: Value, output: &Value, timings: Timings) -> Value {
    // Background type_text read-backs that disagreed with their fast answer.
    let warnings = super::paste_again::quick::take_warnings();
    let mut output = output.clone();
    if !warnings.is_empty()
        && let Some(object) = output.as_object_mut()
    {
        object.insert("warnings".into(), warnings.into());
    }
    // poki-native prints the result with `println!("{result}")`.
    json!({"id": id, "ok": true, "stdout": output.to_string(), "timings": timings})
}

fn failure(id: Value, error: &(dyn std::error::Error + Send + Sync), timings: Timings) -> Value {
    // poki-native's error line on stderr.
    let stderr = json!({"error": error.to_string(), "screen_change_verified": false});
    json!({"id": id, "ok": false, "stderr": stderr.to_string(), "timings": timings})
}

/// A request line split into its id, its op name and poki-native's request object.
type Split = (Value, String, Map<String, Value>);

fn split(line: &str) -> std::result::Result<Split, (Value, String)> {
    let mut object = match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(object)) => object,
        Ok(_) => return Err((Value::Null, "request must be a JSON object".into())),
        Err(error) => return Err((Value::Null, error.to_string())),
    };
    let id = object.remove("id").unwrap_or(Value::Null);
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((id, op, object))
}

/// Answers one line, or None when the client left before its op could finish.
async fn answer(line: &str, state: &State, mut closed: watch::Receiver<bool>) -> Option<Value> {
    let started = Instant::now();
    let (id, op, object) = match split(line) {
        Ok(parts) => parts,
        Err((id, error)) => {
            return Some(failure(
                id,
                &*Box::<dyn std::error::Error + Send + Sync>::from(error),
                Timings::default(),
            ));
        }
    };
    match op.as_str() {
        "ping" => {
            let mut pong = json!({
                "pid": std::process::id(),
                "version": state.version,
                "uptime_ms": ms(state.started),
                "busy": true,
            });
            // A running op holds the session; ping does not wait for it.
            if let Ok(session) = state.session.try_lock() {
                pong["busy"] = false.into();
                pong["tunnel"] = session.link.is_some().into();
                pong["input"] = session.input.is_some().into();
                pong["ops"] = session.ops.into();
                pong["media_reopens"] = session.media_reopens.into();
                pong["frames"] = session.input.as_ref().map_or(Value::Null, |input| {
                    let live = input.frames.live();
                    live.report(&live.mark())
                });
                // What observe needs to know before trusting a picture.
                let mut reasons = Vec::new();
                let frames = &pong["frames"];
                if frames["video_stalled"] == json!(true) {
                    reasons.push("video_stalled");
                } else if frames["latest_age_ms"]
                    .as_u64()
                    .is_some_and(|age| age > 1000)
                    && frames["ms_since_last_packet"]
                        .as_u64()
                        .is_some_and(|ms| ms < 500)
                {
                    // Units arrive but the newest picture is old: decoding is behind.
                    reasons.push("decode_backlog");
                }
                if frames["picture_damaged"] == json!(true) {
                    // A packet was lost: pictures may show errors until the session reopens.
                    reasons.push("picture_damaged");
                }
                if live::ax_unavailable(&state.prefetch) {
                    // The newest accessibility read failed: no tree shows the screen.
                    reasons.push("ax_unavailable");
                }
                if state.device.borrow().json()["state"] == "locked" {
                    // Inputs reach the lock screen, not the app: launches show nothing.
                    reasons.push("locked");
                }
                let foreground = live::foreground_json(state);
                if foreground["stale"] == json!(true) {
                    reasons.push("foreground_stale");
                }
                if let Some(down) = &session.tunnel_down {
                    reasons.push(if down.state == "wifi_required" {
                        "wifi_required"
                    } else {
                        "tunnel_down"
                    });
                } else if live::enabled() && session.input.is_none() {
                    reasons.push("media_closed");
                }
                pong["tunnel_state"] = match (&session.link, &session.tunnel_down) {
                    (Some(_), _) => json!({"state": "up"}),
                    (None, Some(down)) => down.json(),
                    (None, None) => json!({"state": "not_opened"}),
                };
                pong["tunnels"] =
                    json!({"opened": session.tunnels_opened, "lost": session.tunnels_lost});
                pong["health"] = json!({"ok": reasons.is_empty(), "reasons": reasons});
                pong["foreground"] = foreground;
                pong["device_state"] = state.device.borrow().json();
                pong["decode_mode"] = if live::decode_off() {
                    "off"
                } else {
                    "continuous"
                }
                .into();
                pong["ax"] = json!({
                    "watch": session.ax.as_ref().map(|w| w.stats()),
                    "opened": session.ax_opened,
                    "fallbacks": session.ax_fallbacks,
                    "last_error": session.ax_last_error,
                    "ocr": crate::ocr::shared().stats(),
                    "prefetch": session.input.as_ref().map(|input| {
                        live::prefetch_json(&state.prefetch, &input.frames.live())
                    }),
                });
            }
            return Some(json!({"id": id, "ok": true, "pong": pong}));
        }
        op if live::is_live_op(op) => {
            return Box::pin(live::answer(op, id, object, state, closed)).await;
        }
        "device_state_probe" => {
            let started = Instant::now();
            let mut timings = Timings::default();
            let result = Box::pin(async {
                let mut session = state.session.lock().await;
                session.connect(&mut timings).await?;
                let device = &session.link.as_ref().expect("connected").device;
                let (mut adapter, mut rsd) = (device.adapter.clone(), device.rsd.clone());
                drop(session);
                let seconds = object
                    .get("seconds")
                    .and_then(Value::as_f64)
                    .unwrap_or(20.0);
                lock_state::probe(&mut adapter, &mut rsd, seconds).await
            })
            .await;
            timings.total_ms = ms(started);
            log(&format!(
                "device_state_probe: {} in {} ms",
                if result.is_ok() { "ok" } else { "error" },
                timings.total_ms
            ));
            return Some(match result {
                Ok(output) => success(id, &output, timings),
                Err(error) => failure(id, &*error, timings),
            });
        }
        "ax_audit_probe" => {
            let started = Instant::now();
            let mut timings = Timings::default();
            let result = Box::pin(async {
                let mut session = state.session.lock().await;
                session.connect(&mut timings).await?;
                let live = session.live_view();
                let device = &session.link.as_ref().expect("connected").device;
                let (mut adapter, rsd) = (device.adapter.clone(), device.rsd.clone());
                drop(session);
                let seconds = object
                    .get("seconds")
                    .and_then(Value::as_f64)
                    .unwrap_or(10.0);
                let event_type = object.get("event_type").and_then(Value::as_i64);
                crate::ax::audit::probe(&mut adapter, &rsd, live, seconds, event_type).await
            })
            .await;
            timings.total_ms = ms(started);
            log(&format!(
                "ax_audit_probe: {} in {} ms",
                if result.is_ok() { "ok" } else { "error" },
                timings.total_ms
            ));
            return Some(match result {
                Ok(output) => success(id, &output, timings),
                Err(error) => failure(id, &*error, timings),
            });
        }
        "reset" => {
            state.session.lock().await.reset().await;
            return Some(json!({"id": id, "ok": true}));
        }
        "shutdown" => {
            let _ = state.stop.send(true);
            return Some(json!({"id": id, "ok": true}));
        }
        _ => {}
    }
    let mut session = tokio::select! {
        session = state.session.lock() => session,
        _ = closed.wait_for(|closed| *closed) => return None,
    };
    let mut timings = Timings::default();
    let limit = Duration::from_secs(if op == "install_app" { 180 } else { 90 });
    let outcome = tokio::select! {
        outcome = tokio::time::timeout(limit, Box::pin(session.handle(object, &mut timings))) => Some(outcome),
        _ = closed.wait_for(|closed| *closed) => None,
    };
    session.ops += 1;
    session.last_used = Instant::now();
    timings.total_ms = ms(started);
    let result = match outcome {
        None => {
            log(&format!("{op}: client left; cancelled"));
            session.recover().await;
            return None;
        }
        Some(Err(elapsed)) => {
            session.recover().await;
            Err(elapsed.into())
        }
        Some(Ok(result)) => result,
    };
    log(&format!(
        "{op}: {} in {} ms{}{}",
        if result.is_ok() { "ok" } else { "error" },
        timings.total_ms,
        if timings.reused_tunnel { " (warm)" } else { "" },
        timings
            .ax
            .map_or(String::new(), |served| format!(" ax={served:?}")
                .to_lowercase())
    ));
    Some(match result {
        Ok(output) => success(id, &output, timings),
        Err(error) => failure(id, &*error, timings),
    })
}

/// An accessibility tree with when it was asked for (request_started_at, request_epoch) and
/// whether the screen has changed since (current), as top-level fields.
fn with_provenance(mut tree: Value, provenance: &Value) -> Value {
    if let (Some(tree), Some(provenance)) = (tree.as_object_mut(), provenance.as_object()) {
        for (key, value) in provenance {
            tree.insert(key.clone(), value.clone());
        }
    }
    tree
}

struct Link {
    device: Device,
}

/// The screen media session the HID services need, and the HID connections made inside it.
struct Input {
    client: DisplayServiceClient<Box<dyn ReadWrite>>,
    /// Tasks that read and discard the RTP the phone streams to the media session's UDP sockets;
    /// the tunnel's UDP queues are unbounded.
    drains: Vec<JoinHandle<()>>,
    /// The video: read and counted, and with POKI_LIVE_FRAMES=1 decoded (see frames.rs).
    frames: crate::frames::Frames,
    touch: Option<Touch>,
    buttons: Option<Indigo>,
}

struct Session {
    target: Target,
    foreground: live::ForegroundCell,
    prefetch: live::Prefetcher,
    prefetch_events: Rc<watch::Sender<u64>>,
    link: Option<Link>,
    input: Option<Input>,
    /// The held accessibility subscription, inside the tunnel.
    ax: Option<crate::ax::watch::Watch>,
    /// Subscriptions opened, and reads that gave one up and read without it, since the daemon
    /// started; the last reason.
    ax_opened: u64,
    ax_fallbacks: u64,
    ax_last_error: Option<String>,
    /// The subscription's own tunnel, with POKI_BRIDGED_AX_TUNNEL=separate.
    ax_link: Option<Link>,
    last_used: Instant,
    ops: u64,
    /// Media sessions closed because their stream asked for a new one.
    media_reopens: u64,
    /// Why the last tunnel attempt failed, while there is no tunnel.
    tunnel_down: Option<TunnelDown>,
    tunnels_opened: u64,
    tunnels_lost: u64,
}

/// No tunnel, and why: what health reports and what a failing op says.
#[derive(Clone)]
struct TunnelDown {
    /// "wifi_required": the phone answers, but nothing listens on 49152 (iOS accepts new
    /// developer connections only on Wi-Fi or USB). "unreachable": no answer. "error": other.
    state: &'static str,
    since: std::time::SystemTime,
    error: String,
    attempts: u64,
}

const WIFI_REQUIRED: &str =
    "phone reachable, but iOS accepts new developer connections only on Wi-Fi or USB";

impl TunnelDown {
    fn json(&self) -> Value {
        json!({
            "state": self.state,
            "since": crate::ax::watch::stamp_at(self.since),
            "attempts": self.attempts,
            "error": self.error,
            "message": match self.state {
                "wifi_required" => WIFI_REQUIRED,
                "unreachable" => "the phone does not answer on the network",
                _ => "the tunnel could not be opened",
            },
        })
    }
}

/// Sorts a failed tunnel attempt: refused (the port is closed, so the phone answered) or no answer.
fn classify(error: &str) -> &'static str {
    let error = error.to_lowercase();
    if error.contains("refused") {
        "wifi_required"
    } else if error.contains("no answer")
        || error.contains("timed out")
        || error.contains("unreachable")
        || error.contains("no route")
    {
        "unreachable"
    } else {
        "error"
    }
}

/// How often an idle tunnel is checked, which also keeps the network path to it in use.
const KEEPALIVE_EVERY: Duration = Duration::from_secs(15);

fn parse(object: &Map<String, Value>) -> Result<Request> {
    let request: Request = serde_json::from_value(Value::Object(object.clone()))?;
    request.validate()?;
    Ok(request)
}

fn is_input(request: &Request) -> bool {
    matches!(
        request,
        Request::Tap { .. }
            | Request::DoubleTap { .. }
            | Request::LongPress { .. }
            | Request::Drag { .. }
            | Request::Pinch { .. }
            | Request::Key { .. }
            | Request::Button { .. }
            | Request::TypeText { .. }
    )
}

/// Ops that change nothing on the phone, so running one twice is harmless.
fn reads_only(request: &Request) -> bool {
    match request {
        Request::DisplayInfo
        | Request::ListApps
        | Request::AxTree { .. }
        | Request::AppForPid { .. }
        | Request::LockdownGet { .. }
        | Request::Screenshot { .. } => true,
        Request::Pasteboard { action, .. } => action != "set",
        Request::Configuration { method, .. } => method.starts_with("get_"),
        _ => false,
    }
}

/// The ops `tunnel_op` runs on the held tunnel.
fn on_tunnel(request: &Request) -> bool {
    matches!(
        request,
        Request::LaunchApp(_)
            | Request::ListApps
            | Request::Configuration { .. }
            | Request::AxTree { .. }
            | Request::AppForPid { .. }
            | Request::LockdownGet { .. }
            | Request::Screenshot { .. }
            | Request::Rotate { .. }
            | Request::Pasteboard { .. }
            | Request::Location { .. }
            | Request::DisplayInfo
    )
}

fn uses_touch(request: &Request) -> bool {
    matches!(
        request,
        Request::Tap { .. }
            | Request::DoubleTap { .. }
            | Request::LongPress { .. }
            | Request::Drag { .. }
            | Request::Pinch { .. }
    )
}

impl Session {
    fn new(
        target: Target,
        prefetch: live::Prefetcher,
        prefetch_events: Rc<watch::Sender<u64>>,
    ) -> Self {
        Self {
            target,
            prefetch,
            prefetch_events,
            link: None,
            input: None,
            ax: None,
            ax_opened: 0,
            ax_fallbacks: 0,
            ax_last_error: None,
            ax_link: None,
            last_used: Instant::now(),
            tunnel_down: None,
            tunnels_opened: 0,
            tunnels_lost: 0,
            ops: 0,
            media_reopens: 0,
            foreground: live::ForegroundCell::default(),
        }
    }

    async fn close_input(&mut self) {
        if let Some(mut input) = self.input.take() {
            drop(input.touch.take());
            drop(input.buttons.take());
            let _ = tokio::time::timeout(Duration::from_secs(2), input.client.stop_media_stream())
                .await;
            for drain in input.drains {
                drain.abort();
            }
        }
    }

    async fn reset(&mut self) {
        self.close_input().await;
        self.ax = None;
        self.ax_link = None;
        self.link = None;
    }

    async fn connect(&mut self, timings: &mut Timings) -> Result<()> {
        if self.link.is_some() {
            timings.reused_tunnel = true;
            return Ok(());
        }
        let started = Instant::now();
        let device = match connect_device(&self.target).await {
            Ok(device) => device,
            Err(error) => {
                let text = error.to_string();
                let state = classify(&text);
                let attempts = self.tunnel_down.as_ref().map_or(0, |d| d.attempts) + 1;
                let since = self
                    .tunnel_down
                    .as_ref()
                    .filter(|d| d.state == state)
                    .map_or_else(std::time::SystemTime::now, |d| d.since);
                self.tunnel_down = Some(TunnelDown {
                    state,
                    since,
                    error: text.clone(),
                    attempts,
                });
                if state == "wifi_required" {
                    return Err(format!("{WIFI_REQUIRED} ({text})").into());
                }
                return Err(error);
            }
        };
        timings.connect_ms = Some(ms(started));
        if let Some(down) = self.tunnel_down.take() {
            log(&format!(
                "tunnel open again after {} attempts ({} since {})",
                down.attempts,
                down.state,
                crate::ax::watch::stamp_at(down.since)
            ));
        }
        self.tunnels_opened += 1;
        self.link = Some(Link { device });
        Ok(())
    }

    /// Whether the tunnel still carries connections: one to a service on the phone, closed at
    /// once. It is also the keepalive: traffic on the tunnel's path every KEEPALIVE_EVERY.
    async fn tunnel_alive(&mut self) -> bool {
        let Some(link) = self.link.as_mut() else {
            return false;
        };
        let device = &mut link.device;
        let port = [
            "com.apple.mobile.lockdown.remote.untrusted",
            "com.apple.mobile.lockdown.remote.trusted",
        ]
        .iter()
        .find_map(|name| device.rsd.services.get(*name))
        .or_else(|| device.rsd.services.values().next())
        .map(|service| service.port);
        let Some(port) = port else {
            return false;
        };
        matches!(
            tokio::time::timeout(Duration::from_secs(3), device.adapter.connect(port)).await,
            Ok(Ok(_))
        )
    }

    /// After a failed op: the media session and accessibility state go, and the tunnel goes only
    /// if it no longer works. Building a tunnel needs 49152, which iOS opens only on Wi-Fi or USB,
    /// while a working tunnel survives a switch to cellular.
    async fn recover(&mut self) {
        self.close_input().await;
        self.ax = None;
        self.ax_link = None;
        if self.link.is_some() && !self.tunnel_alive().await {
            log("tunnel lost");
            self.tunnels_lost += 1;
            self.link = None;
        }
    }

    /// Reopens the media session when its stream asked for it (stuck, or pictures too old);
    /// whether it was closed. Called before every op as well as by the reaper, which cannot run
    /// while ops hold the session (Nov 6: asked for again and again for 40 s, never done).
    async fn restart_media_if_asked(&mut self) -> bool {
        if !self
            .input
            .as_ref()
            .is_some_and(|input| input.frames.live().take_restart_request())
        {
            return false;
        }
        log(
            "live frames: the newest picture is too old while units arrive; reopening the media session",
        );
        self.close_input().await;
        self.media_reopens += 1;
        true
    }

    async fn handle(&mut self, object: Map<String, Value>, timings: &mut Timings) -> Result<Value> {
        let request = parse(&object)?;
        let changes = !reads_only(&request);
        let tree = matches!(request, Request::AxTree { .. });
        self.restart_media_if_asked().await;
        if changes {
            // The foreground known before an input is not known after it.
            self.foreground.borrow_mut().last_input = Some(Instant::now());
        }
        // The live screen is not settled while an input runs, nor for the settle time after it.
        let noted = changes
            .then(|| self.input.as_ref().map(|input| input.frames.live()))
            .flatten();
        if let Some(live) = &noted {
            live.note_input();
        }
        let result = Box::pin(self.run(request, object, timings)).await;
        if tree && let Ok(tree) = &result {
            live::note_tree(&self.foreground, tree);
        }
        if changes && let Some(input) = self.input.as_ref() {
            input.frames.live().note_input();
        }
        // Whatever it did, an op that may change the screen makes the held tree stale.
        if changes && let Some(watch) = self.ax.as_mut() {
            watch.invalidate();
        }
        result
    }

    async fn run(
        &mut self,
        request: Request,
        object: Map<String, Value>,
        timings: &mut Timings,
    ) -> Result<Value> {
        if let Request::AxTree {
            include_offscreen: false,
        } = request
            && std::env::var("POKI_BRIDGED_AX_WATCH").as_deref() != Ok("0")
        {
            return Box::pin(self.live_tree(timings)).await;
        }
        if matches!(
            request,
            Request::InstallApp { .. } | Request::UninstallApp { .. }
        ) {
            return Box::pin(execute(&self.target, request)).await;
        }
        if is_held_location(&request) {
            return Err("A held location set runs in its own poki-native process.".into());
        }
        if !on_tunnel(&request) && !is_input(&request) {
            // An op this daemon does not know yet runs as poki-native runs it, on its own connection.
            return Box::pin(execute(&self.target, request)).await;
        }
        if is_input(&request) {
            return Box::pin(self.input_op(request, &object, timings)).await;
        }
        let retry = reads_only(&request) || matches!(request, Request::LaunchApp(_));
        let mut request = Some(request);
        loop {
            let reused = self.link.is_some();
            let current = match request.take() {
                Some(request) => request,
                None => parse(&object)?,
            };
            let launch = matches!(current, Request::LaunchApp(_));
            let result = match self.connect(timings).await {
                Ok(()) => Box::pin(self.tunnel_op(current)).await,
                Err(error) => Err(error),
            };
            if result.is_ok() {
                return result;
            }
            self.recover().await;
            if !(retry && reused) || timings.retried {
                // poki-native reports a failed launch as a result rather than an error.
                return if launch {
                    Ok(apps::not_sent(result.unwrap_err()))
                } else {
                    result
                };
            }
            timings.retried = true;
        }
    }

    /// An on-screen tree from the held subscription, opening it when there is none. When the
    /// subscription fails, it is dropped and this read is made as poki-native makes it.
    async fn watched_tree(&mut self, timings: &mut Timings) -> Result<Value> {
        let mut attempt = 0;
        loop {
            let reused = self.link.is_some();
            let result = async {
                self.connect(timings).await?;
                // With POKI_BRIDGED_AX_TUNNEL=separate the subscription gets a tunnel of its own,
                // which input never uses.
                let separate = std::env::var("POKI_BRIDGED_AX_TUNNEL").as_deref() == Ok("separate");
                if separate && self.ax_link.is_none() {
                    self.ax = None;
                    let started = Instant::now();
                    self.ax_link = Some(Link {
                        device: connect_device(&self.target).await?,
                    });
                    timings.connect_ms = Some(timings.connect_ms.unwrap_or(0) + ms(started));
                }
                let link = if separate {
                    &mut self.ax_link
                } else {
                    &mut self.link
                };
                let device = &mut link.as_mut().expect("connected").device;
                // A read on a held subscription that is not answered soon is given up: a plain read
                // on a new connection is answered more reliably than a renewal that hangs. A new
                // subscription gets the time a first answer takes.
                let mut cap =
                    idle_env("POKI_BRIDGED_AX_CAP_MS", 1500).unwrap_or(Duration::from_secs(20));
                if self.ax.is_none() {
                    let settings = crate::ax::watch::Settings::from_env();
                    self.ax = Some(
                        crate::ax::watch::Watch::open(&mut device.adapter, &device.rsd, settings)
                            .await?,
                    );
                    self.ax_opened += 1;
                    cap = cap.max(Duration::from_secs(3));
                }
                let (tree, served) = self.ax.as_mut().expect("open").read(cap).await?;
                timings.ax = Some(served);
                Ok::<Value, Box<dyn std::error::Error + Send + Sync>>(tree)
            }
            .await;
            match result {
                Ok(tree) => return Ok(tree),
                Err(error) => {
                    log(&format!(
                        "held accessibility subscription failed ({error}); reading once without it"
                    ));
                    self.ax = None;
                    self.ax_link = None;
                    self.ax_fallbacks += 1;
                    self.ax_last_error = Some(error.to_string());
                    timings.ax = Some(crate::ax::watch::Served::Fallback);
                    if let Some(link) = self.link.as_mut()
                        && let Ok(tree) =
                            ax::read_tree(&mut link.device.adapter, &link.device.rsd, false).await
                    {
                        return Ok(tree);
                    }
                    self.recover().await;
                    if !reused || attempt > 0 {
                        return Err(error);
                    }
                    attempt += 1;
                    timings.retried = true;
                }
            }
        }
    }

    /// The ops of poki-native's `execute` that need only the tunnel. A launch error is returned as an
    /// error here so the caller can retry it; poki-native reports it as a not-sent result.
    async fn tunnel_op(&mut self, request: Request) -> Result<Value> {
        let Device {
            adapter,
            rsd,
            provider,
            ..
        } = &mut self.link.as_mut().expect("connected").device;
        match request {
            Request::LaunchApp(request) => apps::launch(adapter, rsd, request).await,
            Request::ListApps => apps::list(adapter, rsd, provider.as_deref()).await,
            Request::Configuration { method, value } => {
                configuration::execute(adapter, rsd, &method, value).await
            }
            Request::AxTree { include_offscreen } => {
                ax::read_tree(adapter, rsd, include_offscreen).await
            }
            Request::AppForPid { pid } => apps::app_for_pid(adapter, rsd, pid).await,
            Request::LockdownGet { domain, key } => {
                device_ops::lockdown_get(adapter, rsd, domain.as_deref(), &key).await
            }
            Request::Screenshot { path } => device_ops::screenshot(adapter, rsd, &path).await,
            Request::Rotate { direction } => device_ops::rotate(adapter, rsd, &direction).await,
            Request::Pasteboard { action, text } => {
                device_ops::pasteboard(adapter, rsd, &action, text.as_deref()).await
            }
            Request::Location {
                action,
                latitude,
                longitude,
            } => device_ops::location(adapter, rsd, &action, latitude.zip(longitude)).await,
            Request::DisplayInfo => {
                let mut display = DisplayServiceClient::connect_rsd(adapter, rsd).await?;
                let info = display.get_media_support_info().await?;
                Ok(serde_json::to_value(info)?)
            }
            _ => unreachable!("on_tunnel"),
        }
    }

    /// Opens what an input op needs and is not open yet: the tunnel, the media session (then
    /// `POKI_HID_OPEN_MS`, as poki-native waits) and, for touches, the touch connection.
    async fn prepare_input(&mut self, touch: bool, timings: &mut Timings) -> Result<()> {
        self.connect(timings).await?;
        let device = &mut self.link.as_mut().expect("connected").device;
        if self.input.is_none() {
            let started = Instant::now();
            let (media, our_ssrc) = media::start(&mut device.adapter, &mut device.rsd, 1)
                .await
                .map_err(|e| format!("Cannot establish input media session: {e}"))?;
            trace("media ready");
            let stream::ScreenMediaStream {
                client,
                audio_udp,
                video_udp,
            } = media;
            let drains = [audio_udp]
                .into_iter()
                .map(|socket| tokio::spawn(async move { while socket.recv().await.is_ok() {} }))
                .collect();
            let frames = crate::frames::Frames::new(
                video_udp,
                our_ssrc,
                live::enabled() && !live::decode_off(),
            );
            let mut input = Input {
                client,
                drains,
                frames,
                touch: None,
                buttons: None,
            };
            tokio::time::sleep(hid_wait("POKI_HID_OPEN_MS", 1000)).await;
            if touch {
                input.touch = Some(Touch::connect_rsd(&mut device.adapter, &mut device.rsd).await?);
            }
            self.input = Some(input);
            timings.input_open_ms = Some(ms(started));
            return Ok(());
        }
        timings.reused_input = true;
        let input = self.input.as_mut().expect("open");
        if touch && input.touch.is_none() {
            input.touch = Some(Touch::connect_rsd(&mut device.adapter, &mut device.rsd).await?);
        }
        Ok(())
    }

    /// Opens the input services, retrying once on a fresh tunnel when a reused one fails.
    async fn prepare_input_or_retry(&mut self, touch: bool, timings: &mut Timings) -> Result<()> {
        let reused = self.link.is_some();
        match self.prepare_input(touch, timings).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.recover().await;
                if !reused || timings.retried {
                    return Err(error);
                }
                timings.retried = true;
                log(&format!(
                    "input services failed on a reused tunnel ({error}); reconnecting"
                ));
                self.prepare_input(touch, timings).await
            }
        }
    }

    async fn input_op(
        &mut self,
        request: Request,
        object: &Map<String, Value>,
        timings: &mut Timings,
    ) -> Result<Value> {
        let touch = uses_touch(&request);
        self.prepare_input_or_retry(touch, timings).await?;
        // A tap's first report is the only point where a failure means nothing reached the phone.
        let request = match request {
            Request::Tap { x, y, .. }
            | Request::LongPress { x, y, .. }
            | Request::DoubleTap { x, y, .. } => {
                if let Err(error) = self.contact(x, y).await {
                    self.recover().await;
                    if timings.retried {
                        return Err(error);
                    }
                    timings.retried = true;
                    log(&format!(
                        "touch report failed on a reused connection ({error}); reconnecting"
                    ));
                    self.prepare_input(true, timings).await?;
                    self.contact(x, y).await?;
                }
                parse(object)?
            }
            Request::TypeText {
                text,
                clear,
                submit,
                ..
            } if super::paste_again::quick::enabled() => {
                let result = Box::pin(self.quick_type(&text, clear, submit, object, timings)).await;
                if result.is_err() {
                    self.recover().await;
                }
                return result;
            }
            request => request,
        };
        let result = Box::pin(self.input_action(request)).await;
        if result.is_err() {
            self.recover().await;
        }
        result
    }

    /// type_text with its independent steps overlapped (see quick_type.rs), using the held tree
    /// when it is current and the live screen when it runs.
    async fn quick_type(
        &mut self,
        text: &str,
        clear: bool,
        submit: bool,
        object: &Map<String, Value>,
        timings: &mut Timings,
    ) -> Result<Value> {
        use super::paste_again::{Target, quick};
        let target: Option<Target> = match object.get("target") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value(value.clone())?),
        };
        let held = self.ax.as_ref().and_then(|watch| watch.current());
        let live = self
            .input
            .as_ref()
            .map(|input| input.frames.live())
            .filter(|live| live.decoding() && live.error().is_none());
        let device = &self.link.as_ref().expect("connected").device;
        let mut stages = quick::Stages::default();
        let result = quick::paste_text(
            &device.adapter,
            &device.rsd,
            held,
            live,
            text,
            clear,
            submit,
            target.as_ref(),
            &mut stages,
        )
        .await;
        log(&format!(
            "type_text stages: {}",
            serde_json::to_string(&stages).unwrap_or_default()
        ));
        timings.stages = Some(serde_json::to_value(&stages)?);
        result
    }

    /// The on-screen tree: a current read made when the screen settled, else the watched tree,
    /// with when it was asked for and whether the screen has changed since.
    async fn live_tree(&mut self, timings: &mut Timings) -> Result<Value> {
        let live = self.live_view();
        if let Some(live) = &live
            && let Some(read) = Box::pin(live::prefetched(
                &self.prefetch,
                &self.prefetch_events,
                live,
                Duration::from_millis(1500),
            ))
            .await
        {
            timings.ax = Some(crate::ax::watch::Served::Prefetched);
            let provenance = read.provenance(live);
            timings.tree = Some(provenance.clone());
            return Ok(with_provenance(read.tree, &provenance));
        }
        let requested = Instant::now();
        let tree = Box::pin(self.watched_tree(timings)).await?;
        if let Some(live) = &live {
            live.note_points(&tree);
        }
        let asked = self
            .ax
            .as_ref()
            .and_then(|watch| watch.latest_requested())
            .filter(|_| timings.ax != Some(crate::ax::watch::Served::Fallback))
            .unwrap_or(requested);
        let wall = std::time::SystemTime::now() - asked.elapsed();
        let provenance = json!({
            "request_started_at": crate::ax::watch::stamp_at(wall),
            "request_epoch": live.as_ref().map(|live| live.epoch_at(asked)),
            "request_generation": live.as_ref().map(|live| live.state(Duration::ZERO).session),
            "current": live.as_ref().map(|live| live.unchanged_since(asked)),
        });
        timings.tree = Some(provenance.clone());
        Ok(with_provenance(tree, &provenance))
    }

    /// The live screen, when it is being decoded.
    fn live_view(&self) -> Option<crate::frames::Live> {
        self.input
            .as_ref()
            .map(|input| input.frames.live())
            .filter(|live| live.decoding() && live.error().is_none())
    }

    async fn contact(&mut self, x: u16, y: u16) -> Result<()> {
        let touch = self
            .input
            .as_mut()
            .and_then(|i| i.touch.as_mut())
            .ok_or("no touch connection")?;
        touch
            .send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y, None)
            .await?;
        Ok(())
    }

    /// poki-native's input actions, on held connections. For taps the first contact has already been
    /// sent by `input_op`.
    async fn input_action(&mut self, request: Request) -> Result<Value> {
        let device = &mut self.link.as_mut().expect("connected").device;
        let input = self.input.as_mut().expect("open");
        let (adapter, rsd) = (&mut device.adapter, &mut device.rsd);
        match request {
            Request::Tap { x, y, duration_ms } | Request::LongPress { x, y, duration_ms } => {
                let hid = input.touch.as_mut().expect("touch");
                tokio::time::sleep(Duration::from_millis(duration_ms)).await;
                hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, None)
                    .await?;
            }
            Request::DoubleTap { x, y, duration_ms } => {
                let hid = input.touch.as_mut().expect("touch");
                tokio::time::sleep(Duration::from_millis(duration_ms)).await;
                hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, None)
                    .await?;
                tokio::time::sleep(Duration::from_millis(80)).await;
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::Drag {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
                hold_ms,
                end_hold_ms,
            } => {
                Drag {
                    x1,
                    y1,
                    x2,
                    y2,
                    duration_ms,
                    hold_ms,
                    end_hold_ms,
                }
                .send(input.touch.as_mut().expect("touch"))
                .await?;
            }
            Request::Pinch {
                x,
                y,
                start_distance,
                end_distance,
                angle,
                duration_ms,
            } => {
                Pinch {
                    x,
                    y,
                    start_distance,
                    end_distance,
                    angle,
                    duration_ms,
                }
                .send(input.touch.as_mut().expect("touch"))
                .await?;
            }
            Request::Key {
                key,
                modifiers,
                count,
            } => {
                let mut keyboard = Keyboard::connect(adapter, rsd).await?;
                let usages = modifiers
                    .iter()
                    .map(|m| modifier_usage(m))
                    .collect::<Result<Vec<_>>>()?;
                let outcome: Result<()> = async {
                    for _ in 0..count {
                        chord(&mut keyboard, key_usage(&key)?, &usages).await?;
                    }
                    Ok(())
                }
                .await;
                let cleanup = keyboard.close().await;
                outcome?;
                cleanup?;
            }
            Request::Button {
                button,
                count,
                interval_ms,
            } => {
                if input.buttons.is_none() {
                    input.buttons = Some(Indigo::connect_rsd(adapter, rsd).await?);
                }
                let buttons = input.buttons.as_mut().expect("buttons");
                let (code, duration) = button_usage(&button)?;
                for index in 0..count {
                    if index > 0 {
                        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                    }
                    buttons.send_button(0x0c, code, ButtonState::Down).await?;
                    tokio::time::sleep(Duration::from_millis(duration)).await;
                    buttons.send_button(0x0c, code, ButtonState::Up).await?;
                }
            }
            Request::TypeText {
                text,
                clear,
                submit,
                target,
            } => {
                let mut keyboard = Keyboard::connect(adapter, rsd).await?;
                let outcome = pasteboard::paste_text(
                    adapter,
                    rsd,
                    &mut keyboard,
                    &text,
                    clear,
                    submit,
                    target.as_ref(),
                )
                .await;
                let cleanup = keyboard.close().await;
                let result = outcome?;
                cleanup?;
                return Ok(result);
            }
            _ => unreachable!("not an input op"),
        }
        Ok(json!({"sent":true,"screen_change_verified":false}))
    }
}

#[cfg(test)]
mod daemon_tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("poki-bridged")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn socket_argument_comes_with_the_native_target_arguments() {
        let (socket, target) = parse_daemon_args(&args(&[
            "--socket",
            "/run/poki/a.sock",
            "--host",
            "192.0.2.1",
            "--rp-pairing-file",
            "/tmp/rp.plist",
        ]))
        .unwrap();
        assert_eq!(socket, PathBuf::from("/run/poki/a.sock"));
        assert!(matches!(target, Target::RemotePairing { .. }));
        let (_, target) =
            parse_daemon_args(&args(&["--udid", "X", "--socket", "/tmp/b.sock"])).unwrap();
        assert_eq!(target, Target::Usbmuxd { udid: "X".into() });
        for list in [
            &["--udid", "X"][..],
            &["--socket", "/tmp/a.sock"],
            &["--socket", "--udid", "X"],
            &["--socket", "", "--udid", "X"],
            &["--socket", "/a", "--socket", "/b", "--udid", "X"],
            &["--socket", "/a", "--udid"],
        ] {
            assert!(parse_daemon_args(&args(list)).is_err(), "{list:?}");
        }
    }

    #[test]
    fn requests_keep_their_id_out_of_the_native_request() {
        let (id, op, object) = split(r#"{"id":7,"op":"tap","x":1,"y":2}"#).unwrap();
        assert_eq!(id, json!(7));
        assert_eq!(op, "tap");
        assert!(parse(&object).is_ok());
        let (id, _, object) = split(r#"{"op":"ax_tree"}"#).unwrap();
        assert_eq!(id, Value::Null);
        assert!(matches!(
            parse(&object).unwrap(),
            Request::AxTree {
                include_offscreen: false
            }
        ));
        assert!(split("[1]").is_err());
        assert!(split("{").is_err());
        let (_, _, object) = split(r#"{"id":"a","op":"tap","x":1,"y":2,"extra":1}"#).unwrap();
        assert!(
            parse(&object).is_err(),
            "unknown fields are refused as poki-native refuses them"
        );
    }

    #[test]
    fn answers_carry_poki_native_output_verbatim() {
        let output = json!({"sent": true, "screen_change_verified": false, "x": 1.0});
        let answer = success(json!(1), &output, Timings::default());
        assert_eq!(answer["stdout"], json!(output.to_string()));
        assert_eq!(
            answer["stdout"].as_str().unwrap(),
            r#"{"screen_change_verified":false,"sent":true,"x":1.0}"#
        );
        let error: Box<dyn std::error::Error + Send + Sync> = "boom".into();
        let answer = failure(json!("q"), &*error, Timings::default());
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(
            answer["stderr"].as_str().unwrap(),
            r#"{"error":"boom","screen_change_verified":false}"#
        );
    }

    #[test]
    fn a_refused_tunnel_means_wifi_is_needed_and_silence_means_unreachable() {
        assert_eq!(
            classify("Connect: 100.64.0.9:49152: Connection refused (os error 111)"),
            "wifi_required"
        );
        assert_eq!(
            classify("Connect: 100.64.0.9:49152: no answer within 5s"),
            "unreachable"
        );
        assert_eq!(
            classify("Connect: No route to host (os error 113)"),
            "unreachable"
        );
        assert_eq!(classify("cannot read the pairing file"), "error");
        let down = TunnelDown {
            state: "wifi_required",
            since: std::time::SystemTime::UNIX_EPOCH,
            error: "refused".into(),
            attempts: 3,
        };
        assert_eq!(down.json()["message"], WIFI_REQUIRED);
        assert_eq!(down.json()["attempts"], 3);
    }

    #[test]
    fn only_reads_are_retried() {
        let read = |text: &str| reads_only(&parse(&split(text).unwrap().2).unwrap());
        assert!(read(r#"{"op":"ax_tree"}"#));
        assert!(read(r#"{"op":"app_for_pid","pid":42}"#));
        assert!(read(r#"{"op":"pasteboard","action":"get"}"#));
        assert!(read(r#"{"op":"configuration","method":"get_appearance"}"#));
        assert!(!read(r#"{"op":"pasteboard","action":"set","text":"x"}"#));
        assert!(!read(
            r#"{"op":"configuration","method":"set_appearance","value":"dark"}"#
        ));
        assert!(!read(r#"{"op":"tap","x":1,"y":1}"#));
        assert!(!read(r#"{"op":"rotate"}"#));
    }

    fn temp_socket(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pb-{name}-{}.sock",
            &uuid::Uuid::new_v4().to_string()[..8]
        ))
    }

    async fn ask(stream: &mut BufReader<UnixStream>, line: &str) -> Value {
        stream
            .get_mut()
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        let mut answer = String::new();
        stream.read_line(&mut answer).await.unwrap();
        serde_json::from_str(&answer).unwrap()
    }

    /// The daemon over a real socket, against a target it cannot reach: the answers match what
    /// poki-native prints for the same failure, and the socket protocol works end to end.
    /// The daemon runs on the main thread (8 MB of stack); unoptimized futures need more than the
    /// 2 MB a test thread has, so the test gets a thread like the daemon's.
    #[test]
    fn serves_requests_over_the_socket() {
        std::thread::Builder::new()
            .stack_size(8 << 20)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(tokio::task::LocalSet::new().run_until(serves_requests()));
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn serves_requests() {
        let socket = temp_socket("serve");
        let missing = std::env::temp_dir().join("poki-bridged-test-missing.plist");
        let target = Target::RemotePairing {
            host: "127.0.0.1".parse().unwrap(),
            rp_pairing_file: missing.clone(),
            host_name: Some("test".into()),
        };
        let listener = bind(&socket).await.unwrap();
        assert_eq!(
            bind(&socket).await.err().map(|e| e.to_string()).as_deref(),
            Some(ALREADY_RUNNING)
        );
        let state = Rc::new(State::new(target));
        let server = tokio::task::spawn_local(serve(listener, state.clone()));
        let mut client = BufReader::new(UnixStream::connect(&socket).await.unwrap());

        let pong = ask(&mut client, r#"{"id":1,"op":"ping"}"#).await;
        assert_eq!(pong["id"], json!(1));
        assert_eq!(pong["pong"]["tunnel"], json!(false));
        assert_eq!(pong["pong"]["foreground"], Value::Null, "no tree read yet");
        live::note_tree(
            &state.foreground,
            &json!({"foreground_app": {"pid": 77, "bundle_id": "com.apple.mobilenotes", "name": "Notes"}}),
        );
        let pong = ask(&mut client, r#"{"id":1,"op":"ping"}"#).await;
        assert_eq!(
            pong["pong"]["foreground"]["bundle_id"],
            "com.apple.mobilenotes"
        );
        assert_eq!(pong["pong"]["foreground"]["pid"], 77);
        // No bundle id in the tree: looked up by pid in the background, never waited for.
        live::note_tree(
            &state.foreground,
            &json!({"foreground_app": {"pid": 78, "bundle_id": null}}),
        );
        let pong = ask(&mut client, r#"{"id":1,"op":"ping"}"#).await;
        assert_eq!(pong["pong"]["foreground"]["resolving"], true);
        state.foreground.borrow_mut().known.insert(
            78,
            json!({"running": true, "bundle_id": "com.apple.Preferences", "name": "Settings"}),
        );
        let pong = ask(&mut client, r#"{"id":1,"op":"ping"}"#).await;
        assert_eq!(
            pong["pong"]["foreground"]["bundle_id"],
            "com.apple.Preferences"
        );
        assert_eq!(pong["pong"]["foreground"]["via"], "app_for_pid");

        let started = Instant::now();
        let answer = ask(&mut client, r#"{"id":2,"op":"ax_tree"}"#).await;
        println!(
            "unreachable ax_tree answered in {} ms: {answer}",
            ms(started)
        );
        assert_eq!(answer["ok"], json!(false));
        let expected = remote::read_pairing_file(&missing, Some("test"))
            .err()
            .unwrap()
            .to_string();
        assert_eq!(
            answer["stderr"].as_str().unwrap(),
            json!({"error": expected, "screen_change_verified": false}).to_string()
        );

        let answer = ask(&mut client, r#"{"id":3,"op":"tap","x":1}"#).await;
        assert_eq!(
            answer["ok"],
            json!(false),
            "invalid requests are refused before connecting"
        );
        let answer = ask(
            &mut client,
            r#"{"id":4,"op":"location","action":"set","latitude":1,"longitude":2}"#,
        )
        .await;
        assert!(answer["stderr"].as_str().unwrap().contains("held location"));
        let answer = ask(&mut client, "not json").await;
        assert_eq!(answer["ok"], json!(false));

        let answer = ask(&mut client, r#"{"id":5,"op":"shutdown"}"#).await;
        assert_eq!(answer["ok"], json!(true));
        server.await.unwrap().unwrap();
        assert_eq!(state.session.lock().await.ops, 3);
        let _ = std::fs::remove_file(&socket);
    }
}

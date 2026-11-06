//! See main.rs. Usage:
//!   poki-wda --host IP --rp-pairing-file PATH [--rp-host-name NAME] < requests.jsonl
//! It starts the runner (bundle POKI_WDA_BUNDLE, default com.facebook.WebDriverAgentRunner.xctrunner),
//! waits until GET /status answers on device port 8100, then sends each stdin line
//! {"method","path","body"?} to WDA and prints one JSON line per request with its time and answer.
//! "{session}" and "{element}" in a path are replaced by the last session and element IDs returned.
//!   poki-wda --serve --host IP --rp-pairing-file PATH ...   keep the runner up until SIGTERM
//! WDA is reached at the phone's address directly (POKI_WDA_ROUTE=tunnel uses the tunnel instead).

use super::*;
use idevice::dvt::xctest::{TestConfig, listener::XCUITestListener, run_over_rsd};
use idevice::installation_proxy::InstallationProxyClient;
use std::io::BufRead;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const WDA_PORT: u16 = 8100;
struct Quiet;
impl XCUITestListener for Quiet {}

pub fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("{}", json!({"event": "error", "error": error.to_string()}));
        std::process::exit(1);
    }
}

fn emit(start: Instant, mut value: Value) {
    value["t_ms"] = json!((start.elapsed().as_secs_f64() * 1000.0).round());
    println!("{value}");
}

/// One HTTP/1.1 request to WDA over the tunnel; returns (status, body).
/// Where WebDriverAgent is reached. WDA listens on the phone's IPv4 interfaces, which the tailnet
/// reaches directly; the tunnel's IPv6 address does not answer, so the tunnel only launches it.
enum Route {
    Direct(std::net::IpAddr),
    Tunnel(idevice::tcp::handle::AdapterHandle),
}

async fn http(route: &mut Route, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Vec<u8>)> {
    match route {
        Route::Direct(host) => {
            let mut stream = tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect((*host, WDA_PORT))).await??;
            exchange(&mut stream, method, path, body).await
        }
        Route::Tunnel(adapter) => {
            let mut stream = adapter.connect(WDA_PORT).await?;
            exchange(&mut stream, method, path, body).await
        }
    }
}

async fn exchange<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(stream: &mut S, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Vec<u8>)> {
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{WDA_PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    // WDA keeps connections alive despite "Connection: close", so the body ends at Content-Length,
    // at the last chunk, or at EOF, whichever the headers say; never wait for EOF alone.
    let mut raw = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let split = loop {
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") { break at; }
        let n = stream.read(&mut buf).await?;
        if n == 0 { return Err("connection closed before the HTTP headers ended".into()); }
        raw.extend_from_slice(&buf[..n]);
    };
    let lower = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let length = lower.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
    let chunked = lower.contains("transfer-encoding: chunked");
    loop {
        let have = raw.len() - (split + 4);
        let complete = match length {
            Some(length) => have >= length,
            None if chunked => raw.ends_with(b"0\r\n\r\n"),
            None => false,
        };
        if complete { break; }
        let n = stream.read(&mut buf).await?;
        if n == 0 { break; }
        raw.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut body = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = Vec::new();
        let mut rest = &body[..];
        while let Some(end) = rest.windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(String::from_utf8_lossy(&rest[..end]).trim(), 16).unwrap_or(0);
            if size == 0 { break; }
            let from = end + 2;
            out.extend_from_slice(&rest[from..(from + size).min(rest.len())]);
            rest = &rest[(from + size + 2).min(rest.len())..];
        }
        body = out;
    }
    Ok((status, body))
}

/// A launched runner: the tunnel it was started through and the task driving its test session.
/// Dropping it ends the session.
struct Launched {
    device: Device,
    runner: tokio::task::JoinHandle<std::result::Result<(), idevice::IdeviceError>>,
}

/// Launches the runner and waits until WDA answers /status (up to 90 s).
async fn launch(target: &Target, route: &mut Route, start: Instant) -> Result<Launched> {
    let mut device = connect_device(target).await?;
    emit(start, json!({"event": "connected"}));
    let version = device_ops::lockdown_get(&mut device.adapter, &mut device.rsd, None, "ProductVersion").await?;
    let major: u8 = version["value"].as_str().and_then(|v| v.split('.').next()).and_then(|v| v.parse().ok()).unwrap_or(17);
    let mut proxy = InstallationProxyClient::connect_rsd(&mut device.adapter, &mut device.rsd).await?;
    // A sideloading tool (AltStore, Sideloadly) may rename the bundle, for example by adding the team
    // ID, so without POKI_WDA_BUNDLE the runner is the installed user app whose ID names it.
    let bundle = match std::env::var("POKI_WDA_BUNDLE") {
        Ok(bundle) => bundle,
        Err(_) => {
            let apps = proxy.get_apps(Some("User"), None).await?;
            let mut ids: Vec<String> = apps.keys().filter(|id| id.contains("WebDriverAgentRunner") && id.contains("xctrunner")).cloned().collect();
            ids.sort();
            emit(start, json!({"event": "runner_candidates", "ids": ids}));
            ids.into_iter().next().ok_or("No WebDriverAgent runner is installed (no user app ID contains WebDriverAgentRunner and xctrunner).")?
        }
    };
    let config = TestConfig::from_installation_proxy(&mut proxy, &bundle, None).await?;
    emit(start, json!({"event": "runner_found", "bundle": bundle, "ios_major": major}));
    let mut runner_adapter = device.adapter.clone();
    let handshake = device.rsd.clone();
    let runner = tokio::spawn(async move {
        let mut listener = Quiet;
        run_over_rsd(&mut runner_adapter, &handshake, major, config, &mut listener, None).await
    });
    if let Route::Tunnel(adapter) = route { *adapter = device.adapter.clone(); }
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if runner.is_finished() {
            let result = runner.await.map_err(|e| e.to_string())?;
            return Err(format!("runner ended before WDA answered: {result:?}").into());
        }
        if let Ok(Ok((200, body))) = tokio::time::timeout(Duration::from_secs(3), http(route, "GET", "/status", None)).await {
            emit(start, json!({"event": "wda_ready", "status": serde_json::from_slice::<Value>(&body).ok()}));
            return Ok(Launched { device, runner });
        }
        if Instant::now() > deadline { runner.abort(); return Err("WDA did not answer on port 8100 within 90 s".into()); }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn route_for(target: &Target) -> Route {
    match target {
        Target::RemotePairing { host, .. } if std::env::var("POKI_WDA_ROUTE").as_deref() != Ok("tunnel") => Route::Direct(*host),
        // Replaced by the tunnel's own handle once one is open.
        _ => Route::Direct(std::net::IpAddr::from([127, 0, 0, 1])),
    }
}

/// --serve: keep a runner up until SIGTERM. Each 2 s it checks /status; after 10 s without an answer
/// it launches the runner again, and keeps trying (every 15 s) while the phone cannot be reached.
async fn serve(target: Target) -> Result<()> {
    let start = Instant::now();
    let mut route = route_for(&target);
    loop {
        let launched = match launch(&target, &mut route, start).await {
            Ok(launched) => launched,
            Err(error) => {
                emit(start, json!({"event": "launch_failed", "error": error.to_string()}));
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            }
        };
        println!("{}", json!({"event": "ready", "t_ms": (start.elapsed().as_secs_f64() * 1000.0).round()}));
        let mut silent_since: Option<Instant> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let alive = matches!(tokio::time::timeout(Duration::from_secs(3), http(&mut route, "GET", "/status", None)).await, Ok(Ok((200, _))));
            if alive { silent_since = None; continue; }
            let since = *silent_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(10) || launched.runner.is_finished() {
                emit(start, json!({"event": "runner_lost", "silent_ms": since.elapsed().as_millis() as u64, "runner_finished": launched.runner.is_finished()}));
                break;
            }
        }
        launched.runner.abort();
        drop(launched.device);
    }
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--serve") {
        let rest: Vec<String> = std::iter::once(args[0].clone()).chain(args[2..].iter().cloned()).collect();
        return serve(parse_args(&rest)?).await;
    }
    let target = parse_args(&args)?;
    let start = Instant::now();
    let mut adapter = route_for(&target);
    let Launched { device: _device, runner } = launch(&target, &mut adapter, start).await?;
    {
    }
    let lines: Vec<String> = std::io::stdin().lock().lines().collect::<std::io::Result<_>>()?;
    let (mut session, mut element) = (String::new(), String::new());
    for line in lines.iter().filter(|l| !l.trim().is_empty()) {
        let request: Value = serde_json::from_str(line)?;
        let method = request["method"].as_str().unwrap_or("GET");
        let path = request["path"].as_str().unwrap_or("/status").replace("{session}", &session).replace("{element}", &element);
        let sent = Instant::now();
        let (status, body) = http(&mut adapter, method, &path, request.get("body")).await?;
        let ms = (sent.elapsed().as_secs_f64() * 1000.0).round();
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if let Some(id) = parsed["sessionId"].as_str().or(parsed["value"]["sessionId"].as_str()) { session = id.to_string(); }
        if let Some(id) = parsed["value"]["ELEMENT"].as_str().or(parsed["value"]["element-6066-11e4-a52e-4f735466cecf"].as_str()) { element = id.to_string(); }
        let mut summary = parsed.clone();
        if let Some(value) = summary.get_mut("value") {
            if let Some(text) = value.as_str() { if text.len() > 400 { *value = json!({"string_bytes": text.len(), "head": &text[..300]}); } }
        }
        emit(start, json!({"event": "request", "label": request["label"], "method": method, "path": path, "status": status, "ms": ms, "bytes": body.len(), "answer": summary}));
        if let Some(save) = request["save_value_to"].as_str() {
            if let Some(text) = parsed["value"].as_str() { std::fs::write(save, text)?; }
        }
    }
    runner.abort();
    emit(start, json!({"event": "done"}));
    Ok(())
}

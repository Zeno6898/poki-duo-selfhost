//! See main.rs. Usage:
//!   poki-wda --host IP --rp-pairing-file PATH [--rp-host-name NAME] < requests.jsonl
//! It starts the runner (bundle POKI_WDA_BUNDLE, default com.facebook.WebDriverAgentRunner.xctrunner),
//! waits until GET /status answers on device port 8100, then sends each stdin line
//! {"method","path","body"?} to WDA and prints one JSON line per request with its time and answer.

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
async fn http(adapter: &mut idevice::tcp::handle::AdapterHandle, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Vec<u8>)> {
    let mut stream = adapter.connect(WDA_PORT).await?;
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{WDA_PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no HTTP header end")?;
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

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let target = parse_args(&args)?;
    let start = Instant::now();
    let mut device = connect_device(&target).await?;
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
    let mut adapter = device.adapter.clone();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if runner.is_finished() {
            let result = runner.await.map_err(|e| e.to_string())?;
            return Err(format!("runner ended before WDA answered: {result:?}").into());
        }
        if let Ok((200, body)) = http(&mut adapter, "GET", "/status", None).await {
            emit(start, json!({"event": "wda_ready", "status": serde_json::from_slice::<Value>(&body).ok()}));
            break;
        }
        if Instant::now() > deadline { return Err("WDA did not answer on port 8100 within 90 s".into()); }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let lines: Vec<String> = std::io::stdin().lock().lines().collect::<std::io::Result<_>>()?;
    let mut session = String::new();
    for line in lines.iter().filter(|l| !l.trim().is_empty()) {
        let request: Value = serde_json::from_str(line)?;
        let method = request["method"].as_str().unwrap_or("GET");
        let path = request["path"].as_str().unwrap_or("/status").replace("{session}", &session);
        let sent = Instant::now();
        let (status, body) = http(&mut adapter, method, &path, request.get("body")).await?;
        let ms = (sent.elapsed().as_secs_f64() * 1000.0).round();
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if let Some(id) = parsed["sessionId"].as_str().or(parsed["value"]["sessionId"].as_str()) { session = id.to_string(); }
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

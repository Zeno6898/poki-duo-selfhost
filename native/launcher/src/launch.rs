//! Launching the runner: find the installed runner app, start its test session through testmanagerd
//! and dtservicehub (run_over_rsd), and wait until WebDriverAgent answers.

use crate::device::{DEVELOPER_MODE_FIX, Device, Failure, Result};
use idevice::dvt::xctest::{TestConfig, listener::XCUITestListener, run_over_rsd};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
};

struct Quiet;
impl XCUITestListener for Quiet {}

pub const RUNNER_FIX: &str = "Install Poki Runner from the Poki source in AltStore, and open it once.";

/// The runner: the configured bundle, else the installed user app whose id names a WebDriverAgent
/// runner (AltStore and Sideloadly rename bundles, for example by adding the team id).
pub async fn find_runner(device: &mut Device, configured: Option<&str>) -> Result<String> {
    if let Some(bundle) = configured {
        return Ok(bundle.to_string());
    }
    let mut proxy = device.installation_proxy().await?;
    let apps = proxy.get_apps(Some("User"), None).await?;
    let mut ids: Vec<String> = apps.keys().filter(|id| id.contains("WebDriverAgentRunner") && id.contains("xctrunner")).cloned().collect();
    ids.sort();
    ids.into_iter().next().ok_or_else(|| Failure::new("Poki Runner is not installed").fix(RUNNER_FIX))
}

pub type Session = JoinHandle<std::result::Result<(), idevice::IdeviceError>>;

/// Starts the runner's test session. The session lives as long as the returned task and `device`.
pub async fn start(device: &mut Device, bundle: &str, ios: &str) -> Result<Session> {
    let major: u8 = ios.split('.').next().and_then(|v| v.parse().ok()).unwrap_or(17);
    let mut proxy = device.installation_proxy().await?;
    let config = TestConfig::from_installation_proxy(&mut proxy, bundle, None)
        .await
        .map_err(|e| Failure::new(format!("cannot read the runner's install info: {e}")).fix(RUNNER_FIX))?;
    let mut adapter = device.adapter.clone();
    let handshake = device.rsd.clone();
    Ok(tokio::spawn(async move {
        let mut listener = Quiet;
        run_over_rsd(&mut adapter, &handshake, major, config, &mut listener, None).await
    }))
}

/// Waits until WebDriverAgent answers /status at `wda`, or the session ends, or `limit` passes.
pub async fn wait_ready(session: &mut Session, wda: SocketAddr, limit: Duration) -> Result<()> {
    let until = Instant::now() + limit;
    loop {
        if session.is_finished() {
            let result = session.await.map_err(|e| Failure::new(e.to_string()))?;
            let detail = match result {
                Ok(()) => "the runner's test session ended before WebDriverAgent answered".to_string(),
                Err(e) => format!("the runner did not start: {e}"),
            };
            return Err(Failure::new(detail).fix(format!("{DEVELOPER_MODE_FIX} If it is on: in Settings → General → VPN & Device Management, trust the developer of Poki Runner.")));
        }
        if status(wda, Duration::from_secs(2)).await {
            return Ok(());
        }
        if Instant::now() > until {
            session.abort();
            return Err(Failure::new(format!("WebDriverAgent did not answer on port {} within {} s", wda.port(), limit.as_secs())));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// One GET /status; true when WebDriverAgent answers 200.
pub async fn status(wda: SocketAddr, timeout: Duration) -> bool {
    let attempt = async {
        let mut stream = TcpStream::connect(wda).await.ok()?;
        stream.write_all(b"GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.ok()?;
        let mut head = [0u8; 16];
        let n = stream.read(&mut head).await.ok()?;
        Some(head[..n].starts_with(b"HTTP/1.1 200") || head[..n].starts_with(b"HTTP/1.0 200"))
    };
    matches!(tokio::time::timeout(timeout, attempt).await, Ok(Some(true)))
}

use super::*;
use crate::device::{LOOPBACK_FIX, PAIRING_FIX, Pairing, PairingKind};
use idevice::remote_pairing::RpPairingFile;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("poki-launcher-{}-{name}", std::process::id()))
}

fn wait_for(events: &Arc<Mutex<Vec<Value>>>, seconds: u64, check: impl Fn(&[Value]) -> bool) -> bool {
    let until = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < until {
        if check(&events.lock().unwrap()) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn config_defaults_to_the_loopback_and_local_runner() {
    let config: Config = serde_json::from_str(r#"{"pairing_file": "/p"}"#).unwrap();
    assert_eq!(config.device_address.to_string(), "10.7.0.1");
    assert_eq!(config.wda_host.to_string(), "127.0.0.1");
    assert_eq!(config.wda_port, 8100);
}

#[test]
fn pairing_files_of_either_kind_are_told_apart() {
    let path = temp("rp.plist");
    std::fs::write(&path, RpPairingFile::generate("Poki").to_bytes()).unwrap();
    assert_eq!(Pairing::read(&path, None).unwrap().kind(), PairingKind::Remote);
    std::fs::write(&path, b"<plist><dict><key>x</key><string>y</string></dict></plist>").unwrap();
    let failure = Pairing::read(&path, None).err().unwrap();
    assert_eq!(failure.fix.as_deref(), Some(PAIRING_FIX));
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn without_the_loopback_it_waits_for_the_network_and_keeps_trying() {
    let path = temp("rp2.plist");
    std::fs::write(&path, RpPairingFile::generate("Poki").to_bytes()).unwrap();
    // Nothing listens on 127.0.0.1:49152 here, as on a phone whose loopback is off.
    let config: Config = serde_json::from_value(json!({"pairing_file": path, "device_address": "127.0.0.1"})).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let launcher = Arc::new(Launcher::new(config, Box::new(move |e| sink.lock().unwrap().push(e))));
    launcher.clone().start();
    assert!(wait_for(&events, 5, |e| e.iter().any(|v| v["state"] == "waiting_network" && v["fix"] == LOOPBACK_FIX)));
    // A restart cuts the backoff short: a second attempt comes at once.
    launcher.restart();
    assert!(wait_for(&events, 3, |e| e.iter().filter(|v| v["state"] == "connecting").count() >= 2));
    launcher.stop();
    assert_eq!(launcher.status()["state"], "idle");
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn status_is_true_only_for_a_200() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for answer in [&b"HTTP/1.1 200 OK\r\n\r\n{}"[..], &b"HTTP/1.1 500 Oops\r\n\r\n"[..]] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 256];
                let _ = stream.read(&mut buffer).await;
                stream.write_all(answer).await.unwrap();
            }
        });
        assert!(launch::status(address, Duration::from_secs(1)).await);
        assert!(!launch::status(address, Duration::from_secs(1)).await);
        // Nothing listening at all.
        assert!(!launch::status("127.0.0.1:9".parse().unwrap(), Duration::from_millis(300)).await);
    });
}

#[test]
fn pairing_advertises_what_bonjour_needs() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let config = pair::PairConfig { host_name: "Poki".into(), out_path: temp("paired.plist"), identity_path: Some(temp("identity")) };
    let task = runtime().spawn(pair::run(config, move |e| sink.lock().unwrap().push(e)));
    assert!(wait_for(&events, 3, |e| e.iter().any(|v| v["event"] == "advertise")));
    let advertise = events.lock().unwrap()[0].clone();
    assert_eq!(advertise["service_type"], "_remotepairing-pairable-host._tcp");
    assert!(advertise["port"].as_u64().unwrap() > 0);
    for key in ["name", "identifier", "authTag", "model"] {
        assert!(advertise["txt"][key].is_string(), "{key}");
    }
    assert_eq!(advertise["instance"], advertise["txt"]["identifier"]);
    task.abort();
    // The host identity is kept, so the phone recognizes Poki next time.
    assert_eq!(std::fs::read(temp("identity")).unwrap().len(), 16);
    let _ = std::fs::remove_file(temp("identity"));
}

#[test]
fn an_unreadable_config_gives_null() {
    extern "C" fn ignore(_: *mut c_void, _: *const c_char) {}
    let bad = CString::new("{").unwrap();
    assert!(unsafe { poki_launcher_new(bad.as_ptr(), ignore, std::ptr::null_mut()) }.is_null());
    let good = CString::new(r#"{"pairing_file": "/nowhere"}"#).unwrap();
    let launcher = unsafe { poki_launcher_new(good.as_ptr(), ignore, std::ptr::null_mut()) };
    assert!(!launcher.is_null());
    let status = unsafe { poki_launcher_status(launcher) };
    assert!(unsafe { CStr::from_ptr(status) }.to_str().unwrap().contains("idle"));
    unsafe {
        poki_string_free(status);
        poki_launcher_free(launcher);
    }
}

#[test]
fn disk_image_failures_name_their_own_fix() {
    use crate::ddi::classify;
    use idevice::IdeviceError;
    use idevice::cryptexd::CryptexdError;
    let refused = classify(&IdeviceError::UnexpectedResponse("TSS server responded with non-success status (STATUS=94&MESSAGE=This device isn't eligible)".into()));
    assert_eq!(refused.code, Some("ddi_refused"));
    let bad = classify(&IdeviceError::Cryptexd(CryptexdError::BadDdiBundle("no trustcache".into())));
    assert_eq!(bad.code, Some("ddi_bad"));
    let network = classify(&IdeviceError::Http("connection refused".into()));
    assert_eq!(network.code, Some("network"));
    assert_eq!(network.fix.as_deref(), Some(crate::device::NETWORK_FIX));
}

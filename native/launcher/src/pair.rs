//! On-device pairing (iOS 27): Poki plays the "pairable host". It listens on a TCP port, the app
//! advertises `_remotepairing-pairable-host._tcp` with the TXT records below (Bonjour, from Swift),
//! the person picks Poki in Settings and types the PIN Poki shows, and the result is an RPPairing file
//! the launcher then uses over the loopback. This is what StikPair does.

use idevice::remote_pairing::{PAIRABLE_HOST_SERVICE_TYPE, PairableHost, PairableHostInfo, RpPairingFile, RpPairingSocket};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::net::TcpListener;

pub struct PairConfig {
    pub host_name: String,
    pub out_path: PathBuf,
    /// Where to keep the host identity (alt_irk) so the phone recognizes Poki later.
    pub identity_path: Option<PathBuf>,
}

/// Runs one pairing: `emit` gets `advertise` (what to publish over Bonjour), `pin`, then `paired` or
/// `failed`. Ends after one pairing or on error.
pub async fn run(config: PairConfig, emit: impl Fn(Value) + Send + Sync + 'static) {
    if let Err(detail) = pair(&config, &emit).await {
        emit(json!({"event": "failed", "detail": detail}));
    }
}

async fn pair(config: &PairConfig, emit: &(impl Fn(Value) + Send + Sync)) -> Result<(), String> {
    let mut info = PairableHostInfo::generate(&config.host_name, "Mac17,7");
    if let Some(path) = &config.identity_path {
        if let Ok(bytes) = std::fs::read(path) {
            if bytes.len() == 16 {
                info.alt_irk.copy_from_slice(&bytes);
            }
        } else {
            let _ = std::fs::write(path, info.alt_irk);
        }
    }
    let mut file = RpPairingFile::generate(&config.host_name);
    let identifier = file.identifier().to_string();
    let listener = TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| format!("cannot listen for the phone: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let txt: serde_json::Map<String, Value> = info.mdns_txt_records(&identifier).into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    emit(json!({
        "event": "advertise",
        "service_type": PAIRABLE_HOST_SERVICE_TYPE.trim_end_matches(".local."),
        "instance": identifier,
        "port": port,
        "txt": txt,
    }));
    let (stream, _) = listener.accept().await.map_err(|e| format!("the phone did not connect: {e}"))?;
    let mut host = PairableHost::new(RpPairingSocket::new_device(stream), info);
    host.accept(&mut file, |pin| {
        emit(json!({"event": "pin", "pin": pin}));
        async {}
    })
    .await
    .map_err(|e| format!("pairing failed: {e}"))?;
    let mut bytes = file.to_bytes();
    // Remember the name it was made with, for the requests that send it.
    if let Ok(mut dict) = plist::from_bytes::<plist::Dictionary>(&bytes) {
        dict.insert(crate::remote::SENDING_HOST_KEY.into(), config.host_name.clone().into());
        bytes.clear();
        let _ = plist::to_writer_xml(&mut bytes, &dict);
    }
    std::fs::write(&config.out_path, &bytes).map_err(|e| format!("cannot save the pairing file: {e}"))?;
    emit(json!({"event": "paired", "path": config.out_path.display().to_string()}));
    Ok(())
}

//! One-call device services that Poki otherwise reaches through idevice-tools: lockdown values,
//! DVT screenshots and location simulation, device rotation and the pasteboard. Each runs inside the
//! bridge's tunnel, so it works for the remote pairing target, where lockdown on port 62078 is closed.
use super::Result;
use idevice::{
    RsdService,
    core_device::{
        GENERAL_PASTEBOARD, Orientation, OrientationServiceClient, PasteboardPayload,
        PasteboardServiceClient, RotationDirection,
    },
    dvt::{
        location_simulation::LocationSimulationClient, remote_server::RemoteServerClient,
        screenshot::ScreenshotClient,
    },
    lockdown::LockdownClient,
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};

/// How often a held location is sent again, as idevice-tools does.
const LOCATION_REFRESH: Duration = Duration::from_secs(5);
const MAX_TEXT: usize = 1024 * 1024;

fn plain(name: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("{name} must be 1..256 characters without control characters").into());
    }
    Ok(())
}

pub fn validate_lockdown(domain: Option<&str>, key: &str) -> Result<()> {
    plain("key", key)?;
    if let Some(domain) = domain {
        plain("domain", domain)?;
    }
    Ok(())
}

pub fn validate_screenshot(path: &str) -> Result<()> {
    let path = Path::new(path);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("path must be an absolute file path".into());
    }
    Ok(())
}

pub fn direction(name: &str) -> Result<RotationDirection> {
    Ok(match name {
        "left" => RotationDirection::Left,
        "right" => RotationDirection::Right,
        _ => return Err("direction must be left or right".into()),
    })
}

pub fn validate_pasteboard(action: &str, text: Option<&str>) -> Result<()> {
    match (action, text) {
        ("get" | "items", None) => Ok(()),
        ("set", Some(text)) if text.len() <= MAX_TEXT => Ok(()),
        ("set", Some(_)) => Err("text exceeds 1 MiB".into()),
        _ => Err("pasteboard action must be get, items, or set with text".into()),
    }
}

pub fn validate_location(
    action: &str,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<()> {
    match (action, latitude, longitude) {
        ("clear", None, None) => Ok(()),
        ("set", Some(lat), Some(lon))
            if lat.is_finite()
                && lon.is_finite()
                && (-90.0..=90.0).contains(&lat)
                && (-180.0..=180.0).contains(&lon) =>
        {
            Ok(())
        }
        ("set", Some(_), Some(_)) => Err("latitude must be -90..90 and longitude -180..180".into()),
        _ => Err("location action must be clear, or set with latitude and longitude".into()),
    }
}

pub async fn lockdown_get(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    domain: Option<&str>,
    key: &str,
) -> Result<Value> {
    let mut lockdown = LockdownClient::connect_rsd(adapter, rsd).await?;
    let value = lockdown.get_value(Some(key), domain).await?;
    Ok(json!({"key": key, "domain": domain, "value": serde_json::to_value(value)?}))
}

async fn instruments(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
) -> Result<RemoteServerClient<Box<dyn idevice::ReadWrite>>> {
    let mut client = RemoteServerClient::connect_rsd(adapter, rsd)
        .await
        .map_err(|e| {
            format!(
                "Cannot reach the instruments service ({e}). Is the developer disk image mounted?"
            )
        })?;
    client.read_message(0).await?;
    Ok(client)
}

pub async fn screenshot(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    path: &str,
) -> Result<Value> {
    let mut server = instruments(adapter, rsd).await?;
    let png = ScreenshotClient::new(&mut server)
        .await?
        .take_screenshot()
        .await?;
    write_new(Path::new(path), &png)?;
    Ok(json!({"path": path, "bytes": png.len()}))
}

/// Writes a file that must not exist yet, readable only by this user.
fn write_new(path: &Path, data: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    file.write_all(data)?;
    Ok(())
}

/// The orientation names idevice-tools prints, which Poki already matches.
pub fn orientation_name(orientation: &Orientation) -> String {
    match orientation {
        Orientation::Unknown(other) => other.clone(),
        known => format!("{known:?}"),
    }
}

pub async fn rotate(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    name: &str,
) -> Result<Value> {
    let mut client = OrientationServiceClient::connect_rsd(adapter, rsd).await?;
    let state = client.rotate(direction(name)?).await?;
    Ok(json!({
        "orientation": orientation_name(&state.orientation),
        "non_flat_orientation": orientation_name(&state.non_flat_orientation),
        "locked": state.locked,
    }))
}

pub async fn pasteboard(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    action: &str,
    text: Option<&str>,
) -> Result<Value> {
    validate_pasteboard(action, text)?;
    let mut client = PasteboardServiceClient::connect_rsd(adapter, rsd).await?;
    if let Some(text) = text {
        client.set_text(text, GENERAL_PASTEBOARD).await?;
        return Ok(json!({"copied": true, "bytes": text.len()}));
    }
    let snapshot = client.get(GENERAL_PASTEBOARD).await?;
    if action == "get" {
        return Ok(json!({"text": snapshot.text()}));
    }
    let items: Vec<Value> = snapshot
        .items
        .iter()
        .flat_map(|item| {
            item.data.iter().map(|entry| {
                let (state, size) = match &entry.payload {
                    PasteboardPayload::Inline(bytes) => ("inline", Some(bytes.len() as i64)),
                    PasteboardPayload::Promised { size } => ("promised", *size),
                    PasteboardPayload::Error(_) => ("error", None),
                };
                json!({"index": item.index, "uti": entry.uti, "state": state, "size": size})
            })
        })
        .collect();
    Ok(json!({"items": items}))
}

/// Clears the simulated location, or sets it and holds it. A held location prints one JSON line
/// when the device accepts it, then sends it again every five seconds until the process is ended:
/// the device drops a simulated location when its instruments connection closes.
pub async fn location(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    action: &str,
    coordinates: Option<(f64, f64)>,
) -> Result<Value> {
    let mut server = instruments(adapter, rsd).await?;
    let mut client = LocationSimulationClient::new(&mut server).await?;
    let Some((latitude, longitude)) = coordinates.filter(|_| action == "set") else {
        client.clear().await?;
        return Ok(json!({"cleared": true}));
    };
    client.set(latitude, longitude).await?;
    let ready = json!({"location_set": true, "latitude": latitude, "longitude": longitude});
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{ready}")?;
    stdout.flush()?;
    loop {
        tokio::time::sleep(LOCATION_REFRESH).await;
        client.set(latitude, longitude).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockdown_keys_are_checked() {
        assert!(validate_lockdown(None, "DeviceName").is_ok());
        assert!(validate_lockdown(Some("com.apple.mobile.iTunes"), "ScreenScaleFactor").is_ok());
        assert!(validate_lockdown(None, "").is_err());
        assert!(validate_lockdown(Some(""), "DeviceName").is_err());
        assert!(validate_lockdown(None, "Device\nName").is_err());
        assert!(validate_lockdown(None, &"k".repeat(257)).is_err());
    }

    #[test]
    fn screenshot_paths_must_be_absolute_files() {
        assert!(validate_screenshot("/tmp/frame.png").is_ok());
        assert!(validate_screenshot("frame.png").is_err());
        assert!(validate_screenshot("/").is_err());
        assert!(validate_screenshot("").is_err());
    }

    #[test]
    fn rotation_accepts_left_and_right() {
        assert_eq!(direction("left").unwrap(), RotationDirection::Left);
        assert_eq!(direction("right").unwrap(), RotationDirection::Right);
        assert!(direction("up").is_err());
        assert_eq!(
            orientation_name(&Orientation::LandscapeLeft),
            "LandscapeLeft"
        );
        assert_eq!(
            orientation_name(&Orientation::PortraitUpsideDown),
            "PortraitUpsideDown"
        );
        assert_eq!(
            orientation_name(&Orientation::Unknown("tilted".into())),
            "tilted"
        );
    }

    #[test]
    fn pasteboard_actions_are_checked() {
        assert!(validate_pasteboard("get", None).is_ok());
        assert!(validate_pasteboard("items", None).is_ok());
        assert!(validate_pasteboard("set", Some("")).is_ok());
        assert!(validate_pasteboard("set", None).is_err());
        assert!(validate_pasteboard("get", Some("x")).is_err());
        assert!(validate_pasteboard("watch", None).is_err());
        assert!(validate_pasteboard("set", Some(&"x".repeat(MAX_TEXT + 1))).is_err());
    }

    #[test]
    fn location_coordinates_are_checked() {
        assert!(validate_location("clear", None, None).is_ok());
        assert!(validate_location("set", Some(37.33), Some(-122.03)).is_ok());
        assert!(validate_location("set", Some(-90.0), Some(180.0)).is_ok());
        assert!(validate_location("set", Some(91.0), Some(0.0)).is_err());
        assert!(validate_location("set", Some(0.0), Some(-180.5)).is_err());
        assert!(validate_location("set", Some(f64::NAN), Some(0.0)).is_err());
        assert!(validate_location("set", Some(1.0), None).is_err());
        assert!(validate_location("clear", Some(1.0), Some(1.0)).is_err());
        assert!(validate_location("move", None, None).is_err());
    }
}

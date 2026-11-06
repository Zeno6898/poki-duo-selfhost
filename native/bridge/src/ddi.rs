//! The developer disk image, installed as a Cryptex1 cryptex through `cryptexd` inside the bridge's
//! tunnel. This is what idevice-tools' `cryptexd install-ddi` does, but it also reaches the remote
//! pairing target, where idevice-tools cannot start its tunnel. Newer phones (the iPhone 18 series)
//! have no image mounter build identity in Apple's DDI, so the Cryptex1 route is the only one that
//! works for them; it works on every device from iOS 17.4.
use super::Result;
use idevice::{
    cryptexd::{Cryptex1Assets, install_ddi, installed_ddi},
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use serde_json::{Value, json};
use std::path::Path;

pub const DISPLAY_SERVICE: &str = "com.apple.coredevice.displayservice";
const CRYPTEXD: &str = "com.apple.security.cryptexd.remote";

pub fn validate_dir(dir: &str) -> Result<()> {
    if !Path::new(dir).is_absolute() {
        return Err("dir must be an absolute directory path".into());
    }
    Ok(())
}

/// Whether the tunnel's services already include the display service, which the device only
/// advertises once a developer disk image is installed.
pub async fn status(adapter: &mut AdapterHandle, rsd: &mut RsdHandshake) -> Result<Value> {
    let displayservice = rsd.services.contains_key(DISPLAY_SERVICE);
    let cryptexd = rsd.services.contains_key(CRYPTEXD);
    let installed = if cryptexd {
        installed_ddi(adapter, rsd)
            .await
            .ok()
            .flatten()
            .map(|c| json!({"identifier": c.identifier, "version": c.version}))
    } else {
        None
    };
    Ok(json!({
        "displayservice": displayservice,
        "cryptexd": cryptexd,
        "services": rsd.services.len(),
        "installed": installed,
    }))
}

/// Personalizes the image in `dir` (an unpacked Cryptex1 `Restore` directory) with Apple's signing
/// server and installs it. The services list of this tunnel was fixed when it opened, so the caller
/// checks for the display service on a new connection.
pub async fn install(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    dir: &str,
    force: bool,
) -> Result<Value> {
    if !force && rsd.services.contains_key(DISPLAY_SERVICE) {
        return Ok(json!({"installed": false, "already_available": true}));
    }
    if !rsd.services.contains_key(CRYPTEXD) {
        return Err(format!(
            "The device does not offer {CRYPTEXD}. It needs iOS 17.4 or later with Developer Mode on."
        )
        .into());
    }
    let assets = Cryptex1Assets::load(dir).await?;
    let cryptex = install_ddi(adapter, rsd, &assets)
        .await
        .map_err(|e| format!("Installing the developer disk image failed: {e}"))?;
    Ok(json!({
        "installed": true,
        "already_available": false,
        "identifier": cryptex.identifier,
        "version": cryptex.version,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_must_be_absolute() {
        assert!(validate_dir("/var/lib/poki/ddi").is_ok());
        assert!(validate_dir("ddi").is_err());
        assert!(validate_dir("").is_err());
    }
}

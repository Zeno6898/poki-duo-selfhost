//! The developer disk image. The phone offers testmanagerd and dtservicehub only while it is mounted;
//! it stays mounted until the phone restarts. Installed as a Cryptex1 cryptex through cryptexd, which
//! personalizes it with Apple's signing server (TSS), so the first mount after a restart needs the
//! internet. The image itself (an unpacked Cryptex1 `Restore` directory: BuildManifest.plist,
//! Image.dmg, Image.dmg.trustcache, …) is downloaded by the app into `ddi_dir`.

use crate::device::{DEVELOPER_MODE_FIX, Device, Failure, Result};
use idevice::cryptexd::{Cryptex1Assets, install_ddi};
use std::path::Path;

/// Present only while a developer disk image is mounted.
pub const MOUNTED_MARKERS: [&str; 2] = ["com.apple.instruments.dtservicehub", "com.apple.dt.testmanagerd.remote"];
const CRYPTEXD: &str = "com.apple.security.cryptexd.remote";
pub const DDI_FILES: [&str; 2] = ["BuildManifest.plist", "Image.dmg"];

pub fn mounted(device: &Device) -> bool {
    MOUNTED_MARKERS.iter().all(|name| device.rsd.services.contains_key(*name))
}

pub fn files_present(dir: &str) -> bool {
    !dir.is_empty() && DDI_FILES.iter().all(|name| Path::new(dir).join(name).is_file())
}

/// Mounts the image. The services list of this tunnel was fixed when it opened, so the caller opens
/// a new tunnel afterwards to use the services.
pub async fn mount(device: &mut Device, dir: &str) -> Result<()> {
    if !device.rsd.services.contains_key(CRYPTEXD) {
        return Err(Failure::new("the phone does not offer cryptexd (it needs iOS 17.4 or later with Developer Mode on)").fix(DEVELOPER_MODE_FIX));
    }
    if !files_present(dir) {
        return Err(Failure::new("the developer disk image has not been downloaded").fix("Open Poki and let it download the developer disk image (about 20 MB), once."));
    }
    let assets = Cryptex1Assets::load(dir).await.map_err(|e| Failure::new(format!("the developer disk image in the app is unreadable: {e}")).fix("Open Poki and download the developer disk image again."))?;
    install_ddi(&mut device.adapter, &mut device.rsd, &assets).await.map_err(|e| {
        Failure::new(format!("mounting the developer disk image failed: {e}")).fix("Mounting needs the internet once after each restart (Apple signs the image for this phone). Check the connection and try again.")
    })?;
    Ok(())
}

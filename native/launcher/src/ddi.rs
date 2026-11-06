//! The developer disk image. The phone offers testmanagerd and dtservicehub only while it is mounted;
//! it stays mounted until the phone restarts. Installed as a Cryptex1 cryptex through cryptexd, which
//! personalizes it with Apple's signing server (TSS), so the first mount after a restart needs the
//! internet. The image itself (an unpacked Cryptex1 `Restore` directory: BuildManifest.plist,
//! Image.dmg, Image.dmg.trustcache, …) is downloaded by the app into `ddi_dir`.

use crate::device::{DDI_BAD_FIX, DDI_REFUSED_FIX, DEVELOPER_MODE_FIX, Device, Failure, NETWORK_FIX, Result};
use idevice::IdeviceError;
use idevice::cryptexd::{Cryptex1Assets, CryptexdError, install_ddi};
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
    install_ddi(&mut device.adapter, &mut device.rsd, &assets).await.map_err(|e| classify(&e))?;
    Ok(())
}

/// What went wrong with an install, and the one thing to do about it.
pub fn classify(error: &IdeviceError) -> Failure {
    let failure = Failure::new(format!("mounting the developer disk image failed: {error}"));
    match error {
        // Apple's signing server answered, but said no: this image is not for this iOS.
        IdeviceError::UnexpectedResponse(text) if text.contains("TSS server responded") => failure.fix(DDI_REFUSED_FIX).code("ddi_refused"),
        // The phone could not install what it was given: the files are bad.
        IdeviceError::Cryptexd(CryptexdError::RoutineFailed { .. } | CryptexdError::BadDdiBundle(_)) => failure.fix(DDI_BAD_FIX).code("ddi_bad"),
        // Anything else on the way to gs.apple.com is the network.
        _ => failure.fix(NETWORK_FIX).code("network"),
    }
}

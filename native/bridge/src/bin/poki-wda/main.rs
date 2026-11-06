//! poki-wda: launches a WebDriverAgent runner through testmanagerd over the remote pairing tunnel and
//! relays WebDriver HTTP requests to it. Fork-only spike (poki-remote, dev/wda-runner). It builds
//! poki-native's sources unchanged, the way poki-bridged does.
#![allow(dead_code)]

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Touch = idevice::core_device::hid::UniversalHidServiceClient<Box<dyn idevice::ReadWrite>>;

mod ax {
    include!("../../ax.rs");
}

#[path = "../.."]
mod src {
    include!("../../main.rs");

    #[path = "bin/poki-wda/wda.rs"]
    pub mod wda;
}

fn main() {
    src::wda::main();
}

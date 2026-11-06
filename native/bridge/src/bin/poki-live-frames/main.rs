//! poki-live-frames: a measurement tool for a continuous screen feed. Fork-only (poki-remote).
//!
//! It opens the CoreDevice display stream that input sessions already open and discard, keeps it
//! open, and reports how the HEVC video arrives: one JSON line per access unit on stderr (arrival
//! time, RTP timestamp, size, whether it is a keyframe) and the Annex-B stream on stdout for a
//! decoder. Optional phases hold an input session on the same tunnel and send status-bar taps, to
//! see whether input interrupts the stream. It builds poki-native's sources unchanged, the same way
//! poki-bridged does.
#![allow(dead_code)]

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Touch = idevice::core_device::hid::UniversalHidServiceClient<Box<dyn idevice::ReadWrite>>;

mod ax {
    include!("../../ax.rs");
}

#[path = "../.."]
mod src {
    include!("../../main.rs");

    #[path = "bin/poki-live-frames/live.rs"]
    pub mod live;
}

fn main() {
    src::live::main();
}

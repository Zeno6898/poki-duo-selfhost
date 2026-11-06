//! poki-bridged: a long-lived native bridge for one device. Fork-only (poki-remote).
//!
//! poki-native opens a tunnel, the input services and an accessibility subscription for every op and
//! closes them when it exits. This binary keeps them open between ops and takes the same op requests
//! as newline-delimited JSON on a Unix socket. See daemon.rs for the protocol.
//!
//! It shares poki-native's code by compiling poki-native's own sources: `src/main.rs` and the modules
//! it declares are included below as the module `src`, unchanged, and the daemon is a child of that
//! module so it can call the same functions. Nothing in poki-native is edited, so poki-native builds and
//! behaves as before. Its `main` function is compiled here as an ordinary unused function.
#![allow(dead_code)]

// gesture.rs and pasteboard.rs name these through `crate::`; in poki-native the crate root is
// main.rs. They are the same aliases and the same module source.
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Touch = idevice::core_device::hid::UniversalHidServiceClient<Box<dyn idevice::ReadWrite>>;
// The same source again, with a child that holds a subscription open (see ax_watch.rs).
#[path = "."]
mod ax {
    include!("../../ax.rs");

    #[path = "ax_watch.rs"]
    pub mod watch;
}

// The live screen (J1): the input media session's video, decoded in-process with libavcodec.
#[path = "frames.rs"]
mod frames;
#[path = "libav.rs"]
mod libav;
#[path = "ocr.rs"]
mod ocr;

#[path = "../.."]
mod src {
    include!("../../main.rs");

    #[path = "bin/poki-bridged/daemon.rs"]
    pub mod daemon;

    // pasteboard.rs again, with a child that runs type_text with its steps overlapped (see
    // quick_type.rs). The child reuses the file's private checks and result builders.
    #[path = "."]
    mod paste_again {
        include!("../../pasteboard.rs");

        #[path = "bin/poki-bridged/quick_type.rs"]
        pub mod quick;
    }
}

fn main() {
    src::daemon::main();
}

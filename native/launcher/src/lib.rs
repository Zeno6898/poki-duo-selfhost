//! PokiLauncher: gets the WebDriverAgent runner up on the phone it runs on, keeps it up, and pairs
//! the phone with itself. A C ABI for the Poki app (include/poki_launcher.h); docs/ios-core.md §3.

pub mod ddi;
pub mod device;
pub mod launch;
pub mod pair;
pub mod remote;
pub mod supervisor;

use serde_json::Value;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::{Arc, OnceLock},
};

pub use supervisor::{Config, Launcher};

/// One runtime for everything the library does, on two worker threads.
pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("poki-launcher")
            .enable_all()
            .build()
            .expect("the launcher's runtime")
    })
}

pub type EventCallback = extern "C" fn(context: *mut c_void, event_json: *const c_char);

/// The app's callback and its context pointer, callable from any thread.
#[derive(Clone, Copy)]
struct Callback {
    function: EventCallback,
    context: *mut c_void,
}
unsafe impl Send for Callback {}
unsafe impl Sync for Callback {}

impl Callback {
    fn call(&self, value: &Value) {
        if let Ok(text) = CString::new(value.to_string()) {
            (self.function)(self.context, text.as_ptr());
        }
    }
}

unsafe fn read_str(text: *const c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(text) }.to_str().ok().map(String::from)
}

pub struct PokiLauncher {
    inner: Arc<Launcher>,
}

/// Makes a launcher from its JSON config; null when the config is unreadable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_new(config_json: *const c_char, cb: EventCallback, context: *mut c_void) -> *mut PokiLauncher {
    let Some(text) = (unsafe { read_str(config_json) }) else { return std::ptr::null_mut() };
    let Ok(config) = serde_json::from_str::<Config>(&text) else { return std::ptr::null_mut() };
    let callback = Callback { function: cb, context };
    let launcher = Launcher::new(config, Box::new(move |event| callback.call(&event)));
    Box::into_raw(Box::new(PokiLauncher { inner: Arc::new(launcher) }))
}

/// Starts keeping the runner up; 0 when started (or already running).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_start(launcher: *mut PokiLauncher) -> i32 {
    let Some(launcher) = (unsafe { launcher.as_ref() }) else { return -1 };
    launcher.inner.clone().start();
    0
}

/// Drops the session and launches again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_restart(launcher: *mut PokiLauncher) {
    if let Some(launcher) = unsafe { launcher.as_ref() } {
        launcher.inner.restart();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_stop(launcher: *mut PokiLauncher) {
    if let Some(launcher) = unsafe { launcher.as_ref() } {
        launcher.inner.stop();
    }
}

/// The latest state as JSON; free it with poki_string_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_status(launcher: *mut PokiLauncher) -> *mut c_char {
    let Some(launcher) = (unsafe { launcher.as_ref() }) else { return std::ptr::null_mut() };
    CString::new(launcher.inner.status().to_string()).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_launcher_free(launcher: *mut PokiLauncher) {
    if !launcher.is_null() {
        let launcher = unsafe { Box::from_raw(launcher) };
        launcher.inner.stop();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

pub struct PokiPairing {
    task: tokio::task::JoinHandle<()>,
}

/// Starts one on-device pairing. config_json: {"host_name": "Poki", "out_path": "...",
/// "identity_path": "..."}. Events: advertise {service_type, instance, port, txt}, pin {pin},
/// paired {path}, failed {detail}. Null when the config is unreadable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_pair_start(config_json: *const c_char, cb: EventCallback, context: *mut c_void) -> *mut PokiPairing {
    let Some(text) = (unsafe { read_str(config_json) }) else { return std::ptr::null_mut() };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return std::ptr::null_mut() };
    let Some(out_path) = value["out_path"].as_str() else { return std::ptr::null_mut() };
    let config = pair::PairConfig {
        host_name: value["host_name"].as_str().unwrap_or("Poki").to_string(),
        out_path: out_path.into(),
        identity_path: value["identity_path"].as_str().map(Into::into),
    };
    let callback = Callback { function: cb, context };
    let task = runtime().spawn(pair::run(config, move |event| callback.call(&event)));
    Box::into_raw(Box::new(PokiPairing { task }))
}

/// Stops a pairing (if still running) and frees it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn poki_pair_cancel(pairing: *mut PokiPairing) {
    if !pairing.is_null() {
        let pairing = unsafe { Box::from_raw(pairing) };
        pairing.task.abort();
    }
}

#[cfg(test)]
mod tests;

//! Keeps the runner up: connect, mount the developer disk image if needed, launch, watch, and start
//! again whenever it stops answering. It never gives up by itself; between attempts it waits with
//! backoff, and a restart command cuts the wait short.

use crate::{
    ddi,
    device::{DDI_TIMEOUT_FIX, Device, Failure, LOOPBACK_FIX, NETWORK_FIX, Pairing},
    launch,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_address")]
    pub device_address: IpAddr,
    pub pairing_file: PathBuf,
    #[serde(default)]
    pub host_name: Option<String>,
    #[serde(default)]
    pub ddi_dir: String,
    #[serde(default)]
    pub runner_bundle: Option<String>,
    #[serde(default = "default_wda_host")]
    pub wda_host: IpAddr,
    #[serde(default = "default_wda_port")]
    pub wda_port: u16,
}

/// The longest a disk image mount may take (Apple's signing server plus the upload).
const DDI_MOUNT_TIMEOUT: Duration = Duration::from_secs(120);

fn default_address() -> IpAddr {
    IpAddr::from([10, 7, 0, 1])
}
fn default_wda_host() -> IpAddr {
    IpAddr::from([127, 0, 0, 1])
}
fn default_wda_port() -> u16 {
    8100
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Run,
    Restart(u64),
    Stop,
}

pub struct Launcher {
    config: Config,
    emit: Box<dyn Fn(Value) + Send + Sync>,
    status: Mutex<Value>,
    commands: watch::Sender<Command>,
    started: Instant,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// How often the runner is checked, and after how many misses it is launched again.
    pub check_every: Duration,
    pub misses_allowed: u32,
}

impl Launcher {
    pub fn new(config: Config, emit: Box<dyn Fn(Value) + Send + Sync>) -> Self {
        let (commands, _) = watch::channel(Command::Stop);
        Self {
            config,
            emit,
            status: Mutex::new(json!({"state": "idle", "attempt": 0})),
            commands,
            started: Instant::now(),
            thread: Mutex::new(None),
            check_every: Duration::from_secs(5),
            misses_allowed: 2,
        }
    }

    pub fn status(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, state: &str, attempt: u32, extra: Value) {
        let mut value = json!({"state": state, "attempt": attempt, "since_ms": self.started.elapsed().as_millis() as u64});
        if let (Some(object), Value::Object(more)) = (value.as_object_mut(), extra) {
            object.extend(more);
        }
        *self.status.lock().unwrap() = value.clone();
        (self.emit)(value);
    }

    fn fail(&self, attempt: u32, failure: &Failure) {
        let waiting = matches!(failure.fix.as_deref(), Some(LOOPBACK_FIX) | Some(NETWORK_FIX) | Some(DDI_TIMEOUT_FIX));
        let state = if waiting { "waiting_network" } else { "failed" };
        self.set(state, attempt, json!({"detail": failure.detail, "fix": failure.fix, "code": failure.code}));
    }

    /// Runs the supervisor on a thread of its own with a single-threaded runtime: idevice's futures
    /// are not all provably Send, which a multi-threaded spawn would need.
    pub fn start(self: std::sync::Arc<Self>) {
        let mut thread = self.thread.lock().unwrap();
        if thread.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        self.commands.send_replace(Command::Run);
        let me = self.clone();
        *thread = Some(std::thread::Builder::new().name("poki-launcher".into()).stack_size(8 << 20).spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("the launcher's runtime");
            runtime.block_on(me.run());
        }).expect("the launcher's thread"));
    }

    pub fn restart(&self) {
        self.commands.send_modify(|c| {
            *c = match *c {
                Command::Stop => Command::Stop,
                Command::Run => Command::Restart(1),
                Command::Restart(n) => Command::Restart(n + 1),
            }
        });
    }

    pub fn stop(&self) {
        self.commands.send_replace(Command::Stop);
        // The thread sees the command at its next step and ends; it is not waited for here.
        self.thread.lock().unwrap().take();
        self.set("idle", 0, json!({}));
    }

    /// Waits `duration`, or less when a restart or stop comes in. True when it should go on.
    async fn pause(&self, commands: &mut watch::Receiver<Command>, duration: Duration) -> bool {
        let _ = tokio::time::timeout(duration, commands.changed()).await;
        *commands.borrow_and_update() != Command::Stop
    }

    async fn run(self: std::sync::Arc<Self>) {
        let mut commands = self.commands.subscribe();
        commands.borrow_and_update();
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let mut stop = self.commands.subscribe();
            let outcome = tokio::select! {
                outcome = Self::once(self.clone(), attempt, &mut commands) => Some(outcome),
                _ = stop.wait_for(|c| *c == Command::Stop) => None,
            };
            match outcome {
                Some(Ok(())) => attempt = 0,
                Some(Err(failure)) => self.fail(attempt, &failure),
                None => {
                    // Stopped: end the runner now. Left alone it lives on for about 30 s after the
                    // developer connection closes, with iOS's automation banner on screen.
                    let _ = tokio::time::timeout(Duration::from_secs(6), Self::end_runner(&self.config)).await;
                    return;
                }
            }
            if *commands.borrow() == Command::Stop {
                return;
            }
            // 1, 2, 4 … 30 s between failed attempts; at once after a runner that ran and stopped.
            let wait = if attempt == 0 { Duration::from_millis(500) } else { Duration::from_secs(1u64 << attempt.min(5).saturating_sub(1)).min(Duration::from_secs(30)) };
            if !self.pause(&mut commands, wait).await {
                return;
            }
        }
    }

    /// Ends the runner's process through the developer services (best effort).
    async fn end_runner(config: &Config) {
        let Ok(mut pairing) = Pairing::read(&config.pairing_file, config.host_name.as_deref()) else { return };
        let Ok(mut device) = Device::open(config.device_address, &mut pairing, Duration::from_secs(4)).await else { return };
        let _ = launch::end(&mut device).await;
    }

    /// One launch and the watch over it. Ok when a running runner later stopped answering.
    async fn once(me: std::sync::Arc<Self>, attempt: u32, commands: &mut watch::Receiver<Command>) -> Result<(), Failure> {
        let config = me.config.clone();
        me.set("connecting", attempt, json!({}));
        let mut pairing = Pairing::read(&config.pairing_file, config.host_name.as_deref())?;
        let kind = pairing.kind().name();
        me.set("pairing", attempt, json!({"pairing": kind}));
        let mut device = Device::open(config.device_address, &mut pairing, Duration::from_secs(20)).await?;
        if !ddi::mounted(&device) {
            me.set("mounting_ddi", attempt, json!({"pairing": kind}));
            // Apple's signing server and a ~20 MB upload: bounded, so a stalled network cannot hold
            // the supervisor in mounting_ddi (Stop would end it, Restart would not).
            match tokio::time::timeout(DDI_MOUNT_TIMEOUT, ddi::mount(&mut device, &config.ddi_dir)).await {
                Ok(result) => result?,
                Err(_) => return Err(Failure::new(format!("mounting the developer disk image took over {} s", DDI_MOUNT_TIMEOUT.as_secs())).fix(DDI_TIMEOUT_FIX).code("ddi_timeout")),
            }
            drop(device);
            // The services list was fixed when the tunnel opened; a new one shows the mounted image.
            // It can take a moment to appear: up to three more tunnels, a second apart, before the
            // person is asked to restart the phone (which costs a passcode and a new signature).
            let mut tries = 0;
            loop {
                device = Device::open(config.device_address, &mut pairing, Duration::from_secs(20)).await?;
                if ddi::mounted(&device) { break; }
                tries += 1;
                if tries > 3 {
                    return Err(Failure::new("the developer disk image was installed but its services did not appear").fix("Restart the phone, then open Poki again."));
                }
                drop(device);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        let ios = device.ios_version().await.unwrap_or_default();
        me.set("launching", attempt, json!({"pairing": kind, "ios": ios}));
        let bundle = launch::find_runner(&mut device, config.runner_bundle.as_deref()).await?;
        let mut session = launch::start(&mut device, &bundle, &ios).await?;
        let wda = SocketAddr::new(config.wda_host, config.wda_port);
        launch::wait_ready(&mut session, wda, Duration::from_secs(60)).await?;
        me.set("running", attempt, json!({"pairing": kind, "ios": ios, "runner": bundle}));

        // Watch: a missed /status twice in a row, an ended session, or a restart command ends it.
        let mut misses = 0;
        let reason = loop {
            let changed = tokio::time::timeout(me.check_every, commands.changed()).await;
            if changed.is_ok() {
                match *commands.borrow_and_update() {
                    Command::Stop => break "stopped",
                    Command::Restart(_) => break "restart asked",
                    Command::Run => {}
                }
            }
            if session.is_finished() {
                break "the runner's test session ended";
            }
            if launch::status(wda, Duration::from_millis(1500)).await {
                misses = 0;
            } else {
                misses += 1;
                if misses >= me.misses_allowed {
                    break "the runner stopped answering";
                }
            }
        };
        session.abort();
        drop(device);
        me.set("launching", attempt, json!({"pairing": kind, "ios": ios, "detail": reason}));
        Ok(())
    }
}

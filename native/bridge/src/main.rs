mod apps;
mod ax;
mod configuration;
mod device_ops;
mod gesture;
mod installation;
mod pasteboard;
mod remote;
mod stream;

use gesture::{Drag, Pinch, pinch_contacts};
use idevice::{
    IdeviceError, IdeviceService, ReadWrite, RsdService,
    core_device::hid::{
        ButtonState, IndigoHidClient, KeyboardUsage, MainKeyboardService,
        TOUCHSCREEN_STATE_CONTACT, TOUCHSCREEN_STATE_RELEASE, UniversalHidServiceClient,
    },
    core_device_proxy::CoreDeviceProxy,
    pairing_file::PairingFile,
    provider::{IdeviceProvider, TcpProvider},
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Read, net::IpAddr, path::PathBuf, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Touch = UniversalHidServiceClient<Box<dyn ReadWrite>>;
type Indigo = IndigoHidClient<Box<dyn ReadWrite>>;
fn trace(stage: &str) {
    if std::env::var_os("POKI_MCP_NATIVE_TRACE").is_some() {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let elapsed = START.get_or_init(std::time::Instant::now).elapsed();
        eprintln!("native stage: {stage} (+{} ms)", elapsed.as_millis());
    }
}
struct Keyboard {
    hid: Touch,
    service: MainKeyboardService,
}
impl Keyboard {
    async fn connect(
        adapter: &mut idevice::tcp::handle::AdapterHandle,
        rsd: &mut RsdHandshake,
    ) -> Result<Self> {
        trace("keyboard connect");
        let mut hid = Touch::connect_rsd(adapter, rsd).await?;
        trace("keyboard create");
        let service = hid.create_main_keyboard().await?;
        trace("keyboard ready");
        tokio::time::sleep(Duration::from_millis(150)).await;
        Ok(Self { hid, service })
    }
    async fn close(&mut self) -> Result<()> {
        self.hid.remove_main_keyboard(&mut self.service).await?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    DisplayInfo,
    ListApps,
    InstallApp {
        ipa_path: String,
        bundle_id: String,
        staging_id: String,
    },
    UninstallApp {
        bundle_id: String,
    },
    LaunchApp(apps::LaunchRequest),
    Configuration {
        method: String,
        #[serde(default)]
        value: Option<Value>,
    },
    AxTree {
        #[serde(default)]
        include_offscreen: bool,
    },
    LockdownGet {
        #[serde(default)]
        domain: Option<String>,
        key: String,
    },
    Screenshot {
        path: String,
    },
    Rotate {
        #[serde(default = "rotate_left")]
        direction: String,
    },
    Pasteboard {
        action: String,
        #[serde(default)]
        text: Option<String>,
    },
    Location {
        action: String,
        #[serde(default)]
        latitude: Option<f64>,
        #[serde(default)]
        longitude: Option<f64>,
    },
    Tap {
        x: u16,
        y: u16,
        #[serde(default = "tap_duration")]
        duration_ms: u64,
    },
    DoubleTap {
        x: u16,
        y: u16,
        #[serde(default = "tap_duration")]
        duration_ms: u64,
    },
    LongPress {
        x: u16,
        y: u16,
        #[serde(default = "long_duration")]
        duration_ms: u64,
    },
    Drag {
        x1: u16,
        y1: u16,
        x2: u16,
        y2: u16,
        #[serde(default = "drag_duration")]
        duration_ms: u64,
        #[serde(default)]
        hold_ms: u64,
        #[serde(default)]
        end_hold_ms: u64,
    },
    Pinch {
        x: u16,
        y: u16,
        start_distance: f64,
        end_distance: f64,
        #[serde(default)]
        angle: f64,
        #[serde(default = "drag_duration")]
        duration_ms: u64,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default = "one")]
        count: usize,
    },
    Button {
        button: String,
        #[serde(default = "one")]
        count: usize,
        #[serde(default = "button_interval")]
        interval_ms: u64,
    },
    TypeText {
        text: String,
        #[serde(default)]
        clear: bool,
        #[serde(default)]
        submit: bool,
        #[serde(default)]
        target: Option<pasteboard::Target>,
    },
}
fn tap_duration() -> u64 {
    50
}
fn long_duration() -> u64 {
    600
}
fn drag_duration() -> u64 {
    500
}
fn rotate_left() -> String {
    "left".into()
}
fn one() -> usize {
    1
}
fn button_interval() -> u64 {
    120
}

impl Request {
    fn validate(&self) -> Result<()> {
        match self {
            Self::LaunchApp(request) => request.validate()?,
            Self::InstallApp { bundle_id, .. } | Self::UninstallApp { bundle_id }
                if bundle_id.is_empty() =>
            {
                return Err("bundle_id must not be empty".into());
            }
            Self::Configuration { method, value } => {
                configuration::validate(method, value.as_ref())?
            }
            Self::LockdownGet { domain, key } => {
                device_ops::validate_lockdown(domain.as_deref(), key)?
            }
            Self::Screenshot { path } => device_ops::validate_screenshot(path)?,
            Self::Rotate { direction } => {
                device_ops::direction(direction)?;
            }
            Self::Pasteboard { action, text } => {
                device_ops::validate_pasteboard(action, text.as_deref())?
            }
            Self::Location {
                action,
                latitude,
                longitude,
            } => device_ops::validate_location(action, *latitude, *longitude)?,
            Self::Tap { duration_ms, .. }
            | Self::DoubleTap { duration_ms, .. }
            | Self::LongPress { duration_ms, .. }
            | Self::Drag { duration_ms, .. }
            | Self::Pinch { duration_ms, .. }
                if !(1..=60000).contains(duration_ms) =>
            {
                return Err("duration_ms must be 1..60000".into());
            }
            Self::Key {
                key,
                modifiers,
                count,
            } => {
                key_usage(key)?;
                for modifier in modifiers {
                    modifier_usage(modifier)?;
                }
                if !(1..=200).contains(count) {
                    return Err("count must be 1..200".into());
                }
            }
            Self::Button {
                button,
                count,
                interval_ms,
            } => {
                button_usage(button)?;
                if !(1..=200).contains(count) || *interval_ms > 10000 {
                    return Err("Invalid button count or interval_ms".into());
                }
            }
            Self::TypeText { text, .. } if text.len() > 1024 * 1024 => {
                return Err("text exceeds 1 MiB".into());
            }
            _ => {}
        }
        if let Self::Drag {
            hold_ms,
            end_hold_ms,
            ..
        } = self
        {
            if *hold_ms > 10000 || *end_hold_ms > 10000 {
                return Err("hold_ms and end_hold_ms must not exceed 10000".into());
            }
        }
        if let Self::Pinch {
            x,
            y,
            start_distance,
            end_distance,
            angle,
            ..
        } = self
        {
            pinch_contacts(*x, *y, *start_distance, *angle, true)?;
            pinch_contacts(*x, *y, *end_distance, *angle, true)?;
        }
        Ok(())
    }
}

/// How the bridge reaches the device: through usbmuxd by UDID (the default), over the network with
/// a saved lockdown pairing file, or over the network through the phone's remote pairing service
/// with a saved RPPairing file.
#[derive(Debug, PartialEq)]
enum Target {
    Usbmuxd {
        udid: String,
    },
    Network {
        host: IpAddr,
        pairing_file: PathBuf,
    },
    RemotePairing {
        host: IpAddr,
        rp_pairing_file: PathBuf,
        host_name: Option<String>,
    },
}

const USAGE: &str = "usage: poki-native --udid ID < request.json\n       poki-native --host IP --pairing-file PATH < request.json\n       poki-native --host IP --rp-pairing-file PATH [--rp-host-name NAME] < request.json";

fn parse_args(args: &[String]) -> Result<Target> {
    if args.len() < 3 || args.len().is_multiple_of(2) {
        return Err(USAGE.into());
    }
    let (mut udid, mut host, mut pairing_file, mut rp_pairing_file, mut host_name) =
        (None, None, None, None, None);
    for pair in args[1..].chunks(2) {
        let slot = match pair[0].as_str() {
            "--udid" => &mut udid,
            "--host" => &mut host,
            "--pairing-file" => &mut pairing_file,
            "--rp-pairing-file" => &mut rp_pairing_file,
            "--rp-host-name" => &mut host_name,
            _ => return Err(USAGE.into()),
        };
        if slot.is_some() || pair[1].is_empty() {
            return Err(USAGE.into());
        }
        *slot = Some(pair[1].as_str());
    }
    let ip = |host: &str| {
        host.parse::<IpAddr>()
            .map_err(|_| format!("--host must be an IP address, got {host}"))
    };
    Ok(
        match (udid, host, pairing_file, rp_pairing_file, host_name) {
            (Some(udid), None, None, None, None) => Target::Usbmuxd { udid: udid.into() },
            (None, Some(host), Some(pairing_file), None, None) => Target::Network {
                host: ip(host)?,
                pairing_file: PathBuf::from(pairing_file),
            },
            (None, Some(host), None, Some(rp_pairing_file), host_name) => Target::RemotePairing {
                host: ip(host)?,
                rp_pairing_file: PathBuf::from(rp_pairing_file),
                host_name: host_name.map(String::from),
            },
            _ => return Err(USAGE.into()),
        },
    )
}

/// A lockdown provider for the usbmuxd and lockdown network targets. The remote pairing target has
/// none: its lockdown-era services come from their RSD shims (see [`Lockdown`]).
async fn provider(target: &Target) -> Result<Box<dyn IdeviceProvider>> {
    Ok(match target {
        Target::Usbmuxd { udid } => {
            let mut mux = UsbmuxdConnection::default().await?;
            let device = mux.get_device(udid).await?;
            Box::new(device.to_provider(UsbmuxdAddr::from_env_var()?, "poki-mcp"))
        }
        Target::Network { host, pairing_file } => {
            let bytes = std::fs::read(pairing_file).map_err(|error| {
                format!(
                    "Cannot read pairing file {}: {error}",
                    pairing_file.display()
                )
            })?;
            let pairing = PairingFile::from_bytes(&bytes).map_err(|error| {
                format!(
                    "{} is not a valid pairing file ({error}). Make a new one with bin/pair.",
                    pairing_file.display()
                )
            })?;
            Box::new(TcpProvider {
                addr: *host,
                scope_id: None,
                pairing_file: pairing,
                label: "poki-mcp".into(),
            })
        }
        Target::RemotePairing { .. } => {
            return Err("The remote pairing target has no lockdown provider.".into());
        }
    })
}

/// Where the installation_proxy, AFC and SpringBoard services come from: lockdown through a
/// provider, or the `*.shim.remote` RSD services inside a tunnel.
pub enum Lockdown<'a> {
    Provider(&'a dyn IdeviceProvider),
    Rsd(&'a mut AdapterHandle, &'a mut RsdHandshake),
}

impl Lockdown<'_> {
    pub async fn connect<S: IdeviceService + RsdService>(
        &mut self,
    ) -> std::result::Result<S, IdeviceError> {
        match self {
            Self::Provider(provider) => S::connect(*provider).await,
            Self::Rsd(adapter, rsd) => S::connect_rsd(&mut **adapter, rsd).await,
        }
    }
}

/// An RSD session inside a tunnel. `provider` is set for the usbmuxd and lockdown network targets;
/// `_control` keeps the remote pairing control connection open while the tunnel is in use.
struct Device {
    adapter: AdapterHandle,
    rsd: RsdHandshake,
    provider: Option<Box<dyn IdeviceProvider>>,
    _control: Option<remote::Control>,
}

#[tokio::main]
async fn main() {
    let result = async {
        let args: Vec<String> = std::env::args().collect();
        let target = parse_args(&args)?;
        let mut input = String::new();
        std::io::stdin()
            .take(2 * 1024 * 1024)
            .read_to_string(&mut input)?;
        let request: Request = serde_json::from_str(&input)?;
        request.validate()?;
        if is_held_location(&request) {
            // A held location runs until the caller ends the process.
            return execute(&target, request).await;
        }
        let limit = if matches!(request, Request::InstallApp { .. }) {
            180
        } else {
            90
        };
        tokio::time::timeout(Duration::from_secs(limit), execute(&target, request)).await?
    }
    .await;
    match result {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!(
                "{}",
                json!({"error": error.to_string(), "screen_change_verified": false})
            );
            std::process::exit(1);
        }
    }
}

fn is_held_location(request: &Request) -> bool {
    matches!(request, Request::Location { action, .. } if action == "set")
}

async fn connect_device(target: &Target) -> Result<Device> {
    if let Target::RemotePairing {
        host,
        rp_pairing_file,
        host_name,
    } = target
    {
        let (mut file, sending_host) =
            remote::read_pairing_file(rp_pairing_file, host_name.as_deref())?;
        let (adapter, rsd, control) =
            remote::connect(*host, &mut file, &sending_host, trace).await?;
        return Ok(Device {
            adapter,
            rsd,
            provider: None,
            _control: Some(control),
        });
    }
    let provider = provider(target).await?;
    let proxy = CoreDeviceProxy::connect(&*provider).await?;
    let port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy.create_software_tunnel()?.to_async_handle();
    let rsd = RsdHandshake::new(adapter.connect(port).await?).await?;
    Ok(Device {
        adapter,
        rsd,
        provider: Some(provider),
        _control: None,
    })
}

async fn execute(target: &Target, request: Request) -> Result<Value> {
    if matches!(
        request,
        Request::InstallApp { .. } | Request::UninstallApp { .. }
    ) {
        let result = async {
            let (mut device, lockdown_provider);
            let mut link = if matches!(target, Target::RemotePairing { .. }) {
                device = connect_device(target).await?;
                Lockdown::Rsd(&mut device.adapter, &mut device.rsd)
            } else {
                lockdown_provider = provider(target).await?;
                Lockdown::Provider(&*lockdown_provider)
            };
            match request {
                Request::InstallApp {
                    ipa_path,
                    bundle_id,
                    staging_id,
                } => {
                    installation::install(
                        &mut link,
                        std::path::Path::new(&ipa_path),
                        &bundle_id,
                        &staging_id,
                    )
                    .await
                }
                Request::UninstallApp { bundle_id } => {
                    installation::uninstall(&mut link, &bundle_id).await
                }
                _ => unreachable!(),
            }
        }
        .await;
        return Ok(result.unwrap_or_else(
            |error| json!({"isError":true,"outcome":"not_sent","error":error.to_string()}),
        ));
    }
    if let Request::LaunchApp(request) = request {
        let result = async {
            let mut device = connect_device(target).await?;
            apps::launch(&mut device.adapter, &mut device.rsd, request).await
        }
        .await;
        return Ok(result.unwrap_or_else(apps::not_sent));
    }
    let Device {
        mut adapter,
        mut rsd,
        provider,
        _control,
    } = connect_device(target).await?;
    if matches!(request, Request::ListApps) {
        return apps::list(&mut adapter, &mut rsd, provider.as_deref()).await;
    }
    if let Request::Configuration { method, value } = request {
        return configuration::execute(&mut adapter, &mut rsd, &method, value).await;
    }
    if let Request::AxTree { include_offscreen } = request {
        return ax::read_tree(&mut adapter, &rsd, include_offscreen).await;
    }
    match request {
        Request::LockdownGet { domain, key } => {
            return device_ops::lockdown_get(&mut adapter, &mut rsd, domain.as_deref(), &key).await;
        }
        Request::Screenshot { path } => {
            return device_ops::screenshot(&mut adapter, &mut rsd, &path).await;
        }
        Request::Rotate { direction } => {
            return device_ops::rotate(&mut adapter, &mut rsd, &direction).await;
        }
        Request::Pasteboard { action, text } => {
            return device_ops::pasteboard(&mut adapter, &mut rsd, &action, text.as_deref()).await;
        }
        Request::Location {
            action,
            latitude,
            longitude,
        } => {
            let coordinates = latitude.zip(longitude);
            return device_ops::location(&mut adapter, &mut rsd, &action, coordinates).await;
        }
        _ => {}
    }
    if matches!(request, Request::DisplayInfo) {
        let mut display =
            idevice::core_device::DisplayServiceClient::connect_rsd(&mut adapter, &mut rsd).await?;
        let info = display.get_media_support_info().await?;
        return Ok(serde_json::to_value(info)?);
    }
    let mut media = stream::start_screen_media_stream(&mut adapter, &mut rsd, 1)
        .await
        .map_err(|e| format!("Cannot establish input media session: {e}"))?;
    trace("media ready");
    tokio::time::sleep(hid_wait("POKI_HID_OPEN_MS", 1000)).await;
    // The device sometimes drops a touch whose connection closes straight after its last report, with no
    // error. The touch connection therefore stays open through the wait that follows the action;
    // NATIVE.md has the counts.
    let mut touch: Option<Touch> = None;
    let action: Result<Value> = async {
        match request {
            Request::DisplayInfo
            | Request::ListApps
            | Request::InstallApp { .. }
            | Request::UninstallApp { .. }
            | Request::AxTree { .. }
            | Request::Configuration { .. }
            | Request::LockdownGet { .. }
            | Request::Screenshot { .. }
            | Request::Rotate { .. }
            | Request::Pasteboard { .. }
            | Request::Location { .. }
            | Request::LaunchApp(_) => {
                unreachable!()
            }
            Request::Tap { x, y, duration_ms } | Request::LongPress { x, y, duration_ms } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::DoubleTap { x, y, duration_ms } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                held_tap(hid, x, y, duration_ms).await?;
                tokio::time::sleep(Duration::from_millis(80)).await;
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::Drag {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
                hold_ms,
                end_hold_ms,
            } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                Drag {
                    x1,
                    y1,
                    x2,
                    y2,
                    duration_ms,
                    hold_ms,
                    end_hold_ms,
                }
                .send(hid)
                .await?;
            }
            Request::Pinch {
                x,
                y,
                start_distance,
                end_distance,
                angle,
                duration_ms,
            } => {
                let hid = touch.insert(Touch::connect_rsd(&mut adapter, &mut rsd).await?);
                Pinch {
                    x,
                    y,
                    start_distance,
                    end_distance,
                    angle,
                    duration_ms,
                }
                .send(hid)
                .await?;
            }
            Request::Key {
                key,
                modifiers,
                count,
            } => {
                let mut keyboard = Keyboard::connect(&mut adapter, &mut rsd).await?;
                let usages = modifiers
                    .iter()
                    .map(|m| modifier_usage(m))
                    .collect::<Result<Vec<_>>>()?;
                let outcome: Result<()> = async {
                    for _ in 0..count {
                        chord(&mut keyboard, key_usage(&key)?, &usages).await?;
                    }
                    Ok(())
                }
                .await;
                let cleanup = keyboard.close().await;
                outcome?;
                cleanup?;
            }
            Request::Button {
                button,
                count,
                interval_ms,
            } => {
                let mut keyboard = Indigo::connect_rsd(&mut adapter, &mut rsd).await?;
                let (code, duration) = button_usage(&button)?;
                for index in 0..count {
                    if index > 0 {
                        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                    }
                    keyboard.send_button(0x0c, code, ButtonState::Down).await?;
                    tokio::time::sleep(Duration::from_millis(duration)).await;
                    keyboard.send_button(0x0c, code, ButtonState::Up).await?;
                }
            }
            Request::TypeText {
                text,
                clear,
                submit,
                target,
            } => {
                let mut keyboard = Keyboard::connect(&mut adapter, &mut rsd).await?;
                let outcome = pasteboard::paste_text(
                    &mut adapter,
                    &rsd,
                    &mut keyboard,
                    &text,
                    clear,
                    submit,
                    target.as_ref(),
                )
                .await;
                let cleanup = keyboard.close().await;
                let result = outcome?;
                cleanup?;
                return Ok(result);
            }
        }
        Ok(json!({"sent":true,"screen_change_verified":false}))
    }
    .await;
    tokio::time::sleep(hid_wait("POKI_HID_CLOSE_MS", 300)).await;
    drop(touch);
    let stop = media.client.stop_media_stream().await;
    drop(media.audio_udp);
    drop(media.video_udp);
    let output = action?;
    stop?;
    Ok(output)
}

/// The waits around an input session, overridable for slow links such as a relayed tailnet.
fn hid_wait(name: &str, default_ms: u64) -> Duration {
    Duration::from_millis(parse_wait(std::env::var(name).ok().as_deref(), default_ms))
}

fn parse_wait(value: Option<&str>, default_ms: u64) -> u64 {
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms <= 10000)
        .unwrap_or(default_ms)
}

async fn held_tap(hid: &mut Touch, x: u16, y: u16, ms: u64) -> Result<()> {
    hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y, None)
        .await?;
    tokio::time::sleep(Duration::from_millis(ms)).await;
    hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, None)
        .await?;
    Ok(())
}

fn modifier_usage(name: &str) -> Result<u64> {
    Ok(match name.to_ascii_lowercase().as_str() {
        "command" | "cmd" | "meta" => 0xe3,
        "control" | "ctrl" => 0xe0,
        "option" | "alt" => 0xe2,
        "shift" => 0xe1,
        _ => return Err(format!("Unknown modifier: {name}").into()),
    })
}

fn key_usage(name: &str) -> Result<u64> {
    let name = name.to_ascii_lowercase();
    Ok(match name.as_str() {
        "return" | "enter" => 0x28,
        "escape" | "esc" => 0x29,
        "backspace" | "delete" => 0x2a,
        "tab" => 0x2b,
        "space" => 0x2c,
        "forward_delete" => 0x4c,
        "right" | "arrowright" => 0x4f,
        "left" | "arrowleft" => 0x50,
        "down" | "arrowdown" => 0x51,
        "up" | "arrowup" => 0x52,
        "home" => 0x4a,
        "end" => 0x4d,
        "pageup" | "page_up" => 0x4b,
        "pagedown" | "page_down" => 0x4e,
        "capslock" | "caps_lock" => 0x39,
        "0" => 0x27,
        name if name.len() == 1 && name.as_bytes()[0].is_ascii_lowercase() => {
            4 + (name.as_bytes()[0] - b'a') as u64
        }
        name if name.len() == 1 && matches!(name.as_bytes()[0], b'1'..=b'9') => {
            0x1e + (name.as_bytes()[0] - b'1') as u64
        }
        name if name.starts_with('f')
            && name[1..]
                .parse::<u64>()
                .is_ok_and(|v| (1..=12).contains(&v)) =>
        {
            0x39 + name[1..].parse::<u64>()?
        }
        name if name.starts_with("0x") => {
            let usage = u64::from_str_radix(&name[2..], 16)?;
            if usage > 0xff {
                return Err("HID keyboard usage exceeds 255".into());
            }
            usage
        }
        _ => return Err(format!("Unknown keyboard key: {name}").into()),
    })
}

fn button_usage(name: &str) -> Result<(u64, u64)> {
    Ok(match name.replace('_', "-").as_str() {
        "home" => (0x40, 80),
        "power" | "lock" | "sleep" => (0x30, 200),
        "volume-up" => (0xe9, 80),
        "volume-down" => (0xea, 80),
        "mute" => (0xe2, 80),
        "siri" => (0xcf, 1200),
        "keyboard" => (0xb8, 80),
        _ => return Err(format!("Unknown hardware button: {name}").into()),
    })
}

async fn chord(keyboard: &mut Keyboard, key: u64, modifiers: &[u64]) -> Result<()> {
    let pressed = modifiers
        .iter()
        .map(|&v| KeyboardUsage::new(v as u16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let key = KeyboardUsage::new(key as u16)?;
    let result: Result<()> = async {
        for usage in &pressed {
            keyboard
                .hid
                .main_keyboard_key_down(&mut keyboard.service, *usage)
                .await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        keyboard
            .hid
            .main_keyboard_key_down(&mut keyboard.service, key)
            .await?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        keyboard
            .hid
            .main_keyboard_key_up(&mut keyboard.service, key)
            .await?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok(())
    }
    .await;
    let release_error = keyboard
        .hid
        .set_main_keyboard_usages(&mut keyboard.service, [])
        .await
        .err();
    result?;
    if let Some(error) = release_error {
        return Err(error.into());
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("poki-native")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn udid_argument_is_unchanged() {
        assert_eq!(
            parse_args(&args(&["--udid", "00008150-ABC"])).unwrap(),
            Target::Usbmuxd {
                udid: "00008150-ABC".into()
            }
        );
    }

    #[test]
    fn network_arguments_accept_either_order() {
        let expected = Target::Network {
            host: "192.0.2.1".parse().unwrap(),
            pairing_file: PathBuf::from("/tmp/phone.plist"),
        };
        for list in [
            ["--host", "192.0.2.1", "--pairing-file", "/tmp/phone.plist"],
            ["--pairing-file", "/tmp/phone.plist", "--host", "192.0.2.1"],
        ] {
            assert_eq!(parse_args(&args(&list)).unwrap(), expected);
        }
        assert!(matches!(
            parse_args(&args(&["--host", "2001:db8::1", "--pairing-file", "p"])).unwrap(),
            Target::Network {
                host: IpAddr::V6(_),
                ..
            }
        ));
    }

    #[test]
    fn remote_pairing_arguments_accept_any_order() {
        let expected = Target::RemotePairing {
            host: "192.0.2.1".parse().unwrap(),
            rp_pairing_file: PathBuf::from("/tmp/rp.plist"),
            host_name: None,
        };
        for list in [
            ["--host", "192.0.2.1", "--rp-pairing-file", "/tmp/rp.plist"],
            ["--rp-pairing-file", "/tmp/rp.plist", "--host", "192.0.2.1"],
        ] {
            assert_eq!(parse_args(&args(&list)).unwrap(), expected);
        }
        assert_eq!(
            parse_args(&args(&[
                "--rp-host-name",
                "pairing-mac",
                "--host",
                "2001:db8::1",
                "--rp-pairing-file",
                "rp.plist",
            ]))
            .unwrap(),
            Target::RemotePairing {
                host: "2001:db8::1".parse().unwrap(),
                rp_pairing_file: PathBuf::from("rp.plist"),
                host_name: Some("pairing-mac".into()),
            }
        );
    }

    fn request(text: &str) -> Result<Request> {
        let request: Request = serde_json::from_str(text)?;
        request.validate()?;
        Ok(request)
    }

    #[test]
    fn device_service_requests_parse_and_validate() {
        for text in [
            r#"{"op":"lockdown_get","key":"DeviceName"}"#,
            r#"{"op":"lockdown_get","domain":"com.apple.mobile.iTunes","key":"ScreenScaleFactor"}"#,
            r#"{"op":"screenshot","path":"/tmp/frame.png"}"#,
            r#"{"op":"rotate"}"#,
            r#"{"op":"rotate","direction":"right"}"#,
            r#"{"op":"pasteboard","action":"get"}"#,
            r#"{"op":"pasteboard","action":"items"}"#,
            r#"{"op":"pasteboard","action":"set","text":"héllo"}"#,
            r#"{"op":"location","action":"clear"}"#,
            r#"{"op":"location","action":"set","latitude":37.33,"longitude":-122.03}"#,
            r#"{"op":"configuration","method":"get_appearance"}"#,
            r#"{"op":"configuration","method":"set_appearance","value":"dark"}"#,
            r#"{"op":"configuration","method":"set_text_size","value":"large"}"#,
            r#"{"op":"configuration","method":"set_reduce_motion","value":true}"#,
        ] {
            assert!(request(text).is_ok(), "{text}");
        }
        assert!(matches!(
            request(r#"{"op":"rotate"}"#).unwrap(),
            Request::Rotate { direction } if direction == "left"
        ));
        assert!(is_held_location(
            &request(r#"{"op":"location","action":"set","latitude":1,"longitude":2}"#).unwrap()
        ));
        assert!(!is_held_location(
            &request(r#"{"op":"location","action":"clear"}"#).unwrap()
        ));
    }

    #[test]
    fn invalid_device_service_requests_are_rejected() {
        for text in [
            r#"{"op":"lockdown_get"}"#,
            r#"{"op":"lockdown_get","key":""}"#,
            r#"{"op":"lockdown_get","key":"DeviceName","extra":1}"#,
            r#"{"op":"screenshot","path":"frame.png"}"#,
            r#"{"op":"screenshot"}"#,
            r#"{"op":"rotate","direction":"up"}"#,
            r#"{"op":"pasteboard","action":"set"}"#,
            r#"{"op":"pasteboard","action":"get","text":"x"}"#,
            r#"{"op":"pasteboard"}"#,
            r#"{"op":"location","action":"set","latitude":95,"longitude":0}"#,
            r#"{"op":"location","action":"set","latitude":1}"#,
            r#"{"op":"location","action":"clear","latitude":1,"longitude":1}"#,
            r#"{"op":"configuration","method":"set_appearance","value":"blue"}"#,
            r#"{"op":"configuration","method":"get_text_size","value":"large"}"#,
        ] {
            assert!(request(text).is_err(), "{text}");
        }
    }

    #[test]
    fn hid_waits_fall_back_to_the_defaults() {
        assert_eq!(parse_wait(None, 1000), 1000);
        assert_eq!(parse_wait(Some("2500"), 1000), 2500);
        assert_eq!(parse_wait(Some("0"), 300), 0);
        assert_eq!(parse_wait(Some("soon"), 300), 300);
        assert_eq!(parse_wait(Some("10001"), 300), 300);
    }

    #[test]
    fn invalid_arguments_are_rejected() {
        for list in [
            &[][..],
            &["--udid"],
            &["--udid", "a", "--host", "192.0.2.1"],
            &["--host", "192.0.2.1"],
            &["--host", "192.0.2.1", "--host", "192.0.2.2"],
            &["--host", "192.0.2.1", "--pairing-file", ""],
            &["--host", "192.0.2.1", "--udid", "a"],
            &["--host", "phone.tailnet", "--pairing-file", "p"],
            &["--host", "phone.tailnet", "--rp-pairing-file", "p"],
            &[
                "--host",
                "192.0.2.1",
                "--pairing-file",
                "p",
                "--rp-pairing-file",
                "q",
            ],
            &[
                "--host",
                "192.0.2.1",
                "--pairing-file",
                "p",
                "--rp-host-name",
                "n",
            ],
            &["--udid", "a", "--rp-host-name", "n"],
            &["--rp-pairing-file", "p"],
            &[
                "--host",
                "192.0.2.1",
                "--rp-pairing-file",
                "p",
                "--rp-host-name",
                "",
            ],
            &["--host", "192.0.2.1", "--rp-pairing-file"],
        ] {
            assert!(parse_args(&args(list)).is_err(), "{list:?}");
        }
    }
}

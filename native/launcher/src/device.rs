//! One connection to the phone's developer services: the in-process tunnel and its RSD handshake,
//! opened either through remote pairing (port 49152, an RPPairing file) or through lockdown (port
//! 62078, a lockdown pairing plist, then CoreDeviceProxy). The pairing file decides which.

use crate::remote;
use idevice::{
    IdeviceService, RsdService,
    core_device_proxy::CoreDeviceProxy,
    installation_proxy::InstallationProxyClient,
    lockdown::LockdownClient,
    pairing_file::PairingFile,
    provider::TcpProvider,
    remote_pairing::RpPairingFile,
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use std::{net::IpAddr, path::Path, time::Duration};

pub type Result<T> = std::result::Result<T, Failure>;

/// A step that failed, with what the person can do about it on the phone.
#[derive(Debug, Clone)]
pub struct Failure {
    pub detail: String,
    pub fix: Option<String>,
}

impl Failure {
    pub fn new(detail: impl Into<String>) -> Self {
        Self { detail: detail.into(), fix: None }
    }
    pub fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
}

impl<E: std::error::Error> From<E> for Failure {
    fn from(error: E) -> Self {
        Self::new(error.to_string())
    }
}

pub const LOOPBACK_FIX: &str = "Turn on the loopback in your proxy app: the Poki module in Surge or Loon, loopback_address in sing-box, or Shadowrocket's Settings → Other → \"Include route 10.7.0.1/32\". Then connect to Wi-Fi.";
pub const PAIRING_FIX: &str = "Pair again in Poki's setup.";
pub const DEVELOPER_MODE_FIX: &str = "Turn on Developer Mode: Settings → Privacy & Security → Developer Mode, then restart the phone.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingKind {
    Remote,
    Lockdown,
}

impl PairingKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::Lockdown => "lockdown",
        }
    }
}

pub enum Pairing {
    Remote { file: RpPairingFile, host_name: String },
    Lockdown(PairingFile),
}

impl Pairing {
    pub fn kind(&self) -> PairingKind {
        match self {
            Self::Remote { .. } => PairingKind::Remote,
            Self::Lockdown(_) => PairingKind::Lockdown,
        }
    }

    /// Reads a pairing file of either kind: an RPPairing file (public_key, private_key, identifier)
    /// or a lockdown pairing plist (HostID, certificates, keys).
    pub fn read(path: &Path, host_name: Option<&str>) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| Failure::new(format!("cannot read the pairing file: {e}")).fix(PAIRING_FIX))?;
        if let Ok(file) = RpPairingFile::from_bytes(&bytes) {
            let name = remote::sending_host(&bytes).or_else(|| host_name.map(String::from)).unwrap_or_else(|| "Poki".into());
            return Ok(Self::Remote { file, host_name: name });
        }
        match PairingFile::from_bytes(&bytes) {
            Ok(file) => Ok(Self::Lockdown(file)),
            Err(e) => Err(Failure::new(format!("the pairing file is neither a remote pairing file nor a lockdown pairing record ({e})")).fix(PAIRING_FIX)),
        }
    }
}

/// An open tunnel. Dropping it closes everything that runs through it, the runner's session included.
pub struct Device {
    pub adapter: AdapterHandle,
    pub rsd: RsdHandshake,
    _control: Option<remote::Control>,
}

impl Device {
    pub async fn open(address: IpAddr, pairing: &mut Pairing, timeout: Duration) -> Result<Self> {
        match tokio::time::timeout(timeout, Self::open_inner(address, pairing)).await {
            Ok(result) => result,
            Err(_) => Err(Failure::new(format!("the phone's developer services did not answer within {} s", timeout.as_secs())).fix(LOOPBACK_FIX)),
        }
    }

    async fn open_inner(address: IpAddr, pairing: &mut Pairing) -> Result<Self> {
        match pairing {
            Pairing::Remote { file, host_name } => {
                let (adapter, rsd, control) = remote::connect(address, file, host_name, |_| {}).await.map_err(|e| {
                    let fix = match e.stage {
                        remote::Stage::Connect => LOOPBACK_FIX,
                        remote::Stage::PairVerify => PAIRING_FIX,
                        _ => DEVELOPER_MODE_FIX,
                    };
                    Failure::new(e.to_string()).fix(fix)
                })?;
                Ok(Self { adapter, rsd, _control: Some(control) })
            }
            Pairing::Lockdown(file) => {
                let provider = TcpProvider { addr: address, scope_id: None, pairing_file: file.clone(), label: "Poki".into() };
                let proxy = CoreDeviceProxy::connect(&provider).await.map_err(|e| {
                    let text = e.to_string();
                    let fix = if text.contains("onnect") || text.contains("refused") || text.contains("timed out") { LOOPBACK_FIX } else { PAIRING_FIX };
                    Failure::new(format!("lockdown on {address}:62078 failed: {text}")).fix(fix)
                })?;
                let port = proxy.tunnel_info().server_rsd_port;
                let mut adapter = proxy.create_software_tunnel().map_err(|e| Failure::new(format!("the tunnel did not come up: {e}")))?.to_async_handle();
                let stream = adapter.connect(port).await.map_err(|e| Failure::new(format!("the RSD handshake failed: {e}")))?;
                let rsd = RsdHandshake::new(stream).await?;
                Ok(Self { adapter, rsd, _control: None })
            }
        }
    }

    pub async fn connect<S: RsdService>(&mut self) -> std::result::Result<S, idevice::IdeviceError> {
        S::connect_rsd(&mut self.adapter, &mut self.rsd).await
    }

    pub async fn ios_version(&mut self) -> Result<String> {
        let mut lockdown: LockdownClient = self.connect().await?;
        let value = lockdown.get_value(Some("ProductVersion"), None).await?;
        Ok(value.as_string().unwrap_or("").to_string())
    }

    pub async fn installation_proxy(&mut self) -> Result<InstallationProxyClient> {
        Ok(self.connect().await?)
    }
}


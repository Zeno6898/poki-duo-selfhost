//! The RemotePairing network transport: TCP to the phone's remote pairing service, pair-verify with a
//! saved RPPairing file, a TLS-PSK CDTunnel, and the RSD handshake inside that tunnel.
//!
//! On the phone itself the address is the loopback 10.7.0.1 (Poki's packet tunnel or the user's proxy
//! app reflects it). This path needs no usbmuxd and no lockdown pairing record.

use idevice::{
    IdeviceError,
    remote_pairing::{
        RemotePairingClient, RpPairingFile, RpPairingSocket, connect_tls_psk_tunnel_native,
    },
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use std::{
    fmt,
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};
use tokio::net::TcpStream;

/// The port iOS serves `_remotepairing._tcp` on.
pub const REMOTE_PAIRING_PORT: u16 = 49152;
/// The optional plist key that records the host name used when the RPPairing file was made.
pub const SENDING_HOST_KEY: &str = "sending_host";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub type Control = RemotePairingClient<RpPairingSocket<TcpStream>>;

/// The step that failed. Pair-verify failures mean the RPPairing file is not accepted and must be
/// remade; every later step means the file is good and the tunnel itself failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Connect,
    Handshake,
    PairVerify,
    Listener,
    Tunnel,
    Rsd,
}

#[derive(Debug)]
pub struct RemoteError {
    pub stage: Stage,
    pub detail: String,
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = &self.detail;
        match self.stage {
            Stage::Connect => write!(
                f,
                "remote pairing connect failed: cannot reach the phone's remote pairing service ({detail}). Is the loopback on (Poki's tunnel, or the 10.7.0.1 setting in your proxy app)?"
            ),
            Stage::Handshake => write!(
                f,
                "remote pairing handshake failed: the phone's remote pairing service did not answer ({detail})."
            ),
            Stage::PairVerify => write!(
                f,
                "pair-verify failed: the phone does not accept this RPPairing file ({detail}). Pair again in Poki's setup."
            ),
            Stage::Listener => write!(
                f,
                "tunnel failed after pair-verify: the phone refused to open a tunnel listener ({detail})."
            ),
            Stage::Tunnel => write!(
                f,
                "tunnel failed after pair-verify: the TLS-PSK CDTunnel did not come up ({detail})."
            ),
            Stage::Rsd => write!(
                f,
                "tunnel failed after pair-verify: the RSD handshake inside the tunnel failed ({detail})."
            ),
        }
    }
}

impl std::error::Error for RemoteError {}

fn fail(stage: Stage) -> impl FnOnce(IdeviceError) -> RemoteError {
    move |error| RemoteError {
        stage,
        detail: error.to_string(),
    }
}

/// Reads an RPPairing file and the host name to send with it: the file's `sending_host` key, then
/// `override_name`, then this machine's host name. Pair-verify itself signs with the file's
/// `identifier`; the name only matters to requests that send `sendingHost`.
pub fn read_pairing_file(
    path: &Path,
    override_name: Option<&str>,
) -> Result<(RpPairingFile, String), String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Cannot read RPPairing file {}: {error}", path.display()))?;
    let file = RpPairingFile::from_bytes(&bytes).map_err(|error| {
        format!(
            "{} is not a valid RPPairing file ({error}). It needs public_key, private_key and identifier; pair again in Poki's setup.",
            path.display()
        )
    })?;
    let name = sending_host(&bytes)
        .or_else(|| override_name.map(String::from))
        .unwrap_or_else(|| "Poki".into());
    Ok((file, name))
}

pub fn sending_host(bytes: &[u8]) -> Option<String> {
    let dict: plist::Dictionary = plist::from_bytes(bytes).ok()?;
    dict.get(SENDING_HOST_KEY)
        .and_then(plist::Value::as_string)
        .filter(|name| !name.is_empty())
        .map(String::from)
}

async fn connect_tcp(addr: SocketAddr) -> Result<TcpStream, RemoteError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(RemoteError {
            stage: Stage::Connect,
            detail: format!("{addr}: {error}"),
        }),
        Err(_) => Err(RemoteError {
            stage: Stage::Connect,
            detail: format!("{addr}: no answer within {}s", CONNECT_TIMEOUT.as_secs()),
        }),
    }
}

/// Opens the tunnel and returns its TCP adapter, the RSD handshake and the remote pairing control
/// connection. Keep the control connection alive for as long as the tunnel is in use.
pub async fn connect(
    host: IpAddr,
    pairing_file: &mut RpPairingFile,
    sending_host: &str,
    trace: impl Fn(&str),
) -> Result<(AdapterHandle, RsdHandshake, Control), RemoteError> {
    let addr = SocketAddr::new(host, REMOTE_PAIRING_PORT);
    trace("remote pairing connect");
    let stream = connect_tcp(addr).await?;
    let mut control = RemotePairingClient::new(RpPairingSocket::new(stream), sending_host);
    trace("remote pairing handshake");
    control
        .attempt_pair_verify()
        .await
        .map_err(fail(Stage::Handshake))?;
    trace("pair-verify");
    // No fallback to pair-setup: the bridge never prompts, and a rejected file needs a new pairing.
    control
        .validate_pairing(pairing_file)
        .await
        .map_err(fail(Stage::PairVerify))?;
    trace("tunnel listener");
    let port = control
        .create_tcp_listener()
        .await
        .map_err(fail(Stage::Listener))?;
    let tunnel_stream = connect_tcp(SocketAddr::new(host, port))
        .await
        .map_err(|error| RemoteError {
            stage: Stage::Tunnel,
            detail: error.detail,
        })?;
    trace("tls-psk tunnel");
    let tunnel = connect_tls_psk_tunnel_native(tunnel_stream, control.encryption_key())
        .await
        .map_err(fail(Stage::Tunnel))?;
    let parse = |value: &str| {
        value.parse::<IpAddr>().map_err(|error| RemoteError {
            stage: Stage::Tunnel,
            detail: format!("bad tunnel address {value}: {error}"),
        })
    };
    let client_ip = parse(&tunnel.info.client_address)?;
    let server_ip = parse(&tunnel.info.server_address)?;
    let mtu = tunnel.info.mtu as usize;
    let rsd_port = tunnel.info.server_rsd_port;
    let mut adapter =
        idevice::tcp::adapter::Adapter::new(Box::new(tunnel.into_inner()), client_ip, server_ip);
    adapter.set_mss(mtu.clamp(1280, 8192) - 60);
    let mut adapter = adapter.to_async_handle();
    trace("rsd handshake");
    let rsd_stream = adapter
        .connect(rsd_port)
        .await
        .map_err(|error| RemoteError {
            stage: Stage::Rsd,
            detail: error.to_string(),
        })?;
    let rsd = RsdHandshake::new(rsd_stream)
        .await
        .map_err(fail(Stage::Rsd))?;
    Ok((adapter, rsd, control))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_verify_and_tunnel_failures_read_differently() {
        let message = |stage| {
            RemoteError {
                stage,
                detail: "x".into(),
            }
            .to_string()
        };
        assert!(message(Stage::PairVerify).starts_with("pair-verify failed:"));
        for stage in [Stage::Listener, Stage::Tunnel, Stage::Rsd] {
            assert!(message(stage).starts_with("tunnel failed after pair-verify:"));
        }
        assert!(message(Stage::Connect).starts_with("remote pairing connect failed:"));
        assert!(message(Stage::Handshake).starts_with("remote pairing handshake failed:"));
    }

    #[test]
    fn sending_host_comes_from_the_file_when_present() {
        let mut file = RpPairingFile::generate("pairing-mac").to_bytes();
        assert_eq!(sending_host(&file), None);
        let mut dict: plist::Dictionary = plist::from_bytes(&file).unwrap();
        dict.insert(SENDING_HOST_KEY.into(), "pairing-mac".into());
        file.clear();
        plist::to_writer_xml(&mut file, &dict).unwrap();
        assert_eq!(sending_host(&file).as_deref(), Some("pairing-mac"));

        let path = std::env::temp_dir().join(format!("poki-rp-{}.plist", std::process::id()));
        std::fs::write(&path, &file).unwrap();
        let (_, name) = read_pairing_file(&path, Some("flag-name")).unwrap();
        assert_eq!(name, "pairing-mac");
        std::fs::write(&path, RpPairingFile::generate("h").to_bytes()).unwrap();
        let (_, name) = read_pairing_file(&path, Some("flag-name")).unwrap();
        assert_eq!(name, "flag-name");
        std::fs::write(&path, b"not a plist").unwrap();
        assert!(read_pairing_file(&path, None).is_err());
        std::fs::remove_file(&path).unwrap();
    }
}

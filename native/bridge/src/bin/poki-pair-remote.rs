//! Makes an RPPairing file for the bridge's remote pairing transport, and checks that a file opens a
//! tunnel over the network.
//!
//!   poki-pair-remote pair --udid ID --out PATH [--name HOST]
//!     Pairs over USB through usbmuxd, with no PIN: the phone's untrusted tunnel service accepts a
//!     promptless pairing from a host that already holds its lockdown pairing (tap Trust once if
//!     asked). Writes the file with mode 0600 and records the host name under `sending_host`.
//!
//!   poki-pair-remote check --host IP --rp-pairing-file PATH [--rp-host-name NAME]
//!     Runs pair-verify, opens the tunnel and lists the RSD service names, the same path the bridge
//!     takes with `--host IP --rp-pairing-file PATH`.
//!
//! iPhones do not offer PIN pairing over the network, so pairing needs USB once.

#[path = "../remote.rs"]
mod remote;

use idevice::{
    IdeviceService, RemoteXpcClient,
    core_device_proxy::CoreDeviceProxy,
    remote_pairing::{RemotePairingClient, RpPairingFile},
    rsd::RsdHandshake,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection},
};
use std::{
    io::Write,
    net::IpAddr,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const USAGE: &str = "usage: poki-pair-remote pair --udid ID --out PATH [--name HOST]\n       poki-pair-remote check --host IP --rp-pairing-file PATH [--rp-host-name NAME]";
const UNTRUSTED_TUNNEL_SERVICE: &str = "com.apple.internal.dt.coredevice.untrusted.tunnelservice";

#[derive(Debug, PartialEq)]
enum Command {
    Pair {
        udid: String,
        out: PathBuf,
        name: Option<String>,
    },
    Check {
        host: IpAddr,
        rp_pairing_file: PathBuf,
        host_name: Option<String>,
    },
}

fn parse_args(args: &[String]) -> Result<Command> {
    let Some(command) = args.get(1) else {
        return Err(USAGE.into());
    };
    let flags = &args[2..];
    if !flags.len().is_multiple_of(2) {
        return Err(USAGE.into());
    }
    let allowed: &[&str] = match command.as_str() {
        "pair" => &["--udid", "--out", "--name"],
        "check" => &["--host", "--rp-pairing-file", "--rp-host-name"],
        "-h" | "--help" => return Err(USAGE.into()),
        _ => return Err(USAGE.into()),
    };
    let mut values: [Option<&str>; 3] = [None; 3];
    for pair in flags.chunks(2) {
        let Some(index) = allowed.iter().position(|flag| *flag == pair[0]) else {
            return Err(USAGE.into());
        };
        if values[index].is_some() || pair[1].is_empty() {
            return Err(USAGE.into());
        }
        values[index] = Some(pair[1].as_str());
    }
    let optional = values[2].map(String::from);
    let (Some(first), Some(second)) = (values[0], values[1]) else {
        return Err(USAGE.into());
    };
    Ok(match command.as_str() {
        "pair" => Command::Pair {
            udid: first.into(),
            out: second.into(),
            name: optional,
        },
        _ => Command::Check {
            host: first
                .parse()
                .map_err(|_| format!("--host must be an IP address, got {first}"))?,
            rp_pairing_file: second.into(),
            host_name: optional,
        },
    })
}

/// The RPPairing file as written: idevice's keys plus `sending_host`.
fn file_bytes(file: &RpPairingFile, sending_host: &str) -> Result<Vec<u8>> {
    let mut dict: plist::Dictionary = plist::from_bytes(&file.to_bytes())?;
    dict.insert(remote::SENDING_HOST_KEY.into(), sending_host.into());
    let mut bytes = Vec::new();
    plist::to_writer_xml(&mut bytes, &dict)?;
    Ok(bytes)
}

/// Writes `bytes` to `out` with mode 0600, refusing to replace an existing file.
fn write_private(out: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(out)
        .map_err(|error| {
            format!(
                "Cannot create {} ({error}); an existing file is left unchanged.",
                out.display()
            )
        })?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

async fn pair_over_usb(udid: &str, out: &Path, name: &str) -> Result<()> {
    if out.exists() {
        return Err(format!(
            "{} already exists; it was left unchanged. Choose another path with --out.",
            out.display()
        )
        .into());
    }
    let mut mux = UsbmuxdConnection::default().await?;
    let device = mux.get_device(udid).await.map_err(|error| {
        format!("usbmuxd does not list {udid} ({error}). Connect the phone over USB and unlock it.")
    })?;
    let provider = device.to_provider(UsbmuxdAddr::from_env_var()?, "poki-pair-remote");
    eprintln!("Opening the USB CoreDevice tunnel...");
    let proxy = CoreDeviceProxy::connect(&provider).await.map_err(|error| {
        format!("CoreDeviceProxy failed ({error}). The phone must already trust this computer (run bin/pair first) and have Developer Mode on.")
    })?;
    let rsd_port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy.create_software_tunnel()?.to_async_handle();
    let rsd = RsdHandshake::new(adapter.connect(rsd_port).await?).await?;
    let service = rsd
        .services
        .get(UNTRUSTED_TUNNEL_SERVICE)
        .ok_or("The phone does not offer the untrusted tunnel service over USB.")?;
    let mut xpc = RemoteXpcClient::new(adapter.connect(service.port).await?).await?;
    xpc.do_handshake().await?;
    let _ = xpc.recv_root().await;

    eprintln!("Pairing as \"{name}\". Tap Trust on the phone if it asks.");
    let mut file = RpPairingFile::generate(name);
    let mut client = RemotePairingClient::new(xpc, name);
    client
        .connect(&mut file, async || "000000".to_string())
        .await
        .map_err(|error| format!("Remote pairing failed: {error}"))?;
    write_private(out, &file_bytes(&file, name)?)?;
    println!("RPPairing file written to {} (mode 0600).", out.display());
    println!(
        "Copy it to the server, keep it private, then run:\n  poki-pair-remote check --host PHONE_TAILNET_IP --rp-pairing-file PATH"
    );
    Ok(())
}

async fn check(host: IpAddr, path: &Path, host_name: Option<&str>) -> Result<()> {
    let (mut file, sending_host) = remote::read_pairing_file(path, host_name)?;
    let (_adapter, rsd, _control) = remote::connect(host, &mut file, &sending_host, |stage| {
        eprintln!("{stage}...")
    })
    .await?;
    let mut names: Vec<_> = rsd.services.keys().cloned().collect();
    names.sort();
    println!("Tunnel up: {} RSD services.", names.len());
    for name in names {
        println!("  {name}");
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match parse_args(&args) {
        Ok(Command::Pair { udid, out, name }) => {
            let name = name.unwrap_or_else(remote::local_host_name);
            pair_over_usb(&udid, &out, &name).await
        }
        Ok(Command::Check {
            host,
            rp_pairing_file,
            host_name,
        }) => check(host, &rp_pairing_file, host_name.as_deref()).await,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("poki-pair-remote")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn pair_and_check_arguments_parse_in_any_order() {
        assert_eq!(
            parse_args(&args(&["pair", "--out", "/tmp/rp.plist", "--udid", "ABC"])).unwrap(),
            Command::Pair {
                udid: "ABC".into(),
                out: "/tmp/rp.plist".into(),
                name: None
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "check",
                "--rp-pairing-file",
                "rp.plist",
                "--rp-host-name",
                "mac",
                "--host",
                "192.0.2.1"
            ]))
            .unwrap(),
            Command::Check {
                host: "192.0.2.1".parse().unwrap(),
                rp_pairing_file: "rp.plist".into(),
                host_name: Some("mac".into())
            }
        );
    }

    #[test]
    fn invalid_arguments_are_rejected() {
        for list in [
            &[][..],
            &["pair"],
            &["pair", "--udid", "ABC"],
            &["pair", "--udid", "ABC", "--out"],
            &["pair", "--udid", "ABC", "--out", ""],
            &["pair", "--udid", "A", "--udid", "B", "--out", "o"],
            &["pair", "--host", "192.0.2.1", "--out", "o"],
            &["check", "--host", "phone.tailnet", "--rp-pairing-file", "p"],
            &["check", "--host", "192.0.2.1"],
            &["wifi", "--host", "192.0.2.1"],
        ] {
            assert!(parse_args(&args(list)).is_err(), "{list:?}");
        }
    }

    #[test]
    fn written_file_is_private_readable_and_never_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("poki-rp-{}.plist", uuid::Uuid::new_v4()));
        let file = RpPairingFile::generate("pairing-mac");
        write_private(&path, &file_bytes(&file, "pairing-mac").unwrap()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let (read, name) = remote::read_pairing_file(&path, None).unwrap();
        assert_eq!(name, "pairing-mac");
        assert_eq!(read.identifier, file.identifier);
        assert!(write_private(&path, b"other").is_err());
        std::fs::remove_file(&path).unwrap();
    }
}

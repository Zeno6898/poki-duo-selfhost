use super::{Lockdown, Result};
use idevice::{
    afc::{AfcClient, opcode::AfcFopenMode},
    installation_proxy::InstallationProxyClient,
};
use plist::Dictionary;
use serde_json::{Value, json};
use std::path::Path;

fn receipt(result: std::result::Result<(), idevice::IdeviceError>) -> Value {
    match result {
        Ok(()) => json!({"outcome":"completed"}),
        Err(error) => {
            let outcome = if matches!(
                error,
                idevice::IdeviceError::UnknownErrorType(_)
                    | idevice::IdeviceError::InstallationProxy(_)
            ) {
                "rejected"
            } else {
                "unknown"
            };
            json!({"isError":true,"outcome":outcome,"error":error.to_string()})
        }
    }
}

async fn cleanup(afc: &mut AfcClient, directory: &str) -> Value {
    match afc.remove_all(directory).await {
        Ok(()) => json!({"removed":true}),
        Err(error) => json!({"removed":false,"path":directory,"error":error.to_string()}),
    }
}

/// `ipa_path` must be a host-created archive containing Payload/<name>.app.
/// The caller owns package validation, operator approval and post-install lookup.
/// No install command is retried, including after an unknown receipt.
pub async fn install(
    link: &mut Lockdown<'_>,
    ipa_path: &Path,
    bundle_id: &str,
    staging_id: &str,
) -> Result<Value> {
    if bundle_id.is_empty()
        || !ipa_path
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ipa"))
    {
        return Err("Installation requires an .ipa path and nonempty bundle_id.".into());
    }
    let staging_uuid = uuid::Uuid::parse_str(staging_id)?;
    if staging_uuid.get_version_num() != 4 || staging_uuid.to_string() != staging_id {
        return Err("Staging ID must be a canonical version 4 UUID.".into());
    }
    let bytes = tokio::fs::read(ipa_path).await?;
    let mut installer: InstallationProxyClient = link.connect().await?;
    let mut afc: AfcClient = link.connect().await?;
    if !afc
        .list_dir("/")
        .await?
        .iter()
        .any(|name| name == "PublicStaging")
    {
        afc.mk_dir("PublicStaging").await?;
    }
    let name = format!("poki-{staging_uuid}");
    if afc
        .list_dir("PublicStaging")
        .await?
        .iter()
        .any(|entry| entry == &name)
    {
        return Err("Refusing to reuse an existing device staging directory.".into());
    }
    let directory = format!("PublicStaging/{name}");
    afc.mk_dir(&directory).await?;
    eprintln!("poki installation staging: {directory}");
    let package_path = format!("{directory}/package.ipa");
    let upload: Result<()> = async {
        let mut file = afc.open(&package_path, AfcFopenMode::WrOnly).await?;
        let written = file.write_entire(&bytes).await;
        let closed = file.close().await;
        written?;
        closed?;
        Ok(())
    }
    .await;
    if let Err(error) = upload {
        return Ok(
            json!({"isError":true,"outcome":"not_sent","error":error.to_string(),
            "staging_cleanup":cleanup(&mut afc, &directory).await}),
        );
    }
    let mut options = Dictionary::new();
    options.insert("CFBundleIdentifier".into(), bundle_id.into());
    let mut result = receipt(installer.install(package_path, Some(options.into())).await);
    // A disconnected response can leave installation in progress. Do not remove
    // its input or resend; retain this exact owned path for confirmed cleanup.
    result["staging_cleanup"] = if result["outcome"] == "unknown" {
        json!({"removed":false,"deferred":true,"path":directory})
    } else {
        cleanup(&mut afc, &directory).await
    };
    result["bundle_id"] = bundle_id.into();
    result["operation"] = "install".into();
    Ok(result)
}

/// The caller must authorize the exact bundle and verify absence afterwards.
pub async fn uninstall(link: &mut Lockdown<'_>, bundle_id: &str) -> Result<Value> {
    if bundle_id.is_empty() {
        return Err("Uninstall requires a nonempty bundle_id.".into());
    }
    let mut installer: InstallationProxyClient = link.connect().await?;
    let mut result = receipt(installer.uninstall(bundle_id, None).await);
    result["bundle_id"] = bundle_id.into();
    result["operation"] = "uninstall".into();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn uppercase_ipa_passes_package_validation() {
        let provider = idevice::provider::UsbmuxdProvider {
            addr: idevice::usbmuxd::UsbmuxdAddr::UnixSocket("/nonexistent-poki-test-socket".into()),
            tag: 1,
            udid: "test".into(),
            device_id: 0,
            label: "test".into(),
        };
        let path = std::env::temp_dir().join(format!("poki-missing-{}.IPA", uuid::Uuid::new_v4()));
        let error = install(
            &mut Lockdown::Provider(&provider),
            &path,
            "local.fixture",
            &uuid::Uuid::new_v4().to_string(),
        )
        .await
        .unwrap_err();
        assert!(
            error.downcast_ref::<std::io::Error>().is_some(),
            "expected package read, got {error}"
        );
    }
}

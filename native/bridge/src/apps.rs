use super::Result;
use futures_util::TryStreamExt;
use idevice::{
    IdeviceService, RsdService,
    core_device::{AppListEntry, AppServiceClient},
    provider::IdeviceProvider,
    rsd::RsdHandshake,
    springboardservices::SpringBoardServicesClient,
    tcp::handle::AdapterHandle,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchRequest {
    pub bundle_id: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub terminate_existing: bool,
}
impl LaunchRequest {
    pub fn validate(&self) -> Result<()> {
        match (&self.bundle_id, &self.name) {
            (Some(value), None) | (None, Some(value)) if !value.is_empty() => Ok(()),
            _ => Err("Give one nonempty bundle_id or name.".into()),
        }
    }
}

pub fn not_sent(error: Box<dyn std::error::Error + Send + Sync>) -> Value {
    json!({"isError":true,"outcome":"not_sent","launched":false,"foreground_verified":false,"error":error.to_string()})
}

fn resolve_app<'a>(apps: &'a [AppListEntry], query: &str) -> Result<&'a AppListEntry> {
    let normalized = query.to_lowercase();
    let exact = |app: &&AppListEntry| {
        app.bundle_identifier == query || app.name.to_lowercase() == normalized
    };
    let has_exact = apps.iter().any(|app| exact(&app));
    let mut matches = apps.iter().filter(|app| {
        if has_exact {
            exact(app)
        } else {
            !normalized.is_empty() && app.name.to_lowercase().contains(&normalized)
        }
    });
    let app = matches
        .next()
        .ok_or("No installed app matches the given name.")?;
    if matches.next().is_some() {
        return Err(
            "Multiple installed apps match the given name; give an explicit bundle_id.".into(),
        );
    }
    Ok(app)
}

pub async fn launch(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    request: LaunchRequest,
) -> Result<Value> {
    let mut service = AppServiceClient::connect_rsd(adapter, rsd).await?;
    let (bundle_id, name) = if let Some(bundle_id) = request.bundle_id {
        (bundle_id.clone(), bundle_id)
    } else {
        let query = request.name.ok_or("Give bundle_id or name.")?;
        let apps = installed_apps(&mut service, rsd).await?;
        let app = resolve_app(&apps, &query)?;
        (app.bundle_identifier.clone(), app.name.clone())
    };
    let arguments: Vec<&str> = request.arguments.iter().map(String::as_str).collect();
    let environment: plist::Dictionary = request
        .environment
        .into_iter()
        .map(|(key, value)| (key, plist::Value::String(value)))
        .collect();
    let response = service
        .launch_application(
            &bundle_id,
            &arguments,
            request.terminate_existing,
            false,
            Some(environment),
            None,
            None,
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Ok(
                json!({"isError":true,"outcome":"unknown","foreground_verified":false,"bundle_id":bundle_id,"error":error.to_string()}),
            );
        }
    };
    if response.pid == 0 {
        return Ok(
            json!({"isError":true,"outcome":"unknown","foreground_verified":false,"bundle_id":bundle_id,"pid":response.pid,"error":"Launch service returned an invalid PID."}),
        );
    }
    Ok(
        json!({"bundle_id":bundle_id,"name":name,"pid":response.pid,"launched":true,"transport":"paired-device-app-service"}),
    )
}

async fn installed_apps(
    service: &mut AppServiceClient<Box<dyn idevice::ReadWrite>>,
    rsd: &RsdHandshake,
) -> Result<Vec<AppListEntry>> {
    let supports_stream = rsd
        .services
        .get(AppServiceClient::rsd_service_name().as_ref())
        .and_then(|entry| entry.features.as_ref())
        .is_some_and(|features| {
            features
                .iter()
                .any(|feature| feature == "com.apple.coredevice.feature.streamapplist")
        });
    if !supports_stream {
        return Err(
            "Device does not advertise streamed app lookup; listing is unavailable.".into(),
        );
    }
    Ok(service
        .stream_apps(true, true, true, true, true)
        .try_collect()
        .await?)
}

pub async fn list(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    provider: Option<&dyn IdeviceProvider>,
) -> Result<Value> {
    let mut service = AppServiceClient::connect_rsd(adapter, rsd).await?;
    let mut apps = installed_apps(&mut service, rsd).await?.into_iter().map(|app| {
        let system = app.path.starts_with("/Applications/") || app.path.starts_with("file:///Applications/");
        json!({"bundle_id":app.bundle_identifier,"name":app.name,"version":app.version,"system":system,"path":app.path,"developer":app.is_developer_app,"aliases":[]})
    }).collect::<Vec<_>>();
    let icons = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut springboard = match provider {
            Some(provider) => SpringBoardServicesClient::connect(provider).await?,
            None => SpringBoardServicesClient::connect_rsd(adapter, rsd).await?,
        };
        springboard.get_icon_state(Some("2")).await
    })
    .await;
    let (status, added_aliases) = match icons {
        Ok(Ok(icons)) => ("available", add_localized_names(&mut apps, &icons)),
        Ok(Err(_)) => ("unavailable", 0),
        Err(_) => ("timeout", 0),
    };
    Ok(json!({"apps":apps,"localized_names":{"status":status,"added_aliases":added_aliases}}))
}

/// A path from AppService without its `file://` scheme, `/private` prefix and trailing slash, so
/// an executable path can be matched against the bundle that contains it.
fn bare_path(path: &str) -> &str {
    let path = path.strip_prefix("file://").unwrap_or(path);
    let path = path.strip_prefix("/private").unwrap_or(path);
    path.trim_end_matches('/')
}

/// The installed app whose bundle contains `executable`.
fn app_for_executable<'a>(apps: &'a [AppListEntry], executable: &str) -> Option<&'a AppListEntry> {
    let executable = bare_path(executable);
    apps.iter().find(|app| {
        let bundle = bare_path(&app.path);
        !bundle.is_empty()
            && executable
                .strip_prefix(bundle)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Names the app running as `pid`, for an accessibility root that carries no bundle ID.
pub async fn app_for_pid(
    adapter: &mut AdapterHandle,
    rsd: &mut RsdHandshake,
    pid: u32,
) -> Result<Value> {
    let mut service = AppServiceClient::connect_rsd(adapter, rsd).await?;
    let executable = service
        .list_processes()
        .await?
        .into_iter()
        .find(|process| process.pid == pid)
        .and_then(|process| process.executable_url)
        .map(|url| url.relative);
    let Some(executable) = executable else {
        return Ok(json!({"pid":pid,"running":false,"bundle_id":null,"name":null}));
    };
    let apps = installed_apps(&mut service, rsd).await?;
    let app = app_for_executable(&apps, &executable);
    Ok(json!({"pid":pid,"running":true,"executable":executable,
        "bundle_id":app.map(|app| app.bundle_identifier.as_str()),"name":app.map(|app| app.name.as_str())}))
}

fn add_localized_names(apps: &mut [Value], icons: &plist::Value) -> usize {
    match icons {
        plist::Value::Array(items) => items
            .iter()
            .map(|item| add_localized_names(apps, item))
            .sum(),
        plist::Value::Dictionary(fields) => {
            let bundle = fields
                .get("bundleIdentifier")
                .or_else(|| fields.get("displayIdentifier"))
                .and_then(plist::Value::as_string);
            let name = fields.get("displayName").and_then(plist::Value::as_string);
            let mut added = 0;
            if let (Some(bundle), Some(name)) = (bundle, name)
                && !name.is_empty()
                && let Some(app) = apps
                    .iter_mut()
                    .find(|app| app["bundle_id"].as_str() == Some(bundle))
                && let Some(aliases) = app.get_mut("aliases").and_then(Value::as_array_mut)
                && !aliases.iter().any(|alias| alias.as_str() == Some(name))
            {
                aliases.push(json!(name));
                added += 1;
            }
            added
                + fields
                    .values()
                    .map(|value| add_localized_names(apps, value))
                    .sum::<usize>()
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_executable_maps_to_the_bundle_that_contains_it() {
        let app = |bundle: &str, path: &str| AppListEntry {
            name: bundle.into(),
            bundle_identifier: bundle.into(),
            path: path.into(),
            is_removable: true,
            is_first_party: false,
            is_developer_app: false,
            bundle_version: None,
            is_internal: false,
            is_hidden: false,
            is_app_clip: false,
            version: None,
        };
        let apps = vec![
            app("local.empty", ""),
            app(
                "local.chat",
                "file:///private/var/containers/Bundle/Application/A/Chat.app/",
            ),
            app(
                "local.chatpro",
                "/var/containers/Bundle/Application/B/ChatPro.app",
            ),
            app("com.apple.Preferences", "/Applications/Preferences.app"),
        ];
        let find =
            |path: &str| app_for_executable(&apps, path).map(|a| a.bundle_identifier.as_str());
        assert_eq!(
            find("file:///private/var/containers/Bundle/Application/A/Chat.app/Chat"),
            Some("local.chat")
        );
        assert_eq!(
            find("/var/containers/Bundle/Application/A/Chat.app/Chat"),
            Some("local.chat")
        );
        assert_eq!(
            find("/private/var/containers/Bundle/Application/B/ChatPro.app/ChatPro"),
            Some("local.chatpro")
        );
        assert_eq!(
            find("/Applications/Preferences.app/Preferences"),
            Some("com.apple.Preferences")
        );
        // A sibling whose name starts the same is not inside the bundle.
        assert_eq!(find("/Applications/Preferences.appx/Preferences"), None);
        assert_eq!(find("/usr/libexec/backboardd"), None);
    }

    #[test]
    fn launch_name_resolution_prefers_exact_and_rejects_ambiguous_names() {
        let app = |name: &str, bundle: &str| AppListEntry {
            name: name.into(),
            bundle_identifier: bundle.into(),
            path: String::new(),
            is_removable: true,
            is_first_party: false,
            is_developer_app: false,
            bundle_version: None,
            is_internal: false,
            is_hidden: false,
            is_app_clip: false,
            version: None,
        };
        let apps = vec![
            app("Travel", "local.travel"),
            app("Travel Pro", "local.pro"),
            app("携程旅行", "ctrip.com"),
        ];
        for (query, expected) in [
            ("Travel", Ok("local.travel")),
            ("TRAVEL", Ok("local.travel")),
            ("local.pro", Ok("local.pro")),
            ("携程", Ok("ctrip.com")),
            ("携程旅行", Ok("ctrip.com")),
            (
                "Trav",
                Err("Multiple installed apps match the given name; give an explicit bundle_id."),
            ),
            ("missing", Err("No installed app matches the given name.")),
            ("", Err("No installed app matches the given name.")),
        ] {
            let actual = resolve_app(&apps, query)
                .map(|app| app.bundle_identifier.as_str())
                .map_err(|error| error.to_string());
            assert_eq!(
                actual.as_ref().map(|value| *value).map_err(String::as_str),
                expected,
                "query: {query}"
            );
        }
    }
    #[test]
    fn localized_names_join_installed_bundles_and_ignore_folder_names() {
        let icon = |id: &str, name: &str| {
            plist::Value::Dictionary(
                [
                    (
                        "displayIdentifier".to_string(),
                        plist::Value::String(id.into()),
                    ),
                    (
                        "bundleIdentifier".to_string(),
                        plist::Value::String(id.into()),
                    ),
                    ("displayName".to_string(), plist::Value::String(name.into())),
                ]
                .into_iter()
                .collect(),
            )
        };
        let icons = plist::Value::Array(vec![plist::Value::Dictionary(
            [
                (
                    "displayName".to_string(),
                    plist::Value::String("私人文件夹".into()),
                ),
                (
                    "iconLists".to_string(),
                    plist::Value::Array(vec![
                        icon("com.tencent.xin", "微信"),
                        icon("com.apple.Preferences", "设置"),
                        icon("not.installed", "未知应用"),
                        plist::Value::Data(vec![0, 1]),
                    ]),
                ),
            ]
            .into_iter()
            .collect(),
        )]);
        let mut apps = vec![
            json!({"bundle_id":"com.tencent.xin","name":"WeChat","aliases":[]}),
            json!({"bundle_id":"com.apple.Preferences","name":"Settings","aliases":[]}),
            json!({"bundle_id":"ctrip.com","name":"携程旅行","aliases":[]}),
        ];
        assert_eq!(add_localized_names(&mut apps, &icons), 2);
        assert_eq!(apps[0]["aliases"], json!(["微信"]));
        assert_eq!(apps[1]["aliases"], json!(["设置"]));
        assert_eq!(apps[2]["aliases"], json!([]));
        assert_eq!(add_localized_names(&mut apps, &icons), 0);
    }
}

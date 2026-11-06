use super::Result;
use idevice::{
    core_device::{ConfigurationServiceClient, CoreDeviceServiceClient, UserInterfaceStyle},
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use serde_json::{Value, json};

/// What a configuration method needs for `value`.
#[derive(Debug, PartialEq)]
enum Argument {
    None,
    Bool,
    Appearance,
    TextSize,
}

fn argument(method: &str) -> Option<Argument> {
    Some(match method {
        "get_increase_contrast"
        | "get_larger_accessibility_sizes"
        | "get_appearance"
        | "get_text_size"
        | "get_reduce_motion"
        | "get_reduce_transparency" => Argument::None,
        "set_larger_accessibility_sizes"
        | "set_reduce_motion"
        | "set_reduce_transparency"
        | "set_increase_contrast" => Argument::Bool,
        "set_appearance" => Argument::Appearance,
        "set_text_size" => Argument::TextSize,
        _ => return None,
    })
}

/// Checks the method and its value before the bridge connects to the device.
pub fn validate(method: &str, value: Option<&Value>) -> Result<()> {
    let valid = match (argument(method), value) {
        (Some(Argument::None), None) => true,
        (Some(Argument::Bool), Some(value)) => value.is_boolean(),
        (Some(Argument::Appearance), Some(value)) => {
            matches!(value.as_str(), Some("light" | "dark"))
        }
        // Dynamic type size names such as `large` or `accessibilityExtraLarge`.
        (Some(Argument::TextSize), Some(value)) => value.as_str().is_some_and(|size| {
            (1..=64).contains(&size.len()) && size.bytes().all(|b| b.is_ascii_alphabetic())
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Invalid configuration method or value".into())
    }
}

pub async fn execute(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    method: &str,
    value: Option<Value>,
) -> Result<Value> {
    validate(method, value.as_ref())?;
    let port = rsd
        .services
        .get("com.apple.coredevice.configuration")
        .ok_or("Device configuration service is unavailable")?
        .port;
    let enabled = || value.as_ref().and_then(Value::as_bool).unwrap_or_default();
    let raw = match method {
        "get_increase_contrast" => "getdeviceincreasecontrast",
        "get_larger_accessibility_sizes" => "getlargeraccessibilitysizesenabled",
        "set_larger_accessibility_sizes" => "setlargeraccessibilitysizesenabled",
        _ => {
            let mut client = ConfigurationServiceClient::new(adapter.connect(port).await?).await?;
            return Ok(match method {
                "get_appearance" => {
                    json!({"appearance": client.get_user_interface_style().await?.as_str()})
                }
                "set_appearance" => {
                    let style = if value.as_ref().and_then(Value::as_str) == Some("dark") {
                        UserInterfaceStyle::Dark
                    } else {
                        UserInterfaceStyle::Light
                    };
                    client.set_user_interface_style(style).await?;
                    json!({"appearance": style.as_str()})
                }
                "get_text_size" => json!({"text_size": client.get_device_text_size().await?}),
                "set_text_size" => {
                    let size = value.as_ref().and_then(Value::as_str).unwrap_or_default();
                    client.set_device_text_size(size).await?;
                    json!({"text_size": size})
                }
                "get_reduce_motion" => json!({"enabled": client.get_reduce_motion().await?}),
                "set_reduce_motion" => {
                    client.set_reduce_motion(enabled()).await?;
                    json!({"enabled": enabled()})
                }
                "get_reduce_transparency" => {
                    json!({"enabled": client.get_reduce_transparency().await?})
                }
                "set_reduce_transparency" => {
                    client.set_reduce_transparency(enabled()).await?;
                    json!({"enabled": enabled()})
                }
                "set_increase_contrast" => {
                    client.set_increase_contrast(enabled()).await?;
                    json!({"enabled": enabled()})
                }
                _ => return Err("Unknown configuration method".into()),
            });
        }
    };
    let mut input = plist::Dictionary::new();
    if method == "set_larger_accessibility_sizes" {
        // The service accepts a top-level enabled boolean.
        input.insert("enabled".into(), enabled().into());
    }
    let mut client = CoreDeviceServiceClient::new(adapter.connect(port).await?).await?;
    let response = client
        .invoke_action_with_plist(format!("com.apple.coredevice.action.{raw}"), input)
        .await?;
    Ok(serde_json::to_value(response)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn getters_take_no_value() {
        for method in [
            "get_increase_contrast",
            "get_larger_accessibility_sizes",
            "get_appearance",
            "get_text_size",
            "get_reduce_motion",
            "get_reduce_transparency",
        ] {
            assert!(validate(method, None).is_ok(), "{method}");
            assert!(validate(method, Some(&json!(true))).is_err(), "{method}");
        }
    }

    #[test]
    fn setters_check_their_value() {
        for method in [
            "set_larger_accessibility_sizes",
            "set_reduce_motion",
            "set_reduce_transparency",
            "set_increase_contrast",
        ] {
            assert!(validate(method, Some(&json!(false))).is_ok(), "{method}");
            assert!(validate(method, Some(&json!("on"))).is_err(), "{method}");
            assert!(validate(method, None).is_err(), "{method}");
        }
        assert!(validate("set_appearance", Some(&json!("dark"))).is_ok());
        assert!(validate("set_appearance", Some(&json!("light"))).is_ok());
        assert!(validate("set_appearance", Some(&json!("sepia"))).is_err());
        assert!(validate("set_appearance", None).is_err());
        assert!(validate("set_text_size", Some(&json!("accessibilityExtraLarge"))).is_ok());
        assert!(validate("set_text_size", Some(&json!(""))).is_err());
        assert!(validate("set_text_size", Some(&json!("extra-large"))).is_err());
        assert!(validate("set_text_size", Some(&json!(3))).is_err());
        assert!(validate("set_opacity", Some(&json!(0.5))).is_err());
    }
}

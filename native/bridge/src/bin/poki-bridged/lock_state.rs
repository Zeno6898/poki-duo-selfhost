//! Whether the phone is locked (fork-only).
//!
//! A locked phone takes launch_app (launched: true) and taps but shows none of it, so without
//! this the daemon cannot tell "locked" from "slow". SpringBoard posts Darwin notifications when
//! the lock state changes, and the notification proxy (over RSD, its lockdown shim) relays the ones
//! a client observes. They carry no value, so the state is followed from their order:
//! `lockcomplete` comes once the phone locked; `lockstate` comes on every change (just before
//! `lockcomplete` when locking, alone when unlocking). `hasBlankedScreen` comes when the display
//! turns off or on. Until the first notification the state is unknown.
//!
//! `device_state_probe {seconds=20}` records every observed notification and what the
//! diagnostics relay's IORegistry says about the backlight, so one run on the phone (lock, wake,
//! unlock during it) shows which signals exist and in what order.
use super::*;
use idevice::{
    RsdService, diagnostics_relay::DiagnosticsRelayClient,
    notification_proxy::NotificationProxyClient,
};
use std::collections::VecDeque;

pub const LOCK_COMPLETE: &str = "com.apple.springboard.lockcomplete";
pub const LOCK_STATE: &str = "com.apple.springboard.lockstate";
pub const BLANKED: &str = "com.apple.springboard.hasBlankedScreen";
const OBSERVED: [&str; 6] = [
    LOCK_COMPLETE,
    LOCK_STATE,
    BLANKED,
    "com.apple.iokit.hid.displayStatus",
    "com.apple.springboard.pluggedin",
    "com.apple.mobile.keybagd.lock_status",
];

/// The lock state as the notifications tell it.
#[derive(Default)]
pub struct DeviceState {
    state: Option<&'static str>,
    since: Option<std::time::SystemTime>,
    last_lock_complete: Option<Instant>,
    pub(crate) watching: bool,
    pub(crate) error: Option<String>,
    events: VecDeque<(String, std::time::SystemTime)>,
}

pub type DeviceCell = Rc<std::cell::RefCell<DeviceState>>;

impl DeviceState {
    /// Takes one notification.
    pub fn note(&mut self, name: &str, now: Instant) {
        let wall = std::time::SystemTime::now();
        if self.events.len() >= 8 {
            self.events.pop_front();
        }
        self.events.push_back((name.to_string(), wall));
        let next = match name {
            LOCK_COMPLETE => {
                self.last_lock_complete = Some(now);
                Some("locked")
            }
            // Locking posts lockstate just before lockcomplete; a lockstate well after the lock
            // completed is the unlock.
            LOCK_STATE
                if self.state == Some("locked")
                    && self
                        .last_lock_complete
                        .is_none_or(|at| now.duration_since(at) > Duration::from_millis(500)) =>
            {
                Some("awake")
            }
            _ => None,
        };
        if let Some(next) = next
            && self.state != Some(next)
        {
            self.state = Some(next);
            self.since = Some(wall);
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "state": self.state.unwrap_or("unknown"),
            "since": self.since.map(crate::ax::watch::stamp_at),
            "via": if self.watching { "notifications" } else { "none" },
            "error": self.error,
            "recent": self.events.iter().map(|(name, at)| json!({"name": name, "at": crate::ax::watch::stamp_at(*at)})).collect::<Vec<_>>(),
        })
    }
}

/// Follows the lock notifications on the held tunnel, reconnecting when the tunnel comes back.
pub async fn watch(state: Rc<State>) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let client = {
            let Ok(mut session) = state.session.try_lock() else {
                continue;
            };
            let Some(link) = session.link.as_mut() else {
                continue;
            };
            let device = &mut link.device;
            NotificationProxyClient::connect_rsd(&mut device.adapter, &mut device.rsd).await
        };
        let mut client = match client {
            Ok(client) => client,
            Err(error) => {
                state.device.borrow_mut().error = Some(error.to_string());
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };
        if let Err(error) = client.observe_notifications(&OBSERVED).await {
            state.device.borrow_mut().error = Some(error.to_string());
            continue;
        }
        state.device.borrow_mut().watching = true;
        state.device.borrow_mut().error = None;
        log("device state: watching lock notifications");
        loop {
            match client.receive_notification().await {
                Ok(name) => {
                    log(&format!("device state: {name}"));
                    state.device.borrow_mut().note(&name, Instant::now());
                }
                Err(error) => {
                    let mut device = state.device.borrow_mut();
                    device.watching = false;
                    device.error = Some(error.to_string());
                    log(&format!("device state: notifications ended ({error})"));
                    break;
                }
            }
        }
    }
}

/// Keys of an IORegistry answer and a few short values, for the probe.
fn summary(value: &plist::Value, depth: usize) -> Value {
    match value {
        plist::Value::Dictionary(d) if depth < 3 => Value::Object(
            d.iter()
                .take(60)
                .map(|(k, v)| (k.clone(), summary(v, depth + 1)))
                .collect(),
        ),
        plist::Value::Array(a) if depth < 3 => {
            Value::Array(a.iter().take(10).map(|v| summary(v, depth + 1)).collect())
        }
        plist::Value::Boolean(b) => (*b).into(),
        plist::Value::Integer(i) => i.as_signed().map_or(Value::Null, Into::into),
        plist::Value::Real(r) => (*r).into(),
        plist::Value::String(s) => s.chars().take(80).collect::<String>().into(),
        plist::Value::Data(d) => format!("<{} bytes>", d.len()).into(),
        _ => "...".into(),
    }
}

pub async fn probe(
    adapter: &mut idevice::tcp::handle::AdapterHandle,
    rsd: &mut idevice::rsd::RsdHandshake,
    seconds: f64,
) -> Result<Value> {
    let mut registry = serde_json::Map::new();
    match DiagnosticsRelayClient::connect_rsd(adapter, rsd).await {
        Ok(mut relay) => {
            for class in [
                "AppleARMBacklight",
                "IOMobileFramebuffer",
                "AppleCLCD2",
                "IOPMrootDomain",
            ] {
                let answer = match relay.ioregistry(None, None, Some(class)).await {
                    Ok(Some(found)) => summary(&plist::Value::Dictionary(found), 0),
                    Ok(None) => Value::Null,
                    Err(error) => json!({"error": error.to_string()}),
                };
                registry.insert(class.into(), answer);
            }
            let _ = relay.goodbye().await;
        }
        Err(error) => {
            registry.insert("error".into(), error.to_string().into());
        }
    }
    let started = Instant::now();
    let mut events = Vec::new();
    let mut notifications = NotificationProxyClient::connect_rsd(adapter, rsd).await?;
    notifications.observe_notifications(&OBSERVED).await?;
    let until = tokio::time::Instant::now() + Duration::from_secs_f64(seconds.clamp(1.0, 120.0));
    while let Ok(received) =
        tokio::time::timeout_at(until, notifications.receive_notification()).await
    {
        match received {
            Ok(name) => {
                events.push(json!({"ms": started.elapsed().as_millis() as u64, "name": name}))
            }
            Err(error) => {
                events.push(
                    json!({"ms": started.elapsed().as_millis() as u64, "error": error.to_string()}),
                );
                break;
            }
        }
    }
    Ok(json!({"ioregistry": registry, "observed": OBSERVED, "notifications": events}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_state_follows_the_order_of_springboard_notifications() {
        let mut device = DeviceState::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert_eq!(device.json()["state"], "unknown");
        // Locking: lockstate, then lockcomplete.
        device.note(LOCK_STATE, at(0));
        assert_eq!(
            device.json()["state"],
            "unknown",
            "lockstate alone says nothing yet"
        );
        device.note(LOCK_COMPLETE, at(20));
        assert_eq!(device.json()["state"], "locked");
        device.note(LOCK_STATE, at(100));
        assert_eq!(
            device.json()["state"],
            "locked",
            "the same lock's notifications"
        );
        device.note(BLANKED, at(2000));
        assert_eq!(device.json()["state"], "locked");
        // Unlocking: lockstate alone.
        device.note(LOCK_STATE, at(9000));
        assert_eq!(device.json()["state"], "awake");
        assert_eq!(device.json()["recent"].as_array().unwrap().len(), 5);
    }
}

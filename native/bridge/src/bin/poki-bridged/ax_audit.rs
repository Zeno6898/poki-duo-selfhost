//! Spike (fork-only): does the accessibility audit daemon push anything when the screen changes?
//!
//! poki-native reads trees from `axAuditDaemon.remoteAXService`, which answers one subscription
//! with one tree and pushes nothing unasked (measured Nov 6). Accessibility Inspector talks to a
//! different service on the same daemon, `axAuditDaemon.remoteserver` (over RSD,
//! `...remoteserver.shim.remote`), with `device*` calls and `host*` callbacks. The public clients
//! (pymobiledevice3, the ios-core crate) only handle `hostInspectorCurrentElementChanged:` (the
//! inspector's focused element: caption, spoken description, platform element bytes, no frame),
//! `hostInspectorMonitoredEventTypeChanged:` and `hostDeviceDidCompleteAuditCategoriesWithAuditIssues:`.
//! None of them is a tree. This probe turns on app monitoring, listens, and records every message
//! the phone sends with the live screen's epoch at that moment, so one run on the phone shows
//! whether any callback follows screen changes and how long after the change it comes.
//!
//! `ax_audit_probe {seconds=10, event_type?}`. Read-only: nothing is focused, moved or performed.
use super::*;
use std::time::Instant;

const SERVICES: [&str; 2] = [
    "com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote",
    "com.apple.accessibility.axAuditDaemon.remoteserver",
];

fn summary(value: &Value) -> Json {
    match value {
        Value::String(s) => Json::String(s.chars().take(200).collect()),
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => i.as_signed().map_or(Json::Null, Into::into),
        Value::Real(r) => (*r).into(),
        Value::Data(d) => format!("<{} bytes>", d.len()).into(),
        Value::Array(a) => Json::Array(a.iter().take(20).map(summary).collect()),
        Value::Dictionary(d) => Json::Object(
            d.iter()
                .take(40)
                .map(|(k, v)| (k.clone(), summary(v)))
                .collect(),
        ),
        _ => Json::Null,
    }
}

/// What one message carried: its selector (for an invocation) and its arguments, summarized.
fn describe(message: &Message) -> Json {
    let selector = message.data.as_ref().and_then(|d| match d {
        Value::String(s) => Some(s.clone()),
        _ => None,
    });
    let arguments: Vec<Json> = message
        .aux
        .as_ref()
        .map(|aux| {
            aux.values
                .iter()
                .map(|value| match value {
                    AuxValue::Array(bytes) => Value::from_reader(std::io::Cursor::new(bytes))
                        .map(|v| summary(&v))
                        .unwrap_or_else(|_| format!("<{} bytes>", bytes.len()).into()),
                    other => format!("{other:?}")
                        .chars()
                        .take(120)
                        .collect::<String>()
                        .into(),
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({
        "selector": selector,
        "data": if selector.is_none() { message.data.as_ref().map(summary) } else { None },
        "arguments": arguments,
        "channel": message.message_header.channel,
        "expects_reply": message.message_header.serialize()[28..32] != [0, 0, 0, 0],
    })
}

/// Reads and answers messages until none arrives for `quiet`.
async fn drain(socket: &mut impl ReadWrite, quiet: Duration, record: &mut impl FnMut(&Message)) {
    while let Ok(Ok(message)) = tokio::time::timeout(quiet, Message::from_reader(socket)).await {
        let _ = acknowledge(socket, &message).await;
        record(&message);
    }
}

pub async fn probe(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    live: Option<crate::frames::Live>,
    seconds: f64,
    event_type: Option<i64>,
) -> Result<Json> {
    let Some((name, port)) = SERVICES
        .iter()
        .find_map(|name| rsd.services.get(*name).map(|s| (*name, s.port)))
    else {
        let mut listed: Vec<&String> = rsd
            .services
            .keys()
            .filter(|k| k.contains("ccessibility"))
            .collect();
        listed.sort();
        return Ok(serde_json::json!({"available": false, "accessibility_services": listed}));
    };
    let started = Instant::now();
    let mut socket = adapter.connect(port).await?;
    let epoch = || {
        live.as_ref().map(|live| {
            let state = live.state(crate::frames::settle_time());
            serde_json::json!({
                "epoch": state.epoch,
                "last_change_ms_ago": state.last_change.map(|(at, _)| at.elapsed().as_millis() as u64),
                "last_input_ms_ago": state.last_input.map(|at| at.elapsed().as_millis() as u64),
            })
        })
    };
    let mut events: Vec<Json> = Vec::new();
    let mut counts = std::collections::BTreeMap::<String, u64>::new();
    let mut record = |message: &Message| {
        let mut event = describe(message);
        let key = event["selector"].as_str().unwrap_or("(reply)").to_owned();
        *counts.entry(key).or_default() += 1;
        event["ms"] = (started.elapsed().as_millis() as u64).into();
        event["screen"] = epoch().into();
        if events.len() < 300 {
            events.push(event);
        }
    };
    // The service sends its own messages first (capabilities); answer them before calling.
    drain(&mut socket, Duration::from_millis(600), &mut record).await;
    let mut calls = vec![
        ("deviceCapabilities", None),
        ("deviceApiVersion", None),
        ("deviceSetAppMonitoringEnabled:", Some(Value::Boolean(true))),
    ];
    if let Some(kind) = event_type {
        calls.push((
            "deviceInspectorSetMonitoredEventType:",
            Some(Value::Integer(kind.into())),
        ));
    }
    for (i, (selector, argument)) in calls.into_iter().enumerate() {
        let id = 10 + i as u32;
        match argument {
            Some(argument) => call(&mut socket, id, selector, argument, true).await?,
            None => {
                let message = Message::new(
                    MessageHeader::new(0, 1, id, 0, 0, true),
                    PayloadHeader::method_invocation(),
                    None,
                    Some(selector.into()),
                );
                socket.write_all(&message.serialize()).await?;
            }
        }
        drain(&mut socket, Duration::from_millis(300), &mut record).await;
    }
    let listen = Duration::from_secs_f64(seconds.clamp(1.0, 120.0));
    let until = tokio::time::Instant::now() + listen;
    while tokio::time::Instant::now() < until {
        let message = tokio::time::timeout_at(until, Message::from_reader(&mut socket)).await;
        match message {
            Ok(Ok(message)) => {
                let _ = acknowledge(&mut socket, &message).await;
                record(&message);
            }
            Ok(Err(_)) => break,
            Err(_) => {}
        }
    }
    let _ = call(
        &mut socket,
        90,
        "deviceSetAppMonitoringEnabled:",
        Value::Boolean(false),
        false,
    )
    .await;
    let _ = socket.shutdown().await;
    drop(record);
    Ok(serde_json::json!({
        "available": true,
        "service": name,
        "listened_ms": listen.as_millis() as u64,
        "counts": counts,
        "events": events,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_callback_is_described_by_its_selector_and_arguments() {
        let mut fields = plist::Dictionary::new();
        fields.insert("CaptionTextValue_v1".into(), "Notes".into());
        let mut bytes = Vec::new();
        Value::Dictionary(fields)
            .to_writer_binary(&mut bytes)
            .unwrap();
        let message = Message::new(
            MessageHeader::new(0, 1, 7, 0, 0, false),
            PayloadHeader::method_invocation(),
            Some(Aux {
                header: AuxHeader::default(),
                values: vec![AuxValue::Array(bytes)],
            }),
            Some("hostInspectorCurrentElementChanged:".into()),
        );
        let described = describe(&message);
        assert_eq!(described["selector"], "hostInspectorCurrentElementChanged:");
        assert_eq!(described["arguments"][0]["CaptionTextValue_v1"], "Notes");
        assert_eq!(described["expects_reply"], false);
    }
}

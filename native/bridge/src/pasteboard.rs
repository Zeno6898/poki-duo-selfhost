// Protocol fields follow jkcoxson/idevice pasteboard_service.rs (8970209), MIT.
use super::{Keyboard, Result, chord};
use idevice::{
    RemoteXpcClient, rsd::RsdHandshake, tcp::handle::AdapterHandle, xpc, xpc::XPCObject,
};
use std::time::Duration;

/// The field a caller found on screen. Lists reuse cells, so an object id alone does not name it.
#[derive(serde::Deserialize)]
pub struct Target {
    object_id: String,
    role: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    value: String,
}

pub async fn paste_text(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    keyboard: &mut Keyboard,
    text: &str,
    clear: bool,
    submit: bool,
    target: Option<&Target>,
) -> Result<serde_json::Value> {
    super::trace("paste AX initial");
    let Ok(mut initial) = observe(adapter, rsd).await else {
        return Ok(unconfirmed(
            "accessibility_unavailable_before_input",
            false,
            false,
        ));
    };
    if let Some(left_over) = paste_prompt(&initial) {
        // This request has pasted nothing yet, so Allow would paste whatever the clipboard holds now.
        if let Some((x, y)) = left_over.deny {
            tokio::time::sleep(ALERT_ACCEPTS_TOUCHES_AFTER).await;
            super::held_tap(&mut keyboard.hid, x, y, 50).await?;
            tokio::time::sleep(ALERT_ACCEPTS_TOUCHES_AFTER).await;
            match observe(adapter, rsd).await {
                Ok(tree) => initial = tree,
                Err(_) => {
                    return Ok(unconfirmed(
                        "accessibility_unavailable_before_input",
                        false,
                        false,
                    ));
                }
            }
        }
        if paste_prompt(&initial).is_some() {
            return Ok(unconfirmed("paste_permission", false, false));
        }
    }
    let all = fields(&initial);
    if all.is_empty() {
        return Ok(unconfirmed("no_accessible_text_field", false, false));
    }
    // Key presses carry no target, so this is the last moment a wrong field can be left untouched.
    let mut baseline = match select_fields(&all, target, clear) {
        Ok(selected) => selected,
        Err(refusal) => return Ok(refused(&refusal)),
    };
    let others: Vec<Field> = all
        .iter()
        .filter(|field| !baseline.iter().any(|chosen| chosen.id == field.id))
        .cloned()
        .collect();
    // Backspace on an empty row can delete the row and move the cursor to its neighbor.
    let clear_first = clear && baseline.iter().any(|field| !field.empty());

    // A clear-only request does not need or modify the user's clipboard.
    if text.is_empty() {
        if clear_first {
            clear_text(keyboard).await?;
        }
        let checked = verify(adapter, rsd, &baseline, &others, "", true).await;
        if !matches!(checked.status, Verification::Complete) {
            return Ok(with_changes(
                unconfirmed(checked.status.reason(), clear_first, false),
                &checked.changed,
            ));
        }
        if !checked.changed.is_empty() {
            return Ok(other_field_changed(
                completed(0, false, true, &baseline),
                &checked.changed,
            ));
        }
        if submit {
            chord(keyboard, 0x28, &[]).await?;
        }
        return Ok(completed(0, submit, true, &baseline));
    }

    let port = rsd
        .services
        .get("com.apple.coredevice.pasteboardservice")
        .ok_or("Device has no pasteboard service")?
        .port;
    super::trace("pasteboard PULL");
    // SET + Cmd+V sends the text. Snapshot restoration is best effort.
    // Match the source without resolving promises.
    // A delayed PULL must not block that input path, nor
    // leave a late PULL_REPLY queued on the connection used for SET.
    let previous_items = tokio::time::timeout(Duration::from_secs(8), async {
        let mut snapshot_client = RemoteXpcClient::new(adapter.connect(port).await?).await?;
        snapshot_client.do_handshake().await?;
        complete_items(&pull(&mut snapshot_client).await?)
    })
    .await
    .ok()
    .and_then(std::result::Result::ok);
    let snapshot_status = if previous_items.is_some() {
        "complete"
    } else {
        "unavailable"
    };
    if clear_first {
        super::trace("paste clear");
        clear_text(keyboard).await?;
        super::trace("paste AX cleared");
        let tree = match observe(adapter, rsd).await {
            Ok(tree) => tree,
            Err(_) => {
                return Ok(clipboard_result(
                    unconfirmed("clear_not_verified", true, false),
                    snapshot_status,
                    "not_modified",
                ));
            }
        };
        if paste_prompt(&tree).is_some() {
            return Ok(clipboard_result(
                unconfirmed("paste_permission", true, false),
                snapshot_status,
                "not_modified",
            ));
        }
        let current = fields(&tree);
        if target.is_some() && !still_editing(&current, &baseline) {
            return Ok(clipboard_result(
                unconfirmed("clear_not_verified", true, false),
                snapshot_status,
                "not_modified",
            ));
        }
        baseline.retain(|before| {
            current
                .iter()
                .any(|after| after.id == before.id && after.empty())
        });
        if baseline.is_empty() {
            return Ok(clipboard_result(
                unconfirmed("clear_not_verified", true, false),
                snapshot_status,
                "not_modified",
            ));
        }
        baseline = current
            .into_iter()
            .filter(|after| baseline.iter().any(|before| before.id == after.id))
            .collect();
    }
    let new_items = xpc!([{"types":["public.utf8-plain-text","public.plain-text","public.text"],"data":{
        "public.utf8-plain-text":{"data":text.as_bytes()},"public.plain-text":{"data":text.as_bytes()},"public.text":{"data":text.as_bytes()}
    }}]);
    let expected = new_items.to_plist();
    super::trace("pasteboard connect for SET");
    let mut client = RemoteXpcClient::new(adapter.connect(port).await?).await?;
    client.do_handshake().await?;
    super::trace("pasteboard SET");
    client.send_object(xpc!({"command":"SET","pasteboardName":"general","items":new_items,"sourceMetadata":XPCObject::Null}),true).await?;
    check_reply(&client.recv().await?)?;
    super::trace("paste command V");
    if chord(keyboard, 0x19, &[0xe3]).await.is_err() {
        return Ok(clipboard_result(
            unconfirmed("paste_dispatch_unconfirmed", true, true),
            snapshot_status,
            "retained_pending_paste",
        ));
    }
    let mut checked = verify(adapter, rsd, &baseline, &others, text, clear).await;
    // This request's own Command-V raised the prompt, so what Allow pastes is the text just set.
    // Return still waits for the read-back below.
    let mut answered = false;
    for _ in 0..2 {
        let Verification::Permission(Prompt {
            allow: Some((x, y)),
            ..
        }) = checked.status
        else {
            break;
        };
        super::trace("paste permission: tapping allow");
        tokio::time::sleep(ALERT_ACCEPTS_TOUCHES_AFTER).await;
        if super::held_tap(&mut keyboard.hid, x, y, 50).await.is_err() {
            break;
        }
        answered = true;
        checked = verify(adapter, rsd, &baseline, &others, text, clear).await;
    }
    super::trace("paste verification returned");
    if !matches!(checked.status, Verification::Complete) {
        // The OS may still be waiting to consume this text. Keep it, never
        // send Return, and drop the prior clipboard snapshot from memory when
        // this request ends.
        return Ok(clipboard_result(
            with_changes(
                unconfirmed(checked.status.reason(), true, true),
                &checked.changed,
            ),
            snapshot_status,
            "retained_pending_paste",
        ));
    }

    // Only restore after AX proves the text landed. Do not overwrite a
    // clipboard change made by the user while the request was in progress.
    let restore_status = match previous_items {
        Some(previous) => match restore(&mut client, &expected, previous).await {
            Ok(true) => "restored",
            Ok(false) => "clipboard_changed",
            Err(_) => "restore_failed",
        },
        None => "unavailable",
    };
    super::trace("paste restoration returned");
    let characters = text.chars().count();
    let restored = restore_status == "restored";
    if !checked.changed.is_empty() {
        return Ok(clipboard_result(
            noting_answer(
                other_field_changed(
                    completed(characters, false, restored, &baseline),
                    &checked.changed,
                ),
                answered,
            ),
            snapshot_status,
            restore_status,
        ));
    }
    if submit {
        chord(keyboard, 0x28, &[]).await?;
    }
    Ok(clipboard_result(
        noting_answer(completed(characters, submit, restored, &baseline), answered),
        snapshot_status,
        restore_status,
    ))
}

async fn observe(adapter: &mut AdapterHandle, rsd: &RsdHandshake) -> Result<serde_json::Value> {
    tokio::time::timeout(
        Duration::from_secs(4),
        super::ax::read_tree_with_timeout(adapter, rsd, false, Duration::from_secs(4)),
    )
    .await
    .map_err(|_| "AX observation connection or handshake timed out")?
}

#[derive(Clone)]
struct Field {
    id: String,
    role: String,
    label: Option<String>,
    value: String,
    placeholder: Option<String>,
    focused: bool,
    secure: bool,
}
impl Field {
    fn empty(&self) -> bool {
        self.value.is_empty() || self.placeholder.as_deref() == Some(self.value.as_str())
    }
    fn text(&self) -> &str {
        if self.empty() { "" } else { &self.value }
    }
    fn name(&self) -> &str {
        self.label
            .as_deref()
            .or(self.placeholder.as_deref())
            .unwrap_or("")
    }
}

struct Refusal {
    reason: &'static str,
    editing: Option<String>,
}

/// Picks the field that key presses will reach, before the first of them is sent.
fn select_fields(
    all: &[Field],
    target: Option<&Target>,
    clear: bool,
) -> std::result::Result<Vec<Field>, Refusal> {
    let refuse = |reason, editing| Refusal { reason, editing };
    let editing: Vec<&Field> = all.iter().filter(|field| field.focused).collect();
    let Some(target) = target else {
        return match editing.as_slice() {
            [one] => Ok(vec![(*one).clone()]),
            // Appending stays at the cursor; only deleting needs to know what it deletes.
            _ if !clear => Ok(all.to_vec()),
            [] => Err(refuse("no_editing_field", None)),
            _ => Err(refuse("several_editing_fields", None)),
        };
    };
    match editing.as_slice() {
        [] => Err(refuse("no_editing_field", None)),
        [one] if one.id != target.object_id => {
            Err(refuse("other_field_editing", Some(one.name().to_owned())))
        }
        [one]
            if one.role != target.role
                || one.label != target.label
                || one.placeholder != target.placeholder
                || one.value != target.value =>
        {
            Err(refuse("target_changed", Some(one.name().to_owned())))
        }
        [one] => Ok(vec![(*one).clone()]),
        _ => Err(refuse("several_editing_fields", None)),
    }
}

fn still_editing(current: &[Field], chosen: &[Field]) -> bool {
    let editing: Vec<&Field> = current.iter().filter(|field| field.focused).collect();
    matches!(editing.as_slice(), [one] if chosen.iter().any(|field| field.id == one.id))
}

fn changed_fields(after: &[Field], others: &[Field]) -> Vec<serde_json::Value> {
    others
        .iter()
        .filter(|before| {
            after
                .iter()
                .any(|field| field.id == before.id && field.value != before.value)
        })
        .map(|before| {
            serde_json::json!({"object_id":before.id,"name":before.name(),"previous_value":before.text()})
        })
        .collect()
}
fn fields(tree: &serde_json::Value) -> Vec<Field> {
    tree.get("elements")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|element| {
            let role = element.get("role").and_then(serde_json::Value::as_str)?;
            if !["TextField", "SearchField", "TextView", "SecureTextField"].contains(&role) {
                return None;
            }
            Some(Field {
                id: element.get("object_id")?.as_str()?.into(),
                role: role.into(),
                label: element
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                value: element
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .into(),
                placeholder: element
                    .get("placeholder")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                focused: element
                    .get("focused")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                secure: role == "SecureTextField",
            })
        })
        .collect()
}

// An alert reports its final place at once but ignores touches for about 500 ms.
const ALERT_ACCEPTS_TOUCHES_AFTER: Duration = Duration::from_millis(600);

/// The system's paste permission prompt, with where each of its buttons can be touched.
struct Prompt {
    allow: Option<(u16, u16)>,
    deny: Option<(u16, u16)>,
}

// The English phrases are recovered PromptDetector paste rules. The Chinese
// equivalents cover the two system localizations already used on this device.
fn paste_prompt(tree: &serde_json::Value) -> Option<Prompt> {
    const ALLOW: [&str; 3] = ["allow paste", "允许粘贴", "允許貼上"];
    const DENY: [&str; 4] = [
        "don't allow paste",
        "don’t allow paste",
        "不允许粘贴",
        "不允許貼上",
    ];
    let elements = tree.get("elements")?.as_array()?;
    let screen = elements.iter().find_map(|element| {
        (element.get("role")?.as_str()? == "Application").then_some(())?;
        let frame = element.get("frame")?;
        Some((
            frame.get("width")?.as_f64()?,
            frame.get("height")?.as_f64()?,
        ))
    });
    let mut found = false;
    let mut prompt = Prompt {
        allow: None,
        deny: None,
    };
    for element in elements {
        let role = element
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if ["TextField", "SearchField", "TextView", "SecureTextField"].contains(&role) {
            continue;
        }
        for key in ["label", "value"] {
            let Some(text) = element.get(key).and_then(serde_json::Value::as_str) else {
                continue;
            };
            let text = text.trim().to_lowercase();
            let (allow, deny) = (
                ALLOW.contains(&text.as_str()),
                DENY.contains(&text.as_str()),
            );
            found |= allow
                || deny
                || text.contains("would like to paste from")
                || text.contains("paste from \"dtpasteboardd\"")
                || text.contains("paste from “dtpasteboardd”");
            let place = screen.and_then(|screen| touch_point(element, screen));
            if allow {
                prompt.allow = prompt.allow.or(place);
            } else if deny {
                prompt.deny = prompt.deny.or(place);
            }
        }
    }
    found.then_some(prompt)
}

/// The middle of an element in touch coordinates, which run from 0 to 65535 across the screen.
fn touch_point(element: &serde_json::Value, (width, height): (f64, f64)) -> Option<(u16, u16)> {
    let frame = element.get("frame")?;
    let number = |key| frame.get(key)?.as_f64();
    let x = number("x")? + number("width")? / 2.0;
    let y = number("y")? + number("height")? / 2.0;
    let scale =
        |at: f64, across: f64| (at / (across - 1.0) * 65535.0).round().clamp(0.0, 65535.0) as u16;
    Some((scale(x, width), scale(y, height)))
}

enum Verification {
    Complete,
    Permission(Prompt),
    Unconfirmed,
}
impl Verification {
    fn reason(&self) -> &'static str {
        match self {
            Self::Permission(_) => "paste_permission",
            Self::Unconfirmed => "text_not_verified",
            Self::Complete => "verified",
        }
    }
}
struct Checked {
    status: Verification,
    changed: Vec<serde_json::Value>,
}
async fn verify(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    baseline: &[Field],
    others: &[Field],
    text: &str,
    clear: bool,
) -> Checked {
    let mut changed = Vec::new();
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let Ok(tree) = observe(adapter, rsd).await else {
            continue;
        };
        if let Some(prompt) = paste_prompt(&tree) {
            return Checked {
                status: Verification::Permission(prompt),
                changed,
            };
        }
        let after = fields(&tree);
        changed = changed_fields(&after, others);
        let confirmed: Vec<_> = baseline
            .iter()
            .filter(|before| {
                after.iter().any(|field| {
                    if field.id != before.id || field.secure {
                        return false;
                    }
                    if text.is_empty() {
                        return field.empty();
                    }
                    if clear {
                        return field.value == text && before.text() != field.value;
                    }
                    replacement_matches(before.text(), field.text(), text)
                })
            })
            .collect();
        if confirmed.len() == 1 {
            return Checked {
                status: Verification::Complete,
                changed,
            };
        }
    }
    Checked {
        status: Verification::Unconfirmed,
        changed,
    }
}
fn replacement_matches(before: &str, after: &str, text: &str) -> bool {
    if before == after || text.is_empty() {
        return false;
    }
    after.match_indices(text).any(|(offset, _)| {
        let prefix = &after[..offset];
        let suffix = &after[offset + text.len()..];
        before.len() >= prefix.len() + suffix.len()
            && before.starts_with(prefix)
            && before.ends_with(suffix)
    })
}
/// What went unconfirmed and what the caller can do about it. Return was not sent.
fn unconfirmed(reason: &str, sent: bool, clipboard_changed: bool) -> serde_json::Value {
    let next = match reason {
        "accessibility_unavailable_before_input" => {
            "The screen could not be read before typing, so nothing was typed. Retry, or take a screenshot to see what is in front."
        }
        "no_accessible_text_field" => {
            "No text field could be read on screen, so nothing was typed. Tap a field or take a screenshot to see what is in front."
        }
        "clear_not_verified" => {
            "The field could not be emptied first, so the new text was not typed. Read the field before retrying."
        }
        "paste_dispatch_unconfirmed" => {
            "The paste keystroke may not have reached the device. Read the field, then retry if the text is missing."
        }
        "paste_permission" => {
            "A system paste prompt is still on screen: its Allow Paste button could not be read, or tapping it did not clear the prompt. Answer it with handle_alert, read the field, then retry if the text is missing."
        }
        _ => {
            "The text did not show up in the field, which may not have had focus. Read the field, then retry."
        }
    };
    let held = if clipboard_changed {
        " The text stays on the device clipboard; the previous clipboard was not saved to disk."
    } else {
        ""
    };
    serde_json::json!({"isError":true,"stop_reason":"error","reason":reason,"sent":sent,"screen_change_verified":false,"text_verified":false,
        "submitted":false,"submit_sent":false,"clipboard_restored":false,"clipboard_changed_by_this_request":clipboard_changed,
        "clipboard_retained_for_paste":clipboard_changed,
        "instruction":format!("{next}{held} Return was not sent.")})
}
fn noting_answer(mut result: serde_json::Value, answered: bool) -> serde_json::Value {
    if answered {
        result["paste_permission_answered"] = true.into();
    }
    result
}
fn refused(refusal: &Refusal) -> serde_json::Value {
    let why = match (refusal.reason, refusal.editing.as_deref()) {
        ("other_field_editing", Some(name)) => {
            format!("{name:?} is being edited, not the requested field.")
        }
        ("target_changed", _) => "The requested field changed before typing.".to_owned(),
        ("several_editing_fields", _) => {
            "Several text fields report being edited, so the right one cannot be confirmed."
                .to_owned()
        }
        _ => "No text field is being edited.".to_owned(),
    };
    serde_json::json!({"isError":true,"outcome":"not_sent","stop_reason":"error","reason":refusal.reason,"editing_field":refusal.editing,
        "sent":false,"screen_change_verified":false,"text_verified":false,"submitted":false,"submit_sent":false,
        "clipboard_restored":false,"clipboard_changed_by_this_request":false,
        "instruction":format!("{why} Nothing was typed. Look at the screen before retrying.")})
}
fn with_changes(mut result: serde_json::Value, changed: &[serde_json::Value]) -> serde_json::Value {
    if !changed.is_empty() {
        result["changed_fields"] = changed.into();
    }
    result
}
fn other_field_changed(
    result: serde_json::Value,
    changed: &[serde_json::Value],
) -> serde_json::Value {
    let mut result = with_changes(result, changed);
    result["isError"] = true.into();
    result["stop_reason"] = "error".into();
    result["reason"] = "other_field_changed".into();
    result["instruction"] = "The requested field holds the text, but another field changed too; changed_fields has its previous value. Return was not sent. Look at the screen before continuing.".into();
    result
}
fn completed(
    characters: usize,
    submit_sent: bool,
    restored: bool,
    chosen: &[Field],
) -> serde_json::Value {
    let mut result = serde_json::json!({"sent":true,"screen_change_verified":false,"text_verified":true,"verification_source":"accessibility",
        "characters":characters,"submit_sent":submit_sent,"submission_verified":false,"clipboard_restored":restored});
    if let [field] = chosen {
        result["field"] =
            serde_json::json!({"object_id":field.id,"role":field.role,"name":field.name()});
    }
    result
}
fn clipboard_result(
    mut result: serde_json::Value,
    snapshot: &str,
    restoration: &str,
) -> serde_json::Value {
    result["clipboard_snapshot"] = snapshot.into();
    result["clipboard_restore_status"] = restoration.into();
    result["restore_unavailable"] = (snapshot == "unavailable").into();
    result
}

fn complete_items(value: &plist::Value) -> Result<plist::Value> {
    let items = snapshot(value)?
        .get("items")
        .and_then(plist::Value::as_array)
        .ok_or("Pasteboard snapshot lacks items")?;
    for item in items {
        let item = item.as_dictionary().ok_or("Invalid clipboard item")?;
        let types = item
            .get("types")
            .and_then(plist::Value::as_array)
            .ok_or("Invalid clipboard types")?;
        let data = item
            .get("data")
            .and_then(plist::Value::as_dictionary)
            .ok_or("Invalid clipboard data")?;
        for uti in types {
            let uti = uti.as_string().ok_or("Invalid clipboard type")?;
            if data
                .get(uti)
                .and_then(plist::Value::as_dictionary)
                .and_then(|v| v.get("data"))
                .and_then(plist::Value::as_data)
                .is_none()
            {
                return Err("Clipboard snapshot contains unresolved data".into());
            }
        }
    }
    Ok(plist::Value::Array(items.clone()))
}
async fn restore<R: idevice::ReadWrite>(
    client: &mut RemoteXpcClient<R>,
    expected: &plist::Value,
    previous: plist::Value,
) -> Result<bool> {
    let after = pull(client).await?;
    if snapshot(&after)?.get("items") != Some(expected) {
        return Ok(false);
    }
    client.send_object(xpc!({"command":"SET","pasteboardName":"general","items":XPCObject::from(previous),"sourceMetadata":XPCObject::Null}),true).await?;
    check_reply(&client.recv().await?)?;
    Ok(true)
}
async fn pull<R: idevice::ReadWrite>(client: &mut RemoteXpcClient<R>) -> Result<plist::Value> {
    tokio::time::timeout(Duration::from_secs(8),async {
        client.send_object(xpc!({"command":"PULL","pasteboardName":"general","dataPolicy":{"matchSource":XPCObject::Dictionary(Default::default())}}),true).await?;
        Ok::<_,Box<dyn std::error::Error+Send+Sync>>(client.recv().await?)
    }).await.map_err(|_| "Complete clipboard snapshot was not available within 8 seconds")?
}
fn check_reply(value: &plist::Value) -> Result<()> {
    let root = value
        .as_dictionary()
        .ok_or("Pasteboard reply is not a dictionary")?;
    if root.contains_key("error") {
        return Err("Pasteboard service rejected SET".into());
    }
    if root.get("command").and_then(plist::Value::as_string) != Some("SET_REPLY") {
        return Err("Pasteboard service did not confirm SET".into());
    }
    Ok(())
}

async fn clear_text(keyboard: &mut Keyboard) -> Result<()> {
    // The first selection may cover an IME composition only. Repeat once
    // after it resolves to clear the committed field as well.
    for _ in 0..2 {
        chord(keyboard, 0x04, &[0xe3]).await?;
        chord(keyboard, 0x2a, &[]).await?;
    }
    Ok(())
}

fn snapshot(value: &plist::Value) -> Result<&plist::Dictionary> {
    let root = value
        .as_dictionary()
        .ok_or("Pasteboard response is not a dictionary")?;
    if let Some(error) = root.get("error") {
        let description = match error {
            plist::Value::String(s) => s.chars().take(300).collect(),
            plist::Value::Dictionary(d) => format!(
                "domain={}, code={}, description={}",
                d.get("domain")
                    .and_then(plist::Value::as_string)
                    .unwrap_or("unknown"),
                d.get("code")
                    .and_then(plist::Value::as_signed_integer)
                    .unwrap_or(0),
                d.get("userInfo")
                    .and_then(plist::Value::as_dictionary)
                    .and_then(|d| d.get("NSLocalizedDescription"))
                    .and_then(plist::Value::as_string)
                    .unwrap_or("unavailable")
            ),
            _ => format!("{error:?}").chars().take(200).collect(),
        };
        return Err(format!("Pasteboard service rejected PULL: {description}").into());
    }
    let snapshot = root
        .get("pasteboard")
        .and_then(plist::Value::as_dictionary)
        .unwrap_or(root);
    if !snapshot.contains_key("items") {
        // Only field names are exposed; never log clipboard payloads.
        return Err(format!(
            "Pasteboard snapshot lacks items (response fields: {})",
            root.keys().cloned().collect::<Vec<_>>().join(", ")
        )
        .into());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fields of the Settings search box as the phone sent them, in the first tree of a read.
    const EDITING: u64 = 146031248384;
    const IDLE: u64 = 146029151232;
    fn tree(traits: u64, value: &str) -> serde_json::Value {
        let mut element = serde_json::json!({"object_id":"o15191873788907771168","role":"SearchField",
            "placeholder":"搜索","value":value,"traits":traits});
        element["focused"] = crate::ax::is_editing(traits).into();
        serde_json::json!({"elements":[element]})
    }
    fn target(id: &str, value: &str) -> Target {
        Target {
            object_id: id.into(),
            role: "SearchField".into(),
            label: None,
            placeholder: Some("搜索".into()),
            value: value.into(),
        }
    }
    const SEARCH: &str = "o15191873788907771168";

    #[test]
    fn the_first_tree_of_a_read_says_which_field_is_being_edited() {
        assert!(fields(&tree(EDITING, "搜索"))[0].focused);
        assert!(!fields(&tree(IDLE, "搜索"))[0].focused);
    }

    #[test]
    fn the_field_being_edited_passes_only_when_it_is_the_target() {
        let all = fields(&tree(EDITING, "搜索"));
        let chosen = select_fields(&all, Some(&target(SEARCH, "搜索")), true).ok();
        assert_eq!(
            chosen.map(|fields| fields[0].id.clone()),
            Some(SEARCH.into())
        );
    }

    #[test]
    fn no_key_is_pressed_when_another_field_is_being_edited() {
        let all = fields(&tree(EDITING, "搜索"));
        let refusal = select_fields(&all, Some(&target("o1", "搜索")), true).err();
        assert_eq!(refusal.map(|r| r.reason), Some("other_field_editing"));
    }

    #[test]
    fn no_key_is_pressed_when_no_field_is_being_edited() {
        let all = fields(&tree(IDLE, "搜索"));
        let refusal = select_fields(&all, Some(&target(SEARCH, "搜索")), true).err();
        assert_eq!(refusal.map(|r| r.reason), Some("no_editing_field"));
    }

    #[test]
    fn a_reused_cell_with_other_content_is_not_the_target() {
        let all = fields(&tree(EDITING, "别的内容"));
        let refusal = select_fields(&all, Some(&target(SEARCH, "搜索")), true).err();
        assert_eq!(refusal.map(|r| r.reason), Some("target_changed"));
    }

    // The prompt as the phone sent it over Chrome: Springboard's root and the sheet.
    fn prompt_tree() -> serde_json::Value {
        let at =
            |x: u32, y: u32, w: u32, h: u32| serde_json::json!({"x":x,"y":y,"width":w,"height":h});
        serde_json::json!({"elements":[
            {"role":"Application","label":" ","frame":at(0,0,402,874)},
            {"role":"StaticText","label":"“Chrome”想从“dtpasteboardd”粘贴","frame":at(71,386,260,42)},
            {"role":"Button","label":"允许粘贴","frame":at(57,474,140,48)},
            {"role":"Button","label":"不允许粘贴","frame":at(205,474,140,48)},
        ]})
    }

    #[test]
    fn the_paste_prompt_says_where_to_touch_each_button() {
        let prompt = paste_prompt(&prompt_tree()).expect("a paste prompt");
        assert_eq!(prompt.allow, Some((20755, 37384)));
        assert_eq!(prompt.deny, Some((44943, 37384)));
    }

    #[test]
    fn a_field_holding_the_words_is_not_a_paste_prompt() {
        let tree = serde_json::json!({"elements":[{"role":"TextField","object_id":"o1","value":"允许粘贴"}]});
        assert!(paste_prompt(&tree).is_none());
    }

    #[test]
    fn an_unconfirmed_input_is_an_error_with_a_next_step_for_the_model() {
        for reason in [
            "paste_permission",
            "text_not_verified",
            "clear_not_verified",
        ] {
            let result = unconfirmed(reason, true, true);
            assert_eq!(result["isError"], true);
            assert_eq!(result["reason"], reason);
            assert_eq!(result["submit_sent"], false);
            assert!(
                result["instruction"]
                    .as_str()
                    .unwrap()
                    .contains("Return was not sent")
            );
            assert!(result.get("needs_human_action").is_none());
        }
    }

    #[test]
    fn clearing_without_a_known_editing_field_is_refused_but_appending_is_not() {
        let all = fields(&tree(IDLE, "搜索"));
        assert!(select_fields(&all, None, true).is_err());
        assert_eq!(
            select_fields(&all, None, false).ok().map(|f| f.len()),
            Some(1)
        );
    }
}

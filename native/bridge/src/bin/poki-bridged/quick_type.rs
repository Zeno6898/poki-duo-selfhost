//! type_text for the long-lived bridge (workstream H3, fork-only). It is a child of a second copy of
//! poki-native's pasteboard.rs (see main.rs), so it uses that file's own checks and result builders,
//! and gives the same answers in the same cases. What differs is time:
//!
//! - The steps that do not depend on each other run at once: the accessibility read before typing
//!   (skipped when the daemon holds a current tree), the virtual keyboard, the clipboard snapshot,
//!   and the connection for SET. poki-native does them one after another.
//! - With the live screen (POKI_LIVE_FRAMES=1), the first read-back waits for the pasted text to
//!   show in pixels and settle, up to the same 400 ms poki-native always waits.
//! - Restoring the clipboard, sending Return and removing the keyboard overlap.
//!
//! `POKI_BRIDGED_QUICK_TYPE=0` turns it off; type_text then runs poki-native's code.
use super::*;
use std::time::Instant;

pub fn enabled() -> bool {
    std::env::var("POKI_BRIDGED_QUICK_TYPE").as_deref() != Ok("0")
}

/// Stage times in ms, for the daemon's timings.
#[derive(Default, serde::Serialize)]
pub struct Stages {
    pub prepare_ms: u64,
    pub tree_ms: Option<u64>,
    pub tree: &'static str,
    pub keyboard_ms: u64,
    pub snapshot_ms: Option<u64>,
    pub clear_ms: Option<u64>,
    pub set_ms: Option<u64>,
    pub paste_ms: Option<u64>,
    pub verify_ms: Option<u64>,
    pub reads: u32,
    pub finish_ms: Option<u64>,
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

type Pasteboard = RemoteXpcClient<Box<dyn idevice::ReadWrite>>;

async fn pasteboard(adapter: &mut AdapterHandle, port: u16) -> Result<Pasteboard> {
    let mut client =
        RemoteXpcClient::new(Box::new(adapter.connect(port).await?) as Box<dyn idevice::ReadWrite>)
            .await?;
    client.do_handshake().await?;
    Ok(client)
}

/// Waits for the paste to show: a picture after `after` and then a settled screen, at most `cap`.
async fn shown(live: Option<&crate::frames::Live>, after: Instant, cap: Duration) {
    let Some(live) = live else {
        tokio::time::sleep(cap).await;
        return;
    };
    let deadline = Instant::now() + cap;
    let left = || deadline.saturating_duration_since(Instant::now());
    if live.wait_picture_after(after, left()).await {
        live.wait_settled(Duration::from_millis(80), left()).await;
    } else {
        // No picture: nothing changed yet. Wait out the cap as poki-native does.
        tokio::time::sleep(left()).await;
    }
}

/// pasteboard.rs `verify`, with its first wait replaced by `shown`.
#[allow(clippy::too_many_arguments)]
async fn verify_quick(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    live: Option<&crate::frames::Live>,
    after: Instant,
    baseline: &[Field],
    others: &[Field],
    text: &str,
    clear: bool,
    reads: &mut u32,
) -> Checked {
    let mut changed = Vec::new();
    for attempt in 0..3 {
        if attempt == 0 {
            shown(live, after, Duration::from_millis(400)).await;
        } else {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        *reads += 1;
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

/// poki-native's `paste_text` with independent steps overlapped. `held` is a current on-screen
/// tree the daemon already has; `keyboard` is closed before this returns.
#[allow(clippy::too_many_arguments)]
pub async fn paste_text(
    adapter: &AdapterHandle,
    rsd: &RsdHandshake,
    held: Option<serde_json::Value>,
    live: Option<crate::frames::Live>,
    text: &str,
    clear: bool,
    submit: bool,
    target: Option<&Target>,
    stages: &mut Stages,
) -> Result<serde_json::Value> {
    let started = Instant::now();
    let port = rsd
        .services
        .get("com.apple.coredevice.pasteboardservice")
        .map(|service| service.port);
    // Everything poki-native does before its first key press, at once.
    let (mut a, mut r) = (adapter.clone(), rsd.clone());
    let keyboard = async {
        let at = Instant::now();
        let keyboard = Keyboard::connect(&mut a, &mut r).await;
        (keyboard, ms(at))
    };
    let mut b = adapter.clone();
    let initial = async {
        let at = Instant::now();
        match held {
            Some(tree) => (Ok(tree), None, "held"),
            None => (observe(&mut b, rsd).await, Some(ms(at)), "read"),
        }
    };
    let typing = !text.is_empty();
    let mut c = adapter.clone();
    let snapshot = async {
        let at = Instant::now();
        let port = port.filter(|_| typing)?;
        let items = tokio::time::timeout(Duration::from_secs(8), async {
            let mut client = pasteboard(&mut c, port).await?;
            complete_items(&pull(&mut client).await?)
        })
        .await
        .ok()
        .and_then(std::result::Result::ok);
        Some((items, ms(at)))
    };
    let mut d = adapter.clone();
    let setter = async {
        match port.filter(|_| typing) {
            Some(port) => Some(pasteboard(&mut d, port).await),
            None => None,
        }
    };
    let ((keyboard, keyboard_ms), (initial, tree_ms, tree_kind), snapshot, setter) =
        tokio::join!(keyboard, initial, snapshot, setter);
    stages.keyboard_ms = keyboard_ms;
    stages.tree_ms = tree_ms;
    stages.tree = tree_kind;
    stages.prepare_ms = ms(started);
    let mut keyboard = keyboard?;
    let mut adapter = adapter.clone();
    let result = Box::pin(type_with(
        &mut adapter,
        rsd,
        &mut keyboard,
        live.as_ref(),
        initial,
        snapshot,
        setter,
        port,
        text,
        clear,
        submit,
        target,
        stages,
    ))
    .await;
    let finish = Instant::now();
    let cleanup = keyboard.close().await;
    stages.finish_ms = Some(stages.finish_ms.unwrap_or(0) + ms(finish));
    let result = result?;
    cleanup?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn type_with(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    keyboard: &mut Keyboard,
    live: Option<&crate::frames::Live>,
    initial: Result<serde_json::Value>,
    snapshot: Option<(Option<plist::Value>, u64)>,
    setter: Option<Result<Pasteboard>>,
    port: Option<u16>,
    text: &str,
    clear: bool,
    submit: bool,
    target: Option<&Target>,
    stages: &mut Stages,
) -> Result<serde_json::Value> {
    let Ok(mut initial) = initial else {
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
            super::super::held_tap(&mut keyboard.hid, x, y, 50).await?;
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
        let at = Instant::now();
        if clear_first {
            clear_text(keyboard).await?;
        }
        stages.clear_ms = Some(ms(at));
        let at = Instant::now();
        let checked = verify_quick(
            adapter,
            rsd,
            live,
            at,
            &baseline,
            &others,
            "",
            true,
            &mut stages.reads,
        )
        .await;
        stages.verify_ms = Some(ms(at));
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

    port.ok_or("Device has no pasteboard service")?;
    let (previous_items, snapshot_ms) = snapshot.unwrap_or((None, 0));
    stages.snapshot_ms = Some(snapshot_ms);
    let snapshot_status = if previous_items.is_some() {
        "complete"
    } else {
        "unavailable"
    };
    if clear_first {
        let at = Instant::now();
        clear_text(keyboard).await?;
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
        stages.reads += 1;
        stages.clear_ms = Some(ms(at));
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
    let at = Instant::now();
    let mut client = match setter {
        Some(Ok(client)) => client,
        // The early connection failed: make one now, as poki-native does.
        _ => pasteboard(adapter, port.expect("checked")).await?,
    };
    client.send_object(xpc!({"command":"SET","pasteboardName":"general","items":new_items,"sourceMetadata":XPCObject::Null}),true).await?;
    check_reply(&client.recv().await?)?;
    stages.set_ms = Some(ms(at));
    let at = Instant::now();
    if chord(keyboard, 0x19, &[0xe3]).await.is_err() {
        return Ok(clipboard_result(
            unconfirmed("paste_dispatch_unconfirmed", true, true),
            snapshot_status,
            "retained_pending_paste",
        ));
    }
    stages.paste_ms = Some(ms(at));
    let verifying = Instant::now();
    let mut checked = verify_quick(
        adapter,
        rsd,
        live,
        at,
        &baseline,
        &others,
        text,
        clear,
        &mut stages.reads,
    )
    .await;
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
        tokio::time::sleep(ALERT_ACCEPTS_TOUCHES_AFTER).await;
        if super::super::held_tap(&mut keyboard.hid, x, y, 50)
            .await
            .is_err()
        {
            break;
        }
        answered = true;
        let tapped = Instant::now();
        checked = verify_quick(
            adapter,
            rsd,
            live,
            tapped,
            &baseline,
            &others,
            text,
            clear,
            &mut stages.reads,
        )
        .await;
    }
    stages.verify_ms = Some(ms(verifying));
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

    // Only restore after AX proves the text landed. Do not overwrite a clipboard change made by the
    // user while the request was in progress. Return goes at the same time: it needs the verified
    // text, not the restored clipboard.
    let finish = Instant::now();
    let characters = text.chars().count();
    let other_changed = !checked.changed.is_empty();
    let send_return = submit && !other_changed;
    let restoring = async {
        match previous_items {
            Some(previous) => match restore(&mut client, &expected, previous).await {
                Ok(true) => "restored",
                Ok(false) => "clipboard_changed",
                Err(_) => "restore_failed",
            },
            None => "unavailable",
        }
    };
    let returning = async {
        if send_return {
            chord(keyboard, 0x28, &[]).await
        } else {
            Ok(())
        }
    };
    let (restore_status, returned) = tokio::join!(restoring, returning);
    stages.finish_ms = Some(ms(finish));
    returned?;
    let restored = restore_status == "restored";
    if other_changed {
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
    Ok(clipboard_result(
        noting_answer(
            completed(characters, send_return, restored, &baseline),
            answered,
        ),
        snapshot_status,
        restore_status,
    ))
}

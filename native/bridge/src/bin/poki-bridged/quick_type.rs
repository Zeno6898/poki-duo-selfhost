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
//! - Fast return (live screen and OCR available): once the paste has changed the field's pixels
//!   and the screen has settled, the field box is read by the persistent OCR worker and the answer
//!   goes back at once, with `verified` "ocr" (the text is seen in the field) or "pixels_only"
//!   (the field changed but OCR could not read it, as in a secure field). The accessibility
//!   read-back and the clipboard restore then run in the background; if the read-back disagrees,
//!   the next answer carries a `text_mismatch` warning. Return is sent at once only when OCR saw
//!   the text; otherwise it waits for the read-back as before. When the change is somewhere other
//!   than the field (a paste prompt, another field) or OCR reads different text, the answer waits
//!   for the read-back as before.
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
    /// Fast return: from the paste to the field's pixels settling and OCR done.
    pub shown_ms: Option<u64>,
    pub ocr_ms: Option<u64>,
    pub verified: Option<&'static str>,
}

thread_local! {
    /// Warnings from background read-backs, for the next answer (the daemon runs on one thread).
    static WARNINGS: std::cell::RefCell<Vec<serde_json::Value>> = const { std::cell::RefCell::new(Vec::new()) };
    /// The read-back still running in the background, if any.
    static BACKGROUND: std::cell::RefCell<Option<tokio::task::JoinHandle<()>>> = const { std::cell::RefCell::new(None) };
}

/// Warnings to add to the next answer.
pub fn take_warnings() -> Vec<serde_json::Value> {
    WARNINGS.with(|w| std::mem::take(&mut *w.borrow_mut()))
}

fn warn(warning: serde_json::Value) {
    WARNINGS.with(|w| w.borrow_mut().push(warning));
}

/// Waits for the previous request's background read-back, so that its clipboard restore and this
/// request's clipboard snapshot do not cross.
async fn background_done() {
    let running = BACKGROUND.with(|b| b.borrow_mut().take());
    if let Some(running) = running {
        let _ = running.await;
    }
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
        let port = port.filter(|_| typing)?;
        background_done().await;
        let at = Instant::now();
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
    // Where the chosen field is on screen, for the fast return's pixel and OCR checks.
    let field_area = match &baseline[..] {
        [field] => field_box(&initial, &field.id),
        _ => None,
    };
    let secure = baseline.iter().any(|field| field.secure);
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
    if let Some(live) = live {
        let checking = Instant::now();
        let ocr = crate::ocr::shared();
        let fast = shown_in_field(live, &ocr, at, field_area, secure, text, stages).await;
        stages.shown_ms = Some(ms(checking));
        if let Some(fast) = fast
            && (fast.verified == "ocr" || !submit)
        {
            stages.verified = Some(fast.verified);
            if submit {
                chord(keyboard, 0x28, &[]).await?;
            }
            let job = ReadBack {
                adapter: adapter.clone(),
                rsd: rsd.clone(),
                live: live.clone(),
                after: at,
                client,
                expected,
                previous_items,
                baseline: baseline.clone(),
                others,
                text: text.to_owned(),
                clear,
                verified: fast.verified,
                submitted: submit,
            };
            BACKGROUND.with(|b| *b.borrow_mut() = Some(tokio::task::spawn_local(read_back(job))));
            let mut result = completed(text.chars().count(), submit, false, &baseline);
            result["text_verified"] = (fast.verified == "ocr").into();
            result["verified"] = fast.verified.into();
            result["verification_source"] = if fast.verified == "ocr" {
                "ocr"
            } else {
                "pixels"
            }
            .into();
            result["screen_change_verified"] = true.into();
            result["read_back"] = "pending".into();
            result["changed_region"] = fast.region.to_vec().into();
            return Ok(clipboard_result(result, snapshot_status, "pending"));
        }
    }
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

/// The chosen field's frame as fractions of the screen ([x, y, w, h]), from the tree read before
/// typing: its `frame` over the Application element's.
fn field_box(tree: &serde_json::Value, id: &str) -> Option<[f64; 4]> {
    let elements = tree.get("elements")?.as_array()?;
    let frame = |element: &serde_json::Value| {
        let f = element.get("frame")?;
        Some([
            f.get("x")?.as_f64()?,
            f.get("y")?.as_f64()?,
            f.get("width")?.as_f64()?,
            f.get("height")?.as_f64()?,
        ])
    };
    let screen = elements.iter().find_map(|element| {
        (element.get("role")?.as_str()? == "Application").then_some(())?;
        frame(element)
    })?;
    let field = elements
        .iter()
        .find(|element| element.get("object_id").and_then(serde_json::Value::as_str) == Some(id))
        .and_then(frame)?;
    let (w, h) = (screen[2], screen[3]);
    if w <= 0.0 || h <= 0.0 || field[2] <= 0.0 || field[3] <= 0.0 {
        return None;
    }
    let x = (field[0] / w).clamp(0.0, 1.0);
    let y = (field[1] / h).clamp(0.0, 1.0);
    Some([
        x,
        y,
        (field[2] / w).min(1.0 - x),
        (field[3] / h).min(1.0 - y),
    ])
}

fn overlaps(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/// `area` grown by `by` on every side, kept on screen.
fn grown(area: [f64; 4], by: f64) -> [f64; 4] {
    let x = (area[0] - by).max(0.0);
    let y = (area[1] - by).max(0.0);
    [
        x,
        y,
        (area[2] + 2.0 * by).min(1.0 - x),
        (area[3] + 2.0 * by).min(1.0 - y),
    ]
}

/// One thumbnail column: a caret blink changes about this much width.
const CARET_WIDTH: f64 = 2.0 / 96.0;

struct Shown {
    verified: &'static str,
    region: [f64; 4],
}

/// Whether the paste sent at `after` shows in the field: a picture after it, a settled screen, a
/// change that overlaps the field (or anywhere, when the field's frame is unknown), and then the
/// text read there by OCR. None means the screen cannot tell, and the read-back decides.
async fn shown_in_field(
    live: &crate::frames::Live,
    ocr: &crate::ocr::Ocr,
    after: Instant,
    field: Option<[f64; 4]>,
    secure: bool,
    text: &str,
    stages: &mut Stages,
) -> Option<Shown> {
    let deadline = after + Duration::from_millis(700);
    let left = || deadline.saturating_duration_since(Instant::now());
    if !live.wait_picture_after(after, left()).await
        || !live.wait_settled(Duration::from_millis(80), left()).await
    {
        return None;
    }
    let (difference, _, _) =
        live.diff(after.elapsed() + Duration::from_millis(1), Duration::ZERO)?;
    let region = difference.region?;
    if field.is_some_and(|field| !overlaps(region, field)) {
        return None;
    }
    let area = grown(field.unwrap_or(region), 0.005);
    if !secure && ocr.available() {
        let reading = ocr
            .read_live(live, Some(area), Duration::from_millis(1500))
            .await;
        if let Ok((reading, _)) = reading {
            stages.ocr_ms = Some(reading.ms as u64);
            let seen = reading.text();
            if crate::ocr::shows(&seen, text) {
                return Some(Shown {
                    verified: "ocr",
                    region,
                });
            }
            if !seen.trim().is_empty() {
                // OCR read the field and the text is not there: let the read-back decide.
                return None;
            }
        }
    }
    // Nothing readable (a secure field shows dots), but more changed than a caret blink.
    (region[2] > CARET_WIDTH).then_some(Shown {
        verified: "pixels_only",
        region,
    })
}

/// What the background read-back needs, owned.
struct ReadBack {
    adapter: AdapterHandle,
    rsd: RsdHandshake,
    live: crate::frames::Live,
    after: Instant,
    client: Pasteboard,
    expected: plist::Value,
    previous_items: Option<plist::Value>,
    baseline: Vec<Field>,
    others: Vec<Field>,
    text: String,
    clear: bool,
    verified: &'static str,
    submitted: bool,
}

/// The accessibility read-back after a fast return, then the clipboard restore when it confirms
/// the text. A disagreement becomes a warning on the next answer.
async fn read_back(mut job: ReadBack) {
    let started = Instant::now();
    let mut reads = 0;
    let checked = Box::pin(verify_quick(
        &mut job.adapter,
        &job.rsd,
        Some(&job.live),
        job.after,
        &job.baseline,
        &job.others,
        &job.text,
        job.clear,
        &mut reads,
    ))
    .await;
    let field = match &job.baseline[..] {
        [field] => {
            serde_json::json!({"object_id": field.id, "role": field.role, "name": field.name()})
        }
        _ => serde_json::Value::Null,
    };
    let finished_at = crate::ax::watch::stamp();
    if !matches!(checked.status, Verification::Complete) {
        // As in the slow path: the OS may still be waiting to consume this text, so keep it.
        let reason = checked.status.reason();
        super::super::daemon::log_line(&format!(
            "type_text read-back disagrees with the fast answer ({}): {reason} after {} ms",
            job.verified,
            ms(started)
        ));
        warn(serde_json::json!({
            "warning": "text_mismatch",
            "op": "type_text",
            "finished_at": finished_at,
            "fast_verified": job.verified,
            "reason": reason,
            "field": field,
            "submit_sent": job.submitted,
            "changed_fields": checked.changed,
            "clipboard_restore_status": "retained_pending_paste",
            "instruction": "The accessibility read-back after the last type_text did not find the text in the field. Look at the field before continuing; the typed text stays on the device clipboard.",
        }));
        return;
    }
    let restore_status = match job.previous_items {
        Some(previous) => match restore(&mut job.client, &job.expected, previous).await {
            Ok(true) => "restored",
            Ok(false) => "clipboard_changed",
            Err(_) => "restore_failed",
        },
        None => "unavailable",
    };
    if !checked.changed.is_empty() {
        warn(serde_json::json!({
            "warning": "other_field_changed",
            "op": "type_text",
            "finished_at": finished_at,
            "field": field,
            "submit_sent": job.submitted,
            "changed_fields": checked.changed,
            "clipboard_restore_status": restore_status,
            "instruction": "The last type_text put its text in the field, but another field changed too; changed_fields has its previous value. Look at the screen before continuing.",
        }));
    }
    super::super::daemon::log_line(&format!(
        "type_text read-back confirmed in {} ms ({} reads), clipboard {restore_status}",
        ms(started),
        reads
    ));
}

#[cfg(test)]
mod fast_tests {
    use super::*;
    use crate::frames::fake::{FakeScreen, draw, encode};

    /// The fast return's screen check on a fake screen: text pasted into the field is seen (by
    /// OCR when POKI_OCR_TEST_PYTHON is set, else as pixels); a change elsewhere, a caret blink
    /// or no change at all leaves the decision to the read-back.
    #[test]
    fn the_paste_is_seen_in_the_field_and_nowhere_else() {
        let field = "drawbox=x=20:y=200:w=564:h=60:color=gray:t=2";
        let pictures = [
            draw("empty", "604x1312", field),
            draw(
                "typed",
                "604x1312",
                &format!(
                    "{field},drawtext=text='Groceries for Sunday':fontsize=36:fontcolor=black:x=34:y=212"
                ),
            ),
            draw(
                "elsewhere",
                "604x1312",
                &format!("{field},drawbox=x=60:y=900:w=480:h=200:color=black:t=fill"),
            ),
            draw(
                "caret",
                "604x1312",
                &format!("{field},drawbox=x=34:y=210:w=3:h=40:color=blue:t=fill"),
            ),
        ];
        let Some(pictures) = pictures.into_iter().collect::<Option<Vec<_>>>() else {
            println!("skipped: ffmpeg cannot draw pictures here");
            return;
        };
        let Some(units) = encode(&pictures) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        let Some(screen) = FakeScreen::start() else {
            println!("skipped: no libavcodec");
            return;
        };
        let (empty, typed, elsewhere, caret) = (&units[0], &units[1], &units[2], &units[3]);
        let box_ = Some([20.0 / 604.0, 200.0 / 1312.0, 564.0 / 604.0, 60.0 / 1312.0]);
        let with_ocr = crate::ocr::Ocr::new(
            std::env::var_os("POKI_OCR_TEST_PYTHON")
                .filter(|p| !p.is_empty())
                .map(Into::into),
        );
        let without = crate::ocr::Ocr::new(None);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let live = &screen.live;
                // The daemon starts the worker when it starts.
                with_ocr.warm().await;
                let paste = async |next: &[u8], ocr: &crate::ocr::Ocr| {
                    screen.show(empty).await;
                    assert!(
                        live.wait_settled(Duration::from_millis(80), Duration::from_secs(2))
                            .await
                    );
                    let after = Instant::now();
                    let mut stages = Stages::default();
                    let (_, shown) = tokio::join!(
                        async {
                            tokio::time::sleep(Duration::from_millis(40)).await;
                            screen.show(next).await;
                        },
                        shown_in_field(
                            live,
                            ocr,
                            after,
                            box_,
                            false,
                            "Groceries for Sunday",
                            &mut stages
                        )
                    );
                    (
                        shown.map(|s| s.verified),
                        after.elapsed().as_millis(),
                        stages.ocr_ms,
                    )
                };
                let (verified, took, ocr_ms) = paste(typed, &with_ocr).await;
                println!("typed: {verified:?} in {took} ms (OCR {ocr_ms:?} ms)");
                let expected = if with_ocr.available() {
                    "ocr"
                } else {
                    "pixels_only"
                };
                assert_eq!(verified, Some(expected));
                assert!(took < 700, "{took} ms");
                let (verified, _, _) = paste(typed, &without).await;
                assert_eq!(verified, Some("pixels_only"));
                let (verified, _, _) = paste(elsewhere, &with_ocr).await;
                assert_eq!(verified, None, "the change is outside the field");
                let (verified, _, _) = paste(caret, &without).await;
                assert_eq!(verified, None, "a caret blink is not a paste");
                // Nothing changes: the check gives up within its 700 ms.
                screen.show(empty).await;
                assert!(
                    live.wait_settled(Duration::from_millis(80), Duration::from_secs(2))
                        .await
                );
                let after = Instant::now();
                let shown = shown_in_field(
                    live,
                    &without,
                    after,
                    box_,
                    false,
                    "x",
                    &mut Stages::default(),
                )
                .await;
                assert!(shown.is_none());
                assert!(after.elapsed() < Duration::from_millis(800));
            });
    }
}

//! A held accessibility subscription for poki-bridged. Fork-only (poki-remote).
//!
//! This is a child of a second copy of poki-native's `ax.rs` (see main.rs), so it uses that file's
//! DTX calls, acknowledgements and tree parser unchanged. Where `ax::read_tree` subscribes, waits
//! for the first tree and unsubscribes, a [`Watch`] subscribes once and keeps reading. It
//! acknowledges every message and keeps the latest tree. A dump that is a whole tree by itself
//! replaces the tree; a partial one is merged into it, as `read_tree` merges the messages of its one
//! answer.
//!
//! Whether that tree is current is decided in [`Watch::read`]:
//!
//! - After an op that may change the screen, the daemon calls [`Watch::invalidate`].
//! - A tree that arrived after the last invalidation is current.
//! - Otherwise the read waits for one. If the phone has been seen to send trees on its own after an
//!   input (`push` mode), a quiet `POKI_BRIDGED_AX_QUIET_MS` (default 500) with no new message
//!   after the invalidation means the screen did not change, and the latest tree is served.
//!   The phone counts as sending changes once a tree arrives with no subscription waiting for it,
//!   more than 3 s after the last subscription was made.
//! - Without that evidence, a tree is served only while it is younger than
//!   `POKI_BRIDGED_AX_MAX_AGE_MS` (default 1000). Otherwise the subscription is renewed, as poki-native
//!   does for every read, and the read waits for its answer.
//! - After an invalidation outside push mode, the renewal starts `POKI_BRIDGED_AX_REARM_MS`
//!   (default 300) later in the background, so its answer is under way before the read asks. On
//!   the phone, a renewal sent the moment an input ended (0) usually ended the subscription with a
//!   socket error.
//! - A tree with a second application root (the foreground changed under the subscription) is not
//!   served; the subscription is renewed so the tree holds only the new screen.
//!
//! `POKI_BRIDGED_AX_PUSH=on|off` forces the mode; the default `auto` decides from what the phone
//! does. Any read or write error ends the watch; the daemon then reads once as poki-native does and
//! opens a new watch on the next read.
use super::*;
use std::{
    cell::{Cell, RefCell},
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
    time::Instant,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, ReadHalf, WriteHalf};

/// The write half of the subscription socket, presented as the `ReadWrite` that `call` and
/// `acknowledge` take. Reads return end of file; the reader task owns the read half.
type Socket = Box<dyn ReadWrite>;
struct Writer(WriteHalf<Socket>);
impl std::fmt::Debug for Writer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Writer")
    }
}
impl AsyncRead for Writer {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
impl AsyncWrite for Writer {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

fn log_line(message: &str) {
    eprintln!("{} poki-bridged: {message}", stamp());
}

/// The time now in UTC, as 2026-11-06T02:58:16.123Z, for the daemon's log lines.
pub(crate) fn stamp() -> String {
    stamp_at(std::time::SystemTime::now())
}

/// A time in UTC, as 2026-11-06T02:58:16.123Z.
pub(crate) fn stamp_at(at: std::time::SystemTime) -> String {
    let now = at.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (now.as_secs(), now.subsec_millis());
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Push {
    Auto,
    On,
    Off,
}

pub struct Settings {
    pub quiet: Duration,
    pub max_age: Duration,
    pub rearm: Duration,
    pub push: Push,
    /// How long after a subscription a tree that nobody asked for shows that the phone sends
    /// changes on its own.
    pub unasked_after: Duration,
}

fn env_ms(name: &str, default_ms: u64) -> Duration {
    Duration::from_millis(
        std::env::var(name)
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|ms| *ms <= 60_000)
            .unwrap_or(default_ms),
    )
}

impl Settings {
    pub fn from_env() -> Self {
        Self {
            quiet: env_ms("POKI_BRIDGED_AX_QUIET_MS", 500),
            max_age: env_ms("POKI_BRIDGED_AX_MAX_AGE_MS", 1000),
            rearm: env_ms("POKI_BRIDGED_AX_REARM_MS", 300),
            push: match std::env::var("POKI_BRIDGED_AX_PUSH").as_deref() {
                Ok("on") => Push::On,
                Ok("off") => Push::Off,
                _ => Push::Auto,
            },
            unasked_after: Duration::from_secs(3),
        }
    }
}

#[derive(Default)]
struct State {
    /// The latest ready tree of the current subscription, and when it arrived.
    latest: Option<(Json, Instant)>,
    /// When the subscription that the latest tree answered was made; None for a tree sent unasked.
    /// An answer to a subscription made before a change can show the screen before it.
    latest_asked: Option<Instant>,
    /// When the current subscription was made, and whether its first tree is still awaited.
    subscribed_at: Option<Instant>,
    awaiting: bool,
    /// Bumped on every renewal, so the reader starts a new tree.
    generation: u64,
    last_message: Option<Instant>,
    invalidated: Option<Instant>,
    /// Set when a tree shows a second application root.
    foreground_changed: bool,
    failed: Option<String>,
    // Counters for ping and the timings.
    trees: u64,
    renewals: u64,
    /// Trees that arrived unasked, well after a subscription's answer: the phone sends changes.
    pushed: u64,
}

impl State {
    /// Whether the latest tree shows the screen after the last change.
    fn current(&self) -> bool {
        let Some((_, at)) = &self.latest else {
            return false;
        };
        self.invalidated
            .is_none_or(|t| *at > t && self.latest_asked.is_none_or(|asked| asked > t))
    }
}

struct Inner {
    state: RefCell<State>,
    changed: tokio::sync::Notify,
    writer: tokio::sync::Mutex<Writer>,
    next_id: Cell<u32>,
    unasked_after: Duration,
}

pub struct Watch {
    inner: Rc<Inner>,
    reader: tokio::task::JoinHandle<()>,
    rearm: Option<tokio::task::JoinHandle<()>>,
    settings: Settings,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(rearm) = self.rearm.take() {
            rearm.abort();
        }
    }
}

/// How a read was served, for the daemon's timings.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Served {
    /// A current tree was already there.
    Cached,
    /// The read waited for a tree that the phone sent, or that a renewal made before it asked.
    Waited,
    /// The read renewed the subscription and waited for its answer.
    Renewed,
    /// The latest tree, because nothing arrived in the quiet time after the change (push mode).
    Unchanged,
    /// The held subscription failed or was not answered in time; the daemon read without it.
    Fallback,
}

impl Inner {
    async fn renew(&self) -> Result<()> {
        let id = self.next_id.get();
        self.next_id.set(id + 2);
        {
            let mut state = self.state.borrow_mut();
            state.generation += 1;
            state.awaiting = true;
            state.subscribed_at = Some(Instant::now());
            state.foreground_changed = false;
            state.renewals += 1;
        }
        let mut writer = self.writer.lock().await;
        call(
            &mut *writer,
            id,
            "clientNeedsAccessibility:",
            false.into(),
            true,
        )
        .await?;
        call(
            &mut *writer,
            id + 1,
            "clientNeedsAccessibility:",
            true.into(),
            true,
        )
        .await?;
        Ok(())
    }
}

impl Watch {
    pub async fn open(
        adapter: &mut AdapterHandle,
        rsd: &RsdHandshake,
        settings: Settings,
    ) -> Result<Self> {
        let port = rsd
            .services
            .get("com.apple.accessibility.axAuditDaemon.remoteAXService")
            .ok_or("Native accessibility service is unavailable")?
            .port;
        let socket: Socket = Box::new(adapter.connect(port).await?);
        Self::subscribe(socket, settings).await
    }

    /// Subscribes on an open accessibility service connection.
    async fn subscribe(socket: Socket, settings: Settings) -> Result<Self> {
        let (read, write) = tokio::io::split(socket);
        let mut writer = Writer(write);
        let mut capabilities = plist::Dictionary::new();
        capabilities.insert("com.apple.private.DTXBlockCompression".into(), 0.into());
        capabilities.insert("com.apple.private.DTXConnection".into(), 1.into());
        call(
            &mut writer,
            1,
            "_notifyOfPublishedCapabilities:",
            Value::Dictionary(capabilities),
            false,
        )
        .await?;
        call(
            &mut writer,
            2,
            "clientNeedsAccessibility:",
            true.into(),
            true,
        )
        .await?;
        let inner = Rc::new(Inner {
            state: RefCell::new(State {
                subscribed_at: Some(Instant::now()),
                awaiting: true,
                ..State::default()
            }),
            changed: tokio::sync::Notify::new(),
            writer: tokio::sync::Mutex::new(writer),
            next_id: Cell::new(3),
            unasked_after: settings.unasked_after,
        });
        let reader = tokio::task::spawn_local(read_loop(read, inner.clone()));
        Ok(Self {
            inner,
            reader,
            rearm: None,
            settings,
        })
    }

    fn push_mode(&self) -> bool {
        match self.settings.push {
            Push::On => true,
            Push::Off => false,
            Push::Auto => self.inner.state.borrow().pushed > 0,
        }
    }

    /// The screen may have changed from now on.
    pub fn invalidate(&mut self) {
        let now = Instant::now();
        self.inner.state.borrow_mut().invalidated = Some(now);
        if let Some(rearm) = self.rearm.take() {
            rearm.abort();
        }
        if self.push_mode() {
            return;
        }
        // Renew a moment after the change, so the answer is under way before the read asks. A
        // subscription made while the screen is still moving is often never answered.
        let inner = self.inner.clone();
        let delay = self.settings.rearm;
        self.rearm = Some(tokio::task::spawn_local(async move {
            tokio::time::sleep(delay).await;
            // Unless a tree after the change is there, or a read already asked for one.
            let stale = {
                let state = inner.state.borrow();
                let asked = state.awaiting && state.subscribed_at.is_some_and(|s| s > now);
                !state.current() && !asked
            };
            if stale && inner.renew().await.is_err() {
                inner.changed.notify_waiters();
            }
        }));
    }

    pub fn stats(&self) -> Json {
        let state = self.inner.state.borrow();
        json!({"trees": state.trees, "renewals": state.renewals, "pushed": state.pushed, "push_mode": self.push_mode()})
    }

    /// The current tree, as `ax::read_tree` would return it, within `wait`.
    pub async fn read(&mut self, wait: Duration) -> Result<(Json, Served)> {
        let deadline = Instant::now() + wait;
        let push = self.push_mode();
        let (mut waited, mut renewed) = (false, false);
        loop {
            // Register for the next change before looking, so none is missed.
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut renew = false;
            let mut sleep_until = deadline;
            {
                let state = self.inner.state.borrow();
                if let Some(error) = &state.failed {
                    return Err(error.clone().into());
                }
                let now = Instant::now();
                if state.foreground_changed && !state.awaiting {
                    renew = true;
                } else if let Some((tree, at)) = &state.latest {
                    let current = state.current();
                    if current && !state.awaiting && (push || at.elapsed() < self.settings.max_age)
                    {
                        let served = match (renewed, waited) {
                            (true, _) => Served::Renewed,
                            (false, true) => Served::Waited,
                            _ => Served::Cached,
                        };
                        return Ok((tree.clone(), served));
                    }
                    if push && !current {
                        let since = state.invalidated.expect("not current");
                        let quiet_from = state.last_message.filter(|m| *m > since).unwrap_or(since);
                        if now >= quiet_from + self.settings.quiet {
                            return Ok((tree.clone(), Served::Unchanged));
                        }
                        sleep_until = sleep_until.min(quiet_from + self.settings.quiet);
                    } else if !state.awaiting {
                        renew = true;
                    }
                }
                // An unanswered subscription is renewed after the time one is usually answered in.
                if state.awaiting
                    && state
                        .subscribed_at
                        .is_some_and(|s| now >= s + ANSWER_WITHIN)
                {
                    renew = true;
                }
                if let Some(at) = state.subscribed_at {
                    sleep_until = sleep_until.min(at + ANSWER_WITHIN);
                }
            }
            if renew {
                self.inner.renew().await?;
                renewed = true;
                continue;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Native accessibility tree did not arrive within {} seconds",
                    wait.as_secs()
                )
                .into());
            }
            waited = true;
            let _ = tokio::time::timeout_at(sleep_until.into(), notified).await;
        }
    }
}

async fn read_loop(mut read: ReadHalf<Socket>, inner: Rc<Inner>) {
    let fail = |error: String| {
        inner.state.borrow_mut().failed = Some(error);
        inner.changed.notify_waiters();
    };
    let mut generation = 0;
    let mut tree = Tree::default();
    let opened = Instant::now();
    let mut messages = 0u64;
    loop {
        let message = match Message::from_reader(&mut read).await {
            Ok(message) => message,
            Err(error) => {
                // How the subscription ended, so a device run shows whether the phone closes it
                // right after its first tree.
                let state = inner.state.borrow();
                let since = |at: Option<Instant>| {
                    at.map_or("never".into(), |t| {
                        format!("{} ms ago", t.elapsed().as_millis())
                    })
                };
                let detail = format!(
                    "{} ms after opening, {messages} messages, {} trees, {} renewals, last tree {}, last input {}",
                    opened.elapsed().as_millis(),
                    state.trees,
                    state.renewals,
                    since(state.latest.as_ref().map(|(_, at)| *at)),
                    since(state.invalidated),
                );
                drop(state);
                log_line(&format!(
                    "accessibility subscription ended: {error} ({detail})"
                ));
                return fail(format!(
                    "accessibility subscription ended: {error} ({detail})"
                ));
            }
        };
        messages += 1;
        if let Err(error) = acknowledge(&mut *inner.writer.lock().await, &message).await {
            return fail(format!("accessibility subscription ended: {error}"));
        }
        let now = Instant::now();
        let mut state = inner.state.borrow_mut();
        state.last_message = Some(now);
        if state.generation != generation {
            generation = state.generation;
            tree = Tree::default();
        }
        let Some(AuxValue::Array(bytes)) = message.aux.as_ref().and_then(|aux| aux.values.first())
        else {
            drop(state);
            inner.changed.notify_waiters();
            continue;
        };
        let parsed = Archive::parse(bytes)
            .ok()
            .and_then(|archive| archive.data(archive.root()).map(<[u8]>::to_vec))
            .and_then(|data| Archive::parse(&data).ok())
            .map(|archive| {
                // A dump that is a whole tree by itself replaces the tree: `update` keeps the first
                // label it saw for a node, so merging a new screen into the old one would keep old
                // text. A dump that is not whole adds to the tree, as `read_tree` merges messages.
                let mut whole = Tree::default();
                match whole.update(&archive) {
                    Ok(()) if whole.ready() => {
                        tree = whole;
                        Ok(())
                    }
                    _ => tree.update(&archive),
                }
            });
        if matches!(parsed, Some(Ok(()))) && tree.ready() {
            if tree.roots.len() > 1 {
                state.foreground_changed = true;
            } else {
                let unasked = state
                    .subscribed_at
                    .is_some_and(|s| now > s + inner.unasked_after);
                if !state.awaiting && unasked {
                    state.pushed += 1;
                }
                state.latest = Some((tree.json(), now));
                state.latest_asked = state.awaiting.then_some(state.subscribed_at).flatten();
                state.awaiting = false;
                state.trees += 1;
            }
        }
        drop(state);
        inner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    //! A fake phone on the other end of an in-memory socket: it answers each subscription with the
    //! next queued tree and can send trees nobody asked for.
    use super::*;
    use idevice::dvt::message::PayloadHeader;
    use std::collections::VecDeque;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    /// A tree dump in the shape `Tree::update` reads: one application root per pid, each with one
    /// child labelled `label`.
    fn dump(roots: &[u64], label: &str) -> Vec<u8> {
        let mut responses = vec![];
        for (i, root) in roots.iter().enumerate() {
            let child = 100 + i as u64;
            let node = |id: u64, keys: Vec<Value>, objects: Vec<Value>| {
                let mut attributes = plist::Dictionary::new();
                attributes.insert("NS.keys".into(), Value::Array(keys));
                attributes.insert("NS.objects".into(), Value::Array(objects));
                let mut translation = plist::Dictionary::new();
                translation.insert("objectID".into(), id.into());
                let mut response = plist::Dictionary::new();
                response.insert("associatedRequestType".into(), 5.into());
                response.insert(
                    "associatedTranslationObject".into(),
                    Value::Dictionary(translation),
                );
                response.insert("resultData".into(), Value::Dictionary(attributes));
                Value::Dictionary(response)
            };
            let mut app = plist::Dictionary::new();
            app.insert("objectID".into(), (*root).into());
            app.insert("pid".into(), (*root + 1000).into());
            let mut response = plist::Dictionary::new();
            response.insert("associatedRequestType".into(), 4.into());
            response.insert("resultData".into(), Value::Dictionary(app));
            responses.push(Value::Dictionary(response));
            responses.push(node(
                *root,
                vec![3.into(), 6.into(), 8.into()],
                vec![
                    "App".into(),
                    "com.example".into(),
                    Value::Array(vec![child.into()]),
                ],
            ));
            responses.push(node(
                child,
                vec![3.into(), 21.into()],
                vec![label.into(), "{{1, 2}, {30, 40}}".into()],
            ));
        }
        let mut result = plist::Dictionary::new();
        result.insert("treeDump".into(), Value::Array(responses));
        let mut root = plist::Dictionary::new();
        root.insert("associatedRequestType".into(), 11.into());
        root.insert("resultData".into(), Value::Dictionary(result));
        let archive = |top: Value| {
            let mut tops = plist::Dictionary::new();
            tops.insert("root".into(), top);
            let mut archive = plist::Dictionary::new();
            archive.insert("$objects".into(), Value::Array(vec!["$null".into()]));
            archive.insert("$top".into(), Value::Dictionary(tops));
            let mut bytes = vec![];
            plist::to_writer_binary(&mut bytes, &Value::Dictionary(archive)).unwrap();
            bytes
        };
        let inner = archive(Value::Dictionary(root));
        let outer = archive(Value::Data(inner));
        Message::new(
            MessageHeader::new(0, 1, 9, 0, 0, false),
            PayloadHeader::default(),
            Some(Aux {
                header: AuxHeader::default(),
                values: vec![AuxValue::Array(outer)],
            }),
            None,
        )
        .serialize()
    }

    struct Phone {
        answers: Rc<RefCell<VecDeque<Vec<u8>>>>,
        subscriptions: Rc<Cell<u32>>,
        writer: Rc<tokio::sync::Mutex<WriteHalf<DuplexStream>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Phone {
        fn answer(&self, roots: &[u64], label: &str) {
            self.answers.borrow_mut().push_back(dump(roots, label));
        }
        async fn push(&self, roots: &[u64], label: &str) {
            self.writer
                .lock()
                .await
                .write_all(&dump(roots, label))
                .await
                .unwrap();
        }
    }

    fn settings(push: Push) -> Settings {
        Settings {
            quiet: Duration::from_millis(100),
            max_age: Duration::from_millis(300),
            rearm: Duration::from_millis(30),
            push,
            unasked_after: Duration::from_millis(150),
        }
    }

    async fn connect(push: Push) -> (Watch, Phone) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (mut read, write) = tokio::io::split(theirs);
        let phone_writer = Rc::new(tokio::sync::Mutex::new(write));
        let answers: Rc<RefCell<VecDeque<Vec<u8>>>> = Rc::default();
        let subscriptions = Rc::new(Cell::new(0));
        let (writer, queue, count) = (phone_writer.clone(), answers.clone(), subscriptions.clone());
        let on = match AuxValue::archived_value(true) {
            AuxValue::Array(bytes) => bytes,
            _ => unreachable!(),
        };
        let task = tokio::task::spawn_local(async move {
            while let Ok(message) = Message::from_reader(&mut read).await {
                let subscribing = matches!(
                    message.aux.as_ref().and_then(|a| a.values.first()),
                    Some(AuxValue::Array(bytes)) if *bytes == on
                );
                if subscribing {
                    count.set(count.get() + 1);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    let next = queue.borrow_mut().pop_front();
                    if let Some(bytes) = next {
                        writer.lock().await.write_all(&bytes).await.unwrap();
                    }
                }
            }
        });
        let phone = Phone {
            answers,
            subscriptions,
            writer: phone_writer,
            task,
        };
        let watch = Watch::subscribe(Box::new(ours), settings(push))
            .await
            .unwrap();
        (watch, phone)
    }

    fn label(tree: &Json) -> String {
        tree["elements"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["label"].as_str())
            .filter(|l| *l != "App")
            .collect::<Vec<_>>()
            .join(",")
    }

    async fn timed(watch: &mut Watch) -> (String, Served, u128) {
        let started = Instant::now();
        let (tree, served) = watch.read(Duration::from_secs(5)).await.unwrap();
        (label(&tree), served, started.elapsed().as_millis())
    }

    fn local(test: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(tokio::task::LocalSet::new().run_until(test));
    }

    #[test]
    fn without_pushes_a_change_renews_the_subscription_and_old_trees_expire() {
        local(async {
            let (mut watch, phone) = connect(Push::Off).await;
            phone.answer(&[1], "One");
            assert_eq!(timed(&mut watch).await.0, "One");
            let (tree, served, ms) = timed(&mut watch).await;
            println!("cached read: {ms} ms");
            assert_eq!((tree.as_str(), served), ("One", Served::Cached));
            assert!(ms < 20);

            // A tap: the renewal starts in the background before the read asks.
            phone.answer(&[1], "Two");
            watch.invalidate();
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(
                phone.subscriptions.get(),
                2,
                "renewed after the rearm delay"
            );
            let (tree, served, ms) = timed(&mut watch).await;
            println!("read after a change, renewal already answered: {ms} ms ({served:?})");
            assert_eq!(tree, "Two");

            // Past the maximum age the tree is read again.
            phone.answer(&[1], "Three");
            tokio::time::sleep(Duration::from_millis(350)).await;
            let (tree, served, _) = timed(&mut watch).await;
            assert_eq!((tree.as_str(), served), ("Three", Served::Renewed));
            assert_eq!(watch.stats()["push_mode"], json!(false));
            phone.task.abort();
        });
    }

    #[test]
    fn log_stamps_are_utc_dates() {
        let stamp = stamp();
        assert_eq!(stamp.len(), 24, "{stamp}");
        let today = std::process::Command::new("date")
            .args(["-u", "+%Y-%m-%dT%H"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
        if let Ok(today) = today
            && !today.is_empty()
        {
            assert!(stamp.starts_with(&today[..10]), "{stamp} vs {today}");
        }
    }

    #[test]
    fn an_answer_to_a_subscription_made_before_a_change_is_not_served_after_it() {
        local(async {
            let (mut watch, phone) = connect(Push::Off).await;
            phone.answer(&[1], "Before");
            assert_eq!(timed(&mut watch).await.0, "Before");

            // A read renews just before a tap (tap_text locating its target), and the answer, which
            // shows the screen before the tap, arrives after the tap.
            phone.answer(&[1], "Before");
            phone.answer(&[1], "After");
            watch.inner.renew().await.unwrap();
            watch.invalidate();
            let (tree, served, ms) = timed(&mut watch).await;
            println!("read after a change with an older answer under way: {ms} ms ({served:?})");
            assert_eq!(tree, "After");
            assert_eq!(phone.subscriptions.get(), 3);
            phone.task.abort();
        });
    }

    #[test]
    fn with_pushes_a_change_is_served_from_the_trees_the_phone_sends() {
        local(async {
            let (mut watch, phone) = connect(Push::On).await;
            phone.answer(&[1], "One");
            assert_eq!(timed(&mut watch).await.0, "One");

            watch.invalidate();
            let pushing = async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                phone.push(&[1], "Two").await;
            };
            let ((tree, served, ms), ()) = tokio::join!(timed(&mut watch), pushing);
            println!("read after a pushed change: {ms} ms");
            assert_eq!((tree.as_str(), served), ("Two", Served::Waited));

            // Nothing arrives after the change: after the quiet time the screen did not change.
            watch.invalidate();
            let (tree, served, ms) = timed(&mut watch).await;
            assert_eq!((tree.as_str(), served), ("Two", Served::Unchanged));
            assert!((90..400).contains(&ms), "{ms} ms");
            // Old trees do not expire in push mode, and a later read needs no wait.
            tokio::time::sleep(Duration::from_millis(350)).await;
            let (tree, served, ms) = timed(&mut watch).await;
            assert_eq!((tree.as_str(), served), ("Two", Served::Unchanged));
            assert!(ms < 20, "{ms} ms");
            assert_eq!(phone.subscriptions.get(), 1);
            phone.task.abort();
        });
    }

    #[test]
    fn a_tree_nobody_asked_for_switches_auto_mode_to_push() {
        local(async {
            let (mut watch, phone) = connect(Push::Auto).await;
            phone.answer(&[1], "One");
            timed(&mut watch).await;
            assert_eq!(watch.stats()["push_mode"], json!(false));
            tokio::time::sleep(Duration::from_millis(200)).await;
            phone.push(&[1], "Two").await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(watch.stats()["pushed"], json!(1));
            assert_eq!(watch.stats()["push_mode"], json!(true));
            assert_eq!(timed(&mut watch).await.0, "Two");
            phone.task.abort();
        });
    }

    #[test]
    fn a_second_application_root_renews_the_subscription() {
        local(async {
            let (mut watch, phone) = connect(Push::On).await;
            phone.answer(&[1], "One");
            timed(&mut watch).await;
            // A whole dump of another app replaces the tree.
            watch.invalidate();
            phone.push(&[2], "Other app").await;
            assert_eq!(timed(&mut watch).await.0, "Other app");
            // A dump that names two applications is not served; a new subscription is made.
            phone.answer(&[3], "Third app");
            watch.invalidate();
            phone.push(&[2, 3], "Mixed").await;
            let (tree, served, _) = timed(&mut watch).await;
            assert_eq!((tree.as_str(), served), ("Third app", Served::Renewed));
            assert_eq!(phone.subscriptions.get(), 2);
            phone.task.abort();
        });
    }

    #[test]
    fn an_unanswered_read_gives_up_at_its_cap() {
        local(async {
            let (mut watch, phone) = connect(Push::Off).await;
            phone.answer(&[1], "One");
            timed(&mut watch).await;
            watch.invalidate();
            // The renewal is never answered.
            let started = Instant::now();
            let error = watch.read(Duration::from_millis(200)).await.unwrap_err();
            let ms = started.elapsed().as_millis();
            assert!(error.to_string().contains("did not arrive"), "{error}");
            assert!((190..400).contains(&ms), "{ms} ms");
            phone.task.abort();
        });
    }

    #[test]
    fn a_closed_subscription_is_an_error() {
        local(async {
            let (mut watch, phone) = connect(Push::Auto).await;
            phone.answer(&[1], "One");
            timed(&mut watch).await;
            phone.writer.lock().await.shutdown().await.unwrap();
            phone.task.abort();
            tokio::time::sleep(Duration::from_millis(20)).await;
            let error = watch.read(Duration::from_secs(1)).await.unwrap_err();
            assert!(error.to_string().contains("subscription ended"), "{error}");
        });
    }
}

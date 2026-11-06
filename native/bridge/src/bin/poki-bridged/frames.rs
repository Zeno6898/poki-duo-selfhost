//! The live screen (workstream J1, fork-only): the HEVC video that the input media session streams
//! anyway, decoded as it arrives, so the server always knows what is on the screen.
//!
//! The receive task reads the video socket (the tunnel's UDP queues are unbounded), counts packets
//! and, while decoding, reassembles access units (RFC 7798, with idevice's depacketizer). A complete
//! unit (an RTP packet with the marker bit) goes to the decoder thread, which decodes it with
//! libavcodec (see libav.rs) at once. For every picture the thread keeps:
//!
//! - the picture itself, by reference, so a JPEG of the latest one is made only when asked for;
//! - a small grayscale copy, compared with the previous one: a difference over the threshold is a
//!   change, with the changed region; a ring of these covers the last few seconds for `frame_diff`.
//!
//! The screen is `settled` when neither a pixel change nor an input has happened for the settle time
//! (`POKI_LIVE_SETTLE_MS`, default 150). The phone sends pictures only while the screen moves, so a
//! still screen is settled without any further picture.
//!
//! A key frame is asked for with RTCP (PLI and FIR) when decoding starts, after a lost packet, and
//! every second until one arrives; the decoder is fed from a key frame on.
use crate::libav;
use idevice::core_device::{HevcDepacketizer, RtpPacket, display_stream::rtcp};
use idevice::tcp::handle::UdpSocketHandle;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime},
};

/// The phone's video RTP port in the media session (see stream.rs); RTCP is sent there too.
const SENDER_VIDEO_PORT: u16 = 50001;
/// Columns of the grayscale copies the change detection compares.
const THUMB_WIDTH: u32 = 96;
/// A copy pixel that moved by more than this many gray levels changed.
const PIXEL_DELTA: u8 = 12;
/// Picture numbers, across every stream this daemon opens, so they only grow.
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Media session numbers: each Frames (one media session's stream) takes the next one. With the
/// epoch (the frame's sequence number) it names a frame the way upstream's frame cache does:
/// generation, seq, capture time, size, orientation and scale.
static SESSIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How long the copies are kept for `frame_diff`.
const RING: Duration = Duration::from_secs(5);

/// How long after an input a screen that has not moved counts as unchanged by it
/// (POKI_LIVE_NO_RESPONSE_MS, default 600).
pub fn no_response_time() -> Duration {
    Duration::from_millis(
        std::env::var("POKI_LIVE_NO_RESPONSE_MS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(600),
    )
}

/// How long the screen must be quiet after a change an input caused
/// (POKI_LIVE_SETTLE_AFTER_CHANGE_MS, default 350).
pub fn settle_after_change() -> Duration {
    Duration::from_millis(
        std::env::var("POKI_LIVE_SETTLE_AFTER_CHANGE_MS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(350),
    )
}

/// How long wait_settled looks again after an input-driven change settled, before saying so
/// (POKI_LIVE_SETTLE_RECHECK_MS, default 250; 0 for none).
pub fn settle_recheck() -> Duration {
    Duration::from_millis(
        std::env::var("POKI_LIVE_SETTLE_RECHECK_MS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(250),
    )
}

pub fn settle_time() -> Duration {
    Duration::from_millis(
        std::env::var("POKI_LIVE_SETTLE_MS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(150),
    )
}

/// A grayscale copy of one picture.
struct Thumb {
    arrived: Instant,
    wall: SystemTime,
    epoch: u64,
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

/// How two pictures differ: the share of changed copy pixels and the box around them, as fractions
/// of the screen (x, y, width, height).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Difference {
    pub changed: f64,
    pub region: Option<[f64; 4]>,
}

impl Difference {
    pub fn json(&self) -> Value {
        json!({
            "changed": self.changed > 0.0,
            "changed_fraction": (self.changed * 10000.0).round() / 10000.0,
            "region": self.region.map(|r| r.map(|v| (v * 1000.0).round() / 1000.0)),
        })
    }
}

fn compare(a: &Thumb, b: &Thumb) -> Difference {
    if (a.width, a.height) != (b.width, b.height) {
        return Difference {
            changed: 1.0,
            region: Some([0.0, 0.0, 1.0, 1.0]),
        };
    }
    let (w, h) = (a.width as usize, a.height as usize);
    let (mut count, mut x0, mut y0, mut x1, mut y1) = (0usize, w, h, 0usize, 0usize);
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            if a.pixels[row + x].abs_diff(b.pixels[row + x]) > PIXEL_DELTA {
                count += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    let region = (count > 0).then(|| {
        [
            x0 as f64 / w as f64,
            y0 as f64 / h as f64,
            (x1 + 1 - x0) as f64 / w as f64,
            (y1 + 1 - y0) as f64 / h as f64,
        ]
    });
    Difference {
        changed: count as f64 / (w * h) as f64,
        region,
    }
}

#[derive(Default)]
struct Counters {
    packets: u64,
    rtcp: u64,
    bytes: u64,
    lost: u64,
    units: u64,
    key_units: u64,
    decoded: u64,
    decode_errors: u64,
    last_decode_error: Option<String>,
    decode_ms_sum: f64,
    decode_ms_max: f64,
    keyframe_requests: u64,
    changes: u64,
    /// Sequence jumps backwards or far ahead, and SSRC changes (a new stream on the same session).
    discontinuities: u64,
    /// Times packets kept arriving with no picture for STALL_AFTER.
    stalls: u64,
    /// Packet losses inside a decoded stream: pictures after one may show errors until the next
    /// key unit (this phone sends one only when a session opens).
    damaging_losses: u64,
    /// Units not decoded because no key unit had come yet in this stream.
    units_before_key: u64,
    /// Units given to the decoder, and units it is done with (with or without a picture): the
    /// newest picture is current when the two are equal.
    units_to_decoder: u64,
    units_done: u64,
    /// Units smaller than POKI_LIVE_ACTIVE_BYTES, not counted as movement.
    small_units: u64,
    /// Pixel changes that repeated in place (see Animations), not counted as movement.
    in_place_changes: u64,
    /// Time inside the decoder only (decode_ms_sum also counts the wait in the queue).
    decode_work_ms_sum: f64,
    decode_work_units: u64,
    restart_requests: u64,
    /// Units the decoder took without giving a picture (a missing reference, or a unit it could
    /// not use), and how many in a row now.
    units_without_picture: u64,
    units_without_picture_run: u64,
    last_packet: Option<Instant>,
    max_unit_gap_ms: u64,
    last_unit: Option<Instant>,
}

/// The latest picture: when its unit arrived, the wall time then, and its size.
pub type Latest = (Instant, SystemTime, u32, u32);

/// The newest unit that counts as movement (at least POKI_LIVE_ACTIVE_BYTES): when it arrived,
/// the wall time then, its size, and the picture number current then.
#[derive(Clone, Copy, Debug)]
pub struct Activity {
    pub at: Instant,
    pub wall: SystemTime,
    pub bytes: usize,
    pub epoch: u64,
}

/// How big a unit must be to mean movement. The phone may stream units on a still screen (an
/// iPhone 17 Pro sent 50 to 58 a second on an idle home screen), so their arrival alone means
/// nothing; their size does: a repeated picture codes to a few bytes, a change to more. The
/// idle baseline is a low percentile of the sizes seen over the last 30 s (a still screen's
/// repeats dominate it whenever there was a still moment), and a unit counts as movement when it
/// is over `factor` times that plus a margin. POKI_LIVE_ACTIVE_BYTES fixes the threshold instead;
/// POKI_LIVE_ACTIVE_FACTOR sets the factor (default 2). Until a baseline exists (the first
/// second), every unit counts: "unchanged" is never claimed without one.
#[derive(Debug)]
struct UnitSizes {
    recent: VecDeque<(Instant, usize)>,
    baseline: Option<usize>,
    computed_at: Option<Instant>,
    fixed: Option<usize>,
    factor: f64,
}

/// What the idle baseline is computed over, how often, and from which percentile.
const SIZE_WINDOW: Duration = Duration::from_secs(30);
const SIZE_PERCENTILE: f64 = 0.10;
const SIZE_MARGIN: usize = 32;

impl UnitSizes {
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self::new(
            var("POKI_LIVE_ACTIVE_BYTES").and_then(|v| v.trim().parse().ok()),
            var("POKI_LIVE_ACTIVE_FACTOR").and_then(|v| v.trim().parse().ok()),
        )
    }

    fn new(fixed: Option<usize>, factor: Option<f64>) -> Self {
        Self {
            recent: VecDeque::new(),
            baseline: None,
            computed_at: None,
            fixed,
            factor: factor.unwrap_or(2.0),
        }
    }

    /// Records one unit; whether it means movement.
    fn push(&mut self, now: Instant, bytes: usize) -> bool {
        self.recent.push_back((now, bytes));
        while self
            .recent
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > SIZE_WINDOW)
        {
            self.recent.pop_front();
        }
        let started = self.recent.front().map_or(now, |(at, _)| *at);
        if now.duration_since(started) >= Duration::from_secs(1)
            && self
                .computed_at
                .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(1))
        {
            let mut sizes: Vec<usize> = self.recent.iter().map(|(_, b)| *b).collect();
            sizes.sort_unstable();
            self.baseline = Some(sizes[((sizes.len() - 1) as f64 * SIZE_PERCENTILE) as usize]);
            self.computed_at = Some(now);
        }
        bytes >= self.threshold()
    }

    fn threshold(&self) -> usize {
        self.fixed
            .or(self
                .baseline
                .map(|b| (b as f64 * self.factor) as usize + SIZE_MARGIN))
            .unwrap_or(0)
    }

    /// The average unit size over the last second.
    fn average(&self, now: Instant) -> Option<usize> {
        let last: Vec<usize> = self
            .recent
            .iter()
            .rev()
            .take_while(|(at, _)| now.duration_since(*at) <= Duration::from_secs(1))
            .map(|(_, b)| *b)
            .collect();
        (!last.is_empty()).then(|| last.iter().sum::<usize>() / last.len())
    }
}

impl Default for UnitSizes {
    fn default() -> Self {
        Self::new(None, None)
    }
}

/// Changes that repeat in place (a spinner, a clock, a blinking caret) are not movement: a screen
/// with one would never settle. A change is "in place" when earlier changes over at least
/// IN_PLACE_FOR touched it and together cover it (with a small margin), within a box under
/// IN_PLACE_AREA of the screen. A change once, however small (a typed character, a toggle), is
/// movement; so is one that reaches outside the box (typing next to the caret), and any change in
/// the AFTER_INPUT after an input.
#[derive(Default)]
struct Animations {
    history: VecDeque<(Instant, [f64; 4])>,
    minor: VecDeque<(Instant, [f64; 4])>,
}

const IN_PLACE_FOR: Duration = Duration::from_millis(600);
/// How long after an input a change counts as in place only inside a known animating region.
const AFTER_INPUT: Duration = Duration::from_millis(300);
const IN_PLACE_AREA: f64 = 0.10;
const IN_PLACE_MARGIN: f64 = 0.01;

/// A region that keeps changing in place, for answers: {x, y, w, h, pct} (fractions of the
/// screen; pct of its area), or null.
pub fn animating_json(region: Option<[f64; 4]>) -> Value {
    region.map_or(Value::Null, |[x, y, w, h]| {
        let r = |v: f64| (v * 1000.0).round() / 1000.0;
        json!({"x": r(x), "y": r(y), "w": r(w), "h": r(h), "pct": (w * h * 1000.0).round() / 10.0})
    })
}

fn union(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
    let (x1, y1) = (
        (a[0] + a[2]).max(b[0] + b[2]),
        (a[1] + a[3]).max(b[1] + b[3]),
    );
    [x0, y0, x1 - x0, y1 - y0]
}

fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

fn contains(outer: [f64; 4], inner: [f64; 4], margin: f64) -> bool {
    inner[0] >= outer[0] - margin
        && inner[1] >= outer[1] - margin
        && inner[0] + inner[2] <= outer[0] + outer[2] + margin
        && inner[1] + inner[3] <= outer[1] + outer[3] + margin
}

impl Animations {
    /// Records a change; whether it repeats in place (and so is not movement).
    /// `answering` (right after an input): only a change inside where something was already
    /// seen repeating in place counts, so the input's own effect is never taken for it.
    fn in_place(&mut self, now: Instant, region: [f64; 4], answering: bool) -> bool {
        let keep = IN_PLACE_FOR * 3;
        while self
            .history
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > keep)
        {
            self.history.pop_front();
        }
        while self
            .minor
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > Duration::from_secs(1))
        {
            self.minor.pop_front();
        }
        // Only small changes say where something repeats: a transition that covered this place
        // too (a push into a screen with a spinner) is not part of the spinner.
        let touching: Vec<&(Instant, [f64; 4])> = self
            .history
            .iter()
            .filter(|(_, r)| r[2] * r[3] < IN_PLACE_AREA && intersects(*r, region))
            .collect();
        let oldest = touching.iter().map(|(at, _)| *at).min();
        let place = touching.iter().map(|(_, r)| *r).reduce(union);
        let known = self.region(now);
        let in_place = touching.len() >= 3
            && oldest.is_some_and(|at| now.duration_since(at) >= IN_PLACE_FOR)
            && place.is_some_and(|b| {
                b[2] * b[3] < IN_PLACE_AREA && contains(b, region, IN_PLACE_MARGIN)
            })
            && (!answering || known.is_some_and(|k| contains(k, region, IN_PLACE_MARGIN)));
        self.history.push_back((now, region));
        if in_place {
            self.minor.push_back((now, region));
        }
        in_place
    }

    /// Where something kept changing in place over the last second.
    fn region(&self, now: Instant) -> Option<[f64; 4]> {
        self.minor
            .iter()
            .filter(|(at, _)| now.duration_since(*at) <= Duration::from_secs(1))
            .map(|(_, r)| *r)
            .reduce(union)
    }
}

/// What the daemon reads; written by the receive task and the decoder thread.
#[derive(Default)]
struct Screen {
    counters: Counters,
    thumbs: VecDeque<Thumb>,
    latest: Option<Latest>,
    /// The latest picture's number (see EPOCH).
    epoch: u64,
    last_change: Option<(Instant, Difference)>,
    last_change_wall: Option<SystemTime>,
    last_change_epoch: Option<u64>,
    /// The epoch current when the last input was sent.
    last_input_epoch: Option<u64>,
    last_input: Option<Instant>,
    last_input_wall: Option<SystemTime>,
    /// Set when the media session that carried this stream closed.
    closed: bool,
    decoder_error: Option<String>,
    decoding_since: Option<Instant>,
    first_picture_after_ms: Option<u64>,
    /// Bumped for every picture and input, to wake waiters.
    generation: u64,
    /// This stream's media session number (see SESSIONS).
    session: u64,
    /// The screen in points, from the newest accessibility tree's Application frame.
    points: Option<(f64, f64)>,
    /// When the decoder last gave a picture.
    last_decoded_at: Option<Instant>,
    /// Since when packets arrive but no picture comes out (cleared by the next picture).
    stalled_since: Option<Instant>,
    /// Set when resynchronizing did not bring a key frame: the media session should be reopened.
    restart_requested: bool,
    /// Since when the pictures may show errors from a lost packet (cleared by a key unit).
    damaged_since: Option<Instant>,
    /// The packet clock: the phone sends a unit only when pixels change, so the newest unit's
    /// arrival says when the screen last moved, decoded or not (see Activity).
    activity: Option<Activity>,
    units_since_input: u64,
    /// Sizes of the newest units, for tuning, and the idle baseline (see UnitSizes).
    recent_unit_bytes: VecDeque<usize>,
    sizes: UnitSizes,
    /// Changes that repeat in place, kept apart from movement (see Animations).
    animations: Animations,
    /// The decoder thread's niceness (see lower_priority).
    decoder_nice: Option<i32>,
}

enum Job {
    Unit(Vec<u8>, Instant),
    Flush,
    Jpeg {
        width: u32,
        quality: u32,
        reply: tokio::sync::oneshot::Sender<Result<Jpeg, String>>,
    },
}

pub struct Jpeg {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// When the picture's unit arrived.
    pub arrived: Instant,
    pub wall: SystemTime,
    /// The picture's number.
    pub epoch: u64,
    pub encode_ms: f64,
}

/// A view of the live screen that needs no lock on the daemon's session.
#[derive(Clone)]
pub struct Live {
    screen: Arc<Mutex<Screen>>,
    jobs: mpsc::Sender<Job>,
    changed: tokio::sync::watch::Receiver<u64>,
    notify: Arc<tokio::sync::watch::Sender<u64>>,
}

pub struct Frames {
    live: Live,
    receiver: tokio::task::JoinHandle<()>,
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.receiver.abort();
        let mut screen = self.live.screen.lock().unwrap();
        screen.closed = true;
        screen.generation += 1;
        self.live.notify.send_replace(screen.generation);
    }
}

impl Frames {
    /// Reads the video socket; decoding starts at once when `decode` is set, or with `decode()`.
    /// `our_ssrc` is the SSRC the video offer declared: the phone takes RTCP only from it.
    pub fn new(socket: UdpSocketHandle, our_ssrc: u32, decode: bool) -> Self {
        Self::over(socket, our_ssrc, decode)
    }

    /// Frames from any datagram source (the media session's UDP socket, or a test's).
    fn over<S: Datagrams>(socket: S, our_ssrc: u32, decode: bool) -> Self {
        let screen = Arc::new(Mutex::new(Screen {
            session: SESSIONS.fetch_add(1, Ordering::SeqCst) + 1,
            sizes: UnitSizes::from_env(),
            ..Screen::default()
        }));
        let (jobs, queue) = mpsc::channel();
        let (notify, changed) = tokio::sync::watch::channel(0u64);
        let notify = Arc::new(notify);
        let ready = Arc::new(AtomicBool::new(false));
        {
            let (screen, notify, ready) = (screen.clone(), notify.clone(), ready.clone());
            std::thread::Builder::new()
                .name("poki-frames".into())
                .spawn(move || decode_loop(queue, screen, notify, ready))
                .expect("thread");
        }
        let receiver = tokio::spawn(receive(
            Arc::new(socket),
            screen.clone(),
            jobs.clone(),
            ready,
            our_ssrc,
            notify.clone(),
        ));
        let frames = Self {
            live: Live {
                screen,
                jobs,
                changed,
                notify,
            },
            receiver,
        };
        if decode {
            frames.live.decode();
        }
        frames
    }

    pub fn live(&self) -> Live {
        self.live.clone()
    }
}

/// Counter values at one moment, to measure rates between two of them.
#[derive(Clone, Copy)]
pub struct Mark {
    at: Instant,
    packets: u64,
    bytes: u64,
    units: u64,
    decoded: u64,
    decode_ms_sum: f64,
    lost: u64,
    cpu: Option<f64>,
    decoder_cpu: Option<f64>,
}

/// What the screen is doing now.
pub struct State {
    pub settled: bool,
    /// Since when nothing moved and no input was sent.
    pub quiet_since: Option<Instant>,
    pub latest: Option<Latest>,
    /// The latest picture's number; numbers grow across streams (0 before the first).
    pub epoch: u64,
    pub last_change: Option<(Instant, Difference)>,
    pub last_change_wall: Option<SystemTime>,
    pub last_change_epoch: Option<u64>,
    pub last_input_epoch: Option<u64>,
    pub last_input: Option<Instant>,
    pub last_input_wall: Option<SystemTime>,
    /// The media session closed; a new one has a new stream.
    pub closed: bool,
    /// The media session number (upstream's session generation).
    pub session: u64,
    /// Packets arrive but no picture comes out: the newest picture is stale, however still the
    /// screen looks. Since when.
    pub stalled_since: Option<Instant>,
    /// The packet clock (decoded or not): the newest unit, whether one came within the settle
    /// time, and how many came since the last input.
    pub activity: Option<Activity>,
    pub moving: bool,
    pub units_since_input: u64,
    /// The decoder has every unit that arrived behind it: the newest picture is the screen now.
    /// Always true when nothing is decoded.
    pub picture_current: bool,
    pub decoding: bool,
    /// Whether the screen moved after the last input (None before any input), by the authority
    /// in use: pixels when decoding, unit sizes otherwise.
    pub changed_since_input: Option<bool>,
    /// Where something kept changing in place over the last second (x, y, w, h as fractions):
    /// settled does not wait for it.
    pub animating_region: Option<[f64; 4]>,
    /// The earliest moment the screen can be settled if nothing moves (the quiet time's end, or
    /// after an input the screen has not answered, no_response_time after it).
    pub settles_at: Option<Instant>,
}

impl Live {
    /// Starts decoding (idempotent).
    pub fn decode(&self) {
        let mut screen = self.screen.lock().unwrap();
        if screen.decoding_since.is_none() {
            screen.decoding_since = Some(Instant::now());
            screen.decoder_error = libav::available().err();
        }
    }

    /// An input was sent now: the screen is not settled until it is quiet again.
    pub fn note_input(&self) {
        let mut screen = self.screen.lock().unwrap();
        screen.last_input = Some(Instant::now());
        screen.last_input_wall = Some(SystemTime::now());
        screen.last_input_epoch = Some(screen.epoch);
        screen.units_since_input = 0;
        screen.generation += 1;
        self.notify.send_replace(screen.generation);
    }

    pub fn decoding(&self) -> bool {
        self.screen.lock().unwrap().decoding_since.is_some()
    }

    pub fn error(&self) -> Option<String> {
        self.screen.lock().unwrap().decoder_error.clone()
    }

    /// The screen now. After a change an input caused, quiet must last settle_after_change()
    /// (an app's response comes in steps: a 150 ms lull inside a push is not the end of it).
    pub fn state(&self, settle: Duration) -> State {
        self.state_with(settle, settle_after_change())
    }

    /// state() with the quiet needed after an input-driven change given (`settle` for none).
    pub fn state_with(&self, settle: Duration, after_change: Duration) -> State {
        let screen = self.screen.lock().unwrap();
        let decoding = screen.decoding_since.is_some() && screen.decoder_error.is_none();
        // When decoding, the pixel difference is the authority on movement; otherwise the size
        // of the units (see UnitSizes).
        let moved = if decoding {
            screen.last_change.map(|(at, _)| at)
        } else {
            screen.activity.map(|a| a.at)
        };
        let quiet_since = [moved, screen.last_input]
            .into_iter()
            .flatten()
            .max()
            .or(screen.decoding_since);
        let changed_since_input = screen
            .last_input
            .map(|input| moved.is_some_and(|at| at > input));
        let settle = if changed_since_input == Some(true) {
            settle.max(after_change)
        } else {
            settle
        };
        let quiet = quiet_since.is_none_or(|at| at.elapsed() >= settle);
        // After an input, quiet is not settled until the screen answered or had time to: apps
        // take 100 to 300 ms to start reacting, so quiet before then proves nothing.
        let answer_by = screen
            .last_input
            .filter(|_| changed_since_input == Some(false))
            .map(|input| input + no_response_time());
        let awaiting_answer = answer_by.is_some_and(|by| Instant::now() < by);
        let settles_at = quiet_since
            .map(|at| at + settle)
            .into_iter()
            .chain(answer_by)
            .max();
        // The newest picture is not older than the newest unit that meant movement: whatever
        // waits in the decoder's queue repeats it.
        let picture_current = !decoding
            || screen
                .latest
                .is_some_and(|l| screen.activity.is_none_or(|a| l.0 >= a.at));
        State {
            settled: quiet
                && !awaiting_answer
                && (!decoding || (screen.latest.is_some() && picture_current)),
            settles_at,
            moving: moved.is_some_and(|at| at.elapsed() < settle),
            animating_region: screen.animations.region(Instant::now()),
            changed_since_input,
            activity: screen.activity,
            units_since_input: screen.units_since_input,
            picture_current,
            decoding,
            quiet_since,
            latest: screen.latest,
            last_change: screen.last_change,
            last_change_wall: screen.last_change_wall,
            epoch: screen.epoch,
            last_change_epoch: screen.last_change_epoch,
            last_input_epoch: screen.last_input_epoch,
            last_input: screen.last_input,
            last_input_wall: screen.last_input_wall,
            closed: screen.closed,
            session: screen.session,
            stalled_since: screen.stalled_since,
        }
    }

    /// A packet was lost since the last key unit: pictures may show errors.
    pub fn damaged(&self) -> bool {
        self.screen.lock().unwrap().damaged_since.is_some()
    }

    /// Whether resynchronizing failed and the media session should be reopened; clears it.
    pub fn take_restart_request(&self) -> bool {
        std::mem::take(&mut self.screen.lock().unwrap().restart_requested)
    }

    /// Learns the screen's size in points from an accessibility tree (its Application frame), so
    /// frames can say their scale.
    pub fn note_points(&self, tree: &Value) {
        let points = tree
            .get("elements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find_map(|element| {
                (element.get("role")?.as_str()? == "Application").then_some(())?;
                let frame = element.get("frame")?;
                Some((
                    frame.get("width")?.as_f64()?,
                    frame.get("height")?.as_f64()?,
                ))
            })
            .filter(|(w, h)| *w > 0.0 && *h > 0.0);
        if let Some(points) = points {
            self.screen.lock().unwrap().points = Some(points);
        }
    }

    /// A frame's identity: generation (media session), seq (its epoch), capture time, size in
    /// pixels, orientation (from the size) and scale (pixels per point, once a tree has given the
    /// screen's size in points; null before).
    pub fn identity(&self, seq: u64, captured: SystemTime, width: u32, height: u32) -> Value {
        let screen = self.screen.lock().unwrap();
        identity(&screen, seq, captured, width, height)
    }

    /// The identity of the newest frame, if there is one.
    pub fn latest_identity(&self) -> Option<Value> {
        let screen = self.screen.lock().unwrap();
        let (_, wall, width, height) = screen.latest?;
        Some(identity(&screen, screen.epoch, wall, width, height))
    }

    /// Waits until the screen is settled, for at most `timeout`; whether it settled.
    pub async fn wait_settled(&self, settle: Duration, timeout: Duration) -> bool {
        self.wait_settled_with(settle, settle_after_change(), settle_recheck(), timeout)
            .await
    }

    /// Waits for `settle` of quiet alone, with no longer quiet after an input-driven change and
    /// no re-check: for type_text, which knows what it waits for.
    pub async fn wait_quiet(&self, settle: Duration, timeout: Duration) -> bool {
        self.wait_settled_with(settle, settle, Duration::ZERO, timeout)
            .await
    }

    async fn wait_settled_with(
        &self,
        settle: Duration,
        after_change: Duration,
        recheck: Duration,
        timeout: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut changed = self.changed.clone();
        loop {
            changed.mark_unchanged();
            let state = self.state_with(settle, after_change);
            if state.settled {
                // An input's effect may come in steps: look once more before saying it ended.
                if state.changed_since_input != Some(true) || recheck.is_zero() {
                    return true;
                }
                let until = (tokio::time::Instant::now() + recheck).min(deadline);
                tokio::time::sleep_until(until).await;
                let again = self.state_with(settle, after_change);
                if again.settled && again.quiet_since == state.quiet_since {
                    return true;
                }
                if tokio::time::Instant::now() >= deadline {
                    return false;
                }
                continue;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            // Wake when the quiet time would end, or at the next picture or input.
            let until = state
                .settles_at
                .map_or(deadline, tokio::time::Instant::from_std)
                .min(deadline)
                .max(now + Duration::from_millis(1));
            let _ = tokio::time::timeout_at(until, changed.changed()).await;
        }
    }

    /// Waits for a picture whose unit arrived after `after`, for at most `timeout`.
    pub async fn wait_picture_after(&self, after: Instant, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut changed = self.changed.clone();
        loop {
            changed.mark_unchanged();
            if self
                .screen
                .lock()
                .unwrap()
                .latest
                .is_some_and(|l| l.0 > after)
            {
                return true;
            }
            if tokio::time::timeout_at(deadline, changed.changed())
                .await
                .is_err()
            {
                return false;
            }
        }
    }

    /// Whether the screen is as it was at `at`: no pixel change and no input since.
    pub fn unchanged_since(&self, at: Instant) -> bool {
        let screen = self.screen.lock().unwrap();
        let decoding = screen.decoding_since.is_some() && screen.decoder_error.is_none();
        let moved = if decoding {
            screen.last_change.map(|(at, _)| at)
        } else {
            screen.activity.map(|a| a.at)
        };
        // Pixels vouch for the screen only up to the newest picture: a stalled or lagging
        // decoder proves nothing about the time after it.
        let pixels_cover = !decoding
            || (screen.stalled_since.is_none()
                && screen
                    .latest
                    .is_some_and(|l| screen.activity.is_none_or(|a| l.0 >= a.at)));
        pixels_cover
            && moved.is_none_or(|moved| moved <= at)
            && screen.last_input.is_none_or(|input| input <= at)
            && !screen.closed
    }

    /// The number of the latest picture that had arrived by `at`.
    pub fn epoch_at(&self, at: Instant) -> u64 {
        let screen = self.screen.lock().unwrap();
        screen
            .thumbs
            .iter()
            .rev()
            .find(|t| t.arrived <= at)
            .map_or_else(
                || {
                    if screen.latest.is_some_and(|l| l.0 <= at) {
                        screen.epoch
                    } else {
                        0
                    }
                },
                |t| t.epoch,
            )
    }

    /// A receiver that changes at every picture and input.
    pub fn watcher(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changed.clone()
    }

    /// The latest picture as a JPEG.
    pub async fn jpeg(&self, width: u32, quality: u32) -> Result<Jpeg, String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.jobs
            .send(Job::Jpeg {
                width,
                quality,
                reply,
            })
            .map_err(|_| "the frame decoder stopped".to_string())?;
        answer
            .await
            .map_err(|_| "the frame decoder stopped".to_string())?
    }

    /// How the screen changed between two moments (`ago` before now), by the copies current at
    /// each, and the wall times of the copies used.
    pub fn diff(
        &self,
        a_ago: Duration,
        b_ago: Duration,
    ) -> Option<(Difference, SystemTime, SystemTime)> {
        let screen = self.screen.lock().unwrap();
        let now = Instant::now();
        let at = |ago: Duration| {
            let moment = now.checked_sub(ago).unwrap_or(now);
            screen
                .thumbs
                .iter()
                .rev()
                .find(|t| t.arrived <= moment)
                .or_else(|| screen.thumbs.front())
        };
        let (a, b) = (at(a_ago)?, at(b_ago)?);
        Some((compare(a, b), a.wall, b.wall))
    }

    pub fn mark(&self) -> Mark {
        let screen = self.screen.lock().unwrap();
        let c = &screen.counters;
        Mark {
            at: Instant::now(),
            packets: c.packets,
            bytes: c.bytes,
            units: c.units,
            decoded: c.decoded,
            decode_ms_sum: c.decode_ms_sum,
            lost: c.lost,
            cpu: cpu_seconds("self"),
            decoder_cpu: decoder_thread_cpu(),
        }
    }

    /// What happened between `from` and now, and the totals.
    pub fn report(&self, from: &Mark) -> Value {
        let to = self.mark();
        let seconds = to.at.duration_since(from.at).as_secs_f64().max(0.001);
        let rate = |a: u64, b: u64| ((b - a) as f64 / seconds * 10.0).round() / 10.0;
        let cpu = |a: Option<f64>, b: Option<f64>| {
            a.zip(b)
                .map(|(a, b)| ((b - a) / seconds * 1000.0).round() / 10.0)
        };
        let decoded = to.decoded - from.decoded;
        let state = self.state(settle_time());
        let screen = self.screen.lock().unwrap();
        let c = &screen.counters;
        let since = |at: Option<Instant>| at.map(|at| at.elapsed().as_millis() as u64);
        let mut report = json!({
            "seconds": (seconds * 10.0).round() / 10.0,
            "packets_per_s": rate(from.packets, to.packets),
            "kbit_per_s": rate(from.bytes * 8 / 1000, to.bytes * 8 / 1000),
            "units_per_s": rate(from.units, to.units),
            "decoded_per_s": rate(from.decoded, to.decoded),
            "decode_ms_avg": (decoded > 0).then(|| ((to.decode_ms_sum - from.decode_ms_sum) / decoded as f64 * 100.0).round() / 100.0),
            "lost_packets": to.lost - from.lost,
            "daemon_cpu_percent": cpu(from.cpu, to.cpu),
            "decoder_thread_cpu_percent": cpu(from.decoder_cpu, to.decoder_cpu),
            "settled": state.settled,
            "latest_age_ms": since(state.latest.map(|l| l.0)),
            "ms_since_change": since(state.last_change.map(|c| c.0)),
            "size": state.latest.map(|l| [l.2, l.3]),
            "epoch": state.epoch,
            "decoding": screen.decoding_since.is_some(),
            "decoder_error": screen.decoder_error,
            "video_stalled": screen.stalled_since.is_some(),
            "picture_damaged": screen.damaged_since.is_some(),
            "stalled_ms": since(screen.stalled_since),
            "totals": {
                "packets": c.packets,
                "rtcp": c.rtcp,
                "units": c.units,
                "key_units": c.key_units,
                "decoded": c.decoded,
                "changes": c.changes,
                "lost_packets": c.lost,
                "decode_errors": c.decode_errors,
                "last_decode_error": c.last_decode_error,
                "keyframe_requests": c.keyframe_requests,
                "discontinuities": c.discontinuities,
                "stalls": c.stalls,
                "restart_requests": c.restart_requests,
                "damaging_losses": c.damaging_losses,
                "small_units": c.small_units,
                "decode_work_ms_avg": (c.decode_work_units > 0).then(|| (c.decode_work_ms_sum / c.decode_work_units as f64 * 100.0).round() / 100.0),
                "units_without_picture": c.units_without_picture,
                "units_without_picture_run": c.units_without_picture_run,
                "max_unit_gap_ms": c.max_unit_gap_ms,
                "decode_ms_max": (c.decode_ms_max * 100.0).round() / 100.0,
                "first_picture_after_ms": screen.first_picture_after_ms,
            },
            "ms_since_last_packet": since(c.last_packet),
        });
        // The packet clock, and how far the picture is behind it.
        let clock = json!({
            "queued_units": c.units_to_decoder.saturating_sub(c.units_done),
            "picture_current": state.picture_current,
            "moving": state.moving,
            "ms_since_unit": since(state.activity.map(|a| a.at)),
            "units_since_input": state.units_since_input,
            "recent_unit_bytes": screen.recent_unit_bytes,
            "unit_bytes_avg": screen.sizes.average(Instant::now()),
            "idle_baseline_bytes": screen.sizes.baseline,
            "active_threshold_bytes": screen.sizes.threshold(),
            "movement_from": if state.decoding { "pixels" } else { "unit_bytes" },
            "animating_region": animating_json(state.animating_region),
            "in_place_changes": c.in_place_changes,
            // Why units gave no picture: before this stream's key unit, taken by the decoder
            // without output (a missing reference), or a decode error.
            "no_picture_reasons": {"no_key_yet": c.units_before_key, "no_output": c.units_without_picture, "decode_error": c.decode_errors},
            "decode_work_ms_avg": (c.decode_work_units > 0).then(|| (c.decode_work_ms_sum / c.decode_work_units as f64 * 100.0).round() / 100.0),
            "decoder_nice": screen.decoder_nice,
        });
        if let (Value::Object(report), Value::Object(clock)) = (&mut report, clock) {
            report.extend(clock);
        }
        report
    }
}

/// User plus system CPU seconds of a process (or `self/task/<tid>`), from /proc.
fn cpu_seconds(pid: &str) -> Option<f64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Fields after the parenthesised command name; utime and stime are fields 14 and 15.
    let rest = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let ticks: f64 = fields.get(11)?.parse::<f64>().ok()? + fields.get(12)?.parse::<f64>().ok()?;
    Some(ticks / 100.0)
}

/// CPU seconds of the decoder threads, found by name.
fn decoder_thread_cpu() -> Option<f64> {
    let mut total = None;
    for task in std::fs::read_dir("/proc/self/task").ok()?.flatten() {
        let id = task.file_name().to_string_lossy().into_owned();
        let name =
            std::fs::read_to_string(format!("/proc/self/task/{id}/comm")).unwrap_or_default();
        if name.trim() == "poki-frames" {
            *total.get_or_insert(0.0) += cpu_seconds(&format!("self/task/{id}")).unwrap_or(0.0);
        }
    }
    total
}

/// Where RTP arrives and RTCP goes: the media session's UDP socket, or a test's fake.
trait Datagrams: Send + Sync + 'static {
    fn recv(&self) -> impl std::future::Future<Output = std::io::Result<Vec<u8>>> + Send;
    fn send_to(
        &self,
        port: u16,
        data: Vec<u8>,
    ) -> impl std::future::Future<Output = std::io::Result<()>> + Send;
}

impl Datagrams for UdpSocketHandle {
    async fn recv(&self) -> std::io::Result<Vec<u8>> {
        UdpSocketHandle::recv(self)
            .await
            .map(|datagram| datagram.data)
    }
    async fn send_to(&self, port: u16, data: Vec<u8>) -> std::io::Result<()> {
        UdpSocketHandle::send_to(self, port, data).await
    }
}

/// Packets arriving with no picture for this long is a stall, not a still screen (a still screen
/// sends no packets): the newest picture is reported stale.
const STALL_AFTER: Duration = Duration::from_millis(500);
/// Units arriving and the newest picture this old (or no key unit this long after decoding
/// started): ask for a new media session, which opens with a key unit. Measured on an iPhone 17
/// Pro: the phone does not answer key frame requests, so nothing short of that brings one, and
/// units are never dropped to catch up (each one after a drop would refer to a missing picture).
const RECOVER_AFTER: Duration = Duration::from_millis(1500);
/// How long a new session may take to send its key unit before it is given up.
const FIRST_KEY_WITHIN: Duration = Duration::from_secs(5);

async fn receive<S: Datagrams>(
    socket: Arc<S>,
    screen: Arc<Mutex<Screen>>,
    jobs: mpsc::Sender<Job>,
    decoder_ready: Arc<AtomicBool>,
    our_ssrc: u32,
    notify: Arc<tokio::sync::watch::Sender<u64>>,
) {
    // Bytes of the unit being received, for the packet clock.
    let mut unit_bytes = 0usize;
    let mut depacketizer = HevcDepacketizer::new();
    let mut last_seq: Option<u16> = None;
    let mut was_decoding = false;
    // Set once a key frame has gone to the decoder; until then nothing is sent.
    let mut keyed = false;
    let mut unit = Vec::new();
    let mut last_request: Option<Instant> = None;
    let mut fir_seq = 0u8;
    let mut last_ssrc: Option<u32> = None;
    // Since when a key unit is awaited (after the start, a loss or a stall).
    let mut waiting_since: Option<Instant> = None;
    // When a key unit last went to the decoder.
    let mut keyed_at: Option<Instant> = None;
    while let Ok(datagram) = socket.recv().await {
        let now = Instant::now();
        let data = &datagram;
        if rtcp::is_rtcp(data) {
            screen.lock().unwrap().counters.rtcp += 1;
            continue;
        }
        let Some(packet) = RtpPacket::parse(data) else {
            continue;
        };
        let (decoding, gap) = {
            let mut screen = screen.lock().unwrap();
            let c = &mut screen.counters;
            c.packets += 1;
            c.bytes += data.len() as u64;
            c.last_packet = Some(now);
            let mut gap = false;
            if let Some(last) = last_seq {
                let step = packet.sequence_number.wrapping_sub(last);
                if step > 1 && step < 0x8000 {
                    c.lost += u64::from(step - 1);
                    gap = true;
                } else if step >= 0x8000 && 0u16.wrapping_sub(step) > 64 {
                    // Far behind: a new sequence (the phone restarted the stream). The depacketizer
                    // would ignore every packet as a late duplicate.
                    c.discontinuities += 1;
                    gap = true;
                }
            }
            if last_ssrc.is_some_and(|ssrc| ssrc != packet.ssrc) {
                c.discontinuities += 1;
                gap = true;
            }
            unit_bytes += packet.payload.len();
            if packet.marker {
                c.units += 1;
                if let Some(last) = c.last_unit {
                    let gap_ms = now.duration_since(last).as_millis() as u64;
                    c.max_unit_gap_ms = c.max_unit_gap_ms.max(gap_ms);
                }
                c.last_unit = Some(now);
                let bytes = std::mem::take(&mut unit_bytes);
                if screen.recent_unit_bytes.len() >= 32 {
                    screen.recent_unit_bytes.pop_front();
                }
                screen.recent_unit_bytes.push_back(bytes);
                if screen.sizes.push(now, bytes) {
                    screen.activity = Some(Activity {
                        at: now,
                        wall: SystemTime::now(),
                        bytes,
                        epoch: screen.epoch,
                    });
                    screen.units_since_input += 1;
                    screen.generation += 1;
                    notify.send_replace(screen.generation);
                } else {
                    screen.counters.small_units += 1;
                }
            }
            let screen = &mut *screen;
            let decoding = screen.decoding_since.is_some() && screen.decoder_error.is_none();
            (decoding, gap)
        };
        last_seq = Some(packet.sequence_number);
        last_ssrc = Some(packet.ssrc);
        if decoding && !was_decoding {
            depacketizer = HevcDepacketizer::new();
            keyed = false;
            unit.clear();
            last_request = None;
            waiting_since = Some(now);
        }
        was_decoding = decoding;
        if !decoding {
            continue;
        }
        if gap && keyed {
            // The depacketizer would hold everything after the hole, waiting for the lost packet,
            // until 128 packets had piled up: start it again. The decoder keeps going (it
            // conceals what refers to the lost unit); the pictures are marked damaged until a key
            // unit.
            depacketizer = HevcDepacketizer::new();
            unit.clear();
            let mut s = screen.lock().unwrap();
            s.counters.damaging_losses += 1;
            s.damaged_since.get_or_insert(now);
        }
        // Units keep coming but the newest picture grows old: the decoder is far behind or gets
        // nothing it can use. Report it stale, and past RECOVER_AFTER ask for a new session.
        if keyed {
            let mut s = screen.lock().unwrap();
            // Stale (reported, and pictures come from the screenshot service) when the newest
            // picture's unit arrived STALL_AFTER ago: a decoder behind by a backlog is as stale as
            // one that gives nothing.
            let behind = s
                .latest
                .map(|l| l.0)
                .into_iter()
                .chain(keyed_at)
                .max()
                .map(|at| now.duration_since(at));
            if behind.is_some_and(|age| age >= STALL_AFTER) && s.stalled_since.is_none() {
                s.counters.stalls += 1;
                s.stalled_since = Some(now);
                let c = &s.counters;
                let queued = c.units_to_decoder.saturating_sub(c.units_done);
                eprintln!(
                    "{} poki-bridged: live frames: video stalled: newest picture {} ms behind the stream; {queued} units queued, {} in a row gave no picture (no key yet {}, no output {}, errors {})",
                    crate::ax::watch::stamp(),
                    behind.unwrap().as_millis(),
                    c.units_without_picture_run,
                    c.units_before_key,
                    c.units_without_picture,
                    c.decode_errors,
                );
            }
            // A new session only when the decoder gives no pictures at all: a reopen does not
            // make a slow decoder faster, and the new session needs about 1.3 s and its key unit
            // before its first picture (Nov 6: reopening on a backlog reopened every 10 to 15 s).
            let silent = s
                .last_decoded_at
                .into_iter()
                .chain(keyed_at)
                .max()
                .map(|at| now.duration_since(at));
            if silent.is_some_and(|age| age >= RECOVER_AFTER) && !s.restart_requested {
                s.restart_requested = true;
                s.counters.restart_requests += 1;
                eprintln!(
                    "{} poki-bridged: live frames: no picture for {} ms while units arrive; the media session should be reopened",
                    crate::ax::watch::stamp(),
                    silent.unwrap().as_millis()
                );
            }
        }
        // No key unit since decoding started: a new session starts with one. A session's key
        // unit can come over a second after it opens, so this waits FIRST_KEY_WITHIN.
        if !keyed && waiting_since.is_some_and(|at| now.duration_since(at) >= FIRST_KEY_WITHIN) {
            let mut s = screen.lock().unwrap();
            if !s.restart_requested {
                s.restart_requested = true;
                s.counters.restart_requests += 1;
                eprintln!(
                    "{} poki-bridged: live frames: no key unit {} ms after decoding started; the media session should be reopened",
                    crate::ax::watch::stamp(),
                    FIRST_KEY_WITHIN.as_millis()
                );
            }
            s.stalled_since.get_or_insert(now);
        }
        if !keyed
            && decoder_ready.load(Ordering::SeqCst)
            && last_request.is_none_or(|at| at.elapsed() >= Duration::from_secs(1))
        {
            last_request = Some(now);
            fir_seq = fir_seq.wrapping_add(1);
            let request = rtcp::build_keyframe_request(our_ssrc, "poki", packet.ssrc, &[], fir_seq);
            if socket.send_to(SENDER_VIDEO_PORT, request).await.is_ok() {
                screen.lock().unwrap().counters.keyframe_requests += 1;
            }
        }
        depacketizer.push(packet.sequence_number, packet.timestamp, packet.payload);
        unit.extend_from_slice(&depacketizer.take_output());
        if !packet.marker {
            continue;
        }
        // A whole unit. The depacketizer starts the next one with a delimiter, and the decoder is
        // given each unit as one packet, so it needs none to see where this one ends.
        let complete = std::mem::take(&mut unit);
        let key = nal_units(&complete).any(|(_, kind)| (16..=23).contains(&kind));
        if key {
            let mut s = screen.lock().unwrap();
            s.counters.key_units += 1;
            s.damaged_since = None;
        }
        if complete.is_empty() || (!keyed && !key) {
            // An empty packet would tell the decoder the stream ended.
            if !complete.is_empty() {
                screen.lock().unwrap().counters.units_before_key += 1;
            }
            continue;
        }
        if !keyed {
            keyed_at = Some(now);
            waiting_since = None;
        }
        keyed = true;
        screen.lock().unwrap().counters.units_to_decoder += 1;
        if jobs.send(Job::Unit(complete, now)).is_err() {
            return;
        }
    }
}

fn decode_loop(
    queue: mpsc::Receiver<Job>,
    screen: Arc<Mutex<Screen>>,
    notify: Arc<tokio::sync::watch::Sender<u64>>,
    ready: Arc<AtomicBool>,
) {
    // Below the daemon's own work (input, accessibility reads, the tunnel): the decoder's slice
    // threads are made from this thread and inherit it.
    let niceness = lower_priority();
    screen.lock().unwrap().decoder_nice = niceness;
    let mut decoder: Option<libav::Decoder> = None;
    let mut thumbnailer = libav::Thumbnailer::default();
    let mut encoder = libav::JpegEncoder::default();
    let mut latest: Option<(libav::Picture, Instant, SystemTime, u64)> = None;
    let mut previous: Option<Thumb> = None;
    // Units waiting behind the one being decoded. All are decoded, in order: none can be skipped
    // (see RECOVER_AFTER); only the newest of a batch is thumbnailed and compared.
    let mut pending: VecDeque<Job> = VecDeque::new();
    ready.store(true, Ordering::SeqCst);
    loop {
        if pending.is_empty() {
            match queue.recv() {
                Ok(job) => pending.push_back(job),
                Err(_) => break,
            }
        }
        while let Ok(job) = queue.try_recv() {
            pending.push_back(job);
        }
        // The media session closed: its queue is worth nothing, and a new session has its own
        // decoder. (Views of this one may live on and keep the channel open.)
        if screen.lock().unwrap().closed {
            break;
        }
        let job = pending.pop_front().expect("one job");
        let more_units = pending.iter().any(|job| matches!(job, Job::Unit(..)));
        let unit_job = matches!(job, Job::Unit(..));
        match job {
            Job::Flush => {
                if let Some(decoder) = decoder.as_mut() {
                    decoder.flush();
                }
            }
            Job::Jpeg {
                width,
                quality,
                reply,
            } => {
                let started = Instant::now();
                let answer = match &latest {
                    None => Err("no picture decoded yet".to_string()),
                    Some((picture, arrived, wall, epoch)) => encoder
                        .encode(picture, width, quality)
                        .map(|(bytes, width, height)| Jpeg {
                            bytes,
                            width,
                            height,
                            arrived: *arrived,
                            wall: *wall,
                            epoch: *epoch,
                            encode_ms: started.elapsed().as_secs_f64() * 1000.0,
                        }),
                };
                let _ = reply.send(answer);
            }
            Job::Unit(unit, arrived) => 'unit: {
                if decoder.is_none() {
                    match libav::Decoder::hevc() {
                        Ok(made) => decoder = Some(made),
                        Err(error) => {
                            screen.lock().unwrap().decoder_error = Some(error);
                            break 'unit;
                        }
                    }
                }
                let decoder_now = decoder.as_mut().unwrap();
                let work = Instant::now();
                let decoded = decoder_now.decode(&unit);
                let decoded_at = Instant::now();
                {
                    let mut screen = screen.lock().unwrap();
                    let c = &mut screen.counters;
                    c.decode_work_ms_sum += decoded_at.duration_since(work).as_secs_f64() * 1000.0;
                    c.decode_work_units += 1;
                }
                let pictures = match decoded {
                    Ok(pictures) if pictures.is_empty() => {
                        let mut screen = screen.lock().unwrap();
                        screen.counters.units_without_picture += 1;
                        screen.counters.units_without_picture_run += 1;
                        break 'unit;
                    }
                    Ok(pictures) => pictures,
                    Err(error) => {
                        let mut screen = screen.lock().unwrap();
                        screen.counters.decode_errors += 1;
                        screen.counters.last_decode_error = Some(error);
                        break 'unit;
                    }
                };
                for picture in pictures {
                    let wall = SystemTime::now();
                    // Behind: only the newest picture is compared and kept in the ring; its
                    // change region covers the ones skipped.
                    let thumb = (!more_units)
                        .then(|| thumbnailer.gray(&picture, THUMB_WIDTH).ok())
                        .flatten()
                        .map(|(pixels, width, height)| Thumb {
                            arrived,
                            wall,
                            epoch: 0,
                            pixels,
                            width,
                            height,
                        });
                    let difference = match (&previous, &thumb) {
                        (Some(a), Some(b)) => Some(compare(a, b)),
                        (None, Some(_)) => Some(Difference {
                            changed: 1.0,
                            region: Some([0.0, 0.0, 1.0, 1.0]),
                        }),
                        _ => None,
                    };
                    let size = (picture.width(), picture.height());
                    latest = Some((picture, arrived, wall, 0));
                    let mut screen = screen.lock().unwrap();
                    let c = &mut screen.counters;
                    c.decoded += 1;
                    let ms = decoded_at.duration_since(arrived).as_secs_f64() * 1000.0;
                    c.decode_ms_sum += ms;
                    c.decode_ms_max = c.decode_ms_max.max(ms);
                    if screen.first_picture_after_ms.is_none() {
                        screen.first_picture_after_ms = screen
                            .decoding_since
                            .map(|s| decoded_at.duration_since(s).as_millis() as u64);
                    }
                    screen.latest = Some((arrived, wall, size.0, size.1));
                    screen.last_decoded_at = Some(decoded_at);
                    screen.counters.units_without_picture_run = 0;
                    // Only a picture that shows the screen now ends a stall. A reopen asked for
                    // stays asked for until the daemon takes it (take_restart_request).
                    if arrived.elapsed() < STALL_AFTER {
                        screen.stalled_since = None;
                    }
                    screen.epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
                    let epoch = screen.epoch;
                    if let Some(latest) = latest.as_mut() {
                        latest.3 = epoch;
                    }
                    if let Some(difference) = difference
                        && difference.changed > 0.0
                    {
                        screen.counters.changes += 1;
                        // Right after an input, a change counts as in place only inside a region
                        // already animating (a spinner keeps spinning after a no-op tap); the
                        // input's own effect may land where something changed before (deleting
                        // what was typed), and that is movement.
                        let answering = screen
                            .last_input
                            .and_then(|input| arrived.checked_duration_since(input))
                            .is_some_and(|after| after < AFTER_INPUT);
                        let in_place = difference.region.is_some_and(|region| {
                            screen.animations.in_place(arrived, region, answering)
                        });
                        if in_place {
                            screen.counters.in_place_changes += 1;
                        } else {
                            screen.last_change = Some((arrived, difference));
                            screen.last_change_wall = Some(wall);
                            screen.last_change_epoch = Some(epoch);
                        }
                    }
                    if let Some(mut thumb) = thumb {
                        thumb.epoch = epoch;
                        while screen
                            .thumbs
                            .front()
                            .is_some_and(|t| t.arrived.elapsed() > RING)
                        {
                            screen.thumbs.pop_front();
                        }
                        previous = Some(Thumb {
                            pixels: thumb.pixels.clone(),
                            ..thumb
                        });
                        screen.thumbs.push_back(thumb);
                    }
                    screen.generation += 1;
                    notify.send_replace(screen.generation);
                }
            }
        }
        if unit_job {
            // Done with it, picture or not: waiters for a current picture look again.
            let mut screen = screen.lock().unwrap();
            screen.counters.units_done += 1;
            screen.generation += 1;
            notify.send_replace(screen.generation);
        }
    }
}

/// Lowers this thread's CPU priority (POKI_LIVE_DECODE_NICE, default 0 = unchanged: at 10 the
/// decoder fell behind under load on us-light and AX was no faster); the
/// niceness it has now.
fn lower_priority() -> Option<i32> {
    let nice: i32 = std::env::var("POKI_LIVE_DECODE_NICE")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    #[cfg(target_os = "linux")]
    {
        unsafe extern "C" {
            fn gettid() -> i32;
            fn setpriority(which: i32, who: u32, prio: i32) -> i32;
            fn getpriority(which: i32, who: u32) -> i32;
        }
        // PRIO_PROCESS with a thread id sets that thread alone on Linux.
        unsafe {
            let tid = gettid() as u32;
            if nice != 0 {
                setpriority(0, tid, nice.clamp(-20, 19));
            }
            Some(getpriority(0, tid))
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = nice;
        None
    }
}

fn identity(screen: &Screen, seq: u64, captured: SystemTime, width: u32, height: u32) -> Value {
    // Points keep the portrait order; a landscape picture swaps them.
    let landscape = width > height;
    let scale = screen.points.map(|(w, h)| {
        let across = if landscape { w.max(h) } else { w.min(h) };
        (f64::from(width) / across * 1000.0).round() / 1000.0
    });
    json!({
        "generation": screen.session,
        "seq": seq,
        "captured_at": crate::ax::watch::stamp_at(captured),
        "size": [width, height],
        "orientation": if landscape { "landscape" } else { "portrait" },
        "scale": scale,
        "source": "video",
        // A packet was lost since the last key unit: parts of the picture may be wrong.
        "damaged": screen.damaged_since.is_some(),
    })
}

/// NAL unit types in an Annex-B buffer, with their offsets (the start of the start code).
fn nal_units(buf: &[u8]) -> impl Iterator<Item = (usize, u8)> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        while i + 3 < buf.len() {
            if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
                let start = if i > 0 && buf[i - 1] == 0 { i - 1 } else { i };
                let kind = (buf[i + 3] >> 1) & 0x3f;
                i += 3;
                return Some((start, kind));
            }
            i += 1;
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nal_units_are_found_with_three_and_four_byte_start_codes() {
        let buf = [
            0, 0, 0, 1, 0x40, 1, 9, 0, 0, 1, 0x26, 1, 7, 0, 0, 0, 1, 0x02, 1,
        ];
        let units: Vec<_> = nal_units(&buf).collect();
        assert_eq!(units, vec![(0, 32), (7, 19), (13, 1)]);
    }

    fn thumb(pixels: Vec<u8>, width: u32) -> Thumb {
        let height = pixels.len() as u32 / width;
        Thumb {
            arrived: Instant::now(),
            wall: SystemTime::now(),
            epoch: 0,
            pixels,
            width,
            height,
        }
    }

    #[test]
    fn a_difference_names_the_region_that_changed() {
        let mut a = vec![100u8; 10 * 20];
        let b = a.clone();
        assert_eq!(
            compare(&thumb(a.clone(), 10), &thumb(b.clone(), 10)).changed,
            0.0
        );
        // Small noise is not a change.
        a[5] = 108;
        assert_eq!(
            compare(&thumb(a.clone(), 10), &thumb(b.clone(), 10)).region,
            None
        );
        // A block at columns 2-3, rows 10-14.
        for y in 10..15 {
            for x in 2..4 {
                a[y * 10 + x] = 200;
            }
        }
        let d = compare(&thumb(a, 10), &thumb(b, 10));
        assert_eq!(d.changed, 10.0 / 200.0);
        assert_eq!(d.region, Some([0.2, 0.5, 0.2, 0.25]));
    }

    #[test]
    fn a_frame_names_its_session_seq_size_orientation_and_scale() {
        let mut screen = Screen {
            session: 3,
            ..Screen::default()
        };
        let at = SystemTime::UNIX_EPOCH + Duration::from_millis(1500);
        let frame = identity(&screen, 41, at, 1206, 2622);
        assert_eq!(frame["generation"], 3);
        assert_eq!(frame["seq"], 41);
        assert_eq!(frame["captured_at"], "1970-01-01T00:00:01.500Z");
        assert_eq!(frame["orientation"], "portrait");
        assert_eq!(frame["scale"], Value::Null, "unknown before a tree");
        screen.points = Some((402.0, 874.0));
        assert_eq!(identity(&screen, 41, at, 1206, 2622)["scale"], 3.0);
        let wide = identity(&screen, 42, at, 2622, 1206);
        assert_eq!(
            (wide["orientation"].clone(), wide["scale"].clone()),
            (json!("landscape"), json!(3.0))
        );
    }

    /// Decoding cost per unit at the phone's size, with and without the loop filter, and a flood
    /// of units that the decoder cannot keep up with: it drops to the next key unit instead of
    /// queueing, so the newest picture stays young. Prints the costs.
    #[test]
    fn a_burst_is_queued_and_every_unit_decoded() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        let Some(units) = stream_with(60, "testsrc2=size=1216x2656:rate=60", 30) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        for tuning in [
            libav::Tuning {
                threads: 1,
                thread_type: "slice",
                skip_loop_filter: false,
                fast: false,
            },
            libav::Tuning {
                threads: 3,
                thread_type: "slice",
                skip_loop_filter: true,
                fast: true,
            },
            libav::Tuning {
                threads: 2,
                thread_type: "frame",
                skip_loop_filter: true,
                fast: true,
            },
        ] {
            let mut decoder = libav::Decoder::hevc_with(&tuning).unwrap();
            let started = Instant::now();
            let mut pictures = 0;
            for unit in &units {
                pictures += decoder.decode(unit).unwrap().len();
            }
            let held = units.len() - pictures;
            pictures += decoder.finish().unwrap().len();
            let per_unit = started.elapsed().as_secs_f64() * 1000.0 / units.len() as f64;
            println!(
                "{tuning:?}: {per_unit:.1} ms per 1216x2656 unit, {pictures} pictures, {held} held until the end"
            );
            if tuning.thread_type == "slice" {
                assert_eq!(held, 0, "slice threads hold no picture back");
            } else {
                assert!(
                    held < tuning.threads as usize + 1,
                    "frame threads hold back a unit or so"
                );
            }
            assert_eq!(pictures, units.len());
        }
        let screen = fake::FakeScreen::start().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // 60 units at once: a burst the decoder cannot keep up with. The queue absorbs it.
            for unit in &units {
                screen.send_now(unit);
            }
            let sent = Instant::now();
            let counters =
                |f: fn(&Counters) -> u64| f(&screen.live.screen.lock().unwrap().counters);
            while counters(|c| c.decoded) < 60 && sent.elapsed() < Duration::from_secs(20) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            println!(
                "flood of 60: {} decoded, drained in {} ms",
                counters(|c| c.decoded),
                sent.elapsed().as_millis()
            );
            assert_eq!(counters(|c| c.decoded), 60, "every unit is decoded");
            assert_eq!(counters(|c| c.decode_errors), 0);
        });
    }

    #[test]
    fn cpu_time_is_read_for_this_process() {
        assert!(cpu_seconds("self").is_some_and(|s| s >= 0.0));
    }

    /// A phone that is only a UDP queue: the test sends RTP in and sees the RTCP that goes out.
    struct FakeSocket {
        incoming: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
        sent: Mutex<Vec<(u16, Vec<u8>)>>,
    }

    impl Datagrams for Arc<FakeSocket> {
        async fn recv(&self) -> std::io::Result<Vec<u8>> {
            self.incoming
                .lock()
                .await
                .recv()
                .await
                .ok_or_else(|| std::io::Error::other("closed"))
        }
        async fn send_to(&self, port: u16, data: Vec<u8>) -> std::io::Result<()> {
            self.sent.lock().unwrap().push((port, data));
            Ok(())
        }
    }

    /// RTP packets for one access unit as RFC 7798 sends it: small NAL units whole, large ones
    /// as fragmentation units, the marker on the last packet.
    fn packetize(unit: &[u8], seq: &mut u16, timestamp: u32) -> Vec<Vec<u8>> {
        const MTU: usize = 1200;
        let starts: Vec<usize> = nal_units(unit)
            .map(|(at, _)| at)
            .chain([unit.len()])
            .collect();
        let mut payloads = Vec::new();
        for w in starts.windows(2) {
            let mut nal = &unit[w[0]..w[1]];
            while nal.first() == Some(&0) {
                nal = &nal[1..];
            }
            let nal = &nal[1..]; // the 0x01 that ends the start code
            if nal.len() <= MTU {
                payloads.push(nal.to_vec());
                continue;
            }
            let kind = (nal[0] >> 1) & 0x3f;
            let header = [(nal[0] & 0x81) | (49 << 1), nal[1]];
            let body = &nal[2..];
            let chunks: Vec<&[u8]> = body.chunks(MTU).collect();
            for (i, chunk) in chunks.iter().enumerate() {
                let mut fu = kind;
                if i == 0 {
                    fu |= 0x80;
                }
                if i == chunks.len() - 1 {
                    fu |= 0x40;
                }
                let mut payload = header.to_vec();
                payload.push(fu);
                payload.extend_from_slice(chunk);
                payloads.push(payload);
            }
        }
        let count = payloads.len();
        payloads
            .into_iter()
            .enumerate()
            .map(|(i, payload)| {
                let mut packet = vec![0x80, 100 | if i == count - 1 { 0x80 } else { 0 }];
                packet.extend_from_slice(&seq.to_be_bytes());
                packet.extend_from_slice(&timestamp.to_be_bytes());
                packet.extend_from_slice(&0x1234_5678u32.to_be_bytes());
                packet.extend_from_slice(&payload);
                *seq = seq.wrapping_add(1);
                packet
            })
            .collect()
    }

    /// The receive path from RTP datagrams to pictures, with a fake phone: nothing is decoded
    /// before a key frame and a key frame is asked for over RTCP; after a lost packet decoding
    /// goes on (nothing is skipped: the phone may never send another key frame), the pictures
    /// are marked damaged, and the next key unit clears that.
    #[test]
    fn rtp_becomes_pictures_and_a_lost_packet_marks_them_damaged() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        // Key frames at units 0, 10 and 20.
        let Some(units) = stream_with(30, "testsrc2=size=320x640:rate=30", 10) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        let key = |unit: &Vec<u8>| nal_units(unit).any(|(_, kind)| (16..=23).contains(&kind));
        assert!(key(&units[0]) && key(&units[10]) && !key(&units[1]));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                let socket = Arc::new(FakeSocket {
                    incoming: tokio::sync::Mutex::new(rx),
                    sent: Mutex::new(Vec::new()),
                });
                let frames = Frames::over(socket.clone(), 0x5050_4f4b, true);
                let live = frames.live();
                let counters = |f: fn(&Counters) -> u64| f(&live.screen.lock().unwrap().counters);
                // The decoder thread runs at its own pace (slower when other tests run): wait for
                // a count instead of sleeping a fixed time.
                let decoded = async |want: u64| {
                    let started = Instant::now();
                    while counters(|c| c.decoded) < want
                        && started.elapsed() < Duration::from_secs(3)
                    {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    counters(|c| c.decoded)
                };
                // Let the decoder open, so key frame requests can go out.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let (seq, lost_one) = (std::cell::Cell::new(1000u16), std::cell::Cell::new(false));
                let send = async |index: usize, drop_middle: bool| {
                    let mut next = seq.get();
                    let packets = packetize(&units[index], &mut next, index as u32 * 3000);
                    seq.set(next);
                    let middle = packets.len() / 2;
                    for (i, packet) in packets.into_iter().enumerate() {
                        if drop_middle && i == middle && middle > 0 {
                            lost_one.set(true);
                            continue;
                        }
                        tx.send(packet).unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(15)).await;
                };
                // Joining mid-stream: unit 5 is not a key frame.
                send(5, false).await;
                assert_eq!(counters(|c| c.decoded), 0, "nothing before a key frame");
                let requests = |s: &FakeSocket| {
                    s.sent
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(port, data)| *port == SENDER_VIDEO_PORT && rtcp::is_rtcp(data))
                        .count()
                };
                assert_eq!(requests(&socket), 1, "a key frame is asked for");
                {
                    // From the SSRC the offer declared (the phone ignores others), about the
                    // phone's stream: RR's sender SSRC, then PLI's sender and media SSRCs.
                    let sent = socket.sent.lock().unwrap();
                    let request = &sent[0].1;
                    assert_eq!(&request[4..8], &0x5050_4f4bu32.to_be_bytes());
                    let pli = request
                        .windows(2)
                        .position(|w| w == [0x81, 206])
                        .expect("PLI");
                    assert_eq!(&request[pli + 4..pli + 8], &0x5050_4f4bu32.to_be_bytes());
                    assert_eq!(&request[pli + 8..pli + 12], &0x1234_5678u32.to_be_bytes());
                }
                for index in 10..15 {
                    send(index, false).await;
                }
                assert_eq!(decoded(5).await, 5);
                let epoch = live.state(Duration::from_millis(150)).epoch;
                // A packet of unit 15 is lost: unit 15 is gone, 16 to 19 are still decoded.
                send(15, true).await;
                assert!(lost_one.get());
                for index in 16..20 {
                    send(index, false).await;
                }
                assert_eq!(counters(|c| c.lost), 1);
                assert!(decoded(6).await >= 6, "decoding goes on after a loss");
                assert_eq!(counters(|c| c.damaging_losses), 1);
                assert_eq!(live.latest_identity().unwrap()["damaged"], true);
                assert_eq!(
                    requests(&socket),
                    1,
                    "no key frame request: the phone ignores them"
                );
                send(20, false).await;
                assert_eq!(
                    live.latest_identity().unwrap()["damaged"],
                    false,
                    "a key unit clears it"
                );
                for index in 21..25 {
                    send(index, false).await;
                }
                let at_25 = decoded(14).await;
                assert!(at_25 >= 14, "16 to 24 are decoded: {at_25}");
                assert!(live.state(Duration::from_millis(150)).epoch >= epoch + 5);
                let latest = live.state(Duration::from_millis(150)).latest.unwrap();
                assert_eq!((latest.2, latest.3), (320, 640));

                // The phone restarts its sequence numbers (seen after a Wi-Fi to cellular switch):
                // without care the depacketizer drops everything as late duplicates.
                seq.set(7);
                let before = counters(|c| c.decoded);
                for index in 25..30 {
                    send(index, false).await;
                }
                assert_eq!(counters(|c| c.discontinuities), 1);
                assert!(
                    decoded(before + 5).await >= before + 5,
                    "units after the restart are decoded"
                );

                // Packets that never give a picture: a stall, then a request to reopen the
                // session; a picture clears it.
                let junk = |seq: &std::cell::Cell<u16>| {
                    let mut next = seq.get();
                    let packets = packetize(
                        &[0, 0, 0, 1, 0x4e, 0x01, 0x05, 0x01, 0x00, 0x80],
                        &mut next,
                        99,
                    );
                    seq.set(next);
                    packets
                };
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(2200) {
                    for packet in junk(&seq) {
                        tx.send(packet).unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                assert!(counters(|c| c.stalls) >= 1);
                assert!(
                    live.state(Duration::ZERO).stalled_since.is_some(),
                    "stalled"
                );
                // Nov 6: a picture that came out meanwhile cleared the request before the daemon
                // took it, so the reopen was asked for again and again and never done. It stays
                // asked for until taken.
                let after = counters(|c| c.decoded);
                send(0, false).await;
                decoded(after + 1).await;
                assert!(
                    live.state(Duration::ZERO).stalled_since.is_none(),
                    "a current picture ends the stall"
                );
                assert!(
                    live.take_restart_request(),
                    "the reopen is still asked for after a picture"
                );
                assert!(!live.take_restart_request(), "taken once");
                drop(tx);
            });
    }

    /// The packet clock with nothing decoded, on a phone that streams small units on a still
    /// screen: those do not count as movement once the idle baseline is known; bigger units do;
    /// quiet after them is settled; an input followed by idle units only changed nothing.
    #[test]
    fn unit_sizes_are_the_clock_without_decoding() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                let socket = Arc::new(FakeSocket {
                    incoming: tokio::sync::Mutex::new(rx),
                    sent: Mutex::new(Vec::new()),
                });
                let frames = Frames::over(socket.clone(), 1, false);
                let live = frames.live();
                let settle = Duration::from_millis(80);
                let seq = Arc::new(Mutex::new(1u16));
                // Nothing is decoded, so any bytes do; only the size matters.
                let unit = |size: usize| {
                    let mut nal = vec![0, 0, 0, 1, 0x02, 0x01];
                    nal.resize(size, 0xab);
                    let mut seq = seq.lock().unwrap();
                    for packet in packetize(&nal, &mut seq, 0) {
                        tx.send(packet).unwrap();
                    }
                };
                // Idle: 60 small units a second, all along.
                let idle = {
                    let (tx, seq) = (tx.clone(), seq.clone());
                    tokio::spawn(async move {
                        loop {
                            let mut nal = vec![0, 0, 0, 1, 0x02, 0x01];
                            nal.resize(40, 0);
                            for packet in packetize(&nal, &mut seq.lock().unwrap(), 0) {
                                let _ = tx.send(packet);
                            }
                            tokio::time::sleep(Duration::from_millis(16)).await;
                        }
                    })
                };
                tokio::time::sleep(Duration::from_millis(300)).await;
                assert!(
                    live.state(settle).moving,
                    "no baseline yet: every unit counts"
                );
                #[cfg(target_os = "linux")]
                if std::env::var("POKI_LIVE_DECODE_NICE").is_err() {
                    assert!(live.screen.lock().unwrap().decoder_nice.is_some());
                }
                tokio::time::sleep(Duration::from_millis(1000)).await;
                assert!(live.wait_settled(settle, Duration::from_millis(500)).await);
                let state = live.state(settle);
                assert!(!state.moving && !state.decoding && state.picture_current);
                assert!(
                    state.latest.is_none(),
                    "settled with no picture: nothing is decoded"
                );
                let threshold = live.screen.lock().unwrap().sizes.threshold();
                assert!((40..400).contains(&threshold), "threshold {threshold}");

                // An input that moves the screen: bigger units.
                let started = Instant::now();
                live.note_input();
                for _ in 0..4 {
                    unit(3000);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                let state = live.state(settle);
                assert!(state.moving && !state.settled);
                assert_eq!(state.changed_since_input, Some(true));
                assert!(state.units_since_input >= 4);
                assert!(!live.unchanged_since(started));
                // The response comes in two steps with a 200 ms lull between: not settled in
                // the lull, settled only settle_after_change() after the second step.
                let waiting = {
                    let live = live.clone();
                    tokio::spawn(async move {
                        let settled = live.wait_settled(settle, Duration::from_secs(3)).await;
                        (settled, Instant::now())
                    })
                };
                tokio::time::sleep(Duration::from_millis(200)).await;
                for _ in 0..4 {
                    unit(3000);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                let second_step = Instant::now();
                let (settled, at) = waiting.await.unwrap();
                assert!(settled);
                let after = at.duration_since(second_step);
                assert!(
                    after >= settle_after_change(),
                    "settled {after:?} after the second step"
                );
                assert!(after < Duration::from_millis(1000), "{after:?}");

                // An input followed by idle units only: quiet right after an input proves
                // nothing (apps take a moment to react), so it settles as unchanged only after
                // the no-response time.
                let input = Instant::now();
                live.note_input();
                tokio::time::sleep(Duration::from_millis(200)).await;
                assert!(
                    !live.state(settle).settled,
                    "too early to call it unchanged"
                );
                assert!(live.wait_settled(settle, Duration::from_secs(1)).await);
                let waited = input.elapsed();
                assert!(
                    waited >= no_response_time() && waited < Duration::from_millis(800),
                    "{waited:?}"
                );
                let state = live.state(settle);
                assert_eq!(state.changed_since_input, Some(false));
                assert_eq!(state.units_since_input, 0);
                assert!(live.unchanged_since(input + Duration::from_millis(1)));
                idle.abort();
                drop(tx);
            });
    }

    #[test]
    fn a_screenshot_png_becomes_a_jpeg() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        let Some(path) = fake::draw(
            "shot",
            "1206x2622",
            "drawbox=x=100:y=200:w=300:h=80:c=black:t=fill",
        ) else {
            println!("skipped: ffmpeg cannot draw here");
            return;
        };
        let png = std::fs::read(path).unwrap();
        let started = Instant::now();
        let (jpeg, width, height, source_width, source_height) =
            libav::png_to_jpeg(&png, 600, 5).unwrap();
        println!(
            "png {} bytes to jpeg {} bytes in {} ms",
            png.len(),
            jpeg.len(),
            started.elapsed().as_millis()
        );
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        assert_eq!((source_width, source_height), (1206, 2622));
        assert_eq!(width, 600);
        assert!((1300..=1306).contains(&height));
    }

    #[test]
    fn a_change_that_repeats_in_place_is_not_movement() {
        let mut animations = Animations::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let spinner = [0.80, 0.30, 0.04, 0.02];
        // The first second of a spinner is movement: nothing says yet that it repeats.
        assert!(!animations.in_place(at(0), spinner, false));
        for ms in (50..600).step_by(50) {
            assert!(!animations.in_place(at(ms), spinner, false), "{ms} ms");
        }
        assert!(animations.in_place(at(650), spinner, false));
        assert!(animations.in_place(at(1000), [0.801, 0.301, 0.038, 0.019], false));
        let region = animations.region(at(1000)).unwrap();
        assert!(contains(spinner, region, 0.001));
        // Right after an input: the spinner going on is still in place (a no-op tap), but a
        // change that only touches it is not (a backspace next to a blinking caret).
        assert!(animations.in_place(at(1005), spinner, true));
        assert!(!animations.in_place(at(1006), [0.78, 0.30, 0.06, 0.02], true));
        // Elsewhere, once: movement, however small (a typed character).
        assert!(!animations.in_place(at(1010), [0.10, 0.50, 0.01, 0.01], false));
        // Reaching outside the spinner's box: movement.
        assert!(!animations.in_place(at(1020), [0.70, 0.30, 0.14, 0.02], false));
        // A large region that keeps changing is movement too (a video, a scroll).
        let mut large = Animations::default();
        for ms in (0..2000).step_by(50) {
            assert!(!large.in_place(at(ms), [0.0, 0.2, 1.0, 0.5], false));
        }
        assert!(animations.region(at(3000)).is_none(), "gone after a second");
        assert_eq!(animating_json(Some(spinner))["pct"], 0.1);
    }

    #[test]
    fn the_idle_baseline_is_a_low_percentile_of_recent_sizes() {
        let mut sizes = UnitSizes::new(None, None);
        let start = Instant::now();
        assert!(sizes.push(start, 10), "before a baseline every unit counts");
        // 1.5 s of small units with a few big ones among them.
        for i in 1..90u64 {
            let bytes = if i % 10 == 0 {
                5000
            } else {
                50 + (i % 3) as usize
            };
            sizes.push(start + Duration::from_millis(i * 16), bytes);
        }
        assert_eq!(sizes.baseline, Some(50));
        assert_eq!(sizes.threshold(), 132);
        let now = start + Duration::from_millis(1500);
        assert!(!sizes.push(now, 60));
        assert!(sizes.push(now, 500));
        assert!(sizes.average(now).is_some_and(|avg| avg > 50));
        let fixed = UnitSizes::new(Some(700), None);
        assert_eq!(fixed.threshold(), 700);
    }

    /// A fresh media session as the phone opens one: over a second of units that are not key
    /// units (decoding joined mid-stream), then the session's key unit and a steady 60 units a
    /// second. No stall and no reopen is asked for, and the pictures keep up.
    #[test]
    fn a_fresh_session_waits_for_its_key_unit_without_asking_for_a_reopen() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        let Some(units) = stream_with(120, "testsrc2=size=320x640:rate=60", 60) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                let socket = Arc::new(FakeSocket {
                    incoming: tokio::sync::Mutex::new(rx),
                    sent: Mutex::new(Vec::new()),
                });
                let frames = Frames::over(socket.clone(), 7, true);
                let live = frames.live();
                let mut seq = 500u16;
                let mut send = |index: usize| {
                    for packet in packetize(&units[index], &mut seq, index as u32 * 1500) {
                        tx.send(packet).unwrap();
                    }
                };
                // 1.3 s of the stream before the key unit.
                for round in 0..78 {
                    send(61 + round % 59);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                assert!(!live.take_restart_request(), "1.3 s without a key unit is normal");
                let first_key = Instant::now();
                for index in 0..60 {
                    send(index);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                let screen = live.screen.lock().unwrap();
                let c = &screen.counters;
                println!(
                    "fresh session: {} decoded, {} before key, {} stalls, picture age {:?} after {:?}",
                    c.decoded,
                    c.units_before_key,
                    c.stalls,
                    screen.latest.map(|l| l.0.elapsed()),
                    first_key.elapsed()
                );
                assert_eq!(c.decoded, 60);
                assert!(c.units_before_key >= 70);
                assert_eq!(c.stalls, 0, "no stall once pictures come");
                assert!(!screen.restart_requested, "no reopen asked for");
                drop(screen);
                drop(tx);
            });
    }

    #[test]
    fn closing_the_old_session_does_not_stop_the_new_sessions_decoder() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        let Some(units) = stream_with(30, "testsrc2=size=320x640:rate=60", 60) else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let open = || {
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                    let socket = Arc::new(FakeSocket {
                        incoming: tokio::sync::Mutex::new(rx),
                        sent: Mutex::new(Vec::new()),
                    });
                    (Frames::over(socket, 7, true), tx)
                };
                let send = |tx: &tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
                            seq: &mut u16,
                            index: usize| {
                    for packet in packetize(&units[index], seq, index as u32 * 1500) {
                        tx.send(packet).unwrap();
                    }
                };
                let (old, old_tx) = open();
                let old_live = old.live();
                let mut seq = 10u16;
                for index in 0..10 {
                    send(&old_tx, &mut seq, index);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                // The reopen: the new session opens, then the old one closes (a view of it lives on).
                let (new, new_tx) = open();
                let new_live = new.live();
                drop(old);
                let mut seq = 900u16;
                for index in 0..30 {
                    send(&new_tx, &mut seq, index);
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                assert!(old_live.screen.lock().unwrap().closed);
                let screen = new_live.screen.lock().unwrap();
                assert!(!screen.closed);
                assert_eq!(screen.counters.decoded, 30, "the new decoder runs on");
                drop(screen);
                drop((new, new_tx, old_tx));
            });
    }

    /// An x265 stream like the phone's (no B-frames, delimiters), split into access units.
    fn stream(frames: u32, source: &str) -> Option<Vec<Vec<u8>>> {
        stream_with(frames, source, 60)
    }

    fn stream_with(frames: u32, source: &str, keyint: u32) -> Option<Vec<Vec<u8>>> {
        let dir = std::env::temp_dir().join(format!("poki-frames-{}-{frames}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let file = dir.join("screen.hevc");
        let made = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                source,
            ])
            .args([
                "-frames:v",
                &frames.to_string(),
                "-c:v",
                "libx265",
                "-x265-params",
            ])
            .arg(format!("bframes=0:keyint={keyint}:min-keyint={keyint}:scenecut=0:aud=1:repeat-headers=1:log-level=none"))
            .args(["-f", "hevc"])
            .arg(&file)
            .status();
        let stream = std::fs::read(&file).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if !made.is_ok_and(|s| s.success()) {
            return None;
        }
        let stream = stream?;
        let starts: Vec<usize> = nal_units(&stream)
            .filter(|(_, kind)| *kind == 35)
            .map(|(at, _)| at)
            .chain([stream.len()])
            .collect();
        Some(
            starts
                .windows(2)
                .map(|w| stream[w[0]..w[1]].to_vec())
                .collect(),
        )
    }

    /// The decoder thread as the daemon runs it: every unit gives its picture at once (no frame
    /// of delay), changes are seen, a still screen settles, and a JPEG of the latest picture is
    /// made on request. Prints decode and encode times. Skipped without libavcodec or libx265.
    #[test]
    fn units_decode_at_once_and_a_still_screen_settles() {
        if let Err(error) = libav::available() {
            println!("skipped: {error}");
            return;
        }
        let Some(moving) = stream(30, "testsrc2=size=1206x2622:rate=30") else {
            println!("skipped: ffmpeg cannot encode HEVC here");
            return;
        };
        assert_eq!(moving.len(), 30);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let screen = Arc::new(Mutex::new(Screen {
                    decoding_since: Some(Instant::now()),
                    ..Screen::default()
                }));
                let (jobs, queue) = mpsc::channel();
                let (notify, changed) = tokio::sync::watch::channel(0u64);
                let notify = Arc::new(notify);
                let thread = {
                    let (screen, notify) = (screen.clone(), notify.clone());
                    let ready = Arc::new(AtomicBool::new(false));
                    std::thread::Builder::new()
                        .name("poki-frames".into())
                        .spawn(move || decode_loop(queue, screen, notify, ready))
                        .unwrap()
                };
                let live = Live {
                    screen: screen.clone(),
                    jobs: jobs.clone(),
                    changed,
                    notify,
                };
                let settle = Duration::from_millis(150);
                let mark = live.mark();
                let mut waits = Vec::new();
                for unit in &moving {
                    let before = screen.lock().unwrap().counters.decoded;
                    let sent = Instant::now();
                    jobs.send(Job::Unit(unit.clone(), sent)).unwrap();
                    while screen.lock().unwrap().counters.decoded == before {
                        assert!(
                            sent.elapsed() < Duration::from_secs(2),
                            "a unit did not give its picture"
                        );
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    waits.push(sent.elapsed().as_secs_f64() * 1000.0);
                    assert!(!live.state(settle).settled, "moving");
                    tokio::time::sleep(Duration::from_millis(33)).await;
                }
                let report = live.report(&mark);
                println!("1206x2622 HEVC at 30 fps: {report}");
                waits.sort_by(f64::total_cmp);
                println!(
                    "unit in to picture out: median {:.1} ms, max {:.1} ms",
                    waits[15], waits[29]
                );
                assert_eq!(report["totals"]["changes"], 30);
                // Nothing more arrives: settled once the settle time has passed since the change.
                let started = Instant::now();
                assert!(live.wait_settled(settle, Duration::from_secs(2)).await);
                let waited = started.elapsed().as_millis();
                println!("settled {waited} ms after the last picture was decoded");
                assert!(waited < 200, "{waited} ms");
                // An input unsettles it.
                live.note_input();
                assert!(!live.state(settle).settled);
                for width in [600, 1206] {
                    let jpeg = live.jpeg(width, 5).await.unwrap();
                    println!(
                        "JPEG {}x{}: {} bytes in {:.1} ms",
                        jpeg.width,
                        jpeg.height,
                        jpeg.bytes.len(),
                        jpeg.encode_ms
                    );
                    assert_eq!(&jpeg.bytes[..2], &[0xff, 0xd8]);
                    assert_eq!(jpeg.width, width & !1);
                }
                let (difference, _, _) = live
                    .diff(Duration::from_millis(900), Duration::ZERO)
                    .unwrap();
                assert!(difference.changed > 0.0);
                drop(live);
                drop(jobs);
                thread.join().unwrap();
            });
    }
}

/// A screen fed with encoded pictures instead of the phone's stream, for tests of what reacts to
/// the screen (prefetch, type_text's fast return). It runs the daemon's own decoder thread.
#[cfg(test)]
pub mod fake {
    use super::*;

    pub struct FakeScreen {
        pub live: Live,
        jobs: mpsc::Sender<Job>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeScreen {
        /// None without libavcodec.
        pub fn start() -> Option<Self> {
            libav::available().ok()?;
            let screen = Arc::new(Mutex::new(Screen {
                decoding_since: Some(Instant::now()),
                ..Screen::default()
            }));
            let (jobs, queue) = mpsc::channel();
            let (notify, changed) = tokio::sync::watch::channel(0u64);
            let notify = Arc::new(notify);
            let thread = {
                let (screen, notify) = (screen.clone(), notify.clone());
                let ready = Arc::new(AtomicBool::new(false));
                std::thread::Builder::new()
                    .name("poki-frames".into())
                    .spawn(move || decode_loop(queue, screen, notify, ready))
                    .ok()?
            };
            Some(Self {
                live: Live {
                    screen,
                    jobs: jobs.clone(),
                    changed,
                    notify,
                },
                jobs,
                thread: Some(thread),
            })
        }

        /// Sends one access unit as if it had just arrived, without waiting.
        pub fn send_now(&self, unit: &[u8]) {
            self.jobs
                .send(Job::Unit(unit.to_vec(), Instant::now()))
                .unwrap();
        }

        /// Sends one access unit and waits for its picture.
        pub async fn show(&self, unit: &[u8]) {
            let before = self.live.screen.lock().unwrap().counters.decoded;
            let sent = Instant::now();
            self.jobs.send(Job::Unit(unit.to_vec(), sent)).unwrap();
            while self.live.screen.lock().unwrap().counters.decoded == before {
                assert!(sent.elapsed() < Duration::from_secs(2), "no picture");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }

    impl Drop for FakeScreen {
        fn drop(&mut self) {
            // The decoder thread ends once every Live clone is gone.
            self.live.screen.lock().unwrap().closed = true;
            self.thread.take();
        }
    }

    /// A picture drawn by ffmpeg: a white `size` screen with the `draw` filters on it. None without
    /// ffmpeg (or its drawtext).
    pub fn draw(name: &str, size: &str, draw: &str) -> Option<std::path::PathBuf> {
        let path =
            std::env::temp_dir().join(format!("poki-fake-{}-{name}.png", std::process::id()));
        let made = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg(format!("color=c=white:s={size}"))
            .args(["-vf", draw, "-frames:v", "1"])
            .arg(&path)
            .status();
        made.is_ok_and(|s| s.success()).then_some(path)
    }

    /// The pictures as an HEVC stream like the phone's, one access unit per picture. None
    /// without ffmpeg and libx265.
    pub fn encode(pictures: &[std::path::PathBuf]) -> Option<Vec<Vec<u8>>> {
        let dir = std::env::temp_dir().join(format!(
            "poki-fake-{}-{}",
            std::process::id(),
            pictures.len()
        ));
        std::fs::create_dir_all(&dir).ok()?;
        for (i, picture) in pictures.iter().enumerate() {
            std::fs::copy(picture, dir.join(format!("{i:03}.png"))).ok()?;
        }
        let file = dir.join("screen.hevc");
        let made = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-framerate",
                "30",
                "-i",
            ])
            .arg(dir.join("%03d.png"))
            .args(["-c:v", "libx265", "-pix_fmt", "yuv420p", "-x265-params"])
            .arg("bframes=0:keyint=1:aud=1:repeat-headers=1:log-level=none")
            .args(["-f", "hevc"])
            .arg(&file)
            .status();
        let stream = std::fs::read(&file).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if !made.is_ok_and(|s| s.success()) {
            return None;
        }
        let stream = stream?;
        let starts: Vec<usize> = nal_units(&stream)
            .filter(|(_, kind)| *kind == 35)
            .map(|(at, _)| at)
            .chain([stream.len()])
            .collect();
        Some(
            starts
                .windows(2)
                .map(|w| stream[w[0]..w[1]].to_vec())
                .collect(),
        )
    }
}

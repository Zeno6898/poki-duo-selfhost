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
        screen.generation += 1;
        self.notify.send_replace(screen.generation);
    }

    pub fn decoding(&self) -> bool {
        self.screen.lock().unwrap().decoding_since.is_some()
    }

    pub fn error(&self) -> Option<String> {
        self.screen.lock().unwrap().decoder_error.clone()
    }

    pub fn state(&self, settle: Duration) -> State {
        let screen = self.screen.lock().unwrap();
        let quiet_since = [screen.last_change.map(|(at, _)| at), screen.last_input]
            .into_iter()
            .flatten()
            .max()
            .or(screen.decoding_since);
        State {
            settled: screen.latest.is_some() && quiet_since.is_none_or(|at| at.elapsed() >= settle),
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
        let deadline = tokio::time::Instant::now() + timeout;
        let mut changed = self.changed.clone();
        loop {
            changed.mark_unchanged();
            let state = self.state(settle);
            if state.settled {
                return true;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            // Wake when the quiet time would end, or at the next picture or input.
            let until = state
                .quiet_since
                .map_or(deadline, |at| tokio::time::Instant::from_std(at + settle))
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
        screen.last_change.is_none_or(|(changed, _)| changed <= at)
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
        json!({
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
                "units_without_picture": c.units_without_picture,
                "units_without_picture_run": c.units_without_picture_run,
                "max_unit_gap_ms": c.max_unit_gap_ms,
                "decode_ms_max": (c.decode_ms_max * 100.0).round() / 100.0,
                "first_picture_after_ms": screen.first_picture_after_ms,
            },
            "ms_since_last_packet": since(c.last_packet),
        })
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
/// sends no packets).
const STALL_AFTER: Duration = Duration::from_millis(500);
/// After a key frame request, how long to wait for a key unit before asking for a new session.
const KEY_WITHIN: Duration = Duration::from_millis(1200);

async fn receive<S: Datagrams>(
    socket: Arc<S>,
    screen: Arc<Mutex<Screen>>,
    jobs: mpsc::Sender<Job>,
    decoder_ready: Arc<AtomicBool>,
    our_ssrc: u32,
) {
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
            if packet.marker {
                c.units += 1;
                if let Some(last) = c.last_unit {
                    let gap_ms = now.duration_since(last).as_millis() as u64;
                    c.max_unit_gap_ms = c.max_unit_gap_ms.max(gap_ms);
                }
                c.last_unit = Some(now);
            }
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
            // A lost packet spoils the pictures that refer to it: start again at a key frame.
            // The depacketizer too: it would hold everything after the hole, waiting for the lost
            // packet, until 128 packets had piled up.
            depacketizer = HevcDepacketizer::new();
            keyed = false;
            last_request = None;
            unit.clear();
            waiting_since = Some(now);
            let _ = jobs.send(Job::Flush);
            screen.lock().unwrap().stalled_since.get_or_insert(now);
        }
        // Packets keep coming but no picture: whatever the decoder waits for is not coming.
        // Start again from a key frame.
        if keyed {
            let mut s = screen.lock().unwrap();
            let progress = s.last_decoded_at.into_iter().chain(keyed_at).max();
            if progress.is_some_and(|at| now.duration_since(at) >= STALL_AFTER) {
                s.counters.stalls += 1;
                s.stalled_since.get_or_insert(now);
                let run = s.counters.units_without_picture_run;
                drop(s);
                eprintln!(
                    "{} poki-bridged: live frames: video stalled: packets arrive but no picture for {} ms ({run} units in a row gave none); asking for a key frame",
                    crate::ax::watch::stamp(),
                    STALL_AFTER.as_millis()
                );
                depacketizer = HevcDepacketizer::new();
                keyed = false;
                last_request = None;
                unit.clear();
                waiting_since = Some(now);
                let _ = jobs.send(Job::Flush);
            }
        }
        // A key frame was asked for and none came: the session itself is stuck.
        if !keyed
            && last_request.is_some()
            && waiting_since.is_some_and(|at| now.duration_since(at) >= KEY_WITHIN)
        {
            let mut s = screen.lock().unwrap();
            if !s.restart_requested {
                s.restart_requested = true;
                s.counters.restart_requests += 1;
                eprintln!(
                    "{} poki-bridged: live frames: no key frame {} ms after asking; the media session should be reopened",
                    crate::ax::watch::stamp(),
                    KEY_WITHIN.as_millis()
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
            screen.lock().unwrap().counters.key_units += 1;
        }
        if complete.is_empty() || (!keyed && !key) {
            // An empty packet would tell the decoder the stream ended.
            continue;
        }
        if !keyed {
            keyed_at = Some(now);
            waiting_since = None;
        }
        keyed = true;
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
    let mut decoder: Option<libav::Decoder> = None;
    let mut thumbnailer = libav::Thumbnailer::default();
    let mut encoder = libav::JpegEncoder::default();
    let mut latest: Option<(libav::Picture, Instant, SystemTime, u64)> = None;
    let mut previous: Option<Thumb> = None;
    ready.store(true, Ordering::SeqCst);
    while let Ok(job) = queue.recv() {
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
            Job::Unit(unit, arrived) => {
                if decoder.is_none() {
                    match libav::Decoder::hevc() {
                        Ok(made) => decoder = Some(made),
                        Err(error) => {
                            screen.lock().unwrap().decoder_error = Some(error);
                            continue;
                        }
                    }
                }
                let decoded = decoder.as_mut().unwrap().decode(&unit);
                let decoded_at = Instant::now();
                let pictures = match decoded {
                    Ok(pictures) if pictures.is_empty() => {
                        let mut screen = screen.lock().unwrap();
                        screen.counters.units_without_picture += 1;
                        screen.counters.units_without_picture_run += 1;
                        continue;
                    }
                    Ok(pictures) => pictures,
                    Err(error) => {
                        let mut screen = screen.lock().unwrap();
                        screen.counters.decode_errors += 1;
                        screen.counters.last_decode_error = Some(error);
                        continue;
                    }
                };
                for picture in pictures {
                    let wall = SystemTime::now();
                    let thumb = thumbnailer.gray(&picture, THUMB_WIDTH).ok().map(
                        |(pixels, width, height)| Thumb {
                            arrived,
                            wall,
                            epoch: 0,
                            pixels,
                            width,
                            height,
                        },
                    );
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
                    screen.stalled_since = None;
                    screen.restart_requested = false;
                    screen.epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
                    let epoch = screen.epoch;
                    if let Some(latest) = latest.as_mut() {
                        latest.3 = epoch;
                    }
                    if let Some(difference) = difference
                        && difference.changed > 0.0
                    {
                        screen.counters.changes += 1;
                        screen.last_change = Some((arrived, difference));
                        screen.last_change_wall = Some(wall);
                        screen.last_change_epoch = Some(epoch);
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
    /// before a key frame and a key frame is asked for over RTCP; a lost packet flushes, asks
    /// again and skips to the next key frame; pictures resume there.
    #[test]
    fn rtp_becomes_pictures_and_a_lost_packet_waits_for_the_next_key_frame() {
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
                // A packet of unit 15 is lost: 15 to 19 refer to it and are skipped.
                send(15, true).await;
                assert!(lost_one.get());
                for index in 16..20 {
                    send(index, false).await;
                }
                assert_eq!(counters(|c| c.lost), 1);
                assert_eq!(
                    counters(|c| c.decoded),
                    5,
                    "nothing until the next key frame"
                );
                assert!(requests(&socket) >= 2, "a key frame is asked for again");
                for index in 20..25 {
                    send(index, false).await;
                }
                assert_eq!(decoded(10).await, 10);
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
                send(0, false).await;
                assert_eq!(
                    decoded(before + 1).await,
                    before + 1,
                    "decodes again from the key frame"
                );

                // Packets that never give a picture: a stall, then a key frame request, then a
                // request to reopen the session; a key frame clears it.
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
                let requests_before = requests(&socket);
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
                assert!(
                    requests(&socket) > requests_before,
                    "a key frame is asked for"
                );
                assert!(
                    live.take_restart_request(),
                    "the session should be reopened"
                );
                let after = counters(|c| c.decoded);
                send(0, false).await;
                decoded(after + 1).await;
                assert!(
                    live.state(Duration::ZERO).stalled_since.is_none(),
                    "a picture clears it"
                );
                drop(tx);
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

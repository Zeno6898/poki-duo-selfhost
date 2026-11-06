//! See main.rs. Usage:
//!   poki-live-frames --host IP --rp-pairing-file PATH [--rp-host-name NAME] < plan.json > stream.hevc
//! plan.json: {"seconds": 30, "hold_input_at_s": 10, "taps_at_s": [15, 20], "tap": [6000, 1200]}
//! Every field is optional; without input fields the run only reads.

use super::*;
use idevice::core_device::{HevcDepacketizer, RtpPacket};
use std::io::Write;
use std::time::Instant;

#[derive(serde::Deserialize, Default)]
struct Plan {
    #[serde(default = "thirty")]
    seconds: u64,
    hold_input_at_s: Option<u64>,
    #[serde(default)]
    taps_at_s: Vec<u64>,
    tap: Option<(u16, u16)>,
}

fn thirty() -> u64 {
    30
}

fn event(start: Instant, value: Value) {
    let mut value = value;
    value["t_ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
    eprintln!("{value}");
}

// HEVC NAL types 16..=21 are IRAP (keyframe) slices; 32..=34 are VPS/SPS/PPS.
fn nal_types(annexb: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut i = 0;
    while i + 3 < annexb.len() {
        if annexb[i] == 0 && annexb[i + 1] == 0 && annexb[i + 2] == 1 {
            types.push((annexb[i + 3] >> 1) & 0x3f);
            i += 3;
        } else {
            i += 1;
        }
    }
    types
}

pub fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("{}", json!({"event": "error", "error": error.to_string()}));
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let target = parse_args(&args)?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let plan: Plan = if input.trim().is_empty() {
        Plan::default()
    } else {
        serde_json::from_str(&input)?
    };
    let plan = Plan {
        seconds: plan.seconds.max(1),
        ..plan
    };
    let start = Instant::now();
    let mut device = connect_device(&target).await?;
    event(start, json!({"event": "connected"}));
    let media = stream::start_screen_media_stream(&mut device.adapter, &mut device.rsd, 1)
        .await
        .map_err(|e| format!("Cannot establish media session: {e}"))?;
    event(start, json!({"event": "media_started"}));
    let stream::ScreenMediaStream {
        mut client,
        audio_udp,
        video_udp,
    } = media;
    let audio = tokio::spawn(async move { while audio_udp.recv().await.is_ok() {} });

    let mut out = std::io::BufWriter::new(std::io::stdout());
    let mut depacketizer = HevcDepacketizer::new();
    let (mut packets, mut units, mut unit_bytes, mut unit_packets) = (0u64, 0u64, 0usize, 0u64);
    let mut touch: Option<Touch> = None;
    let mut taps = plan.taps_at_s.clone();
    taps.sort();
    let mut taps = taps.into_iter().peekable();
    let deadline = start + Duration::from_secs(plan.seconds);
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let elapsed = now.duration_since(start).as_secs();
        if touch.is_none() && plan.hold_input_at_s.is_some_and(|at| elapsed >= at) {
            touch = Some(Touch::connect_rsd(&mut device.adapter, &mut device.rsd).await?);
            event(start, json!({"event": "input_held"}));
        }
        if let (Some(&at), Some(hid), Some((x, y))) = (taps.peek(), touch.as_mut(), plan.tap) {
            if elapsed >= at {
                taps.next();
                held_tap(hid, x, y, 50).await?;
                event(start, json!({"event": "tap_sent", "x": x, "y": y}));
            }
        }
        let wait = deadline
            .saturating_duration_since(now)
            .min(Duration::from_millis(200));
        match tokio::time::timeout(wait, video_udp.recv()).await {
            Err(_) => continue,
            Ok(Err(error)) => {
                event(
                    start,
                    json!({"event": "stream_error", "error": format!("{error:?}")}),
                );
                break;
            }
            Ok(Ok(datagram)) => {
                let Some(packet) = RtpPacket::parse(&datagram.data) else {
                    continue;
                };
                packets += 1;
                unit_packets += 1;
                depacketizer.push(packet.sequence_number, packet.timestamp, packet.payload);
                let annexb = depacketizer.take_output();
                if !annexb.is_empty() {
                    unit_bytes += annexb.len();
                    let types = nal_types(&annexb);
                    if out.write_all(&annexb).is_err() {
                        break;
                    }
                    let _ = out.flush();
                    if packet.marker {
                        units += 1;
                        let key = types.iter().any(|t| (16..=21).contains(t));
                        event(
                            start,
                            json!({"event": "unit", "rtp_ts": packet.timestamp, "bytes": unit_bytes, "packets": unit_packets, "key": key, "nal": types}),
                        );
                        unit_bytes = 0;
                        unit_packets = 0;
                    }
                }
            }
        }
    }
    event(
        start,
        json!({"event": "done", "packets": packets, "units": units}),
    );
    drop(touch);
    let _ = client.stop_media_stream().await;
    audio.abort();
    Ok(())
}

//! stream.rs's `start_screen_media_stream`, for the daemon (fork-only), returning the SSRC that the
//! video offer declares. The daemon sends RTCP key frame requests, and the phone takes feedback
//! only from the SSRC it was offered; a random one is ignored (seen Nov 6: 196 requests, no key
//! frame). stream.rs itself is unchanged, so poki-native behaves as before.
// Source: jkcoxson/idevice tools/src/coredevice_stream.rs at 8970209; MIT license.
// Jackson Coxson
use super::super::stream::ScreenMediaStream;
use idevice::{
    RsdService,
    core_device::{
        CallInfoBlob, DisplayServiceClient, build_screen_audio_offer, build_screen_video_offer,
        build_start_audio_parameters, build_start_video_parameters,
    },
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};

const CLIENT_SUPPORTED_FEATURES: u64 = 140;

pub async fn start(
    adapter: &mut AdapterHandle,
    handshake: &mut RsdHandshake,
    display_id: i64,
) -> Result<(ScreenMediaStream, u32), String> {
    macro_rules! log {
        ($($arg:tt)*) => {{}};
    }

    let mut client = DisplayServiceClient::connect_rsd(adapter, handshake)
        .await
        .map_err(|e| format!("no display service: {e:?}"))?;

    let audio_udp = adapter
        .bind_udp(0)
        .await
        .map_err(|e| format!("bind_udp(audio) failed: {e:?}"))?;
    let video_udp = adapter
        .bind_udp(0)
        .await
        .map_err(|e| format!("bind_udp(video) failed: {e:?}"))?;
    let receiver_ip = adapter.host_ip().to_string();
    let audio_receiver_port = audio_udp.local_port();
    let receiver_port = video_udp.local_port();
    // The device is the sender; the host (controller) assigns its endpoint too.
    let sender_ip = adapter.peer_ip().to_string();
    log!("video receiver = {receiver_ip}:{receiver_port}, sender = {sender_ip}");

    // VCCallInfoBlob describing this (host) endpoint. The string values mirror a
    // captured Device Hub offer the device accepted.
    let call_info = CallInfoBlob {
        call_id: 0,
        client_version: 1,
        device_type: "Mac17,7".into(),
        framework_version: "2205.3.1".into(),
        os_version: "25F71".into(),
        device_name: None,
        audio_device_uid: None,
    };

    // The screen-sharing session is keyed by clientSessionID; both the audio and
    // video streams share it.
    let client_session_id = uuid::Uuid::new_v4();

    // Start the audio stream first to establish the screen-sharing session.
    let audio_call_id = uuid::Uuid::new_v4().to_string().to_uppercase();
    let audio_offer = build_screen_audio_offer(&audio_call_id, &call_info)
        .map_err(|e| format!("audio offer build failed: {e:?}"))?;
    let audio_params = build_start_audio_parameters(
        &receiver_ip,
        audio_receiver_port,
        &sender_ip,
        50000,
        audio_offer,
        CLIENT_SUPPORTED_FEATURES,
        client_session_id,
    );
    client
        .start_media_stream(audio_params)
        .await
        .map_err(|e| format!("audio startMediaStream failed: {e:?}"))?;
    log!("audio stream started (session {client_session_id})");

    // Start the video stream on the same session.
    let call_id = uuid::Uuid::new_v4().to_string().to_uppercase();
    // SSRC declared in the offer (field 5.1); must match the RTCP sender SSRC if
    // sending feedback. The daemon sends key frame requests, so it is returned.
    let our_ssrc = uuid::Uuid::new_v4().as_u128() as u32;
    let offer = build_screen_video_offer(&call_id, &call_info, our_ssrc)
        .map_err(|e| format!("video offer build failed: {e:?}"))?;
    let params = build_start_video_parameters(
        &receiver_ip,
        receiver_port,
        &sender_ip,
        50001,
        offer,
        CLIENT_SUPPORTED_FEATURES,
        display_id,
        client_session_id,
    );
    let _answer = client
        .start_media_stream(params)
        .await
        .map_err(|e| format!("video startMediaStream failed: {e:?}"))?;
    log!("video stream started (session {client_session_id})");

    Ok((
        ScreenMediaStream {
            client,
            audio_udp,
            video_udp,
        },
        our_ssrc,
    ))
}

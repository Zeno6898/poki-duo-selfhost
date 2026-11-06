//! FFmpeg's libavcodec and libswscale, loaded when first needed (fork-only, workstream J1).
//!
//! They are opened with `dlopen` rather than linked, so the crate needs no FFmpeg headers to build
//! and poki-native is not affected. The runtime image installs them with `ffmpeg`. Only functions
//! whose signatures have not changed across libavcodec 58 to 61 are used, and only the leading
//! fields of `AVPacket` and `AVFrame`, which have kept their layout over those versions. Codec
//! context settings go through the AVOptions API instead of struct fields.
//!
//! libavcodec is used directly because the `ffmpeg` program holds each decoded frame until the
//! next one arrives, so the last frame of a still screen would never come out.
#![allow(non_camel_case_types)]

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::OnceLock;

type P = *mut c_void;

unsafe extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> P;
    fn dlsym(handle: P, symbol: *const c_char) -> P;
    fn dlerror() -> *const c_char;
}
const RTLD_NOW: c_int = 2;

/// The leading fields of `AVPacket`.
#[repr(C)]
struct PacketHead {
    buf: P,
    pts: i64,
    dts: i64,
    data: *mut u8,
    size: c_int,
}

/// The leading fields of `AVFrame`.
#[repr(C)]
struct FrameHead {
    data: [*mut u8; 8],
    linesize: [c_int; 8],
    extended_data: P,
    width: c_int,
    height: c_int,
    nb_samples: c_int,
    format: c_int,
}

macro_rules! api {
    ($($name:ident: fn($($arg:ty),*) -> $ret:ty = $symbol:literal in $lib:ident;)*) => {
        struct Api { $($name: unsafe extern "C" fn($($arg),*) -> $ret,)* }
        impl Api {
            unsafe fn load(codec: P, scale: P) -> Result<Self, String> {
                Ok(Self { $($name: {
                    let handle = match stringify!($lib) { "scale" => scale, _ => codec };
                    let symbol = CString::new($symbol).unwrap();
                    let found = unsafe { dlsym(handle, symbol.as_ptr()) };
                    if found.is_null() {
                        return Err(format!("{} is missing", $symbol));
                    }
                    unsafe { std::mem::transmute::<P, unsafe extern "C" fn($($arg),*) -> $ret>(found) }
                },)* })
            }
        }
    };
}

api! {
    find_decoder_by_name: fn(*const c_char) -> P = "avcodec_find_decoder_by_name" in codec;
    find_encoder_by_name: fn(*const c_char) -> P = "avcodec_find_encoder_by_name" in codec;
    alloc_context3: fn(P) -> P = "avcodec_alloc_context3" in codec;
    open2: fn(P, P, *mut P) -> c_int = "avcodec_open2" in codec;
    free_context: fn(*mut P) -> () = "avcodec_free_context" in codec;
    send_packet: fn(P, P) -> c_int = "avcodec_send_packet" in codec;
    receive_frame: fn(P, P) -> c_int = "avcodec_receive_frame" in codec;
    send_frame: fn(P, P) -> c_int = "avcodec_send_frame" in codec;
    receive_packet: fn(P, P) -> c_int = "avcodec_receive_packet" in codec;
    flush_buffers: fn(P) -> () = "avcodec_flush_buffers" in codec;
    packet_alloc: fn() -> P = "av_packet_alloc" in codec;
    packet_free: fn(*mut P) -> () = "av_packet_free" in codec;
    packet_unref: fn(P) -> () = "av_packet_unref" in codec;
    new_packet: fn(P, c_int) -> c_int = "av_new_packet" in codec;
    frame_alloc: fn() -> P = "av_frame_alloc" in codec;
    frame_free: fn(*mut P) -> () = "av_frame_free" in codec;
    frame_unref: fn(P) -> () = "av_frame_unref" in codec;
    frame_ref: fn(P, P) -> c_int = "av_frame_ref" in codec;
    frame_get_buffer: fn(P, c_int) -> c_int = "av_frame_get_buffer" in codec;
    opt_set: fn(P, *const c_char, *const c_char, c_int) -> c_int = "av_opt_set" in codec;
    get_pix_fmt: fn(*const c_char) -> c_int = "av_get_pix_fmt" in codec;
    log_set_level: fn(c_int) -> () = "av_log_set_level" in codec;
    sws_get_context: fn(c_int, c_int, c_int, c_int, c_int, c_int, c_int, P, P, *const f64) -> P = "sws_getContext" in scale;
    sws_scale: fn(P, *const *const u8, *const c_int, c_int, c_int, *const *mut u8, *const c_int) -> c_int = "sws_scale" in scale;
    sws_free: fn(P) -> () = "sws_freeContext" in scale;
}

fn open_first(names: &[&str]) -> Result<P, String> {
    let mut errors = Vec::new();
    for name in names {
        let file = CString::new(*name).unwrap();
        let handle = unsafe { dlopen(file.as_ptr(), RTLD_NOW) };
        if !handle.is_null() {
            return Ok(handle);
        }
        let error = unsafe { dlerror() };
        if !error.is_null() {
            errors.push(
                unsafe { CStr::from_ptr(error) }
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    Err(format!("cannot load {}: {}", names[0], errors.join("; ")))
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let codec = open_first(&[
            "libavcodec.so.61",
            "libavcodec.so.60",
            "libavcodec.so.59",
            "libavcodec.so.58",
            "libavcodec.so",
        ])?;
        let scale = open_first(&[
            "libswscale.so.8",
            "libswscale.so.7",
            "libswscale.so.6",
            "libswscale.so.5",
            "libswscale.so",
        ])?;
        let api = unsafe { Api::load(codec, scale) }?;
        // Quiet: a decode error is counted by the caller, not printed into the daemon log.
        unsafe { (api.log_set_level)(8) };
        Ok(api)
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Whether libavcodec and libswscale can be loaded here.
pub fn available() -> Result<(), String> {
    api().map(|_| ())
}

fn set(context: P, key: &str, value: &str) -> Result<(), String> {
    let api = api()?;
    let (k, v) = (CString::new(key).unwrap(), CString::new(value).unwrap());
    let code = unsafe { (api.opt_set)(context, k.as_ptr(), v.as_ptr(), 1) };
    if code < 0 {
        return Err(format!("cannot set {key}={value} ({code})"));
    }
    Ok(())
}

fn pix_fmt(name: &str) -> Result<c_int, String> {
    let name_c = CString::new(name).unwrap();
    let format = unsafe { (api()?.get_pix_fmt)(name_c.as_ptr()) };
    if format < 0 {
        return Err(format!("no pixel format {name}"));
    }
    Ok(format)
}

/// A decoded picture, held by reference.
pub struct Picture(P);

impl Picture {
    fn head(&self) -> &FrameHead {
        unsafe { &*(self.0 as *const FrameHead) }
    }
    pub fn width(&self) -> u32 {
        self.head().width as u32
    }
    pub fn height(&self) -> u32 {
        self.head().height as u32
    }
}

impl Drop for Picture {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.frame_free)(&mut self.0) };
        }
    }
}

/// How much decoding work to spend per picture.
#[derive(Clone, Debug)]
pub struct Tuning {
    pub threads: u32,
    /// "slice" (default) or "frame": frame threads raise throughput when one picture takes
    /// longer than a unit interval, at one unit of delay per extra thread. The phone sends units
    /// even on a still screen, so a held picture comes out with the next one.
    pub thread_type: &'static str,
    pub skip_loop_filter: bool,
    pub fast: bool,
}

impl Tuning {
    /// POKI_LIVE_DECODE_THREADS (default 3), POKI_LIVE_LOOP_FILTER=1 keeps the loop filter,
    /// POKI_LIVE_DECODE_FAST=0 turns flags2 +fast off, POKI_LIVE_THREAD_TYPE=frame uses frame
    /// threads (try with POKI_LIVE_DECODE_THREADS=2).
    pub fn from_env() -> Self {
        Self {
            threads: std::env::var("POKI_LIVE_DECODE_THREADS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3)
                .clamp(1, 16),
            thread_type: match std::env::var("POKI_LIVE_THREAD_TYPE").as_deref() {
                Ok("frame") => "frame",
                _ => "slice",
            },
            skip_loop_filter: std::env::var("POKI_LIVE_LOOP_FILTER").as_deref() != Ok("1"),
            fast: std::env::var("POKI_LIVE_DECODE_FAST").as_deref() != Ok("0"),
        }
    }
}

/// An HEVC decoder that returns every picture as soon as its access unit is in.
pub struct Decoder {
    context: P,
    packet: P,
    frame: P,
}

impl Decoder {
    pub fn hevc() -> Result<Self, String> {
        Self::hevc_with(&Tuning::from_env())
    }

    pub fn hevc_with(tuning: &Tuning) -> Result<Self, String> {
        let api = api()?;
        let name = CString::new("hevc").unwrap();
        let codec = unsafe { (api.find_decoder_by_name)(name.as_ptr()) };
        if codec.is_null() {
            return Err("libavcodec has no HEVC decoder".into());
        }
        let mut context = unsafe { (api.alloc_context3)(codec) };
        // Slice threads by default: frame threading adds a unit of delay per thread, and holds
        // the last pictures until more units come.
        let threads = tuning.threads.to_string();
        let configured = set(context, "threads", &threads)
            .and_then(|()| set(context, "thread_type", tuning.thread_type))
            // libavcodec turns frame threading off under low_delay.
            .and_then(|()| {
                if tuning.thread_type == "frame" {
                    Ok(())
                } else {
                    set(context, "flags", "+low_delay")
                }
            })
            .and_then(|()| {
                if tuning.fast {
                    set(context, "flags2", "+fast")
                } else {
                    Ok(())
                }
            })
            .and_then(|()| {
                if tuning.skip_loop_filter {
                    // Deblocking and SAO are a large part of HEVC decoding; without them edges
                    // show faint blocks, which a screen agent does not need.
                    set(context, "skip_loop_filter", "all")
                } else {
                    Ok(())
                }
            });
        let opened = configured.and_then(|()| {
            let code = unsafe { (api.open2)(context, codec, std::ptr::null_mut()) };
            if code < 0 {
                Err(format!("cannot open the HEVC decoder ({code})"))
            } else {
                Ok(())
            }
        });
        if let Err(error) = opened {
            unsafe { (api.free_context)(&mut context) };
            return Err(error);
        }
        Ok(Self {
            context,
            packet: unsafe { (api.packet_alloc)() },
            frame: unsafe { (api.frame_alloc)() },
        })
    }

    /// A still-image decoder ("png" for the screenshot service's pictures), with no options.
    pub fn image(name: &str) -> Result<Self, String> {
        let api = api()?;
        let codec_name = CString::new(name).unwrap();
        let codec = unsafe { (api.find_decoder_by_name)(codec_name.as_ptr()) };
        if codec.is_null() {
            return Err(format!("libavcodec has no {name} decoder"));
        }
        let mut context = unsafe { (api.alloc_context3)(codec) };
        let code = unsafe { (api.open2)(context, codec, std::ptr::null_mut()) };
        if code < 0 {
            unsafe { (api.free_context)(&mut context) };
            return Err(format!("cannot open the {name} decoder ({code})"));
        }
        Ok(Self {
            context,
            packet: unsafe { (api.packet_alloc)() },
            frame: unsafe { (api.frame_alloc)() },
        })
    }

    /// Decodes one access unit (Annex-B); the pictures it completes, usually one.
    pub fn decode(&mut self, unit: &[u8]) -> Result<Vec<Picture>, String> {
        let api = api()?;
        unsafe {
            if (api.new_packet)(self.packet, unit.len() as c_int) < 0 {
                return Err("out of memory".into());
            }
            let head = &mut *(self.packet as *mut PacketHead);
            std::ptr::copy_nonoverlapping(unit.as_ptr(), head.data, unit.len());
            let sent = (api.send_packet)(self.context, self.packet);
            (api.packet_unref)(self.packet);
            let mut pictures = Vec::new();
            while (api.receive_frame)(self.context, self.frame) == 0 {
                let picture = (api.frame_alloc)();
                (api.frame_ref)(picture, self.frame);
                (api.frame_unref)(self.frame);
                pictures.push(Picture(picture));
            }
            if sent < 0 && pictures.is_empty() {
                return Err(format!("decode error {sent}"));
            }
            Ok(pictures)
        }
    }

    /// Tells the decoder the input ended; the pictures it still held.
    pub fn finish(&mut self) -> Result<Vec<Picture>, String> {
        let api = api()?;
        unsafe {
            (api.send_packet)(self.context, std::ptr::null_mut());
            let mut pictures = Vec::new();
            while (api.receive_frame)(self.context, self.frame) == 0 {
                let picture = (api.frame_alloc)();
                (api.frame_ref)(picture, self.frame);
                (api.frame_unref)(self.frame);
                pictures.push(Picture(picture));
            }
            Ok(pictures)
        }
    }

    /// Forgets the reference pictures, after a gap in the stream.
    pub fn flush(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.flush_buffers)(self.context) };
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe {
                (api.frame_free)(&mut self.frame);
                (api.packet_free)(&mut self.packet);
                (api.free_context)(&mut self.context);
            }
        }
    }
}

/// A cached scaler from one picture size and format to another.
struct Scaler {
    key: (c_int, c_int, c_int, c_int, c_int, c_int),
    context: P,
}

impl Scaler {
    fn get(
        slot: &mut Option<Scaler>,
        from: &FrameHead,
        width: c_int,
        height: c_int,
        format: c_int,
    ) -> Result<P, String> {
        let key = (from.width, from.height, from.format, width, height, format);
        if slot.as_ref().is_none_or(|s| s.key != key) {
            let api = api()?;
            // SWS_AREA (0x20): good for strong downscaling.
            let context = unsafe {
                (api.sws_get_context)(
                    from.width,
                    from.height,
                    from.format,
                    width,
                    height,
                    format,
                    0x20,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            if context.is_null() {
                return Err("cannot scale this picture".into());
            }
            *slot = Some(Scaler { key, context });
        }
        Ok(slot.as_ref().unwrap().context)
    }
}

impl Drop for Scaler {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.sws_free)(self.context) };
        }
    }
}

/// Small grayscale copies of pictures, for comparing them.
#[derive(Default)]
pub struct Thumbnailer {
    scaler: Option<Scaler>,
}

impl Thumbnailer {
    /// The picture as `width` columns of 8-bit gray, keeping its aspect; (pixels, width, height).
    pub fn gray(&mut self, picture: &Picture, width: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let api = api()?;
        let from = picture.head();
        let height = ((from.height as u64 * width as u64) / from.width.max(1) as u64).max(1) as u32;
        let scaler = Scaler::get(
            &mut self.scaler,
            from,
            width as c_int,
            height as c_int,
            pix_fmt("gray")?,
        )?;
        let mut pixels = vec![0u8; (width * height) as usize];
        let destination = [
            pixels.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ];
        let strides = [width as c_int, 0, 0, 0];
        unsafe {
            (api.sws_scale)(
                scaler,
                from.data.as_ptr() as *const *const u8,
                from.linesize.as_ptr(),
                0,
                from.height,
                destination.as_ptr(),
                strides.as_ptr(),
            );
        }
        Ok((pixels, width, height))
    }
}

/// A PNG (the screenshot service's) as a JPEG `width` wide at `quality`: (jpeg, width, height,
/// the PNG's width and height).
pub fn png_to_jpeg(
    png: &[u8],
    width: u32,
    quality: u32,
) -> Result<(Vec<u8>, u32, u32, u32, u32), String> {
    let mut decoder = Decoder::image("png")?;
    let mut pictures = decoder.decode(png)?;
    if pictures.is_empty() {
        // A still-image decoder may hold its picture until told the input ended.
        pictures = decoder.finish()?;
    }
    let picture = pictures.pop().ok_or("the PNG gave no picture")?;
    let (source_width, source_height) = (picture.width(), picture.height());
    let (jpeg, width, height) = JpegEncoder::default().encode(&picture, width, quality)?;
    Ok((jpeg, width, height, source_width, source_height))
}

/// A JPEG encoder for pictures, scaled to a width.
#[derive(Default)]
pub struct JpegEncoder {
    scaler: Option<Scaler>,
    encoder: Option<(P, (u32, u32, u32))>,
}

impl JpegEncoder {
    /// The picture as a JPEG `width` pixels wide (even, at most the picture's width), at `quality`
    /// (2 best, 31 worst); (bytes, width, height).
    pub fn encode(
        &mut self,
        picture: &Picture,
        width: u32,
        quality: u32,
    ) -> Result<(Vec<u8>, u32, u32), String> {
        let api = api()?;
        let from = picture.head();
        let width = (width.min(from.width as u32).max(2)) & !1;
        let height =
            (((from.height as u64 * width as u64) / from.width.max(1) as u64) as u32).max(2) & !1;
        let format = pix_fmt("yuvj420p")?;
        if self
            .encoder
            .as_ref()
            .is_none_or(|(_, key)| *key != (width, height, quality))
        {
            self.close();
            let name = CString::new("mjpeg").unwrap();
            let codec = unsafe { (api.find_encoder_by_name)(name.as_ptr()) };
            if codec.is_null() {
                return Err("libavcodec has no MJPEG encoder".into());
            }
            let mut context = unsafe { (api.alloc_context3)(codec) };
            let configured = set(context, "video_size", &format!("{width}x{height}"))
                .and_then(|()| set(context, "pixel_format", "yuvj420p"))
                .and_then(|()| set(context, "time_base", "1/30"))
                .and_then(|()| set(context, "flags", "+qscale"))
                .and_then(|()| set(context, "global_quality", &(quality * 118).to_string()))
                .and_then(|()| {
                    let code = unsafe { (api.open2)(context, codec, std::ptr::null_mut()) };
                    if code < 0 {
                        Err(format!("cannot open the JPEG encoder ({code})"))
                    } else {
                        Ok(())
                    }
                });
            if let Err(error) = configured {
                unsafe { (api.free_context)(&mut context) };
                return Err(error);
            }
            self.encoder = Some((context, (width, height, quality)));
        }
        let context = self.encoder.as_ref().unwrap().0;
        let scaler = Scaler::get(
            &mut self.scaler,
            from,
            width as c_int,
            height as c_int,
            format,
        )?;
        unsafe {
            let mut frame = (api.frame_alloc)();
            let head = &mut *(frame as *mut FrameHead);
            head.width = width as c_int;
            head.height = height as c_int;
            head.format = format;
            let result = (|| {
                if (api.frame_get_buffer)(frame, 0) < 0 {
                    return Err("out of memory".to_string());
                }
                let head = &*(frame as *const FrameHead);
                (api.sws_scale)(
                    scaler,
                    from.data.as_ptr() as *const *const u8,
                    from.linesize.as_ptr(),
                    0,
                    from.height,
                    head.data.as_ptr(),
                    head.linesize.as_ptr(),
                );
                let code = (api.send_frame)(context, frame);
                if code < 0 {
                    return Err(format!("JPEG encode error {code}"));
                }
                let packet = (api.packet_alloc)();
                let mut packet_slot = packet;
                let code = (api.receive_packet)(context, packet);
                let bytes = if code == 0 {
                    let head = &*(packet as *const PacketHead);
                    Ok(std::slice::from_raw_parts(head.data, head.size as usize).to_vec())
                } else {
                    Err(format!("JPEG encode error {code}"))
                };
                (api.packet_free)(&mut packet_slot);
                bytes
            })();
            (api.frame_free)(&mut frame);
            result.map(|bytes| (bytes, width, height))
        }
    }

    fn close(&mut self) {
        if let Some((mut context, _)) = self.encoder.take()
            && let Ok(api) = api()
        {
            unsafe { (api.free_context)(&mut context) };
        }
    }
}

impl Drop for JpegEncoder {
    fn drop(&mut self) {
        self.close();
    }
}

# Open-source notices

The root AGPL-3.0-only license covers original Poki MCP contributions. Third-party code retains its respective copyright notices and license terms.

## idevice

Poki MCP uses [jkcoxson/idevice](https://github.com/jkcoxson/idevice) at commit `89702099f4d7552f704f93b4526756abda319ceb`, downloaded by setup into `.deps/idevice`. The upstream library and command-line tools are MIT licensed. The complete notice is retained in [native/bridge/LICENSE.idevice](native/bridge/LICENSE.idevice).

[native/bridge/src/stream.rs](native/bridge/src/stream.rs) adapts code from the pinned upstream [tools/src/coredevice_stream.rs](https://github.com/jkcoxson/idevice/blob/89702099f4d7552f704f93b4526756abda319ceb/tools/src/coredevice_stream.rs). The rest of the bridge calls upstream protocol APIs. The pinned [upstream license](https://github.com/jkcoxson/idevice/blob/89702099f4d7552f704f93b4526756abda319ceb/LICENSE.txt) remains applicable to that code.

[native/bridge/src/pasteboard.rs](native/bridge/src/pasteboard.rs) also references the pinned upstream [pasteboard service protocol](https://github.com/jkcoxson/idevice/blob/89702099f4d7552f704f93b4526756abda319ceb/idevice/src/services/core_device/pasteboard_service.rs). Poki builds the upstream `idevice-tools` and `idevice_id` executables during setup; their dependencies are listed separately from those of Poki's native bridge in the [dependency inventory](docs/third-party-dependencies.md).

## Meta idb

The simulator adapter's XPC, accessibility, and HID wire-format work references [facebook/idb](https://github.com/facebook/idb) at commit `5c1044388339006c798c5a6c3c267816e6808297`. The complete MIT notice is retained in [native/LICENSE.idb](native/LICENSE.idb).

Relevant protocol and interface references at that revision include:

- [SimulatorDigitizerHIDTransport.swift](https://github.com/facebook/idb/blob/5c1044388339006c798c5a6c3c267816e6808297/FBSimulatorControl/HID/SimulatorDigitizerHIDTransport.swift), for the digitizer service transport.
- [SimulatorIndigoHID.swift](https://github.com/facebook/idb/blob/5c1044388339006c798c5a6c3c267816e6808297/FBSimulatorControl/HID/SimulatorIndigoHID.swift) and [SimulatorPurpleHID.swift](https://github.com/facebook/idb/blob/5c1044388339006c798c5a6c3c267816e6808297/FBSimulatorControl/HID/SimulatorPurpleHID.swift), for event formats and workspace messages.
- [AccessibilityClient.m](https://github.com/facebook/idb/blob/5c1044388339006c798c5a6c3c267816e6808297/SimulatorFrameworkBridge/Runtime/AccessibilityClient.m) and [AXPTranslatorRequest.h](https://github.com/facebook/idb/blob/5c1044388339006c798c5a6c3c267816e6808297/PrivateHeaders/AccessibilityPlatformTranslation/AXPTranslatorRequest.h), for the accessibility transport and request interface.

Poki MCP's simulator helper is a local implementation using these protocol references. It does not bundle the idb executable or Apple frameworks. The idb license is retained to preserve attribution for the referenced implementation and interfaces.

## BlueBubbles Server

The optional `bin/setup-channels` command downloads the unmodified [BlueBubbles Server 1.9.12](https://github.com/BlueBubblesApp/bluebubbles-server/releases/tag/v1.9.12) release from BlueBubblesApp. BlueBubbles is licensed under Apache-2.0; its complete upstream license is retained in [docs/licenses/BlueBubbles-LICENSE](docs/licenses/BlueBubbles-LICENSE). Its packaged dependencies retain their respective notices. The installer pins the official release asset's SHA-256 digest and preserves the app bundle, including its third-party notices. The application archive is not stored in this repository.

## Appium WebDriverAgent

The on-phone runner is built from [appium/WebDriverAgent](https://github.com/appium/WebDriverAgent) v16.15.3 (commit `02cb92f0e93c8b021443bcbb8eeb80932c113220`), vendored as a git submodule at [native/ios-runner/WebDriverAgent](native/ios-runner/WebDriverAgent). WebDriverAgent is BSD-3-Clause licensed (Copyright (c) 2015-present, Facebook, Inc.); its complete license is in the submodule's [LICENSE](https://github.com/appium/WebDriverAgent/blob/02cb92f0e93c8b021443bcbb8eeb80932c113220/LICENSE) and is shipped unchanged with the source. Poki's build only adds branding (icon, display name, launch screen) to the built app; WebDriverAgent's code is not modified.

## JavaScript packages

The exact installed versions come from `package-lock.json`. These packages provide the MCP server/client transports, image processing, input validation and property lists:

| Repository | Packages and locked versions | License |
| --- | --- | --- |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | `@modelcontextprotocol/client`, `core`, `server` 2.4.0; `@modelcontextprotocol/node` 2.1.2 | Package metadata declares Apache-2.0. The upstream license also retains MIT for contributions without relicensing consent; its complete text is preserved in [third_party/LICENSE.typescript-sdk](third_party/LICENSE.typescript-sdk). |
| [sharp](https://github.com/lovell/sharp/tree/e0624568686516209c434de2d3c0ef6688f0811d) | `sharp` and applicable `@img/sharp-*` packages 0.34.5 | Apache-2.0; full text in [third_party/LICENSE.sharp](third_party/LICENSE.sharp). |
| [Zod](https://github.com/colinhacks/zod/tree/b500a2ee95134f81d74da7911d7378dd2853d042) | `zod` 4.6.7 | MIT; full text in [third_party/LICENSE.zod](third_party/LICENSE.zod). |
| [plist.js](https://github.com/TooTallNate/plist.js) | `plist` 5.0.0, with `@xmldom/xmldom` 0.9.12 and `xmlbuilder` 15.1.1 | MIT; full text in [third_party/LICENSE.plist](third_party/LICENSE.plist). Used off macOS in place of `plutil`. |

The [dependency inventory](docs/third-party-dependencies.md#npm-packages) names every locked npm package, its source repository, declared license and platform conditions. It includes transitive packages such as Hono, EventSource, jose and cross-spawn.

## libvips and bundled image libraries

`npm ci` selects sharp's prebuilt packages for the installing machine. On macOS arm64, `@img/sharp-libvips-darwin-arm64` 1.2.4 supplies libvips 8.17.3 and its bundled image libraries. The package is distributed by [sharp-libvips at commit 20b5e899954907a3039d6e3d4c200aaa0ec52c4c](https://github.com/lovell/sharp-libvips/tree/20b5e899954907a3039d6e3d4c200aaa0ec52c4c), with LGPL-3.0-or-later package metadata. Its components retain their own licenses.

The upstream component notices are retained in [third_party/NOTICE.sharp-libvips.md](third_party/NOTICE.sharp-libvips.md). The [bundle inventory](docs/third-party-dependencies.md#image-libraries-in-the-macos-arm64-libvips-package) lists the versions reported by that package, source repositories and component terms. This includes libvips, libheif, libexif, librsvg, GLib, Pango, Cairo, FreeType, libpng, libwebp and the other reported libraries.

## Rust packages

The native bridge directly depends on [Tokio](https://github.com/tokio-rs/tokio), [Serde](https://github.com/serde-rs/serde), [serde_json](https://github.com/serde-rs/json), [rust-plist](https://github.com/ebarnard/rust-plist), [futures-util](https://github.com/rust-lang/futures-rs), [uuid](https://github.com/uuid-rs/uuid) and idevice. Their licenses and those of every resolved normal/build dependency in the macOS arm64 graphs are listed in the [Rust inventory](docs/third-party-dependencies.md#rust-packages). It identifies packages used by the bridge, the upstream tools, or both. Cryptographic and other bundled code retains the notices supplied by its owning crate; the combined AWS-LC, BoringSSL and OpenSSL terms from the checked `aws-lc-sys` packages are also retained in [third_party/LICENSE.aws-lc](third_party/LICENSE.aws-lc).

## External open-source tools

Setup and runtime invoke these separately installed tools. Their versions and build options are chosen by the installing environment.

| Repository | Use | License |
| --- | --- | --- |
| [Node.js](https://github.com/nodejs/node) | JavaScript runtime, Node.js 24 or newer | MIT and included third-party notices |
| [npm CLI](https://github.com/npm/cli) | Install locked JavaScript packages and run build scripts | Artistic-2.0 and included dependency notices |
| [Rust](https://github.com/rust-lang/rust), [Cargo](https://github.com/rust-lang/cargo) | Compile the native bridge and idevice tools | MIT OR Apache-2.0 and included third-party notices |
| [CPython](https://github.com/python/cpython) | Device discovery and the optional unlock script | PSF-2.0 and included third-party notices |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Encode and inspect recordings with `ffmpeg` and `ffprobe` | LGPL-2.1-or-later by default; GPL and other terms depend on the installed build. Run `ffmpeg -L` for that build's terms. |
| [Git](https://github.com/git/git) | Download and check the pinned idevice checkout during setup | GPL-2.0-only and included third-party notices |

## Linux OCR helper

On Linux, `bin/build-native` (through `bin/build-ocr-linux`) installs the Python packages pinned in [native/ocr-requirements.txt](native/ocr-requirements.txt) into `build/ocr-venv`, and `build/ocr` becomes a launcher for [native/ocr.py](native/ocr.py). On macOS `build/ocr` is still the Vision helper built from `native/ocr.swift`, and none of these packages are installed. The packages are downloaded from PyPI at build time and are not committed here.

| Repository | Packages and pinned versions | License |
| --- | --- | --- |
| [RapidOCR](https://github.com/RapidAI/RapidOCR) | `rapidocr` 3.10.0 | Apache-2.0. The wheel retains its `LICENSE` and `MODEL_LICENSES.md`. |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) models, as converted to ONNX and bundled in the `rapidocr` wheel | `PP-OCRv6_det_small`, `PP-OCRv6_rec_small`, `ch_ppocr_mobile_v2.0_cls` | Apache-2.0; copyright in the weights stays with Baidu and the PaddleOCR rights holders, as recorded in the wheel's `MODEL_LICENSES.md`. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | `onnxruntime` 1.31.1 | MIT, with the third-party notices shipped in the wheel. |
| [OpenCV](https://github.com/opencv/opencv-python) | `opencv-python-headless` 5.0.0.93 | Apache-2.0 for OpenCV; the wheel's bundled libraries keep their own notices. |
| [NumPy](https://github.com/numpy/numpy) | `numpy` 2.4.6 | BSD-3-Clause, with bundled-library notices in the wheel. |
| [Pillow](https://github.com/python-pillow/Pillow) | `pillow` 13.0.0 | MIT-CMU (HPND). |
| [Shapely](https://github.com/shapely/shapely), [pyclipper](https://github.com/fonttools/pyclipper) | `shapely` 2.2.0, `pyclipper` 1.4.0 | BSD-3-Clause; MIT (pyclipper bundles Clipper, BSL-1.0). |
| [OmegaConf](https://github.com/omry/omegaconf), [PyYAML](https://github.com/yaml/pyyaml), [Protocol Buffers](https://github.com/protocolbuffers/protobuf), [FlatBuffers](https://github.com/google/flatbuffers) | `omegaconf` 2.4.0, `PyYAML` 6.0.3, `protobuf` 7.36.2, `flatbuffers` 25.12.19 | BSD-3-Clause; MIT; BSD-3-Clause; Apache-2.0. |
| [Requests](https://github.com/psf/requests), [urllib3](https://github.com/urllib3/urllib3), [idna](https://github.com/kjd/idna), [charset-normalizer](https://github.com/jawah/charset_normalizer), [certifi](https://github.com/certifi/python-certifi) | `requests` 2.34.2, `urllib3` 2.8.0, `idna` 3.20, `charset-normalizer` 3.5.2, `certifi` 2026.10.23 | Apache-2.0; MIT; BSD-3-Clause; MIT; MPL-2.0 (certifi's CA bundle, unmodified). |
| [tqdm](https://github.com/tqdm/tqdm), [colorlog](https://github.com/borntyping/python-colorlog), [six](https://github.com/benjaminp/six), [packaging](https://github.com/pypa/packaging) | `tqdm` 4.70.1, `colorlog` 6.12.0, `six` 1.17.0, `packaging` 26.3 | MPL-2.0 AND MIT; MIT; MIT; Apache-2.0 OR BSD-2-Clause. |

The Requests stack, tqdm and colorlog are RapidOCR install requirements; `native/ocr.py` uses the bundled models and makes no network requests. The OCR test fixture [test/fixtures/ocr-zh-en.png](test/fixtures/ocr-zh-en.png) is synthetic text rendered by [test/fixtures/make-ocr-fixture.py](test/fixtures/make-ocr-fixture.py) with WenQuanYi Zen Hei (GPL-2.0-or-later with the font embedding exception); the font itself is not committed.

## Distribution scope

This repository contains source code and the retained notices above. Setup downloads npm packages and builds idevice locally. Precompiled dependency bundles and the external tools are not committed here. A binary distribution must also retain the notices and satisfy the terms of the components actually included in that distribution. Poki's AGPL-3.0-only license does not replace any component's license.

The prebuilt macOS package includes the native bridge, OCR and simulator helpers, the unlock helper, and idevice tools. See [idevice release build notes](third_party/idevice-release.md) for the diagnostic-path replacement, reproduction commands, and dependency installation boundary. Rust dependency license texts shipped with the binary package are under `third_party/rust-licenses/`.

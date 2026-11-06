# Third-party dependency inventory

This inventory accompanies [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). It records source repositories and declared licenses for the locked npm packages, the normal/build dependencies of the macOS arm64 native bridge and idevice tools, and the libraries reported by sharp’s macOS arm64 libvips bundle. The dependency packages retain their complete upstream license and copyright notices.

Versions are taken from `package-lock.json`, `native/bridge/Cargo.lock`, and the lockfile at the idevice revision pinned in `bin/setup`. npm source links come from the published metadata for each exact package version; Rust source links and license expressions come from the corresponding published Cargo manifests. This is a source inventory, not a change to any component’s license.

## npm packages

Includes every entry in `package-lock.json`. Optional and platform-specific entries are installed only when selected by npm for that environment. The npm column is the package metadata’s declared license; for the MCP SDK, also read the retained [upstream licensing transition terms](../third_party/LICENSE.typescript-sdk).

| Package | Version | Declared license | Source repository | Selection |
| --- | --- | --- | --- | --- |
| `@emnapi/runtime` | 1.11.3 | MIT | [github.com/toyobayashi/emnapi](https://github.com/toyobayashi/emnapi) | optional |
| `@hono/node-server` | 2.1.6 | MIT | [github.com/honojs/node-server](https://github.com/honojs/node-server) | regular dependency |
| `@img/colour` | 1.1.0 | MIT | [github.com/lovell/colour](https://github.com/lovell/colour) | regular dependency |
| `@img/sharp-darwin-arm64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: darwin; cpu: arm64 |
| `@img/sharp-darwin-x64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: darwin; cpu: x64 |
| `@img/sharp-libvips-darwin-arm64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: darwin; cpu: arm64 |
| `@img/sharp-libvips-darwin-x64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: darwin; cpu: x64 |
| `@img/sharp-libvips-linux-arm` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: arm; libc: glibc |
| `@img/sharp-libvips-linux-arm64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: arm64; libc: glibc |
| `@img/sharp-libvips-linux-ppc64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: ppc64; libc: glibc |
| `@img/sharp-libvips-linux-riscv64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: riscv64; libc: glibc |
| `@img/sharp-libvips-linux-s390x` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: s390x; libc: glibc |
| `@img/sharp-libvips-linux-x64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: x64; libc: glibc |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: arm64; libc: musl |
| `@img/sharp-libvips-linuxmusl-x64` | 1.2.4 | LGPL-3.0-or-later | [github.com/lovell/sharp-libvips](https://github.com/lovell/sharp-libvips) | optional; os: linux; cpu: x64; libc: musl |
| `@img/sharp-linux-arm` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: arm; libc: glibc |
| `@img/sharp-linux-arm64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: arm64; libc: glibc |
| `@img/sharp-linux-ppc64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: ppc64; libc: glibc |
| `@img/sharp-linux-riscv64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: riscv64; libc: glibc |
| `@img/sharp-linux-s390x` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: s390x; libc: glibc |
| `@img/sharp-linux-x64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: x64; libc: glibc |
| `@img/sharp-linuxmusl-arm64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: arm64; libc: musl |
| `@img/sharp-linuxmusl-x64` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: linux; cpu: x64; libc: musl |
| `@img/sharp-wasm32` | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; cpu: wasm32 |
| `@img/sharp-win32-arm64` | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: win32; cpu: arm64 |
| `@img/sharp-win32-ia32` | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: win32; cpu: ia32 |
| `@img/sharp-win32-x64` | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | [github.com/lovell/sharp](https://github.com/lovell/sharp) | optional; os: win32; cpu: x64 |
| `@modelcontextprotocol/client` | 2.4.0 | Apache-2.0 | [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | regular dependency |
| `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 | [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | regular dependency |
| `@modelcontextprotocol/node` | 2.1.2 | Apache-2.0 | [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | regular dependency |
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 | [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | regular dependency |
| `@xmldom/xmldom` | 0.9.12 | MIT | [github.com/xmldom/xmldom](https://github.com/xmldom/xmldom) | regular dependency |
| `cross-spawn` | 7.0.6 | MIT | [github.com/moxystudio/node-cross-spawn](https://github.com/moxystudio/node-cross-spawn) | regular dependency |
| `detect-libc` | 2.1.2 | Apache-2.0 | [github.com/lovell/detect-libc](https://github.com/lovell/detect-libc) | regular dependency |
| `eventsource` | 3.0.7 | MIT | [github.com/EventSource/eventsource](https://github.com/EventSource/eventsource) | regular dependency |
| `eventsource-parser` | 3.1.1 | MIT | [github.com/rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser) | regular dependency |
| `hono` | 4.13.16 | MIT | [github.com/honojs/hono](https://github.com/honojs/hono) | regular dependency |
| `isexe` | 2.0.0 | ISC | [github.com/isaacs/isexe](https://github.com/isaacs/isexe) | regular dependency |
| `jose` | 6.2.15 | MIT | [github.com/panva/jose](https://github.com/panva/jose) | regular dependency |
| `path-key` | 3.1.1 | MIT | [github.com/sindresorhus/path-key](https://github.com/sindresorhus/path-key) | regular dependency |
| `pkce-challenge` | 5.0.1 | MIT | [github.com/crouchcd/pkce-challenge](https://github.com/crouchcd/pkce-challenge) | regular dependency |
| `plist` | 5.0.0 | MIT | [github.com/TooTallNate/plist.js](https://github.com/TooTallNate/plist.js) | regular dependency |
| `semver` | 7.8.6 | ISC | [github.com/npm/node-semver](https://github.com/npm/node-semver) | regular dependency |
| `sharp` | 0.34.5 | Apache-2.0 | [github.com/lovell/sharp](https://github.com/lovell/sharp) | regular dependency |
| `shebang-command` | 2.0.0 | MIT | [github.com/kevva/shebang-command](https://github.com/kevva/shebang-command) | regular dependency |
| `shebang-regex` | 3.0.0 | MIT | [github.com/sindresorhus/shebang-regex](https://github.com/sindresorhus/shebang-regex) | regular dependency |
| `tslib` | 2.9.1 | 0BSD | [github.com/Microsoft/tslib](https://github.com/Microsoft/tslib) | optional |
| `which` | 2.0.2 | ISC | [github.com/isaacs/node-which](https://github.com/isaacs/node-which) | regular dependency |
| `xmlbuilder` | 15.1.1 | MIT | [github.com/oozcitak/xmlbuilder-js](https://github.com/oozcitak/xmlbuilder-js) | regular dependency |
| `zod` | 4.6.7 | MIT | [github.com/colinhacks/zod](https://github.com/colinhacks/zod) | regular dependency |

## Rust packages

The usage column identifies the normal/build dependency graph for `poki-native` and the separately built upstream `idevice-tools` package on `aarch64-apple-darwin`. This includes `idevice_id`, another binary from that upstream package. Other targets, optional features and development-only dependencies can resolve additional packages; the lockfiles remain authoritative for them.

The checked graphs are produced without building or operating a device:

```sh
cargo tree --locked --offline --edges normal,build --target aarch64-apple-darwin --manifest-path native/bridge/Cargo.toml --prefix none --format '{p}'
cargo tree --locked --offline --edges normal,build --target aarch64-apple-darwin --manifest-path .deps/idevice/Cargo.toml -p idevice-tools --prefix none --format '{p}'
```

| Package | Version | Declared license | Source repository or published source | Usage |
| --- | --- | --- | --- | --- |
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | [github.com/oyvindln/adler2](https://github.com/oyvindln/adler2) | idevice tools, native bridge |
| `aead` | 0.5.2 | MIT OR Apache-2.0 | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools |
| `aes` | 0.8.4 | MIT OR Apache-2.0 | [github.com/RustCrypto/block-ciphers](https://github.com/RustCrypto/block-ciphers) | idevice tools |
| `anstream` | 1.0.0 | MIT OR Apache-2.0 | [github.com/rust-cli/anstyle](https://github.com/rust-cli/anstyle) | idevice tools |
| `anstyle` | 1.0.14 | MIT OR Apache-2.0 | [github.com/rust-cli/anstyle](https://github.com/rust-cli/anstyle) | idevice tools |
| `anstyle-parse` | 1.0.0 | MIT OR Apache-2.0 | [github.com/rust-cli/anstyle](https://github.com/rust-cli/anstyle) | idevice tools |
| `anstyle-query` | 1.1.5 | MIT OR Apache-2.0 | [github.com/rust-cli/anstyle](https://github.com/rust-cli/anstyle) | idevice tools |
| `async-compression` | 0.4.51 | MIT OR Apache-2.0 | [github.com/Nullus157/async-compression](https://github.com/Nullus157/async-compression) | idevice tools |
| `async-compression` | 0.4.52 | MIT OR Apache-2.0 | [github.com/Nullus157/async-compression](https://github.com/Nullus157/async-compression) | native bridge |
| `async-stream` | 0.3.6 | MIT | [github.com/tokio-rs/async-stream](https://github.com/tokio-rs/async-stream) | idevice tools, native bridge |
| `async-stream-impl` | 0.3.6 | MIT | [github.com/tokio-rs/async-stream](https://github.com/tokio-rs/async-stream) | idevice tools, native bridge |
| `async_zip` | 0.0.18 | MIT | [github.com/Majored/rs-async-zip](https://github.com/Majored/rs-async-zip) | idevice tools, native bridge |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | [github.com/cuviper/autocfg](https://github.com/cuviper/autocfg) | idevice tools, native bridge |
| `aws-lc-rs` | 1.18.2 | ISC AND (Apache-2.0 OR ISC) | [github.com/aws/aws-lc-rs](https://github.com/aws/aws-lc-rs) | idevice tools |
| `aws-lc-rs` | 1.19.0 | ISC AND (Apache-2.0 OR ISC) | [github.com/aws/aws-lc-rs](https://github.com/aws/aws-lc-rs) | native bridge |
| `aws-lc-sys` | 0.46.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) | [github.com/aws/aws-lc-rs](https://github.com/aws/aws-lc-rs) | idevice tools |
| `aws-lc-sys` | 0.47.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) | [github.com/aws/aws-lc-rs](https://github.com/aws/aws-lc-rs) | native bridge |
| `base64` | 0.21.7 | MIT OR Apache-2.0 | [github.com/marshallpierce/rust-base64](https://github.com/marshallpierce/rust-base64) | idevice tools |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | [github.com/marshallpierce/rust-base64](https://github.com/marshallpierce/rust-base64) | idevice tools, native bridge |
| `base64` | 0.23.1 | MIT OR Apache-2.0 | [github.com/marshallpierce/rust-base64](https://github.com/marshallpierce/rust-base64) | idevice tools, native bridge |
| `base64ct` | 1.8.3 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `bitflags` | 2.13.2 | MIT OR Apache-2.0 | [github.com/bitflags/bitflags](https://github.com/bitflags/bitflags) | idevice tools |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools, native bridge |
| `block-padding` | 0.3.3 | MIT OR Apache-2.0 | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools |
| `bytes` | 1.12.1 | MIT | [github.com/tokio-rs/bytes](https://github.com/tokio-rs/bytes) | idevice tools, native bridge |
| `cbc` | 0.1.2 | MIT OR Apache-2.0 | [github.com/RustCrypto/block-modes](https://github.com/RustCrypto/block-modes) | idevice tools |
| `cc` | 1.11.0 | MIT OR Apache-2.0 | [github.com/rust-lang/cc-rs](https://github.com/rust-lang/cc-rs) | native bridge |
| `cc` | 1.9.0 | MIT OR Apache-2.0 | [github.com/rust-lang/cc-rs](https://github.com/rust-lang/cc-rs) | idevice tools |
| `cfg-if` | 1.0.5 | MIT OR Apache-2.0 | [github.com/rust-lang/cfg-if](https://github.com/rust-lang/cfg-if) | idevice tools, native bridge |
| `chacha20` | 0.10.2 | MIT OR Apache-2.0 | [github.com/RustCrypto/stream-ciphers](https://github.com/RustCrypto/stream-ciphers) | idevice tools, native bridge |
| `chacha20` | 0.9.1 | Apache-2.0 OR MIT | [github.com/RustCrypto/stream-ciphers](https://github.com/RustCrypto/stream-ciphers) | idevice tools |
| `chacha20poly1305` | 0.10.1 | Apache-2.0 OR MIT | [github.com/RustCrypto/AEADs](https://github.com/RustCrypto/AEADs) | idevice tools |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 | [github.com/chronotope/chrono](https://github.com/chronotope/chrono) | idevice tools, native bridge |
| `cipher` | 0.4.4 | MIT OR Apache-2.0 | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools |
| `clap` | 4.6.7 | MIT OR Apache-2.0 | [github.com/clap-rs/clap](https://github.com/clap-rs/clap) | idevice tools |
| `clap_builder` | 4.6.7 | MIT OR Apache-2.0 | [github.com/clap-rs/clap](https://github.com/clap-rs/clap) | idevice tools |
| `clap_derive` | 4.6.7 | MIT OR Apache-2.0 | [github.com/clap-rs/clap](https://github.com/clap-rs/clap) | idevice tools |
| `clap_lex` | 1.1.1 | MIT OR Apache-2.0 | [github.com/clap-rs/clap](https://github.com/clap-rs/clap) | idevice tools |
| `cmake` | 0.1.58 | MIT OR Apache-2.0 | [github.com/rust-lang/cmake-rs](https://github.com/rust-lang/cmake-rs) | idevice tools, native bridge |
| `colorchoice` | 1.0.5 | MIT OR Apache-2.0 | [github.com/rust-cli/anstyle](https://github.com/rust-cli/anstyle) | idevice tools |
| `compression-codecs` | 0.4.46 | MIT OR Apache-2.0 | [github.com/Nullus157/async-compression](https://github.com/Nullus157/async-compression) | idevice tools |
| `compression-codecs` | 0.4.47 | MIT OR Apache-2.0 | [github.com/Nullus157/async-compression](https://github.com/Nullus157/async-compression) | native bridge |
| `compression-core` | 0.4.34 | MIT OR Apache-2.0 | [github.com/Nullus157/async-compression](https://github.com/Nullus157/async-compression) | idevice tools, native bridge |
| `console` | 0.16.6 | MIT | [github.com/console-rs/console](https://github.com/console-rs/console) | idevice tools |
| `const-oid` | 0.9.6 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `core-foundation` | 0.10.1 | MIT OR Apache-2.0 | [github.com/servo/core-foundation-rs](https://github.com/servo/core-foundation-rs) | idevice tools |
| `core-foundation-sys` | 0.8.7 | MIT OR Apache-2.0 | [github.com/servo/core-foundation-rs](https://github.com/servo/core-foundation-rs) | idevice tools |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools |
| `crc32fast` | 1.5.2 | MIT OR Apache-2.0 | [github.com/srijs/rust-crc32fast](https://github.com/srijs/rust-crc32fast) | idevice tools |
| `crc32fast` | 1.5.4 | MIT OR Apache-2.0 | [github.com/srijs/rust-crc32fast](https://github.com/srijs/rust-crc32fast) | native bridge |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools, native bridge |
| `curve25519-dalek` | 4.1.3 | BSD-3-Clause | [github.com/dalek-cryptography/curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) | idevice tools |
| `der` | 0.7.10 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `der_derive` | 0.7.3 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `deranged` | 0.5.9 | MIT OR Apache-2.0 | [github.com/jhpratt/deranged](https://github.com/jhpratt/deranged) | idevice tools, native bridge |
| `dialoguer` | 0.12.0 | MIT | [github.com/console-rs/dialoguer](https://github.com/console-rs/dialoguer) | idevice tools |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools, native bridge |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | [gitlab.com/kornelski/dunce](https://gitlab.com/kornelski/dunce) | idevice tools, native bridge |
| `ed25519` | 2.2.3 | Apache-2.0 OR MIT | [github.com/RustCrypto/signatures](https://github.com/RustCrypto/signatures) | idevice tools |
| `ed25519-dalek` | 2.2.0 | BSD-3-Clause | [github.com/dalek-cryptography/curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) | idevice tools |
| `equivalent` | 1.0.3 | Apache-2.0 OR MIT | [github.com/indexmap-rs/equivalent](https://github.com/indexmap-rs/equivalent) | idevice tools, native bridge |
| `errno` | 0.3.14 | MIT OR Apache-2.0 | [github.com/lambda-fairy/rust-errno](https://github.com/lambda-fairy/rust-errno) | idevice tools, native bridge |
| `fastrand` | 2.5.0 | Apache-2.0 OR MIT | [github.com/smol-rs/fastrand](https://github.com/smol-rs/fastrand) | idevice tools, native bridge |
| `find-msvc-tools` | 0.1.15 | MIT OR Apache-2.0 | [github.com/rust-lang/cc-rs](https://github.com/rust-lang/cc-rs) | idevice tools, native bridge |
| `flagset` | 0.4.7 | Apache-2.0 | [github.com/enarx/flagset](https://github.com/enarx/flagset) | idevice tools |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 | [github.com/rust-lang/flate2-rs](https://github.com/rust-lang/flate2-rs) | idevice tools, native bridge |
| `flume` | 0.11.1 | Apache-2.0/MIT | [github.com/zesterer/flume](https://github.com/zesterer/flume) | idevice tools |
| `fs_extra` | 1.3.0 | MIT | [github.com/webdesus/fs_extra](https://github.com/webdesus/fs_extra) | idevice tools, native bridge |
| `futures` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-channel` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-core` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-executor` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-io` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-lite` | 2.6.1 | Apache-2.0 OR MIT | [github.com/smol-rs/futures-lite](https://github.com/smol-rs/futures-lite) | idevice tools, native bridge |
| `futures-macro` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-sink` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-task` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `futures-util` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | idevice tools, native bridge |
| `generic-array` | 0.14.7 | MIT | [github.com/fizyk20/generic-array](https://github.com/fizyk20/generic-array) | idevice tools, native bridge |
| `getrandom` | 0.2.17 | MIT OR Apache-2.0 | [github.com/rust-random/getrandom](https://github.com/rust-random/getrandom) | idevice tools |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 | [github.com/rust-random/getrandom](https://github.com/rust-random/getrandom) | idevice tools, native bridge |
| `getrandom` | 0.4.3 | MIT OR Apache-2.0 | [github.com/rust-random/getrandom](https://github.com/rust-random/getrandom) | idevice tools, native bridge |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 | [github.com/rust-lang/hashbrown](https://github.com/rust-lang/hashbrown) | idevice tools, native bridge |
| `heck` | 0.5.0 | MIT OR Apache-2.0 | [github.com/withoutboats/heck](https://github.com/withoutboats/heck) | idevice tools |
| `hkdf` | 0.12.4 | MIT OR Apache-2.0 | [github.com/RustCrypto/KDFs](https://github.com/RustCrypto/KDFs) | idevice tools |
| `hmac` | 0.12.1 | MIT OR Apache-2.0 | [github.com/RustCrypto/MACs](https://github.com/RustCrypto/MACs) | idevice tools |
| `iana-time-zone` | 0.1.65 | MIT OR Apache-2.0 | [github.com/strawlab/iana-time-zone](https://github.com/strawlab/iana-time-zone) | idevice tools |
| `idevice` | 0.1.68 | MIT | [github.com/jkcoxson/idevice/tree/89702099f4d7552f704f93b4526756abda319ceb](https://github.com/jkcoxson/idevice/tree/89702099f4d7552f704f93b4526756abda319ceb) | idevice tools, native bridge |
| `idevice-srp` | 0.6.0 | MIT OR Apache-2.0 | [github.com/RustCrypto/PAKEs](https://github.com/RustCrypto/PAKEs) | idevice tools |
| `idevice-tools` | 0.1.68 | MIT | [github.com/jkcoxson/idevice/tree/89702099f4d7552f704f93b4526756abda319ceb](https://github.com/jkcoxson/idevice/tree/89702099f4d7552f704f93b4526756abda319ceb) | idevice tools |
| `if-addrs` | 0.15.0 | MIT OR BSD-3-Clause | [github.com/messense/if-addrs](https://github.com/messense/if-addrs) | idevice tools |
| `indexmap` | 2.14.2 | Apache-2.0 OR MIT | [github.com/indexmap-rs/indexmap](https://github.com/indexmap-rs/indexmap) | idevice tools, native bridge |
| `inout` | 0.1.4 | MIT OR Apache-2.0 | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools |
| `io-kit-sys` | 0.5.0 | MIT OR Apache-2.0 | [github.com/jtakakura/io-kit-rs](https://github.com/jtakakura/io-kit-rs) | idevice tools |
| `is_terminal_polyfill` | 1.70.2 | MIT OR Apache-2.0 | [github.com/polyfill-rs/is_terminal_polyfill](https://github.com/polyfill-rs/is_terminal_polyfill) | idevice tools |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | [github.com/dtolnay/itoa](https://github.com/dtolnay/itoa) | idevice tools, native bridge |
| `jkcli` | 0.1.2 | MIT | [crates.io/crates/jkcli/0.1.2](https://crates.io/crates/jkcli/0.1.2) | idevice tools |
| `jktcp` | 0.1.8 | MIT | [github.com/jkcoxson/jktcp](https://github.com/jkcoxson/jktcp) | idevice tools, native bridge |
| `jobserver` | 0.1.35 | MIT OR Apache-2.0 | [github.com/rust-lang/jobserver-rs](https://github.com/rust-lang/jobserver-rs) | idevice tools, native bridge |
| `lazy_static` | 1.5.1 | MIT OR Apache-2.0 | [github.com/rust-lang-nursery/lazy-static.rs](https://github.com/rust-lang-nursery/lazy-static.rs) | idevice tools |
| `libc` | 0.2.191 | MIT OR Apache-2.0 | [github.com/rust-lang/libc](https://github.com/rust-lang/libc) | idevice tools, native bridge |
| `libm` | 0.2.16 | MIT | [github.com/rust-lang/compiler-builtins](https://github.com/rust-lang/compiler-builtins) | idevice tools |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 | [github.com/Amanieu/parking_lot](https://github.com/Amanieu/parking_lot) | idevice tools, native bridge |
| `log` | 0.4.34 | MIT OR Apache-2.0 | [github.com/rust-lang/log](https://github.com/rust-lang/log) | idevice tools |
| `mach2` | 0.5.0 | BSD-2-Clause OR MIT OR Apache-2.0 | [github.com/JohnTitor/mach2](https://github.com/JohnTitor/mach2) | idevice tools |
| `matchers` | 0.2.0 | MIT | [github.com/hawkw/matchers](https://github.com/hawkw/matchers) | idevice tools |
| `md-5` | 0.10.6 | MIT OR Apache-2.0 | [github.com/RustCrypto/hashes](https://github.com/RustCrypto/hashes) | idevice tools, native bridge |
| `mdns-sd` | 0.19.2 | Apache-2.0 OR MIT | [github.com/keepsimple1/mdns-sd](https://github.com/keepsimple1/mdns-sd) | idevice tools |
| `memchr` | 2.8.3 | Unlicense OR MIT | [github.com/BurntSushi/memchr](https://github.com/BurntSushi/memchr) | idevice tools, native bridge |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 | [github.com/Frommi/miniz_oxide](https://github.com/Frommi/miniz_oxide) | idevice tools, native bridge |
| `mio` | 1.2.4 | MIT | [github.com/tokio-rs/mio](https://github.com/tokio-rs/mio) | idevice tools, native bridge |
| `ns-keyed-archive` | 0.1.5 | MIT OR Apache-2.0 | [github.com/jkcoxson/ns_keyed_archive](https://github.com/jkcoxson/ns_keyed_archive) | idevice tools, native bridge |
| `nskeyedarchiver_converter` | 0.1.3 | MIT OR Apache-2.0 | [github.com/michaelwright235/nskeyedarchiver_converter](https://github.com/michaelwright235/nskeyedarchiver_converter) | idevice tools, native bridge |
| `nu-ansi-term` | 0.50.3 | MIT | [github.com/nushell/nu-ansi-term](https://github.com/nushell/nu-ansi-term) | idevice tools |
| `num-bigint` | 0.4.8 | MIT OR Apache-2.0 | [github.com/rust-num/num-bigint](https://github.com/rust-num/num-bigint) | idevice tools |
| `num-bigint-dig` | 0.8.6 | MIT/Apache-2.0 | [github.com/dignifiedquire/num-bigint](https://github.com/dignifiedquire/num-bigint) | idevice tools |
| `num-conv` | 0.2.2 | MIT OR Apache-2.0 | [github.com/jhpratt/num-conv](https://github.com/jhpratt/num-conv) | idevice tools, native bridge |
| `num-integer` | 0.1.47 | MIT OR Apache-2.0 | [github.com/rust-num/num-integer](https://github.com/rust-num/num-integer) | idevice tools |
| `num-iter` | 0.1.46 | MIT OR Apache-2.0 | [github.com/rust-num/num-iter](https://github.com/rust-num/num-iter) | idevice tools |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | [github.com/rust-num/num-traits](https://github.com/rust-num/num-traits) | idevice tools, native bridge |
| `nusb` | 0.2.8 | Apache-2.0 OR MIT | [github.com/kevinmehall/nusb](https://github.com/kevinmehall/nusb) | idevice tools |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 | [github.com/matklad/once_cell](https://github.com/matklad/once_cell) | idevice tools, native bridge |
| `opaque-debug` | 0.3.1 | MIT OR Apache-2.0 | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools |
| `owo-colors` | 4.4.0 | MIT | [github.com/owo-colors/owo-colors](https://github.com/owo-colors/owo-colors) | idevice tools |
| `parking` | 2.2.1 | Apache-2.0 OR MIT | [github.com/smol-rs/parking](https://github.com/smol-rs/parking) | idevice tools, native bridge |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 | [github.com/Amanieu/parking_lot](https://github.com/Amanieu/parking_lot) | idevice tools, native bridge |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 | [github.com/Amanieu/parking_lot](https://github.com/Amanieu/parking_lot) | idevice tools, native bridge |
| `pem-rfc7468` | 0.7.0 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `pin-project` | 1.1.13 | Apache-2.0 OR MIT | [github.com/taiki-e/pin-project](https://github.com/taiki-e/pin-project) | idevice tools, native bridge |
| `pin-project-internal` | 1.1.13 | Apache-2.0 OR MIT | [github.com/taiki-e/pin-project](https://github.com/taiki-e/pin-project) | idevice tools, native bridge |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | [github.com/taiki-e/pin-project-lite](https://github.com/taiki-e/pin-project-lite) | idevice tools, native bridge |
| `pkcs1` | 0.7.5 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `pkcs8` | 0.10.2 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `pkg-config` | 0.3.34 | MIT OR Apache-2.0 | [github.com/rust-lang/pkg-config-rs](https://github.com/rust-lang/pkg-config-rs) | idevice tools, native bridge |
| `plist` | 1.10.1 | MIT | [github.com/ebarnard/rust-plist](https://github.com/ebarnard/rust-plist) | idevice tools |
| `plist` | 1.10.3 | MIT | [github.com/ebarnard/rust-plist](https://github.com/ebarnard/rust-plist) | native bridge |
| `plist-macro` | 0.1.6 | MIT | [github.com/jkcoxson/plist_macro](https://github.com/jkcoxson/plist_macro) | idevice tools, native bridge |
| `poly1305` | 0.8.0 | Apache-2.0 OR MIT | [github.com/RustCrypto/universal-hashes](https://github.com/RustCrypto/universal-hashes) | idevice tools |
| `powerfmt` | 0.2.1 | MIT OR Apache-2.0 | [github.com/jhpratt/powerfmt](https://github.com/jhpratt/powerfmt) | idevice tools, native bridge |
| `ppv-lite86` | 0.2.21 | MIT OR Apache-2.0 | [github.com/cryptocorrosion/cryptocorrosion](https://github.com/cryptocorrosion/cryptocorrosion) | idevice tools, native bridge |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 | [github.com/dtolnay/proc-macro2](https://github.com/dtolnay/proc-macro2) | idevice tools, native bridge |
| `quick-xml` | 0.42.0 | MIT | [github.com/tafia/quick-xml](https://github.com/tafia/quick-xml) | idevice tools, native bridge |
| `quote` | 1.0.47 | MIT OR Apache-2.0 | [github.com/dtolnay/quote](https://github.com/dtolnay/quote) | idevice tools, native bridge |
| `rand` | 0.10.3 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools, native bridge |
| `rand` | 0.8.8 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools |
| `rand` | 0.9.5 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools, native bridge |
| `rand_chacha` | 0.3.1 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools |
| `rand_chacha` | 0.9.0 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools, native bridge |
| `rand_core` | 0.10.1 | MIT OR Apache-2.0 | [github.com/rust-random/rand_core](https://github.com/rust-random/rand_core) | idevice tools, native bridge |
| `rand_core` | 0.6.4 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools |
| `rand_core` | 0.9.5 | MIT OR Apache-2.0 | [github.com/rust-random/rand](https://github.com/rust-random/rand) | idevice tools, native bridge |
| `regex-automata` | 0.4.18 | MIT OR Apache-2.0 | [github.com/rust-lang/regex](https://github.com/rust-lang/regex) | idevice tools |
| `regex-syntax` | 0.8.11 | MIT OR Apache-2.0 | [github.com/rust-lang/regex](https://github.com/rust-lang/regex) | idevice tools |
| `rsa` | 0.9.10 | MIT OR Apache-2.0 | [github.com/RustCrypto/RSA](https://github.com/RustCrypto/RSA) | idevice tools |
| `rustc_version` | 0.4.1 | MIT OR Apache-2.0 | [github.com/djc/rustc-version-rs](https://github.com/djc/rustc-version-rs) | idevice tools |
| `rustix` | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [github.com/bytecodealliance/rustix](https://github.com/bytecodealliance/rustix) | idevice tools |
| `rustls` | 0.23.46 | Apache-2.0 OR ISC OR MIT | [github.com/rustls/rustls](https://github.com/rustls/rustls) | idevice tools, native bridge |
| `rustls-pki-types` | 1.15.1 | MIT OR Apache-2.0 | [github.com/rustls/pki-types](https://github.com/rustls/pki-types) | idevice tools, native bridge |
| `rustls-webpki` | 0.103.15 | ISC | [github.com/rustls/webpki](https://github.com/rustls/webpki) | idevice tools |
| `rustls-webpki` | 0.103.16 | ISC | [github.com/rustls/webpki](https://github.com/rustls/webpki) | native bridge |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 | [github.com/bluss/scopeguard](https://github.com/bluss/scopeguard) | idevice tools, native bridge |
| `semver` | 1.0.28 | MIT OR Apache-2.0 | [github.com/dtolnay/semver](https://github.com/dtolnay/semver) | idevice tools |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | [github.com/serde-rs/serde](https://github.com/serde-rs/serde) | idevice tools, native bridge |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 | [github.com/serde-rs/serde](https://github.com/serde-rs/serde) | idevice tools, native bridge |
| `serde_derive` | 1.0.229 | MIT OR Apache-2.0 | [github.com/serde-rs/serde](https://github.com/serde-rs/serde) | idevice tools, native bridge |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | [github.com/serde-rs/json](https://github.com/serde-rs/json) | idevice tools, native bridge |
| `sha1` | 0.10.7 | MIT OR Apache-2.0 | [github.com/RustCrypto/hashes](https://github.com/RustCrypto/hashes) | idevice tools |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | [github.com/RustCrypto/hashes](https://github.com/RustCrypto/hashes) | idevice tools |
| `sharded-slab` | 0.1.7 | MIT | [github.com/hawkw/sharded-slab](https://github.com/hawkw/sharded-slab) | idevice tools |
| `shell-words` | 1.1.1 | MIT/Apache-2.0 | [github.com/tmiasko/shell-words](https://github.com/tmiasko/shell-words) | idevice tools |
| `shlex` | 2.0.1 | MIT OR Apache-2.0 | [github.com/comex/rust-shlex](https://github.com/comex/rust-shlex) | idevice tools, native bridge |
| `signal-hook-registry` | 1.4.8 | MIT OR Apache-2.0 | [github.com/vorner/signal-hook](https://github.com/vorner/signal-hook) | idevice tools, native bridge |
| `signature` | 2.2.0 | Apache-2.0 OR MIT | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools |
| `simd-adler32` | 0.3.10 | MIT | [github.com/mcountryman/simd-adler32](https://github.com/mcountryman/simd-adler32) | idevice tools, native bridge |
| `siphasher` | 1.0.4 | MIT OR Apache-2.0 | [github.com/jedisct1/rust-siphash](https://github.com/jedisct1/rust-siphash) | idevice tools |
| `slab` | 0.4.12 | MIT | [github.com/tokio-rs/slab](https://github.com/tokio-rs/slab) | idevice tools, native bridge |
| `smallvec` | 1.16.3 | MIT OR Apache-2.0 | [github.com/servo/rust-smallvec](https://github.com/servo/rust-smallvec) | idevice tools |
| `smallvec` | 1.16.4 | MIT OR Apache-2.0 | [github.com/servo/rust-smallvec](https://github.com/servo/rust-smallvec) | native bridge |
| `socket-pktinfo` | 0.3.2 | MIT | [github.com/pixsper/socket-pktinfo](https://github.com/pixsper/socket-pktinfo) | idevice tools |
| `socket2` | 0.6.5 | MIT OR Apache-2.0 | [github.com/rust-lang/socket2](https://github.com/rust-lang/socket2) | idevice tools, native bridge |
| `spin` | 0.9.9 | MIT | [github.com/mvdnes/spin-rs](https://github.com/mvdnes/spin-rs) | idevice tools |
| `spki` | 0.7.3 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `strsim` | 0.11.1 | MIT | [github.com/rapidfuzz/strsim-rs](https://github.com/rapidfuzz/strsim-rs) | idevice tools |
| `subtle` | 2.6.1 | BSD-3-Clause | [github.com/dalek-cryptography/subtle](https://github.com/dalek-cryptography/subtle) | idevice tools, native bridge |
| `syn` | 2.0.119 | MIT OR Apache-2.0 | [github.com/dtolnay/syn](https://github.com/dtolnay/syn) | idevice tools, native bridge |
| `syn` | 3.0.9 | MIT OR Apache-2.0 | [github.com/dtolnay/syn](https://github.com/dtolnay/syn) | idevice tools, native bridge |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 | [github.com/Stebalien/tempfile](https://github.com/Stebalien/tempfile) | idevice tools |
| `thiserror` | 2.0.21 | MIT OR Apache-2.0 | [github.com/dtolnay/thiserror](https://github.com/dtolnay/thiserror) | idevice tools, native bridge |
| `thiserror-impl` | 2.0.21 | MIT OR Apache-2.0 | [github.com/dtolnay/thiserror](https://github.com/dtolnay/thiserror) | idevice tools, native bridge |
| `thread_local` | 1.1.10 | MIT OR Apache-2.0 | [github.com/Amanieu/thread_local-rs](https://github.com/Amanieu/thread_local-rs) | idevice tools |
| `time` | 0.3.55 | MIT OR Apache-2.0 | [github.com/time-rs/time](https://github.com/time-rs/time) | idevice tools, native bridge |
| `time-core` | 0.1.9 | MIT OR Apache-2.0 | [github.com/time-rs/time](https://github.com/time-rs/time) | idevice tools, native bridge |
| `tokio` | 1.54.0 | MIT | [github.com/tokio-rs/tokio](https://github.com/tokio-rs/tokio) | idevice tools |
| `tokio` | 1.54.1 | MIT | [github.com/tokio-rs/tokio](https://github.com/tokio-rs/tokio) | native bridge |
| `tokio-macros` | 2.7.2 | MIT | [github.com/tokio-rs/tokio](https://github.com/tokio-rs/tokio) | idevice tools, native bridge |
| `tokio-rustls` | 0.26.6 | MIT OR Apache-2.0 | [github.com/rustls/tokio-rustls](https://github.com/rustls/tokio-rustls) | idevice tools, native bridge |
| `tokio-util` | 0.7.20 | MIT | [github.com/tokio-rs/tokio](https://github.com/tokio-rs/tokio) | idevice tools, native bridge |
| `tracing` | 0.1.44 | MIT | [github.com/tokio-rs/tracing](https://github.com/tokio-rs/tracing) | idevice tools, native bridge |
| `tracing-attributes` | 0.1.31 | MIT | [github.com/tokio-rs/tracing](https://github.com/tokio-rs/tracing) | idevice tools, native bridge |
| `tracing-core` | 0.1.36 | MIT | [github.com/tokio-rs/tracing](https://github.com/tokio-rs/tracing) | idevice tools, native bridge |
| `tracing-log` | 0.2.0 | MIT | [github.com/tokio-rs/tracing](https://github.com/tokio-rs/tracing) | idevice tools |
| `tracing-subscriber` | 0.3.23 | MIT | [github.com/tokio-rs/tracing](https://github.com/tokio-rs/tracing) | idevice tools |
| `typenum` | 1.20.1 | MIT OR Apache-2.0 | [github.com/paholg/typenum](https://github.com/paholg/typenum) | idevice tools, native bridge |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | [github.com/dtolnay/unicode-ident](https://github.com/dtolnay/unicode-ident) | idevice tools, native bridge |
| `unicode-width` | 0.2.2 | MIT OR Apache-2.0 | [github.com/unicode-rs/unicode-width](https://github.com/unicode-rs/unicode-width) | idevice tools |
| `universal-hash` | 0.5.1 | MIT OR Apache-2.0 | [github.com/RustCrypto/traits](https://github.com/RustCrypto/traits) | idevice tools |
| `untrusted` | 0.9.0 | ISC | [github.com/briansmith/untrusted](https://github.com/briansmith/untrusted) | idevice tools, native bridge |
| `utf8parse` | 0.2.2 | Apache-2.0 OR MIT | [github.com/alacritty/vte](https://github.com/alacritty/vte) | idevice tools |
| `uuid` | 1.28.0 | Apache-2.0 OR MIT | [github.com/uuid-rs/uuid](https://github.com/uuid-rs/uuid) | idevice tools |
| `uuid` | 1.29.0 | Apache-2.0 OR MIT | [github.com/uuid-rs/uuid](https://github.com/uuid-rs/uuid) | native bridge |
| `version_check` | 0.9.5 | MIT/Apache-2.0 | [github.com/SergioBenitez/version_check](https://github.com/SergioBenitez/version_check) | idevice tools, native bridge |
| `web-time` | 1.1.0 | MIT OR Apache-2.0 | [github.com/daxpedda/web-time](https://github.com/daxpedda/web-time) | idevice tools, native bridge |
| `webpki-roots` | 1.0.9 | CDLA-Permissive-2.0 | [github.com/rustls/webpki-roots](https://github.com/rustls/webpki-roots) | idevice tools |
| `x25519-dalek` | 2.0.1 | BSD-3-Clause | [github.com/dalek-cryptography/curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) | idevice tools |
| `x509-cert` | 0.2.5 | Apache-2.0 OR MIT | [github.com/RustCrypto/formats](https://github.com/RustCrypto/formats) | idevice tools |
| `zerocopy` | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT | [github.com/google/zerocopy](https://github.com/google/zerocopy) | idevice tools, native bridge |
| `zeroize` | 1.9.1 | Apache-2.0 OR MIT | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools, native bridge |
| `zeroize_derive` | 1.5.0 | Apache-2.0 OR MIT | [github.com/RustCrypto/utils](https://github.com/RustCrypto/utils) | idevice tools |
| `zmij` | 1.0.23 | MIT | [github.com/dtolnay/zmij](https://github.com/dtolnay/zmij) | idevice tools, native bridge |

`jkcli` 0.1.2 does not publish a repository URL in its Cargo manifest. Its source is available from the linked crates.io release; no repository address has been guessed.

### Native code inside cryptography crates

The `aws-lc-sys` 0.46.0 and 0.47.0 packages include [AWS-LC](https://github.com/aws/aws-lc), which incorporates code from [BoringSSL](https://boringssl.googlesource.com/boringssl/) and [OpenSSL](https://github.com/openssl/openssl). Their complete combined upstream copyright and license text is retained in [third_party/LICENSE.aws-lc](../third_party/LICENSE.aws-lc); the two checked crate releases carry identical license text. The table preserves each crate’s complete declared license expression; the combined license file gives the terms applicable to the embedded components.

## Image libraries in the macOS arm64 libvips package

Versions below are the contents of `@img/sharp-libvips-darwin-arm64` 1.2.4 `versions.json`. Component terms are taken from that package’s README and the retained [sharp-libvips notices](../third_party/NOTICE.sharp-libvips.md). Source repositories are identified in the pinned [sharp-libvips build](https://github.com/lovell/sharp-libvips/blob/20b5e899954907a3039d6e3d4c200aaa0ec52c4c/build/posix.sh); patch sources from that build are listed after the table.

| Library | Reported version | Upstream terms in the bundle notices | Source repository |
| --- | --- | --- | --- |
| aom | 3.13.1 | BSD-2-Clause and AOM Patent License 1.0 | [aomedia.googlesource.com/aom/](https://aomedia.googlesource.com/aom/) |
| libarchive | 3.8.2 | BSD-2-Clause | [github.com/libarchive/libarchive](https://github.com/libarchive/libarchive) |
| cairo | 1.18.4 | MPL-2.0 | [gitlab.freedesktop.org/cairo/cairo](https://gitlab.freedesktop.org/cairo/cairo) |
| cgif | 0.5.0 | MIT | [github.com/dloebl/cgif](https://github.com/dloebl/cgif) |
| libexif | 0.6.25 | LGPLv3 via the later-version clause | [github.com/libexif/libexif](https://github.com/libexif/libexif) |
| expat | 2.7.3 | MIT | [github.com/libexpat/libexpat](https://github.com/libexpat/libexpat) |
| libffi | 3.5.2 | MIT | [github.com/libffi/libffi](https://github.com/libffi/libffi) |
| fontconfig | 2.17.1 | fontconfig license (BSD-like) | [gitlab.freedesktop.org/fontconfig/fontconfig](https://gitlab.freedesktop.org/fontconfig/fontconfig) |
| freetype | 2.14.1 | FreeType License (BSD-like) | [github.com/freetype/freetype](https://github.com/freetype/freetype) |
| fribidi | 1.0.16 | LGPLv3 via the later-version clause | [github.com/fribidi/fribidi](https://github.com/fribidi/fribidi) |
| glib | 2.86.1 | LGPLv3 via the later-version clause | [gitlab.gnome.org/GNOME/glib](https://gitlab.gnome.org/GNOME/glib) |
| harfbuzz | 12.1.0 | MIT | [github.com/harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz) |
| libheif | 1.20.2 | LGPLv3 via the later-version clause | [github.com/strukturag/libheif](https://github.com/strukturag/libheif) |
| highway | 1.3.0 | Apache-2.0 and BSD-3-Clause | [github.com/google/highway](https://github.com/google/highway) |
| libimagequant | 2.4.1 | BSD-2-Clause (the lovell fork in the bundle) | [github.com/lovell/libimagequant](https://github.com/lovell/libimagequant) |
| lcms | 2.17 | MIT | [github.com/mm2/Little-CMS](https://github.com/mm2/Little-CMS) |
| mozjpeg | 0826579 | zlib, IJG and BSD-3-Clause | [github.com/mozilla/mozjpeg](https://github.com/mozilla/mozjpeg) |
| pango | 1.57.0 | LGPLv3 via the later-version clause | [gitlab.gnome.org/GNOME/pango](https://gitlab.gnome.org/GNOME/pango) |
| pixman | 0.46.4 | MIT | [gitlab.freedesktop.org/pixman/pixman](https://gitlab.freedesktop.org/pixman/pixman) |
| libpng | 1.6.50 | libpng license | [github.com/pnggroup/libpng](https://github.com/pnggroup/libpng) |
| proxy-libintl | 0.5 | LGPLv3 via the later-version clause | [github.com/frida/proxy-libintl](https://github.com/frida/proxy-libintl) |
| librsvg | 2.61.2 | LGPLv3 via the later-version clause | [gitlab.gnome.org/GNOME/librsvg](https://gitlab.gnome.org/GNOME/librsvg) |
| libspng | 0.7.4 | BSD-2-Clause and libpng license | [github.com/randy408/libspng](https://github.com/randy408/libspng) |
| libtiff | 4.7.1 | libtiff license (BSD-like) | [gitlab.com/libtiff/libtiff](https://gitlab.com/libtiff/libtiff) |
| libvips | 8.17.3 | LGPLv3 via the later-version clause | [github.com/libvips/libvips](https://github.com/libvips/libvips) |
| libwebp | 1.6.0 | BSD-3-Clause | [chromium.googlesource.com/webm/libwebp](https://chromium.googlesource.com/webm/libwebp) |
| libxml2 | 2.15.1 | MIT | [gitlab.gnome.org/GNOME/libxml2](https://gitlab.gnome.org/GNOME/libxml2) |
| zlib-ng | 2.2.5 | zlib license | [github.com/zlib-ng/zlib-ng](https://github.com/zlib-ng/zlib-ng) |

The same pinned build references patches from [kleisauke’s GLib patch](https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae), [m-ab-s/aom](https://github.com/m-ab-s/aom/commit/6d2b7f71b98bfa28e372b1f2d85f137280bdb3de), [google/highway](https://github.com/google/highway/commit/ad48f2bf298bac247288c8399a5c0e9a40ed8246), [lovell’s libvips patch](https://gist.github.com/lovell/313a6901e9db1bf285f2a1f1180499e4), and [libvips/build-win64-mxe](https://github.com/libvips/build-win64-mxe/blob/v8.17.3/build/patches/vips-8-heifsave-disable-hbr-support.patch). These are source references for the upstream bundle build; Poki does not apply them or rebuild that bundle.

The upstream notices also name libnsgif (MIT), but this macOS arm64 package does not report a libnsgif version. Its notice is retained without claiming it is present in the checked bundle.

## Updating this inventory

When a lockfile, the pinned idevice revision, target architecture or libvips package changes, regenerate the affected package list from the exact package metadata and Cargo graph. Keep upstream license expressions intact, retain component notices, and distinguish optional packages from the packages selected for the supported target. External tool repositories and their terms are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md#external-open-source-tools).

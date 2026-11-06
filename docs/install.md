# Install

## Requirements

- **macOS 15 or later** with a full **Xcode** installation from the App Store, opened at least once to finish its first-launch setup (Command Line Tools alone are not enough). Xcode also provides Git and Python 3.
- **Git**
- **Node.js 24+** and **npm** (required for both the daemon and the stdio client)
- **Rust / Cargo** with Rust 2024 edition support, from [rustup.rs](https://rustup.rs). Setup always uses it to build the iPhone bridge, even if you use only the Simulator.
- **Python 3**
- **`ffmpeg` and `ffprobe`**, from `brew install ffmpeg` (required for recording; checked during `./bin/setup`)
- **iOS Simulator runtime** installed in Xcode (for simulator targets)
- **Apple developer support files** already installed on the Mac (for physical-device developer services)

`./bin/setup` checks for these requirements and stops with an installation hint if any are missing. You do not need to set any environment variables. All settings in [Configuration and sessions](configuration.md) are optional.

> **Reference environment**: Prepared on an Apple silicon Mac with macOS 27.3, Xcode 27.0 (`27A5209h`), Node 26.10.0, npm 11.19.1, Rust/Cargo 1.99.0, Python 3.13.0, and `ffmpeg`/`ffprobe` 9.0.2. These versions record the build environment rather than claiming that every tool and parameter works across all platform versions.

If you received the optional `poki-v0.1.0-macos-arm64.tar.gz` build, follow its bundled README; the source installation below does not depend on that archive.

## 1. Build from Source and Start the Daemon

```sh
git clone https://github.com/JosssphZhou/poki.git
cd poki
./bin/setup
npm start
```

`./bin/setup` takes a few minutes on a first build. What it does:

- Fetches `jkcoxson/idevice` at commit `89702099f4d7552f704f93b4526756abda319ceb` into `.deps/idevice` and verifies its revision and clean working tree (stopping without modifying `.deps/idevice` if mismatched or dirty).
- Installs locked npm dependencies.
- Builds the Rust physical-device bridge, optional unlock helper, Swift OCR helper, and Objective-C simulator bridge. (If you modify native code later, rebuild with `npm run build:native`.)

Setup does **not** install Xcode, developer disk images, device profiles, or signing identities.

Keep `npm start` running while using an MCP client:

- The daemon listens only on `127.0.0.1:47825` (not exposed to external networks, and not registered as a login item).
- Its endpoint and bearer token are written to `~/Library/Application Support/PokiMCP/mcp.json` (`0600`) and removed on normal shutdown. On Linux the state directory is `$XDG_STATE_HOME/poki`, or `~/.local/state/poki`; `POKI_MCP_STATE_DIR` overrides it on any host.
- The stdio wrapper (`src/stdio.mjs`) connects to this running daemon; it does not auto-start the service.

## 2. Connect an MCP Client

Replace `/absolute/path/to/poki` with the absolute path to your checkout, and ensure `node` (24+) is on the MCP client's `PATH`.

From the checkout, `"$PWD/src/stdio.mjs"` gives the same absolute path in a shell command.

**Claude Code:**

```sh
claude mcp add --scope user poki-mcp -- node /absolute/path/to/poki/src/stdio.mjs
```

**Codex:**

```sh
codex mcp add poki-mcp -- node /absolute/path/to/poki/src/stdio.mjs
```

**Codex (`config.toml`):**

```toml
[mcp_servers.poki-mcp]
command = "node"
args = ["/absolute/path/to/poki/src/stdio.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

**Clients using `mcpServers` JSON:**

```json
{
  "mcpServers": {
    "poki-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/poki/src/stdio.mjs"]
    }
  }
}
```

### Let your agent install it

Paste this prompt into your agent:

```text
Install https://github.com/JosssphZhou/poki following its root AGENTS.md, including the MCP skill, and stop whenever you need me to act.
```

[AGENTS.md](../AGENTS.md) covers prerequisites, source setup, the background daemon, registration in your own client, skill installation, iPhone pairing, Poki Agent, optional iMessage, and verification. It names each user-only stop, including Xcode setup, Trust This Computer, Developer Mode, UI Automation, and model login.

The default MCP `tools/list` exposes the tools for phone tasks. `poki_mcp_status.total_tools` reports the size of the complete catalog. Set `POKI_MCP_TOOLS=all` in the client's environment and reconnect to discover the complete catalog. Read and report the actual values. Neither count proves that the phone is ready.

## 3. Verify from the Terminal

Each stdio MCP client gets its own session, keeping its `select_device` choice until the client exits. `bin/call.mjs` works differently: each run opens a session named `terminal`, makes a single call, and closes the session on exit. Even though runs use the same session name, they do not share state, so device selections and recordings do not carry over to the next run. Pass `device` in each call, or use an MCP client session to persist your selection:

```sh
node bin/call.mjs poki_mcp_status
node bin/call.mjs list_devices
node bin/call.mjs start_simulator '{"model":"iPhone 18 Pro"}'
node bin/call.mjs take_screenshot '{"device":"YOUR_DEVICE_NAME_OR_ID"}'
node bin/call.mjs list_elements '{"device":"YOUR_DEVICE_NAME_OR_ID","source":"accessibility"}'
```

`list_devices` with `{"include_all_simulators":true}` lists the models that `start_simulator` can create. `start_simulator` names a new simulator `Poki MCP <model>`.

To use a physical iPhone, first pair it with your Mac over USB. After that, keep both devices on the same local network with the phone unlocked. See [Physical iPhone setup](physical-iphone.md).

## Fix common problems

| What you see | What to do |
| --- | --- |
| `Missing prerequisite: <tool>` from `./bin/setup` | Install what the message names, then run `./bin/setup` again. Setup keeps the existing `.deps/idevice` checkout, and Cargo continues its build. |
| `Poki MCP needs the full Xcode` from `./bin/setup` | Only the Command Line Tools are active. Install Xcode and run the commands in the message. |
| `Local Poki MCP is not running` | Run `npm start` in the checkout. If you set `POKI_MCP_STATE_DIR`, set the same value for the daemon and the client. |
| `Multiple devices match` | Name the device: call `select_device` in an MCP client session, or pass `device` in each call. |
| The default port is in use | Run `npm start -- --port <port>`. Clients read the port from `mcp.json`. |
| A second daemon on one Mac | Give each daemon its own `POKI_MCP_STATE_DIR`. Both write `mcp.json` in that folder, and a normal shutdown removes it. |
| `tap_text` cannot find English text | A new simulator uses the language of the Mac. Target the text as it appears on screen. |
| `This device is not recording` from `bin/call.mjs` | A recording ends when its session closes. Record from one MCP client session. |

## Names and distribution

The repository is `poki`. The command, the MCP server key, and the package name stay `poki-mcp`, because the npm name `poki` belongs to another project. `package.json` is marked `"private": true`; this repository is used from source and does not publish an npm package.

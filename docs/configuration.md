# Configuration and sessions

All device operations are serialized inside the daemon. Every setting below is optional:

| Setting | Purpose |
| --- | --- |
| `POKI_MCP_STATE_DIR` | Override the state and endpoint directory. Must be set to the same value for both daemon and client. |
| `POKI_MCP_SESSION` | Session identifier (`1–80` characters: letters, digits, `_`, or `-`). Simultaneously connected clients with the same identifier share a session and its device selection, while distinct identifiers isolate them. The session closes as soon as any sharing client exits. Because of this, a shared value will not preserve a selection across separate `bin/call.mjs` runs, and reusing a running client's identifier in `bin/call.mjs` will clear that client's selection when the command exits. |
| `POKI_MCP_APPROVAL_MODE=allow` | Preapprove sensitive operations (listed under [Approval & Clipboard Behavior](tools.md#approval--clipboard-behavior)) for this daemon instance. Omit for interactive local approval prompts. |
| `POKI_MCP_NATIVE_TRACE` | Enable native diagnostic timing output on `stderr`. |
| `POKI_DEVICE_HOST`, `POKI_RP_PAIRING_FILE` | Reach one iPhone by IP address through its remote pairing service instead of usbmuxd, for networks where iOS closes lockdown, such as a tailnet. Set both: the phone's IP address and the RPPairing file made with `bin/pair-remote`. Setting them replaces usbmuxd discovery rather than adding to it: the device list holds only this phone, with the ID `network-<host>`, and USB devices are not listed while they are set. Device information, screenshots, rotation, clipboard, location, appearance and accessibility settings go through `build/poki-native` ops instead of `idevice-tools`. Recording still needs USB or usbmuxd, and the `xcrun devicectl` tools (terminate, open URL, crash logs, app container) still need macOS. Each call opens a new tunnel. |
| `POKI_RP_HOST_NAME` | Optional with `POKI_DEVICE_HOST`: the host name for an RPPairing file that records none. See `--rp-host-name` in [NATIVE.md](../native/NATIVE.md). |
| `IDEVICE_TOOLS` | Optional path override for the pinned upstream CLI. |

The authenticated local HTTP bridge passes the session via the `x-poki-mcp-session` header. Standard MCP clients should always connect through `src/stdio.mjs`; the local token file is not a remote access mechanism.

`poki_mcp_status` reports the version from the root `package.json`, the current short Git `commit` (`unknown` outside Git), and `native_build`, the bridge file’s UTC modification time (`unknown` when absent). A daemon startup warning reports Rust source or Cargo metadata newer than the bridge. It does not block startup or rebuild anything.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const stateDir = process.env.POKI_MCP_STATE_DIR
  ?? join(homedir(), 'Library/Application Support/PokiMCP');
export const endpointFile = join(stateDir, 'mcp.json');
export const idevice = process.env.IDEVICE_TOOLS
  ?? join(root, '.deps/idevice/target/release/idevice-tools');

// One phone reached by address through its remote pairing service, without usbmuxd. See
// src/network-device.mjs.
export function networkTarget(env = process.env) {
  const host = env.POKI_DEVICE_HOST?.trim(), file = env.POKI_RP_PAIRING_FILE?.trim();
  if (!host || !file) return undefined;
  const hostName = env.POKI_RP_HOST_NAME?.trim();
  return { id: `network-${host}`, host, rpPairingFile: file, ...(hostName ? { hostName } : {}) };
}

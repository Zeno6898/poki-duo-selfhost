import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// macOS keeps its Application Support folder. Other hosts follow the XDG base directory
// spec, which ignores a relative XDG_STATE_HOME.
export function defaultStateDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library/Application Support/PokiMCP');
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local/state'), 'poki');
}
export const stateDir = process.env.POKI_MCP_STATE_DIR ?? defaultStateDir();
export const endpointFile = join(stateDir, 'mcp.json');
export const idevice = process.env.IDEVICE_TOOLS
  ?? join(root, '.deps/idevice/target/release/idevice-tools');

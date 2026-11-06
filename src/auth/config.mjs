// Remote-access settings for the daemon, read from the environment. With none of them set the
// daemon keeps its original behaviour: 127.0.0.1 only, a fresh random token per start.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
export const defaultRedirectHosts = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1', '[::1]'];
export const scope = 'poki';

// VAR, or the contents of the file named by VAR_FILE (Docker and systemd credentials).
export function secret(env, name) {
  if (env[name] !== undefined && env[name] !== '') return env[name];
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return undefined;
}

const list = value => (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
const seconds = (env, name, fallback) => {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number of seconds`);
  return parsed;
};

export function isLoopbackBind(address) { return loopbackHosts.has(address) || /^127\./.test(address); }

export function remoteConfig(env = process.env, stateDir) {
  const bind = env.POKI_MCP_BIND || '127.0.0.1';
  if (!loopbackHosts.has(bind) && !isIP(bind) && bind !== '0.0.0.0' && bind !== '::') throw new Error('POKI_MCP_BIND must be an IP address, such as 127.0.0.1');
  const token = secret(env, 'POKI_MCP_TOKEN');
  if (token !== undefined && (token.length < 32 || !/^[\x21-\x7e]+$/.test(token))) throw new Error('POKI_MCP_TOKEN must be at least 32 printable characters without spaces; try `openssl rand -hex 32`');
  const config = { bind, token, publicUrl: undefined, mode: 'local' };
  const publicUrl = env.POKI_MCP_PUBLIC_URL;
  if (!publicUrl) {
    if (!isLoopbackBind(bind)) throw new Error('POKI_MCP_BIND is not a loopback address, so set POKI_MCP_PUBLIC_URL and POKI_OAUTH: the local bearer token is only for this machine.');
    return config;
  }
  let url;
  try { url = new URL(publicUrl); } catch { throw new Error('POKI_MCP_PUBLIC_URL must be a URL such as https://poki.example.ts.net'); }
  const localTest = url.protocol === 'http:' && loopbackHosts.has(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol !== 'https:' && !localTest) throw new Error('POKI_MCP_PUBLIC_URL must use https; put Tailscale Funnel or Cloudflare Tunnel in front of the daemon');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('POKI_MCP_PUBLIC_URL must be an origin only, such as https://poki.example.ts.net');
  const origin = url.origin;
  const mode = env.POKI_OAUTH;
  if (!['builtin', 'external', 'cloudflare-access'].includes(mode)) throw new Error('POKI_MCP_PUBLIC_URL needs POKI_OAUTH=builtin (password and TOTP on this daemon), POKI_OAUTH=cloudflare-access (Cloudflare Access signs you in) or POKI_OAUTH=external (tokens from another authorization server)');
  Object.assign(config, {
    mode,
    publicUrl: origin,
    publicHost: url.host.toLowerCase(),
    resource: `${origin}/mcp`,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    allowedHosts: list(env.POKI_MCP_ALLOWED_HOSTS).map(h => h.toLowerCase()),
    allowedOrigins: [url.hostname, ...list(env.POKI_MCP_ALLOWED_ORIGINS)],
  });
  if (mode === 'builtin') {
    Object.assign(config, {
      issuer: origin,
      scopes: [scope],
      requiredScopes: [scope],
      accountFile: env.POKI_OAUTH_ACCOUNT_FILE || join(stateDir, 'oauth/account.json'),
      storeFile: join(stateDir, 'oauth/store.json'),
      keyFile: join(stateDir, 'oauth/signing-key.json'),
      redirectHosts: env.POKI_OAUTH_REDIRECT_HOSTS ? list(env.POKI_OAUTH_REDIRECT_HOSTS) : defaultRedirectHosts,
      accessTtl: seconds(env, 'POKI_OAUTH_ACCESS_TTL', 3600),
      refreshTtl: seconds(env, 'POKI_OAUTH_REFRESH_TTL', 30 * 86400),
    });
  } else if (mode === 'cloudflare-access') {
    // Cloudflare Access is the authorization server; cloudflared on this host forwards the
    // signed-in identity as the Cf-Access-Jwt-Assertion header, so only a loopback peer counts.
    if (!isLoopbackBind(bind)) throw new Error('POKI_OAUTH=cloudflare-access needs POKI_MCP_BIND on loopback (127.0.0.1): only cloudflared on this host may reach the daemon');
    const team = env.POKI_CF_ACCESS_TEAM;
    if (!team || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(team)) throw new Error('POKI_OAUTH=cloudflare-access needs POKI_CF_ACCESS_TEAM, the team name in https://<team>.cloudflareaccess.com');
    const aud = env.POKI_CF_ACCESS_AUD;
    if (!aud || !/^[A-Za-z0-9]{16,128}$/.test(aud)) throw new Error('POKI_OAUTH=cloudflare-access needs POKI_CF_ACCESS_AUD, the Application Audience (AUD) tag of the Access application');
    const subjects = list(env.POKI_OAUTH_ALLOWED_SUBJECTS);
    if (subjects.length === 0) throw new Error('POKI_OAUTH=cloudflare-access needs POKI_OAUTH_ALLOWED_SUBJECTS: the email of the one account allowed to use this phone');
    const issuer = `https://${team.toLowerCase()}.cloudflareaccess.com`;
    Object.assign(config, { issuer, jwksUrl: `${issuer}/cdn-cgi/access/certs`, audience: aud, allowedSubjects: subjects, allowedAlgorithms: ['RS256'], requiredScopes: [] });
  } else {
    const issuer = env.POKI_OAUTH_ISSUER;
    if (!issuer || !/^https:\/\//.test(issuer)) throw new Error('POKI_OAUTH=external needs POKI_OAUTH_ISSUER, the https issuer URL of the authorization server');
    const subjects = list(env.POKI_OAUTH_ALLOWED_SUBJECTS);
    if (subjects.length === 0) throw new Error('POKI_OAUTH=external needs POKI_OAUTH_ALLOWED_SUBJECTS: the subject or email of the one account allowed to use this phone');
    const required = list(env.POKI_OAUTH_REQUIRED_SCOPES);
    Object.assign(config, {
      issuer,
      jwksUrl: env.POKI_OAUTH_JWKS_URL,
      audience: env.POKI_OAUTH_AUDIENCE || `${origin}/mcp`,
      allowedSubjects: subjects,
      scopes: required.length ? required : undefined,
      requiredScopes: required,
    });
  }
  return config;
}

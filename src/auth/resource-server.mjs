// The daemon as an OAuth 2.1 resource server (MCP authorization spec): it publishes Protected
// Resource Metadata (RFC 9728) and accepts only access tokens issued for its own /mcp URL.
import { OAuthError, OAuthErrorCode, verifyBearerToken, bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { verifyJwt, JwtError } from './jwt.mjs';
import { openCors, sendJson, sendWebResponse } from './http.mjs';

const invalid = message => new OAuthError(OAuthErrorCode.InvalidToken, message);

// Verifies JWTs from the built-in authorization server, checked against its live grants.
export function builtinVerifier(config, authorizationServer) {
  return {
    async verifyAccessToken(token) {
      let claims;
      try { claims = verifyJwt(token, { keys: authorizationServer.jwks.keys, issuer: config.issuer, audience: config.resource, allowedAlgorithms: ['EdDSA'] }); }
      catch (error) { throw invalid(error instanceof JwtError ? error.message : 'Invalid token'); }
      if (claims.sub !== authorizationServer.account.username) throw invalid('Token subject is not the allowed account');
      if (typeof claims.sid !== 'string' || !authorizationServer.grantActive(claims.sid)) throw invalid('Token grant has been revoked');
      return authInfo(token, claims, config);
    },
  };
}

// Verifies JWTs from an external authorization server against its JWKS, and only for the
// allowlisted subject.
export function externalVerifier(config, fetchImpl = fetch) {
  let keys = [], fetchedAt = 0, refreshing;
  async function jwksUrl() {
    if (config.jwksUrl) return config.jwksUrl;
    for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const issuer = new URL(config.issuer);
      const url = new URL(`${suffix}${issuer.pathname === '/' ? '' : issuer.pathname}`, issuer.origin);
      const response = await fetchImpl(url).catch(() => undefined);
      if (response?.ok) { const metadata = await response.json(); if (metadata.jwks_uri) return metadata.jwks_uri; }
    }
    throw new Error(`Cannot discover jwks_uri for ${config.issuer}; set POKI_OAUTH_JWKS_URL`);
  }
  async function refresh(force) {
    if (!force && keys.length && Date.now() - fetchedAt < 600000) return;
    if (force && Date.now() - fetchedAt < 30000) return; // At most one forced refetch every 30 s.
    refreshing ??= (async () => {
      try {
        const response = await fetchImpl(await jwksUrl());
        if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`);
        const body = await response.json();
        if (!Array.isArray(body.keys)) throw new Error('JWKS has no keys');
        keys = body.keys; fetchedAt = Date.now();
      } finally { refreshing = undefined; }
    })();
    await refreshing;
  }
  return {
    async verifyAccessToken(token) {
      try { await refresh(false); } catch (error) { throw new OAuthError(OAuthErrorCode.ServerError, error.message); }
      let claims;
      const check = () => verifyJwt(token, { keys, issuer: config.issuer, audience: config.audience });
      try { claims = check(); }
      catch (error) {
        if (!error.unknownKey) throw invalid(error instanceof JwtError ? error.message : 'Invalid token');
        try { await refresh(true); claims = check(); } catch (retry) { throw invalid(retry instanceof JwtError ? retry.message : 'Invalid token'); }
      }
      const identities = [claims.sub, claims.email].filter(v => typeof v === 'string');
      if (!identities.some(id => config.allowedSubjects.includes(id))) throw invalid('Token subject is not the allowed account');
      return authInfo(token, claims, config);
    },
  };
}

function authInfo(token, claims, config) {
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : Array.isArray(claims.scp) ? claims.scp : [];
  return {
    token, scopes, expiresAt: claims.exp,
    clientId: String(claims.client_id ?? claims.azp ?? claims.cid ?? ''),
    resource: new URL(config.resource),
    extra: { subject: claims.sub, grant: typeof claims.sid === 'string' ? claims.sid : undefined },
  };
}

export function protectedResourceMetadata(config) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Poki MCP',
    ...(config.scopes?.length ? { scopes_supported: config.scopes } : {}),
  };
}

// Handles the metadata routes; returns true when it answered.
export function servesMetadata(req, res, path) {
  return path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp';
}

export function sendMetadata(req, res, config) {
  if (req.method === 'OPTIONS') { res.writeHead(204, openCors); res.end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
  sendJson(res, 200, protectedResourceMetadata(config), openCors);
}

// Resolves to AuthInfo, or undefined after answering with the 401/403 challenge.
export async function authenticate(req, res, config, verifier, corsHeaders = {}) {
  const options = { verifier, requiredScopes: config.requiredScopes, resourceMetadataUrl: config.resourceMetadataUrl };
  try {
    return await verifyBearerToken(req.headers.authorization, { ...options, expectedResource: new URL(config.resource) });
  } catch (error) {
    await sendWebResponse(res, bearerAuthChallengeResponse(error, options), corsHeaders);
  }
}

// Small Node HTTP helpers shared by the OAuth endpoints.
export const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
export const openCors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate' };

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function sendOAuthError(res, status, error, description, headers = {}) {
  sendJson(res, status, { error, ...(description ? { error_description: description } : {}) }, { ...noStore, ...headers });
}

export async function readBody(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readForm(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const body = await readBody(req);
  if (type === 'application/json') {
    const parsed = JSON.parse(body || '{}');
    return new Map(Object.entries(parsed).filter(([, v]) => typeof v === 'string'));
  }
  if (type !== 'application/x-www-form-urlencoded') throw Object.assign(new Error('Send application/x-www-form-urlencoded'), { status: 415 });
  const params = new URLSearchParams(body), out = new Map();
  for (const [key, value] of params) {
    if (out.has(key)) throw Object.assign(new Error(`Parameter ${key} was sent more than once`), { status: 400 });
    out.set(key, value);
  }
  return out;
}

export async function readJson(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('Send application/json'), { status: 415 });
  const body = await readBody(req);
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Body is not valid JSON'), { status: 400 }); }
}

// Writes a web-standard Response (from the MCP SDK helpers) to a Node response.
export async function sendWebResponse(res, response, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

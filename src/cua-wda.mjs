// A second backend for the computer-use profile (POKI_CUA_BACKEND=wda): WebDriverAgent running on
// the phone, reached over HTTP at POKI_WDA_URL (W3C WebDriver plus WDA's extensions). Fork-only.
//
// It is a view of the device context with the few methods cua.mjs uses answered by WDA instead of
// the bridge: capture (a screenshot), bridge ax (the source tree, flattened) and launch_app, input
// (tap, drag, long_press, pinch, key, button, type_keys) and screenSize. cua.mjs runs unchanged on it,
// so look and do answer the same way on either backend. One WDA session is kept and made again when
// WDA says it is gone.

const json = value => JSON.stringify(value);
const truthy = value => value === true || value === 1 || value === '1' || value === 'true';

class WdaError extends Error {
  constructor(message, { status, delivered } = {}) { super(message); this.status = status; this.delivered = delivered; }
}

export class Wda {
  constructor(url, { fetch: fetcher = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.url = String(url).replace(/\/+$/, ''); this.fetch = fetcher; this.timeoutMs = timeoutMs;
  }
  async raw(method, path, body, timeoutMs = this.timeoutMs) {
    let response;
    try {
      response = await this.fetch(`${this.url}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : json(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // Refused: the runner is down, and nothing reached the phone. It is reported, not retried.
      if (error.cause?.code === 'ECONNREFUSED') throw new WdaError(`WebDriverAgent is not running at ${this.url} (connection refused); its serve-mode launcher has to be up`, { delivered: 'not_sent' });
      // No answer: the request may or may not have reached the phone.
      throw new WdaError(`WebDriverAgent did not answer ${method} ${path}: ${error.cause?.code ?? error.message}`, { delivered: 'unknown' });
    }
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { value: text }; }
    const failure = parsed?.value?.error ?? (response.ok ? undefined : `HTTP ${response.status}`);
    if (failure) throw new WdaError(`WebDriverAgent ${method} ${path}: ${parsed?.value?.message ?? failure}`.split('\n')[0], { status: response.status, delivered: 'not_sent', ...(parsed?.value?.error ? { code: parsed.value.error } : {}) });
    return parsed.value ?? parsed;
  }
  async session() {
    if (this.id) return this.id;
    this.opening ??= this.raw('POST', '/session', { capabilities: { alwaysMatch: {} } }).then(value => { this.id = value.sessionId ?? value.capabilities?.sessionId; if (!this.id) throw new WdaError('WebDriverAgent opened no session'); return this.id; }).finally(() => { this.opening = undefined; });
    return this.opening;
  }
  // A request inside the session, made again once on a new session when WDA no longer knows it.
  async call(method, path, body, timeoutMs) {
    const id = await this.session();
    try { return await this.raw(method, `/session/${id}${path}`, body, timeoutMs); }
    catch (error) {
      if (!(error.status === 404 || /invalid session id/i.test(error.message))) throw error;
      if (this.id === id) this.id = undefined;
      return this.raw(method, `/session/${await this.session()}${path}`, body, timeoutMs);
    }
  }
}

// WDA's JSON source as a flat list in the shape the bridge's accessibility read has.
export function flatten(root) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    const r = node.rect ?? {};
    const visible = node.isVisible === undefined ? true : truthy(node.isVisible);
    if (depth > 0 && visible && r.width > 0 && r.height > 0) out.push({
      type: String(node.type ?? 'Other').replace(/^XCUIElementType/, ''), label: node.label ?? node.name ?? undefined, value: node.value ?? undefined,
      identifier: node.name ?? undefined, x: r.x, y: r.y, width: r.width, height: r.height, enabled: node.isEnabled === undefined ? true : truthy(node.isEnabled), depth,
    });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

// The source and the app in front, together. Leaving out visible (by far the most expensive attribute:
// 2 s against 0.6 s for Settings), accessible, enabled and index; what is on screen is decided from
// the frames against the window size instead.
async function readSource(wda) {
  const [source, app] = await Promise.all([wda.call('GET', '/source?format=json&excluded_attributes=visible,accessible,enabled,index'), wda.call('GET', '/wda/activeAppInfo').catch(() => undefined)]);
  const tree = typeof source === 'string' ? JSON.parse(source) : source;
  return { elements: flatten(tree), foreground: app ? { bundle_id: app.bundleId, name: app.name ?? tree?.label, pid: app.pid } : { name: tree?.label } };
}

const buttons = { home: 'home', volume_up: 'volumeUp', 'volume-up': 'volumeUp', volume_down: 'volumeDown', 'volume-down': 'volumeDown' };
const keyText = { return: '\n', enter: '\n', delete: '\b', backspace: '\b', tab: '\t', space: ' ', escape: '\u001b' };

// The device context as seen through WDA, kept per device context so its state (refs, last read)
// lasts across calls.
export function wdaContext(ctx, url = process.env.POKI_WDA_URL) {
  if (ctx.wdaView) return ctx.wdaView;
  if (!url) throw new Error('POKI_CUA_BACKEND=wda needs POKI_WDA_URL, the WebDriverAgent address, such as http://100.x.y.z:8100.');
  const wda = new Wda(url);
  const view = Object.create(ctx);
  Object.assign(view, {
    wda, size: undefined, cua: undefined,
    async target() { return { id: 'wda', kind: 'physical', name: 'WebDriverAgent' }; },
    liveScreen() { return undefined; },
    async screenSize() {
      if (!view.size) { const s = await wda.call('GET', '/window/size'); view.size = { device: 'wda', width: s.width, height: s.height }; }
      return view.size;
    },
    async capture() {
      // The tree read that follows every screenshot starts with it: WDA answers both at once.
      view.pendingSource = { at: performance.now(), promise: readSource(wda) };
      view.pendingSource.promise.catch(() => {});
      const [png, size] = await Promise.all([wda.call('GET', '/screenshot'), view.screenSize()]);
      return { id: String(Date.now()), device: 'wda', width: size.width, height: size.height, data: Buffer.from(png, 'base64'), at: Date.now() };
    },
    async bridge(request) {
      if (request.op === 'ax') {
        const pending = view.pendingSource && performance.now() - view.pendingSource.at < 5000 ? view.pendingSource.promise : undefined;
        view.pendingSource = undefined;
        return pending ?? readSource(wda);
      }
      if (request.op === 'launch_app') { await wda.call('POST', '/wda/apps/launch', { bundleId: request.bundle_id }); return { bundle_id: request.bundle_id }; }
      throw new Error(`${request.op} is not available on the WebDriverAgent backend`);
    },
    // Inputs answer like the bridge's: sent, or isError with outcome not_sent or unknown.
    async input(request) {
      try {
        await send(wda, request, () => view.screenSize());
        return { sent: true };
      } catch (error) {
        return { isError: true, error: error.message, outcome: error.delivered ?? 'unknown' };
      }
    },
  });
  ctx.wdaView = view;
  return view;
}

async function send(wda, request, size) {
  switch (request.op) {
    case 'tap': return wda.call('POST', '/wda/tap', { x: request.x, y: request.y });
    case 'long_press': return wda.call('POST', '/wda/touchAndHold', { x: request.x, y: request.y, duration: (request.duration_ms ?? 600) / 1000 });
    case 'drag': return wda.call('POST', '/wda/dragfromtoforduration', { fromX: request.x1, fromY: request.y1, toX: request.x2, toY: request.y2, duration: Math.max(0.05, (request.hold_ms ?? 0) / 1000) }, 15000);
    case 'pinch': {
      // Two fingers apart (or together) along a horizontal line through the point, as W3C actions.
      const { x, y } = request, a = request.start_distance / 2, b = request.end_distance / 2, ms = request.duration_ms ?? 500;
      const finger = (id, sign) => ({ type: 'pointer', id, parameters: { pointerType: 'touch' }, actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(x + sign * a), y: Math.round(y) }, { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: ms, x: Math.round(x + sign * b), y: Math.round(y) }, { type: 'pointerUp', button: 0 }] });
      return wda.call('POST', '/actions', { actions: [finger('f1', -1), finger('f2', 1)] });
    }
    case 'type_keys': {
      if (request.clear) {
        // The field being edited, emptied before the new text goes in.
        const active = await wda.call('GET', '/element/active').catch(() => undefined);
        const id = active?.ELEMENT ?? active?.['element-6066-11e4-a52e-4f735466cecf'];
        if (id) await wda.call('POST', `/element/${id}/clear`, {});
      }
      return wda.call('POST', '/wda/keys', { value: [...request.text] });
    }
    case 'type_text': return wda.call('POST', '/wda/keys', { value: [...request.text] });
    case 'key': {
      const text = keyText[String(request.key).toLowerCase()] ?? (String(request.key).length === 1 ? request.key : undefined);
      if (text === undefined) throw new WdaError(`key ${request.key} has no WebDriverAgent equivalent`, { delivered: 'not_sent' });
      return wda.call('POST', '/wda/keys', { value: [text] });
    }
    case 'button': {
      const name = String(request.button).toLowerCase();
      if (name === 'lock' || name === 'power') return wda.call('POST', '/wda/lock', {});
      if (name === 'home') return wda.call('POST', '/wda/homescreen', {});
      if (!buttons[name]) throw new WdaError(`button ${request.button} has no WebDriverAgent equivalent`, { delivered: 'not_sent' });
      return wda.call('POST', '/wda/pressButton', { name: buttons[name] });
    }
    default: throw new WdaError(`${request.op} is not available on the WebDriverAgent backend`, { delivered: 'not_sent' });
  }
}

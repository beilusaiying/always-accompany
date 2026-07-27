// 本体版：用运行时原生 WebSocket（Deno / Node≥22 全局），零 npm 依赖——
// 原独立库用 npm 'ws'，进本体后裸说明符在 Deno 后端解析不可靠且引入外部依赖
import http from 'node:http';
import { state } from './state.mjs';

const WebSocket = globalThis.WebSocket;

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
const MAX_BUFFERED_EVENTS = 10000;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const BROWSER_LEVEL = (method) =>
  method.startsWith('Target.') || method.startsWith('Browser.');

let ws = null;
let nextMessageId = 1;
const pending = new Map();
const events = [];
const eventWaiters = [];
const pageEnabledSessions = new Set();
const pendingDialogs = new Map();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse response from ${url}: ${data}`)); }
      });
    }).on('error', reject);
  });
}

function httpPut(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ id: data.trim() }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function connect(port = 9222) {
  state.debugPort = port;
  const version = await httpGet(`http://localhost:${port}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('Chrome not running with --remote-debugging-port or webSocketDebuggerUrl not found');

  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    // 原生 WebSocket 事件 API（onopen/onmessage/...），非 npm ws 的 .on()
    ws.onopen = () => {
      state.send = async (req) => {
        if (!req || typeof req !== 'object' || !req.method) {
          throw new Error(`unsupported request: ${JSON.stringify(req)}`);
        }
        const response = await browserCdp(req.method, req.params || {}, req.session_id);
        return { result: response.result || {} };
      };
      resolve();
    };
    ws.onmessage = (ev) => handleMessage(String(ev.data));
    ws.onerror = (ev) => {
      const msg = ev?.message || 'WebSocket error';
      handleSendError(msg, 'WS_ERROR');
      reject(new Error(msg));
    };
    ws.onclose = () => {
      handleSendError('WebSocket closed', 'WS_CLOSED');
    };
  });
}

export function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  state.send = null;
  state.sessionId = null;
  state.sessionTargetId = null;
  state.sessionAt = 0;
}

function rawCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected. Call connect() first.');
  }
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id, method, params,
    ...(sessionId ? { sessionId } : {}),
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (response) => { clearTimeout(timer); resolve(response); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      ws.send(payload);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export async function browserCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId);
  }
  const explicit = sessionId !== undefined;
  let effective = sessionId;
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = await ensureSession();
  }
  try {
    return await rawCdp(method, params, effective, timeoutMs);
  } catch (error) {
    const lost = SESSION_LOST.test(error?.message || '');
    if (lost && !explicit && !BROWSER_LEVEL(method)) {
      invalidateSession();
      const fresh = await ensureSession();
      return rawCdp(method, params, fresh, timeoutMs);
    }
    throw error;
  }
}

export async function ensureSession() {
  if (state.sessionId && Date.now() - state.sessionAt < SESSION_TTL_MS) {
    return state.sessionId;
  }
  if (state.sessionInflight) {
    return state.sessionInflight;
  }
  state.sessionInflight = (async () => {
    try {
      const tabs = await listTabsHTTP();
      const preferred = state.preferredTargetId
        ? tabs.find((t) => t.targetId === state.preferredTargetId)
        : null;
      const active = preferred || tabs[0];
      if (!active) {
        throw new Error('no active tab to attach session');
      }
      const targetId = active.targetId;
      if (targetId !== state.sessionTargetId || !state.sessionId) {
        const attached = await rawCdp('Target.attachToTarget', { targetId, flatten: true });
        state.sessionId = attached.result?.sessionId || attached.sessionId;
        state.sessionTargetId = targetId;
      }
      await enablePageEvents(state.sessionId);
      state.sessionAt = Date.now();
      return state.sessionId;
    } finally {
      state.sessionInflight = null;
    }
  })();
  return state.sessionInflight;
}

export async function listTabsHTTP(port) {
  const p = port || state.debugPort;
  const tabs = await httpGet(`http://localhost:${p}/json`);
  return tabs.filter(t => t.type === 'page').map(t => ({
    targetId: t.id,
    title: t.title || '',
    url: t.url || '',
    active: false,
  }));
}

export async function createTabHTTP(url, port) {
  const p = port || state.debugPort;
  const encoded = encodeURIComponent(url || 'about:blank');
  const tab = await httpPut(`http://localhost:${p}/json/new?${encoded}`);
  return { targetId: tab.id };
}

export function invalidateSession() {
  if (state.sessionId) {
    pageEnabledSessions.delete(state.sessionId);
    pendingDialogs.delete(state.sessionId);
  }
  state.sessionId = null;
  state.sessionTargetId = null;
  state.sessionAt = 0;
}

export function setPreferredTarget(targetId) {
  state.preferredTargetId = targetId || null;
}

export function clearPreferredTarget() {
  state.preferredTargetId = null;
}

export function drainBrowserEvents() {
  return events.splice(0, events.length);
}

export function waitForBrowserEvent(predicate, timeoutMs = state.defaultTimeout) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate, resolve, reject,
      timer: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(new Error('page.waitForEvent timed out'));
      }, timeoutMs),
    };
    eventWaiters.push(waiter);
  });
}

export function pendingDialog(sessionId = state.sessionId) {
  if (sessionId && pendingDialogs.has(sessionId)) {
    return { ...pendingDialogs.get(sessionId) };
  }
  return null;
}

async function enablePageEvents(sessionId) {
  if (!sessionId || pageEnabledSessions.has(sessionId)) return;
  try {
    await rawCdp('Page.enable', {}, sessionId);
    pageEnabledSessions.add(sessionId);
  } catch { /* best-effort */ }
}

function handleSendError(message, error_code) {
  if (pending.size === 0) return;
  const error = new Error(message);
  error.error_code = error_code;
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}

function handleMessage(message) {
  let data;
  try { data = JSON.parse(message); } catch { return; }

  if (Object.hasOwn(data, 'id')) {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) {
      entry.reject(new Error(data.error.message || data.error));
      return;
    }
    entry.resolve(data);
    return;
  }

  if (data.method === 'Target.detachedFromTarget' || data.method === 'Target.targetDestroyed') {
    const sessionId = data.params?.sessionId || data.sessionId;
    if (sessionId) {
      pageEnabledSessions.delete(sessionId);
      pendingDialogs.delete(sessionId);
    }
    const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
    if (targetId && targetId === state.sessionTargetId) {
      invalidateSession();
    }
  }

  if (data.method === 'Page.javascriptDialogOpening') {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) pendingDialogs.set(sessionId, data.params || {});
  } else if (data.method === 'Page.javascriptDialogClosed') {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) pendingDialogs.delete(sessionId);
  }

  events.push(data);
  if (events.length > MAX_BUFFERED_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  }

  for (const waiter of [...eventWaiters]) {
    let matched = false;
    try { matched = waiter.predicate(data); }
    catch (error) {
      clearTimeout(waiter.timer);
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    clearTimeout(waiter.timer);
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve(data);
  }
}

export function snapshotRefsToRefMap(refMap, refs = []) {
  refMap.clear();
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    if (ref.backendNodeId === undefined || ref.backendNodeId === null) continue;
    refMap.add(String(ref.backendNodeId), ref.backendNodeId, ref.role, ref.name, undefined);
  }
}

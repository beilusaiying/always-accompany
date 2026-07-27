import {
  ensureSession, invalidateSession, pendingDialog,
  setPreferredTarget, clearPreferredTarget,
  listTabsHTTP, createTabHTTP, browserCdp,
} from '../transport.mjs';
import { cdp, evaluate } from '../cdp.mjs';
import { state } from '../state.mjs';
import { waitForDocumentLoad } from './load.mjs';

export const INTERNAL_URL_PREFIXES = [
  'chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:',
];

export async function goto(url, options = {}) {
  const navigation = await cdp('Page.navigate', { url });
  const loaded = options.waitUntil === 'commit'
    ? false
    : await waitForDocumentLoad({
        timeout: options.timeout ?? 20000,
        until: options.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load',
      });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) await state.sleep(settle);
  return { navigation, loaded };
}

export async function pageInfo() {
  await ensureSession();
  const dialog = pendingDialog();
  if (dialog) return { dialog };

  const expression = `(() => {
    const root = document.documentElement;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      w: innerWidth, h: innerHeight,
      sx: scrollX, sy: scrollY,
      pw: root?.scrollWidth ?? innerWidth,
      ph: root?.scrollHeight ?? innerHeight,
    });
  })()`;
  return JSON.parse(await evaluate(expression));
}

export async function listTabs(options = {}) {
  const includeChrome = options.includeChrome ?? true;
  const tabs = await listTabsHTTP();
  return tabs
    .filter((tab) =>
      includeChrome || !INTERNAL_URL_PREFIXES.some((prefix) => (tab.url || '').startsWith(prefix))
    )
    .map((tab) => ({
      targetId: tab.targetId,
      title: tab.title || '',
      url: tab.url || '',
      active: Boolean(tab.active),
    }));
}

export async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) throw new Error('no active browser tab');
  return { targetId: active.targetId, url: active.url, title: active.title };
}

export async function switchTab(target) {
  const targetId = targetIdFrom(target, 'switchTab');
  const tabs = await listTabs();
  currentTargetFrom(tabs, targetId, 'switchTab');
  await cdp('Target.activateTarget', { targetId });
  invalidateSession();
  setPreferredTarget(targetId);
  return targetId;
}

export async function newTab(url = 'about:blank') {
  const result = await createTabHTTP(url);
  if (!result.targetId) throw new Error('newTab returned no targetId');
  return result.targetId;
}

export async function openOrReuseTab(url, options = {}) {
  const tabs = await listTabs({ includeChrome: false });
  const match = options.match || 'exact';
  const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
  if (existing) {
    await switchTab(existing.targetId);
    if (options.wait) await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
    const settle = Number(options.settle ?? 0);
    if (settle > 0) await state.sleep(settle);
    return { ...existing, active: true, reused: true };
  }
  const targetId = await newTab(url);
  if (options.wait !== false) await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) await state.sleep(settle);
  return { targetId, url, title: '', active: true, reused: false };
}

export async function closeTab(target = undefined) {
  const tabs = await listTabs();
  const targetId = target === undefined
    ? (tabs.find((tab) => tab.active) || tabs[0])?.targetId
    : targetIdFrom(target, 'closeTab');
  if (!targetId) throw new Error('closeTab requires a targetId');
  currentTargetFrom(tabs, targetId, 'closeTab');
  await cdp('Target.closeTarget', { targetId });
  invalidateSession();
  if (state.preferredTargetId === targetId) clearPreferredTarget();
  if (tabs.length > 1) await waitForClosedTarget(targetId);
  return targetId;
}

export async function ensureRealTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) return null;
  const current = await currentTab().catch(() => null);
  if (current?.url && !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
    return current;
  }
  await switchTab(tabs[0].targetId);
  return tabs[0];
}

/**
 * 同步到用户正在浏览的标签页（人机共享同一浏览器的核心同步原语）。
 * Chrome /json 与 Target.getTargets 都不含焦点信息，故逐 tab 短暂附着读
 * document.visibilityState + hasFocus 判定：visible+focused > visible > 无法判定报错。
 * 命中后 preferredTarget 指向该 tab（后续所有操作作用于用户所见页面）。
 */
export async function syncToUserTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) throw new Error('no browser tabs to sync');
  const states = [];
  for (const tab of tabs) {
    try {
      const attached = await browserCdp('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
      const sessionId = attached.result?.sessionId || attached.sessionId;
      if (!sessionId) continue;
      try {
        const r = await browserCdp('Runtime.evaluate', {
          expression: 'JSON.stringify({v: document.visibilityState, f: document.hasFocus()})',
          returnByValue: true,
        }, sessionId);
        const info = JSON.parse(r.result?.result?.value || '{}');
        states.push({ tab, visible: info.v === 'visible', focused: !!info.f });
      } finally {
        await browserCdp('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    } catch { /* 个别 tab 附着失败（crash 页等）不阻断整体判定 */ }
  }
  const best = states.find((s) => s.visible && s.focused) || states.find((s) => s.visible) || null;
  if (!best) throw new Error('cannot determine user-active tab (no visible tab found)');
  invalidateSession();
  setPreferredTarget(best.tab.targetId);
  return { targetId: best.tab.targetId, url: best.tab.url, title: best.tab.title };
}

export async function iframeTarget(urlSubstring) {
  const targets = (await cdp('Target.getTargets')).targetInfos || [];
  return targets.find(
    (t) => t.type === 'iframe' && (t.url || '').includes(urlSubstring)
  )?.targetId || null;
}

function tabMatchesUrl(tabUrl, wantedUrl, match) {
  if (!tabUrl) return false;
  if (match === 'includes') return tabUrl.includes(wantedUrl);
  let tab, wanted;
  try { tab = new URL(tabUrl); wanted = new URL(wantedUrl); }
  catch { return tabUrl === wantedUrl; }
  if (match === 'origin') return tab.origin === wanted.origin;
  if (match === 'origin+path') {
    return tab.origin === wanted.origin && trimSlash(tab.pathname) === trimSlash(wanted.pathname);
  }
  return tab.href === wanted.href;
}

function trimSlash(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function targetIdFrom(target, operation) {
  const targetId = typeof target === 'string' ? target
    : target && typeof target === 'object' ? target.targetId : undefined;
  if (typeof targetId !== 'string' || !targetId) {
    throw new Error(`${operation} requires a targetId; received ${JSON.stringify(target)}`);
  }
  return targetId;
}

function currentTargetFrom(tabs, targetId, operation) {
  const tab = tabs.find((c) => c.targetId === targetId);
  if (tab) return tab;
  const available = tabs.map(({ targetId, title, url }) => ({ targetId, title, url }));
  throw new Error(
    `${operation} target not found: ${JSON.stringify(targetId)}. ` +
    `Available tabs: ${JSON.stringify(available)}`
  );
}

async function waitForClosedTarget(targetId) {
  const deadline = state.now() + 2000;
  while (true) {
    const tabs = await listTabs();
    if (!tabs.some((tab) => tab.targetId === targetId)) return tabs;
    if (state.now() >= deadline) throw new Error(`closeTab timed out: ${JSON.stringify(targetId)}`);
    await state.sleep(50);
  }
}

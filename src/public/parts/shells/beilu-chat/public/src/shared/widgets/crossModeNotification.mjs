/**
 * crossModeNotification.mjs — 跨模式通知弹窗 + 通知历史中心（W17 机制2 + W18 Q4=A）
 *
 * 功能链：
 *   后端/其它模式 → showCrossModeNotification(data) → _pushNotifyHistory（localStorage 近 20 条）
 *   → 创建 .cross-mode-notification DOM → 右上角弹出（最多同时 3 个）
 *   → 10s 自动消失 / 用户点"去查看" → 跳转对应 Tab
 *   顶栏 🔔 图标 → getNotifyHistory() → 读 localStorage 历史（24h 内有效）
 *   clearNotifyHistory() → 清空历史 → 派发 beilu:notify-history-update
 *   collectBackgroundTasks() → 聚合三类后台任务（本窗/跨窗/待审批）→ 通知中心「进行中」区
 *   getNotifyPrefs()/setNotifyPref() → 通知偏好三开关（角标/页内弹窗/桌面通知，🔔 通知中心可设，
 *   缺省=DEFAULTS.notify，改动派发 beilu:notify-prefs-update 供角标消费方即时响应）
 *   （原 floatingTaskOrb 动态小窗职责，凛倾 2026-07-07 统一并入通知中心，小窗已删）
 *
 * why：
 *   多模式（chat/work/code/smart）并行时，非当前 Tab 的模式产生需要用户关注的事件；
 *   右上角弹窗让用户在不切换 Tab 的情况下感知并快速跳转；
 *   10s 弹窗消失后历史仍可在顶栏 🔔 回看（FT-D9），防止漏看重要通知。
 *
 * 关联链：
 *   ← websocket.mjs / 各模式运行时（showCrossModeNotification 调用）
 *   ← 顶栏 🔔 按钮（getNotifyHistory / clearNotifyHistory 调用）
 *   → scripts/desktopNotify.mjs（桌面通知，可选）
 *   → shared/state/storage.mjs（KEYS.BEILU_NOTIFY_HISTORY：localStorage 历史持久化）
 *
 * 影响范围：
 *   DOM：body 下 .cross-mode-notification 节点（10s 后自移除）；
 *   localStorage：beilu-notify-history（近 20 条，24h 有效）；
 *   事件：beilu:notify-history-update（🔔 图标角标更新）。
 *
 * 使用效果：
 *   work 模式完成任务时，chat Tab 右上角弹通知；点击跳转 work Tab；
 *   顶栏 🔔 可查看最近 24h 内最多 20 条历史通知。
 */

import { escapeHtml } from "../state/utils.mjs";
import { notifyDesktop } from "../../../../../../scripts/desktopNotify.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { TAB_TO_MODE, modeToTab, MODE_BADGE } from "../state/modeTabMap.mjs"; // D2 收口：通知来源标签接模式徽章单源
import { DEFAULTS } from "../../config/defaults.mjs"; // T2 config 收口：通知数值单源

/** 通知队列（同时最多显示 DEFAULTS.notify.maxVisible 个） */
const MAX_VISIBLE = DEFAULTS.notify.maxVisible;
const _notifications = [];

/**
 * 通知偏好（用户可设，🔔 通知中心三开关）。缺省值单源=DEFAULTS.notify；
 * desktop 键复用 desktopNotify.mjs 既有 OPT_OUT_KEY（beilu-browser-notify），
 * notifyDesktop 内部自会按该键短路，这里读出仅供开关 UI 显示状态。
 */
const _PREF_KEYS = {
  badges: KEYS.BEILU_NOTIFY_BADGES,
  popup: KEYS.BEILU_NOTIFY_POPUP,
  desktop: KEYS.BEILU_BROWSER_NOTIFY,
};

export function getNotifyPrefs() {
  const read = (k, dflt) => {
    const v = storage.get(_PREF_KEYS[k]);
    return v == null ? dflt : v !== "false";
  };
  return {
    badges: read("badges", DEFAULTS.notify.badges),
    popup: read("popup", DEFAULTS.notify.popup),
    desktop: read("desktop", DEFAULTS.notify.desktop),
  };
}

export function setNotifyPref(name, enabled) {
  if (!(name in _PREF_KEYS)) return;
  storage.set(_PREF_KEYS[name], String(!!enabled));
  // 角标消费方（smart 活动栏角标 / 🔔 badge）即时响应
  window.dispatchEvent(new CustomEvent("beilu:notify-prefs-update"));
}

/** FT-D9(凛倾批「做」): 通知中心历史——10s 弹窗消失后仍可在顶栏 🔔 回看（localStorage 近 HISTORY_MAX 条） */
const HISTORY_KEY = KEYS.BEILU_NOTIFY_HISTORY;
const HISTORY_MAX = DEFAULTS.notify.historyMax;
const HISTORY_MAX_AGE_MS = DEFAULTS.notify.historyMaxAgeMs;

export function getNotifyHistory() {
  try {
    const raw = JSON.parse(storage.get(HISTORY_KEY) || "[]");
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    const fresh = raw.filter(n => n.at >= cutoff);
    if (fresh.length < raw.length) storage.set(HISTORY_KEY, JSON.stringify(fresh));
    return fresh;
  } catch { return []; }
}

function _pushNotifyHistory(data) {
  try {
    const list = getNotifyHistory();
    list.unshift({
      at: Date.now(),
      fromMode: data.fromMode || "",
      type: data.type || "info",
      message: String(data.message || data.title || "").slice(0, 300),
      targetTab: data.targetTab || "",
    });
    storage.set(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    window.dispatchEvent(new CustomEvent("beilu:notify-history-update"));
  } catch { /* 历史写失败不影响弹窗 */ }
}

export function clearNotifyHistory() {
  try { storage.remove(HISTORY_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("beilu:notify-history-update"));
}

/**
 * 聚合三类后台任务为统一形状 {key,title,state,src,onGoto}（通知中心「进行中」区数据源）。
 * 原 floatingTaskOrb._collectTasks 逐字迁入——小窗与通知中心职责重复，凛倾 2026-07-07
 * 「动态窗口删除,所有通知统一到通知那里」：后台任务动态并入 🔔 通知中心，本模块为通知域单一数据面。
 * 三类数据源均有单一 producer（taskOverlay 写 _beiluActiveTasks / websocket.mjs 写
 * _beiluCrossModeTasks / 审批系统写 _beiluPendingApprovals），此处只读不写，
 * 刷新由 beilu:smart-task-update 事件驱动（消费方=settings.mjs 通知中心 render）。
 */
export function collectBackgroundTasks() {
  const out = [];
  // 本窗口进行中
  for (const t of (window._beiluActiveTasks || [])) {
    out.push({
      key: "self:" + (t.id || t.title),
      title: t.title || t.name || t.id || "任务",
      state: "running",
      src: t.mode === "work" ? "工作" : t.mode === "code" ? "代码" : "本窗",
      onGoto: () => window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: modeToTab(t.mode) } })),
    });
  }
  // 别窗口跨模式（F1-2）
  const crossMap = window._beiluCrossModeTasks || {};
  for (const cid of Object.keys(crossMap)) {
    for (const tk of (crossMap[cid]?.tasks || [])) {
      if (!tk || tk.status === "completed") continue;
      out.push({
        key: "cross:" + cid + ":" + (tk.id || tk.content),
        title: tk.content || tk.id || "任务",
        state: tk.status === "in_progress" ? "running" : tk.status === "failed" ? "failed" : "idle",
        src: "别窗",
        // T021 弹出：跳转失败必须可见，不双重静默
        onGoto: () => import("../chat-core/chat.mjs").then(m => { try { m.switchCharacterScope?.(cid); } catch (e) { window._beiluToast?.("跳转对话失败: " + (e?.message || e), "error"); } }).catch((e) => window._beiluToast?.("跳转模块加载失败: " + (e?.message || e), "error")),
      });
    }
  }
  // 待审批
  for (const a of (window._beiluPendingApprovals || [])) {
    out.push({
      key: "appr:" + (a.id || a.title),
      title: a.title || a.message || a.id || "待审批",
      state: "failed", // 红点提醒（需用户处理）
      src: "审批",
      onGoto: () => window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "work" } })),
    });
  }
  return out;
}

/**
 * 显示跨模式通知
 * @param {{ fromMode: string, type: string, title: string, message: string, targetTab: string }} data
 */
export function showCrossModeNotification(data) {
  _pushNotifyHistory(data); // FT-D9: 进历史（弹窗消失后顶栏🔔可回看）——历史是记录，不受弹窗开关影响
  // 用户关闭页内弹窗时只记历史不打扰；桌面通知由 notifyDesktop 内部按自身开关键短路，此处不重复闸
  if (!getNotifyPrefs().popup) return;
  const notif = document.createElement("div");
  notif.className = "cross-mode-notification";

  // [D2 收口 0713] 来源标签接 MODE_BADGE 单源（原内联副本=第三套文案"聊天模式/代码模式"+废弃 file 旧键）。
  //   file=A 通道(beilu-files) 值域可能泄进 fromMode，归一到 code 再查表；原 modeIcons 表零消费=死变量，纯删。
  const _fromMode = data.fromMode === "file" ? "code" : data.fromMode;
  const typeIcons = { approval: '<i data-ic="bell"></i>', error: '<i data-ic="cross"></i>', info: '<i data-ic="info"></i>' };

  notif.innerHTML = `
    <div class="cross-mode-notif-header">
      <span>${typeIcons[data.type] || '<i data-ic="bell"></i>'}</span>
      <span class="cross-mode-notif-from">${MODE_BADGE[_fromMode]?.label || data.fromMode}</span>
      <span class="cross-mode-notif-close">✕</span>
    </div>
    <div class="cross-mode-notif-message">${escapeHtml(data.message || data.title)}</div>
    <div class="cross-mode-notif-actions">
      <button class="cross-mode-notif-btn" data-action="dismiss">忽略</button>
      <button class="cross-mode-notif-btn primary" data-action="goto">去查看</button>
    </div>
  `;

  // 关闭
  const dismiss = () => {
    notif.classList.add("notif-hide");
    setTimeout(() => {
      notif.remove();
      const idx = _notifications.indexOf(notif);
      if (idx >= 0) _notifications.splice(idx, 1);
      repositionNotifications();
    }, 300);
  };

  notif.querySelector(".cross-mode-notif-close")?.addEventListener("click", dismiss);
  notif.querySelector("[data-action='dismiss']")?.addEventListener("click", dismiss);

  notif.querySelector("[data-action='goto']")?.addEventListener("click", () => {
    // 规范化 targetTab：mode名→tab名，非法值回退chat
    let _tab = data.targetTab || "chat";
    if (!(_tab in TAB_TO_MODE)) _tab = modeToTab(_tab);
    window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: _tab } }));
    dismiss();
  });

  // 10秒后自动消失
  setTimeout(dismiss, 10000);

  // 超过最大数量时移除最老的
  while (_notifications.length >= MAX_VISIBLE) {
    const oldest = _notifications.shift();
    oldest?.remove();
  }

  _notifications.push(notif);
  document.body.appendChild(notif);
  repositionNotifications();

  // 补缺口：窗口失焦时升级为 OS 桌面通知（审批/报错/needHelp 原本只在页内弹，失焦看不到）。
  // [2026-07-13 通读修] 原引用 modeLabels——该表已被 D2 收口删除（:173"零消费死变量纯删"漏改此处）
  //   = 每次通知走到这里必抛 ReferenceError（弹窗已显示但桌面通知永不发+中断调用方后续逻辑，
  //   chat.mjs _renderApprovalDock 的审批列表渲染被此打断）。改与 :179 头部标签同源 MODE_BADGE。
  notifyDesktop(`always accompany · ${MODE_BADGE[_fromMode]?.label || data.fromMode || "通知"}`, data.message || data.title, { tag: "beilu-crossmode" });
}

/** 重新定位通知（垂直堆叠） */
function repositionNotifications() {
  let top = 60;
  for (const n of _notifications) {
    n.style.top = `${top}px`;
    top += n.offsetHeight + 8;
  }
}

/**
 * 处理WS广播中的跨模式通知
 * @param {object} extension - reply.extension
 */
export function handleCrossModeNotification(extension) {
  if (extension?._crossModeNotification) {
    showCrossModeNotification(extension._crossModeNotification);
  }
}

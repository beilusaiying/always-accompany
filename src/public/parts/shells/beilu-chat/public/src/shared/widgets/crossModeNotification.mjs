/**
 * crossModeNotification.mjs — 跨模式通知弹窗 + 通知历史中心（W17 机制2 + W18 Q4=A）
 *
 * 功能链：
 *   后端/其它模式 → showCrossModeNotification(data) → _pushNotifyHistory（localStorage 近 20 条）
 *   → 创建 .cross-mode-notification DOM → 按用户策略在右上角堆叠
 *   → 按用户停留时间自动消失 / 用户点"去查看" → 跳转对应 Tab
 *   顶栏 🔔 图标 → getNotifyHistory() → 按用户保留策略读 localStorage 历史
 *   clearNotifyHistory() → 清空历史 → 派发 beilu:notify-history-update
 *   collectBackgroundTasks() → 聚合本窗/跨窗/待审批/工具 Job → 通知中心「进行中」区
 *   getNotifyPrefs()/setNotifyPref() → 通知开关与数值策略（角标/弹窗/桌面、堆叠/停留/历史，🔔 通知中心可设，
 *   缺省=DEFAULTS.notify，改动派发 beilu:notify-prefs-update 供角标消费方即时响应）
 *   （原 floatingTaskOrb 动态小窗职责，凛倾 2026-07-07 统一并入通知中心，小窗已删）
 *
 * why：
 *   多模式（chat/work/code/smart）并行时，非当前 Tab 的模式产生需要用户关注的事件；
 *   右上角弹窗让用户在不切换 Tab 的情况下感知并快速跳转；
 *   弹窗消失后历史仍可在顶栏 🔔 回看（FT-D9），防止漏看重要通知。
 *
 * 关联链：
 *   ← websocket.mjs / 各模式运行时（showCrossModeNotification 调用）
 *   ← 顶栏 🔔 按钮（getNotifyHistory / clearNotifyHistory 调用）
 *   → scripts/desktopNotify.mjs（桌面通知，可选）
 *   → shared/state/storage.mjs（KEYS.BEILU_NOTIFY_HISTORY：localStorage 历史持久化）
 *
 * 影响范围：
 *   DOM：body 下 .cross-mode-notification 节点（按用户停留策略自移除）；
 *   localStorage：beilu-notify-history（条数和有效期按用户策略）；
 *   事件：beilu:notify-history-update（🔔 图标角标更新）。
 *
 * 使用效果：
 *   work 模式完成任务时，chat Tab 右上角弹通知；点击跳转 work Tab；
 *   顶栏 🔔 可查看用户设置范围内的历史通知。
 */

import { escapeHtml } from "../state/utils.mjs";
import { notifyDesktop } from "../../../../../../scripts/desktopNotify.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { TAB_TO_MODE, modeToTab, MODE_BADGE } from "../state/modeTabMap.mjs"; // D2 收口：通知来源标签接模式徽章单源
import { DEFAULTS } from "../../config/defaults.mjs"; // T2 config 收口：通知数值单源

/** 通知队列（容量每次从用户策略读取） */
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
  maxVisible: KEYS.BEILU_NOTIFY_MAX_VISIBLE,
  historyMax: KEYS.BEILU_NOTIFY_HISTORY_MAX,
  historyMaxAgeMs: KEYS.BEILU_NOTIFY_HISTORY_MAX_AGE_MS,
  popupDurationMs: KEYS.BEILU_NOTIFY_POPUP_DURATION_MS,
};

const _NUMBER_PREF_RULES = Object.freeze({
  maxVisible: Object.freeze([1, 20, DEFAULTS.notify.maxVisible]),
  historyMax: Object.freeze([1, 500, DEFAULTS.notify.historyMax]),
  historyMaxAgeMs: Object.freeze([60000, 31536000000, DEFAULTS.notify.historyMaxAgeMs]),
  popupDurationMs: Object.freeze([0, 600000, DEFAULTS.notify.popupDurationMs]),
});

export function getNotifyPrefs() {
  const readBool = (k, dflt) => {
    const v = storage.get(_PREF_KEYS[k]);
    return v == null ? dflt : v !== "false";
  };
  const readNumber = (k) => {
    const [min, max, dflt] = _NUMBER_PREF_RULES[k];
    const raw = storage.get(_PREF_KEYS[k]);
    if (raw == null || String(raw).trim() === "") return dflt;
    const value = Number(raw);
    if (!Number.isFinite(value)) return dflt;
    return Math.max(min, Math.min(max, Math.round(value)));
  };
  return {
    badges: readBool("badges", DEFAULTS.notify.badges),
    popup: readBool("popup", DEFAULTS.notify.popup),
    desktop: readBool("desktop", DEFAULTS.notify.desktop),
    maxVisible: readNumber("maxVisible"),
    historyMax: readNumber("historyMax"),
    historyMaxAgeMs: readNumber("historyMaxAgeMs"),
    popupDurationMs: readNumber("popupDurationMs"),
  };
}

export function setNotifyPref(name, value) {
  if (!(name in _PREF_KEYS)) return;
  if (name in _NUMBER_PREF_RULES) {
    const [min, max] = _NUMBER_PREF_RULES[name];
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`${name} 必须是有效数字`);
    storage.set(_PREF_KEYS[name], String(Math.max(min, Math.min(max, Math.round(numeric)))));
  } else {
    storage.set(_PREF_KEYS[name], String(!!value));
  }
  if (name === "maxVisible") {
    const maxVisible = getNotifyPrefs().maxVisible;
    while (_notifications.length > maxVisible) _notifications.shift()?.remove();
    repositionNotifications();
  }
  // 角标消费方（smart 活动栏角标 / 🔔 badge）即时响应
  window.dispatchEvent(new CustomEvent("beilu:notify-prefs-update"));
}

/** FT-D9(凛倾批「做」): 通知中心历史——10s 弹窗消失后仍可在顶栏 🔔 回看（localStorage 近 HISTORY_MAX 条） */
const HISTORY_KEY = KEYS.BEILU_NOTIFY_HISTORY;

export function getNotifyHistory() {
  try {
    const raw = JSON.parse(storage.get(HISTORY_KEY) || "[]");
    const prefs = getNotifyPrefs();
    const cutoff = Date.now() - prefs.historyMaxAgeMs;
    const fresh = raw.filter(n => n.at >= cutoff).slice(0, prefs.historyMax);
    if (fresh.length < raw.length) storage.set(HISTORY_KEY, JSON.stringify(fresh));
    return fresh;
  } catch { return []; }
}

function _pushNotifyHistory(data) {
  try {
    const prefs = getNotifyPrefs();
    const list = getNotifyHistory();
    list.unshift({
      at: Date.now(),
      fromMode: data.fromMode || "",
      type: data.type || "info",
      message: String(data.message || data.title || "").slice(0, 300),
      targetTab: data.targetTab || "",
    });
    storage.set(HISTORY_KEY, JSON.stringify(list.slice(0, prefs.historyMax)));
    window.dispatchEvent(new CustomEvent("beilu:notify-history-update"));
  } catch { /* 历史写失败不影响弹窗 */ }
}

export function clearNotifyHistory() {
  try { storage.remove(HISTORY_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("beilu:notify-history-update"));
}

/**
 * 聚合后台任务为统一形状 {key,title,state,src,onGoto}（通知中心「进行中」区数据源）。
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
  // 工具 Job：只展示非终态。wait_timeout 仍可能收到迟到结果，不按失败终态移除。
  const terminalToolStates = new Set(["succeeded", "failed", "connection_lost", "orphan_result"]);
  const toolStore = window._beiluToolJobs;
  const toolJobs = toolStore instanceof Map
    ? [...toolStore.values()]
    : Array.isArray(toolStore) ? toolStore : [];
  for (const job of toolJobs) {
    const status = job?.state || job?.status;
    if (!job || terminalToolStates.has(status)) continue;
    const target = job.target ? ` — ${job.target}` : "";
    out.push({
      key: "tool:" + (job.jobId || job.requestId || `${job.tool}:${job.createdAt}`),
      title: `${job.tool || job.jobId || job.requestId}${target}`,
      state: status === "running" || status === "active" ? "running" : "idle",
      src: [job.backendKind, status].filter(Boolean).join(" · "),
      onGoto: () => window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "files" } })),
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
  const prefs = getNotifyPrefs();
  const _fromMode = data.fromMode === "file" ? "code" : data.fromMode;
  // 页面 popup 与 OS 桌面通知是两个独立开关。桌面权限、窗口焦点和桌面通知偏好
  // 仍由 notifyDesktop 单一入口裁决，不能被页面 popup 开关提前截断。
  notifyDesktop(
    `always accompany · ${MODE_BADGE[_fromMode]?.label || data.fromMode || "通知"}`,
    data.message || data.title,
    { tag: "beilu-crossmode" },
  );
  if (!prefs.popup) return;
  const notif = document.createElement("div");
  notif.className = "cross-mode-notification";

  // [D2 收口 0713] 来源标签接 MODE_BADGE 单源（原内联副本=第三套文案"聊天模式/代码模式"+废弃 file 旧键）。
  //   file=A 通道(beilu-files) 值域可能泄进 fromMode，归一到 code 再查表；原 modeIcons 表零消费=死变量，纯删。
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

  // 0=持续显示直到用户处理；其余使用当前可编辑策略。
  if (prefs.popupDurationMs > 0) setTimeout(dismiss, prefs.popupDurationMs);

  // 超过最大数量时移除最老的
  while (_notifications.length >= prefs.maxVisible) {
    const oldest = _notifications.shift();
    oldest?.remove();
  }

  _notifications.push(notif);
  document.body.appendChild(notif);
  repositionNotifications();

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

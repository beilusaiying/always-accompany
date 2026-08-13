/**
 * backendMonitor.mjs — IDE 后台监控面板
 *
 * 功能链：
 *   模块加载时即拦截 console.log/warn/error → 过滤含 "[xxx]" 前缀的模块日志写入 _logs
 *   → window.onerror / unhandledrejection → 写入 _errors
 *   → websocket beilu:scheduleWakeup 事件 → _wakeup 倒计时
 *   → websocket 分身状态广播 → cloneStatusStore 单点聚合 → 本面板订阅渲染
 *   initBackendMonitor() → 渲染 #ide-backend-monitor 三区块 DOM
 *   → 定时刷新（1s）→ 渲染日志/错误/状态/分身/倒计时
 *
 * why：
 *   IDE 模式开发中需实时查看模块日志、JS 错误、WS 状态、Token 用量；
 *   whitebox.mjs 的 wb 追踪事件也走 console.log "[wb:...]"，自动被本模块捕获，无需新面板；
 *   分身状态按完整 job 身份聚合，同一作业只接受递增 sequence；
 *   内存上限：日志 200 条 / 错误 50 条；分身容量由共享状态 owner 管理。
 *
 * 关联链：
 *   ← featureControls.mjs（getCurrentMode：当前模式显示）
 *   ← tokenProgressBar.mjs（getTokenInfo：Token 用量显示）
 *   ← whitebox.mjs（console.log "[wb:...]" 被拦截后进日志面板）
 *   ← websocket.mjs（beilu:scheduleWakeup / _broadcastCloneStatus 事件）
 *   → shared/transport/api-client.mjs（apiFetch：后端状态 API）
 *
 * 影响范围：
 *   全局 console.log/warn/error 被重写（保留原始引用 _origLog 等，调用后转发）；
 *   DOM：#ide-backend-monitor 下 #monitor-log/#monitor-errors/#monitor-status 等节点。
 *
 * 使用效果：
 *   IDE 模式右侧监控面板实时展示模块日志/JS 错误/WS 连接/Token/分身状态；
 *   wb 线路追踪自动出现在日志区，无需单独操作。
 */

import { getCurrentMode } from "../../panels/feature/featureControls.mjs";
import { getTokenInfo } from "./tokenProgressBar.mjs";
import { escapeHtml } from "../state/utils.mjs";
import { MODE_BADGE } from "../state/modeTabMap.mjs"; // D2 收口：模式徽章单源（原内联 modeMap 漏 smart）
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作）
import { storage, KEYS } from "../state/storage.mjs"; // T041b: key 单源；P2: 读写经门面
import { classifyPartLoadStatus, resolvePartLoadOccurrence } from "../state/partLoadStatus.mjs";
import { CLONE_STATUS_META, clearCloneStatuses, getCloneStatuses, initCloneStatusStore, requestCloneStop, subscribeCloneStatuses } from "../state/cloneStatusStore.mjs";

// ---- 常量 ----
const MAX_LOG_ENTRIES = 200;
const MAX_ERROR_ENTRIES = 50;

// ---- 内存存储 ----
const _logs = [];
const _errors = [];
// 定时唤醒倒计时（producer=websocket beilu:scheduleWakeup，detail {delay(秒),reason}，自起算 now+delay*1000）
let _wakeup = null; // { targetTs, reason }
let _wakeupTicker = null;

// ---- 原始 console 引用 ----
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

// ---- 工具函数 ----

function timestamp() {
  const d = new Date();
  return (
    d.getHours().toString().padStart(2, "0") +
    ":" +
    d.getMinutes().toString().padStart(2, "0") +
    ":" +
    d.getSeconds().toString().padStart(2, "0")
  );
}

/**
 * 将参数列表序列化为单行字符串
 */
function argsToString(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * 判断是否为模块日志（含 [xxx] 前缀）
 */
function isModuleLog(str) {
  return /^\[[\w\-.:]+\]/.test(str);
}

// ---- 日志捕获（模块顶层执行一次，import 即生效，不依赖 init 调用顺序） ----

function interceptConsole() {
  // 拦截 console.log — 仅捕获含 [xxx] 前缀的模块日志
  console.log = function (...args) {
    _origLog(...args);
    const text = argsToString(args);
    if (isModuleLog(text)) {
      pushLog("log", text);
    }
  };

  // 拦截 console.warn — 全部捕获
  console.warn = function (...args) {
    _origWarn(...args);
    const text = argsToString(args);
    pushLog("warn", text);
  };

  // 拦截 console.error — 同时写入错误面板
  console.error = function (...args) {
    _origError(...args);
    const text = argsToString(args);
    pushLog("error", text);
    pushError(text);
  };
}

function interceptGlobalErrors() {
  // 全局 JS 错误
  window.addEventListener("error", (e) => {
    const msg = `${e.message} (${e.filename}:${e.lineno}:${e.colno})`;
    pushError(msg);
  });

  // 未处理的 Promise rejection
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack?.split("\n").slice(0, 3).join("\n") || ""}`
        : String(reason);
    pushError(`UnhandledRejection: ${msg}`);
  });
}

// ---- 数据推送 ----

function pushLog(level, text) {
  _logs.push({ time: timestamp(), level, text });
  if (_logs.length > MAX_LOG_ENTRIES) {
    _logs.splice(0, _logs.length - MAX_LOG_ENTRIES);
  }
  renderLogIfVisible();
}

// 角标语义=未读错误数（非历史累计）。seq 计数与 _errors 环形缓冲解耦：
// 错误区被真实看见（IDE 监控 renderErrors 可见 / work 监控「错误」tab 打开）即置已读→角标清零，
// _errors 历史照常保留可回看。why：原 count=_errors.length 只增永不清零，任一条历史
// console.error（含无害模块日志）都让 work [📊] 红点永亮且无处消。
let _errSeq = 0;
let _errReadSeq = 0;

function _broadcastErrorUnread() {
  // FT-D10(凛倾批「做」): 错误事件广播——work [📊]监控角标 publisher（smart.mjs 消费）
  window.dispatchEvent(new CustomEvent("beilu:monitor-error", { detail: { count: Math.max(0, _errSeq - _errReadSeq) } }));
}

/** work 监控「错误」tab 数据源（只读副本） */
export function getMonitorErrors() {
  return _errors.slice();
}

/** 错误区被用户看见时调用：未读清零并广播（角标随之消失） */
export function markMonitorErrorsRead() {
  if (_errReadSeq === _errSeq) return;
  _errReadSeq = _errSeq;
  _broadcastErrorUnread();
}

function pushError(text) {
  _errors.push({ time: timestamp(), text });
  if (_errors.length > MAX_ERROR_ENTRIES) {
    _errors.splice(0, _errors.length - MAX_ERROR_ENTRIES);
  }
  _errSeq++;
  renderErrorsIfVisible(); // IDE 监控正可见时 renderErrors 内即置已读（在看=已读）
  _broadcastErrorUnread();
}

// ---- 渲染 ----

function isMonitorVisible() {
  const el = document.getElementById("ide-backend-monitor");
  return el && el.style.display !== "none";
}

function renderLogIfVisible() {
  if (!isMonitorVisible()) return;
  renderLog();
}

function renderErrorsIfVisible() {
  if (!isMonitorVisible()) return;
  renderErrors();
}

function renderClonesIfVisible() {
  if (!isMonitorVisible()) return;
  renderClones();
}

function renderClones() {
  const container = document.getElementById("monitor-clones");
  if (!container) return;
  const entries = getCloneStatuses(window._beiluGetChatId?.() || "");

  if (entries.length === 0) {
    container.innerHTML =
      '<p class="text-base-content/50 text-center py-2">暂无分身</p>';
    return;
  }

  container.innerHTML = entries
    .map((c) => {
      const meta = CLONE_STATUS_META[c.status] || { label: c.status, color: "var(--beilu-muted, #94a3b8)", done: false };
      const spin = meta.done ? "" : ' <span style="opacity:0.6;">…</span>';
      // [0724 分身可停·002] 非终态条目带 ⏹ 停止按钮（bindEvents 容器级委托 → SetData stopCloneTask）
      const stopBtn = meta.done ? "" : ` <button class="monitor-clone-stop" data-job="${escapeHtml(c.jobId)}" data-batch="${escapeHtml(c.cloneBatchId)}" data-task="${escapeHtml(c.taskId)}" title="停止这个分身作业" style="cursor:pointer; border:1px solid rgba(148,163,184,0.4); background:transparent; color:var(--beilu-error); border-radius:4px; font-size:11px; line-height:1.2; padding:0 4px; vertical-align:middle;">⏹ 停止</button>`;
      const mode = c.executionMode === "detached" ? "异步" : "随主回合";
      return `<div style="line-height:1.6; border-bottom:1px solid rgba(148,163,184,0.12); padding:2px 0;"><span style="opacity:0.4;">${c.time}</span> <span style="font-weight:600;">分身#${escapeHtml(c.taskId)}</span> <span style="color:${meta.color}; font-weight:600;">[${escapeHtml(meta.label)}]</span><span style="opacity:0.5;"> ${mode} · R${c.round}</span>${spin}${stopBtn} <span style="opacity:0.8;">${escapeHtml(c.detail || "")}</span></div>`;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function renderLog() {
  const container = document.getElementById("monitor-log");
  if (!container) return;

  if (_logs.length === 0) {
    container.innerHTML =
      '<p class="text-base-content/50 text-center py-2">暂无日志</p>';
    return;
  }

  // 只渲染最近 100 条以保持性能
  const visible = _logs.slice(-100);
  container.innerHTML = visible
    .map((entry) => {
      const levelClass =
        entry.level === "error"
          ? "color:var(--beilu-error);"
          : entry.level === "warn"
            ? "color:var(--beilu-warning);"
            : "opacity:0.8;";
      const levelTag =
        entry.level === "error"
          ? "ERR"
          : entry.level === "warn"
            ? "WRN"
            : "LOG";
      return `<div style="${levelClass} line-height:1.6;"><span style="opacity:0.4;">${entry.time}</span> <span style="font-weight:600;">[${levelTag}]</span> ${escapeHtml(entry.text)}</div>`;
    })
    .join("");

  // 自动滚到底部
  container.scrollTop = container.scrollHeight;
}

function renderErrors() {
  const container = document.getElementById("monitor-errors");
  if (!container) return;

  if (_errors.length === 0) {
    container.innerHTML =
      '<p class="text-base-content/50 text-center py-2">无错误</p>';
    return;
  }

  container.innerHTML = _errors
    .map(
      (entry) =>
        `<div style="color:var(--beilu-error); line-height:1.6; border-bottom:1px solid rgba(239,68,68,0.1); padding:2px 0;"><span style="opacity:0.4;">${entry.time}</span> ${escapeHtml(entry.text)}</div>`,
    )
    .join("");

  container.scrollTop = container.scrollHeight;
  // 错误列表真实呈现给用户 = 已读（本函数仅在监控可见路径被调，双保险再核一次可见性）
  if (isMonitorVisible()) markMonitorErrorsRead();
}

// ---- part 加载状态轮询 ----
// 把 server 核心的 part load 失败（parts_loader reportPluginStatus → /api/v1/monitor/plugins，
// 纯内存 pull、原本与本面板不互通）映射到「运行时日志/错误」面板。
// 根因背景：chat shell 那次 404 雪崩就是 part load-time SyntaxError 被静默降级成 404，前端零信号。
const _seenPartErrors = new Map(); // occurrence/fingerprint -> seen timestamp
const MAX_SEEN_PART_ERRORS = 500;

function partLoadDetailText(detail) {
  if (typeof detail === "string") return detail;
  if (detail == null) return "";
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

/** 即时 event 与 poll 共用的唯一消费口：同 occurrence 只进日志/错误面板一次。 */
function consumePartLoadStatus(partpath, info, source) {
  const payload = { ...(info || {}), partpath: info?.partpath || partpath || "?" };
  const status = payload.status || "load-error";
  const kind = classifyPartLoadStatus(status);
  if (kind !== "failure") {
    // part-load-error 事件却传入非失败/未知状态时仍外显协议异常。
    if (source === "event") pushLog("warn", `[parts] ⚠ ${payload.partpath} ${status}`);
    return false;
  }

  const occurrence = resolvePartLoadOccurrence(payload, partpath);
  if (_seenPartErrors.has(occurrence.key)) return false;
  _seenPartErrors.set(occurrence.key, Date.now());
  while (_seenPartErrors.size > MAX_SEEN_PART_ERRORS) {
    _seenPartErrors.delete(_seenPartErrors.keys().next().value);
  }

  if (occurrence.legacyFingerprint) {
    const warning = `[parts] ${payload.partpath} ${status} 缺少 occurrenceId，仅以显式 legacy fingerprint 兼容去重 (${source})`;
    _origWarn(warning);
    pushLog("warn", warning);
  }

  const detail = partLoadDetailText(payload.detail);
  const msg = `[parts] ⚠ ${payload.partpath} ${status}${detail ? ": " + detail : ""}`;
  pushLog("error", msg);
  pushError(msg);
  return true;
}

async function pollPartLoadErrors() {
  try {
    // T6b：raw+手 res.ok/status 语义并入门面（!ok 由门面统一 _report console.error+抛错走 catch；
    //   原 401 vs 其他 status 细粒度分辨在门面模式下弱化——门面已含 target#verb 定位输出，可见性等价）。
    const data = await sendAction({ verb: "getPlugins", target: "server:monitor", source: "web" });
    // 轮询恢复正常时清除失败标记
    for (const k of _seenPartErrors.keys()) { if (k.startsWith("_poll_fail_")) _seenPartErrors.delete(k); }
    const plugins = data?.plugins || {};
    for (const [name, info] of Object.entries(plugins)) {
      if (!info) continue;
      consumePartLoadStatus(name, info, "poll");
    }
  } catch { /* 轮询失败静默，不影响面板 */ }
}

function setWakeup(detail) {
  const delay = Number(detail?.delay);
  if (!Number.isFinite(delay) || delay <= 0) return;
  _wakeup = { targetTs: Date.now() + delay * 1000, reason: detail?.reason || "" };
  renderWakeup();
  if (_wakeupTicker) clearInterval(_wakeupTicker);
  _wakeupTicker = setInterval(renderWakeup, 1000);
}

function renderWakeup() {
  const row = document.getElementById("monitor-wakeup-row");
  const valueEl = document.getElementById("monitor-wakeup");
  if (!row || !valueEl) return;

  if (!_wakeup) {
    row.style.display = "none";
    return;
  }
  const remainMs = _wakeup.targetTs - Date.now();
  if (remainMs <= 0) {
    // 已到点：清倒计时，停 ticker
    valueEl.textContent = "已唤醒";
    valueEl.style.color = "var(--beilu-success)";
    _wakeup = null;
    if (_wakeupTicker) { clearInterval(_wakeupTicker); _wakeupTicker = null; }
    return;
  }
  row.style.display = "";
  const remainS = Math.ceil(remainMs / 1000);
  const reason = _wakeup.reason ? ` · ${_wakeup.reason}` : "";
  valueEl.textContent = `${remainS}s 后${reason}`;
  valueEl.style.color = remainS <= 5 ? "var(--beilu-warning)" : "";
}

function renderStatus() {
  // 当前模式
  const modeEl = document.getElementById("monitor-current-mode");
  if (modeEl) {
    const mode = getCurrentMode();
    // [D2 收口 0713] 原内联 modeMap 副本漏 smart 键 → 全智能模式下监视器显英文裸值。
    // 改 MODE_BADGE 单源（modeTabMap.mjs），新增模式一处生效。
    // data-ic 图标需 innerHTML 生效；mode 兜底值来自内部枚举，无用户输入
    const _badge = MODE_BADGE[mode];
    if (_badge) modeEl.innerHTML = `${_badge.icon} ${_badge.label}`;
    else modeEl.textContent = mode;
  }

  // WebSocket 状态（检查 ideConnPanel 的连接状态）
  const wsEl = document.getElementById("monitor-ws-status");
  if (wsEl) {
    // 通过 DOM 查找连接卡片状态
    const connDots = document.querySelectorAll(".conn-dot-connected");
    if (connDots.length > 0) {
      wsEl.textContent = "● 已连接";
      wsEl.style.color = "var(--beilu-success)";
    } else {
      wsEl.textContent = "○ 未连接";
      wsEl.style.color = "";
    }
  }

  // Token 信息（追加到系统状态区域）
  renderTokenStatus();
}

function renderTokenStatus() {
  const statusContainer = document.getElementById("monitor-status");
  if (!statusContainer) return;

  // 检查是否已有 token 行
  let tokenRow = document.getElementById("monitor-token-row");
  if (!tokenRow) {
    tokenRow = document.createElement("div");
    tokenRow.id = "monitor-token-row";
    tokenRow.className = "flex items-center justify-between";
    tokenRow.innerHTML = `
      <span class="text-base-content/60">Token 用量</span>
      <span id="monitor-token-value" class="text-[10px]">—</span>
    `;
    statusContainer.appendChild(tokenRow);
  }

  const valueEl = document.getElementById("monitor-token-value");
  if (valueEl) {
    try {
      const info = getTokenInfo();
      const ratio = info.ratio;
      const pct = (ratio * 100).toFixed(1);
      const color =
        ratio < 0.6 ? "var(--beilu-success)" : ratio < 0.8 ? "var(--beilu-warning)" : "var(--beilu-error)";
      valueEl.textContent = `${formatK(info.tokens)} / ${formatK(info.maxContext)} (${pct}%)`;
      valueEl.style.color = color;
    } catch {
      valueEl.textContent = "—";
    }
  }
}

function formatK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ---- 全量渲染（面板切入可见时调用） ----

function renderAll() {
  renderLog();
  renderErrors();
  renderClones();
  renderStatus();
  renderWakeup();
}

// ---- 事件绑定 ----

function bindEvents() {
  // 清空日志按钮
  document
    .getElementById("monitor-clear-log")
    ?.addEventListener("click", () => {
      _logs.length = 0;
      renderLog();
    });

  // 清空分身按钮
  document
    .getElementById("monitor-clear-clones")
    ?.addEventListener("click", () => {
      clearCloneStatuses(window._beiluGetChatId?.() || "");
      renderClones();
    });

  // [0724 分身可停·002] ⏹ 停止分身（容器级委托：条目 innerHTML 重渲，不能挂条目级监听）
  //   → SetData stopCloneTask（后端 cloneAbort 触发该任务 AbortController，轮界/在飞 API 即断），
  //   终态 stopped 由后端 _broadcastCloneStatus 回流本面板更新，前端不预写状态（诚实外显）。
  document
    .getElementById("monitor-clones")
    ?.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.(".monitor-clone-stop");
      if (!btn) return;
      const taskId = btn.dataset.task;
      const jobId = btn.dataset.job;
      if (!taskId || !jobId) return;
      btn.disabled = true;
      btn.textContent = "停止中…";
      try {
        const r = await requestCloneStop(jobId, window._beiluGetChatId?.() || "");
        if (!r?.aborted) {
          // 没匹配到在跑任务（已结束/worker 隔离/会话不符）——按钮恢复，面板状态以广播为准
          btn.disabled = false;
          btn.textContent = "⏹ 停止";
          console.warn(`[monitor] 停止分身 job=${jobId}: 未匹配到在跑任务 (aborted=${r?.aborted ?? "?"})`);
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "⏹ 停止";
        console.warn(`[monitor] 停止分身#${taskId} 失败:`, err?.message || err);
      }
    });

  // 定时唤醒倒计时（producer=websocket beilu:scheduleWakeup）
  window.addEventListener("beilu:scheduleWakeup", (e) => {
    setWakeup(e.detail);
  });

  // 监听模式切换 → 刷新状态
  window.addEventListener("beilu:mode-switched", () => {
    renderStatus();
  });

  // Drift 修复：IDE 连接/断连后立即刷新 WS 状态行（此前仅靠 5s 定时刷新，
  // 用户正看监控面板时连/断 IDE，monitor-ws-status 会残留旧值最多 5s）。
  // 事件 producer 见 ideConnPanel.mjs onopen→ide-connected / onclose|disconnect→ide-disconnected。
  window.addEventListener("beilu:ide-connected", () => {
    renderStatus();
  });
  window.addEventListener("beilu:ide-disconnected", () => {
    renderStatus();
  });

  // 插件加载失败即时推送（根因C修复：后端 sendEventToUser → websocket → 本事件）
  // 不再依赖 5s 轮询延迟，前端即时收到并推送到日志/错误面板
  window.addEventListener("beilu:part-load-error", (e) => {
    const d = e.detail || {};
    consumePartLoadStatus(d.partpath || "?", d, "event");
  });

  // 设置面板"后台插件轮询"开关（settingsSlots.mjs 发 beilu:monitor-poll-toggle 事件）
  window.addEventListener("beilu:monitor-poll-toggle", (e) => {
    _pollEnabled = !!e.detail?.enabled;
  });
  // 恢复持久化状态（与 settingsSlots 同读 localStorage）
  if (storage.get(KEYS.BEILU_MONITOR_POLL_ENABLED) === "0") _pollEnabled = false; // P2：裸读→门面（容错在门面内）

  // 监听活动栏面板切换 → 面板可见时刷新全部
  // 使用 MutationObserver 监控 #ide-backend-monitor 的 display 变化
  const monitorEl = document.getElementById("ide-backend-monitor");
  if (monitorEl) {
    const obs = new MutationObserver(() => {
      if (monitorEl.style.display !== "none") {
        renderAll();
      }
    });
    obs.observe(monitorEl, {
      attributes: true,
      attributeFilter: ["style"],
    });
  }
}

// ---- 定时刷新 ----
let _refreshTimer = null;
let _pollEnabled = true; // 设置面板的"后台插件轮询"开关控制

function startPeriodicRefresh() {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    if (isMonitorVisible()) {
      renderStatus();
      if (_pollEnabled) pollPartLoadErrors();
    }
  }, 5000);
}

function stopPeriodicRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ---- 初始化入口 ----

interceptConsole();
interceptGlobalErrors();

export function initBackendMonitor() {
  initCloneStatusStore();
  subscribeCloneStatuses(renderClonesIfVisible);
  // 绑定 DOM 事件
  bindEvents();

  // 3. 初次渲染
  renderAll();

  // 3.5 初次轮询 part 加载错误（启动期 part load 失败发生在面板可见之前，先拉进缓冲，打开面板即可见）
  pollPartLoadErrors();

  // 4. 启动定时刷新
  startPeriodicRefresh();

  _origLog("[backendMonitor] 后台监控面板已初始化");
}

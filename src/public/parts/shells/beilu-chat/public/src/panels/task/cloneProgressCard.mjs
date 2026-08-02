/**
 * cloneProgressCard.mjs — 聊天流顶部分身进度卡
 *
 * 功能链：
 *   initCloneProgressCard → 监听 beilu:cloneStatus 事件 → _render()
 *   后端 replyHandler._broadcastCloneStatus → WS clone_status → websocket.mjs 派发 beilu:cloneStatus
 *   per-chatId 隔离由 WS 层完成（只推送订阅了当前 chat 的客户端）。
 *   停止按钮 → sendAction stopCloneTask → 后端 cloneAbort（与 backendMonitor 同链）。
 */

import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { showToast } from "../../../../../../scripts/toast.mjs";

const STATUS_META = {
  started:   { icon: "🚀", label: "启动",   color: "var(--beilu-accent, oklch(0.7 0.15 250))",  done: false },
  working:   { icon: "⚡", label: "执行中", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  retrying:  { icon: "🔄", label: "重试",   color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  warning:   { icon: "⚠️", label: "告警",   color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  completed: { icon: "✅", label: "完成",   color: "var(--beilu-success, oklch(0.7 0.17 155))",  done: true },
  stopped:   { icon: "⏹️", label: "中断",   color: "var(--beilu-error, oklch(0.65 0.2 25))",    done: true },
  error:     { icon: "❌", label: "错误",   color: "var(--beilu-error, oklch(0.65 0.2 25))",    done: true },
};

const MAX_ENTRIES = 20;
const COLLAPSE_KEY = "beilu-clone-card-collapsed";
const _clones = new Map();
let _cardEl = null;
let _initialized = false;
let _collapsed = false;
try { _collapsed = storage.get(COLLAPSE_KEY) === "1"; } catch { /* ignore */ }

export function initCloneProgressCard() {
  if (_initialized) return;
  _initialized = true;
  _cardEl = document.getElementById("clone-progress-card");
  if (!_cardEl) return;

  window.addEventListener("beilu:cloneStatus", (e) => {
    const d = e.detail || {};
    if (!d.taskId) return;
    const id = String(d.taskId);
    const prev = _clones.get(id) || { firstSeen: Date.now() };
    _clones.set(id, {
      taskId: id,
      round: d.round ?? prev.round ?? 0,
      status: d.status || prev.status || "working",
      detail: (d.detail ?? prev.detail ?? "").substring(0, 120),
      time: (d.timestamp || new Date().toISOString()).slice(11, 19),
      firstSeen: prev.firstSeen,
    });
    if (_clones.size > MAX_ENTRIES) {
      const oldest = [..._clones.values()].sort((a, b) => a.firstSeen - b.firstSeen)[0];
      if (oldest) _clones.delete(oldest.taskId);
    }
    // 通知：分身状态变更时弹 toast（终态只弹一次）
    const prevStatus = prev.status;
    const newStatus = d.status;
    if (newStatus && newStatus !== prevStatus && STATUS_META[newStatus]?.done) {
      const meta = STATUS_META[newStatus];
      showToast(`${meta.icon} 分身#${d.taskId} ${meta.label}`, 3000);
    }
    _render();
  });

  window.addEventListener("hashchange", () => {
    _clones.clear();
    _render();
  });

  _cardEl.addEventListener("click", async (e) => {
    const toggleEl = e.target?.closest?.("[data-action='toggle']");
    if (toggleEl) {
      _collapsed = !_collapsed;
      try { storage.set(COLLAPSE_KEY, _collapsed ? "1" : "0"); } catch { /* ignore */ }
      _render();
      return;
    }
    const stopBtn = e.target?.closest?.(".clone-stop-btn");
    if (stopBtn) {
      const taskId = stopBtn.dataset.task;
      if (!taskId) return;
      stopBtn.disabled = true;
      stopBtn.textContent = "…";
      try {
        await sendAction({
          verb: "stopCloneTask",
          target: "plugins:beilu-memory",
          source: "web",
          payload: { chatid: window._beiluGetChatId?.() || "", taskId },
        });
      } catch (_e) {
        console.warn("[cloneCard] 停止分身失败:", _e?.message);
      }
    }
  });
}

function _render() {
  if (!_cardEl) return;
  if (_clones.size === 0) { _cardEl.classList.add("hidden"); return; }

  const entries = [..._clones.values()].sort((a, b) => {
    const da = STATUS_META[a.status]?.done ? 1 : 0;
    const db = STATUS_META[b.status]?.done ? 1 : 0;
    if (da !== db) return da - db;
    return String(a.taskId).localeCompare(String(b.taskId), undefined, { numeric: true });
  });

  const activeCount = entries.filter(e => !STATUS_META[e.status]?.done).length;

  const rows = entries.map(c => {
    const meta = STATUS_META[c.status] || { icon: "·", label: c.status, color: "var(--beilu-muted, #94a3b8)", done: false };
    const spin = meta.done ? "" : ` <span style="opacity:0.5;">…</span>`;
    const stopBtn = meta.done ? "" : ` <button class="clone-stop-btn" data-task="${escapeHtml(c.taskId)}" title="停止分身" style="cursor:pointer; border:1px solid rgba(148,163,184,0.3); background:transparent; color:var(--beilu-error, oklch(0.65 0.2 25)); border-radius:4px; font-size:11px; line-height:1.2; padding:0 4px; vertical-align:middle;">⏹</button>`;
    const detail = c.detail ? ` <span style="opacity:0.7;">${escapeHtml(c.detail)}</span>` : "";
    return `<div style="line-height:1.6; border-bottom:1px solid rgba(148,163,184,0.08); padding:2px 0; font-size:13px;">`
      + `<span style="opacity:0.35; font-size:11px;">${escapeHtml(c.time)}</span> `
      + `<span style="font-weight:600;">分身#${escapeHtml(c.taskId)}</span> `
      + `<span style="color:${meta.color}; font-weight:600;">[${escapeHtml(meta.label)}]</span>`
      + `<span style="opacity:0.4;"> R${c.round}</span>${spin}${stopBtn}${detail}`
      + `</div>`;
  });

  const toggleIcon = _collapsed ? "▸" : "▾";
  const summary = activeCount > 0
    ? `${activeCount} 运行中`
    : `全部完成`;

  _cardEl.innerHTML = `<div style="background:var(--beilu-surface, oklch(0.25 0.01 260)); border:1px solid oklch(0.35 0.02 260); border-radius:8px; padding:6px 10px;">`
    + `<div style="cursor:pointer; user-select:none; display:flex; align-items:center; gap:6px; font-size:13px;" data-action="toggle">`
    + `<span style="opacity:0.4; font-size:11px;">${toggleIcon}</span>`
    + `<span style="font-weight:600;">🤖 分身进度</span>`
    + `<span style="opacity:0.45; font-size:12px;">${summary}</span>`
    + `</div>`
    + `<div data-body style="display:${_collapsed ? "none" : "block"}; margin-top:4px; max-height:200px; overflow-y:auto;">${rows.join("")}</div>`
    + `</div>`;

  _cardEl.classList.remove("hidden");

  if (activeCount === 0) {
    setTimeout(() => {
      if ([..._clones.values()].every(c => STATUS_META[c.status]?.done)) {
        _clones.clear();
        _render();
      }
    }, 15000);
  }
}

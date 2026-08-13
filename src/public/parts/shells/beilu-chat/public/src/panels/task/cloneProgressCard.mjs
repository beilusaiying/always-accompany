/**
 * cloneProgressCard.mjs — 聊天流顶部分身进度卡
 *
 * 功能链：
 *   initCloneProgressCard → 订阅 cloneStatusStore → _render()
 *   后端 clone_status → websocket.mjs → cloneStatusStore 唯一归一/幂等 → 两个视图
 *   per-chatId 隔离由 WS 层完成（只推送订阅了当前 chat 的客户端）。
 *   停止按钮 → sendAction stopCloneTask → 后端 cloneAbort（与 backendMonitor 同链）。
 */

import { escapeHtml } from "../../shared/state/utils.mjs";
import { storage } from "../../shared/state/storage.mjs";
import { CLONE_STATUS_META as STATUS_META, getCloneStatuses, initCloneStatusStore, requestCloneStop, subscribeCloneStatuses } from "../../shared/state/cloneStatusStore.mjs";
import { showToast } from "../../../../../../scripts/toast.mjs";

const MAX_ENTRIES = 20;
const COLLAPSE_KEY = "beilu-clone-card-collapsed";
const _readyResults = new Map();
let _cardEl = null;
let _initialized = false;
let _collapsed = false;
try { _collapsed = storage.get(COLLAPSE_KEY) === "1"; } catch { /* ignore */ }

export function initCloneProgressCard() {
  if (_initialized) return;
  _initialized = true;
  _cardEl = document.getElementById("clone-progress-card");
  if (!_cardEl) return;

  initCloneStatusStore();
  subscribeCloneStatuses((change) => {
    if (change.type === "upsert" && change.current.status !== change.previous?.status && STATUS_META[change.current.status]?.done) {
      const meta = STATUS_META[change.current.status];
      showToast(`${meta.icon} 分身#${change.current.taskId} ${meta.label}`, 3000);
    }
    _render();
  });

  // 复用已有 tool_results_ready 信息口；它只显示持久结果的投递判定，
  // 不触发生成、不另存业务真值。resultId 使重复完成广播幂等。
  window.addEventListener("beilu:toolResultsReady", (e) => {
    const d = e.detail || {};
    if (d.source !== "clone_results" || d.background !== true || !d.readOnly || !d.resultId) return;
    _readyResults.set(String(d.resultId), {
      resultId: String(d.resultId),
      cloneBatchId: String(d.cloneBatchId || ""),
      delivery: d.delivery || {},
      time: new Date().toISOString().slice(11, 19),
    });
    while (_readyResults.size > MAX_ENTRIES) _readyResults.delete(_readyResults.keys().next().value);
    const sleeping = d.delivery?.reason === "user_stopped";
    showToast(sleeping ? "📥 分身后台结果已就绪，下次互动时读取" : "📥 分身后台结果已就绪", 4000);
    _render();
  });

  // pendingResults 在生成前置阶段已破坏性消费；AI 回复完成后清掉待读投影。
  window.addEventListener("beilu:ai-reply-done", () => {
    if (_readyResults.size === 0) return;
    _readyResults.clear();
    _render();
  });

  window.addEventListener("hashchange", () => {
    _readyResults.clear();
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
      const jobId = stopBtn.dataset.job;
      if (!taskId || !jobId) return;
      stopBtn.disabled = true;
      stopBtn.textContent = "…";
      try {
        const result = await requestCloneStop(jobId, window._beiluGetChatId?.() || "");
        if (!result?.aborted) {
          stopBtn.disabled = false;
          stopBtn.textContent = "⏹";
          console.warn(`[cloneCard] 停止分身 job=${jobId} 未命中:`, result);
        }
      } catch (_e) {
        stopBtn.disabled = false;
        stopBtn.textContent = "⏹";
        console.warn("[cloneCard] 停止分身失败:", _e?.message);
      }
    }
  });
}

function _render() {
  if (!_cardEl) return;
  const entries = getCloneStatuses(window._beiluGetChatId?.() || "");
  if (entries.length === 0 && _readyResults.size === 0) { _cardEl.classList.add("hidden"); return; }

  const activeCount = entries.filter(e => !STATUS_META[e.status]?.done).length;

  const cloneRows = entries.map(c => {
    const meta = STATUS_META[c.status] || { icon: "·", label: c.status, color: "var(--beilu-muted, #94a3b8)", done: false };
    const spin = meta.done ? "" : ` <span style="opacity:0.5;">…</span>`;
    const stopBtn = meta.done ? "" : ` <button class="clone-stop-btn" data-job="${escapeHtml(c.jobId)}" data-batch="${escapeHtml(c.cloneBatchId)}" data-task="${escapeHtml(c.taskId)}" title="停止这个分身作业" style="cursor:pointer; border:1px solid rgba(148,163,184,0.3); background:transparent; color:var(--beilu-error, oklch(0.65 0.2 25)); border-radius:4px; font-size:11px; line-height:1.2; padding:0 4px; vertical-align:middle;">⏹</button>`;
    const detail = c.detail ? ` <span style="opacity:0.7;">${escapeHtml(c.detail)}</span>` : "";
    const mode = c.executionMode === "detached" ? "异步" : "随主回合";
    return `<div style="line-height:1.6; border-bottom:1px solid rgba(148,163,184,0.08); padding:2px 0; font-size:13px;">`
      + `<span style="opacity:0.35; font-size:11px;">${escapeHtml(c.time)}</span> `
      + `<span style="font-weight:600;">分身#${escapeHtml(c.taskId)}</span> `
      + `<span style="color:${meta.color}; font-weight:600;">[${escapeHtml(meta.label)}]</span>`
      + `<span style="opacity:0.4;"> ${mode} · R${c.round}</span>${spin}${stopBtn}${detail}`
      + `</div>`;
  });
  const readyRows = [..._readyResults.values()].map((result) => {
    const sleeping = result.delivery?.reason === "user_stopped";
    const waiting = sleeping
      ? "已按用户停止休眠，下次互动时读取一次"
      : result.delivery?.queued
        ? "已就绪，当前回合结束后读取"
        : result.delivery?.scheduled
          ? "已就绪，等待自动读取"
          : "已就绪，下次互动时读取";
    return `<div style="line-height:1.6; border-bottom:1px solid rgba(148,163,184,0.08); padding:2px 0; font-size:13px;">`
      + `<span style="opacity:0.35; font-size:11px;">${escapeHtml(result.time)}</span> `
      + `<span style="font-weight:600; color:var(--beilu-success, oklch(0.7 0.17 155));">📥 后台结果已就绪</span> `
      + `<span style="opacity:0.65;">${escapeHtml(waiting)}</span>`
      + `</div>`;
  });
  const rows = [...readyRows, ...cloneRows];

  const toggleIcon = _collapsed ? "▸" : "▾";
  const summary = _readyResults.size > 0
    ? `${_readyResults.size} 个后台结果待读`
    : activeCount > 0
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

}

/**
 * taskOverlay.mjs — 聊天流内临时任务进度卡片（W17+W18 全智能任务）
 *
 * 功能链：
 *   createTaskOverlayCard(data) → 创建任务进行中卡片（含模式图标 💻/📋、标题、「查看详情」按钮）
 *     → 插入到聊天消息流中（由 messageList.mjs/extension 分发点调用）
 *     → 点「查看详情」→ window.dispatchEvent(beilu:switchTab {tab: modeToTab(mode)}) → 切换到对应 Tab
 *     → _pushSmartTaskUpdate → 更新 window._beiluActiveTasks → 派发 beilu:smart-task-update
 *   completeTaskOverlay(data) → 已存在的卡片 classList.add("task-overlay-completed") → CSS 淡出
 *     → 替换内容为「已完成」文本 → 3s 后从 DOM 移除
 *   _taskMeta Map → 维护所有任务的最新状态元数据（id/status/title/mode/startedAt/completedAt）
 *
 * why（_pushSmartTaskUpdate 全局同步）：
 *   taskOverlay 是 window._beiluActiveTasks 的唯一 producer（写入正在运行的任务列表）；
 *   通知中心（crossModeNotification.collectBackgroundTasks）和 workPanel 右栏 smart 计数都是 consumer，
 *   通过 beilu:smart-task-update 事件同步，不需要轮询或直接耦合。
 *
 * 关联链：
 *   → shared/state/utils.mjs escapeHtml（任务标题 XSS 安全）
 *   → shared/state/modeTabMap.mjs modeToTab（work/code 模式→Tab 名映射权威源）
 *   ← messageList.mjs / extension 分发块（task_started / task_completed 事件触发创建/完成卡片）
 *   ← crossModeNotification.mjs collectBackgroundTasks（消费 window._beiluActiveTasks / beilu:smart-task-update，
 *     原 floatingTaskOrb 小窗已删——凛倾 2026-07-07 统一并入 🔔 通知中心）
 *   ← workPanel.mjs（消费 beilu:smart-task-update 刷新右栏计数）
 *
 * 影响范围：
 *   聊天消息流 DOM（动态插入/移除任务卡片 <div class="task-overlay-card">）；
 *   window._beiluActiveTasks / window._beiluDoneTasks 全局变量（任务聚合总线）；
 *   _activeOverlays / _taskMeta 内存 Map（会话内状态）。
 *
 * 使用效果：
 *   AI 启动工作/代码模式任务时，聊天流出现「工作模式 进行中...」卡片；
 *   任务完成后卡片变「已完成」并淡出消失；🔔 通知中心/工作面板同步更新任务计数。
 */

import { escapeHtml } from "../../shared/state/utils.mjs";
import { modeToTab } from "../../shared/state/modeTabMap.mjs";

/** 活跃的任务卡片 Map<taskId, HTMLElement> */
const _activeOverlays = new Map();
/** 任务元数据 Map<taskId, {id, status, title, mode, startedAt, completedAt?, result?}> */
const _taskMeta = new Map();

function _pushSmartTaskUpdate() {
  const all = Array.from(_taskMeta.values());
  window._beiluActiveTasks = all.filter(t => t.status !== "completed");
  window._beiluDoneTasks = all.filter(t => t.status === "completed").slice(-10);
  window.dispatchEvent(new CustomEvent("beilu:smart-task-update"));
}

/**
 * 创建任务进行中卡片
 * @param {{ id: string, status: string, title: string, mode: string, startedAt: string }} data
 * @returns {HTMLElement}
 */
export function createTaskOverlayCard(data) {
  // 如果已存在同id卡片，更新状态
  if (_activeOverlays.has(data.id)) {
    const existing = _activeOverlays.get(data.id);
    const statusEl = existing.querySelector(".task-overlay-status");
    if (statusEl) statusEl.textContent = data.status === "running" ? "进行中..." : data.status;
    return existing;
  }

  const card = document.createElement("div");
  card.className = "task-overlay-card";
  card.dataset.taskId = data.id;

  const modeIcon = data.mode === "work" ? '<i data-ic="clipboard"></i>' : '<i data-ic="code"></i>';
  const modeLabel = data.mode === "work" ? "工作模式" : "代码模式";

  card.innerHTML = `
    <div class="task-overlay-header">
      <span class="task-overlay-icon">${modeIcon}</span>
      <span class="task-overlay-mode">${modeLabel}</span>
      <span class="task-overlay-status">进行中...</span>
    </div>
    <div class="task-overlay-title">${escapeHtml(data.title)}</div>
    <div class="task-overlay-actions">
      <button class="task-overlay-btn" data-action="goto" data-mode="${data.mode}">查看详情</button>
    </div>
  `;

  // 查看详情 → 切换到对应Tab
  card.querySelector("[data-action='goto']")?.addEventListener("click", () => {
    // 映射权威源 ../modeTabMap.mjs（T-3）。helper 带 `|| "chat"` 回退（与原逻辑等价）。
    const targetTab = modeToTab(data.mode);
    // 触发switchTab（通过自定义事件，避免直接依赖layout.mjs）
    window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: targetTab } }));
  });

  _activeOverlays.set(data.id, card);
  _taskMeta.set(data.id, { ...data, status: data.status || "running" });
  _pushSmartTaskUpdate();
  return card;
}

/**
 * 完成任务卡片 — 变为完成状态后淡出
 * @param {{ id: string, result: string, completedAt: string }} data
 */
export function completeTaskOverlay(data) {
  const card = _activeOverlays.get(data.id);
  if (!card) return;

  card.classList.add("task-overlay-completed");
  const statusEl = card.querySelector(".task-overlay-status");
  if (statusEl) statusEl.textContent = "已完成";

  const titleEl = card.querySelector(".task-overlay-title");
  if (titleEl) titleEl.textContent = `✅ ${data.result || "任务已完成"}`;

  const actionsEl = card.querySelector(".task-overlay-actions");
  if (actionsEl) actionsEl.remove();

  // 更新元数据 → 已完成
  const meta = _taskMeta.get(data.id);
  if (meta) {
    meta.status = "completed";
    meta.completedAt = data.completedAt;
    meta.result = data.result;
  }
  _pushSmartTaskUpdate();

  // 3秒后淡出
  setTimeout(() => {
    card.classList.add("task-overlay-fadeout");
    setTimeout(() => {
      card.remove();
      _activeOverlays.delete(data.id);
    }, 500);
  }, 3000);
}

/**
 * 处理AI回复中的taskOverlay extension字段
 * 在消息渲染后调用
 * @param {HTMLElement} messageEl - 消息DOM元素
 * @param {object} extension - reply.extension
 */
export function handleTaskOverlayExtension(messageEl, extension) {
  if (!extension) return;

  if (extension._taskOverlay) {
    const card = createTaskOverlayCard(extension._taskOverlay);
    // 插入到消息元素后面
    messageEl.parentNode?.insertBefore(card, messageEl.nextSibling);
  }

  if (extension._taskOverlayComplete) {
    completeTaskOverlay(extension._taskOverlayComplete);
  }

  // <progress> 标签: 更新活跃卡片的进度文本
  if (extension._progress) {
    updateTaskProgress(extension._progress);
  }
}

/** 更新最新活跃任务的进度 (设计P2-1 progress标签) */
export function updateTaskProgress(progress) {
  if (!progress) return;
  // 取最新一个未完成任务
  let latestCard = null;
  for (const card of _activeOverlays.values()) {
    if (!card.classList.contains("task-overlay-completed")) latestCard = card;
  }
  if (!latestCard) return;
  const statusEl = latestCard.querySelector(".task-overlay-status");
  const msg = progress.message || "";
  const prog = (progress.current != null && progress.total != null)
    ? ` (${progress.current}/${progress.total})`
    : "";
  if (statusEl) statusEl.textContent = `进行中${prog} ${msg}`.trim();
  // 同步到任务元数据
  for (const [id, meta] of _taskMeta.entries()) {
    if (_activeOverlays.get(id) === latestCard) {
      meta.progress = progress;
      break;
    }
  }
  _pushSmartTaskUpdate();
}

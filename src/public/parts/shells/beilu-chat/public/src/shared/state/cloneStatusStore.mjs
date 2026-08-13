// cloneStatusStore.mjs — 两个分身进度视图共用的唯一前端状态与精确停止 owner。

import { sendAction } from "../transport/sendAction.mjs";

export const CLONE_STATUS_META = Object.freeze({
  batch_queued: { icon: "🕓", label: "批内排队", color: "var(--beilu-muted, #94a3b8)", done: false },
  accepted: { icon: "📥", label: "已接单", color: "var(--beilu-accent, oklch(0.7 0.15 250))", done: false },
  ai_waiting: { icon: "⏳", label: "等待AI槽", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  ai_queued: { icon: "🕓", label: "AI排队", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  ai_running: { icon: "⚡", label: "AI运行", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  ai_released: { icon: "↪", label: "AI已释放", color: "var(--beilu-accent, oklch(0.7 0.15 250))", done: false },
  ai_cancelled: { icon: "⏹️", label: "AI排队取消", color: "var(--beilu-error, oklch(0.65 0.2 25))", done: false },
  started: { icon: "🚀", label: "启动", color: "var(--beilu-accent, oklch(0.7 0.15 250))", done: false },
  working: { icon: "⚡", label: "执行中", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  retrying: { icon: "🔄", label: "重试", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  warning: { icon: "⚠️", label: "告警", color: "var(--beilu-warning, oklch(0.75 0.15 85))", done: false },
  completed: { icon: "✅", label: "完成", color: "var(--beilu-success, oklch(0.7 0.17 155))", done: true },
  stopped: { icon: "⏹️", label: "中断", color: "var(--beilu-error, oklch(0.65 0.2 25))", done: true },
  error: { icon: "❌", label: "错误", color: "var(--beilu-error, oklch(0.65 0.2 25))", done: true },
});

const MAX_ENTRIES = 30;
const statuses = new Map();
const subscribers = new Set();
let initialized = false;

function identityKey(ownerUsername, chatId, jobId) {
  return `${ownerUsername}\u0000${chatId}\u0000${jobId}`;
}

function notify(change) {
  for (const subscriber of subscribers) {
    try { subscriber(change); } catch (error) { console.warn("[cloneStatusStore] subscriber failed:", error); }
  }
}

export function acceptCloneStatus(payload = {}) {
  const ownerUsername = String(payload.ownerUsername || payload.job?.ownerUsername || "");
  const chatId = String(payload.chatId || payload.job?.chatId || "");
  const cloneBatchId = String(payload.cloneBatchId || payload.job?.cloneBatchId || "");
  const jobId = String(payload.jobId || payload.job?.jobId || "");
  const taskId = payload.taskId ?? payload.job?.taskId;
  const sequence = payload.sequence;
  const status = String(payload.status || "");
  if (!ownerUsername || !chatId || !cloneBatchId || !jobId || taskId == null || !Number.isInteger(sequence) || sequence < 0 || !status) return false;
  const key = identityKey(ownerUsername, chatId, jobId);
  const previous = statuses.get(key);
  if (previous && (sequence <= previous.sequence || previous.state === "terminal")) return false;
  const current = {
    ...payload,
    ownerUsername,
    chatId,
    cloneBatchId,
    jobId,
    taskId: String(taskId),
    executionMode: payload.executionMode || payload.job?.executionMode || previous?.executionMode || "attached",
    round: payload.round ?? previous?.round ?? 0,
    detail: String(payload.detail ?? previous?.detail ?? ""),
    sequence,
    time: String(payload.timestamp || payload.occurredAt || new Date().toISOString()).slice(11, 19),
    firstSeen: previous?.firstSeen ?? Date.now(),
  };
  statuses.set(key, current);
  if (statuses.size > MAX_ENTRIES) {
    const oldest = [...statuses.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen)[0];
    if (oldest) statuses.delete(oldest[0]);
  }
  notify({ type: "upsert", current, previous: previous || null });
  return true;
}

export function initCloneStatusStore() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beilu:cloneStatus", (event) => acceptCloneStatus(event.detail || {}));
}

export function subscribeCloneStatuses(subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function getCloneStatuses(chatId = "") {
  return [...statuses.values()]
    .filter((entry) => !chatId || entry.chatId === String(chatId))
    .sort((a, b) => {
      const doneOrder = Number(CLONE_STATUS_META[a.status]?.done) - Number(CLONE_STATUS_META[b.status]?.done);
      return doneOrder || a.firstSeen - b.firstSeen;
    });
}

export function clearCloneStatuses(chatId) {
  const wantedChatId = String(chatId || "");
  if (!wantedChatId) return false;
  let changed = false;
  for (const [key, entry] of statuses) {
    if (entry.chatId === wantedChatId) changed = statuses.delete(key) || changed;
  }
  if (changed) notify({ type: "clear", chatId: wantedChatId });
  return changed;
}

export async function requestCloneStop(jobId, chatId, send = sendAction) {
  const matches = [...statuses.values()].filter((entry) => entry.jobId === String(jobId || "") && entry.chatId === String(chatId || ""));
  if (matches.length !== 1) throw new Error(`停止分身要求精确命中一个 job，实际 ${matches.length} 个`);
  const entry = matches[0];
  return send({
    verb: "stopCloneTask",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { chatid: entry.chatId, taskId: entry.taskId, cloneBatchId: entry.cloneBatchId, jobId: entry.jobId },
  });
}

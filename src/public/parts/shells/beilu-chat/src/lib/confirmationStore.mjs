/**
 * confirmationStore.mjs — Smart/Chat 模式调度提案的 pending-confirmation 协调器（P0-A，2026-08-03）。
 *
 * 【功能链】
 *   Smart/Chat AI 输出 <modeSwitch>code|work</modeSwitch>
 *     → replyHandler 提案硬门（不执行副作用、不写 running overlay）
 *     → 本模块 createPendingConfirmation（persist：shell data "smart_confirmations"，per-user）
 *     → reply.extension._pendingConfirmation → 前端确认卡（tempConversation）
 *     → 用户确认/取消 → endpoints smart-confirmations/confirm|cancel（认证 + owner/chat 校验）
 *     → claimConfirmation 单次 claim → 目标 mode chat 单源补齐（ensureModeChatsForChar）
 *     → task_start 落盘 → completeClaim(status=confirmed) → 返回 accepted
 *   刷新/重连：GET status 端点 listConfirmations 重新投影。
 *
 * 【why】
 *   旧链在"用户尚未确认"时就写 status=running 的角色级 _active_task_overlay.json、
 *   前端复制 new+bind+pointer 创建循环、`<temp_confirm>` 直接送进目标普通生成链——
 *   提案与执行没有硬门。本模块把"提案"变成服务端一等状态：pending 不是 running，
 *   confirm 是认证端点上的单次 claim，不是前端按钮的乐观切 Tab。
 *
 * 【契约】
 *   - 状态机：pending → claimed → confirmed；pending → cancelled | expired；
 *     claimed 执行失败 → 回 pending（记 lastError，用户可重试确认）。
 *   - claim 是同步 check-and-set（Node 单线程原子）：并发确认只有一个成功执行者，
 *     其余得到 E_CONFIRM_IN_FLIGHT / already-executed 幂等回执。
 *   - confirmed 后重放 confirm → 返回既有执行结果（幂等），不重复执行。
 *   - owner 只来自服务端 session（调用方传入的 username 必须是认证后的值）；
 *     record.ownerUsername / sourceChatId 与请求不匹配一律拒绝，payload 不能覆盖。
 *   - 过期懒判定：任何读/claim 时 now>expiresAt 且仍 pending → expired。
 *   - 持久化：shell data "smart_confirmations"（data/users/<u>/shells/chat/smart_confirmations.json），
 *     按 owner 隔离；终态记录保留最近 MAX_TERMINAL_KEEP 条供对账，超量按时间裁剪。
 *
 * 【关联链】
 *   ← yonban replyHandler.mjs（动态 import，提案生产者）
 *   ← endpoints.mjs smart-confirmations 三路由（confirm/cancel/status 消费者）
 *   → server/setting_loader.mjs loadShellData/saveShellData（持久化）
 *   → yonban storage.mjs（TTL 配置读取 advanced_limits.smart_confirm_ttl_sec）
 */
import crypto from "node:crypto";
import {
  loadShellData,
  saveShellData,
} from "../../../../../../server/setting_loader.mjs";
import {
  getYonbanConfigPath,
  loadJsonFileIfExists,
} from "../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs";

const SHELL = "chat";
const STORE = "smart_confirmations";
const DEFAULT_TTL_SEC = 600; // 出厂默认 10 分钟；用户可配 advanced_limits.smart_confirm_ttl_sec
const MAX_TERMINAL_KEEP = 50;

/** 提案 TTL（秒）：用户可配，非法/缺省回退出厂值。 */
function _ttlSec(username) {
  try {
    const v = Number(loadJsonFileIfExists(getYonbanConfigPath(username), {}).advanced_limits?.smart_confirm_ttl_sec);
    if (Number.isFinite(v) && v > 0) return Math.min(v, 86400);
  } catch { /* 配置不可读 → 出厂值 */ }
  return DEFAULT_TTL_SEC;
}

function _store(username) {
  const data = loadShellData(username, SHELL, STORE);
  // loadShellData 首装返回 {}（_loadSettingsFile 缺失文件语义）；损坏时上抛由调用方可见
  return data && typeof data === "object" ? data : {};
}

function _persist(username) {
  saveShellData(username, SHELL, STORE);
}

/** 懒过期 + 终态裁剪（写点统一走这里，读点只做过期判定不落盘）。 */
function _sweep(store, now) {
  let dirty = false;
  const terminal = [];
  for (const rec of Object.values(store)) {
    if (rec.status === "pending" && rec.expiresAt && now > rec.expiresAt) {
      rec.status = "expired";
      rec.expiredAt = now;
      dirty = true;
    }
    if (rec.status !== "pending" && rec.status !== "claimed") terminal.push(rec);
  }
  if (terminal.length > MAX_TERMINAL_KEEP) {
    terminal.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const rec of terminal.slice(0, terminal.length - MAX_TERMINAL_KEEP)) {
      delete store[rec.confirmationId];
      dirty = true;
    }
  }
  return dirty;
}

/** 对外投影（不含内部 claim 中间态细节，供前端/extension 消费）。 */
export function projectConfirmation(rec) {
  if (!rec) return null;
  return {
    confirmationId: rec.confirmationId,
    revision: rec.revision,
    status: rec.status,
    sourceChatId: rec.sourceChatId,
    sourceCharName: rec.sourceCharName,
    sourceMode: rec.sourceMode,
    targetMode: rec.targetMode,
    taskTitle: rec.taskTitle,
    deferredTags: rec.deferredTags || [],
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    lastError: rec.lastError || null,
    result: rec.status === "confirmed"
      ? { targetChatId: rec.targetChatId || "", taskStartMessageId: rec.taskStartMessageId || "" }
      : null,
  };
}

/**
 * 创建 pending 提案（replyHandler 提案硬门调用）。
 * @returns {object} 完整 record（调用方用 projectConfirmation 投影进 extension）
 */
export function createPendingConfirmation({
  ownerUsername,
  sourceChatId,
  sourceCharName,
  sourceMode,
  sourceMessageId,
  targetMode,
  taskTitle,
  deferredTags,
}) {
  if (!ownerUsername) throw new Error("createPendingConfirmation: 缺少 ownerUsername");
  if (targetMode !== "code" && targetMode !== "work") throw new Error(`createPendingConfirmation: 非法 targetMode "${targetMode}"`);
  const now = Date.now();
  const store = _store(ownerUsername);
  _sweep(store, now);
  const rec = {
    confirmationId: `conf_${now.toString(36)}_${crypto.randomBytes(6).toString("hex")}`,
    revision: 1,
    status: "pending",
    ownerUsername,
    sourceChatId: sourceChatId || "",
    sourceCharName: sourceCharName || "",
    sourceMode: sourceMode || "smart",
    sourceMessageId: sourceMessageId || "",
    targetMode,
    taskTitle: (taskTitle || "").slice(0, 200),
    deferredTags: Array.isArray(deferredTags) ? deferredTags.slice(0, 40) : [],
    createdAt: now,
    expiresAt: now + _ttlSec(ownerUsername) * 1000,
  };
  store[rec.confirmationId] = rec;
  _persist(ownerUsername);
  return rec;
}

/** 读取单条（带懒过期）。owner/sourceChat 不匹配 → null（调用方按 404/403 语义处理）。 */
export function getConfirmation(username, confirmationId) {
  const store = _store(username);
  const now = Date.now();
  if (_sweep(store, now)) _persist(username);
  const rec = store[confirmationId];
  if (!rec || rec.ownerUsername !== username) return null;
  return rec;
}

/** 某源对话的全部提案投影（status 端点重新投影用；pending 在前、新在前）。 */
export function listConfirmations(username, sourceChatId) {
  const store = _store(username);
  const now = Date.now();
  if (_sweep(store, now)) _persist(username);
  return Object.values(store)
    .filter((r) => r.ownerUsername === username && (!sourceChatId || r.sourceChatId === sourceChatId))
    .sort((a, b) => {
      const ap = a.status === "pending" ? 0 : 1;
      const bp = b.status === "pending" ? 0 : 1;
      return ap !== bp ? ap - bp : (b.createdAt || 0) - (a.createdAt || 0);
    })
    .map(projectConfirmation);
}

/**
 * 单次 claim（同步原子 check-and-set）。全部校验失败都是明确错误码，无静默任选。
 * @returns {{ok:true, record:object}|{ok:false, code:string, error:string, record?:object}}
 */
export function claimConfirmation(username, { confirmationId, revision, sourceChatId }) {
  const store = _store(username);
  const now = Date.now();
  if (_sweep(store, now)) _persist(username);
  const rec = store[confirmationId];
  if (!rec) return { ok: false, code: "E_CONFIRM_NOT_FOUND", error: "确认请求不存在或已被清理" };
  if (rec.ownerUsername !== username) return { ok: false, code: "E_CONFIRM_OWNER_MISMATCH", error: "确认请求不属于当前用户" };
  if (sourceChatId && rec.sourceChatId !== sourceChatId) return { ok: false, code: "E_CONFIRM_CHAT_MISMATCH", error: "确认请求与来源对话不匹配" };
  if (revision !== undefined && Number(revision) !== rec.revision) return { ok: false, code: "E_CONFIRM_REVISION_MISMATCH", error: `revision 不匹配（当前 ${rec.revision}）`, record: rec };
  if (rec.status === "confirmed") return { ok: false, code: "E_CONFIRM_ALREADY_EXECUTED", error: "该提案已执行", record: rec };
  if (rec.status === "cancelled") return { ok: false, code: "E_CONFIRM_CANCELLED", error: "该提案已取消", record: rec };
  if (rec.status === "expired") return { ok: false, code: "E_CONFIRM_EXPIRED", error: "该提案已过期", record: rec };
  if (rec.status === "claimed") return { ok: false, code: "E_CONFIRM_IN_FLIGHT", error: "该提案正在执行中（另一确认请求已 claim）", record: rec };
  // pending → claimed（同步段内无 await，Node 单线程下即原子）
  rec.status = "claimed";
  rec.claimedAt = now;
  _persist(username);
  return { ok: true, record: rec };
}

/** claim 执行成功收尾：claimed → confirmed，记录执行结果（幂等对账数据）。 */
export function completeClaim(username, confirmationId, { targetChatId, taskStartMessageId }) {
  const store = _store(username);
  const rec = store[confirmationId];
  if (!rec || rec.status !== "claimed") return false;
  rec.status = "confirmed";
  rec.executedAt = Date.now();
  rec.targetChatId = targetChatId || "";
  rec.taskStartMessageId = taskStartMessageId || "";
  rec.lastError = null;
  _persist(username);
  return true;
}

/** claim 执行失败回退：claimed → pending（记 lastError，用户可见并可重试确认）。 */
export function failClaim(username, confirmationId, error) {
  const store = _store(username);
  const rec = store[confirmationId];
  if (!rec || rec.status !== "claimed") return false;
  rec.status = "pending";
  rec.lastError = String(error?.message || error || "执行失败").slice(0, 500);
  delete rec.claimedAt;
  _persist(username);
  return true;
}

/**
 * 取消提案。pending → cancelled；已 cancelled 幂等成功；confirmed/expired/claimed 明确报错。
 * @returns {{ok:boolean, code?:string, error?:string, record?:object}}
 */
export function cancelConfirmation(username, { confirmationId, sourceChatId }) {
  const store = _store(username);
  const now = Date.now();
  if (_sweep(store, now)) _persist(username);
  const rec = store[confirmationId];
  if (!rec) return { ok: false, code: "E_CONFIRM_NOT_FOUND", error: "确认请求不存在或已被清理" };
  if (rec.ownerUsername !== username) return { ok: false, code: "E_CONFIRM_OWNER_MISMATCH", error: "确认请求不属于当前用户" };
  if (sourceChatId && rec.sourceChatId !== sourceChatId) return { ok: false, code: "E_CONFIRM_CHAT_MISMATCH", error: "确认请求与来源对话不匹配" };
  if (rec.status === "cancelled") return { ok: true, record: rec }; // 幂等
  if (rec.status === "confirmed") return { ok: false, code: "E_CONFIRM_ALREADY_EXECUTED", error: "该提案已执行，无法取消（执行取消请在目标窗口停止生成）", record: rec };
  if (rec.status === "expired") return { ok: false, code: "E_CONFIRM_EXPIRED", error: "该提案已过期", record: rec };
  if (rec.status === "claimed") return { ok: false, code: "E_CONFIRM_IN_FLIGHT", error: "该提案正在执行中，无法取消", record: rec };
  rec.status = "cancelled";
  rec.cancelledAt = now;
  _persist(username);
  return { ok: true, record: rec };
}

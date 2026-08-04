/**
 * 跨存储回档协调器。
 *
 * 顺序契约：稳定消息 ID 解析 → 生成静默点 → 再解析 → 记忆/IDE 回档 →
 * 同一稳定消息 ID 截断聊天。记忆层成功而聊天层失败时必须返回 partial，禁止假成功。
 */

import crypto from "node:crypto";
import {
  resolveMessageAnchor,
  withChatHistoryMutation,
} from "../../../../public/parts/shells/beilu-chat/src/lib/chatOps.mjs";
import {
  chatMetadatas,
  loadChat,
} from "../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs";
import { quiesceGenerationForHistoryRewrite } from "../../../../public/parts/shells/beilu-chat/src/lib/generation.mjs";
import {
  executeCoordinatedMemoryRollback,
  handleSetData,
} from "../memory/handler/setDataActions.mjs";
import { completeContextSummaryRollback } from "../memory/storage_mod/storage.mjs";
import {
  ideRouteSnapshotsEqual,
  isValidIdeRouteSnapshot,
} from "../../transport/ideClient.mjs";

// 回档本身先 per-chat 串行，再按“等生成→取 chat 写锁”的唯一锁序执行。
// 禁止持 chat 写锁等生成：生成结算可能经 addUserReply 取同一锁，反序会死锁。
const _rollbackQueues = new Map();
const _CHARACTER_SCOPE_TOKEN_VERSION = 1;
const _characterScopeSigningKey = crypto.randomBytes(32);

async function _serializeRollback(chatId, operation) {
  const previous = _rollbackQueues.get(chatId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  _rollbackQueues.set(chatId, run);
  try {
    return await run;
  } finally {
    if (_rollbackQueues.get(chatId) === run) _rollbackQueues.delete(chatId);
  }
}

function _businessError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function _validateRequest({ chatId, username, anchorMessageId, targetIndex }) {
  if (typeof chatId !== "string" || !chatId) {
    throw _businessError("chatId must be a non-empty string", "E_INVALID_CHAT_ID");
  }
  if (typeof username !== "string" || !username) {
    throw _businessError("username is required", "E_ROLLBACK_OWNER_REQUIRED", 401);
  }
  if (typeof anchorMessageId !== "string" || !anchorMessageId.trim()) {
    throw _businessError("anchorMessageId must be a non-empty string", "E_INVALID_MESSAGE_ANCHOR");
  }
  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    throw _businessError("targetIndex must be a non-negative integer", "E_INVALID_MESSAGE_INDEX");
  }
}

async function _resolveContext(chatId, username) {
  const chatMetadata = await loadChat(chatId);
  const meta = chatMetadatas.get(chatId);
  if (!chatMetadata || !meta) throw _businessError("Chat not found", "E_CHAT_NOT_FOUND", 404);
  if (meta.username !== username || chatMetadata.username !== username) {
    throw _businessError("Chat owner mismatch", "E_ROLLBACK_OWNER_MISMATCH", 403);
  }
  const charNames = new Set();
  if (typeof meta.primaryCharName === "string" && meta.primaryCharName) charNames.add(meta.primaryCharName);
  for (const name of Object.keys(chatMetadata.LastTimeSlice?.chars || {})) {
    if (name) charNames.add(name);
  }
  // 摘要/表格按 charName 分桶；历史上参与过但当前 timeSlice 已移除的角色也可能
  // 留有摘要桶，不能只看 primary/current chars 后静默遗漏。
  for (const entry of Array.isArray(chatMetadata.chatLog) ? chatMetadata.chatLog : []) {
    for (const name of Object.keys(entry?.timeSlice?.chars || {})) {
      if (name) charNames.add(name);
    }
  }
  const normalizedCharNames = [...charNames].sort();
  if (normalizedCharNames.length === 0) normalizedCharNames.push("_global");
  return { chatMetadata, charName: normalizedCharNames[0], charNames: normalizedCharNames };
}

function _assertSingleCharacterScope(charNames) {
  if (!Array.isArray(charNames) || charNames.length !== 1) {
    throw _businessError(
      `Rollback across ${Array.isArray(charNames) ? charNames.length : 0} character-scoped memory buckets is not atomically supported`,
      "E_ROLLBACK_MULTI_CHAR_UNSUPPORTED",
      409,
    );
  }
  return charNames[0];
}

function _normalizeCharacterScope(value) {
  if (!Array.isArray(value)
    || value.length !== 1
    || value.some((name) => typeof name !== "string" || !name.trim())) {
    throw _businessError("expectedCharacterScope must contain exactly one non-empty character name", "E_INVALID_ROLLBACK_CHARACTER_SCOPE");
  }
  return [...new Set(value.map((name) => name.trim()))].sort();
}

export function characterScopesEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function _signCharacterScopePayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", _characterScopeSigningKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function _verifyCharacterScopeToken(token, expected) {
  if (typeof token !== "string") {
    throw _businessError("characterScopeToken is required", "E_ROLLBACK_CHARACTER_SCOPE_TOKEN_REQUIRED", 409);
  }
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) {
    throw _businessError("characterScopeToken shape is invalid", "E_ROLLBACK_CHARACTER_SCOPE_TOKEN_INVALID", 409);
  }
  const expectedSignature = crypto.createHmac("sha256", _characterScopeSigningKey).update(encoded).digest();
  let actualSignature;
  try { actualSignature = Buffer.from(signature, "base64url"); }
  catch { actualSignature = Buffer.alloc(0); }
  if (actualSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    throw _businessError("characterScopeToken signature is invalid", "E_ROLLBACK_CHARACTER_SCOPE_TOKEN_INVALID", 409);
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch {
    throw _businessError("characterScopeToken payload is invalid", "E_ROLLBACK_CHARACTER_SCOPE_TOKEN_INVALID", 409);
  }
  const scope = _normalizeCharacterScope(payload?.characterScope);
  if (payload?.version !== _CHARACTER_SCOPE_TOKEN_VERSION
    || payload?.chatId !== expected.chatId
    || payload?.username !== expected.username
    || payload?.anchorMessageId !== expected.anchorMessageId
    || !characterScopesEqual(scope, expected.characterScope)) {
    throw _businessError("characterScopeToken does not match this rollback request", "E_ROLLBACK_CHARACTER_SCOPE_TOKEN_MISMATCH", 409);
  }
  return scope;
}

function _characterScopeDriftFailure(chatId, anchor, expectedCharacterScope, actualCharacterScope, quiesce = null) {
  return {
    success: false,
    confirmed: false,
    applied: false,
    partial: false,
    chatId,
    anchor,
    error: "Rollback character scope changed after preview",
    code: "E_ROLLBACK_CHARACTER_SCOPE_DRIFT",
    drift: "characterScope",
    expectedCharacterScope,
    actualCharacterScope,
    ...(quiesce ? { quiesce } : {}),
  };
}

function _anchorFailure(chatId, anchor) {
  return {
    success: false,
    confirmed: false,
    applied: false,
    partial: false,
    chatId,
    anchor,
    error: "Rollback anchor was not found",
    code: "E_ROLLBACK_ANCHOR_NOT_FOUND",
  };
}

/** 纯函数：只有各层协议和持久提交证据全部闭合时才产出 confirmed=true。 */
export function deriveRollbackExecutionConfirmed({
  success,
  applied,
  noOp,
  partial,
  pending,
  indeterminate,
  drift,
  safetyRollbackError,
  remaining,
  memoryEnvelopeOk,
  summaryLeaseCompleted,
  chatCommitted,
  chatNoOp,
} = {}) {
  return success === true
    && applied === true
    && noOp !== true
    && partial === false
    && (pending === undefined || pending === false)
    && (indeterminate === undefined || indeterminate === false)
    && (drift === undefined || drift === null || drift === "")
    && !safetyRollbackError
    && Array.isArray(remaining) && remaining.length === 0
    && memoryEnvelopeOk === true
    && summaryLeaseCompleted === true
    && (chatCommitted === true || chatNoOp === true);
}

/** no-op 不等于普通成功：必须由服务端证明所有支持层均未写且无未知终态。 */
export function deriveRollbackNoOpConfirmed({
  success,
  applied,
  noOp,
  partial,
  pending,
  indeterminate,
  drift,
  safetyRollbackError,
  remaining,
  memoryEnvelopeOk,
  summaryLeaseCompleted,
  chatCommitted,
  chatNoOp,
} = {}) {
  return success === true
    && applied === false
    && noOp === true
    && partial === false
    && (pending === undefined || pending === false)
    && (indeterminate === undefined || indeterminate === false)
    && (drift === undefined || drift === null || drift === "")
    && !safetyRollbackError
    && Array.isArray(remaining) && remaining.length === 0
    && memoryEnvelopeOk === true
    && summaryLeaseCompleted === true
    && chatCommitted !== true
    && chatNoOp === true;
}

function _memoryArgs(username, charName, chatId) {
  return { username, char_id: charName, chatid: chatId };
}

function _memoryArchiveNotCovered() {
  return {
    status: "not_covered",
    coveredByLedger: false,
    affectedOperations: null,
    restoredOperations: 0,
    reason: "角色级 hot/warm/cold 归档记忆尚无按消息范围的操作账本或快照，本次回档无法恢复该层。",
  };
}

function _withMemoryArchiveCoverage(result) {
  return {
    ...(result || {}),
    memoryArchive: _memoryArchiveNotCovered(),
  };
}

function _completedAppliedLayers(memory, { includeChat = false } = {}) {
  const completed = [];
  if (memory?.tableRestored === true) completed.push("table");
  const file = memory?.fileRollback;
  const fileApplied = file?.success === true && [
    file.checkpointsReverted,
    file.totalRestored,
    file.totalDeleted,
  ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (fileApplied) completed.push("ide_files");
  if (memory?.contextSummaryInvalidated === true) {
    completed.push("context_summary");
  }
  if (includeChat) completed.push("chat");
  return completed;
}

function _memoryApplied(memory) {
  // 结果判定只从可核对的层级效果派生；不得信任生产者自报的 applied/restored。
  if (memory?.tableRestored === true) return true;
  if (memory?.contextSummaryInvalidated === true) return true;
  const file = memory?.fileRollback;
  return [
    file?.checkpointsReverted,
    file?.totalRestored,
    file?.totalDeleted,
  ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function _isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function _isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function _isUniqueNonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function _isValidFileRollbackEnvelope(fileRollback, expectedCheckpointIds) {
  if (!_isPlainRecord(fileRollback)) return false;
  if (fileRollback.success !== true || fileRollback.partial !== false) return false;
  if (!((fileRollback.pending === undefined || fileRollback.pending === false)
    && (fileRollback.indeterminate === undefined || fileRollback.indeterminate === false))) return false;
  if (fileRollback.drift !== undefined && fileRollback.drift !== null && fileRollback.drift !== "") return false;
  if (fileRollback.checkpointSetDrift !== false) return false;
  if (!["attempted", "reverted", "checkpointsReverted", "totalRestored", "totalDeleted"]
    .every((field) => _isNonNegativeInteger(fileRollback[field]))) return false;
  if (!Array.isArray(fileRollback.errors)
    || !fileRollback.errors.every((item) => typeof item === "string")
    || fileRollback.errors.length !== 0) return false;
  if (!Array.isArray(fileRollback.failedFiles)
    || !fileRollback.failedFiles.every((item) => typeof item === "string")
    || fileRollback.failedFiles.length !== 0) return false;
  if (!_isUniqueNonEmptyStringArray(fileRollback.checkpointIds)
    || !_isUniqueNonEmptyStringArray(fileRollback.remainingCheckpointIds)) return false;
  if (fileRollback.remainingCheckpointIds.length !== 0) return false;
  if (!_sameStringArray(fileRollback.checkpointIds, expectedCheckpointIds)) return false;
  const expectedCount = expectedCheckpointIds.length;
  if (fileRollback.attempted !== expectedCount
    || fileRollback.reverted !== expectedCount
    || fileRollback.checkpointsReverted !== expectedCount) return false;
  return true;
}

function _sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function _isValidLegacyContextSummaryBoundary(value) {
  return _isPlainRecord(value)
    && value.status === "not_covered_ambiguous"
    && value.deleted === false;
}

function _isValidSummaryRewriteLease(value) {
  return _isPlainRecord(value)
    && typeof value.leaseId === "string" && value.leaseId.length > 0
    && _isNonNegativeInteger(value.epoch)
    && _isNonNegativeInteger(value.revision)
    && typeof value.leaseExpiresAt === "string"
    && Number.isFinite(Date.parse(value.leaseExpiresAt));
}

/**
 * 纯函数协议门：把执行结果与执行前预览令牌做语义闭合。
 * 返回 reason 供协议错误诊断；派生 applied 供调用方避免再次相信生产者自报。
 */
export function validateRollbackMemoryExecutionEnvelope(memory, previewToken) {
  if (!_isPlainRecord(previewToken)
    || !_isUniqueNonEmptyStringArray(previewToken.checkpointIds)
    || !(previewToken.tableSnapshotId === null
      || (typeof previewToken.tableSnapshotId === "string" && previewToken.tableSnapshotId.length > 0))
    || typeof previewToken.expectedIdeConnected !== "boolean"
    || !isValidIdeRouteSnapshot(previewToken.expectedIdeRoute)
    || previewToken.expectedIdeRoute.connected !== previewToken.expectedIdeConnected) {
    return { ok: false, reason: "invalid_preview_token", derivedApplied: false };
  }
  if (!_isPlainRecord(memory)
    || memory.success !== true
    || memory.partial !== false
    || typeof memory.applied !== "boolean"
    || typeof memory.restored !== "boolean"
    || typeof memory.tableRestored !== "boolean"
    || memory.contextSummaryInvalidated !== true
    || !_isNonNegativeInteger(memory.contextSummaryDeleted)
    || memory.contextSummaryDeleted > 1
    || !_isValidSummaryRewriteLease(memory.contextSummaryLease)
    || !_isValidLegacyContextSummaryBoundary(memory.legacyContextSummary)) {
    return { ok: false, reason: "invalid_memory_shape", derivedApplied: _memoryApplied(memory) };
  }
  if (!(memory.pending === undefined || memory.pending === false)) {
    return { ok: false, reason: "memory_pending", derivedApplied: _memoryApplied(memory) };
  }
  if (!(memory.indeterminate === undefined || memory.indeterminate === false)) {
    return { ok: false, reason: "memory_indeterminate", derivedApplied: _memoryApplied(memory) };
  }
  if (!(memory.drift === undefined || memory.drift === null || memory.drift === "")) {
    return { ok: false, reason: "memory_drift", derivedApplied: _memoryApplied(memory) };
  }
  if (memory.safetyRollbackError) {
    return { ok: false, reason: "memory_safety_rollback_error", derivedApplied: _memoryApplied(memory) };
  }
  if (!_sameStringArray(memory.checkpointIds, previewToken.checkpointIds)) {
    return { ok: false, reason: "checkpoint_token_mismatch", derivedApplied: _memoryApplied(memory) };
  }
  if (memory.tableSnapshotId !== previewToken.tableSnapshotId) {
    return { ok: false, reason: "table_token_mismatch", derivedApplied: _memoryApplied(memory) };
  }
  if (memory.expectedIdeConnected !== previewToken.expectedIdeConnected
    || !ideRouteSnapshotsEqual(memory.expectedIdeRoute, previewToken.expectedIdeRoute)) {
    return { ok: false, reason: "ide_route_token_mismatch", derivedApplied: _memoryApplied(memory) };
  }
  const expectedTableRestored = previewToken.tableSnapshotId !== null;
  if (memory.tableRestored !== expectedTableRestored) {
    return { ok: false, reason: "table_effect_mismatch", derivedApplied: _memoryApplied(memory) };
  }
  if (previewToken.checkpointIds.length > 0 && memory.fileRollback === null) {
    return { ok: false, reason: "file_result_missing", derivedApplied: _memoryApplied(memory) };
  }
  if (memory.fileRollback !== null
    && !_isValidFileRollbackEnvelope(memory.fileRollback, previewToken.checkpointIds)) {
    return { ok: false, reason: "invalid_file_result", derivedApplied: _memoryApplied(memory) };
  }
  const derivedApplied = _memoryApplied(memory);
  if (memory.applied !== derivedApplied || memory.restored !== derivedApplied) {
    return { ok: false, reason: "derived_effect_mismatch", derivedApplied };
  }
  return { ok: true, reason: null, derivedApplied };
}

/**
 * 只读回档预览。anchor.index 始终来自稳定 ID 的当前解析，targetIndex 只是客户端提示。
 */
export async function getRollbackPreview({
  chatId,
  username,
  anchorMessageId,
  targetIndex,
} = {}) {
  _validateRequest({ chatId, username, anchorMessageId, targetIndex });
  return _withMemoryArchiveCoverage(await withChatHistoryMutation(chatId, async () => {
    const { charNames } = await _resolveContext(chatId, username);
    const charName = _assertSingleCharacterScope(charNames);
    const anchor = await resolveMessageAnchor(chatId, anchorMessageId, targetIndex);
    if (!anchor.found) return _anchorFailure(chatId, anchor);
    const expectedCharacterScope = [...charNames];
    const characterScopeToken = _signCharacterScopePayload({
      version: _CHARACTER_SCOPE_TOKEN_VERSION,
      chatId,
      username,
      anchorMessageId: anchor.messageId,
      characterScope: expectedCharacterScope,
    });

    const memoryPreview = await handleSetData({
      _action: "getRollbackPreview",
      chatId,
      charName,
      anchorMessageId: anchor.messageId,
      targetIndex: anchor.index,
    }, _memoryArgs(username, charName, chatId));
    const previewShapeValid = memoryPreview?.success === true
      && memoryPreview?.pending !== true
      && memoryPreview?.indeterminate !== true
      && !memoryPreview?.drift
      && typeof memoryPreview.applied === "boolean"
      && Array.isArray(memoryPreview.checkpointIds)
      && memoryPreview.checkpointIds.every((id) => typeof id === "string" && id)
      && new Set(memoryPreview.checkpointIds).size === memoryPreview.checkpointIds.length
      && (memoryPreview.tableSnapshotId === null
        || (typeof memoryPreview.tableSnapshotId === "string" && memoryPreview.tableSnapshotId.length > 0))
      && typeof memoryPreview.expectedIdeConnected === "boolean"
      && isValidIdeRouteSnapshot(memoryPreview.expectedIdeRoute)
      && memoryPreview.expectedIdeRoute.connected === memoryPreview.expectedIdeConnected;
    if (!previewShapeValid) {
      return {
        success: false,
        confirmed: false,
        applied: false,
        partial: false,
        chatId,
        anchor: { messageId: anchor.messageId, index: anchor.index },
        error: memoryPreview?.error || (memoryPreview?.success === true
          ? "Rollback preview returned an invalid internal envelope"
          : "Rollback preview failed"),
        code: memoryPreview?.success === true
          ? "E_ROLLBACK_PREVIEW_PROTOCOL_INVALID"
          : "E_ROLLBACK_PREVIEW_FAILED",
        ...(memoryPreview?.drift ? {
          drift: memoryPreview.drift,
          expectedIdeRoute: memoryPreview.expectedIdeRoute,
          actualIdeRoute: memoryPreview.actualIdeRoute,
        } : {}),
        memory: memoryPreview || null,
      };
    }

    const checkpointIds = Array.isArray(memoryPreview.checkpointIds)
      ? memoryPreview.checkpointIds
      : [];
    const tableSnapshotId = memoryPreview.tableSnapshotId ?? null;
    const expectedIdeConnected = memoryPreview.expectedIdeConnected;
    const expectedIdeRoute = memoryPreview.expectedIdeRoute;
    if (!isValidIdeRouteSnapshot(expectedIdeRoute)) {
      return {
        success: false,
        confirmed: false,
        applied: false,
        partial: false,
        chatId,
        anchor: { messageId: anchor.messageId, index: anchor.index },
        error: "Rollback preview did not return a valid expectedIdeRoute token",
        code: "E_ROLLBACK_ROUTE_TOKEN_MISSING",
        memory: memoryPreview,
      };
    }
    return {
      ...memoryPreview,
      success: true,
      chatId,
      anchor: { messageId: anchor.messageId, index: anchor.index },
      checkpointIds,
      tableSnapshotId,
      expectedIdeConnected,
      expectedIdeRoute,
      expectedCharacterScope,
      characterScopeToken,
    };
  }));
}

/**
 * 执行跨存储回档。success && applied && !partial 只表示已支持层已应用；
 * memoryArchive 单独声明尚未纳入的归档记忆边界。
 */
export async function executeRollback({
  chatId,
  username,
  anchorMessageId,
  targetIndex,
  expectedIdeConnected,
  expectedIdeRoute,
  checkpointIds,
  tableSnapshotId,
  expectedCharacterScope,
  characterScopeToken,
} = {}) {
  _validateRequest({ chatId, username, anchorMessageId, targetIndex });
  const normalizedExpectedCharacterScope = _normalizeCharacterScope(expectedCharacterScope);
  _verifyCharacterScopeToken(characterScopeToken, {
    chatId,
    username,
    anchorMessageId,
    characterScope: normalizedExpectedCharacterScope,
  });
  if (!isValidIdeRouteSnapshot(expectedIdeRoute)) {
    throw _businessError("expectedIdeRoute must be an exact IDE route snapshot", "E_INVALID_IDE_ROUTE_EXPECTATION");
  }
  if (typeof expectedIdeConnected !== "boolean") {
    throw _businessError("expectedIdeConnected must be boolean", "E_INVALID_IDE_EXPECTATION");
  }
  if (expectedIdeConnected !== expectedIdeRoute.connected) {
    throw _businessError("expectedIdeConnected must match expectedIdeRoute.connected", "E_INCONSISTENT_IDE_EXPECTATION");
  }
  // 精确 route token 是执行门；布尔字段只保留为旧消费者的诊断镜像。
  const compatibilityIdeConnected = expectedIdeRoute.connected;
  if (!Array.isArray(checkpointIds)
    || checkpointIds.some((id) => typeof id !== "string" || !id)
    || new Set(checkpointIds).size !== checkpointIds.length) {
    throw _businessError("checkpointIds must be an array of unique non-empty strings", "E_INVALID_CHECKPOINT_IDS");
  }
  if (tableSnapshotId !== null && (typeof tableSnapshotId !== "string" || !tableSnapshotId)) {
    throw _businessError("tableSnapshotId must be a non-empty string or null", "E_INVALID_TABLE_SNAPSHOT_ID");
  }

  return _withMemoryArchiveCoverage(await _serializeRollback(chatId, async () => {
    const initialContext = await _resolveContext(chatId, username);
    if (!characterScopesEqual(initialContext.charNames, normalizedExpectedCharacterScope)) {
      return _characterScopeDriftFailure(
        chatId,
        { messageId: anchorMessageId, index: targetIndex },
        normalizedExpectedCharacterScope,
        initialContext.charNames,
      );
    }
    const charName = normalizedExpectedCharacterScope[0];
    const initialAnchor = await resolveMessageAnchor(chatId, anchorMessageId, targetIndex);
    if (!initialAnchor.found) return _anchorFailure(chatId, initialAnchor);

    const quiesceLease = await quiesceGenerationForHistoryRewrite(chatId);
    const quiesce = {
      quiesced: quiesceLease.quiesced,
      hadInFlight: quiesceLease.hadInFlight,
      abortedStreams: quiesceLease.abortedStreams,
    };
    try {
      return await withChatHistoryMutation(chatId, async ({ deleteMessagesRange }) => {
        const lockedContext = await _resolveContext(chatId, username);
        if (!characterScopesEqual(lockedContext.charNames, normalizedExpectedCharacterScope)) {
          return _characterScopeDriftFailure(
            chatId,
            { messageId: anchorMessageId, index: initialAnchor.index },
            normalizedExpectedCharacterScope,
            lockedContext.charNames,
            quiesce,
          );
        }
        const anchor = await resolveMessageAnchor(chatId, anchorMessageId, initialAnchor.index);
        if (!anchor.found) return { ..._anchorFailure(chatId, anchor), quiesce };

        const alreadyAtTarget = anchor.index === lockedContext.chatMetadata.chatLog.length - 1;
        if (alreadyAtTarget && checkpointIds.length === 0 && tableSnapshotId === null) {
          // no-op 必须重新读取当前服务端预览，确认确认窗口内 IDE route/检查点/表格
          // 仍为空；不能只凭客户端带回的旧 token，也不应为 no-op 推进摘要 epoch。
          const currentPreview = await handleSetData({
            _action: "getRollbackPreview",
            chatId,
            charName,
            anchorMessageId: anchor.messageId,
            targetIndex: anchor.index,
          }, _memoryArgs(username, charName, chatId));
          const previewStillEmpty = currentPreview?.success === true
            && currentPreview?.applied === false
            && (currentPreview?.pending === undefined || currentPreview?.pending === false)
            && (currentPreview?.indeterminate === undefined || currentPreview?.indeterminate === false)
            && !currentPreview?.drift
            && !currentPreview?.safetyRollbackError
            && _sameStringArray(currentPreview?.checkpointIds, checkpointIds)
            && currentPreview?.tableSnapshotId === tableSnapshotId
            && currentPreview?.expectedIdeConnected === compatibilityIdeConnected
            && ideRouteSnapshotsEqual(currentPreview?.expectedIdeRoute, expectedIdeRoute);
          if (!previewStillEmpty) {
            return {
              success: false,
              confirmed: false,
              noOpConfirmed: false,
              applied: false,
              partial: false,
              chatId,
              anchor: { messageId: anchor.messageId, index: anchor.index },
              error: currentPreview?.error || "Rollback preview changed before no-op confirmation",
              code: currentPreview?.code || "E_ROLLBACK_NOOP_PREVIEW_DRIFT",
              ...(currentPreview?.drift ? { drift: currentPreview.drift } : {}),
              quiesce,
              memory: currentPreview || null,
            };
          }
          const noOpConfirmed = deriveRollbackNoOpConfirmed({
            success: true,
            applied: false,
            noOp: true,
            partial: false,
            pending: false,
            indeterminate: false,
            drift: null,
            safetyRollbackError: null,
            remaining: [],
            memoryEnvelopeOk: true,
            summaryLeaseCompleted: true,
            chatCommitted: false,
            chatNoOp: true,
          });
          return {
            success: true,
            confirmed: false,
            noOpConfirmed,
            applied: false,
            noOp: true,
            partial: false,
            chatId,
            anchor: { messageId: anchor.messageId, index: anchor.index },
            checkpointIds: [],
            tableSnapshotId: null,
            expectedIdeConnected: compatibilityIdeConnected,
            expectedIdeRoute,
            expectedCharacterScope: normalizedExpectedCharacterScope,
            completed: [],
            quiesce,
            memory: currentPreview,
            summaryLeaseCompletion: { completed: true, notRequired: true },
            chat: {
              deletedCount: 0,
              newLength: lockedContext.chatMetadata.chatLog.length,
              committed: false,
              status: "not_modified",
              revision: null,
              derived: null,
            },
          };
        }

        const memory = await executeCoordinatedMemoryRollback({
          _action: "rollbackMemoryToMessage",
          chatId,
          charName,
          anchorMessageId: anchor.messageId,
          targetIndex: anchor.index,
          expectedIdeConnected: compatibilityIdeConnected,
          expectedIdeRoute,
          checkpointIds,
          expectedCheckpointIds: checkpointIds,
          tableSnapshotId,
        }, _memoryArgs(username, charName, chatId));

        const memoryEnvelope = validateRollbackMemoryExecutionEnvelope(memory, {
          checkpointIds,
          tableSnapshotId,
          expectedIdeConnected: compatibilityIdeConnected,
          expectedIdeRoute,
        });
        if (!memoryEnvelope.ok) {
          let summaryLeaseCompletion = null;
          if (_isValidSummaryRewriteLease(memory?.contextSummaryLease)) {
            try {
              summaryLeaseCompletion = await completeContextSummaryRollback(username, charName, chatId, {
                leaseId: memory.contextSummaryLease.leaseId,
              });
            } catch (error) {
              summaryLeaseCompletion = { completed: false, code: error?.code || "E_CONTEXT_SUMMARY_LEASE_COMPLETE_FAILED", error: error?.message || String(error) };
            }
          }
          const memoryApplied = memoryEnvelope.derivedApplied;
          const indeterminate = memory?.indeterminate === true
            || memory?.pending === true
            || memory?.fileRollback?.indeterminate === true
            || memory?.fileRollback?.pending === true;
          const partial = indeterminate || memory?.partial === true || memoryApplied || !!memory?.safetyRollbackError;
          return {
            success: false,
            confirmed: false,
            applied: memoryApplied,
            partial,
            ...(indeterminate ? {
              indeterminate: true,
              pending: memory?.pending === true || memory?.fileRollback?.pending === true,
            } : {}),
            chatId,
            anchor: { messageId: anchor.messageId, index: anchor.index },
            error: memory?.error || memory?.warning || (memory?.success === true
              ? `Memory rollback returned an invalid internal envelope (${memoryEnvelope.reason})`
              : "Memory rollback failed"),
            code: memory?.success === true
              ? "E_ROLLBACK_MEMORY_PROTOCOL_INVALID"
              : (memory?.code || "E_ROLLBACK_MEMORY_FAILED"),
            ...(memory?.safetyRollbackError ? { safetyRollbackError: memory.safetyRollbackError } : {}),
            ...(memory?.drift ? {
              drift: memory.drift,
              expectedIdeRoute: memory.expectedIdeRoute ?? expectedIdeRoute,
              actualIdeRoute: memory.actualIdeRoute,
            } : {}),
            completed: _completedAppliedLayers(memory),
            quiesce,
            memory: memory || null,
            ...(summaryLeaseCompletion ? { summaryLeaseCompletion } : {}),
          };
        }

        const memoryApplied = _memoryApplied(memory);

        let chatResult = null;
        let chatError = null;
        let summaryLeaseCompletion = null;
        try {
          chatResult = await deleteMessagesRange(
            anchor.index + 1,
            undefined,
            { anchorMessageId: anchor.messageId },
          );
        } catch (error) {
          chatError = error;
        } finally {
          try {
            summaryLeaseCompletion = await completeContextSummaryRollback(username, charName, chatId, {
              leaseId: memory.contextSummaryLease.leaseId,
            });
          } catch (error) {
            summaryLeaseCompletion = {
              completed: false,
              code: error?.code || "E_CONTEXT_SUMMARY_LEASE_COMPLETE_FAILED",
              error: error?.message || String(error),
            };
          }
        }

        if (summaryLeaseCompletion?.completed !== true) {
          return {
            success: false,
            confirmed: false,
            applied: memoryApplied || chatResult?.applied === true || chatResult?.chatCommitted === true,
            partial: true,
            chatId,
            anchor: { messageId: anchor.messageId, index: anchor.index },
            error: `Context summary rewrite lease was not released by its owner: ${summaryLeaseCompletion?.error || summaryLeaseCompletion?.code || "unknown"}`,
            code: summaryLeaseCompletion?.code || "E_CONTEXT_SUMMARY_LEASE_COMPLETE_FAILED",
            safetyRollbackError: summaryLeaseCompletion?.error || summaryLeaseCompletion?.code || "lease completion failed",
            completed: _completedAppliedLayers(memory, { includeChat: chatResult?.chatCommitted === true }),
            quiesce,
            memory,
            chat: chatResult,
            summaryLeaseCompletion,
          };
        }

        if (chatError) {
          return {
            success: false,
            confirmed: false,
            applied: memoryApplied,
            partial: memoryApplied,
            chatId,
            anchor: { messageId: anchor.messageId, index: anchor.index },
            error: `Chat rollback failed after memory rollback: ${chatError?.message || chatError}`,
            safetyRollbackError: chatError?.message || String(chatError),
            completed: _completedAppliedLayers(memory),
            quiesce,
            memory,
            summaryLeaseCompletion,
          };
        }

        const chatCommitted = chatResult?.applied === true && chatResult?.chatCommitted === true;
        const chatNoOp = chatResult?.applied === false
          && chatResult?.reason === "empty_range"
          && chatResult?.chatCommitted !== true;
        if (!chatCommitted && !chatNoOp) {
          const chatMayHaveApplied = chatResult?.applied === true || chatResult?.chatCommitted === true;
          const applied = memoryApplied || chatMayHaveApplied;
          return {
            success: false,
            confirmed: false,
            applied,
            partial: applied,
            chatId,
            anchor: { messageId: anchor.messageId, index: anchor.index },
            error: `Chat rollback did not return a confirmed commit/no-op result: ${chatResult?.reason || chatResult?.status || "unknown"}`,
            code: "E_ROLLBACK_CHAT_PROTOCOL_INVALID",
            completed: _completedAppliedLayers(memory),
            quiesce,
            memory,
            chat: chatResult,
            summaryLeaseCompletion,
          };
        }

        const applied = memoryApplied || chatCommitted;
        const noOp = !applied;
        const confirmed = deriveRollbackExecutionConfirmed({
          success: true,
          applied,
          noOp,
          partial: false,
          pending: memory?.pending,
          indeterminate: memory?.indeterminate,
          drift: memory?.drift ?? memory?.fileRollback?.drift,
          safetyRollbackError: memory?.safetyRollbackError,
          remaining: memory?.fileRollback?.remainingCheckpointIds || [],
          memoryEnvelopeOk: memoryEnvelope.ok,
          summaryLeaseCompleted: summaryLeaseCompletion?.completed === true,
          chatCommitted,
          chatNoOp,
        });
        const noOpConfirmed = deriveRollbackNoOpConfirmed({
          success: true,
          applied,
          noOp,
          partial: false,
          pending: memory?.pending,
          indeterminate: memory?.indeterminate,
          drift: memory?.drift ?? memory?.fileRollback?.drift,
          safetyRollbackError: memory?.safetyRollbackError,
          remaining: memory?.fileRollback?.remainingCheckpointIds || [],
          memoryEnvelopeOk: memoryEnvelope.ok,
          summaryLeaseCompleted: summaryLeaseCompletion?.completed === true,
          chatCommitted,
          chatNoOp,
        });
        return {
          success: true,
          confirmed,
          noOpConfirmed,
          applied,
          noOp,
          partial: false,
          chatId,
          anchor: { messageId: anchor.messageId, index: anchor.index },
          checkpointIds: Array.isArray(checkpointIds) ? checkpointIds : [],
          tableSnapshotId: tableSnapshotId ?? null,
          expectedIdeConnected: compatibilityIdeConnected,
          expectedIdeRoute,
          expectedCharacterScope: normalizedExpectedCharacterScope,
          completed: _completedAppliedLayers(memory, { includeChat: chatCommitted }),
          quiesce,
          memory,
          summaryLeaseCompletion,
          chat: {
            deletedCount: chatResult.deleted || 0,
            // deleteMessagesRange 省略 endIndex 时物理截断到 anchor 后一位；无需在已完成
            // 两层修改后再做一次可能失败的读盘，从而把真成功误报成未知 500。
            newLength: anchor.index + 1,
            committed: chatCommitted,
            status: chatResult.status || (chatNoOp ? "not_modified" : null),
            revision: chatResult.revision || null,
            derived: chatResult.derived || null,
          },
        };
      }, { expectedUsername: username });
    } finally {
      quiesceLease.release();
    }
  }));
}

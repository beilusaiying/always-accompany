/**
 * 多组并行 v4 · P3-1 —— 主进程网关：chatid → groupId → 常驻 Deno Worker。
 *
 * 一组(group) = 一条并行线 = 一个 worker isolate（configData/ideClient/workspaceRoot 随 isolate 隔离，
 * iso_test 6/0 证）。重只读资源（向量等）走共享底座（阶段0 另建），不在本层各载——本层只管
 * 「按组拿/起 worker + 把一轮回复路由进去 + 流式回传 + 生命周期」。
 *
 * 与 executeGeneration 的关系（v4 §3.5）：executeGeneration 外壳留主进程（存盘/广播/auto-continue），
 * 只把「跑 GetReply」这一段派给组 worker。worker 内真正干活的是 runner 模块（runnerUrl，调用方提供）——
 * runner 在 worker isolate 内 import 整条插件链并重建 char 跑 GetReply，故单例天然隔离。
 *
 * 复用：groupRegistry.mjs（chatid→groupId 单一权威源）。
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

import { getGroupIdByChatId, updateGroup, getGroup } from "./groupRegistry.mjs";
import { data_path } from "../../../../../../server/server.mjs";
import { wbT, wbD } from "../../../../../../server/wbStub.mjs";
// 跨 isolate 收口（isolateBridge）：本网关是主↔worker 唯一咽喉——上行桥事件在 onStream 层
// 拦截分发（审批入队/广播回放），下行主进程权威态随 payload.bridgeState 快照注入。桥零依赖无环。
import {
  bridgeErrorToPayload,
  dispatchBridgeChunk,
  dispatchBridgeRequest,
} from "../../../../../../yonban/core/transport/isolateBridge.mjs";

// lib → ... → 仓库 src（6 级）→ workers/*
const _WORKER_URL = pathToFileURL(
  path.join(import.meta.dirname, "../../../../../../workers/groupWorker.mjs"),
).href;
// 默认 runner = worker 内跑 GetReply 的模块（在 worker isolate 内 Base-only 引导 beilu + getChatRequest + GetReply）
const _RUNNER_URL = pathToFileURL(
  path.join(import.meta.dirname, "../../../../../../workers/groupReplyRunner.mjs"),
).href;

/** @type {Map<string, GroupWorkerHandle>} groupId|chatid（线键）→ handle */
const _workers = new Map();
/**
 * chatid → Set<{ key:string, handle:GroupWorkerHandle, promise:Promise<any>, settled:boolean }>
 *
 * 公开 request Promise 会在 abort/timeout 时提前失败；这里只登记 Worker finally 的真实终态。
 * 历史改写必须等待这个注册表清空，不能把“调用方已收到失败”误当成“副作用生产者已停止”。
 */
const _chatWorkerSettlements = new Map();

// 跨线并发硬上限（借 OpenClaw 4/8、Hermes 3）：防多线 worker 同时占内存 / 打爆 API / $47k 递归。
const MAX_CONCURRENT_WORKERS = 5;        // 同时存活的线 worker 上限（满则先回收最久空闲者）
const WORKER_IDLE_TTL_MS = 10 * 60_000;  // 空闲超时回收（常驻 isolate 防内存单调涨）
const WORKER_EVENT_DEDUP_LIMIT = 4096;
const WORKER_BRIDGE_DEDUP_LIMIT = 4096;
const WORKER_BRIDGE_HANDLER_TIMEOUT_MS = 30_000;

function _newBridgeCapability() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `bridge-cap:${uuid}`;
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return `bridge-cap:${[...bytes].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  const error = new Error("secure bridge capability generator is unavailable");
  error.code = "E_BRIDGE_CAPABILITY_UNAVAILABLE";
  error.phase = "parent_preflight";
  error.executionStarted = false;
  error.sideEffectsPossible = false;
  error.indeterminate = false;
  throw error;
}

function _withExecutionState(error, fallback = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const normalized = error instanceof Error ? error : new Error(error?.message || String(error || fallback.message || "worker request failed"));
  normalized.code = (typeof error?.code === "string" && error.code) || fallback.code || "E_WORKER_REQUEST_FAILED";
  normalized.phase = (typeof error?.phase === "string" && error.phase)
    || (typeof details.phase === "string" && details.phase)
    || fallback.phase
    || "worker_transport";
  for (const field of ["executionStarted", "sideEffectsPossible", "indeterminate"]) {
    const value = error?.[field] ?? details[field] ?? fallback[field];
    if (typeof value === "boolean") normalized[field] = value;
  }
  return normalized;
}

function _errorFromWorkerPayload(payload, fallback = {}) {
  const data = payload && typeof payload === "object"
    ? payload
    : { message: typeof payload === "string" ? payload : "worker request failed" };
  return _withExecutionState(Object.assign(new Error(data.message || "worker request failed"), data), fallback);
}

function _cloneExecutionError(error) {
  const clone = new Error(error?.message || "worker request failed");
  if (typeof error?.code === "string") clone.code = error.code;
  if (error?.details && typeof error.details === "object") clone.details = error.details;
  for (const field of ["phase", "executionStarted", "sideEffectsPossible", "indeterminate"]) {
    if (error?.[field] !== undefined) clone[field] = error[field];
  }
  return clone;
}

function _abortReasonPayload(reason) {
  if (typeof reason === "string" && reason) {
    return { name: "AbortError", code: "E_BRIDGE_PARENT_ABORTED", message: reason };
  }
  if (reason && typeof reason === "object") {
    return {
      name: (typeof reason.name === "string" && reason.name) || "AbortError",
      code: (typeof reason.code === "string" && reason.code) || "E_BRIDGE_PARENT_ABORTED",
      message: (typeof reason.message === "string" && reason.message) || "parent worker request was aborted",
    };
  }
  return {
    name: "AbortError",
    code: "E_BRIDGE_PARENT_ABORTED",
    message: "parent worker request was aborted",
  };
}

function _parentAbortError(reason, lifecycle) {
  const payload = _abortReasonPayload(reason);
  const error = new Error(payload.message);
  error.name = payload.name;
  error.code = payload.code;
  return _withExecutionState(error, {
    code: payload.code,
    phase: lifecycle?.sent ? "parent_execution" : "parent_preflight",
    executionStarted: lifecycle?.sent === true,
    sideEffectsPossible: lifecycle?.sent === true,
    indeterminate: lifecycle?.sent === true,
  });
}

function _registerChatWorkerSettlement(chatid, key, handle, workerSettled) {
  if (!workerSettled || typeof workerSettled.then !== "function") {
    const error = _withExecutionState(new Error("worker request is missing its settlement lifecycle"), {
      code: "E_GROUP_WORKER_SETTLEMENT_MISSING",
      phase: "parent_lifecycle_registration",
      executionStarted: true,
      sideEffectsPossible: true,
      indeterminate: true,
    });
    try { handle.terminate(); } catch { /* terminate() 内部仍会结算已登记的 worker lifecycle */ }
    throw error;
  }
  const bucket = _chatWorkerSettlements.get(chatid) || new Set();
  _chatWorkerSettlements.set(chatid, bucket);
  const record = { key, handle, promise: null, settled: false };
  record.promise = Promise.resolve(workerSettled).finally(() => {
    record.settled = true;
    bucket.delete(record);
    if (bucket.size === 0 && _chatWorkerSettlements.get(chatid) === bucket) {
      _chatWorkerSettlements.delete(chatid);
    }
  });
  // lifecycle 理论上只 resolve；这里仍挂拒绝观察者，避免异常实现产生 unhandled rejection。
  record.promise.catch(() => {});
  bucket.add(record);
  return record;
}

function _positiveDeadlineMs(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(`${field} must be a positive finite number`);
    error.code = "E_HISTORY_REWRITE_DEADLINE_INVALID";
    throw error;
  }
  return Math.floor(number);
}

async function _waitForSettlementRecords(records, deadlineMs) {
  const pendingRecords = records.filter((record) => !record.settled);
  if (pendingRecords.length === 0) return true;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  try {
    return await Promise.race([
      Promise.allSettled(pendingRecords.map((record) => record.promise)).then(() => true),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 历史改写专用 Worker 静默点。先等待真实 request_settled；超时后终止承载这些请求的 Worker，
 * 并再次等待本地 lifecycle 的 termination 终态。仍无法确认时抛错，调用方不得截断历史。
 */
export async function quiesceChatWorkerRequests(
  chatid,
  { deadlineMs, terminationConfirmationDeadlineMs = deadlineMs } = {},
) {
  if (typeof chatid !== "string" || !chatid) {
    const error = new Error("chatid must be a non-empty string");
    error.code = "E_INVALID_CHAT_ID";
    throw error;
  }
  const waitMs = _positiveDeadlineMs(deadlineMs, "deadlineMs");
  const confirmMs = _positiveDeadlineMs(terminationConfirmationDeadlineMs, "terminationConfirmationDeadlineMs");
  const initial = [...(_chatWorkerSettlements.get(chatid) || [])].filter((record) => !record.settled);
  if (initial.length === 0) {
    return { settled: true, pendingCount: 0, forcedWorkerCount: 0 };
  }
  if (await _waitForSettlementRecords(initial, waitMs)) {
    return { settled: true, pendingCount: initial.length, forcedWorkerCount: 0 };
  }

  const remaining = initial.filter((record) => !record.settled);
  const handles = new Set(remaining.map((record) => record.handle));
  wbD(chatid, "group", "historyRewrite:workerSettlementTimeout", false,
    "Worker 未在历史改写截止时间内结算，正在终止对应 Worker", {
      pendingCount: remaining.length,
      workerKeys: [...new Set(remaining.map((record) => record.key))],
      deadlineMs: waitMs,
    });
  for (const handle of handles) handle.terminate();

  const terminationConfirmed = await _waitForSettlementRecords(remaining, confirmMs);
  const stillPending = remaining.filter((record) => !record.settled);
  if (!terminationConfirmed || stillPending.length > 0) {
    const error = _withExecutionState(new Error("worker termination could not be confirmed before history rewrite"), {
      code: "E_HISTORY_REWRITE_WORKER_NOT_SETTLED",
      phase: "history_rewrite_quiesce",
      executionStarted: true,
      sideEffectsPossible: true,
      indeterminate: true,
    });
    error.pendingCount = stillPending.length;
    throw error;
  }
  return { settled: true, pendingCount: initial.length, forcedWorkerCount: handles.size };
}
// 空闲 worker 回收 sweeper：每 2min 终止 inFlight===0 且超 TTL 的线 worker。
const _idleSweeper = setInterval(() => {
  const now = Date.now();
  for (const h of _workers.values()) {
    if (h.inFlight === 0 && now - h.lastUsedAt > WORKER_IDLE_TTL_MS) {
      wbT(null, "group", "sweeper:idleEvict", { groupId: h.groupId, idleMs: now - h.lastUsedAt });
      try { h.terminate(); } catch { /* already gone */ }
    }
  }
}, 120_000);
if (typeof _idleSweeper?.unref === "function") _idleSweeper.unref();

/**
 * @typedef {object} GroupWorkerHandle
 * @property {string} groupId
 * @property {Worker} worker
 * @property {Promise<any>} ready
 * @property {(payload:object, onStream?:((chunk:any)=>void), signal?:AbortSignal, dispatchContext?:object)=>Promise<any>} request
 * @property {(requestSeq:number)=>void} abort
 * @property {()=>void} terminate
 */

function _spawn(groupId, runnerUrl) {
  wbT(null, "group", "spawn:worker", { groupId, workerCount: _workers.size });
  const worker = new Worker(_WORKER_URL, { type: "module" });
  const pending = new Map(); // seq → main 创建的 parent request 状态（含认证身份与 bridge children）
  // request id → worker finally 终态。公开 Promise 可因 abort/300s 先失败，但 worker 资源占用
  // 不能随之提前释放；只有可信 request_settled 或 worker 实例终止才能关闭这里的生命周期。
  const requestLifecycles = new Map();
  // eventId → { status:"pending"|"accepted", at:number }。main 拒绝/异常必须释放，
  // 否则合法 workerId 的畸形事件能抢占 eventId，令修正后的合法重试被永久去重。
  const seenEventIds = new Map();
  const seenBridgeRequestIds = new Map();
  const lifecycleStats = { eventReceived: 0, eventAccepted: 0, eventRejected: 0, eventDeduped: 0 };
  let lifecycleTail = Promise.resolve();
  let announcedWorkerId = null;
  let seq = 0;

  const decorateRequestPromise = (publicPromise, workerSettled) => {
    Object.defineProperty(publicPromise, "workerSettled", {
      value: workerSettled,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return publicPromise;
  };

  const resolvedNotDispatched = (reason) => Promise.resolve(Object.freeze({
    requestId: null,
    outcome: "not_dispatched",
    reason,
  }));

  const createRequestLifecycle = (requestId) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const lifecycle = { requestId, promise, resolve, sent: false, settled: false };
    requestLifecycles.set(requestId, lifecycle);
    return lifecycle;
  };

  const settleRequestLifecycle = (requestId, state = {}) => {
    const lifecycle = requestLifecycles.get(requestId);
    if (!lifecycle || lifecycle.settled) return false;
    lifecycle.settled = true;
    requestLifecycles.delete(requestId);
    lifecycle.resolve(Object.freeze({ requestId, ...state }));
    return true;
  };

  const settleAllRequestLifecycles = (state = {}) => {
    for (const requestId of [...requestLifecycles.keys()]) {
      settleRequestLifecycle(requestId, state);
    }
  };

  const postBridgeMessage = (message) => {
    try {
      worker.postMessage(message);
      return true;
    } catch (postError) {
      wbD(null, "group", "bridge:responsePostFail", false, postError?.message || String(postError), {
        groupId, bridgeRequestId: message?.bridgeRequestId || null,
      });
      return false;
    }
  };

  const postBridgeResponse = (bridgeRequestId, success, value) => {
    if (typeof bridgeRequestId !== "string" || !bridgeRequestId) return false;
    let message = success === true
      ? { kind: "bridge_response", bridgeRequestId, success: true, result: value }
      : { kind: "bridge_response", bridgeRequestId, success: false, error: bridgeErrorToPayload(value) };
    try {
      worker.postMessage(message);
      return message;
    } catch (postError) {
      if (success === true) {
        message = {
          kind: "bridge_response",
          bridgeRequestId,
          success: false,
          error: {
            code: "E_BRIDGE_RESPONSE_SERIALIZATION",
            message: "bridge handler result is not structured-cloneable",
            phase: "response_serialization",
            executionStarted: true,
            sideEffectsPossible: true,
            indeterminate: true,
          },
        };
        try {
          worker.postMessage(message);
          return message;
        } catch { /* worker transport itself is unavailable; log original serialization error below */ }
      }
      wbD(null, "group", "bridge:responsePostFail", false, postError?.message || String(postError), {
        groupId, bridgeRequestId,
      });
      return message;
    }
  };

  const trimBridgeReplayCache = () => {
    if (seenBridgeRequestIds.size <= WORKER_BRIDGE_DEDUP_LIMIT) return;
    for (const [requestId, seen] of seenBridgeRequestIds) {
      if (seenBridgeRequestIds.size <= WORKER_BRIDGE_DEDUP_LIMIT) break;
      if (seen?.status === "completed") seenBridgeRequestIds.delete(requestId);
    }
  };

  const rememberBridgeResponse = (bridgeRequestId, response) => {
    const seen = seenBridgeRequestIds.get(bridgeRequestId);
    if (!seen) return;
    seen.status = "completed";
    seen.response = response;
    seen.completedAt = Date.now();
    trimBridgeReplayCache();
  };

  const completeBridgeChild = (bridgeRequestId, child, success, value) => {
    if (child?.responseSent) return child.response;
    const response = postBridgeResponse(bridgeRequestId, success, value);
    if (child) {
      child.responseSent = true;
      child.response = response;
    }
    rememberBridgeResponse(bridgeRequestId, response);
    return response;
  };

  const closeParentBridgeRequests = (parent, code, message) => {
    if (!parent?.bridgeRequests?.size) return;
    for (const [bridgeRequestId, child] of parent.bridgeRequests) {
      if (child.executionSettled) continue;
      child.cancelled = true;
      const executionStarted = child.dispatched === true;
      const closeError = _withExecutionState(Object.assign(new Error(message), { code }), {
        phase: executionStarted ? "handler_execution" : "handler_queue",
        executionStarted,
        sideEffectsPossible: executionStarted,
        indeterminate: executionStarted,
      });
      child.controller.abort(closeError);
      completeBridgeChild(bridgeRequestId, child, false, closeError);
    }
  };

  const settlePending = (id, parent, success, value, bridgeEnd = {}) => {
    if (pending.get(id) !== parent) return false;
    pending.delete(id);
    closeParentBridgeRequests(
      parent,
      bridgeEnd.code || "E_BRIDGE_PARENT_ENDED",
      bridgeEnd.message || "parent worker request ended before bridge response",
    );
    if (success) parent.resolve(value);
    else parent.reject(value instanceof Error ? value : _errorFromWorkerPayload(value));
    return true;
  };

  const rejectBridgeRequest = (bridgeRequestId, code, message) => {
    postBridgeResponse(bridgeRequestId, false, _withExecutionState(Object.assign(new Error(message), { code }), {
      phase: "bridge_preflight",
      executionStarted: false,
      sideEffectsPossible: false,
      indeterminate: false,
    }));
  };

  const sameBridgeFingerprint = (left, right) => !!left && !!right
    && left.parentRequestId === right.parentRequestId
    && left.type === right.type
    && left.chatId === right.chatId
    && left.capability === right.capability;

  const handleBridgeRequest = (message) => {
    const bridgeRequestId = typeof message?.bridgeRequestId === "string" ? message.bridgeRequestId : "";
    const parentRequestId = message?.parentRequestId;
    const type = typeof message?.type === "string" ? message.type : "";
    const chatId = typeof message?.chatId === "string" ? message.chatId : "";
    const capability = typeof message?.capability === "string" ? message.capability : "";

    if (!bridgeRequestId) {
      wbD(chatId || null, "group", "bridge:missingRequestId", false,
        "bridge_request 缺少 bridgeRequestId，无法关联响应", { groupId, parentRequestId: parentRequestId ?? null });
      return;
    }
    if (!announcedWorkerId) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_WORKER_NOT_READY", "worker identity handshake is incomplete");
      return;
    }
    const fingerprint = { parentRequestId, type, chatId, capability };
    const seen = seenBridgeRequestIds.get(bridgeRequestId);
    if (seen) {
      if (!sameBridgeFingerprint(seen.fingerprint, fingerprint)) {
        wbD(chatId || null, "group", "bridge:requestIdReuseMismatch", false,
          "bridgeRequestId 被不同 parent/type/chat/capability 复用，已隔离且不触碰原请求", {
            groupId,
            bridgeRequestId,
            parentRequestId: parentRequestId ?? null,
          });
        return;
      }
      if (seen.status === "pending") {
        wbT(chatId || null, "group", "bridge:duplicateInFlightIgnored", {
          groupId, bridgeRequestId, parentRequestId,
        });
        return;
      }
      if (seen.status === "completed" && seen.response) {
        postBridgeMessage(seen.response);
      }
      return;
    }
    const parent = pending.get(parentRequestId);
    if (!parent || parent.kind !== "request" || !parent.context) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_PARENT_ENDED", "parent worker request is no longer active");
      return;
    }
    // 身份只取 main dispatch 时保存的 pending context；worker payload 中即便夹带 user 也不读取。
    if (parent.context.workerId !== announcedWorkerId || parent.context.groupId !== groupId) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_WORKER_IDENTITY_MISMATCH", "bridge request does not belong to this worker");
      return;
    }
    if (chatId !== parent.context.chatid) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_CHAT_ID_MISMATCH", "bridge request chatId does not match parent dispatch");
      return;
    }
    if (!type) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_TYPE_REQUIRED", "bridge request type is required");
      return;
    }
    if (!capability || capability !== parent.context.capability) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_CAPABILITY_MISMATCH", "bridge capability does not match parent dispatch");
      return;
    }
    if (!parent.context.allowedBridgeTypes.has(type)) {
      rejectBridgeRequest(bridgeRequestId, "E_BRIDGE_TYPE_NOT_ALLOWED", `bridge request type is not allowed for this parent: ${type}`);
      return;
    }

    seenBridgeRequestIds.set(bridgeRequestId, {
      status: "pending",
      fingerprint,
      response: null,
      receivedAt: Date.now(),
    });
    const child = {
      controller: new AbortController(),
      dispatched: false,
      executionSettled: false,
      responseSent: false,
      response: null,
      cancelled: false,
    };
    parent.bridgeRequests.set(bridgeRequestId, child);
    const trustedContext = Object.freeze({
      username: parent.context.username,
      chatid: parent.context.chatid,
      generationId: parent.context.generationId,
      requestId: parent.context.requestId,
      groupId: parent.context.groupId,
      workerId: parent.context.workerId,
    });
    const executeBridgeChild = async () => {
      if (child.cancelled || pending.get(parentRequestId) !== parent) {
        child.executionSettled = true;
        parent.bridgeRequests.delete(bridgeRequestId);
        return;
      }
      child.dispatched = true;
      let resolveHandlerSettled;
      const handlerSettled = new Promise((resolve) => { resolveHandlerSettled = resolve; });
      try {
        const result = await dispatchBridgeRequest(type, message.payload, trustedContext, {
          timeoutMs: WORKER_BRIDGE_HANDLER_TIMEOUT_MS,
          signal: child.controller.signal,
          onHandlerSettled: resolveHandlerSettled,
        });
        completeBridgeChild(bridgeRequestId, child, true, result);
      } catch (dispatchError) {
        // handler 已开始后抛错时，除非存在更强的业务提交证明，运输层不能断言副作用
        // 一定未发生；统一以 indeterminate 送回 worker，阻止错误地重试同一操作。
        const handlerError = dispatchError?.executionStarted === false
          ? dispatchError
          : _withExecutionState(_cloneExecutionError(dispatchError), {
            code: "E_BRIDGE_HANDLER_FAILED",
            phase: "handler_execution",
            executionStarted: true,
            sideEffectsPossible: true,
            indeterminate: true,
          });
        completeBridgeChild(bridgeRequestId, child, false, handlerError);
        if (dispatchError?.executionStarted === false) resolveHandlerSettled();
      }
      // deadline response 不代表业务 handler 已停止；保持 parent FIFO 到真实 handler settle。
      await handlerSettled;
      child.executionSettled = true;
      parent.bridgeRequests.delete(bridgeRequestId);
    };
    parent.bridgeTail = parent.bridgeTail.then(executeBridgeChild, executeBridgeChild);
  };

  worker.onmessage = (e) => {
    const { kind, id, result, error, chunk, event, requestId, workerId, state } = e.data || {};
    if (kind === "bridge_request") {
      handleBridgeRequest(e.data || {});
      return;
    }
    if (kind === "request_settled") {
      if (!announcedWorkerId || workerId !== announcedWorkerId) {
        wbD(null, "group", "request:settledWorkerMismatch", false,
          "request_settled workerId 与 init 身份不一致，已拒绝", {
            groupId, requestId: requestId ?? null, announcedWorkerId, actualWorkerId: workerId || null,
          });
        return;
      }
      if (!settleRequestLifecycle(requestId, {
        outcome: state?.outcome || "unknown",
        phase: state?.phase || "request_finally",
        executionStarted: state?.executionStarted === true,
        sideEffectsPossible: state?.sideEffectsPossible === true,
        indeterminate: state?.indeterminate === true,
        workerId,
      })) {
        wbD(null, "group", "request:settledUnknown", false,
          "request_settled 没有匹配的主进程生命周期", { groupId, requestId: requestId ?? null });
      }
      return;
    }
    // 常驻 worker lifecycle 必须在 request pending 查找之前消费：reply 后 pending 已删，
    // 迟到事件仍须进入主进程权威 ideClient，不能退化成无匹配 request 后静默 return。
    if (kind === "event") {
      lifecycleStats.eventReceived++;
      const eventId = typeof event?.eventId === "string" ? event.eventId : "";
      // 身份门必须先于 eventId 去重：未完成 init 身份握手或伪造 workerId 的事件不能
      // 污染去重窗口，进而把随后来自真实 worker 的同 eventId 合法事件静默挡掉。
      if (!announcedWorkerId || event?.workerId !== announcedWorkerId) {
        lifecycleStats.eventRejected++;
        wbD(event?.chatid || null, "group", "worker:eventWorkerMismatch", false,
          "lifecycle workerId 缺失或与 init 身份不一致，已拒绝", {
            groupId, announcedWorkerId, actualWorkerId: event?.workerId || null, eventId,
          });
        return;
      }
      if (eventId && seenEventIds.has(eventId)) {
        lifecycleStats.eventDeduped++;
        wbT(event?.chatid || null, "group", "worker:eventDeduped", {
          groupId,
          eventId,
          phase: event?.phase,
          workerId: event?.workerId,
          status: seenEventIds.get(eventId)?.status || null,
        });
        return;
      }
      if (eventId) {
        // 入队到 main 验证前只占 pending；仅 main accepted 后才成为永久去重项。
        seenEventIds.set(eventId, { status: "pending", at: Date.now() });
      }
      wbT(event?.chatid || null, "group", "worker:eventReceived", {
        groupId, eventId: eventId || null, phase: event?.phase, workerId: event?.workerId || null,
      });
      // 串行交付同一 worker 的 phase，避免 started/wait_timeout/late_result 因动态 import/异步
      // chat 校验发生重排。此队列独立于 request promise，request reply 后仍继续存活。
      lifecycleTail = lifecycleTail
        .then(async () => {
          const { ideClient } = await import("../../../../../../yonban/core/transport/ideClient.mjs");
          const accepted = await ideClient.acceptWorkerToolLifecycle?.(event);
          if (accepted?.accepted) {
            lifecycleStats.eventAccepted++;
            if (eventId) {
              seenEventIds.set(eventId, { status: "accepted", at: Date.now() });
              let acceptedCount = 0;
              for (const seen of seenEventIds.values()) {
                if (seen?.status === "accepted") acceptedCount++;
              }
              if (acceptedCount > WORKER_EVENT_DEDUP_LIMIT) {
                for (const [seenId, seen] of seenEventIds) {
                  if (acceptedCount <= WORKER_EVENT_DEDUP_LIMIT) break;
                  if (seen?.status === "accepted") {
                    seenEventIds.delete(seenId);
                    acceptedCount--;
                  }
                }
              }
            }
          } else {
            lifecycleStats.eventRejected++;
            if (eventId) seenEventIds.delete(eventId);
          }
        })
        .catch((err) => {
          lifecycleStats.eventRejected++;
          if (eventId) seenEventIds.delete(eventId);
          wbD(event?.chatid || null, "group", "worker:eventDispatchFail", false,
            err?.message || String(err), { groupId, eventId: eventId || null, phase: event?.phase });
        });
      return;
    }
    if (kind === "fatal") {
      wbD(null, "group", "worker:fatal", false, error?.message || String(error), { groupId, pendingCount: pending.size });
      for (const [pendingId, p] of [...pending]) {
        const started = p.kind === "request";
        const fatalError = _errorFromWorkerPayload(error, {
          code: "E_BRIDGE_WORKER_FATAL",
          phase: "worker_fatal",
          executionStarted: started,
          sideEffectsPossible: started,
          indeterminate: started,
        });
        settlePending(pendingId, p, false, fatalError, {
          code: "E_BRIDGE_WORKER_FATAL",
          message: "worker terminated after a fatal error",
        });
      }
      settleAllRequestLifecycles({ outcome: "worker_fatal", indeterminate: true });
      try { worker.terminate(); } catch { /* worker 已终止 */ }
      if (_workers.get(groupId)?.worker === worker) _workers.delete(groupId);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    if (kind === "stream") {
      if (dispatchBridgeChunk(chunk, p.context)) return;
      try { p.onStream?.(chunk); } catch { /* 流回调不阻塞 */ }
      return;
    }
    if (kind === "reply") settlePending(id, p, true, result);
    else if (kind === "error") {
      const requestError = _errorFromWorkerPayload(error, {
        code: "E_BRIDGE_PARENT_FAILED",
        phase: "worker_request",
        executionStarted: true,
        sideEffectsPossible: true,
        indeterminate: false,
      });
      wbD(null, "group", "worker:reqError", false, requestError.message, {
        groupId, reqId: id, code: requestError.code, phase: requestError.phase,
      });
      settlePending(id, p, false, requestError, {
        code: "E_BRIDGE_PARENT_FAILED",
        message: "parent worker request failed",
      });
    }
  };
  worker.onerror = (e) => {
    const err = e?.error || new Error(e?.message || "worker error");
    wbD(null, "group", "worker:onerror", false, err?.message || "worker error", { groupId, pendingCount: pending.size });
    for (const [pendingId, p] of [...pending]) {
      const started = p.kind === "request";
      // 每个 parent 使用独立 Error；不能让第一个 init/request 的 fallback 字段污染后续 parent。
      const transportError = _withExecutionState(_cloneExecutionError(err), {
        code: "E_BRIDGE_WORKER_ERROR",
        phase: "worker_transport",
        executionStarted: started,
        sideEffectsPossible: started,
        indeterminate: started,
      });
      settlePending(pendingId, p, false, transportError, {
        code: "E_BRIDGE_WORKER_ERROR",
        message: "worker transport failed",
      });
    }
    settleAllRequestLifecycles({ outcome: "worker_error", indeterminate: true });
    try { worker.terminate(); } catch { /* worker 已终止 */ }
    if (_workers.get(groupId)?.worker === worker) _workers.delete(groupId);
  };

  const send = (kind, payload, onStream) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const parent = { id, kind, resolve, reject, onStream, context: null, bridgeRequests: new Map() };
      pending.set(id, parent);
      try {
        worker.postMessage({ kind, id, payload });
      } catch (postError) {
        settlePending(id, parent, false, _withExecutionState(postError, {
          code: "E_BRIDGE_PARENT_SEND_FAILED",
          phase: "parent_delivery",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        }));
      }
    });

  const ready = send("init", { groupId, runnerUrl })
    .then((result) => {
      if (result?.ready !== true || typeof result?.workerId !== "string" || !result.workerId) {
        throw new Error("worker identity handshake failed");
      }
      announcedWorkerId = result.workerId;
      return result;
    })
    .catch((initError) => {
      try { worker.terminate(); } catch { /* worker 已终止 */ }
      if (_workers.get(groupId)?.worker === worker) _workers.delete(groupId);
      throw _withExecutionState(initError, {
        code: "E_BRIDGE_WORKER_INIT_FAILED",
        phase: "worker_init",
        executionStarted: false,
        sideEffectsPossible: false,
        indeterminate: false,
      });
    });

  return {
    groupId,
    worker,
    ready,
    lastUsedAt: Date.now(),
    inFlight: 0,
    lifecycleStats,
    waitForLifecycle: () => lifecycleTail,
    request: (payload, onStream, signal, dispatchContext) => {
      const id = ++seq;
      if (!announcedWorkerId) {
        const error = _withExecutionState(new Error("worker identity handshake is incomplete"), {
          code: "E_BRIDGE_WORKER_NOT_READY",
          phase: "parent_preflight",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        });
        return decorateRequestPromise(Promise.reject(error), resolvedNotDispatched("worker_not_ready"));
      }
      if (
        !dispatchContext
        || typeof dispatchContext.chatid !== "string"
        || !dispatchContext.chatid
        || typeof dispatchContext.username !== "string"
        || !dispatchContext.username
        || dispatchContext.chatid !== payload?.chatid
        || dispatchContext.username !== payload?.username
      ) {
        const error = _withExecutionState(new Error("worker dispatch identity context mismatch"), {
          code: "E_BRIDGE_DISPATCH_IDENTITY_MISMATCH",
          phase: "parent_preflight",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        });
        return decorateRequestPromise(Promise.reject(error), resolvedNotDispatched("identity_mismatch"));
      }
      let capability;
      try { capability = _newBridgeCapability(); }
      catch (capabilityError) {
        return decorateRequestPromise(Promise.reject(capabilityError), resolvedNotDispatched("capability_unavailable"));
      }
      const allowedBridgeTypes = Array.isArray(dispatchContext.allowedBridgeTypes)
        ? [...new Set(dispatchContext.allowedBridgeTypes)]
        : [];
      if (allowedBridgeTypes.some((type) => typeof type !== "string" || !type)) {
        const error = _withExecutionState(new Error("allowedBridgeTypes must contain non-empty strings"), {
          code: "E_BRIDGE_ALLOWLIST_INVALID",
          phase: "parent_preflight",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        });
        return decorateRequestPromise(Promise.reject(error), resolvedNotDispatched("allowlist_invalid"));
      }
      if (signal?.aborted) {
        wbD(null, "group", "request:preAborted", false, "请求前已中止", { groupId });
        const error = _parentAbortError(signal.reason, { sent: false });
        return decorateRequestPromise(Promise.reject(error), resolvedNotDispatched("pre_aborted"));
      }

      const lifecycle = createRequestLifecycle(id);
      let abortForwarder = null;
      const publicPromise = new Promise((resolve, reject) => {
        const TIMEOUT = 300000;
        let timer = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (signal && abortForwarder) signal.removeEventListener?.("abort", abortForwarder);
        };
        const context = Object.freeze({
          username: dispatchContext.username,
          chatid: dispatchContext.chatid,
          generationId: dispatchContext.generationId ?? null,
          requestId: id,
          groupId,
          workerId: announcedWorkerId,
          capability,
          allowedBridgeTypes: new Set(allowedBridgeTypes),
        });
        const parent = {
          id,
          kind: "request",
          resolve: (value) => { cleanup(); resolve(value); },
          reject: (requestError) => { cleanup(); reject(requestError); },
          onStream,
          context,
          bridgeRequests: new Map(),
          bridgeTail: Promise.resolve(),
        };
        pending.set(id, parent);

        // ★ 用户中止转发：公开请求先失败；worker 生命周期继续保留到 request_settled。
        abortForwarder = () => {
          wbD(null, "group", "request:userAbort", false, "用户中止 → 转发 abort 给 worker", { groupId, reqId: id });
          const abortReason = _abortReasonPayload(signal?.reason);
          if (lifecycle.sent) {
            try { worker.postMessage({ kind: "abort", id: ++seq, payload: { requestId: id, reason: abortReason } }); }
            catch (abortPostError) {
              wbD(null, "group", "request:abortPostFail", false, abortPostError?.message || String(abortPostError), { groupId, reqId: id });
            }
          } else {
            settleRequestLifecycle(id, { outcome: "not_dispatched", reason: "aborted_before_send" });
          }
          const p = pending.get(id);
          if (p) settlePending(id, p, false, _parentAbortError(signal?.reason, lifecycle), {
            code: abortReason.code,
            message: abortReason.message,
          });
        };
        if (signal) signal.addEventListener?.("abort", abortForwarder, { once: true });
        if (signal?.aborted) {
          abortForwarder();
          return;
        }

        timer = setTimeout(() => {
          const p = pending.get(id);
          if (p) {
            wbD(null, "group", "request:timeout", false, `worker 请求超时 (${TIMEOUT / 1000}s)`, { groupId, reqId: id });
            try { worker.postMessage({ kind: "abort", id: ++seq, payload: { requestId: id } }); }
            catch (timeoutAbortError) {
              wbD(null, "group", "request:timeoutAbortPostFail", false,
                timeoutAbortError?.message || String(timeoutAbortError), { groupId, reqId: id });
            }
            settlePending(id, p, false, _withExecutionState(new Error(`worker 请求超时 (${TIMEOUT / 1000}s)`), {
              code: "E_BRIDGE_PARENT_TIMEOUT",
              phase: "parent_execution",
              executionStarted: true,
              sideEffectsPossible: true,
              indeterminate: true,
            }), {
              code: "E_BRIDGE_PARENT_TIMEOUT",
              message: "parent worker request timed out",
            });
          }
        }, TIMEOUT);
        timer.unref?.();
        try {
          worker.postMessage({
            kind: "request",
            id,
            payload,
            bridge: { capability, allowedBridgeTypes },
          });
          lifecycle.sent = true;
        } catch (postError) {
          settleRequestLifecycle(id, { outcome: "not_dispatched", reason: "post_failed" });
          settlePending(id, parent, false, _withExecutionState(postError, {
            code: "E_BRIDGE_PARENT_SEND_FAILED",
            phase: "parent_delivery",
            executionStarted: false,
            sideEffectsPossible: false,
            indeterminate: false,
          }), {
            code: "E_BRIDGE_PARENT_SEND_FAILED",
            message: "failed to send parent worker request",
          });
        }
      });
      return decorateRequestPromise(publicPromise, lifecycle.promise);
    },
    abort: (requestSeq) => worker.postMessage({ kind: "abort", id: ++seq, payload: { requestId: requestSeq } }),
    terminate() {
      for (const [pendingId, p] of [...pending]) {
        const started = p.kind === "request";
        const terminationError = _withExecutionState(new Error("worker terminated"), {
          code: "E_BRIDGE_WORKER_TERMINATED",
          phase: "worker_terminated",
          executionStarted: started,
          sideEffectsPossible: started,
          indeterminate: started,
        });
        settlePending(pendingId, p, false, terminationError, {
          code: "E_BRIDGE_WORKER_TERMINATED",
          message: "worker was terminated",
        });
      }
      try { worker.terminate(); } catch { /* already gone */ }
      settleAllRequestLifecycles({ outcome: "worker_terminated", indeterminate: true });
      _workers.delete(groupId);
    },
  };
}

/** 取该组的常驻 worker，无则按需 spawn（runnerUrl 默认 = groupReplyRunner）。 */
export function getOrSpawnGroupWorker(groupId, runnerUrl = _RUNNER_URL) {
  let h = _workers.get(groupId);
  if (!h) {
    // 并发硬上限：满了先回收最久空闲(inFlight===0)的线 worker 腾位；全忙则仍 spawn 不阻塞当前线，交 sweeper 后收。
    if (_workers.size >= MAX_CONCURRENT_WORKERS) {
      wbD(null, "group", "concurrency:limitHit", false, `并发上限 ${MAX_CONCURRENT_WORKERS} 已满`, { workerCount: _workers.size, wantGroupId: groupId });
      let oldest = null;
      for (const hh of _workers.values()) {
        if (hh.inFlight > 0) continue;
        if (!oldest || hh.lastUsedAt < oldest.lastUsedAt) oldest = hh;
      }
      if (oldest) { wbT(null, "group", "concurrency:evictOldest", { evictGroupId: oldest.groupId }); try { oldest.terminate(); } catch { /* already gone */ } }
      else {
        wbD(null, "group", "concurrency:allBusy", false, `全部 worker 在飞(${_workers.size}/${MAX_CONCURRENT_WORKERS}), 超限 spawn`, { workerCount: _workers.size, wantGroupId: groupId });
      }
    }
    h = _spawn(groupId, runnerUrl);
    _workers.set(groupId, h);
  }
  h.lastUsedAt = Date.now();
  return h;
}

/**
 * 把一轮回复路由进「线」的 worker（一窗一线）。
 * 线键 key = 绑组则 groupId（同组共享一 worker isolate）；未绑组则 chatid（per-线独立 isolate）。
 * 任一 key 恒真 → 恒路由 worker；调用方只可对明确的投递前安全错误退回本地 GetReply。
 */
// 缺-2 运行态显示：线起跑/结束时把当前活跃线键广播给前端（cardsPanel 标"在跑"）。
//   懒 import 防循环依赖；广播失败不影响生成。payload.activeLines = activeGroupWorkerIds()（一窗一线时键=chatid）。
function _broadcastRuntime(username) {
  import("./broadcast.mjs")
    .then((m) => m.broadcastAllChatUi?.({ type: "group_runtime_update", payload: { username, activeLines: activeGroupWorkerIds() } }, username))
    .catch(() => {});
}

export async function dispatchReplyToGroup(
  username,
  chatid,
  payload = {},
  runnerUrl = _RUNNER_URL,
  onStream,
  signal,
  dispatchOptions = {},
) {
  let groupId;
  let key;
  let h;
  try {
    // owner 只接受主进程已加载的 chat metadata；先核验调用参数，再登记到主 ideClient。
    // worker payload 的 username 只是这个权威身份的副本，不能反向成为 owner 证明。
    const { chatMetadatas } = await import("./chatStorage.mjs");
    const chatData = chatMetadatas.get(chatid);
    const indexedOwner = typeof chatData?.username === "string" ? chatData.username : "";
    const loadedOwner = typeof chatData?.chatMetadata?.username === "string"
      ? chatData.chatMetadata.username
      : indexedOwner;
    if (!indexedOwner || indexedOwner !== username || loadedOwner !== username) {
      const ownerError = _withExecutionState(new Error("chat owner does not match authenticated dispatch user"), {
        code: "E_GROUP_CHAT_OWNER_MISMATCH",
        phase: "parent_owner_preflight",
        executionStarted: false,
        sideEffectsPossible: false,
        indeterminate: false,
      });
      ownerError.localRetryAllowed = false;
      throw ownerError;
    }
    const { ideClient } = await import("../../../../../../yonban/core/transport/ideClient.mjs");
    if (!ideClient.registerChatOwner(chatid, username)) {
      const ownerError = _withExecutionState(new Error("main process rejected chat owner registration"), {
        code: "E_GROUP_CHAT_OWNER_REGISTRATION",
        phase: "parent_owner_preflight",
        executionStarted: false,
        sideEffectsPossible: false,
        indeterminate: false,
      });
      ownerError.localRetryAllowed = false;
      throw ownerError;
    }
    groupId = getGroupIdByChatId(username, chatid);
    key = groupId || chatid; // 一窗一线：未绑组按 chatid 当线键
    h = getOrSpawnGroupWorker(key, runnerUrl);
    await h.ready;
  } catch (setupError) {
    throw _withExecutionState(setupError, {
      code: "E_BRIDGE_PARENT_SETUP_FAILED",
      phase: "parent_preflight",
      executionStarted: false,
      sideEffectsPossible: false,
      indeterminate: false,
    });
  }
  wbT(chatid, "group", "dispatch:enter", { username, chatid, groupId, key, bound: !!groupId, charname: payload.charname });
  h.inFlight++; // 并发计数：上限回收/sweeper 只动 inFlight===0 的空闲 worker，不误杀在飞线
  if (groupId) updateGroup(username, groupId, { status: "running" }); // 组态只对绑组的更新
  _broadcastRuntime(username); // 缺-2：线起跑 → 推运行态
  let releaseAttached = false;
  let released = false;
  const releaseWorkerResource = () => {
    if (released) return;
    released = true;
    h.inFlight = Math.max(0, h.inFlight - 1);
    h.lastUsedAt = Date.now();
    if (groupId && h.inFlight === 0) updateGroup(username, groupId, { status: "idle" });
    _broadcastRuntime(username);
  };
  try {
    // data_path：worker isolate 内 Base-only 引导 beilu 所需（getChatRequest→auth→server.mjs）
    // signal：转发用户中止给 worker（点停止 → worker 内 GetReply 真停）
    // workspaceRoot 解析：绑组→组根；未绑组(per-线)→ 该卡 memory/_config.json 的 per-卡项目根(workspace_root)，
    //   取不到→""=默认根（runner 内 setWorkspaceRootOverride 消费，仅改 isolate 内存不写共享磁盘）。
    let _wsRoot = "";
    if (groupId) {
      _wsRoot = getGroup(username, groupId)?.workspaceRoot || "";
    } else if (payload.charname) {
      try {
        const { getCardWorkspaceRoot } = await import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
        _wsRoot = getCardWorkspaceRoot(username, payload.charname) || "";
      } catch (_wsErr) { wbD(chatid, "group", "dispatch:wsRootResolveFail", false, _wsErr?.message || String(_wsErr), { charname: payload.charname }); /* 取不到卡根→默认根 */ }
    }
    // 跨 isolate 模式同步（债-C 完整化）：worker isolate 的 activeModes 默认 "chat"（per-isolate 运行时态、
    //   从不经 UI setMode），导致 worker 内 file/work/code 模式全失效。把主进程本会话模式带进 payload，
    //   worker 在 GetReply 前设回本 isolate。
    let _activeMode;
    try {
      const _fm = await import("../../../../plugins/beilu-files/main.mjs");
      // Y2 确诊修三点之三：主进程模式源读 username 桶（UI setMode 经 REST run(username) 写 username 桶
      // [main.mjs:2350/2935]，原无 ALS 读 _default 桶=读不到用户真实模式）。
      _activeMode = _fm._filesAls.run({ username }, () => _fm.getActiveModeForSession(chatid));
    } catch (_amErr) { wbD(chatid, "group", "dispatch:activeModeResolveFail", false, _amErr?.message || String(_amErr), { chatid }); /* 取不到模式→worker 用默认 */ }
    // 跨 isolate 桥下行：主进程权威态快照（写审批开关 per-user 内存 Map / 主工作区根）——
    // worker 在 GetReply 前经 ideClient.applyBridgeState 灌入本 isolate，消除「主写 worker 读不到」
    // 致 L4 全放行仍恒入队/区外误判（收口设计见 isolateBridge.mjs 头注释）。
    let _bridgeState = null;
    let _idePort = null; // 多开：本会话所绑 YonBan 实例端口（主进程绑定表权威），worker isolate 据此定向连接
    try {
      const { ideClient } = await import("../../../../../../yonban/core/transport/ideClient.mjs");
      _bridgeState = {
        requireWriteApproval: ideClient.getRequireWriteApproval(username),
        mainWorkspaceRoot: ideClient.workspaceRootFor(chatid) || null, // 多开：桥下行根也按本会话所绑窗口取
      };
      _idePort = ideClient.getChatBindingPort(chatid);
    } catch (_bsErr) { wbD(chatid, "group", "dispatch:bridgeStateFail", false, _bsErr?.message || String(_bsErr), {}); }
    wbT(chatid, "group", "dispatch:request", { key, workspaceRoot: _wsRoot || "(默认根)", activeMode: _activeMode || "(默认)", hasBridgeState: !!_bridgeState, inFlight: h.inFlight });
    // worker payload 先展开业务字段，再由 main 参数覆盖身份字段；pending context 另存一份认证身份，
    // bridge_request 后续无论在 payload 里夹带什么 username/chatid 都不会成为 handler context。
    const _workerPayload = {
      ...payload,
      username,
      chatid,
      data_path,
      workspaceRoot: _wsRoot,
      activeMode: _activeMode,
      bridgeState: _bridgeState,
      idePort: _idePort,
    };
    const requestPromise = h.request(
      _workerPayload,
      onStream,
      signal,
      {
        username,
        chatid,
        generationId: dispatchOptions.generationId ?? null,
        allowedBridgeTypes: Array.isArray(dispatchOptions.allowedBridgeTypes)
          ? dispatchOptions.allowedBridgeTypes
          : [],
      },
    );
    _registerChatWorkerSettlement(chatid, key, h, requestPromise.workerSettled);
    // 公开 Promise 可因超时/用户中止先 reject；worker 仍可能在执行。资源状态只挂在
    // Worker finally 发出的 request_settled（或 worker 确认终止）上，避免被 sweeper 复用/回收。
    releaseAttached = true;
    Promise.resolve(requestPromise.workerSettled).then(releaseWorkerResource, releaseWorkerResource);
    const result = await requestPromise;
    wbT(chatid, "group", "dispatch:done", { key, hasContent: !!result?.content, contentLen: result?.content?.length || 0, pendingFileOps: !!result?.pendingFileOps });
    return { routed: true, groupId: key, result };
  } catch (_dispErr) {
    wbD(chatid, "group", "dispatch:error", false, _dispErr?.message || String(_dispErr), { key, groupId });
    throw _dispErr;
  } finally {
    // h.request 同步抛错（正常实现不会）或请求尚未创建时，没有 worker 生命周期可等。
    if (!releaseAttached) releaseWorkerResource();
  }
}

/** 终止某组 worker（删组/故障隔离用）。终止后从 _workers 摘键，防 groupId 单调泄漏。 */
export function terminateGroupWorker(groupId) {
  const h = _workers.get(groupId);
  if (!h) return false;
  h.terminate();
  _workers.delete(groupId);
  return true;
}

/** 当前活跃组 worker 的 groupId 列表（右栏运行态/调试用）。 */
export function activeGroupWorkerIds() {
  return [..._workers.keys()];
}

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * isolateBridge — 主进程 ↔ 组 worker isolate 的跨界收口（系统级单源）。
 *
 * why：多组并行 v4 下 AI 回合跑在组 worker isolate（groupWorker.mjs），模块级内存单例
 *   （审批队列/广播 socket 注册表/写审批开关/IDE 连接态）随 isolate 物理隔离——worker 写的态
 *   主进程读不到、主进程写的态 worker 读不到。此前只有 pendingResults（groupReplyRunner 回传）
 *   与 pendingFileOps（债-C 上报门）两条散点专线；本模块把「跨界」收成一个系统：
 *   任何需要跨 isolate 的状态/事件，统一走本桥，不再各拉专线。
 *
 * 通道：
 *   上行（worker→主，实时）：publishFromWorker() → ctx.emit({__isolateBridge:...}) → {kind:"stream"}
 *     → groupWorkerManager.dispatchReplyToGroup 的 onStream 包装层 dispatchBridgeChunk() → 域处理器。
 *   生命周期上行（worker→主，常驻）：publishWorkerLifecycle() → ctx.emitEvent(event)
 *     → {kind:"event"}。该 emitter 绑定 worker 实例，不随单次 request reply/stream 结束。
 *   可等待上行（worker→主）：requestFromWorker() → {kind:"bridge_request"}
 *     → 主进程 async handler → {kind:"bridge_response"}。请求身份由 groupWorkerManager
 *     保存的 parent request 上下文提供，不接受 worker payload 自报 owner。
 *   下行（主→worker，随派发）：dispatchReplyToGroup 组装 payload.bridgeState 快照
 *     → groupReplyRunner 在 GetReply 前交各域 own 模块消费（ideClient.applyBridgeState）。
 *
 * 域归属（本桥只做传输与分发，不懂业务）：
 *   - 域处理器由各域 own 模块自注册（broadcast.mjs 注册 "broadcast"、ideClient.mjs 注册 "approval_add"），
 *     调用方零改动——isolate 判定内化在各系统内部，不在调用点加 if。
 *   - 本模块零业务依赖（仅使用运行时 AsyncLocalStorage），主/worker 两 isolate 均可安全 import，无业务环。
 *
 * 功能链：replyHandler(worker) 审批入队/广播 → 本桥上行 → 主进程权威队列/真实 WS 客户端；
 *         权限面板改写审批开关(主) → bridgeState 下行 → worker 审批门读到最新值。
 */

// groupWorker.mjs:19 在任何 runner import 前设此标——import 时求值即可靠。
export const isWorkerIsolate = !!globalThis.__BEILU_WORKER_ISOLATE;

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_REQUEST_TIMEOUT_MS = 5 * 60_000;

export class BridgeRequestError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code || "bridge request failed");
    this.name = "BridgeRequestError";
    this.code = code || "E_BRIDGE_REQUEST_FAILED";
    if (details !== undefined) this.details = details;
  }
}

const _EXECUTION_FIELDS = ["phase", "executionStarted", "sideEffectsPossible", "indeterminate"];

/** 为跨 isolate 错误补齐可判定的执行阶段；显式字段优先于 fallback。 */
export function withBridgeExecutionState(error, fallback = {}) {
  const normalized = _asBridgeError(error, fallback.code || "E_BRIDGE_REQUEST_FAILED", fallback.message || "bridge request failed");
  const details = error?.details && typeof error.details === "object"
    ? error.details
    : (normalized.details && typeof normalized.details === "object" ? normalized.details : {});
  for (const field of _EXECUTION_FIELDS) {
    const value = error?.[field] ?? normalized[field] ?? details[field] ?? fallback[field];
    if (field === "phase") {
      if (typeof value === "string" && value) normalized.phase = value;
    } else if (typeof value === "boolean") {
      normalized[field] = value;
    }
  }
  return normalized;
}

function _newBridgeId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}:${uuid}` : `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function _normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BridgeRequestError("E_BRIDGE_TIMEOUT_INVALID", "bridge request timeout must be a positive finite number");
  }
  return Math.min(Math.max(1, Math.trunc(n)), MAX_BRIDGE_REQUEST_TIMEOUT_MS);
}

function _asBridgeError(reason, fallbackCode, fallbackMessage) {
  if (reason instanceof BridgeRequestError) return reason;
  if (reason instanceof Error) {
    const error = new BridgeRequestError(reason.code || fallbackCode, reason.message || fallbackMessage, reason.details);
    if (reason.stack) error.stack = reason.stack;
    return error;
  }
  return new BridgeRequestError(fallbackCode, typeof reason === "string" && reason ? reason : fallbackMessage);
}

/** 将异常压成可 structured-clone 的协议错误，不透传 Error 实例。 */
export function bridgeErrorToPayload(error, fallbackCode = "E_BRIDGE_HANDLER_FAILED") {
  const normalized = withBridgeExecutionState(error, { code: fallbackCode, message: "bridge request failed" });
  const payload = { code: normalized.code, message: normalized.message };
  for (const field of _EXECUTION_FIELDS) {
    if (normalized[field] !== undefined) payload[field] = normalized[field];
  }
  return payload;
}

// ---- worker 侧：上行事件出口 ----
let _workerLifecycleEmitter = null;

// 可等待 request bridge 与旧 stream bridge 正交。AsyncLocalStorage 把 emitter 绑定到
// 当前 runner 的 parent request；即使同一 chat 并发两轮，也不会靠“最后一次 set”选路。
const _workerRequestContext = new AsyncLocalStorage();
const _workerRequestBindings = new Map(); // chatId → Map<bindingToken, binding>
const _workerBridgePending = new Map(); // bridgeRequestId → pending

function _removeWorkerBridgePending(pending) {
  _workerBridgePending.delete(pending.bridgeRequestId);
  pending.binding.pendingIds.delete(pending.bridgeRequestId);
}

function _closeWorkerRequestBinding(binding, reason) {
  if (!binding?.active) return false;
  binding.active = false;
  const byChat = _workerRequestBindings.get(binding.chatId);
  if (byChat?.get(binding.bindingToken) === binding) {
    byChat.delete(binding.bindingToken);
    if (byChat.size === 0) _workerRequestBindings.delete(binding.chatId);
  }
  const error = _asBridgeError(reason, "E_BRIDGE_PARENT_ENDED", "parent worker request ended");
  for (const bridgeRequestId of [...binding.pendingIds]) {
    const pending = _workerBridgePending.get(bridgeRequestId);
    if (!pending || pending.binding !== binding) continue;
    _removeWorkerBridgePending(pending);
    pending.reject(error);
  }
  binding.pendingIds.clear();
  if (binding.streamBinding?.active) {
    binding.streamBinding.active = false;
    binding.streamBinding = null;
  }
  return true;
}

/**
 * 为一条 worker parent request 建立可等待桥上下文。返回的 token/解绑函数只作用于
 * 自己的绑定；调用方必须用 run() 包住 runner，并在 abort/error/finally close()。
 */
export function bindWorkerRequestEmitter(chatId, emitRequest, {
  parentRequestId,
  capability,
  allowedBridgeTypes = [],
} = {}) {
  if (!isWorkerIsolate) throw new BridgeRequestError("E_BRIDGE_NOT_WORKER", "worker request emitter can only bind in a worker isolate");
  if (typeof chatId !== "string" || !chatId) throw new BridgeRequestError("E_BRIDGE_CHAT_ID_REQUIRED", "chatId is required");
  if (typeof emitRequest !== "function") throw new BridgeRequestError("E_BRIDGE_EMITTER_REQUIRED", "request emitter is required");
  if ((typeof parentRequestId !== "string" && typeof parentRequestId !== "number") || parentRequestId === "") {
    throw new BridgeRequestError("E_BRIDGE_PARENT_ID_REQUIRED", "parentRequestId is required");
  }
  if (typeof capability !== "string" || !capability) {
    throw new BridgeRequestError("E_BRIDGE_CAPABILITY_REQUIRED", "bridge capability is required");
  }
  if (!Array.isArray(allowedBridgeTypes) || allowedBridgeTypes.some((type) => typeof type !== "string" || !type)) {
    throw new BridgeRequestError("E_BRIDGE_ALLOWLIST_INVALID", "allowedBridgeTypes must be an array of non-empty strings");
  }

  const bindingToken = _newBridgeId("binding");
  const binding = {
    active: true,
    bindingToken,
    chatId,
    parentRequestId,
    capability,
    allowedBridgeTypes: new Set(allowedBridgeTypes),
    emitRequest,
    pendingIds: new Set(),
    streamBinding: null,
  };
  let byChat = _workerRequestBindings.get(chatId);
  if (!byChat) {
    byChat = new Map();
    _workerRequestBindings.set(chatId, byChat);
  }
  byChat.set(bindingToken, binding);

  const close = (reason) => _closeWorkerRequestBinding(binding, reason);
  return Object.freeze({
    token: bindingToken,
    run(fn) {
      if (!binding.active) throw new BridgeRequestError("E_BRIDGE_BINDING_CLOSED", "worker request binding is closed");
      if (typeof fn !== "function") throw new BridgeRequestError("E_BRIDGE_RUNNER_REQUIRED", "binding.run requires a function");
      return _workerRequestContext.run({ chatId, bindingToken }, fn);
    },
    close,
    unbind: close,
  });
}

/** 仅解绑 token 精确命中的 emitter，禁止按 chatId 误删并发请求的绑定。 */
export function unbindWorkerRequestEmitter(chatId, bindingToken, reason) {
  const binding = _workerRequestBindings.get(chatId)?.get(bindingToken);
  return _closeWorkerRequestBinding(binding, reason);
}

/** 返回当前 active parent request 的权威 chatId；上下文缺失或已关闭时不返回陈旧身份。 */
export function getWorkerBridgeChatId() {
  const scope = _workerRequestContext.getStore();
  if (!scope?.chatId) return null;
  const binding = _workerRequestBindings.get(scope.chatId)?.get(scope.bindingToken);
  return binding?.active && binding.chatId === scope.chatId ? binding.chatId : null;
}

/**
 * worker 内发起一条可等待的主进程请求。业务 payload 不承载身份；主进程只使用 parent
 * request pending 中保存的认证上下文。
 */
export function requestFromWorker(type, chatId, payload) {
  if (!isWorkerIsolate) return Promise.reject(new BridgeRequestError("E_BRIDGE_NOT_WORKER", "requestFromWorker is only available in a worker isolate"));
  if (typeof type !== "string" || !type) return Promise.reject(new BridgeRequestError("E_BRIDGE_TYPE_REQUIRED", "bridge request type is required"));
  if (typeof chatId !== "string" || !chatId) return Promise.reject(new BridgeRequestError("E_BRIDGE_CHAT_ID_REQUIRED", "chatId is required"));

  const scope = _workerRequestContext.getStore();
  if (!scope || scope.chatId !== chatId) {
    return Promise.reject(new BridgeRequestError("E_BRIDGE_CONTEXT_MISMATCH", "no matching parent request context for chatId"));
  }
  const binding = _workerRequestBindings.get(chatId)?.get(scope.bindingToken);
  if (!binding?.active) return Promise.reject(new BridgeRequestError("E_BRIDGE_BINDING_CLOSED", "worker request binding is closed"));
  if (!binding.allowedBridgeTypes.has(type)) {
    return Promise.reject(new BridgeRequestError("E_BRIDGE_TYPE_NOT_ALLOWED", `bridge request type is not allowed for this parent: ${type}`));
  }

  const bridgeRequestId = _newBridgeId("request");
  return new Promise((resolve, reject) => {
    // deadline 只有 main handler owner 可以裁决。worker 侧只等待 main response 或 parent close，
    // 避免两个独立时钟把同一业务执行判成两个互相矛盾的结果。
    const pending = { bridgeRequestId, binding, resolve, reject };
    _workerBridgePending.set(bridgeRequestId, pending);
    binding.pendingIds.add(bridgeRequestId);
    try {
      const accepted = binding.emitRequest({
        kind: "bridge_request",
        bridgeRequestId,
        parentRequestId: binding.parentRequestId,
        capability: binding.capability,
        type,
        chatId,
        payload,
      });
      if (accepted === false) throw new BridgeRequestError("E_BRIDGE_SEND_REJECTED", "worker bridge request emitter rejected the message");
    } catch (error) {
      _removeWorkerBridgePending(pending);
      reject(_asBridgeError(error, "E_BRIDGE_SEND_FAILED", "failed to send worker bridge request"));
    }
  });
}

/** groupWorker 收到 bridge_response 后调用；未知/迟到 id 返回 false，不触碰其他 pending。 */
export function acceptWorkerBridgeResponse(message) {
  const bridgeRequestId = typeof message?.bridgeRequestId === "string" ? message.bridgeRequestId : "";
  if (!bridgeRequestId) return false;
  const pending = _workerBridgePending.get(bridgeRequestId);
  if (!pending) return false;
  _removeWorkerBridgePending(pending);
  if (message.success === true) {
    pending.resolve(message.result);
  } else if (message.success === false) {
    const protocolError = message.error && typeof message.error === "object" ? message.error : {};
    const remoteError = new BridgeRequestError(
      typeof protocolError.code === "string" && protocolError.code ? protocolError.code : "E_BRIDGE_REMOTE_FAILED",
      typeof protocolError.message === "string" && protocolError.message ? protocolError.message : "main bridge handler failed",
      protocolError,
    );
    for (const field of _EXECUTION_FIELDS) {
      if (protocolError[field] !== undefined) remoteError[field] = protocolError[field];
    }
    pending.reject(remoteError);
  } else {
    pending.reject(new BridgeRequestError("E_BRIDGE_PROTOCOL", "bridge response success must be boolean"));
  }
  return true;
}

/** worker fatal/terminate 前拒绝所有未完成 bridge Promise，避免悬挂。 */
export function rejectAllWorkerBridgeRequests(reason) {
  let closed = 0;
  for (const byChat of [..._workerRequestBindings.values()]) {
    for (const binding of [...byChat.values()]) {
      if (_closeWorkerRequestBinding(binding, reason)) closed++;
    }
  }
  return closed;
}

export function bindWorkerEmitter(chatid, emit) {
  if (!isWorkerIsolate) throw new BridgeRequestError("E_BRIDGE_NOT_WORKER", "worker stream emitter can only bind in a worker isolate");
  const scope = _workerRequestContext.getStore();
  const binding = scope && _workerRequestBindings.get(chatid)?.get(scope.bindingToken);
  if (!binding?.active || binding.chatId !== chatid) {
    throw new BridgeRequestError("E_BRIDGE_CONTEXT_MISMATCH", "no matching parent request context for stream emitter");
  }
  if (typeof emit !== "function") throw new BridgeRequestError("E_BRIDGE_EMITTER_REQUIRED", "stream emitter is required");
  if (binding.streamBinding?.active) throw new BridgeRequestError("E_BRIDGE_STREAM_ALREADY_BOUND", "stream emitter is already bound for this parent");
  const token = _newBridgeId("stream");
  binding.streamBinding = { active: true, token, emit };
  return token;
}

export function unbindWorkerEmitter(chatid, token) {
  const scope = _workerRequestContext.getStore();
  const binding = scope && _workerRequestBindings.get(chatid)?.get(scope.bindingToken);
  if (!binding?.active || !binding.streamBinding?.active || binding.streamBinding.token !== token) return false;
  binding.streamBinding.active = false;
  binding.streamBinding = null;
  return true;
}

/**
 * 绑定 worker 常驻 lifecycle emitter。groupReplyRunner 可在每轮幂等重绑，但不得在
 * GetReply finally 中解绑；真正生命周期由 groupWorker isolate/terminate 决定。
 */
export function bindWorkerLifecycleEmitter(emitEvent) {
  if (typeof emitEvent === "function") _workerLifecycleEmitter = emitEvent;
}

/**
 * worker 工具运输层向主进程发布版本化 lifecycle。此通道不承载 broadcast/approval 等
 * request-bound 业务事件，避免把原 stream 语义放大成永久广播。
 */
export function publishWorkerLifecycle(event) {
  if (!isWorkerIsolate || typeof _workerLifecycleEmitter !== "function") return false;
  try {
    return _workerLifecycleEmitter(event) !== false;
  } catch {
    return false;
  }
}

/**
 * worker 内向主进程发布一条桥事件（骑 stream 通道，仅请求在飞期间可达——审批入队/广播
 * 都发生在 GetReply 执行中，生命周期天然匹配）。
 * @param {string} type - 域处理器键（如 "broadcast" / "approval_add"）
 * @param {string|null} chatid - 事件归属会话；null 表示使用当前 ALS parent 的权威 chatId。
 * @param {object} payload - 必须可 structured-clone
 * @returns {boolean} 是否送出（false=无在飞 emitter，调用方自行诚实降级并留痕）
 */
export function publishFromWorker(type, chatid, payload) {
  const scope = _workerRequestContext.getStore();
  if (!scope) return false;
  const binding = _workerRequestBindings.get(scope.chatId)?.get(scope.bindingToken);
  const streamBinding = binding?.streamBinding;
  if (!binding?.active || !streamBinding?.active) return false;
  if (chatid != null && chatid !== binding.chatId) return false;
  try {
    streamBinding.emit({ __isolateBridge: { type, chatid: binding.chatId, payload } });
    return true;
  } catch {
    return false;
  }
}

// ---- 主侧：域处理器注册表 + stream 分发 ----
const _handlers = new Map();
const _requestHandlers = new Map();

/** 各域 own 模块在主 isolate 模块加载时自注册（幂等：同 type 后注册覆盖）。 */
export function registerBridgeHandler(type, fn) {
  if (type && typeof fn === "function") _handlers.set(type, fn);
}

/** 注册主进程 async request handler；返回只撤销本次注册的函数。 */
export function registerBridgeRequestHandler(type, fn, options = {}) {
  if (typeof type !== "string" || !type) throw new BridgeRequestError("E_BRIDGE_TYPE_REQUIRED", "bridge request type is required");
  if (typeof fn !== "function") throw new BridgeRequestError("E_BRIDGE_HANDLER_REQUIRED", "bridge request handler is required");
  if (_requestHandlers.has(type)) throw new BridgeRequestError("E_BRIDGE_HANDLER_ALREADY_REGISTERED", `bridge request handler already registered for type: ${type}`);
  const timeoutMs = options?.timeoutMs === undefined ? null : _normalizeTimeout(options.timeoutMs);
  const registrationToken = _newBridgeId("handler");
  const registration = { registrationToken, fn, timeoutMs };
  _requestHandlers.set(type, registration);
  return () => {
    if (_requestHandlers.get(type) !== registration) return false;
    _requestHandlers.delete(type);
    return true;
  };
}

/** 主进程分发一条已由 groupWorkerManager 认证的 request；未知类型和超时均显式拒绝。 */
export async function dispatchBridgeRequest(type, payload, context, {
  timeoutMs,
  signal,
  onHandlerSettled,
} = {}) {
  const registration = _requestHandlers.get(type);
  if (!registration) {
    onHandlerSettled?.();
    throw withBridgeExecutionState(
      new BridgeRequestError("E_BRIDGE_HANDLER_NOT_FOUND", `no bridge request handler registered for type: ${type}`),
      { phase: "handler_lookup", executionStarted: false, sideEffectsPossible: false, indeterminate: false },
    );
  }
  if (signal?.aborted) {
    onHandlerSettled?.();
    throw withBridgeExecutionState(signal.reason, {
      code: "E_BRIDGE_HANDLER_ABORTED",
      message: "bridge request handler was aborted before execution",
      phase: "handler_preflight",
      executionStarted: false,
      sideEffectsPossible: false,
      indeterminate: false,
    });
  }
  const effectiveTimeoutMs = _normalizeTimeout(registration.timeoutMs ?? timeoutMs);
  const handlerController = new AbortController();
  let executionStarted = false;
  let publicSettled = false;
  let settleHandlerNotified = false;
  const notifyHandlerSettled = () => {
    if (settleHandlerNotified) return;
    settleHandlerNotified = true;
    try { onHandlerSettled?.(); } catch { /* 观察回调不能改变 handler 结果 */ }
  };
  const handlerPromise = Promise.resolve().then(() => {
    if (handlerController.signal.aborted) {
      throw withBridgeExecutionState(handlerController.signal.reason, {
        code: "E_BRIDGE_HANDLER_ABORTED",
        message: "bridge request handler was aborted before execution",
        phase: "handler_preflight",
        executionStarted: false,
        sideEffectsPossible: false,
        indeterminate: false,
      });
    }
    executionStarted = true;
    return registration.fn(
      payload,
      Object.freeze({ ...(context || {}) }),
      Object.freeze({ signal: handlerController.signal }),
    );
  });
  handlerPromise.then(notifyHandlerSettled, notifyHandlerSettled);

  let timer = null;
  let abortFromParent = null;
  try {
    return await new Promise((resolve, reject) => {
      const settlePublic = (fn, value) => {
        if (publicSettled) return;
        publicSettled = true;
        fn(value);
      };
      handlerPromise.then(
        (value) => settlePublic(resolve, value),
        (handlerError) => settlePublic(reject, withBridgeExecutionState(handlerError, {
          code: "E_BRIDGE_HANDLER_FAILED",
          message: "bridge request handler failed",
          phase: "handler_execution",
          executionStarted,
          sideEffectsPossible: executionStarted,
          indeterminate: executionStarted,
        })),
      );
      abortFromParent = () => {
        const abortError = withBridgeExecutionState(signal?.reason, {
          code: "E_BRIDGE_HANDLER_ABORTED",
          message: "bridge request handler was aborted",
          phase: "handler_execution",
          executionStarted,
          sideEffectsPossible: executionStarted,
          indeterminate: executionStarted,
        });
        handlerController.abort(abortError);
        settlePublic(reject, abortError);
      };
      signal?.addEventListener?.("abort", abortFromParent, { once: true });
      timer = setTimeout(() => {
        const timeoutError = withBridgeExecutionState(
          new BridgeRequestError("E_BRIDGE_HANDLER_TIMEOUT", `bridge request handler timed out after ${effectiveTimeoutMs}ms`),
          {
            phase: "handler_execution",
            executionStarted,
            sideEffectsPossible: executionStarted,
            indeterminate: executionStarted,
          },
        );
        handlerController.abort(timeoutError);
        settlePublic(reject, timeoutError);
      }, effectiveTimeoutMs);
      timer.unref?.();
    });
  } finally {
    clearTimeout(timer);
    if (abortFromParent) signal?.removeEventListener?.("abort", abortFromParent);
  }
}

/**
 * groupWorkerManager 的 onStream 包装层调用：是桥事件则消费（不外漏给业务 onStream），
 * 否则放行。未注册的桥 type 也拦截（留 console 痕，不静默丢进业务层）。
 * @returns {boolean} true=已消费
 */
export function dispatchBridgeChunk(chunk, trustedContext) {
  const m = chunk && chunk.__isolateBridge;
  if (!m || typeof m !== "object") return false;
  const context = trustedContext && typeof trustedContext === "object"
    ? Object.freeze({ ...trustedContext })
    : null;
  if (!context?.chatid || m.chatid !== context.chatid) {
    console.warn(`[isolateBridge] 桥事件缺少可信 parent context 或 chatid 不匹配 type=${m.type}`);
    return true;
  }
  const h = _handlers.get(m.type);
  if (h) {
    try { h(m.payload, context.chatid, context); }
    catch (e) { console.warn(`[isolateBridge] 域处理器异常 type=${m.type}:`, e?.message || e); }
  } else {
    console.warn(`[isolateBridge] 未注册的桥事件 type=${m.type}（已拦截）`);
  }
  return true;
}

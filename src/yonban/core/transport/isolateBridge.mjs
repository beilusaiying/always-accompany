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
 *   下行（主→worker，随派发）：dispatchReplyToGroup 组装 payload.bridgeState 快照
 *     → groupReplyRunner 在 GetReply 前交各域 own 模块消费（ideClient.applyBridgeState）。
 *
 * 域归属（本桥只做传输与分发，不懂业务）：
 *   - 域处理器由各域 own 模块自注册（broadcast.mjs 注册 "broadcast"、ideClient.mjs 注册 "approval_add"），
 *     调用方零改动——isolate 判定内化在各系统内部，不在调用点加 if。
 *   - 本模块零依赖（不 import 任何业务模块），主/worker 两 isolate 均可安全静态 import，无环。
 *
 * 功能链：replyHandler(worker) 审批入队/广播 → 本桥上行 → 主进程权威队列/真实 WS 客户端；
 *         权限面板改写审批开关(主) → bridgeState 下行 → worker 审批门读到最新值。
 */

// groupWorker.mjs:19 在任何 runner import 前设此标——import 时求值即可靠。
export const isWorkerIsolate = !!globalThis.__BEILU_WORKER_ISOLATE;

// ---- worker 侧：上行事件出口 ----
// chatid → 本次在飞请求的 emit（groupReplyRunner 在 GetReply 前 bind、finally unbind）。
const _workerEmitters = new Map();
let _workerLifecycleEmitter = null;

export function bindWorkerEmitter(chatid, emit) {
  if (chatid && typeof emit === "function") _workerEmitters.set(chatid, emit);
}

export function unbindWorkerEmitter(chatid) {
  if (chatid) _workerEmitters.delete(chatid);
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
 * @param {string|null} chatid - 事件归属会话（找不到对应 emitter 时退而用任一在飞 emitter，
 *   事件体自带 chatid，主侧按内容路由，不依赖走哪条 stream）
 * @param {object} payload - 必须可 structured-clone
 * @returns {boolean} 是否送出（false=无在飞 emitter，调用方自行诚实降级并留痕）
 */
export function publishFromWorker(type, chatid, payload) {
  const emit = _workerEmitters.get(chatid) || _workerEmitters.values().next().value;
  if (typeof emit !== "function") return false;
  try {
    emit({ __isolateBridge: { type, chatid: chatid || null, payload } });
    return true;
  } catch {
    return false;
  }
}

// ---- 主侧：域处理器注册表 + stream 分发 ----
const _handlers = new Map();

/** 各域 own 模块在主 isolate 模块加载时自注册（幂等：同 type 后注册覆盖）。 */
export function registerBridgeHandler(type, fn) {
  if (type && typeof fn === "function") _handlers.set(type, fn);
}

/**
 * groupWorkerManager 的 onStream 包装层调用：是桥事件则消费（不外漏给业务 onStream），
 * 否则放行。未注册的桥 type 也拦截（留 console 痕，不静默丢进业务层）。
 * @returns {boolean} true=已消费
 */
export function dispatchBridgeChunk(chunk) {
  const m = chunk && chunk.__isolateBridge;
  if (!m || typeof m !== "object") return false;
  const h = _handlers.get(m.type);
  if (h) {
    try { h(m.payload, m.chatid); }
    catch (e) { console.warn(`[isolateBridge] 域处理器异常 type=${m.type}:`, e?.message || e); }
  } else {
    console.warn(`[isolateBridge] 未注册的桥事件 type=${m.type}（已拦截）`);
  }
  return true;
}

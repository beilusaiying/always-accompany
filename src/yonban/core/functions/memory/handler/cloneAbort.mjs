/**
 * cloneAbort.mjs — 分身任务停止通道（[0724 分身可停·002] "我需要可以关闭分身,无论是本体还有yonban"）
 *
 * 功能链：
 *   replyHandler <分身N> 任务启动 → registerCloneAbort 领 AbortController
 *   → 前端停止（本体 backendMonitor 分身区 ⏹ / YonBan 分身进度面板 ⏹）
 *   → SetData "stopCloneTask"（setDataActions）→ abortClones 触发 signal
 *   → 分身轮循环界/在飞 API 调用（runMemoryPresetAI options.signal 已有消费）即断
 *   → 任务 finally unregisterCloneAbort 注销
 *
 * why 独立小模块：replyHandler（生产者）与 setDataActions（停止指令入口）互不 import，
 *   注册表放任一侧都会制造循环依赖；本模块零依赖，双方安全静态引。
 *
 * 约束：注册表在主进程内存——group worker 路由（group_worker_enabled=true）下分身跑在
 *   worker isolate，主进程停不到（与 pendingResults 池同款隔离限制，默认关闭不受影响）。
 *
 * key = username / chatid / taskId 三元（taskId 是 <分身N> 的 N，跨会话可重复，必须带 chatid 维度；
 * 分隔符用 NUL 转义，防 username/chatid 含空格撞键）。
 */

const _controllers = new Map(); // key → { controller, username, chatid, taskId, startedAt }

const _SEP = "\u0000";
const _key = (username, chatid, taskId) => [String(username), String(chatid ?? ""), String(taskId)].join(_SEP);

/** 分身任务启动时注册，返回该任务专属 AbortController。
 *  [0726 五修#5] 同 key 已有在飞任务（异步模式跨批次派同编号 <分身N>）→ 不再 abort 旧任务（原"先中止
 *  旧的防泄漏"在异步下=误杀在飞旧批次；泄漏防线已由任务 finally 必注销承担），新注册用唯一化内部 key
 *  并存。abortClones/listActiveClones 按 v.taskId 值匹配不受 key 后缀影响（停 #N=新旧批一起停，符合用户意图）。 */
export function registerCloneAbort(username, chatid, taskId) {
  let k = _key(username, chatid, taskId);
  if (_controllers.has(k)) {
    let i = 2;
    while (_controllers.has(k + _SEP + "b" + i)) i++;
    k = k + _SEP + "b" + i;
  }
  const controller = new AbortController();
  controller._cloneKey = k;
  _controllers.set(k, { controller, username, chatid: String(chatid ?? ""), taskId: String(taskId), startedAt: Date.now() });
  return controller;
}

/** 任务结束（完成/异常/中止）注销。
 *  [0726 五修#5] 优先按注册时返回的 controller 身份删（key 可能已唯一化后缀）；无 controller 按三元 key 兜底。 */
export function unregisterCloneAbort(username, chatid, taskId, controller) {
  if (controller?._cloneKey) { _controllers.delete(controller._cloneKey); return; }
  _controllers.delete(_key(username, chatid, taskId));
}

/**
 * 停止分身。taskId 缺省 = 停该会话（chatid 也缺省则该用户）全部在跑分身。
 * @returns {number} 实际触发中止的任务数
 */
export function abortClones(username, { chatid, taskId } = {}) {
  let n = 0;
  for (const [k, v] of _controllers) {
    if (v.username !== username) continue;
    if (chatid !== undefined && v.chatid !== String(chatid)) continue;
    if (taskId !== undefined && v.taskId !== String(taskId)) continue;
    try { v.controller.abort(); n++; } catch { /* 已中止 */ }
    _controllers.delete(k);
  }
  return n;
}

/** 在跑分身清单（诊断/前端可选消费）。 */
export function listActiveClones(username, chatid) {
  const out = [];
  for (const v of _controllers.values()) {
    if (v.username !== username) continue;
    if (chatid !== undefined && v.chatid !== String(chatid)) continue;
    out.push({ taskId: v.taskId, chatid: v.chatid, startedAt: v.startedAt });
  }
  return out;
}

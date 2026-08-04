/**
 * interaction_lease.mjs — 互动会话对桌宠的临时租约（PetLifecycle 的受控输入）+ 纯决策函数。
 *
 * 【功能链】（D5 §2.1/§2.2，2026-08-04 结构版）
 *   开始互动: setDataActions.startGameCompanion → gameCompanion.startGameCompanion(成功)
 *     → acquireInteractionLease(username, chatid) → onInteractionLeaseChange 广播
 *     → screenshot/main.mjs（唯一进程 owner）重算 effectiveDesired = explicitPetEnabled || activeLease
 *     → ensurePetRunning 拉起/维持 Electron 桌宠
 *   停止互动: stopGameCompanion / Unload(stopAllSessions) → releaseInteractionLease(leaseId)
 *     → owner 重算 effective desired → 显式开关未开则进入优雅停止（10s ack deadline）
 *
 * 【why 独立叶子】
 *   1) lease 是运行时状态，绝不写 pet_settings.json——重启后没有恢复的互动 session 就没有 lease，
 *      不会遗留“被互动动作持久化的开关”（替代 0804 iter6 的 petAutoEnabledByInteraction 持久化标记，
 *      该标记随本结构版从 PET_SETTINGS_DEFAULT 删除）。
 *   2) 零依赖：测试（tests/pet_lifecycle_contract_test.mjs）直接 import 本叶子即可覆盖
 *      四象限/接管/停止判据，不会经 injection_state → storage.mjs 大依赖图，更不会触发
 *      screenshot/main.mjs 的 import 副作用（autostart 定时器/真实 spawn）。
 *
 * 【关联链】
 *   ← gameCompanion.mjs（acquire/release；session.petLeaseId 持有）
 *   ← screenshot/main.mjs（onInteractionLeaseChange 订阅 + hasActiveInteractionLease 消费 +
 *      显式 petEnabled=false 写入时 revokeInteractionLeases 接管）
 *   ← injection_state.mjs（re-export，供 endpoints/setDataActions 单点 import）
 *
 * 【影响范围】桌宠进程的 effective desired 计算；不触碰 pet_settings.json、token、心跳。
 * 【使用效果】原开/原关桌宠 × 开始/停止互动四象限：停止互动只撤本次临时要求；
 *   用户原先显式开启的桌宠仍在，原先关闭的会停；用户显式操作开关=接管（吊销全部 lease）。
 */

/** @type {Map<string, { username: string, chatid: string, acquiredAt: number }>} */
const _leases = new Map();
let _leaseSeq = 0;

const _listeners = new Set();
/** 订阅 lease 集合变更（acquire/release/revoke 后触发）。订阅方异常不阻断写方。 */
export function onInteractionLeaseChange(fn) {
  if (typeof fn === "function") _listeners.add(fn);
}
function _broadcast(event) {
  for (const fn of _listeners) {
    try {
      const r = fn(event);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* 订阅方异常不阻断 */ }
  }
}

/**
 * 互动会话申请临时桌宠租约。
 * @param {string} username 互动 session 所属用户
 * @param {string} [chatid] 承载对话（诊断用途）
 * @returns {string} leaseId
 */
export function acquireInteractionLease(username, chatid = "") {
  const leaseId = `lease_${Date.now().toString(36)}_${++_leaseSeq}`;
  _leases.set(leaseId, { username: String(username || ""), chatid: String(chatid || ""), acquiredAt: Date.now() });
  _broadcast({ type: "acquire", leaseId });
  return leaseId;
}

/**
 * 释放租约（停止互动 / Unload）。幂等：已被接管吊销的 lease 再 release 返回 false 不报错。
 * @param {string} leaseId
 * @returns {boolean} 是否真实释放了一个在册 lease
 */
export function releaseInteractionLease(leaseId) {
  const existed = _leases.delete(leaseId);
  if (existed) _broadcast({ type: "release", leaseId });
  return existed;
}

/**
 * 吊销全部租约（用户显式操作「关闭桌宠」=接管：互动 session 继续，但桌宠按用户显式意愿停止）。
 * @param {string} reason 诊断标记
 * @returns {number} 吊销数量
 */
export function revokeInteractionLeases(reason = "explicit-off") {
  const n = _leases.size;
  if (n) {
    _leases.clear();
    _broadcast({ type: "revoke", reason, count: n });
  }
  return n;
}

/** 是否存在任一活跃互动租约。 */
export function hasActiveInteractionLease() {
  return _leases.size > 0;
}

/** 在册租约快照（诊断/DTO 用）。 */
export function listInteractionLeases() {
  return [..._leases.entries()].map(([leaseId, v]) => ({ leaseId, ...v }));
}

// ── 纯决策函数（PetLifecycle 状态机的可单测内核；owner=screenshot/main.mjs 消费） ──

/**
 * effective desired 单点公式（D5 §2.1）。
 * @param {boolean} explicitPetEnabled pet_settings.json.petEnabled（唯一持久开关）
 * @param {boolean} leaseActive hasActiveInteractionLease()
 */
export function computeEffectiveDesired(explicitPetEnabled, leaseActive) {
  return !!explicitPetEnabled || !!leaseActive;
}

/** 停止 ack 契约常量：请求进程退出后 10s 无 exit/心跳消失 → stop_timeout（状态保持 stopping）。 */
export const STOP_ACK_DEADLINE_MS = 10_000;

/**
 * 停止收束判定（每次轮询喂入观测值，输出下一动作；不做副作用）。
 * @param {object} obs
 * @param {boolean} obs.childExited 本代 child 的 status promise 已落定（真实 exit ack）
 * @param {boolean} obs.hasChild    是否仍持有本代 child 句柄（adopted 实例=无句柄）
 * @param {number|null} obs.heartbeatAgoMs 心跳距今毫秒（null=从未见过）
 * @param {number} obs.heartbeatStaleMs 心跳失效阈值（与 owner 的 _PET_HEARTBEAT_STALE_MS 同源传入）
 * @param {number} obs.elapsedMs    距 stop 请求已过毫秒
 * @param {number} [obs.deadlineMs] ack deadline（默认 STOP_ACK_DEADLINE_MS）
 * @returns {"confirmed"|"waiting"|"escalate_kill"|"timeout"}
 *   confirmed=已确认退出可置 stopped；waiting=继续等；
 *   escalate_kill=owned child 到期，升级 SIGKILL 并继续等其 status 落定；
 *   timeout=adopted 无句柄且心跳仍新鲜到期 → 记 stop_timeout，状态保持 stopping（不谎报 stopped）。
 */
export function resolveStopOutcome(obs) {
  const deadline = obs.deadlineMs ?? STOP_ACK_DEADLINE_MS;
  if (obs.hasChild) {
    if (obs.childExited) return "confirmed";
    return obs.elapsedMs >= deadline ? "escalate_kill" : "waiting";
  }
  // adopted / 无句柄实例：唯一 ack = 心跳消失（从未见过=无存活证据，同样视为已消失）
  if (obs.heartbeatAgoMs === null || obs.heartbeatAgoMs > obs.heartbeatStaleMs) return "confirmed";
  return obs.elapsedMs >= deadline ? "timeout" : "waiting";
}

/**
 * spawn 后心跳确认判定（WAITING_HEARTBEAT → RUNNING / ERROR_UNCONFIRMED）。
 * @param {object} obs
 * @param {number} obs.spawnedAt spawn 时刻 epoch ms
 * @param {number|null} obs.heartbeatSeenAt 最近一次 pet-token 请求时刻（null=从未）
 * @param {number} obs.now
 * @param {number} [obs.deadlineMs] 确认窗口（默认 10s）
 * @returns {"running"|"waiting"|"unconfirmed"}
 */
export function resolveHeartbeatConfirm(obs) {
  const deadline = obs.deadlineMs ?? STOP_ACK_DEADLINE_MS;
  if (typeof obs.heartbeatSeenAt === "number" && obs.heartbeatSeenAt >= obs.spawnedAt) return "running";
  return obs.now - obs.spawnedAt >= deadline ? "unconfirmed" : "waiting";
}

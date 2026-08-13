/**
 * cloneAbort.mjs — 分身作业的唯一在飞注册表与精准停止口。
 *
 * 完整链：replyHandler 为批内每个 job 预注册 → Runner 复用该 controller
 * → 前端携带 jobId 请求停止 → setDataActions → abortClones 精确命中
 * → AI 闸/在飞请求收到 signal → Runner 产出 stopped 单一终态 → finally 注销。
 *
 * 注册表只持瞬时 AbortController；结果、续接和运行快照仍由原存储链负责。
 */

const _controllers = new Map(); // internalKey → entry
const _SEP = "\u0000";

function _internalKey(username, jobId) {
  return [String(username), String(jobId)].join(_SEP);
}

function _executionHost() {
  const pid = globalThis.process?.pid ?? globalThis.Deno?.pid ?? "unknown";
  return globalThis.__beilu_worker_isolate === true
    ? `worker:${globalThis.__beilu_worker_id || pid}`
    : `main:${pid}`;
}

function _job(username, chatid, taskId, jobIdentity = {}, detached = false) {
  const cloneBatchId = String(jobIdentity?.cloneBatchId || `standalone:${jobIdentity?.sourceDetail || "unknown"}:${taskId}`);
  return {
    ownerUsername: String(username),
    chatId: String(chatid ?? ""),
    parentGenerationId: jobIdentity?.parentGenerationId ? String(jobIdentity.parentGenerationId) : null,
    cloneBatchId,
    taskId: String(taskId),
    jobId: String(jobIdentity?.jobId || `${cloneBatchId}:${taskId}`),
    source: "subagent",
    sourceDetail: String(jobIdentity?.sourceDetail || "formal"),
    executionMode: detached ? "detached" : "attached",
    // 宿主由 controller 真 owner 在注册边界冻结，不接受 UI/action payload 自报。
    executionHost: _executionHost(),
  };
}

/** 批内派发前注册，使 batch_queued 阶段也已有可停止的 controller。 */
export function registerCloneAbort(username, chatid, taskId, jobIdentity = {}, { detached = false } = {}) {
  const job = _job(username, chatid, taskId, jobIdentity, detached);
  let key = _internalKey(username, job.jobId);
  if (_controllers.has(key)) {
    let suffix = 2;
    while (_controllers.has(`${key}${_SEP}dup${suffix}`)) suffix++;
    key = `${key}${_SEP}dup${suffix}`;
  }
  const controller = new AbortController();
  controller._cloneKey = key;
  controller._cloneJob = job;
  _controllers.set(key, { controller, job, startedAt: Date.now() });
  return controller;
}

/** 任务结束（完成/异常/中止）按 controller 身份注销，不误删同编号的其他批次。 */
export function unregisterCloneAbort(username, chatid, taskId, controller) {
  if (controller?._cloneKey) {
    _controllers.delete(controller._cloneKey);
    return;
  }
  const candidates = [..._controllers.entries()].filter(([, entry]) => (
    entry.job.ownerUsername === String(username)
    && entry.job.chatId === String(chatid ?? "")
    && entry.job.taskId === String(taskId)
  ));
  if (candidates.length === 1) _controllers.delete(candidates[0][0]);
}

function _matching(username, { chatid, taskId, cloneBatchId, jobId } = {}) {
  return [..._controllers.entries()].filter(([, entry]) => {
    const job = entry.job;
    if (job.ownerUsername !== String(username)) return false;
    if (chatid !== undefined && job.chatId !== String(chatid)) return false;
    if (jobId !== undefined && job.jobId !== String(jobId)) return false;
    if (cloneBatchId !== undefined && job.cloneBatchId !== String(cloneBatchId)) return false;
    if (taskId !== undefined && job.taskId !== String(taskId)) return false;
    return true;
  });
}

/**
 * 停止分身。
 * - jobId：精确停止一个作业。
 * - cloneBatchId + taskId：精确停止批内一个作业。
 * - 仅 taskId：只有唯一匹配时兼容执行；多批同号则拒绝，绝不批量误杀。
 * - 都缺省：停当前筛选范围内全部作业。
 */
export function abortClones(username, criteria = {}) {
  const normalized = {
    chatid: criteria.chatid !== undefined ? String(criteria.chatid) : undefined,
    taskId: criteria.taskId !== undefined ? String(criteria.taskId) : undefined,
    cloneBatchId: criteria.cloneBatchId !== undefined ? String(criteria.cloneBatchId) : undefined,
    jobId: criteria.jobId !== undefined ? String(criteria.jobId) : undefined,
  };
  const matches = _matching(username, normalized);
  const bareTaskId = normalized.taskId !== undefined && normalized.jobId === undefined && normalized.cloneBatchId === undefined;
  if (bareTaskId && matches.length > 1) {
    return { aborted: 0, matched: matches.length, ambiguous: true, jobIds: matches.map(([, entry]) => entry.job.jobId) };
  }

  const abortedJobIds = [];
  for (const [key, entry] of matches) {
    if (!entry.controller.signal.aborted) {
      entry.controller.abort();
      abortedJobIds.push(entry.job.jobId);
    }
    _controllers.delete(key);
  }
  return { aborted: abortedJobIds.length, matched: matches.length, ambiguous: false, jobIds: abortedJobIds };
}

/** 在飞/排队分身清单；完整 job 身份供停止消费者原样回传。 */
export function listActiveClones(username, chatid) {
  const out = [];
  for (const entry of _controllers.values()) {
    if (entry.job.ownerUsername !== String(username)) continue;
    if (chatid !== undefined && entry.job.chatId !== String(chatid)) continue;
    out.push({ ...entry.job, startedAt: entry.startedAt });
  }
  return out;
}

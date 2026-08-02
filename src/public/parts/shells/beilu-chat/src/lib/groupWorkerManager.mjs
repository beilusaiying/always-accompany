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
import { dispatchBridgeChunk } from "../../../../../../yonban/core/transport/isolateBridge.mjs";

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

// 跨线并发硬上限（借 OpenClaw 4/8、Hermes 3）：防多线 worker 同时占内存 / 打爆 API / $47k 递归。
const MAX_CONCURRENT_WORKERS = 5;        // 同时存活的线 worker 上限（满则先回收最久空闲者）
const WORKER_IDLE_TTL_MS = 10 * 60_000;  // 空闲超时回收（常驻 isolate 防内存单调涨）
const WORKER_EVENT_DEDUP_LIMIT = 4096;
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
 * @property {(payload:object, onStream?:(chunk:any)=>void)=>Promise<any>} request
 * @property {(requestSeq:number)=>void} abort
 * @property {()=>void} terminate
 */

function _spawn(groupId, runnerUrl) {
  wbT(null, "group", "spawn:worker", { groupId, workerCount: _workers.size });
  const worker = new Worker(_WORKER_URL, { type: "module" });
  const pending = new Map(); // seq → {resolve,reject,onStream}
  // eventId → { status:"pending"|"accepted", at:number }。main 拒绝/异常必须释放，
  // 否则合法 workerId 的畸形事件能抢占 eventId，令修正后的合法重试被永久去重。
  const seenEventIds = new Map();
  const lifecycleStats = { eventReceived: 0, eventAccepted: 0, eventRejected: 0, eventDeduped: 0 };
  let lifecycleTail = Promise.resolve();
  let announcedWorkerId = null;
  let seq = 0;

  worker.onmessage = (e) => {
    const { kind, id, result, error, chunk, event } = e.data || {};
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
      wbD(null, "group", "worker:fatal", false, "worker fatal: " + error, { groupId, pendingCount: pending.size });
      for (const p of pending.values()) p.reject(new Error("worker fatal: " + error));
      pending.clear();
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    if (kind === "stream") { try { p.onStream?.(chunk); } catch { /* 流回调不阻塞 */ } return; }
    pending.delete(id);
    if (kind === "reply") p.resolve(result);
    else if (kind === "error") { wbD(null, "group", "worker:reqError", false, error, { groupId, reqId: id }); p.reject(new Error(error)); }
  };
  worker.onerror = (e) => {
    const err = e?.error || new Error(e?.message || "worker error");
    wbD(null, "group", "worker:onerror", false, err?.message || "worker error", { groupId, pendingCount: pending.size });
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const send = (kind, payload, onStream) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, onStream });
      worker.postMessage({ kind, id, payload });
    });

  const ready = send("init", { groupId, runnerUrl }).then((result) => {
    announcedWorkerId = result?.workerId || null;
    return result;
  });

  return {
    groupId,
    worker,
    ready,
    lastUsedAt: Date.now(),
    inFlight: 0,
    lifecycleStats,
    waitForLifecycle: () => lifecycleTail,
    request: (payload, onStream, signal) => {
      const id = ++seq;
      // ★ 用户中止转发：stream.signal 中止 → 向 worker 发 abort，命中该 request 的 AbortController
      //   （groupWorker._aborts.get(requestId)），让 worker 内 GetReply 真停。原先没接=停了 worker 还跑。
      if (signal) {
        const _fwd = () => {
          wbD(null, "group", "request:userAbort", false, "用户中止 → 转发 abort 给 worker", { groupId, reqId: id });
          worker.postMessage({ kind: "abort", id: ++seq, payload: { requestId: id } });
          const p = pending.get(id);
          if (p) { pending.delete(id); p.reject(new Error("用户中止")); }
        };
        if (signal.aborted) { wbD(null, "group", "request:preAborted", false, "请求前已中止", { groupId }); return Promise.reject(new Error("用户中止")); }
        signal.addEventListener?.("abort", _fwd, { once: true });
      }
      return new Promise((resolve, reject) => {
        const TIMEOUT = 300000;
        const timer = setTimeout(() => {
          if (pending.has(id)) { wbD(null, "group", "request:timeout", false, `worker 请求超时 (${TIMEOUT / 1000}s)`, { groupId, reqId: id }); pending.delete(id); reject(new Error(`worker 请求超时 (${TIMEOUT / 1000}s)`)); }
        }, TIMEOUT);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, onStream });
        worker.postMessage({ kind: "request", id, payload });
      });
    },
    abort: (requestSeq) => worker.postMessage({ kind: "abort", id: ++seq, payload: { requestId: requestSeq } }),
    terminate() { try { worker.terminate(); } catch { /* already gone */ } _workers.delete(groupId); },
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
 * 任一 key 恒真 → 恒路由 worker（调用方仅在异常时退回本地 GetReply）。
 */
// 缺-2 运行态显示：线起跑/结束时把当前活跃线键广播给前端（cardsPanel 标"在跑"）。
//   懒 import 防循环依赖；广播失败不影响生成。payload.activeLines = activeGroupWorkerIds()（一窗一线时键=chatid）。
function _broadcastRuntime(username) {
  import("./broadcast.mjs")
    .then((m) => m.broadcastAllChatUi?.({ type: "group_runtime_update", payload: { username, activeLines: activeGroupWorkerIds() } }, username))
    .catch(() => {});
}

export async function dispatchReplyToGroup(username, chatid, payload = {}, runnerUrl = _RUNNER_URL, onStream, signal) {
  const groupId = getGroupIdByChatId(username, chatid);
  const key = groupId || chatid; // 一窗一线：未绑组按 chatid 当线键
  wbT(chatid, "group", "dispatch:enter", { username, chatid, groupId, key, bound: !!groupId, charname: payload.charname });
  const h = getOrSpawnGroupWorker(key, runnerUrl);
  await h.ready;
  h.inFlight++; // 并发计数：上限回收/sweeper 只动 inFlight===0 的空闲 worker，不误杀在飞线
  if (groupId) updateGroup(username, groupId, { status: "running" }); // 组态只对绑组的更新
  _broadcastRuntime(username); // 缺-2：线起跑 → 推运行态
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
    // 跨 isolate 桥上行：桥事件（审批入队/广播回放）在此拦截分发，其余 chunk（preview）原样放行。
    const _onStreamBridged = (chunk) => { if (dispatchBridgeChunk(chunk)) return; onStream?.(chunk); };
    wbT(chatid, "group", "dispatch:request", { key, workspaceRoot: _wsRoot || "(默认根)", activeMode: _activeMode || "(默认)", hasBridgeState: !!_bridgeState, inFlight: h.inFlight });
    const result = await h.request({ username, chatid, data_path, workspaceRoot: _wsRoot, activeMode: _activeMode, bridgeState: _bridgeState, idePort: _idePort, ...payload }, _onStreamBridged, signal);
    wbT(chatid, "group", "dispatch:done", { key, hasContent: !!result?.content, contentLen: result?.content?.length || 0, pendingFileOps: !!result?.pendingFileOps });
    return { routed: true, groupId: key, result };
  } catch (_dispErr) {
    wbD(chatid, "group", "dispatch:error", false, _dispErr?.message || String(_dispErr), { key, groupId });
    throw _dispErr;
  } finally {
    h.inFlight--;
    h.lastUsedAt = Date.now();
    if (groupId) updateGroup(username, groupId, { status: "idle" });
    _broadcastRuntime(username); // 缺-2：线结束 → 推运行态
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

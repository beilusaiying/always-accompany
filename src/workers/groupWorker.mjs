import { wbT, wbD } from "../server/wbStub.mjs";
/**
 * 多组并行 v4 · P3-1 —— 常驻组 worker shell（每组一个 Deno Worker isolate）
 *
 * isolate 天然隔离 module 单例（configData/ideClient/_vectors）——见 iso_test 验证 6/0。
 * 本文件只负责「常驻多轮协议 + 生命周期」，不含任何业务：真正跑一轮回复的逻辑由
 * runner 模块提供（init 时传 runnerUrl，runner 在本 worker 的 isolate 内 import，
 * 其 import 链上的 configData/ideClient/workspaceRoot 即随 isolate 隔离 = 一组一套）。
 *
 * 协议（主进程 ↔ worker）：
 *   → {kind:"init", id, payload:{groupId, runnerUrl}}      ← {kind:"reply", id, result:{ready,hasRunner}}
 *   → {kind:"request", id, payload:{...}}                  ← (多条){kind:"stream", id, chunk} 然后 {kind:"reply"|"error", id, ...}
 *   → {kind:"abort", id, payload:{requestId}}              ← {kind:"reply", id, result:{aborted}}
 *   → {kind:"ping", id}                                    ← {kind:"reply", id, result:{pong}}
 *   worker 生命周期事件（不绑定 request pending）          ← {kind:"event", event:{type:"tool_lifecycle",version:1,...}}
 */

// ★ D1：标记本 isolate 为 worker，使 parts_loader 用 per-isolate 内存门跑 part.Init
//   （磁盘 parts_init 是跨进程 install-once 记录，worker 读它会跳过 Init → isolate 内 Init 态空）。
globalThis.__BEILU_WORKER_ISOLATE = true;

let _runner = null;
let _groupId = null;
const _aborts = new Map(); // 进行中请求 id → AbortController（abort 用）
const _workerId = globalThis.crypto?.randomUUID?.()
  || `group_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
let _eventSeq = 0;

function reply(id, result) { self.postMessage({ kind: "reply", id, result }); }
function fail(id, err) {
  self.postMessage({ kind: "error", id, error: err?.stack || err?.message || String(err) });
}
function emit(id, chunk) { self.postMessage({ kind: "stream", id, chunk }); }
function emitEvent(event) {
  if (!event || typeof event !== "object") return false;
  const eventId = (typeof event.eventId === "string" && event.eventId)
    || `${_workerId}:${Date.now()}:${++_eventSeq}`;
  self.postMessage({
    kind: "event",
    event: {
      ...event,
      type: "tool_lifecycle",
      version: 1,
      workerId: _workerId,
      eventId,
    },
  });
  return true;
}

self.onmessage = async (e) => {
  const { kind, id, payload } = e.data || {};
  wbT(payload?.chatid ?? null, "groupWorker", "onmessage:enter", { kind, id, groupId: _groupId });
  try {
    switch (kind) {
      case "init": {
        _groupId = payload?.groupId ?? null;
        wbT(null, "groupWorker", "init:enter", { groupId: _groupId, hasRunnerUrl: !!payload?.runnerUrl });
        if (payload?.runnerUrl) {
          const mod = await import(payload.runnerUrl);
          _runner = mod.run || mod.default || null;
        }
        wbT(null, "groupWorker", "init:done", { groupId: _groupId, hasRunner: typeof _runner === "function" });
        reply(id, { ready: true, groupId: _groupId, workerId: _workerId, hasRunner: typeof _runner === "function" });
        break;
      }
      case "request": {
        if (typeof _runner !== "function") {
          wbD(payload?.chatid ?? null, "groupWorker", "request:noRunner", false, "no runner loaded", { id });
          fail(id, new Error("no runner loaded")); break;
        }
        wbT(payload?.chatid ?? null, "groupWorker", "request:enter", { id, groupId: _groupId });
        const ac = new AbortController();
        _aborts.set(id, ac);
        try {
          const result = await _runner(payload, {
            groupId: _groupId,
            workerId: _workerId,
            signal: ac.signal,
            emit: (chunk) => emit(id, chunk),
            emitEvent,
          });
          wbT(payload?.chatid ?? null, "groupWorker", "request:done", { id });
          reply(id, result);
        } catch (err) {
          wbD(payload?.chatid ?? null, "groupWorker", "request:error", false, err?.message, { id });
          fail(id, err);
        } finally {
          _aborts.delete(id);
        }
        break;
      }
      case "abort": {
        const ac = _aborts.get(payload?.requestId);
        wbT(null, "groupWorker", "abort:enter", { requestId: payload?.requestId, found: !!ac });
        if (ac) ac.abort(new Error("aborted by main"));
        reply(id, { aborted: !!ac });
        break;
      }
      case "ping":
        reply(id, { pong: true, groupId: _groupId, workerId: _workerId });
        break;
      default:
        wbD(null, "groupWorker", "onmessage:unknownKind", false, "unknown kind: " + kind, { kind });
        fail(id, new Error("unknown kind: " + kind));
    }
  } catch (err) {
    wbD(null, "groupWorker", "onmessage:uncaught", false, err?.message, { kind });
    fail(id, err);
  }
};

self.onerror = (e) => {
  wbD(null, "groupWorker", "onerror:fatal", false, e?.message || String(e), {});
  self.postMessage({ kind: "fatal", error: e?.error?.stack || e?.message || String(e) });
};

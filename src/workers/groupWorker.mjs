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
 *   → {kind:"request", id, payload:{...},bridge:{capability,allowedBridgeTypes}}
 *                                                           ← (多条){kind:"stream", id, chunk} 然后 {kind:"reply"|"error", id, ...}
 *   → {kind:"abort", id, payload:{requestId}}              ← {kind:"reply", id, result:{aborted}}
 *   → {kind:"ping", id}                                    ← {kind:"reply", id, result:{pong}}
 *   ← {kind:"bridge_request", bridgeRequestId,parentRequestId,capability,type,chatId,payload}
 *   → {kind:"bridge_response", bridgeRequestId,success,result|error}
 *   ← {kind:"request_settled",requestId,workerId,state}（runner/bridge finally 已完成）
 *   worker 生命周期事件（不绑定 request pending）          ← {kind:"event", event:{type:"tool_lifecycle",version:1,...}}
 */

// ★ D1：标记本 isolate 为 worker，使 parts_loader 用 per-isolate 内存门跑 part.Init
//   （磁盘 parts_init 是跨进程 install-once 记录，worker 读它会跳过 Init → isolate 内 Init 态空）。
globalThis.__BEILU_WORKER_ISOLATE = true;

let _runner = null;
let _groupId = null;
const _requests = new Map(); // parent request id → { controller, bridgeBinding }
let _bridgeModulePromise = null;
const _workerId = globalThis.crypto?.randomUUID?.()
  || `group_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
let _eventSeq = 0;

function bridgeModule() {
  return _bridgeModulePromise ??= import("../yonban/core/transport/isolateBridge.mjs");
}

function reply(id, result) { self.postMessage({ kind: "reply", id, result }); }
function _errorPayload(err, fallback = {}) {
  const details = err?.details && typeof err.details === "object" ? err.details : {};
  const bool = (field, defaultValue) => {
    const value = err?.[field] ?? details[field] ?? fallback[field];
    return typeof value === "boolean" ? value : defaultValue;
  };
  return {
    code: (typeof err?.code === "string" && err.code) || fallback.code || "E_WORKER_REQUEST_FAILED",
    message: err?.message || String(err || fallback.message || "worker request failed"),
    phase: (typeof err?.phase === "string" && err.phase)
      || (typeof details.phase === "string" && details.phase)
      || fallback.phase
      || "worker",
    executionStarted: bool("executionStarted", fallback.executionStarted === true),
    sideEffectsPossible: bool("sideEffectsPossible", fallback.sideEffectsPossible === true),
    indeterminate: bool("indeterminate", fallback.indeterminate === true),
  };
}
function fail(id, err, fallback) {
  self.postMessage({ kind: "error", id, error: _errorPayload(err, fallback) });
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

function emitRequestSettled(requestId, requestState) {
  try {
    self.postMessage({
      kind: "request_settled",
      requestId,
      workerId: _workerId,
      state: {
        phase: requestState?.phase || "request_finally",
        outcome: requestState?.outcome || "unknown",
        executionStarted: requestState?.executionStarted === true,
        sideEffectsPossible: requestState?.sideEffectsPossible === true,
        indeterminate: requestState?.indeterminate === true,
      },
    });
    return true;
  } catch (settledPostError) {
    wbD(null, "groupWorker", "request:settledPostFail", false,
      settledPostError?.message || String(settledPostError), { requestId });
    return false;
  }
}

self.onmessage = async (e) => {
  const { kind, id, payload, bridge: bridgeEnvelope } = e.data || {};
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
          fail(id, Object.assign(new Error("no runner loaded"), { code: "E_WORKER_RUNNER_UNAVAILABLE" }), {
            phase: "runner_lookup",
            executionStarted: false,
            sideEffectsPossible: false,
            indeterminate: false,
          });
          break;
        }
        wbT(payload?.chatid ?? null, "groupWorker", "request:enter", { id, groupId: _groupId });
        const ac = new AbortController();
        const requestState = {
          controller: ac,
          bridgeBinding: null,
          phase: "request_preflight",
          outcome: "pending",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        };
        _requests.set(id, requestState);
        try {
          const bridge = await bridgeModule();
          requestState.bridgeBinding = bridge.bindWorkerRequestEmitter(
            payload?.chatid,
            (message) => { self.postMessage(message); return true; },
            {
              parentRequestId: id,
              capability: bridgeEnvelope?.capability,
              allowedBridgeTypes: bridgeEnvelope?.allowedBridgeTypes,
            },
          );
          if (ac.signal.aborted) {
            requestState.bridgeBinding.close(Object.assign(new Error("parent worker request aborted"), {
              code: "E_BRIDGE_PARENT_ABORTED",
            }));
            throw ac.signal.reason || new Error("aborted by main");
          }
          // 从调用 runner 开始默认 fail-closed：runner 会引导插件/连接工具，随后可发 AI、
          // 执行工具或写文件；任何异常都不能再被 main 当作“未执行”而本地重跑。
          requestState.phase = "runner_start";
          requestState.executionStarted = true;
          requestState.sideEffectsPossible = true;
          const result = await requestState.bridgeBinding.run(() => _runner(payload, {
            groupId: _groupId,
            workerId: _workerId,
            signal: ac.signal,
            emit: (chunk) => emit(id, chunk),
            emitEvent,
            setExecutionPhase: (phase) => {
              if (typeof phase === "string" && phase) requestState.phase = phase;
            },
          }));
          wbT(payload?.chatid ?? null, "groupWorker", "request:done", { id });
          requestState.phase = "response_serialization";
          try {
            reply(id, result);
            requestState.outcome = "reply";
          } catch (responseError) {
            const wrapped = new Error(responseError?.name === "DataCloneError"
              ? "worker response is not structured-cloneable"
              : "worker response delivery failed");
            wrapped.code = responseError?.name === "DataCloneError"
              ? "E_WORKER_RESPONSE_SERIALIZATION"
              : "E_WORKER_RESPONSE_DELIVERY";
            wrapped.phase = "response_serialization";
            wrapped.executionStarted = true;
            wrapped.sideEffectsPossible = true;
            wrapped.indeterminate = true;
            wrapped.details = { cause: responseError?.message || String(responseError) };
            throw wrapped;
          }
        } catch (err) {
          requestState.outcome = "error";
          const details = err?.details && typeof err.details === "object" ? err.details : {};
          if (typeof err?.phase === "string" && err.phase) requestState.phase = err.phase;
          else if (typeof details.phase === "string" && details.phase) requestState.phase = details.phase;
          for (const field of ["executionStarted", "sideEffectsPossible", "indeterminate"]) {
            const explicitValue = err?.[field] ?? details[field];
            if (typeof explicitValue === "boolean") requestState[field] = explicitValue;
          }
          const hasExplicitIndeterminate = typeof err?.indeterminate === "boolean"
            || typeof details.indeterminate === "boolean";
          // runner 启动后发生的异常，除非业务错误明确证明终态，否则 main 不得把它当作
          // 可安全重跑或“已知无副作用”；尤其涵盖 handler 执行后异常与响应 clone 失败。
          if (requestState.executionStarted && !hasExplicitIndeterminate) {
            requestState.indeterminate = true;
          }
          wbD(payload?.chatid ?? null, "groupWorker", "request:error", false, err?.message, { id });
          fail(id, err, requestState);
        } finally {
          try {
            requestState.bridgeBinding?.close(new Error("parent worker request ended"));
          } catch (bridgeCloseError) {
            requestState.outcome = "error";
            requestState.phase = "bridge_finally";
            requestState.indeterminate = requestState.executionStarted;
            wbD(payload?.chatid ?? null, "groupWorker", "request:bridgeCloseFail", false,
              bridgeCloseError?.message || String(bridgeCloseError), { id });
          } finally {
            _requests.delete(id);
            // 必须在 runner/bridge 的 finally 清理完成后发。main 的公开请求可能已因 300s/abort
            // 先失败，但 inFlight/回收资格只以这个可信 workerId+requestId 终态为准。
            emitRequestSettled(id, requestState);
          }
        }
        break;
      }
      case "abort": {
        const requestState = _requests.get(payload?.requestId);
        wbT(null, "groupWorker", "abort:enter", { requestId: payload?.requestId, found: !!requestState });
        if (requestState) {
          requestState.phase = requestState.executionStarted ? "runner_abort" : "request_abort";
          requestState.indeterminate = requestState.executionStarted;
          requestState.sideEffectsPossible = requestState.executionStarted;
          const reportedReason = payload?.reason && typeof payload.reason === "object" ? payload.reason : {};
          const abortError = new Error(
            (typeof reportedReason.message === "string" && reportedReason.message) || "parent worker request aborted",
          );
          abortError.name = (typeof reportedReason.name === "string" && reportedReason.name) || "AbortError";
          abortError.code = (typeof reportedReason.code === "string" && reportedReason.code) || "E_BRIDGE_PARENT_ABORTED";
          requestState.controller.abort(abortError);
          requestState.bridgeBinding?.close(abortError);
        }
        reply(id, { aborted: !!requestState });
        break;
      }
      case "bridge_response": {
        const bridge = await bridgeModule();
        const accepted = bridge.acceptWorkerBridgeResponse(e.data || {});
        if (!accepted) {
          wbD(null, "groupWorker", "bridge:lateOrUnknownResponse", false,
            "bridge response has no matching pending request", { bridgeRequestId: e.data?.bridgeRequestId || null });
        }
        break;
      }
      case "ping":
        reply(id, { pong: true, groupId: _groupId, workerId: _workerId });
        break;
      default:
        wbD(null, "groupWorker", "onmessage:unknownKind", false, "unknown kind: " + kind, { kind });
        fail(id, Object.assign(new Error("unknown kind: " + kind), { code: "E_WORKER_PROTOCOL_KIND" }), {
          phase: "protocol",
          executionStarted: false,
          sideEffectsPossible: false,
          indeterminate: false,
        });
    }
  } catch (err) {
    wbD(null, "groupWorker", "onmessage:uncaught", false, err?.message, { kind });
    if (kind === "bridge_response") return;
    fail(id, err, {
      phase: kind === "request" ? "request_preflight" : "protocol",
      executionStarted: false,
      sideEffectsPossible: false,
      indeterminate: false,
    });
  }
};

self.onerror = (e) => {
  wbD(null, "groupWorker", "onerror:fatal", false, e?.message || String(e), {});
  const hadActiveRequests = _requests.size > 0;
  const fatalError = new Error(e?.error?.message || e?.message || "worker fatal error");
  fatalError.code = "E_BRIDGE_WORKER_FATAL";
  for (const requestState of _requests.values()) {
    try { requestState.controller.abort(fatalError); } catch { /* isolate 正在终止 */ }
    try { requestState.bridgeBinding?.close(fatalError); } catch { /* isolate 正在终止 */ }
  }
  _requests.clear();
  bridgeModule()
    .then((bridge) => bridge.rejectAllWorkerBridgeRequests(fatalError))
    .catch(() => {});
  self.postMessage({
    kind: "fatal",
    error: _errorPayload(fatalError, {
      phase: "worker_fatal",
      executionStarted: hadActiveRequests,
      sideEffectsPossible: hadActiveRequests,
      indeterminate: hadActiveRequests,
    }),
  });
};

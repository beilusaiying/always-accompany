/**
 * p1Bridge.mjs — P1 召回独立服务的桥模块（own 整个接入域）
 *
 * 【功能链】
 *   getPromptHandler Phase3 → runP1(inputText, chatHistory, mode, userCtx)
 *     → HTTP POST http://127.0.0.1:<P1_SERVICE_PORT>/runP1（P1 独立 Python 服务，
 *       memory/p1/service/p1_server.py，002 2026-07-31 拍板：单独/可插拔/可独立运行）
 *     → 返回带 outcome 的结构化结果；空召回、服务失败、传输失败保持可区分
 *
 * 【why · HTTP 而非进程内插件（2026-07-31 改造）】
 *   旧版动态 import Deno 插件=P1 与本体同进程：本体启动/内存背 119MB+词库，测试必须带宿主（高耦合，
 *   002 拍板拆分）。现 P1 全部功能住独立 Python 进程，本桥只做传导：服务不可达/未启用/失败
 *   返回结构化 failure → 调用方按本次请求策略裁决后续，同时白盒可见真实失败层。
 *   启用门也归服务自答（config 自持在服务侧），本体不再知道 P1 配置在哪。
 *
 * 【影响范围】
 *   getPromptHandler.mjs Phase3 与 aiRunner vocab_edit 消费本模块（签名不变，消费方零改动）。
 *   本模块只依赖 shells:p1 的公共 serviceRuntime；生命周期与请求入口同源，无回环。
 *
 * 【并发契约】
 *   HTTP 请求可并发到达；serviceRuntime 只对冷启动单飞。Node 管线的配置、usage 与缓存
 *   是模块级资源，因此 stdio 会对完整 runP1/clearCaches 生命周期执行 FIFO 隔离。
 */

import { getUserDictionary } from "../../security/auth.mjs";
import { requestP1Service } from "../p1/serviceRuntime.mjs";
import { getWorkerBridgeChatId, isWorkerIsolate, requestFromWorker } from "../../../transport/isolateBridge.mjs";

// P1_RUN_TIMEOUT_MS/P1_IO_TIMEOUT_MS 同款 env 通道可覆盖（不接 p1_config，env 是既有通道）
const _RUN_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.("P1_RUN_TIMEOUT_MS")) || 30000;   // 召回管线含冷启动词库加载，首跑可能秒级
const _IO_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.("P1_IO_TIMEOUT_MS")) || 10000;    // 词库纯文件读写

async function _post(action, body, timeoutMs, username = "", chatId = null) {
  if (isWorkerIsolate) {
    let bridgeChatId = typeof chatId === "string" ? chatId.trim() : "";
    if (!bridgeChatId) bridgeChatId = String(getWorkerBridgeChatId() || "").trim();
    if (!bridgeChatId) {
      const { getAmbientChatId } = await import("../../../../../server/whitebox.mjs");
      bridgeChatId = String(getAmbientChatId?.() || "").trim();
    }
    if (!bridgeChatId) {
      return {
        transportOk: false, ok: false, status: 503,
        code: "E_P1_BRIDGE_CHAT_ID_REQUIRED",
        error: "P1 worker bridge 缺少当前 parent chatId",
        data: null, text: "",
      };
    }
    const trustedBody = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
    for (const identityField of ["username", "memoryRoot", "chatId", "chatid", "historyChatId"]) {
      delete trustedBody[identityField];
    }
    try {
      return await requestFromWorker("p1_service", bridgeChatId, {
        action,
        body: trustedBody,
        timeoutMs,
      });
    } catch (error) {
      return {
        transportOk: false, ok: false, status: 503,
        code: error?.code || "E_P1_BRIDGE_REQUEST_FAILED",
        error: error?.message || String(error),
        bridge: {
          phase: error?.phase,
          executionStarted: error?.executionStarted,
          sideEffectsPossible: error?.sideEffectsPossible,
          indeterminate: error?.indeterminate,
        },
        data: null, text: "",
      };
    }
  }
  return await requestP1Service(action, {
    body: body ?? {}, timeoutMs, username,
    memoryRoot: getUserDictionary(username || ""),
  });
}

function _failureFromRequest(requestResult) {
  const serviceData = requestResult?.data && typeof requestResult.data === "object"
    ? requestResult.data
    : null;
  if (!requestResult?.transportOk) {
    return {
      success: false,
      outcome: "transport-failure",
      status: requestResult?.status || 503,
      code: requestResult?.code || "E_P1_TRANSPORT",
      error: requestResult?.error || "P1 服务不可达",
    };
  }
  return {
    success: false,
    outcome: "service-failure",
    status: requestResult.status,
    code: serviceData?.code || requestResult.code || (requestResult.ok ? "E_P1_SERVICE_FAILURE" : `E_P1_HTTP_${requestResult.status}`),
    error: serviceData?.error || requestResult.error || `P1 服务请求失败（HTTP ${requestResult.status}）`,
    trace: serviceData?.trace || null,
    whitebox: serviceData?.whitebox || null,
    runLog: serviceData?.runLog || null,
  };
}

// ---- 对外接口：runP1 ----
/**
 * 运行 P1 自驱动召回管线（独立服务）。
 * @param {string} inputText - 用户最近消息文本
 * @param {Array} chatHistory - 当前输入之前的对话历史 [{role, content}]；不得重复包含 inputText
 * @param {string} mode - 本体已裁决的窗口层（chat/code/work/airp/ide）；P1 不自行回退
 * @param {object} userCtx - {username, charName, chatId, historyChatId}; historyChatId 是 chatHistory 的宿主窗口归属
 * @returns {Promise<object>} {success, outcome, p1_act, recalledRecords, ...}
 *   outcome=recall|empty|service-failure|transport-failure；非 recall 的后续行为由调用方裁决。
 */
export async function runP1(inputText, chatHistory, mode, userCtx) {
  const requestResult = await _post("runP1", {
    inputText: inputText || "",
    chatHistory: chatHistory || [],
    mode: mode || "",
    activeMode: mode || "",
    username: userCtx?.username || "",
    charName: userCtx?.charName || "",
    chatId: userCtx?.chatId || "",
    historyChatId: userCtx?.historyChatId || "",
    source: "production-bridge",
  }, _RUN_TIMEOUT_MS, userCtx?.username || "", userCtx?.chatId || "");
  const res = requestResult?.data;
  if (!requestResult?.transportOk || !requestResult.ok || !res || res.success !== true) {
    const failure = _failureFromRequest(requestResult);
    console.warn("[p1Bridge] P1 request failed:", {
      outcome: failure.outcome,
      status: failure.status,
      code: failure.code,
      error: failure.error,
    });
    return failure;
  }

  // 方向词或记忆记录任一路有结果都必须透传；success:true 的真实空结果也保持为 empty。
  const p1Act = Array.isArray(res.p1_act) ? res.p1_act : [];
  const recalledRecords = Array.isArray(res.recalledRecords) ? res.recalledRecords : [];
  const directionWords = Array.isArray(res.directionWords) ? res.directionWords : [];
  const hasRecall = directionWords.length > 0 || p1Act.length > 0 || recalledRecords.length > 0;
  return {
    success: true,
    outcome: hasRecall ? "recall" : "empty",
    status: requestResult.status,
    p1_act: p1Act,
    recalledRecords,
    v5: res.v5 || null,
    directionWords,
    pyramid: res.pyramid || null,
    trace: res.trace || null,
    whitebox: res.whitebox || null,
    runLog: res.runLog || null,
  };
}

// ---- 对外接口：用户插拔词库读写（P9 词库维护 vocab_edit 工具消费，2026-07-31） ----
// 【why 收口在此】本模块是 yonban 核心触碰 P1 服务的唯一收口点；
//   格式校验收口在服务 saveUserVocab（原子写 + _meta.enabled 必填校验），本函数只透传。

/**
 * 读用户插拔词库文件（供 P9 diff 用）。
 *
 * 返回 tagged union，禁止把“明确不存在”以外的失败压成 null：
 *   - {kind:"found", content, status}
 *   - {kind:"not_found", code, status, error}
 *   - {kind:"error", code, status, error}
 * 只有服务明确给出 E_P1_VOCAB_NOT_FOUND 才是 not_found；HTTP、传输、解析和
 * 其他 success:false 都保留为 error，交由写侧 fail-closed。
 */
export async function getUserVocabFile(file, username = "") {
  try {
    const result = await _post("getUserVocab", { file }, _IO_TIMEOUT_MS, username);
    const res = result?.data;
    if (result?.transportOk && result.ok && res?.success === true) {
      if (!res.content || typeof res.content !== "object" || Array.isArray(res.content)) {
        return {
          kind: "error",
          code: "E_P1_VOCAB_RESPONSE_INVALID",
          status: result.status,
          error: "P1 用户词库读取响应缺少有效 content 对象",
        };
      }
      return { kind: "found", content: res.content, status: result.status };
    }
    if (result?.transportOk && result.ok && res?.code === "E_P1_VOCAB_NOT_FOUND") {
      return {
        kind: "not_found",
        code: res.code,
        status: result.status,
        error: res.error || "用户词库不存在",
      };
    }
    const failure = _failureFromRequest(result);
    return {
      kind: "error",
      code: failure.code,
      status: failure.status,
      error: failure.error,
    };
  } catch (e) {
    return {
      kind: "error",
      code: e?.code || "E_P1_VOCAB_READ_EXCEPTION",
      status: Number(e?.status) || 503,
      error: e?.message || String(e),
    };
  }
}

/** 写用户插拔词库文件（校验/原子写在服务侧） */
export async function saveUserVocabFile(file, content, username = "") {
  try {
    const result = await _post("saveUserVocab", { file, content }, _IO_TIMEOUT_MS, username);
    const res = result?.data;
    if (!result?.transportOk || !result.ok || !res || res.success !== true) {
      return _failureFromRequest(result);
    }
    return { ...res, status: result.status };
  } catch (e) {
    return {
      success: false,
      outcome: "transport-failure",
      status: Number(e?.status) || 503,
      code: e?.code || "E_P1_VOCAB_WRITE_EXCEPTION",
      error: e?.message || String(e),
    };
  }
}

/** 读 P1 服务配置（vocabEditExec 拉熔断上限等；服务不在返 null=调用方用兜底默认） */
export async function getP1Config(username = "") {
  try {
    const result = await _post("getConfig", {}, _IO_TIMEOUT_MS, username);
    const res = result?.data;
    return res?.success ? res.config : null;
  } catch (error) {
    console.warn("[p1Bridge] getP1Config failed:", error?.message || error);
    return null;
  }
}

/**
 * p1Bridge.mjs — P1 召回独立服务的桥模块（own 整个接入域）
 *
 * 【功能链】
 *   getPromptHandler Phase3 → runP1(inputText, chatHistory, mode, userCtx)
 *     → HTTP POST http://127.0.0.1:<P1_SERVICE_PORT>/runP1（P1 独立 Python 服务，
 *       shells/p1/service/p1_server.py，002 2026-07-31 拍板：单独/可插拔/可独立运行）
 *     → 返回 {p1_act, recalledRecords, v5, directionWords, ...} 或 null
 *
 * 【why · HTTP 而非进程内插件（2026-07-31 改造）】
 *   旧版动态 import Deno 插件=P1 与本体同进程：本体启动/内存背 119MB+词库，测试必须带宿主（高耦合，
 *   002 拍板拆分）。现 P1 全部功能住独立 Python 进程，本桥只做传导：服务不可达/未启用/失败
 *   一律返 null → 调用方走 AI P1 降级 = 插拔语义（拔掉服务任何链路不炸）。
 *   启用门也归服务自答（config 自持在服务侧），本体不再知道 P1 配置在哪。
 *
 * 【影响范围】
 *   getPromptHandler.mjs Phase3 与 aiRunner vocab_edit 消费本模块（签名不变，消费方零改动）。
 *   本模块零 import 依赖（fetch 为运行时标准 API），无回环。
 *
 * 【并发契约】
 *   多请求可交错：每次调用独立 HTTP 请求，服务端无请求级共享可变状态（配置盘为真相 mtime 热载）。
 */

const _P1_PORT = Number(globalThis.Deno?.env?.get?.("P1_SERVICE_PORT")) || 13150;
const _P1_BASE = `http://127.0.0.1:${_P1_PORT}`;
// P1_RUN_TIMEOUT_MS/P1_IO_TIMEOUT_MS 同款 env 通道可覆盖（本模块零 import 依赖，不接 p1_config，env 是既有通道）
const _RUN_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.("P1_RUN_TIMEOUT_MS")) || 30000;   // 召回管线含冷启动词库加载，首跑可能秒级
const _IO_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.("P1_IO_TIMEOUT_MS")) || 10000;    // 词库纯文件读写

async function _post(action, body, timeoutMs) {
  const res = await fetch(`${_P1_BASE}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await res.json();
}

// ---- 对外接口：runP1 ----
/**
 * 运行 P1 自驱动召回管线（独立服务）。
 * @param {string} inputText - 用户最近消息文本
 * @param {Array} chatHistory - 最近 N 条对话 [{role, content}]
 * @param {string} mode - 当前模式（chat/code/work/airp/ide）
 * @param {object} userCtx - {username, charName}
 * @returns {Promise<object|null>} {p1_act, recalledRecords, v5, directionWords, pyramid, trace, whitebox} 或 null
 *   null = 服务不可达 / 未启用 / 管线失败 → 调用方走 AI P1 降级（零回归）
 */
export async function runP1(inputText, chatHistory, mode, userCtx) {
  try {
    const res = await _post("runP1", {
      inputText: inputText || "",
      chatHistory: chatHistory || [],
      mode: mode || "chat",
      username: userCtx?.username || "",
      charName: userCtx?.charName || "",
      chatId: userCtx?.chatId || "",
    }, _RUN_TIMEOUT_MS);
    // 方向词或记忆记录任一路有结果都必须透传；不能让非空 record recall 被 p1_act 空值吞掉。
    const recalledRecords = Array.isArray(res?.recalledRecords) ? res.recalledRecords : [];
    if (!res?.success || (!res?.p1_act?.length && recalledRecords.length === 0)) {
      console.warn("[p1Bridge] P1 returned no usable recall result:", {
        success: !!res?.success,
        error: res?.error || null,
        directionCount: res?.p1_act?.length || 0,
        recordCount: recalledRecords.length,
        dataReason: res?.trace?.recall?.dataRecall?.reason || null,
      });
      return null;
    }
    return {
      p1_act: res.p1_act || [],
      recalledRecords,
      v5: res.v5 || null,
      directionWords: res.directionWords || [],
      pyramid: res.pyramid || null,
      trace: res.trace || null,
      whitebox: res.whitebox || null,
    };
  } catch (e) {
    // 服务不在（拔掉状态）走这里：ECONNREFUSED/timeout → 降级，响亮一行不刷屏
    console.warn(`[p1Bridge] P1 服务不可达或失败（走 AI P1 降级，独立启动: python src/public/parts/shells/p1/service/p1_server.py）:`, e?.message || e);
    return null;
  }
}

// ---- 对外接口：用户插拔词库读写（P9 词库维护 vocab_edit 工具消费，2026-07-31） ----
// 【why 收口在此】本模块是 yonban 核心触碰 P1 服务的唯一收口点；
//   格式校验收口在服务 saveUserVocab（原子写 + _meta.enabled 必填校验），本函数只透传。

/** 读用户插拔词库文件（供 P9 diff 用；不存在返回 null，非异常） */
export async function getUserVocabFile(file) {
  try {
    const res = await _post("getUserVocab", { file }, _IO_TIMEOUT_MS);
    return res?.success ? res.content : null;
  } catch (e) {
    console.warn("[p1Bridge] getUserVocabFile 失败:", e?.message || e);
    return null;
  }
}

/** 写用户插拔词库文件（校验/原子写在服务侧） */
export async function saveUserVocabFile(file, content) {
  try {
    return await _post("saveUserVocab", { file, content }, _IO_TIMEOUT_MS);
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

/** 读 P1 服务配置（vocabEditExec 拉熔断上限等；服务不在返 null=调用方用兜底默认） */
export async function getP1Config() {
  try {
    const res = await _post("getConfig", {}, _IO_TIMEOUT_MS);
    return res?.success ? res.config : null;
  } catch {
    return null;
  }
}

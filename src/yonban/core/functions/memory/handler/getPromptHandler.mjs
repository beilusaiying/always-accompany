/**
 * getPromptHandler.mjs — GetPrompt 21步注入管线。
 *
 * 【功能链】
 *   每次 AI 生成前，把记忆/表格/检索/P1/P8联网/委派结果等数据拼装成可供 beilu-preset 消费的注入结构，
 *   控制 token 用量（上下文压缩/urgent清理/T09摘要），并在每日首开时写问候、在切预设时做隔离切换。
 *   不管生成请求构建（requestBuilder 的事），不管预设五段拼装（beilu-preset TweakPrompt 的事），
 *   不管 AI 回复标签解析（replyHandler 的事）。
 *
 * 【why】
 *   GetPrompt 是唯一能在 AI 看到对话前向 prompt 注入结构化记忆的钩子。所有需要在本轮 AI 生成前
 *   "知道/检索/压缩/委派注入"的逻辑都必须在这里完成，否则 AI 当轮无从感知。
 *   21步串行而非并发，是因为各步之间有状态依赖（如 S7 读 code/work 数据才能供 S11 宏替换）。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块。调用链：
 *     前端发消息 → POST /api/generate（beilu-chat）
 *     → generation.mjs executeGeneration()
 *     → getChatRequest()（requestBuilder）
 *     → 遍历插件 GetPrompt 钩子 → main.mjs interfaces.GetPrompt
 *     → 本模块 handleGetPrompt(arg)
 *   返回值 { text, extension.memory_depth_injections } 由 beilu-preset TweakPrompt 三轮消费后
 *   拼入最终发送给 AI 的 system/prompt 五段结构。
 *
 * 【关联链】
 *   ← generation.mjs executeGeneration → getChatRequest → 本模块（R1/R2 交叉）
 *   → storage.mjs（loadMemoryData / loadMemoryPresets / readContextSummary / resolveEffectiveMaxContext）；mode 裁决经 injectionSystem.resolveInjectionContext（单源）
 *   → tableEngine.mjs（generateTableDataOnly / readHotMemoryForInjection）
 *   → aiRunner.mjs（runMemoryPresetAI — P1 AI / P8 联网）
 *   → p1_pipeline.mjs（runPipeline — 自驱动 P1 管线）
 *   → memoryRecall.mjs（recallMemories — 记忆召回）
 *   → ideClient.mjs（IDE 连接状态 / 工具文档 / 读缓存）
 *   → presetBridge.mjs（switchPresetViaAPI — 预设隔离）
 *   → beilu-preset/main.mjs TweakPrompt Round2 消费 extension.memory_depth_injections（R2 交叉）
 *   → backgroundTasks.mjs autoCheckArchiveTriggers 由 replyHandler 触发（R4 交叉，不在本文件）
 *
 * 【影响范围】
 *   - 写文件：_greet_state.json（每日首开）、_recall/{cid}.json（召回落盘）、
 *     _delegate_queue.json（委派轮次/超时/报告注入）、_approval_queue.json（清理）、
 *     _parallel_results_{cid}.json（标记已注入）、context_summary.json（T09异步压缩）、
 *     _output_filter_violations.json（消费后删）
 *   - 广播：无直接 WS 广播（注入数据随 prompt_struct 下发，不经 broadcast）
 *   - 定时器：无（T09 异步压缩是 fire-and-forget Promise，非 setInterval）
 *   - 副作用：修改 arg.chat_log 引用（W66 浅拷贝后压缩旧工具结果/剥 thinking/剥 XML 标签，
 *     urgent 时即时 hideMessages）；预设隔离 switchPresetViaAPI；冷却递减 presetSwitchCooldown
 *
 * 【使用效果】
 *   AI 每轮生成时能看到最新的记忆表格、热层数据、检索结果、P1自驱动结论、联网结果及委派报告，
 *   且不会因 token 超限导致截断——超限时自动压缩旧消息或触发 T09 摘要后再注入。
 *
 * 21步分四阶段：
 *   Phase 0 (S1-S6)   初始化：校验入参 → 加载记忆/预设 → 解析模式/子模式 → 预设隔离
 *   Phase 1 (S7-S10)  数据准备：code/work 附加数据 → 表格+热层 → 上下文摘要
 *   Phase 2 (S11-S12) INJ 注入循环：每日问候 → 遍历 injectionPrompts 宏替换产 depthInjections
 *   Phase 3 (S13-S18) P1检索+联网：自驱动 P1/AI P1 → 旧缓存 → 聊天搜索 → 并行委派 → 流程组 → P8
 *   Phase 4 (S19-S21) Token管理：W66 contextClean 压缩 → Token 多级提醒+urgent 清理+T09 压缩 → 输出管控
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getActivePresetName, applySubModePresetDefault, switchPresetViaAPI } from "../ai/presetBridge.mjs"; // 2026-07-08 生效模型重构：每轮强切已删（生成不碰预设状态）；applySubModePresetDefault=委派超时回切子模式时一次性应用默认预设；switchPresetViaAPI=[0717 串联收口] P1 <presetSwitch> 唯一执行口（原经 extension 穿生成链在 preset TweakPrompt 内第二份写实现，镜像删除）
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs"; // M3：央原子写替裸 fs.writeFileSync 防半写损坏
import { readJsonSafe, readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // T019：_greet_state.json损坏不静默清零，备份后抛错；0716 差集收编：委派/审批队列同切
import { V1_CONST } from "../../../../../server/web_server/v1_adapter.mjs";

import {
  DEFAULT_INJECTION_PROMPTS,
  DEFAULT_COMPACT_MERGE_INSTRUCTIONS,
  pickPresetPromptSet,
  p7HasMeaningfulPrompts,
  __pluginDir,
  __projectRoot,
  diag,
  ensureMemoryDir,
  getMemoryDir,
  getTimeMacroValues,
  getTodayStr,
  loadJsonFileIfExists,
  loadMemoryData,
  loadMemoryPresets,
  presetSwitchCooldown,
  readContextSummary,
  beginContextSummaryWrite,
  commitContextSummaryWrite,
  computeContextSummarySourceRevision,
  resolveActiveSubModeId,
  writeActiveSubModeId,
  saveJsonFile,
  setActiveMode,
  withFileLock,
  writeContextSummary,
  getYonbanConfigPath,
  updateYonbanConfig, // T4：委派超时回切子模式写点走字段级收口串行锁
  getWorkConfigPath,
  resolveWorkflowSlot,
  resolveSkillGroupDomain, // [0722 skill组隔离] 宏清单按当前组（running优先→选中组）过滤，与 replyHandler 切换域同源
  getCodeConfigPath,
  DEFAULT_TOKEN_REMINDER,
  DEFAULT_SYSTEM_TEXTS,
  modeFeature, // 0716 接线批：硬编码模式名门 → ModeDef features 声明消费
  isPathSafe, // 0716 路径前缀边界修复：收口内联 resolve().startsWith 到权威守卫
} from "../storage_mod/storage.mjs";
// inj 识别系统 2026-07-13：识别（模式链路）+门控+互斥+值域收口到注入系统单一权威
// （getDataHandler 显示链、setDataActions 写入校验同源消费）
import { resolveInjectionContext, resolveEffectiveInjections, resolveInjectionContentForLocales, isDataDrivenEntry, isDataEntry } from "../storage_mod/injectionSystem.mjs"; // [D3 0804] +locale 内容解析（INJ 正文按 user.locales 选 hash 匹配的等义覆盖）
import { resolveRequestProfile } from "../storage_mod/subModeActivation.mjs"; // D3 0804 读点收口：B18 内联 ?? 链的全系统唯一实现（嵌套优先+驼峰别名+扁平回退+冲突可见）
import { inspectInjectionCachePrefix } from "./volatileMacros.mjs";
import { resolveEffectiveP1RouteConfig } from "../p1Route.mjs";
// [0728 top-k] 召回频率写点：AI P1 真注入时记本轮读过的记忆文件（预览/P2-P8/无结果不记；
//   另一写点=replyHandler 主AI <memorySearch>）；applyLayerTopkOrder=向量初筛候选层级+热度重排
import { recordRecall, applyLayerTopkOrder } from "../storage_mod/recallStats.mjs";
// 单源收口（2026-07-13 参照 ST）：分母解析迁到 preset 内存 store 版（原 storage 文件版已删）——
// 与真生成层 mergeRuntimeParams 同一份内存数据，消除文件级第二解析器漂移（4.1k/238% 症状族）。
// 壳与实现体 ESM 同实例（plugins/beilu-preset/main.mjs re-export 本路径），getStore 单例安全。
import { resolveEffectiveMaxContextLive } from "../../prompt/preset/main.mjs";
// token 用量分子内存单源（2026-08-11 收口）：写方唯一=本文件算完 code_token_status 即存；
// 读方={{token_status}}宏(本文件,取上一轮值) + replyHandler contextClean 闸门。根治三估算器口径分裂
// （宏/闸门 chatLog字数/3.5 vs 本表注入+chatLog 全口径，IDE 流程低估 50%+ → 闸门按 37% 误拦清理）。
import { setLastTokenStatus, getLastTokenStatus } from "./tokenStatusLive.mjs";

import {
  generateTableDataOnly,
  readHotMemoryForInjection,
  tablesToPromptText,
} from "../storage_mod/tableEngine.mjs";

import {
  consumeLastP1Result,
  injectionLog,
  parsePresetSwitchTag,
  pendingChatSearchResults,
  listChatSearchSlots,
  pendingTableEditFeedback,
  pluginEnabled,
  pushMemoryAIOutput,
  resetP1TriggerFlag,
  runMemoryPresetAI,
} from "../ai/aiRunner.mjs";

import {
  formatToolResultsForInjection,
  ideClient,
  isIdeToolResultMsg,
  isIdeToolCallMsg,
  collectNoiseToHide,
  renderStaticIdeToolSignatures,
} from "../../../transport/ideClient.mjs";
import { getMcpRuntimeSnapshot } from "../../mcp/runtimeRegistry.mjs";

import {
  getDueJobsText,
  getJobsSummary,
  schedulerFeature,
} from "../../notification/scheduler.mjs";

import { countTokensSync } from "../nlp/tokenizer.mjs";
import { loadTasks, remainingCount } from "../tools/taskStore.mjs";
import { vectorPrefilter, formatVectorCandidates } from "../tools/vectorBridge.mjs"; // 0722 拍板：AI P1 前置向量初筛（未启用=恒[]零回归）
import { runP1 } from "../tools/p1Bridge.mjs"; // 0729 插件化：P1自驱动召回经桥调用（照vectorBridge范式，未启用=null零回归）
// 思维链剥离：复用 proxy 出站的同一函数（内置 <think>/<thinking> + 用户自定义 reasoning_tags），保证轮内压缩与出站同源。
import { stripReasoningTags } from "../../api/proxy/lib/messageTransform.mjs"; // T8·回切：改指 yonban 新位实现体（原经 public 薄壳 re-export，已删壳）
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
// {{chat_rename_cmd}} 宏读当前对话显示名——与 shell renameChat 写侧（chat_names）同源同 loader
import { loadShellData } from "../../../../../server/setting_loader.mjs";

// N31/P2 共用：已消费指令标签基础清单（「模型上下文」剥离语义，与 replyHandler._stripAllTags
// 的 show 显示剥离语义不同，勿跨文件统一）。W66 轮内历史清理在块内引用本常量并合并用户自定义
// （strip_tags_custom.json context_tags*）；下方剥离函数用于检索结果等注入文本的无条件清洗
// （P2：记忆AI检索结果曾把含裸指令标签的历史原文回灌模型=剥离机制未覆盖检索回路这一分支，上下文污染测试坐实）。
const _CONSUMED_TAG_NAMES_BASE = "tableEdit|memoryArchive|memorySearch|memoryNote|codeMemoryWrite|workMemoryWrite|modeSwitch|subModeSwitch|delegate|parallelDelegate|report|approval|contextClean|createFlowGroup|presetSwitch|needWebSearch|scheduleTask|captureControl|browserAction|mcpConnect|分身\\d+|UpdateVariable|JSONPatch|taskPlan|taskCheck|toggle|orbMessage|emotion|motion|fileDelivery|progress|needHelp|sendToWindow|wakeWindow|scheduleWakeup|completionVerify|stopContinue|chatRename";
/**
 * 从检索回路注入文本中剥离已消费的指令标签（「模型上下文」剥离语义）。
 * 防止 P1/聊天搜索回灌历史原文时重建裸指令标签（P2 坐实的污染面）。
 * 与 replyHandler._stripAllTags 的「show 显示」剥离语义不同——后者保留部分标签给美化正则，
 * 本函数无条件剥。不要跨文件统一这两套清单。
 *
 * @param {string} text - 待清洗文本（检索结果/搜索结果等不可信内容）
 * @returns {string} 剥离后文本
 */
function _stripConsumedTagsFromInjection(text) {
  if (!text || typeof text !== "string") return text || "";
  try {
    return text
      .replace(new RegExp(`<(${_CONSUMED_TAG_NAMES_BASE})[\\s>][\\s\\S]*?<\\/\\1>`, "g"), "")
      .replace(new RegExp(`<(${_CONSUMED_TAG_NAMES_BASE})[^>]*\\/>`, "g"), "")
      .replace(new RegExp(`<\\/(${_CONSUMED_TAG_NAMES_BASE})>`, "g"), "");
  } catch { return text; }
}

// T09 in-flight 防抖（per-chat）：T09 是 fire-and-forget 异步，摘要落盘前 contextSummaryText 恒空，
// 连续 urgent 轮会并发起多个 P7 压缩调用（重复花钱 + last-writer-wins 互相覆盖）。落盘/失败后释放。
const _t09InFlight = new Set();

async function _readCurrentT09SourceRevision(arg, chatId) {
  if (typeof arg?.Update === "function") {
    const refreshed = await arg.Update();
    if (!Array.isArray(refreshed?.chat_log)) {
      throw Object.assign(new Error("refreshed chat request has no chat_log"), { code: "E_T09_SOURCE_REVISION_UNAVAILABLE" });
    }
    return computeContextSummarySourceRevision(refreshed.chat_log);
  }
  const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
  const chatOps = await import(pathToFileURL(chatOpsPath).href);
  const length = await chatOps.GetChatLogLength(chatId);
  const current = length > 0 ? await chatOps.GetChatLog(chatId, 0, length) : [];
  return computeContextSummarySourceRevision(current.filter((entry) => entry?._hidden !== true && entry?._deleted !== true));
}

// P1 自驱动 in-flight 单飞：只能复用完全相同的“宿主四维 scope + 当前输入 + 历史归属/内容”。
// Map 保存的是纯 local P1 Promise，不保存或复用整轮 prompt；不同输入/历史即使同一窗口也各跑各的。
const _p1InFlight = new Map();

function _p1ScopeIdentity(username, charName, chatId, mode) {
  return [username, charName, chatId, mode].map((value) => String(value ?? "")).join("\0");
}

function _p1LocalRunKey(username, charName, chatId, mode, inputText, historyChatId, chatHistory) {
  return JSON.stringify({
    scope: [username, charName, chatId, mode].map((value) => String(value ?? "")),
    inputText: String(inputText ?? ""),
    historyChatId: String(historyChatId ?? ""),
    history: (Array.isArray(chatHistory) ? chatHistory : []).map((message) => ({
      role: String(message?.role ?? ""),
      content: String(message?.content ?? ""),
    })),
  });
}

function _p1FiniteMeta(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function _p1DisplayTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 10000000000) {
    const date = new Date(number);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return String(value);
}

/**
 * P1 record 的宿主消费契约。服务端已返回事件时间、文件时间/创建时间和记录级 TOP，宿主必须
 * 原样交给主 AI 注入与 AIP1 preContext；timestamp 仅保留给旧引擎兼容，不能再作为唯一时间源。
 */
function _p1RecordMetadata(record) {
  return {
    recordId: record?.recordId ?? record?.id ?? null,
    layer: record?.layer ?? null,
    sourceRel: record?.sourceRel ?? null,
    sourceType: record?.sourceType ?? null,
    eventTime: record?.eventTime ?? null,
    eventTimeSource: record?.eventTimeSource ?? null,
    fileTime: record?.fileTime ?? null,
    fileCreatedTime: record?.fileCreatedTime ?? null,
    legacyTimestamp: record?.timestamp ?? null,
    pinned: record?.pinned === true,
    top: record?.top === true,
    importance: _p1FiniteMeta(record?.importance),
    weight: _p1FiniteMeta(record?.weight),
  };
}

function _formatP1RecordMeta(record) {
  const meta = _p1RecordMetadata(record);
  const parts = [meta.layer];
  if (meta.eventTime !== null) {
    parts.push(`事件时间=${_p1DisplayTime(meta.eventTime)}${meta.eventTimeSource ? `(${meta.eventTimeSource})` : ""}`);
  }
  if (meta.fileTime !== null) parts.push(`文件时间=${_p1DisplayTime(meta.fileTime)}`);
  if (meta.fileCreatedTime !== null) parts.push(`创建时间=${_p1DisplayTime(meta.fileCreatedTime)}`);
  if (meta.eventTime === null && meta.fileTime === null && meta.fileCreatedTime === null && meta.legacyTimestamp !== null) {
    parts.push(`时间=${_p1DisplayTime(meta.legacyTimestamp)}`);
  }
  if (meta.pinned || meta.top) parts.push(meta.pinned ? "pinned/TOP" : "TOP");
  if (meta.importance !== null) parts.push(`importance=${meta.importance}`);
  if (meta.weight !== null) parts.push(`weight=${meta.weight}`);
  return parts.filter(Boolean);
}

function _p1TraceSummary(result) {
  const trace = result?.trace && typeof result.trace === "object" ? result.trace : {};
  const request = trace.request && typeof trace.request === "object" ? trace.request : {};
  const node1 = trace.node1 && typeof trace.node1 === "object" ? trace.node1 : {};
  const recall = trace.recall && typeof trace.recall === "object" ? trace.recall : {};
  const failure = trace.failure && typeof trace.failure === "object" ? trace.failure : null;
  const node1Units = Array.isArray(node1.units) ? node1.units : [];
  const node1TokenCount = node1Units.reduce((sum, unit) => sum + (Array.isArray(unit?.tokens) ? unit.tokens.length : 0), 0);
  return {
    request: {
      inputChars: request.inputChars ?? trace.transport?.inputTextChars ?? null,
      historyCount: request.historyCount ?? null,
      mode: request.mode ?? null,
      chatId: request.chatId ?? null,
      historyChatId: request.historyChatId ?? trace.transport?.historyChatId ?? null,
      historyOwnership: request.historyOwnership ?? trace.transport?.historyOwnership ?? null,
      source: request.source ?? null,
      node0UnitCount: Array.isArray(request.node0Units) ? request.node0Units.length : 0,
      queueWaitMs: request.queue?.waitMs ?? null,
      transport: trace.transport ? {
        protocol: trace.transport.protocol ?? null,
        contentType: trace.transport.contentType ?? null,
        jsonDecoded: trace.transport.jsonDecoded ?? null,
        inputTextChars: trace.transport.inputTextChars ?? null,
      } : null,
    },
    node: {
      provider: node1.provider ?? null,
      resourceStatus: node1.resources ?? null,
      unitCount: node1Units.length,
      tokenCount: node1TokenCount,
    },
    pipeline: trace.pipelineTimings ?? null,
    service: trace.serviceTimings ?? null,
    failure: failure ? {
      stage: failure.stage ?? null,
      code: failure.code ?? result?.code ?? null,
      error: failure.error ?? result?.error ?? null,
      details: failure.details ?? null,
    } : (result?.success === false ? {
      stage: null,
      code: result?.code ?? null,
      error: result?.error ?? null,
      details: null,
    } : null),
    recall: {
      totalTokens: recall.totalTokens ?? null,
      currentInputWords: Array.isArray(recall.currentInputWords) ? recall.currentInputWords.slice(0, 16) : [],
      filteredCount: recall.filteredCount ?? null,
      rawPoolCount: recall.rawPoolCount ?? null,
      scoredCount: recall.scoredCount ?? null,
      rankedCount: recall.rankedCount ?? null,
      mechanisms: Array.isArray(recall.mechanisms) ? recall.mechanisms.slice(0, 12) : [],
      node2: {
        status: recall.node2?.status ?? null,
        errors: Array.isArray(recall.node2?.errors)
          ? recall.node2.errors.slice(0, 12).map((error) => ({
            code: error?.code ?? null,
            mechanism: error?.mechanism ?? null,
          }))
          : [],
      },
      anchors: Array.isArray(recall.anchors) ? recall.anchors.slice(0, 8) : [],
      storageDiagnostics: Array.isArray(recall.storageDiagnostics) ? recall.storageDiagnostics.slice(0, 8) : [],
      recordIds: Array.isArray(result?.recalledRecords)
        ? result.recalledRecords.map((record) => record?.recordId ?? record?.id).filter(Boolean).slice(0, 10)
        : [],
    },
    runLog: result?.runLog ?? null,
  };
}

/**
 * P1 主结果成功时，runLog 的主写与后续清理可能独立失败。这里只映射公开 issue，
 * 不改写 result.success/outcome/召回数据，也不读取可能含绝对路径的 path 字段。
 */
export function getP1RunLogIssues(result) {
  const runLog = result?.runLog;
  if (runLog?.enabled !== true) return [];
  const issues = [];
  const seen = new Set();
  const addIssue = ({ severity, kind, written, stage, code, message, file }) => {
    const normalizedSeverity = severity === "warning" ? "warning" : severity === "error" ? "error" : "";
    const normalizedCode = String(code ?? "").trim();
    if (!normalizedSeverity || !normalizedCode) return;
    const normalizedMessage = String(message ?? "").trim() || "P1 run log operation failed";
    const normalizedFile = String(file ?? "").trim() || null;
    const key = `${normalizedSeverity}\0${normalizedCode}\0${normalizedMessage}\0${normalizedFile || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      component: "runLog",
      severity: normalizedSeverity,
      kind,
      written,
      stage: stage || null,
      code: normalizedCode,
      message: normalizedMessage,
      file: normalizedFile,
    });
  };
  if (runLog.written === false && String(runLog.code).startsWith("E_")) {
    addIssue({
      severity: "error",
      kind: "write",
      written: false,
      stage: "write",
      code: runLog.code,
      message: String(runLog.error ?? "").trim() || "P1 run log write failed",
      file: runLog.file,
    });
  }
  for (const [severity, bucket] of [
    ["error", runLog?.diagnostics?.errors],
    ["warning", runLog?.diagnostics?.warnings],
  ]) {
    for (const diagnostic of Array.isArray(bucket) ? bucket : []) {
      const stage = String(diagnostic?.stage ?? "diagnostic").trim() || "diagnostic";
      const exception = String(diagnostic?.exception ?? "").trim();
      addIssue({
        severity,
        kind: "diagnostic",
        written: runLog.written === true,
        stage,
        code: diagnostic?.code,
        message: String(diagnostic?.message ?? diagnostic?.error ?? "").trim()
          || `${exception ? `${exception}: ` : ""}P1 run log ${stage} failed`,
        file: diagnostic?.file ?? runLog.file,
      });
    }
  }
  return issues;
}

function _reportP1RunLogIssue(chatId, mode, issue) {
  const detail = {
    component: "runLog",
    mode,
    chatId: chatId || null,
    severity: issue.severity,
    kind: issue.kind,
    written: issue.written,
    stage: issue.stage,
    code: issue.code,
    message: issue.message,
    file: issue.file,
  };
  wbD(chatId, "runLog", `p1:${detail.severity}`, false, detail.message, detail);
  // server monitor 捕获分级 console 记录；runLog 旁路 issue 不抛错、不改变召回成功结果。
  if (detail.severity === "warning") {
    console.warn(`[P1-runLog] warning: ${detail.code}: ${detail.message}`, detail);
  } else {
    console.error(`[P1-runLog] error: ${detail.code}: ${detail.message}`, detail);
  }
}

function _reportLocalP1Failure(chatId, mode, scopeKey, failure, traceSummary) {
  const detail = {
    mode,
    chatId: chatId || null,
    code: failure?.code || traceSummary?.failure?.code || "E_P1_LOCAL_FAILURE",
    error: failure?.error || traceSummary?.failure?.error || "local P1 failed",
    scope: scopeKey,
    continuation: "none",
    trace: traceSummary,
  };
  wbD(chatId, "getprompt", "p1:localFailure", false, detail.error, detail);
  // server monitor 已拦截 console.error 并计入错误缓冲；这里不抛错、不走 broadcastBotError，
  // 自驱动与 AI P1 互斥；本地失败不会暗中切到另一条路，用户能在既有监控面板发现故障。
  console.error(
    `[P1-selfDriven] local P1 failed; continuing without a P1 result: ${detail.code}: ${detail.error}`,
    detail,
  );
}

/**
 * 每轮对话前的记忆/数据注入主函数（21步管线）。
 *
 * 链路：requestBuilder.getChatRequest() → 遍历各插件 GetPrompt → 本函数
 *       → 返回 text[] + depthInjections[] → beilu-preset TweakPrompt Round2 按 depth/order 分配到
 *         above/below 区域 → commanderAssembly 五段拼装 → provider StructCall → API
 * 影响：
 *   - 修改 arg.chat_log（W66 浅拷贝后压缩/剥离，urgent 时 hideMessages 可逆隐藏）
 *   - 写 _greet_state / _recall / _delegate_queue / context_summary 等文件
 *   - P1/P8 阻塞式 AI 调用（500ms-数秒）
 * 约束：arg.chat_log 必须是数组引用；isFakeSend=true 时跳过 P1/P8/搜索注入/委派计数
 *
 * @param {object} arg - beilu 框架传入：{ username, char_id, chat_log[], chatid, isFakeSend, Charname, UserCharname, ... }
 * @returns {Promise<{text: Array<{content:string, important:number}>, additional_chat_log: [], extension: object}|null>}
 *   extension 核心字段：memory_depth_injections（depthInjections 数组，每项 {id, role, content, depth, order, macro?}）、
 *   sub_mode_*（子模式参数覆盖）、active_mode、code_token_status（[0717 串联收口] preset_switch_to 已删：P1 切换直走 switchPresetViaAPI 权威口，不再经 extension 穿生成链）
 */
export async function handleGetPrompt(arg) {
  if (!pluginEnabled) return null;

  // ═══════════════════════════════════════════════════════════════
  // Phase 0 (S1-S6): 初始化 — 校验入参 → 加载记忆/预设 → 解析模式/子模式 → 预设隔离
  // ═══════════════════════════════════════════════════════════════
  const username = arg?.username;
  const charName = arg?.char_id;
  if (!username || !charName) { wbD(null, "memory", "getPrompt:missingUserOrChar", false, "username/char_id 缺失，GetPrompt 早退不注入", { hasUser: !!username, hasChar: !!charName }); return null; }

  resetP1TriggerFlag(username, charName);

  const _cid = arg?.chatid || (arg?.chat_name ? arg.chat_name.replace("common_chat_", "") : null);
  wbT(_cid, "memory", "getPrompt:enter", { user: username, char: charName, isFakeSend: arg?.isFakeSend });

  try {
    // per-chatId：注入主链的表格/config 必须与下方 _activeMode（resolveInjectionContext 单源裁决产物）同一模式。
    // 旧代码不传 _cid → data 用全局模式表格，而 _activeMode 走 per-chatId，多窗口下注入错模式表格。
    const data = loadMemoryData(username, charName, undefined, _cid);
    diag.log(`GetPrompt 入口: user=${username} char=${charName} isFakeSend=${arg?.isFakeSend}`);
    diag.debug(`web_search配置:`, JSON.stringify(data.config?.web_search || "UNDEFINED"));
    if (!data.config?.enabled && data.config?.enabled !== undefined)
      return null;

    const userName = arg?.UserCharname || username;
    const displayCharName = arg?.Charname || charName;

    const presetsData = loadMemoryPresets(username, charName);
    wbT(_cid, "preset", "load:done", { presetCount: Array.isArray(presetsData?.presets) ? presetsData.presets.length : 0, hasInjPrompts: !!presetsData.injection_prompts });
    wbD(_cid, "preset", "load:injPromptsMissing", !!presetsData.injection_prompts, "预设无 injection_prompts，降级到 DEFAULT_INJECTION_PROMPTS 内置默认", {});
    const injectionPrompts =
      presetsData.injection_prompts ||
      structuredClone(DEFAULT_INJECTION_PROMPTS);
    diag.debug(`injection_prompts: ${injectionPrompts.length}条 [${injectionPrompts.map(p => `${p.id}(${p.enabled?'on':'off'})`).join(', ')}]`);

    // 任务A：编程模式附加数据
    // inj 识别系统 2026-07-13：模式链路（bot平台派生→arg.mode契约槽→N38 per-chat绑定链）收口
    //   injectionSystem.resolveInjectionContext——识别不再散在调用方（原三级解析内联于此+getDataHandler
    //   各持一份），生成链/显示链同一识别实现。链路语义原样（见该模块注释），零行为变化。
    const _injCtx = resolveInjectionContext({ arg, username, charName, chatId: _cid });
    let _activeMode = _injCtx.activeMode;

    // ★ 预设生效模型（2026-07-08 凛倾定调；[0716 凛倾定案] 模式级「绑定」概念整体删除）：
    //   「正在使用的预设」=运行时状态（active_preset_map[cid:mode]，无记录回退全局 active_preset），
    //   人和 AI 的切换动作直接改它；子模式的 presetName 默认值由切换动作
    //   （setActiveSubMode / flowGroup 推进 / AI subModeSwitch）一次性应用。
    //   生成时【不做任何强切】——原 T046 每轮强切=把默认值做成锁：用户切换 15s 内被盖回、
    //   AI <presetSwitch>/流水线推进下一轮即被拽回=「AI 切换功能被绑定堵死，进程推进不了」
    //   （凛倾 07-08 原话）。生成只读「正在使用的预设」，切换的归切换动作。

    // 子模式数据读取
    let _subModeLabel = "";
    let _subModeDesc = "";
    // 当前身份的专用契约+硬权限只作为运行数据注入 depth:0；统一行为规则留在历史前 INJ-2-code。
    // JSON 是数据而不是代码内嵌提示词，且与 replyHandler 的 undefined=允许 / false=拒绝语义完全一致。
    let _subModeToolPermissionsJson = ""; // [0804] 原 _subModeContractJson：contract 字段全链删除，仅保留硬权限镜像
    let _subModeModel = "";
    let _subModeApiSource = "";
    let _subModeClaudePrefill = "";
    let _subModeMaxContext = 0;
    let _subModeMaxTokens = 0;
    let _subModeTemperature = -1;
    let _subModeTopP = -1; // T001：top_p 与 temperature 同构提取（哨兵-1=未设，top_p 合法域 0..1）
    // 链路2扩展（2026-07-10 凛倾「用户可以掌控全部参数」）：top_k/min_p 照 T001 同构接入子模式覆盖链
    //   （提取→:2213 区 extension 下发→preset mergeRuntimeParams 覆盖块）。runtime 层键已存在
    //   （RUNTIME_PARAMS_DEFAULTS top_k/min_p），此前子模式层无提取=表单加行会成假控件，故三层同补。
    //   哨兵-1=未设（top_k 合法域 0..500，min_p 0..1，0 均为合法显式值不能当哨兵）。
    let _subModeTopK = -1;
    let _subModeMinP = -1;
    let _subModePostProcess = "";
    // 确诊-B（prefill 每轮读收口）：prefillEnabled 是 boolean，false 为有效意图，故用 undefined 哨兵=无覆盖
    //   （对齐 sub_mode_temperature 的 !== undefined 判定，非 truthy），使编辑活跃子模式的 prefill 当轮生效
    //   （不再仅切换时经 subModePanel:333 推 runtime 才生效）。
    let _subModePrefillEnabled = undefined;
    // D3 0804：fallbackPolicy/fallbackSource 随 profile 下发（消费方 char-template submode_source_override
    //   失败分支：fail_closed=可见未发送错误 / explicit_fallback=先试 fallbackSource 再默认源）。
    let _subModeFallbackPolicy = "";
    let _subModeFallbackSource = "";
    // thinking 子模式/流程组覆盖口已删（2026-08-01 凛倾「把子模式的思考模式删除」）：
    //   思维链控制收口到 AI 源面板 per-源单点（settingsSlots→config→httpFetch），本链不再提取/下发。
    try {
      const _smConfigPath = getYonbanConfigPath(username);
      const _smConfig = loadJsonFileIfExists(_smConfigPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
      // [D3 0804 批2·冻结消费] requestBuilder 备料时刻已冻结本请求子模式快照
      //   （extension.activation.sub_mode：subModeId/revision/requestProfile，与 mode/preset_name 同一激活语义）。
      //   优先消费冻结值：①激活线选择用冻结 subModeId——切换期在飞请求不随磁盘中途漂移（D3 极端链路
      //   「并发两窗切换期在飞请求用冻结快照」）；②request profile 用冻结副本——参数中途保存不撕裂本轮组装。
      //   门槛=modeGroup 与 chatId 双匹配（快照跨请求错用防御）；不经 requestBuilder 咽喉的入口（bot 壳等）
      //   无快照=回退每轮磁盘解析（与 runtime_params_snapshot 同款多入口诚实回退，非吞错）。
      //   label/desc/权限 JSON 仍读 live 定义（冻结的是「哪个子模式生效+参数」，不是定义正文）。
      const _frozenAct = arg?.extension?.activation?.sub_mode;
      const _useFrozen = !!(_frozenAct && _frozenAct.modeGroup === _activeMode
        && String(_frozenAct.chatId || "") === String(_cid || ""));
      const _activeSubModeId = _useFrozen ? _frozenAct.subModeId : resolveActiveSubModeId(_smConfig, _activeMode, _cid);
      let _activeSM = null;
      if (_activeSubModeId && Array.isArray(_smConfig.sub_modes)) {
        _activeSM = _smConfig.sub_modes.find(m => m.id === _activeSubModeId);
        if (_activeSM) {
          _subModeLabel = _activeSM.label || _activeSubModeId;
          _subModeDesc = _activeSM.desc || "";
          // [0804 契约字段删除] 原 sub_mode_contract_json 同时承载 contract（第二描述通道，删）与
          //   toolPermissions（后端硬门 replyHandler 的模型可见镜像，保留）。现只产权限 JSON：
          //   与 replyHandler 实际工具过滤同三字段同语义（false=拒绝，undefined/true=允许）。
          _subModeToolPermissionsJson = JSON.stringify({
            id: _activeSM.id,
            label: _subModeLabel,
            toolPermissions: {
              codeEdit: _activeSM.allowCodeEdit !== false,
              runCommand: _activeSM.allowRunCommand !== false,
              delete: _activeSM.allowDelete !== false,
            },
          });
          // B18 读点收口（D3 0804）：原内联 ?? 链（嵌套 model_params 副本权威+驼峰别名容忍+扁平回退+
          //   哨兵 -1/0/undefined）整块迁入 storage_mod/subModeActivation.resolveRequestProfile——
          //   全系统唯一实现，语义逐字段等价（写门 normalizeSubModeForSave 同表 _PROFILE_FIELD_PAIRS 单源）。
          //   此处只映射回既有 _subMode* 变量：下游（跨组原子清零 N36 / flowGroup 快照回退 / extension 下发）零改动。
          const _smProfile = (_useFrozen && _frozenAct.requestProfile) ? _frozenAct.requestProfile : resolveRequestProfile(_activeSM);
          _subModeModel = _smProfile.modelName;
          _subModeApiSource = _smProfile.apiSourceName;
          _subModeClaudePrefill = _smProfile.claudeMode;
          _subModeMaxContext = _smProfile.sampling.maxContext;
          _subModeMaxTokens = _smProfile.sampling.maxTokens;
          _subModeTemperature = _smProfile.sampling.temperature;
          _subModeTopP = _smProfile.sampling.topP;
          _subModeTopK = _smProfile.sampling.topK;
          _subModeMinP = _smProfile.sampling.minP;
          _subModePostProcess = _smProfile.promptPostProcessing;
          _subModePrefillEnabled = _smProfile.prefillEnabled;
          _subModeFallbackPolicy = _smProfile.fallbackPolicy;
          _subModeFallbackSource = _smProfile.fallbackSourceName;
          if (_smProfile.conflicts.length > 0) {
            // 迁移契约：flat/nested 真冲突不静默挑选——读侧维持嵌套优先（与改前行为一致）+ 可见留痕
            wbD(_cid, "memory", "getPrompt:subModeProfileConflict", false, `子模式 ${_activeSM.id} flat/nested 参数冲突（读侧嵌套优先）: ${_smProfile.conflicts.join(", ")}`, { conflicts: _smProfile.conflicts });
          }
        }
      }
      // ★ #26（A1 阶段2 per-request 化）：模式驱动的 API 源不再 SetData 改角色全局绑定
      // （全局写点会让两个窗口的不同模式互相抢源）。子模式源经 extension.sub_mode_api_source
      // 每轮随 prompt 下发，char 模板按请求加载 _effSource（锚点 submode_source_override），
      // 角色绑定的默认 AIsource 全程不动。
      // 归属判定（保留原语义）：仅当前主模式组的子模式覆盖才生效，跨组/chat 不带覆盖。
      // N36（分派单_子模式归属判定只判定源不判定模型）：源+模型+全套参数是**原子覆盖单元**——
      // 原来只清 apiSource，model/参数漏判照样进 extension → proxy 层 model_override 打在绑定源上
      // = 「A 源 URL + B 源模型」混合请求（runtime 铁证：chat 全智能窗实发上游 API 503）。
      // 跨组时整组清掉，禁止退回单字段判定。
      if (_activeSM && (_activeSM.modeGroup || "code") !== _activeMode) {
        _subModeApiSource = "";
        _subModeModel = "";
        _subModeClaudePrefill = "";
        _subModeMaxContext = 0;
        _subModeMaxTokens = 0;
        _subModeTemperature = -1;
        _subModeTopP = -1; // T001：跨组原子清零同组
        _subModeTopK = -1; // 链路2扩展：跨组原子清零同组
        _subModeMinP = -1; // 链路2扩展：跨组原子清零同组
        _subModePostProcess = "";
        _subModePrefillEnabled = undefined; // 确诊-B：跨组原子清零（undefined=无覆盖，回退 runtime/预设基线）
        _subModeFallbackPolicy = ""; // D3：fallback 是源覆盖的附属策略，源覆盖清零则同清（原子单元同 N36）
        _subModeFallbackSource = "";
      }
      // 注意：此处禁止按"绑定值撞子模式源名"做任何 SetData 自愈——用户合法绑定与历史残留
      // 同名无法区分，曾导致绑定被洗空后随机换真实计费源（2026-06-12 洗源 bug，N19 删除）。
    } catch (_smErr) {
      wbD(_cid, "memory", "getPrompt:readSubMode", false, _smErr.message, {});
      console.warn("[beilu-memory] GetPrompt: 读取子模式失败:", _smErr.message);
    }
    // 流程组源/模型快照回退（凛倾 2026-07-15「不需要AI决定api」链路的消费端）：
    //   work 模式下有 running 流程组、且上方子模式覆盖整组为空（含跨组被原子清零后）→ 启用
    //   createFlowGroup 建组时复制的源/模型快照（组级 api_source/model_params，生产端 replyHandler）。
    //   原子单元同 N36：源或模型任一已由子模式覆盖则完全不用快照，禁逐字段混合。
    //   填的是同一组 _subMode* 变量 → 下游零新分支：extension.sub_mode_*（:2158 区）→
    //   preset mergeRuntimeParams 子模式覆盖块 → char 模板 submode_source_override（含 N36 撤销闸）。
    //   用户手建组无 api_source/model_params 字段、AI 组快照为空（跟随全局）→ 此处不启用，行为与现状一致。
    if (!arg.isFakeSend && modeFeature(_activeMode, "flowGroup").enabled && !_subModeApiSource && !_subModeModel) { // 0716 接线：flowGroup 快照消费跟声明（code 声明 enabled 但无 running workflow=行为不变）
      try {
        const _fgsConfigPath = getWorkConfigPath(username, charName);
        if (fs.existsSync(_fgsConfigPath)) {
          const { slot: _fgsSlot } = resolveWorkflowSlot(loadJsonFileIfExists(_fgsConfigPath, {}), _cid);
          if (_fgsSlot?.active_workflow && _fgsSlot.workflow_state?.status === "running") {
            const _fgsWfPath = path.join(getMemoryDir(username, charName), "work", "workflows", _fgsSlot.active_workflow);
            if (fs.existsSync(_fgsWfPath)) {
              const _fgsWf = JSON.parse(await fs.promises.readFile(_fgsWfPath, "utf-8"));
              const _fgsMp = (_fgsWf.model_params && typeof _fgsWf.model_params === "object") ? _fgsWf.model_params : null;
              const _fgsSrc = _fgsWf.api_source || (_fgsMp ? ((_fgsMp.api_source ?? _fgsMp.apiSource) || "") : "");
              if (_fgsMp || _fgsSrc) {
                // 源+模型=原子对整组取快照（启用门已保证二者此刻均空，N36 无杂交）；
                // 其余参数=快照有键才覆盖、无键保留子模式层已解析值——子模式可只配参数不配源
                //   （002 实况：任务设计/流程优化/提示词设计仅显式 prefillEnabled=false），
                //   整组盖缺省会把这些显式意图洗掉。
                _subModeApiSource = _fgsSrc;
                if (_fgsMp) {
                  _subModeModel = (_fgsMp.model ?? _fgsMp.modelName) || "";
                  const _fgsPf = _fgsMp.claude_prefill_mode ?? _fgsMp.claudePrefillMode;
                  if (_fgsPf) _subModeClaudePrefill = _fgsPf;
                  const _fgsMc = _fgsMp.max_context ?? _fgsMp.maxContext;
                  if (_fgsMc) _subModeMaxContext = _fgsMc;
                  const _fgsMt = _fgsMp.max_tokens ?? _fgsMp.maxTokens;
                  if (_fgsMt) _subModeMaxTokens = _fgsMt;
                  if (_fgsMp.temperature !== undefined && _fgsMp.temperature !== null) _subModeTemperature = _fgsMp.temperature;
                  if (_fgsMp.top_p !== undefined && _fgsMp.top_p !== null) _subModeTopP = _fgsMp.top_p;
                  if (_fgsMp.top_k !== undefined && _fgsMp.top_k !== null) _subModeTopK = _fgsMp.top_k;
                  if (_fgsMp.min_p !== undefined && _fgsMp.min_p !== null) _subModeMinP = _fgsMp.min_p;
                  const _fgsPP = _fgsMp.prompt_post_processing ?? _fgsMp.promptPostProcessing;
                  if (_fgsPP) _subModePostProcess = _fgsPP;
                  const _fgsPfEn = _fgsMp.prefill_enabled ?? _fgsMp.prefillEnabled;
                  if (_fgsPfEn !== undefined) _subModePrefillEnabled = _fgsPfEn;
                  // thinking 快照转发已删（2026-08-01 收口到 AI 源面板，见上方声明处注释）
                }
                wbT(_cid, "memory", "getPrompt:flowGroupModelSnap", { workflow: _fgsSlot.active_workflow, source: _fgsSrc, model: _subModeModel });
              }
            }
          }
        }
      } catch (_fgsErr) {
        wbD(_cid, "memory", "getPrompt:flowGroupModelSnap", false, _fgsErr.message, {});
      }
    }
    // ═══════════════════════════════════════════════════════════════
    // Phase 1 (S7-S10): 数据准备 — code/work 附加数据 → 表格+热层 → 上下文摘要
    // ═══════════════════════════════════════════════════════════════
    let _activeProject = "";
    let _codeActiveFiles = "";
    let _envInfo = "";
    if (modeFeature(_activeMode, "memory").config.codeProjectEnv === true) { // 0716 接线：项目env注入跟声明
      try {
        const _memDir = ensureMemoryDir(username, charName);
        const _codeConfigPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点
        if (fs.existsSync(_codeConfigPath)) {
          const _cc = loadJsonFileIfExists(_codeConfigPath, {});
          _activeProject = _cc.active_project || "";
        }
        const _activeDir = path.join(_memDir, "code", "active");
        if (fs.existsSync(_activeDir)) {
          const _mdFiles = fs
            .readdirSync(_activeDir)
            .filter((f) => f.endsWith(".md"));
          _codeActiveFiles =
            _mdFiles.length > 0 ? _mdFiles.join("\n") : "";
        }
      } catch (e) {
        wbD(_cid, "memory", "getPrompt:readCodeMem", false, e.message, {});
        console.warn("[beilu-memory] GetPrompt: 读取编程记忆数据失败:", e.message);
      }
      const _platform = typeof process !== "undefined" ? process.platform : "unknown";
      const _timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
      const _today = new Date().toLocaleDateString("en-US", {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
      });
      const _nodeVer = typeof process !== "undefined" ? process.version : "unknown";
      const _envParts = [
        `Working directory: ${__projectRoot}`,
        `Platform: ${_platform}`,
        `Node: ${_nodeVer}`,
        `Today's date: ${_today}`,
        `Timezone: ${_timezone}`,
      ];
      if (_activeProject) _envParts.push(`Active project: ${_activeProject}`);
      _envInfo = `<env>\n  ${_envParts.join("\n  ")}\n</env>`;
    }

    // 【热层不进主 AI】20260726 凛倾裁决：「热层只注入到 P1，不注入到主 AI」。
    //   原此处按 ModeDef features.memory.config.hotLayerDir/hotLayerStyle 读 <mode>/active/*.md，
    //   拼成 _codeHotLayerText / _workHotLayerText，再由下方 CODE_HOT_LAYER / WORK_HOT_LAYER
    //   直接 depthInjections.push 塞进主 AI（system、order=-50 排最前、上限 4 万字符、无开关、
    //   绕过 :1171 铁律靠 _pendingConvert 豁免名单放行）——与「主 AI 隔离热层」的设计正相反，整段删除。
    //   热层数据的读取通道归 P1（aiRunner 侧宏），主 AI 侧两个宏保留但恒替换为空串（见下方 replace 链），
    //   以免用户预设里已写的 {{codeHotLayer}}/{{workHotLayer}} 漏出字面量。
    const _codeHotLayerText = "";
    const _workHotLayerText = "";
    // 说明书库域已删（凛倾 0723「说明书库可以删除,和inj重复」）：原 F2 索引构建（skills/*.md 扫描
    //   → _skillsListText → SKILLS_INDEX 注入）整段删除；{{skill:}}/{{skills_list}} 宏转入下方
    //   退役宏占位清理链（替空串防字面漏出）。用户数据 memory/skills/*.md 留盘不动。

    // per-layer token budget（_config.injection.*_token_budget）：null/0/缺省=不限。
    // 按 token/char 比例一次性估算截断，超预算的层在注入前裁剪，防单层挤爆上下文。
    const _injBudget = data.config?.injection || {};
    const _applyTokenBudget = (text, budget) => {
      if (!text || !budget || budget <= 0) return text;
      const _tk = countTokensSync(text);
      if (_tk <= budget) return text;
      const _keep = Math.max(0, Math.floor(text.length * (budget / _tk)) - 20);
      wbD(_cid, "getprompt", "tokenBudget:truncate", false, "单层超 token 预算，注入前裁剪", { tk: _tk, budget, origLen: text.length, keep: _keep });
      return text.slice(0, _keep) + "\n…[超 token 预算已截断]";
    };

    let tableDataText = generateTableDataOnly(data.tables, displayCharName, userName);
    tableDataText = _applyTokenBudget(tableDataText, _injBudget.tables_token_budget);

    // F3 任务打勾教学（§1.4 / G2）：code/work 模式默认开，进度 = AI 制定任务清单然后逐项打勾，
    // 不再用「切换模式表达进度」。≥3 步任务才建清单（参照 KILO TodoWrite 门槛）。
    // 单一权威 = work_ctx/tasks.json（不进表格 / 不进 chat log），任务卡前端常驻显示「剩余 N 项」。
    if (modeFeature(_activeMode, "teaching").config.taskPlanHowto === true) { // 0716 接线：任务打勾教学跟声明
      const _taskPlanHowto = data.config?.system_texts?.task_plan_howto;
      tableDataText += typeof _taskPlanHowto === "string"
        ? _taskPlanHowto
        : DEFAULT_SYSTEM_TEXTS.task_plan_howto;
      // B9 回读（§五.2 默认=用户全量可改+AI 下轮感知）：把当前清单状态注回 AI——
      // 用户在任务卡上勾/改/删后，AI 下一轮从这里看到最新状态，不再按自己旧记忆走。
      try {
        const _taskStore = loadTasks(username, charName, _activeMode, _cid);
        if (Array.isArray(_taskStore?.tasks) && _taskStore.tasks.length > 0) {
          const _mark = { completed: "[x]", in_progress: "[~]" };
          tableDataText += [
            "",
            `[当前任务清单状态]（rev ${_taskStore.rev}，剩余 ${remainingCount(_taskStore)} 项；用户可能已手动修改，以下为最新权威）`,
            ..._taskStore.tasks.map((t) => `${_mark[t.status] || "[ ]"} ${t.content}${t.priority === "high" ? "（高优）" : ""}`),
          ].join("\n");
        }
      } catch (_tsErr) {
        diag.warn(`任务清单回读失败（不影响注入主流程）: ${_tsErr.message}`);
      }
    }
    // ★ 表格缓存：INJ-1-*-data整体通过_injDepth提升到depth=2（断点上方，API缓存区）
    // 不再单独注入tableData_split，避免重复

    // R5：主对话真注入 → recordHit 刷新被命中 forever 条目的 last_triggered（接通悬空强化回路）。
    //   仅此主对话路径记命中；P系列(aiRunner) / 预览(previewMemoryPreset/InjectionPrompt) 不传 = 不污染命中。
    let hotMemoryText = readHotMemoryForInjection(username, charName, { recordHit: true, foreverTopK: data.config?.injection?.forever_top_k });
    if (hotMemoryText) {
      hotMemoryText = hotMemoryText
        .replace(/\{\{char\}\}/g, displayCharName)
        .replace(/\{\{user\}\}/g, userName);
    }
    hotMemoryText = _applyTokenBudget(hotMemoryText, _injBudget.hot_memory_token_budget);

    // Phase 3D: 读取已保存的上下文压缩摘要
    let contextSummaryText = "";
    const savedSummary = readContextSummary(username, charName, _cid);
    if (savedSummary?.summary) {
      contextSummaryText = savedSummary.summary;
    }

    const textEntries = [];
    const depthInjections = [];

    // T6-S3: 每日首开问候（仅 chat/airp/smart 陪伴系模式；work/code/ide 是工作 agent，不谈陪伴）。
    // smart（全智能）=底部功能层「chat基于airp进行优化」陪伴系增强，随 smart 升独立模式值（凛倾0706）放行。
    // 当日首次 GetPrompt → 注入「自然问候并续接」指令 + 连续天数 streak；频控写当日，同日多端不重复。
    // 话术/最近话题语义=提示词侧（预设 {{lastTopic}} 占位），后端只给信号+续接占位，不报数不打卡。
    if (_cid && modeFeature(_activeMode, "teaching").config.dailyGreeting === true) { // 0716 接线：问候跟声明（airp 非模式 id 值域从不出现=原分支为死值；bot.json 已修正 false 对齐现状）
      try {
        const _gPath = path.join(getMemoryDir(username, charName), "_greet_state.json");
        const _today = new Date().toISOString().slice(0, 10);
        // T019：损坏→备份.corrupt.bak后抛错（外层_gErr catch承接），不当空顶上→:584写回清掉streak。
        const _gState = (await readJsonSafe(_gPath, {})) || {};
        if (_gState.lastGreetDate !== _today) {
          const _yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
          const _streak = (_gState.lastGreetDate === _yesterday) ? (Number(_gState.streak) || 0) + 1 : 1;
          // 文案单源=DEFAULT_SYSTEM_TEXTS.daily_greeting（config.system_texts 可覆盖）；XML 包裹=注入结构留代码
          const _greetText = data.config?.system_texts?.daily_greeting || DEFAULT_SYSTEM_TEXTS.daily_greeting;
          depthInjections.push({
            id: "DAILY_GREETING", role: "user",
            content: `<daily_greeting streak="${_streak}">${_greetText}</daily_greeting>`,
            depth: 0, order: 0,
          });
          try { fs.mkdirSync(path.dirname(_gPath), { recursive: true }); nicerWriteFileSync(_gPath, JSON.stringify({ lastGreetDate: _today, streak: _streak, lastTopic: _gState.lastTopic || "" })); } catch { /* 写频控失败下轮重试 */ }
        }
      } catch (_gErr) { console.warn("[getPrompt] 每日问候状态读写失败（不影响主流程）:", _gErr.message); /* T019：损坏等错误留痕可诊断，不再全静默 */ }
    }

    let _p1ResultText = ""; // P1输出文本，供P8联网判断用
    let _presetSwitchTarget = null;
    let _presetSwitchExecuted = false;

    const _cooldownKey = `${username}/${charName}`;
    const _cooldownConfig = data.config?.preset_switch?.cooldown_rounds ?? 5;

    // ═══════════════════════════════════════════════════════════════
    // Phase 2 (S12): INJ 注入循环 — 遍历 injectionPrompts，按 autoMode 门控启用，
    // 宏替换（约 30 种 {{macro}}），产 depthInjections[] + textEntries[]。
    // 宏替换后标记 macro:true → beilu-preset TweakPrompt Round2 对 macro:true 的注入
    // 再求一次引擎宏（如 {{workspace_tree}}），其余纯数据注入不二次求宏（BUG-3 修复）。
    // ═══════════════════════════════════════════════════════════════

    // 门控+互斥统一裁决（inj 识别系统 2026-07-13）：整段判定收口 injectionSystem.resolveEffectiveInjections
    //   ——模式域注册表驱动（原硬编码枚举缺 smart=凛倾0706拍板4模式之一在此全灭、airp 永假死值），
    //   互斥规则（INJ-2 vs INJ-2-code 变体对）原样保留在该模块（凛倾「inj2 的互斥不要改」）。
    //   getDataHandler 显示链、setDataActions 写入校验消费同一模块=前后端同一份裁决，无镜像重算。
    const _ideConnected = _injCtx.ideConnected;
    wbT(_cid, "getprompt", "macro:loopEnter", { injCount: injectionPrompts.length, mode: _activeMode, ideConnected: _ideConnected });
    const _injGate = resolveEffectiveInjections(injectionPrompts, _injCtx);

    // 历史前缓存区的宏契约由 volatileMacros.mjs 的稳定 allowlist 统一识别。
    // 凛倾 0810 定案：契约只提醒不强制——注入一律按用户配置的 depth/role 原样执行，
    // 系统禁止在用户不知情时改写位置/角色（此前的强制降级 depth:0/user 已删）。
    // 检测结果仍写入 extension.cache_safety_adjustments + 白盒诊断作为提醒面：
    // 含动态宏且位于缓存前缀区（depth>=1 或 system 抽顶）时可能破坏缓存命中（0729 事故同型），
    // 由用户自行知情决策；前端 INJ 面板徽标/横幅为同源提醒。
    const _cacheSafetyAdjustments = [];
    const _cacheSafePlacementByEntry = new WeakMap();
    const _effectiveCacheSafePlacement = (entry) => {
      if (_cacheSafePlacementByEntry.has(entry)) return _cacheSafePlacementByEntry.get(entry);
      // 能走到这里的条目本轮一定会注入；一次性注入允许 enabled=false 条目临时生效，
      // 因此检测显式按 enabled=true 计算，不被持久化开关绕过。
      const placement = inspectInjectionCachePrefix({ ...entry, enabled: true });
      _cacheSafePlacementByEntry.set(entry, placement);
      const { requestedDepth, effectiveDepth, requestedRole, effectiveRole, unsafeMacros } = placement;
      if (effectiveDepth !== requestedDepth || effectiveRole !== requestedRole) {
        const adjustment = {
          id: String(entry?.id || ""),
          requestedDepth,
          effectiveDepth,
          requestedRole,
          effectiveRole,
          unsafeMacros,
        };
        _cacheSafetyAdjustments.push(adjustment);
        wbD(
          _cid,
          "getprompt",
          "cachePrefix:unsafeMacroNotice",
          false,
          `提醒: 动态 INJ 位于缓存前缀区，按用户配置原样注入（未改写）: ${adjustment.id}`,
          adjustment,
        );
        diag.warn(`缓存提醒(未改写): ${adjustment.id} depth=${requestedDepth}, role=${requestedRole}; 动态宏=${unsafeMacros.join(",")} 可能破坏缓存前缀命中`);
      }
      return placement;
    };

    // {{tool_runtime_json}} 每轮只求值一次（跨条目共享）：forPrompt 快照带单次投递副作用
    // （终态 job 标记已投递，listForPrompt），同轮第二次求值会拿到已被第一次消费掉的空反馈。
    let _toolRuntimeJsonMemo = null;

    for (const [_injIdx, inj] of injectionPrompts.entries()) {
      const _gate = _injGate[_injIdx];
      if (!_gate.on) {
        // T-5 收口(2026-06-17)语义保留：未知/拼错 autoMode 拒注入且留痕，不静默"全模式开"
        if (_gate.reason === "unknown_automode") {
          wbD(_cid, "getprompt", "macro:unknownAutoMode", false, `未知 autoMode "${inj.autoMode}"，门控拒该注入`, { inj: inj.id, autoMode: inj.autoMode });
          diag.warn(`getPromptHandler: 未知 autoMode "${inj.autoMode}" (inj=${inj.id})，门控拒该注入`);
        }
        continue;
      }

      // [0722 硬编码注入收口] 数据生产点驱动条目由 _pushDataInj 按需注入（模板在配置=前端 INJ 面板
      //   可改，代码只供数据宏值），主循环跳过防止未展开的 {{数据宏}} 原样进提示词。
      //   判据单源=injectionSystem.isDataDrivenEntry（0722 审计 J1-B：四机制判据收口，勿在此内联字段判断）。
      if (isDataDrivenEntry(inj)) continue;

      // [D3 0804 locale] 条目正文按用户语言解析（injectionSystem 单源）：zh 用户零 IO 快路径原文直返；
      //   外语用户仅当差量文件 zh_sha256 与条目当前 content 精确匹配才覆盖（用户改写/翻译过期=退原文，
      //   「翻译=删减」通道被 hash 闸死）。宏替换在解析结果上照跑（翻译文本保留 {{宏}} 占位，等义门禁
      //   由 inj_locale_check.mjs 写入侧把关）。传导链：user.locales → requestBuilder:68 → arg.locales。
      let content = resolveInjectionContentForLocales(inj, arg?.locales);
      let lastUserMsg = "";
      if (arg?.chat_log && Array.isArray(arg.chat_log)) {
        for (let i = arg.chat_log.length - 1; i >= 0; i--) {
          if (arg.chat_log[i].role === "user") {
            lastUserMsg = arg.chat_log[i].content || "";
            break;
          }
        }
      }

      const _tmINJ = getTimeMacroValues(arg?.chat_log);
      content = content
        .replace(/\{\{tableData\}\}/g, tableDataText)
        .replace(/\{\{hotMemory\}\}/g, hotMemoryText || "")
        .replace(/\{\{char\}\}/g, displayCharName)
        .replace(/\{\{user\}\}/g, userName)
        .replace(/\{\{lastUserMessage\}\}/g, lastUserMsg)
        .replace(/\{\{current_date\}\}/g, getTodayStr())
        .replace(
          /\{\{chat_history\}\}/g,
          (() => {
            if (!arg?.chat_log || !Array.isArray(arg.chat_log)) return "";
            const _rc = data.config?.retrieval || {};
            const count = _rc[`chat_history_count_${_activeMode}`] || _rc.chat_history_count || 5;
            return arg.chat_log
              .slice(-count)
              .map((m) => {
                const role = m.role === "user" ? userName : displayCharName;
                return `${role}: ${m.content || ""}`;
              })
              .join("\n\n");
          })(),
        )
        .replace(/\{\{time\}\}/g, _tmINJ.time)
        .replace(/\{\{currentTime\}\}/g, `${_tmINJ.date} ${_tmINJ.weekday} ${_tmINJ.time}`)
        .replace(/\{\{date\}\}/g, _tmINJ.date)
        .replace(/\{\{weekday\}\}/g, _tmINJ.weekday)
        .replace(/\{\{idle_duration\}\}/g, _tmINJ.idle_duration)
        .replace(/\{\{lasttime\}\}/g, _tmINJ.lasttime)
        .replace(/\{\{lastdate\}\}/g, _tmINJ.lastdate)
        .replace(/\{\{contextSummary\}\}/g, contextSummaryText || "")
        .replace(/\{\{current_mode\}\}/g, _activeMode)
        .replace(/\{\{sub_mode\}\}/g, _subModeLabel)
        .replace(/\{\{sub_mode_desc\}\}/g, _subModeDesc)
        .replace(/\{\{sub_mode_tool_permissions_json\}\}/g, _subModeToolPermissionsJson)
        // [0804 兼容读] 旧宏名保留替换：存量/用户自定义条目仍写 {{sub_mode_contract_json}} 时
        //   注入权限 JSON（contract 字段已不产出），不让裸宏字面量漏进 prompt；条目文案迁移由
        //   storage v4 条件迁移完成后此别名自然无消费。
        .replace(/\{\{sub_mode_contract_json\}\}/g, _subModeToolPermissionsJson)
        .replace(/\{\{active_project\}\}/g, _activeProject)
        .replace(/\{\{code_active_files\}\}/g, _codeActiveFiles)
        .replace(/\{\{env_info\}\}/g, _envInfo)
        .replace(/\{\{codeHotLayer\}\}/g, _codeHotLayerText || "")
        .replace(/\{\{workHotLayer\}\}/g, _workHotLayerText || "")
        .replace(/\{\{scheduler_jobs_summary\}\}/g, () => {
          // 宏可用性跟 features.scheduler 库开关粒度（0702 散点清单 §D 裁决），零硬编码模式名
          if (!schedulerFeature(_activeMode).enabled) return "";
          return getJobsSummary(username, charName);
        })
        // 动态文件引用宏
        .replace(/\{\{code_file:([^}]+)\}\}/g, (_match, _filename) => {
          if (!modeFeature(_activeMode, "ide").enabled) return "(仅编程模式可用)"; // 0716 接线：code 宏跟 features.ide（0702 §D 裁决）
          try {
            const _memDir = ensureMemoryDir(username, charName);
            const _filePath = path.join(_memDir, "code", "active", _filename.trim());
            if (!isPathSafe(_filePath, path.resolve(path.join(_memDir, "code")))) return "(路径越界)"; // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
            if (fs.existsSync(_filePath)) return fs.readFileSync(_filePath, "utf-8");
            return `(文件 ${_filename.trim()} 不存在)`;
          } catch (e) {
            return `(读取失败: ${e.message})`;
          }
        })
        .replace(/\{\{code_files_list\}\}/g, () => {
          if (!modeFeature(_activeMode, "ide").enabled) return "(仅编程模式可用)"; // 0716 接线：同上
          try {
            const _memDir = ensureMemoryDir(username, charName);
            const _activeDir = path.join(_memDir, "code", "active");
            if (!fs.existsSync(_activeDir)) return "(目录不存在)";
            const _entries = fs.readdirSync(_activeDir, { withFileTypes: true });
            if (_entries.length === 0) return "(空目录)";
            return _entries.map((_e) => {
              const _icon = _e.isDirectory() ? "📁" : "📄";
              return `${_icon} ${_e.name}`;
            }).join("\n");
          } catch (e) {
            return `(读取目录失败: ${e.message})`;
          }
        })
        // 浏览器状态数据宏（0723 凛倾「修 禁止硬编码」：0722 拆出 INJ-browser-status-data 条目时
        //   只建了条目没建 producer 的半接线在此补全）：producer=beilu-browser 插件连接态变化写
        //   data/browser-status.json（CWD 锚，同其 config 落盘范式），此处 consumer 只读盘透传——
        //   值域（connected/disconnected/端口号）由 producer 持有，代码不产生任何文案；
        //   缺文件/读失败=空串诚实降级（插件未装/从未启动≠断开，不发明状态值）。
        .replace(/\{\{browser_(status|port)\}\}/g, (_m, _bk) => {
          try {
            const _bs = JSON.parse(fs.readFileSync("data/browser-status.json", "utf-8"));
            return String((_bk === "status" ? _bs.status : _bs.port) ?? "");
          } catch { return ""; }
        })
        // 退役宏占位清理（0723 凛倾「说明书库可以删除,和inj重复」）：{{skill:名}}/{{skills_list}}
        //   原展开角色卡 memory/skills/*.md 正文/索引（0716 接线），说明书库整域删除后转退役——
        //   提示词内容唯一权威=INJ 条目正文本身。替空串防存量条目字面漏出（同 ide_tools 范式）。
        .replace(/\{\{skill:([^}]+)\}\}/g, "")
        .replace(/\{\{skills_list\}\}/g, "")
        // {{ide_tools}} 只展开 canonical IDE_TOOLS 的稳定签名：无连接态/用户/工作区/运行值，允许
        // 放在 depth>=1 历史前缓存区。执行规则仍由 INJ-2-code 可编辑，运行态只走 depth:0。
        .replace(/\{\{ide_tools\}\}/g, renderStaticIdeToolSignatures())
        .replace(/\{\{ide_dual_inject\}\}/g, "")
        // 退役宏占位清理（0716 MCP 链路走查判定：刻意不接）：原 W61 实现双断——扫代码库插件目录
        // （MCP 插件实际装在用户 data/users/<u>/plugins/，永扫不到）+读 data.json 不存在的 tools 字段。
        // MCP 工具清单的真路径=各 mcp_ 插件 Template GetPrompt 每轮 listTools 活数据（断连即消失，
        // 优于静态快照）。接此宏=stale 双通道。全数据源零引用；替空防用户手写字面原样漏出。
        .replace(/\{\{mcp_tools\}\}/g, "")
        // forPrompt=单次投递视图（0731 缓存归零修复）：终态 job 只进一次提示词；活跃 job 持续可见。
        // 本宏唯一合法住所=历史下方 depth:0 数据条目（INJ-1-write-code-data）——写进 depth>=1 条目
        // 会让每轮变的展开值坐进缓存前缀区，从该处起全部 messages 缓存连坐失效（0722/0731 两次确诊）。
        .replace(/\{\{tool_runtime_json\}\}/g, () => (_toolRuntimeJsonMemo ??= JSON.stringify(ideClient.getRuntimeSnapshot(_cid, username, { forPrompt: true }))))
        .replace(/\{\{mcp_runtime_json\}\}/g, () => JSON.stringify(getMcpRuntimeSnapshot(username)))
        .replace(/\{\{env_tools\}\}/g, () => {
          if (!modeFeature(_activeMode, "ide").enabled) return ""; // 0716 接线：同上
          try {
            const _etPath1 = path.join(ensureMemoryDir(username, charName), "code", "_env_tools.json");
            const _etPath2 = path.join(ensureMemoryDir(username, "_global"), "code", "_env_tools.json");
            const _etPath = fs.existsSync(_etPath1) ? _etPath1 : (fs.existsSync(_etPath2) ? _etPath2 : null);
            if (!_etPath) {
              // 无 _env_tools.json 时自动扫 workspace root 的 package.json
              const _wsRoot = ideClient.workspaceRootFor(_cid);
              if (_wsRoot) {
                const _autoPkg = path.join(_wsRoot, "package.json");
                if (fs.existsSync(_autoPkg)) {
                  try {
                    const _pk = JSON.parse(fs.readFileSync(_autoPkg, "utf-8"));
                    const _deps = { ..._pk.dependencies, ..._pk.devDependencies };
                    const _ns = Object.keys(_deps);
                    if (_ns.length > 0) {
                      const _projName = _pk.name || path.basename(_wsRoot);
                      return `[${_projName} 依赖]\n` + _ns.map(n => `- ${n} ${(_deps[n] || "").replace(/^\^|~/, "")}`).join("\n");
                    }
                  } catch { /* 解析失败静默 */ }
                }
              }
              return "";
            }
            const _etc = JSON.parse(fs.readFileSync(_etPath, "utf-8"));
            const _parts = [];
            const _descs = Object.entries(_etc.descriptions || {}).filter(([k, v]) => k && v);
            if (_descs.length > 0) _parts.push("[项目工具说明]\n" + _descs.map(([n, d]) => `- ${n}: ${d}`).join("\n") + "\n[/项目工具说明]");
            if (Array.isArray(_etc.scan_dirs)) {
              for (const _sd of _etc.scan_dirs) {
                const _dp = typeof _sd === "string" ? _sd : _sd.path;
                const _lb = typeof _sd === "string" ? path.basename(_sd) : (_sd.label || path.basename(_sd.path));
                const _pp = path.join(_dp, "package.json");
                if (fs.existsSync(_pp)) {
                  const _pk = JSON.parse(fs.readFileSync(_pp, "utf-8"));
                  const _deps = { ..._pk.dependencies, ..._pk.devDependencies };
                  const _ns = Object.keys(_deps);
                  if (_ns.length > 0) _parts.push(`[${_lb}]\n` + _ns.map(n => `- ${n} ${(_deps[n] || "").replace(/^\^|~/, "")}`).join("\n"));
                }
              }
            }
            return _parts.join("\n\n");
          } catch { return ""; }
        })
        // 退役宏占位清理（0716 链路走查判定：刻意不接）：IDE 工具结果的真路径=generation.mjs
        // consumePendingResults→真消息进对话尾部（易变区）。接此宏=同一数据双通道（双写病）
        // +巨块每轮变进预设区（打缓存）。全数据源（模板/用户副本）零引用；替空防用户手写字面原样漏出。
        .replace(/\{\{ide_tool_results\}\}/g, "")
        .replace(/\{\{memory_path\}\}/g, () => {
          try {
            return ensureMemoryDir(username, charName);
          } catch { return "(路径获取失败)"; }
        })
        .replace(/\{\{client_env\}\}/g, () => ideClient.clientEnvFor(_cid))
        .replace(/\{\{ide_workspace\}\}/g, () => {
          let _wsRoot = "";
          if (ideClient.isConnectedFor(_cid)) {
            const info = ideClient.ideInfoFor(_cid);
            // 2026-07-09 收口审计：只读 status 嵌套单一真值位（ideClient status case 已改并入嵌套，
            //   顶层 workspaceFolders 形状不再产生，旧 fallback=读残留旧值风险）
            const folders = info?.status?.workspaceFolders || [];
            if (folders.length === 0) return "(IDE未打开文件夹)";
            _wsRoot = folders[0];
          } else {
            _wsRoot = ideClient.workspaceRootFor(_cid);
          }
          if (!_wsRoot) return "(未设置工作区)";
          // 紧凑目录树（2层，限3000字符）—— 省 AI 开局 list_files
          let _tree = _wsRoot + "\n";
          try {
            const _MAX = 3000;
            const _entries = fs.readdirSync(_wsRoot, { withFileTypes: true });
            const _dirs = _entries.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").sort((a, b) => a.name.localeCompare(b.name));
            const _files = _entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
            for (const d of _dirs) {
              _tree += `  ${d.name}/\n`;
              if (_tree.length > _MAX) { _tree += "  ...(已截断)\n"; break; }
              try {
                const _sub = fs.readdirSync(path.join(_wsRoot, d.name), { withFileTypes: true });
                const _subDirs = _sub.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").sort((a, b) => a.name.localeCompare(b.name));
                const _subFiles = _sub.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
                for (const sd of _subDirs) { _tree += `    ${sd.name}/\n`; if (_tree.length > _MAX) break; }
                for (const sf of _subFiles) { _tree += `    ${sf.name}\n`; if (_tree.length > _MAX) break; }
              } catch { /* 无权限或不可读 */ }
            }
            if (_tree.length <= _MAX) {
              for (const f of _files) { _tree += `  ${f.name}\n`; if (_tree.length > _MAX) break; }
            }
          } catch { /* 目录不可读，只返回根路径 */ }
          return _tree.trimEnd();
        })
        .replace(/\{\{ide_read_cache\}\}/g, () => {
          if (!ideClient.isConnectedFor(_cid)) return "";
          const _items = [];
          if (arg?.chat_log?.length > 0) {
            for (let _ci = 0; _ci < arg.chat_log.length; _ci++) {
              const _cm = arg.chat_log[_ci];
              if (!_cm.content || _cm.role !== "system") continue;
              if (!_cm.content.includes("[IDE工具执行结果]") && !_cm.content.includes("[分身AI执行结果")) continue;
              if (_cm.content.startsWith("[已压缩") || _cm.content === "[已清理的工具结果]") continue;
              // 时间
              const _tsMatch = _cm.content.match(/\((\d{4}-\d{2}-\d{2}T[\d:]+)/);
              const _time = _tsMatch ? _tsMatch[1].replace("T", " ").substring(5, 16) : "";
              // 分身结果
              if (_cm.content.includes("[分身AI执行结果")) {
                const _clCount = (_cm.content.match(/--- 分身任务#/g) || []).length;
                _items.push(`#${_ci} ${_time} 分身结果×${_clCount} (${_cm.content.length}字)`);
                continue;
              }
              // 解析每个工具块: --- tool_name (timestamp) ---
              const _blockRe = /--- (\w+)\s*\(([^)]*)\)\s*---/g;
              let _bm;
              while ((_bm = _blockRe.exec(_cm.content)) !== null) {
                const _tool = _bm[1];
                const _ts = _bm[2].replace("T", " ").substring(5, 16);
                // 提取块内容（到下一个 --- 或 [/IDE 为止）
                const _blockStart = _bm.index + _bm[0].length;
                const _nextBlock = _cm.content.indexOf("\n--- ", _blockStart);
                const _endMark = _cm.content.indexOf("\n[/IDE", _blockStart);
                const _blockEnd = _nextBlock > 0 ? _nextBlock : (_endMark > 0 ? _endMark : _cm.content.length);
                const _blockContent = _cm.content.substring(_blockStart, _blockEnd);
                const _blockLen = _blockContent.length;
                // 从块内容中提取路径（JSON格式: "path": "xxx" 或 "pattern": "xxx"）
                let _preview = "";
                const _pathM = _blockContent.match(/"path":\s*"([^"]*)"/);
                const _patternM = !_pathM ? _blockContent.match(/"pattern":\s*"([^"]*)"/): null;
                if (_pathM) {
                  const _p = _pathM[1].replace(/\\\\/g, "\\");
                  _preview = _p.length > 50 ? "..." + _p.slice(-47) : _p;
                } else if (_patternM) {
                  _preview = "搜索:" + _patternM[1].substring(0, 30);
                } else {
                  // 取第一行非空内容
                  const _firstLine = _blockContent.trim().split("\n").find(l => l.trim() && l.trim() !== "{" && l.trim() !== "}");
                  _preview = (_firstLine || "").trim().substring(0, 50);
                }
                _items.push(`#${_ci} ${_ts} ${_tool} ${_preview} (${_blockLen}字)`);
              }
            }
          }
          if (_items.length === 0) return "(无工具结果)";
          return _items.join("\n") + "\n清理指令: <contextClean>msg:序号</contextClean> 删指定消息 | msg:5,8,12 多条 | msg:5-12 范围 | tool_results:all 全清 | read_file:路径 按路径清（默认=可逆隐藏，可恢复）| 加 purge: 前缀=一次性物理删除不可逆（如 purge:read_file:路径），仅内容永久无用时用";
        })
        // ---- 分身AI宏 ----
        .replace(/\{\{clone_list\}\}/g, () => {
          try {
            const _clCfgPath = getYonbanConfigPath(username);
            const _clCfg = loadJsonFileIfExists(_clCfgPath, { clones: [] });
            const _enabledClones = (_clCfg.clones || []).filter(c => c.enabled);
            if (_enabledClones.length === 0) return "(无可用分身)";
            // 只用第一个启用的分身（数字只是任务编号，不是分身ID）
            const c = _enabledClones[0];
            const perms = [];
            if (c.permissions?.read_file) perms.push("读文件");
            if (c.permissions?.run_command) perms.push("运行脚本");
            if (c.permissions?.write_md) perms.push("写MD");
            if (c.permissions?.write_code) perms.push("写代码");
            return `分身: ${c.label}${c.modelName ? " (" + c.modelName + ")" : ""} — ${perms.join("/")}\n调用方式: <分身N clone="分身名">指令</分身N>（N=任务编号，clone指定用哪个分身，省略用默认；多任务并行）`;
          } catch (_e) { return "(无可用分身)"; }
        })
        // {{clone_configs}}：主AI看到【全部】启用分身的完整配置（非 {{clone_list}} 只第一个+4权限）。
        // 机制只读全量配置；何时/在哪个预设引用此宏由凛倾提示词侧决定。
        .replace(/\{\{clone_configs\}\}/g, () => {
          try {
            const _ccPath = getYonbanConfigPath(username);
            const _ccCfg = loadJsonFileIfExists(_ccPath, { clones: [] });
            const _ccEnabled = (_ccCfg.clones || []).filter(c => c.enabled);
            if (_ccEnabled.length === 0) return "(无可用分身)";
            const _lines = _ccEnabled.map((c, i) => {
              const _perms = [];
              if (c.permissions?.read_file) _perms.push("读文件");
              if (c.permissions?.run_command) _perms.push("运行脚本");
              if (c.permissions?.write_md) _perms.push("写MD");
              if (c.permissions?.write_code) _perms.push("写代码");
              const _smDesc = (_ccCfg.sub_modes || []).find(sm => sm.presetName === c.presetName)?.desc || c.desc || "";
              const _meta = [
                _smDesc ? `职能:${_smDesc}` : "",
                `模型:${c.modelName || "默认"}`,
                `源:${c.apiSource || "默认"}`,
                `预设:${c.presetName || "无(顶空白)"}`,
                `权限:[${_perms.join("/") || "仅只读"}]`,
                c.maxRounds ? `最多${c.maxRounds}轮` : "",
                c.contextMessages ? `上下文${c.contextMessages}条` : "",
                c.promptPostProcessing ? `后处理:${c.promptPostProcessing}` : "",
              ].filter(Boolean);
              return `分身${i + 1}「${c.label || "未命名"}」— ${_meta.join(" | ")}`;
            });
            return _lines.join("\n") + `\n调用方式: <分身N clone="分身名">指令</分身N>（N=任务编号，clone属性指定用哪个分身配置，省略则用第一个启用的；多个任务并行执行）`;
          } catch (_e) { return "(无可用分身)"; }
        })
        // {{clone_runtime}}：多个分身一起干活的【运行态/协作上下文】——最近一轮分身/并行委派的"谁·状态·产出摘要"，
        // 让主AI看到多分身协作态(非 {{clone_configs}} 静态配置)。数据=replyHandler 聚合处落的会话级快照 work/_clone_runtime_<cid>.json。
        .replace(/\{\{clone_runtime\}\}/g, () => {
          try {
            const _crDir = getMemoryDir(username, charName);
            const _crSession = _cid ? path.join(_crDir, "work", `_clone_runtime_${_cid}.json`) : "";
            const _crLegacy = path.join(_crDir, "work", "_clone_runtime.json");
            const _crPath = (_crSession && fs.existsSync(_crSession)) ? _crSession : _crLegacy;
            if (!fs.existsSync(_crPath)) return "(本会话暂无多分身协作运行态)";
            const _crData = JSON.parse(fs.readFileSync(_crPath, "utf-8"));
            const _crClones = _crData?.clones || [];
            if (_crClones.length === 0) return "(本会话暂无多分身协作运行态)";
            const _crKind = _crData.kind === "parallel" ? "并行委派" : "分身";
            const _crAge = _crData.ts ? Math.round((Date.now() - new Date(_crData.ts).getTime()) / 60000) : null;
            const _crAgeStr = _crAge == null ? "" : _crAge < 1 ? "（刚刚）" : _crAge < 60 ? `（${_crAge}分钟前）` : `（${Math.round(_crAge / 60)}小时前）`;
            const _crLines = _crClones.map((c, i) => {
              // [0726 五修#4] running=异步派发时写的"在跑"态（replyHandler 异步分支派发即写快照，完成时聚合覆盖）
              const _st = c.status === "running" ? "🔄在跑" : c.status === "error" ? "❌失败" : c.resumable ? "⏸中断" : "✅完成";
              const _meta = [c.rounds ? `${c.rounds}轮` : "", c.tools ? `${c.tools}次工具` : ""].filter(Boolean).join("/");
              return `${i + 1}. 「${c.label || "未命名"}」${_st}${_meta ? " (" + _meta + ")" : ""}: ${(c.summary || "(无输出)").replace(/\s+/g, " ").trim()}`;
            });
            return `[多个分身一起干活 — 最近一轮${_crKind}协作 ${_crClones.length}个${_crAgeStr}]\n` + _crLines.join("\n");
          } catch { return "(分身协作运行态加载失败)"; }
        })
        // ---- 子模式全量列表宏 ----
        .replace(/\{\{sub_modes_all\}\}/g, () => {
          try {
            const _smaPath = getYonbanConfigPath(username);
            const _smaCfg = loadJsonFileIfExists(_smaPath, { sub_modes: [] });
            const _smaAll = (_smaCfg.sub_modes || []).filter(m => m.enabled !== false);
            if (_smaAll.length === 0) return "(无可用子模式)";
            // [0722 skill组隔离] 全量宏也按各 modeGroup 当前组过滤（域单源 resolveSkillGroupDomain）——
            //   本宏尾部教 <subModeSwitch>，教的清单必须与 replyHandler 门放行域一致
            const _smaCDom = resolveSkillGroupDomain(username, charName, _cid, "code");
            const _smaWDom = resolveSkillGroupDomain(username, charName, _cid, "work");
            const _smaCode = _smaAll.filter(m => (m.modeGroup || "code") === "code" && (!_smaCDom || _smaCDom.modeIds.includes(m.id)));
            const _smaWork = _smaAll.filter(m => m.modeGroup === "work" && (!_smaWDom || _smaWDom.modeIds.includes(m.id)));
            const _fmt = m => `- ${m.id}: ${m.icon || ""} ${m.label}${m.desc ? " — " + m.desc : ""}`;
            let _out = "";
            if (_smaCode.length) _out += "[编程模式子模式]\n" + _smaCode.map(_fmt).join("\n");
            if (_smaWork.length) _out += (_out ? "\n" : "") + "[工作模式子模式]\n" + _smaWork.map(_fmt).join("\n");
            const _curId = resolveActiveSubModeId(_smaCfg, _activeMode, _cid);
            const _curSm = _smaAll.find(m => m.id === _curId);
            _out += `\n\n当前活跃: ${_curId}${_curSm ? " (" + (_curSm.icon || "") + " " + _curSm.label + ")" : ""}\n切换指令: <subModeSwitch>子模式ID</subModeSwitch>`;
            return _out;
          } catch { return "(子模式列表加载失败)"; }
        })
        // ---- 对话改名指令宏（凛倾 0709：ai也可以用指令改对话文件名字）----
        // 用户把宏放进预设才出现（代码只持有默认说明文本=用户可配置铁律同口径，
        // 与 {{sub_modes}}/{{context_status}} 尾部指令说明同范式）。执行侧 replyHandler <chatRename> 6c 块。
        .replace(/\{\{chat_rename_cmd\}\}/g, () => {
          const _crDoc = "改名指令: <chatRename>新名字</chatRename>（只改列表显示名，不改对话文件名，≤100字）";
          try {
            // chat_names 与 renameChat 写侧同源（shell setting_loader，sync 读）；无 _cid（无会话归属回合）只出指令说明
            const _crNames = _cid ? loadShellData(username, "chat", "chat_names") : null;
            const _crName = _crNames ? (_crNames[_cid] || "") : "";
            return `当前对话显示名: ${_crName || "(未命名)"}\n${_crDoc}`;
          } catch { return _crDoc; }
        })
        // ---- Token状态宏 ----
        .replace(/\{\{token_status\}\}/g, () => {
          const _chatLog = arg?.chat_log;
          if (!_chatLog || !Array.isArray(_chatLog) || _chatLog.length === 0) return "";
          const _msgCount = _chatLog.length;
          // ★ 分子同口径收口（2026-08-11）：优先上一轮 code_token_status.used（注入+chatLog 全口径，
          //   tokenStatusLive 内存单源，误差=一轮增量）；首轮/重启后无值回退 chatLog 字数粗估。
          //   原恒用粗估在注入占大头的 IDE 流程低估 50%+（AI 见 37% 而进度条 90%，下方清理引导全不触发）。
          const _liveTs = getLastTokenStatus(username, _cid);
          const _totalChars = _chatLog.reduce((_s, _m) => _s + (_m.content || "").length, 0);
          const _estTokens = _liveTs?.used || Math.round(_totalChars / 3.5);
          const _tknCfg = data.config?.token_reminder || {};
          // ★ 根病1 单源：token 占用率分母 = 三层生效 max_context（子模式▸runtime▸预设base▸200000），
          //   与前端进度条 _effective_max_context / 真生成层同口径（resolveEffectiveMaxContextLive 内存单源），
          //   不再 _subModeMaxContext||code_token_limit||200000 异源（缺陷2：无子模式时 AI 分母≠进度条分母）。
          const _tknLimit = resolveEffectiveMaxContextLive(username, _activeMode, _cid, getActivePresetName(username, _cid, _activeMode), charName);
          const _pct = Math.round((_estTokens / _tknLimit) * 100);
          const _usedK = Math.round(_estTokens / 1000);
          const _limitK = Math.round(_tknLimit / 1000);
          let _st = `${_msgCount}条消息 ~${_usedK}k/${_limitK}k tokens (${_pct}%)`;
          if (_pct >= 85) {
            _st += `\n🔴 紧急！立即清理: <contextClean>msg:1-${Math.max(1, _msgCount - 10)}</contextClean> 保留最近10条`;
          } else if (_pct >= 70) {
            _st += `\n🟡 建议清理旧对话: <contextClean>msg:1-${Math.max(1, _msgCount - 15)}</contextClean>`;
          } else if (_pct >= 50) {
            _st += "\n💡 可清理不再需要的工具结果: <contextClean>tool_results:all</contextClean>";
          }
          return _st;
        })
        // ---- 工作模式专属宏 ----
        .replace(/\{\{work_tables_schema\}\}/g, () => {
          if (_activeMode !== "work") return "";
          // F4-3/④读侧补全: 用顶部已 load 的 data.tables（work 模式=work_ctx/<chatId> 权威），不再直读 root 绕缓存
          const _tables = data.tables || [];
          if (!_tables.length) return "(暂无表格)";
          return _tables.map((t, i) =>
            `W${i}「${t.name}」列: [${(t.columns || []).join(", ")}]`
          ).join("\n");
        })
        .replace(/\{\{work_tables_data\}\}/g, () => {
          if (_activeMode !== "work") return "";
          // F4-3/④读侧补全: 同上用 data.tables（不再直读 root）
          const _tables = data.tables || [];
          if (!_tables.length) return "(暂无数据)";
          return _tables.map((t, i) => {
            if (!t.rows || t.rows.length === 0) return `W${i}「${t.name}」: (空)`;
            const header = (t.columns || []).join(" | ");
            const rows = t.rows.map(r => (Array.isArray(r) ? r : Object.values(r)).join(" | ")).join("\n");
            return `W${i}「${t.name}」\n${header}\n${rows}`;
          }).join("\n\n");
        })
        .replace(/\{\{work_sub_modes_list\}\}/g, () => {
          if (_activeMode !== "work") return "";
          try {
            const _smPath = getYonbanConfigPath(username);
            const _smCfg = loadJsonFileIfExists(_smPath, { sub_modes: [] });
            // [0722 skill组隔离] 宏清单按当前组过滤（无选中组=全量），与 AI 切换域同源——
            //   AI 只被告知组内可切项，教的与门放的一致（教全量+门拦截=AI 照教必败）。
            const _wDom = resolveSkillGroupDomain(username, charName, _cid, "work");
            const workModes = (_smCfg.sub_modes || []).filter(sm => sm.modeGroup === "work" && (!_wDom || _wDom.modeIds.includes(sm.id)));
            if (workModes.length === 0) return "(暂无工作子模式)";
            return workModes.map(sm => `- ${sm.id}: ${sm.label} — ${sm.desc || ""}`).join("\n");
          } catch { return "(读取失败)"; }
        })
        // N33-B: code 子模式宏（镜像上方 work 宏）——根治 INJ-2-code 硬编码列表漂移（教学名/id 与
        // resolveSubMode 精确匹配对不上=AI 照教必败）。modeGroup 缺省按 "code"（与归属判定 :192 同口径），
        // 未配 modeGroup 的老数据不会降级成空列表（N18-B 的依赖序顾虑由此化解）。
        .replace(/\{\{code_sub_modes_list\}\}/g, () => {
          if (_activeMode !== "code") return "";
          try {
            const _smPath = getYonbanConfigPath(username);
            const _smCfg = loadJsonFileIfExists(_smPath, { sub_modes: [] });
            // [0722 skill组隔离] 同 work 宏：按当前组过滤，与 AI 切换域同源
            const _cDom = resolveSkillGroupDomain(username, charName, _cid, "code");
            const codeModes = (_smCfg.sub_modes || []).filter(sm => (sm.modeGroup || "code") === "code" && (!_cDom || _cDom.modeIds.includes(sm.id)));
            if (codeModes.length === 0) return "(暂无编程子模式)";
            return codeModes.map(sm => `- ${sm.id}: ${sm.label} — ${sm.desc || ""}`).join("\n");
          } catch { return "(读取失败)"; }
        })
        .replace(/\{\{work_tasks\}\}/g, () => {
          if (_activeMode !== "work") return "";
          // F4-3/④读侧补全: 同上用 data.tables（不再直读 root）
          const taskTable = (data.tables || [])[0];
          if (!taskTable || !taskTable.rows || taskTable.rows.length === 0) return "当前无任务";
          const active = taskTable.rows.filter(r => {
            const status = Array.isArray(r) ? r[3] : r["3"];
            return status !== "完成";
          });
          if (active.length === 0) return "当前无进行中任务";
          return active.map(r => {
            const arr = Array.isArray(r) ? r : Object.values(r);
            return `[${arr[2] || "通用"}] ${arr[0]} — ${arr[3] || "待办"}`;
          }).join("\n");
        });

      diag.debug(`${inj.id}: 宏替换后 ${content.length}字符`);
      const _placement = _effectiveCacheSafePlacement(inj); // 只检测提醒，不改写（凛倾 0810）
      depthInjections.push({
        id: inj.id,
        role: _placement.requestedRole,
        content,
        depth: _placement.requestedDepth,
        order: inj.order ?? 0,
        // BUG-3: 仅作者编写的 INJ 模板需预设引擎再求一次宏(如 {{workspace_tree}}/{{workspace_root}} 由 env 注入,
        // getPromptHandler 不持有不解析)。其余 push 站点是运行期纯数据(热层md/摘要/检索结果等),不可二次求宏。
        macro: true,
      });
      // ★ 数据类INJ不进textEntries（通过memory_data_before_last2单独注入，避免重复）
      //   判据单源=injectionSystem.isDataEntry（0722 J1-B 收口，原内联 endsWith("-data")）。
      if (!isDataEntry(inj)) {
        textEntries.push({ content, important: 5 });
      }
    }

    // !!!禁止放入提示词!!! 任何进 messages 的文本（引导句/包装标签/占位符）必须写在 injection_prompts
    //   配置条目的 content 模板里（前端 INJ 面板可改），代码只允许向 _pushDataInj 供数据宏值。
    //   直接 depthInjections.push 硬编码文本 = 会被本函数返回前的白名单拦截并 wbD 可见告警。
    //
    // [P0-D 2026-08-03] 代码直推注入的【集中框架例外声明】（任务 MD P0-D 要求6：明确、集中且可配置）：
    //   以下 4 个 id 由本文件代码直推 depthInjections、不经 injection_prompts 注册表条目，豁免依据=
    //   全部是 depth:0/user 的历史后运行数据（不进缓存前缀），且进入 messages 的文字均有可配置单源
    //   （config.system_texts 覆盖 DEFAULT_SYSTEM_TEXTS / token_reminder 配置），XML 包裹=注入结构留代码：
    //   - DAILY_GREETING（daily_greeting 文本可配）
    //   - context_summary（summary_prefix 文本可配）
    //   - TOKEN_WARNING（token_reminder 配置驱动，cleanup_hint 可配）
    //   - OUTPUT_FILTER_WARNING（output_filter 文本可配）
    //   此表就是全部例外；新增直推点禁止扩表——先建注册表条目（_pushDataInj 数据宏范式）。
    // [0722 硬编码注入收口] 数据类注入统一入口：按 id 查配置条目取模板/位置/开关，展开数据宏后入队。
    //   条目缺失（用户副本未播种/被删）→ wbD 可见告警不静默；enabled=false → 用户关闭，跳过。
    //   空标签行清理是机制不是文本：模板可选字段"标签: "在数据为空时整行剔除。
    const _pushDataInj = (injId, dataMap, { important = 5, idSuffix = "", pushText = true, cleanupEmptyLabels = false } = {}) => {
      const _entry = injectionPrompts.find((p) => p.id === injId);
      if (!_entry) {
        wbD(_cid, "getprompt", "dataInj:entryMissing", false, `数据注入条目缺失: ${injId}（用户副本未播种或已删，前端"恢复默认"可找回）`, { injId });
        return false;
      }
      // [0731 单次注入·002问"能不能使用单次注入"] 数据注入条目接入 onceIds：条目被用户关闭
      //   （enabled=false=平时不注入）但本轮 single_inject_ids 含该 id → 照常注入一次。
      //   onceIds 传导链与注入坞同源（extension.once_inject_ids → resolveInjectionContext _injCtx.onceIds），
      //   仅本轮：下轮 extension 不携带即自然失效，零清理。enabled=true 时 once 无感（本来就注入）。
      //   域边界（凛倾0726）：P1 条目不进注入坞候选列表，排队入口在 P1 面板自己的域（p1panel queueOnceInject）。
      if (_entry.enabled === false && !_injCtx.onceIds?.has(injId)) return false;
      // [D3 0804 locale] 数据类直推条目同走 locale 解析（与主循环 :911 同一单源，数据宏在解析结果上展开）
      let _text = resolveInjectionContentForLocales(_entry, arg?.locales);
      for (const [_k, _v] of Object.entries(dataMap || {})) {
        _text = _text.replaceAll(`{{${_k}}}`, String(_v ?? ""));
      }
      // 空标签行清理仅对声明了可选字段的模板开启（delegate-task）：作用于全文会误删数据体里
      //   合法的"xxx:"独行（检索结果/报告正文），故默认关闭（0722 静态走查自查项）。
      if (cleanupEmptyLabels) {
        _text = _text
          .replace(/^[^\n]{1,60}: *$\n?/gm, "")
          .replace(/^[^\n]{1,60}:\n(?=\s*(\n|$))/gm, "")
          .replace(/\n{3,}/g, "\n\n");
      }
      _text = _text.trim();
      if (!_text) return false;
      const _placement = _effectiveCacheSafePlacement(_entry); // 只检测提醒，不改写（凛倾 0810）
      depthInjections.push({
        id: idSuffix ? `${injId}${idSuffix}` : injId,
        role: _placement.requestedRole,
        content: _text,
        depth: _placement.requestedDepth,
        order: _entry.order ?? 0,
      });
      if (pushText) textEntries.push({ content: _text, important });
      return true;
    };

    // Phase 3D: 上下文摘要注入
    if (contextSummaryText) {
      // 前缀单源=DEFAULT_SYSTEM_TEXTS.summary_prefix（config.system_texts 可覆盖）
      const _sumPrefix = data.config?.system_texts?.summary_prefix || DEFAULT_SYSTEM_TEXTS.summary_prefix;
      const summaryInjContent = `${_sumPrefix}\n\n${contextSummaryText}`;
      depthInjections.push({
        id: "context_summary",
        role: "user",
        content: summaryInjContent,
        depth: 0,
        order: 85,
      });
      textEntries.push({ content: summaryInjContent, important: 8 });
    }

    // 【已删】原任务E/F：CODE_HOT_LAYER / WORK_HOT_LAYER 把 <mode>/active/*.md 全文塞进主 AI
    //   （system、depth=0、order=-50 排最前、无开关、绕过 :1171 铁律靠豁免名单放行）。
    //   凛倾 20260726 裁决「热层只注入到 P1，不注入到主 AI」→ 整条注入删除，两个 id 一并移出豁免名单。
    //   热层的读取归 P1 侧（aiRunner 宏通道）。

    // SKILLS_INDEX 注入已删（0723 说明书库域删除，见上方 F2 段说明）

    // 任务G：到期定时任务注入（授权=ModeDef features.scheduler.config.dueJobsInject，零硬编码模式名）
    if (schedulerFeature(_activeMode).dueJobsInject) {
      const _dueText = getDueJobsText(username, charName);
      if (_dueText) {
        // !!!禁止放入提示词!!! 包装文本在 INJ-scheduler-due-data 模板（前端可改），此处只供数据。
        _pushDataInj("INJ-scheduler-due-data", { scheduler_due: _dueText }, { important: 9 });
      }
    }

    // [P0-D 2026-08-03] Smart 待确认提案运行数据（历史后 data 条目；P0-A 配套）：
    //   权威=confirmationStore（per-owner 持久化 pending 记录），注入让 AI 看到"提案待用户确认"
    //   事实——防重复提案/误报已启动。chat/smart 模式 + 有会话坐标才查；无 pending 零注入。
    //   !!!禁止放入提示词!!! 包装文本在 INJ-smart-confirm-data 模板（前端可改），此处只供数据宏值。
    if ((_activeMode === "chat" || _activeMode === "smart") && _cid) {
      try {
        const _confStorePath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "confirmationStore.mjs");
        const _confStore = await import(pathToFileURL(_confStorePath).href);
        const _pendingConfs = _confStore.listConfirmations(username, _cid).filter((c) => c && c.status === "pending");
        if (_pendingConfs.length > 0) {
          const _confLines = _pendingConfs
            .map((c) => `- ${c.confirmationId} → ${c.targetMode}「${(c.taskTitle || "").slice(0, 80) || "(无标题)"}」`)
            .join("\n");
          _pushDataInj("INJ-smart-confirm-data", { smart_pending_confirmations: _confLines }, { important: 8 });
        }
      } catch (_confErr) {
        wbD(_cid, "getprompt", "smartConfirmData:fail", false, _confErr?.message || String(_confErr), {});
      }
    }

    // 任务H：委派/报告/审批结果注入 (P3)
    // 不限制 _activeMode === "work"，因为 delegate 可能跨模式（如 work→code）
    // 只要 work/_delegate_queue.json 存在活跃条目就注入
    {
      const _memDir = ensureMemoryDir(username, charName);
      const _dlgQueuePath = path.join(_memDir, "work", "_delegate_queue.json");

      try {
        // 0716 T019 差集收编：损坏 → readJsonSafe 备份 .corrupt.bak 后抛 → 本段外层 catch（委派队列读取失败）
        //   warn 承接=整段跳过（不注入不写回，防原「空表+dirty 写回=委派队列整表覆盖」）；生成主链不断。
        const _dlgQueue = await readJsonSafe(_dlgQueuePath, []);

        // H1: 活跃委派任务 → 注入给当前子模式AI（遍历全部 active，不只最新）
        const _activeDelegates = _dlgQueue.filter(d => d.status === "active");
        let _dlgQueueDirty = false;
        for (let _di = 0; _di < _activeDelegates.length; _di++) {
          const _dlg = _activeDelegates[_di];
          // !!!禁止放入提示词!!! 标签/引导文本在 INJ-delegate-task-data 模板（前端可改），此处只供数据。
          //   原 depth:1 混头部 system=缓存全 miss 主犯之一，0722 收口归尾部（凛倾"这些应该是为尾部的情况"）。
          //   汇报指令仍读 config.system_texts.delegation_report 覆盖（历史覆盖兼容），默认值单源 DEFAULT_SYSTEM_TEXTS；
          //   <report status> 标签名是协议契约（解析器按此收报告），改文案须保留标签说明。
          _pushDataInj("INJ-delegate-task-data", {
            delegate_seq: _activeDelegates.length > 1 ? ` ${_di + 1}/${_activeDelegates.length}` : "",
            delegate_from: _dlg.from,
            delegate_priority: _dlg.priority,
            delegate_source_channel: _dlg.sourceChannel || "",
            delegate_user_message: _dlg.userMessage || "",
            delegate_task: _dlg.task,
            delegate_chat_context: _dlg.chatContext || "",
            delegate_report_instruction: data.config?.system_texts?.delegation_report || DEFAULT_SYSTEM_TEXTS.delegation_report,
          }, { important: 8, idSuffix: _activeDelegates.length > 1 ? `_${_di}` : "", cleanupEmptyLabels: true });
          // 递增轮次计数 — 仅真实用户回合计数；fakeSend（预览/总结/自动重生成等）会多次调用 getPrompt，
          // 若也计数会虚增轮次导致委派提前判超时
          // H1: 外部来源（API/game_ws/bot）的 delegate 用短超时，防审批挂死
          const _isExternal = _dlg.sourceChannel && _dlg.sourceChannel !== "web" && _dlg.sourceChannel !== "";
          const _effectiveMaxRounds = (_isExternal && _dlg.maxRounds > V1_CONST.DELEGATE_EXTERNAL_MAX_ROUNDS)
            ? V1_CONST.DELEGATE_EXTERNAL_MAX_ROUNDS : _dlg.maxRounds;

          if (!arg.isFakeSend) {
            _dlg.currentRound = (_dlg.currentRound || 0) + 1;
            _dlgQueueDirty = true;
            if (_dlg.currentRound >= _effectiveMaxRounds) {
              _dlg.status = "timeout";
              _dlg.completedAt = new Date().toISOString();
              _dlg.report = `(超时: 执行了${_dlg.maxRounds}轮未完成)`;
              _dlg.reportInjected = false;
              // 超时后切回委派源模式
              try {
                const _toSmPath = getYonbanConfigPath(username);
                const _toSmCfg = loadJsonFileIfExists(_toSmPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
                const _toSourceSm = (_toSmCfg.sub_modes || []).find(s => s.id === _dlg.from);
                if (_toSourceSm) {
                  // T4 收口：write→save 走 updateYonbanConfig 串行锁
                  await updateYonbanConfig(username, (cfg) => {
                    writeActiveSubModeId(cfg, _toSourceSm.modeGroup || "code", _dlg.from, _cid);
                    return cfg;
                  }, { sub_modes: [], active_sub_mode: "前置任务专家" });
                  // 生效模型（凛倾 2026-07-08）：超时切回源子模式=一次性应用其默认预设（生成时无强切盖回）
                  try { await applySubModePresetDefault(username, _toSourceSm, _cid); } catch (e) { console.warn(`[beilu-memory] 超时回切预设应用失败: ${e.message}`); }
                  if (_toSourceSm.modeGroup && _toSourceSm.modeGroup !== _activeMode) {
                    setActiveMode(username, charName, _toSourceSm.modeGroup, _cid);
                  }
                }
              } catch (_toErr) {
                console.warn(`[beilu-memory] GetPrompt: 超时切回模式失败:`, _toErr.message);
              }
              console.log(`[beilu-memory] GetPrompt: 委派 ${_dlg.id} 超时 (${_dlg.maxRounds}轮)，已切回 ${_dlg.from}`);
            }
          }
        }
        if (_dlgQueueDirty) {
          nicerWriteFileSync(_dlgQueuePath, JSON.stringify(_dlgQueue, null, 2));
        }

        // H2: 已完成的委派报告 → 注入给委派源AI
        const _pendingReports = _dlgQueue.filter(d => d.status !== "active" && d.report && !d.reportInjected);
        if (_pendingReports.length > 0 && _activeDelegates.length === 0) {
          const _latestRpt = _pendingReports[_pendingReports.length - 1];
          // !!!禁止放入提示词!!! 模板在 INJ-delegate-report-data（前端可改），此处只供数据。原 depth:1=缓存主犯，0722归尾。
          _pushDataInj("INJ-delegate-report-data", {
            delegate_report_to: _latestRpt.to,
            delegate_report_status: _latestRpt.status,
            delegate_report_task: _latestRpt.task.slice(0, 100),
            delegate_report_body: _latestRpt.report,
          }, { important: 7 });
          _latestRpt.reportInjected = true;
          nicerWriteFileSync(_dlgQueuePath, JSON.stringify(_dlgQueue, null, 2));
        }
        // H2b: 队列清理 — 已完成+已注入且超过7天的条目自动清除
        const _now = Date.now();
        const _7days = 7 * 24 * 60 * 60 * 1000;
        const _beforeLen = _dlgQueue.length;
        const _cleanedQueue = _dlgQueue.filter(d => {
          if (d.status === "active") return true; // 保留活跃的
          if (!d.reportInjected) return true; // 保留未注入报告的
          const _completedAt = d.completedAt ? new Date(d.completedAt).getTime() : 0;
          return (_now - _completedAt) < _7days; // 7天内的保留
        });
        if (_cleanedQueue.length < _beforeLen) {
          nicerWriteFileSync(_dlgQueuePath, JSON.stringify(_cleanedQueue, null, 2));
        }
      } catch (e) {
        console.warn(`[beilu-memory] GetPrompt: 委派队列读取失败:`, e.message);
      }

      // H3: 审批结果注入
      const _aprResultPath = path.join(_memDir, "work", "_pending_results.json");
      try {
        // ★ A3：read→消费(filter approval/async)→write 整段走 per-file 串行锁，
        //   防与并发 push(后台AI/审批) 互踩——否则在「读」与「写回 remaining」之间被 push 的结果会被覆盖丢失。
        //   锁内只做读+清除已消费项；注入(depthInjections/textEntries)在锁外执行，缩短锁占用。
        let _approvalResults = [];
        let _asyncResults = [];
        await withFileLock(_aprResultPath, () => {
          // 0716 T019 差集收编：损坏 → readJsonSafeSync 备份后抛 → withFileLock 透传（锁 finally 释放）→
          //   本段外层 catch warn 承接=整段跳过（防原「空表+锁内写回 remaining=待审批结果整表覆盖」）。
          const _aprResults = readJsonSafeSync(_aprResultPath, []);
          _approvalResults = _aprResults.filter(r => r.type === "approval_result");
          _asyncResults = _aprResults.filter(r => r.type === "async_ai_result");
          if (_approvalResults.length > 0 || _asyncResults.length > 0) {
            // 一次性写回剩余（保留非这两类的条目），避免两次独立读写竞态
            const _remaining = _aprResults.filter(
              r => r.type !== "approval_result" && r.type !== "async_ai_result",
            );
            saveJsonFile(_aprResultPath, _remaining);
          }
        });

        if (_approvalResults.length > 0) {
          const _aprContent = _approvalResults.map(r =>
            `[审批结果] ${r.title}: ${r.decision}${r.comment ? ` (备注: ${r.comment})` : ""}`,
          ).join("\n");
          // !!!禁止放入提示词!!! 外层模板在 INJ-approval-results-data（前端可改）；行内"[审批结果]/备注"
          //   字段标签属数据序列化残留，已列 0722 待决清单（同 ASYNC/PARALLEL 的条目级格式）。
          _pushDataInj("INJ-approval-results-data", { approval_results: _aprContent }, { important: 8 });
          // （已注入项已在上方 withFileLock 内一次性清除）
        }

        // H3b: 异步后台AI结果注入 (P4)
        if (_asyncResults.length > 0) {
          const _asyncContent = _asyncResults.map(r =>
            `[后台AI结果: ${r.taskLabel}]\n${r.reply}`,
          ).join("\n\n");
          // !!!禁止放入提示词!!! 外层模板在 INJ-async-ai-data（前端可改）；条目级"[后台AI结果: X]"为数据序列化残留，列0722待决。
          _pushDataInj("INJ-async-ai-data", { async_ai_results: _asyncContent }, { important: 6 });
          // （已注入项已在上方 withFileLock 内一次性清除）
        }
      } catch (e) {
        console.warn(`[beilu-memory] GetPrompt: 审批/异步结果读取失败:`, e.message);
      }

      // H4: 审批队列清理 — 非pending且超过7天的条目清除
      const _aprQueuePath = path.join(_memDir, "work", "_approval_queue.json");
      try {
        let _aprQueue = [];
        try { _aprQueue = JSON.parse(await fs.promises.readFile(_aprQueuePath, "utf-8")); } catch {}
        const _aprNow = Date.now();
        const _apr7days = 7 * 24 * 60 * 60 * 1000;
        const _aprBefore = _aprQueue.length;
        const _aprCleaned = _aprQueue.filter(a => {
          if (a.status === "pending") return true;
          const _resolvedAt = a.resolvedAt ? new Date(a.resolvedAt).getTime() : 0;
          return (_aprNow - _resolvedAt) < _apr7days;
        });
        if (_aprCleaned.length < _aprBefore) {
          nicerWriteFileSync(_aprQueuePath, JSON.stringify(_aprCleaned, null, 2));
        }
      } catch {}
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 3 (S13): P1 检索 — 自驱动管线或 AI P1，最多启用一条
    // 触发条件：retrievalConfig.auto_trigger && 非 fakeSend && 最后消息是用户输入
    // 合法合同是 10/01/00；只禁止 11。历史 11→10，由 p1Route.mjs 单源收敛。
    // 产出：depthInjection id="SELF_DRIVEN_P1" 或 "P1_RETRIEVAL"，depth=0
    // ═══════════════════════════════════════════════════════════════
    {
      const retrievalConfig = data.config?.retrieval || {};
      const _lastMsg = arg?.chat_log?.[arg.chat_log?.length - 1];
      const _isUserInput = !_lastMsg || _lastMsg.role === "user";
      // T06修复: 所有模式下非用户输入都跳过P1（凛倾原话：AI读取/联网→直接进入AI，不走P1）
      const _skipP1ForAutoReply = !_isUserInput;
      // [0724→0729 P1触发接线] ModeDef features.p1 声明门（零硬编码模式名，同 L354 flowGroup 接线范式）：
      //   enabled=false 整段跳过；selfDriven 只门本地自驱动管线；aiP1 只门后续可选深查层。
      // [0724 背景] 自驱动管线曾无条件直接 import p1_pipeline → 119MB 词库 JSON 解析成数百MB
      //   模块级缓存进程永驻（0723 内存2GB案主因）→ 全模式声明 selfDriven:false 封存。
      // [0729 002拍板插件化解封] 内存由 beilu-p1-selfdriven 插件生命周期管理（Load零资源 + idle卸载
      //   + Unload清缓存），经 p1Bridge.mjs 桥调用（照 vectorBridge 范式：读盘 config 启用门 + 动态
      //   import 插件），chat 模式先行灰度（selfDriven:true），其余模式待验证后另批。
      //   双门职责：selfDriven=mode级路由（该mode要不要自驱动）；插件 enabled=用户级开关（资源就绪否）。
      //   禁绕门直接 import p1_pipeline（0724内存案教训不变，插件化是解法不是豁免）。
      const _p1Feat = modeFeature(_activeMode || "chat", "p1");
      // 用户覆盖层：yonban_config.mode_feature_overrides（写口=setDataActions
      //   saveModeFeatureOverride，前端=P1 运行面板 per-mode 互斥开关）。enabled 仍是 mode 声明门；
      //   无字段=沿用 modes json 声明值。
      //   每次 GetPrompt 同步读盘（同 :284 _smConfig 开销量级），下一轮生效无需重启；
      //   覆盖文件损坏→诚实降级回代码声明值，不阻断主链。
      let _mfOv = null;
      try {
        _mfOv = loadJsonFileIfExists(getYonbanConfigPath(username), {})
          ?.mode_feature_overrides?.[_activeMode || "chat"]?.p1 || null;
      } catch { /* 覆盖层读取失败=用代码声明值 */ }
      _p1Feat.config = resolveEffectiveP1RouteConfig(_p1Feat.config || {}, _mfOv);
      const _selfDrivenUserEnabled = _p1Feat.config.selfDriven === true;
      const _aiP1UserEnabled = _p1Feat.config.aiP1 === true;
      // 10/01 由本轮自动 P1 owner 决定注入，尾段不得用旧缓存改写结果；00 不接管，
      // 手动 P1 缓存仍可在尾段按旧合同一次性消费。
      let _p1CurrentRequestHandled = false;
      if (retrievalConfig.auto_trigger
        && _p1Feat.enabled
        && !arg.isFakeSend
        && !_skipP1ForAutoReply
        && (_selfDrivenUserEnabled || _aiP1UserEnabled)) {
        _p1CurrentRequestHandled = true;

        // ★ 10 路由走 p1Bridge/service 本地低时延召回并直注；01 路由只走原 AI P1。
        const _p1Mode = _activeMode || "chat";
        const _p1ScopeKey = _p1ScopeIdentity(username, charName, _cid, _p1Mode);
        let _hasConcreteLocalRecall = false;
        const _localP1 = {
          mode: _p1Mode,
          status: "not-run",
          outcome: null,
          directionWords: [],
          recalledRecords: [],
          legacyActCount: 0,
          legacyActs: [],
          insufficiencyReason: "self_driven_disabled",
          failure: null,
          traceSummary: null,
        };
        // ★ P1自驱动管线接回（2026-07-20 beilu → 2026-07-29 插件化改造）
        // why: P1在后台产出方向词注入主AI上下文，让主AI能想到自己想不到的跨域方向。
        // 关联链: ← p1Bridge.mjs → beilu-p1-selfdriven 插件 → p1_pipeline.mjs (runPipeline)
        //         → depthInjections (depth:1, order:100) → beilu-preset TweakPrompt Round2
        // 本地有 recalledRecords、方向词或旧 p1_act 时直接注入并结束本轮 P1。
        // 铁律: P1_SELF_LEARN在live中保持默认(on)，由管线内部根据userCtx决定是否写盘
        // [0729 插件化] selfDriven 声明门+插件enabled双门：
        //   selfDriven=false → 整段跳过零开销，由互斥的 AI P1 路由独立处理；
        //   selfDriven=true+插件enabled=false → runP1返回null并显式记录失败，不暗中切 AI P1；
        //   selfDriven=true+插件enabled=true → 经p1Bridge调用插件内runPipeline（词库由插件生命周期管理）。
        //   禁绕门直接 import p1_pipeline（0724内存案教训，0729插件化解法）。
        if (_selfDrivenUserEnabled) {
        const _p1History = (arg?.chat_log || []).slice(0, -1).map(m => ({
          role: m.role || "user", content: String(m.content ?? m.mes ?? "")
        }));
        const _p1InputText = _lastMsg?.content || _lastMsg?.mes || "";
        const _historyChatId = String(_cid ?? "");
        const _p1RunKey = _p1LocalRunKey(
          username, charName, _cid, _p1Mode, _p1InputText, _historyChatId, _p1History,
        );
        let _p1RunPromise = _p1InFlight.get(_p1RunKey);
        const _p1RunReused = !!_p1RunPromise;
        try {
          _localP1.status = _p1RunReused ? "waiting-shared-local-run" : "running";
          _localP1.insufficiencyReason = null;
          // P1 输入契约：currentUserText 单独传；chatHistory 只传当前输入之前的历史。
          // 不在调用层硬截“最后5条总消息”：Node0 按 contextMessages 选择最近 N 条 user，
          // code/work 还需最近 assistant，且无记忆文档时更早 user 可作为动态检索库。
          wbT(_cid, "getprompt", "p1:selfDrivenStart", {
            mode: _p1Mode,
            historyChatId: _historyChatId,
            historyCount: _p1History.length,
            historyUserCount: _p1History.filter(m => m.role === "user").length,
            historyIncludesCurrent: false,
            sharedLocalRun: _p1RunReused,
          });
          if (!_p1RunPromise) {
            _p1RunPromise = runP1(
              _p1InputText,
              _p1History,
              _p1Mode,
              { username, charName, chatId: _cid, historyChatId: _historyChatId }
            );
            _p1InFlight.set(_p1RunKey, _p1RunPromise);
          }
          const _p1Res = await _p1RunPromise;
          const _structuredTrace = _p1TraceSummary(_p1Res);
          _localP1.traceSummary = _structuredTrace;
          // production 不请求 whitebox=true 的完整文本；消费服务已经返回的结构化 trace，压成现有
          // wbT/wbD 可承载的有界摘要，避免把 Node0→4 全量数组复制进生成链并破坏 <1s 目标。
          wbT(_cid, "getprompt", "p1:structuredTrace", _structuredTrace);
          _localP1.outcome = _p1Res?.outcome || null;
          _localP1.legacyActCount = Array.isArray(_p1Res?.p1_act) ? _p1Res.p1_act.length : 0;
          _localP1.legacyActs = Array.isArray(_p1Res?.p1_act)
            ? _p1Res.p1_act.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 5)
            : [];
          wbT(_cid, "getprompt", "p1:selfDrivenResult", {
            success: _p1Res?.success === true,
            outcome: _p1Res?.outcome || "unknown",
            status: _p1Res?.status || null,
            code: _p1Res?.code || null,
            error: _p1Res?.error || null,
            directionCount: _p1Res?.directionWords?.length || 0,
            legacyActCount: _p1Res?.p1_act?.length || 0,
            recordCount: _p1Res?.recalledRecords?.length || 0,
            sharedLocalRun: _p1RunReused,
            runLog: _p1Res?.runLog || null,
          });
          const _runLogIssues = getP1RunLogIssues(_p1Res);
          // 同一 in-flight 结果可能被多个 GetPrompt 等待者复用；只由创建该结果的调用报告一次。
          if (_p1Res?.success === true && _runLogIssues.length > 0 && !_p1RunReused) {
            for (const _runLogIssue of _runLogIssues) {
              _reportP1RunLogIssue(_cid, _p1Mode, _runLogIssue);
            }
          }
          const _selfDrivenDirections = Array.isArray(_p1Res?.directionWords)
            ? [...new Set(_p1Res.directionWords.map((word) => String(word || "").trim()).filter(Boolean))]
            : [];
          const _selfDrivenRecords = Array.isArray(_p1Res?.recalledRecords)
            ? _p1Res.recalledRecords.filter((record) => String(record?.content || "").trim())
            : [];
          _localP1.directionWords = _selfDrivenDirections;
          _localP1.recalledRecords = _selfDrivenRecords;
          if (_p1Res?.success !== true) {
            _localP1.status = "failure";
            _localP1.failure = {
              code: _p1Res?.code || null,
              error: _p1Res?.error || "local P1 returned unsuccessful result",
            };
            _localP1.insufficiencyReason = `local_failure:${_localP1.failure.code || "unknown"}`;
          } else if (_selfDrivenRecords.length > 0) {
            _hasConcreteLocalRecall = true;
            _localP1.status = "concrete-recall";
            _localP1.insufficiencyReason = null;
          } else {
            _localP1.status = _selfDrivenDirections.length > 0 || _localP1.legacyActCount > 0 ? "partial" : "empty";
            _localP1.insufficiencyReason = "no_concrete_recalled_records";
          }
          wbT(_cid, "getprompt", "p1:localOutput", {
            mode: _p1Mode,
            status: _localP1.status,
            outcome: _localP1.outcome,
            directionCount: _localP1.directionWords.length,
            recordCount: _localP1.recalledRecords.length,
            legacyActCount: _localP1.legacyActCount,
            hasConcreteRecall: _hasConcreteLocalRecall,
            insufficiencyReason: _localP1.insufficiencyReason,
          });
          const _injectSelfDrivenDirectly = _selfDrivenUserEnabled;
          if (_injectSelfDrivenDirectly
            && (_selfDrivenDirections.length > 0 || _p1Res?.p1_act?.length > 0 || _selfDrivenRecords.length > 0)) {
            const _p1Parts = [];
            if (_selfDrivenDirections.length > 0) {
              const _directionText = _selfDrivenDirections.join(" / ");
              // 方向词沿用既有 INJ-p1-act-data 模板；这是自驱动联想的生产消费端，
              // 与 recalledRecords 的结构化记忆注入是两种不同信息，不互相替代。
              _pushDataInj("INJ-p1-act-data", { p1_act: _directionText }, { important: 6, pushText: false });
              _p1Parts.push(_directionText);
              wbT(_cid, "getprompt", "p1:selfDrivenDirectionInject", {
                directionCount: _selfDrivenDirections.length,
                directions: _selfDrivenDirections,
              });
            }
            if (_selfDrivenRecords.length > 0) {
              const _recordBody = _stripConsumedTagsFromInjection(
                _selfDrivenRecords.map((record, index) => {
                  const _meta = _formatP1RecordMeta(record).join(" · ");
                  return `${index + 1}. ${_meta ? `[${_meta}] ` : ""}${String(record.content).trim()}`;
                }).join("\n\n")
              );
              // 复用既有可配置模板；这里只提供记录数据，不新增第二套提示词包装。
              _pushDataInj("INJ-p1-retrieval-data", {
                p1_retrieval: _recordBody,
                p1_retrieval_ts: "",
              }, { important: 6 });
              _p1Parts.push(_recordBody);
              wbT(_cid, "getprompt", "p1:selfDrivenRecallInject", {
                recordCount: _selfDrivenRecords.length,
                recordIds: _selfDrivenRecords.map((record) => record.recordId).filter(Boolean),
              });
            }
            // [0801 双写修复] recalledRecords 已注入 INJ-p1-retrieval-data（结构化带层/编号/内容）;
            // p1_act 只兼容没有 directionWords、也没有 recalledRecords 的旧链；新管线
            // p1_act=records.map(content)，若继续注入会在主 AI 上下文里复制同一记忆。
            if (_p1Res?.p1_act?.length > 0 && _selfDrivenDirections.length === 0 && _selfDrivenRecords.length === 0) {
              const _p1ActStr = _p1Res.p1_act.join(" / ");
              _pushDataInj("INJ-p1-act-data", { p1_act: _p1ActStr }, { important: 6, pushText: false });
              _p1Parts.push(_p1ActStr);
            }
            _p1ResultText = _p1Parts.join("\n\n");
          }
        } catch (_p1Err) {
          _localP1.status = "failure";
          _localP1.failure = { code: _p1Err?.code || null, error: _p1Err?.message || String(_p1Err) };
          _localP1.insufficiencyReason = `local_exception:${_localP1.failure.code || "unknown"}`;
          const _structuredTrace = _p1TraceSummary({ success: false, code: _p1Err?.code, error: _localP1.failure.error });
          _localP1.traceSummary = _structuredTrace;
        } finally {
          if (!_p1RunReused && _p1InFlight.get(_p1RunKey) === _p1RunPromise) {
            _p1InFlight.delete(_p1RunKey);
          }
        }
        } else {
          wbT(_cid, "getprompt", "p1:localOutput", {
            mode: _p1Mode,
            status: _localP1.status,
            hasConcreteRecall: false,
            insufficiencyReason: _localP1.insufficiencyReason,
          });
        }

        const p1Preset = presetsData.presets.find((p) => p.id === "P1");
        // 01 路由只运行 AI P1；它不消费自驱动输出，也不在失败时偷取自驱动/旧缓存结果。
        const _aiP1Eligible = _aiP1UserEnabled && !!p1Preset?.enabled;
        const _aiP1WillRun = _aiP1Eligible;
        if (_localP1.failure) {
          _reportLocalP1Failure(
            _cid,
            _p1Mode,
            _p1ScopeKey,
            _localP1.failure,
            _localP1.traceSummary,
          );
        }
        wbT(_cid, "getprompt", "p1:aiEligibility", {
          mode: _p1Mode,
          userEnabled: _aiP1UserEnabled,
          presetEnabled: p1Preset?.enabled === true,
          eligible: _aiP1Eligible,
          willRun: _aiP1WillRun,
          localStatus: _localP1.status,
          localRecordCount: _localP1.recalledRecords.length,
          localFailure: _localP1.failure?.code || null,
          insufficiencyReason: _localP1.insufficiencyReason,
        });

        // AIP1 是否调用只由互斥的 aiP1 用户路由与 P1 preset 门裁决。
        if (_aiP1WillRun) {
          let chatHistory = "";
          const chatHistoryCount = retrievalConfig[`chat_history_count_${_activeMode}`] || retrievalConfig.chat_history_count || 5;
          if (arg?.chat_log && Array.isArray(arg.chat_log)) {
            const recent = arg.chat_log.slice(-chatHistoryCount);
            chatHistory = recent
              .map((m) => {
                const role = m.role === "user" ? userName : displayCharName;
                return `${role}: ${m.content || ""}`;
              })
              .join("\n\n");
          }

          pushMemoryAIOutput({
            presetId: "P1", presetName: "检索AI",
            reply: "", thinking: "", operations: [], status: "running",
          });

          // ★ 向量初筛（0722 接入，拍板=未来技术演进§1.2/演进规划§9.3：向量检索做初筛 Top-K，
          //   P1 AI 做精选，减少 P1 多轮 memorySearch 摸索）。vectordb 未启用/索引空/异常 →
          //   _vecExtraCtx 保持空串 → runMemoryPresetAI 不加消息 = 原链零回归。
          let _vecExtraCtx = "";
          try {
            const _vecHits = await vectorPrefilter(getMemoryDir(username, charName), _lastMsg?.content || _lastMsg?.mes || "");
            if (_vecHits.length > 0) {
              // [0728 top-k] 只在语义 Top-5 切片内按层级+热度重排（先切片后重排：热度不改变入选
              //   ——入选仍由语义相关性定，避免低相关高热文件挤掉高相关候选），呈现序供 P1 参考
              const _vecTop = _vecHits.slice(0, 5);
              applyLayerTopkOrder(getMemoryDir(username, charName), _vecTop);
              const _vecTpl = data.config?.system_texts?.p1_vector_prefilter || DEFAULT_SYSTEM_TEXTS.p1_vector_prefilter;
              _vecExtraCtx = _vecTpl.replaceAll("{candidates}", formatVectorCandidates(_vecTop));
              wbT(_cid, "getprompt", "p1:vectorPrefilter", { hits: _vecHits.length, ctxLen: _vecExtraCtx.length });
            }
          } catch (_vecErr) {
            console.warn("[beilu-memory] P1 向量初筛失败（P1 走原链）:", _vecErr?.message || _vecErr);
          }

          wbT(_cid, "getprompt", "p1:aiContext", {
            mode: _p1Mode,
            vectorContextChars: _vecExtraCtx.length,
          });

          try {
            const result = await runMemoryPresetAI(
              username, charName, p1Preset, data, displayCharName, userName, chatHistory,
              {
                chatId: _cid,
                mode: _p1Mode,
                activeMode: _p1Mode,
                extraContext: _vecExtraCtx,
              }, // 宿主本轮 mode 显式交接，AIP1 不再从 active_modes 二次解析；其余调用方仍走兼容回退
            );
            const replyText = (result.reply || "").trim();
            wbT(_cid, "getprompt", "p1:aiDone", { ms: result.totalTimeMs, rounds: result.totalRounds, replyLen: replyText.length });
            wbT(_cid, "getprompt", "p1:aiResult", {
              success: true,
              mode: _p1Mode,
              ms: result.totalTimeMs,
              rounds: result.totalRounds,
              replyLen: replyText.length,
            });

            const {
              presetName: switchTarget,
              cleanContent: cleanedP1Reply,
            } = parsePresetSwitchTag(result.reply);
            if (switchTarget) {
              const _cdRemaining = presetSwitchCooldown.get(_cooldownKey) || 0;
              if (_cdRemaining > 0) {
                console.log(`[beilu-memory] P1 请求切换预设: "${switchTarget}" — 冷却中(剩余${_cdRemaining}轮)，已忽略`);
              } else {
                // [0717 串联收口·凛倾「两个预设污染/链路串联」] P1 切换在此（信号产生地=动作域）经唯一权威口
                //   switchPresetViaAPI（内部=beilu-preset SetData switch_preset：幂等/落盘/正则联动/广播/charName归位）
                //   立即执行——原路径把信号塞进 extension.preset_switch_to 穿过生成链、在 preset TweakPrompt
                //   中途用第二份手拼写实现落盘（写map+落盘+正则+广播的同构副本，违反 0708「生成不碰预设状态」定案；
                //   主AI <presetSwitch> 废弃收口时此处漏收=半修）。两份实现镜像删除，P1 功能不变、同轮生效时序不变
                //   （本处早于 preset TweakPrompt 各轮的 resolveActivePresetName 读点）。
                //   mode=_activeMode（生成链权威解析值，与读键同源）；arg 透传 username/char_id 供 SetData 分桶。
                const _psOk = await switchPresetViaAPI(switchTarget, arg, _cid || undefined, _activeMode || undefined);
                if (_psOk) {
                  _presetSwitchTarget = switchTarget;
                  _presetSwitchExecuted = true;
                  presetSwitchCooldown.set(_cooldownKey, _cooldownConfig);
                  console.log(`[beilu-memory] P1 触发预设切换(权威口): "${switchTarget}"，冷却已重置为${_cooldownConfig}轮`);
                } else {
                  // 权威口失败=可见不静默；不置冷却（下轮可重试），不置 executed（冷却递减逻辑照常）
                  console.warn(`[beilu-memory] P1 预设切换失败(switch_preset 通道异常): "${switchTarget}"`);
                }
              }
            }

            const cleanedText = cleanedP1Reply.trim();
            const _noResultKws = ["无需检索", "无相关记忆", "无关联记忆", "无内容", "无相关内容"];
            const _isP1NoResult = cleanedText.length < 5 || _noResultKws.some((kw) => cleanedText.includes(kw));
            if (!_isP1NoResult) {
              // P2：检索回复可能引用含裸指令标签的历史原文，注入前剥（防复读诱导/二次雪球）
              // !!!禁止放入提示词!!! 包装模板在 INJ-p1-retrieval-data（前端可改），此处只供数据。
              const _p1Body = _stripConsumedTagsFromInjection(cleanedP1Reply);
              _pushDataInj("INJ-p1-retrieval-data", { p1_retrieval: _p1Body, p1_retrieval_ts: "" }, { important: 6 });
              wbT(_cid, "getprompt", "p1:aiInject", { contentLen: _p1Body.length });
              // [0728 top-k] 真注入才计召回频率（语义对齐 tableEngine forever recordHit :442-444）：
              //   本轮 P1 读过的文件 → recallStats 累计 {count,last} → 检索结果层内 top-k 排序消费
              if (Array.isArray(result.touchedMemoryFiles) && result.touchedMemoryFiles.length > 0) {
                recordRecall(getMemoryDir(username, charName), result.touchedMemoryFiles);
              }
            } else {
              wbD(_cid, "getprompt", "p1:aiNoResult", false, "AI P1 判定无相关记忆/无需检索，不注入", { cleanedLen: cleanedText.length });
            }

            // 保存P1完整输出供P8联网判断
            _p1ResultText = replyText || "";

            pushMemoryAIOutput({
              presetId: "P1", presetName: "检索AI",
              reply: replyText || "无相关记忆", thinking: result.thinking || "",
              operations: result.operations || [], status: "done",
              totalRounds: result.totalRounds || 1, totalTimeMs: result.totalTimeMs,
            });
          } catch (e) {
            wbD(_cid, "getprompt", "p1:aiFail", false, e?.message || String(e), {});
            wbT(_cid, "getprompt", "p1:aiResult", {
              success: false,
              mode: _p1Mode,
              error: e?.message || String(e),
            });
            console.error(`[beilu-memory] P1 检索失败:`, e?.message || String(e));
            pushMemoryAIOutput({
              presetId: "P1", presetName: "检索AI",
              reply: "", thinking: "", operations: [], status: "error",
              error: e?.message || String(e),
            });
          }
        }
      }
      // 冷却递减
      if (!_presetSwitchExecuted && presetSwitchCooldown.has(_cooldownKey)) {
        const remaining = presetSwitchCooldown.get(_cooldownKey) - 1;
        if (remaining <= 0) presetSwitchCooldown.delete(_cooldownKey);
        else presetSwitchCooldown.set(_cooldownKey, remaining);
      }

      // 旧缓存结果注入（兼容）— 使用按角色隔离的consumeLastP1Result
      // 跳过已在本轮同步注入过P1的情况（防止double injection）
      const _p1AlreadyInjected = depthInjections.some(d => d.id === "INJ-p1-retrieval-data");
      const _skipLegacyP1Consume = _p1CurrentRequestHandled;
      if (!_p1AlreadyInjected && !_skipLegacyP1Consume && !arg.isFakeSend) {
        const _p1Cached = consumeLastP1Result(username, charName, _cid); // T4靶点④：本窗槽优先，miss 回退 "_" 槽（面板手动流兼容）
        if (_p1Cached) {
          // !!!禁止放入提示词!!! 包装模板在 INJ-p1-retrieval-data（前端可改），此处只供数据（含时间戳后缀）。
          _pushDataInj("INJ-p1-retrieval-data", {
            p1_retrieval: _stripConsumedTagsFromInjection(_p1Cached.reply),
            p1_retrieval_ts: _p1Cached.timestamp ? ` (${_p1Cached.timestamp})` : "",
          }, { important: 6 });
        }
      }

      // 聊天AI搜索结果注入
      if (!arg.isFakeSend) {
        // [0726 功能槽] 一条线路上可同时存在多个功能的检索结果（memory=记忆检索 / web=联网搜索），
        //   按架构「a 和 b 同时激活工作两次不影响」各占独立槽——此处取齐全部槽，逐槽消费。
        //   原实现按单 key get，两功能同轮时后写覆盖先写、静默丢一份（0726 实证）。
        const _searchSlots = listChatSearchSlots(username, charName, _cid);
        if (_searchSlots.length > 0) {
          // !!!禁止放入提示词!!! 包装模板在 INJ-chat-search-data（前端可改），此处只供数据。
          //   多槽合并为一次注入（模板体系不变）；槽间以来源标识分段，保持各功能结果可辨。
          const _slotTs = _searchSlots.map(([, v]) => v.timestamp).sort().pop();
          const _slotText = _searchSlots
            .map(([, v, feature]) => (_searchSlots.length > 1 ? `[来源: ${feature}]\n${v.results}` : v.results))
            .join("\n\n");
          _pushDataInj("INJ-chat-search-data", { chat_search_ts: _slotTs, chat_search_results: _slotText }, { important: 5 });
          for (const [k] of _searchSlots) pendingChatSearchResults.delete(k);
        }
        // 断点#5 修（0716）：上轮 tableEdit 失败明细回喂——纯事实呈现（操作+原因），无引导话术（0708 铁律）。
        // [0726 修 ReferenceError] 原读键 chatSearchKey 是旁边 chat-search 单键时代的变量，那段改成
        //   _searchSlots 多槽后该变量被删、这两行没跟着改 → 每次 GetPrompt 抛
        //   "chatSearchKey is not defined"（21:05-21:11 实测连发），整个 tableEdit 失败回喂链死。
        //   键口径对齐**写侧单源** replyHandler.mjs:1048 `${username}/${charName}/${_cid || "_"}`
        //   （aiRunner.mjs:225 契约注释 "Key: username/charName/chatid" 同款）。
        const _tefKey = `${username}/${charName}/${_cid || "_"}`;
        const _tefPending = pendingTableEditFeedback.get(_tefKey);
        if (_tefPending) {
          // !!!禁止放入提示词!!! 包装模板在 INJ-table-edit-feedback-data（前端可改）；"- op: reason"行是数据序列化。
          _pushDataInj("INJ-table-edit-feedback-data", {
            table_edit_ts: _tefPending.timestamp,
            table_edit_failures: _tefPending.failures.map((f) => `- ${f.op}: ${f.reason}`).join("\n"),
          }, { important: 6 });
          pendingTableEditFeedback.delete(_tefKey);
        }
      }

      // W57: 并行委派结果注入
      if (!arg.isFakeSend) {
        try {
          const _pdDir = getMemoryDir(username, charName);
          // ★ B2 corrId隔离: 优先读本会话的结果文件，回退旧无后缀文件(向后兼容)
          const _pdSessionPath = _cid ? path.join(_pdDir, "work", `_parallel_results_${_cid}.json`) : "";
          const _pdLegacyPath = path.join(_pdDir, "work", "_parallel_results.json");
          const _pdPath = (_pdSessionPath && fs.existsSync(_pdSessionPath)) ? _pdSessionPath : _pdLegacyPath;
          if (fs.existsSync(_pdPath)) {
            const _pdData = JSON.parse(await fs.promises.readFile(_pdPath, "utf-8"));
            if (_pdData && !_pdData.injected && _pdData.results?.length > 0) {
              const _pdContent = _pdData.results.map(r =>
                `[${r.label || r.subMode}${r.status === "error" ? " (失败)" : ""}]\n${r.reply || r.error || "(无输出)"}`
              ).join("\n\n");
              // !!!禁止放入提示词!!! 外层模板在 INJ-parallel-delegate-data（前端可改）；子任务条目格式为数据序列化残留，列0722待决。
              _pushDataInj("INJ-parallel-delegate-data", { parallel_count: _pdData.results.length, parallel_results: _pdContent }, { important: 7 });
              // 标记已注入
              _pdData.injected = true;
              nicerWriteFileSync(_pdPath, JSON.stringify(_pdData, null, 2));
            }
          }
        } catch (_e) {
          // F13：原空 catch 静默吞错 → wbD 观测（并行委派结果注入读失败，AI 看不到子任务结果；非主链，继续）
          wbD(null, "memory", "getPromptHandler:parallelDelegate_inject_read_fail", false, "并行委派结果注入读失败", { err: _e.message });
        }
      }
    }

    // W65: 分身AI结果现在通过 pendingResults 同步注入（跟ideToolCall一样的路径）
    // 不再从文件读取。清理旧文件（如果存在）
    if (!arg.isFakeSend) {
      try {
        const _clDir = getMemoryDir(username, charName);
        const _clPath = path.join(_clDir, "code", "_clone_results.json");
        if (fs.existsSync(_clPath)) {
          fs.unlinkSync(_clPath);
        }
      } catch (_e) { wbD(null, "memory", "getPromptHandler:clone_results_cleanup_fail", false, "旧 _clone_results 清理失败(无害)", { err: _e.message }); }
    }

    // W58: 流程组(Skill组)状态注入 — 让AI知道当前在执行哪个步骤
    if (!arg.isFakeSend && modeFeature(_activeMode, "flowGroup").config.stateInject === true) { // 0716 接线：跟声明（0702 §E 裁决）
      try {
        const _fgDir = getMemoryDir(username, charName);
        const _fgConfigPath = getWorkConfigPath(username, charName); // T7 尾段收口：权威路径单点
        if (fs.existsSync(_fgConfigPath)) {
          const _fgConfig = loadJsonFileIfExists(_fgConfigPath, {});
          // D09 收口：槽解析单源（同 W61/动作四 case，语义不变=per-chatid 优先 _default 兜底）
          const { slot: _fgSlot } = resolveWorkflowSlot(_fgConfig, _cid);
          if (_fgSlot?.active_workflow && _fgSlot.workflow_state?.status === "running") {
            const _fgWfPath = path.join(_fgDir, "work", "workflows", _fgSlot.active_workflow);
            const _fgWf = fs.existsSync(_fgWfPath) ? JSON.parse(await fs.promises.readFile(_fgWfPath, "utf-8")) : null;
            if (_fgWf) {
              const _ws = _fgSlot.workflow_state;
              const _currentStep = _fgWf.steps[_ws.current_step];
              const _stepsOverview = _fgWf.steps.map((s, i) => {
                const status = i < _ws.current_step ? "✅" : i === _ws.current_step ? "▶️" : "⬜";
                return `${status} ${i + 1}. ${s.label || s.mode || s.preset_name || `步骤${i + 1}`}`;
              }).join("\n");
              // !!!禁止放入提示词!!! 模板在 INJ-flow-group-data（前端可改），此处只供数据。
              //   原 depth:1 混头部 system=缓存主犯（进度每轮变），0722 收口归尾部。
              _pushDataInj("INJ-flow-group-data", {
                flow_group_name: _fgWf.name,
                flow_group_progress: `${_ws.current_step + 1}/${_ws.total_steps}`,
                flow_group_steps: _stepsOverview,
                flow_group_current: _currentStep?.label || _currentStep?.mode || "未知",
                flow_group_auto_advance: _fgWf.auto_advance ? "是" : "否",
              }, { important: 8 });
            }
          }
        }
      } catch (_fgErr) { wbD(null, "memory", "getPromptHandler:flowgroup_status_inject_fail", false, "流程组状态注入读失败(已跳过)", { err: _fgErr.message }); }
    }

    // P8 联网搜索AI — P1判断需要时触发（在P1之后）
    if (!arg.isFakeSend) {
      const p8Preset = presetsData.presets.find((p) => p.id === "P8");
      const webSearchConfig = data.config?.web_search || {};

      // ★ 检查P1输出是否包含 <needWebSearch> 标签
      const _p1ReplyForSearch = _p1ResultText || "";
      const _p1NeedSearch = /<needWebSearch>([\s\S]*?)<\/needWebSearch>/i.exec(_p1ReplyForSearch);
      const _p1SearchReason = _p1NeedSearch ? _p1NeedSearch[1].trim() : "";

      // ★ W66修复：P8开启即视为搜索可用，不再额外检查 webSearchConfig.enabled
      // [0726 死键接线·002「死键接」] web_search.p8_enabled 此前**后端零消费**（只有 storage 默认值 +
      //   前端面板读写）——UI 上那个"P8 搜索"开关拨了不控任何东西。现接为**总开关**：显式 false 即停
      //   P8 链路（preset.enabled 仍是第二道门，两者与门关系；未设置时 !==false 为真=行为与改前一致）。
      const _p8SwitchOn = webSearchConfig.p8_enabled !== false;
      diag.log(`P8触发检查: preset=${!!p8Preset}(${p8Preset?.enabled}), p8_enabled=${_p8SwitchOn}, ws=${webSearchConfig.enabled}, engine=${webSearchConfig.engine || 'none'}, P1联网=${!!_p1NeedSearch}${_p1SearchReason ? '(' + _p1SearchReason + ')' : ''}`);
      wbT(_cid, "getprompt", "p8:triggerCheck", { hasPreset: !!p8Preset, enabled: !!p8Preset?.enabled, p8Switch: _p8SwitchOn, engine: webSearchConfig.engine || null, p1NeedSearch: !!_p1NeedSearch, reason: _p1SearchReason || null });
      if (p8Preset && p8Preset.enabled && _p8SwitchOn && _p1NeedSearch) {
        let p8ChatHistory = "";
        const _p8rc = data.config?.retrieval || {};
        const p8HistoryCount = _p8rc[`chat_history_count_${_activeMode}`] || _p8rc.chat_history_count || 5;
        if (arg?.chat_log && Array.isArray(arg.chat_log)) {
          const recent = arg.chat_log.slice(-p8HistoryCount);
          p8ChatHistory = recent
            .map((m) => {
              const role = m.role === "user" ? userName : displayCharName;
              return `${role}: ${m.content || ""}`;
            })
            .join("\n\n");
        }

        pushMemoryAIOutput({
          presetId: "P8", presetName: "联网搜索AI",
          reply: "", thinking: "", operations: [], status: "running",
        });

        try {
          const _p8StartTime = Date.now();
          const p8Result = await runMemoryPresetAI(
            username, charName, p8Preset, data, displayCharName, userName, p8ChatHistory, { webSearchConfig, chatId: _cid }, // T4靶点④
          );
          const p8Reply = (p8Result.reply || "").trim();
          wbT(_cid, "getprompt", "p8:aiDone", { ms: Date.now() - _p8StartTime, rounds: p8Result.totalRounds, replyLen: p8Reply.length });
          const _isP8NoResult = !p8Reply || p8Reply.length < 10 || p8Reply.includes("<noSearch>") || p8Reply === "无需搜索";
          if (!_isP8NoResult) {
            // !!!禁止放入提示词!!! 包装模板在 INJ-p8-web-search-data（前端可改），此处只供数据。
            _pushDataInj("INJ-p8-web-search-data", { p8_results: p8Reply }, { important: 5 });
            wbT(_cid, "getprompt", "p8:inject", { contentLen: p8Reply.length });
            diag.log(`P8搜索完成 (${Date.now() - _p8StartTime}ms, ${p8Reply.length}字符, rounds=${p8Result.totalRounds})`);
          } else {
            wbD(_cid, "getprompt", "p8:noResult", false, "P8 联网无结果/<noSearch>，不注入", { replyLen: p8Reply.length });
          }
          pushMemoryAIOutput({
            presetId: "P8", presetName: "联网搜索AI",
            reply: p8Reply || "无需搜索", thinking: p8Result.thinking || "",
            operations: p8Result.operations || [], status: "done",
            totalRounds: p8Result.totalRounds || 1, totalTimeMs: p8Result.totalTimeMs,
          });
        } catch (e) {
          wbD(_cid, "getprompt", "p8:aiFail", false, e?.message || String(e), {});
          console.error(`[beilu-memory] P8 联网搜索失败:`, e?.message || String(e));
          pushMemoryAIOutput({
            presetId: "P8", presetName: "联网搜索AI",
            reply: "", thinking: "", operations: [], status: "error",
            error: e?.message || String(e),
          });
        }
      }
    }

    diag.log(`GetPrompt汇总: text=${textEntries.length}条, depth=${depthInjections.length}条`);

    // ★ 文件读取缓存清单已通过 INJ-1-write-code-data 的 {{ide_read_cache}} 宏注入，不再单独注入

    // ═══════════════════════════════════════════════════════════════
    // Phase 4 (S19-S21): Token 管理与后处理
    //   S19: W66 contextClean — 压缩旧工具结果/AI命令 + 剥 thinking + 剥旧 XML 标签
    //   S20: Token 多级提醒 + urgent 自动 hideMessages + T09 异步 P7 压缩
    //   S21: 输出管控违规警告注入
    // ═══════════════════════════════════════════════════════════════

    // ★ W66 contextClean: 压缩chatLog中的旧工具结果和AI工具命令，节省token
    // 新架构：工具结果是chatLog中的system消息，AI工具命令在char消息的<ideToolCall>标签内
    // 策略：保留最近若干条完整（_KEEP_RECENT 按工具结果字符量动态取 1/2/3，缺省 3，见下方 T3），更早的压缩为摘要
    {
      const _origChatLog = arg?.chat_log;
      // ★ 浅拷贝数组，避免污染 chatMetadata.chatLog 原始数据（后续AI指令清理也用这个副本）
      let _chatLog = null;
      if (_origChatLog && Array.isArray(_origChatLog) && _origChatLog.length > 0) {
        _chatLog = [..._origChatLog];
        arg.chat_log = _chatLog;
        // ★ T3: 动态KEEP_RECENT — 按工具结果总字符量调整保留条数
        let _totalToolChars = 0;
        for (const e of _chatLog) {
          if (isIdeToolResultMsg(e)) {
            _totalToolChars += (e.content || "").length;
          }
        }
        const _KEEP_RECENT = _totalToolChars > 50000 ? 1 : _totalToolChars > 20000 ? 2 : 3;
        wbT(_cid, "getprompt", "w66:enter", { chatLogLen: _chatLog.length, toolChars: _totalToolChars, keepRecent: _KEEP_RECENT });
        let _compressedCount = 0;

        // 1. 压缩旧的系统工具结果消息（role=system 或 name=系统/IDE工具结果）
        const _sysIndices = [];
        for (let i = 0; i < _chatLog.length; i++) {
          if (isIdeToolResultMsg(_chatLog[i])) {
            _sysIndices.push(i);
          }
        }
        // 只压缩除最近N条外的旧工具结果
        // ★ 注意：chat_log是chatMetadata.chatLog的引用，不能修改原始content
        //   用浅拷贝替换对应位置，保护持久化数据
        const _sysToCompress = _sysIndices.slice(0, Math.max(0, _sysIndices.length - _KEEP_RECENT));
        for (const idx of _sysToCompress) {
          const e = _chatLog[idx];
          const _origLen = (e.content || "").length;
          if (_origLen > 200) {
            // ★ compaction: 旧工具结果直接清除，只保留工具名摘要
            // 防止旧的错误/空结果污染AI判断（"上下文污染"问题）
            const _toolEntries = [];
            const _toolRe = /---\s+(\w+)\s+\(([^)]*)\)\s*---/g;
            let _m;
            while ((_m = _toolRe.exec(e.content)) !== null) {
              _toolEntries.push(_m[1]);
            }
            // 检查是否包含失败结果 — 失败的直接清除不保留
            const _hasFailure = e.content.includes('"success":false') || e.content.includes("success\": false") || e.content.includes("执行失败") || e.content.includes("error");
            const _summary = _hasFailure
              ? `[旧工具结果已清除 — 包含过时的错误信息，请重新执行工具获取最新结果]`
              : _toolEntries.length > 0
                ? `[旧工具结果已清除: ${_toolEntries.join(", ")}]`
                : `[旧工具结果已清除]`;
            _chatLog[idx] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { content: _summary });
            _compressedCount++;
          }
        }

        // 2. 压缩AI消息中旧的<ideToolCall>标签 — 保留工具名但移除参数细节
        const _charIndices = [];
        for (let i = 0; i < _chatLog.length; i++) {
          const e = _chatLog[i];
          if (e.role !== "user" && e.role !== "system" && e.content && e.content.includes("<ideToolCall")) {
            _charIndices.push(i);
          }
        }
        const _charToCompress = _charIndices.slice(0, Math.max(0, _charIndices.length - _KEEP_RECENT));
        for (const idx of _charToCompress) {
          const e = _chatLog[idx];
          const _origContent = e.content;
          let _newContent = _origContent.replace(
            /<ideToolCall\s+tool="([^"]*)"([^>]*)>[\s\S]*?<\/ideToolCall>/g,
            (match, toolName, attrs) => {
              const _pathMatch = attrs.match(/path="([^"]*)"/);
              return _pathMatch ? `[已执行: ${toolName} → ${_pathMatch[1]}]` : `[已执行: ${toolName}]`;
            }
          );
          _newContent = _newContent.replace(
            /<ideToolCall\s+tool="([^"]*)"([^>]*)\s*\/>/g,
            (match, toolName, attrs) => {
              const _pathMatch = attrs.match(/path="([^"]*)"/);
              return _pathMatch ? `[已执行: ${toolName} → ${_pathMatch[1]}]` : `[已执行: ${toolName}]`;
            }
          );
          _newContent = _newContent.replace(
            /<file_op\s+[^>]*tool="([^"]*)"[^>]*>[\s\S]*?<\/file_op>/g,
            (match, toolName) => `[已执行: ${toolName}]`
          );
          if (_newContent.length < _origContent.length) {
            _chatLog[idx] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { content: _newContent });
            _compressedCount++;
          }
        }

        // 3. thinking 剥离已由 beilu-regex TweakPrompt reasoning placement 统一处理（0714 框架级收口），
        //    不再在此重复遍历 chatLog 调 stripReasoningTags——同一 chatLog 引用在 TweakPrompt 已改过。
        //    beilu_think 标签如需剥离，用户在正则编辑器加 reasoning placement 规则即可。

        // 4. 自动清理旧XML指令标签 — 保留最近5条含XML标签的消息，更早的剥离标签
        // 目的：减少上下文中的旧指令污染（AI会参考旧标签格式导致格式漂移）
        // N31: 标签清单单源化（原三正则重复列表）+ 补齐缺席标签——mvu 系（UpdateVariable/JSONPatch）
        // 缺席曾是哨兵/变量块随历史回灌模型的口子（0612 白盒"标签生命周期不一致"）。
        // 注意：此清单=「模型上下文」剥离语义，与 replyHandler._stripAllTags（show 显示剥离，
        // 故意保留 mvu 给美化正则）语义不同，勿跨文件强行统一。新增 AI 指令标签在此登记一处即可。
        const _XML_KEEP_RECENT = 5;
        const _CONSUMED_TAG_NAMES = _CONSUMED_TAG_NAMES_BASE; // 单源：模块级基础清单（P2 注入清洗共用）
        // 用户可自由增删（凛倾 2026-06-12 问「这些用户可以自由设置吗」→接 show 剥离同一配置文件）：
        // data/users/<用户>/strip_tags_custom.json 新增两键——context_tags:[追加标签名]、
        // context_tags_exclude:[从内置清单排除]。同 _loadCustomStripPatterns 的字符白名单，配置坏不影响内置。
        let _ctNames = _CONSUMED_TAG_NAMES;
        let _ctCfg = null;
        try {
          const _ctCfgPath = path.join(__projectRoot, "data", "users", username, "strip_tags_custom.json");
          if (fs.existsSync(_ctCfgPath)) {
            _ctCfg = JSON.parse(await fs.promises.readFile(_ctCfgPath, "utf-8"));
            const _ctSafe = (t) => typeof t === "string" && /^[\w\u4e00-\u9fff-]+$/.test(t);
            if (Array.isArray(_ctCfg.context_tags_exclude))
              for (const t of _ctCfg.context_tags_exclude.filter(_ctSafe))
                _ctNames = _ctNames.split("|").filter((n) => n !== t).join("|");
            if (Array.isArray(_ctCfg.context_tags))
              _ctNames += _ctCfg.context_tags.filter(_ctSafe).map((t) => "|" + t).join("");
          }
        } catch (_ctErr) { wbD(_cid, "getprompt", "w66:customTagFail", false, _ctErr.message, {}); console.warn("[beilu-memory] context_tags 自定义读取失败（用内置清单）:", _ctErr.message); }
        // 孤立闭标签清理开关（凛倾 2026-06-12：AIRP 可能需要孤立闭标签做美化锚点，其他地方不需要）：
        // 缺省按模式=chat(AIRP/全智能)不清、code/work 清；strip_tags_custom.json 的
        // context_strip_orphan_close: true=全模式清 / false=全模式不清，显式值覆盖模式默认。
        let _orphanStripOn = modeFeature(_activeMode, "memory").config.orphanStrip === true; // 0716 接线：跟声明（0702 §G 裁决）
        if (typeof _ctCfg?.context_strip_orphan_close === "boolean")
          _orphanStripOn = _ctCfg.context_strip_orphan_close;
        // 检测兼容三形态：开标签 / 孤立闭标签（污染历史的常见形态）/ 裸自闭合 <tag/>
        const _xmlTagsRe = new RegExp(`<\\/?(${_ctNames})[\\s>/]`);
        const _xmlFullStripRe = new RegExp(`<(${_ctNames})[\\s>][\\s\\S]*?<\\/\\1>`, "g");
        const _xmlSelfCloseRe = new RegExp(`<(${_ctNames})[^>]*\\/>`, "g");
        // 孤立闭标签（如历史残留的 </UpdateVariable> 哨兵——N24 已停新增，这里清旧账）
        const _xmlOrphanCloseRe = new RegExp(`<\\/(${_ctNames})>`, "g");
        const _xmlMsgIndices = [];
        for (let i = 0; i < _chatLog.length; i++) {
          const e = _chatLog[i];
          if (e.role !== "user" && e.role !== "system" && e.content && _xmlTagsRe.test(e.content)) {
            _xmlMsgIndices.push(i);
          }
        }
        const _xmlToStrip = _xmlMsgIndices.slice(0, Math.max(0, _xmlMsgIndices.length - _XML_KEEP_RECENT));
        // T8 标签分离白盒埋点：AI 上下文剥离点（C 清单消费端）剥前/剥后可见。
        // 加日志不改控制流：报含 XML 标签的历史消息数 / 剥的条数 / 保留近 N 条 / 孤立闭标签开关。
        // 与 show(replyHandler:3135) / bot 两个消费端的剥离观测对称，让三清单分流在白盒面板同框可见。
        wbT(_cid, "memory", "stripConsumedTags:contextXml", { xmlMsgs: _xmlMsgIndices.length, toStrip: _xmlToStrip.length, keepRecent: _XML_KEEP_RECENT, orphanStrip: _orphanStripOn, mode: _activeMode });
        let _xmlStrippedThisPass = 0;
        for (const idx of _xmlToStrip) {
          const e = _chatLog[idx];
          let _c = e.content;
          _c = _c.replace(_xmlFullStripRe, "");
          _c = _c.replace(_xmlSelfCloseRe, "");
          if (_orphanStripOn) _c = _c.replace(_xmlOrphanCloseRe, "");
          _c = _c.trim();
          if (_c !== e.content) {
            _chatLog[idx] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { content: _c });
            _compressedCount++;
            _xmlStrippedThisPass++;
          }
        }
        // T8 出口观测：实际改写了几条（剥后），让"剥前(toStrip)→剥后(stripped)"的差在面板可量。
        if (_xmlToStrip.length > 0) wbT(_cid, "memory", "stripConsumedTags:contextXmlDone", { candidate: _xmlToStrip.length, stripped: _xmlStrippedThisPass });

        if (_compressedCount > 0) {
          wbT(_cid, "getprompt", "w66:done", { compressed: _compressedCount, keepRecent: _KEEP_RECENT });
          diag.log(`contextClean: 压缩了${_compressedCount}条chatLog消息（含thinking剥离/XML标签清理，保留最近${_KEEP_RECENT}条工具结果+${_XML_KEEP_RECENT}条XML标签完整）`);
        }
      }

      // AI <contextClean> 指令回退处理（正常流程已在replyHandler中立即执行）
      // 这里只处理回退场景：replyHandler无法访问chatOps时写了marks文件
      try {
        const _cleanMarksPath = path.join(getMemoryDir(username, charName), "hot", "_context_clean_marks.json");
        if (fs.existsSync(_cleanMarksPath)) {
          const _cleanMarks = loadJsonFileIfExists(_cleanMarksPath, []);
          if (_cleanMarks.length > 0 && _chatLog) {
            let _cleanedCount = 0;
            for (const mark of _cleanMarks) {
              const cmd = mark.command || "";
              if (cmd === "tool_results:all") {
                for (let i = _chatLog.length - 1; i >= 0; i--) {
                  const e = _chatLog[i];
                  if (isIdeToolResultMsg(e)) {
                    // 文案单源=DEFAULT_SYSTEM_TEXTS.cleaned_tool_results（config.system_texts 可覆盖，0722 铁律迁移）
                    _chatLog[i] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { content: (data.config?.system_texts?.cleaned_tool_results || DEFAULT_SYSTEM_TEXTS.cleaned_tool_results) });
                    _cleanedCount++;
                  }
                }
              } else if (cmd.startsWith("read_file:")) {
                const filePath = cmd.substring("read_file:".length).trim();
                if (filePath) {
                  for (let i = _chatLog.length - 1; i >= 0; i--) {
                    const e = _chatLog[i];
                    if ((e.role === "system" || e.name === "系统" || e.name === "IDE工具结果") && e.content && e.content.includes(filePath)) {
                      // 文案单源=DEFAULT_SYSTEM_TEXTS.cleaned_file（config.system_texts 可覆盖，{path} 此处填充）
                      _chatLog[i] = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { content: (data.config?.system_texts?.cleaned_file || DEFAULT_SYSTEM_TEXTS.cleaned_file).replaceAll("{path}", filePath) });
                      _cleanedCount++;
                    }
                  }
                }
              }
            }
            if (_cleanedCount > 0) diag.log(`contextClean(回退): 压缩${_cleanedCount}条`);
            fs.unlinkSync(_cleanMarksPath);
          }
        }
      } catch (_cleanErr) {
        diag.warn(`contextClean回退执行失败: ${_cleanErr.message}`);
      }
    }

    // 回退旧方式
    if (textEntries.length === 0) {
      const tableText = tablesToPromptText(data.tables, displayCharName, userName);
      let fullText = tableText;
      if (hotMemoryText) fullText += "\n\n[相关记忆]" + hotMemoryText + "\n[/记忆]";
      injectionLog.push({
        timestamp: new Date().toISOString(), injectionCount: 1,
        p1Injected: false, hotMemoryLength: hotMemoryText ? hotMemoryText.length : 0,
        tableDataLength: tableDataText.length, mode: "fallback",
      });
      while (injectionLog.length > 20) injectionLog.shift();
      return {
        text: [{ content: fullText, important: 5 }],
        additional_chat_log: [],
        extension: {},
      };
    }

    const _p1WasInjected = depthInjections.some((d) => d.id === "P1_RETRIEVAL");
    injectionLog.push({
      timestamp: new Date().toISOString(), injectionCount: textEntries.length,
      p1Injected: _p1WasInjected, hotMemoryLength: hotMemoryText ? hotMemoryText.length : 0,
      tableDataLength: tableDataText.length, depthCount: depthInjections.length,
      mode: "injection_prompts",
    });
    while (injectionLog.length > 20) injectionLog.shift();

    // 任务G: Token 状态计算 + 多级提醒 + 可配置格式（所有模式启用）
    // ★ 修正：加入chatLog的token估算（之前只算depthInjections，实际用量低估30-50%）
    const SAFETY_MARGIN = 1.2; // token估算加20%安全余量
    let _codeTokenStatus = null;
    {
      const _totalInjChars = depthInjections.reduce((sum, d) => sum + (d.content || "").length, 0);
      const _injTokens = depthInjections.reduce((sum, d) => sum + 4 + countTokensSync(d.content || ""), 0);
      // ★ chatLog token估算（每条消息约4 token overhead + 内容）
      const _chatLog = arg?.chat_log;
      let _chatLogTokens = 0;
      if (_chatLog && Array.isArray(_chatLog)) {
        for (const e of _chatLog) {
          _chatLogTokens += 4 + countTokensSync(e.content || "");
        }
      }
      const _rawTokens = _injTokens + _chatLogTokens;
      const _estimatedTokens = Math.round(_rawTokens * SAFETY_MARGIN);
      if (_chatLogTokens > 0) {
        diag.log(`Token统计: 注入=${_injTokens}, chatLog=${_chatLogTokens} (${_chatLog.length}条), 合计=${_rawTokens}, ×${SAFETY_MARGIN}=${_estimatedTokens}`);
      }
      // TOKEN_WARNING 单源收敛（2026-07-08 链路3）：默认值唯一权威=storage DEFAULT_TOKEN_REMINDER
      //   （用户可改路径上的播种默认），用户 config 逐字段覆盖；本文件原第二份写死的四级阈值
      //   +动态 cleanup_hint 副本已删（与 storage 三级内容不一致=双源漂移根源）。
      const _tokenReminder = { ...DEFAULT_TOKEN_REMINDER, ...(data.config?.token_reminder || {}) };
      // ★ 根病1 单源：token 占用率分母 = 三层生效 max_context（子模式▸runtime▸预设base▸200000），
      //   与前端进度条 _effective_max_context / 真生成层同口径（resolveEffectiveMaxContextLive 内存单源），
      //   不再 _subModeMaxContext||code_token_limit||200000 异源（缺陷2）。
      const _tokenLimit = resolveEffectiveMaxContextLive(username, _activeMode, _cid, getActivePresetName(username, _cid, _activeMode), charName);
      _codeTokenStatus = {
        used: _estimatedTokens,
        limit: _tokenLimit,
        percentage: Math.round((_estimatedTokens / _tokenLimit) * 100),
      };
      diag.log(`Token: ${_estimatedTokens}/${_tokenLimit} (${_codeTokenStatus.percentage}%, margin=${SAFETY_MARGIN})`);
      // 分子单源写点（唯一写方，tokenStatusLive）：contextClean 闸门/{{token_status}}宏 由此同口径读取
      setLastTokenStatus(username, _cid, _codeTokenStatus);

      if (_tokenReminder.enabled !== false) {
        // 多级阈值：单源=DEFAULT_TOKEN_REMINDER.thresholds（用户 config 可覆盖）
        // 兼容旧配置（单阈值）：重建数组而非原地清空——_thresholds 可能引用 DEFAULT 常量，原地改=污染单源
        const _thresholds = (_tokenReminder.threshold_percent && !(data.config?.token_reminder?.thresholds))
          ? [{ percent: _tokenReminder.threshold_percent, level: "warning", text: _tokenReminder.warning_text || "请及时记录md文件" }]
          : _tokenReminder.thresholds;

        const _triggered = _thresholds
          .filter(t => _codeTokenStatus.percentage >= t.percent)
          .sort((a, b) => b.percent - a.percent);

        if (_triggered.length > 0) {
          const _highest = _triggered[0];
          // 阈值条目 text 分层回退（0811）：web 面板保存历史上只存 percent/level 不带 text，
          // 顶层 {...DEFAULT,...config} 合并后 _highest.text=undefined 会把 "undefined" 渲进提醒文案。
          // 缺 text 按 level 从 DEFAULT_TOKEN_REMINDER.thresholds 回填（文本默认单源仍在 defaults）。
          const _text = _tokenReminder.custom_text || _highest.text
            || (DEFAULT_TOKEN_REMINDER.thresholds.find((d) => d.level === _highest.level)?.text) || "";
          const _format = _tokenReminder.format || "xml";
          const _pct = _codeTokenStatus.percentage;
          const _used = _codeTokenStatus.used;
          const _limit = _codeTokenStatus.limit;

          // 格式化提醒内容
          let _reminderContent;
          if (_format === "xml") {
            _reminderContent = `<token_warning level="${_highest.level}" used="${_used}" limit="${_limit}" percent="${_pct}%">\n${_text}\n</token_warning>`;
          } else if (_format === "emphasis") {
            _reminderContent = `!!!TOKEN ${_pct}% (${_used}/${_limit}) — ${_text}!!!`;
          } else {
            _reminderContent = `[系统提示] 当前上下文 Token 占用已达 ${_pct}%（${_used}/${_limit}）。${_text}`;
          }

          // AI自主清理提示：文本单源=DEFAULT_TOKEN_REMINDER.cleanup_hint（用户可改）；
          // 原按 level 动态拼接的三段副本已删（代码造提示词+与单源不同文）
          if (_tokenReminder.allow_ai_cleanup !== false && _tokenReminder.cleanup_hint) {
            _reminderContent += "\n" + _tokenReminder.cleanup_hint;
          }

          depthInjections.push({
            id: "TOKEN_WARNING",
            role: "user",
            content: _reminderContent,
            // 每轮 token 用量属于历史后运行数据；禁止旧配置/API/直接改盘把它送到缓存前缀。
            depth: 0,
            order: 999,
          });
          textEntries.push({ content: _reminderContent, important: 9 });
          diag.log(`Token提醒注入: level=${_highest.level} (${_pct}% >= ${_highest.percent}%)`);

          // W57+W58: 自动Token裁剪（urgent级别 ≥85% 时生效）
          if (_highest.level === "urgent" && _tokenReminder.auto_compact !== false) {
            // ★ 改（凛倾 2026-06-06）：urgent 不再「按 important 裁剪 depthInjection」——important 字段不在
            // depthInjections 条目上(只在 textEntries)，原裁剪 d.important??5 恒等 5，退化为按数组原序删，会误删
            // 重要系统注入(INJ模板/热层md)。改走「人工流程」：自动 hide AI读取/工具结果/分身输入(真正占 token 的噪声)，
            // 用 hideMessages 可逆(对齐手动压缩)。落盘→下轮 requestBuilder:97 过滤后 token 降；本轮按 id 从
            // arg.chat_log 即时移除应对本次超限。
            if (_cid) {
              try {
                const _coPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
                const _co = await import(pathToFileURL(_coPath).href);
                const _tLen = await _co.GetChatLogLength(_cid);
                const _fLog = _tLen > 0 ? await _co.GetChatLog(_cid, 0, _tLen) : [];
                // ★ D7 单源:噪声下标收集收口到 ideClient.collectNoiseToHide(原与 setDataActions:hideContextNoise 逐字复制,urgent 用 keep=2)。
                const { indices: _toHide, breakdown: _bd } = collectNoiseToHide(_fLog, 2);
                if (_toHide.length > 0) {
                  // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
                  const _idsUrgent = _toHide.map((i) => _fLog[i]?.id);
                  await _co.hideMessages(_cid, _toHide, true, { ...(_idsUrgent.every(Boolean) ? { ids: _idsUrgent } : {}), meta: { by: "auto", reason: "urgent_token_compact" } });
                  // urgent 本轮即时移除 arg.chat_log(生成链上下文独有,留调用方本地不进公共函数)
                  const _hideIds = new Set(_toHide.map((i) => _fLog[i].id).filter(Boolean));
                  if (_hideIds.size > 0 && Array.isArray(arg.chat_log)) {
                    arg.chat_log = arg.chat_log.filter((e) => !_hideIds.has(e.id));
                  }
                  diag.log(`Token urgent 人工流程清理: 隐藏(可逆)${_toHide.length}条 [AI读取/工具${_bd.read}+AI操作${_bd.op}+分身${_bd.clone}], ${_pct}%`);
                }
              } catch (_ce) {
                diag.warn(`Token urgent 人工流程清理失败: ${_ce.message}`);
              }
            }
          // T09: Token到达上限时异步生成摘要（不阻塞GetPrompt）
          // 下一轮 GetPrompt 的 Phase 3D 经 readContextSummary 自动读取 context_summary.json 注入（grep `readContextSummary`）
          // ★ #12：自动触发与手动一致的真实 P7 AI 压缩（P7→P1→任意可用预设），机械裁剪仅作 AI 真失败时兜底。
          // ★ P7 停用守卫（0802）：前端"停用"=p7Preset.enabled:false，T09 必须尊重——否则停用按钮形同虚设
          const _p7ForT09 = presetsData.presets?.find((p) => p.id === "P7");
          if (!contextSummaryText && !_t09InFlight.has(_cid || "_") && _p7ForT09?.enabled !== false) {
            const _t09Key = _cid || "_";
            const _chatLog = Array.isArray(arg?.chat_log) ? arg.chat_log.slice() : [];
            if (_chatLog.length >= 10) {
              const _sourceRevision = computeContextSummarySourceRevision(_chatLog);
              _t09InFlight.add(_t09Key);
              let _summaryWriteToken = null;
              try {
                // 必须在 handleGetPrompt 的主 await 路径内取得持久 CAS token，然后才启动
                // detached AI 任务。begin 内部还会校验“调用时观测基线”，锁等待期
                // 若回档推进 epoch/revision，旧请求不能在恢复后把新基线当成自己的 token。
                _summaryWriteToken = _cid
                  ? await beginContextSummaryWrite(username, charName, _cid, { sourceRevision: _sourceRevision })
                  : null;
              } catch (_beginError) {
                _t09InFlight.delete(_t09Key);
                wbD(_cid, "getprompt", "t09:summaryBeginFail", false, _beginError.message, { code: _beginError.code || null });
                diag.warn(`T09 摘要令牌获取失败: ${_beginError.message}`);
              }
              if (_summaryWriteToken && _summaryWriteToken.ok !== true) {
                _t09InFlight.delete(_t09Key);
                wbD(_cid, "getprompt", "t09:summaryBusy", false, _summaryWriteToken.code || "context summary rewrite busy", {
                  leaseId: _summaryWriteToken.leaseId || null,
                  leaseExpiresAt: _summaryWriteToken.leaseExpiresAt || null,
                  superseded: _summaryWriteToken.superseded === true,
                  expected: _summaryWriteToken.expected || null,
                  actual: _summaryWriteToken.actual || null,
                });
              } else if (!_cid || _summaryWriteToken?.ok === true) {
                (async () => {
                  try {
                const _keepStart = Math.floor(_chatLog.length * 0.3);
                const _firstMsg = _chatLog[0]
                  ? `[消息#0] ${_chatLog[0].role}: ${(_chatLog[0].content || "").substring(0, 500)}`
                  : "";
                const _recentMsgs = _chatLog.slice(_keepStart).map((m, i) =>
                  `[消息#${_keepStart + i}] ${m.role}: ${(m.content || "").substring(0, 500)}`
                );
                // 待压缩区间：#1 到 _keepStart（最早 30%）；slice(_keepStart) 保留的是最近 70% 原文
                // （原注释「保留近30%」与代码不符，_keepStart=len*0.3——代码为真，勿按旧注释改比例）
                const _compactRange = _chatLog.slice(1, _keepStart);
                const _historyStr = _compactRange
                  .map((m, i) => `[消息#${i + 1}] ${m.role}: ${m.content || ""}`)
                  .join("\n");

                // 与 setDataActions compactContext 一致的降级链：P7 → P1 → 任意启用且带 api_config 的预设
                let _p7Api = null;
                const _p7 = presetsData.presets?.find((p) => p.id === "P7");
                if (_p7?.api_config) _p7Api = _p7.api_config;
                else {
                  const _p1 = presetsData.presets?.find((p) => p.id === "P1");
                  if (_p1?.api_config) _p7Api = _p1.api_config;
                  else {
                    const _any = presetsData.presets?.find((p) => p.enabled && p.api_config);
                    if (_any?.api_config) _p7Api = _any.api_config;
                  }
                }

                let _summaryText = "";
                let _method = "auto_P7";
                if (_p7Api && _historyStr.trim()) {
                  // 接通：用户在面板编辑的 P7 prompts 优先（按当前模式选 prompts/_code/_work，
                  // 由 runMemoryPresetAI 自动替换 {{chat_history}}）；未配置有效 prompts 时回退单源默认指令。
                  const _t09Mode = _activeMode; // T4靶点③：T09 压缩按本窗模式选 P7 prompt 集。0715 单源收口：直接复用 :232 resolveInjectionContext 的裁决产物（原重调 getActiveMode=同请求第二次解析且不看 platform，bot 请求与主链分叉）
                  const _t09Set = _p7 ? pickPresetPromptSet(_p7, _t09Mode) : [];
                  let _compactPreset, _t09ChatHistory;
                  if (_p7 && p7HasMeaningfulPrompts(_t09Set)) {
                    _compactPreset = _p7;
                    _t09ChatHistory = _historyStr; // 真实历史经 {{chat_history}} 注入
                  } else {
                    _compactPreset = {
                      id: "P7_compact", name: "上下文压缩", enabled: true,
                      api_config: { ..._p7Api },
                      prompts: [
                        { role: "system", content: DEFAULT_COMPACT_MERGE_INSTRUCTIONS, identifier: "P7_system", enabled: true, builtin: true },
                        // 引导句已删（凛倾0712：代码禁产生进对话的文本）——system 侧默认指令已含压缩语义，user 侧只给数据
                        { role: "user", content: _historyStr, identifier: "P7_user", enabled: true, builtin: true },
                      ],
                    };
                    _t09ChatHistory = ""; // 历史已内联进合成 user prompt
                  }
                  try {
                    const _r = await runMemoryPresetAI(username, charName, _compactPreset, data, displayCharName, userName, _t09ChatHistory, { maxRounds: 1, chatId: _cid }); // T4靶点④
                    const _raw = (_r?.reply || "").trim();
                    if (_raw) {
                      let _parsed;
                      try { _parsed = JSON.parse(_raw); }
                      catch {
                        const _m = _raw.match(/\{[\s\S]*\}/);
                        if (_m) { try { _parsed = JSON.parse(_m[0]); } catch { _parsed = { summary: _raw }; } }
                        else _parsed = { summary: _raw };
                      }
                      _summaryText = _parsed.summary || _raw;
                    }
                  } catch (_p7e) {
                    wbD(_cid, "getprompt", "t09:p7CompactFail", false, _p7e.message, {});
                    diag.warn(`T09 auto_P7 AI压缩失败，降级机械裁剪: ${_p7e.message}`);
                  }
                }

                // AI 真失败/无可用源时才机械裁剪兜底
                if (!_summaryText) {
                  _method = "auto_fallbackPrune";
                  wbD(_cid, "getprompt", "t09:mechanicalPrune", false, "AI 压缩不可用，降级机械裁剪早期对话", { keepStart: _keepStart, hasP7Api: !!_p7Api });
                  _summaryText = `[...已省略 ${Math.max(0, _keepStart - 1)} 条早期对话（AI压缩不可用，机械裁剪）...]`;
                }

                const _finalSummary = [
                  _firstMsg,
                  `[早期对话压缩摘要 / ${_method}]:\n${_summaryText}`,
                  ..._recentMsgs,
                ].join("\n\n");
                const _summaryData = {
                  summary: _finalSummary,
                  keep_indices: [],
                  timestamp: new Date().toISOString(),
                  originalMsgCount: _chatLog.length,
                  keptMsgCount: _chatLog.length - _keepStart + 1,
                  method: _method,
                };
                // AI 完成后重读权威对话请求并重算条目序列锚点。回档/删除/新消息
                // 只要改变了生成来源，即使摘要 epoch 未被其他写者推进也拒绝旧结果。
                const _currentSourceRevision = _cid
                  ? await _readCurrentT09SourceRevision(arg, _cid)
                  : null;
                const _summaryCommit = _cid
                  ? await commitContextSummaryWrite(
                    username,
                    charName,
                    _cid,
                    _summaryWriteToken,
                    _summaryData,
                    { currentSourceRevision: _currentSourceRevision },
                  )
                  : (writeContextSummary(username, charName, _summaryData), { committed: true, legacy: true });
                if (_summaryCommit.committed !== true) {
                  wbD(_cid, "getprompt", "t09:summarySuperseded", false, _summaryCommit.code || "context summary write superseded", {
                    superseded: _summaryCommit.superseded === true,
                    busy: _summaryCommit.busy === true,
                    expected: _summaryCommit.expected || null,
                    actual: _summaryCommit.actual || null,
                    expectedSourceRevision: _summaryCommit.expectedSourceRevision || null,
                    actualSourceRevision: _summaryCommit.actualSourceRevision || null,
                  });
                  return;
                }
                diag.log(`T09 ${_method}: ${_chatLog.length}条→压缩${_compactRange.length}条+保留近${_chatLog.length - _keepStart}条`);
              } catch (_e) {
                wbD(_cid, "getprompt", "t09:autoCompactFail", false, _e.message, {});
                diag.warn(`T09 自动压缩失败: ${_e.message}`);
              } finally {
                _t09InFlight.delete(_cid || "_");
              }
            })();
          }
          }
          }
          }
        }
      }
    }

    // W24 §三: 输出管控 — 如果上次有违规，注入警告
    try {
      const _violPath = path.join(__projectRoot, "data", "users", username, "_output_filter_violations.json");
      if (fs.existsSync(_violPath)) {
        const _violations = JSON.parse(await fs.promises.readFile(_violPath, "utf-8"));
        if (Array.isArray(_violations) && _violations.length > 0) {
          const _warnLines = _violations.map(v => `- ${v.name}: ${v.message}`).join("\n");
          // 文案单源=DEFAULT_SYSTEM_TEXTS.output_filter(config.system_texts 可覆盖);XML 包裹=注入结构留代码
          const _ofText = (data.config?.system_texts?.output_filter || DEFAULT_SYSTEM_TEXTS.output_filter).replaceAll("{rules}", _warnLines);
          const _warnContent = `<output_filter_warning>\n${_ofText}\n</output_filter_warning>`;
          depthInjections.push({
            id: "OUTPUT_FILTER_WARNING",
            role: "user",
            content: _warnContent,
            depth: 0,
            order: 998,
          });
          // 消费后删除
          fs.unlinkSync(_violPath);
        }
      }
    } catch (_ofErr) {
      wbD(_cid, "getprompt", "outputFilterWarning:fail", false, _ofErr?.message || String(_ofErr), {});
      // 静默失败
    }

    // 溢出保护：总 token 超上下文窗口时，从最低优先级 depthInjection 开始裁剪，防 API 400
    {
      const _ovfLimit = resolveEffectiveMaxContextLive(username, _activeMode, _cid, getActivePresetName(username, _cid, _activeMode), charName);
      let _ovfUsed = depthInjections.reduce((s, d) => s + 4 + countTokensSync(d.content || ""), 0);
      const _chatLog = arg?.chat_log;
      if (_chatLog && Array.isArray(_chatLog)) {
        for (const e of _chatLog) _ovfUsed += 4 + countTokensSync(e.content || "");
      }
      _ovfUsed = Math.round(_ovfUsed * 1.2);
      if (_ovfLimit > 0 && _ovfUsed > _ovfLimit) {
        // [0722 硬编码注入收口] 同步改裁剪名单：数据类注入已迁 INJ-*-data 条目 id（旧 id 已不存在，留旧名=裁剪静默失效）
        const _trimOrder = ["TOKEN_WARNING", "OUTPUT_FILTER_WARNING", "INJ-flow-group-data", "INJ-p8-web-search-data", "INJ-chat-search-data", "INJ-parallel-delegate-data", "SELF_DRIVEN_P1", "INJ-p1-retrieval-data"];
        for (const tid of _trimOrder) {
          if (_ovfUsed <= _ovfLimit * 0.9) break;
          const idx = depthInjections.findIndex(d => d.id === tid);
          if (idx >= 0) {
            _ovfUsed -= Math.round((4 + countTokensSync(depthInjections[idx].content || "")) * 1.2);
            diag.log(`溢出保护: 裁剪 ${tid} (${depthInjections[idx].content?.length || 0}c), 剩余 ${_ovfUsed}/${_ovfLimit}`);
            depthInjections.splice(idx, 1);
          }
        }
      }
    }

    // !!!禁止放入提示词!!! [0722 拦截机制] 硬编码注入白名单强制：depthInjections 中 id 未在
    //   injection_prompts 注册（容 _N 多实例后缀）的条目 = 绕过配置的硬编码注入，直接拦截删除
    //   并 wbD 可见告警（不静默吞）。未来新增注入必须先在 default_memory_presets.json 注册条目
    //   （模板前端 INJ 面板可改），代码经 _pushDataInj 只供数据宏值。
    //   _pendingConvert = 尚未条目化的存量注入豁免名单（0722 二期收口对象），收完即删。
    {
      const _registeredInjIds = new Set(injectionPrompts.map((p) => p.id));
      // CODE_HOT_LAYER / WORK_HOT_LAYER 已移出：热层注入主 AI 整条删除（凛倾 20260726「热层只注入到 P1」），
      //   不是条目化、也不是继续豁免——注入本身不存在了，白名单里自然没有它们的位置。
      const _pendingConvert = new Set(["DAILY_GREETING", "context_summary", "TOKEN_WARNING", "OUTPUT_FILTER_WARNING"]); // SKILLS_INDEX 已随说明书库域删除（0723）
      const _blockedInj = [];
      for (let _wi = depthInjections.length - 1; _wi >= 0; _wi--) {
        const _rawId = String(depthInjections[_wi].id || "");
        const _baseId = _rawId.replace(/_\d+$/, "");
        if (!_registeredInjIds.has(_rawId) && !_registeredInjIds.has(_baseId) && !_pendingConvert.has(_rawId) && !_pendingConvert.has(_baseId)) {
          _blockedInj.push(_rawId);
          depthInjections.splice(_wi, 1);
        }
      }
      if (_blockedInj.length > 0) {
        wbD(_cid, "getprompt", "dataInj:hardcodeBlocked", false, `硬编码注入已拦截（未在 injection_prompts 注册）: ${_blockedInj.join(", ")}`, { blocked: _blockedInj });
      }
    }

    wbT(_cid, "getprompt", "extension:output", { textCount: Array.isArray(textEntries) ? textEntries.length : 0, depthCount: Array.isArray(depthInjections) ? depthInjections.length : 0, presetSwitchTo: _presetSwitchTarget || null, subModeModel: _subModeModel || null });
    wbT(_cid, "memory", "getPrompt:exit", { textLen: Array.isArray(textEntries) ? textEntries.length : 0, mode: _activeMode });
    return {
      text: textEntries,
      additional_chat_log: [],
      extension: {
        memory_depth_injections: depthInjections,
        cache_safety_adjustments: _cacheSafetyAdjustments,
        // [0717 串联收口] preset_switch_to 字段已删：P1 切换在解析点直走 switchPresetViaAPI 权威口，
        //   生成链不再携带预设写信号（0708「生成不碰预设状态」定案对齐；TweakPrompt 消费块同批镜像删除）
        // ★ 当前子模式的模型覆盖（每轮都传，不依赖runtime-params）
        sub_mode_model: _subModeModel || undefined,
        sub_mode_api_source: _subModeApiSource || undefined,
        sub_mode_max_context: _subModeMaxContext || undefined,
        sub_mode_max_tokens: _subModeMaxTokens || undefined,
        sub_mode_temperature: _subModeTemperature >= 0 ? _subModeTemperature : undefined,
        sub_mode_top_p: _subModeTopP >= 0 ? _subModeTopP : undefined, // T001：消费方=preset mergeRuntimeParams 子模式覆盖块
        sub_mode_top_k: _subModeTopK >= 0 ? _subModeTopK : undefined, // 链路2扩展：同 top_p 通路
        sub_mode_min_p: _subModeMinP >= 0 ? _subModeMinP : undefined, // 链路2扩展：同 top_p 通路

        sub_mode_post_process: _subModePostProcess || undefined,
        sub_mode_claude_prefill: _subModeClaudePrefill || undefined,
        // 确诊-B：boolean 直传（false 为有效意图，禁用 || undefined 否则 false 被吞成"无覆盖"）；
        //   undefined=无覆盖，消费方 preset/main.mjs mergeRuntimeParams 以 !== undefined 判定是否覆盖 prefill_enabled。
        sub_mode_prefill_enabled: _subModePrefillEnabled,
        // D3 0804：override 源加载失败的策略下发（消费方 char-template submode_source_override 分支：
        //   fail_closed=可见未发送错误不静默回退角色源；explicit_fallback=先试 fallback 源再默认源+trace）
        sub_mode_fallback_policy: _subModeFallbackPolicy || undefined,
        sub_mode_fallback_source: _subModeFallbackSource || undefined,
        // thinking 下发键已删（2026-08-01 收口到 AI 源面板 per-源单点）
        active_mode: _activeMode,
        active_project: _activeProject,
        code_active_files: _codeActiveFiles,
        env_info: _envInfo,
        code_token_status: _codeTokenStatus,
        code_sub_modes_list: (() => {
          if (_activeMode !== "code") return "";
          try {
            const _smPath = getYonbanConfigPath(username);
            const _smCfg = loadJsonFileIfExists(_smPath, { sub_modes: [] });
            // [0722 skill组隔离] 同上方 {{code_sub_modes_list}} 宏展开器：按当前组过滤，域单源 resolveSkillGroupDomain
            const _cDom = resolveSkillGroupDomain(username, charName, _cid, "code");
            const codeModes = (_smCfg.sub_modes || []).filter(sm => sm.modeGroup === "code" && (!_cDom || _cDom.modeIds.includes(sm.id)));
            if (codeModes.length === 0) return "(暂无IDE子模式)";
            return codeModes.map(sm => `- ${sm.id}: ${sm.label} — ${sm.desc || ""}`).join("\n");
          } catch { return ""; }
        })(),
        work_sub_modes_list: (() => {
          if (_activeMode !== "work") return "";
          try {
            const _smPath = getYonbanConfigPath(username);
            const _smCfg = loadJsonFileIfExists(_smPath, { sub_modes: [] });
            // [0722 skill组隔离] 同上方 {{work_sub_modes_list}} 宏展开器：按当前组过滤，域单源 resolveSkillGroupDomain
            const _wDom = resolveSkillGroupDomain(username, charName, _cid, "work");
            const workModes = (_smCfg.sub_modes || []).filter(sm => sm.modeGroup === "work" && (!_wDom || _wDom.modeIds.includes(sm.id)));
            if (workModes.length === 0) return "(暂无工作子模式)";
            return workModes.map(sm => `- ${sm.id}: ${sm.label} — ${sm.desc || ""}`).join("\n");
          } catch { return ""; }
        })(),
      },
    };
  } catch (e) {
    wbD(_cid, "memory", "getPrompt:topCatch", false, e.message, { stack: e.stack ? String(e.stack).slice(0, 300) : null });
    console.error("[beilu-memory] GetPrompt error:", e.message);
    injectionLog.push({
      timestamp: new Date().toISOString(), injectionCount: 0,
      p1Injected: false, hotMemoryLength: 0, tableDataLength: 0, error: e.message,
    });
    while (injectionLog.length > 20) injectionLog.shift();
    return null;
  }
}

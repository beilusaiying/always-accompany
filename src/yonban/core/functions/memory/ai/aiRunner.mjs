import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { renameSyncWithRetry } from "../../../../../scripts/nicerWriteFile.mjs";
import { readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // 0716 T019 差集收编：_pending_results 损坏备份后抛（防空表 push 写回覆盖整表）
import { getInjectText } from "../../injectTexts/main.mjs"; // 注入文本单源（铁律：进 messages 的文本用户可配置，默认值在 injectTexts CATALOG）
/**
 * aiRunner.mjs — 记忆插件 AI 调用引擎（P1检索 / P2总结 / 委派/分身 AI 调用核心）。
 *
 * 【功能链】
 *   提供 beilu-memory 内部所有需要调用 AI 的能力：
 *   - runMemoryPresetAI：多轮搜索循环 AI 调用核心（P1/P2/委派/分身/gameCompanion 均复用此函数），
 *     内部处理思维链剥离、标签解析、工具调用注入、多轮上下文回喂。
 *   - [已删除] triggerP1Retrieval（曾：异步触发 P1 检索 fire-and-forget，结果落 _lastP1Results Map 供下轮注入）——
*     凛倾 07-02 拍板"自驱动P1召回发散直接移除"后调用点已摘、07-03 授权删除，函数体已物理移除（死码，详见 :1461 附近注释）。
*     P1 现由 getPromptHandler.mjs S13 直接同步 await runMemoryPresetAI() 触发，不再经本函数中转。
 *   - triggerP2Summary：异步触发 P2 总结。0802 凛倾指令"P2 是手动触发"后，backgroundTasks
 *     的 onTriggerP2 自动回调调用点已注释（见 backgroundTasks.mjs autoCheckArchiveTriggers），
 *     现唯一真实触发路径是 setDataActions.mjs case "triggerP2Summary"（手动按钮）直接调用本函数。
 *   - pushMemoryAIOutput / memoryAIOutputQueue：AI 输出队列，供前端 SSE/WS 轮询消费。
 *   - 插件全局状态变量：pluginEnabled / pendingChatSearchResults 等
 *     （单一权威，getPromptHandler/replyHandler 直接 import 使用，不重复定义）。
 *   - P1 检索结果缓存 _lastP1Results（Map，按 username/charName/chatId 隔离）：
 *     真注入走 consumeLastP1Result（一次性消费），诊断只读走 peekLastP1Result（不消费）。
 *
 * 【why】
 *   P1/P2/委派/分身等多个流程都需要发起独立 AI 子调用，抽到此引擎避免重复造 API 调用逻辑；
 *   思维链剥离（stripReasoningTags）在回喂上下文前统一做——AI 不应看到自己的推理过程，
 *   但物理保留供用户在 UI 折叠查看，这个"剥给 AI / 保留给人"的分离在此单一处实现。
 *   pluginEnabled 等状态变量放在此模块是因为它是最底层的无环依赖节点，
 *   上层模块（getPromptHandler / replyHandler）都 import 此模块，反向 import 会产生循环。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块。触发路径有三条：
 *     1. getPromptHandler S13（P1）/ S18（P8）→ runMemoryPresetAI() 直接同步调用
*        （triggerP1Retrieval 已删除，07-02/07-03 拍板，见 :1461 附近注释）
 *     2. replyHandler parallelDelegate / 分身标签 → runMemoryPresetAI()（委派/分身子任务）
 *     3. setDataActions.mjs case "triggerP2Summary"（用户手动点按钮）→ triggerP2Summary()
 *        （backgroundTasks onTriggerP2 自动回调此前走这条路，0802 起调用点已注释，不再触发）
 *   AI 输出通过两条路径回前端：
 *     - _lastP1Results Map / pendingChatSearchResults → 下轮 GetPrompt 注入 → 随 prompt 传给 AI → AI 回复给用户
 *     - memoryAIOutputQueue → 前端 SSE 轮询 /api/memory-ai-output → 实时显示 P1/P2 进度面板
 *
 * 【关联链】
 *   ← getPromptHandler.mjs（runMemoryPresetAI — S13 P1 / S18 P8，均直接同步调用；triggerP1Retrieval 已删除见 :1461）
 *   ← replyHandler.mjs（runMemoryPresetAI 委派/分身 / pluginEnabled）
 *   ← setDataActions.mjs（case "triggerP2Summary" 手动按钮 → triggerP2Summary；backgroundTasks.mjs
 *     的 onTriggerP2 回调形参仍在但 0802 起调用点已注释，不再是实际触发源）
 *   ← gameCompanion.mjs（runMemoryPresetAI 游戏陪伴 AI 分析）
 *   → storage.mjs（loadMemoryData / loadMemoryPresets / saveTablesData 等）
 *   → replyParser.mjs（parseTableEditTags / parseMemoryArchiveTags / parseSearchQueryTags 等）
 *   → tableEngine.mjs（executeTableOperations / generateTableDataOnly）
 *   → archiver.mjs（executeMemoryArchiveOps）
 *   → retrieval.mjs（executeMemorySearchOps / formatSearchResultsForAI）
 *   → webSearch.mjs（executeWebSearch / buildInjectableSearchText — 联网功能层单一出口）
 *   → presetBridge.mjs（getActivePresetName / listPresetsForP1）
 *   → ideClient.mjs（读取工具文档/读缓存注入 P1 上下文）
 *   → parts_loader.mjs（loadAnyPreferredDefaultPart / loadPart — 加载 AI 源预设）
 *   → dataSystem.mjs（readRoute — {{code_route}} 宏）
 *
 * 【影响范围】
 *   - 写 _lastP1Results Map（内存，供下轮 GetPrompt 注入）
 *   - 写 pendingChatSearchResults（内存，供下轮 GetPrompt 注入）
 *   - 写 memoryAIOutputQueue（内存队列，前端 SSE 消费）
 *   - 通过 replyParser 函数间接触发：tables.json / code-work 热层 / 归档文件等写操作
 *   - 不直接广播 WS（广播由调用方 replyHandler 在返回值基础上执行）
 *
 * 【使用效果】
 *   P1 检索结果在当轮回复后异步完成，下轮对话时 AI 能看到最新检索结论；
 *   P2 总结现只能由用户手动点按钮触发（0802 起不再随归档自动异步跑），完成后热层记忆被精炼注入下轮；
 *   委派/分身在同轮内同步串行完成，结果通过 pendingResults 注入当轮 AI 继续上下文。
 *
 * 依赖：storage.mjs / replyParser.mjs / tableEngine.mjs / archiver.mjs / retrieval.mjs /
 *       webSearch.mjs / presetBridge.mjs / ideClient.mjs / parts_loader.mjs / dataSystem.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createArchiveSnapshot } from "../../rollback/snapshot.mjs"; // 归档前自动快照（凛倾0712；rollback→storage 单向无环）

// T002：记忆AI域后处理默认值（单点命名，禁再写字面量兜底）。
// 域语义：本值只管 P1/P2/委派/分身等记忆AI子调用（commander 模式需 squash+严格角色交替），
// 与主聊天链的 runtime-params 域默认（preset/main.mjs RUNTIME_PARAMS_DEFAULTS="none"）是
// 两个独立执行域、默认值有意不同——禁跨域"统一"（会改一方现行为）。
const MEMORY_AI_DEFAULT_POST_PROCESSING = "strict";

// 思维链「专门针对 AI 的正则删除」权威剥离器（含未闭合标签兜底 + 用户自定义 reasoning_tags），
// 与 proxy 出站 messageTransform 同源。用于轮内回喂上下文：AI 不可见但物理保留供用户折叠看。
import { stripReasoningTags } from "../../api/proxy/lib/messageTransform.mjs"; // T8·回切：改指 yonban 新位实现体（原经 public 薄壳 re-export，已删壳）


import {
  loadAnyPreferredDefaultPart,
  loadPart,
} from "../../../../../server/parts_loader.mjs";

import {
  __pluginDir,
  __projectRoot,
  ensureMemoryDir,
  getActiveMode,
  getTimeMacroValues,
  getTodayStr,
  loadJsonFile,
  loadJsonFileIfExists,
  loadMemoryData,
  loadMemoryPresets,
  getSystemText,
  resolveActiveSubModeId,
  resolveSkillGroupDomain, // [0722 skill组隔离] {{sub_modes_all}} 宏按当前组过滤，与主链宏/切换域同源
  saveJsonFile,
  saveTablesData,
  withFileLock,
  getYonbanConfigPath,
  getCodeConfigPath,
  appendPendingTasks, // T5-4：memoryNote pending_tasks 落盘收口（解析层不再直写）
  isPathSafe, // 0716 路径前缀边界修复：收口内联 resolve().startsWith 到权威守卫
} from "../storage_mod/storage.mjs";

import {
  parseMemoryArchiveTags,
  parseMemoryNoteTags,
  parseMemorySearchTags,
  parseNoSearchTag,
  parseSearchQueryTags,
  parseSearchResultTags,
  parseTableEditTags,
  parseVocabEditTags, // P9 词库维护 <vocab_edit>（2026-07-31 002拍板）
} from "../handler/replyParser.mjs";
// P9 词库维护执行层（0731 子模式化提升为单点收口，与 replyHandler 正常对话链共享；
//   p1Bridge 读写在其内部，本文件不再直接触碰词库文件）
import { executeVocabEditOps } from "../tools/vocabEditExec.mjs";

// [0726「底部功能层.txt」第44行收口] 本文件是 P8 传导链，只搬运：结果→AI 可读文本的格式化、
//   相关度打印、SEC-T8 不可信边界包裹三件事全在功能层 buildInjectableSearchText 单源（chat/分身链同调）。
import { executeWebSearch, buildInjectableSearchText } from "../../web/webSearch.mjs";
import { getActivePresetName, listPresetsForP1 } from "./presetBridge.mjs";

import {
  executeTableOperations,
  generateTableDataOnly,
  readHotMemoryForInjection,
} from "../storage_mod/tableEngine.mjs";

import { executeMemoryArchiveOps } from "../storage_mod/archiver.mjs";

import {
  readRoute as _dsReadRoute,
} from "../data/dataSystem.mjs";

import {
  executeMemorySearchOps,
  formatSearchResultsForAI,
} from "../storage_mod/retrieval.mjs";
// [0728 top-k] "读到内容的文件"提取规则单源（与 replyHandler 共用，禁复制提取逻辑）
import { collectTouchedFiles } from "../storage_mod/recallStats.mjs";

import { getClientEnvString } from "../../../transport/ideClient.mjs";


// ============================================================
// 插件状态变量
// ============================================================

export let pluginEnabled = true;

export function setPluginEnabled(val) {
  pluginEnabled = !!val;
}

/** P1 检索AI结果缓存（一次性消费）— 按username/charName/chatId隔离防跨角色/跨窗窜值 */
// T6-6：原并存的全局单值 lastP1Result 已删。它只被诊断侧读，却是"最后任意窗口的结果"，
// 多窗口下诊断面板会串显别窗口的 P1 结果（双键表达同一语义，语义漂移）。诊断读改走本 Map
// 的只读探针 peekLastP1Result（按本窗上下文取，不消费），语义收敛为单键。
const _lastP1Results = new Map();

export function setLastP1Result(val, username, charName, chatId = null) {
  // T4靶点④：加 chatId 维防跨窗抢注（一次性消费）。无 chatId 落 "_" 槽=旧行为。
  const base = (username && charName) ? `${username}/${charName}` : "_default";
  _lastP1Results.set(`${base}/${chatId || "_"}`, val);
}

export function consumeLastP1Result(username, charName, chatId = null) {
  const base = (username && charName) ? `${username}/${charName}` : "_default";
  // 先取本窗槽，miss 回退 "_" 槽（面板手动跑 P1 不带窗口上下文时仍可被消费，兼容不破）
  for (const key of [`${base}/${chatId || "_"}`, `${base}/_`]) {
    if (_lastP1Results.has(key)) {
      const r = _lastP1Results.get(key) || null;
      _lastP1Results.delete(key);
      return r;
    }
  }
  return null;
}

// T6-6：诊断只读探针。与 consumeLastP1Result 同槽/同回退逻辑，但**不 delete**（诊断读不能
// 消费掉真注入用的结果）。本窗无 P1 结果时返回 null，诊断如实显示"无"（语义保持）。
export function peekLastP1Result(username, charName, chatId = null) {
  const base = (username && charName) ? `${username}/${charName}` : "_default";
  for (const key of [`${base}/${chatId || "_"}`, `${base}/_`]) {
    if (_lastP1Results.has(key)) return _lastP1Results.get(key) || null;
  }
  return null;
}

/**
 * 聊天AI检索结果缓存（下轮 GetPrompt 一次性注入后清除）
 *
 * Key: "username/charName/chatid#feature" —— **线路 × 功能** 两个维度。
 *
 * 【why 必须带 feature 维度·「底部功能层.txt」第 40-44 / 88-89 行】
 *   架构原文：「AIRP/Code/Work ─→ 输入/缓存/处理（隔离）」「功能层是一个，单次传导/缓存/处理是 3 个+n」
 *   「我们的功能就是被激活的，进行一个派发，**a 和 b 同时激活那就是工作两次，直接异步，也就是说不影响**」。
 *   即：同一条线路上的多个功能各自激活、各自产出，互不影响。
 *   原 key 只有线路维度（username/charName/chatid），却被两个不同功能共用——
 *   `<memorySearch>` 记忆检索(a) 与 `<needWebSearch>` 联网搜索(b) 同轮触发时，
 *   后写的 Map.set 直接覆盖先写的，a 的结果静默消失且无报错（0726 实证）。
 *   这正是架构文档说的「因为现在是高耦合」。加 feature 槽后两者天然并存，不需要任何合并/避让逻辑。
 * @type {Map<string, {results: string, timestamp: string}>}
 */
export const pendingChatSearchResults = new Map();

/** 检索结果槽 key（单源：写/读/清三侧共用，防两处各写一份格式而漂移）。 */
export function chatSearchSlotKey(username, charName, cid, feature) {
  return `${username}/${charName}/${cid || "_"}#${feature}`;
}

/** 取某条线路上的全部功能槽 → [[key, value, feature], ...]（读侧一次拿齐，各功能独立可辨）。 */
export function listChatSearchSlots(username, charName, cid) {
  const prefix = `${username}/${charName}/${cid || "_"}#`;
  const out = [];
  for (const [k, v] of pendingChatSearchResults) {
    if (k.startsWith(prefix)) out.push([k, v, k.slice(prefix.length)]);
  }
  return out;
}

/**
 * tableEdit 失败反馈（断点#5 修 0716）：replyHandler 写 → getPromptHandler 下轮注入后清除。
 * Key: "username/charName/chatid"
 * @type {Map<string, {failures: Array<{op:string,reason:string}>, timestamp: string}>}
 */
export const pendingTableEditFeedback = new Map();

/**
 * peek：指定对话是否有待注入的聊天AI搜索结果（0716 M1 同轮闭环：generation 续轮决策用，不消费——
 * 消费仍由 getPromptHandler 既有注入器 get+delete，续轮 GetPrompt 即注入=「搜完立刻生成」）。
 * 按 key 尾段 /cid 匹配：cid 全局唯一，避开 charName/char_id 值域差异。
 * @param {string} cid
 * @returns {boolean}
 */
export function hasPendingChatSearchForChat(cid) {
  if (!cid) return false;
  // key 尾部现在是 "#feature"（0726 功能槽维度），故判据从 endsWith(`/${cid}`) 改为含 `/${cid}#`——
  //   不改会恒 false，worker 路由下的续轮上报（groupReplyRunner reply.pendingWebSearch）随之失效
  const _mid = `/${cid}#`;
  for (const k of pendingChatSearchResults.keys()) if (k.includes(_mid)) return true;
  return false;
}

/**
 * GetPrompt 注入日志（供前端诊断面板显示）
 * @type {Array<object>}
 */
export const injectionLog = [];
/**
 * P1 运行互斥锁（角色卡级别隔离）
 * Key: "username/charName"
 * ★ B07修复：从全局 boolean 改为 Map，不同角色 P1 独立运行，同一角色仍互斥
 */
export const isP1RunningMap = new Map();

/** 兼容旧调用：返回当前是否有任意角色的 P1 在运行 */
export function isP1Running() {
  for (const v of isP1RunningMap.values()) if (v) return true;
  return false;
}

/**
 * 本轮对话是否已触发过 P1（角色卡级别隔离）
 * Key: "username/charName"
 */
export const p1TriggeredMap = new Map();

export function resetP1TriggerFlag(username, charName) {
  const key = `${username}/${charName}`;
  p1TriggeredMap.set(key, false);
}

/**
 * 内容级防重 — 记录最近处理过的 tableEdit 内容 hash
 * Map<"username/charName", { hash: string, timestamp: number }>
 */
export const lastProcessedTableEditHash = new Map();

// ============================================================
// 记忆AI输出队列
// ============================================================

/** @type {Array<object>} */
export const memoryAIOutputQueue = [];

let _outputIdCounter = 0;

/**
 * 推送记忆AI输出到队列
 */
export function pushMemoryAIOutput(output) {
  _outputIdCounter++;
  const entry = {
    id: _outputIdCounter,
    ...output,
    timestamp: output.timestamp || new Date().toISOString(),
  };
  memoryAIOutputQueue.push(entry);
  while (memoryAIOutputQueue.length > 20) memoryAIOutputQueue.shift();
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 计算 tableEdit 内容的简单 hash — 已移至 replyParser.mjs，此处仅保留re-export兼容
 */
// export function computeTableEditHash → 见 replyParser.mjs（grep `export function computeTableEditHash`）

/**
 * 读取 beilu-preset 插件的预设列表（用于 P1 检索AI 的 {{presetList}} 宏）
 * @param {object} [p1Preset] - P1 预设对象（可选）
 * @returns {string}
 */
export function getPresetListForP1(username, p1Preset) {
  try {
    const presets = listPresetsForP1(username); // [T065] 预设列表 per-user
    if (presets.length === 0) return "(无可用预设)";

    const customDescMap = {};
    if (
      p1Preset?.preset_switch_entries &&
      Array.isArray(p1Preset.preset_switch_entries)
    ) {
      for (const entry of p1Preset.preset_switch_entries) {
        if (entry.preset_name && entry.description) {
          customDescMap[entry.preset_name] = entry.description;
        }
      }
    }

    return presets
      .map((p) => {
        const active = p.active ? " [当前]" : "";
        const desc = customDescMap[p.name] || p.description;
        const modeTag = p.mode ? ` [模式:${p.mode}]` : "";
        const triggersTag =
          Array.isArray(p.mode_triggers) && p.mode_triggers.length > 0
            ? ` [触发词:${p.mode_triggers.join(",")}]`
            : "";
        return `- ${p.name}${active}${modeTag}${triggersTag}${desc ? ": " + desc : ""}`;
      })
      .join("\n");
  } catch (e) {
    console.warn("[beilu-memory] 读取预设列表失败:", e.message);
    return "(读取预设列表失败)";
  }
}

/**
 * 从 P1 AI 回复中提取 <presetSwitch> 标签
 */
export function parsePresetSwitchTag(content) {
  if (!content) return { presetName: null, cleanContent: content };

  const match = content.match(/<presetSwitch>([\s\S]*?)<\/presetSwitch>/i);
  if (match) {
    const presetName = match[1].trim();
    const cleanContent = content
      .replace(/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi, "")
      .trim();
    return { presetName: presetName || null, cleanContent };
  }

  // 兜底：匹配开标签但闭合标签被截断的情况
  const partialMatch = content.match(/<presetSwitch>([^<]+)/i);
  if (partialMatch) {
    const presetName = partialMatch[1].trim();
    if (presetName) {
      console.warn(
        `[beilu-memory] parsePresetSwitchTag: 检测到截断的 presetSwitch 标签，提取预设名: "${presetName}"`,
      );
      const cleanContent = content
        .replace(/<presetSwitch>[^<]*/i, "")
        .replace(/<\/p\w*$/i, "")
        .trim();
      return { presetName, cleanContent };
    }
  }

  return { presetName: null, cleanContent: content };
}

// ============================================================
// 核心：runMemoryPresetAI
// ============================================================

/**
 * 运行记忆预设AI（独立调用，支持多轮搜索循环）
 * @param {string} username
 * @param {string} charName
 * @param {object} preset
 * @param {object} memData
 * @param {string} displayCharName
 * @param {string} displayUserName
 * @param {string} chatHistory
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runMemoryPresetAI(
  username,
  charName,
  preset,
  memData,
  displayCharName,
  displayUserName,
  chatHistory,
  options = {},
) {
  wbT(null, "aiRunner", "runMemoryPresetAI:enter", { username, charName, presetId: preset.id, presetName: preset.name });
  const apiConfig = preset.api_config || {};
  // [0726 死键接线·002「死键接」] web_search.p8_source 此前**后端零消费**（前端面板可填、UI 写着
  //   "沿用预设"，实际填了永远没用）。现接为 **P8 专属 AI 源覆盖**：仅当本次跑的是 P8 且该键非空时
  //   生效，其余预设完全不受影响（P8 是联网工具型 AI，允许它用与记忆链不同的源——如更快更便宜的模型）。
  //   优先级：p8_source > preset.api_config.source > 系统默认。必须同时放行 use_custom 门（:397 原判据
  //   `apiConfig.use_custom && configSourceName`，P8 的 use_custom=false 会把覆盖挡掉=半接线陷阱）。
  //   注意只放行**服务源**这道门：下方 :952 的模型参数覆盖块（model/temperature/max_tokens）仍按
  //   apiConfig.use_custom 判——换源后沿用该源自己的默认模型才合理，否则会把 gemini 的模型名发给别的源。
  const _p8SrcOverride = (preset.id === "P8" && typeof memData?.config?.web_search?.p8_source === "string")
    ? memData.config.web_search.p8_source.trim() : "";
  const configSourceName = _p8SrcOverride || apiConfig.source || "";
  // 不写 apiConfig.use_custom（那是 preset.api_config 的引用，改它会污染内存里的预设对象）——
  //   改用局部量参与下方门判定。
  const _useCustomSource = !!_p8SrcOverride || !!apiConfig.use_custom;
  const retrievalConfig = memData.config?.retrieval || {};
  const maxRounds = options.maxRounds || retrievalConfig.max_search_rounds || 5;
  const timeoutMs = retrievalConfig.timeout_ms || 60000;

  // 1. 加载 AI 服务源
  let aiSource;
  let actualSourceName = configSourceName || "(系统默认)";
  if (!options.dryRun) {
    try {
      if (_useCustomSource && configSourceName) {
        aiSource = await loadPart(
          username,
          `serviceSources/AI/${configSourceName}`,
        );
        actualSourceName = configSourceName;
      } else {
        aiSource = await loadAnyPreferredDefaultPart(
          username,
          "serviceSources/AI",
        );
        actualSourceName =
          aiSource?.info?.name || aiSource?.name || "(系统默认)";
      }
    } catch (e) {
      if (configSourceName) {
        try {
          aiSource = await loadPart(
            username,
            `serviceSources/AI/${configSourceName}`,
          );
          actualSourceName = configSourceName;
        } catch (e2) {
          throw new Error(
            `无法加载 AI 服务源 "${configSourceName}": ${e2.message}`,
          );
        }
      } else {
        wbD(null, "aiRunner", "runMemoryPresetAI:loadAISource", false, `无法加载默认AI服务源: ${e.message}`, { presetId: preset.id });
        throw new Error(`无法加载默认 AI 服务源: ${e.message}`);
      }
    }
  }

  if (!options.dryRun && !aiSource) {
    wbD(null, "aiRunner", "runMemoryPresetAI:aiSourceEmpty", false, "AI服务源加载结果为空", { source: configSourceName });
    throw new Error(
      `AI 服务源加载结果为空 (source="${configSourceName || "(默认)"}")，请检查服务源配置`,
    );
  }
  wbT(null, "aiRunner", "runMemoryPresetAI:aiSourceLoaded", { source: configSourceName || "(默认)" });

  // 2. 组装初始 prompt messages
  const tableDataText = generateTableDataOnly(
    memData.tables,
    displayCharName,
    displayUserName,
  );
  let hotMemoryText = readHotMemoryForInjection(username, charName);
  if (hotMemoryText) {
    hotMemoryText = hotMemoryText
      .replace(/\{\{char\}\}/g, displayCharName)
      .replace(/\{\{user\}\}/g, displayUserName);
  }

  // Phase 2: 根据当前模式选择提示词组（prompts / prompts_code / prompts_work）
  const activeMode = getActiveMode(username, charName, options.chatId || null); // T4靶点④：有窗口上下文时按本窗模式选组（null=char级回退，行为同旧）
  // 子模式数据读取（供 {{sub_mode}} / {{sub_mode_desc}} 宏替换）
  let _macroSubModeLabel = "";
  let _macroSubModeDesc = "";
  try {
    const _smConfigPath = getYonbanConfigPath(username);
    const _smCfg = loadJsonFileIfExists(_smConfigPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
    const _asmId = resolveActiveSubModeId(_smCfg, activeMode, options.chatId || null); // T4靶点④：{{sub_mode}} 宏按本窗子模式（无 chatId 走全局回退，行为同旧）
    if (_asmId && Array.isArray(_smCfg.sub_modes)) {
      const _asm = _smCfg.sub_modes.find(m => m.id === _asmId);
      if (_asm) {
        _macroSubModeLabel = _asm.label || _asmId;
        _macroSubModeDesc = _asm.desc || "";
      }
    }
  } catch (_smErr) {
    // 静默失败，子模式宏替换为空
  }
  let promptsToUse;
  let promptsSourceLabel = "prompts";
  if (
    activeMode === "live" &&
    Array.isArray(preset.prompts_live) &&
    preset.prompts_live.length > 0
  ) {
    // [0727] 直播模式提示词组（002:「加一个直播的，直播专门的路线，4个」）
    promptsToUse = preset.prompts_live;
    promptsSourceLabel = "prompts_live";
  } else if (
    activeMode === "work" &&
    Array.isArray(preset.prompts_work) &&
    preset.prompts_work.length > 0
  ) {
    promptsToUse = preset.prompts_work;
    promptsSourceLabel = "prompts_work";
  } else if (
    activeMode === "code" &&
    Array.isArray(preset.prompts_code) &&
    preset.prompts_code.length > 0
  ) {
    promptsToUse = preset.prompts_code;
    promptsSourceLabel = "prompts_code";
  } else {
    promptsToUse = preset.prompts || [];
    promptsSourceLabel = "prompts";
  }
  console.log(
    `[beilu-memory] runMemoryPresetAI: ${preset.id} 使用 ${promptsSourceLabel} (mode=${activeMode})`,
  );

  // 任务A：计算编程模式宏数据（供记忆AI提示词宏替换使用）
  let _macroActiveProject = "";
  let _macroCodeActiveFiles = "";
  let _macroEnvInfo = "";
  if (activeMode === "code") {
    try {
      const _memDir = ensureMemoryDir(username, charName);
      const _codeConfigPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点
      if (fs.existsSync(_codeConfigPath)) {
        const _cc = loadJsonFileIfExists(_codeConfigPath, {});
        _macroActiveProject = _cc?.active_project || "";
      }
      const _activeDir = path.join(_memDir, "code", "active");
      if (fs.existsSync(_activeDir)) {
        const _mdFiles = fs
          .readdirSync(_activeDir)
          .filter((f) => f.endsWith(".md"));
        _macroCodeActiveFiles = _mdFiles.length > 0 ? _mdFiles.join("\n") : "";
      }
    } catch (e) {
      console.warn(
        "[beilu-memory] runMemoryPresetAI: 读取编程记忆数据失败:",
        e.message,
      );
    }
  }

  // 热层全文（凛倾 20260726 裁决「热层只注入到 P1，不注入到主 AI」）：
  //   主 AI 侧原 CODE_HOT_LAYER/WORK_HOT_LAYER 硬编码注入已整条删除（getPromptHandler），
  //   P1 此前只拿得到 {{code_active_files}}=文件名列表 / {{available_data}}=清单，**读不到内容**。
  //   此处为 P1 提供内容通道：宏 {{codeHotLayer}} / {{workHotLayer}}（宏名沿用原有，
  //   与 wiki/macros 文档一致）。只做机制供数据，预设里用不用是用户的事。
  //   容量上限沿用既有配置键 injection.hot_md_max_chars / work_hot_max_chars（默认 40000/30000），
  //   不新造硬编码数字；`_` 前缀元文件（_index.md）跳过，与原主 AI 侧口径一致。
  let _macroCodeHotLayer = "";
  let _macroWorkHotLayer = "";
  if (activeMode === "code" || activeMode === "work") {
    try {
      const _memDir = ensureMemoryDir(username, charName);
      const _hotDir = path.join(_memDir, activeMode, "active");
      if (fs.existsSync(_hotDir)) {
        const _cfg = memData?.config?.injection || {};
        const _max = activeMode === "code"
          ? (_cfg.hot_md_max_chars || 40000)
          : (_cfg.work_hot_max_chars || 30000);
        const _parts = [];
        let _total = 0;
        for (const _f of fs.readdirSync(_hotDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort()) {
          try {
            const _c = fs.readFileSync(path.join(_hotDir, _f), "utf-8");
            if (_total + _c.length > _max) continue; // 超限跳过该文件（同原主 AI 侧策略）
            _parts.push(`### 📄 ${_f}\n${_c}`);
            _total += _c.length;
          } catch (_fe) { console.warn(`[beilu-memory] P1 热层读取失败 ${_f}: ${_fe.message}`); }
        }
        const _text = _parts.length > 0 ? _parts.join("\n\n---\n\n") : "";
        if (activeMode === "code") _macroCodeHotLayer = _text;
        else _macroWorkHotLayer = _text;
      }
    } catch (e) {
      console.warn("[beilu-memory] P1 热层构建失败:", e.message);
    }
    // 环境信息
    const _platform =
      typeof process !== "undefined" ? process.platform : "unknown";
    const _timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const _today = new Date().toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const _envParts = [
      `Working directory: ${__projectRoot}`,
      `Platform: ${_platform}`,
      `Today's date: ${_today}`,
      `Timezone: ${_timezone}`,
    ];
    if (_macroActiveProject)
      _envParts.push(`Active project: ${_macroActiveProject}`);
    _macroEnvInfo = `<env>\n  ${_envParts.join("\n  ")}\n</env>`;
  }

  // 任务G：编程/工作模式 P1 搜索范围扩展（准备 {{available_data}} 宏）
  // work 同 code 三层结构：active(热)/archive(温,含本次自动归档落点)/outputs(冷)。
  // 修黑洞：原仅 code 读 archive，work/archive 只写不读 → 此处镜像扩展到 work。
  let _availableDataText = "";
  if (activeMode === "code" || activeMode === "work") {
    try {
      const _memDir = ensureMemoryDir(username, charName);
      const _sources = [];
      let _totalEstTokens = 0;
      const _MAX_SEARCH_TOKENS = 30000;
      const _mRoot = activeMode === "code" ? "code" : "work";
      const _coldSub = activeMode === "code" ? "projects" : "outputs";

      // 热层：递归读取日期目录，归档的 JSON/MD 都要进入 P1 可用数据清单。
      const _hotDir = path.join(_memDir, _mRoot, "active");
      const _walkHot = (dir, rel = "") => {
        if (!fs.existsSync(dir)) return;
        for (const _entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const _fp = path.join(dir, _entry.name);
          const _rel = rel ? `${rel}/${_entry.name}` : _entry.name;
          if (_entry.isDirectory()) _walkHot(_fp, _rel);
          else if (_entry.name.endsWith(".md") || _entry.name.endsWith(".json")) {
            const _est = Math.round(fs.statSync(_fp).size / 3);
            _sources.push({ name: _rel, layer: "hot", tokens: _est });
            _totalEstTokens += _est;
          }
        }
      };
      _walkHot(_hotDir);
      // 温层 <mode>/archive/：表格行归档落点（20260726 从 hot/archive/tables/ 归位于此）
      //   + 旧经验表专线遗留的 *_archive.json 存量（该专线已删，只读不再生产）
      const _warmDir = path.join(_memDir, _mRoot, "archive");
      if (fs.existsSync(_warmDir)) {
        for (const _f of fs.readdirSync(_warmDir)) {
          const _fp = path.join(_warmDir, _f);
          if (fs.statSync(_fp).isFile()) {
            const _est = Math.round(fs.statSync(_fp).size / 3);
            _sources.push({ name: _f, layer: "warm", tokens: _est });
            _totalEstTokens += _est;
          }
        }
      }
      // 冷层（code=projects/<proj>/ 子目录；work=outputs 可能平铺文件，两种都收）
      const _coldDir = path.join(_memDir, _mRoot, _coldSub);
      if (fs.existsSync(_coldDir)) {
        for (const _proj of fs.readdirSync(_coldDir)) {
          const _projDir = path.join(_coldDir, _proj);
          const _stat = fs.statSync(_projDir);
          if (_stat.isDirectory()) {
            for (const _f of fs.readdirSync(_projDir)) {
              if (_f.endsWith(".md") || _f.endsWith(".json")) {
                const _fp = path.join(_projDir, _f);
                const _est = Math.round(fs.statSync(_fp).size / 3);
                _sources.push({
                  name: `${_proj}/${_f}`,
                  layer: "cold",
                  tokens: _est,
                });
                _totalEstTokens += _est;
              }
            }
          } else if (_proj.endsWith(".md") || _proj.endsWith(".json")) {
            const _est = Math.round(_stat.size / 3);
            _sources.push({ name: _proj, layer: "cold", tokens: _est });
            _totalEstTokens += _est;
          }
        }
      }

      // Token裁剪：优先保留热层
      const _included = [];
      const _excluded = [];
      let _usedTokens = 0;
      const _priorityOrder = { hot: 3, warm: 2, cold: 1 };
      _sources.sort(
        (_a, _b) =>
          (_priorityOrder[_b.layer] || 0) - (_priorityOrder[_a.layer] || 0),
      );

      for (const _s of _sources) {
        if (_usedTokens + _s.tokens <= _MAX_SEARCH_TOKENS) {
          _included.push(_s);
          _usedTokens += _s.tokens;
        } else {
          _excluded.push(_s);
        }
      }

      _availableDataText = _included
        .map((_s) => `[${_s.layer}] ${_s.name} (~${_s.tokens} tokens)`)
        .join("\n");
      if (_excluded.length > 0) {
        _availableDataText +=
          "\n\n⚠️ 以下文件因Token限制未加载：\n" +
          _excluded.map((_s) => `[${_s.layer}] ${_s.name}`).join("\n");
      }
    } catch (_e) {
      console.warn("[beilu-memory] P1搜索范围准备失败:", _e.message);
    }
  } else {
    // [0717 凛倾定案] P2-P6 不做 code/work 变体，通用版靠宏看目录——{{available_data}} 补陪伴域分支：
    //   hot/ + warm/YYYY/MM/**(受限深度 walk) + cold/，同上方 code/work 的 token 裁剪范式（热>温>冷）。
    //   此前该宏 chat 模式恒 "(无可用数据)"，P2-P6 想知道有哪些批次/文件只能盲拼路径靠检索轮试。
    try {
      const _memDir = ensureMemoryDir(username, charName);
      const _sources = [];
      const _MAX_SEARCH_TOKENS = 30000;
      const _MAX_FILES = 300; // 目录清单行数硬上限，防超大记忆库把宏撑爆
      const _pushFile = (_name, _layer, _fp) => {
        if (_sources.length >= _MAX_FILES) return;
        try { _sources.push({ name: _name, layer: _layer, tokens: Math.round(fs.statSync(_fp).size / 3) }); } catch { /* 单文件 stat 失败跳过 */ }
      };
      const _walk = (_dir, _rel, _layer, _depth) => {
        if (_depth > 4 || _sources.length >= _MAX_FILES || !fs.existsSync(_dir)) return;
        for (const _f of fs.readdirSync(_dir)) {
          const _fp = path.join(_dir, _f);
          let _st; try { _st = fs.statSync(_fp); } catch { continue; }
          const _r = _rel ? `${_rel}/${_f}` : _f;
          if (_st.isDirectory()) _walk(_fp, _r, _layer, _depth + 1);
          else _pushFile(_r, _layer, _fp);
        }
      };
      _walk(path.join(_memDir, "hot"), "", "hot", 1);
      _walk(path.join(_memDir, "warm"), "", "warm", 1);
      _walk(path.join(_memDir, "cold"), "", "cold", 1);

      const _included = [];
      const _excluded = [];
      let _usedTokens = 0;
      const _priorityOrder = { hot: 3, warm: 2, cold: 1 };
      _sources.sort((_a, _b) => (_priorityOrder[_b.layer] || 0) - (_priorityOrder[_a.layer] || 0));
      for (const _s of _sources) {
        if (_usedTokens + _s.tokens <= _MAX_SEARCH_TOKENS) { _included.push(_s); _usedTokens += _s.tokens; }
        else _excluded.push(_s);
      }
      _availableDataText = _included.map((_s) => `[${_s.layer}] ${_s.name} (~${_s.tokens} tokens)`).join("\n");
      if (_excluded.length > 0) {
        _availableDataText += "\n\n⚠️ 以下文件因Token限制未列全：\n" + _excluded.map((_s) => `[${_s.layer}] ${_s.name}`).join("\n");
      }
    } catch (_e) {
      console.warn("[beilu-memory] 陪伴域目录清单准备失败:", _e.message);
    }
  }

  const messages = [];
  // 向量初筛候选（0722 接入 P1 拍板：P1 接收 表格+热层+向量候选）：优先跟在 chat_history
  // 消息之后；预设无 {{chat_history}} 条目时循环后兜底追加。无候选=无消息（凛倾0712：代码禁产生进对话的文本）
  let _extraCtxPushed = false;
  for (const prompt of promptsToUse) {
    if (!prompt.enabled) continue;

    let content = prompt.content || "";

    // 内置宏条目 role 消费条目自身值（默认 system）——原硬编码 user/system 导致前端改身份不生效（凛倾0711）
    const _builtinRole =
      prompt.role === "user" ? "user" : prompt.role === "assistant" ? "assistant" : "system";

    if (prompt.builtin && content === "{{chat_history}}") {
      // 空历史不塞占位文本（凛倾0712：代码禁产生进对话的文本）——无数据=无消息，诚实降级
      if (chatHistory) messages.push({ role: _builtinRole, content: chatHistory });
      if (options.extraContext && !_extraCtxPushed) {
        messages.push({ role: _builtinRole, content: options.extraContext });
        _extraCtxPushed = true;
      }
      continue;
    }

    if (prompt.builtin && content === "{{presetList}}") {
      if (preset.preset_switch_auto === false) continue;
      const presetListText = getPresetListForP1(username, preset);
      if (presetListText) {
        messages.push({ role: _builtinRole, content: presetListText });
      }
      continue;
    }

    // 提取最后一条用户消息
    let lastUserMessage = options.lastUserMessage || "";
    if (!lastUserMessage && chatHistory) {
      const segments = chatHistory.split("\n\n");
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].startsWith(displayUserName + ":")) {
          lastUserMessage = segments[i]
            .slice(displayUserName.length + 1)
            .trim();
          break;
        }
      }
    }

    const _tm = getTimeMacroValues();

    content = content
      .replace(/\{\{tableData\}\}/g, tableDataText)
      .replace(/\{\{hotMemory\}\}/g, hotMemoryText || "")
      .replace(/\{\{char\}\}/g, displayCharName)
      .replace(/\{\{user\}\}/g, displayUserName)
      .replace(/\{\{current_date\}\}/g, getTodayStr())
      .replace(/\{\{chat_history\}\}/g, chatHistory || "")
      .replace(/\{\{lastUserMessage\}\}/g, lastUserMessage)
      .replace(/\{\{time\}\}/g, _tm.time)
      .replace(/\{\{currentTime\}\}/g, `${_tm.date} ${_tm.weekday} ${_tm.time}`)
      .replace(/\{\{date\}\}/g, _tm.date)
      .replace(/\{\{weekday\}\}/g, _tm.weekday)
      .replace(/\{\{idle_duration\}\}/g, _tm.idle_duration)
      .replace(/\{\{lasttime\}\}/g, _tm.lasttime)
      .replace(/\{\{lastdate\}\}/g, _tm.lastdate)
      .replace(
        /\{\{presetList\}\}/g,
        preset.preset_switch_auto === false ? "" : getPresetListForP1(username, preset),
      )
      .replace(/\{\{current_mode\}\}/g, activeMode)
      .replace(/\{\{sub_mode\}\}/g, _macroSubModeLabel || "")
      .replace(/\{\{sub_mode_desc\}\}/g, _macroSubModeDesc || "")
      .replace(/\{\{sub_modes_all\}\}/g, () => {
        try {
          const _smaPath = getYonbanConfigPath(username);
          const _smaCfg = loadJsonFileIfExists(_smaPath, { sub_modes: [] });
          // [0722 skill组隔离] 与 getPromptHandler {{sub_modes_all}} 同规则：各 modeGroup 按当前组过滤（域单源）
          const _smaCDom = resolveSkillGroupDomain(username, charName, options.chatId || null, "code");
          const _smaWDom = resolveSkillGroupDomain(username, charName, options.chatId || null, "work");
          const _smaList = (_smaCfg.sub_modes || []).filter(m => {
            if (m.enabled === false) return false;
            const _mg = m.modeGroup || "code";
            const _dom = _mg === "work" ? _smaWDom : _smaCDom;
            return !_dom || _dom.modeIds.includes(m.id);
          });
          if (_smaList.length === 0) return "(无可用子模式)";
          return _smaList.map(m => `- [${m.modeGroup || "code"}] ${m.id}: ${m.icon || ""} ${m.label}${m.desc ? " — " + m.desc : ""}`).join("\n");
        } catch { return "(子模式列表加载失败)"; }
      })
      .replace(/\{\{active_project\}\}/g, _macroActiveProject)
      .replace(/\{\{code_active_files\}\}/g, _macroCodeActiveFiles)
      // 热层全文（20260726「热层只注入到 P1」）：主 AI 侧该链已删，此处是热层内容的唯一读取通道
      .replace(/\{\{codeHotLayer\}\}/g, _macroCodeHotLayer)
      .replace(/\{\{workHotLayer\}\}/g, _macroWorkHotLayer)
      .replace(/\{\{env_info\}\}/g, _macroEnvInfo)
      // F1: 客户端环境宏
      .replace(/\{\{client_env\}\}/g, () => getClientEnvString())
      // 任务F: 动态文件引用宏 {{code_file:filename.md}} → 文件内容
      .replace(/\{\{code_file:([^}]+)\}\}/g, (_match, _filename) => {
        if (activeMode !== "code") return "(仅编程模式可用)";
        try {
          const _memDir = ensureMemoryDir(username, charName);
          const _filePath = path.join(
            _memDir,
            "code",
            "active",
            _filename.trim(),
          );
          if (
            !isPathSafe(_filePath, path.resolve(path.join(_memDir, "code"))) // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
          ) {
            return "(路径越界)";
          }
          if (fs.existsSync(_filePath)) {
            return fs.readFileSync(_filePath, "utf-8");
          }
          return `(文件 ${_filename.trim()} 不存在)`;
        } catch (e) {
          return `(读取失败: ${e.message})`;
        }
      })
      // （{{framework}}/{{issues}} 宏已删，2026-07-16 凛倾拍板去重：与 code 记忆表格 #3/#4 概念重复
      //   且无预设引用=死链；架构/问题知识归记忆表格单源。）
      // data 系统: 线路宏 {{code_route:taskName}}（本角色独立层，最近事件）
      .replace(/\{\{code_route:([^}]+)\}\}/g, (_match, _taskName) => {
        if (activeMode !== "code") return "(仅编程模式可用)";
        try {
          const events = _dsReadRoute(username, charName, _taskName.trim());
          if (!events.length) return "(无线路事件)";
          return events
            .slice(-30)
            .map((e) => `#${e.seq} ${e.action} ${e.target}${e.node ? `@${e.node}` : ""}${e.errorAfter ? ` ✗${e.errorAfter}` : ""}${e.reason ? ` (${e.reason})` : ""}`)
            .join("\n");
        } catch (e) {
          return `(线路读取失败: ${e.message})`;
        }
      })
      // 任务F: 热层md目录查看宏 {{code_files_list}}
      .replace(/\{\{available_data\}\}/g, _availableDataText || "(无可用数据)")
      .replace(/\{\{code_files_list\}\}/g, () => {
        if (activeMode !== "code") return "(仅编程模式可用)";
        try {
          const _memDir = ensureMemoryDir(username, charName);
          const _activeDir = path.join(_memDir, "code", "active");
          if (!fs.existsSync(_activeDir)) return "(目录不存在)";
          const _entries = fs.readdirSync(_activeDir, { withFileTypes: true });
          if (_entries.length === 0) return "(空目录)";
          return _entries
            .map((_e) => {
              const _icon = _e.isDirectory() ? "📁" : "📄";
              let _sizeStr = "";
              if (_e.isFile()) {
                try {
                  const _st = fs.statSync(path.join(_activeDir, _e.name));
                  const _b = _st.size;
                  _sizeStr = _b < 1024 ? ` (${_b}B)` : _b < 1048576 ? ` (${(_b/1024).toFixed(1)}K)` : ` (${(_b/1048576).toFixed(1)}M)`;
                } catch { /* ignore */ }
              }
              return `${_icon} ${_e.name}${_sizeStr}`;
            })
            .join("\n");
        } catch (e) {
          return `(读取目录失败: ${e.message})`;
        }
      });

    messages.push({
      role:
        prompt.role === "user"
          ? "user"
          : prompt.role === "assistant"
            ? "assistant"
            : "system",
      content,
    });
  }

  // 预设无 {{chat_history}} 内置条目时，向量初筛候选兜底追加在末尾（有候选才有消息）
  if (options.extraContext && !_extraCtxPushed) {
    messages.push({ role: "system", content: options.extraContext });
    _extraCtxPushed = true;
  }

  if (messages.length === 0) {
    wbD(null, "clone", "runMemoryPresetAI:noPrompts", false, "预设没有可用的提示词条目", { presetId: preset.id, promptsSourceLabel });
    throw new Error("预设没有可用的提示词条目");
  }

  // Dry Run: 直接返回
  if (options.dryRun) {
    return {
      dryRun: true,
      messages,
      presetId: preset.id,
      presetName: preset.name,
      timestamp: new Date().toISOString(),
    };
  }

  // 3. 多轮搜索循环
  const allExecutedOps = [];
  // ── P9 词库维护 <vocab_edit>（2026-07-31 002拍板；0731 子模式化后执行层提升为
  //   tools/vocabEditExec.mjs 单点收口，与正常对话链 replyHandler 共享——本文件只消费不再自持实现） ──
  // [0728 top-k] 本 run 实际读到内容的记忆文件相对路径（readFile 成功/关键词/正则/向量命中）。
  //   随返回值带出，由 getPromptHandler 在 AI P1 真注入时交 recallStats.recordRecall 记召回频率
  //   （写点不在本函数：P2-P8/dryRun/无结果轮不该计数，注入与否只有调用方知道）。
  const _touchedMemFiles = new Set();
  const roundDetails = [];
  let finalReply = "";
  let finalThinking = "";
  const startTime = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    wbT(null, "aiRunner", "runMemoryPresetAI:roundStart", { presetId: preset.id, round, maxRounds });
    if (Date.now() - startTime > timeoutMs) {
      wbD(null, "aiRunner", "runMemoryPresetAI:timeout", false, "记忆AI超时", { presetId: preset.id, round, timeoutMs });
      console.warn(
        `[beilu-memory] 记忆AI(${preset.id}) 超时 (${timeoutMs}ms), 停止在第${round}轮`,
      );
      break;
    }

    // 构造 promptStruct（司令员模式）
    let tailSplit = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") tailSplit = i;
      else break;
    }
    const beforeMessages = messages.slice(0, tailSplit);
    const afterMessages = messages.slice(tailSplit);

    const promptStruct = {
      // ★ 单源 username：供反代 _resolveFileHash 还原 file:hash 图片（分身/辅助AI 路径同样需要，缺它退查 _default 丢图）
      username,
      // 图片入链(2026-07-09 断链修:陪伴轮次截图此前从未抵达 AI):options.images=[{name,mime_type,buffer(base64串)}]
      // → 作为 chat_log 末条 user 消息的 files 走【既有已验证嵌入路径】:司令员模式 proxy main.mjs:170
      //   buildChatLogMessages 消费 chat_log,末条含图 user 消息嵌成 image_url part(messageTransform.mjs:117-199,
      //   base64 字符串 buffer 走 :154 分支)。不发明新管线;content=截图描述(数据,来自截图客户端 message 字段)。
      chat_log: (Array.isArray(options.images) && options.images.length)
        ? [{ role: "user", content: options.imagesText || getInjectText("memory.images_placeholder"), files: options.images }]
        // 纯文本用户输入(2026-07-09 触碰发送):options.userText=用户自己预设的触碰消息(数据来自用户配置,
        //   代码不产生文本),走同一 chat_log 嵌入路径,无 files=纯文本 user 消息。
        : ((typeof options.userText === "string" && options.userText.trim())
          ? [{ role: "user", content: options.userText.trim() }]
          : []),
      char_prompt: { text: [] },
      user_prompt: { text: [] },
      world_prompt: { text: [] },
      other_chars_prompt: {},
      plugin_prompts: {
        "beilu-preset": {
          extension: {
            commander_mode: true,
            beilu_preset_messages: true,
            beilu_preset_before: beforeMessages,
            beilu_preset_after: afterMessages,
            beilu_injection_above: [],
            beilu_injection_below: [],
            beilu_model_params: {
              squash_system_messages: true,
              prompt_post_processing: apiConfig.prompt_post_processing || MEMORY_AI_DEFAULT_POST_PROCESSING,
              prefill_enabled: apiConfig.prefill_enabled !== undefined ? apiConfig.prefill_enabled : true,
              claude_prefill_mode: apiConfig.claude_prefill_mode || "",
              // ★ 分身/辅助AI关闭模型自带thinking
              show_thoughts: apiConfig.include_reasoning === true,
            },
          },
        },
      },
    };

    const modelOverrides = {};
    if (apiConfig.use_custom) {
      if (apiConfig.model) modelOverrides.model = apiConfig.model;
      if (apiConfig.temperature !== undefined)
        modelOverrides.temperature = apiConfig.temperature;
      if (apiConfig.max_tokens !== undefined)
        modelOverrides.max_tokens = apiConfig.max_tokens;
      // T001/C1：top_p 转发（patch_p2 P2-1 原功能，T3e 迁移丢失）。下游 proxy StructCall:114-115
      // 已支持 modelOverrides.top_p→model_arguments.top_p。条件转发不塞默认值（undefined=不带参）。
      if (apiConfig.top_p !== undefined)
        modelOverrides.top_p = apiConfig.top_p;
      // top_k/min_p：与 top_p 同通路（参数设定对齐子模式，消费端 proxy StructCall modelOverrides 块）
      if (apiConfig.top_k !== undefined)
        modelOverrides.top_k = apiConfig.top_k;
      if (apiConfig.min_p !== undefined)
        modelOverrides.min_p = apiConfig.min_p;
      // ★ 思考模式控制（分身/辅助AI关闭模型自带thinking）
      if (apiConfig.include_reasoning !== undefined)
        modelOverrides.include_reasoning = apiConfig.include_reasoning;
      // extended_thinking/thinking_budget 转发已删（2026-08-01 凛倾收口：思维链控制唯一入口=
      //   AI 源面板 per-源 config，httpFetch 只读源 config，分身/委派不再逐调用覆盖）
    }
    const hasModelOverrides = Object.keys(modelOverrides).length > 0;

    console.log(
      `[beilu-memory] 调用记忆AI: ${preset.id}(${preset.name}) 第${round}轮, 服务源=${actualSourceName}${apiConfig.use_custom ? "" : "(自动)"}${hasModelOverrides ? `, model=${modelOverrides.model || "(默认)"}` : ""}, ${messages.length}条消息`,
    );

    // StructCall 带重试
    let result;
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (options.signal?.aborted) break;
      try {
        result = await aiSource.StructCall(
          promptStruct,
          // [0727 并发闸] aiPriority 透传：分身/delegate 调用点标 "low"（并发闸让路+串行），主回合记忆AI 不带=本体级
          { ...(hasModelOverrides ? { modelOverrides } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.aiPriority ? { aiPriority: options.aiPriority } : {}) },
        );
        wbT(null, "aiRunner", "runMemoryPresetAI:structCallDone", { presetId: preset.id, round, attempt, replyLen: result?.content?.length || 0 });
        break;
      } catch (callError) {
        const isRetryable =
          /connection error|TLS|close_notify|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(
            callError.message,
          );
        if (isRetryable && attempt <= maxRetries) {
          const delay = attempt * 2000;
          wbD(null, "aiRunner", "runMemoryPresetAI:structCallRetry", false, callError.message, { presetId: preset.id, round, attempt });
          console.warn(
            `[beilu-memory] 记忆AI(${preset.id}) 第${round}轮第${attempt}次调用失败(${callError.message}), ${delay}ms后重试...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        wbD(null, "aiRunner", "runMemoryPresetAI:structCallFail", false, callError.message, { presetId: preset.id, round });
        throw callError;
      }
    }

    let replyContent = result?.content || "";

    // ★ P2-7: 空回检测 + 备用API自动切换
    if (!replyContent.trim() && round === 1) {
      // 尝试从子模式配置读取备用API源
      let _backupSource = "";
      try {
        const _bkConfigPath = getYonbanConfigPath(username);
        const _bkConfig = loadJsonFileIfExists(_bkConfigPath, { sub_modes: [] });
        const _bkActiveId = resolveActiveSubModeId(_bkConfig, activeMode, options.chatId || null); // 键收口 2026-07-13：原裸读全局字段（全链唯一无 chatId 读点），与 :438 同参对齐 per-chat 生效链
        const _bkSubMode = (_bkConfig.sub_modes || []).find(m => m.id === _bkActiveId);
        _backupSource = _bkSubMode?.backup_api_source || "";
      } catch (_e) { /* 读取失败跳过 */ }

      if (_backupSource && _backupSource !== actualSourceName) {
        console.warn(`[beilu-memory] 记忆AI(${preset.id}) 第${round}轮空回，尝试备用API源: ${_backupSource}`);
        try {
          const _bkAiSource = await loadPart(username, `serviceSources/AI/${_backupSource}`);
          if (_bkAiSource) {
            // 与主调用(L743)一致：第二参须为 { modelOverrides }，generator 只解构 options.modelOverrides；
            // 旧版传裸 modelOverrides 导致备用源 model/temperature override 静默失效，已修。
            const _bkResult = await _bkAiSource.StructCall(promptStruct, { ...(hasModelOverrides ? { modelOverrides } : {}), ...(options.signal ? { signal: options.signal } : {}) });
            replyContent = _bkResult?.content || "";
            if (replyContent.trim()) {
              console.log(`[beilu-memory] 备用API源 ${_backupSource} 返回成功 (${replyContent.length}字符)`);
            } else {
              wbD(null, "clone", "runMemoryPresetAI:backupAlsoEmpty", false, `备用API源 ${_backupSource} 也返回空内容`, { presetId: preset.id, round });
              console.warn(`[beilu-memory] 备用API源 ${_backupSource} 也返回空内容`);
            }
          }
        } catch (_bkErr) {
          wbD(null, "clone", "runMemoryPresetAI:backupCallFail", false, _bkErr?.message || String(_bkErr), { presetId: preset.id, backupSource: _backupSource, round });
          console.warn(`[beilu-memory] 备用API源 ${_backupSource} 调用失败: ${_bkErr.message}`);
        }
      } else if (!replyContent.trim()) {
        wbD(null, "clone", "runMemoryPresetAI:emptyNoBackup", false, "空回且无备用API源可用", { presetId: preset.id, round });
        console.warn(`[beilu-memory] 记忆AI(${preset.id}) 第${round}轮空回，无备用API源可用`);
      }
    }

    let processedContent = replyContent;

    // <tableEdit>
    const { operations: tableOps, cleanContent: afterTableEdit } =
      parseTableEditTags(processedContent);
    processedContent = afterTableEdit;
    // [2026-07-16] archiveRows 是主链（replyHandler 分流→归档引擎）专属指令；P 系列线未接归档引擎，
    //   executeTableOperations 无此 case 会静默跳过——先过滤+留痕，防无声吞（P 线接归档能力另议）。
    const _arcDropped = tableOps.filter((o) => o.type === "archiveRows");
    if (_arcDropped.length > 0) {
      wbD(null, "clone", "runMemoryPresetAI:archiveRowsUnsupported", false, "P系列线暂不支持 archiveRows，已忽略", { presetId: preset.id, count: _arcDropped.length });
    }
    const _crudTableOps = tableOps.filter((o) => o.type !== "archiveRows");
    if (_crudTableOps.length > 0) {
      const { successCount } = executeTableOperations(memData.tables, _crudTableOps); // 0716 返回形状升级（断点#5）：P 系列子 AI 线失败仅 wb 留痕，回喂只做主链
      if (successCount > 0) {
        // [2026-07-16 半接线补齐] 第4参 options.chatId：saveTablesData 按 cacheKey 从 memoryCache 取数写盘
        // (storage.mjs:1697-1698 不写传入对象)——调用方带 chatId load 的 memData 在 `#mode@chatId` 槽，
        // 漏传 chatId 则写盘取 `#mode` char 级槽=改动丢失/写旧数据。options.chatId 通道本函数 :431/:438/:952
        // 已消费（T4靶点④），唯独两处 saveTablesData 漏接。无 chatId 调用方 → undefined → 行为同旧。
        saveTablesData(username, charName, memData.activeMode, options.chatId || undefined);
        allExecutedOps.push({
          type: "tableEdit",
          count: successCount,
          total: _crudTableOps.length,
          round,
        });
      }
    }

    // <memoryArchive>
    const { archiveOps, cleanContent: afterArchive } =
      parseMemoryArchiveTags(processedContent);
    processedContent = afterArchive;
    if (archiveOps.length > 0) {
      const archiveResults = executeMemoryArchiveOps(
        archiveOps,
        username,
        charName,
        memData.tables,
      );
      const archiveOkCount = archiveResults.filter(
        (r) => r.status === "ok",
      ).length;
      if (archiveOkCount > 0) saveTablesData(username, charName, memData.activeMode, options.chatId || undefined); // [2026-07-16] 同上：写盘槽与 memData load 槽对齐
      allExecutedOps.push({
        type: "memoryArchive",
        results: archiveResults,
        count: archiveOkCount,
        round,
      });
    }

    // <memorySearch>（本地记忆文件搜索）
    const { searchOps, cleanContent: afterSearch } =
      parseMemorySearchTags(processedContent);
    processedContent = afterSearch;

    // <searchQuery>（P8 联网搜索）
    const { queries: webSearchQueries, cleanContent: afterWebSearch } =
      parseSearchQueryTags(processedContent);
    processedContent = afterWebSearch;

    // <noSearch>（P8 判定不需要联网）
    const { noSearch: isNoSearch, cleanContent: afterNoSearch } =
      parseNoSearchTag(processedContent);
    processedContent = afterNoSearch;

    // <searchResult>（P8 二次过滤后的精选结果，最终轮输出）
    const {
      searchResults: filteredResults,
      cleanContent: afterFilteredResults,
    } = parseSearchResultTags(processedContent);
    processedContent = afterFilteredResults;

    // <memoryNote>（T5-4：解析层只返回 notes，落盘走 storage.appendPendingTasks 收口）
    {
      const { notes: _mnNotes, cleanContent: _mnClean } = parseMemoryNoteTags(processedContent);
      processedContent = _mnClean;
      try { await appendPendingTasks(username, charName, _mnNotes); }
      catch (e) { console.error("[beilu-memory] 保存 memoryNote 失败:", e.message); }
    }

    // <vocab_edit>（P9 词库维护：预览→确认两态，防一次性静默大改）
    const { blocks: vocabEditBlocks, cleanContent: afterVocabEdit } = parseVocabEditTags(processedContent);
    processedContent = afterVocabEdit;
    let vocabEditFeedback = "";
    if (vocabEditBlocks.length > 0) {
      const vocabResults = await executeVocabEditOps(vocabEditBlocks);
      const writtenCount = vocabResults.filter((r) => r.status === "written").length;
      allExecutedOps.push({ type: "vocabEdit", results: vocabResults, count: writtenCount, round });
      vocabEditFeedback = `[词库改动结果]\n${vocabResults.map((r) => {
        if (r.status === "preview") return `预览 ${r.file}: 新增${r.added} 删除${r.removed} 修改${r.modified}，理由：${r.reason}。确认无误请用完全相同的 file+content 重新发送 <vocab_edit> 并在 JSON 中加 "confirm": true 以落库；如需调整请修改后重新提交（不视为确认）。`;
        if (r.status === "written") return `已写入 ${r.file}: 新增${r.added} 删除${r.removed} 修改${r.modified}（理由：${r.reason}）`;
        if (r.status === "rejected_cap") return `拒绝 ${r.file}: ${r.reason}`;
        return `失败 ${r.file || ""}: ${r.reason}`;
      }).join("\n")}\n[/词库改动结果]`;
    }

    // 提取 <thinking> / <think>
    let roundThinking = "";
    const thinkingMatch = replyContent.match(
      /<thinking>([\s\S]*?)<\/thinking>/i,
    );
    if (thinkingMatch) {
      roundThinking = thinkingMatch[1].trim();
    } else {
      const thinkMatch = replyContent.match(/<think>([\s\S]*?)<\/think>/i);
      if (thinkMatch) roundThinking = thinkMatch[1].trim();
    }
    // ★ 不物理删除 thinking：保留在 finalReply（落库/显示）里，供前端折叠块展示给用户。
    //   AI 不可见由「专门针对 AI 的正则删除」保证——出站 proxy messageTransform stripReasoningTags
    //   对每条 assistant 消息剥离 + 下方轮内回喂(:1055)亦经 stripReasoningTags。
    //   原 .replace 物理删 = 用户也永久看不到（本次纠正）。roundThinking 仍单独抽取供诊断。
    processedContent = processedContent.trim();

    const hasLocalSearch = searchOps.length > 0;
    const hasWebSearch = webSearchQueries.length > 0;
    // vocab_edit 预览必须回喂让 AI 有机会确认——有 tag 就继续循环，与搜索同权
    const hasVocabEdit = vocabEditBlocks.length > 0;

    roundDetails.push({
      round,
      replyLength: replyContent.length,
      hasSearchOps: hasLocalSearch,
      searchOpsCount: searchOps.length,
      hasWebSearch,
      webSearchCount: webSearchQueries.length,
      isNoSearch,
      hasFilteredResults: filteredResults.length > 0,
      thinking: roundThinking,
    });

    console.log(
      `[beilu-memory] 记忆AI(${preset.id}) 第${round}轮回复: ${replyContent.length}字符, 本地搜索: ${searchOps.length}个, 联网搜索: ${webSearchQueries.length}个${isNoSearch ? " (noSearch)" : ""}${filteredResults.length > 0 ? ` (精选结果: ${filteredResults.length}条)` : ""}`,
    );

    // 既没有本地搜索也没有联网搜索、也没有待回喂的词库改动 → 循环完成
    if (!hasLocalSearch && !hasWebSearch && !hasVocabEdit) {
      finalReply = processedContent;
      finalThinking = roundThinking;
      // 如果有精选结果，将其保留在 reply 中
      if (filteredResults.length > 0) {
        finalReply =
          filteredResults.join("\n\n") +
          (processedContent ? "\n\n" + processedContent : "");
      }
      break;
    }

    // === 执行本地记忆文件搜索 ===
    let localSearchFeedback = "";
    if (hasLocalSearch) {
      const searchResults = await executeMemorySearchOps( // async 化（0722 向量 fallback 接入）
        searchOps,
        username,
        charName,
      );
      // [0728 top-k] 收集本轮读到内容的文件（提取规则单源 recallStats.collectTouchedFiles，与 replyHandler 共用）
      for (const _tf of collectTouchedFiles(searchResults)) _touchedMemFiles.add(_tf);
      const searchResultsText = formatSearchResultsForAI(searchResults);
      allExecutedOps.push({
        type: "memorySearch",
        results: searchResults.length,
        round,
      });
      localSearchFeedback = `[本地记忆搜索结果]\n${searchResultsText}\n[/本地记忆搜索结果]`;
    }

    // === 执行联网搜索 ===
    let webSearchFeedback = "";
    if (hasWebSearch) {
      const webSearchConfig = memData.config?.web_search || {};
      const allWebResults = [];

      for (const query of webSearchQueries) {
        console.log(`[beilu-memory] P8 联网搜索: "${query}"`);
        const { results, error, warning, engine } = await executeWebSearch(
          query,
          webSearchConfig,
        );
        // [0726] warning=成功但可疑度中等（结果照给+提醒）；error 仍是"失败且 results 必空"的唯一判据
        const _wsWarn = warning ? `\n⚠️ ${warning}` : "";

        if (error) {
          wbD(null, "clone", "runMemoryPresetAI:webSearchFail", false, String(error), { presetId: preset.id, query, engine, round });
          console.warn(`[beilu-memory] P8 联网搜索失败 (${engine}): ${error}`);
          allWebResults.push(`搜索 "${query}" 失败: ${error}`);
        } else if (results.length > 0) {
          allWebResults.push(
            `搜索 "${query}" (${engine}) 返回 ${results.length} 条结果:${_wsWarn}\n\n${buildInjectableSearchText(results, "P8联网搜索")}`,
          );
        } else {
          allWebResults.push(`搜索 "${query}" 无结果`);
        }

        allExecutedOps.push({
          type: "webSearch",
          query,
          resultCount: results?.length || 0,
          engine,
          error: error || null,
          round,
        });
      }

      // SEC-T8 FL-9：联网搜索结果是纯外部不可信内容（恶意网页可含 ＜ideToolCall＞/＜mcp-tool＞ 等
      //   协议标签原文做间接注入，OWASP LLM01）→ 边界包裹**已下沉到功能层** buildInjectableSearchText
      //   （0726「底部功能层.txt」第44行收口：包裹与格式化是联网功能层职责，本文件是 P8 传导链只搬运）。
      //   包裹粒度随之从"整批一次"变为"每条查询一块"：每块独立 nonce，且失败/无结果这类**本系统文案**
      //   留在包裹外不再被误标为不可信内容——语义更准，防御强度不变。
      webSearchFeedback = `[联网搜索结果]\n${allWebResults.join("\n\n---\n\n")}\n[/联网搜索结果]`;
    }

    // 组合反馈消息
    const feedbackParts = [];
    if (localSearchFeedback) feedbackParts.push(localSearchFeedback);
    if (webSearchFeedback) feedbackParts.push(webSearchFeedback);
    if (vocabEditFeedback) feedbackParts.push(vocabEditFeedback);

    const feedbackContent = feedbackParts.join("\n\n");

    // 回喂给下一轮 AI 的历史：先走 hide 单源剥内置+自定义标签（0716 回归单源，受「思维链显示」
    // 设置 reasoning_builtin/reasoning_tags 控制），再跑用户自建 reasoning 正则规则。
    // 不影响 finalReply=落库/显示仍保留 thinking 供用户折叠看。
    {
      let _aiClean = stripReasoningTags(replyContent, username);
      try {
        const { applyRegexRules, getRegexStore } = await import("../../regex/main.mjs");
        const _rxData = getRegexStore(username);
        if (_rxData?.enabled && _rxData.rules?.length) {
          _aiClean = await applyRegexRules(_aiClean, _rxData.rules, 'reasoning', {});
        }
      } catch { /* 正则模块不可用→内置剥离已完成，仅用户自建规则不生效 */ }
      messages.push({ role: "assistant", content: _aiClean });
    }
    // 回喂指令文案：per-char config.system_texts 覆盖 → DEFAULT_SYSTEM_TEXTS 单源
    // （<searchResult>/<searchQuery>/<memorySearch> 标签名=协议契约）
    messages.push({
      role: "user",
      content: getSystemText(hasWebSearch ? "search_feedback" : "memory_feedback", username, charName)
        .replaceAll("{content}", feedbackContent),
    });

    if (round === maxRounds) {
      finalReply = processedContent;
      finalThinking = roundThinking;
      if (filteredResults.length > 0) {
        finalReply =
          filteredResults.join("\n\n") +
          (processedContent ? "\n\n" + processedContent : "");
      }
      console.log(
        `[beilu-memory] 记忆AI(${preset.id}) 达到最大轮数 ${maxRounds}，使用当前结果`,
      );
    }
  }

  const totalTime = Date.now() - startTime;
  wbT(null, "aiRunner", "runMemoryPresetAI:done", { presetId: preset.id, totalRounds: roundDetails.length, totalTimeMs: totalTime, opCount: allExecutedOps.length });
  console.log(
    `[beilu-memory] 记忆AI(${preset.id}) 完成: ${roundDetails.length}轮, ${totalTime}ms, 操作: ${allExecutedOps.length}个`,
  );

  // [0717 凛倾"看不到P系列输出记录"] P系列运行留痕：此前 P2-P8 输出零留痕（只进 memoryAIOutputQueue
  //   消费即弃）、P1 只有本窗最近一次缓存——诊断面板无从展示历史。单点落盘 _pseries_runs.json
  //   （per-char，cap 100 条），getDiagSnapshot 带出，memtool 诊断页展示。dryRun（测试跑）不记。
  if (!options.dryRun) {
    try {
      _appendPseriesRun(username, charName, {
        ts: new Date().toISOString(),
        presetId: preset.id,
        presetName: preset.name,
        mode: activeMode,
        rounds: roundDetails.length,
        timeMs: totalTime,
        replyLen: (finalReply || "").length,
        reply: (finalReply || "").slice(0, 2000),
        opCount: allExecutedOps.length,
        // [0726 字段错配根修] 原映射读 o.op/o.path/o.status，而本函数内 allExecutedOps 实际 push 的是
        //   {type, query, resultCount, engine, error, round}（webSearch :1220）/{type,count,total,round}
        //   （tableEdit :1065）/{type,results,count,round}（memoryArchive :1089）/{type,results,round}
        //   （memorySearch :1185）——**没有任何一条带 op/path/status**，落盘出来全是 {op:"?",path:"",status:""}，
        //   P8 的 query/结果数/引擎/失败原因 100% 丢失（诊断页因此看不到 P8 到底搜了什么）。
        //   现按真实字段映射：type 单源 + 按类型带关键载荷 + 统一 ok 状态。
        ops: allExecutedOps.slice(0, 10).map((o) => ({
          type: o?.type || o?.op || o?.action || "?",
          round: o?.round ?? null,
          detail: o?.type === "webSearch"
            ? `${o?.query || ""} → ${o?.resultCount ?? 0}条${o?.engine ? "(" + o.engine + ")" : ""}`
            : o?.type === "tableEdit" ? `${o?.count ?? 0}/${o?.total ?? 0}`
            : (o?.count !== undefined || o?.results !== undefined) ? String(o?.count ?? (Array.isArray(o?.results) ? o.results.length : o?.results) ?? "")
            : (o?.path || ""),
          ok: o?.error ? false : (o?.status ? o.status === "ok" : true),
          error: o?.error ? String(o.error).slice(0, 120) : undefined,
        })),
      });
    } catch (_prErr) { console.warn("[beilu-memory] P系列运行留痕失败:", _prErr?.message); }
  }

  return {
    presetId: preset.id,
    presetName: preset.name,
    reply: finalReply,
    rawReply: finalReply,
    thinking: finalThinking,
    operations: allExecutedOps,
    rounds: roundDetails,
    totalRounds: roundDetails.length,
    totalTimeMs: totalTime,
    timestamp: new Date().toISOString(),
    touchedMemoryFiles: Array.from(_touchedMemFiles), // [0728 top-k] 供 getPromptHandler 真注入时记召回频率
  };
}

// ============================================================
// P系列运行留痕（[0717] 单一写点=runMemoryPresetAI 完成处；读点=setDataActions getDiagSnapshot）
// ============================================================

const _PSERIES_RUNS_FILE = "_pseries_runs.json";
const _PSERIES_RUNS_CAP = 100;

function _appendPseriesRun(username, charName, rec) {
  const _dir = ensureMemoryDir(username, charName);
  const _fp = path.join(_dir, _PSERIES_RUNS_FILE);
  let _runs = [];
  try {
    const _raw = fs.existsSync(_fp) ? JSON.parse(fs.readFileSync(_fp, "utf-8")) : [];
    if (Array.isArray(_raw)) _runs = _raw;
  } catch { /* 损坏文件从空重建（留痕非关键数据） */ }
  _runs.push(rec);
  if (_runs.length > _PSERIES_RUNS_CAP) _runs = _runs.slice(-_PSERIES_RUNS_CAP);
  fs.writeFileSync(_fp, JSON.stringify(_runs, null, 2), "utf-8");
}

/** 读最近 N 条运行记录（倒序=最新在前）。诊断展示用。 */
export function readPseriesRuns(username, charName, limit = 20) {
  try {
    const _fp = path.join(ensureMemoryDir(username, charName), _PSERIES_RUNS_FILE);
    if (!fs.existsSync(_fp)) return [];
    const _raw = JSON.parse(fs.readFileSync(_fp, "utf-8"));
    return Array.isArray(_raw) ? _raw.slice(-limit).reverse() : [];
  } catch { return []; }
}

// ============================================================
// 异步触发 P1 检索AI
// ============================================================

// [已删除] triggerP1Retrieval（自驱动 P1 检索触发器）——凛倾 07-02 拍板"自驱动P1召回发散直接移除(还没开发好)"后调用点已摘,
//   函数体成死码（全库调用零命中,W4 复扫+主 AI 复核）,凛倾 07-03 授权删除。isP1RunningMap/isP1Running 保留（诊断链活码,
//   setDataActions:1786→memtool P1运行中badge——本删除前后其值同恒 false,零行为变化）。原实现见备份 yonban迁移_死码删除_*。

// ============================================================
// 异步触发 P2 总结AI
// ============================================================

/**
 * @param {string} username
 * @param {string} charName
 */
export async function triggerP2Summary(username, charName, chatId) {
  wbT(null, "aiRunner", "triggerP2Summary:enter", { username, charName, chatId });
  const presetsData = loadMemoryPresets(username, charName);
  const p2Preset = presetsData.presets.find((p) => p.id === "P2");
  if (!p2Preset || !p2Preset.enabled) {
    console.log("[beilu-memory] P2 未启用，跳过自动总结");
    return;
  }

  if (p2Preset.trigger === "manual_button") {
    console.log("[beilu-memory] P2 触发方式为手动按钮，跳过自动触发");
    return;
  }

  const memData = loadMemoryData(username, charName, undefined, chatId);
  console.log(`[beilu-memory] P2 总结AI 异步触发 (${charName})`);

  // 归档前自动快照（凛倾0712；日戳频控在 helper 内——P2 阈值型触发一天可多次，快照每天最多一份）
  createArchiveSnapshot(username, charName, "P2 归档总结前自动快照");

  // 安全兜底：P2 AI运行前先把#4数据物理归档到warm层
  // 即使P2 AI只执行clearTable(4)，数据也已经保存在 warm/年/月/日_details/
  try {
    const { archiveTempMemory } = await import("../tools/backgroundTasks.mjs");
    const _archResult = await archiveTempMemory(username, charName, chatId); // T1：async 化后 await（失败落本块 catch）；T4 同族：同函数上文 loadMemoryData 已带 chatId，归档漏传补齐

    if (_archResult.archived > 0) {
      console.log(`[beilu-memory] P2前置归档: ${_archResult.archived}条→${_archResult.batchFiles.length}个batch文件`);
    }
  } catch (_archErr) {
    wbD(null, "clone", "triggerP2Summary:preArchiveFail", false, _archErr?.message || String(_archErr), { username, charName });
    console.error(`[beilu-memory] P2前置归档失败: ${_archErr.message}`);
  }

  // 重新加载数据（归档后#4已清空）
  const memDataAfterArchive = loadMemoryData(username, charName, undefined, chatId);

  pushMemoryAIOutput({
    presetId: "P2",
    presetName: p2Preset.name,
    reply: "",
    thinking: "",
    operations: [],
    status: "running",
  });

  try {
    const result = await runMemoryPresetAI(
      username,
      charName,
      p2Preset,
      memDataAfterArchive,
      charName,
      username,
      "(自动触发：临时记忆已归档到warm层batch文件，请在#6长期记忆表格中添加总结条目)",
      { chatId }, // T4靶点④：P2 按触发窗模式选 prompt 组
    );

    pushMemoryAIOutput({
      presetId: "P2",
      presetName: p2Preset.name,
      reply: result.reply || "",
      thinking: result.thinking || "",
      operations: result.operations || [],
      status: "done",
      totalRounds: result.totalRounds,
      totalTimeMs: result.totalTimeMs,
    });

    console.log(
      `[beilu-memory] P2 总结完成 (${result.totalRounds || 1}轮, ${result.totalTimeMs}ms)`,
    );
  } catch (e) {
    wbD(null, "aiRunner", "triggerP2Summary:error", false, e?.message || String(e), { username, charName });
    console.error(`[beilu-memory] P2 总结失败:`, e?.message || String(e));
    pushMemoryAIOutput({
      presetId: "P2",
      presetName: p2Preset.name,
      reply: "",
      thinking: "",
      operations: [],
      status: "error",
      error: e?.message || String(e),
    });
  }
}

// ============================================================
// P2-code 编程归档（回归修复：旧 triggerP2CodeArchive 在某次重构丢失，按钮调用即崩）
// ============================================================

/**
 * 把 code/active 顶层 .md 文件物理归档到热层 hot/archive/md/code/YYYY-MM/（瘦身热层工作区）。
 * 落点=mdArchiveDir 单源（修8 20260716，凛倾「归档只可以变成文件储存在热层」；原 code/archive/YYYY-MM/
 * 对温层扫描(跳子目录)与关键词检索(原只扫.json)双重不可达=归档即消失，retrieval 已同批扩 .md）。
 * 跳过 `_` 前缀元文件(_index.md 等)与子文件夹(已归类的项目)。同名碰撞追加时间戳防覆盖。
 * 归档后 _index.md 消 stale 行：提及被搬文件名的行一并移除（原显式跳过=索引指向已搬走文件）。
 * 注：2026-04-18 旧设计走 P2-AI 总结路径；此处先以文件搬移恢复「按钮可用 + 真实瘦身」，AI 总结可后续叠加。
 * @param {string} username
 * @param {string} charName
 * @returns {Promise<{archived:number, files:string[], archiveDir:string}>}
 */
export async function triggerP2CodeArchive(username, charName) {
  const _memDir = ensureMemoryDir(username, charName);
  const _activeDir = path.join(_memDir, "code", "active");
  if (!fs.existsSync(_activeDir)) return { archived: 0, files: [], archiveDir: "" };
  const _now = new Date();
  const _ym = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}`;
  // 动态 import 同 :1247 archiveTempMemory 先例（backgroundTasks 不反向 import aiRunner，无环）
  const { mdArchiveDir } = await import("../tools/backgroundTasks.mjs");
  const { absDir: _archiveDir, relPrefix: _archiveRel } = mdArchiveDir(_memDir, "code", _ym);
  const _entries = fs.readdirSync(_activeDir, { withFileTypes: true });
  const _moved = [];
  for (const _e of _entries) {
    if (!_e.isFile()) continue;                       // 子文件夹(项目分类)不动
    if (_e.name.startsWith("_")) continue;            // _index.md 等元文件不动
    if (!_e.name.endsWith(".md")) continue;
    if (!fs.existsSync(_archiveDir)) fs.mkdirSync(_archiveDir, { recursive: true });
    let _dest = path.join(_archiveDir, _e.name);
    if (fs.existsSync(_dest)) {                        // 同月同名碰撞 → 追加时间戳
      const _base = _e.name.replace(/\.md$/, "");
      _dest = path.join(_archiveDir, `${_base}.${Date.now()}.md`);
    }
    renameSyncWithRetry(path.join(_activeDir, _e.name), _dest);
    _moved.push(_e.name);
  }
  // _index.md 消 stale 行（机械行过滤，只删含被搬文件名的行；索引本体 AI 维护，此处不生成新内容）
  if (_moved.length > 0) {
    const _idxPath = path.join(_activeDir, "_index.md");
    try {
      if (fs.existsSync(_idxPath)) {
        const _lines = fs.readFileSync(_idxPath, "utf-8").split("\n");
        const _kept = _lines.filter((l) => !_moved.some((f) => l.includes(f)));
        if (_kept.length !== _lines.length) {
          const _tmp = `${_idxPath}.tmp${process.pid}_${Date.now()}`;
          fs.writeFileSync(_tmp, _kept.join("\n"), "utf-8");
          renameSyncWithRetry(_tmp, _idxPath);
        }
      }
    } catch (_ie) { console.warn(`[beilu-memory] P2-code 归档 _index.md 消账失败(不阻断): ${_ie.message}`); }
  }
  console.log(`[beilu-memory] P2-code 归档: ${_moved.length} 个文件 code/active → ${_archiveRel}`);
  return { archived: _moved.length, files: _moved, archiveDir: _archiveRel };
}

// ============================================================
// P4: 异步后台AI — 非阻塞版本
// ============================================================

/** 正在运行的后台任务 Map<taskId, { promise, status, result }> */
export const asyncAITasks = new Map();

/**
 * 非阻塞运行记忆预设AI，结果写入 _pending_results.json
 * @param {string} username
 * @param {string} charName
 * @param {object} preset - 预设配置
 * @param {object} memData - 记忆数据
 * @param {string} displayCharName
 * @param {string} displayUserName
 * @param {string} chatHistory
 * @param {object} [options]
 * @param {string} [options.taskLabel] - 任务标签（显示用）
 * @param {string} [options.resultType] - 结果类型（写入_pending_results.json的type字段）
 * @returns {{ taskId: string }} 立即返回任务ID
 */
export function runMemoryPresetAI_async(
  username, charName, preset, memData,
  displayCharName, displayUserName, chatHistory,
  options = {},
) {
  const taskId = `async_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const taskLabel = options.taskLabel || preset.name || taskId;
  wbT(null, "aiRunner", "runMemoryPresetAI_async:enter", { username, charName, presetId: preset.id, taskLabel, taskId });
  const resultType = options.resultType || "async_ai_result";

  const entry = { status: "running", result: null, startedAt: new Date().toISOString() };
  asyncAITasks.set(taskId, entry);

  pushMemoryAIOutput({
    presetId: taskId, presetName: `[后台] ${taskLabel}`,
    reply: "", thinking: "", operations: [], status: "running",
  });

  console.log(`[beilu-memory] async AI 启动: ${taskLabel} (${taskId})`);

  // 后台执行，不 await
  const promise = runMemoryPresetAI(
    username, charName, preset, memData,
    displayCharName, displayUserName, chatHistory, options,
  ).then(async (result) => {
    entry.status = "done";
    entry.result = result;
    entry.completedAt = new Date().toISOString();

    // 写入 _pending_results.json 供 GetPrompt 下轮注入
    // ★ A3：read→push→write 走 per-file 串行锁，防多个后台 AI 相近完成时后写覆盖先写（lost-update）
    try {
      const memDir = ensureMemoryDir(username, charName);
      const resultPath = path.join(memDir, "work", "_pending_results.json");
      await withFileLock(resultPath, () => {
        // 0716 T019 差集收编：损坏 → readJsonSafeSync 备份后抛 → 锁 finally 释放 → 外层
        //   catch(:async AI 结果写入失败) 承接（防原「空表+push+写回=既有待注入结果整表覆盖」）。
        const results = readJsonSafeSync(resultPath, []);
        results.push({
          type: resultType,
          taskId,
          taskLabel,
          reply: result.reply || "",
          thinking: result.thinking || "",
          timestamp: new Date().toISOString(),
        });
        saveJsonFile(resultPath, results);
      });
    } catch (e) {
      wbD(null, "clone", "runMemoryPresetAI_async:resultWriteFail", false, e?.message || String(e), { taskId, taskLabel });
      console.warn(`[beilu-memory] async AI 结果写入失败:`, e.message);
    }

    pushMemoryAIOutput({
      presetId: taskId, presetName: `[后台] ${taskLabel}`,
      reply: result.reply || "", thinking: result.thinking || "",
      operations: result.operations || [], status: "done",
      totalRounds: result.totalRounds, totalTimeMs: result.totalTimeMs,
    });

    // FT5 A-②: 完成回调 — 供调用方(如 gameCompanion)拿到真实 reply 文本做 producer 广播。
    // async 路径下 reply 文本只在此 .then 中可得, 故 producer 必须挂这里而非 _executeRound 内。
    if (typeof options.onComplete === "function") {
      try { await options.onComplete(result); } catch (_ocErr) { wbD(null, "clone", "runMemoryPresetAI_async:onCompleteFail", false, _ocErr?.message || String(_ocErr), { taskId, taskLabel }); console.warn(`[beilu-memory] async onComplete 回调失败:`, _ocErr.message); }
    }

    console.log(`[beilu-memory] async AI 完成: ${taskLabel} (${result.totalTimeMs}ms)`);
    return result;
  }).catch((e) => {
    entry.status = "error";
    entry.error = e?.message || String(e);
    entry.completedAt = new Date().toISOString();

    pushMemoryAIOutput({
      presetId: taskId, presetName: `[后台] ${taskLabel}`,
      reply: "", thinking: "", operations: [], status: "error",
      error: e?.message || String(e),
    });

    wbD(null, "aiRunner", "runMemoryPresetAI_async:error", false, e?.message || String(e), { taskId, taskLabel });
    console.error(`[beilu-memory] async AI 失败: ${taskLabel}:`, e?.message);
  });

  entry.promise = promise;

  // 5分钟后自动清理任务记录
  setTimeout(() => { asyncAITasks.delete(taskId); }, 5 * 60 * 1000);

  return { taskId, taskLabel };
}

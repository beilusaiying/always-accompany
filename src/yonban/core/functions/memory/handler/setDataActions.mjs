import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * setDataActions.mjs — SetData 处理器：前端所有写操作的统一入口（约200+ 种 action，2026-07 快照，以实际分支为准）。
 *
 * 【功能链】
 *   接收前端或内部调用的写操作请求，通过 switch(action) 路由到具体实现分支，
 *   覆盖表格编辑、配置保存、预设管理、记忆归档、快照、IDE工具触发、调度器 CRUD、
 *   流程组编排、权限规则、data系统埋点、code/work 文件读写等全部写场景。
 *   不管读操作（那是 getDataHandler 的事）。
 *
 * 【why】
 *   把 70+ 种写 action 收口到单一入口而非分散路由，好处是：
 *   SEC 属主校验（_resolveChatOwner）只需在一处实施，不会被绕过；
 *   存储锁（withFileLock）、原子写（nicerWriteFileSync）等保护措施统一加；
 *   新增 action 只加 case 分支，不引入新路由/入口/鉴权面。
 *
 * 【前端调用方式】
 *   前端调用 window.moduleManager.SetData("beilu-memory", { action: "actionName", ...params })
 *   → beilu-chat plugin bridge → POST /api/plugin（或 WS）
 *   → main.mjs interfaces.config.SetData → 本模块 handleSetData(data, args)
 *   → switch(data.action) → 各操作分支执行 → 返回 { ok, ... }
 *
 *   常见 action 示例（2026-07 grep 真实 `_action ===`/`case` 分支核对，非示意）：
 *     "updateTable"                  — 保存表格数据
 *     "switchMode"（if 分支非 case） — 切换 chat/code/work 模式
 *     "updateMemoryPreset"           — 更新已有记忆预设字段（[0804] getSubModes/saveSubModes 对缺失
 *                                      预设引用只触发 preset owner 官方播种，不再自造预设文件）
 *     "scheduler_addJob"/"scheduler_removeJob" — 调度器任务增删
 *     "endDay"                       — 触发日终9步归档
 *     "ideToolCall"                  — 手动触发 IDE 工具调用
 *     "planTasks"/"checkTask"        — 任务清单操作（转发 taskStore）
 *   搜 `case "actionName"` 或 `_action === "actionName"` 定位具体分支。
 *
 * 【关联链】
 *   ← main.mjs（SetData 路由）
 *   → storage.mjs（大量写函数：saveTablesData / saveJsonFile / setActiveMode 等）
 *   → backgroundTasks.mjs（endDay / archiveRememberAboutUser 等）
 *   → tableEngine.mjs（generateTableDataOnly / readHotMemoryForInjection）
 *   → tableSnapshot.mjs（saveSnapshot / listSnapshots / restoreSnapshot）
 *   → dataSystem.mjs（appendRouteEvent / detectRepeatedEdit）
 *   → aiRunner.mjs（triggerP2Summary；triggerP1Retrieval 已删除——凛倾 07-02/07-03 拍板"自驱动P1召回发散直接移除(还没开发好)"，见 aiRunner.mjs:1464 自证注释）
 *   → ideClient.mjs（callToolAndStore / addPendingApproval）
 *   → scheduler.mjs（addJob / removeJob / startScheduler）
 *   → taskStore.mjs（appendTask / applyTaskCheck / applyTaskPlan）
 *   → presetBridge.mjs（createPreset / hasPreset）
 *   → archiver.mjs（executeMemoryArchiveOps）
 *
 * 【影响范围】
 *   写表格/配置/预设/归档/快照/IDE工具调用/调度器/流程组/权限/data系统/code-work文件等，
 *   几乎所有 storage.mjs 的写函数都被本模块某个分支调用。
 *   部分 action 会触发 WS 广播（如 setActiveMode → broadcast "mode_changed"）。
 *
 * 【使用效果】
 *   前端所有写操作（用户手动编辑表格、切换模式、配置预设、触发归档等）均通过此入口落盘，
 *   SEC 属主校验确保只有对应用户/角色的 action 才能通过，原子写防止并发半写损坏。
 *
 * 文件约5720+行（2026-07快照，以实际行数为准），action 分支众多，不在此逐一列举。搜 `case "actionName"` 定位具体分支。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import JSZip from "npm:jszip";
import { safeFetch, assertSafeOutboundInServerMode } from "../../security/safe_fetch.mjs";
import { hasPreset as presetExists, applySubModePresetDefault, clearPresetOverrideViaAPI, ensurePresetReference } from "../ai/presetBridge.mjs"; // [0725] getActivePresetNameBridge 随 using_preset 孤儿产者删除（跨域第二解析源收口）；[0804] createBeiluPreset 随 11-entry 空壳工厂删除（memory 不再是预设内容第二生产者）；[D3 批2] ensurePresetStoreLoaded 整店播种改 ensurePresetReference 单名结构化 outcome（D2-③ Owner API）
// [D3 0804] 子模式激活唯一 owner：setActiveSubMode 成 adapter、新 verb activateSubMode 三入口统一；
//   saveSubModes 写门归一（flat↔nested 同步+冲突标记+contract 剥除）收口 normalizeSubModeForSave 单源。
import { activateSubMode as activateSubModeCore, deactivateSubMode as deactivateSubModeCore, preflightSubModeActivation, normalizeSubModeForSave, listMissingPresetReferences } from "../storage_mod/subModeActivation.mjs";
// 链路2（2026-07-08 可操作处禁硬编码）：getSubModes 响应附 param_schema，YonBan 子模式表单
//   值域/默认值据此渲染（替代 chat-modes.js 写死 0.7/1/8192 与 min/max/step 副本）
// 链路2扩展（2026-07-09）：再附 enum_schema——pp/预填充选项集单源下发，YonBan 两 select
//   据此渲染（替代 innerHTML 写死旧枚举 off/prefill/claude 的漂移副本）
import { PARAM_SCHEMA, ENUM_SCHEMA } from "../../prompt/preset/engine/paramSchema.mjs";
import { nicerWriteFileSync, renameSyncWithRetry } from "../../../../../scripts/nicerWriteFile.mjs"; // M3：央原子写(tmp+rename+D-09重试)，替裸 fs.writeFileSync 防半写损坏
import { sanitizeFilename } from "../../../../../scripts/sanitizeName.mjs"; // 0716 轮子收口：文件名安全清洗共享原语
import { modelsRequestFor } from "../../../../../public/pages/scripts/modelListRequest.mjs"; // 前后端共用纯契约：已保存源 generator → models 端点/响应形状
import { safeUnlink } from "../../rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体
// inj 识别系统 2026-07-13：autoMode 写入校验单源（原零校验=垃圾值静默入库后在门控被拒无诊断面）
import { isValidInjectionAutoMode } from "../storage_mod/injectionSystem.mjs";
import { inspectInjectionCachePrefix } from "./volatileMacros.mjs";
import { resolveEffectiveP1RouteConfig, resolveP1RouteUpdate } from "../p1Route.mjs";
import { dispatch } from "../../../dispatch/dispatcher.mjs"; // [0716 T3对接首批] 广播副作用改经 bus:broadcast 出口节点（exits.mjs），删 4 个 _broadcast* 内的动态 import broadcast.mjs 散拼样板

import {
  DEFAULT_CODE_SUB_MODES,
  buildDefaultSkillGroups,
  DEFAULT_INJECTION_PROMPTS,
  DEFAULT_COMPACT_MERGE_INSTRUCTIONS,
  DEFAULT_SYSTEM_TEXTS,
  getSystemText,
  pickPresetPromptSet,
  p7HasMeaningfulPrompts,
  DEFAULT_WORK_SUB_MODES,
  PERM_LEVEL_META,
  __pluginDir,
  __projectRoot,
  diag,
  ensureMemoryDir,
  DEFAULT_TOKEN_REMINDER, // 0811 getTokenReminderConfig 读侧：返回 DEFAULT 合并后的生效值（后端唯一默认权威）
  getActiveMode,
  getCacheKey,
  getMemoryDir,
  getModeCtxDir,
  getTimeMacroValues,
  getTodayStr,
  loadJsonFile,
  loadJsonFileIfExists,
  loadMemoryData,
  loadMemoryPresets,
  memoryCache,
  clearCharCache,
  presetSwitchCooldown,
  readContextSummary,
  beginContextSummaryWrite,
  commitContextSummaryWrite,
  computeContextSummarySourceRevision,
  beginContextSummaryRollback,
  completeContextSummaryRollback,
  clearContextSummary,
  saveJsonFile,
  saveMemoryPresets,
  saveTablesData,
  resolveActiveSubModeId,
  writeActiveSubModeId,
  buildSubModeSwitchEvent,
  setActiveMode,
  isValidModeId,
  getCardWorkspaceRoot,
  setCardWorkspaceRoot,
  withFileLock,
  writeContextSummary,
  getYonbanConfigPath,
  updateYonbanConfig, // T4：yonban_config 字段级收口写口（读改写走串行锁，防整文件互覆）
  SKIP_SAVE, // updateYonbanConfig 哨兵：mutator 返回它=本次不落盘（getSubModes/setActiveSubMode/saveClones 用）
  addPermanentCharLink,
  removePermanentCharLink,
  getCommandConfigPath,
  getGameCompanionConfigPath,
  getWorkConfigPath,
  updateWorkConfig, // [0722 锁收口] _work_config 字段级收口写口（流程组五case+选中组全走此口）
  resolveSelectedGroups, // [0722 每窗独立链路] 窗口有效选中组读解析单源（窗口层→_default 长期层）
  writeSelectedGroup, // [0722 每窗独立链路] 选中组双层写单源（禁调用点手拼 map）
  migrateWorkflowsShape,
  resolveWorkflowSlot,
  getCodeConfigPath,
  modeFeaturesReady, // 0716 审查风险3：switchMode 声明表未就绪时跳过 scheduler 启停
  modeFeature, // 0731 T2：getModeFeatureOverrides 下发声明默认值（单源，前端零硬编码）
  isPathSafe, // 0716 路径前缀边界修复：收口内联 resolve().startsWith 到权威守卫
} from "../storage_mod/storage.mjs";

import {
  generateTableDataOnly,
  readHotMemoryForInjection,
} from "../storage_mod/tableEngine.mjs";

import {
  appendTask,
  applyTaskCheck,
  applyTaskPlan,
  loadTasks,
  mutateTasks,
  remainingCount,
} from "../tools/taskStore.mjs";

import {
  addJob,
  listJobs,
  removeJob,
  schedulerFeature,
  startScheduler,
  stopScheduler,
  toggleJob,
  updateJob,
} from "../../notification/scheduler.mjs";

import {
  archiveCompletedTasks,
  archiveForeverEntries,
  archiveRememberAboutUser,
  archiveTableRowsGeneric,
  archiveTempMemory,
  archiveWarmToCold,
  endDay,
  mdArchiveDir,
  TABLE_ARCHIVE_DEFAULTS,
  tableArchiveRoot,
  listTableArchiveFiles,
} from "../tools/backgroundTasks.mjs";

import { countTokensSync } from "../nlp/tokenizer.mjs";

// [0720 框架归位·子模式配置数据版本] 迁移状态是数据自身的属性(yonban_config.sub_modes_schema),
//   不是进程态:盘上版本达标=getSubModes 纯读;低版本才进一次性迁移写路径(迁移完推版本号落盘,
//   跨进程/isolate 天然一致,配置被删重建时版本字段缺失自然重迁)。版本号语义:1=初始化+W64迁移+建预设已完成;
//   2=0722 新增 work-job-hunt/work-stock 子模式(存量用户经迁移段5"补充缺失的工作子模式"按 id union 补齐);
//   3=0722 凛倾撤销 work-job-hunt/work-stock(迁移段5.5按 id 剔除+激活指针归位,默认表已同步删除);
//   4=0724 code组重组中文id(段0.9分流+旧英文id剔除+映射表直达最终id);
//   5=[D3 0804] 存量条目过 normalizeSubModeForSave 写门归一(段7:contract 剥除+schemaVersion:2+
//     fallbackPolicy 默认 fail_closed+flat↔nested 缺侧同步+真冲突只标 _profile_conflicts 不静默挑选;
//     幂等可重复,不覆盖用户值)。
//   6=[0811 凛倾拍板] code组新增「PPT制作」子模式(撤销0724删除;存量用户经迁移段4"补充缺失的编程
//     子模式"按 id union 补齐;id 用中文"PPT制作"避开 _oldToNew/_removedIds2 里被永久剔除的 "ppt-designer")。
const SUB_MODES_SCHEMA = 6;

import {
  asyncAITasks,
  injectionLog,
  isP1Running,
  memoryAIOutputQueue,
  peekLastP1Result,
  pendingChatSearchResults,
  listChatSearchSlots,
  pluginEnabled,
  pushMemoryAIOutput,
  readPseriesRuns,
  runMemoryPresetAI,
  runMemoryPresetAI_async,
  setLastP1Result,
  setPluginEnabled,
} from "../ai/aiRunner.mjs";

import { ideClient, isValidIdeRouteSnapshot, ideRouteSnapshotsEqual, isIdeToolResultMsg, isIdeToolCallMsg, deriveApprovalSkipRule, buildPermissionTemplateRules, collectNoiseToHide, CLONE_TAG_RE, PERMISSION_WRITE_TOOLS, FILE_EDIT_TOOLS, WRITE_TOOLS_ALL, DELETE_CMD_FIRST_WORDS, isSensitiveEnvBasename } from "../../../transport/ideClient.mjs";
import {
  normalizeToolRuntimeConfig,
  normalizeToolRuntimeConfigForRecovery,
  readToolRuntimeConfig,
  readToolRuntimeConfigState,
} from "../../../transport/toolRuntime.mjs";
import { getMcpRuntimeSnapshot } from "../../mcp/runtimeRegistry.mjs";
import {
  listMcpConnectRequests,
  normalizeMcpConnectConfig,
  transitionMcpConnectRequest,
} from "../../mcp/connectRequestStore.mjs";
import { loadPart } from "../../../../../server/parts_loader.mjs"; // 根病4/cleanIdeResults: 跨插件直调替代 HTTP(端口+认证双断)

import {
  createTableSnapshot,
  findSnapshotForRollback,
  listTableSnapshots,
  pruneSnapshotsAfter,
  restoreTableSnapshot,
} from "../../rollback/tableSnapshot.mjs";

import {
  ackWarning,
  appendBehaviorSignal,
  appendRouteAmendment,
} from "../data/dataSystem.mjs";


// ★ FT2 需求 A：四内置权限档元数据（id/name/color/desc/level）。前端档位徽章渲染用。
//   level 映射 buildPermissionTemplateRules：full=L4 / collab=L2 / careful=L1 / readonly=L0。
//   ruleset 不在此内联（前端切档调 importPermissionTemplate(level) 取实际规则，避免双源漂移）。
const _PERMISSION_TEMPLATES_META = [
  { id: "unrestricted", name: "无限制", color: "darkred", level: 5, desc: "全部放行：所有操作自动执行，无任何审批（含危险/敏感操作）", warn: true },
  { id: "full",     name: "自由",   color: "green",  level: 4, desc: "所有工具放行，敏感文件(.env)/删除仍询问" },
  { id: "collab",   name: "协作",   color: "blue",   level: 2, desc: "写/删前询问，读放行（默认档）" },
  { id: "careful",  name: "谨慎",   color: "yellow", level: 1, desc: "几乎全询问，仅纯读放行" },
  { id: "readonly", name: "只读",   color: "red",    level: 0, desc: "禁所有写/删/执行（全询问）" },
];

// ★ FT2：判断一条「allow」规则是否在放宽敏感默认（.env 读写 / 删除类命令）——需二次确认才接受。
//   0715 D2 收口：删除命令首词集/敏感 env 判定改为消费 commandGate 导出（DELETE_CMD_FIRST_WORDS/
//   isSensitiveEnvBasename，经 ideClient re-export），删除原「本地轻量复刻」副本——两处曾注称同口径
//   但集合已分叉（5 项 vs 7 项），单源后不再漂移。glob 通配剥离仍是本函数职责（规则 subject 特有形态）。
//   仅在 action==="allow" 时有意义：deny/ask 不放宽敏感档，无需二次确认。
function _isSensitiveOverrideRule(tool, action, glob, pathPrefix) {
  if (action !== "allow") return false;
  const _norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
  const subj = _norm(glob || pathPrefix);
  if (tool === "run_command") {
    // 删除类命令规则放宽：subject（命令前缀/glob）以删除首词起头。
    const first = subj.trim().split(/\s+/)[0] || "";
    // glob 形态如 "rm*" 也要识别 → 取去掉通配后的首词比对。
    const firstNoGlob = first.replace(/[*?].*$/, "");
    return DELETE_CMD_FIRST_WORDS.has(first) || DELETE_CMD_FIRST_WORDS.has(firstNoGlob);
  }
  // 文件类：subject 命中 .env / .env.*（.env.example 非敏感）。空 subject(通配) 不算定向敏感，不触发。
  if (!subj) return false;
  const base = subj.slice(subj.lastIndexOf("/") + 1).replace(/[*?]/g, "");
  return isSensitiveEnvBasename(base);
}

// ★ FT2：按档位 id 生成规则集。full/collab/careful 复用引擎 buildPermissionTemplateRules(level)（L4/L2/L1）；
//   readonly 不能复用 L0（L0=全 ask），需真正 deny 所有写/删/执行（与徽章描述"禁所有写/删/执行"一致，避免误导）。
// readonly 模板的写工具 deny 列表引用 canonical PERMISSION_WRITE_TOOLS（单一定义在 ideClient.mjs）
const _B3_WRITE_TOOLS_LOCAL = PERMISSION_WRITE_TOOLS;
function _buildTemplateRulesById(templateId, level) {
  if (templateId === "readonly") {
    const _now = new Date().toISOString();
    const mk = (tool) => ({ tool, pathPrefix: "", action: "deny", source: "template", level: 0, createdAt: _now });
    return [..._B3_WRITE_TOOLS_LOCAL.map(mk), mk("run_command")];
  }
  if (templateId === "unrestricted") {
    return buildPermissionTemplateRules(5);
  }
  return buildPermissionTemplateRules(level);
}

/**
 * 审批操作完成（批准/拒绝）后：广播 tool_results_ready（UI 通知）+ 接进后端自动继续系统。
 *
 * 半接线修复（2026-07-14 追链路确诊）：原注释称"触发前端自动继续"，但前端消费端历史上已改为
 * 纯 UI 通知（本体 beilu:toolResultsReady 零监听者；YonBan chat-modes.js 注释称"后端统一处理"）
 * ——两端互指=责任真空，批准后结果长期躺 pendingResults 等用户手动发言。现由本函数（审批完成
 * 四 case 的单一收口点）直接触发后端续轮。triggerCharReply 自带 per-chatid 生成锁
 * （在飞时静默忽略，不打断不重复）。
 *
 * 0714 二修（时序：放行后 AI 零反馈）：续轮不再受 getAutoContinueConfig.enabled 门控——该开关
 * 语义是"普通回合末是否自动继续"，而审批批准/拒绝是用户显式动作（点了按钮=明确要执行/终止并让
 * AI 接住结果），开关关闭时真实执行结果躺 pendingResults 直到用户再发言 =「点了同意却完全没有
 * 反馈」的病根。延迟仍尊重配置（delay_ms）。
 */
async function _broadcastToolResultsReady(_ideClient, chatId, username = "") {
  const _pendingResults = _ideClient.getPendingResults({
    ownerUsername: username,
    chatid: chatId || undefined,
  });
  if (_pendingResults.length === 0) return;
  // [0716 T3对接首批] 原动态 import broadcast.mjs 散拼样板改经 bus:broadcast 出口（exits.mjs 薄包装，
  //   行为等价：dispatch 内部 fail 不抛，ok:false 时 warn=原 catch+warn 同语义）。续轮段（下方
  //   triggerCharReply）非广播域，保持原样。
  if (chatId) {
    const _r = await dispatch({
      target: "bus:broadcast", verb: "emit", source: "yonban",
      payload: { chatid: chatId, event: { type: "tool_results_ready", payload: { count: _pendingResults.length, source: "approval", readOnly: false } } },
    });
    if (_r?.ok) console.log(`[beilu-memory] 审批完成，广播 tool_results_ready (${_pendingResults.length}条结果)`);
    else console.warn("[beilu-memory] 广播 tool_results_ready 失败:", _r?.error?.msg);
  }
  await _triggerContinueAfterUserAction(chatId, username);
}

/**
 * 用户显式动作（IDE 审批批准/拒绝、work 审批决议）完成后的后端续轮触发（单一收口）。
 * 0714 二修语义：无条件触发（用户显式动作≠普通回合末，不受 auto_continue.enabled 门控），只沿用配置延迟；
 * triggerCharReply 自带 per-chatid 生成锁（在飞时静默忽略）。
 * 0715 抽出共用：原为 _broadcastToolResultsReady 内联段（只服务 IDE 审批）；work 审批（resolveWorkApproval）
 * 决议结果走 work/_pending_results.json（GetPrompt 下轮注入）而非 ideClient 池，不能复用带池空检查的
 * _broadcastToolResultsReady——续轮段独立成函数两处共用。
 */
async function _triggerContinueAfterUserAction(chatId, username) {
  if (!chatId || !username) return;
  try {
    const _genPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "generation.mjs");
    const { pathToFileURL: _pfu2 } = await import("node:url");
    const _gen = await import(_pfu2(_genPath).href);
    const _ac = _gen.getAutoContinueConfig?.(username);
    // [0717 时序修] 裸 setTimeout → generation.scheduleAutoContinue 单一收口：此前审批 timer 无句柄
    //   不可取消、不登记 _autoContinueTimers → 与回合末续轮 timer 不互斥（双 timer 各 fire 一轮，
    //   第二轮空转）、用户发消息 cancelAutoContinue 取消不到、_releaseGenerationLock 互斥判断看不见。
    //   收口后同门：登记+可取消+互斥。charname 维持不传（triggerCharReply 取 LastTimeSlice 第一角色，
    //   行为与原版等价；群聊多角色取角问题为已知限制，另行专项）。
    if (typeof _gen.scheduleAutoContinue === "function") {
      const _delay = _ac?.delay_ms || 0;
      _gen.scheduleAutoContinue(chatId, undefined, _delay, "approval");
      console.log(`[beilu-memory] 审批完成 → ${_delay}ms 后触发自动继续`);
    }
  } catch (_acE) {
    console.warn("[beilu-memory] 审批后自动继续接入失败:", _acE.message);
  }
}

/**
 * F3：用户手动改任务后广播 task_update（推送优先轮询，不变式4）。
 * 本窗口 broadcastChatEvent + 跨窗口 broadcastCrossChatEvent（与 replyHandler AI 侧同口径）。
 * @param {string} chatId
 * @param {{tasks:object[], rev:number}} store
 */
async function _broadcastTaskUpdate(chatId, store) {
  if (!chatId || !store) return;
  // [0716 T3对接首批] 双投改经 bus:broadcast 出口（emit=本窗口 / emitCross=跨窗口，exits.mjs 薄包装）。
  const _payload = {
    chatid: chatId,
    tasks: store.tasks,
    rev: store.rev,
    remaining: remainingCount(store),
  };
  const _r1 = await dispatch({
    target: "bus:broadcast", verb: "emit", source: "yonban",
    payload: { chatid: chatId, event: { type: "task_update", payload: _payload } },
  });
  const _r2 = await dispatch({
    target: "bus:broadcast", verb: "emitCross", source: "yonban",
    payload: { chatid: chatId, event: { type: "cross_mode_task_update", subtype: "tasks", payload: _payload } },
  });
  if (!_r1?.ok || !_r2?.ok) console.warn("[beilu-memory] 广播 task_update 失败:", _r1?.error?.msg || _r2?.error?.msg);
}

/**
 * A3：大模式切换（chat/code/work）成功后推送 mode_changed，强化 INJ 互斥实时性。
 * YonBan 面板靠 4s 轮询/手动重连才知道大模式变了（子模式已由 subModeSwitched 推），
 * 这里补本体唯一 producer：switchMode 持久化 + 扇出完成后 push，YonBan 即时同步 _activeMode。
 * 与上方 broadcast 同口径——经 bus:broadcast 出口（0716 T3对接首批，原动态 import broadcast.mjs 散拼已收）。
 * @param {string} chatId  data.chatid（无 chatid 时为 null，跳过）
 * @param {{mode:string, charName:string}} payload
 */
async function _broadcastModeChanged(chatId, payload) {
  if (!chatId) return;
  // [0716 T3对接首批] 改经 bus:broadcast.emit 出口（exits.mjs 薄包装）。
  const _r = await dispatch({
    target: "bus:broadcast", verb: "emit", source: "yonban",
    payload: { chatid: chatId, event: { type: "mode_changed", payload } },
  });
  if (!_r?.ok) console.warn("[beilu-memory] 广播 mode_changed 失败:", _r?.error?.msg);
}

/**
 * [0716 W4 刷新机制] INJ 条目增删改后广播 injection_prompts_changed（preset_list_changed 同范式）。
 * 半链根因：add/update/delete/restore 四个 CRUD case 写成功只 return，无广播——INJ 面板开着时
 * （本窗另一 tab 或跨窗口）名单/开关定格，需手动重开（事件配对矩阵普查 D5 点名）。
 * 消费链：websocket "injection_prompts_changed" → beilu:injectionPromptsChanged → panels.mjs
 * _injPanelRefresh（面板可见时重拉，订阅骨架 0716 已建）。emitAll 按 username 全投（INJ 是 user 级数据）。
 */
async function _broadcastInjPromptsChanged(username) {
  const _r = await dispatch({
    target: "bus:broadcast", verb: "emitAll", source: "yonban",
    payload: { username: username !== "_default" ? username : undefined, event: { type: "injection_prompts_changed", payload: {} } },
  });
  if (!_r?.ok) console.warn("[beilu-memory] 广播 injection_prompts_changed 失败:", _r?.error?.msg);
}

/**
 * mcpConnect 请求文件变化后只广播轻量刷新信号。
 * 配置仍由面板通过当前 chatId 重拉，不在 WS 携带，也不在此触发导入/挂载/批准/连接。
 */
async function _broadcastMcpConnectRequestsChanged(username, request) {
  if (!request?.requestId) return;
  const _r = await dispatch({
    target: "bus:broadcast",
    verb: "emitAll",
    source: "yonban",
    payload: {
      username: username !== "_default" ? username : undefined,
      event: {
        type: "mcp_connect_requests_changed",
        payload: {
          requestId: request.requestId,
          chatId: request.chatId,
          status: request.status,
        },
      },
    },
  });
  if (!_r?.ok) console.warn("[beilu-memory] 广播 mcp_connect_requests_changed 失败:", _r?.error?.msg);
}

/**
 * T052：data 系统写成功后广播 data_system_updated，跨窗口回显同步（补半链的 producer 侧）。
 *
 * 半链根因：data 系统写 handler（addRouteNote/ackDataWarning）只有
 *   diag.log，写成功后直接 return，无广播——窗口A 改完窗口B 不刷新。读侧无变更推送（不做同步）
 *   =典型半链。此函数补 producer，与 _broadcastTaskUpdate 同口径。
 *   （2026-07-16 去重后仅剩 "char" scope 两个 producer；"global" 分支原属 saveFramework/saveIssues 已删，
 *   前端 consumer 仍容忍未知 scope=直刷，参数保留二值签名不改形。）
 *
 * scope 语义（数据归属维度，前端据此决定要不要按 charId 过滤，防串窗）：
 *   - "char"：route/warnings 是 per-char（appendRouteAmendment/ackWarning 传 charName）
 *     → 只有同 charId 的窗口该刷新，前端校验 payload.charId === getCurrentCharId()（防串到别张卡）。
 *
 * 走 broadcastCrossChatEvent（按 username fan-out，源 chatid 已被跳过；#181 不跨用户）——data 系统是
 * per-char 跨对话跨窗口共享，非 per-chatid，故用跨窗口引擎而非本窗口 broadcastChatEvent。
 * 事件形状与前端 handleBroadcastEvent 解包对齐（T023 形状病教训：{type,payload:{charId,scope,kind}} 扁平，
 * 前端读 event.payload.charId / .scope，不嵌套 params）。
 * @param {string|null} chatId  源会话 chatid（作 sourceChatId 被跳过；null 时按显式 username 投递）
 * @param {string} username     已认证用户 owner；chatId 为空时是 fail-closed 隔离所必需
 * @param {string} charName     数据归属角色卡（= args.char_id；前端 getCurrentCharId() 同值，键对齐）
 * @param {"char"} scope        数据维度（route/warnings=char）
 * @param {string} kind         具体写类型（route/warning）——仅供前端 trace/调试，不参与过滤
 */
async function _broadcastDataSystemUpdate(chatId, username, charName, scope, kind) {
  // [0716 T3对接首批] 改经 bus:broadcast.emitCross 出口；chatid 允许 null，但必须携带认证 username。
  const _r = await dispatch({
    target: "bus:broadcast", verb: "emitCross", source: "yonban",
    payload: { chatid: chatId, username, event: { type: "data_system_updated", payload: { charId: charName, scope, kind } } },
  });
  if (!_r?.ok) console.warn("[beilu-memory] 广播 data_system_updated 失败:", _r?.error?.msg);
}

// ============================================================
// C2 字段级 char↔char data 同步（凛倾清单第9行 NEED）
// ------------------------------------------------------------
// 凛倾原话：「角色卡之间的 data 也可以进行同步」「两边状态都能同步，不是一边一种」。
// 现状：zip 整包 export/import（exportMemory/importMemory）有，字段级双向无。
// 本功能在 zip 整包旁补「按数据域」的 char→char 整域复制 action：
//   - 域=用户原话覆盖的数据语义单元 → memory 目录下的相对路径集合。
//   - 方向：源 char → 目标 char 整域覆盖（单向一次）。双向=用户对两个方向各触发一次
//     （原话「两边状态都能同步」=支持任意方向，非自动 merge）。
//   - 冲突语义：设计原话未给字段级 merge 规则 → 按纪律取最保守：**显式整域覆盖**
//     （绝不静默合并），且执行前自动把目标域备份到 D 盘。
//   - A4 username 权威化：username/源 char/目标 char 必须显式，无 _default/_global 回退。
//
// 域→相对路径白名单（相对 memory 目录）。只列原话覆盖的语义域；未登记域不同步。
// 文件型域指向单个文件；目录型域指向整个子目录（递归覆盖）。
const C2_SYNC_DOMAINS = {
  // 三层记忆框架（hot/warm/cold 正文）
  hot:    { label: "热记忆(hot)",   type: "dir",  rel: "hot" },
  warm:   { label: "温记忆(warm)",  type: "dir",  rel: "warm" },
  cold:   { label: "冷记忆(cold)",  type: "dir",  rel: "cold" },
  // 表格（chat/code/work 三套）
  tables:      { label: "聊天表格(tables.json)",      type: "file", rel: "tables.json" },
  code_tables: { label: "代码表格(code_tables.json)", type: "file", rel: "code_tables.json" },
  work_tables: { label: "工作表格(work_tables.json)", type: "file", rel: "work_tables.json" },
  // 记忆预设 + 注入预设绑定（用户原话「预设可以绑定/同步」相关的角色级配置）
  memory_presets: { label: "记忆预设(_memory_presets/)", type: "dir", rel: "_memory_presets" }, // [0717 store v2] directory store (one preset = one file); sync/export follows the dir like hot/warm/cold
  config:         { label: "记忆配置(_config.json)",         type: "file", rel: "_config.json" },
};

/** 该域 key 是否合法 */
function _c2IsValidDomain(domain) {
  return Object.prototype.hasOwnProperty.call(C2_SYNC_DOMAINS, domain);
}

/**
 * 把目标角色某域当前内容备份（执行覆盖前调用，绝不静默丢数据）。
 * 备份根：env BEILU_C2_BACKUP_DIR，缺省 = 项目 data/_c2_backup（P0-2 去硬编码 D:\，他机也能建）。
 * @returns {{ok:boolean, backupDir?:string, error?:string, empty?:boolean}}
 */
function _c2BackupTargetDomain(username, targetChar, domain, targetMemDir) {
  const dom = C2_SYNC_DOMAINS[domain];
  const srcAbs = path.join(targetMemDir, dom.rel);
  // 目标域不存在 → 无需备份（覆盖=新建），标记 empty 让调用方知道
  if (!fs.existsSync(srcAbs)) return { ok: true, empty: true };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]/g, "_");
  // P0-2 去硬编码 D:\：备份根改 env 可配 / 项目 data 相对（__pluginDir 上 5 级=项目根 + data/_c2_backup）。
  // 原写死 <PROJECT_ROOT>\p1_archive\backup 在无 D 盘的他机 mkdir 抛错 → 调用方(1366)会"备份失败=不覆盖"
  // 永久阻断 C2 同步。改 data 相对后任何机器都能建，备份不再阻断同步。
  const _backupBase = process.env.BEILU_C2_BACKUP_DIR
    || path.join(__pluginDir, "..", "..", "..", "..", "..", "data", "_c2_backup");
  const backupDir = path.join(
    _backupBase, "C2_runtime_target_backup",
    `${safe(username)}_${safe(targetChar)}_${safe(domain)}_${ts}`,
  );
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const destAbs = path.join(backupDir, dom.rel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.cpSync(srcAbs, destAbs, { recursive: true });
    return { ok: true, backupDir };
  } catch (e) {
    return { ok: false, error: `C2 备份失败: ${e.message}` };
  }
}

/**
 * 把源角色某域整体覆盖写入目标角色（先删目标域再从源拷贝；目录递归）。
 * 调用方必须已完成 D 盘备份。
 * @returns {{ok:boolean, copied:number, error?:string, missingSource?:boolean}}
 */
function _c2CopyDomain(domain, sourceMemDir, targetMemDir) {
  const dom = C2_SYNC_DOMAINS[domain];
  const srcAbs = path.join(sourceMemDir, dom.rel);
  const dstAbs = path.join(targetMemDir, dom.rel);
  // 越界防御（域 rel 是常量白名单，仍 resolve 校验兜底）
  if (!isPathSafe(srcAbs, path.resolve(sourceMemDir))) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
    return { ok: false, copied: 0, error: "源路径越界" };
  }
  if (!isPathSafe(dstAbs, path.resolve(targetMemDir))) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
    return { ok: false, copied: 0, error: "目标路径越界" };
  }
  if (!fs.existsSync(srcAbs)) {
    // 源域不存在=不覆盖（避免把目标清空）。视为无内容可同步。
    return { ok: true, copied: 0, missingSource: true };
  }
  try {
    // 整域覆盖：先删目标旧内容（已备份），再从源拷贝
    if (fs.existsSync(dstAbs)) fs.rmSync(dstAbs, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.cpSync(srcAbs, dstAbs, { recursive: true });
    // 统计拷贝文件数
    let copied = 0;
    if (dom.type === "file") copied = 1;
    else {
      const _count = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) _count(path.join(d, e.name));
          else copied++;
        }
      };
      if (fs.existsSync(dstAbs)) _count(dstAbs);
    }
    return { ok: true, copied };
  } catch (e) {
    return { ok: false, copied: 0, error: `覆盖写入失败: ${e.message}` };
  }
}

/**
 * [N8] tab/B模式 → beilu-files A 通道模式值 的单一权威映射。
 *   原前端三处散落映射（layout.mjs TAB_TO_MODE / switchTab / messageInput），并轨后权威收成这一份。
 *   A 通道值域 = {chat, file, memory, work}（beilu-files main.mjs setMode validModes）。
 *   语义错位修正：files tab 与 memory tab 在 B 通道都坍缩成 "code"，但 A 通道需区分 file vs memory，
 *     故优先用原始 tab 区分；无 tab（快速命令/记忆面板钮等非 tab 入口）时按 B 模式回退。
 *   返回 null = 该模式无 A 通道对应值（如 companion），调用方不扇出（不补 A 态，by-design）。
 * @param {string|undefined} tab - 前端原始 tab 意图（chat/smart/files/memory/work/bot/helper/companion 等）
 * @param {string} bMode - B 通道已落地的模式（chat/code/work）
 * @returns {"chat"|"file"|"memory"|"work"|null}
 */
// P系列提示词组整组写入的统一归一+守卫（replacePresetPrompts 与 importMemoryPreset 共用，
// 禁再各写一份=散写）：字段归一 → deletable:false 原条目漏删插回 → 内置条目内容/身份标志锁
// （content/builtin/deletable 保原值，role/enabled/name/顺序放行，凛倾0711）
// ── 子模式「成员即有预设」不变式（0804 根因重修）。
//   【why·E 现场根因】原实现对任何缺失 presetName 直接 createBeiluPreset 造 11-entry 骨架——
//   新用户首访 getSubModes 早于 beilu-preset 首访播种，21 个 builtin 名称被骨架抢占同名文件，
//   seedBuiltinsForUser 见「文件已存在」跳过 → 官方完整预设（17-42 prompts）永远进不了用户池，
//   code/work 全线拿 11 条空壳发请求（「预设系统全面死亡」实证）。
//   【修】memory 侧不再是预设内容的第二生产者：缺失时先经 ensurePresetStoreLoaded 触发
//   preset owner 的既有惰性播种（官方 builtin 完整内容，幂等），播种后复查；仍缺 = 非 builtin
//   自定义引用 → 可见警告跳过，交用户在预设面板显式创建或改选——绝不静默造骨架占名。
//   幂等：presetExists 命中直接跳过。消费方：getSubModes（初始化/迁移后）+ saveSubModes（写入后）。──
async function _ensureSubModePresetsFor(smUser, subModes) {
  const _missing = (subModes || []).filter((sm) => sm?.presetName && !presetExists(smUser, sm.presetName));
  if (_missing.length === 0) return 0;
  // [D3 批2·消费 D2-③ Owner API] 原「整店 ensurePresetStoreLoaded 播种 + presetExists 复查」升级为
  //   逐引用 ensurePresetReference（presetBridge 薄适配 → preset owner 单名结构化 ensure）：
  //   builtin=seeded（缺文件复制 DEFAULTS+registry）/reconciled（registry 缺项补）/exists；
  //   用户显式删过的 builtin=skipped-deleted 不复活；非 builtin 缺失=rejected（禁造骨架）。
  //   outcome 可审计单点裁决在 owner，本模块不写任何预设文件（防 E 现场骨架抢名根因复发）。
  let _resolved = 0;
  for (const sm of _missing) {
    const _oc = await ensurePresetReference(smUser, { name: sm.presetName, reference: "submode" });
    if (_oc?.status === "seeded" || _oc?.status === "reconciled" || _oc?.status === "exists") { _resolved++; continue; }
    console.warn(`[beilu-memory] 子模式「${sm.label || sm.id}」引用的预设「${sm.presetName}」未就绪（${_oc?.status || "unknown"}${_oc?.reason ? ":" + _oc.reason : ""}）——不自动生成骨架（防抢占官方命名空间），请显式创建或改选已有预设`);
  }
  return _resolved;
}

function sanitizePromptSet(orig, incoming, presetId, setKey) {
  const _orig = Array.isArray(orig) ? orig : [];
  const _new = incoming.map((p, i) => ({
    role: p.role || "system",
    content: p.content ?? "",
    identifier: p.identifier || `${presetId}_${setKey}_${i}`,
    enabled: p.enabled !== false,
    builtin: p.builtin || false,
    deletable: p.deletable !== false,
    ...(p.name ? { name: p.name } : {}),
  }));
  _orig.forEach((op, oi) => {
    if (op && op.deletable === false && !_new.some((np) => np.identifier === op.identifier)) {
      _new.splice(Math.min(oi, _new.length), 0, op);
    }
  });
  _new.forEach((np) => {
    const op = _orig.find((o) => o && o.identifier === np.identifier);
    if (op && (op.builtin === true || op.deletable === false)) {
      np.content = op.content;
      np.builtin = op.builtin === true;
      np.deletable = op.deletable !== false;
    }
  });
  return _new;
}

function mapToFilesMode(tab, bMode) {
  // 优先按原始 tab 精确区分（file vs memory，B 通道无法区分）
  switch (tab) {
    case "files":
      return "file";
    case "memory":
      return "memory";
    case "work":
      return "work";
    case "chat":
    case "smart":
    case "airp":
    case "bot":
    case "helper":
      return "chat";
    case "companion":
      return null; // companion 无 A 通道对应值
    case "settings":
    case "editor":
      return null; // 不切后端模式
  }
  // 无 tab（非 tab 入口：快速命令 / 记忆面板模式钮 / IDE 自动切）→ 按 B 模式回退
  switch (bMode) {
    case "code":
      return "file"; // IDE/编程 → file
    case "work":
      return "work";
    case "chat":
      return "chat";
    case "companion":
      return null;
    default:
      return null;
  }
}

// SEC-T7/R3：URL 安全校验 + 重定向每跳 assertSafeUrl 收口到 src/server/safe_fetch.mjs 单一权威 safeFetch。
//   原本地手抄 _assertSafeUrl/_safeFetch 删除——杜绝 SSRF 安全逻辑分叉腐烂(权威加固自动生效)。
//   注意：getModels 等"用户自配 LLM 端点"仍走 assertSafeOutboundInServerMode(server 分级豁免,本地放行),不变。

/**
 * 处理 config.SetData 请求
 * @param {object} data - 请求数据
 * @param {object} args - 查询参数
 * @returns {object|undefined}
 */
// SEC（红方 round2 隔离破口D·框架级单一权威 owner 谓词）：IDE 待审批 op 带 chatid 不带 username，
//   一个 chatid 唯一属主 = chatMetadatas.get(chatid).username（与破口1 同源）。审批/读取边界用本谓词解
//   op.chatid 属主，校验 === 请求用户，防 A 批准/查看 B 的 IDE 写/命令(跨用户代执行/泄漏)。chatMetadatas
//   跨 part 动态 import（对齐 chatStorage.deleteChat 反向桥范式）；import 失败/未命中 → null → fail-closed。
export async function _resolveChatOwner(chatid) {
  if (!chatid) return null;
  try {
    const { getChatMetadatas } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
    return getChatMetadatas().get(chatid)?.username ?? null;
  } catch { return null; }
}

/**
 * 回档坐标只能由 chatOps 的稳定消息 ID 解析器决定。targetIndex 仅是旧调用提示，
 * 给出 anchorMessageId 后不得用 hint 覆盖当前真实下标。
 */
async function _resolveRollbackAnchor(chatid, anchorMessageId, indexHint) {
  if (typeof chatid !== "string" || !chatid) throw new Error("缺少 chatId");
  if (indexHint !== undefined && (!Number.isInteger(indexHint) || indexHint < 0)) {
    throw new Error("targetIndex 必须是有限非负整数");
  }
  if (typeof anchorMessageId === "string" && anchorMessageId) {
    const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
    const { pathToFileURL } = await import("node:url");
    const chatOps = await import(pathToFileURL(chatOpsPath).href);
    if (typeof chatOps.resolveMessageAnchor !== "function") {
      throw new Error("聊天锚点解析器不可用，拒绝按易漂移下标回档");
    }
    const resolved = await chatOps.resolveMessageAnchor(chatid, anchorMessageId, indexHint);
    if (!resolved?.found || !Number.isInteger(resolved.index) || resolved.index < 0) {
      const error = new Error(resolved?.reason || "anchor_not_found");
      error.code = "ROLLBACK_ANCHOR_NOT_FOUND";
      throw error;
    }
    return { messageId: resolved.messageId || anchorMessageId, index: resolved.index };
  }
  if (!Number.isInteger(indexHint) || indexHint < 0) throw new Error("缺少 targetIndex 或 anchorMessageId");
  return { messageId: null, index: indexHint };
}

const _ROLLBACK_HISTORY_COORDINATION_CAPABILITY = Symbol("rollback-history-coordination");

/**
 * 仅供服务端 rollbackCoordinator 使用。协调权限由模块私有 Symbol 传递，不能由
 * HTTP/WS payload 中的同名布尔字段伪造。
 */
export async function executeCoordinatedMemoryRollback(data, args) {
  return handleSetData(data, args, _ROLLBACK_HISTORY_COORDINATION_CAPABILITY);
}

function _isActiveCompactSourceEntry(entry) {
  return entry?.extension?._hidden !== true
    && entry?.extension?._deleted !== true
    && entry?._hidden !== true
    && entry?._deleted !== true;
}

async function _readAuthoritativeCompactSource(chatId, sourceMessageIds) {
  if (!Array.isArray(sourceMessageIds)
    || sourceMessageIds.length === 0
    || sourceMessageIds.some((id) => typeof id !== "string" || !id.trim())
    || new Set(sourceMessageIds).size !== sourceMessageIds.length) {
    const error = new Error("sourceMessageIds 必须是唯一非空稳定消息 ID 数组");
    error.code = "E_CONTEXT_SUMMARY_SOURCE_IDS_INVALID";
    throw error;
  }
  const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
  const { pathToFileURL } = await import("node:url");
  const chatOps = await import(pathToFileURL(chatOpsPath).href);
  const total = await chatOps.GetChatLogLength(chatId);
  const chatLog = total > 0 ? await chatOps.GetChatLog(chatId, 0, total) : [];
  const byId = new Map();
  for (let index = 0; index < chatLog.length; index++) {
    const entry = chatLog[index];
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (byId.has(id)) {
      const error = new Error(`权威聊天记录存在重复消息 ID: ${id}`);
      error.code = "E_CONTEXT_SUMMARY_SOURCE_ID_AMBIGUOUS";
      throw error;
    }
    byId.set(id, { entry, index });
  }
  const selected = sourceMessageIds.map((id) => byId.get(id));
  if (selected.some((item) => !item || !_isActiveCompactSourceEntry(item.entry))) {
    const error = new Error("压缩来源已被删除、隐藏或不再存在，旧窗口结果已拒绝");
    error.code = "E_CONTEXT_SUMMARY_SOURCE_SUPERSEDED";
    throw error;
  }
  for (let index = 1; index < selected.length; index++) {
    if (selected[index - 1].index >= selected[index].index) {
      const error = new Error("压缩来源顺序与权威聊天记录不一致");
      error.code = "E_CONTEXT_SUMMARY_SOURCE_ORDER_DRIFT";
      throw error;
    }
  }
  const entries = selected.map(({ entry, index }) => ({
    ...entry,
    _contextSummarySourceIndex: index,
  }));
  const chatHistory = entries.map((entry, index) => {
    const speaker = String(entry?.name ?? entry?.role ?? "未知").trim() || "未知";
    const content = typeof entry?.content === "string"
      ? entry.content.trim()
      : String(entry?.content ?? "").trim();
    return `[消息#${index}] ${speaker}: ${content}`;
  }).join("\n\n");
  return {
    entries,
    chatHistory,
    sourceRevision: computeContextSummarySourceRevision(entries),
  };
}

function _parseExpectedCheckpointIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) {
    throw new Error("expected checkpointIds 必须是非空字符串数组");
  }
  if (new Set(value).size !== value.length) throw new Error("expected checkpointIds 不得重复");
  return [...value];
}

function _sameCheckpointIds(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((id, index) => id === right[index]);
}

function _isCheckpointIdArray(value) {
  return Array.isArray(value)
    && value.every((id) => typeof id === "string" && id)
    && new Set(value).size === value.length;
}

function _isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function _readCheckpointPreviewEnvelope(envelope) {
  const result = envelope?.result;
  const pending = envelope?.pending === true || result?.pending === true;
  const indeterminate = pending || envelope?.indeterminate === true || result?.indeterminate === true;
  const drift = envelope?.drift || result?.drift || null;
  const checkpointSetDrift = envelope?.checkpointSetDrift === true || result?.checkpointSetDrift === true;
  if (pending || indeterminate || drift || checkpointSetDrift === true) {
    return {
      ok: false,
      pending,
      indeterminate,
      drift: drift || (checkpointSetDrift === true ? "checkpointIds" : null),
      result: result && typeof result === "object" ? result : null,
      error: result?.error || envelope?.error || "检查点预览处于未决或已漂移状态",
    };
  }
  if (!envelope || typeof envelope !== "object" || envelope.success !== true) {
    return { ok: false, result: result && typeof result === "object" ? result : null, error: result?.error || envelope?.error || "检查点预览执行端未确认成功" };
  }
  if (!result || typeof result !== "object" || result.success !== true) {
    return { ok: false, result: result && typeof result === "object" ? result : null, error: result?.error || "检查点预览缺少内层 success:true" };
  }
  const shapeOk = _isCheckpointIdArray(result.checkpointIds)
    && result.checkpointSetDrift === false
    && Number.isInteger(result.checkpointsToRevert) && result.checkpointsToRevert >= 0
    && result.checkpointsToRevert === result.checkpointIds.length
    && _isStringArray(result.filesToRestore)
    && _isStringArray(result.filesToDelete);
  if (!shapeOk) {
    return { ok: false, result, error: "检查点预览协议不完整，拒绝生成回档令牌" };
  }
  return { ok: true, result };
}

/**
 * 纯函数：把 callTool 外层 envelope 与 FileCheckpoint 内层结果归一化。
 * pending/indeterminate 不是失败终态；调用方必须停止截断对话并禁止重试。
 */
export function normalizeRollbackFileResult(fileResult, expectedCheckpointIds = undefined) {
  const outer = fileResult && typeof fileResult === "object" && !Array.isArray(fileResult)
    ? fileResult
    : {};
  const inner = outer.result && typeof outer.result === "object" && !Array.isArray(outer.result)
    ? outer.result
    : outer;
  const conflicts = [];
  const _protocolEqual = (left, right) => {
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length
        && left.every((value, index) => Object.is(value, right[index]));
    }
    return Object.is(left, right);
  };
  const protocolField = (name) => {
    const hasInner = Object.hasOwn(inner, name);
    const hasOuter = inner !== outer && Object.hasOwn(outer, name);
    if (hasInner && hasOuter && !_protocolEqual(inner[name], outer[name])) conflicts.push(name);
    return hasInner ? inner[name] : outer[name];
  };
  // 先读完所有重复危险字段，任一外层/内层冲突都 fail-closed。
  const successField = protocolField("success");
  const partialField = protocolField("partial");
  const pendingField = protocolField("pending");
  const indeterminateField = protocolField("indeterminate");
  const driftField = protocolField("drift");
  const pending = outer.pending === true || inner.pending === true;
  const indeterminate = pending || outer.indeterminate === true || inner.indeterminate === true;
  const hasDrift = driftField !== undefined && driftField !== null && driftField !== "";
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  const attemptedField = protocolField("attempted");
  const checkpointsAttemptedField = protocolField("checkpointsAttempted");
  if (attemptedField !== undefined && checkpointsAttemptedField !== undefined
    && !_protocolEqual(attemptedField, checkpointsAttemptedField)) conflicts.push("attempted/checkpointsAttempted");
  const attempted = count(attemptedField ?? checkpointsAttemptedField);
  const reverted = count(protocolField("reverted") ?? protocolField("checkpointsReverted"));
  const totalRestored = count(protocolField("totalRestored"));
  const totalDeleted = count(protocolField("totalDeleted"));
  const checkpointSetDrift = protocolField("checkpointSetDrift");
  const resultCheckpointIds = protocolField("checkpointIds");
  const remainingCheckpointIds = protocolField("remainingCheckpointIds");
  const errors = protocolField("errors");
  const failedFiles = protocolField("failedFiles");
  const hasExpected = expectedCheckpointIds !== undefined;
  const expectedValid = !hasExpected || _isCheckpointIdArray(expectedCheckpointIds);
  const resultCheckpointIdsValid = _isCheckpointIdArray(resultCheckpointIds);
  const remainingCheckpointIdsValid = _isCheckpointIdArray(remainingCheckpointIds);
  const errorsValid = _isStringArray(errors);
  const failedFilesValid = _isStringArray(failedFiles);
  const expectedIds = hasExpected && expectedValid ? expectedCheckpointIds : resultCheckpointIds;
  const expectedCount = Array.isArray(expectedIds) ? expectedIds.length : -1;
  const canonicalInnerShape = [
    "success", "partial", "checkpointSetDrift", "attempted", "reverted",
    "checkpointsReverted", "totalRestored", "totalDeleted", "errors", "failedFiles",
    "checkpointIds", "remainingCheckpointIds",
  ].every((name) => Object.hasOwn(inner, name));
  const shapeOk = conflicts.length === 0
    && canonicalInnerShape
    && expectedValid
    && !hasDrift
    && inner.partial === false
    && partialField === false
    && checkpointSetDrift === false
    && Number.isInteger(protocolField("attempted")) && protocolField("attempted") >= 0
    && Number.isInteger(protocolField("reverted")) && protocolField("reverted") >= 0
    && Number.isInteger(protocolField("checkpointsReverted")) && protocolField("checkpointsReverted") >= 0
    && Number.isInteger(protocolField("totalRestored")) && protocolField("totalRestored") >= 0
    && Number.isInteger(protocolField("totalDeleted")) && protocolField("totalDeleted") >= 0
    && errorsValid
    && failedFilesValid
    && resultCheckpointIdsValid
    && remainingCheckpointIdsValid
    && protocolField("reverted") === protocolField("checkpointsReverted");
  const semanticOk = shapeOk
    && (!hasExpected || _sameCheckpointIds(resultCheckpointIds, expectedCheckpointIds))
    && errors.length === 0
    && failedFiles.length === 0
    && remainingCheckpointIds.length === 0
    && attempted === expectedCount
    && reverted === expectedCount;
  const confirmed = outer.success === true
    && inner.success === true
    && successField === true
    && !indeterminate
    && semanticOk;
  const partial = confirmed
    ? false
    : (indeterminate || outer.partial === true || inner.partial === true || reverted > 0 || totalRestored > 0 || totalDeleted > 0);
  const fileRollback = {
    success: confirmed,
    partial,
    pending,
    indeterminate,
    ...(driftField !== undefined ? { drift: driftField } : {}),
    attempted,
    reverted,
    checkpointsReverted: reverted,
    totalRestored,
    totalDeleted,
    ...(typeof checkpointSetDrift === "boolean" ? { checkpointSetDrift } : {}),
    ...(resultCheckpointIds !== undefined ? { checkpointIds: resultCheckpointIds } : {}),
    ...(remainingCheckpointIds !== undefined ? { remainingCheckpointIds } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(failedFiles !== undefined ? { failedFiles } : {}),
  };
  return {
    confirmed,
    pending,
    indeterminate,
    shapeOk,
    semanticOk,
    conflicts,
    fileRollback,
    error: conflicts.length > 0
      ? `回档执行包外层/内层危险字段冲突: ${[...new Set(conflicts)].join(", ")}`
      : (hasDrift ? `回档执行结果存在漂移: ${String(driftField)}` : (inner.error || outer.error || null)),
  };
}

function _memoryArchiveNotCovered() {
  return {
    status: "not_covered",
    coveredByLedger: false,
    affectedOperations: null,
    restoredOperations: 0,
    reason: "角色级 hot/warm/cold 归档记忆尚无按消息范围的操作账本或快照，本次回档无法恢复该层。",
  };
}

function _legacyContextSummaryNotCovered() {
  return {
    status: "not_covered_ambiguous",
    deleted: false,
    reason: "角色级 legacy context_summary 没有 chatId 归属账本，无法证明属于本次对话，回档不删除。",
  };
}

function _withMemoryArchiveCoverage(result) {
  return {
    ...(result || {}),
    memoryArchive: _memoryArchiveNotCovered(),
    legacyContextSummary: _legacyContextSummaryNotCovered(),
  };
}

// 0714 chatid→char 归位（与 _resolveChatOwner 同源同范式）：无 char 上下文的调用方（YonBan 等）
// 带 chatid 时按 chat 元数据 primaryCharName 解析——不归位会落 _global 写成死桶（per-char 消费端
// 如 aiRunner web_search 无 _global 回退；表格域=记录与 web 面板 per-char 桶分家，_global/code_ctx
// 与 char/code_ctx 同批 cid 目录并存实证）。显式 charName/char_id 恒优先；解析失败回落原值。
// 消费方：handleSetData 主体 charName 解析 + switchMode/getMode/bindChatMode/updateConfig/
//   getWebSearchConfig + getDataHandler.handleGetData（新增无 char 上下文的 case 一律用本函数，禁再内联复制）。
// [2026-07-16 断链修] chatid 取形扩到 data.chatid||data.chatId||args?.chatid（与 :747/:927 取形对齐）——
//   原只认 data.chatid，桥盖章走 args.chatid 的调用方（sendAction 通配桥）从未被归位过。
// [2026-07-17 链1 修·export] getData 读侧同用：0714 只装了 setData 侧=半修，读恒 _global 写落
//   per-char（联网开关"重启即关"实锤病根），读写必须同一归位函数。
export async function _resolveRequestChar(data, args, fallbackChar) {
  const _rcCid = data?.chatid || data?.chatId || args?.chatid || null;
  if (data?.charName || args?.char_id || !_rcCid) return fallbackChar;
  try {
    const { getChatMetadatas, tryRepairChatPath } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
    let _m = getChatMetadatas().get(_rcCid);
    // [char归位·永不落_global毒桶] primaryCharName 空(元数据未定 owner)会回落 fallbackChar(_global)，
    //   读侧落 _global 桶而写侧(前端带 charName)落真角色 → active_modes_map 等读写不同源。对话文件物理
    //   归属可从目录反查：tryRepairChatPath 扫 chars/*/chats/ 命中即回写 primaryCharName(幂等自愈，
    //   首次后 _m.primaryCharName 已填、后续跳过扫描)。真正无归属(旧路径 shells/chat/chats)仍回落 fallback。
    if (_m && !_m.primaryCharName && _m.username) {
      try { tryRepairChatPath(_m.username, _rcCid, ""); _m = getChatMetadatas().get(_rcCid); } catch { /* 扫描失败=保持原回落，不阻断 */ }
    }
    return _m?.primaryCharName || fallbackChar;
  } catch { return fallbackChar; }
}

// 0714 权限等级写盘单点（与 setPermissionLevel case / importPermissionTemplate 档位联动共用）：
// 同键（permission_level.json .level）只允许这一个写函数，防同键双写路散拼。
function _writePermissionLevel(username, level) {
  const _plPath = path.join(__projectRoot, "data", "users", username, "permission_level.json");
  const _plDir = path.dirname(_plPath);
  if (!fs.existsSync(_plDir)) fs.mkdirSync(_plDir, { recursive: true });
  saveJsonFile(_plPath, { level, updatedAt: new Date().toISOString() });
}

// 归档配置单一权威（三模式映射 + 字段白名单 + 默认）。统一 get/updateArchiveConfig 与旧
// get/update[Code|Work]ArchiveConfig 都委托此处 → 逻辑一处不双套；顺带修旧 updateCodeArchiveConfig
// 无白名单把 _action/chatid 污染进 code_archive 的 bug。chat 此前完全无 config action，于此补齐。
// table_archive（表格归档系统 per-table 配置，25批21 加）：{ [tableId]: {enabled, max_rows, keep_recent} }。
//   放进 allow 白名单 → updateArchiveConfig 不再 strip 它（现有 getArchiveConfig/updateArchiveConfig 复用同一 spec，
//   自动获得读写能力，无需新 verb 也能配；专用 get/updateTableArchiveConfig 提供 per-table patch 便捷面）。
//   ★默认关：def 不含 table_archive（缺省=undefined=触发器空 map=无表参与），符合「chat 现状无表格归档默认关」决议。
const _ARCHIVE_SPEC = {
  chat: {
    key: "archive",
    allow: ["enabled", "temp_memory_threshold", "remember_archive_days", "forever_max", "cold_archive_after_days", "table_archive"],
    def: { enabled: true, temp_memory_threshold: 50, remember_archive_days: 3, forever_max: 200, cold_archive_after_days: 30 },
  },
  code: {
    key: "code_archive",
    allow: ["enabled", "total_rows_threshold", "archive_age_days", "auto_summary", "table_archive"],
    def: { enabled: true, total_rows_threshold: 80 },
  },
  work: {
    key: "work_archive",
    allow: ["enabled", "total_rows_threshold", "archive_age_days", "auto_summary", "table_archive"],
    def: { enabled: true, total_rows_threshold: 80, archive_age_days: { experience: 14 }, auto_summary: false },
  },
};
function _archiveSpec(mode) {
  return _ARCHIVE_SPEC[mode] || _ARCHIVE_SPEC.chat;
}
function _readArchiveConfig(memDir, mode) {
  const spec = _archiveSpec(mode);
  const cfg = loadJsonFileIfExists(path.join(memDir, "_config.json"), {});
  return { ...spec.def, ...(cfg[spec.key] || {}) };
}
function _writeArchiveConfig(memDir, mode, patch) {
  const spec = _archiveSpec(mode);
  const cfgPath = path.join(memDir, "_config.json");
  const cfg = loadJsonFileIfExists(cfgPath, { enabled: true });
  cfg[spec.key] = { ...(cfg[spec.key] || {}) };
  for (const k of spec.allow) if (patch[k] !== undefined) cfg[spec.key][k] = patch[k];
  saveJsonFile(cfgPath, cfg);
  return cfg[spec.key];
}

// 表格归档系统 per-table 配置（25批21）：读/写 <mode 归档键>.table_archive 子 map。
//   _read 返回 { [tableId]: {enabled, max_rows, keep_recent} }（缺省空 {} = 无表启用 = 默认关）。
//   _write 做 per-table 字段白名单 merge（防 _action/chatid 等 payload 噪声污染进 config，同 _writeArchiveConfig 范式）。
// archive_batch（每次归档条数上限，0=不限）/file_name_template（{date}/{tableId}/{tableName}）：
//   20260712 凛倾归档设置面补齐，默认值权威源 = backgroundTasks.TABLE_ARCHIVE_DEFAULTS 单源
const _TABLE_ARCHIVE_FIELDS = ["enabled", "max_rows", "keep_recent", "archive_batch", "min_archive_rows", "file_name_template"];
function _readTableArchiveConfig(memDir, mode) {
  const spec = _archiveSpec(mode);
  const cfg = loadJsonFileIfExists(path.join(memDir, "_config.json"), {});
  return (cfg[spec.key] && cfg[spec.key].table_archive) || {};
}
function _writeTableArchiveConfig(memDir, mode, tableId, patch) {
  const spec = _archiveSpec(mode);
  const cfgPath = path.join(memDir, "_config.json");
  const cfg = loadJsonFileIfExists(cfgPath, { enabled: true });
  cfg[spec.key] = { ...(cfg[spec.key] || {}) };
  const _ta = { ...(cfg[spec.key].table_archive || {}) };
  const _key = String(tableId);
  const _entry = { ...(_ta[_key] || {}) };
  for (const k of _TABLE_ARCHIVE_FIELDS) if (patch[k] !== undefined) _entry[k] = patch[k];
  _ta[_key] = _entry;
  cfg[spec.key].table_archive = _ta;
  saveJsonFile(cfgPath, cfg);
  return _ta;
}

// 表格归档族 mode 解析单一收口（20260712 凛倾「双键不同步/前后端默认分叉」诊断修复）。
//   病根：getData 空 viewMode = loadMemoryData 按 per-chatId active_mode 回退（getDataHandler.mjs:91），
//   而归档族 verb 空 mode 此前 = chat 硬默认——两个「空」的语义分叉 → 用户看着 A 桶的表，归档动作/列表打到 chat 桶，
//   三个归档入口（行归档设置/归档列/列头📦）互相「不同步」。
//   修法：空/未知 mode → 与读端同源走 getActiveMode(per-chatId)，显式三值原样用；内联三元 8 处散写收口到此一处。
function _resolveTableMode(data, username, charName, chatId) {
  if (data.mode === "code" || data.mode === "work" || data.mode === "chat") return data.mode;
  const _m = getActiveMode(username, charName, chatId || null);
  return (_m === "code" || _m === "work") ? _m : "chat";
}

// D-1 游戏陪伴：启动时解析有效角色(角色卡)，带存在性校验 + 明示 fallback。
//   解析结果只用于创建 session；运行后 gameCompanion 以 username 寻址唯一 runtime，
//   session.charName/chatid 固定，不随前端当前角色或后续 bindChar 改动漂移。
//   bindChar 指向被删角色卡 → 启动时回退当前 charName。
function _resolveCompanionChar(username, charName, cfg, warnings = []) {
  let effChar = charName;
  if (cfg && cfg.bindChar) {
    const charDir = path.join(__projectRoot, "data", "users", username, "chars", cfg.bindChar);
    let ok = false;
    try { ok = fs.existsSync(charDir) && fs.statSync(charDir).isDirectory(); } catch { ok = false; }
    if (ok) effChar = cfg.bindChar;
    else warnings.push({ field: "bindChar", value: cfg.bindChar, reason: "not_found", fellBackTo: charName });
  }
  return effChar;
}

// [凛倾 2026-07-22 框架级重构]"陪伴模式需要单独创建一个对话文件.至少别影响其他窗口使用":
//   陪伴对话=独立专门对话文件,【前端当前对话彻底退出路由】——原 follow(跟随当前对话)设计整体删除,
//   它就是陪伴消息落进 IDE/work 对话+触发其自动继续的根源(0722 实测活bug)。
//   路由=两级:bindChat(用户显式锁定,校验存在) > companion 专门对话(ensureBotChat 幂等指针,
//   bot 符号命名被普通列表屏蔽,新对话默认 chat 模式=AIRP 形态)。
//   防呆:bindChat 指向 code/work 对话也拒绝(凛倾:"只可以使用airp或者专门的"),落专门对话并 warning。
//   仅 start 调用(session.charName/chatid 定于启动)；stop/status/action 按 username 命中正在运行的实例，
//   避免状态轮询重新解释当前角色/绑定，更不会产生"顺手建对话"副作用。
async function _resolveCompanionTarget(username, charName, cfg) {
  const warnings = [];
  const effChar = _resolveCompanionChar(username, charName, cfg, warnings);
  let effChatid = null;
  // bindChat 仅在用户显式选「锁定指定对话」(bindMode=independent)时参与——防 UI 切回"专门"后
  // 旧 bindChat 残值抢路由(前端两态选择器语义对齐)
  if (cfg && cfg.bindMode === "independent" && cfg.bindChat) {
    let ok = false;
    try {
      const charsRoot = path.join(__projectRoot, "data", "users", username, "chars");
      if (fs.existsSync(charsRoot)) {
        for (const d of fs.readdirSync(charsRoot, { withFileTypes: true })) {
          if (d.isDirectory() && fs.existsSync(path.join(charsRoot, d.name, "chats", cfg.bindChat + ".json"))) { ok = true; break; }
        }
      }
    } catch { ok = false; }
    if (ok) {
      // 角色与承载对话必须是同一份契约：旧实现只证明 chat 文件存在，却没有证明其中挂载了
      // bindChar。gameCompanion 随后把 session.charName 丢掉、生成器再从对话首角色猜，导致
      // bindChar/实际 prompt/API 源分叉。显式绑定不擅自往用户已有对话加角色；不匹配就如实
      // 回退专门陪伴线并返回 warning。
      let _hasBoundChar = false;
      try {
        const { loadChat: _loadBoundChat } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
        const _boundMeta = await _loadBoundChat(cfg.bindChat);
        _hasBoundChar = !!_boundMeta?.LastTimeSlice?.chars?.[effChar];
      } catch { _hasBoundChar = false; }
      if (!_hasBoundChar) {
        warnings.push({ field: "bindChat", value: cfg.bindChat, reason: "character_mismatch", expectedChar: effChar, fellBackTo: "companion_dedicated" });
      } else {
        const _bindModeOfChat = getActiveMode(username, effChar, cfg.bindChat);
        if (_bindModeOfChat === "code" || _bindModeOfChat === "work") {
          warnings.push({ field: "bindChat", value: cfg.bindChat, reason: `mode_${_bindModeOfChat}_forbidden`, fellBackTo: "companion_dedicated" });
        } else {
          effChatid = cfg.bindChat;
        }
      }
    } else {
      warnings.push({ field: "bindChat", value: cfg.bindChat, reason: "not_found", fellBackTo: "companion_dedicated" });
    }
  }
  if (!effChatid) {
    const { ensureBotChat } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatOps.mjs");
    const _ded = await ensureBotChat(username, effChar, "companion", {});
    effChatid = _ded.chatid;
    // [凛倾 0723 陪伴子模式化·时序] 专门陪伴对话的 per-chat 模式落子(先于首轮生成):
    //   getActiveMode 三级回退(per-chat→char级→_global)在本对话无记录时会吃到 AIRP 侧
    //   刚切的 char 级模式(code/work 漂移进陪伴,INJ 门控/子模式域随之漂移)。专门对话按设计
    //   恒为 chat 域(bindChat 防呆同判据),每次启动写实 per-chat 绑定=回退链永不触发。
    //   4 参调用只写线级 active_modes_map[effChatid],不污染 char 级(委派链同语义,:832)。
    //   bindChat(用户锁定的既有对话)路径刻意不写——跟随该对话自身配置(谁最后绑定跟随谁)。
    try { setActiveMode(username, effChar, "chat", effChatid); } catch (e) { warnings.push({ field: "modeBind", value: effChatid, reason: "set_active_mode_failed:" + (e?.message || e) }); }
  }
  return { effChar, effChatid, warnings };
}

/**
 * [P0-C 2026-08-03] chat 归属校验单源：chatid → chatMetadatas 索引（启动全量扫描 + 创建即入索引）。
 * 未知 chatid / 归属不匹配 / 校验设施不可用 → 一律 fail-closed（不可证明即不放行）。
 * 消费方：handleSetData 头部统一闸（data.chatid/chatId/args.chatid 归一值）+ bindChatMode 的 chat_id。
 */
async function _verifyChatOwnership(chatid, username) {
  try {
    const { getChatMetadatas, initializeChatMetadatas } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
    let _meta = getChatMetadatas().get(chatid);
    // [0808下午 两态拆分·框架修] 原实现把「索引未就绪」与「确实无此 chatid」折叠成同一个
    //   E_CHAT_UNKNOWN：启动窗口期/worker isolate 未扫盘时，早到的合法请求被批量误拒
    //   （0808 日志 chatOwnerReject 14+ action 竞态族）。未命中先走与 loadChat(:749) 同一条
    //   自愈路——initializeChatMetadatas 幂等扫盘（内置 5s 节流，真未知 chatid 重复打不穿）——
    //   再重查；仍未命中才是「已就绪且查无」，维持 P0-C fail-closed 拒绝语义不变。
    if (!_meta) {
      try { initializeChatMetadatas(); } catch { /* 扫盘失败按未命中处理，落入 fail-closed */ }
      _meta = getChatMetadatas().get(chatid);
    }
    if (!_meta) return { ok: false, code: "E_CHAT_UNKNOWN", error: `chatid 未知，归属不可证明（fail-closed）: ${String(chatid).slice(0, 40)}` };
    if (_meta.username !== username) return { ok: false, code: "E_CHAT_OWNER_MISMATCH", error: "chatid 不属于当前认证用户，已拒绝" };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "E_CHAT_OWNER_UNVERIFIABLE", error: `chat 归属校验不可用（fail-closed）: ${e?.message || e}` };
  }
}

export async function handleSetData(data, args, internalCapability = null) {
  if (!data) return;

  // SEC-T1（跨账号越权根因·框架级单点收口）+ [P0-C 2026-08-03 升级]：存在认证上下文(args.username)时，
  //   认证身份是 username 的唯一权威源。原实现静默覆盖 data.username——payload 与可信身份
  //   不一致时现在【直接拒绝】（任务 MD P0-C 要求2：不能静默任选一个），一致/缺失才归一。
  //   无 args.username 的调用（纯插件间内部调用）不受影响。
  //   [分身C 0803 注释校准] 原例"parts_loader:670 恢复无 username"已失真——parts_loader 生命周期
  //   SetData 现带 username（lifecycleContext），不再点名行号防漂移。
  if (args?.username) {
    if (typeof data.username === "string" && data.username && data.username !== args.username) {
      wbD(null, "setDataActions", "handleSetData:identityMismatch", false,
        `payload username 与认证身份不一致（拒绝）`, { _action: data._action });
      return { success: false, code: "E_IDENTITY_MISMATCH", error: "payload username 与认证身份不一致，已拒绝" };
    }
    data.username = args.username;
  }

  // 桥接调用把认证会话写在 args.chatid（HTTP/WS dispatch 同契约），旧 REST 调用
  // 仍可能把 chatid 放在 data。两条入口必须在这里统一归一；否则 ideToolCall 会
  // 以无会话 Job 执行，owner 广播被拒，运行快照也无法按当前聊天读到该 Job。
  // [分身C 0803 堵洞] 归一公式与下方 _rawChatId 完全同源（含 args.chat_name 派生候选）——
  //   原头部闸少 chat_name 一路，调用方只传 chat_name 时可绕过归属校验（枚举现存调用方虽未触发，
  //   两公式不同源本身就是绕过面，收成同一公式）。
  const _chatid = data.chatid || data.chatId || args?.chatid ||
    (args?.chat_name ? args.chat_name.replace("common_chat_", "") : null);

  // [P0-C 2026-08-03] chat owner 统一校验（任务 MD P0-C 要求4）：认证上下文存在且 action 带 chatid
  //   时，chatid 必须属于认证用户——未知 chatid（索引无记录=归属不可证明）与归属不匹配一律
  //   fail-closed 拒绝。chatMetadatas 索引启动即全量扫描（chatStorage.mjs:236-303），新建对话
  //   创建时入索引，可靠作为归属单源。payload 指向自己名下另一条线（记忆中心跨线查看/编辑）
  //   仍合法——安全不变量是「归属」而非「与传输会话同线」。
  if (_chatid && args?.username) {
    const _own = await _verifyChatOwnership(_chatid, args.username);
    if (!_own.ok) {
      wbD(_chatid, "setDataActions", "handleSetData:chatOwnerReject", false, `${_own.code}: ${_own.error}`, { _action: data._action });
      return { success: false, code: _own.code, error: _own.error };
    }
  }
  const _isReadOnly = typeof data._action === "string" && (data._action.startsWith("get") || data._action.startsWith("list"));
  if (!_isReadOnly) {
    wbT(_chatid, "setDataActions", "handleSetData:enter", { _action: data._action, username: data.username, charName: data.charName });
  }

  if (data._action === "setEnabled") {
    setPluginEnabled(data.enabled);
    return;
  }

  // === 模式切换 ===
  if (data._action === "switchMode") {
    const targetMode = data.mode;
    if (!targetMode) return { success: false, error: "缺少 mode 参数" };
    if (!isValidModeId(targetMode)) { // T5：内置集 _validModeIds+已注册自定义
      return { success: false, error: `非法模式值: ${targetMode}` };
    }
    const switchUsername = data.username || args?.username || "_default";
    // [2026-07-16 断链② 修] 无 char 调用方（YonBan）切模式原直写 _global 的 active_mode——经
    //   getActiveMode 第三级回退（per-cid → char 级 → _global）污染一切"char 级无记录"窗口的模式
    //   解析（airp 表格面板翻成 code 的后端毒源，盘上 _global active_mode=code 实证）。带 chatid 归位。
    const switchCharName = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
    // [P0-C 2026-08-03] switchMode 全链 canonical chatid 单源（任务 MD P0-C 要求5）：
    //   原实现写入/verify/files 扇出读 data.chatid、broadcast 却读 _chatid（data||args 合成）——
    //   payload 无 chatid 而桥会话有时，广播与写入取值分叉。现四消费点统一 _switchChatId
    //   （payload 显式声明=线级写意图；无声明=char 级语义，广播走无 chatid 的 emitAll 回退）。
    //   归属已在 handleSetData 头部闸校验（data.chatid 是 _chatid 首选候选）。
    const _switchChatId = data.chatid || data.chatId || null;
    // [0808 模式=窗口身份·凛倾拍板「绑定角色卡和窗口，不绑对话id」] windowToken=发起切换的前端窗口
    //   实例令牌（featureControls getWindowInstanceToken 每窗一份，页内存续）。它随 mode_changed 广播
    //   原样回显，前端 _beiluApplyModeFromWs 据此只应用【本窗发起】的切换回流——两窗绑同一条对话时，
    //   B 的用户切换不再翻转 A 的窗口模式（跨窗互拽死循环的翻转通路之一）。后端不解释不存储该令牌，
    //   纯回显；缺失（旧前端/AI 链/YonBan）= 广播无 token，前端按"非本窗"处理。
    const _switchWindowToken = (typeof data.windowToken === "string" && data.windowToken.length <= 64) ? data.windowToken : null;
    wbT(_chatid, "setDataActions", "switchMode:enter", { targetMode, switchUsername, switchCharName, switchChatId: _switchChatId });
    console.log(`[beilu-memory] switchMode: mode=${targetMode}, user=${switchUsername}, char=${switchCharName}`);
    // [隔离架构 2026-07-25 mode 域对称化 · 凛倾「高内聚低耦合」] 带窗口坐标=只写线级（与 preset 域
    //   actSetLine 对称）：原实现无条件先调 3 参 setActiveMode（写 char 级 active_mode + _global 层，
    //   storage.mjs setActiveMode 无 chatId 分支）再带 cid 追加线级——窗口 A 切模式必污染同 char 全部
    //   "无线级记录"窗口的回退层（多窗口被强制切换的 mode 域病根，与 preset 全局槽被夺同构）。
    //   char 级/_global 保留"无记录对话初始回退"语义（0708 N38），现只被无坐标调用方
    //   （YonBan/委派链等显式 char 级语义）更新；4 参线级分支 storage 侧本就早返回不碰 char 级。
    const result = _switchChatId
      ? setActiveMode(switchUsername, switchCharName, targetMode, _switchChatId)
      : setActiveMode(switchUsername, switchCharName, targetMode);
    if (result.success) {
      // [0808 verify 读回删除·两窗死循环根修] 原 A3 verify（写后 getActiveMode 读回比对）在两窗绑
      //   同一条对话时是假失败产生器：A 写完 map[cid]、verify 前 B 并发写同键不同值 → A 读到 B 的值
      //   → 误报"验证失败" → 前端回滚 tab → B 侧对称发生 → 互相回退死循环（凛倾 0808 第二循环）。
      //   写路径本身可信：setActiveMode 全同步 RMW（saveJsonFile=nicerWriteFileSync），单进程事件循环内
      //   不可被打断，写失败会经 setActiveMode 自身返回 success:false——读回验证只多出竞态窗口，删。
      // [0716 凛倾定案] 「模式绑定预设」概念整体删除（原 mode_preset_bindings 读取+首入初始化块在此）：
      //   设计里只有「当前正在使用的预设」（active_preset_map[cid:mode]，无记录回退全局 active_preset）。
      // scheduler 生命周期跟 ModeDef 声明（features.scheduler.enabled），零硬编码模式名。
      // 顶部已静态 import start/stopScheduler+schedulerFeature+modeFeaturesReady（原动态 import 是同文件双份写法，收口）。
      // 声明表未就绪（重启后预热未达的最初数秒）＝未知态不动作：跳过启停防「切 work 被全 false 误 stop」，
      // 调度器状态由 resumeSchedulers/预热/下次生成兜（0716 审查风险3 修复）。
      if (!modeFeaturesReady()) {
        console.warn(`[beilu-memory] switchMode: ModeDef 声明表未就绪，本次跳过 scheduler 启停（mode=${targetMode}）`);
      } else if (schedulerFeature(targetMode).enabled) {
        try {
          const _memDir = ensureMemoryDir(switchUsername, switchCharName);
          startScheduler(switchUsername, switchCharName, _memDir);
        } catch (e) {
          console.warn(`[beilu-memory] switchMode: 启动 scheduler 失败: ${e.message}`);
        }
      } else {
        try {
          stopScheduler(switchUsername, switchCharName);
        } catch (e) {
          console.warn(`[beilu-memory] switchMode: 停止 scheduler 失败: ${e.message}`);
        }
      }

      // [N8] 单入口扇出：模式切换并轨为一条后端线路。
      //   原前端在 switchTab 内并发发两请求（B=本插件 switchMode + A=beilu-files setMode），
      //   互不 await、任一失败不回滚另一，且 A 通道全局单例/值域错位 → 两通道可永久不一致。
      //   现 B 通道为唯一入口：持久化 active_mode 后，服务端内部调 beilu-files setMode（同 ideClient.mjs
      //   反向桥 import 插件 main.mjs 的 interfaces.config.SetData 既有 seam，禁造旁路；
      //   插件实体在 src/public/parts/plugins/beilu-files/，非 yonban/core 骨架——迁移时相对路径必须重锚）。
      //   tab→A值映射单源在此（mapToFilesMode），前端散落的 TAB_TO_MODE A 值口径权威搬进来。
      //   B 持久化为权威，不因 A 失败回滚（A 可由下次切换自愈）；A 结果回填响应供前端可见（不静默吞）。
      const _filesMode = mapToFilesMode(data.tab, targetMode);
      if (_filesMode) {
        try {
          const _filesMod = await import("../../../../../public/parts/plugins/beilu-files/main.mjs");
          const _setData = _filesMod?.default?.interfaces?.config?.SetData;
          if (typeof _setData === "function") {
            const _filesRes = await _setData({
              _action: "setMode",
              mode: _filesMode,
              chatid: _switchChatId || "",
              currentMessageCount: data.currentMessageCount ?? -1,
            });
            result.filesMode = "ok";
            // setMode 退文件/记忆模式时返回 { _cleanup: {...} }（隐藏对话消息的前端动作）。
            //   原 notifyActiveMode 在前端处理；并轨后随 B 响应回传，前端 _doSwitchMode 接管。
            if (_filesRes && _filesRes._cleanup) {
              result._filesCleanup = _filesRes._cleanup;
            }
          } else {
            result.filesMode = "failed";
            console.warn(`[beilu-memory] switchMode 扇出: beilu-files SetData 不可用`);
          }
        } catch (e) {
          // A 失败不回滚 B（B 是权威）；标记失败让响应可见，不静默吞
          result.filesMode = "failed";
          console.warn(`[beilu-memory] switchMode 扇出 beilu-files 失败: ${e.message}`);
        }
      } else {
        // companion 等无 A 通道对应值的模式：不扇出（by-design，不补 A 态）
        result.filesMode = "skipped";
      }

      // A3：大模式持久化 + 扇出完成后广播 mode_changed（本体唯一 producer）。
      //   INJ 互斥（getPromptHandler）按 _activeMode 选注入，YonBan 面板需即时同步大模式，
      //   否则只能靠 4s 轮询拿到 stale 模式。
      // [P0-C] 广播与写入同一 canonical（原读 _chatid=data||args 合成，与写入点分叉）
      await _broadcastModeChanged(_switchChatId, {
        mode: targetMode,
        charName: switchCharName,
        // [0808 模式=窗口身份] 发起窗口令牌原样回显（见 :enter 处注释）；null 不落字段
        // [0808下午 发起源分流·凛倾拍板] origin 单公式推导：带窗口令牌=web 窗口发起（前端按令牌隔离，
        //   跨窗不互拽）；无令牌=external（AI 链 <modeSwitch>/delegate 跨组/YonBan/桥——这些调用方
        //   都不产生窗口令牌），前端跟随翻转，封掉"后端已切、前端生成轴停旧模式"的三态分叉。
        //   不信任 payload 自报 origin（调用方伪造 web 令牌才可能冒充，令牌本身即凭据），公式与
        //   featureControls._beiluApplyModeFromWs 的前端推导式同源。
        origin: _switchWindowToken ? "web" : "external",
        ...(_switchWindowToken ? { windowToken: _switchWindowToken } : {}),
      });
    }
    return result;
  }

  // === 获取当前模式 ===
  if (data._action === "getMode") {
    const modeUsername = data.username || args?.username || "_default";
    // 断链② 读侧对称：与 switchMode 同归位，读写同源
    const modeCharName = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
    // N38: 可选 chat_id —— 传入时返回该对话线的绑定模式（未绑定回退 char 级）
    return { success: true, mode: getActiveMode(modeUsername, modeCharName, data.chat_id || null) };
  }

  // === 获取联网搜索配置（0714，YonBan 读侧）===
  // 与下方 updateConfig 的 chatid→primaryCharName 归位对称（读写同源）：无 char 上下文的调用方
  // （YonBan）带 chatid 即读到当前 chat 角色的 per-char web_search，而非 _global 死配置。
  if (data._action === "getWebSearchConfig") {
    const wscUsername = data.username || args?.username || "_default";
    const wscChar = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
    const wscDir = getMemoryDir(wscUsername, wscChar);
    const wscCfg = loadJsonFileIfExists(path.join(wscDir, "_config.json"), {});
    return { success: true, charName: wscChar, web_search: wscCfg.web_search || {} };
  }

  // === 获取Token提醒配置（0811，YonBan 读侧）===
  // 与上方 getWebSearchConfig 同范式（chatid→primaryCharName 归位，读写同源）；返回
  // DEFAULT_TOKEN_REMINDER 合并后的生效值——YonBan Token设置弹窗回显 ai_clean_min_percent
  // 等字段不必在前端镜像默认值（后端唯一默认权威）。写侧=updateConfig token_reminder 合并写口。
  if (data._action === "getTokenReminderConfig") {
    const trcUsername = data.username || args?.username || "_default";
    const trcChar = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
    const trcDir = getMemoryDir(trcUsername, trcChar);
    const trcCfg = loadJsonFileIfExists(path.join(trcDir, "_config.json"), {});
    return { success: true, charName: trcChar, token_reminder: { ...DEFAULT_TOKEN_REMINDER, ...(trcCfg.token_reminder || {}) } };
  }

  // === N38 对话线模式绑定 ===
  // 设计（全智能_界面设计.md :291-319）：每模式独立 chatId、一个对话一条线路。
  // 前端创建/复用模式专属 chatId（work-yyy/code-zzz）后调用本 action 把该线绑定到
  // 对应模式（active_modes_map[chatId]），确保投递线上的确认师/执行 AI 拿到正确模式
  // 的 INJ/预设——不再依赖旧的 char 级 active_mode 全局翻转。幂等。
  if (data._action === "bindChatMode") {
    const bindMode = data.mode;
    const bindChatId = data.chat_id;
    if (!bindChatId) return { success: false, error: "缺少 chat_id 参数" };
    if (!isValidModeId(bindMode)) { // T5：内置集 _validModeIds+已注册自定义
      return { success: false, error: `非法模式值: ${bindMode}` };
    }
    const bindUsername = data.username || args?.username || "_default";
    // [P0-C 2026-08-03] bindChatMode 归属校验（Fable 审查非阻断5：原任意 chat_id+mode 可写
    //   active_modes_map 无归属校验）：认证上下文存在时 chat_id 必须属于认证用户，fail-closed。
    //   头部统一闸只覆盖 data.chatid/chatId，本 action 的目标键是 chat_id，单独补校验。
    if (args?.username) {
      const _bindOwn = await _verifyChatOwnership(bindChatId, args.username);
      if (!_bindOwn.ok) {
        wbD(bindChatId, "setDataActions", "bindChatMode:chatOwnerReject", false, `${_bindOwn.code}: ${_bindOwn.error}`, {});
        return { success: false, code: _bindOwn.code, error: _bindOwn.error };
      }
    }
    // 断链② 同族：线级绑定同归位（bindChatMode 本就带 chat_id，data.chatid 缺省时也按 chat_id 归位）
    const bindCharName = await _resolveRequestChar({ ...data, chatid: data.chatid || data.chat_id }, args, data.charName || args?.char_id || "_global");
    const bindResult = setActiveMode(bindUsername, bindCharName, bindMode, bindChatId);
    if (bindResult.success) {
      console.log(`[beilu-memory] bindChatMode: 线 ${bindChatId} → ${bindMode} (user=${bindUsername}, char=${bindCharName})`);
    }
    return bindResult;
  }

  const username = data.username || args?.username || "_default";
  // [2026-07-16 断链① 修] 无 char 上下文调用方（YonBan 等）带 chatid 时按 chat 元数据归位——
  //   原直落 "_global" 使表格域全部 verb（updateTable/归档族/删除族/getTables…）读写 _global 死桶，
  //   与 web 面板 per-char 桶分家（同窗口 cid 目录在 _global 与 char 下并存实证）。
  //   显式 charName/char_id 恒优先，web 面板/AI 链行为零变化。
  const charName = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
  // K5：窗口隔离键。仅 work 任务态 + gate 开时参与路径/缓存（getWorkCtxDir/getCacheKey 内部判定）。
  const _rawChatId = data.chatid || data.chatId || args?.chatid ||
    (args?.chat_name ? args.chat_name.replace("common_chat_", "") : null);
  // 记忆中心「查看模式」：前端在中心里看/改某模式记忆时带 viewMode，读写都落该模式而不切会话 active_mode。
  // 必须与 getDataHandler 的读路径对称——否则在 chat 会话看 code 表却把编辑存进 chat 表（落错模式）。
  // 所有旧调用方 + AI 写路径不带 viewMode → undefined → 按会话 active_mode 回退，行为同旧（零回归）。
  const _viewMode = (data.viewMode === "chat" || data.viewMode === "code" || data.viewMode === "work") ? data.viewMode : undefined;
  // [2026-07-16 读写同源修复] viewMode 也照传 chatId（与 getDataHandler 读侧同批对称修）：
  // 隔离模式(code/work) AI 写链落 `<mode>_ctx/<chatId>/`（凛倾 2026-06-17 裁决 B 窗口隔离），
  // 查看/编辑必须同窗口同目录，否则「UI 读 char 级空模板、编辑落 char 级、AI 写 ctx」三方分叉。
  // 原「footgun 守卫」（viewMode 时置 null 走 char 级）方向反了：char 级根从无 AI 写入。
  // chatId 变量被 loadMemoryData 读 + saveTablesData 写 + getCacheKey 缓存键统一消费，三者恒同源。
  // 非隔离模式(chat) getModeCtxDir/getCacheKey 不消费 chatId（chat=裸键），行为不变。
  const chatId = _rawChatId;
  const memData = loadMemoryData(username, charName, _viewMode, chatId);
  const presetsData = loadMemoryPresets(username, charName);

  switch (data._action) {
    case "clearCache": {
      // K5：work 模式 + gate 开时删带 chatId 的隔离键，否则删 chat 键（向后兼容）
      memoryCache.delete(getCacheKey(username, charName, memData.activeMode, chatId));
      return { success: true };
    }

    case "updateTable": {
      let targetTable = null;
      if (data.tableId !== undefined) {
        const idx = memData.tables.findIndex((t) => t.id === data.tableId);
        if (idx >= 0) targetTable = memData.tables[idx];
        else diag.warn(`updateTable: tableId=${data.tableId} 未找到`);
      } else if (data.tableIndex !== undefined) {
        const idx = data.tableIndex;
        if (idx >= 0 && idx < memData.tables.length) targetTable = memData.tables[idx];
      }
      if (!targetTable) return { success: false, error: `表格未找到` };
      // N12：乐观并发版本号。expectedRev 传了才校验（AI/旧调用不带=强写，零回归）；不匹配=拒写防 lost-update。
      //   与前端 dataTable.mjs:106(送 expectedRev)/:117(读 conflict) 对账：HTTP 200 也可能 conflict。
      const _curRev = Number(targetTable.rev || 0);
      if (data.expectedRev != null && Number(data.expectedRev) !== _curRev) {
        return { success: false, conflict: true, error: `表格已被其它窗口修改（当前 rev ${_curRev}，提交基于 ${data.expectedRev}），请刷新后重试`, rev: _curRev };
      }
      if (data.rows !== undefined) targetTable.rows = data.rows;
      const _oldCols = targetTable.columns ? [...targetTable.columns] : [];
      if (data.columns !== undefined) targetTable.columns = data.columns;
      if (data.rules !== undefined) targetTable.rules = data.rules;
      if (data.name !== undefined) targetTable.name = data.name;
      if (data.enabled !== undefined) {
        targetTable.enabled = targetTable.required ? true : !!data.enabled;
      }
      targetTable.rev = _curRev + 1;
      // M5：await 真正落盘（saveTablesData 返回写入 promise）后再回 HTTP success，避免"success 早于落盘"窗口丢数据。
      const _wU = await saveTablesData(username, charName, memData.activeMode, chatId);
      if (_wU && _wU.ok === false) return { success: false, error: _wU.error || "表格写盘失败" };
      // T7-S1：采集「用户改记忆」行为信号（旁挂 append，不改原逻辑）。
      try { appendBehaviorSignal(username, charName, { type: "mem_edit", target: String(targetTable.id ?? targetTable.name ?? ""), action: "updateTable" }); } catch { /* 信号采集失败不影响主流程 */ }
      if (data.columns !== undefined && _oldCols.length > 0) {
        const _newCols = data.columns;
        const _renames = [];
        const _minLen = Math.min(_oldCols.length, _newCols.length);
        for (let _i = 0; _i < _minLen; _i++) {
          if (_oldCols[_i] !== _newCols[_i]) _renames.push({ oldName: _oldCols[_i], newName: _newCols[_i] });
        }
        const _deleted = _oldCols.slice(_newCols.length);
        if (_renames.length > 0 || _deleted.length > 0) {
          // 根病4 框架级修：跨插件直调 worldbook SetData（旧 HTTP 端口"12000"+无认证=双断死码）
          try {
            const _wbPart = await loadPart(username, "plugins/beilu-worldbook");
            const _syncResult = await _wbPart?.interfaces?.config?.SetData?.({ _action: "syncColumnRefs", renames: _renames, deleted: _deleted });
            if (_syncResult) diag.log(`根病4联动: renamed=${_syncResult.renamed} warned=${_syncResult.warned}`);
          } catch (_syncErr) { console.warn("[beilu-memory] 根病4联动失败(worldbook syncColumnRefs):", _syncErr?.message); }
        }
      }
      return { success: true, rev: targetTable.rev };
    }

    case "addTable": {
      const newId = memData.tables.length > 0 ? Math.max(...memData.tables.map((t) => t.id)) + 1 : 0;
      memData.tables.push({
        id: newId, name: data.name || `自定义表格 #${newId}`,
        columns: data.columns || ["列1", "列2"], rows: [],
        rules: data.rules || { insert: "", update: "", delete: "" },
        required: false, user_customizable: true, enabled: true, rev: 0,
      });
      // M5：await 落盘再回 success。
      const _wA = await saveTablesData(username, charName, memData.activeMode, chatId);
      if (_wA && _wA.ok === false) return { success: false, error: _wA.error || "表格写盘失败" };
      return { success: true };
    }

    case "removeTable": {
      let idx = -1;
      if (data.tableId !== undefined) {
        idx = memData.tables.findIndex((t) => t.id === data.tableId);
        if (idx < 0) return { success: false, error: `表格未找到 (tableId=${data.tableId})` };
      } else if (data.tableIndex !== undefined) idx = data.tableIndex;
      if (idx < 0 || idx >= memData.tables.length) return { success: false, error: `表格未找到` };
      if (memData.tables[idx].required) return { success: false, error: `必需表格不可删除` };
      memData.tables.splice(idx, 1);
      memData.tables.forEach((t, i) => (t.id = i));
      // M5：await 落盘再回 success。
      const _wR = await saveTablesData(username, charName, memData.activeMode, chatId);
      if (_wR && _wR.ok === false) return { success: false, error: _wR.error || "表格写盘失败" };
      return { success: true };
    }

    case "getTables": {
      // K5：work 模式 + gate 开时删带 chatId 的隔离键，否则删 chat 键（向后兼容）
      memoryCache.delete(getCacheKey(username, charName, memData.activeMode, chatId));
      return { success: true };
    }

    // ===== F3 任务打勾系统（§1.4 / G2）=====
    // 单一权威 = work_ctx/tasks.json（taskStore，按 _activeMode + chatId 隔离）。
    // 前端任务卡读写：getTasks / planTasks / checkTask / updateTask / deleteTask。
    case "getTasks": {
      const _tStore = loadTasks(username, charName, memData.activeMode, chatId);
      return {
        success: true,
        tasks: _tStore.tasks,
        rev: _tStore.rev,
        remaining: remainingCount(_tStore),
      };
    }

    // 全量替换清单（AI 或用户重排/批量编辑）。data.tasks = [{content,status,priority,id?}]
    case "planTasks": {
      const _tStore = await applyTaskPlan(
        username, charName, memData.activeMode, chatId, data.tasks || [],
      );
      _broadcastTaskUpdate(chatId, _tStore);
      return { success: true, tasks: _tStore.tasks, rev: _tStore.rev, remaining: remainingCount(_tStore) };
    }

    // 追加单条（原子，前端添加任务专用——替代 getTasks→planTasks 覆盖写）。data.content 必填。
    case "addTask": {
      const _content = String(data.content || "").trim();
      if (!_content) return { success: false, error: "缺少 content" };
      const _tStore = await appendTask(
        username, charName, memData.activeMode, chatId,
        { content: _content, priority: data.priority },
      );
      _broadcastTaskUpdate(chatId, _tStore);
      return { success: true, tasks: _tStore.tasks, rev: _tStore.rev, remaining: remainingCount(_tStore) };
    }

    // 勾选/改状态某一项。data.id 或 data.content 选中；data.status 默认 completed。
    case "checkTask": {
      const _res = await applyTaskCheck(
        username, charName, memData.activeMode, chatId,
        { id: data.id, content: data.content, status: data.status },
      );
      if (_res.matched) _broadcastTaskUpdate(chatId, _res.store);
      return {
        success: _res.matched,
        error: _res.matched ? undefined : "未匹配到任务",
        tasks: _res.store.tasks, rev: _res.store.rev, remaining: remainingCount(_res.store),
      };
    }

    // 编辑单项内容/优先级（不改状态）。data.id 选中，data.content/data.priority 可选。
    case "updateTask": {
      if (!data.id) return { success: false, error: "缺少 id" };
      let _matched = false;
      const _tStore = await mutateTasks(
        username, charName, memData.activeMode, chatId, (cur) => {
          for (const t of cur.tasks) {
            if (t.id !== String(data.id)) continue;
            _matched = true;
            if (data.content != null) t.content = String(data.content).trim();
            if (data.priority != null) t.priority = String(data.priority);
            if (data.status != null && ["pending", "in_progress", "completed"].includes(data.status)) {
              t.status = data.status;
              t.completedAt = data.status === "completed" ? new Date().toISOString() : null;
            }
            break;
          }
          return { tasks: cur.tasks };
        },
      );
      if (_matched) _broadcastTaskUpdate(chatId, _tStore);
      return { success: _matched, error: _matched ? undefined : "未匹配到任务", tasks: _tStore.tasks, rev: _tStore.rev, remaining: remainingCount(_tStore) };
    }

    // 删除单项。data.id 选中。
    case "deleteTask": {
      if (!data.id) return { success: false, error: "缺少 id" };
      let _removed = false;
      const _tStore = await mutateTasks(
        username, charName, memData.activeMode, chatId, (cur) => {
          const _before = cur.tasks.length;
          const tasks = cur.tasks.filter((t) => t.id !== String(data.id));
          _removed = tasks.length < _before;
          return { tasks };
        },
      );
      if (_removed) _broadcastTaskUpdate(chatId, _tStore);
      return { success: _removed, error: _removed ? undefined : "未匹配到任务", tasks: _tStore.tasks, rev: _tStore.rev, remaining: remainingCount(_tStore) };
    }

    case "getMemoryPresets":
      return { success: true };

    // W61: 获取单个预设完整详情（含prompts）
    case "getMemoryPresetDetail": {
      const _dPreset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!_dPreset) return { success: false, error: "预设不存在" };
      return { success: true, preset: _dPreset, prompts: _dPreset.prompts || [] };
    }

    // W61: 批量更新预设提示词
    case "updateMemoryPresetPrompts": {
      const _upPreset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!_upPreset) return { success: false, error: "预设不存在" };
      if (!Array.isArray(data.prompts)) return { success: false, error: "prompts必须是数组" };
      // 更新每条prompt的name/content/enabled
      // 内置条目内容锁（与 updatePresetPrompt/replacePresetPrompts 同语义，三条写路统一收口，凛倾0711）
      data.prompts.forEach((updated, idx) => {
        if (_upPreset.prompts && _upPreset.prompts[idx]) {
          if (updated.name !== undefined) _upPreset.prompts[idx].name = updated.name;
          if (updated.content !== undefined && !_upPreset.prompts[idx].builtin) _upPreset.prompts[idx].content = updated.content;
          if (updated.enabled !== undefined) _upPreset.prompts[idx].enabled = updated.enabled;
        }
      });
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, updated: data.prompts.length };
    }

    // p系列持久激活位（凛倾0706 6口之⑤「5是p系列」+「切换就是改绑」）：原前端选中
    //   （memoryPresetChat selectedPresetId / memtool _pseriesSelected）是纯临时变量刷新即丢=违反
    //   「切换=改绑」总则。落 _memory_presets.json 顶层 active_preset_id（与 presets[] 同文件同 save 链），
    //   getData 下发 active_memory_preset_id 供三处前端（memoryPresetChat/memtool/home memoryPreset tab）
    //   恢复选中。运行仍按前端显式传的 presetId（本位只管"选中态持久+跨面板互通"，不改运行取值链）。
    // P 系列新建能力（2026-07-31 002拍板"从子模式拉个线"）：此前所有 P 系列写 verb 均以"预设已存在"
    //   为前提、全仓无 create 入口（系统级空白非枚举拦截）。本 verb 对齐子模式 saveSubModes 的"数据即成员"
    //   语义：新增能力零改既有 verb（importMemoryPreset "只覆盖不新增"不变式保留）。
    //   首个消费方：P9 词库维护 AI（p1panel.mjs P9 面板"创建 P9 预设"，prompts seed 自 P9 提示词数据件）。
    //   前端 P 系列面板动态渲染 presets 数组（memtool.mjs:825-842）→ 新预设创建即显示，可编辑可运行。
    case "createMemoryPreset": {
      const _cpId = String(data.presetId || "").trim();
      if (!_cpId) return { success: false, error: "presetId 不能为空" };
      if (presetsData.presets.some((p) => p.id === _cpId)) {
        return { success: false, error: `预设已存在 (presetId=${_cpId})，如需改内容用 updateMemoryPreset/replacePresetPrompts` };
      }
      const _cpPrompts = Array.isArray(data.prompts) ? data.prompts : [];
      const _cpPreset = {
        id: _cpId,
        name: String(data.name || _cpId),
        description: String(data.description || ""),
        enabled: data.enabled !== false,
        ...(data.api_config && typeof data.api_config === "object" ? { api_config: structuredClone(data.api_config) } : {}),
        prompts: sanitizePromptSet([], _cpPrompts, _cpId, "prompts"),
      };
      presetsData.presets.push(_cpPreset);
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, presetId: _cpId, promptCount: _cpPreset.prompts.length };
    }

    case "setActiveMemoryPreset": {
      const _amId = data.presetId || "";
      if (_amId && !presetsData.presets.some((p) => p.id === _amId)) {
        return { success: false, error: `预设不存在 (presetId=${_amId})` };
      }
      presetsData.active_preset_id = _amId;
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, active_preset_id: _amId };
    }

    case "updateMemoryPreset": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      if (data.enabled !== undefined) preset.enabled = !!data.enabled;
      if (data.description !== undefined) preset.description = String(data.description);
      if (data.trigger !== undefined) preset.trigger = String(data.trigger);
      if (data.api_config !== undefined) preset.api_config = { ...preset.api_config, ...data.api_config };
      if (data.preset_switch_auto !== undefined) preset.preset_switch_auto = !!data.preset_switch_auto;
      if (data.preset_switch_entries !== undefined) preset.preset_switch_entries = data.preset_switch_entries;
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, presetId: preset.id };
    }

    case "updatePresetPrompt": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      const promptSet = data.promptSet === "code" ? "prompts_code" : data.promptSet === "work" ? "prompts_work" : "prompts";
      const prompts = preset[promptSet];
      if (!prompts || !prompts[data.promptIndex]) return { success: false, error: `提示词不存在 (promptIndex=${data.promptIndex})` };
      const prompt = prompts[data.promptIndex];
      // 内置条目锁内容不锁身份（凛倾0711：可开关/改身份/移动，内容不可改）——原守卫方向相反（锁role放content）
      if (data.role !== undefined) prompt.role = data.role;
      if (data.content !== undefined && !prompt.builtin) prompt.content = String(data.content);
      if (data.enabled !== undefined) prompt.enabled = !!data.enabled;
      saveMemoryPresets(username, charName, presetsData);
      return { success: true };
    }

    case "addPresetPrompt": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      const promptSet = data.promptSet === "code" ? "prompts_code" : data.promptSet === "work" ? "prompts_work" : "prompts";
      if (!preset[promptSet]) preset[promptSet] = [];
      const suffix = data.promptSet === "code" ? "_code" : data.promptSet === "work" ? "_work" : "";
      const newPrompt = {
        role: data.role || "system", content: data.content || "",
        identifier: `${data.presetId}${suffix}_custom_${Date.now()}`,
        enabled: true, builtin: false, deletable: true,
      };
      const chatHistoryIdx = preset[promptSet].findIndex((p) => p.builtin && p.content === "{{chat_history}}");
      if (chatHistoryIdx >= 0) preset[promptSet].splice(chatHistoryIdx, 0, newPrompt);
      else preset[promptSet].push(newPrompt);
      saveMemoryPresets(username, charName, presetsData);
      return { success: true };
    }

    case "removePresetPrompt": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      const promptSet = data.promptSet === "code" ? "prompts_code" : data.promptSet === "work" ? "prompts_work" : "prompts";
      const prompts = preset[promptSet];
      if (!prompts || !prompts[data.promptIndex]) return { success: false, error: `提示词不存在 (promptIndex=${data.promptIndex})` };
      if (!prompts[data.promptIndex].deletable) return { success: false, error: "该提示词不可删除" };
      prompts.splice(data.promptIndex, 1);
      saveMemoryPresets(username, charName, presetsData);
      return { success: true };
    }

    case "replacePresetPrompts": {
      // 批量替换指定模式的整个提示词组（归一+守卫收口于 sanitizePromptSet，与 importMemoryPreset 共用）
      const _rpPreset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!_rpPreset) return { success: false, error: "预设不存在" };
      const _rpSetKey = data.promptSetKey === "prompts_code" ? "prompts_code" : data.promptSetKey === "prompts_work" ? "prompts_work" : "prompts";
      if (!Array.isArray(data.prompts)) return { success: false, error: "prompts必须是数组" };
      _rpPreset[_rpSetKey] = sanitizePromptSet(_rpPreset[_rpSetKey], data.prompts, data.presetId, _rpSetKey);
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, count: _rpPreset[_rpSetKey].length };
    }

    case "exportMemoryPreset": {
      // P系列预设导出（凛倾0712「需要可以和预设一样导入导出,而不是写死」）：单预设完整可携带态
      // → 前端 Blob 下载。只导出实有键（无 prompts_code 键的预设不导空数组，防导入侧误清空）
      const _exPreset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!_exPreset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      const _exPayload = {
        type: "beilu_memory_preset",
        version: 1,
        exported_at: new Date().toISOString(),
        preset: {
          id: _exPreset.id,
          name: _exPreset.name || "",
          description: _exPreset.description || "",
          enabled: _exPreset.enabled !== false,
          ...(_exPreset.api_config ? { api_config: structuredClone(_exPreset.api_config) } : {}),
          ...(Array.isArray(_exPreset.prompts) ? { prompts: structuredClone(_exPreset.prompts) } : {}),
          ...(Array.isArray(_exPreset.prompts_code) ? { prompts_code: structuredClone(_exPreset.prompts_code) } : {}),
          ...(Array.isArray(_exPreset.prompts_work) ? { prompts_work: structuredClone(_exPreset.prompts_work) } : {}),
        },
      };
      return { success: true, json: JSON.stringify(_exPayload, null, 2), name: `${_exPreset.id}_memory_preset` };
    }

    case "importMemoryPreset": {
      // P系列预设导入：type 概念域校验 + 按文件内 id 匹配现有预设覆盖（P系列固定名单
      // P1-P8 闭案不新增）；prompts 三组经 sanitizePromptSet 同款守卫（内置条目内容锁/漏删插回），
      // 只覆盖文件里实有的键
      const _im = data.json;
      if (!_im || _im.type !== "beilu_memory_preset" || !_im.preset?.id) {
        return { success: false, error: "不是有效的记忆预设文件（缺 type=beilu_memory_preset 或 preset.id）" };
      }
      const _imTarget = presetsData.presets.find((p) => p.id === _im.preset.id);
      if (!_imTarget) {
        return { success: false, error: `目标预设不存在 (${_im.preset.id})——P系列为固定名单，不支持导入新增` };
      }
      if (typeof _im.preset.description === "string") _imTarget.description = _im.preset.description;
      if (_im.preset.enabled !== undefined) _imTarget.enabled = !!_im.preset.enabled;
      if (_im.preset.api_config && typeof _im.preset.api_config === "object") {
        _imTarget.api_config = structuredClone(_im.preset.api_config);
      }
      const _imSets = [];
      for (const _k of ["prompts", "prompts_code", "prompts_work"]) {
        if (Array.isArray(_im.preset[_k])) {
          _imTarget[_k] = sanitizePromptSet(_imTarget[_k], _im.preset[_k], _im.preset.id, _k);
          _imSets.push(_k);
        }
      }
      saveMemoryPresets(username, charName, presetsData);
      return { success: true, presetId: _im.preset.id, sets: _imSets };
    }

    case "initPresetPromptsFromTemplate": {
      // 从 default_memory_presets.json 模板初始化指定模式的提示词组
      const _initPreset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!_initPreset) return { success: false, error: "预设不存在" };
      const _initSetKey = data.promptSet === "code" ? "prompts_code" : data.promptSet === "work" ? "prompts_work" : "prompts";
      try {
        const _templatePath = path.join(__pluginDir, "default_memory_presets.json");
        const _template = loadJsonFile(_templatePath);
        const _tplPreset = _template?.presets?.find((p) => p.id === data.presetId);
        if (!_tplPreset?.[_initSetKey]?.length) {
          return { success: false, error: `模板中 ${data.presetId} 没有 ${_initSetKey} 数据` };
        }
        _initPreset[_initSetKey] = structuredClone(_tplPreset[_initSetKey]);
        saveMemoryPresets(username, charName, presetsData);
        return { success: true, count: _initPreset[_initSetKey].length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "syncDefaultPresets": {
      try {
        const _tplPath = path.join(__pluginDir, "default_memory_presets.json");
        const _tpl = loadJsonFile(_tplPath);
        if (!_tpl) return { success: false, error: "默认模板文件不存在" };

        const report = { added: [], updated: [], unchanged: [] };
        const userInj = presetsData.injection_prompts || [];
        const tplInj = _tpl.injection_prompts || [];

        for (const tplEntry of tplInj) {
          const userEntry = userInj.find(e => e.id === tplEntry.id);
          if (!userEntry) {
            userInj.push(structuredClone(tplEntry));
            report.added.push(tplEntry.id);
            continue;
          }
          // [0723 凛倾拍板「2做」] 元字段（builtin/dataDriven）=出厂元数据非用户可改域，
          //   与模板不一致即对齐（INJ 面板系统层/数据条目判据依赖它们；content/enabled 等用户域不受此影响）。
          //   背景：browser 两条历史 builtin:false 落 Skill 层分层错位，sync 原更新集不含元字段无法自愈。
          let _metaDirty = false;
          for (const _mk of ["builtin", "dataDriven"]) {
            if (tplEntry[_mk] !== undefined && userEntry[_mk] !== tplEntry[_mk]) {
              userEntry[_mk] = tplEntry[_mk];
              _metaDirty = true;
            }
          }
          if (userEntry.content !== tplEntry.content) {
            userEntry.content = tplEntry.content;
            if (tplEntry.name) userEntry.name = tplEntry.name;
            if (tplEntry.autoMode !== undefined) userEntry.autoMode = tplEntry.autoMode;
            if (tplEntry.depth !== undefined) userEntry.depth = tplEntry.depth;
            if (tplEntry.order !== undefined) userEntry.order = tplEntry.order;
            report.updated.push(tplEntry.id);
          } else if (_metaDirty) {
            report.updated.push(tplEntry.id);
          } else {
            report.unchanged.push(tplEntry.id);
          }
        }

        presetsData.injection_prompts = userInj;
        saveMemoryPresets(username, charName, presetsData);
        return {
          success: true,
          report,
          summary: `新增${report.added.length}条，更新${report.updated.length}条，${report.unchanged.length}条无变化`
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "reorderPresetPrompts": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `预设不存在 (presetId=${data.presetId})` };
      if (!Array.isArray(data.order)) return { success: false, error: "缺少 order 数组" };
      const promptSet = data.promptSet === "code" ? "prompts_code" : data.promptSet === "work" ? "prompts_work" : "prompts";
      const prompts = preset[promptSet];
      if (!prompts) return { success: false, error: `提示词组不存在 (promptSet=${promptSet})` };
      const reordered = [];
      for (const identifier of data.order) {
        const found = prompts.find((p) => p.identifier === identifier);
        if (found) reordered.push(found);
      }
      for (const p of prompts) { if (!reordered.includes(p)) reordered.push(p); }
      preset[promptSet] = reordered;
      saveMemoryPresets(username, charName, presetsData);
      return { success: true };
    }

    case "updateInjectionPrompt": {
      const injPrompts = presetsData.injection_prompts || [];
      const inj = injPrompts.find((p) => p.id === data.injectionId);
      if (!inj) return { success: false, error: `未找到注入条目 ${data.injectionId}` };
      // 缓存前缀契约（凛倾 0810 定案：只提醒不拦截）：对拟保存状态做动态宏检测，结果只作为
      // warning 随成功返回下发（前端徽标/横幅为同源提醒），保存一律按用户配置执行——
      // 系统禁止拒绝或改写用户设定的 depth/role。autoMode 值域校验与缓存契约无关，保持拒绝。
      if (data.autoMode !== undefined && !isValidInjectionAutoMode(String(data.autoMode)))
        return { success: false, error: `非法 autoMode "${data.autoMode}"（合法值=always/all/manual/file + 已注册模式/别名域）` };
      const _nextEnabled = data.enabled !== undefined ? !!data.enabled : inj.enabled !== false;
      const _nextDepth = data.depth !== undefined ? (parseInt(data.depth, 10) || 0) : (Number(inj.depth) || 0);
      const _nextRole = data.role !== undefined ? String(data.role || "system") : String(inj.role || "system");
      const _nextContent = data.content !== undefined ? String(data.content) : String(inj.content || "");
      const _placement = inspectInjectionCachePrefix({
        enabled: _nextEnabled,
        depth: _nextDepth,
        role: _nextRole,
        content: _nextContent,
      });
      const _cacheWarning = _placement.safe ? undefined
        : `提醒: 该条目含动态宏 ${_placement.unsafeMacros.map((m) => `{{${m}}}`).join(", ")}，按当前 depth/role 保存后位于缓存前缀区，可能破坏 Anthropic 缓存命中（0729 事故同型）。已按你的配置原样保存。`;
      if (data.enabled !== undefined) inj.enabled = !!data.enabled;
      if (data.content !== undefined) inj.content = String(data.content);
      if (data.name !== undefined) inj.name = String(data.name);
      if (data.description !== undefined) inj.description = String(data.description);
      if (data.role !== undefined) inj.role = data.role;
      if (data.depth !== undefined) inj.depth = parseInt(data.depth, 10) || 0;
      if (data.order !== undefined) inj.order = parseInt(data.order, 10) || 0;
      if (data.autoMode !== undefined) {
        inj.autoMode = String(data.autoMode);
      }
      // 平台限定注入（凛倾 07-09）：platform 仅对 autoMode="bot" 有门控意义（getPromptHandler bot 分支）；
      //   传空串/null = 清除限定（回到全平台共用）。
      if (data.platform !== undefined) {
        if (data.platform) inj.platform = String(data.platform);
        else delete inj.platform;
      }
      presetsData.injection_prompts = injPrompts;
      saveMemoryPresets(username, charName, presetsData);
      // T7-S1：采集「关/开注入」「改 autoMode」行为信号（不改原逻辑，旁挂 append）。
      try {
        if (data.enabled !== undefined) appendBehaviorSignal(username, charName, { type: data.enabled ? "inject_enable" : "inject_disable", target: inj.id, action: "toggle" });
        if (data.autoMode !== undefined) appendBehaviorSignal(username, charName, { type: "automode_change", target: inj.id, action: String(data.autoMode) });
      } catch { /* 信号采集失败不影响主流程 */ }
      await _broadcastInjPromptsChanged(username); // [0716 W4]
      return { success: true, ...(_cacheWarning ? { warning: _cacheWarning, unsafeMacros: _placement.unsafeMacros } : {}) };
    }

    case "addInjectionPrompt": {
      // inj 识别系统 2026-07-13：值域校验（单源=injectionSystem），非法值可见拒绝不静默入库
      if (data.autoMode !== undefined && !isValidInjectionAutoMode(String(data.autoMode)))
        return { success: false, error: `非法 autoMode "${data.autoMode}"（合法值=always/all/manual/file + 已注册模式/别名域）` };
      const injPrompts = presetsData.injection_prompts || [];
      const newId = `INJ-${Date.now()}`;
      const maxOrder = injPrompts.reduce((max, p) => Math.max(max, p.order || 0), 0);
      const newInj = {
        id: newId, name: data.name || "新注入条目", description: data.description || "",
        enabled: data.enabled !== undefined ? !!data.enabled : true,
        builtin: false, deletable: true, role: data.role || "system",
        depth: data.depth != null ? (parseInt(data.depth, 10) || 0) : 0, order: parseInt(data.order, 10) || maxOrder + 100, // N3：omitted-depth 默认对齐 update 路径(:960 ||0)+全 UI caller(均传 depth:0)，消除新建项漂 999 的分叉
        autoMode: data.autoMode || "always", content: data.content || "",
        // 平台限定注入（凛倾 07-09）：可选字段，autoMode="bot" 时门控只进该平台 bot 会话
        ...(data.platform ? { platform: String(data.platform) } : {}),
      };
      // 缓存前缀契约（凛倾 0810 定案：只提醒不拦截）——同 updateInjectionPrompt 口径。
      const _placement = inspectInjectionCachePrefix(newInj);
      const _cacheWarning = _placement.safe ? undefined
        : `提醒: 该条目含动态宏 ${_placement.unsafeMacros.map((m) => `{{${m}}}`).join(", ")}，按当前 depth/role 保存后位于缓存前缀区，可能破坏 Anthropic 缓存命中（0729 事故同型）。已按你的配置原样保存。`;
      injPrompts.push(newInj);
      presetsData.injection_prompts = injPrompts;
      saveMemoryPresets(username, charName, presetsData);
      await _broadcastInjPromptsChanged(username); // [0716 W4]
      return { success: true, id: newId, injection: newInj, ...(_cacheWarning ? { warning: _cacheWarning, unsafeMacros: _placement.unsafeMacros } : {}) };
    }

    case "deleteInjectionPrompt": {
      const injPrompts = presetsData.injection_prompts || [];
      const injIdx = injPrompts.findIndex((p) => p.id === data.injectionId);
      if (injIdx === -1) return { success: false, error: `未找到注入条目 ${data.injectionId}` };
      // 用户有权删除任意条目（含内置）。删除即永久——loadMemoryPresets 已无自动补全，
      // 不会把它加回；唯一找回 = 「恢复默认」(restoreDefaultInjections)。
      injPrompts.splice(injIdx, 1);
      presetsData.injection_prompts = injPrompts;
      saveMemoryPresets(username, charName, presetsData);
      await _broadcastInjPromptsChanged(username); // [0716 W4]
      return { success: true, deleted: data.injectionId };
    }

    case "restoreDefaultInjections": {
      // 单一权威源：从模板 default_memory_presets.json 恢复内置 INJ（无硬编码列表）。
      // 语义：模板内置项重置为出厂值（name/content/autoMode...）；用户自建（不在模板）的条目保留；清空墓碑。
      const tplPath = path.join(__pluginDir, "default_memory_presets.json");
      let tpl;
      try { tpl = loadJsonFile(tplPath); } catch (e) { return { success: false, error: `读取模板失败: ${e.message}` }; }
      const tplInj = (tpl && Array.isArray(tpl.injection_prompts)) ? tpl.injection_prompts : [];
      if (!tplInj.length) return { success: false, error: "模板无内置注入条目" };
      const byId = new Map((presetsData.injection_prompts || []).map((p) => [p.id, p]));
      for (const t of tplInj) byId.set(t.id, structuredClone(t));
      presetsData.injection_prompts = Array.from(byId.values());
      saveMemoryPresets(username, charName, presetsData);
      await _broadcastInjPromptsChanged(username); // [0716 W4]
      return { success: true, restored: tplInj.length };
    }

    case "previewMemoryPreset": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { error: `未找到预设 ${data.presetId}` };
      const dc = data.charDisplayName || charName, du = data.userDisplayName || username;
      const tableDataText = generateTableDataOnly(memData.tables, dc, du);
      let previewHot = readHotMemoryForInjection(username, charName);
      if (previewHot) previewHot = previewHot.replace(/\{\{char\}\}/g, dc).replace(/\{\{user\}\}/g, du);
      const previewPrompts = (preset.prompts || []).map((p, idx) => {
        let content = (p.content || "").replace(/\{\{tableData\}\}/g, tableDataText).replace(/\{\{hotMemory\}\}/g, previewHot || "").replace(/\{\{char\}\}/g, dc).replace(/\{\{user\}\}/g, du).replace(/\{\{current_date\}\}/g, getTodayStr());
        return { index: idx, identifier: p.identifier || `prompt_${idx}`, role: p.role, enabled: p.enabled, builtin: p.builtin || false, isChatHistory: p.builtin && p.content === "{{chat_history}}", originalLength: (p.content || "").length, preview: content, charCount: content.length };
      });
      return { success: true, presetId: preset.id, presetName: preset.name, prompts: previewPrompts, totalChars: previewPrompts.reduce((s, p) => s + p.charCount, 0), estimatedTokens: previewPrompts.reduce((s, p) => s + 4 + countTokensSync(p.preview || ""), 0) };
    }

    case "previewInjectionPrompt": {
      const injPrompts = presetsData.injection_prompts || [];
      const inj = injPrompts.find((p) => p.id === data.injectionId);
      if (!inj) return { error: `未找到注入条目 ${data.injectionId}` };
      const dc = data.charDisplayName || charName, du = data.userDisplayName || username;
      const tableDataText = generateTableDataOnly(memData.tables, dc, du);
      let hotText = readHotMemoryForInjection(username, charName);
      if (hotText) hotText = hotText.replace(/\{\{char\}\}/g, dc).replace(/\{\{user\}\}/g, du);
      const _tm = getTimeMacroValues();
      // {{skill:}}/{{skills_list}} 已转退役宏（0723 说明书库域删除）：预览与正线同语义替空串。
      // {{browser_status/port}} 正线读盘展开（getPromptHandler 0723 接线），预览侧不复刻读盘（防镜像）→ 占位（chat_history 同先例）。
      const preview = inj.content.replace(/\{\{tableData\}\}/g, tableDataText).replace(/\{\{hotMemory\}\}/g, hotText || "").replace(/\{\{char\}\}/g, dc).replace(/\{\{user\}\}/g, du).replace(/\{\{current_date\}\}/g, getTodayStr()).replace(/\{\{chat_history\}\}/g, "（预览模式）").replace(/\{\{lastUserMessage\}\}/g, "（预览模式）").replace(/\{\{time\}\}/g, _tm.time).replace(/\{\{date\}\}/g, _tm.date).replace(/\{\{weekday\}\}/g, _tm.weekday).replace(/\{\{idle_duration\}\}/g, _tm.idle_duration || "（预览模式）").replace(/\{\{lasttime\}\}/g, _tm.lasttime || "（预览模式）").replace(/\{\{lastdate\}\}/g, _tm.lastdate || "（预览模式）").replace(/\{\{skill:([^}]+)\}\}/g, "").replace(/\{\{skills_list\}\}/g, "").replace(/\{\{browser_(status|port)\}\}/g, "（预览模式）");
      return { success: true, id: inj.id, name: inj.name, role: inj.role, depth: inj.depth, autoMode: inj.autoMode, enabled: inj.enabled, preview, charCount: preview.length, estimatedTokens: 4 + countTokensSync(preview), hotMemoryPreview: hotText || "（无热记忆数据）", hotMemoryCharCount: hotText ? hotText.length : 0 };
    }

    // === 归档操作 ===
    case "archiveTempMemory": return { success: true, ...(await archiveTempMemory(username, charName, data.chatId || args?.chatid || undefined)) }; // T1：归档链 async 化后 await 展开结果；T4 同族：chatId 穿透防归错 mode 表（:571 范式）
    case "endDay": return { success: true, ...(await endDay(username, charName)) }; // T1：endDay async 化后 await
    case "archiveHotToWarm": {
      const r7 = await archiveRememberAboutUser(username, charName); // T1：await 归档结果
      const r8 = await archiveForeverEntries(username, charName); // T1：await 归档结果
      return { success: true, remember_archived: r7.archived, forever_archived: r8.archived };
    }
    case "archiveWarmToCold": return { success: true, ...archiveWarmToCold(username, charName) }; // archiveWarmToCold 无 saveTablesData 落表（纯 saveJsonFile 同步），未 async 化
    case "archiveCompletedTasks": return { success: true, ...(await archiveCompletedTasks(username, charName, data.rowIndices || [])) }; // T1：archiveCompletedTasks async 化后 await
    case "triggerP2CodeArchive": {
      const { triggerP2CodeArchive } = await import("../ai/aiRunner.mjs");
      triggerP2CodeArchive(username, charName).catch(e =>
        console.error("[beilu-memory] 手动P2-code归档失败:", e.message));
      return { success: true, message: "P2-code归档已异步触发" };
    }
    case "triggerP2Summary": {
      // [0804 根因修] 传 opts.manual=true：这是用户显式点击手动按钮，必须绕过
      //   triggerP2Summary 内「trigger===manual_button 跳过自动触发」守卫（否则手动按钮永远 no-op）。
      const { triggerP2Summary } = await import("../ai/aiRunner.mjs");
      triggerP2Summary(username, charName, undefined, { manual: true }).catch(e =>
        console.error("[beilu-memory] 手动P2归档失败:", e.message));
      return { success: true, message: "P2归档已异步触发" };
    }
    // 统一归档配置（三模式单一入口；chat 此前完全无 config action，于此补齐 = ③核心硬后端工作）。
    case "getArchiveConfig": {
      const _aMode = data.mode === "code" || data.mode === "work" ? data.mode : "chat";
      return { success: true, mode: _aMode, config: _readArchiveConfig(getMemoryDir(username, charName), _aMode) };
    }
    case "updateArchiveConfig": {
      const _aMode = data.mode === "code" || data.mode === "work" ? data.mode : "chat";
      const _aSaved = _writeArchiveConfig(getMemoryDir(username, charName), _aMode, data);
      return { success: true, mode: _aMode, config: _aSaved };
    }

    // ============================================================
    // 表格归档系统（25批21）· 6 verb。数据归档按模式落在当前工作层的日期目录：
    //   chat=hot/<YYYY-MM-DD>/，code=code/active/<YYYY-MM-DD>/，work=work/active/<YYYY-MM-DD>/。
    //   路径单源 tableArchiveRoot/tableArchiveDir，旧 archive 存量首次访问自动归位。
    //   mode 解析走 _resolveTableMode 收口（显式三值原样用；空=per-chatId active_mode 同源，20260712 改，
    //   原「空→chat 硬默认」与读端 getData 回退语义分叉=跨桶归档病根）。
    // ============================================================

    // per-table 归档配置读取：{ [tableId]: {enabled, max_rows, keep_recent} }
    case "getTableArchiveConfig": {
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      // defaults/storage/format 随配置一并回传：前端 placeholder、储存位置、文件格式展示全取自这里。
      const { relRoot: _relRoot } = tableArchiveRoot(getMemoryDir(username, charName), _tMode);
      return {
        success: true, mode: _tMode,
        config: _readTableArchiveConfig(getMemoryDir(username, charName), _tMode),
        defaults: { ...TABLE_ARCHIVE_DEFAULTS },
        storage: `${_relRoot}/{date}`,
        format: "json", // 归档文件固定纯 JSON（{date,mode,table,tableId,columns,count,entries}，同日合并+指纹去重）；restore/list 依赖此格式
      };
    }

    // per-table 归档配置更新（字段白名单 merge，防 payload 噪声污染）
    case "updateTableArchiveConfig": {
      if (data.tableId === undefined || data.tableId === null) return { success: false, error: "缺少 tableId" };
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      const _patch = (data.patch && typeof data.patch === "object") ? data.patch : data; // 兼容 patch 包裹 / 平铺两种前端形状
      const _saved = _writeTableArchiveConfig(getMemoryDir(username, charName), _tMode, data.tableId, _patch);
      // ★【保存＝只写配置，禁止在此执行归档】20260726 事故定案：本 verb 一度被改成「保存即生效」
      //   （enabled 且超限就当场调归档引擎），用户在设置弹窗点「保存」＝数据当场被搬走
      //   （实证 09:52:19：#1 代码定位表 29 行被搬走 9 行，用户只是想保存设置）。
      //   配置动作与破坏性数据动作必须分离：执行只能来自用户显式点「立即归档」(archiveTableRows)
      //   或用户自己开启的自动触发链。此语义禁止再合并。
      return { success: true, mode: _tMode, tableId: data.tableId, config: _saved };
    }

    // 手动归档：不传 rowIndices=按行数上限自动选超出行；传了=按索引归档。
    //   参数优先级 payload > 已存 table_archive 配置 > 引擎默认（20260712 根治「手动 verb 不读存储配置」坑：
    //   此前缺省直接回落 80/20 硬默认，用户已保存的 per-table 配置对手动路径不生效）。
    case "archiveTableRows": {
      if (data.tableId === undefined || data.tableId === null) return { success: false, error: "缺少 tableId" };
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      try {
        clearCharCache(username, charName); // 防 memoryCache 陈旧表被瘦身后覆盖回写
        const _stored = _readTableArchiveConfig(getMemoryDir(username, charName), _tMode)[String(data.tableId)] || {};
        const _r = await archiveTableRowsGeneric(username, charName, _tMode, data.tableId, chatId, { // T1：async 化后 await，写盘失败经本 catch 转 {success:false}
          rowIndices: Array.isArray(data.rowIndices) ? data.rowIndices : undefined,
          keepRecent: Number.isFinite(data.keepRecent) ? data.keepRecent : _stored.keep_recent,
          maxRows: Number.isFinite(data.maxRows) ? data.maxRows : _stored.max_rows,
          archiveBatch: Number.isFinite(data.archiveBatch) ? data.archiveBatch : _stored.archive_batch,
          minArchiveRows: Number.isFinite(data.minArchiveRows) ? data.minArchiveRows : _stored.min_archive_rows,
          fileNameTemplate: typeof data.fileNameTemplate === "string" ? data.fileNameTemplate : _stored.file_name_template,
          manual: true, // 本 verb = 用户显式点「立即归档」：不受单次下限(min_archive_rows)约束，用户要搬就搬
        });
        return { success: true, mode: _tMode, ..._r };
      } catch (e) { return { success: false, error: `归档失败: ${e.message}` }; }
    }

    // 列出归档文件：递归扫 <mode active root>/<date>/*.json，返回 [{file, date, tableId, table, count}]
    case "listTableArchives": {
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      try {
        const _memDir = getMemoryDir(username, charName);
        const _out = [];
        for (const _item of listTableArchiveFiles(_memDir, _tMode)) {
          const _doc = _item.doc;
          if (!_doc) continue;
          if (data.tableId !== undefined && data.tableId !== null && Number(_doc.tableId) !== Number(data.tableId)) continue;
          _out.push({ file: _item.file, date: _doc.date || "", tableId: _doc.tableId, table: _doc.table || "", count: _doc.count || (_doc.entries?.length || 0) });
        }
        _out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return { success: true, mode: _tMode, archives: _out };
      } catch (e) { return { success: false, error: `列出归档失败: ${e.message}` }; }
    }

    // 删除行：与 archiveTableRows 同引擎（archiveTableRowsGeneric），
    //   唯一差别=discard:true 不写归档文件（「删除」=「不保留档案」的参数，不再是前端第二套本地 splice 实现）。
    //   删除无档可恢复 → 删前建全表快照；前端行 ×/批量条「删除选中」走此 verb。
    case "deleteTableRows": {
      if (data.tableId === undefined || data.tableId === null) return { success: false, error: "缺少 tableId" };
      if (!Array.isArray(data.rowIndices) || data.rowIndices.length === 0) return { success: false, error: "缺少 rowIndices（删除必须显式选行）" };
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      try {
        clearCharCache(username, charName);
        const _md = loadMemoryData(username, charName, _tMode, chatId);
        try { createTableSnapshot(username, charName, _md.tables, chatId || "", -1, `deleteTableRows #${data.tableId} 前自动快照`, _tMode); }
        catch (_se) { diag.warn(`deleteTableRows 快照失败(不阻断): ${_se.message}`); }
        const _r = await archiveTableRowsGeneric(username, charName, _tMode, data.tableId, chatId, {
          rowIndices: data.rowIndices, discard: true,
        });
        return { success: true, mode: _tMode, deleted: _r.archived, remaining: _r.remaining, rev: _r.rev };
      } catch (e) { return { success: false, error: `删除失败: ${e.message}` }; }
    }

    // 删除列：{tableId, colIndex} → 删前建全表快照，从 live 表移除该列（列定义+每行对应格），落盘。
    //   与 deleteTableRows 同域语义（删除=不留档+快照保护）；至少保留 1 列。
    //   [2026-07-16] 补齐断链：前端 × 删除列一直发本 verb，后端此前无实现=死按钮（悬空引用实证）。
    case "deleteTableColumn": {
      if (data.tableId === undefined || data.tableId === null) return { success: false, error: "缺少 tableId" };
      if (!Number.isInteger(data.colIndex)) return { success: false, error: "缺少 colIndex" };
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      try {
        clearCharCache(username, charName); // 防陈旧表被移除列后覆盖回写
        const _md = loadMemoryData(username, charName, _tMode, chatId);
        const _tbl = _md.tables.find((t) => t.id === data.tableId);
        if (!_tbl) return { success: false, error: `目标表未找到 (tableId=${data.tableId})` };
        const _cols = _tbl.columns || [];
        if (data.colIndex < 0 || data.colIndex >= _cols.length) return { success: false, error: "colIndex 越界" };
        if (_cols.length <= 1) return { success: false, error: "至少保留 1 列，不能删除最后一列" };
        const _colName = _cols[data.colIndex];
        try { createTableSnapshot(username, charName, _md.tables, chatId || "", -1, `deleteTableColumn #${data.tableId}「${_colName}」前自动快照`, _tMode); }
        catch (_se) { diag.warn(`deleteTableColumn 快照失败(不阻断): ${_se.message}`); }
        _tbl.columns.splice(data.colIndex, 1);
        for (const _r of _tbl.rows) { if (data.colIndex < _r.length) _r.splice(data.colIndex, 1); }
        _tbl.rev = Number(_tbl.rev || 0) + 1;
        const _wu = await saveTablesData(username, charName, _tMode, chatId);
        if (_wu && _wu.ok === false) return { success: false, error: `表格落盘失败: ${_wu.error}` };
        return { success: true, mode: _tMode, tableId: data.tableId, column: _colName, rev: _tbl.rev };
      } catch (e) { return { success: false, error: `删除列失败: ${e.message}` }; }
    }

    // 读单个归档文件（返回 columns+entries）。file 必须是 listTableArchives 回传的相对路径，越界校验。
    case "getTableArchive": {
      if (!data.file) return { success: false, error: "缺少 file" };
      try {
        const _memDir = getMemoryDir(username, charName);
        const _full = path.join(_memDir, data.file);
        // 越界校验：解析后必须仍在 memDir 内，且 basename 结尾 _archive.json（防读任意文件）
        if (!isPathSafe(_full, path.resolve(_memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
        if (!path.basename(_full).endsWith("_archive.json")) return { success: false, error: "非归档文件" };
        if (!fs.existsSync(_full)) return { success: false, error: "归档文件不存在" };
        const _doc = loadJsonFileIfExists(_full, null);
        if (!_doc) return { success: false, error: "归档文件解析失败" };
        return { success: true, file: data.file, columns: _doc.columns || [], entries: _doc.entries || [], count: _doc.count || (_doc.entries?.length || 0), tableId: _doc.tableId, table: _doc.table || "", date: _doc.date || "" };
      } catch (e) { return { success: false, error: `读取归档失败: ${e.message}` }; }
    }

    // 恢复归档行回 live 表头（修3 断链B 20260716：归档迁走的是数组前部=最旧行，插回头部才还原时序；
    //   原决议5「追加到尾」被凛倾「恢复不会恢复顺序」推翻）。恢复前建 tableSnapshot 防误恢复。
    //   rowIndices 传了=只恢复归档 entries 中这些索引；否则恢复全部。
    //   修3 断链C：恢复=移回（归档反演），恢复多少从档里消多少，档空删文件——原「默认保留」使重复点恢复=重复行。
    case "restoreTableArchiveRows": {
      if (!data.file) return { success: false, error: "缺少 file" };
      if (data.tableId === undefined || data.tableId === null) return { success: false, error: "缺少 tableId" };
      const _tMode = _resolveTableMode(data, username, charName, chatId);
      try {
        const _memDir = getMemoryDir(username, charName);
        const _full = path.join(_memDir, data.file);
        if (!isPathSafe(_full, path.resolve(_memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
        if (!path.basename(_full).endsWith("_archive.json")) return { success: false, error: "非归档文件" };
        if (!fs.existsSync(_full)) return { success: false, error: "归档文件不存在" };
        const _doc = loadJsonFileIfExists(_full, null);
        if (!_doc || !Array.isArray(_doc.entries)) return { success: false, error: "归档文件损坏" };

        clearCharCache(username, charName);
        const _md = loadMemoryData(username, charName, _tMode, chatId);
        const _tbl = _md.tables.find((t) => t.id === data.tableId);
        if (!_tbl) return { success: false, error: `目标表未找到 (tableId=${data.tableId})` };

        // 恢复前建全表快照（决议5 防误恢复，复用 tableEdit 前自动快照范式）
        try { createTableSnapshot(username, charName, _md.tables, chatId || "", -1, `restoreTableArchiveRows #${data.tableId} 前自动快照`, _tMode); }
        catch (_se) { diag.warn(`restoreTableArchiveRows 快照失败(不阻断): ${_se.message}`); }

        // entries → rows[][]（按归档 columns 顺序还原；缺列补空）。目标表列以归档 columns 为准对齐。
        const _cols = _doc.columns || _tbl.columns || [];
        const _selIdx = Array.isArray(data.rowIndices) && data.rowIndices.length > 0
          ? new Set(data.rowIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < _doc.entries.length))
          : null;
        const _toRestore = _doc.entries.filter((_e, i) => (_selIdx ? _selIdx.has(i) : true));
        const _newRows = _toRestore.map((_e) => _cols.map((c) => (_e[c] ?? "")));
        _tbl.rows.unshift(..._newRows); // 插回头部还原时序（归档迁走的是最旧前段；entries 相对顺序保持）
        _tbl.rev = Number(_tbl.rev || 0) + 1;
        const _wu = await saveTablesData(username, charName, _tMode, chatId);
        if (_wu && _wu.ok === false) return { success: false, error: `表格落盘失败: ${_wu.error}` };
        // 消账：已恢复的 entries 从档移除（部分恢复只消对应索引），档空删文件。失败只记录——数据已回表
        try {
          const _remain = _doc.entries.filter((_e, i) => (_selIdx ? !_selIdx.has(i) : false));
          if (_remain.length > 0) {
            _doc.entries = _remain;
            _doc.count = _remain.length;
            saveJsonFile(_full, _doc);
          } else {
            fs.unlinkSync(_full);
            try {
              const _parent = path.dirname(_full);
              if (/^\d{4}-\d{2}-\d{2}$/.test(path.basename(_parent)) && fs.readdirSync(_parent).length === 0) fs.rmdirSync(_parent);
            } catch (_rmdirErr) { diag.warn(`restoreTableArchiveRows 清理空日期目录失败: ${_rmdirErr.message}`); }
          }
        } catch (_ue) { diag.warn(`restoreTableArchiveRows 消账失败(数据已恢复,档残留可能被重复恢复): ${_ue.message}`); }
        return { success: true, mode: _tMode, tableId: data.tableId, restored: _newRows.length, rev: _tbl.rev };
      } catch (e) { return { success: false, error: `恢复失败: ${e.message}` }; }
    }

    // === 环境工具管理 ===
    case "getEnvTools": {
      const _etMemDir = ensureMemoryDir(username, charName);
      const _etPath = path.join(_etMemDir, "code", "_env_tools.json");
      let _etConfig = { descriptions: {}, scan_dirs: [] };
      if (fs.existsSync(_etPath)) {
        try { _etConfig = JSON.parse(fs.readFileSync(_etPath, "utf-8")); } catch {}
      }
      // 动态扫描系统工具
      const _isWin = process.platform === "win32";
      const _toolList = [
        { cmd: "node", ver: "--version" }, { cmd: "npm", ver: "--version" },
        { cmd: "npx", ver: "--version" }, { cmd: "pnpm", ver: "--version" },
        { cmd: "yarn", ver: "--version" }, { cmd: "bun", ver: "--version" },
        { cmd: "deno", ver: "--version" }, { cmd: "git", ver: "--version" },
        { cmd: "python", ver: "--version" }, { cmd: "pip", ver: "--version" },
        { cmd: "go", ver: "version" }, { cmd: "java", ver: "-version" },
        { cmd: "rustc", ver: "--version" }, { cmd: "cargo", ver: "--version" },
        { cmd: "dotnet", ver: "--version" }, { cmd: "docker", ver: "--version" },
        { cmd: "tsc", ver: "--version" }, { cmd: "make", ver: "--version" },
        { cmd: "cmake", ver: "--version" }, { cmd: "curl", ver: "--version" },
      ];
      const _detected = [];
      for (const { cmd, ver } of _toolList) {
        try { execSync(_isWin ? `where ${cmd}` : `which ${cmd}`, { timeout: 2000, stdio: "pipe" }); } catch { continue; }
        let version = "";
        try {
          const raw = execSync(`${cmd} ${ver} 2>&1`, { timeout: 3000, stdio: "pipe", shell: true }).toString().trim();
          const m = raw.match(/v?(\d+\.\d+[\w.\-]*)/);
          version = m ? m[1] : "";
        } catch (e) {
          const stderr = (e.stderr || e.stdout || Buffer.alloc(0)).toString();
          const m = stderr.match(/v?(\d+\.\d+[\w.\-]*)/);
          version = m ? m[1] : "";
        }
        _detected.push({ cmd, version });
      }
      // 扫描 npm 目录
      const _npmResults = [];
      for (const entry of (_etConfig.scan_dirs || [])) {
        const dirPath = typeof entry === "string" ? entry : entry.path;
        const label = typeof entry === "string" ? path.basename(entry) : (entry.label || path.basename(entry.path));
        try {
          const pkgPath = path.join(dirPath, "package.json");
          if (!fs.existsSync(pkgPath)) { _npmResults.push({ path: dirPath, label, error: "package.json not found" }); continue; }
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          _npmResults.push({ path: dirPath, label, packages: Object.entries(deps).map(([n, v]) => ({ name: n, version: (v || "").replace(/^\^|~/, "") })) });
        } catch (e) { _npmResults.push({ path: dirPath, label, error: e.message }); }
      }
      return { success: true, config: _etConfig, detected: _detected, npmResults: _npmResults };
    }
    case "saveEnvTools": {
      const _stMemDir = ensureMemoryDir(username, charName);
      const _stCodeDir = path.join(_stMemDir, "code");
      if (!fs.existsSync(_stCodeDir)) fs.mkdirSync(_stCodeDir, { recursive: true });
      const _stPath = path.join(_stCodeDir, "_env_tools.json");
      const _newConfig = { descriptions: data.descriptions || {}, scan_dirs: data.scan_dirs || [] };
      nicerWriteFileSync(_stPath, JSON.stringify(_newConfig, null, 2));
      return { success: true };
    }

    // === 文件管理 ===
    case "listMemoryFiles": {
      const memDir = ensureMemoryDir(username, charName);
      const subPath = data.subPath || "";
      const targetDir = subPath ? path.join(memDir, subPath) : memDir;
      if (!fs.existsSync(targetDir)) return { success: true, files: [], dirs: [] };
      if (!isPathSafe(targetDir, path.resolve(memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const files = [], dirs = [];
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.push({ name: entry.name, path: subPath ? `${subPath}/${entry.name}` : entry.name });
        else if (entry.isFile()) {
          const stat = fs.statSync(path.join(targetDir, entry.name));
          files.push({ name: entry.name, path: subPath ? `${subPath}/${entry.name}` : entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      }
      return { success: true, files, dirs, currentPath: subPath || "/" };
    }

    case "readMemoryFile": {
      if (!data.filePath) return { success: false, error: "缺少 filePath" };
      const memDir = ensureMemoryDir(username, charName);
      const fullPath = path.join(memDir, data.filePath);
      if (!isPathSafe(fullPath, path.resolve(memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(fullPath)) return { success: false, error: "文件不存在" };
      try {
        const content = await fs.promises.readFile(fullPath, "utf8");
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { /* not JSON */ }
        // T037：与 listMemoryFiles(:1434) 对称补返 mtime——右栏查看器显示「更新时间」元信息需此字段（凛倾"记忆文件查看"诉求含 大小/更新时间/属于哪层）。同一 fs.statSync 语义，读文件时顺带取。
        let mtime = null;
        try { mtime = fs.statSync(fullPath).mtime.toISOString(); } catch { /* stat 失败不阻断读取，mtime 缺省 null */ }
        return { success: true, filePath: data.filePath, absPath: path.resolve(fullPath), content, isJson: parsed !== null, parsed, size: Buffer.byteLength(content, "utf8"), mtime };
      } catch (e) { return { success: false, error: `读取失败: ${e.message}` }; }
    }

    case "writeMemoryFile": {
      if (!data.filePath) return { success: false, error: "缺少 filePath" };
      if (data.content === undefined) return { success: false, error: "缺少 content" };
      const memDir = ensureMemoryDir(username, charName);
      const fullPath = path.join(memDir, data.filePath);
      if (!isPathSafe(fullPath, path.resolve(memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const writeContent = typeof data.content === "string" ? data.content : JSON.stringify(data.content, null, "\t") + "\n";
        // N4/M3：改前 .bak 备份 + 央原子写（tmp+rename），防半写损坏用户记忆文件。
        if (fs.existsSync(fullPath)) { try { fs.copyFileSync(fullPath, fullPath + ".bak"); } catch { /* .bak 失败不阻断主写 */ } }
        nicerWriteFileSync(fullPath, writeContent);
        return { success: true, filePath: data.filePath, size: Buffer.byteLength(writeContent, "utf8") };
      } catch (e) { return { success: false, error: `写入失败: ${e.message}` }; }
    }

    case "exportMemory": {
      wbT(_chatid, "setDataActions", "exportMemory:enter", { username, charName });
      try {
        const memDir = ensureMemoryDir(username, charName);
        const zip = new JSZip();
        let fileCount = 0;
        function sanitizePresetsForExport(jsonStr) { try { const d = JSON.parse(jsonStr); if (d.presets && Array.isArray(d.presets)) { for (const preset of d.presets) { if (preset.api_config) preset.api_config = { use_custom: false, source: "", model: preset.api_config.model || "", temperature: preset.api_config.temperature ?? 0.3, max_tokens: preset.api_config.max_tokens ?? 2000 }; delete preset.preset_switch_entries; delete preset.preset_switch_auto; } } return JSON.stringify(d, null, "\t") + "\n"; } catch { return jsonStr; } }
        function sanitizeConfigForExport(jsonStr) { try { const d = JSON.parse(jsonStr); for (const key of ["retrieval_ai", "summary_ai"]) { if (d[key]) d[key] = { ...d[key], api_key: null, base_url: null }; } return JSON.stringify(d, null, "\t") + "\n"; } catch { return jsonStr; } }
        function addDirToZip(dir, zipFolder) {
          if (!fs.existsSync(dir)) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.name.endsWith(".bak") || entry.name.endsWith(".import_bak")) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) addDirToZip(fullPath, zipFolder.folder(entry.name));
            else if (entry.isFile()) { try { let content = fs.readFileSync(fullPath, "utf8"); if (entry.name === "_memory_presets.json") content = sanitizePresetsForExport(content); else if (entry.name === "_config.json") content = sanitizeConfigForExport(content); zipFolder.file(entry.name, content); fileCount++; } catch { /* skip */ } }
          }
        }
        addDirToZip(memDir, zip);
        const zipBase64 = await zip.generateAsync({ type: "base64" });
        const fileName = `beilu-memory_${charName}_${new Date().toISOString().slice(0, 10)}.zip`;
        return { success: true, zipBase64, fileName, fileCount };
      } catch (e) { wbD(_chatid, "setDataActions", "exportMemory:error", false, e.message, {}); return { success: false, error: `导出失败: ${e.message}` }; }
    }

    case "importMemory": {
      wbT(_chatid, "setDataActions", "importMemory:enter", { username, charName });
      try {
        const memDir = ensureMemoryDir(username, charName);
        const resolvedMem = path.resolve(memDir);
        let imported = 0, skipped = 0;
        const errors = [];
        const backupExisting = data.backupExisting !== false;
        if (data.zipBase64) {
          const binaryStr = atob(data.zipBase64);
          const zipBinary = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) zipBinary[i] = binaryStr.charCodeAt(i);
          const zip = await JSZip.loadAsync(zipBinary);
          for (const [relPath, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) continue;
            if (relPath.includes("..")) { errors.push(`非法路径: ${relPath}`); skipped++; continue; }
            const fullPath = path.join(memDir, relPath);
            if (!isPathSafe(fullPath, resolvedMem)) { errors.push(`路径越界: ${relPath}`); skipped++; continue; } // 0716 路径前缀边界修复：收口到 isPathSafe
            try {
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              if (backupExisting && fs.existsSync(fullPath)) try { fs.copyFileSync(fullPath, fullPath + ".import_bak"); } catch { /* ignore */ }
              const content = await zipEntry.async("string");
              nicerWriteFileSync(fullPath, content);
              imported++;
            } catch (e) { errors.push(`写入失败 ${relPath}: ${e.message}`); skipped++; }
          }
        } else {
          const importData = data.importData;
          if (!importData || !importData.files) return { success: false, error: "无效的导入数据" };
          if (importData._format !== "beilu-memory-export") return { success: false, error: "格式标识不匹配" };
          for (const [relPath, content] of Object.entries(importData.files)) {
            const fullPath = path.join(memDir, relPath);
            if (!isPathSafe(fullPath, resolvedMem) || relPath.includes("..")) { errors.push(`路径越界: ${relPath}`); skipped++; continue; } // 0716 路径前缀边界修复：收口到 isPathSafe
            try {
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              if (backupExisting && fs.existsSync(fullPath)) try { fs.copyFileSync(fullPath, fullPath + ".import_bak"); } catch { /* ignore */ }
              nicerWriteFileSync(fullPath, content);
              imported++;
            } catch (e) { errors.push(`写入失败 ${relPath}: ${e.message}`); skipped++; }
          }
        }
        clearCharCache(username, charName);
        return { success: true, imported, skipped, errors: errors.length > 0 ? errors : undefined };
      } catch (e) { return { success: false, error: `导入失败: ${e.message}` }; }
    }

    case "importPresets": {
      const importData = data.importData;
      if (!importData) return { success: false, error: "缺少 importData" };
      if (importData._format !== "beilu-memory-presets-export") return { success: false, error: "格式标识不匹配" };
      if (!Array.isArray(importData.presets) || !Array.isArray(importData.injection_prompts)) return { success: false, error: "缺少 presets 或 injection_prompts 数组" };
      // inj 识别系统 2026-07-13：导入是 injection_prompts 的整体覆写点，与 add/update 同口径校验
      //   autoMode 值域（否则非法值绕过写入口静默入库，门控层拒时无诊断面）
      let _importCacheWarning;
      {
        const _badAm = importData.injection_prompts.filter((p) => p?.autoMode !== undefined && !isValidInjectionAutoMode(String(p.autoMode)));
        if (_badAm.length) return { success: false, error: `导入含非法 autoMode 条目: ${_badAm.map((p) => `${p.id || p.name || "?"}(${p.autoMode})`).join(", ")}` };
        // 缓存前缀契约（凛倾 0810 定案：只提醒不拦截）：导入按用户数据原样落盘，警告随结果下发。
        const _badCachePlacement = importData.injection_prompts
          .map((p) => ({ entry: p, placement: inspectInjectionCachePrefix(p) }))
          .filter(({ placement }) => !placement.safe);
        if (_badCachePlacement.length) {
          _importCacheWarning = `提醒: 导入含动态宏且位于缓存前缀区的条目（已按原样导入，可能破坏缓存命中）: ${_badCachePlacement.map(({ entry, placement }) => `${entry?.id || entry?.name || "?"}(${placement.unsafeMacros.map((m) => `{{${m}}}`).join("/")})`).join(", ")}`;
        }
      }
      if (data.backupExisting !== false) {
        const memDir = ensureMemoryDir(username, "_global");
        const presetsPath = path.join(memDir, "_memory_presets.json");
        if (fs.existsSync(presetsPath)) try { fs.copyFileSync(presetsPath, presetsPath + ".import_bak"); } catch { /* ignore */ }
      }
      saveMemoryPresets(username, charName, { presets: importData.presets, injection_prompts: importData.injection_prompts });
      await _broadcastInjPromptsChanged(username); // [0716 W4] 导入=injection_prompts 整体覆写点
      return { success: true, presetsCount: importData.presets.length, injectionCount: importData.injection_prompts.length, ...(_importCacheWarning ? { warning: _importCacheWarning } : {}) };
    }

    case "deleteMemoryFile": {
      if (!data.filePath) return { success: false, error: "缺少 filePath" };
      const memDir = ensureMemoryDir(username, charName);
      const fullPath = path.join(memDir, data.filePath);
      // 越界守卫（复用 read/writeMemoryFile 同款）+ 禁 ..；只删文件不删目录。
      if (String(data.filePath).includes("..") || !isPathSafe(fullPath, path.resolve(memDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(fullPath)) return { success: false, error: "文件不存在" };
      if (!fs.statSync(fullPath).isFile()) return { success: false, error: "只能删除文件，不能删目录" };
      try {
        // 删前备份 .del_bak，防误删不可逆（配合前端危险确认，仍可回退）
        try { fs.copyFileSync(fullPath, fullPath + ".del_bak"); } catch { /* ignore */ }
        fs.unlinkSync(fullPath);
        clearCharCache(username, charName);
        return { success: true, filePath: data.filePath };
      } catch (e) { return { success: false, error: `删除失败: ${e.message}` }; }
    }

    case "exportPresets": {
      try {
        const _epData = loadMemoryPresets(username, charName);
        const _epPresets = structuredClone(_epData.presets || []);
        // 清 api_config 敏感（仿 exportMemory 的 sanitizePresetsForExport），不外泄 key/url
        for (const _p of _epPresets) {
          if (_p.api_config) _p.api_config = { use_custom: false, source: "", model: _p.api_config.model || "", temperature: _p.api_config.temperature ?? 0.3, max_tokens: _p.api_config.max_tokens ?? 2000 };
          delete _p.preset_switch_entries; delete _p.preset_switch_auto;
        }
        const _epObj = { _format: "beilu-memory-presets-export", presets: _epPresets, injection_prompts: _epData.injection_prompts || [] };
        return { success: true, exportData: _epObj, fileName: `beilu-presets_${new Date().toISOString().slice(0, 10)}.json`, presetsCount: _epPresets.length };
      } catch (e) { return { success: false, error: `导出预设失败: ${e.message}` }; }
    }

    // === C2 字段级 char↔char data 同步 ===

    // 列出可同步的数据域 + 源/目标角色各域是否存在（供前端 C5 入口渲染勾选）
    case "listSyncDomains": {
      // A4 username 权威化：无显式 username 不回退 _default
      const _syncUser = data.username || args?.username;
      if (!_syncUser) {
        return { success: false, error: "未能识别登录用户名（username 解析失败），无法列出同步域，请重新登录后重试。" };
      }
      const _sourceChar = data.sourceChar;
      const _targetChar = data.targetChar;
      const _probe = (charN) => {
        // 不创建目录：用 getMemoryDir（只算路径）+ existsSync 探测，避免误建
        if (!charN || charN === "_global") return null; // 不对 _global 探测（防误同步全局域）
        const _md = getMemoryDir(_syncUser, charN);
        const _out = {};
        for (const [k, dom] of Object.entries(C2_SYNC_DOMAINS)) {
          _out[k] = fs.existsSync(path.join(_md, dom.rel));
        }
        return _out;
      };
      const domains = Object.entries(C2_SYNC_DOMAINS).map(([k, v]) => ({ key: k, label: v.label, type: v.type, rel: v.rel }));
      return {
        success: true,
        domains,
        sourcePresence: _sourceChar ? _probe(_sourceChar) : null,
        targetPresence: _targetChar ? _probe(_targetChar) : null,
      };
    }

    // char→char 字段级（按域）整域覆盖同步。单向一次；双向=两个方向各调一次。
    // 入参：username（权威）、sourceChar、targetChar、domains:string[]（域 key 列表）
    // 语义：对每个域，先把目标角色该域备份到 D 盘，再用源角色该域整体覆盖（绝不静默 merge）。
    case "syncCharDomains": {
      // A4 username 权威化：无显式 username 不回退 _default（防写错用户目录）
      const _syncUser = data.username || args?.username;
      if (!_syncUser) {
        return { success: false, error: "未能识别登录用户名（username 解析失败），无法执行角色同步，请重新登录后重试。" };
      }
      const _sourceChar = data.sourceChar;
      const _targetChar = data.targetChar;
      // 源/目标 char 必须显式，且不允许 _global（防误把全局域当角色卡同步）
      if (!_sourceChar || !_targetChar) {
        return { success: false, error: "缺少 sourceChar 或 targetChar" };
      }
      if (_sourceChar === "_global" || _targetChar === "_global") {
        return { success: false, error: "sourceChar/targetChar 不允许为 _global（角色卡同步不覆盖全局域）" };
      }
      if (_sourceChar === _targetChar) {
        return { success: false, error: "源角色与目标角色相同，无需同步" };
      }
      // char 名安全校验（防路径穿越）
      for (const _c of [_sourceChar, _targetChar]) {
        if (String(_c).includes("..") || String(_c).includes("/") || String(_c).includes("\\") || path.basename(String(_c)) !== String(_c)) {
          return { success: false, error: `角色名包含非法字符: ${_c}` };
        }
      }
      const _domains = Array.isArray(data.domains) ? data.domains : [];
      if (_domains.length === 0) {
        return { success: false, error: "缺少 domains（要同步的数据域列表）" };
      }
      const _badDomain = _domains.find((d) => !_c2IsValidDomain(d));
      if (_badDomain) {
        return { success: false, error: `未知数据域: ${_badDomain}` };
      }
      // 源角色目录必须存在（不创建源；目标可不存在→覆盖=新建）
      const _sourceMemDir = getMemoryDir(_syncUser, _sourceChar);
      if (!fs.existsSync(_sourceMemDir)) {
        return { success: false, error: `源角色记忆目录不存在: ${_sourceChar}` };
      }
      // 目标目录确保存在（首次同步时新建并初始化）
      const _targetMemDir = ensureMemoryDir(_syncUser, _targetChar);

      const results = [];
      for (const _dom of _domains) {
        // 1) 执行覆盖前：目标域备份到 D 盘（绝不静默丢数据）
        const _bk = _c2BackupTargetDomain(_syncUser, _targetChar, _dom, _targetMemDir);
        if (!_bk.ok) {
          // 备份失败=不覆盖该域（保守，宁可不同步也不丢数据）
          results.push({ domain: _dom, success: false, error: _bk.error, copied: 0 });
          continue;
        }
        // 2) 源域整体覆盖目标域
        const _cp = _c2CopyDomain(_dom, _sourceMemDir, _targetMemDir);
        results.push({
          domain: _dom,
          success: _cp.ok,
          copied: _cp.copied,
          backupDir: _bk.empty ? null : _bk.backupDir,
          missingSource: _cp.missingSource || false,
          error: _cp.error,
        });
      }
      // 3) 失效目标角色缓存，使下次读走新内容
      clearCharCache(_syncUser, _targetChar);

      const okCount = results.filter((r) => r.success).length;
      return {
        success: okCount > 0,
        sourceChar: _sourceChar,
        targetChar: _targetChar,
        results,
        message: `已同步 ${okCount}/${results.length} 个数据域（${_sourceChar} → ${_targetChar}，整域覆盖，目标域已备份至 D 盘）`,
      };
    }

    case "getModels": {
      let url, key, generator = "", provider = "", requestSourceName = "";
      if (data.sourceName) {
        const _sn = String(data.sourceName);
        requestSourceName = _sn;
        if (_sn.includes("..") || _sn.includes("/") || _sn.includes("\\") || path.basename(_sn) !== _sn) {
          return { success: false, error: "sourceName 包含非法字符" };
        }
        try {
          const sourcePath = path.join(__projectRoot, "data", "users", username, "serviceSources", "AI", _sn, "config.json");
          if (fs.existsSync(sourcePath)) {
            const sourceData = loadJsonFile(sourcePath);
            const sourceConfig = sourceData.config || {};
            generator = sourceData.generator || "";
            provider = sourceConfig.convert_config?.provider || "";
            url = sourceConfig.url || sourceConfig.base_url || sourceConfig.host;
            key = sourceConfig.apikey || sourceConfig.key;
          }
        } catch (e) { return { success: false, error: `读取源配置失败: ${e.message}` }; }
      } else if (data.apiConfig) { url = data.apiConfig.url; key = data.apiConfig.key; }
      // 0714 边界 trim：历史落盘的脏 URL（前导空格，实证 claude 源 " http://…"）
      //   会使模型端点规整失败；写点已同批 trim，此处对存量数据做输入边界归一。
      url = typeof url === "string" ? url.trim() : url;
      key = typeof key === "string" ? key.trim() : key;
      if (!url) return { success: false, error: "未找到 API URL" };
      const request = modelsRequestFor({ generator, provider }, url);
      const modelsUrl = request.url;
      try {
        new URL(modelsUrl);
      } catch { return { success: false, error: "URL 格式无效" }; }
      try {
        const headers = { "Content-Type": "application/json" };
        if (key) headers["Authorization"] = `Bearer ${key}`;
        await assertSafeOutboundInServerMode(modelsUrl); // SEC-F4：server 下拒内网模型端点（含错误体回显内网探测）
        const controller = new AbortController();
        // T008：15s→8s（前端 sendAction 自身亦有超时叠加，15s+前端超时=用户等 30s；8s 快速失败足够覆盖慢网络握手）
        const timeout = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
          response = await fetch(modelsUrl, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
        const result = await response.json();
        const models = [...new Set(request.normalize(result))].sort();
        return { success: true, models };
      } catch (e) {
        // T008：错误结构化含源名+脱敏URL（前端诊断面展示：用户能看到请求了哪个源、为什么失败）
        const _sourceName = requestSourceName || "(临时配置)";
        const _reason = e.name === "AbortError" ? "请求超时（8s）" : e.message;
        return { success: false, error: `模型列表获取失败 [源: ${_sourceName}]: ${_reason}`, source: _sourceName, reason: _reason };
      }
    }

    // ★ 直接触发分身执行（测试用，返回完整每轮详情）
    case "testClone": {
      const _tcInstruction = typeof data.instruction === "string" ? data.instruction.trim() : "";
      if (!_tcInstruction) return { success: false, error: "测试分身需要明确 instruction" };
      const _tcConfigPath = getYonbanConfigPath(username);
      const _tcConfig = loadJsonFileIfExists(_tcConfigPath, { clones: [] });
      // 契约对账修复（20260706）：详情页测试传 cloneId（subModePanel:2672）原被无视——恒 find(enabled)
      //   取第一个启用分身，用户测 B 实跑 A（测的不是看的）。带 cloneId=精确测该分身（不滤 enabled，
      //   测试即配置验证）；缺省=旧行为（:2752 全局测试入口沿用 enabled 首个）。
      const _tcClone = data.cloneId
        ? (_tcConfig.clones || []).find(c => c.id === data.cloneId)
        : (_tcConfig.clones || []).find(c => c.enabled);
      if (!_tcClone) return { success: false, error: data.cloneId ? `未找到分身配置 ${data.cloneId}` : "没有启用的分身配置" };
      const _tcMaxRounds = data.maxRounds || _tcClone.maxRounds || 40;

      try {
        const { parseIdeToolCallTags, renderStaticIdeToolSignatures } = await import("../../../transport/ideClient.mjs");
        const { pathToFileURL } = await import("node:url");

        // 加载预设提示词
        let _tcSystemPrompts = [];
        if (_tcClone.presetName) {
          const _tcPresetPath = path.join(__pluginDir, "..", "beilu-preset", "presets", _tcClone.presetName + ".json");
          if (fs.existsSync(_tcPresetPath)) {
            const _tcPreset = JSON.parse(fs.readFileSync(_tcPresetPath, "utf-8"));
            _tcSystemPrompts = (_tcPreset.preset_json?.prompts || [])
              .filter(p => p.system_prompt && p.content?.trim())
              .map(p => ({ role: p.role || "system", content: p.content }));
          }
        }
        // 人设唯一来源=预设（凛倾#43）：无预设时顶空白，不再硬编码兜底人设。

        // 加载INJ-2-code工具文档
        const _tcPresetsData = loadMemoryPresets(username, charName);
        const _tcInj2 = (_tcPresetsData.injection_prompts || []).find(p => p.id === "INJ-2-code" && p.enabled);
        if (_tcInj2?.content) {
          // ★ 过滤分身相关段落，防止分身递归调用分身
          let _tcInj2Content = _tcInj2.content
            .replace(/\{\{user\}\}/g, username)
            // 测试分身与正式分身消费同一静态工具注册表；动态项目环境不进入历史前工具文档。
            .replace(/\{\{env_tools\}\}/g, "")
            .replace(/\{\{ide_tools\}\}/g, renderStaticIdeToolSignatures())
            .replace(/<ide_extended>[\s\S]*?## 分身AI[\s\S]*?(?=##|<\/ide_extended>)/, "")
            .replace(/并行调用分身AI[\s\S]*?结果下一轮自动注入/g, "");
          _tcSystemPrompts.push({ role: "system", content: _tcInj2Content });
        }

        // 构建消息
        const _tcMessages = [
          ..._tcSystemPrompts,
          { role: "user", content: _tcInstruction },
        ];

        // Agent循环
        const _tcRounds = [];
        const _tcApiSource = _tcClone.apiSource || "";
        const _tcModel = _tcClone.modelName || "";
        let _tcToolCount = 0;

        for (let _r = 0; _r < _tcMaxRounds; _r++) {
          // 调用AI
          const _tcAiResult = await runMemoryPresetAI(username, charName, {
            id: `TEST_CLONE_${Date.now()}_r${_r}`,
            name: _tcClone.label,
            prompts: _tcMessages.map(m => ({ role: m.role, content: m.content, enabled: true })),
            api_config: {
              use_custom: !!(_tcApiSource || _tcModel || _tcClone.temperature !== undefined),
              source: _tcApiSource || undefined,
              model: _tcModel || undefined,
              temperature: _tcClone.temperature !== undefined ? _tcClone.temperature : 0.5,
              max_tokens: _tcClone.maxTokens || 60000,
              prompt_post_processing: _tcClone.promptPostProcessing || "strict",
              include_reasoning: false,
              // extended_thinking 已删（2026-08-01 收口：思维链跟随所用 AI 源的 per-源设置）
            },
          }, memData, charName, username, "", { maxRounds: 1, aiPriority: "low" }); // [0727 并发闸] 测试分身=后台级

          let _tcReply = (_tcAiResult?.reply || "").replace(/<stopContinue\s*\/?>/gi, "");
          const _tcThinking = _tcAiResult?.thinking || "";

          // ★ 空回重试（最多2次）
          if (!_tcReply.trim()) {
            for (let _retry = 0; _retry < 2; _retry++) {
              console.log(`[testClone] 第${_r+1}轮空回，重试${_retry+1}/2...`);
              await new Promise(r => setTimeout(r, 2000));
              const _retryResult = await runMemoryPresetAI(username, charName, {
                id: `TEST_CLONE_${Date.now()}_r${_r}_retry${_retry}`,
                name: _tcClone.label,
                prompts: _tcMessages.map(m => ({ role: m.role, content: m.content, enabled: true })),
                api_config: {
                  use_custom: true,
                  source: _tcApiSource || undefined,
                  model: _tcModel || undefined,
                  temperature: (_tcClone.temperature || 0.5) + 0.1, // 稍微提高温度重试
                  max_tokens: _tcClone.maxTokens || 60000,
                  prompt_post_processing: "strict",
                  include_reasoning: false,
                },
              }, memData, charName, username, "", { maxRounds: 1, aiPriority: "low" }); // [0727 并发闸] 测试分身重试=后台级
              _tcReply = _retryResult?.reply || "";
              if (_tcReply.trim()) break;
            }
          }

          // 解析工具调用
          const { toolCalls } = parseIdeToolCallTags(_tcReply);

          _tcRounds.push({
            round: _r + 1,
            reply: _tcReply,
            thinking: _tcThinking,
            toolCalls: toolCalls.map(tc => ({ tool: tc.tool, params: tc.params })),
          });

          if (toolCalls.length === 0) {
            // 无工具调用，结束
            break;
          }

          // 执行工具
          const { ideClient } = await import("../../../transport/ideClient.mjs");
          const _tcToolResults = [];
          for (const tc of toolCalls) {
            _tcToolCount++;
            try {
              // [0727 id传导] 测试分身的工具调用也带线 id（gate 语义不动：不加 source，只补路由 id）
              const result = await ideClient.callTool(tc.tool, tc.params, undefined, undefined, { chatid: data.chatid || args?.chatid || null });
              const resultStr = typeof result?.result === "string" ? result.result : JSON.stringify(result?.result || {}).substring(0, 2000);
              _tcToolResults.push(`--- ${tc.tool} ---\n${resultStr}`);
            } catch (e) {
              _tcToolResults.push(`--- ${tc.tool} ---\n❌ ${e.message}`);
            }
          }

          // 注入结果，继续
          _tcMessages.push({ role: "assistant", content: _tcReply });
          // 文案：per-char config.system_texts 覆盖 → DEFAULT_SYSTEM_TEXTS 单源（testclone_* 键）
          let _tcContinueMsg = getSystemText("testclone_tool_result", username, charName).replaceAll("{results}", _tcToolResults.join("\n\n"));
          // 接近轮次上限时提醒输出
          if (_r >= _tcMaxRounds - 3) {
            _tcContinueMsg += getSystemText("testclone_rounds_left", username, charName).replaceAll("{rounds_left}", String(_tcMaxRounds - _r - 1));
          }
          _tcMessages.push({ role: "user", content: _tcContinueMsg });
        }

        return {
          success: true,
          cloneLabel: _tcClone.label,
          model: _tcModel,
          totalRounds: _tcRounds.length,
          totalTools: _tcToolCount,
          rounds: _tcRounds,
        };
      } catch (e) {
        return { success: false, error: e.message, stack: e.stack?.substring(0, 300) };
      }
    }

    case "runMemoryPreset": {
      const preset = presetsData.presets.find((p) => p.id === data.presetId);
      if (!preset) return { success: false, error: `未找到预设 ${data.presetId}` };
      wbT(_chatid, "setDataActions", "runMemoryPreset:enter", { presetId: data.presetId, dryRun: !!data.dryRun, username, charName });
      if (!data.dryRun) pushMemoryAIOutput({ presetId: data.presetId, presetName: preset.name, reply: "", thinking: "", operations: [], status: "running" });
      try {
        const result = await runMemoryPresetAI(username, charName, preset, memData, data.charDisplayName || charName, data.userDisplayName || username, data.chatHistory || "", { dryRun: !!data.dryRun, chatId: _rawChatId }); // T4靶点④
        if (data.presetId === "P1" && result.reply) setLastP1Result({ reply: result.reply, timestamp: result.timestamp }, username, charName, _rawChatId); // T4靶点④：带窗口时落本窗槽
        wbT(_chatid, "setDataActions", "runMemoryPreset:done", { presetId: data.presetId, replyLen: result.reply?.length || 0, totalRounds: result.totalRounds });
        if (!data.dryRun) pushMemoryAIOutput({ presetId: data.presetId, presetName: preset.name, reply: result.reply || "", thinking: result.thinking || "", operations: result.operations || [], status: "done", totalRounds: result.totalRounds, totalTimeMs: result.totalTimeMs });
        return { success: true, ...result };
      } catch (e) {
        wbD(_chatid, "setDataActions", "runMemoryPreset:error", false, e.message, { presetId: data.presetId });
        if (!data.dryRun) pushMemoryAIOutput({ presetId: data.presetId, presetName: preset.name, reply: "", thinking: "", operations: [], status: "error", error: e.message });
        return { success: false, error: e.message };
      }
    }

    case "getMemoryAIOutput": {
      const sinceId = data.sinceId !== undefined && data.sinceId !== null ? Number(data.sinceId) : null;
      let outputs = [...memoryAIOutputQueue];
      if (sinceId !== null && !isNaN(sinceId)) outputs = outputs.filter((o) => o.id > sinceId);
      return { success: true, outputs, hasMore: outputs.length > 0 };
    }

    case "clearMemoryAIOutput": {
      memoryAIOutputQueue.length = 0;
      return { success: true };
    }

    case "dumpP1Request": {
      const preset = presetsData.presets.find((p) => p.id === (data.presetId || "P1"));
      if (!preset) return { success: false, error: `未找到预设` };
      try {
        const result = await runMemoryPresetAI(username, charName, preset, memData, data.charDisplayName || charName, data.userDisplayName || username, data.chatHistory || "(测试对话内容)", { dryRun: true, chatId: _rawChatId }); // T4靶点④
        return { success: true, presetId: result.presetId, presetName: result.presetName, messageCount: result.messages.length, messages: result.messages.map((m, i) => ({ index: i, role: m.role, contentLength: (m.content || "").length, content: m.content })), timestamp: result.timestamp, note: "dryRun 模式" };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "getDiagSnapshot": {
      const presetsForDiag = presetsData.presets || [];
      const injPromptsForDiag = presetsData.injection_prompts || [];
      // T6-6：诊断读本窗 P1 结果——从 _lastP1Results Map 按本窗上下文只读探针取（不消费）。
      // 原读全局单值 lastP1Result（最后任意窗口的结果）会在多窗口下串显别窗口 P1 缓存。
      // 本窗无 P1 结果时 peek 返回 null，诊断如实显示"无缓存"（语义保持）。
      const _p1Diag = peekLastP1Result(username, charName, _rawChatId);
      return {
        success: true, pluginEnabled,
        autoTrigger: memData.config?.retrieval?.auto_trigger || false,
        hasP1Cache: !!_p1Diag, p1CacheLength: _p1Diag ? (_p1Diag.reply || "").length : 0,
        p1CacheTimestamp: _p1Diag?.timestamp || null, p1CacheContent: _p1Diag?.reply || null,
        isP1Running: isP1Running(),
        enabledPresets: presetsForDiag.filter((p) => p.enabled).map((p) => p.id),
        enabledInjections: injPromptsForDiag.filter((p) => p.enabled).map((p) => p.id),
        injectionLog: [...injectionLog], outputQueueLength: memoryAIOutputQueue.length,
        presetSwitchCooldown: Object.fromEntries(presetSwitchCooldown),
        cooldownConfig: memData.config?.preset_switch?.cooldown_rounds ?? 5,
        // [0717 凛倾"看不到P系列输出记录"] 运行留痕（aiRunner _pseries_runs.json，最新在前，最多20条）
        pseriesRuns: readPseriesRuns(username, charName, 20),
      };
    }

    case "updateConfig": {
      // chatid→char 归位单点=_resolveRequestChar（无 char 上下文调用方防落 _global 死配置）
      const _ucChar = await _resolveRequestChar(data, args, charName);
      const memDir = getMemoryDir(username, _ucChar);
      const configPath = path.join(memDir, "_config.json");
      const currentConfig = loadJsonFileIfExists(configPath, { enabled: true });
      if (data.retrieval !== undefined) currentConfig.retrieval = { ...(currentConfig.retrieval || {}), ...data.retrieval };
      if (data.injection !== undefined) currentConfig.injection = { ...(currentConfig.injection || {}), ...data.injection };
      if (data.archive !== undefined) {
        // 白名单收口（2026-07-07 写入链修复）：原 {...data.archive} 盲铺是 _writeArchiveConfig allow 白名单
        // 的旁路口（同键双写路，payload 噪声可污染 config.archive）。复用同一 _ARCHIVE_SPEC 单源过滤，
        // 保持本 case 尾部 :2142 单次落盘不双写文件。
        const _arcAllow = _archiveSpec("chat").allow;
        const _arcPatch = {};
        for (const _k of _arcAllow) if (data.archive[_k] !== undefined) _arcPatch[_k] = data.archive[_k];
        currentConfig.archive = { ...(currentConfig.archive || {}), ..._arcPatch };
      }
      if (data.enabled !== undefined) currentConfig.enabled = !!data.enabled;
      if (data.preset_switch !== undefined) currentConfig.preset_switch = { ...(currentConfig.preset_switch || {}), ...data.preset_switch };
      if (data.web_search !== undefined) currentConfig.web_search = { ...(currentConfig.web_search || {}), ...data.web_search };
      // 思维链设定收口（凛倾 0714「把所有的思维链设定收口到这里.其他的删除」）：reasoning_tags/reasoning_builtin
      //   写路唯一=functions:hide#setReasoningTags（stripThinking.mjs setReasoningTags，写后清 _userTagsCache 立即生效）。
      //   本 verb 原受理这两键=旧门面残枝（写后不清 hide 缓存→30s TTL 内出站剥离仍旧值），全部调用方
      //   （web saveReasoningTags / YonBan ChatService T027）已迁 hide verb，2026-07-15 删除。
      if (data.token_reminder !== undefined) currentConfig.token_reminder = { ...(currentConfig.token_reminder || {}), ...data.token_reminder };
      // 链路3（2026-07-08）：拼接骨架段标题用户配置写口——键白名单=DEFAULT_SECTION_HEADERS 单源
      //   （消费端 prompt_struct.mjs 同表），值必须字符串（空串=不输出该段标题行，合法值）。
      //   消费链: 本写口 → _config.json → loadMemoryData → shadowBuild 填 prompt_struct.section_headers
      //   → structPromptToSingleNoChatLog 覆盖默认标题。
      if (data.section_headers !== undefined) {
        const { DEFAULT_SECTION_HEADERS } = await import("../../../../../public/parts/shells/beilu-chat/src/prompt_struct.mjs");
        const _shPatch = {};
        for (const _k of Object.keys(DEFAULT_SECTION_HEADERS))
          if (typeof data.section_headers?.[_k] === "string") _shPatch[_k] = data.section_headers[_k];
        currentConfig.section_headers = { ...(currentConfig.section_headers || {}), ..._shPatch };
      }
      // [F3 接线 0714] 分身并发上限写口——消费端 replyHandler:2327/3587（?? 0，0=无限多开>0 池限流）。
      //   原状态：消费端设计可调且注释明写"不硬编码"，但本 updateConfig 白名单无此分支=前端发了也静默丢，
      //   用户只能手改 _config.json（双侧断链）。归一化：非负整数，非法输入落 0（=默认无限，与消费端 ?? 0 同义）。
      if (data.clone_concurrency !== undefined) {
        currentConfig.clone_concurrency = Math.max(0, parseInt(data.clone_concurrency, 10) || 0);
      }
      // 链路3（2026-07-08）：系统注入文案写口——键白名单=DEFAULT_SYSTEM_TEXTS 单源（消费端 getPromptHandler 同表）
      if (data.system_texts !== undefined) {
        const _stPatch = {};
        for (const _k of Object.keys(DEFAULT_SYSTEM_TEXTS))
          if (typeof data.system_texts?.[_k] === "string") _stPatch[_k] = data.system_texts[_k];
        currentConfig.system_texts = { ...(currentConfig.system_texts || {}), ..._stPatch };
      }
      // [0716 凛倾定案] mode_preset_bindings 写口已删——「绑定」概念不存在，只有「当前正在使用的预设」。
      saveJsonFile(configPath, currentConfig);
      // [0717 链1 附带修] 缓存键用归位后的 _ucChar：原用归位前 charName，chatid 归位发生时
      // 写盘落 per-char 桶而缓存刷的是 _global 桶=缓存桶错位（TTL 内读到 stale config）。
      const cacheKey = `${username}/${_ucChar}`;
      if (memoryCache.has(cacheKey)) memoryCache.get(cacheKey).config = currentConfig;
      // [0717 跨窗口同步] web_search 改动带变更信号（同 saveSubModes._subModesChanged 范式：信号不带全量，
      //   消费端收到后各自重拉读回落盘真值）——原零广播：A 窗保存联网设置，B 窗四个只读显示点 stale 到
      //   切角色/刷新（凛倾「同一个按钮多处散写不同步」跨窗腿）。中继：REST=memory/main.mjs、桥=memory/index.mjs。
      return { success: true, config: currentConfig, ...(data.web_search !== undefined ? { _webSearchConfigChanged: { charName: _ucChar } } : {}) };
    }

    case "compactContext": {
      let _compactSource = null;
      if (chatId) {
        try {
          _compactSource = await _readAuthoritativeCompactSource(chatId, data.sourceMessageIds);
        } catch (error) {
          return {
            success: false,
            applied: false,
            superseded: error?.code === "E_CONTEXT_SUMMARY_SOURCE_SUPERSEDED"
              || error?.code === "E_CONTEXT_SUMMARY_SOURCE_ORDER_DRIFT",
            code: error?.code || "E_CONTEXT_SUMMARY_SOURCE_UNAVAILABLE",
            error: error?.message || String(error),
          };
        }
      } else if (typeof data.chatHistory === "string" && data.chatHistory.trim()) {
        // 无 per-chat 坐标的旧内部调用没有可重读的聊天真源，只保留既有角色级兼容行为。
        _compactSource = { chatHistory: data.chatHistory, sourceRevision: null, entries: null };
      } else {
        return { success: false, applied: false, error: "缺少权威压缩来源", code: "E_CONTEXT_SUMMARY_SOURCE_REQUIRED" };
      }
      const _authoritativeHistory = _compactSource.chatHistory;
      if (!_authoritativeHistory.trim()) {
        return { success: false, applied: false, error: "权威压缩来源为空", code: "E_CONTEXT_SUMMARY_SOURCE_EMPTY" };
      }

      const _summaryWriteToken = chatId
        ? await beginContextSummaryWrite(username, charName, chatId, {
          sourceRevision: _compactSource.sourceRevision,
        })
        : null;
      if (_summaryWriteToken && _summaryWriteToken.ok !== true) {
        return {
          success: false,
          applied: false,
          busy: _summaryWriteToken.busy === true,
          code: _summaryWriteToken.code || "E_CONTEXT_SUMMARY_WRITE_BLOCKED",
          error: "当前对话摘要正在回档改写期，本次压缩未执行",
          leaseExpiresAt: _summaryWriteToken.leaseExpiresAt || null,
        };
      }
      const _commitSummary = async (summaryData) => {
        if (!chatId) {
          writeContextSummary(username, charName, summaryData);
          return { committed: true, legacy: true };
        }
        let currentSource;
        try {
          currentSource = await _readAuthoritativeCompactSource(chatId, data.sourceMessageIds);
        } catch (error) {
          return {
            committed: false,
            superseded: true,
            code: error?.code || "E_CONTEXT_SUMMARY_SOURCE_SUPERSEDED",
            error: error?.message || String(error),
          };
        }
        return commitContextSummaryWrite(username, charName, chatId, _summaryWriteToken, summaryData, {
          currentSourceRevision: currentSource.sourceRevision,
        });
      };
      const _summaryCommitFailure = (commit) => ({
        success: false,
        applied: false,
        superseded: commit?.superseded === true,
        busy: commit?.busy === true,
        code: commit?.code || "E_CONTEXT_SUMMARY_WRITE_NOT_COMMITTED",
        error: commit?.error || (commit?.superseded
          ? "压缩期间对话摘要已被回档或更新，迟到结果已丢弃"
          : "对话摘要未能确认提交"),
        expected: commit?.expected || null,
        actual: commit?.actual || null,
      });

      // === 第一级：快速裁剪（不调AI，直接删旧对话30%） ===
      if (data.quickPrune) {
        const lines = _authoritativeHistory.split("\n");
        const keepStart = Math.floor(lines.length * 0.3);
        const pruned = [
          lines[0], // 保留第一条（开场上下文）
          `[...已省略 ${keepStart - 1} 条早期对话...]`,
          ...lines.slice(keepStart),
        ].join("\n");
        const summaryData = {
          summary: pruned, keep_indices: [],
          timestamp: new Date().toISOString(),
          originalChars: _authoritativeHistory.length, summaryChars: pruned.length,
          compressionRatio: ((1 - pruned.length / _authoritativeHistory.length) * 100).toFixed(1),
          method: "quickPrune",
        };
        const commit = await _commitSummary(summaryData);
        if (commit.committed !== true) return _summaryCommitFailure(commit);
        return { success: true, summary: pruned, method: "quickPrune", compressionRatio: summaryData.compressionRatio };
      }

      // === 第二级+第三级：AI摘要（三级降级） ===
      let aiApiConfig = null;
      const p7Preset = presetsData.presets.find((p) => p.id === "P7");
      if (p7Preset?.api_config) aiApiConfig = p7Preset.api_config;
      else { const p1P = presetsData.presets.find((p) => p.id === "P1"); if (p1P?.api_config) aiApiConfig = p1P.api_config; else { const anyP = presetsData.presets.find((p) => p.enabled && p.api_config); if (anyP?.api_config) aiApiConfig = anyP.api_config; } }
      if (!aiApiConfig) return { success: false, error: "未找到可用的 AI 配置" };

      const compactKeepLast = Number.isInteger(data.keepLastN) && data.keepLastN >= 0 ? data.keepLastN : 0;
      const compactRange = Array.isArray(_compactSource.entries)
        ? _compactSource.entries.length
        : Math.max(0, (Number.isInteger(data.messageCount) ? data.messageCount : 0) - compactKeepLast);
      const compactMsgCount = compactRange + compactKeepLast;

      // 接通：用户在面板编辑的 P7 prompts 优先（按当前模式选 prompts/_code/_work，
      // 由 runMemoryPresetAI 自动替换 {{chat_history}}）；未配置有效 prompts 时回退单源默认指令。
      const _compactMode = getActiveMode(username, charName, _rawChatId); // T4靶点③：per-chat 模式选 P7 prompt 集（char 级会跨窗选错）
      const _p7Set = p7Preset ? pickPresetPromptSet(p7Preset, _compactMode) : [];
      let compactPreset, compactChatHistory;
      if (p7Preset && p7HasMeaningfulPrompts(_p7Set)) {
        compactPreset = p7Preset;
        compactChatHistory = _authoritativeHistory; // 服务端权威历史经 {{chat_history}} 注入
      } else {
        compactPreset = {
          id: "P7_compact", name: "上下文压缩", enabled: true,
          api_config: { ...aiApiConfig },
          prompts: [
            { role: "system", content: DEFAULT_COMPACT_MERGE_INSTRUCTIONS, identifier: "P7_system", enabled: true, builtin: true },
            // 引导句已删（凛倾0712：代码禁产生进对话的文本）——system 侧默认指令已含压缩语义，user 侧只给数据
            { role: "user", content: _authoritativeHistory, identifier: "P7_user", enabled: true, builtin: true },
          ],
        };
        compactChatHistory = ""; // 历史已内联进合成 user prompt
      }

      // 第二级：完整AI摘要。AI/network await 始终在文件锁外，落盘只走上方 CAS。
      let summaryData;
      let responsePayload;
      let fullError = null;
      try {
        const result = await runMemoryPresetAI(username, charName, compactPreset, memData, data.charDisplayName || charName, data.userDisplayName || username, compactChatHistory, { maxRounds: 1, chatId: _rawChatId }); // T4靶点④
        const rawReply = (result.reply || "").trim();
        if (!rawReply) throw new Error("AI返回空响应");
        let parsedResponse;
        try { parsedResponse = JSON.parse(rawReply); } catch { const jsonMatch = rawReply.match(/\{[\s\S]*\}/); if (jsonMatch) { try { parsedResponse = JSON.parse(jsonMatch[0]); } catch { parsedResponse = { summary: rawReply, keep_indices: [] }; } } else { parsedResponse = { summary: rawReply, keep_indices: [] }; } }
        const summary = parsedResponse.summary || rawReply;
        const keepIndices = Array.isArray(parsedResponse.keep_indices) ? parsedResponse.keep_indices.filter((i) => typeof i === "number" && i >= 0 && i < compactRange) : [];
        summaryData = { summary, keep_indices: keepIndices, timestamp: new Date().toISOString(), originalChars: _authoritativeHistory.length, summaryChars: summary.length, messageCount: compactMsgCount, compactRange, keepLastN: compactKeepLast, compressionRatio: ((1 - summary.length / _authoritativeHistory.length) * 100).toFixed(1), method: "aiSummary" };
        responsePayload = { success: true, summary, keep_indices: keepIndices, reasoning: parsedResponse.reasoning || "", summaryChars: summary.length, originalChars: _authoritativeHistory.length, compressionRatio: summaryData.compressionRatio, method: "aiSummary" };
      } catch (error) {
        fullError = error;
        console.warn(`[beilu-memory] compactContext 完整摘要失败，降级为快速裁剪:`, fullError.message);

        // 第三级：兜底 — 快速裁剪
        const lines = _authoritativeHistory.split("\n");
        const keepStart = Math.floor(lines.length * 0.3);
        const fallback = [
          lines[0],
          `[...AI摘要失败，已省略 ${keepStart - 1} 条早期对话（原因：${fullError.message}）...]`,
          ...lines.slice(keepStart),
        ].join("\n");
        summaryData = {
          summary: fallback, keep_indices: [],
          timestamp: new Date().toISOString(),
          originalChars: _authoritativeHistory.length, summaryChars: fallback.length,
          compressionRatio: ((1 - fallback.length / _authoritativeHistory.length) * 100).toFixed(1),
          method: "fallbackPrune",
        };
        responsePayload = { success: true, summary: fallback, method: "fallbackPrune", compressionRatio: summaryData.compressionRatio, warning: fullError.message };
      }
      const commit = await _commitSummary(summaryData);
      if (commit.committed !== true) return _summaryCommitFailure(commit);
      return { ...responsePayload, ...(commit.mirrorError ? { mirrorWarning: commit.mirrorError } : {}) };
    }

    case "clearInjections": {
      try {
        // 按勾分清：P1/搜索是缓存；工具结果是 chatLog system 消息(需 hide)。默认清=兼容旧调用，显式 false 才跳过。
        if (data.clearP1 !== false) { setLastP1Result(null, username, charName, chatId); setLastP1Result(null, username, charName); } // T4靶点④：清本窗槽+"_"槽（保持"清P1缓存"全清语义）
        if (data.clearWeb !== false) {
          // [0726 功能槽] key 现在是 "线路#功能"，按裸线路 key 做 has/delete 会**永远匹配不到**
          //   （静默失效：用户点"清除"没反应也无报错）。改为清该线路下的全部功能槽。
          for (const [k] of listChatSearchSlots(username, charName, chatId)) pendingChatSearchResults.delete(k);
        }
        if (data.clearSummary) {
          const _summaryClear = await clearContextSummary(username, charName, chatId);
          if (_summaryClear?.busy) {
            return {
              success: false,
              applied: false,
              busy: true,
              code: _summaryClear.code,
              error: "对话摘要正在回档改写期，已拒绝无令牌清理",
            };
          }
        }
        let toolHidden = 0;
        if (data.clearTool && data.chatid) {
          // 工具调用结果 = chatLog 的 [IDE工具执行结果] system 消息(非缓存)，可逆 hide（修「勾工具结果实际没清工具结果」）
          const _coPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
          const { pathToFileURL: _pfu } = await import("node:url");
          const _co = await import(_pfu(_coPath).href);
          const _tl = await _co.GetChatLogLength(data.chatid);
          const _lg = _tl > 0 ? await _co.GetChatLog(data.chatid, 0, _tl) : [];
          const _ti = [];
          for (let i = 0; i < _lg.length; i++) { if (!_lg[i].extension?._hidden && isIdeToolResultMsg(_lg[i])) _ti.push(i); }
          if (_ti.length > 0) {
            // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
            const _idsCT = _ti.map((i) => _lg[i]?.id);
            await _co.hideMessages(data.chatid, _ti, true, { ...(_idsCT.every(Boolean) ? { ids: _idsCT } : {}), meta: { by: "auto", reason: "clearTool" } });
            toolHidden = _ti.length;
          }
        }
        return { success: true, toolHidden };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // 80% 阈值轻量清理：可逆 hide 三类噪声（AI读取/工具结果 + AI操作/YonBan命令 + 分身输入），各保留最近 N。
    // 与 AI 摘要压缩(compactContext)不同：纯隐藏不调 AI、即时省 token、可撤销（hide=false）。
    case "hideContextNoise": {
      const _hnChatid = data.chatid;
      if (!_hnChatid) return { success: false, error: "缺少 chatid" };
      const _hnKeep = Number.isInteger(data.keepLast) ? data.keepLast : 2;
      try {
        const _coPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
        const { pathToFileURL: _pfu } = await import("node:url");
        const _co = await import(_pfu(_coPath).href);
        const _len = await _co.GetChatLogLength(_hnChatid);
        const _log = _len > 0 ? await _co.GetChatLog(_hnChatid, 0, _len) : [];
        // ★ D7 单源:噪声下标收集收口到 ideClient.collectNoiseToHide(原与 getPromptHandler:urgent 逐字复制,差异点 keep 参数化)。
        const { indices: _toHide, breakdown: _bd } = collectNoiseToHide(_log, _hnKeep);
        if (_toHide.length > 0) {
          // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
          const _idsHN = _toHide.map((i) => _log[i]?.id);
          await _co.hideMessages(_hnChatid, _toHide, true, { ...(_idsHN.every(Boolean) ? { ids: _idsHN } : {}), meta: { by: "auto", reason: "hideContextNoise" } });
        }
        return { success: true, hidden: _toHide.length, breakdown: _bd, keepLast: _hnKeep };
      } catch (e) { return { success: false, error: `hide 噪声失败: ${e.message}` }; }
    }

    case "getReadCacheFromChat": {
      // 从chatLog扫描所有文件读取结果（覆盖内存中丢失的记录）
      const chatid = data.chatid;
      if (!chatid) return { success: false, error: "缺少 chatid" };
      const entries = [];
      const now = Date.now();
      try {
        const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
        const { pathToFileURL: _pfu1 } = await import("node:url");
        const chatOps = await import(_pfu1(chatOpsPath).href);
        const _total = await chatOps.GetChatLogLength(chatid);
        const chatLog = _total > 0 ? await chatOps.GetChatLog(chatid, 0, _total) : [];
        if (chatLog && Array.isArray(chatLog)) {
          for (let i = 0; i < chatLog.length; i++) {
            const msg = chatLog[i];
            // 已清理(_hidden 软掩码)的工具结果不再列入——否则清理后重开面板又出现=「清理不了」。
            if (msg?.extension?._hidden) continue;
            if (!isIdeToolResultMsg(msg)) continue;
            // 解析每个工具块: --- tool_name (timestamp) ---
            const blockRe = /---\s+(\w+)\s+\(([^)]*)\)\s+---/g;
            let m;
            while ((m = blockRe.exec(msg.content)) !== null) {
              const tool = m[1];
              const timestamp = m[2];
              // 尝试提取路径（读取类工具通常在 tool 名后面有路径信息）
              const afterHeader = msg.content.substring(m.index + m[0].length);
              const nextBlock = afterHeader.indexOf("\n--- ");
              const blockContent = nextBlock > 0 ? afterHeader.substring(0, nextBlock) : afterHeader.replace(/\n\[\/IDE工具执行结果\][\s\S]*$/, "");
              const chars = blockContent.length;
              const lines = blockContent.split("\n").length;
              // 从前后文本推断路径
              let filePath = "(消息#" + i + ")";
              // AI的ideToolCall中可能有path属性，但工具结果里没有直接的路径
              // 往前找同一轮AI消息中的ideToolCall标签
              if (i > 0) {
                const prevMsg = chatLog[i - 1];
                if (prevMsg && prevMsg.role !== "system" && prevMsg.role !== "user" && prevMsg.content) {
                  // 匹配 <ideToolCall tool="read_file" path="xxx" />
                  const tcRe = new RegExp(`<ideToolCall\\s+tool="${tool}"\\s+path="([^"]*)"`, "g");
                  const tcMatch = tcRe.exec(prevMsg.content);
                  if (tcMatch) filePath = tcMatch[1];
                }
              }
              entries.push({
                path: filePath,
                tool,
                lines,
                chars,
                tokens: Math.ceil(chars / 3.5),
                age: timestamp ? now - new Date(timestamp).getTime() : 0,
                chatLogIndex: i,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[beilu-memory] getReadCacheFromChat失败:", e.message);
      }
      // ★ 隔离修复：合并「本对话」内存读缓存(ideClient._readCache 现已按 chatid 分区)，
      //   补全 chatLog 扫描里推断不到的准确路径(那里拿不到时只能记"(消息#N)")。只取本对话分区
      //   → 杜绝原先把进程级全局缓存(所有对话)串进面板的 67 项跨对话串台。chatLogIndex:-1 的条目
      //   由 cleanReadCache 的 paths 分支经 removeFromReadCache(path,chatid) 清理(可清)。
      const _ownCache = ideClient._readCache.get(chatid);
      if (_ownCache) {
        for (const [p, info] of _ownCache) {
          if (entries.some(e => e.path === p)) continue;
          entries.push({
            path: p,
            tool: info.tool,
            lines: info.lines,
            chars: info.chars,
            tokens: info.tokens || Math.ceil(info.chars / 3.5),
            age: now - new Date(info.timestamp).getTime(),
            chatLogIndex: -1,
          });
        }
      }
      return { success: true, entries };
    }

    case "cleanReadCache": {
      // 前端压缩面板: 选择性清理文件读取缓存
      // 支持两种模式:
      //   paths: string[] — 按路径匹配删除
      //   chatLogIndices: number[] — 按chatLog索引精确删除
      const paths = data.paths || [];
      const chatLogIndices = data.chatLogIndices || [];
      if (paths.length === 0 && chatLogIndices.length === 0) {
        return { success: false, error: "缺少 paths 或 chatLogIndices" };
      }
      let cleaned = 0;
      const chatid = data.chatid;
      // 从 ideClient._readCache 移除（按本对话分区，不误删别的对话缓存）
      for (const p of paths) {
        if (ideClient.removeFromReadCache(p, chatid)) cleaned++;
      }
      // 从 chatLog 中删除对应消息
      if (chatid) {
        try {
          const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
          const { pathToFileURL: _pfu2 } = await import("node:url");
          const chatOps = await import(_pfu2(chatOpsPath).href);
          const _total2 = await chatOps.GetChatLogLength(chatid);
          const chatLog = _total2 > 0 ? await chatOps.GetChatLog(chatid, 0, _total2) : [];
          if (chatLog && Array.isArray(chatLog)) {
            const deleteSet = new Set(chatLogIndices.filter(i => i >= 0 && i < chatLog.length));
            if (paths.length > 0) {
              for (let i = 0; i < chatLog.length; i++) {
                const msg = chatLog[i];
                if (isIdeToolResultMsg(msg)) {
                  if (paths.some(p => msg.content.includes(p))) {
                    deleteSet.add(i);
                  }
                }
              }
            }
            // 删除=不发送掩码（_hidden），非物理删除：留盘可逆，仅不送 AI
            const sortedIndices = [...deleteSet].filter(i => i >= 0 && i < chatLog.length);
            if (sortedIndices.length > 0) {
              // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
              const _idsCRC = sortedIndices.map((i) => chatLog[i]?.id);
              await chatOps.hideMessages(chatid, sortedIndices, true, { ...(_idsCRC.every(Boolean) ? { ids: _idsCRC } : {}), meta: { by: "auto", reason: "cleanReadCache" } });
              cleaned += sortedIndices.length;
            }
          }
        } catch (e) {
          console.warn("[beilu-memory] cleanReadCache chatLog清理失败:", e.message);
        }
      }
      return { success: true, cleaned };
    }

    case "smartCleanChat": {
      // 智能清理：不删除消息，只给旧消息打 _hidden 标记
      // 被标记的消息不会注入到 AI 上下文，但保留在 chatLog 中（前端可翻看历史）
      const chatid = data.chatid;
      const keepRecent = data.keepRecent || 10;
      if (!chatid) return { success: false, error: "缺少 chatid" };
      try {
        const chatStoragePath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatStorage.mjs");
        const { pathToFileURL } = await import("node:url");
        const chatStorage = await import(pathToFileURL(chatStoragePath).href);

        const chatMeta = await chatStorage.loadChat(chatid);
        if (!chatMeta || !chatMeta.chatLog) return { success: false, error: "无法读取chatLog" };

        // 按可见序(未 hidden)统计：手动「保留最近 keepRecent 条对话」针对还在发送的可见消息，
        // 已 hidden 的不计入(对齐 slider ?visible=1，避免把已隐藏算进"可清理总数")。
        // keep_indices 坐标=可见序旧对话区 [0,visCutoff)。
        const visIdx = [];
        for (let i = 0; i < chatMeta.chatLog.length; i++) if (!chatMeta.chatLog[i].extension?._hidden) visIdx.push(i);
        const visTotal = visIdx.length;
        if (visTotal <= keepRecent) return { success: true, hidden: 0, kept: visTotal, total: visTotal, message: "可见消息数不超过保留数量" };

        const visCutoff = visTotal - keepRecent;
        const keepSet = new Set(Array.isArray(data.keepIndices) ? data.keepIndices : []);
        let hidden = 0, keptByAI = 0;
        const _hiddenIdx = [];
        const _nowTs = Date.now();
        // hide 前 visCutoff 条可见消息(保留最近 keepRecent 条可见)；AI 指定保留的原文跳过不 hide
        for (let v = 0; v < visCutoff; v++) {
          if (keepSet.has(v)) { keptByAI++; continue; }
          const raw = visIdx[v];
          if (!chatMeta.chatLog[raw].extension) chatMeta.chatLog[raw].extension = {};
          chatMeta.chatLog[raw].extension._hidden = true;
          chatMeta.chatLog[raw].extension._hiddenMeta = { by: "auto", at: _nowTs, reason: "smartClean" }; // T4
          _hiddenIdx.push(raw);
          hidden++;
        }

        await chatStorage.saveChat(chatid);
        // 多窗口一致——hide 后广播 messages_hidden 让其他窗口灰显刷新（对齐 chatOps.hideMessages）。
        // #4：payload 必带 {indices,hide} 才匹配前端 handleMessagesHidden(indices,hide)（virtualQueue:522 非数组直接 return）；
        //     原 {count} 到他端=空操作，发起窗口靠 location.reload 掩盖了不一致。
        if (hidden > 0) {
          // [0716 C3 口径收口] 原手拼路径动态 import broadcast.mjs＝T3 对接批的散拼漏网 → bus:broadcast.emit 出口
          //   （与 _broadcastTaskUpdate 同口径；emit=本窗口投递，语义与原 broadcastChatEvent 等价）。
          try {
            const _r = await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid, event: { type: "messages_hidden", payload: { indices: _hiddenIdx, hide: true, count: hidden, meta: { by: "auto", reason: "smartClean" } } } } });
            if (!_r?.ok) console.warn("[setData] smartClean broadcast failed:", _r?.error?.msg);
          } catch (e) { console.warn("[setData] smartClean broadcast failed:", e?.message); }
        }
        return { success: true, hidden, kept: keepRecent, keptByAI, total: visTotal, cutoff: visCutoff };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "hideCloneMessages": {
      // 屏蔽分身委派相关的系统消息
      const hcChatid = data.chatid;
      if (!hcChatid) return { success: false, error: "缺少 chatid" };
      try {
        const chatStoragePath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatStorage.mjs");
        const { pathToFileURL } = await import("node:url");
        const chatStorage = await import(pathToFileURL(chatStoragePath).href);

        const chatMeta = await chatStorage.loadChat(hcChatid);
        if (!chatMeta || !chatMeta.chatLog) return { success: false, error: "无法读取chatLog" };

        let hidden = 0;
        const _hiddenIdx = [];
        const _nowTs = Date.now();
        for (let i = 0; i < chatMeta.chatLog.length; i++) {
          const entry = chatMeta.chatLog[i];
          // 匹配分身相关消息：含 <分身 或 <delegate> 或 <parallelDelegate> 或 <report> 或 <approval> 标签
          const c = entry.content || "";
          if (CLONE_TAG_RE.test(c)) {
            if (!entry.extension) entry.extension = {};
            if (!entry.extension._hidden) {
              entry.extension._hidden = true;
              entry.extension._hiddenMeta = { by: "auto", at: _nowTs, reason: "cloneClean" }; // T4
              _hiddenIdx.push(i);
              hidden++;
            }
          }
        }

        await chatStorage.saveChat(hcChatid);
        // #4：payload 带 {indices,hide} 对齐前端 handleMessagesHidden（原 {count} 到他端=空操作）
        if (hidden > 0) {
          // [0716 C3 口径收口] 同上 smartClean 处：散拼漏网 → bus:broadcast.emit 出口。
          try {
            const _r = await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: hcChatid, event: { type: "messages_hidden", payload: { indices: _hiddenIdx, hide: true, count: hidden, meta: { by: "auto", reason: "cloneClean" } } } } });
            if (!_r?.ok) console.warn("[setData] cloneClean broadcast failed:", _r?.error?.msg);
          } catch (e) { console.warn("[setData] cloneClean broadcast failed:", e?.message); }
        }
        return { success: true, hidden };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "injectSummaryMessage": {
      // 全量清理后注入摘要系统消息
      const isChatid = data.chatid;
      const summary = data.summary;
      if (!isChatid || !summary) return { success: false, error: "缺少 chatid 或 summary" };
      try {
        const chatStoragePath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatStorage.mjs");
        const { pathToFileURL } = await import("node:url");
        const chatStorage = await import(pathToFileURL(chatStoragePath).href);

        const chatMeta = await chatStorage.loadChat(isChatid);
        if (!chatMeta || !chatMeta.chatLog) return { success: false, error: "无法读取chatLog" };

        // 找到第一条非hidden消息，在它前面插入摘要
        const firstVisibleIdx = chatMeta.chatLog.findIndex(e => !e.extension?._hidden);
        const summaryEntry = {
          id: "summary_" + Date.now(),
          role: "system",
          name: "对话摘要",
          // 文案单源=DEFAULT_SYSTEM_TEXTS.summary_replaced_wrap（per-char config.system_texts 可覆盖，0722 铁律迁移）
          content: getSystemText("summary_replaced_wrap", username, charName).replaceAll("{count}", String(data.hiddenCount || "?")).replaceAll("{summary}", summary),
          content_for_show: `📋 **对话摘要** (${data.originalChars || "?"} → ${data.summaryChars || "?"}字)\n\n${summary}`,
          extension: { _isSummary: true },
          timestamp: Date.now(),
        };

        if (firstVisibleIdx >= 0) {
          chatMeta.chatLog.splice(firstVisibleIdx, 0, summaryEntry);
        } else {
          chatMeta.chatLog.push(summaryEntry);
        }

        await chatStorage.saveChat(isChatid);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "cleanXmlTags": {
      const chatid = data.chatid;
      if (!chatid) return { success: false, error: "缺少 chatid" };
      try {
        const chatOpsPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "chatOps.mjs");
        const { pathToFileURL } = await import("node:url");
        const chatOps = await import(pathToFileURL(chatOpsPath).href);
        // T012 标签名单源：名称来源=constants.mjs OPERATION_TAG_NAMES（显示剥离面清单，YonBan OPERATION_TAGS 互指）。
        // 本工具只取子集（块删 4 + 替换 2）且行为=删除/「[已执行:x]」替换混合——子集与行为差异是手动清理工具的
        // 设计（≠显示面 12 全集），不合一；运行时校验子集⊆共享清单，漂移即警告留痕。
        const _tagConstPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "constants.mjs");
        const { OPERATION_TAG_NAMES } = await import(pathToFileURL(_tagConstPath).href);
        const _knownTags = new Set([...OPERATION_TAG_NAMES.paired, ...OPERATION_TAG_NAMES.pairedLoose]);
        for (const _t of ["tableEdit", "memoryArchive", "memorySearch", "memoryNote", "ideToolCall", "file_op"])
          if (!_knownTags.has(_t)) console.warn(`[cleanXmlTags] T012 漂移警告: 标签 ${_t} 已不在 OPERATION_TAG_NAMES 共享清单`);
        const total = await chatOps.GetChatLogLength(chatid);
        const chatLog = await chatOps.GetChatLog(chatid, 0, total);
        if (!chatLog || !Array.isArray(chatLog)) return { success: false, error: "无法读取 chat_log" };
        let cleanedCount = 0;
        // 逐标签独立匹配（同修：原交替组开/闭标签独立捕获可 <tableEdit>…</memoryNote> 跨标签吞正文——
        // 与 YonBan chat-messages 历史 bug 同族，YonBan 侧早已按逐标签修）
        const blockDelRegexes = ["tableEdit", "memoryArchive", "memorySearch"].map((t) => new RegExp(`<${t}>[\\s\\S]*?<\\/${t}>`, "gi"));
        blockDelRegexes.push(/<memoryNote\s+type="\w+">[\s\S]*?<\/memoryNote>/gi);
        const ideTagRegex = /<ideToolCall\s+[^>]*>[\s\S]*?<\/ideToolCall>/gi;
        const fileOpTagRegex = /<file_op\s+[^>]*>[\s\S]*?<\/file_op>/gi;
        const editFailures = [];
        for (let i = 0; i < chatLog.length; i++) {
          const msg = chatLog[i]; if (!msg.content) continue;
          let cleanContent = msg.content;
          for (const _re of blockDelRegexes) cleanContent = cleanContent.replace(_re, "");
          cleanContent = cleanContent.replace(ideTagRegex, (match) => {
            const toolMatch = match.match(/tool="([^"]*)"/);
            return toolMatch ? `[已执行: ${toolMatch[1]}]` : "";
          });
          cleanContent = cleanContent.replace(fileOpTagRegex, (match) => {
            const toolMatch = match.match(/tool="([^"]*)"/);
            return toolMatch ? `[已执行: ${toolMatch[1]}]` : "";
          });
          cleanContent = cleanContent.trim();
          if (cleanContent !== msg.content) {
            const messageId = typeof msg.id === "string" ? msg.id.trim() : "";
            if (!messageId) {
              editFailures.push({ indexHint: i, code: "E_EDIT_MESSAGE_ID_REQUIRED", error: "遗留消息缺少稳定 ID，已拒绝按 index 编辑" });
              continue;
            }
            // messageId 是唯一身份，i 只是锁内重定位的 hint。未传 files/extension 时由 editMessage
            // 保留原附件与 extension，本链路不改图片/SVG/附件注入规则。
            const editResult = await chatOps.editMessage(
              chatid,
              messageId,
              i,
              { content: cleanContent },
              { expectedUsername: username },
            );
            if (editResult?.applied !== true) {
              editFailures.push({
                indexHint: i,
                messageId,
                code: editResult?.code || "E_EDIT_NOT_APPLIED",
                error: editResult?.reason || editResult?.error || "编辑未确认应用",
              });
              continue;
            }
            cleanedCount += 1;
          }
        }
        // 系统工具结果消息=不发送掩码（_hidden），非物理删除：留盘可逆
        const _toolIdx = [];
        for (let i = 0; i < chatLog.length; i++) {
          if (isIdeToolResultMsg(chatLog[i])) _toolIdx.push(i);
        }
        if (_toolIdx.length > 0) {
          // T3 id锚定：按稳定 entry.id 传递，hideMessages reload后按id重定位下标，防TOCTOU漂移
          const _idsSCC = _toolIdx.map((i) => chatLog[i]?.id);
          await chatOps.hideMessages(chatid, _toolIdx, true, { ...(_idsSCC.every(Boolean) ? { ids: _idsSCC } : {}), meta: { by: "auto", reason: "cleanIdeResults" } });
          cleanedCount += _toolIdx.length;
        }
        const partial = editFailures.length > 0 && cleanedCount > 0;
        return {
          success: editFailures.length === 0,
          applied: cleanedCount > 0,
          partial,
          cleanedCount,
          totalMessages: chatLog.length,
          ...(editFailures.length ? {
            code: partial ? "E_CLEAN_XML_PARTIAL" : "E_CLEAN_XML_EDIT_FAILED",
            error: `${editFailures.length}条消息因稳定 ID 或提交确认失败未编辑`,
            editFailures,
          } : {}),
        };
      } catch (e) {
        return {
          success: false,
          applied: false,
          partial: false,
          code: e?.code || "E_CLEAN_XML_FAILED",
          error: e?.message || String(e),
        };
      }
    }

    case "exportCodeMemory": {
      try {
        const memDir = ensureMemoryDir(username, charName);
        const codeDir = path.join(memDir, "code");
        if (!fs.existsSync(codeDir)) return { success: false, error: "编程记忆目录不存在" };
        const zip = new JSZip(); let fileCount = 0;
        function addCodeDirToZip(dir, zipFolder) {
          if (!fs.existsSync(dir)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) { const fullPath = path.join(dir, entry.name); if (entry.isDirectory()) addCodeDirToZip(fullPath, zipFolder.folder(entry.name)); else if (entry.isFile()) { try { zipFolder.file(entry.name, fs.readFileSync(fullPath, "utf8")); fileCount++; } catch { /* skip */ } } }
        }
        addCodeDirToZip(codeDir, zip.folder("code"));
        const codeTablesPath = path.join(memDir, "code_tables.json");
        if (fs.existsSync(codeTablesPath)) { zip.file("code_tables.json", fs.readFileSync(codeTablesPath, "utf8")); fileCount++; }
        const zipBase64 = await zip.generateAsync({ type: "base64" });
        return { success: true, zipBase64, fileName: `beilu-code-memory_${charName}_${new Date().toISOString().slice(0, 10)}.zip`, fileCount };
      } catch (e) { return { success: false, error: `导出失败: ${e.message}` }; }
    }

    case "importCodeMemory": {
      try {
        if (!data.zipBase64) return { success: false, error: "缺少 zipBase64" };
        const memDir = ensureMemoryDir(username, charName);
        const resolvedMem = path.resolve(memDir);
        let imported = 0, skipped = 0; const errors = [];
        const binaryStr = atob(data.zipBase64); const zipBinary = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) zipBinary[i] = binaryStr.charCodeAt(i);
        const zip = await JSZip.loadAsync(zipBinary);
        for (const [relPath, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) continue;
          if (relPath.includes("..")) { errors.push(`非法路径: ${relPath}`); skipped++; continue; }
          const fullPath = path.join(memDir, relPath);
          if (!isPathSafe(fullPath, resolvedMem)) { errors.push(`路径越界: ${relPath}`); skipped++; continue; } // 0716 路径前缀边界修复：收口到 isPathSafe
          try { const dir = path.dirname(fullPath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); if (fs.existsSync(fullPath)) try { fs.copyFileSync(fullPath, fullPath + ".import_bak"); } catch { /* */ } const content = await zipEntry.async("string"); nicerWriteFileSync(fullPath, content); imported++; }
          catch (e) { errors.push(`写入失败 ${relPath}: ${e.message}`); skipped++; }
        }
        clearCharCache(username, charName);
        return { success: true, imported, skipped, errors: errors.length > 0 ? errors : undefined };
      } catch (e) { return { success: false, error: `导入失败: ${e.message}` }; }
    }

    case "readContextSummary": {
      // O17 per-chatId 隔离：透传 chatId 读本窗口摘要
      const summaryData = readContextSummary(username, charName, chatId);
      if (!summaryData) return { success: true, hasSummary: false };
      return { success: true, hasSummary: true, ...summaryData };
    }

    case "copyToCodeMemory": {
      if (!data.sourcePath) return { success: false, error: "缺少 sourcePath" };
      const _memDir = ensureMemoryDir(username, charName);
      const _activeDir = path.join(_memDir, "code", "active");
      if (!fs.existsSync(_activeDir)) fs.mkdirSync(_activeDir, { recursive: true });
      const _srcResolved = path.resolve(data.sourcePath);
      if (!fs.existsSync(_srcResolved)) return { success: false, error: `源文件不存在` };
      if (!fs.statSync(_srcResolved).isFile()) return { success: false, error: `不是文件` };
      const _targetName = data.targetFilename ? sanitizeFilename(data.targetFilename) : path.basename(_srcResolved);
      const _targetPath = path.join(_activeDir, _targetName);
      if (!isPathSafe(_targetPath, path.resolve(_activeDir))) return { success: false, error: "目标路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (fs.statSync(_srcResolved).size > 1024 * 1024) return { success: false, error: "文件过大" };
      fs.copyFileSync(_srcResolved, _targetPath);
      return { success: true, filename: _targetName };
    }

    case "createCodeFolder": {
      if (!data.folderName) return { success: false, error: "缺少 folderName" };
      const _memDir = ensureMemoryDir(username, charName);
      const _activeDir = path.join(_memDir, "code", "active");
      const _safeName = sanitizeFilename(data.folderName);
      const _folderPath = path.join(_activeDir, _safeName);
      if (!isPathSafe(_folderPath, path.resolve(_activeDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(_folderPath)) fs.mkdirSync(_folderPath, { recursive: true });
      return { success: true, folderName: _safeName };
    }

    case "moveCodeFile": {
      if (!data.sourceFile) return { success: false, error: "缺少 sourceFile" };
      const _memDir = ensureMemoryDir(username, charName);
      const _activeDir = path.join(_memDir, "code", "active");
      const _srcPath = path.join(_activeDir, data.sourceFile);
      if (!isPathSafe(_srcPath, path.resolve(_activeDir))) return { success: false, error: "源路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(_srcPath)) return { success: false, error: `源文件不存在` };
      const _targetDir = data.targetFolder ? path.join(_activeDir, sanitizeFilename(data.targetFolder)) : _activeDir;
      if (!isPathSafe(_targetDir, path.resolve(_activeDir))) return { success: false, error: "目标路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(_targetDir)) fs.mkdirSync(_targetDir, { recursive: true });
      renameSyncWithRetry(_srcPath, path.join(_targetDir, path.basename(_srcPath)));
      return { success: true };
    }

    case "listCodeFiles": {
      const _memDir = ensureMemoryDir(username, charName);
      let _targetDir = path.join(_memDir, "code", "active");
      if (data.subPath) { _targetDir = path.join(_targetDir, data.subPath); if (!isPathSafe(_targetDir, path.resolve(path.join(_memDir, "code", "active")))) return { success: false, error: "路径越界" }; } // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(_targetDir)) return { success: true, files: [] };
      const _entries = fs.readdirSync(_targetDir, { withFileTypes: true });
      const _files = _entries.map((_e) => ({ name: _e.name, isDirectory: _e.isDirectory(), size: _e.isFile() ? fs.statSync(path.join(_targetDir, _e.name)).size : null }));
      return { success: true, files: _files, path: data.subPath || "/" };
    }

    case "searchCodeFiles": {
      if (!data.query) return { success: false, error: "缺少 query" };
      const _memDir = ensureMemoryDir(username, charName);
      const _activeDir = path.join(_memDir, "code", "active");
      if (!fs.existsSync(_activeDir)) return { success: true, results: [] };
      const _results = [];
      const _regex = data.useRegex ? new RegExp(data.query, "gi") : new RegExp(data.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      async function _searchDir(_dir, _prefix) {
        const _dirEntries = fs.readdirSync(_dir, { withFileTypes: true });
        for (const _entry of _dirEntries) {
          const _fullPath = path.join(_dir, _entry.name);
          if (_entry.isDirectory()) { await _searchDir(_fullPath, _prefix ? `${_prefix}/${_entry.name}` : _entry.name); }
          else if (_entry.name.endsWith(".md")) {
            try {
              const _fileContent = await fs.promises.readFile(_fullPath, "utf-8");
              const _matches = []; let _match;
              while ((_match = _regex.exec(_fileContent)) !== null) {
                const _lineStart = _fileContent.lastIndexOf("\n", _match.index) + 1;
                const _lineEnd = _fileContent.indexOf("\n", _match.index + _match[0].length);
                _matches.push({ match: _match[0], line: _fileContent.substring(_lineStart, _lineEnd === -1 ? undefined : _lineEnd).trim(), position: _match.index });
                if (_matches.length >= 10) break;
              }
              _regex.lastIndex = 0;
              if (_matches.length > 0) _results.push({ file: _prefix ? `${_prefix}/${_entry.name}` : _entry.name, matches: _matches });
            } catch { /* ignore */ }
          }
        }
      }
      await _searchDir(_activeDir, "");
      return { success: true, results: _results, query: data.query };
    }

    case "deleteCodeFile": {
      if (!data.filePath) return { success: false, error: "缺少 filePath" };
      const _memDir = ensureMemoryDir(username, charName);
      const _activeDir = path.join(_memDir, "code", "active");
      const _fullPath = path.join(_activeDir, data.filePath);
      if (!isPathSafe(_fullPath, path.resolve(_activeDir))) return { success: false, error: "路径越界" }; // 0716 路径前缀边界修复：收口到 isPathSafe
      if (!fs.existsSync(_fullPath)) return { success: false, error: "文件不存在" };
      const _fStat = fs.statSync(_fullPath);
      if (_fStat.isDirectory()) { if (fs.readdirSync(_fullPath).length > 0) return { success: false, error: "文件夹不为空" }; fs.rmdirSync(_fullPath); }
      else { await safeUnlink(_fullPath, "IDE_deleteFile"); }
      return { success: true };
    }

    case "createSnapshot": {
      try { const { createSnapshot } = await import("../../rollback/snapshot.mjs"); return createSnapshot(__projectRoot, username, charName, ensureMemoryDir(username, charName), data.reason); }
      catch (e) { return { success: false, error: `创建快照失败: ${e.message}` }; }
    }
    case "listSnapshots": {
      try { const { listSnapshots } = await import("../../rollback/snapshot.mjs"); return { success: true, snapshots: listSnapshots(__projectRoot, username, charName) }; }
      catch (e) { return { success: false, error: `列出快照失败: ${e.message}` }; }
    }
    case "restoreSnapshot": {
      if (!data.snapshotId) return { success: false, error: "缺少 snapshotId" };
      try { const { restoreSnapshot } = await import("../../rollback/snapshot.mjs"); clearCharCache(username, charName); return restoreSnapshot(__projectRoot, username, charName, ensureMemoryDir(username, charName), data.snapshotId); }
      catch (e) { return { success: false, error: `恢复快照失败: ${e.message}` }; }
    }

    case "fetchWebPage": {
      if (!data.url) return { success: false, error: "缺少 url" };
      try {
        // SEC-T7：safeFetch 内对首跳及每个重定向 Location 都做 assertSafeUrl（防 302→内网绕过 + 全文回显）
        const controller = new AbortController();
        // T008 同类：fetchWebPage 超时 15s→8s（与 getModels 同批收窄）
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await safeFetch(data.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; beilu-memory/1.0)", Accept: "text/html,application/xhtml+xml,text/plain,application/json" }, signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
        const contentType = response.headers.get("content-type") || "";
        let text = await response.text();
        if (text.length > 100000) text = text.substring(0, 100000) + "\n\n... (截断)";
        if (contentType.includes("html")) text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return { success: true, url: data.url, contentType, content: text, contentLength: text.length };
      } catch (e) {
        // T008 同类：错误结构化
        const _reason = e.name === "AbortError" ? "请求超时（8s）" : e.message;
        return { success: false, error: `网页抓取失败: ${_reason}`, url: data.url, reason: _reason };
      }
    }

    case "readExternalFile": {
      if (getActiveMode(username, charName, _rawChatId) !== "code") return { success: false, error: "仅编程模式可用" }; // T4靶点③：门按本窗绑定模式判（char 级=误挡绑 code 的窗/放行绑 chat 的窗，沙盒已复现）
      if (!data.filePath) return { success: false, error: "缺少 filePath" };
      const _blockedPatterns = [/\.env$/i, /\.env\./i, /password/i, /secret/i, /credential/i, /\.ssh\//i, /\.gnupg\//i, /\.aws\/credentials/i, /id_rsa/i, /\.npmrc/i, /\.git-credentials/i, /\.kube\/config/i];
      if (_blockedPatterns.some((p) => p.test(data.filePath.replace(/\\/g, "/")))) return { success: false, error: "安全限制" };
      try {
        if (!fs.existsSync(data.filePath)) return { success: false, error: `文件不存在` };
        const _stat = fs.statSync(data.filePath);
        if (!_stat.isFile()) return { success: false, error: "路径不是文件" };
        if (_stat.size > 500 * 1024) return { success: false, error: "文件过大" };
        return { success: true, filePath: data.filePath, content: await fs.promises.readFile(data.filePath, "utf-8"), size: _stat.size, mtime: _stat.mtime.toISOString() };
      } catch (e) { return { success: false, error: `读取失败: ${e.message}` }; }
    }

    case "listExternalDir": {
      if (getActiveMode(username, charName, _rawChatId) !== "code") return { success: false, error: "仅编程模式可用" }; // T4靶点③：同 readExternalFile
      if (!data.dirPath) return { success: false, error: "缺少 dirPath" };
      try {
        if (!fs.existsSync(data.dirPath)) return { success: false, error: `目录不存在` };
        if (!fs.statSync(data.dirPath).isDirectory()) return { success: false, error: "路径不是目录" };
        const _entries = fs.readdirSync(data.dirPath, { withFileTypes: true });
        const _files = [], _dirs = [];
        for (const _entry of _entries) {
          if (_entry.name.startsWith(".")) continue;
          if (_entry.isDirectory()) _dirs.push(_entry.name);
          else if (_entry.isFile()) { try { _files.push({ name: _entry.name, size: fs.statSync(path.join(data.dirPath, _entry.name)).size }); } catch { _files.push({ name: _entry.name }); } }
        }
        return { success: true, dirPath: data.dirPath, files: _files.slice(0, 100), dirs: _dirs.slice(0, 50), totalFiles: _files.length, totalDirs: _dirs.length };
      } catch (e) { return { success: false, error: `列出失败: ${e.message}` }; }
    }

    // === 工作模式诊断 ===
    case "diagnoseWorkMode": {
      const _dwUser = data.username || args?.username || "_default";
      const _dwChar = data.charName || args?.char_id || "_global";
      const _dwMemDir = getMemoryDir(_dwUser, _dwChar);
      const _dwResults = [];
      const _dwPass = (msg) => _dwResults.push({ status: "✅", msg });
      const _dwFail = (msg) => _dwResults.push({ status: "❌", msg });
      const _dwWarn = (msg) => _dwResults.push({ status: "⚠️", msg });

      // 1. 检查当前模式
      const _dwMode = getActiveMode(_dwUser, _dwChar, _rawChatId); // T4靶点③：诊断按本窗模式报
      if (_dwMode === "work") _dwPass(`当前模式: work`);
      else _dwWarn(`当前模式: ${_dwMode} (非work，部分检查可能不适用)`);

      // 2. 检查work目录结构
      const _dwDirs = ["work", "work/active", "work/archive", "work/outputs", "work/workflows"];
      for (const d of _dwDirs) {
        const dp = path.join(_dwMemDir, d);
        if (fs.existsSync(dp)) _dwPass(`目录存在: ${d}`);
        else _dwFail(`目录缺失: ${d}`);
      }

      // 3. 检查 _work_config.json
      const _dwCfgPath = getWorkConfigPath(_dwUser, _dwChar); // T7 尾段收口：权威路径单点
      if (fs.existsSync(_dwCfgPath)) {
        try {
          const _dwCfg = JSON.parse(fs.readFileSync(_dwCfgPath, "utf-8"));
          _dwPass(`_work_config.json: active_workflow="${_dwCfg.active_workflow || ""}", auto_switch=${_dwCfg.auto_switch}`);
        } catch (e) { _dwFail(`_work_config.json 解析失败: ${e.message}`); }
      } else _dwFail("_work_config.json 不存在");

      // 4. 检查 _index.md
      const _dwIdxPath = path.join(_dwMemDir, "work", "active", "_index.md");
      if (fs.existsSync(_dwIdxPath)) _dwPass("active/_index.md 存在");
      else _dwWarn("active/_index.md 不存在 (首次切换到work模式后创建)");

      // 5. 检查 work_tables.json
      const _dwTablesPath = path.join(_dwMemDir, "work_tables.json");
      if (fs.existsSync(_dwTablesPath)) {
        try {
          const _dwTables = JSON.parse(fs.readFileSync(_dwTablesPath, "utf-8"));
          const _dwCount = (_dwTables?.tables || []).length;
          if (_dwCount === 4) _dwPass(`work_tables.json: ${_dwCount}张表 (W0-W3)`);
          else _dwWarn(`work_tables.json: ${_dwCount}张表 (预期4张)`);
          (_dwTables?.tables || []).forEach((t, i) => {
            _dwPass(`  W${i} "${t.name}" 列: [${(t.columns || []).join(",")}] 行数: ${(t.rows || []).length}`);
          });
        } catch (e) { _dwFail(`work_tables.json 解析失败: ${e.message}`); }
      } else _dwWarn("work_tables.json 不存在 (切换到work模式后自动创建)");

      // 6. 检查 INJ-1-work 内容
      try {
        const _dwPresetsPath = path.join(_dwMemDir, "_memory_presets.json");
        if (fs.existsSync(_dwPresetsPath)) {
          const _dwPresets = JSON.parse(fs.readFileSync(_dwPresetsPath, "utf-8"));
          const _dwInj = (_dwPresets?.injection_prompts || []).find(p => p.id === "INJ-1-work");
          if (_dwInj) {
            const _dwLen = (_dwInj.content || "").length;
            if (_dwLen > 100) _dwPass(`INJ-1-work: ${_dwLen}字符 (内容已填充)`);
            else if (_dwLen > 0) _dwWarn(`INJ-1-work: ${_dwLen}字符 (内容过短)`);
            else _dwFail("INJ-1-work: content为空");
          } else _dwWarn("INJ-1-work 条目不存在于用户数据 (将使用默认模板)");
        } else _dwWarn("_memory_presets.json 不存在 (首次创建角色后生成)");
      } catch (e) { _dwFail(`检查INJ-1-work失败: ${e.message}`); }

      // 7. 检查子模式配置
      try {
        const _dwSmPath = getYonbanConfigPath(_dwUser);
        if (fs.existsSync(_dwSmPath)) {
          const _dwSm = JSON.parse(fs.readFileSync(_dwSmPath, "utf-8"));
          const _dwWorkModes = (_dwSm.sub_modes || []).filter(m => m.modeGroup === "work");
          const _dwCodeModes = (_dwSm.sub_modes || []).filter(m => (m.modeGroup || "code") === "code");
          _dwPass(`子模式: ${_dwCodeModes.length}个code + ${_dwWorkModes.length}个work`);
          if (_dwWorkModes.length === 10) _dwPass("工作子模式数量正确 (10个)");
          else _dwWarn(`工作子模式数量: ${_dwWorkModes.length} (预期10)`);
        } else _dwWarn("yonban_config.json 不存在 (首次访问子模式后自动创建)");
      } catch (e) { _dwFail(`检查子模式失败: ${e.message}`); }

      // 8. 检查 default_memory_presets.json 模板
      try {
        const _dwDefPath = path.join(__pluginDir, "..", "beilu-memory", "default_memory_presets.json");
        if (fs.existsSync(_dwDefPath)) {
          const _dwDef = JSON.parse(fs.readFileSync(_dwDefPath, "utf-8"));
          const _dwDefInj = (_dwDef?.injection_prompts || []).find(p => p.id === "INJ-1-work");
          const _dwDefLen = (_dwDefInj?.content || "").length;
          if (_dwDefLen > 100) _dwPass(`默认模板INJ-1-work: ${_dwDefLen}字符`);
          else _dwFail(`默认模板INJ-1-work: ${_dwDefLen}字符 (模板为空或过短)`);
          // P1/P7 prompts_work
          const _dwP1 = (_dwDef?.presets || []).find(p => p.id === "P1");
          const _dwP7 = (_dwDef?.presets || []).find(p => p.id === "P7");
          if (_dwP1?.prompts_work?.length > 0) _dwPass(`P1 prompts_work: ${_dwP1.prompts_work.length}条`);
          else _dwFail("P1 缺少 prompts_work");
          if (_dwP7?.prompts_work?.length > 0) _dwPass(`P7 prompts_work: ${_dwP7.prompts_work.length}条`);
          else _dwFail("P7 缺少 prompts_work");
        }
      } catch (e) { _dwFail(`检查默认模板失败: ${e.message}`); }

      const _dwPassCount = _dwResults.filter(r => r.status === "✅").length;
      const _dwFailCount = _dwResults.filter(r => r.status === "❌").length;
      const _dwWarnCount = _dwResults.filter(r => r.status === "⚠️").length;
      return {
        success: true,
        summary: `${_dwPassCount}通过 / ${_dwFailCount}失败 / ${_dwWarnCount}警告`,
        results: _dwResults,
      };
    }

    // === 工作模式文件管理 ===
    case "createWorkFile": {
      const _wfUser = data.username || args?.username || "_default";
      const _wfChar = data.charName || args?.char_id || "_global";
      // K5：work 任务 md 在 gate 开 + 有 chatId 时下沉到 work_ctx/<chatId>/，否则原路径（向后兼容）
      const _wfMemDir = getModeCtxDir(getMemoryDir(_wfUser, _wfChar), "work", chatId);
      const _wfFilename = data.filename;
      if (!_wfFilename) return { success: false, error: "缺少 filename" };
      const _wfSubfolder = data.subfolder || "active";
      const _wfValidFolders = ["active", "outputs", "workflows"];
      if (!_wfValidFolders.includes(_wfSubfolder)) return { success: false, error: `非法目录: ${_wfSubfolder}` };
      // 防路径穿越
      if (_wfFilename.includes("..") || _wfFilename.includes("/") || _wfFilename.includes("\\")) return { success: false, error: "文件名不合法" };
      const _wfDir = path.join(_wfMemDir, "work", _wfSubfolder);
      if (!fs.existsSync(_wfDir)) fs.mkdirSync(_wfDir, { recursive: true });
      const _wfPath = path.join(_wfDir, _wfFilename);
      nicerWriteFileSync(_wfPath, data.content || "");
      return { success: true, path: `work/${_wfSubfolder}/${_wfFilename}` };
    }

    case "readWorkFile": {
      const _rwUser = data.username || args?.username || "_default";
      const _rwChar = data.charName || args?.char_id || "_global";
      const _rwMemDir = getModeCtxDir(getMemoryDir(_rwUser, _rwChar), "work", chatId);
      const _rwFilename = data.filename;
      if (!_rwFilename || _rwFilename.includes("..")) return { success: false, error: "文件名不合法" };
      const _rwSubfolder = data.subfolder || "active";
      const _rwPath = path.join(_rwMemDir, "work", _rwSubfolder, _rwFilename);
      if (!fs.existsSync(_rwPath)) return { success: false, error: "文件不存在" };
      return { success: true, content: await fs.promises.readFile(_rwPath, "utf-8") };
    }

    case "archiveWorkFile": {
      const _awUser = data.username || args?.username || "_default";
      const _awChar = data.charName || args?.char_id || "_global";
      const _awMemDir = getModeCtxDir(getMemoryDir(_awUser, _awChar), "work", chatId);
      const _awFilename = data.filename;
      if (!_awFilename || _awFilename.includes("..")) return { success: false, error: "文件名不合法" };
      const _awSrc = path.join(_awMemDir, "work", "active", _awFilename);
      if (!fs.existsSync(_awSrc)) return { success: false, error: "源文件不存在" };
      const _awNow = new Date();
      const _awYm = `${_awNow.getFullYear()}-${String(_awNow.getMonth() + 1).padStart(2, "0")}`;
      // 修8（20260716）：落点=mdArchiveDir 单源热层（凛倾「归档只可以变成文件储存在热层」；
      //   原 work/archive/YYYY-MM/ 对温层扫描/检索双重不可达=归档即消失，同 triggerP2CodeArchive 同批修）。
      //   目的地锚 char 级 memDir（非 ctx 目录）：归档=历史沉降跨窗口共享，与 hot/_table_snapshots 同域先例；
      //   源仍取 ctx（窗口隔离的 active 是写侧真身）。
      const { absDir: _awAbsDir, relPrefix: _awRel } = mdArchiveDir(getMemoryDir(_awUser, _awChar), "work", _awYm);
      if (!fs.existsSync(_awAbsDir)) fs.mkdirSync(_awAbsDir, { recursive: true });
      let _awDst = path.join(_awAbsDir, _awFilename);
      if (fs.existsSync(_awDst)) _awDst = path.join(_awAbsDir, _awFilename.replace(/\.md$/, "") + `.${Date.now()}.md`); // 同月同名碰撞防覆盖（镜像 code 侧）
      renameSyncWithRetry(_awSrc, _awDst);
      return { success: true, archived_to: `${_awRel}/${path.basename(_awDst)}` };
    }

    case "listWorkFiles": {
      const _lwUser = data.username || args?.username || "_default";
      const _lwChar = data.charName || args?.char_id || "_global";
      const _lwMemDir = getModeCtxDir(getMemoryDir(_lwUser, _lwChar), "work", chatId);
      const _lwSubfolder = data.subfolder || "active";
      const _lwDir = path.join(_lwMemDir, "work", _lwSubfolder);
      if (!fs.existsSync(_lwDir)) return { success: true, files: [] };
      const _lwFiles = fs.readdirSync(_lwDir)
        .filter(f => !f.startsWith("_"))
        .map(f => {
          try {
            const _st = fs.statSync(path.join(_lwDir, f));
            return { name: f, size: _st.size, modified: _st.mtimeMs };
          } catch { return { name: f }; }
        });
      return { success: true, files: _lwFiles };
    }

    case "getWorkStats": {
      const _wsUser = data.username || args?.username || "_default";
      const _wsChar = data.charName || args?.char_id || "_global";
      // K5：work_tables.json 在 gate 开 + 有 chatId 时读 work_ctx/<chatId>/ 下的隔离份
      const _wsMemDir = getModeCtxDir(getMemoryDir(_wsUser, _wsChar), "work", chatId);
      const _wsTablesPath = path.join(_wsMemDir, "work_tables.json");
      if (!fs.existsSync(_wsTablesPath)) return { success: true, stats: { total: 0, active: 0, completed: 0, high_priority: 0 } };
      try {
        const _wsTables = JSON.parse(await fs.promises.readFile(_wsTablesPath, "utf-8"));
        const _wsTaskTable = (_wsTables?.tables || [])[0]; // W0 = 任务原话记录
        if (!_wsTaskTable || !_wsTaskTable.rows) return { success: true, stats: { total: 0, active: 0, completed: 0, high_priority: 0 } };
        const _wsRows = _wsTaskTable.rows;
        const _wsTotal = _wsRows.length;
        // W0列: 0=任务摘要, 1=用户原话, 2=类型, 3=状态, 4=关联文档, 5=日期
        const _wsCompleted = _wsRows.filter(r => (Array.isArray(r) ? r[3] : r["3"]) === "完成").length;
        return {
          success: true,
          stats: {
            total: _wsTotal,
            active: _wsTotal - _wsCompleted,
            completed: _wsCompleted,
          },
        };
      } catch (e) { return { success: false, error: `读取失败: ${e.message}` }; }
    }

    // === 调度器管理 ===
    case "scheduler_start": {
      const _ssUser = data.username || args?.username || "_default";
      const _ssChar = data.charName || args?.char_id || "_global";
      const _ssMemDir = getMemoryDir(_ssUser, _ssChar);
      startScheduler(_ssUser, _ssChar, _ssMemDir);
      return { success: true };
    }
    case "scheduler_stop": {
      const _spUser = data.username || args?.username || "_default";
      const _spChar = data.charName || args?.char_id || "_global";
      stopScheduler(_spUser, _spChar);
      return { success: true };
    }
    case "scheduler_addJob": {
      const _ajUser = data.username || args?.username || "_default";
      const _ajChar = data.charName || args?.char_id || "_global";
      // 捕获目标会话：auto_reply/wake 到期时 dispatchActivation 据此 chatid 触发 generate（inject 不需要）
      const _ajChatid = data.chatid || data.chatId || args?.chatid ||
        (args?.chat_name ? args.chat_name.replace("common_chat_", "") : null);
      const _ajJob = data.job || data;
      return addJob(_ajUser, _ajChar, { ..._ajJob, chatid: _ajJob.chatid || _ajChatid });
    }
    case "scheduler_removeJob": {
      const _rjUser = data.username || args?.username || "_default";
      const _rjChar = data.charName || args?.char_id || "_global";
      return removeJob(_rjUser, _rjChar, data.jobId);
    }
    case "scheduler_updateJob": {
      const _ujUser = data.username || args?.username || "_default";
      const _ujChar = data.charName || args?.char_id || "_global";
      return updateJob(_ujUser, _ujChar, data.jobId, data.updates || {});
    }
    case "scheduler_toggleJob": {
      const _tjUser = data.username || args?.username || "_default";
      const _tjChar = data.charName || args?.char_id || "_global";
      return toggleJob(_tjUser, _tjChar, data.jobId, data.enabled ?? true);
    }
    case "scheduler_listJobs": {
      const _ljUser = data.username || args?.username || "_default";
      const _ljChar = data.charName || args?.char_id || "_global";
      return listJobs(_ljUser, _ljChar);
    }

    // === 异步后台AI (P4) ===
    case "runAsyncAI": {
      const _raPresetId = data.presetId; // P系列ID或自定义
      if (!_raPresetId) return { success: false, error: "缺少 presetId" };
      const _raPreset = presetsData.presets.find(p => p.id === _raPresetId);
      if (!_raPreset) return { success: false, error: `预设 ${_raPresetId} 不存在` };
      const _raCharName = args?.Charname || charName;
      const _raUserName = args?.UserCharname || username;
      const _raResult = runMemoryPresetAI_async(
        username, charName, _raPreset, memData,
        _raCharName, _raUserName,
        data.chatHistory || "",
        { taskLabel: data.taskLabel || _raPreset.name, resultType: data.resultType || "async_ai_result" },
      );
      return { success: true, ..._raResult };
    }

    case "getAsyncAITasks": {
      const _tasks = [];
      for (const [id, entry] of asyncAITasks) {
        _tasks.push({ id, status: entry.status, startedAt: entry.startedAt, completedAt: entry.completedAt || null, error: entry.error || null });
      }
      return { success: true, tasks: _tasks };
    }

    // === 启动编辑器 (P4) ===
    // [P1 2026-08-03 launch_ide 收紧（Fable 审查阻断5 根修）]
    //   ① schema：editor ∈ cursor|code|auto；projectPath 必须是已存在目录的绝对解析路径且不以 "-"
    //      开头（防被编辑器 CLI 当选项解析=参数注入面）；waitTimeout 钳 1s-120s。
    //   ② 允许域：yonban_config.launch_editor.allowed_workspaces（绝对路径前缀数组）配置后强制
    //      前缀匹配；未配置=保持本机单用户既有语义（仅基础校验），该默认已写入完成报告。
    //   ③ 返回态拆 spawned / connected(global) / ready(目标 workspace 实例已接入)：success 只表达
    //      spawn 成立；ready 才证明目标窗口就绪（按 ideClient.listLiveInstances 的 instanceId/workspace
    //      事实，不再拿"全局任意连接"冒充）；无 projectPath 时 ready 恒 false（无目标=无法证明）。
    //   ④ 本 action 只在认证 SetData 链可达（web/bridge 会话）；Bot 标签链无此通道——capability
    //      registry（launch_ide）接入并过 owner/审批门前，不对 Bot 开放。
    case "launchEditor": {
      const _leProjectRaw = typeof data.projectPath === "string" ? data.projectPath.trim() : "";
      const _leEditor = data.editor === "cursor" || data.editor === "code" ? data.editor : "auto";
      let _leProject = "";
      if (_leProjectRaw) {
        if (_leProjectRaw.startsWith("-")) {
          return { success: false, spawned: false, code: "E_LAUNCH_BAD_PATH", error: "projectPath 非法（以 - 开头会被编辑器 CLI 当作选项解析，已拒绝）" };
        }
        const _leResolved = path.resolve(_leProjectRaw);
        let _leStat = null;
        try { _leStat = fs.statSync(_leResolved); } catch { /* 不存在 → 下方拒绝 */ }
        if (!_leStat || !_leStat.isDirectory()) {
          return { success: false, spawned: false, code: "E_LAUNCH_BAD_PATH", error: `projectPath 不是已存在的目录: ${_leResolved}` };
        }
        const _leAllow = loadJsonFileIfExists(getYonbanConfigPath(username), {}).launch_editor?.allowed_workspaces;
        if (Array.isArray(_leAllow) && _leAllow.length > 0) {
          const _leNorm = (p) => { try { return path.resolve(String(p)).toLowerCase(); } catch { return ""; } };
          const _leTargetN = _leNorm(_leResolved);
          const _leHit = _leAllow.some((w) => {
            const _w = _leNorm(w);
            return _w && (_leTargetN === _w || _leTargetN.startsWith(_w.endsWith(path.sep) ? _w : _w + path.sep));
          });
          if (!_leHit) {
            return { success: false, spawned: false, code: "E_LAUNCH_WORKSPACE_DENIED", error: "projectPath 不在 launch_editor.allowed_workspaces 允许域内" };
          }
        }
        _leProject = _leResolved;
      }
      const { execSync: _leExecSync, spawn: _leSpawn } = await import("node:child_process");

      // 检测可用的编辑器
      const _leDetect = (cmd) => {
        try {
          _leExecSync(`${cmd} --version`, { stdio: "pipe", timeout: 5000 });
          return true;
        } catch { return false; }
      };

      let _leCmd = null;
      if (_leEditor === "cursor" || _leEditor === "auto") {
        if (_leDetect("cursor")) _leCmd = "cursor";
      }
      if (!_leCmd && (_leEditor === "code" || _leEditor === "auto")) {
        if (_leDetect("code")) _leCmd = "code";
      }

      if (!_leCmd) {
        return { success: false, spawned: false, error: "未检测到 Cursor 或 VSCode，请确认已安装并添加到 PATH" };
      }

      try {
        const _leArgs = _leProject ? [_leProject] : [];
        const _leProc = _leSpawn(_leCmd, _leArgs, { detached: true, stdio: "ignore" });
        _leProc.unref();
        console.log(`[beilu-memory] launchEditor: 已启动 ${_leCmd}${_leProject ? ` (${_leProject})` : ""}`);

        const { ideClient: _leIdeClient } = await import("../../../transport/ideClient.mjs");
        const _leMaxWaitRaw = Number(data.waitTimeout);
        const _leMaxWait = Number.isFinite(_leMaxWaitRaw) ? Math.min(Math.max(_leMaxWaitRaw, 1000), 120000) : 30000;
        const _lePollInterval = 1000;
        const _leNormWs = (p) => { try { return path.resolve(String(p)).toLowerCase(); } catch { return ""; } };
        const _leTargetWs = _leProject ? _leNormWs(_leProject) : "";
        const _leReadyNow = () => {
          if (!_leTargetWs) return false;
          try { return (_leIdeClient.listLiveInstances?.() || []).some((i) => i.workspace && _leNormWs(i.workspace) === _leTargetWs); } catch { return false; }
        };
        let _leWaited = 0;
        let _leReady = _leReadyNow();
        if (_leTargetWs) {
          // 有目标 workspace：等的是【目标实例】ready（per-instance 证明），非全局连接
          while (!_leReady && _leWaited < _leMaxWait) {
            await new Promise(r => setTimeout(r, _lePollInterval));
            _leWaited += _lePollInterval;
            _leReady = _leReadyNow();
          }
          if (!_leReady) console.log(`[beilu-memory] launchEditor: 目标 workspace 实例未在${_leMaxWait / 1000}秒内接入`);
        } else if (!_leIdeClient.isConnected) {
          // 无目标 workspace：保持旧全局连接等待语义（仅作 connected 信息，不冒充 ready）
          while (_leWaited < _leMaxWait) {
            await new Promise(r => setTimeout(r, _lePollInterval));
            _leWaited += _lePollInterval;
            if (_leIdeClient.isConnected) break;
          }
        }

        return {
          success: true, // 只表达 spawn 成立；消费方禁把它当 ready/succeeded（诚实语义拆分）
          spawned: true,
          editor: _leCmd,
          project: _leProject || "(无)",
          connected: _leIdeClient.isConnected, // 全局任意 IDE 连接（scope=global，不证明目标窗口）
          connectedScope: "global",
          ready: _leReady, // 目标 workspace 的实例已接入连接池；projectPath 未传=恒 false
          waitedMs: _leWaited,
        };
      } catch (e) {
        return { success: false, spawned: false, error: `启动失败: ${e.message}` };
      }
    }

    // === 工作模式委派与审批 (P3) ===
    case "getWorkApprovals": {
      const _gaMemDir = getMemoryDir(username, charName);
      const _gaPath = path.join(_gaMemDir, "work", "_approval_queue.json");
      let _gaApprovals = [];
      try { _gaApprovals = JSON.parse(await fs.promises.readFile(_gaPath, "utf-8")); } catch {}
      return { success: true, approvals: _gaApprovals.filter(a => a.status === "pending") };
    }

    case "resolveWorkApproval": {
      const { approvalId, decision, comment } = data;
      if (!approvalId) return { success: false, error: "缺少 approvalId" };
      if (!decision) return { success: false, error: "缺少 decision (approved/rejected/modified)" };
      const _raMemDir = getMemoryDir(username, charName);
      const _raPath = path.join(_raMemDir, "work", "_approval_queue.json");
      let _raItem = null;
      let _raErr = null;
      // M4：_approval_queue 的 read→modify→write 走 per-file 串行锁 + 原子 saveJsonFile，对齐紧邻 _pending_results 的口径，
      //   防并发 resolve/add 审批时裸写互相覆盖（lost-update）。
      await withFileLock(_raPath, () => {
        let _raApprovals = [];
        try { _raApprovals = JSON.parse(fs.readFileSync(_raPath, "utf-8")); } catch {}
        const _item = _raApprovals.find(a => a.id === approvalId);
        if (!_item) { _raErr = "审批项不存在"; return; }
        if (_item.status !== "pending") { _raErr = `审批项状态为 ${_item.status}，非 pending`; return; }
        _item.status = decision;
        _item.comment = comment || "";
        _item.resolvedAt = new Date().toISOString();
        saveJsonFile(_raPath, _raApprovals);
        _raItem = _item;
      });
      if (_raErr) return { success: false, error: _raErr };
      // 注入审批结果到下一轮上下文
      // ★ A3：read→push→write 走 per-file 串行锁，防与后台 AI 结果写入并发时互相覆盖（lost-update）
      const _raResultPath = path.join(_raMemDir, "work", "_pending_results.json");
      await withFileLock(_raResultPath, () => {
        let _raResults = [];
        try { _raResults = JSON.parse(fs.readFileSync(_raResultPath, "utf-8")); } catch {}
        _raResults.push({
          type: "approval_result",
          approvalId,
          decision,
          comment: comment || "",
          title: _raItem.title || _raItem.description?.slice(0, 50) || approvalId,
        });
        saveJsonFile(_raResultPath, _raResults);
      });
      console.log(`[beilu-memory] resolveWorkApproval: ${approvalId} → ${decision}`);
      // 0715 断链修：决议结果此前只写 _pending_results.json 等 GetPrompt"下一轮"注入，但无人触发
      // 下一轮=点了同意/拒绝零反馈（与 IDE 审批 0714 修复前同病）。按入队时记录的发起会话触发续轮；
      // 旧存量项无 chatid → 保持原行为（等用户发言时 GetPrompt 注入）。
      _triggerContinueAfterUserAction(_raItem.chatid || "", username);
      return { success: true, decision };
    }

    case "getWorkDelegates": {
      const _gdMemDir = getMemoryDir(username, charName);
      const _gdPath = path.join(_gdMemDir, "work", "_delegate_queue.json");
      let _gdQueue = [];
      try { _gdQueue = JSON.parse(await fs.promises.readFile(_gdPath, "utf-8")); } catch {}
      return {
        success: true,
        delegates: _gdQueue,
        active: _gdQueue.filter(d => d.status === "active"),
        completed: _gdQueue.filter(d => d.status !== "active"),
      };
    }

    case "cancelWorkDelegate": {
      const { delegateId } = data;
      if (!delegateId) return { success: false, error: "缺少 delegateId" };
      const _cdMemDir = getMemoryDir(username, charName);
      const _cdPath = path.join(_cdMemDir, "work", "_delegate_queue.json");
      let _cdQueue = [];
      try { _cdQueue = JSON.parse(await fs.promises.readFile(_cdPath, "utf-8")); } catch {}
      const _cdItem = _cdQueue.find(d => d.id === delegateId);
      if (!_cdItem) return { success: false, error: "委派不存在" };
      if (_cdItem.status !== "active") return { success: false, error: `委派状态为 ${_cdItem.status}，非 active` };
      _cdItem.status = "cancelled";
      _cdItem.completedAt = new Date().toISOString();
      nicerWriteFileSync(_cdPath, JSON.stringify(_cdQueue, null, 2));
      console.log(`[beilu-memory] cancelWorkDelegate: ${delegateId}`);
      return { success: true };
    }

    case "clearWorkQueues": {
      const _cqMemDir = getMemoryDir(username, charName);
      const _cqDlgPath = path.join(_cqMemDir, "work", "_delegate_queue.json");
      const _cqAprPath = path.join(_cqMemDir, "work", "_approval_queue.json");
      const _cqResPath = path.join(_cqMemDir, "work", "_pending_results.json");
      try { saveJsonFile(_cqDlgPath, []); } catch (e) { console.warn("[setData] clearWorkQueues delegate:", e?.message); }
      try { await withFileLock(_cqAprPath, () => saveJsonFile(_cqAprPath, [])); } catch (e) { console.warn("[setData] clearWorkQueues approval lock:", e?.message); }
      try { await withFileLock(_cqResPath, () => saveJsonFile(_cqResPath, [])); } catch (e) { console.warn("[setData] clearWorkQueues results lock:", e?.message); }
      console.log(`[beilu-memory] clearWorkQueues: 已清空委派/审批/结果队列`);
      return { success: true };
    }

    // === 子模式动态管理 ===
    case "getSubModes": {
      const smUser = args?.username || data.username || "_default";
      // T4 收口：getSubModes 的「初始化默认 + W64 迁移」整段 read-modify-write 走 updateYonbanConfig
      //   串行锁。建预设 helper 已提升为模块级 _ensureSubModePresetsFor（0731 002"没有新建预设"根修：
      //   原定义困在本 case 且只在初始化/迁移分支被调 → schema 达标的纯读路径与 saveSubModes 新增条目
      //   永远不建预设=「成员即有预设」不变式只在首次初始化成立一次。现 saveSubModes 写入后同步补建）。
      const _ensureSubModePresets = (subModes) => _ensureSubModePresetsFor(smUser, subModes);
      // [0720 框架归位·数据版本门] 盘上 sub_modes_schema 达标=纯读返回(写不变式由 saveSubModes
      //   的 D4 写路径归一维持,读盘每次拿各写口最新值);低版本/空配置才进下方一次性迁移写路径。
      let _gsmConfig = loadJsonFileIfExists(getYonbanConfigPath(smUser), { sub_modes: [], active_sub_mode: "前置任务专家" });
      if ((_gsmConfig.sub_modes_schema ?? 0) < SUB_MODES_SCHEMA || !Array.isArray(_gsmConfig.sub_modes) || _gsmConfig.sub_modes.length === 0) {
      await updateYonbanConfig(smUser, (smConfig) => {
        if (!smConfig.sub_modes || smConfig.sub_modes.length === 0) {
          smConfig.sub_modes = [...structuredClone(DEFAULT_CODE_SUB_MODES), ...structuredClone(DEFAULT_WORK_SUB_MODES)];
          smConfig.active_sub_mode = "前置任务专家";
        }
        // W64: 数据迁移 — 旧ID映射 + 补齐modeGroup + 补充缺失子模式 + 去重
        {
          let _migrated = false;
          // 旧ID→新ID映射（后端storage.mjs旧版定义→前端subModePanel.mjs统一ID）
          const _oldToNew = {
            // [0724 schema4] code组重组：确认师并入前置任务专家、错误生产+测试并为链路审计专家、
            //   全组id中文化。更早架构名直达最终id（一次循环只映射一跳，禁止链式落死id）。
            "architect": "前置任务专家", "framework-review": "框架审查员",
            "code-impl": "代码专家", "error-precheck": "链路审计专家",
            "testing": "链路审计专家", "bugfix": "纠错专家",
            "task-confirm": "前置任务专家", "pre-designer": "前置任务专家",
            "frame-reviewer": "框架审查员", "algorithm": "算法与推演专家",
            "code-expert": "代码专家", "pre-error": "链路审计专家",
            "test-expert": "链路审计专家", "debug-expert": "纠错专家",
            "handover": "任务交接员", "frontend-design": "前端美化",
            "large-project": "大项目协调",
            "ppt-designer": "前置任务专家",
            // 旧工作模式ID→带work-前缀的新ID
            "task-design": "work-task-design", "flow-optimize": "work-flow-optimize",
            "prompt-design": "work-prompt-design", "skill-build": "work-skill-script",
            "flow-assemble": "work-flow-assemble", "flow-execute": "work-flow-execute",
            "verify": "work-verify", "wrap-up": "work-wrapup",
          };
          // 0.9 [0724 schema4] 先分流work旧task-confirm（表内 "task-confirm"→中文code id，
          //   work项必须先走，否则被误映射进code组），再整体剔除code组旧英文id项——
          //   剔除后段4按新 DEFAULT_CODE_SUB_MODES（中文id）补齐全新项，presetName/desc 随新表，
          //   不留"新id旧presetName"半迁移项。
          for (const sm of smConfig.sub_modes) {
            if (sm.id === "task-confirm" && sm.modeGroup === "work") {
              sm.id = "work-task-confirm";
              _migrated = true;
            }
          }
          {
            const _removedIds2 = new Set(["task-confirm", "pre-designer", "frame-reviewer", "algorithm",
              "code-expert", "pre-error", "test-expert", "debug-expert", "handover", "frontend-design",
              "large-project", "ppt-designer"]);
            const _beforeLen2 = smConfig.sub_modes.length;
            smConfig.sub_modes = smConfig.sub_modes.filter(sm => !_removedIds2.has(sm.id));
            if (smConfig.sub_modes.length !== _beforeLen2) _migrated = true;
          }
          // 1. 映射旧ID到新ID（sub_modes 里旧code项已剔除，此循环实际服务更早架构名与漏网项）
          for (const sm of smConfig.sub_modes) {
            if (_oldToNew[sm.id]) {
              console.log(`[beilu-memory] getSubModes迁移: ${sm.id} → ${_oldToNew[sm.id]}`);
              sm.id = _oldToNew[sm.id];
              _migrated = true;
            }
          }
          // [五类病灶审计 2026-07-12 F3] per-chat 激活映射同步迁移：原 W64 只迁 sub_modes[].id 与
          //   全局字段，active_sub_modes_map 的值仍是旧ID（architect 等）——老会话
          //   resolveActiveSubModeId 返回死ID，label 反查空/子模式默认预设应用 miss。
          //   注：map 值无 modeGroup 上下文，code 起点现为 "前置任务专家"（schema4 中文id），仅映射 _oldToNew 表。
          if (smConfig.active_sub_modes_map) {
            for (const _k of Object.keys(smConfig.active_sub_modes_map)) {
              const _v = smConfig.active_sub_modes_map[_k];
              if (_oldToNew[_v]) {
                console.log(`[beilu-memory] getSubModes迁移(per-chat ${_k}): ${_v} → ${_oldToNew[_v]}`);
                smConfig.active_sub_modes_map[_k] = _oldToNew[_v];
                _migrated = true;
              }
            }
          }
          // 2. 去重（按ID保留第一个）
          const _seenIds = new Set();
          const _deduped = [];
          for (const sm of smConfig.sub_modes) {
            if (!_seenIds.has(sm.id)) {
              _seenIds.add(sm.id);
              _deduped.push(sm);
            } else {
              _migrated = true;
            }
          }
          smConfig.sub_modes = _deduped;
          // 3. 给无modeGroup的子模式补上
          const _workIds = new Set(DEFAULT_WORK_SUB_MODES.map(m => m.id));
          for (const sm of smConfig.sub_modes) {
            if (!sm.modeGroup) {
              if (_workIds.has(sm.id)) { sm.modeGroup = "work"; _migrated = true; }
              else { sm.modeGroup = "code"; _migrated = true; }
            }
          }
          // 4. 补充缺失的编程子模式
          const _existingIds = new Set(smConfig.sub_modes.map(m => m.id));
          for (const defaultCm of DEFAULT_CODE_SUB_MODES) {
            if (!_existingIds.has(defaultCm.id)) {
              smConfig.sub_modes.push(structuredClone(defaultCm));
              _migrated = true;
            }
          }
          // 5. 补充缺失的工作子模式
          for (const defaultWm of DEFAULT_WORK_SUB_MODES) {
            if (!_existingIds.has(defaultWm.id)) {
              smConfig.sub_modes.push(structuredClone(defaultWm));
              _migrated = true;
            }
          }
          // 5.5 [0722 schema 3] 凛倾撤销求职助手/股票分析场景子模式：schema 2 曾经段5 union 进
          //   存量用户配置，默认表删除管不到已落盘数据——此处按 id 剔除；激活指针（全局
          //   active_sub_mode(_work) 与 per-chat map）指向被删项时归位起点子模式，防死ID悬空。
          {
            const _removedIds = new Set(["work-job-hunt", "work-stock"]);
            const _beforeLen = smConfig.sub_modes.length;
            smConfig.sub_modes = smConfig.sub_modes.filter(sm => !_removedIds.has(sm.id));
            if (smConfig.sub_modes.length !== _beforeLen) _migrated = true;
            if (_removedIds.has(smConfig.active_sub_mode_work)) { smConfig.active_sub_mode_work = "work-task-confirm"; _migrated = true; }
            if (_removedIds.has(smConfig.active_sub_mode)) { smConfig.active_sub_mode = "前置任务专家"; _migrated = true; }
            if (smConfig.active_sub_modes_map) {
              for (const _k of Object.keys(smConfig.active_sub_modes_map)) {
                if (_removedIds.has(smConfig.active_sub_modes_map[_k])) { smConfig.active_sub_modes_map[_k] = "work-task-confirm"; _migrated = true; }
              }
            }
          }
          // 6. 建预设移到锁外统一执行（见下方 _ensureSubModePresets）——不在锁内做 preset 文件 IO。
          // ⚠ FIX: 原来先保存再修正 active_sub_mode，导致修正值不持久化
          if (_oldToNew[smConfig.active_sub_mode]) {
            smConfig.active_sub_mode = _oldToNew[smConfig.active_sub_mode];
            _migrated = true;
          }
          if (_oldToNew[smConfig.active_sub_mode_work]) {
            smConfig.active_sub_mode_work = _oldToNew[smConfig.active_sub_mode_work];
            _migrated = true;
          }
          if (!smConfig.active_sub_mode_work) {
            smConfig.active_sub_mode_work = "work-task-confirm";
            _migrated = true;
          }
          // 7. [D3 0804 schema 5] 存量条目写门归一（单源 normalizeSubModeForSave，与 saveSubModes
          //    写路径同一实现）：contract 剥除 + schemaVersion:2 + fallbackPolicy 默认 + 驼峰别名归位 +
          //    flat↔nested 缺侧同步；双侧真冲突只标 _profile_conflicts（不静默挑选，读侧维持嵌套优先）。
          //    幂等可重复执行，不覆盖用户显式值——版本门只保证至少跑过一次。
          {
            const _n5Conflicts = [];
            for (const sm of smConfig.sub_modes) {
              if (!sm) continue;
              normalizeSubModeForSave(sm, _workIds);
              if (Array.isArray(sm._profile_conflicts) && sm._profile_conflicts.length) _n5Conflicts.push(`${sm.id}[${sm._profile_conflicts.join(",")}]`);
            }
            _migrated = true; // schemaVersion 字段写入即变更
            if (_n5Conflicts.length) console.warn(`[beilu-memory] getSubModes 迁移(schema5): flat/nested 冲突已标记不静默挑选: ${_n5Conflicts.join(" ")}`);
          }
          if (_migrated) console.log(`[beilu-memory] getSubModes: 数据迁移完成 (${smConfig.sub_modes.length}个子模式)`);
        }
        smConfig.sub_modes_schema = SUB_MODES_SCHEMA; // 迁移完成标记写进数据本身=版本门关闭
        _gsmConfig = smConfig;
        return smConfig; // 版本号推进即变更,必落盘（只发生在低版本首遇一次）
      }, { sub_modes: [], active_sub_mode: "前置任务专家" });
      // 锁外统一补齐缺失预设（对最终 sub_modes；幂等；[0804] 补齐=触发官方播种，不再造骨架）
      try {
        const _seeded = await _ensureSubModePresets(_gsmConfig.sub_modes || []);
        if (_seeded > 0) console.log(`[beilu-memory] getSubModes: 经官方播种补齐 ${_seeded} 个缺失预设引用`);
      } catch (e) { console.warn(`[beilu-memory] getSubModes: 预设播种补齐失败: ${e.message}`); }
      } // 数据版本门结束（建预设跟随迁移一跑;预设文件缺失另有解析层回退,不做每请求自愈）
      const smConfig = _gsmConfig;
      // [隔离架构 2026-07-25 双源收口] 原 using_preset 产出已删——它是 beilu-preset 激活预设的跨域
      //   第二解析源（0708 顶栏专用），前端顶栏 0724 已收口改读 beilu-preset GetData 的
      //   active_preset_resolved 单源，全根 grep 零消费点=孤儿产者（凛倾「删除=纯删除」，只删本字段）。
      //   current_mode 保留（getActiveMode 后端权威，禁前端拿 localStorage 模式自行解析）。
      const _rpUser = data.username || args?.username || "_default";
      const _rpChatId = data.chatId || data.chat_id || args?.chatid || null; // 键收口 2026-07-13：补会话上下文兜底（桥 scope.chatId→args.chatid），effective_sub_modes 按请求会话解析
      let _rpCurMode = "chat";
      try {
        // [0717 预设三症·R1 归位] charName 缺省经 _resolveRequestChar 按 chat 元数据归位（0714 收口函数）——
        //   原直落 "_global" 桶：同 cid 在 _global 与 char 桶的 active_modes_map 可互相矛盾（盘上实证
        //   vsi2z4bs8e code/work 分叉）。
        _rpCurMode = getActiveMode(_rpUser, await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global"), _rpChatId);
      } catch (_rpErr) { console.warn(`[beilu-memory] getSubModes current_mode 解析失败: ${_rpErr.message}`); }
      // [键收口 2026-07-13] effective_sub_modes：后端 resolveActiveSubModeId 按请求 chatId 算好的
      //   「当前生效子模式」单源下发——前端（airp/preset.mjs 等只读展示口）直接消费，不再各自
      //   镜像解析链（原前端两份副本与后端三方同构，语义漂移即出口不同步病根之一）。
      return { success: true, sub_modes: smConfig.sub_modes || [], active_sub_mode: smConfig.active_sub_mode || "前置任务专家", active_sub_mode_work: smConfig.active_sub_mode_work || "work-task-confirm", active_sub_modes_map: smConfig.active_sub_modes_map || {}, parallel_sub_modes: smConfig.parallel_sub_modes || [], effective_sub_modes: { code: resolveActiveSubModeId(smConfig, "code", _rpChatId), work: resolveActiveSubModeId(smConfig, "work", _rpChatId) }, current_mode: _rpCurMode, param_schema: PARAM_SCHEMA, enum_schema: ENUM_SCHEMA };
    }

    case "saveSubModes": {
      const smUser = data.username || args?.username || "_default";
      // T4 收口：读改写走 updateYonbanConfig 串行锁（saveJsonFile 自带目录创建，原 mkdir 冗余可删）
      // [D4 0713] 写路径归一 modeGroup（与本文件 getSubModes W64 迁移 step3 同规则）：存储不变式
      //   「每条 sub_mode 必有 modeGroup」原只在读路径保证，YonBan/旧调用方经本 verb 写入缺字段条目
      //   会在"写入后→下次 getSubModes 前"的窗口漏出——两侧归一后消费方无需再各自 `|| "code"` 防御。
      const _smWorkIds = new Set(DEFAULT_WORK_SUB_MODES.map((m) => m.id));
      const smConfig = await updateYonbanConfig(smUser, (smConfig) => {
        if (Array.isArray(data.sub_modes)) {
          for (const sm of data.sub_modes) {
            // [D3 0804] 写门归一收口 normalizeSubModeForSave 单源：modeGroup 归一（原 D4 规则）+
            //   contract 剥除（RC11 断点1 存量清洗）+ schemaVersion:2 + fallbackPolicy 默认 fail_closed +
            //   flat↔nested 缺侧同步（消"旧入口只改一份"漂移）+ 真冲突标 _profile_conflicts 不静默挑选。
            if (sm) normalizeSubModeForSave(sm, _smWorkIds);
          }
          smConfig.sub_modes = data.sub_modes;
        }
        return smConfig;
      }, { sub_modes: [], active_sub_mode: "前置任务专家" });
      await _ensureSubModePresetsFor(smUser, smConfig.sub_modes || []); // 写入即补齐缺失预设引用（[0804] 补齐=触发官方播种，非 builtin 缺失只警告不造骨架）
      // [D3 0804] 预设引用只读校验（播种复查后仍缺=非 builtin 悬空引用）：可见回传不静默——
      //   配置本体已保存（其余子模式不陪葬），code=E_PRESET_REFERENCE_MISSING + 清单供前端提示
      //   用户显式创建/改选（禁造骨架，D2 只读 API 就绪后改消费其 outcome）。
      const _smMissingRefs = listMissingPresetReferences(smUser, smConfig.sub_modes || []);
      // _subModesChanged：上层（memory/main.mjs SetData 路由）据此广播 subModesConfigChanged，
      //   通知本体/YonBan 各客户端重拉（修"配置变更零推送"同步断链）。同 _subModeSwitch 信号范式。
      return {
        success: true, sub_modes: smConfig.sub_modes, _subModesChanged: true,
        ...(_smMissingRefs.length ? { code: "E_PRESET_REFERENCE_MISSING", invalid_preset_references: _smMissingRefs } : {}),
      };
    }

    case "deleteSubMode": {
      // [0720 凛倾「没办法删除子模式」] 子模式本体删除 verb(原只有 saveSubModes 整表覆盖零级联)。
      //   级联清理(子模式域全链侦察 20260720 点3 六处引用):①sub_modes 表 ②active_sub_mode/
      //   active_sub_mode_work 指针(指向被删→回退组起点默认) ③active_sub_modes_map per-chat 值
      //   ④parallel_sub_modes 触发栏快捷位 ⑤当前 char 的 workflows/*.json steps(锁外文件级;
      //   其他 char 的组文件不跨域清,消费端 _renderGroupDetail 已对悬空步 filter(Boolean) 韧性丢弃)
      //   ⑥绑定预设文件不删(预设域闭案+可能被其他子模式/用户共用)。
      //   恢复默认语义自洽:删默认项后「恢复默认」=出厂重置会重建,用户自建项删后不复活。
      const _dsUser = data.username || args?.username || "_default";
      const _dsId = data.id;
      if (!_dsId) return { success: false, error: "缺少 id" };
      let _dsFound = false;
      const _dsCfg = await updateYonbanConfig(_dsUser, (cfg) => {
        const _before = (cfg.sub_modes || []).length;
        cfg.sub_modes = (cfg.sub_modes || []).filter((m) => m.id !== _dsId);
        _dsFound = cfg.sub_modes.length < _before;
        if (!_dsFound) return SKIP_SAVE;
        if (cfg.active_sub_mode === _dsId) cfg.active_sub_mode = "前置任务专家";
        if (cfg.active_sub_mode_work === _dsId) cfg.active_sub_mode_work = "work-task-confirm";
        if (cfg.active_sub_modes_map) {
          for (const _k of Object.keys(cfg.active_sub_modes_map)) {
            if (cfg.active_sub_modes_map[_k] === _dsId) {
              delete cfg.active_sub_modes_map[_k];
              if (cfg.sub_mode_activations) delete cfg.sub_mode_activations[_k];
            }
          }
        }
        if (cfg.sub_mode_activations) {
          for (const _k of Object.keys(cfg.sub_mode_activations)) {
            if (cfg.sub_mode_activations[_k]?.subModeId === _dsId) delete cfg.sub_mode_activations[_k];
          }
        }
        if (Array.isArray(cfg.parallel_sub_modes)) cfg.parallel_sub_modes = cfg.parallel_sub_modes.filter((p) => p.id !== _dsId);
        return cfg;
      }, { sub_modes: [], active_sub_mode: "前置任务专家" });
      if (!_dsFound) return { success: false, error: `子模式ID不存在: ${_dsId}` };
      // ⑤当前 char 的流程组文件级联(锁外:workflows 文件非 yonban_config;charName 缺省时跳过,如实非致命)
      try {
        const _dsChar = data.charName || args?.char_id || null;
        if (_dsChar) {
          const _dsWfDir = path.join(getMemoryDir(_dsUser, _dsChar), "work", "workflows");
          if (fs.existsSync(_dsWfDir)) {
            for (const _fn of fs.readdirSync(_dsWfDir).filter((f) => f.endsWith(".json"))) {
              const _fp = path.join(_dsWfDir, _fn);
              const _wf = loadJsonFileIfExists(_fp, null);
              if (Array.isArray(_wf?.steps) && _wf.steps.some((s) => s?.mode === _dsId)) {
                _wf.steps = _wf.steps.filter((s) => s?.mode !== _dsId);
                saveJsonFile(_fp, _wf);
              }
            }
          }
        }
      } catch (e) { console.warn(`[beilu-memory] deleteSubMode 流程组级联清理失败(非致命): ${e.message}`); }
      console.log(`[beilu-memory] deleteSubMode: 已删除 ${_dsId} 并级联清理引用`);
      return { success: true, sub_modes: _dsCfg?.sub_modes || [], _subModesChanged: true };
    }

    case "setCardWorkspaceRoot": {
      // 一窗一线：设置某角色卡的项目根（per-卡 workspace_root，存卡 memory/_config.json）。
      //   未绑组的线 worker 以此为 isolate 内 setWorkspaceRootOverride 的源 → 每卡跑各自项目根。
      const _cwChar = data.charName || args?.char_id;
      if (!_cwChar) return { success: false, error: "缺少 charName" };
      return setCardWorkspaceRoot(username, _cwChar, data.root);
    }
    case "getCardWorkspaceRoot": {
      const _cwChar2 = data.charName || args?.char_id;
      if (!_cwChar2) return { success: false, error: "缺少 charName" };
      return { success: true, workspace_root: getCardWorkspaceRoot(username, _cwChar2) };
    }
    // [D3 0804] 三入口统一的显式激活 verb（UI 目标入口）：一次请求完成
    //   跨组模式切换（内部重入既有 switchMode 管线——scheduler 启停 + beilu-files setMode 扇出 +
    //   mode_changed 广播全套复用，禁造第二套扇出）+ 子模式激活单事务（activateSubModeCore）+
    //   默认预设应用，返回完整 activation 快照。原 UI 两次 HTTP（switchModeTo→setActiveSubMode）
    //   的半失败窗口由此消除（RC11 断点3）。
    case "activateSubMode": {
      const _avUser = args?.username || data.username || "_default";
      const _avChatId = data.chatId || data.chatid || args?.chatid || "";
      if (!data.id) return { success: false, error: "缺少 id" };
      const _avChar = await _resolveRequestChar(data, args, data.charName || args?.char_id || "_global");
      // 跨组 switchMode 有调度器/文件/广播副作用。先以只读门禁完成 owner、primaryCharName、
      // 子模式存在性和旧映射组冲突校验；此处不要求“当前模式已是目标组”，因为下一步就是受控切换。
      const _avPreflight = await preflightSubModeActivation({
        username: _avUser,
        charName: _avChar === "_global" ? "" : _avChar,
        chatId: _avChatId,
        subModeId: data.id,
        requireCurrentMode: false,
      });
      if (!_avPreflight.success) return _avPreflight;
      const _avGroup = _avPreflight.modeGroup;
      const _avVerifiedChar = _avPreflight.charName || _avChar;
      const _avCurMode = getActiveMode(_avUser, _avVerifiedChar, _avChatId || null);
      let _avModeSwitched = false;
      if (_avGroup !== _avCurMode) {
        // [0808 模式=窗口身份] windowToken 透传：跨组切换的 mode_changed 广播带发起窗口令牌，
        //   该窗 _beiluApplyModeFromWs 识别为本窗回流才翻转 UI（subModePanel 依赖此回流对齐模式态）。
        const _avSwitch = await handleSetData({ _action: "switchMode", mode: _avGroup, chatid: _avChatId || undefined, charName: _avVerifiedChar, tab: data.tab, windowToken: data.windowToken }, args);
        if (!_avSwitch?.success) {
          // 模式切换失败=整体中止，子模式未激活。owner/角色/目标实体/旧 map 跨组冲突等
          // 确定性失败已在切换前排除；切换后的 core 仍基于最新态复核，拒绝并发变化。
          return { success: false, code: "E_MODE_SWITCH_FAILED", error: `跨组模式切换失败: ${_avSwitch?.error || "未知错误"}（子模式未激活）` };
        }
        _avModeSwitched = true;
      }
      const _avRes = await activateSubModeCore({
        username: _avUser,
        charName: _avVerifiedChar === "_global" ? "" : _avVerifiedChar,
        chatId: _avChatId,
        subModeId: data.id,
        source: "ui",
      });
      if (!_avRes.success) return { success: false, error: _avRes.error, ...(_avRes.code ? { code: _avRes.code } : {}), mode_switched: _avModeSwitched };
      return {
        success: true,
        activation: _avRes.activation,
        mode_switched: _avModeSwitched,
        modeGroup: _avRes.modeGroup,
        preset_applied: _avRes.presetApplied,
        active_sub_mode: _avRes.active_sub_mode,
        active_sub_mode_work: _avRes.active_sub_mode_work,
        active_sub_modes_map: _avRes.active_sub_modes_map,
        _subModeSwitch: _avRes.event,
      };
    }

    case "setActiveSubMode": {
      const smUser = data.username || args?.username || "_default";
      const _smChatId = data.chatId || args?.chatid || "";
      if (data.id) {
        // [D3 0804] compatibility adapter：整段事务收口 activateSubModeCore（storage_mod/subModeActivation.mjs
        //   唯一 owner——单事务提交 map+版本化 activation 记录，chat fail-closed 校验，锁外 preset 默认应用）。
        //   响应形状与旧版逐键等价（active_sub_mode* 三键 + _subModeSwitch 事件体走 main.mjs 既有广播链），
        //   另附 activation 快照 + preset_applied 如实回传。原内联 T4 事务整块删除（第二实现镜像清零）。
        const _saChar = await _resolveRequestChar(data, args, data.charName || args?.char_id || "");
        const _saRes = await activateSubModeCore({
          username: smUser,
          charName: _saChar === "_global" ? "" : _saChar,
          chatId: _smChatId,
          subModeId: data.id,
          source: "ui",
        });
        if (!_saRes.success) {
          return { success: false, error: _saRes.error || `子模式ID不存在: ${data.id}`, ...(_saRes.code ? { code: _saRes.code } : {}), active_sub_mode: _saRes.active_sub_mode };
        }
        return {
          success: true,
          active_sub_mode: _saRes.active_sub_mode,
          active_sub_mode_work: _saRes.active_sub_mode_work,
          active_sub_modes_map: _saRes.active_sub_modes_map,
          activation: _saRes.activation,
          preset_applied: _saRes.presetApplied,
          _subModeSwitch: _saRes.event, // 事件体单源=buildSubModeSwitchEvent（core 内构造，键收口契约不变）
        };
      }
      // 清除线级覆盖（0723 bot 子模式：面板「无覆盖」选项）：删 active_sub_modes_map[chatId]，
      //   该线回到 resolveActiveSubModeId 无记录默认（bot=""无覆盖 / code/work=组起点）。通用不限组。
      if (data.clear && _smChatId) {
        const _clChar = await _resolveRequestChar(data, args, data.charName || args?.char_id || "");
        const _clRes = await deactivateSubModeCore({
          username: smUser,
          charName: _clChar === "_global" ? "" : _clChar,
          chatId: _smChatId,
          expectedSubModeId: String(data.expectedId || "").trim(),
        });
        if (!_clRes.success) return _clRes;
        // 调用方显式声明“回到承载对话 AIRP”时，一并清掉进入该子模式时写下的线级预设。
        // 默认不清，保持通用 setActiveSubMode 的既有语义；陪伴专属开关会传 clearPreset=true。
        let _clPresetCleared = false;
        if (data.clearPreset === true && _clRes.cleared === true) {
          try {
            _clPresetCleared = await clearPresetOverrideViaAPI(
              { username: smUser },
              _smChatId,
              data.modeGroup || "chat",
            );
          } catch (e) {
            console.warn(`[beilu-memory] 清除子模式预设覆盖失败: ${e?.message || e}`);
          }
        }
        return {
          success: true,
          cleared: _clRes.cleared,
          conflict: _clRes.conflict,
          actual_sub_mode: _clRes.actualSubModeId,
          active_sub_modes_map: _clRes.active_sub_modes_map,
          preset_cleared: _clPresetCleared,
        };
      }
      // 无 data.id：纯读当前态返回（原顶层 load 的只读用途，此分支不写盘）
      const _saNoIdCfg = loadJsonFileIfExists(getYonbanConfigPath(smUser), { sub_modes: [], active_sub_mode: "前置任务专家" });
      return { success: true, active_sub_mode: _saNoIdCfg.active_sub_mode, active_sub_mode_work: _saNoIdCfg.active_sub_mode_work || "work-task-confirm", active_sub_modes_map: _saNoIdCfg.active_sub_modes_map || {} };
    }

    case "addParallelSubMode": {
      const _apUser = data.username || args?.username || "_default";
      const _apId = data.id;
      if (!_apId) return { success: false, error: "缺少 id" };
      // T4 收口：读改写走 updateYonbanConfig 串行锁。原「已存在则不 save 直接返回」语义保留——
      //   mutator 命中已存在时返回哨兵字段让下方跳过（updateYonbanConfig 无 SKIP_SAVE 但此处即使重写相同
      //   数组内容也字段等价；为严格等价用 _apExisted 标记，命中即不 push=数组不变=落盘内容相同）。
      const _apLinks = await updateYonbanConfig(_apUser, (_apCfg) => {
        if (!Array.isArray(_apCfg.parallel_sub_modes)) _apCfg.parallel_sub_modes = [];
        if (!_apCfg.parallel_sub_modes.some(p => p.id === _apId)) {
          const _apMode = (_apCfg.sub_modes || []).find(m => m.id === _apId);
          _apCfg.parallel_sub_modes.push({ id: _apId, label: _apMode?.label || _apId, icon: _apMode?.icon || "" });
        }
        return _apCfg.parallel_sub_modes;
      }, { sub_modes: [], parallel_sub_modes: [] });
      return { success: true, parallel_sub_modes: _apLinks };
    }

    case "removeParallelSubMode": {
      const _rpUser = data.username || args?.username || "_default";
      // T4 收口：读改写走 updateYonbanConfig 串行锁
      const _rpLinks = await updateYonbanConfig(_rpUser, (_rpCfg) => {
        if (!Array.isArray(_rpCfg.parallel_sub_modes)) _rpCfg.parallel_sub_modes = [];
        _rpCfg.parallel_sub_modes = _rpCfg.parallel_sub_modes.filter(p => p.id !== data.id);
        return _rpCfg.parallel_sub_modes;
      }, { parallel_sub_modes: [] });
      return { success: true, parallel_sub_modes: _rpLinks };
    }

    // === 角色卡永久链路（T030 期D，凛倾 2026-07-05「用户自己添加角色卡=增加一个永久的链路」）===
    // 【why 落 yonban_config per-user】链路维度=角色卡（charName），生命周期=永久（加卡建链、删卡才断，
    //   点×收起视图态不删链路）。物理存 per-user 的 yonban_config.permanent_char_links[]（跟随
    //   parallel_sub_modes 同范式：per-user 单文件里的 charName 数组），侵入最小且与既有 map 字段一致
    //   （active_sub_modes_map / parallel_sub_modes / clones 均在此文件）；不为每张卡另建目录元数据文件。
    //   与前端「_openWindows 临时 chatid Set」的最大差集正在此收口：那是对话标签视图态，此为角色卡永久链路。
    case "getCharLinks": {
      const _clUser = data.username || args?.username || "_default";
      const _clPath = getYonbanConfigPath(_clUser);
      const _clCfg = loadJsonFileIfExists(_clPath, { permanent_char_links: [] });
      if (!Array.isArray(_clCfg.permanent_char_links)) _clCfg.permanent_char_links = [];
      return { success: true, permanent_char_links: _clCfg.permanent_char_links };
    }

    case "addCharLink": {
      // 加卡=建永久链路。charName 权威取值同 handler 顶部 :781（data.charName || args?.char_id）。
      // 落盘逻辑单源在 storage.addPermanentCharLink（create-char/import-char 端点自动建链共用同一函数）。
      const _alUser = data.username || args?.username || "_default";
      const _alChar = data.charName || args?.char_id || "";
      return await addPermanentCharLink(_alUser, _alChar); // T4：now async（updateYonbanConfig 串行锁），await 解开 Promise 供 SetData 路由返回
    }

    case "removeCharLink": {
      // 移除链路=显式断链（前端二次确认后调用）；不是点×收起（收起是纯前端视图态，不进此路径）。
      // 落盘逻辑单源在 storage.removePermanentCharLink（delete-char 端点删卡自动断链共用同一函数）。
      const _dlUser = data.username || args?.username || "_default";
      const _dlChar = data.charName || args?.char_id || "";
      return await removePermanentCharLink(_dlUser, _dlChar); // T4：now async（updateYonbanConfig 串行锁）
    }

    // === 分身AI管理 (W65) ===

    case "getClones": {
      // A4 username 权威化：username 来源=登录态(main.mjs 路由层 _getUserByReq 注入)。
      // 解析失败时不再静默回退 "_default"（会读到无 clones 的目录→空列表装正常），直接返回 error 让前端可见报错。
      const _clUser = data.username || args?.username;
      if (!_clUser) {
        return { success: false, error: "未能识别登录用户名（username 解析失败），无法加载分身列表，请重新登录后重试。" };
      }
      // 全键 false 基线（14 权限键与 live yonban_config.json / 前端 permissions 结构完全一致），
      // 各分身按职能只翻转所需键为 true。write_md 统一放开=true（分身产报告是常态，前后端默认统一）。
      // maxContext=1000000 / maxTokens=60000 为凛倾 2026-07-07 指定（上下文100万，最大输出6w）。
      // 07-09 收口审计：_base/_readMd 提出 if 块——除默认分身初始化外，还作 clone_template 随响应下发
      //   （前端新建分身表单的默认值单源；原前端写死 7 键旧结构+maxTokens=4096 与本处 14 键+60000 分叉）。
      const _base = { read_file: false, list_files: false, search_files: false, search_by_name: false, get_diagnostics: false, get_status: false, run_command: false, write_md: false, write_code: false, delete: false, github_upload: false, fuzzy_edit: false, replace_lines: false, insert_at_line: false };
      // 只读+写MD 职能基线（审查/收集/框架线路追踪共用）：读/列/搜（两搜索键）/诊断/写MD
      const _readMd = { ..._base, read_file: true, list_files: true, search_files: true, search_by_name: true, get_diagnostics: true, write_md: true };
      // T4 收口：读+缺失初始化整段走 updateYonbanConfig 串行锁（原 load→push 默认→save 无锁，
      //   与 saveClones/setActiveSubMode 并发时互覆）。无初始化时 mutator 返回 SKIP_SAVE 不落盘（等价原「仅缺失才 save」）。
      let _clClones = [];
      await updateYonbanConfig(_clUser, (_clConfig) => {
        if (!Array.isArray(_clConfig.clones)) _clConfig.clones = [];
        // 初始化默认分身（如果没有）。审查分身 enabled，其余 5 种为模板(enabled:false，用户按需启用)。
        // presetName 留空=不硬编码到不存在的预设，用户自绑；类型差异体现在 label+permissions+上下文。
        const _existingIds = new Set((_clConfig.clones || []).map(c => c.id));
        let _clTouched = false;
        if (_clConfig.clones.length === 0 || !_existingIds.has(1) || !_existingIds.has(2)) {
          const _defaults = [
            // 审查：只读+写MD报告，绑定「分身_全能型」（对抗性分析师，不锚定主AI结论）
            { id: 1, label: "审查分身", enabled: true,  presetName: "分身_全能型", apiSource: "", modelName: "",
              permissions: { ..._readMd }, contextMessages: 10, maxContext: 1000000, maxTokens: 60000 },
            // 收集：只读采集+写MD，绑定「分身_大型调查」（系统完整性审计，双向可达链路扫描）
            { id: 2, label: "收集分身", enabled: false, presetName: "分身_大型调查", apiSource: "", modelName: "",
              permissions: { ..._readMd }, contextMessages: 8, maxContext: 1000000, maxTokens: 60000 },
            // 代码工作：读/搜/诊断/写MD + 写代码+跑命令（含 fuzzy_edit/replace_lines/insert_at_line 子能力），绑定「分身_代码更改」
            { id: 3, label: "代码工作分身", enabled: false, presetName: "分身_代码更改", apiSource: "", modelName: "",
              permissions: { ..._readMd, write_code: true, run_command: true, fuzzy_edit: true, replace_lines: true, insert_at_line: true }, contextMessages: 12, maxContext: 1000000, maxTokens: 60000 },
            // 框架线路深度追踪：只读+写MD 追链路，绑定「分身_调查追踪」（代码考古学家+调用链追踪）
            { id: 4, label: "框架线路追踪分身", enabled: false, presetName: "分身_调查追踪", apiSource: "", modelName: "",
              permissions: { ..._readMd }, contextMessages: 15, maxContext: 1000000, maxTokens: 60000 },
            // 批量简单任务：读/列/搜/写MD+跑命令，不写代码，绑定「分身_全能型」（通用型批量）
            { id: 5, label: "批量任务分身", enabled: false, presetName: "分身_全能型", apiSource: "", modelName: "",
              permissions: { ..._readMd, run_command: true }, contextMessages: 6, maxContext: 1000000, maxTokens: 60000 },
            // 测试：读/搜/诊断/写MD+跑命令/脚本，不写代码，绑定「分身_测试实验」（QA自动化+断言驱动）
            { id: 6, label: "测试分身", enabled: false, presetName: "分身_测试实验", apiSource: "", modelName: "",
              permissions: { ..._readMd, run_command: true }, contextMessages: 10, maxContext: 1000000, maxTokens: 60000 },
          ];
          for (const _d of _defaults) {
            if (!_existingIds.has(_d.id)) _clConfig.clones.push(_d);
          }
          _clConfig.clones.sort((a, b) => a.id - b.id);
          _clTouched = true;
        }
        _clClones = _clConfig.clones;
        return _clTouched ? _clConfig : SKIP_SAVE;
      }, { clones: [] });
      // clone_template：前端新建分身的默认值单源（权限键集/数值与本后端拍板值+消费端兜底一致）。
      //   maxRounds/temperature 值=replyHandler 消费端兜底(:3150 temperature 0.5 / :3166 maxRounds 50)——
      //   进模板后本体前端表单不再持写死副本（07-09 使用链走查）。
      return { success: true, clones: _clClones, clone_template: { permissions: { ..._readMd }, contextMessages: 10, maxContext: 1000000, maxTokens: 60000, maxRounds: 50, temperature: 0.5 } };
    }

    case "saveClones": {
      // A4 username 权威化：解析失败不再静默回退 "_default"（会把分身写进错误用户目录），返回 error。
      const _clUser = data.username || args?.username;
      if (!_clUser) {
        return { success: false, error: "未能识别登录用户名（username 解析失败），无法保存分身列表，请重新登录后重试。" };
      }
      // T4 收口：读改写走 updateYonbanConfig 串行锁（saveClones 与 setActiveSubMode/加卡等并发时字段互覆的重灾）
      const _clClones = await updateYonbanConfig(_clUser, (_clConfig) => {
        if (Array.isArray(data.clones)) _clConfig.clones = data.clones;
        return _clConfig.clones;
      }, {});
      return { success: true, clones: _clClones };
    }

    // === 编程表格定期清理频率配置 ===
    //   原寄生在 auxiliaryAI 配置里（删辅助AI后独立成自己的存取动作）。
    //   tableCleanFrequency 存 yonban_config.json 顶层，replyHandler 直接读（编程表格定期清理）。

    case "saveTableCleanConfig": {
      const _tcUser = data.username || args?.username || "_default";
      // T4 收口：读改写走 updateYonbanConfig 串行锁
      await updateYonbanConfig(_tcUser, (_tcCfg) => {
        _tcCfg.tableCleanFrequency = parseInt(data.tableCleanFrequency) || 0;
        return _tcCfg;
      }, {});
      return { success: true };
    }

    case "getTableCleanConfig": {
      const _tcUser = data.username || args?.username || "_default";
      const _tcPath = getYonbanConfigPath(_tcUser);
      const _tcCfg = loadJsonFileIfExists(_tcPath, {});
      return { success: true, tableCleanFrequency: _tcCfg.tableCleanFrequency || 0 };
    }

    // P1 per-mode 路由用户覆盖层：modes/*.json 是随代码模板禁直写，用户选择落
    //   yonban_config.mode_feature_overrides。P1 允许 10/01/00、只禁止 11，写口、读口、GetPrompt 运行口
    //   共用 p1Route.mjs；lib 白名单只放行 "p1"，避免把本写口扩成任意 features 后门。
    case "saveModeFeatureOverride": {
      const _mfUser = data.username || args?.username || "_default";
      const _mfMode = data.mode;
      if (!isValidModeId(_mfMode)) return { success: false, error: `非法模式值: ${_mfMode}` };
      if (data.lib !== "p1") return { success: false, error: "本写口仅支持 lib=p1" };
      const _mfRouteShape = resolveP1RouteUpdate(data);
      if (!_mfRouteShape.ok) {
        return { success: false, code: _mfRouteShape.code, error: _mfRouteShape.error };
      }
      let _mfSavedRoute = null;
      await updateYonbanConfig(_mfUser, (cfg) => {
        cfg.mode_feature_overrides ??= {};
        cfg.mode_feature_overrides[_mfMode] ??= {};
        const _mfDecl = modeFeature(_mfMode, "p1");
        const _mfCurrentRoute = resolveEffectiveP1RouteConfig(
          _mfDecl.config || {},
          cfg.mode_feature_overrides[_mfMode].p1 || null,
        );
        _mfSavedRoute = resolveP1RouteUpdate(data, _mfCurrentRoute).config;
        cfg.mode_feature_overrides[_mfMode].p1 = {
          ...(cfg.mode_feature_overrides[_mfMode].p1 || {}),
          ..._mfSavedRoute,
        };
        return cfg;
      }, {});
      return { success: true, mode: _mfMode, effective: _mfSavedRoute };
    }

    case "getModeFeatureOverrides": {
      const _mfUser = data.username || args?.username || "_default";
      const _mfCfg = loadJsonFileIfExists(getYonbanConfigPath(_mfUser), {});
      const _mfOv = _mfCfg.mode_feature_overrides || {};
      // effective = modes json 声明值 ⊕ 用户覆盖（单源下发，前端纯渲染零硬编码默认值）
      const _mfEffective = {};
      for (const _m of ["chat", "code", "work"]) {
        const _decl = modeFeature(_m, "p1");
        _mfEffective[_m] = resolveEffectiveP1RouteConfig(
          _decl.config || {},
          _mfOv[_m]?.p1 || null,
        );
      }
      return { success: true, mode_feature_overrides: _mfOv, effective: _mfEffective };
    }

    // === Skill组(流程组)执行引擎 ===
    // per-chatId workflow 存储：每个 chatid 独立一个 workflow 槽，多组并行各自不干扰。
    // 向后兼容：旧格式(active_workflow 直接在顶层) 自动迁移到 workflows Map。

    case "startFlowGroup": {
      const _fgFilename = data.filename;
      if (!_fgFilename) return { success: false, error: "缺少 filename" };
      const _fgMemDir = ensureMemoryDir(username, charName);
      const _fgPath = path.join(_fgMemDir, "work", "workflows", _fgFilename);
      if (!fs.existsSync(_fgPath)) return { success: false, error: `流程组不存在: ${_fgFilename}` };
      try {
        const _fgData = JSON.parse(await fs.promises.readFile(_fgPath, "utf-8"));
        if (!_fgData.steps || _fgData.steps.length === 0) return { success: false, error: "流程组没有步骤" };
        // [键收口 2026-07-13] 显式 body 键 > 会话上下文 args（桥现按 scope.chatId 盖章 args.chatid）——
        //   与 approve/stop/getStatus 的既有优先序对齐；原 args-first 会让逐行显式键被当前会话盖掉。
        const _fgChatId = data.chatid || args?.chatid || "_default";
        // [0722 锁收口] load→改→save 整段走 updateWorkConfig 串行锁（原无锁 RMW 与 advance/W61/
        //   scheduler 快照写并发=lost-update）。D09 迁移单源；启动=按请求键建新槽（写点不走回退）。
        await updateWorkConfig(username, charName, (_fgConfig) => {
          migrateWorkflowsShape(_fgConfig);
          _fgConfig.workflows[_fgChatId] = {
            active_workflow: _fgFilename,
            workflow_state: {
              current_step: 0,
              total_steps: _fgData.steps.length,
              status: "running",
              started_at: new Date().toISOString(),
              step_history: [],
            },
          };
          // [0722 skill组隔离·每窗独立链路] 启动=更新本窗+用户长期层选中组（消费点：顶栏列表/宏/
          //   AI 切换域，resolveSkillGroupDomain 单源读；写形状收口 writeSelectedGroup，与 setSelectedFlowGroup 同源）
          writeSelectedGroup(_fgConfig, _fgChatId, _fgData.modeGroup || _fgData.steps[0]?.modeGroup || "code", _fgFilename);
          return _fgConfig;
        }, { auto_switch: true });
        // 切换到第一步的子模式/预设
        const firstStep = _fgData.steps[0];
        let _prevSubMode = "";
        let _fgTargetSm = null, _fgGroup = "code"; // 提到 if 外：返回体 subModeSwitch 需要 modeGroup（键收口 2026-07-13）
        if (firstStep.mode || firstStep.preset_name) {
          const _smUser = args?.username || username;
          // T4 收口：子模式切换段（load→resolve prev→write→save）走 updateYonbanConfig 串行锁；
          //   applySubModePresetDefault（写 preset 非 yonban_config）留锁外。
          await updateYonbanConfig(_smUser, (_smConfig) => {
            _fgTargetSm = (_smConfig.sub_modes || []).find(m => m.id === firstStep.mode);
            _fgGroup = _fgTargetSm?.modeGroup || firstStep.modeGroup || "code";
            _prevSubMode = resolveActiveSubModeId(_smConfig, _fgGroup, _fgChatId);
            if (firstStep.mode) writeActiveSubModeId(_smConfig, _fgGroup, firstStep.mode, _fgChatId);
            return _smConfig;
          }, { sub_modes: [], active_sub_mode: "前置任务专家" });
          // 生效模型（凛倾 2026-07-08）：流水线启动切入首步子模式=一次性应用其默认预设（步内 AI 可自由切换）
          if (_fgTargetSm) { try { await applySubModePresetDefault(_smUser, _fgTargetSm, _fgChatId); } catch (e) { console.warn(`[beilu-memory] flowGroup 首步预设应用失败: ${e.message}`); } }
        }
        console.log(`[beilu-memory] startFlowGroup: "${_fgData.name}" 启动 (${_fgData.steps.length}步)`);
        // [BE-T2] 返回 subModeSwitch 让前端派发 beilu:subModeSwitched 事件
        // [键收口 2026-07-13] 广播体必带 chatId+modeGroup：前端镜像监听器（subModePanel:3324）按事件键写
        //   _activeSubModesMap——原不带键时监听器拿浏览器当前 cid 盖写=与后端落盘键（本处 _fgChatId）错位回灌。
        return {
          success: true, name: _fgData.name, totalSteps: _fgData.steps.length, currentStep: 0, firstStep,
          subModeSwitch: firstStep.mode ? buildSubModeSwitchEvent({ from: _prevSubMode, to: firstStep.mode, sm: _fgTargetSm, modeGroup: _fgGroup, chatId: _fgChatId, reason: "flowGroup_start", workflow: _fgData.name }) : null,
        };
      } catch (e) { return { success: false, error: `启动失败: ${e.message}` }; }
    }

    case "advanceFlowGroup": {
      const _afMemDir = ensureMemoryDir(username, charName);
      // _afChatId 仅作子模式激活映射分区键（:3664-3665 请求者聊天线语义），槽键另走回退解析——两键语义不同勿合并
      // [键收口 2026-07-13] 显式 body 键 > 会话上下文 args，同 startFlowGroup 优先序对齐
      const _afChatId = data.chatid || args?.chatid || "_default";
      try {
        // [0722 锁收口] 槽解析→状态推进→落盘整段走 updateWorkConfig 串行锁——原 load 与 save 之间
        //   await 读组文件=真竞态窗（并发写者插入即 lost-update）。早退响应经闭包 _afEarly 带出
        //   （SKIP_SAVE 不落盘=原「校验失败不写」语义）；yonban 子模式切换段保持锁外后置
        //   （原顺序=work 落盘先于 yonban 写，全局锁序恒 work外→yonban内）。
        let _afEarly = null; // 校验失败早退响应
        let _afDone = null;  // 落盘分支产物 {kind:"completed"|"approval"|"auto", wf, state, nextStep?}
        await updateWorkConfig(username, charName, async (_afConfig) => {
          // D09 收口：槽解析单源（per-chatid 优先、_default 兜底，对齐 W61/W58 AI 侧既有语义；
          //   原精确键使手动启动的 _default 槽组对 per-chatid 视角调用方永不可达）
          const { slot: _afSlot } = resolveWorkflowSlot(_afConfig, args?.chatid || data.chatid);
          if (!_afSlot?.active_workflow || !_afSlot.workflow_state) { _afEarly = { success: false, error: "没有正在执行的流程组" }; return SKIP_SAVE; }
          const _afState = _afSlot.workflow_state;
          if (_afState.status !== "running") { _afEarly = { success: false, error: `流程组状态: ${_afState.status}` }; return SKIP_SAVE; }
          const _afWfPath = path.join(_afMemDir, "work", "workflows", _afSlot.active_workflow);
          if (!fs.existsSync(_afWfPath)) { _afEarly = { success: false, error: "流程组文件丢失" }; return SKIP_SAVE; }
          const _afWf = JSON.parse(await fs.promises.readFile(_afWfPath, "utf-8"));
          // 记录当前步骤完成
          _afState.step_history.push({
            step: _afState.current_step,
            label: _afWf.steps[_afState.current_step]?.label || `步骤${_afState.current_step}`,
            completed_at: new Date().toISOString(),
            result: data.result || "",
          });
          _afState.current_step++;
          // 检查是否全部完成
          if (_afState.current_step >= _afState.total_steps) {
            _afState.status = "completed";
            _afState.completed_at = new Date().toISOString();
            _afSlot.active_workflow = "";
            _afDone = { kind: "completed", wf: _afWf, state: _afState };
            return _afConfig;
          }
          // 检查下一步是否需要approval
          const _afNext = _afWf.steps[_afState.current_step];
          const _afNeedsApproval = Array.isArray(_afWf.approval_before) && _afWf.approval_before.includes(_afNext.label || _afNext.mode);
          if (_afNeedsApproval) {
            _afState.status = "awaiting_approval";
            _afDone = { kind: "approval", wf: _afWf, state: _afState, nextStep: _afNext };
            return _afConfig;
          }
          _afDone = { kind: "auto", wf: _afWf, state: _afState, nextStep: _afNext };
          return _afConfig;
        }, {});
        if (_afEarly) return _afEarly;
        const _afWf = _afDone.wf;
        const _afState = _afDone.state;
        if (_afDone.kind === "completed") {
          console.log(`[beilu-memory] advanceFlowGroup: "${_afWf.name}" 全部完成！`);
          return { success: true, completed: true, name: _afWf.name, totalSteps: _afState.total_steps };
        }
        const nextStep = _afDone.nextStep;
        if (_afDone.kind === "approval") {
          return { success: true, completed: false, currentStep: _afState.current_step, nextStep, needsApproval: true, name: _afWf.name };
        }
        // 自动切换到下一步（yonban 段锁外，与原「work 落盘在前」顺序一致）
        let _prevSubMode2 = "";
        let _afTargetSm = null;
        let _afGroup = "code"; // 提到 if 外：返回体 subModeSwitch 需要 modeGroup（键收口 2026-07-13）
        if (nextStep.mode || nextStep.preset_name) {
          const _smUser = args?.username || username;
          // T4 收口：子模式切换段走 updateYonbanConfig 串行锁；applySubModePresetDefault 留锁外。
          await updateYonbanConfig(_smUser, (_smConfig) => {
            _afTargetSm = (_smConfig.sub_modes || []).find(m => m.id === nextStep.mode);
            _afGroup = _afTargetSm?.modeGroup || nextStep.modeGroup || "code";
            _prevSubMode2 = resolveActiveSubModeId(_smConfig, _afGroup, _afChatId);
            if (nextStep.mode) writeActiveSubModeId(_smConfig, _afGroup, nextStep.mode, _afChatId);
            return _smConfig;
          }, { sub_modes: [], active_sub_mode: "前置任务专家" });
          // 生效模型（凛倾 2026-07-08）：流水线推进切入下一步子模式=一次性应用其默认预设（步内 AI 可自由切换）
          if (_afTargetSm) { try { await applySubModePresetDefault(_smUser, _afTargetSm, _afChatId); } catch (e) { console.warn(`[beilu-memory] flowGroup 推进预设应用失败: ${e.message}`); } }
        }
        console.log(`[beilu-memory] advanceFlowGroup: "${_afWf.name}" 进入步骤${_afState.current_step}/${_afState.total_steps}: ${nextStep.label || nextStep.mode}`);
        return {
          success: true, completed: false, currentStep: _afState.current_step, totalSteps: _afState.total_steps, nextStep, name: _afWf.name,
          // [键收口 2026-07-13] 同 startFlowGroup：广播体带 chatId+modeGroup 防前端镜像键错位回灌
          subModeSwitch: nextStep.mode ? buildSubModeSwitchEvent({ from: _prevSubMode2, to: nextStep.mode, sm: _afTargetSm, modeGroup: _afGroup, chatId: _afChatId, reason: "flowGroup_advance", workflow: _afWf.name }) : null,
        };
      } catch (e) { return { success: false, error: `推进失败: ${e.message}` }; }
    }

    case "getFlowGroupStatus": {
      const _gsMemDir = ensureMemoryDir(username, charName);
      const _gsConfigPath = getWorkConfigPath(username, charName); // T7 尾段收口：权威路径单点
      const _gsConfig = loadJsonFileIfExists(_gsConfigPath, {});
      // D09 收口：槽解析单源（per-chatid 优先、_default 兜底）。原迁移块在读路径写盘=副作用反模式，
      //   迁移幂等由单源保障，落盘交由写路径四 case（start/advance/approve/stop）。
      const { slot: _gsSlot } = resolveWorkflowSlot(_gsConfig, data.chatid || args?.chatid);
      if (!_gsSlot?.active_workflow) return { success: true, active: false };
      const _gsWfPath = path.join(_gsMemDir, "work", "workflows", _gsSlot.active_workflow);
      let _gsWf = null;
      try { _gsWf = JSON.parse(await fs.promises.readFile(_gsWfPath, "utf-8")); } catch {}
      return {
        success: true, active: true,
        filename: _gsSlot.active_workflow,
        name: _gsWf?.name || _gsSlot.active_workflow,
        state: _gsSlot.workflow_state || {},
        steps: _gsWf?.steps || [],
      };
    }

    // W61: 审批流程组步骤（将awaiting_approval改为running，允许继续推进）
    case "approveFlowGroup": {
      const _apMemDir = ensureMemoryDir(username, charName);
      // [0722 锁收口] RMW 走 updateWorkConfig 串行锁；早退经闭包带出（SKIP_SAVE 不落盘）
      let _apOut = null;
      await updateWorkConfig(username, charName, (_apConfig) => {
        // D09 收口：槽解析单源（per-chatid 优先、_default 兜底）——groupRuntimePanel 按钮带真实 chatid，
        //   手动组在 _default 槽，原精确键=面板看得见（显示链同修）却批不到的预埋，回退后同槽一致
        const { slot: _apSlot } = resolveWorkflowSlot(_apConfig, data.chatid || args?.chatid);
        if (!_apSlot?.workflow_state || _apSlot.workflow_state.status !== "awaiting_approval") {
          _apOut = { success: false, error: "当前没有待审批的流程组步骤" };
          return SKIP_SAVE;
        }
        _apSlot.workflow_state.status = "running";
        console.log(`[beilu-memory] approveFlowGroup: 步骤${_apSlot.workflow_state.current_step}已批准`);
        _apOut = { success: true, currentStep: _apSlot.workflow_state.current_step };
        return _apConfig;
      }, {});
      return _apOut;
    }

    case "stopFlowGroup": {
      const _sfMemDir = ensureMemoryDir(username, charName);
      // [0722 锁收口] RMW 走 updateWorkConfig 串行锁（原无槽也整文件写回，保持无条件落盘语义）
      await updateWorkConfig(username, charName, (_sfConfig) => {
        // D09 收口：槽解析单源（per-chatid 优先、_default 兜底），与 approve/advance/getStatus 同语义
        const { slot: _sfSlot } = resolveWorkflowSlot(_sfConfig, data.chatid || args?.chatid);
        if (_sfSlot?.workflow_state) {
          _sfSlot.workflow_state.status = "stopped";
          _sfSlot.workflow_state.stopped_at = new Date().toISOString();
        }
        if (_sfSlot) _sfSlot.active_workflow = "";
        return _sfConfig;
      }, {});
      return { success: true };
    }

    case "deleteFlowGroup": {
      const _dfFilename = data.filename;
      if (!_dfFilename) return { success: false, error: "缺少 filename" };
      const _dfMemDir = ensureMemoryDir(username, charName);
      const _dfPath = path.join(_dfMemDir, "work", "workflows", _dfFilename);
      if (!fs.existsSync(_dfPath)) return { success: false, error: "文件不存在" };
      // 内置组（builtin/created_by=default）不可删
      try {
        const _dfWf = JSON.parse(fs.readFileSync(_dfPath, "utf-8"));
        if (_dfWf.builtin === true || _dfWf.created_by === "default") {
          return { success: false, error: "内置组不可删除（大型项目等系统流水线）。" };
        }
      } catch { /* 文件损坏照常允许删 */ }
      try {
        await safeUnlink(_dfPath, "deleteFlowGroup");
        // [0722 skill组隔离·每窗独立链路] 级联清理选中组指针（删除↔引用配对反演）：任一窗口层/长期层
        //   指向被删文件=悬空（resolveSkillGroupDomain 读到 null 会优雅放行，但指针留着=脏数据+前端误过滤）。
        //   [0722 锁收口] RMW 走 updateWorkConfig 串行锁；无匹配指针 SKIP_SAVE 不落盘。
        try {
          await updateWorkConfig(username, charName, (_dfCfg) => {
            const _dfMap = _dfCfg.selected_groups_map;
            if (!_dfMap) return SKIP_SAVE;
            let _dfDirty = false;
            for (const _slotKey of Object.keys(_dfMap)) {
              for (const _mg of Object.keys(_dfMap[_slotKey] || {})) {
                if (_dfMap[_slotKey][_mg] === _dfFilename) { delete _dfMap[_slotKey][_mg]; _dfDirty = true; }
              }
            }
            return _dfDirty ? _dfCfg : SKIP_SAVE;
          }, {});
        } catch (e) { console.warn(`[beilu-memory] deleteFlowGroup 选中组指针级联清理失败(非致命): ${e.message}`); }
        return { success: true };
      }
      catch (e) { return { success: false, error: e.message }; }
    }

    // 用户自建 skill 组：前端传 name + steps(完整 {mode,preset_name,label,icon}) → 落盘 builtin:false。
    case "saveFlowGroup": {
      const _sgName = (data.name || "").trim();
      if (!_sgName) return { success: false, error: "缺少组名" };
      const _sgSteps = Array.isArray(data.steps) ? data.steps.filter((s) => s && s.mode) : [];
      if (!_sgSteps.length) return { success: false, error: "至少选一个子模式作为步骤" };
      const _sgMemDir = ensureMemoryDir(username, charName);
      const _sgDir = path.join(_sgMemDir, "work", "workflows");
      try {
        if (!fs.existsSync(_sgDir)) fs.mkdirSync(_sgDir, { recursive: true });
        const _sgSafe = sanitizeFilename(_sgName);
        const _sgFilename = _sgSafe + ".json";
        const _sgPath = path.join(_sgDir, _sgFilename);
        // 禁止覆盖内置组
        if (fs.existsSync(_sgPath)) {
          try {
            const _ex = JSON.parse(fs.readFileSync(_sgPath, "utf-8"));
            if (_ex.builtin === true || _ex.created_by === "default") return { success: false, error: "该名与内置组冲突，请改名" };
          } catch { /* 损坏文件允许覆盖 */ }
        }
        const _sgWf = {
          name: _sgName,
          filename: _sgFilename,
          description: (data.description || "").trim(),
          skill_group: true,
          builtin: false,
          modeGroup: data.modeGroup || (_sgSteps[0]?.modeGroup) || "code",
          steps: _sgSteps.map((s) => ({ mode: s.mode, preset_name: s.preset_name || "", label: s.label || s.mode, icon: s.icon || "", modeGroup: s.modeGroup || "" })),
          auto_advance: data.auto_advance !== false,
          approval_before: [],
          created_by: "user",
          created_at: new Date().toISOString(),
        };
        nicerWriteFileSync(_sgPath, JSON.stringify(_sgWf, null, 2));
        return { success: true, filename: _sgFilename, name: _sgName };
      } catch (e) { return { success: false, error: `保存 skill 组失败: ${e.message}` }; }
    }

    // skill 组库：列出 work/workflows/ 下所有流程组（=skill 组）。
    // 首次访问若缺默认组（大型项目/小型项目）则从 buildDefaultSkillGroups 落盘种子（不覆盖用户已存在的同名文件）。
    case "listFlowGroups": {
      const _lfMemDir = ensureMemoryDir(username, charName);
      const _lfDir = path.join(_lfMemDir, "work", "workflows");
      try {
        if (!fs.existsSync(_lfDir)) fs.mkdirSync(_lfDir, { recursive: true });
        // 种子默认 skill 组（仅当同名文件不存在，绝不覆盖用户改动）
        let _seeded = 0;
        for (const _sg of buildDefaultSkillGroups()) {
          const _sgPath = path.join(_lfDir, _sg.filename);
          if (!fs.existsSync(_sgPath)) {
            const { filename: _fn, ...rest } = _sg;
            nicerWriteFileSync(_sgPath, JSON.stringify({ ...rest, created_at: new Date().toISOString() }, null, 2));
            _seeded++;
          }
        }
        if (_seeded) console.log(`[beilu-memory] listFlowGroups: 种子 ${_seeded} 个默认 skill 组`);
        // 列出全部
        const _groups = [];
        for (const _f of fs.readdirSync(_lfDir)) {
          if (!_f.endsWith(".json")) continue;
          try {
            const _wf = JSON.parse(fs.readFileSync(path.join(_lfDir, _f), "utf-8"));
            _groups.push({
              filename: _f,
              name: _wf.name || _f.replace(/\.json$/, ""),
              description: _wf.description || "",
              stepCount: Array.isArray(_wf.steps) ? _wf.steps.length : 0,
              steps: (_wf.steps || []).map((s) => ({ mode: s.mode, label: s.label, icon: s.icon, modeGroup: s.modeGroup })),
              skill_group: _wf.skill_group === true,
              modeGroup: _wf.modeGroup || ((_wf.steps || [])[0]?.modeGroup) || "code",
              auto_advance: _wf.auto_advance ?? true,
              created_by: _wf.created_by || "ai",
              builtin: _wf.builtin === true || _wf.created_by === "default",
              // 组级源/模型快照投影（AI建组时复制自当时活跃子模式，replyHandler createFlowGroup）——
              //   组详情面板显示+更改入口用；空=跟随全局。消费端 getPromptHandler flowGroupModelSnap。
              api_source: _wf.api_source || (_wf.model_params ? ((_wf.model_params.api_source ?? _wf.model_params.apiSource) || "") : ""),
              model: _wf.model_params ? ((_wf.model_params.model ?? _wf.model_params.modelName) || "") : "",
            });
          } catch { /* 单个流程组损坏不影响列出其余 */ }
        }
        // [0722 skill组隔离·每窗独立链路] 附带【本窗有效】选中组（{code,work}，后端 resolveSelectedGroups
        //   按请求 chatid 算好单源下发——同 effective_sub_modes 范式，前端只消费不解析层级）。
        //   写点=setSelectedFlowGroup/startFlowGroup（writeSelectedGroup 双层写）。
        const _lfCfg = loadJsonFileIfExists(getWorkConfigPath(username, charName), {});
        return { success: true, groups: _groups, seeded: _seeded, selected_groups: resolveSelectedGroups(_lfCfg, data.chatid || args?.chatid || null) };
      } catch (e) { return { success: false, error: `列出 skill 组失败: ${e.message}`, groups: [] }; }
    }

    // [0722 skill组隔离·每窗独立链路] 选中组写点：点选组=本窗+用户长期层双层持久化（除非再切换）。
    //   filename 空 + modeGroup 有值 = 清除该 modeGroup 的选择（两层同清，域限制解除恢复全量显示）。
    //   消费链：resolveSkillGroupDomain（宏清单/AI 切换域）+ listFlowGroups 下发本窗有效值（前端顶栏过滤+选中恢复）。
    case "setSelectedFlowGroup": {
      const _ssFilename = (data.filename || "").trim();
      const _ssMemDir = ensureMemoryDir(username, charName);
      const _ssChatId = data.chatid || args?.chatid || null; // 键口径同 flow 组各 case（显式 body 键 > 会话上下文）
      // 组文件读+校验留锁外（非 _work_config IO；modeGroup 以组文件为权威，payload 仅作清除键）
      let _ssMg = "";
      if (_ssFilename) {
        const _ssWf = loadJsonFileIfExists(path.join(_ssMemDir, "work", "workflows", _ssFilename), null);
        if (!_ssWf) return { success: false, error: `流程组不存在: ${_ssFilename}` };
        _ssMg = _ssWf.modeGroup || (_ssWf.steps || [])[0]?.modeGroup || "code";
      } else if (!data.modeGroup) {
        return { success: false, error: "缺少 filename 或 modeGroup" };
      }
      // [0722 锁收口] RMW 走 updateWorkConfig 串行锁；写形状收口 writeSelectedGroup（清除=写空串，两层同清）
      const _ssResult = await updateWorkConfig(username, charName, (_ssCfg) => {
        if (_ssFilename) writeSelectedGroup(_ssCfg, _ssChatId, _ssMg, _ssFilename);
        else writeSelectedGroup(_ssCfg, _ssChatId, data.modeGroup, "");
        return resolveSelectedGroups(_ssCfg, _ssChatId);
      }, {});
      return { success: true, selected_groups: _ssResult };
    }


    // [BE-T9] 前端表单创建 Skill组
    case "createFlowGroupManual": {
      const _cfgmData = data.flowGroup || {};
      const _cfgmName = _cfgmData.name;
      if (!_cfgmName) return { success: false, error: "缺少 name" };
      const _cfgmMemDir = ensureMemoryDir(username, charName);
      const _cfgmDir = path.join(_cfgmMemDir, "work", "workflows");
      if (!fs.existsSync(_cfgmDir)) fs.mkdirSync(_cfgmDir, { recursive: true });
      const _cfgmSafeName = sanitizeFilename(_cfgmName);
      const _cfgmPath = path.join(_cfgmDir, `${_cfgmSafeName}.json`);
      if (fs.existsSync(_cfgmPath) && !data.overwrite) {
        return { success: false, error: "已存在同名 Skill 组,加 overwrite=true 可覆盖" };
      }
      try {
        const _cfgmBody = {
          name: _cfgmName,
          description: _cfgmData.description || "",
          steps: _cfgmData.steps || [],
          auto_advance: _cfgmData.auto_advance ?? true,
          approval_before: _cfgmData.approval_before || [],
          created_at: new Date().toISOString(),
          created_by: "user",
        };
        nicerWriteFileSync(_cfgmPath, JSON.stringify(_cfgmBody, null, 2));
        return { success: true, filename: `${_cfgmSafeName}.json`, flowGroup: _cfgmBody };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // [BE-T9] 更新已有 Skill组
    case "updateFlowGroup": {
      const _ufFilename = data.filename;
      const _ufUpdate = data.update || {};
      if (!_ufFilename) return { success: false, error: "缺少 filename" };
      const _ufMemDir = ensureMemoryDir(username, charName);
      const _ufPath = path.join(_ufMemDir, "work", "workflows", _ufFilename);
      if (!fs.existsSync(_ufPath)) return { success: false, error: "Skill 组不存在" };
      try {
        const _ufOld = JSON.parse(fs.readFileSync(_ufPath, "utf-8"));
        const _ufNew = { ..._ufOld, ..._ufUpdate, updated_at: new Date().toISOString() };
        nicerWriteFileSync(_ufPath, JSON.stringify(_ufNew, null, 2));
        return { success: true, flowGroup: _ufNew };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // 前端直接调用 IDE 工具（git面板/文件面板等非AI场景）
    case "ideToolCall": {
      const _itTool = data.tool;
      const _itParams = data.params || {};
      if (!_itTool) return { success: false, error: "缺少 tool" };
      wbT(_chatid, "setDataActions", "ideToolCall:enter", { tool: _itTool, path: _itParams?.path });
      try {
        // [0727 id传导] 前端面板直调工具带线 id：git/文件面板的操作路由到该线绑定的执行端，
        //   不再一律落主连接（gate 语义不动：只补路由 id）。_chatid 上方 wbT 已在用=同一作用域现成值。
        const result = await ideClient.callTool(_itTool, _itParams, undefined, undefined, { chatid: _chatid || null });
        if (result?.success === false) {
          wbD(_chatid, "setDataActions", "ideToolCall:fail", false, result?.error || "工具失败", { tool: _itTool });
        } else {
          wbT(_chatid, "setDataActions", "ideToolCall:done", { tool: _itTool, success: true });
        }
        return result ?? { success: true };
      } catch (e) {
        wbD(_chatid, "setDataActions", "ideToolCall:error", false, e.message, { tool: _itTool });
        return { success: false, error: `IDE 工具调用失败: ${e.message}` };
      }
    }

    // === W61: git快照防护（W13 §6设计） ===

    case "gitSnapshot": {
      // N43 框架级修正（W13 §6 防护语义=保险，不毁现场）：
      //   旧实现 `git stash push --include-untracked` 会把工作区全部未提交改动【收走】——
      //   用户点"创建快照"=改动从工作区消失，与防护语义相反（前端按钮因此一直 disabled）。
      //   现改 `git stash create`（只造 stash commit 对象，工作区零变化）+ `git stash store`
      //   （挂入 stash 列表防 GC），并把 stash hash 记进 checkpoint 供 gitRestore 精确 apply。
      //   局限：stash create 不含未跟踪文件（untracked 不进快照），data/ 等 gitignore 内容本就不在 git 域。
      try {
        const _gsUser = args?.username || username;
        const _gsCheckpointsPath = path.join(__projectRoot, "data", "users", _gsUser, "git_checkpoints.json");
        const _gsCheckpoints = loadJsonFileIfExists(_gsCheckpointsPath, []);
        const _gsTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const _gsLabel = (data.label || `beilu-checkpoint-${_gsTimestamp}`).replace(/["`$\\]/g, "");

        const { execFileSync } = await import("node:child_process");
        // 缺-7 per-卡 checkpoint：带 cardKey 且该卡有 workspace_root → 快照作用于该卡 repo（否则默认 __projectRoot），
        //   防多卡并行时 A 卡快照/回档误碰 B 卡的项目仓（设计§十一「唯一需改」）。
        const _gsCard = data.cardKey || "";
        let _gsProjectDir = __projectRoot;
        if (_gsCard) { try { const _r = getCardWorkspaceRoot(_gsUser, _gsCard); if (_r) _gsProjectDir = _r; } catch { /* 取不到卡根→默认根 */ } }
        // SEC-T10：git 一律 execFileSync argv 形式（不经 shell），label/hash 作单一参数传入，
        //   杜绝 label 或被污染的 checkpoint 注入 shell。
        const _gsGit = (a) => execFileSync("git", a, { cwd: _gsProjectDir, encoding: "utf-8" });
        let _gsHeadHash = "";
        try { _gsHeadHash = _gsGit(["rev-parse", "HEAD"]).trim(); } catch {}
        if (!_gsHeadHash) {
          // 非 git 仓库/无 HEAD：旧实现吞错后仍返回 success（误导），现如实失败
          return { success: false, error: "项目根不是可用的 git 仓库（rev-parse HEAD 失败）" };
        }
        let _gsStashHash = "";
        let _gsStashResult = "";
        try {
          _gsStashHash = _gsGit(["stash", "create", _gsLabel]).trim();
          if (_gsStashHash) {
            _gsGit(["stash", "store", "-m", _gsLabel, _gsStashHash]);
            _gsStashResult = "stash created (workspace untouched)";
          } else {
            _gsStashResult = "no local changes (HEAD-only checkpoint)";
          }
        } catch (e) { _gsStashResult = `stash create failed: ${e.message}`; }

        const _gsEntry = {
          id: _gsTimestamp,
          label: _gsLabel,
          headHash: _gsHeadHash,
          stashHash: _gsStashHash,
          stashResult: _gsStashResult,
          createdAt: new Date().toISOString(),
          reason: data.reason || "manual",
          cardKey: _gsCard, // 缺-7：所属角色卡（空=全局/默认根）
        };
        _gsCheckpoints.push(_gsEntry);
        if (_gsCheckpoints.length > 20) _gsCheckpoints.splice(0, _gsCheckpoints.length - 20);
        saveJsonFile(_gsCheckpointsPath, _gsCheckpoints);
        console.log(`[beilu-memory] gitSnapshot: ${_gsLabel} (HEAD=${_gsHeadHash.substring(0, 8)}, stash=${_gsStashHash ? _gsStashHash.substring(0, 8) : "none"})`);
        return { success: true, checkpoint: _gsEntry };
      } catch (e) { return { success: false, error: `git快照失败: ${e.message}` }; }
    }

    case "gitRestore": {
      // N43 框架级修正：
      //   旧实现 ① reset --hard 直接毁当前未提交改动无任何保险 ② `git stash pop` 弹的是
      //   【栈顶】任意 stash，不是该 checkpoint 对应的那个——恢复错对象。
      //   现：恢复前先自动打一个 pre-restore 保险快照（stash create+store，零动现场），
      //   再 reset --hard 到记录 HEAD，再 `git stash apply <该快照的 stashHash>`（精确）。
      //   旧条目无 stashHash → 跳过 apply 并在 results 注明（向后兼容，不再乱 pop）。
      const _grCheckpointId = data.checkpointId;
      if (!_grCheckpointId) return { success: false, error: "缺少 checkpointId" };
      // SEC-D4：多用户共享仓回滚防护——gitRestore 作用于全局 __projectRoot 仓，
      //   一人 reset --hard 会抹掉所有用户未提交改动。server(多用户)模式默认禁用，
      //   owner 可在安全中心「多用户允许 gitRestore」(config.gitRestoreMultiUser=true)放行。local 模式不受限。
      try {
        const { getDeployMode } = await import("../../security/path_confine.mjs");
        if (getDeployMode() === "server") {
          let _grAllowMU = false;
          try { _grAllowMU = JSON.parse(fs.readFileSync(path.join(__projectRoot, "data", "config.json"), "utf-8"))?.gitRestoreMultiUser === true; } catch {}
          if (!_grAllowMU)
            return { success: false, error: "多用户(server)模式下 gitRestore 默认禁用——回滚共享仓会影响全部用户。可在安全中心开启「多用户允许 gitRestore」。" };
        }
      } catch { /* path_confine 不可用时不阻断 local 正常回滚 */ }
      try {
        const _grUser = args?.username || username;
        const _grCheckpointsPath = path.join(__projectRoot, "data", "users", _grUser, "git_checkpoints.json");
        const _grCheckpoints = loadJsonFileIfExists(_grCheckpointsPath, []);
        const _grEntry = _grCheckpoints.find(c => c.id === _grCheckpointId);
        if (!_grEntry) return { success: false, error: `快照不存在: ${_grCheckpointId}` };
        // 缺-7：防 A 卡回档误碰 B 卡——快照所属卡与当前请求卡不一致则拒；按快照所属卡解析其 repo 目录。
        const _grCard = _grEntry.cardKey || "";
        if (data.cardKey && _grCard && data.cardKey !== _grCard) {
          return { success: false, error: `该快照属角色卡「${_grCard}」,当前卡「${data.cardKey}」,拒绝跨卡回档` };
        }
        const { execFileSync } = await import("node:child_process");
        let _grProjectDir = __projectRoot;
        if (_grCard) { try { const _r = getCardWorkspaceRoot(_grUser, _grCard); if (_r) _grProjectDir = _r; } catch { /* 取不到卡根→默认根 */ } }
        const _grGit = (a) => execFileSync("git", a, { cwd: _grProjectDir, encoding: "utf-8" });
        // SEC-T10：headHash/stashHash 来自 git_checkpoints.json，该文件可能被污染——
        //   恢复前强制校验为合法 git 对象名(仅十六进制)，且 git 一律走 argv 不经 shell，双重防注入。
        const _isHash = (h) => typeof h === "string" && /^[0-9a-f]{4,64}$/i.test(h);
        let results = [];

        // 0. 恢复前保险快照（当前改动存为 stash 对象，工作区不动；失败只记录不阻塞——
        //    用户已明确要恢复，但尽力留一条回头路）
        try {
          const _grPreLabel = `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          const _grPreHash = _grGit(["stash", "create", _grPreLabel]).trim();
          if (_grPreHash) {
            _grGit(["stash", "store", "-m", _grPreLabel, _grPreHash]);
            results.push(`pre-restore 保险快照 ${_grPreHash.substring(0, 8)}`);
          }
        } catch (e) { results.push(`pre-restore 保险失败: ${e.message}`); }

        // 1. reset到记录的HEAD（hash 校验通过才执行）
        if (_grEntry.headHash) {
          if (!_isHash(_grEntry.headHash)) results.push("reset跳过: headHash 非法");
          else try { _grGit(["reset", "--hard", _grEntry.headHash]); results.push("reset OK"); }
          catch (e) { results.push(`reset失败: ${e.message}`); }
        }
        // 2. 精确 apply 该快照的 stash（不 pop 栈顶；hash 校验通过才执行）
        if (_grEntry.stashHash) {
          if (!_isHash(_grEntry.stashHash)) results.push("stash apply跳过: stashHash 非法");
          else try { _grGit(["stash", "apply", _grEntry.stashHash]); results.push("stash apply OK"); }
          catch (e) { results.push(`stash apply: ${e.message}`); }
        } else {
          results.push("旧格式快照无 stashHash（仅恢复到 HEAD，未应用改动层）");
        }

        console.log(`[beilu-memory] gitRestore: ${_grEntry.label} → ${results.join(", ")}`);
        return { success: true, results, checkpoint: _grEntry };
      } catch (e) { return { success: false, error: `git恢复失败: ${e.message}` }; }
    }

    case "listGitCheckpoints": {
      const _lcUser = args?.username || username;
      const _lcPath = path.join(__projectRoot, "data", "users", _lcUser, "git_checkpoints.json");
      let _lcList = loadJsonFileIfExists(_lcPath, []);
      // 缺-7：按卡过滤——带 cardKey 时只列该卡的快照 + 旧格式无 cardKey 的（向后兼容）。
      if (data.cardKey) _lcList = _lcList.filter((c) => !c.cardKey || c.cardKey === data.cardKey);
      return { success: true, checkpoints: _lcList };
    }

    // === 回档 ===
    case "rollbackMemoryToMessage": {
      return _withMemoryArchiveCoverage(await (async () => {
      if (!data.chatId) return { success: false, error: "缺少 chatId" };
      if (Object.prototype.hasOwnProperty.call(data, "_historyCoordinated")) {
        return {
          success: false,
          applied: false,
          partial: false,
          code: "E_ROLLBACK_INTERNAL_CAPABILITY_REQUIRED",
          error: "_historyCoordinated 是服务端内部能力，公共 SetData payload 不得传入",
        };
      }
      const _historyCoordinated = internalCapability === _ROLLBACK_HISTORY_COORDINATION_CAPABILITY;
      // ★ P1-1 per-layer 自由度：data.layers={file?,table?}（缺省=全 true，向后兼容）。
      // 仅 false 才跳过该层；缺省/未传 = 回。角色级归档记忆尚无按消息账本，
      // 不参与执行，并由 memoryArchive:not_covered 显式声明边界。
      const _layers = (data.layers && typeof data.layers === "object") ? data.layers : {};
      const _doTable = _layers.table !== false;
      const _doFile = _layers.file !== false;
      try {
        const anchor = await _resolveRollbackAnchor(data.chatId, data.anchorMessageId, data.targetIndex);
        const targetIndex = anchor.index;
        const actualIdeRoute = ideClient.getRouteSnapshot(data.chatId);
        const ideConnected = actualIdeRoute.connected;
        const hasExpectedIdeRoute = Object.prototype.hasOwnProperty.call(data, "expectedIdeRoute");
        if (_historyCoordinated && !hasExpectedIdeRoute) {
          return {
            success: false,
            applied: false,
            error: "协调回档缺少 expectedIdeRoute，已拒绝执行",
            drift: "ideRoute",
            actualIdeRoute,
            anchor,
          };
        }
        if (hasExpectedIdeRoute && !isValidIdeRouteSnapshot(data.expectedIdeRoute)) {
          return {
            success: false,
            applied: false,
            error: "expectedIdeRoute 形状无效",
            drift: "ideRoute",
            expectedIdeRoute: data.expectedIdeRoute,
            actualIdeRoute,
            anchor,
          };
        }
        if (hasExpectedIdeRoute && !ideRouteSnapshotsEqual(data.expectedIdeRoute, actualIdeRoute)) {
          return {
            success: false,
            applied: false,
            error: "回档令牌已漂移：IDE 路由连接代次变化",
            drift: "ideRoute",
            expectedIdeRoute: data.expectedIdeRoute,
            actualIdeRoute,
            anchor,
          };
        }
        const hasExpectedIde = Object.prototype.hasOwnProperty.call(data, "expectedIdeConnected");
        if (hasExpectedIde && typeof data.expectedIdeConnected !== "boolean") {
          return { success: false, applied: false, error: "expectedIdeConnected 必须是布尔值", anchor };
        }
        if (hasExpectedIdeRoute && hasExpectedIde && data.expectedIdeConnected !== data.expectedIdeRoute.connected) {
          return {
            success: false,
            applied: false,
            error: "回档令牌无效：expectedIdeConnected 与 expectedIdeRoute 不一致",
            drift: "ideRoute",
            expectedIdeConnected: data.expectedIdeConnected,
            expectedIdeRoute: data.expectedIdeRoute,
            actualIdeRoute,
            anchor,
          };
        }
        // 旧的直接调用入口没有精确 route token 时，仅保留布尔连接状态兼容校验；
        // 协调入口上方已强制 expectedIdeRoute，布尔值不能替代连接代次。
        if (!hasExpectedIdeRoute && hasExpectedIde && data.expectedIdeConnected !== ideConnected) {
          return {
            success: false,
            applied: false,
            error: "回档令牌已漂移：IDE 连接状态变化",
            drift: "ideConnected",
            expectedIdeConnected: data.expectedIdeConnected,
            actualIdeConnected: ideConnected,
            anchor,
          };
        }

        const hasExpectedCheckpoints = Object.prototype.hasOwnProperty.call(data, "checkpointIds");
        const expectedCheckpointIds = hasExpectedCheckpoints ? _parseExpectedCheckpointIds(data.checkpointIds) : undefined;
        let currentCheckpointIds = [];
        // 文件令牌预检必须发生在表格写入前；执行时还会把同一令牌传给 revert 再校验一次，
        // 防止预检与文件恢复之间新检查点插入。
        if (_doFile && ideConnected && hasExpectedCheckpoints) {
          const preflight = await ideClient.getCheckpointDiff(
            data.chatId,
            targetIndex,
            expectedCheckpointIds,
            hasExpectedIdeRoute ? data.expectedIdeRoute : undefined,
          );
          const preflightEnvelope = _readCheckpointPreviewEnvelope(preflight);
          const preflightData = preflightEnvelope.result || {};
          if (!preflightEnvelope.ok) {
            const routeDrift = preflight?.drift === "ideRoute" || preflightData?.drift === "ideRoute";
            return {
              success: false,
              applied: false,
              error: preflightEnvelope.error || "检查点令牌校验失败",
              drift: routeDrift ? "ideRoute" : "checkpointIds",
              ...(routeDrift ? {
                expectedIdeRoute: preflight?.expectedIdeRoute ?? preflightData?.expectedIdeRoute ?? data.expectedIdeRoute,
                actualIdeRoute: preflight?.actualIdeRoute ?? preflightData?.actualIdeRoute ?? ideClient.getRouteSnapshot(data.chatId),
              } : {}),
              anchor,
            };
          }
          currentCheckpointIds = preflightData.checkpointIds;
          if (!_sameCheckpointIds(currentCheckpointIds, expectedCheckpointIds)) {
            return { success: false, applied: false, error: "回档令牌已漂移：文件检查点集合变化", drift: "checkpointIds", expectedCheckpointIds, actualCheckpointIds: currentCheckpointIds, anchor };
          }
        } else if (_doFile && !ideConnected && expectedCheckpointIds?.length) {
          return { success: false, applied: false, error: "回档令牌已漂移：绑定 IDE 离线且预览包含文件检查点", drift: "checkpointIds", anchor };
        }

        const snapshot = _doTable ? findSnapshotForRollback(username, charName, data.chatId, targetIndex) : null;
        const currentTableSnapshotId = snapshot?.id || null;
        const hasExpectedTable = Object.prototype.hasOwnProperty.call(data, "tableSnapshotId");
        if (hasExpectedTable && data.tableSnapshotId !== null && (typeof data.tableSnapshotId !== "string" || !data.tableSnapshotId)) {
          return { success: false, applied: false, error: "tableSnapshotId 必须是非空字符串或 null", anchor };
        }
        if (hasExpectedTable && data.tableSnapshotId !== currentTableSnapshotId) {
          return {
            success: false,
            applied: false,
            error: "回档令牌已漂移：表格快照变化",
            drift: "tableSnapshotId",
            expectedTableSnapshotId: data.tableSnapshotId,
            actualTableSnapshotId: currentTableSnapshotId,
            anchor,
          };
        }
        let tableRestored = false, snapshotId = null, snapshotTimestamp = null, tableCount = 0, pruned = 0;
        // ★ P0-1 保命快照：在改表格前抓当前 tables 深拷贝，文件层失败时回滚到改前状态，
        // 实现"要么全成、要么完全不动"原子性。_rollbackMemData 是 live 缓存对象（saveTablesData 写它）。
        let _safetyTables = null, _rollbackMemData = null;
        if (snapshot) {
          // 恢复不能只凭 snapshotId：旧时间戳 ID 可能碰撞，且快照文件跨同角色的多个 chat 共存。
          // 这里把“刚按当前 anchor 解析出的同一条快照”事实作为作用域交给恢复端二次核对，拒绝跨对话/消息猜测。
          const tableSnapshotScope = {
            chatId: data.chatId,
            messageIndex: snapshot.messageIndex,
            ...(snapshot.messageId ? { messageId: snapshot.messageId } : {}),
          };
          const restoreResult = restoreTableSnapshot(username, charName, snapshot.id, tableSnapshotScope);
          if (!restoreResult.success) {
            return {
              success: false,
              applied: false,
              error: restoreResult.error,
              ...(restoreResult.code ? { code: restoreResult.code } : {}),
              ...(restoreResult.drift ? { drift: restoreResult.drift } : {}),
              ...(restoreResult.expectedScope ? { expectedTableSnapshotScope: restoreResult.expectedScope } : {}),
              ...(restoreResult.actualScopes ? { actualTableSnapshotScopes: restoreResult.actualScopes } : {}),
              anchor,
            };
          }
          clearCharCache(username, charName);
          // 修2 断链A（20260716）：按快照自带 mode 路由桶（tableEdit 快照的桶=创建时会话模式）；
          //   legacy 无 mode 快照按 undefined→active_mode（旧行为）。写盘 mode 必须取 _rollbackMemData.activeMode
          //   ——原 memData.activeMode 是外层 viewMode 加载的桶，与本处 undefined 加载的桶可分叉：
          //   分叉时 saveTablesData 按 memData 桶键查缓存=miss（clearCharCache 后只有本处键）→
          //   「缓存中无数据」warn、回档静默不落盘（读写同源铁律：写谁的 tables 就用谁的 activeMode）。
          _rollbackMemData = loadMemoryData(username, charName, restoreResult.mode || undefined, chatId);
          _safetyTables = structuredClone(_rollbackMemData.tables);
          _rollbackMemData.tables = restoreResult.tables;
          // B-4：回档落盘必须 await + 校 .ok（对齐 updateTable/addTable M5 契约:645-646）——
          //   原 fire-and-forget：HTTP 可早于落盘返回崩溃即丢回档；且与下方保命回滚读同一 live cache 存写序竞态。
          const _wuRestore = await saveTablesData(username, charName, _rollbackMemData.activeMode, chatId);
          if (_wuRestore && _wuRestore.ok === false) {
            // saveTablesData 失败时磁盘真值未推进，但 _rollbackMemData 是缓存中的 live 对象。
            // 必须同步恢复缓存，否则接口虽返回失败，后续读取仍会看到未落盘的“已回档”表格。
            _rollbackMemData.tables = _safetyTables;
            return {
              success: false,
              applied: false,
              partial: false,
              restored: false,
              error: `回档表格落盘失败: ${_wuRestore.error || "saveTablesData ok=false"}`,
              anchor,
            };
          }
          // ★ P0-2 prune 推迟：pruneSnapshotsAfter 不可逆（删过期快照），推迟到文件层也成功的 commit 点。
          tableRestored = true; snapshotId = snapshot.id; snapshotTimestamp = snapshot.timestamp; tableCount = restoreResult.tables.length;
        }
        let fileRollback = null;
        // ④T1 去谎报：文件层回档失败（抛异常 或 返回非 success）必须如实暴露，
        // 不再吞错后无条件 success:true。success 反映各层真实结果，避免用户误判回档已成功。
        let fileError = null;
        let fileFailedFiles = null;
        let fileRouteDrift = null;
        if (_doFile && ideConnected) {
          try {
            const _fileResult = await ideClient.revertToMessage(
              data.chatId,
              targetIndex,
              expectedCheckpointIds,
              hasExpectedIdeRoute ? data.expectedIdeRoute : undefined,
            );
            // 外层 callTool 与内层 FileCheckpoint 必须同时确认；pending/indeterminate 是
            // “执行端仍可能落地”的未知终态，不能降格成普通失败，更不能继续截断对话。
            const normalizedFile = normalizeRollbackFileResult(
              _fileResult,
              hasExpectedCheckpoints ? expectedCheckpointIds : undefined,
            );
            const _fr = (_fileResult?.result && typeof _fileResult.result === "object")
              ? _fileResult.result
              : (_fileResult || {});
            fileRollback = normalizedFile.fileRollback;
            if (normalizedFile.indeterminate) {
              return {
                success: false,
                applied: true,
                partial: true,
                indeterminate: true,
                pending: normalizedFile.pending,
                restored: tableRestored,
                tableRestored,
                snapshotId,
                snapshotTimestamp,
                tableCount,
                pruned: 0,
                fileRollback,
                fileError: normalizedFile.error,
                checkpointIds: currentCheckpointIds,
                tableSnapshotId: currentTableSnapshotId,
                expectedIdeConnected: hasExpectedIde ? data.expectedIdeConnected : actualIdeRoute.connected,
                expectedIdeRoute: hasExpectedIdeRoute ? data.expectedIdeRoute : actualIdeRoute,
                actualIdeRoute,
                contextSummaryDeleted: 0,
                warning: "文件操作终态未知，禁止重试/截断对话；请等待执行端迟到结果并人工核对。",
              };
            }
            if (!normalizedFile.confirmed) {
              const _errs = (Array.isArray(_fr.errors) && _fr.errors.length) ? _fr.errors.join("; ") : null;
              fileError = !normalizedFile.shapeOk || !normalizedFile.semanticOk
                ? "文件回档执行端返回的协议或计数语义不闭合，无法确认结果；已拒绝继续截断对话"
                : (_errs || normalizedFile.error || "文件回档未成功（执行端未同时确认外层与内层 success:true）");
              if (_fileResult?.drift === "ideRoute" || _fr?.drift === "ideRoute") {
                fileRouteDrift = {
                  drift: "ideRoute",
                  expectedIdeRoute: _fileResult?.expectedIdeRoute ?? _fr?.expectedIdeRoute ?? data.expectedIdeRoute,
                  actualIdeRoute: _fileResult?.actualIdeRoute ?? _fr?.actualIdeRoute ?? ideClient.getRouteSnapshot(data.chatId),
                };
              }
              const _ff = _fr.failedFiles || _fileResult?.failedFiles;
              if (Array.isArray(_ff) && _ff.length) fileFailedFiles = _ff;
            }
          } catch (_err) {
            fileError = _err?.message || String(_err);
            fileRollback = { success: false, partial: false, attempted: 0, reverted: 0, checkpointsReverted: 0, totalRestored: 0, totalDeleted: 0 };
            console.warn("[beilu-memory] rollbackMemory: 文件回档异常:", fileError);
          }
        }
        // 文件层失败时表格仍尽力回到改前状态。但 FileCheckpoint 可能已恢复/删除
        // 部分文件，表格保命成功不能把整体结果重写为“完全不动”。
        if (fileError) {
          const _filePartial = !!fileRollback?.partial
            || (fileRollback?.reverted || 0) > 0
            || (fileRollback?.totalRestored || 0) > 0
            || (fileRollback?.totalDeleted || 0) > 0;
          if (tableRestored && _safetyTables && _rollbackMemData) {
            try {
              _rollbackMemData.tables = _safetyTables;
              // B-4：保命回滚落盘也必须 await+校 .ok；失败则 throw 进下方 catch 升级 safetyRollbackError（fail-safe）。
              //   mode 同上取 _rollbackMemData.activeMode（保命写回的就是它的桶）。
              const _wuSafety = await saveTablesData(username, charName, _rollbackMemData.activeMode, chatId);
              if (_wuSafety && _wuSafety.ok === false) throw new Error(`保命回滚落盘失败: ${_wuSafety.error || "saveTablesData ok=false"}`);
              return {
                success: false,
                applied: _filePartial,
                partial: _filePartial,
                restored: false,
                snapshotId,
                snapshotTimestamp,
                tableCount: 0,
                pruned: 0,
                fileRollback,
                fileError,
                failedFiles: fileFailedFiles,
                ...(fileRouteDrift || {}),
                warning: `文件层回档失败: ${fileError}；表格已恢复到回档前状态，文件层${_filePartial ? "已发生部分变化，请人工核对" : "未确认发生变化，仍应核对后重试"}`,
              };
            } catch (_revErr) {
              const _revMsg = _revErr?.message || String(_revErr);
              console.error("[beilu-memory] rollbackMemory: 保命回滚也失败:", _revMsg);
              return { success: false, applied: true, partial: true, restored: tableRestored, snapshotId, snapshotTimestamp, tableCount, pruned: 0, fileRollback, fileError, failedFiles: fileFailedFiles, ...(fileRouteDrift || {}), safetyRollbackError: _revMsg, warning: `文件层回档失败且表格保命回滚也失败=状态可能不一致，请人工核对（文件层:${fileError}；保命回滚:${_revMsg}）` };
            }
          }
          // 无表格快照（纯文件回档场景）文件层失败 → 表格本就未动，直接如实报告
          return {
            success: false,
            applied: _filePartial,
            partial: _filePartial,
            restored: false,
            snapshotId,
            snapshotTimestamp,
            tableCount: 0,
            pruned: 0,
            fileRollback,
            fileError,
            failedFiles: fileFailedFiles,
            ...(fileRouteDrift || {}),
            warning: `文件层回档失败: ${fileError}；表格层无可恢复快照，文件层${_filePartial ? "已发生部分变化，请人工核对" : "未确认发生变化，仍应核对后重试"}`,
          };
        }
        // ★ commit 点：表格+文件层都成功 → 此刻才 prune（不可逆清理过期快照）。
        // prune 失败不破坏已回档状态（只是残留过期快照），不应使整体 success 翻转。
        if (snapshot) {
          try { pruned = pruneSnapshotsAfter(username, charName, data.chatId, targetIndex); }
          catch (_pruneErr) { console.warn("[beilu-memory] rollbackMemory: prune 过期快照失败(不影响回档结果):", _pruneErr?.message || _pruneErr); }
        }
        // 摘要真值收口：表格+文件层均确认后才推进持久 epoch，建立 rewrite lease。
        // 回档协调入口把 lease 持有到聊天截断的 finally；直接旧入口则在本函数内精确完成。
        // state 一旦存在就禁止 legacy fallback，因此不删角色级模糊归属文件也不会复活旧摘要。
        let contextSummaryDeleted = 0;
        let contextSummaryInvalidated = false;
        let contextSummaryLease = null;
        const contextSummaryCleanupErrors = [];
        let perChatContextSummary = { status: "absent", deleted: false };
        if (data.chatId) {
          try {
            const _summaryRollback = await beginContextSummaryRollback(username, charName, data.chatId);
            if (_summaryRollback?.ok !== true) {
              const _error = new Error(_summaryRollback?.code || "context summary rewrite lease unavailable");
              _error.code = _summaryRollback?.code || "E_CONTEXT_SUMMARY_ROLLBACK_BLOCKED";
              throw _error;
            }
            contextSummaryInvalidated = true;
            contextSummaryDeleted = _summaryRollback.deleted === true ? 1 : 0;
            contextSummaryLease = {
              leaseId: _summaryRollback.leaseId,
              epoch: _summaryRollback.epoch,
              revision: _summaryRollback.revision,
              leaseExpiresAt: _summaryRollback.leaseExpiresAt,
              operationId: _summaryRollback.operationId,
            };
            perChatContextSummary = {
              status: "invalidated",
              deleted: contextSummaryDeleted > 0,
              epoch: _summaryRollback.epoch,
              revision: _summaryRollback.revision,
              ...(typeof _summaryRollback.mirrorError === "string" ? { mirrorWarning: _summaryRollback.mirrorError } : {}),
            };
            if (!_historyCoordinated) {
              const _completed = await completeContextSummaryRollback(username, charName, data.chatId, {
                leaseId: contextSummaryLease.leaseId,
              });
              if (_completed?.completed !== true) {
                const _error = new Error(_completed?.code || "context summary rewrite lease completion failed");
                _error.code = _completed?.code || "E_CONTEXT_SUMMARY_LEASE_COMPLETE_FAILED";
                throw _error;
              }
              contextSummaryLease = null;
              perChatContextSummary.rewriteCompleted = true;
            }
          } catch (_csErr) {
            const _cleanupFailure = {
              scope: "per_chat_state",
              code: _csErr?.code || "E_CONTEXT_SUMMARY_INVALIDATION_FAILED",
              error: _csErr?.message || String(_csErr),
            };
            contextSummaryCleanupErrors.push(_cleanupFailure);
            perChatContextSummary = { status: "failed", deleted: false, code: _cleanupFailure.code, error: _cleanupFailure.error };
            console.warn("[beilu-memory] rollbackMemory: context summary state invalidation failed:", _cleanupFailure.error);
          }
        }
        const fileApplied = fileRollback?.success === true && [
          fileRollback.checkpointsReverted,
          fileRollback.totalRestored,
          fileRollback.totalDeleted,
        ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
        const applied = tableRestored || fileApplied || contextSummaryInvalidated;
        const cleanupError = contextSummaryCleanupErrors.length > 0
          ? contextSummaryCleanupErrors.map((item) => `${item.scope}: ${item.error}`).join("; ")
          : null;
        const result = {
          success: !cleanupError,
          applied,
          partial: !!cleanupError,
          restored: applied,
          snapshotId,
          snapshotTimestamp,
          tableCount,
          pruned,
          fileRollback,
          ideConnected,
          expectedIdeConnected: hasExpectedIde ? data.expectedIdeConnected : actualIdeRoute.connected,
          expectedIdeRoute: hasExpectedIdeRoute ? data.expectedIdeRoute : actualIdeRoute,
          actualIdeRoute,
          checkpointIds: currentCheckpointIds,
          tableSnapshotId: currentTableSnapshotId,
          anchor,
          tableRestored,
          contextSummaryDeleted,
          contextSummaryInvalidated,
          contextSummaryLease,
          perChatContextSummary,
          layers: { table: _doTable, file: _doFile },
          historyCoordinated: _historyCoordinated,
        };
        if (cleanupError) {
          result.cleanupError = cleanupError;
          result.contextSummaryCleanupErrors = contextSummaryCleanupErrors;
          result.error = `回档主体已执行，但 context_summary 清理失败: ${cleanupError}`;
        }
        return result;
      } catch (e) {
        return {
          success: false,
          applied: false,
          error: `记忆回档失败: ${e.message}`,
          ...(typeof e?.code === "string" ? { code: e.code } : {}),
        };
      }
      })());
    }

    // ★ P1-2 只读预览：回档到 targetIndex 前预览文件层会还原/删哪些文件。纯查询，不改任何状态。
    // 注意：原名 "getCheckpointDiff" 与下方面板用的同名 case 撞 label（JS switch 只走第一个），
    // 导致面板按 id 查 diff 恒被本 case 拦截返回"缺少 chatId"。改名为 getRollbackPreview 解冲突（本 case 当前无前端调用方）。
    case "getRollbackPreview": {
      return _withMemoryArchiveCoverage(await (async () => {
      if (!data.chatId) return { success: false, error: "缺少 chatId" };
      try {
        const anchor = await _resolveRollbackAnchor(data.chatId, data.anchorMessageId, data.targetIndex);
        const expectedIdeRoute = ideClient.getRouteSnapshot(data.chatId);
        const ideConnected = expectedIdeRoute.connected;
        const _layers = (data.layers && typeof data.layers === "object") ? data.layers : {};
        const snapshot = _layers.table !== false
          ? findSnapshotForRollback(username, charName, data.chatId, anchor.index)
          : null;
        const tableSnapshotId = snapshot?.id || null;
        if (!ideConnected || _layers.file === false) {
          return {
            success: true,
            applied: false,
            anchor,
            ideConnected,
            expectedIdeConnected: ideConnected,
            expectedIdeRoute,
            checkpointIds: [],
            tableSnapshotId,
            checkpointsToRevert: 0,
            filesToRestore: [],
            filesToDelete: [],
          };
        }
        const _r = await ideClient.getCheckpointDiff(
          data.chatId,
          anchor.index,
          undefined,
          expectedIdeRoute,
        );
        const previewEnvelope = _readCheckpointPreviewEnvelope(_r);
        if (previewEnvelope.ok) {
          const _d = previewEnvelope.result;
          return {
            success: true,
            applied: false,
            anchor,
            ideConnected: true,
            expectedIdeConnected: true,
            expectedIdeRoute,
            checkpointIds: _d.checkpointIds,
            tableSnapshotId,
            checkpointsToRevert: _d.checkpointsToRevert || 0,
            filesToRestore: _d.filesToRestore || [],
            filesToDelete: _d.filesToDelete || [],
          };
        }
        return {
          success: false,
          applied: false,
          error: previewEnvelope.error || "回档预览未成功",
          ideConnected: true,
          expectedIdeRoute,
          ...(_r?.drift ? {
            drift: _r.drift,
            actualIdeRoute: _r.actualIdeRoute,
          } : {}),
          anchor,
        };
      } catch (e) {
        return {
          success: false,
          applied: false,
          error: `回档预览失败: ${e.message}`,
          ...(typeof e?.code === "string" ? { code: e.code } : {}),
        };
      }
      })());
    }

    case "listTableSnapshots": {
      // 修2 断链A（20260716）：快照列表按查看桶过滤——原全量返回=三模式所有窗口快照混列，
      //   恢复别桶快照必污染当前桶。mode 走 _resolveTableMode 与归档族/读端同源（前端 _archiveAction 送 mode）；
      //   旧无 mode 快照（legacy）保留显示（向后兼容，恢复时按查看桶处理）。
      try {
        const _tMode = _resolveTableMode(data, username, charName, chatId);
        const _all = listTableSnapshots(username, charName);
        return { success: true, mode: _tMode, snapshots: _all.filter((s) => !s.mode || s.mode === _tMode) };
      } catch (e) {
        return { success: false, error: e.message, ...(typeof e?.code === "string" ? { code: e.code } : {}) };
      }
    }

    case "restoreTableSnapshot": {
      // 前端表格快照面板恢复入口（与 layout-memtool 的记忆快照 restoreSnapshot 是不同系统）
      // 修2 断链A（20260716）：桶路由收口。原 loadMemoryData(undefined)=按会话 active_mode 写桶，
      //   与 UI 读桶（getDataHandler viewMode）分叉——viewMode≠active_mode 时恢复写进另一桶：
      //   界面重载纹丝不动（「恢复不了」）+ 另一桶被整套覆盖（静默污染）。归档族 20260712 已把这缝
      //   收口到 _resolveTableMode，快照族漏在收口外，本修补齐。快照自带 mode（创建时所记的桶归属）
      //   时必须与查看桶一致才恢复——跨桶恢复=把 A 桶整套表写进 B 桶；legacy 无 mode 快照按查看桶恢复。
      try {
        const _snapId = data.snapshotId;
        if (!_snapId) return { success: false, error: "缺少 snapshotId" };
        const _tMode = _resolveTableMode(data, username, charName, chatId);
        const _rResult = restoreTableSnapshot(username, charName, _snapId, { chatId });
        if (!_rResult.success) {
          return {
            success: false,
            error: _rResult.error,
            ...(_rResult.code ? { code: _rResult.code } : {}),
            ...(_rResult.drift ? { drift: _rResult.drift } : {}),
            ...(_rResult.expectedScope ? { expectedTableSnapshotScope: _rResult.expectedScope } : {}),
            ...(_rResult.actualScopes ? { actualTableSnapshotScopes: _rResult.actualScopes } : {}),
          };
        }
        if (_rResult.mode && _rResult.mode !== _tMode) {
          return { success: false, error: `快照属于「${_rResult.mode}」模式表格，当前查看「${_tMode}」，不跨桶恢复（切到对应模式再恢复）` };
        }
        clearCharCache(username, charName);
        const _memData = loadMemoryData(username, charName, _tMode, chatId);
        _memData.tables = _rResult.tables;
        const _wuResult = await saveTablesData(username, charName, _tMode, chatId);
        if (_wuResult && _wuResult.ok === false) return { success: false, error: `表格落盘失败: ${_wuResult.error}` };
        return { success: true, snapshotId: _snapId, mode: _tMode };
      } catch (e) {
        return { success: false, error: e.message, ...(typeof e?.code === "string" ? { code: e.code } : {}) };
      }
    }

    // === IDE 写操作审批 ===
    case "getIdeApprovals": {
      // ★ 多窗口会话隔离：传 chatid 时只返回本会话 pending（与 approveAll/rejectAll 收口一致，
      //   dock 显示 = 批准范围）。不传则返回全量（向后兼容）。entry.chatid 入队取 _qcid，
      //   正常回合 = 真实 chatid；合成键项无主，不匹配任一会话 → 各会话 dock 都不显示亦不批。
      // SEC 破口D：在会话作用域之上再叠加 owner 过滤——只返回属主===当前用户的 op，杜绝原"不传 chatid
      //   则全量返回"泄漏他人 pending(含 opId/path/command)。无 chatid 的 op 不归任何用户，不返回。
      const _gaSession = data.chatid || data.chatId || args?.chatid || null;
      const _gaMine = [];
      for (const o of (ideClient.pendingApprovals || [])) {
        if (o.status !== "pending") continue;
        if (_gaSession != null && o.chatid !== _gaSession) continue;
        if (!o.chatid || (await _resolveChatOwner(o.chatid)) !== username) continue;
        _gaMine.push(o);
      }
      return {
        success: true,
        pendingApprovals: _gaMine,
        requireWriteApproval: ideClient.getRequireWriteApproval(username), // SEC 破口C: per-user
        ideConnected: ideClient.isConnected,
      };
    }

    case "setAutoContinueConfig": {
      // 「操作后自动继续」面板设置后端单源写口（消费端=generation.getAutoContinueConfig：
      // 回合末续轮两处 + 上方审批完成续轮，同门控同延迟 + loop 续轮）。
      const _acEnabled = data.enabled !== false;
      const _acDelay = Math.max(0, Math.min(30000, Number(data.delay_ms) || 0));
      const _loopEnabled = !!data.loop_enabled;
      const _loopText = typeof data.loop_inject_text === "string" ? data.loop_inject_text : "";
      // [0724 双停退出] AI 连续 N 轮 <stopContinue/> 停 loop 的阈值（002「连续输出两次停止」→默认2；0=关闭双停出口）
      const _loopStopN = Number.isInteger(Number(data.loop_stop_threshold)) && Number(data.loop_stop_threshold) >= 0
        ? Math.min(99, Number(data.loop_stop_threshold)) : 2;
      // [0726 容错修] 连续续轮轮数上限（0=禁用；默认 50 口径在 generation.getAutoContinueConfig 单源）
      const _maxRounds = Number.isInteger(Number(data.max_auto_rounds)) && Number(data.max_auto_rounds) >= 0
        ? Math.min(999, Number(data.max_auto_rounds)) : 50;
      // [T4 0805] mode="work" → 写 work_auto_continue（凛倾方案B独立配置：work 面板独立于 code 面板，
      //   消费端 generation.getAutoContinueConfig(username,"work") 优先读 work 键、缺键回退 auto_continue）。
      //   同一 verb 同一归一化口径复用，不另开写口——updateConfig 写的是 per-char memory/_config.json，
      //   消费端读 user 级 yonban_config.json，走那条=读写不同源死配置。
      const _acKey = data.mode === "work" ? "work_auto_continue" : "auto_continue";
      const _acVal = { enabled: _acEnabled, delay_ms: _acDelay, loop_enabled: _loopEnabled, loop_inject_text: _loopText, loop_stop_threshold: _loopStopN, max_auto_rounds: _maxRounds };
      await updateYonbanConfig(username, (cfg) => {
        cfg[_acKey] = _acVal;
      });
      return { success: true, auto_continue: _acVal };
    }

    case "getAutoContinueConfig": {
      // [0724 只许前端关] 面板初始化读口：后端 yonban_config.auto_continue 是唯一真源，前端 init
      //   改为"读后端回填面板"（原 init 把 localStorage/面板默认值推后端=换浏览器/清缓存时用默认值
      //   静默覆写用户配置，loop_enabled 被翻 false 即"自动继续被别处关闭"事故源之一）。
      //   默认值口径复用 generation.getAutoContinueConfig 单源（与消费端逐字段一致，不复制第二份）。
      const _gacGenPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "generation.mjs");
      const { pathToFileURL: _gacPfu } = await import("node:url");
      const _gacGen = await import(_gacPfu(_gacGenPath).href);
      // [T4 0805] data.mode="work" → 返回 work 生效值（work_auto_continue 覆盖、缺键回退全局），
      //   与消费端 generation 同一函数同一口径——work 面板显示的即当前实际生效配置。
      return { success: true, auto_continue: _gacGen.getAutoContinueConfig(username, data?.mode) };
    }

    case "setCloneAsyncConfig": {
      // [0726 分身异步·002] 分身异步开关面板写口（消费端=replyHandler 分身执行块判分支 +
      //   generation.getCloneAsyncConfig 唤醒延迟）。enabled 显式 true 才异步，默认同步不变。
      const _caEnabled = data.enabled === true;
      const _caWakeDelay = Math.max(0, Math.min(30000, Number(data.wake_delay_ms) || 0));
      await updateYonbanConfig(username, (cfg) => {
        cfg.clone_async = { enabled: _caEnabled, wake_delay_ms: _caWakeDelay };
      });
      return { success: true, clone_async: { enabled: _caEnabled, wake_delay_ms: _caWakeDelay } };
    }

    case "getCloneAsyncConfig": {
      // [0726 分身异步] 面板初始化读口：默认值口径复用 generation.getCloneAsyncConfig 单源
      //   （与消费端逐字段一致，不复制第二份——同 getAutoContinueConfig 范式）。
      const _gcaGenPath = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib", "generation.mjs");
      const { pathToFileURL: _gcaPfu } = await import("node:url");
      const _gcaGen = await import(_gcaPfu(_gcaGenPath).href);
      return { success: true, clone_async: _gcaGen.getCloneAsyncConfig(username) };
    }

    case "getActiveClones": {
      // [0726 五修#4] 在飞分身查询口（listActiveClones 此前全仓零消费者）：前端面板/诊断可查在跑清单；
      //   AI 侧等待期感知走 {{clone_runtime}} 的 running 快照（异步派发即写），不经此口。
      const { listActiveClones: _gacList } = await import("./cloneAbort.mjs");
      return { success: true, clones: _gacList(username, (data.chatid !== undefined && data.chatid !== "") ? data.chatid : undefined) };
    }

    case "stopCloneTask": {
      // [0724 分身可停·002「我需要可以关闭分身,无论是本体还有yonban」] 停止在跑分身：
      //   taskId 精确停一个；缺省 taskId=停该会话全部。仅触发该任务 AbortController
      //   （replyHandler 分身循环轮界/在飞 API 即断），产出走既有 user_aborted 收尾链
      //   （终态广播 stopped + 可续接快照照落，可 resumeTaskId 续接）。
      //   调用方：本体 backendMonitor 分身区 ⏹ / YonBan 分身进度面板 ⏹（经 _callPluginApi 中转）。
      const _sctChat = data.chatid || data.chatId || "";
      const _sctTask = (data.taskId !== undefined && data.taskId !== null && String(data.taskId) !== "") ? String(data.taskId) : undefined;
      const { abortClones: _sctAbort } = await import("./cloneAbort.mjs");
      const _sctN = _sctAbort(username, { chatid: _sctChat !== "" ? _sctChat : undefined, taskId: _sctTask });
      console.log(`[beilu-memory] stopCloneTask: chatid=${_sctChat || "(全部)"}, taskId=${_sctTask || "(全部)"}, aborted=${_sctN}`);
      return { success: true, aborted: _sctN };
    }

    case "setScheduledContinue": {
      const { charName, chatid: _scChatid, enabled: _scEnabled, days: _scDays, time: _scTime, content: _scContent } = data;
      if (!charName) return { success: false, error: "缺少 charName" };
      const _scheduler = await import("../../notification/scheduler.mjs");
      const _scList = _scheduler.listJobs(username, charName);
      const _scExisting = (_scList.jobs || []).find((j) => j.tags?.includes("scheduled_continue"));
      if (!_scEnabled) {
        if (_scExisting) {
          const _memDir0 = (await import("../../memory/storage_mod/storage.mjs")).getMemoryDir(username, charName);
          _scheduler.startScheduler(username, charName, _memDir0);
          _scheduler.removeJob(username, charName, _scExisting.id);
        }
        return { success: true, removed: true };
      }
      const [_scHH, _scMM] = (_scTime || "09:00").split(":").map(Number);
      const _scDow = Array.isArray(_scDays) && _scDays.length > 0 ? _scDays.join(",") : "*";
      const _scCron = `${_scMM || 0} ${_scHH || 9} * * ${_scDow}`;
      const _scActionType = _scContent ? "message" : "auto_reply";
      const _memDir = (await import("../../memory/storage_mod/storage.mjs")).getMemoryDir(username, charName);
      _scheduler.startScheduler(username, charName, _memDir);
      if (_scExisting) {
        _scheduler.updateJob(username, charName, _scExisting.id, {
          schedule: { type: "cron", cron: _scCron },
          action: { type: _scActionType, content: _scContent || "", target: { chatid: _scChatid || null } },
          description: _scContent ? _scContent.slice(0, 50) : "定时自动继续",
          enabled: true,
        });
      } else {
        _scheduler.addJob(username, charName, {
          name: "定时继续",
          description: _scContent ? _scContent.slice(0, 50) : "定时自动继续",
          schedule: { type: "cron", cron: _scCron },
          action: { type: _scActionType, content: _scContent || "", target: { chatid: _scChatid || null } },
          chatid: _scChatid || null,
          tags: ["scheduled_continue"],
        });
      }
      return { success: true, cron: _scCron };
    }

    case "setAdvancedLimits": {
      const _saved = {};
      // PPT 连续执行预算 → PPT 插件 SetData
      if (data.ppt_budget !== undefined) {
        const _n = Math.max(0, Math.round(Number(data.ppt_budget) || 0));
        try {
          const _ppt = (await import("../../../../../public/parts/plugins/beilu-ppt/main.mjs")).default;
          await _ppt.interfaces?.config?.SetData?.({ maxOpsPerUserTurn: _n });
          _saved.ppt_budget = _n;
        } catch (e) { _saved.ppt_budget_error = e?.message; }
      }
      // 委派最大轮次 / 模式切换上限 / 定时任务节流 / 历史改写静默时限 → yonban_config.advanced_limits
      const _updates = {};
      if (data.delegate_max_rounds !== undefined) _updates.delegate_max_rounds = Math.max(0, Math.round(Number(data.delegate_max_rounds) || 0));
      if (data.switch_loop_max !== undefined) _updates.switch_loop_max = Math.max(0, Math.round(Number(data.switch_loop_max) || 0));
      if (data.scheduler_pacing !== undefined) _updates.scheduler_pacing = !!data.scheduler_pacing;
      if (data.history_rewrite_worker_settle_timeout_ms !== undefined) {
        const { resolveHistoryRewriteWorkerSettleTimeoutMs } = await import("../../../transport/historyRewritePolicy.mjs");
        _updates.history_rewrite_worker_settle_timeout_ms = resolveHistoryRewriteWorkerSettleTimeoutMs(
          data.history_rewrite_worker_settle_timeout_ms,
        );
      }
      if (Object.keys(_updates).length) {
        await updateYonbanConfig(username, (cfg) => { cfg.advanced_limits = { ...(cfg.advanced_limits || {}), ..._updates }; });
        Object.assign(_saved, _updates);
      }
      return { success: true, saved: _saved };
    }

    case "approveIdeOp": {
      if (!data.opId) return { success: false, error: "缺少 opId" };
      const _apOp = (ideClient.pendingApprovals || []).find((o) => o.id === data.opId);
      if (!_apOp) return { success: false, error: "操作不存在" };
      // SEC 破口D：只能批准【属于自己会话】的 op（owner 谓词），防 A 批准 B 的 IDE 写/命令(跨用户代执行)。
      //   有 chatid 的 op 必须解出属主 === 当前用户；解不出(import 失败/未命中)亦拒(fail-closed)。
      if (_apOp.chatid && (await _resolveChatOwner(_apOp.chatid)) !== username)
        return { success: false, error: "无权批准该操作（不属于你的会话）" };
      const _apResult = await ideClient.approveOperation(data.opId);
      // T7-S1：采集 approve 行为信号（target=op 工具类型）。
      try { appendBehaviorSignal(username, charName, { type: "approve", target: _apOp?.tool || "", action: "approveIdeOp" }); } catch { /* 信号采集失败不影响主流程 */ }
      // ★ W66修复：审批后广播 tool_results_ready，触发自动继续
      // 0715 断链修：chatid 首选 op 自带值（入队时记录=权威源）。YonBan IDE 侧 approveIdeOp 只传 opId
      // 不带 chatid，原实现取调用方参数落空串 → 广播+续轮整段跳过（IDE 侧批准后 AI 零反应）。
      _broadcastToolResultsReady(ideClient, _apOp.chatid || data.chatid || data.chatId || args?.chatid || "", username);
      return _apResult;
    }

    case "rejectIdeOp": {
      if (!data.opId) return { success: false, error: "缺少 opId" };
      const _rjOp = (ideClient.pendingApprovals || []).find((o) => o.id === data.opId);
      if (!_rjOp) return { success: false, error: "操作不存在" };
      // SEC 破口D：只能拒绝属于自己会话的 op（防 A 拒/干预 B 的待审批操作）。
      if (_rjOp.chatid && (await _resolveChatOwner(_rjOp.chatid)) !== username)
        return { success: false, error: "无权操作该审批项（不属于你的会话）" };
      const _rjResult = ideClient.rejectOperation(data.opId);
      // T7-S1：采集 reject 行为信号。
      try { appendBehaviorSignal(username, charName, { type: "reject", target: _rjOp?.tool || "", action: "rejectIdeOp" }); } catch { /* 信号采集失败不影响主流程 */ }
      // 0715 断链修：同 approveIdeOp——chatid 首选 op 自带值，兜住 IDE 侧无 chatid 调用方
      _broadcastToolResultsReady(ideClient, _rjOp.chatid || data.chatid || data.chatId || args?.chatid || "", username);
      return _rjResult;
    }

    case "approveAllIdeOps": {
      const _aaSession = data.chatid || data.chatId || args?.chatid || null;
      const _aaTargets = [];
      for (const o of (ideClient.pendingApprovals || [])) {
        if (o.status !== "pending") continue;
        if (_aaSession != null && o.chatid !== _aaSession) continue;
        if (o.chatid && (await _resolveChatOwner(o.chatid)) !== username) continue;
        _aaTargets.push(o);
      }
      const _aaResults = [];
      for (const o of _aaTargets) _aaResults.push(await ideClient.approveOperation(o.id));
      try { for (const o of _aaTargets) appendBehaviorSignal(username, charName, { type: "approve", target: o.tool || "", action: "approveAllIdeOps" }); } catch { /* 信号采集失败不影响主流程 */ }
      // 0715 断链修：无 session 的调用方（YonBan IDE 侧）原落空串=零续轮。改按被批 op 的实际 chatid
      // 集合逐会话广播+续轮（多会话各自接住自己的结果）。
      const _aaChatids = [...new Set(_aaTargets.map((o) => o.chatid).filter(Boolean))];
      if (_aaChatids.length === 0 && _aaSession) _aaChatids.push(_aaSession);
      for (const _aaCid of _aaChatids) _broadcastToolResultsReady(ideClient, _aaCid, username);
      return { success: true, results: _aaResults };
    }

    case "rejectAllIdeOps": {
      const _raSession = data.chatid || data.chatId || args?.chatid || null;
      const _raTargets = [];
      for (const o of (ideClient.pendingApprovals || [])) {
        if (o.status !== "pending") continue;
        if (_raSession != null && o.chatid !== _raSession) continue;
        if (o.chatid && (await _resolveChatOwner(o.chatid)) !== username) continue;
        _raTargets.push(o);
      }
      const _raResults = [];
      for (const o of _raTargets) _raResults.push(ideClient.rejectOperation(o.id));
      try { for (const o of _raTargets) appendBehaviorSignal(username, charName, { type: "reject", target: o.tool || "", action: "rejectAllIdeOps" }); } catch { /* 信号采集失败不影响主流程 */ }
      // 0715 断链修：同 approveAllIdeOps——按被拒 op 的实际 chatid 集合逐会话广播+续轮
      const _raChatids = [...new Set(_raTargets.map((o) => o.chatid).filter(Boolean))];
      if (_raChatids.length === 0 && _raSession) _raChatids.push(_raSession);
      for (const _raCid of _raChatids) _broadcastToolResultsReady(ideClient, _raCid, username);
      return { success: true, results: _raResults };
    }

    case "setIdeWriteApproval": {
      // SEC 破口C：写审批开关 per-user——只改当前请求用户的值，不再是全局单值殃及他人。
      if (data.requireApproval !== undefined) {
        ideClient.setRequireWriteApproval(username, !!data.requireApproval);
      }
      return { success: true, requireWriteApproval: ideClient.getRequireWriteApproval(username) };
    }

    // === ★ F6「此类不再问」审批跳过规则（per-user，落 data/users/<u>/ide_approval_rules.json）===
    // 规则结构：{ rules: [{ tool, pathPrefix, createdAt }] }。入队门(replyHandler)按 (tool, pathPrefix) 命中放行。
    // ★ 多开实例绑定（2026-07-26 多窗口 YonBan 支持）：YonBan 窗口 selectChat/重连时上报
    //   「本会话由端口 N 的实例服务」→ ideClient 连接池按绑定路由该会话的全部 IDE 工具/检查点/提问。
    //   功能链：YonBanProvider switchChat → ChatService.bindIdeInstance → 本 case → ideClient.bindChat。
    case "bindIdeInstance": {
      // 取值源：data=POST body（YonBan ChatService 发 {_action, chatid, port}）；args 仅兜底（同库 _raSession 先例口径）
      const _biChatid = data.chatid || data.chat_id || args?.chatid || null;
      const _biPort = Number(data.port ?? args?.port);
      if (!_biChatid || !Number.isFinite(_biPort)) return { success: false, error: "缺少 chatid 或 port" };
      const _biAuthUsername = typeof args?.username === "string" ? args.username.trim() : "";
      if (!_biAuthUsername) return { success: false, error: "bindIdeInstance 缺少认证 username" };
      const _biOwner = await _resolveChatOwner(_biChatid);
      if (!_biOwner || _biOwner !== _biAuthUsername) {
        return { success: false, error: "无权绑定该对话的 IDE 实例" };
      }
      const _biInstanceId = data.instanceId == null ? null : String(data.instanceId).trim();
      if (data.instanceId != null && !_biInstanceId) return { success: false, error: "instanceId 无效" };
      if (ideClient.registerChatOwner?.(_biChatid, _biAuthUsername) === false) {
        return { success: false, error: "会话 owner 绑定冲突" };
      }
      // [绑定来源 0726] source="manual"=用户在 ＋号 里明确指定执行端（粘性，不被自动上报覆盖）；
      //   缺省/"auto"=窗口打开某对话时的自动上报（弱）。缺省保持旧语义，YonBan 旧版不传也不报错。
      return ideClient.bindChat(_biChatid, _biPort, data.source === "manual" ? "manual" : "auto", _biInstanceId);
    }

    case "unbindIdeInstance": {
      const _ubChatid = data.chatid || data.chat_id || args?.chatid || null;
      if (!_ubChatid) return { success: false, error: "缺少 chatid" };
      const _ubAuthUsername = typeof args?.username === "string" ? args.username.trim() : "";
      if (!_ubAuthUsername) return { success: false, error: "unbindIdeInstance 缺少认证 username" };
      const _ubOwner = await _resolveChatOwner(_ubChatid);
      if (!_ubOwner || _ubOwner !== _ubAuthUsername) {
        return { success: false, error: "无权解绑该对话的 IDE 实例" };
      }
      return ideClient.unbindChat(_ubChatid);
    }

    // 连接池状态快照（实例列表+会话绑定表+主端口），供 YonBan/前端展示「本窗口是否被本体连接/路由」。
    case "getIdeInstances": {
      try {
        return { success: true, ...ideClient.getIdeInstances() };
      } catch (e) {
        return { success: false, error: e?.message || String(e) };
      }
    }

    case "getApprovalRules": {
      try {
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        const _rules = Array.isArray(_arData?.rules) ? _arData.rules : [];
        // ★ FT2 区外开关：默认 true=完全访问工作区外（缺字段向后兼容为开放）。
        const _allowOutside = _arData?.allowOutsideWorkspace !== false;
        // ★ FT2 需求 A：返回 activeTemplate（当前档 id）+ templates[]（四内置档元数据）供前端档位徽章渲染。
        //   activeTemplate 取持久化字段；缺省时按规则集是否含 user 来源粗判 custom，否则 collab（默认档）。
        const _hasUserRule = _rules.some((r) => r && r.source === "user");
        const _activeTemplate = (typeof _arData?.activeTemplate === "string" && _arData.activeTemplate)
          ? _arData.activeTemplate
          : (_hasUserRule ? "custom" : "collab");
        return {
          success: true,
          rules: _rules,
          allowOutsideWorkspace: _allowOutside,
          activeTemplate: _activeTemplate,
          templates: _PERMISSION_TEMPLATES_META,
          // 0715 硬编码收口：工具集下发（权威=commandGate.mjs），前端 toolSets.mjs syncToolSets 覆盖静态兜底，
          // 根治 messageList/workPanel/permissionPanel 三处前端副本漂移（分身扫描 F1/F6/D1）。
          toolSets: {
            fileEditTools: [...FILE_EDIT_TOOLS],
            permissionWriteTools: [...PERMISSION_WRITE_TOOLS],
            writeToolsAll: [...WRITE_TOOLS_ALL],
          },
        };
      } catch (e) { return { success: false, error: e.message, rules: [] }; }
    }

    // N46「总是允许」：从一条 pending op（或直接给的 {tool,pathPrefix}）派生规则并去重落盘。
    // 本 action 只落规则不动队列；当前这条 op 的去向由前端配对 action 决定（N46 起配对 approveIdeOp=本条执行，
    //  旧「此类不再问」配对 rejectIdeOp 已弃用）。下一轮 AI 再发同类操作时由规则在入队门放行。
    case "addApprovalSkipRule": {
      try {
        let _rule = null;
        if (data.tool && typeof data.pathPrefix === "string") {
          _rule = { tool: data.tool, pathPrefix: data.pathPrefix };
        } else if (data.opId) {
          const _op = (ideClient.pendingApprovals || []).find((o) => o.id === data.opId);
          if (!_op) return { success: false, error: "操作未找到" };
          _rule = deriveApprovalSkipRule(_op);
        }
        if (!_rule || !_rule.tool) return { success: false, error: "无法派生规则（缺 tool/pathPrefix 或 opId）" };
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        if (!Array.isArray(_arData.rules)) _arData.rules = [];
        const _dup = _arData.rules.some((r) => r && r.tool === _rule.tool && String(r.pathPrefix || "") === String(_rule.pathPrefix || ""));
        if (!_dup) {
          _arData.rules.push({ tool: _rule.tool, pathPrefix: _rule.pathPrefix || "", createdAt: new Date().toISOString() });
          const _arDir = path.dirname(_arPath);
          if (!fs.existsSync(_arDir)) fs.mkdirSync(_arDir, { recursive: true });
          saveJsonFile(_arPath, _arData);
        }
        try { appendBehaviorSignal(username, charName, { type: "approve", target: _rule.tool, action: "addApprovalSkipRule" }); } catch { /* 信号采集失败不影响主流程 */ }
        return { success: true, rule: _rule, rules: _arData.rules };
      } catch (e) { return { success: false, error: e.message }; }
    }

    case "removeApprovalRule": {
      try {
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        if (!Array.isArray(_arData.rules)) _arData.rules = [];
        const _before = _arData.rules.length;
        if (data.tool !== undefined) {
          // ★ FT2：glob 规则用 (tool, glob) 精确定位；前缀规则用 (tool, pathPrefix)，避免误删同 tool 其它 glob。
          const _hasGlobKey = typeof data.glob === "string" && data.glob.length > 0;
          _arData.rules = _arData.rules.filter((r) => {
            if (!r || r.tool !== data.tool) return true;
            if (_hasGlobKey) return String(r.glob || "") !== data.glob;            // 删指定 glob
            return !(String(r.pathPrefix || "") === String(data.pathPrefix || "") && !r.glob); // 删前缀规则
          });
        } else if (data.index !== undefined) {
          _arData.rules.splice(Number(data.index), 1);
        }
        saveJsonFile(_arPath, _arData);
        return { success: true, removed: _before - _arData.rules.length, rules: _arData.rules };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // ★ FT2：区外访问开关（KILO 式权限管理）。持久化 allowOutsideWorkspace 字段到规则文件。
    //   true=AI 完全访问工作区外（默认）；false=区外回 ask（非 forced，引擎层裁决）。
    //   注：本开关不影响 _forceApproval 敏感命令强制确认（那条永远 forced ask，不可关）。
    case "setAllowOutsideWorkspace": {
      try {
        const _enabled = data.allowOutsideWorkspace !== false; // 显式 false 才关闭，其余=开放
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        if (!Array.isArray(_arData.rules)) _arData.rules = [];
        _arData.allowOutsideWorkspace = _enabled;
        const _arDir = path.dirname(_arPath);
        if (!fs.existsSync(_arDir)) fs.mkdirSync(_arDir, { recursive: true });
        saveJsonFile(_arPath, _arData);
        return { success: true, allowOutsideWorkspace: _enabled };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // === mcpConnect 人工审查队列 ===
    case "getMcpConnectRequests": {
      const _requestChatId = data.chatId || data.chatid || args?.chatid || "";
      if (!_requestChatId) return { success: false, error: "缺少 chatId，不能读取 MCP 请求" };
      return {
        success: true,
        chatId: _requestChatId,
        requests: listMcpConnectRequests(username, { chatId: _requestChatId }),
      };
    }

    case "beginMcpConnectRequestImport": {
      const _requestChatId = data.chatId || data.chatid || args?.chatid || "";
      if (!_requestChatId) return { success: false, error: "缺少 chatId，不能开始导入 MCP 请求" };
      let _editedMcpConfig;
      try {
        const _editedText = typeof data.importText === "string" ? data.importText.trim() : "";
        if (!_editedText) throw new Error("缺少用户审查后的 MCP 配置");
        _editedMcpConfig = JSON.parse(_editedText);
      } catch (e) {
        return { success: false, errorCode: "invalid_mcp_config", error: `MCP 配置 JSON 无效: ${e.message}` };
      }
      const _editedValidation = normalizeMcpConnectConfig(_editedMcpConfig);
      if (_editedValidation.validationError) {
        return {
          success: false,
          errorCode: "invalid_mcp_config",
          error: _editedValidation.validationError,
        };
      }
      const _result = await transitionMcpConnectRequest({
        username,
        requestId: data.requestId,
        chatId: _requestChatId,
        nextStatus: "importing",
      });
      if (_result.success && !_result.unchanged) {
        await _broadcastMcpConnectRequestsChanged(username, _result.request);
      }
      return _result;
    }

    case "finishMcpConnectRequestImport": {
      const _requestChatId = data.chatId || data.chatid || args?.chatid || "";
      if (!_requestChatId) return { success: false, error: "缺少 chatId，不能更新 MCP 导入结果" };
      if (typeof data.importSucceeded !== "boolean") {
        return { success: false, error: "缺少 importSucceeded 导入结果" };
      }
      const _reportedParts = Array.isArray(data.importedParts)
        ? data.importedParts.map(String)
        : [];
      const _validMcpParts = _reportedParts.length > 0 &&
        _reportedParts.every((part) => /^plugins\/mcp_[^/\\]+$/.test(part));
      const _importSucceeded = data.importSucceeded && _validMcpParts;
      const _importError = data.importSucceeded && !_validMcpParts
        ? "导入响应未包含有效 MCP 插件"
        : data.importError;
      const _result = await transitionMcpConnectRequest({
        username,
        requestId: data.requestId,
        chatId: _requestChatId,
        nextStatus: _importSucceeded ? "imported" : "import_failed",
        importError: _importError,
        importedParts: _reportedParts,
      });
      if (_result.success && !_result.unchanged) {
        await _broadcastMcpConnectRequestsChanged(username, _result.request);
      }
      return _result;
    }

    case "dismissMcpConnectRequest": {
      const _requestChatId = data.chatId || data.chatid || args?.chatid || "";
      if (!_requestChatId) return { success: false, error: "缺少 chatId，不能忽略 MCP 请求" };
      const _result = await transitionMcpConnectRequest({
        username,
        requestId: data.requestId,
        chatId: _requestChatId,
        nextStatus: "dismissed",
      });
      if (_result.success && !_result.unchanged) {
        await _broadcastMcpConnectRequestsChanged(username, _result.request);
      }
      return _result;
    }

    // === IDE 工具结果（自动继续轮询用） ===
    case "getPendingIdeResults": {
      const _pendingChatid = data.chatid || data.chatId || args?.chatid || null;
      const _pendingResults = ideClient.getPendingResults({
        ownerUsername: username,
        chatid: _pendingChatid || undefined,
      });
      return {
        hasPending: _pendingResults.length > 0,
        count: _pendingResults.length,
        ideConnected: ideClient.isConnectedFor(_pendingChatid),
      };
    }

    case "getToolRuntimeConfig": {
      const _runtimeState = readToolRuntimeConfigState(username);
      return {
        ..._runtimeState.config,
        _source: _runtimeState.source,
        _persisted: _runtimeState.persisted,
        _error: _runtimeState.error,
      };
    }

    case "setToolRuntimeConfig": {
      const _runtimePatch = data.patch && typeof data.patch === "object" && !Array.isArray(data.patch)
        ? data.patch
        : null;
      const _savedRuntime = await updateYonbanConfig(username, (cfg) => {
        const _currentRuntime = Object.hasOwn(cfg, "tool_runtime")
          ? normalizeToolRuntimeConfigForRecovery(cfg.tool_runtime)
          : normalizeToolRuntimeConfig();
        const _rawRuntime = _runtimePatch
          ? { ..._currentRuntime, ..._runtimePatch }
          : (data.tool_runtime && typeof data.tool_runtime === "object" && !Array.isArray(data.tool_runtime)
              ? data.tool_runtime
              : data);
        const _normalizedRuntime = normalizeToolRuntimeConfig(_rawRuntime);
        cfg.tool_runtime = _normalizedRuntime;
        return _normalizedRuntime;
      }, {}, { strictRead: true });
      return {
        ..._savedRuntime,
        _source: "persisted",
        _persisted: true,
        _error: null,
      };
    }

    case "getSystemRuntimeSnapshot": {
      const _runtimeChatid = data.chatid || data.chatId || args?.chatid || null;
      return {
        tool: ideClient.getRuntimeSnapshot(_runtimeChatid, username),
        mcp: getMcpRuntimeSnapshot(username),
      };
    }

    // === IDE 操作历史（操作监控面板用） ===
    case "getIdeOperationHistory": {
      const _historyChatid = data.chatid || data.chatId || args?.chatid || null;
      const _runtimeConfig = readToolRuntimeConfig(username);
      const history = ideClient.getOperationHistory({
        ownerUsername: username,
        chatid: _historyChatid || undefined,
        limit: _runtimeConfig.history_limit,
      });
      const total = history.length;
      const success = history.filter(h => h.success).length;
      const failed = total - success;
      return {
        history,
        jobs: ideClient.getToolJobs({
          ownerUsername: username,
          chatid: _historyChatid || undefined,
          limit: _runtimeConfig.history_limit,
        }),
        stats: { total, success, failed },
      };
    }

    case "clearIdeOperationHistory": {
      const _clearChatid = data.chatid || data.chatId || args?.chatid || null;
      const clearedHistory = ideClient.clearOperationHistory({
        ownerUsername: username,
        chatid: _clearChatid || undefined,
      });
      ideClient.clearTerminalToolJobs(_clearChatid, username);
      return { success: true, clearedHistory };
    }

    // === checkpoint 管理面板（前端 idePanel 调，经 YonBan _checkpoint_* 工具）===
    case "getCheckpointList": {
      try {
        // [多开 0726] 带 chatid 路由到会话所绑窗口（检查点存在各窗口本地）；无 chatid=主连接（本体全局面板语义）
        const r = await ideClient.callTool("_checkpoint_list", {}, undefined, undefined, { chatid: data.chatid || args?.chatid || null });
        const inner = r?.result ?? r;
        return { success: r?.success !== false, checkpoints: inner?.checkpoints || [] };
      } catch (e) {
        return { success: false, error: e?.message, checkpoints: [] };
      }
    }

    case "getCheckpointDiff": {
      if (!data.id) return { success: false, error: "缺少 id", files: [] };
      try {
        const r = await ideClient.callTool("_checkpoint_get_diff", { id: data.id }, undefined, undefined, { chatid: data.chatid || args?.chatid || null }); // [多开] 会话路由
        const inner = r?.result ?? r;
        return { success: inner?.success !== false, files: inner?.files || [], error: inner?.error };
      } catch (e) {
        return { success: false, error: e?.message, files: [] };
      }
    }

    // 单检查点文件回档（面板按钮用）：仅还原该检查点的文件层（原始内容回写/删 AI 新建），
    // 不删对话消息、不动表格快照——与"按消息原子回档"(rollbackMemoryToMessage) 是两个独立入口。
    case "revertCheckpoint": {
      if (!data.id) return { success: false, error: "缺少 id" };
      if (!ideClient.isConnected) return { success: false, error: "IDE 未连接" };
      try {
        const r = await ideClient.revertCheckpoint(data.id, data.chatid || args?.chatid || null); // [多开] 会话路由
        const inner = r?.result ?? r;
        if (r?.success === false) return { success: false, error: r?.error || inner?.error || "回档未成功" };
        return { success: true, restored: inner?.restored ?? 0, deleted: inner?.deleted ?? 0, errors: inner?.errors || [] };
      } catch (e) {
        return { success: false, error: `检查点回档失败: ${e?.message || e}` };
      }
    }

    // 定点跳转（阶段3）：UI 点击 diff 锚 → 在 IDE 编辑器按内容锚定位+跳转高亮。走 callTool 不入 pendingResults（不污染对话）。
    case "revealInIde": {
      if (!data.path) return { success: false, error: "缺少 path" };
      if (!ideClient.isConnected) return { success: false, error: "IDE 未连接" };
      try {
        const r = await ideClient.callTool("_reveal", { path: data.path, anchorText: data.anchorText, line: data.line }, undefined, undefined, { chatid: data.chatid || args?.chatid || null }); // [多开] 跳转到会话所绑窗口
        const inner = r?.result ?? r;
        return { success: r?.success !== false, line: inner?.line, anchorMatched: inner?.anchorMatched };
      } catch (e) {
        return { success: false, error: `跳转失败: ${e?.message || e}` };
      }
    }

    // === 命令白名单配置 (W13+W18 Q5=B) ===
    case "getCommandConfig": {
      const _ccPath = getCommandConfigPath(username);
      const _ccData = loadJsonFileIfExists(_ccPath) || {};
      const { DEFAULT_COMMAND_CATEGORIES } = await import("../../../transport/ideClient.mjs");
      return {
        categories: { ...DEFAULT_COMMAND_CATEGORIES, ..._ccData },
        // [0726 会话输出上限可调] 持久会话单条命令输出上限（MB），缺省 10（凛倾 0726 定值）。
        // 单源在此下发，UI（permissionPanel 安全设置）只消费/回写，不自带默认。
        session_output_limit_mb: Math.min(Math.max(Number(_ccData.session_output_limit_mb) || 10, 1), 100),
        _raw: _ccData,
      };
    }

    case "setCommandConfig": {
      const _ccPath2 = getCommandConfigPath(username);
      const _ccExisting = loadJsonFileIfExists(_ccPath2) || {};
      const _ccNew = { ..._ccExisting };
      // data.categories = { git: true, npm: false, ... }
      if (data.categories && typeof data.categories === "object") {
        for (const [k, v] of Object.entries(data.categories)) {
          if (typeof v === "boolean") _ccNew[k] = v;
        }
      }
      // [0726 会话输出上限可调] 数字键：钳制 1-100 MB 后落盘（写侧钳制=单源不存非法值）
      if (data.session_output_limit_mb !== undefined) {
        const _soMb = Number(data.session_output_limit_mb);
        if (Number.isFinite(_soMb)) _ccNew.session_output_limit_mb = Math.min(Math.max(Math.round(_soMb), 1), 100);
      }
      saveJsonFile(_ccPath2, _ccNew);
      return { success: true, config: _ccNew };
    }

    // === 游戏陪伴 (W15+W18 Q2) ===
    // D-1 绑定：启动角色 = game_companion_config.bindChar（有效时），否则当前 charName。
    // runtime 按 username 唯一寻址；stop/status/action 不再重算角色，切卡或改绑定也能命中已启动 session。
    case "startGameCompanion": {
      const { startGameCompanion } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      const _gcCfg = loadJsonFileIfExists(getGameCompanionConfigPath(username)) || {};
      // [凛倾 0722 框架级] 路由收口在 _resolveCompanionTarget:专门陪伴对话/bindChat 两级,
      // 前端当前对话不参与(别影响其他窗口使用);code/work 防呆也在收口内。
      const { effChar, effChatid, warnings } = await _resolveCompanionTarget(username, charName, _gcCfg);
      const _gcStart = startGameCompanion(username, effChar, {
        interval: data.interval, // 可选：自定义间隔(ms)
        chatid: effChatid, // D-1:bindChat(已校验存在)锁定一条陪伴对话，否则前端 layout 传入 chatid
        petLease: data.petLease === false ? false : undefined, // D5 §2.2 可选「只互动」:false=不申请桌宠租约
      });
      // [D5 §2.2 结构版 2026-08-04] 分项 PetOperationResult:session 与 pet 各自真值,不用一个 success
      // toast 抹平——互动可以成功而桌宠 waiting_heartbeat/installing/missing/error。lease acquire 已在
      // startGameCompanion 内触发 PetLifecycle owner 拉起;此处只读 injection_state 运行时镜像组装 DTO,
      // 有界等它离开 stopped(≤2s,装 Electron/等心跳等长阶段按当时快照如实上报,不阻塞互动开始)。
      const _eye = await import("../../screenshot/injection_state.mjs");
      let _petRt = _eye.getPetRuntimeState();
      if (_gcStart?.success && _gcStart.petLeaseId && _petRt.status === "stopped") {
        ({ state: _petRt } = await _eye.waitPetRuntimeSettled((s) => s.status !== "stopped", 2000, 100));
      }
      const _petDto = {
        explicitEnabled: !!_eye.loadPetSettingsStore(__projectRoot).petEnabled,
        interactionLease: !!_gcStart?.petLeaseId,
        effectiveDesired: _eye.getPetEffectiveDesired(__projectRoot),
        runtime: _petRt.status,
        pid: _petRt.pid,
        error: _petRt.error,
      };
      const _startDto = { ...(_gcStart || {}), operationId: crypto.randomUUID(), pet: _petDto };
      // 白盒定位点:互动开始的分项真值单点留痕(session 结果+pet 运行时快照),排查"toast 与真实状态不一致"从这里看
      wbT(effChatid, "gameCompanion", "start:dto", { success: _gcStart?.success, lease: _petDto.interactionLease, petRuntime: _petDto.runtime, effectiveDesired: _petDto.effectiveDesired, warnings: warnings.length });
      return warnings.length ? { ..._startDto, bindWarnings: warnings } : _startDto; // 失效绑定不静默
    }

    case "stopGameCompanion": {
      const { stopGameCompanion } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      const _gcStop = stopGameCompanion(username);
      // [D5 §2.2] 停止分项收束:session stop 与本次 lease release 的结果均返回后才回包——
      //   显式开着的桌宠(effectiveDesired 仍 true)不等停,直接如实上报 running;
      //   lease 撤回触发优雅停止(10s ack)时等 runtime 收束(stopped / stopTimeout / 超时按快照上报,
      //   状态保持 stopping 不谎报 stopped,对账继续观察——waitPetRuntimeSettled 到期即返)。
      const _eyeStop = await import("../../screenshot/injection_state.mjs");
      const _explicitOn = !!_eyeStop.loadPetSettingsStore(__projectRoot).petEnabled;
      let _stopRt = _eyeStop.getPetRuntimeState();
      if (_gcStop?.petLeaseReleased && !_eyeStop.getPetEffectiveDesired(__projectRoot)) {
        ({ state: _stopRt } = await _eyeStop.waitPetRuntimeSettled(
          (s) => s.status === "stopped" || s.stopTimeout === true,
          _eyeStop.STOP_ACK_DEADLINE_MS + 1500, 250,
        ));
      }
      // 白盒定位点:停止收束的分项真值单点留痕(lease 是否真实释放+pet 终态/stop_timeout),
      // 排查"停不掉/假停止"先看这里与 eye:pet stop_* 链是否一致
      wbT(null, "gameCompanion", "stop:dto", { success: _gcStop?.success, leaseReleased: _gcStop?.petLeaseReleased === true, petRuntime: _stopRt.status, stopTimeout: _stopRt.stopTimeout === true, explicitOn: _explicitOn });
      return {
        ...(_gcStop || {}),
        operationId: crypto.randomUUID(),
        pet: {
          explicitEnabled: _explicitOn,
          interactionLease: _eyeStop.hasActiveInteractionLease(),
          effectiveDesired: _eyeStop.getPetEffectiveDesired(__projectRoot),
          runtime: _stopRt.status,
          pid: _stopRt.pid,
          stopTimeout: _stopRt.stopTimeout === true,
          error: _stopRt.error,
        },
      };
    }

    case "getGameCompanionStatus": {
      const { getGameCompanionStatus } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      return getGameCompanionStatus(username);
    }

    case "gameCompanionAction": {
      const { gameCompanionUserAction, gameCompanionCaptureNow } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      // data.action: "reply" | "ignore" | "close" | "pause"
      if (data.action === "captureNow") return await gameCompanionCaptureNow(username);
      gameCompanionUserAction(username, null, data.action || "ignore");
      const { getGameCompanionStatus: getStatus } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      return getStatus(username);
    }

    // 对话台输入(凛倾 2026-07-12"需要有对话台"):web session 侧把用户文本发进陪伴轮。
    // 与桌宠端 /api/eye/pet-message(pet-token)同一执行体 gameCompanionTouchMessage——两入口一条链,
    // 回应同走 onComplete→companion_message WS + orb 槽→桌宠气泡。陪伴未运行=诚实报错不静默。
    case "gameCompanionSay": {
      const { gameCompanionTouchMessage } = await import("../../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs");
      const _sayText = typeof data.text === "string" ? data.text.trim() : "";
      // 0725 对话台对齐主输入条(凛倾"对话界面没有上传,角色对话框的快速也没有"):
      //   files=附件([{name,mime_type,dataBase64}],触碰轮 addUserReply.files 消费,与截图附件同链);
      //   singleInject=单次注入(透传 triggerCharReply.singleInject,与主聊天 POST_message 同消费点)。
      //   大小上限不在此另立数值:前端 fileHandling MAX_ATTACHMENT_BYTES 预检,与主聊天 message 端点同姿态。
      const _sayFiles = Array.isArray(data.files) ? data.files.filter(f => f && typeof f.dataBase64 === "string" && f.dataBase64) : [];
      const _sayInject = typeof data.singleInject === "string" ? data.singleInject : "";
      if (!_sayText && !_sayFiles.length) return { success: false, error: "空消息" };
      return await gameCompanionTouchMessage(username, _sayText, {
        files: _sayFiles,
        singleInject: _sayInject,
        captureNow: data.captureNow === true,
      });
    }

    case "getGameCompanionConfig": {
      const _gcPath = getGameCompanionConfigPath(username);
      // presetName 已删(凛倾 2026-07-16 P 系列删除:陪伴不搬记忆预设,轮次走主对话链用对话自身 AIRP 配置)
      // apiSource/postProcess/customPrompt 已删(凛倾 2026-07-23"删"):三字段自 0716 起无 UI 生产者、
      // 生成链零消费(陪伴轮走承载对话 AIRP 配置)=悬空 schema 副本,与"跟随 AIRP"方向冲突。
      return loadJsonFileIfExists(_gcPath) || {
        bindChar: null,   // D-1:绑定到指定角色卡(null=跟随当前角色卡)
        bindChat: null,   // 锁定一条陪伴对话(null=自动专门陪伴对话;凛倾 0722 框架改,当前对话不参与路由)
        bindMode: "follow", // 存值兼容:非"independent"一律=自动专门陪伴对话("follow"历史值,跟随语义已删)
        silenceMultiplier: 1.5, // 频率自适应:忽略一次的降频倍率(原硬编码暴露,缺省=原值)
        closeMultiplier: 2.0,   // 频率自适应:关闭的降频倍率
        maxIntervalMin: 30,     // 频率自适应:最大间隔(分钟,降频上限)
      };
    }

    case "setGameCompanionConfig": {
      const _gcPath2 = getGameCompanionConfigPath(username);
      const _gcExisting = loadJsonFileIfExists(_gcPath2) || {};
      const _gcNew = { ..._gcExisting };
      delete _gcNew.presetName; // P 系列已删(凛倾 2026-07-16):旧文件残留键一次性清除,后端零消费
      // 三死字段删除(凛倾 2026-07-23"删",同 presetName 先例):无 UI 无消费,写口关闭+旧文件残留键清除
      delete _gcNew.apiSource; delete _gcNew.postProcess; delete _gcNew.customPrompt;
      if (data.bindChar !== undefined) _gcNew.bindChar = data.bindChar || null;   // D-1:绑定角色卡
      if (data.bindChat !== undefined) _gcNew.bindChat = data.bindChat || null;   // D-1:锁定陪伴对话
      if (data.bindMode !== undefined) _gcNew.bindMode = (data.bindMode === "independent") ? "independent" : "follow"; // D-1:路由模式(枚举校验)
      // 频率自适应倍率(数值校验,缺省=原硬编码值):忽略降频×1.5/关闭降频×2.0/最大间隔30min。
      //   用 isFinite 而非 ||默认:0 是有限但越界值应 clamp 到下限(1),不该被 || 当 falsy 跳成默认。
      if (data.silenceMultiplier !== undefined) { const _v = Number(data.silenceMultiplier); _gcNew.silenceMultiplier = Number.isFinite(_v) ? Math.max(1, Math.min(5, _v)) : 1.5; }
      if (data.closeMultiplier !== undefined) { const _v = Number(data.closeMultiplier); _gcNew.closeMultiplier = Number.isFinite(_v) ? Math.max(1, Math.min(10, _v)) : 2.0; }
      if (data.maxIntervalMin !== undefined) { const _v = Number(data.maxIntervalMin); _gcNew.maxIntervalMin = Number.isFinite(_v) ? Math.max(1, Math.min(120, _v)) : 30; }
      saveJsonFile(_gcPath2, _gcNew);
      return { success: true, config: _gcNew };
    }

    // W13 §2.2: 权限分级 Level 0-4
    case "getPermissionLevel": {
      const _plUser = data.username || args?.username || "_default";
      const _plPath = path.join(__projectRoot, "data", "users", _plUser, "permission_level.json");
      const _plData = loadJsonFileIfExists(_plPath, { level: 0 });
      // T011：附带档位显示元数据（storage.mjs PERM_LEVEL_META 单源）——前端删副本后据此渲染；纯新增字段，老消费方零影响
      return { success: true, level: _plData.level || 0, levels: PERM_LEVEL_META };
    }
    case "setPermissionLevel": {
      const _plUser = data.username || args?.username || "_default";
      const _plLevel = parseInt(data.level, 10);
      if (isNaN(_plLevel) || _plLevel < 0 || _plLevel > 5) {
        return { success: false, error: "权限等级必须为 0-5" };
      }
      _writePermissionLevel(_plUser, _plLevel); // 同键写盘单点（防双写路）
      console.log(`[beilu-memory] 权限等级已设置: Level ${_plLevel} (user=${_plUser})`);
      return { success: true, level: _plLevel };
    }

    // W24: 输出管控正则规则读写
    case "getOutputFilterRules": {
      const _ofUser = data.username || args?.username || "_default";
      const _ofPath = path.join(__projectRoot, "data", "users", _ofUser, "output_filter_rules.json");
      const _ofRules = loadJsonFileIfExists(_ofPath, { rules: [] });
      return { success: true, ..._ofRules };
    }
    case "setOutputFilterRules": {
      const _ofUser = data.username || args?.username || "_default";
      const _ofPath = path.join(__projectRoot, "data", "users", _ofUser, "output_filter_rules.json");
      const _ofDir = path.dirname(_ofPath);
      if (!fs.existsSync(_ofDir)) fs.mkdirSync(_ofDir, { recursive: true });
      saveJsonFile(_ofPath, { rules: data.rules || [] });
      return { success: true };
    }

    case "getStripTagsCustom": {
      const _stUser = data.username || args?.username || "_default";
      const _stPath = path.join(__projectRoot, "data", "users", _stUser, "strip_tags_custom.json");
      const _stData = loadJsonFileIfExists(_stPath, { tags: [], patterns: [] });
      return { success: true, ..._stData };
    }
    case "setStripTagsCustom": {
      const _stUser = data.username || args?.username || "_default";
      const _stPath = path.join(__projectRoot, "data", "users", _stUser, "strip_tags_custom.json");
      const _stDir = path.dirname(_stPath);
      if (!fs.existsSync(_stDir)) fs.mkdirSync(_stDir, { recursive: true });
      // 契约修复（20260706 链4轮）：原整对象覆盖 {tags, patterns:[]} 会抹掉文件其余配置键——
      //   该文件实际四键：tags（设置面UI管）/ patterns（正则，replyHandler:314 消费）/
      //   context_tags·context_tags_exclude（getPromptHandler:1799 消费），后三键仅手编产生。
      //   UI 只发 tags → 保存一次即静默清空手编配置（数据丢失）。改部分更新语义：只覆盖
      //   调用方显式传的字段，其余原样保留（与 T054b scheduler {...原action} 同型修）。
      const _stPrev = loadJsonFileIfExists(_stPath, {});
      const _stMerged = { ..._stPrev, tags: data.tags || [] };
      if (data.patterns !== undefined) _stMerged.patterns = data.patterns || [];
      else if (_stMerged.patterns === undefined) _stMerged.patterns = [];
      saveJsonFile(_stPath, _stMerged);
      return { success: true };
    }

    case "readUserFile": {
      const _rufName = data.filename;
      if (!_rufName || /[\/\\]/.test(_rufName) || _rufName.includes("..") || path.basename(_rufName) !== _rufName) return { success: false, error: "无效文件名" };
      const _rufPath = path.join(__projectRoot, "data", "users", username, _rufName);
      if (!fs.existsSync(_rufPath)) return { success: true, content: null };
      try {
        const _rufContent = fs.readFileSync(_rufPath, "utf-8"); // 原始读：调用方自行 JSON.parse，后端不二次 parse（防与写侧双重编码耦合）
        return { success: true, content: _rufContent };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case "writeUserFile": {
      const _wufName = data.filename;
      if (!_wufName || /[\/\\]/.test(_wufName) || _wufName.includes("..") || path.basename(_wufName) !== _wufName) return { success: false, error: "无效文件名" };
      const _wufDir = path.join(__projectRoot, "data", "users", username);
      if (!fs.existsSync(_wufDir)) fs.mkdirSync(_wufDir, { recursive: true });
      const _wufPath = path.join(_wufDir, _wufName);
      nicerWriteFileSync(_wufPath, data.content); // 原始原子写：content 已是调用方序列化的 JSON 字符串，saveJsonFile 会二次序列化致双重编码
      return { success: true };
    }
    // N41: 读侧补齐（与 saveRetrievalConfig 对称；旧前端绕 getMemoryData 读死键 p1_config 的根因）
    case "getRetrievalConfig": {
      const _grcMemDir = getMemoryDir(username, charName);
      const _grcConfig = loadJsonFileIfExists(path.join(_grcMemDir, "_config.json"), { enabled: true });
      return { success: true, config: _grcConfig.retrieval || {} };
    }
    case "saveRetrievalConfig": {
      const _srcMemDir = getMemoryDir(username, charName);
      const _srcConfigPath = path.join(_srcMemDir, "_config.json");
      const _srcConfig = loadJsonFileIfExists(_srcConfigPath, { enabled: true });
      // N41 修笔误：旧实现 `data.config || data` 会把整个请求体（含 _action、嵌套 p1_config）
      // merge 进 config.retrieval。现只接受 config/retrieval 对象并剔除 _action。
      const _srcPatch = { ...(data.config || data.retrieval || {}) };
      delete _srcPatch._action;
      _srcConfig.retrieval = { ...(_srcConfig.retrieval || {}), ..._srcPatch };
      saveJsonFile(_srcConfigPath, _srcConfig);
      const _srcCacheKey = `${username}/${charName}`;
      if (memoryCache.has(_srcCacheKey)) memoryCache.get(_srcCacheKey).config = _srcConfig;
      return { success: true, config: _srcConfig.retrieval };
    }

    // ============================================================
    // data 系统 — 用户/前端侧写通道（配 ⑤ 后端 dataSystem.mjs）
    // 线路批注/消警=本角色当前活动任务，天然 char 隔离（与 codeMemoryWrite 同款 getMemoryDir），不碰 beilu-files 沙箱。
    // （2026-07-16 凛倾拍板去重：saveFramework/saveIssues 已删——框架/问题与 code 记忆表格 #3/#4 概念重复
    //   且 AI 链全死，架构/问题知识归记忆表格单源；线路/警告为独有机制保留。）
    // ============================================================
    case "addRouteNote": {
      const _rnNote = data.note ?? data.reason;
      if (!_rnNote) return { success: false, error: "缺少 note 内容" };
      let _rnTask = data.taskName || "";
      if (!_rnTask) {
        try {
          const _ccPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点
          const _cc = loadJsonFileIfExists(_ccPath, {});
          _rnTask = (_cc && _cc.active_project) || "";
        } catch { /* 无活动任务 */ }
      }
      if (!_rnTask) return { success: false, error: "当前无活动任务（active_project 为空），线路批注无归属" };
      const _rnRec = appendRouteAmendment(username, charName, _rnTask, _rnNote, data.target || "");
      diag.log("[dataCRUD]", `addRouteNote user=${username} char=${charName} task=${_rnTask} seq=${_rnRec?.seq ?? "-"}`);
      // T052：route 批注是 per-char（appendRouteAmendment 传 charName）→ scope="char"，前端按 charId 过滤只刷同卡窗口。
      // _rnRec 存在=真追加了记录（真变化）才广播。
      if (_rnRec) _broadcastDataSystemUpdate(chatId, username, charName, "char", "route");
      return { success: true, event: _rnRec };
    }

    case "ackDataWarning": {
      const _awPos = data.position;
      if (!_awPos) return { success: false, error: "缺少 position（警告位置标识）" };
      let _awTask = data.taskName || "";
      if (!_awTask) {
        try {
          const _ccPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点
          const _cc = loadJsonFileIfExists(_ccPath, {});
          _awTask = (_cc && _cc.active_project) || "";
        } catch { /* 无活动任务 */ }
      }
      if (!_awTask) return { success: false, error: "当前无活动任务（active_project 为空），无警告可消" };
      const _awOk = ackWarning(username, charName, _awTask, _awPos);
      diag.log("[dataCRUD]", `ackDataWarning user=${username} char=${charName} task=${_awTask} position=${_awPos} ok=${_awOk}`);
      // T052：消警是 per-char（ackWarning 传 charName）→ scope="char"。仅 _awOk=true（真消到警告=真变化）才广播，
      // 未匹配到警告时不广播（防无意义风暴）。
      if (_awOk) _broadcastDataSystemUpdate(chatId, username, charName, "char", "warning");
      return { success: _awOk, acked: _awOk, ...(_awOk ? {} : { error: "未找到匹配的未消警警告" }) };
    }

    case "checkMemoryFormat": {
      const { scanMemoryFormat } = await import("../storage_mod/memoryEntryFormat.mjs");
      const _cmfMemDir = getMemoryDir(username, charName);
      const _cmfResult = scanMemoryFormat(_cmfMemDir);
      return { success: true, ..._cmfResult };
    }
    case "upgradeMemoryFormat": {
      const { upgradeMemoryFormat: _umfFunc } = await import("../storage_mod/memoryEntryFormat.mjs");
      const _umfMemDir = getMemoryDir(username, charName);
      const _umfResult = _umfFunc(_umfMemDir);
      return { success: true, ..._umfResult };
    }

    // === ★ B3 权限规则集引擎：三态规则 CRUD + L 档模板（toggle 面板用，独立块） ===
    //   规则结构升级为 { tool, pathPrefix|glob, action: "allow"|"ask"|"deny", source: "user"|"template", createdAt }。
    //   旧规则文件无 action 字段=allow（引擎层 _ruleHit 向后兼容，老文件不迁移）。
    //   安全红线：本块只增删改用户规则，系统强制确认(_forceApproval/区外/敏感默认)在 evaluateRuleAction 引擎层裁决，前端改不了。
    case "setApprovalRule": {
      try {
        // upsert 一条三态规则。定位键 = (tool, pathPrefix||glob)；命中则改 action，否则新增。
        const _tool = data.tool;
        if (!_tool || typeof _tool !== "string") return { success: false, error: "缺 tool" };
        const _action = data.action;
        if (_action !== "allow" && _action !== "ask" && _action !== "deny") {
          return { success: false, error: `非法 action: ${_action}（须 allow|ask|deny）` };
        }
        const _hasGlob = typeof data.glob === "string" && data.glob.length > 0;
        const _pathPrefix = typeof data.pathPrefix === "string" ? data.pathPrefix : "";
        // ★ FT2：放宽敏感默认（.env/删除类→allow）须前端二次确认——仅 confirmSensitive:true 才接受敏感覆盖。
        //   未带 confirmSensitive 的敏感放宽 → 拒绝并回 needConfirm，前端弹确认后带 confirmSensitive 重发。
        if (_isSensitiveOverrideRule(_tool, _action, data.glob, _pathPrefix) && data.confirmSensitive !== true) {
          return {
            success: false,
            needConfirm: true,
            sensitive: true,
            error: "该规则放宽敏感默认（.env/删除类）保护，需二次确认。请在确认弹窗勾选后重试（confirmSensitive）。",
          };
        }
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        if (!Array.isArray(_arData.rules)) _arData.rules = [];
        // 匹配键：glob 优先比 glob，否则比 pathPrefix。
        const _idx = _arData.rules.findIndex((r) => {
          if (!r || r.tool !== _tool) return false;
          if (_hasGlob) return String(r.glob || "") === data.glob;
          return !r.glob && String(r.pathPrefix || "") === _pathPrefix;
        });
        const _newRule = _hasGlob
          ? { tool: _tool, glob: data.glob, action: _action, source: "user", createdAt: new Date().toISOString() }
          : { tool: _tool, pathPrefix: _pathPrefix, action: _action, source: "user", createdAt: new Date().toISOString() };
        if (_idx >= 0) {
          // 保留原 createdAt，只更新 action/source。
          _newRule.createdAt = _arData.rules[_idx].createdAt || _newRule.createdAt;
          _arData.rules[_idx] = _newRule;
        } else {
          _arData.rules.push(_newRule);
        }
        // ★ FT2 需求 A：用户逐条微调 → 当前档转 custom（第 1 层徽章 ● 移到自定义）。
        _arData.activeTemplate = "custom";
        const _arDir = path.dirname(_arPath);
        if (!fs.existsSync(_arDir)) fs.mkdirSync(_arDir, { recursive: true });
        saveJsonFile(_arPath, _arData);
        return { success: true, rule: _newRule, activeTemplate: "custom", rules: _arData.rules };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // L 档模板预览：返回该档生成的一组规则（不落盘，前端「从模板导入」时再逐条 setApprovalRule 或整组 import）。
    case "getPermissionTemplate": {
      try {
        const _lvl = data.level;
        const _rules = buildPermissionTemplateRules(_lvl);
        return { success: true, level: Number(_lvl) || 0, rules: _rules };
      } catch (e) { return { success: false, error: e.message, rules: [] }; }
    }

    // 从 L 档模板整组导入：合并进用户规则（同键 upsert，不重复）。
    // ★ FT2：支持 templateId（full/collab/careful/readonly，需求 A 档位徽章切档）→ 映射 level + 持久化 activeTemplate。
    //   切档语义=用模板整组覆盖当前档位规则（先清掉旧 template 来源规则，再导入新档），保留 user 自定义规则不动。
    case "importPermissionTemplate": {
      try {
        // templateId 优先（档位徽章），回退 level（旧调用方）。数字化口径统一（旧调用方可能传字符串）。
        let _lvl = Number.isFinite(Number(data.level)) ? Number(data.level) : data.level;
        let _tplId = typeof data.templateId === "string" ? data.templateId : null;
        if (_tplId) {
          const _meta = _PERMISSION_TEMPLATES_META.find((t) => t.id === _tplId);
          if (!_meta) return { success: false, error: `未知档位: ${_tplId}` };
          _lvl = _meta.level;
        }
        const _tplRules = _tplId ? _buildTemplateRulesById(_tplId, _lvl) : buildPermissionTemplateRules(_lvl);
        const _arPath = path.join(__projectRoot, "data", "users", username, "ide_approval_rules.json");
        const _arData = loadJsonFileIfExists(_arPath, { rules: [] });
        if (!Array.isArray(_arData.rules)) _arData.rules = [];
        // 切档（带 templateId）：先移除旧 template 来源规则，避免上一档残留与新档叠加（user 自定义规则保留）。
        if (_tplId) _arData.rules = _arData.rules.filter((r) => r && r.source !== "template");
        let _added = 0, _updated = 0;
        for (const _tr of _tplRules) {
          const _idx = _arData.rules.findIndex((r) =>
            r && r.tool === _tr.tool && !r.glob && String(r.pathPrefix || "") === String(_tr.pathPrefix || ""));
          if (_idx >= 0) { _arData.rules[_idx] = { ..._tr, createdAt: _arData.rules[_idx].createdAt || _tr.createdAt }; _updated++; }
          else { _arData.rules.push(_tr); _added++; }
        }
        // 持久化当前档位（需求 A：getApprovalRules 回读 activeTemplate 高亮徽章）。
        if (_tplId) _arData.activeTemplate = _tplId;
        const _arDir = path.dirname(_arPath);
        if (!fs.existsSync(_arDir)) fs.mkdirSync(_arDir, { recursive: true });
        saveJsonFile(_arPath, _arData);
        // 0714 双键收口修：切档必须同步抬/降 permission_level.json 的 level（免审批总闸）。
        //   此前本 case 只写键2(ide_approval_rules.json)，键1(permission_level.json)不动——用户点
        //   「自由(L4)」档位徽章后 replyHandler:1688 读到的 level 仍是旧值 → 完全信任不生效（双键不同步病根）。
        //   写盘走 _writePermissionLevel 单点（与 setPermissionLevel case 同一函数，同键禁双写路）。
        if (Number.isInteger(_lvl) && _lvl >= 0 && _lvl <= 5) {
          _writePermissionLevel(username, _lvl);
          console.log(`[beilu-memory] 档位切换联动权限等级: Level ${_lvl} (user=${username}, template=${_tplId || "?"})`);
        }
        return { success: true, added: _added, updated: _updated, activeTemplate: _arData.activeTemplate, level: _lvl, rules: _arData.rules };
      } catch (e) { return { success: false, error: e.message }; }
    }

    // === 辅助 AI 调用（前端 TavernHelper.generate/generateRaw 的后端 handler）===
    //   用途：iframe 脚本/美化代码调 AI 做"额外处理"(翻译/摘要/小任务)，
    //         不触发聊天主流程。接既有 runMemoryPresetAI 引擎单轮调用。
    //   AI 源：use_custom:false → loadAnyPreferredDefaultPart 取系统默认 AI 服务源
    //         （原 yonban_config.auxiliaryAI 独立配置已删，见 :2772「删辅助AI后」，
    //          故不再读已不存在的 auxiliaryAI，直接复用系统默认源）。
    //   返回：{success, reply, model} —— 字段对齐前端 tavernHelper 的 j.reply / j.model 消费。
    case "testAuxiliary": {
      const _auxText = String(data.content || data.user_input || data.prompt || "").trim();
      if (!_auxText) return { success: false, error: "辅助 AI 调用缺少输入文本（content）" };
      try {
        const _auxResult = await runMemoryPresetAI(
          username,
          charName,
          {
            id: `AUX_${Date.now()}`,
            name: "辅助AI(generate)",
            prompts: [{ role: "user", content: _auxText, enabled: true }],
            api_config: {
              use_custom: false, // 取系统默认 AI 服务源
              temperature: 0.7,
              max_tokens: 4000,
              prompt_post_processing: "strict",
              include_reasoning: false,
              // extended_thinking 已删（2026-08-01 收口：思维链跟随所用 AI 源的 per-源设置）
            },
          },
          memData,
          charName,
          username,
          "",
          { maxRounds: 1, chatId }, // [2026-07-16] 与外层 memData(带 chatId load) 同槽（同批半接线补齐）
        );
        const _auxReply = (_auxResult?.reply || "").trim();
        // runMemoryPresetAI 返回体不含 model 字段（内部 actualSourceName 不外露）→ presetName 作为来源标识，前端 j.model 容忍空。
        return { success: true, reply: _auxReply, model: _auxResult?.presetName || "" };
      } catch (e) {
        // 框架级诚实报错：调用方（STScript generate/generateRaw）能看到真实失败原因，不静默空串。
        return { success: false, error: `辅助 AI 调用失败: ${e.message}` };
      }
    }

    default: {
      if (data.enabled !== undefined) { setPluginEnabled(data.enabled); return { success: true }; }
      return { success: false, error: `未知 action: ${data._action || "(无)"}` };
    }
  }
}

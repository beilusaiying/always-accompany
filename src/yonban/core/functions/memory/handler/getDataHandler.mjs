/**
 * getDataHandler.mjs — GetData 处理器：前端拉取插件完整状态的唯一入口。
 *
 * 【功能链】
 *   聚合记忆表格、配置、预设列表、上下文摘要、data系统快照、IDE审批队列、文件读取缓存等全部状态，
 *   一次性返回前端。不管写操作（那是 setDataActions 的事）。
 *
 * 【why】
 *   记忆中心前端面板需要一次性渲染多个维度（表格/配置/预设/IDE状态），
 *   如果让前端多次分散请求会产生竞态和闪烁。GetData 单一聚合入口让前端一次拉全，
 *   且通过 viewMode/chatId 参数解耦"查看哪个模式的数据"与"当前活跃会话"，
 *   避免前端切换查看视图时污染活跃模式状态。
 *
 * 【前端调用方式】
 *   前端调用 window.moduleManager.GetData("beilu-memory", { username, charName, chatid?, viewMode? })
 *   → beilu-chat plugin bridge → POST /api/plugin（或 WS）
 *   → main.mjs interfaces.config.GetData → 本模块 handleGetData(args)
 *   → 返回完整状态对象，前端直接渲染到记忆中心 UI 面板
 *
 *   关键参数：
 *     viewMode="chat"|"code"|"work" — 只切换查看视图，不改活跃模式（解耦显示与会话）
 *     chatid — per-chatId 隔离：按本窗口活跃模式取表格/状态，不带时回退全局
 *
 * 【关联链】
 *   ← main.mjs（GetData 路由）
 *   → storage.mjs（loadMemoryData / loadMemoryPresets / readContextSummary / getActiveMode 等）
 *   → dataSystem.mjs（getDataSnapshot / initDataFiles）
 *   → aiRunner.mjs（pluginEnabled — 读插件启用状态）
 *   → ideClient.mjs（IDE 审批状态 / 读取缓存）
 *   → setDataActions.mjs（_resolveChatOwner — SEC 破口D 属主过滤，复用单一权威）
 *   → presetBridge.mjs（listPresets — 可用预设列表）
 *
 * 【影响范围】
 *   纯读取，不写磁盘（除 initDataFiles 幂等初始化空 schema 无副作用）；不广播 WS 事件。
 *
 * 【使用效果】
 *   前端一次请求即可获取所有面板数据，支持多窗口 per-chatId 独立查看，
 *   viewMode 切换不影响实际会话状态，IDE 审批队列实时反映待处理操作。
 *
 * 返回结构：{ username, charName, enabled, activeMode, tables, config, context_summary,
 *             memory_presets, injection_prompts, available_presets, data_system,
 *             web_search_engines, _actions, ide_approvals, read_cache }
 */
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_INJECTION_PROMPTS,
  __pluginDir,
  getActiveMode,
  getMemoryDir,
  loadJsonFile,
  loadJsonFileIfExists,
  loadMemoryData,
  loadMemoryPresets,
  readContextSummary,
  getCodeConfigPath,
} from "../storage_mod/storage.mjs";
import { listPresets as listBeiluPresets } from "../ai/presetBridge.mjs";

import { pluginEnabled } from "../ai/aiRunner.mjs";
import { ideClient } from "../../../transport/ideClient.mjs";
// inj 识别系统 2026-07-13：识别+裁决+值域单源（生成链 getPromptHandler 同模块）
import { resolveInjectionContext, resolveEffectiveInjections, getInjectionAutoModeMeta } from "../storage_mod/injectionSystem.mjs";
import { _resolveChatOwner, _resolveRequestChar } from "./setDataActions.mjs"; // SEC 破口D owner 谓词 + 链1 chatid→char 归位（单一权威复用，不重复造）
import { getDataSnapshot, initDataFiles } from "../data/dataSystem.mjs";
// T072a（可操作处禁硬编码）：搜索引擎枚举唯一权威源（webSearch.mjs），
//   随 GetData 附 web_search_engines 下发前端动态渲染引擎下拉，消除前端两处静态 option 副本。
import { SUPPORTED_ENGINES } from "../../web/webSearch.mjs";
// 链路2（2026-07-08 可操作处禁硬编码）：模型参数元数据单源（default/min/max/step/label），
//   随 GetData 附 param_schema 下发，前端参数控件据此渲染值域，替代 HTML/JS 写死副本。
import { PARAM_SCHEMA, ENUM_SCHEMA } from "../../prompt/preset/engine/paramSchema.mjs"; // 0714：enum_schema 随 GetData 下发（主面板 pp/prefill 下拉接线，原只随 getSubModes 下发）

/**
 * 处理 config.GetData 请求
 * @param {object} args - 查询参数
 * @returns {object} 完整的插件状态数据
 */
export async function handleGetData(args) {
  const username = args?.username || "_default";

  // per-chatId：前端带 chatid 时按本窗口模式读表格/状态（与 GetPrompt 注入同一权威）。
  // 前端暂未带 → undefined → getActiveMode 回退全局，行为同旧（零回归）。
  const _cid = args?.chatid || (args?.chat_name ? args.chat_name.replace("common_chat_", "") : undefined);

  // [2026-07-17 链1 读写同源修] chatid→char 归位（单一权威=_resolveRequestChar，0714 只装了
  // setData 侧=半修残留）：显式 char_id/charName 恒优先；无 char 上下文但带 chatid（getData 桥
  // sendAction:145 自动盖章）→ 按 chat 元数据 primaryCharName 归位。原实现恒落 "_global"，
  // 而写侧（updateConfig 等）与 AI 写链全在 per-char 桶——读 A 写 B，联网开关等 config 面板
  // 显示永远是 _global 旧值（凛倾 0717"重启后端变关闭"实锤）。无 chatid 调用方维持 _global 不变。
  const charName = await _resolveRequestChar({ chatid: _cid }, args, args?.char_id || args?.charName || "_global");
  // 记忆中心「查看模式」：前端切「看哪个模式的记忆/表格」时带 viewMode，按指定模式取数据
  // 而不改 active_mode（解耦查看视图与会话模式，修 mem-mode-switch-btn 切会话+恢复错预设的污染）。
  // 不带 viewMode（所有旧调用方）→ undefined → loadMemoryData 按 active_mode 回退，行为同旧（零回归）。
  const _viewMode = (args?.viewMode === "chat" || args?.viewMode === "code" || args?.viewMode === "work") ? args.viewMode : undefined;
  // [2026-07-16 读写同源修复] viewMode 也照传 _cid：隔离模式(code/work)的 AI 写链
  // (replyHandler:960 saveTablesData 带 _cid) 落 `<mode>_ctx/<chatId>/`，查看视图必须读同一窗口目录
  // 才与写侧同源（凛倾 2026-06-17 裁决 B：code/work 按窗口隔离，查看跟随窗口）。
  // 原「footgun 守卫」（viewMode 时强制 undefined 读 char 级根）方向反了：char 级根从无 AI 写入，
  // 守卫生效=永远读空模板（0716 "0行"病根之一）；且在 getData 桥漏接 chatid 期间它恒 no-op。
  // 非隔离模式(chat) getModeCtxDir 不消费 chatId，行为不变。
  const data = loadMemoryData(username, charName, _viewMode, _cid);
  const presetsData = loadMemoryPresets(username, charName);

  let availablePresets = [];
  try {
    availablePresets = listBeiluPresets(username); // [T065] 预设列表 per-user
  } catch (e) {
    console.warn(
      "[beilu-memory] GetData: 读取 beilu-preset 列表失败:",
      e.message,
    );
  }

  // 当前活跃模式单源：loadMemoryData 内部已走 getActiveMode 权威链（线级>char级>全局）
  // 且恒返回合法值（storage.mjs:2406/2501 safeMode 兜底 "chat"）。原 `|| config.active_mode || "chat"`
  // 是死分支双源回退——config.active_mode 是 char 级裸字段，若生效即与 per-chatId 解析分叉
  // （2026-07-13 补丁形式识别·形式一，多源合并删除）。
  const activeMode = data.activeMode;

  // 读取压缩摘要（Step 6 / O17 per-chatId 隔离）
  const contextSummary = readContextSummary(username, charName, _cid);

  // data 系统：线路/警告快照（本角色当前活动任务；框架/问题已删=2026-07-16 去重，归 code 记忆表格）。
  // taskName 取 active_project（与 replyHandler 埋点同源），无任务则空字符串 → 线路/警告为空集。
  let dataSystemSnapshot = null;
  try {
    initDataFiles(username); // 幂等：缺失时建默认阈值配置，让用户能在界面看到并编辑
    let _routeTask = "";
    try {
      const _ccPath = getCodeConfigPath(username, charName); // T7 尾段收口：权威路径单点
      const _cc = loadJsonFileIfExists(_ccPath, {});
      _routeTask = (_cc && _cc.active_project) || "";
    } catch { /* 无活动任务 = 线路/警告空集 */ }
    dataSystemSnapshot = getDataSnapshot(username, charName, _routeTask);
    dataSystemSnapshot.activeProject = _routeTask;
    const _snapSig = `${dataSystemSnapshot.routeTotal ?? 0}|${dataSystemSnapshot.warnings?.length ?? 0}|${_routeTask}`;
    if (_snapSig !== getDataSnapshot._lastSig) {
      getDataSnapshot._lastSig = _snapSig;
      console.debug(
        "[beilu-memory] GetData data_system 快照:",
        `route=${dataSystemSnapshot.routeTotal ?? 0}`,
        `warnings=${dataSystemSnapshot.warnings?.length ?? 0}`,
        `task=${_routeTask || "(none)"}`,
      );
    }
  } catch (e) {
    console.warn("[beilu-memory] GetData: 读取 data 系统快照失败:", e.message);
  }

  // [0716 凛倾定案] mode_preset_bindings 读口已删——「绑定」概念不存在，只有「当前正在使用的预设」
  //   （active_preset_map[cid:mode]，经 active_preset_resolved 下发）。
  const returnConfig = { ...data.config };

  // SEC 破口D：IDE 待审批项按属主过滤——原 ide_approvals.pendingApprovals 全量返回所有用户 pending
  //   (含 opId/path/command) = 跨用户泄漏。只返回 chatid 属主===当前用户的项（owner 谓词单一权威）。
  const _idePending = [];
  for (const _o of (ideClient.pendingApprovals || [])) {
    if (_o.status !== "pending") continue;
    if (!_o.chatid || (await _resolveChatOwner(_o.chatid)) !== username) continue;
    _idePending.push(_o);
  }

  return {
    username,
    charName,
    enabled: pluginEnabled,
    activeMode,
    tables: data.tables,
    config: returnConfig,
    context_summary: contextSummary,
    memory_presets: presetsData.presets,
    // p系列持久激活位（凛倾0706「切换=改绑」）：写点=setActiveMemoryPreset verb，三处前端恢复选中用
    active_memory_preset_id: presetsData.active_preset_id || "",
    injection_prompts:
      presetsData.injection_prompts ||
      structuredClone(DEFAULT_INJECTION_PROMPTS),
    // inj 识别系统 2026-07-13（"后端权威清单下发"范式同 web_search_engines/param_schema）：
    //   injection_automode_meta = autoMode 值域+各模式接受域（前端选项唯一数据源，替 3 份硬编码清单）
    //   injection_effective   = 每条生效裁决（与生成链同一 resolveEffectiveInjections，
    //   前端直接渲染真值，替 panels.mjs computeEffective 镜像重算——镜像漏 bot 分支且缺 smart）
    injection_automode_meta: getInjectionAutoModeMeta(),
    // loadMemoryPresets(storage.mjs:2785) 已把缺失键归一成 []，不复制上面 ||DEFAULT 的死枝形状
    // [0718 半接线修] chatId 补传：桥层 0709 起统一注入 chatid（sendAction.mjs:145），本处一直未消费——
    //   同响应内 activeMode 已走 per-窗口(_cid :119)而本判定走 char 级，窗口绑定模式（active_modes_map）
    //   下面板"生效"预览与生成链真实注入分叉。与 getPromptHandler:235 同源传参；无 chatid 调用方行为不变。
    injection_effective: resolveEffectiveInjections(
      presetsData.injection_prompts || [],
      resolveInjectionContext({ username, charName, chatId: _cid }),
    ),
    available_presets: availablePresets,
    // data 系统 v3：三类数据 + 警告（前端 data 界面渲染源）
    data_system: dataSystemSnapshot,
    // T072a：搜索引擎枚举下发（单源=webSearch.mjs SUPPORTED_ENGINES），前端据此动态渲染引擎下拉，
    //   与 available_presets 同为"后端权威清单下发"范式（非用户 config，不写盘、不被用户存储覆盖）。
    web_search_engines: SUPPORTED_ENGINES,
    // 链路2：模型参数元数据下发（单源=paramSchema.mjs PARAM_SCHEMA），前端参数控件
    //   min/max/step/default 据此覆盖（HTML 静态值作离线退化），同上述范式。
    param_schema: PARAM_SCHEMA,
    // 0714：枚举选项集同批下发（单源=paramSchema.mjs ENUM_SCHEMA）——主面板 pp/prefill 下拉
    //   此前靠 HTML 静态 option 半接线，随 GetData 下发后与 subModePanel/YonBan 表单同源。
    enum_schema: ENUM_SCHEMA,
    _actions: [
      "setEnabled",
      "switchMode",
      "getMode",
      "clearCache",
      "updateTable",
      "addTable",
      "removeTable",
      "getTables",
      "getMemoryPresets",
      "getMemoryPresetDetail",
      "updateMemoryPresetPrompts",
      "updateMemoryPreset",
      "updatePresetPrompt",
      "addPresetPrompt",
      "removePresetPrompt",
      "replacePresetPrompts",
      "exportMemoryPreset",
      "importMemoryPreset",
      "initPresetPromptsFromTemplate",
      "syncDefaultPresets",
      "reorderPresetPrompts",
      "updateInjectionPrompt",
      "addInjectionPrompt",
      "deleteInjectionPrompt",
      "previewMemoryPreset",
      "previewInjectionPrompt",
      "archiveTempMemory",
      "endDay",
      "archiveHotToWarm",
      "archiveWarmToCold",
      "archiveCompletedTasks",
      "triggerP2CodeArchive",
      "triggerP2Summary",
      "getArchiveConfig",
      "updateArchiveConfig",
      "getEnvTools",
      "saveEnvTools",
      "listMemoryFiles",
      "readMemoryFile",
      "writeMemoryFile",
      "deleteMemoryFile",
      "exportMemory",
      "importMemory",
      "importPresets",
      "exportPresets",
      "listSyncDomains",
      "syncCharDomains",
      "getModels",
      "testClone",
      "runMemoryPreset",
      "getMemoryAIOutput",
      "clearMemoryAIOutput",
      "dumpP1Request",
      "getDiagSnapshot",
      "updateConfig",
      "compactContext",
      "clearInjections",
      "hideContextNoise",
      "getReadCacheFromChat",
      "cleanReadCache",
      "smartCleanChat",
      "hideCloneMessages",
      "injectSummaryMessage",
      "cleanXmlTags",
      "exportCodeMemory",
      "importCodeMemory",
      "readContextSummary",
      "copyToCodeMemory",
      "createCodeFolder",
      "moveCodeFile",
      "listCodeFiles",
      "searchCodeFiles",
      "deleteCodeFile",
      "createSnapshot",
      "listSnapshots",
      "restoreSnapshot",
      "fetchWebPage",
      "readExternalFile",
      "listExternalDir",
      "diagnoseWorkMode",
      "createWorkFile",
      "readWorkFile",
      "archiveWorkFile",
      "listWorkFiles",
      "getWorkStats",
      "scheduler_start",
      "scheduler_stop",
      "scheduler_addJob",
      "scheduler_removeJob",
      "scheduler_updateJob",
      "scheduler_toggleJob",
      "scheduler_listJobs",
      "runAsyncAI",
      "getAsyncAITasks",
      "launchEditor",
      "getWorkApprovals",
      "resolveWorkApproval",
      "getWorkDelegates",
      "cancelWorkDelegate",
      "clearWorkQueues",
      "getSubModes",
      "saveSubModes",
      "setActiveSubMode",
      "getClones",
      "saveClones",
      "saveTableCleanConfig",
      "getTableCleanConfig",
      "startFlowGroup",
      "advanceFlowGroup",
      "getFlowGroupStatus",
      "approveFlowGroup",
      "stopFlowGroup",
      "deleteFlowGroup",
      "saveFlowGroup",
      "listFlowGroups",
      "setSelectedFlowGroup", // [0722 skill组隔离] 长期选中组写点（subModePanel 点选组）
      "createFlowGroupManual",
      "updateFlowGroup",
      "ideToolCall",
      "gitSnapshot",
      "gitRestore",
      "listGitCheckpoints",
      "rollbackMemoryToMessage",
      "getRollbackPreview",
      "listTableSnapshots",
      "getIdeApprovals",
      "approveIdeOp",
      "rejectIdeOp",
      "approveAllIdeOps",
      "rejectAllIdeOps",
      "setIdeWriteApproval",
      "getPendingIdeResults",
      "getIdeOperationHistory",
      "clearIdeOperationHistory",
      "getCheckpointList",
      "getCheckpointDiff",
      "revertCheckpoint",
      "getCommandConfig",
      "setCommandConfig",
      "startGameCompanion",
      "stopGameCompanion",
      "getGameCompanionStatus",
      "gameCompanionAction",
      "getGameCompanionConfig",
      "setGameCompanionConfig",
      "getPermissionLevel",
      "setPermissionLevel",
      "getOutputFilterRules",
      "setOutputFilterRules",
      "getStripTagsCustom",
      "setStripTagsCustom",
      "readUserFile",
      "writeUserFile",
      "saveRetrievalConfig",
      "addRouteNote",
      "ackDataWarning",
      "checkMemoryFormat",
      "upgradeMemoryFormat",
    ],
    // IDE 工具审批状态
    ide_approvals: {
      pendingApprovals: _idePending, // SEC 破口D: 属主过滤（防全量泄漏他人 pending）
      requireWriteApproval: ideClient.getRequireWriteApproval(username), // SEC 破口C: per-user
      ideConnected: ideClient.isConnected,
      // 后端类型（0722 识别细化）："cli"|"yonban"|null——前端 INJ 统计条区分显示（CLI 连接≠YonBan 连接，
      // INJ-2↔INJ-2-code 互斥只认 YonBan），审批语义仍用上行 ideConnected（任意后端已连）。
      backendKind: ideClient.backendKind,
    },
    // 文件读取缓存清单（供前端压缩面板展示）——只取本对话分区(_readCache 已按 chatid 分区)，不串别的对话
    read_cache: (() => {
      const entries = [];
      const now = Date.now();
      const _ownCache = ideClient._readCache.get(_cid || "");
      if (_ownCache) {
        for (const [p, info] of _ownCache) {
          const age = now - new Date(info.timestamp).getTime();
          entries.push({ path: p, tool: info.tool, lines: info.lines, chars: info.chars, tokens: info.tokens || Math.ceil(info.chars / 3.5), age });
        }
      }
      return entries;
    })(),
  };
}
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * [storage] — 数据基础层（最底层）。不管业务逻辑/AI 调用/标签解析（那是上层各 handler 的事）。
 *
 * 链路：所有 lib/ 子模块 → import storage → 磁盘 I/O
 *        main.mjs → loadMemoryData/saveTablesData → 磁盘 tables.json / code_tables.json / work_tables.json
 * 影响：写 tables.json/.bak（原子 tmp+rename，串行队列 _saveTablesLocks）
 *        写 _config.json（模式切换 setActiveMode）
 *        写 _memory_presets.json（saveMemoryPresets，全局存 _global）
 *        写 context_summary.json（per-chatId 隔离，O17）
 *        memoryCache（Map，进程级内存缓存，按 "username/charName[#mode@chatId]" 索引）
 * 相交：← 所有 lib/ 子模块依赖本模块（路径/IO/缓存/模式/默认模板/时间工具）
 *        → 不 import 任何 lib/ 兄弟模块（杜绝循环依赖）
 *        → nicerWriteFile.mjs（nicerWriteFileSync 原子写单源，0716 收口）
 *        → diagLogger.mjs（createDiag，结构化诊断日志）
 *        → path_confine.mjs（confinePath，SEC-T2 路径穿越防护）
 *
 * 核心机制：
 *   · 原子写：saveJsonFile → nicerWriteFileSync 单源（tmp+重试 rename+同值跳写，0716 收口）
 *   · 写队列：saveTablesData → _saveTablesLocks（Map<path, Promise>），同路径串行排队
 *   · 模式感知：chat/code/work 三套表文件 + per-chatId 窗口隔离（K5 getModeCtxDir）
 *   · 缓存：memoryCache per-cacheKey 缓存 tables + config，config 每次读盘刷新
 *   · 损坏恢复：主文件损坏 → .bak 回读 → 默认模板兜底（DL-2）
 *   · 关停 drain：drainTableWrites() await 所有 pending 写入（D-02）
 */

import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs"; // 0716 收口：原子写单源（renameSyncWithRetry 死 import 已删） // T3e: memory/storage_mod/ 新位到 src/ 5 级(旧 lib/storage_mod/ 为 6 级)
import { bakCorruptFile } from "../../../../../scripts/safeJsonIO.mjs"; // [0716 断电安全] 损坏备份单源（loadJsonFileIfExists 消费）

import { createDiag } from "../../../../../server/diagLogger.mjs"; // T3e: 6→5 级
import { confinePath } from "../../security/path_confine.mjs"; // T3e: 6→5 级
// [0722 J1-B 二迁] 判据真源=entryKind.mjs（零依赖纯叶子）。禁止改回 import injectionSystem：
//   injectionSystem 顶层 import ideClient→commandGate，commandGate 顶层立即调 getFilesSettingsPath()
//   → storage 未初始化完 __projectRoot 即被读 = TDZ 崩全部插件加载（0722 事故）。本文件保持叶子约定。
import { isDataEntry } from "./entryKind.mjs"; // 数据类条目判据单源（播种域消费）


// ============================================================
// 后端诊断日志器（单例，所有子模块共享）
// ============================================================
export const diag = createDiag("memory");

// ============================================================
// 高频函数 trace 降频：只在首次调用打 wbT，后续静默（只通知一遍）
// ============================================================
const _tracedOnce = new Set();

// ============================================================
// 路径常量
// ============================================================
// T3e·memory 组迁移：实现体迁到 src/yonban/core/functions/memory/storage_mod/，
//   但 __pluginDir 语义 = beilu-memory 插件在 parts 树的家目录（default_memory_presets.json / 兄弟插件 beilu-preset /
//   shells/beilu-chat / plugins 根 全部留在 parts 树，未随代码迁移），必须仍指向旧位 plugins/beilu-memory，
//   否则 setDataActions:1014/1030/1139(default_memory_presets)、presetBridge:55(beilu-preset)、
//   *_bcPath/chatOps(shells) 等 ~30 处 __pluginDir 相对引用全断。数据资产随代码同迁的部分走 __dirname/../（各 .mjs 自锚），不经 __pluginDir。
//   新位 memory/storage_mod/ 上 5 级到 src/，再 public/parts/plugins/beilu-memory。
export const __pluginDir = path.resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "..",
  "public", "parts", "plugins", "beilu-memory",
);
// 从插件目录 (src/public/parts/plugins/beilu-memory) 推算项目根目录
// 5个 ".." 向上5级: beilu-memory/ → plugins/ → parts/ → public/ → src/ → 项目根
export const __projectRoot = path.resolve(
  __pluginDir,
  "..",
  "..",
  "..",
  "..",
  "..",
);

/**
 * [路径单源] beilu-files-settings.json 的 node 侧读写路径权威收口。
 *
 * 【为什么在这里】storage.mjs 已是路径权威收口先例（__projectRoot :62 + getEyeConfigPath）。
 *   R5 收敛前，node 侧三头（server/web_server/endpoints.mjs、yonban/core/transport/ideClient.mjs、
 *   yonban/core/functions/security/commandGate.mjs）各自用 __dirname/fileURLToPath 上溯 2/4/5 级
 *   推导仓库根——三种推导恰好都到仓库根靠巧合，任一文件挪位即路径分叉到不同物理文件。
 *   统一由本函数供给：单源推导，任一消费方迁移不再影响解析结果。
 * 【功能链】endpoints._readCommandGate/_writeAllowChannelBExec（commandGate 段合并写）、
 *   ideClient._readCanonicalWorkspace（_global.workspaceRoot 只读）、
 *   commandGate._loadCommandGateConfig（commandGate 段只读）三处消费此路径。
 * 【owner 边界】真 owner 是 beilu-files 插件（Deno，相对 CWD 路径，合并写全量）——不在本函数管辖，
 *   跨运行时不共享此 node 侧模块，各自解析到同一物理路径 <仓库根>/data/beilu-files-settings.json。
 * @returns {string} 绝对路径
 */
export function getFilesSettingsPath() {
  return path.join(__projectRoot, "data", "beilu-files-settings.json");
}

// ============================================================
// 基础文件 I/O 工具
// ============================================================

/**
 * 加载 JSON 文件
 * @param {string} filepath
 * @returns {any}
 */
export function loadJsonFile(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch (e) {
    wbD(null, "storage", "loadJsonFile:fail", false, "JSON 读/解析失败，返回 null（疑似文件损坏/丢数据）", { path: filepath, err: e.message });
    console.warn(`[storage] loadJsonFile失败 ${filepath}: ${e.message}`);
    return null;
  }
}

/**
 * 如果文件存在则加载 JSON，否则返回默认值
 * @param {string} filepath
 * @param {any} defaultValue
 * @returns {any}
 */
export function loadJsonFileIfExists(filepath, defaultValue = {}) {
  if (fs.existsSync(filepath)) {
    const result = loadJsonFile(filepath);
    if (result === null) {
      // [0716 断电安全·凛倾日常因素审计] 损坏≠不存在：原直接回退 defaultValue，下游 read-modify-write
      //   链（yonban_config/正则库/_memory_presets 等）会把默认值写回覆盖 = 一个字节损坏静默清空用户数据。
      //   现先把损坏原件备份 <file>.corrupt.<ts>.bak（safeJsonIO 单源）再回退——功能照常降级启动，
      //   数据可从备份恢复。T019 抛错范式（readJsonSafeSync）仍是新代码首选；本原语调用面太广，
      //   改抛错=数十个启动路径行为突变，故取「备份+回退」温和态。
      const _bak = bakCorruptFile(filepath);
      wbD(null, "storage", "loadJsonFileIfExists:corrupt_fallback", false, `文件损坏，已备份${_bak ? " " + _bak : "失败"}后回退 defaultValue`, { path: filepath, bak: _bak });
      console.error(`[storage] ⚠ JSON 损坏: ${filepath}${_bak ? `（已备份 ${_bak}，可从备份恢复）` : "（备份失败）"}，本次按默认值继续`);
      return defaultValue;
    }
    return result;
  }
  return defaultValue;
}

/**
 * 保存 JSON 文件（带目录自动创建）
 * @param {string} filepath
 * @param {any} data
 */
export function saveJsonFile(filepath, data) {
  wbT(null, "storage", "saveJsonFile:write", { filepath });
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 0716 轮子收口：原子写步骤（tmp{pid}_{ts}+renameSyncWithRetry 内联）→ nicerWriteFileSync 单源
  //（同值内容跳写=白赚的减写盘；DL-1 半截文件防护/D-01 tmp 防互覆/D-09 重试语义全在单源内）。
  //   序列化格式（tab 缩进+尾换行）不变，读侧零感知。
  nicerWriteFileSync(filepath, JSON.stringify(data, null, "\t") + "\n");
  wbT(null, "storage", "saveJsonFile:done", { filepath });
  // 向量索引双写通知（tools/vectorBridge own 相关性判定+去抖；未启用=纯路径判断早退）。
  // fire-and-forget + 动态 import：storage 是 bootstrap 最底层、契约"不 import 兄弟模块"，
  // 故不建静态边；索引层任何故障不许打断记忆写链（向量=索引层，JSON 是数据源头）。
  try {
    import("../tools/vectorBridge.mjs").then((m) => m.notifyMemoryWrite(filepath, data)).catch(() => {});
  } catch { /* 双保险：同步阶段异常也不外抛 */ }
}

/**
 * 获取用户数据目录路径（不依赖 auth.mjs）
 * @param {string} username
 * @returns {string}
 */
// B·userDir 权威合一（07-03，凛倾"剩下的全部做"批）：yonban 层此前纯拼 __projectRoot/data/users/<u>，
//   与 shell 层权威 auth.getUserDictionary（UserDictionary 覆盖+BEILU_DATA_DIR=data_path）在覆盖启用时分叉。
//   合一形态=惰性动态桥接：storage 是 bootstrap 最底层模块，静态 import auth（→server/server 运行态）=装载序炸弹
//   （data_path 在 server.init 前 undefined）——故装载时异步取引用，取到前回退纯拼（bootstrap 窗口=原行为 byte-eq，
//   默认态两函数输出 resolve 归一后逐字节相等实测），取到后=shell 层权威单源。auth 不可装载时静默回退纯拼。
let _authUserDictionary = null;
import("../../security/auth.mjs")
  .then((m) => { _authUserDictionary = m.getUserDictionary; })
  .catch(() => { /* auth 不可用（独立进程直 import storage 等场景）→维持纯拼 */ });

export function getUserDataDir(username) {
  if (_authUserDictionary) {
    try { return _authUserDictionary(username); } catch { /* data_path 未初始化等 → 回退纯拼 */ }
  }
  return path.join(__projectRoot, "data", "users", username || "_default");
}

/**
 * yonban_config.json 权威路径（T7 收口：原 33 处散点手拼 path.join(__projectRoot,"data","users",u,"yonban_config.json")）
 * 【功能链】用户级运行态配置单文件（sub_modes/clones/tableCleanFrequency/deepwrite 等）——
 *   读走 loadJsonFileIfExists(此路径,{})，写走 saveJsonFile(此路径)；scopeResolver dataType "yonbanConfig" 同引此函数。
 * 【why 不走 resolvePath】resolvePath 命中即止（不存在→null），写场景需要确定路径；权威函数层才是读写共用的单点。
 * @param {string} username
 * @returns {string}
 */
export function getYonbanConfigPath(username) {
  return path.join(getUserDataDir(username), "yonban_config.json");
}

/**
 * 角色卡永久链路建链单源（T030 期D 补链：凛倾 2026-07-05「用户自己添加角色卡=增加一个永久的链路」）。
 * 【why 单源】"添加角色卡"的真实入口在 shell 端点 create-char / import-char（新建+导入），
 *   而写点原本只有 setDataActions addCharLink verb 一处（前端手动调用）——verb 与端点各自手写
 *   同一 JSON 字段会格式漂移，落盘逻辑收口本函数，verb case 与端点共调。
 * 【功能链】写 yonban_config.permanent_char_links[]（charName 数组，幂等去重）→ getCharLinks verb 读
 *   → cardsPanel 两层渲染（窗口分类）消费。对侧断链走 removePermanentCharLink（加卡建链、删卡才断；
 *   前端点×收起是视图态不进此路径）。
 * @param {string} username
 * @param {string} charName
 * @returns {{success: boolean, permanent_char_links?: string[], error?: string}}
 */
export async function addPermanentCharLink(username, charName) {
  if (!charName) return { success: false, error: "缺少 charName" };
  // T4 收口：读改写整段走 updateYonbanConfig 串行锁——与 saveClones/setActiveSubMode 等
  //   同文件写点并发时不再互覆字段（原独立 load+save 无锁，加卡与存分身同时发生会丢字段）。
  const links = await updateYonbanConfig(username, (cfg) => {
    if (!Array.isArray(cfg.permanent_char_links)) cfg.permanent_char_links = [];
    if (!cfg.permanent_char_links.includes(charName)) cfg.permanent_char_links.push(charName);
    return cfg.permanent_char_links;
  }, { permanent_char_links: [] });
  return { success: true, permanent_char_links: links };
}

/**
 * 角色卡永久链路断链单源（与 addPermanentCharLink 对侧）。
 * 【功能链】delete-char 端点删卡成功时调（卡目录已删=链必断，无条件）+ removeCharLink verb
 *   （前端二次确认后的显式断链）共调。幂等：链不存在时静默通过。
 * @param {string} username
 * @param {string} charName
 * @returns {{success: boolean, permanent_char_links?: string[], error?: string}}
 */
export async function removePermanentCharLink(username, charName) {
  if (!charName) return { success: false, error: "缺少 charName" };
  // T4 收口：与 addPermanentCharLink 对侧，读改写走 updateYonbanConfig 串行锁。
  const links = await updateYonbanConfig(username, (cfg) => {
    if (!Array.isArray(cfg.permanent_char_links)) cfg.permanent_char_links = [];
    cfg.permanent_char_links = cfg.permanent_char_links.filter((c) => c !== charName);
    return cfg.permanent_char_links;
  }, { permanent_char_links: [] });
  return { success: true, permanent_char_links: links };
}

/**
 * eye_config.json 权威路径（T7 批2 收口：原 replyHandler/gameCompanion/injection_state 各自手拼）。
 * 【功能链】用户级截图安全配置（黑白名单/感知模式/captureFrequency 等）——读写共用单点；scopeResolver dataType "eyeConfig" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getEyeConfigPath(username) {
  return path.join(getUserDataDir(username), "eye_config.json");
}

/**
 * command_config.json 权威路径（T7 批2 收口：原 setDataActions/replyHandler 各自手拼）。
 * 【功能链】用户级命令白名单能力授权（node/python/pip 分类开关）——读写共用单点；scopeResolver dataType "commandConfig" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getCommandConfigPath(username) {
  return path.join(getUserDataDir(username), "command_config.json");
}

/**
 * game_companion_config.json 权威路径（T7 批2 收口：原 setDataActions/gameCompanion 各自手拼）。
 * 【功能链】用户级游戏陪伴配置（绑定预设/API/频率自适应参数/D-1 bindChar/bindChat/bindMode）——读写共用单点；scopeResolver dataType "gameCompanionConfig" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getGameCompanionConfigPath(username) {
  return path.join(getUserDataDir(username), "game_companion_config.json");
}

/**
 * webhooks.json 权威路径（T7 批2 收口：原 api_v1_router 手拼）。
 * 【功能链】用户级 webhook 注册表（外部 URL 事件推送）——读写共用单点；scopeResolver dataType "webhooks" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getWebhooksPath(username) {
  return path.join(getUserDataDir(username), "webhooks.json");
}

/**
 * clone_resume 目录权威路径（T7 批2 收口：原 replyHandler 手拼，一处目录一处目录下文件）。
 * 【功能链】用户级分身续接上下文目录（clone_resume/{taskId}.json 逐 task 落盘）——返回目录，文件名由调用点拼；scopeResolver dataType "cloneResume" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getCloneResumeDir(username) {
  return path.join(getUserDataDir(username), "clone_resume");
}

/**
 * work/_work_config.json 权威路径（T7 尾段收口：原 scheduler/setDataActions/replyHandler/getPromptHandler/storage 各自"getMemoryDir 前段+尾段手拼"）。
 * 【功能链】卡级 work 模式配置（work 任务态开关/参数）——读写共用单点；scopeResolver dataType "workConfig" 同引。
 *   经 getMemoryDir 派生=charName confinePath 防穿越（SEC-T2）一并收敛。
 * @param {string} username
 * @param {string} charName
 * @returns {string}
 */
export function getWorkConfigPath(username, charName) {
  return path.join(getMemoryDir(username, charName), "work", "_work_config.json");
}

/**
 * 流程组 workflows 形状迁移（D09 收口：原 setDataActions 五 case + replyHandler W61 + getPromptHandler W58
 * 七处各自手抄"旧单槽→per-chatId"迁移块，收敛单源）。原地改 config，幂等。
 * 【功能链】_work_config.json 旧格式 {active_workflow, workflow_state} → 新格式 {workflows: {<chatid>: {...}}}。
 * @param {object} config - loadJsonFileIfExists(getWorkConfigPath(...)) 的解析结果
 */
export function migrateWorkflowsShape(config) {
  if (!config.workflows && config.active_workflow) {
    config.workflows = {
      [config.active_workflow_chatid || "_default"]: {
        active_workflow: config.active_workflow,
        workflow_state: config.workflow_state,
      },
    };
    delete config.active_workflow;
    delete config.active_workflow_chatid;
    delete config.workflow_state;
  }
  if (!config.workflows) config.workflows = {};
}

/**
 * 流程组槽解析单源（D09）：请求 chatid 有槽用之，否则回退 "_default"。
 * 【why】回退语义原只在 AI 侧（replyHandler W61 / getPromptHandler W58 `[_cid]||["_default"]`），
 *   动作/状态四 case（advance/approve/stop/getStatus）为精确键——手动启动的组全落 _default 槽
 *   （两个启动入口均不带 chatid），per-chatid 槽零生产者 ⇒ groupRuntimePanel（per-chatid 视角）
 *   的流程组区与按钮永不点亮，且与 AI 侧回退语义分裂（传导链报告 20260706 D09）。统一为
 *   "per-chatid 优先、_default 兜底"后所有读/动作/AI 点同槽一致。
 * 【契约】返回 {key, slot}；slot 为 config.workflows[key] 的活引用（改字段后 saveJsonFile(config) 即落盘），
 *   可能为 undefined（该键与 _default 均无槽），调用方自判。写回/新建槽用返回的 key，禁再手拼键。
 * @param {object} config
 * @param {string|null|undefined} chatid
 * @returns {{key: string, slot: object|undefined}}
 */
export function resolveWorkflowSlot(config, chatid) {
  migrateWorkflowsShape(config);
  const key = chatid && config.workflows[chatid] ? chatid : "_default";
  return { key, slot: config.workflows[key] };
}

/**
 * 窗口有效选中组解析单源（0722 凛倾「多窗口=每个窗口单独的链路」）。
 * 【存储形状】_work_config.selected_groups_map: { [chatid|"_default"]: {code?, work?} }——
 *   per-窗口两层：窗口层 [chatid]=本窗覆盖；"_default"=用户级长期层（新窗口/无 chatid 继承，
 *   承载「选择长期记录，除非切换」）。与 active_sub_modes_map（yonban）/workflows[chatid] 同键域范式。
 * 【写点】setSelectedFlowGroup / startFlowGroup（双层写：窗口层+长期层）；deleteFlowGroup 级联全槽清指针。
 * @param {object} config - loadJsonFileIfExists(getWorkConfigPath(...)) 的解析结果
 * @param {string|null} chatid
 * @returns {{code:string, work:string}} 该窗口生效的选中组 filename（空串=未选）
 */
export function resolveSelectedGroups(config, chatid) {
  const m = config.selected_groups_map || {};
  const win = (chatid && m[chatid]) || {};
  const def = m._default || {};
  return { code: win.code || def.code || "", work: win.work || def.work || "" };
}

/**
 * skill 组接受域解析单源（0722 凛倾「显示/切换/宏都按当前 skill 组隔离」）。
 * 【裁决序】本窗 running 组优先（chatid 槽 status=running 且组属请求的 modeGroup 域）→
 *   本窗有效选中组（resolveSelectedGroups：窗口层→用户长期层）→
 *   null（从未选组=无域限制，消费方维持原 modeGroup 全量语义）。
 * 【功能链】消费方同源：replyHandler <subModeSwitch> 越域阻断 / getPromptHandler+aiRunner
 *   宏清单过滤 / 前端顶栏列表（listFlowGroups 下发本窗有效值，前端零解析逻辑）。
 *   域=组文件 steps[].mode 集合，零硬编码，组变域变。
 * 【why modeGroup 校验】域按 modeGroup 定义：同一窗口跑着 work 组时，code 侧请求（窗口切模式/
 *   _default 槽回退命中他窗组）不该被 work 组 steps 堵死（交集恒空），组不属请求域即跳过
 *   running 回落选中组。
 * @param {string} username
 * @param {string} charName
 * @param {string|null} chatid
 * @param {string} modeGroup "code" | "work"
 * @returns {{source:"running"|"selected", filename:string, name:string, modeIds:string[]}|null}
 */
export function resolveSkillGroupDomain(username, charName, chatid, modeGroup) {
  const cfg = loadJsonFileIfExists(getWorkConfigPath(username, charName), {});
  const _loadWf = (fn) => loadJsonFileIfExists(path.join(getMemoryDir(username, charName), "work", "workflows", fn), null);
  const _wfMg = (wf) => wf?.modeGroup || (Array.isArray(wf?.steps) ? wf.steps[0]?.modeGroup : "") || "code";
  const _toDomain = (wf, fn, source) => {
    if (!wf || !Array.isArray(wf.steps) || !wf.steps.length) return null;
    const modeIds = wf.steps.map((s) => s?.mode).filter(Boolean);
    return modeIds.length ? { source, filename: fn, name: wf.name || fn, modeIds } : null;
  };
  try {
    const { slot } = resolveWorkflowSlot(cfg, chatid);
    if (slot?.active_workflow && slot?.workflow_state?.status === "running") {
      const wf = _loadWf(slot.active_workflow);
      if (!modeGroup || _wfMg(wf) === modeGroup || _wfMg(wf) === "all") {
        const dom = _toDomain(wf, slot.active_workflow, "running");
        if (dom) return dom;
      }
    }
  } catch { /* running 槽解析失败不堵 selected 兜底 */ }
  const selFn = modeGroup ? resolveSelectedGroups(cfg, chatid)[modeGroup] : "";
  if (!selFn) return null;
  return _toDomain(_loadWf(selFn), selFn, "selected");
}

/**
 * 选中组写入单源（0722：窗口层+用户长期层双层写，写点=setSelectedFlowGroup/startFlowGroup 共用，
 * 禁在调用点手拼 map——散写=键形状漂移温床）。原地改 config，调用方负责落盘（updateWorkConfig 锁内用）。
 * filename 空值=清除该 modeGroup 选择：两层删键（不是写空串——resolveSelectedGroups 的 || 回退会让
 * 窗口层空串穿透到长期层旧值=清不掉）。
 * @param {object} config
 * @param {string|null} chatid - 空/null 时只写 "_default"
 * @param {string} modeGroup
 * @param {string} filename - 组文件名；空串/假值=清除
 */
export function writeSelectedGroup(config, chatid, modeGroup, filename) {
  if (!config.selected_groups_map) config.selected_groups_map = {};
  for (const key of new Set([chatid || "_default", "_default"])) {
    const slot = { ...config.selected_groups_map[key] };
    if (filename) slot[modeGroup] = filename;
    else delete slot[modeGroup];
    config.selected_groups_map[key] = slot;
  }
}

/**
 * code/_code_config.json 权威路径（T7 尾段收口：原 aiRunner/setDataActions/replyHandler/getPromptHandler/getDataHandler/storage 各自手拼）。
 * 【功能链】卡级 code 模式配置（auto_snapshot/snapshot_max_count 等）——读写共用单点；loadCodeConfig/saveCodeConfig 同引；scopeResolver dataType "codeConfig" 同引。
 * @param {string} username
 * @param {string} charName
 * @returns {string}
 */
export function getCodeConfigPath(username, charName) {
  return path.join(getMemoryDir(username, charName), "code", "_code_config.json");
}

/**
 * screenshots/ 目录权威路径（T7 尾段收口：原 screenshot/injection_state 手拼）。
 * 【功能链】用户级截图归档目录（eye 截图落盘+注入读取）——返回目录不建目录（ensure 留调用点，行为零漂移）；scopeResolver dataType "screenshots" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getScreenshotsDir(username) {
  return path.join(getUserDataDir(username), "screenshots");
}

/**
 * _gc_capture_request.json 权威路径（T7 尾段收口：原 gameCompanion 写/删方与 endpoints 读方两端各手拼一份）。
 * 【功能链】用户级游戏陪伴截图请求标记文件（后端写标记→前端轮询触发截图→后端删标记）——读写删三端共用单点；scopeResolver dataType "gcCaptureRequest" 同引。
 * @param {string} username
 * @returns {string}
 */
export function getGcCaptureRequestPath(username) {
  return path.join(getUserDataDir(username), "_gc_capture_request.json");
}

// ============================================================
// 模式枚举（chat/code/work 三值）
// ============================================================
export const MODES = Object.freeze({ CHAT: 'chat', CODE: 'code', WORK: 'work' });
export const VALID_MODES = new Set([MODES.CHAT, MODES.CODE, MODES.WORK]);
export const isValidMode = (m) => VALID_MODES.has(m);
export const isIsolatedMode = (m) => m === MODES.CODE || m === MODES.WORK;

// ============================================================
// 写入队列（防止并发写入竞态）— ★ B18修复
// 同路径写入串行排队：Map<tablesPath, Promise>，N 次调用各写各自 data、按序逐次落盘。
// 不要把 _saveTablesLocks 与 _fileRmwLocks 混淆：
//   _saveTablesLocks = 串行排队写（每次写调用时已捕获的 data）
//   _fileRmwLocks = 串行执行整个 read-modify-write 回调（每次基于最新磁盘状态）
// ============================================================
export const _saveTablesLocks = new Map();

// ============================================================
// per-file 读-改-写串行锁（防止 lost-update 竞态）— ★ A3修复
// ------------------------------------------------------------
// 场景：多个后台任务对同一 JSON 队列文件（如 _pending_results.json）做
//   read → push/filter → write。若无锁，两个并发段会各读到旧内容、各自
//   修改、后写覆盖先写，导致先写那条结果永久丢失（lost-update）。
// 与 saveTablesData 不同（后者串行排队写、但每次写的是调用时捕获的 data、不重读磁盘，
//   并发"先读后改"会被后写覆盖丢更新）：本锁串行执行整个
//   read-modify-write 回调，每个回调都基于前一个写盘后的最新磁盘状态，
//   保证 append 类操作每一条都不丢。
// 同型于 ideClient._withWriteLock，但提为模块级、按文件路径分键的通用工具，
//   供非 IDE 路径（aiRunner / setDataActions / getPromptHandler）复用。
// 注意：仅在单进程内串行；跨进程并发写仍需 saveJsonFile 的 tmp+rename 原子性兜底。
// ============================================================
const _fileRmwLocks = new Map();

/**
 * 对指定文件路径串行执行一次「读-改-写」回调。
 * 同一 filepath 的并发调用会按调用顺序排队，逐个等前一个完成（含写盘）后再执行，
 * 从而消除 read-modify-write 的 lost-update 竞态。
 * @param {string} filepath - 作为锁键的文件绝对路径
 * @param {() => any} fn - 读改写回调（内部自行 read + 修改 + saveJsonFile）
 * @returns {Promise<any>} 回调的返回值
 */
export async function withFileLock(filepath, fn) {
  const prev = _fileRmwLocks.get(filepath) ?? Promise.resolve();
  let release;
  const myTurn = new Promise((res) => {
    release = res;
  });
  // 把「本次任务完成」串到链尾：后续排队者会等 myTurn resolve
  const chained = prev.then(() => myTurn).catch(() => myTurn);
  _fileRmwLocks.set(filepath, chained);
  try {
    // 等前序任务完成（其失败不阻塞本次）
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    // 队尾仍是自己时摘键，防 Map 单调泄漏（有后续者已 set 新链则不误删）
    if (_fileRmwLocks.get(filepath) === chained) _fileRmwLocks.delete(filepath);
  }
}

// ============================================================
// yonban_config.json 字段级收口 setter（T4：同一键多处散写根治）
// ------------------------------------------------------------
// 病根：per-user yonban_config.json 被 6+ 模块 15+ 写点各自
//   loadJsonFileIfExists → 改字段 → saveJsonFile 整文件 read-modify-write，无字段级
//   收口、无锁——两个入口（如一边 setActiveSubMode 一边 saveClones）几乎同时读到旧
//   内容、各改各的、后写整文件覆盖先写 → 用户设置随机丢失（lost-update）。
// 修法（框架级，非打补丁）：把「load→mutate→save」整段串行进 withFileLock（同 yonban_config
//   路径为锁键），单进程内并发写按序排队、每次基于前一次落盘后的最新磁盘状态改，字段互不覆盖。
//   全部写点改走此收口（读侧不变，仍可直接 loadJsonFileIfExists 只读）。
// why 复用 withFileLock 不新建锁：它已是「per-file 读-改-写串行」通用原语（A3 修复），
//   注释即声明供 setDataActions/getPromptHandler/aiRunner 复用——yonban_config 收口正是其目标场景。
// 跨进程并发仍由 saveJsonFile 的 tmp+rename 原子性兜底（与 withFileLock 注释同口径）。
// ============================================================

/**
 * yonban_config.json 字段级收口写口（mutator 式，覆盖全部读改写场景）。
 * 同一 username 的并发调用串行排队：load→mutator(cfg)→save 整段持锁执行，
 * 后一次读到的是前一次落盘后的最新状态，消灭整文件互覆的 lost-update。
 * @param {string} username - 用户名（yonban_config 按用户存；路径走权威 getYonbanConfigPath）
 * @param {(cfg:object)=>any} mutator - 读改写回调：直接 mutate 传入的 cfg（已 load）；
 *   其返回值即本函数返回值（供调用方拿回需要的派生数据，如变更后的数组）。
 *   ★ 若 mutator 显式返回哨兵 SKIP_SAVE，则本次不落盘（供「无变化不写盘」的等价保留，如
 *     removeChatSubModeMapping 原本仅在键存在时才 save；此时本函数返回 undefined）。
 * @param {any} [defaultValue] - 文件不存在时 load 的默认对象（同各写点原 loadJsonFileIfExists 第二参）
 * @returns {Promise<any>} mutator 的返回值（返回 SKIP_SAVE 时本函数返回 undefined）
 */
export const SKIP_SAVE = Symbol("yonbanConfig:skipSave");
export async function updateYonbanConfig(username, mutator, defaultValue = {}) {
  const cfgPath = getYonbanConfigPath(username || "_default");
  return withFileLock(cfgPath, async () => {
    const cfg = loadJsonFileIfExists(cfgPath, defaultValue);
    const ret = await mutator(cfg); // 支持 async mutator（如 getSubModes 迁移含 await 建预设——但建议把非 yonban_config 的 IO 留锁外）
    if (ret === SKIP_SAVE) return undefined; // 无变化：不落盘（保留原写点「仅变化时 save」语义）
    saveJsonFile(cfgPath, cfg); // saveJsonFile 自带目录创建+原子写
    return ret;
  });
}

/**
 * yonban_config.json 浅 patch 便捷写口（单/多顶层字段场景，如 group_worker_enabled/tableCleanFrequency）。
 * 内部走 updateYonbanConfig 同一串行锁，仅把 patch 的键浅合并进 cfg。
 * @param {string} username
 * @param {object} patch - 要写入的顶层字段键值
 * @param {any} [defaultValue]
 * @returns {Promise<object>} 合并后的完整 cfg
 */
export async function patchYonbanConfig(username, patch, defaultValue = {}) {
  return updateYonbanConfig(username, (cfg) => {
    Object.assign(cfg, patch);
    return cfg;
  }, defaultValue);
}

/**
 * _work_config.json 字段级收口写口（0722 skill组隔离追加）——与 updateYonbanConfig 同范式。
 * 【病根】per user×char 的 _work_config.json 被多写者（流程组五 case + selected_groups 两写点 +
 *   replyHandler W61 auto_advance + scheduler scheduled_tasks）各自 load→改→saveJsonFile 整文件
 *   RMW 无锁；advance/W61 的 load 与 save 之间有 await（读组文件/嵌套 yonban 锁）=真竞态窗，
 *   任一并发写者插入即 lost-update（如 selected_groups 被 scheduled_tasks 快照写回旧值抹掉）。
 * 【锁序不变式】嵌套恒为「work 锁外层 → yonban 锁内层」（W61/advance 在 mutator 内调
 *   updateYonbanConfig）；任何代码禁止在 updateYonbanConfig 的 mutator 里再进本锁，反向嵌套=死锁。
 * 【SKIP_SAVE】同 updateYonbanConfig：mutator 返回 SKIP_SAVE 不落盘（校验失败/无变化早退），
 *   早退的业务返回值经调用方闭包变量带出。跨进程仍由 saveJsonFile tmp+rename 原子性兜底。
 * @param {string} username
 * @param {string} charName
 * @param {(cfg:object)=>any} mutator - 支持 async；建议非 _work_config 的重 IO 留锁外
 * @param {any} [defaultValue]
 * @returns {Promise<any>} mutator 返回值（SKIP_SAVE 时 undefined）
 */
export async function updateWorkConfig(username, charName, mutator, defaultValue = {}) {
  const cfgPath = getWorkConfigPath(username, charName);
  return withFileLock(cfgPath, async () => {
    const cfg = loadJsonFileIfExists(cfgPath, defaultValue);
    const ret = await mutator(cfg);
    if (ret === SKIP_SAVE) return undefined;
    saveJsonFile(cfgPath, cfg);
    return ret;
  });
}

// ============================================================
// 时间工具函数
// ============================================================

/**
 * 获取今天的日期字符串 YYYY-MM-DD
 * @returns {string}
 */
export function getTodayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 获取 N 天前的日期字符串
 * @param {number} days
 * @returns {string}
 */
export function getDaysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 获取酒馆兼容时间宏值
 * @param {Array} [chatLog] - chat_log 数组（可选，用于 lasttime/lastdate/idle_duration）
 * @returns {object} { time, date, weekday, idle_duration, lasttime, lastdate }
 */
export function getTimeMacroValues(chatLog) {
  const now = new Date();
  const weekdays = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
  ];
  const result = {
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    weekday: weekdays[now.getDay()],
    idle_duration: "",
    lasttime: "",
    lastdate: "",
  };

  // 尝试从 chat_log 获取最后一条消息的时间
  if (chatLog && Array.isArray(chatLog) && chatLog.length > 0) {
    const lastMsg = chatLog[chatLog.length - 1];
    const ts =
      lastMsg.time_stamp ||
      lastMsg.timestamp ||
      lastMsg.time ||
      lastMsg.send_date;
    const lastTime = ts
      ? new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts)
      : now;
    if (!isNaN(lastTime.getTime())) {
      result.lasttime = `${String(lastTime.getHours()).padStart(2, "0")}:${String(lastTime.getMinutes()).padStart(2, "0")}`;
      result.lastdate = `${lastTime.getFullYear()}年${lastTime.getMonth() + 1}月${lastTime.getDate()}日`;
      const diff = now - lastTime;
      if (diff < 60000) result.idle_duration = "just now";
      else if (diff < 3600000)
        result.idle_duration = `${Math.floor(diff / 60000)} minutes ago`;
      else if (diff < 86400000)
        result.idle_duration = `${Math.floor(diff / 3600000)} hours ago`;
      else result.idle_duration = `${Math.floor(diff / 86400000)} days ago`;
    }
  }

  return result;
}

// ============================================================
// 默认常量/纯函数 — 提取到 defaults.mjs（零副作用、零 I/O）
// storage.mjs re-export 保持所有外部消费者 import 路径不变
// ============================================================
import {
  DEFAULT_CODE_TABLES,
  DEFAULT_WORK_TABLES,
  DEFAULT_TABLES,
  DEFAULT_MEMORY_PRESETS,
  DEFAULT_MEMORY_MODEL,
  DEFAULT_SYSTEM_TEXTS,
  DEFAULT_TOKEN_REMINDER,
  DEFAULT_INJECTION_PROMPTS,
} from "./defaults.mjs";

export {
  DEFAULT_CODE_TABLES,
  DEFAULT_WORK_TABLES,
  DEFAULT_TABLES,
  DEFAULT_MEMORY_PRESETS,
  DEFAULT_SYSTEM_TEXTS,
  DEFAULT_TOKEN_REMINDER,
  DEFAULT_INJECTION_PROMPTS,
};

export {
  DEFAULT_COMPACT_MERGE_INSTRUCTIONS,
  pickPresetPromptSet,
  p7HasMeaningfulPrompts,
  DEFAULT_CODE_SUB_MODES,
  DEFAULT_WORK_SUB_MODES,
  PERM_LEVEL_META,
  buildDefaultSkillGroups,
} from "./defaults.mjs";


// ============================================================
// 默认表格官方配置化（T075，data 资产官方配置化）
// ------------------------------------------------------------
// 【凛倾指令 2026-07-05】「data 一直没有官方配置」——三套默认表格模板（chat/code/work）
//   此前 100% 硬编码在上方代码常量（DEFAULT_TABLES/DEFAULT_CODE_TABLES/DEFAULT_WORK_TABLES），
//   非官方配置文件。本函数把「模板来源」收口到官方配置文件 default_tables.json，与
//   default_memory_presets.json（记忆预设官方配置，getMemoryPresets:2530 三级加载）同域同级同范式。
// 【范式对齐】模板文件优先 → 代码骨架兜底（fail-loud console.warn 留痕，非静默）。
//   与 getMemoryPresets 首次初始化三级加载（用户已有→模板文件→代码骨架）的后两级完全同构。
// 【per-user 播种】本函数只产「官方默认模板」；实际播种由现有各消费点完成——
//   ensureMemoryDir:1454(chat 首建 tables.json) / _ensureModeArtifacts:1953,1968(code/work 首建)
//   全部「文件不存在才写」= 惰性播种；用户已有表数据一字节不动；官方配置升级不覆盖用户已改
//   （消费点均 `if(!existsSync)` 守卫，播种只在缺失时）。tables.json 现存用户数据零改动。
// 【why 保留代码骨架常量】不删——降级为「配置文件缺失/损坏时的最后兜底」（fail-loud），
//   对齐 getMemoryPresets:2555 DEFAULT_MEMORY_PRESETS 兜底同款政策；禁静默吞错。
// 【缓存】per-mode 缓存已解析模板（进程级），避免 loadMemoryData 每次读盘；配置文件是只读官方
//   资产，进程生命周期内不变，缓存安全。structuredClone 由各消费点负责（不共享可变引用）。
// ============================================================
const _defaultTablesCache = new Map(); // mode -> tables[]（已 parse，消费点自行 structuredClone）

/**
 * 获取指定模式的官方默认表格模板（官方配置文件优先，代码骨架兜底）。
 * @param {"chat"|"code"|"work"} mode
 * @returns {Array} 默认表格数组（调用方需 structuredClone 后使用，勿直接改动返回引用）
 */
export function getDefaultTables(mode) {
  const safeMode = mode === "code" || mode === "work" ? mode : "chat";
  if (_defaultTablesCache.has(safeMode)) {
    return _defaultTablesCache.get(safeMode);
  }
  // 代码骨架兜底源（配置文件缺失/损坏时用）
  const skeleton =
    safeMode === "code"
      ? DEFAULT_CODE_TABLES
      : safeMode === "work"
        ? DEFAULT_WORK_TABLES
        : DEFAULT_TABLES;

  let tables = null;
  const templatePath = path.join(__pluginDir, "default_tables.json");
  try {
    if (fs.existsSync(templatePath)) {
      const template = loadJsonFile(templatePath);
      if (template && Array.isArray(template[safeMode])) {
        tables = template[safeMode];
        console.log(
          `[beilu-memory] 从官方配置初始化默认表格(${safeMode}): ${templatePath}`,
        );
      } else {
        // fail-loud：文件在但结构不对，留痕后走骨架兜底（不静默）
        console.warn(
          `[beilu-memory] default_tables.json 缺少 "${safeMode}" 数组，使用代码骨架兜底`,
        );
        wbD(null, "storage", "getDefaultTables:bad_shape", false, "官方表格配置结构异常，回退代码骨架兜底", { path: templatePath, mode: safeMode });
      }
    } else {
      // fail-loud：官方配置文件缺失，留痕后走骨架兜底
      console.warn(
        `[beilu-memory] 官方表格配置 default_tables.json 不存在，使用代码骨架兜底(${safeMode})`,
      );
      wbD(null, "storage", "getDefaultTables:missing", false, "官方表格配置文件缺失，回退代码骨架兜底", { path: templatePath, mode: safeMode });
    }
  } catch (e) {
    console.warn(
      `[beilu-memory] 读取 default_tables.json 失败，使用代码骨架兜底(${safeMode}): ${e.message}`,
    );
    wbD(null, "storage", "getDefaultTables:read_fail", false, "官方表格配置读取异常，回退代码骨架兜底", { path: templatePath, mode: safeMode, err: e.message });
  }

  if (!tables) tables = skeleton;
  _defaultTablesCache.set(safeMode, tables);
  return tables;
}


/**
 * 取系统注入文案：用户 per-char 配置（config.system_texts，updateConfig 写口）逐键覆盖 → 默认表。
 * 走 loadMemoryData（memoryCache 命中零额外 IO）；读取失败回默认不阻断调用方。
 * @param {string} key DEFAULT_SYSTEM_TEXTS 键
 */
export function getSystemText(key, username, charName) {
  try {
    const _v = loadMemoryData(username, charName, null, null)?.config?.system_texts?.[key];
    if (typeof _v === "string" && _v !== "") return _v;
  } catch { /* 配置读取失败回默认 */ }
  return DEFAULT_SYSTEM_TEXTS[key];
}


// ============================================================
// 内存缓存（按 "username/charName" 索引）
// ============================================================

/** @type {Map<string, { tables: object, config: object, username: string }>} */
export const memoryCache = new Map();

/**
 * 清除指定角色的所有缓存条目（含该角色所有模式 #code/#work/@chatId 变体）。
 * setActiveMode / setDataActions 改表结构后调用，强制下次 loadMemoryData 重读磁盘。
 */
export function clearCharCache(username, charName) {
  const prefix = `${username}/${charName}`;
  for (const k of [...memoryCache.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}#`)) memoryCache.delete(k);
  }
}

/**
 * 预设切换冷却计数器: Map<"username/charName", remainingRounds>
 * 每次 GetPrompt 调用递减 1，为 0 时允许切换，切换后重置
 */
export const presetSwitchCooldown = new Map();

// ============================================================
// 文件系统操作
// ============================================================

/**
 * 获取记忆目录路径
 * 新路径: data/users/{user}/chars/{charName}/memory/
 * @param {string} username
 * @param {string} charName
 * @returns {string}
 */
export function getMemoryDir(username, charName) {
  // SEC-T2：charName 不可信(来自请求体 data.charName)——限制在本用户 chars 目录内，
  //   阻断 ../ 穿越逃出自己 chars（配合 T1 username 锁定，杜绝跨账号读写他人记忆）。
  const charsRoot = path.join(getUserDataDir(username), "chars");
  const charDir = confinePath(charsRoot, String(charName ?? ""));
  return path.join(charDir, "memory");
}

/**
 * 一窗一线：读/写「角色卡的项目根」(per-卡 workspace_root，存卡 memory/_config.json)。
 * 未绑组的线(per-chatid worker)以此为 isolate 内 setWorkspaceRootOverride 的源 → 每卡跑各自项目根。
 */
export function getCardWorkspaceRoot(username, charName) {
  try {
    const cfgPath = path.join(getMemoryDir(username, charName), "_config.json");
    const cfg = loadJsonFileIfExists(cfgPath, {});
    return cfg.workspace_root || "";
  } catch { return ""; }
}

export function setCardWorkspaceRoot(username, charName, root) {
  const memDir = ensureMemoryDir(username, charName);
  const cfgPath = path.join(memDir, "_config.json");
  const cfg = loadJsonFileIfExists(cfgPath, { enabled: true });
  cfg.workspace_root = String(root || "");
  saveJsonFile(cfgPath, cfg);
  return { success: true, workspace_root: cfg.workspace_root };
}

/**
 * per-char _config.json 的 pending_tasks 追加写口（T5-4 收口）。
 * 【why】原写副作用埋在解析层 replyParser.parseMemoryNoteTags（头注释谎报"不写业务数据"），
 *   违反解析层无副作用契约、且直写无锁。现把落盘从解析层挪到本 storage 收口：
 *   解析层只返回 notes，由调用它的 handler（replyHandler/aiRunner）走此写口落盘。
 * 【语义等价】保留原「仅当 _config.json 已存在才写」——文件不存在不创建（用 getMemoryDir 非 ensureMemoryDir）。
 *   read-modify-write 走 withFileLock 串行（原直写无锁，与其他 _config.json 写点并发有 lost-update 风险）。
 * @param {string} username
 * @param {string} charName
 * @param {Array<{type:string,content:string}>} notes - 解析出的 memoryNote 条目
 * @returns {Promise<boolean>} 是否落盘（文件不存在或 notes 空 → false）
 */
export async function appendPendingTasks(username, charName, notes) {
  if (!Array.isArray(notes) || notes.length === 0) return false;
  const configPath = path.join(getMemoryDir(username, charName), "_config.json");
  if (!fs.existsSync(configPath)) return false; // 等价原 replyParser 的 if (fs.existsSync(configPath))
  return withFileLock(configPath, () => {
    const config = loadJsonFile(configPath);
    if (!config) return false; // 文件损坏读回 null → 不写（与原 loadJsonFile 后直接用同风险面，但不再 crash）
    config.pending_tasks = config.pending_tasks || [];
    for (const note of notes) {
      config.pending_tasks.push({
        type: note.type,
        content: note.content,
        created_at: new Date().toISOString(),
      });
    }
    saveJsonFile(configPath, config);
    return true;
  });
}

// ============================================================
// ②T1 记忆晋升：能力层(经验)可晋升 _global 跨角色复用 / 关系层结构上硬隔离
// ============================================================
// 复合键白名单 (mode, tableId)——**裸 id 会撞车**：
//   code#4=错误·经验表(晋升) 但 code#3=流程·架构索引(拒) ; work#3=经验记录(晋升) 但 work#4={{user}}画像(拒)。
//   裸 id [3,4] 会误晋升 code#3 流程架构 + work#4 画像(正是关系层)，故必须复合键。
const PROMOTE_WHITELIST = [
  ["code", 4], // 错误·经验表（能力层）
  ["work", 3], // 经验记录（能力层）
];

/** 该 (mode, tableId) 是否属能力层、允许晋升 _global。关系层(画像/社交/永久)恒 false。 */
export function isPromotable(mode, tableId) {
  return PROMOTE_WHITELIST.some(([m, id]) => m === mode && Number(tableId) === id);
}

/**
 * 把一条经验类表条目晋升到 _global（跨角色可复用）。关系层条目结构上进不来（白名单拒）。
 * 写 `chars/_global/memory/promoted_experience.json`：{ rev, entries:[{mode,columns,value,ref,audit,_sig}] }。
 * rev 乐观并发：beilu 单进程内 read→write 同步无 await 间隙=原子；rev 供前端乐观并发 + 审计。
 * _sig 去重：同源同值不重复 append。
 * @returns {{ok:boolean, rejected?:boolean, dup?:boolean, rev?:number}}
 */
export function promoteToGlobal(username, mode, tableId, columns, rowValues, fromChar) {
  if (!isPromotable(mode, tableId)) return { ok: false, rejected: true };
  const file = path.join(ensureMemoryDir(username, "_global"), "promoted_experience.json");
  const cur = loadJsonFileIfExists(file, { rev: 0, entries: [] });
  if (!Array.isArray(cur.entries)) cur.entries = [];
  const sig = JSON.stringify(rowValues);
  if (cur.entries.some((e) => e._sig === sig && e.ref && e.ref.fromChar === fromChar)) {
    return { ok: true, dup: true };
  }
  const nextRev = Number(cur.rev || 0) + 1;
  cur.entries.push({
    mode,
    columns: Array.isArray(columns) ? columns : [],
    value: rowValues,
    ref: { fromChar, mode, tableId: Number(tableId) },
    audit: [{ ts: Date.now(), op: "promote", rev: nextRev, fromChar }],
    _sig: sig,
  });
  cur.rev = nextRev;
  saveJsonFile(file, cur);
  return { ok: true, rev: nextRev };
}

/**
 * 确保记忆目录存在，若不存在则创建并初始化默认文件
 * 如果旧路径 memory/{charName}/ 存在数据，自动迁移到新路径
 * @param {string} username
 * @param {string} charName
 * @returns {string} 记忆目录路径
 */
export function ensureMemoryDir(username, charName) {
  const memDir = getMemoryDir(username, charName);

  // 旧路径迁移检查: data/users/{user}/memory/{charName}/
  if (!fs.existsSync(memDir)) {
    const oldMemDir = path.join(getUserDataDir(username), "memory", charName);
    if (fs.existsSync(oldMemDir)) {
      // 确保新路径父目录存在
      const parentDir = path.dirname(memDir);
      if (!fs.existsSync(parentDir))
        fs.mkdirSync(parentDir, { recursive: true });
      // 重命名（移动）旧目录到新路径
      try {
        fs.renameSync(oldMemDir, memDir);
        console.log(`[beilu-memory] 迁移记忆目录: ${oldMemDir} → ${memDir}`);
      } catch (e) {
        // renameSync 跨盘可能失败，回退为递归复制
        wbD(null, "storage", "ensureMemoryDir:rename_fail_copy", false, "记忆目录迁移 renameSync 失败，回退递归复制（疑似跨盘/EPERM）", { src: oldMemDir, dst: memDir, err: e.message });
        console.warn(
          `[beilu-memory] renameSync 失败，尝试递归复制: ${e.message}`,
        );
        fs.cpSync(oldMemDir, memDir, { recursive: true });
        // 验证复制完整后再删源，避免复制中断+源已删导致数据丢失
        const _srcCount = fs.readdirSync(oldMemDir).length;
        const _dstCount = fs.existsSync(memDir) ? fs.readdirSync(memDir).length : 0;
        if (_dstCount < _srcCount) {
          wbD(null, "storage", "ensureMemoryDir:copy_incomplete", false, "记忆目录复制不完整，保留源目录并抛出（防数据丢失）", { src: oldMemDir, dst: memDir, srcCount: _srcCount, dstCount: _dstCount });
          throw new Error(
            `记忆目录复制不完整 (${_dstCount}/${_srcCount} 条目)，已保留源目录: ${oldMemDir}`,
          );
        }
        fs.rmSync(oldMemDir, { recursive: true, force: true });
        console.log(
          `[beilu-memory] 迁移记忆目录(复制模式): ${oldMemDir} → ${memDir}`,
        );
      }
      return memDir;
    }
  }

  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
    // 初始化子目录
    fs.mkdirSync(path.join(memDir, "hot", "remember_about_user"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(memDir, "warm"), { recursive: true });
    fs.mkdirSync(path.join(memDir, "cold"), { recursive: true });
    fs.mkdirSync(path.join(memDir, "vocab", "core"), { recursive: true });

    // 初始化默认 tables.json —— T075：模板来源收口到官方配置 default_tables.json（getDefaultTables 优先读，骨架兜底）
    saveJsonFile(path.join(memDir, "tables.json"), {
      tables: structuredClone(getDefaultTables("chat")),
    });

    // 初始化默认 _config.json
    saveJsonFile(path.join(memDir, "_config.json"), {
      enabled: true,
      retrieval_ai: {
        api_key: null,
        model: DEFAULT_MEMORY_MODEL,
        base_url: null,
        fallback_to_dialogue: true,
      },
      summary_ai: {
        api_key: null,
        model: DEFAULT_MEMORY_MODEL,
        base_url: null,
        fallback_to_dialogue: true,
      },
      injection: {
        tables_token_budget: null,
        hot_memory_token_budget: 3000,
        warm_memory_token_budget: 2000,
        cold_search_enabled: true,
        hot_md_max_chars: 40000,
        work_hot_max_chars: 30000,
        forever_top_k: 100,
      },
      archive: {
        temp_memory_threshold: 50,
        cold_archive_after_days: 30,
      },
      retrieval: {
        auto_trigger: true,
        max_file_size: 512000,
        chat_history_count: 5,
        chat_history_count_chat: 10,
        chat_history_count_code: 5,
        chat_history_count_work: 5,
        max_search_rounds: 5,
        timeout_ms: 60000,
      },
      preset_switch: { cooldown_rounds: 5 },
      // 联网搜索配置（2026-07-10 键收口重构）：键名与消费端 web/webSearch.mjs executeWebSearch
      //   读键一字不差（原 searxng_base_url/search_depth/include_domains/exclude_domains 为断链死键已删，
      //   消费端旧读名 search_api_key/max_search_results/search_timeout_ms 同步统一）。
      //   p8_enabled: P8 搜索AI 主动帮搜（与直搜 autoSearch 独立，两条路径可同时开）。
      //   engine 值域单源=webSearch.mjs SUPPORTED_ENGINES（默认 browser=Chrome 拟人流主通道，
      //   凛倾 0717 拍板）；tavily/searxng 为进阶 API 通道值。
      //   domain_whitelist 空=不限，domain_blacklist 命中即滤（消费端 isDomainAllowed）。
      web_search: {
        enabled: false,
        p8_enabled: true,
        // [0726 002「不需要选择平台,直接是多平台注入」] multi=并发默认池（webSearch.DEFAULT_MULTI_ENGINES）
        //   速度=最慢的那个且有时间窗封顶，容错=单平台失败其余照返，质量=多平台共识权重自动生效
        engine: "multi",
        engines: [],              // 空=用默认池；显式列表可覆盖成员（禁硬编码，用户可改）
        multi_window_ms: 5000,    // 并发时间窗：窗口内回来的都用，未回来的丢弃（保证"多平台"不牺牲速度）
        tavily_api_key: "",
        searxng_url: "",
        max_results: 5,
        timeout_ms: 8000,
        domain_cap: 2, // 结果域名多样性：单域名最多 N 条（0=不限），消费端 executeWebSearch ④
        domain_whitelist: [],
        domain_blacklist: [],
        noise_filter: true,
        noise_keywords: [],
        proxy_url: "",
        browsers_path: "",
        p8_source: "",
        inject_once: false,      // [0726] true=搜索结果只本轮可见(瞬态注入,不进对话历史); false=作为对话内容保留
        // [0726 Chrome 扩用] browser 引擎内的源顺序（同一拟人流骨架换内容源，非跨引擎兜底）：
        //   bing 优先（0717「以谷歌浏览器为主」拍板的内容源不变），失败按序降级；每次降级 diag 留痕
        //   且结果 source 标 "browser:<源>" 可见（错误可见精神保留）。改成 ["bing"] 即恢复单源行为。
        //   可选值见 browserSearch.BROWSER_SOURCES（bing/ddg/baidu）。
        // [0726 002「算法去优化搜索内容,看占比」] 排序权重配置化落位（rankAndDedupe 已支持 config.rank_weights
        //   覆盖，此前无默认键=用户无从知道可调、前端也无入口）。各信号先归一 [0,1] 再加权，分母按激活
        //   信号自适应（信号缺席不惩罚）。engine_score 仅 tavily/searxng 有；position=引擎原始位次 RRF；
        //   consensus=多引擎共识；bm25=本地相关度；info=摘要信息量；integrity=URL/标题完整度。
        rank_weights: { engine_score: 3, position: 1.5, consensus: 1.5, bm25: 2.5, info: 0.5, integrity: 0.5 },
        no_match_threshold: 0.15,      // 低于此连续匹配分判 no_match（cjkMatchScore，CJK bigram）
        poison_threshold: 0.8,         // no_match 占比 ≥ 此值且零干净结果 → 报投毒（error）
        poison_warn_threshold: 0.5,    // ≥ 此值 → 结果照给但带 warning（成功但需自判）
        title_dedupe_threshold: 0.15,  // 标题编辑距离比 < 此值判近重合并
        browser_sources: ["bing", "baidu"],
        // [0726 Chrome 扩用] 深抓正文：搜索后用同一浏览器实例抓 top-N 结果正文（snippet 升级为全文摘录）。
        //   0=关（默认，行为不变）；每条多耗 1-3s，建议 1-2。上限由 deep_fetch_max_chars 截断。
        deep_fetch_top_n: 0,
        deep_fetch_max_chars: 2000,
        // [0726 002「正文用关键词看正文内容匹配」] 正文校验（消费端 webSearch.verifyByContent）：
        //   并发抓 top-N 正文按查询词打分，标题像而正文不对的降权（实测搜狗对英文查询会混进
        //   "Linux 2.0 Release Notes" 这类词面像的无关条目）；抓取失败不惩罚、低分只降权不删除。
        content_verify: true,
        content_verify_top_n: 4,
        content_verify_window_ms: 2200,  // 整体时间窗：不得吃掉多平台并发省下的时间
        content_verify_max_chars: 4000,
        content_verify_threshold: 0.12,
        // [0726] Python 通道两项（消费端 web/webSearch.mjs searchViaDdgs + ddgs_bridge.py）
        python_cmd: "",            // 空=自动（windows→python，其他→python3），与 beilu-ppt pythonCmd 同义
        python_auto_install: true, // ddgs 依赖缺失时后台自动安装（进程级一次）；关=只报错并给手动安装动线
        ddgs_backend: "bing",
        ddgs_region: "",           // 空=按查询语言自动（含 CJK→cn-zh，否则 us-en）；库默认 us-en 会让中文查询拿回英文结果被判无关     // 单后端最快（实测 bing 1.7s）；"auto" 库内多引擎轮试更稳但 5-6s
        // [0726 反检测/性能] browser 引擎三项（消费端 web/browserSearch.mjs）
        user_agent: "",           // 空=自动取内核真实 UA 并去 headless 字样（版本与 Sec-CH-UA 一致，随内核升级自动跟随）；非空=完全覆盖
        stealth: true,            // 自动化指纹补丁（webdriver/window.chrome/plugins/permissions 一致性）
        // 拦截图片/字体/音视频。**默认关**：0726 三轮实测，开启时必应搜索 25-27s 全部超时失败、
        //   关闭时 2.5s 成功——根因是 playwright 只要注册 route 就禁用 HTTP 缓存且所有请求回 Node 端
        //   判匹配，对靠缓存加速的持久 profile 伤害远大于省下的图片流量。仅在大批量深抓时值得开。
        block_resources: false,
      },
      token_reminder: structuredClone(DEFAULT_TOKEN_REMINDER),
      // [0716 凛倾定案] mode_preset_bindings 默认键已删——「绑定」概念不存在，只有「当前正在使用的预设」。
      pending_tasks: [],
    });

    // 初始化空的热记忆文件
    saveJsonFile(path.join(memDir, "hot", "forever.json"), { entries: [] });
    saveJsonFile(path.join(memDir, "hot", "items_archive.json"), { items: [] });
    saveJsonFile(path.join(memDir, "hot", "appointments.json"), {
      entries: [],
    });
    saveJsonFile(path.join(memDir, "hot", "user_profile.json"), {
      entries: [],
    });
    saveJsonFile(path.join(memDir, "hot", "warm_monthly_index.json"), {
      months: [],
    });
    saveJsonFile(path.join(memDir, "warm", "cold_yearly_index.json"), {
      years: [],
    });
  }
  return memDir;
}

// ============================================================
// 数据加载与持久化（模式感知）
// ============================================================

// ============================================================
// 模式管理工具
// ============================================================

// T5 收尾：模式合法集从三值硬编码放开为可注册集（自定义 ModeDef 真实生成的前提）。
// 依赖方向：pipelines runner 发现 modes/*.json 后调 registerModeIds 注入（storage 不 import pipelines）。
// 内置集：chat/code/work + smart/bot（凛倾 2026-07-06 拍板「4个模式就是现在前端的4个模式」=smart/chat/code/work
//   四绑定维度 + 6口之③bot 独立绑定维度）。smart/bot 进初始集而非只靠 modes/*.json 异步注册——
//   注册链挂在首次生成（prompt_struct→shadowBuild→getModeDef），存在「先切模式后首次生成」时序洞：
//   切 smart 的 switchMode 会在注册发生前被 isValidModeId 拒。产品内置模式不吃这个时序，故入初始集；
//   modes/smart.json、bot.json 仍提供 pipeline 行为定义（首版照抄 chat 真值）。
const _validModeIds = new Set(["chat", "smart", "code", "work", "bot", "live"]); // [0724] smart 回归内置集（002:「用以前的全智能模式」，0723 删除撤销）; [0727] live 加入内置集（002:「加一个直播的，直播专门的路线」）
export function registerModeIds(ids) {
  for (const id of ids ?? []) {
    if (typeof id === "string" && /^[\w-]+$/.test(id)) _validModeIds.add(id);
  }
}
export function isValidModeId(m) {
  return _validModeIds.has(m);
}
/** 合法模式 id 枚举（注入系统 injectionSystem.mjs 值域/元数据消费；只读快照） */
export function listModeIds() {
  return [..._validModeIds];
}

// ModeDef features 只读镜像（0716 接线批：功能层「mode==="work"」类硬编码模式门 → 声明表消费的通用读口）。
// 依赖方向同 registerModeIds：runner 发现 modes/*.json 后经同一注册钩注入，storage 不 import pipelines。
// 时序洞关法=scheduler.mjs _preheatModeDefs（带重试预热 loadModeDefs，填表惠及全域）；
// 注册未达/未知模式 → enabled:false + config:{} 诚实降级。
const _modeFeaturesById = new Map();
export function registerModeFeatures(defs) {
  for (const d of defs ?? []) {
    if (d?.id) _modeFeaturesById.set(d.id, d.features ?? null);
  }
}
/** 读某模式对某功能库的声明。@returns {{enabled:boolean, config:object}} */
export function modeFeature(mode, lib) {
  const f = _modeFeaturesById.get(mode)?.[lib];
  return { enabled: f?.enabled === true, config: f?.config ?? {} };
}
/** 声明表是否已注册（启动最初数秒预热未达时=false）。有副作用的消费点（如 switchMode 启停调度器）
 *  应在未就绪时跳过动作而非按全 false 误动作；只读注入类消费点直接诚实降级即可不必查此口。 */
export function modeFeaturesReady() {
  return _modeFeaturesById.size > 0;
}

// bot 生成模式单源（凛倾 07-09「bot 禁止硬编码，追动态链路」）。
//   bot 上下文的天然动态标识=request.extension.platform：9 个 bot 壳（0716 删 kookbot）在 generateChatReplyRequest
//   均设 extension.platform（discord/telegram/.../wechat），web 主链 requestBuilder.mjs:159 恒为
//   extension={}，组 worker（groupReplyRunner）仅转发不改。故生成侧据此单源判定「这是 bot 调用」→
//   用 "bot" 模式（跳过 web 端 active_mode 的 tab 联动漂移，预设走线级 active_preset_map[cid:bot]/
//   全局 active_preset + INJ autoMode="bot" 门控）。壳不再各自硬编码 mode:"bot" 字面量。
export const BOT_GENERATION_MODE = "bot";
export function resolveBotModeFromRequest(arg) {
  return arg?.extension?.platform ? BOT_GENERATION_MODE : null;
}

// 生成侧 mode 裁决唯一单源（凛倾 07-15「我们需要单个——禁止散写，或者高耦合」）。
//   三级链语义原样取自 injectionSystem.resolveInjectionContext（0713 识别收口时的拍板链路）：
//     1. bot 平台派生：resolveBotModeFromRequest（bot 壳 cid 是平台会话名不匹配 _CHATID_RE，
//        走 per-chat 链会污染 char 级，故最先短路）
//     2. 显式契约槽：arg.mode 且 isValidModeId（当前无壳传入，兼容保留）
//     3. per-chat 绑定链：getActiveMode（active_modes_map[chatId] → char 级 → _global → "chat"）
//   消费方=所有拿着生成请求 arg 的链路节点（shadowBuild ViaModes / injectionSystem /
//   preset GetPrompt / replyHandler / worldbook 生成链）。0715 双判定链收口前，ViaModes 只走
//   getActiveMode（不看 platform）→ bot 壳请求的 ModeDef 骨架随 web 端 active_mode 漂移、
//   bot.json hooks 不被消费，而 INJ/preset 已按 platform 判 bot——同一请求两条判定链分叉。
//   无 arg 的语境（web 面板显示链、SetData 动作链、调度器）不属本函数域，直接用 getActiveMode。
export function resolveGenerationMode(arg, username, charName, chatId = null) {
  return resolveBotModeFromRequest(arg) ||
    ((arg?.mode && isValidModeId(arg.mode)) ? arg.mode : getActiveMode(username, charName, chatId ?? null));
}

/**
 * 获取当前活跃模式
 * N38 per-chatId 隔离（设计：全智能_界面设计.md §4.1 一个对话一条线路）：
 * 传入 chatId 时优先返回该对话线的绑定模式（active_modes_map[chatId]，
 * 镜像 active_sub_modes_map 范式）；未绑定回退 char 级 active_mode → _global → "chat"。
 * @param {string} username
 * @param {string} charName
 * @param {string} [chatId] - 对话线 ID（窗口=对话=chatId）
 * @returns {string} "chat" | "code" | "work"
 */
export function getActiveMode(username, charName, chatId = null) {
  const memDir = getMemoryDir(username, charName);
  const configPath = path.join(memDir, "_config.json");
  const config = loadJsonFileIfExists(configPath, { enabled: true });
  if (chatId && config.active_modes_map && typeof config.active_modes_map === "object") {
    const bound = config.active_modes_map[chatId];
    if (isValidModeId(bound)) return bound; // T5：合法集含已注册自定义模式
  }
  let mode = config.active_mode;
  // fallback: 角色目录没有 active_mode 时，查 _global（YonBan等客户端可能写到 _global）
  if (!mode && charName !== "_global") {
    const globalDir = getMemoryDir(username, "_global");
    const globalConfig = loadJsonFileIfExists(path.join(globalDir, "_config.json"), {});
    mode = globalConfig.active_mode;
  }
  mode = mode || "chat";
  // 防御：只允许合法值（T5：内置集 _validModeIds+已注册自定义）
  if (!isValidModeId(mode)) {
    diag.warn(`getActiveMode: 非法模式值 "${mode}"，回退到 "chat"`);
    return "chat";
  }
  return mode;
}

// [T047] chatId 形态守卫（后端落盘入口单点，覆盖 writeActiveSubModeId 的全部 8 条写路径——
//   [2026-07-11 C6 注释校准] 原"9条"与下方 :1921"8条"矛盾，实测 8：setDataActions×3 + replyHandler×4 + getPromptHandler×1）。
// 关联链（单源）：与前端 sharedState.mjs:105 `_CHATID_RE=/^[a-z0-9]{7,15}$/` 同规则——
//   前端 getChatId() 已用它把非法 hash（分段气泡锚点 comp-seg-bubble 等）挡成 ""，
//   但非 web 调用方（AI 驱动 replyHandler/getPromptHandler、flowGroup）可绕过前端直传 chatId，
//   故后端 map 落盘入口再补同规则守卫一处（禁在每个 case 散加 if）。
// why 放行 "_default"：flowGroup（setDataActions:3481/:3525 `args?.chatid||data.chatid||"_default"`）
//   把 "_default" 当「无对话归属」的真实隔离键——writeActiveSubModeId 写 map["_default"]、
//   resolveActiveSubModeId 也从 map["_default"] 读回（读写对称、有 subModeSwitch.from 消费），
//   是系统保留合法键，非脏 hash。若用纯 _CHATID_RE 拦它会破坏 flowGroup 回读。
const _SM_CHATID_RE = /^[a-z0-9]{7,15}$/; // 单源同步自前端 sharedState.mjs:105 _CHATID_RE
/** map key 是否为合法 per-chatId 隔离键：真实 chatid(_SM_CHATID_RE) 或系统保留 "_default"。 */
function _isValidSubModeChatKey(chatId) {
  return chatId === "_default" || (typeof chatId === "string" && _SM_CHATID_RE.test(chatId));
}

export function resolveActiveSubModeId(smConfig, modeGroup, chatId) {
  // [T047] 与 writeActiveSubModeId 守卫对称：脏 chatId 视同无 chatId 走全局字段回退，
  // 保证「写被守卫拦→全局字段」与「读也走全局字段」一致，不产生读写错位。
  if (chatId && _isValidSubModeChatKey(chatId)) {
    if (smConfig.active_sub_modes_map?.[chatId]) {
      // [0725 组维度守卫] active_sub_modes_map 按 chatId 单值无组维度——记录是 code 子模式时,
      //   work 组解析也返回它=跨组泄漏(work 格显示 code 预设实证;与预设裸键 [cid] 同族病)。
      //   组不符=视同本组无记录,落到下方组起点默认;组相符/查无条目(自定义子模式兼容)原样返回。
      const _mid = smConfig.active_sub_modes_map[chatId];
      const _me = (smConfig.sub_modes || []).find((m) => m.id === _mid);
      if (!_me || (_me.modeGroup || "code") === modeGroup) return _mid;
    }
    // bot 组（0723 凛倾「每个外部bot一个子模式」）：纯 opt-in 参数覆盖，无组起点默认——
    // 无记录=""（无覆盖，参数回退预设/runtime 基线）。此前回退 "前置任务专家"（code 组）
    // 靠下游跨组守卫才 inert，语义不诚实。
    if (modeGroup === "bot") return "";
    // 带 chatId 但本对话无记录：从流水线起点开始，不继承全局 active_sub_mode
    // （全局字段可能被卡在 code-expert，会让每个新对话/刷新都跳到代码专家，破坏流水线循环）
    return modeGroup === "work" ? "work-task-confirm" : "前置任务专家";
  }
  if (modeGroup === "bot") return ""; // bot 无全局激活字段：覆盖只挂平台线（per-chatId map）
  if (modeGroup === "work") return smConfig.active_sub_mode_work || "work-task-confirm";
  return smConfig.active_sub_mode || "前置任务专家";
}

/**
 * 删聊天清理链（deleteChat 第⑨站，07-03 补链）：清 yonban_config.active_sub_modes_map 的 per-chatId 残键。
 * 【why】删聊天此前不清此映射→yonban_config 积累死键（孤儿复扫实证 2 条）。读写走权威路径单点 getYonbanConfigPath。
 * @param {string} username
 * @param {string} chatId
 * @returns {boolean} 是否清了键
 */
/**
 * 删聊天清理链（0722 每窗独立链路配对删链）：清 _work_config 的 per-chatId 窗口层键——
 * selected_groups_map[chatid]（窗口层选中组）+ workflows[chatid]（流程组运行槽，凛倾 0722「修」
 * 拍板收编：死聊天的运行槽纯脏数据，_default 手动槽不在清理域）。
 * 【why】凡建 per-chat 键必配删链（同 removeChatSubModeMapping 范式）——否则删聊天积累死键。
 *   "_default" 用户长期层/手动槽不清（跨聊天语义）。
 * @param {string} username
 * @param {string} charName
 * @param {string} chatId
 * @returns {Promise<boolean>} 是否清了键
 */
export async function removeChatWorkConfigMappings(username, charName, chatId) {
  if (!chatId || chatId === "_default") return false;
  try {
    let _cleared = false;
    await updateWorkConfig(username, charName, (cfg) => {
      if (cfg?.selected_groups_map && cfg.selected_groups_map[chatId] !== undefined) {
        delete cfg.selected_groups_map[chatId];
        _cleared = true;
      }
      if (cfg?.workflows && cfg.workflows[chatId] !== undefined) {
        delete cfg.workflows[chatId];
        _cleared = true;
      }
      return _cleared ? cfg : SKIP_SAVE;
    }, {});
    return _cleared;
  } catch (e) {
    diag.warn(`removeChatWorkConfigMappings 失败: ${e.message}`);
  }
  return false;
}

export async function removeChatSubModeMapping(username, chatId) {
  if (!chatId) return false;
  try {
    // T4 收口：读改写走 updateYonbanConfig 串行锁；无键时 mutator 返回 SKIP_SAVE 保留原「仅变化才落盘」语义
    //   （文件不存在→cfg=null→不落盘不创建空文件，与原 loadJsonFileIfExists(p, null) 行为一致）。
    let _cleared = false;
    await updateYonbanConfig(username, (cfg) => {
      if (cfg?.active_sub_modes_map && cfg.active_sub_modes_map[chatId] !== undefined) {
        delete cfg.active_sub_modes_map[chatId];
        _cleared = true;
        return cfg;
      }
      return SKIP_SAVE;
    }, null);
    return _cleared;
  } catch (e) {
    diag.warn(`removeChatSubModeMapping 失败: ${e.message}`);
  }
  return false;
}

// 契约：本函数只 mutate 传入的 smConfig 内存对象、不落盘（首参无 username 拿不到路径）。
//   [T4 收口校准 2026-07-13] 原注释「调用方必须自行 saveJsonFile」已过时——各调用方（setDataActions/
//   replyHandler/getPromptHandler 的子模式切换点）不再各自 loadJsonFileIfExists→writeActiveSubModeId→
//   saveJsonFile 无锁散写，而是把该整段包进 updateYonbanConfig(username, cfg => { writeActiveSubModeId(cfg,...); return cfg; })
//   走 withFileLock 串行落盘（字段级收口，并发写不互覆）。本函数仍只 mutate，落盘由 updateYonbanConfig 统一负责。
export function writeActiveSubModeId(smConfig, modeGroup, id, chatId) {
  // [T047] chatId 形态守卫（框架级单点，覆盖全部 8 条写路径）：
  //   合法 chatid 或系统保留 "_default" 才写 map；脏 chatId（非法 hash 锚点等）视同无 chatId
  //   走全局字段分支，避免 active_sub_modes_map 累积永不回读、永不 GC 的脏 key（缓慢泄漏）。
  //   被拦留痕（diag.warn），不静默丢弃——便于定位是哪个调用方传了脏 chatId。
  if (chatId && !_isValidSubModeChatKey(chatId)) {
    diag.warn(`writeActiveSubModeId: 非法 chatId "${chatId}" 被守卫拦截，视同无 chatId 写全局字段（modeGroup=${modeGroup}）`);
    chatId = "";
  }
  if (chatId) {
    // per-chatId 全隔离（蓝图阶段3）：带 chatId 只写本窗口映射，
    // 不再双写全局字段——双写会让 A 窗口切子模式污染 B 窗口的回退默认。
    if (!smConfig.active_sub_modes_map) smConfig.active_sub_modes_map = {};
    smConfig.active_sub_modes_map[chatId] = id;
    return;
  }
  // 无 chatId（单窗口/旧调用方）维持 per-modeGroup 全局字段
  if (modeGroup === "work") smConfig.active_sub_mode_work = id;
  else smConfig.active_sub_mode = id;
}

/**
 * [键收口 2026-07-13] 子模式切换广播体构造器（契约单源）。
 * 【why】_subModeSwitch / subModeSwitch 事件体此前由 7 个生产点各自手拼（replyHandler×4 +
 *   setDataActions setActiveSubMode/startFlowGroup/advanceFlowGroup）——字段集质量不齐
 *   （两处缺 modeGroup、全数缺 chatId），前端镜像监听器（subModePanel beilu:subModeSwitched）
 *   按事件键写 _activeSubModesMap，缺键=拿浏览器当前 cid 盖写→与后端落盘键错位回灌。
 *   契约收成本函数后新增生产点不可能再漏字段。
 * 【契约】chatId=本次切换真实落盘键（""=全局字段、"_default"=无对话归属），与 writeActiveSubModeId
 *   实际所写的键必须同值——调用方传写盘时用的同一个变量，禁另行推导。
 * @param {object} p
 * @param {string} p.from - 切换前子模式 id
 * @param {string} p.to - 目标子模式 id
 * @param {object|null} [p.sm] - 目标子模式对象（供 label/modeGroup 派生）
 * @param {string} [p.modeGroup] - 显式组（缺省从 sm 派生，再缺省 "code"）
 * @param {string} [p.chatId] - 真实落盘键
 * @param {string} [p.reason] - 切换来源（"delegate"/"flowGroup_start" 等，可选）
 * @param {string} [p.workflow] - 所属流程组名（可选）
 */
export function buildSubModeSwitchEvent({ from, to, sm = null, modeGroup = "", chatId = "", reason = "", workflow = "" }) {
  const ev = {
    from: from || "",
    to: to || "",
    label: sm?.label || to || "",
    modeGroup: modeGroup || sm?.modeGroup || "code",
    chatId: chatId || "",
  };
  if (reason) ev.reason = reason;
  if (workflow) ev.workflow = workflow;
  return ev;
}

/**
 * 从子模式对象抽取 maxContext（单一权威·消重）。
 * 键名/优先级与 getPromptHandler 子模式解析、main.mjs 生成层覆盖完全一致：
 *   model_params.max_context ?? model_params.maxContext ?? sub.maxContext ?? sub.max_context ?? 0
 * （带 model_params 副本时其内层为权威，无副本走旧扁平字段）。
 * @param {object} sm - 单个 sub_mode 对象
 * @returns {number} maxContext（>0 有效，0=未设）
 */
export function extractSubModeMaxContext(sm) {
  if (!sm || typeof sm !== "object") return 0;
  const _mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : null;
  let v;
  if (_mp) {
    v = _mp.max_context ?? _mp.maxContext ?? sm.maxContext ?? sm.max_context ?? 0;
  } else {
    v = sm.maxContext ?? sm.max_context ?? 0;
  }
  v = Number(v) || 0;
  return v > 0 ? v : 0;
}

/**
 * 当前活跃子模式的 maxContext 单一解析（A·根病1 单源化）。
 * getPromptHandler（带 mode/chatId 精确）与 GET runtime-params 端点（无 chat 上下文，best-effort）共用，
 * 消除「同一子模式 maxContext 解析逻辑两处各写」的二次根病。
 *
 * - modeGroup 给定（getPromptHandler 路径）：按组精确解析 active 子模式 + 跨组守卫
 *   （子模式 modeGroup 与请求 modeGroup 不符 → 不生效，对齐 getPromptHandler:227 / main.mjs 覆盖语义）。
 * - modeGroup 省略/null（端点路径，无法确知当前模式）：扫描 code/work 两组的全局 active 子模式，
 *   返回首个 maxContext>0 的值（best-effort 展示分母）。真生成层始终带 chatId 精确，不依赖此 best-effort。
 *
 * @param {string} username - 用户名（yonban_config.json 按用户存）
 * @param {string|null} [modeGroup] - "code"|"work"|...；省略=无模式上下文（端点）
 * @param {string|null} [chatId] - 对话线 id；省略=用全局 active_sub_mode 字段
 * @returns {number} 子模式 maxContext（>0 有效，0=无活跃子模式或未设）
 */
export function resolveSubModeMaxContext(username, modeGroup = null, chatId = null) {
  if (!username || /[\/\\]|\.\./.test(username)) return 0;
  try {
    const _cfgPath = getYonbanConfigPath(username);
    const _cfg = loadJsonFileIfExists(_cfgPath, { sub_modes: [], active_sub_mode: "前置任务专家" });
    const _subs = Array.isArray(_cfg.sub_modes) ? _cfg.sub_modes : [];
    if (_subs.length === 0) return 0;

    // 精确路径：modeGroup 已知 → 解析该组 active 子模式，跨组不生效
    if (modeGroup) {
      const _id = resolveActiveSubModeId(_cfg, modeGroup, chatId);
      if (!_id) return 0;
      const _sm = _subs.find(m => m.id === _id);
      if (!_sm) return 0;
      // 跨组守卫：子模式归属组 ≠ 请求组 → 该子模式覆盖不生效（对齐 getPromptHandler:227）
      if ((_sm.modeGroup || "code") !== modeGroup) return 0;
      return extractSubModeMaxContext(_sm);
    }

    // best-effort 路径（端点无模式上下文）：扫 code/work 两组全局 active 子模式，取首个有 maxContext 的
    for (const _g of ["code", "work"]) {
      const _id = resolveActiveSubModeId(_cfg, _g, chatId);
      if (!_id) continue;
      const _sm = _subs.find(m => m.id === _id && (m.modeGroup || "code") === _g);
      if (!_sm) continue;
      const _v = extractSubModeMaxContext(_sm);
      if (_v > 0) return _v;
    }
    return 0;
  } catch (_e) {
    diag.warn(`resolveSubModeMaxContext 解析失败: ${_e.message}`);
    return 0;
  }
}


/**
 * 子模式 ID 解析单一权威（A5）。
 * AI 在提示词里可能用 id（work-task-confirm）也可能用中文 label（任务确认师）指代子模式；
 * code 组与 work 组存在同名 label（如「任务确认师」），故解析必须带 modeGroup 边界。
 * @param {Array} subModes - yonban_config.sub_modes 全量子模式数组
 * @param {string} rawQuery - AI 输出的原始指代（id 或 label，可含中文/空格）
 * @param {string} [preferGroup] - 优先解析的 modeGroup（"work"|"code"|...）；subModeSwitch 传当前组限定边界
 * @param {boolean} [allowCrossGroup=false] - 是否允许跨组匹配（delegate 委派传 true，subModeSwitch 传 false）
 * @returns {object|null} 命中的子模式对象，未命中返回 null
 */
export function resolveSubMode(subModes, rawQuery, preferGroup, allowCrossGroup = false) {
  if (!Array.isArray(subModes) || !rawQuery) return null;
  const _norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
  const q = _norm(rawQuery);
  if (!q) return null;
  // 匹配谓词：id 或 label 命中（id 精确小写比对；label 去空白小写比对，支持中文 label）
  const _hit = (m) => _norm(m.id) === q || _norm(m.label) === q;
  // 容错兜底：精确全部未命中时，按 label/id 包含 query（短名→全名，如"设计师"⊂"前置设计师"，
  //   抗用户改子模式名后提示词里旧短名对不上）。只在精确失败时启用，且组内唯一命中才采纳——
  //   多义（如"专家"撞多个）不猜，回退 null，避免切错角色。
  const _fuzzyUnique = (pool) => {
    const cands = pool.filter((m) => _norm(m.label).includes(q) || _norm(m.id).includes(q));
    return cands.length === 1 ? cands[0] : null;
  };
  // 1. 优先在 preferGroup 内精确匹配（同名 label 撞名时锁定当前组，不串组）
  if (preferGroup) {
    const inGroup = subModes.filter((m) => (m.modeGroup || "code") === preferGroup);
    const exact = inGroup.find(_hit);
    if (exact) return exact;
  }
  // 2. allowCrossGroup（delegate）或无 preferGroup：全量精确匹配（preferGroup 命中优先于其它组）
  if (allowCrossGroup || !preferGroup) {
    const all = subModes.filter(_hit);
    if (all.length > 0) {
      if (preferGroup) {
        const pref = all.find((m) => (m.modeGroup || "code") === preferGroup);
        if (pref) return pref;
      }
      return all[0];
    }
  }
  // 3. 精确全部未命中 → 容错兜底。preferGroup 内优先（不串组），allowCrossGroup/无组才扩到全量。
  if (preferGroup) {
    const fz = _fuzzyUnique(subModes.filter((m) => (m.modeGroup || "code") === preferGroup));
    if (fz) return fz;
    if (!allowCrossGroup) return null; // preferGroup 限定不跨组
  }
  return _fuzzyUnique(subModes);
}

/**
 * 设置活跃模式并持久化
 * N38 per-chatId 隔离：传入 chatId 时只写该对话线的绑定（active_modes_map[chatId]），
 * 不再触碰 char 级 active_mode / _global / _default 三层默认——三层广播写正是
 * AI 一条 <modeSwitch> 污染同 char 全部窗口的根因（污染测试坐实）。
 * 不传 chatId（用户手动切换 / YonBan / 旧调用方）维持原 char 级+同步行为。
 * @param {string} username
 * @param {string} charName
 * @param {string} mode - "chat" | "code" | "work"
 * @param {string} [chatId] - 对话线 ID；有值=线级绑定
 * @returns {{ success: boolean, oldMode: string, newMode: string, error?: string }}
 */
export function setActiveMode(username, charName, mode, chatId = null) {
  wbT(chatId || null, "storage", "setActiveMode:enter", { username, charName, mode });
  // 防御：验证模式值（T5：内置集 _validModeIds+已注册自定义）
  if (!isValidModeId(mode)) {
    diag.error(`setActiveMode: 非法模式值 "${mode}"，拒绝切换`);
    return {
      success: false,
      oldMode: "unknown",
      newMode: mode,
      error: `非法模式值: ${mode}`,
    };
  }

  const memDir = ensureMemoryDir(username, charName);
  const configPath = path.join(memDir, "_config.json");
  const config = loadJsonFileIfExists(configPath, { enabled: true });

  if (chatId) {
    // 线级绑定：只动本对话线，零跨窗副作用
    if (!config.active_modes_map || typeof config.active_modes_map !== "object") {
      config.active_modes_map = {};
    }
    const prevBound = config.active_modes_map[chatId];
    const oldMode =
      isValidModeId(prevBound)
        ? prevBound
        : (config.active_mode || "chat");
    if (oldMode === mode && prevBound === mode) {
      diag.debug(`setActiveMode: 线 ${chatId} 模式未变 (${mode})，跳过`);
      return { success: true, oldMode, newMode: mode };
    }
    config.active_modes_map[chatId] = mode;
    saveJsonFile(configPath, config);
    _ensureModeArtifacts(username, charName, memDir, mode, oldMode);
    return { success: true, oldMode, newMode: mode };
  }

  const oldMode = config.active_mode || "chat";

  if (oldMode === mode) {
    diag.debug(`setActiveMode: 模式未变 (${mode})，跳过`);
    return { success: true, oldMode, newMode: mode };
  }

  config.active_mode = mode;
  saveJsonFile(configPath, config);

  // 同步写入 _global（确保 YonBan 等不传 charName 的客户端也能读到；getActiveMode:1826 兜底层同源）
  // 2026-07-09 收口审计：原第三层 _default/_global 写扩散已删——全根 grep 零运行时读点（getActiveMode
  //   fallback 链不含该层），纯写不读=分叉温床。_global 层保留但写失败必须可见，不再静默吞错。
  if (charName !== "_global") {
    try {
      const globalDir = ensureMemoryDir(username, "_global");
      const globalConfigPath = path.join(globalDir, "_config.json");
      const globalConfig = loadJsonFileIfExists(globalConfigPath, { enabled: true });
      globalConfig.active_mode = mode;
      saveJsonFile(globalConfigPath, globalConfig);
    } catch (e) {
      diag.warn(`setActiveMode: _global 层同步写失败（char 级已写成，无 charName 客户端将读到旧值）: ${e.message}`);
    }
  }

  _ensureModeArtifacts(username, charName, memDir, mode, oldMode);
  return { success: true, oldMode, newMode: mode };
}

/**
 * 模式切换共用尾段（char 级与线级两条写路径共用）：
 * 确保目标模式的表格/目录存在 + 清模式分键缓存。
 */
function _ensureModeArtifacts(username, charName, memDir, mode, oldMode) {
  // 如果切换到 code 模式，确保 code_tables.json 存在
  if (mode === "code") {
    const codeTablesPath = path.join(memDir, "code_tables.json");
    if (!fs.existsSync(codeTablesPath)) {
      saveJsonFile(codeTablesPath, {
        tables: structuredClone(getDefaultTables("code")), // T075：官方配置 default_tables.json 优先，骨架兜底
      });
      console.log(
        `[beilu-memory] 首次切换到编程模式，自动创建 code_tables.json (user=${username}, char=${charName})`,
      );
    }
    // 确保 code/ 目录结构存在
    ensureCodeMemoryDirs(username, charName);
  }

  // 如果切换到 work 模式，确保 work_tables.json 存在
  if (mode === "work") {
    const workTablesPath = path.join(memDir, "work_tables.json");
    if (!fs.existsSync(workTablesPath)) {
      saveJsonFile(workTablesPath, {
        tables: structuredClone(getDefaultTables("work")), // T075：官方配置 default_tables.json 优先，骨架兜底
      });
      console.log(
        `[beilu-memory] 首次切换到工作模式，自动创建 work_tables.json (user=${username}, char=${charName})`,
      );
    }
    // 确保 work/ 目录结构存在
    ensureWorkMemoryDirs(username, charName);
  }

  // 清该 char 全部模式/窗口的表格缓存（含 per-chatId 隔离键 #mode@chatId）——通用前缀清。
  //   旧版只删 #code/#work 裸键会漏带 chatId 的窗口缓存；用 `#` 边界防 char 名前缀撞（char1 vs char10）。
  const _ckPrefix = `${username}/${charName}`;
  let _clearedKeys = 0;
  for (const k of [...memoryCache.keys()]) {
    if (k === _ckPrefix || k.startsWith(`${_ckPrefix}#`)) {
      memoryCache.delete(k);
      _clearedKeys++;
    }
  }

  // ★ 自驱动P1缓存清除（模式切换时词表和倒排索引都可能不同）
  // 注意：setActiveMode是同步函数，用import().then异步清除（不阻塞模式切换）
  import("../nlp/vocab.mjs").then(m => m.clearVocabCache?.()).catch(() => {});

  console.log(
    `[beilu-memory] 模式切换: "${oldMode}" → "${mode}" (user=${username}, char=${charName}) | 清缓存键数=${_clearedKeys}`,
  );
}

/**
 * K5 每窗口临时 data 隔离（权威单点 seam）
 *
 * 凛倾 2026-06-10 拍板：「每一窗口一个的临时 data，一个窗口一个临时任务 md，然后经验、框架共享」
 * 隔离键 = chatId（窗口=对话=chatId）。仅 **work 任务态本体**（work_tables.json + work/active md）参与隔离；
 * chat/code 任务态、经验晋升(_global)、框架定义(sub_modes/workflows)、配置态(active_*)一律不经此=零变化。
 *
 * gate：仅当 env BEILU_GROUP_WORKER==="1" 且 mode==="work" 且 chatId 有值时，把任务态目录下沉到
 *       `<memDir>/work_ctx/<chatId>/`；否则原样返回 memDir（向后兼容，旧数据继续用旧路径）。
 *
 * @param {string} memDir 已解析的角色记忆根目录（getMemoryDir/ensureMemoryDir 结果）
 * @param {string} mode  "chat" | "code" | "work"
 * @param {string} [chatId]
 * @returns {string} work 任务态应使用的目录
 */
/**
 * 模式数据目录的单一权威（相对 memDir）—— 恒为角色卡级 memDir。
 *
 * 【20260726 凛倾定案】隔离只有两级：**用户级**（api/预设）与**角色卡级**（data/记忆/对话文件/世界书）。
 *   对话不是隔离维度——「对话窗口之间互通」「我们不是按照对话，我们有角色卡」。
 *   角色卡内 code/work/chat 是同一套记忆的分区（三份 tables.json + code/ work/ 目录 + 三温层），
 *   这本身已是模式分区，不需要也不允许再按 chatid 切一刀。
 * 【被删的东西】原 `<memDir>/<mode>_ctx/<chatId>/` 按对话文件切分（连同 isPerChatIdIsolated 开关）已退役：
 *   它把本该共享的经验表/框架索引/文档索引/画像/任务碎成每对话一份（实测：185 条经验碎在 8 个对话里，
 *   AI 换对话最多只看得到 82 条；画像碎成 5 份），且删对话会连带删掉那份记忆
 *   （chatStorage deleteChat 清理链），直接违背凛倾 06-10「经验、框架共享」。
 * 【为什么保留函数】8 处调用点（scopeResolver/worldbook/setDataActions×5/taskStore/本文件×2）继续调用本函数，
 *   路径解析仍单点收口在这里；签名保留 chatId 形参以免调用点散改，但不再参与路径。
 * @param {string} memDir
 * @param {string} mode "chat"|"code"|"work"（不再影响返回值，保留签名）
 * @param {string} [chatId] 已不参与路径解析（保留形参，防调用点散改）
 * @returns {string} 恒 memDir（角色卡级）
 */
export function getModeCtxDir(memDir, _mode, _chatId) {
  return memDir;
}

/**
 * 根据模式获取表格文件名
 * @param {string} mode - "chat" | "code" | "work"
 * @returns {string}
 */
export function getTablesFileName(mode) {
  return mode === "code"
    ? "code_tables.json"
    : mode === "work"
      ? "work_tables.json"
      : "tables.json";
}

/**
 * 模式私有空间的单一权威：该 mode 独占的【表文件名 + 私有子目录】。
 * 用于召回隔离（排除别模式私有内容）等需要"按模式划界"的地方，避免各处硬编码重复。
 * - chat：仅 tables.json，**无私有子目录**（归档落共享 hot/warm/cold）。
 * - code：code_tables.json + code/（active/archive/projects，ensureCodeMemoryDirs）+ code_ctx/（窗口任务态，getModeCtxDir）。
 * - work：work_tables.json + work/（active/archive/outputs/workflows，ensureWorkMemoryDirs）+ work_ctx/（窗口任务态，getModeCtxDir）。
 * @param {string} mode - "chat" | "code" | "work"
 * @returns {{ tableFile: string, dirs: string[] }}
 */
export function getModePrivatePaths(mode) {
  // 20260726：`<mode>_ctx` 已从 dirs 移除——按对话切分的维度整个退役（getModeCtxDir 恒角色卡级），
  //   目录不再存在也不再产生，留在这里会让「按模式划界」的消费方（召回隔离等）继续把它当私有目录。
  if (mode === "code") return { tableFile: "code_tables.json", dirs: ["code"] };
  if (mode === "work") return { tableFile: "work_tables.json", dirs: ["work"] };
  return { tableFile: "tables.json", dirs: [] };
}

/**
 * 根据模式获取缓存 key —— 角色卡 + 模式两级，不含对话维度。
 *
 * 【20260726 定案】原 `#mode@chatId` 窗口键随「按对话切分」维度一并退役
 *   （见 getModeCtxDir 注释：隔离只有用户级+角色卡级，对话不是维度）。
 *   缓存键必须与路径解析同源——路径已恒角色卡级，键再带 chatId 会让同一份盘上文件
 *   在多个缓存槽里各存一份副本，产生「读到别对话缓存的旧表」的串号（读写不同源）。
 * @param {string} username
 * @param {string} charName
 * @param {string} mode - "chat" | "code" | "work"
 * @param {string} [chatId] 已不参与键（保留形参，防调用点散改）
 * @returns {string}
 */
export function getCacheKey(username, charName, mode, _chatId) {
  // code/work 仍按模式分键（三份 tables.json 是不同文件）；chat = 裸键（读 tables.json）。
  if (mode === "code" || mode === "work") return `${username}/${charName}#${mode}`;
  return `${username}/${charName}`;
}

/**
 * 加载 tables.json 或 code_tables.json 到内存缓存（模式感知）
 *
 * 向后兼容：不传 forceMode 时，从 _config.json 读取 active_mode，
 * 默认为 "chat"，行为与原版完全一致。
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} [forceMode] - 强制指定模式，不传则从 config 读取
 * @param {string} [chatId] - K5：work 模式 + gate 开时，按窗口隔离任务态 tables
 * @returns {{ tables: object[], config: object, activeMode: string }}
 */
export function loadMemoryData(username, charName, forceMode, chatId) {
  const _tKey = `loadMemoryData:${username}:${charName}`;
  if (!_tracedOnce.has(_tKey)) { _tracedOnce.add(_tKey); wbT(chatId || null, "storage", "loadMemoryData:enter", { username, charName, forceMode }); }
  const memDir = ensureMemoryDir(username, charName);
  const configData = loadJsonFileIfExists(path.join(memDir, "_config.json"), {
    enabled: true,
  });

  // 确定当前模式：框架级 per-chatId —— 复用 getActiveMode（先 active_modes_map[chatId]，
  // 再全局 active_mode，再 _global 兜底 + 合法性校验）。修根因：原来直接读全局 config.active_mode，
  // 多窗口下 memData.activeMode 与 per-chatId 真实模式分叉，所有消费者（任务分区/缓存键/表格）一起读错。
  const activeMode = forceMode || getActiveMode(username, charName, chatId);

  // 防御：验证模式值
  const safeMode =
    activeMode === "code" || activeMode === "work" ? activeMode : "chat";
  if (activeMode !== safeMode) {
    diag.warn(
      `loadMemoryData: 模式值 "${activeMode}" 不合法，回退到 "${safeMode}"`,
    );
  }

  const cacheKey = getCacheKey(username, charName, safeMode, chatId);
  if (memoryCache.has(cacheKey)) {
    // 缓存命中：tables 保留缓存（不丢未落盘的内存改动），但 config 用本次已读的 fresh configData
    // 刷新——否则面板改归档开关/阈值（写 _config.json）在缓存进程内永不生效（只 setActiveMode 清缓存）。
    // configData 在上方无条件已读盘，此处复用 = 零新增 IO。
    const cached = memoryCache.get(cacheKey);
    cached.config = configData;
    return cached;
  }

  // 根据模式选择表格文件和默认模板
  // T075：默认模板来源收口到官方配置 default_tables.json（getDefaultTables 优先读，代码骨架兜底）
  const tablesFileName = getTablesFileName(safeMode);
  const defaultTables = structuredClone(getDefaultTables(safeMode));

  // 表文件目录：getModeCtxDir 恒返回角色卡级 memDir（20260726 按对话切分维度退役）。
  //   原此处还有一段「tablesDir !== memDir 时 mkdir <mode>_ctx/<chatId>/ + 从卡级复制存量份」——
  //   该条件现恒 false，且它正是"每开一个新对话就复制一份表"的源头（造出 12 份空模板副本），一并删除。
  const tablesDir = getModeCtxDir(memDir, safeMode, chatId);
  const tablesFilePath = path.join(tablesDir, tablesFileName);
  const tablesFileExists = fs.existsSync(tablesFilePath);
  let tablesData = tablesFileExists
    ? loadJsonFile(tablesFilePath)
    : { tables: defaultTables };

  // DL-2：主文件损坏（parse 失败返 null）时回读 .bak，避免静默回退默认模板丢用户自定义表
  if (tablesFileExists && (!tablesData || !tablesData.tables)) {
    wbD(chatId || null, "storage", "loadMemoryData:main_corrupt", false, "主表格文件损坏(parse 返 null)，尝试 .bak 恢复", { path: tablesFilePath, tablesFileName, username, charName });
    const _bakPath = tablesFilePath + ".bak";
    if (fs.existsSync(_bakPath)) {
      const _bakData = loadJsonFile(_bakPath);
      if (_bakData && _bakData.tables) {
        wbD(chatId || null, "storage", "loadMemoryData:bak_restored", false, "主文件损坏，已从 .bak 恢复", { path: tablesFilePath, username, charName });
        console.warn(
          `[beilu-memory] loadMemoryData: 主文件 ${tablesFileName} 损坏，已从 .bak 恢复 (user=${username}, char=${charName})`,
        );
        tablesData = _bakData;
      }
    }
    // .bak 也无效则回退默认模板（保持原回退语义，但不再因 null 抛异常）
    if (!tablesData || !tablesData.tables) {
      wbD(chatId || null, "storage", "loadMemoryData:fallback_default", false, "主文件与.bak 均不可用，回退默认模板（用户自定义表已丢失）", { path: tablesFilePath, tablesFileName, username, charName });
      tablesData = { tables: structuredClone(defaultTables) };
    }
  }

  // 问题E修复：老角色卡首次以 code 模式加载时，code_tables.json 不存在，自动写盘创建
  if (!tablesFileExists) {
    saveJsonFile(tablesFilePath, tablesData);
    console.log(
      `[beilu-memory] loadMemoryData: 自动创建 ${tablesFileName} (user=${username}, char=${charName}, mode=${safeMode})`,
    );
  }

  // 自动补全：检查默认模板中的表格是否都存在于用户数据中，缺失的自动追加
  if (tablesFileExists && tablesData.tables) {
    let _tablesPatched = false;
    const _existingIds = new Set(tablesData.tables.map(t => t.id));
    const _existingNames = new Set(tablesData.tables.map(t => t.name));
    for (const defTable of defaultTables) {
      if (!_existingIds.has(defTable.id) && !_existingNames.has(defTable.name)) {
        tablesData.tables.push(structuredClone(defTable));
        _tablesPatched = true;
        console.log(`[beilu-memory] 自动补全: ${tablesFileName} 追加表格 #${defTable.id} "${defTable.name}" (user=${username}, char=${charName})`);
      }
    }
    if (_tablesPatched) saveJsonFile(tablesFilePath, tablesData);
  }

  const data = {
    tables: tablesData.tables || [],
    config: configData,
    username,
    activeMode: safeMode,
  };

  // 诊断: 数据加载完整性检查
  diag.debug(
    `loadMemoryData: ${cacheKey} (mode=${safeMode}), ${data.tables.length} 表格, file=${tablesFileName}`,
  );
  for (let i = 0; i < data.tables.length; i++) {
    const t = data.tables[i];
    diag.guard(
      t,
      ["id", "name", "columns", "rows", "rules"],
      `loadMemoryData.table[${i}]`,
    );
    if (t.enabled === undefined) {
      diag.warn(
        `loadMemoryData: table[${i}](#${t.id}) 缺少 enabled 字段, 兼容补全为 true`,
      );
      t.enabled = true;
    }
  }
  const enabledCount = data.tables.filter((t) => t.enabled !== false).length;
  const disabledCount = data.tables.length - enabledCount;
  if (disabledCount > 0) {
    diag.debug(`loadMemoryData: ${enabledCount} 启用, ${disabledCount} 禁用`);
  }

  memoryCache.set(cacheKey, data);
  return data;
}

/**
 * 持久化表格数据到磁盘（带写入队列防并发竞态，模式感知）
 * @param {string} username
 * @param {string} charName
 * @param {string} [forceMode] - 强制指定模式，不传则从缓存数据推断
 * @param {string} [chatId] - K5：work 模式 + gate 开时，按窗口隔离任务态 tables
 */
export function saveTablesData(username, charName, forceMode, chatId) {
  wbT(chatId || null, "storage", "saveTablesData:enter", { username, charName, forceMode });
  // 模式契约：forceMode 由调用方传权威 mode（= loadMemoryData 返回的 data.activeMode，
  //   safeMode 保证恒为 chat/code/work 之一）。全 13 个实时调用方已覆盖（②收口完成）。
  //   ②前的"扫缓存猜模式"兜底已删——它会扫别模式缓存猜，可能猜成 work/code 写错表；
  //   而 mode 万一缺失时下游天然安全退化 chat（getCacheKey 裸键 + getTablesFileName→tables.json
  //   + 下方 if(!data) return 兜底），无需启发式猜测。
  const mode = forceMode;

  const cacheKey = getCacheKey(username, charName, mode, chatId);
  const data = memoryCache.get(cacheKey);
  if (!data) {
    diag.warn(`saveTablesData: 缓存中无数据 (key=${cacheKey}, mode=${mode})`);
    return;
  }

  const memDir = getMemoryDir(username, charName);
  const tablesFileName = getTablesFileName(mode);
  // K5 seam：work 任务态 tables 写盘同样下沉到 work_ctx/<chatId>/（与 loadMemoryData 对齐）
  const tablesDir = getModeCtxDir(memDir, mode, chatId);
  if (tablesDir !== memDir && !fs.existsSync(tablesDir)) {
    fs.mkdirSync(tablesDir, { recursive: true });
  }
  const tablesPath = path.join(tablesDir, tablesFileName);

  // ★ B18修复：使用写入队列防止并发竞态
  // 同路径写入串行排队（_saveTablesLocks 链）：N 次调用各写各自 data、按序逐次落盘，
  //   最终态=最后入队那次的数据（非合并/非去重，不是"只写一次"）
  const prev = _saveTablesLocks.get(tablesPath) ?? Promise.resolve();
  const next = prev.then(() => {
    try {
      // 备份
      const bakPath = tablesPath + ".bak";
      if (fs.existsSync(tablesPath)) {
        try {
          fs.copyFileSync(tablesPath, bakPath);
        } catch (e) {
          wbD(chatId || null, "storage", "saveTablesData:bak_copy_fail", false, "saveTablesData .bak 备份失败（损坏时无可恢复备份）", { path: tablesPath, bakPath, err: e.message });
          /* ignore */
        }
      }

      // 诊断: 保存前数据校验（含模式信息）
      diag.debug(
        `saveTablesData: ${cacheKey} (mode=${mode}, file=${tablesFileName}), ${data.tables.length} 表格`,
      );
      const totalRows = data.tables.reduce(
        (sum, t) => sum + (t.rows?.length || 0),
        0,
      );
      diag.snapshot("saveTablesData", {
        cacheKey,
        mode,
        tablesFileName,
        tableCount: data.tables.length,
        totalRows,
        enabledCount: data.tables.filter((t) => t.enabled !== false).length,
        tableSummary: data.tables.map(
          (t) =>
            `#${t.id}(${t.name}):${t.rows?.length || 0}r/${t.columns?.length || 0}c/${t.enabled !== false ? "on" : "off"}`,
        ),
      });

      saveJsonFile(tablesPath, { tables: data.tables });
      return { ok: true }; // 写盘成功标记,供 await 调用方(updateTable等)判断是否真落盘
    } catch (e) {
      wbD(chatId || null, "storage", "saveTablesData:write_fail", false, "saveTablesData 写盘失败(fire-and-forget，表格数据未落盘丢失)", { path: tablesPath, username, charName, mode, err: e.message });
      diag.error(`saveTablesData: 写入失败 ${tablesPath}:`, e.message);
      console.error(`[beilu-memory] saveTablesData 写入失败:`, e.message);
      return { ok: false, error: e.message }; // 上浮失败:await 调用方据此回 success:false 不再谎报(fire-and-forget 调用方忽略返回值,行为不变)
    }
  });
  _saveTablesLocks.set(
    tablesPath,
    next.catch(() => {}),
  );
  // D-02：返回写入 promise，使调用方/关停 drain 能 await 真正落盘（旧版返回 undefined → 写在微任务里
  // fire-and-forget，进程退出即丢未落盘表格）。现有调用方均 statement 调用、不读返回值，故非破坏。
  return next;
}

// D-02：关停 drain —— await 所有 pending 表格写入落盘后再返回（beilu-memory Unload 调用，防关停丢未落盘表格）
export async function drainTableWrites() {
  const pending = [..._saveTablesLocks.values()];
  if (pending.length) await Promise.allSettled(pending);
}

// ============================================================
// 记忆预设管理
// ============================================================

/**
 * 加载记忆预设（若文件不存在则初始化默认预设）
 * @param {string} username
 * @param {string} charName
 * @returns {object} { presets, injection_prompts }
 */
// ============================================================
// [0717 memory-preset isolation, store v2] One preset = one file (decision 2026-07-17:
//   "8 presets crammed into one file = no isolation"). Layout under
//   chars/_global/memory/_memory_presets/ :
//     <presetId>.json  = full single-preset object (P1..P8 / custom; ASCII-safe filename)
//     _injections.json = { injection_prompts: [...] } (INJ system split from presets)
//     _meta.json       = remaining top-level keys (active_preset_id etc.) + preset_order
//   All reads/writes go through _read/_writeMemoryPresetsStore only (called by
//   loadMemoryPresets/saveMemoryPresets). External shape is unchanged
//   ({presets, injection_prompts, ...topLevel}) => zero consumer changes.
//   Legacy single file _memory_presets.json auto-migrates to the directory on first read
//   and is renamed *.migrated.bak (reader trusts the directory only; if an external tool
//   recreates the legacy file we warn: it is a dead write nobody reads).
//   Factory template default_memory_presets.json stays a single file (factory seed,
//   not a runtime copy).
//   NOTE per user 2026-07-17: new code/comments/log strings in English; filenames must be
//   ASCII-safe (Chinese paths/filenames are known to break tooling).
// ============================================================
const MEMORY_PRESETS_DIR = "_memory_presets";
const MEMORY_PRESETS_LEGACY = "_memory_presets.json";

// Preset id -> ASCII-safe filename (custom ids may contain non-ASCII; encode, don't strip,
// so distinct ids never collide; "%" replaced to keep the name filesystem-friendly).
function _presetIdToFilename(id) {
  return encodeURIComponent(String(id)).replace(/%/g, "_") + ".json";
}

function _writeMemoryPresetsStore(memDir, data) {
  const dir = path.join(memDir, MEMORY_PRESETS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const { presets = [], injection_prompts = [], ...meta } = data || {};
  const _liveFiles = new Set(["_meta.json", "_injections.json"]);
  for (const p of presets) {
    if (!p || !p.id) continue;
    const _fid = _presetIdToFilename(p.id);
    _liveFiles.add(_fid);
    saveJsonFile(path.join(dir, _fid), p);
  }
  saveJsonFile(path.join(dir, "_injections.json"), { injection_prompts });
  saveJsonFile(path.join(dir, "_meta.json"), { ...meta, preset_order: presets.map((p) => p?.id).filter(Boolean) });
  // Delete-sync: removing a preset must remove its file, otherwise the ghost file
  // resurrects on next load (delete/restore must stay paired).
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".json") && !_liveFiles.has(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch (e) { console.warn(`[beilu-memory] memory-preset ghost-file cleanup failed (retried on next write): ${e.message}`); }
}

function _readMemoryPresetsStore(memDir) {
  const dir = path.join(memDir, MEMORY_PRESETS_DIR);
  const legacyPath = path.join(memDir, MEMORY_PRESETS_LEGACY);
  if (fs.existsSync(dir)) {
    // Dual-source alarm (diagnostics-first): legacy file recreated after migration is a
    // dead write nobody reads; must be visible, not silent.
    if (fs.existsSync(legacyPath)) console.warn(`[beilu-memory] memory-preset dual-source: ${legacyPath} was recreated after directory migration - runtime reads the directory store only; migrate whatever tool wrote the legacy file`);
    const meta = loadJsonFileIfExists(path.join(dir, "_meta.json"), {}) || {};
    const injWrap = loadJsonFileIfExists(path.join(dir, "_injections.json"), {}) || {};
    const presets = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || f === "_meta.json" || f === "_injections.json") continue;
        const p = loadJsonFileIfExists(path.join(dir, f), null);
        if (p && p.id) presets.push(p);
      }
    } catch (e) { console.warn(`[beilu-memory] memory-preset directory read failed: ${e.message}`); }
    const _order = Array.isArray(meta.preset_order) ? meta.preset_order : [];
    presets.sort((a, b) => {
      const ia = _order.indexOf(a.id), ib = _order.indexOf(b.id);
      return ((ia < 0 ? _order.length : ia) - (ib < 0 ? _order.length : ib)) || String(a.id).localeCompare(String(b.id));
    });
    const { preset_order: _po, ...restMeta } = meta;
    return { ...restMeta, presets, injection_prompts: injWrap.injection_prompts || [] };
  }
  // Legacy single file -> auto-migrate (rename to backup only after the directory write
  // succeeded; rename failure is warn-only because the directory takes priority anyway).
  const legacy = loadJsonFileIfExists(legacyPath, null);
  if (legacy && legacy.presets) {
    try {
      _writeMemoryPresetsStore(memDir, legacy);
      try { fs.renameSync(legacyPath, legacyPath + ".migrated.bak"); } catch (e) { console.warn(`[beilu-memory] legacy memory-preset file rename failed (harmless, directory wins): ${e.message}`); }
      console.log(`[beilu-memory] memory presets migrated to directory store: ${legacyPath} -> ${MEMORY_PRESETS_DIR}/ (${(legacy.presets || []).length} presets, one file each)`);
    } catch (e) {
      console.warn(`[beilu-memory] memory-preset directory migration failed (legacy file kept for this round, retried next load): ${e.message}`);
    }
    return legacy;
  }
  return null;
}

export function loadMemoryPresets(username, charName) {
  const _tKey = `loadMemoryPresets:${username}:${charName}`;
  if (!_tracedOnce.has(_tKey)) { _tracedOnce.add(_tKey); wbT(null, "storage", "loadMemoryPresets:enter", { username, charName }); }
  // 预设配置（P1-P8 + INJ）是全局的，始终从 _global 加载，不按角色分——charName 形参是历史残留死参
  //   （20260706 传导链核：与 saveMemoryPresets 双侧均强制 _global=写读同源，调用方传的 charName 不参与路径）
  const memDir = ensureMemoryDir(username, "_global");
  const data = _readMemoryPresetsStore(memDir); // [0717 目录化] 单文件读点收口进 store 读函数（含自动迁移）
  if (data && data.presets) {
    // 自动补全：检查是否缺少 P7 压缩AI预设
    const hasP7 = data.presets.some((p) => p.id === "P7");
    if (!hasP7) {
      // 从模板文件读取 P7，或从代码骨架获取
      let p7Template = null;
      try {
        const templatePath = path.join(
          __pluginDir,
          "default_memory_presets.json",
        );
        if (fs.existsSync(templatePath)) {
          const template = loadJsonFile(templatePath);
          if (template?.presets) {
            p7Template = template.presets.find((p) => p.id === "P7");
          }
        }
      } catch (e) {
        console.warn(`[beilu-memory] P7 模板读取失败: ${e.message}`);
      }
      if (!p7Template) {
        // 从代码骨架获取
        p7Template = DEFAULT_MEMORY_PRESETS.find((p) => p.id === "P7");
      }
      if (p7Template) {
        data.presets.push(structuredClone(p7Template));
        console.log("[beilu-memory] 自动补全: 追加缺失的 P7 编程AI预设");
        _writeMemoryPresetsStore(memDir, data); // [0717 store v2] write through directory store
      }
    }

    // 自动补全：检查是否缺少 P8 联网搜索AI预设
    const hasP8 = data.presets.some((p) => p.id === "P8");
    if (!hasP8) {
      let p8Template = null;
      try {
        const templatePath = path.join(
          __pluginDir,
          "default_memory_presets.json",
        );
        if (fs.existsSync(templatePath)) {
          const template = loadJsonFile(templatePath);
          if (template?.presets) {
            p8Template = template.presets.find((p) => p.id === "P8");
          }
        }
      } catch (e) {
        console.warn(`[beilu-memory] P8 模板读取失败: ${e.message}`);
      }
      if (!p8Template) {
        p8Template = DEFAULT_MEMORY_PRESETS.find((p) => p.id === "P8");
      }
      if (p8Template) {
        data.presets.push(structuredClone(p8Template));
        console.log("[beilu-memory] 自动补全: 追加缺失的 P8 联网搜索AI预设");
        _writeMemoryPresetsStore(memDir, data); // [0717 store v2] write through directory store
      }
    }

    // 自动补全：为已有预设补全 prompts_code / prompts_work 字段（模式提示词架构迁移）
    let promptsModeSynced = false;
    try {
      const templatePath2 = path.join(
        __pluginDir,
        "default_memory_presets.json",
      );
      if (fs.existsSync(templatePath2)) {
        const template2 = loadJsonFile(templatePath2);
        if (template2?.presets) {
          for (const templatePreset of template2.presets) {
            const userPreset = data.presets.find(
              (p) => p.id === templatePreset.id,
            );
            if (!userPreset) continue;
            // 同步 prompts_code
            if (templatePreset.prompts_code && !userPreset.prompts_code) {
              userPreset.prompts_code = structuredClone(
                templatePreset.prompts_code,
              );
              console.log(
                `[beilu-memory] 自动补全: ${userPreset.id} 添加了 prompts_code (${templatePreset.prompts_code.length} 条)`,
              );
              promptsModeSynced = true;
            }
            // 同步 prompts_work
            if (templatePreset.prompts_work && !userPreset.prompts_work) {
              userPreset.prompts_work = structuredClone(
                templatePreset.prompts_work,
              );
              console.log(
                `[beilu-memory] 自动补全: ${userPreset.id} 添加了 prompts_work (${templatePreset.prompts_work.length} 条)`,
              );
              promptsModeSynced = true;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[beilu-memory] prompts_code/work 同步检查失败: ${e.message}`);
    }
    if (promptsModeSynced) {
      _writeMemoryPresetsStore(memDir, data); // [0717 store v2] write through directory store
    }

    // 自动补全：检查 P1 是否缺少 P1_preset_list builtin 条目
    const p1 = data.presets.find((p) => p.id === "P1");
    if (p1 && p1.prompts) {
      const hasPresetList = p1.prompts.some(
        (p) => p.builtin && p.content === "{{presetList}}",
      );
      if (!hasPresetList) {
        // 在 {{chat_history}} 之前插入
        const chatHistoryIdx = p1.prompts.findIndex(
          (p) => p.builtin && p.content === "{{chat_history}}",
        );
        const newEntry = {
          role: "system",
          content: "{{presetList}}",
          identifier: "P1_preset_list",
          enabled: true,
          builtin: true,
          deletable: false,
        };
        if (chatHistoryIdx >= 0) {
          p1.prompts.splice(chatHistoryIdx, 0, newEntry);
        } else {
          p1.prompts.push(newEntry);
        }
        console.log(
          "[beilu-memory] 自动补全: P1 添加了 P1_preset_list builtin 条目",
        );
        _writeMemoryPresetsStore(memDir, data); // [0717 store v2] write through directory store
      }
    }
    // 自动补全：旧 INJ-1 迁移 → INJ-1-chat/code/work
    let injMigrated = false;
    if (!data.injection_prompts) data.injection_prompts = [];
    const oldInj1Idx = data.injection_prompts.findIndex(
      (p) => p.id === "INJ-1",
    );
    if (oldInj1Idx >= 0) {
      const oldInj1 = data.injection_prompts[oldInj1Idx];
      // 将旧 INJ-1 的 content 迁移到 INJ-1-chat
      const hasChat = data.injection_prompts.some((p) => p.id === "INJ-1-chat");
      if (!hasChat) {
        data.injection_prompts.push({
          id: "INJ-1-chat",
          name: "聊天表格说明",
          description: "向聊天AI注入聊天模式的表格数据和操作规则",
          enabled: oldInj1.enabled,
          builtin: true,
          deletable: false,
          role: "system",
          depth: oldInj1.depth ?? 999, // ?? 防 || 吞掉显式 depth=0（对齐 H1：旧 INJ-1 设过下方 depth=0 不该被迁成 999 上方）
          order: 100,
          autoMode: "chat",
          content: oldInj1.content || "",
        });
        console.log("[beilu-memory] INJ迁移: 旧 INJ-1 content → INJ-1-chat");
      }
      // 删除旧 INJ-1
      data.injection_prompts.splice(oldInj1Idx, 1);
      console.log("[beilu-memory] INJ迁移: 删除旧 INJ-1");
      injMigrated = true;
    }

    // 不做任何 INJ 自动补全/自动恢复（凛倾 2026-06-15 定调）。内置条目仅在「首次初始化」
    // 播种一次；之后用户删了就是删了，唯一找回途径 = 前端「恢复默认」(restoreDefaultInjections)。
    // [0722 硬编码注入收口] 数据类 INJ 条目（*-data, dataDriven:true）一次性播种：
    //   与 0615 定调不冲突——这批条目是「从未存在过」的新增 builtin（承接原 getPromptHandler 硬编码
    //   注入的模板），存量用户副本没有它们=功能静默丢失（p1_act/委派/检索结果不再注入），必须补种一次。
    //   marker 文件防重（同 INJ-1 迁移的一次性范式）；播种后用户删除=删了，找回走前端「恢复默认」。
    try {
      const _seedMarker = path.join(memDir, "_inj_data_seed_v1.done");
      if (!fs.existsSync(_seedMarker)) {
        const _seedTplPath = path.join(__pluginDir, "default_memory_presets.json");
        const _seedTpl = fs.existsSync(_seedTplPath) ? loadJsonFile(_seedTplPath) : null;
        // 播种域 = dataDriven 数据条目 + 一切 *-data 尾部动态条目（0722 动态宏归尾拆出的 submodes 等）
        // 播种域判据单源=injectionSystem.isDataEntry（0722 J1-B 收口，原内联双判据副本）
        const _tplDataInj = (_seedTpl?.injection_prompts || []).filter((p) => isDataEntry(p));
        let _seeded = 0;
        for (const _te of _tplDataInj) {
          if (!data.injection_prompts.some((p) => p.id === _te.id)) {
            data.injection_prompts.push(structuredClone(_te));
            _seeded++;
          }
        }
        fs.writeFileSync(_seedMarker, new Date().toISOString());
        if (_seeded > 0) {
          console.log(`[beilu-memory] 0722 数据类INJ播种: 新增 ${_seeded} 条 (*-data)`);
          _writeMemoryPresetsStore(memDir, data);
        }
      }
    } catch (_seedErr) { console.warn("[beilu-memory] 数据类INJ播种失败:", _seedErr.message); }
    if (injMigrated) {
      _writeMemoryPresetsStore(memDir, data); // [0717 store v2] write through directory store
    }
    return data;
  }

  // 首次初始化：三级加载优先级
  // 1. 用户已有 _memory_presets.json → 上面已 return
  // 2. 模板文件 default_memory_presets.json → 优先使用
  // 3. 代码骨架 DEFAULT_MEMORY_PRESETS / DEFAULT_INJECTION_PROMPTS → 最终兜底
  let defaults;
  const templatePath = path.join(__pluginDir, "default_memory_presets.json");
  try {
    if (fs.existsSync(templatePath)) {
      const template = loadJsonFile(templatePath);
      if (template && template.presets) {
        defaults = {
          presets: structuredClone(template.presets),
          injection_prompts: structuredClone(
            template.injection_prompts || DEFAULT_INJECTION_PROMPTS,
          ),
        };
        console.log(`[beilu-memory] 从模板文件初始化预设: ${templatePath}`);
      }
    }
  } catch (e) {
    console.warn(
      `[beilu-memory] 读取模板文件失败，使用代码骨架兜底: ${e.message}`,
    );
  }

  if (!defaults) {
    defaults = {
      presets: structuredClone(DEFAULT_MEMORY_PRESETS),
      injection_prompts: structuredClone(DEFAULT_INJECTION_PROMPTS),
    };
    console.log(
      "[beilu-memory] 模板文件不存在，使用代码骨架初始化预设（空提示词）",
    );
  }

  _writeMemoryPresetsStore(memDir, defaults); // [0717 store v2] first-init seed goes to directory store
  return defaults;
}

/**
 * 保存记忆预设到磁盘（presets + injection_prompts 一起保存）
 * @param {string} username
 * @param {string} charName
 * @param {object} presetsData - { presets, injection_prompts }
 */
export function saveMemoryPresets(username, charName, presetsData) {
  wbT(null, "storage", "saveMemoryPresets:enter", { username, charName });
  // 预设配置（P1-P8 + INJ）是全局的，始终保存到 _global，不按角色分——charName 形参是历史残留死参（同 loadMemoryPresets）
  const memDir = ensureMemoryDir(username, "_global");
  _writeMemoryPresetsStore(memDir, presetsData); // [0717 store v2] one preset = one file; delete-sync included
}

/**
 * 路径安全检查：确保路径在记忆目录内且不含 .. 越界
 * @param {string} fullPath - 完整路径
 * @param {string} resolvedMemDir - path.resolve 后的记忆目录
 * @returns {boolean}
 */
export function isPathSafe(fullPath, resolvedMemDir) {
  const resolved = path.resolve(fullPath);
  const base = resolvedMemDir.endsWith(path.sep) ? resolvedMemDir : resolvedMemDir + path.sep;
  return (resolved === resolvedMemDir || resolved.startsWith(base)) && !fullPath.includes("..");
}

// readSkillBody 已删（凛倾 0723「说明书库可以删除,和inj重复」）：{{skill:}} 宏转退役替空串，
//   正线/预览两消费方同批清零；用户数据 memory/skills/*.md 留盘不动。

// ============================================================
// 压缩摘要 I/O（Step 6: P7 压缩 AI 写入，前端展示区读取）
// ============================================================

/**
 * 读取压缩摘要。
 * O17 per-chatId 隔离：有 chatId 时优先读 hot/chat_ctx/<safeChatId>/context_summary.json，
 * 文件不存在则 fallback 到旧路径 hot/context_summary.json（兼容旧数据 / 首次迁移前）。
 * 无 chatId 时走旧路径，行为同旧（零回归）。
 * @param {string} username
 * @param {string} charName
 * @param {string|null} [chatId=null]
 * @returns {object|null} 摘要对象，或 null（文件不存在）
 */
export function readContextSummary(username, charName, chatId = null) {
  const memDir = ensureMemoryDir(username, charName);
  if (chatId) {
    const safeChatId = String(chatId).replace(/[\\/]|\.\./g, "_");
    const perChatPath = path.join(memDir, "hot", "chat_ctx", safeChatId, "context_summary.json");
    const perChatData = loadJsonFileIfExists(perChatPath, null);
    if (perChatData !== null) return perChatData;
    // fallback：旧全局路径（兼容未迁移数据）
  }
  return loadJsonFileIfExists(
    path.join(memDir, "hot", "context_summary.json"),
    null,
  );
}

/**
 * 写入压缩摘要。
 * O17 per-chatId 隔离：有 chatId 时写 hot/chat_ctx/<safeChatId>/context_summary.json（mkdir 由 saveJsonFile 自动处理）。
 * 无 chatId 时写旧路径，行为同旧（零回归）。
 * @param {string} username
 * @param {string} charName
 * @param {object} data - 摘要数据
 * @param {string|null} [chatId=null]
 */
export function writeContextSummary(username, charName, data, chatId = null) {
  const memDir = ensureMemoryDir(username, charName);
  if (chatId) {
    const safeChatId = String(chatId).replace(/[\\/]|\.\./g, "_");
    saveJsonFile(path.join(memDir, "hot", "chat_ctx", safeChatId, "context_summary.json"), data);
  } else {
    saveJsonFile(path.join(memDir, "hot", "context_summary.json"), data);
  }
}

// ============================================================
// 编程记忆目录与配置
// ============================================================

/**
 * 确保编程记忆目录结构存在
 * 在首次切换到 code 模式时调用
 * （T7 尾段收口：签名 memoryDir→(username,charName)，config 路径引权威 getCodeConfigPath；唯一调用方=_ensureModeArtifacts）
 * @param {string} username
 * @param {string} charName
 */
export function ensureCodeMemoryDirs(username, charName) {
  const memoryDir = getMemoryDir(username, charName);
  const codeDirs = [
    path.join(memoryDir, "code"),
    path.join(memoryDir, "code", "active"),
    path.join(memoryDir, "code", "archive"),
    path.join(memoryDir, "code", "projects"),
  ];
  for (const dir of codeDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // 初始化 _code_config.json（如果不存在）
  const configPath = getCodeConfigPath(username, charName);
  if (!fs.existsSync(configPath)) {
    saveJsonFile(configPath, {
      active_project: "",
      token_threshold_percent: 80,
      auto_snapshot: true,
      snapshot_max_count: 10,
      created_at: new Date().toISOString(),
      last_archive_at: null,
    });
    console.log(
      `[beilu-memory] ensureCodeMemoryDirs: 已创建 _code_config.json`,
    );
  }

  // 初始化 _index.md（如果不存在）
  const indexPath = path.join(memoryDir, "code", "active", "_index.md");
  if (!fs.existsSync(indexPath)) {
    nicerWriteFileSync(
      indexPath,
      "# 编程记忆热层索引\n\n> 此文件由AI自动维护，列出当前活跃的工作文件。\n\n当前无活跃文件。\n",
      "utf-8",
    );
    console.log(`[beilu-memory] ensureCodeMemoryDirs: 已创建 active/_index.md`);
  }

  console.log(
    `[beilu-memory] ensureCodeMemoryDirs: 编程记忆目录已确认 (${memoryDir}/code/)`,
  );
}

/**
 * 确保工作记忆目录结构存在
 * 在首次切换到 work 模式时调用
 * （T7 尾段收口：签名 memoryDir→(username,charName)，config 路径引权威 getWorkConfigPath；唯一调用方=_ensureModeArtifacts）
 * @param {string} username
 * @param {string} charName
 */
export function ensureWorkMemoryDirs(username, charName) {
  const memoryDir = getMemoryDir(username, charName);
  const workDirs = [
    path.join(memoryDir, "work"),
    path.join(memoryDir, "work", "active"),
    path.join(memoryDir, "work", "archive"),
    path.join(memoryDir, "work", "outputs"),
    path.join(memoryDir, "work", "workflows"),
  ];
  for (const dir of workDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // 初始化 _work_config.json（如果不存在）
  const configPath = getWorkConfigPath(username, charName);
  if (!fs.existsSync(configPath)) {
    saveJsonFile(configPath, {
      active_workflow: "",
      auto_switch: true,
      created_at: new Date().toISOString(),
      last_archive_at: null,
    });
    console.log(
      `[beilu-memory] ensureWorkMemoryDirs: 已创建 _work_config.json`,
    );
  }

  // 初始化 _index.md（如果不存在）
  const indexPath = path.join(memoryDir, "work", "active", "_index.md");
  if (!fs.existsSync(indexPath)) {
    nicerWriteFileSync(
      indexPath,
      "# 工作记忆热层索引\n\n> 此文件由AI自动维护，列出当前活跃的工作任务。\n\n当前无活跃任务。\n",
      "utf-8",
    );
    console.log(`[beilu-memory] ensureWorkMemoryDirs: 已创建 active/_index.md`);
  }

  console.log(
    `[beilu-memory] ensureWorkMemoryDirs: 工作记忆目录已确认 (${memoryDir}/work/)`,
  );
}

/**
 * 读取编程记忆配置（T7 尾段收口：签名 memoryDir→(username,charName)，路径引权威 getCodeConfigPath；调用方=rollback/snapshot ×2）
 * @param {string} username
 * @param {string} charName
 * @returns {object|null} 配置对象，目录不存在时返回 null
 */
export function loadCodeConfig(username, charName) {
  return loadJsonFileIfExists(getCodeConfigPath(username, charName), null);
}

/**
 * 保存编程记忆配置（T7 尾段收口：同上签名与路径权威化）
 * @param {string} username
 * @param {string} charName
 * @param {object} config - 配置对象
 */
export function saveCodeConfig(username, charName, config) {
  const configPath = getCodeConfigPath(username, charName);
  const codeDir = path.dirname(configPath);
  if (!fs.existsSync(codeDir)) {
    fs.mkdirSync(codeDir, { recursive: true });
  }
  saveJsonFile(configPath, config);
}

/**
 * 列出 code/active/ 目录下的md文件
 * @param {string} memoryDir - memory/{char_name}/ 的绝对路径
 * @returns {string[]} md文件名数组
 */
export function listCodeActiveFiles(memoryDir) {
  const activeDir = path.join(memoryDir, "code", "active");
  if (!fs.existsSync(activeDir)) return [];
  try {
    return fs.readdirSync(activeDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

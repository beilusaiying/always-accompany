/**
 * presetBridge.mjs — beilu-preset 读写桥接（单一访问层，隔离目录化格式细节）。
 *
 * 【功能链】
 *   提供 beilu-memory 访问 beilu-preset 插件的全部读写接口：
 *   读取/写入当前激活预设名（支持 per-chatId 多窗口隔离）、
 *   读取预设注册表（registry.json）、检查/列出/加载/创建预设，
 *   以及读取预设完整内容（含 mode_triggers，供 P1 AI 的 {{presetList}} 宏）。
 *
 * 【why】
 *   BUG-8：beilu-preset 已迁移到目录化格式（registry.json + presets/ + config.json），
 *   旧 config_data.json 废弃。beilu-memory 有 5 个调用点（getPromptHandler / replyHandler /
 *   setDataActions / getDataHandler / aiRunner）都需要读写预设，若各自直接读文件会重复且易
 *   格式不一致。此模块作为单一抽象层，让调用方不感知目录结构细节，格式迁移时只改此一处。
 *   per-chatId 隔离（active_preset_map[chatId]）保证多窗口各自激活不同预设互不污染。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块（纯后端库）。
 *   间接路径：
 *     1. 前端 GetData → getDataHandler → listPresets() → 前端渲染预设下拉列表
 *     2. 前端 SetData("switchPreset") → setDataActions → switchPresetViaAPI() → beilu-preset SetData
 *     3. getPromptHandler S6 预设隔离 → switchPresetViaAPI() / getActivePresetName()
 *     4. replyHandler <presetSwitch> 标签 → createPreset() / switchPresetViaAPI()
 *
 * 【关联链】
 *   ← getPromptHandler.mjs（getActivePresetName / hasPreset / switchPresetViaAPI）
 *   ← replyHandler.mjs（hasPreset / createPreset / getRegistry）
 *   ← setDataActions.mjs（hasPreset / createPreset / applySubModePresetDefault 等）
 *   ← getDataHandler.mjs（listPresets）
 *   ← aiRunner.mjs（getActivePresetName / listPresetsForP1）
 *   → storage.mjs（loadJsonFileIfExists / saveJsonFile / __pluginDir — 路径基准）
 *   读写路径：beilu-preset/config.json（激活预设名）、beilu-preset/registry.json（预设列表）、
 *              beilu-preset/presets/{name}.json（预设内容）
 *
 * 【影响范围】
 *   - 读：config.json / registry.json / presets/*.json（幂等，无副作用）
 *   - 写：config.json（主路径经 switchPresetViaAPI → switch_preset 权威收口；setActivePresetName 仅降级应急直写,盘+内存双写）
 *   - 写：presets/{name}.json + registry.json（createPreset — 新建预设时）
 *   - 不广播 WS，不写记忆目录（memory/ 下的文件）
 *
 * 【使用效果】
 *   多窗口各自维护激活预设（per-chatId map），互不干扰；
 *   预设切换只改 config.json 单点，所有读取方下次调用 getActivePresetName() 即得新值。
 *
 * 导出函数：
 *   getActivePresetName / setActivePresetName / getRegistry / hasPreset /
 *   listPresets / listPresetsForP1 / loadPreset / createPreset / switchPresetViaAPI
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJsonFileIfExists, saveJsonFile, __pluginDir, getUserDataDir, withFileLock } from "../storage_mod/storage.mjs";

// [T065 per-user] 预设内容池已从全局单份迁到 data/users/<user>/presets/（对齐 beilu-preset/main.mjs）。
//   本桥的全部读写按 username 定位到该用户目录；username 缺省 → "_default" 桶（匿名/无上下文回退，
//   与 beilu-preset 引擎 _normUser 同语义）。旧全局 beilu-preset/ 目录不再运行时读回退（禁旧路径回退，T065 规划四）。
//   beilu-preset 实现体（main.mjs）仍在旧位（import.meta 锚回旧位），故 switchPresetViaAPI 的 main.mjs URL 不变。
const BEILU_PRESET_PLUGIN_DIR = path.resolve(__pluginDir, "..", "beilu-preset");

function _normUser(username) {
  return (typeof username === "string" && username) ? username : "_default";
}
function _userPresetDir(username) {
  return path.join(getUserDataDir(_normUser(username)), "presets");
}
function _configPath(username) {
  return path.join(_userPresetDir(username), "config.json");
}
function _registryPath(username) {
  return path.join(_userPresetDir(username), "registry.json");
}

/**
 * 获取某用户当前激活预设名。
 * per-chatId 隔离：传 chatId 时优先读 active_preset_map[chatId]，回退该用户 active_preset。
 * @param {string} username - [T065] 预设内容池已 per-user，定位到 data/users/<user>/presets/config.json
 * @param {string} [chatId] - 窗口/对话 ID；不传则只读该用户全局激活
 */
export function getActivePresetName(username, chatId, mode) {
  const cfg = loadJsonFileIfExists(_configPath(username), {});
  // R1（2026-07-08）：补精确键 [cid:mode] 优先——与读侧权威 resolveActivePresetName（preset/main.mjs:933-934）
  //   同序（精确键 > 裸键 > 全局）。原只读裸键：强切写精确键后本函数读旧裸键 → 隔离判断永远失准。
  if (chatId && mode && cfg.active_preset_map && cfg.active_preset_map[chatId + ":" + mode]) {
    return cfg.active_preset_map[chatId + ":" + mode];
  }
  if (chatId && cfg.active_preset_map && cfg.active_preset_map[chatId]) {
    return cfg.active_preset_map[chatId];
  }
  // [0725 凛倾「没有全局,马上删除」] 原 `cfg.active_preset` 全局回退摘除——active_preset 字段已
  //   全面退役(preset/main.mjs 解析链同批摘除,停写)。本函数与收口点 resolveActivePresetWithSource
  //   同语义:线级记录之外没有回退值,无记录=""(消费方 aiRunner/getPromptHandler 空值分支已有)。
  //   code/work 的子模式回退发生在收口点(生成主链走 resolveActivePresetName),本降级桥不复制该逻辑。
  return "";
}

/**
 * 写某用户激活预设名（【降级应急路径】：唯一运行时调用=applySubModePresetDefault，
 * 仅 switchPresetViaAPI 失败（SetData 通道异常）时走）。
 * per-chatId：传 chatId 时只写 active_preset_map（有 mode 精确键 [cid:mode]，无 mode 裸键）；
 * 不传 chatId（无窗口上下文）时才写该用户 active_preset。
 * [五类病灶审计 2026-07-12 F1 重修] 原病：独立读盘-改-写盘不回灌主模块内存 configData，
 *   主模块下次 saveConfigToDisk（内存态整替换 map）会把本写入静默回滚。读侧
 *   resolveActivePresetName 经 _loadGlobalCfgFresh 按 mtime 读盘=本写入在回滚前真实生效，
 *   故不能删（删=行为退化），治法=对齐同域既有范式 removeChatPresetMapping（preset main.mjs:139-147）：
 *   盘 + 主模块内存态双写 + 失效 globalCfgCache，写入不再被回滚。
 *   已知半态（如实声明）：本路径不做正则 resync/不广播——触发场景=SetData 通道本身异常，
 *   这两个联动在该场景不可达；失败原因由 switchPresetViaAPI 内 warn 留痕。
 * @param {string} username
 * @param {string} name - 预设名
 * @param {string} [chatId] - 窗口/对话 ID
 */
export async function setActivePresetName(username, name, chatId, mode) {
  const p = _configPath(username);
  const _writeTo = (obj) => {
    if (chatId) {
      if (!obj.active_preset_map) obj.active_preset_map = {};
      // 有 mode 只写精确键，裸键仅无 mode 退化写（对齐 switch_preset 收口 2026-07-11）：
      // 裸键=跨模式共享槽，双写会让任一模式的切换污染同 cid 全部模式的回退值。
      if (mode) obj.active_preset_map[chatId + ":" + mode] = name;
      else obj.active_preset_map[chatId] = name;
    } else {
      // [0725 凛倾「没有全局」] 无 chatId 写 active_preset 摘除(字段退役)——降级桥只服务线级写
      console.warn(`[presetBridge] setActivePresetName("${name}") 无 chatId,全局写已废除(没有全局),跳过`);
    }
  };
  // [缺口⑦ 2026-07-16] 盘段 load→mutate→save 进 withFileLock（键=config.json，与主模块 saveConfigToDisk/
  //   removeChatPresetMapping 同键同队），多写路并发不再 lost-update。目录创建、原子写、内存同写不变。
  await withFileLock(p, () => {
    const cfg = loadJsonFileIfExists(p, {});
    _writeTo(cfg);
    if (!fs.existsSync(_userPresetDir(username))) fs.mkdirSync(_userPresetDir(username), { recursive: true });
    saveJsonFile(p, cfg);
  });
  // 内存态同写+失效缓存（防主模块 saveConfigToDisk 整态覆盖回滚）——仅当主模块 store 已实例化
  try {
    const mainUrl = pathToFileURL(path.join(BEILU_PRESET_PLUGIN_DIR, "main.mjs")).href;
    const mod = await import(mainUrl);
    const st = (mod?._existingStore || mod?.default?._existingStore)?.(username);
    if (st?.configData) {
      _writeTo(st.configData);
      st.globalCfgCache = { mtime: 0, data: null };
    }
  } catch (e) { console.warn(`[presetBridge] setActivePresetName 内存态同写失败（盘写已成；主模块 saveConfigToDisk 已不覆盖 map——0724 激活态漏斗收口后无回滚风险，仅主模块内存镜像暂旧，下次漏斗写会镜像盘归位）:`, e?.message || e); }
}

/** 获取某用户预设注册表 { [name]: { file, source, description, tags, ... } } */
export function getRegistry(username) {
  return loadJsonFileIfExists(_registryPath(username), { presets: {} }).presets || {};
}

/** 检查某用户是否存在该预设 */
export function hasPreset(username, name) {
  return name in getRegistry(username);
}

/** 获取某用户预设列表 [{ name, description, active }] */
export function listPresets(username) {
  const reg = getRegistry(username);
  const active = getActivePresetName(username);
  return Object.entries(reg).map(([name, meta]) => ({
    name,
    description: meta.description || "",
    active: name === active,
  }));
}

/**
 * 获取某用户预设列表（含 mode/mode_triggers，读取预设文件）
 * 用于 P1 AI 的 {{presetList}} 宏
 * @param {string} username
 */
export function listPresetsForP1(username) {
  const reg = getRegistry(username);
  const active = getActivePresetName(username);
  const result = [];
  for (const [name, meta] of Object.entries(reg)) {
    const entry = {
      name,
      description: meta.description || "",
      active: name === active,
      mode: "",
      mode_triggers: [],
    };
    if (meta.file) {
      try {
        const data = loadJsonFileIfExists(
          path.join(_userPresetDir(username), meta.file),
          {},
        );
        entry.mode = data.mode || data._meta?.mode || "";
        entry.mode_triggers =
          data.mode_triggers || data._meta?.mode_triggers || [];
      } catch {
        /* skip unreadable preset files */
      }
    }
    result.push(entry);
  }
  return result;
}

// 预设名 → 安全文件名: 替换非法路径字符与空白, 截断 100 字防文件名过长
function _sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

/**
 * 为某用户创建新预设（直写文件 + 更新其 registry）
 * @param {string} username
 * @returns {boolean} true=创建成功, false=已存在
 */
export function createPreset(username, name, presetJson, description = "") {
  if (hasPreset(username, name)) return false;

  const fileName = _sanitize(name) + ".json";
  const presetsDir = _userPresetDir(username);
  if (!fs.existsSync(presetsDir))
    fs.mkdirSync(presetsDir, { recursive: true });

  saveJsonFile(path.join(presetsDir, fileName), {
    _meta: { name, version: 1, source: "beilu-memory", description },
    preset_json: presetJson || {},
    model_params: {},
    macro_variables: {},
  });

  const regPath = _registryPath(username);
  const reg = loadJsonFileIfExists(regPath, { presets: {} });
  if (!reg.presets) reg.presets = {};
  reg.presets[name] = {
    file: fileName,
    source: "beilu-memory",
    description,
    tags: [],
    created_at: new Date().toISOString(),
    modified_at: new Date().toISOString(),
  };
  saveJsonFile(regPath, reg);
  return true;
}

/**
 * 通过 beilu-preset SetData API 切换预设。
 * 修：SetData 挂在 interfaces.config 下（原 interfaces.chat 永远 undefined → 恒返 false，
 * 调用方只能降级 setActivePresetName 写盘、引擎从不感知 = 绑定切换半残）。
 * per-chatId：传 chatId 时 beilu-preset 只写 active_preset_map[chatId]，不动全局引擎/其他窗口。
 * @param {string} name - 预设名
 * @param {object} [arg] - chatReplyRequest_t（透传 username 等）
 * @param {string} [chatId] - 窗口/对话 ID
 * @param {string} [mode] - 当前权威模式（R1：调用方=getPromptHandler 已解析的 _activeMode）
 * @returns {Promise<boolean>} true=切换成功
 */
export async function switchPresetViaAPI(name, arg, chatId, mode) {
  try {
    // beilu-preset 实现体 main.mjs 仍在插件旧位（import.meta 锚回旧位）；SetData 内部按 arg.username 分桶写该用户目录
    const mainUrl = pathToFileURL(
      path.join(BEILU_PRESET_PLUGIN_DIR, "main.mjs"),
    ).href;
    const mod = await import(mainUrl);
    const exp = mod?.default || mod;
    const setData = exp?.interfaces?.config?.SetData || exp?.interfaces?.chat?.SetData;
    if (setData) {
      // R1（2026-07-08 断链审计病根二④）：补传 mode+charName——原不传 mode 使隔离强切只写裸键
      //   active_preset_map[cid]，与手动切换的精确键 [cid:mode] 错位（读侧精确键优先，裸键被强切持续占领）。
      //   mode=调用方生成链已解析的权威 _activeMode；charName 供 switch_preset 缺省 mode 时自解析兜底。
      await setData(
        { switch_preset: { name, ...(chatId ? { chatid: chatId } : {}), ...(mode ? { mode } : {}), ...(arg?.char_id ? { charName: arg.char_id } : {}) } },
        arg,
      );
      return true;
    }
  } catch (e) {
    // 留痕不吞（2026-07-12 F1）：此处失败=降级触发的唯一原因,静默会让"预设没跟着子模式切"不可诊断
    console.warn(`[presetBridge] switchPresetViaAPI 失败 (preset="${name}"):`, e?.message || e);
  }
  return false;
}

/**
 * 清除某对话线的预设覆盖（回退全局 active_preset；[0716] 绑定回退已随概念删除）。
 * switchPresetViaAPI 的 clear 兄弟口（凛倾 07-09 bot 技能式预设 `!skill clear`），
 * 同一 SetData switch_preset 权威通道（beilu-preset main.mjs clear 分支）。
 * @param {object} [arg] - 透传 username 等。
 * @param {string} chatId - 对话线 ID（必填，clear 只有线级语义）。
 * @param {string} [mode] - 权威模式。
 * @returns {Promise<boolean>}
 */
export async function clearPresetOverrideViaAPI(arg, chatId, mode) {
  if (!chatId) return false;
  try {
    const mainUrl = pathToFileURL(
      path.join(BEILU_PRESET_PLUGIN_DIR, "main.mjs"),
    ).href;
    const mod = await import(mainUrl);
    const exp = mod?.default || mod;
    const setData = exp?.interfaces?.config?.SetData || exp?.interfaces?.chat?.SetData;
    if (setData) {
      await setData(
        { switch_preset: { clear: true, chatid: chatId, ...(mode ? { mode } : {}) } },
        arg,
      );
      return true;
    }
  } catch { /* 调用方自行降级 */ }
  return false;
}

/**
 * 切入子模式时一次性应用其默认预设（生效模型 · 凛倾 2026-07-08 定调）。
 * 「正在使用的预设」=运行时状态（active_preset_map），人/AI 切换动作直接改它；
 * 「绑定」（sub_modes[].presetName）只是**进入子模式那一刻的默认初始值**——本函数即该时刻的执行者。
 * 应用后人/AI 可自由切换（<presetSwitch>/手动下拉），生成时无任何强切盖回（原 T046 每轮强切已删：
 * 它把绑定做成锁，AI 流水线推进的预设切换当轮被拽回=进程堵死）。
 * 走完整 switch_preset 流程（精确键 [cid:modeGroup]+正则联动+preset_changed 广播=UI 顶部同步；
 * 裸键双写已收口 2026-07-11——裸键=跨模式共享槽，只在无 mode 时退化写）。
 * @param {string} username
 * @param {object} subMode - sub_modes[] 条目（presetName/modeGroup）
 * @param {string} [chatId] - 对话线 ID
 * @returns {Promise<boolean>} true=已应用（presetName 空/预设不存在=false 不动当前预设）
 */
export async function applySubModePresetDefault(username, subMode, chatId) {
  const name = subMode?.presetName;
  if (!name || !hasPreset(username, name)) return false;
  const mode = subMode.modeGroup || "code";
  const ok = await switchPresetViaAPI(name, { username }, chatId || undefined, mode);
  if (!ok) {
    // 降级应急（F1 重修 2026-07-12）：SetData 通道异常时直写激活键保预设生效
    // （读侧 resolveActivePresetName 按 mtime 读盘,写后即生效;内存态同写防回滚——见 setActivePresetName）。
    // 已知半态:该场景正则 resync/广播不可达,warn 已留痕。
    console.warn(`[presetBridge] switch_preset 通道异常,走降级直写 (subMode="${subMode?.id}", preset="${name}")`);
    await setActivePresetName(username, name, chatId || undefined, mode);
  }
  return true;
}

// [0716 凛倾定案] hasChatModePreset 已删——它只服务「模式绑定预设」首入守卫，该概念整体删除
//   （设计里只有「当前正在使用的预设」active_preset_map[cid:mode]，无记录回退全局 active_preset）。

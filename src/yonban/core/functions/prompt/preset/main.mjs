/**
 * [beilu-preset] — 预设引擎：TweakPrompt 三轮接管提示词组装。不管 AI API 调用（那是 StructCall/_shared 的事）、
 * 不管记忆/P1 管线（那是 beilu-memory/getPromptHandler 的事）。
 *
 * TweakPrompt 三轮职责：
 *   Round 1 (dl=2) 收集清空 — 读取 char_prompt/user_prompt/world_prompt + 全部 plugin_prompts
 *     到宏环境 env，清空原始模块（text=[]，保留 extension）；消费 beilu-worldbook 世界书注入；
 *     检测 P1 预设切换信号。
 *   Round 2 (dl=1) 重建四段 — 调 eng.buildAllEntries() 产 beforeChat/afterChat/injectionAbove/injectionBelow；
 *     处理 beilu-memory 的 memory_depth_injections（按 depth 分 above/below，macro:true 再求宏）；
 *     合并 model_params（覆盖链：子模式 > runtime model_overrides_by_char > 旧扁平全局 > 预设 eng.modelParams）；
 *     写入 extension 供下游 6 家 provider StructCall 消费。
 *   Round 3 (dl=0) 快照 — 仅 buildCommanderSnapshot() 记录调试快照，不再改 chat_log。
 *
 * 链路：getPromptHandler(21步) → 本模块 GetPrompt(空壳) + TweakPrompt(三轮) → requestBuilder → StructCall(六家 provider)
 * 影响：Round 1 写盘（P1 预设切换时 saveConfigToDisk + _resyncPresetRegex）；Round 2 修改 prompt_struct.chat_log（截取/宏替换/脏条目清理）
 * 相交：← requestBuilder.buildPromptStruct() 调本插件 GetPrompt/TweakPrompt
 *        ← beilu-memory extension 提供 memory_depth_injections / sub_mode_* / active_mode（[0717 串联收口] preset_switch_to 已删：P1 切换直走 switchPresetViaAPI 权威口）
 *        ← beilu-worldbook extension 提供 worldbook_char_injections/worldbook_injections
 *        → PresetEngine.buildAllEntries() 按条目排序+宏展开产四段消息
 *        → _shared/commanderAssembly 五段拼装（before+above+chat+below+after）
 *        → _shared/applyModelParams canonical→provider 形状采样器映射
 *
 * ══════════════ 激活态架构契约（隔离架构 2026-07-24/25 · 凛倾定案,改动前必读） ══════════════
 * 【没有全局】激活状态的唯一储存 = active_preset_map[cid:mode]（线级,每窗口每模式独立）。
 *   config.json 的 active_preset 字段已全面退役：解析不读/落盘不写/GetData 恒空下发/无任何写点,
 *   盘上残值=惰性死数据(仅作主引擎启动装载输入,不参与任何链)。历史病:它曾是隐形回退池,
 *   导入夺槽/删除换选写它 → 所有无线级记录的窗口/模式齐变(0724 系统烈性 bug 总根因之一)。
 * 【唯一解析】resolveActivePresetWithSource = 全系统唯一解析实现(生成/显示/AI链/token上限同键):
 *   [cid:mode] 精确键 → [cid] 裸键(旧数据兼容,只读不写) → code/work=当前生效子模式默认预设
 *   (resolveActiveSubModeId 带组维度守卫) → none(诚实空,不注入预设)。
 *   禁新增解析副本——历史上曾有 4 份实现漂移(presetBridge/前端镜像/token上限内联),已全部收口。
 * 【唯一写入】_activationMutate 漏斗 = 激活态唯一写路(锁内盘键级 RMW → 落盘 → 内存镜像盘 →
 *   失效缓存;权威方向=盘→内存)。本文件内禁绕过漏斗赋值 configData.active_preset_map。
 *   历史病:9+ 写点散写 + saveConfigToDisk 内存快照整份覆盖盘 = lost-update/重启回档族。
 * 【传导】状态变化必带坐标广播(actBroadcastLine cid/mode),禁静默;前端 8 显示口全部单源消费
 *   active_preset_resolved + 双事件通道(presetSwitched/preset-changed)重解析;前端缓存有失效
 *   代数守卫(sharedState getCachedPresetData,过期响应无权写缓存,0725 竞态修)。
 * 【三级隔离】(底部功能层.txt):预设库=用户级资产 / 激活态=线级 / 角色卡资产随卡——无坐标操作
 *   (导入等)只入库不激活,不得触碰任何线的状态。
 * 全案:工作日志 预设激活链系统bug调查_20260724\
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// [yonban T3d 迁移] 本文件实现体从 plugins/beilu-preset/main.mjs 迁入 functions/prompt/preset/main.mjs（5 级到 src）。
//   纯搬家零逻辑改动——engine 全局单槽/runtimeParams/读写同实例传导链一字不动（T4 去常驻批的靶点）。
//   import 级数按新位重算：engine 子文件随迁在同目录 ./engine/；marco.mjs 已归 macro 组（组13）不随迁，
//   指向 macro 组实现体 ../../macro/marco.mjs（preset→prompt→functions→macro，2 级到 functions/）；
//   info.json/config/registry/presets 等 part 元数据与用户数据留旧位，import.meta 锚点回旧位（见下 __pluginDir）。
import { evaluateMacros } from "../../macro/marco.mjs";
// [T065 per-user] 预设内容池 per-user 化：磁盘目录从全局单份 → data/users/<user>/presets/（getUserDataDir 权威范式，
//   与 yonban_config/eye_config 同款）。修复实锤泄漏：新用户 002 曾读到全局池含作者私人预设(017)并被激活。
import { getUserDataDir } from "../../memory/storage_mod/storage.mjs";
import { PresetEngine, buildDefaultMemory, SYSTEM_LEVEL_ID, USER_LEVEL_ID, DEFAULT_INJECTION_DEPTH } from "./engine/preset_engine.mjs";
// 参数缺省单源（2026-07-08 链路2）：空窗兜底改读 PARAM_SCHEMA，与引擎 extractModelParams 同表
import { paramDefault } from "./engine/paramSchema.mjs";
import { exportSTPreset } from "./engine/st_import.mjs";
// info.json 留旧位（part 元数据随 parts 树，parts_loader 发现旧位壳）→ 指回旧位；新位 5 级到 src + public/parts/plugins/beilu-preset。
import info from "../../../../../public/parts/plugins/beilu-preset/info.json" with { type: "json" };
import { countTokensSync } from "../../memory/nlp/tokenizer.mjs"; // T8·回切：组内新位
import { safeUnlink } from "../../rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体
// 根病1 单源化：_effective_max_context 补子模式层用同一权威解析（与 getPromptHandler / 生成层同口径）
import { dispatch } from "../../../dispatch/dispatcher.mjs"; // [0716 T3对接首批] 广播副作用改经 bus:broadcast 出口节点（exits.mjs），删 8 处一行式动态 import broadcast.mjs 散拼
import { resolveSubModeMaxContext, ensureMemoryDir, loadJsonFileIfExists, saveJsonFile, getActiveMode, resolveGenerationMode, withFileLock, resolveActiveSubModeId, getYonbanConfigPath } from "../../memory/storage_mod/storage.mjs"; // T8·回切：改组内引用（T3a 暂指旧位壳的欠账，T3e memory 已入住）；getActiveMode=显示/动作链用（无 arg 语境）；resolveGenerationMode=生成链 mode 唯一单源（0715 收口）；withFileLock=preset 写域 read-modify-write 串行锁（缺口⑦，复用 memory 域 A3 通用原语，per-file 键=registry/config/preset 各自路径，同源两窗口不再 lost-update）；[0716] resolveBotModeFromRequest 已随 bindingsDefault 死参删除
// §三-#6：preset 配置/预设落盘改用原子写（tmp+rename，与 storage.mjs saveTablesData 同标准），
//   防崩溃在写一半截断 JSON → 读时兜底静默丢 active_preset_map 等全局键。
import { nicerWriteFileSync, renameSyncWithRetry } from "../../../../../scripts/nicerWriteFile.mjs";
import { readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // 0716 T019 差集收编：config.json 损坏备份后抛（防默认结构写回销毁预设映射）
// A2-3：HTTP 端点鉴权中间件（未认证→401），与全站 router.get/post(path, authenticate, handler) 同型
import { authenticate } from "../../security/auth.mjs";
// 降噪#74：TweakPrompt 内 per-turn 历史 [DIAG] 残留改走项目 gated diag 框架（默认静默，
//   BEILU_DIAG=preset 可重现），与 beilu-worldbook 同构。createDiag emit 对非 error+未启用模块直接 return。
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
const diag = createDiag("preset");

// ============================================================
// 持久化
// ============================================================

// [yonban T3d 路径锚] __pluginDir 是 preset 全部用户数据的根（PRESETS_DIR/REGISTRY_FILE/config.json/
//   runtime_params.json 全基于它）。实现体虽迁到 yonban 新位，但用户预设数据仍在旧位 plugins/beilu-preset/，
//   若用 import.meta.url 会解析到新位 → 用户预设/激活映射/runtime 参数全部静默断裂（读到空目录）。
//   故锚回旧位（新位 preset/ 上 5 级 ../../../../../ 到 src，再 public/parts/plugins/beilu-preset）。deno eval 实测命中现存 registry.json。
//   与 T3a regex CONFIG_FILE / rollback storage 同类必要路径锚，非逻辑改动。
const __pluginDir = fileURLToPath(new URL("../../../../../public/parts/plugins/beilu-preset", import.meta.url));

// ---- 全局只读 builtin 种子源（不含用户态，保持全局单份，类比 default/templates/）----
const DEFAULTS_DIR = join(__pluginDir, "defaults");
// 旧全局目录（仅用于一次性迁移脚本判空/备份，运行时不读回退——禁旧路径回退，见 T065 规划四）
const LEGACY_GLOBAL_DIR = __pluginDir;

// ---- [T065 per-user] 存储路径：常量 → (username)=>path 函数，锚 data/users/<user>/presets/ ----
// 空 username 回退 "_default" 桶（getUserDataDir 内部同款兜底）——匿名/主链无 user 时不崩，与既有 _default 语义一致。
function _userPresetDir(username) { return join(getUserDataDir(username || "_default"), "presets"); }
function presetsDirOf(username) { return _userPresetDir(username); }
function registryFileOf(username) { return join(_userPresetDir(username), "registry.json"); }
function globalConfigFileOf(username) { return join(_userPresetDir(username), "config.json"); }
function runtimeParamsFileOf(username) { return join(_userPresetDir(username), "runtime_params.json"); }

// ============================================================
// 目录化存储 I/O
// ============================================================

/** 文件名清理 */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
}

/** 读取某用户的 config.json（active_preset + active_preset_map + deleted_builtins） */
function loadGlobalConfig(username) {
  // 0716 T019 差集收编：损坏 → readJsonSafeSync 备份 .corrupt.bak 后抛（原静默返默认结构，
  //   而调用链 loadGlobalConfig→改 map→saveGlobalConfig 会把默认结构写回=active_preset_map/
  //   deleted_builtins 整表销毁）。首装无文件仍返默认（合法路径不变）；抛错由上层 REST/action
  //   catch 承接报错可见。
  return readJsonSafeSync(globalConfigFileOf(username), { active_preset: "", default_preset: "", auto_seed_defaults: true });
}

/** 保存某用户 config.json。失败返回 false + 日志警告（不抛出，防调用方连锁崩溃） */
function saveGlobalConfig(username, config) {
  const f = globalConfigFileOf(username);
  try {
    if (!fs.existsSync(presetsDirOf(username))) fs.mkdirSync(presetsDirOf(username), { recursive: true });
    nicerWriteFileSync(f, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.error("[beilu-preset] ⚠ config.json 写入失败(可能磁盘满/权限不足):", e.message);
    try { wbD(null, "beilu-preset", "saveGlobalConfig:fail", false, e.message); } catch {}
    return false;
  }
}

/**
 * 删聊天清理链（deleteChat 第⑨站，07-03 补链）：清 active_preset_map 的 per-chatId 残键。
 * 【why】此前删聊天只清 ctx 目录不清映射→config.json 积累已删聊天的死键（孤儿复扫实证 3 条）。
 * 盘上与模块内存态（configData，saveConfigToDisk 合并写会把内存键写回）双清，防写回复活。
 * @param {string} chatid
 * @returns {boolean} 是否清了键
 */
/**
 * [缺口⑦ 2026-07-16] 缩：删聊天清理 active_preset_map 键是 config.json 的 read-modify-write，
 *   与并发 saveConfigToDisk/switch_preset 落盘会 lost-update（清理动作被覆盖，映射死键复活）。
 *   盘段 loadGlobalConfig→改 map→saveGlobalConfig 整段进 withFileLock（键=config.json）；
 *   内存段无锁必要（Node 单线程原子）。async 化后调用方 chatStorage.mjs:820 已 await 就绪。
 */
export async function removeChatPresetMapping(username, chatid) {
  if (!chatid) return false;
  // [隔离架构 2026-07-24] 收口到激活态唯一写入漏斗 _activationMutate（本函数曾是唯一正确的
  //   漏斗形实现——锁内盘 RMW+内存双清+缓存失效——现泛化为通用层后改为其消费方，删同构副本）。
  // 2026-07-09 收口审计语义保留：裸键+精确键 [cid:*] 一并清（原清理只删裸键，精确键成死键残留）。
  try {
    const out = await _activationMutate(username, `removeByChat ${chatid}`, (gc) => {
      const _stale = Object.keys(gc.active_preset_map).filter(k => k === chatid || k.startsWith(chatid + ":"));
      for (const k of _stale) delete gc.active_preset_map[k];
      return { changed: _stale.length > 0, removed: _stale.length };
    });
    return !!out.changed;
  } catch (e) {
    // 非致命语义保留（原实现同款）：删聊天主链不因映射清理失败中断，warn 留痕
    console.warn("[beilu-preset] removeChatPresetMapping 失败:", e.message);
    return false;
  }
}

// ============================================================
// [隔离架构 2026-07-24 · 凛倾「储存/功能/传导都需要隔离,不是打补丁」] 激活态收口层
// ——active_preset（用户级全局默认槽）与 active_preset_map（线级 [cid:mode]）的【唯一写入漏斗】。
// 【why】原激活状态写散在 9+ 处（switch/import/delete/rename/clear/create/删聊天/presetBridge 降级桥），
//   各自 read-modify-write，且 saveConfigToDisk 用内存快照整份覆盖盘上 map → lost-update/整态回滚
//   族病（缺口⑦、presetBridge:139 自认"主模块下次落盘可能回滚本写入"、0724 系统烈性 bug 土壤）。
// 【框架语义】每次变更 = withFileLock(config.json) 盘上键级 RMW → 落盘 → 内存镜像盘
//   （权威方向 = 盘→内存，与旧 saveConfigToDisk 的内存→盘相反）→ 失效新鲜读缓存。
//   读侧 resolveActivePresetWithSource/_loadGlobalCfgFresh 按 mtime 读盘，写后即见（读写同源）。
// 【纪律】本文件内禁止绕过本层直接赋值 configData.active_preset / active_preset_map
//   （启动 load 初始化方向除外）；新增激活语义 = 在本层加 act* 函数，禁在调用点手拼。
// 【传导】广播统一走 actBroadcastLine（带 cid/mode 坐标）/ actBroadcastGlobal（scope:global+reason），
//   状态变化禁静默（0724 删除换选静默齐变实证）。
// ============================================================
async function _activationMutate(username, label, mutator) {
  const cfgPath = globalConfigFileOf(username);
  let out = { changed: false };
  let snapshot = null;
  // 错误不吞（0716 T019 定案：config.json 损坏 readJsonSafeSync 备份后抛=必须可见）——
  //   上抛由 SetData/REST 层 catch 承接报错；需要非致命语义的调用方（删聊天清理链）自行兜。
  await withFileLock(cfgPath, () => {
    const gc = loadGlobalConfig(username);
    gc.active_preset_map = gc.active_preset_map || {};
    out = mutator(gc) || { changed: false };
    if (out.changed) saveGlobalConfig(username, gc);
    snapshot = gc;
  });
  if (out.changed) {
    const st = _existingStore(username);
    if (st) {
      st.configData.active_preset_map = { ...(snapshot.active_preset_map || {}) };
      // 全局槽只在本次真的改了它时才回灌内存——否则启动 loadConfigFromDisk 的
      // "激活指向缺失→内存自动修选第一个"会被盘上 stale 值盖回（修复失效）
      if (out.globalChanged) st.configData.active_preset = snapshot.active_preset || "";
      st.globalCfgCache = { mtime: 0, data: null }; // 写后失效新鲜读缓存
    }
  }
  return out;
}

/** 线级激活：mode 有值写精确键 [cid:mode]；无 mode 退化写裸键（旧语义保留，读侧兼容链消费） */
async function actSetLine(username, cid, mode, name) {
  if (!cid || !name) return { changed: false };
  const key = mode ? cid + ":" + mode : cid;
  return _activationMutate(username, `setLine ${key}`, (gc) => {
    if (gc.active_preset_map[key] === name) return { changed: false, already: true };
    gc.active_preset_map[key] = name;
    return { changed: true, key };
  });
}

/** 清线级覆盖：精确键+裸键一并清（bot「回退默认」/switch_preset clear 语义） */
async function actClearLine(username, cid, mode) {
  if (!cid) return { changed: false };
  return _activationMutate(username, `clearLine ${cid}:${mode || "*"}`, (gc) => {
    let n = 0;
    const key = mode ? cid + ":" + mode : cid;
    if (key in gc.active_preset_map) { delete gc.active_preset_map[key]; n++; }
    if (cid in gc.active_preset_map) { delete gc.active_preset_map[cid]; n++; }
    return { changed: n > 0, removed: n };
  });
}

// [0725 凛倾「没有全局」] actSetGlobal 已删除——全局槽概念废除,全部调用点(切换/删除换选/首激活/
//   导入显式/clear)同批废除,零调用后函数体移除(禁留死代码)。

/** 删除预设：清全部指向该预设的线级键，返回受影响坐标列表（供传导层逐键广播） */
async function actRemoveByPreset(username, name) {
  return _activationMutate(username, `removeByPreset "${name}"`, (gc) => {
    const affected = [];
    for (const [k, v] of Object.entries(gc.active_preset_map)) {
      if (v !== name) continue;
      delete gc.active_preset_map[k];
      const i = k.indexOf(":");
      affected.push(i < 0 ? { cid: k } : { cid: k.slice(0, i), mode: k.slice(i + 1) });
    }
    return { changed: affected.length > 0, affected };
  });
}

/** 重命名预设：全局槽 + 线级键指向值同步改名（原 rename 分支散拼实现收口） */
async function actRenamePreset(username, oldName, newName) {
  return _activationMutate(username, `rename "${oldName}"→"${newName}"`, (gc) => {
    let changed = false, globalChanged = false;
    if (gc.active_preset === oldName) { gc.active_preset = newName; changed = true; globalChanged = true; }
    for (const [k, v] of Object.entries(gc.active_preset_map)) {
      if (v === oldName) { gc.active_preset_map[k] = newName; changed = true; }
    }
    return { changed, globalChanged };
  });
}

// —— 传导层：激活态变化广播统一出口（坐标必带，禁静默） ——
async function actBroadcastLine(cid, mode, preset) {
  const _r = await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: cid, event: { type: "preset_changed", payload: { preset, cid, ...(mode ? { mode } : {}) } } } });
  if (!_r?.ok) console.warn("[beilu-preset] preset_changed(line) broadcast failed:", _r?.error?.msg);
}
// [0725 凛倾「没有全局」] actBroadcastGlobal 已删除——scope:global 事件的生产面随全局槽废除消亡
//   (websocket 消费侧对无 cid/scope:global 事件的兼容分支保留,服务旧事件与未来显式全域刷新)。

/** 读取某用户 registry */
function loadRegistry(username) {
  const f = registryFileOf(username);
  try {
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, "utf-8"));
    }
  } catch (e) {
    console.warn("[beilu-preset] 读取 registry.json 失败:", e.message);
  }
  return { presets: {} };
}

/** 保存某用户 registry。失败返回 false + 日志警告（不抛出，防调用方连锁崩溃） */
function saveRegistry(username, registry) {
  const f = registryFileOf(username);
  try {
    if (!fs.existsSync(presetsDirOf(username))) fs.mkdirSync(presetsDirOf(username), { recursive: true });
    nicerWriteFileSync(f, JSON.stringify(registry, null, 2), "utf-8");
    // 自写完成后同步 store 上的 _registryMtime，避免下次 getStore 因自写 mtime 前进而触发无用重载
    //   （在盘态失效框架里，"我们自己刚写的"与"外部改写"要区分——外部改写才应触发重载）
    try {
      const st = perUserStore.get(_normUser(username));
      if (st) st._registryMtime = fs.statSync(f).mtimeMs || 0;
    } catch { /* 非致命：下次 getStore 至多多一次同源重载 */ }
    return true;
  } catch (e) {
    console.error("[beilu-preset] ⚠ registry.json 写入失败(可能磁盘满/权限不足):", e.message);
    try { wbD(null, "beilu-preset", "saveRegistry:fail", false, e.message); } catch {}
    return false;
  }
}

/** 读取某用户单个预设文件 */
function loadPresetFile(username, name) {
  const reg = loadRegistry(username);
  const entry = reg.presets[name];
  if (!entry?.file) return null;
  const filePath = join(presetsDirOf(username), entry.file);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`[beilu-preset] ⚠ 预设文件损坏/读取失败 "${name}":`, e.message);
    try { wbD(null, "beilu-preset", "loadPresetFile:corrupt", false, `${name}: ${e.message}`); } catch {}
  }
  return null;
}

/**
 * 保存某用户单个预设文件。
 * [缺口⑦ 2026-07-16] 缩：read-modify-write（loadRegistry→改reg→saveRegistry+preset文件落盘）串行进
 *   withFileLock（键=registry.json 路径，与 scanAndSyncRegistry/seedBuiltinsForUser/deletePresetFile
 *   同键）——多窗口/多请求并发写不同预设时，原来"两路各自 loadRegistry(旧盘态)→加自家条目→
 *   saveRegistry"会 lost-update（后写盖掉前写的条目）。preset 内容文件本身路径互斥（不同 name→
 *   不同文件），tmp+rename 原子写，与锁的键（registry）无关；多窗口写同一预设=同 name 会串行进
 *   同锁→最后一次写胜出（预期语义，与内存态 syncPresetEngineToConfig 一致）。
 * 返回：true 成功 / false 失败（沿用旧签名，调用方判 _saved 分支保留）。
 */
async function savePresetFile(username, name, data) {
  const regPath = registryFileOf(username);
  return withFileLock(regPath, () => {
    const reg = loadRegistry(username);
    let entry = reg.presets[name];
    if (!entry) {
      // 新预设：source 取调用方传入（未传则 user）。registry 为权威源。
      const fileName = sanitizeFilename(name) + ".json";
      entry = {
        file: fileName,
        source: data._meta?.source || "user",
        description: data._meta?.description || "",
        tags: [],
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      };
      reg.presets[name] = entry;
    }
    entry.modified_at = new Date().toISOString();
    if (data._meta?.description !== undefined) {
      entry.description = data._meta.description;
    }

    // ★ B8 单源：registry 是 source 的唯一权威源。落盘文件的 _meta.source 一律
    //   覆盖回 registry 现行 source，忽略调用方传入的硬编码值（多处调用硬写
    //   "user"，会把 builtin 预设错误降级）。保存不改变预设的 source 归属。
    const authoritativeSource = entry.source || "user";
    const dataToWrite = {
      ...data,
      _meta: { ...(data._meta || {}), source: authoritativeSource },
    };

    const dir = presetsDirOf(username);
    const filePath = join(dir, entry.file);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      nicerWriteFileSync(filePath, JSON.stringify(dataToWrite, null, 2), "utf-8");
      saveRegistry(username, reg);
      // 自写完成后同步 store 上该预设条目的 _file_mtime/_file_path，避免下次 getEngineFor 因自写
      //   mtime 前进触发无用单文件重载（自写内容与内存态同源，无需刷新）
      try {
        const st = perUserStore.get(_normUser(username));
        if (st?.configData?.presets?.[name]) {
          st.configData.presets[name]._file_mtime = fs.statSync(filePath).mtimeMs || 0;
          st.configData.presets[name]._file_path = filePath;
        }
      } catch { /* 非致命：下次 getEngineFor 至多多一次同源重载 */ }
      return true;
    } catch (e) {
      console.warn(`[beilu-preset] 保存预设文件失败 "${name}":`, e.message);
      return false;
    }
  });
}

/**
 * 删除某用户单个预设文件。
 * [缺口⑦ 2026-07-16] 缩：registry.json 与 config.json 两把 read-modify-write 各自串行进对应 withFileLock。
 *   ①registry 锁段：读 reg→取 entry→await safeUnlink→（builtin 时在 config 锁内改 deleted_builtins→
 *     写 config）→delete reg[name]→saveRegistry；跨 await 的 safeUnlink 是文件系统删除，与内存 reg 无关，
 *     锁只护 reg 的 read+mutate+write，safeUnlink 后回到锁内再改 reg 是安全的（此 fn 全程持锁）。
 *   ②config 锁段：仅 builtin 分支进入，短 RMW，不嵌套 safeUnlink。两锁不同键无死锁风险。
 * 调用方（SetData delete_preset :1631、rename_preset :1865）已 `await deletePresetFile(...)`，async 化零回归。
 */
async function deletePresetFile(username, name) {
  const regPath = registryFileOf(username);
  const cfgPath = globalConfigFileOf(username);
  await withFileLock(regPath, async () => {
    const reg = loadRegistry(username);
    const entry = reg.presets[name];
    if (!entry) return;
    const filePath = join(presetsDirOf(username), entry.file);
    try {
      if (fs.existsSync(filePath)) await safeUnlink(filePath, "deletePreset");
    } catch (e) {
      console.warn(`[beilu-preset] 删除预设文件失败 "${name}":`, e.message);
    }
    // builtin 预设被用户主动删除 → 记录到该用户 config，防惰性播种复活（per-user deleted_builtins）
    if (entry.source === "builtin") {
      await withFileLock(cfgPath, () => {
        const gc = loadGlobalConfig(username);
        gc.deleted_builtins = gc.deleted_builtins || [];
        if (!gc.deleted_builtins.includes(name)) gc.deleted_builtins.push(name);
        saveGlobalConfig(username, gc);
      });
    }
    delete reg.presets[name];
    saveRegistry(username, reg);
  });
}

/**
 * 扫描某用户 presets/ 目录，同步其 registry。
 * [缺口⑦ 2026-07-16 保持 sync] 唯一调用方=loadConfigFromDisk（首访/mtime失效重建，在 getStore 同步路径内），
 *   getStore 仍是 sync（数百消费方 arg=同步），此函数不改 async。两窗口同步首触发的确会双跑本函数——
 *   但扫描+播种都是幂等（已有文件不覆盖、条目名一致），末尾 saveRegistry 走 tmp+rename 原子写：
 *   即便双写，落盘也不torn，last-writer-wins 内容同型（相同 reg 状态），无 lost-update 真实病害。
 *   真实并发 RMW 风险在写路径（savePresetFile 系列），已各自进 withFileLock。
 */
function scanAndSyncRegistry(username) {
  const dir = presetsDirOf(username);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const reg = loadRegistry(username);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "registry.json" && f !== "config.json" && f !== "runtime_params.json");

  // 扫描目录中存在但 registry 中没有的文件
  for (const file of files) {
    const knownNames = Object.values(reg.presets).map((e) => e.file);
    if (!knownNames.includes(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(join(dir, file), "utf-8"));
        const name = data._meta?.name || file.replace(".json", "");
        reg.presets[name] = {
          file,
          source: data._meta?.source || "user",
          description: data._meta?.description || "",
          tags: [],
          created_at: data._meta?.created_at || new Date().toISOString(),
          modified_at: new Date().toISOString(),
        };
      } catch (e) {
        console.warn(`[beilu-preset] 扫描跳过损坏文件 ${file}:`, e.message);
      }
    }
  }

  // 清理 registry 中指向不存在文件的条目
  for (const [name, entry] of Object.entries(reg.presets)) {
    if (!fs.existsSync(join(dir, entry.file))) {
      delete reg.presets[name];
    }
  }

  saveRegistry(username, reg);
  return reg;
}

// ---- [T065 期3 folded] builtin 播种名单（全局单源，per-user 惰性播种时过滤个人存量）----
// 泄漏根因：defaults/ 内每个文件自报 _meta.source="builtin"（连个人预设(017)也自报 builtin），
//   故不能用「文件自报 source」过滤——个人预设(017)会漏进播种，正是凛倾实测 002 看到个人预设(017)的病灶。
// 权威过滤单源 = 旧全局 registry.json 的 source 字段（个人预设(017)在其中标 source=user）+ 旧全局
//   config.json deleted_builtins（个人预设(017)在列）。据此产出「应播给新用户的 builtin 文件名单」缓存一次。
let _builtinSeedManifestCache = null;
function _builtinSeedManifest() {
  if (_builtinSeedManifestCache) return _builtinSeedManifestCache;
  const manifest = []; // [{name, file}]
  try {
    const gReg = JSON.parse(fs.readFileSync(join(LEGACY_GLOBAL_DIR, "registry.json"), "utf-8"));
    let gDeleted = [];
    try { gDeleted = new Set(JSON.parse(fs.readFileSync(join(LEGACY_GLOBAL_DIR, "config.json"), "utf-8")).deleted_builtins || []); } catch { gDeleted = new Set(); }
    for (const [name, e] of Object.entries(gReg.presets || {})) {
      // 只播 source=builtin 且未被凛倾标记删除的（个人预设(017)=source=user → 天然排除；且已在 deleted_builtins）
      if (e?.source !== "builtin" || !e?.file) continue;
      if (gDeleted.has && gDeleted.has(name)) continue;
      if (fs.existsSync(join(DEFAULTS_DIR, e.file))) manifest.push({ name, file: e.file });
    }
  } catch (err) {
    console.warn("[beilu-preset] 构建 builtin 播种名单失败（全局 registry 不可读）:", err?.message);
  }
  _builtinSeedManifestCache = manifest;
  return manifest;
}

/**
 * [T065 期3] 惰性播种：首次读某 user 预设目录且其为空 → 从全局 DEFAULTS_DIR 播 builtin 名单（过滤个人预设(017)等个人存量）。
 * 幂等：已有预设文件则不播；per-user deleted_builtins 尊重（该用户删过的 builtin 不复活）。
 * [缺口⑦ 2026-07-16 保持 sync] 唯一调用方=loadConfigFromDisk（getStore 同步首访路径），
 *   getStore 是同步 API 不改（数百消费方 sync）。首访幂等（copyFileSync 见"已有→不覆盖"分支保护 +
 *   condition `if (!reg.presets[name])` 保 registry 幂等），末尾 saveRegistry 走 tmp+rename 原子写：
 *   多窗口同一 user 首触发即便双跑，播种内容与 reg 目标状态同型，last-writer-wins 内容一致，
 *   无真实 lost-update。写路径的 RMW 风险在 savePresetFile 系列（用户增删改动作），已锁保。
 * @returns {number} 播种数量
 */
function seedBuiltinsForUser(username) {
  if (!fs.existsSync(DEFAULTS_DIR)) return 0;
  const dir = presetsDirOf(username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const manifest = _builtinSeedManifest();
  if (manifest.length === 0) return 0;

  const gc = loadGlobalConfig(username);
  const deleted = new Set(gc.deleted_builtins || []);
  const reg = loadRegistry(username);

  let seeded = 0;
  for (const { name, file } of manifest) {
    if (deleted.has(name)) continue;
    const targetPath = join(dir, file);
    if (fs.existsSync(targetPath)) continue; // 已有→不覆盖用户改动
    try {
      fs.copyFileSync(join(DEFAULTS_DIR, file), targetPath);
      // 同步 registry（标 builtin，与全局同源）
      if (!reg.presets[name]) {
        reg.presets[name] = {
          file, source: "builtin", description: "",
          tags: [], created_at: new Date().toISOString(), modified_at: new Date().toISOString(),
        };
      }
      seeded++;
    } catch (e) {
      console.warn(`[beilu-preset] 播种 builtin "${name}" 失败:`, e.message);
    }
  }
  if (seeded > 0) {
    saveRegistry(username, reg);
    console.log(`[beilu-preset] 用户 "${username}" 首访播种 ${seeded} 个 builtin 预设（已过滤个人存量）`);
  }
  return seeded;
}

// ---- 兼容旧接口的包装 ----

/**
 * 将某用户 store 的 configData 保存到磁盘（保存激活预设内容 + config.json）。
 * [缺口⑦ 2026-07-16] 缩：整段 read _onDisk → 合成 → saveGlobalConfig → savePresetFile(激活预设) 的
 *   两级 RMW：外层锁=config.json（读盘 _onDisk→合并内存 active_preset*→saveGlobalConfig）；内层
 *   savePresetFile 自带 registry.json 锁（不同键无死锁）。两窗口并发切换/边界写不再 lost-update。
 *   语义保留：`..._onDisk` 只护住 active_preset_map 之外的顶层字段；savePresetFile 走 await。
 *   调用方全部在 async 上下文（SetData/TweakPrompt/presetBridge），异步化零回归。
 */
async function saveConfigToDisk(username) {
  const st = getStore(username);
  const configData = st.configData;
  const gcf = globalConfigFileOf(username);
  try {
    await withFileLock(gcf, () => {
      let _onDisk = {};
      try {
        if (fs.existsSync(gcf)) _onDisk = JSON.parse(fs.readFileSync(gcf, "utf-8"));
      } catch { /* 损坏时按空处理 */ }
      saveGlobalConfig(username, {
        ..._onDisk,
        // [0725 凛倾「没有全局」] active_preset 停写(字段退役,盘上残值成惰性死数据,解析链已不读)
        default_preset: configData.default_preset || "",
        auto_seed_defaults: true,
        // [隔离架构 2026-07-24] active_preset_map 内存快照覆盖行删除——map 写已全部收口到激活态
        //   漏斗(_activationMutate)键级 RMW 落盘,盘为权威;此处整份覆盖=lost-update/整态回滚族病根
        //   (presetBridge 降级写被回滚、删聊天清理死键复活,缺口⑦)。_onDisk 展开已原样保留盘上 map。
        //   active_preset 保留内存写:运行时写点已全迁漏斗(内存==盘恒等),仅启动 loadConfigFromDisk
        //   "激活指向缺失自动修选"的修复值经此持久化。
      });
      st.globalCfgCache = { mtime: 0, data: null }; // 写后失效新鲜读缓存
    });
    // 保存当前激活预设——出 config 锁再走 registry 锁（savePresetFile 内部），避免嵌套锁扩散
    const name = configData.active_preset;
    if (name && configData.presets[name]) {
      const preset = configData.presets[name];
      await savePresetFile(username, name, {
        _meta: { name, source: "user", description: preset.description || "" },
        preset_json: preset.preset_json || {},
        model_params: preset.model_params || {},
        macro_variables: preset.macro_variables || {},
      });
    }
  } catch (e) {
    console.warn("[beilu-preset] saveConfigToDisk 失败:", e.message);
  }
}

/**
 * 从某用户磁盘读取配置（目录化版本）。首访触发惰性播种。
 * [缺口⑦ 2026-07-16 保持 sync] getStore 是 sync API，本函数在其同步路径内调用；seedBuiltinsForUser/
 *   scanAndSyncRegistry 幂等，无需锁（详见各函数上方注释）。
 * @param {string} username
 * @returns {object|null}
 */
function loadConfigFromDisk(username) {
  // 1. 惰性播种 builtin（首访空目录 → 从全局 DEFAULTS_DIR 播，过滤个人存量）
  seedBuiltinsForUser(username);

  // 2. 扫描并同步 registry
  const registry = scanAndSyncRegistry(username);
  const globalConfig = loadGlobalConfig(username);

  if (Object.keys(registry.presets).length === 0) return null;

  // 3. 构建 configData 结构（全量加载所有预设完整数据）
  const result = {
    active_preset: globalConfig.active_preset || "",
    active_preset_map: globalConfig.active_preset_map || {},
    presets: {},
  };

  const dir = presetsDirOf(username);
  for (const [name, entry] of Object.entries(registry.presets)) {
    const filePath = join(dir, entry.file);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        // 记录源文件 mtime（条目平级字段_file_mtime/_file_path，不污染 preset_json 本体）
        //   供 getEngineFor 命中 engineCache 前对该预设源文件 statSync 做单文件失效——
        //   直写盘（不经 saveConfigToDisk）时 engineCache 自动同源，与 store 级 registry mtime 失效互补。
        let _mtime = 0;
        try { _mtime = fs.statSync(filePath).mtimeMs || 0; } catch { _mtime = 0; }
        result.presets[name] = {
          preset_json: data.preset_json || {},
          model_params: data.model_params || {},
          macro_variables: data.macro_variables || {},
          description: data._meta?.description || entry.description || "",
          _file_mtime: _mtime,
          _file_path: filePath,
        };
      }
    } catch (e) {
      console.warn(`[beilu-preset] 加载预设 "${name}" 失败:`, e.message);
    }
  }

  // [0725 凛倾「没有全局」] 原"激活预设不存在自动选第一个"块删除——active_preset 字段退役,
  //   没有槽需要修选;残值仅作主引擎启动装载的惰性输入,不参与任何解析/显示/持久化。

  console.log(`[beilu-preset] 用户 "${username}" 目录化加载完成: ${Object.keys(result.presets).length} 个预设, 激活="${result.active_preset}"`);
  return result;
}

// ============================================================
// 插件状态 —— [T065 per-user] 三单例（engine/configData/runtimeParams）+ 两缓存
//   （engineCache/macroMemCache）下沉为 perUserStore: Map<username, UserStore>。
//   根因：原进程级单例被全部请求共享，改磁盘路径不改内存态仍串台（凛倾实测 002 看到凛倾激活预设）。
//   getStore(username) 惰性建桶 + 首访 loadConfigFromDisk（含惰性播种）+ 载入激活预设到桶引擎。
// ============================================================

/**
 * 最近一次提示词快照（内存中，不持久化，纯调试）——全局单份即可（/prompt-snapshot 调试端点，
 * 非用户态数据，最后一次生成的快照供开发查看，无隔离必要）。
 * @type {object|null}
 */
let lastPromptSnapshot = null;

/** 运行时参数默认值（常量模板，各 user store 拷一份） */
const RUNTIME_PARAMS_DEFAULTS = {
  context_msg_limit: 0,
  stream: true,
  prompt_post_processing: "none",
  prefill_enabled: false,
  claude_prefill_mode: "off",
  // ---- 模型参数（覆盖预设） ----
  openai_max_context: 0,  // 0=使用预设值
  openai_max_tokens: 0,   // 0=使用预设值
  temperature: -1,        // -1=使用预设值
  top_p: -1,              // -1=使用预设值
  top_k: -1,              // -1=使用预设值
  frequency_penalty: null,  // null=使用预设值（penalty 合法范围 -2~2，不能用 -1 当哨兵）
  presence_penalty: null,   // null=使用预设值（penalty 合法范围 -2~2，不能用 -1 当哨兵）
  min_p: -1,              // -1=使用预设值
  // thinking 六口·口2（2026-07-25）：boolean 域 false 是合法显式值不能当哨兵，用 null=使用预设值（对齐 penalty 范式）；
  //   budget 合法域 ≥1024（PARAM_SCHEMA），0 可安全作"使用预设值"哨兵。
  extended_thinking: null,
  thinking_budget: 0,
};

/** 加载某用户持久化的 runtime params */
function loadRuntimeParams(username) {
  const f = runtimeParamsFileOf(username);
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, "utf-8"));
      return { ...RUNTIME_PARAMS_DEFAULTS, ...data };
    }
  } catch (e) {
    console.warn("[beilu-preset] 加载 runtime_params.json 失败:", e.message);
  }
  return { ...RUNTIME_PARAMS_DEFAULTS };
}

/** 保存某用户 runtime params 到磁盘 */
function saveRuntimeParams(username) {
  const st = getStore(username);
  const f = runtimeParamsFileOf(username);
  try {
    if (!fs.existsSync(presetsDirOf(username))) fs.mkdirSync(presetsDirOf(username), { recursive: true });
    nicerWriteFileSync(f, JSON.stringify(st.runtimeParams, null, 2), "utf-8");
  } catch (e) {
    console.warn("[beilu-preset] 保存 runtime_params.json 失败:", e.message);
  }
}

// ============================================================
// perUserStore：username → { configData, engine, macroMemory, runtimeParams,
//                            engineCache, macroMemCache, globalCfgCache, loaded }
// ============================================================
/** @type {Map<string, object>} */
const perUserStore = new Map();

/** 归一 username：空/未定义 → "_default" 桶（匿名/主链无 user 时的回退桶，与既有 _default 语义一致） */
function _normUser(username) {
  return (typeof username === "string" && username) ? username : "_default";
}

/** 取（不创建）某 user 已实例化的 store，未实例化返回 null——供 removeChatPresetMapping /
 *  presetBridge.setActivePresetName（降级写的内存态同写,防 saveConfigToDisk 整态回滚）等
 *  仅需内存态同步场景。export 2026-07-12 F1 重修。 */
export function _existingStore(username) {
  return perUserStore.get(_normUser(username)) || null;
}

/**
 * 惰性取某 user 的 store：首次访问建桶 + loadConfigFromDisk（含惰性播种）+ 载入激活预设到桶引擎。
 * @param {string} username
 * @returns {{configData:object, engine:PresetEngine, macroMemory:object, runtimeParams:object, engineCache:Map, macroMemCache:Map, globalCfgCache:object, loaded:boolean}}
 */
function getStore(username) {
  const key = _normUser(username);
  let st = perUserStore.get(key);
  if (st) {
    // 【store 级失效】盘=真相，configData=缓存：每次取桶都以 registry.json mtime 为权威指纹。
    //   直写盘上预设文件 + touch/写 registry.json（增删/注册变更）会让 mtime 前进 → 触发 configData
    //   重建 + engineCache/macroMemCache 清空，同源刷新。保留 st.engine（激活主引擎，含 UI 未保存
    //   编辑态）与 st.macroMemory（宏记忆不来自预设文件），只换 configData 快照与懒加载缓存。
    //   自身 saveRegistry 已同步更新 _registryMtime，不会因自写而无效重载。
    try {
      const rf = registryFileOf(key);
      let curMt = 0;
      try { curMt = fs.existsSync(rf) ? (fs.statSync(rf).mtimeMs || 0) : 0; } catch { curMt = 0; }
      if (curMt !== st._registryMtime) {
        const saved = loadConfigFromDisk(key);
        if (saved?.presets) {
          st.configData = {
            active_preset: saved.active_preset || "",
            active_preset_map: saved.active_preset_map || {},
            presets: saved.presets || {},
          };
          st.engineCache.clear();
          st.macroMemCache.clear();
          // 不动 st.engine / st.macroMemory：主引擎持 UI 未保存编辑态，直到显式 syncPresetEngineToConfig
          //   / setActivePresetName 才换绑；重建仅刷新快照与懒加载入口。
        }
        st._registryMtime = curMt;
      }
    } catch (e) {
      // fail-loud 留痕但不吞任务：EPERM/安全软件拦截 statSync 等异常场景沿用旧快照
      console.warn(`[beilu-preset] getStore("${key}") 盘态失效检查失败(沿用旧快照):`, e?.message);
    }
    return st;
  }

  st = {
    _user: key,
    configData: { active_preset: "", presets: {} },
    engine: new PresetEngine(),
    macroMemory: buildDefaultMemory(),
    runtimeParams: loadRuntimeParams(key),
    engineCache: new Map(),
    macroMemCache: new Map(),
    globalCfgCache: { mtime: 0, data: null },
    _registryMtime: 0, // 【store 级失效指纹】registry.json 上次已知 mtime，与 getStore 复用路径对比
    loaded: false,
  };
  perUserStore.set(key, st);

  // 首访：从磁盘载入（惰性播种 builtin → 扫 registry → 全量加载预设 → 载入激活预设到引擎）
  try {
    const saved = loadConfigFromDisk(key);
    if (saved?.presets) {
      st.configData = {
        active_preset: saved.active_preset || "",
        active_preset_map: saved.active_preset_map || {},
        presets: saved.presets || {},
      };
      const activeData = st.configData.presets[st.configData.active_preset];
      if (activeData?.preset_json) {
        st.engine.load(activeData.preset_json, st.configData.active_preset);
        if (activeData.model_params && Object.keys(activeData.model_params).length > 0) {
          // updateModelParams（非 Object.assign）：载盘路顺带归一历史漂移的 max_context 双键
          st.engine.updateModelParams(activeData.model_params);
        }
        if (activeData.macro_variables) st.macroMemory.variables = { ...activeData.macro_variables };
      }
    }
  } catch (e) {
    console.warn(`[beilu-preset] getStore("${key}") 首访加载失败:`, e.message);
  }
  // 首访完成后，标记当前 registry.json mtime（loadConfigFromDisk 已惰性播种/同步 registry，
  //   此处读到的是同步后 mtime，作为后续失效比对的基线）
  try {
    const rf = registryFileOf(key);
    st._registryMtime = fs.existsSync(rf) ? (fs.statSync(rf).mtimeMs || 0) : 0;
  } catch { st._registryMtime = 0; }
  st.loaded = true;
  return st;
}

/**
 * 生效 max_context 单一解析（2026-07-13 参照 ST oai_settings 单源模型收口）。
 * 原 storage.mjs resolveEffectiveMaxContext 是本逻辑的文件级重实现——每问一次分母就重读
 * config.json/registry.json/预设文件，与真生成层（mergeRuntimeParams 读内存 store）异源，
 * 多解析点各自漂移 = 238%/615.5%/4.1k 症状族根因（该文件版已删，消费方全部迁到本函数）。
 * 现层2/层3 直读内存 store，与生成层同一份数据（runtimeParams/configData 与盘双写同步：
 * applyRuntimeParams 落盘、syncPresetEngineToConfig:2639 内存+盘同写、setActivePresetName F1 双写）。
 * 层序不变：子模式(>0) ▸ runtime 覆盖(openai_max_context>0) ▸ 预设 base ▸ PARAM_SCHEMA 默认。
 * @param {string} username
 * @param {string|null} [modeGroup] - 子模式精确解析用；省略=best-effort（端点无模式上下文）
 * @param {string|null} [chatId] - per-chatId 子模式 + 激活预设解析
 * @param {string|null} [activePresetName] - 已知激活预设名（避免重复解析）；省略按 chatId 自解析
 * @param {string|null} [charName] - 模式桶解析用（active_modes_map 为 per-char 桶）
 * @returns {number} 生效 max_context（恒 >0）
 */
export function resolveEffectiveMaxContextLive(username, modeGroup = null, chatId = null, activePresetName = null, charName = null) {
  // 层1：子模式覆盖（子模式配置归 memory 域，保留其权威解析）
  try {
    const _sm = resolveSubModeMaxContext(username, modeGroup, chatId);
    if (_sm > 0) return _sm;
  } catch { /* 降级到 runtime/预设 */ }
  const _st = getStore(username);
  // 层2：runtime 覆盖（内存；0=哨兵「使用预设值」）
  const _rt = Number(_st.runtimeParams?.openai_max_context) || 0;
  if (_rt > 0) return _rt;
  // 层3：预设 base（内存 configData；预设名序=精确键 [cid:mode] > 裸键 > 全局，与 resolveActivePresetName 同序）
  try {
    let _name = activePresetName;
    if (!_name) {
      // [0725 解析收口] 原内联手拼 map+退役字段回退 = 第四份解析副本(0725 验证债扫描发现:
      //   `|| configData.active_preset` 让 token 上限从残值预设取参数=退役字段语义泄漏)。
      //   改调唯一收口点(线级→code/work 子模式→none,与生成/显示同键)。
      let _pmMode = null;
      try { _pmMode = chatId ? getActiveMode(username || "_default", charName || "_global", chatId) : null; } catch { /* 无模式=裸键层兜底 */ }
      _name = resolveActivePresetName(username, chatId, _pmMode) || "";
    }
    const _mp = _name ? (_st.configData.presets[_name]?.model_params || {}) : {};
    // 载盘首访未经 sync 时 model_params 可能只有 ST 旧键 openai_max_context，双键读
    const _base = Number(_mp.max_context ?? _mp.openai_max_context) || 0;
    if (_base > 0) return _base;
  } catch { /* 降级到默认 */ }
  // 层4：默认（单源=PARAM_SCHEMA，不再写死字面量）
  return paramDefault("max_context");
}

/**
 * A2 过桥重构（07-03）：运行时参数视图合成纯函数——原 GET /config/runtime-params handler 内联逻辑逐字抽出
 * （_getUserByReq(req)→username 参数，其余零改动）。REST 薄壳与桥线 getRuntimeParams 共用单源。
 * 返回 runtimeParams + 预设基础值哨兵填充（_effective_*）+ 三层 max_context（子模式▸runtime▸预设，根病1 单源化口径）。
 * @param {string} username - 已鉴权身份（空串=匿名，无子模式覆盖）
 * @param {{chatId?: string|null, charName?: string|null}} [ctx] - per-chat 上下文（P3 参数分母 2026-07-13：
 *   桥线 getRuntimeParams 注入 → 分母走线级模式精确解析；缺省=旧 best-effort，零回归）
 * @returns {object} merged
 */
export function buildRuntimeParamsView(username, { chatId = null, charName = null } = {}) {
  const _st = getStore(username);
  const presetBase = { ..._st.engine.modelParams };
  const merged = { ..._st.runtimeParams };
  // 空窗兜底单源=PARAM_SCHEMA（presetBase 经引擎 extractModelParams 必有值，?? 仅零预设空窗生效）
  if (merged.temperature < 0) merged._effective_temperature = presetBase.temperature ?? paramDefault("temperature");
  else merged._effective_temperature = merged.temperature;
  if (merged.top_p < 0) merged._effective_top_p = presetBase.top_p ?? paramDefault("top_p");
  else merged._effective_top_p = merged.top_p;
  if (merged.top_k < 0) merged._effective_top_k = presetBase.top_k ?? paramDefault("top_k");
  else merged._effective_top_k = merged.top_k;
  if (merged.min_p < 0) merged._effective_min_p = presetBase.min_p ?? paramDefault("min_p");
  else merged._effective_min_p = merged.min_p;
  if (merged.frequency_penalty == null) merged._effective_frequency_penalty = presetBase.frequency_penalty ?? paramDefault("frequency_penalty");
  else merged._effective_frequency_penalty = merged.frequency_penalty;
  if (merged.presence_penalty == null) merged._effective_presence_penalty = presetBase.presence_penalty ?? paramDefault("presence_penalty");
  else merged._effective_presence_penalty = merged.presence_penalty;
  // ★ 单源收口（2026-07-13）：委托 resolveEffectiveMaxContextLive——原内联三层是第二份实现，与
  //   getPromptHandler 分母层各自漂移。
  // [P3 参数分母] 带 ctx 时按线级模式精确解析（modeGroup=getActiveMode(cid) 派生，与生成链同源），
  //   与 fake-send code_token_status.limit 同函数同参=前端无需读侧覆盖；无 ctx=旧 best-effort（零回归）。
  let _rpModeGroup = null;
  if (chatId) {
    try {
      const _rpMode = getActiveMode(username || "_default", charName || "_global", chatId);
      _rpModeGroup = (_rpMode === "code" || _rpMode === "work") ? _rpMode : null;
    } catch { /* 无模式上下文=best-effort */ }
  }
  merged._effective_max_context = resolveEffectiveMaxContextLive(username, _rpModeGroup, chatId, null, charName);
  // 缺省兜底单源=PARAM_SCHEMA（与引擎 extractModelParams 同表）——presetBase.max_tokens
  // 经引擎必有值，此兜底仅零预设空窗生效；原 4096 与引擎 2048 跨层分叉（2026-07-07 写入链消歧收口）
  if (merged.openai_max_tokens <= 0) merged._effective_max_tokens = presetBase.max_tokens ?? paramDefault("max_tokens");
  else merged._effective_max_tokens = merged.openai_max_tokens;
  return merged;
}

/**
 * A2 过桥重构（07-03）：运行时参数写入纯函数——原 POST /config/runtime-params handler 内联逻辑逐字抽出
 * （req.body→body、_getUserByReq(req)→username 参数，其余零改动）。REST 薄壳与桥线 setRuntimeParams 共用单源。
 * @param {object} body
 * @param {string} username - 调用方已鉴权身份（REST=getUserByReq / 桥=context.user 盖章）
 * @returns {Promise<object>} {success, params}
 */
export async function applyRuntimeParams(body, username) {
  // [T065 per-user] runtime 参数下沉到该 user store（原全局单例改踩任意用户）
  const rp = getStore(username).runtimeParams;
  if (body) {
    if (body.context_msg_limit !== undefined) {
      rp.context_msg_limit =
        parseInt(body.context_msg_limit, 10) || 0;
    }
    if (body.stream !== undefined) {
      rp.stream = !!body.stream;
    }
    if (body.prompt_post_processing !== undefined) {
      // 2026-07-08 凛倾:「后处理是后处理,预填充是预填充…提示词后处理只有3个模式,合并,严格,半严格」
      // ——旧枚举混入 "claude"（预填充概念泄漏进 pp）和 "single"（全并单条 user=效力全失），
      // 写入层迁移收口：claude→merge（ST 分发表同义）、single→strict；存量随前端下次推送自愈。
      const _ppMigrate = { claude: "merge", single: "strict" };
      const _ppIn = _ppMigrate[body.prompt_post_processing] || body.prompt_post_processing;
      const valid = ["none", "merge", "semi", "strict"];
      rp.prompt_post_processing = valid.includes(_ppIn) ? _ppIn : "none";
    }
    if (body.prefill_enabled !== undefined) {
      rp.prefill_enabled = !!body.prefill_enabled;
    }
    if (body.claude_prefill_mode !== undefined) {
      // 枚举迁移收口（2026-07-07 写入链修复）：UI（featureControls.mjs:294 带同款迁移表）与消费端
      // （providerPatch.mjs:160-171）早已迁到新三态 off/prefill/claude，此白名单曾滞留旧四态
      // keep/wrap_system/append_user——UI 发 prefill/claude（含默认值 claude）被吞成 "off"，
      // 右栏全局路径的 Claude 预填充静默失效。写入层与前端同表迁移旧存量值，校验按新枚举。
      // 2026-07-08 四模式定稿+正名（凛倾:四模式原话+「什么又叫做claude模式?互联网上有这个名词吗?」
      // ——"claude"是自造名词，正名 to_user）：off / prefill(尾部assistant原样=旧keep语义) /
      // to_user(直接改user，旧名claude/wrap_system/append_user归此) / user_assistant(改user+尾部assistant:引导)。
      const _prefillMigrate = { wrap_system: "to_user", append_user: "to_user", keep: "prefill", claude: "to_user" };
      const validModes = ["off", "prefill", "to_user", "user_assistant"];
      let mode = String(body.claude_prefill_mode);
      mode = _prefillMigrate[mode] || mode;
      rp.claude_prefill_mode = validModes.includes(mode)
        ? mode
        : "off";
    }
    // 兼容旧版 claude_prefill_enabled 布尔值（true 原落旧枚举 "keep"，消费端把未知值当 prefill 同义——
    // 枚举收口后直接落 "prefill"，语义不变、不再生产旧枚举值）
    if (
      body.claude_prefill_enabled !== undefined &&
      body.claude_prefill_mode === undefined
    ) {
      rp.claude_prefill_mode = body
        .claude_prefill_enabled
        ? "prefill"
        : "off";
    }
    // continue_prefill 写入分支已删（2026-07-08）：beilu 无 continue 生成功能，该键全链零消费死键。
    // ---- 模型/API源覆盖（子模式切换/对话AI设置传入） ----
    // N37（分派单刀2）：model/api_source 是原子覆盖单元，按 user/char 作用域存
    // `model_overrides_by_char["<user>/<char>"]`——原全局扁平字段会踩任何角色的绑定源模型。
    // 前端不传 charName（旧调用方）→ 落 "" 全局键并同步旧扁平字段=行为与改前完全一致（零回归）。
    if (body.model !== undefined || body.api_source !== undefined) {
      const _rpUser = username || "";
      const _rpChar = typeof body.charName === "string" ? body.charName : "";
      if (!rp.model_overrides_by_char || typeof rp.model_overrides_by_char !== "object")
        rp.model_overrides_by_char = {};
      const _rpKey = `${_rpUser}/${_rpChar}`;
      const _rpSlot = rp.model_overrides_by_char[_rpKey] || (rp.model_overrides_by_char[_rpKey] = {});
      if (body.model !== undefined) _rpSlot.model = String(body.model) || "";
      if (body.api_source !== undefined) _rpSlot.api_source = String(body.api_source) || "";
      if (!_rpChar) {
        // 全局键同步旧扁平字段（向后兼容读端兜底）
        if (body.model !== undefined) rp.model = String(body.model) || "";
        if (body.api_source !== undefined) rp.api_source = String(body.api_source) || "";
      }
    }
    // ---- 模型参数 ----
    if (body.openai_max_context !== undefined) {
      rp.openai_max_context = parseInt(body.openai_max_context, 10) || 0;
    }
    if (body.openai_max_tokens !== undefined) {
      rp.openai_max_tokens = parseInt(body.openai_max_tokens, 10) || 0;
    }
    if (body.temperature !== undefined) {
      rp.temperature = parseFloat(body.temperature);
      if (isNaN(rp.temperature)) rp.temperature = -1;
    }
    if (body.top_p !== undefined) {
      rp.top_p = parseFloat(body.top_p);
      if (isNaN(rp.top_p)) rp.top_p = -1;
    }
    if (body.top_k !== undefined) {
      rp.top_k = parseFloat(body.top_k);
      if (isNaN(rp.top_k)) rp.top_k = -1;
    }
    if (body.frequency_penalty !== undefined) {
      rp.frequency_penalty = parseFloat(body.frequency_penalty);
      if (isNaN(rp.frequency_penalty)) rp.frequency_penalty = null;
    }
    if (body.presence_penalty !== undefined) {
      rp.presence_penalty = parseFloat(body.presence_penalty);
      if (isNaN(rp.presence_penalty)) rp.presence_penalty = null;
    }
    if (body.min_p !== undefined) {
      rp.min_p = parseFloat(body.min_p);
      if (isNaN(rp.min_p)) rp.min_p = -1;
    }
    // thinking 六口·口2：extended_thinking null=解除覆盖回预设值，其余强制 boolean；budget 非法值落 0=解除覆盖
    if (body.extended_thinking !== undefined) {
      rp.extended_thinking = body.extended_thinking === null ? null : !!body.extended_thinking;
    }
    if (body.thinking_budget !== undefined) {
      rp.thinking_budget = parseInt(body.thinking_budget, 10) || 0;
    }
    // 持久化
    saveRuntimeParams(username);
    // 广播 runtime_params_changed → YonBan 面板实时同步（同 preset_changed pattern）
    const _bcastUser = username || undefined;
    { const _r = await dispatch({ target: "bus:broadcast", verb: "emitAll", source: "yonban", payload: { username: _bcastUser, event: { type: "runtime_params_changed", payload: { params: { ...rp } } } } }); if (!_r?.ok) console.warn("[beilu-preset] runtime_params_changed broadcast failed:", _r?.error?.msg); } // [0716 T3对接首批]
  }
  return { success: true, params: { ...rp } };
}

/**
 * runtimeParamsSnapshot 两步装配·第 1 步（设计② §3.4，凛倾 07-03"4个模式做好隔离"）：
 * 生成入口（requestBuilder.getChatRequest）调本函数拍冻结快照挂 request.extension.runtime_params_snapshot，
 * 在途生成不再受并发窗口 POST runtime-params 改全局单例污染（T4 靶点② temp=1.7 跨窗族根修）。
 * model_overrides_by_char 深拷——applyRuntimeParams 会原地改该嵌套 Map（:625-628），浅拷会被穿透。
 * @returns {Readonly<object>} 冻结快照（消费端=TweakPrompt Round2 的 rt 视图）
 */
export function snapshotRuntimeParams(username) {
  const snap = { ...getStore(username).runtimeParams };
  if (snap.model_overrides_by_char && typeof snap.model_overrides_by_char === "object")
    snap.model_overrides_by_char = structuredClone(snap.model_overrides_by_char);
  return Object.freeze(snap);
}

/**
 * runtimeParamsSnapshot 两步装配·第 2 步（设计② §3.4）：出站模型参数合并纯函数——
 * 原 TweakPrompt Round2 内联块（预设 base + runtime 覆盖 + 子模式覆盖三层）逐字抽出，
 * runtimeParams 全局读改为 rt 参数（快照优先），其余零改动。
 * 哨兵值（使用预设默认）：temperature/top_p/top_k/min_p 用 <0；max_context/max_tokens 用 <=0；penalty 用 null（其合法范围含负值，不能复用数值哨兵）。
 * @param {object} presetModelParams - 当前引擎预设 base（eng.modelParams）
 * @param {object} rt - runtime 参数视图（arg.extension.runtime_params_snapshot 快照，缺失回退活全局）
 * @param {object|undefined} smExt - beilu-memory 因子模式 ext（prompt_struct.plugin_prompts["beilu-memory"].extension，每轮都有，不依赖 runtime-params）
 * @param {string} scopedKey - `${username}/${char_id}` 精确覆盖键（N37 分派单刀2）
 * @returns {object} beilu_model_params（供 Gemini/Proxy StructCall 读取）
 */
export function mergeRuntimeParams(presetModelParams, rt, smExt, scopedKey) {
  const _mergedModelParams = { ...presetModelParams };
  if (rt.temperature >= 0) _mergedModelParams.temperature = rt.temperature;
  if (rt.top_p >= 0) _mergedModelParams.top_p = rt.top_p;
  if (rt.top_k >= 0) _mergedModelParams.top_k = rt.top_k;
  if (rt.min_p >= 0) _mergedModelParams.min_p = rt.min_p;
  if (rt.frequency_penalty != null) _mergedModelParams.frequency_penalty = rt.frequency_penalty;
  if (rt.presence_penalty != null) _mergedModelParams.presence_penalty = rt.presence_penalty;
  if (rt.openai_max_context > 0) { _mergedModelParams.openai_max_context = rt.openai_max_context; _mergedModelParams.max_context = rt.openai_max_context; } // B10: 镜像 max_context（proxy 读此键，runtime 覆盖同步生效）
  if (rt.openai_max_tokens > 0) _mergedModelParams.max_tokens = rt.openai_max_tokens;
  // thinking 六口·口2：null=用预设值（boolean 域禁 -1 哨兵）；budget 0=用预设值
  if (rt.extended_thinking != null) _mergedModelParams.extended_thinking = !!rt.extended_thinking;
  if (rt.thinking_budget > 0) _mergedModelParams.thinking_budget = rt.thinking_budget;
  return {
    ..._mergedModelParams,
    stream: rt.stream,
    prompt_post_processing: rt.prompt_post_processing,
    prefill_enabled: rt.prefill_enabled,
    // ★ 子模式覆盖（从beilu-memory extension读取，每轮都有，不依赖runtime-params）
    ...((() => {
      const _smExt = smExt;
      // N37（分派单刀2）：runtime 模型/源覆盖按 user/char 取——精确键存在即整组生效
      // （含显式空=该角色解除覆盖），miss 才回退旧扁平全局值（向后兼容）。
      const _rpScoped = (() => {
        const _m = rt.model_overrides_by_char;
        if (!_m || typeof _m !== "object") return null;
        return Object.prototype.hasOwnProperty.call(_m, scopedKey) ? (_m[scopedKey] || {}) : null;
      })();
      const _rtModel = _rpScoped ? (_rpScoped.model || "") : (rt.model || "");
      const _rtApi = _rpScoped ? (_rpScoped.api_source || "") : (rt.api_source || "");
      const _smModel = _smExt?.sub_mode_model || _rtModel || "";
      const _smApi = _smExt?.sub_mode_api_source || _rtApi || "";
      // ★ claude_prefill_mode: 子模式配置优先 → runtime-params 回退
      const _smPrefill = _smExt?.sub_mode_claude_prefill || rt.claude_prefill_mode || "";
      const _smMaxCtx = _smExt?.sub_mode_max_context;
      const _smMaxTok = _smExt?.sub_mode_max_tokens;
      const _smTemp = _smExt?.sub_mode_temperature;
      const _smTopP = _smExt?.sub_mode_top_p; // T001：与 temperature 同构（上游 getPromptHandler:2183 区输出）
      const _smTopK = _smExt?.sub_mode_top_k; // 链路2扩展（2026-07-10）：同 top_p 通路
      const _smMinP = _smExt?.sub_mode_min_p; // 链路2扩展：同 top_p 通路
      const _smPP = _smExt?.sub_mode_post_process;
      // 确诊-B（prefill 每轮读收口）：子模式 prefill_enabled 覆盖 runtime 基线（:762 rt.prefill_enabled）。
      //   boolean 且 false 有效 → 用 !== undefined 判定（同 _smTemp），使编辑活跃子模式 prefill 当轮生效。
      const _smPrefillEnabled = _smExt?.sub_mode_prefill_enabled;
      // thinking 六口·口3/口4：boolean undefined=无覆盖（同 prefill_enabled）；budget 生产端 0 已折 undefined
      const _smExtThinking = _smExt?.sub_mode_extended_thinking;
      const _smThinkBudget = _smExt?.sub_mode_thinking_budget;
      return {
        ...(_smModel ? { model_override: _smModel } : {}),
        ...(_smApi ? { api_source_override: _smApi } : {}),
        claude_prefill_mode: _smPrefill || undefined,
        ...(_smMaxCtx ? { max_context: _smMaxCtx } : {}),
        ...(_smMaxTok ? { max_tokens: _smMaxTok } : {}),
        ...(_smTemp !== undefined ? { temperature: _smTemp } : {}),
        ...(_smTopP !== undefined ? { top_p: _smTopP } : {}), // T001：子模式 top_p 覆盖
        ...(_smTopK !== undefined ? { top_k: _smTopK } : {}), // 链路2扩展：子模式 top_k 覆盖（runtime 键 RUNTIME_PARAMS_DEFAULTS 既有）
        ...(_smMinP !== undefined ? { min_p: _smMinP } : {}), // 链路2扩展：子模式 min_p 覆盖
        ...(_smPP ? { prompt_post_processing: _smPP } : {}),
        ...(_smPrefillEnabled !== undefined ? { prefill_enabled: !!_smPrefillEnabled } : {}), // 确诊-B：子模式覆盖 runtime prefill_enabled
        ...(_smExtThinking !== undefined ? { extended_thinking: !!_smExtThinking } : {}), // thinking 六口·口3/口4：子模式/流程组覆盖
        ...(_smThinkBudget ? { thinking_budget: _smThinkBudget } : {}),
      };
    })()),
  };
}


// [T065 per-user] 原 module 级 `let configData` 单例已下沉到 perUserStore（getStore(username).configData）。
//   数据结构不变：{ active_preset, active_preset_map, presets: {name: {preset_json, model_params, macro_variables, description}} }。

// ============================================================
// 预设切换 → 正则联动（B1 re-sync）
// 设计：预设绑定正则。切换激活预设时，把新预设 extensions.regex_scripts
//   经 beilu-regex 的 syncPresetRegex action 同步进全局正则库。
// 插件间通信范式与 presetBridge.switchPresetViaAPI 一致：动态 import 对方
//   main.mjs 的 interfaces.config.SetData，直接函数调用（非 HTTP，后端无 port 依赖）。
// 来源隔离：syncPresetRegex 只清/导 scope==='preset' && boundPresetName===该预设名 的条目，
//   用户手建的 global/scoped 规则、以及其他预设的规则一律不动（beilu-regex 内已实现）。
// per-chat 语义：正则匹配按每次请求实际渲染 prompt 携带的 preset_name 过滤（per-chat aware），
//   库为全局累积。全局切换与 per-chat 切换都只刷新「目标预设自己」在库里的副本，
//   不跨预设污染、不影响其他窗口 → 两路径调用同一 helper，语义安全一致。
// ============================================================
// [yonban T3d] beilu-regex 未迁本组（属 regex 组，T3a·3.4 已迁走但旧位留壳）；此处沿用旧位路径经壳解析。
//   新位 preset/ 上 5 级到 src + public/parts/plugins/beilu-regex/main.mjs（原 ../beilu-regex 从 plugins/beilu-preset 出发）。
const __regexMainUrl = new URL("../../../../../public/parts/plugins/beilu-regex/main.mjs", import.meta.url).href;
// [0719 正则错桶修·凛倾「预设连带的正则也导入不了」确诊] username 必传穿透：本函数是
//   in-process 旁路（动态 import 直调 regex SetData），绕过桥 session 的 username 盖章——
//   原不传第二参 args → regex/main.mjs:742 `_normUser(args?.username)` 回退 "_default" 桶，
//   而用户的生成/显示/库全读自己的桶（盘上物证：_default 桶 preset 规则 0 条、002 桶 8 条陈旧）
//   = 预设连带正则写进没人读的桶，永不生效。调用点全在 SetData 上下文（username 在握），穿透即根治。
async function _resyncPresetRegex(presetName, presetJson, username) {
  try {
    if (!presetName) return;
    const scripts = presetJson?.extensions?.regex_scripts;
    // scripts 为空数组时仍调用：syncPresetRegex 会清掉该预设上次同步进库的旧规则
    //   （预设绑定语义=预设若不再含正则，其旧规则随之失效），不动其他来源。
    const mod = await import(__regexMainUrl);
    const exp = mod?.default || mod;
    const setData = exp?.interfaces?.config?.SetData;
    if (typeof setData !== "function") {
      console.warn("[beilu-preset] re-sync 正则: beilu-regex SetData 不可用，跳过");
      return;
    }
    const r = await setData({
      _action: "syncPresetRegex",
      presetName,
      scripts: Array.isArray(scripts) ? scripts : [],
    }, { username });
    const res = r?._result || r || {};
    console.log(
      `[beilu-preset] 预设 "${presetName}" 正则已 re-sync: 移除 ${res.removed || 0} 条, 导入 ${res.imported || 0} 条`,
    );
  } catch (err) {
    // 静默降级：正则联动失败不影响预设切换主逻辑
    console.warn(`[beilu-preset] re-sync 正则失败 "${presetName}":`, err?.message || err);
  }
}

// 预设删除/重命名时清掉该预设同步进库的正则（只清来源=预设同步的条目，行为可逆=重切预设会重新同步）
// [0719 正则错桶修] username 穿透，同 _resyncPresetRegex（同型病：不传 args → _default 桶）
async function _removePresetRegex(presetName, username) {
  try {
    if (!presetName) return;
    const mod = await import(__regexMainUrl);
    const exp = mod?.default || mod;
    const setData = exp?.interfaces?.config?.SetData;
    if (typeof setData !== "function") return;
    const r = await setData({ _action: "removeByPreset", presetName }, { username });
    const res = r?._result || r || {};
    console.log(`[beilu-preset] 预设 "${presetName}" 正则已清理: 移除 ${res.removed || 0} 条`);
  } catch (err) {
    console.warn(`[beilu-preset] 清理正则失败 "${presetName}":`, err?.message || err);
  }
}

// ============================================================
// per-chatId 预设解析（多窗口全隔离·蓝图阶段0/1）
// 读路径不再依赖"switch 时 reload 单例"：每轮按 config.json 的
// active_preset_map[chatId]（回退全局 active_preset）解析本次该用的预设，
// 从 engineCache 取对应只读引擎。写路径（switch_preset/presetBridge）只写 config。
// ============================================================

// [T065 per-user] _engineCache/_macroMemCache/_globalCfgCache 下沉到 perUserStore（每 user 一份），
//   下方 getEngineFor/getMacroMemFor/_loadGlobalCfgFresh/resolveActivePresetName 全部按 username 取桶。

/**
 * 从请求参数中提取 chatId，用于 per-chatId 预设隔离。
 * chatid 直取；chat_name 去掉 "common_chat_" 前缀转化为 chatId。
 * @param {object} arg - chatReplyRequest_t
 * @returns {string|null} chatId 或 null（无法解析时回退全局）
 */
function _resolveCid(arg) {
  return arg?.chatid || (arg?.chat_name ? String(arg.chat_name).replace("common_chat_", "") : null);
}

/** 从 arg（chatReplyRequest_t）提取 username（主链盖章 arg.username），回退 _default 桶 */
function _resolveUser(arg) {
  return _normUser(arg?.username);
}

/** 读某 user 盘上 config（mtime 缓存），盘=active_preset/active_preset_map 单一权威 */
function _loadGlobalCfgFresh(username) {
  const st = getStore(username);
  const gcf = globalConfigFileOf(username);
  try {
    const stat = fs.statSync(gcf);
    if (st.globalCfgCache.data && stat.mtimeMs === st.globalCfgCache.mtime) return st.globalCfgCache.data;
    const data = JSON.parse(fs.readFileSync(gcf, "utf-8"));
    st.globalCfgCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (e) {
    if (fs.existsSync(gcf)) console.warn("[preset] 全局 config 读盘/解析失败，回退内存态:", e?.message || e); // 文件不存在属正常首启，不刷屏
    return { active_preset: st.configData.active_preset, active_preset_map: st.configData.active_preset_map || {} };
  }
}

/**
 * 解析某 user 某 chatId 本轮该用的预设名（四级回退）。
 * code 和 work 共享同一个 chatId，只用 chatId 做 key 会互相覆盖。
 * 优先级：map[chatId:mode] → map[chatId]（向后兼容旧数据）→ 该 user active_preset → 内存兜底。
 *
 * @param {string} username
 * @param {string|null} cid - chatId，null 时跳过 per-chat 查找
 * @param {string|null} [mode] - 当前模式(code/work/chat)，null 时跳过 mode-qualified 查找
 * @returns {string} 预设名称
 */
// [隔离架构 2026-07-24] 解析升级为带来源层级的单源实现（resolveActivePresetName 成为薄壳）。
// 【why】凛倾 0724 定案（底部功能层.txt 隔离三层）：显示/消费端必须能区分「线级真有记录」和
//   「回退到全局默认凑的值」——原先三个显示字段（active_preset_resolved/by_mode/using_preset）
//   都只下发回退后的最终字符串，全局槽一被污染（导入夺槽/删除换选）所有无记录的格子齐变且前端
//   无从分辨（0724 四格全变实证）。source 值域：exact=[cid:mode] 精确键 / bare=[cid] 裸键（旧数据
//   跨模式共享槽）/ global=用户级默认（active_preset）/ none=全无。
// 【功能链】GetData active_preset_by_mode(_src) → 前端四格诚实渲染；生成链仍消费 .name（语义不变）。
function resolveActivePresetWithSource(username, cid, mode) {
  const st = getStore(username);
  const configData = st.configData;
  const cfg = _loadGlobalCfgFresh(username);
  const map = cfg.active_preset_map || {};
  if (cid && mode && map[cid + ":" + mode] && configData.presets[map[cid + ":" + mode]]) return { name: map[cid + ":" + mode], source: "exact" };
  if (cid && map[cid] && configData.presets[map[cid]]) return { name: map[cid], source: "bare" };
  // [隔离架构 2026-07-25 · 凛倾「work和code只可以使用子模式的预设,为什么会出现其他的」]
  //   code/work 无线级记录时回退到【当前生效子模式的默认预设】（resolveActiveSubModeId 与
  //   getSubModes 下发同函数解析）——原直接落 user 级槽 = 回退错层：code/work 的在用预设
  //   语义上只能来自"人/AI 切过的线级记录"或"当前子模式默认"，user 级槽值(如删除换选残值)
  //   出现在 code/work 格/生成里=违反子模式预设域(0725 截图实证"框架审查员"漏进 work 格)。
  if (cid && (mode === "code" || mode === "work")) {
    try {
      const _smCfg = loadJsonFileIfExists(getYonbanConfigPath(username), { sub_modes: [] });
      const _smId = resolveActiveSubModeId(_smCfg, mode, cid);
      const _smPreset = (_smCfg.sub_modes || []).find((m) => m.id === _smId)?.presetName;
      if (_smPreset && configData.presets[_smPreset]) return { name: _smPreset, source: "submode" };
    } catch { /* 子模式配置不可读=诚实落下一层，不拿猜测值凑 */ }
  }
  // [0725 凛倾「没有全局,马上删除」] 原第三/四级回退(cfg.active_preset/内存 active_preset)整体摘除——
  //   线级记录是唯一"在用"储存,code/work 无记录=子模式预设(上方),chat/smart 无记录=none(诚实空,
  //   首次切换才建记录)。active_preset 字段全面退役:不再读(此处)不再写(saveConfigToDisk 停写)。
  return { name: "", source: "none" };
}

function resolveActivePresetName(username, cid, mode) {
  return resolveActivePresetWithSource(username, cid, mode).name;
}

/**
 * [T1 激活层·裁决7] buildPresetContext —— 激活入口备料门面。
 * 【功能链】requestBuilder.getChatRequest 激活备料（extension.activation.preset_name）→
 *   GetPrompt/TweakPrompt 三轮消费同一冻结值（不再每轮重解析，防组装中途并发切预设撕裂三轮）。
 * 【why 门面】三层激活架构_设计 01 §五「beilu-preset 暴露 buildPresetContext，
 *   resolveActivePresetName/getEngineFor 仍私有」——复用不重写，引擎实例不外泄，
 *   消费端持 preset_name 经本库钩子在库内取实例。scopeResolver.mjs TODO(T3d) 同此门面接入。
 * @param {string} username
 * @param {string|null} chatId
 * @param {string|null} mode
 * @returns {{presetName: string|null}}
 */
export function buildPresetContext(username, chatId, mode) {
  return { presetName: resolveActivePresetName(username, chatId, mode) || null };
}

/**
 * [0717 预设三症·R1 模式桶归位] charName 缺省时按 chat 元数据 primaryCharName 归位。
 * 【why】active_modes_map 是 per-char 桶（char/_config.json 与 _global/_config.json 各一份），
 *   带 chatid 但不带 charName 的调用方（getCharId 初始化竞态返空 / YonBan / AI 链）落 "_global" 桶
 *   解析模式 → 与生成链（charName 正确）解析出不同 mode → active_preset_map 写键 [cid:modeA]
 *   读键 [cid:modeB] 错位（盘上实证：vsi2z4bs8e 在 _global=code / 代码001=work，:code 与 :work
 *   双键都被写入 PPT制作=跨模式污染源）。
 * 【收口】解析实现=memory 域 _resolveRequestChar 单源（setDataActions.mjs:621，0714 收口函数，
 *   禁内联复制）；动态 import 防 preset→setDataActions 静态环（presetBridge 反向动态引本文件）。
 * 显式 charName 恒优先；无 chatid 或解析失败回落 "_global"（与旧行为一致=诚实降级）。
 * @param {string|undefined|null} charName
 * @param {string|undefined|null} chatid
 * @returns {Promise<string>} 归位后的 charName（兜底 "_global"）
 */
async function _resolveCharForMode(charName, chatid) {
  if (charName) return charName;
  if (!chatid) return "_global";
  try {
    const { _resolveRequestChar } = await import("../../memory/handler/setDataActions.mjs");
    return await _resolveRequestChar({ chatid }, null, "_global");
  } catch (e) {
    console.warn(`[beilu-preset] charName 归位失败(回落 _global 桶): ${e?.message || e}`);
    return "_global";
  }
}

/**
 * 取某 user 某预设名对应的 PresetEngine 实例。
 * 该 user 激活且已载入主引擎时复用其主引擎（含 UI 未保存的编辑态），否则从该 user engineCache 懒加载。
 * 缓存由 invalidateEngineCaches(username) 统一失效（预设内容变更后调用）。
 *
 * @param {string} username
 * @param {string} name - 预设名称
 * @returns {PresetEngine|null} 引擎实例，预设不存在或无 preset_json 时返回 null
 */
function getEngineFor(username, name) {
  const st = getStore(username);
  if (!name || !st.configData.presets[name]?.preset_json) return null;
  if (st.engine.isLoaded() && st.engine.presetName === name) return st.engine;
  return _getCachedEngine(st, name);
}

/**
 * [T2 去常驻·生成路径专用] 与 getEngineFor 的唯一差别：永不返回 st.engine（UI 编辑路径的
 * 可变主引擎单槽）——激活线拿到的恒为 engineCache 盘态只读实例。
 * 【why】设计 01 §四拍板「引擎实例=按 presetName 取（缓存实例只读引用，不改全局）」：
 *   原生成路径命中激活预设名时与 UI 共享同一可变实例，编辑中途（engine.load 换装/updateModelParams）
 *   被在途生成读到=撕裂。所有编辑路径均即时 _tpSync 落盘（configData+savePresetFile），
 *   缓存路径有文件级 mtime 失效（_getCachedEngine）——盘态=已保存最新态，无"未保存编辑丢失"问题
 *   （getEngineFor 头注释的「UI 未保存的编辑态」表述已腐烂：全部 SetData 变更路径都 await _tpSync）。
 * 消费方：GetPrompt/TweakPrompt 生成读点；UI 读写路径（GetData/SetData _tpEng）仍走 getEngineFor。
 */
function getEngineForActivation(username, name) {
  const st = getStore(username);
  if (!name || !st.configData.presets[name]?.preset_json) return null;
  return _getCachedEngine(st, name);
}

/** engineCache 懒加载 + 文件级失效（getEngineFor / getEngineForActivation 共用实现体） */
function _getCachedEngine(st, name) {
  const configData = st.configData;
  // 【文件级失效】命中 engineCache 前，对该预设源文件 statSync：mtime 与条目记录不同 →
  //   直写盘上单预设内容（未变更 registry 全量指纹） → 重读 json 刷 configData 条目 + engineCache.delete
  //   再走懒加载。与 store 级 registry mtime 失效互补：store 抓增删/注册变更，file 抓单预设内容改写。
  //   路径来源=loadConfigFromDisk 时同步记录的 _file_path（与其内部 join(dir, entry.file) 同源同构），
  //   不发明第二套路径拼接。
  const entry = configData.presets[name];
  try {
    const fp = entry._file_path;
    if (fp && fs.existsSync(fp)) {
      const curMt = fs.statSync(fp).mtimeMs || 0;
      if (curMt !== (entry._file_mtime || 0)) {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        entry.preset_json = data.preset_json || {};
        entry.model_params = data.model_params || {};
        entry.macro_variables = data.macro_variables || {};
        entry.description = data._meta?.description || entry.description || "";
        entry._file_mtime = curMt;
        st.engineCache.delete(name);
        st.macroMemCache.delete(name); // 宏变量也源于该文件，同步失效
      }
    }
  } catch (e) {
    console.warn(`[beilu-preset] getEngineFor 单文件失效检查失败 "${name}"(沿用旧缓存):`, e?.message);
  }
  let eng = st.engineCache.get(name);
  if (!eng) {
    eng = new PresetEngine();
    eng.load(configData.presets[name].preset_json, name);
    const mp = configData.presets[name].model_params;
    if (mp && Object.keys(mp).length > 0) eng.updateModelParams(mp);
    st.engineCache.set(name, eng);
  }
  return eng;
}

/**
 * 取某 user 某预设名对应的宏记忆（memory 对象含 variables/timers 等供 evaluateMacros 消费）。
 * 该 user 主引擎预设复用其全局 macroMemory（保持旧行为+含 UI 编辑态），其他预设从该 user macroMemCache 懒加载。
 *
 * @param {string} username
 * @param {string} name - 预设名称
 * @returns {object} 宏记忆对象（buildDefaultMemory 结构 + variables）
 */
function getMacroMemFor(username, name) {
  const st = getStore(username);
  if (st.engine.isLoaded() && st.engine.presetName === name) return st.macroMemory;
  let mem = st.macroMemCache.get(name);
  if (!mem) {
    mem = buildDefaultMemory();
    mem.variables = { ...(st.configData.presets[name]?.macro_variables || {}) };
    st.macroMemCache.set(name, mem);
  }
  return mem;
}

/** 某 user 预设内容变更后失效其缓存（单点失效，重建成本=内存 JSON 解析，低） */
function invalidateEngineCaches(username) {
  const st = getStore(username);
  st.engineCache.clear();
  st.macroMemCache.clear();
}

// ============================================================
// beilu-preset 插件
// ============================================================

/**
 * beilu-preset — 预设管理引擎
 *
 * 职责：
 * - 兼容 ST 预设格式（prompts[] + prompt_order[]）
 * - 双层排序：系统级 prompt_order → GetPrompt; 注入式 injection_depth → TweakPrompt
 * - 宏替换（复用 beilu ST 宏引擎 marco.mjs）
 * - 管理条目启用/禁用状态（供 beilu-toggle 操控）
 * - 提供预设数据给 UI 面板展示
 *
 * @returns {import('../../../../../decl/pluginAPI.ts').PluginAPI_t}
 */
const pluginExport = {
  info,

  // --------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------

  Load: async ({ router }) => {
    console.log("[beilu-preset] 插件加载中...");

    // [T065 per-user] 不再进程启动时预载全局单例——预设内容池已 per-user，
    //   各 user 的 store 在其首次 GetData/GetPrompt/SetData（getStore(username)）时惰性载入（含惰性播种）。
    //   进程启动零磁盘读，用户登录后首次访问自然按其身份分桶加载。

    // 获取认证模块（前置声明，供下方 handler 在请求期取 username）
    let _getUserByReq;
    try {
      const authMod = await import("../../security/auth.mjs");
      _getUserByReq = authMod.getUserByReq;
    } catch (_e) { /* fallback：匿名走 _default 桶 */ }

    // ---- 注册 HTTP API 端点 ----
    // 前端通过这些端点与插件通信，替代不可用的 shells:config 路径

    router.get(
      "/api/parts/plugins\\:beilu-preset/config/getdata",
      authenticate, // A2-3：补鉴权——杜绝匿名读预设配置
      async (req, res) => {
        try {
          let _u = "";
          if (_getUserByReq) try { _u = (await _getUserByReq(req)).username || ""; } catch { /* 匿名→_default 桶 */ }
          const data = await pluginExport.interfaces.config.GetData(req.query.preset, _u);
          res.json(data);
        } catch (err) {
          console.error("[beilu-preset] GetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    // ---- 提示词快照 API ----
    router.get(
      "/api/parts/plugins\\:beilu-preset/prompt-snapshot",
      async (_req, res) => {
        try {
          if (!lastPromptSnapshot) {
            res.json({
              available: false,
              message: "尚无快照，请先发送一条消息",
            });
          } else {
            res.json({ available: true, snapshot: lastPromptSnapshot });
          }
        } catch (err) {
          console.error("[beilu-preset] prompt-snapshot error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    // ---- 运行时参数 API（GET 读 / POST 写 + 持久化到 runtime_params.json） ----
    // A2 过桥重构（07-03）：合成/写入逻辑抽纯函数 buildRuntimeParamsView/applyRuntimeParams（见文件下方 export），
    //   REST 端点薄壳化保双线；桥线=functions:prompt get/setRuntimeParams verb 同实现单源。
    router.get(
      "/api/parts/plugins\\:beilu-preset/config/runtime-params",
      authenticate, // A2-3：补鉴权——杜绝匿名读运行时参数
      async (req, res) => {
        let _effUser = "";
        if (_getUserByReq) try { _effUser = (await _getUserByReq(req)).username || ""; } catch { /* 匿名→无子模式覆盖 */ }
        // [P3 参数分母 2026-07-13] REST 双线与桥线同形：query 带 chatid/charName 时 per-chat 精确分母
        res.json(buildRuntimeParamsView(_effUser, { chatId: req.query?.chatid || null, charName: req.query?.charName || null }));
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-preset/config/runtime-params",
      authenticate, // A2-3：补鉴权——杜绝匿名写运行时参数（模型/上下文/采样等）
      async (req, res) => {
        try {
          let _rpUser = "";
          if (_getUserByReq) try { _rpUser = (await _getUserByReq(req)).username || ""; } catch { /* 匿名落全局 */ }
          res.json(await applyRuntimeParams(req.body, _rpUser)); // A2 过桥重构：逻辑单源=applyRuntimeParams（桥线 setRuntimeParams 同源）
        } catch (err) {
          console.error("[beilu-preset] runtime-params error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-preset/config/setdata",
      authenticate, // A2-3：补鉴权——杜绝匿名写预设配置
      async (req, res) => {
        try {
          let _reqUsername;
          if (_getUserByReq) try { _reqUsername = (await _getUserByReq(req)).username; } catch { /* */ }
          const result = await pluginExport.interfaces.config.SetData(req.body, { username: _reqUsername });
          res.json(result);
        } catch (err) {
          console.error("[beilu-preset] SetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );
  },

  Unload: async () => {
    console.log("[beilu-preset] 插件卸载");
  },

  // --------------------------------------------------------
  // 接口
  // --------------------------------------------------------

  interfaces: {
    config: {
      /**
       * 获取插件配置数据
       * 返回预设信息、条目列表、模型参数等供 UI 和其他插件使用
       */
      // [T065 洞①修] username 参数：verb 层 context.user 盖章透传 / REST getdata handler getUserByReq。
      //   缺省（旧调用面/主链）→ _default 桶。GetData 是唯一曾断链的读接口（前端不传、主链 requestBuilder 也不传）。
      GetData: async (requestedPreset, username, chatid, charName) => {
        const st = getStore(username);
        const { engine, macroMemory, configData } = st;
        // 2026-07-09 收口审计：chatid（桥层统一注入）→ 下发 active_preset_resolved 权威解析值
        //   （resolveActivePresetName 精确键>裸键>全局，与生成链同源）。原前端 resolveActivePresetFor 只读
        //   裸键自行解析：同 cid 跨模式（code/work 共 chatId）时裸键停在别模式最后切的预设 → 选择器高亮/
        //   displayRegex 取错预设。mode 用后端 getActiveMode 解析，禁前端 localStorage 推值（断链根理同 :1287）。
        // [预设隔离 2026-07-11] charName（桥层同批注入）：线级 active_modes_map 存 per-char _config.json
        //   （storage.mjs setActiveMode:2161），原硬编码 "_global" 桶=选了角色时读写分桶，线级模式恒 miss
        //   → resolved 按 char 级旧模式解析 → 浮层高亮/下拉显示别模式的预设（显示层交叉病灶）。
        let active_preset_resolved;
        if (chatid) {
          try {
            // [0717 R1 归位] charName 缺省经 chat 元数据归位（与 switch_preset 写侧同源，显示=生成同键）
            const _gdMode = getActiveMode(username || "_default", await _resolveCharForMode(charName, chatid), chatid);
            active_preset_resolved = resolveActivePresetName(username, chatid, _gdMode) || "";
          } catch { /* 字段缺省，前端走旧裸键回退链 */ }
        }
        // [0717 预设三症·四格恢复] 本窗口四个模式各自的生效预设（后端算好单源下发，
        //   与生成读键 resolveActivePresetName 同函数同序=精确键>裸键>全局）——浮层四格显示消费。
        //   前端自行按 active_preset_map 镜像解析=第 2 份同构副本（0713 键收口同病），故收口在此。
        //   凛倾 0701「显示4个模式各绑定的是什么预设」/0706「4个模式就是现在前端的4个模式」。
        let active_preset_by_mode;
        let active_preset_by_mode_src;
        if (chatid) {
          try {
            active_preset_by_mode = {};
            active_preset_by_mode_src = {};
            for (const _m of ["chat", "smart", "code", "work"]) {
              // [隔离架构 2026-07-24] 同批下发来源层级（exact/bare/global/none）——前端四格按来源
              //   诚实渲染（global=「跟随全局默认」弱化显示），不再把回退值冒充该模式真值
              //   （0724 导入夺槽后四格齐变、删除换选后齐变"框架审查员"的显示病根）。
              const _r = resolveActivePresetWithSource(username, chatid, _m);
              active_preset_by_mode[_m] = _r.name || "";
              active_preset_by_mode_src[_m] = _r.source;
            }
          } catch { active_preset_by_mode = undefined; active_preset_by_mode_src = undefined; /* 字段缺省=前端四格显示退化为不渲染 */ }
        }
        // 构建预设描述映射
        const preset_descriptions = {};
        for (const [name, preset] of Object.entries(configData.presets)) {
          preset_descriptions[name] = preset.description || "";
        }

        // 预设 bucket 映射（分组权威单源=registry）：用户态 registry 优先，无 bucket 字段时回退
        //   旧全局 registry（builtin bucket 唯一落点——播种 seedBuiltinsForUser:358 不带 bucket 且存量
        //   用户已播不重播，读时合并回退即全覆盖，无需数据迁移）。前端分组显示消费此字段，
        //   替代名字关键词推断（分身_*/前端美化/大项目协调 名字不命中关键词被误归 chat 的病灶）。
        const preset_buckets = {};
        try {
          const _uReg = loadRegistry(username).presets || {};
          let _gReg = {};
          try { _gReg = JSON.parse(fs.readFileSync(join(LEGACY_GLOBAL_DIR, "registry.json"), "utf-8")).presets || {}; } catch { /* 全局 registry 不可读=只用用户态 */ }
          for (const name of Object.keys(configData.presets)) {
            const b = _uReg[name]?.bucket ?? _gReg[name]?.bucket;
            if (b) preset_buckets[name] = b;
          }
        } catch (e) { console.warn("[beilu-preset] 构建 preset_buckets 失败:", e.message); }

        // [隔离架构 2026-07-24 读同源] 未指名 requestedPreset 且带 chatid 且线解析≠全局主引擎
        //   → 默认展示【本窗口线的预设】（engineCache 盘态只读，与生成读点同函数解析）——原默认
        //   全局主引擎 = 线级世界里左栏条目/参数/顶栏展示别的预设（「我用001显示另一个」读侧病根）。
        //   线解析与全局主引擎同名时仍用主引擎（live 态，全局世界行为不变）；requestedPreset 恒优先。
        const _gdLineName = (!requestedPreset && chatid && active_preset_resolved && active_preset_resolved !== engine.presetName && configData.presets[active_preset_resolved]) ? active_preset_resolved : null;
        const _wantName = requestedPreset || _gdLineName;
        const _wantsOther = !!(_wantName && _wantName !== engine.presetName);
        // [0725 凛倾「没有全局」] 本窗口线解析=空(none)时给【诚实空引擎】——原默认主引擎:启动时
        //   主引擎从盘上退役字段装载残值,无记录窗口的左栏条目/参数/preset_name 全显示残值=全局漏出口。
        const _gdEmptyView = !requestedPreset && chatid && active_preset_resolved === "";
        const targetEngine = _wantsOther ? getEngineFor(username, _wantName) : (_gdEmptyView ? new PresetEngine() : engine);
        // [预设切换互斥 2026-07-13 读互斥] 原 `|| engine` 静默回退：请求的预设不存在时把主引擎
        //   内容当 requestedPreset 返回（读A给B）——前端选择器显示名A、列表却是B的条目，
        //   正是"导入预设长出别预设条目"的显示机制。错误必须可见：返回 error + 空内容，
        //   保留列表/激活名等全局字段供前端刷新选择器自愈。
        if (!targetEngine) {
          return {
            active_preset: "", // [0725 凛倾「没有全局」] 字段退役恒空下发(前端回退链吃不到启动残值)
            ...(active_preset_resolved !== undefined ? { active_preset_resolved } : {}),
            ...(active_preset_by_mode !== undefined ? { active_preset_by_mode } : {}),
            ...(active_preset_by_mode_src !== undefined ? { active_preset_by_mode_src } : {}),
            active_preset_map: { ...(_loadGlobalCfgFresh(username).active_preset_map || configData.active_preset_map || {}) },
            preset_list: Object.keys(configData.presets),
            preset_descriptions,
            preset_buckets,
            error: `预设 "${_wantName}" 不存在`,
            preset_name: _wantName,
            preset_loaded: false,
            entries: [],
            model_params: {},
            templates: {},
            regex_scripts: [],
            macro_variables: {},
            preset_json: null,
            commander_mode: true,
          };
        }
        const targetMacro = _wantsOther ? getMacroMemFor(username, _wantName) : (_gdEmptyView ? { variables: {} } : macroMemory);

        return {
          // 多预设管理
          active_preset: "", // [0725 凛倾「没有全局」] 字段退役恒空下发(前端回退链吃不到启动残值)
          // 后端权威解析的本窗口激活预设（带 chatid 请求才有；前端 resolveActivePresetFor 优先消费）
          ...(active_preset_resolved !== undefined ? { active_preset_resolved } : {}),
          // [0717 四格恢复] 本窗口四模式各自生效预设（浮层四格显示消费，生成链同函数解析）
          ...(active_preset_by_mode !== undefined ? { active_preset_by_mode } : {}),
          // [隔离架构 2026-07-24] 四格来源层级（exact/bare/global/none），前端据此诚实标注回退
          ...(active_preset_by_mode_src !== undefined ? { active_preset_by_mode_src } : {}),
          // per-chatId 预设映射（chatId → presetName），前端按当前窗口显示真实激活预设
          active_preset_map: { ...(_loadGlobalCfgFresh(username).active_preset_map || configData.active_preset_map || {}) },
          preset_list: Object.keys(configData.presets),
          builtin_presets: (() => { const reg = loadRegistry(username); return Object.entries(reg.presets || {}).filter(([, e]) => e?.source === "builtin" && e?.file && fs.existsSync(join(DEFAULTS_DIR, e.file))).map(([n]) => n); })(),
          preset_descriptions,
          // 预设分组 bucket（name→bucket，registry 单源；前端分组显示消费，无值的预设走前端关键词回退）
          preset_buckets,

          // 当前激活预设的信息
          preset_name: targetEngine.presetName,
          preset_loaded: targetEngine.isLoaded(),

          // 所有条目列表（供 UI 和 beilu-toggle 使用）
          entries: targetEngine.getAllEntries(),

          // 模型参数
          model_params: { ...targetEngine.modelParams },

          // 预设模板
          templates: { ...targetEngine.templates },

          // 正则脚本
          regex_scripts: targetEngine.getRegexScripts(),

          // 宏变量
          macro_variables: { ...targetMacro.variables },

          // 完整预设 JSON（用于导出）
          preset_json: targetEngine.toJSON(),

          // 司令员模式标记
          commander_mode: true,
        };
      },

      /**
       * 设置插件配置
       *
       * 支持的操作：
       * - import_preset: 导入新的 ST 预设 JSON（存入 presets，自动激活）
       * - switch_preset: 切换激活预设
       * - delete_preset: 删除指定预设
       * - rename_preset: 重命名预设
       * - toggle_entry: 切换条目启用/禁用
       * - batch_toggle: 批量切换
       * - update_entry: 修改条目内容或属性
       * - update_model_params: 修改模型参数
       * - update_macro_vars: 修改宏变量
       * - clear_preset: 清除当前预设（从列表中移除）
       */
      SetData: async (data, args) => {
        if (!data) return { success: true };

        // [T065 per-user] username 权威=args.username（verb setData:70 桥 session 盖章 / REST setdata getUserByReq）。
        //   缺省→_default 桶。下方全程按此 user 取 store，写读都落该用户的 presets 目录。
        const username = _normUser(args?.username || data?.username);
        const st = getStore(username);
        const { engine, macroMemory, configData } = st;

        // 导出预设为 SillyTavern 格式（走 exportSTPreset 校正，往返一致）
        // 只读操作：不改 configData、不落盘，早返回校正后的 ST JSON 字符串
        if (data.export_st_preset) {
          const reqName = data.export_st_preset.name;
          const targetName = reqName || configData.active_preset;
          if (!targetName) {
            return { success: false, error: "没有指定预设，也没有激活预设" };
          }
          // 激活预设：先把 live 引擎状态同步进 configData，保证导出=运行态
          if (targetName === configData.active_preset) {
            await syncActivePresetToConfig(username);
          }
          const presetData = configData.presets[targetName];
          if (!presetData?.preset_json) {
            return { success: false, error: `预设 "${targetName}" 不存在或无内容` };
          }
          try {
            // preset_json 已是 toJSON() 形态（ST 形：prompts/prompt_order/extensions/模型参数齐全）
            // 走 exportSTPreset 做 enabled 同步等校正，产物可被 importSTPreset 吃回
            const stJson = exportSTPreset(presetData.preset_json, {
              pretty: true,
              includeDisabled: true,
            });
            return { success: true, name: targetName, st_json: stJson };
          } catch (err) {
            console.error("[beilu-preset] export_st_preset error:", err);
            return { success: false, error: err.message };
          }
        }

        // 导入预设（存入 presets，自动激活）
        if (data.import_preset) {
          let { json, name, description } = data.import_preset;
          const forceOverwrite = data.import_preset.force_overwrite || false;

          // 重名检测：如果已存在同名预设且不是强制覆盖
          if (configData.presets[name] && !forceOverwrite) {
            // 返回重名提示，让前端决定
            console.log(`[beilu-preset] 预设重名: "${name}"，等待前端确认`);
            return {
              success: false,
              duplicate: true,
              existing_name: name,
              message: `预设 "${name}" 已存在，是否覆盖？`,
            };
          } else {
            // [预设切换互斥 2026-07-13 S7] 导入不再无条件夺全局槽：
            //   原 engine.load + active_preset=name 把全局编辑态强切到新导入预设——用户在
            //   per-chat/per-mode 世界里工作时，全局槽被"捕获"后所有默认打全局引擎的读写都
            //   落进导入预设（污染/捕捉源头）。现按坐标激活：带 chatid → 只写本窗口
            //   map[cid:mode]（与 switch_preset per-chat 分支同形，写键=读键单源）；
            //   无坐标（beilu-home 全局管理面板）→ 维持全局激活语义。
            const existingDesc = configData.presets[name]?.description;
            const _impEng = new PresetEngine();
            _impEng.load(json, name);
            configData.presets[name] = {
              preset_json: json,
              model_params: { ..._impEng.modelParams },
              macro_variables: {},
              description: description || existingDesc || "",
            };
            // 预设文件自身立即落盘：尾部 saveConfigToDisk 只落 active_preset 一个文件，
            //   per-chat 激活时 active 不变 → 不落盘则导入成内存孤儿（重启即失踪，2026-07-13 实证"(1)"）。
            await savePresetFile(username, name, {
              _meta: { name, source: "user", description: configData.presets[name].description },
              preset_json: json,
              model_params: configData.presets[name].model_params,
              macro_variables: {},
            });

            // [隔离架构 2026-07-24] 坐标来源补 args 兜底：桥层 updatePresetConfig 现按键收口范式
            //   注入 args.chatid/charName（sendAction.mjs，镜像 getData 线）——settings/panels.mjs
            //   与 importExport.mjs 两个裸发入口零改自愈（0713 S7 只修 airp 入口的半修陷阱收口）。
            //   payload 显式坐标仍优先（浮层对别窗口操作的场景）。
            const _impCid = data.import_preset.chatid || args?.chatid || null;
            if (_impCid) {
              // [0717 R1 归位] charName 缺省经 chat 元数据归位（同 switch_preset，写键=读键单源）
              const _impMode = data.import_preset.mode || getActiveMode(username, await _resolveCharForMode(data.import_preset.charName || args?.charName, _impCid), _impCid);
              // [隔离架构 2026-07-24] 线级激活经漏斗写入（锁内盘 RMW+内存镜像+缓存失效，写后读侧
              //   即见，不再依赖 SetData 尾部 saveConfigToDisk 顺带落盘=导入激活即持久）。
              await actSetLine(username, _impCid, _impMode || null, name);
              console.log(`[beilu-preset] 预设已导入并激活(per-chat ${_impMode ? _impCid + ":" + _impMode : _impCid}): "${name}"`);
              await actBroadcastLine(_impCid, _impMode || null, name); // [0716 T3对接首批→0724 统一传导出口]
            } else {
              // [0725 凛倾「没有全局」] 原 activate_global 显式全局激活分支删除(0724 过渡通道,零调用方)。
              // [隔离架构 2026-07-24 · 凛倾「储存/功能/传导都要隔离,不是打补丁」] 库操作与激活解耦：
              //   无窗口坐标的导入=纯入库（预设文件已 savePresetFile 落盘、进 preset_list），
              //   【不触碰任何激活态】。原「无坐标→engine.load+active_preset=导入名」= 夺全局槽，
              //   所有无线级记录的窗口/模式回退值瞬间齐变（0724 四格全变+当前预设被顶+编辑读A写B
              //   回档的总病根）。要激活由用户/调用方带坐标显式切换（switch_preset）。
              console.log(`[beilu-preset] 预设已导入(仅入库,无坐标不激活): "${name}"`);
            }
            await _resyncPresetRegex(name, json, username);
          }
        }

        // 切换激活预设
        if (data.switch_preset) {
          const { name, chatid, charName: _spChar } = data.switch_preset;
          // R1 模式单源化（2026-07-08 断链审计病根二④）：mapKey 的 :mode 后缀不再信前端 localStorage 推值。
          //   断链根理：前端推 mode（BEILU_ACTIVE_MODE）与生成读键 mode（getPromptHandler:220 getActiveMode）
          //   是两个源——前端=chat 后端=code 时写 [cid:chat] 读 [cid:code] 永 miss，裸键被隔离强切占领。
          //   显式 data.switch_preset.mode 仍优先（隔离强切 presetBridge 传权威 _activeMode / 浮层绑定别模式会话），
          //   缺省时后端用同一 getActiveMode 解析。
          //   [0717 R1 归位] charName 缺省不再直落 "_global" 桶——经 _resolveCharForMode 按 chat 元数据归位，
          //   否则写键按 _global 桶的 mode、生成读键按 char 桶的 mode = [cid:mode] 读写错位（跨模式污染实证）。
          const mode = data.switch_preset.mode || (chatid ? getActiveMode(username, await _resolveCharForMode(_spChar, chatid), chatid) : null);
          // clear（凛倾 07-09 bot 每平台线预设）：清 per-line 覆盖，回退默认链
          //（全局 active_preset）。bot 面板选"(用全平台默认)"时用；web 无消费者零影响。
          if (data.switch_preset.clear && chatid) {
            // [隔离架构 2026-07-24] 经漏斗清键（精确键+裸键，原语义）；原「手拼 delete + saveConfigToDisk
            //   整份覆盖落盘」散写收口。真清了才广播（原先 map 对象存在即广播）。
            const _clr = await actClearLine(username, chatid, mode || null);
            if (_clr.changed) {
              console.log(`[beilu-preset] 已清除 per-chat 预设覆盖: ${mode ? chatid + ":" + mode : chatid}`);
              // [多窗口审计 2026-07-11 A4] 载荷补 cid/mode：消费侧(websocket preset_changed)可按窗口坐标过滤
              await actBroadcastLine(chatid, mode || null, "");
            }
          } else if (!name) {
            console.warn(`[beilu-preset] switch_preset: name 为空，跳过`);
          } else if (chatid) {
            // per-chatId-per-mode：code 和 work 共享 chatId，用 chatid:mode 做 key 互不覆盖
            // [预设隔离 2026-07-11] 有 mode 时不再同步盖裸键 [chatid]——裸键是跨模式共享槽，
            //   双写=任一模式的切换污染同 cid 全部模式的回退值（AIRP/chat 互换病灶之一）。
            //   裸键只在 mode 解析不出时作退化写；读侧（resolveActivePresetName/getActivePresetName/
            //   resolveActivePresetFor）裸键回退保留，仅服务旧数据与无 mode 记录。
            const mapKey = mode ? (chatid + ":" + mode) : chatid;
            if ((configData.active_preset_map || {})[mapKey] === name) {
              console.debug(`[beilu-preset] switch_preset(per-chat): ${mapKey} 已是 "${name}"，跳过`);
            } else if (configData.presets[name]?.preset_json) {
              // [隔离架构 2026-07-24] 经漏斗写线级键（锁内盘 RMW+内存镜像+缓存失效，写后读侧即见）。
              //   2026-07-08 落盘修语义保留且更强：漏斗即时落盘，不再整份覆盖（原 saveConfigToDisk
              //   内存快照覆盖盘=lost-update 族病根）。
              await actSetLine(username, chatid, mode || null, name);
              console.log(`[beilu-preset] 已切换 per-chat 预设: ${mapKey} → "${name}"`);
              // 正则联动：刷新该预设自己在全局库里的规则副本（按请求 preset_name 过滤 → per-chat 隔离）
              await _resyncPresetRegex(name, configData.presets[name].preset_json, username);
              // [多窗口审计 2026-07-11 A4] 载荷补 cid/mode：消费侧可按窗口坐标过滤（原只 {preset} 无坐标）
              await actBroadcastLine(chatid, mode || null, name);
            } else {
              console.warn(`[beilu-preset] switch_preset(per-chat): 预设 "${name}" 不存在`);
            }
          } else {
            // [0725 凛倾「没有全局,马上删除」] 无坐标全局切换语义整体废除——没有全局槽可切。
            //   可见拒绝留痕不静默;残余无坐标调用方(bot 无线分支)迁移见 task#4。
            console.warn(`[beilu-preset] switch_preset("${name}") 无窗口坐标,全局语义已废除(没有全局),跳过`);
          }
        }

        // 删除指定预设（允许删除激活的预设）
        // [0716 刷新机制] 预设名单脏标：delete/create/duplicate/rename 任一成功置 true，
        //   四分支处理完后单点广播 preset_list_changed（见 rename 块后）。
        let _presetListChanged = false;

        if (data.delete_preset) {
          const { name } = data.delete_preset;
          if (configData.presets[name]) {
            delete configData.presets[name];
            _presetListChanged = true;
            await deletePresetFile(username, name);
            // per-chatId 映射里指向该预设的条目一并清除（指向不存在预设=读路径已回退全局，清掉防悬挂）
            // [隔离架构 2026-07-24] 经漏斗清键 + 逐受影响线广播（带坐标 preset:""=该线回退默认链）——
            //   原静默清除：受影响窗口显示定格旧值/下次拉取"莫名"变化，前端无从感知（0724 实证）。
            const _delRes = await actRemoveByPreset(username, name);
            for (const _af of (_delRes.affected || [])) {
              await actBroadcastLine(_af.cid, _af.mode || null, "");
            }
            console.log(`[beilu-preset] 已删除预设: "${name}"`);

            // 正则联动：预设被删 → 清掉它同步进库的正则（预设绑定语义=预设没了规则失效）
            await _removePresetRegex(name, username);

            // [0725 凛倾「没有全局,马上删除」] 原"删除激活预设→自动换选剩余第一个"整块废除——
            //   全局槽已退役,没有槽可换选(它就是"框架审查员从天而降"进所有回退格的制造机)。
            //   主引擎若正载着被删预设,只清空运行时容器,不替用户选任何东西。
            if (name === engine.presetName) {
              engine.load({}, "");
              macroMemory.variables = {};
              console.log(`[beilu-preset] 被删预设 "${name}" 曾载入主引擎,已清空(不自动换选)`);
            }
          }
        }

        // 新建空白预设
        if (data.create_preset) {
          const { name } = data.create_preset;
          if (!name) {
            console.warn("[beilu-preset] create_preset: 缺少名称");
          } else if (configData.presets[name]) {
            console.warn(`[beilu-preset] 预设 "${name}" 已存在`);
          } else {
            const defaultOrder = [
              { identifier: "main", enabled: true },
              { identifier: "personaDescription", enabled: true },
              { identifier: "worldInfoBefore", enabled: true },
              { identifier: "charDescription", enabled: true },
              { identifier: "charPersonality", enabled: true },
              { identifier: "scenario", enabled: true },
              { identifier: "nsfw", enabled: true },
              { identifier: "worldInfoAfter", enabled: true },
              { identifier: "dialogueExamples", enabled: true },
              { identifier: "chatHistory", enabled: true },
              { identifier: "jailbreak", enabled: true },
            ];
            const blankPreset = {
              prompts: [
                // 3 个内置非 Marker 条目（内容为空，用户可编辑）
                {
                  name: "Main Prompt",
                  system_prompt: true,
                  role: "system",
                  content: "",
                  identifier: "main",
                  forbid_overrides: false,
                  injection_position: 0,
                  injection_depth: DEFAULT_INJECTION_DEPTH,
                  injection_order: 100,
                  injection_trigger: [],
                },
                {
                  name: "NSFW Prompt",
                  system_prompt: true,
                  role: "system",
                  content: "",
                  identifier: "nsfw",
                  forbid_overrides: false,
                  injection_position: 0,
                  injection_depth: DEFAULT_INJECTION_DEPTH,
                  injection_order: 100,
                  injection_trigger: [],
                },
                {
                  name: "Jailbreak",
                  system_prompt: true,
                  role: "system",
                  content: "",
                  identifier: "jailbreak",
                  forbid_overrides: false,
                  injection_position: 0,
                  injection_depth: DEFAULT_INJECTION_DEPTH,
                  injection_order: 100,
                  injection_trigger: [],
                },
                // 8 个 Marker 条目（占位符，由引擎展开为模块内容）
                {
                  identifier: "personaDescription",
                  name: "Persona Description",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "scenario",
                  name: "Scenario",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "charDescription",
                  name: "Char Description",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "charPersonality",
                  name: "Char Personality",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "worldInfoBefore",
                  name: "World Info (before)",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "worldInfoAfter",
                  name: "World Info (after)",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "chatHistory",
                  name: "Chat History",
                  system_prompt: true,
                  marker: true,
                },
                {
                  identifier: "dialogueExamples",
                  name: "Chat Examples",
                  system_prompt: true,
                  marker: true,
                },
              ],
              prompt_order: [
                {
                  character_id: SYSTEM_LEVEL_ID,
                  order: defaultOrder.map((o) => ({ ...o })),
                },
                {
                  character_id: USER_LEVEL_ID,
                  order: defaultOrder.map((o) => ({ ...o })),
                },
              ],
            };
            configData.presets[name] = {
              preset_json: blankPreset,
              model_params: {},
              macro_variables: {},
              description: data.create_preset.description || "",
            };
            // saveConfigToDisk 只写激活预设，新建预设非激活时不落盘=内存孤儿（重启即失踪，
            //   与 import_preset :1525 同病；0713 修 import 时漏扫本入口，2026-07-16 实证「预设001测试」重启消失）
            await savePresetFile(username, name, {
              _meta: { name, source: "user", description: data.create_preset.description || "" },
              preset_json: blankPreset,
              model_params: {},
              macro_variables: {},
            });

            // [0725 凛倾「没有全局」] 原"无激活预设自动激活新建的"块废除——没有全局槽可激活,
            //   新建=纯入库,在用预设只由用户/AI 带坐标切换产生。

            console.log(`[beilu-preset] 空白预设已创建: "${name}"`);
            _presetListChanged = true;
          }
        }

        // 复制预设
        if (data.duplicate_preset) {
          const { name: sourceName } = data.duplicate_preset;
          const sourceData = configData.presets[sourceName];
          if (sourceData) {
            // 生成不重复的新名称：原名 (1), 原名 (2), ...
            let newName;
            let counter = 1;
            do {
              newName = `${sourceName} (${counter})`;
              counter++;
            } while (configData.presets[newName]);

            // 深拷贝预设数据
            configData.presets[newName] = JSON.parse(JSON.stringify(sourceData));
            // saveConfigToDisk 只写激活预设，复制品非激活时需直接落盘
            const dup = configData.presets[newName];
            await savePresetFile(username, newName, {
              _meta: { name: newName, source: "user", description: dup.description || "" },
              preset_json: dup.preset_json || {},
              model_params: dup.model_params || {},
              macro_variables: dup.macro_variables || {},
            });
            console.log(`[beilu-preset] 预设已复制: "${sourceName}" → "${newName}"`);
            _presetListChanged = true;
          } else {
            console.warn(`[beilu-preset] duplicate_preset: 源预设 "${sourceName}" 不存在`);
          }
        }

        // 重命名预设
        if (data.rename_preset) {
          const { old_name, new_name } = data.rename_preset;
          if (configData.presets[old_name] && !configData.presets[new_name]) {
            configData.presets[new_name] = configData.presets[old_name];
            delete configData.presets[old_name];
            // saveConfigToDisk 只写激活预设，重命名需落新名文件并删旧名文件
            const renamed = configData.presets[new_name];
            const _saved = await savePresetFile(username, new_name, {
              _meta: { name: new_name, source: "user", description: renamed.description || "" },
              preset_json: renamed.preset_json || {},
              model_params: renamed.model_params || {},
              macro_variables: renamed.macro_variables || {},
            });
            if (_saved) {
              await deletePresetFile(username, old_name);
              // [隔离架构 2026-07-24] 激活引用（全局槽+线级键指向值）经漏斗原子改名——顺序重排为
              //   "新名文件落成后才动激活态"，文件写失败时激活态从未被改，原手拼回滚分支随之消亡。
              const _rn = await actRenamePreset(username, old_name, new_name);
              if (_rn.globalChanged) engine.presetName = new_name;
            } else {
              console.error(`[beilu-preset] rename_preset: 新文件写入失败，保留旧文件 "${old_name}"`);
              configData.presets[old_name] = configData.presets[new_name];
              delete configData.presets[new_name];
            }
            console.log(
              `[beilu-preset] 预设已重命名: "${old_name}" → "${new_name}"`,
            );

            // 正则联动：库里 boundPresetName 仍是旧名（悬挂）→ 清旧名 + 用新名重新同步该预设的正则
            await _removePresetRegex(old_name, username);
            await _resyncPresetRegex(new_name, renamed.preset_json, username);
            _presetListChanged = true;
          }
        }

        // [0716 刷新机制] 预设名单变化单点广播——此前前端下拉/弹窗对新建/删除/复制/重命名
        //   无任何刷新机制（凛倾0716「完全不刷新,是没有刷新机制」定案），开着的界面只能手动重开。
        //   消费链：websocket "preset_list_changed" → beilu:presetListChanged → preset.mjs
        //   loadPresetData 重填下拉 + 弹窗开着时重渲。与 preset_changed（当前预设已切）语义分开。
        if (_presetListChanged) {
          const _r = await dispatch({ target: "bus:broadcast", verb: "emitAll", source: "yonban", payload: { username: username !== "_default" ? username : undefined, event: { type: "preset_list_changed", payload: { preset_list: Object.keys(configData.presets) } } } });
          if (!_r?.ok) console.warn("[beilu-preset] preset_list_changed broadcast failed:", _r?.error?.msg);
        }

        // ★ 恢复内置默认预设（从 defaults/ 复制到 presets/）
        if (data.restore_preset) {
          const { name } = data.restore_preset;
          const reg = loadRegistry(username);
          const entry = reg.presets[name];
          if (entry?.file && fs.existsSync(join(DEFAULTS_DIR, entry.file))) {
            fs.copyFileSync(join(DEFAULTS_DIR, entry.file), join(presetsDirOf(username), entry.file));
            // 重新加载到内存
            const freshData = loadPresetFile(username, name);
            if (freshData) {
              configData.presets[name] = {
                preset_json: freshData.preset_json || {},
                model_params: freshData.model_params || {},
                macro_variables: freshData.macro_variables || {},
                description: freshData._meta?.description || "",
              };
              // 如果恢复的是当前激活预设，重新加载引擎
              if (name === configData.active_preset) {
                engine.load(freshData.preset_json, name);
                if (freshData.model_params) engine.updateModelParams(freshData.model_params);
                macroMemory.variables = { ...(freshData.macro_variables || {}) };
              }
              console.log(`[beilu-preset] 预设已恢复默认: "${name}"`);
            }
          } else {
            console.warn(`[beilu-preset] restore_preset: 未找到内置默认 "${name}"`);
          }
        }

        // _target_preset: 前端指定操作目标预设（浏览非激活预设时读写一致）
        let _tpName = data._target_preset;
        // [隔离架构 2026-07-24 写同源容错] 未指名目标且带窗口坐标（args=桥注入）→ 写目标=本窗口线
        //   解析预设（与 GetData 展示、生成读键同一解析函数=三方同键）。原默认打全局主引擎：线级
        //   世界里左栏改模型参数等 = 显示线预设、写全局预设（读A写B，改动"消失"、重启观感=回档）。
        //   显式 _target_preset 恒优先；解析失败/线值即全局主引擎 → 维持原全局目标（行为不变）。
        if (!_tpName && args?.chatid) {
          try {
            const _tpMode = getActiveMode(username, await _resolveCharForMode(args?.charName, args.chatid), args.chatid);
            const _lineName = resolveActivePresetName(username, args.chatid, _tpMode);
            if (_lineName && _lineName !== engine.presetName && configData.presets[_lineName]) _tpName = _lineName;
          } catch { /* 解析失败=维持全局目标，不拿猜测值凑 */ }
        }
        const _tpEng = (_tpName && _tpName !== engine.presetName)
          ? getEngineFor(username, _tpName) : engine;
        // [预设切换互斥 2026-07-13 写互斥] _target_preset 指名的预设不存在 → 整体拒绝（可见诊断），
        //   原 null 引擎往下走=写操作 crash 或静默错写。契约校验：写目标必须真实存在。
        if (_tpName && !_tpEng) {
          return { success: false, error: `预设 "${_tpName}" 不存在（_target_preset 指向无效目标）` };
        }
        // [缺口⑦ 2026-07-16] async 化：内部 sync* 已 await savePresetFile；调用点全 await。
        const _tpSync = async () => {
          if (_tpEng === engine) await syncActivePresetToConfig(username);
          else await syncPresetEngineToConfig(username, _tpName, _tpEng);
        };

        // 重新排序条目
        if (data.reorder_entries) {
          const { order } = data.reorder_entries;
          const ok = _tpEng.reorderEntries(order);
          if (ok) await _tpSync();
        }

        // 切换单个条目
        if (data.toggle_entry) {
          const { identifier, enabled } = data.toggle_entry;
          const ok = _tpEng.toggleEntry(identifier, enabled);
          if (ok) await _tpSync();
        }

        // 批量切换
        if (data.batch_toggle) {
          const count = _tpEng.batchToggle(data.batch_toggle);
          if (count > 0) await _tpSync();
        }

        // 新增条目
        if (data.add_entry) {
          const entryData = data.add_entry;
          if (!entryData.identifier) {
            console.warn("[beilu-preset] add_entry: 缺少 identifier");
          } else {
            const ok = _tpEng.addEntry(entryData);
            if (ok) {
              await _tpSync();
              console.log(
                `[beilu-preset] 条目已新增: "${entryData.identifier}" (preset: ${_tpName || configData.active_preset})`,
              );
            } else {
              console.warn(
                `[beilu-preset] 条目新增失败: "${entryData.identifier}" (可能已存在)`,
              );
            }
          }
        }

        // 删除条目
        if (data.delete_entry) {
          const { identifier } = data.delete_entry;
          if (!identifier) {
            console.warn("[beilu-preset] delete_entry: 缺少 identifier");
          } else {
            const ok = _tpEng.deleteEntry(identifier);
            if (ok) {
              await _tpSync();
              console.log(`[beilu-preset] 条目已删除: "${identifier}" (preset: ${_tpName || configData.active_preset})`);
            } else {
              console.warn(
                `[beilu-preset] 条目删除失败: "${identifier}" (可能是内置Marker或不存在)`,
              );
            }
          }
        }

        // 修改条目内容
        if (data.update_entry) {
          const { identifier, content, props } = data.update_entry;
          if (content !== undefined) {
            _tpEng.updateEntryContent(identifier, content);
          }
          if (props) {
            _tpEng.updateEntryProps(identifier, props);
          }
          await _tpSync();
        }

        // 修改模型参数（#30 隐患1修复：接固定点 _tpEng/_tpSync——原裸激活引擎，
        // 浏览态(_target_preset≠激活)调用会读A写B；现状调用不带 _target_preset 时
        // _tpEng===engine+_tpSync=syncActivePresetToConfig，零行为漂移）
        // updateModelParams：前端只发 max_context，归一镜像 openai_max_context（分母读该键，
        // 原 Object.assign 散写导致双键漂移=token 条分母永远 4.1k 的写路根因）
        if (data.update_model_params) {
          _tpEng.updateModelParams(data.update_model_params);
          await _tpSync();
          console.log(`[beilu-preset] update_model_params: max_context=${_tpEng.modelParams.max_context}, max_tokens=${_tpEng.modelParams.max_tokens} (preset: ${_tpName || configData.active_preset})`);
        }

        // 修改宏变量（#30 隐患1同族修复：宏记忆按目标预设取——激活=全局 macroMemory，
        // 非激活=getMacroMemFor 缓存；_tpSync 非激活分支 syncPresetEngineToConfig 内部
        // 同源 getMacroMemFor 落 macro_variables，写盘闭环）
        if (data.update_macro_vars) {
          const _mvMem = (_tpEng === engine) ? macroMemory : getMacroMemFor(username, _tpName);
          Object.assign(_mvMem.variables, data.update_macro_vars);
          await _tpSync();
        }

        // 更新预设描述
        if (data.update_preset_description) {
          const { name, description } = data.update_preset_description;
          if (name && configData.presets[name]) {
            configData.presets[name].description = description || "";
            // saveConfigToDisk 只写激活预设，非激活预设描述需直接落盘
            const descTarget = configData.presets[name];
            await savePresetFile(username, name, {
              _meta: { name, source: "user", description: descTarget.description || "" },
              preset_json: descTarget.preset_json || {},
              model_params: descTarget.model_params || {},
              macro_variables: descTarget.macro_variables || {},
            });
            console.log(`[beilu-preset] 预设描述已更新: "${name}"`);
          }
        }

        // 清除当前预设（从列表移除）
        if (data.clear_preset) {
          const activeName = configData.active_preset;
          if (activeName && configData.presets[activeName]) {
            delete configData.presets[activeName];
          }
          engine.load({}, "");
          macroMemory.variables = {};
          // [0725 凛倾「没有全局」] actSetGlobal/全局广播删除——字段退役,清的只是主引擎运行时容器
        }

        // 任何 SetData 变更都可能改预设内容 → 单点失效该 user 的 per-preset 引擎缓存（重建成本低）
        invalidateEngineCaches(username);

        // 持久化到磁盘（该 user 的 presets/config）
        await saveConfigToDisk(username);
        return { success: true };
      },
    },

    chat: {
      /**
       * GetPrompt — 司令员模式下，GetPrompt 只返回空壳
       *
       * 所有实际内容在 TweakPrompt 阶段通过三轮机制组装。
       * GetPrompt 返回空的 single_part_prompt_t，仅保留 extension 字段
       * 作为后续 TweakPrompt 的数据通道。
       *
       * @param {object} arg - chatReplyRequest_t
       * @returns {object} single_part_prompt_t
       */
      GetPrompt: (arg) => {
        // [T065] username 权威=arg.username（主链 shadowBuild 盖章）。原 `args?.username` 引用 SetData 闭包外变量
        //   =chat 作用域 ReferenceError（仅在 arg.username falsy 时才触发），一并修正为显式 _gpUser。
        const _gpUser = _resolveUser(arg);
        const _st = getStore(_gpUser);
        const _cid = _resolveCid(arg);
        wbT(_cid, "preset", "GetPrompt:enter", {});
        // per-chatId-per-mode：模式与生成主链同源——resolveGenerationMode 唯一单源（0715 凛倾
        //   「单个，禁止散写/高耦合」收口：原此处 getActiveMode + _gpBotMode 覆盖=三级链的散拼副本，
        //   与 injectionSystem/shadowBuild 各持一份，镜像删除）。
        //   [0716 凛倾定案] bindingsDefault 死参已删（「绑定」概念不存在，bot 同链回退全局 active_preset）。
        // [T1 激活层 2026-07-19] 激活备料优先：入口（requestBuilder）已把本条激活线的 mode/preset_name
        //   一次备齐冻结在 extension.activation，此处消费同一份——与 TweakPrompt 三轮同源，防组装期间
        //   并发切预设/切模式导致 GetPrompt 与三轮各读各的。无 activation 的入口（bot 壳等）回退原解析链。
        const _gpAct = arg?.extension?.activation;
        const _gpMode = _gpAct?.mode || resolveGenerationMode(arg, _gpUser, arg?.char_id || "_global", _cid);
        const _pName = _gpAct?.preset_name || resolveActivePresetName(_gpUser, _cid, _gpMode);
        // [T2 去常驻 2026-07-19] 生成读点切 Activation 变体：不共享 UI 可变主引擎（见 getEngineForActivation 注释）。
        //   || _st.engine 兜底保留=预设名解析不到实体时的原有降级（仅此 degenerate 分支仍读主引擎，只读取用途）。
        const _eng = getEngineForActivation(_gpUser, _pName) || _st.engine;
        const _ret = {
          text: [],
          additional_chat_log: [],
          extension: {
            preset_source: "beilu-preset",
            preset_name: _eng.presetName,
            commander_mode: _eng.isLoaded(),
            // 供 beilu-toggle 列出可控条目（slim：仅 toggle 列表需要的字段，不带 content 防膨胀）。
            toggleable_entries: _eng.getAllEntries().map((e) => ({
              identifier: e.identifier,
              name: e.name,
              enabled: e.enabled,
              marker: e.marker,
              is_comment: e.is_comment,
              has_content: e.has_content,
              is_builtin: e.is_builtin,
            })),
          },
        };
        wbT(_cid, "preset", "GetPrompt:exit", {});
        return _ret;
      },

      /**
       * TweakPrompt — 司令员模式：三轮接管
       *
       * Round 1 (detail_level=2): 收集 — 读取所有模块内容到宏环境，清空原始模块
       * Round 2 (detail_level=1): 重建 — 用预设条目重新组装消息序列，写入 extension
       * Round 3 (detail_level=0): 快照捕获 — 仅记录调试快照（注入已简化为 above/below 区域块，于 Round 2 完成，不再改 chat_log）
       *
       * @param {object} arg - chatReplyRequest_t
       * @param {object} prompt_struct - prompt_struct_t（可修改）
       * @param {object} my_prompt - 本插件的 single_part_prompt_t
       * @param {number} detail_level - 细节级别 (2→1→0)
       */
      TweakPrompt: async (arg, prompt_struct, my_prompt, detail_level) => {
        // [T065] username 权威=arg.username（主链 shadowBuild 盖章），全程按此 user 取 store。
        const _twUser = _resolveUser(arg);
        const _twSt = getStore(_twUser);
        // [0717 串联收口] 原 engine/macroMemory/configData 解构随 P1 切换块删除——TweakPrompt 只读
        //   getEngineFor(_twName) 的目标引擎（eng），不再持有主引擎/全局配置写手柄（生成不碰预设状态）。
        // per-chatId-per-mode：从 beilu-memory extension 读当前 mode，区分 code/work 各自预设槽位
        // 2026-07-08 生效模型（凛倾定调）：生成只读「正在使用的预设」（active_preset_map=人/AI 切换动作
        //   的直接产物）。绑定=切换动作时刻的一次性默认值，不在生成时僭越——原 R3 同轮僭越已撤：
        //   它会把 AI <presetSwitch>/流水线推进当轮盖回绑定值=「AI 切换功能被绑定堵死，进程推进不了」。
        const _twCid = _resolveCid(arg);
        // [T1 激活层 2026-07-19] 激活备料优先（同 GetPrompt 处注释）：三轮消费入口冻结的同一份
        //   mode/preset_name——原每轮重解析（且 mode 取自 memory ext、GetPrompt 取自 resolveGenerationMode
        //   =双源），组装中途并发切预设会让三轮撕裂。回退链保持原样（bot 壳等无 activation 入口）。
        const _twAct = arg?.extension?.activation;
        const _twMode = _twAct?.mode || prompt_struct?.plugin_prompts?.["beilu-memory"]?.extension?.active_mode || null;
        const _twName = _twAct?.preset_name || resolveActivePresetName(_twUser, _twCid, _twMode);
        // [T2 去常驻 2026-07-19] 生成读点切 Activation 变体（同 GetPrompt 处）：三轮组装全程用
        //   engineCache 盘态实例，UI 编辑/切预设中途改 st.engine 不再撕裂在途组装。
        const eng = getEngineForActivation(_twUser, _twName);
        if (!eng?.isLoaded()) return;
        const mem = getMacroMemFor(_twUser, _twName);
        if (!prompt_struct) return;

        // ================================================================
        // Round 1 (detail_level=2): 收集所有模块内容到宏环境
        // ================================================================
        if (detail_level === 2) {
          wbT(arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null, "preset", "TweakPrompt:round1", { dl: detail_level });
          // [0717 串联收口·凛倾「两个预设污染/链路串联」] 原「P1 预设切换信号检测」块整体删除——
          //   它是 switch_preset 权威口（本文件 SetData 分支）的第二份手拼写实现（写 map+落盘+正则+广播
          //   同构副本；无 cid 分支直接 engine.load 换装全局主引擎），写点长在生成链（提示词构建域）中途，
          //   违反 0708「生成不碰预设状态」定案；主AI <presetSwitch> 废弃（replyHandler:3702）时此处漏收=半修。
          //   P1 功能不变：切换改在信号产生地（getPromptHandler P1 解析点）经 switchPresetViaAPI 走
          //   SetData switch_preset 唯一权威口，时序仍早于本函数各轮 resolveActivePresetName 读点=同轮生效。
          //   extension.preset_switch_to 字段同批删除（生成链不再携带预设写信号，两预设系统状态层解耦）。

          // 构建基础宏环境
          const env = buildMacroEnvFromPromptStruct(prompt_struct);

          // 构建 {{presetList}} 宏内容
          env.presetList = buildPresetListText(_twUser);

          // [0721 身份宏] {{active_preset_name}}/{{active_preset_description}}——预设 cot 骨架的
          //   身份自检行（"当前任务身份=/是否是我的身份范围"）原是空白完形填空，AI 每轮凭感觉填；
          //   凛倾定案改宏填实。名=本轮激活预设 _twName（Activation 冻结值，与 eng 同源），
          //   介绍=该预设 description（configData 单源，与 preset_descriptions REST 同读点 :1437）。
          //   与 presetList 同型：需 username 的宏在调用点挂，不进 buildMacroEnvFromPromptStruct。
          env.active_preset_name = _twName || "";
          env.active_preset_description = _twSt.configData.presets[_twName]?.description || "";

          // 收集各模块内容到宏环境（同步块，保证原子性）
          // 2026-07-07 凛倾「(卡字段)我觉得需要按照酒馆的来,然后还需要有排序等功能」：
          // 按 GetPrompt(beilu-char-template/main.mjs:132-198) 的 description 标签分字段展开——
          // personality/scenario/mes_examples 从原 char_prompt 大块拆出，各自喂
          // charPersonality/scenario/dialogueExamples 三个 marker 宏（MARKER_TO_MACRO
          // preset_engine.mjs:38，展开点 :646），卡字段从此走 prompt_order 可排序/可开关
          // （既有 Prompt Manager UI 直接生效，与酒馆同构）。
          // 其余标签（system_prompt/char_description/post_history_instructions/depth_prompt_*
          // /无标签兜底）仍并入 char_prompt=charDescription marker——酒馆完整语义
          // （system_prompt→override main、PHI→override jailbreak、depth_prompt→in-chat@depth）
          // 属下一阶段，本次先解排序塌缩、内容零丢失。
          {
            const _cpBuckets = { char_prompt: [], char_personality: [], scenario: [], dialogue_examples: [] };
            const _cpTagOf = (d) =>
              d === "personality" ? "char_personality"
              : d === "scenario" ? "scenario"
              : d === "mes_examples" ? "dialogue_examples"
              : "char_prompt";
            for (const _t of (prompt_struct.char_prompt?.text || [])) {
              if (!_t?.content) continue;
              _cpBuckets[_cpTagOf(_t.description)].push(_t.content);
            }
            // join("\n") 与 flattenPromptTexts(:2538) 同口径
            env.char_prompt = _cpBuckets.char_prompt.join("\n");
            env.char_personality = _cpBuckets.char_personality.join("\n");
            env.scenario = _cpBuckets.scenario.join("\n");
            env.dialogue_examples = _cpBuckets.dialogue_examples.join("\n");
          }
          env.user_prompt = flattenPromptTexts(prompt_struct.user_prompt);
          env.world_prompt = flattenPromptTexts(prompt_struct.world_prompt);
          env.world_prompt_after = ""; // beilu 不区分 before/after

          // ---- 从 beilu-worldbook 插件 extension 中提取世界书内容 ----
          // beilu-worldbook 是 plugin 不是 world 部件，所以 world_prompt 为空
          // 需要从它的 extension 中读取分类后的世界书条目
          const wbPrompt = prompt_struct.plugin_prompts?.["beilu-worldbook"];
          if (wbPrompt?.extension) {
            // before/after 位置的世界书条目 → 填充 {{worldInfoBefore}} / {{worldInfoAfter}} 宏
            const charInjections = wbPrompt.extension.worldbook_char_injections;
            if (Array.isArray(charInjections) && charInjections.length > 0) {
              // 按 order 排序后再分 before/after 通道（修复断链：worldbook 侧未排序，
              // 此前 join 时丢失 order 语义，条目顺序取决于激活遍历顺序而非用户设定）
              const sorted = [...charInjections].sort(
                (a, b) => (a.order ?? 100) - (b.order ?? 100),
              );
              const beforeContent = sorted
                .filter((inj) => inj.position === 0)
                .map((inj) => inj.content)
                .filter(Boolean)
                .join("\n");
              const afterContent = sorted
                .filter((inj) => inj.position === 1)
                .map((inj) => inj.content)
                .filter(Boolean)
                .join("\n");
              if (beforeContent) env.world_prompt = beforeContent;
              if (afterContent) env.world_prompt_after = afterContent;
            }

            // @depth 注入的世界书条目 → 暂存，在 Round 2 中处理
            const depthInjections = wbPrompt.extension.worldbook_injections;
            if (Array.isArray(depthInjections) && depthInjections.length > 0) {
              my_prompt.extension._worldbook_depth_injections = depthInjections;
            }

            // ANTop/ANBottom/EMTop/EMBottom 位置的条目已在 text 中，
            // 会被 flattenPromptTexts 收集到 env.plugin_beilu-worldbook
          }

          // [DIAG] 诊断点5：Round 1 - plugin_prompts 所有 key（gated，默认静默）
          diag.debug(
            `Round 1: plugin_prompts keys:`,
            Object.keys(prompt_struct.plugin_prompts || {}).join(", "),
          );

          // 收集其他插件的输出
          for (const [name, prompt] of Object.entries(
            prompt_struct.plugin_prompts || {},
          )) {
            if (name === "beilu-preset") continue;
            const pluginContent = flattenPromptTexts(prompt);

            // [DIAG] 诊断点6：Round 1 - 每个插件的 flattenPromptTexts 结果（gated）
            if (name === "beilu-memory") {
              diag.debug(
                `Round 1: beilu-memory flattenPromptTexts → ${pluginContent.length}字符, truthy=${!!pluginContent}`,
              );
              diag.debug(
                `Round 1: beilu-memory prompt.text 原始:`,
                JSON.stringify(
                  prompt?.text?.map((t) => ({
                    hasContent: !!t.content,
                    contentLen: (t.content || "").length,
                    contentTruthy: !!t.content,
                    preview: (t.content || "")
                      .substring(0, 60)
                      .replace(/\n/g, "\\n"),
                  })),
                ),
              );
              diag.debug(
                `Round 1: beilu-memory extension keys:`,
                Object.keys(prompt?.extension || {}).join(", "),
              );
              const mdi = prompt?.extension?.memory_depth_injections;
              diag.debug(
                `Round 1: beilu-memory memory_depth_injections: ${mdi ? mdi.length + "条" : "undefined"}`,
              );
              if (mdi && mdi.length > 0) {
                diag.debug(
                  `Round 1: memory_depth_injections 详情:`,
                  mdi
                    .map(
                      (d) =>
                        `${d.id}(depth=${d.depth},content=${d.content.length}字符)`,
                    )
                    .join(", "),
                );
              }
            } else {
              diag.debug(
                `Round 1: plugin "${name}" flattenPromptTexts → ${pluginContent.length}字符`,
              );
            }

            if (pluginContent) {
              env[`plugin_${name}`] = pluginContent;
            }
            // 从插件 extension 中提取宏变量（不用 truthy 判断，允许空字符串）
            if (prompt?.extension) {
              if (prompt.extension.workspace_root !== undefined) {
                env.workspace_root = prompt.extension.workspace_root;
              }
              if (prompt.extension.workspace_tree !== undefined) {
                env.workspace_tree = prompt.extension.workspace_tree;
              }
              // 通用宏通路：插件 extension.macro_env = { 宏名: 字符串值 } 自声明宏
              // （框架级通路，替代上面 workspace_* 式逐插件硬编码摘取；beilu-ppt 首个消费方）。
              // 只收 string 值；已有 env 键不覆盖——插件不得顶掉核心宏（user/char/presetList 等）。
              if (prompt.extension.macro_env && typeof prompt.extension.macro_env === "object") {
                for (const [mk, mv] of Object.entries(prompt.extension.macro_env)) {
                  if (typeof mv !== "string") continue;
                  if (mk in env) continue;
                  env[mk] = mv;
                }
              }
            }
          }
          // 诊断日志：确认宏变量是否被收集
          if (
            env.workspace_root !== undefined ||
            env.workspace_tree !== undefined
          ) {
            console.log(
              `[beilu-preset] Round 1: workspace_root="${env.workspace_root || ""}", workspace_tree=${env.workspace_tree ? env.workspace_tree.length + "字符" : "(空)"}`,
            );
          }

          // 清空原始模块（预设将完全接管）
          if (prompt_struct.char_prompt) {
            prompt_struct.char_prompt.text = [];
            prompt_struct.char_prompt.additional_chat_log = [];
          }
          if (prompt_struct.user_prompt) {
            prompt_struct.user_prompt.text = [];
            prompt_struct.user_prompt.additional_chat_log = [];
          }
          if (prompt_struct.world_prompt) {
            prompt_struct.world_prompt.text = [];
            prompt_struct.world_prompt.additional_chat_log = [];
          }
          // 清空其他插件的 text（但保留 extension）
          for (const [name, prompt] of Object.entries(
            prompt_struct.plugin_prompts || {},
          )) {
            if (name === "beilu-preset") continue;
            if (prompt) {
              prompt.text = [];
              prompt.additional_chat_log = [];
              // [DIAG] 诊断点7：Round 1 - 清空后 extension 是否保留（gated）
              if (name === "beilu-memory") {
                diag.debug(
                  `Round 1: 清空 beilu-memory text 后, extension存在=${!!prompt?.extension}, memory_depth_injections存在=${!!prompt?.extension?.memory_depth_injections}, 长度=${prompt?.extension?.memory_depth_injections?.length ?? "N/A"}`,
                );
              }
            }
          }

          // [DIAG] 诊断点8：Round 1 完成 - env 汇总（gated）
          {
            const pluginKeys = Object.keys(env).filter((k) =>
              k.startsWith("plugin_"),
            );
            diag.debug(
              `Round 1 完成: env 中 ${pluginKeys.length} 个 plugin_* 键:`,
              pluginKeys
                .map(
                  (k) =>
                    `${k}(${(env[k] || "").length}字符, truthy=${!!env[k]}, trimNonEmpty=${!!env[k]?.trim()})`,
                )
                .join(", "),
            );
            diag.debug(
              `Round 1 完成: env.char_prompt=${(env.char_prompt || "").length}字符, env.user_prompt=${(env.user_prompt || "").length}字符, env.world_prompt=${(env.world_prompt || "").length}字符`,
            );
          }

          // 将收集到的 env 存入 extension，供 Round 2 使用
          my_prompt.extension = my_prompt.extension || {};
          my_prompt.extension._collected_env = env;

          return;
        }

        // ================================================================
        // Round 2 (detail_level=1): 用预设条目重建消息序列
        // ================================================================
        if (detail_level === 1) {
          wbT(arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null, "preset", "TweakPrompt:round2", { dl: detail_level, snap: !!arg?.extension?.runtime_params_snapshot });
          const env = my_prompt.extension?._collected_env;
          if (!env) {
            console.warn(
              "[beilu-preset] Round 2: 未找到 Round 1 收集的环境数据",
            );
            return;
          }

          // 检查其他插件是否在 Round 1 之后写入了新内容（处理并行竞态）
          for (const [name, prompt] of Object.entries(
            prompt_struct.plugin_prompts || {},
          )) {
            if (name === "beilu-preset") continue;
            const newContent = flattenPromptTexts(prompt);
            if (newContent && !env[`plugin_${name}`]) {
              env[`plugin_${name}`] = newContent;
              // 清空新写入的内容
              if (prompt) {
                prompt.text = [];
                prompt.additional_chat_log = [];
              }
            }
          }

          // runtimeParamsSnapshot 两步装配（设计②§3.4）：本轮 runtime 参数视图=入口快照优先
          // （getChatRequest 挂 extension.runtime_params_snapshot），快照缺失（旧调用面/预览链）回退活全局=原行为。
          // 在途生成读快照 → 并发窗口改 runtime-params 不再污染本次出站（4模式激活各自异步，互不影响）。
          // [T065] 快照缺失回退=该 user store 的 runtimeParams（原全局单例改踩任意用户）。
          const rt = arg?.extension?.runtime_params_snapshot || _twSt.runtimeParams;

          // 上下文屏蔽：根据运行时参数截取 chat_log
          let chatLog = prompt_struct.chat_log || [];
          const _origLogLen = chatLog.length;
          if (
            rt.context_msg_limit > 0 &&
            chatLog.length > rt.context_msg_limit
          ) {
            chatLog = chatLog.slice(-rt.context_msg_limit);
            prompt_struct.chat_log = chatLog;
            console.log(
              `[beilu-preset] 上下文屏蔽: 保留最近 ${rt.context_msg_limit} 条消息（原 ${_origLogLen} 条）`,
            );
          }

          // 聊天消息中的 {{user}}/{{char}} 宏替换
          for (const msg of chatLog) {
            if (msg.content) {
              msg.content = msg.content
                .replace(/{{user}}/gi, env.user)
                .replace(/{{char}}/gi, env.char);
            }
          }

          // ★ data注入：只清理chatLog中的旧脏数据，不插入新条目（避免持久化破坏聊天记录）
          // 新数据通过下方的injectionBelow注入（不持久化）
          {
            for (let _ci = chatLog.length - 1; _ci >= 0; _ci--) {
              const _m = chatLog[_ci];
              if (_m && (_m.is_injection_data || _m.name === "memory_data" || (typeof _m.name === "string" && (_m.name.startsWith("data_INJ") || _m.name.startsWith("memory_"))))) {
                chatLog.splice(_ci, 1);
              }
            }
          }

          // 调用引擎的 buildAllEntries
          const { beforeChat, afterChat, injectionAbove, injectionBelow } =
            eng.buildAllEntries(env, mem, chatLog);

          // [0718 #27 收口] Round2 追加注入的唯一分派点：depth>=1=聊天记录上方，否则下方。
          //   worldbook/memory/插件三源只构造语义字段（role/name/identifier/content/depth/order），
          //   区选择不再各写一份 if/else（原三份同形分派散拼）。
          // !!!禁止放入提示词!!! 提示词文本只允许住 INJ 条目和预设（凛倾 0722）；本分派点只接收
          //   配置驱动的注入消息，禁止在此或任何上游用代码字符串硬编码提示词。动态内容（每轮变的
          //   宏/数据）必须 depth:0 走下方（尾部），混进上方=提示词缓存前缀整体失效（0722 确诊）。
          const pushInjection = (msg) =>
            ((msg.depth ?? 0) >= 1 ? injectionAbove : injectionBelow).push(msg);

          // ★ data INJ现在走统一的depth/order注入路径（不再特殊处理）

          // ---- 处理 beilu-worldbook 的 @depth 注入条目 ----
          const wbDepthInjections =
            my_prompt.extension?._worldbook_depth_injections;
          if (
            Array.isArray(wbDepthInjections) &&
            wbDepthInjections.length > 0
          ) {
            for (const inj of wbDepthInjections) {
              pushInjection({
                role: inj.role || "system",
                name: "world_info",
                identifier: "worldbook_depth",
                content: inj.content,
                depth: inj.depth ?? 4,
                // [0718 #27] order 透传（世界书条目自带 order, before/after 通道 :2282 已消费此处原丢）
                order: inj.order ?? 100,
              });
            }
          }

          // [DIAG] 诊断点9：Round 2 - 遍历 env 中所有 plugin_* 键的状态（gated）
          {
            const allPluginKeys = Object.keys(env).filter((k) =>
              k.startsWith("plugin_"),
            );
            diag.debug(
              `Round 2: env 中 plugin_* 键总数=${allPluginKeys.length}`,
            );
            for (const pk of allPluginKeys) {
              const pv = env[pk];
              diag.debug(
                `Round 2: ${pk} → len=${(pv || "").length}, truthy=${!!pv}, trimNonEmpty=${!!pv?.trim()}, willEnterIf=${!!(pv && pv.trim())}`,
              );
            }
            // 特别检查 beilu-memory 不在 env 中的情况
            if (!allPluginKeys.includes("plugin_beilu-memory")) {
              diag.debug(
                `Round 2: ⚠️ env 中没有 plugin_beilu-memory 键！检查 prompt_struct.plugin_prompts 中是否有 beilu-memory...`,
              );
              const hasInPS = !!prompt_struct.plugin_prompts?.["beilu-memory"];
              const mdi =
                prompt_struct.plugin_prompts?.["beilu-memory"]?.extension
                  ?.memory_depth_injections;
              diag.debug(
                `Round 2: prompt_struct 中 beilu-memory 存在=${hasInPS}, memory_depth_injections=${mdi ? mdi.length + "条" : "undefined"}`,
              );
            }
          }

          // ══ depth 注入消费（20260726 解耦：不再挂在 env.plugin_* 非空上）══
          //   【原病】本段原本嵌在下方 `for (env) { if (key.startsWith("plugin_") && value.trim()) }`
          //     里面：depth 注入的生死取决于该插件的 **text** 是否非空——
          //     Round 1 只在 `if (pluginContent)` 时才写 env.plugin_<name>（:2542），
          //     所以 text 一空，键根本不存在 → 循环遍历不到 → 整包 memory_depth_injections
          //     （热层 + 上下文摘要 + 检索/搜索结果 + 委派报告 + INJ 数据条目）被**静默**丢弃，无任何告警。
          //     两个本来独立的机制（文本注入 / 位置注入）被绑成一条命。
          //   【修法】depth 独立成段，直接遍历 prompt_struct.plugin_prompts 取 extension.memory_depth_injections。
          //     text 与 depth 在 memory 侧是同一份内容的两份拷贝（getPromptHandler 同时 push textEntries
          //     与 depthInjections），故原 if/else 是防重复——解耦后靠 _depthHandled 集合承接该语义：
          //     已走 depth 的插件，下方 text 循环跳过，绝不双份注入。
          const _depthHandled = new Set();
          for (const [pluginName, pluginPrompt] of Object.entries(prompt_struct.plugin_prompts || {})) {
            if (pluginName === "beilu-preset") continue;
            const memoryDepthInjections = pluginPrompt?.extension?.memory_depth_injections;
            if (!Array.isArray(memoryDepthInjections) || memoryDepthInjections.length === 0) continue;
            _depthHandled.add(pluginName);
            // beilu-memory 提供了带 depth 的注入条目
            // 按 depth 分配到 injectionAbove (depth>=1) 或 injectionBelow (depth=0)
            // 先按 order 排序
            // FT8-2: memory_depth_injections 入口 schema 校验。生产侧（beilu-memory getPromptHandler）
            // 推条目时若 content 缺失/类型错，下方 `injContent.length` 会抛、坏条目会污染注入区。
            // 校验契约：必须是对象 + content 为 string + id 为 string（其余字段有默认值，宽松放行）。
            // 不合规 → 跳过该条 + wbTrace 记录（不 throw 整轮、不静默吞）。
            const _validInjections = [];
            for (const _mi of memoryDepthInjections) {
              const _ok =
                _mi && typeof _mi === "object" &&
                typeof _mi.content === "string" &&
                typeof _mi.id === "string" && _mi.id.length > 0;
              if (_ok) {
                _validInjections.push(_mi);
              } else {
                wbD(
                  null,
                  "preset:memDepthInject",
                  "schema_invalid_skipped",
                  false,
                  `memory_depth_injections 条目结构非法已跳过 (id=${_mi?.id ?? "?"}, contentType=${typeof _mi?.content})`,
                  { id: _mi?.id, hasContent: typeof _mi?.content, isObject: _mi && typeof _mi === "object" },
                );
              }
            }
            const sorted = [..._validInjections].sort(
              (a, b) => (a.order || 0) - (b.order || 0),
            );
            for (const depthInj of sorted) {
              // BUG-3 双重宏求值修复：只有标记 macro:true 的注入（作者编写的 INJ 模板，可能含
              // {{workspace_tree}} 等由 env 注入、getPromptHandler 不解析的预设宏）才在此再求一次宏。
              // 其余注入是运行期纯数据（热层 md / 上下文摘要 / 检索·搜索·委派结果等），getPromptHandler
              // 已完成自有宏替换，此处再 evaluateMacros 会把数据里偶含的 {{//...}}/{{setvar::}}/env同名串
              // 当宏吃掉/执行，造成内容损坏，故按字面透传。
              let injContent = depthInj.content;
              if (depthInj.macro) {
                try {
                  injContent = evaluateMacros(
                    injContent,
                    env,
                    mem,
                    chatLog,
                  );
                } catch (e) {
                  console.warn(
                    `[beilu-preset] 记忆注入宏替换失败 (${depthInj.id}):`,
                    e.message,
                  );
                  // 用户宏语法错误 → 该条记忆注入原样保留，映射到前端面板告警。
                  wbD(null, "preset:macro", "depth_inject_macro_fail", false, `记忆注入宏替换失败 (${depthInj.id}): ${e.message}`, { id: depthInj.id, err: e.message });
                }
              }
              const msg = {
                role: depthInj.role || "system",
                name: `memory_${depthInj.id}`,
                identifier: `memory_${depthInj.id}`,
                content: injContent,
                depth: depthInj.depth ?? 0,
                // [0718 #27] order 上车（:2633 组内 sort 后原丢弃——INJ 面板"值越小越靠前"
                //   承诺的是全区语义, 末尾统一排序消费此值）
                order: depthInj.order ?? 0,
              };
              // [DIAG] 诊断点11：Round 2 - 注入推入（gated）
              diag.debug(
                `Round 2: 推入 memory_${depthInj.id} → depth=${depthInj.depth}, target=${depthInj.depth >= 1 ? "injectionAbove" : "injectionBelow"}, content=${injContent.length}字符`,
              );
              pushInjection(msg);
            }
          }

          // 将其他插件的内容（Round 1 收集的 env.plugin_* ）追加到注入区域
          // buildAllEntries 只处理 ST 预设条目，不处理 plugin_* 键
          // 不追加则这些内容会在 Round 1 清空后彻底丢失
          for (const [key, value] of Object.entries(env)) {
            if (key.startsWith("plugin_") && value && value.trim()) {
              const pluginName = key.replace("plugin_", "");
              // 已在上方 depth 段消费过的插件跳过：text 与 depth 是同一份内容的两份拷贝，
              //   两边都推 = 双份注入（原 if/else 二选一语义在此承接）。
              if (_depthHandled.has(pluginName)) continue;
              const pluginPrompt = prompt_struct.plugin_prompts?.[pluginName];
              // [0718 #27] 其他插件纳入位置体系：extension.injection_meta={depth,order} 声明位置
              //   （beilu-ppt <ppt_system> 8539字原恒垫底贴生成点=零位置控制, 凛倾两次点名）。
              //   无声明=旧行为（below 区、order=1000 垫底语义, 统一排序后相对位置不变）。
              const _pm = pluginPrompt?.extension?.injection_meta;
              pushInjection({
                role: "system",
                name: pluginName,
                identifier: key,
                content: value,
                depth: Number.isFinite(Number(_pm?.depth)) ? Number(_pm.depth) : 0,
                order: Number.isFinite(Number(_pm?.order)) ? Number(_pm.order) : 1000,
              });
            }
          }

          // [0718 #27 排序根修] INJ 面板 UI 承诺"值越小越靠前"是整区语义，原实现只有组内 sort
          //   （buildAllEntries:721 预设组 / :2633 memory 组），Round2 追加的各组之间从不重排——
          //   order=-175 的 INJ 条目照样排在 order=100 的预设条目后、插件文本恒垫底（凛倾截图实锤）。
          //   统一稳定排序兑现全局语义：各 push 点已补组默认 order（预设/worldbook=100, memory=0,
          //   插件=1000），Array.sort 稳定（ES2019+）——同 order 保持原推入相对序，未显式设 order
          //   的条目相对位置不变，只有显式设 order 的条目按承诺移动。
          {
            const _byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);
            injectionAbove.sort(_byOrder);
            injectionBelow.sort(_byOrder);
          }

          // [DIAG] 诊断点12：Round 2 完成汇总（gated）
          diag.debug(
            `Round 2 完成: beforeChat=${beforeChat.length}, afterChat=${afterChat.length}, injectionAbove=${injectionAbove.length}, injectionBelow=${injectionBelow.length}`,
          );
          if (injectionAbove.length > 0) {
            diag.debug(
              `Round 2 injectionAbove:`,
              injectionAbove
                .map(
                  (m) =>
                    `${m.identifier || m.name}(${m.content?.length || 0}字符,depth=${m.depth ?? "?"})`,
                )
                .join(", "),
            );
          }
          if (injectionBelow.length > 0) {
            diag.debug(
              `Round 2 injectionBelow:`,
              injectionBelow
                .map(
                  (m) =>
                    `${m.identifier || m.name}(${m.content?.length || 0}字符,depth=${m.depth ?? "?"})`,
                )
                .join(", "),
            );
          }

          // bug2 修复兜底：如果 persona 已收集但未进入最终消息，则自动补一条系统消息
          {
            const userPromptLen = (env.user_prompt || "").length;
            if (userPromptLen > 0) {
              const allMsgs = [
                ...beforeChat,
                ...afterChat,
                ...injectionAbove,
                ...injectionBelow,
              ];
              const personaFound = allMsgs.some(
                (m) =>
                  m.identifier === "personaDescription" ||
                  m.identifier === "personaDescription_fallback" ||
                  (m.content &&
                    m.content.includes(env.user_prompt.substring(0, 50))),
              );

              if (!personaFound) {
                beforeChat.push({
                  role: "system",
                  name: "Persona Description (Fallback)",
                  identifier: "personaDescription_fallback",
                  content: env.user_prompt,
                  is_marker: false,
                  order: 95,
                });
                console.warn(
                  `[beilu-preset] bug2 fallback: persona 内容已自动补注入（${userPromptLen}字符）`,
                  `原因：预设未产出 personaDescription，可检查 marker/宏配置`,
                );
              }
            }
          }

          // 将结果写入 extension（供 Gemini/Proxy StructCall 读取）
          // beforeChat: chatHistory marker 之前的预设条目（头部，system only）
          // afterChat: chatHistory marker 之后的预设条目（尾部，system only）
          // injectionAbove: @D>=1 的注入条目（聊天记录上方，可选 role）
          // injectionBelow: @D=0 的注入条目（聊天记录下方，可选 role）
          my_prompt.extension.beilu_preset_before = beforeChat;
          my_prompt.extension.beilu_preset_after = afterChat;
          my_prompt.extension.beilu_injection_above = injectionAbove;
          my_prompt.extension.beilu_injection_below = injectionBelow;
          // 向后兼容：beilu_preset_messages 合并 before+after
          my_prompt.extension.beilu_preset_messages = [
            ...beforeChat,
            ...afterChat,
          ];
          // 向后兼容：beilu_injection_messages 合并 above+below
          // 死键：全库零读（B10 核实 20260610，parts+YonBan grep 仅此 producer 命中），保留兼容
          my_prompt.extension.beilu_injection_messages = [
            ...injectionAbove,
            ...injectionBelow,
          ];
          // ★ 合并 engine.modelParams + runtimeParams 覆盖层——两步装配第 2 步：
          // 因子模式 ext（beilu-memory）此刻已齐，用纯函数 mergeRuntimeParams 从 rt 快照视图算出站参数
          // （原内联块逐字抽出为纯函数，见文件下方 export；rt=入口快照优先，见 Round2 顶部）。
          my_prompt.extension.beilu_model_params = mergeRuntimeParams(
            eng.modelParams,
            rt,
            prompt_struct.plugin_prompts?.["beilu-memory"]?.extension,
            `${arg?.username || ""}/${arg?.char_id || ""}`,
          );

          // [DIAG] Phase 0: 用户设定（persona）注入断言
          {
            const userPromptLen = (env.user_prompt || "").length;
            const allMsgs = [
              ...beforeChat,
              ...afterChat,
              ...injectionAbove,
              ...injectionBelow,
            ];
            const personaFound = allMsgs.some(
              (m) =>
                m.identifier === "personaDescription" ||
                m.identifier === "personaDescription_fallback" ||
                (m.content &&
                  userPromptLen > 0 &&
                  m.content.includes(env.user_prompt.substring(0, 50))),
            );
            diag.debug(
              `Round 2 persona 断言:`,
              `player_id="${prompt_struct.user_prompt ? "有user_prompt模块" : "无user_prompt模块"}",`,
              `env.user_prompt=${userPromptLen}字符,`,
              `persona在最终消息中=${personaFound},`,
              `beforeChat=${beforeChat.length}, afterChat=${afterChat.length},`,
              `injAbove=${injectionAbove.length}, injBelow=${injectionBelow.length}`,
            );
            if (userPromptLen > 0 && !personaFound) {
              diag.warn(
                `⚠️ persona 内容已收集(${userPromptLen}字符)但未出现在最终消息中！`,
                `预设条目中可能缺少引用 personaDescription marker 或 {{personaDescription}} 宏`,
              );
            }
          }

          return;
        }

        // ================================================================
        // Round 3 (detail_level=0): 注入 + 快照
        // ================================================================
        if (detail_level === 0) {
          wbT(arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null, "preset", "TweakPrompt:round3", { dl: detail_level });
          // 注入简化方案：不再按细粒度 depth 插入 chat_log
          // injectionAbove 和 injectionBelow 作为独立区域传递给 serviceGenerator
          // serviceGenerator 负责将它们放在聊天记录的上方/下方
          // 这里不再修改 chat_log，避免 ephemeral 条目的复杂性

          // 捕获提示词快照
          try {
            lastPromptSnapshot = buildCommanderSnapshot(
              prompt_struct,
              my_prompt,
              eng,
            );
          } catch (e) {
            console.warn("[beilu-preset] 快照捕获失败:", e.message);
          }
        }
      },
    },
  },
};

export default pluginExport;

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 将当前主引擎（engine）的编辑态同步回 configData.presets[active_preset]，
 * 并写入独立预设文件（savePresetFile）。
 * 调用时机：P1 预设切换（旧全局路径，无 chatId 时）、SetData 等写操作后。
 *
 * 影响：写盘（presets/<name>.json）
 */
// [缺口⑦ 2026-07-16] async 化：内部 savePresetFile 已进 withFileLock 返回 Promise；不 await
//   会 fire-and-forget，锁保护的写与后续 SetData 逻辑失去时序保证。调用方（SetData 各 _tpSync/
//   syncActivePresetToConfig 调用点）全部在 async 上下文，await 化零回归。
async function syncActivePresetToConfig(username) {
  const st = getStore(username);
  // [预设切换互斥 2026-07-13 锚统一] 写入锚 = engine.presetName（主引擎实际装载的预设名），
  //   不再用 active_preset。病根：_tpEng 固定点(:1778)判等锚是 engine.presetName，写入锚却是
  //   active_preset——两个变量一旦错位（import/切换/降级直写竞态），任何条目写都把主引擎
  //   整个 toJSON 灌进"别的预设"的槽（2026-07-13 捕捉/污染事故机制）。判等锚=写入锚单源后，
  //   主引擎内容永远只落回它自己名下的槽；presetName 为空=引擎未装载，syncPresetEngineToConfig 内 no-op。
  await syncPresetEngineToConfig(username, st.engine.presetName, st.engine, st.macroMemory);
}

async function syncPresetEngineToConfig(username, name, eng, macroMem) {
  if (!name) return;
  const st = getStore(username);
  const configData = st.configData;

  if (!configData.presets[name]) {
    configData.presets[name] = {};
  }

  const existing = configData.presets[name];
  const macro = macroMem || getMacroMemFor(username, name);
  configData.presets[name] = {
    preset_json: eng.toJSON(),
    model_params: { ...eng.modelParams },
    macro_variables: { ...macro.variables },
    description: existing?.description || "",
  };

  await savePresetFile(username, name, {
    _meta: { name, source: existing?._source || "user", description: existing?.description || "" },
    preset_json: configData.presets[name].preset_json,
    model_params: configData.presets[name].model_params,
    macro_variables: configData.presets[name].macro_variables,
  });
}

/**
 * 从 prompt_struct_t 构建宏替换环境（基础字段：user/char/mode/lastMessage 等）。
 * 模块内容宏（char_prompt/user_prompt/world_prompt/plugin_* 等）不在此处填充——
 * 那些在 TweakPrompt Round 1 中逐个 flattenPromptTexts() 后添加到返回的 env 对象上。
 *
 * 链路：TweakPrompt Round 1 入口调用 → 返回的 env 贯穿 Round 1 收集 → Round 2 宏展开
 *
 * @param {object} ps - prompt_struct_t（含 chat_log/Charname/UserCharname/plugin_prompts）
 * @returns {object} 宏环境对象，供 evaluateMacros() 消费
 */
function buildMacroEnvFromPromptStruct(ps) {
  const chatLog = ps.chat_log || [];

  // 任务A：从 beilu-memory 的 extension 中获取模式相关宏数据
  const memoryExt = ps.plugin_prompts?.["beilu-memory"]?.extension;
  const currentMode = memoryExt?.active_mode || "chat";

  return {
    user: ps.UserCharname || "User",
    char: ps.Charname || "Character",
    group: "",
    model: "",
    current_mode: currentMode,
    active_project: memoryExt?.active_project || "",
    code_active_files: memoryExt?.code_active_files || "",
    env_info: memoryExt?.env_info || "",
    // 子模式实时列表宏（0716 半接线收口）：producer=beilu-memory getPromptHandler extension 导出
    //   （code_sub_modes_list/work_sub_modes_list，非本模式时为空串），此前导出后无消费方，
    //   预设文本写 {{code_sub_modes_list}} 会原样漏出 → 预设被迫硬编码子模式清单（漂移源）。
    //   接进 env 后由 evaluateMacros 的 env 键循环自动替换，预设即可引用实时子模式清单。
    code_sub_modes_list: memoryExt?.code_sub_modes_list || "",
    work_sub_modes_list: memoryExt?.work_sub_modes_list || "",
    lastMessage: findLast(chatLog, null),
    lastUserMessage: findLast(chatLog, "user"),
    lastCharMessage: findLast(chatLog, "assistant"),
  };
}

/**
 * 将 single_part_prompt_t 的 text[] 扁平化为单个字符串
 * @param {object} prompt - single_part_prompt_t
 * @returns {string}
 */
function flattenPromptTexts(prompt) {
  if (!prompt?.text || !Array.isArray(prompt.text)) return "";
  return prompt.text
    .filter((t) => t.content)
    .map((t) => t.content)
    .join("\n");
}

/**
 * 查找聊天记录中最后一条匹配角色的消息
 * @param {Array} chatLog
 * @param {string|null} role
 * @returns {string}
 */
function findLast(chatLog, role) {
  if (!chatLog?.length) return "";
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const msg = chatLog[i];
    if (msg.extension?.ephemeral) continue;
    if (role === null || msg.role === role) {
      return msg.content || "";
    }
  }
  return "";
}

// ============================================================
// 预设列表宏构建
// ============================================================

/**
 * 构建 {{presetList}} 宏内容
 * 列出所有可用预设及其描述，当前激活的预设标记 " [当前]"
 * @returns {string}
 */
function buildPresetListText(username) {
  const configData = getStore(username).configData;
  const names = Object.keys(configData.presets);
  if (names.length === 0) return "(无可用预设)";
  return names
    .map((n) => {
      const preset = configData.presets[n];
      const active = n === configData.active_preset ? " [当前]" : "";
      const desc = preset?.description;
      const modeTag = preset?.mode ? ` [模式:${preset.mode}]` : "";
      const triggersTag =
        Array.isArray(preset?.mode_triggers) && preset.mode_triggers.length > 0
          ? ` [触发词:${preset.mode_triggers.join(",")}]`
          : "";
      return `- ${n}${active}${modeTag}${triggersTag}${desc ? ": " + desc : ""}`;
    })
    .join("\n");
}

// ============================================================
// 司令员模式快照构建
// ============================================================

/**
 * 构建司令员模式的调试快照，供 /prompt-snapshot API 返回给前端 promptViewer 面板。
 * 在 TweakPrompt Round 3 (dl=0) 调用。包含四段条目统计、聊天记录摘要、token 估算、model_params。
 *
 * 链路：TweakPrompt Round 3 → 本函数 → lastPromptSnapshot → GET /prompt-snapshot → 前端 promptViewer
 *
 * @param {object} ps - prompt_struct_t（三轮结束后的状态，chat_log 已被 Round 2 修改）
 * @param {object} myPrompt - beilu-preset 的 single_part_prompt_t（extension 含四段+model_params）
 * @param {object} engineRef - PresetEngine 实例
 * @returns {object} 快照数据
 */
function buildCommanderSnapshot(ps, myPrompt, engineRef) {
  const now = new Date();
  const beforeChat = myPrompt.extension?.beilu_preset_before || [];
  const afterChat = myPrompt.extension?.beilu_preset_after || [];
  const injectionAbove = myPrompt.extension?.beilu_injection_above || [];
  const injectionBelow = myPrompt.extension?.beilu_injection_below || [];
  const allPresetMessages = [...beforeChat, ...afterChat];
  const allInjectionMessages = [...injectionAbove, ...injectionBelow];

  // ---- 预设区条目统计 ----
  const presetEntries = allPresetMessages.map((msg) => ({
    name: msg.name,
    role: msg.role,
    identifier: msg.identifier,
    chars: msg.content?.length || 0,
    is_marker: !!msg.is_marker,
    preview: (msg.content || "").substring(0, 120),
  }));
  const presetTotalChars = presetEntries.reduce((sum, e) => sum + e.chars, 0);

  // ---- 注入式条目统计（分上下） ----
  const injAboveEntries = injectionAbove.map((msg) => ({
    name: msg.name,
    role: msg.role,
    position: "above",
    identifier: msg.identifier,
    chars: msg.content?.length || 0,
    preview: (msg.content || "").substring(0, 120),
  }));
  const injBelowEntries = injectionBelow.map((msg) => ({
    name: msg.name,
    role: msg.role,
    position: "below",
    identifier: msg.identifier,
    chars: msg.content?.length || 0,
    preview: (msg.content || "").substring(0, 120),
  }));
  const injectionTotalChars = allInjectionMessages.reduce(
    (sum, m) => sum + (m.content?.length || 0),
    0,
  );

  // ---- 聊天记录统计 ----
  const chatLog = ps.chat_log || [];
  const chatLogChars = chatLog.reduce(
    (sum, m) => sum + (m.content?.length || 0),
    0,
  );

  // ---- 汇总 ----
  const totalChars = presetTotalChars + injectionTotalChars + chatLogChars;

  return {
    timestamp: now.toISOString(),
    charname: ps.Charname || "",
    username: ps.UserCharname || "",
    preset_name: engineRef.presetName || "",
    commander_mode: true,

    // 预设区条目
    preset_entries: presetEntries,
    preset_total_chars: presetTotalChars,
    preset_count: presetEntries.length,

    // 注入式条目（分上下）
    injection_above_entries: injAboveEntries,
    injection_below_entries: injBelowEntries,
    injection_above_count: injAboveEntries.length,
    injection_below_count: injBelowEntries.length,
    injection_total_chars: injectionTotalChars,

    // 聊天记录统计
    chat_log: {
      total: chatLog.length,
      recent: chatLog.slice(-5).map((m) => ({
        role: m.role,
        name: m.name || "",
        preview: (m.content || "").substring(0, 80),
      })),
    },

    // 汇总
    total_chars: totalChars,
    chat_log_chars: chatLogChars,
    estimated_tokens: (() => {
      const allMsgs = [...beforeChat, ...injectionAbove, ...chatLog, ...injectionBelow, ...afterChat];
      let t = 0;
      for (const m of allMsgs) { t += 4 + countTokensSync(m.content || ""); }
      return t;
    })(),

    // 模型参数
    model_params: myPrompt.extension?.beilu_model_params || {},

    // 分段统计
    before_chat_count: beforeChat.length,
    after_chat_count: afterChat.length,
    injection_above_count_stat: injectionAbove.length,
    injection_below_count_stat: injectionBelow.length,
  };
}

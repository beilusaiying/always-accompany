/**
 * injectionSystem.mjs — INJ 注入系统的识别与选择单一权威（inj 识别系统重构 2026-07-13）
 *
 * 【功能链】
 *   modes/*.json(injectionScopes) → runner.loadModeDefs → registerInjectionScopes（注册注入域）
 *   识别：resolveInjectionContext(原始请求) → {activeMode, filesActiveMode, ideConnected, platform}
 *         （模式链路 bot平台派生→arg.mode契约槽→N38 per-chat绑定链 收口在此，调用方零预解析）
 *   生成链：getPromptHandler INJ 循环 → resolveEffectiveInjections(entries, ctx) → 每条 {on, reason} → 注入/跳过
 *   显示链：getDataHandler getData → resolveEffectiveInjections + getInjectionAutoModeMeta 随 payload 下发
 *           → 前端（beilu-chat panels.mjs / beilu-home memoryPreset.mjs）直接渲染后端真值，零镜像重算
 *   写入链：setDataActions add/updateInjectionPrompt → isValidInjectionAutoMode 校验 → 非法值可见拒绝
 *
 * 【why】
 *   重构前 autoMode 的识别散在 6 处互相打架的副本：getPromptHandler 硬编码门控枚举（缺 smart=
 *   凛倾0706拍板4模式之一在此全灭，违反 smart.json T5「行为等价照抄 chat」；airp 永假死值——
 *   AIRP tab→mode="chat"，见 modeTabMap.mjs，_activeMode 永不等于 "airp"）、panels.mjs AUTO_MODES
 *   硬编码选项、panels.mjs computeEffective 镜像重算（且漏 bot 分支=bot 条目在 web 显示恒"生效"）、
 *   beilu-home memoryPreset 第三份选项清单（又不含 all/bot）、setDataActions 写入零校验（垃圾值
 *   静默入库后在门控被拒）、sysViewer 文档表。本模块是唯一权威，全部消费方由此派生——
 *   增一个模式/别名域只改 modes/*.json 声明，不再摸任何消费点。
 *
 * 【互斥（INJ-2 vs INJ-2-code 变体对）】规则原样保留（凛倾 2026-07-13「inj2 的互斥不要改」），
 *   仅从 getPromptHandler 内联搬入本模块统一出口，逻辑逐行等价：
 *   1. IDE 连接 + code 模式 → -code 变体生效，基础版自动禁用
 *   2. IDE 未连接 → -code 变体禁用，基础版可用
 *   3. 用户手动开启基础版（autoMode=manual 且 enabled）→ 变体禁用
 *   变体判定=末尾 -(code|chat|work) 且基础版 id 实际存在（INJ-1-write-code 无 INJ-1-write=非变体）。
 *
 * 【影响范围】纯函数+进程内注册表，无 IO。消费方：getPromptHandler / getDataHandler /
 *   setDataActions / runner（注册钩）；前端经 getData payload 间接消费（浏览器不 import 本文件）。
 */

import { isValidModeId, listModeIds, resolveGenerationMode } from "./storage.mjs";
import { ideClient } from "../../../transport/ideClient.mjs";

// ============================================================
// 识别：原始请求 → 注入上下文（模式链路收口在此，调用方不各自解析）
// ============================================================

/**
 * 从原始请求解析注入上下文——识别链唯一实现，生成链（getPromptHandler）与
 * 显示链（getDataHandler）同源消费，杜绝"调用方各自预解析 ctx"的识别散点。
 *
 * 模式三级链本体已下沉 storage.resolveGenerationMode（0715 凛倾「单个，禁止散写/高耦合」——
 * 原三级链内联于此，preset GetPrompt 另散拼一份、shadowBuild ViaModes 完全没接=同请求双判定分叉），
 * 本函数只做注入上下文的组装消费，不再持有裁决逻辑。
 *
 * @param {object} p
 * @param {object} [p.arg] - 生成请求（chatReplyRequest_t）；显示链（web 面板）不传
 * @param {string} p.username
 * @param {string} p.charName
 * @param {string} [p.chatId]
 * @returns {{activeMode: string, filesActiveMode: string, ideConnected: boolean, platform: string|undefined}}
 */
export function resolveInjectionContext({ arg, username, charName, chatId } = {}) {
  const activeMode = resolveGenerationMode(arg, username, charName, chatId ?? null);
  return {
    activeMode,
    // code模式=IDE模式=file模式，直接从 activeMode 推导（arg.filesActiveMode 契约槽保留，从未被传入）
    filesActiveMode: arg?.filesActiveMode || (activeMode === "code" ? "file" : "chat"),
    // ★ 识别细化（凛倾 0722「cli打开绑定的是inj2,而不是inj2code」）：此处 ideConnected 语义=
    //   「YonBan 真 IDE（VS Code/Cursor）连接」。CLI 常驻后端连接不算——否则 CLI 随本体自启动
    //   使 ideConnected 恒真，INJ-2 永被 -code 变体覆盖。互斥规则本体不动（凛倾 0713「inj2 的
    //   互斥不要改」），只细化输入信号：CLI 连接/未连 → INJ-2（含全量 CLI 指令段）；
    //   YonBan 连接 + code 模式 → INJ-2-code。backendKind 权威=hello appName（ideClient）。
    ideConnected: ideClient.isConnectedFor(chatId ?? null) && ideClient.backendKindFor(chatId ?? null) === "yonban",
    platform: arg?.extension?.platform,
    // ★ 单次注入·条目引用（0726 注入坞，凛倾「点击注入」）：本轮临时启用的 INJ 条目 id 集合。
    //   链路 前端注入坞点⚡ → POST /message.single_inject_ids → triggerCharReply(onceInjectIds)
    //        → requestBuilder result.extension.once_inject_ids → 此处 → resolveEffectiveInjections。
    //   why 走条目引用而非文本：命中条目由 INJ 正线注入，其 role/depth/order/宏 全部照常生效，
    //     且注入的永远是条目当前内容（0617/0706 两次否决的「把 skill 原文复制进单次注入框」形态
    //     会把改条目前的旧原文注进去，且丢失 depth/role）。
    //   仅本轮：Update() 递归重建不携带 → extension 天然不再有它，无需任何清理动作。
    onceIds: new Set(
      Array.isArray(arg?.extension?.once_inject_ids)
        ? arg.extension.once_inject_ids.filter((s) => typeof s === "string" && s)
        : [],
    ),
  };
}

// ============================================================
// 识别：模式 → 接收的注入域（注册表）
// ============================================================

// 内置映射与 modes/*.json 的 injectionScopes 字段同源（同 storage._validModeIds 内置集范式：
// 注册链挂首次生成有时序洞，内置模式入初始表，自定义模式经 registerInjectionScopes 注入）。
// - chat 声明 airp 别名：与 TAB_TO_MODE.airp="chat" 同语义，autoMode="airp" 历史条目在 chat 模式生效
// - smart 声明吃 chat 域：T5 首版铁则「行为等价照抄 chat」+ 凛倾0706「smart 基于 airp 优化」，
//   恢复 smart 升独立模式值前 chat 门控注入在该 tab 生效的行为；差异拆分设计落地时收窄 smart.json 声明即可
// 基座从 storage 内置模式集派生（单源，不与 _validModeIds 手工双表同步）：每模式默认吃自己 id 域
// [0722 排雷] 惰性初始化（首次访问才调 listModeIds）：原顶层 new Map(listModeIds()...) 立即求值
//   = 押注「storage 已初始化完」的承重顶层调用（endpoints.mjs:151 函数内取值范式）——本模块若再被
//   storage 的传递依赖拉进 import 链即 TDZ（0722 事故同款）。惰性化后首次访问必在某函数调用时，
//   模块图已全部求值完，且基座取的是当时已注册模式全集（≥模块求值时刻的集合，语义只增不减）。
let _injScopesByModeMap = null;
function _injScopesByMode() {
  if (!_injScopesByModeMap) {
    _injScopesByModeMap = new Map(listModeIds().map((m) => [m, new Set([m])]));
    // 语义声明（与 modes/chat.json、smart.json 的 injectionScopes 同源双写）：
    _injScopesByModeMap.get("chat")?.add("airp"); // airp=chat 别名域（AIRP tab→mode="chat"）
    _injScopesByModeMap.set("smart", new Set(["smart", "chat", "airp"])); // smart 吃 chat 域+别名（T5 行为等价）
  }
  return _injScopesByModeMap;
}

// autoMode 特殊域（非模式匹配语义）：always/all=全模式；manual=开即生效；file=filesActiveMode 门控
export const INJECTION_SPECIAL_AUTOMODES = ["always", "all", "manual", "file"];

// ─── 数据类条目判据单一真源（0722 J1-B 收口；本体已迁 entryKind.mjs 纯叶子）───────
// 真源=entryKind.mjs（零依赖）。迁出原因：storage 播种域也消费判据，但本模块顶层
//   import ideClient→commandGate（commandGate 顶层立即调 storage.getFilesSettingsPath），
//   storage→本模块的环会让 __projectRoot 在初始化前被读 → TDZ（0722 全插件 load_failed 事故）。
//   此处 re-export 保持消费方 import 面不变；判据增改去 entryKind.mjs。
export { isDataDrivenEntry, isDataEntry } from "./entryKind.mjs";

/** runner.loadModeDefs 注册钩（与 registerModeIds 同批 fire-and-forget）：
 *  ModeDef 可声明 injectionScopes:[...] 覆盖本模式接收的注入域；未声明的新模式默认只吃自己 id 域。 */
export function registerInjectionScopes(defs) {
  for (const d of defs ?? []) {
    if (!d?.id || typeof d.id !== "string") continue;
    if (Array.isArray(d.injectionScopes) && d.injectionScopes.length) {
      _injScopesByMode().set(d.id, new Set(d.injectionScopes.filter((s) => typeof s === "string" && /^[\w-]+$/.test(s))));
    } else if (!_injScopesByMode().has(d.id)) {
      _injScopesByMode().set(d.id, new Set([d.id]));
    }
  }
}

/** 写入校验：autoMode 值是否属于合法值域（特殊域 ∪ 注册模式 ∪ 别名域） */
export function isValidInjectionAutoMode(v) {
  if (INJECTION_SPECIAL_AUTOMODES.includes(v)) return true;
  if (isValidModeId(v)) return true;
  for (const set of _injScopesByMode().values()) if (set.has(v)) return true;
  return false;
}

/** 值域元数据（getDataHandler 下发，"后端权威清单下发"范式同 web_search_engines/param_schema）：
 *  前端选项列表与生效镜像的唯一数据源。 */
export function getInjectionAutoModeMeta() {
  const modes = listModeIds();
  const aliases = new Set();
  for (const set of _injScopesByMode().values())
    for (const s of set) if (!isValidModeId(s)) aliases.add(s);
  const scopes_by_mode = {};
  for (const [m, set] of _injScopesByMode()) scopes_by_mode[m] = [...set];
  return {
    special: [...INJECTION_SPECIAL_AUTOMODES],
    modes,
    aliases: [...aliases],
    scopes_by_mode,
    // 前端 <select> 渲染序：全域 → 各模式 → 别名域 → 文件门控 → 手动
    options: [...new Set(["always", "all", ...modes, ...aliases, "file", "manual"])],
  };
}

// ============================================================
// 选择：一份条目列表 + 一个上下文 → 每条生效判定（门控 + 互斥）
// ============================================================

/**
 * 识别的最终产物：本上下文接受的注入域集合。门控=一次集合成员判定，非分支级联——
 * 加模式/加别名域只会让这个集合变大，不新增任何分支。
 *   无条件域 always/all/manual + 文件门控域 file(仅 filesActiveMode="file" 时进集合)
 *   + 模式域（注册表：activeMode 声明接收的全部域）
 */
export function acceptedScopes(ctx) {
  const activeMode = ctx?.activeMode || "chat";
  const s = new Set(["always", "all", "manual"]);
  if ((ctx?.filesActiveMode ?? (activeMode === "code" ? "file" : "chat")) === "file") s.add("file");
  for (const m of _injScopesByMode().get(activeMode) ?? [activeMode]) s.add(m);
  return s;
}

/**
 * 互斥规则（INJ-2 vs INJ-2-code 变体对）——规则原样保留（凛倾「inj2 的互斥不要改」），
 * 输出「条目→禁用原因」映射。变体判定=末尾 -(code|chat|work) 且基础版 id 实际存在
 * （INJ-1-write-code 无 INJ-1-write=非变体）。
 */
function _mutexDisabled(list, ctx) {
  const off = new Map();
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const inj of list) {
    const m = typeof inj.id === "string" ? inj.id.match(/^(.+)-(code|chat|work)$/) : null;
    const base = m && byId.get(m[1]);
    if (!base) continue;
    // 规则2：IDE 未连接 → -code 变体禁用（本地 beilu-chat IDE 用基础版）
    if (m[2] === "code" && !ctx.ideConnected) off.set(inj, "variant_ide_off");
    // 规则3：用户手动开启基础版（autoMode=manual 且 enabled）→ 变体禁用
    else if (base.enabled && base.autoMode === "manual") off.set(inj, "variant_manual_base");
    // 规则1：IDE 连接 + code 模式 + -code 变体开启 + 基础版非手动 → 基础版让位
    if (m[2] === "code" && inj.enabled && ctx.ideConnected && ctx.activeMode === "code" && base.autoMode !== "manual") {
      off.set(base, "base_overridden");
    }
  }
  return off;
}

/**
 * 解析一组注入条目在给定上下文下的生效状态——后端门控与前端显示共用的唯一裁决函数。
 * 机制：on = enabled ∧ autoMode∈acceptedScopes ∧ 平台匹配 ∧ 未被互斥禁用（四个正交谓词，无级联）。
 * T-5 收口语义保留：未知/拼错 autoMode 不在任何集合=拒注入，reason 区分 unknown_automode 供留痕。
 *
 * @param {Array<object>} entries - injection_prompts（{id, enabled, autoMode, platform?...}）
 * @param {object} ctx - resolveInjectionContext 产物（或等价 {activeMode, filesActiveMode, ideConnected, platform, onceIds?}）
 * @returns {Array<{id: string, on: boolean, reason: string|null, once?: boolean}>} 与 entries 索引对齐；
 *   reason ∈ null(生效) | disabled | scope_mismatch | unknown_automode | platform_mismatch |
 *   variant_ide_off | variant_manual_base | base_overridden；once=本轮单次注入命中
 */
export function resolveEffectiveInjections(entries, ctx) {
  const list = Array.isArray(entries) ? entries : [];
  const accepted = acceptedScopes(ctx);
  const mutexOff = _mutexDisabled(list, ctx ?? {});
  // 单次注入集合（0726 注入坞）：显示链（getDataHandler）不传 ctx.onceIds → 空集，行为零变化。
  const onceIds =
    ctx?.onceIds instanceof Set ? ctx.onceIds
    : new Set(Array.isArray(ctx?.onceIds) ? ctx.onceIds : []);
  return list.map((inj) => {
    // ★ 单次注入命中 = 用户在注入坞对这一条按下「⚡这轮」的显式动作，优先于全部自动门控
    //   （enabled 开关 / 模式域 / INJ-2 互斥 / 平台限定）——自动规则的职责是替用户处理「没表态」
    //   的条目，用户点了名就不该被任何自动规则否决。仅本轮，不写 enabled、不落盘。
    if (onceIds.has(inj.id)) return { id: inj.id, on: true, reason: null, once: true };
    // 平台限定（凛倾 07-09「可以设置单独的平台注入」）：带 platform 字段的条目只进该平台会话
    //   （bot 壳 arg.extension.platform 同源；web 无 platform=不匹配）。无 platform 字段=不限定。
    const reason =
      !inj.enabled ? "disabled"
      : !accepted.has(inj.autoMode) ? (isValidInjectionAutoMode(inj.autoMode) ? "scope_mismatch" : "unknown_automode")
      : (inj.platform && inj.platform !== ctx?.platform) ? "platform_mismatch"
      : mutexOff.get(inj) ?? null;
    return { id: inj.id, on: reason === null, reason };
  });
}

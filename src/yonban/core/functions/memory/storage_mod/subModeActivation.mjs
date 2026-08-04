/**
 * subModeActivation.mjs — 子模式激活唯一 owner + request profile 单一解析（D3 2026-08-04）。
 *
 * 【为什么存在】RC11 确诊：子模式 mode/preset/API/model/采样有多个写 owner、flat/nested 双表示，
 *   UI / AI `<subModeSwitch>` / autoAdvance 三入口各自拼事务（UI 甚至是两次 HTTP），激活结果
 *   没有版本、没有 provenance——UI 文案、持久状态、provider 真实选择不是同一权威。
 *   本模块把「激活」收成单一动作 + 版本化记录，把「请求参数怎么读」收成单一解析函数。
 *
 * 【功能链】
 *   写：setDataActions（setActiveSubMode adapter / activateSubMode verb, source="ui"）、
 *       replyHandler `<subModeSwitch>`（source="ai_tag"）、replyHandler autoAdvance（source="auto_advance"）
 *       → activateSubMode() / deactivateSubMode() → updateYonbanConfig 单事务
 *         （active_sub_modes_map + sub_mode_activations[chatId]）
 *       → 锁外 applySubModePresetDefault（0708 生效模型：切入=一次性应用默认预设，生成时无强切）
 *       → 返回 snapshot + buildSubModeSwitchEvent 事件体（memory/main.mjs 既有 _subModeSwitch 广播链自动接管）。
 *   读：getPromptHandler → resolveRequestProfile()（原 B18 内联 ?? 链收口）；
 *       requestBuilder → getActivationSnapshot()（生成入口冻结 activation revision/profile）。
 *
 * 【存储】yonban_config.sub_mode_activations = { [chatId]: SubModeActivationV1 }：
 *   { schemaVersion:1, revision, chatId, charName, modeGroup, subModeId,
 *     preset:{name, provenance}, activatedAt, activatedBy }
 *   active_sub_modes_map 与 activation 记录在【同一 mutator 同一落盘】里写（单文件单提交的两个视图，
 *   非跨源双写）；map 仍是全系统读权威（resolveActiveSubModeId），activation 记录补版本/来源审计。
 *   delegate/report/flowGroup/委派超时回切等 legacy 写者只写 map 不写记录（共享文件 owner 边界，
 *   本轮不改）——getActivationSnapshot 检测记录与 map 不一致时诚实标 activatedBy:"legacy_writer"，
 *   不伪造 revision。删聊天配对删链在 storage.removeChatSubModeMapping。
 *
 * 【request profile canonical 决策（0804 双侧 grep 后定案）】
 *   YonBan webview（yonban-vscode/webview-ui/chat-modes.js:740-2214）大量直读 flat 字段
 *   （sm.apiSource/modelName/temperature/maxContext/maxTokens）且自带 B18 双写——本轮删除 flat
 *   存储字段=打断跨库消费者（D3 窗口禁碰 YonBan）。故 canonical = 【读侧单一解析器】（本文件
 *   resolveRequestProfile，嵌套 model_params 优先 + 冲突可见）+【写门归一】（normalizeSubModeForSave：
 *   缺侧补齐同步、双侧真冲突标记 _profile_conflicts 不静默挑选、驼峰别名归位）。
 *   flat 物理删除 = YonBan 适配后的协同批（见施工C_D3 施工记录）。
 *
 * 【影响范围】写 yonban_config.json（经 updateYonbanConfig 串行锁）；调 presetBridge.applySubModePresetDefault
 *   （preset owner 自己的写口，不直写 preset 文件）；不写角色 AIsource、不写 preset 文件、不 setActiveMode
 *   （模式对齐由入口层负责：UI 跨组走既有 switchMode 管线，AI 同组限定，autoAdvance 历史即不切模式）。
 */

import {
  loadJsonFileIfExists,
  getYonbanConfigPath,
  updateYonbanConfig,
  SKIP_SAVE,
  resolveActiveSubModeId,
  writeActiveSubModeId,
  buildSubModeSwitchEvent,
  isValidSubModeChatKey,
  extractSubModeMaxContext,
  getActiveMode,
  diag,
} from "./storage.mjs";
import { applySubModePresetDefault, hasPreset } from "../ai/presetBridge.mjs";

export const SUB_MODE_ACTIVATION_SCHEMA = 1;
export const SUB_MODE_DEFINITION_SCHEMA = 2;
export const ACTIVATION_SOURCES = Object.freeze(["ui", "ai_tag", "auto_advance"]);

// ============================================================
// request profile 单一解析（canonical 读点）
// ============================================================

/**
 * 从子模式对象解析本轮 request profile（全系统唯一实现）。
 * 语义与原 getPromptHandler:570-609 的 B18 链逐字段等价（带 model_params 副本=副本权威、
 * 容忍驼峰别名、无副本走扁平字段；哨兵：字符串空串 / 数值 -1（temperature/top_p/top_k/min_p）/
 * 0（maxContext/maxTokens）/ prefillEnabled undefined=无覆盖）。
 * 另附 conflicts：嵌套与扁平【均为有意义值且不相等】的字段名清单（迁移契约：不静默挑选，
 * 读侧维持嵌套优先 + 冲突可见留痕，由消费方 wbD/前端提示）。
 * @param {object} sm - sub_modes[] 条目
 * @returns {{apiSourceName:string, modelName:string, claudeMode:string, promptPostProcessing:string,
 *   prefillEnabled:(boolean|undefined), fallbackPolicy:string, fallbackSourceName:string,
 *   sampling:{temperature:number, topP:number, topK:number, minP:number, maxContext:number, maxTokens:number},
 *   conflicts:string[]}}
 */
export function resolveRequestProfile(sm) {
  const empty = {
    apiSourceName: "", modelName: "", claudeMode: "", promptPostProcessing: "",
    prefillEnabled: undefined, fallbackPolicy: "fail_closed", fallbackSourceName: "",
    sampling: { temperature: -1, topP: -1, topK: -1, minP: -1, maxContext: 0, maxTokens: 0 },
    conflicts: [],
  };
  if (!sm || typeof sm !== "object") return empty;
  const mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : null;
  const out = { ...empty, sampling: { ...empty.sampling }, conflicts: [] };

  if (mp) {
    out.modelName = mp.model ?? mp.modelName ?? sm.modelName ?? "";
    out.apiSourceName = mp.api_source ?? mp.apiSource ?? sm.apiSource ?? "";
    out.claudeMode = mp.claude_prefill_mode ?? mp.claudePrefillMode ?? sm.claudePrefillMode ?? "";
    out.sampling.maxContext = extractSubModeMaxContext(sm);
    out.sampling.maxTokens = mp.max_tokens ?? mp.maxTokens ?? sm.maxTokens ?? sm.max_tokens ?? 0;
    out.sampling.temperature = (mp.temperature !== undefined && mp.temperature !== null)
      ? mp.temperature
      : (sm.temperature !== undefined ? sm.temperature : -1);
    out.sampling.topP = (mp.top_p !== undefined && mp.top_p !== null)
      ? mp.top_p
      : (sm.top_p !== undefined ? sm.top_p : -1);
    out.sampling.topK = (mp.top_k !== undefined && mp.top_k !== null)
      ? mp.top_k
      : (sm.top_k !== undefined ? sm.top_k : -1);
    out.sampling.minP = (mp.min_p !== undefined && mp.min_p !== null)
      ? mp.min_p
      : (sm.min_p !== undefined ? sm.min_p : -1);
    out.promptPostProcessing = mp.prompt_post_processing ?? mp.promptPostProcessing ?? sm.promptPostProcessing ?? "";
    out.prefillEnabled = mp.prefill_enabled ?? mp.prefillEnabled ?? sm.prefillEnabled;
  } else {
    out.modelName = sm.modelName || "";
    out.apiSourceName = sm.apiSource || "";
    out.claudeMode = sm.claudePrefillMode || "";
    out.sampling.maxContext = extractSubModeMaxContext(sm);
    out.sampling.maxTokens = sm.maxTokens || sm.max_tokens || 0;
    out.sampling.temperature = sm.temperature !== undefined ? sm.temperature : -1;
    out.sampling.topP = sm.top_p !== undefined ? sm.top_p : -1;
    out.sampling.topK = sm.top_k !== undefined ? sm.top_k : -1;
    out.sampling.minP = sm.min_p !== undefined ? sm.min_p : -1;
    out.promptPostProcessing = sm.promptPostProcessing || "";
    out.prefillEnabled = sm.prefillEnabled;
  }
  out.fallbackPolicy = sm.fallbackPolicy === "explicit_fallback" ? "explicit_fallback" : "fail_closed";
  out.fallbackSourceName = sm.backup_api_source || "";
  out.conflicts = mp ? _detectProfileConflicts(sm, mp) : [];
  return out;
}

// 同语义字段的 嵌套(canonical, 驼峰别名) ↔ 扁平 对照表——单源，写门归一与冲突检测共用。
const _PROFILE_FIELD_PAIRS = Object.freeze([
  // [flatKey, mpKey, mpAliasKey]
  ["apiSource", "api_source", "apiSource"],
  ["modelName", "model", "modelName"],
  ["temperature", "temperature", null],
  ["top_p", "top_p", null],
  ["top_k", "top_k", null],
  ["min_p", "min_p", null],
  ["maxContext", "max_context", "maxContext"],
  ["maxTokens", "max_tokens", "maxTokens"],
  ["promptPostProcessing", "prompt_post_processing", "promptPostProcessing"],
  ["claudePrefillMode", "claude_prefill_mode", "claudePrefillMode"],
  ["prefillEnabled", "prefill_enabled", "prefillEnabled"],
]);

const _meaningful = (v) => v !== undefined && v !== null && v !== "";

function _mpRead(mp, mpKey, aliasKey) {
  if (mp[mpKey] !== undefined) return mp[mpKey];
  if (aliasKey && mp[aliasKey] !== undefined) return mp[aliasKey];
  return undefined;
}

/** 嵌套与扁平均为有意义值且不相等的字段名（冲突=不静默挑选，读侧嵌套优先 + 留痕）。 */
function _detectProfileConflicts(sm, mp) {
  const conflicts = [];
  for (const [flatKey, mpKey, aliasKey] of _PROFILE_FIELD_PAIRS) {
    const mv = _mpRead(mp, mpKey, aliasKey);
    const fv = sm[flatKey];
    if (_meaningful(mv) && _meaningful(fv) && mv !== fv) conflicts.push(flatKey);
  }
  return conflicts;
}

/**
 * 子模式写门归一（saveSubModes / schema 迁移共用；幂等，可重复执行不覆盖用户值）。
 * ① modeGroup 归一（原 saveSubModes D4 规则）② contract 剥除（RC11 断点1 存量清洗）
 * ③ schemaVersion=2 ④ fallbackPolicy 缺省补 "fail_closed"（D3 契约默认）
 * ⑤ 驼峰别名归位：mp 只有别名键→迁 canonical 键删别名；canonical 已有→删重复别名
 * ⑥ flat↔nested 缺侧同步：仅一侧有值→补齐另一侧（消"旧入口只改一份"的漂移病）；
 *    双侧真冲突（均有意义且不等）→ 标 sm._profile_conflicts=[字段名] 不改任一侧（迁移契约：
 *    不静默挑选；读侧 resolveRequestProfile 维持嵌套优先，与改前行为一致）。
 * @param {object} sm - sub_modes[] 条目（原地 mutate）
 * @param {Set<string>} workIds - DEFAULT_WORK_SUB_MODES id 集（modeGroup 归一用）
 * @returns {object} sm
 */
export function normalizeSubModeForSave(sm, workIds) {
  if (!sm || typeof sm !== "object") return sm;
  if (!sm.modeGroup) sm.modeGroup = (workIds && workIds.has(sm.id)) ? "work" : "code";
  if ("contract" in sm) delete sm.contract;
  sm.schemaVersion = SUB_MODE_DEFINITION_SCHEMA;
  if (sm.fallbackPolicy !== "fail_closed" && sm.fallbackPolicy !== "explicit_fallback") {
    sm.fallbackPolicy = "fail_closed";
  }
  const hasFlatExec = _PROFILE_FIELD_PAIRS.some(([flatKey]) => sm[flatKey] !== undefined);
  if (!sm.model_params || typeof sm.model_params !== "object") {
    if (!hasFlatExec) { delete sm._profile_conflicts; return sm; }
    sm.model_params = {};
  }
  const mp = sm.model_params;
  const conflicts = [];
  for (const [flatKey, mpKey, aliasKey] of _PROFILE_FIELD_PAIRS) {
    // ⑤ 别名归位
    if (aliasKey && mp[aliasKey] !== undefined) {
      if (mp[mpKey] === undefined) mp[mpKey] = mp[aliasKey];
      delete mp[aliasKey];
    }
    const mv = mp[mpKey];
    const fv = sm[flatKey];
    if (mv === undefined && fv !== undefined) {
      mp[mpKey] = fv; // ⑥ 只有扁平 → 补嵌套
    } else if (mv !== undefined && fv === undefined) {
      sm[flatKey] = mv; // ⑥ 只有嵌套 → 补扁平（YonBan 读扁平，双侧 grep 定案保留镜像）
    } else if (_meaningful(mv) && _meaningful(fv) && mv !== fv) {
      conflicts.push(flatKey); // 真冲突：不动、可见
    }
  }
  if (conflicts.length > 0) sm._profile_conflicts = conflicts;
  else delete sm._profile_conflicts;
  return sm;
}

// ============================================================
// 激活单一动作
// ============================================================

/**
 * chat 边界校验（fail-closed）：activateSubMode 只消费已存在的 chat 坐标，不补建
 * （补建/repair 归 D1 chat owner；未知 chatId=归属不可证明=拒绝，零 activation 提交）。
 * ""/null/"_default" = 无对话归属语境（全局字段/flowGroup 手动槽），放行不查。
 */
export async function verifyChatActivatable(chatId, { username = "", charName = "" } = {}) {
  if (!chatId || chatId === "_default") return { ok: true, unbound: true };
  if (!isValidSubModeChatKey(chatId)) {
    return { ok: false, code: "E_CHAT_ID_INVALID", error: "chatId 格式无效，子模式操作已拒绝" };
  }
  try {
    const { getChatMetadatas } = await import("../../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
    const meta = getChatMetadatas().get(chatId);
    if (!meta) return { ok: false, code: "E_CHAT_UNKNOWN", error: `chatId 未知，激活拒绝（fail-closed）: ${String(chatId).slice(0, 40)}` };
    const authenticatedUser = String(username || "").trim();
    const chatOwner = String(meta.username || "").trim();
    if (!authenticatedUser || !chatOwner || authenticatedUser !== chatOwner) {
      return { ok: false, code: "E_CHAT_OWNER_MISMATCH", error: "对话不属于当前登录用户，子模式操作已拒绝" };
    }
    const ownedCharName = String(meta.primaryCharName || "").trim();
    if (!ownedCharName) {
      return { ok: false, code: "E_CHAT_CHAR_UNVERIFIABLE", error: "对话没有可验证的角色卡归属，子模式操作已拒绝" };
    }
    const requestedCharName = String(charName || "").trim();
    if (requestedCharName && requestedCharName !== ownedCharName) {
      return { ok: false, code: "E_CHAT_CHAR_MISMATCH", error: "所选角色卡与对话真实归属不一致，子模式操作已拒绝" };
    }
    return { ok: true, chatOwner, charName: ownedCharName };
  } catch (e) {
    return { ok: false, code: "E_CHAT_OWNER_UNVERIFIABLE", error: `chat 归属校验不可用（fail-closed）: ${e?.message || e}` };
  }
}

function _subModeGroup(sm) {
  return String(sm?.modeGroup || "code").trim().toLowerCase() || "code";
}

function _requiresChatModeAuthority(modeGroup) {
  return ["chat", "code", "work"].includes(modeGroup);
}

function _activationMapConflict(cfg, chatId, subModeId, modeGroup) {
  if (!isValidSubModeChatKey(chatId)) return null;
  const rawPrevSubModeId = String(cfg.active_sub_modes_map?.[chatId] || "");
  if (!rawPrevSubModeId || rawPrevSubModeId === subModeId) return null;
  const rawPrev = (cfg.sub_modes || []).find((m) => m.id === rawPrevSubModeId);
  const rawPrevGroup = rawPrev ? _subModeGroup(rawPrev) : "";
  if (rawPrevGroup && rawPrevGroup === modeGroup) return null;
  return {
    success: false,
    code: "E_SUB_MODE_GROUP_CONFLICT",
    error: rawPrevGroup
      ? `该对话已绑定 ${rawPrevGroup} 组子模式「${rawPrevSubModeId}」，拒绝跨组覆盖`
      : `该对话已有来源不可验证的子模式「${rawPrevSubModeId}」，拒绝覆盖`,
    active_sub_mode: cfg.active_sub_mode,
    active_sub_modes_map: cfg.active_sub_modes_map || {},
  };
}

/**
 * 激活前只读门禁。显式跨组入口在 switchMode 前以 requireCurrentMode=false 调用，先排除
 * owner/角色/子模式/旧映射冲突等确定性失败；direct/AI/auto 入口要求当前生成模式已属于目标组。
 * 模式权威只读 memory _config.active_modes_map，不调用会整理并保存 shellData 的 getChatList。
 */
export async function preflightSubModeActivation({
  username,
  charName = "",
  chatId = "",
  subModeId,
  requireCurrentMode = true,
}) {
  if (!subModeId) return { success: false, code: "E_SUB_MODE_ID_REQUIRED", error: "缺少 subModeId" };
  const chat = await verifyChatActivatable(chatId, { username, charName });
  if (!chat.ok) return { success: false, code: chat.code, error: chat.error };
  const verifiedCharName = chat.unbound ? String(charName || "").trim() : chat.charName;
  const cfg = loadJsonFileIfExists(getYonbanConfigPath(username), { sub_modes: [] });
  const sm = (cfg.sub_modes || []).find((m) => m.id === subModeId);
  if (!sm) return { success: false, code: "E_SUB_MODE_NOT_FOUND", error: `子模式ID不存在: ${subModeId}` };
  const modeGroup = _subModeGroup(sm);
  if (requireCurrentMode && chatId !== "_default" && isValidSubModeChatKey(chatId) && _requiresChatModeAuthority(modeGroup)) {
    const currentMode = String(getActiveMode(username, verifiedCharName, chatId)).trim().toLowerCase();
    if (currentMode !== modeGroup) {
      return {
        success: false,
        code: "E_CHAT_MODE_GROUP_MISMATCH",
        error: `对话当前模式为 ${currentMode || "未知"}，不能绑定 ${modeGroup} 组子模式`,
      };
    }
  }
  const conflict = _activationMapConflict(cfg, chatId, subModeId, modeGroup);
  if (conflict) return conflict;
  return { success: true, charName: verifiedCharName, modeGroup, subMode: sm };
}

/**
 * 子模式激活唯一动作（三入口统一）。
 * 事务边界：updateYonbanConfig 串行锁内一次提交 active_sub_modes_map + sub_mode_activations 记录；
 * 校验失败（子模式不存在 / chat 未知）零提交零落盘。preset 默认应用在锁外（0708 生效模型：
 * 切入=一次性应用，失败不阻塞激活本体，presetApplied 如实回传）。
 * source 只作审计（activatedBy），不改变任何持久副作用（D3 契约）。
 * @param {object} p
 * @param {string} p.username
 * @param {string} [p.charName] - 审计字段（activation 记录）；缺省 ""
 * @param {string} [p.chatId] - 激活线坐标；""/null=全局字段语义
 * @param {string} p.subModeId - 精确子模式 id（label 模糊解析由入口层 resolveSubMode 完成）
 * @param {string} p.source - "ui" | "ai_tag" | "auto_advance"
 * @returns {Promise<{success:boolean, code?:string, error?:string, activation?:object|null,
 *   subMode?:object, modeGroup?:string, prevSubModeId?:string, presetApplied?:boolean,
 *   event?:object, active_sub_mode?:string, active_sub_mode_work?:string, active_sub_modes_map?:object}>}
 */
export async function activateSubMode({ username, charName = "", chatId = "", subModeId, source }) {
  const src = ACTIVATION_SOURCES.includes(source) ? source : "ui";
  if (!subModeId) return { success: false, code: "E_SUB_MODE_ID_REQUIRED", error: "缺少 subModeId" };

  const preflight = await preflightSubModeActivation({ username, charName, chatId, subModeId, requireCurrentMode: true });
  if (!preflight.success) return preflight;
  const verifiedCharName = preflight.charName;

  let out = null;
  await updateYonbanConfig(username, async (cfg) => {
    const sm = (cfg.sub_modes || []).find((m) => m.id === subModeId);
    if (!sm) {
      out = { success: false, code: "E_SUB_MODE_NOT_FOUND", error: `子模式ID不存在: ${subModeId}`, active_sub_mode: cfg.active_sub_mode };
      return SKIP_SAVE; // 校验失败零提交（原 setActiveSubMode SKIP_SAVE 语义保留）
    }
    const modeGroup = _subModeGroup(sm);
    const liveChat = await verifyChatActivatable(chatId, { username, charName: verifiedCharName });
    if (!liveChat.ok) {
      out = { success: false, code: liveChat.code, error: liveChat.error, active_sub_mode: cfg.active_sub_mode };
      return SKIP_SAVE;
    }
    if (chatId !== "_default" && isValidSubModeChatKey(chatId) && _requiresChatModeAuthority(modeGroup)) {
      const currentMode = String(getActiveMode(username, verifiedCharName, chatId)).trim().toLowerCase();
      if (currentMode !== modeGroup) {
        out = {
          success: false,
          code: "E_CHAT_MODE_GROUP_MISMATCH",
          error: `对话当前模式为 ${currentMode || "未知"}，不能绑定 ${modeGroup} 组子模式`,
          active_sub_mode: cfg.active_sub_mode,
          active_sub_modes_map: cfg.active_sub_modes_map || {},
        };
        return SKIP_SAVE;
      }
    }
    const conflict = _activationMapConflict(cfg, chatId, subModeId, modeGroup);
    if (conflict) { out = conflict; return SKIP_SAVE; }
    const prevSubModeId = resolveActiveSubModeId(cfg, modeGroup, chatId);
    writeActiveSubModeId(cfg, modeGroup, subModeId, chatId);
    let activation = null;
    if (isValidSubModeChatKey(chatId)) {
      // 激活记录键=map 键同一守卫（isValidSubModeChatKey 单源）：writeActiveSubModeId 会把非法
      // chatId 降级写全局字段，此处同判定保证「有记录必有同键 map 条目」不错位。
      cfg.sub_mode_activations = cfg.sub_mode_activations || {};
      const prevRec = cfg.sub_mode_activations[chatId];
      const presetName = sm.presetName || "";
      activation = {
        schemaVersion: SUB_MODE_ACTIVATION_SCHEMA,
        revision: (Number(prevRec?.revision) || 0) + 1,
        chatId,
        charName: verifiedCharName,
        modeGroup,
        subModeId,
        preset: { name: presetName, provenance: presetName ? "submode_default" : "none" },
        activatedAt: new Date().toISOString(),
        activatedBy: src,
      };
      cfg.sub_mode_activations[chatId] = activation;
    }
    out = {
      success: true,
      subMode: sm,
      modeGroup,
      prevSubModeId,
      activation,
      active_sub_mode: cfg.active_sub_mode,
      active_sub_mode_work: cfg.active_sub_mode_work || "work-task-confirm",
      active_sub_modes_map: cfg.active_sub_modes_map || {},
    };
    return cfg;
  }, { sub_modes: [], active_sub_mode: "前置任务专家" });

  if (!out || !out.success) return out || { success: false, code: "E_ACTIVATION_NOT_COMMITTED", error: "激活未提交" };

  // 生效模型（凛倾 2026-07-08）：切入子模式=一次性应用其默认预设为「正在使用」。
  // 锁外执行（写 preset 域非 yonban_config，走 preset owner 的 switch_preset 权威口）；
  // 失败不阻塞激活本体（activation 已提交），presetApplied 如实回传不谎报。
  let presetApplied = false;
  try {
    presetApplied = await applySubModePresetDefault(username, out.subMode, chatId || undefined);
  } catch (e) {
    diag.warn(`activateSubMode: 子模式默认预设应用失败（激活已提交，presetApplied=false）: ${e?.message || e}`);
  }
  out.presetApplied = presetApplied;
  // 事件体单源（storage.buildSubModeSwitchEvent 契约）：chatId=map 实际写盘键同一变量
  out.event = buildSubModeSwitchEvent({
    from: out.prevSubModeId,
    to: subModeId,
    sm: out.subMode,
    modeGroup: out.modeGroup,
    chatId: chatId || "",
    reason: src === "ui" ? "" : src,
  });
  return out;
}

/**
 * 解除线级子模式覆盖的唯一写动作。
 * expectedSubModeId 与当前 map 值的比较和删除在同一 updateYonbanConfig 锁内完成，
 * 避免前端“先读后删”在并发改绑时误删新值；同时删除配对 activation 审计记录。
 */
export async function deactivateSubMode({ username, charName = "", chatId = "", expectedSubModeId = "" }) {
  if (!chatId) return { success: false, code: "E_CHAT_ID_REQUIRED", error: "缺少 chatId" };
  const chk = await verifyChatActivatable(chatId, { username, charName });
  if (!chk.ok) return { success: false, code: chk.code, error: chk.error };

  let out = null;
  await updateYonbanConfig(username, (cfg) => {
    const map = cfg.active_sub_modes_map || {};
    const actualSubModeId = String(map[chatId] || "");
    if (!actualSubModeId) {
      out = { success: true, cleared: false, conflict: false, actualSubModeId: "", active_sub_modes_map: map };
      return SKIP_SAVE;
    }
    if (expectedSubModeId && actualSubModeId !== expectedSubModeId) {
      out = { success: true, cleared: false, conflict: true, actualSubModeId, active_sub_modes_map: map };
      return SKIP_SAVE;
    }
    delete map[chatId];
    cfg.active_sub_modes_map = map;
    if (cfg.sub_mode_activations && Object.prototype.hasOwnProperty.call(cfg.sub_mode_activations, chatId)) {
      delete cfg.sub_mode_activations[chatId];
    }
    out = { success: true, cleared: true, conflict: false, actualSubModeId, active_sub_modes_map: map };
    return cfg;
  }, { sub_modes: [], active_sub_mode: "前置任务专家" });

  return out || { success: false, code: "E_DEACTIVATION_NOT_COMMITTED", error: "解绑未提交" };
}

// ============================================================
// 激活快照（生成入口冻结消费）
// ============================================================

/**
 * 组合当前生效子模式 + activation 记录为只读快照（requestBuilder 冻结 / 显示链消费）。
 * map（resolveActiveSubModeId）保持全系统读权威；activation 记录与 map 一致才附
 * revision/provenance，不一致（delegate/report/flowGroup 等 legacy 写者最后写入）→
 * activatedBy:"legacy_writer"、revision:null——诚实标注，不伪造版本。
 * @param {string} username
 * @param {string} charName - 预留（当前 map 键不含 char 维度；保留签名防调用点散改）
 * @param {string|null} chatId
 * @param {string} modeGroup - 当前生效模式（调用方已解析，如 resolveGenerationMode 产物）
 * @returns {{chatId:string|null, modeGroup:string, subModeId:string|null, label:string,
 *   revision:number|null, activatedBy:string|null, preset:object|null, requestProfile:object|null}}
 */
export function getActivationSnapshot(username, charName, chatId, modeGroup) {
  const cfg = loadJsonFileIfExists(getYonbanConfigPath(username), { sub_modes: [] });
  const subModeId = resolveActiveSubModeId(cfg, modeGroup, chatId) || null;
  const sm = subModeId ? (cfg.sub_modes || []).find((m) => m.id === subModeId) || null : null;
  const rec = (chatId && cfg.sub_mode_activations && cfg.sub_mode_activations[chatId]) || null;
  const recMatches = !!(rec && rec.subModeId === subModeId && rec.modeGroup === modeGroup);
  return {
    chatId: chatId || null,
    modeGroup,
    subModeId,
    label: sm?.label || subModeId || "",
    revision: recMatches ? rec.revision : null,
    activatedBy: recMatches ? rec.activatedBy : (subModeId ? "legacy_writer" : null),
    preset: recMatches
      ? rec.preset
      : (sm?.presetName ? { name: sm.presetName, provenance: "submode_default" } : null),
    requestProfile: sm ? resolveRequestProfile(sm) : null,
  };
}

/**
 * 预设引用只读校验（saveSubModes「只验证不制造」用；D2 只读 API 就绪后此处改为消费其 outcome）。
 * @returns {Array<{id:string, presetName:string}>} 缺失引用清单（非 builtin 且用户池不存在）
 */
export function listMissingPresetReferences(username, subModes) {
  const missing = [];
  for (const sm of subModes || []) {
    if (sm?.presetName && !hasPreset(username, sm.presetName)) {
      missing.push({ id: sm.id, presetName: sm.presetName });
    }
  }
  return missing;
}

/**
 * 变量持久化管理器（Phase 2D）
 *
 * 在父页面运行，管理所有 iframe 的变量读写。
 * 提供：
 * 1. 跨 iframe 变量同步（所有 iframe 共享同一份变量）
 * 2. 持久化到后端 chat 元数据（防抖保存）
 * 3. postMessage 通信桥接（iframe 内变量操作委托到此管理器）
 *
 * 使用方式（在 initSTCompat 中调用）：
 *   import { initVariableStore, getVariableStore } from './variableStore.mjs'
 *   initVariableStore()  // 注册 postMessage 监听
 *
 * 存储位置：
 * - global 变量 → localStorage (beilu-st-vars-global)
 * - character 变量 → localStorage (beilu-st-vars-char-{charId})
 * - chat 变量 → 运行时权威=内存 _vars.chat；localStorage + 后端用户文件 (chat_vars_{chatId}.json)
 *   是它的持久化输出（写扇出），后端仅在加载时回灌内存一次，非并列读源
 * - message 变量 → 内存（随 iframe 生命周期）
 * - preset 变量 → 真源=激活预设文件 preset_json.extensions.tavern_helper.variables
 *   （对齐酒馆助手 per-preset 契约，写回走 beilu-preset update_tavern_helper，导出随预设走）；
 *   localStorage 降为缓存（owner 已知按预设名分键，未知=旧全局单键=迁移期兼容读源）
 * - extension 变量 → localStorage (beilu-st-vars-extensions)
 * - script 变量 → localStorage (beilu-st-vars-scripts)
 */

import { createDiag } from "../shared/state/diagLogger.mjs";
import { storage, KEYS } from "../shared/state/storage.mjs"; // R2: localStorage 集中
import { sendAction } from "../shared/transport/sendAction.mjs"; // T8·切桥：writeUserFile/readUserFile 直连收口走门面（原 apiFetch 仅此两用点已切净删除）

const diag = createDiag("stCompat");

// ============================================================
// 变量存储
// ============================================================

/** @type {object} 变量数据 */
const _vars = {
  global: {},
  character: {},
  chat: {},
  messages: {},
  scripts: {},
  preset: {},
  extensions: {},
};

/** 是否有未保存的修改 */
let _dirty = false;

/** 保存防抖定时器 */
let _saveTimer = null;

/** 保存防抖延迟（ms） */
const SAVE_DEBOUNCE = 3000;

/** postMessage 监听器引用 */
let _messageHandler = null;

/** 当前聊天 ID（用于持久化） */
let _chatId = "";

/** 当前角色 ID（用于持久化） */
let _charId = "";

// ============================================================
// 公开接口
// ============================================================

/**
 * 初始化变量存储
 * 注册 postMessage 监听器，从 localStorage 加载已保存的变量
 *
 * @param {object} [options]
 * @param {string} [options.chatId=''] - 当前聊天 ID
 * @param {string} [options.charId=''] - 当前角色 ID
 */
export function initVariableStore(options = {}) {
  _chatId = options.chatId || "";
  _charId = options.charId || "";

  // 从 localStorage 加载
  _loadFromLocalStorage();
  _loadCharVarsFromBackend(); // [0807 §七#6] 角色卡为 character 变量真源，异步回灌
  _loadPresetVarsFromBackend(); // [0807 §七#6 preset 半] 激活预设为 preset 变量真源，异步回灌

  // 注册 postMessage 监听
  if (!_messageHandler) {
    _messageHandler = _handleMessage.bind(null);
    window.addEventListener("message", _messageHandler);
    diag.log("变量持久化管理器已初始化", { chatId: _chatId, charId: _charId });
  }

  // 挂载到 window 供 iframe 同步读取初始变量
  window.__beiluVarStore = _vars;

  if (!window.__beiluVarStoreCharBound) {
    window.__beiluVarStoreCharBound = true;
    window.addEventListener("beilu:char-changed", (e) => {
      const newCharId = e.detail?.charId || "";
      if (newCharId && newCharId !== _charId) {
        if (_dirty) _saveToLocalStorage();
        _charId = newCharId;
        Object.keys(_vars).forEach(k => { _vars[k] = {}; });
        _dirty = false;
        _loadFromLocalStorage();
        _loadCharVarsFromBackend(); // [0807 §七#6] 切卡后从新卡回灌
        _loadPresetVarsFromBackend(); // [0807 §七#6 preset 半] 切卡多随切聊天，线激活预设可能已变
      }
    });
  }

  if (!window.__beiluVarStorePresetBound) {
    window.__beiluVarStorePresetBound = true;
    // [0807 §七#6 preset 半] 切预设联动（对齐酒馆 OAI_PRESET_CHANGED_AFTER 刷新语义）：
    //   本窗 switchPreset → beilu:presetSwitched；WS 广播/别窗切换 → beilu:preset-changed。
    //   先按旧 owner 冲洗未落盘改动（_savePresetVarsToBackend 带 _target_preset 指名，防写进新预设），
    //   再按新激活预设回灌。序号令牌在 _loadPresetVarsFromBackend 内防回包乱序。
    const _onPresetChange = () => { _savePresetVarsToBackend(); _loadPresetVarsFromBackend(); };
    window.addEventListener("beilu:presetSwitched", _onPresetChange);
    window.addEventListener("beilu:preset-changed", _onPresetChange);
  }
}

/**
 * 销毁变量存储
 * 保存未持久化的变量，移除监听器
 */
export function destroyVariableStore() {
  if (_dirty) {
    _saveToLocalStorage();
  }
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (_messageHandler) {
    window.removeEventListener("message", _messageHandler);
    _messageHandler = null;
  }
  diag.log("变量持久化管理器已销毁");
}

/**
 * 获取指定作用域的变量
 *
 * @param {object} [option] - 变量选项
 * @param {string} [option.scope='chat'] - 作用域
 * @param {string} [option.key] - 特定变量 key（用于 message/script 作用域）
 * @returns {object} 变量对象
 */
export function getVariables(option = {}) {
  const scope = option.scope || "chat";
  const key = option.key || "";

  switch (scope) {
    case "global":
      return { ..._vars.global };
    case "character":
      return { ..._vars.character };
    case "chat":
      return { ..._vars.chat };
    case "message":
      return { ...(_vars.messages[key] || {}) };
    case "script":
      return { ...(_vars.scripts[key] || {}) };
    case "preset":
      return { ..._vars.preset };
    case "extension":
      return { ...(_vars.extensions[key] || {}) };
    default:
      return { ..._vars.chat };
  }
}

/**
 * 替换指定作用域的变量
 *
 * @param {object} variables - 新变量对象
 * @param {object} [option] - 变量选项
 * @param {string} [option.scope='chat'] - 作用域
 * @param {string} [option.key] - 特定变量 key
 */
export function replaceVariables(variables, option = {}) {
  const scope = option.scope || "chat";
  const key = option.key || "";

  switch (scope) {
    case "global":
      _vars.global = { ...variables };
      break;
    case "character":
      _vars.character = { ...variables };
      break;
    case "chat":
      _vars.chat = { ...variables };
      break;
    case "message":
      if (key) {
        _vars.messages[key] = { ...variables };
        // [0808 MVU 写回链收口·方案A] 楼层变量落后端（chatLog+timeLines.extension.mvu_variables）：
        //   此前 message 域是纯前端终点（bundle initCheck 初始化只到内存/面板），EJS 读侧
        //   （后端 mvu_accumulated）恒空="未知状态"根因（读写不同源，0808 凛倾真卡确诊）。
        //   key=楼层 index（tavernHelper setChatMessages / bundle replaceMvuData 的 message_id 同序）。
        _saveMessageVarsToBackend(key, _vars.messages[key]);
      }
      break;
    case "script":
      if (key) _vars.scripts[key] = { ...variables };
      break;
    case "preset":
      _vars.preset = { ...variables };
      break;
    case "extension":
      if (key) _vars.extensions[key] = { ...variables };
      break;
    default:
      _vars.chat = { ...variables };
  }

  _dirty = true;
  _scheduleSave();
}

/**
 * 获取所有作用域合并后的变量（用于 getAllVariables）
 *
 * 合并顺序（参考 JS-Slash-Runner _getAllVariables）：
 * global → character → preset → chat(默认变量) → messages(MVU变量按楼层累积)
 * 后面的同名 key 会覆盖前面的。
 *
 * @returns {object}
 */
export function getAllVariables() {
  const merged = {
    ..._vars.global,
    ..._vars.character,
    ..._vars.preset,
    ..._vars.chat,
  };

  // ★ 累积合并 messages 中的变量（按楼层号从小到大）
  // MVU 变量存在 messages 作用域中，每个楼层一个快照
  const msgKeys = Object.keys(_vars.messages)
    .map(Number)
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  for (const key of msgKeys) {
    const vars = _vars.messages[key];
    if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
      Object.assign(merged, vars);
    }
  }

  return merged;
}

/**
 * 清空 messages 作用域中的所有变量
 *
 * 在"重新对话"或切换聊天时调用，确保旧对话的 MVU 变量不会
 * 泄漏到新对话中。
 */
export function clearMessages() {
  _vars.messages = {};
  diag.debug("messages 作用域已清空");
}

/**
 * 更新当前上下文（角色/聊天切换时）
 *
 * @param {object} options
 * @param {string} [options.chatId]
 * @param {string} [options.charId]
 */
export function updateContext(options = {}) {
  // 先保存旧的
  if (_dirty) _saveToLocalStorage();

  if (options.chatId !== undefined) _chatId = options.chatId;
  if (options.charId !== undefined) _charId = options.charId;

  // 加载新的
  _loadFromLocalStorage();
  _loadCharVarsFromBackend(); // [0807 §七#6] 上下文切换后从卡回灌
  _loadPresetVarsFromBackend(); // [0807 §七#6 preset 半] 激活预设=per(chatid:mode)，切窗后按新线回灌
  diag.debug("变量上下文已更新", { chatId: _chatId, charId: _charId });
}

// ============================================================
// postMessage 通信处理
// ============================================================

/**
 * 处理来自 iframe 的变量操作 postMessage
 *
 * @param {MessageEvent} e
 */
function _handleMessage(e) {
  if (!e.data || !e.data.type) return;
  // N15：origin 校验（镜像 iframeRenderer.mjs:278）。srcdoc iframe origin="null"、同源=location.origin；拒其它=防任意 origin 改变量
  if (e.origin !== 'null' && e.origin !== window.location.origin) return;

  switch (e.data.type) {
    case "beilu-var-get": {
      // iframe 请求获取变量
      const vars = getVariables(e.data.option);
      try {
        e.source?.postMessage(
          {
            type: "beilu-var-response",
            requestId: e.data.requestId,
            variables: vars,
          },
          "*",
        );
      } catch {
        /* iframe 可能已销毁 */
      }
      break;
    }

    case "beilu-var-replace": {
      // iframe 请求替换变量
      replaceVariables(e.data.variables, e.data.option);
      diag.debug(
        "变量替换:",
        e.data.option?.scope || "chat",
        Object.keys(e.data.variables || {}).length,
        "个 key",
      );
      break;
    }

    case "beilu-var-get-all": {
      // iframe 请求获取所有合并变量
      const allVars = getAllVariables();
      try {
        e.source?.postMessage(
          {
            type: "beilu-var-response",
            requestId: e.data.requestId,
            variables: allVars,
          },
          "*",
        );
      } catch {
        /* iframe 可能已销毁 */
      }
      break;
    }

    case "beilu-var-update": {
      // iframe 请求部分更新变量（merge 而非 replace）
      const scope = e.data.option?.scope || "chat";
      const current = getVariables(e.data.option);
      const merged = { ...current, ...e.data.variables };
      replaceVariables(merged, e.data.option);
      break;
    }

    case "beilu-var-delete": {
      // iframe 请求删除变量
      const scope2 = e.data.option?.scope || "chat";
      const varName = e.data.varName;
      if (varName) {
        const current2 = getVariables(e.data.option);
        delete current2[varName];
        replaceVariables(current2, e.data.option);
      }
      break;
    }
  }
}

// ============================================================
// 持久化（localStorage）
// ============================================================

/**
 * 防抖保存
 */
function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveToLocalStorage();
    _saveTimer = null;
  }, SAVE_DEBOUNCE);
}

/**
 * 保存变量到 localStorage
 */
function _saveToLocalStorage() {
  try {
    // global 变量 — 全局共享
    storage.set(KEYS.BEILU_ST_VARS_GLOBAL, JSON.stringify(_vars.global));

    // character 变量 — 按角色存储
    if (_charId) {
      storage.set(
        `beilu-st-vars-char-${_charId}`,
        JSON.stringify(_vars.character),
      );
      // [0807 §七#6] 双写：角色卡本体为真源（契约表§1.1 🔴 导出即丢修复），localStorage 降为缓存
      _saveCharVarsToBackend();
    }

    // chat 变量 — 按聊天存储（localStorage + 后端双写）
    if (_chatId) {
      storage.set(
        `beilu-st-vars-chat-${_chatId}`,
        JSON.stringify(_vars.chat),
      );
      _saveChatVarsToBackend();
    }

    // preset 变量 — [0807 §七#6 preset 半] 真源=预设文件（_savePresetVarsToBackend 写回），
    //   localStorage 降为缓存：owner 已知按预设名分键（防跨预设串值），未知=旧全局单键（旧行为）
    storage.set(_presetVarsCacheKey(), JSON.stringify(_vars.preset));
    _savePresetVarsToBackend();

    // extension 变量 — 合并存储
    if (Object.keys(_vars.extensions).length > 0) {
      storage.set(KEYS.BEILU_ST_VARS_EXTENSIONS,
        JSON.stringify(_vars.extensions),
      );
    }

    // script 变量 — 合并存储
    if (Object.keys(_vars.scripts).length > 0) {
      storage.set(KEYS.BEILU_ST_VARS_SCRIPTS,
        JSON.stringify(_vars.scripts),
      );
    }

    _dirty = false;
    diag.debug("变量已保存到 localStorage", {
      global: Object.keys(_vars.global).length,
      character: Object.keys(_vars.character).length,
      chat: Object.keys(_vars.chat).length,
      preset: Object.keys(_vars.preset).length,
      extensions: Object.keys(_vars.extensions).length,
      scripts: Object.keys(_vars.scripts).length,
    });
  } catch (err) {
    diag.error("变量保存失败:", err.message);
  }
}

/**
 * 从 localStorage 加载变量
 */
function _loadFromLocalStorage() {
  try {
    // global
    const globalStr = storage.get(KEYS.BEILU_ST_VARS_GLOBAL);
    if (globalStr) _vars.global = JSON.parse(globalStr);

    // character
    if (_charId) {
      const charStr = storage.get(`beilu-st-vars-char-${_charId}`);
      if (charStr) _vars.character = JSON.parse(charStr);
      else _vars.character = {};
    }

    // chat — 先从 localStorage 加载（快），后台异步从后端回灌一次（持久化镜像，
    //   加载完成后运行时读写均以内存 _vars.chat 为权威，后端不再参与读）
    if (_chatId) {
      const chatStr = storage.get(`beilu-st-vars-chat-${_chatId}`);
      if (chatStr) _vars.chat = JSON.parse(chatStr);
      else _vars.chat = {};
      _loadChatVarsFromBackend();
    }

    // preset
    const presetStr = storage.get(KEYS.BEILU_ST_VARS_PRESET);
    if (presetStr) _vars.preset = JSON.parse(presetStr);
    else _vars.preset = {};

    // extensions
    const extStr = storage.get(KEYS.BEILU_ST_VARS_EXTENSIONS);
    if (extStr) _vars.extensions = JSON.parse(extStr);

    // scripts
    const scriptsStr = storage.get(KEYS.BEILU_ST_VARS_SCRIPTS);
    if (scriptsStr) _vars.scripts = JSON.parse(scriptsStr);

    diag.debug("变量已从 localStorage 加载", {
      global: Object.keys(_vars.global).length,
      character: Object.keys(_vars.character).length,
      chat: Object.keys(_vars.chat).length,
      preset: Object.keys(_vars.preset).length,
    });
  } catch (err) {
    diag.error("变量加载失败:", err.message);
  }
}

// ============================================================
// 后端持久化（chat 变量 — writeUserFile/readUserFile）
// ============================================================

function _chatVarsFilename() {
  if (!_chatId) return "";
  const safe = _chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `chat_vars_${safe}.json`;
}

// [0807 §七#6 character 半] 契约表§1.1 🔴"导出即丢"：酒馆把 character 变量写回角色卡本体
//   （character.data.extensions.tavern_helper.variables，导出随卡走，stside Q1 亲读证据），
//   beilu 此前只存 localStorage。写回走 updateChar 深合并（scriptManager 存脚本树同款范式），
//   后端 update-char 端点深合并 extensions → chardata.json。防抖由调用方 _scheduleSave 承担。
let _lastSavedCharVars = ""; // 上次写回卡的序列化值（防写放大：character 未变不 PUT 卡）
function _saveCharVarsToBackend() {
  if (!_charId) return;
  const _serialized = JSON.stringify(_vars.character);
  if (_serialized === _lastSavedCharVars) return;
  _lastSavedCharVars = _serialized;
  sendAction({ verb: "updateChar", target: "shells:chat", source: "web",
    payload: { charId: _charId, extensions: { tavern_helper: { variables: _vars.character } } },
  }).catch((err) => {
    diag.warn("character 变量写回角色卡失败:", err.message);
  });
}

// [0807 §七#6] 读侧同源：加载卡时从 chardata 的 extensions.tavern_helper.variables 灌 character 变量
//   （顶层优先、data. 兼容未解包 V3 —— scriptManager _loadScripts 同口径）。异步回灌一次，
//   与 chat 变量后端回灌同语义（契约表§1.1："后端只在加载时回灌一次，非并列读源"）。
function _loadCharVarsFromBackend() {
  if (!_charId) return;
  const cid = _charId;
  sendAction({ verb: "getCharDataQuiet", target: "shells:chat", source: "web", payload: { charId: cid } }).then((charData) => {
    if (cid !== _charId) return; // 回包期间已切卡，丢弃防串台
    const vars = charData?.extensions?.tavern_helper?.variables
      || charData?.data?.extensions?.tavern_helper?.variables;
    if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
      _vars.character = { ...vars };
      _lastSavedCharVars = JSON.stringify(_vars.character); // 回灌值=卡内已有值，标记已同步防原样回写
      storage.set(`beilu-st-vars-char-${cid}`, JSON.stringify(vars));
      diag.debug("character 变量已从角色卡加载:", Object.keys(vars).length, "个 key");
    }
  }).catch((err) => {
    diag.warn("character 变量从角色卡加载失败:", err.message);
  });
}

// [0807 §七#6 preset 半] 契约表§1.1 🔴"导出即丢"预设分量：酒馆把 preset 变量存进预设文件
//   （extensions.tavern_helper.variables，导出随预设走，JS-Slash-Runner variables.ts:78/164 亲读证据），
//   beilu 此前只存 localStorage 全局单份（无 per-preset 维度）。写回走 beilu-preset SetData
//   update_tavern_helper（_target_preset=owner 指名，防切换竞态写进别的预设）；读侧 GetData
//   preset_json（桥自动注入 chatid → 后端解析本窗口线激活预设，与生成读键同源）。
let _presetVarsOwner = ""; // 当前 _vars.preset 归属的预设名（写回指名锚；空=无激活预设，不写后端）
let _lastSavedPresetVars = ""; // 上次写回值（防写放大：未变不发请求）
let _presetVarsLoadSeq = 0; // 加载序号令牌（快速连续切换时丢弃过期回包，防串台）

function _presetVarsCacheKey() {
  return _presetVarsOwner ? `${KEYS.BEILU_ST_VARS_PRESET}--${_presetVarsOwner}` : KEYS.BEILU_ST_VARS_PRESET;
}

function _savePresetVarsToBackend() {
  if (!_presetVarsOwner) return; // 无激活预设=无归属文件，维持 localStorage 单键旧行为（诚实降级）
  const _serialized = JSON.stringify(_vars.preset);
  if (_serialized === _lastSavedPresetVars) return;
  _lastSavedPresetVars = _serialized;
  sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web",
    payload: { _target_preset: _presetVarsOwner, update_tavern_helper: { variables: _vars.preset } },
  }).catch((err) => {
    diag.warn("preset 变量写回预设失败:", err.message);
  });
}

function _loadPresetVarsFromBackend() {
  const _seq = ++_presetVarsLoadSeq;
  // getData 桥注入 chatid/charName → 后端下发本窗口线激活预设的 preset_json + active_preset_resolved
  sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" }).then((data) => {
    if (_seq !== _presetVarsLoadSeq) return; // 回包期间又触发过加载（切预设/切窗），丢弃防串台
    // owner 判定=sharedState.resolveCurrentPresetName 同口径：resolved 字段存在（含空串）即权威
    _presetVarsOwner = (typeof data?.active_preset_resolved === "string")
      ? data.active_preset_resolved
      : (data?.preset_name || "");
    const th = data?.preset_json?.extensions?.tavern_helper;
    if (th && Object.prototype.hasOwnProperty.call(th, "variables")) {
      _vars.preset = (th.variables && typeof th.variables === "object") ? { ...th.variables } : {};
    } else {
      // 字段缺席=该预设从未写过 tavern_helper → 旧全局单键迁移读兜底（首次变更写回即升级进预设文件）
      try {
        const legacy = storage.get(KEYS.BEILU_ST_VARS_PRESET);
        _vars.preset = legacy ? JSON.parse(legacy) : {};
      } catch { _vars.preset = {}; }
    }
    _lastSavedPresetVars = JSON.stringify(_vars.preset); // 回灌值=已同步态，防原样回写
    if (_presetVarsOwner) storage.set(_presetVarsCacheKey(), _lastSavedPresetVars);
    diag.debug("preset 变量已按激活预设加载:", _presetVarsOwner || "(无激活预设)", Object.keys(_vars.preset).length, "个 key");
  }).catch((err) => {
    diag.warn("preset 变量从预设加载失败:", err.message);
  });
}

// [0808 MVU 写回链收口] 按楼防抖写回（per-楼 300ms 合并连写；同楼覆盖语义与后端端点一致）
const _msgVarsTimers = new Map();
function _saveMessageVarsToBackend(floorKey, variables) {
  if (!_chatId) return;
  const idx = Number(floorKey);
  if (!Number.isSafeInteger(idx) || idx < 0) return; // 非楼号键（异常形态）不上后端
  if (_msgVarsTimers.has(floorKey)) clearTimeout(_msgVarsTimers.get(floorKey));
  const payload = variables; // 引用即可：发送时序列化当刻值
  _msgVarsTimers.set(floorKey, setTimeout(() => {
    _msgVarsTimers.delete(floorKey);
    fetch(`/api/parts/shells:chat/${encodeURIComponent(_chatId)}/message-vars`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: idx, variables: payload }),
    }).then((r) => { if (!r.ok) diag.warn("message 变量后端写回失败:", r.status); })
      .catch((e) => diag.warn("message 变量后端写回失败:", e.message));
  }, 300));
}

function _saveChatVarsToBackend() {
  const filename = _chatVarsFilename();
  if (!filename) return;
  const content = JSON.stringify(_vars.chat);
  // T8·切桥：raw 直连→sendAction 门面（memory 通配桥；reject 同被 .catch 接住=等价）
  sendAction({ verb: "writeUserFile", target: "plugins:beilu-memory", source: "web", payload: { filename, content } }).catch((err) => {
    diag.warn("chat 变量后端保存失败:", err.message);
  });
}

function _loadChatVarsFromBackend() {
  const filename = _chatVarsFilename();
  if (!filename) return;
  // T8·切桥：同上——sendAction 返回 unwrap 后裸 json（原 resp.ok+resp.json 两步并入门面；HTTP 失败走 .catch=等价原 !resp.ok 静默）
  sendAction({ verb: "readUserFile", target: "plugins:beilu-memory", source: "web", payload: { filename } }).then(async (j) => {
    if (!j.success || !j.content) return;
    try {
      const backendVars = JSON.parse(j.content);
      if (backendVars && typeof backendVars === "object") {
        _vars.chat = backendVars;
        storage.set(`beilu-st-vars-chat-${_chatId}`, j.content);
        diag.debug("chat 变量已从后端加载:", Object.keys(backendVars).length, "个 key");
      }
    } catch { /* 解析失败静默 */ }
  }).catch((err) => {
    diag.warn("chat 变量后端加载失败:", err.message);
  });
}

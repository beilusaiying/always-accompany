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
 * - preset 变量 → localStorage (beilu-st-vars-preset)
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
      }
    });
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
      if (key) _vars.messages[key] = { ...variables };
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
    }

    // chat 变量 — 按聊天存储（localStorage + 后端双写）
    if (_chatId) {
      storage.set(
        `beilu-st-vars-chat-${_chatId}`,
        JSON.stringify(_vars.chat),
      );
      _saveChatVarsToBackend();
    }

    // preset 变量
    storage.set(KEYS.BEILU_ST_VARS_PRESET, JSON.stringify(_vars.preset));

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

/**
 * featureControls.mjs — 功能控件绑定 + 运行时参数同步
 *
 * 功能链：
 *   右栏开关 UI（渲染器/流式/预填充/后处理/上下文限制等）→ localStorage 持久化
 *   → syncRuntimeParams() → POST beilu-preset/config/runtime-params → 后端生效
 *   → 派发 beilu:runtime-params-changed 事件通知其它模块
 *   聊天宽度 → applyChatWidth → 根级 CSS 变量 --beilu-chat-width（0712 弃 inline 根治双写；字体链在 settingsSlots initUiSlot 写 --beilu-font-size）
 *   模式切换 → 只切后端 data + 记忆表格背景（T040b/0716 凛倾定案：不联动切换/应用任何预设，「绑定」概念已删；
 *     预设隔离由后端生成时按 active_preset_map[cid:mode] 自主解析，应用只在用户/AI 的切换动作）
 *
 * why：
 *   统一收口所有运行时参数的写入路径，避免各控件直接散写 localStorage 或直接 fetch；
 *   model/api_source 按角色作用域覆盖（N37），须携带 charName 让后端写 model_overrides_by_char；
 *   window._beiluSyncRuntimeParams 全局桥供 subModePanel 等不 import 此模块的调用方使用。
 *
 * 关联链：
 *   ← index.mjs（initFeatureControls 调用入口）
 *   ← subModePanel.mjs（通过 window._beiluSyncRuntimeParams 调用）
 *   → tokenProgressBar.mjs（initTokenProgressBar 在此调用）
 *   → beilu-preset 插件后端（/api/parts/plugins:beilu-preset/config/runtime-params）
 *   → shared/state/storage.mjs（KEYS 常量集中管理 localStorage）
 *   → shared/transport/api-client.mjs（apiFetch：统一 timeout+401）
 *
 * 影响范围：
 *   所有依赖 runtime-params 的后端逻辑（模型选择/预设/上下文限制）；
 *   所有监听 beilu:runtime-params-changed 的前端模块（tokenProgressBar 等）；
 *   CSS 变量 --beilu-font-size / --beilu-chat-width 影响全局聊天区排版。
 *
 * 使用效果：
 *   右栏开关改动即时同步后端；
 *   字体/宽度设置即时生效无需刷新。
 */

import { charList } from "../../shared/chat-core/chat.mjs";
import { initTokenProgressBar } from "../../shared/widgets/tokenProgressBar.mjs";
import { getCharId, isValidChatId } from "../../shared/state/sharedState.mjs"; // T040b：getPresetName 随预设联动移除，不再引入
import { showToast as _publicToast } from "../../../../../../scripts/toast.mjs";
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b 首收口：出向统一门面（verb=真动作，失败统一报错可见；apiFetch 经门面内部走，本文件不再直连）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { DEFAULTS } from "../../config/defaults.mjs"; // T6：cleanup 模式缺省单源（第三处 `|| "auto"` 副本收口，同 settings/layout）
import { setParamSchema, setEnumSchema } from "../../shared/state/paramSchemaCache.mjs"; // 链路2：param_schema/enum_schema 会话缓存写入端
import { initWebSearchPanel, applyWebSearchDisplays } from "./webSearchPanel.mjs"; // [0717 显示同步收口] 联网显示点回填单源（原本文件内联版漏 menu-web-search=≡菜单开关永 stale）
import { TAB_TO_MODE } from "../../shared/state/modeTabMap.mjs"; // [0716 对账修] 视图轴→模式轴映射单源（纯常量可安全 import）

// ============================================================
// 工具：runtime-params 同步
// ============================================================

/**
 * 同步运行时参数到后端 beilu-preset 插件
 * @param {Object} params - 要更新的参数
 */
// P0-1（一致性审计③双键失步）：返回 true/false 供调用方「后端确认才落本地」；
//   失败默认弹可见 error toast（原 warning 文案"刷新可恢复"具误导性——本地新值刷新后仍在，后端仍旧值）。
//   opts.quiet=true 供页面加载时的 bootstrap 推送使用（本地即意图源，失败只 warn 不打扰开机）。
export async function syncRuntimeParams(params, { quiet = false } = {}) {
  try {
    // N37：model/api_source 是按角色作用域的覆盖单元——统一补当前角色名，
    // 后端据此写 model_overrides_by_char["<user>/<char>"]（取不到角色=落全局键，行为同改前）。
    const _body = { ...params };
    if (!_body.chatId) {
      // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——
      //   非法 hash（分段气泡/IDE 内部锚点）返 ""，不再裸读 substring 当 chatid 送后端 setRuntimeParams 分区键。
      //   对齐 cardsPanel.mjs:62 _cur()/idePanel.mjs:109 范式（window 全局桥单源，无需新增 import）。
      _body.chatId = window._beiluGetChatId?.() || "";
    }
    if ((_body.model !== undefined || _body.api_source !== undefined) && _body.charName === undefined) {
      const _cn = _getCharId();
      if (_cn) _body.charName = _cn;
    }
    await sendAction({ verb: "setRuntimeParams", target: "plugins:beilu-preset", source: "web", payload: _body, scope: { chatId: _body.chatId } }); // T6b：!ok 抛错由门面统一（含报错可见）
    window.dispatchEvent(new CustomEvent("beilu:runtime-params-changed", { detail: params }));
    return true;
  } catch (err) {
    console.warn("[featureControls] 同步 runtime-params 失败:", err.message);
    if (!quiet) {
      try { _publicToast("error", "参数未写入后端，已回退显示: " + err.message); } catch {}
    }
    return false;
  }
}
// 暴露给不 import featureControls 的模块（subModePanel 等）统一走此入口
window._beiluSyncRuntimeParams = syncRuntimeParams;

// ============================================================
// P2（一致性审计①散写收 setter）：多 UI 入口共享键的唯一写点。
//   病根：三个 cleanup select / 三个消息加载数 input 各自 storage.set + 手工同步兄弟控件，
//   featureControls 自己的入口甚至不同步兄弟（改它→另两处显示 stale）。收口后入口只调 setter。
// ============================================================
/** 清理模式唯一写点：写键 + 同步全部三个入口控件显示（ui-cleanup-mode / cleanup-mode-select / ide-cleanup-mode） */
export function setCleanupMode(value) {
  storage.set(KEYS.BEILU_CLEANUP_MODE, value);
  for (const id of ["ui-cleanup-mode", "cleanup-mode-select", "ide-cleanup-mode"]) {
    const el = document.getElementById(id);
    if (el && el.value !== value) el.value = value;
  }
}
/** 消息加载数唯一写点：归一化（int，0..1000，非法回落 DEFAULTS）+ 写键 + 同步三个入口 input */
export function setMsgLoadLimit(value) {
  const n = parseInt(value, 10);
  const v = String(Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : DEFAULTS.messages.loadLimit);
  storage.set(KEYS.BEILU_MSG_LOAD_LIMIT, v);
  for (const id of ["bk-msg-load-limit", "menu-msg-load-limit", "msg-load-limit"]) {
    const el = document.getElementById(id);
    if (el && el.value !== v) el.value = v;
  }
  return v;
}
/** 布尔渲染开关唯一写点的共同体：幂等（值未变=只对齐控件显示，不写键不重渲染）+
 *  写键 + 同步全部入口控件 checked + reloadBeautify 重渲染已上屏消息。
 *  病根（0713 病灶审计 A1/A4）：airp 入口只写键不重渲染=改了不生效；W28 入口写键后不回同步兄弟 checked。 */
function _setRenderToggle(storageKey, controlIds, enabled, name) {
  const val = enabled ? "true" : "false";
  for (const id of controlIds) {
    const el = document.getElementById(id);
    if (el && el.checked !== !!enabled) el.checked = !!enabled;
  }
  if (storage.get(storageKey) === val) return; // 幂等：无变化不写键不重渲染（调用方无需自带守卫）
  storage.set(storageKey, val);
  import("../../shared/render/virtualQueue.mjs")
    .then(m => m.reloadBeautify?.(30))
    .catch(err => console.warn(`[featureControls] ${name} reloadBeautify 失败:`, err));
}
/** 正则处理器开关唯一写点（消费方 displayRegex.applyDisplayRules） */
export function setRegexEnabled(enabled) {
  _setRenderToggle(KEYS.BEILU_REGEX_ENABLED, ["toggle-regex", "ds-regex"], enabled, "setRegexEnabled");
}
// setThinkingFoldEnabled 已删（0720 硬化）：凛倾硬性核心「人类必须看得到」——
//   思维链折叠块恒渲染（messageList）,开关 UI/存储键 BEILU_THINKING_FOLD 同批删除。
// 桥给不 import 本模块的调用方（settings.mjs / idePanel.mjs / backup.mjs / settingsSlots.mjs / extendMenuW28.mjs）
window._beiluSetCleanupMode = setCleanupMode;
window._beiluSetMsgLoadLimit = setMsgLoadLimit;
window._beiluSetRegexEnabled = setRegexEnabled;

// window._beiluPublicShowToast 二级桥已删（0716 轮子收口）：与 index.mjs:157 _beiluToast 同源双桥，
// 原 8 消费点（smart×2/subModePanel×2/extendMenuW28×4）已全部改直接 import toast.mjs 单源。

// ============================================================
// CSS 工具
// ============================================================

/**
 * 应用字体比例到聊天消息区域
 * 通过更新 CSS 变量 --beilu-font-size 实现
 * @param {string|number} percent - 百分比值 (50-200)
 */
// applyFontScale 已删（0712 打架扫描：全根零调用死代码；真实字体链=settingsSlots initUiSlot
// 写 CSS 变量 --beilu-font-size。留着会诱发 inline fontSize 覆盖 var() 继承的双写冲突）。

/**
 * 应用聊天宽度（0712 根治打架对A）：弃 inline style，改写根级 CSS 变量 --beilu-chat-width。
 * 【why】旧版直写 #chat-container.style.maxWidth——inline 永久压过一切 CSS 规则：
 *   用户调过滑块后切到 smart，smart 的 max(820px,85%) 规则被残留 inline 覆盖；
 *   反之 init 链异常时 inline 缺席、固定钳制顶上（凛倾 0712「为什么不跟随放大」根因链）。
 *   CSS 变量单层（对齐字体链 settingsSlots:541 先例）：=100 移除变量回各模式默认
 *   （smart=max(820px,85%)，其余=全宽），<100 全模式统一钳用户值。
 * @param {string|number} percent - 百分比值 (30-100)
 */
export function applyChatWidth(percent) {
  const val = parseInt(percent);
  if (!Number.isFinite(val) || val >= 100) {
    document.documentElement.style.removeProperty("--beilu-chat-width");
  } else {
    document.documentElement.style.setProperty("--beilu-chat-width", val + "%");
  }
  // 清旧版 inline 残留（升级路径：老会话 DOM 上可能还挂着直写值，不清则新机制被压制）
  const chatContainer = document.getElementById("chat-container");
  if (chatContainer) {
    chatContainer.style.maxWidth = "";
    chatContainer.style.width = "";
    chatContainer.style.alignSelf = "";
  }
}

// T072a（可操作处禁硬编码）：搜索引擎下拉的选项集从后端单源（webSearch.mjs SUPPORTED_ENGINES）
//   经 GetData.web_search_engines 下发渲染，替代 index.html 两处静态 <option> 副本。
//   退化：后端未下发/空数组 → 保留 HTML 静态 option 不动（离线/旧后端零回归）。
function _renderSearchEngineOptions(engines) {
  if (!Array.isArray(engines) || engines.length === 0) return; // 退化：保留静态 option
  [document.getElementById("select-search-engine"), document.getElementById("menu-search-engine")]
    .filter(Boolean).forEach(sel => {
      const cur = sel.value; // 保留当前选中值
      sel.innerHTML = "";
      for (const e of engines) {
        if (!e || typeof e.value !== "string") continue;
        const opt = document.createElement("option");
        opt.value = e.value;
        opt.textContent = e.label || e.value;
        sel.appendChild(opt);
      }
      // 恢复原选中值（若仍在清单内），否则回落首项（浏览器默认）
      if (cur && engines.some(e => e && e.value === cur)) sel.value = cur;
    });
}

// 链路2（2026-07-08 可操作处禁硬编码）：参数控件 min/max/step 从后端 param_schema 单源覆盖
//   （paramSchema.mjs 经 GetData 下发），HTML 静态属性只作离线/旧后端退化，与
//   _renderSearchEngineOptions 同范式。只覆盖值域元数据，不动 value（value=用户当前值）。
const _PARAM_SCHEMA_DOM = [
  ["temperature", "param-temp"],
  ["top_p", "param-top-p"],
  ["top_k", "param-top-k"],
  ["min_p", "param-min-p"],
  ["max_context", "param-max-context"],
  ["max_tokens", "param-max-tokens"],
  // thinking_budget 行已删（2026-08-01 收口：思维链控制唯一入口=AI 源面板 per-源设置）
  ["frequency_penalty", "param-frequency-penalty"], // T11-A：min/max/step 从 PARAM_SCHEMA 单源覆盖
  ["presence_penalty", "param-presence-penalty"],   // T11-A
];
function _applyParamSchema(schema) {
  if (!schema || typeof schema !== "object") return; // 退化：保留 HTML 静态值域
  setParamSchema(schema); // 会话级缓存：供动态构造的表单（子模式等）构造后自取
  for (const [key, elId] of _PARAM_SCHEMA_DOM) {
    const meta = schema[key];
    const el = document.getElementById(elId);
    if (!meta || !el) continue;
    if (Number.isFinite(meta.min)) el.min = String(meta.min);
    if (Number.isFinite(meta.max)) el.max = String(meta.max);
    if (Number.isFinite(meta.step)) el.step = String(meta.step);
    // [0727 凛倾「那些参数,默认值需要给一个,好参考」] 参考值单源=后端 PARAM_SCHEMA.default
    //   （getData param_schema 下发，前端零硬编码）。数字框接 placeholder（直接可见），
    //   滑条/下拉接 title（hover 可见）；旧占位"默认"二字升级为带数值。
    if (meta.default !== undefined && meta.default !== null) {
      const _hint = `默认 ${meta.default}${Number.isFinite(meta.min) && Number.isFinite(meta.max) ? `（${meta.min}–${meta.max}）` : ""}`;
      el.title = _hint;
      if (el.tagName === "INPUT" && el.type === "number" && (!el.placeholder || el.placeholder === "默认")) el.placeholder = `默认 ${meta.default}`;
    }
  }
}

// 0714 enum_schema 接线（病型大扫·前后端对齐③-B 半接线修）：主面板 pp/prefill 下拉选项集
//   从后端 ENUM_SCHEMA 重建——此前只有 subModePanel/YonBan 表单接了下发，主面板靠 HTML 静态
//   option（后端改选项集=主面板不跟，三处第 3 口漂移）。HTML 静态项作离线/旧后端退化。
//   空项策略归表单（paramSchema.mjs :84 约定）：prefill 的 "off" 是本表单自身关闭项，保留在首位。
function _applyEnumSchema(schema) {
  if (!schema || typeof schema !== "object") return; // 退化：保留 HTML 静态选项
  setEnumSchema(schema); // 会话缓存：供其他动态表单自取（与 setParamSchema 同范式）
  const rebuild = (elId, key, keepFirstStatic) => {
    const el = document.getElementById(elId);
    const opts = schema[key]?.options;
    if (!el || !Array.isArray(opts) || !opts.length) return;
    const prev = el.value;
    const firstStatic = keepFirstStatic ? el.options[0] : null;
    el.innerHTML = "";
    if (firstStatic) el.appendChild(firstStatic);
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.title) opt.title = o.title;
      el.appendChild(opt);
    }
    if (prev && [...el.options].some((x) => x.value === prev)) el.value = prev;
  };
  rebuild("param-post-processing", "prompt_post_processing", false); // schema 含 none=全集
  rebuild("param-claude-prefill-mode", "claude_prefill_mode", true); // off=表单自身关闭项
}

async function _syncWebSearchFromBackend() {
  const charId = getCharId();
  if (!charId) return;
  try {
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" }); // T6b
    // [0717 async-order guard, audit H2] rapid char switching: a slow response fetched for
    // the previous char must not repaint toggles/engine options after the char changed
    // (each char-changed fires a fresh call which will paint the right values).
    if (getCharId() !== charId) return;
    // 先渲染引擎选项集（后端单源），再回填当前值——顺序不可反，否则 value 设不到未渲染的 option 上。
    _renderSearchEngineOptions(data?.web_search_engines);
    // 参数控件值域覆盖（后端单源），顺序不敏感（不动 value）
    _applyParamSchema(data?.param_schema);
    // 枚举选项集重建（后端单源），保持当前选中值
    _applyEnumSchema(data?.enum_schema);
    const ws = data?.config?.web_search || {};
    // [0717 显示同步收口] 显示点回填走 webSearchPanel.applyWebSearchDisplays 单源——原此处内联版
    //   只写 #toggle-web-search 漏 #menu-web-search：≡菜单开关从不吃后端权威值=永远 stale
    //   （凛倾截图实证：菜单显示"关"、面板/后端 enabled=true，P8 照常自动帮搜=显示欺骗用户）。
    // [0713 病灶审计 B1/B2] localStorage 镜像缓存已删（死镜像）；后端 config.web_search 即单源。
    applyWebSearchDisplays(ws);
  } catch { /* 同步失败保持本地值 */ }
}

// 浏览器感知开关已删（2026-07-16）：beilu-browser 插件整体移除（开关 DOM/回填/写入全链同批删）。

// ============================================================
// 主初始化
// ============================================================

/**
 * 初始化右栏功能控件的事件绑定和 localStorage 持久化
 */
export function initFeatureControls() {
  // T027：原 #thinking-fold-tags 绑定段已删——该元素是 index.html 里的 type=hidden 幽灵输入
  //   （全库无人写 value/dispatch change，死代码），且它纯写 localStorage 不落后端单源，
  //   与 hide#setReasoningTags 写单点（extendMenuW28/tokenProgressBar 均已收口）口径冲突。

  // 思维链折叠开关已全线删除（0714 收口→0720 硬化）：人类侧恒可见,无隐藏开关。

  // --- 渲染器开关 ---
  const rendererToggle = document.getElementById("toggle-renderer");
  if (rendererToggle) {
    const saved = storage.get(KEYS.BEILU_RENDERER_ENABLED);
    if (saved !== null) rendererToggle.checked = saved !== "false";
    rendererToggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_RENDERER_ENABLED, rendererToggle.checked);
    });
  }

  // --- 代码折叠开关 ---
  const codeFoldToggle = document.getElementById("toggle-code-fold");
  if (codeFoldToggle) {
    const saved = storage.get(KEYS.BEILU_CODE_FOLD_ENABLED);
    if (saved !== null) codeFoldToggle.checked = saved === "true";
    codeFoldToggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_CODE_FOLD_ENABLED, codeFoldToggle.checked);
    });
  }

  // --- 代码折叠模式 ---
  const codeFoldMode = document.getElementById("code-fold-mode");
  if (codeFoldMode) {
    const saved = storage.get(KEYS.BEILU_CODE_FOLD_MODE);
    if (saved) codeFoldMode.value = saved;
    codeFoldMode.addEventListener("change", () => {
      storage.set(KEYS.BEILU_CODE_FOLD_MODE, codeFoldMode.value);
    });
  }

  // --- 流式渲染开关 ---
  const streamRenderToggle = document.getElementById("toggle-stream-render");
  if (streamRenderToggle) {
    const saved = storage.get(KEYS.BEILU_STREAM_RENDER_ENABLED);
    if (saved !== null) streamRenderToggle.checked = saved === "true";
    streamRenderToggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_STREAM_RENDER_ENABLED,
        streamRenderToggle.checked,
      );
    });
  }

  // --- 渲染深度 ---
  const renderDepth = document.getElementById("render-depth");
  if (renderDepth) {
    const saved = storage.get(KEYS.BEILU_RENDER_DEPTH);
    if (saved) renderDepth.value = saved;
    renderDepth.addEventListener("change", () => {
      storage.set(KEYS.BEILU_RENDER_DEPTH, renderDepth.value);
    });
  }

  // --- 消息加载限制 ---
  const msgLoadLimit = document.getElementById("menu-msg-load-limit");
  if (msgLoadLimit) {
    const saved = storage.get(KEYS.BEILU_MSG_LOAD_LIMIT);
    if (saved) msgLoadLimit.value = saved;
    msgLoadLimit.addEventListener("change", () => {
      setMsgLoadLimit(msgLoadLimit.value); // P2：唯一写点（归一化+同步兄弟入口）
    });
  }

  // --- 上下文屏蔽 ---
  const contextMsgLimit = document.getElementById("menu-context-msg-limit");
  if (contextMsgLimit) {
    const saved = storage.get(KEYS.BEILU_CONTEXT_MSG_LIMIT);
    if (saved) contextMsgLimit.value = saved;
    // P0-1：后端确认才落本地，失败回读旧值（杜绝 UI 新值/后端旧值静默失步；对齐 security.mjs 控件范式）
    contextMsgLimit.addEventListener("change", async () => {
      const prev = storage.get(KEYS.BEILU_CONTEXT_MSG_LIMIT);
      const val = parseInt(contextMsgLimit.value) || 0;
      contextMsgLimit.disabled = true;
      const ok = await syncRuntimeParams({ context_msg_limit: val });
      contextMsgLimit.disabled = false;
      if (ok) storage.set(KEYS.BEILU_CONTEXT_MSG_LIMIT, val);
      else contextMsgLimit.value = prev ?? "";
    });
    // 页面加载时同步一次（bootstrap：本地即意图源，失败仅 warn）
    syncRuntimeParams({
      context_msg_limit: parseInt(contextMsgLimit.value) || 0,
    }, { quiet: true });
  }

  // --- 流式输出开关 ---
  const streamToggle = document.getElementById("param-stream");
  if (streamToggle) {
    const saved = storage.get(KEYS.BEILU_STREAM_ENABLED);
    if (saved !== null) streamToggle.checked = saved !== "false";
    streamToggle.addEventListener("change", async () => {
      const want = streamToggle.checked;
      streamToggle.disabled = true;
      const ok = await syncRuntimeParams({ stream: want });
      streamToggle.disabled = false;
      if (ok) storage.set(KEYS.BEILU_STREAM_ENABLED, want);
      else streamToggle.checked = !want;
    });
    syncRuntimeParams({ stream: streamToggle.checked }, { quiet: true });
  }

  // --- 通用预填充开关 ---
  const prefillToggle = document.getElementById("param-prefill-toggle");
  if (prefillToggle) {
    const saved = storage.get(KEYS.BEILU_PREFILL_ENABLED);
    if (saved !== null) prefillToggle.checked = saved === "true";
    prefillToggle.addEventListener("change", async () => {
      const want = prefillToggle.checked;
      prefillToggle.disabled = true;
      const ok = await syncRuntimeParams({ prefill_enabled: want });
      prefillToggle.disabled = false;
      if (ok) storage.set(KEYS.BEILU_PREFILL_ENABLED, want);
      else prefillToggle.checked = !want;
    });
    syncRuntimeParams({ prefill_enabled: prefillToggle.checked }, { quiet: true });
  }

  // --- 尾部预填充模式下拉（全渠道通用，键名 claude_prefill_mode 为历史遗留） ---
  const claudePrefillSelect = document.getElementById(
    "param-claude-prefill-mode",
  );
  if (claudePrefillSelect) {
    // ★ 从localStorage读取，旧值自动迁移到四模式（off/prefill=尾部assistant原样/to_user=直改user
    //   （旧名claude，自造名词已正名）/user_assistant=改user+assistant:引导）
    const saved = storage.get(KEYS.BEILU_CLAUDE_PREFILL_MODE);
    const _migrateMap = { "wrap_system": "to_user", "append_user": "to_user", "keep": "prefill", "claude": "to_user" };
    const _migrated = _migrateMap[saved] || saved;
    if (_migrated && ["off", "prefill", "to_user", "user_assistant"].includes(_migrated)) {
      claudePrefillSelect.value = _migrated;
      if (_migrated !== saved) storage.set(KEYS.BEILU_CLAUDE_PREFILL_MODE, _migrated);
    } else {
      claudePrefillSelect.value = "off";
      storage.set(KEYS.BEILU_CLAUDE_PREFILL_MODE, "off");
    }
    claudePrefillSelect.addEventListener("change", async () => {
      const prev = storage.get(KEYS.BEILU_CLAUDE_PREFILL_MODE) || "off";
      const mode = claudePrefillSelect.value;
      claudePrefillSelect.disabled = true;
      const ok = await syncRuntimeParams({ claude_prefill_mode: mode });
      claudePrefillSelect.disabled = false;
      if (ok) storage.set(KEYS.BEILU_CLAUDE_PREFILL_MODE, mode);
      else claudePrefillSelect.value = prev;
      // （2026-07-08 删除旧"非 off 自动切 strict"联动——与双库 display.mjs 同批的第三入口：
      //   预填充尾部处理已收敛到后端 patchBodyForClaude，与 pp 无关；联动悄悄把 pp 写成
      //   strict 落 localStorage+runtime_params，strict=首条以外 system 全转 user 效力全失）
    });
    syncRuntimeParams({
      claude_prefill_mode: claudePrefillSelect.value || "off",
    }, { quiet: true });
  }

  // --- 提示词后处理下拉框 ---
  const postProcessingSelect = document.getElementById("param-post-processing");
  if (postProcessingSelect) {
    // 2026-07-08 枚举收口迁移（凛倾:「后处理只有3个模式,合并,严格,半严格」）：
    // 旧 "claude"（预填充概念泄漏进 pp）→ merge、旧 "single"（全 user）→ strict。
    // 选项已从下拉删除，不迁移则 select.value 设不上（空选中）且初始化推送把旧值推回全局。
    const _ppSaved = storage.get(KEYS.BEILU_POST_PROCESSING);
    const _ppLegacy = { claude: "merge", single: "strict" };
    const saved = _ppLegacy[_ppSaved] || _ppSaved;
    if (saved && saved !== _ppSaved) storage.set(KEYS.BEILU_POST_PROCESSING, saved);
    // P1-1：无本地值时显式落后端默认（preset/main.mjs RUNTIME_PARAMS_DEFAULTS.prompt_post_processing），
    //   不再依赖 HTML selected 位置的巧合——前后端默认单点对齐
    // T15-1：字面量 "none" 副本收口进 DEFAULTS.runtimeParams.postProcessing 单源（前端零字面量）
    postProcessingSelect.value = saved || DEFAULTS.runtimeParams.postProcessing;
    postProcessingSelect.addEventListener("change", async () => {
      const prev = storage.get(KEYS.BEILU_POST_PROCESSING);
      const val = postProcessingSelect.value;
      postProcessingSelect.disabled = true;
      const ok = await syncRuntimeParams({ prompt_post_processing: val });
      postProcessingSelect.disabled = false;
      if (ok) storage.set(KEYS.BEILU_POST_PROCESSING, val);
      else if (prev) postProcessingSelect.value = prev;
    });
    syncRuntimeParams({ prompt_post_processing: postProcessingSelect.value }, { quiet: true });
  }

  // （2026-07-08 删"继续预填充"假开关：beilu 无 ST 式 continue 生成功能，continue_prefill
  //   全链零消费死键——写入齐全无任何读者。功能若将来实现再随功能加回。）

  // --- 模式切换清理设置 ---
  const cleanupModeSelect = document.getElementById("cleanup-mode-select");
  if (cleanupModeSelect) {
    const saved = storage.get(KEYS.BEILU_CLEANUP_MODE);
    if (saved) cleanupModeSelect.value = saved;
    cleanupModeSelect.addEventListener("change", () => {
      setCleanupMode(cleanupModeSelect.value); // P2：唯一写点（原来这里不同步兄弟控件=显示 stale 实害）
    });
  }

  // --- 联网设置收口到悬浮窗（webSearchPanel.mjs 唯一写入点） ---
  // ≡菜单 toggle/engine + 右栏 toggle/engine 改为只读显示，点击打开悬浮窗。
  // 后端同步只读：_syncWebSearchFromBackend 拉后端权威值回填 DOM。
  const _openWsPanel = () => {
    const btn = document.getElementById("open-web-search-settings");
    if (btn) btn.click();
  };
  [document.getElementById("toggle-web-search"), document.getElementById("menu-web-search")].filter(Boolean).forEach(t => {
    t.addEventListener("click", (e) => { e.preventDefault(); _openWsPanel(); });
  });
  [document.getElementById("select-search-engine"), document.getElementById("menu-search-engine")].filter(Boolean).forEach(s => {
    s.addEventListener("mousedown", (e) => { e.preventDefault(); _openWsPanel(); });
  });

  _syncWebSearchFromBackend();
  window.addEventListener("beilu:char-changed", () => _syncWebSearchFromBackend());
  // [0717 跨窗口同步] 别窗保存联网设置 → ws 广播 → 本窗重拉回填（信号不带全量，重拉读落盘真值）
  window.addEventListener("beilu:webSearchConfigChanged", () => _syncWebSearchFromBackend());

  initWebSearchPanel();


  // --- 聊天宽度滑块 ---
  const chatWidth = document.getElementById("chat-width");
  const chatWidthValue = document.getElementById("chat-width-value");
  if (chatWidth) {
    const saved = storage.get(KEYS.BEILU_CHAT_WIDTH);
    if (saved) chatWidth.value = saved;
    if (chatWidthValue) chatWidthValue.textContent = chatWidth.value + "%";
    applyChatWidth(chatWidth.value);

    chatWidth.addEventListener("input", () => {
      const val = chatWidth.value;
      storage.set(KEYS.BEILU_CHAT_WIDTH, val);
      if (chatWidthValue) chatWidthValue.textContent = val + "%";
      applyChatWidth(val);
    });
  }

  // B6 修复：已删除 initModePresetBindings() 调用
  // 根据主人要求，"模式切换绑定预设"功能不再需要

  // --- 编程模式切换 ---
  initModeSwitch();

  // --- 后端推送 → 前端控件反向同步 ---
  // why: 所有 runtime-params 控件只做写出（用户改 → POST 后端），不监听后端推送。
  //   当后端主动改参数（子模式切换/AI驱动/websocket 广播）时，前端控件不更新，
  //   用户下次手动操作时会把旧值覆写回去。设 DOM 值不触发 change 事件，无循环风险。
  window.addEventListener("beilu:runtime-params-changed", (e) => {
    const p = e.detail;
    if (!p) return;
    if (p.stream !== undefined) {
      const el = document.getElementById("param-stream");
      if (el) { el.checked = !!p.stream; storage.set(KEYS.BEILU_STREAM_ENABLED, el.checked); }
    }
    if (p.prefill_enabled !== undefined) {
      const el = document.getElementById("param-prefill-toggle");
      if (el) { el.checked = !!p.prefill_enabled; storage.set(KEYS.BEILU_PREFILL_ENABLED, el.checked); }
    }
    if (p.claude_prefill_mode !== undefined) {
      const el = document.getElementById("param-claude-prefill-mode");
      if (el) { el.value = p.claude_prefill_mode; storage.set(KEYS.BEILU_CLAUDE_PREFILL_MODE, el.value); }
    }
    if (p.prompt_post_processing !== undefined) {
      const el = document.getElementById("param-post-processing");
      if (el) { el.value = p.prompt_post_processing; storage.set(KEYS.BEILU_POST_PROCESSING, el.value); }
    }
    // T023 Q3 补齐：数值滑块类回灌（元素在 preset 面板，id 全局可查）。
    // 哨兵约定：-1/null=未设置不回灌（YonBan _rtParams 用 -1 表"不覆盖"），max 类 0 同哨兵。
    const _numMap = [
      ["temperature", "param-temp", "param-temp-value"],
      ["top_p", "param-top-p", "param-top-p-value"],
      ["top_k", "param-top-k", "param-top-k-value"],
      ["min_p", "param-min-p", "param-min-p-value"],
      ["openai_max_context", "param-max-context", null],
      ["openai_max_tokens", "param-max-tokens", null],
    ];
    for (const [field, elId, valId] of _numMap) {
      const v = p[field];
      if (v === undefined || v === null || Number(v) < 0) continue;
      if ((field === "openai_max_context" || field === "openai_max_tokens") && Number(v) === 0) continue;
      const el = document.getElementById(elId);
      if (el) {
        el.value = v;
        if (valId) { const vl = document.getElementById(valId); if (vl) vl.textContent = String(v); }
      }
    }
  });

  // --- Token 进度条 ---
  initTokenProgressBar();
}

// ============================================================
// 编程模式切换
// ============================================================

/** 当前模式状态（从 localStorage 同步读取，避免 reload 后丢失） */
const _MODE_STORAGE_KEY = KEYS.BEILU_ACTIVE_MODE;
let _currentMode = storage.get(_MODE_STORAGE_KEY) || "chat";

/**
 * [0808 模式=窗口身份·凛倾拍板「绑定角色卡和窗口，不绑对话id」] 窗口实例令牌。
 * 功能链：本窗发起 switchMode/activateSubMode 时随 payload 上送 → 后端纯回显进 mode_changed 广播
 *   → _beiluApplyModeFromWs 比对令牌，只有本窗发起的切换回流才翻转本窗模式态。
 * why：模式是窗口的固有身份（重设计08 §四），不是对话/角色卡的共享状态。两窗绑同一条对话时，
 *   跨窗回流翻转 = 互拽死循环的翻转通路。令牌页内存续（刷新即新窗），不落盘不进任何授权判定，
 *   是绑定包窗口化（第三批）的窗口身份第一块砖。
 */
let _windowInstanceToken = null;
export function getWindowInstanceToken() {
  if (!_windowInstanceToken) {
    _windowInstanceToken = "w-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
  }
  return _windowInstanceToken;
}

// T040b：原 _presetHistory 预设历史缓存已移除。切模式不再缓存/恢复/应用预设
//   （凛倾 2026-06-16「切换模式切换的是模式的 data 和记忆，不是切换预设」）。

/**
 * E1: 模式 chatId 的 localStorage key 映射
 * smart 独立键（凛倾 0706「4个模式就是现在前端的4个模式」+ 0628「角色卡都需要创建4个对话」+
 * 底部功能层「data需要3个:airp,bot,chat」三处原话一致=smart 独立成线；原 chat+smart 共享
 * beilu-chat-chatid 是实现残留非设计，共享还会让 per-chatId 的 active_modes_map 在 chat/smart 间互覆）。
 */
const MODE_CHATID_KEYS = {
  chat: KEYS.BEILU_CHAT_CHATID,
  smart: KEYS.BEILU_SMART_CHATID,
  code: KEYS.BEILU_CODE_CHATID,
  work: KEYS.BEILU_WORK_CHATID,
};

// T040b：_getCurrentPresetName（读当前激活预设名，原仅供切模式前缓存预设用）已随预设联动一并移除。

/**
 * 获取当前活跃模式
 * @returns {string} "chat" | "smart" | "code" | "work"
 */
export function getCurrentMode() {
  return _currentMode;
}

/**
 * 更新模式状态（内部，不触发后端请求）
 * 同时持久化到 localStorage，确保 reload 后状态不丢失
 * @param {string} mode - "chat" | "code" | "work"
 */
function updateModeSwitchUI(mode) {
  _currentMode = mode;
  try {
    storage.set(_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

// T023 Q4 单真源：WS mode_changed 的派发权收口到本模块（websocket.mjs 转调）。
// [0808 模式=窗口身份 → 0808下午 发起源分流·凛倾拍板"本窗AI切模式应跟随，仅跨窗web切换用令牌隔离"]
//   原一刀切"无 token 一律不翻转"误伤了合法场景：AI 链 <modeSwitch>/delegate 跨组/YonBan 切模式的
//   广播天然不带窗口令牌，被全拒 → 后端 active_mode 已切、本窗 UI 与生成轴（messageInput 读
//   getCurrentMode）停在旧模式 = 三态分叉（0808 "code 混乱"根因链之一）。
//   分流规则（origin 由后端 switchMode 按"有无 windowToken"推导，见 setDataActions switchMode 广播点）：
//   · origin=web（含无 origin 但带 token 的旧广播）：窗口身份隔离不变——仅本窗令牌回流才翻转，
//     两窗绑同一条对话时 B 的用户切换不翻转 A（0808 第二循环封闭通路保持）。
//   · origin=external（AI 链/YonBan/桥等非窗口客户端，均无令牌）：跟随翻转——本窗 socket 是
//     per-chat 的，收到即说明该切换发生在本窗正显示的对话上（emitAll 回退=char 级语义，同跟随）。
//     视图轴不强拉（T040b 切模式≠切视图，layout 监听器只更新顶显）；生成窗口的 Tab 跟随
//     仍由既有 ext._modeSwitch 通路负责（websocket.mjs），_newMode===_currentMode 守卫保证两通路幂等。
//   本窗回流的用途保留：subModePanel activateSubMode 跨组切换不本地翻转、专等此回流对齐（:1451 契约）。
window._beiluApplyModeFromWs = (payload) => {
  const _newMode = payload?.mode || payload?.newMode;
  if (!_newMode || _newMode === _currentMode) return;
  // 发起源：后端新广播带 origin；旧后端广播无 origin 字段 → 按"有 token=web / 无 token=external"
  //   同一公式在前端推导（与后端推导式同源，见 setDataActions），老后端未重启期间语义已正确。
  const _origin = payload?.origin || (payload?.windowToken ? "web" : "external");
  if (_origin === "web" && (!payload?.windowToken || payload.windowToken !== getWindowInstanceToken())) return; // 跨窗 web 切换：不翻转窗口身份
  const _old = _currentMode;
  updateModeSwitchUI(_newMode);
  window.dispatchEvent(new CustomEvent("beilu:mode-switched", {
    detail: { oldMode: _old, newMode: _newMode, charName: payload?.charName, source: "ws" },
  }));
};

/**
 * 获取当前角色卡 charId（从 DOM 读取）
 * @returns {string}
 */
function _getCharId() {
  return getCharId();
}

// ============================================================
// E1: 模式会话隔离 — chatId 管理
// ============================================================

// E1 会话隔离相关辅助函数已移除（B3修复）
// 模式切换不再切换对话/reload，只切预设和后端表格

// ============================================================
// 后端模式同步
// ============================================================

/**
 * 本窗模式基线对账（init/切角色时）。
 * [0808 改契约] 不再从后端 getMode 采纳 char 级 active_mode（跨窗共享键回灌=窗口身份污染）；
 * 本窗真源=per-window BEILU_ACTIVE_MODE + 视图轴对账，后端只作为切换动作执行端被幂等重推。
 * @param {string} [charId] - 可选，直接传入 charId（避免重复查 DOM）
 */
async function syncModeFromBackend(charId) {
  try {
    // 优先使用传入的 charId，fallback 到 DOM 读取
    const charName = charId || _getCharId();
    // Phase2 修复：charName 为空时不查询后端，避免读到 _global 默认值覆盖真实模式
    if (!charName) {
      console.log(
        "[featureControls] syncModeFromBackend: charId 为空，跳过查询",
      );
      return;
    }
    // [0808 模式=窗口身份·凛倾拍板] 后端 char 级 active_mode 不再回灌本窗模式轴。
    //   原实现 getMode（char 级）→ updateModeSwitchUI：char 级键是同 char 全部窗口共享的，
    //   另一窗口最后写入的值会在本窗 init/切角色时被采纳为本窗基线 = 跨窗身份污染
    //   （0713 已删过"对话轴回灌"，本次删掉"char 轴回灌"这最后一条反向回灌路）。
    //   本窗模式真源 = per-window BEILU_ACTIVE_MODE（WINDOW_LOCAL_KEYS sessionStorage，模块加载
    //   时已恢复进 _currentMode）+ 下方视图对账；后端不再是窗口身份的读源，只是切换动作的执行端。
    //   YonBan 等无窗口客户端的 getMode 读点不在此链，不受影响。
    // [2026-07-16 两轴对账修·保留] 视图轴（activeTab）与模式轴（_currentMode）对账：
    //   tab 映射的模式≠本窗模式 → 以视图为意图补发一次幂等切换（含后端 scheduler/files 扇出预热，
    //   与手动点 tab 同语义）。守卫：layout 未就绪/辅助视图跳过。
    //   死循环免疫：重推的 mode_changed 广播带本窗令牌，其他窗口 _beiluApplyModeFromWs 不翻转，
    //   不会引发对面再对账（0808 互拽环第三通路封闭）。
    if ((_getCharId() || charName) !== charName) return;
    {
      const _tab = document.body.dataset.activeTab;
      const _tabMode = _tab ? TAB_TO_MODE[_tab] : null;
      if (_tabMode && _tabMode !== _currentMode) {
        console.log(`[featureControls] 模式对账: 视图轴=${_tab}(→${_tabMode}) ≠ 模式轴=${_currentMode}，以视图为意图重推`);
        _doSwitchMode(_tabMode, { skipConfirm: true, tab: _tab });
      }
    }
  } catch (err) {
    console.warn("[featureControls] 查询模式失败:", err.message);
  }
}

// ============================================================
// 核心：模式切换
// ============================================================

/**
 * 内部核心：执行模式切换（后端请求 + 记忆表格背景切换，零预设动作）
 * 设计（T040b，凛倾 2026-06-16「切换模式切换的是模式的data，和记忆，不是切换当前使用的模式或者预设」）：
 *   模式切换只切后端 data 与表格，不切换对话、不reload、不联动预设（预设隔离由后端 getPromptHandler 生成时保证）
 * 参考：modeSwitchworkmodeSwitch.txt L41 "模式切换,可以和预设那样,用xml标签"
 * @param {string} targetMode - "chat" | "code" | "work" | "companion"
 * @param {{ skipConfirm?: boolean }} opts
 */
// [2026-07-16 模式轴时序修·凛倾「时序问题+我已经切换了但还是之前的模式」] 原 `_switchingMode` 布尔闸
//   并发时静默丢弃（return undefined）：前一次切换在飞（getLogLength+switchMode+后端扇出，可达秒级）时
//   用户再点 → 本次意图丢失——tab/面板已切、后端没写、无重试；随后旧链完成派 mode-switched(旧值) 把
//   顶部翻回去 → 「面板=全智能 / 顶部=IDE / 盘上 active_mode=code」三态分叉（0716 截图实证）。
//   layout:481 注释「下次切换自愈」实为要用户再点一次，不是自愈。
//   改串行队列：每次调用挂前链之后依序执行，最新意图必达后端；每个调用方仍拿到自己那次的三态返回
//   （layout A3 回滚判别不变）；事件按执行序派发，顶部终态=最后一次意图。
let _switchQueue = Promise.resolve();
async function _doSwitchMode(targetMode, opts = {}) {
  const _run = _switchQueue.then(() => _doSwitchModeInner(targetMode, opts));
  // 队列尾吞错防断链（Inner 已全捕获理论不抛）；调用方拿的是未吞错的 _run，三态语义不变
  _switchQueue = _run.catch(() => {});
  return _run;
}
async function _doSwitchModeInner(targetMode, opts = {}) {
  // [N8] opts.tab = 前端原始 tab 意图（switchTab 联动时传入），供后端 mapToFilesMode 区分 file/memory。
  //   后端单入口扇出（B 持久化后内部调 beilu-files setMode），消灭前端双发 A 通道（原 notifyActiveMode）。
  const currentMode = _currentMode;
  // skipConfirm（Tab联动调用）时不跳过：前端缓存可能与后端不一致，强制同步
  if (currentMode === targetMode && !opts.skipConfirm) return;

  const charName = _getCharId();

  if (!opts.skipConfirm) {
    const confirmMsgMap = {
      code: "切换到编程模式？\n\n将切换到编程专用预设和记忆表格，当前对话保持不变。",
      work: "切换到工作模式？\n\n将切换到工作专用预设和记忆表格，当前对话保持不变。",
      chat: "切换回聊天模式？\n\n将恢复聊天专用预设和记忆表格，当前对话保持不变。",
      companion: "切换到陪伴模式？\n\n将切换到陪伴专用预设和记忆表格，当前对话保持不变。",
    };
    const confirmMsg = confirmMsgMap[targetMode] || confirmMsgMap.chat;
    if (!await beiluConfirm(confirmMsg)) return;
  }

  // [病型全查·框架修 2026-07-13] 模式轴翻转时机前移到「意图确定」时刻(此处=确认后/请求前)。
  // 【why】_currentMode 属用户意图轴(=tab轴,subModePanel:929 data-active-tab 判据同一权威),
  //   原在后端往返成功后才翻(本函数成功分支)——两个串行 HTTP+后端扇出的飞行窗口内
  //   getCurrentMode() 恒为旧模式:期间点对话 → switchToChat/markModeActiveChat 把对话指针
  //   写进【旧模式】的本地+服务端键,再经 指针校准→[MO-ISO]restore→回写 环永久化,即凛倾
  //   0713「切换到对话1之后,转换模式,切回来,对话1变成了刚切换的模式的对话2」「IDE 切不了
  //   对话用的是上次的」的产地。翻转前移后 30 处 getCurrentMode() 消费点(指针写入/列表过滤/
  //   视图)在点击瞬间即读到正确模式,零新增数据源。
  //   后端写=持久化跟随:确定失败(success:false/异常)回滚翻转,与 layout A3 的 tab 回滚同拍;
  //   beilu:mode-switched 事件语义(后端已生效)与派发时机【不变】,10 个订阅者零影响。
  updateModeSwitchUI(targetMode);

  // T040b（凛倾 2026-06-16「切换模式切换的是模式的 data 和记忆，不是切换当前使用的模式或者预设」；
  //   0716 定案补刀：「绑定」概念整体删除）：切模式 = 零预设动作。
  //   预设的隔离由后端生成时按 active_preset_map[cid:mode]（回退全局 active_preset）自主解析；
  //   应用预设的唯一路径 = 用户/AI 的切换动作（预设选择器/弹窗点卡/<presetSwitch>）。

  // [N8] 单入口扇出所需的 A 通道分区键 + 原始意图：tab 供后端区分 file/memory；
  //   file/memory 进入时需 currentMessageCount 作为清理起始点（原 notifyActiveMode 取自 log/length）。
  // 补修（同族收口）：切守卫单源 getChatId（内部仍读 hash，同源不变；加 _CHATID_RE 校验，
  //   非法 hash 返 "" 不写脏分区键送 getLogLength/switchMode）。对齐 cardsPanel.mjs:62/idePanel.mjs:673。
  // [预设隔离 2026-07-11] chatid 按调用语义分线（凛倾「链路有很多交叉问题和异步问题」根因层）：
  //   · tab 联动（opts.tab 有值，layout.switchTab 发起，后跟 [MO-ISO] _restoreModeChatId）——
  //     后端拿 chatid 写线级 active_modes_map[cid]=新模式。
  //     原取"切换时刻 hash"=【旧 tab 的会话】：旧会话线级模式被盖成新模式、新模式绑定预设
  //     初始化到旧会话键上（裸键双写再污染），随后 restore 才把 hash 换到目标模式记住的 cid
  //     ——写点全部落在错误的线上（AIRP/chat 预设互换实证）。改为与 _restoreModeChatId 同源
  //     目标 cid 必须从服务端 mode_active_chats 投影取得，本地键只是缓存。
  //     严禁回退当前 hash：切对话时 hash 早于 getInitialData 完成提交，此窗口把 hash
  //     当目标模式线，会将 chat/smart 线写成 code 并永久污染 active_modes_map。
  //   · 就地切换（无 opts.tab：messageInput 快捷指令等）——意图=把当前会话切到该模式，维持当前 hash。
  let _chatid = window._beiluGetChatId?.() || "";
  if (opts.tab) {
    try {
      const _targetChar = charName || storage.get(KEYS.BEILU_LAST_CHAR) || "";
      const _tgtKey = getModeChatIdKey(targetMode, _targetChar);
      const { fetchChatList } = await import("../../shared/chat-core/conversationManager.mjs");
      const _list = await fetchChatList();
      let _tgtCid = Array.isArray(_list)
        ? _list.find((c) => c?.primaryCharName === _targetChar && Array.isArray(c?.usedByModes) && c.usedByModes.includes(targetMode))?.chatid
        : null;
      // 权威表真缺线时复用既有四模式幂等创建口；失败就终止本次切换，不拿当前 hash 凑目标。
      if (!_tgtCid) {
        const _rep = await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: _targetChar } });
        _tgtCid = _rep?.modeChats?.[targetMode] || null;
      }
      if (!_tgtCid || !isValidChatId(_tgtCid)) throw new Error(`无法解析 ${targetMode} 模式的权威对话`);
      if (_tgtKey) storage.set(_tgtKey, _tgtCid);
      _chatid = _tgtCid;
    } catch (err) {
      console.error("[featureControls] 模式目标对话解析失败:", err.message);
      _publicToast("error", `模式切换失败: ${err.message}`);
      updateModeSwitchUI(currentMode);
      return false;
    }
  }
  const _tab = opts.tab || undefined;
  let _currentMessageCount = -1;
  if (_tab === "files" || _tab === "memory") {
    try {
      _currentMessageCount = await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: _chatid } }); // T6b
    } catch { /* ignore */ }
  }

  try {
    // [0804 根因修·死循环自愈] chatId 只是同模式多窗口的作业线身份，不是硬识别：目标模式记住的
    //   chatid 可能指向已删除/他人对话（外部删文件、换用户残留 localStorage）。原实现把它直接盖进
    //   scope → 桥 owner 闸拒绝（E_SCOPE_CHAT_OWNER）→ 本函数 catch 只回滚 → 下次仍读同一个死
    //   chatid = 永久业务状态循环，且该窗口永远够不到唯一重建入口 ensureModeChatsForChar。
    //   修法=闸拒绝时经认证 REST 公用机制（POST /ensure-mode-chats，不携带 stale scope）在服务端
    //   重建/读回该角色四模式坐标 → 更新本地模式键 → 用新 chatid 重试一次。owner 闸本身不放宽：
    //   仍存在但属他人的 chatid 在 repair 后依然拒绝（ensure 只在认证用户自己的域内建线）。
    let result;
    for (let _attempt = 0; ; _attempt++) {
      try {
        result = await sendAction({ // T6b：HTTP !ok 抛错走 catch（原 else console.error 语义并入门面报错）
          verb: "switchMode", target: "plugins:beilu-memory", source: "web",
          payload: {
            mode: targetMode,
            charName,
            // [N8] 后端单入口扇出至 beilu-files 所需字段
            tab: _tab,
            chatid: _chatid,
            currentMessageCount: _currentMessageCount,
            // [0808 模式=窗口身份] 本窗令牌随切换上送，后端回显进 mode_changed；
            //   本窗回流才翻转模式态（_beiluApplyModeFromWs 比对），跨窗广播不再互拽。
            windowToken: getWindowInstanceToken(),
          },
          scope: { chatId: _chatid },
        });
        break;
      } catch (swErr) {
        const _staleScope = /E_SCOPE_CHAT_OWNER|会话不存在/.test(swErr?.message || "");
        if (_attempt > 0 || !_staleScope || !charName) throw swErr;
        console.warn(`[featureControls] ${targetMode} 模式坐标失效（${swErr.message}），走 ensureModeChats 修复后重试`);
        const _rep = await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: charName } });
        const _newCid = _rep?.modeChats?.[targetMode];
        if (!_newCid || _newCid === _chatid) throw swErr; // 修复未产出新坐标 → 原错误可见，不静默循环
        const _repKey = getModeChatIdKey(targetMode, charName);
        if (_repKey) storage.set(_repKey, _newCid); // 清死指针：本地模式键指向服务端权威新线
        _chatid = _newCid;
      }
    }

    {
      if (result?.success) {
        // [框架修 0713] updateModeSwitchUI 已在请求前翻转(意图时刻),此处不再重复。

        // [N8] 后端扇出 beilu-files 失败时可见（不静默吞；B 持久化是权威不回滚，A 下次切换自愈）
        if (result.filesMode === "failed") {
          console.warn("[featureControls] 模式扇出 beilu-files 失败（A 通道未同步，将在下次切换自愈）");
        }
        // [N8] 退文件/记忆模式的对话清理：原在 layout.notifyActiveMode 处理，并轨后随 B 响应回传。
        //   清理逻辑（confirm/隐藏消息）仍是前端职责，经 window 桥调用 layout 的处理器（避免循环 import）。
        if (result._filesCleanup) {
          try { await window._beiluHandleFilesModeCleanup?.(result._filesCleanup); }
          catch (e) { console.warn("[featureControls] 文件模式清理失败:", e?.message); }
        }
        console.log(
          `[featureControls] 模式切换成功: ${currentMode} → ${targetMode} (char=${charName})`,
        );

        // [0716 凛倾定案] 「绑定」概念整体删除（原 T040b 注释与 bound_preset 回传均已清）：
        //   切模式不改预设权威状态；「正在使用的预设」只由用户/AI 的切换动作改。

        // S4: 模式切换后清理对话历史中的 XML 操作标签（根据用户设置）
        {
          const _cleanupMode = storage.get(KEYS.BEILU_CLEANUP_MODE) || DEFAULTS.cleanup.mode;
          const _doCleanup = _cleanupMode === "auto" || (_cleanupMode === "ask" && await beiluConfirm("模式切换：是否清理对话中的 XML 操作标签？\n\n选择「确定」清理，「取消」保留。"));
          if (_doCleanup) {
            try {
              const chatMessages = document.getElementById("chat-messages");
              if (chatMessages) {
                const xmlTagRegex =
                  /<(?:tableEdit|memoryArchive|memorySearch|file_op|presetSwitch|modeSwitch)>[\s\S]*?<\/(?:tableEdit|memoryArchive|memorySearch|file_op|presetSwitch|modeSwitch)>/gi;
                chatMessages.querySelectorAll(".message-content").forEach((el) => {
                  xmlTagRegex.lastIndex = 0; // 每次 test 前重置，避免全局 lastIndex 错位
                  if (xmlTagRegex.test(el.innerHTML)) {
                    xmlTagRegex.lastIndex = 0; // replace 前再重置，保证从头匹配
                    el.innerHTML = el.innerHTML.replace(xmlTagRegex, "");
                  }
                });
                console.log("[featureControls] 模式切换: 已清理对话中的 XML 操作标签");
              }
            } catch (cleanErr) {
              console.warn("[featureControls] XML 标签清理失败:", cleanErr.message);
            }
          } else {
            console.log(`[featureControls] 模式切换: XML 标签清理已跳过 (模式=${_cleanupMode})`);
          }
        }

        // 派发自定义事件，通知其他模块模式已切换
        window.dispatchEvent(
          new CustomEvent("beilu:mode-switched", {
            detail: {
              oldMode: currentMode,
              newMode: targetMode,
              charName,
            },
          }),
        );

        // [0716 断链修] 切模式=本窗「正在使用的预设」换轴（生成侧 resolveActivePresetName 按
        //   active_preset_map[cid:newMode] 解析，无记录回退全局 active_preset）——权威没变但本窗
        //   解析结果变了，后端不广播 → 顶栏/smart/memswitch 等「当前预设」读点定格上一模式的值
        //   （凛倾 0716「顶部…不相识当前用的预设,显示之前的,时序异常」案）。
        //   修法=重解析本窗生效值（resolveCurrentPresetName 单源，与生成链同源）后派发既有
        //   beilu:preset-changed——三个消费点（layout:643 顶栏/smart:346 左栏/memswitch）全走
        //   「收到事件→重解析→值未变静默」幂等范式，一处派发全部读点归位，无新增订阅散点。
        try {
          // 先失效预设缓存（对齐 ws preset_changed 链的「先失效再派发」顺序，sharedState:219）：
          //   resolveCurrentPresetName 走 getCachedPresetData 缓存，不失效会解析到切换前模式的旧值。
          window._beiluInvalidatePresetCache?.();
          const _resolved = await window._beiluResolveCurrentPreset?.();
          if (_resolved) {
            window.dispatchEvent(new CustomEvent("beilu:preset-changed", { detail: { preset: _resolved, source: "mode-switch-resync" } }));
          }
        } catch { /* 解析失败=各读点保持现值，不拿旧值凑 */ }
        return true; // [多窗口审计 2026-07-11 A3] 三态返回：true=成功
      } else {
        console.error("[featureControls] 模式切换失败:", result?.error);
        if (!opts.skipConfirm) {
          _publicToast("error", `模式切换失败: ${result?.error || "未知错误"}`);
        }
        // [A3] 原吞错恒 resolve(undefined) → layout 的 .catch 回滚是死路径（后端 success:false /
        //   异常都到不了那里），失败时前端 tab/hash 已切而后端模式没切=三态不一致无人修。
        //   改三态返回：false=确定失败（layout 据此回滚）；undefined=并发守卫丢弃（不回滚）。
        updateModeSwitchUI(currentMode); // [框架修 0713] 确定失败=回滚意图翻转（与 layout A3 tab 回滚同拍）
        return false;
      }
    }
  } catch (err) {
    console.error("[featureControls] 模式切换异常:", err.message);
    updateModeSwitchUI(currentMode); // [框架修 0713] 异常同属确定失败,回滚意图翻转
    return false; // [A3] 异常同属确定失败
  }
}

/**
 * 静默切换模式（供 Tab 联动调用，无确认弹窗）
 * @param {string} targetMode - "chat" | "code" | "work" | "companion"
 * @param {{ tab?: string }} [opts] - [N8] tab=前端原始 tab 意图，透传给后端单入口扇出区分 file/memory
 */
export async function switchModeTo(targetMode, opts = {}) {
  return _doSwitchMode(targetMode, { skipConfirm: true, tab: opts.tab });
}

// B6 修复：已删除 initModePresetBindings() 函数
// 根据主人要求，"模式切换绑定预设"功能不再需要

/**
 * 初始化模式切换（同步后端状态 + 监听角色切换事件）
 */
function initModeSwitch() {
  // 从后端同步当前模式
  syncModeFromBackend();

  // IDE连接时自动切换到编程模式——仅当用户正处于 IDE 视图（files/memory tab）。
  // [2026-07-16 断链修·顶部模式被回写 code] 原无条件强切：YonBan WS 每次 hello（含自动重连的每一次）
  //   都触发 _doSwitchMode("code")——真写后端 char 级 active_mode + 派发 mode-switched{code}，而
  //   T040b 切模式≠切视图 → 用户刚切到 AIRP/work，视图还在、顶部标签与后端模式被拽回 IDE/code
  //   （凛倾 17:15 实证「切airp和work顶部都显示ide」+ 盘上 代码001 active_mode=code 为最后写）。
  //   适用域判据复用 data-active-tab（本文件/subModePanel 同一权威）：在 IDE 视图里连上 IDE=自动
  //   进编程模式（原设计意图保留）；在其他视图=用户的显式模式选择优先，不抢。
  // IDE 连接自动切模式：init 期间延迟（防 init + switchMode 级联同时发 HTTP → 超浏览器 6 连接限制 → 级联超时）。
  let _pendingIdeConnect = null;
  window.addEventListener("beilu:ide-connected", (e) => {
    if (e.detail?.reconnect) {
      console.log(`[featureControls] IDE重连(${e.detail?.appName})，恢复既有连接不自动切模式`);
      return;
    }
    if (window._beiluChatInitializing) {
      console.log(`[featureControls] IDE连接(${e.detail?.appName})，init 进行中，延迟到 init 完成后处理`);
      _pendingIdeConnect = e;
      return;
    }
    _handleIdeConnected(e);
  });
  window.addEventListener("beilu:chatInitDone", () => {
    if (_pendingIdeConnect) {
      const e = _pendingIdeConnect;
      _pendingIdeConnect = null;
      console.log(`[featureControls] init 完成，处理延迟的 IDE 连接事件`);
      _handleIdeConnected(e);
    }
  });
  function _handleIdeConnected(e) {
    const _tab = document.body.dataset.activeTab;
    if (_tab !== "files" && _tab !== "memory") {
      console.log(`[featureControls] IDE连接(${e.detail?.appName})，当前视图=${_tab}，不自动切模式（用户显式选择优先）`);
      return;
    }
    if (_currentMode !== "code") {
      console.log(`[featureControls] IDE连接(${e.detail?.appName})，自动切换到编程模式`);
      _doSwitchMode("code", { skipConfirm: true });
    }
  }

  // 监听角色卡切换事件，重新同步模式状态
  window.addEventListener("beilu:char-changed", (e) => {
    // T040b：原「角色切换时清空 _presetHistory 预设历史缓存」已随预设联动一并移除。
    syncModeFromBackend(e.detail?.charId);
  });
}

/**
 * 公开：重新从后端同步模式（供外部模块在角色切换时调用）
 */
export { syncModeFromBackend };

/**
 * E1 公开：获取模式 chatId 的 localStorage key 映射
 */
export { MODE_CHATID_KEYS };

/**
 * 获取 per-character 的模式 chatId localStorage key。
 * 格式: `beilu-{mode}-chatid:{charName}`，切角色后各角色独立存储。
 * @param {string} mode - 模式名 (chat/code/work)
 * @param {string} charName - 角色名
 * @returns {string|null} localStorage key，无效参数返回 null
 */
export function getModeChatIdKey(mode, charName) {
  const baseKey = MODE_CHATID_KEYS[mode];
  if (!baseKey) return null;
  if (!charName) return baseKey;
  return baseKey + ":" + charName;
}

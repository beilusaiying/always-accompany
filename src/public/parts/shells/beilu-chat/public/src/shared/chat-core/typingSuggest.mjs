/**
 * [typingSuggest.mjs] — 打字式联想（002 0731 新功能；考古确认与历史"打字式学习"词频机制无关）
 *
 * 功能链：
 *   #message-input input 事件（messageInput.mjs 接线）→ onTypingInput(text)
 *     → debounce 400ms + 触发门槛（≥4字）→ sendAction runP1（dataRecallOverride:false 轻量：
 *       只要锚点/池词不扫三层记忆，请求级参数不碰全局配置、不影响生产召回）
 *     → #typing-suggest-bar 渲染联想词 chip（点击插入光标处）+ 相关记忆只读提示
 *
 * why：P1 召回暖态 P50 毫秒级，可支撑打字停顿即联想；给用户"想到自己想不到的关联"的前置入口。
 * 影响范围：默认关闭（storage key beilu-typing-suggest-enabled，开关在 P1「运行/测试」面板）。
 *   关闭=onTypingInput 直接 no-op 零请求。失败不阻断输入/主生成，但复用既有 console.error +
 *   window._reportError 进入监控错误中心，并按错误签名限频，避免输入事件无界刷屏。
 * 性能护栏：trailing-only 并发闸（至多1在途，_reqSeq 过期响应丢弃，_pendingText 补发）；
 *   focus 专用预热（失败可观察且允许下次 focus 重试；不伪造用户输入、不写运行记录）。
 * 关联链：← messageInput.mjs（input 监听+init） → sendAction(plugins:beilu-p1-selfdriven warmup/runP1)
 *   → 插件 main.mjs dataRecallOverride → p1_recall 管线
 */
import { sendAction } from "../transport/sendAction.mjs";

const KEY_ENABLED = "beilu-typing-suggest-enabled"; // 单一判断点；toggle 在 p1panel 运行面板
const P1_CONFIG_CHANGED_EVENT = "beilu:p1-config-changed";
const TYPING_CFG_LIMITS = Object.freeze({
  typingDebounceMs: [100, 3000],
  typingMinChars: [1, 20],
});
// [0731 机制类硬编码收口] 默认值=原硬编码值（零行为变化）；init 时异步拉 P1 getData 的
// typingDebounceMs/typingMinChars 覆盖，拉不到（服务未启动/网络失败）用这两个硬编码值兜底。
let DEBOUNCE_MS = 400;
let MIN_CHARS = 4;
let _cfgFetched = false;

function _boundedInteger(config, key) {
  const value = Number(config?.[key]);
  const [min, max] = TYPING_CFG_LIMITS[key];
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function _applyTypingCfg(config) {
  const debounceMs = _boundedInteger(config, "typingDebounceMs");
  const minChars = _boundedInteger(config, "typingMinChars");
  let changed = false;
  if (debounceMs !== null && debounceMs !== DEBOUNCE_MS) { DEBOUNCE_MS = debounceMs; changed = true; }
  if (minChars !== null && minChars !== MIN_CHARS) { MIN_CHARS = minChars; changed = true; }
  return changed;
}

async function _loadTypingCfg() {
  if (_cfgFetched) return;
  _cfgFetched = true;
  try {
    const d = await sendAction({ verb: "getData", target: "plugins:beilu-p1-selfdriven", source: "web" });
    if (_applyTypingCfg(d)) _rescheduleTypingInput();
  } catch { /* 拉取失败静默保留硬编码默认值兜底 */ }
}

let _textarea = null;
let _bar = null;
let _timer = null;
let _reqSeq = 0;      // 响应过期判定：回包 seq !== 当前 seq 直接丢弃
let _inFlight = false;
let _pendingText = null; // 在途期间的最新文本，完成后补发一次（trailing-only）
let _warmupState = "cold";
let _warmupPromise = null;
let _bindingListenersBound = false;
const FAILURE_REPORT_WINDOW_MS = 30000;
const FAILURE_REPORT_MAX_KEYS = 24;
const _failureReportAt = new Map();

function _currentBinding() {
  if (typeof window._beiluCurWinBinding !== "function") {
    const error = new Error("当前窗口绑定 producer 未就绪");
    error.code = "E_P1_WINDOW_BINDING_MISSING";
    throw error;
  }
  const raw = window._beiluCurWinBinding();
  const binding = {
    chatId: String(raw?.chatId || "").trim(),
    charName: String(raw?.charName || "").trim(),
    mode: String(raw?.mode || "").trim(),
    multiWindow: raw?.multiWindow,
  };
  const missing = [];
  if (!binding.chatId) missing.push("chatId");
  if (!binding.charName) missing.push("charName");
  if (!binding.mode) missing.push("mode");
  if (typeof binding.multiWindow !== "boolean") missing.push("multiWindow");
  if (missing.length) {
    const error = new Error(`P1 打字联想的当前窗口绑定不完整，缺少: ${missing.join(", ")}`);
    error.code = "E_P1_WINDOW_BINDING_INCOMPLETE";
    error.binding = binding;
    throw error;
  }
  return Object.freeze(binding);
}

const _bindingKey = (binding) => binding
  ? `${binding.chatId}\u0000${binding.charName}\u0000${binding.mode}\u0000${binding.multiWindow}`
  : "";

function _reportTypingFailure(code, error, context = {}) {
  const detail = {
    code: code || "E_P1_TYPING_SUGGEST",
    error: error || "P1 typing suggestion failed",
    charName: context.charName || null,
    chatId: context.chatId || null,
    mode: context.mode || null,
    multiWindow: typeof context.multiWindow === "boolean" ? context.multiWindow : null,
    phase: context.phase || "runP1",
  };
  const signature = `${detail.code}|${detail.error}|${detail.charName || ""}|${detail.chatId || ""}|${detail.mode || ""}|${detail.multiWindow}|${detail.phase}`;
  const now = Date.now();
  if (now - (_failureReportAt.get(signature) || 0) < FAILURE_REPORT_WINDOW_MS) return false;
  _failureReportAt.set(signature, now);
  while (_failureReportAt.size > FAILURE_REPORT_MAX_KEYS) {
    _failureReportAt.delete(_failureReportAt.keys().next().value);
  }
  console.error("[typingSuggest] P1 suggestion failed:", detail);
  try {
    window._reportError?.(
      `[typingSuggest] ${detail.code}: ${detail.error}`,
      null,
      { target: "plugins:beilu-p1-selfdriven", verb: detail.phase },
    );
  } catch { /* 报错桥不可用不影响输入 */ }
  return true;
}

function _emitWarmupStatus(detail) {
  try { window.dispatchEvent(new CustomEvent("beilu:p1-warmup-status", { detail })); }
  catch { /* 非浏览器测试环境不阻断 */ }
}

function _warmTypingSuggest() {
  // 服务可能被 idle 生命周期卸载；每次新 focus 都向幂等 /warmup 重新确认真实就绪状态。
  if (_warmupPromise) return _warmupPromise;
  let binding = null;
  try { binding = _currentBinding(); }
  catch (error) {
    const partial = error?.binding || {};
    const detail = {
      state: "failed",
      charName: partial.charName || "",
      chatId: partial.chatId || "",
      code: error?.code || "E_P1_WINDOW_BINDING_INCOMPLETE",
      error: error?.message || String(error),
    };
    _reportTypingFailure(detail.code, detail.error, { ...partial, phase: "warmup" });
    _emitWarmupStatus(detail);
    return Promise.resolve(false);
  }
  const { charName, chatId, mode, multiWindow } = binding;
  _warmupState = "warming";
  _emitWarmupStatus({ state: "warming", charName, chatId, mode, multiWindow });
  _warmupPromise = sendAction({
    verb: "warmup", target: "plugins:beilu-p1-selfdriven", source: "web",
    scope: { chatId },
    payload: { mode, activeMode: mode, charName, chatId, multiWindow, source: "typing-suggest" },
  }).then((result) => {
    if (result?.success !== true || result?.readyForRecall !== true) {
      const error = new Error(result?.error || "P1 warmup 未进入 readyForRecall 状态");
      error.code = result?.code || "E_P1_WARMUP_FAILED";
      error.warmup = result?.warmup;
      throw error;
    }
    let currentBinding = null;
    try { currentBinding = _currentBinding(); } catch { /* 下方按过期处理 */ }
    if (_bindingKey(currentBinding) !== _bindingKey(binding)) {
      _warmupState = "cold";
      return false;
    }
    _warmupState = "ready";
    _emitWarmupStatus({ state: "ready", charName, chatId, mode, multiWindow, warmup: result.warmup });
    return true;
  }).catch((error) => {
    _warmupState = "failed";
    const detail = {
      state: "failed", charName, chatId,
      code: error?.code || "E_P1_WARMUP_FAILED",
      error: error?.message || String(error),
      warmup: error?.warmup,
    };
    _reportTypingFailure(detail.code, detail.error, { charName, chatId, mode, multiWindow, phase: "warmup" });
    _emitWarmupStatus(detail);
    return false;
  }).finally(() => { _warmupPromise = null; });
  return _warmupPromise;
}

function _rescheduleTypingInput() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_textarea) onTypingInput(_textarea.value);
}

if (typeof window !== "undefined") {
  window.addEventListener(P1_CONFIG_CHANGED_EVENT, (event) => {
    // 只消费 updateConfig 成功回包中的完整生效配置；不读取面板提交 patch，不做乐观更新。
    if (_applyTypingCfg(event?.detail?.config)) _rescheduleTypingInput();
  });
}

const _enabled = () => { try { return localStorage.getItem(KEY_ENABLED) === "true"; } catch { return false; } };
const _esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function initTypingSuggest(textareaEl) {
  _textarea = textareaEl || document.getElementById("message-input");
  _bar = document.getElementById("typing-suggest-bar");
  if (!_textarea || !_bar) return;
  if (!_bindingListenersBound) {
    _bindingListenersBound = true;
    const invalidateBinding = () => {
      // 旧窗口尚未触发的文本不得在切换后用新 binding 发出；已发请求仍可在后端完成，
      // 但由下方 seq + binding 双闸阻止回包渲染进新窗口的输入栏。
      if (_timer) { clearTimeout(_timer); _timer = null; }
      _reqSeq += 1;
      _pendingText = null;
      _hide();
    };
    for (const eventName of ["beilu:window-switched", "beilu:mode-switched", "beilu:char-changed", "hashchange"]) {
      window.addEventListener(eventName, invalidateBinding);
    }
  }
  _loadTypingCfg(); // 不 await：首屏不阻塞，配置到位前用硬编码默认值触发（不影响功能，只影响门槛/防抖数值）
  // Esc 关闭联想栏（不动 handleKeyPress 发送逻辑；v1 点击选词不做↑↓键选）
  _textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _bar.style.display !== "none") { _hide(); e.stopPropagation(); }
  });
  // 专用预热：不构造“预热”伪输入；失败会发状态事件并在下一次 focus 重试。
  _textarea.addEventListener("focus", () => {
    if (!_enabled()) return;
    void _warmTypingSuggest();
  }, { once: false });
}

export function onTypingInput(text) {
  if (!_enabled() || !_bar) return;
  if (_timer) clearTimeout(_timer);
  const t = String(text || "").trim();
  if (t.length < MIN_CHARS) { _hide(); return; }
  _timer = setTimeout(() => { _timer = null; _fire(t); }, DEBOUNCE_MS);
}

function _hide() { if (_bar) { _bar.style.display = "none"; _bar.innerHTML = ""; } }

async function _fire(text) {
  if (_inFlight) { _pendingText = text; return; } // trailing-only：在途时只记最新，不排队
  _inFlight = true;
  const seq = ++_reqSeq;
  let binding = null;
  try {
    binding = _currentBinding();
    const { charName, chatId, mode, multiWindow } = binding;
    const r = await sendAction({
      verb: "runP1", target: "plugins:beilu-p1-selfdriven", source: "web",
      scope: { chatId },
      payload: {
        inputText: text,
        chatHistory: [],
        historyChatId: chatId,
        mode,
        activeMode: mode,
        charName,
        chatId,
        multiWindow,
        source: "typing-suggest",
        dataRecallOverride: false,
      },
    });
    if (seq !== _reqSeq) return; // 过期响应丢弃
    let currentBinding = null;
    try { currentBinding = _currentBinding(); } catch { _hide(); return; }
    if (_bindingKey(currentBinding) !== _bindingKey(binding)) { _hide(); return; }
    if (!r?.success) {
      _reportTypingFailure(
        r?.code || "E_P1_TYPING_RUN_FAILED",
        r?.error || "P1 打字联想返回失败",
        { charName, chatId, mode, multiWindow, phase: "runP1" },
      );
      _hide();
      return;
    }
    const rec = r.trace?.recall || {};
    const anchors = (rec.anchors || []).map((a) => (typeof a === "string" ? a : a?.word || "")).filter(Boolean);
    const dirWords = Array.isArray(r.directionWords) ? r.directionWords : (r.p1_act || []);
    const words = [...new Set([...anchors, ...dirWords])].slice(0, 12);
    const mem = (r.recalledRecords || [])[0];
    if (!words.length && !mem) { _hide(); return; }
    _bar.innerHTML = words.map((w) => `<span class="typing-suggest-chip" data-tsw="${_esc(w)}">${_esc(w)}</span>`).join("")
      + (mem ? `<span class="typing-suggest-mem" title="${_esc(String(mem.content || "").slice(0, 200))}">💭 ${_esc(String(mem.content || "").slice(0, 60))}</span>` : "");
    _bar.style.display = "flex";
    _bar.querySelectorAll("[data-tsw]").forEach((el) => el.addEventListener("click", () => _insert(el.dataset.tsw)));
  } catch (error) {
    const context = binding || error?.binding || {};
    _reportTypingFailure(
      error?.code || "E_P1_TYPING_REQUEST_FAILED",
      error?.message || String(error),
      {
        charName: context.charName || "",
        chatId: context.chatId || "",
        mode: context.mode || "",
        multiWindow: context.multiWindow,
        phase: "runP1",
      },
    );
    _hide();
  }
  finally {
    _inFlight = false;
    if (_pendingText && _pendingText !== text) { const p = _pendingText; _pendingText = null; _fire(p); }
    else _pendingText = null;
  }
}

function _insert(word) {
  if (!_textarea || !word) return;
  const s = _textarea.selectionStart ?? _textarea.value.length;
  const e = _textarea.selectionEnd ?? s;
  _textarea.value = _textarea.value.slice(0, s) + word + _textarea.value.slice(e);
  const pos = s + word.length;
  _textarea.setSelectionRange(pos, pos);
  _textarea.focus();
  _textarea.dispatchEvent(new Event("input", { bubbles: true })); // 触发 autoResize/草稿保存既有链
}

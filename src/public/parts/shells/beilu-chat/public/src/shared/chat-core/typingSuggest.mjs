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
 *   关闭=onTypingInput 直接 no-op 零请求。失败静默降级不弹 toast（输入场景不打扰）。
 * 性能护栏：trailing-only 并发闸（至多1在途，_reqSeq 过期响应丢弃，_pendingText 补发）；
 *   focus 一次性预热（防 idle 卸载后首次调用 1-3s 冷启动撞上用户第一句话）。
 * 关联链：← messageInput.mjs（input 监听+init） → sendAction(plugins:beilu-p1-selfdriven runP1)
 *   → 插件 main.mjs dataRecallOverride → p1_recall 管线
 */
import { sendAction } from "../transport/sendAction.mjs";

const KEY_ENABLED = "beilu-typing-suggest-enabled"; // 单一判断点；toggle 在 p1panel 运行面板
// [0731 机制类硬编码收口] 默认值=原硬编码值（零行为变化）；init 时异步拉 P1 getData 的
// typingDebounceMs/typingMinChars 覆盖，拉不到（服务未启动/网络失败）用这两个硬编码值兜底。
let DEBOUNCE_MS = 400;
let MIN_CHARS = 4;
let _cfgFetched = false;

async function _loadTypingCfg() {
  if (_cfgFetched) return;
  _cfgFetched = true;
  try {
    const d = await sendAction({ verb: "getData", target: "plugins:beilu-p1-selfdriven", source: "web" });
    if (Number.isFinite(d?.typingDebounceMs) && d.typingDebounceMs > 0) DEBOUNCE_MS = Number(d.typingDebounceMs);
    if (Number.isFinite(d?.typingMinChars) && d.typingMinChars > 0) MIN_CHARS = Number(d.typingMinChars);
  } catch { /* 拉取失败静默保留硬编码默认值兜底 */ }
}

let _textarea = null;
let _bar = null;
let _timer = null;
let _reqSeq = 0;      // 响应过期判定：回包 seq !== 当前 seq 直接丢弃
let _inFlight = false;
let _pendingText = null; // 在途期间的最新文本，完成后补发一次（trailing-only）
let _warmedOnce = false;

const _enabled = () => { try { return localStorage.getItem(KEY_ENABLED) === "true"; } catch { return false; } };
const _esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const _mode = () => {
  const t = document.body?.dataset?.activeTab || "chat";
  return t === "files" ? "code" : (t === "work" ? "work" : "chat");
};

export function initTypingSuggest(textareaEl) {
  _textarea = textareaEl || document.getElementById("message-input");
  _bar = document.getElementById("typing-suggest-bar");
  if (!_textarea || !_bar) return;
  _loadTypingCfg(); // 不 await：首屏不阻塞，配置到位前用硬编码默认值触发（不影响功能，只影响门槛/防抖数值）
  // Esc 关闭联想栏（不动 handleKeyPress 发送逻辑；v1 点击选词不做↑↓键选）
  _textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _bar.style.display !== "none") { _hide(); e.stopPropagation(); }
  });
  // 一次性预热：开关开着才预热（发一次抛弃结果的调用把管线 import 好）
  _textarea.addEventListener("focus", () => {
    if (_warmedOnce || !_enabled()) return;
    _warmedOnce = true;
    sendAction({ verb: "runP1", target: "plugins:beilu-p1-selfdriven", source: "web", payload: { inputText: "预热", chatHistory: [], mode: _mode(), dataRecallOverride: false } }).catch(() => { /* 预热失败静默 */ });
  }, { once: false });
}

export function onTypingInput(text) {
  if (!_enabled() || !_bar) return;
  if (_timer) clearTimeout(_timer);
  const t = String(text || "").trim();
  if (t.length < MIN_CHARS) { _hide(); return; }
  _timer = setTimeout(() => _fire(t), DEBOUNCE_MS);
}

function _hide() { if (_bar) { _bar.style.display = "none"; _bar.innerHTML = ""; } }

async function _fire(text) {
  if (_inFlight) { _pendingText = text; return; } // trailing-only：在途时只记最新，不排队
  _inFlight = true;
  const seq = ++_reqSeq;
  try {
    const charName = window._beiluGetCharName?.() || "";
    const r = await sendAction({
      verb: "runP1", target: "plugins:beilu-p1-selfdriven", source: "web",
      payload: { inputText: text, chatHistory: [], mode: _mode(), charName, dataRecallOverride: false },
    });
    if (seq !== _reqSeq) return; // 过期响应丢弃
    if (!r?.success) { _hide(); return; } // 插件未启用/失败=静默
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
  } catch { _hide(); /* 静默降级 */ }
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

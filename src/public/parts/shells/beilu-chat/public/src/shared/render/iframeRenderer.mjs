/**
 * iframeRenderer.mjs — iframe 沙箱渲染器（v2）+ 父页面多轨音频管理
 *
 * 功能链：
 *   消息渲染 → createIframeRenderer(html) → <iframe sandbox> 注入内容
 *   → 高度自适应：frameElement.style.height 直接操作（非 postMessage）
 *   → 父页面 resize → 更新 iframe 内 CSS 变量（--vh 等，解决 vh 循环依赖）
 *   iframe 内 beiluAudio.play(type, src) → postMessage → 父页面多轨音频管理器
 *   → bgm 轨（loop）/ voice 轨（单实例）/ se 轨（叠加短音效）
 *   voice 播放 → _wireVoiceLipEvents → 派发 beilu:voice-audio-start/end → live2dRenderer 订阅口型
 *
 * why（v2 相比 v1 核心改动）：
 *   1. 高度自适应从 postMessage 改为 frameElement.style.height 直接操作（更稳定）
 *   2. 注入 overflow:hidden 到 iframe body，消除内部滚动条
 *   3. vh 单位替换为 CSS 变量，解决 iframe 内 vh 循环依赖
 *   4. 音频改由父页面多轨管理（beiluAudio 桥），iframe 不再申请 autoplay 权限
 *   5. 父页面 resize 监听，实时更新 iframe 内视口变量
 *   口型同步（R-Lip）：事件总线解耦，iframeRenderer 只管「voice 在播/停」事实，不认识 live2d。
 *
 * 关联链：
 *   ← messageList.mjs / virtualQueue.mjs（消息含 HTML 内容时创建 iframe）
 *   → stCompat/index.mjs（buildInjectionScript/detectNeeds：ST 兼容注入脚本）
 *   → shared/state/diagLogger.mjs（createDiag：结构化诊断日志）
 *   → scripts/onElementRemoved.mjs（iframe 移除时清理音频）
 *   → live2dRenderer（通过 beilu:voice-audio-start/end 事件订阅口型）
 *
 * 影响范围：
 *   DOM：每条含 HTML 消息对应一个 <iframe sandbox> 节点；
 *   音频：bgm/voice/se 三轨由父页面统一管理，iframe 不直接操作 Audio API；
 *   闭环A：同一时刻最多一个 iframe 持有「发声权」，其余 suspend；
 *   beilu:voice-audio-start/end 事件影响 live2d 口型同步。
 *
 * 使用效果：
 *   角色卡 HTML 消息在沙箱 iframe 内安全渲染；音频/口型/视口高度跨框架协同；
 *   iframe 移除时音频自动停止，防止后台播放。
 */

import { onElementRemoved } from "../../../../../../scripts/onElementRemoved.mjs";
import { createDiag } from "../state/diagLogger.mjs";
import { buildInjectionScript, detectNeeds } from "../../stCompat/index.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { DEFAULTS } from "../../config/defaults.mjs"; // 0719 收口：sandbox 缺省档单源（原与 settings.mjs 各写一份字面量）

const diag = createDiag("iframeRenderer");

// ============================================================
// 全局：父页面多轨音频管理器 (R2)
//   bgm   — 背景音乐, loop, 切换时替换 src
//   voice — 配音/TTS, 单实例, 不 loop
//   se    — 短音效, 每次创建新 Audio 叠加播放, 播完自动 remove
// ============================================================
const _trackAudios = { bgm: null, voice: null };
const _seActive = new Set(); // 活跃的 SE Audio 实例(自动清理)

// ============================================================
// 口型同步桥(R-Lip): voice 轨真实播放 → 派发 window CustomEvent,
//   供 live2dRenderer 订阅后接 talkWithAudio(AudioContext+RMS 真实口型)。
//   事件总线解耦:iframeRenderer 只管"voice 在播/停"这一【事实】,不认识 live2d;
//   live2d 只订阅事实驱动口型,不认识音频桥。与既有 window CustomEvent 范式一致(bindEvents)。
//   注:voice <audio> 元素由 _getTrackAudio('voice') 懒建后复用同一实例(单实例配音),
//      故口型侧按【元素身份】缓存 MediaElementSource(一个 audio 只能 createMediaElementSource 一次)。
let _voiceLipWired = false;
function _wireVoiceLipEvents(audio) {
  if (!audio || _voiceLipWired) return;
  _voiceLipWired = true; // voice 是单实例,只挂一次(元素复用)
  const fireStart = () => {
    try {
      window.dispatchEvent(new CustomEvent("beilu:voice-audio-start", { detail: { audioEl: audio } }));
    } catch (e) { /* CustomEvent 不可用环境:静默 */ }
  };
  const fireEnd = () => {
    try {
      window.dispatchEvent(new CustomEvent("beilu:voice-audio-end", { detail: { audioEl: audio } }));
    } catch (e) { /* 静默 */ }
  };
  // play=真正开始出声(含 resume);pause/ended=停。用元素原生事件而非调用点,
  //   保证无论谁触发(角色卡 beiluAudio.play / 父页直接调)都一致派发。
  audio.addEventListener("playing", fireStart);
  audio.addEventListener("pause", fireEnd);
  audio.addEventListener("ended", fireEnd);
}

// ============================================================
// 闭环A: 音频单一发声 — 当前持有发声权的 iframe(messageId)
//   最新带音频消息渲染完成时设为 active, 其余 iframe 广播 suspend。
// ============================================================
let activeAudioIframe = null;

function _getTrackAudio(track) {
  if (track === "se") {
    const audio = new Audio();
    _seActive.add(audio);
    audio.addEventListener("ended", () => { _seActive.delete(audio); }, { once: true });
    audio.addEventListener("error", () => { _seActive.delete(audio); }, { once: true });
    return audio;
  }
  if (!_trackAudios[track]) {
    _trackAudios[track] = new Audio();
    if (track === "bgm") _trackAudios[track].loop = true;
    // voice 轨建好即挂口型同步事件(playing/pause/ended → window CustomEvent)。
    if (track === "voice") _wireVoiceLipEvents(_trackAudios[track]);
  }
  return _trackAudios[track];
}

// 对外暴露各轨道状态（供 iframe 查询/调试）
// R2 兼容:旧代码读 state.playing / state.src / state.volume 返回 bgm 轨道数据,避免破坏性变更
const _audioStateObj = {
  bgm: { playing: false, src: "", volume: 0.5 },
  voice: { playing: false, src: "", volume: 1.0 },
  se: { activeCount: 0 },
};
Object.defineProperty(_audioStateObj, "playing", { get() { return this.bgm.playing; }, configurable: true });
Object.defineProperty(_audioStateObj, "src",     { get() { return this.bgm.src;     }, configurable: true });
Object.defineProperty(_audioStateObj, "volume",  { get() { return this.bgm.volume;  }, configurable: true });
window.__beiluAudioState = _audioStateObj;

function _normalizeTrack(options) {
  const t = options && options.track;
  return (t === "se" || t === "voice" || t === "bgm") ? t : "bgm";
}

// export: 父页模块消费方(教程引擎BGM拉线)与iframe桥共用同一播放器, 防双audio叠音
export function beiluAudioPlay(url, options = {}) {
  const track = _normalizeTrack(options);
  const audio = _getTrackAudio(track);
  if (options.loop !== undefined) audio.loop = options.loop;
  if (options.volume !== undefined) {
    audio.volume = options.volume;
    if (window.__beiluAudioState[track]) window.__beiluAudioState[track].volume = options.volume;
  }

  // SE 每次都是新实例直接播放
  if (track === "se") {
    if (url) audio.src = url;
    audio.play().catch((e) => console.warn("[beiluAudio SE] play failed:", e));
    window.__beiluAudioState.se.activeCount = _seActive.size;
    return;
  }

  // BGM / voice:同源 URL 不重启
  let isSameUrl = false;
  if (url) {
    try { isSameUrl = audio.src === new URL(url, location.href).href; }
    catch { isSameUrl = audio.src === url; }
  } else {
    isSameUrl = true;
  }
  if (!isSameUrl && url) audio.src = url;
  if (isSameUrl && !audio.paused && !options.force) return;

  audio.play().catch((e) => console.warn(`[beiluAudio ${track}] play failed:`, e));
  if (window.__beiluAudioState[track]) {
    window.__beiluAudioState[track].playing = true;
    window.__beiluAudioState[track].src = url || audio.src;
  }
}

function beiluAudioPause(options = {}) {
  const track = _normalizeTrack(options);
  if (track === "se") {
    // 暂停所有 SE(一般没意义,但支持)
    _seActive.forEach((a) => { try { a.pause(); } catch {} });
    return;
  }
  const audio = _trackAudios[track];
  if (!audio) return;
  audio.pause();
  if (window.__beiluAudioState[track]) window.__beiluAudioState[track].playing = false;
}

export function beiluAudioStop(options = {}) {
  const track = _normalizeTrack(options);
  if (track === "se") {
    _seActive.forEach((a) => { try { a.pause(); a.src = ""; } catch {} });
    _seActive.clear();
    window.__beiluAudioState.se.activeCount = 0;
    return;
  }
  const audio = _trackAudios[track];
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  if (window.__beiluAudioState[track]) window.__beiluAudioState[track].playing = false;
}

function beiluAudioSetVolume(vol, options = {}) {
  const track = _normalizeTrack(options);
  if (track === "se") {
    _seActive.forEach((a) => { try { a.volume = vol; } catch {} });
    return;
  }
  const audio = _trackAudios[track];
  if (!audio) return;
  audio.volume = vol;
  if (window.__beiluAudioState[track]) window.__beiluAudioState[track].volume = vol;
}

// ============================================================
// R5: injectPrompts / uninjectPrompts — 桥接到 beilu-memory injectionPrompts
// ============================================================
// 本轮脚本注入的 id 集合(generation_ended 后自动清)
const _oneShotInjectIds = new Set();

async function _beiluInjectPrompts(prompts) {
  for (const p of prompts) {
    if (!p || !p.content) continue;
    try {
      // T6b：走 beilu-memory 通配 setdata（verb=addInjectionPrompt，rest 平铺）
      const j = await sendAction({
        verb: "addInjectionPrompt", target: "plugins:beilu-memory", source: "web",
        payload: {
          name: p.id || p.name || `iframe-inject-${Date.now()}`,
          description: p.description || "脚本运行时注入",
          enabled: true,
          role: p.role || "system",
          depth: Number(p.depth ?? 0),
          order: Number(p.order ?? 0),
          autoMode: "manual",
          content: String(p.content),
        },
      });
      if (j?.success && j?.id) _oneShotInjectIds.add(j.id);
    } catch (e) { console.warn("[iframe injectPrompts]", e); }
  }
}

async function _beiluUninjectPrompts(ids) {
  for (const id of ids) {
    if (!id) continue;
    try {
      // T6b：走 beilu-memory 通配 setdata（verb=deleteInjectionPrompt）
      await sendAction({ verb: "deleteInjectionPrompt", target: "plugins:beilu-memory", source: "web", payload: { injectionId: id } });
      _oneShotInjectIds.delete(id);
    } catch (e) { console.warn("[iframe uninjectPrompts]", e); }
  }
}

// generation_ended 时清空本轮所有 iframe 注入(避免累积)
function _installOneShotInjectionCleanup() {
  // 自建 bus(如果 eventSystem 还没初始化 — 避免永久不挂)
  if (!window.__beiluEventBus) {
    window.__beiluEventBus = { _listeners: new Map() };
  }
  const bus = window.__beiluEventBus;
  if (!bus._listeners) bus._listeners = new Map();
  const clearAll = async () => {
    if (_oneShotInjectIds.size === 0) return;
    const ids = Array.from(_oneShotInjectIds);
    _oneShotInjectIds.clear();
    for (const id of ids) {
      try {
        // T6b：走 beilu-memory 通配 setdata（verb=deleteInjectionPrompt）
        await sendAction({ verb: "deleteInjectionPrompt", target: "plugins:beilu-memory", source: "web", payload: { injectionId: id } });
      } catch {}
    }
  };
  for (const name of ["generation_ended", "js_generation_ended"]) {
    if (!bus._listeners.has(name)) bus._listeners.set(name, []);
    bus._listeners.get(name).push(clearAll);
  }
}
// 延迟到 __beiluEventBus 初始化后挂载
setTimeout(_installOneShotInjectionCleanup, 0);

// ============================================================
// 全局：父页面 resize 监听（只注册一次）
// ============================================================
let resizeListenerRegistered = false;

function ensureParentResizeListener() {
  if (resizeListenerRegistered) return;
  resizeListenerRegistered = true;

  // W72远期-resize防抖：原每个 resize 事件即向所有 iframe postMessage(viewport+remeasure)，窗口拖拽时
  //   风暴式重排。150ms 防抖合并，拖拽停后只测一次（iframe 内部 requestMeasure 已 RAF 节流，本处治父页风暴）。
  let _resizeDebounceT = null;
  window.addEventListener("resize", () => {
    if (_resizeDebounceT) clearTimeout(_resizeDebounceT);
    _resizeDebounceT = setTimeout(() => {
      _resizeDebounceT = null;
      // 通知所有 iframe 更新视口高度变量 + 重新测量高度
      document.querySelectorAll(".beilu-beauty-iframe").forEach((iframe) => {
        try {
          iframe.contentWindow?.postMessage(
            { type: "beilu-update-viewport", height: window.innerHeight },
            "*",
          );
          iframe.contentWindow?.postMessage({ type: "beilu-remeasure" }, "*");
        } catch (e) {
          /* ignore */
        }
      });
    }, 150);
  });

  // ★ 监听来自 iframe 的音频控制消息
  window.addEventListener("message", (e) => {
    if (!e.data) return;
    // ★ 安全：只接受来自beilu iframe的消息（srcdoc origin为"null"，同源为location.origin）
    if (e.origin !== 'null' && e.origin !== window.location.origin) return;
    switch (e.data.type) {
      case "beilu-audio-play":
        beiluAudioPlay(e.data.url, e.data.options || {});
        break;
      case "beilu-audio-pause":
        beiluAudioPause(e.data.options || {});
        break;
      case "beilu-audio-stop":
        beiluAudioStop(e.data.options || {});
        break;
      case "beilu-audio-volume":
        beiluAudioSetVolume(e.data.volume, e.data.options || {});
        break;
      // R5: injectPrompts / uninjectPrompts — 复用后端 addInjectionPrompt / deleteInjectionPrompt
      case "beilu-inject-prompts":
        _beiluInjectPrompts(Array.isArray(e.data.prompts) ? e.data.prompts : []);
        break;
      case "beilu-uninject-prompts":
        _beiluUninjectPrompts(Array.isArray(e.data.ids) ? e.data.ids : []);
        break;
      // R-HR: iframe 触发美化热重载(刷新规则缓存 + 重渲染最近 N 条)
      case "beilu-reload-beautify":
        import("./virtualQueue.mjs")
          .then((m) => m.reloadBeautify?.(e.data.limit))
          .catch((err) => console.warn("[reloadBeautify import]", err));
        break;
    }
  });
}

/**
 * 当 iframe 重新变为可见时，触发重新测量
 * 解决 tab 切换后黑屏/高度归零的问题
 */
function observeIframeVisibility(iframe) {
  if (typeof IntersectionObserver === "undefined") return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          try {
            iframe.contentWindow?.postMessage(
              { type: "beilu-update-viewport", height: window.innerHeight },
              "*",
            );
            iframe.contentWindow?.postMessage({ type: "beilu-remeasure" }, "*");
          } catch (e) {
            /* ignore */
          }
        }
      });
    },
    { threshold: 0.01 },
  );
  observer.observe(iframe);
}

// ============================================================
// 闭环A: 设置发声权 — 最新 iframe resume, 其余全部 suspend
//   按 dataset.beiluMsgId 区分 active 与其余已渲染 iframe。
// ============================================================
function setActiveAudioIframe(messageId) {
  activeAudioIframe = messageId;
  let _suspended = 0;
  document.querySelectorAll(".beilu-beauty-iframe").forEach((frame) => {
    try {
      const isActive = frame.dataset.beiluMsgId === messageId;
      if (!isActive) _suspended++;
      frame.contentWindow?.postMessage(
        { type: isActive ? "beilu-audio-resume" : "beilu-audio-suspend" },
        "*",
      );
    } catch (e) {
      /* ignore */
    }
  });
  // 白盒: 发声权归属 — 运行时验证"同一时刻只最新出声"
  diag.debug("音频发声权 →", { active: messageId, suspended: _suspended });
}

// ============================================================
// vh 单位预处理
// ============================================================

/**
 * 将 HTML 中所有 CSS 属性声明里的 vh 单位替换为 CSS 变量表达式
 * 避免 iframe 内 vh 指向 iframe 自身高度导致的循环依赖
 *
 * 覆盖范围：
 * - CSS 声明块中的 vh（height、min-height、max-height、top、margin 等所有属性）
 * - 行内 style="..." 中的 vh
 * - JS element.style.xxx = "...vh" 中的 vh
 *
 * @param {string} content - HTML 文档字符串
 * @returns {string} 处理后的 HTML
 */
function replaceVhInContent(content) {
  const hasVh = /\d+(?:\.\d+)?vh/gi.test(content);
  if (!hasVh) return content;

  const convertVh = (value) =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num) => {
      const parsed = parseFloat(num);
      if (!isFinite(parsed)) return match;
      const VARIABLE = "var(--beilu-viewport-height)";
      if (parsed === 100) return VARIABLE;
      return `calc(${VARIABLE} * ${parsed / 100})`;
    });

  // CSS 声明块中所有属性的 vh（匹配 属性名: 含vh的值; 或 }）
  content = content.replace(
    /([\w-]+\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh[^;{}]*)(?=\s*[;}])/gi,
    (match, prefix, value) => {
      // 跳过不在 CSS 上下文中的误匹配（如 JS 变量名）
      if (/^\s*(\/\/|var\s|let\s|const\s|function\s)/.test(match)) return match;
      return `${prefix}${convertVh(value)}`;
    },
  );

  // 行内 style="..." 中的 vh（覆盖所有属性）
  content = content.replace(
    /(style\s*=\s*(["']))([^"']*?)(\2)/gi,
    (match, prefix, _q, styleContent, suffix) => {
      if (!/\d+(?:\.\d+)?vh/i.test(styleContent)) return match;
      const replaced = styleContent.replace(
        /([\w-]+\s*:\s*)([^;]*?\d+(?:\.\d+)?vh[^;]*)/gi,
        (_, p1, p2) => `${p1}${convertVh(p2)}`,
      );
      return `${prefix}${replaced}${suffix}`;
    },
  );

  // JS: element.style.xxx = "...vh"（覆盖所有 style 属性赋值）
  content = content.replace(
    /(\.style\.\w+\s*=\s*(["']))([\s\S]*?)(\2)/gi,
    (match, prefix, _q, val, suffix) => {
      if (!/\b\d+(?:\.\d+)?vh\b/i.test(val)) return match;
      return `${prefix}${convertVh(val)}${suffix}`;
    },
  );

  return content;
}

// ============================================================
// 桥接脚本（注入到 iframe 内部）
// ============================================================

/**
 * 创建注入到 iframe <head> 最前面的"早期脚本"
 * 在 Vue / GSAP 等库加载之前执行，用于：
 * 1. 注入 SillyTavern 兼容 API
 * 2. 注入 beiluAudio 桥接 API（音频播放由父页面管理）
 * 3. 注入 MVU 变量数据到 SillyTavern.chat[0].variables
 *
 * @param {string} rawContentBase64 - 原始消息内容的 base64 编码
 * @param {string} mvuVariablesJson - MVU 变量的 JSON 字符串（直接内联）
 * @returns {string} <script> 标签字符串
 */
function createEarlyScript(
  rawContentBase64 = "",
  mvuVariablesJson = "{}",
  charName = "Character",
  userName = "User",
) {
  // 安全转义：防止角色名中的引号破坏 JS 字符串
  const safeCharName = charName
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\//g, "<\\/");
  const safeUserName = userName
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\//g, "<\\/");

  return (
    `<script>
(function() {
	// ★ 提前注入 SillyTavern 兼容 API（必须在角色卡 Vue 脚本之前执行！）
	var _rawMsg = '';
	try { _rawMsg = '${rawContentBase64}' ? decodeURIComponent(escape(atob('${rawContentBase64}'))) : ''; } catch(e) { console.warn('[earlyScript] base64 decode failed:', e); }

	// ★ MVU 变量数据注入
	var _mvuVars = {};
	try { _mvuVars = ${mvuVariablesJson}; } catch(e) { console.warn('[earlyScript] mvuVars parse failed:', e); }

	// ★ 构造包含 variables 的 chat 条目（供 getAllVariables 读取）
	// 即使 raw message 为空，也保留一条 message-scope 记录，确保状态栏可读到 variables[0]
	var _stChat = [{
		message_id: 0,
		message: _rawMsg,
		mes: _rawMsg,
		name: '${safeCharName}',
		role: 'assistant',
		is_user: false,
		is_hidden: false,
		is_system: false,
		data: {},
		extra: {},
		variables: [_mvuVars],
		swipe_id: 0,
		swipes: [_rawMsg],
		swipe_info: [{}]
	}];
	window.__beiluStChat = _stChat;
	window.SillyTavern = {
		chat: _stChat,
		name1: '${safeUserName}',
		name2: '${safeCharName}'
	};
	window.getCurrentMessageId = function() { return 0; };
	window.getChatMessages = function() { return _stChat; };

	// ★ Zod 继承：从父页面同步获取 Zod 库（避免 CDN 异步加载时序问题）
	try {
		var p = window.parent;
		if (p && p.z && typeof p.z === 'object' && typeof p.z.object === 'function') {
			window.z = p.z;
			self.z = p.z;
		}
	} catch(e) { /* cross-origin */ }

	// ★ 注意：不再在此处直接 Object.assign 父页面 __beiluVarStore.chat
	// 变量同步已由 websocket.mjs 的 _syncMvuVariablesToStore() 统一通过 replaceVariables() 正规 API 处理，
	// 确保 dirty 标记、localStorage 持久化、变量管理器 UI 刷新等副作用都能正确触发。
	// 此处仅保留 SillyTavern.chat[0].variables[0] 的注入（供 iframe 内 getAllVariables 读取）。

	// ★ 闭环A: 音频单一发声 — suspend/resume 协议
	//   非最新 iframe 收到 beilu-audio-suspend → 暂停自带 audio/video,
	//   且 beiluAudio.play(非se) no-op; 最新 iframe 收到 beilu-audio-resume 恢复。
	window.__beiluAudioSuspended = false;
	window.addEventListener('message', function(e) {
		if (!e.data) return;
		if (e.data.type === 'beilu-audio-suspend') {
			window.__beiluAudioSuspended = true;
			try {
				document.querySelectorAll('audio,video').forEach(function(el) { try { el.pause(); } catch(_e) {} });
			} catch(_e) {}
		} else if (e.data.type === 'beilu-audio-resume') {
			window.__beiluAudioSuspended = false;
		}
	});
	// suspended 期间新增的 audio/video 节点立即暂停
	try {
		new MutationObserver(function(muts) {
			if (!window.__beiluAudioSuspended) return;
			muts.forEach(function(m) {
				m.addedNodes.forEach(function(n) {
					if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') { try { n.pause(); } catch(_e) {} }
				});
			});
		}).observe(document.documentElement, { childList: true, subtree: true });
	} catch(_e) {}

	// ★ 音频桥接 API (R2 多轨): 支持 bgm / se / voice 三轨分组
	//   beiluAudio.play(url, {track:'bgm', loop:true, volume:0.5})
	//   beiluAudio.play('click.mp3', {track:'se'})   // 叠加短音效
	//   beiluAudio.play('tts.mp3', {track:'voice'})  // 单实例配音
	//   不传 track 默认 'bgm' (兼容旧调用)
	window.beiluAudio = {
		play: function(url, options) {
			// ★ 闭环A: 被 suspend 的非最新 iframe 不出声(SE 短音效不受限,可叠加)
			var _track = (options && options.track) || 'bgm';
			if (window.__beiluAudioSuspended && _track !== 'se') return;
			try {
				window.parent.postMessage({
					type: 'beilu-audio-play',
					url: url,
					options: options || {}
				}, '*');
			} catch(e) { console.warn('[beiluAudio] play postMessage failed:', e); }
		},
		pause: function(options) {
			try {
				window.parent.postMessage({ type: 'beilu-audio-pause', options: options || {} }, '*');
			} catch(e) { console.warn('[beiluAudio] pause postMessage failed:', e); }
		},
		stop: function(options) {
			try {
				window.parent.postMessage({ type: 'beilu-audio-stop', options: options || {} }, '*');
			} catch(e) { console.warn('[beiluAudio] stop postMessage failed:', e); }
		},
		setVolume: function(vol, options) {
			try {
				window.parent.postMessage({ type: 'beilu-audio-volume', volume: vol, options: options || {} }, '*');
			} catch(e) { console.warn('[beiluAudio] setVolume postMessage failed:', e); }
		},
		isPlaying: function(track) {
			try {
				var s = window.parent.__beiluAudioState;
				var t = track || 'bgm';
				return !!(s && s[t] && s[t].playing);
			} catch(e) { return false; }
		},
		getState: function() {
			try { return window.parent.__beiluAudioState || null; }
			catch(e) { return null; }
		}
	};
})();
</` + `script>`
  );
}

/**
 * 创建注入到 iframe 的桥接脚本
 *
 * 功能：
 * 1. 注入 overflow:hidden CSS reset
 * 2. 设置 --beilu-viewport-height CSS 变量
 * 3. 使用 frameElement.style.height 直接调整高度
 * 4. SillyTavern 兼容 API（含原始消息注入，解决 innerText 丢失 HTML 标签问题）
 *
 * @param {string} messageId - 消息元素 ID
 * @param {string} [rawContentBase64=''] - 原始消息内容的 base64 编码（用于 ST API 兼容）
 * @returns {string} <script> 标签字符串
 */
function createBridgeScript(messageId, rawContentBase64 = "", initialVh = 0, swipeCount = 1, swipeIndex = 0) {
  return `<script>
(function() {
	var __initialVh = ${initialVh || 0};
	// ============================================================
	// 1. CSS Reset：限制宽度溢出，但允许纵向自然滚动
	// ============================================================
	var resetStyle = document.createElement('style');
	resetStyle.textContent = 'html,body{overflow-x:hidden!important;max-width:100%!important;width:100%!important;margin:0!important;padding:0!important;}';
	(document.head || document.documentElement).appendChild(resetStyle);

	// ============================================================
	// 2. 视口高度变量（修复 vh 在 iframe 中的问题）
	// ============================================================
	function updateViewportHeight(fallbackHeight) {
		try {
			var vh = window.parent.innerHeight;
			if (vh > 0) {
				document.documentElement.style.setProperty('--beilu-viewport-height', vh + 'px');
				return;
			}
		} catch(e) {}
		if (fallbackHeight > 0) {
			document.documentElement.style.setProperty('--beilu-viewport-height', fallbackHeight + 'px');
		} else if (__initialVh > 0) {
			document.documentElement.style.setProperty('--beilu-viewport-height', __initialVh + 'px');
		}
	}
	updateViewportHeight();

	// 监听父页面消息（只接受同源或srcdoc origin）
	window.addEventListener('message', function(e) {
		if (!e.data) return;
		if (location.origin !== 'null' && e.origin !== 'null' && e.origin !== location.origin) return;
		if (e.data.type === 'beilu-update-viewport') {
			updateViewportHeight(e.data.height);
		}
		if (e.data.type === 'beilu-remeasure') {
			// 强制重新测量（tab 切换后恢复用）
			lastHeight = 0;
			requestMeasure();
		}
		if (e.data.type === 'beilu-stream-update') {
			// ★ 流式内容增量更新：增量帧可能是整份文档(含<html>/<head>)，
			//   若直接塞进 body.innerHTML 会丢首帧 srcdoc 的壳(doctype/head样式/script)。
			//   故整份文档帧只取 body 内容替换；已是片段则原样替换(向后兼容)。
			var _streamHtml = e.data.content || '';
			var _streamLower = _streamHtml.toLowerCase();
			if (_streamLower.indexOf('<html') !== -1 || _streamLower.indexOf('<body') !== -1) {
				try {
					var _streamDoc = new DOMParser().parseFromString(_streamHtml, 'text/html');
					document.body.innerHTML = _streamDoc.body ? _streamDoc.body.innerHTML : _streamHtml;
				} catch (_err) {
					document.body.innerHTML = _streamHtml;
				}
			} else {
				document.body.innerHTML = _streamHtml;
			}
			requestMeasure();
		}
		if (e.data.type === 'beilu-inject-chat-data') {
			stAPI.chat = e.data.chat || [];
		}
	});

	// ============================================================
	// 3. 高度自适应（直接操作 frameElement）
	// ============================================================
	var lastHeight = 0;
	var scheduled = false;

	function measureAndApply() {
		scheduled = false;
		try {
			var body = document.body;
			var html = document.documentElement;
			if (!body || !html) return;

			var h = Math.max(body.scrollHeight, body.offsetHeight, html.scrollHeight);
			if (!Number.isFinite(h) || h <= 0) return;

			// 最小高度 100px
			h = Math.max(h, 100);

			if (h !== lastHeight) {
				lastHeight = h;
				// 直接操作父元素的 iframe 高度（需要 allow-same-origin）
				try {
					frameElement.style.height = h + 'px';
				} catch(e) {
					// fallback: postMessage（frameElement 不可用时）
					window.parent.postMessage({
						type: 'beilu-iframe-resize',
						id: '${messageId}',
						height: h
					}, '*');
				}
			}
		} catch(e) {}
	}

	function requestMeasure() {
		if (scheduled) return;
		scheduled = true;
		if (typeof requestAnimationFrame === 'function') {
			requestAnimationFrame(measureAndApply);
		} else {
			setTimeout(measureAndApply, 16);
		}
	}

	// ResizeObserver 精确监听
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(requestMeasure).observe(document.documentElement);
		if (document.body) new ResizeObserver(requestMeasure).observe(document.body);
	}

	// MutationObserver 兜底（动态内容加载）
	if (typeof MutationObserver !== 'undefined') {
		new MutationObserver(requestMeasure).observe(document.documentElement, {
			childList: true, subtree: true, attributes: true
		});
	}

	// 初始 + 延迟测量
	measureAndApply();
	window.addEventListener('load', function() {
		measureAndApply();
		setTimeout(measureAndApply, 100);
		setTimeout(measureAndApply, 500);
		setTimeout(measureAndApply, 1000);
		setTimeout(measureAndApply, 3000);
		setTimeout(measureAndApply, 5000);
	});

	// 图片/字体加载后重测
	document.addEventListener('load', function(e) {
		if (e.target && (e.target.tagName === 'IMG' || e.target.tagName === 'LINK')) {
			requestMeasure();
		}
	}, true);

	// ★ 创建后延迟测量 + 低频轮询兜底。
	// [0719 二次修正] 轮询曾按"RO/MO 已覆盖=防御补丁"判删，后经旧库基线核对
	//   （github公共仓库发送 ui/iframeRenderer.mjs:435-467：RO+MO+load+2s 轮询四件套共存且功能完好）
	//   ——基线自带该轮询=有参考的行为，按凛倾判据回正为与基线逐字一致；requestMeasure 是 rAF
	//   合流的轻测量，负载可忽略。
	setTimeout(requestMeasure, 100);
	setTimeout(requestMeasure, 500);
	setTimeout(requestMeasure, 1500);
	setInterval(requestMeasure, 2000);

	// ============================================================
	// 4. 音频播放已移至父页面（通过 beiluAudio 桥接 API）
	//    earlyScript 中注入了 window.beiluAudio 供角色卡使用
	// ============================================================

	// ============================================================
	// 5. SillyTavern 兼容 API（补充 earlyScript 中未定义的方法）
	// ============================================================
	// 原始消息数据已在 earlyScript 中注入到 window.__beiluStChat
	var stAPI = window.SillyTavern || { chat: window.__beiluStChat || [] };
	stAPI.switchSwipe = function(index) {
			window.parent.postMessage({
				type: 'beilu-swipe-switch',
				id: '${messageId}',
				index: index
			}, '*');
	};

	window.SillyTavern = stAPI;
	// ══ [0727 A11 根修·ST 原生开场白切换套路] ══
	// ST 卡的经典写法（小圆卡 kcb 脚本实证）：改 chat[0].swipe_id/mes → await saveChat() →
	// await reloadCurrentChat()。此前三层断：① earlyScript 的 swipes 恒长度 1（index≥1 直接
	// 判"找不到索引"）；② saveChat/reloadCurrentChat 只有 stCompat 按需层的 no-op 空壳，且
	// detectNeeds 对裸 window.SillyTavern 写法的卡不命中=连空壳都没有；③ 兜底 alert 被 sandbox 吞。
	// 本段无条件注入且顺序在 stCompat 之后（直接赋值=覆盖空壳），给真桥：
	//   swipes 补齐到宿主真实条数（内容用占位——卡的判定只看 length，切换真实生效走宿主
	//   setTimeLineAbsolute 链，不消费这里的内容）；saveChat=检测 swipe_id 变化 → 与
	//   stAPI.switchSwipe 同一条 postMessage 桥；reloadCurrentChat=空实现（切换后父页面重渲染本消息）。
	try {
		var _swCount = ${Number(swipeCount) || 1};
		var _swIndex = ${Number(swipeIndex) || 0};
		var _c0 = (stAPI.chat && stAPI.chat[0]) || null;
		if (_c0) {
			if (!Array.isArray(_c0.swipes)) _c0.swipes = [_c0.mes || ''];
			while (_c0.swipes.length < _swCount) _c0.swipes.push(_c0.swipes[0] || '');
			if (!Array.isArray(_c0.swipe_info)) _c0.swipe_info = [{}];
			while (_c0.swipe_info.length < _swCount) _c0.swipe_info.push({});
			if (_swIndex >= 0 && _swIndex < _c0.swipes.length) _c0.swipe_id = _swIndex;
			var _swipeId0 = _c0.swipe_id;
			stAPI.saveChat = function() {
				var _cur = (stAPI.chat && stAPI.chat[0]) ? stAPI.chat[0].swipe_id : _swipeId0;
				if (typeof _cur === 'number' && _cur !== _swipeId0 && _cur >= 0) {
					_swipeId0 = _cur;
					stAPI.switchSwipe(_cur);
				}
				return Promise.resolve();
			};
			stAPI.reloadCurrentChat = function() { return Promise.resolve(); };
		}
	} catch (e) { console.warn('[bridgeScript] swipe 桥初始化失败:', e); }
	// getCurrentMessageId 和 getChatMessages 已在 earlyScript 中定义
	window.createChatMessages = function(msgs) {
		window.parent.postMessage({
			type: 'beilu-chat-message',
			id: '${messageId}',
			messages: msgs
		}, '*');
	};
	window.triggerSlash = function(cmd) {
		window.parent.postMessage({
			type: 'beilu-slash-command',
			id: '${messageId}',
			command: cmd
		}, '*');
	};
})();
</script>`;
}

// ============================================================
// 公开接口
// ============================================================

/**
 * 将完整 HTML 文档渲染为 iframe
 *
 * @param {string} htmlDocument - 完整的 HTML 文档字符串
 * @param {HTMLElement} messageElement - 消息 DOM 元素（需包含 .message-content）
 * @param {string} [rawContent=''] - 原始消息文本（display regex 处理前），用于注入 ST API
 * @param {object} [options={}] - 额外选项
 * @param {object} [options.mvuVariables] - MVU 累积变量对象，注入到 iframe 中供状态栏读取
 * @returns {HTMLIFrameElement|null} 创建的 iframe 元素
 */
export async function renderAsIframe(
  htmlDocument,
  messageElement,
  rawContent = "",
  options = {},
) {
  const contentEl = messageElement.querySelector(".message-content");
  if (!contentEl) {
    diag.warn("未找到 .message-content 容器");
    return null;
  }

  // 确保父页面 resize 监听已注册
  ensureParentResizeListener();

  // 移除 markdown-body 类（避免样式干扰）
  contentEl.classList.remove("markdown-body");
  contentEl.classList.add("iframe-content");
  contentEl.innerHTML = "";

  // ★ 强制覆盖 daisyUI .chat-bubble 的宽度约束
  // daisyUI 设置了 width: fit-content; max-inline-size: 90% 导致 iframe 无法全宽
  const chatBubble = contentEl.closest(".chat-bubble");
  if (chatBubble) {
    chatBubble.style.cssText +=
      ";margin-left:0!important;width:100%!important;max-width:100%!important;max-inline-size:100%!important;padding:0!important;";
  }

  // ★ 让消息容器也全宽
  const chatMessage = contentEl.closest(".chat-message");
  if (chatMessage) {
    chatMessage.style.cssText += ";max-width:100%!important;";
  }

  // 创建 iframe
  const iframe = document.createElement("iframe");
  iframe.className = "beilu-beauty-iframe";
  // F-T4 + F-D5 XSS: sandbox 可配置 3 档 (localStorage: beilu-iframe-sandbox)
  //   standard (★默认)              → 含 allow-same-origin(frameElement直操高度/原生audio/跨域API),
  //                                    内容安全由导入时 data_reader 清理 polyglot 保障。
  //   strict                         → 去掉 allow-same-origin(opaque origin), 高度/音频走 postMessage fallback。
  //   sandbox                        → 最严格,只允许脚本(纯渲染)。
  const _sandboxLevel = (typeof localStorage !== "undefined" && storage.get(KEYS.BEILU_IFRAME_SANDBOX)) || DEFAULTS.iframe.sandboxLevel;
  // [0727 A11] 三档均补 allow-modals：无它则卡脚本的 alert/confirm 被浏览器静默吞掉——
  //   卡的失败兜底提示消失，"点了没反应"连一句解释都不给用户（0727 小圆卡实证）。
  //   modals 只弹对话框不扩权，三档语义不变。
  const _sandboxMap = {
    standard: "allow-scripts allow-same-origin allow-popups allow-modals",
    strict: "allow-scripts allow-popups allow-modals",
    sandbox: "allow-scripts allow-modals",
  };
  iframe.sandbox = _sandboxMap[_sandboxLevel] || _sandboxMap.strict;
  iframe.setAttribute("allowfullscreen", "");
  // Audio 已移至父页面，不再需要 iframe autoplay 权限

  // 消息 ID
  const messageId = messageElement.id || `msg-${Date.now()}`;
  // ★ 闭环A: 标记 iframe 的 messageId, 供发声权广播按帧区分
  iframe.dataset.beiluMsgId = messageId;

  // ★ 预处理 HTML：vh 单位替换
  let modifiedHtml = replaceVhInContent(htmlDocument);

  // ★ 预处理 HTML：宏替换（必须在 srcdoc 设置之前，否则浏览器解析 HTML 时会尝试加载未替换的宏作为 URL）
  // 典型场景：角色卡 HTML 中 src="{{avatar}}" 在 JS 运行之前就被浏览器当作相对 URL 请求 → 404
  // 获取角色名/用户名（提升到外层作用域，earlyScript 也需要）
  const charNameEl = document.getElementById("char-name-display");
  const macroCharName = charNameEl?.textContent?.trim() || "Character";
  const macroUserName =
    document.querySelector("[data-user-name]")?.dataset?.userName || "User";

  {
    // 角色卡头像 URL
    const charId = charNameEl?.dataset?.charId;
    const macroAvatar = charId
      ? `/parts/chars:${encodeURIComponent(charId)}/image.png`
      : "";

    // 诊断：记录宏替换参数
    const hasMacros =
      /\{\{(user|char|avatar)\}\}/i.test(modifiedHtml) ||
      /%7B%7B(user|char|avatar)%7D%7D/i.test(modifiedHtml);
    if (hasMacros) {
      diag.log("宏替换:", {
        user: macroUserName,
        char: macroCharName,
        avatar: macroAvatar
          ? "✓ " + macroAvatar.substring(0, 60)
          : "✗ (empty — charId=" + (charId || "null") + ")",
        charNameElFound: !!charNameEl,
      });
    }

    modifiedHtml = modifiedHtml
      .replace(/\{\{user\}\}/gi, macroUserName)
      .replace(/\{\{char\}\}/gi, macroCharName)
      .replace(/\{\{avatar\}\}/gi, macroAvatar)
      // P3修复：处理 URL 编码版本的宏（浏览器可能在解析 HTML 时将 { } 编码为 %7B %7D）
      .replace(/%7B%7Buser%7D%7D/gi, macroUserName)
      .replace(/%7B%7Bchar%7D%7D/gi, macroCharName)
      .replace(/%7B%7Bavatar%7D%7D/gi, macroAvatar);

    // 诊断：替换后检查是否仍有未替换的宏
    const remainingMacros = modifiedHtml.match(/\{\{[^}]+\}\}/g);
    if (remainingMacros) {
      diag.warn("宏替换后仍有未处理的宏:", [...new Set(remainingMacros)]);
    }
    const remainingEncodedMacros = modifiedHtml.match(/%7B%7B[^%]*%7D%7D/gi);
    if (remainingEncodedMacros) {
      diag.warn("宏替换后仍有 URL 编码的宏:", [
        ...new Set(remainingEncodedMacros),
      ]);
    }
  }

  // ★ 对原始消息做 base64 编码，注入到 earlyScript 中供 ST API 使用
  let rawContentBase64 = "";
  try {
    if (rawContent) {
      rawContentBase64 = btoa(unescape(encodeURIComponent(rawContent)));
    }
  } catch (e) {
    diag.warn("base64 encode failed:", e);
  }

  // ★ 序列化 MVU 变量为 JSON（用于 earlyScript 注入）
  let mvuVariablesJson = "{}";
  if (
    options.mvuVariables &&
    typeof options.mvuVariables === "object" &&
    Object.keys(options.mvuVariables).length > 0
  ) {
    try {
      mvuVariablesJson = JSON.stringify(options.mvuVariables);
      // 安全检查：超大变量对象可能导致 srcdoc 膨胀
      if (mvuVariablesJson.length > 50 * 1024) {
        diag.warn(
          `MVU 变量数据过大 (${(mvuVariablesJson.length / 1024).toFixed(1)}KB)，可能影响 iframe 加载性能`,
        );
      }
    } catch (e) {
      diag.warn("MVU 变量 JSON 序列化失败:", e);
      mvuVariablesJson = "{}";
    }
  }

  // ★ 注入 early script（beiluAudio 桥接 API + ST API + MVU 变量）到 <head> 最前面
  const earlyScript = createEarlyScript(
    rawContentBase64,
    mvuVariablesJson,
    macroCharName,
    macroUserName,
  );
  if (modifiedHtml.includes("<head>")) {
    modifiedHtml = modifiedHtml.replace("<head>", "<head>" + earlyScript);
  } else if (modifiedHtml.includes("<HEAD>")) {
    modifiedHtml = modifiedHtml.replace("<HEAD>", "<HEAD>" + earlyScript);
  } else if (/<!doctype|<!DOCTYPE/i.test(modifiedHtml)) {
    // 没有 <head> 标签，在 <html> 后插入
    modifiedHtml = modifiedHtml.replace(
      /<html[^>]*>/i,
      "$&<head>" + earlyScript + "</head>",
    );
  } else {
    // 最后手段：直接在最前面插入
    modifiedHtml = earlyScript + modifiedHtml;
  }

  // ★ 新增：ST 兼容层注入（在 earlyScript 之后、bridgeScript 之前）
  const { needsST, needsMVU, needsVue, needsEJS } = detectNeeds(htmlDocument);
  diag.debug("ST 兼容层检测结果:", {
    needsST,
    needsMVU,
    needsVue,
    needsEJS,
    htmlLen: htmlDocument.length,
  });
  if (needsST || needsMVU || needsVue || needsEJS) {
    diag.log(
      `ST 兼容层注入开始: Layer1=${needsST}, Layer2/MVU=${needsMVU}, Vue=${needsVue}, EJS=${needsEJS}, msgId=${messageId}`,
    );
    const stCompatScript = await buildInjectionScript({
      needsST,
      needsMVU,
      needsVue,
      needsEJS,
      messageId: parseInt(messageId.replace(/\D/g, "")) || 0,
      // userName / charName 将在 STContextEnhancement 中使用
    });
    if (stCompatScript) {
      // 插入到 earlyScript 之后（在 <head> 内，角色卡脚本之前）
      if (modifiedHtml.includes("<head>")) {
        // earlyScript 已经在 <head> 后面了，stCompat 追加到 earlyScript 之后
        // 找到 earlyScript 的结束位置（第一个 </script> 之后）
        const earlyScriptEnd = modifiedHtml.indexOf(
          "</script>",
          modifiedHtml.indexOf("<head>"),
        );
        if (earlyScriptEnd !== -1) {
          const insertPos = earlyScriptEnd + "</script>".length;
          modifiedHtml =
            modifiedHtml.slice(0, insertPos) +
            stCompatScript +
            modifiedHtml.slice(insertPos);
        } else {
          // fallback: 在 </head> 前插入
          modifiedHtml = modifiedHtml.replace(
            "</head>",
            stCompatScript + "</head>",
          );
        }
      } else {
        // 没有 <head> 标签，直接在 earlyScript 后追加
        modifiedHtml += stCompatScript;
      }
      diag.log(
        `ST 兼容层注入完成: Layer1=${needsST}, Layer2/MVU=${needsMVU}, Vue=${needsVue}, EJS=${needsEJS}, 脚本大小=${(stCompatScript.length / 1024).toFixed(1)}KB`,
      );
    }
  }

  // ★ 注入桥接脚本（在 </body> 或 </html> 前）
  // [0727 A11] 真实 swipe 数量/索引带进 iframe（时间线单源=virtualQueue，window 桥防模块环）：
  //   setTimeLineAbsolute 本就是会话级切换，与该桥的会话级语义一致
  const _tl = (() => { try { return window._beiluTimeLineInfo?.() || null; } catch { return null; } })();
  const bridgeScript = createBridgeScript(messageId, "", window.innerHeight, _tl?.timeLinesCount || 1, _tl?.timeLineIndex || 0);
  if (modifiedHtml.includes("</body>")) {
    modifiedHtml = modifiedHtml.replace("</body>", bridgeScript + "</body>");
  } else if (modifiedHtml.includes("</html>")) {
    modifiedHtml = modifiedHtml.replace("</html>", bridgeScript + "</html>");
  } else {
    modifiedHtml += bridgeScript;
  }

  // ★ 使用 srcdoc 加载（与父页面同源，继承 autoplay 权限）
  // 默认使用 srcdoc，不使用 Blob URL
  // Blob URL 的 origin 是 null（opaque），不继承父页面的 Media Engagement Index
  // srcdoc + sandbox="allow-same-origin" → iframe 与父页面同源 → 音频自动播放可继承
  iframe.srcdoc = modifiedHtml;

  // 初始高度（后续由桥接脚本 frameElement.style.height 覆盖）
  iframe.style.height = "600px";

  contentEl.appendChild(iframe);

  // ★ 监听 iframe 可见性变化（解决 tab 切换后黑屏问题）
  observeIframeVisibility(iframe);

  // ★ 闭环A: 最新带音频消息渲染完成 → 取得发声权, 其余 iframe 静音
  //   iframe 内脚本需就绪才能收消息, 故 load 后再广播(并立即广播一次兜底)。
  setActiveAudioIframe(messageId);
  iframe.addEventListener("load", () => setActiveAudioIframe(messageId), {
    once: true,
  });

  // ★ 监听 fallback postMessage（frameElement 不可用时的后备）
  const handleMessage = (e) => {
    // ★ 闭环C(RD-2): 与主路径(:242)一致, 拒绝伪造 origin 的 postMessage
    if (e.origin !== 'null' && e.origin !== window.location.origin) {
      // 白盒: 记录被拒的伪造 origin — 安全审计 + 运行时验证拦截生效
      diag.warn("拒绝非法 origin 的 fallback postMessage:", e.origin);
      return;
    }
    if (!e.data || e.data.id !== messageId) return;

    switch (e.data.type) {
      case "beilu-iframe-resize": {
        // fallback：postMessage 方式调整高度
        const newHeight = Math.max(100, e.data.height);
        iframe.style.height = newHeight + "px";
        break;
      }
      case "beilu-swipe-switch": {
        import("../transport/endpoints.mjs")
          .then(({ setTimeLineAbsolute }) => {
            const targetIndex = e.data.index || 0;
            setTimeLineAbsolute(targetIndex);
          })
          .catch((err) =>
            console.warn("[iframeRenderer] swipe switch failed:", err),
          );
        break;
      }
      case "beilu-chat-message": {
        // ★ P0 修复：iframe 请求发送消息（如选择框选项点击）
        import("../transport/endpoints.mjs")
          .then(async ({ addUserReply, triggerCharacterReply }) => {
            const msgs = e.data.messages || [];
            for (const msg of msgs) {
              if (msg.message) {
                await addUserReply(msg.message);
              }
            }
            // 发送完用户消息后，触发 AI 回复
            await triggerCharacterReply();
          })
          .catch((err) =>
            console.warn("[iframeRenderer] chat-message failed:", err),
          );
        break;
      }
      case "beilu-slash-command": {
        // ★ P0 修复：iframe 请求执行斜杠命令
        const cmd = e.data.command || "";
        const sendMatch = cmd.match(/^\/send\s+([\s\S]+)/);
        if (sendMatch) {
          import("../transport/endpoints.mjs")
            .then(async ({ addUserReply, triggerCharacterReply }) => {
              await addUserReply(sendMatch[1]);
              await triggerCharacterReply();
            })
            .catch((err) =>
              console.warn("[iframeRenderer] /send failed:", err),
            );
        } else if (cmd.trim() === "/trigger") {
          import("../transport/endpoints.mjs")
            .then(({ triggerCharacterReply }) => {
              triggerCharacterReply();
            })
            .catch((err) =>
              console.warn("[iframeRenderer] /trigger failed:", err),
            );
        } else {
          console.warn("[iframeRenderer] 未知斜杠命令:", cmd);
        }
        break;
      }
    }
  };
  window.addEventListener("message", handleMessage);

  // 元素移除时清理
  onElementRemoved(messageElement, () => {
    window.removeEventListener("message", handleMessage);
    // ★ 闭环A: 持发声权的 iframe 被移除 → 停 bgm/voice, 防孤儿背景乐
    if (activeAudioIframe === messageId) {
      beiluAudioStop({ track: "bgm" });
      beiluAudioStop({ track: "voice" });
      activeAudioIframe = null;
    }
  });

  diag.log(`消息 ${messageId} 已渲染为 iframe（${modifiedHtml.length} 字符）`);
  return iframe;
}

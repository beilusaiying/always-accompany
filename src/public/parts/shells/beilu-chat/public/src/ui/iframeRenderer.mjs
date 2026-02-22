/**
 * iframe 沙箱渲染器（v2 — 借鉴 JS-Slash-Runner 方案）
 *
 * 核心改动（相比 v1）：
 * 1. 高度自适应从 postMessage 改为 frameElement.style.height 直接操作
 * 2. 注入 overflow:hidden 到 iframe body，消除内部滚动条
 * 3. vh 单位替换为 CSS 变量，解决 iframe 内 vh 循环依赖
 * 4. 添加 allow="autoplay" 支持音频自动播放
 * 5. 父页面 resize 监听，实时更新 iframe 内视口变量
 *
 * 参考：JS-Slash-Runner/src/panel/render/iframe.ts
 *       JS-Slash-Runner/src/iframe/adjust_iframe_height.js
 *       JS-Slash-Runner/src/iframe/adjust_viewport.js
 */

import { onElementRemoved } from '../../../../../scripts/onElementRemoved.mjs'

// ============================================================
// 全局：父页面音频管理器（单例）
// ============================================================
let _parentAudio = null

function getParentAudio() {
	if (!_parentAudio) {
		_parentAudio = new Audio()
		_parentAudio.loop = true
	}
	return _parentAudio
}

// 对外暴露播放状态（供 iframe 同步查询）
window.__beiluAudioState = { playing: false, src: '', volume: 0.5 }

function beiluAudioPlay(url, options = {}) {
	const audio = getParentAudio()
	if (options.loop !== undefined) audio.loop = options.loop
	if (options.volume !== undefined) {
		audio.volume = options.volume
		window.__beiluAudioState.volume = options.volume
	}
	if (url && audio.src !== url) {
		audio.src = url
	}
	audio.play().catch(e => console.warn('[beiluAudio] play failed:', e))
	window.__beiluAudioState.playing = true
	window.__beiluAudioState.src = url || audio.src
}

function beiluAudioPause() {
	const audio = getParentAudio()
	audio.pause()
	window.__beiluAudioState.playing = false
}

function beiluAudioSetVolume(vol) {
	const audio = getParentAudio()
	audio.volume = vol
	window.__beiluAudioState.volume = vol
}

// ============================================================
// 全局：父页面 resize 监听（只注册一次）
// ============================================================
let resizeListenerRegistered = false

function ensureParentResizeListener() {
	if (resizeListenerRegistered) return
	resizeListenerRegistered = true

	window.addEventListener('resize', () => {
		// 通知所有 iframe 更新视口高度变量 + 重新测量高度
		document.querySelectorAll('.beilu-beauty-iframe').forEach(iframe => {
			try {
				iframe.contentWindow?.postMessage({ type: 'beilu-update-viewport' }, '*')
				iframe.contentWindow?.postMessage({ type: 'beilu-remeasure' }, '*')
			} catch (e) { /* ignore */ }
		})
	})

	// ★ 监听来自 iframe 的音频控制消息
	window.addEventListener('message', (e) => {
		if (!e.data) return
		switch (e.data.type) {
			case 'beilu-audio-play':
				beiluAudioPlay(e.data.url, e.data.options || {})
				break
			case 'beilu-audio-pause':
				beiluAudioPause()
				break
			case 'beilu-audio-volume':
				beiluAudioSetVolume(e.data.volume)
				break
		}
	})
}

/**
 * 当 iframe 重新变为可见时，触发重新测量
 * 解决 tab 切换后黑屏/高度归零的问题
 */
function observeIframeVisibility(iframe) {
	if (typeof IntersectionObserver === 'undefined') return

	const observer = new IntersectionObserver((entries) => {
		entries.forEach(entry => {
			if (entry.isIntersecting) {
				try {
					iframe.contentWindow?.postMessage({ type: 'beilu-update-viewport' }, '*')
					iframe.contentWindow?.postMessage({ type: 'beilu-remeasure' }, '*')
				} catch (e) { /* ignore */ }
			}
		})
	}, { threshold: 0.01 })
	observer.observe(iframe)
}

// ============================================================
// vh 单位预处理（借鉴 JS-Slash-Runner replaceVhInContent）
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
	const hasVh = /\d+(?:\.\d+)?vh/gi.test(content)
	if (!hasVh) return content

	const convertVh = (value) =>
		value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num) => {
			const parsed = parseFloat(num)
			if (!isFinite(parsed)) return match
			const VARIABLE = 'var(--beilu-viewport-height)'
			if (parsed === 100) return VARIABLE
			return `calc(${VARIABLE} * ${parsed / 100})`
		})

	// CSS 声明块中所有属性的 vh（匹配 属性名: 含vh的值; 或 }）
	content = content.replace(
		/([\w-]+\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh[^;{}]*)(?=\s*[;}])/gi,
		(match, prefix, value) => {
			// 跳过不在 CSS 上下文中的误匹配（如 JS 变量名）
			if (/^\s*(\/\/|var\s|let\s|const\s|function\s)/.test(match)) return match
			return `${prefix}${convertVh(value)}`
		}
	)

	// 行内 style="..." 中的 vh（覆盖所有属性）
	content = content.replace(
		/(style\s*=\s*(["']))([^"']*?)(\2)/gi,
		(match, prefix, _q, styleContent, suffix) => {
			if (!/\d+(?:\.\d+)?vh/i.test(styleContent)) return match
			const replaced = styleContent.replace(
				/([\w-]+\s*:\s*)([^;]*?\d+(?:\.\d+)?vh[^;]*)/gi,
				(_, p1, p2) => `${p1}${convertVh(p2)}`
			)
			return `${prefix}${replaced}${suffix}`
		}
	)

	// JS: element.style.xxx = "...vh"（覆盖所有 style 属性赋值）
	content = content.replace(
		/(\.style\.\w+\s*=\s*(["']))([\s\S]*?)(\2)/gi,
		(match, prefix, _q, val, suffix) => {
			if (!/\b\d+(?:\.\d+)?vh\b/i.test(val)) return match
			return `${prefix}${convertVh(val)}${suffix}`
		}
	)

	return content
}

// ============================================================
// 桥接脚本（注入到 iframe 内部）
// ============================================================

/**
 * 创建注入到 iframe <head> 最前面的"早期脚本"
 * 在 Vue / GSAP 等库加载之前执行，用于：
 * 1. 注入 SillyTavern 兼容 API
 * 2. 注入 beiluAudio 桥接 API（音频播放由父页面管理）
 *
 * @returns {string} <script> 标签字符串
 */
function createEarlyScript(rawContentBase64 = '') {
	return `<script>
(function() {
	// ★ 提前注入 SillyTavern 兼容 API（必须在角色卡 Vue 脚本之前执行！）
	var _rawMsg = '';
	try { _rawMsg = '${rawContentBase64}' ? decodeURIComponent(escape(atob('${rawContentBase64}'))) : ''; } catch(e) { console.warn('[earlyScript] base64 decode failed:', e); }
	var _stChat = _rawMsg ? [{ message: _rawMsg }] : [];
	window.__beiluStChat = _stChat;
	window.SillyTavern = { chat: _stChat };
	window.getCurrentMessageId = function() { return 0; };
	window.getChatMessages = function() { return _stChat; };

	// ★ 音频桥接 API：角色卡通过此 API 控制父页面的音频播放器
	// Audio 对象在父页面，不在 iframe 内，彻底避免 autoplay 限制和控制冲突
	window.beiluAudio = {
		play: function(url, options) {
			try {
				window.parent.postMessage({
					type: 'beilu-audio-play',
					url: url,
					options: options || {}
				}, '*');
			} catch(e) { console.warn('[beiluAudio] play postMessage failed:', e); }
		},
		pause: function() {
			try {
				window.parent.postMessage({ type: 'beilu-audio-pause' }, '*');
			} catch(e) { console.warn('[beiluAudio] pause postMessage failed:', e); }
		},
		setVolume: function(vol) {
			try {
				window.parent.postMessage({ type: 'beilu-audio-volume', volume: vol }, '*');
			} catch(e) { console.warn('[beiluAudio] setVolume postMessage failed:', e); }
		},
		isPlaying: function() {
			try {
				return window.parent.__beiluAudioState ? window.parent.__beiluAudioState.playing : false;
			} catch(e) { return false; }
		}
	};
})();
</` + `script>`
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
function createBridgeScript(messageId, rawContentBase64 = '') {
	return `<script>
(function() {
	// ============================================================
	// 1. CSS Reset：限制宽度溢出，但允许纵向自然滚动
	// ============================================================
	var resetStyle = document.createElement('style');
	resetStyle.textContent = 'html,body{overflow-x:hidden!important;max-width:100%!important;width:100%!important;margin:0!important;padding:0!important;}';
	(document.head || document.documentElement).appendChild(resetStyle);

	// ============================================================
	// 2. 视口高度变量（修复 vh 在 iframe 中的问题）
	// ============================================================
	function updateViewportHeight() {
		try {
			var vh = window.parent.innerHeight;
			if (vh > 0) {
				document.documentElement.style.setProperty('--beilu-viewport-height', vh + 'px');
			}
		} catch(e) {}
	}
	updateViewportHeight();

	// 监听父页面消息
	window.addEventListener('message', function(e) {
		if (!e.data) return;
		if (e.data.type === 'beilu-update-viewport') {
			updateViewportHeight();
		}
		if (e.data.type === 'beilu-remeasure') {
			// 强制重新测量（tab 切换后恢复用）
			lastHeight = 0;
			requestMeasure();
		}
		if (e.data.type === 'beilu-inject-chat-data') {
			stAPI.chat = e.data.chat || [];
		}
	});

	// ============================================================
	// 3. 高度自适应（直接操作 frameElement — 参考 JS-Slash-Runner）
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

	// 持续检查（不限时间，每 2 秒一次 — 保证 tab 切换后仍能恢复）
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
</script>`
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
 * @returns {HTMLIFrameElement|null} 创建的 iframe 元素
 */
export function renderAsIframe(htmlDocument, messageElement, rawContent = '') {
	const contentEl = messageElement.querySelector('.message-content')
	if (!contentEl) {
		console.warn('[iframeRenderer] 未找到 .message-content 容器')
		return null
	}

	// 确保父页面 resize 监听已注册
	ensureParentResizeListener()

	// 移除 markdown-body 类（避免样式干扰）
	contentEl.classList.remove('markdown-body')
	contentEl.classList.add('iframe-content')
	contentEl.innerHTML = ''

	// ★ 强制覆盖 daisyUI .chat-bubble 的宽度约束
	// daisyUI 设置了 width: fit-content; max-inline-size: 90% 导致 iframe 无法全宽
	const chatBubble = contentEl.closest('.chat-bubble')
	if (chatBubble) {
		chatBubble.style.cssText += ';margin-left:0!important;width:100%!important;max-width:100%!important;max-inline-size:100%!important;padding:0!important;'
	}

	// ★ 让消息容器也全宽
	const chatMessage = contentEl.closest('.chat-message')
	if (chatMessage) {
		chatMessage.style.cssText += ';max-width:100%!important;'
	}

	// 创建 iframe
	const iframe = document.createElement('iframe')
	iframe.className = 'beilu-beauty-iframe'
	iframe.sandbox = 'allow-scripts allow-same-origin allow-popups'
	iframe.setAttribute('allowfullscreen', '')
	// Audio 已移至父页面，不再需要 iframe autoplay 权限

	// 消息 ID
	const messageId = messageElement.id || `msg-${Date.now()}`

	// ★ 预处理 HTML：vh 单位替换
	let modifiedHtml = replaceVhInContent(htmlDocument)

	// ★ 对原始消息做 base64 编码，注入到 earlyScript 中供 ST API 使用
	let rawContentBase64 = ''
	try {
		if (rawContent) {
			rawContentBase64 = btoa(unescape(encodeURIComponent(rawContent)))
		}
	} catch (e) {
		console.warn('[iframeRenderer] base64 encode failed:', e)
	}

	// ★ 注入 early script（beiluAudio 桥接 API + ST API）到 <head> 最前面
	const earlyScript = createEarlyScript(rawContentBase64)
	if (modifiedHtml.includes('<head>')) {
		modifiedHtml = modifiedHtml.replace('<head>', '<head>' + earlyScript)
	} else if (modifiedHtml.includes('<HEAD>')) {
		modifiedHtml = modifiedHtml.replace('<HEAD>', '<HEAD>' + earlyScript)
	} else if (/<!doctype|<!DOCTYPE/i.test(modifiedHtml)) {
		// 没有 <head> 标签，在 <html> 后插入
		modifiedHtml = modifiedHtml.replace(/<html[^>]*>/i, '$&<head>' + earlyScript + '</head>')
	} else {
		// 最后手段：直接在最前面插入
		modifiedHtml = earlyScript + modifiedHtml
	}

	// ★ 注入桥接脚本（在 </body> 或 </html> 前）
	const bridgeScript = createBridgeScript(messageId)
	if (modifiedHtml.includes('</body>')) {
		modifiedHtml = modifiedHtml.replace('</body>', bridgeScript + '</body>')
	} else if (modifiedHtml.includes('</html>')) {
		modifiedHtml = modifiedHtml.replace('</html>', bridgeScript + '</html>')
	} else {
		modifiedHtml += bridgeScript
	}

	// ★ 使用 srcdoc 加载（与父页面同源，继承 autoplay 权限）
	// 参考 JS-Slash-Runner：默认使用 srcdoc，不使用 Blob URL
	// Blob URL 的 origin 是 null（opaque），不继承父页面的 Media Engagement Index
	// srcdoc + sandbox="allow-same-origin" → iframe 与父页面同源 → 音频自动播放可继承
	iframe.srcdoc = modifiedHtml

	// 初始高度（后续由桥接脚本 frameElement.style.height 覆盖）
	iframe.style.height = '600px'

	contentEl.appendChild(iframe)

	// ★ 监听 iframe 可见性变化（解决 tab 切换后黑屏问题）
	observeIframeVisibility(iframe)

	// ★ 监听 fallback postMessage（frameElement 不可用时的后备）
	const handleMessage = (e) => {
		if (!e.data || e.data.id !== messageId) return

		switch (e.data.type) {
			case 'beilu-iframe-resize': {
				// fallback：postMessage 方式调整高度
				const newHeight = Math.max(100, e.data.height)
				iframe.style.height = newHeight + 'px'
				break
			}
			case 'beilu-swipe-switch': {
				import('../endpoints.mjs').then(({ setTimeLineAbsolute }) => {
					const targetIndex = e.data.index || 0
					setTimeLineAbsolute(targetIndex)
				}).catch(err => console.warn('[iframeRenderer] swipe switch failed:', err))
				break
			}
			case 'beilu-chat-message': {
				// ★ P0 修复：iframe 请求发送消息（如选择框选项点击）
				import('../endpoints.mjs').then(async ({ addUserReply, triggerCharacterReply }) => {
					const msgs = e.data.messages || []
					for (const msg of msgs) {
						if (msg.message) {
							await addUserReply(msg.message)
						}
					}
					// 发送完用户消息后，触发 AI 回复
					await triggerCharacterReply()
				}).catch(err => console.warn('[iframeRenderer] chat-message failed:', err))
				break
			}
			case 'beilu-slash-command': {
				// ★ P0 修复：iframe 请求执行斜杠命令
				const cmd = e.data.command || ''
				const sendMatch = cmd.match(/^\/send\s+([\s\S]+)/)
				if (sendMatch) {
					import('../endpoints.mjs').then(async ({ addUserReply, triggerCharacterReply }) => {
						await addUserReply(sendMatch[1])
						await triggerCharacterReply()
					}).catch(err => console.warn('[iframeRenderer] /send failed:', err))
				} else if (cmd.trim() === '/trigger') {
					import('../endpoints.mjs').then(({ triggerCharacterReply }) => {
						triggerCharacterReply()
					}).catch(err => console.warn('[iframeRenderer] /trigger failed:', err))
				} else {
					console.warn('[iframeRenderer] 未知斜杠命令:', cmd)
				}
				break
			}
		}
	}
	window.addEventListener('message', handleMessage)

	// 元素移除时清理
	onElementRemoved(messageElement, () => {
		window.removeEventListener('message', handleMessage)
	})

	console.log(`[iframeRenderer] 消息 ${messageId} 已渲染为 iframe（${modifiedHtml.length} 字符）`)
	return iframe
}
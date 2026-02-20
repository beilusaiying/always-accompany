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

	// ★ 父页面用户交互时，直接同步调用 iframe 内的音频恢复函数
	// 关键：postMessage 不传递用户手势上下文，play() 仍被阻止
	// 但 srcdoc iframe 与父页面同源，可以直接同步调用（保持用户手势调用栈）
	const notifyIframesUserInteraction = () => {
		document.querySelectorAll('.beilu-beauty-iframe').forEach(iframe => {
			try {
				// 直接同步调用：保持用户手势上下文，让 play() 被浏览器接受
				if (iframe.contentWindow?.__beiluResumeAllAudio) {
					iframe.contentWindow.__beiluResumeAllAudio()
				}
			} catch (e) {
				// 跨域时 fallback 到 postMessage（Blob URL 模式）
				try {
					iframe.contentWindow?.postMessage({ type: 'beilu-user-interaction' }, '*')
				} catch (e2) { /* ignore */ }
			}
		})
	}
	document.addEventListener('click', notifyIframesUserInteraction, true)
	document.addEventListener('touchstart', notifyIframesUserInteraction, true)
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
 * 将 HTML 中 min-height 声明里的 vh 单位替换为 CSS 变量表达式
 * 避免 iframe 内 vh 指向 iframe 自身高度导致的循环依赖
 *
 * @param {string} content - HTML 文档字符串
 * @returns {string} 处理后的 HTML
 */
function replaceVhInContent(content) {
	const hasMinHeightVh = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/gi.test(content)
	if (!hasMinHeightVh) return content

	const convertVh = (value) =>
		value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num) => {
			const parsed = parseFloat(num)
			if (!isFinite(parsed)) return match
			const VARIABLE = 'var(--beilu-viewport-height)'
			if (parsed === 100) return VARIABLE
			return `calc(${VARIABLE} * ${parsed / 100})`
		})

	// CSS 声明块中的 min-height: ...vh
	content = content.replace(
		/(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
		(_, prefix, value) => `${prefix}${convertVh(value)}`
	)

	// 行内 style="min-height: ...vh"
	content = content.replace(
		/(style\s*=\s*(["']))([^"']*?)(\2)/gi,
		(match, prefix, _q, styleContent, suffix) => {
			if (!/min-height\s*:\s*[^;]*vh/i.test(styleContent)) return match
			const replaced = styleContent.replace(
				/(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi,
				(_, p1, p2) => `${p1}${convertVh(p2)}`
			)
			return `${prefix}${replaced}${suffix}`
		}
	)

	// JS: element.style.minHeight = "...vh"
	content = content.replace(
		/(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi,
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
 * 1. Monkey-patch Audio 构造函数，追踪所有 Audio 实例
 * 2. 用户首次交互后自动恢复被浏览器阻止的音频播放
 *
 * @returns {string} <script> 标签字符串
 */
function createEarlyScript() {
	return `<script>
(function() {
	// ★ 追踪所有通过 new Audio() 创建的实例
	var _OrigAudio = window.Audio;
	var _trackedAudios = [];
	window.__beiluTrackedAudios = _trackedAudios;

	window.Audio = function(src) {
		var inst = new _OrigAudio(src);
		_trackedAudios.push(inst);
		return inst;
	};
	// 保持 prototype 链兼容
	window.Audio.prototype = _OrigAudio.prototype;
	try {
		Object.defineProperty(window.Audio, 'name', { value: 'Audio' });
	} catch(e) {}

	// ★ 恢复所有被阻止的音频（可重复调用）
	function resumeAllAudio() {
		// 1. 尝试 resume AudioContext（解除全局音频限制）
		try {
			var ctx = new (window.AudioContext || window.webkitAudioContext)();
			if (ctx.state === 'suspended') {
				ctx.resume().then(function() { ctx.close(); });
			} else {
				ctx.close();
			}
		} catch(e) {}

		// 2. DOM 中的 <audio> 和 <video> 元素
		document.querySelectorAll('audio,video').forEach(function(el) {
			if (el.paused && el.src) {
				el.play().catch(function(){});
			}
		});

		// 3. JS new Audio() 创建的实例（不在 DOM 中）
		_trackedAudios.forEach(function(a) {
			if (a && a.paused && a.src) {
				a.play().catch(function(){});
			}
		});
	}

	// ★ 暴露为全局函数，让父页面可以直接同步调用（保持用户手势上下文）
	window.__beiluResumeAllAudio = resumeAllAudio;

	// 监听 iframe 内部的用户交互事件（不用 once，因为可能有新的 Audio 实例）
	['click', 'touchstart', 'keydown'].forEach(function(evt) {
		document.addEventListener(evt, resumeAllAudio, { capture: true });
	});

	// 也监听来自父页面的 postMessage 通知（跨域 fallback）
	window.addEventListener('message', function(e) {
		if (e.data && e.data.type === 'beilu-user-interaction') {
			resumeAllAudio();
		}
	});
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
 * 4. SillyTavern 兼容 API
 *
 * @param {string} messageId - 消息元素 ID
 * @returns {string} <script> 标签字符串
 */
function createBridgeScript(messageId) {
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
	// 4. 音频恢复已移至 createEarlyScript()
	//    在 <head> 最前面注入，确保在 Vue/Audio 之前就生效
	// ============================================================

	// ============================================================
	// 5. SillyTavern 兼容 API
	// ============================================================
	var stAPI = {
		chat: [],
		switchSwipe: function(index) {
			window.parent.postMessage({
				type: 'beilu-swipe-switch',
				id: '${messageId}',
				index: index
			}, '*');
		}
	};

	window.SillyTavern = stAPI;
	window.getCurrentMessageId = function() { return 0; };
	window.getChatMessages = function() { return stAPI.chat; };
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
 * @returns {HTMLIFrameElement|null} 创建的 iframe 元素
 */
export function renderAsIframe(htmlDocument, messageElement) {
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
	iframe.setAttribute('allow', 'autoplay')  // ★ 支持音频自动播放

	// 消息 ID
	const messageId = messageElement.id || `msg-${Date.now()}`

	// ★ 预处理 HTML：vh 单位替换
	let modifiedHtml = replaceVhInContent(htmlDocument)

	// ★ 注入 early script（Audio 追踪 + 音频恢复）到 <head> 最前面
	const earlyScript = createEarlyScript()
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
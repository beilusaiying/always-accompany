/**
 * iframe 沙箱渲染器
 *
 * 职责：
 * - 将完整 HTML 文档渲染在 iframe 中，绕过 markdown 渲染器
 * - 使用 Blob URL 加载（比 srcdoc 更可靠地处理大文档）
 * - 通过 ResizeObserver + postMessage 实现高度自适应
 * - 注入 beilu 通信桥脚本，支持 iframe↔父页面通信
 *
 * 设计背景：
 * - 酒馆美化代码（如贝露对话框代码）是完整的 HTML 文档（Vue 3 + GSAP + CDN 资源）
 * - 这类文档不能经过 markdown 渲染器（会被破坏），也不能直接 innerHTML（脚本不执行）
 * - iframe 是唯一能完整渲染独立 HTML 文档的方案
 *
 * sandbox 权限：allow-scripts allow-same-origin allow-popups
 * - allow-scripts：美化代码需要执行 Vue/GSAP 等脚本
 * - allow-same-origin：需要加载 CDN 资源（unpkg/cdnjs/catbox）
 * - allow-popups：部分美化代码有全屏/新窗口功能
 */

import { onElementRemoved } from '../../../../../scripts/onElementRemoved.mjs'

/**
 * 注入到 iframe 中的通信桥脚本
 * 功能：
 * 1. ResizeObserver 监听文档高度变化，通过 postMessage 通知父页面
 * 2. 提供 beilu API 的基础桥接（未来扩展用）
 *
 * @param {string} messageId - 消息元素的 ID，用于父页面识别来源
 * @returns {string} 完整的 <script> 标签
 */
function createBridgeScript(messageId) {
	return `<script>
(function() {
	// 高度自适应：监听文档尺寸变化，通知父页面调整 iframe 高度
	var lastHeight = 0;
	function reportHeight() {
		var h = Math.max(
			document.documentElement.scrollHeight,
			document.documentElement.offsetHeight,
			document.body ? document.body.scrollHeight : 0,
			document.body ? document.body.offsetHeight : 0
		);
		if (h !== lastHeight) {
			lastHeight = h;
			window.parent.postMessage({
				type: 'beilu-iframe-resize',
				id: '${messageId}',
				height: h
			}, '*');
		}
	}

	// 使用 ResizeObserver 精确监听
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(reportHeight).observe(document.documentElement);
	}

	// 兜底：MutationObserver + 定时检查（处理动态内容加载）
	if (typeof MutationObserver !== 'undefined') {
		new MutationObserver(reportHeight).observe(document.documentElement, {
			childList: true, subtree: true, attributes: true
		});
	}

	// 初始报告 + 延迟报告（等待 CDN 资源加载）
	reportHeight();
	window.addEventListener('load', function() {
		reportHeight();
		// CDN 资源可能晚于 load 事件，额外延迟检查
		setTimeout(reportHeight, 500);
		setTimeout(reportHeight, 1500);
		setTimeout(reportHeight, 3000);
	});

	// 图片加载完成后重新报告高度
	document.addEventListener('load', function(e) {
		if (e.target.tagName === 'IMG') reportHeight();
	}, true);
})();
</script>`
}

/**
 * 将完整 HTML 文档渲染为 iframe
 *
 * @param {string} htmlDocument - 完整的 HTML 文档字符串
 * @param {HTMLElement} messageElement - 消息 DOM 元素（需包含 .message-content）
 * @returns {HTMLIFrameElement} 创建的 iframe 元素
 */
export function renderAsIframe(htmlDocument, messageElement) {
	const contentEl = messageElement.querySelector('.message-content')
	if (!contentEl) {
		console.warn('[iframeRenderer] 未找到 .message-content 容器')
		return null
	}

	// 移除 markdown-body 类（避免 github-markdown-css 样式干扰 iframe 布局）
	contentEl.classList.remove('markdown-body')
	contentEl.classList.add('iframe-content')
	contentEl.innerHTML = ''

	// 创建 iframe
	const iframe = document.createElement('iframe')
	iframe.className = 'beilu-beauty-iframe'
	iframe.sandbox = 'allow-scripts allow-same-origin allow-popups'
	iframe.setAttribute('allowfullscreen', '')
	iframe.setAttribute('loading', 'lazy')

	// 在 </body> 前注入桥接脚本
	const messageId = messageElement.id || `msg-${Date.now()}`
	const bridgeScript = createBridgeScript(messageId)
	let modifiedHtml = htmlDocument

	if (modifiedHtml.includes('</body>')) {
		modifiedHtml = modifiedHtml.replace('</body>', bridgeScript + '</body>')
	} else if (modifiedHtml.includes('</html>')) {
		modifiedHtml = modifiedHtml.replace('</html>', bridgeScript + '</html>')
	} else {
		// 没有 body/html 闭合标签，追加到末尾
		modifiedHtml += bridgeScript
	}

	// 使用 Blob URL（比 srcdoc 更可靠地处理大文档 + 特殊字符）
	const blob = new Blob([modifiedHtml], { type: 'text/html;charset=utf-8' })
	const blobUrl = URL.createObjectURL(blob)
	iframe.src = blobUrl

	// 初始高度（避免闪烁），后续由 postMessage 动态调整
	iframe.style.height = '400px'

	contentEl.appendChild(iframe)

	// 监听 iframe 高度变化
	const handleMessage = (e) => {
		if (e.data?.type === 'beilu-iframe-resize' && e.data.id === messageId) {
			const newHeight = Math.max(100, e.data.height)
			iframe.style.height = newHeight + 'px'
		}
	}
	window.addEventListener('message', handleMessage)

	// 元素移除时清理资源
	onElementRemoved(messageElement, () => {
		window.removeEventListener('message', handleMessage)
		URL.revokeObjectURL(blobUrl)
	})

	console.log(`[iframeRenderer] 消息 ${messageId} 已渲染为 iframe（${modifiedHtml.length} 字符）`)
	return iframe
}
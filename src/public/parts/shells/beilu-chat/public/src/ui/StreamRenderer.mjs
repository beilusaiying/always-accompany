import { renderMarkdownAsString } from '../../../../../scripts/markdown.mjs'
import { applyStreamingThinkFold, detectContentType, isRendererEnabled } from '../displayRegex.mjs'
import { renderAsIframe } from './iframeRenderer.mjs'

/**
 * 读取流式渲染是否启用
 * @returns {boolean}
 */
function isStreamRenderEnabled() {
	try {
		return localStorage.getItem('beilu-stream-render-enabled') === 'true'
	} catch { return false }
}

/**
 * 用于实现流式渲染的类。
 *
 * 性能优化：
 * - 思维链折叠使用节流（MIN_RENDER_INTERVAL），避免每帧都执行正则+markdown
 * - 流式渲染模式：检测 full-html 内容时按间隔更新 iframe
 */
class StreamRenderer {
	/** @type {number} 最小渲染间隔（毫秒），用于节流 */
	static MIN_RENDER_INTERVAL = 80

	/**
	 * 创建一个新的 StreamRenderer 实例。
	 */
	constructor() {
		this.streamingMessages = new Map()
		this.animationFrameId = null
	}

	/**
	 * 注册一个正在进行流式传输的消息。
	 * @param {string} id - 消息的唯一 ID。
	 * @param {string} initialContent - 消息的初始内容。
	 */
	register(id, initialContent) {
		this.streamingMessages.set(id, {
			targetContent: initialContent || '',
			displayedContent: initialContent || '',
			lastRendered: null,
			lastRenderTime: 0,
			domElement: document.getElementById(id), // 缓存引用
			cache: {},
			streamIframe: null, // 流式渲染的 iframe 引用
			isFullHtml: false,  // 是否被检测为 full-html
		})
		this.startLoop()
	}

	/**
	 * 更新指定消息的目标内容，用于平滑渲染。
	 * @param {string} id - 消息的唯一 ID。
	 * @param {string} newContent - 消息的新内容。
	 */
	updateTarget(id, newContent) {
		const state = this.streamingMessages.get(id)
		if (state) state.targetContent = newContent
		this.startLoop()
	}

	/**
	 * 停止对指定消息的流式渲染。
	 * @param {string} id - 消息的唯一 ID。
	 */
	stop(id) {
		const state = this.streamingMessages.get(id)
		if (state?.streamIframe) {
			state.streamIframe = null // 清除引用，iframe 保留在 DOM 中
		}
		this.streamingMessages.delete(id)
	}

	/**
	 * 启动渲染循环
	 */
	startLoop() {
		if (this.animationFrameId || !this.streamingMessages.size) return
		/**
		 * 一个帧的渲染逻辑
		 */
		const loop = async () => {
			if (!this.streamingMessages.size) {
				this.animationFrameId = null
				return
			}
			await this.renderFrame()
			this.animationFrameId = requestAnimationFrame(loop)
		}
		this.animationFrameId = requestAnimationFrame(loop)
	}

	/**
	 * 渲染一帧
	 *
	 * 性能优化策略：
	 * 1. 平滑算法照旧（字符追赶，无需节流）
	 * 2. markdown 渲染 + 思维链折叠使用最小间隔节流
	 * 3. full-html 流式渲染使用更长间隔（500ms）更新 iframe
	 */
	async renderFrame() {
		const now = performance.now()

		for (const [id, state] of this.streamingMessages) {
			// 重新获取 DOM，防止虚拟列表滚动导致元素重建
			if (!state.domElement || !state.domElement.isConnected) {
				state.domElement = document.getElementById(id)
				if (!state.domElement) continue
			}

			// 平滑算法逻辑
			const { targetContent, displayedContent } = state
			if (targetContent.length > displayedContent.length) {
				const lag = targetContent.length - displayedContent.length
				const step = Math.max(1, Math.ceil(lag / 5))
				state.displayedContent = targetContent.substring(0, displayedContent.length + step)
			} else {
				state.displayedContent = targetContent
			}

			// 只有内容变化才操作 DOM
			if (state.displayedContent !== state.lastRendered) {
				// ★ 节流：距离上次渲染未达最小间隔则跳过（平滑算法下一帧会重试）
				if (now - state.lastRenderTime < StreamRenderer.MIN_RENDER_INTERVAL) {
					continue
				}

				// ★ 流式渲染：检测 full-html 内容
				if (isStreamRenderEnabled() && isRendererEnabled()) {
					const contentType = detectContentType(state.displayedContent)
					if (contentType === 'full-html' && !state.isFullHtml) {
						state.isFullHtml = true
					}

					// full-html 流式更新：用更长间隔（500ms）刷新 iframe
					if (state.isFullHtml) {
						if (now - state.lastRenderTime < 500) continue

						state.lastRenderTime = now
						state.lastRendered = state.displayedContent

						// 移除旧 iframe，创建新的
						if (state.streamIframe?.isConnected) {
							state.streamIframe.remove()
						}
						state.streamIframe = renderAsIframe(state.displayedContent, state.domElement)

						// 显示内容区域
						if (state.displayedContent.trim()) {
							const skeletonEl = state.domElement.querySelector('.skeleton-loader')
							if (skeletonEl) skeletonEl.classList.add('hidden')
							const contentEl = state.domElement.querySelector('.message-content')
							if (contentEl) contentEl.classList.remove('hidden')
						}
						continue
					}
				}

				const contentEl = state.domElement.querySelector('.message-content')
				if (contentEl) {
					// 流式阶段应用思维链折叠（处理已闭合和未闭合的 think 标签）
					const processed = applyStreamingThinkFold(state.displayedContent)
					contentEl.innerHTML = await renderMarkdownAsString(processed, state.cache)

					if (state.displayedContent.trim()) {
						const skeletonEl = state.domElement.querySelector('.skeleton-loader')
						if (skeletonEl) skeletonEl.classList.add('hidden')
						contentEl.classList.remove('hidden')
					}
				}

				state.lastRendered = state.displayedContent
				state.lastRenderTime = now
			}
		}
	}
}

/**
 * 流式渲染器的单例
 */
export const streamRenderer = new StreamRenderer()

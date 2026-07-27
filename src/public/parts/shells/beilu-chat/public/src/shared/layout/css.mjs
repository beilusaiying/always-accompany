/**
 * css.mjs — 布局相关 CSS 变量动态计算与注册
 *
 * 功能链：
 *   setupCss() → registerCssUpdater(callback)
 *   → 每次布局变化时 callback 触发 → 读取顶栏/输入区实际高度
 *   → setCssVariable("--chat-header-width", ...) + setCssVariable("--beilu-chat-area-height", ...)
 *
 * why：
 *   beilu-chat 使用 .top-bar 而非原版 .chat-header，需适配不同 DOM 结构；
 *   --beilu-chat-area-height 供 iframeRenderer 等使用，解决 iframe 内 vh 循环依赖问题；
 *   通过 registerCssUpdater 统一触发（而非各处独立监听 resize），保证变量一致性。
 *
 * 关联链：
 *   ← index.mjs / layout.mjs（setupCss() 调用入口）
 *   → scripts/cssValues.mjs（registerCssUpdater/setCssVariable：CSS 变量统一管理）
 *   → iframeRenderer.mjs（消费 --beilu-chat-area-height 解决 vh 问题）
 *
 * 影响范围：
 *   CSS 变量 --chat-header-width / --beilu-chat-area-height 影响全局布局计算；
 *   无 DOM 结构改动，无后端请求，无 localStorage。
 *
 * 使用效果：
 *   顶栏宽度/聊天区高度变量随窗口 resize 自动更新；
 *   iframe 内内容可正确使用 --beilu-chat-area-height 替代 vh 单位。
 */
import { registerCssUpdater, setCssVariable } from '../../../../../../scripts/cssValues.mjs'


/**
 * 设置CSS变量
 */
export function setupCss() {
	registerCssUpdater(() => {
		// beilu-chat 使用 .top-bar 而非原版 .chat-header
		const header = document.querySelector('.top-bar') || document.querySelector('.chat-header')
		if (header) {
			const headerWidth = header.offsetWidth
			setCssVariable('--chat-header-width', `${headerWidth}px`)
		}
		// beilu: 始终显示角色名和头像，不再根据参与人数隐藏

		// 计算聊天消息区域的实际可用高度（视口高度 - 顶部栏 - 输入区域）
		// 美化 iframe 用这个值作为 vh 的等效高度
		const topBar = document.querySelector('#top-bar')
		const chatInput = document.querySelector('.chat-input')
		const topBarH = topBar ? topBar.offsetHeight : 0
		const inputH = chatInput ? chatInput.offsetHeight : 0
		const chatAreaHeight = window.innerHeight - topBarH - inputH
		if (chatAreaHeight > 0) {
			setCssVariable('--beilu-chat-area-height', `${chatAreaHeight}px`)
		}
	})
}

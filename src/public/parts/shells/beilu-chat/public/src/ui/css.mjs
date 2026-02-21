import { registerCssUpdater, setCssVariable } from '../../../../../scripts/cssValues.mjs'


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

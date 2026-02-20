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
	})
}

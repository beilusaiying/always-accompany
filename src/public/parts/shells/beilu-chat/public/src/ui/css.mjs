import { registerCssUpdater, setCssVariable } from '../../../../../scripts/cssValues.mjs'

import { getQueue } from './virtualQueue.mjs'

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
		// 根据队列中的人数判断是否隐藏角色名
		const uniqueNames = new Set(getQueue().map(e => e.name))
		document.body.classList.toggle('hide-char-names', uniqueNames.size <= 2)
	})
}

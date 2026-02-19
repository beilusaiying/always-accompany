// beilu-always-accompany: 精简后的前端基础模块
// 移除了 Sentry / Service Worker / 自动更新 / 愚人节彩蛋

import { onServerEvent } from './scripts/server_events.mjs'
import { showToast } from './scripts/toast.mjs'

// polyfill
await import('https://cdn.jsdelivr.net/gh/steve02081504/js-polyfill/index.mjs').catch(console.error)

// Service Worker 已禁用 — 不再缓存旧版前端代码
// 如需重新启用，取消下方注释：
// if ('serviceWorker' in navigator)
// 	navigator.serviceWorker.register('/service_worker.mjs', { scope: '/', module: true })

// 注销已有的 Service Worker（清理残留缓存）
if ('serviceWorker' in navigator)
	navigator.serviceWorker.getRegistrations().then(regs => {
		for (const reg of regs) reg.unregister()
	})

// 键盘快捷键
document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		if (history.length > 1) history.back()
		else window.close()
	}
})

// Toast 通知
onServerEvent('show-toast', ({ type, message, duration }) => {
	showToast(type, message, duration)
})

// 自动更新已禁用 — 不再自动刷新页面
// onServerEvent('server-updated', ...)
// onServerEvent('page-modified', ...)

console.log('[beilu] 前端基础模块已加载（SW禁用/Sentry禁用/自动更新禁用）')

/**
 * 基础目录。
 * @type {string}
 */
export const base_dir = '/'

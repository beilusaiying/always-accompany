// desktopNotify.mjs — 单一桌面 OS 通知入口（app 级，与 toast.mjs/server_events.mjs 同层）。
// 消重复：原 websocket.mjs:_maybeNotifyBrowser 的 new Notification、chat.mjs 的 requestPermission、
//         以及已禁用 SW 里的 showNotification（event_dispatcher.sendNotification 的旧消费端）三处各一份，
//         统一收敛到这里。语义：窗口可见时不打扰（页内已有 toast/crossMode），仅失焦时升级为 OS 通知。

// 复用 websocket.mjs 原有的 localStorage 开关键，保持用户既有的"关闭浏览器通知"设置不丢。
const OPT_OUT_KEY = 'beilu-browser-notify'

/**
 * 桌面通知是否启用（用户可在设置里关闭）。
 * @returns {boolean}
 */
export function isDesktopNotifyEnabled() {
	return localStorage.getItem(OPT_OUT_KEY) !== 'false'
}

/**
 * 惰性申请通知权限（替代 chat.mjs 内联的 requestPermission）。仅在尚未决定时申请，不打扰已 deny 的用户。
 * @returns {void}
 */
export function ensureNotifyPermission() {
	if (!('Notification' in window)) return
	if (Notification.permission === 'default') try { Notification.requestPermission() } catch { /* 申请失败忽略 */ }
}

/**
 * 弹一条 OS 桌面通知。默认仅在窗口失焦时弹（页内可见时由 toast/crossMode 负责，不重复打扰）。
 * @param {string} title - 通知标题。
 * @param {string} [body] - 通知正文（截断至 120 字）。
 * @param {{icon?: string, tag?: string, targetUrl?: string, force?: boolean}} [opts]
 *        force=true 时无视窗口可见性强制弹（一般不用）；targetUrl 点击通知后跳转。
 * @returns {void}
 */
export function notifyDesktop(title, body = '', opts = {}) {
	if (!('Notification' in window)) return
	if (!isDesktopNotifyEnabled()) return
	if (!opts.force && document.visibilityState === 'visible') return
	if (Notification.permission === 'granted') try {
		const n = new Notification(title, {
			body: String(body).slice(0, 120),
			icon: opts.icon || '/favicon.ico',
			tag: opts.tag || 'beilu',
		})
		if (opts.targetUrl) n.onclick = () => {
			try { window.focus(); location.href = opts.targetUrl } catch { /* 跳转失败忽略 */ }
		}
	} catch { /* 通知构造失败忽略 */ }
	else if (Notification.permission !== 'denied') try { Notification.requestPermission() } catch { /* 申请失败忽略 */ }
}

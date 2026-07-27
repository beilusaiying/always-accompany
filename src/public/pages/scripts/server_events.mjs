const handlers = new Map()

/**
 * 注册一个服务器事件回调。
 * @param {string} type - 事件类型。
 * @param {(data: any) => void} callback - 回调函数。
 * @returns {void}
 */
export function onServerEvent(type, callback) {
	if (!handlers.has(type))
		handlers.set(type, [])

	handlers.get(type).push(callback)
}

/**
 * 注销一个服务器事件回调。
 * @param {string} type - 事件类型。
 * @param {(data: any) => void} callback - 回调函数。
 * @returns {void}
 */
export function offServerEvent(type, callback) {
	if (handlers.has(type)) {
		const typeHandlers = handlers.get(type)
		const index = typeHandlers.indexOf(callback)
		if (index > -1)
			typeHandlers.splice(index, 1)
	}
}

/**
 * 由 base.mjs 在收到来自 SW 的消息时调用。
 * @param {{type: string, data: any}} message - 消息。
 * @returns {void}
 */
function dispatchMessage(message) {
	const { type, data } = message
	if (handlers.has(type))
		for (const handler of handlers.get(type)) try {
			handler(data)
		} catch (e) {
			console.error(`Error in message handler for type "${type}":`, e)
		}
}

if ('serviceWorker' in navigator)
	navigator.serviceWorker.addEventListener('message', event => {
		if (event.data)
			dispatchMessage(event.data)
	})

// 用户级事件传输（通道B）——框架级修复。
// 历史：由 Service Worker 持有 /ws/notify 连接并 postMessage 回页面。SW 文件(pages/service_worker.mjs)
// 仍在，但已在 base.mjs:94-105 取消注册并 unregister → 运行时不跑 → 不连 /ws/notify，
// 导致 onServerEvent 全链静默失效：show-toast / locale-updated / part-installed(角色卡刷新) /
// 跨客户端聊天列表同步 等全部收不到。
// 修复：页面直接连同一服务端路由 /ws/notify（server/web_server/endpoints.mjs:122 → registerNotifier
// → userConnections，sendEventToUser 的投递目标），把消息喂回 dispatchMessage。单点复活整条通道，
// 且不重新引入 SW 缓存（缓存是 SW 的 Cache Storage 行为，与本事件传输正交）。
// ★ SW 守卫：若哪天 SW 被重新启用并控制页面，则由 SW 走 postMessage→dispatchMessage，
//   本页面直连跳过，避免两路都喂 dispatchMessage 造成 onServerEvent 双触发。
if (
	typeof WebSocket !== 'undefined' &&
	typeof location !== 'undefined' &&
	/^https?:$/.test(location.protocol) &&
	!(navigator.serviceWorker && navigator.serviceWorker.controller)
) {
	let _notifyWs = null
	// 重连指数退避：未登录页(登录页/会话过期)每次连接都被 401→426 拒绝，固定 3s 重连会让服务端
	// 控制台被"接受到请求+连接被拒"两行/次无限刷屏(2026-07-19 VM 实测)。3s 起步×2 封顶 60s；
	// 连接真正建立(onopen)即重置回 3s——已登录用户断线仍快速恢复。登录成功走页面跳转=新页面
	// 新起 3s 链，无需感知登录事件。
	let _notifyDelay = 3000
	const _NOTIFY_DELAY_MAX = 60000
	const _scheduleReconnect = () => {
		setTimeout(_connectNotify, _notifyDelay)
		_notifyDelay = Math.min(_notifyDelay * 2, _NOTIFY_DELAY_MAX)
	}
	const _connectNotify = () => {
		try {
			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
			_notifyWs = new WebSocket(`${proto}//${location.host}/ws/notify`)
			_notifyWs.onopen = () => { _notifyDelay = 3000 }
			// 服务端 sendMessageToConnections 发的是 JSON.stringify({ type, data })
			_notifyWs.onmessage = ev => {
				try { dispatchMessage(JSON.parse(ev.data)) } catch { /* 非 JSON / 无 type：忽略 */ }
			}
			_notifyWs.onclose = () => { _notifyWs = null; _scheduleReconnect() }
			_notifyWs.onerror = () => { try { _notifyWs?.close() } catch { /* 已关 */ } }
		} catch { _scheduleReconnect() }
	}
	_connectNotify()
}

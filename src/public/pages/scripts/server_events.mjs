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
// 当前 service_worker.mjs 是注销墓碑，不承载 /ws/notify。不能仅因旧 SW controller 尚在
// 就跳过页面连接，否则会出现两边都没有通知通道；未来若恢复 SW，应由它显式声明通知能力，
// 再建立互斥所有权，而不是用 controller 存在与否猜测。
if (
	typeof WebSocket !== 'undefined' &&
	typeof location !== 'undefined' &&
	/^https?:$/.test(location.protocol)
) {
	let _notifyWs = null
	let _notifyReconnectTimer = null
	let _notifyConnecting = false
	let _notifyStoppedForAuth = false
	// 认证不是网络断线：未登录页面或已失效会话不能建立受保护的 /ws/notify。WS upgrade
	// 不能接收 Set-Cookie，因此每次连接前都由普通 HTTP 做会话确认/续签；401/403 是终止态，
	// 不进入指数重连。登录页成功后会整页跳转，新的已认证页面再启动该模块。
	let _notifyDelay = 3000
	const _NOTIFY_DELAY_MAX = 60000
	const _clearNotifyReconnect = () => {
		if (_notifyReconnectTimer !== null) {
			clearTimeout(_notifyReconnectTimer)
			_notifyReconnectTimer = null
		}
	}
	const _stopNotifyForAuth = () => {
		_notifyStoppedForAuth = true
		_clearNotifyReconnect()
		const ws = _notifyWs
		_notifyWs = null
		try { ws?.close() } catch { /* 已关闭 */ }
	}
	const _scheduleReconnect = () => {
		if (_notifyStoppedForAuth || _notifyReconnectTimer !== null) return
		_notifyReconnectTimer = setTimeout(() => {
			_notifyReconnectTimer = null
			_connectNotify()
		}, _notifyDelay)
		_notifyDelay = Math.min(_notifyDelay * 2, _NOTIFY_DELAY_MAX)
	}
	const _checkNotifySession = async () => {
		const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
		const timeout = controller ? setTimeout(() => controller.abort(), 10000) : null
		try {
			const response = await fetch('/api/authenticate', {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				signal: controller?.signal,
			})
			if (response.ok) return 'authenticated'
			if (response.status === 401 || response.status === 403) return 'unauthenticated'
			return 'unavailable'
		} catch {
			return 'unavailable'
		} finally {
			if (timeout !== null) clearTimeout(timeout)
		}
	}
	const _connectNotify = async () => {
		if (_notifyStoppedForAuth || _notifyConnecting || _notifyWs) return
		_notifyConnecting = true
		try {
			const sessionState = await _checkNotifySession()
			if (_notifyStoppedForAuth) return
			if (sessionState === 'unauthenticated') {
				_stopNotifyForAuth()
				return
			}
			if (sessionState !== 'authenticated') {
				_scheduleReconnect()
				return
			}
			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
			const ws = new WebSocket(`${proto}//${location.host}/ws/notify`)
			_notifyWs = ws
			ws.onopen = () => { _notifyDelay = 3000 }
			// 服务端 sendMessageToConnections 发的是 JSON.stringify({ type, data })
			ws.onmessage = ev => {
				try { dispatchMessage(JSON.parse(ev.data)) } catch { /* 非 JSON / 无 type：忽略 */ }
			}
			ws.onclose = () => {
				if (_notifyWs !== ws) return
				_notifyWs = null
				_scheduleReconnect()
			}
			ws.onerror = () => {
				try { ws.close() } catch {
					if (_notifyWs === ws) {
						_notifyWs = null
						_scheduleReconnect()
					}
				}
			}
		} catch {
			_scheduleReconnect()
		} finally {
			_notifyConnecting = false
		}
	}
	_connectNotify()
}

import express from 'npm:express'
import { WebSocketServer } from 'npm:ws'

/**
 * 使用 WebSocket 功能增强 Express 路由器。
 * @param {import('npm:express').Router} [router=express.Router()] - 要增强的 Express 路由器。
 * @param {import('http').Server} [httpServer=null] - 要绑定的 HTTP 服务器。
 * @returns {import('npm:express').Router} 增强后的路由器。
 */
export function WsAbleRouter(router = express.Router(), httpServer = null) {
	/**
	 * 处理 WebSocket 升级请求。
	 * @param {import('http').IncomingMessage} req - HTTP 请求对象。
	 * @param {import('net').Socket} socket - 客户端和服务器之间的网络套接字。
	 * @param {Buffer} head - 已升级流的第一个数据包。
	 */
	router.ws_on_upgrade = async (req, socket, head) => {
		const _wsOrigin = req.headers['origin'] || '';
		const _wsHost = req.headers['host'] || '';
		if (_wsOrigin && _wsOrigin !== 'null') {
			try {
				const _originHost = new URL(_wsOrigin).host;
				if (_originHost !== _wsHost && !_originHost.startsWith('localhost') && !_originHost.startsWith('127.0.0.1')) {
					socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
					socket.destroy();
					return;
				}
			} catch {
					// 畸形 Origin 无法解析 → 合法浏览器/Electron 客户端只会发送规范 Origin（或无/null，上面已放行），
					// 不可解析的 Origin 仅来自构造请求 → fail-closed 拒绝，防 CSWSH 绕过。
					socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
					socket.destroy();
					return;
				}
		}
		let resolve, reject
		Object.assign(req, {
			ws: {
				socket,
				head,
				/**
				 * 拒绝 WebSocket 连接。
				 * @returns {void}
				 */
				fail: () => {
					if (!socket.destroyed) {
						socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n')
						socket.destroy()
					}
					// 例行拒绝（鉴权等中间件主动挡下,已答 426）≠ 异常：打标记让 catch 降为一行诊断。
					// 未登录页面每 3s 重连 /ws/notify,每次全堆栈会把正常流程刷成事故现场,
					// 且鉴权层已有 [wb:auth:authenticate:401] 一行诊断,堆栈是重复噪音。
					const rejection = new Error('WebSocket connection rejected')
					rejection.wsRoutineReject = true
					reject(rejection)
				},
				/**
				 * 标记 WebSocket 连接已成功建立。
				 * @returns {void}
				 */
				done: () => resolve(),
			},
			/**
			 * 模拟 Express 的 `accepts` 方法。
			 * @param {any} _ - 未使用的参数。
			 * @returns {number} 总是返回 0。
			 */
			accepts: _ => 0,
			ip: req.socket.remoteAddress,
		})

		const res = {
			/**
			 * 模拟 Express 的 `setHeader` 方法。
			 * @returns {void}
			 */
			setHeader: () => { },
			/**
			 * 模拟 Express 的 `getHeader` 方法。
			 * @returns {undefined}
			 */
			getHeader: () => undefined,
			/**
			 * 模拟 Express 的 `removeHeader` 方法。
			 * @returns {void}
			 */
			removeHeader: () => { },
			/**
			 * 模拟 Express 的 `end` 方法，用于拒绝连接。
			 * @returns {void}
			 */
			end: () => req.ws.fail(),
		}

		try {
			await new Promise((my_resolve, my_reject) => {
				resolve = my_resolve; reject = my_reject
				return (async () => await router(req, res))().catch(reject)
			})
		}
		catch (e) {
			// 例行拒绝一行可见诊断(不吞);真异常保留完整错误与堆栈。
			if (e?.wsRoutineReject) console.error(`WebSocket 连接被拒(已答426): ${req.method} ${req.url}`)
			else console.error('WebSocket upgrade error:', e)
			if (!socket.destroyed) socket.destroy()
		}
	}
	/**
	 * 为给定的路径注册一个 WebSocket 处理器。
	 * @param {string} path - 路由路径。
	 * @param {...any} handlers - 中间件和 WebSocket 连接处理器。
	 * @returns {import('npm:express').Router} 增强后的路由器。
	 */
	router.ws = (path, ...handlers) => {
		const wss = new WebSocketServer({
			noServer: true,
			perMessageDeflate: true,
			/**
			 * 处理 WebSocket 协议。
			 * @param {Set<string>} protocols - 客户端支持的协议集。
			 * @returns {string|boolean} 选择的协议或 false。
			 */
			handleProtocols: (protocols) => {
				if (protocols.size) return protocols.values().next().value
				return false
			}
		})
		const handler = handlers.pop()
		wss.on('connection', handler)
		wss.on('wsClientError', (error, socket, req) => {
			console.error('WebSocket client error:', error)
			req.ws?.fail?.()
		})
		router.get(path, ...handlers, (req, res) => {
			if (!req.ws) return res.status(400).json({ message: 'This is a WebSocket-only endpoint.' })
			const { socket, head } = req.ws
			wss.handleUpgrade(req, socket, head, ws => {
				wss.emit('connection', ws, req)
				req.ws?.done?.()
			})
		})
		return router
	}
	/**
	 * 将 WebSocket 升级处理器绑定到一个 HTTP 服务器。
	 * @param {import('http').Server} server - 要绑定的 HTTP 服务器。
	 * @returns {import('npm:express').Router} 增强后的路由器。
	 */
	router.ws_bindServer = server => {
		server.on('upgrade', router.ws_on_upgrade)
		return router
	}
	if (httpServer) router.ws_bindServer(httpServer)
	return router
}
/**
 * 使用 WebSocket 功能增强 Express 应用程序。
 * @param {import('npm:express').Application} [app=express()] - 要增强的 Express 应用程序。
 * @param {import('http').Server} [httpServer=null] - 要绑定的 HTTP 服务器。
 * @returns {import('npm:express').Application} 增强后的应用程序。
 */
export function WsAbleApp(app = express(), httpServer = null) {
	return WsAbleRouter(app, httpServer)
}

import { console } from '../../scripts/i18n_core.mjs' // [0722 解环] console 叶子
import { currentGitCommit } from '../autoupdate.mjs'
import { events } from '../events.mjs'
import { wbTrace, wbDetect } from '../whitebox.mjs'

/**
 * 存储每个用户的活动 WebSocket 连接。
 * @type {Map<string, Set<import('npm:ws')>>}
 */
const userConnections = new Map()

/**
 * 为用户注册一个 WebSocket 连接。
 * @param {string} username - 用户名。
 * @param {import('npm:ws')} ws - WebSocket 实例。
 * @returns {void}
 */
export function register(username, ws) {
	if (!userConnections.has(username)) userConnections.set(username, new Set())

	const connections = userConnections.get(username)
	connections.add(ws)

	// 连接时发送当前的 commit ID
	if (ws.readyState === ws.OPEN)
		ws.send(JSON.stringify({ type: 'server-reconnected', data: { commitId: currentGitCommit } }))

	ws.on('close', () => {
		unregister(username, ws)
	})
}

/**
 * 为用户注销一个 WebSocket 连接。
 * @param {string} username - 用户名。
 * @param {import('npm:ws')} ws - WebSocket 实例。
 * @returns {void}
 */
export function unregister(username, ws) {
	const connections = userConnections.get(username)
	if (connections?.delete(ws)) {
		if (!connections.size) userConnections.delete(username)
		return
	}
	// 改名迁移后 register 时 close 闭包捕的是旧用户名，按旧名查不到——全表兜底扫，
	// 防迁移后的连接在断开时残留在新名集合里（泄漏 + 死连接堆积）。
	for (const [name, set] of userConnections)
		if (set.delete(ws)) {
			if (!set.size) userConnections.delete(name)
			return
		}
}

/**
 * 向一组 WebSocket 连接发送结构化消息。
 * @param {Set<import('npm:ws')>} connections - WebSocket 连接的集合。
 * @param {string} type - 消息类型。
 * @param {any} data - 消息数据。
 * @returns {boolean} 如果消息已发送则为 true，否则为 false。
 */
function sendMessageToConnections(connections, type, data) {
	if (connections?.size) {
		const payload = JSON.stringify({ type, data })
		wbTrace(null, "dispatch", "send", { type, conns: connections.size })
		for (const ws of connections)
			if (ws.readyState === ws.OPEN) try {
				ws.send(payload)
			} catch (e) { wbDetect(null, "dispatch", "send", false, e?.message || String(e)); console.error(e) }
		return true
	}
	return false
}

/**
 * 向特定用户的所有连接客户端发送消息。
 * @param {string} username - 要发送到的用户名。
 * @param {string} type - 消息类型。
 * @param {any} data - 消息数据。
 * @returns {boolean} 如果消息已发送则为 true，否则为 false。
 */
export function sendEventToUser(username, type, data) {
	const connections = userConnections.get(username)
	events.emit('send-event-to-user', { username, type, data })
	return sendMessageToConnections(connections, type, data)
}

/**
 * 向所有用户的全部连接客户端广播消息。
 * @param {string} type - 消息类型。
 * @param {any} data - 消息数据。
 * @returns {void}
 */
export function sendEventToAll(type, data) {
	for (const connections of userConnections.values())
		sendMessageToConnections(connections, type, data)
}

/**
 * 向特定用户的所有连接客户端发送通知。
 * @param {string} username - 要通知的用户名。
 * @param {string} title - 通知标题。
 * @param {NotificationOptions} options - 通知选项。
 * @param {string | null} targetUrl - 点击通知时打开的 URL。
 * @returns {boolean} 如果通知已发送则为 true，否则为 false。
 */
export function sendNotification(username, title, options, targetUrl = null) {
	return sendEventToUser(username, 'notification', { title, options, targetUrl })
}

// 改名传导链（20260706）：连接表 key 随用户名迁移，否则改名后 sendEventToUser(新名) 查不到在场连接
//   → chat-list-changed/notification 等推送静默丢失直至重连。发起浏览器的 cookie 已由改名端点重签
//   （endpoints.mjs rename → reissueSessionTokens），连接迁过来即恢复完整推送链。
events.on('AfterUserRenamed', ({ oldUsername, newUsername }) => {
	const conns = userConnections.get(oldUsername)
	userConnections.delete(oldUsername)
	if (!conns?.size) return
	const target = userConnections.get(newUsername)
	if (target) for (const ws of conns) target.add(ws)
	else userConnections.set(newUsername, conns)
})

events.on('AfterUserDeleted', ({ username }) => {
	const connections = userConnections.get(username)
	if (!connections?.size) return
	const payload = JSON.stringify({ type: 'account_deleted' })
	for (const ws of connections) {
		try {
			if (ws.readyState === ws.OPEN) ws.send(payload)
			ws.close(1000, 'account deleted')
		} catch {}
	}
	userConnections.delete(username)
})

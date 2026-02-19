/**
 * beilu-eye 共享注入状态
 *
 * 这个模块是 beilu-eye 插件和 beilu-chat 端点之间的桥梁。
 * ES 模块在同一进程中是单例的，所以两边 import 同一个模块实例。
 *
 * 流程：
 * 1. Electron 客户端 POST → beilu-chat 端点 → setPendingInjection()
 * 2. 用户发送消息 → Fount 调用 GetPrompt → consumePendingInjection()
 * 3. AI 回复后，注入数据已清除，后续对话不再包含截图
 */

/** @type {{ image: string, message: string, timestamp: number } | null} */
let _pendingInjection = null

/**
 * 设置待注入的截图数据
 * @param {{ image: string, message: string }} data
 */
export function setPendingInjection(data) {
	_pendingInjection = {
		image: data.image,
		message: data.message || '',
		timestamp: Date.now(),
	}
	console.log('[beilu-eye] 收到截图注入，大小:', Math.round((data.image?.length || 0) / 1024), 'KB')
}

/**
 * 消费（取出并清除）待注入数据
 * 调用后 pendingInjection 变为 null，实现一次性注入
 * @returns {{ image: string, message: string, timestamp: number } | null}
 */
export function consumePendingInjection() {
	const data = _pendingInjection
	_pendingInjection = null
	return data
}

/**
 * 检查是否有待注入数据（不消费）
 * @returns {boolean}
 */
export function hasPendingInjection() {
	return _pendingInjection !== null
}
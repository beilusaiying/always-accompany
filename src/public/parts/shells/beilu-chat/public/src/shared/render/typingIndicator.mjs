/**
 * [typingIndicator.mjs] — 「角色正在输入」指示器。只管 #typing-indicator 的显隐与内容更新，
 *   不管 WS 连接，不管消息渲染，不管输入框状态。
 *
 * 职责：
 *   1. handleTypingStatus(list)：接收当前正在输入的角色名 ID 列表，更新 typingChars Set
 *   2. updateTypingIndicator()：根据 typingChars 决定显示/隐藏 #typing-indicator
 *      — 0 人输入：隐藏（.hidden class）
 *      — 1-4 人：展示「角色名 正在输入...」（异步查 getPartDetails 获取显示名）
 *      — 5+ 人：展示「多名成员正在输入」（不查接口）
 *
 * 链路：websocket.mjs handleBroadcastEvent(typing_status) → handleTypingStatus(list)
 *       → updateTypingIndicator() → 写 #typing-indicator.innerHTML
 * 影响：写 #typing-indicator DOM（innerHTML / classList）；异步查 getPartDetails（仅读角色信息）
 * 相交：← virtualQueue.mjs（在 handleStreamUpdate 等处调用 handleTypingStatus）
 *       ← websocket.mjs（typing_status 事件分发到此）
 *       → parts.mjs（getPartDetails: 查角色显示名）→ utils.mjs（escapeHtml: 防 XSS）
 *
 * 点击后发生什么：
 *   无用户点击交互；由 WS 推送的 typing_status 事件驱动
 *   后端推 typing_status: ['char1', 'char2'] → handleTypingStatus → #typing-indicator 出现"Char1、Char2 正在输入..."
 *   后端推 typing_status: [] → handleTypingStatus → #typing-indicator 隐藏
 */
import { getPartDetails } from '../../../../../../scripts/parts.mjs'
import { escapeHtml } from '../state/utils.mjs'

let typingIndicatorElement = null
let typingChars = new Set()

/**
 * 更新正在输入的指示器
 */
async function updateTypingIndicator() {
	if (!typingIndicatorElement) typingIndicatorElement = document.getElementById('typing-indicator')
	if (!typingIndicatorElement) return

	if (!typingChars.size) {
		typingIndicatorElement.classList.add('hidden')
		typingIndicatorElement.innerHTML = ''
		return
	}

	typingIndicatorElement.classList.remove('hidden')

	let names = '', i18nKey = ''
	if (typingChars.size > 4) {
		i18nKey = 'chat.typingIndicator.multipleMembers'
		names = ''
	}
	else {
		i18nKey = 'chat.typingIndicator.isTyping'
		const charNames = await Promise.all(
			Array.from(typingChars).map(async (charname) => {
				try {
					const details = await getPartDetails(`chars/${charname}`)
					return details.info.name
				} catch (e) {
					return charname // fallback to id
				}
			})
		)
		names = charNames.join('、')
	}

	typingIndicatorElement.innerHTML = `\
<span class="loading loading-dots loading-xs"></span>
<span data-i18n="${i18nKey}" data-names="${escapeHtml(names)}"></span>
`
}

/**
 * 处理输入状态列表更新
 * @param {string[]} list - 正在输入的角色列表
 */
export function handleTypingStatus(list) {
	typingChars = new Set(list)
	updateTypingIndicator()
}

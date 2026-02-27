/**
 * 创建新聊天的页面逻辑。
 * 先检查该角色是否已有聊天记录，如果有则直接跳转到最近的聊天；
 * 否则创建新聊天会话，添加角色后重定向到 beilu-chat 主页面。
 */
import { console, initTranslations } from '../../../scripts/i18n.mjs'
import { applyTheme } from '../../../scripts/theme.mjs'
import { showToast } from '../../../scripts/toast.mjs'
import { addCharacter, createNewChat, currentChatId } from '../src/endpoints.mjs'

/**
 * 查询该角色是否已有聊天记录。
 * @param {string} charName - 角色名称
 * @returns {Promise<string|null>} - 已有聊天的 chatid，没有则返回 null
 */
async function findExistingChat(charName) {
	try {
		const response = await fetch('/api/parts/shells:chat/getchatlist')
		if (!response.ok) return null
		const chatList = await response.json()
		// chatList 是按时间倒序排列的摘要数组，找到第一个包含该角色的聊天
		const existing = chatList.find(chat =>
			Array.isArray(chat.chars) && chat.chars.includes(charName)
		)
		return existing?.chatid || null
	} catch (e) {
		console.warn('[new] 查询已有聊天失败:', e.message)
		return null
	}
}

/**
 * 初始化页面，检查已有聊天或创建新聊天会话，然后重定向到 beilu-chat 主页面。
 * @returns {Promise<void>}
 */
async function main() {
	await initTranslations('chat.new')
	applyTheme()

	const searchParams = new URLSearchParams(window.location.search)
	const charToAdd = searchParams.get('char')

	try {
		// 如果指定了角色，先检查是否已有该角色的聊天
		if (charToAdd) {
			const existingChatId = await findExistingChat(charToAdd)
			if (existingChatId) {
				// 已有聊天，直接跳转，不创建新聊天
				console.log(`[new] 角色 "${charToAdd}" 已有聊天 ${existingChatId}，直接跳转`)
				window.history.replaceState(null, null, '/parts/shells:beilu-chat/#' + existingChatId)
				window.location = '/parts/shells:beilu-chat/#' + existingChatId
				window.location.reload()
				return
			}
		}

		// 没有已有聊天，创建新的
		await createNewChat()
		if (charToAdd) await addCharacter(charToAdd)
	}
	catch (e) {
		console.error(e)
		showToast('error', e.stack || e.message || e)
		throw e
	}

	window.history.replaceState(null, null, '/parts/shells:beilu-chat/#' + currentChatId)
	window.location = '/parts/shells:beilu-chat/#' + currentChatId
	window.location.reload()
}
main()
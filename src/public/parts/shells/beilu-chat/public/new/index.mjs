/**
 * 创建新聊天的页面逻辑。
 * 调用 Fount chat API 创建聊天会话，添加角色后重定向到 beilu-chat 主页面。
 */
import { console, initTranslations } from '../../../scripts/i18n.mjs'
import { applyTheme } from '../../../scripts/theme.mjs'
import { showToast } from '../../../scripts/toast.mjs'
import { addCharacter, createNewChat, currentChatId } from '../src/endpoints.mjs'

/**
 * 初始化页面，创建新聊天会话，根据 URL 参数添加角色，然后重定向到 beilu-chat 主页面。
 * @returns {Promise<void>}
 */
async function main() {
	await initTranslations('chat.new')
	applyTheme()

	try {
		await createNewChat()
		const searchParams = new URLSearchParams(window.location.search)
		const charToAdd = searchParams.get('char')
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
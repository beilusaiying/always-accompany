import { showToastI18n } from '../../../../../scripts/toast.mjs'

import { loadDisplayRules } from './displayRegex.mjs'
import { addCharacter, addPlugin, getInitialData, setPersona, setWorld } from './endpoints.mjs'
import { setupCss } from './ui/css.mjs'
import { initializeMessageInput } from './ui/messageInput.mjs'
import { setupSidebar, updateSidebar } from './ui/sidebar.mjs'
import { initializeVirtualQueue } from './ui/virtualQueue.mjs'
import { initializeWebSocket, sendWebsocketMessage } from './websocket.mjs'

// beilu 专用插件列表 — 创建/加载聊天时自动注册
const BEILU_AUTO_PLUGINS = ['beilu-preset', 'beilu-toggle', 'beilu-logger', 'beilu-files', 'beilu-regex', 'beilu-worldbook']

// These are shared state used by the sidebar.
// They will be updated by events from the websocket.

/**
 * 聊天角色列表。
 * @type {Array<string>}
 */
export let charList = []
/**
 * @type {Array<string>}
 */
export let pluginList = []
/**
 * 当前世界名称。
 * @type {string|null}
 */
export let worldName = null
/**
 * 当前角色名称。
 * @type {string|null}
 */
export let personaName = null

/**
 * 设置聊天角色列表。
 * @param {Array<string>} list - 角色列表。
 */
export function setCharList(list) {
	charList = list
}

/**
 * 设置插件列表。
 * @param {Array<string>} list - 插件列表。
 */
export function setPluginList(list) {
	pluginList = list
}
/**
 * 设置当前世界名称。
 * @param {string} name - 世界名称。
 */
export function setWorldName(name) {
	worldName = name
}
/**
 * 设置当前角色名称。
 * @param {string} name - 角色名称。
 */
export function setPersonaName(name) {
	personaName = name
}

/**
 * 自动注册 beilu 专用插件。
 * 检查当前聊天的 pluginlist，若缺少必要插件则自动添加。
 * @param {Array<string>} currentPlugins - 当前已注册的插件列表
 */
async function autoRegisterBeiluPlugins(currentPlugins) {
	for (const pluginName of BEILU_AUTO_PLUGINS) {
		if (!currentPlugins.includes(pluginName)) {
			try {
				await addPlugin(pluginName)
				console.log(`[beilu-chat] 自动注册插件: ${pluginName}`)
			} catch (err) {
				console.warn(`[beilu-chat] 自动注册插件 ${pluginName} 失败:`, err.message)
			}
		}
	}
}

/**
 * 初始化聊天。
 * 每个步骤独立 try/catch，避免单个失败拖垮整个初始化（尤其是发送按钮绑定）。
 * @returns {Promise<void>}
 */
export async function initializeChat() {
	try { setupCss() } catch (e) {
		console.warn('[beilu-chat] setupCss 失败（非致命）:', e.message)
	}

	try { initializeWebSocket() } catch (e) {
		console.warn('[beilu-chat] initializeWebSocket 失败:', e.message)
	}

	let refreshedData = null
	try {
		const initialData = await getInitialData()

		// ⭐ beilu 特有: 自动注册 beilu 插件
		await autoRegisterBeiluPlugins(initialData.pluginlist || [])
		// 重新获取 pluginlist（因为可能新增了插件）
		refreshedData = await getInitialData()
	} catch (e) {
		console.warn('[beilu-chat] getInitialData / autoRegister 失败:', e.message)
	}

	// ⭐ beilu 特有: 预加载 display regex 规则（在插件注册之后，确保 beilu-regex 可用）
	loadDisplayRules().catch(err => console.warn('[beilu-chat] display regex 加载失败:', err))

	if (refreshedData) {
		try { initializeVirtualQueue(refreshedData) } catch (e) {
			console.warn('[beilu-chat] initializeVirtualQueue 失败（非致命）:', e.message)
		}

		try {
			updateSidebar({
				charlist: refreshedData.charlist,
				pluginlist: refreshedData.pluginlist,
				worldname: refreshedData.worldname,
				personaname: refreshedData.personaname,
				frequency_data: refreshedData.frequency_data,
			})
		} catch (e) {
			console.warn('[beilu-chat] updateSidebar 失败（非致命）:', e.message)
		}
	}

	if (window.Notification && Notification?.permission != 'granted')
		Notification.requestPermission()

	try { setupSidebar() } catch (e) {
		console.warn('[beilu-chat] setupSidebar 失败（非致命）:', e.message)
	}

	// ⚠️ 关键：发送按钮绑定 — 必须执行
	try { initializeMessageInput() } catch (e) {
		console.error('[beilu-chat] initializeMessageInput 失败（严重）:', e.message)
	}

	// Add global drag-and-drop support for x-fount-part
	document.body.addEventListener('dragover', event => {
		event.preventDefault() // Allow drop
	})

	document.body.addEventListener('drop', async event => {
		event.preventDefault()
		const partData = event?.dataTransfer?.getData?.('x-fount-part')
		if (!partData) return
		const [partType, partName] = partData.split('/')
		if (!partType || !partName) return showToastI18n('error', 'chat.dragAndDrop.invalidPartData')

		try {
			switch (partType) {
				case 'chars':
					await addCharacter(partName)
					showToastI18n('success', 'chat.dragAndDrop.charAdded', { partName })
					break
				case 'personas':
					await setPersona(partName)
					showToastI18n('success', 'chat.dragAndDrop.personaSet', { partName })
					break
				case 'worlds':
					await setWorld(partName)
					showToastI18n('success', 'chat.dragAndDrop.worldSet', { partName })
					break
				case 'plugins':
					await addPlugin(partName)
					showToastI18n('success', 'chat.dragAndDrop.pluginAdded', { partName })
					break
				default:
					showToastI18n('warning', 'chat.dragAndDrop.unsupportedPartType', { partType })
					return
			}
		} catch (error) {
			console.error(`Error handling dropped part (${partType}/${partName}):`, error)
			showToastI18n('error', 'chat.dragAndDrop.errorAddingPart', { partName, error: error.message })
		}
	})
}

/**
 * 停止生成。
 * @param {string} id - 消息 ID。
 */
export function stopGeneration(id) {
	console.log('Stop generation for', id)
	sendWebsocketMessage({
		type: 'stop_generation',
		payload: { messageId: id },
	})
	// UI change is now optimistic, backend will confirm by replacing the message or just stopping the stream.
	const element = document.getElementById(id)
	if (element) {
		const stopButton = element.querySelector('.stop-generating-button')
		if (stopButton) stopButton.remove()
	}
}

/**
 * sidebar.mjs — 左/右侧栏内容渲染与选择列表管理
 *
 * 功能链：
 *   页面加载 / 用户操作 → updateSelectList（world/persona/char/plugin）
 *   → 后端 getPartList / getPartDetails → 渲染 <select> + 详情区域
 *   角色/插件增删 → addCharacter/removeCharacter/addPlugin/removePlugin（endpoints.mjs）
 *   → compareLists 差量更新（避免全量重建）→ 触发 triggerCharacterReply
 *   世界书/人设选择 → setWorld/setPersona（endpoints.mjs）→ 右侧详情区域刷新
 *
 * why：
 *   侧栏内容（角色卡/插件/世界书/人设）需与后端实时同步；
 *   compareLists 差量更新防止选择状态被重置；
 *   cachedDom 缓存详情渲染结果，避免未变更项重复请求后端。
 *
 * 关联链：
 *   ← index.mjs / layout.mjs（初始化调用）
 *   → shared/transport/endpoints.mjs（addCharacter/removeCharacter/addPlugin/removePlugin/setWorld/setPersona/triggerCharacterReply）
 *   → shared/chat-core/chat.mjs（charList/personaName/pluginList/worldName 状态读写）
 *   → scripts/parts.mjs（getPartDetails/getPartList：后端资源详情）
 *   → scripts/i18n.mjs / markdown.mjs / template.mjs（国际化/渲染）
 *   → shared/state/utils.mjs（resolveAvatar：头像路径解析）
 *
 * 影响范围：
 *   DOM：#world-select/#persona-select/#char-select/#plugin-select 及对应详情容器；
 *   状态：chat.mjs 中的 charList/pluginList/worldName/personaName；
 *   后端：每次增删角色/插件触发 API 调用。
 *
 * 使用效果：
 *   侧栏下拉框实时反映后端当前对话加载的角色/插件；
 *   切换角色后自动触发角色回复；差量更新保留已选状态。
 */
import { geti18n } from '../../../../../../scripts/i18n.mjs'
import { renderMarkdown } from '../../../../../../scripts/markdown.mjs'
import {
  getPartDetails,
  getPartList,
} from '../../../../../../scripts/parts.mjs'
import { renderTemplate } from '../../../../../../scripts/template.mjs'
import { resolveAvatar } from '../state/utils.mjs'
import { charList, personaName, pluginList, setCharList, setPersonaName, setPluginList, setWorldName, worldName } from '../chat-core/chat.mjs'
import { addCharacter, addPlugin, removeCharacter, removePlugin, setPersona, setWorld, triggerCharacterReply } from '../transport/endpoints.mjs'
import { createDiag } from '../state/diagLogger.mjs'

const diag = createDiag('sidebar')

const worldSelect = document.getElementById('world-select')
const worldDetailsContainer = document.getElementById('world-details')
const personaSelect = document.getElementById('persona-select')
const personaDetailsContainer = document.getElementById('persona-details')
const charSelect = document.getElementById('char-select')
const charDetailsContainer = document.getElementById('char-details')
const addCharButton = document.getElementById('add-char-button')
const pluginSelect = document.getElementById('plugin-select')
const pluginDetailsContainer = document.getElementById('plugin-details')
const addPluginButton = document.getElementById('add-plugin-button')
const itemDescription = document.getElementById('item-description')
const rightSidebarContainer = document.getElementById('right-sidebar-container')
const leftDrawerCheckbox = document.getElementById('left-drawer')

// 缓存DOM
const cachedDom = {
	world: {},
	persona: {},
	character: {},
	plugin: {},
}

/**
 * 比较两个数组的差异
 * @param {Array} oldList 旧数组
 * @param {Array} newList 新数组
 * @returns {{ added: Array, removed: Array, unchanged: Array }} 包含 added, removed, unchanged 三个数组的对象
 */
function compareLists(oldList, newList) {
	const added = newList.filter(item => !oldList.includes(item))
	const removed = oldList.filter(item => !newList.includes(item))
	const unchanged = newList.filter(item => oldList.includes(item))

	return { added, removed, unchanged }
}

/**
 * 更新选择列表
 * @param {HTMLSelectElement} selectElement 选择列表元素
 * @param {string} currentName 当前选中项的名称
 * @param {Function} listGetter 获取列表数据的函数
 * @param {Function} detailsRenderer 渲染详情的函数
 * @param {boolean} forceUpdate 是否强制更新详情, 为 true 时强制更新
 */
async function updateSelectList(selectElement, currentName, listGetter, detailsRenderer, { forceUpdate = false } = {}) {
	try {
		const newList = await listGetter()
		newList.unshift('') // 添加一个空选项

		const oldList = Array.from(selectElement.options).map(option => option.value)
		const { added, removed } = compareLists(oldList, newList)
		if (added.length || removed.length) diag.debug('updateSelectList', selectElement.id, '+', added.length, '-', removed.length)

		// 删除已移除的选项
		removed.forEach(name => {
			const optionToRemove = selectElement.querySelector(`option[value="${name}"]`)
			if (optionToRemove) selectElement.removeChild(optionToRemove)
		})

		// 添加新增的选项
		added.forEach(name => {
			const option = document.createElement('option')
			option.value = name || ''
			option.text = name || geti18n('chat.sidebar.noSelection')
			selectElement.add(option)
		})

		// 更新当前选中项 (如果需要)
		if (currentName !== selectElement.value)
			selectElement.value = currentName || ''

		// 更新详情 (仅当选中项改变或强制更新时)
		if (selectElement.value !== (selectElement.previousValue || '') || forceUpdate)
			await detailsRenderer(selectElement.value)

		selectElement.previousValue = selectElement.value
	} catch (err) {
		console.error('[sidebar] updateSelectList failed:', err)
		window._reportError?.(`[sidebar] updateSelectList: ${err.message}`, err.stack)
	}
}

/**
 * 渲染世界信息列表
 */
async function renderWorldList() {
	try {
		await updateSelectList(worldSelect, worldName, () => getPartList('worlds'), renderWorldDetails, { forceUpdate: true })
	} catch (err) {
		console.error('[sidebar] renderWorldList failed:', err)
		window._reportError?.(`[sidebar] renderWorldList: ${err.message}`, err.stack)
	}
}

/**
 * 渲染世界信息详情
 * @param {string} worldName 世界名称
 */
async function renderWorldDetails(worldName) {
	try {
		worldDetailsContainer.innerHTML = ''
		if (!worldName) return

		let worldData
		if (!cachedDom.world[worldName]) {
			worldData = await getPartDetails(`worlds/${worldName}`)
			// 返空原全静默——详情区空白无信号。埋点出信号，行为不变（不 throw）
			if (!worldData) { diag.warn('getPartDetails 返空:', `worlds/${worldName}`, '→ 详情区留空'); return }
			const worldCard = cachedDom.world[worldName] = await renderTemplate('world_info_chat_view', {
				...worldData.info,
				avatar: resolveAvatar({ avatar: worldData.info?.avatar, kind: 'worlds', name: worldName, fallback: '/parts/shells:beilu-chat/icons/mdi__earth.svg' }),
			})
			addCardEventListeners(worldCard, worldData)
		}

		if (cachedDom.world[worldName])
			worldDetailsContainer.appendChild(cachedDom.world[worldName])
	} catch (err) {
		console.error('[sidebar] renderWorldDetails failed:', err)
		window._reportError?.(`[sidebar] renderWorldDetails: ${err.message}`, err.stack)
	}
}

/**
 * 渲染角色信息列表
 */
async function renderPersonaList() {
	try {
		await updateSelectList(personaSelect, personaName, () => getPartList('personas'), renderPersonaDetails, { forceUpdate: true })
	} catch (err) {
		console.error('[sidebar] renderPersonaList failed:', err)
		window._reportError?.(`[sidebar] renderPersonaList: ${err.message}`, err.stack)
	}
}

/**
 * 渲染角色信息详情
 * @param {string} personaName 角色名称
 */
async function renderPersonaDetails(personaName) {
	try {
		personaDetailsContainer.innerHTML = ''
		if (!personaName) return

		let personaData
		if (!cachedDom.persona[personaName]) {
			personaData = await getPartDetails(`personas/${personaName}`)
			if (!personaData) { diag.warn('getPartDetails 返空:', `personas/${personaName}`); return }
			// 头像：C7 统一契约——空串/缺失/宏显式 fallback，相对文件名转 /parts/ 静态 URL
			const avatarSrc = resolveAvatar({ avatar: personaData.info?.avatar, kind: 'personas', name: personaName, fallback: '/parts/shells:beilu-chat/icons/mdi__account.svg' })
			const personaCard = cachedDom.persona[personaName] = await renderTemplate('persona_info_chat_view', { ...personaData.info, avatar: avatarSrc })
			addCardEventListeners(personaCard, personaData)
		}

		if (cachedDom.persona[personaName])
			personaDetailsContainer.appendChild(cachedDom.persona[personaName])
	} catch (err) {
		console.error('[sidebar] renderPersonaDetails failed:', err)
		window._reportError?.(`[sidebar] renderPersonaDetails: ${err.message}`, err.stack)
	}
}

/**
 * 渲染聊天角色列表
 * @param {object} data - 包含角色列表和频率数据的对象。
 */
async function renderCharList(data) {
	try {
		if (!data) return
		const allChars = await getPartList('chars')
		const currentCharsRendered = Array.from(charDetailsContainer.children).map(child => child.getAttribute('data-char-name'))
		const { added, removed, unchanged } = compareLists(currentCharsRendered, charList)

		// 删除已经移除的角色
		removed.forEach(char => {
			const charCardToRemove = charDetailsContainer.querySelector(`[data-char-name="${char}"]`)
			if (charCardToRemove) {
				charDetailsContainer.removeChild(charCardToRemove)
				delete cachedDom.character[char] // 清理缓存
			}
		})

		// 添加新的角色
		for (const char of added)
			await renderCharDetails(char)

		// 频率刷新段已删（T070 链 UI 末节，凛倾0706授权）：后端全域零 frequency_data 产出，滑条恒 0.5 纯僵尸——
		// 出向端点早删（原 :283 自白 display-only）+入向 char_frequency_set case 已删，整链三节收口。

		// 更新可用角色列表
		const availableChars = allChars.filter(char => !charList.includes(char))
		const charSelectOldList = Array.from(charSelect.options).map(option => option.value)
		const { added: charSelectAdded, removed: charSelectRemoved } = compareLists(charSelectOldList, availableChars)

		charSelectRemoved.forEach(name => {
			const optionToRemove = charSelect.querySelector(`option[value="${name}"]`)
			if (optionToRemove) charSelect.removeChild(optionToRemove)
		})

		charSelectAdded.forEach(name => {
			const option = document.createElement('option')
			option.value = name
			option.text = name
			charSelect.add(option)
		})
	} catch (err) {
		console.error('[sidebar] renderCharList failed:', err)
		window._reportError?.(`[sidebar] renderCharList: ${err.message}`, err.stack)
	}
}

/**
 * 渲染聊天角色详情
 * @param {string} charName 角色名称
 */
async function renderCharDetails(charName) {
	try {
		let charData
		if (!cachedDom.character[charName]) {
			charData = await getPartDetails(`chars/${charName}`)
			if (!charData) { diag.warn('getPartDetails 返空:', `chars/${charName}`); return }
			const charCard = cachedDom.character[charName] = await renderTemplate('char_info_chat_view', {
				...charData.info,
				avatar: resolveAvatar({ avatar: charData.info?.avatar, kind: 'chars', name: charName, fallback: '/parts/shells:beilu-chat/icons/mdi__account-circle.svg' }),
			})
			charCard.dataset.charName = charName
			addCardEventListeners(charCard, charData)
			// 频率滑条绑定段已删（T070 链 UI 末节，模板内滑条同批删除，见 char_info_chat_view.html 注释）

			// 添加移除按钮的事件监听
			const removeCharButton = charCard.querySelector('.remove-char-button')
			removeCharButton.addEventListener('click', async () => {
				try {
					await removeCharacter(charName)
				} catch (err) {
					console.error('[sidebar] removeCharacter click failed:', err)
					window._reportError?.(`[sidebar] removeCharacter click: ${err.message}`, err.stack)
				}
			})

			// 添加强制回复按钮的事件监听
			const forceReplyButton = charCard.querySelector('.force-reply-button')
			forceReplyButton.addEventListener('click', async () => {
				try {
					await triggerCharacterReply(charName)
				} catch (err) {
					console.error('[sidebar] triggerCharacterReply click failed:', err)
					window._reportError?.(`[sidebar] triggerCharacterReply click: ${err.message}`, err.stack)
				}
			})
		}

		if (cachedDom.character[charName] && !charDetailsContainer.querySelector(`[data-char-name="${charName}"]`))
			charDetailsContainer.appendChild(cachedDom.character[charName])
	} catch (err) {
		console.error('[sidebar] renderCharDetails failed:', err)
		window._reportError?.(`[sidebar] renderCharDetails: ${err.message}`, err.stack)
	}
}

/**
 * 渲染插件列表
 * @param {object} data - 包含插件列表的对象。
 */
async function renderPluginList(data) {
	try {
		if (!data) return
		const allPlugins = await getPartList('plugins')
		const currentPluginsRendered = Array.from(pluginDetailsContainer.children).map(child => child.getAttribute('data-plugin-name'))
		const { added, removed, unchanged } = compareLists(currentPluginsRendered, pluginList)

		// 删除已经移除的插件
		removed.forEach(plugin => {
			const pluginCardToRemove = pluginDetailsContainer.querySelector(`[data-plugin-name="${plugin}"]`)
			if (pluginCardToRemove) {
				pluginDetailsContainer.removeChild(pluginCardToRemove)
				delete cachedDom.plugin[plugin] // 清理缓存
			}
		})

		// 添加新的插件
		for (const plugin of added)
			await renderPluginDetails(plugin)

		// 更新可用插件列表
		const availablePlugins = allPlugins.filter(plugin => !pluginList.includes(plugin))
		const pluginSelectOldList = Array.from(pluginSelect.options).map(option => option.value)
		const { added: pluginSelectAdded, removed: pluginSelectRemoved } = compareLists(pluginSelectOldList, availablePlugins)

		pluginSelectRemoved.forEach(name => {
			const optionToRemove = pluginSelect.querySelector(`option[value="${name}"]`)
			if (optionToRemove) pluginSelect.removeChild(optionToRemove)
		})

		pluginSelectAdded.forEach(name => {
			const option = document.createElement('option')
			option.value = name
			option.text = name
			pluginSelect.add(option)
		})
	} catch (err) {
		console.error('[sidebar] renderPluginList failed:', err)
		window._reportError?.(`[sidebar] renderPluginList: ${err.message}`, err.stack)
	}
}

/**
 * 渲染插件详情
 * @param {string} pluginName 插件名称
 */
async function renderPluginDetails(pluginName) {
	try {
		let pluginData
		if (!cachedDom.plugin[pluginName]) {
			pluginData = await getPartDetails(`plugins/${pluginName}`)
			if (!pluginData) { diag.warn('getPartDetails 返空:', `plugins/${pluginName}`); return }
			const pluginCard = cachedDom.plugin[pluginName] = await renderTemplate('plugin_info_chat_view', {
				name: pluginName,
				description: '',
				...pluginData.info,
				avatar: resolveAvatar({ avatar: pluginData.info?.avatar, kind: 'plugins', name: pluginName, fallback: '/parts/shells:beilu-chat/icons/mdi__puzzle-outline.svg' }),
			})
			pluginCard.dataset.pluginName = pluginName
			addCardEventListeners(pluginCard, pluginData)

			// 添加移除按钮的事件监听
			const removePluginButton = pluginCard.querySelector('.remove-plugin-button')
			removePluginButton.addEventListener('click', async () => {
				try {
					await removePlugin(pluginName)
				} catch (err) {
					console.error('[sidebar] removePlugin click failed:', err)
					window._reportError?.(`[sidebar] removePlugin click: ${err.message}`, err.stack)
				}
			})
		}

		if (cachedDom.plugin[pluginName] && !pluginDetailsContainer.querySelector(`[data-plugin-name="${pluginName}"]`))
			pluginDetailsContainer.appendChild(cachedDom.plugin[pluginName])
	} catch (err) {
		console.error('[sidebar] renderPluginDetails failed:', err)
		window._reportError?.(`[sidebar] renderPluginDetails: ${err.message}`, err.stack)
	}
}

/**
 * 为卡片添加事件监听器
 * @param {HTMLElement} card 卡片元素
 * @param {object} data 卡片数据
 */
function addCardEventListeners(card, data) {
	card.addEventListener('mouseenter', () => {
		displayItemDescription(data.info.description_markdown)
		showRightSidebar()
	})

	card.addEventListener('click', () => {
		displayItemDescription(data.info.description_markdown)
		showRightSidebar()
	})
}

/**
 * 显示条目描述
 * @param {string} markdown 描述的markdown内容
 */
async function displayItemDescription(markdown) {
	try {
		if (!markdown) {
			itemDescription.innerHTML = geti18n('chat.sidebar.noDescription')
			return
		}
		itemDescription.innerHTML = ''
		itemDescription.appendChild(await renderMarkdown(markdown))
	} catch (err) {
		console.error('[sidebar] displayItemDescription failed:', err)
		window._reportError?.(`[sidebar] displayItemDescription: ${err.message}`, err.stack)
	}
}

/**
 * 显示右侧边栏
 */
function showRightSidebar() {
	rightSidebarContainer.classList.remove('sidebar-hidden')
}

/**
 * 隐藏右侧边栏
 */
function hideRightSidebar() {
	rightSidebarContainer.classList.add('sidebar-hidden')
}

/**
 * 初始化侧边栏
 */
export async function setupSidebar() {
	try {
		worldSelect.addEventListener('change', async () => {
			try {
				const newWorldName = worldSelect.value === '' ? null : worldSelect.value
				await setWorld(newWorldName)
			} catch (err) {
				console.error('[sidebar] worldSelect change failed:', err)
				window._reportError?.(`[sidebar] worldSelect change: ${err.message}`, err.stack)
			}
		})

		personaSelect.addEventListener('change', async () => {
			try {
				const newPersonaName = personaSelect.value === '' ? null : personaSelect.value
				await setPersona(newPersonaName)
				setPersonaName(newPersonaName)
			} catch (err) {
				console.error('[sidebar] personaSelect change failed:', err)
				window._reportError?.(`[sidebar] personaSelect change: ${err.message}`, err.stack)
			}
		})

		addCharButton.addEventListener('click', async () => {
			try {
				const charName = charSelect.value
				if (charName && !charList.includes(charName))
					await addCharacter(charName)
			} catch (err) {
				console.error('[sidebar] addCharButton click failed:', err)
				window._reportError?.(`[sidebar] addCharButton click: ${err.message}`, err.stack)
			}
		})

		addPluginButton.addEventListener('click', async () => {
			try {
				const pluginName = pluginSelect.value
				if (pluginName && !pluginList.includes(pluginName))
					await addPlugin(pluginName)
			} catch (err) {
				console.error('[sidebar] addPluginButton click failed:', err)
				window._reportError?.(`[sidebar] addPluginButton click: ${err.message}`, err.stack)
			}
		})

		// 点击非右侧边栏关闭右侧边栏
		document.addEventListener('click', event => {
			if (!rightSidebarContainer.contains(event.target))
				hideRightSidebar()
		})

		// 鼠标移出右侧边栏区域隐藏右侧边栏
		rightSidebarContainer.addEventListener('mouseleave', () => {
			hideRightSidebar()
		})
	} catch (err) {
		console.error('[sidebar] setupSidebar failed:', err)
		window._reportError?.(`[sidebar] setupSidebar: ${err.message}`, err.stack)
	}
}

/**
 * 更新侧边栏显示。
 * @param {object} data - 包含世界名称、角色名称和角色列表的数据对象。
 */
export async function updateSidebar(data) {
	try {
		diag.debug('updateSidebar', 'chars:', data?.charlist?.length ?? 0, 'plugins:', data?.pluginlist?.length ?? 0, 'world:', data?.worldname || '(无)', 'persona:', data?.personaname || '(无)')
		diag.guard(data, ['charlist', 'pluginlist'], 'updateSidebar')
		setCharList(data.charlist)
		setPluginList(data.pluginlist)
		setWorldName(data.worldname)
		setPersonaName(data.personaname)

		// 尝试更新数据
		await renderWorldList()
		await renderPersonaList()
		await renderCharList(data)
		await renderPluginList(data)
	} catch (err) {
		console.error('[sidebar] updateSidebar failed:', err)
		window._reportError?.(`[sidebar] updateSidebar: ${err.message}`, err.stack)
	}
}

/**
 * 处理世界设置。
 * @param {string} worldname - 世界的名称。
 */
export async function handleWorldSet(worldname) {
	try {
		setWorldName(worldname)
		worldSelect.value = worldname || ''
		await renderWorldDetails(worldname)
	} catch (err) {
		console.error('[sidebar] handleWorldSet failed:', err)
		window._reportError?.(`[sidebar] handleWorldSet: ${err.message}`, err.stack)
	}
}

/**
 * 处理角色设置。
 * @param {string} personaname - 角色的名称。
 */
export async function handlePersonaSet(personaname) {
	try {
		setPersonaName(personaname)
		personaSelect.value = personaname || ''
		await renderPersonaDetails(personaname)
	} catch (err) {
		console.error('[sidebar] handlePersonaSet failed:', err)
		window._reportError?.(`[sidebar] handlePersonaSet: ${err.message}`, err.stack)
	}
}

/**
 * 处理角色添加。
 * @param {string} charname - 要添加的角色的名称。
 */
export async function handleCharAdded(charname) {
	try {
		diag.debug('handleCharAdded:', charname)
		if (charList.includes(charname)) return // Already there

		charList.push(charname)
		setCharList(charList)

		// Add to UI
		await renderCharDetails(charname)

		// Remove from select dropdown
		const optionToRemove = charSelect.querySelector(`option[value="${charname}"]`)
		if (optionToRemove) charSelect.removeChild(optionToRemove)
	} catch (err) {
		console.error('[sidebar] handleCharAdded failed:', err)
		window._reportError?.(`[sidebar] handleCharAdded: ${err.message}`, err.stack)
	}
}

/**
 * 处理角色移除。
 * @param {string} charname - 要移除的角色的名称。
 */
export async function handleCharRemoved(charname) {
	try {
		diag.debug('handleCharRemoved:', charname)
		const index = charList.indexOf(charname)
		if (index === -1) return // Not there

		charList.splice(index, 1)
		setCharList(charList)

		// Remove from UI
		const charCardToRemove = charDetailsContainer.querySelector(`[data-char-name="${charname}"]`)
		if (charCardToRemove) {
			charDetailsContainer.removeChild(charCardToRemove)
			delete cachedDom.character[charname]
		}

		// Add back to select dropdown
		if (!charSelect.querySelector(`option[value="${charname}"]`)) {
			const option = document.createElement('option')
			option.value = charname
			option.text = charname
			charSelect.add(option)
		}
	} catch (err) {
		console.error('[sidebar] handleCharRemoved failed:', err)
		window._reportError?.(`[sidebar] handleCharRemoved: ${err.message}`, err.stack)
	}
}

// T070 死枝删除（凛倾 2026-07-06 授权）：handleCharFrequencySet + websocket char_frequency_set case 整链删——
//   全库（含 dist/yonban）零 broadcastChatEvent 发送点=事件永不到达，handler 从未执行过。备份=删除批_凛倾授权_20260706_1258。

/**
 * 处理插件添加。
 * @param {string} pluginname - 要添加的插件的名称。
 */
export async function handlePluginAdded(pluginname) {
	try {
		if (pluginList.includes(pluginname)) return // Already there

		pluginList.push(pluginname)
		setPluginList(pluginList)

		// Add to UI
		await renderPluginDetails(pluginname)

		// Remove from select dropdown
		const optionToRemove = pluginSelect.querySelector(`option[value="${pluginname}"]`)
		if (optionToRemove) pluginSelect.removeChild(optionToRemove)
	} catch (err) {
		console.error('[sidebar] handlePluginAdded failed:', err)
		window._reportError?.(`[sidebar] handlePluginAdded: ${err.message}`, err.stack)
	}
}

/**
 * 处理插件移除。
 * @param {string} pluginname - 要移除的插件的名称。
 */
export async function handlePluginRemoved(pluginname) {
	try {
		const index = pluginList.indexOf(pluginname)
		if (index === -1) return // Not there

		pluginList.splice(index, 1)
		setPluginList(pluginList)

		// Remove from UI
		const pluginCardToRemove = pluginDetailsContainer.querySelector(`[data-plugin-name="${pluginname}"]`)
		if (pluginCardToRemove) {
			pluginDetailsContainer.removeChild(pluginCardToRemove)
			delete cachedDom.plugin[pluginname]
		}

		// Add back to select dropdown
		if (!pluginSelect.querySelector(`option[value="${pluginname}"]`)) {
			const option = document.createElement('option')
			option.value = pluginname
			option.text = pluginname
			pluginSelect.add(option)
		}
	} catch (err) {
		console.error('[sidebar] handlePluginRemoved failed:', err)
		window._reportError?.(`[sidebar] handlePluginRemoved: ${err.message}`, err.stack)
	}
}

/**
 * 将部件添加到侧边栏的相关选择列表中。
 * @param {string} parttype - 部件类型 (例如, 'worlds', 'personas', 'chars')。
 * @param {string} partname - 部件名称。
 */
export function addPartToSelect(parttype, partname) {
	let selectElement
	switch (parttype) {
		case 'worlds':
			selectElement = worldSelect
			break
		case 'personas':
			selectElement = personaSelect
			break
		case 'chars':
			selectElement = charSelect
			break
		case 'plugins':
			selectElement = pluginSelect
			break
		default:
			return
	}

	if (!selectElement || selectElement.querySelector(`option[value="${partname}"]`)) return

	const option = document.createElement('option')
	option.value = partname
	option.text = partname
	selectElement.add(option)
}

/**
 * 从侧边栏的相关选择列表和活动用户界面中删除部件。
 * @param {string} parttype - 部件类型 (例如, 'worlds', 'personas', 'chars')。
 * @param {string} partname - 部件名称。
 */
export function removePartFromSelect(parttype, partname) {
	let selectElement
	let cacheType
	switch (parttype) {
		case 'worlds':
			selectElement = worldSelect
			cacheType = 'world'
			break
		case 'personas':
			selectElement = personaSelect
			cacheType = 'persona'
			break
		case 'chars':
			selectElement = charSelect
			cacheType = 'character'
			break
		case 'plugins':
			selectElement = pluginSelect
			cacheType = 'plugin'
			break
		default:
			return
	}

	// Remove from dropdown
	if (selectElement) {
		const optionToRemove = selectElement.querySelector(`option[value="${partname}"]`)
		if (optionToRemove) selectElement.removeChild(optionToRemove)
	}

	// If it's a char, also remove from the active list in the chat
	if (parttype === 'chars') {
		const charCardToRemove = charDetailsContainer.querySelector(`[data-char-name="${partname}"]`)
		if (charCardToRemove) charDetailsContainer.removeChild(charCardToRemove)
	}

	// Clean up cache
	if (cacheType && cachedDom[cacheType]?.[partname])
		delete cachedDom[cacheType][partname]
}

/**
 * "使用"选项卡核心逻辑
 *
 * 职责：
 * - 获取角色卡列表（Fount API）
 * - 获取聊天摘要（beilu-home 后端 API）
 * - 渲染角色卡网格
 * - 点击角色卡 → 查找最后对话 → 跳转聊天
 * - 导入角色卡按钮
 * - 左侧导航子菜单切换
 */

import { t } from '../i18n.mjs'
import { getAllCachedPartDetails } from '/scripts/parts.mjs'

// ===== 角色卡附属资源提取 =====

/**
 * 从已解析的角色卡数据中提取附属资源（正则脚本 + 内嵌世界书）
 * 并自动导入到对应的 beilu 插件中
 *
 * @param {Object} data - 解析后的角色卡数据（ST v2/v3 的 data 层）
 * @param {string} charName - 角色卡在文件系统中的名称（用于 boundCharName 绑定）
 * @returns {Promise<{regex: number, worldbook: number}>} 导入结果
 */
async function extractAndImportResources(data, charName) {
	const results = { regex: 0, worldbook: 0 }
	if (!data) return results

	try {
		// 1. 提取正则脚本
		const regexScripts = data.extensions?.regex_scripts
		if (Array.isArray(regexScripts) && regexScripts.length > 0) {
			try {
				const res = await fetch('/api/parts/plugins:beilu-regex/config/setdata', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						_action: 'importST',
						scripts: regexScripts,
						scope: 'scoped',
						boundCharName: charName,
					}),
				})
				if (res.ok) {
					const result = await res.json()
					results.regex = result?._result?.count || regexScripts.length
					console.log(`[beilu-home] 从角色卡提取 ${results.regex} 条正则脚本`)
				}
			} catch (err) {
				console.warn('[beilu-home] 导入正则脚本失败:', err)
			}
		}

		// 2. 提取内嵌世界书
		const charBook = data.extensions?.character_book || data.character_book
		if (charBook?.entries && Object.keys(charBook.entries).length > 0) {
			try {
				const bookName = `${data.name || '未知角色'} 世界书`
				const res = await fetch('/api/parts/plugins:beilu-worldbook/config/setdata', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						import_worldbook: {
							json: charBook,
							name: bookName,
							boundCharName: charName,
						},
					}),
				})
				if (res.ok) {
					results.worldbook = Object.keys(charBook.entries).length
					console.log(`[beilu-home] 从角色卡提取 ${results.worldbook} 条世界书条目`)
				}
			} catch (err) {
				console.warn('[beilu-home] 导入世界书失败:', err)
			}
		}
	} catch (err) {
		console.warn('[beilu-home] 提取角色卡附属资源失败:', err)
	}

	return results
}

/**
 * 构建导入结果摘要消息
 * @param {string} charName - 导入的角色名
 * @param {number} totalRegex - 导入的正则数
 * @param {number} totalWorldbook - 导入的世界书条目数
 * @returns {string} 摘要消息
 */
function buildImportSummary(charName, totalRegex, totalWorldbook) {
	const parts = [t('chars.import.success', { name: charName })]
	if (totalRegex > 0) parts.push(t('chars.import.regex', { count: totalRegex }))
	if (totalWorldbook > 0) parts.push(t('chars.import.worldbook', { count: totalWorldbook }))
	return parts.join('\n')
}

/**
 * 显示删除角色卡确认对话框（带资源清理选项）
 * @param {string} displayName - 角色显示名称
 * @returns {Promise<{deleteChats: boolean, deleteMemory: boolean, deleteWorldbook: boolean}|null>} 选项或 null（取消）
 */
function showDeleteConfirmDialog(displayName) {
	return new Promise((resolve) => {
		// 创建遮罩层
		const overlay = document.createElement('div')
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;'

		const dialog = document.createElement('div')
		dialog.style.cssText = 'background:#2a2a2a;color:#eee;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);'

		dialog.innerHTML = `
			<h3 style="margin:0 0 12px;font-size:16px;">${t('chars.delete.title', { name: displayName })}</h3>
			<p style="margin:0 0 16px;font-size:13px;color:#aaa;">${t('chars.delete.desc')}</p>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-chats" checked style="width:16px;height:16px;"> ${t('chars.delete.chats')}
			</label>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-memory" checked style="width:16px;height:16px;"> ${t('chars.delete.memory')}
			</label>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-worldbook" checked style="width:16px;height:16px;"> ${t('chars.delete.worldbook')}
			</label>
			<div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
				<button id="del-cancel" style="padding:8px 20px;border:1px solid #555;background:transparent;color:#ccc;border-radius:6px;cursor:pointer;font-size:14px;">${t('chars.delete.cancel')}</button>
				<button id="del-confirm" style="padding:8px 20px;border:none;background:#e53e3e;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">${t('chars.delete.confirm')}</button>
			</div>
		`

		overlay.appendChild(dialog)
		document.body.appendChild(overlay)

		// 取消
		dialog.querySelector('#del-cancel').addEventListener('click', () => {
			document.body.removeChild(overlay)
			resolve(null)
		})
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				document.body.removeChild(overlay)
				resolve(null)
			}
		})

		// 确认
		dialog.querySelector('#del-confirm').addEventListener('click', () => {
			const result = {
				deleteChats: dialog.querySelector('#del-chats').checked,
				deleteMemory: dialog.querySelector('#del-memory').checked,
				deleteWorldbook: dialog.querySelector('#del-worldbook').checked,
			}
			document.body.removeChild(overlay)
			resolve(result)
		})
	})
}

/**
 * 执行单个文件的导入流程（上传 → 提取附属资源）
 * @param {File} file - 要导入的文件
 * @returns {Promise<{success: boolean, message: string}>} 导入结果
 */
async function importSingleFile(file) {
	const formData = new FormData()
	formData.append('file', file)

	// Step 1: 上传到 beilu 自定义导入 API
	const res = await fetch('/api/parts/shells:beilu-home/import-char', {
		method: 'POST',
		body: formData,
	})

	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		return { success: false, message: err.message || res.statusText }
	}

	const result = await res.json()
	const charDisplayName = result.original_name || result.name
	const charFsName = result.name // 文件系统中的角色名（用于 boundCharName 绑定）
	const chardata = result.chardata

	// Step 2: 提取附属资源（正则 + 世界书），绑定到文件系统角色名
	const { regex, worldbook } = await extractAndImportResources(chardata, charFsName)

	return {
		success: true,
		message: buildImportSummary(charDisplayName, regex, worldbook),
	}
}

// ===== DOM 引用 =====
const charsLoading = document.getElementById('chars-loading')
const charsGrid = document.getElementById('chars-grid')
const charsEmpty = document.getElementById('chars-empty')
const charsImportBtn = document.getElementById('chars-import-btn')
const charsCreateBtn = document.getElementById('chars-create-btn')

// ===== 数据获取 =====

/**
 * 获取聊天摘要缓存
 * @returns {Promise<Object>} { chatid: { chatid, chars[], lastMessageTime, ... } }
 */
async function fetchChatSummaries() {
	try {
		const res = await fetch('/api/parts/shells:beilu-home/chat-summaries')
		if (!res.ok) return {}
		return await res.json()
	} catch (err) {
		console.warn('[beilu-home] 获取聊天摘要失败:', err)
		return {}
	}
}

/**
 * 从摘要中查找角色的最后一次对话
 * @param {string} charName - 角色名称
 * @param {Object} summaries - 聊天摘要缓存
 * @returns {string|null} 最近的 chatId，或 null
 */
function findLastChat(charName, summaries) {
	const chats = Object.values(summaries)
		.filter(s => s && s.chars && s.chars.includes(charName))
		.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime))
	return chats.length > 0 ? chats[0].chatid : null
}

/**
 * 格式化时间为相对时间
 * @param {string} isoTime - ISO 时间字符串
 * @returns {string} 相对时间文本
 */
function formatRelativeTime(isoTime) {
	if (!isoTime) return ''
	const diff = Date.now() - new Date(isoTime).getTime()
	const minutes = Math.floor(diff / 60000)
	if (minutes < 1) return t('time.justNow')
	if (minutes < 60) return t('time.minutesAgo', { n: minutes })
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return t('time.hoursAgo', { n: hours })
	const days = Math.floor(hours / 24)
	if (days < 30) return t('time.daysAgo', { n: days })
	const months = Math.floor(days / 30)
	return t('time.monthsAgo', { n: months })
}

/**
 * 获取角色的显示名称
 * @param {Object} details - 角色详情对象
 * @param {string} key - 角色 key（目录名）
 * @returns {string} 显示名称
 */
function getCharDisplayName(details, key) {
	if (details?.name) {
		if (typeof details.name === 'string') return details.name
		// 多语言 name 对象，优先 zh-CN → en-UK → 第一个
		return details.name['zh-CN'] || details.name['en-UK'] || Object.values(details.name)[0] || key
	}
	return key
}

/**
 * 获取角色头像 URL
 * @param {Object} details - 角色详情对象
 * @param {string} key - 角色 key
 * @returns {string|null} 头像 URL 或 null
 */
function getCharAvatarUrl(details, key) {
	if (details?.avatar) {
		// avatar 可能是 base64、绝对URL、Fount路径 或相对路径
		if (details.avatar.startsWith('data:') || details.avatar.startsWith('http')) {
			return details.avatar
		}
		// Fount 路径（以 / 开头），直接使用
		if (details.avatar.startsWith('/')) {
			return details.avatar
		}
		// 相对路径
		return `/api/parts/res/chars/${key}/${details.avatar}`
	}
	// details.avatar 为空时，仍然尝试标准头像路径
	// （导入或编辑器上传的图片可能还没反映到 Fount parts 缓存中）
	// img.onerror 回调会在 404 时回退到 emoji
	return `/parts/chars:${encodeURIComponent(key)}/image.png`
}

// ===== 渲染 =====

/**
 * 创建单个角色卡 DOM 元素
 * @param {string} key - 角色 key
 * @param {Object} details - 角色详情
 * @param {Object} summaries - 聊天摘要
 * @returns {HTMLElement}
 */
function createCharCard(key, details, summaries) {
	const card = document.createElement('div')
	card.className = 'beilu-char-card'

	const displayName = getCharDisplayName(details, key)
	const avatarUrl = getCharAvatarUrl(details, key)

	// 头像
	const avatarDiv = document.createElement('div')
	avatarDiv.className = 'beilu-char-avatar'
	if (avatarUrl) {
		const img = document.createElement('img')
		img.src = avatarUrl
		img.alt = displayName
		img.loading = 'lazy'
		img.onerror = () => {
			img.remove()
			avatarDiv.textContent = '🎭'
		}
		avatarDiv.appendChild(img)
	} else {
		avatarDiv.textContent = '🎭'
	}
	card.appendChild(avatarDiv)

	// 名称
	const nameDiv = document.createElement('div')
	nameDiv.className = 'beilu-char-name'
	nameDiv.textContent = displayName
	nameDiv.title = displayName
	card.appendChild(nameDiv)

	// 最后对话时间
	const lastChatId = findLastChat(key, summaries)
	if (lastChatId) {
		const summary = summaries[lastChatId]
		const timeDiv = document.createElement('div')
		timeDiv.className = 'beilu-char-last-chat'
		timeDiv.textContent = formatRelativeTime(summary?.lastMessageTime)
		card.appendChild(timeDiv)
	}

	// 设置按钮（左上角）
	const settingsBtn = document.createElement('button')
	settingsBtn.className = 'beilu-char-settings-btn'
	settingsBtn.textContent = '⚙'
	settingsBtn.title = t('chars.edit.title')
	settingsBtn.addEventListener('click', (e) => {
		e.stopPropagation()
		openCharEditDialog(key, displayName, avatarUrl)
	})
	card.appendChild(settingsBtn)

	// 删除按钮
	const deleteBtn = document.createElement('button')
	deleteBtn.className = 'beilu-char-delete-btn'
	deleteBtn.textContent = '×'
	deleteBtn.title = t('chars.delete')
	deleteBtn.addEventListener('click', async (e) => {
		e.stopPropagation()  // 阻止触发卡片的点击事件
		const deleteOptions = await showDeleteConfirmDialog(displayName)
		if (!deleteOptions) return  // 用户取消

		try {
			const res = await fetch(`/api/parts/shells:beilu-home/delete-char/${encodeURIComponent(key)}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(deleteOptions),
			})
			if (res.ok) {
				const result = await res.json()
				console.log(`[beilu-home] 角色卡已删除: ${key}`, result.cleanup)
				await loadChars()
			} else {
				const err = await res.json().catch(() => ({}))
				alert('删除失败: ' + (err.message || res.statusText))
			}
		} catch (err) {
			alert('删除出错: ' + err.message)
		}
	})
	card.appendChild(deleteBtn)

	// 点击事件
	card.addEventListener('click', () => {
		if (lastChatId) {
			// 有历史对话 → 跳转到最后一次对话
			window.location.href = `/parts/shells:beilu-chat/#${lastChatId}`
		} else {
			// 无历史对话 → 新建对话
			window.location.href = `/parts/shells:beilu-chat/new?char=${encodeURIComponent(key)}`
		}
	})

	return card
}

/**
 * 创建导入角色卡按钮
 * @returns {HTMLElement}
 */
function createImportCard() {
	const card = document.createElement('div')
	card.className = 'beilu-import-card'

	const icon = document.createElement('div')
	icon.className = 'beilu-import-icon'
	icon.textContent = '+'
	card.appendChild(icon)

	const label = document.createElement('div')
	label.className = 'beilu-import-label'
	label.textContent = t('chars.import.card')
	card.appendChild(label)

	// 创建隐藏的文件输入
	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = '.json,.png'
	fileInput.style.display = 'none'
	fileInput.multiple = true
	card.appendChild(fileInput)

	card.addEventListener('click', () => {
		fileInput.click()
	})

	fileInput.addEventListener('change', async (e) => {
		const files = e.target.files
		if (!files || files.length === 0) return
		await handleImportFiles(files)
		fileInput.value = ''
	})

	return card
}

/**
 * 加载并渲染角色卡列表
 */
async function loadChars() {
	charsLoading.style.display = ''
	charsGrid.style.display = 'none'
	charsEmpty.style.display = 'none'

	try {
		// 并行获取角色卡列表和聊天摘要
		const [result, summaries] = await Promise.all([
			getAllCachedPartDetails('chars'),
			fetchChatSummaries(),
		])

		// getAllCachedPartDetails 返回 { cachedDetails: { name: details }, uncachedNames: [] }
		const cachedDetails = result?.cachedDetails || {}
		const uncachedNames = result?.uncachedNames || []
		const charKeys = [...Object.keys(cachedDetails), ...uncachedNames]

		charsLoading.style.display = 'none'

		if (charKeys.length === 0) {
			charsEmpty.style.display = ''
			// 在空状态区域也放一个导入按钮
			charsEmpty.innerHTML = ''
			const p = document.createElement('p')
				p.textContent = t('chars.empty.short')
			charsEmpty.appendChild(p)
			charsEmpty.appendChild(createImportCard())
			return
		}

		// 渲染角色卡网格
		charsGrid.innerHTML = ''
		for (const key of charKeys) {
			const card = createCharCard(key, cachedDetails[key] || null, summaries)
			charsGrid.appendChild(card)
		}

		// 末尾添加导入按钮
		charsGrid.appendChild(createImportCard())

		charsGrid.style.display = ''
	} catch (err) {
		console.error('[beilu-home] 加载角色卡失败:', err)
		charsLoading.style.display = 'none'
		charsEmpty.style.display = ''
		charsEmpty.innerHTML = `<p>加载失败: ${err.message}</p>`
	}
}

/**
 * 处理多个文件的导入（逐个上传）
 * @param {FileList} files - 文件列表
 */
async function handleImportFiles(files) {
	const messages = []
	let hasError = false

	for (const file of files) {
		try {
			const result = await importSingleFile(file)
			if (result.success) {
				messages.push(result.message)
			} else {
				hasError = true
				messages.push(`❌ ${file.name}: ${result.message}`)
			}
		} catch (err) {
			hasError = true
			messages.push(`❌ ${file.name}: ${err.message}`)
		}
	}

	// 显示汇总结果
	if (messages.length > 0) {
		alert(messages.join('\n\n'))
	}

	// 刷新角色卡列表
	await loadChars()
}

// ===== 工具栏导入按钮 =====
function setupToolbarImport() {
	if (!charsImportBtn) return
	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = '.json,.png'
	fileInput.style.display = 'none'
	fileInput.multiple = true
	document.body.appendChild(fileInput)

	charsImportBtn.addEventListener('click', () => fileInput.click())

	fileInput.addEventListener('change', async (e) => {
		const files = e.target.files
		if (!files || files.length === 0) return
		await handleImportFiles(files)
		fileInput.value = ''
	})
}

// ===== 新建角色卡 =====
function setupCreateChar() {
	if (!charsCreateBtn) return

	charsCreateBtn.addEventListener('click', async () => {
		const name = prompt(t('chars.prompt.newName'))
		if (!name || !name.trim()) return

		try {
			const res = await fetch('/api/parts/shells:beilu-home/create-char', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() }),
			})

			if (res.ok) {
				console.log('[beilu-home] 角色卡创建成功')
				await loadChars()
			} else {
				const err = await res.json().catch(() => ({}))
				alert('创建失败: ' + (err.message || res.statusText))
			}
		} catch (err) {
			alert('创建出错: ' + err.message)
		}
	})
}

// ===== 角色卡编辑弹窗 =====

/**
 * 打开角色卡编辑弹窗
 * @param {string} charKey - 角色key
 * @param {string} displayName - 显示名称
 * @param {string|null} currentAvatarUrl - 当前头像URL
 */
async function openCharEditDialog(charKey, displayName, currentAvatarUrl) {
	// 先获取角色卡完整数据
	let chardata = {}
	try {
		const res = await fetch(`/api/parts/shells:beilu-home/char-data/${encodeURIComponent(charKey)}`)
		if (res.ok) {
			chardata = await res.json()
		}
	} catch (err) {
		console.warn('[beilu-home] 获取角色数据失败:', err)
	}

	// 创建遮罩
	const overlay = document.createElement('div')
	overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;'

	const dialog = document.createElement('div')
	dialog.className = 'beilu-char-edit-dialog'
	dialog.style.cssText = 'background:rgba(255,253,245,0.8);color:#1a1a1a;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'

	// 用于暂存新头像文件
	let newAvatarFile = null

	dialog.innerHTML = `
		<h3 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#b45309;">${t('chars.edit.settings')}「${escapeHtml(displayName)}」</h3>
		
		<!-- 头像区域 -->
		<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;">
			<div id="char-edit-avatar-preview" style="width:80px;height:80px;border-radius:50%;background:rgba(0,0,0,0.06);display:flex;align-items:center;justify-content:center;font-size:2rem;overflow:hidden;flex-shrink:0;border:2px solid #d97706;">
				${currentAvatarUrl ? `<img src="${currentAvatarUrl}" style="width:100%;height:100%;object-fit:cover;" />` : '🎭'}
			</div>
			<div>
				<button id="char-edit-avatar-btn" style="padding:6px 16px;border:1px solid #d97706;background:transparent;color:#333;border-radius:6px;cursor:pointer;font-size:13px;">${t('chars.edit.avatar')}</button>
				<input type="file" id="char-edit-avatar-input" accept="image/*" style="display:none;" />
				<div style="font-size:11px;color:#888;margin-top:4px;">${t('chars.edit.avatar.hint')}</div>
			</div>
		</div>

		<!-- 开场白 -->
		<div style="margin-bottom:12px;">
			<label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:4px;">${t('chars.edit.greeting')}</label>
			<textarea id="char-edit-greeting" style="width:100%;min-height:100px;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:rgba(255,255,255,0.5);color:#1a1a1a;font-size:13px;resize:vertical;box-sizing:border-box;" placeholder="${t('chars.edit.greeting.placeholder')}">${escapeHtml(chardata.first_mes || '')}</textarea>
		</div>

		<!-- 备选开场白 (alternate_greetings) -->
		<div style="margin-bottom:12px;">
			<label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:4px;">${t('chars.edit.altGreetings')}</label>
			<div id="char-edit-alt-greetings"></div>
			<button id="char-edit-add-greeting" type="button" style="padding:6px 14px;border:1px dashed #d97706;background:transparent;color:#b45309;border-radius:6px;cursor:pointer;font-size:13px;margin-top:4px;">${t('chars.edit.altGreetings.add')}</button>
			<div style="font-size:11px;color:#888;margin-top:4px;">${t('chars.edit.altGreetings.hint')}</div>
		</div>

		<!-- 角色描述 -->
		<div style="margin-bottom:12px;">
			<label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:4px;">${t('chars.edit.description')}</label>
			<textarea id="char-edit-desc" style="width:100%;min-height:80px;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:rgba(255,255,255,0.5);color:#1a1a1a;font-size:13px;resize:vertical;box-sizing:border-box;" placeholder="${t('chars.edit.description.placeholder')}">${escapeHtml(chardata.description || '')}</textarea>
		</div>

		<!-- 角色性格 -->
		<div style="margin-bottom:12px;">
			<label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:4px;">${t('chars.edit.personality')}</label>
			<textarea id="char-edit-personality" style="width:100%;min-height:60px;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:rgba(255,255,255,0.5);color:#1a1a1a;font-size:13px;resize:vertical;box-sizing:border-box;" placeholder="${t('chars.edit.personality.placeholder')}">${escapeHtml(chardata.personality || '')}</textarea>
		</div>

		<!-- 创作者备注 -->
		<div style="margin-bottom:12px;">
			<label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:4px;">${t('chars.edit.creatorNotes')}</label>
			<textarea id="char-edit-notes" style="width:100%;min-height:60px;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:rgba(255,255,255,0.5);color:#1a1a1a;font-size:13px;resize:vertical;box-sizing:border-box;" placeholder="${t('chars.edit.creatorNotes.placeholder')}">${escapeHtml(chardata.creator_notes || '')}</textarea>
		</div>

		<!-- 操作按钮 -->
		<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:20px;">
			<button id="char-edit-cancel" style="padding:8px 20px;border:1px solid rgba(0,0,0,0.15);background:transparent;color:#555;border-radius:6px;cursor:pointer;font-size:14px;">${t('chars.edit.cancel')}</button>
			<button id="char-edit-save" style="padding:8px 20px;border:none;background:#b45309;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">${t('chars.edit.save')}</button>
		</div>
		<div id="char-edit-status" style="font-size:12px;text-align:center;color:#888;margin-top:8px;"></div>
	`

	overlay.appendChild(dialog)
	document.body.appendChild(overlay)

	// === 初始化 alternate_greetings 编辑区域 ===
	const altGreetingsContainer = dialog.querySelector('#char-edit-alt-greetings')
	const addGreetingBtn = dialog.querySelector('#char-edit-add-greeting')
	const existingAlts = Array.isArray(chardata.alternate_greetings) ? chardata.alternate_greetings : []

	function createAltGreetingItem(text, index) {
		const item = document.createElement('div')
		item.className = 'alt-greeting-item'
		item.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:flex-start;'

		const textarea = document.createElement('textarea')
		textarea.className = 'alt-greeting-text'
		textarea.style.cssText = 'flex:1;min-height:60px;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:rgba(255,255,255,0.5);color:#1a1a1a;font-size:13px;resize:vertical;box-sizing:border-box;'
		textarea.placeholder = t('chars.edit.altGreetings.placeholder', { index: index + 1 })
		textarea.value = text || ''
		item.appendChild(textarea)

		const deleteBtn = document.createElement('button')
		deleteBtn.type = 'button'
		deleteBtn.textContent = '✕'
		deleteBtn.style.cssText = 'padding:4px 8px;border:1px solid #e53e3e;background:transparent;color:#e53e3e;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;margin-top:4px;'
		deleteBtn.addEventListener('click', () => {
			item.remove()
			updateAltIndices()
		})
		item.appendChild(deleteBtn)

		return item
	}

	function updateAltIndices() {
		const items = altGreetingsContainer.querySelectorAll('.alt-greeting-text')
		items.forEach((ta, i) => { ta.placeholder = t('chars.edit.altGreetings.placeholder', { index: i + 1 }) })
	}

	// 填充已有数据
	existingAlts.forEach((text, i) => {
		altGreetingsContainer.appendChild(createAltGreetingItem(text, i))
	})

	// 添加按钮
	addGreetingBtn.addEventListener('click', () => {
		const count = altGreetingsContainer.querySelectorAll('.alt-greeting-item').length
		altGreetingsContainer.appendChild(createAltGreetingItem('', count))
	})

	// 头像上传
	const avatarBtn = dialog.querySelector('#char-edit-avatar-btn')
	const avatarInput = dialog.querySelector('#char-edit-avatar-input')
	const avatarPreview = dialog.querySelector('#char-edit-avatar-preview')

	avatarBtn.addEventListener('click', () => avatarInput.click())
	avatarInput.addEventListener('change', (e) => {
		const file = e.target.files?.[0]
		if (!file) return
		newAvatarFile = file
		const reader = new FileReader()
		reader.onload = (ev) => {
			avatarPreview.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover;" />`
		}
		reader.readAsDataURL(file)
	})

	// 取消
	dialog.querySelector('#char-edit-cancel').addEventListener('click', () => {
		document.body.removeChild(overlay)
	})
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) document.body.removeChild(overlay)
	})

	// 保存
	dialog.querySelector('#char-edit-save').addEventListener('click', async () => {
		const statusEl = dialog.querySelector('#char-edit-status')
		statusEl.textContent = t('chars.edit.saving')
		statusEl.style.color = 'var(--beilu-amber)'

		try {
			// 使用 FormData 支持同时上传文件和JSON数据
			const formData = new FormData()
			
			// 文本字段
			const greeting = dialog.querySelector('#char-edit-greeting').value
			const desc = dialog.querySelector('#char-edit-desc').value
			const personality = dialog.querySelector('#char-edit-personality').value
			const notes = dialog.querySelector('#char-edit-notes').value

			formData.append('first_mes', greeting)
			formData.append('description', desc)
			formData.append('personality', personality)
			formData.append('creator_notes', notes)

			// 收集备选开场白
			const altTextareas = dialog.querySelectorAll('#char-edit-alt-greetings .alt-greeting-text')
			const altGreetings = Array.from(altTextareas).map(ta => ta.value).filter(v => v.trim() !== '')
			formData.append('alternate_greetings', JSON.stringify(altGreetings))

			if (newAvatarFile) {
				formData.append('avatar', newAvatarFile)
			}

			// 使用 PUT 请求
			// 注意：express-fileupload 需要 multipart，但 PUT + FormData 应该可以
			// 但后端是用 req.body 解析 JSON 的，FormData 的文本字段会在 req.body 中
			const res = await fetch(`/api/parts/shells:beilu-home/update-char/${encodeURIComponent(charKey)}`, {
				method: 'PUT',
				body: formData,
			})

			if (res.ok) {
				statusEl.textContent = t('chars.edit.saved')
				statusEl.style.color = '#22c55e'
				setTimeout(() => {
					document.body.removeChild(overlay)
					loadChars() // 刷新列表
				}, 800)
			} else {
				const err = await res.json().catch(() => ({}))
				statusEl.textContent = '❌ ' + (err.message || '保存失败')
				statusEl.style.color = 'oklch(var(--er))'
			}
		} catch (err) {
			statusEl.textContent = '❌ ' + err.message
			statusEl.style.color = 'oklch(var(--er))'
		}
	})
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ===== 初始化 =====
export async function init() {
	console.log('[beilu-home] 初始化"使用"选项卡')
	setupToolbarImport()
	setupCreateChar()
	await loadChars()
}
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
	const parts = [`角色卡「${charName}」导入成功！`]
	if (totalRegex > 0) parts.push(`📝 自动导入 ${totalRegex} 条正则脚本`)
	if (totalWorldbook > 0) parts.push(`📖 自动导入 ${totalWorldbook} 条世界书条目`)
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
			<h3 style="margin:0 0 12px;font-size:16px;">删除角色卡「${displayName}」</h3>
			<p style="margin:0 0 16px;font-size:13px;color:#aaa;">角色卡将被移至回收站。<br>绑定的正则脚本将自动删除。<br>请选择是否同时清理以下关联数据：</p>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-chats" checked style="width:16px;height:16px;"> 删除聊天记录
			</label>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-memory" checked style="width:16px;height:16px;"> 删除记忆数据
			</label>
			<label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;font-size:14px;">
				<input type="checkbox" id="del-worldbook" checked style="width:16px;height:16px;"> 删除绑定的世界书
			</label>
			<div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
				<button id="del-cancel" style="padding:8px 20px;border:1px solid #555;background:transparent;color:#ccc;border-radius:6px;cursor:pointer;font-size:14px;">取消</button>
				<button id="del-confirm" style="padding:8px 20px;border:none;background:#e53e3e;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">确认删除</button>
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
	if (minutes < 1) return '刚刚'
	if (minutes < 60) return `${minutes}分钟前`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}小时前`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}天前`
	const months = Math.floor(days / 30)
	return `${months}个月前`
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
		// avatar 可能是 base64 或 URL
		if (details.avatar.startsWith('data:') || details.avatar.startsWith('http')) {
			return details.avatar
		}
		// 可能是相对路径
		return `/api/parts/res/chars/${key}/${details.avatar}`
	}
	return null
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

	// 删除按钮
	const deleteBtn = document.createElement('button')
	deleteBtn.className = 'beilu-char-delete-btn'
	deleteBtn.textContent = '×'
	deleteBtn.title = '删除角色卡'
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
	label.textContent = '导入角色卡'
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
			p.textContent = '还没有角色卡'
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
		const name = prompt('请输入新角色名称：')
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

// ===== 初始化 =====
export async function init() {
	console.log('[beilu-home] 初始化"使用"选项卡')
	setupToolbarImport()
	setupCreateChar()
	await loadChars()
}
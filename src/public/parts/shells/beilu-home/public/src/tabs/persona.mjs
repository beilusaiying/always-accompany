/**
 * persona.mjs — 用户人设管理模块
 *
 * 职责：
 * - 多人设列表展示（从 Fount getPartList('personas') 获取）
 * - 新建 / 编辑 / 删除人设（通过 beilu-home 后端路由）
 * - 搜索过滤
 */

import { getAllCachedPartDetails } from '/scripts/parts.mjs'

// ===== DOM 引用 =====
const loadingEl = document.getElementById('persona-loading')
const listEl = document.getElementById('persona-list')
const emptyEl = document.getElementById('persona-empty')
const searchInput = document.getElementById('persona-search')
const createBtn = document.getElementById('persona-create-btn')
const dialog = document.getElementById('persona-edit-dialog')
const dialogTitle = document.getElementById('persona-dialog-title')
const dialogName = document.getElementById('persona-edit-name')
const dialogDesc = document.getElementById('persona-edit-desc')
const dialogSave = document.getElementById('persona-dialog-save')
const dialogCancel = document.getElementById('persona-dialog-cancel')
const dialogStatus = document.getElementById('persona-dialog-status')
const dialogAvatar = document.getElementById('persona-edit-avatar')
const avatarPreview = document.getElementById('persona-avatar-preview')
const avatarPlaceholder = document.getElementById('persona-avatar-placeholder')

// ===== 状态 =====
let personas = [] // { name, displayName, description, avatarUrl }[]
let editingName = null // 编辑模式时为人设名称，新建时为 null

// ===== API 调用 =====
const API_BASE = '/api/parts/shells:beilu-home'

async function apiCreatePersona(name, description, avatarFile) {
	const formData = new FormData()
	formData.append('name', name)
	formData.append('description', description)
	if (avatarFile) formData.append('avatar', avatarFile)

	const res = await fetch(`${API_BASE}/create-persona`, {
		method: 'POST',
		body: formData,
	})
	if (!res.ok) {
		const data = await res.json().catch(() => ({}))
		throw new Error(data.message || `创建失败 (${res.status})`)
	}
	return res.json()
}

async function apiUpdatePersona(name, description, avatarFile) {
	const formData = new FormData()
	formData.append('description', description)
	if (avatarFile) formData.append('avatar', avatarFile)

	const res = await fetch(`${API_BASE}/update-persona/${encodeURIComponent(name)}`, {
		method: 'PUT',
		body: formData,
	})
	if (!res.ok) {
		const data = await res.json().catch(() => ({}))
		throw new Error(data.message || `更新失败 (${res.status})`)
	}
	return res.json()
}

async function apiDeletePersona(name) {
	const res = await fetch(`${API_BASE}/delete-persona/${encodeURIComponent(name)}`, {
		method: 'DELETE',
	})
	if (!res.ok) {
		const data = await res.json().catch(() => ({}))
		throw new Error(data.message || `删除失败 (${res.status})`)
	}
	return res.json()
}

// ===== 加载人设列表 =====
async function loadPersonas() {
	loadingEl.style.display = ''
	listEl.style.display = 'none'
	emptyEl.style.display = 'none'

	try {
		const result = await getAllCachedPartDetails('personas')
		const cachedDetails = result?.cachedDetails || {}
		const uncachedNames = result?.uncachedNames || []
		const allNames = [...Object.keys(cachedDetails), ...uncachedNames]

		personas = []
		for (const name of allNames) {
			const details = cachedDetails[name] || null
			const info = details?.info || details || {}
			const desc = info?.description || ''
			const rawName = info?.name
			const displayName = (typeof rawName === 'string' ? rawName : rawName?.['zh-CN'] || rawName?.['en-UK'] || '') || name
			// 头像URL：如果 info.avatar 有值，拼接 /parts/ 静态文件 URL
			const avatar = info?.avatar || ''
			const avatarUrl = avatar ? `/parts/personas:${encodeURIComponent(name)}/${avatar}?t=${Date.now()}` : ''
			personas.push({ name, displayName, description: desc, avatarUrl })
		}

		renderList()
	} catch (err) {
		console.error('[persona] 加载人设列表失败:', err)
		loadingEl.innerHTML = `<p class="text-sm text-error">加载失败: ${err.message}</p>`
	}
}

// ===== 渲染列表 =====
function renderList(filter = '') {
	loadingEl.style.display = 'none'
	const filtered = filter
		? personas.filter(p =>
			p.displayName.toLowerCase().includes(filter.toLowerCase()) ||
			p.description.toLowerCase().includes(filter.toLowerCase())
		)
		: personas

	if (filtered.length === 0) {
		listEl.style.display = 'none'
		emptyEl.style.display = ''
		return
	}

	emptyEl.style.display = 'none'
	listEl.style.display = ''
	listEl.innerHTML = ''

	for (const persona of filtered) {
		const card = document.createElement('div')
		card.className = 'beilu-persona-card'
		const avatarContent = persona.avatarUrl
			? `<img src="${escapeAttr(persona.avatarUrl)}" alt="${escapeAttr(persona.displayName)}" class="w-full h-full object-cover" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
				+ `<span class="text-3xl" style="display:none">👤</span>`
			: `<span class="text-3xl">👤</span>`
		card.innerHTML = `
			<div class="beilu-persona-avatar-area">
				<div class="beilu-persona-avatar">
					${avatarContent}
				</div>
			</div>
			<div class="flex-grow min-w-0">
				<div class="font-medium text-sm truncate">${escapeHtml(persona.displayName)}</div>
				<div class="text-xs text-base-content/50 mt-1 line-clamp-2">${escapeHtml(persona.description) || '<span class="text-base-content/30">暂无描述</span>'}</div>
			</div>
			<div class="flex items-center gap-1 shrink-0">
				<button class="btn btn-xs btn-outline persona-edit-btn" data-name="${escapeAttr(persona.name)}" title="编辑">✏️</button>
				<button class="btn btn-xs btn-outline btn-error persona-delete-btn" data-name="${escapeAttr(persona.name)}" title="删除">🗑️</button>
			</div>
		`
		listEl.appendChild(card)
	}

	// 绑定按钮事件
	listEl.querySelectorAll('.persona-edit-btn').forEach(btn => {
		btn.addEventListener('click', () => openEditDialog(btn.dataset.name))
	})
	listEl.querySelectorAll('.persona-delete-btn').forEach(btn => {
		btn.addEventListener('click', () => handleDelete(btn.dataset.name))
	})
}

// ===== 对话框操作 =====
function resetAvatarPreview(avatarUrl) {
	if (dialogAvatar) dialogAvatar.value = ''
	if (!avatarPreview) return
	if (avatarUrl) {
		avatarPreview.innerHTML = `<img src="${escapeAttr(avatarUrl)}" alt="头像" class="w-full h-full object-cover" onerror="this.style.display='none';this.parentElement.querySelector('.avatar-fallback').style.display=''"><span class="text-2xl avatar-fallback" style="display:none">👤</span>`
	} else {
		avatarPreview.innerHTML = `<span class="text-2xl">👤</span>`
	}
}

function openCreateDialog() {
	editingName = null
	dialogTitle.textContent = '新建人设'
	dialogName.value = ''
	dialogName.disabled = false
	dialogDesc.value = ''
	dialogStatus.textContent = ''
	resetAvatarPreview('')
	dialog.showModal()
}

function openEditDialog(name) {
	const persona = personas.find(p => p.name === name)
	if (!persona) return

	editingName = name
	dialogTitle.textContent = '编辑人设'
	dialogName.value = persona.displayName
	dialogName.disabled = true // 编辑模式不允许改名
	dialogDesc.value = persona.description
	dialogStatus.textContent = ''
	resetAvatarPreview(persona.avatarUrl)
	dialog.showModal()
}

async function handleSave() {
	const name = dialogName.value.trim()
	const description = dialogDesc.value.trim()
	const avatarFile = dialogAvatar?.files?.[0] || null

	if (!name) {
		dialogStatus.textContent = '⚠️ 名称不能为空'
		dialogStatus.style.color = 'oklch(var(--er))'
		return
	}

	dialogSave.disabled = true
	dialogStatus.textContent = '保存中...'
	dialogStatus.style.color = ''

	try {
		if (editingName) {
			// 编辑模式
			await apiUpdatePersona(editingName, description, avatarFile)
			dialogStatus.textContent = '✅ 已更新'
		} else {
			// 新建模式
			await apiCreatePersona(name, description, avatarFile)
			dialogStatus.textContent = '✅ 已创建'
		}

		// 刷新列表（上传了头像需要完整刷新以获取新URL）
		setTimeout(() => {
			dialog.close()
			loadPersonas()
		}, 500)
	} catch (err) {
		dialogStatus.textContent = `❌ ${err.message}`
		dialogStatus.style.color = 'oklch(var(--er))'
	} finally {
		dialogSave.disabled = false
	}
}

async function handleDelete(name) {
	if (!confirm(`确定要删除人设 "${name}" 吗？此操作不可撤销。`)) return

	try {
		await apiDeletePersona(name)
		await loadPersonas()
	} catch (err) {
		alert(`删除失败: ${err.message}`)
	}
}

// ===== 工具函数 =====
function escapeHtml(str) {
	if (!str) return ''
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escapeAttr(str) {
	if (!str) return ''
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ===== 初始化 =====
export async function init() {
	console.log('[persona] 初始化人设管理模块')

	// 搜索
	searchInput.addEventListener('input', () => {
		renderList(searchInput.value)
	})

	// 新建按钮
	createBtn.addEventListener('click', openCreateDialog)

	// 对话框按钮
	dialogSave.addEventListener('click', handleSave)
	dialogCancel.addEventListener('click', () => dialog.close())

	// 头像文件选择：实时预览
	if (dialogAvatar) {
		dialogAvatar.addEventListener('change', () => {
			const file = dialogAvatar.files?.[0]
			if (file && avatarPreview) {
				const reader = new FileReader()
				reader.onload = (e) => {
					avatarPreview.innerHTML = `<img src="${e.target.result}" alt="头像预览" class="w-full h-full object-cover">`
				}
				reader.readAsDataURL(file)
			}
		})
	}

	// 点击头像预览区域触发文件选择
	if (avatarPreview && dialogAvatar) {
		avatarPreview.addEventListener('click', () => dialogAvatar.click())
	}

	// 加载列表
	await loadPersonas()
}
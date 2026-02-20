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

// ===== 状态 =====
let personas = [] // { name, description }[]
let editingName = null // 编辑模式时为人设名称，新建时为 null

// ===== API 调用 =====
const API_BASE = '/api/parts/shells:beilu-home'

async function apiCreatePersona(name, description) {
	const res = await fetch(`${API_BASE}/create-persona`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, description }),
	})
	if (!res.ok) {
		const data = await res.json().catch(() => ({}))
		throw new Error(data.message || `创建失败 (${res.status})`)
	}
	return res.json()
}

async function apiUpdatePersona(name, description) {
	const res = await fetch(`${API_BASE}/update-persona/${encodeURIComponent(name)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ description }),
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
			const desc = details?.description || ''
			const displayName = details?.name || name
			personas.push({ name, displayName, description: desc })
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
		card.innerHTML = `
			<div class="beilu-persona-avatar-area">
				<div class="beilu-persona-avatar">
					<span class="text-3xl">👤</span>
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
function openCreateDialog() {
	editingName = null
	dialogTitle.textContent = '新建人设'
	dialogName.value = ''
	dialogName.disabled = false
	dialogDesc.value = ''
	dialogStatus.textContent = ''
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
	dialog.showModal()
}

async function handleSave() {
	const name = dialogName.value.trim()
	const description = dialogDesc.value.trim()

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
			await apiUpdatePersona(editingName, description)
			dialogStatus.textContent = '✅ 已更新'

			// 直接更新本地数据（避免缓存未刷新导致显示旧值）
			const p = personas.find(p => p.name === editingName)
			if (p) p.description = description
		} else {
			// 新建模式
			await apiCreatePersona(name, description)
			dialogStatus.textContent = '✅ 已创建'
		}

		// 刷新列表
		setTimeout(() => {
			dialog.close()
			if (editingName) {
				// 编辑模式直接用本地数据重渲染
				renderList(searchInput.value)
			} else {
				// 新建模式需要重新加载获取新条目
				loadPersonas()
			}
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

	// 加载列表
	await loadPersonas()
}
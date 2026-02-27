/**
 * beilu-home 预设管理模块
 * "使用"选项卡 → 预设管理子菜单
 *
 * 功能：
 * - 多预设管理（导入/切换/删除）
 * - 条目列表展示 + 开关 + 拖拽排序
 * - 条目详情编辑（content + role/type/depth 字段）
 *
 * 复用 beilu-preset 插件的 config 接口
 */

const PRESET_PARTPATH = 'plugins/beilu-preset'
const REGEX_API_SET = '/api/parts/plugins:beilu-regex/config/setdata'

// ============================================================
// API 通信层
// ============================================================

async function getPluginData(_partpath) {
	const res = await fetch('/api/parts/plugins:beilu-preset/config/getdata')
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.message || err.error || `HTTP ${res.status}`)
	}
	return res.json()
}

async function setPluginData(_partpath, data) {
	const res = await fetch('/api/parts/plugins:beilu-preset/config/setdata', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.message || err.error || `HTTP ${res.status}`)
	}
	return res.json()
}

// ============================================================
// 状态
// ============================================================

let currentEntries = []
let selectedEntryId = null
let currentPresetJson = null
let isEditing = false
/** identifier → 完整 content 映射（从 preset_json.prompts 提取） */
let contentMap = {}
/** 当前预设列表 */
let presetList = []
/** 当前激活预设名 */
let activePreset = ''
// DOM 引用（init 时获取）
let dom = {}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

function showToast(message, type = 'info') {
	const toast = document.createElement('div')
	const cls = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : type === 'warning' ? 'alert-warning' : 'alert-info'
	toast.className = `alert ${cls} fixed top-4 right-4 z-[100] max-w-sm shadow-lg`
	toast.innerHTML = `<span>${escapeHtml(message)}</span>`
	document.body.appendChild(toast)
	setTimeout(() => {
		toast.style.opacity = '0'
		toast.style.transition = 'opacity 0.3s'
		setTimeout(() => toast.remove(), 300)
	}, 3000)
}

// ============================================================
// 数据加载
// ============================================================

async function loadPresetData() {
	try {
		dom.loading.style.display = ''
		dom.mainContent.style.display = 'none'

		const data = await getPluginData(PRESET_PARTPATH)

		// 多预设管理
		presetList = data.preset_list || []
		activePreset = data.active_preset || ''
		updatePresetSelector()

		currentPresetJson = data.preset_json || null
		currentEntries = data.entries || []

		// 从完整 preset_json 构建 identifier → content 映射
		contentMap = {}
		if (currentPresetJson?.prompts) {
			for (const p of currentPresetJson.prompts) {
				if (p.identifier) contentMap[p.identifier] = p.content || ''
			}
		}

		renderEntryList(currentEntries)
		updateStats(currentEntries)

		dom.loading.style.display = 'none'
		dom.mainContent.style.display = ''
	} catch (err) {
		console.error('[beilu-home/preset] 加载预设失败:', err)
		dom.loading.style.display = 'none'
		dom.mainContent.style.display = ''
	}
}

// ============================================================
// 预设选择器
// ============================================================

function updatePresetSelector() {
	const select = dom.presetSelect
	if (!select) return

	select.innerHTML = ''

	if (presetList.length === 0) {
		const opt = document.createElement('option')
		opt.value = ''
		opt.textContent = '未加载 — 请导入预设'
		select.appendChild(opt)
		dom.presetDelete.disabled = true
		return
	}

	presetList.forEach(name => {
		const opt = document.createElement('option')
		opt.value = name
		opt.textContent = name
		if (name === activePreset) opt.selected = true
		select.appendChild(opt)
	})

	// 删除按钮：有预设就可以删除
	dom.presetDelete.disabled = presetList.length === 0
}

async function handleSwitchPreset() {
	const selected = dom.presetSelect.value
	if (!selected || selected === activePreset) return

	try {
		await setPluginData(PRESET_PARTPATH, { switch_preset: { name: selected } })
		showToast(`已切换到预设: ${selected}`, 'success')
		selectedEntryId = null
		dom.detail.style.display = 'none'
		await loadPresetData()
		// 广播资源变更事件
		window.dispatchEvent(new CustomEvent('resource:preset-changed', { detail: { action: 'switch', name: selected } }))
	} catch (err) {
		showToast('切换失败: ' + err.message, 'error')
	}
}

async function handleDeletePreset() {
	const selected = dom.presetSelect.value
	if (!selected) return
	if (!confirm(`确定删除预设 "${selected}" 吗？此操作不可恢复。`)) return

	try {
		await setPluginData(PRESET_PARTPATH, { delete_preset: { name: selected } })
		// 清理该预设在 beilu-regex 中绑定的正则规则
		await removePresetRegexFromPlugin(selected)
		showToast(`预设 "${selected}" 已删除`, 'success')
		selectedEntryId = null
		dom.detail.style.display = 'none'
		await loadPresetData()
		// 广播资源变更事件
		window.dispatchEvent(new CustomEvent('resource:preset-changed', { detail: { action: 'delete', name: selected } }))
	} catch (err) {
		showToast('删除失败: ' + err.message, 'error')
	}
}

// ============================================================
// 渲染
// ============================================================

/** 拖拽状态 */
let draggedId = null

function renderEntryList(entries, filter = '') {
	dom.entryList.innerHTML = ''

	if (!entries || entries.length === 0) {
		dom.entryList.innerHTML = '<p class="text-sm text-base-content/50 text-center py-8">请先导入一个 ST 预设文件</p>'
		return
	}

	const filtered = filter
		? entries.filter(e => e.name?.toLowerCase().includes(filter.toLowerCase()))
		: entries

	if (filtered.length === 0) {
		dom.entryList.innerHTML = '<p class="text-sm text-base-content/50 text-center py-4">无匹配条目</p>'
		return
	}

	filtered.forEach(entry => {
		const item = document.createElement('div')
		item.className = `beilu-preset-entry ${entry.enabled ? '' : 'disabled'} ${entry.identifier === selectedEntryId ? 'selected' : ''}`
		item.dataset.id = entry.identifier
		item.draggable = true

		// v14.3: 类型标签基于 system_prompt + injection_position
		// system_prompt: true → 系统（内置4条）
		// injection_position: 0 → 相对位置（系统区域）
		// injection_position: 1 → 注入 @D{深度}
		const injPos = entry.injection_position ?? 0
		let typeLabel, typeClass
		if (entry.system_prompt) {
			typeLabel = '系统'
			typeClass = 'system'
		} else if (injPos === 1) {
			typeLabel = `D${entry.injection_depth ?? '?'}`
			typeClass = 'inject'
		} else {
			typeLabel = '相对'
			typeClass = 'system'
		}
		const roleBadge = entry.role === 'system' ? '🔧' : entry.role === 'user' ? '👤' : entry.role === 'assistant' ? '🤖' : '📝'

		item.innerHTML = `
			<span class="beilu-preset-entry-drag" title="拖拽排序">⠿</span>
			<input type="checkbox" class="checkbox checkbox-xs checkbox-warning entry-toggle"
				data-id="${entry.identifier}" ${entry.enabled ? 'checked' : ''} />
			<span class="beilu-preset-entry-role">${roleBadge}</span>
			<span class="beilu-preset-entry-name">${escapeHtml(entry.name || '(无名)')}</span>
			<span class="beilu-preset-entry-type ${typeClass}">${typeLabel}</span>
		`

		// 点击选择条目（排除 checkbox 和拖拽手柄）
		item.addEventListener('click', (e) => {
			if (e.target.classList.contains('entry-toggle')) return
			if (e.target.classList.contains('beilu-preset-entry-drag')) return
			selectEntry(entry)
		})

		// 拖拽事件
		item.addEventListener('dragstart', (e) => {
			draggedId = entry.identifier
			item.classList.add('dragging')
			e.dataTransfer.effectAllowed = 'move'
			e.dataTransfer.setData('text/plain', entry.identifier)
		})

		item.addEventListener('dragend', () => {
			draggedId = null
			item.classList.remove('dragging')
			// 清除所有拖拽指示
			dom.entryList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
				el.classList.remove('drag-over-top', 'drag-over-bottom')
			})
		})

		item.addEventListener('dragover', (e) => {
			e.preventDefault()
			e.dataTransfer.dropEffect = 'move'
			if (!draggedId || draggedId === entry.identifier) return

			const rect = item.getBoundingClientRect()
			const midY = rect.top + rect.height / 2
			item.classList.remove('drag-over-top', 'drag-over-bottom')
			if (e.clientY < midY) {
				item.classList.add('drag-over-top')
			} else {
				item.classList.add('drag-over-bottom')
			}
		})

		item.addEventListener('dragleave', () => {
			item.classList.remove('drag-over-top', 'drag-over-bottom')
		})

		item.addEventListener('drop', async (e) => {
			e.preventDefault()
			item.classList.remove('drag-over-top', 'drag-over-bottom')

			if (!draggedId || draggedId === entry.identifier) return

			const rect = item.getBoundingClientRect()
			const midY = rect.top + rect.height / 2
			const insertBefore = e.clientY < midY

			// 重新排列 currentEntries
			const dragIdx = currentEntries.findIndex(e => e.identifier === draggedId)
			if (dragIdx === -1) return

			const [draggedEntry] = currentEntries.splice(dragIdx, 1)
			let targetIdx = currentEntries.findIndex(e => e.identifier === entry.identifier)
			if (!insertBefore) targetIdx++
			currentEntries.splice(targetIdx, 0, draggedEntry)

			// 重新渲染
			renderEntryList(currentEntries, dom.entrySearch?.value || '')

			// 保存新顺序到后端
			const newOrder = currentEntries.map(e => e.identifier)
			try {
				await setPluginData(PRESET_PARTPATH, { reorder_entries: { order: newOrder } })
			} catch (err) {
				showToast('排序保存失败: ' + err.message, 'error')
				await loadPresetData()
			}
		})

		dom.entryList.appendChild(item)
	})

	// 绑定 checkbox
	dom.entryList.querySelectorAll('.entry-toggle').forEach(cb => {
		cb.addEventListener('change', async (e) => {
			e.stopPropagation()
			await toggleEntry(cb.dataset.id, cb.checked)
		})
	})
}

function updateStats(entries) {
	if (!entries || entries.length === 0) {
		dom.stats.style.display = 'none'
		return
	}
	dom.stats.style.display = ''
	dom.statTotal.textContent = entries.length
	dom.statEnabled.textContent = entries.filter(e => e.enabled).length
	// v14.3: 统计基于 injection_position
	// 系统区 = system_prompt:true 或 injection_position:0
	// 注入 = injection_position:1
	dom.statSystem.textContent = entries.filter(e => e.system_prompt || (e.injection_position ?? 0) === 0).length
	dom.statInject.textContent = entries.filter(e => !e.system_prompt && (e.injection_position ?? 0) === 1).length
}

// ============================================================
// 条目操作
// ============================================================

function selectEntry(entry) {
	selectedEntryId = entry.identifier
	exitEditMode()

	// 更新列表高亮
	dom.entryList.querySelectorAll('.beilu-preset-entry').forEach(el => {
		el.classList.toggle('selected', el.dataset.id === entry.identifier)
	})

	// 填充详情
	dom.detailName.value = entry.name || '(无名)'
	dom.detailToggle.checked = entry.enabled

	// 角色选择框
	dom.detailRole.value = entry.role || 'system'

	// 类型选择框 — v14.3: 基于 injection_position
	const injPos = entry.injection_position ?? 0
	if (entry.system_prompt) {
		dom.detailType.value = 'system_prompt'
	} else if (injPos === 1) {
		dom.detailType.value = 'injection'
	} else {
		dom.detailType.value = 'system_prompt'  // 相对位置归入系统区
	}

	// 注入深度：仅 injection_position === 1 时显示
	if (injPos === 1 && !entry.system_prompt) {
		dom.detailDepthRow.style.display = ''
		dom.detailDepth.value = entry.injection_depth ?? 0
	} else {
		dom.detailDepthRow.style.display = 'none'
	}

	// 从 contentMap 获取完整内容
	const fullContent = contentMap[entry.identifier] ?? entry.content_preview ?? ''
	dom.detailContent.value = fullContent
	dom.detail.style.display = ''

	// 删除按钮：非内置 Marker 条目才显示
	if (dom.detailDeleteBtn) {
		dom.detailDeleteBtn.style.display = entry.is_builtin ? 'none' : ''
	}

	// 字段编辑状态
	setFieldsEditable(false)
}

function exitEditMode() {
	isEditing = false
	if (dom.detailContent) {
		dom.detailContent.readOnly = true
		dom.detailContent.classList.remove('textarea-warning')
	}
	setFieldsEditable(false)
	if (dom.detailEditBtn) dom.detailEditBtn.style.display = ''
	if (dom.detailSaveBtn) dom.detailSaveBtn.style.display = 'none'
	if (dom.detailCancelBtn) dom.detailCancelBtn.style.display = 'none'
}

function setFieldsEditable(editable) {
	if (dom.detailName) dom.detailName.readOnly = !editable
	if (dom.detailRole) dom.detailRole.disabled = !editable
	if (dom.detailType) dom.detailType.disabled = !editable
	if (dom.detailDepth) dom.detailDepth.disabled = !editable
}

async function toggleEntry(identifier, enabled) {
	try {
		await setPluginData(PRESET_PARTPATH, { toggle_entry: { identifier, enabled } })
		const entry = currentEntries.find(e => e.identifier === identifier)
		if (entry) entry.enabled = enabled
		renderEntryList(currentEntries, dom.entrySearch?.value || '')
		updateStats(currentEntries)
	} catch (err) {
		showToast('切换失败: ' + err.message, 'error')
		loadPresetData()
	}
}

// ============================================================
// 导入 / 导出
// ============================================================

async function syncPresetRegexToPlugin(presetName, presetJson) {
	const scripts = presetJson?.extensions?.regex_scripts
	if (!scripts || !Array.isArray(scripts) || scripts.length === 0) return
	try {
		await fetch(REGEX_API_SET, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ _action: 'syncPresetRegex', presetName, scripts }),
		})
	} catch (err) {
		console.warn('[beilu-home/preset] 同步预设正则失败:', err)
	}
}

async function removePresetRegexFromPlugin(presetName) {
	try {
		await fetch(REGEX_API_SET, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ _action: 'removeByPreset', presetName }),
		})
	} catch (err) {
		console.warn('[beilu-home/preset] 清理预设正则失败:', err)
	}
}

async function handleImport() {
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = '.json'
	input.addEventListener('change', async (e) => {
		const file = e.target.files?.[0]
		if (!file) return
		try {
			const text = await file.text()
			const json = JSON.parse(text)
			const presetName = file.name.replace(/\.json$/i, '')

			// 首次导入（不强制覆盖）
			const result = await setPluginData(PRESET_PARTPATH, {
				import_preset: { json, name: presetName },
			})

			// 检查重名
			if (result.duplicate) {
				const overwrite = confirm(`预设 "${presetName}" 已存在，是否覆盖？\n选择"取消"将跳过导入。`)
				if (overwrite) {
					await setPluginData(PRESET_PARTPATH, {
						import_preset: { json, name: presetName, force_overwrite: true },
					})
					showToast(`预设 "${presetName}" 已覆盖导入`, 'success')
				} else {
					showToast('导入已取消', 'info')
					return
				}
			} else {
				showToast(`预设 "${file.name}" 导入成功`, 'success')
			}

			// 同步预设中的正则脚本到 beilu-regex 插件
			await syncPresetRegexToPlugin(presetName, json)

			selectedEntryId = null
			dom.detail.style.display = 'none'
			await loadPresetData()
			// 广播资源变更事件
			window.dispatchEvent(new CustomEvent('resource:preset-changed', { detail: { action: 'import', name: presetName } }))
		} catch (err) {
			showToast('导入失败: ' + err.message, 'error')
		}
	})
	input.click()
}

async function handleCreatePreset() {
	const name = prompt('请输入新预设名称：')
	if (!name || !name.trim()) return

	try {
		await setPluginData(PRESET_PARTPATH, {
			create_preset: { name: name.trim() },
		})
		showToast(`预设 "${name.trim()}" 创建成功`, 'success')
		selectedEntryId = null
		dom.detail.style.display = 'none'
		await loadPresetData()
	} catch (err) {
		showToast('创建失败: ' + err.message, 'error')
	}
}

// ============================================================
// 条目新增 / 删除
// ============================================================

async function handleAddEntry() {
	if (!activePreset) {
		showToast('请先导入或创建一个预设', 'warning')
		return
	}

	const name = prompt('请输入新条目名称：')
	if (!name || !name.trim()) return

	// 生成唯一标识符（类似 ST 的 UUID 方式，但简化为时间戳+随机）
	const identifier = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

	try {
		await setPluginData(PRESET_PARTPATH, {
			add_entry: {
				identifier,
				name: name.trim(),
				system_prompt: true,
				role: 'system',
				content: '',
				enabled: true,
				injection_position: 0,
				injection_depth: 4,
				injection_order: 100,
			},
		})
		showToast(`条目 "${name.trim()}" 创建成功`, 'success')
		await loadPresetData()
		// 自动选中新建的条目
		const newEntry = currentEntries.find(e => e.identifier === identifier)
		if (newEntry) selectEntry(newEntry)
	} catch (err) {
		showToast('条目创建失败: ' + err.message, 'error')
	}
}

async function handleDeleteEntry() {
	if (!selectedEntryId) return

	const entry = currentEntries.find(e => e.identifier === selectedEntryId)
	const displayName = entry?.name || selectedEntryId

	// 内置 Marker 不允许删除（后端也有保护，前端双重确认）
	if (entry?.is_builtin) {
		showToast('内置标记条目不允许删除', 'warning')
		return
	}

	if (!confirm(`确定删除条目 "${displayName}" 吗？此操作不可恢复。`)) return

	try {
		await setPluginData(PRESET_PARTPATH, {
			delete_entry: { identifier: selectedEntryId },
		})
		showToast(`条目 "${displayName}" 已删除`, 'success')
		selectedEntryId = null
		dom.detail.style.display = 'none'
		await loadPresetData()
	} catch (err) {
		showToast('删除失败: ' + err.message, 'error')
	}
}

async function handleExport() {
	try {
		const data = await getPluginData(PRESET_PARTPATH)
		const json = data.preset_json
		if (!json) {
			showToast('没有可导出的预设', 'warning')
			return
		}
		const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `${data.preset_name || 'preset'}.json`
		a.click()
		URL.revokeObjectURL(url)
		showToast('预设已导出', 'success')
	} catch (err) {
		showToast('导出失败: ' + err.message, 'error')
	}
}

// ============================================================
// 初始化（由 index.mjs 调用）
// ============================================================

export async function init() {
	dom = {
		loading: document.getElementById('preset-loading'),
		mainContent: document.getElementById('preset-main'),
		presetSelect: document.getElementById('home-preset-select'),
		presetDelete: document.getElementById('home-preset-delete'),
		stats: document.getElementById('home-preset-stats'),
		statTotal: document.getElementById('home-stat-total'),
		statEnabled: document.getElementById('home-stat-enabled'),
		statSystem: document.getElementById('home-stat-system'),
		statInject: document.getElementById('home-stat-inject'),
		entrySearch: document.getElementById('home-entry-search'),
		entryList: document.getElementById('home-entry-list'),
		entryAdd: document.getElementById('home-entry-add'),
		detail: document.getElementById('home-entry-detail'),
		detailName: document.getElementById('home-detail-name'),
		detailToggle: document.getElementById('home-detail-toggle'),
		detailRole: document.getElementById('home-detail-role'),
		detailType: document.getElementById('home-detail-type'),
		detailDepthRow: document.getElementById('home-detail-depth-row'),
		detailDepth: document.getElementById('home-detail-depth'),
		detailContent: document.getElementById('home-detail-content'),
		detailEditBtn: document.getElementById('home-detail-edit-btn'),
		detailSaveBtn: document.getElementById('home-detail-save-btn'),
		detailCancelBtn: document.getElementById('home-detail-cancel-btn'),
		detailDeleteBtn: document.getElementById('home-detail-delete-btn'),
		importBtn: document.getElementById('home-preset-import'),
		exportBtn: document.getElementById('home-preset-export'),
		presetCreate: document.getElementById('home-preset-create'),
	}

	// 事件绑定
	dom.importBtn?.addEventListener('click', handleImport)
	dom.exportBtn?.addEventListener('click', handleExport)
	dom.presetCreate?.addEventListener('click', handleCreatePreset)
	dom.entryAdd?.addEventListener('click', handleAddEntry)
	dom.detailDeleteBtn?.addEventListener('click', handleDeleteEntry)

	// 预设选择器
	dom.presetSelect?.addEventListener('change', handleSwitchPreset)
	dom.presetDelete?.addEventListener('click', handleDeletePreset)

	dom.entrySearch?.addEventListener('input', () => {
		renderEntryList(currentEntries, dom.entrySearch.value)
	})

	dom.detailToggle?.addEventListener('change', async () => {
		if (!selectedEntryId) return
		await toggleEntry(selectedEntryId, dom.detailToggle.checked)
	})

	// 类型切换时联动深度显示
	dom.detailType?.addEventListener('change', () => {
		if (dom.detailType.value === 'system_prompt') {
			dom.detailDepthRow.style.display = 'none'
		} else {
			dom.detailDepthRow.style.display = ''
		}
	})

	dom.detailEditBtn?.addEventListener('click', () => {
		isEditing = true
		dom.detailContent.readOnly = false
		dom.detailContent.classList.add('textarea-warning')
		setFieldsEditable(true)
		dom.detailEditBtn.style.display = 'none'
		dom.detailSaveBtn.style.display = ''
		dom.detailCancelBtn.style.display = ''
	})

	dom.detailCancelBtn?.addEventListener('click', () => {
		exitEditMode()
		// 从 contentMap 恢复完整内容
		const fullContent = contentMap[selectedEntryId] ?? ''
		dom.detailContent.value = fullContent
		// 恢复字段值
		const entry = currentEntries.find(e => e.identifier === selectedEntryId)
		if (entry) selectEntry(entry)
	})

	dom.detailSaveBtn?.addEventListener('click', async () => {
		if (!selectedEntryId) return
		try {
			const updateData = {
				identifier: selectedEntryId,
				content: dom.detailContent.value,
			}

			// 收集字段变更
			const props = {}

			// 名称
			const newName = dom.detailName.value.trim()
			if (newName) props.name = newName

			const newRole = dom.detailRole.value
			if (newRole) props.role = newRole

			const newType = dom.detailType.value
			const isNowSystemPrompt = newType === 'system_prompt'

			// 始终传递 system_prompt 属性（确保类型变更被保存）
			props.system_prompt = isNowSystemPrompt

			// 注入深度：仅注入式条目有效
			if (!isNowSystemPrompt) {
				const depthVal = parseInt(dom.detailDepth.value)
				if (!isNaN(depthVal)) props.injection_depth = depthVal
			}

			if (Object.keys(props).length > 0) {
				updateData.props = props
			}

			await setPluginData(PRESET_PARTPATH, { update_entry: updateData })
			// 同步更新 contentMap
			contentMap[selectedEntryId] = dom.detailContent.value
			exitEditMode()
			showToast('条目已保存', 'success')
			// 重新加载以刷新条目列表中的标签
			await loadPresetData()
		} catch (err) {
			showToast('保存失败: ' + err.message, 'error')
		}
	})

	// 加载数据
	await loadPresetData()
}
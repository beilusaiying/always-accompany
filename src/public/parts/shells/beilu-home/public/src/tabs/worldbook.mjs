/**
 * "世界书"子模块 — 世界书条目管理
 *
 * 职责：
 * - 与 beilu-worldbook 插件后端通信（CRUD）
 * - 渲染世界书条目列表（comment + keys 摘要）
 * - 双栏编辑器：左栏列表 + 右栏详情
 * - 导入/导出 ST 世界书 JSON
 * - 新建/删除/切换世界书
 */

// ===== API =====

const API_GET = '/api/parts/plugins:beilu-worldbook/config/getdata'
const API_SET = '/api/parts/plugins:beilu-worldbook/config/setdata'

async function apiGet() {
	const res = await fetch(API_GET)
	if (!res.ok) throw new Error(`GET failed: ${res.status}`)
	return res.json()
}

async function apiSet(data) {
	const res = await fetch(API_SET, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) throw new Error(`SET failed: ${res.status}`)
	return res.json()
}

// ===== DOM 引用 =====

const dom = {
	loading: () => document.getElementById('wb-loading'),
	main: () => document.getElementById('wb-main'),
	select: () => document.getElementById('wb-select'),
	deleteBtn: () => document.getElementById('wb-delete'),
	importBtn: () => document.getElementById('wb-import'),
	exportBtn: () => document.getElementById('wb-export'),
	createBtn: () => document.getElementById('wb-create'),
	stats: () => document.getElementById('wb-stats'),
	statTotal: () => document.getElementById('wb-stat-total'),
	statEnabled: () => document.getElementById('wb-stat-enabled'),
	statConstant: () => document.getElementById('wb-stat-constant'),
	statKeyword: () => document.getElementById('wb-stat-keyword'),
	entrySearch: () => document.getElementById('wb-entry-search'),
	addEntryBtn: () => document.getElementById('wb-add-entry'),
	entryList: () => document.getElementById('wb-entry-list'),
	detail: () => document.getElementById('wb-entry-detail'),
	detailComment: () => document.getElementById('wb-detail-comment'),
	detailToggle: () => document.getElementById('wb-detail-toggle'),
	detailKeys: () => document.getElementById('wb-detail-keys'),
	detailKeys2: () => document.getElementById('wb-detail-keys2'),
	detailExcludeRecursion: () => document.getElementById('wb-detail-exclude-recursion'),
	detailPreventRecursion: () => document.getElementById('wb-detail-prevent-recursion'),
	detailLogic: () => document.getElementById('wb-detail-logic'),
	detailPosition: () => document.getElementById('wb-detail-position'),
	detailDepth: () => document.getElementById('wb-detail-depth'),
	detailDepthGroup: () => document.getElementById('wb-depth-group'),
	detailRoleGroup: () => document.getElementById('wb-role-group'),
	detailOrder: () => document.getElementById('wb-detail-order'),
	detailRole: () => document.getElementById('wb-detail-role'),
	detailContent: () => document.getElementById('wb-detail-content'),
	detailDeleteBtn: () => document.getElementById('wb-detail-delete-btn'),
	detailEditBtn: () => document.getElementById('wb-detail-edit-btn'),
	detailSaveBtn: () => document.getElementById('wb-detail-save-btn'),
	detailCancelBtn: () => document.getElementById('wb-detail-cancel-btn'),
	// 激活模式
	modeConstant: () => document.getElementById('wb-mode-constant'),
	modeRegex: () => document.getElementById('wb-mode-regex'),
	modeDynamic: () => document.getElementById('wb-mode-dynamic'),
	regexOptions: () => document.getElementById('wb-regex-options'),
	dynamicConfig: () => document.getElementById('wb-dynamic-config'),
	dynColumn: () => document.getElementById('wb-dyn-column'),
	dynMatchType: () => document.getElementById('wb-dyn-match-type'),
	dynRangeMin: () => document.getElementById('wb-dyn-range-min'),
	dynRangeMax: () => document.getElementById('wb-dyn-range-max'),
	dynRangeFields: () => document.getElementById('wb-dyn-range-fields'),
	dynExactFields: () => document.getElementById('wb-dyn-exact-fields'),
	dynExactValue: () => document.getElementById('wb-dyn-exact-value'),
}

// ===== 状态 =====

let currentData = null       // 从后端获取的完整数据
let selectedUid = null        // 当前选中的条目 uid
let isEditing = false         // 是否在编辑模式

// ===== 数据加载 =====

async function loadData(retries = 3) {
	for (let i = 0; i < retries; i++) {
		try {
			currentData = await apiGet()
			return // 成功则直接返回
		} catch (err) {
			console.warn(`[worldbook] 加载数据失败 (${i + 1}/${retries}):`, err.message || err)
			if (i < retries - 1) {
				// 等待后重试（插件可能还未加载完成）
				await new Promise(r => setTimeout(r, 2000 * (i + 1)))
			}
		}
	}
	// 所有重试失败，使用空数据
	currentData = { active_worldbook: '', worldbook_list: [], entries: [], entry_count: 0 }
}

// ===== 渲染 =====

function renderSelect() {
	const sel = dom.select()
	if (!sel || !currentData) return

	sel.innerHTML = ''

	if (currentData.worldbook_list.length === 0) {
		sel.innerHTML = '<option value="">未加载</option>'
		dom.deleteBtn().disabled = true
		return
	}

	for (const name of currentData.worldbook_list) {
		const opt = document.createElement('option')
		opt.value = name
		opt.textContent = name
		if (name === currentData.active_worldbook) opt.selected = true
		sel.appendChild(opt)
	}

	// 有世界书就可以删除
	dom.deleteBtn().disabled = false
}

function renderStats() {
	const statsEl = dom.stats()
	if (!currentData || !currentData.entries || currentData.entries.length === 0) {
		if (statsEl) statsEl.style.display = 'none'
		return
	}

	const entries = currentData.entries
	const total = entries.length
	const enabled = entries.filter(e => !e.disable).length
	const constant = entries.filter(e => (e.activationMode === 'constant' || (!e.activationMode && e.constant)) && !e.disable).length
	const keyword = entries.filter(e => {
		const mode = e.activationMode || (e.constant ? 'constant' : 'regex')
		return mode === 'regex' && !e.disable
	}).length

	dom.statTotal().textContent = total
	dom.statEnabled().textContent = enabled
	dom.statConstant().textContent = constant
	dom.statKeyword().textContent = keyword
	statsEl.style.display = ''
}

/**
 * 按注入位置分组渲染条目列表
 * 分3组：📌角色之前(position=0) / 📎角色之后(position=1) / 📍@深度(position=4)
 * 组内按 order 升序排列
 */
function renderEntryList(filter = '') {
	const listEl = dom.entryList()
	if (!listEl || !currentData) return

	const entries = currentData.entries || []

	if (entries.length === 0) {
		listEl.innerHTML = '<p class="text-sm text-base-content/50 text-center py-8">请先导入一个 ST 世界书文件</p>'
		return
	}

	// 过滤
	const lowerFilter = filter.toLowerCase()
	const filtered = lowerFilter
		? entries.filter(e => {
			const comment = (e.comment || '').toLowerCase()
			const keys = (e.key || []).join(',').toLowerCase()
			const content = (e.content || '').toLowerCase()
			return comment.includes(lowerFilter) || keys.includes(lowerFilter) || content.includes(lowerFilter)
		})
		: entries

	// 按注入位置分组
	const groups = [
		{ key: 0, icon: '📌', label: '角色描述前', entries: [] },
		{ key: 1, icon: '📎', label: '角色描述后', entries: [] },
		{ key: 4, icon: '📍', label: '聊天记录中 (@depth)', entries: [] },
	]

	for (const entry of filtered) {
		const pos = entry.position ?? 0
		const group = groups.find(g => g.key === pos) || groups[0]
		group.entries.push(entry)
	}

	// 组内按 order 升序
	for (const group of groups) {
		group.entries.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
	}

	listEl.innerHTML = ''

	for (const group of groups) {
		if (group.entries.length === 0) continue

		// 分组标题
		const header = document.createElement('div')
		header.className = 'wb-group-header'
		header.innerHTML = `<span class="wb-group-icon">${group.icon}</span> ${group.label} <span class="wb-group-count">(${group.entries.length})</span>`
		listEl.appendChild(header)

		// 组内条目
		for (const entry of group.entries) {
			const item = document.createElement('div')
			item.className = 'beilu-preset-entry-item'
			if (entry.uid === selectedUid) item.classList.add('selected')
			if (entry.disable) item.classList.add('opacity-40')

			// 标题行
			const titleRow = document.createElement('div')
			titleRow.className = 'flex items-center gap-1'

			// 激活模式 badge
			const mode = entry.activationMode || (entry.constant ? 'constant' : 'regex')
			const modeBadge = document.createElement('span')
			modeBadge.className = 'wb-mode-badge'
			if (mode === 'constant') {
				modeBadge.classList.add('mode-constant')
				modeBadge.textContent = '常驻'
			} else if (mode === 'dynamic') {
				modeBadge.classList.add('mode-dynamic')
				modeBadge.textContent = '动态'
			} else {
				modeBadge.classList.add('mode-regex')
				modeBadge.textContent = '正则'
			}
			titleRow.appendChild(modeBadge)

			// @depth 位置标记
			if ((entry.position ?? 0) === 4) {
				const depthBadge = document.createElement('span')
				depthBadge.className = 'badge badge-xs badge-info badge-outline'
				depthBadge.textContent = `D${entry.depth ?? 4}`
				titleRow.appendChild(depthBadge)
			}

			const titleSpan = document.createElement('span')
			titleSpan.className = 'text-sm font-medium truncate flex-grow'
			titleSpan.textContent = entry.comment || `条目 #${entry.uid}`
			titleRow.appendChild(titleSpan)

			// 启用/禁用指示
			const statusDot = document.createElement('span')
			statusDot.className = `w-2 h-2 rounded-full shrink-0 ${entry.disable ? 'bg-base-content/20' : 'bg-success'}`
			titleRow.appendChild(statusDot)

			item.appendChild(titleRow)

			// 关键词摘要（仅正则模式显示）
			if (mode === 'regex' && entry.key && entry.key.length > 0) {
				const keysDiv = document.createElement('div')
				keysDiv.className = 'text-xs text-base-content/40 truncate mt-0.5'
				keysDiv.textContent = entry.key.join(', ')
				item.appendChild(keysDiv)
			}
			// 动态条件摘要
			if (mode === 'dynamic' && entry.dynamicConfig?.columnName) {
				const dynDiv = document.createElement('div')
				dynDiv.className = 'text-xs text-base-content/40 truncate mt-0.5'
				const cfg = entry.dynamicConfig
				if (cfg.matchType === 'exact') {
					dynDiv.textContent = `📊 ${cfg.columnName} = "${cfg.exactValue}"`
				} else {
					dynDiv.textContent = `📊 ${cfg.columnName} ∈ [${cfg.rangeMin}, ${cfg.rangeMax}]`
				}
				item.appendChild(dynDiv)
			}

			// 点击选中
			item.addEventListener('click', () => {
				if (isEditing) {
					if (!confirm('有未保存的修改，是否放弃？')) return
					exitEditMode()
				}
				selectedUid = entry.uid
				renderEntryList(dom.entrySearch()?.value || '')
				renderDetail(entry)
			})

			listEl.appendChild(item)
		}
	}
}

function renderDetail(entry) {
	const detailEl = dom.detail()
	if (!detailEl) return

	if (!entry) {
		detailEl.style.display = 'none'
		return
	}

	detailEl.style.display = ''

	// 填充字段
	dom.detailComment().value = entry.comment || ''
	dom.detailToggle().checked = !entry.disable
	dom.detailKeys().value = (entry.key || []).join(', ')
	dom.detailKeys2().value = (entry.keysecondary || []).join(', ')
	dom.detailExcludeRecursion().checked = !!entry.excludeRecursion
	dom.detailPreventRecursion().checked = !!entry.preventRecursion
	dom.detailLogic().value = String(entry.selectiveLogic ?? 0)
	dom.detailPosition().value = String(entry.position ?? 0)
	dom.detailDepth().value = entry.depth ?? 4
	dom.detailOrder().value = entry.order ?? 100
	dom.detailRole().value = entry.role != null ? String(entry.role) : '0'
	dom.detailContent().value = entry.content || ''

	// 激活模式
	const mode = entry.activationMode || (entry.constant ? 'constant' : 'regex')
	const modeRadio = document.querySelector(`input[name="wb-activation-mode"][value="${mode}"]`)
	if (modeRadio) modeRadio.checked = true
	updateActivationModeVisibility(mode)

	// 动态配置
	const dynCfg = entry.dynamicConfig || {}
	const dynCol = dom.dynColumn()
	if (dynCol) dynCol.value = dynCfg.columnName || ''
	const dynMT = dom.dynMatchType()
	if (dynMT) dynMT.value = dynCfg.matchType || 'range'
	const dynRMin = dom.dynRangeMin()
	if (dynRMin) dynRMin.value = dynCfg.rangeMin ?? 0
	const dynRMax = dom.dynRangeMax()
	if (dynRMax) dynRMax.value = dynCfg.rangeMax ?? 0
	const dynEV = dom.dynExactValue()
	if (dynEV) dynEV.value = dynCfg.exactValue || ''
	updateDynMatchTypeVisibility()

	// 位置联动：只在 @深度 时显示深度和角色
	updatePositionVisibility()

	// 确保在查看模式
	exitEditMode()
}

/**
 * 根据激活模式更新相关面板的显隐
 */
function updateActivationModeVisibility(mode) {
	const regexOpts = dom.regexOptions()
	const dynConfig = dom.dynamicConfig()
	const keysEl = dom.detailKeys()
	const keys2El = dom.detailKeys2()
	const keysSection = keysEl?.closest('.form-control')
	const keys2Section = keys2El?.closest('.form-control')

	if (mode === 'constant') {
		// 常驻：隐藏关键词、正则选项、动态配置
		if (regexOpts) regexOpts.style.display = 'none'
		if (dynConfig) dynConfig.style.display = 'none'
		if (keysSection) keysSection.style.display = 'none'
		if (keys2Section) keys2Section.style.display = 'none'
	} else if (mode === 'dynamic') {
		// 动态：隐藏关键词和正则选项，显示动态配置
		if (regexOpts) regexOpts.style.display = 'none'
		if (dynConfig) dynConfig.style.display = ''
		if (keysSection) keysSection.style.display = 'none'
		if (keys2Section) keys2Section.style.display = 'none'
	} else {
		// 正则：显示关键词和正则选项，隐藏动态配置
		if (regexOpts) regexOpts.style.display = ''
		if (dynConfig) dynConfig.style.display = 'none'
		if (keysSection) keysSection.style.display = ''
		if (keys2Section) keys2Section.style.display = ''
	}
}

/**
 * 根据动态匹配类型更新范围/精确字段显隐
 */
function updateDynMatchTypeVisibility() {
	const matchType = dom.dynMatchType()?.value
	const rangeFields = dom.dynRangeFields()
	const exactFields = dom.dynExactFields()
	if (matchType === 'exact') {
		if (rangeFields) rangeFields.style.display = 'none'
		if (exactFields) exactFields.style.display = ''
	} else {
		if (rangeFields) rangeFields.style.display = ''
		if (exactFields) exactFields.style.display = 'none'
	}
}

/**
 * 根据位置选择更新深度和角色字段的显示
 */
function updatePositionVisibility() {
	const posVal = dom.detailPosition()?.value
	const isAtDepth = posVal === '4'
	const depthGroup = dom.detailDepthGroup()
	const roleGroup = dom.detailRoleGroup()
	if (depthGroup) depthGroup.style.display = isAtDepth ? '' : 'none'
	if (roleGroup) roleGroup.style.display = isAtDepth ? '' : 'none'
}

// ===== 编辑模式 =====

function enterEditMode() {
	isEditing = true
	const fields = [
		dom.detailComment(), dom.detailKeys(), dom.detailKeys2(),
		dom.detailContent(),
	]
	fields.forEach(f => { if (f) f.removeAttribute('readonly') })

	const controls = [
		dom.detailExcludeRecursion(), dom.detailPreventRecursion(),
		dom.detailLogic(), dom.detailPosition(), dom.detailDepth(), dom.detailOrder(), dom.detailRole(),
		// 激活模式 radio
		dom.modeConstant(), dom.modeRegex(), dom.modeDynamic(),
		// 动态配置
		dom.dynColumn(), dom.dynMatchType(), dom.dynRangeMin(), dom.dynRangeMax(), dom.dynExactValue(),
	]
	controls.forEach(f => { if (f) f.removeAttribute('disabled') })

	dom.detailEditBtn().style.display = 'none'
	dom.detailSaveBtn().style.display = ''
	dom.detailCancelBtn().style.display = ''
	dom.detailDeleteBtn().style.display = ''
}

function exitEditMode() {
	isEditing = false
	const fields = [
		dom.detailComment(), dom.detailKeys(), dom.detailKeys2(),
		dom.detailContent(),
	]
	fields.forEach(f => { if (f) f.setAttribute('readonly', '') })

	const controls = [
		dom.detailExcludeRecursion(), dom.detailPreventRecursion(),
		dom.detailLogic(), dom.detailPosition(), dom.detailDepth(), dom.detailOrder(), dom.detailRole(),
		// 激活模式 radio
		dom.modeConstant(), dom.modeRegex(), dom.modeDynamic(),
		// 动态配置
		dom.dynColumn(), dom.dynMatchType(), dom.dynRangeMin(), dom.dynRangeMax(), dom.dynExactValue(),
	]
	controls.forEach(f => { if (f) f.setAttribute('disabled', '') })

	dom.detailEditBtn().style.display = ''
	dom.detailSaveBtn().style.display = 'none'
	dom.detailCancelBtn().style.display = 'none'
	// 删除按钮在查看模式也保持可见（选中条目时）
	dom.detailDeleteBtn().style.display = ''
}

// ===== 事件处理 =====

async function handleSave() {
	if (selectedUid == null) return

	const keysStr = dom.detailKeys().value
	const keys2Str = dom.detailKeys2().value
	const posVal = parseInt(dom.detailPosition().value) || 0
	const roleVal = dom.detailRole().value

	// 获取选中的激活模式
	const selectedMode = document.querySelector('input[name="wb-activation-mode"]:checked')?.value || 'regex'

	const props = {
		comment: dom.detailComment().value,
		key: keysStr ? keysStr.split(',').map(k => k.trim()).filter(Boolean) : [],
		keysecondary: keys2Str ? keys2Str.split(',').map(k => k.trim()).filter(Boolean) : [],
		content: dom.detailContent().value,
		constant: selectedMode === 'constant', // 保持向后兼容
		activationMode: selectedMode,
		selective: true,
		excludeRecursion: dom.detailExcludeRecursion().checked,
		preventRecursion: dom.detailPreventRecursion().checked,
		selectiveLogic: parseInt(dom.detailLogic().value) || 0,
		position: posVal,
		depth: posVal === 4 ? (parseInt(dom.detailDepth().value) ?? 4) : 4,
		order: parseInt(dom.detailOrder().value) || 100,
		role: posVal === 4 ? (parseInt(roleVal) ?? 0) : null,
		// 动态配置
		dynamicConfig: {
			columnName: dom.dynColumn()?.value || '',
			matchType: dom.dynMatchType()?.value || 'range',
			rangeMin: parseFloat(dom.dynRangeMin()?.value) || 0,
			rangeMax: parseFloat(dom.dynRangeMax()?.value) || 0,
			exactValue: dom.dynExactValue()?.value || '',
		},
	}

	try {
		await apiSet({ update_entry: { uid: selectedUid, props } })
		await loadData()
		renderStats()
		renderEntryList(dom.entrySearch()?.value || '')
		// 重新填充详情
		const updated = (currentData.entries || []).find(e => e.uid === selectedUid)
		if (updated) renderDetail(updated)
		exitEditMode()
	} catch (err) {
		alert('保存失败: ' + err.message)
	}
}

async function handleToggle() {
	if (selectedUid == null) return
	const disabled = !dom.detailToggle().checked
	try {
		await apiSet({ toggle_entry: { uid: selectedUid, disabled } })
		await loadData()
		renderStats()
		renderEntryList(dom.entrySearch()?.value || '')
	} catch (err) {
		console.error('[worldbook] toggle failed:', err)
	}
}

async function handleDeleteEntry() {
	if (selectedUid == null) return
	const entry = (currentData.entries || []).find(e => e.uid === selectedUid)
	const name = entry?.comment || `条目 #${selectedUid}`
	if (!confirm(`确定要删除条目 "${name}" 吗？`)) return

	try {
		await apiSet({ delete_entry: { uid: selectedUid } })
		selectedUid = null
		dom.detail().style.display = 'none'
		await loadData()
		renderStats()
		renderEntryList(dom.entrySearch()?.value || '')
		exitEditMode()
	} catch (err) {
		alert('删除失败: ' + err.message)
	}
}

async function handleAddEntry() {
	if (!currentData?.active_worldbook) {
		alert('请先创建或导入一个世界书')
		return
	}
	try {
		await apiSet({ add_entry: { props: { comment: '新条目' } } })
		await loadData()
		renderStats()
		// 选中新条目（最后一个）
		const entries = currentData.entries || []
		if (entries.length > 0) {
			const newest = entries[entries.length - 1]
			selectedUid = newest.uid
			renderEntryList(dom.entrySearch()?.value || '')
			renderDetail(newest)
		}
	} catch (err) {
		alert('新增失败: ' + err.message)
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

			// 验证格式
			if (!json.entries) {
				alert('无效的世界书格式：缺少 entries 字段')
				return
			}

			const name = file.name.replace(/\.json$/i, '')
			await apiSet({ import_worldbook: { json, name } })
			await loadData()
			selectedUid = null
			dom.detail().style.display = 'none'
			renderSelect()
			renderStats()
			renderEntryList('')
			console.log(`[worldbook] 世界书导入成功: "${name}"`)
		} catch (err) {
			alert('导入失败: ' + err.message)
		}
	})
	input.click()
}

async function handleExport() {
	if (!currentData?.active_worldbook || !currentData.entries) {
		alert('没有可导出的世界书')
		return
	}

	// 重建 ST 格式
	const exportData = { entries: {} }
	for (const entry of currentData.entries) {
		exportData.entries[String(entry.uid)] = entry
	}

	const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = `${currentData.active_worldbook}.json`
	a.click()
	URL.revokeObjectURL(url)
}

async function handleCreate() {
	const name = prompt('请输入新世界书名称：')
	if (!name?.trim()) return

	try {
		await apiSet({ create_worldbook: { name: name.trim() } })
		await loadData()
		renderSelect()
		renderStats()
		renderEntryList('')
	} catch (err) {
		alert('创建失败: ' + err.message)
	}
}

async function handleDelete() {
	const sel = dom.select()
	const name = sel.value
	if (!name) return

	if (!confirm(`确定要删除世界书 "${name}" 吗？`)) return

	try {
		await apiSet({ delete_worldbook: { name } })
		selectedUid = null
		dom.detail().style.display = 'none'
		await loadData()
		renderSelect()
		renderStats()
		renderEntryList('')
	} catch (err) {
		alert('删除失败: ' + err.message)
	}
}

async function handleSwitch() {
	const sel = dom.select()
	const name = sel.value
	if (!name || name === currentData.active_worldbook) return

	try {
		await apiSet({ switch_worldbook: { name } })
		selectedUid = null
		dom.detail().style.display = 'none'
		await loadData()
		renderSelect()
		renderStats()
		renderEntryList('')
	} catch (err) {
		alert('切换失败: ' + err.message)
	}
}

// ===== 位置字段联动 =====

function handlePositionChange() {
	updatePositionVisibility()
}

// ===== 初始化 =====

export async function init() {
	console.log('[worldbook] 初始化世界书模块')

	await loadData()

	// 隐藏 loading，显示主界面
	const loadingEl = dom.loading()
	const mainEl = dom.main()
	if (loadingEl) loadingEl.style.display = 'none'
	if (mainEl) mainEl.style.display = ''

	renderSelect()
	renderStats()
	renderEntryList('')

	// 绑定事件
	dom.select()?.addEventListener('change', handleSwitch)
	dom.deleteBtn()?.addEventListener('click', handleDelete)
	dom.importBtn()?.addEventListener('click', handleImport)
	dom.exportBtn()?.addEventListener('click', handleExport)
	dom.createBtn()?.addEventListener('click', handleCreate)
	dom.addEntryBtn()?.addEventListener('click', handleAddEntry)

	dom.entrySearch()?.addEventListener('input', (e) => {
		renderEntryList(e.target.value)
	})

	dom.detailEditBtn()?.addEventListener('click', enterEditMode)
	dom.detailSaveBtn()?.addEventListener('click', handleSave)
	dom.detailCancelBtn()?.addEventListener('click', () => {
		const entry = (currentData?.entries || []).find(e => e.uid === selectedUid)
		if (entry) renderDetail(entry)
		exitEditMode()
	})
	dom.detailToggle()?.addEventListener('change', handleToggle)
	dom.detailDeleteBtn()?.addEventListener('click', handleDeleteEntry)
	dom.detailPosition()?.addEventListener('change', handlePositionChange)

	// 激活模式 radio 切换
	document.querySelectorAll('input[name="wb-activation-mode"]').forEach(radio => {
		radio.addEventListener('change', () => {
			const selectedMode = document.querySelector('input[name="wb-activation-mode"]:checked')?.value || 'regex'
			updateActivationModeVisibility(selectedMode)
		})
	})

	// 动态匹配类型切换
	dom.dynMatchType()?.addEventListener('change', () => {
		updateDynMatchTypeVisibility()
	})
}
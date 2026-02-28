/**
 * memoryManage.mjs — 记忆管理 Tab（增强版）
 *
 * 职责：
 * - 角色卡选择器（从 parts 系统获取角色卡列表）
 * - 表格标签页 #0-#9（或更多）
 * - 表格网格渲染（列头可编辑 + 数据行）
 * - 单元格单击内联编辑
 * - 列头可编辑（点击修改列名，可增删列）
 * - 表格名称可双击编辑
 * - 规则可点击编辑（insert/update/delete）
 * - 表格启用/禁用 toggle（禁用后不注入AI）
 * - 行增删 + 表格新增/删除
 * - 查看 JSON 数据
 * - 保存完整数据到后端（name + columns + rules + enabled + rows）
 */

import { getAllCachedPartDetails } from '/scripts/parts.mjs'

// ===== 状态 =====
let currentUsername = ''
let currentCharId = ''
let tables = []
let currentTableIndex = 0
let isDirty = false
let memoryConfig = null  // 记忆系统配置（archive 阈值等）

// ===== DOM 引用缓存 =====
const dom = {}

function cacheDom() {
	dom.loading = document.getElementById('mm-loading')
	dom.main = document.getElementById('mm-main')
	dom.charSelect = document.getElementById('mm-char-select')
	dom.refreshBtn = document.getElementById('mm-refresh-btn')
	dom.stats = document.getElementById('mm-stats')
	dom.noChar = document.getElementById('mm-no-char')
	dom.editor = document.getElementById('mm-editor')
	dom.tableTabs = document.getElementById('mm-table-tabs')
	dom.tableId = document.getElementById('mm-table-id')
	dom.tableName = document.getElementById('mm-table-name')
	dom.tableDirty = document.getElementById('mm-table-dirty')
	dom.enabledToggle = document.getElementById('mm-enabled-toggle')
	dom.enabledCheckbox = document.getElementById('mm-enabled-checkbox')
	dom.enabledLabel = document.getElementById('mm-enabled-label')
	dom.rowCount = document.getElementById('mm-row-count')
	dom.addRowBtn = document.getElementById('mm-add-row-btn')
	dom.addColBtn = document.getElementById('mm-add-col-btn')
	dom.addTableBtn = document.getElementById('mm-add-table-btn')
	dom.delTableBtn = document.getElementById('mm-del-table-btn')
	dom.viewJsonBtn = document.getElementById('mm-view-json-btn')
	dom.saveBtn = document.getElementById('mm-save-btn')
	dom.ruleInsert = document.getElementById('mm-rule-insert')
	dom.ruleUpdate = document.getElementById('mm-rule-update')
	dom.ruleDelete = document.getElementById('mm-rule-delete')
	dom.gridHead = document.getElementById('mm-grid-head')
	dom.gridBody = document.getElementById('mm-grid-body')
	dom.status = document.getElementById('mm-status')
	// JSON 查看面板
	dom.jsonPanel = document.getElementById('mm-json-panel')
	dom.jsonContent = document.getElementById('mm-json-content')
	dom.jsonCopy = document.getElementById('mm-json-copy')
	dom.jsonClose = document.getElementById('mm-json-close')
	// 归档配置面板
	dom.archiveConfig = document.getElementById('mm-archive-config')
	dom.threshold = document.getElementById('mm-threshold')
	dom.saveConfigBtn = document.getElementById('mm-save-config-btn')
	dom.configStatus = document.getElementById('mm-config-status')
}

// ===== API 调用 =====

async function fetchMemoryData(username, charId) {
	const url = `/api/parts/plugins:beilu-memory/config/getdata?username=${encodeURIComponent(username)}&char_id=${encodeURIComponent(charId)}`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`获取记忆数据失败: ${res.status}`)
	return res.json()
}

async function saveTableToBackend(username, charId, tableIndex, tableData) {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(username)}&char_id=${encodeURIComponent(charId)}`
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			_action: 'updateTable',
			username,
			charName: charId,
			tableIndex,
			rows: tableData.rows,
			columns: tableData.columns,
			rules: tableData.rules,
			name: tableData.name,
			enabled: tableData.enabled,
		}),
	})
	if (!res.ok) throw new Error(`保存表格失败: ${res.status}`)
	return res.json()
}

async function saveArchiveConfig(username, charId, archiveConfig) {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(username)}&char_id=${encodeURIComponent(charId)}`
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			_action: 'updateConfig',
			username,
			charName: charId,
			archive: archiveConfig,
		}),
	})
	if (!res.ok) throw new Error(`保存归档配置失败: ${res.status}`)
	return res.json()
}

// ===== 角色卡选择器 =====

async function loadCharList() {
	try {
		const result = await getAllCachedPartDetails('chars')
		const cachedDetails = result?.cachedDetails || {}
		const uncachedNames = result?.uncachedNames || []
		const charKeys = [...Object.keys(cachedDetails), ...uncachedNames]

		dom.charSelect.innerHTML = '<option value="">选择角色卡...</option>'
		for (const key of charKeys) {
			const opt = document.createElement('option')
			opt.value = key
			const details = cachedDetails[key]
			const displayName = details?.info?.display_name || details?.DisplayName || key
			opt.textContent = displayName
			dom.charSelect.appendChild(opt)
		}

		dom.stats.textContent = `${charKeys.length} 个角色卡`
	} catch (err) {
		console.error('[memoryManage] 获取角色卡列表失败:', err)
		dom.stats.textContent = '获取角色卡失败'
	}
}

async function onCharSelected() {
	const charId = dom.charSelect.value
	if (!charId) {
		dom.noChar.style.display = ''
		dom.editor.style.display = 'none'
		hideArchiveConfig()
		tables = []
		currentCharId = ''
		return
	}

	const urlParams = new URLSearchParams(window.location.search)
	currentUsername = urlParams.get('username') || 'linqing'
	currentCharId = charId

	await loadTablesForChar(currentUsername, charId)
}

function hideArchiveConfig() {
	if (dom.archiveConfig) dom.archiveConfig.style.display = 'none'
	memoryConfig = null
}

async function loadTablesForChar(username, charId) {
	dom.noChar.style.display = 'none'
	dom.editor.style.display = 'none'
	setStatus('加载中...')

	try {
		const data = await fetchMemoryData(username, charId)
		tables = data.tables || []
		memoryConfig = data.config || {}
		// 兼容旧数据：补全 enabled 字段
		for (const t of tables) {
			if (t.enabled === undefined) t.enabled = true
		}
		isDirty = false
		updateDirtyIndicator()

		renderStats()
		renderArchiveConfig()
		renderTableTabs()
		switchTable(0)

		dom.editor.style.display = ''
		setStatus(`已加载 ${tables.length} 个表格`)
	} catch (err) {
		console.error('[memoryManage] 加载表格数据失败:', err)
		setStatus(`加载失败: ${err.message}`)
		dom.noChar.style.display = ''
	}
}

// ===== 归档配置面板 =====

function renderArchiveConfig() {
	if (!dom.archiveConfig || !dom.threshold) return

	const threshold = memoryConfig?.archive?.temp_memory_threshold || 50
	dom.threshold.value = threshold
	dom.archiveConfig.style.display = ''
	if (dom.configStatus) dom.configStatus.textContent = ''
}

async function onSaveArchiveConfig() {
	if (!currentUsername || !currentCharId) {
		if (dom.configStatus) dom.configStatus.textContent = '未选择角色卡'
		return
	}

	const threshold = parseInt(dom.threshold.value, 10)
	if (isNaN(threshold) || threshold < 10 || threshold > 500) {
		if (dom.configStatus) dom.configStatus.textContent = '阈值应在 10-500 之间'
		return
	}

	dom.saveConfigBtn.disabled = true
	dom.saveConfigBtn.textContent = '保存中...'
	if (dom.configStatus) dom.configStatus.textContent = '正在保存...'

	try {
		await saveArchiveConfig(currentUsername, currentCharId, {
			temp_memory_threshold: threshold,
		})

		if (!memoryConfig.archive) memoryConfig.archive = {}
		memoryConfig.archive.temp_memory_threshold = threshold

		if (dom.configStatus) dom.configStatus.textContent = `✅ 阈值已设为 ${threshold} 条`
		setStatus(`归档阈值已更新为 ${threshold}`)
	} catch (err) {
		console.error('[memoryManage] 保存归档配置失败:', err)
		if (dom.configStatus) dom.configStatus.textContent = `❌ ${err.message}`
	} finally {
		dom.saveConfigBtn.disabled = false
		dom.saveConfigBtn.textContent = '💾 保存配置'
	}
}

// ===== 统计信息 =====

function renderStats() {
	if (!tables.length) {
		dom.stats.textContent = ''
		return
	}

	const totalRows = tables.reduce((sum, t) => sum + (t.rows?.length || 0), 0)
	const enabledCount = tables.filter(t => t.enabled !== false).length
	dom.stats.textContent = `${tables.length} 表格 · ${totalRows} 行 · ${enabledCount} 启用`
}

// ===== 表格标签页 =====

function renderTableTabs() {
	dom.tableTabs.innerHTML = ''
	for (let i = 0; i < tables.length; i++) {
		const tab = document.createElement('button')
		const isDisabled = tables[i].enabled === false
		tab.className = 'mm-table-tab' + (i === currentTableIndex ? ' active' : '') + (isDisabled ? ' mm-tab-disabled' : '')
		tab.dataset.index = i
		tab.textContent = `#${tables[i].id}`
		tab.title = (isDisabled ? '[已禁用] ' : '') + (tables[i].name || `表格 #${tables[i].id}`)
		tab.addEventListener('click', () => switchTable(i))
		dom.tableTabs.appendChild(tab)
	}
}

function switchTable(index) {
	if (index < 0 || index >= tables.length) return
	currentTableIndex = index

	// 更新标签页高亮
	dom.tableTabs.querySelectorAll('.mm-table-tab').forEach((tab, i) => {
		const isDisabled = tables[i]?.enabled === false
		tab.classList.toggle('active', i === index)
		tab.classList.toggle('mm-tab-disabled', isDisabled)
	})

	const table = tables[index]

	// 更新表格信息
	dom.tableId.textContent = `#${table.id}`
	dom.tableName.textContent = table.name || '(未命名)'
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`

	// 启用/禁用 toggle
	const isEnabled = table.enabled !== false
	if (dom.enabledCheckbox) {
		dom.enabledCheckbox.checked = isEnabled
		dom.enabledLabel.textContent = isEnabled ? '已启用' : '已禁用'
		// required 表格锁定启用
		if (table.required) {
			dom.enabledCheckbox.disabled = true
			dom.enabledToggle.title = '必需表格，不可禁用'
			dom.enabledToggle.style.opacity = '0.5'
		} else {
			dom.enabledCheckbox.disabled = false
			dom.enabledToggle.title = '启用/禁用此表格（禁用后不注入AI）'
			dom.enabledToggle.style.opacity = '1'
		}
	}

	// 更新规则
	if (table.rules) {
		dom.ruleInsert.textContent = table.rules.insert || '-'
		dom.ruleUpdate.textContent = table.rules.update || '-'
		dom.ruleDelete.textContent = table.rules.delete || '-'
	}

	// 显示/隐藏删除表格按钮（required 表格不可删除）
	if (dom.delTableBtn) {
		dom.delTableBtn.style.display = table.required ? 'none' : ''
	}

	// 隐藏 JSON 面板
	if (dom.jsonPanel) dom.jsonPanel.style.display = 'none'

	// 渲染网格
	renderGrid(table)
}

// ===== 表格网格渲染 =====

function renderGrid(table) {
	// 列头
	dom.gridHead.innerHTML = ''
	const headerRow = document.createElement('tr')

	// 行号列
	const thIdx = document.createElement('th')
	thIdx.className = 'mm-cell mm-cell-header mm-cell-idx'
	thIdx.textContent = '#'
	headerRow.appendChild(thIdx)

	// 数据列（可编辑列名 + 删除列按钮）
	for (let c = 0; c < table.columns.length; c++) {
		const th = document.createElement('th')
		th.className = 'mm-cell mm-cell-header'
		th.style.position = 'relative'
		th.style.cursor = 'pointer'

		const nameSpan = document.createElement('span')
		nameSpan.textContent = table.columns[c]
		nameSpan.title = `点击编辑列名「${table.columns[c]}」`
		th.appendChild(nameSpan)

		// 删除列按钮（至少保留1列）
		if (table.columns.length > 1) {
			const delBtn = document.createElement('button')
			delBtn.style.cssText = 'position:absolute;top:-2px;right:-2px;font-size:0.55rem;cursor:pointer;opacity:0;transition:opacity 0.15s;background:rgba(239,68,68,0.8);color:white;border:none;border-radius:50%;width:14px;height:14px;line-height:14px;text-align:center;padding:0;'
			delBtn.textContent = '×'
			delBtn.title = `删除列「${table.columns[c]}」`
			delBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				deleteColumn(c)
			})
			th.appendChild(delBtn)
			th.addEventListener('mouseenter', () => { delBtn.style.opacity = '1' })
			th.addEventListener('mouseleave', () => { delBtn.style.opacity = '0' })
		}

		// 点击编辑列名
		nameSpan.addEventListener('click', () => startColumnNameEdit(th, nameSpan, c))

		headerRow.appendChild(th)
	}

	// 操作列
	const thOps = document.createElement('th')
	thOps.className = 'mm-cell mm-cell-header mm-cell-ops'
	thOps.textContent = '操作'
	headerRow.appendChild(thOps)

	dom.gridHead.appendChild(headerRow)

	// 数据行
	dom.gridBody.innerHTML = ''
	for (let r = 0; r < table.rows.length; r++) {
		const row = table.rows[r]
		const tr = document.createElement('tr')
		tr.className = 'mm-grid-row'

		// 行号
		const tdIdx = document.createElement('td')
		tdIdx.className = 'mm-cell mm-cell-idx'
		tdIdx.textContent = r
		tr.appendChild(tdIdx)

		// 数据单元格
		for (let c = 0; c < table.columns.length; c++) {
			const td = document.createElement('td')
			td.className = 'mm-cell mm-cell-data'
			const val = (c < row.length) ? (row[c] || '') : ''
			td.textContent = val
			td.title = val || '(空，点击编辑)'
			td.dataset.row = r
			td.dataset.col = c
			td.addEventListener('click', () => startCellEdit(td, r, c))
			tr.appendChild(td)
		}

		// 操作按钮
		const tdOps = document.createElement('td')
		tdOps.className = 'mm-cell mm-cell-ops'
		const delBtn = document.createElement('button')
		delBtn.className = 'mm-row-delete-btn'
		delBtn.textContent = '🗑️'
		delBtn.title = '删除此行'
		delBtn.addEventListener('click', () => deleteRow(r))
		tdOps.appendChild(delBtn)
		tr.appendChild(tdOps)

		dom.gridBody.appendChild(tr)
	}

	// 空表格提示
	if (table.rows.length === 0) {
		const tr = document.createElement('tr')
		const td = document.createElement('td')
		td.className = 'mm-cell text-center text-base-content/30'
		td.colSpan = table.columns.length + 2
		td.textContent = '暂无数据，点击「➕ 添加行」开始'
		tr.appendChild(td)
		dom.gridBody.appendChild(tr)
	}
}

// ===== 列名编辑 =====

function startColumnNameEdit(th, nameSpan, colIdx) {
	if (th.classList.contains('mm-cell-editing')) return

	const table = tables[currentTableIndex]
	const currentValue = table.columns[colIdx] || ''

	th.classList.add('mm-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.className = 'input input-xs input-bordered w-full font-bold'
	input.value = currentValue
	nameSpan.textContent = ''
	nameSpan.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim() || currentValue
		th.classList.remove('mm-cell-editing')
		nameSpan.textContent = newValue
		nameSpan.title = `点击编辑列名「${newValue}」`

		if (newValue !== currentValue) {
			table.columns[colIdx] = newValue
			markDirty()
		}
	}

	input.addEventListener('blur', finishEdit)
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); input.blur() }
		if (e.key === 'Escape') { input.value = currentValue; input.blur() }
	})
}

// ===== 列操作 =====

function addColumn() {
	const table = tables[currentTableIndex]
	if (!table) return

	const name = prompt('请输入新列名:')
	if (!name?.trim()) return

	table.columns.push(name.trim())
	for (const row of table.rows) {
		row.push('')
	}

	markDirty()
	renderGrid(table)
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	setStatus(`已添加列「${name.trim()}」`)
}

function deleteColumn(colIdx) {
	const table = tables[currentTableIndex]
	if (!table || table.columns.length <= 1) return

	const colName = table.columns[colIdx]
	if (!confirm(`确定删除列「${colName}」？该列所有数据将丢失。`)) return

	table.columns.splice(colIdx, 1)
	for (const row of table.rows) {
		if (colIdx < row.length) {
			row.splice(colIdx, 1)
		}
	}

	markDirty()
	renderGrid(table)
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	setStatus(`已删除列「${colName}」`)
}

// ===== 表格名称编辑 =====

function startTableNameEdit() {
	const table = tables[currentTableIndex]
	if (!table) return

	const nameEl = dom.tableName
	if (nameEl.classList.contains('mm-cell-editing')) return

	const currentValue = table.name || ''

	nameEl.classList.add('mm-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.className = 'input input-sm input-bordered font-medium'
	input.style.width = '200px'
	input.value = currentValue
	nameEl.textContent = ''
	nameEl.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim() || currentValue
		nameEl.classList.remove('mm-cell-editing')
		nameEl.textContent = newValue

		if (newValue !== currentValue) {
			table.name = newValue
			markDirty()
			renderTableTabs()
		}
	}

	input.addEventListener('blur', finishEdit)
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); input.blur() }
		if (e.key === 'Escape') { input.value = currentValue; input.blur() }
	})
}

// ===== 规则编辑 =====

function startRuleEdit(ruleSpan, ruleKey) {
	const table = tables[currentTableIndex]
	if (!table?.rules) return
	if (ruleSpan.classList.contains('mm-cell-editing')) return

	const currentValue = table.rules[ruleKey] || ''

	ruleSpan.classList.add('mm-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.className = 'input input-xs input-bordered font-mono'
	input.style.width = '250px'
	input.value = currentValue
	ruleSpan.textContent = ''
	ruleSpan.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim()
		ruleSpan.classList.remove('mm-cell-editing')
		ruleSpan.textContent = newValue || '-'

		if (newValue !== currentValue) {
			table.rules[ruleKey] = newValue
			markDirty()
		}
	}

	input.addEventListener('blur', finishEdit)
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); input.blur() }
		if (e.key === 'Escape') { input.value = currentValue; input.blur() }
	})
}

// ===== 启用/禁用 toggle =====

function toggleTableEnabled() {
	const table = tables[currentTableIndex]
	if (!table || table.required) return

	table.enabled = dom.enabledCheckbox.checked
	dom.enabledLabel.textContent = table.enabled ? '已启用' : '已禁用'

	markDirty()
	renderTableTabs()
	renderStats()
	setStatus(`表格 #${table.id} 已${table.enabled ? '启用' : '禁用'}`)
}

// ===== 单元格内联编辑 =====

function startCellEdit(td, rowIdx, colIdx) {
	if (td.classList.contains('mm-cell-editing')) return

	const table = tables[currentTableIndex]
	const currentValue = table.rows[rowIdx]?.[colIdx] || ''

	td.classList.add('mm-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.className = 'mm-cell-input'
	input.value = currentValue
	td.textContent = ''
	td.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value
		td.classList.remove('mm-cell-editing')
		td.textContent = newValue
		td.title = newValue || '(空)'

		if (newValue !== currentValue) {
			while (table.rows[rowIdx].length <= colIdx) {
				table.rows[rowIdx].push('')
			}
			table.rows[rowIdx][colIdx] = newValue
			markDirty()
		}
	}

	input.addEventListener('blur', finishEdit)
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			input.blur()
		}
		if (e.key === 'Escape') {
			input.value = currentValue
			input.blur()
		}
		if (e.key === 'Tab') {
			e.preventDefault()
			input.blur()
			const nextCol = colIdx + 1
			if (nextCol < table.columns.length) {
				const nextTd = dom.gridBody.querySelector(`td[data-row="${rowIdx}"][data-col="${nextCol}"]`)
				if (nextTd) startCellEdit(nextTd, rowIdx, nextCol)
			}
		}
	})
}

// ===== 行操作 =====

function addRow() {
	const table = tables[currentTableIndex]
	if (!table) return

	const newRow = new Array(table.columns.length).fill('')
	table.rows.push(newRow)
	markDirty()
	renderGrid(table)
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	renderStats()

	const container = document.getElementById('mm-grid-container')
	if (container) container.scrollTop = container.scrollHeight

	setStatus(`已添加第 ${table.rows.length - 1} 行`)
}

function deleteRow(rowIdx) {
	const table = tables[currentTableIndex]
	if (!table || rowIdx < 0 || rowIdx >= table.rows.length) return

	if (!confirm(`确定删除第 ${rowIdx} 行？`)) return

	table.rows.splice(rowIdx, 1)
	markDirty()
	renderGrid(table)
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	renderStats()
	setStatus(`已删除第 ${rowIdx} 行`)
}

// ===== 表格管理（新增/删除） =====

async function addNewTable() {
	if (!currentUsername || !currentCharId) {
		setStatus('请先选择角色卡')
		return
	}

	const name = prompt('请输入新表格名称:')
	if (!name?.trim()) return

	const colsStr = prompt('请输入列名（逗号分隔）:', '列1,列2,列3')
	if (!colsStr?.trim()) return
	const columns = colsStr.split(',').map(s => s.trim()).filter(Boolean)
	if (columns.length === 0) return

	setStatus('正在创建表格...')

	try {
		const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(currentUsername)}&char_id=${encodeURIComponent(currentCharId)}`
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				_action: 'addTable',
				username: currentUsername,
				charName: currentCharId,
				name: name.trim(),
				columns,
			}),
		})
		if (!res.ok) throw new Error(`创建失败: ${res.status}`)

		await loadTablesForChar(currentUsername, currentCharId)
		switchTable(tables.length - 1)
		setStatus(`表格「${name.trim()}」已创建`)
	} catch (err) {
		console.error('[memoryManage] 创建表格失败:', err)
		setStatus(`创建失败: ${err.message}`)
	}
}

async function deleteCurrentTable() {
	if (!currentUsername || !currentCharId) return

	const table = tables[currentTableIndex]
	if (!table) return
	if (table.required) {
		setStatus('必需表格不可删除')
		return
	}

	if (!confirm(`确定删除表格「#${table.id} ${table.name}」？此操作不可撤销。`)) return

	setStatus('正在删除表格...')

	try {
		const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(currentUsername)}&char_id=${encodeURIComponent(currentCharId)}`
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				_action: 'removeTable',
				username: currentUsername,
				charName: currentCharId,
				tableIndex: currentTableIndex,
			}),
		})
		if (!res.ok) throw new Error(`删除失败: ${res.status}`)

		await loadTablesForChar(currentUsername, currentCharId)
		setStatus(`表格已删除`)
	} catch (err) {
		console.error('[memoryManage] 删除表格失败:', err)
		setStatus(`删除失败: ${err.message}`)
	}
}

// ===== JSON 查看 =====

function showJsonPanel() {
	const table = tables[currentTableIndex]
	if (!table || !dom.jsonPanel) return

	dom.jsonContent.textContent = JSON.stringify(table, null, 2)
	dom.jsonPanel.style.display = ''
}

function hideJsonPanel() {
	if (dom.jsonPanel) dom.jsonPanel.style.display = 'none'
}

function copyJson() {
	const text = dom.jsonContent?.textContent || ''
	navigator.clipboard.writeText(text).then(() => {
		setStatus('JSON 已复制到剪贴板')
	}).catch(() => {
		setStatus('复制失败')
	})
}

// ===== 保存 =====

async function saveCurrentTable() {
	if (!currentUsername || !currentCharId) {
		setStatus('未选择角色卡')
		return
	}

	const table = tables[currentTableIndex]
	if (!table) return

	dom.saveBtn.disabled = true
	dom.saveBtn.textContent = '保存中...'
	setStatus('正在保存...')

	try {
		await saveTableToBackend(currentUsername, currentCharId, currentTableIndex, table)
		isDirty = false
		updateDirtyIndicator()
		setStatus(`表格 #${table.id} 保存成功`)
	} catch (err) {
		console.error('[memoryManage] 保存失败:', err)
		setStatus(`保存失败: ${err.message}`)
	} finally {
		dom.saveBtn.disabled = false
		dom.saveBtn.textContent = '💾 保存'
	}
}

// ===== Dirty 状态管理 =====

function markDirty() {
	isDirty = true
	updateDirtyIndicator()
}

function updateDirtyIndicator() {
	dom.tableDirty.style.display = isDirty ? '' : 'none'

	const activeTab = dom.tableTabs.querySelector('.mm-table-tab.active')
	if (activeTab) {
		const baseText = `#${tables[currentTableIndex]?.id ?? ''}`
		activeTab.textContent = isDirty ? `${baseText} *` : baseText
	}
}

// ===== 工具函数 =====

function setStatus(msg) {
	if (dom.status) dom.status.textContent = msg
}

// ===== 事件绑定 =====

function bindEvents() {
	dom.charSelect.addEventListener('change', onCharSelected)
	dom.refreshBtn.addEventListener('click', async () => {
		if (currentCharId) {
			await loadTablesForChar(currentUsername, currentCharId)
		} else {
			await loadCharList()
		}
	})
	dom.addRowBtn.addEventListener('click', addRow)
	dom.saveBtn.addEventListener('click', saveCurrentTable)
	if (dom.saveConfigBtn) dom.saveConfigBtn.addEventListener('click', onSaveArchiveConfig)

	// 新功能按钮
	if (dom.addColBtn) dom.addColBtn.addEventListener('click', addColumn)
	if (dom.addTableBtn) dom.addTableBtn.addEventListener('click', addNewTable)
	if (dom.delTableBtn) dom.delTableBtn.addEventListener('click', deleteCurrentTable)
	if (dom.viewJsonBtn) dom.viewJsonBtn.addEventListener('click', showJsonPanel)
	if (dom.jsonClose) dom.jsonClose.addEventListener('click', hideJsonPanel)
	if (dom.jsonCopy) dom.jsonCopy.addEventListener('click', copyJson)

	// 表格名称双击编辑
	if (dom.tableName) dom.tableName.addEventListener('dblclick', startTableNameEdit)

	// 启用/禁用 toggle
	if (dom.enabledCheckbox) dom.enabledCheckbox.addEventListener('change', toggleTableEnabled)

	// 规则编辑
	if (dom.ruleInsert) dom.ruleInsert.addEventListener('click', () => startRuleEdit(dom.ruleInsert, 'insert'))
	if (dom.ruleUpdate) dom.ruleUpdate.addEventListener('click', () => startRuleEdit(dom.ruleUpdate, 'update'))
	if (dom.ruleDelete) dom.ruleDelete.addEventListener('click', () => startRuleEdit(dom.ruleDelete, 'delete'))

	// 离开前提示未保存
	window.addEventListener('beforeunload', (e) => {
		if (isDirty) {
			e.preventDefault()
			e.returnValue = '记忆表格有未保存的修改，确定离开？'
		}
	})
}

// ===== 初始化 =====

export async function init() {
	console.log('[memoryManage] 初始化记忆管理模块（增强版）')
	cacheDom()
	bindEvents()

	// 加载角色卡列表
	await loadCharList()

	// 隐藏加载动画，显示主界面
	dom.loading.style.display = 'none'
	dom.main.style.display = ''

	console.log('[memoryManage] 记忆管理模块初始化完成')
}
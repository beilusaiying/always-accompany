/**
 * memoryManage.mjs — 记忆管理 Tab（Phase 4.1: 表格可视化编辑器）
 *
 * 职责：
 * - 角色卡选择器（从 parts 系统获取角色卡列表）
 * - 表格标签页 #0-#9（或更多）
 * - 表格网格渲染（列头 + 数据行）
 * - 单元格双击内联编辑
 * - 行增删
 * - 保存到后端
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
	dom.rowCount = document.getElementById('mm-row-count')
	dom.addRowBtn = document.getElementById('mm-add-row-btn')
	dom.saveBtn = document.getElementById('mm-save-btn')
	dom.ruleInsert = document.getElementById('mm-rule-insert')
	dom.ruleUpdate = document.getElementById('mm-rule-update')
	dom.ruleDelete = document.getElementById('mm-rule-delete')
	dom.gridHead = document.getElementById('mm-grid-head')
	dom.gridBody = document.getElementById('mm-grid-body')
	dom.status = document.getElementById('mm-status')
	// 归档配置面板
	dom.archiveConfig = document.getElementById('mm-archive-config')
	dom.threshold = document.getElementById('mm-threshold')
	dom.saveConfigBtn = document.getElementById('mm-save-config-btn')
	dom.configStatus = document.getElementById('mm-config-status')
}

// ===== API 调用 =====

/**
 * 从后端获取记忆数据
 */
async function fetchMemoryData(username, charId) {
	const url = `/api/parts/plugins:beilu-memory/config/getdata?username=${encodeURIComponent(username)}&char_id=${encodeURIComponent(charId)}`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`获取记忆数据失败: ${res.status}`)
	return res.json()
}

/**
 * 保存表格数据到后端
 */
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
		}),
	})
	if (!res.ok) throw new Error(`保存表格失败: ${res.status}`)
	return res.json()
}

/**
 * 保存归档配置到后端
 */
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

/**
 * 获取角色卡列表并填充下拉框
 */
async function loadCharList() {
	try {
		const result = await getAllCachedPartDetails('chars')
		const cachedDetails = result?.cachedDetails || {}
		const uncachedNames = result?.uncachedNames || []
		const charKeys = [...Object.keys(cachedDetails), ...uncachedNames]

		// 清空并重新填充
		dom.charSelect.innerHTML = '<option value="">选择角色卡...</option>'
		for (const key of charKeys) {
			const opt = document.createElement('option')
			opt.value = key
			// 尝试取显示名
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

/**
 * 角色卡选择变化
 */
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

	// 获取当前用户名（从 URL 参数或默认值）
	const urlParams = new URLSearchParams(window.location.search)
	currentUsername = urlParams.get('username') || 'linqing'
	currentCharId = charId

	await loadTablesForChar(currentUsername, charId)
}

/**
	* 角色卡选择清空时隐藏归档配置
	*/
function hideArchiveConfig() {
	if (dom.archiveConfig) dom.archiveConfig.style.display = 'none'
	memoryConfig = null
}

/**
 * 加载指定角色卡的表格数据
 */
async function loadTablesForChar(username, charId) {
	dom.noChar.style.display = 'none'
	dom.editor.style.display = 'none'
	setStatus('加载中...')

	try {
		const data = await fetchMemoryData(username, charId)
		tables = data.tables || []
		memoryConfig = data.config || {}
		isDirty = false
		updateDirtyIndicator()

		// 渲染统计
		renderStats()

		// 渲染归档配置
		renderArchiveConfig()

		// 渲染
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

		// 更新本地缓存
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
	const nonEmptyCount = tables.filter(t => t.rows?.length > 0).length
	dom.stats.textContent = `${tables.length} 表格 · ${totalRows} 行 · ${nonEmptyCount} 非空`
}

// ===== 表格标签页 =====

function renderTableTabs() {
	dom.tableTabs.innerHTML = ''
	for (let i = 0; i < tables.length; i++) {
		const tab = document.createElement('button')
		tab.className = 'mm-table-tab' + (i === currentTableIndex ? ' active' : '')
		tab.dataset.index = i
		tab.textContent = `#${tables[i].id}`
		tab.title = tables[i].name || `表格 #${tables[i].id}`
		tab.addEventListener('click', () => switchTable(i))
		dom.tableTabs.appendChild(tab)
	}
}

function switchTable(index) {
	if (index < 0 || index >= tables.length) return
	currentTableIndex = index

	// 更新标签页高亮
	dom.tableTabs.querySelectorAll('.mm-table-tab').forEach((tab, i) => {
		tab.classList.toggle('active', i === index)
	})

	const table = tables[index]

	// 更新表格信息
	dom.tableId.textContent = `#${table.id}`
	dom.tableName.textContent = table.name || '(未命名)'
	dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`

	// 更新规则
	if (table.rules) {
		dom.ruleInsert.textContent = table.rules.insert || '-'
		dom.ruleUpdate.textContent = table.rules.update || '-'
		dom.ruleDelete.textContent = table.rules.delete || '-'
	}

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

	// 数据列
	for (let c = 0; c < table.columns.length; c++) {
		const th = document.createElement('th')
		th.className = 'mm-cell mm-cell-header'
		th.textContent = table.columns[c]
		th.title = table.columns[c]
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
			// 单击即可编辑（双击在某些环境下不稳定）
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
			// 确保行数组足够长
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
			// Tab 跳转到下一个单元格
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

	// 滚动到底部
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

	// 在标签页上标记
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
	console.log('[memoryManage] 初始化记忆管理模块')
	cacheDom()
	bindEvents()

	// 加载角色卡列表
	await loadCharList()

	// 隐藏加载动画，显示主界面
	dom.loading.style.display = 'none'
	dom.main.style.display = ''

	console.log('[memoryManage] 记忆管理模块初始化完成')
}
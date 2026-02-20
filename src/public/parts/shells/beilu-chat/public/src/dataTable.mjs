/**
 * dataTable.mjs — 记忆系统表格编辑器（完整版）
 *
 * 职责：
 * - 自动绑定当前聊天角色卡（不手动选择）
 * - 表格标签页 #0-#9（或更多）
 * - 表格网格渲染（列头 + 数据行）
 * - 单元格单击内联编辑
 * - 行增删 + 表格新增/删除
 * - 保存到后端 beilu-memory API
 * - 统计信息展示
 */

// ===== 状态 =====
let currentUsername = ''
let currentCharId = ''
let tables = []
let currentTableIndex = 0
let isDirty = false
let _boundCharId = '' // 绑定的角色卡（从 chat.mjs charList 传入）

// ===== DOM 引用 =====
let _container = null
let _dom = {}

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
		}),
	})
	if (!res.ok) throw new Error(`保存表格失败: ${res.status}`)
	return res.json()
}

// ===== 渲染完整编辑器 UI =====

function renderEditorUI(container) {
	container.innerHTML = `
		<div class="dt-editor" style="display:flex;flex-direction:column;height:100%;">
			<!-- 顶部工具栏：角色卡绑定显示 + 统计 -->
			<div class="dt-toolbar">
				<div class="dt-toolbar-group">
					<span style="font-size:0.75rem;color:var(--beilu-amber);font-weight:600;">🧠 记忆表格</span>
					<span id="dt-char-label" style="font-size:0.7rem;color:rgba(212,160,23,0.7);padding:0.15rem 0.5rem;border:1px solid rgba(212,160,23,0.2);border-radius:0.25rem;background:rgba(212,160,23,0.05);">未绑定角色</span>
					<button id="dt-refresh-btn" class="dt-btn dt-btn-sm" title="刷新">🔄</button>
				</div>
				<div class="dt-toolbar-group">
					<span id="dt-stats" style="font-size:0.65rem;color:rgba(212,160,23,0.5);"></span>
				</div>
			</div>

			<!-- 表格标签页 -->
			<div id="dt-table-tabs" class="dt-toolbar" style="padding:0.25rem 0.5rem;gap:0.25rem;border-top:none;flex-wrap:nowrap;overflow-x:auto;">
			</div>

			<!-- 表格信息栏 -->
			<div id="dt-table-info" class="dt-toolbar" style="padding:0.25rem 0.75rem;border-top:none;display:none;">
				<div class="dt-toolbar-group">
					<span id="dt-table-id" class="dt-table-label"></span>
					<span id="dt-table-name" style="font-size:0.75rem;font-weight:500;"></span>
					<span id="dt-table-dirty" style="color:#f59e0b;font-size:0.7rem;display:none;">● 未保存</span>
				</div>
				<div class="dt-toolbar-group">
					<span id="dt-row-count" class="dt-table-count"></span>
					<button id="dt-add-row-btn" class="dt-btn dt-btn-sm">➕ 添加行</button>
					<button id="dt-add-table-btn" class="dt-btn dt-btn-sm" title="新增表格">📊 新增表格</button>
					<button id="dt-del-table-btn" class="dt-btn dt-btn-sm" title="删除当前表格" style="display:none;">🗑️ 删除表格</button>
					<button id="dt-save-btn" class="dt-btn dt-btn-sm dt-btn-primary">💾 保存</button>
				</div>
			</div>

			<!-- 规则提示 -->
			<div id="dt-rules" style="padding:0.25rem 0.75rem;font-size:0.6rem;color:rgba(212,160,23,0.35);display:none;">
				插入: <span id="dt-rule-insert">-</span> · 更新: <span id="dt-rule-update">-</span> · 删除: <span id="dt-rule-delete">-</span>
			</div>

			<!-- 表格网格 -->
			<div id="dt-grid-container" class="dt-content-area" style="flex:1;overflow:auto;">
				<!-- 空状态 -->
				<div id="dt-empty" class="dt-empty-state">
					<div class="dt-empty-icon">🧠</div>
					<div class="dt-empty-title">记忆表格编辑器</div>
					<div class="dt-empty-desc">绑定到当前聊天的角色卡，自动加载记忆数据</div>
				</div>
				<!-- 表格 -->
				<div id="dt-grid-wrapper" class="dt-table-wrapper" style="display:none;">
					<table class="dt-table">
						<thead id="dt-grid-head"></thead>
						<tbody id="dt-grid-body"></tbody>
					</table>
				</div>
			</div>

			<!-- 状态栏 -->
			<div style="display:flex;align-items:center;justify-content:space-between;padding:0.125rem 0.5rem;background:var(--beilu-amber-dark);color:rgba(255,255,255,0.8);font-size:0.6rem;flex-shrink:0;">
				<span id="dt-status">就绪</span>
				<span>记忆编辑器</span>
			</div>
		</div>
	`

	// 缓存 DOM 引用
	_dom.charLabel = container.querySelector('#dt-char-label')
	_dom.refreshBtn = container.querySelector('#dt-refresh-btn')
	_dom.stats = container.querySelector('#dt-stats')
	_dom.tableTabs = container.querySelector('#dt-table-tabs')
	_dom.tableInfo = container.querySelector('#dt-table-info')
	_dom.tableId = container.querySelector('#dt-table-id')
	_dom.tableName = container.querySelector('#dt-table-name')
	_dom.tableDirty = container.querySelector('#dt-table-dirty')
	_dom.rowCount = container.querySelector('#dt-row-count')
	_dom.addRowBtn = container.querySelector('#dt-add-row-btn')
	_dom.addTableBtn = container.querySelector('#dt-add-table-btn')
	_dom.delTableBtn = container.querySelector('#dt-del-table-btn')
	_dom.saveBtn = container.querySelector('#dt-save-btn')
	_dom.rules = container.querySelector('#dt-rules')
	_dom.ruleInsert = container.querySelector('#dt-rule-insert')
	_dom.ruleUpdate = container.querySelector('#dt-rule-update')
	_dom.ruleDelete = container.querySelector('#dt-rule-delete')
	_dom.gridContainer = container.querySelector('#dt-grid-container')
	_dom.empty = container.querySelector('#dt-empty')
	_dom.gridWrapper = container.querySelector('#dt-grid-wrapper')
	_dom.gridHead = container.querySelector('#dt-grid-head')
	_dom.gridBody = container.querySelector('#dt-grid-body')
	_dom.status = container.querySelector('#dt-status')
}

// ===== 角色卡绑定 =====

/**
 * 绑定到指定角色卡并加载数据
 * @param {string} charId - 角色卡名称
 * @param {string} [username] - 用户名（可选）
 */
async function bindToChar(charId, username) {
	if (!charId) {
		_dom.charLabel.textContent = '未绑定角色'
		_dom.charLabel.style.color = 'rgba(212,160,23,0.5)'
		showEmpty()
		tables = []
		currentCharId = ''
		_boundCharId = ''
		return
	}

	_boundCharId = charId
	currentCharId = charId

	const urlParams = new URLSearchParams(window.location.search)
	currentUsername = username || urlParams.get('username') || ''

	// 更新绑定标签
	_dom.charLabel.textContent = `🔗 ${charId}`
	_dom.charLabel.style.color = 'var(--beilu-amber)'

	await loadTablesForChar(currentUsername, charId)
}

async function loadTablesForChar(username, charId) {
	showEmpty()
	setStatus('加载中...')

	try {
		const data = await fetchMemoryData(username, charId)
		tables = data.tables || []
		isDirty = false
		updateDirtyIndicator()

		renderStats()
		renderTableTabs()
		switchTable(0)

		setStatus(`已加载 ${tables.length} 个表格`)
	} catch (err) {
		console.error('[dataTable] 加载表格数据失败:', err)
		setStatus(`加载失败: ${err.message}`)
		showEmpty()
	}
}

// ===== 显示/隐藏 =====

function showEmpty() {
	_dom.empty.style.display = ''
	_dom.gridWrapper.style.display = 'none'
	_dom.tableInfo.style.display = 'none'
	_dom.rules.style.display = 'none'
	_dom.tableTabs.innerHTML = ''
}

function showGrid() {
	_dom.empty.style.display = 'none'
	_dom.gridWrapper.style.display = ''
	_dom.tableInfo.style.display = ''
}

// ===== 统计 =====

function renderStats() {
	if (!tables.length) {
		_dom.stats.textContent = ''
		return
	}
	const totalRows = tables.reduce((sum, t) => sum + (t.rows?.length || 0), 0)
	const nonEmptyCount = tables.filter(t => t.rows?.length > 0).length
	_dom.stats.textContent = `${tables.length} 表格 · ${totalRows} 行 · ${nonEmptyCount} 非空`
}

// ===== 表格标签页 =====

function renderTableTabs() {
	_dom.tableTabs.innerHTML = ''
	for (let i = 0; i < tables.length; i++) {
		const tab = document.createElement('button')
		tab.className = 'dt-tab-btn' + (i === currentTableIndex ? ' dt-tab-active' : '')
		tab.dataset.index = i
		tab.textContent = `#${tables[i].id}`
		tab.title = tables[i].name || `表格 #${tables[i].id}`
		tab.addEventListener('click', () => switchTable(i))
		_dom.tableTabs.appendChild(tab)
	}
}

function switchTable(index) {
	if (index < 0 || index >= tables.length) return
	currentTableIndex = index

	// 切换到表格视图时，隐藏文件查看器，显示 dataTable 区域
	const fileViewer = document.getElementById('memory-file-viewer')
	const datatableArea = document.getElementById('memory-datatable-area')
	if (fileViewer) fileViewer.style.display = 'none'
	if (datatableArea) datatableArea.style.display = ''

	_dom.tableTabs.querySelectorAll('.dt-tab-btn').forEach((tab, i) => {
		tab.classList.toggle('dt-tab-active', i === index)
	})

	const table = tables[index]
	_dom.tableId.textContent = `#${table.id}`
	_dom.tableName.textContent = table.name || '(未命名)'
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`

	if (table.rules) {
		_dom.ruleInsert.textContent = table.rules.insert || '-'
		_dom.ruleUpdate.textContent = table.rules.update || '-'
		_dom.ruleDelete.textContent = table.rules.delete || '-'
		_dom.rules.style.display = ''
	} else {
		_dom.rules.style.display = 'none'
	}

	// 显示/隐藏删除表格按钮（required 表格不可删除）
	if (_dom.delTableBtn) {
		_dom.delTableBtn.style.display = table.required ? 'none' : ''
	}

	showGrid()
	renderGrid(table)
}

// ===== 表格网格渲染 =====

function renderGrid(table) {
	// 列头
	_dom.gridHead.innerHTML = ''
	const headerRow = document.createElement('tr')

	const thIdx = document.createElement('th')
	thIdx.className = 'dt-row-num-header'
	thIdx.textContent = '#'
	headerRow.appendChild(thIdx)

	for (let c = 0; c < table.columns.length; c++) {
		const th = document.createElement('th')
		th.className = 'dt-col-header'
		th.textContent = table.columns[c]
		th.title = table.columns[c]
		headerRow.appendChild(th)
	}

	const thOps = document.createElement('th')
	thOps.className = 'dt-action-header'
	thOps.textContent = '操作'
	headerRow.appendChild(thOps)

	_dom.gridHead.appendChild(headerRow)

	// 数据行
	_dom.gridBody.innerHTML = ''
	for (let r = 0; r < table.rows.length; r++) {
		const row = table.rows[r]
		const tr = document.createElement('tr')

		// 行号
		const tdIdx = document.createElement('td')
		tdIdx.className = 'dt-row-num'
		tdIdx.textContent = r
		tr.appendChild(tdIdx)

		// 数据单元格
		for (let c = 0; c < table.columns.length; c++) {
			const td = document.createElement('td')
			td.className = 'dt-cell'
			const val = (c < row.length) ? (row[c] || '') : ''
			td.textContent = val
			td.title = val || '(空，点击编辑)'
			td.dataset.row = r
			td.dataset.col = c
			td.addEventListener('click', () => startCellEdit(td, r, c))
			tr.appendChild(td)
		}

		// 操作
		const tdOps = document.createElement('td')
		tdOps.className = 'dt-action-cell'
		const delBtn = document.createElement('button')
		delBtn.className = 'dt-row-delete-btn'
		delBtn.textContent = '🗑️'
		delBtn.title = '删除此行'
		delBtn.addEventListener('click', () => deleteRow(r))
		tdOps.appendChild(delBtn)
		tr.appendChild(tdOps)

		_dom.gridBody.appendChild(tr)
	}

	// 空表格提示
	if (table.rows.length === 0) {
		const tr = document.createElement('tr')
		const td = document.createElement('td')
		td.className = 'dt-cell'
		td.style.textAlign = 'center'
		td.style.color = 'rgba(212,160,23,0.35)'
		td.colSpan = table.columns.length + 2
		td.textContent = '暂无数据，点击「➕ 添加行」开始'
		tr.appendChild(td)
		_dom.gridBody.appendChild(tr)
	}
}

// ===== 单元格内联编辑 =====

function startCellEdit(td, rowIdx, colIdx) {
	if (td.classList.contains('dt-cell-editing')) return

	const table = tables[currentTableIndex]
	const currentValue = table.rows[rowIdx]?.[colIdx] || ''

	td.classList.add('dt-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.style.cssText = 'width:100%;padding:0.2rem 0.3rem;font-size:0.8rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;'
	input.value = currentValue
	td.textContent = ''
	td.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value
		td.classList.remove('dt-cell-editing')
		td.textContent = newValue
		td.title = newValue || '(空，点击编辑)'

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
				const nextTd = _dom.gridBody.querySelector(`td[data-row="${rowIdx}"][data-col="${nextCol}"]`)
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
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	renderStats()

	_dom.gridContainer.scrollTop = _dom.gridContainer.scrollHeight
	setStatus(`已添加第 ${table.rows.length - 1} 行`)
}

function deleteRow(rowIdx) {
	const table = tables[currentTableIndex]
	if (!table || rowIdx < 0 || rowIdx >= table.rows.length) return
	if (!confirm(`确定删除第 ${rowIdx} 行？`)) return

	table.rows.splice(rowIdx, 1)
	markDirty()
	renderGrid(table)
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	renderStats()
	setStatus(`已删除第 ${rowIdx} 行`)
}

// ===== 表格管理（新增/删除） =====

async function addNewTable() {
	if (!currentUsername || !currentCharId) {
		setStatus('请先绑定角色卡')
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

		// 重新加载
		await loadTablesForChar(currentUsername, currentCharId)
		// 切换到新表格
		switchTable(tables.length - 1)
		setStatus(`表格「${name.trim()}」已创建`)
	} catch (err) {
		console.error('[dataTable] 创建表格失败:', err)
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

		// 重新加载
		await loadTablesForChar(currentUsername, currentCharId)
		setStatus(`表格已删除`)
	} catch (err) {
		console.error('[dataTable] 删除表格失败:', err)
		setStatus(`删除失败: ${err.message}`)
	}
}

// ===== 保存 =====

async function saveCurrentTable() {
	if (!currentUsername || !currentCharId) {
		setStatus('未绑定角色卡')
		return
	}

	const table = tables[currentTableIndex]
	if (!table) return

	_dom.saveBtn.disabled = true
	_dom.saveBtn.textContent = '保存中...'
	setStatus('正在保存...')

	try {
		await saveTableToBackend(currentUsername, currentCharId, currentTableIndex, table)
		isDirty = false
		updateDirtyIndicator()
		setStatus(`表格 #${table.id} 保存成功`)
	} catch (err) {
		console.error('[dataTable] 保存失败:', err)
		setStatus(`保存失败: ${err.message}`)
	} finally {
		_dom.saveBtn.disabled = false
		_dom.saveBtn.textContent = '💾 保存'
	}
}

// ===== Dirty 状态 =====

function markDirty() {
	isDirty = true
	updateDirtyIndicator()
}

function updateDirtyIndicator() {
	if (_dom.tableDirty) _dom.tableDirty.style.display = isDirty ? '' : 'none'

	const activeTab = _dom.tableTabs?.querySelector('.dt-tab-btn.dt-tab-active')
	if (activeTab && tables[currentTableIndex]) {
		const baseText = `#${tables[currentTableIndex].id}`
		activeTab.textContent = isDirty ? `${baseText} *` : baseText
	}
}

// ===== 工具 =====

function setStatus(msg) {
	if (_dom.status) _dom.status.textContent = msg
}

// ===== 事件绑定 =====

function bindEvents() {
	_dom.refreshBtn?.addEventListener('click', async () => {
		if (currentCharId) {
			await loadTablesForChar(currentUsername, currentCharId)
		}
	})
	_dom.addRowBtn?.addEventListener('click', addRow)
	_dom.addTableBtn?.addEventListener('click', addNewTable)
	_dom.delTableBtn?.addEventListener('click', deleteCurrentTable)
	_dom.saveBtn?.addEventListener('click', saveCurrentTable)
}

// ===== 公开接口 =====

/**
 * 初始化 dataTable 可视化编辑器
 * @param {HTMLElement} container - 编辑器容器 DOM
 * @param {object} data - 初始数据（兼容旧接口，可为 null）
 * @param {object} options - 配置项 { charId, username, onSave }
 */
export async function initDataTable(container, data, options = {}) {
	if (!container) return
	_container = container

	// 渲染编辑器 UI
	renderEditorUI(container)
	bindEvents()

	// 如果提供了 charId，自动绑定
	if (options.charId) {
		await bindToChar(options.charId, options.username)
	}

	console.log('[dataTable] 记忆表格编辑器初始化完成', options.charId ? `(绑定: ${options.charId})` : '(等待绑定)')
}

/**
 * 动态绑定到新的角色卡（外部调用，如聊天切换角色时）
 * @param {string} charId - 角色卡名称
 * @param {string} [username] - 用户名
 */
export async function bindDataTableToChar(charId, username) {
	if (!_container) return // 编辑器未初始化
	if (charId === _boundCharId) return // 已绑定同一角色，跳过
	await bindToChar(charId, username)
}

/**
 * 获取当前所有表格数据
 * @returns {Array} 表格数据数组
 */
export function getTablesData() {
	return tables || []
}
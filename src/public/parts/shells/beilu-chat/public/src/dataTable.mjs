/**
 * dataTable.mjs — 记忆系统表格编辑器（增强版）
 *
 * 职责：
 * - 自动绑定当前聊天角色卡（不手动选择）
 * - 表格标签页 #0-#9（或更多）
 * - 表格网格渲染（列头 + 数据行）
 * - 单元格单击内联编辑
 * - 列头可编辑（点击修改列名，可增删列）
 * - 表格名称可双击编辑
 * - 规则可点击编辑（insert/update/delete）
 * - 表格启用/禁用 toggle（禁用后不注入AI）
 * - 行增删 + 表格新增/删除
 * - 保存完整数据到后端 beilu-memory API（name + columns + rules + enabled + rows）
 * - 统计信息展示
 */

import { createDiag } from './diagLogger.mjs'
const diag = createDiag('memory')

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
	const res = await diag.traceFetch(url)
	if (!res.ok) throw new Error(`获取记忆数据失败: ${res.status}`)
	return res.json()
}

async function saveTableToBackend(username, charId, tableIndex, tableData) {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(username)}&char_id=${encodeURIComponent(charId)}`
	diag.log(`saveTableToBackend: #${tableIndex} "${tableData.name}" rows=${tableData.rows?.length} cols=${tableData.columns?.length} enabled=${tableData.enabled}`)
	const body = {
		_action: 'updateTable',
		username,
		charName: charId,
		tableIndex,
		rows: tableData.rows,
		columns: tableData.columns,
		rules: tableData.rules,
		name: tableData.name,
		enabled: tableData.enabled,
	}
	const res = await diag.traceFetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
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
				<div class="dt-toolbar-group" style="gap:0.4rem;align-items:center;">
					<span id="dt-table-id" class="dt-table-label"></span>
					<span id="dt-table-name" style="font-size:0.75rem;font-weight:500;cursor:pointer;" title="双击编辑表格名称"></span>
					<span id="dt-table-dirty" style="color:#f59e0b;font-size:0.7rem;display:none;">● 未保存</span>
					<!-- 启用/禁用 toggle -->
					<label id="dt-enabled-toggle" style="display:inline-flex;align-items:center;gap:0.25rem;cursor:pointer;font-size:0.65rem;color:rgba(212,160,23,0.7);margin-left:0.5rem;" title="启用/禁用此表格（禁用后不注入AI）">
						<input type="checkbox" id="dt-enabled-checkbox" style="accent-color:var(--beilu-amber);cursor:pointer;">
						<span id="dt-enabled-label">已启用</span>
					</label>
				</div>
				<div class="dt-toolbar-group">
					<span id="dt-row-count" class="dt-table-count"></span>
					<button id="dt-add-row-btn" class="dt-btn dt-btn-sm">➕ 添加行</button>
					<button id="dt-add-col-btn" class="dt-btn dt-btn-sm" title="添加新列">📏 添加列</button>
					<button id="dt-add-table-btn" class="dt-btn dt-btn-sm" title="新增表格">📊 新增表格</button>
					<button id="dt-del-table-btn" class="dt-btn dt-btn-sm" title="删除当前表格" style="display:none;">🗑️ 删除表格</button>
					<button id="dt-save-btn" class="dt-btn dt-btn-sm dt-btn-primary">💾 保存</button>
				</div>
			</div>

			<!-- 规则提示（可编辑） -->
			<div id="dt-rules" style="padding:0.25rem 0.75rem;font-size:0.6rem;color:rgba(212,160,23,0.5);display:none;">
				<span style="color:rgba(212,160,23,0.35);">📋</span>
				插入: <span id="dt-rule-insert" class="dt-rule-editable" title="点击编辑插入规则">-</span>
				 · 更新: <span id="dt-rule-update" class="dt-rule-editable" title="点击编辑更新规则">-</span>
				 · 删除: <span id="dt-rule-delete" class="dt-rule-editable" title="点击编辑删除规则">-</span>
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

		<style>
			.dt-rule-editable {
				cursor: pointer;
				border-bottom: 1px dashed rgba(212,160,23,0.3);
				padding: 0 0.15rem;
				transition: color 0.15s, border-color 0.15s;
			}
			.dt-rule-editable:hover {
				color: var(--beilu-amber);
				border-bottom-color: var(--beilu-amber);
			}
			.dt-col-header-editable {
				cursor: pointer;
				position: relative;
			}
			.dt-col-header-editable:hover {
				background: rgba(212,160,23,0.15) !important;
			}
			.dt-col-delete-btn {
				position: absolute;
				top: -2px;
				right: -2px;
				font-size: 0.55rem;
				cursor: pointer;
				opacity: 0;
				transition: opacity 0.15s;
				background: rgba(239,68,68,0.8);
				color: white;
				border: none;
				border-radius: 50%;
				width: 14px;
				height: 14px;
				line-height: 14px;
				text-align: center;
				padding: 0;
			}
			.dt-col-header-editable:hover .dt-col-delete-btn {
				opacity: 1;
			}
			.dt-tab-disabled {
				opacity: 0.45;
				text-decoration: line-through;
			}
		</style>
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
	_dom.enabledToggle = container.querySelector('#dt-enabled-toggle')
	_dom.enabledCheckbox = container.querySelector('#dt-enabled-checkbox')
	_dom.enabledLabel = container.querySelector('#dt-enabled-label')
	_dom.rowCount = container.querySelector('#dt-row-count')
	_dom.addRowBtn = container.querySelector('#dt-add-row-btn')
	_dom.addColBtn = container.querySelector('#dt-add-col-btn')
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
	diag.log(`bindToChar: charId="${charId || ''}" username="${username || ''}"`)
	if (!charId) {
		diag.log('bindToChar: 解绑（charId为空）')
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
	currentUsername = username || urlParams.get('username') || 'linqing'

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
		// 兼容旧数据：补全 enabled 字段
		for (const t of tables) {
			if (t.enabled === undefined) t.enabled = true
		}
		isDirty = false
		updateDirtyIndicator()

		const enabledCount = tables.filter(t => t.enabled !== false).length
		diag.log(`loadTablesForChar: 加载完成, ${tables.length} 个表格, ${enabledCount} 启用`)
		diag.snapshot('tables-loaded', {
			charId,
			tableCount: tables.length,
			enabledCount,
			tableIds: tables.map(t => t.id),
		})

		renderStats()
		renderTableTabs()
		switchTable(0)

		setStatus(`已加载 ${tables.length} 个表格`)
	} catch (err) {
		diag.error('loadTablesForChar: 加载失败', err.message)
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
	const enabledCount = tables.filter(t => t.enabled !== false).length
	_dom.stats.textContent = `${tables.length} 表格 · ${totalRows} 行 · ${enabledCount} 启用`
}

// ===== 表格标签页 =====

function renderTableTabs() {
	_dom.tableTabs.innerHTML = ''
	for (let i = 0; i < tables.length; i++) {
		const tab = document.createElement('button')
		const isDisabled = tables[i].enabled === false
		tab.className = 'dt-tab-btn' + (i === currentTableIndex ? ' dt-tab-active' : '') + (isDisabled ? ' dt-tab-disabled' : '')
		tab.dataset.index = i
		tab.textContent = `#${tables[i].id}`
		tab.title = (isDisabled ? '[已禁用] ' : '') + (tables[i].name || `表格 #${tables[i].id}`)
		tab.addEventListener('click', () => switchTable(i))
		_dom.tableTabs.appendChild(tab)
	}
}

function switchTable(index) {
	if (index < 0 || index >= tables.length) return
	currentTableIndex = index
	diag.debug(`switchTable: index=${index} id=#${tables[index]?.id} name="${tables[index]?.name}" enabled=${tables[index]?.enabled}`)

	// 切换到表格视图时，隐藏文件查看器，显示 dataTable 区域
	const fileViewer = document.getElementById('memory-file-viewer')
	const datatableArea = document.getElementById('memory-datatable-area')
	if (fileViewer) fileViewer.style.display = 'none'
	if (datatableArea) datatableArea.style.display = ''

	_dom.tableTabs.querySelectorAll('.dt-tab-btn').forEach((tab, i) => {
		const isDisabled = tables[i]?.enabled === false
		tab.classList.toggle('dt-tab-active', i === index)
		tab.classList.toggle('dt-tab-disabled', isDisabled)
	})

	const table = tables[index]
	_dom.tableId.textContent = `#${table.id}`
	_dom.tableName.textContent = table.name || '(未命名)'
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`

	// 启用/禁用 toggle
	const isEnabled = table.enabled !== false
	_dom.enabledCheckbox.checked = isEnabled
	_dom.enabledLabel.textContent = isEnabled ? '已启用' : '已禁用'
	_dom.enabledLabel.style.color = isEnabled ? 'rgba(212,160,23,0.7)' : 'rgba(239,68,68,0.7)'
	// required 表格锁定启用
	if (table.required) {
		_dom.enabledCheckbox.disabled = true
		_dom.enabledToggle.title = '必需表格，不可禁用'
		_dom.enabledToggle.style.opacity = '0.5'
	} else {
		_dom.enabledCheckbox.disabled = false
		_dom.enabledToggle.title = '启用/禁用此表格（禁用后不注入AI）'
		_dom.enabledToggle.style.opacity = '1'
	}

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
		th.className = 'dt-col-header dt-col-header-editable'
		th.style.position = 'relative'

		const nameSpan = document.createElement('span')
		nameSpan.textContent = table.columns[c]
		nameSpan.title = `点击编辑列名「${table.columns[c]}」`
		th.appendChild(nameSpan)

		// 删除列按钮（至少保留1列）
		if (table.columns.length > 1) {
			const delBtn = document.createElement('button')
			delBtn.className = 'dt-col-delete-btn'
			delBtn.textContent = '×'
			delBtn.title = `删除列「${table.columns[c]}」`
			delBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				deleteColumn(c)
			})
			th.appendChild(delBtn)
		}

		// 点击编辑列名
		nameSpan.addEventListener('click', () => startColumnNameEdit(th, nameSpan, c))

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

// ===== 列名编辑 =====

function startColumnNameEdit(th, nameSpan, colIdx) {
	if (th.classList.contains('dt-cell-editing')) return

	const table = tables[currentTableIndex]
	const currentValue = table.columns[colIdx] || ''

	th.classList.add('dt-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.style.cssText = 'width:100%;padding:0.2rem 0.3rem;font-size:0.75rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;font-weight:600;'
	input.value = currentValue
	nameSpan.textContent = ''
	nameSpan.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim() || currentValue // 不允许空列名
		th.classList.remove('dt-cell-editing')
		nameSpan.textContent = newValue
		nameSpan.title = `点击编辑列名「${newValue}」`

		if (newValue !== currentValue) {
			diag.log(`columnNameEdit: #${table.id} col[${colIdx}] "${currentValue}" → "${newValue}"`)
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
	// 所有已有行补充空单元格
	for (const row of table.rows) {
		row.push('')
	}

	diag.log(`addColumn: #${table.id} 新列="${name.trim()}" 总列数=${table.columns.length}`)
	markDirty()
	renderGrid(table)
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	setStatus(`已添加列「${name.trim()}」`)
}

function deleteColumn(colIdx) {
	const table = tables[currentTableIndex]
	if (!table || table.columns.length <= 1) return

	const colName = table.columns[colIdx]
	if (!confirm(`确定删除列「${colName}」？该列所有数据将丢失。`)) return

	diag.log(`deleteColumn: #${table.id} col[${colIdx}]="${colName}" 影响行数=${table.rows.length}`)
	table.columns.splice(colIdx, 1)
	// 所有行同步删除对应位置的数据
	for (const row of table.rows) {
		if (colIdx < row.length) {
			row.splice(colIdx, 1)
		}
	}

	markDirty()
	renderGrid(table)
	_dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`
	setStatus(`已删除列「${colName}」`)
}

// ===== 表格名称编辑 =====

function startTableNameEdit() {
	const table = tables[currentTableIndex]
	if (!table) return

	const nameEl = _dom.tableName
	if (nameEl.classList.contains('dt-cell-editing')) return

	const currentValue = table.name || ''

	nameEl.classList.add('dt-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.style.cssText = 'width:200px;padding:0.15rem 0.3rem;font-size:0.75rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;font-weight:500;'
	input.value = currentValue
	nameEl.textContent = ''
	nameEl.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim() || currentValue // 不允许空名称
		nameEl.classList.remove('dt-cell-editing')
		nameEl.textContent = newValue

		if (newValue !== currentValue) {
			diag.log(`tableNameEdit: #${table.id} "${currentValue}" → "${newValue}"`)
			table.name = newValue
			markDirty()
			// 更新标签页 title
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
	if (ruleSpan.classList.contains('dt-cell-editing')) return

	const currentValue = table.rules[ruleKey] || ''

	ruleSpan.classList.add('dt-cell-editing')
	const input = document.createElement('input')
	input.type = 'text'
	input.style.cssText = 'width:250px;padding:0.1rem 0.25rem;font-size:0.6rem;border:1px solid var(--beilu-amber);border-radius:0.15rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;'
	input.value = currentValue
	ruleSpan.textContent = ''
	ruleSpan.appendChild(input)
	input.focus()
	input.select()

	const finishEdit = () => {
		const newValue = input.value.trim()
		ruleSpan.classList.remove('dt-cell-editing')
		ruleSpan.textContent = newValue || '-'

		if (newValue !== currentValue) {
			diag.log(`ruleEdit: #${table.id} ${ruleKey} "${currentValue}" → "${newValue}"`)
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

	const oldEnabled = table.enabled
	table.enabled = _dom.enabledCheckbox.checked
	diag.log(`toggleEnabled: #${table.id} "${table.name}" ${oldEnabled} → ${table.enabled}`)
	_dom.enabledLabel.textContent = table.enabled ? '已启用' : '已禁用'
	_dom.enabledLabel.style.color = table.enabled ? 'rgba(212,160,23,0.7)' : 'rgba(239,68,68,0.7)'

	markDirty()
	renderTableTabs() // 更新标签页样式
	renderStats()
	setStatus(`表格 #${table.id} 已${table.enabled ? '启用' : '禁用'}`)
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
			diag.debug(`cellEdit: #${table.id} [${rowIdx},${colIdx}] "${currentValue}" → "${newValue}"`)
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
	diag.debug(`addRow: #${table.id} 新行索引=${table.rows.length - 1} 总行数=${table.rows.length}`)
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

	diag.log(`deleteRow: #${table.id} row[${rowIdx}] 内容=${JSON.stringify(table.rows[rowIdx])}`)
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
	diag.log(`addNewTable: name="${name.trim()}" columns=[${columns.join(',')}]`)

	try {
		const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(currentUsername)}&char_id=${encodeURIComponent(currentCharId)}`
		const res = await diag.traceFetch(url, {
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

		diag.log('addNewTable: 创建成功, 重新加载数据')
		// 重新加载
		await loadTablesForChar(currentUsername, currentCharId)
		// 切换到新表格
		switchTable(tables.length - 1)
		setStatus(`表格「${name.trim()}」已创建`)
	} catch (err) {
		diag.error('addNewTable: 创建失败', err.message)
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

	diag.log(`deleteCurrentTable: #${table.id} "${table.name}" index=${currentTableIndex}`)
	setStatus('正在删除表格...')

	try {
		const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(currentUsername)}&char_id=${encodeURIComponent(currentCharId)}`
		const res = await diag.traceFetch(url, {
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

		diag.log('deleteCurrentTable: 删除成功, 重新加载数据')
		// 重新加载
		await loadTablesForChar(currentUsername, currentCharId)
		setStatus(`表格已删除`)
	} catch (err) {
		diag.error('deleteCurrentTable: 删除失败', err.message)
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

	diag.log(`saveCurrentTable: #${table.id} "${table.name}" rows=${table.rows.length} cols=${table.columns.length} enabled=${table.enabled}`)
	diag.snapshot('pre-save', {
		tableId: table.id,
		name: table.name,
		rowCount: table.rows.length,
		colCount: table.columns.length,
		enabled: table.enabled,
		rules: table.rules,
	})

	_dom.saveBtn.disabled = true
	_dom.saveBtn.textContent = '保存中...'
	setStatus('正在保存...')

	try {
		await saveTableToBackend(currentUsername, currentCharId, currentTableIndex, table)
		isDirty = false
		updateDirtyIndicator()
		diag.log(`saveCurrentTable: #${table.id} 保存成功`)
		setStatus(`表格 #${table.id} 保存成功`)
	} catch (err) {
		diag.error(`saveCurrentTable: #${table.id} 保存失败`, err.message)
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
	_dom.addColBtn?.addEventListener('click', addColumn)
	_dom.addTableBtn?.addEventListener('click', addNewTable)
	_dom.delTableBtn?.addEventListener('click', deleteCurrentTable)
	_dom.saveBtn?.addEventListener('click', saveCurrentTable)

	// 表格名称双击编辑
	_dom.tableName?.addEventListener('dblclick', startTableNameEdit)

	// 启用/禁用 toggle
	_dom.enabledCheckbox?.addEventListener('change', toggleTableEnabled)

	// 规则编辑
	_dom.ruleInsert?.addEventListener('click', () => startRuleEdit(_dom.ruleInsert, 'insert'))
	_dom.ruleUpdate?.addEventListener('click', () => startRuleEdit(_dom.ruleUpdate, 'update'))
	_dom.ruleDelete?.addEventListener('click', () => startRuleEdit(_dom.ruleDelete, 'delete'))
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

	diag.log('initDataTable: 初始化完成', options.charId ? `绑定: ${options.charId}` : '等待绑定')
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
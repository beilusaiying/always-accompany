/**
 * 变量管理器 UI（Phase 3 — 美化版）
 *
 * 提供可视化的变量查看/编辑面板，参考酒馆助手的变量管理器。
 * 数据源：variableStore.mjs 中的 window.__beiluVarStore
 *
 * 功能：
 * - 5 个作用域 tab（全局/预设/角色/聊天/消息楼层）
 * - 消息楼层：按楼层分区展示，支持追踪最新、楼层范围筛选
 * - 树状视图（可折叠、语法高亮）
 * - JSON 文本视图（只读，可复制）
 * - 自动刷新（监听 postMessage 变量变更事件）
 * - 编辑功能（双击编辑值）
 *
 * 使用方式：
 *   import { initVariableManager } from './stCompat/variableManager.mjs'
 *   initVariableManager(containerElement)
 */

import { createDiag } from '../../diagLogger.mjs'
import { replaceVariables } from './variableStore.mjs'

const diag = createDiag('stCompat')

// ============================================================
// 状态
// ============================================================

/** @type {HTMLElement|null} 容器元素 */
let _container = null

/** 当前选中的 tab */
let _activeTab = 'chat'

/** 当前视图模式（全局/预设/角色/聊天 tab 使用） */
let _viewMode = 'tree' // 'tree' | 'text'

/** 树节点折叠状态（path → boolean） */
const _collapsed = new Map()

/** postMessage 监听器引用 */
let _msgHandler = null

/** 自动刷新定时器 */
let _refreshTimer = null

// ── 消息楼层专用状态 ──
/** 是否追踪最新楼层 */
let _trackLatest = true

/** 楼层范围 */
let _floorRangeStart = 0
let _floorRangeEnd = Infinity

/** 展开的楼层 ID 集合 */
const _expandedFloors = new Set()

/** 每个楼层的视图模式 */
const _floorViewModes = new Map() // floorId → 'tree'|'text'

/** 每个楼层的树折叠状态 */
const _floorCollapsed = new Map() // `${floorId}.${path}` → boolean

// ============================================================
// 公开接口
// ============================================================

/**
 * 初始化变量管理器
 * @param {HTMLElement} container - 面板容器元素
 */
export function initVariableManager(container) {
	if (!container) return
	_container = container

	const store = window.__beiluVarStore
	if (!store) {
		diag.warn('[variableManager] __beiluVarStore 未初始化！变量管理器将显示空数据。')
	} else {
		diag.debug('[variableManager] __beiluVarStore 已存在:', {
			global: Object.keys(store.global || {}).length,
			preset: Object.keys(store.preset || {}).length,
			character: Object.keys(store.character || {}).length,
			chat: Object.keys(store.chat || {}).length,
			messages: Object.keys(store.messages || {}).length,
		})
	}

	// 渲染初始 UI
	_renderPanel()

	// 监听变量变更事件
	_msgHandler = (e) => {
		if (!e.data?.type) return
		if (e.data.type === 'beilu-var-replace' || e.data.type === 'beilu-var-update' || e.data.type === 'beilu-var-delete') {
			_scheduleRefresh()
		}
	}
	window.addEventListener('message', _msgHandler)

	diag.log('[variableManager] 变量管理器已初始化')
}

/**
 * 销毁变量管理器
 */
export function destroyVariableManager() {
	if (_msgHandler) {
		window.removeEventListener('message', _msgHandler)
		_msgHandler = null
	}
	if (_refreshTimer) {
		clearTimeout(_refreshTimer)
		_refreshTimer = null
	}
	if (_container) {
		_container.innerHTML = ''
		_container = null
	}
}

/**
 * 手动刷新面板
 */
export function refreshVariableManager() {
	if (!_container) return
	_renderContent()
}

// ============================================================
// 面板渲染
// ============================================================

function _renderPanel() {
	if (!_container) return

	_container.innerHTML = ''
	_container.className = 'var-manager'

	// ── Tab 栏 ──
	const tabBar = document.createElement('div')
	tabBar.className = 'var-tabs'

	const tabs = [
		{ id: 'global', label: '全局' },
		{ id: 'preset', label: '预设' },
		{ id: 'character', label: '角色' },
		{ id: 'chat', label: '聊天' },
		{ id: 'messages', label: '消息楼层' },
	]

	tabs.forEach(tab => {
		const btn = document.createElement('button')
		btn.className = `var-tab ${tab.id === _activeTab ? 'var-tab-active' : ''}`
		btn.textContent = tab.label
		btn.dataset.tab = tab.id
		btn.addEventListener('click', () => {
			_activeTab = tab.id
			tabBar.querySelectorAll('.var-tab').forEach(b => b.classList.toggle('var-tab-active', b.dataset.tab === _activeTab))
			_renderToolbar()
			_renderContent()
		})
		tabBar.appendChild(btn)
	})

	// ── 工具栏容器 ──
	const toolbarWrap = document.createElement('div')
	toolbarWrap.id = 'var-toolbar-wrap'

	// ── 内容区 ──
	const content = document.createElement('div')
	content.className = 'var-content'
	content.id = 'var-manager-content'

	_container.appendChild(tabBar)
	_container.appendChild(toolbarWrap)
	_container.appendChild(content)

	// 注入样式
	_injectStyles()

	// 渲染工具栏和内容
	_renderToolbar()
	_renderContent()
}

/**
 * 渲染工具栏（根据当前 tab 切换不同内容）
 */
function _renderToolbar() {
	const wrap = document.getElementById('var-toolbar-wrap')
	if (!wrap) return
	wrap.innerHTML = ''

	if (_activeTab === 'messages') {
		// ── 消息楼层专用工具栏 ──
		_renderFloorToolbar(wrap)
	} else {
		// ── 普通 tab 工具栏 ──
		_renderNormalToolbar(wrap)
	}
}

/**
 * 普通 tab 工具栏
 */
function _renderNormalToolbar(wrap) {
	const toolbar = document.createElement('div')
	toolbar.className = 'var-toolbar'

	// 视图切换
	const viewToggle = document.createElement('div')
	viewToggle.className = 'var-view-toggle'
	;['tree', 'text'].forEach(mode => {
		const btn = document.createElement('button')
		btn.className = `var-view-btn ${mode === _viewMode ? 'var-view-btn-active' : ''}`
		btn.textContent = mode === 'tree' ? '文本' : '树状'
		btn.dataset.mode = mode
		btn.addEventListener('click', () => {
			_viewMode = mode
			viewToggle.querySelectorAll('.var-view-btn').forEach(b => b.classList.toggle('var-view-btn-active', b.dataset.mode === _viewMode))
			_renderContent()
		})
		viewToggle.appendChild(btn)
	})
	toolbar.appendChild(viewToggle)

	// 工具按钮
	const toolBtns = document.createElement('div')
	toolBtns.className = 'var-tool-btns'

	const btnDefs = [
		{ icon: '⊟', title: '全部折叠', action: () => { _collapseAll(); _renderContent() } },
		{ icon: '⊞', title: '全部展开', action: () => { _collapsed.clear(); _renderContent() } },
		{ icon: '↺', title: '刷新', action: () => _renderContent() },
		{ icon: '⤓', title: '导出 JSON', action: _exportJson },
	]
	btnDefs.forEach(def => {
		const btn = document.createElement('button')
		btn.className = 'var-tool-btn'
		btn.textContent = def.icon
		btn.title = def.title
		btn.addEventListener('click', def.action)
		toolBtns.appendChild(btn)
	})
	toolbar.appendChild(toolBtns)

	wrap.appendChild(toolbar)
}

/**
 * 消息楼层工具栏
 */
function _renderFloorToolbar(wrap) {
	const toolbar = document.createElement('div')
	toolbar.className = 'var-floor-toolbar-main'

	// 追踪最新按钮
	const trackBtn = document.createElement('button')
	trackBtn.className = `var-floor-track-btn ${_trackLatest ? 'var-floor-track-active' : ''}`
	trackBtn.innerHTML = `<span class="var-floor-track-icon">⫿</span> 追踪最新`
	trackBtn.title = '自动展开最新楼层'
	trackBtn.addEventListener('click', () => {
		_trackLatest = !_trackLatest
		trackBtn.classList.toggle('var-floor-track-active', _trackLatest)
		if (_trackLatest) {
			_autoExpandLatest()
		}
		_renderContent()
	})
	toolbar.appendChild(trackBtn)

	// 楼层范围
	const rangeWrap = document.createElement('div')
	rangeWrap.className = 'var-floor-range'

	const startInput = document.createElement('input')
	startInput.className = 'var-floor-range-input'
	startInput.type = 'number'
	startInput.min = '0'
	startInput.value = String(_floorRangeStart)
	startInput.title = '起始楼层'
	startInput.addEventListener('change', () => {
		_floorRangeStart = parseInt(startInput.value) || 0
		_renderContent()
	})

	const sep = document.createElement('span')
	sep.className = 'var-floor-range-sep'
	sep.textContent = '楼 ~'

	const messages = _getMessagesData()
	const floorIds = Object.keys(messages).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
	const maxFloor = floorIds.length > 0 ? floorIds[floorIds.length - 1] : 0

	const endInput = document.createElement('input')
	endInput.className = 'var-floor-range-input'
	endInput.type = 'number'
	endInput.min = '0'
	endInput.value = _floorRangeEnd === Infinity ? String(maxFloor) : String(_floorRangeEnd)
	endInput.title = '结束楼层'
	endInput.addEventListener('change', () => {
		const v = parseInt(endInput.value)
		_floorRangeEnd = isNaN(v) ? Infinity : v
		_renderContent()
	})

	const endSuffix = document.createElement('span')
	endSuffix.className = 'var-floor-range-sep'
	endSuffix.textContent = '楼'

	rangeWrap.appendChild(startInput)
	rangeWrap.appendChild(sep)
	rangeWrap.appendChild(endInput)
	rangeWrap.appendChild(endSuffix)
	toolbar.appendChild(rangeWrap)

	// 最新楼层号提示
	const latestHint = document.createElement('span')
	latestHint.className = 'var-floor-latest-hint'
	latestHint.textContent = `最新楼层号:${maxFloor}`
	toolbar.appendChild(latestHint)

	// 工具按钮（导出 + 刷新）
	const toolBtns = document.createElement('div')
	toolBtns.className = 'var-tool-btns'
	const refreshBtn = document.createElement('button')
	refreshBtn.className = 'var-tool-btn'
	refreshBtn.textContent = '↺'
	refreshBtn.title = '刷新'
	refreshBtn.addEventListener('click', () => _renderContent())
	toolBtns.appendChild(refreshBtn)

	const exportBtn = document.createElement('button')
	exportBtn.className = 'var-tool-btn'
	exportBtn.textContent = '⤓'
	exportBtn.title = '导出全部楼层变量'
	exportBtn.addEventListener('click', _exportJson)
	toolBtns.appendChild(exportBtn)
	toolbar.appendChild(toolBtns)

	wrap.appendChild(toolbar)
}

// ============================================================
// 内容渲染
// ============================================================

/**
 * 渲染内容区域
 */
function _renderContent() {
	const content = document.getElementById('var-manager-content')
	if (!content) return

	if (_activeTab === 'messages') {
		_renderFloorView(content)
	} else {
		_renderNormalView(content)
	}
}

/**
 * 普通 tab 视图
 */
function _renderNormalView(content) {
	const data = _getActiveData()
	content.innerHTML = ''

	if (_viewMode === 'tree') {
		if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
			content.innerHTML = '<div class="var-empty">（空）</div>'
		} else {
			const tree = _renderJsonTree(data, '', 0)
			content.appendChild(tree)
		}
	} else {
		const pre = document.createElement('pre')
		pre.className = 'var-json-text'
		pre.textContent = JSON.stringify(data, null, 2)
		content.appendChild(pre)
	}
}

/**
 * 消息楼层视图 — 按楼层分区展示
 */
function _renderFloorView(content) {
	content.innerHTML = ''

	const messages = _getMessagesData()
	const floorIds = Object.keys(messages).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)

	if (floorIds.length === 0) {
		content.innerHTML = '<div class="var-empty">暂无楼层变量数据</div>'
		return
	}

	// 追踪最新
	if (_trackLatest && floorIds.length > 0) {
		_autoExpandLatest()
	}

	// 过滤范围
	const endVal = _floorRangeEnd === Infinity ? Infinity : _floorRangeEnd
	const visibleFloors = floorIds.filter(id => id >= _floorRangeStart && id <= endVal)

	if (visibleFloors.length === 0) {
		content.innerHTML = '<div class="var-empty">指定范围内暂无楼层数据</div>'
		return
	}

	// 倒序显示（最新在上）
	const reversed = [...visibleFloors].reverse()

	reversed.forEach(floorId => {
		const floorData = messages[String(floorId)] || {}
		const panel = _renderFloorPanel(floorId, floorData)
		content.appendChild(panel)
	})
}

/**
 * 渲染单个楼层面板
 */
function _renderFloorPanel(floorId, data) {
	const isExpanded = _expandedFloors.has(floorId)
	const viewMode = _floorViewModes.get(floorId) || 'tree'
	const keyCount = typeof data === 'object' ? Object.keys(data).length : 0

	const panel = document.createElement('div')
	panel.className = `var-floor ${isExpanded ? 'var-floor-expanded' : ''}`

	// ── 楼层头部 ──
	const header = document.createElement('div')
	header.className = 'var-floor-header'
	header.addEventListener('click', () => {
		if (_expandedFloors.has(floorId)) {
			_expandedFloors.delete(floorId)
		} else {
			_expandedFloors.add(floorId)
		}
		_renderContent()
	})

	const chevron = document.createElement('span')
	chevron.className = 'var-floor-chevron'
	chevron.textContent = isExpanded ? '▼' : '▶'

	const title = document.createElement('span')
	title.className = 'var-floor-title'
	title.textContent = `第 ${floorId} 楼`

	const badge = document.createElement('span')
	badge.className = 'var-floor-badge'
	badge.textContent = keyCount > 0 ? `${keyCount} 项` : '空'

	const expandIcon = document.createElement('span')
	expandIcon.className = 'var-floor-expand-icon'
	expandIcon.textContent = isExpanded ? '∧' : '∨'

	header.appendChild(chevron)
	header.appendChild(title)
	header.appendChild(badge)
	header.appendChild(expandIcon)
	panel.appendChild(header)

	// ── 楼层内容 ──
	if (isExpanded) {
		const body = document.createElement('div')
		body.className = 'var-floor-body'

		// 楼层内工具栏
		const floorTools = document.createElement('div')
		floorTools.className = 'var-floor-inner-toolbar'

		// 视图切换
		const viewToggle = document.createElement('div')
		viewToggle.className = 'var-view-toggle'
		;['tree', 'text'].forEach(mode => {
			const btn = document.createElement('button')
			btn.className = `var-view-btn ${mode === viewMode ? 'var-view-btn-active' : ''}`
			btn.textContent = mode === 'tree' ? '文本' : '树状'
			btn.dataset.mode = mode
			btn.addEventListener('click', (e) => {
				e.stopPropagation()
				_floorViewModes.set(floorId, mode)
				_renderContent()
			})
			viewToggle.appendChild(btn)
		})
		floorTools.appendChild(viewToggle)

		// 小工具按钮
		const miniTools = document.createElement('div')
		miniTools.className = 'var-tool-btns'

		// 折叠本楼所有
		const collapseBtn = document.createElement('button')
		collapseBtn.className = 'var-tool-btn var-tool-btn-sm'
		collapseBtn.textContent = '⊟'
		collapseBtn.title = '折叠本楼所有'
		collapseBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			// 折叠本楼所有第一层 key
			if (data && typeof data === 'object') {
				Object.keys(data).forEach(k => _floorCollapsed.set(`${floorId}.${k}`, true))
			}
			_renderContent()
		})
		miniTools.appendChild(collapseBtn)

		const expandBtn = document.createElement('button')
		expandBtn.className = 'var-tool-btn var-tool-btn-sm'
		expandBtn.textContent = '⊞'
		expandBtn.title = '展开本楼所有'
		expandBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			// 清除本楼所有折叠状态
			for (const key of _floorCollapsed.keys()) {
				if (key.startsWith(`${floorId}.`)) _floorCollapsed.delete(key)
			}
			_renderContent()
		})
		miniTools.appendChild(expandBtn)

		// 搜索（暂用 prompt 简单实现）
		const searchBtn = document.createElement('button')
		searchBtn.className = 'var-tool-btn var-tool-btn-sm'
		searchBtn.textContent = '🔍'
		searchBtn.title = '搜索'
		searchBtn.addEventListener('click', (e) => {
			e.stopPropagation()
			const keyword = prompt('搜索变量名:')
			if (keyword) {
				const results = _searchInData(data, keyword)
				if (results.length > 0) {
					alert(`找到 ${results.length} 个匹配:\n${results.join('\n')}`)
				} else {
					alert('未找到匹配项')
				}
			}
		})
		miniTools.appendChild(searchBtn)

		floorTools.appendChild(miniTools)
		body.appendChild(floorTools)

		// 内容区
		const contentArea = document.createElement('div')
		contentArea.className = 'var-floor-content'

		if (viewMode === 'tree') {
			if (keyCount === 0) {
				contentArea.innerHTML = '<div class="var-empty">（空）</div>'
			} else {
				const tree = _renderFloorTree(floorId, data, '', 0)
				contentArea.appendChild(tree)
			}
		} else {
			const pre = document.createElement('pre')
			pre.className = 'var-json-text'
			pre.textContent = JSON.stringify(data, null, 2)
			contentArea.appendChild(pre)
		}

		body.appendChild(contentArea)
		panel.appendChild(body)
	}

	return panel
}

// ============================================================
// 数据访问
// ============================================================

function _getActiveData() {
	const store = window.__beiluVarStore
	if (!store) return {}

	switch (_activeTab) {
		case 'global': return store.global || {}
		case 'preset': return store.preset || {}
		case 'character': return store.character || {}
		case 'chat': return store.chat || {}
		case 'messages': return store.messages || {}
		default: return store.chat || {}
	}
}

function _getMessagesData() {
	const store = window.__beiluVarStore
	return store?.messages || {}
}

// ============================================================
// 树状视图渲染（普通 tab）
// ============================================================

function _renderJsonTree(data, path, depth) {
	const container = document.createElement('div')
	container.className = 'var-tree-container'

	if (data === null || data === undefined) {
		const nullNode = document.createElement('span')
		nullNode.className = 'var-val var-val-null'
		nullNode.textContent = 'null'
		container.appendChild(nullNode)
		return container
	}

	if (typeof data !== 'object') {
		const valNode = _createValueNode(data, path)
		container.appendChild(valNode)
		return container
	}

	const isArray = Array.isArray(data)
	const entries = isArray ? data.map((v, i) => [String(i), v]) : Object.entries(data)

	if (entries.length === 0) {
		const emptyNode = document.createElement('span')
		emptyNode.className = 'var-val var-val-empty'
		emptyNode.textContent = isArray ? '[ ]' : '{ }'
		container.appendChild(emptyNode)
		return container
	}

	entries.forEach(([key, value]) => {
		const childPath = path ? `${path}.${key}` : key
		const isCollapsed = _collapsed.get(childPath)
		const isObject = value !== null && typeof value === 'object'

		const row = document.createElement('div')
		row.className = 'var-tree-row'
		row.style.paddingLeft = `${depth * 16}px`

		if (isObject) {
			// 可折叠节点
			const toggle = document.createElement('span')
			toggle.className = 'var-toggle'
			toggle.textContent = isCollapsed ? '▶' : '▼'
			toggle.addEventListener('click', (e) => {
				e.stopPropagation()
				if (_collapsed.get(childPath)) {
					_collapsed.delete(childPath)
				} else {
					_collapsed.set(childPath, true)
				}
				_renderContent()
			})
			row.appendChild(toggle)

			const keyNode = document.createElement('span')
			keyNode.className = 'var-key'
			keyNode.textContent = key

			const typeHint = document.createElement('span')
			typeHint.className = 'var-type-hint'
			typeHint.textContent = Array.isArray(value)
				? ` [${value.length}项]`
				: ` {${Object.keys(value).length}}`

			row.appendChild(keyNode)
			row.appendChild(document.createTextNode(' : '))
			row.appendChild(typeHint)
			container.appendChild(row)

			if (!isCollapsed) {
				const childTree = _renderJsonTree(value, childPath, depth + 1)
				container.appendChild(childTree)
			}
		} else {
			_renderLeafRow(row, key, value, childPath)
			container.appendChild(row)
		}
	})

	return container
}

// ============================================================
// 树状视图渲染（楼层专用 — 使用 _floorCollapsed）
// ============================================================

function _renderFloorTree(floorId, data, path, depth) {
	const container = document.createElement('div')
	container.className = 'var-tree-container'

	if (data === null || data === undefined) {
		const nullNode = document.createElement('span')
		nullNode.className = 'var-val var-val-null'
		nullNode.textContent = 'null'
		container.appendChild(nullNode)
		return container
	}

	if (typeof data !== 'object') {
		const valNode = _createValueNode(data, `floor:${floorId}:${path}`)
		container.appendChild(valNode)
		return container
	}

	const isArray = Array.isArray(data)
	const entries = isArray ? data.map((v, i) => [String(i), v]) : Object.entries(data)

	if (entries.length === 0) {
		const emptyNode = document.createElement('span')
		emptyNode.className = 'var-val var-val-empty'
		emptyNode.textContent = isArray ? '[ ]' : '{ }'
		container.appendChild(emptyNode)
		return container
	}

	entries.forEach(([key, value]) => {
		const childPath = path ? `${path}.${key}` : key
		const collapsedKey = `${floorId}.${childPath}`
		const isCollapsed = _floorCollapsed.get(collapsedKey)
		const isObject = value !== null && typeof value === 'object'

		const row = document.createElement('div')
		row.className = 'var-tree-row'
		row.style.paddingLeft = `${depth * 16}px`

		if (isObject) {
			// 可折叠节点
			const toggle = document.createElement('span')
			toggle.className = 'var-toggle'
			toggle.textContent = isCollapsed ? '▶' : '▼'
			toggle.addEventListener('click', (e) => {
				e.stopPropagation()
				if (_floorCollapsed.get(collapsedKey)) {
					_floorCollapsed.delete(collapsedKey)
				} else {
					_floorCollapsed.set(collapsedKey, true)
				}
				_renderContent()
			})
			row.appendChild(toggle)

			const keyNode = document.createElement('span')
			keyNode.className = 'var-key'
			keyNode.textContent = key

			const typeHint = document.createElement('span')
			typeHint.className = 'var-type-hint'
			typeHint.textContent = Array.isArray(value)
				? ` [${value.length}项]`
				: ` {${Object.keys(value).length}}`

			row.appendChild(keyNode)
			row.appendChild(document.createTextNode(' : '))
			row.appendChild(typeHint)
			container.appendChild(row)

			if (!isCollapsed) {
				const childTree = _renderFloorTree(floorId, value, childPath, depth + 1)
				container.appendChild(childTree)
			}
		} else {
			_renderLeafRow(row, key, value, `floor:${floorId}:${childPath}`)
			container.appendChild(row)
		}
	})

	return container
}

// ============================================================
// 共用行渲染
// ============================================================

function _renderLeafRow(row, key, value, path) {
	const indent = document.createElement('span')
	indent.className = 'var-indent'
	indent.textContent = '  '
	row.appendChild(indent)

	const keyNode = document.createElement('span')
	keyNode.className = 'var-key'
	keyNode.textContent = key

	const valNode = _createValueNode(value, path)

	row.appendChild(keyNode)
	row.appendChild(document.createTextNode(' : '))
	row.appendChild(valNode)
}

// ============================================================
// 值节点（语法高亮 + 双击编辑）
// ============================================================

function _createValueNode(value, path) {
	const span = document.createElement('span')

	if (typeof value === 'boolean') {
		span.className = `var-val var-val-bool var-val-bool-${value}`
		const indicator = document.createElement('span')
		indicator.className = 'var-bool-indicator'
		indicator.textContent = value ? '☑' : '☐'
		span.appendChild(indicator)
		span.appendChild(document.createTextNode(` ${value}`))
	} else if (typeof value === 'number') {
		span.className = 'var-val var-val-number'
		span.textContent = String(value)
	} else if (typeof value === 'string') {
		span.className = 'var-val var-val-string'
		const display = value.length > 80 ? value.substring(0, 80) + '…' : value
		span.textContent = `"${display}"`
		if (value.length > 80) span.title = value
	} else if (value === null) {
		span.className = 'var-val var-val-null'
		span.textContent = 'null'
	} else if (value === undefined) {
		span.className = 'var-val var-val-null'
		span.textContent = 'undefined'
	} else {
		span.className = 'var-val'
		span.textContent = String(value)
	}

	// 双击编辑
	span.addEventListener('dblclick', (e) => {
		e.stopPropagation()
		_startInlineEdit(span, value, path)
	})

	return span
}

// ============================================================
// 内联编辑
// ============================================================

function _startInlineEdit(span, originalValue, path) {
	const input = document.createElement('input')
	input.className = 'var-inline-edit'
	input.type = 'text'
	input.value = typeof originalValue === 'string' ? originalValue : JSON.stringify(originalValue)

	const originalText = span.textContent
	span.textContent = ''
	span.appendChild(input)
	input.focus()
	input.select()

	const commit = () => {
		const raw = input.value
		let newValue
		if (raw === 'true') newValue = true
		else if (raw === 'false') newValue = false
		else if (raw === 'null') newValue = null
		else if (raw !== '' && !isNaN(Number(raw))) newValue = Number(raw)
		else newValue = raw

		_setValueByPath(path, newValue)
		_renderContent()
	}

	const cancel = () => {
		span.textContent = originalText
	}

	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); commit() }
		if (e.key === 'Escape') { e.preventDefault(); cancel() }
	})
	input.addEventListener('blur', commit)
}

function _setValueByPath(path, value) {
	const store = window.__beiluVarStore
	if (!store) return

	const parts = path.split('.')
	const scopeData = _getActiveData()

	if (parts.length === 1) {
		scopeData[parts[0]] = value
	} else {
		let obj = scopeData
		for (let i = 0; i < parts.length - 1; i++) {
			if (obj[parts[i]] === undefined || obj[parts[i]] === null) {
				obj[parts[i]] = {}
			}
			obj = obj[parts[i]]
		}
		obj[parts[parts.length - 1]] = value
	}

	replaceVariables(scopeData, { scope: _activeTab === 'messages' ? 'chat' : _activeTab })
}

// ============================================================
// 辅助方法
// ============================================================

function _collapseAll() {
	_collapsed.clear()
	const data = _getActiveData()
	if (data && typeof data === 'object') {
		Object.keys(data).forEach(k => _collapsed.set(k, true))
	}
}

function _autoExpandLatest() {
	const messages = _getMessagesData()
	const floorIds = Object.keys(messages).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
	if (floorIds.length > 0) {
		const latest = floorIds[floorIds.length - 1]
		_expandedFloors.add(latest)
	}
}

function _exportJson() {
	const data = _getActiveData()
	const json = JSON.stringify(data, null, 2)
	const blob = new Blob([json], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = `beilu-vars-${_activeTab}.json`
	a.click()
	URL.revokeObjectURL(url)
}

function _searchInData(data, keyword, prefix = '') {
	const results = []
	if (!data || typeof data !== 'object') return results
	const lowerKw = keyword.toLowerCase()

	Object.entries(data).forEach(([key, val]) => {
		const fullPath = prefix ? `${prefix}.${key}` : key
		if (key.toLowerCase().includes(lowerKw)) {
			results.push(fullPath)
		}
		if (val && typeof val === 'object') {
			results.push(..._searchInData(val, keyword, fullPath))
		}
	})
	return results
}

// ============================================================
// 刷新控制
// ============================================================

function _scheduleRefresh() {
	if (_refreshTimer) return
	_refreshTimer = setTimeout(() => {
		_refreshTimer = null
		_renderContent()
	}, 500)
}

// ============================================================
// 样式注入
// ============================================================

let _stylesInjected = false

function _injectStyles() {
	if (_stylesInjected) return
	_stylesInjected = true

	const style = document.createElement('style')
	style.textContent = `
/* ============================================================ */
/* 变量管理器样式（美化版）                                     */
/* ============================================================ */

.var-manager {
	display: flex;
	flex-direction: column;
	height: 100%;
	font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
	font-size: 12px;
	color: #d4d4d4;
	background: rgba(24, 24, 28, 0.97);
	border-radius: 6px;
	overflow: hidden;
}

/* ── Tab 栏 ── */
.var-tabs {
	display: flex;
	gap: 0;
	border-bottom: 1px solid rgba(255,255,255,0.08);
	flex-shrink: 0;
	background: rgba(20, 20, 24, 0.9);
}
.var-tab {
	flex: 1;
	padding: 7px 4px;
	background: none;
	border: none;
	color: #888;
	font-size: 11px;
	font-weight: 500;
	cursor: pointer;
	transition: all 0.15s;
	border-bottom: 2px solid transparent;
	letter-spacing: 0.5px;
}
.var-tab:hover { color: #ccc; background: rgba(255,255,255,0.04); }
.var-tab-active {
	color: #f59e0b;
	border-bottom-color: #f59e0b;
	background: rgba(245, 158, 11, 0.06);
}

/* ── 工具栏 ── */
.var-toolbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 4px 8px;
	border-bottom: 1px solid rgba(255,255,255,0.06);
	flex-shrink: 0;
	background: rgba(30, 30, 34, 0.6);
}

.var-view-toggle {
	display: flex;
	gap: 1px;
	background: rgba(255,255,255,0.04);
	border-radius: 4px;
	padding: 1px;
}
.var-view-btn {
	padding: 3px 10px;
	background: none;
	border: none;
	border-radius: 3px;
	color: #888;
	font-size: 11px;
	cursor: pointer;
	transition: all 0.15s;
}
.var-view-btn:hover { color: #ccc; }
.var-view-btn-active {
	color: #f59e0b;
	background: rgba(245, 158, 11, 0.15);
}

.var-tool-btns {
	display: flex;
	gap: 3px;
}
.var-tool-btn {
	width: 26px;
	height: 26px;
	display: flex;
	align-items: center;
	justify-content: center;
	background: none;
	border: 1px solid rgba(255,255,255,0.08);
	border-radius: 4px;
	color: #888;
	font-size: 13px;
	cursor: pointer;
	transition: all 0.15s;
}
.var-tool-btn:hover { color: #f59e0b; border-color: rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.06); }
.var-tool-btn-sm {
	width: 22px;
	height: 22px;
	font-size: 11px;
}

/* ── 内容区 ── */
.var-content {
	flex: 1;
	overflow: auto;
	padding: 6px;
	min-height: 0;
}

/* ── 空状态 ── */
.var-empty {
	color: #555;
	text-align: center;
	padding: 32px 0;
	font-style: italic;
	font-size: 12px;
}

/* ── JSON 文本视图 ── */
.var-json-text {
	margin: 0;
	padding: 0;
	font-size: 11px;
	line-height: 1.6;
	color: #d4d4d4;
	white-space: pre-wrap;
	word-break: break-all;
	user-select: text;
}

/* ============================================================ */
/* 树状视图                                                     */
/* ============================================================ */

.var-tree-container { }
.var-tree-row {
	display: flex;
	align-items: center;
	gap: 4px;
	line-height: 1.9;
	white-space: nowrap;
	cursor: default;
	border-radius: 2px;
}
.var-tree-row:hover {
	background: rgba(245, 158, 11, 0.04);
}

.var-toggle {
	width: 14px;
	flex-shrink: 0;
	cursor: pointer;
	color: #666;
	font-size: 9px;
	text-align: center;
	user-select: none;
	transition: color 0.15s;
}
.var-toggle:hover { color: #f59e0b; }

.var-indent {
	width: 14px;
	flex-shrink: 0;
}

.var-key {
	color: #9cdcfe;
	flex-shrink: 0;
	font-weight: 500;
}

.var-type-hint {
	color: #555;
	font-size: 10px;
	font-style: italic;
}

/* ── 值样式 ── */
.var-val {
	cursor: text;
}
.var-val-string { color: #ce9178; }
.var-val-number { color: #b5cea8; font-weight: 600; }
.var-val-bool { font-weight: 600; }
.var-val-bool-true { color: #4ec9b0; }
.var-val-bool-false { color: #f14c4c; }
.var-val-null { color: #555; font-style: italic; }
.var-val-empty { color: #555; }
.var-bool-indicator { margin-right: 2px; font-size: 11px; }

/* ── 内联编辑 ── */
.var-inline-edit {
	background: rgba(0,0,0,0.6);
	border: 1px solid #f59e0b;
	border-radius: 3px;
	color: #d4d4d4;
	font-family: inherit;
	font-size: 11px;
	padding: 2px 6px;
	outline: none;
	min-width: 80px;
	max-width: 300px;
	box-shadow: 0 0 8px rgba(245, 158, 11, 0.2);
}

/* ============================================================ */
/* 消息楼层专用样式                                             */
/* ============================================================ */

/* 楼层主工具栏 */
.var-floor-toolbar-main {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 5px 8px;
	border-bottom: 1px solid rgba(255,255,255,0.06);
	flex-shrink: 0;
	flex-wrap: wrap;
	background: rgba(30, 30, 34, 0.6);
}

/* 追踪最新按钮 */
.var-floor-track-btn {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 3px 10px;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 4px;
	background: none;
	color: #888;
	font-size: 11px;
	cursor: pointer;
	transition: all 0.2s;
	white-space: nowrap;
}
.var-floor-track-btn:hover { color: #ccc; border-color: rgba(255,255,255,0.2); }
.var-floor-track-active {
	color: #4ec9b0;
	border-color: rgba(78, 201, 176, 0.4);
	background: rgba(78, 201, 176, 0.08);
}
.var-floor-track-icon {
	font-size: 13px;
	font-weight: bold;
}

/* 楼层范围 */
.var-floor-range {
	display: flex;
	align-items: center;
	gap: 4px;
}
.var-floor-range-input {
	width: 48px;
	padding: 2px 4px;
	background: rgba(0,0,0,0.3);
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 3px;
	color: #d4d4d4;
	font-family: inherit;
	font-size: 11px;
	text-align: center;
	outline: none;
}
.var-floor-range-input:focus { border-color: #f59e0b; }
.var-floor-range-sep {
	color: #666;
	font-size: 11px;
}

/* 最新楼层号提示 */
.var-floor-latest-hint {
	color: #555;
	font-size: 10px;
	margin-left: auto;
	white-space: nowrap;
}

/* ── 楼层面板 ── */
.var-floor {
	margin-bottom: 4px;
	border: 1px solid rgba(255,255,255,0.06);
	border-radius: 6px;
	overflow: hidden;
	transition: border-color 0.2s;
}
.var-floor:hover {
	border-color: rgba(255,255,255,0.1);
}
.var-floor-expanded {
	border-color: rgba(245, 158, 11, 0.2);
}
.var-floor-expanded:hover {
	border-color: rgba(245, 158, 11, 0.3);
}

/* 楼层头部 */
.var-floor-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	background: rgba(40, 40, 46, 0.8);
	cursor: pointer;
	user-select: none;
	transition: background 0.15s;
}
.var-floor-header:hover {
	background: rgba(50, 50, 56, 0.9);
}

.var-floor-chevron {
	color: #666;
	font-size: 9px;
	width: 12px;
	text-align: center;
	transition: color 0.15s;
}
.var-floor-expanded .var-floor-chevron { color: #f59e0b; }

.var-floor-title {
	font-weight: 600;
	font-size: 12px;
	color: #ccc;
}
.var-floor-expanded .var-floor-title { color: #f59e0b; }

.var-floor-badge {
	font-size: 10px;
	color: #666;
	background: rgba(255,255,255,0.05);
	padding: 1px 6px;
	border-radius: 8px;
}

.var-floor-expand-icon {
	margin-left: auto;
	color: #555;
	font-size: 11px;
}

/* 楼层内容 */
.var-floor-body {
	border-top: 1px solid rgba(255,255,255,0.04);
	background: rgba(24, 24, 28, 0.5);
}

.var-floor-inner-toolbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 3px 8px;
	border-bottom: 1px solid rgba(255,255,255,0.03);
	background: rgba(35, 35, 40, 0.5);
}

.var-floor-content {
	padding: 6px 8px;
	max-height: 400px;
	overflow-y: auto;
}

/* 自定义滚动条 */
.var-content::-webkit-scrollbar,
.var-floor-content::-webkit-scrollbar {
	width: 6px;
}
.var-content::-webkit-scrollbar-track,
.var-floor-content::-webkit-scrollbar-track {
	background: transparent;
}
.var-content::-webkit-scrollbar-thumb,
.var-floor-content::-webkit-scrollbar-thumb {
	background: rgba(255,255,255,0.1);
	border-radius: 3px;
}
.var-content::-webkit-scrollbar-thumb:hover,
.var-floor-content::-webkit-scrollbar-thumb:hover {
	background: rgba(255,255,255,0.2);
}
`
	document.head.appendChild(style)
}
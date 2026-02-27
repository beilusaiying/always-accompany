/**
 * 插件管理器 UI
 *
 * 在助手选项卡中提供插件开关面板，
 * 当前支持 beilu-mvu（MVU 变量系统）和 beilu-ejs（EJS 模板渲染）的启用/禁用。
 *
 * 使用 localStorage 存取开关状态（插件无需注册 config 处理器）。
 * MVU 开关联动：关闭时隐藏变量管理器和脚本管理器 tab。
 *
 * 使用方式：
 *   import { initPluginManager } from './stCompat/pluginManager.mjs'
 *   initPluginManager(containerElement)
 */

import { createDiag } from '../../diagLogger.mjs'

const diag = createDiag('stCompat')

// ============================================================
// 插件定义
// ============================================================

const PLUGINS = [
	{
		id: 'beilu-mvu',
		name: 'MVU 变量系统',
		icon: '📊',
		description: '兼容 JS-Slash-Runner (酒馆助手) 的 MVU 变量累积、初始化、命令解析、YAML 注入',
		storageKey: 'beilu-st-compat-enabled',
		defaultEnabled: true,
	},
	{
		id: 'beilu-ejs',
		name: 'EJS 模板渲染',
		icon: '📝',
		description: '兼容 ST-Prompt-Template 的 EJS 模板语法，在提示词中嵌入变量和条件逻辑',
		storageKey: 'beilu-plugin-ejs-enabled',
		defaultEnabled: true,
	},
]

// ============================================================
// 状态
// ============================================================

/** @type {HTMLElement|null} */
let _container = null

/** 插件状态缓存 { pluginId: { enabled, loading, error } } */
const _states = new Map()

// ============================================================
// 公开接口
// ============================================================

/**
 * 初始化插件管理器
 * @param {HTMLElement} container
 */
export function initPluginManager(container) {
	if (!container) return
	_container = container

	// 初始化状态
	PLUGINS.forEach(p => {
		_states.set(p.id, { enabled: false, loading: true, error: null })
	})

	// 渲染 UI
	_renderPanel()

	// 加载所有插件状态
	_loadAllStates()

	diag.log('[pluginManager] 插件管理器已初始化')
}

/**
 * 获取插件是否启用
 * @param {string} pluginId - 插件 ID
 * @returns {boolean}
 */
export function getPluginEnabled(pluginId) {
	const plugin = PLUGINS.find(p => p.id === pluginId)
	if (!plugin) return true
	try {
		const stored = localStorage.getItem(plugin.storageKey)
		return stored !== null ? stored === 'true' : plugin.defaultEnabled
	} catch {
		return plugin.defaultEnabled
	}
}

/**
 * 销毁插件管理器
 */
export function destroyPluginManager() {
	if (_container) {
		_container.innerHTML = ''
		_container = null
	}
}

// ============================================================
// 渲染
// ============================================================

function _renderPanel() {
	if (!_container) return
	_container.innerHTML = ''
	_container.className = 'plugin-manager'

	// 头部
	const header = document.createElement('div')
	header.className = 'pm-header'
	header.innerHTML = `
		<div class="pm-title">
			<span class="pm-title-icon">🧩</span>
			<span>脚本插件管理</span>
		</div>
		<button class="pm-refresh-btn" title="刷新状态">↺</button>
	`
	header.querySelector('.pm-refresh-btn').addEventListener('click', () => _loadAllStates())
	_container.appendChild(header)

	// 插件列表
	const list = document.createElement('div')
	list.className = 'pm-list'
	list.id = 'pm-plugin-list'

	PLUGINS.forEach(plugin => {
		const card = _renderPluginCard(plugin)
		list.appendChild(card)
	})

	_container.appendChild(list)

	// 注入样式
	_injectStyles()
}

function _renderPluginCard(plugin) {
	const state = _states.get(plugin.id) || { enabled: false, loading: true, error: null }

	const card = document.createElement('div')
	card.className = `pm-card ${state.enabled ? 'pm-card-enabled' : ''} ${state.loading ? 'pm-card-loading' : ''}`
	card.id = `pm-card-${plugin.id}`

	card.innerHTML = `
		<div class="pm-card-header">
			<span class="pm-card-icon">${plugin.icon}</span>
			<div class="pm-card-info">
				<span class="pm-card-name">${plugin.name}</span>
				<span class="pm-card-id">${plugin.id}</span>
			</div>
			<div class="pm-card-toggle-wrap">
				${state.loading
			? '<span class="pm-loading-spinner">⏳</span>'
			: `<label class="pm-toggle-label">
						<input type="checkbox" class="pm-toggle" data-plugin-id="${plugin.id}" ${state.enabled ? 'checked' : ''} />
						<span class="pm-toggle-track">
							<span class="pm-toggle-thumb"></span>
						</span>
					</label>`
		}
			</div>
		</div>
		<div class="pm-card-desc">${plugin.description}</div>
		${state.error ? `<div class="pm-card-error">⚠️ ${state.error}</div>` : ''}
		<div class="pm-card-status">
			<span class="pm-status-dot ${state.enabled ? 'pm-status-on' : 'pm-status-off'}"></span>
			<span class="pm-status-text">${state.loading ? '加载中...' : state.enabled ? '已启用' : '已禁用'}</span>
		</div>
	`

	// 绑定开关事件
	const toggle = card.querySelector('.pm-toggle')
	if (toggle) {
		toggle.addEventListener('change', () => _togglePlugin(plugin.id, toggle.checked))
	}

	return card
}

function _updateCard(pluginId) {
	const existing = document.getElementById(`pm-card-${pluginId}`)
	if (!existing) return

	const plugin = PLUGINS.find(p => p.id === pluginId)
	if (!plugin) return

	const newCard = _renderPluginCard(plugin)
	existing.replaceWith(newCard)
}

// ============================================================
// 数据操作
// ============================================================

function _loadAllStates() {
	PLUGINS.forEach(plugin => {
		const state = _states.get(plugin.id)
		state.loading = false
		state.error = null
		try {
			const stored = localStorage.getItem(plugin.storageKey)
			state.enabled = stored !== null ? stored === 'true' : plugin.defaultEnabled
		} catch {
			state.enabled = plugin.defaultEnabled
		}
		_updateCard(plugin.id)
	})
	// 同步变量管理器/脚本管理器 tab 显隐
	_syncMvuRelatedTabs()
}

function _togglePlugin(pluginId, enabled) {
	const plugin = PLUGINS.find(p => p.id === pluginId)
	const state = _states.get(pluginId)
	if (!plugin || !state) return

	try {
		localStorage.setItem(plugin.storageKey, enabled ? 'true' : 'false')
		state.enabled = enabled
		state.loading = false
		state.error = null
		diag.log(`[pluginManager] ${pluginId} ${enabled ? '已启用' : '已禁用'}`)
	} catch (err) {
		state.loading = false
		state.error = err.message
		diag.warn(`[pluginManager] 切换 ${pluginId} 失败:`, err.message)
	}

	_updateCard(pluginId)
	// 同步变量管理器/脚本管理器 tab 显隐
	_syncMvuRelatedTabs()
}

/**
 * 同步变量管理器 tab 的显隐（根据 beilu-mvu 开关状态）
 * MVU 关闭时：隐藏变量管理器 tab，如正在查看则自动切回正则 tab
 */
function _syncMvuRelatedTabs() {
	const mvuState = _states.get('beilu-mvu')
	const mvuEnabled = mvuState ? mvuState.enabled : true

	// 隐藏/显示变量管理器 tab 按钮
	const varTab = document.querySelector('.helper-sub-tab[data-helper-tab="variables"]')
	if (varTab) varTab.style.display = mvuEnabled ? '' : 'none'

	// 如果 MVU 被关闭且当前正在查看变量面板，自动切到正则面板
	if (!mvuEnabled) {
		const varPanel = document.getElementById('helper-panel-variables')
		if (varPanel && varPanel.style.display !== 'none') {
			document.querySelectorAll('.helper-sub-tab').forEach(t => {
				t.classList.toggle('helper-sub-tab-active', t.dataset.helperTab === 'regex')
			})
			document.querySelectorAll('.helper-panel').forEach(panel => {
				panel.style.display = panel.id === 'helper-panel-regex' ? '' : 'none'
			})
		}
	}
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
/* 插件管理器样式                                               */
/* ============================================================ */

.plugin-manager {
	display: flex;
	flex-direction: column;
	height: 100%;
	font-family: system-ui, -apple-system, sans-serif;
	font-size: 13px;
	color: #d4d4d4;
	background: rgba(24, 24, 28, 0.97);
	border-radius: 6px;
	overflow: hidden;
}

/* ── 头部 ── */
.pm-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid rgba(255,255,255,0.08);
	background: rgba(20, 20, 24, 0.9);
	flex-shrink: 0;
}

.pm-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-weight: 600;
	font-size: 14px;
	color: #f59e0b;
}

.pm-title-icon {
	font-size: 16px;
}

.pm-refresh-btn {
	width: 28px;
	height: 28px;
	display: flex;
	align-items: center;
	justify-content: center;
	background: none;
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 5px;
	color: #888;
	font-size: 15px;
	cursor: pointer;
	transition: all 0.15s;
}
.pm-refresh-btn:hover {
	color: #f59e0b;
	border-color: rgba(245, 158, 11, 0.3);
	background: rgba(245, 158, 11, 0.06);
}

/* ── 插件列表 ── */
.pm-list {
	flex: 1;
	overflow-y: auto;
	padding: 10px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* ── 插件卡片 ── */
.pm-card {
	border: 1px solid rgba(255,255,255,0.08);
	border-radius: 8px;
	padding: 12px 14px;
	background: rgba(35, 35, 40, 0.7);
	transition: all 0.2s;
}
.pm-card:hover {
	border-color: rgba(255,255,255,0.12);
	background: rgba(40, 40, 46, 0.8);
}
.pm-card-enabled {
	border-color: rgba(245, 158, 11, 0.25);
	background: rgba(245, 158, 11, 0.04);
}
.pm-card-enabled:hover {
	border-color: rgba(245, 158, 11, 0.35);
}
.pm-card-loading {
	opacity: 0.7;
}

.pm-card-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 6px;
}

.pm-card-icon {
	font-size: 22px;
	flex-shrink: 0;
}

.pm-card-info {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.pm-card-name {
	font-weight: 600;
	font-size: 13px;
	color: #e0e0e0;
}
.pm-card-enabled .pm-card-name {
	color: #f59e0b;
}

.pm-card-id {
	font-size: 10px;
	color: #666;
	font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.pm-card-desc {
	font-size: 11px;
	color: #888;
	line-height: 1.5;
	margin-bottom: 6px;
}

.pm-card-error {
	font-size: 11px;
	color: #f14c4c;
	margin-bottom: 4px;
	padding: 4px 8px;
	background: rgba(241, 76, 76, 0.08);
	border-radius: 4px;
}

.pm-card-status {
	display: flex;
	align-items: center;
	gap: 6px;
}

.pm-status-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex-shrink: 0;
}
.pm-status-on {
	background: #4ec9b0;
	box-shadow: 0 0 6px rgba(78, 201, 176, 0.4);
}
.pm-status-off {
	background: #555;
}

.pm-status-text {
	font-size: 11px;
	color: #888;
}

/* ── 开关 ── */
.pm-card-toggle-wrap {
	flex-shrink: 0;
}

.pm-loading-spinner {
	font-size: 14px;
	animation: pm-spin 1s linear infinite;
}
@keyframes pm-spin {
	to { transform: rotate(360deg); }
}

.pm-toggle-label {
	display: inline-flex;
	cursor: pointer;
	user-select: none;
}

.pm-toggle {
	display: none;
}

.pm-toggle-track {
	width: 36px;
	height: 20px;
	background: #444;
	border-radius: 10px;
	position: relative;
	transition: background 0.2s;
}

.pm-toggle:checked + .pm-toggle-track {
	background: #f59e0b;
}

.pm-toggle-thumb {
	width: 16px;
	height: 16px;
	background: #fff;
	border-radius: 50%;
	position: absolute;
	top: 2px;
	left: 2px;
	transition: transform 0.2s;
	box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.pm-toggle:checked + .pm-toggle-track .pm-toggle-thumb {
	transform: translateX(16px);
}

/* ── 滚动条 ── */
.pm-list::-webkit-scrollbar { width: 6px; }
.pm-list::-webkit-scrollbar-track { background: transparent; }
.pm-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
.pm-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
`
	document.head.appendChild(style)
}
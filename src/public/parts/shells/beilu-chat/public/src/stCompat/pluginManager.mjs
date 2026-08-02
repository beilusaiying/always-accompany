/**
 * 插件管理器 UI
 *
 * 在助手选项卡中提供插件开关面板，
 * 当前支持 beilu-mvu（MVU 变量系统）和 beilu-ejs（EJS 模板渲染）的启用/禁用。
 *
 * 开关真值来源=后端 config（getConfig 读回对齐 / setConfig 同步写入），localStorage 仅作
 * 离线回显缓存（0731 修正：原注释"无需注册 config 处理器"已腐烂——只写 localStorage 的开关
 * 管不住后端渲染管线）。
 * MVU 开关联动：关闭时隐藏变量管理器和脚本管理器 tab。
 *
 * 使用方式：
 *   import { initPluginManager } from './stCompat/pluginManager.mjs'
 *   initPluginManager(containerElement)
 */

import { createDiag } from '../shared/state/diagLogger.mjs'
import { sendAction } from '../shared/transport/sendAction.mjs' // P1-2：mvu config 读写经门面精确 verb（原 apiFetch 直连已收口）
import { storage, KEYS } from "../shared/state/storage.mjs"; // R2: localStorage 集中

const diag = createDiag('stCompat')

// ============================================================
// 插件定义
// ============================================================

const PLUGINS = [
	{
		id: 'beilu-mvu',
		name: 'MVU 变量系统',
		icon: '<i data-ic="chart"></i>',
		description: '兼容 JS-Slash-Runner (酒馆助手) 的 MVU 变量累积、初始化、命令解析、YAML 注入',
		storageKey: KEYS.BEILU_ST_COMPAT_ENABLED,
		defaultEnabled: false, // [0731 凛倾拍板"这两个默认关闭"] ST 卡适配件 opt-in，与后端默认一致（mvu/main.mjs）
		// 后端 config 路由 base：开关需同步到后端的 pluginEnabled（getdata/setdata 返回/接受 { enabled }）
		// 实际请求路径用字面量 ':'（后端路由注册的 '\\:' 只是 Express 转义）
		// backendApiBase 现仅作「此插件有后端配置」的开关标记（真实端点在 sendAction plugins:beilu-mvu 注册段）
		backendApiBase: '/api/parts/plugins:beilu-mvu/config',
	},
	{
		id: 'beilu-ejs',
		name: 'EJS 模板渲染',
		icon: '<i data-ic="edit"></i>',
		description: '兼容 ST-Prompt-Template 的 EJS 模板语法，在提示词中嵌入变量和条件逻辑',
		storageKey: 'beilu-plugin-ejs-enabled',
		defaultEnabled: false, // [0731 凛倾拍板"这两个默认关闭"] ST 卡适配件 opt-in，与后端默认一致（sandbox/main.mjs）
		// [0731 门控断链根修] 此前无 backendApiBase → 开关只写 localStorage、后端 pluginEnabled
		//   永远 true（sandbox/main.mjs），面板显示"已禁用"后端照渲染每轮 chat_log =「按钮是摆设」
		//   事故。补标记接通 _syncBackendState/_loadBackendState（端点=sendAction plugins:beilu-ejs 注册段）。
		backendApiBase: '/api/parts/plugins:beilu-ejs/config',
	},
]
// 【红线·0731 凛倾拍板】本面板是 MVU/EJS 开关的唯一控制面（额外插件管理平台的重复条目已删）。
//   新增条目必须带 backendApiBase 接通后端 config——只写 localStorage 的开关是摆设（后端管线
//   读的是它自己的 pluginEnabled，不读浏览器 localStorage）；后端侧 enabled 必须落盘持久
//   （内存态默认 true=重启即硬开启，见 sandbox/mvu main.mjs 0731 根修注释）。

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
		const stored = storage.get(plugin.storageKey)
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
			<span class="pm-title-icon"><i data-ic="puzzle"></i></span>
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
			? '<span class="pm-loading-spinner"><i data-ic="hourglass"></i></span>'
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
			const stored = storage.get(plugin.storageKey)
			state.enabled = stored !== null ? stored === 'true' : plugin.defaultEnabled
		} catch {
			state.enabled = plugin.defaultEnabled
		}
		_updateCard(plugin.id)
		// 后端是开关真值来源：读回后端 enabled 并与本地状态对齐（异步，不阻塞渲染）
		if (plugin.backendApiBase) _loadBackendState(plugin)
	})
	// 同步变量管理器/脚本管理器 tab 显隐
	_syncMvuRelatedTabs()
}

/**
 * 从后端读回插件 enabled 真值，与本地状态/localStorage 对齐
 * 后端不可达时保留本地值（离线降级，不报错刷红）
 * @param {object} plugin
 */
async function _loadBackendState(plugin) {
	const state = _states.get(plugin.id)
	if (!state) return
	try {
		// P1-2（一致性审计②）：直连→门面精确 verb（sendAction 内 plugins:<id>#getConfig；!ok 由门面抛错）
		const data = await sendAction({ verb: "getConfig", target: `plugins:${plugin.id}`, source: "web" })
		if (data && typeof data.enabled === 'boolean' && data.enabled !== state.enabled) {
			state.enabled = data.enabled
			try {
				storage.set(plugin.storageKey, data.enabled ? 'true' : 'false')
			} catch { /* localStorage 不可用时忽略 */ }
			_updateCard(plugin.id)
			_syncMvuRelatedTabs()
		}
	} catch (err) {
		diag.warn(`[pluginManager] 读回 ${plugin.id} 后端状态失败:`, err.message)
	}
}

/**
 * 将插件 enabled 同步到后端
 * @param {object} plugin
 * @param {boolean} enabled
 */
async function _syncBackendState(plugin, enabled) {
	try {
		// P1-2（一致性审计②）：直连→门面精确 verb（payload 平铺进 body，与原 {enabled} 逐字节等价）
		await sendAction({ verb: "setConfig", target: `plugins:${plugin.id}`, source: "web", payload: { enabled } })
		diag.log(`[pluginManager] ${plugin.id} 后端状态已同步: ${enabled}`)
	} catch (err) {
		// 同步失败：本地状态已变，标记错误供用户感知
		const state = _states.get(plugin.id)
		if (state) {
			state.error = `后端同步失败: ${err.message}`
			_updateCard(plugin.id)
		}
		diag.warn(`[pluginManager] 同步 ${plugin.id} 到后端失败:`, err.message)
	}
}

function _togglePlugin(pluginId, enabled) {
	const plugin = PLUGINS.find(p => p.id === pluginId)
	const state = _states.get(pluginId)
	if (!plugin || !state) return

	try {
		storage.set(plugin.storageKey, enabled ? 'true' : 'false')
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
	// 后端有 config 路由的插件（如 beilu-mvu）：将开关同步到后端 pluginEnabled
	if (plugin.backendApiBase) _syncBackendState(plugin, enabled)
	// 同步变量管理器/脚本管理器 tab 显隐
	_syncMvuRelatedTabs()
}

/**
 * 同步变量管理器 tab 的显隐（根据 beilu-mvu 开关状态）
 * MVU 关闭时：隐藏变量管理器 tab，如正在查看则自动切到脚本 tab
 */
function _syncMvuRelatedTabs() {
	const mvuState = _states.get('beilu-mvu')
	const mvuEnabled = mvuState ? mvuState.enabled : true

	const varTab = document.querySelector('.helper-sub-tab[data-helper-tab="variables"]')
	if (varTab) varTab.style.display = mvuEnabled ? '' : 'none'

	if (!mvuEnabled) {
		const varPanel = document.getElementById('helper-panel-variables')
		if (varPanel && varPanel.style.display !== 'none') {
			document.querySelectorAll('.helper-sub-tab').forEach(t => {
				t.classList.toggle('helper-sub-tab-active', t.dataset.helperTab === 'scripts')
			})
			document.querySelectorAll('.helper-panel').forEach(panel => {
				panel.style.display = panel.id === 'helper-panel-scripts' ? '' : 'none'
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
	color: oklch(var(--bc));
	background: oklch(var(--b1));
	border-radius: 6px;
	overflow: hidden;
}

/* ── 头部 ── */
.pm-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid oklch(var(--bc) / 0.08);
	background: oklch(var(--b2));
	flex-shrink: 0;
}

.pm-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-weight: 600;
	font-size: 14px;
	color: var(--beilu-amber);
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
	border: 1px solid oklch(var(--bc) / 0.1);
	border-radius: 5px;
	color: oklch(var(--bc) / 0.55);
	font-size: 15px;
	cursor: pointer;
	transition: all 0.15s;
}
.pm-refresh-btn:hover {
	color: var(--beilu-amber);
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
	border: 1px solid oklch(var(--bc) / 0.08);
	border-radius: 8px;
	padding: 12px 14px;
	background: oklch(var(--b2));
	transition: all 0.2s;
}
.pm-card:hover {
	border-color: oklch(var(--bc) / 0.12);
	background: oklch(var(--b3));
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
	color: oklch(var(--bc) / 0.9);
}
.pm-card-enabled .pm-card-name {
	color: var(--beilu-amber);
}

.pm-card-id {
	font-size: 10px;
	color: oklch(var(--bc) / 0.65);
	font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.pm-card-desc {
	font-size: 11px;
	color: oklch(var(--bc) / 0.55);
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
	background: oklch(var(--bc) / 0.35);
}

.pm-status-text {
	font-size: 11px;
	color: oklch(var(--bc) / 0.55);
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
	background: oklch(var(--bc) / 0.28);
	border-radius: 10px;
	position: relative;
	transition: background 0.2s;
}

.pm-toggle:checked + .pm-toggle-track {
	background: var(--beilu-amber);
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
.pm-list::-webkit-scrollbar-thumb { background: oklch(var(--bc) / 0.1); border-radius: 3px; }
.pm-list::-webkit-scrollbar-thumb:hover { background: oklch(var(--bc) / 0.2); }
`
	document.head.appendChild(style)
}
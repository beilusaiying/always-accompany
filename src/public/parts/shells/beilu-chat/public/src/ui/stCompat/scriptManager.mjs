/**
 * scriptManager.mjs — 角色卡脚本管理器 UI
 *
 * 助手选项卡第三个子tab，展示角色卡的 tavern_helper.scripts 列表。
 * 功能：查看/编辑脚本内容、按钮/数据展示、启用状态和运行状态、触发脚本按钮。
 *
 * 数据来源：
 *   - 全量脚本数据：fetch('/api/parts/shells:beilu-home/char-data/{charId}')
 *     → charData.data.extensions.tavern_helper.scripts
 *   - 运行状态：getRunningScripts() → [{id, name, enabled, buttons}]
 *
 * 编辑保存：
 *   - PUT /api/parts/shells:beilu-home/update-char/{charId}
 *     body: { extensions: { tavern_helper: { scripts: [...] } } }
 *
 * 依赖：scriptRunner.mjs（getRunningScripts / triggerScriptButton）
 */

import { createDiag } from '../../diagLogger.mjs'
import { getRunningScripts, triggerScriptButton } from './scriptRunner.mjs'

const diag = createDiag('stCompat')

/** @type {HTMLElement|null} */
let _container = null
/** @type {Array<object>} 完整脚本列表（从角色卡 chardata 获取） */
let _allScripts = []
/** @type {string|null} 当前角色卡 ID */
let _charId = null
/** @type {Set<string>} 已展开的脚本 ID */
const _expandedIds = new Set()
/** @type {Set<string>} 正在编辑中的脚本 ID */
const _editingIds = new Set()
/** @type {Map<string, string>} 编辑中的脚本内容暂存（scriptId → content） */
const _editBuffers = new Map()

// ============================================================
// 公共 API
// ============================================================

/**
 * 初始化脚本管理器
 * @param {HTMLElement} container - #script-manager-container 容器元素
 */
export function initScriptManager(container) {
	_container = container
	_renderEmpty()
	_scheduleAutoLoad()
}

// ============================================================
// 数据加载
// ============================================================

/**
 * 延迟自动加载角色卡脚本数据
 * 角色卡可能还没加载完毕，需要轮询等待
 */
function _scheduleAutoLoad() {
	const tryLoad = async () => {
		const charId = _getCharId()
		if (charId && charId !== _charId) {
			await _loadScripts(charId)
		}
	}

	// 首次延迟 3 秒（等角色卡加载）
	setTimeout(tryLoad, 3000)

	// 之后每 5 秒检查一次角色卡变化（最多 6 次 = 30 秒）
	let attempts = 0
	const timer = setInterval(async () => {
		attempts++
		if (attempts >= 6 || _charId) {
			clearInterval(timer)
			return
		}
		await tryLoad()
	}, 5000)
}

/**
 * 从 DOM 获取当前角色卡 ID
 * index.mjs 的 loadCharInfo() 会设置 charNameDisplay.dataset.charId
 * @returns {string|null}
 */
function _getCharId() {
	const el = document.getElementById('char-name-display')
	return el?.dataset?.charId || null
}

/**
 * 加载指定角色卡的脚本数据
 * @param {string} charId - 角色卡 ID（目录名）
 */
async function _loadScripts(charId) {
	try {
		const resp = await fetch(`/api/parts/shells:beilu-home/char-data/${encodeURIComponent(charId)}`)
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
		const charData = await resp.json()

		// 兼容两种数据嵌套结构
		const scripts = charData?.data?.extensions?.tavern_helper?.scripts
			|| charData?.extensions?.tavern_helper?.scripts
			|| []

		_allScripts = Array.isArray(scripts) ? scripts : []
		_charId = charId
		_render()
	} catch (err) {
		diag.warn('[scriptManager] 加载脚本数据失败:', err.message)
		_allScripts = []
		_charId = charId
		_render()
	}
}

// ============================================================
// 渲染
// ============================================================

/** 初始状态（等待角色卡） */
function _renderEmpty() {
	if (!_container) return
	_container.innerHTML = `
		<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.8rem;">
			等待角色卡加载...
		</div>
	`
}

/** 主渲染 */
function _render() {
	if (!_container) return

	// 获取运行状态
	let runningScripts = []
	try { runningScripts = getRunningScripts() } catch { /* 静默 */ }
	const runningMap = new Map(runningScripts.map(s => [s.id, s]))

	// 统计
	const total = _allScripts.length
	const enabledCount = _allScripts.filter(s => s.enabled).length
	const runningCount = runningScripts.length

	let html = ''

	// ── 工具栏 ──
	html += `
		<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid oklch(var(--b3));flex-shrink:0;">
			<span style="font-weight:600;font-size:0.85rem;">📜 角色卡脚本</span>
			<span style="font-size:0.7rem;opacity:0.5;">${total} 个 · ${enabledCount} 启用 · ${runningCount} 运行中</span>
			<button class="sm-refresh-btn btn btn-xs btn-ghost btn-square" title="刷新" style="margin-left:auto;">🔄</button>
		</div>
	`

	// ── 空状态 ──
	if (total === 0) {
		html += `
			<div style="padding:32px;text-align:center;opacity:0.35;font-size:0.8rem;">
				${_charId ? '当前角色卡没有 tavern_helper 脚本' : '未加载角色卡'}
			</div>
		`
		_container.innerHTML = html
		_bindToolbarEvents()
		return
	}

	// ── 脚本列表 ──
	html += '<div class="sm-script-list" style="overflow-y:auto;flex:1;padding:8px;">'

	for (const script of _allScripts) {
		const isExpanded = _expandedIds.has(script.id)
		const running = runningMap.get(script.id)

			// 启用/禁用切换开关
			const toggleChecked = script.enabled ? 'checked' : ''
			const enabledToggle = `<label class="sm-toggle-label" style="display:flex;align-items:center;cursor:pointer;" title="${script.enabled ? '点击禁用脚本' : '点击启用脚本'}">
				<input type="checkbox" class="sm-script-toggle toggle toggle-xs toggle-success" data-script-id="${_esc(script.id)}" ${toggleChecked} />
			</label>`
			const runningBadge = running
				? '<span class="badge badge-xs badge-info" style="font-size:0.6rem;">运行中</span>'
				: ''

		// 箭头旋转
		const chevronStyle = isExpanded ? 'transform:rotate(90deg);' : ''

		html += `
			<div style="border:1px solid oklch(var(--b3));border-radius:8px;margin-bottom:6px;overflow:hidden;">
				<div class="sm-script-header" data-script-id="${_esc(script.id)}"
					style="display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;user-select:none;">
					<span style="font-size:0.7rem;opacity:0.4;transition:transform 0.15s;${chevronStyle}">▶</span>
					<span style="font-size:0.8rem;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${script.enabled ? '' : 'opacity:0.4;text-decoration:line-through;'}">
						${_esc(script.name || '(无名脚本)')}
					</span>
					${enabledToggle}
					${runningBadge}
				</div>
		`

		if (isExpanded) {
			html += _renderDetails(script, running)
		}

		html += '</div>'
	}

	html += '</div>'

	_container.innerHTML = html
	_bindEvents()
}

/**
 * 渲染脚本详情面板（展开后的内容区域）
 * @param {object} script - 脚本对象
 * @param {object|undefined} runningInfo - 运行时信息（来自 getRunningScripts）
 * @returns {string} HTML
 */
function _renderDetails(script, runningInfo) {
	let html = '<div style="border-top:1px solid oklch(var(--b3));padding:8px 10px;font-size:0.75rem;">'

	// 基本信息
	const shortId = (script.id || '').length > 12
		? script.id.substring(0, 8) + '...' + script.id.substring(script.id.length - 4)
		: script.id || '-'
	html += `
		<div style="display:flex;gap:12px;margin-bottom:8px;opacity:0.5;font-size:0.65rem;">
			<span>ID: ${_esc(shortId)}</span>
			<span>类型: ${_esc(script.type || 'script')}</span>
		</div>
	`

	// ── 脚本内容 ──
	if (script.content !== undefined) {
		const isEditing = _editingIds.has(script.id)
		const content = isEditing
			? (_editBuffers.get(script.id) ?? script.content)
			: script.content

		html += `
			<div style="margin-bottom:8px;">
				<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
					<span style="font-weight:600;">📝 脚本内容</span>
					<span style="font-size:0.6rem;opacity:0.4;">(${script.content.length} 字符)</span>
					<span style="margin-left:auto;display:flex;gap:4px;">
		`

		if (isEditing) {
			html += `
						<button class="sm-save-btn btn btn-xs btn-success" data-script-id="${_esc(script.id)}" title="保存修改">💾 保存</button>
						<button class="sm-cancel-btn btn btn-xs btn-ghost" data-script-id="${_esc(script.id)}" title="取消编辑">✖ 取消</button>
			`
		} else {
			html += `
						<button class="sm-edit-btn btn btn-xs btn-ghost" data-script-id="${_esc(script.id)}" title="编辑脚本内容">✏️ 编辑</button>
			`
		}

		html += `
					</span>
				</div>
		`

		if (isEditing) {
			html += `
				<textarea class="sm-content-editor" data-script-id="${_esc(script.id)}"
					style="width:100%;min-height:200px;max-height:400px;background:oklch(var(--b2));padding:6px 8px;border-radius:4px;border:1px solid oklch(var(--b3));font-size:0.65rem;font-family:ui-monospace,monospace;resize:vertical;color:inherit;outline:none;"
					spellcheck="false">${_esc(content)}</textarea>
			`
		} else {
			const maxLen = 500
			const preview = content.length > maxLen
				? content.substring(0, maxLen) + `\n... (共 ${content.length} 字符)`
				: content
			html += `
				<pre style="background:oklch(var(--b2));padding:6px 8px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:0.65rem;max-height:200px;overflow-y:auto;font-family:ui-monospace,monospace;">${_esc(preview)}</pre>
			`
		}

		html += '</div>'
	}

	// ── 按钮列表 ──
	const buttons = script.button?.buttons
	if (buttons && Array.isArray(buttons) && buttons.length > 0) {
		const btnGroupEnabled = script.button?.enabled !== false
		html += `
			<div style="margin-bottom:8px;">
				<div style="font-weight:600;margin-bottom:3px;">
					🔘 脚本按钮
					${btnGroupEnabled ? '' : '<span style="opacity:0.4;font-weight:400;"> (按钮功能已禁用)</span>'}
				</div>
				<div style="display:flex;flex-wrap:wrap;gap:4px;">
		`
		for (const btn of buttons) {
			const canTrigger = !!runningInfo && btnGroupEnabled
			const visibleHint = btn.visible === false ? ' (隐藏)' : ''
			html += `
				<button class="sm-trigger-btn btn btn-xs ${canTrigger
					? 'btn-outline border-amber-700 text-amber-700 hover:bg-amber-700 hover:text-white'
					: 'btn-disabled opacity-40'}"
					data-script-id="${_esc(script.id)}" data-btn-name="${_esc(btn.name)}"
					${canTrigger ? '' : 'disabled'}
					title="${canTrigger ? '点击触发按钮' : '脚本未运行或按钮已禁用'}">
					${_esc(btn.name)}${visibleHint}
				</button>
			`
		}
		html += '</div></div>'
	}

	// ── 脚本数据 ──
	const data = script.data
	if (data && typeof data === 'object' && Object.keys(data).length > 0) {
		html += `
			<div style="margin-bottom:4px;">
				<div style="font-weight:600;margin-bottom:3px;">📊 脚本数据</div>
				<div style="background:oklch(var(--b2));border-radius:4px;overflow:hidden;">
		`
		const entries = Object.entries(data)
		for (let i = 0; i < entries.length; i++) {
			const [key, value] = entries[i]
			const displayValue = typeof value === 'string'
				? (value.length > 120 ? value.substring(0, 120) + '...' : value)
				: JSON.stringify(value)
			const borderStyle = i < entries.length - 1 ? 'border-bottom:1px solid oklch(var(--b3));' : ''
			html += `
				<div style="display:flex;padding:4px 8px;${borderStyle}font-size:0.7rem;">
					<span style="font-weight:500;min-width:100px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;margin-right:8px;">
						${_esc(key)}
					</span>
					<span style="opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">
						${_esc(displayValue)}
					</span>
				</div>
			`
		}
		html += '</div></div>'
	}

	html += '</div>'
	return html
}

// ============================================================
// 事件绑定
// ============================================================

/** 仅绑定工具栏事件（空状态时使用） */
function _bindToolbarEvents() {
	_container?.querySelector('.sm-refresh-btn')?.addEventListener('click', _handleRefresh)
}

/** 绑定所有事件 */
function _bindEvents() {
	if (!_container) return

	// 刷新按钮
	_container.querySelector('.sm-refresh-btn')?.addEventListener('click', _handleRefresh)

	// 展开/折叠
	_container.querySelectorAll('.sm-script-header').forEach(header => {
		header.addEventListener('click', () => {
			const scriptId = header.dataset.scriptId
			if (!scriptId) return
			if (_expandedIds.has(scriptId)) {
				_expandedIds.delete(scriptId)
			} else {
				_expandedIds.add(scriptId)
			}
			_render()
		})
	})

	// 触发脚本按钮
	_container.querySelectorAll('.sm-trigger-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			const btnName = btn.dataset.btnName
			if (!scriptId || !btnName) return

			try {
				triggerScriptButton(scriptId, btnName)
			} catch (err) {
				diag.warn('[scriptManager] 触发按钮失败:', err.message)
			}

			const originalText = btn.textContent
			btn.textContent = '✓ 已触发'
			btn.disabled = true
			setTimeout(() => {
				btn.textContent = originalText
				btn.disabled = false
			}, 1500)
		})
	})

	// 编辑按钮
	_container.querySelectorAll('.sm-edit-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			if (!scriptId) return
			_editingIds.add(scriptId)
			// 初始化编辑缓冲区
			const script = _allScripts.find(s => s.id === scriptId)
			if (script) _editBuffers.set(scriptId, script.content || '')
			_render()
		})
	})

	// 取消编辑按钮
	_container.querySelectorAll('.sm-cancel-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			if (!scriptId) return
			_editingIds.delete(scriptId)
			_editBuffers.delete(scriptId)
			_render()
		})
	})

	// 保存按钮
	_container.querySelectorAll('.sm-save-btn').forEach(btn => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			if (!scriptId || !_charId) return

			// 从 textarea 获取最新内容
			const textarea = _container.querySelector(`.sm-content-editor[data-script-id="${CSS.escape(scriptId)}"]`)
			const newContent = textarea?.value ?? _editBuffers.get(scriptId) ?? ''

			btn.disabled = true
			btn.textContent = '⏳ 保存中...'

			try {
				await _saveScriptContent(scriptId, newContent)
				_editingIds.delete(scriptId)
				_editBuffers.delete(scriptId)
				// 更新本地数据
				const script = _allScripts.find(s => s.id === scriptId)
				if (script) script.content = newContent
				_render()
			} catch (err) {
				btn.textContent = '❌ 失败'
				diag.error('[scriptManager] 保存脚本失败:', err.message)
				setTimeout(() => { btn.textContent = '💾 保存'; btn.disabled = false }, 2000)
			}
		})
	})

	// 编辑器内容变化时同步到缓冲区
	_container.querySelectorAll('.sm-content-editor').forEach(textarea => {
		textarea.addEventListener('input', () => {
			const scriptId = textarea.dataset.scriptId
			if (scriptId) _editBuffers.set(scriptId, textarea.value)
		})
		// 阻止点击事件冒泡到 header
		textarea.addEventListener('click', (e) => e.stopPropagation())
	})

	// 启用/禁用切换开关
	_container.querySelectorAll('.sm-script-toggle').forEach(toggle => {
		// 阻止点击冒泡到 header（避免触发展开/折叠）
		toggle.addEventListener('click', (e) => e.stopPropagation())
		toggle.closest('.sm-toggle-label')?.addEventListener('click', (e) => e.stopPropagation())

		toggle.addEventListener('change', async () => {
			const scriptId = toggle.dataset.scriptId
			if (!scriptId || !_charId) return

			const newEnabled = toggle.checked

			try {
				await _saveScriptEnabled(scriptId, newEnabled)
				// 保存成功后更新本地数据
				const script = _allScripts.find(s => s.id === scriptId)
				if (script) script.enabled = newEnabled
				_render()
			} catch (err) {
				// 保存失败，恢复 UI 状态
				toggle.checked = !newEnabled
				diag.error('[scriptManager] 切换脚本启用状态失败:', err.message)
			}
		})
	})
}

/**
 * 将完整脚本列表保存到角色卡后端
 * @param {Array<object>} scripts - 完整的脚本数组
 */
async function _saveScriptsToBackend(scripts) {
	const resp = await fetch(`/api/parts/shells:beilu-home/update-char/${encodeURIComponent(_charId)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			extensions: {
				tavern_helper: { scripts },
			},
		}),
	})

	if (!resp.ok) {
		const errData = await resp.json().catch(() => ({}))
		throw new Error(errData.message || `HTTP ${resp.status}`)
	}
}

/**
 * 保存脚本内容到后端
 * @param {string} scriptId - 脚本 ID
 * @param {string} newContent - 新的脚本内容
 */
async function _saveScriptContent(scriptId, newContent) {
	const updatedScripts = _allScripts.map(s =>
		s.id === scriptId ? { ...s, content: newContent } : s
	)
	await _saveScriptsToBackend(updatedScripts)
	diag.log(`[scriptManager] 脚本 ${scriptId} 已保存到角色卡 ${_charId}`)
}

/**
 * 保存脚本启用状态到后端
 * @param {string} scriptId - 脚本 ID
 * @param {boolean} enabled - 是否启用
 */
async function _saveScriptEnabled(scriptId, enabled) {
	const updatedScripts = _allScripts.map(s =>
		s.id === scriptId ? { ...s, enabled } : s
	)
	await _saveScriptsToBackend(updatedScripts)
	diag.log(`[scriptManager] 脚本 ${scriptId} 已${enabled ? '启用' : '禁用'}`)
}

/** 刷新按钮点击处理 */
async function _handleRefresh() {
	const charId = _getCharId()
	if (charId) {
		_charId = null // 强制重新加载
		await _loadScripts(charId)
	} else {
		_renderEmpty()
	}
}

// ============================================================
// 工具函数
// ============================================================

/**
 * HTML 转义
 * @param {string} str
 * @returns {string}
 */
function _esc(str) {
	if (!str) return ''
	const div = document.createElement('div')
	div.textContent = String(str)
	return div.innerHTML
}
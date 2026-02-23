/**
 * beilu-chat 正则脚本编辑器模块
 *
 * ST 风格正则管理器 — 完整功能：
 * - 三级作用域列表（全局/角色/预设）
 * - 拖拽排序
 * - 脚本编辑器（所有 ST 字段）
 * - 实时测试模式
 * - 导入/导出
 */

import { refreshDisplayRules } from './displayRegex.mjs'

const REGEX_API_GET = '/api/parts/plugins:beilu-regex/config/getdata'
const REGEX_API_SET = '/api/parts/plugins:beilu-regex/config/setdata'

// ============================================================
// API 通信
// ============================================================

async function getRegexData() {
	const res = await fetch(REGEX_API_GET)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

async function setRegexData(data) {
	const res = await fetch(REGEX_API_SET, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

// ============================================================
// 状态
// ============================================================

let allRules = []
let selectedRuleId = null
let globalEnabled = true
let isTestMode = false
let renderMode = 'sandbox' // 'sandbox' | 'free'
let showAllScoped = false // 是否显示全部角色的 scoped/preset 规则
/** @type {Set<string>} 已展开的角色名折叠组 */
let expandedCharGroups = new Set()
/** @type {HTMLElement|null} */
let container = null

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化正则编辑器
 * @param {HTMLElement} targetContainer - 渲染目标容器
 */
export async function initRegexEditor(targetContainer) {
	container = targetContainer
	if (!container) return

	container.innerHTML = buildMainHTML()
	bindEvents()
	await loadData()
}

// ============================================================
// 主 HTML 构建
// ============================================================

function buildMainHTML() {
	return `
<div class="regex-editor flex flex-col h-full">
	<!-- 顶部工具栏 -->
	<div class="flex items-center justify-between px-4 py-2 bg-base-200/80 border-b border-base-300 shrink-0">
		<div class="flex items-center gap-2">
			<span class="font-bold text-amber-700 text-sm">🔤 正则脚本</span>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="regex-global-toggle" class="toggle toggle-xs toggle-warning" checked />
				<span class="text-xs">启用</span>
			</label>
		</div>
		<div class="flex items-center gap-1">
			<div id="regex-render-mode" class="flex items-center bg-base-300/50 rounded-md px-0.5 py-0.5 gap-0">
				<button class="render-mode-btn btn btn-xs px-2 ${renderMode === 'sandbox' ? 'bg-amber-700 text-white' : 'btn-ghost text-base-content/60'}" data-mode="sandbox" title="沙盒模式：iframe 隔离渲染">🔒 沙盒</button>
				<button class="render-mode-btn btn btn-xs px-2 ${renderMode === 'free' ? 'bg-amber-700 text-white' : 'btn-ghost text-base-content/60'}" data-mode="free" title="自由模式：直接注入页面">🔓 自由</button>
			</div>
			<div class="divider divider-horizontal mx-0.5 w-px h-4"></div>
			<button id="regex-add-global" class="btn btn-xs btn-outline border-amber-700 text-amber-700 hover:bg-amber-700 hover:text-white" title="新建全局规则">
				+ 全局
			</button>
			<button id="regex-add-scoped" class="btn btn-xs btn-outline border-blue-600 text-blue-600 hover:bg-blue-600 hover:text-white" title="新建角色规则">
				+ 角色
			</button>
			<button id="regex-add-preset" class="btn btn-xs btn-outline border-green-600 text-green-600 hover:bg-green-600 hover:text-white" title="新建预设规则">
				+ 预设
			</button>
			<button id="regex-import-btn" class="btn btn-xs btn-ghost" title="导入 ST 正则脚本">📥</button>
			<button id="regex-export-all-btn" class="btn btn-xs btn-ghost" title="导出全部">📤</button>
			<input type="file" id="regex-file-input" accept=".json" class="hidden" />
		</div>
	</div>

	<!-- 主内容区：左右分栏 -->
	<div class="flex flex-1 overflow-hidden">
		<!-- 左侧：脚本列表 -->
		<div class="regex-list-panel w-72 min-w-[240px] border-r border-base-300 flex flex-col overflow-hidden shrink-0">
			<!-- 角色过滤开关 -->
				<div class="px-2 py-1 border-b border-base-300/50 flex items-center justify-between">
					<span class="text-[10px] text-blue-600 font-bold" id="regex-current-char-label">角色正则脚本</span>
					<label class="cursor-pointer flex items-center gap-1" title="只影响当前角色，保存在角色卡中">
						<span class="text-[10px] text-base-content/40">显示全部</span>
						<input type="checkbox" id="regex-show-all-toggle" class="toggle toggle-xs" ${showAllScoped ? 'checked' : ''} />
					</label>
				</div>
			<!-- 搜索 -->
				<div class="px-2 py-1.5 border-b border-base-300/50">
					<input type="text" id="regex-search" placeholder="搜索规则..."
						class="input input-xs input-bordered w-full" />
				</div>
			<!-- 列表 -->
			<div id="regex-list" class="flex-1 overflow-y-auto text-xs">
				<p class="text-center text-base-content/40 py-8">加载中...</p>
			</div>
			<!-- 统计 -->
			<div id="regex-stats" class="px-2 py-1 text-xs text-base-content/40 border-t border-base-300/50 shrink-0">
				共 0 条规则
			</div>
		</div>

		<!-- 右侧：编辑器 -->
		<div id="regex-editor-panel" class="flex-1 flex flex-col overflow-hidden">
			<!-- 空状态 -->
			<div id="regex-empty-state" class="flex-1 flex items-center justify-center text-base-content/30">
				<div class="text-center">
					<div class="text-4xl mb-3">🔤</div>
					<p class="text-sm">选择一条规则进行编辑</p>
					<p class="text-xs mt-1">或点击"+"按钮新建规则</p>
				</div>
			</div>
			<!-- 编辑器内容（选中规则后显示） -->
			<div id="regex-edit-form" class="flex-1 overflow-y-auto hidden">
			</div>
		</div>
	</div>
</div>
`
}

// ============================================================
// 规则列表渲染
// ============================================================

/**
 * 获取当前角色名
 * @returns {string}
 */
function getCurrentCharName() {
	return document.getElementById('char-name-display')?.textContent?.trim() || ''
}

/**
 * 获取当前预设名（从预设选择器读取）
 * @returns {string}
 */
function getCurrentPresetName() {
	return document.getElementById('preset-selector')?.value || ''
}

/**
 * 渲染单条规则的列表项 HTML
 * @param {object} rule - 规则对象
 * @param {string} colorClass - 颜色 class（如 'amber', 'blue', 'green'）
 * @param {boolean} showCharLabel - 是否显示角色名标签
 * @returns {string}
 */
function renderRuleItemHTML(rule, colorClass, showCharLabel = false) {
	const isSelected = rule.id === selectedRuleId
	const charLabelHtml = showCharLabel && rule.boundCharName
		? `<span class="badge badge-xs badge-outline text-[9px] shrink-0" title="绑定: ${escapeHtml(rule.boundCharName)}">${escapeHtml(rule.boundCharName)}</span>`
		: ''
	return `
	<div class="regex-rule-item flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-base-300/50 border-l-2 ${isSelected ? `border-${colorClass}-500 bg-base-300/60` : 'border-transparent'}"
		data-rule-id="${rule.id}">
		<span class="drag-handle cursor-grab text-base-content/30 hover:text-base-content/60" title="拖拽排序">≡</span>
		<input type="checkbox" class="checkbox checkbox-xs checkbox-warning rule-toggle"
			data-rule-id="${rule.id}" ${rule.disabled ? '' : 'checked'} />
		<span class="flex-1 truncate ${rule.disabled ? 'line-through opacity-40' : ''}">${escapeHtml(rule.scriptName || '(无名)')}</span>
		${charLabelHtml}
		<div class="flex items-center gap-0.5 opacity-60">
			${rule.placement?.includes('user_input') ? '<span class="badge badge-xs" title="用户输入">U</span>' : ''}
			${rule.placement?.includes('ai_output') ? '<span class="badge badge-xs" title="AI输出">A</span>' : ''}
			${rule.placement?.includes('world_info') ? '<span class="badge badge-xs" title="世界信息">W</span>' : ''}
		</div>
		<button class="btn btn-xs btn-ghost btn-square rule-menu-btn opacity-0 group-hover:opacity-100" data-rule-id="${rule.id}" title="更多">⋯</button>
	</div>
	`
}

/**
 * 渲染按角色分组的 scoped/preset 规则
 * @param {object[]} rules - scoped 或 preset 规则数组
 * @param {string} currentCharName - 当前角色名
 * @param {string} colorClass - 颜色 class
 * @param {string} scope - 作用域名
 * @returns {string}
 */
function renderGroupedRules(rules, currentCharName, colorClass, scope) {
	// preset 规则按 boundPresetName 分组，scoped 规则按 boundCharName 分组
	const groupField = scope === 'preset' ? 'boundPresetName' : 'boundCharName'
	const currentName = scope === 'preset' ? getCurrentPresetName() : currentCharName
	const emptyLabel = scope === 'scoped' ? '角色' : '预设'

	if (!showAllScoped) {
		// 只显示当前角色/预设的规则
		const currentRules = rules.filter(r => r[groupField] === currentName)
		if (currentRules.length === 0) {
			return `<p class="text-center text-base-content/30 py-3 text-[11px]">当前${emptyLabel}无${emptyLabel}规则</p>`
		}
		let html = ''
		for (const rule of currentRules) {
			html += renderRuleItemHTML(rule, colorClass, false)
		}
		return html
	}

	// 显示全部：按分组字段折叠
	const byGroup = {}
	for (const rule of rules) {
		const name = rule[groupField] || '(未绑定)'
		if (!byGroup[name]) byGroup[name] = []
		byGroup[name].push(rule)
	}

	if (Object.keys(byGroup).length === 0) {
		return `<p class="text-center text-base-content/30 py-3 text-[11px]">无规则</p>`
	}

	let html = ''
	// 当前角色/预设排最前
	const sortedNames = Object.keys(byGroup).sort((a, b) => {
		if (a === currentName) return -1
		if (b === currentName) return 1
		return a.localeCompare(b)
	})

	for (const groupName of sortedNames) {
		const groupRules = byGroup[groupName]
		const isCurrent = groupName === currentName
		const groupKey = `${scope}-${groupName}`
		const isExpanded = isCurrent || expandedCharGroups.has(groupKey)

		html += `
		<div class="regex-char-group">
			<div class="px-3 py-1 bg-base-200/50 flex items-center justify-between cursor-pointer char-group-toggle"
				data-group-key="${escapeHtml(groupKey)}">
				<div class="flex items-center gap-1.5">
					<span class="text-[10px] ${isCurrent ? `text-${colorClass}-600 font-bold` : 'text-base-content/50'}">${isCurrent ? '▸ ' : ''}${escapeHtml(groupName)}</span>
					<span class="badge badge-xs ${isCurrent ? `badge-${colorClass === 'blue' ? 'info' : 'success'}` : 'badge-ghost'}">${groupRules.length}</span>
					${isCurrent ? '<span class="text-[9px] text-base-content/40">当前</span>' : ''}
				</div>
				<span class="text-[10px] text-base-content/30">${isExpanded ? '▼' : '▶'}</span>
			</div>
			<div class="char-group-content" style="${isExpanded ? '' : 'display:none'}" data-group-key="${escapeHtml(groupKey)}">
		`
		for (const rule of groupRules) {
			html += renderRuleItemHTML(rule, colorClass, false)
		}
		html += `</div></div>`
	}

	return html
}

function renderRuleList(filter = '') {
	const listEl = container?.querySelector('#regex-list')
	if (!listEl) return

	const filtered = filter
		? allRules.filter(r => r.scriptName?.toLowerCase().includes(filter.toLowerCase()))
		: allRules

	const currentCharName = getCurrentCharName()

	// 更新当前角色名标签
	const charLabel = container?.querySelector('#regex-current-char-label')
	if (charLabel) {
		charLabel.textContent = currentCharName ? `角色: ${currentCharName}` : '角色正则脚本'
	}

	// 按 scope 分组
	const groups = {
		global: filtered.filter(r => r.scope === 'global'),
		scoped: filtered.filter(r => r.scope === 'scoped'),
		preset: filtered.filter(r => r.scope === 'preset'),
	}

	let html = ''

	// 渲染全局分组（保持不变）
	const globalRules = groups.global
	if (globalRules.length > 0 || !filter) {
		const label = { title: '全局正则脚本', subtitle: '影响所有角色', color: 'amber' }
		html += `
		<div class="regex-scope-group">
			<div class="px-2 py-1.5 bg-base-300/30 sticky top-0 z-10 flex items-center justify-between">
				<div>
					<span class="font-bold text-${label.color}-700 text-xs">${label.title}</span>
					<span class="text-[10px] text-base-content/40 ml-1">${label.subtitle}</span>
				</div>
				<label class="cursor-pointer flex items-center gap-0.5">
					<input type="checkbox" class="toggle toggle-xs scope-toggle" data-scope="global"
						${globalRules.some(r => !r.disabled) ? 'checked' : ''} />
				</label>
			</div>
		`
		if (globalRules.length === 0) {
			html += `<p class="text-center text-base-content/30 py-3 text-[11px]">无规则</p>`
		}
		for (const rule of globalRules) {
			html += renderRuleItemHTML(rule, 'amber', false)
		}
		html += `</div>`
	}

	// 渲染 scoped 分组（按角色分组）
	const scopedRules = groups.scoped
	if (scopedRules.length > 0 || !filter) {
		const label = { title: '角色正则脚本', subtitle: showAllScoped ? '全部角色' : '只影响当前角色', color: 'blue' }
		html += `
		<div class="regex-scope-group">
			<div class="px-2 py-1.5 bg-base-300/30 sticky top-0 z-10 flex items-center justify-between">
				<div>
					<span class="font-bold text-${label.color}-700 text-xs">${label.title}</span>
					<span class="text-[10px] text-base-content/40 ml-1">${label.subtitle}</span>
				</div>
				<label class="cursor-pointer flex items-center gap-0.5">
					<input type="checkbox" class="toggle toggle-xs scope-toggle" data-scope="scoped"
						${scopedRules.some(r => !r.disabled) ? 'checked' : ''} />
				</label>
			</div>
		`
		html += renderGroupedRules(scopedRules, currentCharName, 'blue', 'scoped')
		html += `</div>`
	}

	// 渲染 preset 分组（按预设名分组，复用相同逻辑）
	const presetRules = groups.preset
	if (presetRules.length > 0 || !filter) {
		const label = { title: '预设正则脚本', subtitle: showAllScoped ? '全部预设' : '只影响当前预设', color: 'green' }
		html += `
		<div class="regex-scope-group">
			<div class="px-2 py-1.5 bg-base-300/30 sticky top-0 z-10 flex items-center justify-between">
				<div>
					<span class="font-bold text-${label.color}-700 text-xs">${label.title}</span>
					<span class="text-[10px] text-base-content/40 ml-1">${label.subtitle}</span>
				</div>
				<label class="cursor-pointer flex items-center gap-0.5">
					<input type="checkbox" class="toggle toggle-xs scope-toggle" data-scope="preset"
						${presetRules.some(r => !r.disabled) ? 'checked' : ''} />
				</label>
			</div>
		`
		html += renderGroupedRules(presetRules, currentCharName, 'green', 'preset')
		html += `</div>`
	}

	if (filtered.length === 0 && filter) {
		html = '<p class="text-center text-base-content/40 py-6 text-xs">无匹配规则</p>'
	}

	listEl.innerHTML = html

	// 绑定列表事件
	listEl.querySelectorAll('.regex-rule-item').forEach(item => {
		item.addEventListener('click', (e) => {
			if (e.target.classList.contains('rule-toggle') || e.target.classList.contains('rule-menu-btn')) return
			const ruleId = item.dataset.ruleId
			selectRule(ruleId)
		})
	})

	listEl.querySelectorAll('.rule-toggle').forEach(cb => {
		cb.addEventListener('change', async (e) => {
			e.stopPropagation()
			const ruleId = cb.dataset.ruleId
			const rule = allRules.find(r => r.id === ruleId)
			if (rule) {
				rule.disabled = !cb.checked
				await setRegexData({ _action: 'updateRule', rule: { id: ruleId, disabled: rule.disabled } })
				renderRuleList(container?.querySelector('#regex-search')?.value || '')
			}
		})
	})

	listEl.querySelectorAll('.rule-menu-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			showRuleContextMenu(btn.dataset.ruleId, e)
		})
	})

	// 绑定折叠组事件
	listEl.querySelectorAll('.char-group-toggle').forEach(toggle => {
		toggle.addEventListener('click', () => {
			const groupKey = toggle.dataset.groupKey
			const contentEl = listEl.querySelector(`.char-group-content[data-group-key="${groupKey}"]`)
			if (!contentEl) return
			const isHidden = contentEl.style.display === 'none'
			contentEl.style.display = isHidden ? '' : 'none'
			if (isHidden) {
				expandedCharGroups.add(groupKey)
			} else {
				expandedCharGroups.delete(groupKey)
			}
			// 更新箭头
			const arrow = toggle.querySelector('span:last-child')
			if (arrow) arrow.textContent = isHidden ? '▼' : '▶'
		})
	})

	// 更新统计
	const statsEl = container?.querySelector('#regex-stats')
	if (statsEl) {
		const enabled = allRules.filter(r => !r.disabled).length
		statsEl.textContent = `共 ${allRules.length} 条规则 · ${enabled} 启用`
	}
}

// ============================================================
// 规则编辑器渲染
// ============================================================

function selectRule(ruleId) {
	selectedRuleId = ruleId
	const rule = allRules.find(r => r.id === ruleId)
	if (!rule) return

	renderRuleList(container?.querySelector('#regex-search')?.value || '')
	renderEditorForm(rule)
}

function renderEditorForm(rule) {
	const emptyState = container?.querySelector('#regex-empty-state')
	const editForm = container?.querySelector('#regex-edit-form')
	if (!emptyState || !editForm) return

	emptyState.classList.add('hidden')
	editForm.classList.remove('hidden')

	const scopeColors = { global: 'amber', scoped: 'blue', preset: 'green' }
	const scopeLabels = { global: '全局', scoped: '角色', preset: '预设' }
	const color = scopeColors[rule.scope] || 'amber'

	editForm.innerHTML = `
<div class="p-4 space-y-3">
	<!-- 标题栏 + 测试模式 -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<span class="font-bold text-sm text-${color}-700">正则脚本编辑器</span>
			<span class="badge badge-xs badge-outline border-${color}-600 text-${color}-600">${scopeLabels[rule.scope]}</span>
		</div>
		<button id="regex-test-toggle" class="btn btn-xs ${isTestMode ? 'btn-warning' : 'btn-outline'}" title="测试模式">
			🧪 测试模式
		</button>
	</div>

	<!-- 测试区域（默认隐藏） -->
	<div id="regex-test-area" class="${isTestMode ? '' : 'hidden'} bg-base-300/30 rounded-lg p-3 space-y-2">
		<div class="flex items-center gap-2">
			<span class="text-xs font-medium text-amber-700">测试模式</span>
			<span class="text-[10px] text-base-content/40">输入文本查看正则效果（实时更新）</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			<div>
				<label class="text-[10px] text-base-content/50">输入</label>
				<textarea id="regex-test-input" class="textarea textarea-xs textarea-bordered w-full font-mono text-xs" rows="3" placeholder="在此输入测试文本..."></textarea>
			</div>
			<div>
				<label class="text-[10px] text-base-content/50">输出</label>
				<div id="regex-test-output" class="bg-base-100 border border-base-300 rounded-lg p-2 min-h-[60px] font-mono text-xs whitespace-pre-wrap break-all text-base-content/70">
					输出将在此显示
				</div>
			</div>
		</div>
	</div>

	<!-- 脚本名称 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">脚本名称</span></label>
		<input type="text" id="edit-script-name" value="${escapeAttr(rule.scriptName)}"
			class="input input-sm input-bordered w-full" placeholder="规则名称" />
	</div>

	<!-- 查找正则 -->
	<div class="form-control">
		<label class="label py-0.5">
			<span class="label-text text-xs font-medium">查找正则表达式</span>
			<span class="label-text-alt text-[10px] text-base-content/40" id="regex-flag-hint">匹配第一个，区分大小写</span>
		</label>
		<input type="text" id="edit-find-regex" value="${escapeAttr(rule.findRegex)}"
			class="input input-sm input-bordered w-full font-mono text-xs" placeholder="/pattern/flags 或纯文本" />
	</div>

	<!-- 替换为 -->
	<div class="form-control">
		<label class="label py-0.5">
			<span class="label-text text-xs font-medium">替换为</span>
			<span class="label-text-alt text-[10px] text-base-content/40">支持 $1, $2, {{match}}</span>
		</label>
		<textarea id="edit-replace-string" class="textarea textarea-sm textarea-bordered w-full font-mono text-xs" rows="4" placeholder="替换内容">${escapeHtml(rule.replaceString || '')}</textarea>
	</div>

	<!-- 修剪掉 -->
	<div class="form-control">
		<label class="label py-0.5">
			<span class="label-text text-xs font-medium">修剪掉</span>
			<span class="label-text-alt text-[10px] text-base-content/40">替换前从匹配文本中移除，换行分隔</span>
		</label>
		<textarea id="edit-trim-strings" class="textarea textarea-xs textarea-bordered w-full font-mono text-xs" rows="2" placeholder="每行一个要移除的字符串">${escapeHtml(rule.trimStrings || '')}</textarea>
	</div>

	<!-- 作用范围 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">作用范围</span></label>
		<div class="flex flex-wrap gap-3">
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="user_input"
					${rule.placement?.includes('user_input') ? 'checked' : ''} />
				<span class="text-xs">用户输入</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="ai_output"
					${rule.placement?.includes('ai_output') ? 'checked' : ''} />
				<span class="text-xs">AI输出</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="slash_command"
					${rule.placement?.includes('slash_command') ? 'checked' : ''} />
				<span class="text-xs">快捷命令</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="world_info"
					${rule.placement?.includes('world_info') ? 'checked' : ''} />
				<span class="text-xs">世界信息</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="reasoning"
					${rule.placement?.includes('reasoning') ? 'checked' : ''} />
				<span class="text-xs">推理</span>
			</label>
		</div>
	</div>

	<!-- 其他选项 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">其他选项</span></label>
		<div class="flex flex-wrap gap-3">
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="edit-disabled" class="checkbox checkbox-xs"
					${rule.disabled ? 'checked' : ''} />
				<span class="text-xs">已禁用</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="edit-run-on-edit" class="checkbox checkbox-xs"
					${rule.runOnEdit ? 'checked' : ''} />
				<span class="text-xs">在编辑时运行</span>
				</label>
			</div>
		</div>
	
		<!-- 绑定角色（仅 scoped 规则生效） -->
			<div class="form-control" id="bound-char-section" ${rule.scope !== 'scoped' ? 'style="display:none"' : ''}>
				<label class="label py-0.5">
					<span class="label-text text-xs font-medium">绑定角色名</span>
					<span class="label-text-alt text-[10px] text-base-content/40">scoped 规则仅对此角色生效，留空则对所有角色生效</span>
				</label>
				<input type="text" id="edit-bound-char-name" value="${escapeAttr(rule.boundCharName || '')}"
					class="input input-sm input-bordered w-full" placeholder="角色名称（如：贝露）" />
			</div>
	
		<!-- 绑定预设（仅 preset 规则生效） -->
			<div class="form-control" id="bound-preset-section" ${rule.scope !== 'preset' ? 'style="display:none"' : ''}>
				<label class="label py-0.5">
					<span class="label-text text-xs font-medium">绑定预设名</span>
					<span class="label-text-alt text-[10px] text-base-content/40">preset 规则仅在该预设激活时生效</span>
				</label>
				<input type="text" id="edit-bound-preset-name" value="${escapeAttr(rule.boundPresetName || '')}"
					class="input input-sm input-bordered w-full" placeholder="预设名称" />
			</div>
	
		<!-- 宏替换模式 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">正则表达式查找时的宏</span></label>
		<select id="edit-substitute-regex" class="select select-xs select-bordered w-full max-w-xs">
			<option value="0" ${rule.substituteRegex === 0 ? 'selected' : ''}>不替换</option>
			<option value="1" ${rule.substituteRegex === 1 ? 'selected' : ''}>原始</option>
			<option value="2" ${rule.substituteRegex === 2 ? 'selected' : ''}>转义</option>
		</select>
	</div>

	<!-- 深度设置 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">深度设置</span></label>
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-1">
				<span class="text-xs text-base-content/60">最小深度</span>
				<input type="number" id="edit-min-depth" value="${rule.minDepth ?? -1}" min="-1"
					class="input input-xs input-bordered w-20 font-mono text-xs" />
			</div>
			<div class="flex items-center gap-1">
				<span class="text-xs text-base-content/60">最大深度</span>
				<input type="number" id="edit-max-depth" value="${rule.maxDepth ?? 0}" min="0"
					class="input input-xs input-bordered w-20 font-mono text-xs" />
			</div>
		</div>
		<span class="text-[10px] text-base-content/40 mt-0.5">最小=-1 为无限制, 0=最新消息; 最大=0 为无限制</span>
	</div>

	<!-- 瞬时性 -->
	<div class="form-control">
		<label class="label py-0.5"><span class="label-text text-xs font-medium">瞬时</span></label>
		<div class="flex flex-wrap gap-3">
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="edit-markdown-only" class="checkbox checkbox-xs"
					${rule.markdownOnly ? 'checked' : ''} />
				<span class="text-xs">仅格式显示</span>
			</label>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="edit-prompt-only" class="checkbox checkbox-xs"
					${rule.promptOnly ? 'checked' : ''} />
				<span class="text-xs">仅格式提示词</span>
			</label>
		</div>
		<span class="text-[10px] text-base-content/40 mt-0.5">默认（均不勾选）= 直接修改聊天记录。勾选后不改聊天文件</span>
	</div>

	<!-- 保存/删除 -->
	<div class="flex items-center gap-2 pt-2 border-t border-base-300/50">
		<button id="regex-save-btn" class="btn btn-sm bg-amber-700 hover:bg-amber-800 text-white border-amber-700 flex-1">
			💾 保存
		</button>
		<button id="regex-export-btn" class="btn btn-sm btn-outline border-amber-700 text-amber-700" title="导出此规则">
			📤
		</button>
		<button id="regex-duplicate-btn" class="btn btn-sm btn-outline" title="复制此规则">
			📋
		</button>
		<button id="regex-delete-btn" class="btn btn-sm btn-outline btn-error" title="删除此规则">
			🗑️
		</button>
	</div>
</div>
`

	// 绑定编辑器事件
	bindEditorEvents(rule)
}

// ============================================================
// 编辑器事件绑定
// ============================================================

function bindEditorEvents(rule) {
	const form = container?.querySelector('#regex-edit-form')
	if (!form) return

	// 测试模式切换
	form.querySelector('#regex-test-toggle')?.addEventListener('click', () => {
		isTestMode = !isTestMode
		const testArea = form.querySelector('#regex-test-area')
		const toggleBtn = form.querySelector('#regex-test-toggle')
		if (testArea) testArea.classList.toggle('hidden', !isTestMode)
		if (toggleBtn) {
			toggleBtn.classList.toggle('btn-warning', isTestMode)
			toggleBtn.classList.toggle('btn-outline', !isTestMode)
		}
	})

	// 实时测试
	const testInput = form.querySelector('#regex-test-input')
	const testOutput = form.querySelector('#regex-test-output')
	const findRegexInput = form.querySelector('#edit-find-regex')
	const replaceStringInput = form.querySelector('#edit-replace-string')
	const trimStringsInput = form.querySelector('#edit-trim-strings')

	function runTest() {
		if (!isTestMode || !testInput || !testOutput) return
		const input = testInput.value
		if (!input) { testOutput.textContent = '输出将在此显示'; return }

		const testRule = collectFormData()
		// 本地执行测试（不走后端）
		try {
			const output = localTestRule(input, testRule)
			testOutput.textContent = output
			testOutput.classList.toggle('text-success', output !== input)
			testOutput.classList.toggle('text-base-content/70', output === input)
		} catch (err) {
			testOutput.textContent = `错误: ${err.message}`
			testOutput.classList.add('text-error')
		}
	}

	testInput?.addEventListener('input', runTest)
	findRegexInput?.addEventListener('input', () => {
		updateFlagHint(findRegexInput.value)
		runTest()
	})
	replaceStringInput?.addEventListener('input', runTest)
	trimStringsInput?.addEventListener('input', runTest)

	// 初始化 flag hint
	if (findRegexInput) updateFlagHint(findRegexInput.value)

	// 保存
	form.querySelector('#regex-save-btn')?.addEventListener('click', async () => {
		const data = collectFormData()
		data.id = rule.id
		try {
			await setRegexData({ _action: 'updateRule', rule: data })
			// 更新本地数据
			const idx = allRules.findIndex(r => r.id === rule.id)
			if (idx !== -1) allRules[idx] = { ...allRules[idx], ...data }
			renderRuleList(container?.querySelector('#regex-search')?.value || '')
			// 刷新 display regex 缓存（markdownOnly 规则可能已变更）
			refreshDisplayRules().catch(() => {})
			showToast('规则已保存', 'success')
		} catch (err) {
			showToast('保存失败: ' + err.message, 'error')
		}
	})

	// 删除
	form.querySelector('#regex-delete-btn')?.addEventListener('click', async () => {
		if (!confirm(`确定删除规则 "${rule.scriptName || '(无名)'}" 吗？`)) return
		try {
			await setRegexData({ _action: 'removeRule', ruleId: rule.id })
			allRules = allRules.filter(r => r.id !== rule.id)
			selectedRuleId = null
			renderRuleList()
			showEmptyState()
			refreshDisplayRules().catch(() => {})
			showToast('规则已删除', 'success')
		} catch (err) {
			showToast('删除失败: ' + err.message, 'error')
		}
	})

	// 复制
	form.querySelector('#regex-duplicate-btn')?.addEventListener('click', async () => {
		try {
			const result = await setRegexData({ _action: 'duplicateRule', ruleId: rule.id })
			await loadData()
			if (result?._result?.id) selectRule(result._result.id)
			showToast('规则已复制', 'success')
		} catch (err) {
			showToast('复制失败: ' + err.message, 'error')
		}
	})

	// 导出单条
	form.querySelector('#regex-export-btn')?.addEventListener('click', async () => {
		try {
			const result = await setRegexData({ _action: 'exportRule', ruleId: rule.id })
			if (result?._result) {
				const blob = new Blob([JSON.stringify(result._result, null, 2)], { type: 'application/json' })
				const url = URL.createObjectURL(blob)
				const a = document.createElement('a')
				a.href = url
				a.download = `regex_${rule.scriptName || 'rule'}.json`
				a.click()
				URL.revokeObjectURL(url)
				showToast('规则已导出', 'success')
			}
		} catch (err) {
			showToast('导出失败: ' + err.message, 'error')
		}
	})
}

/**
 * 从编辑器表单收集数据
 * @returns {Partial<RegexScript>}
 */
function collectFormData() {
	const form = container?.querySelector('#regex-edit-form')
	if (!form) return {}

	const placementCbs = form.querySelectorAll('.placement-cb')
	const placement = []
	placementCbs.forEach(cb => { if (cb.checked) placement.push(cb.value) })

	return {
		scriptName: form.querySelector('#edit-script-name')?.value || '',
		findRegex: form.querySelector('#edit-find-regex')?.value || '',
		replaceString: form.querySelector('#edit-replace-string')?.value || '',
		trimStrings: form.querySelector('#edit-trim-strings')?.value || '',
		placement,
		disabled: form.querySelector('#edit-disabled')?.checked || false,
		runOnEdit: form.querySelector('#edit-run-on-edit')?.checked || false,
		substituteRegex: parseInt(form.querySelector('#edit-substitute-regex')?.value || '0', 10),
		minDepth: parseInt(form.querySelector('#edit-min-depth')?.value || '-1', 10),
		maxDepth: parseInt(form.querySelector('#edit-max-depth')?.value || '0', 10),
		markdownOnly: form.querySelector('#edit-markdown-only')?.checked || false,
		promptOnly: form.querySelector('#edit-prompt-only')?.checked || false,
		boundCharName: form.querySelector('#edit-bound-char-name')?.value || '',
		boundPresetName: form.querySelector('#edit-bound-preset-name')?.value || '',
	}
}

// ============================================================
// 本地测试引擎（前端实时预览用）
// ============================================================

function localTestRule(input, rule) {
	if (!input || !rule.findRegex) return input

	const match = rule.findRegex.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	let regex
	if (match) {
		try { regex = new RegExp(match[1].replace('\\/', '/'), match[2]) } catch { return input }
	} else {
		try { regex = new RegExp(rule.findRegex, 'g') } catch { return input }
	}

	const trimList = rule.trimStrings ? rule.trimStrings.split('\n').filter(s => s.length > 0) : []
	const replaceStr = rule.replaceString || ''

	return input.replace(regex, (matched, ...groups) => {
		let trimmed = matched
		for (const t of trimList) trimmed = trimmed.replaceAll(t, '')
		let result = replaceStr.replaceAll('{{match}}', trimmed)
		for (let i = 0; i < groups.length; i++) {
			if (typeof groups[i] === 'string') {
				result = result.replaceAll(`$${i + 1}`, groups[i])
			}
		}
		return result
	})
}

function updateFlagHint(findRegex) {
	const hint = container?.querySelector('#regex-flag-hint')
	if (!hint) return

	const match = findRegex?.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!match) {
		hint.textContent = '全局匹配, 区分大小写'
		return
	}

	const flags = match[2]
	const parts = []
	parts.push(flags.includes('g') ? '全局匹配' : '匹配第一个')
	parts.push(flags.includes('i') ? '不区分大小写' : '区分大小写')
	if (flags.includes('s')) parts.push('dotAll')
	if (flags.includes('m')) parts.push('多行')
	hint.textContent = parts.join(', ')
}

// ============================================================
// 右键菜单
// ============================================================

function showRuleContextMenu(ruleId, event) {
	// 移除已有菜单
	container?.querySelectorAll('.regex-context-menu').forEach(m => m.remove())

	const rule = allRules.find(r => r.id === ruleId)
	if (!rule) return

	const menu = document.createElement('div')
	menu.className = 'regex-context-menu fixed bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1 text-xs min-w-[140px]'
	menu.style.left = event.clientX + 'px'
	menu.style.top = event.clientY + 'px'

	const items = [
		{ label: '📋 复制', action: 'duplicate' },
		{ label: '📤 导出', action: 'export' },
		{ label: '—', action: 'divider' },
	]

	// 移动作用域
	if (rule.scope !== 'global') items.push({ label: '↑ 移为全局', action: 'move-global' })
	if (rule.scope !== 'scoped') items.push({ label: '↓ 移为角色', action: 'move-scoped' })
	if (rule.scope !== 'preset') items.push({ label: '→ 移为预设', action: 'move-preset' })

	items.push({ label: '—', action: 'divider' })
	items.push({ label: '🗑️ 删除', action: 'delete', danger: true })

	for (const item of items) {
		if (item.action === 'divider') {
			menu.innerHTML += '<div class="divider my-0.5 mx-2"></div>'
			continue
		}
		const btn = document.createElement('button')
		btn.className = `block w-full text-left px-3 py-1 hover:bg-base-300/50 ${item.danger ? 'text-error' : ''}`
		btn.textContent = item.label
		btn.addEventListener('click', async () => {
			menu.remove()
			switch (item.action) {
				case 'duplicate':
					await setRegexData({ _action: 'duplicateRule', ruleId })
					await loadData()
					break
				case 'export':
					const result = await setRegexData({ _action: 'exportRule', ruleId })
					if (result?._result) {
						downloadJson(result._result, `regex_${rule.scriptName || 'rule'}.json`)
					}
					break
				case 'move-global':
				case 'move-scoped':
				case 'move-preset':
					const newScope = item.action.replace('move-', '')
					await setRegexData({ _action: 'moveScope', ruleId, newScope })
					await loadData()
					break
				case 'delete':
					if (confirm(`确定删除规则 "${rule.scriptName}" 吗？`)) {
						await setRegexData({ _action: 'removeRule', ruleId })
						await loadData()
						if (selectedRuleId === ruleId) { selectedRuleId = null; showEmptyState() }
					}
					break
			}
		})
		menu.appendChild(btn)
	}

	document.body.appendChild(menu)

	// 点击其他地方关闭
	const closeMenu = (e) => {
		if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu) }
	}
	setTimeout(() => document.addEventListener('click', closeMenu), 0)
}

// ============================================================
// 全局事件绑定
// ============================================================

function bindEvents() {
	if (!container) return

	// 全局开关
	container.querySelector('#regex-global-toggle')?.addEventListener('change', async (e) => {
		globalEnabled = e.target.checked
		await setRegexData({ _action: 'toggleAll', enabled: globalEnabled })
	})

	// 渲染模式切换
	container.querySelectorAll('.render-mode-btn').forEach(btn => {
		btn.addEventListener('click', async () => {
			const mode = btn.dataset.mode
			if (mode === renderMode) return
			renderMode = mode
			try {
				await setRegexData({ _action: 'setRenderMode', renderMode: mode })
				// 更新按钮样式
				container.querySelectorAll('.render-mode-btn').forEach(b => {
					const isActive = b.dataset.mode === mode
					b.classList.toggle('bg-amber-700', isActive)
					b.classList.toggle('text-white', isActive)
					b.classList.toggle('btn-ghost', !isActive)
					b.classList.toggle('text-base-content/60', !isActive)
				})
				// 通知 displayRegex 模块更新
				refreshDisplayRules().catch(() => {})
				showToast(`渲染模式已切换为: ${mode === 'sandbox' ? '🔒 沙盒' : '🔓 自由'}`, 'success')
			} catch (err) {
				showToast('切换失败: ' + err.message, 'error')
			}
		})
	})

	// 新建规则
	container.querySelector('#regex-add-global')?.addEventListener('click', () => addRule('global'))
	container.querySelector('#regex-add-scoped')?.addEventListener('click', () => addRule('scoped'))
	container.querySelector('#regex-add-preset')?.addEventListener('click', () => addRule('preset'))

	// 搜索
	container.querySelector('#regex-search')?.addEventListener('input', (e) => {
		renderRuleList(e.target.value)
	})

	// 导入
	container.querySelector('#regex-import-btn')?.addEventListener('click', () => {
		container.querySelector('#regex-file-input')?.click()
	})
	container.querySelector('#regex-file-input')?.addEventListener('change', handleImport)

	// 显示全部 scoped 开关
	container.querySelector('#regex-show-all-toggle')?.addEventListener('change', (e) => {
		showAllScoped = e.target.checked
		renderRuleList(container?.querySelector('#regex-search')?.value || '')
	})

	// 导出全部
	container.querySelector('#regex-export-all-btn')?.addEventListener('click', handleExportAll)
}

async function addRule(scope) {
	try {
		const rule = { scope, scriptName: '新规则' }
		if (scope === 'scoped') {
			rule.boundCharName = getCurrentCharName()
		} else if (scope === 'preset') {
			rule.boundPresetName = getCurrentPresetName()
		}
		const result = await setRegexData({
			_action: 'addRule',
			rule,
		})
		await loadData()
		if (result?._result?.id) selectRule(result._result.id)
	} catch (err) {
		showToast('创建失败: ' + err.message, 'error')
	}
}

async function handleImport(e) {
	const file = e.target.files?.[0]
	if (!file) return
	try {
		const text = await file.text()
		const json = JSON.parse(text)

		// 判断是单条还是数组
		const scripts = Array.isArray(json) ? json : [json]
		const result = await setRegexData({ _action: 'importST', scripts, scope: 'global' })
		await loadData()
		refreshDisplayRules().catch(() => {})
		showToast(`已导入 ${result?._result?.count || scripts.length} 条正则规则`, 'success')
	} catch (err) {
		showToast('导入失败: ' + err.message, 'error')
	}
	e.target.value = ''
}

async function handleExportAll() {
	try {
		const result = await setRegexData({ _action: 'exportAll' })
		if (result?._result) {
			downloadJson(result._result, 'regex_scripts_all.json')
			showToast('全部规则已导出', 'success')
		}
	} catch (err) {
		showToast('导出失败: ' + err.message, 'error')
	}
}

// ============================================================
// 数据加载
// ============================================================

async function loadData() {
	try {
		const data = await getRegexData()
		allRules = data.rules || []
		globalEnabled = data.enabled !== false
		renderMode = data.renderMode || 'sandbox'

		const toggle = container?.querySelector('#regex-global-toggle')
		if (toggle) toggle.checked = globalEnabled

		// 更新渲染模式按钮状态
		container?.querySelectorAll('.render-mode-btn').forEach(b => {
			const isActive = b.dataset.mode === renderMode
			b.classList.toggle('bg-amber-700', isActive)
			b.classList.toggle('text-white', isActive)
			b.classList.toggle('btn-ghost', !isActive)
			b.classList.toggle('text-base-content/60', !isActive)
		})

		renderRuleList()
	} catch (err) {
		console.error('[regex-editor] 加载数据失败:', err)
		const listEl = container?.querySelector('#regex-list')
		if (listEl) listEl.innerHTML = '<p class="text-center text-error py-4 text-xs">加载失败: ' + err.message + '</p>'
	}
}

function showEmptyState() {
	const emptyState = container?.querySelector('#regex-empty-state')
	const editForm = container?.querySelector('#regex-edit-form')
	if (emptyState) emptyState.classList.remove('hidden')
	if (editForm) editForm.classList.add('hidden')
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str || ''
	return div.innerHTML
}

function escapeAttr(str) {
	return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function downloadJson(data, filename) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	a.click()
	URL.revokeObjectURL(url)
}

function showToast(message, type = 'info') {
	const toast = document.createElement('div')
	const alertType = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : type === 'warning' ? 'alert-warning' : 'alert-info'
	toast.className = `alert ${alertType} fixed top-4 right-4 z-[100] max-w-sm shadow-lg text-sm`
	toast.innerHTML = `<span>${escapeHtml(message)}</span>`
	document.body.appendChild(toast)
	setTimeout(() => {
		toast.style.opacity = '0'
		toast.style.transition = 'opacity 0.3s'
		setTimeout(() => toast.remove(), 300)
	}, 3000)
}
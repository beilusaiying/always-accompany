/**
 * regexEditor.mjs — ST 风格正则脚本编辑器（完整管理器）
 *
 * 功能链：
 *   initRegexEditor(container) → buildMainHTML → bindEvents → loadData
 *     → GET beilu-regex getdata → allRules 列表 + globalEnabled + guardConfig
 *     → 渲染三级作用域规则列表（全局/角色卡 scoped/预设 preset）
 *     → 各角色名折叠组（expandedCharGroups Set 控制展开态）
 *   点规则行 → selectRule → 右侧编辑器填充所有 ST 字段
 *     （pattern/flags/replaceStr/trimList/disabled/markdownOnly/runOn/minActivations/maxActivations 等）
 *   点「保存」→ POST beilu-regex setdata {action:"saveRule", rule} → 后端持久化
 *     → refreshDisplayRules（displayRegex 立刻用新规则）
 *   点「删除」→ beiluConfirm → POST {action:"deleteRule"}
 *   拖拽排序（dragstart/dragover/drop）→ 重新排列 allRules → POST {action:"reorderRules"}
 *   实时测试模式（isTestMode=true）→ 输入测试文本 → computeReplacement 实时预览替换结果
 *   导入：点「导入」→ <input type="file"> JSON → POST {action:"importRules"}
 *   导出：点「导出」→ JSON.stringify(allRules) → download
 *   ReDoS 护栏：编辑 pattern 时 assessRegexComplexity → 超阈值显示橙色警告
 *   showAllScoped toggle → 控制是否显示所有角色的 scoped/preset 规则（默认只显当前角色）
 *
 * why（guardConfig 从后端拉取而非硬编码）：
 *   ReDoS 护栏参数（maxInputLength / maxQuantifiers / maxNestedQuantifierDepth）由后端 beilu-regex
 *   配置文件控制，前端从 loadData 响应中获取 guardConfig，保持前后端护栏阈值一致。
 *
 * 关联链：
 *   → shared/regex-core/regexCore.mjs（assessRegexComplexity / computeReplacement / REGEX_MAX_INPUT_LENGTH）
 *   → shared/render/displayRegex.mjs refreshDisplayRules（保存规则后立刻刷新显示层）
 *   → shared/transport/api-client.mjs apiFetch（beilu-regex getdata/setdata 所有操作）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm（删除规则确认）
 *   → shared/widgets/whitebox.mjs wbDetect（异常上报）
 *   ← layout.mjs（正则 Tab 激活时调用 initRegexEditor）
 *
 * 影响范围：
 *   container DOM（三栏布局：作用域列表 + 编辑器 + 测试区）；
 *   后端 beilu-regex 规则配置文件（saveRule/deleteRule/reorderRules 落盘）；
 *   displayRegex 运行时规则缓存（保存后立刻更新）。
 *
 * 使用效果：
 *   编辑正则规则 → 实时测试预览替换效果 → 保存后消息渲染立刻使用新规则；
 *   拖拽调整执行顺序；角色折叠组快速筛选 scoped 规则；ReDoS 警告提前暴露危险正则。
 */

import { refreshDisplayRules } from '../../shared/render/displayRegex.mjs'
import { escapeHtml, positionContextMenu, bindClickOutsideClose, downloadBlob } from '../../shared/state/utils.mjs' // [合并批 0714·二] 点外关闭收口单源；0716 下载基元收口
import { getCharId } from '../../shared/state/sharedState.mjs' // P-A根修：charId 单源（替代 DOM textContent 读法）
import { wbDetect } from '../../shared/widgets/whitebox.mjs'
import { assessRegexComplexity, REGEX_MAX_INPUT_LENGTH } from '../../shared/regex-core/regexCore.mjs'
import { sendAction } from '../../shared/transport/sendAction.mjs' // T6b批7：出向统一门面（verb=真动作），beilu-regex getdata/setdata 收口
import { beiluConfirm } from '../../shared/widgets/beiluDialog.mjs';
import { enableDragAutoScroll } from '../../shared/widgets/dragAutoScroll.mjs' // 0722：拖拽排序中 wheel 被浏览器抑制→边缘自动滚动
import { recordImportHistory } from '../settings/importExport.mjs' // T033：正则导入成功上报集中历史

// ============================================================
// API 通信（T6b批7：apiFetch → sendAction 门面。
//   getRegexData = beilu-regex getData（GET getdata）；
//   setRegexData(data) 的 data 形如 {_action:'saveRule',...rest}，verb=真动作，payload=其余字段，
//   门面 plugins:beilu-regex#* 通配路由把 {_action:verb,...payload} 组装回后端契约体，行为等价。）
// ============================================================

async function getRegexData() {
	return sendAction({ verb: "getData", target: "plugins:beilu-regex", source: "web" })
}

async function setRegexData(data) {
	const { _action, ...rest } = data ?? {}
	return sendAction({ verb: _action, target: "plugins:beilu-regex", source: "web", payload: rest })
}

// ============================================================
// 状态
// ============================================================

let allRules = []
let selectedRuleId = null
let globalEnabled = true
let isTestMode = false
let renderMode = 'sandbox' // 'sandbox' | 'free'
/** @type {{ enabled:boolean, maxInputLength:number, maxQuantifiers:number, maxNestedQuantifierDepth:number }|null} */
let guardConfig = null // ReDoS 护栏当前生效配置，loadData 从后端拉取
// T072BC（可操作处禁硬编码）：护栏安全默认阈值由后端单源下发（GetData.regexGuardDefaults=
//   regexGuard.mjs DEFAULT_GUARD_CONFIG），供「重置默认」与回填 fallback 用，消除前端写死 {1000000/60/0} 副本。
//   退化：后端未下发（旧后端/离线）→ 用下方静态兜底常量，保离线可用零回归。
const GUARD_DEFAULTS_FALLBACK = { enabled: true, maxInputLength: 1000000, maxQuantifiers: 60, maxNestedQuantifierDepth: 0 }
/** @type {typeof GUARD_DEFAULTS_FALLBACK} 后端下发的护栏安全默认（loadData 回填；未下发时=静态兜底） */
let guardDefaults = { ...GUARD_DEFAULTS_FALLBACK }
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
			<span class="font-bold text-sm" style="color:var(--beilu-amber)"><i data-ic="abc"></i> 正则脚本</span>
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" id="regex-global-toggle" class="toggle toggle-xs toggle-warning" checked />
				<span class="text-xs">启用</span>
			</label>
		</div>
		<div class="flex items-center gap-1">
			<div id="regex-render-mode" class="flex items-center bg-base-300/50 rounded-md px-0.5 py-0.5 gap-0">
				<button class="render-mode-btn btn btn-xs px-2 ${renderMode === 'sandbox' ? 'text-white' : 'btn-ghost text-base-content/60'}" data-mode="sandbox" title="沙盒模式：iframe 隔离渲染" ${renderMode === 'sandbox' ? 'style="background:var(--beilu-amber)"' : ''}><i data-ic="lock"></i> 沙盒</button>
				<button class="render-mode-btn btn btn-xs px-2 ${renderMode === 'free' ? 'text-white' : 'btn-ghost text-base-content/60'}" data-mode="free" title="自由模式：直接注入页面" ${renderMode === 'free' ? 'style="background:var(--beilu-amber)"' : ''}><i data-ic="lock-open"></i> 自由</button>
			</div>
			<div class="divider divider-horizontal mx-0.5 w-px h-4"></div>
			<button id="regex-add-global" class="btn btn-xs btn-outline" style="border-color:var(--beilu-amber);color:var(--beilu-amber)" title="新建全局规则">
				+ 全局
			</button>
			<button id="regex-add-scoped" class="btn btn-xs btn-outline border-blue-600 text-blue-600 hover:bg-blue-600 hover:text-white" title="新建角色规则">
				+ 角色
			</button>
			<button id="regex-add-preset" class="btn btn-xs btn-outline border-green-600 text-green-600 hover:bg-green-600 hover:text-white" title="新建预设规则">
				+ 预设
			</button>
			<button id="regex-import-btn" class="btn btn-xs btn-ghost" title="导入 ST 正则脚本"><i data-ic="download"></i></button>
			<button id="regex-export-all-btn" class="btn btn-xs btn-ghost" title="导出全部"><i data-ic="upload"></i></button>
			<button id="regex-guard-toggle-panel" class="btn btn-xs btn-ghost" title="ReDoS 护栏配置"><i data-ic="shield"></i></button>
			<button id="regex-striptags-toggle-panel" class="btn btn-xs btn-ghost" title="输出标签管控"><i data-ic="scissors"></i></button>
			<input type="file" id="regex-file-input" accept=".json" class="hidden" />
		</div>
	</div>

	<!-- ReDoS 护栏配置面板（默认收起） -->
	<div id="regex-guard-panel" class="hidden border-b border-base-300 bg-base-200/60 px-4 py-2 text-xs shrink-0">
		<div class="flex items-center gap-2 mb-2">
			<span class="font-bold text-sm"><i data-ic="shield"></i> ReDoS 护栏</span>
			<span class="text-base-content/50">正则安全防护配置</span>
		</div>
		<div class="grid grid-cols-2 gap-x-4 gap-y-2">
			<!-- 总开关 -->
			<label class="flex items-center gap-2 col-span-2">
				<input type="checkbox" id="guard-enabled" class="toggle toggle-xs toggle-success" checked />
				<span>护栏总开关</span>
				<span class="text-base-content/40">（关闭=完全退回原生替换，仅供调试）</span>
			</label>
			<!-- 输入长度上限 -->
			<label class="flex items-center gap-2">
				<span class="w-28 shrink-0">输入长度上限</span>
				<input type="number" id="guard-maxInputLength" class="input input-xs input-bordered w-28" min="1000" step="10000" />
			</label>
			<!-- 量词数上限 -->
			<label class="flex items-center gap-2">
				<span class="w-28 shrink-0">量词数上限</span>
				<input type="number" id="guard-maxQuantifiers" class="input input-xs input-bordered w-28" min="1" step="5" />
			</label>
			<!-- 嵌套量词深度 -->
			<label class="flex items-center gap-2 col-span-2">
				<span class="w-28 shrink-0">嵌套量词深度</span>
				<input type="number" id="guard-maxNestedQuantifierDepth" class="input input-xs input-bordered w-28" min="0" step="1" />
				<span class="text-base-content/40">（0=禁止嵌套量词回退，安全默认）</span>
			</label>
		</div>
		<div class="flex justify-end mt-2 gap-2">
			<button id="guard-reset-btn" class="btn btn-xs btn-ghost text-warning" title="重置为安全默认值">重置默认</button>
			<button id="guard-save-btn" class="btn btn-xs btn-outline btn-success">保存护栏配置</button>
		</div>
	</div>

	<!-- 输出标签管控面板（默认收起） -->
	<div id="regex-striptags-panel" class="hidden border-b border-base-300 bg-base-200/60 px-4 py-2 text-xs shrink-0">
		<div class="flex items-center gap-2 mb-2">
			<span class="font-bold text-sm"><i data-ic="scissors"></i> 输出标签管控</span>
			<span class="text-base-content/50">从 AI 输出中剥离的自定义标签与正则（每行一个）</span>
		</div>
		<div class="grid grid-cols-2 gap-x-4 gap-y-2">
			<div>
				<label class="text-xs font-medium">剥离标签</label>
				<textarea id="striptags-tags" class="textarea textarea-bordered w-full text-xs font-mono mt-1" style="min-height:64px;" placeholder="thinking\nreasoning"></textarea>
			</div>
			<div>
				<label class="text-xs font-medium">剥离正则</label>
				<textarea id="striptags-patterns" class="textarea textarea-bordered w-full text-xs font-mono mt-1" placeholder="<!--[\\s\\S]*?-->"></textarea>
			</div>
		</div>
		<div class="flex justify-end mt-2 gap-2">
			<button id="striptags-save-btn" class="btn btn-xs btn-outline btn-success">保存标签配置</button>
		</div>
		<div id="striptags-status" class="text-xs text-center hidden mt-1"></div>
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
			<div id="regex-empty-state" class="flex-1 flex items-center justify-center text-base-content/50">
				<div class="text-center">
					<div class="text-4xl mb-3"><i data-ic="abc"></i></div>
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
	// P-A根修（2026-07-05）：原读 #char-name-display textContent=显示名，与后端角色隔离键（卡目录名）不同物，
	//   且角色未加载时会把占位文案"未加载角色"当角色名持久化进 rule.boundCharName（memtool 同型病）。
	//   改 sharedState.getCharId() 单源（读写/过滤/展示四处消费同走本函数，前后一致）。
	//   边缘：历史规则若曾以"显示名≠目录名"绑定会失配——属存量数据校准，登记不掩盖。
	return getCharId() || ''
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
	<div class="regex-rule-item flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-base-300/50 border-l-2 ${isSelected ? (colorClass === 'amber' ? 'bg-base-300/60' : `border-${colorClass}-500 bg-base-300/60`) : 'border-transparent'}"
		${isSelected && colorClass === 'amber' ? 'style="border-color:var(--beilu-amber)"' : ''}
		data-rule-id="${escapeHtml(rule.id)}">
		<span class="drag-handle cursor-grab text-base-content/50 hover:text-base-content/60" title="拖拽排序">≡</span>
		<input type="checkbox" class="checkbox checkbox-xs checkbox-warning rule-toggle"
			data-rule-id="${escapeHtml(rule.id)}" ${rule.disabled ? '' : 'checked'} />
		<span class="flex-1 truncate ${rule.disabled ? 'line-through opacity-40' : ''}">${escapeHtml(rule.scriptName || '(无名)')}</span>
		${charLabelHtml}
		<div class="flex items-center gap-0.5 opacity-60">
			${rule.placement?.includes('user_input') ? '<span class="badge badge-xs" title="用户输入">U</span>' : ''}
			${rule.placement?.includes('ai_output') ? '<span class="badge badge-xs" title="AI输出">A</span>' : ''}
			${rule.placement?.includes('world_info') ? '<span class="badge badge-xs" title="世界信息">W</span>' : ''}
			${rule.placement?.includes('output_filter') ? '<span class="badge badge-xs" title="输出截断">F</span>' : ''}
		</div>
		<button class="btn btn-xs btn-ghost btn-square rule-menu-btn opacity-0 group-hover:opacity-100" data-rule-id="${escapeHtml(rule.id)}" title="更多">⋯</button>
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
			return `<p class="text-center text-base-content/50 py-3 text-[11px]">当前${emptyLabel}无${emptyLabel}规则</p>`
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
		return `<p class="text-center text-base-content/50 py-3 text-[11px]">无规则</p>`
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
				<span class="text-[10px] text-base-content/50">${isExpanded ? '▼' : '▶'}</span>
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
	enableDragAutoScroll(listEl) // 0722：规则拖拽排序边缘自动滚动（幂等注册）

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
					<span class="font-bold text-xs" style="color:var(--beilu-amber)">${label.title}</span>
					<span class="text-[10px] text-base-content/40 ml-1">${label.subtitle}</span>
				</div>
				<label class="cursor-pointer flex items-center gap-0.5">
					<input type="checkbox" class="toggle toggle-xs scope-toggle" data-scope="global"
						${globalRules.some(r => !r.disabled) ? 'checked' : ''} />
				</label>
			</div>
		`
		if (globalRules.length === 0) {
			html += `<p class="text-center text-base-content/50 py-3 text-[11px]">无规则</p>`
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
				const prevDisabled = rule.disabled
				const newDisabled = !cb.checked
				rule.disabled = newDisabled
				try {
					await setRegexData({ _action: 'updateRule', rule: { id: ruleId, disabled: newDisabled } })
				} catch (err) {
					// Drift 修复:后端保存失败回滚内存态+复选框,避免内存/DOM 与后端脱节
					rule.disabled = prevDisabled
					cb.checked = !prevDisabled
					_reportError('切换规则状态失败', err)
				}
				renderRuleList(container?.querySelector('#regex-search')?.value || '')
			}
		})
	})

	// N7: 分组头 scope-toggle = 批量启停整组（照 N7 预览，仿 .rule-toggle 范式；部分启用呈 indeterminate）
	listEl.querySelectorAll('.scope-toggle').forEach(cb => {
		const scope = cb.dataset.scope
		const scopeRules = groups[scope] || []
		const enabledCount = scopeRules.filter(r => !r.disabled).length
		cb.indeterminate = enabledCount > 0 && enabledCount < scopeRules.length
		cb.addEventListener('change', async (e) => {
			e.stopPropagation()
			const newDisabled = !cb.checked
			const prev = scopeRules.map(r => ({ id: r.id, disabled: r.disabled }))
			scopeRules.forEach(r => { r.disabled = newDisabled })
			try {
				await Promise.all(scopeRules.map(r => setRegexData({ _action: 'updateRule', rule: { id: r.id, disabled: newDisabled } })))
			} catch (err) {
				prev.forEach(p => { const r = allRules.find(x => x.id === p.id); if (r) r.disabled = p.disabled })
				_reportError('批量切换分组规则失败', err)
			}
			renderRuleList(container?.querySelector('#regex-search')?.value || '')
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
			<span class="font-bold text-sm ${color !== 'amber' ? `text-${color}-700` : ''}" ${color === 'amber' ? 'style="color:var(--beilu-amber)"' : ''}>正则脚本编辑器</span>
			<span class="badge badge-xs badge-outline ${color !== 'amber' ? `border-${color}-600 text-${color}-600` : ''}" ${color === 'amber' ? 'style="border-color:var(--beilu-amber);color:var(--beilu-amber)"' : ''}>${scopeLabels[rule.scope]}</span>
		</div>
		<button id="regex-test-toggle" class="btn btn-xs ${isTestMode ? 'btn-warning' : 'btn-outline'}" title="测试模式">
			<i data-ic="flask"></i> 测试模式
		</button>
	</div>

	<!-- 测试区域（默认隐藏） -->
	<div id="regex-test-area" class="${isTestMode ? '' : 'hidden'} bg-base-300/30 rounded-lg p-3 space-y-2">
		<div class="flex items-center gap-2">
			<span class="text-xs font-medium" style="color:var(--beilu-amber)">测试模式</span>
			<span class="text-[10px] text-base-content/40">输入文本查看正则效果（实时更新）</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			<div>
				<label class="text-[10px] text-base-content/50">输入</label>
				<textarea id="regex-test-input" class="textarea textarea-xs textarea-bordered w-full font-mono text-xs" rows="3" placeholder="在此输入测试文本..."></textarea>
			</div>
			<div>
				<!-- R-UP-1 预览模式切换:text(纯文本)/html(innerHTML)/iframe(srcdoc 隔离渲染) -->
				<div class="flex items-center justify-between">
					<label class="text-[10px] text-base-content/50">输出</label>
					<div class="flex gap-1">
						<button type="button" data-preview-mode="text" class="btn btn-xs btn-ghost px-1 active" title="纯文本">T</button>
						<button type="button" data-preview-mode="html" class="btn btn-xs btn-ghost px-1" title="内嵌 HTML (同页面)">H</button>
						<button type="button" data-preview-mode="iframe" class="btn btn-xs btn-ghost px-1" title="iframe 沙盒渲染 (隔离样式)"><i data-ic="fullscreen"></i></button>
					</div>
				</div>
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
			<span class="label-text-alt text-[10px] text-base-content/40" id="regex-flag-hint">全局匹配，区分大小写</span>
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
		<div class="relative expandable-container"><textarea id="edit-replace-string" class="textarea textarea-sm textarea-bordered w-full font-mono text-xs" rows="4" placeholder="替换内容" data-expandable data-expand-title="替换内容">${escapeHtml(rule.replaceString || '')}</textarea><button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button></div>
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
			<label class="flex items-center gap-1 cursor-pointer" title="SEC-G: AI 输出后、写入聊天前做最后裁剪(长度/重复/未知标签)">
				<input type="checkbox" class="checkbox checkbox-xs checkbox-warning placement-cb" value="output_filter"
					${rule.placement?.includes('output_filter') ? 'checked' : ''} />
				<span class="text-xs">输出截断</span>
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
		<button id="regex-save-btn" class="btn btn-sm text-white flex-1" style="background:var(--beilu-amber);border-color:var(--beilu-amber)">
			<i data-ic="save"></i> 保存
		</button>
		<button id="regex-export-btn" class="btn btn-sm btn-outline" style="border-color:var(--beilu-amber);color:var(--beilu-amber)" title="导出此规则">
			<i data-ic="upload"></i>
		</button>
		<button id="regex-duplicate-btn" class="btn btn-sm btn-outline" title="复制此规则">
			<i data-ic="clipboard"></i>
		</button>
		<button id="regex-delete-btn" class="btn btn-sm btn-outline btn-error" title="删除此规则">
			<i data-ic="trash"></i>
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

	// R-UP-1: 预览模式状态,默认纯文本(向后兼容)
	//   text   — textContent,原有行为,看原始替换字符串
	//   html   — innerHTML,所见即所得(同页面样式)
	//   iframe — srcdoc 沙盒,完全隔离(和真实渲染一致)
	let previewMode = 'text'

	function runTest() {
		if (!isTestMode || !testInput || !testOutput) return
		const input = testInput.value
		if (!input) {
			testOutput.textContent = '输出将在此显示'
			testOutput.classList.remove('text-success', 'text-error')
			return
		}

		const testRule = collectFormData()
		let output
		try {
			output = localTestRule(input, testRule)
		} catch (err) {
			testOutput.textContent = `错误: ${err.message}`
			testOutput.classList.add('text-error')
			return
		}
		testOutput.classList.remove('text-error')

		// 根据 previewMode 决定如何渲染输出
		if (previewMode === 'html') {
			// 同页面 innerHTML,继承 beilu CSS,共享样式
			testOutput.classList.remove('whitespace-pre-wrap', 'break-all', 'font-mono')
			testOutput.innerHTML = output
		} else if (previewMode === 'iframe') {
			// 沙盒 iframe,隔离样式/脚本,最接近真实渲染效果
			testOutput.classList.remove('whitespace-pre-wrap', 'break-all', 'font-mono')
			testOutput.innerHTML = ''
			const iframe = document.createElement('iframe')
			iframe.sandbox = 'allow-scripts allow-same-origin'
			iframe.style.cssText = 'width:100%;min-height:60px;border:none;background:transparent;'
			iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:4px;font-family:sans-serif;font-size:12px;color:inherit;}</style></head><body>${output}</body></html>`
			testOutput.appendChild(iframe)
			// 延迟测量高度自适应
			iframe.addEventListener('load', () => {
				try {
					const h = iframe.contentDocument?.body?.scrollHeight
					if (h) iframe.style.height = Math.max(60, h + 8) + 'px'
				} catch { /* ignore */ }
			})
		} else {
			// text — 原行为,纯文本显示替换字符串
			testOutput.classList.add('whitespace-pre-wrap', 'break-all', 'font-mono')
			testOutput.textContent = output
		}
		testOutput.classList.toggle('text-success', output !== input && previewMode === 'text')
		testOutput.classList.toggle('text-base-content/70', output === input && previewMode === 'text')
	}

	// R-UP-1: 预览模式切换按钮绑定
	form.querySelectorAll('[data-preview-mode]').forEach(btn => {
		btn.addEventListener('click', () => {
			previewMode = btn.dataset.previewMode
			form.querySelectorAll('[data-preview-mode]').forEach(b => {
				b.classList.toggle('active', b === btn)
			})
			runTest()
		})
	})

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
		if (!await beiluConfirm(`确定删除规则 "${rule.scriptName || '(无名)'}" 吗？`)) return
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
		// 0714 trim 扫尾：仅脚本名 trim（名称类）；findRegex/replaceString/trimStrings 首尾空白有正则语义，刻意不 trim
		scriptName: (form.querySelector('#edit-script-name')?.value || '').trim(),
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

	// #ReDoS-FE：编辑器实时预览每键重跑（input 事件），用户正在键入的中间态可能是灾难性回溯正则。
	//   跑前过同源静态护栏 + 长度上限，命中即跳过预览（返回原文），避免每键冻结主线程。
	const _safety = assessRegexComplexity(regex.source)
	if (!_safety.ok) {
		wbDetect('regexEditor', 'localTestRule.unsafeRegex', false, _safety.reason, { findRegex: rule.findRegex })
		return input
	}
	if (input.length > REGEX_MAX_INPUT_LENGTH) return input

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

	// 清掉上次的错误状态
	hint.classList.remove('text-error', 'text-success')

	const match = findRegex?.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	// R-UP-3: 实时语法校验 — try/catch 构造 RegExp,无效立即显示错误
	//   支持两种写法:带斜杠 /pat/flags 或裸模式 pat(默认 g，对齐 displayRegex.mjs 运行时与 localTestRule)
	let pattern, flags
	if (match) {
		pattern = match[1]
		flags = match[2]
	} else if (findRegex) {
		pattern = findRegex
		flags = 'g' // 裸模式默认 flags(对齐运行时 displayRegex.mjs:441 与 localTestRule:893)
	} else {
		hint.textContent = '全局匹配, 区分大小写'
		return
	}

	// 实际尝试构造
	try {
		new RegExp(pattern, flags)
	} catch (e) {
		hint.textContent = `❌ 正则语法错误: ${e.message}`
		hint.classList.add('text-error')
		return
	}

	const parts = []
	parts.push(flags.includes('g') ? '全局匹配' : '匹配第一个')
	parts.push(flags.includes('i') ? '不区分大小写' : '区分大小写')
	if (flags.includes('s')) parts.push('dotAll')
	if (flags.includes('m')) parts.push('多行')
	if (flags.includes('u')) parts.push('Unicode')
	if (flags.includes('y')) parts.push('sticky')
	hint.textContent = '✓ ' + parts.join(', ')
	hint.classList.add('text-success')
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

	const items = [
		{ label: '<i data-ic="clipboard"></i> 复制', action: 'duplicate' },
		{ label: '<i data-ic="upload"></i> 导出', action: 'export' },
		{ label: '—', action: 'divider' },
	]

	// 移动作用域
	if (rule.scope !== 'global') items.push({ label: '↑ 移为全局', action: 'move-global' })
	if (rule.scope !== 'scoped') items.push({ label: '↓ 移为角色', action: 'move-scoped' })
	if (rule.scope !== 'preset') items.push({ label: '→ 移为预设', action: 'move-preset' })

	items.push({ label: '—', action: 'divider' })
	items.push({ label: '<i data-ic="trash"></i> 删除', action: 'delete', danger: true })

	for (const item of items) {
		if (item.action === 'divider') {
			menu.innerHTML += '<div class="divider my-0.5 mx-2"></div>'
			continue
		}
		const btn = document.createElement('button')
		btn.className = `block w-full text-left px-3 py-1 hover:bg-base-300/50 ${item.danger ? 'text-error' : ''}`
		// 右键菜单 label 含 data-ic 图标标签，全部为内部常量串无用户数据（无 XSS），
		//   用 innerHTML 让图标渲染（原 textContent 会把 <i> 当字面文本；箭头↑↓→标签不受影响）。
		btn.innerHTML = item.label
		btn.addEventListener('click', async () => {
			menu.remove()
			try {
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
						if (await beiluConfirm(`确定删除规则 "${rule.scriptName}" 吗？`)) {
							await setRegexData({ _action: 'removeRule', ruleId })
							await loadData()
							if (selectedRuleId === ruleId) { selectedRuleId = null; showEmptyState() }
						}
						break
				}
			} catch (err) {
				_reportError('右键菜单操作失败', err)
			}
		})
		menu.appendChild(btn)
	}

	document.body.appendChild(menu)
	positionContextMenu(menu, event.clientX, event.clientY)
	bindClickOutsideClose(menu, () => menu.remove())
}

// ============================================================
// 全局事件绑定
// ============================================================

function bindEvents() {
	if (!container) return

	// 全局开关
	container.querySelector('#regex-global-toggle')?.addEventListener('change', async (e) => {
		const prevEnabled = globalEnabled
		const newEnabled = e.target.checked
		globalEnabled = newEnabled
		try {
			await setRegexData({ _action: 'toggleAll', enabled: newEnabled })
		} catch (err) {
			// Drift 修复:乐观更新后端失败回滚内存态+复选框,否则全局开关与后端脱节
			globalEnabled = prevEnabled
			e.target.checked = prevEnabled
			_reportError('切换全局开关失败', err)
		}
	})

	// 渲染模式切换
	container.querySelectorAll('.render-mode-btn').forEach(btn => {
		btn.addEventListener('click', async () => {
			const mode = btn.dataset.mode
			if (mode === renderMode) return
			// Drift 修复:成功落盘后才提交 renderMode。原先 await 前就改,
			// 失败时既不回滚也不更新按钮样式 → renderMode 卡在失败值,
			// 上面 if(mode===renderMode) 守卫导致再也切不回去(内存与后端/DOM 三方脱节)。
			try {
				await setRegexData({ _action: 'setRenderMode', renderMode: mode })
				renderMode = mode
				// 更新按钮样式
				container.querySelectorAll('.render-mode-btn').forEach(b => {
					const isActive = b.dataset.mode === mode
					b.style.background = isActive ? 'var(--beilu-amber)' : ''
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

	// 护栏面板展开/收起
	container.querySelector('#regex-guard-toggle-panel')?.addEventListener('click', () => {
		const panel = container.querySelector('#regex-guard-panel')
		if (panel) panel.classList.toggle('hidden')
	})

	// 护栏保存
	container.querySelector('#guard-save-btn')?.addEventListener('click', async () => {
		const btn = container.querySelector('#guard-save-btn')
		const patch = _collectGuardForm()
		btn.disabled = true
		try {
			const result = await setRegexData({ _action: 'setGuardConfig', regexGuard: patch })
			guardConfig = result?._result || { ...guardConfig, ...patch }
			_syncGuardUI()
			showToast('护栏配置已保存', 'success')
		} catch (err) {
			showToast('护栏配置保存失败: ' + err.message, 'error')
		} finally {
			btn.disabled = false
		}
	})

	// 护栏重置默认
	container.querySelector('#guard-reset-btn')?.addEventListener('click', async () => {
		// T072BC：重置阈值取后端下发的安全默认单源（guardDefaults），非前端写死副本——后端收紧默认时前端「重置」随之同步。
		const defaults = { ...guardDefaults }
		const btn = container.querySelector('#guard-reset-btn')
		btn.disabled = true
		try {
			const result = await setRegexData({ _action: 'setGuardConfig', regexGuard: defaults })
			guardConfig = result?._result || defaults
			_syncGuardUI()
			showToast('护栏配置已重置为安全默认', 'success')
		} catch (err) {
			showToast('重置失败: ' + err.message, 'error')
		} finally {
			btn.disabled = false
		}
	})

	// 输出标签管控面板展开/收起
	container.querySelector('#regex-striptags-toggle-panel')?.addEventListener('click', () => {
		const panel = container.querySelector('#regex-striptags-panel')
		if (panel) panel.classList.toggle('hidden')
	})

	// 输出标签管控保存
	container.querySelector('#striptags-save-btn')?.addEventListener('click', async () => {
		const btn = container.querySelector('#striptags-save-btn')
		btn.disabled = true
		try {
			const splitLines = (v) => (v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
			const tags = splitLines(container.querySelector('#striptags-tags')?.value)
			const patterns = splitLines(container.querySelector('#striptags-patterns')?.value)
			const data = await _postStripTags({ _action: 'setStripTagsCustom', tags, patterns })
			if (data && data.success === false) throw new Error(data.error || '保存失败')
			_showStripTagsStatus('✅ 已保存', 'success')
		} catch (e) {
			_showStripTagsStatus('❌ ' + e.message, 'error')
		} finally {
			btn.disabled = false
		}
	})
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

/**
 * 导入前让用户选择目标作用域（全局/角色/预设）。
 * 复用 addRule 的 scope 三分逻辑，不 hardcode 任何默认 scope。
 * @returns {Promise<{scope:string, boundCharName:string, boundPresetName:string}|null>} 选中→scope 信息；取消→null
 */
function pickImportScope() {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog')
		dlg.className = 'modal'
		dlg.innerHTML = `<div class="modal-box max-w-xs">
			<h3 class="font-bold text-sm mb-3">导入到哪个作用域？</h3>
			<div class="flex flex-col gap-2">
				<button data-scope="global" class="btn btn-sm btn-outline" style="border-color:var(--beilu-amber);color:var(--beilu-amber)">全局</button>
				<button data-scope="scoped" class="btn btn-sm btn-outline border-blue-600 text-blue-600 hover:bg-blue-600 hover:text-white">角色（${escapeHtml(getCurrentCharName()) || '当前角色'}）</button>
				<button data-scope="preset" class="btn btn-sm btn-outline border-green-600 text-green-600 hover:bg-green-600 hover:text-white">预设（${escapeHtml(getCurrentPresetName()) || '当前预设'}）</button>
			</div>
			<div class="modal-action"><button class="btn btn-sm btn-ghost" data-role="cancel">取消</button></div>
		</div>`
		document.body.appendChild(dlg)

		let done = false
		const finish = (val) => {
			if (done) return
			done = true
			try { dlg.close() } catch { /* already closed */ }
			dlg.remove()
			resolve(val)
		}

		dlg.querySelectorAll('[data-scope]').forEach(btn => {
			btn.addEventListener('click', () => {
				const scope = btn.dataset.scope
				const boundCharName = scope === 'scoped' ? getCurrentCharName() : ''
				const boundPresetName = scope === 'preset' ? getCurrentPresetName() : ''
				finish({ scope, boundCharName, boundPresetName })
			})
		})
		dlg.querySelector('[data-role="cancel"]')?.addEventListener('click', () => finish(null))
		dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null) })
		dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null) })

		dlg.showModal()
	})
}

async function handleImport(e) {
	const file = e.target.files?.[0]
	if (!file) return
	try {
		const text = await file.text()
		let json
		try {
			json = JSON.parse(text)
		} catch (parseErr) {
			wbDetect("regex", "import:parse", false, parseErr?.message)
			showToast('导入失败: JSON 格式无效 — ' + parseErr.message, 'error')
			e.target.value = ''
			return
		}

		// 让用户选择导入目标 scope（与 addRule 三分逻辑一致，不 hardcode global）
		const target = await pickImportScope()
		if (!target) {
			e.target.value = ''
			return // 用户取消
		}

		// 判断是单条还是数组
		const scripts = Array.isArray(json) ? json : [json]
		const result = await setRegexData({
			_action: 'importST',
			scripts,
			scope: target.scope,
			boundCharName: target.boundCharName,
			boundPresetName: target.boundPresetName,
		})
		await loadData()
		refreshDisplayRules().catch(() => {})
		const scopeLabel = { global: '全局', scoped: '角色', preset: '预设' }[target.scope] || target.scope
		showToast(`已导入 ${result?._result?.count || scripts.length} 条正则规则（${scopeLabel}）`, 'success')
		recordImportHistory('正则', file.name) // T033：上报集中导入历史
	} catch (err) {
		wbDetect("regex", "import", false, err?.message)
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
// ReDoS 护栏配置 UI 同步
// ============================================================

/** 从内存 guardConfig 回填表单控件 */
function _syncGuardUI() {
	if (!container || !guardConfig) return
	const el = (id) => container.querySelector('#' + id)
	const en = el('guard-enabled')
	if (en) en.checked = guardConfig.enabled !== false
	// T072BC：字段缺省时的 fallback 取后端下发的安全默认单源（guardDefaults），非前端写死阈值副本。
	const mil = el('guard-maxInputLength')
	if (mil) mil.value = guardConfig.maxInputLength ?? guardDefaults.maxInputLength
	const mq = el('guard-maxQuantifiers')
	if (mq) mq.value = guardConfig.maxQuantifiers ?? guardDefaults.maxQuantifiers
	const mnd = el('guard-maxNestedQuantifierDepth')
	if (mnd) mnd.value = guardConfig.maxNestedQuantifierDepth ?? guardDefaults.maxNestedQuantifierDepth
}

/** 从表单控件收集当前值 */
function _collectGuardForm() {
	if (!container) return {}
	const el = (id) => container.querySelector('#' + id)
	const patch = {}
	const en = el('guard-enabled')
	if (en) patch.enabled = en.checked
	const mil = el('guard-maxInputLength')
	if (mil) { const v = Number(mil.value); if (Number.isFinite(v) && v > 0) patch.maxInputLength = v }
	const mq = el('guard-maxQuantifiers')
	if (mq) { const v = Number(mq.value); if (Number.isFinite(v) && v > 0) patch.maxQuantifiers = v }
	const mnd = el('guard-maxNestedQuantifierDepth')
	if (mnd) { const v = Number(mnd.value); if (Number.isFinite(v) && v >= 0) patch.maxNestedQuantifierDepth = v }
	return patch
}

// ============================================================
// 数据加载
// ============================================================

// [0716 W2 刷新机制] 正则规则变更广播订阅：producer=后端 regex saveConfigToDisk 单点
//   （regex_rules_changed，覆盖跨窗口增删改/导入/启动迁移清理）→ ws 桥 beilu:regexRulesChanged。
//   消费：①显示层规则缓存必刷（refreshDisplayRules 全局生效，与编辑器开关无关）
//        ②编辑器开着时重载列表。本窗自己保存的回显=幂等无害（loadData 重拉同值）。
window.addEventListener("beilu:regexRulesChanged", () => {
	refreshDisplayRules().catch(() => {})
	if (container && container.offsetParent !== null) loadData().catch(() => {})
})

async function loadData() {
	try {
		const data = await getRegexData()
		allRules = data.rules || []
		globalEnabled = data.enabled !== false
		renderMode = data.renderMode || 'sandbox'
		guardConfig = data.regexGuard || null
		// T072BC：后端下发护栏安全默认（regexGuardDefaults）→ 供重置/回填单源用；未下发保静态兜底。
		if (data.regexGuardDefaults && typeof data.regexGuardDefaults === 'object') {
			guardDefaults = { ...GUARD_DEFAULTS_FALLBACK, ...data.regexGuardDefaults }
		}

		const toggle = container?.querySelector('#regex-global-toggle')
		if (toggle) toggle.checked = globalEnabled

		// 更新渲染模式按钮状态
		container?.querySelectorAll('.render-mode-btn').forEach(b => {
			const isActive = b.dataset.mode === renderMode
			b.style.background = isActive ? 'var(--beilu-amber)' : ''
			b.classList.toggle('text-white', isActive)
			b.classList.toggle('btn-ghost', !isActive)
			b.classList.toggle('text-base-content/60', !isActive)
		})

		// 回填护栏配置控件
		_syncGuardUI()

		// 加载输出标签管控数据
		_loadStripTagsData()

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

function escapeAttr(str) {
	return escapeHtml(str)
}

// 0716 轮子收口：下载基元 → utils.downloadBlob 单源（本地签名保留，调用点零改）
function downloadJson(data, filename) {
	downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename)
}

function _reportError(label, err) {
	console.error(`[regex-editor] ${label}:`, err)
	showToast(`${label}: ${err.message}`, 'error')
}

// [D1 收口 0713] 纯桥壳：window._beiluToast（index.mjs main 启动挂载，先于任何用户交互）→
//   scripts/toast.mjs 单源。原本地手绘 DOM 降级分支运行期不可达=死代码+第二套 toast UI，纯删除。
function showToast(message, type = 'info') {
	window._beiluToast?.(message, type)
}

// ============================================================
// 输出标签管控（从 settingsSlots.mjs 迁入）
// ============================================================

function _postStripTags({ _action, ...payload }) {
	return sendAction({ verb: _action, target: 'plugins:beilu-memory', source: 'web', payload })
}

function _showStripTagsStatus(msg, type = 'info') {
	const st = container?.querySelector('#striptags-status')
	if (!st) return
	st.textContent = msg
	st.className = `text-xs text-center mt-1 ${type === 'success' ? 'text-success' : type === 'error' ? 'text-error' : 'text-warning'}`
	st.classList.remove('hidden')
	if (type === 'success') setTimeout(() => st.classList.add('hidden'), 2000)
}

async function _loadStripTagsData() {
	try {
		const data = await _postStripTags({ _action: 'getStripTagsCustom' })
		if (data && data.success) {
			const tagsEl = container?.querySelector('#striptags-tags')
			const patternsEl = container?.querySelector('#striptags-patterns')
			if (tagsEl) tagsEl.value = (Array.isArray(data.tags) ? data.tags : []).join('\n')
			if (patternsEl) patternsEl.value = (Array.isArray(data.patterns) ? data.patterns : []).join('\n')
		}
	} catch {}
}
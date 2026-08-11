/**
 * scriptManager.mjs — 角色卡脚本管理器 UI
 *
 * 助手选项卡第三个子tab，展示角色卡的 tavern_helper.scripts 列表。
 * 功能：查看/编辑脚本内容、按钮/数据展示、启用状态和运行状态、触发脚本按钮。
 *
 * 数据来源：
 *   - 全量脚本数据：fetch('/api/parts/shells:chat/char-data/{charId}')
 *     → charData.extensions.tavern_helper.scripts（顶层=权威层，落盘/编辑均写顶层；
 *       data.extensions 仅兼容未解包 V3 原卡，见 _loadScripts 内注释）
 *     [0806] 读取/展开收口 scriptTree.mjs：ScriptTree 文件夹节点原位展开、legacy 键
 *       TavernHelper_scripts 兜底、生效语义=folder.enabled && script.enabled；
 *       持久化存树（_scriptTrees）而非扁平视图（_allScripts），防文件夹结构被夷平
 *   - 运行状态：getRunningScripts() → [{id, name, enabled, buttons}]
 *
 * 编辑保存：
 *   - PUT /api/parts/shells:chat/update-char/{charId}
 *     body: { extensions: { tavern_helper: { scripts: [...] } } }
 *
 * 依赖：scriptRunner.mjs（getRunningScripts / triggerScriptButton）
 */

import { createDiag } from '../shared/state/diagLogger.mjs'
import { getRunningScripts, triggerScriptButton, unloadSingleScript } from './scriptRunner.mjs'
import { escapeHtml as _esc } from '../shared/state/utils.mjs'
import { apiFetch } from '../shared/transport/api-client.mjs' // R1: raw fetch → apiFetch（timeout+401；raw 保留 ok/j.success 判断）
import { sendAction } from '../shared/transport/sendAction.mjs' // T8·切桥：readUserFile/writeUserFile 直连收口走门面（凛倾 07-03"ST 只是插件"拍板解除 stCompat 零内改限制）
import { showToast } from '../../../../../scripts/toast.mjs'
import { beiluConfirm, beiluPrompt } from '../shared/widgets/beiluDialog.mjs';
import { readTavernScriptTrees, flattenScriptTrees, isEffectivelyEnabled, removeScriptFromTrees } from './scriptTree.mjs' // [0806] ScriptTree 规范化单源
import { wbTrace, wbDetect } from '../shared/widgets/whitebox.mjs' // [0806 可观测] 酒馆兼容链埋点，line="stcompat"，前端查看器可筛

const diag = createDiag('stCompat')

/** @type {HTMLElement|null} */
let _container = null
/** @type {Array<object>} ScriptTree 原始树（当前 scope 的持久化权威形态——保存必须存树，防文件夹结构被夷平） */
let _scriptTrees = []
/** @type {Map<string, {folderId: string, folderName: string, folderEnabled: boolean}>} 脚本id→所属文件夹信息 */
let _folderMeta = new Map()
/** @type {Array<object>} 扁平脚本视图（树内原对象引用，folder 内脚本原位展开；改字段天然回写树） */
let _allScripts = []

/** [0806] 树→扁平视图刷新（folder 展开 + legacy 兼容统一在 scriptTree.mjs） */
function _refreshFlatView() {
	const f = flattenScriptTrees(_scriptTrees)
	_allScripts = f.scripts
	_folderMeta = f.meta
}
/** @type {string|null} 当前角色卡 ID（含加载失败态——只表示"面板正对着哪张卡"） */
let _charId = null
/** @type {string|null} [0806] **成功加载过**脚本数据的角色卡 ID。与 _charId 分离：
 *  失败时 _charId 有值而本值为 null，自动轮询据此继续重试（原共用一个变量=失败即永久锁死）。 */
let _loadedCharId = null
/** @type {string} [0806] 最近一次加载的结果态，驱动空态文案区分"真没有脚本"与"加载失败" */
let _loadState = 'idle' // 'idle' | 'ok' | 'error'
/** @type {Set<string>} 已展开的脚本 ID */
const _expandedIds = new Set()
/** @type {Set<string>} 正在编辑中的脚本 ID */
const _editingIds = new Set()
/** @type {Map<string, string>} 编辑中的脚本内容暂存（scriptId → content） */
const _editBuffers = new Map()

/**
 * R-UP-2 / R-UP-7: 当前作用域 — 'character'(角色卡) / 'global'(全局) / 'preset'(预设)
 *   character: 来源 charData.extensions.tavern_helper.scripts
 *   global:    来源 data/users/{username}/global_scripts.json (via readUserFile)
 *   preset:    来源 激活预设文件 preset_json.extensions.tavern_helper.scripts
 *     [0807 §七#6 per-preset 化，对齐酒馆助手 PresetSettings.scripts] 读=beilu-preset GetData
 *     preset_json（桥自动注入 chatid → 后端解析本窗口线激活预设，与生成读键同源）；
 *     写=SetData update_tavern_helper（_target_preset=owner 指名，防切换竞态写进别的预设）。
 *     旧单份 preset_scripts.json 降为迁移期读兜底（预设无 tavern_helper.scripts 字段时显示
 *     旧文件内容，首次保存即升级进预设文件），不再写入。
 */
let _scope = 'character'
// 全局/预设脚本读写都走 beilu-memory 的 setdata 端点（用 _action: readUserFile/writeUserFile 区分），
// 该端点是通用调度入口，并非只写 config——故读取脚本也复用它而非另开 getdata。

/** R-UP-7: 各 scope 对应的用户文件名(character 走角色卡 API,无文件) */
const SCOPE_FILE = { global: 'global_scripts.json', preset: 'preset_scripts.json' }

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
	// [0807 §七#6] 预设切换联动：preset scope 视图跟随激活预设刷新
	//   （本窗 switchPreset → beilu:presetSwitched；别窗/WS 广播 → beilu:preset-changed）
	if (!window.__beiluScriptMgrPresetBound) {
		window.__beiluScriptMgrPresetBound = true
		const _onPresetChange = () => { if (_scope === 'preset') _loadPresetScopeTrees() }
		window.addEventListener('beilu:presetSwitched', _onPresetChange)
		window.addEventListener('beilu:preset-changed', _onPresetChange)
	}
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
		// [0806 根修] 判据用 _loadedCharId（**加载成功**的卡）而非 _charId（"当前显示的卡"，失败态也有值）。
		//   原来两者共用 _charId：首次加载失败 → catch 里也把 _charId 设成 charId → 这里
		//   `charId !== _charId` 恒假 + 下方轮询 `|| _charId` 立刻 clearInterval →
		//   **一次失败即永久锁死在"0 个脚本"**，只有手动点刷新能救（0806 用户实报现场：
		//   后端刚重启时打开页面，首帧请求失败，之后再也不重试）。
		if (charId && charId !== _loadedCharId) {
			await _loadScripts(charId)
		}
	}

	// 首次延迟 3 秒（等角色卡加载）
	setTimeout(tryLoad, 3000)

	// 之后每 5 秒检查一次角色卡变化（最多 6 次 = 30 秒）
	// 停止条件=**已成功加载**（_loadedCharId），失败态继续重试到次数用尽（容错自愈，不静默躺平）
	let attempts = 0
	const timer = setInterval(async () => {
		attempts++
		if (attempts >= 6 || _loadedCharId) {
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
		// P1-2（一致性审计②双通道）：apiFetch 直连 → 既有 verb getCharData（sendAction.mjs:600），
		//   门面返回解析体且 !ok 统一抛错，与原 raw+手检等价；消灭同端点双通道
		const charData = await sendAction({ verb: "getCharData", target: "shells:chat", source: "web", payload: { charId } })

		// [补丁扫描修复二批 2026-07-13] 顶层优先（顶层=权威层，data.extensions 仅兼容未解包 V3 原卡）。
		// [0806] 读取收口 scriptTree.readTavernScriptTrees：两层 + legacy 键 TavernHelper_scripts 兜底；
		//   flatten 把 folder 内脚本原位展开进视图（原实现 folder 节点被当脚本渲染/丢弃）。
		_scriptTrees = readTavernScriptTrees(charData)
		_refreshFlatView()
		_charId = charId
		_loadedCharId = charId // 成功才认领：轮询据此停止
		_loadState = 'ok'
		// [0806 可观测] 把"卡里到底有没有脚本、读到几条、几条真生效"变成前端查看器可见事实，
		//   替代用户只能看到一个"0 个"的黑盒。folders=文件夹节点数（旧实现会整个丢掉它们）。
		wbTrace('stcompat', 'scripts:loaded', {
			charId,
			trees: _scriptTrees.length,
			flat: _allScripts.length,
			effective: _allScripts.filter(s => isEffectivelyEnabled(s, _folderMeta)).length,
			folders: _scriptTrees.filter(n => n && n.type === 'folder').length,
			legacyKey: !!(charData?.extensions?.TavernHelper_scripts || charData?.data?.extensions?.TavernHelper_scripts),
		})
		// 卡里明明有 tavern_helper 容器却解析出 0 条 → 判为异常（红项），不再静默显示"没有脚本"
		wbDetect('stcompat', 'scripts:nonempty', !(_hasTavernContainer(charData) && _allScripts.length === 0),
			'角色卡带 tavern_helper 容器但解析出 0 条脚本（格式不识别？）', { charId })
		_render()
	} catch (err) {
		diag.warn('[scriptManager] 加载脚本数据失败:', err.message)
		_scriptTrees = []
		_refreshFlatView()
		_charId = charId
		// [0806 根修] 失败**不认领** _loadedCharId：让自动轮询继续重试（原来这里设 _charId
		//   等于告诉轮询"已处理完这张卡"，一次网络抖动=永久 0 个脚本）。
		_loadState = 'error'
		wbDetect('stcompat', 'scripts:load', false, `脚本数据加载失败: ${err?.message || err}`, { charId })
		_render()
	}
}

/** [0806 可观测] 角色卡是否带 tavern_helper 容器（四路键任一命中）——用于区分"卡没脚本"与"我们没解析出来" */
function _hasTavernContainer(charData) {
	const e1 = charData?.extensions, e2 = charData?.data?.extensions
	return !!(e1?.tavern_helper || e2?.tavern_helper || e1?.TavernHelper_scripts || e2?.TavernHelper_scripts)
}

// [0807 §七#6 preset 半"导出即丢"] 预设脚本 per-preset 真源函数组。
//   契约表§1.1 🔴"预设导出不带脚本"：酒馆把预设脚本存进预设文件 extensions.tavern_helper.scripts
//   （导出随预设走，OAI_PRESET_EXPORT_READY 只按 export_with 清 data/button），beilu 此前存独立
//   preset_scripts.json 用户文件=导出即丢。现真源=预设文件（后端 update_tavern_helper 写口）。
let _presetScriptsOwner = '' // 当前树归属的预设名（保存指名 _target_preset，防切换竞态写进别的预设）

async function _loadPresetScopeTrees() {
	try {
		// getData 桥自动注入 chatid/charName → 后端下发本窗口线激活预设 preset_json + active_preset_resolved
		const data = await sendAction({ verb: 'getData', target: 'plugins:beilu-preset', source: 'web' })
		// owner 判定=sharedState.resolveCurrentPresetName 同口径：resolved 字段存在（含空串）即权威
		_presetScriptsOwner = (typeof data?.active_preset_resolved === 'string')
			? data.active_preset_resolved
			: (data?.preset_name || '')
		const th = data?.preset_json?.extensions?.tavern_helper
		if (th && Object.prototype.hasOwnProperty.call(th, 'scripts')) {
			_scriptTrees = Array.isArray(th.scripts) ? th.scripts : []
		} else {
			_scriptTrees = await _readLegacyPresetTrees() // 字段缺席=预设从未写过 → 旧文件迁移读兜底
		}
	} catch (err) {
		diag.warn(`[scriptManager] 加载预设内脚本失败: ${err.message}`)
		_presetScriptsOwner = ''
		_scriptTrees = []
	}
	_refreshFlatView()
	_render()
}

/** 旧单份 preset_scripts.json 读兜底（仅预设无 tavern_helper.scripts 字段时消费，不再写入） */
async function _readLegacyPresetTrees() {
	try {
		const j = await sendAction({ verb: 'readUserFile', target: 'plugins:beilu-memory', source: 'web', payload: { filename: 'preset_scripts.json' } })
		if (!j.success || !j.content) return []
		const data = JSON.parse(j.content)
		return Array.isArray(data.scripts) ? data.scripts : []
	} catch { return [] }
}

/**
 * R-UP-2 / R-UP-7: 加载用户文件作用域脚本(global；preset 已 per-preset 化走 _loadPresetScopeTrees)
 * 读 data/users/{username}/{filename} via beilu-memory readUserFile action
 * @param {'global'|'preset'} scope
 */
async function _loadFileScripts(scope) {
	if (scope === 'preset') return _loadPresetScopeTrees() // [0807 §七#6] preset 真源=激活预设文件
	const filename = SCOPE_FILE[scope]
	if (!filename) { _scriptTrees = []; _refreshFlatView(); _render(); return }
	try {
		// T8·切桥：raw 直连→sendAction（memory 通配桥，unwrap 还原旧裸形状；HTTP 失败在门面内抛=等价原 !resp.ok throw）
		const j = await sendAction({ verb: 'readUserFile', target: 'plugins:beilu-memory', source: 'web', payload: { filename } })
		if (!j.success) {
			_scriptTrees = []
			_refreshFlatView()
			_render()
			return
		}
		// 空文件或不存在 → 空数组
		if (!j.content) {
			_scriptTrees = []
			_refreshFlatView()
			_render()
			return
		}
		let data
		try { data = JSON.parse(j.content) }
		catch (e) {
			diag.warn(`[scriptManager] ${filename} 解析失败:`, e.message)
			_scriptTrees = []
			_refreshFlatView()
			_render()
			return
		}
		_scriptTrees = Array.isArray(data.scripts) ? data.scripts : []
		_refreshFlatView()
		_render()
	} catch (err) {
		diag.warn(`[scriptManager] 加载 ${scope} 脚本失败:`, err.message)
		_scriptTrees = []
		_refreshFlatView()
		_render()
	}
}

/**
 * R-UP-2 / R-UP-7: 保存用户文件作用域脚本(global / preset)
 * @param {'global'|'preset'} scope
 */
async function _saveFileScripts(scope) {
	// [0807 §七#6] preset scope 存进激活预设文件（update_tavern_helper 写口，_target_preset 指名）
	if (scope === 'preset') {
		if (!_presetScriptsOwner) {
			diag.error('[scriptManager] 保存预设脚本失败: 当前窗口无激活预设')
			window._beiluToast?.('当前窗口无激活预设，预设脚本无处可存（请先激活一个预设）', 'warning')
			return false
		}
		try {
			const j = await sendAction({ verb: 'updatePresetConfig', target: 'plugins:beilu-preset', source: 'web', payload: { _target_preset: _presetScriptsOwner, update_tavern_helper: { scripts: _scriptTrees } } })
			if (!j?.success) throw new Error(j?.error || 'unknown')
			diag.log(`[scriptManager] 预设脚本已存进预设 "${_presetScriptsOwner}": ${_allScripts.length} 条`)
			return true
		} catch (e) {
			diag.error(`[scriptManager] 保存预设脚本失败: ${e.message}`)
			return false
		}
	}
	const filename = SCOPE_FILE[scope]
	if (!filename) return false
	try {
		// [0806] 保存树而非扁平视图：扁平条目是树内引用，存 _allScripts 会把文件夹结构夷平
		const content = JSON.stringify({ scripts: _scriptTrees }, null, 2)
		// T8·切桥：同 _loadFileScripts——raw 直连→sendAction 门面
		const j = await sendAction({ verb: 'writeUserFile', target: 'plugins:beilu-memory', source: 'web', payload: { filename, content } })
		if (!j.success) throw new Error(j.error || 'unknown')
		diag.log(`[scriptManager] ${scope} 脚本已保存: ${_allScripts.length} 条`)
		return true
	} catch (e) {
		diag.error(`[scriptManager] 保存 ${scope} 脚本失败:`, e.message)
		return false
	}
}

/**
 * R-UP-2 / R-UP-7: 按 scope 切换并刷新
 * @param {'character'|'global'|'preset'} scope
 */
async function _switchScope(scope) {
	if (_scope === scope) return
	_scope = scope
	_scriptTrees = []
	_refreshFlatView()
	_expandedIds.clear()
	_editingIds.clear()
	_editBuffers.clear()
	_renderEmpty()
	if (scope === 'global' || scope === 'preset') {
		await _loadFileScripts(scope)
	} else if (_charId) {
		await _loadScripts(_charId)
	} else {
		// character 作用域但没角色卡 → 保持空态
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

	// 统计（[0806] 启用数=实际生效数：文件夹内脚本要求 folder.enabled && script.enabled，对齐 ST 语义）
	const total = _allScripts.length
	const enabledCount = _allScripts.filter(s => isEffectivelyEnabled(s, _folderMeta)).length
	const runningCount = runningScripts.length

	let html = ''

	// ── 工具栏 (R-UP-2 / R-UP-7: 加 scope 切换 + 新建按钮) ──
	const scopeLabel = _scope === 'global' ? '<i data-ic="earth"></i> 全局脚本'
		: _scope === 'preset' ? '<i data-ic="tune"></i> 预设脚本'
		: '<i data-ic="script"></i> 角色卡脚本'
	html += `
		<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid oklch(var(--b3));flex-shrink:0;flex-wrap:wrap;">
			<!-- scope 切换按钮: 三级作用域 角色卡/全局/预设 -->
			<div class="join" style="flex-shrink:0;">
				<button class="sm-scope-btn join-item btn btn-xs ${_scope === 'character' ? 'btn-active' : 'btn-ghost'}" data-scope="character" title="当前角色卡脚本"><i data-ic="script"></i> 角色卡</button>
				<button class="sm-scope-btn join-item btn btn-xs ${_scope === 'global' ? 'btn-active' : 'btn-ghost'}" data-scope="global" title="全局脚本(跨角色卡)"><i data-ic="earth"></i> 全局</button>
				<button class="sm-scope-btn join-item btn btn-xs ${_scope === 'preset' ? 'btn-active' : 'btn-ghost'}" data-scope="preset" title="预设脚本(随预设加载/卸载)"><i data-ic="tune"></i> 预设</button>
			</div>
			<span style="font-weight:500;font-size:0.75rem;">${scopeLabel}</span>
			<span style="font-size:0.7rem;opacity:0.5;">${total} 个 · ${enabledCount} 启用 · ${runningCount} 运行中</span>
			<div style="margin-left:auto;display:flex;gap:4px;">
				<button class="sm-new-btn btn btn-xs btn-primary" title="新建脚本"><i data-ic="plus"></i> 新建</button>
				<button class="sm-refresh-btn btn btn-xs btn-ghost btn-square" title="刷新"><i data-ic="refresh"></i></button>
			</div>
		</div>
	`

	// ── 空状态 ──
	if (total === 0) {
		// [0806] 区分三态：加载失败 ≠ 真的没有脚本 ≠ 还没加载角色卡。
		//   原来失败也显示"当前角色卡没有 tavern_helper 脚本"=把故障报成事实，用户无从判断该刷新还是该导入。
		const emptyMsg = _scope === 'global' ? '暂无全局脚本，点「新建」添加'
			: _scope === 'preset' ? '暂无预设脚本，点「新建」添加'
			: _loadState === 'error' ? '脚本数据加载失败（角色卡数据读取出错），正在自动重试；可点右上角刷新立即重试'
			: (_charId ? '当前角色卡没有 tavern_helper 脚本' : '未加载角色卡')
		html += `
			<div style="padding:32px;text-align:center;opacity:0.35;font-size:0.8rem;">
				${emptyMsg}
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
		// [0806] 所属文件夹标识：folder 内脚本挂 📁 徽标；文件夹被禁用时标注（此时脚本开关开着也不生效）
		const _fm = _folderMeta.get(script.id)
		const folderBadge = _fm
			? `<span class="badge badge-xs badge-ghost" style="font-size:0.6rem;flex-shrink:0;" title="来自脚本文件夹「${_esc(_fm.folderName)}」${_fm.folderEnabled ? '' : '（文件夹已禁用，内部脚本不会运行）'}">📁 ${_esc(_fm.folderName)}${_fm.folderEnabled ? '' : ' ⛔'}</span>`
			: ''

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
					<span style="font-size:0.8rem;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${isEffectivelyEnabled(script, _folderMeta) ? '' : 'opacity:0.4;text-decoration:line-through;'}">
						${_esc(script.name || '(无名脚本)')}
					</span>
					${folderBadge}
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

	// ── R-UP-6: 来源(内嵌代码 / 外部URL) ──
	const isEditingRow = _editingIds.has(script.id)
	const source = script.source || 'inline'
	if (isEditingRow) {
		// 编辑态:可切换来源 + URL 输入 + 自动更新
		html += `
			<div style="margin-bottom:8px;">
				<div style="font-weight:600;margin-bottom:3px;"><i data-ic="link"></i> 来源</div>
				<div class="join" style="margin-bottom:6px;">
					<button class="sm-source-btn join-item btn btn-xs ${source === 'inline' ? 'btn-active' : 'btn-ghost'}" data-script-id="${_esc(script.id)}" data-source="inline">内嵌代码</button>
					<button class="sm-source-btn join-item btn btn-xs ${source === 'url' ? 'btn-active' : 'btn-ghost'}" data-script-id="${_esc(script.id)}" data-source="url">外部URL</button>
				</div>
				<div class="sm-url-fields" data-script-id="${_esc(script.id)}" style="${source === 'url' ? '' : 'display:none;'}">
					<input type="text" class="sm-url-input" data-script-id="${_esc(script.id)}"
						placeholder="https://raw.githubusercontent.com/.../main.js"
						value="${_esc(script.url || '')}"
						style="width:100%;background:oklch(var(--b2));padding:5px 8px;border-radius:4px;border:1px solid oklch(var(--b3));font-size:0.65rem;color:inherit;outline:none;margin-bottom:4px;" spellcheck="false" />
					<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.7rem;">
						<input type="checkbox" class="sm-autoupdate-toggle toggle toggle-xs" data-script-id="${_esc(script.id)}" ${script.autoUpdate ? 'checked' : ''} />
						<span>自动更新(每次加载拉取最新)</span>
					</label>
				</div>
			</div>
		`
	} else if (source === 'url') {
		// 只读态:显示 URL 来源
		html += `
			<div style="margin-bottom:8px;font-size:0.7rem;">
				<span style="font-weight:600;"><i data-ic="link"></i> 来源:</span> 外部URL${script.autoUpdate ? ' · 自动更新' : ''}
				<div style="opacity:0.6;word-break:break-all;font-family:ui-monospace,monospace;font-size:0.62rem;margin-top:2px;">${_esc(script.url || '(未设置)')}</div>
			</div>
		`
	}

	// ── 脚本内容(仅 source=inline 显示代码编辑区) ──
	// R-UP-6: source=url 时不展示内嵌代码区(代码运行时从 URL 拉取),避免与 URL 混淆
	if (source !== 'url' && (script.content !== undefined || isEditingRow)) {
		const isEditing = _editingIds.has(script.id)
		const rawContent = script.content ?? ''
		const content = isEditing
			? (_editBuffers.get(script.id) ?? rawContent)
			: rawContent

		html += `
			<div style="margin-bottom:8px;">
				<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
					<span style="font-weight:600;"><i data-ic="edit"></i> 脚本内容</span>
					<span style="font-size:0.6rem;opacity:0.4;">(${rawContent.length} 字符)</span>
					<span style="margin-left:auto;display:flex;gap:4px;">
		`

		if (isEditing) {
			html += `
						<button class="sm-save-btn btn btn-xs btn-success" data-script-id="${_esc(script.id)}" title="保存修改"><i data-ic="save"></i> 保存</button>
						<button class="sm-cancel-btn btn btn-xs btn-ghost" data-script-id="${_esc(script.id)}" title="取消编辑">✖ 取消</button>
			`
		} else {
			html += `
						<button class="sm-edit-btn btn btn-xs btn-ghost" data-script-id="${_esc(script.id)}" title="编辑脚本内容">✏️ 编辑</button>
						<!-- R-UP-2: 删除按钮 -->
						<button class="sm-delete-btn btn btn-xs btn-ghost text-error" data-script-id="${_esc(script.id)}" title="删除脚本">🗑</button>
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
					<i data-ic="dot"></i> 脚本按钮
					${btnGroupEnabled ? '' : '<span style="opacity:0.4;font-weight:400;"> (按钮功能已禁用)</span>'}
				</div>
				<div style="display:flex;flex-wrap:wrap;gap:4px;">
		`
		for (const btn of buttons) {
			const canTrigger = !!runningInfo && btnGroupEnabled
			const visibleHint = btn.visible === false ? ' (隐藏)' : ''
			html += `
				<button class="sm-trigger-btn btn btn-xs ${canTrigger
					? 'btn-outline'
					: 'btn-disabled opacity-40'}" ${canTrigger ? 'style="border-color:var(--beilu-amber);color:var(--beilu-amber)"' : ''}
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
				<div style="font-weight:600;margin-bottom:3px;"><i data-ic="chart"></i> 脚本数据</div>
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
	// R-UP-2: scope 切换 + 新建按钮
	_container?.querySelectorAll('.sm-scope-btn').forEach(btn => {
		btn.addEventListener('click', () => _switchScope(btn.dataset.scope))
	})
	_container?.querySelector('.sm-new-btn')?.addEventListener('click', _handleNewScript)
}

/**
 * R-UP-2 / R-UP-6 / R-UP-7: 新建脚本
 *   character scope:追加到 allScripts + 调后端 update-char 保存
 *   global/preset scope:追加到 allScripts + writeUserFile 保存对应文件
 *   新脚本默认 source='inline'(内嵌代码),用户可在编辑区切到外部 URL
 */
async function _handleNewScript() {
	const name = await beiluPrompt('新脚本名称:')
	if (!name || !name.trim()) return
	const newScript = {
		id: 'script-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		name: name.trim(),
		type: 'script',
		enabled: false, // 默认不启用(避免意外执行)
		source: 'inline', // R-UP-6: 来源,inline=内嵌 / url=外部URL
		content: '',
		url: '',          // R-UP-6: source=url 时的脚本地址
		autoUpdate: false, // R-UP-6: URL 脚本是否每次加载拉取最新
		info: '',
		data: {},
		button: { enabled: true, buttons: [] },
		// [0806] 对齐酒馆助手 813bb6f 新增字段：导出角色卡时是否携带 data/button（ST 侧 zod 默认 true/true）
		export_with: { data: true, button: true },
	}
	// [0806] 新建落到树顶层（不进文件夹），扁平视图随树刷新
	_scriptTrees.push(newScript)
	_refreshFlatView()
	_expandedIds.add(newScript.id)
	_editingIds.add(newScript.id)
	_editBuffers.set(newScript.id, '')

	if (_scope === 'global' || _scope === 'preset') {
		const ok = await _saveFileScripts(_scope)
		if (!ok) { removeScriptFromTrees(_scriptTrees, newScript.id); _refreshFlatView(); showToast('error', '保存失败'); return }
	} else {
		const ok = await _saveCharacterScripts()
		if (!ok) { removeScriptFromTrees(_scriptTrees, newScript.id); _refreshFlatView(); showToast('error', '保存到角色卡失败'); return }
	}
	_render()
}

/**
 * R-UP-2 / R-UP-7: 删除脚本
 */
async function _handleDeleteScript(scriptId) {
	const script = _allScripts.find(s => s.id === scriptId)
	if (!script) return
	if (!await beiluConfirm(`删除脚本 "${script.name}"? 此操作不可撤销。`)) return
	// [0806] 从树里删（顶层或文件夹内），扁平视图随树刷新
	removeScriptFromTrees(_scriptTrees, scriptId)
	_refreshFlatView()
	_expandedIds.delete(scriptId)
	_editingIds.delete(scriptId)
	_editBuffers.delete(scriptId)

	if (_scope === 'global' || _scope === 'preset') {
		await _saveFileScripts(_scope)
	} else {
		await _saveCharacterScripts()
	}
	_render()
}

/**
 * R-UP-2: 保存角色卡脚本到后端（新建/删除入口用，返回布尔便于失败回滚）
 *   委托唯一正确机制 _saveScriptsToBackend：PUT update-char 带 JSON
 *   {extensions:{tavern_helper:{scripts}}}，由后端 update-char 深合并 extensions。
 *   旧实现用 multipart `data` 字段提交完整 charData，但后端只读 req.body.extensions/文本字段，
 *   从不读 `data` → changed 恒 false → 不写盘却返 success:true（新建/删除刷新后静默丢失）。
 */
async function _saveCharacterScripts() {
	if (!_charId) return false
	try {
		await _saveScriptsToBackend(_scriptTrees) // [0806] 存树防夷平文件夹
		diag.log(`[scriptManager] 角色卡脚本已保存: ${_allScripts.length} 条`)
		return true
	} catch (e) {
		diag.error('[scriptManager] 保存角色卡脚本失败:', e.message)
		return false
	}
}

/** 绑定所有事件 */
function _bindEvents() {
	if (!_container) return

	// 刷新按钮
	_container.querySelector('.sm-refresh-btn')?.addEventListener('click', _handleRefresh)
	// R-UP-2: scope 切换 + 新建按钮 + 删除按钮
	_container.querySelectorAll('.sm-scope-btn').forEach(btn => {
		btn.addEventListener('click', () => _switchScope(btn.dataset.scope))
	})
	_container.querySelector('.sm-new-btn')?.addEventListener('click', _handleNewScript)
	_container.querySelectorAll('.sm-delete-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			if (scriptId) _handleDeleteScript(scriptId)
		})
	})

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

	// R-UP-6: 来源切换按钮(内嵌/URL)
	_container.querySelectorAll('.sm-source-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			const newSource = btn.dataset.source
			if (!scriptId || !newSource) return
			const script = _allScripts.find(s => s.id === scriptId)
			if (script) {
				script.source = newSource
				// 切换来源仅改本地状态,等点「保存」才落盘
				_render()
			}
		})
	})

	// R-UP-6: 保存按钮 — 支持三级 scope + source/url/autoUpdate
	_container.querySelectorAll('.sm-save-btn').forEach(btn => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation()
			const scriptId = btn.dataset.scriptId
			if (!scriptId) return
			const script = _allScripts.find(s => s.id === scriptId)
			if (!script) return
			// character scope 无角色卡时无法保存
			if (_scope === 'character' && !_charId) { showToast('warning', '未加载角色卡，无法保存'); return }

			// 收集编辑区字段
			const textarea = _container.querySelector(`.sm-content-editor[data-script-id="${CSS.escape(scriptId)}"]`)
			const urlInput = _container.querySelector(`.sm-url-input[data-script-id="${CSS.escape(scriptId)}"]`)
			const autoToggle = _container.querySelector(`.sm-autoupdate-toggle[data-script-id="${CSS.escape(scriptId)}"]`)
			const newContent = textarea?.value ?? _editBuffers.get(scriptId) ?? script.content ?? ''
			const source = script.source || 'inline'

			btn.disabled = true
			btn.innerHTML = '<i data-ic="hourglass"></i> 保存中...'

			try {
				// 先把字段写回本地脚本对象
				script.source = source
				if (source === 'url') {
					script.url = urlInput?.value?.trim() ?? script.url ?? ''
					script.autoUpdate = !!autoToggle?.checked
					// url 来源不改 content(运行时从 URL 拉取)
				} else {
					script.content = newContent
				}
				// 按 scope 持久化整份列表(覆盖 source/url/autoUpdate/content)
				if (_scope === 'global' || _scope === 'preset') {
					const ok = await _saveFileScripts(_scope)
					if (!ok) throw new Error('writeUserFile 失败')
				} else {
					await _saveScriptsToBackend(_scriptTrees) // [0806] 存树防夷平文件夹
				}
				_editingIds.delete(scriptId)
				_editBuffers.delete(scriptId)
				_render()
			} catch (err) {
				btn.innerHTML = '<i data-ic="cross"></i> 失败'
				diag.error('[scriptManager] 保存脚本失败:', err.message)
				setTimeout(() => { btn.innerHTML = '<i data-ic="save"></i> 保存'; btn.disabled = false }, 2000)
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

	// R-UP-6: URL 输入框 / autoUpdate 阻止冒泡到 header
	_container.querySelectorAll('.sm-url-input, .sm-autoupdate-toggle').forEach(el => {
		el.addEventListener('click', (e) => e.stopPropagation())
	})

	// 启用/禁用切换开关 — R-UP-7: 支持三级 scope
	_container.querySelectorAll('.sm-script-toggle').forEach(toggle => {
		// 阻止点击冒泡到 header（避免触发展开/折叠）
		toggle.addEventListener('click', (e) => e.stopPropagation())
		toggle.closest('.sm-toggle-label')?.addEventListener('click', (e) => e.stopPropagation())

		toggle.addEventListener('change', async () => {
			const scriptId = toggle.dataset.scriptId
			if (!scriptId) return
			if (_scope === 'character' && !_charId) { toggle.checked = !toggle.checked; return }

			const newEnabled = toggle.checked
			const script = _allScripts.find(s => s.id === scriptId)
			const prevEnabled = script?.enabled
			const scriptName = script?.name || scriptId

			try {
				if (script) script.enabled = newEnabled
				if (_scope === 'global' || _scope === 'preset') {
					const ok = await _saveFileScripts(_scope)
					if (!ok) throw new Error('writeUserFile 失败')
				} else {
					await _saveScriptsToBackend(_scriptTrees) // [0806] 存树防夷平文件夹
				}

				if (newEnabled) {
					window.dispatchEvent(new CustomEvent('beilu:scripts-changed', {
						detail: { scope: _scope, charId: _charId },
					}))
					showToast('success', `已启用 ${scriptName}`)
				} else {
					unloadSingleScript(scriptId)
					showToast('info', `已禁用 ${scriptName}`)
				}
				_render()
			} catch (err) {
				if (script) script.enabled = prevEnabled
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
	// T2批1收口：raw PUT update-char → sendAction 门面（updateChar 注册体剥离 charId meta、其余进 body，与旧 body 逐字段等价）。
	//   sendAction 非 2xx 自动 throw（原 if(!resp.ok)throw 由门面接管删除；错误文案来源变为 apiFetch 取后端 _msg，语义近似）。
	await sendAction({
		verb: 'updateChar', target: 'shells:chat', source: 'web',
		payload: { charId: _charId, extensions: { tavern_helper: { scripts } } },
	})
}

/** 刷新按钮点击处理 — R-UP-7: 必须按当前 scope 刷新，否则 global/preset 下会被角色卡脚本覆盖(Drift) */
async function _handleRefresh() {
	if (_scope === 'global' || _scope === 'preset') {
		// 全局/预设作用域:重读对应用户文件,不能去拉角色卡脚本
		await _loadFileScripts(_scope)
		return
	}
	const charId = _getCharId()
	if (charId) {
		// [0806] 两个身份态一起清：_loadedCharId 不清则"手动刷新"对已成功加载的卡无效（点了没反应）
		_charId = null
		_loadedCharId = null
		await _loadScripts(charId)
	} else {
		_renderEmpty()
	}
}

// ============================================================
// 工具函数
// ============================================================

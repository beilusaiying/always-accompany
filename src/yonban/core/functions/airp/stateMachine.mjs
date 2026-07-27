/**
 * stateMachine.mjs — AIRP 数值状态机（确定性 JS，LLM 只写指令不管计算）。
 *
 * 设计哲学(002 原话)：数值必须留在确定性代码里，LLM 只负责叙事皮肤。
 *   LLM 在回复里写数值指令(<airp-patch>...)，本模块纯 JS 解析+计算+累积，结果存 chatLogEntry.extension.airp_state。
 *   给定同一序列指令，结果可复现——不经 LLM，无漂移(era 骨架可靠性)。
 *
 * 范式来源：照抄 beilu-mvu(prompt/mvu/main.mjs) 的 parseVariableCommands/applyJsonPatch/hideVariableCommands，
 *   收窄到数值状态机最小集：op 只留 set(赋值) / delta(增量，如 好感度+5) / remove。
 *
 * 语法 vs 数据(禁硬编码铁律)：
 *   - <airp-patch> 是【DSL 语法约定】(同 mvu 的 <JSONPatch> 是约定)，固定，属渲染协议一部分。
 *   - 【哪些数值域/初始值/阈值事件】是数据，走世界书 [InitVar] / 后端谱可配，本模块不写死任何具体数值域。
 *
 * 存储单源：状态住 extension.airp_state.stat_data(照 mvu extension.mvu_variables.stat_data)，无第二存放处。
 *   累积：accumulateAirpState 逐楼深合并(后楼覆盖前楼)，即使某楼只存 delta 也能合出完整态。
 *
 * 原型污染防护：路径段拒绝 __proto__/constructor/prototype(照 mvu convertJsonPointerToLodashPath)。
 */
import _ from 'npm:lodash-es'

// ============================================================
// §1 状态累积（照 mvu accumulateVariables）
// ============================================================

/**
 * 从 chatLog 逐楼累积出最新完整 airp 数值状态。
 * 后楼深合并覆盖前楼，即使某楼只存 delta 也能合出完整态。
 * @param {Array} chatLog - beilu chatLog 数组
 * @returns {object|null} { stat_data: {...} } 或 null
 */
export function accumulateAirpState(chatLog) {
	let accumulated = null
	if (!Array.isArray(chatLog)) return null
	for (let i = 0; i < chatLog.length; i++) {
		const st = chatLog[i]?.extension?.airp_state
		if (st && typeof st === 'object' && Object.keys(st).length > 0) {
			if (!accumulated) accumulated = _.cloneDeep(st)
			else _.merge(accumulated, st)
		}
	}
	return accumulated
}

// ============================================================
// §2 路径工具（照 mvu convertJsonPointerToLodashPath + 原型污染防护）
// ============================================================

/** 拒绝原型污染段。@returns {boolean} true=安全 */
function _pathSafe(segments) {
	return !segments.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')
}

/**
 * 归一路径为 lodash 路径数组。支持 dot 路径(好感度 / 秋浸月.好感度)。
 * 去 stat_data 前缀(doc 本身就是 stat_data，照 mvu normalizeJsonPointerForStatDataRoot)。
 * @param {string} path
 * @returns {string[]|null} 路径数组，或 null(不安全/非法)
 */
function _toLodashPath(path) {
	if (typeof path !== 'string' || path === '') return null
	let p = path.trim().replace(/^\/?stat_data[./]/, '').replace(/^\//, '').replace(/\//g, '.')
	const segs = _.toPath(p)
	if (!segs.length || !_pathSafe(segs)) return null
	return segs
}

// ============================================================
// §3 应用单条 patch（op: set/delta/remove）
// ============================================================

/**
 * 在 stat_data 上应用一条数值 patch（不 mutate 入参，返回新 doc）。
 * @param {object} statData
 * @param {{op:string, path:string, value?:any}} patch
 * @returns {object} 新 stat_data
 */
function _applyOne(statData, patch) {
	const doc = _.cloneDeep(statData)
	const { op, path, value } = patch || {}
	const lodashPath = _toLodashPath(path)
	if (!lodashPath) {
		console.warn('[beilu-airp] stateMachine: 非法/不安全路径，跳过:', path)
		return doc
	}
	switch (op) {
		case 'set':
		case 'assign':
		case 'replace':
			_.set(doc, lodashPath, value)
			break
		case 'delta': {
			// 增量：现有数值上加（如 好感度+5）；不存在则初始化为增量值
			const cur = _.get(doc, lodashPath)
			const nCur = Number(cur)
			const nVal = Number(value)
			if (Number.isNaN(nVal)) {
				console.warn('[beilu-airp] stateMachine: delta value 非数值，跳过:', path, value)
				break
			}
			_.set(doc, lodashPath, (Number.isNaN(nCur) ? 0 : nCur) + nVal)
			break
		}
		case 'remove':
			_.unset(doc, lodashPath)
			break
		default:
			console.warn('[beilu-airp] stateMachine: 未支持的 op，跳过:', op)
	}
	return doc
}

// ============================================================
// §4 解析 AI 输出中的数值指令
// ============================================================

/** <airp-patch>...</airp-patch> 块，内部为 JSON 数组 [{op,path,value}, ...] */
const AIRP_PATCH_RE = /<airp-patch>\s*([\s\S]*?)\s*<\/airp-patch>/g

/**
 * 从 AI 输出解析数值指令并应用到当前状态。
 * 语法：<airp-patch>[{"op":"delta","path":"好感度","value":5}, ...]</airp-patch>
 * @param {string} content - AI 原始输出
 * @param {object} currentState - 当前状态 { stat_data:{...} }
 * @returns {{ newState: object, hasChanges: boolean }}
 */
export function parseAirpCommands(content, currentState) {
	const newState = _.cloneDeep(currentState || {})
	if (!newState.stat_data || typeof newState.stat_data !== 'object') newState.stat_data = {}
	let hasChanges = false
	if (typeof content !== 'string') return { newState, hasChanges }

	let m
	AIRP_PATCH_RE.lastIndex = 0
	while ((m = AIRP_PATCH_RE.exec(content)) !== null) {
		let patches
		try {
			patches = JSON.parse(m[1])
		} catch (e) {
			console.warn('[beilu-airp] stateMachine: <airp-patch> JSON 解析失败，跳过该块:', e.message)
			continue
		}
		if (!Array.isArray(patches)) continue
		for (const p of patches) {
			if (!p || typeof p !== 'object' || typeof p.path !== 'string') continue
			newState.stat_data = _applyOne(newState.stat_data, p)
			hasChanges = true
		}
	}
	return { newState, hasChanges }
}

// ============================================================
// §5 显示态剥离（照 mvu hideVariableCommands）
// ============================================================

/**
 * 从显示内容剥掉 <airp-patch> 数值指令块（数值指令不该裸露给用户看）。
 * 注意：只剥数值指令；scene/sym/char/desc 视觉标签保留(第4章渲染器消费)。
 * @param {string} content
 * @returns {string}
 */
export function hideAirpCommands(content) {
	if (typeof content !== 'string') return content
	let cleaned = content.replace(/<airp-patch>[\s\S]*?<\/airp-patch>/g, '')
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
	return cleaned
}
/**
 * regexCore.mjs — 正则核心纯函数库（前后端共享唯一权威源）
 *
 * 功能链（纯函数，无副作用）：
 *   parseRegexFromString(input, onError?) → /pattern/flags 字符串 → RegExp 对象
 *     → 支持 pattern 内 \/ 转义；裸字符串降级 new RegExp(input,"g")；失败回调 onError
 *   extractCaptureGroups(args) → replace 回调 ...args → 提取纯捕获组数组（截断到第一个 number）
 *   extractNamedGroups(args) → 提取命名组对象（最后一个非数组对象）
 *   computeReplacement(replaceStr, match, captureGroups, namedGroups, trimList?)
 *     → 与 SillyTavern runRegexScript 行为对齐：{{match}}→$0，$N→捕获组，$<name>→命名组
 *     → 回调模式替换避免 $$/$&/$`/$' 被特殊解释；trimList 对匹配文本和捕获组均生效
 *   protectJsonSegments(text) → 保护 JSON 结构体（{} 块）不被正则破坏 → 占位符映射
 *   restoreProtectedSegments(text, map) → 还原占位符为原始 JSON
 *   assessRegexComplexity(pattern) → 评估 ReDoS 风险（量词嵌套深度/数量）→ {ok, reason}
 *   REGEX_MAX_INPUT_LENGTH → 安全最大输入长度常量
 *
 * why（单一权威源消灭漂移）：
 *   历史上前后端各维护一份 parseRegexFromString + computeReplacement，语义悄悄漂移；
 *   此模块把两端必须逐字一致的逻辑收归唯一实现，各端的显示/提示词侧差异留在外壳里。
 *   约束：纯函数，禁 window/document/localStorage/node:* 任何运行时全局。
 *   错误遥测通过 onError 回调外置，前端注入 wb 通道，后端注入日志函数。
 *
 * 关联链：
 *   ← displayRegex.mjs（浏览器端消费：markdownOnly/display 规则处理）
 *   ← 后端 beilu-regex 插件（Deno 端消费：user_input/ai_output/world_info/output_filter）
 *   ← regexEditor.mjs（assessRegexComplexity 编辑时实时护栏提示）
 *
 * 影响范围：
 *   无 DOM / 无网络 / 无存储操作；纯输入→输出转换。
 *   所有调用方通过 import 引用，修改本模块会同时影响前后端所有正则处理路径。
 *
 * 使用效果：
 *   前端消息渲染时用 parseRegexFromString 解析用户配置的正则字符串，用 computeReplacement
 *   计算替换结果，与 SillyTavern 行为一致；ReDoS 护栏拒绝高风险规则执行。
 */

/**
 * 从斜杠分隔的正则字符串解析为 RegExp 对象
 * @param {string} input - 形如 /pattern/flags 的正则字符串（pattern 内 `/` 以 `\/` 转义）
 * @param {(stage: string, message: string, data: object) => void} [onError] - 可选错误遥测回调
 * @returns {RegExp|null}
 */
export function parseRegexFromString(input, onError) {
	if (!input) return null
	const match = input.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!match) {
		// 不是 /pattern/flags 格式，尝试当作纯字符串
		try {
			return new RegExp(input, 'g')
		} catch (e) {
			if (onError) onError('parseRegexFromString.bare', e?.message, { input })
			return null
		}
	}
	let [, pattern, flags] = match
	pattern = pattern.replaceAll('\\/', '/')
	try {
		return new RegExp(pattern, flags)
	} catch (e) {
		if (onError) onError('parseRegexFromString', e?.message, { pattern, flags })
		return null
	}
}

/**
 * 从 String.prototype.replace 回调的 ...args 中提取纯捕获组
 *
 * replace(regex, (match, ...args) => {}) 中 args 的结构：
 *   [group1, group2, ..., offset(number), inputString(string), namedGroups?(object)]
 * 在第一个 number(offset) 处截断。
 *
 * @param {Array} args - replace 回调中 match 后的所有参数
 * @returns {Array} 只包含捕获组的数组
 */
export function extractCaptureGroups(args) {
	for (let i = 0; i < args.length; i++) {
		if (typeof args[i] === 'number') {
			return args.slice(0, i)
		}
	}
	return args
}

/**
 * 从 replace 回调的 ...args 中提取命名组对象（最后一个非数组对象）
 * @param {Array} args
 * @returns {object|null}
 */
export function extractNamedGroups(args) {
	const last = args.length > 0 ? args[args.length - 1] : null
	return (typeof last === 'object' && last !== null && !Array.isArray(last)) ? last : null
}

/**
 * 计算正则替换结果（与酒馆 runRegexScript 行为对齐）
 * - {{match}} → $0（完整匹配）
 * - 正则 /\$(\d+)|\$<([^>]+)>/g 精确匹配 $N 与 $<name>，回调模式避免 $$/$&/$`/$' 被特殊解释
 * - 未匹配的捕获组返回空字符串
 * - trimList 对匹配文本与各捕获组值都生效
 *
 * @param {string} replaceStr - 替换字符串模板
 * @param {string} match - 完整匹配文本
 * @param {Array} groups - 捕获组数组（$1=groups[0]）
 * @param {string[]} [trimList] - 需修剪的字符串列表
 * @param {object|null} [namedGroups] - 命名组对象
 * @returns {string} 替换结果
 */
export function computeReplacement(replaceStr, match, groups, trimList = [], namedGroups = null) {
	let target = match
	if (trimList.length > 0) {
		for (const trim of trimList) {
			target = target.replaceAll(trim, '')
		}
	}

	// Step 1: 将 {{match}} 转换为 $0（与酒馆一致）
	let result = (replaceStr || '').replace(/\{\{match\}\}/gi, '$0')

	// Step 2: 精确匹配 $N 和 $<name>，回调模式规避特殊替换序列
	result = result.replace(/\$(\d+)|\$<([^>]+)>/g, (_placeholder, num, groupName) => {
		let value
		if (num !== undefined) {
			const idx = Number(num)
			if (idx === 0) {
				value = target // $0 = 完整匹配（经 trimList 处理）
			} else {
				value = groups[idx - 1] // $1 = groups[0]
			}
		} else if (groupName !== undefined) {
			value = namedGroups?.[groupName]
		}

		if (value === undefined || value === null) {
			return '' // 与酒馆一致：未匹配的捕获组返回空字符串
		}

		// 对捕获组内容应用 trimList（与酒馆 filterString 对齐）
		let filtered = String(value)
		if (trimList.length > 0) {
			for (const trim of trimList) { filtered = filtered.replaceAll(trim, '') }
		}
		return filtered
	})

	return result
}

// ============================================================
// JSON/代码段保护（#75）— 前后端共享单一权威
// ------------------------------------------------------------
// 背景：beilu-regex 的 ai_output 规则在 beilu-mvu 解析之前对整段 content 跑替换。
// 若用户正则改/删了 <UpdateVariable>/<JSONPatch>/<ideToolCall> 段或代码块内的
// JSON，mvu 后续按标签探测会读坏变量并静默丢失。框架级解法：应用任何正则前，
// 把受保护段整体抠出换成不可被正则误伤的占位符（PROTECT_SEG_<n>），跑完替换再
// 原样放回。占位符不含任何用户正则可能匹配的结构字符，纯字母数字 sentinel。
//
// 设计依据：⑨ 框架自验 #75（合并_组4 batch30 §4.1 / batch24 §#75）建议 (b)
//   「ai_output 增 JSON 区段保护，跳过 <UpdateVariable>/<JSONPatch>/<ideToolCall> 段」。
//   无凛倾逐字原话定义保护边界；此处按"框架最小一致实现"取：
//     1) 三个结构化标签整段（含标签本身）
//     2) ``` fenced ``` 代码块（任务背景明列"代码块/JSON 块"）
//   均为整段抠出，不做内部内容识别（符合 beilu「只做管道不做内容识别」原则）。
// ============================================================

// 受保护的结构化标签名（整段抠出，含开闭标签）。
// 仅匹配成对标签 <tag ...>...</tag>，自闭合 <tag .../> 也覆盖。
const PROTECTED_TAGS = ['UpdateVariable', 'JSONPatch', 'ideToolCall']

// 占位符 sentinel：纯大写字母+数字，正则元字符/JSON 结构字符均不含，
// 用户正则极难误命中；用零宽不可见字符做不到（会被某些清理规则吃掉），故用文本 sentinel。
const PROTECT_PREFIX = 'PROTECTSEG'

function _buildProtectRegexes() {
	const parts = []
	// fenced code block: ``` 可带语言标识 ... ```（非贪婪，允许内部换行）
	parts.push(/```[\s\S]*?```/g)
	for (const tag of PROTECTED_TAGS) {
		// 自闭合 <tag .../> 或 成对 <tag ...>...</tag>，标签名大小写不敏感
		parts.push(new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[^>]*?>[\\s\\S]*?</${tag}>`, 'gi'))
	}
	return parts
}

/**
 * 抠出受保护段，替换为占位符。返回 { text, segments }。
 * 跑完正则后用 restoreProtectedSegments 放回。
 *
 * @param {string} text
 * @returns {{ text: string, segments: string[] }}
 */
export function protectJsonSegments(text) {
	if (!text || typeof text !== 'string') return { text, segments: [] }
	const segments = []
	let out = text
	for (const re of _buildProtectRegexes()) {
		out = out.replace(re, (m) => {
			const token = `${PROTECT_PREFIX}${segments.length}X`
			segments.push(m)
			return token
		})
	}
	return { text: out, segments }
}

/**
 * 把占位符还原回原始受保护段。
 * @param {string} text
 * @param {string[]} segments - protectJsonSegments 返回的 segments
 * @returns {string}
 */
export function restoreProtectedSegments(text, segments) {
	if (!segments || segments.length === 0) return text
	if (!text || typeof text !== 'string') return text
	let out = text
	// 倒序还原：避免 PROTECTSEG1X 被 PROTECTSEG10X 的前缀匹配吃掉（先长后短）
	for (let i = segments.length - 1; i >= 0; i--) {
		out = out.replaceAll(`${PROTECT_PREFIX}${i}X`, segments[i])
	}
	return out
}

// ============================================================
// ReDoS / 灾难性回溯静态复杂度预检 — 前后端共享单一权威（#ReDoS-FE）
// ------------------------------------------------------------
// 背景：用户/角色卡可控的 findRegex 经 new RegExp 编译后以同步 text.replace 作用于任意输入。
//   原生 V8 RegExp 是回溯引擎，/(a+)+$/ 这类嵌套量词 + 长输入触发指数级灾难性回溯（实测 30
//   个 'a' 已耗 ~10s），同步冻结线程。后端 regexGuard 主防线是 RE2（线性引擎，仅 Deno 可用），
//   静态预检是其回退路径的纵深护栏；前端无 RE2（npm:re2js 是 Deno specifier），故前端【唯一】
//   护栏就是本静态预检 + 输入长度上限。把这套 safe-regex star-height 启发式收敛到 regexCore
//   （纯函数、浏览器安全），让后端 regexGuard._staticComplexityOk 与前端 displayRegex/
//   regexEditor/tavernHelper 三处共用同一份，与后端同闸、消灭副本漂移。
//   注：启发式有误报（如 IP 正则 (\d{1,3}\.){3}）/漏报，叠加长度上限兜底；命中即跳过该规则。
// ============================================================

// 与后端 regexGuard DEFAULT_GUARD_CONFIG 同口径的默认阈值。
export const REGEX_COMPLEXITY_DEFAULTS = { maxQuantifiers: 60, maxNestedQuantifierDepth: 0 }

/**
 * 静态评估正则 pattern 的灾难性回溯风险（纯函数，无运行时全局）。
 * @param {string} pattern - 正则源串（RegExp.source，不含 /.../ 包裹）
 * @param {{maxQuantifiers?:number, maxNestedQuantifierDepth?:number}} [cfg] - 阈值，缺省用 REGEX_COMPLEXITY_DEFAULTS（=后端默认）
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function assessRegexComplexity(pattern, cfg) {
	if (typeof pattern !== 'string') return { ok: true }
	const maxQuantifiers = (cfg && Number.isFinite(cfg.maxQuantifiers)) ? cfg.maxQuantifiers : REGEX_COMPLEXITY_DEFAULTS.maxQuantifiers
	const maxNestedQuantifierDepth = (cfg && Number.isFinite(cfg.maxNestedQuantifierDepth)) ? cfg.maxNestedQuantifierDepth : REGEX_COMPLEXITY_DEFAULTS.maxNestedQuantifierDepth
	let quantifierCount = 0
	let starHeight = 0
	let maxStarHeight = 0
	// 用栈跟踪分组层级，记录每层"进入时的量词数基线"；出组时若该组被量词修饰且组内有量词 → 星高+1
	const groupStack = []
	let inClass = false // 字符类 [...] 内的量词字符不算量词
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]
		const prev = pattern[i - 1]
		if (prev === '\\') continue // 转义字符跳过（\* \+ 等是字面量）
		if (inClass) { if (c === ']') inClass = false; continue }
		if (c === '[') { inClass = true; continue }
		if (c === '(') { groupStack.push(quantifierCount); continue }
		if (c === ')') {
			const baseAtOpen = groupStack.pop() ?? 0
			const groupHasQuantifier = quantifierCount > baseAtOpen
			const next = pattern[i + 1]
			const groupIsQuantified = next === '*' || next === '+' || next === '?' || next === '{'
			if (groupHasQuantifier && groupIsQuantified) {
				starHeight++
				if (starHeight > maxStarHeight) maxStarHeight = starHeight
			}
			continue
		}
		if (c === '*' || c === '+' || c === '?') { quantifierCount++; continue }
		if (c === '{') { quantifierCount++; continue } // 计 {n}/{n,}/{n,m} 为一个量词（粗略足够）
	}
	// maxStarHeight=1 表示存在一处 /(a+)+/（真实 star-height=2）。默认 0 → 任何嵌套量词都拒绝。
	if (maxStarHeight > maxNestedQuantifierDepth) {
		return { ok: false, reason: `嵌套量词(nested-depth=${maxStarHeight}>${maxNestedQuantifierDepth}, 真实star-height≈${maxStarHeight + 1})` }
	}
	if (quantifierCount > maxQuantifiers) {
		return { ok: false, reason: `量词过多(${quantifierCount}>${maxQuantifiers})` }
	}
	// SEC-R4：量词作用于含 alternation 的分组((a|a)+ 类重叠交替)=经典 ReDoS，星高计数看不见（组内无量词字符）。保守拦。
	if (/\([^()]*\|[^()]*\)\s*[*+]/.test(pattern) || /\([^()]*\|[^()]*\)\s*\{/.test(pattern)) {
		return { ok: false, reason: '量词作用于交替分组((a|a)+ 类，疑似重叠 ReDoS)' }
	}
	return { ok: true }
}

// 输入长度上限（与后端 maxInputLength 同口径）：超长输入即便正则"安全"也跳过，兜住启发式漏报。
export const REGEX_MAX_INPUT_LENGTH = 1000000

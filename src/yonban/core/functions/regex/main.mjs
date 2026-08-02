/**
 * beilu-regex — 后端正则脚本引擎。不管前端显示侧正则（那是 displayRegex.mjs 的事）。
 *
 * 链路：
 *   TweakPrompt(dl=0) → applyRegexRules('user_input') 改 chatLog 用户消息
 *                      → applyRegexRules('world_info') 改 plugin_prompts
 *   ReplyHandler       → applyRegexRules('ai_output', outputPhase) 改 reply.content
 *                      → applyRegexRules('output_filter', outputPhase) 改 reply.content_for_show
 *   IDE工具回执落log   → applyRegexRules('slash_command') 改 formatToolResultsForInjection 产出
 *                      （0723 补线，收口=beilu-chat/src/lib/generation.mjs _applySlashCommandRegex，3 写点统一经它）
 *
 * 影响：写 config_data.json（saveConfigToDisk）；不广播、不发事件
 * 相交：← beilu-home 角色卡导入调 importFromSTFormat（单一权威源导出）
 *       ← stCompat/tavernHelper getTavernRegexes/replaceTavernRegexes 经 HTTP 读写 rules
 *       → regexGuard.mjs guardedReplace（RE2 优先 + ReDoS 护栏）
 *       → regexCore.mjs computeReplacement/protectJsonSegments（前后端共享纯函数）
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nicerWriteFileSync } from '../../../../scripts/nicerWriteFile.mjs'
import info from '../../../../public/parts/plugins/beilu-regex/info.json' with { type: 'json' } // T3a·3.4: part 元数据留原位
// 单一权威源：正则解析 + 捕获组替换语义与前端 displayRegex 共用 regexCore，禁止再造副本
import { computeReplacement, extractCaptureGroups, extractNamedGroups, protectJsonSegments, restoreProtectedSegments } from '../../../../public/parts/shells/beilu-chat/public/src/shared/regex-core/regexCore.mjs' // T3a·3.4: 前端共享 regexCore 留原位（shared 归属，B1 隐藏任务）
// ReDoS / 灾难性回溯护栏（仅后端 Deno 侧）：用户/角色卡可控正则改走 RE2 线性引擎，
// 不支持的特性回退原生 + 静态复杂度预检 + 输入长度上限。详见 regexGuard.mjs 头注释。
import { guardedReplace, configureGuard, getGuardConfig, getGuardDefaults } from './regexGuard.mjs'
// 0716：stripReasoningTags 回归（0714 曾删）——内置+自定义标签剥离的权威单源（hide 域，
// 受「思维链显示」设置 reasoning_builtin/reasoning_tags 控制），TweakPrompt 对 assistant 消息先剥再跑用户规则。
// 直接指 hide 实现体（messageTransform 只是 re-export 薄壳）。
import { stripReasoningTags } from '../hide/stripThinking.mjs'
import { wbT, wbD } from "../../../../server/wbStub.mjs";
// [T077 per-user] 正则规则库 per-user 化：磁盘目录从全局单文件 → data/users/<user>/regex/config_data.json
//   （getUserDataDir 权威范式，与 T065 preset / T074 worldbook / yonban_config 同款）。修复实锤泄漏：
//   用户 B 打开正则设置看到用户 A 全部私有正则/替换规则，B 增删改覆盖 A 的规则（磁盘单文件 + 内存单例双同型病）。
import { getUserDataDir } from "../memory/storage_mod/storage.mjs";
// [T077 per-user] HTTP 端点鉴权 + 身份解析：与 preset REST 薄壳同型（authenticate 未认证→401；getUserByReq→username）。
import { authenticate, getUserByReq } from "../security/auth.mjs";
// [0716 W2 刷新机制] 规则变更广播出口（与 preset/main.mjs 静态 import dispatch 同范式，无环：dispatcher 不依赖具体插件）
import { dispatch } from "../../dispatch/dispatcher.mjs";

// ============================================================
// 持久化（T077 per-user：路径/内存均按 username 分桶）
// ============================================================

const __pluginDir = dirname(fileURLToPath(import.meta.url))

// [T077 per-user] 常量 CONFIG_FILE（全局单文件）→ (username)=>path 函数，锚 data/users/<user>/regex/。
//   空 username 回退 "_default" 桶（getUserDataDir 内部同款兜底）——匿名/主链无 user 时不崩，
//   与 preset _userPresetDir / worldbook configFileFor 同型。禁旧全局路径运行时回退（漏迁会串台复活）。
function configFileFor(username) {
	return join(getUserDataDir(username || '_default'), 'regex', 'config_data.json')
}

/**
 * 将某 user 的 pluginData 保存到该 user 的磁盘文件
 * @param {string} username
 * @param {object} data - 该 user 的 store 数据（pluginData 形状）
 */
function saveConfigToDisk(username, data) {
	try {
		const f = configFileFor(username)
		// [T077] nicerWriteFileSync 不建目录：首次为新用户写时 data/users/<user>/regex/ 不存在会 ENOENT。
		//   与 preset saveGlobalConfig 同款先 mkdir（recursive 幂等），防新用户首次保存静默失败（被 catch 吞成 warn 丢数据）。
		const dir = dirname(f)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		nicerWriteFileSync(f, JSON.stringify(data, null, 2), 'utf-8')
		// 【store 级失效】自写推进指纹，防 getStore 把自己的写误判为外部变更（2026-08-01 批①修）
		try { _diskMtimeByUser.set(_normUser(username), fs.statSync(f).mtimeMs || 0) } catch { /* 指纹推进失败仅退化为下次多一次无害重载 */ }
		// [0716 W2 刷新机制] 写盘=规则/配置变更的唯一事实点（全部 CRUD case 收口于此，读写同源）
		//   → 单点广播 regex_rules_changed（preset_list_changed 同范式，跨窗口/显示层缓存刷新）。
		//   fire-and-forget（本函数 sync）；启动迁移回写也广播=前端拿到迁移后的干净列表，幂等无害。
		try {
			dispatch({
				target: 'bus:broadcast', verb: 'emitAll', source: 'yonban',
				payload: { username: username !== '_default' ? username : undefined, event: { type: 'regex_rules_changed', payload: {} } },
			}).then((_r) => { if (_r && !_r.ok) console.warn('[beilu-regex] regex_rules_changed 广播失败:', _r?.error?.msg) }).catch(() => {})
		} catch { /* 广播不可用不影响写盘 */ }
	} catch (e) {
		console.warn('[beilu-regex] 保存配置到磁盘失败:', e.message)
	}
}

/**
 * 从某 user 的磁盘文件读取配置
 * @param {string} username
 * @returns {object|null}
 */
function loadConfigFromDisk(username) {
	try {
		const f = configFileFor(username)
		if (fs.existsSync(f)) {
			return JSON.parse(fs.readFileSync(f, 'utf-8'))
		}
	} catch (e) {
		console.warn('[beilu-regex] 从磁盘读取配置失败:', e.message)
	}
	return null
}

// ============================================================
// 正则工具函数
// ============================================================

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

// ============================================================
// ST 正则脚本完整格式
// ============================================================

/**
 * @typedef {Object} RegexScript
 * @property {string} id - 唯一 ID
 * @property {string} scriptName - 规则名称
 * @property {string} findRegex - 查找正则 (斜杠分隔或纯字符串)
 * @property {string} replaceString - 替换字符串 (支持 $1, {{match}} 等)
 * @property {string} trimStrings - 替换前要修剪的文本（换行分隔多条）
 * @property {string[]} placement - 应用位置: user_input, ai_output, slash_command, world_info, reasoning, output_filter
 * @property {boolean} disabled - 是否禁用（编辑器级别，禁用后脚本命令也无法触发）
 * @property {boolean} runOnEdit - 编辑消息时是否运行
 * @property {number} substituteRegex - 宏替换模式: 0=不替换, 1=原始, 2=转义
 * @property {number} minDepth - 最小消息深度 (-1 或空 = 无限, 0 = 最新消息)
 * @property {number} maxDepth - 最大消息深度 (0 = 无限)
 * @property {boolean} markdownOnly - 仅显示格式（不改变聊天文件/提示词）
 * @property {boolean} promptOnly - 仅提示词格式（不改变聊天文件/显示）
 * @property {'global'|'scoped'|'preset'} scope - 作用域: global=全局, scoped=角色绑定, preset=预设绑定
 * @property {number} [priority] - 应用优先级（数字小者先执行；缺省=默认值，按数组原序）
 */

/**
 * 创建默认正则规则
 * @param {Partial<RegexScript>} [overrides]
 * @returns {RegexScript}
 */
function createDefaultRule(overrides = {}) {
	return {
		id: generateId(),
		scriptName: '',
		findRegex: '',
		replaceString: '',
		trimStrings: '',
		placement: ['ai_output'],
		disabled: false,
		runOnEdit: false,
		substituteRegex: 0,
		minDepth: -1,
		maxDepth: 0,
		markdownOnly: false,
		promptOnly: false,
		scope: 'global',
		boundCharName: '',
		boundPresetName: '',
		...overrides,
	}
}

// ============================================================
// 预设名归一化（单一权威口径）
// 线上 summarize-thinking 泄漏根因：preset scope 规则 boundPresetName 存的是
// "017…3.6.3_(4).json"（下划线 + .json 后缀，早期导入路径写入），而比对侧
// currentPresetName = engine.presetName = config.json active_preset = "017…3.6.3 (4)"
// （空格、无后缀）。直接 !== 字节比对导致 4 条规则全静默丢。
// 归一化：去 .json 后缀 + 下划线/空格归一 + trim，比对两边都过此函数，
// 容忍历史脏数据（带后缀/下划线/多余空白），不依赖写侧已被清理。
// ============================================================
function normalizePresetName(s) {
	if (s == null) return ''
	return String(s)
		.replace(/\.json$/i, '')   // 去 .json 后缀
		.replace(/[_\s]+/g, ' ')   // 下划线/连续空白 → 单空格（"_(4)" 与 " (4)" 归一）
		.trim()
}

// ============================================================
// placement 数字→字符串映射（兼容 ST 旧版数字格式）
// ============================================================

// ST 权威枚举(engine.js:229-235): MD_DISPLAY=0/USER_INPUT=1/AI_OUTPUT=2/SLASH_COMMAND=3/(4 已删 sendAs 空位)/WORLD_INFO=5/REASONING=6
const PLACEMENT_NUM_TO_STR = {
	0: 'ai_output',    // MD_DISPLAY 已废弃，回退到 ai_output
	1: 'user_input',
	2: 'ai_output',
	3: 'slash_command',
	4: 'world_info',   // 旧版/兼容：部分历史数据用 4 表世界书，宽容并入 world_info
	5: 'world_info',   // 当前 ST: WORLD_INFO=5
	6: 'reasoning',    // 当前 ST: REASONING=6
}

// 字符串→ST 数字(导出回 ST 用，与上表同一权威的反向)。beilu 专属 scope(output_filter 等) 无 ST 对应 → 导出时丢弃
const PLACEMENT_STR_TO_NUM = {
	user_input: 1,
	ai_output: 2,
	slash_command: 3,
	world_info: 5,
	reasoning: 6,
}

/**
 * 检查规则的 placement 是否包含指定过滤器（兼容数字和字符串格式）
 * @param {(string|number)[]} placement - 规则的 placement 数组
 * @param {string} filter - 过滤器字符串，如 'ai_output'
 * @returns {boolean}
 */
function placementIncludes(placement, filter) {
	if (!placement || !Array.isArray(placement)) return false
	for (const p of placement) {
		if (p === filter) return true
		if (typeof p === 'number' && PLACEMENT_NUM_TO_STR[p] === filter) return true
	}
	return false
}

// ============================================================
// 正则执行引擎
// ============================================================

/**
 * 对文本应用单条正则规则
 * @param {string} text - 输入文本
 * @param {RegexScript} rule - 规则
 * @param {Object} [macroValues] - 宏替换值（{{user}}, {{char}} 等）
 * @returns {string} 处理后的文本
 */
async function applySingleRule(text, rule, macroValues = {}) {
	if (!text || !rule.findRegex) return text

	let findStr = rule.findRegex

	// 宏替换（在正则中替换 {{user}} 等）
	if (rule.substituteRegex > 0 && macroValues) {
		for (const [key, value] of Object.entries(macroValues)) {
			const macroPattern = `{{${key}}}`
			if (findStr.includes(macroPattern)) {
				const replacement = rule.substituteRegex === 2
					? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // 转义模式
					: value // 原始模式
				findStr = findStr.replaceAll(macroPattern, replacement)
			}
		}
	}

	// trimStrings 处理：在替换前先从匹配文本中移除指定字符串
	let replaceStr = rule.replaceString || ''
	const trimList = rule.trimStrings
		? rule.trimStrings.split('\n').filter(s => s.length > 0)
		: []

	// 捕获组替换收敛到 regexCore 单一权威，与前端 displayRegex / 酒馆 runRegexScript 逐字一致：
	// $N/$<name>/$0/{{match}} 语义、未命中组返回空串、trimList 作用于匹配文本与各组值，均由 computeReplacement 统一处理。
	// 编译 + 执行收敛到 guardedReplace（RE2 线性引擎优先，挡 ReDoS；不支持则原生+预检+长度上限回退）。
	// replacerFn 回调签名与原生 String.replace 一致 → RE2 与原生两路径替换语义完全相同。
	const onGuardError = (stage, msg, data) => {
		// 编译失败 / 高危跳过 → 映射到前端面板遥测，否则用户不知自己的正则坏了或被护栏挡了。
		wbD(null, "regex:apply", stage, false, `${msg}: ${findStr.slice(0, 60)}`, { find: findStr.slice(0, 120), ...data })
	}
	const res = await guardedReplace(
		text,
		findStr,
		(match, ...args) => {
			const groups = extractCaptureGroups(args)
			const namedGroups = extractNamedGroups(args)
			return computeReplacement(replaceStr, match, groups, trimList, namedGroups)
		},
		{ onError: onGuardError }
	)

	return res.text
}

/**
 * 对文本应用正则规则列表
 * @param {string} text - 输入文本
 * @param {RegexScript[]} rules - 规则列表
 * @param {string} placementFilter - 应用位置过滤
 * @param {Object} [options]
 * @param {number} [options.messageDepth] - 消息深度
 * @param {Object} [options.macroValues] - 宏替换值
 * @param {boolean} [options.isEdit] - 是否为编辑操作
 * @returns {string} 处理后的文本
 */
// #75：规则无 priority 字段时的默认优先级。所有缺省规则同值 → 稳定排序退化为原数组序，
// 完全向后兼容（不写 priority 的旧规则顺序不变）。用户给某条更小的 priority 即可提前执行。
const DEFAULT_RULE_PRIORITY = 100

/**
 * 按 priority 稳定排序（小者先）。缺省 priority 视为 DEFAULT_RULE_PRIORITY；
 * priority 相同（含全缺省）时保持输入数组的原相对顺序（稳定）。
 * @param {RegexScript[]} rules
 * @returns {RegexScript[]} 新数组（不改原数组）
 */
function sortRulesByPriority(rules) {
	return rules
		.map((rule, idx) => ({ rule, idx }))
		.sort((a, b) => {
			const pa = (typeof a.rule.priority === 'number') ? a.rule.priority : DEFAULT_RULE_PRIORITY
			const pb = (typeof b.rule.priority === 'number') ? b.rule.priority : DEFAULT_RULE_PRIORITY
			if (pa !== pb) return pa - pb
			return a.idx - b.idx // 同优先级稳定：保持原序
		})
		.map(x => x.rule)
}

/**
 * 对文本批量应用正则规则（核心执行入口）。
 *
 * 链路：TweakPrompt / ReplyHandler → 本函数 → sortRulesByPriority → 逐条 applySingleRule → guardedReplace
 * 影响：修改并返回 text；内部经 protectJsonSegments 保护 JSON/代码段不被正则破坏
 * 约束：
 *   - outputPhase=true 时 promptOnly 规则被跳过（防止 prompt-only 规则污染落盘回复）
 *   - scoped 规则双键匹配 currentCharId(目录名) + currentCharName(显示名)，任一命中即通过
 *   - preset 规则两侧 normalizePresetName 归一化后比对，容忍历史脏数据（.json 后缀/下划线）
 *
 * @param {string} text - 输入文本
 * @param {RegexScript[]} rules - 规则列表（会被 sortRulesByPriority 排序，不改原数组）
 * @param {string} placementFilter - 应用位置过滤（'user_input'|'ai_output'|'world_info'|'output_filter'|'display'）
 * @param {Object} [options]
 * @param {number} [options.messageDepth] - 消息深度（chatLog 末尾=0，越早越大）
 * @param {Object} [options.macroValues] - 宏替换值（{{user}}, {{char}} 等）
 * @param {boolean} [options.isEdit] - 是否为编辑操作（runOnEdit=false 的规则被跳过）
 * @param {string} [options.currentCharId] - 当前角色目录名（scoped 口径主键）
 * @param {string} [options.currentCharName] - 当前角色显示名（scoped 口径兜底）
 * @param {string} [options.currentPresetName] - 当前预设名（preset 规则过滤用）
 * @param {boolean} [options.outputPhase] - 是否为输出阶段（ReplyHandler 传 true，跳过 promptOnly 规则）
 * @returns {Promise<string>} 处理后的文本
 */
async function applyRegexRules(text, rules, placementFilter, options = {}) {
	if (!rules || !Array.isArray(rules) || rules.length === 0) return text
	if (!text || typeof text !== 'string') return text

	const { messageDepth = 0, macroValues = {}, isEdit = false, currentCharId = '', currentCharName = '', currentPresetName = '' } = options

	// #75-①：JSON/代码段保护 — 应用任何规则前把受保护段（<UpdateVariable>/<JSONPatch>/
	// <ideToolCall>/```代码块```）整体抠出换占位符，跑完所有规则再放回。框架级一处，
	// 不在每条规则里加 if。保护逻辑收敛在共享 regexCore（前后端同源）。
	const { text: protectedText, segments } = protectJsonSegments(text)
	text = protectedText

	// #75-②：按 priority 稳定排序（小者先执行）。缺省字段 → 默认值 → 退化为原序（向后兼容）。
	const orderedRules = sortRulesByPriority(rules)

	for (const rule of orderedRules) {
		if (rule.disabled) continue
		if (!rule.placement || !placementIncludes(rule.placement, placementFilter)) continue

		// 作用域过滤：scoped 规则只对绑定的角色生效。
		// 口径双键(对齐 beilu-worldbook getAllEnabledEntries:430)：boundCharName 写入时存目录名(char_id/finalName)，
		// 但本函数历史只比显示名(Charname)→ 目录≠显示名的卡(非法字符sanitize/重名_N/用户改名)scoped 正则在生成路径静默丢。
		// 改为目录名(currentCharId,主键)与显示名(currentCharName,兜底)任一命中即视为绑定本角色。
		if (rule.scope === 'scoped' && rule.boundCharName && (currentCharId || currentCharName)) {
			if (rule.boundCharName !== currentCharId && rule.boundCharName !== currentCharName) continue
		}

		// 作用域过滤：preset 规则只对绑定的预设生效
		// 比对两边均过 normalizePresetName，容忍 boundPresetName 历史脏数据
		// （下划线/.json 后缀）与 active_preset（空格/无后缀）的口径分叉。
		if (rule.scope === 'preset') {
			const ruleBoundPreset = normalizePresetName(rule.boundPresetName)
			const curPreset = normalizePresetName(currentPresetName)
			if (ruleBoundPreset && curPreset && ruleBoundPreset !== curPreset) continue
			// 如果 currentPresetName 为空但规则有绑定，跳过
			if (ruleBoundPreset && !curPreset) continue
		}

		// 深度范围检查
		const minD = rule.minDepth ?? -1
		const maxD = rule.maxDepth ?? 0
		if (minD >= 0 && messageDepth < minD) continue
		if (maxD > 0 && messageDepth > maxD) continue

		// 编辑检查
		if (isEdit && !rule.runOnEdit) continue

		// 瞬时性检查 — markdownOnly 的规则不应在 prompt 构建阶段运行
		if (rule.markdownOnly && placementFilter !== 'display') continue
		// promptOnly 的规则不应在显示阶段 + 输出保存阶段运行（仅作用于 prompt 构建）。
		//   'ai_output' placement 在 TweakPrompt(prompt 阶段,该跑) 与 ReplyHandler(改 reply.content=聊天文件,不该跑) 复用，
		//   placementFilter 区分不了 → 靠 options.outputPhase 标志区分同名 'ai_output' 的 prompt vs 输出保存/显示阶段。
		if (rule.promptOnly && (placementFilter === 'display' || options.outputPhase)) continue

		text = await applySingleRule(text, rule, macroValues)
	}

	// #75-①：放回受保护段（占位符 → 原始 JSON/代码块）。即便无保护段也是 no-op。
	text = restoreProtectedSegments(text, segments)

	return text
}

/**
 * 测试模式：对输入文本应用单条规则，返回结果
 * @param {string} input - 测试输入
 * @param {RegexScript} rule - 要测试的规则
 * @param {Object} [macroValues] - 宏替换值
 * @returns {{ output: string, matched: boolean }}
 */
async function testRule(input, rule, macroValues = {}) {
	if (!input || !rule.findRegex) return { output: input, matched: false }
	const output = await applySingleRule(input, rule, macroValues)
	return { output, matched: output !== input }
}

/**
 * 从 ST 角色卡的 extensions.regex_scripts 导入正则规则
 * @param {object[]} stScripts - ST 格式的正则脚本
 * @param {'global'|'scoped'|'preset'} [scope='global'] - 导入到哪个作用域
 * @returns {RegexScript[]}
 */
/**
 * 从 ST 角色卡的 extensions.regex_scripts 导入正则规则。
 *
 * 链路：beilu-home 角色卡导入 / SetData('importST') / SetData('syncPresetRegex') → 本函数
 * 影响：返回新规则数组（调用方 push 到 pluginData.rules 并 saveConfigToDisk）
 * 约束：placement 兼容三种 ST 格式——数字数组 / 单数字 / boolean flags，统一归一为字符串数组
 *
 * @param {object[]} stScripts - ST 格式的正则脚本
 * @param {'global'|'scoped'|'preset'} [scope='global'] - 导入到哪个作用域
 * @param {string} [boundCharName] - scoped 规则绑定的角色名（目录名）
 * @param {string} [boundPresetName] - preset 规则绑定的预设名
 * @returns {RegexScript[]}
 */
function importFromSTFormat(stScripts, scope = 'global', boundCharName = '', boundPresetName = '') {
	if (!Array.isArray(stScripts)) return []

	return stScripts.map(script => {
		// placement 可以是数组或旧版数字/字符串格式
		let placement = ['ai_output']
		if (script.placement !== undefined) {
			if (Array.isArray(script.placement)) {
				// ST 旧版格式: placement 是数字数组 [0, 1, 2]
				// 需要将数字转换为字符串标识符
				placement = script.placement.map(p => {
					if (typeof p === 'number') {
						return PLACEMENT_NUM_TO_STR[p] || 'ai_output'
					}
					return p // 已经是字符串，保留原样
				})
			} else if (typeof script.placement === 'number') {
				placement = [PLACEMENT_NUM_TO_STR[script.placement] || 'ai_output']
			} else if (typeof script.placement === 'string') {
				placement = [script.placement]
			}
		}

		// ST 新版 placement 字段可能用 boolean flags
		if (script.user_input !== undefined || script.ai_output !== undefined) {
			placement = []
			if (script.user_input) placement.push('user_input')
			if (script.ai_output) placement.push('ai_output')
			if (script.slash_command) placement.push('slash_command')
			if (script.world_info) placement.push('world_info')
			if (script.reasoning) placement.push('reasoning')
		}

		return createDefaultRule({
			scriptName: script.scriptName || script.name || '',
			findRegex: script.findRegex || '',
			replaceString: script.replaceString || '',
			trimStrings: Array.isArray(script.trimStrings)
				? script.trimStrings.join('\n')
				: (script.trimStrings || ''),
			placement,
			disabled: script.disabled || false,
			runOnEdit: script.runOnEdit || false,
			substituteRegex: script.substituteRegex ?? 0,
			minDepth: script.minDepth ?? -1,
			maxDepth: script.maxDepth ?? 0,
			markdownOnly: script.markdownOnly || false,
			promptOnly: script.promptOnly || false,
			scope,
			boundCharName,
			boundPresetName,
			// #75：若来源脚本带 priority 则保留，否则不写（缺省走默认优先级）
			...(typeof script.priority === 'number' ? { priority: script.priority } : {}),
		})
	})
}

/**
 * 将规则导出为 ST 兼容格式
 * @param {RegexScript} rule
 * @returns {object}
 */
function exportToSTFormat(rule) {
	// placement: beilu 字符串 → ST 数字(同一权威反向)，去重；丢弃无 ST 对应的 beilu 专属 scope；全无对应回退 ai_output(2)
	const stPlacement = [...new Set(
		(rule.placement || [])
			.map(p => (typeof p === 'number' ? p : PLACEMENT_STR_TO_NUM[p]))
			.filter(n => typeof n === 'number')
	)]
	// beilu 用 -1/0 作"无限"哨兵(minDepth -1=无下限, maxDepth 0=无上限)；ST 用 null 表无限 → 导出还原，避免 ST 误判为字面深度界
	const minD = rule.minDepth ?? -1
	const maxD = rule.maxDepth ?? 0
	return {
		scriptName: rule.scriptName,
		findRegex: rule.findRegex,
		replaceString: rule.replaceString,
		trimStrings: rule.trimStrings ? rule.trimStrings.split('\n') : [],
		placement: stPlacement.length ? stPlacement : [2],
		disabled: rule.disabled,
		runOnEdit: rule.runOnEdit,
		substituteRegex: rule.substituteRegex,
		minDepth: minD < 0 ? null : minD,
		maxDepth: maxD === 0 ? null : maxD,
		markdownOnly: rule.markdownOnly,
		promptOnly: rule.promptOnly,
		// #75：仅在显式设置时导出 priority，保持 ST 兼容（ST 无此字段，缺省不污染导出）
		...(typeof rule.priority === 'number' ? { priority: rule.priority } : {}),
	}
}

// ============================================================
// 插件数据
// ============================================================

// [T077 per-user] 原 module 级 `let pluginData`（全用户共享单例，跨用户串台根因）已下沉到
//   perUserStore：username → pluginData。getStore(username) 惰性建桶 + 首访 loadConfigFromDisk（含 builtin 种子播种）。
//   与 T065 preset perUserStore / T074 worldbook perUserStore 同型。
/** 某 user 的默认（空）pluginData 形状。builtin output_filter 模板由 _seedDefaultOutputFilterRules 首访播种。 */
function _freshPluginData() {
	return {
		rules: [],       // RegexScript[] — 所有规则（global + scoped + preset）
		enabled: true,   // 全局开关
		renderMode: 'sandbox', // 'sandbox' | 'free' — 美化渲染模式
		// ReDoS 护栏配置（安全默认全开）。详见 regexGuard.mjs DEFAULT_GUARD_CONFIG。
		// 缺省字段由 getGuardConfig() 兜安全默认，磁盘可只存用户改过的字段。
		regexGuard: undefined,
	}
}

/** @type {Map<string, object>} username → pluginData */
const perUserStore = new Map()

// 【store 级失效】盘=真相指纹（2026-08-01 批①存写不生效修）：username → config_data.json mtimeMs。
//   worker isolate 与主 isolate 各持一份本模块单例，旧实现惰性载入后零失效——UI 改正则后
//   worker 内 TweakPrompt/ReplyHandler 持续用旧规则直到进程回收。照抄 preset getStore mtime 范式。
const _diskMtimeByUser = new Map()

/** 归一 username：空/未定义 → "_default" 桶（匿名/主链无 user 时的回退桶，与 preset/worldbook _normUser 同型） */
function _normUser(username) {
	return (typeof username === 'string' && username) ? username : '_default'
}

/**
 * 惰性取某 user 的 pluginData：首访建桶 + loadConfigFromDisk + builtin 种子播种 + 护栏配置注入。
 * @param {string} username
 * @returns {object} 该 user 的 pluginData（rules/enabled/renderMode/regexGuard/_outputFilterSeeded）
 */
function getStore(username) {
	const key = _normUser(username)
	let data = perUserStore.get(key)
	if (data) {
		// 【store 级失效】盘=真相，内存桶=缓存（2026-08-01 批①修，范式=preset/main.mjs:795-823）：
		//   写盘唯一事实点 saveConfigToDisk 同步推进本 isolate 指纹（不自失效）；跨 isolate/外部写盘
		//   → mtime 前进 → 就地重建桶字段（不换对象引用，捕获旧引用的持有方同步看到新值）。
		try {
			const f = configFileFor(key)
			let curMt = 0
			try { curMt = fs.existsSync(f) ? (fs.statSync(f).mtimeMs || 0) : 0 } catch { curMt = 0 }
			if (curMt !== (_diskMtimeByUser.get(key) ?? 0)) {
				const saved = loadConfigFromDisk(key)
				if (saved) {
					if (Array.isArray(saved.rules)) data.rules = saved.rules.filter(r => !r?._builtin)
					if (saved.enabled !== undefined) data.enabled = saved.enabled
					if (saved.renderMode === 'sandbox' || saved.renderMode === 'free') data.renderMode = saved.renderMode
					if (saved._outputFilterSeeded) data._outputFilterSeeded = true
					if (saved.regexGuard && typeof saved.regexGuard === 'object') { data.regexGuard = saved.regexGuard; configureGuard(saved.regexGuard) }
				}
				_diskMtimeByUser.set(key, curMt)
			}
		} catch (e) {
			// fail-loud 留痕但不吞任务：stat/读盘异常沿用旧快照（同 preset 范式）
			console.warn(`[beilu-regex] getStore("${key}") 盘态失效检查失败(沿用旧快照):`, e?.message)
		}
		return data
	}

	data = _freshPluginData()
	perUserStore.set(key, data)

	// 首访：从该 user 磁盘载入（原 Load() 里的恢复逻辑下沉到此，per-user）
	try {
		const saved = loadConfigFromDisk(key)
		if (saved) {
			if (Array.isArray(saved.rules)) {
				// 0716 迁移清理：reasoning 内置规则回归 hide/stripThinking 单源（凛倾：内置剥离是内部机制，
				//   归「思维链显示」设置管（reasoning_builtin 开关 + reasoning_tags 自定义标签），
				//   不作为用户正则显示）。历史盘上有反复播种的重复内置规则（恢复白名单曾漏回读
				//   _reasoningSeeded，每次重启 +4 条，实测单用户堆到 100+），此处过滤 _builtin 治愈；
				//   有过滤即回写盘（getStore 尾部），防脏数据复活。用户自建规则（无 _builtin）原样保留。
				const _nBefore = saved.rules.length
				data.rules = saved.rules.filter(r => !r?._builtin)
				if (data.rules.length !== _nBefore) data._builtinPurged = true
			}
			if (saved.enabled !== undefined) data.enabled = saved.enabled
			if (saved.renderMode === 'sandbox' || saved.renderMode === 'free') data.renderMode = saved.renderMode
			if (saved._outputFilterSeeded) data._outputFilterSeeded = true
			if (saved.regexGuard && typeof saved.regexGuard === 'object') data.regexGuard = saved.regexGuard
			console.log(`[beilu-regex] getStore("${key}") 已恢复 ${data.rules.length} 条正则规则`)
		}
	} catch (e) {
		console.warn(`[beilu-regex] getStore("${key}") 首访加载失败:`, e.message)
	}

	// builtin 种子：首次为该 user 种下 output_filter 模板（3 条全 disabled）。
	//   删光后重启不再回填（_outputFilterSeeded 标记）。
	//   reasoning 内置种子已删（0716）：内置剥离回归 hide/stripThinking 单源，见 TweakPrompt reasoning 分支。
	_seedDefaultOutputFilterRules(key, data)

	// 0716 迁移回写：上方恢复逻辑过滤掉了历史污染的 _builtin 规则 → 立即固化到盘，一次治愈。
	if (data._builtinPurged) {
		delete data._builtinPurged
		saveConfigToDisk(key, data)
	}

	// ReDoS 护栏：注意 configureGuard 是护栏模块的全局单态（非 per-user）。用户改护栏仍写各自盘，
	//   但生效的护栏配置是最后一次 configureGuard 的值——护栏是"安全上限"性质（防 ReDoS），
	//   非用户私产语义，全局单态可接受（与 preset 全局 engine 单态同类，不属本次隔离资产）。
	if (data.regexGuard) configureGuard(data.regexGuard)

	// 【store 级失效】首访完成即记录盘指纹（2026-08-01 批①修）
	try { const _f = configFileFor(key); _diskMtimeByUser.set(key, fs.existsSync(_f) ? (fs.statSync(_f).mtimeMs || 0) : 0) } catch { _diskMtimeByUser.set(key, 0) }

	return data
}

// ============================================================
// reasoning（thinking 剥离）——0716 回归单源，内置剥离不再做成用户规则
// 历史：0714 曾把内置剥离做成 per-user 种子规则（DEFAULT_REASONING_RULES 4 条入用户 rules 存储）。
// 该设计有三病（凛倾 0716 定案回滚）：
//   ① 第二存储：思维链标签已有权威单源 hide/stripThinking（reasoning_builtin 开关 + reasoning_tags
//      自定义标签，「思维链显示」设置面板读写）——种子规则是硬编码 think/thinking 副本，
//      用户在设置里关内置/加自定义标签，出站主链无感知（断链，同 06-25「只有airp可以改」旧病复发）；
//   ② 内置规则出现在用户正则列表=内部机制泄漏到用户面（且播种 bug 每重启 +4 条重复）；
//   ③ regex 插件整体禁用时出站剥离全失效（proxy 出站兜底也被 0714 删除）。
// 现行架构：内置+自定义标签剥离 = stripReasoningTags（hide 单源，受思维链设置控制），
//   在 TweakPrompt/aiRunner/replyHandler 组装点 + proxy 出站 buildChatLogMessages 兜底执行；
//   用户仍可在正则编辑器自建 reasoning placement 规则（applyRegexRules('reasoning') 只跑用户规则）。
// ============================================================

// SEC-G: output_filter 默认模板规则(首次加载种子,全部默认禁用)
// 用户可在正则编辑器启用/修改/删除/新建自己的规则
// 框架只提供"机制 + 模板",内容/阈值由用户决定 — 不硬编码
// ============================================================
const DEFAULT_OUTPUT_FILTER_RULES = [
	{
		scriptName: '[模板] 最大输出长度截断',
		findRegex: '/^([\\s\\S]{20000})[\\s\\S]+$/',
		replaceString: '$1\n\n[输出超过 20000 字符,已截断]',
		placement: ['output_filter'],
		disabled: true,
		scope: 'global',
	},
	{
		scriptName: '[模板] 重复内容截断(卡循环检测)',
		findRegex: '/(.{50,}?)\\1{3,}/',
		replaceString: '$1\n\n[检测到重复输出,已截断]',
		placement: ['output_filter'],
		disabled: true,
		scope: 'global',
	},
	{
		scriptName: '[模板] 未知 XML 标签清理',
		findRegex: '/<(?!\\/?(?:p|br|div|span|a|img|b|i|u|s|em|strong|code|pre|ul|ol|li|h[1-6]|blockquote|table|tr|td|th|thead|tbody|details|summary|hr|sub|sup|video|audio|source|details)\\b)[a-zA-Z][^>]*>[\\s\\S]*?<\\/[a-zA-Z][^>]*>/g',
		replaceString: '',
		placement: ['output_filter'],
		disabled: true,
		scope: 'global',
	},
]

// [T077 per-user] 接 (username, data)：为该 user 的 store 播种 builtin 模板并写该 user 盘。
//   用户可删光 → 重启后不再自动回填（只看 _outputFilterSeeded 标记）。这是 regex 的"新用户默认态"：
//   非空规则集（3 条 disabled 模板 builtin），与 preset/worldbook 的"空默认"不同——审计判定 regex 有官方 builtin 种子。
function _seedDefaultOutputFilterRules(username, data) {
	if (data._outputFilterSeeded) return
	for (const tmpl of DEFAULT_OUTPUT_FILTER_RULES) {
		data.rules.push(createDefaultRule(tmpl))
	}
	data._outputFilterSeeded = true
	saveConfigToDisk(username, data)
}

// ============================================================
// beilu-regex 插件导出
// ============================================================

/**
 * beilu-regex 插件 — 完整 ST 风格正则脚本引擎
 *
 * 功能：
 * - 三级作用域：global（全局）、scoped（角色绑定）、preset（预设绑定）
 * - 完整 ST 字段：trimStrings、runOnEdit、substituteRegex、depth、ephemerality
 * - 测试模式：输入文本 → 实时预览输出
 * - TweakPrompt: 对发送给 AI 的消息应用正则
 * - ReplyHandler: 对 AI 回复应用正则
 * - 导入/导出 ST 兼容格式
 */
const pluginExport = {
	info,
	Load: async ({ router }) => {
		console.log('[beilu-regex] 插件加载中...')

		// [T077 per-user] 不再 Load 时全局预载（原读全局单文件到共享 pluginData=串台根因）。
		//   各 user 的 store 在其首次 GetData/SetData/TweakPrompt/ReplyHandler（getStore(username)）时惰性载入
		//   （含 builtin 种子播种 + 护栏注入）。与 T065 preset / T074 worldbook 惰性加载范式一致。

		// ---- 注册 HTTP API 端点（A2-3 同型：authenticate 补鉴权 + getUserByReq 解析身份透传 username）----
		router.get('/api/parts/plugins\\:beilu-regex/config/getdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const data = await pluginExport.interfaces.config.GetData({ username: _u })
				res.json(data)
			} catch (err) {
				console.error('[beilu-regex] GetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-regex/config/setdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const result = await pluginExport.interfaces.config.SetData(req.body, { username: _u })
				res.json(result || { success: true })
			} catch (err) {
				console.error('[beilu-regex] SetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: async () => {
		console.log('[beilu-regex] 插件卸载')
	},
	interfaces: {
		config: {
			// [T077 per-user] GetData 接 ctx.username → getStore 按用户分桶（原 () 无 user → 读共享单例 → 新用户看到别人全部规则）。
			//   verb getData 透传 context.user；HTTP getdata 透传 getUserByReq(req).username；缺失回退 _default 桶。
			GetData: async (ctx) => {
			const pluginData = getStore(ctx?.username)
			return {
				rules: pluginData.rules,
				enabled: pluginData.enabled,
				renderMode: pluginData.renderMode || 'sandbox',
				// ReDoS 护栏当前生效配置（含安全默认）。前端可据此渲染开关/上限设置。
				regexGuard: getGuardConfig(),
				// T072BC（可操作处禁硬编码）：护栏安全默认阈值单源下发（regexGuard.mjs DEFAULT_GUARD_CONFIG），
				//   前端「重置为安全默认」与回填 fallback 读此值，消除前端写死的 {1000000/60/0} 阈值副本漂移。
				regexGuardDefaults: getGuardDefaults(),
				_actions: [
					'addRule', 'removeRule', 'updateRule', 'reorder',
					'importST', 'exportRule', 'exportAll',
					'toggleAll', 'duplicateRule', 'testRule',
					'moveScope', 'batchToggle', 'removeByChar',
					'removeByPreset', 'syncPresetRegex',
					'setRenderMode', 'setGuardConfig',
				],
				_stats: {
					total: pluginData.rules.length,
					enabled: pluginData.rules.filter(r => !r.disabled).length,
					global: pluginData.rules.filter(r => r.scope === 'global').length,
					scoped: pluginData.rules.filter(r => r.scope === 'scoped').length,
					preset: pluginData.rules.filter(r => r.scope === 'preset').length,
				},
			}
			},
			// [T077 per-user] SetData 接 (data, args) → args.username 分桶（原 (data) 无 user → 写共享单例 → 覆盖别人规则）。
			//   verb setData 盖章 context.user；HTTP setdata 透传 getUserByReq(req).username；endpoints 迁移/清理 SetData(_,{username})；缺失回退 _default。
			//   全部 saveConfigToDisk(_user, pluginData) → saveConfigToDisk(_user, pluginData) 写各自 user 盘。
			SetData: async (data, args) => {
				if (!data) return
				const _user = _normUser(args?.username)
				const pluginData = getStore(_user)

				if (data._action) {
					switch (data._action) {
						case 'addRule': {
							const newRule = createDefaultRule(data.rule || {})
							pluginData.rules.push(newRule)
							saveConfigToDisk(_user, pluginData)
							return { _result: { id: newRule.id } }
						}
						case 'removeRule': {
							pluginData.rules = pluginData.rules.filter(r => r.id !== data.ruleId)
							saveConfigToDisk(_user, pluginData)
							break
						}
						case 'updateRule': {
							const idx = pluginData.rules.findIndex(r => r.id === data.rule?.id)
							if (idx !== -1) {
								pluginData.rules[idx] = { ...pluginData.rules[idx], ...data.rule }
							}
							saveConfigToDisk(_user, pluginData)
							break
						}
						case 'duplicateRule': {
							const src = pluginData.rules.find(r => r.id === data.ruleId)
							if (src) {
								const dup = { ...src, id: generateId(), scriptName: src.scriptName + ' (copy)' }
								const srcIdx = pluginData.rules.indexOf(src)
								pluginData.rules.splice(srcIdx + 1, 0, dup)
								saveConfigToDisk(_user, pluginData)
								return { _result: { id: dup.id } }
							}
							break
						}
						case 'moveScope': {
							const rule = pluginData.rules.find(r => r.id === data.ruleId)
							if (rule && data.newScope) {
								rule.scope = data.newScope
								// 联动清理/设置绑定字段
								if (data.newScope === 'global') {
									rule.boundCharName = ''
									rule.boundPresetName = ''
								} else if (data.newScope === 'scoped') {
									rule.boundCharName = data.charName || rule.boundCharName || ''
									rule.boundPresetName = ''
								} else if (data.newScope === 'preset') {
									rule.boundCharName = ''
									rule.boundPresetName = data.presetName || rule.boundPresetName || ''
								}
							}
							saveConfigToDisk(_user, pluginData)
							break
						}
						case 'importST': {
							const scope = data.scope || 'global'
							const boundCharName = data.boundCharName || ''
							const boundPresetName = data.boundPresetName || ''
							const imported = importFromSTFormat(data.scripts || [], scope, boundCharName, boundPresetName)
							pluginData.rules.push(...imported)
							saveConfigToDisk(_user, pluginData)
							console.log(`[beilu-regex] 导入 ${imported.length} 条 ST 正则脚本 (scope: ${scope}${boundCharName ? ', char: ' + boundCharName : ''}${boundPresetName ? ', preset: ' + boundPresetName : ''})`)
							return { _result: { count: imported.length } }
						}
						case 'removeByChar': {
							const charName = data.charName
							if (charName) {
								const before = pluginData.rules.length
								pluginData.rules = pluginData.rules.filter(r => r.boundCharName !== charName)
								saveConfigToDisk(_user, pluginData)
								console.log(`[beilu-regex] 已清理角色 "${charName}" 绑定的 ${before - pluginData.rules.length} 条正则规则`)
								return { _result: { removed: before - pluginData.rules.length } }
							}
							break
						}
						case 'removeByPreset': {
							const presetName = data.presetName
							if (presetName) {
								// 归一化比对（口径=normalizePresetName:168，与读侧过滤 :358 同一权威）：
								// 库里存在历史脏 boundPresetName（下划线/.json 后缀，见 :161 注释），字节 === 比对
								// 删 0 条 → 删除预设后正则残留（2026-07-22 盘上 8 条孤儿实证）。
								const _target = normalizePresetName(presetName)
								const before = pluginData.rules.length
								pluginData.rules = pluginData.rules.filter(r =>
									!(r.scope === 'preset' && normalizePresetName(r.boundPresetName) === _target)
								)
								saveConfigToDisk(_user, pluginData)
								const removed = before - pluginData.rules.length
								console.log(`[beilu-regex] 已清理预设 "${presetName}" 绑定的 ${removed} 条正则规则`)
								return { _result: { removed } }
							}
							break
						}
						case 'syncPresetRegex': {
							// 一步完成：清除旧预设正则 + 导入新预设正则
							const presetName = data.presetName
							if (!presetName) {
								console.warn('[beilu-regex] syncPresetRegex: 缺少 presetName')
								break
							}
							// 1. 清除该预设名绑定的旧正则（归一化比对，同 removeByPreset：容忍历史脏 boundPresetName）
							const _target = normalizePresetName(presetName)
							const before = pluginData.rules.length
							pluginData.rules = pluginData.rules.filter(r =>
								!(r.scope === 'preset' && normalizePresetName(r.boundPresetName) === _target)
							)
							const removed = before - pluginData.rules.length
	
							// 2. 导入新正则
							const scripts = data.scripts || []
							let imported = []
							if (scripts.length > 0) {
								imported = importFromSTFormat(scripts, 'preset', '', presetName)
								pluginData.rules.push(...imported)
							}

							saveConfigToDisk(_user, pluginData)
							console.log(`[beilu-regex] syncPresetRegex "${presetName}": 移除 ${removed} 条, 导入 ${imported.length} 条`)
							return { _result: { removed, imported: imported.length } }
						}
						case 'exportRule': {
							const rule = pluginData.rules.find(r => r.id === data.ruleId)
							if (rule) {
								return { _result: exportToSTFormat(rule) }
							}
							break
						}
						case 'exportAll': {
							const scope = data.scope || null
							const toExport = scope
								? pluginData.rules.filter(r => r.scope === scope)
								: pluginData.rules
							return { _result: toExport.map(exportToSTFormat) }
						}
						case 'testRule': {
							const result = await testRule(data.input || '', data.rule || {}, data.macroValues || {})
							return { _result: result }
						}
						case 'toggleAll': {
							pluginData.enabled = !!data.enabled
							saveConfigToDisk(_user, pluginData)
							break
						}
						case 'setRenderMode': {
							if (data.renderMode === 'sandbox' || data.renderMode === 'free') {
								pluginData.renderMode = data.renderMode
								saveConfigToDisk(_user, pluginData)
								console.log(`[beilu-regex] 渲染模式已切换为: ${data.renderMode}`)
							}
							break
						}
						case 'setGuardConfig': {
							// 更新 ReDoS 护栏配置（开关 / 长度上限 / 复杂度上限）。
							// 只接收已知字段，缺省字段在护栏侧兜安全默认。
							const g = data.regexGuard || {}
							const patch = {}
							if (typeof g.enabled === 'boolean') patch.enabled = g.enabled
							if (Number.isFinite(g.maxInputLength) && g.maxInputLength > 0) patch.maxInputLength = g.maxInputLength
							if (Number.isFinite(g.maxQuantifiers) && g.maxQuantifiers > 0) patch.maxQuantifiers = g.maxQuantifiers
							if (Number.isFinite(g.maxNestedQuantifierDepth) && g.maxNestedQuantifierDepth >= 0) patch.maxNestedQuantifierDepth = g.maxNestedQuantifierDepth
							pluginData.regexGuard = { ...(pluginData.regexGuard || {}), ...patch }
							configureGuard(pluginData.regexGuard)
							saveConfigToDisk(_user, pluginData)
							console.log('[beilu-regex] ReDoS 护栏配置已更新:', JSON.stringify(getGuardConfig()))
							return { _result: getGuardConfig() }
						}
						case 'batchToggle': {
							if (Array.isArray(data.ruleIds)) {
								for (const id of data.ruleIds) {
									const r = pluginData.rules.find(x => x.id === id)
									if (r) r.disabled = !!data.disabled
								}
							}
							saveConfigToDisk(_user, pluginData)
							break
						}
						case 'reorder': {
							if (Array.isArray(data.order)) {
								const reordered = []
								for (const id of data.order) {
									const rule = pluginData.rules.find(r => r.id === id)
									if (rule) reordered.push(rule)
								}
								for (const rule of pluginData.rules) {
									if (!data.order.includes(rule.id)) reordered.push(rule)
								}
								pluginData.rules = reordered
							}
							saveConfigToDisk(_user, pluginData)
							break
						}
						default:
							break
					}
					return
				}

				// 直接覆盖数据
				if (data.rules !== undefined) pluginData.rules = data.rules
				if (data.enabled !== undefined) pluginData.enabled = data.enabled
				if (data.regexGuard && typeof data.regexGuard === 'object') {
					pluginData.regexGuard = data.regexGuard
					configureGuard(pluginData.regexGuard)
				}
				saveConfigToDisk(_user, pluginData)
			},
		},
		chat: {
			/**
			 * TweakPrompt(dl=0) — 对发送给 AI 的提示词应用正则。
			 *
			 * 链路：prompt_struct.mjs 三轮 TweakPrompt → dl=0 本函数
			 *       → chatLog 倒序遍历：user 消息走 'user_input' placement
			 *       → plugin_prompts 遍历：走 'world_info' placement
			 * 影响：直接修改 prompt_struct.chat_log 条目的 content（副本上操作，不污染存储）
			 * 约束：内置剥思维链走 stripReasoningTags（hide 单源，「思维链显示」设置控制），非用户规则——不受 pluginData.rules 控制
			 */
			TweakPrompt: async (arg, prompt_struct, my_prompt, detail_level) => {
				// [T077 per-user] username 权威=arg.username（主链盖章）→ prompt_struct.username 兜底（与既有 _stripUsername 口径同源）。
				//   缺失回退 _default 桶。getStore 惰性载该 user 规则，全程按此 user 的 pluginData 应用正则，不串台。
				const _twUser = arg?.username || prompt_struct?.username
				const pluginData = getStore(_twUser)
				if (!pluginData.enabled) return
				if (detail_level !== 0) return

				// 构建宏替换值
				const macroValues = {}
				const currentCharName = prompt_struct?.Charname || ''
				const currentCharId = prompt_struct?.char_id || '' // 目录名(口径主键,对齐 write/display/delete 路径)

				// 获取当前预设名（从 beilu-preset 的 extension 中读取）
				let currentPresetName = ''
				const presetPrompt = prompt_struct?.plugin_prompts?.['beilu-preset']
				if (presetPrompt?.extension?.preset_name) {
					currentPresetName = presetPrompt.extension.preset_name
				}

				if (prompt_struct) {
					if (prompt_struct.Charname) macroValues.char = prompt_struct.Charname
					if (prompt_struct.UserCharname) macroValues.user = prompt_struct.UserCharname
				}

				// 遍历聊天记录应用正则
				// 注意：在副本上操作，避免污染原始存储数据
				const chatLog = prompt_struct?.chat_log
				if (chatLog && Array.isArray(chatLog)) {
					for (let i = chatLog.length - 1; i >= 0; i--) {
						const entry = chatLog[i]
						if (!entry || !entry.content) continue

						const depth = chatLog.length - 1 - i
						let content = entry.content

						// 0716 单源回归：内置+自定义标签剥离走 stripReasoningTags（hide 单源，
						// 受「思维链显示」设置 reasoning_builtin/reasoning_tags 控制）；
						// applyRegexRules('reasoning') 只跑用户在正则编辑器自建的 reasoning 规则。
						if (entry.role === 'char' || entry.role === 'assistant') {
							content = stripReasoningTags(content, _twUser)
							content = await applyRegexRules(
								content,
								pluginData.rules,
								'reasoning',
								{ messageDepth: depth, macroValues, currentCharId, currentCharName, currentPresetName }
							)
							content = content.replace(/\n{3,}/g, '\n\n').trim()
						}

						if (entry.role === 'user') {
							// [2026-08-01 W1 接线 runOnEdit] 编辑过的消息传 isEdit=true →
							//   applyRegexRules:377 跳过 runOnEdit=false 的规则（只让标记了"编辑时也跑"的规则生效）。
							//   编辑标记来源=chatOps editMessage:508 给条目打的 _editVersion（>0 即编辑过）。
							const _isEdited = !!(entry._editVersion || entry.extension?._editVersion)
							content = await applyRegexRules(
								content,
								pluginData.rules,
								'user_input',
								{ messageDepth: depth, macroValues, currentCharId, currentCharName, currentPresetName, isEdit: _isEdited }
							)
						}

						// 只有实际变化时才写回（写回到 prompt_struct 的副本上，不影响存储）
						if (content !== entry.content) {
							entry.content = content
						}
					}
				}

				// 对插件 prompts 应用 world_info 正则
				if (prompt_struct?.plugin_prompts) {
					for (const [key, pp] of Object.entries(prompt_struct.plugin_prompts)) {
						if (pp?.text && Array.isArray(pp.text)) {
							for (const t of pp.text) {
								if (t?.content) {
									t.content = await applyRegexRules(
											t.content,
											pluginData.rules,
											'world_info',
											{ macroValues, currentCharId, currentCharName, currentPresetName }
										)
								}
							}
						}
					}
				}
			},

			/**
			 * ReplyHandler — 对 AI 回复应用 ai_output + output_filter 正则。
			 *
			 * 链路：replyHandler.mjs 插件链 → 本函数
			 *       → reply.content 走 'ai_output' placement（outputPhase=true → promptOnly 规则被跳过）
			 *       → reply.content_for_show 走 'output_filter' placement（SEC-G：_stripAllTags 之后的最终裁剪）
			 * 影响：直接修改 reply.content 和 reply.content_for_show
			 *
			 * @returns {boolean} false — 不触发重新生成
			 */
			ReplyHandler: async (reply, args) => {
				const _cid = args?.chatid || args?.chat_name?.replace('common_chat_', '') || null
				wbT(_cid, 'regex', 'ReplyHandler:enter', {})
				// [T077 per-user] username 权威=args.username（replyHandler.mjs:518 框架参数契约 { username, char_id, chatid, ... }）。
				//   缺失回退 _default 桶。getStore 按此 user 取规则，A 的 ai_output/output_filter 正则不作用于 B 的回复。
				const pluginData = getStore(args?.username)
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const macroValues = {}
				const currentCharName = args?.prompt_struct?.Charname || ''
				const currentCharId = args?.prompt_struct?.char_id || '' // 目录名(口径主键,对齐 write/display/delete 路径)

				// 获取当前预设名
				let currentPresetName = ''
				const presetPrompt = args?.prompt_struct?.plugin_prompts?.['beilu-preset']
				if (presetPrompt?.extension?.preset_name) {
					currentPresetName = presetPrompt.extension.preset_name
				}

				if (args?.prompt_struct) {
					if (args.prompt_struct.Charname) macroValues.char = args.prompt_struct.Charname
					if (args.prompt_struct.UserCharname) macroValues.user = args.prompt_struct.UserCharname
				}

				const _aoBefore = (reply.content || '').length
				reply.content = await applyRegexRules(
					reply.content,
					pluginData.rules,
					'ai_output',
					{ messageDepth: 0, macroValues, currentCharId, currentCharName, currentPresetName, outputPhase: true }
				)
				wbT(_cid, 'regex', 'rewrite:ai_output', { beforeLen: _aoBefore, afterLen: (reply.content || '').length })

				// SEC-G: output_filter placement — 在 _stripAllTags 之后作用于最终显示内容
				// 用户可在正则编辑器创建规则,默认 3 条模板全部 disabled,完全由用户决定
				if (reply.content_for_show) {
					const _ofBefore = (reply.content_for_show || '').length
					reply.content_for_show = await applyRegexRules(
						reply.content_for_show,
						pluginData.rules,
						'output_filter',
						{ messageDepth: 0, macroValues, currentCharId, currentCharName, currentPresetName, outputPhase: true }
					)
					wbT(_cid, 'regex', 'rewrite:output_filter', { beforeLen: _ofBefore, afterLen: (reply.content_for_show || '').length })
				}

				wbT(_cid, 'regex', 'ReplyHandler:exit', {})
				return false
			},
		},
	},
}

export default pluginExport

// 单一权威源导出：ST regex_scripts → beilu 规则的转换逻辑（含 placement 数字/布尔映射、
// scope/boundCharName 写入）。供 beilu-home 角色卡导入路径在「插件未加载到 parts_set」时
// 直接落盘迁移复用，避免另写一份 placement 映射副本（与本文件 importST/usage 同一口径）。
export { importFromSTFormat }

// 导出 applyRegexRules + getStore 供独立多轮入口（aiRunner/replyHandler 分身）跑用户自建的
// reasoning placement 规则（0716 起内置剥离不在 rules 里——调用方先 stripReasoningTags 再跑用户规则）。
// applyRegexRules 本身是纯函数（接收 rules 数组），getStore 惰性取该 user 的规则集。
export { applyRegexRules, getStore as getRegexStore }
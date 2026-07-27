/**
 * regexGuard — 后端 ReDoS / 灾难性回溯护栏（单一权威源，仅后端 Deno 侧使用）
 *
 * 背景与根因：
 *   用户 / 角色卡可控的正则（findRegex）经 `new RegExp(用户串)` 编译后，在主回复管线里
 *   以同步 `text.replace(regexObj, ...)` 作用于任意长度输入。原生 V8 RegExp 是回溯引擎，
 *   形如 `/(a+)+$/` 的嵌套量词 + 长输入会触发指数级灾难性回溯（ReDoS），同步阻塞冻结
 *   主线程（实测原生 28 个 'a' 已耗时 24.6 秒）。用户串不可信，必须挡。
 *
 * 框架级解法（不打补丁，不在每条规则里加 if）：
 *   把"编译 + 替换"这对动作收敛到本模块。优先用 **RE2（线性时间引擎，无回溯）** 编译执行；
 *   RE2 不支持的特性（backreference / lookahead / 部分 lookbehind / sticky）编译会抛
 *   RE2JSSyntaxException → 回退原生引擎，但回退路径加 **静态复杂度预检（star-height ≤ 1 +
 *   量词数上限）+ 输入长度上限** 双重护栏，命中即跳过该规则并 console 告警。
 *
 * 语义保持：RE2JS 的 replacer 回调签名 (match, p1, p2, ..., offset, string, namedGroups)
 *   与原生 String.prototype.replace 回调逐字一致 —— 因此与 regexCore 的
 *   computeReplacement / extractCaptureGroups / extractNamedGroups 完全兼容，只换引擎不改语义。
 *
 * 约束：本模块依赖 npm:re2js（Deno npm 兼容，纯 JS，已实测可用），故只能在后端 Deno 进程使用，
 *   **禁止被前端 / regexCore.mjs（纯函数共享层）引用**。
 *   ★ 静态复杂度预检 _staticComplexityOk 已下沉到 regexCore.assessRegexComplexity（纯函数、
 *     浏览器安全），本模块改为薄委托——前端 displayRegex/regexEditor/tavernHelper 与本后端
 *     护栏共用同一份启发式（与后端同闸），消灭副本漂移。本模块仍独占 RE2 主防线（Deno only）。
 *   （订正旧注释：前端显示侧的 findRegex 来自可导入的角色卡/ST 正则脚本，并非纯 owner 本地可信，
 *     确在 ReDoS 攻击面——前端护栏由 regexCore 静态预检 + 长度上限承担。）
 */

import { assessRegexComplexity } from '../../../../public/parts/shells/beilu-chat/public/src/shared/regex-core/regexCore.mjs' // T3a·3.4: 前端共享 regexCore 留原位

// 惰性加载 re2js：失败（极端环境无网/无缓存）时不崩，退化为"纯原生 + 预检 + 长度上限"。
let _RE2JS = null
let _re2State = 'pending' // 'pending' | 'ready' | 'unavailable'
let _re2LoadPromise = null

async function _ensureRE2() {
	if (_re2State !== 'pending') return _RE2JS
	if (!_re2LoadPromise) {
		_re2LoadPromise = import('npm:re2js')
			.then(m => {
				_RE2JS = m.RE2JS || m.default?.RE2JS || m.default
				if (_RE2JS && typeof _RE2JS.compile === 'function') {
					_re2State = 'ready'
				} else {
					_re2State = 'unavailable'
					console.warn('[beilu-regex][guard] re2js 导入成功但 RE2JS.compile 不可用，退化为原生+预检')
				}
				return _RE2JS
			})
			.catch(e => {
				_re2State = 'unavailable'
				console.warn('[beilu-regex][guard] re2js 加载失败，退化为原生+预检:', e?.message)
				return null
			})
	}
	return _re2LoadPromise
}

// 进程启动即尝试预热（不 await，失败静默），让首条规则到来时大概率已 ready。
_ensureRE2()

// ============================================================
// 默认护栏配置（安全默认全开；可被插件 config 覆盖）
// ============================================================
// why（T072BC·可操作处禁硬编码）：此常量是 ReDoS 守卫默认阈值的唯一权威源。
//   前端 regexEditor「重置默认」按钮与回填 fallback 原各写死一份 {1000000/60/0} 副本，
//   后端调整安全默认（如收紧 maxQuantifiers）后前端「重置」会回旧值 = 前后端漂移。
//   故 export 本常量 + getGuardDefaults()，经 main.mjs GetData 附 regexGuardDefaults 下发前端，
//   前端重置/兜底读下发默认（退化保静态兜底），消除阈值副本漂移。
export const DEFAULT_GUARD_CONFIG = {
	enabled: true,           // 总开关：关闭则完全退回原生 text.replace（旧行为，仅供调试）
	maxInputLength: 1000000, // 单次替换输入字符上限（仅作用于"回退原生"路径；RE2 线性无需此限，但仍兜底）
	maxQuantifiers: 60,      // 回退原生路径：量词节点数上限（safe-regex 默认 25，此处放宽以减少误杀合法长正则）
	// 回退原生路径：嵌套量词深度上限。0 = 不允许任何"量词作用于内含量词的分组"
	// （即 /(a+)+/ 这类真实 star-height≥2 的灾难性回溯结构），这是 ReDoS 的核心特征。
	// 提高到 1 可放宽（允许一层嵌套），但安全默认取 0 = 一律拒绝嵌套量词回退执行。
	maxNestedQuantifierDepth: 0,
	// SEC-R4：RE2 拒绝某模式（含 backreference/lookahead/lookbehind 等 RE2 不支持特性）时，
	//   这些特性正是回溯高危类，且静态预检对 (a|a)+ 等重叠交替不完备（红方坐实绕过）。
	//   安全默认【不回退原生执行】(skip 该规则)——结构性消除回溯类，不靠补全预检。
	//   owner 明知风险可置 true 恢复"RE2 拒绝→原生+预检"旧行为。
	allowNativeFallbackOnRe2Reject: false,
}

let _config = { ...DEFAULT_GUARD_CONFIG }

/**
 * 由插件在加载 / SetData 时注入护栏配置（浅合并，缺省字段保留安全默认）。
 * @param {Partial<typeof DEFAULT_GUARD_CONFIG>} cfg
 */
export function configureGuard(cfg) {
	if (!cfg || typeof cfg !== 'object') return
	_config = { ...DEFAULT_GUARD_CONFIG, ...cfg }
}

/** @returns {typeof DEFAULT_GUARD_CONFIG} 当前生效护栏配置（含默认值） */
export function getGuardConfig() {
	return { ...DEFAULT_GUARD_CONFIG, ..._config }
}

/**
 * @returns {typeof DEFAULT_GUARD_CONFIG} 安全默认阈值克隆（不含用户覆盖）。
 * 供前端「重置为安全默认」与回填 fallback 读取——阈值默认单一权威在此，前端不再写死副本。
 */
export function getGuardDefaults() {
	return { ...DEFAULT_GUARD_CONFIG }
}

// ============================================================
// /pattern/flags 解析（与 regexCore.parseRegexFromString 同口径，避免双源漂移）
// 返回 { pattern, flags } 或 null（纯字符串走 catch 分支 → pattern=原串, flags='g'）
// ============================================================
function _parseSlashRegex(input) {
	if (!input) return null
	const m = input.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!m) return { pattern: input, flags: 'g', bare: true } // 非 /.../ 格式 → 当裸串，默认全局（与 regexCore 一致）
	let [, pattern, flags] = m
	pattern = pattern.replaceAll('\\/', '/')
	return { pattern, flags, bare: false }
}

// ============================================================
// 回退原生路径的静态复杂度预检 —— 薄委托到 regexCore.assessRegexComplexity（前后端单一权威）。
// 仅在 RE2 不支持该正则、被迫回退原生引擎时启用 —— RE2 路径本身线性，无需预检。
// 阈值取 getGuardConfig()（owner 可覆盖 maxQuantifiers/maxNestedQuantifierDepth）；
// 启发式实现（star-height + 量词计数 + 交替分组）已下沉 regexCore，前端三处共用同一份。
// ============================================================
function _staticComplexityOk(pattern) {
	return assessRegexComplexity(pattern, getGuardConfig())
}

// ============================================================
// 原生 flags → RE2JS 编译 flag 位映射
// g（全局）不是 RE2 编译 flag，由 replaceAll / replaceFirst 决定，单独返回。
// y（sticky）/ 某些 u 边界 RE2 无对应语义 → 标记 unsupportedFlag，强制回退原生（保语义）。
// ============================================================
function _mapFlagsToRE2(flags, RE2JS) {
	let bits = 0
	let global = false
	let unsupportedFlag = false
	for (const f of flags) {
		switch (f) {
			case 'g': global = true; break
			case 'i': bits |= RE2JS.CASE_INSENSITIVE; break
			case 'm': bits |= RE2JS.MULTILINE; break
			case 's': bits |= RE2JS.DOTALL; break
			case 'u': break // RE2 默认按 Unicode 码点处理；多数情况兼容，u 不单独置位
			case 'y': unsupportedFlag = true; break // sticky 无 RE2 等价语义
			default: break
		}
	}
	return { bits, global, unsupportedFlag }
}

/**
 * 护栏化编译 + 执行一次替换。语义等价于 `text.replace(parseRegexFromString(findStr), replacerFn)`，
 * 但用 RE2 线性引擎执行（不支持时安全回退原生）。replacerFn 的回调签名与原生 replace 一致。
 *
 * @param {string} text - 输入文本
 * @param {string} findStr - 用户正则字符串（/pattern/flags 或裸串）
 * @param {(match: string, ...args: any[]) => string} replacerFn - 与原生 String.replace 同签名的回调
 * @param {object} [opts]
 * @param {(stage: string, message: string, data: object) => void} [opts.onError] - 编译/护栏遥测回调
 * @returns {Promise<{ text: string, engine: 're2'|'native'|'native-bare', skipped: boolean, reason?: string }>}
 */
export async function guardedReplace(text, findStr, replacerFn, opts = {}) {
	const onError = typeof opts.onError === 'function' ? opts.onError : null
	if (typeof text !== 'string' || !findStr) return { text, engine: 'native', skipped: false }

	const cfg = getGuardConfig()

	// 护栏总开关关闭 → 完全旧行为（原生 replace），仅供调试，安全默认不会走到这。
	if (!cfg.enabled) {
		const parsed = _parseSlashRegex(findStr)
		if (!parsed) return { text, engine: 'native', skipped: false }
		let re
		try { re = new RegExp(parsed.pattern, parsed.bare ? 'g' : parsed.flags) }
		catch (e) { onError && onError('guard.disabled.compile', e?.message, { findStr }); return { text, engine: 'native', skipped: true, reason: 'compile_fail' } }
		return { text: text.replace(re, replacerFn), engine: 'native', skipped: false }
	}

	const parsed = _parseSlashRegex(findStr)
	if (!parsed) return { text, engine: 'native', skipped: false }

	const RE2JS = await _ensureRE2()

	// ---- 首选：RE2 线性引擎 ----
	let re2Rejected = false // RE2 可用但拒绝了本模式（不支持特性）—— 该模式属回溯高危类
	if (_re2State === 'ready' && RE2JS) {
		const { bits, global, unsupportedFlag } = _mapFlagsToRE2(parsed.flags, RE2JS)
		if (!unsupportedFlag) {
			try {
				const p = RE2JS.compile(parsed.pattern, bits)
				const matcher = p.matcher(text)
				// RE2JS replacer 回调签名与原生 replace 一致 → 直接复用 replacerFn
				const out = global
					? matcher.replaceAll(replacerFn)
					: matcher.replaceFirst(replacerFn)
				return { text: out, engine: 're2', skipped: false }
			} catch (e) {
				// RE2 不支持该特性（backreference / lookahead / lookbehind 等）→ 落回退路径
				re2Rejected = true
				onError && onError('guard.re2.unsupported', e?.message, { pattern: parsed.pattern.slice(0, 120) })
			}
		} else {
			re2Rejected = true
			onError && onError('guard.re2.unsupportedFlag', `flags=${parsed.flags}`, { flags: parsed.flags })
		}
	}

	// SEC-R4：RE2 可用却拒绝本模式 = 该模式用了 RE2 不支持的回溯高危特性。安全默认【不跑原生】
	//   （结构性消除灾难性回溯，不依赖不完备的静态预检）。owner 置 allowNativeFallbackOnRe2Reject=true 才回退。
	if (re2Rejected && !cfg.allowNativeFallbackOnRe2Reject) {
		console.warn(`[beilu-regex][guard] RE2 拒绝该模式(含回溯高危特性)，安全默认跳过不回退原生: ${findStr.slice(0, 80)}`)
		onError && onError('guard.re2reject.skip', 'RE2 rejected; native fallback disabled', { findStr: findStr.slice(0, 120) })
		return { text, engine: 'native', skipped: true, reason: 're2_rejected_no_native_fallback' }
	}

	// ---- 回退：原生引擎 + 静态复杂度预检 + 输入长度上限 ----
	// 复杂度预检：嵌套量词 / 量词过多 → 拒绝执行该规则（跳过），避免灾难性回溯冻结主线程。
	const complexity = _staticComplexityOk(parsed.pattern)
	if (!complexity.ok) {
		console.warn(`[beilu-regex][guard] 跳过高危正则(回退原生路径, ${complexity.reason}): ${findStr.slice(0, 80)}`)
		onError && onError('guard.native.complexity_block', complexity.reason, { findStr: findStr.slice(0, 120) })
		return { text, engine: 'native', skipped: true, reason: complexity.reason }
	}
	// 输入长度上限：即便正则星高合规，超长输入 + 中度回溯也可能卡顿 → 截断为兜底。
	if (text.length > cfg.maxInputLength) {
		console.warn(`[beilu-regex][guard] 输入超长(${text.length}>${cfg.maxInputLength})，回退原生路径跳过该规则: ${findStr.slice(0, 60)}`)
		onError && onError('guard.native.input_too_long', `len=${text.length}`, { findStr: findStr.slice(0, 80) })
		return { text, engine: 'native', skipped: true, reason: 'input_too_long' }
	}

	let re
	try {
		re = new RegExp(parsed.pattern, parsed.bare ? 'g' : parsed.flags)
	} catch (e) {
		onError && onError('guard.native.compile_fail', e?.message, { findStr: findStr.slice(0, 120) })
		return { text, engine: 'native', skipped: true, reason: 'compile_fail' }
	}
	return { text: text.replace(re, replacerFn), engine: 'native', skipped: false }
}

/**
 * guardedReplace 的同步版本。语义与 async 版完全一致，但不 await _ensureRE2。
 *
 * 链路：ST 导入引擎等同步上下文 → 本函数 → RE2(若已 ready) / 原生+预检+长度上限
 * 约束：RE2 必须在已 ready 时才走 RE2，否则同步只能走"原生 + 预检 + 长度上限"。
 *       因 _ensureRE2 已在模块加载即预热，稳定运行后通常 ready。
 *
 * @param {string} text - 输入文本
 * @param {string} findStr - 用户正则字符串
 * @param {(match: string, ...args: any[]) => string} replacerFn - 替换回调
 * @param {object} [opts]
 * @returns {{ text: string, engine: string, skipped: boolean, reason?: string }}
 */
export function guardedReplaceSync(text, findStr, replacerFn, opts = {}) {
	const onError = typeof opts.onError === 'function' ? opts.onError : null
	if (typeof text !== 'string' || !findStr) return { text, engine: 'native', skipped: false }
	const cfg = getGuardConfig()
	const parsed = _parseSlashRegex(findStr)
	if (!parsed) return { text, engine: 'native', skipped: false }

	let re2Rejected = false // RE2 可用但拒绝本模式（不支持特性）= 回溯高危类
	if (cfg.enabled && _re2State === 'ready' && _RE2JS) {
		const { bits, global, unsupportedFlag } = _mapFlagsToRE2(parsed.flags, _RE2JS)
		if (!unsupportedFlag) {
			try {
				const p = _RE2JS.compile(parsed.pattern, bits)
				const matcher = p.matcher(text)
				const out = global ? matcher.replaceAll(replacerFn) : matcher.replaceFirst(replacerFn)
				return { text: out, engine: 're2', skipped: false }
			} catch (e) {
				re2Rejected = true
				onError && onError('guard.re2.unsupported.sync', e?.message, { pattern: parsed.pattern.slice(0, 120) })
			}
		} else {
			re2Rejected = true
			onError && onError('guard.re2.unsupportedFlag.sync', `flags=${parsed.flags}`, { flags: parsed.flags })
		}
	}

	// SEC-R4：RE2 拒绝本模式（回溯高危特性）→ 安全默认不回退原生（与 async 同策略）。
	if (cfg.enabled && re2Rejected && !cfg.allowNativeFallbackOnRe2Reject) {
		console.warn(`[beilu-regex][guard][sync] RE2 拒绝该模式，安全默认跳过不回退原生: ${findStr.slice(0, 80)}`)
		onError && onError('guard.re2reject.skip.sync', 'RE2 rejected; native fallback disabled', { findStr: findStr.slice(0, 120) })
		return { text, engine: 'native', skipped: true, reason: 're2_rejected_no_native_fallback' }
	}

	// 回退原生（带护栏）
	if (cfg.enabled) {
		const complexity = _staticComplexityOk(parsed.pattern)
		if (!complexity.ok) {
			console.warn(`[beilu-regex][guard][sync] 跳过高危正则(${complexity.reason}): ${findStr.slice(0, 80)}`)
			onError && onError('guard.native.complexity_block.sync', complexity.reason, { findStr: findStr.slice(0, 120) })
			return { text, engine: 'native', skipped: true, reason: complexity.reason }
		}
		if (text.length > cfg.maxInputLength) {
			console.warn(`[beilu-regex][guard][sync] 输入超长(${text.length})，跳过: ${findStr.slice(0, 60)}`)
			onError && onError('guard.native.input_too_long.sync', `len=${text.length}`, { findStr: findStr.slice(0, 80) })
			return { text, engine: 'native', skipped: true, reason: 'input_too_long' }
		}
	}
	let re
	try { re = new RegExp(parsed.pattern, parsed.bare ? 'g' : parsed.flags) }
	catch (e) { onError && onError('guard.native.compile_fail.sync', e?.message, { findStr: findStr.slice(0, 120) }); return { text, engine: 'native', skipped: true, reason: 'compile_fail' } }
	return { text: text.replace(re, replacerFn), engine: 'native', skipped: false }
}

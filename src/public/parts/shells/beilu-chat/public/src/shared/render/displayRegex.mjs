/**
 * displayRegex.mjs — 消息显示层正则处理器
 *
 * 功能链：
 *   refreshDisplayRules → GET beilu-regex getdata → 拉取 markdownOnly=true 的正则规则列表 → 缓存
 *   applyDisplayRules(rawText) → 按顺序执行：
 *     ① 内置处理器（BUILTIN_PROCESSORS）：
 *        codeFold：把代码块折叠（localStorage 开关控制，all/frontend 两种模式）
 *        （思维链折叠不在此处：extractThinkingContent 剥离正文 → messageList/StreamRenderer 渲染独立 .thinking-toggle 组件）
 *     ② 用户自定义 markdownOnly 规则：protectJsonSegments → parseRegexFromString → computeReplacement
 *        → restoreProtectedSegments（保护 JSON 不被正则破坏）
 *   activateScripts(container) → 手动 clone 并执行替换后注入的 <script> 标签
 *   wbDetect/wbTrace → 正则执行异常上报白盒通道
 *
 * why（只影响显示层）：
 *   markdownOnly 规则仅在渲染时变换文本，不修改存储的消息内容或发送给 AI 的提示词；
 *   替换后的 HTML 被 markdown 渲染器保留（unified/remark 默认保留内嵌 HTML），
 *   因此可以安全注入 <details>/<button> 等 HTML 结构增强显示体验。
 *   protectJsonSegments 防止正则替换破坏消息中的 JSON 数据（工具调用结果等）。
 *   assessRegexComplexity 护栏防止 ReDoS 攻击（复杂度超阈值的规则跳过执行）。
 *
 * 关联链：
 *   → shared/regex-core/regexCore.mjs（parseRegexFromString / computeReplacement / protectJson* / assessRegexComplexity 权威实现）
 *   → shared/transport/sendAction.mjs（T6b批7：拉取 beilu-regex 规则列表，plugins:beilu-regex#getData）
 *   → shared/state/storage.mjs（思维链标签/折叠标题文案配置、codeFold 开关从 localStorage 读取）
 *   → shared/widgets/whitebox.mjs wbDetect/wbTrace（异常上报）
 *   ← messageList.mjs（消息渲染前调用 applyDisplayRules，渲染后调用 activateScripts）
 *   ← regexEditor.mjs（保存规则后调用 refreshDisplayRules 让新规则立刻生效）
 *
 * 影响范围：
 *   消息渲染 DOM（<details>/<button> 等结构注入）；仅影响显示不影响存储/AI 输入；
 *   BEILU_THINKING_TAGS / BEILU_THINKING_FOLD_LABEL / BEILU_CODE_FOLD_ENABLED / BEILU_CODE_FOLD_MODE localStorage 读取。
 *
 * 使用效果：
 *   AI 输出包含 <thinking> 标签 → 正文剥离，折叠块标题文案可在设置(API 区块下方)自定义；
 *   开启代码折叠后长代码块变为可展开条；用户自定义正则在每条消息渲染时自动生效。
 */

import { createDiag } from '../state/diagLogger.mjs'
import { escapeHtml } from '../state/utils.mjs'
import { sendAction } from '../transport/sendAction.mjs' // T6b批7：出向统一门面（verb=真动作），原 apiFetch beilu-regex getdata 收口
import { wbTrace, wbDetect } from '../widgets/whitebox.mjs'
import { parseRegexFromString, computeReplacement, extractCaptureGroups, protectJsonSegments, restoreProtectedSegments, assessRegexComplexity, REGEX_MAX_INPUT_LENGTH } from '../regex-core/regexCore.mjs'
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { renderAirpDSL } from './airpRenderer.mjs' // AIRP 符号 DSL → styled HTML（纯函数，capabilities 由本文件异步缓存 cachedAirpCaps 传入）
const diag = createDiag('displayRegex')

// ============================================================
// 内置处理器（不依赖 beilu-regex 插件）
// ============================================================

/**
 * 思维链折叠块标题文案（用户可配置，凛倾 2026-07-12：进对话 UI 的文本须可配置，代码只持默认值）。
 * 单源 = localStorage['beilu-thinking-fold-label']，缺省用默认文案。
 * 消费方：messageList 渲染 .thinking-toggle-label（textContent 注入，无 XSS 面）；
 * 设置入口：设置 → AI 服务源(api) 区块下方（settingsSlots.initApiSlot 装配）。
 * @returns {string}
 */
export const THINKING_FOLD_LABEL_DEFAULT = '思考了一会'
export function getThinkingFoldLabel() {
	try {
		const stored = storage.get(KEYS.BEILU_THINKING_FOLD_LABEL)
		if (stored && stored.trim()) return stored.trim()
	} catch { /* ignore */ }
	return THINKING_FOLD_LABEL_DEFAULT
}

/**
 * 内置显示处理器配置
 * 在自定义正则规则之前运行，处理通用的显示需求
 * （原 thinkingFold 处理器（patterns/template）为死配置已删——思维链折叠真实链路
 *   = extractThinkingContent 剥离正文 + messageList/StreamRenderer 渲染独立 .thinking-toggle 组件）
 */
const BUILTIN_PROCESSORS = {
	codeFold: {
		get enabled() { return getCodeFoldEnabled() },
		get mode() { return getCodeFoldMode() },
	},
}

/**
 * 读取代码折叠是否启用
 * @returns {boolean}
 */
function getCodeFoldEnabled() {
	try {
		return storage.get(KEYS.BEILU_CODE_FOLD_ENABLED) === 'true'
	} catch { return false }
}

/**
 * 读取代码折叠模式
 * @returns {'all'|'frontend'}
 */
function getCodeFoldMode() {
	try {
		return storage.get(KEYS.BEILU_CODE_FOLD_MODE) || 'frontend'
	} catch { return 'frontend' }
}

// ============================================================
// AIRP 能力谱缓存（照 cachedDisplayRules 范式：异步拉后端谱 + TTL 缓存，applyBuiltinProcessors 同步读）
// ============================================================
// why 异步缓存 + 同步读：applyBuiltinProcessors 是同步纯字符串处理器（无 DOM、无 await），
//   而 airp 配色/标签集/动态效果谱要异步从后端 plugins:beilu-airp 拉——故预加载缓存、同步读缓存。
//   缓存为 null（首帧未加载/后端未就绪）→ renderAirpDSL 不被调用 → airp DSL 原样留存，下一帧缓存到齐后渲染（优雅降级，非报错）。
// 单源：airp 能力谱唯一来源=后端 GetData 返回的 capabilities（出厂谱 ← data 全局 ← per-user 深merge），前端零默认副本。

/** @type {object|null} 缓存的 airp 能力谱（renderAirpDSL 消费：palette/tagSpec/dynEffects/layout/fallback） */
let cachedAirpCaps = null

/** @type {Array<{type:string,data:object,order:number}>} 渲染块（P0 只有 type:'state'；P1 起消费） */
let cachedAirpBlocks = []

/** @type {number} airp 谱缓存时间戳 */
let _airpCacheTimestamp = 0

/** @type {Promise|null} airp 谱正在进行的加载 Promise（防并发重复拉取） */
let _airpLoadingPromise = null

/**
 * 异步拉取 airp 能力谱并缓存（照 _doLoadDisplayRules 拉 plugins:beilu-regex 的范式，改拉 plugins:beilu-airp）。
 * 挂在 chat.mjs 的 loadDisplayRules 预加载点一并调用（步②-b），使 applyBuiltinProcessors 同步读时缓存已就位。
 * @returns {Promise<object|null>} 能力谱（enabled=false 或失败时为 null → applyBuiltinProcessors 降级不渲染 airp）
 */
export async function loadAirpCaps() {
	if (cachedAirpCaps !== null && Date.now() - _airpCacheTimestamp < CACHE_TTL) {
		return cachedAirpCaps
	}
	if (_airpLoadingPromise) return _airpLoadingPromise
	_airpLoadingPromise = _doLoadAirpCaps()
	try {
		return await _airpLoadingPromise
	} finally {
		_airpLoadingPromise = null
	}
}

/**
 * 实际拉取逻辑。
 * @returns {Promise<object|null>}
 */
async function _doLoadAirpCaps() {
	try {
		// [框架 v6 §十一章4] 改走 shell 渲染期端点：一次拉取得 {caps, blocks}。
		//   原 target=plugins:beilu-airp 在 sendAction 无注册路由（fail loud throw）→ caps 永 null → airp 永不渲染；
		//   走 shells:chat#getAirpView 后端点侧 loadPart→interfaces.chat.GetRenderView（与世界书 render 相同款挂法）。
		const data = await sendAction({
			verb: "getAirpView", target: "shells:chat", source: "web",
			scope: { chatId: window._beiluGetChatId?.() || "" },
			payload: { charId: window._beiluGetCharId?.() || "" },
		})
		// caps=null（插件未装/enabled=false）→ 不渲染 airp（applyBuiltinProcessors 早退），诚实降级
		if (!data || !data.caps || typeof data.caps !== 'object') {
			cachedAirpCaps = null
			cachedAirpBlocks = []
			_airpCacheTimestamp = Date.now()
			return cachedAirpCaps
		}
		cachedAirpCaps = data.caps
		cachedAirpBlocks = Array.isArray(data.blocks) ? data.blocks : []
		_airpCacheTimestamp = Date.now()
		return cachedAirpCaps
	} catch (err) {
		console.warn('[displayRegex] 加载 airp 能力谱失败:', err)
		wbDetect('displayRegex', 'loadAirpCaps', false, err?.message, { stack: err?.stack })
		cachedAirpCaps = null
		cachedAirpBlocks = []  // 与成功路径对称：caps/blocks 同源同拉，失败时一并清（防两键不同步）
		_airpCacheTimestamp = Date.now()
		return cachedAirpCaps
	}
}

/**
 * 强制刷新 airp 谱缓存（用户在设置面板改 airp 配置后调用，同 refreshDisplayRules 语义）。
 * @returns {Promise<object|null>}
 */
export async function refreshAirpCaps() {
	cachedAirpCaps = null
	cachedAirpBlocks = []
	_airpCacheTimestamp = 0
	return loadAirpCaps()
}

// isThinkingFoldEnabled 已删（0720 硬化）：凛倾硬性核心「人类必须看得到」——
//   开关关=完全隐藏思维链违反原则,messageList 折叠块改恒渲染,开关/写点/存储键同批删除。

/**
 * 判断渲染器是否启用
 * @returns {boolean}
 */
export function isRendererEnabled() {
	try {
		const val = storage.get(KEYS.BEILU_RENDERER_ENABLED)
		return val !== 'false' // 默认启用
	} catch { return true }
}

/**
 * 判断是否允许在主页面激活外来 <script>（F-D5 XSS 防护）。
 *
 * 安全默认：禁用（false）。角色卡/AI 输出注入的 <script> 不应在主页面执行——
 * 含脚本的内容会改走 iframe 沙箱渲染（detectContentType→script-fragment→iframe）。
 * owner 可在设置里显式开启 beilu-script-activation='true' 恢复旧行为（高风险）。
 *
 * @returns {boolean} 是否允许主页面脚本激活。
 */
export function isScriptActivationAllowed() {
	try {
		return storage.get(KEYS.BEILU_SCRIPT_ACTIVATION) === 'true' // 默认禁用
	} catch { return false }
}

/**
 * 获取渲染深度设置
 * @returns {number} 0=全部渲染
 */
export function getRenderDepth() {
	try {
		return parseInt(storage.get(KEYS.BEILU_RENDER_DEPTH) || '0', 10) || 0
	} catch { return 0 }
}

/**
 * 前端可渲染的代码块语言标识
 */
const FRONTEND_LANGS = new Set(['html', 'htm', 'css', 'javascript', 'js', 'vue', 'svg', 'xml'])

/**
 * 获取用户配置的思维链标签名列表（纯字符串）
 * @returns {string[]} 标签名数组，如 ['thinking', 'think']
 */
function getThinkingTagList() {
	const defaultTags = 'thinking,think'
	let tags = defaultTags
	try {
		const stored = storage.get(KEYS.BEILU_THINKING_TAGS)
		if (stored && stored.trim()) tags = stored.trim()
	} catch { /* ignore */ }
	// [0720 硬化] ①内置 thinking/think 恒在集合（凛倾硬性核心,存量脏镜像也被兜住）
	//   ②过滤放宽为非空（原 /^[\w-]+$/ 静默丢中文等非 ASCII 标签=自定义标签「加了没效」断点）,
	//   正则安全由 extractThinkingContent 构造处 escape 保证。
	const names = tags.split(',').map(t => t.trim()).filter(t => t.length > 0)
	return [...new Set(['thinking', 'think', ...names])]
}

/**
 * 保护 Markdown 代码段，避免其中的 <thinking>/<think> 字面量被当成真实标签提取。
 *
 * 保护顺序：
 * 1. fenced code block
 * 2. inline code span
 *
 * @param {string} text
 * @returns {{ text: string, restore: (value: string) => string }}
 */
function protectMarkdownCodeSegments(text) {
	if (!text || typeof text !== 'string') {
		return {
			text: text || '',
			restore: value => value || '',
		}
	}

	const placeholders = []
	const stash = segment => {
		const token = `@@BEILU_CODE_${placeholders.length}@@`
		placeholders.push({ token, segment })
		return token
	}

	let protectedText = text
	protectedText = protectedText.replace(/```[\s\S]*?```/g, stash)
	protectedText = protectedText.replace(/`[^`\n]*`/g, stash)

	return {
		text: protectedText,
		restore(value) {
			let restored = value || ''
			for (const { token, segment } of placeholders) {
				restored = restored.replaceAll(token, segment)
			}
			return restored
		},
	}
}

/**
 * 从文本中提取思维链内容并返回清理后的正文
 *
 * 将 <think>/<thinking> 标签内容从消息正文中剥离，
 * 供调用方将思维链渲染到独立的 UI 组件中，而非嵌入消息气泡。
 *
 * @param {string} text - 原始消息文本
 * @returns {{ cleanText: string, thinkingText: string, isComplete: boolean }}
 *   - cleanText: 剥离思维链后的正文
 *   - thinkingText: 思维链内容（纯文本，多段用换行拼接）
 *   - isComplete: 所有思维链标签是否已闭合（false = 流式中间状态）
 */
export function extractThinkingContent(text) {
	if (!text || typeof text !== 'string') return { cleanText: text || '', thinkingText: '', isComplete: true }

	const strippedText = stripOuterCodeFence(text)
	const { text: protectedText, restore } = protectMarkdownCodeSegments(strippedText)

	const tags = getThinkingTagList()
	// [0720] 标签名 escape 后再拼正则：过滤已放宽到任意非空名（含中文）,防特殊字符破正则
	const _esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const openAlt = tags.map(t => `<${_esc(t)}>`).join('|')
	const closeAlt = tags.map(t => `<\\/${_esc(t)}>`).join('|')

	let workingText = protectedText
	let thinkingText = ''
	let isComplete = true

	// ── 循环剥离直到收敛（问题4根因修）──
	// why: 单次 Step1+Step2 对「嵌套同名标签」剥不净——closedPattern 非贪婪停在第一个闭合标签,
	//   内层若含同名开标签,剥完外层后内层残留 → cleanText 裸露 thinking 内容(如 [上下文回顾] 小节)。
	//   现象: 同一 thinking 上半进折叠块 + 下半裸文本重复渲染。
	// 改法: Step1(闭合对)+Step2(未闭合) 包进循环,每轮剥完检测 workingText 是否还有 thinking 开标签,
	//   有则再剥一轮,直到无残留或到 MAX_ITERATIONS 上限。thinkingText 累积,末尾统一 restore。
	// 影响面: extractThinkingContent 单函数内,返回格式 cleanText/thinkingText/isComplete 不变,
	//   3 个消费方(messageList/StreamRenderer)解构依赖此格式,不受影响。
	const MAX_ITERATIONS = 5 // 安全上限防无限循环(嵌套深度极限)
	const openDetect = new RegExp(`(?:${openAlt})`, 'i') // 残留检测:是否还有 thinking 开标签

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		let strippedThisRound = false

		// Step 1: 提取所有已闭合的标签对（允许交叉闭合,如 开thinking 到 闭think）
		const closedPattern = new RegExp(`(?:${openAlt})([\\s\\S]*?)(?:${closeAlt})`, 'gi')
		let match
		while ((match = closedPattern.exec(workingText)) !== null) {
			if (thinkingText) thinkingText += '\n'
			thinkingText += match[1].trim()
			strippedThisRound = true
		}
		if (strippedThisRound) workingText = workingText.replace(closedPattern, '')

		// Step 2: 处理未闭合的标签（流式中间状态 — 贪婪匹配到末尾）
		const unclosedPattern = new RegExp(`(?:${openAlt})([\\s\\S]*)$`, 'i')
		const unclosedMatch = workingText.match(unclosedPattern)
		if (unclosedMatch) {
			if (thinkingText) thinkingText += '\n'
			thinkingText += unclosedMatch[1].trim()
			workingText = workingText.replace(unclosedPattern, '')
			isComplete = false
			strippedThisRound = true
		}

		// 收敛检测: workingText 还有 thinking 开标签(嵌套内层)则再剥一轮,否则收敛退出
		if (!strippedThisRound || !openDetect.test(workingText)) break
	}

	// 根因修:thinkingText 从 protectMarkdownCodeSegments 打码后的 workingText 提取,
	//   含占位符。restore 幂等(replaceAll token,全局唯一,多段拼接不碰撞),整体 restore 正确。
	//   消费方 messageList/StreamRenderer 用 textContent 展示(无 XSS 面)。
	thinkingText = restore(thinkingText)
	wbTrace('displayRegex', 'extractThinkingContent', { inLen: text?.length, thinkingLen: thinkingText?.length, isComplete })
	return { cleanText: restore(workingText).trim(), thinkingText, isComplete }
}

/**
 * 应用内置显示处理器
 * 当前支持：思维链折叠（<thinking>/<think> → 可折叠区域）
 *
 * @param {string} content - 原始消息内容
 * @returns {string} 处理后的内容
 */
export function applyBuiltinProcessors(content) {
	if (!content || typeof content !== 'string') return content

	// 1. 代码围栏剥离 — 兼容美化正则作者在 AI 输出头尾加 ``` 的做法
	content = stripOuterCodeFence(content)

	// 2. 思维链折叠 — ★ 已移到 extractThinkingContent()，不再在此处处理
	// 思维链现在由调用方（messageList / StreamRenderer）提取到独立 UI 组件

	// 3. 代码折叠
	const codeFoldCfg = BUILTIN_PROCESSORS.codeFold
	if (codeFoldCfg.enabled) {
		content = applyCodeFold(content, codeFoldCfg.mode)
	}

	// 4. AIRP 符号 DSL 渲染（Additive）——同步读缓存的能力谱，null 时 renderAirpDSL 内部无 scene 早退/此处跳过，均不影响非 airp 消息。
	//   缓存来源：loadAirpCaps()（chat.mjs 预加载点调用）。谱=后端 plugins:beilu-airp 单源，前端零默认副本。
	if (cachedAirpCaps) {
		content = renderAirpDSL(content, cachedAirpCaps)
	}

	// 5. era 指令防御剥离——后端 ReplyHandler 已剥主路径，此处兜历史楼层/手编原文残留（无标签零成本早退）

	wbTrace('displayRegex', 'applyBuiltinProcessors', { outLen: content?.length, codeFold: codeFoldCfg.enabled, airp: !!cachedAirpCaps })
	return content
}

/**
	* 代码折叠处理器
	*
	* 将 ```lang ... ``` 代码块折叠为 <details> 元素
	* - 'all' 模式：折叠所有代码块
	* - 'frontend' 模式：仅折叠 html/css/js 等前端代码块
	*
	* @param {string} content - 内容
	* @param {'all'|'frontend'} mode - 折叠模式
	* @returns {string} 处理后的内容
	*/
function applyCodeFold(content, mode) {
	// 匹配 ```lang\n...\n``` 代码块
	return content.replace(/```(\w*)\s*\n([\s\S]*?)```/g, (match, lang, code) => {
		const langLower = (lang || '').toLowerCase()

		// frontend 模式：只折叠前端可渲染语言
		if (mode === 'frontend' && langLower && !FRONTEND_LANGS.has(langLower)) {
			return match // 不折叠
		}

		const displayLang = lang || '代码'
		const lineCount = code.split('\n').length
		const preview = code.trim().split('\n')[0]?.substring(0, 60) || ''
		const previewText = preview ? ` — ${preview}${preview.length >= 60 ? '...' : ''}` : ''

		return `<details class="code-fold"><summary><i data-ic="package"></i> ${displayLang} (${lineCount}行)${previewText}</summary><pre><code class="language-${langLower}">${escapeCodeHtml(code)}</code></pre></details>`
	})
}

const escapeCodeHtml = escapeHtml

/**
 * 剥离包裹整个消息的外层代码围栏
 *
 * 酒馆美化正则的作者会让 AI 在输出头尾加上 ```，
 * 这会导致 markdown 渲染器将整个内容当作代码块而非 HTML。
 * 本函数在 markdown 渲染前检测并移除这层包裹。
 *
 * 安全策略：只在内部没有行首 ``` 标记时才剥离（避免误删合法代码块）
 *
 * @param {string} content - 原始消息内容
 * @returns {string} 剥离后的内容（或原样返回）
 */
function stripOuterCodeFence(content) {
	const trimmed = content.trim()
	// 匹配: ```[lang]\n...内容...\n``` （整个消息被一个围栏包裹）
	const match = trimmed.match(/^```(\w*)\s*\n([\s\S]*)\n```\s*$/)
	if (!match) return content
	const inner = match[2]
	// 内部有行首 ``` 标记 → 消息包含多个代码块，不应剥离
	if (/^```/m.test(inner)) return content
	return inner
}

// ============================================================
// 规则缓存
// ============================================================

/** @type {Array<object>|null} 缓存的 display 规则 */
let cachedDisplayRules = null

/** @type {'sandbox'|'free'} 当前渲染模式 */
let cachedRenderMode = 'sandbox'

/** @type {Promise|null} 正在进行的加载Promise（替代loading布尔值+自旋等待） */
let _loadingPromise = null

/** @type {number} 缓存时间戳 */
let _cacheTimestamp = 0

/** @type {number} 缓存TTL（30秒后自动刷新，用户编辑正则规则后最多30秒生效） */
const CACHE_TTL = 30000

/** @type {string} 当前激活预设名（已规范化）。随 loadDisplayRules 异步预解析并缓存，applyDisplayRules 同步读取——
 *  避免在同步渲染循环里直接调 async 的 _beiluGetPresetData（其返回 Promise，当对象读会恒空导致 preset 规则被全跳过）。 */
let cachedActivePreset = ''

/** 预设名规范化：去 .json 后缀 + 折叠下划线/空白，用于 boundPresetName 与激活预设名比对（与后端 beilu-regex 同口径） */
function _normPresetName(s) {
	return s == null ? '' : String(s).replace(/\.json$/i, '').replace(/[_\s]+/g, ' ').trim()
}

/**
 * 从 beilu-regex 后端拉取规则并缓存 markdownOnly 的规则
 * @returns {Promise<Array<object>>} display 规则列表
 */
// [0725 同步断点②修·分身E对照表] 预设切换两事件 → 重解析激活预设名缓存。原两事件均不订阅,
//   切预设后 preset 作用域 display 正则不重过滤,最长滞后 30s TTL/切卡才对齐(凛倾「如果切换了,
//   其他入口的地方也要切换」的违背点)。上游已先失效预设缓存(websocket:1057/切换链),此处重拉即新值。
async function _refreshActivePresetCache() {
	try {
		const _pd = await window._beiluGetPresetData?.()
		cachedActivePreset = _normPresetName(window._beiluResolveActivePreset?.(_pd) ?? '')
	} catch { /* 解析失败保持旧值 */ }
}
window.addEventListener('beilu:presetSwitched', _refreshActivePresetCache)
window.addEventListener('beilu:preset-changed', _refreshActivePresetCache)

export async function loadDisplayRules() {
	// H2：每次调用都刷新激活预设名缓存（getCachedPresetData 自带 5s TTL，廉价）。
	//   放在规则缓存早退之前 → 启动/切卡/刷新任一路径都能让 cachedActivePreset 与当前窗口预设对齐。
	//   [0725] 实现收口 _refreshActivePresetCache 单源(事件订阅与本路径共用,防两份解析漂移)。
	await _refreshActivePresetCache()

	if (cachedDisplayRules !== null && Date.now() - _cacheTimestamp < CACHE_TTL) {
		return cachedDisplayRules
	}
	if (cachedDisplayRules !== null) {
		cachedDisplayRules = null
	}
	if (_loadingPromise) return _loadingPromise

	_loadingPromise = _doLoadDisplayRules()
	try {
		return await _loadingPromise
	} finally {
		_loadingPromise = null
	}
}

/**
 * 实际加载逻辑（内部函数）
 * @returns {Promise<Array<object>>}
 */
async function _doLoadDisplayRules() {
	try {
		// T6b批7：原 raw fetch（手检 res.ok + 自 .json()）→ sendAction 门面。!ok 由门面统一抛错走下方 catch，
		// 与原 !res.ok 分支同一降级结果（cachedDisplayRules=[]），行为等价。
		const data = await sendAction({ verb: "getData", target: "plugins:beilu-regex", source: "web" })
		if (!data.enabled || !Array.isArray(data.rules)) {
			cachedDisplayRules = []
			_cacheTimestamp = Date.now()
			return cachedDisplayRules
		}

		// 读取渲染模式
		cachedRenderMode = data.renderMode || 'sandbox'

		// 筛选：启用的 + markdownOnly 的 + placement 包含 ai_output 或 display 的
			// 兼容 ST 旧格式：placement 可能是数字数组（0=ai_output, 1=user_input, 2=slash_command/display）
			// 也可能是字符串数组 ['ai_output', 'display']
			cachedDisplayRules = data.rules.filter(rule => {
				if (rule.disabled) return false
				// W53-4A修复: beilu-regex规则没有placement字段但有markdownOnly，应允许通过
				if (!rule.placement) return !!rule.markdownOnly
				if (!rule.markdownOnly) return false
				// 检查 placement 中是否包含目标值（兼容数字和字符串）
				const hasTarget = rule.placement.some(p =>
					p === 'ai_output' || p === 'display'
					|| p === 0  // ST 数字格式: 0 = ai_output
					|| p === 2  // ST 数字格式: 2 = slash_command（在 display 上下文中也适用）
				)
				return hasTarget
			})

		_cacheTimestamp = Date.now()
		console.log(`[displayRegex] 已缓存 ${cachedDisplayRules.length} 条 display 规则, 渲染模式: ${cachedRenderMode}`)
		return cachedDisplayRules
	} catch (err) {
		console.warn('[displayRegex] 加载规则失败:', err)
		wbDetect('displayRegex', 'loadDisplayRules', false, err?.message, { stack: err?.stack })
		cachedDisplayRules = []
		_cacheTimestamp = Date.now()
		return cachedDisplayRules
	}
}

/**
 * 强制刷新规则缓存（如用户编辑了正则规则后调用）
 * @returns {Promise<Array<object>>}
 */
export async function refreshDisplayRules() {
	cachedDisplayRules = null
	return loadDisplayRules()
}

// ============================================================
// 正则应用引擎（前端版，与后端 applySingleRule 逻辑一致）
// ============================================================

/**
 * 需要占位符保护的 HTML 标签/声明
 * 这些标签如果出现在正则替换结果中，会被 markdown 渲染器破坏
 *
 * 包含：
 * - <!doctype>、<html>、<head>、<body> — 美化正则注入完整 HTML 文档时的标识
 * - 常见 block-level 标签 — div、section、article、table、form 等
 * - 媒体/嵌入标签 — canvas、svg、iframe、video、audio
 * - style/script — 样式和脚本注入
 * - pre、blockquote、details、figure — 其他 block-level 元素
 */
const COMPLEX_HTML_TAGS = /^<(?:!doctype|html|head|body|div|style|script|section|article|header|footer|nav|aside|main|table|form|canvas|svg|iframe|template|details|summary|pre|blockquote|figure|figcaption|picture|video|audio|link|meta)\b/i

// [0713 病灶审计 D1] 原此处 parseRegexFromString 私有副本（与 regexCore.mjs:43 权威版逐行同构，
//   仅错误上报硬绑 wbDetect）删除——改 import regexCore 权威版 + onError 回调接 wbDetect（见 applySingleRule）。

/**
 * 对文本应用单条正则规则（带占位符保护 + 空结果安全防护）
 *
 * 当替换结果包含 block-level HTML 标签时，用占位符替代以保护其不被 markdown 渲染器破坏。
 * 当替换结果为空字符串且原始匹配不为空时，保留原始内容（防止美化正则导致内容消失）。
 *
 * @param {string} text - 输入文本
 * @param {object} rule - 规则对象
 * @param {Map<string, string>} placeholders - 占位符映射（会被修改）
 * @returns {string} 处理后的文本
 */
function applySingleRule(text, rule, placeholders) {
	if (!text || !rule.findRegex) return text

	const regexObj = parseRegexFromString(rule.findRegex, (stage, msg, data) => wbDetect('displayRegex', stage, false, msg, data))
	if (!regexObj) return text

	// #ReDoS-FE：findRegex 来自可导入的角色卡/ST 正则脚本（非纯 owner 可信）。跑前过与后端同源的
	//   静态复杂度护栏 + 输入长度上限，命中即跳过该规则——挡灾难性回溯同步冻结浏览器主线程。
	const _safety = assessRegexComplexity(regexObj.source)
	if (!_safety.ok) {
		wbDetect('displayRegex', 'applySingleRule.unsafeRegex', false, _safety.reason, { findRegex: rule.findRegex })
		return text
	}
	if (text.length > REGEX_MAX_INPUT_LENGTH) {
		wbDetect('displayRegex', 'applySingleRule.inputTooLong', false, `len=${text.length}>${REGEX_MAX_INPUT_LENGTH}`, {})
		return text
	}

	const replaceStr = rule.replaceString || ''
	const trimList = rule.trimStrings
		? (Array.isArray(rule.trimStrings) ? rule.trimStrings : rule.trimStrings.split('\n')).filter(s => s.length > 0)
		: []

	text = text.replace(regexObj, (match, ...args) => {
		// String.prototype.replace 回调的 args 结构:
		// [group1, group2, ..., offset(number), fullString(string), namedGroups?(object)]
		// 需要剥离末尾的 offset/fullString/namedGroups，只保留真正的捕获组
		const groups = extractCaptureGroups(args)
		const _lastArg = args.length > 0 ? args[args.length - 1] : null
		const _namedGroups = (typeof _lastArg === 'object' && _lastArg !== null && !Array.isArray(_lastArg)) ? _lastArg : null

		let result = computeReplacement(replaceStr, match, groups, trimList, _namedGroups)

		// 剥离替换结果外层代码围栏
		// 酒馆美化正则（JS-Slash-Runner 等）惯例：用 ``` 包裹 HTML 文档
		result = stripOuterCodeFence(result)

		// 替换结果为空 → 直接删除匹配内容（这是合法用例，如"去除更新变量"正则）
		if (!result || result.trim() === '') {
			return ''
		}

		const trimmedResult = result.trim()

		// 完整 HTML 文档 → 直接返回，不做占位符保护
		// 让 detectContentType() 能正确识别为 'full-html' 并走 iframe/free 渲染路径
		if (/^<!doctype\s+html/i.test(trimmedResult) || /^<html[\s>]/i.test(trimmedResult)) {
			return result
		}

		// 非完整文档但包含 block-level HTML → 占位符保护，防止 markdown 渲染器破坏
		if (placeholders && COMPLEX_HTML_TAGS.test(trimmedResult)) {
			const id = placeholders.size
			const placeholder = `<beilu-ph data-id="${id}"></beilu-ph>`
			placeholders.set(placeholder, result)
			return placeholder
		}

		return result
	})

	return text
}

/**
 * 对原始消息文本应用所有 display 正则规则（含占位符保护）
 *
 * 应在 renderMarkdownAsString 之前调用。
 * 返回处理后的文本和占位符映射。markdown 渲染后需调用 restorePlaceholders() 恢复真正的 HTML。
 *
 * @param {string} rawContent - 消息的原始文本内容
 * @param {object} [options]
 * @param {number} [options.messageDepth=0] - 消息深度
 * @param {string} [options.role=''] - 消息角色（'user'/'assistant'/'system'）
 * @returns {{ text: string, placeholders: Map<string, string> }}
 */
// #75：缺省 priority 的默认值（与后端 beilu-regex DEFAULT_RULE_PRIORITY 一致），
// 全缺省时稳定排序退化为原序，向后兼容。
const DEFAULT_DISPLAY_RULE_PRIORITY = 100

/**
 * 按 priority 稳定排序（小者先）。缺省 priority 视为默认值；同优先级保持原相对顺序。
 * @param {Array} rules
 * @returns {Array} 新数组（不改原数组）
 */
function _sortDisplayRulesByPriority(rules) {
	return rules
		.map((rule, idx) => ({ rule, idx }))
		.sort((a, b) => {
			const pa = (typeof a.rule.priority === 'number') ? a.rule.priority : DEFAULT_DISPLAY_RULE_PRIORITY
			const pb = (typeof b.rule.priority === 'number') ? b.rule.priority : DEFAULT_DISPLAY_RULE_PRIORITY
			if (pa !== pb) return pa - pb
			return a.idx - b.idx
		})
		.map(x => x.rule)
}

export function applyDisplayRules(rawContent, options = {}) {
 const placeholders = new Map()

 if (storage.get(KEYS.BEILU_REGEX_ENABLED) === "false") {
 	return { text: rawContent, placeholders }
 }
 if (!cachedDisplayRules || cachedDisplayRules.length === 0) {
 	return { text: rawContent, placeholders }
 }
 if (!rawContent || typeof rawContent !== 'string') {
 	return { text: rawContent, placeholders }
 }

 const { messageDepth = 0, role = '', charName = '' } = options

 // 用户消息不应用 display regex（防止美化正则导致用户消息消失）
 if (role === 'user') {
 	return { text: rawContent, placeholders }
 }

 let text = rawContent

	// #75-①：JSON/代码段保护 — 跑 display 正则前抠出受保护段（<UpdateVariable>/
	// <JSONPatch>/<ideToolCall>/```代码块```）换占位符，跑完放回。与后端同源 regexCore。
	const { text: protectedText, segments } = protectJsonSegments(text)
	text = protectedText

	// #75-②：按 priority 稳定排序（小者先）。缺省字段 → 默认值 → 退化为原序（向后兼容）。
	const orderedRules = _sortDisplayRulesByPriority(cachedDisplayRules)

	for (const rule of orderedRules) {
		// 深度范围检查
		const minD = rule.minDepth ?? -1
		const maxD = rule.maxDepth ?? 0
		if (minD >= 0 && messageDepth < minD) continue
		if (maxD > 0 && messageDepth > maxD) continue

		// 作用域过滤：scoped 规则只应用于绑定的角色
		if (rule.scope === 'scoped' && rule.boundCharName && rule.boundCharName !== charName) {
			continue
		}

		// N9/H2：preset 规则只应用于当前激活预设。后端生成路径 beilu-regex/main.mjs:285-291 已过滤，此处补显示层同口径。
		//   读 loadDisplayRules 异步预解析好的 cachedActivePreset（同步），不在此同步循环里调 async 的 _beiluGetPresetData。
		if (rule.scope === 'preset') {
			const _rulePreset = _normPresetName(rule.boundPresetName)
			if (_rulePreset && cachedActivePreset && _rulePreset !== cachedActivePreset) continue
			if (_rulePreset && !cachedActivePreset) continue
		}

		text = applySingleRule(text, rule, placeholders)
	}

	// #75-①：放回受保护段（占位符 → 原始 JSON/代码块）
	text = restoreProtectedSegments(text, segments)

	wbTrace('displayRegex', 'applyDisplayRules', { role, ruleCount: cachedDisplayRules.length, outLen: text?.length, placeholderCount: placeholders.size })
	return { text, placeholders }
}

/**
 * 在 markdown 渲染后恢复占位符为真正的 HTML
 *
 * @param {string} html - markdown 渲染后的 HTML
 * @param {Map<string, string>} placeholders - 由 applyDisplayRules 返回的占位符映射
 * @returns {string} 恢复后的 HTML
 */
export function restorePlaceholders(html, placeholders) {
	if (!placeholders || placeholders.size === 0) return html

	for (const [placeholder, original] of placeholders) {
		// 直接替换占位符标签
		html = html.replaceAll(placeholder, original)
		// markdown 渲染器可能将占位符包裹在 <p> 中，清理空 <p> 包裹
		html = html.replaceAll(`<p>${original}</p>`, original)
	}

	return html
}

/**
 * 获取当前渲染模式
 * @returns {'sandbox'|'free'} 渲染模式
 */
export function getRenderMode() {
	return cachedRenderMode
}

// ============================================================
// 内容类型检测
// ============================================================

/**
 * 检测 display regex 处理后的内容类型
 *
 * 用于决定后续走哪条渲染路径：
 * - 'full-html'：完整 HTML 文档 → iframe 沙箱渲染，绕过 markdown
 * - 'script-fragment'：含 <script> 的 HTML 片段 → markdown + activateScripts
 * - 'markdown'：普通文本/markdown → 标准 markdown 渲染
 *
 * @param {string} text - display regex 处理后的文本
 * @returns {'full-html'|'script-fragment'|'markdown'} 内容类型
 */
export function detectContentType(text) {
	if (!text || typeof text !== 'string') return 'markdown'

	const trimmed = text.trim()

	// ★ 渲染器开关：禁用时所有内容都走 markdown
	if (!isRendererEnabled()) {
		return 'markdown'
	}

	// 类型 A：完整 HTML 文档
	// 1. 开头直接是 doctype/html
	if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
		return 'full-html'
	}
	// 2. 开头是内置处理器输出(details/div等)，剥离后再检查
	const stripped = trimmed.replace(/^(<details[^>]*>[\s\S]*?<\/details>\s*)+/i, '').trim()
	if (stripped !== trimmed && (/^<!doctype\s+html/i.test(stripped) || /^<html[\s>]/i.test(stripped))) {
		return 'full-html'
	}
	// 3. 全文兜底（0719 按旧库基线恢复，github公共仓库发送 displayRegex.mjs:672-674 原文）：
	//    完整 HTML 文档可能被思维链/说明文字等任意前置内容遮挡——上一版只剥 <details> 的收窄
	//    （怕"AI 讨论 HTML"误判）方向代价反了：假阴性=角色卡渲染整体失效（0719 凛倾实录
	//    「真正渲染全部失效」），而旧库带全文兜底期间=功能完好基线。误判顾虑留观：讨论文本
	//    含完整 doctype/<html> 标签的场景远少于真文档被前置内容遮挡的场景。
	if (/<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
		return 'full-html'
	}

	// 类型 B：HTML 片段中包含 <script> 标签（角色卡脚本）
	// 排除已被识别为完整文档的情况
	if (/<script[\s>]/i.test(trimmed)) {
		wbTrace('displayRegex', 'detectContentType', { type: 'script-fragment', len: trimmed.length })
		return 'script-fragment'
	}

	// 类型 C：普通 markdown/文本
	wbTrace('displayRegex', 'detectContentType', { type: 'markdown', len: trimmed.length })
	return 'markdown'
}

// ============================================================
// 脚本激活工具
// ============================================================

/** @type {Set<string>} 已加载的外部脚本 URL，用于跨消息去重（避免 Vue 等 CDN 重复加载） */
const loadedExternalScripts = new Set()

/**
 * 激活 DOM 元素中所有通过 innerHTML 插入的 <script> 标签
 *
 * innerHTML 插入的 script 不会自动执行，需要替换为新创建的 script 元素。
 *
 * 处理策略：
 * - 外部脚本（有 src）：异步加载并等待 onload，确保依赖库就绪后再执行后续脚本；
 *   同一 URL 跨消息只加载一次（去重）
 * - 内联脚本：用 IIFE 包裹以隔离作用域，避免重复声明错误（如 Vue createApp）
 *
 * @param {HTMLElement} container - 包含 script 标签的容器元素
 */
export async function activateScriptsInElement(container) {
	if (!container) return

	// ★ F-D5 XSS 门控：默认禁止主页面激活外来脚本。含 <script> 的内容应走 iframe 沙箱。
	//   owner 显式开 beilu-script-activation='true' 才恢复主页面激活（高风险）。
	if (!isScriptActivationAllowed()) {
		const skipped = container.querySelectorAll('script:not([data-beilu-activated])')
		if (skipped.length)
			wbDetect('displayRegex', 'activateScriptsInElement.blocked', false, '主页面脚本激活已禁用(F-D5)', { count: skipped.length })
		return
	}

	const scripts = Array.from(container.querySelectorAll('script'))

	for (const oldScript of scripts) {
		// 跳过已激活的脚本
		if (oldScript.dataset.beiluActivated) continue

		if (oldScript.src) {
			// --- 外部脚本处理 ---
			const url = oldScript.src

			// 同一个 CDN 脚本只加载一次（跨消息去重）
			if (loadedExternalScripts.has(url)) {
				oldScript.dataset.beiluActivated = '1'
				continue
			}

			// 创建新 script 元素并等待加载完成
			const newScript = document.createElement('script')
			for (const attr of oldScript.attributes) {
				newScript.setAttribute(attr.name, attr.value)
			}

			await new Promise(resolve => {
				newScript.onload = () => {
					loadedExternalScripts.add(url)
					resolve()
				}
				newScript.onerror = () => {
					console.warn('[displayRegex] 外部脚本加载失败:', url)
					resolve() // 失败不阻塞后续脚本
				}
				newScript.dataset.beiluActivated = '1'
				oldScript.replaceWith(newScript)
			})
		} else {
			// --- 内联脚本处理 ---
			const newScript = document.createElement('script')
			for (const attr of oldScript.attributes) {
				newScript.setAttribute(attr.name, attr.value)
			}
			newScript.textContent = `(function(){${oldScript.textContent}})();`
			newScript.dataset.beiluActivated = '1'
			oldScript.replaceWith(newScript)
		}
	}
}
/**
 * Display Regex 模块
 *
 * 职责：
 * - 从 beilu-regex 后端拉取 markdownOnly 规则
 * - 在消息渲染时，对原始文本应用 display 正则（在 markdown 渲染之前）
 * - 渲染后激活注入的 <script> 标签
 *
 * 设计：
 * - markdownOnly 规则仅影响显示，不修改存储的消息内容或发送给 AI 的提示词
 * - 替换后的 HTML 会被 markdown 渲染器保留（unified/remark 默认保留内嵌 HTML）
 * - 替换后的 <script> 通过 activateScripts() 手动执行
 */

// ============================================================
// ★ 调试标记：如果在控制台看到这条日志，说明新版 displayRegex.mjs 已加载
// ============================================================
import { createDiag } from './diagLogger.mjs'
const diag = createDiag('displayRegex')

console.log('%c[displayRegex] ★ v8-debug 版本已加载', 'color: #ff6600; font-weight: bold; font-size: 14px')

// ============================================================
// 内置处理器（不依赖 beilu-regex 插件）
// ============================================================

/**
 * 内置显示处理器配置
 * 在自定义正则规则之前运行，处理通用的显示需求
 */
/**
 * 从 localStorage 读取用户自定义的思维链标签列表
 * @returns {RegExp[]} 正则数组
 */
function getThinkingFoldPatterns() {
	const defaultTags = 'thinking,think'
	let tags = defaultTags
	try {
		const stored = localStorage.getItem('beilu-thinking-tags')
		if (stored && stored.trim()) tags = stored.trim()
	} catch { /* ignore */ }
	return tags.split(',')
		.map(t => t.trim())
		.filter(t => t.length > 0)
		.map(t => new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, 'gi'))
}

const BUILTIN_PROCESSORS = {
	thinkingFold: {
		enabled: true,
		get patterns() { return getThinkingFoldPatterns() },
		template: '<details class="thinking-fold"><summary>💭 我在想你的事情,不要偷看啦</summary><div class="thinking-content">$1</div></details>',
	},
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
		return localStorage.getItem('beilu-code-fold-enabled') === 'true'
	} catch { return false }
}

/**
 * 读取代码折叠模式
 * @returns {'all'|'frontend'}
 */
function getCodeFoldMode() {
	try {
		return localStorage.getItem('beilu-code-fold-mode') || 'frontend'
	} catch { return 'frontend' }
}

/**
 * 判断渲染器是否启用
 * @returns {boolean}
 */
export function isRendererEnabled() {
	try {
		const val = localStorage.getItem('beilu-renderer-enabled')
		return val !== 'false' // 默认启用
	} catch { return true }
}

/**
 * 获取渲染深度设置
 * @returns {number} 0=全部渲染
 */
export function getRenderDepth() {
	try {
		return parseInt(localStorage.getItem('beilu-render-depth') || '0', 10) || 0
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
		const stored = localStorage.getItem('beilu-thinking-tags')
		if (stored && stored.trim()) tags = stored.trim()
	} catch { /* ignore */ }
	return tags.split(',').map(t => t.trim()).filter(t => t.length > 0)
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

	let cleanText = stripOuterCodeFence(text)
	let thinkingText = ''
	let isComplete = true

	const tags = getThinkingTagList()

	for (const tag of tags) {
		// Step 1: 提取所有已闭合的标签对（非贪婪匹配）
		const closedPattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')
		let match
		while ((match = closedPattern.exec(cleanText)) !== null) {
			if (thinkingText) thinkingText += '\n'
			thinkingText += match[1].trim()
		}
		cleanText = cleanText.replace(closedPattern, '')

		// Step 2: 处理未闭合的标签（流式中间状态 — 贪婪匹配到末尾）
		const unclosedPattern = new RegExp(`<${tag}>([\\s\\S]*)$`, 'i')
		const unclosedMatch = cleanText.match(unclosedPattern)
		if (unclosedMatch) {
			if (thinkingText) thinkingText += '\n'
			thinkingText += unclosedMatch[1].trim()
			cleanText = cleanText.replace(unclosedPattern, '')
			isComplete = false
		}
	}

	return { cleanText: cleanText.trim(), thinkingText, isComplete }
}

/**
 * 流式输出专用的思维链折叠处理
 *
 * ★ 已废弃：保留导出签名以兼容旧调用，内部改为使用 extractThinkingContent。
 * 新代码应直接使用 extractThinkingContent()。
 *
 * @deprecated 使用 extractThinkingContent() 代替
 * @param {string} content - 流式输出的当前内容
 * @returns {string} 处理后的内容（剥离思维链后的正文）
 */
export function applyStreamingThinkFold(content) {
	const { cleanText } = extractThinkingContent(content)
	return cleanText
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

		return `<details class="code-fold"><summary>📦 ${displayLang} (${lineCount}行)${previewText}</summary><pre><code class="language-${langLower}">${escapeCodeHtml(code)}</code></pre></details>`
	})
}

/**
	* 转义代码内容中的 HTML 特殊字符
	* @param {string} str
	* @returns {string}
	*/
function escapeCodeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

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

/** @type {boolean} 是否正在加载 */
let loading = false

/**
 * 从 beilu-regex 后端拉取规则并缓存 markdownOnly 的规则
 * @returns {Promise<Array<object>>} display 规则列表
 */
export async function loadDisplayRules() {
	if (cachedDisplayRules !== null) return cachedDisplayRules
	if (loading) {
		// 等待正在进行的加载完成
		while (loading) await new Promise(r => setTimeout(r, 50))
		return cachedDisplayRules || []
	}

	loading = true
	try {
		const res = await fetch('/api/parts/plugins:beilu-regex/config/getdata')
		if (!res.ok) {
			console.warn('[displayRegex] 获取正则规则失败:', res.status)
			cachedDisplayRules = []
			return cachedDisplayRules
		}

		const data = await res.json()
		if (!data.enabled || !Array.isArray(data.rules)) {
			cachedDisplayRules = []
			return cachedDisplayRules
		}

		// 读取渲染模式
		cachedRenderMode = data.renderMode || 'sandbox'

		// 筛选：启用的 + markdownOnly 的 + placement 包含 ai_output 或 display 的
			// 兼容 ST 旧格式：placement 可能是数字数组（0=ai_output, 1=user_input, 2=slash_command/display）
			// 也可能是字符串数组 ['ai_output', 'display']
			cachedDisplayRules = data.rules.filter(rule => {
				if (rule.disabled || !rule.markdownOnly || !rule.placement) return false
				// 检查 placement 中是否包含目标值（兼容数字和字符串）
				const hasTarget = rule.placement.some(p =>
					p === 'ai_output' || p === 'display'
					|| p === 0  // ST 数字格式: 0 = ai_output
					|| p === 2  // ST 数字格式: 2 = slash_command（在 display 上下文中也适用）
				)
				return hasTarget
			})

		console.log(`[displayRegex] 已缓存 ${cachedDisplayRules.length} 条 display 规则, 渲染模式: ${cachedRenderMode}`)
		return cachedDisplayRules
	} catch (err) {
		console.warn('[displayRegex] 加载规则失败:', err)
		cachedDisplayRules = []
		return cachedDisplayRules
	} finally {
		loading = false
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

/**
 * 从斜杠分隔的正则字符串解析为 RegExp 对象
 * @param {string} input - 形如 /pattern/flags 的正则字符串
 * @returns {RegExp|null}
 */
function parseRegexFromString(input) {
	if (!input) return null
	const match = input.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!match) {
		try { return new RegExp(input, 'g') } catch { return null }
	}
	let [, pattern, flags] = match
	pattern = pattern.replaceAll('\\/', '/')
	try { return new RegExp(pattern, flags) } catch { return null }
}

/**
 * 计算正则替换结果
 *
 * 与酒馆 runRegexScript 行为对齐：
 * - 使用正则 /\$(\d+)|\$<([^>]+)>/g 精确匹配 $N 和 $<name>
 * - 不使用 replaceAll 的字符串替换模式（避免 $$/$&/$`/$' 被特殊解释）
 * - 未匹配的捕获组返回空字符串
 *
 * @param {string} replaceStr - 替换字符串模板
 * @param {string} match - 匹配文本
 * @param {Array} groups - 捕获组
 * @param {string[]} trimList - 需要修剪的字符串列表
 * @returns {string} 替换结果
 */
function computeReplacement(replaceStr, match, groups, trimList) {
	let target = match
	if (trimList.length > 0) {
		for (const trim of trimList) {
			target = target.replaceAll(trim, '')
		}
	}

	// Step 1: 将 {{match}} 转换为 $0（与酒馆一致）
	let result = replaceStr.replace(/\{\{match\}\}/gi, '$0')

	// Step 2: 使用正则精确匹配 $N 和 $<name>，与酒馆 runRegexScript 行为对齐
	// 酒馆原版使用 replaceAll(/\$(\d+)|\$<([^>]+)>/g, callback)
	// 这里用回调函数模式，避免 replacement 参数中 $$ $& $` $' 被特殊解释
	result = result.replace(/\$(\d+)|\$<([^>]+)>/g, (_placeholder, num, _groupName) => {
		let value
		if (num !== undefined) {
			const idx = Number(num)
			if (idx === 0) {
				value = target  // $0 = 完整匹配（经过 trimList 处理）
			} else {
				value = groups[idx - 1]  // $1 = groups[0], $2 = groups[1], ...
			}
		}
		// 命名捕获组暂不支持（beilu 的 extractCaptureGroups 不提取命名组）

		if (value === undefined || value === null) {
			return ''  // 与酒馆一致：未匹配的捕获组返回空字符串
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

	const regexObj = parseRegexFromString(rule.findRegex)
	if (!regexObj) return text

	const replaceStr = rule.replaceString || ''
	const trimList = rule.trimStrings
		? rule.trimStrings.split('\n').filter(s => s.length > 0)
		: []

	text = text.replace(regexObj, (match, ...args) => {
		// String.prototype.replace 回调的 args 结构:
		// [group1, group2, ..., offset(number), fullString(string), namedGroups?(object)]
		// 需要剥离末尾的 offset/fullString/namedGroups，只保留真正的捕获组
		const groups = extractCaptureGroups(args)

		let result = computeReplacement(replaceStr, match, groups, trimList)

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
 * 从 String.prototype.replace 回调的 ...args 中提取纯捕获组
 *
 * replace(regex, (match, ...args) => {}) 中 args 的结构：
 *   [group1, group2, ..., offset, inputString, namedGroups?]
 * offset 是 number，inputString 是 string — 我们需要在此处截断
 *
 * @param {Array} args - replace 回调中 match 后的所有参数
 * @returns {Array} 只包含捕获组的数组
 */
function extractCaptureGroups(args) {
	// 从后向前检查：namedGroups (object|undefined), inputString (string), offset (number)
	// 最保险的方式：找到第一个 number 类型的参数作为 offset 的位置
	for (let i = 0; i < args.length; i++) {
		if (typeof args[i] === 'number') {
			return args.slice(0, i)
		}
	}
	return args
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
export function applyDisplayRules(rawContent, options = {}) {
 const placeholders = new Map()

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

	for (const rule of cachedDisplayRules) {
		// 深度范围检查
		const minD = rule.minDepth ?? -1
		const maxD = rule.maxDepth ?? 0
		if (minD >= 0 && messageDepth < minD) continue
		if (maxD > 0 && messageDepth > maxD) continue

		// 作用域过滤：scoped 规则只应用于绑定的角色
		if (rule.scope === 'scoped' && rule.boundCharName && rule.boundCharName !== charName) {
			continue
		}

		text = applySingleRule(text, rule, placeholders)
	}

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
	// ★ 修复：不仅检查开头，也检查全文是否包含完整 HTML 文档标记
	// 原因：思维链折叠等内置处理器可能在文档前插入 <details> 等标签，
	// 导致 <!doctype html 不在开头而无法被识别
	if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
		return 'full-html'
	}
	// 检查全文中是否包含完整 HTML 文档（可能被思维链折叠等前置内容遮挡）
	if (/<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
		return 'full-html'
	}

	// 类型 B：HTML 片段中包含 <script> 标签（角色卡脚本）
	// 排除已被识别为完整文档的情况
	if (/<script[\s>]/i.test(trimmed)) {
		return 'script-fragment'
	}

	// 类型 C：普通 markdown/文本
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
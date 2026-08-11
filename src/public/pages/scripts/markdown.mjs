import { createDocumentFragmentFromHtmlStringNoScriptActivation, activateScripts } from './template.mjs'

// 根因修（2026-08-08 "每次对话都 Markdown Load Error"）：原实现是模块顶层
//   `const { GetMarkdownConvertor } = await import('./markdownConvertor.mjs').catch(兜底)`——
//   在页面加载那一刻只 import 一次，一旦当时 esm 依赖图有瞬时抽风（esm.sh/CDN 某个子模块 fetch 失败），
//   import reject → GetMarkdownConvertor 被永久绑定成"只吐错误 HTML 的兜底桩"，整个标签页会话不再恢复，
//   之后每条消息（messageList/StreamRenderer/sidebar 共用同一 singleton）全渲染成 Markdown Load Error。
// 改为惰性 + 失败可重试：真正的 import 延后到首次需要转换器时；只在拿到真模块后才缓存 Promise，
//   失败则清空缓存，下次调用重新尝试——一瞬间的加载抽风不再拖死整会话。
let _convertorModulePromise = null

/**
 * 惰性加载 markdownConvertor 模块并返回其 GetMarkdownConvertor。
 * 成功后缓存 import Promise；失败清空缓存并抛出（下次调用重新 import），
 * 由上层缓存点决定"只缓存成功、失败走不缓存的临时兜底"——避免把兜底焊进任何一层单例。
 * @returns {Promise<(opts?: object) => Promise<any>>} GetMarkdownConvertor 函数。
 */
async function _loadGetMarkdownConvertor() {
	_convertorModulePromise ??= import('./markdownConvertor.mjs')
	try {
		const mod = await _convertorModulePromise
		return mod.GetMarkdownConvertor
	} catch (error) {
		// 失败不焊死：清空缓存，下次调用重新 import（等 esm 图恢复即自愈）
		_convertorModulePromise = null
		throw error
	}
}

/**
 * 错误兜底转换器（本次调用用，绝不缓存）——底层模块加载失败时，让调用方拿到可渲染的错误 HTML
 * 而不是抛异常拖垮整条渲染链。下一次调用会重新尝试真加载。
 * @param {Error} error - 加载失败的错误。
 * @returns {{process: (function(object): string), processSync: (function(object): string)}} 兜底转换器。
 */
function _fallbackConvertor(error) {
	/**
	 * 处理 Markdown 内容（错误兜底）。
	 * @param {{value: string, data: object}} content 要处理的对象。
	 * @returns {string} 返回处理后的 HTML 字符串。
	 */
	const func = content => /* html */ `\
<h1>Markdown Load Error: ${error.name}</h1>
<pre><code>
${error.stack || error.message || error}
</code></pre>

<br/>

<pre><code>
${content.value}
</code></pre>
`
	return { process: func, processSync: func }
}

/**
 * 获取 Markdown 转换器（惰性加载底层模块）。加载失败时抛出——由缓存层捕获后走不缓存的临时兜底。
 * @param {object} [options={}] - 透传给 GetMarkdownConvertor 的选项。
 * @returns {Promise<any>} - Markdown 转换器实例。
 */
async function GetMarkdownConvertor(options = {}) {
	const factory = await _loadGetMarkdownConvertor()
	return factory(options)
}

// ★ F-D5：净化(非可信)与可信两套转换器分别缓存，避免单例混用导致漏净化/误净化。
let convertor, trustedConvertor, standaloneConvertor

/**
 * 强制预加载独立 Markdown 转换器，用于需要同步渲染的情况。
 * @returns {Promise<import('npm:unified').Processor>} 返回一个 Promise，解析为独立的 Markdown 转换器实例。
 */
export async function getStandaloneConvertor() {
	if (standaloneConvertor) return standaloneConvertor
	try { return standaloneConvertor = await GetMarkdownConvertor({ isStandalone: true }) }
	catch (error) { return _fallbackConvertor(error) } // 失败不缓存，下次重试
}
/**
 * 强制预加载 Markdown 转换器，用于需要同步渲染的情况。
 * @param {boolean} [trusted=false] - 是否可信源(true 跳过 XSS 净化)。
 * @returns {Promise<import('npm:unified').Processor>} 返回一个 Promise，解析为 Markdown 转换器实例。
 */
export async function getConvertor(trusted = false) {
	// 只缓存成功加载的转换器；加载失败返回不缓存的临时兜底，下次调用自动重试（避免把兜底焊进单例）
	if (trusted) {
		if (trustedConvertor) return trustedConvertor
		try { return trustedConvertor = await GetMarkdownConvertor({ trusted: true }) }
		catch (error) { return _fallbackConvertor(error) }
	}
	if (convertor) return convertor
	try { return convertor = await GetMarkdownConvertor() }
	catch (error) { return _fallbackConvertor(error) }
}

/**
 * 将 Markdown 渲染为字符串。
 * @param {string} markdown - Markdown 文本。
 * @param {object} [cache] - 缓存对象。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.trusted=false] - 是否可信源。AI 输出/角色卡/世界书/网页内容
 *   一律 false(默认，走 XSS 净化)；仅系统自渲染 UI 等可信内容可传 true 跳过净化。
 * @returns {Promise<string>} - 渲染后的 HTML 字符串。
 */
export async function renderMarkdownAsString(markdown, cache, { trusted = false } = {}) {
	const conv = await getConvertor(trusted)
	const file = await conv.process({ value: markdown, data: { cache } })
	return String(file)
}

/**
 * 将 Markdown 渲染为 DOM 元素（不激活脚本）。
 * @param {string} markdown - Markdown 文本。
 * @param {object} [cache] - 缓存对象。
 * @param {object} [options] - 选项（{trusted}，默认 false 走净化）。
 * @returns {Promise<DocumentFragment>} - 渲染后的 DOM 片段（脚本未激活）。
 */
export async function renderMarkdownNoScriptActivation(markdown, cache, options) {
	return createDocumentFragmentFromHtmlStringNoScriptActivation(await renderMarkdownAsString(markdown, cache, options))
}

/**
 * 将 Markdown 渲染为 DOM 元素（并激活脚本）。
 * @param {string} markdown - Markdown 文本。
 * @param {object} [cache] - 缓存对象。
 * @param {object} [options] - 选项（{trusted}，默认 false 走净化）。
 * @returns {Promise<DocumentFragment>} - 渲染后的 DOM 片段。
 */
export async function renderMarkdown(markdown, cache, options) {
	const fragment = await renderMarkdownNoScriptActivation(markdown, cache, options)
	return activateScripts(fragment)
}

/**
 * 将 Markdown 渲染为独立的 HTML 字符串。
 * @param {string} markdown - Markdown 文本。
 * @param {object} [cache] - 缓存对象。
 * @returns {Promise<string>} - 渲染后的 HTML 字符串。
 */
export async function renderMarkdownAsStandAloneHtmlString(markdown, cache) {
	const conv = await getStandaloneConvertor() // 复用统一的"成功才缓存/失败临时兜底"逻辑
	const file = await conv.process({ value: markdown, data: { cache } })
	return String(file)
}

/**
 * 将 Markdown 同步渲染为独立的 HTML 字符串。
 * @param {string} markdown - Markdown 文本。
 * @param {object} [cache] - 缓存对象。
 * @returns {string} - 渲染后的 HTML 字符串。
 */
export function renderMarkdownAsStandAloneHtmlStringSync(markdown, cache) {
	if (!standaloneConvertor) throw new Error('Standalone markdown convertor not initialized')
	const file = standaloneConvertor.processSync({ value: markdown, data: { cache } })
	return String(file)
}

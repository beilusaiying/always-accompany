import { safeFetch } from '../security/safe_fetch.mjs'
import { authenticate } from '../security/auth.mjs' // config REST 端点鉴权（范式同 memory/main.mjs）

import info from '../../../../public/parts/plugins/beilu-web/info.json' with { type: 'json' } // T3a·3.8: part 元数据留原位
import { wbT, wbD } from "../../../../server/wbStub.mjs";
import { probeCrawlCapability, ensureBrowsers } from "./crawlProbe.mjs";
import { getInjectText } from "../injectTexts/main.mjs"; // 注入文本单源（铁律：进 messages 的文本用户可配置，默认值在 injectTexts CATALOG）

// ============================================================
// 搜索结果格式
// ============================================================

/**
 * @typedef {Object} SearchResult
 * @property {string} title - 标题
 * @property {string} url - URL
 * @property {string} snippet - 摘要
 */

/**
 * @typedef {Object} WebSearchRecord
 * @property {string} id - 搜索 ID
 * @property {string} query - 搜索词
 * @property {SearchResult[]} results - 搜索结果
 * @property {number} timestamp - 时间戳
 * @property {string} status - 状态
 */

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

// ============================================================
// 搜索引擎适配器
// ============================================================

/**
 * 联网搜索（委托同目录 webSearch.mjs:executeWebSearch 单一权威，见下方惰性加载）。
 * 原 `/api/services/search` 死路由已弃用、不再 fetch；<search>/<browse> 经委托真实可用。
 * @param {string} query - 搜索词
 * @param {Object} options - 选项
 * @returns {Promise<SearchResult[]>}
 */
// === K1 联网套件委托（惰性加载同目录 webSearch.mjs，失败安全）===
// 凛倾 2026-06-10：联网套件单一权威（现位 yonban/core/functions/web/webSearch.mjs）。
// beilu-web 有 UI 消费（config 面板 manualSearch + <search>/<browse> 标签），
// 故 searchViaBeilu 委托调 executeWebSearch（当壳），不再走死路由 /api/services/search。
let _wsMod = null, _wsInit = false;
function _wsEnsure() {
	if (_wsInit) return;
	_wsInit = true;
	import(new URL('./webSearch.mjs', import.meta.url).href)
		.then(m => { _wsMod = m; })
		.catch(e => { console.warn('[beilu-web] 联网套件 webSearch.mjs 加载失败:', e && e.message); });
}

// [0717 直搜配置断链修] <search> 直搜链原来只组 {max_results} 喂 executeWebSearch——用户在
// 联网设置面板配的 engine/proxy_url/timeout_ms/browsers_path/noise 词表/域名黑白名单/domain_cap
// 对直搜标签全部无效（同一功能面双配置现实）。按 chat 上下文取 per-char web_search 配置铺底：
// char 归位=显式 char_id 优先，无则 chatid→chatMetadatas.primaryCharName（_resolveChatOwner 同款
// 跨 part 动态 import 范式），失败回 _global（与 memory 域读法同源）。失败安全：取不到=空底（行为同旧）。
async function _perCharWebSearchConfig(args, cid) {
	try {
		const { loadMemoryData } = await import('../memory/storage_mod/storage.mjs')
		let _char = args?.char_id || args?.charName || null
		if (!_char && cid) {
			try {
				const { getChatMetadatas } = await import('../../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs')
				_char = getChatMetadatas().get(cid)?.primaryCharName || null
			} catch { /* chat 壳不可用（独立部署）→ _global */ }
		}
		const _username = args?.username || '_default'
		return loadMemoryData(_username, _char || '_global')?.config?.web_search || {}
	} catch { return {} }
}

async function searchViaBeilu(query, options = {}) {
	const { maxResults = 5, engine, baseConfig, category } = options

	wbT(null, 'web:search', 'searchViaBeilu.in', { query, maxResults })
	try {
		_wsEnsure();
		// 惰性 import 可能尚未就绪——再 await 一次（失败安全，最坏回退空结果）
		if (!_wsMod) {
			await import(new URL('./webSearch.mjs', import.meta.url).href)
				.then(m => { _wsMod = m; })
				.catch(() => {});
		}
		if (!_wsMod || typeof _wsMod.executeWebSearch !== 'function') {
			wbD(null, 'web:search', 'suite.unavailable', false, '联网套件不可用', { query })
			console.warn('[beilu-web] 联网套件 executeWebSearch 不可用')
			return []
		}

		// 键收口：与 webSearch.mjs 读键一字不差；per-char 配置铺底，调用参精度优先
		const _cfg = { ...(baseConfig || {}), max_results: maxResults }
		if (engine) _cfg.engine = engine
		// [0726] 类别透传：非 text 才写，避免覆盖 per-char 配置里的 search_category
		if (category && category !== 'text') _cfg.search_category = category
		const _res = await _wsMod.executeWebSearch(query, _cfg)
		const _out = (_res.results || []).map(r => {
			const o = {
				title: r.title || '',
				url: r.url || r.link || '',
				snippet: r.snippet || r.description || '',
			}
			// 图片/新闻专有字段随结果上行——原映射只保留三字段，图片直链在此丢失
			// （AI 只拿到来源页 URL 拿不到图，等于 type="images" 白传）
			if (r.image) o.image = r.image
			if (r.thumbnail) o.thumbnail = r.thumbnail
			if (r.width) o.width = r.width
			if (r.height) o.height = r.height
			if (r.date) o.date = r.date
			return o
		})
		wbD(null, 'web:search', 'results.empty', _out.length > 0, _out.length > 0 ? '' : `search no results: ${query}${_res.error ? ' / ' + _res.error : ''}`, { count: _out.length, query, engine: _res.engine })
		return _out
	} catch (err) {
		wbD(null, 'web:search', 'searchViaBeilu.catch', false, err && err.message, { query })
		console.warn('[beilu-web] 联网套件委托失败:', err.message)
		return []
	}
}

/**
 * 使用 fetch 直接抓取网页内容
 * @param {string} url - 目标 URL
 * @param {Object} options - 选项
 * @returns {Promise<string>} 网页文本内容
 */
// SEC-T7/R3：IP 私网判定收口到 src/server/safe_fetch.mjs 单一权威 ipIsPrivate（已修 IPv4-mapped
//   IPv6 双形态绕过 + 未知 IPv6 fail-closed）。原本地副本删除，杜绝同缺陷三处复制各自腐烂。

// SEC-T7/R3：URL 安全校验 + 重定向每跳 assertSafeUrl 收口到 src/server/safe_fetch.mjs 单一权威 safeFetch。
//   原本地手抄 _assertSafeUrl/_safeFetch 删除——杜绝 SSRF 安全逻辑分叉腐烂(权威加固自动生效)。
//   AI <browse> URL 恒不可信,safeFetch 无条件每跳校验(含 302 Location),fail-closed。

async function fetchWebPage(url, options = {}) {
	const { maxLength = 5000, timeout = 10000, _isRetry = false } = options

	wbT(null, 'web:fetch', 'fetchWebPage.in', { url, maxLength, timeout, retry: _isRetry })

	// [reach 平台路由] 已知平台 URL 优先走平台适配器获取结构化数据（比通用 HTML 抓取更深层）。
	// 失败静默降级到通用抓取（增强层，非依赖层）。
	// action/query 由 registry fromUrl 映射（此前固定 action:'read'，多数平台无 read action 必抛，
	// URL 提取形同虚设）；开关门控 enabled+urlSmartExtract（此前开关无人消费=死配置）。
	if (!_isRetry) {
		try {
			const { getReachConfig } = await import('../reach/config.mjs')
			const _rcfg = getReachConfig()
			const { matchPlatformByDomain, PLATFORM_REGISTRY } = await import('../reach/registry.mjs')
			const _platform = (_rcfg.enabled && _rcfg.urlSmartExtract) ? matchPlatformByDomain(url) : null
			const _mapped = _platform ? PLATFORM_REGISTRY[_platform]?.fromUrl?.(url) : null
			if (_mapped) {
				const { dispatch } = await import('../../dispatch/dispatcher.mjs')
				const _r = await dispatch({
					verb: 'read', target: 'functions:reach',
					payload: { platform: _platform, action: _mapped.action, query: _mapped.query },
				})
				if (_r?.ok && _r.data) {
					let _text = typeof _r.data === 'string' ? _r.data : JSON.stringify(_r.data, null, 2)
					// [SEC 安全同步 0722] 平台结构化数据=不可信外部内容：通用抓取链有 htmlToText 去标签
					// 清洗，此分支原样返回=清洗被绕过（间接注入面）。对齐 SEC-T7 口径中性化。
					const { neutralizeAngleBrackets, stripInvisibleUnicode } = await import('../security/untrusted_content.mjs')
					_text = neutralizeAngleBrackets(stripInvisibleUnicode(_text))
					if (_text.length > maxLength) _text = _text.substring(0, maxLength) + '\n...[truncated]'
					wbD(null, 'web:fetch', 'fetchWebPage.reach', true, '', { url, platform: _platform, len: _text.length })
					return _text
				}
			}
		} catch (_reachErr) {
			wbT(null, 'web:fetch', 'fetchWebPage.reachFallback', { url, error: String(_reachErr?.message || _reachErr).slice(0, 120) })
		}
	}

	// [0717 browse 浏览器化·凛倾拍板] 有 Chromium 内核时优先浏览器渲染抓页（JS 站点可读正文、
	// 反爬面小于裸 fetch），失败按原裸 safeFetch 链路降级（行为兜底不变）。
	// SSRF 分级（与 deployGatedAllow 同哲学）：
	//   - server 多用户部署：禁浏览器通道（浏览器内后续跳转无法像 safeFetch 逐跳校验 Location，
	//     fail-closed 退裸 safeFetch 全跳校验链）
	//   - local：首跳 assertSafeUrl（挡直接内网/保留地址目标）后走浏览器
	if (!_isRetry) {
		try {
			const { getDeployMode } = await import('../security/path_confine.mjs')
			if (getDeployMode() !== 'server') {
				const _bs = await import('./browserSearch.mjs')
				if (_bs.findChromiumExecutable('')) {
					const { assertSafeUrl } = await import('../security/safe_fetch.mjs')
					await assertSafeUrl(url)
					const _raw = await _bs.fetchPageViaBrowser(url, { timeout_ms: timeout }, maxLength)
					// SEC-T7 同口径清洗：裸 fetch 链经 htmlToText 去标签（含实体解码后复活的标签字面），
					// innerText 正文里的 <ideToolCall> 类字面若不清洗=恶意页面对 AI 的间接注入面（LLM01）。
					const _text = htmlToText(_raw)
					wbD(null, 'web:fetch', 'fetchWebPage.browser', true, '', { url, len: _text.length })
					return _text
				}
			}
		} catch (_bfErr) {
			// 内网拦截（assertSafeUrl 抛）也落这里——裸 fetch 链 safeFetch 会再次拦截，语义不变
			wbT(null, 'web:fetch', 'fetchWebPage.browserFallback', { url, error: String(_bfErr?.message || _bfErr).slice(0, 120) })
		}
	}

	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeout)

		// SEC-T7：safeFetch 内对首跳及每个重定向 Location 都做 assertSafeUrl（防 302→内网绕过）
		const response = await safeFetch(url, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; Beilu/1.0)',
				'Accept': 'text/html,text/plain,application/json',
			},
		})

		clearTimeout(timer)

		if (!response.ok) {
			wbD(null, 'web:fetch', 'fetch.nonOk', false, `HTTP ${response.status}`, { status: response.status, url })
			throw new Error(`HTTP ${response.status}`)
		}

		const contentType = response.headers.get('content-type') || ''
		let text

		if (contentType.includes('application/json')) {
			const json = await response.json()
			text = JSON.stringify(json, null, 2)
		} else {
			text = await response.text()
		}

		// 简单的 HTML 到纯文本转换
		if (contentType.includes('text/html')) {
			text = htmlToText(text)
		}

		// 截断
		if (text.length > maxLength) {
			text = text.substring(0, maxLength) + '\n...[truncated]'
		}

		wbD(null, 'web:fetch', 'fetchWebPage.out', text.length > 0, text.length > 0 ? '' : `fetched empty: ${url}`, { url, len: text.length })
		return text
	} catch (err) {
		// [0716 网络波动容错·凛倾指令] 瞬态错（超时/连接类）复试一次再落错误字符串——原单发即败，
		//   网络抖一下 AI 就拿到 [Error fetching]。非瞬态（HTTP 4xx/SSRF 拦截）不重试；错误字符串契约不变。
		const _eAll = `${err?.message || ''} ${err?.cause?.message || ''}`
		const _transient = err?.name === 'AbortError' || /timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|terminated|other side closed|reading a body/i.test(_eAll)
		if (_transient && !_isRetry) {
			wbD(null, 'web:fetch', 'fetchWebPage.retry', false, `瞬态失败复试: ${err?.message}`, { url })
			await new Promise((r) => setTimeout(r, 800))
			return fetchWebPage(url, { ...options, _isRetry: true })
		}
		wbD(null, 'web:fetch', 'fetchWebPage.catch', false, err && err.message, { url, aborted: err && err.name === 'AbortError' })
		return `[Error fetching ${url}]: ${err.message}`
	}
}

/**
 * 简单的 HTML 到纯文本转换
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
	return String(html)
		// SEC-T7：先解码 HTML 实体，使 &lt;ideToolCall&gt; 之类先还原成真标签，
		//   再统一去标签时一并清除——杜绝"去标签在前、解码在后"导致编码标签复活注入 AI。
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		// 移除 script / style / 注释
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		// 块级元素换行
		.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		// 移除所有 HTML 标签（含上面解码出的标签）
		.replace(/<[^>]+>/g, '')
		// 清理多余空白
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]+/g, ' ')
		.trim()
}

/**
 * 解析 AI 回复中的搜索/浏览指令
 * @param {string} content
 * @returns {Object[]} 操作列表
 */
function parseWebOperations(content) {
	const ops = []

	// <search>query</search> ／ <search max="10" type="images">query</search>
	// [0726 002「注意图片类型的读取」+「照着改就行」] 属性改为**顺序无关的通用捕获**：
	//   原 `(?:\s+max="(\d+)")?` 是位置固定的单属性，加第二个属性就要写死顺序，
	//   AI 写成 type 在前就整条失配（且静默——正则不匹配=这条指令消失，无报错）。
	//   同款通用属性捕获在分身标签已有先例（replyHandler _preCloneRegex）。
	const searchRegex = /<search((?:\s+[a-zA-Z_]+\s*=\s*"[^"]*")*)\s*>([\s\S]*?)<\/search>/gi
	let match
	while ((match = searchRegex.exec(content)) !== null) {
		const attrs = match[1] || ''
		const _attr = (n) => attrs.match(new RegExp(`${n}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
		const _type = String(_attr('type') || _attr('category') || 'text').toLowerCase()
		ops.push({
			type: 'search',
			query: match[2].trim(),
			maxResults: _attr('max') ? parseInt(_attr('max'), 10) : 5,
			// 值域收窄到通道实际支持的三类，非法值回落 text（而不是原样透传让下游静默返回 0 条）
			category: ['text', 'images', 'news'].includes(_type) ? _type : 'text',
		})
	}

	// <browse>url</browse>
	const browseRegex = /<browse(?:\s+max="(\d+)")?>([\s\S]*?)<\/browse>/gi
	while ((match = browseRegex.exec(content)) !== null) {
		ops.push({
			type: 'browse',
			url: match[2].trim(),
			maxLength: match[1] ? parseInt(match[1], 10) : 5000,
		})
	}

	return ops
}

// ============================================================
// 插件数据
// ============================================================

let pluginData = {
	enabled: true,
	autoSearch: true,         // 自动执行搜索
	autoBrowse: false,        // 自动执行浏览 (可能较慢)
	maxResults: 5,            // 默认搜索结果数
	maxPageLength: 5000,      // 默认页面最大长度
	fetchTimeout: 10000,      // fetch 超时 (ms)
	searchHistory: [],        // WebSearchRecord[]
	maxHistory: 50,
	_browsersPath: "",
	// 搜索结果缓存 (用于下次 GetPrompt 注入) —— 按会话键(chatid)分区，兜底键 ""
	//   范式同 beilu-files pendingOpResults（Map<chatid|"", []> + "" 兜底）。
	//   写入方：ReplyHandler(args.chat_name→chatid) / manualSearch(无 chatid → "")。
	//   消费方：GetPrompt(args.chat_name→chatid) drain 自己键 + 兜底键 "" 后清空。
	//   修复多窗口/多用户串台：B 会话 GetPrompt 不再吃掉并清空 A 会话的搜索结果。
	_latestResults: new Map(), // Map<chatid|"", SearchResult[]>
	_latestBrowse: new Map(),  // Map<chatid|"", {url,content}[]>
}

// 模块加载时后台触发浏览器内核自动安装（不阻塞启动）
ensureBrowsers(pluginData._browsersPath).catch(e =>
	console.warn("[beilu-web] 浏览器内核自动安装跳过:", e?.message?.slice(0, 100))
);

// ============================================================
// 搜索结果 / 浏览内容会话隔离辅助（Map<chatid|"", []>），范式同 beilu-files pendingOpResults。
//   读：GetPrompt drain 本会话键 + 兜底键 ""（无键结果对所有会话可见），并清空这两键。
//   写：按会话键 push（null/undefined → 兜底键 ""）。
//   会话键统一由 _cidOf(args) 提取：args.chatid || args.chat_name.replace('common_chat_','')。
// ============================================================
/** 从 GetPrompt/ReplyHandler 的 args 提取会话键（与 beilu-files 同口径）。 */
function _cidOf(arg) {
	return arg?.chatid ?? arg?.chat_id ?? arg?.chat_name?.replace('common_chat_', '') ?? null
}
/** 入队：按会话键 push（null/undefined → 兜底键 ""）。 */
function _pushToMap(map, sessionKey, items) {
	if (!items || items.length === 0) return
	const k = sessionKey || ''
	let arr = map.get(k)
	if (!arr) { arr = []; map.set(k, arr) }
	arr.push(...items)
}
/** GetPrompt drain：取本会话键 + 兜底键 ""（无键结果对所有会话可见），并清空这两键。 */
function _drainFromMap(map, sessionKey) {
	const k = sessionKey || ''
	const out = []
	for (const key of k === '' ? [''] : [k, '']) {
		const arr = map.get(key)
		if (arr && arr.length) {
			out.push(...arr)
			map.set(key, [])
		}
	}
	return out
}

// ============================================================
// beilu-web 插件导出
// ============================================================

/**
 * beilu-web 插件 — 联网搜索/浏览
 *
 * 职责：
 * - 解析 AI 回复中的 <search> 和 <browse> 标签
 * - 调用 beilu SearchSource 或直接 fetch 获取信息
 * - GetPrompt: 注入搜索能力说明 + 最新搜索结果
 * - ReplyHandler: 解析并执行搜索/浏览操作
 */
const pluginExport = {
	info,
	Load: async ({ router } = {}) => {
		// config REST 自注册（范式=memory/main.mjs Load）：parts_loader:787 传 part 作用域 router，
		// 前端 settings 槽位(settingsSlots.mjs initWebConfigSlot)走 /api/parts/plugins:beilu-web/config/*——
		// 此前 Load 为空=端点从未注册，前端恒 404。单源复用 interfaces.config（不消费身份，pluginData 全局单例）。
		if (!router) return
		router.get(/\/config\/getdata$/, authenticate, async (req, res) => {
			try { res.json(await pluginExport.interfaces.config.GetData()) }
			catch (err) { res.status(500).json({ error: err.message }) }
		})
		router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
			try {
				await pluginExport.interfaces.config.SetData(req.body)
				res.json({ success: true })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})
	},
	Unload: async () => {},
	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginData.enabled,
				autoSearch: pluginData.autoSearch,
				autoBrowse: pluginData.autoBrowse,
				maxResults: pluginData.maxResults,
				maxPageLength: pluginData.maxPageLength,
				fetchTimeout: pluginData.fetchTimeout,
				maxHistory: pluginData.maxHistory,
				searchHistory: pluginData.searchHistory.slice(-10),
				_stats: {
					totalSearches: pluginData.searchHistory.length,
				},
				crawl: probeCrawlCapability(pluginData._browsersPath),
			}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						case 'manualSearch': {
							// [0717 配置断链修] 面板手动搜索同样铺 per-char 配置底（桥盖章有 chatid 即归位，
							// 无则 _global——比原来的裸 {max_results} 至少多吃到 _global 级 engine/代理/名单）
							const results = await searchViaBeilu(data.query, {
								maxResults: data.maxResults || pluginData.maxResults,
								baseConfig: await _perCharWebSearchConfig(data, data.chatid ?? data.chatId ?? null),
							})
							const record = {
								id: generateId(),
								query: data.query,
								results,
								timestamp: Date.now(),
								status: results.length > 0 ? 'completed' : 'no_results',
							}
							pluginData.searchHistory.push(record)
							// config 面板手动搜索无 chatid 上下文 → 兜底键 ""（对所有会话可见）
							_pushToMap(pluginData._latestResults, '', results)
							break
						}
						case 'clearHistory': {
							pluginData.searchHistory = []
							break
						}
						case 'diagnose': {
							_wsEnsure()
							if (!_wsMod) {
								try { _wsMod = await import(new URL('./webSearch.mjs', import.meta.url).href); } catch {}
							}
							if (typeof _wsMod?.diagnoseWebSearch === 'function') {
								return await _wsMod.diagnoseWebSearch(data.config || {})
							}
							return { nodes: [{ id: "error", name: "诊断", ok: false, ms: 0, detail: "诊断模块不可用" }] }
						}
						default:
							break
					}
					return
				}

				if (data.enabled !== undefined) pluginData.enabled = data.enabled
				if (data.autoSearch !== undefined) pluginData.autoSearch = data.autoSearch
				if (data.autoBrowse !== undefined) pluginData.autoBrowse = data.autoBrowse
				if (data.maxResults !== undefined) pluginData.maxResults = data.maxResults
				if (data.maxPageLength !== undefined) pluginData.maxPageLength = data.maxPageLength
				if (data.fetchTimeout !== undefined) pluginData.fetchTimeout = data.fetchTimeout
				if (data.maxHistory !== undefined) pluginData.maxHistory = data.maxHistory
				if (data.browsersPath !== undefined) pluginData._browsersPath = data.browsersPath
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入搜索能力 + 最新结果
			 */
			GetPrompt: async (arg) => {
				if (!pluginData.enabled) return null

				// 能力引导块走 injectTexts 单源（web.capabilities 键）；结构尾换行留代码
				let text = getInjectText('web.capabilities') + '\n'

				const _cid = _cidOf(arg)
				const _myResults = _drainFromMap(pluginData._latestResults, _cid)
				const _myBrowse = _drainFromMap(pluginData._latestBrowse, _cid)
				wbT(_cid, 'web:inject', 'GetPrompt.in', { latestResults: _myResults.length, latestBrowse: _myBrowse.length })
				if (_myResults.length > 0) {
					let _block = ''
					for (const r of _myResults)
						_block += `- ${r.title}\n  ${r.url}\n  ${r.snippet}\n\n`
					text += '\n[Latest Search Results]\n' + _block + '\n'
				}

				if (_myBrowse.length > 0) {
					let _block = ''
					for (const b of _myBrowse)
						_block += `--- ${b.url} ---\n${b.content}\n---\n\n`
					text += '\n[Browsed Page Content]\n' + _block + '\n'
				}

				// [0727 契约修] text 契约=数组[{content,important}]（decl/prompt_struct.ts，同批：sysinfo/airp/reach）——
				//   裸字符串在 fake-send 的 change-prompt .sort 处炸，且每 15s 轮询被 shadowBuild 契约归一点名刷日志
				return {
					text: text ? [{ content: text, important: 0 }] : [],
					role: 'system',
					name: (wbT(_cid, 'web:inject', 'GetPrompt.out', { chars: text.length }), 'beilu-web'),
				}
			},

			/**
			 * ReplyHandler: 解析搜索/浏览指令并执行
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const _rcid = _cidOf(args) ?? reply?.chatid ?? null
				const ops = parseWebOperations(reply.content)
				if (ops.length === 0) return false
				wbT(_rcid, 'web:reply', 'ReplyHandler.ops', { count: ops.length, types: ops.map(o => o.type) })

				// per-char web_search 配置一次取齐供本轮多个 <search> 共用（0717 直搜配置断链修）
				const _wsBaseCfg = ops.some(o => o.type === 'search') ? await _perCharWebSearchConfig(args, _rcid) : null
				// [0717 开关语义收口] "联网搜索"总闸（web_search.enabled）原来只管 <needWebSearch> 一条，
				// <search> 直搜只看 beilu-web 自己的 autoSearch=用户关了总闸直搜照跑（开关语义分裂，
				// 体感"关不掉"）。直搜挂同一总闸（fail-open 口径与 memory replyHandler 一致：
				// enabled===false 才拒）；autoSearch 仍是直搜通道自己的细粒度开关，两闸都开才走。
				const _wsGateOff = _wsBaseCfg && _wsBaseCfg.enabled === false
				for (const op of ops) {
					if (op.type === 'search' && pluginData.autoSearch) {
						if (_wsGateOff) {
							wbD(_rcid, 'web:search', 'ReplyHandler.gateOff', false, '联网搜索总闸已关（web_search.enabled=false），直搜跳过', { query: op.query })
							continue
						}
						const results = await searchViaBeilu(op.query, {
							maxResults: op.maxResults || pluginData.maxResults,
							baseConfig: _wsBaseCfg,
							category: op.category, // <search type="images|news"> 类别透传（解析→执行的最后一环）
						})
						const record = {
							id: generateId(),
							query: op.query,
							results,
							timestamp: Date.now(),
							status: results.length > 0 ? 'completed' : 'no_results',
						}
						pluginData.searchHistory.push(record)
						_pushToMap(pluginData._latestResults, _rcid, results)
						// [0717 前端搜索卡] 结构化事件挂 reply.extension（memory 3b 同键同形状，前端 _appendWebSearchCard 消费）。
						// 时序免疫（与 memory 侧同口径）：追加 + 按 query 去重——regen 重跑链时 extension 残留，盲 push 会累积重复。
						if (!reply.extension) reply.extension = {}
						const _prevWsEvts = Array.isArray(reply.extension._webSearchEvents) ? reply.extension._webSearchEvents : []
						reply.extension._webSearchEvents = [
							..._prevWsEvts.filter(e => e.query !== op.query),
							{
								query: op.query, count: results.length,
								...(results.length === 0 ? { error: '无结果' } : {}),
								results: results.map(r => ({
									title: r.title || '', url: r.url || '',
									domain: (() => { try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' } })(),
								})),
							},
						]
						wbD(_rcid, 'web:search', 'ReplyHandler.searchResult', results.length > 0, results.length > 0 ? '' : `search no results: ${op.query}`, { query: op.query, count: results.length })
					}

					// 工作/代码模式下自动开启browse（reply.extension._mode由beilu-memory设置）
					const _modeAutoBrowse = ['work', 'code'].includes(reply.extension?._mode)
					if (op.type === 'browse' && (pluginData.autoBrowse || _modeAutoBrowse)) {
						const content = await fetchWebPage(op.url, {
							maxLength: op.maxLength || pluginData.maxPageLength,
							timeout: pluginData.fetchTimeout,
						})
						wbD(_rcid, 'web:fetch', 'ReplyHandler.browseResult', !(typeof content === 'string' && content.startsWith('[Error fetching')), (typeof content === 'string' && content.startsWith('[Error fetching')) ? content.slice(0, 120) : '', { url: op.url, len: typeof content === 'string' ? content.length : 0 })
						_pushToMap(pluginData._latestBrowse, _rcid, [{
							url: op.url,
							content,
						}])
					}
				}

				// 清除回复中的搜索/浏览标签
				reply.content = reply.content
					.replace(/<search[\s\S]*?<\/search>/gi, '')
					.replace(/<browse[\s\S]*?<\/browse>/gi, '')
					.trim()

				// 限制历史
				if (pluginData.searchHistory.length > pluginData.maxHistory) {
					pluginData.searchHistory = pluginData.searchHistory.slice(-pluginData.maxHistory)
				}

				return false
			},
		},
	},
}

export default pluginExport
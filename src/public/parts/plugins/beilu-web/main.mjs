import info from './info.json' with { type: 'json' }

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
 * 使用 Fount 的 SearchSource 进行搜索
 * 通过 Fount API 调用已配置的搜索源
 * @param {string} query - 搜索词
 * @param {Object} options - 选项
 * @returns {Promise<SearchResult[]>}
 */
async function searchViaFount(query, options = {}) {
	const { maxResults = 5 } = options

	try {
		// 调用 Fount 的搜索服务 API
		const response = await fetch('/api/services/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				query,
				maxResults,
			}),
		})

		if (!response.ok) {
			throw new Error(`Search API returned ${response.status}`)
		}

		const data = await response.json()
		return (data.results || []).map(r => ({
			title: r.title || '',
			url: r.url || r.link || '',
			snippet: r.snippet || r.description || '',
		}))
	} catch (err) {
		console.warn('[beilu-web] Fount search API failed:', err.message)
		return []
	}
}

/**
 * 使用 fetch 直接抓取网页内容
 * @param {string} url - 目标 URL
 * @param {Object} options - 选项
 * @returns {Promise<string>} 网页文本内容
 */
async function fetchWebPage(url, options = {}) {
	const { maxLength = 5000, timeout = 10000 } = options

	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeout)

		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; Beilu/1.0)',
				'Accept': 'text/html,text/plain,application/json',
			},
		})

		clearTimeout(timer)

		if (!response.ok) {
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

		return text
	} catch (err) {
		return `[Error fetching ${url}]: ${err.message}`
	}
}

/**
 * 简单的 HTML 到纯文本转换
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
	return html
		// 移除 script 和 style
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		// 移除 HTML 注释
		.replace(/<!--[\s\S]*?-->/g, '')
		// 块级元素换行
		.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		// 移除所有 HTML 标签
		.replace(/<[^>]+>/g, '')
		// 解码 HTML 实体
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
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

	// <search>query</search>
	const searchRegex = /<search(?:\s+max="(\d+)")?>([\s\S]*?)<\/search>/gi
	let match
	while ((match = searchRegex.exec(content)) !== null) {
		ops.push({
			type: 'search',
			query: match[2].trim(),
			maxResults: match[1] ? parseInt(match[1], 10) : 5,
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
	// 搜索结果缓存 (用于下次 GetPrompt 注入)
	_latestResults: [],
	_latestBrowse: [],
}

// ============================================================
// beilu-web 插件导出
// ============================================================

/**
 * beilu-web 插件 — 联网搜索/浏览
 *
 * 职责：
 * - 解析 AI 回复中的 <search> 和 <browse> 标签
 * - 调用 Fount SearchSource 或直接 fetch 获取信息
 * - GetPrompt: 注入搜索能力说明 + 最新搜索结果
 * - ReplyHandler: 解析并执行搜索/浏览操作
 */
export default {
	info,
	Load: async () => {},
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
			}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						case 'manualSearch': {
							const results = await searchViaFount(data.query, {
								maxResults: data.maxResults || pluginData.maxResults,
							})
							const record = {
								id: generateId(),
								query: data.query,
								results,
								timestamp: Date.now(),
								status: results.length > 0 ? 'completed' : 'no_results',
							}
							pluginData.searchHistory.push(record)
							pluginData._latestResults = results
							break
						}
						case 'clearHistory': {
							pluginData.searchHistory = []
							break
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
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入搜索能力 + 最新结果
			 */
			GetPrompt: async (arg) => {
				if (!pluginData.enabled) return null

				let text = '[Web Search Capabilities]\n'
				text += 'You can search the web and browse pages:\n'
				text += '- <search>your query</search> - Search the web\n'
				text += '- <browse>https://example.com</browse> - Read a web page\n'

				// 注入最新搜索结果
				if (pluginData._latestResults.length > 0) {
					text += '\n[Latest Search Results]\n'
					for (const r of pluginData._latestResults) {
						text += `- ${r.title}\n  ${r.url}\n  ${r.snippet}\n\n`
					}
					// 清空，避免重复注入
					pluginData._latestResults = []
				}

				// 注入最新浏览内容
				if (pluginData._latestBrowse.length > 0) {
					text += '\n[Browsed Page Content]\n'
					for (const b of pluginData._latestBrowse) {
						text += `--- ${b.url} ---\n${b.content}\n---\n\n`
					}
					pluginData._latestBrowse = []
				}

				return {
					text,
					role: 'system',
					name: 'beilu-web',
				}
			},

			/**
			 * ReplyHandler: 解析搜索/浏览指令并执行
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const ops = parseWebOperations(reply.content)
				if (ops.length === 0) return false

				for (const op of ops) {
					if (op.type === 'search' && pluginData.autoSearch) {
						const results = await searchViaFount(op.query, {
							maxResults: op.maxResults || pluginData.maxResults,
						})
						const record = {
							id: generateId(),
							query: op.query,
							results,
							timestamp: Date.now(),
							status: results.length > 0 ? 'completed' : 'no_results',
						}
						pluginData.searchHistory.push(record)
						pluginData._latestResults.push(...results)
					}

					if (op.type === 'browse' && pluginData.autoBrowse) {
						const content = await fetchWebPage(op.url, {
							maxLength: op.maxLength || pluginData.maxPageLength,
							timeout: pluginData.fetchTimeout,
						})
						pluginData._latestBrowse.push({
							url: op.url,
							content,
						})
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
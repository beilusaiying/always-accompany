import { createDocumentFragmentFromHtmlString } from './template.mjs'

const IconCache = {}

/**
 * 取图标文本（共享缓存）。失败即从缓存删除条目——否则 rejected Promise 永久占位，
 * 网络恢复后图标仍全断直到刷新页面；404 时 fetch 不 reject，错误页 HTML 会被当 SVG
 * 缓存并注入 DOM，故校验 response.ok + 内容含 <svg。
 * @param {string} url - 图标 URL。
 * @returns {Promise<string>} SVG 文本。
 */
function fetchIconText(url) {
	IconCache[url] ??= fetch(url)
		.then(response => {
			if (!response.ok) throw new Error(`svg fetch ${response.status}: ${url}`)
			return response.text()
		})
		.then(text => {
			if (!text.includes('<svg')) throw new Error(`svg content invalid: ${url}`)
			return text
		})
		.catch(error => {
			delete IconCache[url]
			throw error
		})
	return IconCache[url]
}

/**
 * currentColor在img的从url导入的svg中不起作用，此函数旨在解决这个问题。
 * @param {DocumentFragmentOrElement} DOM - 要处理的 DOM。
 * @returns {Promise<DocumentFragmentOrElement>} - 处理后的 DOM。
 */
export async function svgInliner(DOM) {
	const svgs = DOM.querySelectorAll('img[src$=".svg"]')
	await Promise.all([...svgs].map(async svg => {
		const url = svg.getAttribute('src')
		// T007：职责收窄回设计意图——只内联【同源】SVG（本地图标 currentColor 着色）。
		// 外域 SVG fetch 必撞 CORS（截图202实证 modelcontextprotocol.io favicon → base.mjs TypeError 连锁），
		// 而 <img> 跨域展示本不受 CORS 限：非同源保留原标签原样渲染（在线正常显示/离线优雅缺省），不 fetch 不报错。
		// data:/blob: 等 origin="null" 一并跳过（img 自身可显示，无内联必要）。
		if (new URL(url, location.href).origin !== location.origin) return
		let data = await fetchIconText(url)
		// 对于每个id="xx"的match，在id后追加uuid
		const uuid = Math.random().toString(36).slice(2)
		const matches = data.matchAll(/id="([^"]+)"/g)
		for (const match of matches) data = data.replaceAll(match[1], `${match[1]}-${uuid}`)
		const newSvg = createDocumentFragmentFromHtmlString(data)
		for (const attr of svg.attributes)
			newSvg.querySelector('svg')?.setAttribute?.(attr.name, attr.value)
		svg.replaceWith(newSvg)
	})).catch(console.error)
	return DOM
}
/**
 * 获取 SVG 图标。
 * @param {string} url - 图标的 URL。
 * @param {object} [attributes={}] - 要添加到 SVG 元素的属性。
 * @returns {Promise<SVGElement>} - SVG 元素。
 */
export async function getSvgIcon(url, attributes = {}) {
	let data = await fetchIconText(url)
	// 对于每个id="xx"的match，在id后追加uuid
	const uuid = Math.random().toString(36).slice(2)
	const matches = data.matchAll(/id="([^"]+)"/g)
	for (const match of matches) data = data.replaceAll(match[1], `${match[1]}-${uuid}`)
	const newSvg = createDocumentFragmentFromHtmlString(data)
	for (const attr in attributes)
		newSvg.querySelector('svg').setAttribute(attr, attributes[attr])
	return newSvg.querySelector('svg')
}

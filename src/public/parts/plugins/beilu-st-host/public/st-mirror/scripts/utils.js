/**
 * [beilu-st-host · st-mirror shim] scripts/utils.js —— 酒馆通用工具函数落点。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   debounce / delay 等 → memory-enhancement / MessageSummarize。
 *
 * 【一期策略】这些是「纯工具函数」（无 ST 内部状态依赖），直接就地实现比抛错 stub 更有用、更稳
 *   （避免插件因缺一个 debounce 就整体挂）。ST-P4 证据外的杂项工具按需再补；未导出符号由 ESM 暴露（可见）。
 *   实现对齐 ST utils.js 的常见签名（debounce(fn, timeout)、delay(ms)、uuidv4() 等）。
 */

/** 防抖：ST 签名 debounce(func, timeout=300)。 */
export function debounce(func, timeout = 300) {
	let timer = null
	return function debounced(...args) {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => func.apply(this, args), timeout)
	}
}

/** 节流：ST 签名 throttle(func, limit=300)。 */
export function throttle(func, limit = 300) {
	let inThrottle = false
	return function throttled(...args) {
		if (inThrottle) return
		func.apply(this, args)
		inThrottle = true
		setTimeout(() => { inThrottle = false }, limit)
	}
}

/** 延时：ST 签名 delay(ms) → Promise。 */
export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ST sleep 别名。 */
export const sleep = delay

/** 生成 uuid v4（ST uuidv4）。优先用平台 crypto，退化到手写。 */
export function uuidv4() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0
		const v = c === 'x' ? r : (r & 0x3) | 0x8
		return v.toString(16)
	})
}

/** 转义 HTML（ST 常用 escapeHtml；用 textContent 走浏览器原生转义）。 */
export function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = String(str ?? '')
	return div.innerHTML
}

/** 判空（ST isTrueBoolean 语义近似：把字符串/布尔归一为布尔）。 */
export function isTrueBoolean(value) {
	return value === true || value === 'true' || value === '1' || value === 1
}

/** 深拷贝（结构化克隆优先，退化 JSON）。ST 有 structuredClone 用法。 */
export function deepClone(obj) {
	if (typeof structuredClone === 'function') {
		try { return structuredClone(obj) } catch { /* 含不可克隆值时退 JSON */ }
	}
	return JSON.parse(JSON.stringify(obj))
}

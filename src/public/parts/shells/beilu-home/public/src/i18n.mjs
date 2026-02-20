/**
 * beilu-home 国际化模块
 *
 * 设计思路：
 * - HTML 中的中文是默认语言（zh-CN），无需翻译文件支撑
 * - 切换到其他语言时，通过 data-i18n 属性定位元素，覆盖文字
 * - 切换回中文时，恢复存储的原始文本
 * - JS 动态文字通过 t(key) 函数获取翻译
 *
 * 支持语言：zh-CN / en-UK / ja-JP / zh-TW
 */

// ===== 状态 =====
const cache = {}                      // { lang: { key: value } }
const originals = new Map()           // Map<Element, { text?, placeholder?, title? }>
let currentLang = 'zh-CN'

// ===== 核心 API =====

/**
 * 加载语言文件
 * @param {string} lang - 语言代码
 * @returns {Promise<Object>} 翻译数据
 */
async function loadLang(lang) {
	if (lang === 'zh-CN') return {}  // 中文是 HTML 原始内容，无需文件
	if (cache[lang]) return cache[lang]
	try {
		const res = await fetch(`./locales/${lang}.json`)
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		cache[lang] = await res.json()
		return cache[lang]
	} catch (err) {
		console.warn(`[i18n] 加载语言文件 ${lang}.json 失败:`, err)
		return {}
	}
}

/**
 * 获取翻译文本
 * @param {string} key - 翻译 key
 * @param {Object} [params] - 插值参数 ${name} 格式
 * @returns {string} 翻译后的文本，找不到则返回 key
 */
export function t(key, params) {
	let text
	if (currentLang === 'zh-CN') {
		// 中文模式：从 zh-CN 缓存或直接返回 key
		text = cache['zh-CN']?.[key] || key
	} else {
		text = cache[currentLang]?.[key] || cache['zh-CN']?.[key] || key
	}
	// 简单插值
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), v)
		}
	}
	return text
}

/**
 * 翻译页面中所有带 data-i18n 属性的元素
 */
function translateDOM() {
	const data = currentLang === 'zh-CN' ? null : cache[currentLang]

	document.querySelectorAll('[data-i18n]').forEach(el => {
		const key = el.dataset.i18n

		// 首次翻译时存储原始文本
		if (!originals.has(el)) {
			originals.set(el, {
				text: el.textContent,
				placeholder: el.getAttribute('placeholder'),
				title: el.getAttribute('title'),
			})
		}

		if (currentLang === 'zh-CN') {
			// 恢复原始文本
			const orig = originals.get(el)
			if (orig) {
				const target = el.dataset.i18nAttr
				if (target === 'placeholder') {
					el.setAttribute('placeholder', orig.placeholder || '')
				} else if (target === 'title') {
					el.setAttribute('title', orig.title || '')
				} else {
					el.textContent = orig.text
				}
			}
			return
		}

		// 应用翻译
		const translated = data?.[key]
		if (!translated) return

		const target = el.dataset.i18nAttr
		if (target === 'placeholder') {
			el.setAttribute('placeholder', translated)
		} else if (target === 'title') {
			el.setAttribute('title', translated)
		} else {
			el.textContent = translated
		}
	})
}

/**
 * 切换语言并翻译页面
 * @param {string} lang - 目标语言代码
 */
export async function switchLang(lang) {
	currentLang = lang
	localStorage.setItem('beiluHomeLang', lang)

	if (lang !== 'zh-CN') {
		await loadLang(lang)
	}

	translateDOM()

	// 触发自定义事件，让各模块知道语言已切换
	window.dispatchEvent(new CustomEvent('beilu-lang-change', { detail: { lang } }))
}

/**
 * 获取当前语言
 * @returns {string}
 */
export function getCurrentLang() {
	return currentLang
}

/**
 * 初始化 i18n 系统
 * 从 localStorage 读取偏好，加载对应语言文件
 */
export async function initI18n() {
	// 同时预加载 zh-CN 的翻译数据（供 t() 函数在中文模式下使用）
	try {
		const res = await fetch('./locales/zh-CN.json')
		if (res.ok) cache['zh-CN'] = await res.json()
	} catch { /* 中文模式不依赖文件 */ }

	const saved = localStorage.getItem('beiluHomeLang')
	if (saved && saved !== 'zh-CN') {
		currentLang = saved
		await loadLang(saved)
		translateDOM()
	}

	console.log(`[i18n] 初始化完成，当前语言: ${currentLang}`)
}
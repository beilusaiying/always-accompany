// login 页轻量覆盖式 i18n（beilu 多语言体系：中文原文=本体，外语=差量字典覆盖）
// 为什么独立于壳模块：/parts/ 静态域全部要求登录（endpoints.mjs:827 authenticate），
// 登录页是匿名态，壳字典 401 不可达——字典放本页 locales/（pages 域 express.static 匿名可达）。
// 语言来源：localStorage beiluLang（与壳/wiki 同键，登录过的用户自动跟随）→ navigator.language 映射兜底。
// 页面小（44 条），一次性翻译 + 简版 observer 兜动态错误消息；切换器由本模块注入页面右上角。

const LANG_KEY = 'beiluLang'
const ATTRS = ['title', 'placeholder', 'aria-label']

function detectLang() {
	const saved = localStorage.getItem(LANG_KEY)
	if (saved) return saved
	const nav = (navigator.language || '').toLowerCase()
	if (nav.startsWith('zh-tw') || nav.startsWith('zh-hant')) return 'zh-TW'
	if (nav.startsWith('zh')) return 'zh-CN'
	if (nav.startsWith('ja')) return 'ja'
	return 'en'
}

let dict = null
let applying = false

function translateTextNode(node) {
	const raw = node.nodeValue
	if (!raw) return
	const trimmed = raw.trim()
	if (!trimmed) return
	const translated = dict[trimmed]
	if (translated === undefined || translated === trimmed) return
	const lead = raw.slice(0, raw.indexOf(trimmed[0]))
	node.nodeValue = lead + translated + raw.slice(lead.length + trimmed.length)
}

function translateAttrs(el) {
	for (const attr of ATTRS) {
		const v = el.getAttribute(attr)
		if (!v) continue
		const translated = dict[v]
		if (translated !== undefined && translated !== v) el.setAttribute(attr, translated)
	}
}

function translateTree(root) {
	applying = true
	try {
		if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return }
		if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode(n) {
				if (n.nodeType === Node.ELEMENT_NODE) {
					const t = n.tagName
					if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA') return NodeFilter.FILTER_REJECT
				}
				return NodeFilter.FILTER_ACCEPT
			},
		})
		if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root)
		let n
		while ((n = walker.nextNode()))
			if (n.nodeType === Node.TEXT_NODE) translateTextNode(n)
			else translateAttrs(n)
		if (document.title.trim() in dict) document.title = dict[document.title.trim()]
	} finally {
		applying = false
	}
}

const observer = new MutationObserver(muts => {
	if (applying || !dict) return
	for (const m of muts)
		if (m.type === 'childList') m.addedNodes.forEach(node => translateTree(node))
		else if (m.type === 'characterData') { applying = true; try { translateTextNode(m.target) } finally { applying = false } }
})

async function applyLang(lang) {
	if (lang === 'zh-CN') return // 中文=本体，零行为（切语言动作在切换器里走 reload 重置）
	try {
		const res = await fetch(`./locales/${lang}.json`)
		if (!res.ok) return
		dict = await res.json()
	} catch { return }
	document.documentElement.lang = lang
	translateTree(document.body)
	observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

async function injectSwitcher(current) {
	let langs = []
	try {
		const res = await fetch('./locales/list.json')
		if (res.ok) langs = await res.json()
	} catch { /* 无清单不显示切换器 */ }
	if (!langs.length) return
	const all = [{ id: 'zh-CN', name: '简体中文' }, ...langs]
	const sel = document.createElement('select')
	sel.id = 'login-lang-select'
	sel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:50;font-size:12px;padding:2px 6px;border-radius:6px;opacity:.85;'
	sel.innerHTML = all.map(l => `<option value="${l.id}"${l.id === current ? ' selected' : ''}>${l.name}</option>`).join('')
	sel.addEventListener('change', () => {
		localStorage.setItem(LANG_KEY, sel.value)
		location.reload() // 登录页无状态，reload=最稳的语言重置（含切回中文的原文恢复）
	})
	document.body.appendChild(sel)
}

const lang = detectLang()
if (document.body) { applyLang(lang); injectSwitcher(lang) }
else document.addEventListener('DOMContentLoaded', () => { applyLang(lang); injectSwitcher(lang) })

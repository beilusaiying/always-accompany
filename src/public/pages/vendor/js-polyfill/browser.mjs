// js-polyfill 浏览器侧（本地化副本，避免运行时 jsdelivr CDN 依赖）
// 来源: https://cdn.jsdelivr.net/gh/steve02081504/js-polyfill/browser.mjs
// 本地化日期: 2026-06-12
// 说明: https://esm.sh/* 子依赖改写为 /esm-cache/*，经 esmProxy 缓存加载。
//       保留原 .catch 降级 + 特性检测：仅在浏览器缺失该特性时才尝试加载 polyfill。
if (!('anchorName' in document.documentElement.style))
	import('/esm-cache/@oddbird/css-anchor-positioning').catch(_ => 0)

if (!('popover' in HTMLElement.prototype))
	await import('/esm-cache/@oddbird/popover-polyfill').catch(_ => 0)

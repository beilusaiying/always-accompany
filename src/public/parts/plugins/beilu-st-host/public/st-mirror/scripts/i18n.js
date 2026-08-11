/**
 * [beilu-st-host · st-mirror shim] scripts/i18n.js —— 酒馆多语言落点（P2，一期返回原文）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   t / translate → memory-enhancement（界面文案翻译）。
 *
 * 【一期策略】P2：i18n 字典体系属二期。一期「透传返回原文」（不抛错）—— 因为翻译缺失时返回原文是
 *   业界通行的优雅降级（插件 UI 显示英文/原文，功能不受影响），比抛错更合理。这是红线2 的合理例外：
 *   i18n 的语义本身就允许「查不到返回原键」，非「未实现导致坏值」。二期接 beilu i18n 字典后自然生效。
 */

/**
 * t：ST 模板标签/函数式翻译。一期返回原文。
 * 兼容两种调用：t`原文` （模板标签）与 t('原文', {...}) （函数式）。
 */
export function t(strings, ...values) {
	// 模板标签用法：t`Hello ${x}` → strings 是数组，拼回原文。
	if (Array.isArray(strings) && Object.prototype.hasOwnProperty.call(strings, 'raw')) {
		return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '')
	}
	// 函数式用法：t('key') → 原样返回。
	return String(strings ?? '')
}

/** translate：ST translate(text, key?) 一期返回原文。 */
export function translate(text, _key) {
	return String(text ?? '')
}

/** 取当前语言（一期固定返回 'en'，二期接 beilu 语言态）。 */
export function getCurrentLocale() {
	return 'en'
}

/** 应用翻译到 DOM（一期 no-op：原文即已在 DOM 上）。 */
export function applyLocale(root) {
	return root
}

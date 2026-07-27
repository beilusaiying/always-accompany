/**
 * 从斜杠分隔的正则表达式字符串中获取一个真正的正则表达式对象。
 *
 * 此函数使用 `/` 作为分隔符，正则表达式内部的每个 `/` 都必须转义。
 * 标志是可选的，但只能是 JavaScript 的 `RegExp` 支持的有效标志（`g`、`i`、`m`、`s`、`u`、`y`）。
 *
 * @param {string} input - 一个带分隔符的正则表达式字符串。
 * @returns {RegExp} 正则表达式对象。
 */
export function parseRegexFromString(input) {
	// Extracting the regex pattern and flags
	const match = input.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!match) throw new Error(`Invalid regex string: ${input}`)

	let [, pattern, flags] = match

	// If we find any unescaped slash delimiter, we also exit out.
	// JS doesn't care about delimiters inside regex patterns, but for this to be a valid regex outside of our implementation,
	// we have to make sure that our delimiter is correctly escaped. Or every other engine would fail.
	if (pattern.match(/(^|[^\\])\//)) throw new Error(`there is an unescaped slash in the regex: ${input}`)

	// Now we need to actually unescape the slash delimiters, because JS doesn't care about delimiters
	pattern = pattern.replace('\\/', '/')

	// Then we return the regex. If it fails, it was invalid syntax.
	return new RegExp(pattern, flags)
}

// 收口: escapeRegExp/unescapeRegExp 逐字等价副本 → re-export 权威 scripts/escape.mjs
export { escapeRegExp, unescapeRegExp } from '../../scripts/escape.mjs'

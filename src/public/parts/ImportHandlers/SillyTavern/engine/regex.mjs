import { parseRegexFromString } from './tools.mjs'

/**
 * 从 String.prototype.replace 回调的 ...args 中提取纯捕获组
 * @param {Array} args - replace 回调中 match 后的所有参数
 * @returns {Array} 只包含捕获组的数组
 */
function extractCaptureGroups(args) {
	for (let i = 0; i < args.length; i++) {
		if (typeof args[i] === 'number') {
			return args.slice(0, i)
		}
	}
	return args
}

/**
 * 对匹配结果应用 trimStrings 过滤
 * @param {string} str - 原始字符串
 * @param {string[]} trimStrings - 需要修剪的字符串列表
 * @returns {string} 过滤后的字符串
 */
function filterString(str, trimStrings) {
	if (!Array.isArray(trimStrings)) return str
	let result = str
	for (const trim of trimStrings) {
		if (trim) result = result.replaceAll(trim, '')
	}
	return result
}

/**
 * 运行正则表达式
 *
 * 与酒馆 runRegexScript 行为对齐：
 * - 使用回调函数模式替代原生 replace 的字符串替换
 * - 手动处理 $N 和 $<name> 捕获组替换
 * - 避免 $$/$&/$`/$' 等特殊替换模式被错误解释
 *
 * @param {import('./charData.mjs').v2CharData} charData 角色数据
 * @param {string} text 文本
 * @param {(e: import('./charData.mjs').regex_script_info) => boolean} filter 过滤器
 * @returns {string} 处理后的文本。
 */
export function runRegex(charData, text, filter = e => true) {
	if (charData?.extensions?.regex_scripts) {
		const WI_regex_scripts = charData.extensions.regex_scripts.filter(filter)
		for (const script of WI_regex_scripts)
			script.findRegexObject = parseRegexFromString(String(script.findRegex)) || new RegExp(script.findRegex)

		for (const script of WI_regex_scripts) {
			if (!script.findRegexObject || !script.replaceString) {
				// 空替换字符串时保持原生 replace 行为（用于删除匹配内容）
				text = text.replace(script.findRegexObject, script.replaceString || '')
				continue
			}

			text = text.replace(script.findRegexObject, function (match, ...args) {
				const groups = extractCaptureGroups(args)

				// 将 {{match}} 转换为 $0（与酒馆一致）
				let replaceStr = script.replaceString.replace(/\{\{match\}\}/gi, '$0')

				// 使用正则精确匹配 $N 和 $<name>，与酒馆 runRegexScript 行为对齐
				const replaceWithGroups = replaceStr.replace(/\$(\d+)|\$<([^>]+)>/g, (_placeholder, num, groupName) => {
					let value
					if (num !== undefined) {
						const idx = Number(num)
						if (idx === 0) {
							value = match  // $0 = 完整匹配
						} else {
							value = groups[idx - 1]  // $1 = groups[0], ...
						}
					} else if (groupName) {
						// 命名捕获组：从最后一个参数（namedGroups 对象）中取
						const namedGroups = args[args.length - 1]
						if (namedGroups && typeof namedGroups === 'object') {
							value = namedGroups[groupName]
						}
					}

					if (value === undefined || value === null) {
						return ''  // 与酒馆一致：未匹配的捕获组返回空字符串
					}

					// 应用 trimStrings 过滤（与酒馆 filterString 对齐）
					return filterString(String(value), script.trimStrings)
				})

				return replaceWithGroups
			})
		}

		for (const script of WI_regex_scripts)
			delete script.findRegexObject
	}

	return text
}

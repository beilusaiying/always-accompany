/**
 * SillyTavern 宏引擎
 *
 * 支持的宏:
 * - {{user}}, {{char}}, <user>, <bot>, <char>
 * - {{time}}, {{date}}, {{weekday}}, {{isotime}}, {{isodate}}
 * - {{idle_duration}}, {{lasttime}}, {{lastdate}}
 * - {{getvar::name}}, {{setvar::name::value}}, {{addvar::name::value}}
 * - {{getglobalvar::name}}, {{setglobalvar::name::value}}
 * - {{incvar::name}}, {{decvar::name}}, {{incglobalvar::name}}, {{decglobalvar::name}}
 * - {{random::a,b,c}}, {{pick::a,b,c}}, {{roll:1d6}}
 * - {{reverse::text}}, {{newline}}, {{trim}}, {{noop}}
 * - {{timediff::time1::time2}}, {{banned "word"}}
 * - {{datetimeformat FORMAT}}, {{time_utc+N}}
 * - 以及 env 中的自定义变量
 */

import sha256 from 'npm:crypto-js/sha256.js'
import droll from 'npm:droll'
import moment from 'npm:moment/moment.js'
import seedrandom from 'npm:seedrandom'

/**
 * 字符串哈希
 * @param {string} str 字符串
 * @returns {string} 字符串的 SHA256 哈希值。
 */
const STRING_HASH = str => sha256(str).toString()

/**
 * 获取变量
 * @param {any} memory 内存
 * @param {any} name 名称
 * @param {any} args 参数
 * @param {any} isGlobal 是否全局
 * @returns {any} 获取到的变量值。
 */
function getVariable(memory, name, args = {}, isGlobal = false) {
	const storage = isGlobal ? memory?.globalVariables : memory?.variables
	if (!storage) return ''
	let variable = storage[args.key || name]
	if (args.index !== undefined) try {
		variable = JSON.parse(variable)
		variable = variable?.[args.index]
		if (variable instanceof Object) variable = JSON.stringify(variable)
	} catch { }

	return variable === '' || isNaN(Number(variable)) ? variable || '' : Number(variable)
}

/**
 * 设置变量
 * @param {any} memory 内存
 * @param {any} name 名称
 * @param {any} value 值
 * @param {any} args 参数
 * @param {any} isGlobal 是否全局
 * @returns {any} 设置的变量值。
 */
function setVariable(memory, name, value, args = {}, isGlobal = false) {
	const storage = isGlobal ? memory.globalVariables ??= {} : memory.variables ??= {}
	if (args.index !== undefined) {
		// T019：旧版 catch{} 吞错后 fallthrough 到 storage[name]=value——现值损坏时整个容器被
		// 字符串覆盖，上层持久化时间接写回销毁。现按 index 写失败=报错中止，容器不动。
		let current
		try { current = JSON.parse(storage[name] ?? 'null') }
		catch (e) { throw new Error(`setVariable: 变量 "${name}" 现值不是合法 JSON，拒绝按 index 写入以免覆盖容器（${e.message}）`) }
		if (current === null) current = Number.isNaN(Number(args.index)) ? {} : []
		current[args.index] = value
		storage[name] = JSON.stringify(current)
		return value
	}

	return storage[name] = value
}

/**
 * 修改变量
 * @param {any} memory 内存
 * @param {any} name 名称
 * @param {any} value 值
 * @param {boolean} isGlobal 是否全局
 * @param {string} operation 操作
 * @returns {any} 修改后的变量值。
 */
function modifyVariable(memory, name, value, isGlobal = false, operation = 'add') {
	const currentValue = getVariable(memory, name, {}, isGlobal) || 0
	let newValue

	try {
		const parsedValue = JSON.parse(currentValue)
		if (Array.isArray(parsedValue)) {
			parsedValue.push(value)
			return setVariable(memory, name, JSON.stringify(parsedValue), {}, isGlobal)
		}
	} catch { }

	const increment = Number(value)

	if (isNaN(increment) || isNaN(Number(currentValue)))
		newValue = String(currentValue || '') + value
	else {
		newValue = Number(currentValue) + (operation === 'add' ? increment : -increment)
		if (isNaN(newValue)) return ''
	}

	return setVariable(memory, name, newValue, {}, isGlobal)
}


/**
 * 替换变量宏
 * @param {any} input 输入
 * @param {any} memory 内存
 * @returns {any} 替换宏后的字符串。
 */
function replaceVariableMacros(input, memory) {
	if (!input || !input.includes('{{')) return input

	return input.split('\n').map(line => {
		if (!line || !line.includes('{{')) return line

		line = line.replace(/{{(getvar|getglobalvar)::([^}]+)}}/gi, (_, type, name) => {
			name = name.trim()
			return getVariable(memory, name, {}, type === 'getglobalvar')
		})

		line = line.replace(/{{(setvar|setglobalvar)::([^:]+)::([^}]+)}}/gi, (_, type, name, value) => {
			name = name.trim()
			setVariable(memory, name, value, {}, type === 'setglobalvar')
			return ''
		})

		line = line.replace(/{{(addvar|addglobalvar)::([^:]+)::([^}]+)}}/gi, (_, type, name, value) => {
			name = name.trim()
			modifyVariable(memory, name, value, type === 'addglobalvar', 'add')
			return ''
		})

		line = line.replace(/{{(incvar|incglobalvar)::([^}]+)}}/gi, (_, type, name) => {
			name = name.trim()
			return modifyVariable(memory, name, 1, type === 'incglobalvar', 'add')
		})

		line = line.replace(/{{(decvar|decglobalvar)::([^}]+)}}/gi, (_, type, name) => {
			name = name.trim()
			return modifyVariable(memory, name, 1, type === 'decglobalvar', 'sub')
		})

		return line
	}).join('\n')
}

/**
 * 获取自上次消息以来的时间
 * @param {any} chatLog 聊天记录
 * @returns {string} 一个描述时间间隔的字符串。
 */
function getTimeSinceLastMessage(chatLog) {
	if (!chatLog?.length) return 'just now'
	const lastMessage = chatLog
		.filter(message => message.role !== 'system')
		.toReversed()
		.find((_, index, arr) => arr[index + 1]?.role === 'user')
	if (lastMessage?.time_stamp)
		return moment.duration(moment().diff(lastMessage.time_stamp)).humanize()

	return 'just now'
}

/**
 * 随机替换
 * @param {any} input 输入
 * @param {any} emptyListPlaceholder 空列表占位符
 * @returns {any} 替换后的字符串。
 */
function randomReplace(input, emptyListPlaceholder = '') {
	return input.replace(/{{random\s?::?([^]*?)}}/gi, (_, listString) => {
		const list = listString.split(/(?<!\\),/g).map(item => item.replace(/\\,/g, ',').trim())
		if (!list.length) return emptyListPlaceholder
		const randomIndex = Math.floor(seedrandom('added entropy.', { entropy: true })() * list.length)
		return list[randomIndex]
	})
}

/**
 * 挑选替换
 * @param {any} input 输入
 * @param {any} rawContent 原始内容
 * @param {any} emptyListPlaceholder 空列表占位符
 * @returns {any} 替换后的字符串。
 */
function pickReplace(input, rawContent, emptyListPlaceholder = '') {
	return input.replace(/{{pick\s?::?([^]*?)}}/gi, (_, listString, offset) => {
		const list = listString.split(/(?<!\\),/g).map(item => item.replace(/\\,/g, ',').trim())
		if (!list.length) return emptyListPlaceholder
		const randomIndex = Math.floor(seedrandom(STRING_HASH(`${STRING_HASH(rawContent)}-${offset}`))() * list.length)
		return list[randomIndex]
	})
}

/**
 * 掷骰子替换
 * @param {any} input 输入
 * @param {any} invalidRollPlaceholder 无效掷骰占位符
 * @returns {any} 替换后的字符串。
 */
function diceRollReplace(input, invalidRollPlaceholder = '') {
	return input.replace(/{{roll[ :]([^}]+)}}/gi, (_, formula) => {
		formula = formula.trim()
		if (/^\d+$/.test(formula)) formula = `1d${formula}`
		return droll.validate(formula) ? String(droll.roll(formula).total) : invalidRollPlaceholder
	})
}

/**
 * 时间差替换
 * @param {any} input 输入
 * @returns {any} 替换后的字符串。
 */
function timeDiffReplace(input) {
	return input.replace(/{{timediff::(.*?)::(.*?)}}/gi, (_, time1, time2) =>
		moment.duration(moment(time1).diff(moment(time2))).humanize()
	)
}

/**
 * 违禁词替换
 * @param {any} inText 输入文本
 * @returns {any} 替换后的字符串。
 */
function bannedWordsReplace(inText) {
	return inText ? inText.replaceAll(/{{banned "([^"]*)"}}/gi, '') : ''
}

/**
 * 动态值 → 安全替换器（0803 函数式替换收口，凛倾拍板）。
 * 根因：String.replace 的字符串形态第二参会解释 $&/$'/$`/$1 等替换模式——动态宏值
 * （workspace_tree/plugin_* 大段内容、用户名等）偶含 $ 序列即被吃字变形。
 * 函数替换器的返回值按字面使用、不解释模式（根修，非转义补丁）。
 * 容错：值为函数则调用取值（旧行为=直接当 replacer 调用，返回值同样按字面用，等价）；
 * null/undefined → ''（旧行为会把字面 "undefined" 写进正文）；取值抛错 → 保留宏原文
 * 不炸整条宏链（可见可诊断，不静默吞）。
 * @param {any} value 环境值（字符串/函数/任意）
 * @returns {(match: string) => string}
 */
function _literalReplacer(value) {
	return (match) => {
		try {
			const v = value instanceof Function ? value() : value
			return v == null ? '' : String(v)
		} catch {
			return match
		}
	}
}

/** RegExp 元字符转义（env 键名进 new RegExp 前必转——键含 .()[] 等时旧代码误匹配或直接 throw）。 */
function _reEscape(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 评估宏
 * @param {string} content 内容
 * @param {any} env 环境
 * @param {any} memory 内存
 * @param {any} chatLog 聊天记录
 * @returns {string} 评估宏后的字符串。
 */
export function evaluateMacros(content, env, memory = {}, chatLog = []) {
	if (!content) return ''
	const rawContent = content

	content = content
		.replace(/<user>/gi, _literalReplacer(env.user))
		.replace(/<bot>|<char>/gi, _literalReplacer(env.char))
		.replace(/<charifnotgroup>|<group>/gi, _literalReplacer(env.group))

	if (!content.includes('{{')) return content

	content = content.replace(/{{reverse::(.*?)}}/gi, (_, str) => str.split('').reverse().join(''))

	content = diceRollReplace(content)
	content = replaceVariableMacros(content, memory)
	content = content.replace(/{{newline}}/gi, '\n')
	content = content.replace(/\n*{{trim}}\n*/gi, '')
	content = content.replace(/{{noop}}/gi, '')

	for (const varName in env)
		if (Object.hasOwn(env, varName))
			content = content.replace(new RegExp(`{{${_reEscape(varName)}}}`, 'gi'), _literalReplacer(env[varName]))

	content = content.replace(/{{\/\/([\S\s]*?)}}/gm, '')
	content = content.replace(/{{lasttime}}/gi, () => {
		const lastMessage = chatLog?.findLast(message => message.role !== 'system')
		return lastMessage?.time_stamp ? moment(lastMessage.time_stamp).format('LT') : ''
	})
	content = content.replace(/{{lastdate}}/gi, () => {
		const lastMessage = chatLog?.findLast(message => message.role !== 'system')
		return lastMessage?.time_stamp ? moment(lastMessage.time_stamp).format('LL') : ''
	})
	content = content.replace(/{{time}}/gi, () => moment().format('LT'))
	content = content.replace(/{{date}}/gi, () => moment().format('LL'))
	content = content.replace(/{{weekday}}/gi, () => moment().format('dddd'))
	content = content.replace(/{{isotime}}/gi, () => moment().format('HH:mm'))
	content = content.replace(/{{isodate}}/gi, () => moment().format('YYYY-MM-DD'))
	content = content.replace(/{{datetimeformat +([^}]*)}}/gi, (_, format) => moment().format(format))
	content = content.replace(/{{idle_duration}}/gi, () => getTimeSinceLastMessage(chatLog))
	content = content.replace(/{{time_utc([+-]\d+)}}/gi, (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT'))

	content = timeDiffReplace(content)
	content = bannedWordsReplace(content)
	content = randomReplace(content)
	content = pickReplace(content, rawContent)
	content = replaceVariableMacros(content, memory)

	return content
}
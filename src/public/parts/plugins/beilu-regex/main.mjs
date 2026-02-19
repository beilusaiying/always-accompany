import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import info from './info.json' with { type: 'json' }

// ============================================================
// 持久化
// ============================================================

const __pluginDir = dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = join(__pluginDir, 'config_data.json')

/**
 * 将 pluginData 保存到磁盘
 */
function saveConfigToDisk() {
	try {
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(pluginData, null, 2), 'utf-8')
	} catch (e) {
		console.warn('[beilu-regex] 保存配置到磁盘失败:', e.message)
	}
}

/**
 * 从磁盘读取配置
 * @returns {object|null}
 */
function loadConfigFromDisk() {
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
		}
	} catch (e) {
		console.warn('[beilu-regex] 从磁盘读取配置失败:', e.message)
	}
	return null
}

// ============================================================
// 正则工具函数
// ============================================================

/**
 * 从斜杠分隔的正则字符串解析为 RegExp 对象
 * @param {string} input - 形如 /pattern/flags 的正则字符串
 * @returns {RegExp|null}
 */
function parseRegexFromString(input) {
	if (!input) return null
	const match = input.match(/^\/([\W\w]+?)\/([gimsuy]*)$/)
	if (!match) {
		// 不是 /pattern/flags 格式，尝试当作纯字符串
		try { return new RegExp(input, 'g') } catch { return null }
	}
	let [, pattern, flags] = match
	pattern = pattern.replace('\\/', '/')
	try { return new RegExp(pattern, flags) } catch { return null }
}

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

// ============================================================
// ST 正则脚本完整格式
// ============================================================

/**
 * @typedef {Object} RegexScript
 * @property {string} id - 唯一 ID
 * @property {string} scriptName - 规则名称
 * @property {string} findRegex - 查找正则 (斜杠分隔或纯字符串)
 * @property {string} replaceString - 替换字符串 (支持 $1, {{match}} 等)
 * @property {string} trimStrings - 替换前要修剪的文本（换行分隔多条）
 * @property {string[]} placement - 应用位置: user_input, ai_output, slash_command, world_info, reasoning
 * @property {boolean} disabled - 是否禁用（编辑器级别，禁用后脚本命令也无法触发）
 * @property {boolean} runOnEdit - 编辑消息时是否运行
 * @property {number} substituteRegex - 宏替换模式: 0=不替换, 1=原始, 2=转义
 * @property {number} minDepth - 最小消息深度 (-1 或空 = 无限, 0 = 最新消息)
 * @property {number} maxDepth - 最大消息深度 (0 = 无限)
 * @property {boolean} markdownOnly - 仅显示格式（不改变聊天文件/提示词）
 * @property {boolean} promptOnly - 仅提示词格式（不改变聊天文件/显示）
 * @property {'global'|'scoped'|'preset'} scope - 作用域: global=全局, scoped=角色绑定, preset=预设绑定
 */

/**
 * 创建默认正则规则
 * @param {Partial<RegexScript>} [overrides]
 * @returns {RegexScript}
 */
function createDefaultRule(overrides = {}) {
	return {
		id: generateId(),
		scriptName: '',
		findRegex: '',
		replaceString: '',
		trimStrings: '',
		placement: ['ai_output'],
		disabled: false,
		runOnEdit: false,
		substituteRegex: 0,
		minDepth: -1,
		maxDepth: 0,
		markdownOnly: false,
		promptOnly: false,
		scope: 'global',
		boundCharName: '',
		...overrides,
	}
}

// ============================================================
// 正则执行引擎
// ============================================================

/**
 * 对文本应用单条正则规则
 * @param {string} text - 输入文本
 * @param {RegexScript} rule - 规则
 * @param {Object} [macroValues] - 宏替换值（{{user}}, {{char}} 等）
 * @returns {string} 处理后的文本
 */
function applySingleRule(text, rule, macroValues = {}) {
	if (!text || !rule.findRegex) return text

	let findStr = rule.findRegex

	// 宏替换（在正则中替换 {{user}} 等）
	if (rule.substituteRegex > 0 && macroValues) {
		for (const [key, value] of Object.entries(macroValues)) {
			const macroPattern = `{{${key}}}`
			if (findStr.includes(macroPattern)) {
				const replacement = rule.substituteRegex === 2
					? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // 转义模式
					: value // 原始模式
				findStr = findStr.replaceAll(macroPattern, replacement)
			}
		}
	}

	const regexObj = parseRegexFromString(findStr)
	if (!regexObj) return text

	// trimStrings 处理：在替换前先从匹配文本中移除指定字符串
	let replaceStr = rule.replaceString || ''
	const trimList = rule.trimStrings
		? rule.trimStrings.split('\n').filter(s => s.length > 0)
		: []

	if (trimList.length > 0) {
		text = text.replace(regexObj, (match, ...groups) => {
			let trimmed = match
			for (const trim of trimList) {
				trimmed = trimmed.replaceAll(trim, '')
			}
			// 用 {{match}} 宏插入修剪后的匹配文本
			let result = replaceStr.replaceAll('{{match}}', trimmed)
			// 替换捕获组 $1, $2, etc.
			for (let i = 0; i < groups.length; i++) {
				if (typeof groups[i] === 'string') {
					result = result.replaceAll(`$${i + 1}`, groups[i])
				}
			}
			return result
		})
	} else {
		// 无 trimStrings，标准替换
		text = text.replace(regexObj, (match, ...groups) => {
			let result = replaceStr.replaceAll('{{match}}', match)
			for (let i = 0; i < groups.length; i++) {
				if (typeof groups[i] === 'string') {
					result = result.replaceAll(`$${i + 1}`, groups[i])
				}
			}
			return result
		})
	}

	return text
}

/**
 * 对文本应用正则规则列表
 * @param {string} text - 输入文本
 * @param {RegexScript[]} rules - 规则列表
 * @param {string} placementFilter - 应用位置过滤
 * @param {Object} [options]
 * @param {number} [options.messageDepth] - 消息深度
 * @param {Object} [options.macroValues] - 宏替换值
 * @param {boolean} [options.isEdit] - 是否为编辑操作
 * @returns {string} 处理后的文本
 */
function applyRegexRules(text, rules, placementFilter, options = {}) {
	if (!rules || !Array.isArray(rules) || rules.length === 0) return text
	if (!text || typeof text !== 'string') return text

	const { messageDepth = 0, macroValues = {}, isEdit = false, currentCharName = '' } = options

	for (const rule of rules) {
		if (rule.disabled) continue
		if (!rule.placement || !rule.placement.includes(placementFilter)) continue

		// 作用域过滤：scoped 规则只对绑定的角色生效
		if (rule.scope === 'scoped' && rule.boundCharName && currentCharName) {
			if (rule.boundCharName !== currentCharName) continue
		}

		// 深度范围检查
		const minD = rule.minDepth ?? -1
		const maxD = rule.maxDepth ?? 0
		if (minD >= 0 && messageDepth < minD) continue
		if (maxD > 0 && messageDepth > maxD) continue

		// 编辑检查
		if (isEdit && !rule.runOnEdit) continue

		// 瞬时性检查 — markdownOnly 的规则不应在 prompt 构建阶段运行
		if (rule.markdownOnly && placementFilter !== 'display') continue
		// promptOnly 的规则不应在显示阶段运行
		if (rule.promptOnly && placementFilter === 'display') continue

		text = applySingleRule(text, rule, macroValues)
	}

	return text
}

/**
 * 测试模式：对输入文本应用单条规则，返回结果
 * @param {string} input - 测试输入
 * @param {RegexScript} rule - 要测试的规则
 * @param {Object} [macroValues] - 宏替换值
 * @returns {{ output: string, matched: boolean }}
 */
function testRule(input, rule, macroValues = {}) {
	if (!input || !rule.findRegex) return { output: input, matched: false }
	const output = applySingleRule(input, rule, macroValues)
	return { output, matched: output !== input }
}

/**
 * 从 ST 角色卡的 extensions.regex_scripts 导入正则规则
 * @param {object[]} stScripts - ST 格式的正则脚本
 * @param {'global'|'scoped'|'preset'} [scope='global'] - 导入到哪个作用域
 * @returns {RegexScript[]}
 */
function importFromSTFormat(stScripts, scope = 'global', boundCharName = '') {
	if (!Array.isArray(stScripts)) return []

	return stScripts.map(script => {
		// placement 可以是数组或旧版数字/字符串格式
		let placement = ['ai_output']
		if (script.placement !== undefined) {
			if (Array.isArray(script.placement)) {
				placement = script.placement
			} else if (typeof script.placement === 'number') {
				const map = { 0: ['ai_output'], 1: ['user_input'], 2: ['slash_command'], 3: ['world_info'] }
				placement = map[script.placement] || ['ai_output']
			} else if (typeof script.placement === 'string') {
				placement = [script.placement]
			}
		}

		// ST 新版 placement 字段可能用 boolean flags
		if (script.user_input !== undefined || script.ai_output !== undefined) {
			placement = []
			if (script.user_input) placement.push('user_input')
			if (script.ai_output) placement.push('ai_output')
			if (script.slash_command) placement.push('slash_command')
			if (script.world_info) placement.push('world_info')
			if (script.reasoning) placement.push('reasoning')
		}

		return createDefaultRule({
			scriptName: script.scriptName || script.name || '',
			findRegex: script.findRegex || '',
			replaceString: script.replaceString || '',
			trimStrings: Array.isArray(script.trimStrings)
				? script.trimStrings.join('\n')
				: (script.trimStrings || ''),
			placement,
			disabled: script.disabled || false,
			runOnEdit: script.runOnEdit || false,
			substituteRegex: script.substituteRegex ?? 0,
			minDepth: script.minDepth ?? -1,
			maxDepth: script.maxDepth ?? 0,
			markdownOnly: script.markdownOnly || false,
			promptOnly: script.promptOnly || false,
			scope,
			boundCharName,
		})
	})
}

/**
 * 将规则导出为 ST 兼容格式
 * @param {RegexScript} rule
 * @returns {object}
 */
function exportToSTFormat(rule) {
	return {
		scriptName: rule.scriptName,
		findRegex: rule.findRegex,
		replaceString: rule.replaceString,
		trimStrings: rule.trimStrings ? rule.trimStrings.split('\n') : [],
		placement: rule.placement,
		disabled: rule.disabled,
		runOnEdit: rule.runOnEdit,
		substituteRegex: rule.substituteRegex,
		minDepth: rule.minDepth,
		maxDepth: rule.maxDepth,
		markdownOnly: rule.markdownOnly,
		promptOnly: rule.promptOnly,
	}
}

// ============================================================
// 插件数据
// ============================================================

let pluginData = {
	rules: [],       // RegexScript[] — 所有规则（global + scoped + preset）
	enabled: true,   // 全局开关
	renderMode: 'sandbox', // 'sandbox' | 'free' — 美化渲染模式
}

// ============================================================
// beilu-regex 插件导出
// ============================================================

/**
 * beilu-regex 插件 — 完整 ST 风格正则脚本引擎
 *
 * 功能：
 * - 三级作用域：global（全局）、scoped（角色绑定）、preset（预设绑定）
 * - 完整 ST 字段：trimStrings、runOnEdit、substituteRegex、depth、ephemerality
 * - 测试模式：输入文本 → 实时预览输出
 * - TweakPrompt: 对发送给 AI 的消息应用正则
 * - ReplyHandler: 对 AI 回复应用正则
 * - 导入/导出 ST 兼容格式
 */
const pluginExport = {
	info,
	Load: async ({ router }) => {
		console.log('[beilu-regex] 插件加载中...')

		// 从磁盘恢复数据
		try {
			const saved = loadConfigFromDisk()
			if (saved) {
				if (Array.isArray(saved.rules)) pluginData.rules = saved.rules
				if (saved.enabled !== undefined) pluginData.enabled = saved.enabled
				console.log(`[beilu-regex] 已恢复 ${pluginData.rules.length} 条正则规则`)
			} else {
				console.log('[beilu-regex] 无已保存规则，等待导入')
			}
		} catch (e) {
			console.warn('[beilu-regex] 加载配置失败:', e.message)
		}

		// ---- 注册 HTTP API 端点 ----
		router.get('/api/parts/plugins\\:beilu-regex/config/getdata', async (req, res) => {
			try {
				const data = await pluginExport.interfaces.config.GetData()
				res.json(data)
			} catch (err) {
				console.error('[beilu-regex] GetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-regex/config/setdata', async (req, res) => {
			try {
				const result = await pluginExport.interfaces.config.SetData(req.body)
				res.json(result || { success: true })
			} catch (err) {
				console.error('[beilu-regex] SetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: async () => {
		console.log('[beilu-regex] 插件卸载')
	},
	interfaces: {
		config: {
			GetData: async () => ({
				rules: pluginData.rules,
				enabled: pluginData.enabled,
				renderMode: pluginData.renderMode || 'sandbox',
				_actions: [
					'addRule', 'removeRule', 'updateRule', 'reorder',
					'importST', 'exportRule', 'exportAll',
					'toggleAll', 'duplicateRule', 'testRule',
					'moveScope', 'batchToggle', 'removeByChar',
					'setRenderMode',
				],
				_stats: {
					total: pluginData.rules.length,
					enabled: pluginData.rules.filter(r => !r.disabled).length,
					global: pluginData.rules.filter(r => r.scope === 'global').length,
					scoped: pluginData.rules.filter(r => r.scope === 'scoped').length,
					preset: pluginData.rules.filter(r => r.scope === 'preset').length,
				},
			}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						case 'addRule': {
							const newRule = createDefaultRule(data.rule || {})
							pluginData.rules.push(newRule)
							saveConfigToDisk()
							return { _result: { id: newRule.id } }
						}
						case 'removeRule': {
							pluginData.rules = pluginData.rules.filter(r => r.id !== data.ruleId)
							saveConfigToDisk()
							break
						}
						case 'updateRule': {
							const idx = pluginData.rules.findIndex(r => r.id === data.rule?.id)
							if (idx !== -1) {
								pluginData.rules[idx] = { ...pluginData.rules[idx], ...data.rule }
							}
							saveConfigToDisk()
							break
						}
						case 'duplicateRule': {
							const src = pluginData.rules.find(r => r.id === data.ruleId)
							if (src) {
								const dup = { ...src, id: generateId(), scriptName: src.scriptName + ' (copy)' }
								const srcIdx = pluginData.rules.indexOf(src)
								pluginData.rules.splice(srcIdx + 1, 0, dup)
								saveConfigToDisk()
								return { _result: { id: dup.id } }
							}
							break
						}
						case 'moveScope': {
							const rule = pluginData.rules.find(r => r.id === data.ruleId)
							if (rule && data.newScope) {
								rule.scope = data.newScope
							}
							saveConfigToDisk()
							break
						}
						case 'importST': {
							const scope = data.scope || 'global'
							const boundCharName = data.boundCharName || ''
							const imported = importFromSTFormat(data.scripts || [], scope, boundCharName)
							pluginData.rules.push(...imported)
							saveConfigToDisk()
							console.log(`[beilu-regex] 导入 ${imported.length} 条 ST 正则脚本 (scope: ${scope}${boundCharName ? ', char: ' + boundCharName : ''})`)
							return { _result: { count: imported.length } }
						}
						case 'removeByChar': {
							const charName = data.charName
							if (charName) {
								const before = pluginData.rules.length
								pluginData.rules = pluginData.rules.filter(r => r.boundCharName !== charName)
								saveConfigToDisk()
								console.log(`[beilu-regex] 已清理角色 "${charName}" 绑定的 ${before - pluginData.rules.length} 条正则规则`)
								return { _result: { removed: before - pluginData.rules.length } }
							}
							break
						}
						case 'exportRule': {
							const rule = pluginData.rules.find(r => r.id === data.ruleId)
							if (rule) {
								return { _result: exportToSTFormat(rule) }
							}
							break
						}
						case 'exportAll': {
							const scope = data.scope || null
							const toExport = scope
								? pluginData.rules.filter(r => r.scope === scope)
								: pluginData.rules
							return { _result: toExport.map(exportToSTFormat) }
						}
						case 'testRule': {
							const result = testRule(data.input || '', data.rule || {}, data.macroValues || {})
							return { _result: result }
						}
						case 'toggleAll': {
							pluginData.enabled = !!data.enabled
							saveConfigToDisk()
							break
						}
						case 'setRenderMode': {
							if (data.renderMode === 'sandbox' || data.renderMode === 'free') {
								pluginData.renderMode = data.renderMode
								saveConfigToDisk()
								console.log(`[beilu-regex] 渲染模式已切换为: ${data.renderMode}`)
							}
							break
						}
						case 'batchToggle': {
							if (Array.isArray(data.ruleIds)) {
								for (const id of data.ruleIds) {
									const r = pluginData.rules.find(x => x.id === id)
									if (r) r.disabled = !!data.disabled
								}
							}
							saveConfigToDisk()
							break
						}
						case 'reorder': {
							if (Array.isArray(data.order)) {
								const reordered = []
								for (const id of data.order) {
									const rule = pluginData.rules.find(r => r.id === id)
									if (rule) reordered.push(rule)
								}
								for (const rule of pluginData.rules) {
									if (!data.order.includes(rule.id)) reordered.push(rule)
								}
								pluginData.rules = reordered
							}
							saveConfigToDisk()
							break
						}
						default:
							break
					}
					return
				}

				// 直接覆盖数据
				if (data.rules !== undefined) pluginData.rules = data.rules
				if (data.enabled !== undefined) pluginData.enabled = data.enabled
				saveConfigToDisk()
			},
		},
		chat: {
			/**
			 * TweakPrompt: 对提示词中的用户消息应用 user_input 正则
			 */
			TweakPrompt: async (arg, prompt_struct, my_prompt, detail_level) => {
				if (!pluginData.enabled) return
				if (detail_level !== 0) return

				// 构建宏替换值
				const macroValues = {}
				const currentCharName = prompt_struct?.Charname || ''
				if (prompt_struct) {
					if (prompt_struct.Charname) macroValues.char = prompt_struct.Charname
					if (prompt_struct.UserCharname) macroValues.user = prompt_struct.UserCharname
				}

				// 内置处理：从上下文中剥离思维链标签
				// <thinking>...</thinking> 和 <think>...</think> 不应出现在发送给 AI 的历史中
				const thinkingPatterns = [
					/<thinking>[\s\S]*?<\/thinking>/gi,
					/<think>[\s\S]*?<\/think>/gi,
				]

				// 遍历聊天记录应用正则
				const chatLog = prompt_struct?.chat_log
				if (chatLog && Array.isArray(chatLog)) {
					for (let i = chatLog.length - 1; i >= 0; i--) {
						const entry = chatLog[i]
						if (!entry || !entry.content) continue

						const depth = chatLog.length - 1 - i

						// 内置：剥离 AI 回复中的思维链
						if (entry.role === 'char' || entry.role === 'assistant') {
							for (const pattern of thinkingPatterns) {
								entry.content = entry.content.replace(pattern, '')
							}
							// 清理剥离后可能产生的多余空行
							entry.content = entry.content.replace(/\n{3,}/g, '\n\n').trim()
						}

						if (entry.role === 'user') {
							entry.content = applyRegexRules(
								entry.content,
								pluginData.rules,
								'user_input',
								{ messageDepth: depth, macroValues, currentCharName }
							)
						}
					}
				}

				// 对插件 prompts 应用 world_info 正则
				if (prompt_struct?.plugin_prompts) {
					for (const [key, pp] of Object.entries(prompt_struct.plugin_prompts)) {
						if (pp?.text && Array.isArray(pp.text)) {
							for (const t of pp.text) {
								if (t?.content) {
									t.content = applyRegexRules(
											t.content,
											pluginData.rules,
											'world_info',
											{ macroValues, currentCharName }
										)
								}
							}
						}
					}
				}
			},

			/**
			 * ReplyHandler: 对 AI 回复应用 ai_output 正则
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const macroValues = {}
				const currentCharName = args?.prompt_struct?.Charname || ''
				if (args?.prompt_struct) {
					if (args.prompt_struct.Charname) macroValues.char = args.prompt_struct.Charname
					if (args.prompt_struct.UserCharname) macroValues.user = args.prompt_struct.UserCharname
				}

				reply.content = applyRegexRules(
					reply.content,
					pluginData.rules,
					'ai_output',
					{ messageDepth: 0, macroValues, currentCharName }
				)

				return false
			},
		},
	},
	}
	
	export default pluginExport
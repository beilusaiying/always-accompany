import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'npm:jszip'

import { loadAnyPreferredDefaultPart, loadPart } from '../../../../server/parts_loader.mjs'

import info from './info.json' with { type: 'json' }

// ============================================================
// 内联工具函数（避免跨目录 import 导致 Deno 模块重复加载）
// ============================================================

const __pluginDir = dirname(fileURLToPath(import.meta.url))
// 从插件目录 (src/public/parts/plugins/beilu-memory) 推算项目根目录
// 向上5级: plugins/ → parts/ → public/ → src/ → 项目根
const __projectRoot = path.resolve(__pluginDir, '..', '..', '..', '..', '..')

/**
 * 加载 JSON 文件
 * @param {string} filepath
 * @returns {any}
 */
function loadJsonFile(filepath) {
	return JSON.parse(fs.readFileSync(filepath, 'utf8'))
}

/**
 * 如果文件存在则加载 JSON，否则返回默认值
 * @param {string} filepath
 * @param {any} defaultValue
 * @returns {any}
 */
function loadJsonFileIfExists(filepath, defaultValue = {}) {
	if (fs.existsSync(filepath)) return loadJsonFile(filepath)
	return defaultValue
}

/**
 * 保存 JSON 文件（带目录自动创建）
 * @param {string} filepath
 * @param {any} data
 */
function saveJsonFile(filepath, data) {
	const dir = path.dirname(filepath)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(filepath, JSON.stringify(data, null, '\t') + '\n', 'utf8')
}

/**
 * 获取用户数据目录路径（不依赖 auth.mjs）
 * @param {string} username
 * @returns {string}
 */
function getUserDataDir(username) {
	return path.join(__projectRoot, 'data', 'users', username || '_default')
}

// ============================================================
// 默认表格模板（#0-#9）
// ============================================================

// ============================================================
// 默认记忆预设模板（6个内置预设）
// ============================================================

// 最小骨架：仅保留结构定义，不含提示词内容。
// 实际默认提示词在 default_memory_presets.json 模板文件中维护。
// 此骨架仅作为"模板文件也丢失"时的最终兜底。
const DEFAULT_MEMORY_PRESETS = [
	{
		id: 'P1', name: '检索AI',
		description: '根据当前对话上下文从温/冷层检索相关记忆',
		enabled: true, builtin: true, deletable: false, trigger: 'auto_on_message',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.3, max_tokens: 2000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P1_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P1_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
	{
		id: 'P2', name: '表格总结/归档AI',
		description: '临时记忆超阈值时生成总结并归档到温层',
		enabled: true, builtin: true, deletable: false, trigger: 'auto_on_threshold',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.3, max_tokens: 4000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P2_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P2_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
	{
		id: 'P3', name: '每日总结AI',
		description: '日终时汇总当天事件生成日总结',
		enabled: false, builtin: true, deletable: false, trigger: 'manual_button',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.3, max_tokens: 4000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P3_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P3_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
	{
		id: 'P4', name: '热→温转移AI',
		description: '将热层中过期/低权重的记忆移入温层',
		enabled: false, builtin: true, deletable: false, trigger: 'manual_button',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.3, max_tokens: 4000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P4_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P4_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
	{
		id: 'P5', name: '月度总结/归档AI',
		description: '温层超过30天的日总结生成月总结并移入冷层',
		enabled: false, builtin: true, deletable: false, trigger: 'manual_or_auto',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.3, max_tokens: 4000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P5_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P5_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
	{
		id: 'P6', name: '格式检查/修复AI',
		description: '检查并修复表格和记忆文件中的格式问题',
		enabled: false, builtin: true, deletable: false, trigger: 'manual_button',
		api_config: { use_custom: false, source: '', model: 'gemini-2.0-flash', temperature: 0.1, max_tokens: 4000 },
		prompts: [
			{ role: 'system', content: '', identifier: 'P6_system', enabled: true, builtin: false, deletable: true },
			{ role: 'user', content: '{{chat_history}}', identifier: 'P6_chat_history', enabled: true, builtin: true, deletable: false },
		],
	},
]

// ============================================================
// 默认注入提示词（聊天AI用，2条内置）
// ============================================================

// 最小骨架：仅保留结构定义，不含提示词内容。
// 实际默认提示词在 default_memory_presets.json 模板文件中维护。
// 此骨架仅作为"模板文件也丢失"时的最终兜底。
const DEFAULT_INJECTION_PROMPTS = [
	{
		id: 'INJ-1',
		name: 'dataTable说明',
		description: '向聊天AI注入表格数据和操作规则',
		enabled: true,
		builtin: true,
		deletable: false,
		role: 'system',
		depth: 999,
		order: 100,
		autoMode: 'always',
		content: '',
	},
	{
		id: 'INJ-2',
		name: '文件层AI提示词',
		description: '告诉聊天AI如何通过beilu-files修改用户项目文件（类似Cursor IDE）',
		enabled: true,
		builtin: true,
		deletable: false,
		role: 'system',
		depth: 999,
		order: 200,
		autoMode: 'manual',
		content: '',
	},
]

// ============================================================
// 记忆预设文件操作
// ============================================================

/**
 * 加载记忆预设（若文件不存在则初始化默认预设）
 * @param {string} username
 * @param {string} charName
 * @returns {object[]} 预设数组
 */
function loadMemoryPresets(username, charName) {
	// 预设配置（P1-P6 + INJ）是全局的，始终从 _global 加载，不按角色分
	const memDir = ensureMemoryDir(username, '_global')
	const presetsPath = path.join(memDir, '_memory_presets.json')
	const data = loadJsonFileIfExists(presetsPath, null)
	if (data && data.presets) return data

	// 首次初始化：三级加载优先级
	// 1. 用户已有 _memory_presets.json → 上面已 return
	// 2. 模板文件 default_memory_presets.json → 优先使用
	// 3. 代码骨架 DEFAULT_MEMORY_PRESETS / DEFAULT_INJECTION_PROMPTS → 最终兜底
	let defaults
	const templatePath = path.join(__pluginDir, 'default_memory_presets.json')
	try {
		if (fs.existsSync(templatePath)) {
			const template = loadJsonFile(templatePath)
			if (template && template.presets) {
				defaults = {
					presets: structuredClone(template.presets),
					injection_prompts: structuredClone(template.injection_prompts || DEFAULT_INJECTION_PROMPTS),
				}
				console.log(`[beilu-memory] 从模板文件初始化预设: ${templatePath}`)
			}
		}
	} catch (e) {
		console.warn(`[beilu-memory] 读取模板文件失败，使用代码骨架兜底: ${e.message}`)
	}

	if (!defaults) {
		defaults = {
			presets: structuredClone(DEFAULT_MEMORY_PRESETS),
			injection_prompts: structuredClone(DEFAULT_INJECTION_PROMPTS),
		}
		console.log('[beilu-memory] 模板文件不存在，使用代码骨架初始化预设（空提示词）')
	}

	saveJsonFile(presetsPath, defaults)
	return defaults
}

/**
 * 保存记忆预设到磁盘（presets + injection_prompts 一起保存）
 * @param {string} username
 * @param {string} charName
 * @param {object} presetsData - { presets, injection_prompts }
 */
function saveMemoryPresets(username, charName, presetsData) {
	// 预设配置（P1-P6 + INJ）是全局的，始终保存到 _global，不按角色分
	const memDir = getMemoryDir(username, '_global')
	const presetsPath = path.join(memDir, '_memory_presets.json')
	saveJsonFile(presetsPath, presetsData)
}

// ============================================================
// 默认表格模板（#0-#9）
// ============================================================

const DEFAULT_TABLES = [
	{
		id: 0,
		name: '时空表格',
		columns: ['日期', '时间', '地点（当前描写）', '此地角色'],
		rows: [],
		rules: {
			insert: '当时间/地点/在场角色发生变化时',
			update: '当当前行的信息需要更新时',
			delete: '当转场到新场景且旧场景不再需要时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 1,
		name: '角色特征表格',
		columns: ['角色名', '身体特征', '性格', '职业', '爱好', '喜欢的事物', '住所', '其他重要信息'],
		rows: [],
		rules: {
			insert: '当出现新的角色时',
			update: '当角色特征发生变化时',
			delete: '当角色永久退场时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 2,
		name: '角色与{{user}}社交表格',
		columns: ['角色名', '对{{user}}关系', '对{{user}}态度', '对{{user}}的好感度'],
		rows: [],
		rules: {
			insert: '当出现新的角色与{{user}}的关系时',
			update: '当关系/态度/好感度变化时',
			delete: '当角色永久退场时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 3,
		name: '任务、命令或者约定表格',
		columns: ['角色', '任务', '地点', '持续时间'],
		rows: [],
		rules: {
			insert: '当出现新的任务/命令/约定时',
			update: '当任务状态变化时',
			delete: '当任务完成且已归档时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 4,
		name: '当日临时记忆',
		columns: ['角色', '事件简述', '日期', '地点', '情绪'],
		rows: [],
		rules: {
			insert: '当发生需要记住的事件时',
			update: '当事件状态变化时',
			delete: '仅在归档时由系统执行',
		},
		required: true,
		user_customizable: true,
	},
	{
		id: 5,
		name: '重要物品表格（背包）',
		columns: ['拥有人', '物品描述', '物品名', '重要原因'],
		rows: [],
		rules: {
			insert: '当出现随身携带或当前装备的重要物品时',
			update: '当物品信息变化时',
			delete: '当物品放入仓库（不再随身携带）时，使用moveToStash操作归档',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 6,
		name: '当天事件大总结',
		columns: ['时间', '地点', '事件概述'],
		rows: [],
		rules: {
			insert: '当临时记忆归档时由总结AI生成',
			update: '当总结需要修正时',
			delete: '当日终归档完成后清空',
		},
		required: true,
		user_customizable: true,
	},
	{
		id: 7,
		name: '{{char}}想要记住的关于{{user}}的事情',
		columns: ['日期', '想要记住的事情', '原因'],
		rows: [],
		rules: {
			insert: '当发现值得记住的关于{{user}}的事情时',
			update: '当相关信息需要补充时',
			delete: '当超过3天的条目已归档到热记忆层时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 8,
		name: '{{char}}永远记住的事情',
		columns: ['事件', '日期'],
		rows: [],
		rules: {
			insert: '当发生永远值得记住的重要事件时',
			update: '当事件需要补充信息时',
			delete: '合并重复项时',
		},
		required: false,
		user_customizable: true,
	},
	{
		id: 9,
		name: '时空记忆表格',
		columns: ['日期', '当日总结'],
		rows: [],
		rules: {
			insert: '当日终归档时从#6转入',
			update: '当总结需要修正时',
			delete: '当超过两天的条目需要清理时',
		},
		required: false,
		user_customizable: true,
	},
]

// ============================================================
// 内存缓存（按 charName 索引）
// ============================================================

/** @type {Map<string, { tables: object, config: object, username: string }>} */
const memoryCache = new Map()

// ============================================================
// 文件系统操作
// ============================================================

/**
 * 获取记忆目录路径
 * 新路径: data/users/{user}/chars/{charName}/memory/
 * @param {string} username
 * @param {string} charName
 * @returns {string}
 */
function getMemoryDir(username, charName) {
	return path.join(getUserDataDir(username), 'chars', charName, 'memory')
}

/**
 * 确保记忆目录存在，若不存在则创建并初始化默认文件
 * 如果旧路径 memory/{charName}/ 存在数据，自动迁移到新路径
 * @param {string} username
 * @param {string} charName
 * @returns {string} 记忆目录路径
 */
function ensureMemoryDir(username, charName) {
	const memDir = getMemoryDir(username, charName)

	// 旧路径迁移检查: data/users/{user}/memory/{charName}/
	if (!fs.existsSync(memDir)) {
		const oldMemDir = path.join(getUserDataDir(username), 'memory', charName)
		if (fs.existsSync(oldMemDir)) {
			// 确保新路径父目录存在
			const parentDir = path.dirname(memDir)
			if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })
			// 重命名（移动）旧目录到新路径
			try {
				fs.renameSync(oldMemDir, memDir)
				console.log(`[beilu-memory] 迁移记忆目录: ${oldMemDir} → ${memDir}`)
			} catch (e) {
				// renameSync 跨盘可能失败，回退为递归复制
				console.warn(`[beilu-memory] renameSync 失败，尝试递归复制: ${e.message}`)
				fs.cpSync(oldMemDir, memDir, { recursive: true })
				fs.rmSync(oldMemDir, { recursive: true, force: true })
				console.log(`[beilu-memory] 迁移记忆目录(复制模式): ${oldMemDir} → ${memDir}`)
			}
			return memDir
		}
	}

	if (!fs.existsSync(memDir)) {
		fs.mkdirSync(memDir, { recursive: true })
		// 初始化子目录
		fs.mkdirSync(path.join(memDir, 'hot', 'remember_about_user'), { recursive: true })
		fs.mkdirSync(path.join(memDir, 'warm'), { recursive: true })
		fs.mkdirSync(path.join(memDir, 'cold'), { recursive: true })

		// 初始化默认 tables.json
		saveJsonFile(path.join(memDir, 'tables.json'), { tables: structuredClone(DEFAULT_TABLES) })

		// 初始化默认 _config.json
		saveJsonFile(path.join(memDir, '_config.json'), {
			enabled: true,
			retrieval_ai: { api_key: null, model: 'gemini-2.0-flash', base_url: null, fallback_to_dialogue: true },
			summary_ai: { api_key: null, model: 'gemini-2.0-flash', base_url: null, fallback_to_dialogue: true },
			injection: { tables_token_budget: null, hot_memory_token_budget: 3000, warm_memory_token_budget: 2000, cold_search_enabled: true },
			archive: { temp_memory_threshold: 50, auto_daily_archive: false, cold_archive_after_days: 30 },
			retrieval: { auto_trigger: true, chat_history_count: 5, max_search_rounds: 5, timeout_ms: 60000 },
			pending_tasks: [],
		})

		// 初始化空的热记忆文件
		saveJsonFile(path.join(memDir, 'hot', 'forever.json'), { entries: [] })
		saveJsonFile(path.join(memDir, 'hot', 'items_archive.json'), { items: [] })
		saveJsonFile(path.join(memDir, 'hot', 'appointments.json'), { entries: [] })
		saveJsonFile(path.join(memDir, 'hot', 'user_profile.json'), { entries: [] })
		saveJsonFile(path.join(memDir, 'hot', 'warm_monthly_index.json'), { months: [] })
		saveJsonFile(path.join(memDir, 'warm', 'cold_yearly_index.json'), { years: [] })
	}
	return memDir
}

/**
 * 加载 tables.json 到内存缓存
 * @param {string} username
 * @param {string} charName
 * @returns {{ tables: object[], config: object }}
 */
function loadMemoryData(username, charName) {
	const cacheKey = `${username}/${charName}`
	if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey)

	const memDir = ensureMemoryDir(username, charName)
	const tablesData = loadJsonFileIfExists(path.join(memDir, 'tables.json'), { tables: structuredClone(DEFAULT_TABLES) })
	const configData = loadJsonFileIfExists(path.join(memDir, '_config.json'), { enabled: true })

	const data = { tables: tablesData.tables || [], config: configData, username }
	memoryCache.set(cacheKey, data)
	return data
}

/**
 * 保存 tables.json 到磁盘
 * @param {string} username
 * @param {string} charName
 */
function saveTablesData(username, charName) {
	const cacheKey = `${username}/${charName}`
	const data = memoryCache.get(cacheKey)
	if (!data) return

	const memDir = getMemoryDir(username, charName)
	const tablesPath = path.join(memDir, 'tables.json')

	// 备份
	const bakPath = tablesPath + '.bak'
	if (fs.existsSync(tablesPath)) {
		try { fs.copyFileSync(tablesPath, bakPath) } catch (e) { /* ignore */ }
	}

	saveJsonFile(tablesPath, { tables: data.tables })
}

// ============================================================
// Phase 2: 热记忆层写入 + 归档 + 日终流程
// ============================================================

/**
 * 获取今天的日期字符串 YYYY-MM-DD
 * @returns {string}
 */
function getTodayStr() {
	const now = new Date()
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 获取酒馆兼容时间宏值
 * @param {Array} [chatLog] - chat_log 数组（可选，用于 lasttime/lastdate/idle_duration）
 * @returns {object} { time, date, weekday, idle_duration, lasttime, lastdate }
 */
function getTimeMacroValues(chatLog) {
	const now = new Date()
	const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
	const result = {
		time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
		date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
		weekday: weekdays[now.getDay()],
		idle_duration: '',
		lasttime: '',
		lastdate: '',
	}

	// 尝试从 chat_log 获取最后一条消息的时间
	if (chatLog && Array.isArray(chatLog) && chatLog.length > 0) {
		const lastMsg = chatLog[chatLog.length - 1]
		const ts = lastMsg.timestamp || lastMsg.time || lastMsg.send_date
		const lastTime = ts ? new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts) : now
		if (!isNaN(lastTime.getTime())) {
			result.lasttime = `${String(lastTime.getHours()).padStart(2, '0')}:${String(lastTime.getMinutes()).padStart(2, '0')}`
			result.lastdate = `${lastTime.getFullYear()}年${lastTime.getMonth() + 1}月${lastTime.getDate()}日`
			const diff = now - lastTime
			if (diff < 60000) result.idle_duration = 'just now'
			else if (diff < 3600000) result.idle_duration = `${Math.floor(diff / 60000)} minutes ago`
			else if (diff < 86400000) result.idle_duration = `${Math.floor(diff / 3600000)} hours ago`
			else result.idle_duration = `${Math.floor(diff / 86400000)} days ago`
		}
	}

	return result
}

/**
 * 获取 N 天前的日期字符串
 * @param {number} days
 * @returns {string}
 */
function getDaysAgoStr(days) {
	const d = new Date()
	d.setDate(d.getDate() - days)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * #7 归档：将表格中超过3天的条目移入 hot/remember_about_user/{date}.json
 * 设计文档：表格中只保留近3天的条目，超出3天的归档到 hot/remember_about_user/{date}.json
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number }}
 */
function archiveRememberAboutUser(username, charName) {
	const data = loadMemoryData(username, charName)
	const table7 = data.tables.find(t => t.id === 7)
	if (!table7 || table7.rows.length === 0) return { archived: 0 }

	const threeDaysAgo = getDaysAgoStr(3)
	const toArchive = []
	const toKeep = []

	for (const row of table7.rows) {
		const dateCol = row[0] || '' // 第0列是日期
		if (dateCol && dateCol < threeDaysAgo) {
			toArchive.push(row)
		} else {
			toKeep.push(row)
		}
	}

	if (toArchive.length === 0) return { archived: 0 }

	// 按日期分组归档
	const byDate = {}
	for (const row of toArchive) {
		const date = row[0] || getTodayStr()
		if (!byDate[date]) byDate[date] = []
		byDate[date].push({
			thing: row[1] || '',
			reason: row[2] || '',
			date: date,
		})
	}

	const memDir = getMemoryDir(username, charName)
	const rememberDir = path.join(memDir, 'hot', 'remember_about_user')
	if (!fs.existsSync(rememberDir)) fs.mkdirSync(rememberDir, { recursive: true })

	for (const [date, entries] of Object.entries(byDate)) {
		const filePath = path.join(rememberDir, `${date}.json`)
		const existing = loadJsonFileIfExists(filePath, { entries: [] })
		existing.entries = (existing.entries || []).concat(entries)
		saveJsonFile(filePath, existing)
	}

	// 更新表格
	table7.rows = toKeep
	saveTablesData(username, charName)
	console.log(`[beilu-memory] #7 归档了 ${toArchive.length} 条超过3天的记忆 (${charName})`)
	return { archived: toArchive.length }
}

/**
 * #8 归档：表格超过200条时，溢出条目移入 hot/forever.json
 * 设计文档：表格保留近一周的内容，超过200条 → 溢出条目归档到 hot/forever.json
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number }}
 */
function archiveForeverEntries(username, charName) {
	const data = loadMemoryData(username, charName)
	const table8 = data.tables.find(t => t.id === 8)
	if (!table8 || table8.rows.length <= 200) return { archived: 0 }

	// 保留最新的200条，溢出的归档
	const toKeep = table8.rows.slice(-200) // 保留最后200条（最新的）
	const toArchive = table8.rows.slice(0, table8.rows.length - 200) // 最早的溢出

	const memDir = getMemoryDir(username, charName)
	const foreverPath = path.join(memDir, 'hot', 'forever.json')
	const existing = loadJsonFileIfExists(foreverPath, { entries: [] })

	for (const row of toArchive) {
		existing.entries.push({
			event: row[0] || '',
			date: row[1] || getTodayStr(),
			weight: 1,
			last_triggered: new Date().toISOString(),
		})
	}
	saveJsonFile(foreverPath, existing)

	table8.rows = toKeep
	saveTablesData(username, charName)
	console.log(`[beilu-memory] #8 归档了 ${toArchive.length} 条溢出记忆到 forever.json (${charName})`)
	return { archived: toArchive.length }
}

/**
 * #3 归档：标记为已完成的任务移入 hot/appointments.json
 * 注意：AI通过 deleteRow(3, rowIndex) 删除完成的任务，这里提供手动触发归档
 * @param {string} username
 * @param {string} charName
 * @param {number[]} completedRowIndices - 要归档的行索引列表
 * @returns {{ archived: number }}
 */
function archiveCompletedTasks(username, charName, completedRowIndices) {
	const data = loadMemoryData(username, charName)
	const table3 = data.tables.find(t => t.id === 3)
	if (!table3 || !completedRowIndices || completedRowIndices.length === 0) return { archived: 0 }

	const memDir = getMemoryDir(username, charName)
	const appointmentsPath = path.join(memDir, 'hot', 'appointments.json')
	const existing = loadJsonFileIfExists(appointmentsPath, { entries: [] })

	// 从大到小排序避免索引偏移
	const sorted = [...completedRowIndices].sort((a, b) => b - a)
	let archived = 0

	for (const idx of sorted) {
		if (idx >= 0 && idx < table3.rows.length) {
			const row = table3.rows[idx]
			existing.entries.push({
				character: row[0] || '',
				task: row[1] || '',
				location: row[2] || '',
				duration: row[3] || '',
				completed_at: new Date().toISOString(),
			})
			table3.rows.splice(idx, 1)
			archived++
		}
	}

	if (archived > 0) {
		saveJsonFile(appointmentsPath, existing)
		saveTablesData(username, charName)
		console.log(`[beilu-memory] #3 归档了 ${archived} 个已完成任务 (${charName})`)
	}
	return { archived }
}

/**
 * #4 临时记忆归档：超过阈值时将临时记忆归档到 warm 层
 * 设计文档：超过50条 → 10条一个文件 → 归入 warm/{year}/{month}/{day}_details/
 * AI总结部分留 TODO
 * @param {string} username
 * @param {string} charName
 * @returns {{ archived: number, batchFiles: string[] }}
 */
function archiveTempMemory(username, charName) {
	const data = loadMemoryData(username, charName)
	const table4 = data.tables.find(t => t.id === 4)
	const config = data.config
	const threshold = config?.archive?.temp_memory_threshold || 50

	if (!table4 || table4.rows.length <= threshold) return { archived: 0, batchFiles: [] }

	const today = getTodayStr()
	const [year, month, day] = today.split('-')

	const memDir = getMemoryDir(username, charName)
	const detailsDir = path.join(memDir, 'warm', year, month, `${day}_details`)
	if (!fs.existsSync(detailsDir)) fs.mkdirSync(detailsDir, { recursive: true })

	// 找到已有的最大 batch 编号
	let maxBatch = 0
	if (fs.existsSync(detailsDir)) {
		const existing = fs.readdirSync(detailsDir).filter(f => f.startsWith('batch_'))
		for (const f of existing) {
			const num = parseInt(f.replace('batch_', '').replace('.json', ''), 10)
			if (num > maxBatch) maxBatch = num
		}
	}

	// 将所有行按10条一批归档
	const allRows = [...table4.rows]
	const batchFiles = []
	let batchNum = maxBatch

	for (let i = 0; i < allRows.length; i += 10) {
		batchNum++
		const batch = allRows.slice(i, i + 10)
		const batchEntries = batch.map(row => ({
			character: row[0] || '',
			event: row[1] || '',
			date: row[2] || today,
			location: row[3] || '',
			emotion: row[4] || '',
			archived_at: new Date().toISOString(),
		}))
		const batchFile = `batch_${String(batchNum).padStart(3, '0')}.json`
		saveJsonFile(path.join(detailsDir, batchFile), { entries: batchEntries })
		batchFiles.push(batchFile)
	}

	// 清空 #4 表格
	const archivedCount = table4.rows.length
	table4.rows = []
	saveTablesData(username, charName)

	console.log(`[beilu-memory] #4 归档了 ${archivedCount} 条临时记忆到 ${batchFiles.length} 个 batch 文件 (${charName})`)

	// TODO: 触发总结AI（P2预设）生成 #6 的总结
	// 目前只归档文件，不调用AI

	return { archived: archivedCount, batchFiles }
}

/**
 * #9 时空记忆维护：只保留后两天的内容
 * 设计文档：超过两天的条目删除
 * @param {string} username
 * @param {string} charName
 * @returns {{ removed: number }}
 */
function maintainTimeSpaceTable(username, charName) {
	const data = loadMemoryData(username, charName)
	const table9 = data.tables.find(t => t.id === 9)
	if (!table9 || table9.rows.length === 0) return { removed: 0 }

	const twoDaysAgo = getDaysAgoStr(2)
	const before = table9.rows.length
	table9.rows = table9.rows.filter(row => {
		const date = row[0] || ''
		return date >= twoDaysAgo
	})
	const removed = before - table9.rows.length

	if (removed > 0) {
		saveTablesData(username, charName)
		console.log(`[beilu-memory] #9 清理了 ${removed} 条超过2天的时空记忆 (${charName})`)
	}
	return { removed }
}

/**
 * 日终归档流程（"结束今天"按钮触发）
 * 9个步骤，AI调用部分留 TODO
 * @param {string} username
 * @param {string} charName
 * @returns {{ steps: object[] }}
 */
function endDay(username, charName) {
	const steps = []
	const today = getTodayStr()
	const [year, month, day] = today.split('-')
	const memDir = getMemoryDir(username, charName)
	const data = loadMemoryData(username, charName)

	// Step 1: TODO - 总结AI把 #6 全部条目总结为当天详细内容
	// 目前跳过AI调用，直接用 #6 的原始数据作为日总结
	const table6 = data.tables.find(t => t.id === 6)
	const daySummaryEntries = table6 ? [...table6.rows] : []
	steps.push({ step: 1, action: 'generate_day_summary', status: 'TODO_AI', note: '需要总结AI生成详细日总结，当前使用原始数据' })

	// Step 2: 生成日总结文件 → warm/{year}/{month}/{day}_summary.json
	const warmDir = path.join(memDir, 'warm', year, month)
	if (!fs.existsSync(warmDir)) fs.mkdirSync(warmDir, { recursive: true })
	const summaryPath = path.join(warmDir, `${day}_summary.json`)
	const summaryData = {
		date: today,
		title: `${today} 日总结`,
		summary: daySummaryEntries.map(row => `${row[0] || ''} ${row[1] || ''}: ${row[2] || ''}`).join('\n'),
		key_events: daySummaryEntries.map(row => row[2] || '').filter(Boolean),
		tags: [],
		created_at: new Date().toISOString(),
	}
	saveJsonFile(summaryPath, summaryData)
	steps.push({ step: 2, action: 'save_day_summary', status: 'done', file: summaryPath })

	// Step 3: #9 时空记忆表格 ← 从 #6 转入
	const table9 = data.tables.find(t => t.id === 9)
	if (table9 && table6) {
		// 将 #6 的内容汇总为一行加入 #9
		const combinedSummary = daySummaryEntries.map(row => `${row[0] || ''} ${row[2] || ''}`).join('; ')
		table9.rows.push([today, combinedSummary || '(无记录)'])
	}
	steps.push({ step: 3, action: 'transfer_to_table9', status: 'done' })

	// Step 4: #6 清空
	if (table6) table6.rows = []
	steps.push({ step: 4, action: 'clear_table6', status: 'done' })

	// Step 5: #7 超过3天的条目 → 归档到 hot/remember_about_user/{date}.json
	const step5 = archiveRememberAboutUser(username, charName)
	steps.push({ step: 5, action: 'archive_remember_about_user', status: 'done', archived: step5.archived })

	// Step 6: #3 已完成的任务 → 归档到热记忆层
	// 注意：这里无法自动判断哪些任务已完成，需要前端或AI标记
	// 暂时跳过自动归档，由用户通过 archiveCompletedTasks action 手动触发
	steps.push({ step: 6, action: 'archive_completed_tasks', status: 'skipped', note: '需要手动标记已完成的任务' })

	// Step 7: #4 剩余未归档的临时记忆 → 归档
	const step7 = archiveTempMemory(username, charName)
	steps.push({ step: 7, action: 'archive_temp_memory', status: 'done', archived: step7.archived, batchFiles: step7.batchFiles })

	// Step 8: 更新 hot/warm_monthly_index.json（加入今天的日总结摘要）
	const warmIndexPath = path.join(memDir, 'hot', 'warm_monthly_index.json')
	const warmIndex = loadJsonFileIfExists(warmIndexPath, { months: [] })
	// 找到或创建当月的索引
	let monthEntry = warmIndex.months.find(m => m.year === parseInt(year) && m.month === parseInt(month))
	if (!monthEntry) {
		monthEntry = { year: parseInt(year), month: parseInt(month), summary: '', days_with_data: [] }
		warmIndex.months.push(monthEntry)
	}
	const dayNum = parseInt(day)
	if (!monthEntry.days_with_data.includes(dayNum)) {
		monthEntry.days_with_data.push(dayNum)
		monthEntry.days_with_data.sort((a, b) => a - b)
	}
	// 更新月摘要（简单拼接，TODO: AI生成）
	monthEntry.summary = `${year}年${month}月，共${monthEntry.days_with_data.length}天有记忆数据`
	saveJsonFile(warmIndexPath, warmIndex)
	steps.push({ step: 8, action: 'update_warm_monthly_index', status: 'done' })

	// Step 9: #0 时空表格清空（新的一天）
	const table0 = data.tables.find(t => t.id === 0)
	if (table0) table0.rows = []
	steps.push({ step: 9, action: 'clear_table0', status: 'done' })

	// #9 维护：清理超过2天的
	maintainTimeSpaceTable(username, charName)

	// #8 维护：超过200条归档
	archiveForeverEntries(username, charName)

	// 保存所有表格变更
	saveTablesData(username, charName)

	console.log(`[beilu-memory] 日终归档完成 (${charName}):`, steps.map(s => `Step${s.step}:${s.status}`).join(', '))
	return { steps, date: today }
}

/**
 * 冷归档：将超过30天的温记忆移入冷层
 * @param {string} username
 * @param {string} charName
 * @returns {{ moved: number }}
 */
function archiveWarmToCold(username, charName) {
	const data = loadMemoryData(username, charName)
	const config = data.config
	const coldAfterDays = config?.archive?.cold_archive_after_days || 30
	const cutoffDate = getDaysAgoStr(coldAfterDays)
	const [cutYear, cutMonth] = cutoffDate.split('-').map(Number)

	const memDir = getMemoryDir(username, charName)
	const warmBaseDir = path.join(memDir, 'warm')
	let moved = 0

	// 遍历 warm/ 下的年/月目录
	if (!fs.existsSync(warmBaseDir)) return { moved: 0 }

	const years = fs.readdirSync(warmBaseDir).filter(f => /^\d{4}$/.test(f))
	for (const yearStr of years) {
		const yearDir = path.join(warmBaseDir, yearStr)
		if (!fs.statSync(yearDir).isDirectory()) continue

		const months = fs.readdirSync(yearDir).filter(f => /^\d{2}$/.test(f))
		for (const monthStr of months) {
			const y = parseInt(yearStr), m = parseInt(monthStr)
			// 跳过还在温层保留期内的月份
			if (y > cutYear || (y === cutYear && m >= cutMonth)) continue

			const monthDir = path.join(yearDir, monthStr)
			if (!fs.statSync(monthDir).isDirectory()) continue

			// 移动整个月目录到 cold/
			const coldMonthDir = path.join(memDir, 'cold', yearStr, monthStr)
			if (!fs.existsSync(coldMonthDir)) fs.mkdirSync(coldMonthDir, { recursive: true })

			const files = fs.readdirSync(monthDir)
			for (const file of files) {
				const srcPath = path.join(monthDir, file)
				const destPath = path.join(coldMonthDir, file)
				if (fs.statSync(srcPath).isDirectory()) {
					// 递归复制目录
					if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true })
					const subFiles = fs.readdirSync(srcPath)
					for (const sf of subFiles) {
						fs.copyFileSync(path.join(srcPath, sf), path.join(destPath, sf))
					}
					fs.rmSync(srcPath, { recursive: true })
				} else {
					fs.copyFileSync(srcPath, destPath)
					fs.unlinkSync(srcPath)
				}
				moved++
			}

			// 删除空的月目录
			try { fs.rmdirSync(monthDir) } catch (e) { /* not empty */ }
		}
		// 删除空的年目录
		try { fs.rmdirSync(yearDir) } catch (e) { /* not empty */ }
	}

	if (moved > 0) {
		// 更新冷层年索引
		const coldIndexPath = path.join(warmBaseDir, 'cold_yearly_index.json')
		const coldIndex = loadJsonFileIfExists(coldIndexPath, { years: [] })
		// 重建索引
		const coldBaseDir = path.join(memDir, 'cold')
		if (fs.existsSync(coldBaseDir)) {
			const coldYears = fs.readdirSync(coldBaseDir).filter(f => /^\d{4}$/.test(f))
			coldIndex.years = coldYears.map(y => {
				const yearPath = path.join(coldBaseDir, y)
				const coldMonths = fs.readdirSync(yearPath).filter(f => /^\d{2}$/.test(f))
				return {
					year: parseInt(y),
					months: coldMonths.map(m => {
						const summaryPath = path.join(yearPath, m, 'monthly_summary.json')
						const summary = loadJsonFileIfExists(summaryPath, { summary: '' })
						return {
							month: parseInt(m),
							summary: summary.summary || '',
							file: `cold/${y}/${m}/monthly_summary.json`,
						}
					}),
				}
			})
		}
		saveJsonFile(coldIndexPath, coldIndex)

		// 更新温层月索引（移除已冷归档的月份）
		const warmIndexPath = path.join(memDir, 'hot', 'warm_monthly_index.json')
		const warmIndex = loadJsonFileIfExists(warmIndexPath, { months: [] })
		warmIndex.months = warmIndex.months.filter(m => {
			return m.year > cutYear || (m.year === cutYear && m.month >= cutMonth)
		})
		saveJsonFile(warmIndexPath, warmIndex)

		console.log(`[beilu-memory] 冷归档：移动了 ${moved} 个文件到冷层 (${charName})`)
	}

	return { moved }
}

/**
 * 异步触发 P2 总结AI
 * 在临时记忆超阈值归档后调用，将 #4 内容总结写入 #6 表格
 * @param {string} username
 * @param {string} charName
 */
async function triggerP2Summary(username, charName) {
	const presetsData = loadMemoryPresets(username, charName)
	const p2Preset = presetsData.presets.find(p => p.id === 'P2')
	if (!p2Preset || !p2Preset.enabled) {
		console.log('[beilu-memory] P2 未启用，跳过自动总结')
		return
	}

	// 检查触发方式：manual_button 时不自动触发
	if (p2Preset.trigger === 'manual_button') {
		console.log('[beilu-memory] P2 触发方式为手动按钮，跳过自动触发')
		return
	}

	const memData = loadMemoryData(username, charName)
	const displayCharName = charName
	const displayUserName = username

	console.log(`[beilu-memory] P2 总结AI 异步触发 (${charName})`)

	pushMemoryAIOutput({
		presetId: 'P2',
		presetName: p2Preset.name,
		reply: '',
		thinking: '',
		operations: [],
		status: 'running',
	})

	try {
		const result = await runMemoryPresetAI(
			username, charName, p2Preset, memData,
			displayCharName, displayUserName,
			'(自动触发：临时记忆超阈值，请总结归档到#6表格)'
		)

		pushMemoryAIOutput({
			presetId: 'P2',
			presetName: p2Preset.name,
			reply: result.reply || '',
			thinking: result.thinking || '',
			operations: result.operations || [],
			status: 'done',
			totalRounds: result.totalRounds,
			totalTimeMs: result.totalTimeMs,
		})

		console.log(`[beilu-memory] P2 总结完成 (${result.totalRounds || 1}轮, ${result.totalTimeMs}ms)`)
	} catch (e) {
		console.error(`[beilu-memory] P2 总结失败:`, e.message)
		pushMemoryAIOutput({
			presetId: 'P2',
			presetName: p2Preset.name,
			reply: '',
			thinking: '',
			operations: [],
			status: 'error',
			error: e.message,
		})
	}
}

/**
 * 每轮回复后自动检查是否需要触发归档
 * 在 ReplyHandler 中调用
 * @param {string} username
 * @param {string} charName
 */
function autoCheckArchiveTriggers(username, charName) {
	const data = loadMemoryData(username, charName)

	// 检查 #4 是否超过阈值
	const table4 = data.tables.find(t => t.id === 4)
	const threshold = data.config?.archive?.temp_memory_threshold || 50
	if (table4 && table4.rows.length > threshold) {
		console.log(`[beilu-memory] #4 临时记忆 ${table4.rows.length} 条，超过阈值 ${threshold}，触发归档`)
		archiveTempMemory(username, charName)
		// 异步触发 P2 总结AI（非阻塞，不影响当前对话）
		triggerP2Summary(username, charName).catch(e =>
			console.error('[beilu-memory] P2 自动触发失败:', e.message)
		)
	}

	// 检查 #7 是否有超过3天的条目
	const table7 = data.tables.find(t => t.id === 7)
	if (table7 && table7.rows.length > 0) {
		const threeDaysAgo = getDaysAgoStr(3)
		const hasOld = table7.rows.some(row => (row[0] || '') < threeDaysAgo)
		if (hasOld) {
			archiveRememberAboutUser(username, charName)
		}
	}

	// 检查 #8 是否超过200条
	const table8 = data.tables.find(t => t.id === 8)
	if (table8 && table8.rows.length > 200) {
		archiveForeverEntries(username, charName)
	}

	// 检查 #9 是否有超过2天的条目
	maintainTimeSpaceTable(username, charName)
}

// ============================================================
// <tableEdit> 解析器
// ============================================================

/**
 * 从 AI 回复内容中提取 <tableEdit> 标签并解析操作
 * @param {string} content - AI 回复内容
 * @returns {{ operations: Array<{type: string, args: string}>, cleanContent: string }}
 */
function parseTableEditTags(content) {
	if (!content) return { operations: [], cleanContent: content }

	const tagRegex = /<tableEdit>([\s\S]*?)<\/tableEdit>/gi
	const operations = []
	let match

	while ((match = tagRegex.exec(content)) !== null) {
		const body = match[1]
			.replace(/<!--([\s\S]*?)-->/g, '$1') // 去掉 HTML 注释包裹
			.trim()

		// 匹配 insertRow / updateRow / deleteRow 调用
		const opRegex = /(insertRow|updateRow|deleteRow)\s*\(([\s\S]*?)\)(?=\s*(?:insertRow|updateRow|deleteRow|\s*$))/g
		let op
		while ((op = opRegex.exec(body)) !== null) {
			operations.push({ type: op[1], rawArgs: op[2].trim() })
		}
	}

	// 清除标签
	const cleanContent = content.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, '').trim()

	return { operations, cleanContent }
}

/**
 * 解析操作参数
 * insertRow(tableIndex, {colIndex: "value", ...})
 * updateRow(tableIndex, rowIndex, {colIndex: "value", ...})
 * deleteRow(tableIndex, rowIndex)
 *
 * @param {string} type
 * @param {string} rawArgs
 * @returns {{ tableIndex: number, rowIndex?: number, values?: Record<number, string> } | null}
 */
function parseOperationArgs(type, rawArgs) {
	try {
		switch (type) {
			case 'insertRow': {
				// insertRow(tableIndex, {0: "val", 1: "val"})
				const commaIdx = rawArgs.indexOf(',')
				if (commaIdx === -1) return null
				const tableIndex = parseInt(rawArgs.slice(0, commaIdx).trim(), 10)
				const valuesStr = rawArgs.slice(commaIdx + 1).trim()
				const values = parseObjectLiteral(valuesStr)
				if (isNaN(tableIndex) || !values) return null
				return { tableIndex, values }
			}
			case 'updateRow': {
				// updateRow(tableIndex, rowIndex, {0: "val"})
				const firstComma = rawArgs.indexOf(',')
				if (firstComma === -1) return null
				const tableIndex = parseInt(rawArgs.slice(0, firstComma).trim(), 10)
				const rest = rawArgs.slice(firstComma + 1).trim()
				const secondComma = rest.indexOf(',')
				if (secondComma === -1) return null
				const rowIndex = parseInt(rest.slice(0, secondComma).trim(), 10)
				const valuesStr = rest.slice(secondComma + 1).trim()
				const values = parseObjectLiteral(valuesStr)
				if (isNaN(tableIndex) || isNaN(rowIndex) || !values) return null
				return { tableIndex, rowIndex, values }
			}
			case 'deleteRow': {
				// deleteRow(tableIndex, rowIndex)
				const parts = rawArgs.split(',').map(s => parseInt(s.trim(), 10))
				if (parts.length < 2 || parts.some(isNaN)) return null
				return { tableIndex: parts[0], rowIndex: parts[1] }
			}
			default:
				return null
		}
	} catch (e) {
		console.error('[beilu-memory] parseOperationArgs error:', e.message)
		return null
	}
}

/**
 * 解析类似 {0: "value", 1: "value"} 的对象字面量
 * 支持双引号和单引号的值
 * @param {string} str
 * @returns {Record<number, string> | null}
 */
function parseObjectLiteral(str) {
	try {
		// 尝试直接 JSON 解析（将未加引号的 key 修复为字符串 key）
		// {0: "val", 1: "val"} → {"0": "val", "1": "val"}
		const jsonStr = str
			.replace(/'/g, '"') // 单引号→双引号
			.replace(/(\d+)\s*:/g, '"$1":') // 数字key加引号
		const obj = JSON.parse(jsonStr)
		const result = {}
		for (const [k, v] of Object.entries(obj)) {
			result[parseInt(k, 10)] = String(v)
		}
		return result
	} catch (e) {
		// 回退：手动正则提取
		const result = {}
		const pairRegex = /(\d+)\s*:\s*["']([^"']*?)["']/g
		let m
		while ((m = pairRegex.exec(str)) !== null) {
			result[parseInt(m[1], 10)] = m[2]
		}
		return Object.keys(result).length > 0 ? result : null
	}
}

/**
 * 执行表格操作
 * @param {object[]} tables - 表格数组
 * @param {Array<{type: string, rawArgs: string}>} operations - 操作列表
 * @returns {number} 成功执行的操作数
 */
function executeTableOperations(tables, operations) {
	let successCount = 0

	for (const op of operations) {
		const parsed = parseOperationArgs(op.type, op.rawArgs)
		if (!parsed) {
			console.warn(`[beilu-memory] 无法解析操作: ${op.type}(${op.rawArgs})`)
			continue
		}

		const table = tables[parsed.tableIndex]
		if (!table) {
			console.warn(`[beilu-memory] 表格 #${parsed.tableIndex} 不存在`)
			continue
		}

		try {
			switch (op.type) {
				case 'insertRow': {
					const newRow = new Array(table.columns.length).fill('')
					for (const [colIdx, value] of Object.entries(parsed.values)) {
						const idx = parseInt(colIdx, 10)
						if (idx >= 0 && idx < table.columns.length) {
							newRow[idx] = value
						}
					}
					table.rows.push(newRow)
					successCount++
					break
				}
				case 'updateRow': {
					if (parsed.rowIndex < 0 || parsed.rowIndex >= table.rows.length) {
						console.warn(`[beilu-memory] 行 #${parsed.rowIndex} 不存在于表格 #${parsed.tableIndex}`)
						break
					}
					for (const [colIdx, value] of Object.entries(parsed.values)) {
						const idx = parseInt(colIdx, 10)
						if (idx >= 0 && idx < table.columns.length) {
							table.rows[parsed.rowIndex][idx] = value
						}
					}
					successCount++
					break
				}
				case 'deleteRow': {
					if (parsed.rowIndex < 0 || parsed.rowIndex >= table.rows.length) {
						console.warn(`[beilu-memory] 行 #${parsed.rowIndex} 不存在于表格 #${parsed.tableIndex}`)
						break
					}
					table.rows.splice(parsed.rowIndex, 1)
					successCount++
					break
				}
			}
		} catch (e) {
			console.error(`[beilu-memory] 执行 ${op.type} 失败:`, e.message)
		}
	}

	return successCount
}

// ============================================================
// 表格 → CSV 文本（用于注入 prompt）
// ============================================================

/**
 * 将全部表格转为注入文本
 * @param {object[]} tables - 表格数组
 * @param {string} charName - 角色名（替换宏）
 * @param {string} userName - 用户名（替换宏）
 * @returns {string}
 */
function tablesToPromptText(tables, charName, userName) {
	const lines = ['[记忆表格]']

	for (const table of tables) {
		const name = table.name
			.replace(/\{\{char\}\}/g, charName)
			.replace(/\{\{user\}\}/g, userName)

		lines.push(`\n#${table.id} ${name}`)

		// 列头
		const columns = table.columns.map(c =>
			c.replace(/\{\{char\}\}/g, charName).replace(/\{\{user\}\}/g, userName)
		)
		lines.push(columns.join(','))

		// 数据行
		for (const row of table.rows) {
			lines.push(row.join(','))
		}
	}

	// 操作规则
	lines.push('\n[表格操作规则]')
	lines.push('当满足以下条件时，在回复末尾使用 <tableEdit> 标签进行操作：')

	for (const table of tables) {
		const name = table.name
			.replace(/\{\{char\}\}/g, charName)
			.replace(/\{\{user\}\}/g, userName)

		lines.push(`#${table.id} ${name}:`)
		if (table.rules.insert) lines.push(`  插入: ${table.rules.insert}`)
		if (table.rules.update) lines.push(`  更新: ${table.rules.update}`)
		if (table.rules.delete) lines.push(`  删除: ${table.rules.delete}`)
	}

	lines.push('\n操作格式:')
	lines.push('<tableEdit>')
	lines.push('<!--')
	lines.push('insertRow(表格编号, {列编号: "值", ...})')
	lines.push('updateRow(表格编号, 行编号, {列编号: "新值", ...})')
	lines.push('deleteRow(表格编号, 行编号)')
	lines.push('-->')
	lines.push('</tableEdit>')

	return lines.join('\n')
}

/**
	* 将全部表格转为纯数据文本（不含操作规则，用于 {{tableData}} 宏替换）
	* @param {object[]} tables - 表格数组
	* @param {string} charName - 角色名（替换宏）
	* @param {string} userName - 用户名（替换宏）
	* @returns {string}
	*/
function generateTableDataOnly(tables, charName, userName) {
	const lines = []

	for (const table of tables) {
		const name = table.name
			.replace(/\{\{char\}\}/g, charName)
			.replace(/\{\{user\}\}/g, userName)

		lines.push(`\n#${table.id} ${name}`)

		// 列头
		const columns = table.columns.map(c =>
			c.replace(/\{\{char\}\}/g, charName).replace(/\{\{user\}\}/g, userName)
		)
		lines.push(columns.join(','))

		// 数据行
		for (const row of table.rows) {
			lines.push(row.join(','))
		}

		// 简要操作规则（每个表格附带）
		if (table.rules) {
			lines.push(`规则: 插入=${table.rules.insert} | 更新=${table.rules.update} | 删除=${table.rules.delete}`)
		}
	}

	return lines.join('\n')
}

// ============================================================
// 热记忆层读取（Phase 1: 基础读取）
// ============================================================

/**
 * 读取热记忆层内容用于注入
 * @param {string} username
 * @param {string} charName
 * @returns {string} 热记忆文本
 */
function readHotMemoryForInjection(username, charName) {
	const memDir = getMemoryDir(username, charName)
	const hotDir = path.join(memDir, 'hot')
	if (!fs.existsSync(hotDir)) return ''

	const lines = []

	// #7 想要记住的关于 user 的事情（全部日期文件）
	const rememberDir = path.join(hotDir, 'remember_about_user')
	if (fs.existsSync(rememberDir)) {
		const files = fs.readdirSync(rememberDir).filter(f => f.endsWith('.json')).sort()
		if (files.length > 0) {
			lines.push('\n* 想要记住的关于{{user}}的事情:')
			for (const file of files) {
				try {
					const data = loadJsonFile(path.join(rememberDir, file))
					const entries = data.entries || data
					if (Array.isArray(entries)) {
						for (const entry of entries) {
							const text = typeof entry === 'string' ? entry : (entry.content || entry.thing || JSON.stringify(entry))
							lines.push(`  - ${file.replace('.json', '')}: ${text}`)
						}
					}
				} catch (e) { /* skip broken files */ }
			}
		}
	}

	// #8 永远记住的事情（Top-K 活跃注入，最多100条）
	const foreverPath = path.join(hotDir, 'forever.json')
	if (fs.existsSync(foreverPath)) {
		try {
			const data = loadJsonFile(foreverPath)
			let entries = data.entries || []
			if (entries.length > 0) {
				// Top-K 排序：weight × recency_decay 降序
				const now = Date.now()
				const scored = entries.map((entry, idx) => {
					const weight = (typeof entry === 'object' ? entry.weight : null) || 1
					const lastTriggered = (typeof entry === 'object' && entry.last_triggered)
						? new Date(entry.last_triggered).getTime()
						: now - idx * 86400000 // 没有触发时间的按索引顺序衰减
					const daysSince = Math.max(0, (now - lastTriggered) / 86400000)
					const recencyScore = 1 / (1 + daysSince * 0.1) // 越久越低
					return { entry, score: weight * recencyScore }
				})
				scored.sort((a, b) => b.score - a.score)
				const topK = scored.slice(0, 100) // 注入 Top-100

				lines.push(`\n* 永远记住的事情 (${topK.length}/${entries.length}条):`)
				for (const { entry } of topK) {
					const text = typeof entry === 'string' ? entry : (entry.content || entry.event || JSON.stringify(entry))
					lines.push(`  - ${text}`)
				}
			}
		} catch (e) { /* skip */ }
	}

	// 约定/任务/计划
	const appointmentsPath = path.join(hotDir, 'appointments.json')
	if (fs.existsSync(appointmentsPath)) {
		try {
			const data = loadJsonFile(appointmentsPath)
			const entries = data.entries || []
			if (entries.length > 0) {
				lines.push('\n* 约定/任务/计划:')
				for (const entry of entries) {
					const text = typeof entry === 'string' ? entry : (entry.content || entry.task || JSON.stringify(entry))
					lines.push(`  - ${text}`)
				}
			}
		} catch (e) { /* skip */ }
	}

	// 用户自我介绍
	const profilePath = path.join(hotDir, 'user_profile.json')
	if (fs.existsSync(profilePath)) {
		try {
			const data = loadJsonFile(profilePath)
			const entries = data.entries || []
			if (entries.length > 0) {
				lines.push('\n* 关于{{user}}:')
				for (const entry of entries) {
					const text = typeof entry === 'string' ? entry : (entry.content || JSON.stringify(entry))
					lines.push(`  - ${text}`)
				}
			}
		} catch (e) { /* skip */ }
	}

	// 温记忆层月总结索引（用于检索AI判断）
	const warmIndexPath = path.join(hotDir, 'warm_monthly_index.json')
	if (fs.existsSync(warmIndexPath)) {
		try {
			const data = loadJsonFile(warmIndexPath)
			const months = data.months || []
			if (months.length > 0) {
				lines.push('\n* 历史记忆索引:')
				for (const m of months) {
					lines.push(`  - ${m.year}年${m.month}月: ${m.summary || '(无摘要)'}`)
				}
			}
		} catch (e) { /* skip */ }
	}

	return lines.join('\n')
}

// ============================================================
// <memoryArchive> 解析器（Phase 1: 骨架，留待 Phase 2 完善）
// ============================================================

/**
 * 从 AI 回复中提取 <memoryArchive> 标签并解析操作
 * @param {string} content
 * @returns {{ archiveOps: Array, cleanContent: string }}
 */
function parseMemoryArchiveTags(content) {
	if (!content) return { archiveOps: [], cleanContent: content }

	const tagRegex = /<memoryArchive>([\s\S]*?)<\/memoryArchive>/gi
	const archiveOps = []
	let match

	while ((match = tagRegex.exec(content)) !== null) {
		// Phase 2 将实现具体操作解析
		archiveOps.push(match[1].trim())
	}

	const cleanContent = content.replace(/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi, '').trim()
	return { archiveOps, cleanContent }
}

/**
	* 路径安全检查：确保路径在记忆目录内且不含 .. 越界
	* @param {string} fullPath - 完整路径
	* @param {string} resolvedMemDir - path.resolve 后的记忆目录
	* @returns {boolean}
	*/
function isPathSafe(fullPath, resolvedMemDir) {
	const resolved = path.resolve(fullPath)
	return resolved.startsWith(resolvedMemDir) && !fullPath.includes('..')
}

/**
	* 从 <memoryArchive> 原始文本中解析操作调用
	* 使用括号计数法处理嵌套的 JSON 参数
	* @param {string} body - 去掉 HTML 注释后的文本
	* @returns {Array<{name: string, rawArgs: string}>}
	*/
function parseArchiveOperations(body) {
	const ops = []
	const opNames = ['createFile', 'appendToFile', 'updateFile', 'updateIndex', 'moveEntries', 'clearTable', 'deleteFile']

	let pos = 0
	while (pos < body.length) {
		let found = false
		for (const opName of opNames) {
			if (!body.startsWith(opName, pos)) continue

			// 确认不是某个更长标识符的一部分
			const before = pos > 0 ? body[pos - 1] : ' '
			if (/[a-zA-Z_]/.test(before)) continue

			// 找到开括号
			let parenStart = pos + opName.length
			while (parenStart < body.length && body[parenStart] !== '(') {
				if (!/\s/.test(body[parenStart])) break
				parenStart++
			}
			if (parenStart >= body.length || body[parenStart] !== '(') continue

			// 括号计数法找到匹配的闭括号
			let depth = 1
			let parenEnd = parenStart + 1
			let inString = false
			let stringChar = ''

			while (parenEnd < body.length && depth > 0) {
				const ch = body[parenEnd]
				if (inString) {
					if (ch === '\\') { parenEnd += 2; continue }
					if (ch === stringChar) inString = false
				} else {
					if (ch === '"' || ch === "'") { inString = true; stringChar = ch }
					else if (ch === '(') depth++
					else if (ch === ')') depth--
				}
				parenEnd++
			}

			if (depth === 0) {
				const rawArgs = body.slice(parenStart + 1, parenEnd - 1).trim()
				ops.push({ name: opName, rawArgs })
				pos = parenEnd
				found = true
				break
			}
		}
		if (!found) pos++
	}

	return ops
}

/**
	* 解析并执行 <memoryArchive> 中的文件操作
	* 支持: createFile / appendToFile / updateFile / updateIndex / moveEntries / clearTable
	* 禁止: deleteFile（安全策略）
	* @param {string[]} archiveOpsRaw - parseMemoryArchiveTags() 提取的原始字符串数组
	* @param {string} username
	* @param {string} charName
	* @param {object[]} [tables] - 表格数组（clearTable 需要）
	* @returns {Array<{op: string, status: string, path?: string, error?: string}>}
	*/
function executeMemoryArchiveOps(archiveOpsRaw, username, charName, tables) {
	const memDir = getMemoryDir(username, charName)
	const resolvedMemDir = path.resolve(memDir)
	const results = []

	for (const rawBlock of archiveOpsRaw) {
		// 去掉 HTML 注释包裹
		const body = rawBlock.replace(/<!--([\s\S]*?)-->/g, '$1').trim()
		const ops = parseArchiveOperations(body)

		for (const op of ops) {
			try {
				// 解析参数：包装为 JSON 数组来解析
				let args
				try {
					let cleaned = op.rawArgs
						.replace(/'/g, '"') // 单引号→双引号
						.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // 未加引号的key加引号
					args = JSON.parse('[' + cleaned + ']')
				} catch (parseErr) {
					results.push({ op: op.name, status: 'error', error: `参数解析失败: ${parseErr.message}` })
					continue
				}

				switch (op.name) {
					case 'createFile': {
						// createFile("path", {content})
						const [relPath, content] = args
						if (!relPath) { results.push({ op: 'createFile', status: 'error', error: '缺少路径' }); break }

						const fullPath = path.join(memDir, relPath)
						if (!isPathSafe(fullPath, resolvedMemDir)) {
							results.push({ op: 'createFile', status: 'error', path: relPath, error: '路径越界' })
							break
						}

						saveJsonFile(fullPath, content || {})
						results.push({ op: 'createFile', status: 'ok', path: relPath })
						console.log(`[beilu-memory] memoryArchive: createFile("${relPath}")`)
						break
					}

					case 'appendToFile': {
						// appendToFile("path", [{entries}])
						const [relPath, newEntries] = args
						if (!relPath) { results.push({ op: 'appendToFile', status: 'error', error: '缺少路径' }); break }

						const fullPath = path.join(memDir, relPath)
						if (!isPathSafe(fullPath, resolvedMemDir)) {
							results.push({ op: 'appendToFile', status: 'error', path: relPath, error: '路径越界' })
							break
						}

						const existing = loadJsonFileIfExists(fullPath, null)
						if (existing === null) {
							// 文件不存在，自动创建
							if (Array.isArray(newEntries)) {
								saveJsonFile(fullPath, { entries: newEntries })
							} else {
								saveJsonFile(fullPath, newEntries || {})
							}
						} else {
							// 文件存在，找到可追加的数组字段
							if (Array.isArray(newEntries)) {
								if (Array.isArray(existing.entries)) {
									existing.entries = existing.entries.concat(newEntries)
								} else if (Array.isArray(existing.items)) {
									existing.items = existing.items.concat(newEntries)
								} else {
									// 没有 entries/items，创建 entries
									existing.entries = [].concat(newEntries)
								}
							}
							saveJsonFile(fullPath, existing)
						}
						results.push({ op: 'appendToFile', status: 'ok', path: relPath })
						console.log(`[beilu-memory] memoryArchive: appendToFile("${relPath}")`)
						break
					}

					case 'updateFile': {
						// updateFile("path", content) — 覆盖写入，若传入数组则追加到 entries
						const [relPath, content] = args
						if (!relPath) { results.push({ op: 'updateFile', status: 'error', error: '缺少路径' }); break }

						const fullPath = path.join(memDir, relPath)
						if (!isPathSafe(fullPath, resolvedMemDir)) {
							results.push({ op: 'updateFile', status: 'error', path: relPath, error: '路径越界' })
							break
						}

						// 如果传入的是数组，当作追加到 entries（兼容 updateFile 被当 appendToFile 用）
						if (Array.isArray(content)) {
							const existing = loadJsonFileIfExists(fullPath, { entries: [] })
							if (Array.isArray(existing.entries)) {
								existing.entries = existing.entries.concat(content)
							} else if (Array.isArray(existing.items)) {
								existing.items = existing.items.concat(content)
							} else {
								existing.entries = content
							}
							saveJsonFile(fullPath, existing)
						} else {
							saveJsonFile(fullPath, content || {})
						}
						results.push({ op: 'updateFile', status: 'ok', path: relPath })
						console.log(`[beilu-memory] memoryArchive: updateFile("${relPath}")`)
						break
					}

					case 'updateIndex': {
						// updateIndex("path", {data}) — 顶层 key 浅合并（数组 concat，其他覆盖）
						const [relPath, updateData] = args
						if (!relPath) { results.push({ op: 'updateIndex', status: 'error', error: '缺少路径' }); break }

						const fullPath = path.join(memDir, relPath)
						if (!isPathSafe(fullPath, resolvedMemDir)) {
							results.push({ op: 'updateIndex', status: 'error', path: relPath, error: '路径越界' })
							break
						}

						const existing = loadJsonFileIfExists(fullPath, {})
						if (updateData && typeof updateData === 'object' && !Array.isArray(updateData)) {
							for (const [key, val] of Object.entries(updateData)) {
								if (Array.isArray(val) && Array.isArray(existing[key])) {
									existing[key] = existing[key].concat(val)
								} else {
									existing[key] = val
								}
							}
						}
						saveJsonFile(fullPath, existing)
						results.push({ op: 'updateIndex', status: 'ok', path: relPath })
						console.log(`[beilu-memory] memoryArchive: updateIndex("${relPath}")`)
						break
					}

					case 'moveEntries': {
						if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'string') {
							// 形式2: moveEntries("sourceDir/", "targetDir/") — 目录级别移动
							const [srcRel, destRel] = args
							const srcFull = path.join(memDir, srcRel)
							const destFull = path.join(memDir, destRel)

							if (!isPathSafe(srcFull, resolvedMemDir) || !isPathSafe(destFull, resolvedMemDir)) {
								results.push({ op: 'moveEntries', status: 'error', error: '路径越界' })
								break
							}

							if (fs.existsSync(srcFull) && fs.statSync(srcFull).isDirectory()) {
								if (!fs.existsSync(destFull)) fs.mkdirSync(destFull, { recursive: true })
								const files = fs.readdirSync(srcFull)
								let moved = 0
								for (const f of files) {
									const s = path.join(srcFull, f)
									const d = path.join(destFull, f)
									try {
										if (fs.statSync(s).isDirectory()) {
											if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
											fs.cpSync(s, d, { recursive: true })
											fs.rmSync(s, { recursive: true })
										} else {
											fs.copyFileSync(s, d)
											fs.unlinkSync(s)
										}
										moved++
									} catch (moveErr) {
										console.warn(`[beilu-memory] moveEntries: 移动 ${f} 失败:`, moveErr.message)
									}
								}
								results.push({ op: 'moveEntries', status: 'ok', from: srcRel, to: destRel, moved })
								console.log(`[beilu-memory] memoryArchive: moveEntries("${srcRel}" → "${destRel}") ${moved}个文件`)
							} else {
								results.push({ op: 'moveEntries', status: 'error', error: `源目录不存在: ${srcRel}` })
							}
						} else if (args.length >= 3) {
							// 形式1: moveEntries("source.json", [indices], "target.json") — 条目级别移动
							const [srcRel, indices, destRel] = args
							const srcFull = path.join(memDir, srcRel)
							const destFull = path.join(memDir, destRel)

							if (!isPathSafe(srcFull, resolvedMemDir) || !isPathSafe(destFull, resolvedMemDir)) {
								results.push({ op: 'moveEntries', status: 'error', error: '路径越界' })
								break
							}

							if (!Array.isArray(indices)) {
								results.push({ op: 'moveEntries', status: 'error', error: '索引参数不是数组' })
								break
							}

							const srcData = loadJsonFileIfExists(srcFull, null)
							if (!srcData) {
								results.push({ op: 'moveEntries', status: 'error', error: `源文件不存在: ${srcRel}` })
								break
							}

							// 确定源文件的数组字段
							const srcArrayKey = Array.isArray(srcData.entries) ? 'entries'
								: Array.isArray(srcData.items) ? 'items' : null
							if (!srcArrayKey) {
								results.push({ op: 'moveEntries', status: 'error', error: '源文件无 entries/items 数组' })
								break
							}

							const srcArray = srcData[srcArrayKey]
							const sortedIndices = [...indices].map(Number).filter(i => !isNaN(i)).sort((a, b) => b - a)
							const toMove = []

							// 提取要移动的条目（从大到小 splice）
							for (const idx of sortedIndices) {
								if (idx >= 0 && idx < srcArray.length) {
									toMove.unshift(srcArray[idx]) // unshift 保持原顺序
								}
							}

							if (toMove.length === 0) {
								results.push({ op: 'moveEntries', status: 'ok', moved: 0, note: '无有效索引' })
								break
							}

							// 追加到目标文件
							const destData = loadJsonFileIfExists(destFull, {})
							const destArrayKey = Array.isArray(destData.entries) ? 'entries'
								: Array.isArray(destData.items) ? 'items' : srcArrayKey
							if (!Array.isArray(destData[destArrayKey])) destData[destArrayKey] = []
							destData[destArrayKey] = destData[destArrayKey].concat(toMove)
							saveJsonFile(destFull, destData)

							// 从源文件删除（从大到小 splice）
							for (const idx of sortedIndices) {
								if (idx >= 0 && idx < srcArray.length) {
									srcArray.splice(idx, 1)
								}
							}
							saveJsonFile(srcFull, srcData)

							results.push({ op: 'moveEntries', status: 'ok', from: srcRel, to: destRel, moved: toMove.length })
							console.log(`[beilu-memory] memoryArchive: moveEntries("${srcRel}" → "${destRel}") ${toMove.length}条`)
						} else {
							results.push({ op: 'moveEntries', status: 'error', error: '参数不足' })
						}
						break
					}

					case 'clearTable': {
						// clearTable(tableIndex)
						const [tableIndex] = args
						if (typeof tableIndex !== 'number' || !tables) {
							results.push({ op: 'clearTable', status: 'error', error: '无效的表格索引或缺少表格引用' })
							break
						}
						if (tableIndex >= 0 && tableIndex < tables.length) {
							tables[tableIndex].rows = []
							results.push({ op: 'clearTable', status: 'ok', tableIndex })
							console.log(`[beilu-memory] memoryArchive: clearTable(${tableIndex})`)
						} else {
							results.push({ op: 'clearTable', status: 'error', error: `表格 #${tableIndex} 不存在` })
						}
						break
					}

					case 'deleteFile': {
						results.push({ op: 'deleteFile', status: 'blocked', error: '安全策略禁止AI删除文件' })
						console.warn('[beilu-memory] memoryArchive: deleteFile 被拒绝（安全策略）')
						break
					}

					default:
						results.push({ op: op.name, status: 'error', error: '未知操作' })
				}
			} catch (e) {
				results.push({ op: op.name, status: 'error', error: e.message })
				console.error(`[beilu-memory] memoryArchive: ${op.name} 异常:`, e.message)
			}
		}
	}

	return results
}

/**
	* 从 AI 回复中提取 <memorySearch> 标签
 * @param {string} content
 * @returns {{ searchOps: Array, cleanContent: string }}
 */
function parseMemorySearchTags(content) {
	if (!content) return { searchOps: [], cleanContent: content }

	const tagRegex = /<memorySearch>([\s\S]*?)<\/memorySearch>/gi
	const searchOps = []
	let match

	while ((match = tagRegex.exec(content)) !== null) {
		searchOps.push(match[1].trim())
	}

	const cleanContent = content.replace(/<memorySearch>[\s\S]*?<\/memorySearch>/gi, '').trim()
	return { searchOps, cleanContent }
}

/**
 * 执行 <memorySearch> 中的文件操作（readFile / listDir）
 * P1 多轮检索时，AI 输出 <memorySearch> 标签后由此函数实际读取文件
 * @param {string[]} searchOpsRaw - parseMemorySearchTags() 提取的原始字符串数组
 * @param {string} username
 * @param {string} charName
 * @returns {Array<{op: string, path: string, content?: string, entries?: Array, error?: string}>}
 */
function executeMemorySearchOps(searchOpsRaw, username, charName) {
	const results = []
	const memDir = getMemoryDir(username, charName)
	const resolvedMemDir = path.resolve(memDir)

	for (const rawBlock of searchOpsRaw) {
		// 去掉 HTML 注释包裹
		const body = rawBlock.replace(/<!--([\s\S]*?)-->/g, '$1').trim()

		// 匹配 readFile("path") 和 listDir("path")
		const opRegex = /(readFile|listDir)\s*\(\s*"([^"]+)"\s*\)/g
		let match
		while ((match = opRegex.exec(body)) !== null) {
			const [, opType, relPath] = match
			const fullPath = path.join(memDir, relPath)

			// 安全检查：路径不能越界
			if (!path.resolve(fullPath).startsWith(resolvedMemDir)) {
				results.push({ op: opType, path: relPath, error: '路径越界' })
				continue
			}

			try {
				if (opType === 'readFile') {
					if (fs.existsSync(fullPath)) {
						const content = fs.readFileSync(fullPath, 'utf8')
						results.push({ op: 'readFile', path: relPath, content })
					} else {
						results.push({ op: 'readFile', path: relPath, error: '文件不存在' })
					}
				} else if (opType === 'listDir') {
					if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
						const entries = fs.readdirSync(fullPath, { withFileTypes: true })
						const listing = entries.map(e => ({
							name: e.name,
							isDir: e.isDirectory(),
						}))
						results.push({ op: 'listDir', path: relPath, entries: listing })
					} else {
						results.push({ op: 'listDir', path: relPath, error: '目录不存在' })
					}
				}
			} catch (e) {
				results.push({ op: opType, path: relPath, error: e.message })
			}
		}
	}
	return results
}

/**
 * 将 executeMemorySearchOps 的结果格式化为 AI 可读的文本
 * @param {Array} searchResults - executeMemorySearchOps() 的返回值
 * @returns {string}
 */
function formatSearchResultsForAI(searchResults) {
	if (!searchResults || searchResults.length === 0) return '(无搜索结果)'

	const lines = ['[记忆文件搜索结果]']
	for (const r of searchResults) {
		if (r.error) {
			lines.push(`\n❌ ${r.op}("${r.path}"): ${r.error}`)
		} else if (r.op === 'readFile') {
			lines.push(`\n📄 readFile("${r.path}"):`)
			// 截断过长的文件内容（防止 token 爆炸）
			const content = r.content || ''
			if (content.length > 8000) {
				lines.push(content.substring(0, 8000) + '\n... (内容已截断，共' + content.length + '字符)')
			} else {
				lines.push(content)
			}
		} else if (r.op === 'listDir') {
			lines.push(`\n📁 listDir("${r.path}"):`)
			for (const entry of (r.entries || [])) {
				lines.push(`  ${entry.isDir ? '📂' : '📄'} ${entry.name}`)
			}
		}
	}
	lines.push('[/记忆文件搜索结果]')
	return lines.join('\n')
}

/**
 * 从 AI 回复中提取 <memoryNote> 标签
 * @param {string} content
 * @param {string} username
 * @param {string} charName
 * @returns {string} 清理后的内容
 */
function parseMemoryNoteTags(content, username, charName) {
	if (!content) return content

	const tagRegex = /<memoryNote\s+type="(\w+)">([\s\S]*?)<\/memoryNote>/gi
	const notes = []
	let match

	while ((match = tagRegex.exec(content)) !== null) {
		notes.push({ type: match[1], content: match[2].trim() })
	}

	if (notes.length > 0) {
		// 写入 _config.json 的 pending_tasks
		try {
			const memDir = getMemoryDir(username, charName)
			const configPath = path.join(memDir, '_config.json')
			if (fs.existsSync(configPath)) {
				const config = loadJsonFile(configPath)
				config.pending_tasks = config.pending_tasks || []
				for (const note of notes) {
					config.pending_tasks.push({
						type: note.type,
						content: note.content,
						created_at: new Date().toISOString(),
					})
				}
				saveJsonFile(configPath, config)
			}
		} catch (e) {
			console.error('[beilu-memory] 保存 memoryNote 失败:', e.message)
		}
	}

	return content.replace(/<memoryNote\s+type="\w+">[\s\S]*?<\/memoryNote>/gi, '').trim()
}

// ============================================================
// T7: 记忆AI独立调用
// ============================================================

/** P1 运行互斥锁，防止并发调用 */
let isP1Running = false
/** 本轮对话是否已触发过 P1，防止 ReplyHandler 多次调用导致重复触发 */
let p1TriggeredForCurrentReply = false

/**
 * 运行记忆预设AI（独立调用，不经过聊天流程）
 * 支持多轮搜索循环：AI 输出 <memorySearch> → 系统执行 → 结果回传 → AI 继续
 * @param {string} username
 * @param {string} charName
 * @param {object} preset - 记忆预设对象 (P1-P6)
 * @param {object} memData - { tables, config }
 * @param {string} displayCharName - 角色显示名
 * @param {string} displayUserName - 用户显示名
 * @param {string} chatHistory - 最近对话历史文本
 * @param {object} [options] - 可选参数
 * @param {number} [options.maxRounds] - 最大搜索轮数（覆盖 _config.json 设置）
 * @param {boolean} [options.dryRun] - 是否仅空跑（只构建 Prompt 不请求 AI）
 * @returns {Promise<object>} { reply, operations, thinking, rounds }
 */
async function runMemoryPresetAI(username, charName, preset, memData, displayCharName, displayUserName, chatHistory, options = {}) {
 const apiConfig = preset.api_config || {}
 const configSourceName = apiConfig.source || ''

 // 从 _config.json 获取检索配置
 const retrievalConfig = memData.config?.retrieval || {}
 const maxRounds = options.maxRounds || retrievalConfig.max_search_rounds || 5
 const timeoutMs = retrievalConfig.timeout_ms || 60000

 // 1. 加载 AI 服务源
 let aiSource
 let actualSourceName = configSourceName || '(系统默认)' // 日志用：显示实际加载的源名
 if (!options.dryRun) {
 	try {
 		if (apiConfig.use_custom && configSourceName) {
 			aiSource = await loadPart(username, `serviceSources/AI/${configSourceName}`)
 			actualSourceName = configSourceName
 		} else {
 			// 使用系统默认 AI 源（与聊天 AI 一致）
 			aiSource = await loadAnyPreferredDefaultPart(username, 'serviceSources/AI')
 			// 尝试从加载结果获取实际源名
 			actualSourceName = aiSource?.info?.name || aiSource?.name || '(系统默认)'
 		}
 	} catch (e) {
 		// 回退：如果默认源也加载失败，尝试指定名称
 		if (configSourceName) {
 			try {
 				aiSource = await loadPart(username, `serviceSources/AI/${configSourceName}`)
 				actualSourceName = configSourceName
 			} catch (e2) {
 				throw new Error(`无法加载 AI 服务源 "${configSourceName}": ${e2.message}`)
 			}
 		} else {
 			throw new Error(`无法加载默认 AI 服务源: ${e.message}`)
 		}
 	}
 }

 // 2. 组装初始 prompt messages
 const tableDataText = generateTableDataOnly(memData.tables, displayCharName, displayUserName)
	let hotMemoryText = readHotMemoryForInjection(username, charName)
	if (hotMemoryText) {
		hotMemoryText = hotMemoryText
			.replace(/\{\{char\}\}/g, displayCharName)
			.replace(/\{\{user\}\}/g, displayUserName)
	}

	const messages = []
	for (const prompt of (preset.prompts || [])) {
		if (!prompt.enabled) continue

		let content = prompt.content || ''

		// {{chat_history}} 替换为实际对话记录
		if (prompt.builtin && content === '{{chat_history}}') {
			messages.push({
				role: 'user',
				content: chatHistory || '(暂无对话记录)',
			})
			continue
		}

		// 提取最后一条用户消息（兼容酒馆 {{lastUserMessage}} 宏）
		let lastUserMessage = options.lastUserMessage || ''
		if (!lastUserMessage && chatHistory) {
			const segments = chatHistory.split('\n\n')
			for (let i = segments.length - 1; i >= 0; i--) {
				if (segments[i].startsWith(displayUserName + ':')) {
					lastUserMessage = segments[i].slice(displayUserName.length + 1).trim()
					break
				}
			}
		}
	
		// 时间宏值
		const _tm = getTimeMacroValues()
	
		// 宏替换
		content = content
			.replace(/\{\{tableData\}\}/g, tableDataText)
			.replace(/\{\{hotMemory\}\}/g, hotMemoryText || '')
			.replace(/\{\{char\}\}/g, displayCharName)
			.replace(/\{\{user\}\}/g, displayUserName)
			.replace(/\{\{current_date\}\}/g, getTodayStr())
			.replace(/\{\{chat_history\}\}/g, chatHistory || '')
			.replace(/\{\{lastUserMessage\}\}/g, lastUserMessage)
			.replace(/\{\{time\}\}/g, _tm.time)
			.replace(/\{\{date\}\}/g, _tm.date)
			.replace(/\{\{weekday\}\}/g, _tm.weekday)
			.replace(/\{\{idle_duration\}\}/g, _tm.idle_duration)
			.replace(/\{\{lasttime\}\}/g, _tm.lasttime)
			.replace(/\{\{lastdate\}\}/g, _tm.lastdate)

		// 热记忆数据已通过 {{hotMemory}} 宏替换注入（L2267），不再硬追加

		messages.push({
			role: prompt.role === 'user' ? 'user' : prompt.role === 'assistant' ? 'assistant' : 'system',
			content,
		})
	}

	if (messages.length === 0) {
		throw new Error('预设没有可用的提示词条目')
	}

	// === 调试日志：打印实际构建的 messages 摘要 ===
	console.log(`[beilu-memory] ===== P${preset.id} 实际构建的 messages (共${messages.length}条) =====`)
	for (let mi = 0; mi < messages.length; mi++) {
		const msg = messages[mi]
		const preview = (msg.content || '').substring(0, 120).replace(/\n/g, '\\n')
		console.log(`[beilu-memory]   [${mi}] role=${msg.role}, len=${(msg.content || '').length}, preview: ${preview}`)
	}
	console.log(`[beilu-memory] ===== /messages =====`)

	// Dry Run: 直接返回构建好的 messages
	if (options.dryRun) {
		return {
			dryRun: true,
			messages: messages,
			presetId: preset.id,
			presetName: preset.name,
			timestamp: new Date().toISOString(),
		}
	}

	// 3. 多轮搜索循环
	const allExecutedOps = []
	const roundDetails = []
	let finalReply = ''
	let finalThinking = ''
	const startTime = Date.now()

	for (let round = 1; round <= maxRounds; round++) {
		// 超时检查
		if (Date.now() - startTime > timeoutMs) {
			console.warn(`[beilu-memory] 记忆AI(${preset.id}) 超时 (${timeoutMs}ms), 停止在第${round}轮`)
			break
		}

		// 构造 promptStruct 并调用 AI（司令员模式：精确控制 role 和位置）
		// 从末尾提取连续的 assistant 消息作为尾部预填充
		let tailSplit = messages.length
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') tailSplit = i
			else break
		}
		const beforeMessages = messages.slice(0, tailSplit)
		const afterMessages = messages.slice(tailSplit)

		const promptStruct = {
			chat_log: [], // 司令员模式下 chat_log 为空，全部通过5段结构传递
			char_prompt: { text: [] },
			user_prompt: { text: [] },
			world_prompt: { text: [] },
			other_chars_prompt: {},
			plugin_prompts: {
				'beilu-preset': {
					extension: {
						commander_mode: true,
						beilu_preset_messages: true,
						beilu_preset_before: beforeMessages,
						beilu_preset_after: afterMessages,
						beilu_injection_above: [],
						beilu_injection_below: [],
						beilu_model_params: {},
					}
				}
			},
		}

		// 构建 per-call 模型参数覆盖（使用预设中配置的 model/temperature/max_tokens）
		const modelOverrides = {}
		if (apiConfig.use_custom) {
			if (apiConfig.model) modelOverrides.model = apiConfig.model
			if (apiConfig.temperature !== undefined) modelOverrides.temperature = apiConfig.temperature
			if (apiConfig.max_tokens !== undefined) modelOverrides.max_tokens = apiConfig.max_tokens
		}
		const hasModelOverrides = Object.keys(modelOverrides).length > 0
	
		console.log(`[beilu-memory] 调用记忆AI: ${preset.id}(${preset.name}) 第${round}轮, 服务源=${actualSourceName}${apiConfig.use_custom ? '' : '(自动)'}${hasModelOverrides ? `, model=${modelOverrides.model || '(默认)'}` : ''}, ${messages.length}条消息`)
	
			// StructCall 带重试（防御 TLS/网络瞬断错误）
			let result
			const maxRetries = 2
			for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
				try {
					result = await aiSource.StructCall(promptStruct, hasModelOverrides ? { modelOverrides } : {})
				break // 成功则跳出重试循环
			} catch (callError) {
				const isRetryable = /connection error|TLS|close_notify|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(callError.message)
				if (isRetryable && attempt <= maxRetries) {
					const delay = attempt * 2000 // 2s, 4s
					console.warn(`[beilu-memory] 记忆AI(${preset.id}) 第${round}轮第${attempt}次调用失败(${callError.message}), ${delay}ms后重试...`)
					await new Promise(r => setTimeout(r, delay))
					continue
				}
				// 不可重试 或 已用尽重试次数
				throw callError
			}
		}
		const replyContent = result?.content || ''

		// 解析回复中的标签
		let processedContent = replyContent

		// <tableEdit>
		const { operations: tableOps, cleanContent: afterTableEdit } = parseTableEditTags(processedContent)
		processedContent = afterTableEdit
		if (tableOps.length > 0) {
			const successCount = executeTableOperations(memData.tables, tableOps)
			if (successCount > 0) {
				saveTablesData(username, charName)
				allExecutedOps.push({ type: 'tableEdit', count: successCount, total: tableOps.length, round })
			}
		}

		// <memoryArchive> — 解析并执行文件操作
		const { archiveOps, cleanContent: afterArchive } = parseMemoryArchiveTags(processedContent)
		processedContent = afterArchive
		if (archiveOps.length > 0) {
			const archiveResults = executeMemoryArchiveOps(archiveOps, username, charName, memData.tables)
			const archiveOkCount = archiveResults.filter(r => r.status === 'ok').length
			if (archiveOkCount > 0) {
				saveTablesData(username, charName)
			}
			allExecutedOps.push({ type: 'memoryArchive', results: archiveResults, count: archiveOkCount, total: archiveResults.length, round })
			console.log(`[beilu-memory] 记忆AI(${preset.id}) 第${round}轮: memoryArchive ${archiveOkCount}/${archiveResults.length} 操作成功`)
		}

		// <memorySearch> — 核心：判断是否需要继续搜索
		const { searchOps, cleanContent: afterSearch } = parseMemorySearchTags(processedContent)
		processedContent = afterSearch

		// <memoryNote>
		processedContent = parseMemoryNoteTags(processedContent, username, charName)

		// 提取 <thinking>
		let roundThinking = ''
		const thinkingMatch = replyContent.match(/<thinking>([\s\S]*?)<\/thinking>/i)
		if (thinkingMatch) {
			roundThinking = thinkingMatch[1].trim()
		}

		roundDetails.push({
			round,
			replyLength: replyContent.length,
			hasSearchOps: searchOps.length > 0,
			searchOpsCount: searchOps.length,
			thinking: roundThinking,
		})

		console.log(`[beilu-memory] 记忆AI(${preset.id}) 第${round}轮回复: ${replyContent.length}字符, 搜索操作: ${searchOps.length}个`)

		// 没有 <memorySearch> → 搜索完成，使用当前回复作为最终结果
		if (searchOps.length === 0) {
			finalReply = processedContent
			finalThinking = roundThinking
			break
		}

		// 有 <memorySearch> → 执行文件操作，将结果追加到消息中，继续下一轮
		const searchResults = executeMemorySearchOps(searchOps, username, charName)
		const searchResultsText = formatSearchResultsForAI(searchResults)
		allExecutedOps.push({ type: 'memorySearch', results: searchResults.length, round })

		// 将 AI 回复添加为 assistant 消息
		messages.push({
			role: 'assistant',
			content: replyContent,
		})

		// 将搜索结果添加为 user 消息（system 角色会被某些模型忽略，用 user 更安全）
		messages.push({
			role: 'user',
			content: `以下是你请求的记忆文件内容：\n\n${searchResultsText}\n\n请继续分析这些内容。如果需要更多文件，继续使用 <memorySearch> 标签。如果已获取足够信息，直接输出最终结果。`,
		})

		// 如果是最后一轮，强制使用当前结果
		if (round === maxRounds) {
			finalReply = processedContent
			finalThinking = roundThinking
			console.log(`[beilu-memory] 记忆AI(${preset.id}) 达到最大轮数 ${maxRounds}，使用当前结果`)
		}
	}

	const totalTime = Date.now() - startTime
	console.log(`[beilu-memory] 记忆AI(${preset.id}) 完成: ${roundDetails.length}轮, ${totalTime}ms, 操作: ${allExecutedOps.length}个`)

	return {
		presetId: preset.id,
		presetName: preset.name,
		reply: finalReply,
		rawReply: finalReply, // 多轮时最终结果即为最终 raw
		thinking: finalThinking,
		operations: allExecutedOps,
		rounds: roundDetails,
		totalRounds: roundDetails.length,
		totalTimeMs: totalTime,
		timestamp: new Date().toISOString(),
	}
}

/**
 * 异步触发 P1 检索AI（非阻塞，在 ReplyHandler 中调用）
 * 结果缓存到 lastP1Result，在下一轮 GetPrompt 中注入
 * @param {string} username
 * @param {string} charName
 * @param {object} memData - { tables, config }
 * @param {string} displayCharName
 * @param {string} displayUserName
 * @param {string} chatHistory - 最近 N 条聊天记录文本
 */
async function triggerP1Retrieval(username, charName, memData, displayCharName, displayUserName, chatHistory) {
	// 互斥检查：正在运行 或 本轮已触发过
	if (isP1Running || p1TriggeredForCurrentReply) {
		return
	}
	p1TriggeredForCurrentReply = true

	const retrievalConfig = memData.config?.retrieval || {}
	if (!retrievalConfig.auto_trigger) {
		return // 未启用自动触发
	}

	// 加载预设
	const presetsData = loadMemoryPresets(username, charName)
	const p1Preset = presetsData.presets.find(p => p.id === 'P1')
	if (!p1Preset || !p1Preset.enabled) {
		return // P1 未启用
	}

	isP1Running = true
	console.log(`[beilu-memory] P1 检索AI 异步触发 (${charName})`)

	// 推送 running 状态
	const runningOutputId = `mai_p1_${Date.now()}`
	pushMemoryAIOutput({
		id: runningOutputId,
		presetId: 'P1',
		presetName: '检索AI',
		reply: '',
		thinking: '',
		operations: [],
		status: 'running',
	})

	try {
		const result = await runMemoryPresetAI(
			username, charName, p1Preset, memData,
			displayCharName, displayUserName,
			chatHistory
		)

		// 检查P1是否返回了"无实质内容"的回复
		// 判定条件：回复为空、回复过短（<5字符），或包含明确的"无结果"关键词
		const replyLower = (result.reply || '').trim()
		const noResultKeywords = ['无需检索', '无相关记忆', '无关联记忆', '无内容', '无相关内容']
		const isNoResult = replyLower.length < 5 || noResultKeywords.some(kw => replyLower.includes(kw))
		if (isNoResult) {
			console.log(`[beilu-memory] P1 判定无实质内容: "${replyLower.substring(0, 30)}"`)
			// 推送完成状态（无实质内容）
			pushMemoryAIOutput({
				presetId: 'P1',
				presetName: '检索AI',
				reply: replyLower || '无相关记忆',
				thinking: result.thinking || '',
				operations: result.operations || [],
				status: 'done',
				totalRounds: result.totalRounds || 1,
			})
			return
		}

		// 缓存结果（用于下次 GetPrompt 注入）
		lastP1Result = {
			reply: result.reply,
			timestamp: result.timestamp,
			rounds: result.totalRounds || 1,
		}

		// 推送完成输出到队列（供前端显示）
		pushMemoryAIOutput({
			presetId: 'P1',
			presetName: '检索AI',
			reply: result.reply,
			thinking: result.thinking || '',
			operations: result.operations || [],
			status: 'done',
			totalRounds: result.totalRounds || 1,
			totalTimeMs: result.totalTimeMs,
		})

		console.log(`[beilu-memory] P1 检索结果已缓存 (${result.reply.length}字符, ${result.totalRounds || 1}轮)`)
	} catch (e) {
		console.error(`[beilu-memory] P1 检索失败:`, e.message)
		// 推送错误状态
		pushMemoryAIOutput({
			presetId: 'P1',
			presetName: '检索AI',
			reply: '',
			thinking: '',
			operations: [],
			status: 'error',
			error: e.message,
		})
	} finally {
		isP1Running = false
	}
}

// ============================================================
// 插件状态
// ============================================================

let pluginEnabled = true

/**
 * T6: P1 检索AI结果缓存
 * 当 runMemoryPreset 以 P1 运行时，将 AI 回复存入此变量。
 * GetPrompt 在下一次调用时读取并注入到聊天消息序列中（一次性使用）。
 */
let lastP1Result = null

/**
 * GetPrompt 注入日志（供前端诊断面板显示）
 * 记录每次 GetPrompt 调用时的注入情况
 * @type {Array<{timestamp: string, injectionCount: number, p1Injected: boolean, hotMemoryLength: number, tableDataLength: number, error?: string}>}
 */
const injectionLog = []

/**
 * 记忆AI输出缓存（供前端轮询显示）
 * 每次记忆AI运行（手动或自动P1）完成后，将输出推入此队列。
 * 前端通过 getMemoryAIOutput action 获取并显示。
 * @type {Array<{id: string, presetId: string, presetName: string, reply: string, thinking: string, operations: Array, timestamp: string, status: 'running'|'done'|'error', error?: string}>}
 */
const memoryAIOutputQueue = []

/** 记忆AI输出ID计数器 */
let _outputIdCounter = 0

/**
 * 推送记忆AI输出到队列
 * @param {object} output
 */
function pushMemoryAIOutput(output) {
	_outputIdCounter++
	const entry = {
		id: _outputIdCounter,
		...output,
		timestamp: output.timestamp || new Date().toISOString(),
	}
	memoryAIOutputQueue.push(entry)
	// 只保留最近20条，防止内存膨胀
	while (memoryAIOutputQueue.length > 20) memoryAIOutputQueue.shift()
}

// ============================================================
// beilu-memory 插件导出
// ============================================================

const pluginExport = {
	info,
	Load: async ({ router }) => {
		// 动态加载 auth 模块以获取真实用户名（解决 _default 路径问题）
		let _getUserByReq
		try {
			const authMod = await import('../../../../server/auth.mjs')
			_getUserByReq = authMod.getUserByReq
		} catch (e) {
			console.warn('[beilu-memory] auth.mjs 未能加载，将使用默认用户名:', e.message)
		}

		if (router) {
			router.get('/api/parts/plugins\\:beilu-memory/config/getdata', async (req, res) => {
				try {
					let username
					if (_getUserByReq) try { username = (await _getUserByReq(req)).username } catch { /* fallback */ }
					const query = { ...(req.query || {}), ...(username ? { username } : {}) }
					const data = await pluginExport.interfaces.config.GetData(query)
					res.json(data)
				} catch (err) {
					res.status(500).json({ error: err.message })
				}
			})

			router.post('/api/parts/plugins\\:beilu-memory/config/setdata', async (req, res) => {
				try {
					let username
					if (_getUserByReq) try { username = (await _getUserByReq(req)).username } catch { /* fallback */ }
					// body 中的 username 优先（前端显式传入时）,否则用 auth 的用户名
					const body = { ...req.body }
					if (!body.username && username) body.username = username
					const query = { ...(req.query || {}), ...(username ? { username } : {}) }
					const result = await pluginExport.interfaces.config.SetData(body, query)
					res.json(result || { success: true })
				} catch (err) {
					res.status(500).json({ error: err.message })
				}
			})
		}
		console.log('[beilu-memory] 记忆系统已加载')
	},
	Unload: async () => {
		memoryCache.clear()
		console.log('[beilu-memory] 记忆系统已卸载')
	},
	interfaces: {
		config: {
			/**
			 * GetData: 返回当前记忆数据给前端
			 * 当缺少 username/charName 时，使用全局模板模式（_default/_global）
			 */
			GetData: async (args) => {
				const username = args?.username || '_default'
				const charName = args?.char_id || args?.charName || '_global'

				const data = loadMemoryData(username, charName)
				const presetsData = loadMemoryPresets(username, charName)
				return {
					username, // 返回当前上下文信息
					charName,
					enabled: pluginEnabled,
					tables: data.tables,
					config: data.config,
					memory_presets: presetsData.presets,
					injection_prompts: presetsData.injection_prompts || structuredClone(DEFAULT_INJECTION_PROMPTS),
					_actions: [
						'setEnabled', 'updateTable', 'addTable', 'removeTable', 'getTables',
						'getMemoryPresets', 'updateMemoryPreset', 'updatePresetPrompt',
						'addPresetPrompt', 'removePresetPrompt', 'reorderPresetPrompts',
						'updateInjectionPrompt', 'runMemoryPreset', 'dumpP1Request',
						'archiveTempMemory', 'endDay', 'archiveHotToWarm', 'archiveWarmToCold', 'archiveCompletedTasks',
						'listMemoryFiles', 'readMemoryFile', 'writeMemoryFile',
						'exportMemory', 'importMemory',
					],
				}
			},

			/**
			 * SetData: 前端管理面板操作
			 */
			SetData: async (data, args) => {
				if (!data) return

				if (data._action === 'setEnabled') {
					pluginEnabled = !!data.enabled
					return
				}

				const username = data.username || args?.username || '_default'
				const charName = data.charName || args?.char_id || '_global'

				const memData = loadMemoryData(username, charName)

				// 加载预设数据（presets + injection_prompts）
				const presetsData = loadMemoryPresets(username, charName)

				switch (data._action) {
					case 'clearCache': {
						// 清理指定角色的内存缓存（角色卡删除时由 beilu-home 调用）
						const cacheKey = `${username}/${charName}`
						memoryCache.delete(cacheKey)
						console.log(`[beilu-memory] 已清除缓存: ${cacheKey}`)
						return { success: true }
					}
					case 'updateTable': {
						// 更新指定表格的 rows/columns/rules
						const tableIdx = data.tableIndex
						if (tableIdx >= 0 && tableIdx < memData.tables.length) {
							if (data.rows !== undefined) memData.tables[tableIdx].rows = data.rows
							if (data.columns !== undefined) memData.tables[tableIdx].columns = data.columns
							if (data.rules !== undefined) memData.tables[tableIdx].rules = data.rules
							if (data.name !== undefined) memData.tables[tableIdx].name = data.name
							saveTablesData(username, charName)
						}
						break
					}
					case 'addTable': {
						const newId = memData.tables.length
						memData.tables.push({
							id: newId,
							name: data.name || `自定义表格 #${newId}`,
							columns: data.columns || ['列1', '列2'],
							rows: [],
							rules: data.rules || { insert: '', update: '', delete: '' },
							required: false,
							user_customizable: true,
						})
						saveTablesData(username, charName)
						break
					}
					case 'removeTable': {
						const idx = data.tableIndex
						if (idx >= 0 && idx < memData.tables.length) {
							if (memData.tables[idx].required) break // 不能删除必须的表格
							memData.tables.splice(idx, 1)
							// 重新编号
							memData.tables.forEach((t, i) => t.id = i)
							saveTablesData(username, charName)
						}
						break
					}
					case 'getTables': {
						// 仅用于强制重新加载
						const cacheKey = `${username}/${charName}`
						memoryCache.delete(cacheKey)
						break
					}

					// ============================================================
					// 记忆预设 CRUD 操作
					// ============================================================

					case 'getMemoryPresets': {
							// 强制重新加载预设（前端刷新用）
							break // GetData 已经返回 memory_presets
						}
						case 'updateMemoryPreset': {
							// 更新单个预设的元数据（enabled, description, trigger, api_config等）
							const presetId = data.presetId
							if (!presetId) break
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset) break
	
							if (data.enabled !== undefined) preset.enabled = !!data.enabled
							if (data.description !== undefined) preset.description = String(data.description)
							if (data.trigger !== undefined) preset.trigger = String(data.trigger)
							if (data.api_config !== undefined) {
								preset.api_config = {
									...preset.api_config,
									...data.api_config,
								}
							}
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'updatePresetPrompt': {
							// 更新预设中某个 prompt 条目
							const presetId = data.presetId
							const promptIdx = data.promptIndex
							if (!presetId || promptIdx === undefined) break
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset || !preset.prompts[promptIdx]) break
	
							const prompt = preset.prompts[promptIdx]
							if (data.role !== undefined && !prompt.builtin) prompt.role = data.role
							if (data.content !== undefined) prompt.content = String(data.content)
							if (data.enabled !== undefined) prompt.enabled = !!data.enabled
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'addPresetPrompt': {
							// 在预设中添加新 prompt 条目
							const presetId = data.presetId
							if (!presetId) break
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset) break
	
							const newPrompt = {
								role: data.role || 'system',
								content: data.content || '',
								identifier: `${presetId}_custom_${Date.now()}`,
								enabled: true,
								builtin: false,
								deletable: true,
							}
							// 在 {{chat_history}} 之前插入
							const chatHistoryIdx = preset.prompts.findIndex(p => p.builtin && p.content === '{{chat_history}}')
							if (chatHistoryIdx >= 0) {
								preset.prompts.splice(chatHistoryIdx, 0, newPrompt)
							} else {
								preset.prompts.push(newPrompt)
							}
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'removePresetPrompt': {
							// 删除预设中的 prompt 条目
							const presetId = data.presetId
							const promptIdx = data.promptIndex
							if (!presetId || promptIdx === undefined) break
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset || !preset.prompts[promptIdx]) break
							if (!preset.prompts[promptIdx].deletable) break // 不可删除的条目
		
							preset.prompts.splice(promptIdx, 1)
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'reorderPresetPrompts': {
							// 重新排列预设中的 prompt 条目顺序
							const presetId = data.presetId
							const order = data.order // identifier[] 数组
							if (!presetId || !Array.isArray(order)) break
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset) break
			
							// 根据 order 重排 prompts
							const reordered = []
							for (const identifier of order) {
								const found = preset.prompts.find(p => p.identifier === identifier)
								if (found) reordered.push(found)
							}
							// 追加 order 中未包含的条目（安全兜底）
							for (const p of preset.prompts) {
								if (!reordered.includes(p)) reordered.push(p)
							}
							preset.prompts = reordered
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'updateInjectionPrompt': {
							// 更新注入提示词条目
							const injId = data.injectionId
							if (!injId) break
							const injPrompts = presetsData.injection_prompts || []
							const inj = injPrompts.find(p => p.id === injId)
							if (!inj) break
		
							if (data.enabled !== undefined) inj.enabled = !!data.enabled
							if (data.content !== undefined) inj.content = String(data.content)
							if (data.name !== undefined) inj.name = String(data.name)
							if (data.description !== undefined) inj.description = String(data.description)
							if (data.role !== undefined) inj.role = data.role
							if (data.depth !== undefined) inj.depth = parseInt(data.depth, 10) || 0
							if (data.order !== undefined) inj.order = parseInt(data.order, 10) || 0
							if (data.autoMode !== undefined) inj.autoMode = data.autoMode
		
							presetsData.injection_prompts = injPrompts
							saveMemoryPresets(username, charName, presetsData)
							break
						}
						case 'previewMemoryPreset': {
							// 预览记忆预设的全部提示词条目（宏替换后）
							const presetId = data.presetId
							if (!presetId) return { error: '缺少 presetId' }
							const preset = presetsData.presets.find(p => p.id === presetId)
							if (!preset) return { error: `未找到预设 ${presetId}` }
	
							const displayCharName = data.charDisplayName || charName
							const displayUserName = data.userDisplayName || username
	
							// 生成表格数据文本（部分预设可能引用）
							const tableDataText = generateTableDataOnly(memData.tables, displayCharName, displayUserName)
	
							// 生成热记忆文本用于预览
							let previewHotMemory = readHotMemoryForInjection(username, charName)
							if (previewHotMemory) {
								previewHotMemory = previewHotMemory
									.replace(/\{\{char\}\}/g, displayCharName)
									.replace(/\{\{user\}\}/g, displayUserName)
							}

							const previewPrompts = (preset.prompts || []).map((p, idx) => {
								let content = p.content || ''
								// 替换宏
								content = content
									.replace(/\{\{tableData\}\}/g, tableDataText)
									.replace(/\{\{hotMemory\}\}/g, previewHotMemory || '')
									.replace(/\{\{char\}\}/g, displayCharName)
									.replace(/\{\{user\}\}/g, displayUserName)
									.replace(/\{\{current_date\}\}/g, getTodayStr())
	
								return {
									index: idx,
									identifier: p.identifier || `prompt_${idx}`,
									role: p.role,
									enabled: p.enabled,
									builtin: p.builtin || false,
									isChatHistory: p.builtin && p.content === '{{chat_history}}',
									originalLength: (p.content || '').length,
									preview: content,
									charCount: content.length,
								}
							})
	
							const totalChars = previewPrompts.reduce((sum, p) => sum + p.charCount, 0)
	
							return {
								success: true,
								presetId: preset.id,
								presetName: preset.name,
								prompts: previewPrompts,
								totalChars,
								estimatedTokens: Math.round(totalChars / 3.5),
							}
						}
						case 'previewInjectionPrompt': {
							// 预览注入提示词（宏替换后的实际内容）
							const injId = data.injectionId
							if (!injId) return { error: '缺少 injectionId' }
							const injPrompts = presetsData.injection_prompts || []
							const inj = injPrompts.find(p => p.id === injId)
							if (!inj) return { error: `未找到注入条目 ${injId}` }
	
							// 获取显示名
							const displayCharName = data.charDisplayName || charName
							const displayUserName = data.userDisplayName || username
	
							// 生成表格数据文本
							const tableDataText = generateTableDataOnly(memData.tables, displayCharName, displayUserName)
	
							// 生成热记忆文本
							let hotMemoryText = readHotMemoryForInjection(username, charName)
							if (hotMemoryText) {
								hotMemoryText = hotMemoryText
									.replace(/\{\{char\}\}/g, displayCharName)
									.replace(/\{\{user\}\}/g, displayUserName)
							}
	
							// 执行宏替换
								const _tmPreview = getTimeMacroValues()
								let previewContent = inj.content
									.replace(/\{\{tableData\}\}/g, tableDataText)
									.replace(/\{\{hotMemory\}\}/g, hotMemoryText || '')
									.replace(/\{\{char\}\}/g, displayCharName)
									.replace(/\{\{user\}\}/g, displayUserName)
									.replace(/\{\{current_date\}\}/g, getTodayStr())
									.replace(/\{\{chat_history\}\}/g, '（预览模式：无聊天记录）')
									.replace(/\{\{lastUserMessage\}\}/g, '（预览模式：无用户消息）')
									.replace(/\{\{time\}\}/g, _tmPreview.time)
									.replace(/\{\{date\}\}/g, _tmPreview.date)
									.replace(/\{\{weekday\}\}/g, _tmPreview.weekday)
									.replace(/\{\{idle_duration\}\}/g, _tmPreview.idle_duration || '（预览模式）')
									.replace(/\{\{lasttime\}\}/g, _tmPreview.lasttime || '（预览模式）')
									.replace(/\{\{lastdate\}\}/g, _tmPreview.lastdate || '（预览模式）')
	
							return {
								success: true,
								id: inj.id,
								name: inj.name,
								role: inj.role,
								depth: inj.depth,
								autoMode: inj.autoMode,
								enabled: inj.enabled,
								preview: previewContent,
								charCount: previewContent.length,
								estimatedTokens: Math.round(previewContent.length / 3.5),
								hotMemoryPreview: hotMemoryText || '（无热记忆数据）',
								hotMemoryCharCount: hotMemoryText ? hotMemoryText.length : 0,
							}
						}
	
					// ============================================================
					// Phase 2: 归档触发 actions
					// ============================================================
	
					case 'archiveTempMemory': {
						// 手动触发 #4 临时记忆归档
						const result = archiveTempMemory(username, charName)
						return { success: true, ...result }
					}
					case 'endDay': {
						// 手动触发日终归档流程
						const result = endDay(username, charName)
						return { success: true, ...result }
					}
					case 'archiveHotToWarm': {
						// 手动触发 #7/#8 热→温归档
						const r7 = archiveRememberAboutUser(username, charName)
						const r8 = archiveForeverEntries(username, charName)
						return { success: true, remember_archived: r7.archived, forever_archived: r8.archived }
					}
					case 'archiveWarmToCold': {
						// 手动触发温→冷归档
						const result = archiveWarmToCold(username, charName)
						return { success: true, ...result }
					}
					case 'archiveCompletedTasks': {
						// 手动归档已完成的任务
						const rowIndices = data.rowIndices || []
						const result = archiveCompletedTasks(username, charName, rowIndices)
						return { success: true, ...result }
					}

					case 'listMemoryFiles': {
						// Phase 4.3: 列出记忆目录下的文件和子目录
						const memDir = ensureMemoryDir(username, charName)
						const subPath = data.subPath || ''
						const targetDir = subPath ? path.join(memDir, subPath) : memDir
	
						if (!fs.existsSync(targetDir)) return { success: true, files: [], dirs: [] }
	
						// 安全检查：目标路径必须在记忆目录内
						const resolvedTarget = path.resolve(targetDir)
						const resolvedMem = path.resolve(memDir)
						if (!resolvedTarget.startsWith(resolvedMem)) {
							return { success: false, error: '路径越界' }
						}
	
						const entries = fs.readdirSync(targetDir, { withFileTypes: true })
						const files = []
						const dirs = []
	
						for (const entry of entries) {
							if (entry.isDirectory()) {
								dirs.push({ name: entry.name, path: subPath ? `${subPath}/${entry.name}` : entry.name })
							} else if (entry.isFile()) {
								const filePath = path.join(targetDir, entry.name)
								const stat = fs.statSync(filePath)
								files.push({
									name: entry.name,
									path: subPath ? `${subPath}/${entry.name}` : entry.name,
									size: stat.size,
									mtime: stat.mtime.toISOString(),
								})
							}
						}
	
						return { success: true, files, dirs, currentPath: subPath || '/' }
					}
	
					case 'readMemoryFile': {
						// Phase 4.3: 读取记忆目录下的文件内容
						const filePath = data.filePath
						if (!filePath) return { success: false, error: '缺少 filePath' }
	
						const memDir = ensureMemoryDir(username, charName)
						const fullPath = path.join(memDir, filePath)
	
						// 安全检查
						const resolvedFile = path.resolve(fullPath)
						const resolvedMem = path.resolve(memDir)
						if (!resolvedFile.startsWith(resolvedMem)) {
							return { success: false, error: '路径越界' }
						}
	
						if (!fs.existsSync(fullPath)) {
							return { success: false, error: '文件不存在' }
						}
	
						try {
							const content = fs.readFileSync(fullPath, 'utf8')
							// 尝试解析为 JSON
							let parsed = null
							try { parsed = JSON.parse(content) } catch { /* not JSON */ }
	
							return {
								success: true,
								filePath,
								content,
								isJson: parsed !== null,
								parsed,
								size: Buffer.byteLength(content, 'utf8'),
							}
						} catch (e) {
							return { success: false, error: `读取失败: ${e.message}` }
						}
					}
	
					case 'writeMemoryFile': {
						// Phase 4.3: 写入记忆目录下的文件
						const filePath = data.filePath
						const content = data.content
						if (!filePath) return { success: false, error: '缺少 filePath' }
						if (content === undefined) return { success: false, error: '缺少 content' }
	
						const memDir = ensureMemoryDir(username, charName)
						const fullPath = path.join(memDir, filePath)
	
						// 安全检查
						const resolvedFile = path.resolve(fullPath)
						const resolvedMem = path.resolve(memDir)
						if (!resolvedFile.startsWith(resolvedMem)) {
							return { success: false, error: '路径越界' }
						}
	
						try {
							// 确保目录存在
							const dir = path.dirname(fullPath)
							if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	
							// 如果是对象/数组，自动 JSON 序列化
							const writeContent = typeof content === 'string' ? content : JSON.stringify(content, null, '\t') + '\n'
							fs.writeFileSync(fullPath, writeContent, 'utf8')
	
							return { success: true, filePath, size: Buffer.byteLength(writeContent, 'utf8') }
						} catch (e) {
							return { success: false, error: `写入失败: ${e.message}` }
						}
					}
	case 'exportMemory': {
			try {
				// 导出：递归读取整个记忆目录，打包为 zip
				const memDir = ensureMemoryDir(username, charName)
				const zip = new JSZip()
				let fileCount = 0

				// 清洗 _memory_presets.json 中的敏感信息（api_config.source 泄露用户私有服务源名称）
					function sanitizePresetsForExport(jsonStr) {
						try {
							const data = JSON.parse(jsonStr)
							if (data.presets && Array.isArray(data.presets)) {
								for (const preset of data.presets) {
									if (preset.api_config) {
										preset.api_config = {
											use_custom: false,
											source: '',
											model: preset.api_config.model || '',
											temperature: preset.api_config.temperature ?? 0.3,
											max_tokens: preset.api_config.max_tokens ?? 2000,
										}
									}
								}
							}
							return JSON.stringify(data, null, '\t') + '\n'
						} catch (e) {
							console.warn('[beilu-memory] exportMemory: 清洗 _memory_presets.json 失败:', e.message)
							return jsonStr // 解析失败则原样返回（不阻断导出）
						}
					}
	
					// 清洗 _config.json 中的敏感信息（api_key, base_url 泄露用户 API 密钥和端点）
					function sanitizeConfigForExport(jsonStr) {
						try {
							const data = JSON.parse(jsonStr)
							// 清除 retrieval_ai 和 summary_ai 中的密钥和自定义 URL
							for (const key of ['retrieval_ai', 'summary_ai']) {
								if (data[key]) {
									data[key] = {
										...data[key],
										api_key: null,
										base_url: null,
									}
								}
							}
							return JSON.stringify(data, null, '\t') + '\n'
						} catch (e) {
							console.warn('[beilu-memory] exportMemory: 清洗 _config.json 失败:', e.message)
							return jsonStr
						}
					}
	
					// 递归添加文件到 zip（对敏感文件进行清洗）
					function addDirToZip(dir, zipFolder, relBase) {
						if (!fs.existsSync(dir)) return
						let entries
						try {
							entries = fs.readdirSync(dir, { withFileTypes: true })
						} catch (e) {
							console.warn(`[beilu-memory] exportMemory: 无法读取目录 ${relBase || '/'}: ${e.message}`)
							return
						}
						for (const entry of entries) {
							// 跳过 .bak 和 .import_bak 文件
							if (entry.name.endsWith('.bak') || entry.name.endsWith('.import_bak')) continue
							const fullPath = path.join(dir, entry.name)
							if (entry.isDirectory()) {
								addDirToZip(fullPath, zipFolder.folder(entry.name), relBase ? `${relBase}/${entry.name}` : entry.name)
							} else if (entry.isFile()) {
								try {
									let content = fs.readFileSync(fullPath, 'utf8')
									// 对敏感文件进行清洗
									if (entry.name === '_memory_presets.json') {
										content = sanitizePresetsForExport(content)
									} else if (entry.name === '_config.json') {
										content = sanitizeConfigForExport(content)
									}
									zipFolder.file(entry.name, content)
									fileCount++
								} catch (e) {
									console.warn(`[beilu-memory] exportMemory: 读取失败 ${relBase ? relBase + '/' : ''}${entry.name}: ${e.message}`)
								}
							}
						}
					}

				addDirToZip(memDir, zip, '')

				// 生成 zip 的 base64
				const zipBase64 = await zip.generateAsync({ type: 'base64' })

				const dateStr = new Date().toISOString().slice(0, 10)
				const fileName = `beilu-memory_${charName}_${dateStr}.zip`

				console.log(`[beilu-memory] 导出记忆: ${charName}, ${fileCount} 个文件 → zip`)
				return { success: true, zipBase64, fileName, fileCount }
			} catch (e) {
				console.error(`[beilu-memory] exportMemory 失败:`, e.message)
				return { success: false, error: `导出失败: ${e.message}` }
			}
		}
	
						case 'importMemory': {
							try {
								const memDir = ensureMemoryDir(username, charName)
								const resolvedMem = path.resolve(memDir)
								let imported = 0
								let skipped = 0
								const errors = []
								const backupExisting = data.backupExisting !== false
	
								if (data.zipBase64) {
									// ZIP 格式导入：解压 base64 zip → 写入文件
									const binaryStr = atob(data.zipBase64)
									const zipBinary = new Uint8Array(binaryStr.length)
									for (let i = 0; i < binaryStr.length; i++) {
										zipBinary[i] = binaryStr.charCodeAt(i)
									}
									const zip = await JSZip.loadAsync(zipBinary)
	
									for (const [relPath, zipEntry] of Object.entries(zip.files)) {
										if (zipEntry.dir) continue
	
										if (relPath.includes('..')) {
											errors.push(`非法路径: ${relPath}`)
											skipped++
											continue
										}
	
										const fullPath = path.join(memDir, relPath)
										if (!path.resolve(fullPath).startsWith(resolvedMem)) {
											errors.push(`路径越界: ${relPath}`)
											skipped++
											continue
										}
	
										try {
											const dir = path.dirname(fullPath)
											if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	
											if (backupExisting && fs.existsSync(fullPath)) {
												try { fs.copyFileSync(fullPath, fullPath + '.import_bak') } catch { /* ignore */ }
											}
	
											const content = await zipEntry.async('string')
											fs.writeFileSync(fullPath, content, 'utf8')
											imported++
										} catch (e) {
											errors.push(`写入失败 ${relPath}: ${e.message}`)
											skipped++
										}
									}
								} else {
									// 旧 JSON 格式导入（兼容）
									const importData = data.importData
									if (!importData || !importData.files) {
										return { success: false, error: '无效的导入数据：缺少 files 字段或 zipBase64' }
									}
									if (importData._format !== 'beilu-memory-export') {
										return { success: false, error: '无效的导入数据：格式标识不匹配' }
									}
	
									for (const [relPath, content] of Object.entries(importData.files)) {
										const fullPath = path.join(memDir, relPath)
										if (!path.resolve(fullPath).startsWith(resolvedMem)) {
											errors.push(`路径越界: ${relPath}`)
											skipped++
											continue
										}
										if (relPath.includes('..')) {
											errors.push(`非法路径: ${relPath}`)
											skipped++
											continue
										}
	
										try {
											const dir = path.dirname(fullPath)
											if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	
											if (backupExisting && fs.existsSync(fullPath)) {
												try { fs.copyFileSync(fullPath, fullPath + '.import_bak') } catch { /* ignore */ }
											}
	
											fs.writeFileSync(fullPath, content, 'utf8')
											imported++
										} catch (e) {
											errors.push(`写入失败 ${relPath}: ${e.message}`)
											skipped++
										}
									}
								}
	
								// 清除内存缓存
								const cacheKey = `${username}/${charName}`
								memoryCache.delete(cacheKey)
	
								console.log(`[beilu-memory] 导入记忆: ${charName}, 成功 ${imported}, 跳过 ${skipped}`)
								return {
									success: true,
									imported,
									skipped,
									errors: errors.length > 0 ? errors : undefined,
								}
							} catch (e) {
								console.error(`[beilu-memory] importMemory 失败:`, e.message)
								return { success: false, error: `导入失败: ${e.message}` }
							}
						}
	
						case 'importPresets': {
							// 导入记忆预设（一次性覆盖 presets + injection_prompts）
							const importData = data.importData
							if (!importData) return { success: false, error: '缺少 importData' }
							if (importData._format !== 'beilu-memory-presets-export') {
								return { success: false, error: '无效的预设文件：格式标识不匹配' }
							}
							if (!Array.isArray(importData.presets) || !Array.isArray(importData.injection_prompts)) {
								return { success: false, error: '无效的预设文件：缺少 presets 或 injection_prompts 数组' }
							}
	
							// 备份现有预设
							const backupExisting = data.backupExisting !== false
							if (backupExisting) {
								const memDir = ensureMemoryDir(username, '_global')
								const presetsPath = path.join(memDir, '_memory_presets.json')
								if (fs.existsSync(presetsPath)) {
									try { fs.copyFileSync(presetsPath, presetsPath + '.import_bak') } catch { /* ignore */ }
								}
							}
	
							// 写入新预设
							const newPresetsData = {
								presets: importData.presets,
								injection_prompts: importData.injection_prompts,
							}
							saveMemoryPresets(username, charName, newPresetsData)
	
							console.log(`[beilu-memory] 预设已导入: ${importData.presets.length} 个预设, ${importData.injection_prompts.length} 个注入条目`)
							return {
								success: true,
								presetsCount: importData.presets.length,
								injectionCount: importData.injection_prompts.length,
							}
						}
	
						case 'getModels': {
						// 获取指定 AI 源的模型列表（后端代理请求，解决 CORS 问题）
						const sourceName = data.sourceName
						const apiConfig = data.apiConfig // { url, key } 可选，用于测试连接
						
						let url, key
						
						if (sourceName) {
							// 从已保存的源加载（目录结构: serviceSources/AI/{name}/config.json）
							try {
								const sourcePath = path.join(__projectRoot, 'data', 'users', username, 'serviceSources', 'AI', sourceName, 'config.json')
								if (fs.existsSync(sourcePath)) {
									const sourceData = loadJsonFile(sourcePath)
									url = sourceData.config?.url || sourceData.config?.base_url
									key = sourceData.config?.apikey || sourceData.config?.key
								}
							} catch (e) {
								return { success: false, error: `读取源配置失败: ${e.message}` }
							}
						} else if (apiConfig) {
							// 使用传入的临时配置
							url = apiConfig.url
							key = apiConfig.key
						}

						if (!url) return { success: false, error: '未找到 API URL' }

						// 规范化 URL (复用 proxy/display.mjs 的逻辑，但在后端实现)
						let modelsUrl = url
						try {
							let urlObj
							if (!url.startsWith('http')) url = 'https://' + url
							urlObj = new URL(url)
							
							if (urlObj.pathname.includes('/chat/completions')) {
								urlObj.pathname = urlObj.pathname.replace(/\/chat\/completions.*$/, '/models')
							} else {
								let p = urlObj.pathname
								if (p.endsWith('/')) p = p.slice(0, -1)
								if (p.endsWith('/v1')) urlObj.pathname = p + '/models'
								else urlObj.pathname = p + '/v1/models'
							}
							modelsUrl = urlObj.toString()
						} catch (e) {
							return { success: false, error: 'URL 格式无效' }
						}

						try {
							console.log(`[beilu-memory] Fetching models from: ${modelsUrl}`)
							const headers = { 'Content-Type': 'application/json' }
							if (key) headers['Authorization'] = `Bearer ${key}`

							const response = await fetch(modelsUrl, { headers })
							if (!response.ok) {
								const text = await response.text()
								throw new Error(`${response.status} ${response.statusText}: ${text}`)
							}
							
							const result = await response.json()
							const models = result.data || result
							if (!Array.isArray(models)) throw new Error('响应不是模型数组')
							
							const modelIds = models.map(m => m.id).sort()
							return { success: true, models: modelIds }
						} catch (e) {
							console.error(`[beilu-memory] getModels failed: ${e.message}`)
							return { success: false, error: e.message }
						}
					}

					case 'runMemoryPreset': {
						// T7: 运行记忆AI预设（独立调用AI，不经过聊天流程）
						const presetId = data.presetId
						if (!presetId) return { success: false, error: '缺少 presetId' }

						const preset = presetsData.presets.find(p => p.id === presetId)
						if (!preset) return { success: false, error: `未找到预设 ${presetId}` }

						// 推送 running 状态到输出队列
						if (!data.dryRun) {
							pushMemoryAIOutput({
								presetId,
								presetName: preset.name,
								reply: '',
								thinking: '',
								operations: [],
								status: 'running',
							})
						}

						try {
							const result = await runMemoryPresetAI(
								username, charName, preset, memData,
								data.charDisplayName || charName,
								data.userDisplayName || username,
								data.chatHistory || '',
								{ dryRun: !!data.dryRun }
							)

							// T6: 如果是 P1 检索AI，缓存结果用于下次 GetPrompt 注入
							if (presetId === 'P1' && result.reply) {
								lastP1Result = {
									reply: result.reply,
									timestamp: result.timestamp,
								}
								console.log(`[beilu-memory] P1 检索结果已缓存，将在下次聊天中注入 (${result.reply.length}字符)`)
							}

							// 推送完成输出到队列（供前端显示）
							if (!data.dryRun) {
								pushMemoryAIOutput({
									presetId,
									presetName: preset.name,
									reply: result.reply || '',
									thinking: result.thinking || '',
									operations: result.operations || [],
									status: 'done',
									totalRounds: result.totalRounds,
									totalTimeMs: result.totalTimeMs,
								})
							}

							return { success: true, ...result }
						} catch (e) {
							console.error(`[beilu-memory] runMemoryPreset(${presetId}) 失败:`, e.message)
							// 推送错误到输出队列
							if (!data.dryRun) {
								pushMemoryAIOutput({
									presetId,
									presetName: preset.name,
									reply: '',
									thinking: '',
									operations: [],
									status: 'error',
									error: e.message,
								})
							}
							return { success: false, error: e.message }
						}
					}

					case 'getMemoryAIOutput': {
						// 获取记忆AI输出队列（前端轮询用）
						// sinceId: 只返回 ID > sinceId 的输出（数字比较）
						const sinceId = (data.sinceId !== undefined && data.sinceId !== null) ? Number(data.sinceId) : null
						let outputs = [...memoryAIOutputQueue]
						if (sinceId !== null && !isNaN(sinceId)) {
							outputs = outputs.filter(o => o.id > sinceId)
						}
						return { success: true, outputs, hasMore: outputs.length > 0 }
					}

					case 'clearMemoryAIOutput': {
						// 清空记忆AI输出队列
						memoryAIOutputQueue.length = 0
						return { success: true }
					}
	
					case 'dumpP1Request': {
						// 诊断工具：伪构建P1请求，返回实际会发送给AI的完整messages数组
						// 不实际调用AI，只构建并返回
						const presetId = data.presetId || 'P1'
						const preset = presetsData.presets.find(p => p.id === presetId)
						if (!preset) return { success: false, error: `未找到预设 ${presetId}` }

						const displayCharName = data.charDisplayName || charName
						const displayUserName = data.userDisplayName || username

						try {
							const result = await runMemoryPresetAI(
								username, charName, preset, memData,
								displayCharName, displayUserName,
								data.chatHistory || '(测试对话内容)',
								{ dryRun: true }
							)
							return {
								success: true,
								presetId: result.presetId,
								presetName: result.presetName,
								messageCount: result.messages.length,
								messages: result.messages.map((m, i) => ({
									index: i,
									role: m.role,
									contentLength: (m.content || '').length,
									content: m.content,
								})),
								timestamp: result.timestamp,
								note: '这是 dryRun 模式，不会实际调用AI。显示的是完整的实际请求内容。',
							}
						} catch (e) {
							return { success: false, error: e.message }
						}
					}

					case 'getDiagSnapshot': {
							// 诊断面板：返回系统运行状态快照
							const presetsForDiag = presetsData.presets || []
							const injPromptsForDiag = presetsData.injection_prompts || []
							return {
								success: true,
								pluginEnabled,
								autoTrigger: memData.config?.retrieval?.auto_trigger || false,
								hasP1Cache: !!lastP1Result,
								p1CacheLength: lastP1Result ? (lastP1Result.reply || '').length : 0,
								p1CacheTimestamp: lastP1Result?.timestamp || null,
								p1CacheContent: lastP1Result?.reply || null,
								isP1Running,
								enabledPresets: presetsForDiag.filter(p => p.enabled).map(p => p.id),
								enabledInjections: injPromptsForDiag.filter(p => p.enabled).map(p => p.id),
								injectionLog: [...injectionLog],
								outputQueueLength: memoryAIOutputQueue.length,
							}
						}
	
						case 'updateConfig': {
							// 更新 _config.json 中的配置字段（retrieval / injection / archive 等）
							const memDir = getMemoryDir(username, charName)
							const configPath = path.join(memDir, '_config.json')
							const currentConfig = loadJsonFileIfExists(configPath, { enabled: true })
	
							// 合并更新指定的配置段
							if (data.retrieval !== undefined) {
								currentConfig.retrieval = {
									...(currentConfig.retrieval || {}),
									...data.retrieval,
								}
							}
							if (data.injection !== undefined) {
								currentConfig.injection = {
									...(currentConfig.injection || {}),
									...data.injection,
								}
							}
							if (data.archive !== undefined) {
								currentConfig.archive = {
									...(currentConfig.archive || {}),
									...data.archive,
								}
							}
							if (data.enabled !== undefined) {
								currentConfig.enabled = !!data.enabled
							}
	
							// 保存到磁盘
							saveJsonFile(configPath, currentConfig)
	
							// 更新内存缓存
							const cacheKey = `${username}/${charName}`
							if (memoryCache.has(cacheKey)) {
								memoryCache.get(cacheKey).config = currentConfig
							}
	
							console.log(`[beilu-memory] 配置已更新 (${charName}):`, Object.keys(data).filter(k => k !== '_action' && k !== 'username' && k !== 'charName'))
							return { success: true, config: currentConfig }
						}
		
						default: {
						// 直接设置
						if (data.enabled !== undefined) pluginEnabled = data.enabled
						break
					}
				}
			},
		},
		chat: {
			/**
			 * GetPrompt: 每轮注入记忆（通过注入提示词条目）
			 */
			GetPrompt: async (arg) => {
				if (!pluginEnabled) return null
				// 重置 P1 触发标志（新一轮对话开始）
				p1TriggeredForCurrentReply = false

				const username = arg?.username
				const charName = arg?.char_id
				if (!username || !charName) return null

				try {
					const data = loadMemoryData(username, charName)
					if (!data.config?.enabled && data.config?.enabled !== undefined) return null

					// 获取用户显示名和角色显示名
					const userName = arg?.UserCharname || username
					const displayCharName = arg?.Charname || charName

					// 加载注入提示词
					const presetsData = loadMemoryPresets(username, charName)
					const injectionPrompts = presetsData.injection_prompts || structuredClone(DEFAULT_INJECTION_PROMPTS)

					// 获取 beilu-files 的 activeMode（用于 autoMode 判断）
					let filesActiveMode = 'chat'
					try {
						// 尝试从 beilu-files 获取当前模式
						// 通过 arg 中可能传递的信息，或者直接读取
						filesActiveMode = arg?.filesActiveMode || 'chat'
					} catch (e) { /* 默认 chat */ }

					// 生成表格数据文本（纯数据，不含操作规则）
					const tableDataText = generateTableDataOnly(data.tables, displayCharName, userName)

					// 读取热记忆层
					let hotMemoryText = readHotMemoryForInjection(username, charName)
					if (hotMemoryText) {
						hotMemoryText = hotMemoryText
							.replace(/\{\{char\}\}/g, displayCharName)
							.replace(/\{\{user\}\}/g, userName)
					}

					// 组装注入文本列表
						const textEntries = []
						// 按 depth 分组的注入条目（传递给 beilu-preset TweakPrompt）
						const depthInjections = []
	
						for (const inj of injectionPrompts) {
							// 判断是否启用（结合 autoMode 和 filesActiveMode）
							let shouldEnable = inj.enabled
	
							if (inj.autoMode === 'file') {
								// 'file' 模式: 只在文件模式下启用（且 enabled 为 true）
								shouldEnable = inj.enabled && filesActiveMode === 'file'
							} else if (inj.autoMode === 'always') {
								// 'always': 始终跟随 enabled 字段
								shouldEnable = inj.enabled
							}
							// 'manual': 只看 enabled 字段（默认行为，不需要额外逻辑）
	
							if (!shouldEnable) continue
	
							let content = inj.content
							// 替换宏
							// 提取最后一条用户消息
							let lastUserMsg = ''
							if (arg?.chat_log && Array.isArray(arg.chat_log)) {
								for (let i = arg.chat_log.length - 1; i >= 0; i--) {
									if (arg.chat_log[i].role === 'user') {
										lastUserMsg = arg.chat_log[i].content || ''
										break
									}
								}
							}
	
							const _tmINJ = getTimeMacroValues(arg?.chat_log)
							content = content
								.replace(/\{\{tableData\}\}/g, tableDataText)
								.replace(/\{\{hotMemory\}\}/g, hotMemoryText || '')
								.replace(/\{\{char\}\}/g, displayCharName)
								.replace(/\{\{user\}\}/g, userName)
								.replace(/\{\{lastUserMessage\}\}/g, lastUserMsg)
								.replace(/\{\{current_date\}\}/g, getTodayStr())
								.replace(/\{\{chat_history\}\}/g, (() => {
									if (!arg?.chat_log || !Array.isArray(arg.chat_log)) return ''
									const count = data.config?.retrieval?.chat_history_count || 5
									return arg.chat_log.slice(-count).map(m => {
										const role = m.role === 'user' ? userName : displayCharName
										return `${role}: ${m.content || ''}`
									}).join('\n\n')
								})())
								.replace(/\{\{time\}\}/g, _tmINJ.time)
								.replace(/\{\{date\}\}/g, _tmINJ.date)
								.replace(/\{\{weekday\}\}/g, _tmINJ.weekday)
								.replace(/\{\{idle_duration\}\}/g, _tmINJ.idle_duration)
								.replace(/\{\{lasttime\}\}/g, _tmINJ.lasttime)
								.replace(/\{\{lastdate\}\}/g, _tmINJ.lastdate)
	
							// 收集到 depthInjections（带 depth/order 元信息）
							depthInjections.push({
								id: inj.id,
								role: inj.role || 'system',
								content,
								depth: inj.depth ?? 0,
								order: inj.order ?? 0,
							})
	
							textEntries.push({ content, important: 5 })
						}
	
						// T6: P1 检索AI — 阻塞式运行（在聊天AI之前完成，结果直接注入当前轮）
						// 注意：必须在回退判断之前执行，否则 INJ 全部禁用时 P1 不会运行
						// fake-send 模式下跳过 P1 检索（避免提示词查看器触发真实AI调用）
						{
							const retrievalConfig = data.config?.retrieval || {}
							if (retrievalConfig.auto_trigger && !arg.isFakeSend) {
								const p1Preset = presetsData.presets.find(p => p.id === 'P1')
								if (p1Preset && p1Preset.enabled) {
									// 构建聊天记录
									let chatHistory = ''
									const chatHistoryCount = retrievalConfig.chat_history_count || 5
									if (arg?.chat_log && Array.isArray(arg.chat_log)) {
										const recent = arg.chat_log.slice(-chatHistoryCount)
										chatHistory = recent.map(m => {
											const role = m.role === 'user' ? userName : displayCharName
											return `${role}: ${m.content || ''}`
										}).join('\n\n')
									}
	
									pushMemoryAIOutput({
										presetId: 'P1', presetName: '检索AI',
										reply: '', thinking: '', operations: [],
										status: 'running',
									})
	
									try {
										const result = await runMemoryPresetAI(
											username, charName, p1Preset, data,
											displayCharName, userName, chatHistory
										)
										const replyText = (result.reply || '').trim()
	
										// 判定P1是否返回了实质性记忆内容
										const _noResultKws = ['无需检索', '无相关记忆', '无关联记忆', '无内容', '无相关内容']
										const _isP1NoResult = replyText.length < 5 || _noResultKws.some(kw => replyText.includes(kw))
										if (!_isP1NoResult) {
											const p1Content = `[记忆AI检索结果]\n${result.reply}\n[/记忆AI检索结果]`
											depthInjections.push({
												id: 'P1_RETRIEVAL', role: 'system',
												content: p1Content, depth: 0, order: 1,
											})
											textEntries.push({ content: p1Content, important: 6 })
											console.log(`[beilu-memory] P1 检索结果已注入到本轮对话 (${result.reply.length}字符)`)
										} else {
											console.log(`[beilu-memory] P1 判定无实质内容: "${replyText.substring(0, 30)}"`)
										}
	
										pushMemoryAIOutput({
											presetId: 'P1', presetName: '检索AI',
											reply: replyText || '无相关记忆',
											thinking: result.thinking || '', operations: result.operations || [],
											status: 'done', totalRounds: result.totalRounds || 1,
											totalTimeMs: result.totalTimeMs,
										})
									} catch (e) {
										console.error(`[beilu-memory] P1 检索失败:`, e.message)
										pushMemoryAIOutput({
											presetId: 'P1', presetName: '检索AI',
											reply: '', thinking: '', operations: [],
											status: 'error', error: e.message,
										})
									}
								}
							}
							// 兼容：旧缓存结果注入（正常情况不会触发）
							if (lastP1Result) {
								const p1Content = `[记忆AI检索结果 (${lastP1Result.timestamp || ''})]\n${lastP1Result.reply}\n[/记忆AI检索结果]`
								depthInjections.push({ id: 'P1_RETRIEVAL', role: 'system', content: p1Content, depth: 0, order: 1 })
								textEntries.push({ content: p1Content, important: 6 })
								lastP1Result = null
							}
						}
	
						// 如果没有任何注入条目启用（且 P1 也无结果），回退到旧方式（表格+热记忆）
						if (textEntries.length === 0) {
							const tableText = tablesToPromptText(data.tables, displayCharName, userName)
							let fullText = tableText
							if (hotMemoryText) {
								fullText += '\n\n[相关记忆]' + hotMemoryText + '\n[/记忆]'
							}
							// 注入日志：回退模式
							injectionLog.push({
								timestamp: new Date().toISOString(),
								injectionCount: 1,
								p1Injected: false,
								hotMemoryLength: hotMemoryText ? hotMemoryText.length : 0,
								tableDataLength: tableDataText.length,
								mode: 'fallback',
							})
							while (injectionLog.length > 20) injectionLog.shift()
							return {
								text: [{ content: fullText, important: 5 }],
								additional_chat_log: [],
								extension: {},
							}
						}
	
						// 热记忆不再硬编码注入。用户可在 INJ 条目的 content 中使用 {{hotMemory}} 宏按需注入。
	
						// 注入日志：正常模式
						const _p1WasInjected = depthInjections.some(d => d.id === 'P1_RETRIEVAL')
						injectionLog.push({
							timestamp: new Date().toISOString(),
							injectionCount: textEntries.length,
							p1Injected: _p1WasInjected,
							hotMemoryLength: hotMemoryText ? hotMemoryText.length : 0,
							tableDataLength: tableDataText.length,
							depthCount: depthInjections.length,
							mode: 'injection_prompts',
						})
						while (injectionLog.length > 20) injectionLog.shift()
	
						return {
							text: textEntries,
							additional_chat_log: [],
							extension: {
								// 传递给 beilu-preset TweakPrompt 的 depth 注入信息
								memory_depth_injections: depthInjections,
							},
						}
				} catch (e) {
					console.error('[beilu-memory] GetPrompt error:', e.message)
					// 注入日志：错误
					injectionLog.push({
						timestamp: new Date().toISOString(),
						injectionCount: 0,
						p1Injected: false,
						hotMemoryLength: 0,
						tableDataLength: 0,
						error: e.message,
					})
					while (injectionLog.length > 20) injectionLog.shift()
					return null
				}
			},

			/**
			 * ReplyHandler: 解析 AI 回复中的 <tableEdit> / <memoryArchive> / <memorySearch> / <memoryNote>
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginEnabled) return false
				if (!reply || !reply.content) return false

				const username = args?.username
				const charName = args?.char_id
				if (!username || !charName) return false

				try {
					let content = reply.content

					// 1. 解析 <tableEdit>
					const { operations, cleanContent: afterTableEdit } = parseTableEditTags(content)
					content = afterTableEdit

					if (operations.length > 0) {
						const data = loadMemoryData(username, charName)
						const successCount = executeTableOperations(data.tables, operations)
						if (successCount > 0) {
							saveTablesData(username, charName)
							console.log(`[beilu-memory] 执行了 ${successCount}/${operations.length} 个表格操作 (${charName})`)
						}
					}

					// 2. 解析 <memoryArchive> 并执行文件操作
					const { archiveOps, cleanContent: afterArchive } = parseMemoryArchiveTags(content)
					content = afterArchive
					if (archiveOps.length > 0) {
						const replyMemData = loadMemoryData(username, charName)
						const archiveResults = executeMemoryArchiveOps(archiveOps, username, charName, replyMemData.tables)
						const archiveOkCount = archiveResults.filter(r => r.status === 'ok').length
						if (archiveOkCount > 0) {
							saveTablesData(username, charName)
						}
						console.log(`[beilu-memory] ReplyHandler: memoryArchive ${archiveOkCount}/${archiveResults.length} 操作成功 (${charName})`)
					}

					// 3. 解析 <memorySearch>（Phase 2 完善）
					const { cleanContent: afterSearch } = parseMemorySearchTags(content)
					content = afterSearch

					// 4. 解析 <memoryNote>
					content = parseMemoryNoteTags(content, username, charName)

					// 更新回复内容（清除所有记忆标签）
					reply.content = content
	
					// 5. 自动检查是否需要触发归档
					autoCheckArchiveTriggers(username, charName)
	
					// 6. P1 自动触发已移至 GetPrompt 中（阻塞式，在聊天AI之前完成）
					// ReplyHandler 不再触发 P1
	
				} catch (e) {
					console.error('[beilu-memory] ReplyHandler error:', e.message)
					// 错误降级：不阻塞对话，但清除标签
					reply.content = reply.content
						.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, '')
						.replace(/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi, '')
						.replace(/<memorySearch>[\s\S]*?<\/memorySearch>/gi, '')
						.replace(/<memoryNote\s+type="\w+">[\s\S]*?<\/memoryNote>/gi, '')
						.trim()
				}

				return false // 不阻止其他 handler
			},
		},
	},
}

export default pluginExport
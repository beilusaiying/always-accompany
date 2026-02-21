/**
 * beilu 后端诊断日志框架
 *
 * Deno/Node 兼容版本，与前端 diagLogger 共享相同的模块名和级别体系。
 *
 * 控制方式：
 * 1. 环境变量: BEILU_DIAG=* 或 BEILU_DIAG=chat,proxy
 * 2. 环境变量: BEILU_DIAG_LEVEL=debug
 * 3. API端点: /api/diag/enable, /api/diag/disable, /api/diag/status (需要在路由中注册)
 * 4. 运行时: import { diagControl } from './diagLogger.mjs'; diagControl.enable('*')
 *
 * 模块列表（后端）：
 * - chat            聊天引擎（triggerCharReply, executeGeneration, chatLog）
 * - proxy           AI代理/源（fetchChatCompletion, SSE, StructCall）
 * - preset          预设引擎（TweakPrompt, buildAllEntries, 宏替换）
 * - memory          记忆系统（P1-P6, 表格操作, 归档）
 * - worldbook       世界书（导入/格式转换, 条目注入）
 * - files           文件操作（工作区沙箱, 权限, 审批队列）
 * - eye             桌面截图（Python进程, 截图注入）
 * - regex           正则插件（规则加载, ST导入）
 * - auth            认证/用户管理
 * - server          HTTP服务器/路由
 * - parts           部件加载器
 * - stream          流式输出（buffer, diff, 广播）
 */

// ============================================================
// 日志级别
// ============================================================

const LEVELS = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4,
}

// ============================================================
// ANSI 颜色码（终端彩色输出）
// ============================================================

const ANSI_COLORS = {
	chat: '\x1b[33m',       // 黄色
	proxy: '\x1b[36m',      // 青色
	preset: '\x1b[35m',     // 紫色
	memory: '\x1b[34m',     // 蓝色
	worldbook: '\x1b[32m',  // 绿色
	files: '\x1b[94m',      // 亮蓝
	eye: '\x1b[95m',        // 亮紫
	regex: '\x1b[91m',      // 亮红
	auth: '\x1b[93m',       // 亮黄
	server: '\x1b[96m',     // 亮青
	parts: '\x1b[92m',      // 亮绿
	stream: '\x1b[90m',     // 灰色
}
const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'

// ============================================================
// 运行时状态（可通过 API 或 diagControl 修改）
// ============================================================

let enabledModules = _parseEnvModules()
let currentLevel = _parseEnvLevel()

/**
 * 从环境变量解析启用的模块
 * @returns {Set<string>|'*'}
 */
function _parseEnvModules() {
	try {
		// Deno
		const val = typeof Deno !== 'undefined'
			? Deno.env.get('BEILU_DIAG')
			: (typeof process !== 'undefined' ? process.env.BEILU_DIAG : undefined)
		if (!val) return new Set()
		if (val.trim() === '*') return '*'
		return new Set(val.split(',').map(s => s.trim()).filter(Boolean))
	} catch {
		return new Set()
	}
}

/**
 * 从环境变量解析日志级别
 * @returns {number}
 */
function _parseEnvLevel() {
	try {
		const val = typeof Deno !== 'undefined'
			? Deno.env.get('BEILU_DIAG_LEVEL')
			: (typeof process !== 'undefined' ? process.env.BEILU_DIAG_LEVEL : undefined)
		if (val && LEVELS[val] !== undefined) return LEVELS[val]
		return LEVELS.info
	} catch {
		return LEVELS.info
	}
}

/**
 * 判断模块是否启用
 * @param {string} moduleName
 * @returns {boolean}
 */
function isModuleEnabled(moduleName) {
	if (enabledModules === '*') return true
	return enabledModules.has(moduleName)
}

/**
 * 判断级别是否应该输出
 * @param {string} level
 * @returns {boolean}
 */
function isLevelEnabled(level) {
	return (LEVELS[level] ?? LEVELS.info) <= currentLevel
}

// ============================================================
// 快照存储
// ============================================================

const MAX_SNAPSHOTS = 200
const snapshots = []

// ============================================================
// createDiag — 创建模块专属日志器
// ============================================================

/**
 * 创建后端模块专属的日志器
 *
 * @param {string} moduleName - 模块名称
 * @returns {object} 日志器对象
 *
 * @example
 * import { createDiag } from '../../server/diagLogger.mjs'
 * const diag = createDiag('chat')
 * diag.log('triggerCharReply:', chatId)
 * diag.guard(entry, ['id', 'content'], 'finalizeEntry')
 */
export function createDiag(moduleName) {
	const color = ANSI_COLORS[moduleName] || '\x1b[37m'
	const prefix = `${color}${ANSI_BOLD}[${moduleName} DIAG]${ANSI_RESET}`

	/**
	 * 内部输出
	 */
	function emit(method, level, ...args) {
		if (level !== 'error' && (!isModuleEnabled(moduleName) || !isLevelEnabled(level))) return
		const timestamp = new Date().toLocaleTimeString()
		console[method](`${prefix} ${timestamp}`, ...args)
	}

	const timers = new Map()

	return {
		log: (...args) => emit('log', 'info', ...args),
		warn: (...args) => emit('warn', 'warn', ...args),
		error: (...args) => emit('error', 'error', ...args),
		debug: (...args) => emit('log', 'debug', ...args),
		trace: (...args) => emit('log', 'trace', ...args),

		time(label) {
			if (!isModuleEnabled(moduleName)) return
			timers.set(label, performance.now())
		},

		timeEnd(label) {
			if (!isModuleEnabled(moduleName)) return
			const start = timers.get(label)
			if (start !== undefined) {
				const elapsed = (performance.now() - start).toFixed(1)
				emit('log', 'info', `${label}: ${elapsed}ms`)
				timers.delete(label)
			}
		},

		assert(condition, ...args) {
			if (!condition) emit('warn', 'warn', '[ASSERT FAILED]', ...args)
		},

		throttled: (() => {
			const counters = new Map()
			return (key, interval, ...args) => {
				const count = (counters.get(key) || 0) + 1
				counters.set(key, count)
				if (count === 1 || count % interval === 0) {
					emit('log', 'info', `[#${count}]`, ...args)
				}
			}
		})(),

		/**
		 * 数据完整性守卫
		 * @param {any} obj
		 * @param {string[]} requiredFields
		 * @param {string} context
		 * @returns {boolean}
		 */
		guard(obj, requiredFields, context) {
			if (!obj || typeof obj !== 'object') {
				emit('error', 'error', `[GUARD] ${context}: 对象为空或非对象`,
					'received:', typeof obj, obj)
				return false
			}

			const missing = requiredFields.filter(f => !(f in obj))
			if (missing.length > 0) {
				emit('warn', 'warn', `[GUARD] ${context}: 缺少字段:`, missing.join(', '),
					'| 现有字段:', Object.keys(obj).join(', '),
					'| constructor:', obj.constructor?.name || '(none)')
				return false
			}

			const nullish = requiredFields.filter(f => obj[f] === undefined || obj[f] === null)
			if (nullish.length > 0) {
				emit('log', 'debug', `[GUARD] ${context}: 字段值为空:`,
					nullish.map(f => `${f}=${obj[f]}`).join(', '))
			}

			return true
		},

		/**
		 * 状态快照
		 * @param {string} label
		 * @param {object} data
		 */
		snapshot(label, data) {
			if (!isModuleEnabled(moduleName) || !isLevelEnabled('debug')) return
			const entry = {
				t: Date.now(),
				module: moduleName,
				label,
				data: { ...data },
			}
			snapshots.push(entry)
			if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift()
			emit('log', 'trace', `[SNAPSHOT] ${label}:`, data)
		},

		/**
		 * 类型检查
		 * @param {any} value
		 * @param {string} expectedType
		 * @param {string} context
		 * @returns {boolean}
		 */
		typeCheck(value, expectedType, context) {
			let actual
			if (Array.isArray(value)) actual = 'array'
			else if (value === null) actual = 'null'
			else actual = typeof value

			if (actual !== expectedType) {
				emit('warn', 'warn', `[TYPE] ${context}: 期望 ${expectedType}, 实际 ${actual}`)
				return false
			}
			return true
		},
	}
}

// ============================================================
// 全局控制 API
// ============================================================

export const diagControl = {
	enable(modules) {
		if (modules === '*') {
			enabledModules = '*'
			console.log('\x1b[32m[beiluDiag] ✅ 已启用所有后端诊断模块\x1b[0m')
			return
		}
		const toAdd = modules.split(',').map(s => s.trim()).filter(Boolean)
		if (enabledModules === '*') {
			enabledModules = new Set(toAdd)
		} else {
			for (const m of toAdd) enabledModules.add(m)
		}
		console.log('\x1b[32m[beiluDiag] ✅ 已启用模块:\x1b[0m', Array.from(enabledModules).join(', '))
	},

	disable(modules) {
		if (modules === '*') {
			enabledModules = new Set()
			console.log('\x1b[31m[beiluDiag] ❌ 已禁用所有后端诊断模块\x1b[0m')
			return
		}
		if (enabledModules === '*') {
			const allModules = Object.keys(ANSI_COLORS)
			const toRemove = new Set(modules.split(',').map(s => s.trim()))
			enabledModules = new Set(allModules.filter(m => !toRemove.has(m)))
		} else {
			const toRemove = modules.split(',').map(s => s.trim())
			for (const m of toRemove) enabledModules.delete(m)
		}
		console.log('\x1b[31m[beiluDiag] ❌ 已禁用模块:\x1b[0m', modules)
	},

	setLevel(level) {
		if (LEVELS[level] === undefined) {
			console.warn('[beiluDiag] 无效级别。可用:', Object.keys(LEVELS).join(', '))
			return
		}
		currentLevel = LEVELS[level]
		console.log('\x1b[34m[beiluDiag] 📊 日志级别设为:\x1b[0m', level)
	},

	status() {
		const levelName = Object.entries(LEVELS).find(([, v]) => v === currentLevel)?.[0] || 'info'
		console.log('\x1b[33m╔══════════════════════════════════════╗\x1b[0m')
		console.log('\x1b[33m║  beilu 后端诊断系统 · 状态面板      ║\x1b[0m')
		console.log('\x1b[33m╚══════════════════════════════════════╝\x1b[0m')
		console.log('  📡 启用模块:', enabledModules === '*' ? '✅ 全部 (*)' : (enabledModules.size ? `✅ ${Array.from(enabledModules).join(', ')}` : '❌ (无)'))
		console.log('  📊 日志级别:', levelName)
		console.log('  📸 快照缓存:', `${snapshots.length}/${MAX_SNAPSHOTS}`)
		console.log('  可用模块:', Object.keys(ANSI_COLORS).join(', '))
	},

	all() {
		this.enable('*')
		this.setLevel('debug')
	},

	/**
	 * 获取诊断状态（用于 API 端点返回）
	 * @returns {object}
	 */
	getStatus() {
		return {
			modules: enabledModules === '*' ? '*' : Array.from(enabledModules),
			level: Object.entries(LEVELS).find(([, v]) => v === currentLevel)?.[0] || 'info',
			snapshots: snapshots.length,
			maxSnapshots: MAX_SNAPSHOTS,
			availableModules: Object.keys(ANSI_COLORS),
			availableLevels: Object.keys(LEVELS),
		}
	},

	/**
	 * 获取快照（用于 API 端点返回）
	 * @param {number} [count=50]
	 * @param {string} [filterModule]
	 * @returns {Array}
	 */
	getSnapshots(count = 50, filterModule = null) {
		let filtered = snapshots
		if (filterModule) filtered = snapshots.filter(s => s.module === filterModule)
		return filtered.slice(-count)
	},

	/** 清空快照 */
	clearSnapshots() {
		snapshots.length = 0
	},

	modules: Object.keys(ANSI_COLORS),
	levels: Object.keys(LEVELS),
}

// 启动时显示状态
if (enabledModules === '*' || (enabledModules instanceof Set && enabledModules.size > 0)) {
	const levelName = Object.entries(LEVELS).find(([, v]) => v === currentLevel)?.[0] || 'info'
	console.log(`\x1b[33m[beiluDiag] 🔬 后端诊断模式已激活 | 模块: ${enabledModules === '*' ? '*' : Array.from(enabledModules).join(',')} | 级别: ${levelName}\x1b[0m`)
}
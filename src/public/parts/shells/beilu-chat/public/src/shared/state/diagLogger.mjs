/**
 * [diagLogger.mjs] — 前端全系统诊断日志框架 v2。不管业务逻辑（所有业务模块通过 createDiag() 消费），
 *   不管后端日志系统（后端有独立的 diagLogger，本模块通过 pack() 跨端合并导出）。
 *
 * 功能链：
 *   日志输出：各前端模块 → createDiag(moduleName) → diag.log/warn/error/debug/trace()
 *     → 模块+级别过滤（从 localStorage 读配置）→ console 彩色输出 + logBuffer 环形缓冲（500条）
 *   状态快照：各前端模块 → diag.snapshot(label, data) → snapshots 环形缓冲（200条）（事后分析时序问题用）
 *   数据守卫：各前端模块 → diag.guard(obj, requiredFields, context) → 检查必需字段 → 缺失时 warn 输出
 *   API 追踪：各前端模块 → diag.traceFetch(url, options) → 原生 fetch + 计时 → 自动记录耗时/状态码
 *   全局控制：浏览器控制台 → window.beiluDiag.enable/disable/setLevel/status/pack() → localStorage 持久化
 *   日志打包：beiluDiag.pack() → apiFetch 后端 /diag/logs + /diag/snapshots + /diag/status
 *     → 前后端日志合并 → 触发浏览器 JSON 文件下载
 *   Console 拦截：模块加载时 installConsoleHook() → 覆写 console.log/warn/error/info
 *     → 所有控制台输出同步写入 logBuffer（供 pack() 导出）
 *
 * why：前端调试 bug 时经常需要复现用户操作序列、追踪竞态时序（rAF 覆盖/流式竞态/replaceItem 顺序），
 *   但浏览器控制台日志在报 bug 时已清空，且前后端日志分散。本模块提供：
 *   1) 按模块+级别过滤——生产环境默认关闭噪音，调试时 beiluDiag.enable("template") 精确开启
 *   2) 环形缓冲——始终保留最近 500 条日志，刷新前可 pack() 导出
 *   3) guard()/snapshot() 针对历史高频 bug 模式（缺 id 字段/竞态覆盖）设计的专用探针
 *   4) pack() 前后端日志合并——用户反馈 bug 时一键打包，无需手动截图+复制
 *   traceFetch() 故意使用原生 fetch 而非 apiFetch，避免双重封装（apiFetch 已有超时/401处理，
 *   traceFetch 是计时包装器本体，套 apiFetch 会改返回类型导致调用方链式解析失败）。
 *
 * 关联链：
 *   import → api-client.mjs（apiFetch，仅 pack() 拉后端日志用）/ storage.mjs（storage/KEYS，读写过滤配置）
 *   被 import → 全前端模块（通过 createDiag(moduleName) 获取各自专属日志器）
 *   window.beiluDiag → 浏览器控制台直接调用 / URL ?diag= 参数自动配置
 *
 * 影响范围：
 *   - 改动 installConsoleHook() → 影响 logBuffer 内容（pack() 导出的前端日志完整性）
 *   - 改动 MAX_LOGS (500) / MAX_SNAPSHOTS (200) → 影响内存占用和可追溯的历史深度
 *   - 改动 emit() 中的 error 始终输出逻辑 → 影响生产环境 error 级别日志是否始终可见
 *   - 改动 STORAGE_KEY / STORAGE_LEVEL_KEY → 影响用户已持久化的诊断配置（相当于配置重置）
 *   - 改动 pack() 的后端 API 路径 → 影响前后端日志合并下载功能
 *
 * 使用效果：
 *   - 正常用户：无感知（console 拦截静默，logBuffer 在内存，不影响性能）
 *   - 开发者调试：浏览器控制台 beiluDiag.enable("template") → 该模块的 diag.log() 开始彩色输出
 *   - 用户报 bug：beiluDiag.pack() → 自动下载 beilu-diag-xxx.json（含前后端日志+快照）→ 开发者分析
 *   - URL 参数调试：?diag=websocket,template → 自动写 localStorage → 刷新后仍持续开启
 *
 * 核心 API：guard() 数据完整性守卫、snapshot() 状态快照、traceFetch() 请求追踪、pack() 一键打包
 *
 * 控制方式：
 * 1. localStorage: 设置 'beilu-diag-modules' = '*' (全部) 或 'template,websocket' (指定模块)
 * 2. 浏览器控制台: window.beiluDiag.enable('*') / .disable('template') / .status()
 * 3. URL 参数: ?diag=* 或 ?diag=template,websocket （写入 localStorage 持久启用，刷新后仍生效）
 *
 * 模块列表（前端）：
 * ── 聊天引擎 ──
 * - template        模板引擎 ${} 解析
 * - displayRegex    正则渲染（美化系统）
 * - messageList     消息渲染路径
 * - streamRenderer  流式渲染（逐字输出）
 * - virtualQueue    消息事件队列
 * - websocket       WebSocket 通信
 * - iframeRenderer  iframe 渲染
 * - stCompat        SillyTavern 兼容层
 * ── UI ──
 * - sidebar         侧边栏
 * - fileExplorer    文件浏览器
 * - layout          布局/控件
 * ── 系统 ──
 * - config          配置/默认值验证
 * - api             API 通信（fetch 请求/响应）
 * - dom             DOM 操作追踪
 * - perf            性能指标采集
 * ── 后端标记 ──
 * - chat            后端聊天引擎（标记用）
 * - proxy           后端代理/AI源（标记用）
 * - preset          预设引擎（标记用）
 * - memory          记忆系统（标记用）
 * - worldbook       世界书（标记用）
 * - files           文件操作（标记用）
 * - regex           正则插件（标记用）
 * - browser         网页快照插件（标记用）
 * - vectordb        向量数据库插件（标记用）
 * - discord         Discord Bot（标记用）
 */

import { apiFetch } from '../transport/api-client.mjs' // R1: raw fetch → apiFetch（timeout+401；raw 保留 .then(r.ok?json) 链）
import { storage, KEYS } from "./storage.mjs"; // R2: localStorage 集中
import { DEFAULTS } from "../../config/defaults.mjs"; // T2 config 收口：缓冲上限单源

const STORAGE_KEY = KEYS.BEILU_DIAG_MODULES
const STORAGE_LEVEL_KEY = KEYS.BEILU_DIAG_LEVEL

// 日志级别：数值越大越详细
const LEVELS = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4,
}

// 模块颜色映射（用于控制台区分）
const MODULE_COLORS = {
	// ── 聊天引擎 ──
	template: '#ff9800',
	displayRegex: '#4caf50',
	messageList: '#2196f3',
	streamRenderer: '#9c27b0',
	virtualQueue: '#00bcd4',
	websocket: '#e91e63',
	iframeRenderer: '#607d8b',
	stCompat: '#00897b',
	// ── UI ──
	sidebar: '#ff5722',
	fileExplorer: '#8bc34a',
	layout: '#cddc39',
	// ── 系统 ──
	config: '#ffc107',
	api: '#03a9f4',
	dom: '#ff7043',
	perf: '#ab47bc',
	// ── 后端标记（前端显示用）──
	chat: '#795548',
	proxy: '#546e7a',
	preset: '#6d4c41',
	memory: '#7e57c2',
	worldbook: '#26a69a',
	files: '#5c6bc0',
	regex: '#ef5350',
	browser: '#ff6d00',
	vectordb: '#00b8d4',
	discord: '#5865f2',
}

// ============================================================
// 状态快照存储（用于事后分析时序问题）
// ============================================================
const MAX_SNAPSHOTS = DEFAULTS.diag.maxSnapshots
const snapshots = []

// ============================================================
// 日志缓冲区（用于一键打包导出）
// ============================================================
const MAX_LOGS = DEFAULTS.diag.maxLogs
const logBuffer = []

/**
 * 获取启用的模块集合
 * @returns {Set<string>|'*'}
 */
function getEnabledModules() {
	try {
		const val = storage.get(STORAGE_KEY)
		if (!val) return new Set() // 默认全部关闭
		if (val.trim() === '*') return '*'
		return new Set(val.split(',').map(s => s.trim()).filter(Boolean))
	} catch {
		return new Set()
	}
}

/**
 * 获取当前日志级别
 * @returns {number}
 */
function getLevel() {
	try {
		const val = storage.get(STORAGE_LEVEL_KEY)
		if (val && LEVELS[val] !== undefined) return LEVELS[val]
		return LEVELS.info // 默认 info
	} catch {
		return LEVELS.info
	}
}

/**
 * 判断指定模块是否启用
 * @param {string} moduleName
 * @returns {boolean}
 */
function isModuleEnabled(moduleName) {
	const enabled = getEnabledModules()
	if (enabled === '*') return true
	return enabled.has(moduleName)
}

/**
 * 判断指定级别是否应该输出
 * @param {string} level
 * @returns {boolean}
 */
function isLevelEnabled(level) {
	const currentLevel = getLevel()
	return (LEVELS[level] ?? LEVELS.info) <= currentLevel
}

/**
 * 创建模块专属的日志器
 *
 * @param {string} moduleName - 模块名称
 * @returns {object} 日志器对象
 *
 * @example
 * const diag = createDiag('template')
 * diag.log('expression parsed:', expr)     // 仅当 template 模块启用时输出
 * diag.warn('fallback triggered')          // warn 级别
 * diag.error('critical failure', err)      // error 始终输出（不受模块过滤）
 * diag.guard(message, ['id', 'content'], 'renderMessage')  // 数据完整性检查
 * diag.snapshot('pre-render', { id, contentType })          // 状态快照
 */
export function createDiag(moduleName) {
	const color = MODULE_COLORS[moduleName] || '#999'
	const prefix = `%c[${moduleName} DIAG]`
	const style = `color: ${color}; font-weight: bold`

	/**
	 * 内部输出函数
	 * @param {'log'|'warn'|'error'|'debug'} method
	 * @param {string} level
	 * @param  {...any} args
	 */
	function emit(method, level, ...args) {
		// error 级别始终输出
		if (level !== 'error' && (!isModuleEnabled(moduleName) || !isLevelEnabled(level))) return
		console[method](prefix, style, ...args)
	}

	const timers = new Map()

	return {
		/** @param {...any} args */
		log: (...args) => emit('log', 'info', ...args),
		/** @param {...any} args */
		warn: (...args) => emit('warn', 'warn', ...args),
		/** @param {...any} args */
		error: (...args) => emit('error', 'error', ...args),
		/** @param {...any} args */
		debug: (...args) => emit('log', 'debug', ...args),
		/** @param {...any} args */
		trace: (...args) => emit('log', 'trace', ...args),

		/**
		 * 开始计时
		 * @param {string} label
		 */
		time: (label) => {
			if (!isModuleEnabled(moduleName)) return
			timers.set(label, performance.now())
		},

		/**
		 * 结束计时并输出
		 * @param {string} label
		 */
		timeEnd: (label) => {
			if (!isModuleEnabled(moduleName)) return
			const start = timers.get(label)
			if (start !== undefined) {
				const elapsed = (performance.now() - start).toFixed(1)
				emit('log', 'info', `${label}: ${elapsed}ms`)
				timers.delete(label)
			}
		},

		/**
		 * 条件日志：仅当 condition 为 false 时输出警告
		 * @param {boolean} condition
		 * @param {...any} args
		 */
		assert: (condition, ...args) => {
			if (!condition) emit('warn', 'warn', '[ASSERT FAILED]', ...args)
		},

		/**
		 * 带计数的日志（每 N 次输出一次，避免高频日志刷屏）
		 * @param {string} key - 计数器 key
		 * @param {number} interval - 每 N 次输出一次
		 * @param {...any} args
		 */
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
		 *
		 * 检查对象是否具有必需的字段，缺失时输出详细诊断信息。
		 * 基于历史bug模式设计：chatLog缺id、世界书缺uid、entry缺toData等。
		 *
		 * @param {any} obj - 要检查的对象
		 * @param {string[]} requiredFields - 必需字段列表
		 * @param {string} context - 调用上下文描述（用于日志）
		 * @returns {boolean} 是否通过检查（所有字段都存在）
		 *
		 * @example
		 * if (!diag.guard(message, ['id', 'content', 'role'], 'renderMessage')) {
		 *     // 缺少字段的处理逻辑
		 * }
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
					'| constructor:', obj.constructor?.name || '(none)',
					'| 对象预览:', _summarize(obj))
				return false
			}

			// debug级别：字段存在但值为undefined/null的也报告
			const nullish = requiredFields.filter(f => obj[f] === undefined || obj[f] === null)
			if (nullish.length > 0) {
				emit('log', 'debug', `[GUARD] ${context}: 字段值为空:`,
					nullish.map(f => `${f}=${obj[f]}`).join(', '))
			}

			return true
		},

		/**
		 * 状态快照
		 *
		 * 在关键节点保存状态快照，用于事后分析时序问题。
		 * 基于历史bug模式设计：rAF覆盖、流式竞态、replaceItem时序。
		 *
		 * @param {string} label - 快照标签
		 * @param {object} data - 要保存的状态数据（会被浅拷贝）
		 *
		 * @example
		 * diag.snapshot('pre-replaceItem', { messageId, isGenerating, contentLen: content.length })
		 * // ... 执行操作 ...
		 * diag.snapshot('post-replaceItem', { messageId, domExists: !!document.getElementById(messageId) })
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
		 * 数据格式验证
		 *
		 * 检查值的类型是否匹配预期，用于捕获格式转换问题。
		 * 基于历史bug模式设计：ST世界书格式不匹配、entries容器类型错误等。
		 *
		 * @param {any} value - 要检查的值
		 * @param {string} expectedType - 期望类型（'string'|'number'|'boolean'|'array'|'object'|'function'）
		 * @param {string} context - 上下文描述
		 * @returns {boolean} 是否匹配
		 */
		typeCheck(value, expectedType, context) {
			let actual
			if (Array.isArray(value)) actual = 'array'
			else if (value === null) actual = 'null'
			else actual = typeof value

			if (actual !== expectedType) {
				emit('warn', 'warn', `[TYPE] ${context}: 期望 ${expectedType}, 实际 ${actual}`,
					'| 值预览:', _summarize(value))
				return false
			}
			return true
		},

		/**
		 * API 请求/响应追踪
		 *
		 * 包装 fetch 调用，自动记录请求URL、状态码、耗时、错误。
		 * 基于历史bug模式设计：SSE body内嵌error、404端点、空响应。
		 *
		 * @param {string} url - 请求URL
		 * @param {object} [options] - fetch options
		 * @returns {Promise<Response>} fetch响应
		 */
		async traceFetch(url, options = {}) {
			const start = performance.now()
			const method = options.method || 'GET'
			emit('log', 'debug', `[API] ${method} ${url}`)
			try {
				// R1-SKIP: traceFetch 是 fetch 计时/日志包装器本体，透传任意 url/options 并返回原始 Response 供调用方自管解析；套 apiFetch 会双重封装+改返回类型。
				const res = await fetch(url, options)
				const elapsed = (performance.now() - start).toFixed(0)
				if (!res.ok) {
					emit('warn', 'warn', `[API] ${method} ${url} → ${res.status} (${elapsed}ms)`)
				} else {
					emit('log', 'trace', `[API] ${method} ${url} → ${res.status} (${elapsed}ms)`)
				}
				return res
			} catch (err) {
				const elapsed = (performance.now() - start).toFixed(0)
				emit('error', 'error', `[API] ${method} ${url} → FAILED (${elapsed}ms):`, err.message)
				throw err
			}
		},
	}
}

/**
 * 对象摘要（用于日志输出，避免打印巨大对象）
 * @param {any} obj
 * @returns {string}
 */
function _summarize(obj) {
	if (obj === null || obj === undefined) return String(obj)
	if (typeof obj === 'string') return obj.length > 100 ? obj.substring(0, 100) + '...' : obj
	if (typeof obj !== 'object') return String(obj)
	if (Array.isArray(obj)) return `Array(${obj.length})`
	const keys = Object.keys(obj)
	if (keys.length <= 5) {
		const entries = keys.map(k => {
			const v = obj[k]
			if (typeof v === 'string') return `${k}:"${v.length > 30 ? v.substring(0, 30) + '...' : v}"`
			if (typeof v === 'object' && v !== null) return `${k}:{...}`
			return `${k}:${v}`
		})
		return `{${entries.join(', ')}}`
	}
	return `{${keys.length} keys: ${keys.slice(0, 5).join(', ')}...}`
}

/**
 * 安全序列化（用于日志缓冲区，避免循环引用和巨大对象）
 * @param {any} val
 * @returns {string}
 */
function _safeStringify(val) {
	if (val === null || val === undefined) return String(val)
	if (typeof val === 'string') {
		// 过滤 CSS 样式字符串（%c 格式化前缀产生的样式参数）
		if (val.startsWith('color:') || val.startsWith('font-weight:') || val.startsWith('background:')) return ''
		return val.length > 500 ? val.substring(0, 500) + '...[truncated]' : val
	}
	if (typeof val === 'number' || typeof val === 'boolean') return String(val)
	if (val instanceof Error) return `${val.name}: ${val.message}`
	if (typeof val === 'object') {
		try {
			const json = JSON.stringify(val, (key, value) => {
				if (typeof value === 'string' && value.length > 200) return value.substring(0, 200) + '...'
				if (value instanceof HTMLElement) return `<${value.tagName.toLowerCase()} id="${value.id || ''}">`
				return value
			})
			return json.length > 1000 ? json.substring(0, 1000) + '...[truncated]' : json
		} catch {
			return `[Object: ${Object.prototype.toString.call(val)}]`
		}
	}
	if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`
	return String(val)
}

// ============================================================
// Console 拦截器（捕获所有 console 输出到日志缓冲区）
// ============================================================

let _consoleHookInstalled = false

function installConsoleHook() {
	if (_consoleHookInstalled) return
	_consoleHookInstalled = true

	const originalConsole = {
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		info: console.info.bind(console),
	}

	for (const [method, origFn] of Object.entries(originalConsole)) {
		console[method] = function (...args) {
			// 存入缓冲区
			const serialized = args
				.map(a => _safeStringify(a))
				.filter(s => s.length > 0) // 过滤掉空的 CSS 样式参数
				.join(' ')
			if (serialized.length > 0) {
				logBuffer.push({
					t: Date.now(),
					level: method,
					msg: serialized,
				})
				if (logBuffer.length > MAX_LOGS) logBuffer.shift()
			}
			// 保持原始输出
			origFn.apply(console, args)
		}
	}

	// 捕获未处理的异常
	window.addEventListener('error', (e) => {
		logBuffer.push({
			t: Date.now(),
			level: 'uncaught_error',
			msg: `${e.message} at ${e.filename || '?'}:${e.lineno || '?'}:${e.colno || '?'}`,
		})
		if (logBuffer.length > MAX_LOGS) logBuffer.shift()
	})

	// 捕获未处理的 Promise 拒绝
	window.addEventListener('unhandledrejection', (e) => {
		const reason = e.reason instanceof Error
			? `${e.reason.name}: ${e.reason.message}`
			: String(e.reason)
		logBuffer.push({
			t: Date.now(),
			level: 'unhandled_promise',
			msg: reason,
		})
		if (logBuffer.length > MAX_LOGS) logBuffer.shift()
	})
}

// ============================================================
// 全局控制 API（挂载到 window.beiluDiag）
// ============================================================

const diagControl = {
	/**
	 * 启用诊断模块
	 * @param {string} modules - 模块名（逗号分隔）或 '*' 全部启用
	 * @example beiluDiag.enable('*')
	 * @example beiluDiag.enable('template,websocket')
	 */
	enable(modules) {
		if (modules === '*') {
			storage.set(STORAGE_KEY, '*')
			console.log('%c[beiluDiag] ✅ 已启用所有诊断模块', 'color: #4caf50; font-weight: bold')
			return
		}
		const current = getEnabledModules()
		const toAdd = modules.split(',').map(s => s.trim()).filter(Boolean)
		const newSet = current === '*' ? new Set(toAdd) : new Set([...current, ...toAdd])
		storage.set(STORAGE_KEY, Array.from(newSet).join(','))
		console.log('%c[beiluDiag] ✅ 已启用模块:', 'color: #4caf50; font-weight: bold', Array.from(newSet).join(', '))
	},

	/**
	 * 禁用诊断模块
	 * @param {string} modules - 模块名（逗号分隔）或 '*' 全部禁用
	 */
	disable(modules) {
		if (modules === '*') {
			storage.remove(STORAGE_KEY)
			console.log('%c[beiluDiag] ❌ 已禁用所有诊断模块', 'color: #f44336; font-weight: bold')
			return
		}
		const current = getEnabledModules()
		if (current === '*') {
			const allModules = Object.keys(MODULE_COLORS)
			const toRemove = new Set(modules.split(',').map(s => s.trim()))
			const remaining = allModules.filter(m => !toRemove.has(m))
			storage.set(STORAGE_KEY, remaining.join(','))
		} else {
			const toRemove = new Set(modules.split(',').map(s => s.trim()))
			const remaining = Array.from(current).filter(m => !toRemove.has(m))
			if (remaining.length) storage.set(STORAGE_KEY, remaining.join(','))
			else storage.remove(STORAGE_KEY)
		}
		console.log('%c[beiluDiag] ❌ 已禁用模块:', 'color: #f44336; font-weight: bold', modules)
	},

	/**
	 * 设置日志级别
	 * @param {'error'|'warn'|'info'|'debug'|'trace'} level
	 */
	setLevel(level) {
		if (LEVELS[level] === undefined) {
			console.warn('[beiluDiag] 无效级别。可用:', Object.keys(LEVELS).join(', '))
			return
		}
		storage.set(STORAGE_LEVEL_KEY, level)
		console.log('%c[beiluDiag] 📊 日志级别设为:', 'color: #2196f3; font-weight: bold', level)
	},

	/**
	 * 显示当前诊断状态（增强版）
	 */
	status() {
		const modules = getEnabledModules()
		const level = Object.entries(LEVELS).find(([, v]) => v === getLevel())?.[0] || 'info'
		const snapshotCount = snapshots.length

		console.log('')
		console.log('%c╔══════════════════════════════════════╗', 'color: #ff9800; font-weight: bold')
		console.log('%c║   beilu 诊断系统 v2 · 状态面板      ║', 'color: #ff9800; font-weight: bold')
		console.log('%c╚══════════════════════════════════════╝', 'color: #ff9800; font-weight: bold')
		console.log('')

		// 启用状态
		const enabledStr = modules === '*' ? '✅ 全部 (*)' : (modules.size ? `✅ ${Array.from(modules).join(', ')}` : '❌ (无)')
		console.log('  📡 启用模块:', enabledStr)
		console.log('  📊 日志级别:', level)
		console.log('  📸 快照缓存:', `${snapshotCount}/${MAX_SNAPSHOTS}`)
		console.log('')

		// 模块分组显示
		const groups = {
			'聊天引擎': ['template', 'displayRegex', 'messageList', 'streamRenderer', 'virtualQueue', 'websocket', 'iframeRenderer', 'stCompat'],
			'UI': ['sidebar', 'fileExplorer', 'layout'],
			'系统': ['config', 'api', 'dom', 'perf'],
			'后端标记': ['chat', 'proxy', 'preset', 'memory', 'worldbook', 'files', 'regex', 'browser', 'vectordb', 'discord'],
		}

		for (const [groupName, groupModules] of Object.entries(groups)) {
			const items = groupModules.map(m => {
				const enabled = modules === '*' || (modules instanceof Set && modules.has(m))
				const color = MODULE_COLORS[m] || '#999'
				return `${enabled ? '●' : '○'} ${m}`
			})
			console.log(`  [${groupName}]`, items.join('  '))
		}

		console.log('')
		console.log('  📋 控制命令:')
		console.log('    beiluDiag.enable("*")              启用全部')
		console.log('    beiluDiag.enable("template,chat")  启用指定模块')
		console.log('    beiluDiag.disable("*")             禁用全部')
		console.log('    beiluDiag.setLevel("debug")        设置级别 (error/warn/info/debug/trace)')
		console.log('    beiluDiag.all()                    快捷：全部+debug')
		console.log('    beiluDiag.snapshots()              查看状态快照')
		console.log('    beiluDiag.export()                 导出诊断报告')
		console.log('')
	},

	/**
	 * 快速启用全部 + debug 级别（调试快捷方式）
	 */
	all() {
		this.enable('*')
		this.setLevel('debug')
	},

	/**
	 * 查看状态快照
	 * @param {number} [count=20] - 显示最近N条
	 * @param {string} [filterModule] - 按模块过滤
	 */
	snapshots(count = 20, filterModule = null) {
		let filtered = snapshots
		if (filterModule) {
			filtered = snapshots.filter(s => s.module === filterModule)
		}
		const recent = filtered.slice(-count)
		if (recent.length === 0) {
			console.log('[beiluDiag] 无快照记录。启用诊断并操作后会自动采集。')
			return
		}
		console.log(`%c[beiluDiag] 最近 ${recent.length} 条快照${filterModule ? ` (${filterModule})` : ''}:`, 'color: #ff9800; font-weight: bold')
		console.table(recent.map(s => ({
			时间: new Date(s.t).toLocaleTimeString(),
			模块: s.module,
			标签: s.label,
			数据: JSON.stringify(s.data).substring(0, 100),
		})))
	},

	/**
	 * 导出诊断报告（用于用户反馈bug时附带）
	 * @returns {string} JSON格式的诊断报告
	 */
	export() {
		const report = {
			timestamp: new Date().toISOString(),
			userAgent: navigator.userAgent,
			url: window.location.href,
			diag: {
				modules: (() => {
					const m = getEnabledModules()
					return m === '*' ? '*' : Array.from(m)
				})(),
				level: Object.entries(LEVELS).find(([, v]) => v === getLevel())?.[0] || 'info',
			},
			snapshots: snapshots.slice(-50),
			localStorage: {
				'beilu-diag-modules': storage.get(STORAGE_KEY),
				'beilu-diag-level': storage.get(STORAGE_LEVEL_KEY),
				'beilu-renderer-enabled': storage.get(KEYS.BEILU_RENDERER_ENABLED),
				'beilu-render-depth': storage.get(KEYS.BEILU_RENDER_DEPTH),
				'beilu-code-fold-enabled': storage.get(KEYS.BEILU_CODE_FOLD_ENABLED),
				'beilu-thinking-tags': storage.get(KEYS.BEILU_THINKING_TAGS),
				'beilu-msg-load-limit': storage.get(KEYS.BEILU_MSG_LOAD_LIMIT),
			},
		}
		const json = JSON.stringify(report, null, 2)
		// 复制到剪贴板。LAN http 非安全上下文时 navigator.clipboard 为 undefined（本机 localhost 有、
		// http://192.168.x.x 访问无）——直接调用是同步 TypeError，.catch 接不住，整个 export 炸掉。
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(json).then(() => {
			console.log('%c[beiluDiag] 📋 诊断报告已复制到剪贴板', 'color: #4caf50; font-weight: bold')
		}).catch(() => {
			console.log('%c[beiluDiag] 诊断报告:', 'color: #ff9800; font-weight: bold')
			console.log(json)
		})
		else {
			console.log('%c[beiluDiag] 诊断报告（剪贴板不可用，非安全上下文）:', 'color: #ff9800; font-weight: bold')
			console.log(json)
		}
		return json
	},

	/**
	 * 一键打包日志（前端 + 后端）
	 *
	 * 收集前端 console 日志缓冲区 + 快照 + 后端日志 + 后端快照，
	 * 合并为一个 JSON 文件并触发浏览器下载。
	 *
	 * @param {object} [options] - 可选参数
	 * @param {string} [options.backendApi] - 后端诊断 API 基础路径
	 * @returns {Promise<object>} 打包的报告对象
	 */
	async pack(options = {}) {
		const backendApi = options.backendApi || '/api/parts/shells:chat/diag'

		console.log('%c[beiluDiag] 📦 正在打包诊断日志...', 'color: #ff9800; font-weight: bold')

		// 1. 收集前端数据
		const frontendData = {
			logs: logBuffer.slice(),
			snapshots: snapshots.slice(-200),
			diagConfig: {
				modules: (() => {
					const m = getEnabledModules()
					return m === '*' ? '*' : Array.from(m)
				})(),
				level: Object.entries(LEVELS).find(([, v]) => v === getLevel())?.[0] || 'info',
			},
			localStorage: {
				'beilu-diag-modules': storage.get(STORAGE_KEY),
				'beilu-diag-level': storage.get(STORAGE_LEVEL_KEY),
				'beilu-renderer-enabled': storage.get(KEYS.BEILU_RENDERER_ENABLED),
				'beilu-render-depth': storage.get(KEYS.BEILU_RENDER_DEPTH),
				'beilu-code-fold-enabled': storage.get(KEYS.BEILU_CODE_FOLD_ENABLED),
				'beilu-thinking-tags': storage.get(KEYS.BEILU_THINKING_TAGS),
				'beilu-msg-load-limit': storage.get(KEYS.BEILU_MSG_LOAD_LIMIT),
			},
		}

		// 2. 收集后端数据
		let backendData = { logs: [], snapshots: [], status: null, error: null }
		try {
			const [logsRes, snapshotsRes, statusRes] = await Promise.allSettled([
				apiFetch(`${backendApi}/logs`, { raw: true }).then(r => r.ok ? r.json() : null),
				apiFetch(`${backendApi}/snapshots?count=200`, { raw: true }).then(r => r.ok ? r.json() : null),
				apiFetch(`${backendApi}/status`, { raw: true }).then(r => r.ok ? r.json() : null),
			])
			backendData.logs = logsRes.status === 'fulfilled' && logsRes.value?.logs ? logsRes.value.logs : []
			backendData.snapshots = snapshotsRes.status === 'fulfilled' && snapshotsRes.value?.snapshots ? snapshotsRes.value.snapshots : []
			backendData.status = statusRes.status === 'fulfilled' ? statusRes.value : null
		} catch (err) {
			backendData.error = `后端数据获取失败: ${err.message}`
		}

		// 3. 组装报告
		const report = {
			_type: 'beilu-diag-report',
			_version: 2,
			meta: {
				timestamp: new Date().toISOString(),
				userAgent: navigator.userAgent,
				url: window.location.href,
				viewport: `${window.innerWidth}x${window.innerHeight}`,
				language: navigator.language,
			},
			frontend: frontendData,
			backend: backendData,
		}

		// 4. 触发文件下载
		const json = JSON.stringify(report, null, 2)
		const blob = new Blob([json], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `beilu-diag-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.json`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)

		console.log('%c[beiluDiag] ✅ 诊断日志已打包下载', 'color: #4caf50; font-weight: bold',
			`前端日志: ${frontendData.logs.length} 条`,
			`后端日志: ${backendData.logs.length} 条`,
			`前端快照: ${frontendData.snapshots.length} 条`,
			`后端快照: ${backendData.snapshots.length} 条`)

		return report
	},

	/**
	 * 获取前端日志缓冲区（供 debug 面板使用）
	 * @param {number} [count=500]
	 * @returns {Array}
	 */
	getLogBuffer(count = 500) {
		return logBuffer.slice(-count)
	},

	/**
	 * 获取状态快照缓冲区（供设置面板 diag-export 导出使用，与 getLogBuffer 配对的原始数组读取口；
	 * snapshots() 是 console.table 展示版，不可作数据源）
	 * @param {number} [count=200]
	 * @returns {Array}
	 */
	getSnapshotBuffer(count = 200) {
		return snapshots.slice(-count)
	},

	/** 可用的模块列表 */
	modules: Object.keys(MODULE_COLORS),

	/** 可用的级别列表 */
	levels: Object.keys(LEVELS),

	/** 清空快照缓存 */
	clearSnapshots() {
		snapshots.length = 0
		console.log('%c[beiluDiag] 🗑️ 快照缓存已清空', 'color: #f44336; font-weight: bold')
	},
}

// 挂载到 window
if (typeof window !== 'undefined') {
	// 安装 Console 拦截器（必须在挂载 beiluDiag 之前，确保捕获所有后续日志）
	installConsoleHook()

	window.beiluDiag = diagControl

	// 检查 URL 参数
	try {
		const params = new URLSearchParams(window.location.search)
		const diagParam = params.get('diag')
		if (diagParam) {
			storage.set(STORAGE_KEY, diagParam)
			console.log('%c[beiluDiag] URL 参数启用诊断:', 'color: #4caf50; font-weight: bold', diagParam)
		}
	} catch { /* ignore */ }

	// 启动时显示简要状态
	const modules = getEnabledModules()
	if (modules === '*' || (modules instanceof Set && modules.size > 0)) {
		console.log('%c[beiluDiag] 🔬 诊断模式已激活', 'color: #ff9800; font-weight: bold',
			'| 模块:', modules === '*' ? '*' : Array.from(modules).join(','),
			'| 级别:', Object.entries(LEVELS).find(([, v]) => v === getLevel())?.[0] || 'info',
			'| 输入 beiluDiag.status() 查看详情',
			'| beiluDiag.pack() 一键打包日志')
	}
}

export default diagControl
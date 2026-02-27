/**
 * 变量持久化管理器（Phase 2D）
 *
 * 在父页面运行，管理所有 iframe 的变量读写。
 * 提供：
 * 1. 跨 iframe 变量同步（所有 iframe 共享同一份变量）
 * 2. 持久化到后端 chat 元数据（防抖保存）
 * 3. postMessage 通信桥接（iframe 内变量操作委托到此管理器）
 *
 * 使用方式（在 initSTCompat 中调用）：
 *   import { initVariableStore, getVariableStore } from './variableStore.mjs'
 *   initVariableStore()  // 注册 postMessage 监听
 *
 * 存储位置：
 * - global 变量 → localStorage (beilu-st-vars-global)
 * - character 变量 → localStorage (beilu-st-vars-char-{charId})
 * - chat 变量 → 后端 chat 元数据
 * - message 变量 → 内存（随 iframe 生命周期）
 * - script 变量 → localStorage (beilu-st-vars-script-{scriptId})
 */

import { createDiag } from '../../diagLogger.mjs'

const diag = createDiag('stCompat')

// ============================================================
// 变量存储
// ============================================================

/** @type {object} 变量数据 */
const _vars = {
	global: {},
	character: {},
	chat: {},
	messages: {},
	scripts: {},
	preset: {},
	extensions: {},
}

/** 是否有未保存的修改 */
let _dirty = false

/** 保存防抖定时器 */
let _saveTimer = null

/** 保存防抖延迟（ms） */
const SAVE_DEBOUNCE = 3000

/** postMessage 监听器引用 */
let _messageHandler = null

/** 当前聊天 ID（用于持久化） */
let _chatId = ''

/** 当前角色 ID（用于持久化） */
let _charId = ''

// ============================================================
// 公开接口
// ============================================================

/**
 * 初始化变量存储
 * 注册 postMessage 监听器，从 localStorage 加载已保存的变量
 *
 * @param {object} [options]
 * @param {string} [options.chatId=''] - 当前聊天 ID
 * @param {string} [options.charId=''] - 当前角色 ID
 */
export function initVariableStore(options = {}) {
	_chatId = options.chatId || ''
	_charId = options.charId || ''

	// 从 localStorage 加载
	_loadFromLocalStorage()

	// 注册 postMessage 监听
	if (!_messageHandler) {
		_messageHandler = _handleMessage.bind(null)
		window.addEventListener('message', _messageHandler)
		diag.log('变量持久化管理器已初始化', { chatId: _chatId, charId: _charId })
	}

	// 挂载到 window 供 iframe 同步读取初始变量
	window.__beiluVarStore = _vars
}

/**
 * 销毁变量存储
 * 保存未持久化的变量，移除监听器
 */
export function destroyVariableStore() {
	if (_dirty) {
		_saveToLocalStorage()
	}
	if (_saveTimer) {
		clearTimeout(_saveTimer)
		_saveTimer = null
	}
	if (_messageHandler) {
		window.removeEventListener('message', _messageHandler)
		_messageHandler = null
	}
	diag.log('变量持久化管理器已销毁')
}

/**
 * 获取指定作用域的变量
 *
 * @param {object} [option] - 变量选项
 * @param {string} [option.scope='chat'] - 作用域
 * @param {string} [option.key] - 特定变量 key（用于 message/script 作用域）
 * @returns {object} 变量对象
 */
export function getVariables(option = {}) {
	const scope = option.scope || 'chat'
	const key = option.key || ''

	switch (scope) {
		case 'global': return { ..._vars.global }
		case 'character': return { ..._vars.character }
		case 'chat': return { ..._vars.chat }
		case 'message': return { ...(_vars.messages[key] || {}) }
		case 'script': return { ...(_vars.scripts[key] || {}) }
		case 'preset': return { ..._vars.preset }
		case 'extension': return { ...(_vars.extensions[key] || {}) }
		default: return { ..._vars.chat }
	}
}

/**
 * 替换指定作用域的变量
 *
 * @param {object} variables - 新变量对象
 * @param {object} [option] - 变量选项
 * @param {string} [option.scope='chat'] - 作用域
 * @param {string} [option.key] - 特定变量 key
 */
export function replaceVariables(variables, option = {}) {
	const scope = option.scope || 'chat'
	const key = option.key || ''

	switch (scope) {
		case 'global': _vars.global = { ...variables }; break
		case 'character': _vars.character = { ...variables }; break
		case 'chat': _vars.chat = { ...variables }; break
		case 'message':
			if (key) _vars.messages[key] = { ...variables }
			break
		case 'script':
			if (key) _vars.scripts[key] = { ...variables }
			break
		case 'preset': _vars.preset = { ...variables }; break
		case 'extension':
			if (key) _vars.extensions[key] = { ...variables }
			break
		default: _vars.chat = { ...variables }
	}

	_dirty = true
	_scheduleSave()
}

/**
 * 获取所有作用域合并后的变量（用于 getAllVariables）
 *
 * @returns {object}
 */
export function getAllVariables() {
	return {
		..._vars.global,
		..._vars.character,
		..._vars.chat,
		..._vars.preset,
	}
}

/**
 * 更新当前上下文（角色/聊天切换时）
 *
 * @param {object} options
 * @param {string} [options.chatId]
 * @param {string} [options.charId]
 */
export function updateContext(options = {}) {
	// 先保存旧的
	if (_dirty) _saveToLocalStorage()

	if (options.chatId !== undefined) _chatId = options.chatId
	if (options.charId !== undefined) _charId = options.charId

	// 加载新的
	_loadFromLocalStorage()
	diag.debug('变量上下文已更新', { chatId: _chatId, charId: _charId })
}

// ============================================================
// postMessage 通信处理
// ============================================================

/**
 * 处理来自 iframe 的变量操作 postMessage
 *
 * @param {MessageEvent} e
 */
function _handleMessage(e) {
	if (!e.data || !e.data.type) return

	switch (e.data.type) {
		case 'beilu-var-get': {
			// iframe 请求获取变量
			const vars = getVariables(e.data.option)
			try {
				e.source?.postMessage({
					type: 'beilu-var-response',
					requestId: e.data.requestId,
					variables: vars,
				}, '*')
			} catch { /* iframe 可能已销毁 */ }
			break
		}

		case 'beilu-var-replace': {
			// iframe 请求替换变量
			replaceVariables(e.data.variables, e.data.option)
			diag.debug('变量替换:', e.data.option?.scope || 'chat', Object.keys(e.data.variables || {}).length, '个 key')
			break
		}

		case 'beilu-var-get-all': {
			// iframe 请求获取所有合并变量
			const allVars = getAllVariables()
			try {
				e.source?.postMessage({
					type: 'beilu-var-response',
					requestId: e.data.requestId,
					variables: allVars,
				}, '*')
			} catch { /* iframe 可能已销毁 */ }
			break
		}

		case 'beilu-var-update': {
			// iframe 请求部分更新变量（merge 而非 replace）
			const scope = e.data.option?.scope || 'chat'
			const current = getVariables(e.data.option)
			const merged = { ...current, ...e.data.variables }
			replaceVariables(merged, e.data.option)
			break
		}

		case 'beilu-var-delete': {
			// iframe 请求删除变量
			const scope2 = e.data.option?.scope || 'chat'
			const varName = e.data.varName
			if (varName) {
				const current2 = getVariables(e.data.option)
				delete current2[varName]
				replaceVariables(current2, e.data.option)
			}
			break
		}
	}
}

// ============================================================
// 持久化（localStorage）
// ============================================================

/**
 * 防抖保存
 */
function _scheduleSave() {
	if (_saveTimer) clearTimeout(_saveTimer)
	_saveTimer = setTimeout(() => {
		_saveToLocalStorage()
		_saveTimer = null
	}, SAVE_DEBOUNCE)
}

/**
 * 保存变量到 localStorage
 */
function _saveToLocalStorage() {
	try {
		// global 变量 — 全局共享
		localStorage.setItem('beilu-st-vars-global', JSON.stringify(_vars.global))

		// character 变量 — 按角色存储
		if (_charId) {
			localStorage.setItem(`beilu-st-vars-char-${_charId}`, JSON.stringify(_vars.character))
		}

		// chat 变量 — 按聊天存储
		if (_chatId) {
			localStorage.setItem(`beilu-st-vars-chat-${_chatId}`, JSON.stringify(_vars.chat))
		}

		// script 变量 — 合并存储
		if (Object.keys(_vars.scripts).length > 0) {
			localStorage.setItem('beilu-st-vars-scripts', JSON.stringify(_vars.scripts))
		}

		_dirty = false
		diag.debug('变量已保存到 localStorage', {
			global: Object.keys(_vars.global).length,
			character: Object.keys(_vars.character).length,
			chat: Object.keys(_vars.chat).length,
			scripts: Object.keys(_vars.scripts).length,
		})
	} catch (err) {
		diag.error('变量保存失败:', err.message)
	}
}

/**
 * 从 localStorage 加载变量
 */
function _loadFromLocalStorage() {
	try {
		// global
		const globalStr = localStorage.getItem('beilu-st-vars-global')
		if (globalStr) _vars.global = JSON.parse(globalStr)

		// character
		if (_charId) {
			const charStr = localStorage.getItem(`beilu-st-vars-char-${_charId}`)
			if (charStr) _vars.character = JSON.parse(charStr)
			else _vars.character = {}
		}

		// chat
		if (_chatId) {
			const chatStr = localStorage.getItem(`beilu-st-vars-chat-${_chatId}`)
			if (chatStr) _vars.chat = JSON.parse(chatStr)
			else _vars.chat = {}
		}

		// scripts
		const scriptsStr = localStorage.getItem('beilu-st-vars-scripts')
		if (scriptsStr) _vars.scripts = JSON.parse(scriptsStr)

		diag.debug('变量已从 localStorage 加载', {
			global: Object.keys(_vars.global).length,
			character: Object.keys(_vars.character).length,
			chat: Object.keys(_vars.chat).length,
		})
	} catch (err) {
		diag.error('变量加载失败:', err.message)
	}
}
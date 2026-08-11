/**
 * [beilu-st-host · 前端 runtime] st-events —— 酒馆 eventSource / event_types 的 beilu 侧对等物。
 *
 * 【定位】酒馆插件（Timelines / MessageSummarize / memory-enhancement 等 5/6 样本）从
 *   `../../../../script.js` import { eventSource, event_types }，用 eventSource.on(...) 订阅
 *   聊天生命周期事件、eventSource.emit(...) 发射。本文件提供其对等实现，桥到 beilu 事件总线。
 *
 * 【桥接对象（实证）】beilu-chat 的父页面事件总线 `window.__beiluEventBus`
 *   形状见 shells/beilu-chat/public/src/shared/transport/websocket.mjs:170-183 `_emitEventBus`：
 *     const bus = window.__beiluEventBus;
 *     const listeners = bus._listeners.get(eventName);   // _listeners: Map<string, Function[]>
 *     for (const cb of listeners.slice()) cb(...args);   // 数组元素必须是「函数」，同步 fire-and-forget
 *   后端 WS 广播（message_received / generation_ended / variable_updated 等）都经 _emitEventBus 落到此 bus。
 *   故：只要插件的 on() 把回调 push 进同一个 bus._listeners，插件就能收到后端事件——这是一期接缝的关键。
 *
 * 【功能链】后端 WS 事件 → websocket.mjs handleBroadcastEvent → _emitEventBus(name,...args)
 *   → window.__beiluEventBus._listeners.get(name) → 本文件 on() 注册进去的插件回调被 cb(...args) 调用。
 *   插件主动 emit → 本文件 emit() 遍历同一 _listeners 透传（一期同步；二期做 await/可变引用改造）。
 *
 * 【红线对应】红线2：event_types 是静态枚举常量表（非「未实现 API」，无需抛错）；但只列有真实 producer
 *   的事件名对齐后端广播，无 producer 的键订阅得到但永不触发＝如实（不造假、不静默补发）。
 *
 * 【一期边界】不做 await 串行/可变引用改造（二期主体）；emit 如实透传 payload（与 _emitEventBus 同语义）。
 */

/**
 * 取（或惰性创建）父页面事件总线。
 * why 惰性创建：__beiluEventBus 由 beilu-chat 的 iframe 脚本兼容层按需建立，父页面若尚未建，
 *   插件的 on() 也要能落地，且必须与 websocket.mjs 消费的是「同一个」bus（同一个 _listeners Map），
 *   否则后端广播与插件订阅两张表对不上 —— 故这里就地补建，形状严格对齐 _emitEventBus 的读取契约。
 */
function _bus() {
	let bus = globalThis.__beiluEventBus
	if (!bus || !(bus._listeners instanceof Map)) {
		bus = globalThis.__beiluEventBus = { _listeners: new Map() }
	}
	return bus
}

/** 取某事件的监听器数组（惰性建槽）。数组元素恒为「函数」，以兼容 _emitEventBus 的 cb(...args) 消费。 */
function _slot(eventName) {
	const bus = _bus()
	let arr = bus._listeners.get(eventName)
	if (!arr) { arr = []; bus._listeners.set(eventName, arr) }
	return arr
}

/**
 * once 包装追踪：off(event, 原回调) 必须能移除 once 注册的 wrapper。
 * 结构：Map<eventName, Map<原回调, wrapper函数>>。
 */
const _onceWrappers = new Map()

function _rememberOnce(eventName, original, wrapper) {
	let m = _onceWrappers.get(eventName)
	if (!m) { m = new Map(); _onceWrappers.set(eventName, m) }
	m.set(original, wrapper)
}

function _takeOnce(eventName, original) {
	const m = _onceWrappers.get(eventName)
	if (!m) return null
	const w = m.get(original) || null
	if (w) m.delete(original)
	return w
}

/**
 * eventSource：酒馆 EventEmitter 的对等物（方法面按 ST-P4 / 转换表插件实际用到的裁剪）。
 * on/once/off/removeListener/emit + makeFirst/makeLast（一期 makeFirst/makeLast 简化为普通注册，语义近似）。
 */
export const eventSource = {
	/** 订阅：把回调 push 进父页面 bus 的对应槽（与后端广播共表）。 */
	on(eventName, callback) {
		if (typeof eventName !== 'string' || typeof callback !== 'function') return
		_slot(eventName).push(callback)
	},

	/** 只触发一次：包装后自动 off；记住 wrapper 以支持按原回调 off。 */
	once(eventName, callback) {
		if (typeof eventName !== 'string' || typeof callback !== 'function') return
		const wrapper = (...args) => {
			eventSource.off(eventName, callback)
			return callback(...args)
		}
		_rememberOnce(eventName, callback, wrapper)
		_slot(eventName).push(wrapper)
	},

	/** 退订：优先移除 once wrapper，再移除直接注册的回调（可能有多份，全清）。 */
	off(eventName, callback) {
		if (typeof eventName !== 'string') return
		const arr = _bus()._listeners.get(eventName)
		if (!arr) return
		const wrapper = _takeOnce(eventName, callback)
		const target = wrapper || callback
		for (let i = arr.length - 1; i >= 0; i--) {
			if (arr[i] === target || arr[i] === callback) arr.splice(i, 1)
		}
	},

	/** ST 别名：removeListener === off。 */
	removeListener(eventName, callback) {
		eventSource.off(eventName, callback)
	},

	/**
	 * 发射：遍历同一 bus 的槽，如实透传 args（与 websocket.mjs _emitEventBus 同语义）。
	 * 一期同步 fire-and-forget（不 await 监听器返回的 Promise）；二期做 await 串行 + 可变引用改造。
	 * @returns {Promise<void>} 返回 resolved Promise 以兼容 `await eventSource.emit(...)` 的插件写法。
	 */
	emit(eventName, ...args) {
		if (typeof eventName === 'string') {
			const arr = _bus()._listeners.get(eventName)
			if (arr && arr.length) {
				for (const cb of arr.slice()) {
					try { cb(...args) } catch (e) { console.error(`[beilu-st-host] eventSource 监听器执行出错 ${eventName}:`, e) }
				}
			}
		}
		return Promise.resolve()
	},

	/** ST 有 makeFirst/makeLast 控制监听器顺序；一期不保证插入序，等价 on（记录到报告的已知简化）。 */
	makeFirst(eventName, callback) {
		if (typeof eventName !== 'string' || typeof callback !== 'function') return
		_slot(eventName).unshift(callback)
	},
	makeLast(eventName, callback) {
		eventSource.on(eventName, callback)
	},
}

/**
 * event_types：ST 事件名常量枚举。
 * 值对齐 websocket.mjs 真实广播的事件名（有后端 producer 的项，订阅即可收到数据）；
 * 无 producer 的标准键仍列出（插件按 event_types.XXX 引用不至于取到 undefined），但订阅不会触发——如实、不造假。
 * 证据：websocket.mjs 内 _emitEventBus 广播的事件名清单（message_sent/received/deleted/edited/updated、
 *   generation_started/ended、js_generation_started/ended、variable_updated、emotion_changed、motion_triggered）。
 */
export const event_types = {
	// —— 有后端 producer（websocket.mjs 实际广播，订阅可收到） ——
	MESSAGE_SENT: 'message_sent',
	MESSAGE_RECEIVED: 'message_received',
	MESSAGE_DELETED: 'message_deleted',
	MESSAGE_EDITED: 'message_edited',
	MESSAGE_UPDATED: 'message_updated',
	GENERATION_STARTED: 'generation_started',
	GENERATION_ENDED: 'generation_ended',
	VARIABLE_UPDATED: 'variable_updated',
	// —— iframe 兼容层事件名（JS-Slash-Runner 风格，websocket.mjs 亦广播） ——
	JS_GENERATION_STARTED: 'js_generation_started',
	JS_GENERATION_ENDED: 'js_generation_ended',
	// —— beilu 扩展事件（有 producer） ——
	EMOTION_CHANGED: 'emotion_changed',
	MOTION_TRIGGERED: 'motion_triggered',
	// —— 标准键但一期无对应 producer：列出防 undefined，订阅不触发（如实，二期对齐 91 事件） ——
	CHAT_CHANGED: 'chat_id_changed',
	CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
	USER_MESSAGE_RENDERED: 'user_message_rendered',
	MESSAGE_SWIPED: 'message_swiped',
	GENERATION_STOPPED: 'generation_stopped',
	APP_READY: 'app_ready',
	EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
	SETTINGS_UPDATED: 'settings_updated',
}

/** eventSource 的别名（部分插件用 eventTypes 拼写）。 */
export const eventTypes = event_types

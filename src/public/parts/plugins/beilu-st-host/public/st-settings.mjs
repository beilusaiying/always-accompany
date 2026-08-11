/**
 * [beilu-st-host · 前端 runtime] st-settings —— 酒馆 extension_settings / saveSettingsDebounced 对等物。
 *
 * 【定位】6/6 样本插件都 import { extension_settings } from '../../../../scripts/extensions.js'，
 *   以 extension_settings[插件名] 读写自己的设置，并调 saveSettingsDebounced() 持久化。
 *   ST 把它存 localStorage —— 我们改存后端单源（红线1：禁 localStorage；红线6：按 key 粒度写，不整库覆盖）。
 *
 * 【后端契约（main.mjs 既成事实，只读不改）】
 *   GET  /api/parts/plugins:beilu-st-host/st-plugins/settings/getdata  → 全量 settings 对象 {key: value}
 *   POST /api/parts/plugins:beilu-st-host/st-plugins/settings/setdata  {key, value} → 按顶层 key 落盘
 *
 * 【功能链】host-loader 注入插件前 await initSettings()（一次全量拉，填成同步可读对象）
 *   → 插件同步读 extension_settings[name] / 写 extension_settings[name].x = v → 调 saveSettingsDebounced()
 *   → 500ms 防抖 → 对「被访问/被写过」的顶层 key 逐个 POST setdata（key 粒度，未触碰的 key 不发）。
 *
 * 【why 追踪「被访问过」的顶层 key，而非仅「被赋值过」】
 *   插件典型写法是二级写：`const s = extension_settings[name]; s.foo = 1; saveSettingsDebounced()`。
 *   Proxy 的 set 只拦得到顶层赋值（extension_settings[name] = ...），拦不到 s.foo=1。
 *   故把「get 返回过对象引用」的顶层 key 也纳入 dirty 候选——保证二级写不漏存，同时仍是 key 粒度
 *   （只发被这个插件碰过的 key，不整库覆盖别的插件的 key，满足红线6）。
 *
 * 【一期边界】extension_settings 值语义不做深校验（ST 零校验是已知瑕疵，但一期不引入 schema，二期再加）。
 */

// 后端 part base（main.mjs: const API = '/api/parts/plugins\:beilu-st-host'，真实路径冒号不转义）。
const API_BASE = '/api/parts/plugins:beilu-st-host'
const GET_URL = `${API_BASE}/st-plugins/settings/getdata`
const SET_URL = `${API_BASE}/st-plugins/settings/setdata`

// dirty 候选：被顶层 set 过、或被 get 返回过对象引用的顶层 key（见文件头 why）。
const _dirty = new Set()
let _flushTimer = null

/** 内部承载对象：所有真实数据落在这里，Proxy 只做「读写拦截 + dirty 记账」的透明层。 */
const _raw = {}

/**
 * extension_settings：酒馆全局设置对象的对等物（Proxy 追踪顶层读写）。
 * 插件以 extension_settings[插件名] 存取自己的配置桶。
 */
export const extension_settings = new Proxy(_raw, {
	get(target, prop, receiver) {
		const val = Reflect.get(target, prop, receiver)
		// 返回的是对象引用（插件可能往里二级写）→ 记为 dirty 候选。
		if (typeof prop === 'string' && val !== null && typeof val === 'object') _dirty.add(prop)
		return val
	},
	set(target, prop, value, receiver) {
		if (typeof prop === 'string') _dirty.add(prop)
		return Reflect.set(target, prop, value, receiver)
	},
	deleteProperty(target, prop) {
		if (typeof prop === 'string') _dirty.add(prop)
		return Reflect.deleteProperty(target, prop)
	},
})

/**
 * 启动时一次性全量拉取，填成同步可读对象（Object.assign 到 _raw，保持 Proxy 引用不变）。
 * host-loader 必须在注入任何插件 js 之前 await 本函数——否则插件同步读 extension_settings 会读到空。
 * 拉取阶段的写入不应污染 dirty（是「载入」不是「用户改」），故填充后清空 dirty。
 */
export async function initSettings() {
	try {
		const res = await fetch(GET_URL, { credentials: 'same-origin' })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const data = await res.json()
		if (data && typeof data === 'object') Object.assign(_raw, data)
	} catch (err) {
		// 拉取失败＝诚实降级：extension_settings 为空对象，插件读到空而非崩溃（无网/未登录场景）。
		console.warn('[beilu-st-host] extension_settings 初始化拉取失败，降级为空设置：', err?.message || err)
	} finally {
		_dirty.clear()
	}
}

/** 立即把某个顶层 key 落盘（key 粒度 POST）。 */
async function _postKey(key) {
	try {
		const res = await fetch(SET_URL, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ key, value: _raw[key] }),
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
	} catch (err) {
		console.warn(`[beilu-st-host] 保存设置项 "${key}" 失败：`, err?.message || err)
	}
}

/** flush：把当前 dirty 的每个顶层 key 逐个 POST（不整库覆盖），发完清账。 */
async function _flush() {
	_flushTimer = null
	if (_dirty.size === 0) return
	const keys = [..._dirty]
	_dirty.clear()
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(_raw, key)) await _postKey(key)
	}
}

/**
 * saveSettingsDebounced：酒馆同名 API 对等物。500ms 防抖，避免高频写打爆后端。
 * 插件改完设置后调用它即可（与 ST 用法一致）。
 */
export function saveSettingsDebounced() {
	if (_flushTimer) clearTimeout(_flushTimer)
	_flushTimer = setTimeout(() => { _flush() }, 500)
}

/** 同步别名：saveSettings（部分插件用非防抖版；一期同样走防抖以统一收口，语义上「尽快保存」）。 */
export function saveSettings() {
	saveSettingsDebounced()
}

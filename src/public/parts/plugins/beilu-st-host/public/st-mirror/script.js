/**
 * [beilu-st-host · st-mirror shim] script.js —— 酒馆主脚本 `../../../../script.js` 的相对导入落点。
 *
 * 【为什么在这里】6/6 样本插件都写 `import {...} from '../../../../script.js'`（ST-P4 §2.1）。插件被挂到
 *   镜像树 .../st-mirror/scripts/extensions/third-party/<name>/<入口js>，四级相对 `../../../../script.js`
 *   正好解析到本文件 .../st-mirror/script.js。本 shim 只做「转发」：把符号 re-export 自 runtime 模块
 *   （../st-events、../st-settings、../st-globals），或 lazy 委托到 getContext()。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.1）】
 *   eventSource        → Timelines / MessageSummarize / memory-enhancement（事件订阅发射）
 *   event_types        → 同上（事件名枚举）
 *   saveSettingsDebounced → 全部 6（保存设置）
 *   getContext         → Timelines / memory-enhancement（取运行时上下文）
 *   this_chid          → Timelines（当前角色索引 → getContext().characterId）
 *   characters         → Timelines / memory-enhancement（角色数组）
 *   chat               → MessageSummarize / memory-enhancement（当前聊天消息数组）
 *   chat_metadata      → memory-enhancement（聊天元数据）
 *   messageFormatting  → Timelines（消息格式化函数）
 *   substituteParams   → MessageSummarize / memory-enhancement（宏替换）
 *   saveChatConditional→ memory-enhancement（条件保存聊天 → getContext().saveChat 对等）
 *   getCurrentChatId   → memory-enhancement（当前 chatId）
 *   getRequestHeaders  → memory-enhancement / MessageSummarize（请求头，含 CSRF）
 *
 * 【red line 2 与可变引用（二期）】
 *   - 函数符号（substituteParams 等）：lazy 委托 —— 每次调用现取 getContext().fn；未实现键由 getContext 抛
 *     带键名错误（红线2），且天然是「实时」的（无快照过期问题）。
 *   - 对象/数组符号（chat / characters / chat_metadata）：用 Proxy 实时委托到 getContext().xxx，读写都转发到
 *     当前真实对象 —— 既满足红线2（未实现键经 getContext 抛错），又免掉快照过期（部分解决二期可变引用）。
 *   - 原始值符号（this_chid）：无法 Proxy，一期取一次快照（getContext().characterId），实时刷新属二期。
 *
 * 【未覆盖符号】ST script.js 导出数百个符号；本 shim 只覆盖 ST-P4 §2.1 的真实依赖。插件若 import 了这里
 *   未导出的符号，ESM 会抛「does not provide an export named X」—— 这本身是可见错误（该插件注入失败进面板），
 *   符合红线（失败可见、不静默）。新增依赖按证据补进本文件即可。
 */

import { eventSource, event_types, eventTypes } from '../st-events.mjs'
import { saveSettingsDebounced, saveSettings, extension_settings } from '../st-settings.mjs'
import { getContext } from '../st-globals.mjs'

// —— 直接转发的稳定引用 ——
export { eventSource, event_types, eventTypes, saveSettingsDebounced, saveSettings, extension_settings, getContext }

// —— 函数符号：lazy 委托到 getContext()（实时 + 未实现即抛带键名错误，红线2） ——

/** 宏替换。ST-P4：MessageSummarize / memory-enhancement 使用。 */
export function substituteParams(...args) {
	return getContext().substituteParams(...args)
}

/** 消息格式化。ST-P4：Timelines 使用。 */
export function messageFormatting(...args) {
	return getContext().messageFormatting(...args)
}

/** 条件保存聊天（→ getContext().saveChat 对等）。ST-P4：memory-enhancement 使用。 */
export function saveChatConditional(...args) {
	const ctx = getContext()
	const fn = ctx.saveChatConditional || ctx.saveChat
	if (typeof fn !== 'function') throw new Error('[beilu宿主] getContext().saveChat(Conditional) 尚未实现')
	return fn.apply(ctx, args)
}

/** 当前 chatId。ST-P4：memory-enhancement 使用。 */
export function getCurrentChatId(...args) {
	return getContext().getCurrentChatId(...args)
}

/** 请求头（含 CSRF token）。ST-P4 §三：memory-enhancement / MessageSummarize 使用。 */
export function getRequestHeaders(...args) {
	return getContext().getRequestHeaders(...args)
}

// —— 对象/数组符号：Proxy 实时委托（读写转发到 getContext() 当前对象，红线2 经 getContext 抛错） ——

/** 把「访问某 getContext 键返回的对象」包成实时委托 Proxy；每次属性访问都现取，免快照过期。 */
function liveObjectProxy(ctxKey) {
	const resolve = () => {
		const v = getContext()[ctxKey]   // 未实现键：getContext 抛带键名错误（红线2）
		if (v === null || typeof v !== 'object') {
			throw new Error(`[beilu宿主] getContext().${ctxKey} 不是对象（当前：${typeof v}），无法作为 ${ctxKey} 使用`)
		}
		return v
	}
	return new Proxy({}, {
		get(_t, prop) {
			const real = resolve()
			const val = real[prop]
			return typeof val === 'function' ? val.bind(real) : val
		},
		set(_t, prop, value) { resolve()[prop] = value; return true },
		has(_t, prop) { return prop in resolve() },
		ownKeys() { return Reflect.ownKeys(resolve()) },
		getOwnPropertyDescriptor(_t, prop) {
			const d = Object.getOwnPropertyDescriptor(resolve(), prop)
			if (d) d.configurable = true   // Proxy 不变量要求：目标不存在的属性描述符须 configurable
			return d
		},
		deleteProperty(_t, prop) { delete resolve()[prop]; return true },
	})
}

/** 当前聊天消息数组。ST-P4：MessageSummarize / memory-enhancement 使用。 */
export const chat = liveObjectProxy('chat')

/** 角色数组。ST-P4：Timelines / memory-enhancement 使用。 */
export const characters = liveObjectProxy('characters')

/** 聊天元数据。ST-P4：memory-enhancement 使用。 */
export const chat_metadata = liveObjectProxy('chatMetadata')

// —— 原始值符号：一期取一次快照（实时刷新属二期）。取不到不静默给 undefined —— 记 warn 并保留 undefined，
//    该软点仅限此一个 primitive 且只 Timelines 用；已在交付报告标注为二期「可变引用改造」项。 ——
export let this_chid
try {
	this_chid = getContext().characterId
} catch (err) {
	console.warn('[beilu-st-host] script.js shim：this_chid 取值失败（getContext().characterId 未就绪/未实现），一期置空，二期做实时绑定：', err?.message || err)
}

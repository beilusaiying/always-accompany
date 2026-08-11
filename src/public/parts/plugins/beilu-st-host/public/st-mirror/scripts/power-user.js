/**
 * [beilu-st-host · st-mirror shim] scripts/power-user.js —— 酒馆高级用户设置落点（P1）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   power_user → Timelines（读高级设置，如渲染选项）。beilu 侧对等：getContext().powerUserSettings。
 *
 * 【一期策略】power_user 是「读多写少的设置对象」。用实时委托 Proxy 转发到 getContext().powerUserSettings：
 *   未实现时经 getContext 抛带键名错误（红线2），不给 undefined。
 */

import { getContext } from '../../st-globals.mjs'

/** 实时委托到 getContext().powerUserSettings（读写转发，未实现即抛，红线2）。 */
export const power_user = new Proxy({}, {
	get(_t, prop) {
		const src = getContext().powerUserSettings
		if (src === null || typeof src !== 'object') {
			throw new Error('[beilu宿主] getContext().powerUserSettings 尚未实现（power_user 一期无对等）')
		}
		const val = src[prop]
		return typeof val === 'function' ? val.bind(src) : val
	},
	set(_t, prop, value) {
		const src = getContext().powerUserSettings
		if (src === null || typeof src !== 'object') {
			throw new Error('[beilu宿主] getContext().powerUserSettings 尚未实现（power_user 一期无对等）')
		}
		src[prop] = value
		return true
	},
	has(_t, prop) {
		const src = getContext().powerUserSettings
		return !!src && typeof src === 'object' && prop in src
	},
})

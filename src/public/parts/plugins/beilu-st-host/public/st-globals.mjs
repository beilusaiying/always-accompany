/**
 * [beilu-st-host · 前端 runtime] st-globals —— 全局 `SillyTavern` 对象（getContext + libs）。
 *
 * 【定位】酒馆主脚本 script.js:292 会在 window 上挂 `SillyTavern = { getContext, libs, ... }`，
 *   插件通过 `SillyTavern.getContext()` 取运行时上下文、`SillyTavern.libs.lodash` 等取内置库。
 *   本文件在任何插件 js 之前把该全局挂好（host-loader 首行静态 import 本模块触发副作用）。
 *
 * 【依赖契约】getContext 来自同目录 ./st-context.mjs（由并行分身编写，本文件只按契约引用，不创建）：
 *     export function getContext(): object   // 145 键骨架，未实现键调用即抛带键名的错误（红线2）
 *
 * 【libs 策略（红线2 + 离线硬约束）】本工作树未发现任何可复用的本地库注入源
 *   （grep beilu-chat/public 下 lodash/jquery/yaml/showdown/vendor 均无 —— 见交付报告 §2）。
 *   故 SillyTavern.libs 一律「访问即抛明确错误（含库名）」，绝不返回 undefined 让插件静默拿到坏值。
 *   联网下载 24 库是另一批任务；库到位后把对应名接上真实模块即可（此处只留抛错占位 + 清单）。
 *
 * 【功能链】host-loader import 本模块 → globalThis.SillyTavern 就位 → 注入插件 js →
 *   插件 import { getContext } from script.js（shim 转 SillyTavern.getContext）/ 用 SillyTavern.libs.X。
 */

import { getContext } from './st-context.mjs'

/**
 * ST 内置库清单（SillyTavern.libs.* 的常见键，来自 ST script.js libs 命名空间）。
 * 一期全部缺失 —— 逐个抛错占位；库下载到位后在这里替换为真实模块引用。
 * WebLLM 单独标注：ST-P4 §一 Extension-WebLLM 依赖 libs 里的 webllm。
 */
const LIB_NAMES = [
	'lodash', 'DOMPurify', 'Bowser', 'Fuse', 'hljs', 'localforage', 'Handlebars',
	'css', 'diff', 'diff_match_patch', 'SVGInject', 'showdown', 'moment', 'dayjs',
	'seedrandom', 'Popper', 'droll', 'slugify', 'chalk', 'morphdom', 'pako', 'yaml',
	'toastr', 'webllm',
]

/**
 * SillyTavern.libs：Proxy 拦截所有属性访问，缺失库一律抛含库名的明确错误。
 * why Proxy 而非逐个 getter：库名可能超出 LIB_NAMES 枚举（不同插件引用不同库），Proxy 能对
 *   任意属性名给出「该库尚未接入」的可读错误，而不是 undefined —— 符合红线2「绝不 undefined」。
 */
const libs = new Proxy({}, {
	get(_target, prop) {
		if (prop === Symbol.toStringTag) return 'SillyTavernLibs'
		const name = String(prop)
		throw new Error(`[beilu宿主] SillyTavern.libs.${name} 尚未接入（离线库缺失，一期未打包本地库）。` +
			`该库需随「离线库本地化」批次下载后接线；当前访问被显式拦截以避免拿到坏值。`)
	},
	has() { return false },
	ownKeys() { return [] },
})

/**
 * 全局 SillyTavern：挂到 globalThis（＝浏览器 window），插件与 shim 均从此取。
 * 幂等：重复 import 只挂一次（ESM 模块单例，副作用天然只跑一次，但仍防御 host-loader 之外的意外重入）。
 */
if (!globalThis.SillyTavern) {
	globalThis.SillyTavern = {
		getContext,
		libs,
		/** 供报告/调试：暴露一期缺失的库清单（不影响插件逻辑）。 */
		__missingLibs: LIB_NAMES.slice(),
	}
}

export const SillyTavern = globalThis.SillyTavern
export { getContext, libs }

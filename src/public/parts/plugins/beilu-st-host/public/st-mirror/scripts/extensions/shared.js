/**
 * [beilu-st-host · st-mirror shim] scripts/extensions/shared.js —— 酒馆扩展共享杂项落点（一期抛错 stub）。
 *
 * 【为什么在这里】插件 `import {...} from '../../../../scripts/extensions/shared.js'` 从
 *   .../third-party/<name>/ 五级相对解析到 .../st-mirror/scripts/extensions/shared.js（本文件）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】少量插件的杂项（具体符号 ST-P4 未逐一列举）。
 *
 * 【一期策略】证据不足以确定具体符号 → 用 Proxy 命名空间：任意具名访问都抛「含符号名」的明确错误（红线2）。
 *   注意：ESM 无法用 Proxy 做「动态命名导出」；本 shim 只能导出已知名 + default。若插件 import 了本文件
 *   未显式导出的具名符号，ESM 会抛「no export named X」（可见错误），同样满足红线（失败可见）。
 *   一旦发现真实依赖的具名符号，按证据补成显式 export（转发 or 抛错 stub）。
 */

/** 默认导出：Proxy 命名空间，任意属性访问抛含名错误（供 `import shared from '...'; shared.foo` 写法）。 */
const shared = new Proxy({}, {
	get(_t, prop) {
		if (prop === 'default' || typeof prop === 'symbol') return undefined
		throw new Error(`[beilu宿主] scripts/extensions/shared.js 的 ${String(prop)} 尚未实现（一期 stub）。发现真实依赖请按证据补入本 shim。`)
	},
})

export default shared

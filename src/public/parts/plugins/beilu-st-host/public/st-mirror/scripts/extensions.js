/**
 * [beilu-st-host · st-mirror shim] scripts/extensions.js —— 酒馆扩展子系统 `../../../../scripts/extensions.js` 落点。
 *
 * 【为什么在这里】插件 `import {...} from '../../../../scripts/extensions.js'` 从
 *   .../third-party/<name>/ 四级相对解析到 .../st-mirror/scripts/extensions.js（本文件）。只做转发。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.2）】
 *   extension_settings          → 全部 6（插件设置读写）        → ../../st-settings.mjs Proxy
 *   getContext                  → MessageSummarize / Dialogue-Colorizer → ../../st-globals.mjs
 *   renderExtensionTemplateAsync→ memory-enhancement / Timelines（渲染 HTML 模板）→ ../../st-ui.mjs（一期抛错 stub）
 *   writeExtensionField         → memory-enhancement（写扩展字段到角色卡）→ getContext().writeExtensionField
 *
 * 【red line 2】未实现符号经 getContext 或 st-ui 抛带名错误；未列符号由 ESM「no export named」暴露（可见）。
 */

import { extension_settings, saveSettingsDebounced, saveSettings } from '../../st-settings.mjs'
import { getContext } from '../../st-globals.mjs'
import { renderExtensionTemplateAsync } from '../../st-ui.mjs'

export { extension_settings, saveSettingsDebounced, saveSettings, getContext, renderExtensionTemplateAsync }

/** 写扩展字段到角色卡（→ getContext().writeExtensionField）。ST-P4：memory-enhancement 使用。 */
export function writeExtensionField(...args) {
	return getContext().writeExtensionField(...args)
}

/**
 * renderExtensionTemplate（非 Async 旧版）：ST 遗留同步签名。一期同样抛错 stub（红线2），二期接模板体系。
 * 分开定义（不复用 Async）以便插件 import 任一名都拿到明确错误而非 undefined。
 */
export function renderExtensionTemplate(extensionName, templateId) {
	throw new Error(`[beilu宿主] renderExtensionTemplate（同步版）尚未实现（一期）。` +
		`插件 "${extensionName}" 请求模板 "${templateId}"；模板渲染体系属二期。`)
}

/**
 * [0807 拉线断点A] loadExtensionSettings —— ST extensions.js:1783 真 export（初始化期加载各扩展设置面板，
 * 宿主自己在 host-loader 里做等价编排，插件不该调用）。st-input-helper 等插件按 ST 官方模板
 * `import { ..., loadExtensionSettings }` 只 import 不调用——shim 漏此符号时 ESM 静态解析直接
 * 「no export named」＝插件模块加载即炸（沙盒 1315 后端拉线实测确诊）。补「符号存在、调用即抛」：
 * import 可过（官方模板插件全活），真调用走红线 2 可见错误。
 */
export function loadExtensionSettings(...args) {
	throw new Error('[beilu宿主] loadExtensionSettings 是 ST 宿主初始化函数（extensions.js:1783），' +
		'beilu 宿主由 host-loader 统一编排加载，插件不应调用；若插件确有此依赖请报错误面板。')
}

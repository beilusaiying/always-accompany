/**
 * ST 兼容层主入口
 *
 * 负责：
 * 1. 内容检测：分析 HTML 内容判断需要注入哪些层
 * 2. 脚本组装：生成 <script src> 外部标签 + 内联 shim 代码
 * 3. 开关管理：读取/设置 ST 兼容模式开关状态
 *
 * 加载策略（v2 重构）：
 * - 第三方库（lodash/jQuery/Vue/YAML/EJS）→ <script src="CDN"> 外部标签加载
 * - 环境适配代码（事件系统/变量系统/TavernHelper 等）→ 内联 <script> 注入
 * - Zod 不再预注入（MVU bundle 自带 Zod 4.x，避免版本冲突）
 *
 * 使用方式（在 iframeRenderer.mjs 中调用）：
 *   import { detectNeeds, buildInjectionScript, isSTCompatEnabled } from './stCompat/index.mjs'
 *
 *   const { needsST, needsMVU, needsVue, needsEJS } = detectNeeds(htmlDocument)
 *   if (needsST || needsMVU || needsVue || needsEJS) {
 *       const script = await buildInjectionScript({ needsST, needsMVU, needsVue, needsEJS, messageId, userName, charName })
 *       // 注入到 earlyScript 之后
 *   }
 */

import { createDiag } from '../../diagLogger.mjs'
import { generateEjsEngineScript } from './ejsEngine.mjs'
import { initVariableStore } from './variableStore.mjs'

// runtime/ 模块 — 从原 polyfills.mjs 拆分
import { generateEventConstantsScript } from './runtime/eventConstants.mjs'
import { generateEventSystemScript } from './runtime/eventSystem.mjs'
import { generateGlobalManagerScript } from './runtime/globalManager.mjs'
import { generateLorebookAPIScript } from './runtime/lorebookAPI.mjs'
import { generateMVUPolyfillScript } from './runtime/mvuPolyfill.mjs'
import { generateSTContextEnhancementScript } from './runtime/stContext.mjs'
import { generateTavernHelperScript } from './runtime/tavernHelper.mjs'
import { generateUtilsScript } from './runtime/utils.mjs'
import { generateVariableSystemScript } from './runtime/variableSystem.mjs'

const diag = createDiag('stCompat')

// ============================================================
// CDN URL 配置
// ============================================================

const CDN_URLS = {
	lodash: 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
	jquery: 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
	yaml: 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js',
	vue: 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.global.prod.js',
	ejs: 'https://cdn.jsdelivr.net/npm/ejs@3.1.10/ejs.min.js',
	'mvu-bundle': 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js',
}

// ============================================================
// 开关管理
// ============================================================

/** localStorage key */
const STORAGE_KEY = 'beilu-st-compat-enabled'

/**
 * 检查 ST 兼容模式是否开启
 *
 * 默认为 true（开启），用户可通过 UI 关闭。
 * 即使开启，也只在检测到内容使用 ST API 时才注入。
 *
 * @returns {boolean}
 */
export function isSTCompatEnabled() {
	try {
		const saved = localStorage.getItem(STORAGE_KEY)
		// 默认开启：只有明确设为 'false' 时才关闭
		const enabled = saved !== 'false'
		diag.debug('开关状态:', enabled ? '开启' : '关闭')
		return enabled
	} catch {
		return true
	}
}

/**
 * 设置 ST 兼容模式开关
 *
 * @param {boolean} enabled
 */
export function setSTCompatEnabled(enabled) {
	try {
		localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
	} catch { /* ignore */ }
}

// ============================================================
// 内容检测
// ============================================================

/**
 * 检测 HTML 内容需要哪些兼容层
 *
 * @param {string} htmlContent - iframe 的 HTML 文档字符串
 * @returns {{ needsST: boolean, needsMVU: boolean, needsVue: boolean, needsEJS: boolean }}
 */
export function detectNeeds(htmlContent) {
	if (!htmlContent || !isSTCompatEnabled()) {
		diag.debug('检测跳过:', !htmlContent ? '内容为空' : '兼容层已关闭')
		return { needsST: false, needsMVU: false, needsVue: false, needsEJS: false }
	}

	diag.time('detectNeeds')

	// Layer 1: ST 兼容层 — 检测 TavernHelper / SillyTavern API 使用
	let needsST = /\bTavernHelper\b|\bgetVariables\b|\beventOn\b|\bwaitGlobalInitialized\b|\bSillyTavern\.\w+\b|\binitializeGlobal\b|\beventEmit\b|\bgetAllVariables\b|\breplaceVariables\b|\berrorCatched\b|\beventOnce\b|\btavern_events\b|\biframe_events\b/.test(htmlContent)

	// Layer 2: MVU 层 — 检测 MVU 框架引用
	let needsMVU = needsST && /\bMvu\b|\bMagVarUpdate\b|\bstat_data\b|\bgetMvuData\b|\breplaceMvuData\b|\bmag_variable_/.test(htmlContent)

	// ★ URL 模式检测：消息 HTML 中可能包含 <script src="...bundle.js"> 等外部引用
	// 这些外部脚本内部使用 getVariables/eventOn/z.object 等 API，但关键字不在 HTML 字符串中
	// 通过检测 CDN URL 来识别 MVU 需求
	if (!needsMVU) {
		const hasMvuUrls = /bundle\.js|mvu_zod\.js|MagVarUpdate|MagicalAstrogy|tavern_resource\/dist/.test(htmlContent)
		if (hasMvuUrls) {
			needsST = true
			needsMVU = true
			diag.debug('URL 模式检测到 MVU 依赖，强制启用 Layer1+Layer2')
		}
	}

	// Layer 3: Vue — 检测 Vue 3 框架引用
	const needsVue = /\bVue\b|\bv-if\b|\bv-for\b|\bv-model\b|\bcreateApp\b/.test(htmlContent)

	// Layer 4: EJS — 检测 EJS 模板语法
	const needsEJS = /<%[\s\S]*?%>/.test(htmlContent)

	diag.timeEnd('detectNeeds')
	diag.log('内容检测结果:', { needsST, needsMVU, needsVue, needsEJS, htmlLen: htmlContent.length })

	if (needsST || needsVue || needsEJS) {
		diag.snapshot('detectNeeds', {
			needsST,
			needsMVU,
			needsVue,
			needsEJS,
			htmlLen: htmlContent.length,
			matchedAPIs: [
				needsST && 'ST-Layer1',
				needsMVU && 'MVU-Layer2',
				needsVue && 'Vue-Layer3',
				needsEJS && 'EJS-Layer4',
			].filter(Boolean),
		})
	}

	return { needsST, needsMVU, needsVue, needsEJS }
}

// ============================================================
// 脚本组装
// ============================================================

/**
 * 生成 <script src="..."> 外部加载标签
 *
 * @param {string} url - CDN URL
 * @param {string} [comment] - 注释说明
 * @returns {string} HTML script 标签
 */
function _cdnScriptTag(url, comment) {
	const commentStr = comment ? `<!-- ${comment} -->\n` : ''
	return `${commentStr}<script src="${url}"></` + `script>`
}

/**
 * 构建完整的 ST 兼容层注入脚本
 *
 * 返回一组 HTML 标签字符串（<script src> + <script>内联</script>），
 * 插入到 earlyScript 之后。
 *
 * 执行顺序保证：
 *   earlyScript（基础 ST API）
 *   → <script src> 第三方库（lodash/jQuery/Vue 等）
 *   → <script> 内联 shim（事件系统/变量系统/TavernHelper 等）
 *   → 角色卡自身脚本
 *
 * @param {object} options
 * @param {boolean} options.needsST - 是否需要 Layer 1
 * @param {boolean} options.needsMVU - 是否需要 Layer 2
 * @param {boolean} [options.needsVue=false] - 是否需要 Vue 3
 * @param {boolean} [options.needsEJS=false] - 是否需要 EJS 模板引擎
 * @param {number} [options.messageId=0] - 当前消息 ID
 * @param {string} [options.userName='User'] - 用户名
 * @param {string} [options.charName='Character'] - 角色名
 * @returns {Promise<string>} HTML 标签字符串（多个 <script> 标签）
 */
export async function buildInjectionScript(options = {}) {
	const {
		needsST, needsMVU,
		needsVue = false, needsEJS = false,
		messageId = 0, userName = 'User', charName = 'Character',
	} = options

	if (!needsST && !needsMVU && !needsVue && !needsEJS) return ''

	diag.time('buildInjectionScript')
	diag.log('开始构建注入脚本:', { needsST, needsMVU, needsVue, needsEJS, messageId, userName, charName })

	/** 外部 <script src> 标签（先加载，保证依赖顺序） */
	const externalScripts = []

	/** 内联 shim 代码块 */
	const inlineParts = []

	// ============================================================
	// Layer 1: ST 兼容层
	// ============================================================
	if (needsST) {
		// 1a. lodash — 外部加载（后续 polyfill 依赖 _.set / _.get）
		externalScripts.push(_cdnScriptTag(CDN_URLS.lodash, 'lodash 4.17.21'))
		diag.debug('已添加: lodash CDN script tag')

		// 1b. 事件系统（内联 shim）
		inlineParts.push(generateEventSystemScript())

		// 1c. 事件常量
		inlineParts.push(generateEventConstantsScript())

		// 1d. 全局对象管理
		inlineParts.push(generateGlobalManagerScript())

		// 1e. 变量系统
		inlineParts.push(generateVariableSystemScript())

		// 1f. 工具函数
		inlineParts.push(generateUtilsScript())

		// 1g. SillyTavern 对象增强
		inlineParts.push(generateSTContextEnhancementScript({ userName, charName, messageId }))

		// 1h. TavernHelper 对象
		inlineParts.push(generateTavernHelperScript())

		// 1i. 世界书 / Lorebook API
		inlineParts.push(generateLorebookAPIScript())
		diag.debug('已生成: 世界书 API 脚本')

		// 1j. yaml 库 — 外部加载
		externalScripts.push(_cdnScriptTag(CDN_URLS.yaml, 'js-yaml 4.1.0'))

		// 1k. YAML 兼容包装器
		// js-yaml CDN 注册 window.jsyaml，API: jsyaml.load() / jsyaml.dump()
		// 酒馆助手用的是 'yaml' 包（非 js-yaml），API: YAML.parse() / YAML.stringify()
		// MVU bundle.js 的 util.ts 使用 YAML.parse() + YAML.stringify()
		// 这里创建兼容包装器，将 jsyaml API 映射为 YAML API
		inlineParts.push(`
// YAML compat wrapper: js-yaml (jsyaml.load/dump) → yaml pkg API (YAML.parse/stringify)
if (typeof window.YAML === 'undefined' && typeof window.jsyaml !== 'undefined') {
	window.YAML = {
		parse: function(str, options) {
			try { return window.jsyaml.load(str, options); }
			catch(e) { console.warn('[YAML.parse] error:', e.message); return undefined; }
		},
		stringify: function(obj, options) {
			try { return window.jsyaml.dump(obj, options); }
			catch(e) { console.warn('[YAML.stringify] error:', e.message); return ''; }
		},
		parseDocument: function(str, options) {
			var parsed = window.jsyaml.load(str);
			return {
				toJS: function(opt) { return parsed; },
				toJSON: function() { return parsed; },
				toString: function() { return window.jsyaml.dump(parsed); },
				contents: parsed
			};
		},
		parseAllDocuments: function(str) {
			try {
				return window.jsyaml.loadAll(str).map(function(doc) {
					return {
						toJS: function(opt) { return doc; },
						toJSON: function() { return doc; },
						toString: function() { return window.jsyaml.dump(doc); },
						contents: doc
					};
				});
			} catch(e) { return []; }
		}
	};
	console.log('[stCompat] YAML compat wrapper created (js-yaml → yaml pkg API)');
}`)

		// 1l. EJS（按需）
		if (needsEJS) {
			externalScripts.push(_cdnScriptTag(CDN_URLS.ejs, 'ejs 3.1.10'))
			inlineParts.push(generateEjsEngineScript())
			diag.debug('已添加: EJS CDN + EjsTemplate polyfill')
		}

		diag.log('Layer 1 (ST兼容) 构建完成')
	}

	// ============================================================
	// Layer 2: MVU 层
	// ============================================================
	if (needsMVU) {
		// ★ Zod CDN 注入：消息 iframe 中的内联代码可能使用 z.object()/z.boolean() 等
		// 通过 <script type="module"> 加载 Zod 4.x，与 scriptRunner 使用相同的 CDN
		inlineParts.push(`
// ★ Zod 4.x CDN 加载（消息 iframe 用）
(async function() {
	if (typeof window.z === 'undefined' || typeof window.z.object !== 'function') {
		try {
			window.z = window.z || {};
			const zod = await import('https://testingcf.jsdelivr.net/npm/zod/+esm');
			window.z = zod; self.z = zod;
			console.log('[stCompat] Zod 4.x loaded for message iframe');
		} catch(e1) {
			try {
				const zod2 = await import('https://cdn.jsdelivr.net/npm/zod/+esm');
				window.z = zod2; self.z = zod2;
			} catch(e2) {
				console.warn('[stCompat] Zod CDN load failed for message iframe');
			}
		}
	}
})();`)

		// MVU polyfill（内联 shim）
		inlineParts.push(generateMVUPolyfillScript())
		diag.log('Layer 2 (MVU) 构建完成 — Zod CDN + MVU polyfill 已注入')
	}

	// ============================================================
	// Layer 3: Vue 层（按需）
	// ============================================================
	if (needsVue) {
		externalScripts.push(_cdnScriptTag(CDN_URLS.vue, 'Vue 3.5.13'))
		diag.log('Layer 3 (Vue) 构建完成')
	}

	// ============================================================
	// 组装最终输出
	// ============================================================
	// 顺序：外部 <script src> 先加载 → 内联 <script> 后执行
	const resultParts = []

	// 外部脚本标签
	if (externalScripts.length > 0) {
		resultParts.push(externalScripts.join('\n'))
	}

	// 内联 shim 代码
	if (inlineParts.length > 0) {
		const inlineCode = inlineParts.join('\n\n')
		resultParts.push(`<script>\n${inlineCode}\n</` + `script>`)
	}

	const result = resultParts.join('\n')

	diag.timeEnd('buildInjectionScript')
	diag.log('注入脚本构建完成:', (result.length / 1024).toFixed(1), 'KB')
	diag.snapshot('buildInjectionScript', {
		messageId,
		needsST,
		needsMVU,
		needsVue,
		needsEJS,
		externalCount: externalScripts.length,
		inlineCount: inlineParts.length,
		totalSizeKB: (result.length / 1024).toFixed(1),
	})

	return result
}

/**
 * 初始化 ST 兼容层
 *
 * 在 beilu-chat 父页面的 init() 中调用一次。
 * 初始化父页面全局对象。
 *
 * 注意：v2 重构后不再预加载 CDN 资源（改为 <script src> 外部标签，
 * 由浏览器自行加载和缓存）。
 */
export function initSTCompat() {
	// 初始化父页面全局对象
	if (!window.__beiluEventBus) {
		window.__beiluEventBus = { _listeners: new Map() }
	}
	if (!window.__beiluGlobals) {
		window.__beiluGlobals = {}
	}

	// 初始化变量持久化管理器
	if (!window.__beiluVarStore) {
		initVariableStore()
	}

	if (isSTCompatEnabled()) {
		diag.log('ST 兼容层已初始化（开关: 开启）— EventBus + Globals + VarStore 已挂载')
	} else {
		diag.log('ST 兼容层已跳过（开关: 关闭）')
	}
}
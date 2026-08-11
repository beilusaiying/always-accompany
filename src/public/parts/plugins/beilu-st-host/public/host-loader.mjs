/**
 * [beilu-st-host · 前端入口] host-loader —— 复刻酒馆 activateExtensions 加载链。
 *
 * 【定位】beilu-chat 在页面早期只 dynamic import 本文件一行（挂载点由并行分身接入，本文件不碰 beilu-chat）。
 *   本文件负责：拉已装插件清单 → 排序 → 门槛判定 → 顺序注入 js/css → 调 manifest.hooks。
 *   复刻对象：ST public/scripts/extensions.js 的 activateExtensions（转换表§一、ST-P1）。
 *
 * 【后端契约（main.mjs 既成事实，只读）】
 *   GET /api/parts/plugins:beilu-st-host/st-plugins/discover
 *       → { hostEnabled:boolean, plugins:[{name, enabled, manifest|null, error|null}] }
 *   插件静态文件（镜像树）：/api/parts/plugins:beilu-st-host/st-mirror/scripts/extensions/third-party/<name>/<file>
 *
 * 【为什么注入路径要走 st-mirror 镜像树】酒馆插件 js 用相对 ESM 导入（`import ... from '../../../../script.js'`，
 *   6/6 样本如此，ST-P4）。只有把插件挂在
 *     .../st-mirror/scripts/extensions/third-party/<name>/<入口js>
 *   四级相对 `../../../../script.js` 才会解析到 .../st-mirror/script.js（宿主 shim）。见交付报告的相对路径推演。
 *
 * 【红线】1 加载前门槛：hostEnabled=false 或插件未 enabled → 根本不注入 js（不是注入后不激活）。
 *   3/4 门槛不满足 / manifest 损坏 → 进错误面板并写明原因（st-ui.addExtensionError），不静默丢弃。
 *
 * 【功能链】beilu-chat 挂载点 → import(host-loader) → run() → fetch discover →
 *   (hostEnabled? enabled 项?) → initUi + initSettings → 排序 → 逐个门槛+注入 script/link → hooks.activate。
 *
 * 【runtime 先于插件】本文件顶部静态 import 四个 runtime 模块，保证
 *   globalThis.SillyTavern（st-globals 副作用）、eventSource、extension_settings、三容器 在任何插件 js 之前就位。
 */

// —— 顺序敏感：st-globals 顶层副作用挂 globalThis.SillyTavern，必须最先 import ——
import './st-globals.mjs'
import { initSettings } from './st-settings.mjs'
import { initUi, addExtensionError } from './st-ui.mjs'
import { eventSource, event_types } from './st-events.mjs'

// 后端 part base（main.mjs: const API = '/api/parts/plugins\:beilu-st-host'，真实路径冒号不转义）。
const API_BASE = '/api/parts/plugins:beilu-st-host'
const DISCOVER_URL = `${API_BASE}/st-plugins/discover`
// 插件文件在镜像树的 third-party 段（main.mjs st-mirror 路由的 third-party 分支 serve 用户插件目录）。
const THIRD_PARTY_BASE = `${API_BASE}/st-mirror/scripts/extensions/third-party`

const HOOK_TIMEOUT_MS = 5000

/** 拼某插件某文件的镜像树 URL。 */
function pluginFileUrl(name, file) {
	return `${THIRD_PARTY_BASE}/${encodeURIComponent(name)}/${String(file).split('/').map(encodeURIComponent).join('/')}`
}

/**
 * loading_order 排序（ST-P1 §二 + 转换表改进：parseInt 失败退到 display_name 稳定二级排序）。
 * ST 原版用 `parseInt(order)||0`（NaN→0）；我们改用 NaN→末位 + display_name 二级键，避免无序抖动。
 */
function sortByLoadingOrder(list) {
	return list.slice().sort((a, b) => {
		const oa = parseInt(a.manifest?.loading_order)
		const ob = parseInt(b.manifest?.loading_order)
		const na = Number.isNaN(oa), nb = Number.isNaN(ob)
		if (na && nb) return String(a.manifest?.display_name || a.name).localeCompare(String(b.manifest?.display_name || b.name))
		if (na) return 1   // a 无序 → 末位
		if (nb) return -1  // b 无序 → 末位
		if (oa !== ob) return oa - ob
		return String(a.manifest?.display_name || a.name).localeCompare(String(b.manifest?.display_name || b.name))
	})
}

/**
 * 门槛判定（ST-P1 §三 门槛四连 → 一期裁剪）。满足返回 null（可注入）；不满足返回原因字符串（记面板 + 不注入）。
 * @param {object} item discover 项 {name, enabled, manifest, error}
 * @param {Set<string>} enabledNames 所有 enabled 且 manifest 有效的插件名（用于 dependencies 判定）
 */
function gateReason(item, enabledNames) {
	const m = item.manifest
	if (item.error) return `manifest 读取失败：${item.error}`
	if (!m || typeof m !== 'object') return 'manifest 缺失或非法'
	if (m.dead === true) return '插件 manifest 标记为 dead（已废弃），跳过加载'
	if (!m.js || typeof m.js !== 'string') return 'manifest 缺少入口 js 字段'
	// dependencies：依赖的其他插件必须都已 enabled（否则不注入，红线1/3）。
	if (Array.isArray(m.dependencies) && m.dependencies.length) {
		const missing = m.dependencies.filter(dep => !enabledNames.has(dep))
		if (missing.length) return `依赖的插件未启用：${missing.join('、')}`
	}
	// requires（Extras 端点）：beilu 无 Extras 对等 → 非空即视为不满足（ST-P1 §三、转换表 D 策）。
	if (Array.isArray(m.requires) && m.requires.length) {
		return `依赖 Extras 端点（beilu 一期不支持）：${m.requires.join('、')}`
	}
	// min_version / minimum_version：一期无版本约束，跳过判定（不拦）。
	return null
}

/**
 * 注入一个 <script type="module"> 并等待其 load（顺序 await，复刻 ST 逐个 addExtension）。
 * @returns {Promise<void>} onload resolve；onerror reject（带 URL，便于面板显示是哪个文件挂了）。
 */
function injectScript(url) {
	return new Promise((resolve, reject) => {
		const el = document.createElement('script')
		el.type = 'module'
		el.src = url
		el.onload = () => resolve()
		el.onerror = () => reject(new Error(`脚本加载失败：${url}`))
		document.head.appendChild(el)
	})
}

/** 注入一个 <link rel="stylesheet">（css 失败不阻断 —— 样式缺失不影响逻辑，只 warn）。 */
function injectCss(url) {
	return new Promise((resolve) => {
		const el = document.createElement('link')
		el.rel = 'stylesheet'
		el.href = url
		el.onload = () => resolve()
		el.onerror = () => { console.warn(`[beilu-st-host] 样式加载失败（忽略）：${url}`); resolve() }
		document.head.appendChild(el)
	})
}

/**
 * 调 manifest.hooks（ST-P1 §四 / ST-P4 §四：真实只有 activate，但机制通用支持任意具名导出）。
 * 动态 import 插件入口模块 → 取 hooks 指定的具名导出 → Promise.race 5000ms 超时只 warn 不阻塞。
 */
async function runHooks(item) {
	const hooks = item.manifest?.hooks
	if (!hooks || typeof hooks !== 'object') return
	const url = pluginFileUrl(item.name, item.manifest.js)
	let mod
	try {
		mod = await import(url)
	} catch (err) {
		console.warn(`[beilu-st-host] 插件 "${item.name}" hooks 模块 import 失败：`, err?.message || err)
		return
	}
	for (const [hookName, exportName] of Object.entries(hooks)) {
		const fn = mod?.[exportName]
		if (typeof fn !== 'function') {
			console.warn(`[beilu-st-host] 插件 "${item.name}" 的 hook "${hookName}" 指定导出 "${exportName}" 不是函数，跳过`)
			continue
		}
		const timeout = new Promise((resolve) => setTimeout(() => {
			console.warn(`[beilu-st-host] 插件 "${item.name}" hook "${hookName}" 超过 ${HOOK_TIMEOUT_MS}ms 未完成（不阻塞后续）`)
			resolve()
		}, HOOK_TIMEOUT_MS))
		try {
			await Promise.race([Promise.resolve().then(() => fn()), timeout])
		} catch (err) {
			console.warn(`[beilu-st-host] 插件 "${item.name}" hook "${hookName}" 执行抛错：`, err?.message || err)
		}
	}
}

/**
 * 主流程。beilu-chat 挂载点 import 本模块后调 run()（或本模块默认自执行，见文件尾）。
 * @returns {Promise<{loaded:string[], skipped:string[]}>} 便于挂载点/测试断言。
 */
export async function run() {
	const result = { loaded: [], skipped: [] }

	// 1. 拉清单。
	let discover
	try {
		const res = await fetch(DISCOVER_URL, { credentials: 'same-origin' })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		discover = await res.json()
	} catch (err) {
		console.warn('[beilu-st-host] discover 拉取失败，宿主不加载任何插件：', err?.message || err)
		return result
	}

	// 2. 加载前门槛（红线1）：宿主未启用 → 零动作。
	if (!discover || discover.hostEnabled !== true) return result
	const plugins = Array.isArray(discover.plugins) ? discover.plugins : []

	// enabled 且 manifest 有效的插件名集合（dependencies 判定用）。
	const enabledNames = new Set(plugins.filter(p => p.enabled === true && p.manifest && !p.error).map(p => p.name))

	// 只处理 enabled 项（红线1：禁用插件根本不进注入流程）。
	const candidates = plugins.filter(p => p.enabled === true)
	if (candidates.length === 0) return result

	// 3. 初始化 UI 容器 + 全量拉设置 —— 必须早于任何插件 js。
	initUi()
	await initSettings()

	// 3.5 [0807 拉线断点C] 全局 jQuery：ST 主页面有全局 $/jQuery，酒馆插件裸用（st-input-helper
	//   `$.get`/`$('#send_form')`，官方模板形态）；beilu-chat 主页面无 jQuery（交付报告 §2 grep 证据，
	//   沙盒 1315 拉线确诊）→ 插件运行即 ReferenceError。注入本地资产 /vendor/jquery.min.js
	//   （离线硬约束：本仓 public/pages/vendor/ 自带，页面根 200 已实测）。已有 $ 时零动作（不覆盖）；
	//   加载失败进错误面板不阻断（无 jQuery 的插件仍能跑）。必须早于任何插件 js。
	if (!globalThis.jQuery || !globalThis.$) {
		await new Promise((resolve) => {
			const el = document.createElement('script')
			el.src = '/vendor/jquery.min.js'
			el.onload = () => resolve()
			el.onerror = () => { addExtensionError('宿主', 'jQuery 本地资产加载失败（/vendor/jquery.min.js）——裸用 $ 的插件将运行报错'); resolve() }
			document.head.appendChild(el)
		})
	}

	// 3.6 [0807 libs 离线化·排序链实证缺口] jQuery UI：ST 页面全局带 $.ui（sortable/draggable 等），
	//   插件裸用（st-input-helper initSortable 拖拽排序，缺席时自警降级=功能缺）。本地资产=
	//   st-mirror/lib/（整目录复制自 ST public/lib，AGPL，_SOURCE.md 记来源）——镜像树静态 serve，
	//   离线硬约束满足。touch-punch=jQuery UI 移动端触摸桥（ST 页面同款成对加载）。
	//   顺序：必须在 jQuery 之后、任何插件 js 之前；已有 $.ui（未来 beilu 自带时）零动作不覆盖。
	if (globalThis.jQuery && !globalThis.jQuery.ui) {
		const _loadLib = (file) => new Promise((resolve) => {
			const el = document.createElement('script')
			el.src = `/parts/plugins:beilu-st-host/st-mirror/lib/${file}`
			el.onload = () => resolve()
			el.onerror = () => { addExtensionError('宿主', `本地库加载失败（st-mirror/lib/${file}）`); resolve() }
			document.head.appendChild(el)
		})
		await _loadLib('jquery-ui.min.js')
		await _loadLib('jquery.ui.touch-punch.min.js')
	}

	// 4. 排序。
	const ordered = sortByLoadingOrder(candidates)

	// 5. 逐个门槛 + 顺序注入。
	for (const item of ordered) {
		const reason = gateReason(item, enabledNames)
		if (reason) {
			addExtensionError(item.manifest?.display_name || item.name, reason)
			result.skipped.push(item.name)
			continue
		}
		try {
			// css 先注（不阻断），再 await 注入入口 js。
			if (item.manifest.css && typeof item.manifest.css === 'string') {
				injectCss(pluginFileUrl(item.name, item.manifest.css))
			}
			await injectScript(pluginFileUrl(item.name, item.manifest.js))
			// 注入成功后调 hooks（ST 时机：注入 script 后、FIRST_LOAD 前）。
			await runHooks(item)
			result.loaded.push(item.name)
		} catch (err) {
			addExtensionError(item.manifest?.display_name || item.name, `注入失败：${err?.message || err}`)
			result.skipped.push(item.name)
		}
	}

	// 6. 全部注入后广播 EXTENSIONS_FIRST_LOAD（转换表：一期可选；有订阅者则收到）。
	try { eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD) } catch { /* 无订阅者安全 no-op */ }

	return result
}

// 默认自执行：挂载点只需 `import('.../host-loader.mjs')` 一行即可触发全流程（符合设计「只挂一个 loader」）。
// 若挂载点想拿到结果，可改为 import 后显式调 run()；两种用法都支持（run 幂等性由后端门槛保证）。
run().catch(err => console.error('[beilu-st-host] host-loader 运行异常：', err))

export default run

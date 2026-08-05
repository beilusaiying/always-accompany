/**
 * 部件加载器 — 管理所有 Part（Shell/Plugin/ServiceSource/ServiceGenerator/ImportHandler）的
 * 发现、加载、卸载、重载、默认部件注册。不管路由分发（那是 parts_router.mjs 的事），
 * 不管具体部件的业务逻辑（那是各 Part 自己的事）。
 *
 * 链路：server.mjs init() → shallowLoadAllDefaultParts(浅加载) → 首次 HTTP 请求触发 PartsRouter → loadPart → loadPartBase(完整生命周期)
 * 影响：写 parts_config.json（部件配置持久化）、发 part-installed/part-loaded/part-uninstalled 事件、
 *       重载时 setTimeout(restartor) 重启整个进程（Deno 不支持单文件 ESM 热卸载）
 * 相交：← parts_router.mjs(loadPart 懒加载) / server.mjs(shallowLoadAllDefaultParts)
 *       → auth.mjs(getUserDictionary 用户目录) / events.mjs(事件发射) / web_server/parts_router.mjs(getPartRouter/deletePartRouter)
 *
 * 部件生命周期钩子执行时序：
 *   首次加载(loadPartBase)：Init({ router, username }) → Load({ router, username }) → [按 config.loadPolicy] SetData(config, lifecycleContext)
 *     ⚠ SetData 在 Load 之后，插件 Load 内部无法依赖框架注入的配置
 *   浅加载(baseloadPart via shallowLoadAllDefaultParts)：只 import(main.mjs) + V8 缓存，不执行 Init/Load/SetData
 *   热重载(reloadPart)：setTimeout(restartor, 1000) 重启进程
 *
 * FullProxy 包装：loadPartBase 返回的引用是惰性代理，每次属性访问实时取 parts_set 最新实例——
 * 保证重载后旧引用自动指向新实例。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout } from 'node:timers'
import { parentPort, threadId } from 'node:worker_threads'
import url from 'node:url'

import { FullProxy } from 'npm:full-proxy'
import trash from 'npm:trash'

// beilu: 移除了 git.mjs 和 profiler.mjs（已删除）
import { console } from '../scripts/i18n_core.mjs' // [0722 解环] console 叶子
import { loadJsonFile } from '../scripts/json_loader.mjs'
import { getLocalizedInfo } from '../scripts/locale.mjs'
import { nicerWriteFileSync } from '../scripts/nicerWriteFile.mjs'
import { confinePath } from '../yonban/core/functions/security/path_confine.mjs'

import { reportPluginStatus, clearPluginStatusesForUser, renamePluginStatusesForUser, getPluginStatusUsernames, logError, logWarn } from "./monitor.mjs";
import { reportPartPreloadState } from "./readiness.mjs"; // [D5 §2.4] 后台预加载逐 Part 可观察状态(readiness 注册表叶子,无环)
import { wbTrace, wbDetect } from "./whitebox.mjs";
import { extractMissingNpmPackage, ensureNpmPackage } from "./npmAutoInstall.mjs";
import { createDiag } from "./diagLogger.mjs";

// 诊断 parts 模块常驻埋点（0716 死标记接线）：加载/卸载链按需可见（BEILU_DIAG=parts）
const diag = createDiag("parts");

// beilu: doProfile 替代为直接执行
async function doProfile(fn) {
	const start = Date.now()
	await fn()
	return `${Date.now() - start}ms`
}

import { getAllUsers, getUserByUsername, getUserDictionary } from '../yonban/core/functions/security/auth.mjs'
import { __dirname } from './base.mjs'
import { events } from './events.mjs'
import { config, data_path, restartor, save_config, setDefaultStuff, skip_report } from './svr_state.mjs' // [0722 解环] 环境态叶子
import { loadData, saveData } from './setting_loader.mjs'
import { sendEventToUser } from './web_server/event_dispatcher.mjs'
import { deletePartRouter, getPartRouter } from './web_server/parts_router_registry.mjs' // [0722 解环] 注册表叶子（原互引 parts_router）

/**
 * 为用户设置默认部件。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @param {string} child - 子部件名称。
 * @returns {void}
 */
export function setDefaultPart(user, parent, child) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const hadDefaultParts = Object.prototype.hasOwnProperty.call(user, 'defaultParts')
	const hadParent = Object.prototype.hasOwnProperty.call(user.defaultParts || {}, parent)
	const previous = hadParent ? [...user.defaultParts[parent]] : undefined
	const defaultParts = (user.defaultParts ??= {})[parent] ??= []
	if (defaultParts.includes(child)) return
	defaultParts.push(child)
	try { save_config() }
	catch (error) {
		if (hadParent) user.defaultParts[parent] = previous
		else delete user.defaultParts[parent]
		if (!hadDefaultParts) delete user.defaultParts
		throw error
	}
	sendEventToUser(user.username, 'default-part-setted', { parent, child })
}

/**
 * 批量设置默认部件（只写一次磁盘）。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @param {string[]} children - 子部件名称数组。
 * @returns {string[]} 实际新增的子部件名称。
 */
export function setDefaultPartBatch(user, parent, children) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const hadDefaultParts = Object.prototype.hasOwnProperty.call(user, 'defaultParts')
	const hadParent = Object.prototype.hasOwnProperty.call(user.defaultParts || {}, parent)
	const previous = hadParent ? [...user.defaultParts[parent]] : undefined
	const defaultParts = (user.defaultParts ??= {})[parent] ??= []
	const added = []
	for (const child of children) {
		if (defaultParts.includes(child)) continue
		defaultParts.push(child)
		added.push(child)
	}
	if (!added.length) return added
	try { save_config() }
	catch (error) {
		if (hadParent) user.defaultParts[parent] = previous
		else delete user.defaultParts[parent]
		if (!hadDefaultParts) delete user.defaultParts
		throw error
	}
	for (const child of added)
		sendEventToUser(user.username, 'default-part-setted', { parent, child })
	return added
}

/**
 * 从用户的默认部件列表中移除一个部件。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @param {string} child - 要移除的子部件名称。
 * @returns {void}
 */
export function unsetDefaultPart(user, parent, child) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const defaultParts = (user.defaultParts ?? {})[parent] ?? []
	const index = defaultParts.indexOf(child)
	if (index == -1) return
	const previous = [...defaultParts]
	defaultParts.splice(index, 1)
	if (!defaultParts.length) delete user.defaultParts?.[parent]
	try { save_config() }
	catch (error) {
		user.defaultParts ??= {}
		user.defaultParts[parent] = previous
		throw error
	}
	sendEventToUser(user.username, 'default-part-unsetted', { parent, child })
}
/**
 * 获取用户的默认部件。
 * @param {object | string} user - 用户对象或用户名。
 * @returns {Record<string, string[]>} 用户的默认部件。
 */
export function getDefaultParts(user) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	return user?.defaultParts || {}
}

/**
 * 获取用户指定父部件的一个随机默认子部件名称。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @returns {string | undefined} 一个随机的子部件名称，如果列表为空则为 undefined。
 */
export function getAnyDefaultPart(user, parent) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const defaultParts = user?.defaultParts?.[parent] || []
	return defaultParts[Math.floor(Math.random() * defaultParts.length)]
}

/**
 * 获取用户指定父部件的所有默认子部件名称。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @returns {string[]} 指定父部件的所有默认子部件名称。
 */
export function getAllDefaultParts(user, parent) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	return user?.defaultParts?.[parent] || []
}

/**
 * 获取用户指定父部件的一个随机首选默认子部件名称（仅在用户自配的默认列表内随机）。
 * 默认列表为空时返回 undefined，由调用方走"未配置"线路——禁止从全部可用部件随机兜底：
 * serviceSources/AI 等计费资源被随机顶替会静默打真实外部 API（2026-06-12 洗源 bug，N19 删除）。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @returns {string | undefined} 默认列表内随机的子部件名称，列表为空则为 undefined。
 */
export function getAnyPreferredDefaultPart(user, parent) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const defaultPartNames = getAllDefaultParts(user, parent)
	if (defaultPartNames.length)
		return defaultPartNames[Math.floor(Math.random() * defaultPartNames.length)]
	return undefined
}

/**
 * 废弃 shell 迁移表 —— 后端权威定义（与前端 pages/scripts/parts.mjs 的 DEPRECATED_SHELLS 语义镜像）。
 * why 双写：前端模块是浏览器 fetch 版，Deno 后端无法 import；两侧各持一份、注释互指，改一处须同步另一处。
 * 键 = 废弃/失效 shell，值 = 迁移目标可用 shell。
 * - 'beilu-home'：老壳，2026-07 判定废弃（老用户 config 存量 defaultParts.shells 指向它 → 登录落废壳全链路死亡）。
 * - 'home'：历史空值回退串，对应目录从不存在。
 */
export const DEPRECATED_SHELLS = {
	'beilu-home': 'beilu-chat',
	'home': 'beilu-chat',
}

/**
 * 一次性幂等迁移：扫描全用户 defaultParts.shells，把废弃 shell 就地替换为迁移目标。
 * 幂等：已迁移的用户无废壳，再扫为 no-op；安全去重（迁移后若与已有目标重复则合并）。
 * 调用点：server.mjs 启动段 config 加载后、对外服务前（改内存 config 后 save_config 落盘，
 * 不存在"盘改被 live 内存回写覆盖"问题——改的就是权威内存对象）。
 * @returns {{ migrated: Array<{user: string, from: string[], to: string[]}>, total: number }} 迁移报告。
 */
export function migrateStaleShells() {
	const report = { migrated: [], total: 0 }
	let dirty = false
	// getAllUsers() 返回 config.data.users —— 是 {username: userObj} 字典，非数组，须 entries 遍历。
	for (const [username, user] of Object.entries(getAllUsers() || {})) {
		const shells = user?.defaultParts?.shells
		if (!Array.isArray(shells) || !shells.length) continue
		const before = shells.slice()
		const after = []
		let changed = false
		for (const s of shells) {
			const mapped = DEPRECATED_SHELLS[s]
			const next = mapped || s
			if (mapped) changed = true
			if (!after.includes(next)) after.push(next) // 去重，防迁移后与已有壳重复
		}
		if (changed) {
			user.defaultParts.shells = after
			report.migrated.push({ user: username, from: before, to: after })
			report.total++
			dirty = true
		}
	}
	if (dirty) save_config()
	return report
}

/**
 * 加载用户指定父部件的一个随机首选默认子部件。
 * @param {object | string} user - 用户对象或用户名。
 * @param {string} parent - 父部件路径。
 * @returns {Promise<any | undefined>} 一个解析为已加载部件的承诺，如果没有任何可用部件则为 undefined。
 */
export async function loadAnyPreferredDefaultPart(user, parent) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const partname = getAnyPreferredDefaultPart(user, parent)
	if (!partname) return
	return loadPart(user.username, parent + '/' + partname, { username: user.username })
}

/**
 * 通知客户端部件已安装。
 * @param {string} username - 用户名。
 * @param {string} partpath - 部件路径。
 * @returns {void}
 */
export function notifyPartInstall(username, partpath) {
	events.emit('part-installed', { username, partpath })
	sendEventToUser(username, 'part-installed', { partpath })
	invalidatePartBranchesCache(username)
}
/**
 * @typedef {Object} PartInfo
 * @property {Record<string, string>} [name] - 部件的本地化名称。
 * @property {Record<string, string>} [avatar] - 部件的本地化头像URL。
 * @property {Record<string, string>} [description] - 部件的本地化简短描述。
 * @property {Record<string, string>} [description_markdown] - 部件的本地化 markdown 描述。
 * // ... 其他潜在的信息属性
 */

/**
 * @typedef {Object} PartInterfaces
 * @property {Object} [config] - 配置界面。
 * @property {Function} [config.SetData] - 设置配置数据的函数。
 * @property {Object} [parts] - 子部件管理界面。
 * @property {function(string[]): string[]} [parts.getSubPartsList] - 获取子部件列表。
 * @property {function(string[], string, string): Promise<any>} [parts.loadSubPart] - 加载子部件。
 * // ... 其他潜在的界面
 */

/**
 * @typedef {Object} Part
 * @property {PartInfo} [info] - 关于部件的信息。
 * @property {PartInterfaces} [interfaces] - 部件提供的界面。
 * @property {function(Initargs_t): Promise<void>} [Init] - 初始化函数。
 * @property {function(Loadargs_t): Promise<void>} [Load] - 加载函数。
 * @property {function(UnloadArgs_t): Promise<void>} [Unload] - 卸载函数。
 * @property {function(UninstallArgs_t): Promise<void>} [Uninstall] - 卸载函数。
 */

/**
 * @typedef {Object} PartDetails
 * @property {PartInfo} info - 关于部件的本地化信息。
 * @property {string[]} supportedInterfaces - 支持的界面列表。
 */

/**
 * 一个存储已加载部件实例的对象。
 * @type {object}
 */
export const parts_set = {}

// ★ D1 修：worker isolate 的 part.Init per-isolate 门（in-memory，per username → { partpath: Promise }）。
//   磁盘 parts_init 是跨进程 install-once 记录；worker isolate 读它会跳过 part.Init → isolate 内 Init 承载的
//   runtime 态为空。worker 改用本表（每 isolate 各一份，随 isolate 隔离），保证 Init 每运行时初始化一次
//   （与 Load/parts_set 同 isolate 语义）。主进程仍走磁盘门 once-ever，行为不变；worker 不回写磁盘。
const _isolateInited = {}

const PARTS_BRANCH_CACHE_NAME = 'parts_branch_cache'

/**
 * 遍历指定目录下的所有 beilu-part.json。
 * @param {string} rootPath - 要扫描的根目录。
 * @returns {string[]} - beilu-part.json 的完整路径列表。
 */
function walkBeiluPartFiles(rootPath) {
	wbTrace(null, "parts", "walkBeiluPartFiles:enter", { rootPath })
	const files = []
	if (!fs.existsSync(rootPath)) {
		wbDetect(null, "parts", "walkBeiluPartFiles:root_missing", false, "扫描根目录不存在", { rootPath })
		return files
	}

	const stack = [rootPath]
	while (stack.length) {
		const current = stack.pop()
		let dirents = []
		try {
			dirents = fs.readdirSync(current, { withFileTypes: true })
		} catch (e) { wbDetect(null, "parts", "walkBeiluPartFiles:readdir_failed", false, "目录读取失败", { current, err: e?.message || String(e) }); continue }

		const _direntNames = []
		for (const dirent of dirents) {
			const fullPath = path.join(current, dirent.name)
			if (dirent.isDirectory())
				stack.push(fullPath)

			// beilu 自有部件清单统一 'beilu-part.json'。
			else if (dirent.isFile() && dirent.name === 'beilu-part.json') {
				files.push(fullPath)
				_direntNames.push(dirent.name)
			}
			else if (dirent.isFile())
				_direntNames.push(dirent.name)
		}
		// P0-4 告警：目录像 part（有 main.mjs）却无清单 → walk 枚举不到=潜在未注册 part（清单被删的事故征兆），打面板
		if (_direntNames.includes('main.mjs') && !_direntNames.includes('beilu-part.json'))
			wbDetect(null, "parts", "walkBeiluPartFiles:orphan_part_no_manifest", false, "目录有 main.mjs 但无 beilu-part.json 清单，part 树枚举不到", { dir: current })
	}

	wbTrace(null, "parts", "walkBeiluPartFiles:exit", { rootPath, count: files.length })
	return files
}

/**
 * 将路径片段合并到部件分支对象中。
 * @param {object} branches - 当前的分支对象。
 * @param {string[]} segments - 路径片段。
 */
function applyBranchSegments(branches, segments) {
	let cursor = branches
	for (const segment of segments) {
		if (!segment) continue
		cursor = cursor[segment] ??= {}
	}
}

/**
 * 将 beilu-part.json 的内容合并到部件分支对象中。
 * @param {object} branches - 当前的分支对象。
 * @param {string} filePath - beilu-part.json 路径。
 */
function mergeBeiluPartIntoBranches(branches, filePath) {
	try {
		const info = loadJsonFile(filePath)
		const type = info.type?.trim?.() || ''
		const dirname = info.dirname?.trim?.() || ''
		if (!dirname) {
			wbDetect(null, "parts", "mergeBeiluPart:no_dirname", false, "beilu-part.json 缺少 dirname", { path: filePath, type })
			return
		}
		const segments = [...type.split('/').filter(Boolean), dirname]
		applyBranchSegments(branches, segments)
	}
	catch (error) {
		wbDetect(null, "parts", "mergeBeiluPart:parse_failed", false, "beilu-part.json 解析失败", { path: filePath, err: error?.message || String(error) })
		console.warn(`Failed to parse beilu-part.json at ${filePath}: ${error.message}`)
	}
}

/**
 * 扫描公共与用户目录，构建部件分支对象。
 * @param {string} username - 用户名。
 * @returns {object} - 部件分支对象。
 */
function buildPartBranches(username) {
	wbTrace(null, "parts", "buildPartBranches:enter", { username })
	const branches = {}
	const roots = [
		path.join(__dirname, 'src/public/parts'),
		getUserDictionary(username),
	]

	for (const root of roots)
		for (const filePath of walkBeiluPartFiles(root))
			mergeBeiluPartIntoBranches(branches, filePath)

	wbTrace(null, "parts", "buildPartBranches:exit", { username, topKeys: Object.keys(branches) })
	return branches
}

/**
 * 使部件分支缓存失效。
 * @param {string} username - 用户名。
 */
function invalidatePartBranchesCache(username) {
	const cache = loadData(username, PARTS_BRANCH_CACHE_NAME)
	delete cache.branches
	delete cache.updatedAt
	saveData(username, PARTS_BRANCH_CACHE_NAME)
}

/**
 * 获取（并在需要时刷新）用户的部件分支结构。
 * @param {string} username - 用户名。
 * @param {{ nocache?: boolean }} [options] - 可选项。
 * @returns {object} - 部件分支对象。
 */
export function getPartBranches(username, { nocache = false } = {}) {
	const cache = loadData(username, PARTS_BRANCH_CACHE_NAME)
	if (!nocache && cache.branches) return cache.branches

	const branches = buildPartBranches(username)
	cache.branches = branches
	cache.updatedAt = Date.now()
	saveData(username, PARTS_BRANCH_CACHE_NAME)
	return branches
}

/**
 * 根据用户名和部件路径获取部件的路径。
 * 它首先检查用户特定的部件，然后回退到公共部件。
 *
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径（例如，'shells:chat'）。
 * @returns {string} 部件目录的路径。
 */
export function GetPartPath(username, partpath) {
	const userRoot = getUserDictionary(username);
	const userPath = path.join(userRoot, partpath);
	confinePath(userRoot, userPath);
	if (fs.existsSync(path.join(userPath, 'main.mjs')))
		return userPath
	const builtinRoot = path.join(__dirname, 'src', 'public', 'parts');
	const builtinPath = path.join(builtinRoot, partpath);
	confinePath(builtinRoot, builtinPath);
	return builtinPath
}

/**
 * 从给定路径动态 import 部件的 main.mjs 并返回其 default 导出。
 * beilu: 早期版本会在此处理 git 仓库更新，git.mjs 已删除，仅保留纯加载。
 *
 * @async
 * @param {string} path - 部件目录的路径。
 * @returns {Promise<Part>} 一个解析为加载的部件对象的承诺。
 */
export async function baseMjsPartLoader(path) {
	wbTrace(null, "parts", "baseMjsPartLoader:enter", { path })
	try {
		const mod = (await import(url.pathToFileURL(path + '/main.mjs'))).default
		wbTrace(null, "parts", "baseMjsPartLoader:exit", { path })
		return mod
	} catch (e) {
		// 缺 npm 包（便携 manual 模式下随包清单外的包,常见于用户自装插件）→ 自动补装后重试一次。
		// 补装域收口在 npmAutoInstall.mjs;识别不出/补装失败(离线) → 原有报错降级路径不变。
		// 重试 import 带 cache-busting 查询串:同 specifier 的失败解析可能被模块图缓存。
		const missingPkg = extractMissingNpmPackage(e)
		if (missingPkg && await ensureNpmPackage(missingPkg)) {
			try {
				const mod = (await import(url.pathToFileURL(path + '/main.mjs') + '?npmretry=' + Date.now())).default
				wbTrace(null, "parts", "baseMjsPartLoader:exit_after_npm_autoinstall", { path, missingPkg })
				return mod
			} catch (e2) { wbDetect(null, "parts", "baseMjsPartLoader:retry_failed", false, "补装后重试仍失败", { path, missingPkg, err: e2?.message || String(e2) }); diag.warn("补装后重试仍失败:", path, e2?.message); throw skip_report(e2) }
		}
		wbDetect(null, "parts", "baseMjsPartLoader:import_failed", false, "main.mjs 动态 import 失败", { path, err: e?.message || String(e) }); diag.warn("main.mjs import 失败:", path, e?.message); throw skip_report(e)
	}
}

/**
 * 检查部件当前是否已加载到内存中。
 *
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {boolean} 如果部件已加载则为 true，否则为 false。
 */
export function isPartLoaded(username, partpath) {
	return !!parts_set?.[username]?.[partpath]
}

/**
 * 加载部件的包装函数。处理记录调用和父部件加载等细节，然后调用 loadPartBase。
 *
 * @async
 * @template T
 * @template Initargs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {Initargs_t} Initargs - 传递给部件 Init 函数的初始化参数。
 * @param {Object} [functions] - 用于自定义加载和初始化过程的可选函数。
 * @param {() => string} [functions.pathGetter] - 获取部件路径的函数。
 * @param {(path: string, Initargs: Initargs_t) => Promise<T>} [functions.Loader] - 从路径加载部件的函数。默认为 baseMjsPartLoader 并调用 part.Load。
 * @param {(part: T) => void} [functions.afterLoad] - 部件加载后调用的函数。
 * @param {(path: string, Initargs: Initargs_t) => Promise<T>} [functions.Initer] - 从路径初始化部件的函数。默认为 baseMjsPartLoader 并调用 part.Init。
 * @param {(part: T) => void} [functions.afterInit] - 部件初始化后调用的函数。
 * @returns {Promise<FullProxy<T>>} 一个解析为加载和初始化的部件实例的 FullProxy 的承诺。
 */
// 并发门：同一 username:partpath 的 loadPart 在第一个 await 前同步存入 Promise，
// 后续同步进入的并发调用（如 150 条消息 × 17 插件的 Promise.all）直接 await 同一个 Promise。
const _loadPartInflight = new Map();
const _loadPartAttempts = new Map();
const _loadPartFailures = new Map();
const PART_LOAD_BACKOFF_BASE_MS = 500;
const PART_LOAD_BACKOFF_MAX_MS = 30_000;
const PART_LOAD_TRANSIENT_MAX_ATTEMPTS = 4;
const PART_LOAD_CIRCUIT_OPEN_MS = 5 * 60_000;
const PART_LOAD_OWNER_LEASE_MS = 3 * 60_000;
const PART_LOAD_OWNER_POLL_MS = 250;
const PART_LIFECYCLE_DEFAULT_DEADLINE_MS = 60_000;
const PART_UNLOAD_DEFAULT_DEADLINE_MS = 30_000;
const PART_LOADER_RUNTIME_DIRNAME = 'part-loader';
const PART_LOADER_RUNTIME_REVISION = sha256(`${process.pid}:${Math.trunc(Date.now() - process.uptime() * 1000)}`);
const PART_LOADER_ISOLATE_ID = `${process.pid}-${threadId}-${crypto.randomUUID()}`;
const PART_LOADER_ISOLATE_HEARTBEAT_MS = 2_000;
const PART_LOADER_ISOLATE_STALE_MS = 10_000;
const PART_LOADER_QUIESCE_ACK_RETENTION_MS = 60_000;
const _isolateQuiesceAcks = Object.create(null);
const DETERMINISTIC_PART_LOAD_CODES = new Set([
	'E_PART_CONFIG_APPLY', 'E_PART_CONFIG_LOAD_POLICY', 'E_PART_LOAD_ROLLBACK_FAILED',
	'E_PART_CONFIG_CONTRACT', 'E_PART_CONFIG_CONTRACT_CONFLICT',
	'E_PART_LOADER_POLICY',
	'E_PART_MODULE_INVALID', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'MODULE_NOT_FOUND',
]);
const TRANSIENT_PART_LOAD_CODES = new Set([
	'E_PART_LIFECYCLE_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
	'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
]);

const PART_LOADER_POLICY_BOUNDS = Object.freeze({
	backoff_base_ms: [100, 60_000],
	backoff_max_ms: [100, 10 * 60_000],
	transient_max_attempts: [1, 20],
	circuit_open_ms: [1_000, 60 * 60_000],
	lifecycle_deadline_ms: [1_000, 10 * 60_000],
	owner_lease_ms: [10_000, 30 * 60_000],
	isolate_stale_ms: [4_000, 5 * 60_000],
	user_quiesce_timeout_ms: [5_000, 10 * 60_000],
})

function readBoundedPolicyNumber(value, fallback, [minimum, maximum], key) {
	if (value === undefined || value === null || value === '') return fallback
	const number = Number(value)
	if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
		const error = new Error(`parts_loader_policy.${key} 必须是 ${minimum}..${maximum} 的整数，实际为 ${String(value)}`)
		error.code = 'E_PART_LOADER_POLICY'
		error.policyKey = key
		error.minimum = minimum
		error.maximum = maximum
		throw error
	}
	return number
}

function getPartLoaderPolicy() {
	const policy = config?.parts_loader_policy || {}
	const env = process.env
	const backoffBaseMs = readBoundedPolicyNumber(env.BEILU_PART_LOAD_BACKOFF_BASE_MS ?? policy.backoff_base_ms, PART_LOAD_BACKOFF_BASE_MS, PART_LOADER_POLICY_BOUNDS.backoff_base_ms, 'backoff_base_ms')
	const backoffMaxMs = readBoundedPolicyNumber(env.BEILU_PART_LOAD_BACKOFF_MAX_MS ?? policy.backoff_max_ms, PART_LOAD_BACKOFF_MAX_MS, PART_LOADER_POLICY_BOUNDS.backoff_max_ms, 'backoff_max_ms')
	if (backoffMaxMs < backoffBaseMs) {
		const error = new Error('parts_loader_policy.backoff_max_ms 不能小于 backoff_base_ms')
		error.code = 'E_PART_LOADER_POLICY'
		throw error
	}
	return {
		backoffBaseMs,
		backoffMaxMs,
		transientMaxAttempts: readBoundedPolicyNumber(env.BEILU_PART_LOAD_MAX_ATTEMPTS ?? policy.transient_max_attempts, PART_LOAD_TRANSIENT_MAX_ATTEMPTS, PART_LOADER_POLICY_BOUNDS.transient_max_attempts, 'transient_max_attempts'),
		circuitOpenMs: readBoundedPolicyNumber(env.BEILU_PART_LOAD_CIRCUIT_OPEN_MS ?? policy.circuit_open_ms, PART_LOAD_CIRCUIT_OPEN_MS, PART_LOADER_POLICY_BOUNDS.circuit_open_ms, 'circuit_open_ms'),
		ownerLeaseMs: readBoundedPolicyNumber(env.BEILU_PART_LOAD_OWNER_LEASE_MS ?? policy.owner_lease_ms, PART_LOAD_OWNER_LEASE_MS, PART_LOADER_POLICY_BOUNDS.owner_lease_ms, 'owner_lease_ms'),
		isolateStaleMs: readBoundedPolicyNumber(env.BEILU_PART_ISOLATE_STALE_MS ?? policy.isolate_stale_ms, PART_LOADER_ISOLATE_STALE_MS, PART_LOADER_POLICY_BOUNDS.isolate_stale_ms, 'isolate_stale_ms'),
		userQuiesceTimeoutMs: readBoundedPolicyNumber(env.BEILU_PART_USER_QUIESCE_TIMEOUT_MS ?? policy.user_quiesce_timeout_ms, PART_UNLOAD_DEFAULT_DEADLINE_MS, PART_LOADER_POLICY_BOUNDS.user_quiesce_timeout_ms, 'user_quiesce_timeout_ms'),
		lifecycleDeadlines: policy.lifecycle_deadlines_ms || {},
	}
}

/**
 * 计算连续加载失败后的有界指数退避时长。
 * 保持为纯函数，供静态断言覆盖；策略只按连续失败次数生效，不按具体插件写特例。
 */
export function calculatePartLoadBackoffMs(failureCount, baseMs = PART_LOAD_BACKOFF_BASE_MS, maxMs = PART_LOAD_BACKOFF_MAX_MS) {
	const failureNumber = Number(failureCount)
	const baseNumber = Number(baseMs)
	const maxNumber = Number(maxMs)
	const failures = Number.isFinite(failureNumber) ? Math.max(1, Math.trunc(failureNumber)) : 1
	const base = Number.isFinite(baseNumber) ? Math.max(1, Math.trunc(baseNumber)) : PART_LOAD_BACKOFF_BASE_MS
	const maximum = Number.isFinite(maxNumber) ? Math.max(base, Math.trunc(maxNumber)) : PART_LOAD_BACKOFF_MAX_MS
	return Math.min(maximum, base * (2 ** Math.min(failures - 1, 30)))
}

function getPartLoadKey(username, partpath) {
	return `${username}\0${partpath}`
}

function stableJson(value) {
	if (value === undefined) return 'undefined'
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function sha256(value) {
	return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function getPartLoaderRuntimeDir() {
	if (!data_path) {
		const error = new Error('部件加载协调目录尚未初始化')
		error.code = 'E_PART_LOAD_COORDINATION'
		throw error
	}
	const runtimeDir = path.join(data_path, 'runtime', PART_LOADER_RUNTIME_DIRNAME)
	fs.mkdirSync(runtimeDir, { recursive: true })
	return runtimeDir
}

function getPartStatePaths(username, partpath) {
	const runtimeDir = getPartLoaderRuntimeDir()
	const id = sha256(`${username}\0${partpath}`)
	return {
		failurePath: path.join(runtimeDir, `failure-${id}.json`),
		lockDir: path.join(runtimeDir, `owner-${id}.lock`),
		userStatePath: path.join(runtimeDir, `user-${sha256(username)}.json`),
	}
}

function readJsonState(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
	catch (error) {
		if (error?.code === 'ENOENT') return undefined
		const stateError = new Error(`读取部件加载协调状态失败: ${filePath}`)
		stateError.code = 'E_PART_LOAD_COORDINATION'
		stateError.cause = error
		throw stateError
	}
}

function writeJsonState(filePath, value) {
	try { nicerWriteFileSync(filePath, JSON.stringify(value, null, 2)) }
	catch (error) {
		const stateError = new Error(`写入部件加载协调状态失败: ${filePath}`)
		stateError.code = 'E_PART_LOAD_COORDINATION'
		stateError.cause = error
		throw stateError
	}
}

function unlinkState(filePath) {
	try { fs.unlinkSync(filePath) }
	catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function getUserLifecycleState(username) {
	const { userStatePath } = getPartStatePaths(username, '')
	return readJsonState(userStatePath) || { epoch: 0, blocked: false }
}

function setUserLifecycleBlocked(username, blocked, reason, context = {}) {
	const { userStatePath } = getPartStatePaths(username, '')
	const previous = readJsonState(userStatePath) || { epoch: 0 }
	const next = {
		username,
		epoch: Number(previous.epoch || 0) + 1,
		blocked: !!blocked,
		reason: reason || null,
		context,
		updatedAt: Date.now(),
	}
	writeJsonState(userStatePath, next)
	return next
}

const PART_REVISION_SOURCE_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '.json']
const PART_REVISION_IMPORT_PATTERN = /(?:\b(?:import|export)\s+(?:[^'"\r\n]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"]+)['"]/g

function resolvePartRevisionDependency(fromFile, specifier) {
	const cleanSpecifier = String(specifier).split(/[?#]/, 1)[0]
	let unresolved
	if (cleanSpecifier.startsWith('@beilu/')) unresolved = path.join(__dirname, 'src', cleanSpecifier.slice('@beilu/'.length))
	else if (cleanSpecifier.startsWith('./') || cleanSpecifier.startsWith('../')) unresolved = path.resolve(path.dirname(fromFile), cleanSpecifier)
	else if (cleanSpecifier.startsWith('file:')) {
		try { unresolved = url.fileURLToPath(cleanSpecifier) }
		catch { return undefined }
	}
	else return undefined
	for (const extension of PART_REVISION_SOURCE_EXTENSIONS) {
		const candidate = unresolved + extension
		try { if (fs.statSync(candidate).isFile()) return candidate }
		catch (error) { if (error?.code !== 'ENOENT') throw error }
	}
	for (const extension of PART_REVISION_SOURCE_EXTENSIONS.slice(1)) {
		const candidate = path.join(unresolved, `index${extension}`)
		try { if (fs.statSync(candidate).isFile()) return candidate }
		catch (error) { if (error?.code !== 'ENOENT') throw error }
	}
	return undefined
}

/**
 * 对入口、清单与所有可静态解析的本地 ESM 依赖做内容哈希。这样薄壳 re-export 的
 * YonBan 实现体变更也会改变 deterministic breaker revision，而不是只看 main.mjs 的 size/mtime。
 */
function getPartModuleRevision(username, partpath) {
	const partDirectory = GetPartPath(username, partpath)
	const entryPath = path.join(partDirectory, 'main.mjs')
	if (!fs.existsSync(entryPath)) return 'missing'
	const queue = [entryPath]
	const manifestPath = path.join(partDirectory, 'beilu-part.json')
	if (fs.existsSync(manifestPath)) queue.push(manifestPath)
	for (const dependencyState of ['deno.json', 'package.json', 'package-lock.json', 'deno.lock']) {
		const dependencyPath = path.join(__dirname, dependencyState)
		if (fs.existsSync(dependencyPath)) queue.push(dependencyPath)
	}
	const seen = new Set()
	const digest = crypto.createHash('sha256')
	while (queue.length) {
		const candidate = queue.pop()
		const realPath = fs.realpathSync(candidate)
		if (seen.has(realPath)) continue
		seen.add(realPath)
		const content = fs.readFileSync(realPath)
		digest.update(path.normalize(realPath)).update('\0').update(content).update('\0')
		if (!/\.(?:mjs|js|cjs|ts)$/i.test(realPath)) continue
		const source = content.toString('utf8')
		PART_REVISION_IMPORT_PATTERN.lastIndex = 0
		for (let match; (match = PART_REVISION_IMPORT_PATTERN.exec(source));) {
			const dependency = resolvePartRevisionDependency(realPath, match[1])
			if (dependency) queue.push(dependency)
		}
	}
	return digest.digest('hex')
}

function getPartRevision(username, partpath) {
	const partsConfig = loadData(username, 'parts_config')
	const hasStoredConfig = partsConfig != null && Object.prototype.hasOwnProperty.call(partsConfig, partpath)
	const moduleRevision = getPartModuleRevision(username, partpath)
	const configFingerprint = sha256(stableJson(hasStoredConfig ? partsConfig[partpath] : undefined))
	return {
		id: sha256(`${moduleRevision}\0${configFingerprint}`),
		configFingerprint,
		moduleRevision,
	}
}

function getOwnerCurrentPath(lockDir) {
	return path.join(lockDir, 'current.json')
}

function getOwnerLeasePath(lockDir, token) {
	return path.join(lockDir, `owner-${token}.json`)
}

function readOwnerFromLockDir(lockDir) {
	const current = readJsonState(getOwnerCurrentPath(lockDir))
	if (!current?.token) return undefined
	const owner = readJsonState(getOwnerLeasePath(lockDir, current.token))
	const confirmedCurrent = readJsonState(getOwnerCurrentPath(lockDir))
	return owner?.token === current.token && confirmedCurrent?.token === current.token ? owner : undefined
}

function cleanOwnerLockDirectory(lockDir) {
	for (const entry of fs.readdirSync(lockDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue
		if (
			entry.name === 'current.json' || entry.name === 'owner.json' ||
			/^owner-[a-z0-9-]+\.json$/i.test(entry.name) ||
			/^(?:current\.json|owner-[a-z0-9-]+\.json)\.tmp_\d+_\d+$/i.test(entry.name)
		)
			unlinkState(path.join(lockDir, entry.name))
	}
	fs.rmdirSync(lockDir)
}

function acquirePartLoadOwner(username, partpath, revision, policy) {
	const { lockDir } = getPartStatePaths(username, partpath)
	const token = crypto.randomUUID()
	for (let pass = 0; pass < 3; pass++) {
		try {
			fs.mkdirSync(lockDir)
			const owner = { token, username, partpath, revision: revision.id, pid: process.pid, leaseUntil: Date.now() + policy.ownerLeaseMs }
			writeJsonState(getOwnerLeasePath(lockDir, token), owner)
			writeJsonState(getOwnerCurrentPath(lockDir), { token })
			const committedOwner = readOwnerFromLockDir(lockDir)
			if (committedOwner?.token !== token) {
				const error = new Error(`部件 ${partpath} 的加载所有权在提交时已失效`)
				error.code = 'E_PART_LOAD_BUSY'
				error.suppressDuplicateNotification = true
				throw error
			}
			return { token, lockDir, owner }
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error
			const owner = readOwnerFromLockDir(lockDir)
			let ownerLeaseUntil = Number(owner?.leaseUntil || 0)
			if (!owner) {
				try { ownerLeaseUntil = fs.statSync(lockDir).mtimeMs + policy.ownerLeaseMs }
				catch (statError) { if (statError?.code === 'ENOENT') continue; throw statError }
			}
			if (ownerLeaseUntil <= Date.now()) {
				const staleDir = `${lockDir}.stale-${token}`
				try {
					fs.renameSync(lockDir, staleDir)
					const movedOwner = readOwnerFromLockDir(staleDir)
					// fencing：观测后到 rename 前若已有新 owner 接棒，绝不能继续当作旧锁回收并启动第二 owner。
					if ((movedOwner?.token || null) !== (owner?.token || null)) {
						try {
							fs.mkdirSync(lockDir)
							const fenceOwner = {
								token: `recovery-fence-${token}`, username, partpath, revision: revision.id,
								pid: process.pid, fence: true, leaseUntil: Date.now() + Math.max(1000, PART_LOAD_OWNER_POLL_MS * 4),
							}
							writeJsonState(getOwnerLeasePath(lockDir, fenceOwner.token), fenceOwner)
							writeJsonState(getOwnerCurrentPath(lockDir), { token: fenceOwner.token })
						} catch (fenceError) { if (fenceError?.code !== 'EEXIST') throw fenceError }
						cleanOwnerLockDirectory(staleDir)
						const fenced = new Error(`部件 ${partpath} 的旧锁回收检测到 owner 已换代，本轮已由 fencing 阻断`)
						fenced.code = 'E_PART_LOAD_BUSY'
						fenced.retryable = true
						fenced.suppressDuplicateNotification = true
						throw fenced
					}
					cleanOwnerLockDirectory(staleDir)
					continue
				} catch (reclaimError) {
					if (reclaimError?.code === 'ENOENT' || reclaimError?.code === 'EEXIST') continue
					throw reclaimError
				}
			}
			const busy = new Error(`部件 ${partpath} 正由另一个运行隔离区加载`)
			busy.code = 'E_PART_LOAD_BUSY'
			busy.retryable = true
			busy.retryAfterMs = Math.max(1, ownerLeaseUntil - Date.now())
			busy.suppressDuplicateNotification = true
			throw busy
		}
	}
	const error = new Error(`无法取得部件 ${partpath} 的跨隔离区加载所有权`)
	error.code = 'E_PART_LOAD_COORDINATION'
	throw error
}

function readPartLoadOwner(attempt) {
	return readOwnerFromLockDir(attempt.owner.lockDir)
}

function renewPartLoadOwner(attempt) {
	const owner = readPartLoadOwner(attempt)
	if (!owner || owner.token !== attempt.owner.token) return false
	owner.leaseUntil = Date.now() + attempt.policy.ownerLeaseMs
	// 续租只写 token 专属文件，绝不覆盖 current fencing 指针；旧 owner 迟到也不能夺回新 owner。
	writeJsonState(getOwnerLeasePath(attempt.owner.lockDir, attempt.owner.token), owner)
	return readJsonState(getOwnerCurrentPath(attempt.owner.lockDir))?.token === attempt.owner.token
}

function releasePartLoadOwner(attempt) {
	if (!attempt?.owner || attempt.ownerReleased) return
	attempt.ownerReleased = true
	try {
		const observed = readOwnerFromLockDir(attempt.owner.lockDir)
		if (observed?.token !== attempt.owner.token) return
		const releaseDir = `${attempt.owner.lockDir}.release-${attempt.owner.token}`
		fs.renameSync(attempt.owner.lockDir, releaseDir)
		const movedOwner = readOwnerFromLockDir(releaseDir)
		if (movedOwner?.token !== attempt.owner.token) {
			// 释放前 owner 已换代：不删除稳定路径的新 owner；被误移动的 owner 由 fencing 迫使取消。
			try {
				fs.mkdirSync(attempt.owner.lockDir)
				const fenceToken = `recovery-fence-${crypto.randomUUID()}`
				const fenceOwner = {
					token: fenceToken, username: attempt.username, partpath: attempt.partpath,
					revision: attempt.revision.id, pid: process.pid, fence: true,
					leaseUntil: Date.now() + Math.max(1000, PART_LOAD_OWNER_POLL_MS * 4),
				}
				writeJsonState(getOwnerLeasePath(attempt.owner.lockDir, fenceToken), fenceOwner)
				writeJsonState(getOwnerCurrentPath(attempt.owner.lockDir), { token: fenceToken })
			} catch (fenceError) { if (fenceError?.code !== 'EEXIST') throw fenceError }
			cleanOwnerLockDirectory(releaseDir)
			return
		}
		cleanOwnerLockDirectory(releaseDir)
	} catch (error) {
		if (error?.code !== 'ENOENT') wbDetect(null, 'parts', 'loadPart:owner_release_failed', false, '释放部件加载所有权失败', { username: attempt.username, partpath: attempt.partpath, err: error?.message || String(error) })
	}
}

function createPartLoadAttempt(username, partpath) {
	const policy = getPartLoaderPolicy()
	const revision = getPartRevision(username, partpath)
	assertPartLoadRetryAllowed(username, partpath, Date.now(), revision)
	const userState = getUserLifecycleState(username)
	if (userState.blocked) {
		const error = new Error(`用户 ${username} 正在执行 ${userState.reason || '账户变更'}，拒绝启动新部件生命周期`)
		error.code = 'E_PART_USER_QUIESCING'
		error.suppressDuplicateNotification = true
		throw error
	}
	const attempt = {
		username, partpath, revision, policy, userEpoch: Number(userState.epoch || 0),
		controller: new AbortController(), hooks: new Set(), owner: null, ownerReleased: false,
	}
	attempt.owner = acquirePartLoadOwner(username, partpath, revision, policy)
	attempt.leaseTimer = setInterval(() => {
		try { if (!renewPartLoadOwner(attempt)) attempt.controller.abort(createPartAttemptInvalidError(attempt, '加载所有权已失效')) }
		catch (error) { attempt.controller.abort(error) }
	}, Math.max(1000, Math.trunc(policy.ownerLeaseMs / 3)))
	attempt.leaseTimer.unref?.()
	return attempt
}

function createPartAttemptInvalidError(attempt, detail) {
	const error = new Error(`部件 ${attempt.partpath} 生命周期已取消: ${detail}`)
	error.code = 'E_PART_LOAD_CANCELLED'
	error.suppressDuplicateNotification = true
	return error
}

function assertPartAttemptCurrent(attempt, { renew = false } = {}) {
	if (!attempt) return
	if (attempt.controller.signal.aborted) throw attempt.controller.signal.reason || createPartAttemptInvalidError(attempt, '已取消')
	const owner = readPartLoadOwner(attempt)
	if (!owner || owner.token !== attempt.owner.token) throw createPartAttemptInvalidError(attempt, '加载所有权已转移')
	const userState = getUserLifecycleState(attempt.username)
	if (userState.blocked || Number(userState.epoch || 0) !== attempt.userEpoch)
		throw createPartAttemptInvalidError(attempt, '用户生命周期已变更')
	const currentRevision = getPartRevision(attempt.username, attempt.partpath)
	if (currentRevision.id !== attempt.revision.id) {
		const error = createPartAttemptInvalidError(attempt, '配置或代码 revision 已变更')
		error.code = 'E_PART_LOAD_REVISION_CHANGED'
		error.retryable = true
		throw error
	}
	if (renew && !renewPartLoadOwner(attempt)) throw createPartAttemptInvalidError(attempt, '提交前续租 fencing 校验失败')
}

function finalizePartLoadAttempt(attempt) {
	if (!attempt) return
	if (!attempt.hooks.size) {
		clearInterval(attempt.leaseTimer)
		return releasePartLoadOwner(attempt)
	}
	// 超时只结束调用方等待，不代表 hook 已停止。只要原 hook 或迟到回收仍未真实 settled，
	// owner 必须持续续租；否则 lease 到期被新 owner 回收，会与忽略 AbortSignal 的旧 hook 并行产生副作用。
	Promise.allSettled([...attempt.hooks]).finally(() => {
		clearInterval(attempt.leaseTimer)
		releasePartLoadOwner(attempt)
	})
}

function getLifecycleDeadlines(overrides = {}) {
	const policy = getPartLoaderPolicy()
	const configured = policy.lifecycleDeadlines
	const resolve = (stage, fallback) => readBoundedPolicyNumber(
		overrides[stage] ?? process.env[`BEILU_PART_${stage.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_TIMEOUT_MS`] ?? configured[stage],
		fallback,
		PART_LOADER_POLICY_BOUNDS.lifecycle_deadline_ms,
		`lifecycle_deadlines_ms.${stage}`,
	)
	return {
		Init: resolve('Init', PART_LIFECYCLE_DEFAULT_DEADLINE_MS),
		Load: resolve('Load', PART_LIFECYCLE_DEFAULT_DEADLINE_MS),
		SetData: resolve('SetData', PART_LIFECYCLE_DEFAULT_DEADLINE_MS),
		afterInit: resolve('afterInit', PART_LIFECYCLE_DEFAULT_DEADLINE_MS),
		afterLoad: resolve('afterLoad', PART_LIFECYCLE_DEFAULT_DEADLINE_MS),
		Unload: resolve('Unload', PART_UNLOAD_DEFAULT_DEADLINE_MS),
	}
}

async function runCleanupWithDeadline(stage, timeoutMs, invoke) {
	const controller = new AbortController()
	let timeoutHandle
	const timeoutPromise = new Promise((_, reject) => {
		timeoutHandle = setTimeout(() => {
			const error = new Error(`部件清理阶段 ${stage} 超过 ${timeoutMs}ms`)
			error.code = 'E_PART_UNLOAD_TIMEOUT'
			error.stage = stage
			error.timeoutMs = timeoutMs
			controller.abort(error)
			reject(error)
		}, timeoutMs)
		timeoutHandle.unref?.()
	})
	const work = Promise.resolve().then(() => invoke(controller.signal))
	work.catch(() => {})
	try { return await Promise.race([work, timeoutPromise]) }
	finally { clearTimeout(timeoutHandle) }
}

async function runLifecycleStage(attempt, stage, timeoutMs, invoke, { onLateFulfilled, onLateSettled } = {}) {
	assertPartAttemptCurrent(attempt)
	let settled = false
	const hookPromise = Promise.resolve().then(invoke)
	attempt?.hooks.add(hookPromise)
	hookPromise.then(
		value => { settled = true; attempt?.hooks.delete(hookPromise); return value },
		() => { settled = true; attempt?.hooks.delete(hookPromise) },
	)
	let timeoutHandle
	let pollHandle
	let abortHandler
	const guardPromise = new Promise((_, reject) => {
		const rejectOnce = error => { if (!settled) reject(error) }
		timeoutHandle = setTimeout(() => {
			const error = new Error(`部件 ${attempt?.partpath || '(unknown)'} 生命周期阶段 ${stage} 超过 ${timeoutMs}ms`)
			error.code = 'E_PART_LIFECYCLE_TIMEOUT'
			error.stage = stage
			error.timeoutMs = timeoutMs
			error.retryable = true
			attempt?.controller.abort(error)
			rejectOnce(error)
		}, timeoutMs)
		timeoutHandle.unref?.()
		abortHandler = () => rejectOnce(attempt.controller.signal.reason || createPartAttemptInvalidError(attempt, '已取消'))
		attempt?.controller.signal.addEventListener('abort', abortHandler, { once: true })
		pollHandle = setInterval(() => {
			try { assertPartAttemptCurrent(attempt) }
			catch (error) { attempt?.controller.abort(error); rejectOnce(error) }
		}, PART_LOAD_OWNER_POLL_MS)
		pollHandle.unref?.()
	})
	try {
		return await Promise.race([hookPromise, guardPromise])
	} catch (error) {
		// 只有 guard（超时/取消/revision/owner fencing）先赢且原 hook 尚未 settled，才是“迟到”。
		// hook 自身正常抛错由外层单次 rollback 处理，不能在这里重复卸载。
		if (!settled && (typeof onLateSettled === 'function' || typeof onLateFulfilled === 'function')) {
			const lateCleanup = typeof onLateSettled === 'function'
				? onLateSettled
				: outcome => outcome.status === 'fulfilled' ? onLateFulfilled(outcome.value) : undefined
			const lateCleanupPromise = hookPromise.then(
				value => lateCleanup({ status: 'fulfilled', value }),
				reason => lateCleanup({ status: 'rejected', reason }),
			)
			attempt?.hooks.add(lateCleanupPromise)
			lateCleanupPromise.then(
				() => attempt?.hooks.delete(lateCleanupPromise),
				cleanupError => {
					attempt?.hooks.delete(lateCleanupPromise)
					wbDetect(null, 'parts', 'loadPart:late_cleanup_failed', false, '超时钩子迟到后的回收失败', { username: attempt?.username, partpath: attempt?.partpath, stage, err: cleanupError?.message || String(cleanupError) })
				},
			)
		}
		throw error
	} finally {
		clearTimeout(timeoutHandle)
		clearInterval(pollHandle)
		attempt?.controller.signal.removeEventListener('abort', abortHandler)
	}
}

function summarizePartLoadCause(error) {
	return {
		name: error?.name || 'Error',
		code: error?.code || 'E_PART_LOAD_FAILED',
		message: error?.message || String(error),
	}
}

function classifyPartLoadFailure(error) {
	if (error?.manualRecoveryRequired || error?.code === 'E_PART_LOAD_ROLLBACK_FAILED') return 'manual-recovery'
	if (error instanceof SyntaxError || DETERMINISTIC_PART_LOAD_CODES.has(error?.code)) return 'deterministic'
	if (TRANSIENT_PART_LOAD_CODES.has(error?.code)) return 'transient'
	return 'transient'
}

function isPartLoadControlError(error) {
	return new Set([
		'E_PART_LOAD_BACKOFF', 'E_PART_LOAD_BLOCKED', 'E_PART_LOAD_BUSY',
		'E_PART_USER_QUIESCING', 'E_PART_LOAD_CANCELLED', 'E_PART_LOAD_REVISION_CHANGED',
	]).has(error?.code)
}

function markPartLoadFailure(username, partpath, error, attempt = _loadPartAttempts.get(getPartLoadKey(username, partpath))) {
	if (isPartLoadControlError(error) || error?.partFailureRecorded) return
	const revision = attempt?.revision || getPartRevision(username, partpath)
	const key = getPartLoadKey(username, partpath)
	const { failurePath } = getPartStatePaths(username, partpath)
	const persisted = readJsonState(failurePath)
	const previous = persisted?.revision === revision.id ? persisted : undefined
	const failures = (previous?.failures || 0) + 1
	const classification = classifyPartLoadFailure(error)
	const policy = getPartLoaderPolicy()
	const backoffMs = classification === 'transient'
		? (failures >= policy.transientMaxAttempts ? policy.circuitOpenMs : calculatePartLoadBackoffMs(failures, policy.backoffBaseMs, policy.backoffMaxMs))
		: null
	const lastCause = summarizePartLoadCause(error)
	const state = {
		username, partpath, revision: revision.id, configFingerprint: revision.configFingerprint,
		moduleRevision: revision.moduleRevision, runtimeRevision: PART_LOADER_RUNTIME_REVISION, failures, classification,
		nextRetryAt: backoffMs == null ? null : Date.now() + backoffMs,
		lastCause, updatedAt: Date.now(),
	}
	_loadPartFailures.set(key, { ...state, lastError: error })
	writeJsonState(failurePath, state)
	if (error && (typeof error === 'object' || typeof error === 'function'))
		Object.defineProperty(error, 'partFailureRecorded', { value: true, configurable: true })
	wbDetect(null, 'parts', 'loadPart:failure_state_armed', false, '部件真实加载失败，已进入 revision 感知的失败状态', {
		username, partpath, failures, classification, backoffMs, causeCode: lastCause.code, err: lastCause.message,
	})
	try {
		const partsDetailsCache = loadData(username, 'parts_details_cache')
		delete partsDetailsCache[partpath]
		saveData(username, 'parts_details_cache')
	} catch (cacheError) {
		wbDetect(null, 'parts', 'loadPart:details_cache_invalidate_failed', false, '加载失败后详情缓存清理失败', { username, partpath, err: cacheError?.message || String(cacheError) })
	}
	const statusEntry = reportPluginStatus(username, partpath, 'load-error', { detail: lastCause.message, code: lastCause.code, classification })
	sendEventToUser(username, 'part-load-error', { partpath, status: 'load-error', detail: lastCause.message, code: lastCause.code, classification, occurrenceId: statusEntry.occurrenceId, revision: statusEntry.revision })
}

function clearPartLoadFailure(username, partpath, attempt) {
	_loadPartFailures.delete(getPartLoadKey(username, partpath))
	const { failurePath } = getPartStatePaths(username, partpath)
	const persisted = readJsonState(failurePath)
	if (!persisted || !attempt || persisted.revision === attempt.revision.id) unlinkState(failurePath)
}

function clearPartLoadFailuresForUser(username) {
	const prefix = `${username}\0`
	for (const key of _loadPartFailures.keys())
		if (key.startsWith(prefix)) _loadPartFailures.delete(key)
	const runtimeDir = getPartLoaderRuntimeDir()
	for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
		if (!entry.isFile() || !/^failure-[a-f0-9]{64}\.json$/i.test(entry.name)) continue
		const failurePath = path.join(runtimeDir, entry.name)
		const state = readJsonState(failurePath)
		if (state?.username === username) unlinkState(failurePath)
	}
}

function clearPersistentUserLifecycleState(username) {
	clearPartLoadFailuresForUser(username)
	const { userStatePath } = getPartStatePaths(username, '')
	unlinkState(userStatePath)
	const runtimeDir = getPartLoaderRuntimeDir()
	for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^owner-[a-f0-9]{64}\.lock$/i.test(entry.name)) continue
		const lockDir = path.join(runtimeDir, entry.name)
		const owner = readOwnerFromLockDir(lockDir)
		if (owner?.username !== username) continue
		if (Number(owner.leaseUntil || 0) > Date.now()) {
			const error = new Error(`用户 ${username} 仍有活跃部件 owner，拒绝清除生命周期状态`)
			error.code = 'E_PART_USER_STATE_CLEANUP_ACTIVE_OWNER'
			error.partpath = owner.partpath
			throw error
		}
		cleanOwnerLockDirectory(lockDir)
	}
	delete _isolateQuiesceAcks[username]
}

function assertPartLoadRetryAllowed(username, partpath, now = Date.now(), revision = getPartRevision(username, partpath)) {
	const key = getPartLoadKey(username, partpath)
	const { failurePath } = getPartStatePaths(username, partpath)
	let state = readJsonState(failurePath) || _loadPartFailures.get(key)
	if (!state) return
	if (state.classification === 'manual-recovery' && state.runtimeRevision !== PART_LOADER_RUNTIME_REVISION) {
		_loadPartFailures.delete(key)
		unlinkState(failurePath)
		return
	}
	if (state.classification !== 'manual-recovery' && state.revision !== revision.id) {
		_loadPartFailures.delete(key)
		unlinkState(failurePath)
		return
	}
	_loadPartFailures.set(key, state)
	const blockedByRevision = state.classification === 'deterministic' || state.classification === 'manual-recovery'
	const retryAfterMs = blockedByRevision ? null : Math.max(0, Math.ceil(Number(state.nextRetryAt || 0) - now))
	if (!blockedByRevision && !retryAfterMs) return
	const error = new Error(blockedByRevision
		? (state.classification === 'manual-recovery'
			? `部件 ${partpath} 上次加载的回滚清理不完整，需重启运行时或人工清理后再试`
			: `部件 ${partpath} 的当前配置/代码 revision 已被熔断，需变更配置或代码后再试`)
		: `部件 ${partpath} 暂处于加载退避期，请在 ${retryAfterMs}ms 后重试`)
	error.name = blockedByRevision ? 'PartLoadBlockedError' : 'PartLoadBackoffError'
	error.code = blockedByRevision ? 'E_PART_LOAD_BLOCKED' : 'E_PART_LOAD_BACKOFF'
	error.retryable = !blockedByRevision
	error.retryAfterMs = retryAfterMs
	error.failureCount = state.failures
	error.username = username
	error.partpath = partpath
	error.lastCause = state.lastCause
	Object.defineProperty(error, 'cause', { value: state.lastError, enumerable: false })
	// 消费端可据此避免把同一真实失败在冷却期重复推送；原始失败本身不会带此标记。
	error.suppressDuplicateNotification = true
	throw error
}

export async function loadPart(username, partpath, Initargs, functions) {
	// 缓存命中前置：已完整加载（非 Promise）的部件直接返回，跳过递归和 fs 调用
	if (isPartLoaded(username, partpath) && !(parts_set[username][partpath] instanceof Promise)) {
		if (isRecordingLoadPartCalls) loadPartCallRecords.add(`${username}:${partpath}`)
		parts_load_results[username] ??= {}
		return parts_load_results[username][partpath] ??= new FullProxy(() => parts_set[username][partpath])
	}
	// 并发门：同 key 已有 in-flight 加载 → await 它（同步检查，在任何 await 之前）
	const _lfKey = getPartLoadKey(username, partpath);
	if (_loadPartInflight.has(_lfKey)) {
		return _loadPartInflight.get(_lfKey);
	}
	// 首次加载：trace
	wbTrace(null, "parts", "loadPart:enter", { username, partpath })
	diag.debug("loadPart:", username, partpath)
	// 标记本次顶层尝试的所有权：其内部即使经父容器调用 loadPartBase，也只由这里登记一次失败。
	const _lfAttempt = createPartLoadAttempt(username, partpath)
	_loadPartAttempts.set(_lfKey, _lfAttempt)
	// 同步存入 Promise（必须在第一个 await 之前，否则同微任务的并发调用看不到）
	const _lfPromise = _doLoadPart(username, partpath, Initargs, functions);
	_loadPartInflight.set(_lfKey, _lfPromise);
	try {
		const loaded = await _lfPromise;
		assertPartAttemptCurrent(_lfAttempt, { renew: true })
		clearPartLoadFailure(username, partpath, _lfAttempt)
		return loaded;
	} catch (error) {
		markPartLoadFailure(username, partpath, error, _lfAttempt)
		throw error
	} finally {
		_loadPartInflight.delete(_lfKey);
		if (_loadPartAttempts.get(_lfKey) === _lfAttempt) _loadPartAttempts.delete(_lfKey)
		finalizePartLoadAttempt(_lfAttempt)
	}
}
async function _doLoadPart(username, partpath, Initargs, functions) {
	// 记录loadPart调用
	if (isRecordingLoadPartCalls) loadPartCallRecords.add(`${username}:${partpath}`)

	// 支持层级化加载
	const parentPath = path.dirname(partpath)
	const partname = path.basename(partpath)
	if (parentPath !== '.' && parentPath !== '/' && fs.existsSync(GetPartPath(username, parentPath) + '/main.mjs')) {
		let parentPart
		try {
			parentPart = await loadPart(username, parentPath)
		} catch (e) {
			// 不能因父生命周期失败而绕开其参数、路由及 afterLoad 契约。模块若声明 loadSubPart，
			// 即视为父容器已接管，原始失败必须向上游传播；仅无声明的普通目录允许子路径直载。
			let declaredPartsInterface
			try { declaredPartsInterface = (await baseMjsPartLoader(GetPartPath(username, parentPath)))?.interfaces?.parts }
			catch { /* 原始父错误更有诊断价值 */ }
			if (typeof declaredPartsInterface?.loadSubPart === 'function') throw e
			wbDetect(null, "parts", "loadPart:parent_load_failed_no_delegation", false, "父部件加载失败且未声明子部件接管，子部件尝试直载", { partpath, parentPath, err: e?.message || String(e) })
			diag.warn("非容器父部件加载失败:", parentPath, "for", partpath, e?.message)
			logWarn("parts", "Non-container parent part load failed: " + parentPath + " — " + (e?.message || String(e)))
		}
		const partsInterface = parentPart?.interfaces?.parts
		if (typeof partsInterface?.loadSubPart === 'function') {
			const pathGetter = functions?.pathGetter || (() => GetPartPath(username, partpath))
			const initialPaths = [pathGetter()]
			const my_paths = typeof partsInterface.getSubPartsInstallPaths === 'function'
				? partsInterface.getSubPartsInstallPaths(initialPaths)
				: initialPaths
			// 父容器已经接管子加载后，任何 reject 都是该子加载的真实失败，必须原样上抛。
			// 只有显式返回空结果才表示“未接管”，此时才允许走下方直载。
			const subPart = await partsInterface.loadSubPart(my_paths, username, partname)
			if (subPart) return subPart
			wbTrace(null, "parts", "loadPart:parent_declined_subpart", { username, partpath, parentPath })
		}
	}

	return await loadPartBase(username, partpath, Initargs, functions)
}

/**
 * getPartListBase 的公开别名（见本文件 getPartListBase 定义）。
 */
export const getPartList = getPartListBase

/**
 * 卸载部件的包装函数。处理父部件卸载等细节，然后调用 unloadPartBase。
 *
 * @async
 * @template T
 * @template UnloadArgs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {UnloadArgs_t} unLoadargs - 传递给部件 Unload 函数的参数。
 * @param {Object} [options] - 用于自定义卸载过程的可选函数。
 * @param {() => string} [options.pathGetter] - 获取部件路径的函数。
 * @param {(part: T) => Promise<void>} [options.unLoader] - 卸载部件的函数。默认为调用 part.Unload。
 * @param {(path: string, unLoadargs: UnloadArgs_t) => Promise<void>} [options.afterUnload] - 卸载后调用的函数。
 * @returns {Promise<void>} 一个在部件卸载后解析的承诺。
 */
export async function unloadPart(username, partpath, unLoadargs, options) {
	diag.debug("unloadPart:", username, partpath)
	const loadKey = getPartLoadKey(username, partpath)
	const activeAttempt = _loadPartAttempts.get(loadKey)
	if (activeAttempt && !activeAttempt.controller.signal.aborted)
		activeAttempt.controller.abort(createPartAttemptInvalidError(activeAttempt, '收到卸载请求'))
	const pending = _loadPartInflight.get(loadKey) || (parts_set[username]?.[partpath] instanceof Promise ? parts_set[username][partpath] : null)
	if (pending) {
		const unloadDeadline = getLifecycleDeadlines(options?.lifecycleDeadlines).Unload
		try { await runCleanupWithDeadline('await-inflight', unloadDeadline, () => pending) }
		catch (error) {
			if (error?.code === 'E_PART_LOAD_ROLLBACK_FAILED' || error?.manualRecoveryRequired) throw error
			if (error?.code === 'E_PART_UNLOAD_TIMEOUT') throw error
			// 已取消/已正常回滚的加载没有可卸载实例，继续检查 parts_set 真值。
		}
	}
	// 尝试委托给父部件
	const parentPath = path.dirname(partpath)
	const partname = path.basename(partpath)
	if (parentPath !== '.' && parentPath !== '/' && isPartLoaded(username, parentPath)) {
		const parentPart = await loadPart(username, parentPath)
		if (typeof parentPart?.interfaces?.parts?.unloadSubPart === 'function') {
			const pathGetter = options?.pathGetter || (() => GetPartPath(username, partpath))
			await parentPart.interfaces.parts.unloadSubPart([pathGetter()], username, partname)
			return
			}
	}

	return await unloadPartBase(username, partpath, unLoadargs, options)
}

/**
 * 获取已加载的部件列表。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 可选的父部件路径，用于过滤。
 * @returns {string[]} 已加载部件路径的数组。
 */
export function getLoadedPartList(username, partpath) {
	if (!parts_set[username]) return []
	const loadedParts = Object.keys(parts_set[username])
	if (!partpath) return loadedParts
	const prefix = partpath + '/'
	return loadedParts.filter(path => path === partpath || path.startsWith(prefix))
}

/**
 * 重新加载一个部件。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {Promise<any>} 一个解析为重新加载的部件实例的承诺。
 */
export async function reloadPart(username, partpath) {
	setTimeout(restartor, 1000).unref() // 我们将重新启动整个服务器，因为 deno 不支持单个 js 文件的热重载
	/*
	await unloadPartBase(username, partpath)
	return await loadPartBase(username, partpath)
	*/
}

/**
 * 加载部件的基本函数，使用提供的或默认的路径获取器和加载器。
 * 如果部件已加载，则返回现有实例。
 *
 * @async
 * @template T
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {Object} [options] - 加载的可选配置。
 * @param {() => string} [options.pathGetter] - 获取部件路径的函数。
 * @param {(path: string) => Promise<T>} [options.Loader=baseMjsPartLoader] - 从路径加载部件的函数。
 * @returns {Promise<T>} 一个解析为加载的部件实例的承诺。
 */
export async function baseloadPart(username, partpath, {
	pathGetter = () => GetPartPath(username, partpath),
	Loader = baseMjsPartLoader,
} = {}) {
	// 已加载时跳过 trace，与 loadPart:enter / loadPartBase:enter 同策略
	if (!isPartLoaded(username, partpath))
		wbTrace(null, "parts", "baseloadPart:enter", { username, partpath })
	if (isPartLoaded(username, partpath)) return parts_set[username][partpath]
	const path = pathGetter()

	// beilu: git自动更新已移除（git.mjs已删除）
	if (fs.existsSync(path + '/.isdefault')) {
		// P0-3 容错：默认部件 beilu-part.json 缺/坏不应崩启动。包 try/catch——失败则跳过模板同步 + 告警，
		// 部件仍走下方 Loader(path) 正常加载（旧版裸 loadJsonFile 抛错冒泡 → 整启动/该 part 加载崩）。
		try {
			// 默认组件更新：在载入前自 __dirname + '/default/templates/user/' + partpath 同步文件
			const userPath = path
			const _manifestName = 'beilu-part.json'; wbTrace(null, "parts", "baseloadPart:isdefault_read_manifest", { partpath, manifest: userPath + '/' + _manifestName, exists: fs.existsSync(userPath + '/' + _manifestName) })
			wbDetect(null, "parts", "baseloadPart:isdefault_manifest_missing", fs.existsSync(userPath + '/' + _manifestName), ".isdefault 分支清单不存在（将跳过模板同步）", { partpath, manifest: userPath + '/' + _manifestName })
			const { type, dirname } = loadJsonFile(userPath + '/' + _manifestName)
			const templatePath = __dirname + '/default/templates/user/' + type + '/' + dirname
			/**
			 * 递归地将文件从模板目录映射到用户目录。
			 * @param {string} fileOrDir - 要映射的文件或目录。
			 */
			function mapper(fileOrDir) {
				if (fs.statSync(templatePath + '/' + fileOrDir).isDirectory()) {
					if (!fs.existsSync(userPath + '/' + fileOrDir))
						fs.mkdirSync(userPath + '/' + fileOrDir, { recursive: true })
					fs.readdirSync(templatePath + '/' + fileOrDir).forEach(path => mapper(fileOrDir + '/' + path))
				}
				else
					nicerWriteFileSync(userPath + '/' + fileOrDir, fs.readFileSync(templatePath + '/' + fileOrDir))
			}
			fs.readdirSync(templatePath).forEach(mapper)
		} catch (e) {
			wbDetect(null, "parts", "baseloadPart:isdefault_sync_skipped", false, "默认部件 beilu-part.json 缺/坏，跳过模板同步（不崩启动，部件仍尝试 Loader 加载）", { partpath, err: e?.message || String(e) })
		}
	}
	return await Promise.resolve(Loader(path)).catch(e => {
		wbDetect(null, "parts", "baseloadPart:loader_failed", false, "部件 Loader 加载失败", { partpath, path, err: e?.message || String(e) })
		throw e
	})
}

const STARTUP_PRESET_PARTPATH = 'plugins/beilu-preset'

/**
 * 启动核心只来自用户现有默认配置：全部默认角色卡，以及已明确启用的 canonical 预设引擎。
 * 不从已安装插件全集、显示名称或标签推断，避免引入第二套 priority/dependency 规则。
 */
function getStartupCorePartpaths(defaultParts) {
	const corePartpaths = new Set()
	for (const charname of defaultParts?.chars ?? [])
		corePartpaths.add('chars/' + charname)
	if (defaultParts?.plugins?.includes(path.basename(STARTUP_PRESET_PARTPATH)))
		corePartpaths.add(STARTUP_PRESET_PARTPATH)
	return corePartpaths
}

function throwStartupCoreFailures(username, results) {
	const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
	if (!failures.length) return
	if (failures.length === 1) throw failures[0]
	const error = new AggregateError(failures, `用户 ${username} 的 ${failures.length} 个启动核心部件加载失败`)
	error.code = 'E_STARTUP_CORE_PARTS_FAILED'
	throw error
}

/**
 * 浅加载所有的默认部件，以此实现默认部件的快速启动
 * @param {object | string} user - 用户对象或用户名。
 * @returns {Promise<void>}
 */
async function shallowLoadDefaultPartsForUser(user) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const defaultParts = user.defaultParts ??= {}
	wbTrace(null, "startup", "shallowLoadDefaultParts:user", { username: user.username, parents: Object.keys(defaultParts) })
	const loadTasks = []
	for (const parent in defaultParts)
		for (const child of [...(defaultParts[parent] ?? [])]) {
			const partpath = parent + '/' + child
			if (!fs.existsSync(GetPartPath(user.username, partpath) + '/main.mjs')) {
				wbDetect(null, "startup", "shallowLoadDefaultParts:stale_entry_removed", false, "defaultParts 条目目录不存在，已自动清理", { username: user.username, partpath })
				unsetDefaultPart(user, parent, child)
				continue
			}
			loadTasks.push(
				baseloadPart(user.username, partpath).catch(e => {
					wbDetect(null, "startup", "shallowLoadDefaultParts:load_failed", false, "默认部件浅加载失败", { username: user.username, partpath, err: e?.message || String(e) })
					const statusEntry = reportPluginStatus(user.username, partpath, "shallow-load-error", e?.message || String(e))
					sendEventToUser(user.username, "part-load-error", { partpath, status: "shallow-load-error", detail: e?.message || String(e), occurrenceId: statusEntry.occurrenceId, revision: statusEntry.revision })
					return 0
				})
			)
		}
	await Promise.allSettled(loadTasks)
}
/**
 * 浅加载所有用户的默认部件，以此实现默认部件的快速启动
 * @returns {Promise<void>}
 */
export async function shallowLoadAllDefaultParts() {
	for (const user of Object.values(getAllUsers())) await shallowLoadDefaultPartsForUser(user)
}

/**
 * 完整预加载单用户的全部功能插件 + defaultParts 记录的部件（loadPart 完整生命周期：Init+Load+按策略 SetData 后进 parts_set）。
 * why：浅加载只 import 暖 V8 模块缓存，部件首次被面板/对话触碰仍要在请求路径上跑 Init/Load（重插件秒级等待）。
 *   本函数把这段成本移到启动后台；用户之后打开任何功能命中 loadPart 缓存前置（本文件 472 行 isPartLoaded 分支）即时返回。
 * 覆盖面 = 已安装插件全集（getPartList 'plugins'，含未进 defaultParts 的新插件）∪ defaultParts 全部记录（shells 等）。
 * 并发安全：parts_init / parts_set 均以 in-flight Promise 兼作并发守卫（loadPartBase），与请求路径懒加载并跑无双初始化。
 * @param {object | string} user - 用户对象或用户名。
 * @returns {Promise<void>}
 */
async function fullLoadPartForUser(user, partpath, { critical = false } = {}) {
	if (!fs.existsSync(GetPartPath(user.username, partpath) + '/main.mjs')) return
	// [D5 §2.4] 预加载状态逐 Part 进 readiness 注册表：浏览器已先行打开(SHELL_READY),
	// 「正在后台准备 N 个扩展/失败 Part 名称」由 /api/readiness 可观察,不再盲等。
	reportPartPreloadState(user.username, partpath, 'loading')
	try {
		await loadPart(user.username, partpath, { username: user.username })
		// 顺手预热详情缓存（parts_details_cache）：getAllCachedPartDetails 只回已缓存项，
		// 不预热则插件列表等消费者对从未打开过的插件拿不到 info.json 文案（描述空白）。部件已在内存，此调用零重载成本。
		await getPartDetails(user.username, partpath)
		reportPartPreloadState(user.username, partpath, 'loaded')
	}
	catch (e) {
		if (e?.suppressDuplicateNotification) {
			wbTrace(null, "startup", "fullLoadAllParts:load_backoff", { username: user.username, partpath, retryAfterMs: e.retryAfterMs })
			reportPartPreloadState(user.username, partpath, 'failed', e?.lastCause?.message || e?.message)
		}
		else {
			wbDetect(null, "startup", "fullLoadAllParts:load_failed", false, "部件启动全量预加载失败", { username: user.username, partpath, critical, err: e?.message || String(e) })
			reportPartPreloadState(user.username, partpath, 'failed', e?.message)
		}
		if (critical) throw e
	}
}

async function fullLoadAllPartsForUser(user) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const partpaths = new Set(getPartList(user.username, 'plugins').map(name => 'plugins/' + name))
	const defaultParts = user.defaultParts ?? {}
	for (const parent in defaultParts)
		for (const child of defaultParts[parent] ?? [])
			partpaths.add(parent + '/' + child)
	const corePartpaths = getStartupCorePartpaths(defaultParts)
	const backgroundPartpaths = [...partpaths].filter(partpath => !corePartpaths.has(partpath))
	wbTrace(null, "startup", "fullLoadAllParts:user", {
		username: user.username,
		count: partpaths.size,
		coreCount: corePartpaths.size,
		backgroundCount: backgroundPartpaths.length,
	})
	// [0804 根因修·B3] 预加载覆盖面=已安装插件全集（getPartList 'plugins'），而 loadPart 经
	//   plugins 容器 loadSubPart 会 setDefaultPart 自注册为默认插件——于是「用户未默认启用」的
	//   已装插件被启动暖加载反向写回 defaultParts.plugins，覆盖用户意图（03 §九.4）。预加载是纯
	//   暖缓存操作，不得改用户 config：快照 plugins 键，暖加载后还原（用户真实默认不变、暖加载新增
	//   的一律撤销）。启动早期无并发用户改配置窗口，还原在 allSettled 之后=所有自注册已结算，无竞态。
	const _pluginsBefore = Object.prototype.hasOwnProperty.call(user.defaultParts || {}, 'plugins')
		? [...user.defaultParts.plugins]
		: undefined
	try {
		const coreLoadResults = await Promise.allSettled([...corePartpaths]
			.map(partpath => fullLoadPartForUser(user, partpath, { critical: true })))
		throwStartupCoreFailures(user.username, coreLoadResults)
		await Promise.allSettled(backgroundPartpaths.map(partpath => fullLoadPartForUser(user, partpath)))
	}
	finally {
		// [0804 B3] 还原 plugins 默认清单到暖加载前快照（撤销 loadSubPart 自注册的越权写入）。
		const _pluginsAfter = user.defaultParts?.plugins
		const _changed = _pluginsBefore === undefined
			? Array.isArray(_pluginsAfter) // 原本无 plugins 键，暖加载新增了 → 需撤销
			: !Array.isArray(_pluginsAfter) || _pluginsBefore.length !== _pluginsAfter.length
				|| _pluginsBefore.some((n, i) => n !== _pluginsAfter[i])
		if (_changed) {
			if (_pluginsBefore === undefined) { if (user.defaultParts) delete user.defaultParts.plugins }
			else user.defaultParts.plugins = [..._pluginsBefore]
			try { save_config() }
			catch (e) { wbDetect(null, "startup", "fullLoadAllParts:defaultParts_restore_failed", false, "暖加载后还原 plugins 默认清单失败", { username: user.username, err: e?.message || String(e) }) }
		}
	}
}

/**
 * 完整预加载所有用户的全部功能插件与默认部件（server.mjs 启动段在浅加载后调用）。
 * @returns {Promise<void>}
 */
export async function fullLoadAllParts() {
	for (const user of Object.values(getAllUsers())) await fullLoadAllPartsForUser(user)
}

/**
 * 卸载一个基础的 mjs 部件。
 * @param {string} path - 部件的路径。
 */
export async function baseMjsPartUnloader(path) {
	if (!fs.existsSync(path)) return
	/**
	 * 卸载代码。
	 * @param {string} path - 要卸载的代码的路径。
	 */
	async function codeunloader(path) {
		/*
		todo: implement codeunloader after moveing beilu from deno to bun/done
		deno ll never support this, see also:
		https://github.com/denoland/deno/issues/27820
		https://github.com/denoland/deno/issues/28126
		https://github.com/denoland/deno/issues/25780
		*/
	}
	// get all the js/ts/mjs/cjs/wasm files in the path and call codeunloader
	await Promise.all(
		fs.readdirSync(path, { withFileTypes: true, recursive: true })
			.filter(file => file.isFile() && /\.(js|ts|mjs|cjs|wasm)$/.test(file.name))
			.map(file => file.parentPath + '/' + file.name)
			.map(f => codeunloader(f).catch(console.error))
	)
}

/**
 * 部件完整载入的一段（Load → 按策略 SetData → afterLoad）失败时的局部回收。
 * 这里不能调用 unloadPartBase：当前部件仍是 parts_set 中的 in-flight Promise，
 * 走公共卸载入口会把“正在加载”误当成已加载实例。只回收本次 part 自己已经建立的资源和路由。
 */
async function rollbackPartLoadAttempt(part, username, partpath, sourcePath, Initargs, stage, originalError) {
	const cleanupFailures = []
	let cleanupDeadline = PART_UNLOAD_DEFAULT_DEADLINE_MS
	try { cleanupDeadline = getLifecycleDeadlines().Unload }
	catch (policyError) { cleanupFailures.push({ stage: 'policy', error: policyError }) }
	for (const [cleanupStage, cleanup] of [
		['Unload', () => part?.Unload?.({ ...Initargs, lifecycle: { ...(Initargs?.lifecycle || {}), phase: 'rollback' } })],
		['deleteRouter', () => deletePartRouter(username, partpath)],
		['moduleUnload', () => baseMjsPartUnloader(sourcePath || GetPartPath(username, partpath))],
	]) {
		try { await runCleanupWithDeadline(`rollback-${cleanupStage}`, cleanupDeadline, cleanup) }
		catch (rollbackError) {
			cleanupFailures.push({ stage: cleanupStage, error: rollbackError })
			wbDetect(null, 'parts', `loadPartBase:rollback_${cleanupStage}_failed`, false, `部件加载失败后的 ${cleanupStage} 回收失败`, {
				username, partpath, stage, err: rollbackError?.message || String(rollbackError),
			})
		}
	}
	if (cleanupFailures.length) {
		const aggregate = new AggregateError(cleanupFailures.map(item => item.error), `部件 ${partpath} 在 ${stage} 失败，且 ${cleanupFailures.length} 项回滚清理未完成`)
		aggregate.code = 'E_PART_LOAD_ROLLBACK_FAILED'
		aggregate.stage = stage
		aggregate.partpath = partpath
		aggregate.cleanupFailures = cleanupFailures.map(item => ({ stage: item.stage, cause: summarizePartLoadCause(item.error) }))
		aggregate.manualRecoveryRequired = true
		Object.defineProperty(aggregate, 'cause', { value: originalError, enumerable: false })
		return aggregate
	}
	wbDetect(null, 'parts', 'loadPartBase:rolled_back', false, '部件完整生命周期失败，回滚已完成且未标记为 loaded', {
		username, partpath, stage, err: originalError?.message || String(originalError),
	})
	return originalError
}

async function rollbackLatePartAndEscalate(attempt, part, username, partpath, sourcePath, Initargs, stage) {
	const lateCause = new Error(`${stage} completed after lifecycle cancellation`)
	lateCause.code = 'E_PART_LIFECYCLE_LATE_COMPLETION'
	const rollbackResult = await rollbackPartLoadAttempt(part, username, partpath, sourcePath, Initargs, stage, lateCause)
	if (rollbackResult !== lateCause) {
		markPartLoadFailure(username, partpath, rollbackResult, attempt)
		throw rollbackResult
	}
}

function assertConfigApplySucceeded(result, partpath) {
	// 兼容历史 SetData：无返回值依旧表示正常完成；只有显式失败语义才阻断 loaded。
	const normalized = result?._result && typeof result._result === 'object' ? result._result : result
	if (result === false || normalized?.success === false || normalized?.ok === false || normalized?.error != null || result?.error != null) {
		const detail = normalized?.error || normalized?.message || result?.error || result?.message || '配置接口返回失败状态'
		const error = new Error(`部件 ${partpath} 配置未应用: ${detail}`)
		error.code = 'E_PART_CONFIG_APPLY'
		throw error
	}
}

const PART_CONFIG_LOAD_POLICY_DEFAULT = 'always'
const PART_CONFIG_LOAD_POLICIES = new Set(['stored-only', 'always', 'never'])
const PART_CONFIG_CONTRACTS = new Map([
	['state', 'always'],
	['stored-state', 'stored-only'],
	['command', 'never'],
	['none', 'never'],
])
const _missingConfigContractWarnings = new Set()

/**
 * 读取 Part 清单中的配置能力契约。清单是发现与能力登记的同一权威；loader 不查看
 * partpath、tag 或 SetData 函数源码来猜测“这是配置还是命令”。
 */
function readPartConfigContract(partDirectory, partpath) {
	const manifestPath = path.join(partDirectory, 'beilu-part.json')
	if (!fs.existsSync(manifestPath)) return { declared: false, contract: undefined, manifestPath }
	let manifest
	try { manifest = loadJsonFile(manifestPath) }
	catch (cause) {
		const error = new Error(`部件 ${partpath} 的 beilu-part.json 无法读取，不能确定配置恢复契约`)
		error.code = 'E_PART_CONFIG_CONTRACT'
		error.partpath = partpath
		error.manifestPath = manifestPath
		Object.defineProperty(error, 'cause', { value: cause, enumerable: false })
		throw error
	}
	if (!Object.prototype.hasOwnProperty.call(manifest, 'configContract'))
		return { declared: false, contract: undefined, manifestPath }
	const contract = manifest.configContract
	if (!PART_CONFIG_CONTRACTS.has(contract)) {
		const error = new Error(`部件 ${partpath} 声明了无效的 configContract: ${String(contract)}`)
		error.code = 'E_PART_CONFIG_CONTRACT'
		error.partpath = partpath
		error.manifestPath = manifestPath
		error.configContract = contract
		throw error
	}
	return { declared: true, contract, manifestPath }
}

/**
 * 解析 Part 自己声明的配置恢复契约。loader 不识别具体 partpath，也不推断 SetData 的业务语义。
 * @returns {{ policy: 'stored-only' | 'always' | 'never'; shouldApply: boolean; data: any }}
 */
export function resolvePartConfigLoadPlan(loadPolicy, hasStoredConfig, storedConfig, partpath = '(unknown)') {
	const policy = loadPolicy === undefined ? PART_CONFIG_LOAD_POLICY_DEFAULT : loadPolicy
	if (!PART_CONFIG_LOAD_POLICIES.has(policy)) {
		const error = new Error(`部件 ${partpath} 声明了无效的 config.loadPolicy: ${String(policy)}`)
		error.code = 'E_PART_CONFIG_LOAD_POLICY'
		error.partpath = partpath
		error.loadPolicy = policy
		throw error
	}
	if (policy === 'never') return { policy, shouldApply: false, data: undefined }
	if (policy === 'always') {
		// [D5 §2.4 首启约束 2026-08-04] 无 stored config 时不得对业务 Part SetData({})：
		//   'always' 的空对象初始化是一份【契约】——只有 Part 显式声明（configContract='state' 经映射、
		//   或旧接口显式写 loadPolicy:'always'）才视为"空对象初始化安全"，首启照旧收 {}；
		//   未声明走 legacy 默认(loadPolicy===undefined)的 Part，首启【跳过】SetData——
		//   否则插件把 {} 当"用户清空了配置"处理，形成"第一次启动行为错、第二次(有落盘后)才生效"同类风险(05 §A#1 同族)。
		if (loadPolicy === undefined && !hasStoredConfig)
			return { policy, shouldApply: false, data: undefined, firstBootSkipped: true }
		return { policy, shouldApply: true, data: hasStoredConfig ? storedConfig : {} }
	}
	return { policy, shouldApply: !!hasStoredConfig, data: hasStoredConfig ? storedConfig : undefined }
}

/**
 * 将清单能力契约映射到既有加载计划。历史 Part 无登记时保持原行为，但由调用点审计；
 * 登记与旧接口声明并存时必须一致，禁止两个权威静默漂移。
 */
export function resolvePartConfigContractLoadPlan(configContract, legacyLoadPolicy, hasStoredConfig, storedConfig, partpath = '(unknown)') {
	if (configContract === undefined)
		return resolvePartConfigLoadPlan(legacyLoadPolicy, hasStoredConfig, storedConfig, partpath)
	if (!PART_CONFIG_CONTRACTS.has(configContract)) {
		const error = new Error(`部件 ${partpath} 声明了无效的 configContract: ${String(configContract)}`)
		error.code = 'E_PART_CONFIG_CONTRACT'
		error.partpath = partpath
		error.configContract = configContract
		throw error
	}
	const mappedPolicy = PART_CONFIG_CONTRACTS.get(configContract)
	if (legacyLoadPolicy !== undefined && legacyLoadPolicy !== mappedPolicy) {
		const error = new Error(`部件 ${partpath} 的 configContract=${configContract} 与 config.loadPolicy=${legacyLoadPolicy} 冲突`)
		error.code = 'E_PART_CONFIG_CONTRACT_CONFLICT'
		error.partpath = partpath
		error.configContract = configContract
		error.loadPolicy = legacyLoadPolicy
		throw error
	}
	return { ...resolvePartConfigLoadPlan(mappedPolicy, hasStoredConfig, storedConfig, partpath), configContract }
}

function assertPartConfigContractCompatible(registration, part, partpath) {
	const configInterface = part?.interfaces?.config
	resolvePartConfigContractLoadPlan(registration.contract, configInterface?.loadPolicy, false, undefined, partpath)
	if ((registration.contract === 'state' || registration.contract === 'stored-state') && typeof configInterface?.SetData !== 'function') {
		const error = new Error(`部件 ${partpath} 声明 configContract=${registration.contract}，但没有 interfaces.config.SetData`)
		error.code = 'E_PART_CONFIG_CONTRACT'
		error.partpath = partpath
		error.configContract = registration.contract
		throw error
	}
	if (!registration.declared && typeof configInterface?.SetData === 'function') {
		const warningKey = `${registration.manifestPath}\0${configInterface?.loadPolicy ?? '(legacy-default)'}`
		if (!_missingConfigContractWarnings.has(warningKey)) {
			_missingConfigContractWarnings.add(warningKey)
			wbDetect(null, 'parts', 'loadPartBase:config_contract_missing', false, '部件存在 SetData 但尚未登记 configContract，暂按历史策略兼容', {
				partpath, manifest: registration.manifestPath,
				legacyLoadPolicy: configInterface?.loadPolicy ?? PART_CONFIG_LOAD_POLICY_DEFAULT,
			})
		}
	}
}

const parts_load_results = {}

/**
 * 记录loadPart调用的集合。
 * @type {Set<string>}
 */
const loadPartCallRecords = new Set()

/**
 * 是否启用loadPart调用记录。
 * @type {boolean}
 */
let isRecordingLoadPartCalls = false

/**
 * 启用loadPart调用记录。
 * @returns {void}
 */
export function enableLoadPartRecording() {
	isRecordingLoadPartCalls = true
	loadPartCallRecords.clear()
}

/**
 * 禁用loadPart调用记录。
 * @returns {void}
 */
export function disableLoadPartRecording() {
	isRecordingLoadPartCalls = false
	loadPartCallRecords.clear()
}

/**
 * 获取记录的loadPart调用列表。
 * @returns {string[]} 记录的调用列表，格式为 "username:partpath"。
 */
export function getLoadPartCallRecords() {
	return Array.from(loadPartCallRecords)
}

/**
 * 清除记录的loadPart调用。
 * @returns {void}
 */
export function clearLoadPartCallRecords() {
	loadPartCallRecords.clear()
}

/**
 * 加载和初始化部件的基础函数。处理初始化和加载生命周期。
 * 此函数只负责加载给定的层级，不处理记录调用或父部件加载等细节。
 * 使用模板参数来指定部件类型和初始化参数，以获得更好的类型安全。
 *
 * @async
 * @template T
 * @template Initargs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {Initargs_t} Initargs - 传递给部件 Init 函数的初始化参数。
 * @param {Object} [functions] - 用于自定义加载和初始化过程的可选函数。
 * @param {() => string} [functions.pathGetter] - 获取部件路径的函数。
 * @param {(path: string, Initargs: Initargs_t) => Promise<T>} [functions.Loader] - 从路径加载部件的函数。默认为 baseMjsPartLoader 并调用 part.Load。
 * @param {(part: T) => void} [functions.afterLoad] - 部件加载后调用的函数。
 * @param {(path: string, Initargs: Initargs_t) => Promise<T>} [functions.Initer] - 从路径初始化部件的函数。默认为 baseMjsPartLoader 并调用 part.Init。
 * @param {(part: T) => void} [functions.afterInit] - 部件初始化后调用的函数。
 * @returns {Promise<FullProxy<T>>} 一个解析为加载和初始化的部件实例的 FullProxy 的承诺。
 */
export async function loadPartBase(username, partpath, Initargs, {
	pathGetter = () => GetPartPath(username, partpath),
	Loader = async (path, Initargs) => {
		let part
		try {
			part = await baseMjsPartLoader(path)
			await part.Load?.(Initargs)
			return part
		}
		catch (e) {
			wbDetect(null, "parts", "loadPartBase:part_Load_failed", false, "部件 Load 失败（已回滚卸载）", { username, partpath, path, err: e?.message || String(e) })
			throw await rollbackPartLoadAttempt(part, username, partpath, path, Initargs, 'Load', e)
		}
	},
	afterLoad = part => { },
	Initer = async (path, Initargs) => {
		let part
		try {
			part = await baseMjsPartLoader(path)
			await part.Init?.(Initargs)
			return part
		} catch (error) {
			if (part && error && typeof error === 'object') Object.defineProperty(error, 'part', { value: part, configurable: true })
			throw error
		}
	},
	afterInit = part => { },
	lifecycleDeadlines = {},
} = {}) {
	const deadlines = getLifecycleDeadlines(lifecycleDeadlines)
	const loadKey = getPartLoadKey(username, partpath)
	let attempt = _loadPartAttempts.get(loadKey)
	let ownsAttempt = false
	if (!attempt) {
		attempt = createPartLoadAttempt(username, partpath)
		_loadPartAttempts.set(loadKey, attempt)
		ownsAttempt = true
	}
	// 已加载（内存中 part 实例已存在且非 Promise）时跳过 trace，避免每次请求路由都刷屏
	if (!(parts_set[username]?.[partpath]) || parts_set[username][partpath] instanceof Promise)
		wbTrace(null, "parts", "loadPartBase:enter", { username, partpath })
	Initargs = {
		...Initargs,
		router: getPartRouter(username, partpath),
		username,
		signal: attempt.controller.signal,
		lifecycle: { source: 'parts-loader', phase: 'load', attemptRevision: attempt.revision.id },
	}
	parts_set[username] ??= {}
	const parts_init = loadData(username, 'parts_init')
	const parts_config = loadData(username, 'parts_config')
	let manifestContract
	// ★ D1：worker isolate 走 per-isolate 内存门跑 part.Init（不碰磁盘 parts_init，主进程语义不变）
	const _inWorker = !!globalThis.__BEILU_WORKER_ISOLATE
	try {
		if (!parts_set[username][partpath]) {
			// 清单非法及“登记/旧接口冲突”必须在 Init/Load/工具启动之前失败。
			// 动态 import 只取得模块契约；不调用任何生命周期钩子。
			manifestContract = readPartConfigContract(pathGetter(), partpath)
			const contractPart = await baseMjsPartLoader(pathGetter())
			assertPartConfigContractCompatible(manifestContract, contractPart, partpath)
		}
		if (_inWorker) {
			// worker isolate：本 isolate 没跑过该 part 的 Init 才跑（in-flight Promise 兼作并发守卫）。
			//   不回写磁盘 parts_init、不抢 install-once 记录（install 由主进程一次性完成）。
			const _isoMap = (_isolateInited[username] ??= {})
			if (!_isoMap[partpath])
				_isoMap[partpath] = initPart(username, partpath, Initargs, { pathGetter, Initer, afterInit, attempt, deadlines })
			try { await _isoMap[partpath] }
			catch (error) { delete _isoMap[partpath]; throw error } // init 失败清缓存 Promise，允许重试
		}
		// 只认 true=已初始化、Promise=正在初始化（并发守卫）；其余值（如 Promise 落盘残骸 {}）一律重新 init
		else if (parts_init[partpath] !== true && !(parts_init[partpath] instanceof Promise)) {
			try {
				const profile = await doProfile(async () => {
					parts_init[partpath] = initPart(username, partpath, Initargs, { pathGetter, Initer, afterInit, attempt, deadlines })
					parts_init[partpath] = await parts_init[partpath]
				})
				console.logI18n('beiluConsole.partManager.partInited', {
					partpath
				})
				console.log(profile)
				reportPluginStatus(username, partpath, "inited", { profile });
				parts_init[partpath] = true
				notifyPartInstall(username, partpath)
			}
			catch (error) {
				wbDetect(null, "parts", "loadPartBase:init_failed", false, "部件 Init 失败", { username, partpath, err: error?.message || String(error) })
				// init 失败必须清 key，否则残值（含被序列化成 {} 的 Promise）会让下次启动误判已加载
				delete parts_init[partpath]
				saveData(username, 'parts_init')
				throw error
			}
			saveData(username, 'parts_init')
		}
		if (!_inWorker && parts_init[partpath] instanceof Promise)
			parts_init[partpath] = await parts_init[partpath]
		if (!parts_set[username][partpath]) {
			const profile = await doProfile(async () => {
				parts_set[username][partpath] = (async () => {
					/** @type {T} */
					const part = await baseloadPart(username, partpath, {
						pathGetter,
						/**
						 * 从指定路径加载部件。
						 * @param {string} path - 部件路径。
						 * @returns {Promise<any>} 加载的部件。
						 */
						Loader: async path => await runLifecycleStage(attempt, 'Load', deadlines.Load,
							() => Loader(path, Initargs),
							{ onLateFulfilled: latePart => rollbackLatePartAndEscalate(attempt, latePart, username, partpath, path, Initargs, 'Load-late') },
						)
					})
					let stage = 'afterLoad'
					try {
						// 配置恢复由 beilu-part.json 的能力契约决定；历史接口声明只作兼容。
						// loader 不按 partpath、tag 或函数源码猜测业务语义。
						stage = 'config-load-policy'
						const configInterface = part.interfaces?.config
						const hasStoredConfig = parts_config != null && Object.prototype.hasOwnProperty.call(parts_config, partpath)
						const configLoadPlan = resolvePartConfigContractLoadPlan(
							manifestContract.contract,
							configInterface?.loadPolicy,
							hasStoredConfig,
							hasStoredConfig ? parts_config[partpath] : undefined,
							partpath,
						)
						if (configLoadPlan.firstBootSkipped)
							wbTrace(null, 'parts', 'loadPartBase:first_boot_setdata_skipped', { username, partpath, note: '无 stored config 且未声明空对象初始化契约,首启跳过 SetData({})' })
						if (configLoadPlan.shouldApply && typeof configInterface?.SetData === 'function') {
							stage = 'SetData'
							const configResult = await runLifecycleStage(attempt, 'SetData', deadlines.SetData, () => configInterface.SetData(configLoadPlan.data, {
								username, partpath, source: 'parts-loader', lifecycle: 'load',
								signal: attempt.controller.signal,
								deadlineMs: deadlines.SetData,
							}), {
								onLateSettled: () => rollbackLatePartAndEscalate(attempt, part, username, partpath, pathGetter(), Initargs, 'SetData-late'),
							})
							assertConfigApplySucceeded(configResult, partpath)
						}
						stage = 'afterLoad'
						await runLifecycleStage(attempt, 'afterLoad', deadlines.afterLoad, () => afterLoad(part, {
							username, partpath, signal: attempt.controller.signal, deadlineMs: deadlines.afterLoad,
						}), {
							onLateSettled: () => rollbackLatePartAndEscalate(attempt, part, username, partpath, pathGetter(), Initargs, 'afterLoad-late'),
						})
						assertPartAttemptCurrent(attempt, { renew: true })
						writeIsolatePresence({ strict: true })
						clearPartLoadFailure(username, partpath, attempt)
					}
					catch (error) {
						const failureStage = error?.code === 'E_PART_CONFIG_APPLY' ? 'SetData-result' : stage
						wbDetect(null, "parts", "loadPartBase:config_or_afterload_failed", false, "部件配置或加载后钩子失败，已回滚", { username, partpath, stage: failureStage, err: error?.message || String(error) })
						throw await rollbackPartLoadAttempt(part, username, partpath, pathGetter(), Initargs, failureStage, error)
					}
					return part
				})()
				try {
					parts_set[username][partpath] = await parts_set[username][partpath]
				} catch (loadErr) {
					// rejected Promise 残留在 parts_set 会让后续所有调用卡死——清掉允许重试
					delete parts_set[username][partpath]
					if (!Object.keys(parts_set[username]).length) delete parts_set[username]
					throw loadErr
				}
			})
			assertPartAttemptCurrent(attempt, { renew: true })
			console.logI18n('beiluConsole.partManager.partLoaded', {
				partpath
			})
			console.log(profile)
			const statusEntry = reportPluginStatus(username, partpath, "loaded", null)
			events.emit('part-loaded', { username, partpath, occurrenceId: statusEntry.occurrenceId, revision: statusEntry.revision })
			wbTrace(null, "parts", "loadPartBase:loaded", { username, partpath })
			writeIsolatePresence()
		}
		if (parts_set[username][partpath] instanceof Promise)
			parts_set[username][partpath] = await parts_set[username][partpath]
	}
	catch (error) {
		if (_inWorker) delete _isolateInited[username]?.[partpath]
		else {
			delete parts_init[partpath]
			try { saveData(username, 'parts_init') }
			catch (saveError) { wbDetect(null, 'parts', 'loadPartBase:init_state_clear_failed', false, '加载失败后清理 Init 状态失败', { username, partpath, err: saveError?.message || String(saveError) }) }
		}
		// 经 loadPart 进入时由外层 attempt owner 统一登记；直接 loadPartBase 在本层登记。
		if (ownsAttempt) markPartLoadFailure(username, partpath, error, attempt)
		throw error
	}
	finally {
		setDefaultStuff()
		if (ownsAttempt) {
			if (_loadPartAttempts.get(loadKey) === attempt) _loadPartAttempts.delete(loadKey)
			finalizePartLoadAttempt(attempt)
		}
	}
	parts_load_results[username] ??= {}
	return parts_load_results[username][partpath] ??= new FullProxy(() => parts_set[username][partpath])
}

/**
 * 初始化一个部件。此函数与 `loadPartBase` 分离，以便在不重新加载的情况下重新初始化。
 *
 * @async
 * @template T
 * @template Initargs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {Initargs_t} Initargs - 初始化参数。
 * @param {Object} [options] - 用于自定义初始化过程的可选函数。
 * @param {() => string} [options.pathGetter] - 获取部件路径的函数。
 * @param {(path: string, Initargs: Initargs_t) => Promise<T>} [options.Initer] - 从路径初始化部件的函数。默认为 baseMjsPartLoader 并调用 part.Init。
 * @param {(part: T) => void} [options.afterInit] - 部件初始化后调用的函数。
 * @returns {Promise<void>}
 */
export async function initPart(username, partpath, Initargs, {
	pathGetter = () => GetPartPath(username, partpath),
	Initer = async (path, Initargs) => {
		const part = await baseMjsPartLoader(path)
		await part.Init?.(Initargs)
		return part
	},
	afterInit = part => { },
	attempt,
	deadlines = getLifecycleDeadlines(),
} = {}) {
	const loadKey = getPartLoadKey(username, partpath)
	let lifecycleAttempt = attempt || _loadPartAttempts.get(loadKey)
	let ownsAttempt = false
	if (!lifecycleAttempt) {
		lifecycleAttempt = createPartLoadAttempt(username, partpath)
		_loadPartAttempts.set(loadKey, lifecycleAttempt)
		ownsAttempt = true
	}
	let part
	let stage = 'Init'
	try {
		part = await runLifecycleStage(lifecycleAttempt, 'Init', deadlines.Init,
			() => Initer(pathGetter(), Initargs),
			{ onLateFulfilled: latePart => rollbackLatePartAndEscalate(lifecycleAttempt, latePart, username, partpath, pathGetter(), Initargs, 'Init-late') },
		)
		stage = 'afterInit'
		await runLifecycleStage(lifecycleAttempt, 'afterInit', deadlines.afterInit, () => afterInit(part, {
			username, partpath, signal: lifecycleAttempt.controller.signal, deadlineMs: deadlines.afterInit,
		}), {
			onLateSettled: () => rollbackLatePartAndEscalate(lifecycleAttempt, part, username, partpath, pathGetter(), Initargs, 'afterInit-late'),
		})
		assertPartAttemptCurrent(lifecycleAttempt, { renew: true })
		return part
	} catch (error) {
		const rollbackPart = part || error?.part
		throw await rollbackPartLoadAttempt(rollbackPart, username, partpath, pathGetter(), Initargs, stage, error)
	} finally {
		if (ownsAttempt) {
			if (_loadPartAttempts.get(loadKey) === lifecycleAttempt) _loadPartAttempts.delete(loadKey)
			finalizePartLoadAttempt(lifecycleAttempt)
		}
	}
}

/**
 * 从内存中卸载一个部件的基础函数，如果存在，则调用其 Unload 函数。
 * 此函数只负责卸载给定的层级，不处理父部件卸载等细节。
 *
 * @async
 * @template T
 * @template UnloadArgs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {UnloadArgs_t} unLoadargs - 传递给部件 Unload 函数的参数。
 * @param {Object} [options] - 用于自定义卸载过程的可选函数。
 * @param {() => string} [options.pathGetter] - 获取部件路径的函数。
 * @param {(part: T) => Promise<void>} [options.unLoader] - 卸载部件的函数。默认为调用 part.Unload。
 * @param {(path: string, unLoadargs: UnloadArgs_t) => Promise<void>} [options.afterUnload] - 卸载后调用的函数。
 * @returns {Promise<void>} 一个在部件卸载后解析的承诺。
 */
export async function unloadPartBase(username, partpath, unLoadargs, {
	pathGetter = () => GetPartPath(username, partpath),
	unLoader = (part, lifecycleContext) => part.Unload?.(unLoadargs, lifecycleContext),
	afterUnload = baseMjsPartUnloader,
	lifecycleDeadlines = {},
} = {}) {
	/** @type {T} */
	const part = parts_set[username]?.[partpath]
	if (!part) return
	if (part instanceof Promise) {
		const error = new Error(`部件 ${partpath} 仍处于加载中，不能把 Promise 当作可卸载实例`)
		error.code = 'E_PART_UNLOAD_INFLIGHT'
		throw error
	}
	const deadlines = getLifecycleDeadlines(lifecycleDeadlines)
	// Unload 是提交闸：它失败时不能继续删路由/卸模块，否则 parts_set 仍指向“loaded”实例，
	// 实际请求却已无 route，形成最难恢复的半卸载状态。
	try {
		await runCleanupWithDeadline('Unload', deadlines.Unload,
			signal => unLoader(part, { username, partpath, signal, deadlineMs: deadlines.Unload }))
	}
	catch (cause) {
		const error = new AggregateError([cause], `部件 ${partpath} 的 Unload 未提交，已保留实例、路由与模块`)
		error.code = 'E_PART_UNLOAD_FAILED'
		error.partpath = partpath
		error.cleanupFailures = [{ stage: 'Unload', cause: summarizePartLoadCause(cause) }]
		reportPluginStatus(username, partpath, 'unload-error', { detail: error.message, cleanupFailures: error.cleanupFailures })
		throw error
	}
	const cleanupFailures = []
	for (const [stage, cleanup] of [
		['deleteRouter', () => deletePartRouter(username, partpath)],
		['afterUnload', signal => afterUnload(pathGetter(), { ...unLoadargs, signal, lifecycle: 'unload', username, partpath })],
		['clearFailureState', () => clearPartLoadFailure(username, partpath)],
	]) {
		try { await runCleanupWithDeadline(stage, deadlines.Unload, cleanup) }
		catch (error) {
			cleanupFailures.push({ stage, error })
			wbDetect(null, 'parts', `unloadPartBase:${stage}_failed`, false, `部件卸载阶段 ${stage} 失败`, { username, partpath, err: error?.message || String(error) })
		}
	}
	if (cleanupFailures.length) {
		const error = new AggregateError(cleanupFailures.map(item => item.error), `部件 ${partpath} 已执行 Unload，但后续清理不完整，需人工恢复`)
		error.code = 'E_PART_UNLOAD_CLEANUP_FAILED'
		error.partpath = partpath
		error.manualRecoveryRequired = true
		error.cleanupFailures = cleanupFailures.map(item => ({ stage: item.stage, cause: summarizePartLoadCause(item.error) }))
		delete parts_set[username][partpath]
		if (!Object.keys(parts_set[username]).length) delete parts_set[username]
		if (parts_load_results[username]) {
			delete parts_load_results[username][partpath]
			if (!Object.keys(parts_load_results[username]).length) delete parts_load_results[username]
		}
		reportPluginStatus(username, partpath, 'unload-error', { detail: error.message, cleanupFailures: error.cleanupFailures })
		markPartLoadFailure(username, partpath, error)
		writeIsolatePresence()
		throw error
	}
	delete parts_set[username][partpath]
	if (!Object.keys(parts_set[username]).length) delete parts_set[username]
	if (parts_load_results[username]) {
		delete parts_load_results[username][partpath]
		if (!Object.keys(parts_load_results[username]).length) delete parts_load_results[username]
	}
	reportPluginStatus(username, partpath, "unloaded", null);
	writeIsolatePresence()
}

/**
 * 卸载一个部件，首先卸载它，然后调用其 Uninstall 函数（如果存在）并删除其目录。
 *
 * @async
 * @template T
 * @template UnloadArgs_t
 * @template UninstallArgs_t
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {UnloadArgs_t} unLoadargs - 传递给部件 Unload 函数的参数。
 * @param {UninstallArgs_t} uninstallArgs - 传递给部件 Uninstall 函数的参数。
 * @param {Object} [options] - 用于自定义卸载过程的可选函数。
 * @param {(path: string) => Promise<T>} [options.Loader] - 从路径加载部件的函数（如果在卸载时部件尚未加载，则使用）。
 * @param {(part: T) => Promise<void>} [options.unLoader] - 卸载部件的函数。默认为调用 part.Unload。
 * @param {() => string} [options.pathGetter] - 获取部件路径的函数。
 * @param {(part: T, path: string) => Promise<void>} [options.Uninstaller] - 卸载部件的函数。默认为调用 part.Uninstall 并删除目录。
 * @returns {Promise<void>} 一个在部件卸载后解析的承诺。
 */
export async function uninstallPartBase(username, partpath, unLoadargs, uninstallArgs, {
	Loader = baseMjsPartLoader,
	unLoader = part => part.Unload?.(unLoadargs),
	pathGetter = () => GetPartPath(username, partpath),
	Uninstaller = async (part, path) => {
		await part?.Uninstall?.(uninstallArgs)
		try {
			await trash(path)
		}
		catch (error) {
			console.error(error)
			fs.rmSync(path, { recursive: true, force: true })
		}
	}
} = {}) {
	parts_set[username] ??= {}
	/** @type {T | undefined} */
	let part = parts_set[username][partpath]
	const parent = path.dirname(partpath)
	const partname = path.basename(partpath)
	if (getAllDefaultParts(username, parent).includes(partname))
		unsetDefaultPart(username, parent, partname)
	await unloadPartBase(username, partpath, unLoadargs, { unLoader })
	part ??= await baseloadPart(username, partpath, { Loader, pathGetter })
	await Uninstaller(part, pathGetter())
	events.emit('part-uninstalled', { username, partpath })
	sendEventToUser(username, 'part-uninstalled', { partpath })
	delete parts_set[username]?.[partpath]
	const parts_details_cache = loadData(username, 'parts_details_cache')
	delete parts_details_cache[partpath]
	saveData(username, 'parts_details_cache')
	const parts_config = loadData(username, 'parts_config')
	delete parts_config[partpath]
	saveData(username, 'parts_config')
	const parts_init = loadData(username, 'parts_init')
	delete parts_init[partpath]
	saveData(username, 'parts_init')
	invalidatePartBranchesCache(username)
}

/**
 * 获取给定用户和部件路径的子部件列表。
 *
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 父部件的路径。
 * @param {Object} [options] - 部件列表的可选过滤器和映射器。
 * @param {(file: fs.Dirent) => boolean} [options.PathFilter] - 过滤目录条目的函数。默认为检查具有“main.mjs”的目录。
 * @param {(file: fs.Dirent) => string} [options.ResultMapper] - 将目录条目映射到结果的函数。默认为返回文件名。
 * @returns {string[]} 部件名称数组。
 */
export function getPartListBase(username, partpath, {
	PathFilter = file => fs.existsSync(file.parentPath + '/' + file.name + '/main.mjs'),
	ResultMapper = file => file.name
} = {}) {
	const userRoot = getUserDictionary(username)
	const part_dir = userRoot + '/' + partpath
	let public_dir

	let partlist = []
	if (fs.existsSync(part_dir) && fs.statSync(part_dir).isDirectory())
		partlist = fs.readdirSync(part_dir, { withFileTypes: true }).filter(PathFilter)

	try {
		public_dir = __dirname + '/src/public/parts/' + partpath
		if (fs.existsSync(public_dir)) {
			const publiclist = fs.readdirSync(public_dir, { withFileTypes: true }).filter(PathFilter)
			const currentNames = new Set(partlist.map(f => f.name))
			for (const file of publiclist)
				if (!currentNames.has(file.name))
					partlist.push(file)
		}
	} catch (e) { console.warn("[parts_loader] public 部件目录扫描失败(退回用户目录):", public_dir, e?.message); }

	return partlist.map(ResultMapper)
}

/**
 * 获取部件的基本详细信息，而不使用缓存。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {Promise<object>} 一个解析为部件详细信息的承诺。
 */
async function nocacheGetPartBaseDetails(username, partpath) {
	const parts_details_cache = loadData(username, 'parts_details_cache')
	try {
		let part = await baseloadPart(username, partpath)
		let info = await part?.interfaces?.info?.UpdateInfo?.() || part?.info
		if (!info) {
			part = await loadPart(username, partpath).catch(() => part)
			info = await part?.interfaces?.info?.UpdateInfo?.() || part?.info
		}
		try {
			return parts_details_cache[partpath] = {
				info: JSON.parse(JSON.stringify(info)),
				supportedInterfaces: Object.keys(part.interfaces || {}),
			}
		}
		finally {
			saveData(username, 'parts_details_cache')
		}
	}
	catch (error) {
		wbDetect(null, "parts", "getPartDetails:load_failed", false, "获取部件详情时加载失败（返回错误占位）", { username, partpath, err: error?.message || String(error) })
		return {
			info: {
				'': {
					name: path.basename(partpath),
					avatar: 'https://api.iconify.design/line-md/emoji-frown-open.svg',
					description: 'error loading part',
					description_markdown: `# error loading part\n\n\`\`\`\`ansi\n${error.message}\n${error.stack}\n\`\`\`\``,
				}
			},
			supportedInterfaces: [],
		}
	}
}

/**
 * 获取“对工作安全”的信息。
 * @param {object} info - 要处理的信息对象。
 * @returns {object} 处理后的信息对象。
 */
function getSfwInfo(info) {
	if (!info) return info
	const sfwInfo = { ...info }
	for (const key in info)
		if (key.startsWith('sfw_')) {
			const originalKey = key.substring(4) // remove 'sfw_'
			sfwInfo[originalKey] = info[key]
		}
	return sfwInfo
}

/**
 * 检索关于部件的详细信息，可以从缓存中或通过加载部件来获取。
 *
 * @async
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {boolean} [nocache=false] - 如果为 true，则绕过缓存并强制加载部件。
 * @returns {Promise<PartDetails>} 一个解析为详细部件信息的承诺。
 */
export async function getPartDetails(username, partpath, nocache = false) {
	/** @type {PartDetails | undefined} */
	let details = nocache ? undefined : loadData(username, 'parts_details_cache')?.[partpath]
	const user = getUserByUsername(username)
	if (!details) details = await nocacheGetPartBaseDetails(username, partpath)
	else if (isPartLoaded(username, partpath)) await Promise.any([
		nocacheGetPartBaseDetails(username, partpath).then(result => details = result),
		new Promise(resolve => setTimeout(resolve, 500)),
	])
	let info = getLocalizedInfo(details.info, user.locales)
	if (user.sfw) info = getSfwInfo(info)

	return { ...details, info }
}

/**
 * 获取给定用户和部件路径的所有缓存部件详细信息。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {Promise<{cachedDetails: object, uncachedNames: string[]}>} 一个解析为包含缓存的详细信息和未缓存的名称的对象的承诺。
 */
export async function getAllCachedPartDetails(username, partpath) {
	// 1. Get the full list of part names in this path
	const allPartNames = getPartList(username, partpath)
	const allPartPaths = allPartNames.map(name => partpath ? partpath + '/' + name : name)
	const allPartPathsSet = new Set(allPartPaths)

	// 2. Get cached details
	const detailsCache = loadData(username, 'parts_details_cache') || {}
	const user = getUserByUsername(username)
	const cachedDetails = {}

	// 3. Process cached parts (same logic as before)
	const promises = Object.keys(detailsCache).map(async (cachedPath) => {
		// Filter only parts that are children of the requested path
		// Basically, we check if the cached entry is in the list we found
		if (!allPartPathsSet.has(cachedPath)) return

		let details = detailsCache[cachedPath]
		if (isPartLoaded(username, cachedPath))
			await Promise.any([
				nocacheGetPartBaseDetails(username, cachedPath).then(result => details = result),
				new Promise(resolve => setTimeout(resolve, 500)),
			])

		let info = getLocalizedInfo(details.info, user.locales)
		if (user.sfw) info = getSfwInfo(info)

		// Return keyed by NAME, not full path, to likely match frontend expectations for a list
		const name = path.basename(cachedPath)
		cachedDetails[name] = { ...details, info }
	})

	await Promise.all(promises)

	// 4. Determine uncached names
	const uncachedNames = allPartNames.filter(name => !cachedDetails[name])

	// 5. Return the new structure
	return { cachedDetails, uncachedNames }
}

function getIsolatePresencePath(isolateId = PART_LOADER_ISOLATE_ID) {
	return path.join(getPartLoaderRuntimeDir(), `isolate-${isolateId}.json`)
}

function getLocalLifecycleUsernames() {
	const usernames = new Set(Object.keys(parts_set))
	for (const attempt of _loadPartAttempts.values()) usernames.add(attempt.username)
	for (const username of getPluginStatusUsernames()) usernames.add(username)
	return [...usernames]
}

function writeIsolatePresence({ strict = false } = {}) {
	try {
		writeJsonState(getIsolatePresencePath(), {
			isolateId: PART_LOADER_ISOLATE_ID,
			pid: process.pid,
			threadId,
			heartbeatAt: Date.now(),
			loadedUsers: getLocalLifecycleUsernames(),
			quiesceAcks: _isolateQuiesceAcks,
		})
	} catch (error) {
		// svr_state 初始化前允许跳过；初始化后的协调写失败会由真实生命周期入口 fail closed。
		if (data_path) wbDetect(null, 'parts', 'isolate_presence_write_failed', false, '部件 isolate 心跳写入失败', { isolateId: PART_LOADER_ISOLATE_ID, err: error?.message || String(error) })
		if (strict) {
			const coordinationError = new Error('部件 isolate 状态无法持久化，拒绝发布 loaded')
			coordinationError.code = 'E_PART_LOAD_COORDINATION'
			coordinationError.cause = error
			throw coordinationError
		}
	}
}

function getActiveIsolatePresencesForUser(username, isolateStaleMs = getPartLoaderPolicy().isolateStaleMs) {
	const now = Date.now()
	const result = []
	for (const entry of fs.readdirSync(getPartLoaderRuntimeDir(), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.startsWith('isolate-') || !entry.name.endsWith('.json')) continue
		const presence = readJsonState(path.join(getPartLoaderRuntimeDir(), entry.name))
		if (!presence || !presence.loadedUsers?.includes(username)) continue
		const heartbeatFresh = now - Number(presence.heartbeatAt || 0) <= isolateStaleMs
		// pid 只能证明进程存在，不能证明同 pid 下的 worker thread 仍存在；线程级存活以
		// 该 isolate 自己持续写入的 heartbeat 为准，避免已 terminate worker 永久等待 ACK。
		if (heartbeatFresh) result.push(presence)
	}
	return result
}

async function quiesceLocalUserParts(username, reason) {
	const prefix = `${username}\0`
	const partpaths = new Set(Object.keys(parts_set[username] || {}))
	for (const [key, attempt] of _loadPartAttempts) {
		if (!key.startsWith(prefix)) continue
		partpaths.add(attempt.partpath)
		if (!attempt.controller.signal.aborted) attempt.controller.abort(createPartAttemptInvalidError(attempt, reason))
	}
	const failures = []
	for (const partpath of partpaths) {
		try { await unloadPart(username, partpath, { lifecycle: reason }) }
		catch (error) { failures.push({ partpath, error }) }
	}
	writeIsolatePresence()
	return failures
}

async function waitForCrossIsolateAcks(username, epoch, targetIsolateIds, timeoutMs, isolateStaleMs) {
	const pending = new Set(targetIsolateIds.filter(id => id !== PART_LOADER_ISOLATE_ID))
	const failures = []
	const deadline = Date.now() + timeoutMs
	while (pending.size) {
		for (const isolateId of [...pending]) {
			const presence = readJsonState(getIsolatePresencePath(isolateId))
			if (!presence || (!isPresenceProcessAlive(presence) && Date.now() - Number(presence.heartbeatAt || 0) > isolateStaleMs)) {
				pending.delete(isolateId)
				continue
			}
			const ack = presence.quiesceAcks?.[username]
			if (Number(ack?.epoch) !== Number(epoch)) continue
			pending.delete(isolateId)
			if (ack.success !== true) failures.push({ isolateId, error: ack.error })
		}
		if (!pending.size) break
		if (Date.now() >= deadline) {
			const error = new Error(`等待用户 ${username} 的跨隔离区卸载确认超时`)
			error.code = 'E_PART_USER_QUIESCE_TIMEOUT'
			error.pendingIsolates = [...pending]
			throw error
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	if (failures.length) {
		const error = new Error(`用户 ${username} 在 ${failures.length} 个隔离区卸载失败`)
		error.code = 'E_PART_USER_QUIESCE_REMOTE_FAILED'
		error.failures = failures
		throw error
	}
}

async function waitForCrossIsolatePartOwners(username, timeoutMs) {
	const runtimeDir = getPartLoaderRuntimeDir()
	const deadline = Date.now() + timeoutMs
	while (true) {
		const activeOwners = []
		for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith('owner-')) continue
			const owner = readOwnerFromLockDir(path.join(runtimeDir, entry.name))
			if (owner?.username === username && Number(owner.leaseUntil || 0) > Date.now()) activeOwners.push(owner)
		}
		if (!activeOwners.length) return
		if (Date.now() >= deadline) {
			const error = new Error(`用户 ${username} 仍有 ${activeOwners.length} 个跨隔离区部件生命周期未安全结束`)
			error.code = 'E_PART_USER_QUIESCE_TIMEOUT'
			error.activeParts = activeOwners.map(owner => owner.partpath)
			throw error
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}
}

async function quiesceAndUnloadUserParts(username, reason, context = {}) {
	const policy = getPartLoaderPolicy()
	const userState = setUserLifecycleBlocked(username, true, reason, context)
	const targetIsolates = getActiveIsolatePresencesForUser(username, policy.isolateStaleMs).map(item => item.isolateId)
	const failures = await quiesceLocalUserParts(username, reason)
	_isolateQuiesceAcks[username] = { epoch: userState.epoch, success: failures.length === 0, error: failures.length ? failures.map(item => summarizePartLoadCause(item.error)) : null, updatedAt: Date.now() }
	writeIsolatePresence()
	try { await waitForCrossIsolateAcks(username, userState.epoch, targetIsolates, policy.userQuiesceTimeoutMs, policy.isolateStaleMs) }
	catch (error) { failures.push({ partpath: '(cross-isolate-ack)', error }) }
	try { await waitForCrossIsolatePartOwners(username, policy.userQuiesceTimeoutMs) }
	catch (error) { failures.push({ partpath: '(cross-isolate)', error }) }
	if (failures.length) {
		const error = new AggregateError(failures.map(item => item.error), `用户 ${username} 的部件生命周期未能安全静止`)
		error.code = 'E_PART_USER_QUIESCE_FAILED'
		error.failures = failures.map(item => ({ partpath: item.partpath, cause: summarizePartLoadCause(item.error) }))
		throw error
	}
}

let _isolateBlockMonitorRunning = false
async function monitorBlockedUsersInThisIsolate() {
	if (_isolateBlockMonitorRunning || !data_path) return
	_isolateBlockMonitorRunning = true
	try {
		for (const [username, ack] of Object.entries(_isolateQuiesceAcks))
			if (Date.now() - Number(ack?.updatedAt || 0) > PART_LOADER_QUIESCE_ACK_RETENTION_MS) delete _isolateQuiesceAcks[username]
		for (const username of getLocalLifecycleUsernames()) {
			const state = getUserLifecycleState(username)
			if (!state.blocked || Number(_isolateQuiesceAcks[username]?.epoch) === Number(state.epoch)) continue
			const failures = await quiesceLocalUserParts(username, state.reason || 'remote-user-quiesce')
			if (!failures.length && state.reason === 'user-delete') clearPluginStatusesForUser(username)
			if (!failures.length && state.reason === 'user-rename' && state.context?.newUsername)
				renamePluginStatusesForUser(username, state.context.newUsername)
			_isolateQuiesceAcks[username] = {
				epoch: state.epoch,
				success: failures.length === 0,
				error: failures.length ? failures.map(item => ({ partpath: item.partpath, cause: summarizePartLoadCause(item.error) })) : null,
				updatedAt: Date.now(),
			}
		}
	} finally {
		if (getLocalLifecycleUsernames().length || Object.keys(_isolateQuiesceAcks).length) writeIsolatePresence()
		_isolateBlockMonitorRunning = false
	}
}

const _isolateHeartbeat = setInterval(() => { monitorBlockedUsersInThisIsolate().catch(error => wbDetect(null, 'parts', 'isolate_block_monitor_failed', false, '跨隔离区用户生命周期监控失败', { isolateId: PART_LOADER_ISOLATE_ID, err: error?.message || String(error) })) }, PART_LOADER_ISOLATE_HEARTBEAT_MS)
_isolateHeartbeat.unref?.()

function removeCurrentIsolatePresence() {
	if (!data_path) return
	try { unlinkState(getIsolatePresencePath(PART_LOADER_ISOLATE_ID)) }
	catch (error) { wbDetect(null, 'parts', 'isolate_presence_cleanup_failed', false, '当前 isolate 退出时清理精确 presence 文件失败', { isolateId: PART_LOADER_ISOLATE_ID, err: error?.message || String(error) }) }
}

// 只清本 isolate UUID 对应文件，不扫描或删除同进程其他活跃 worker 的 presence。
process.once('exit', removeCurrentIsolatePresence)
parentPort?.once('close', removeCurrentIsolatePresence)

events.on('BeforeUserDeleted', async ({ username }) => {
	await quiesceAndUnloadUserParts(username, 'user-delete')
})

events.on('UserDeletionAborted', async ({ username }) => {
	setUserLifecycleBlocked(username, false, 'user-delete-aborted')
})

events.on('AfterUserDeleted', async ({ username }) => {
	delete parts_set[username]
	delete _isolateInited[username]
	delete parts_load_results[username]
	clearPluginStatusesForUser(username)
	clearPersistentUserLifecycleState(username)
	writeIsolatePresence({ strict: true })
})

// 改名传导链（20260706）：旧名的已加载 part 实例必须卸载——实例内部捕获的是旧用户名，
//   残留会内存泄漏且后续写盘经 getUserDictionary(旧名) 兜底路径重建已挪走的旧目录。
//   挂 Before（非 After）：此刻用户目录还在旧位置、config 里用户还在，part.Unload 的落盘
//   写到正确的旧目录，随后被 renameUser 整体搬到新名下=状态无损迁移。新名首次请求懒加载重建。
events.on('BeforeUserRenamed', async ({ oldUsername, newUsername }) => {
	await quiesceAndUnloadUserParts(oldUsername, 'user-rename', { newUsername })
	// 目标名虽不在账户表中，仍可能是历史已删除身份留下的 runtime 状态；先精确清理，
	// 否则改名后会继承旧 deterministic/manual breaker。
	clearPersistentUserLifecycleState(newUsername)
	delete parts_set[oldUsername]
	delete _isolateInited[oldUsername]
	delete parts_load_results[oldUsername]
	clearPartLoadFailuresForUser(oldUsername)
})

events.on('UserRenameAborted', async ({ oldUsername }) => {
	setUserLifecycleBlocked(oldUsername, false, 'user-rename-aborted')
})

events.on('AfterUserRenamed', async ({ oldUsername, newUsername }) => {
	renamePluginStatusesForUser(oldUsername, newUsername)
	clearPersistentUserLifecycleState(oldUsername)
	clearPersistentUserLifecycleState(newUsername)
	writeIsolatePresence({ strict: true })
})

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
 *   首次加载(loadPartBase)：Init({ router, username }) → Load({ router, username }) → SetData(savedConfig)
 *     ⚠ SetData 在 Load 之后，插件 Load 内部无法依赖框架注入的配置
 *   浅加载(baseloadPart via shallowLoadAllDefaultParts)：只 import(main.mjs) + V8 缓存，不执行 Init/Load/SetData
 *   热重载(reloadPart)：setTimeout(restartor, 1000) 重启进程
 *
 * FullProxy 包装：loadPartBase 返回的引用是惰性代理，每次属性访问实时取 parts_set 最新实例——
 * 保证重载后旧引用自动指向新实例。
 */
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout } from 'node:timers'
import url from 'node:url'

import { FullProxy } from 'npm:full-proxy'
import trash from 'npm:trash'

// beilu: 移除了 git.mjs 和 profiler.mjs（已删除）
import { console } from '../scripts/i18n_core.mjs' // [0722 解环] console 叶子
import { loadJsonFile } from '../scripts/json_loader.mjs'
import { getLocalizedInfo } from '../scripts/locale.mjs'
import { nicerWriteFileSync } from '../scripts/nicerWriteFile.mjs'
import { confinePath } from '../yonban/core/functions/security/path_confine.mjs'

import { reportPluginStatus, logError, logWarn } from "./monitor.mjs";
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
import { restartor, save_config, setDefaultStuff, skip_report } from './svr_state.mjs' // [0722 解环] 环境态叶子
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
	const defaultParts = (user.defaultParts ??= {})[parent] ??= []
	if (defaultParts.includes(child)) return
	defaultParts.push(child)
	save_config()
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
	const defaultParts = (user.defaultParts ??= {})[parent] ??= []
	const added = []
	for (const child of children) {
		if (defaultParts.includes(child)) continue
		defaultParts.push(child)
		added.push(child)
	}
	if (!added.length) return added
	save_config()
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
	defaultParts.splice(index, 1)
	if (!defaultParts.length) delete user.defaultParts?.[parent]
	save_config()
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
export async function loadPart(username, partpath, Initargs, functions) {
	// 缓存命中前置：已完整加载（非 Promise）的部件直接返回，跳过递归和 fs 调用
	if (isPartLoaded(username, partpath) && !(parts_set[username][partpath] instanceof Promise)) {
		if (isRecordingLoadPartCalls) loadPartCallRecords.add(`${username}:${partpath}`)
		parts_load_results[username] ??= {}
		return parts_load_results[username][partpath] ??= new FullProxy(() => parts_set[username][partpath])
	}
	// 并发门：同 key 已有 in-flight 加载 → await 它（同步检查，在任何 await 之前）
	const _lfKey = `${username}\0${partpath}`;
	if (_loadPartInflight.has(_lfKey)) {
		return _loadPartInflight.get(_lfKey);
	}
	// 首次加载：trace
	wbTrace(null, "parts", "loadPart:enter", { username, partpath })
	diag.debug("loadPart:", username, partpath)
	// 同步存入 Promise（必须在第一个 await 之前，否则同微任务的并发调用看不到）
	const _lfPromise = _doLoadPart(username, partpath, Initargs, functions);
	_loadPartInflight.set(_lfKey, _lfPromise);
	try {
		return await _lfPromise;
	} finally {
		_loadPartInflight.delete(_lfKey);
	}
}
async function _doLoadPart(username, partpath, Initargs, functions) {
	// 记录loadPart调用
	if (isRecordingLoadPartCalls) loadPartCallRecords.add(`${username}:${partpath}`)

	// 支持层级化加载
	const parentPath = path.dirname(partpath)
	const partname = path.basename(partpath)
	if (parentPath !== '.' && parentPath !== '/')
		try {
			if (fs.existsSync(GetPartPath(username, parentPath) + '/main.mjs')) {
				const parentPart = await loadPart(username, parentPath)
				if (parentPart?.interfaces?.parts?.loadSubPart) {
					const pathGetter = functions?.pathGetter || (() => GetPartPath(username, partpath))
					const my_paths = parentPart.interfaces.parts.getSubPartsInstallPaths([pathGetter()])
					const subPart = await parentPart.interfaces.parts.loadSubPart(my_paths, username, partname)
					if (subPart) return subPart
				}
			}
		} catch (e) { wbDetect(null, "parts", "loadPart:parent_load_failed", false, "父部件加载失败", { partpath, parentPath, err: e?.message || String(e) }); diag.warn("父部件加载失败:", parentPath, "for", partpath, e?.message); logWarn("parts", "Parent part load failed: " + parentPath + " — " + (e?.message || String(e))); }

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
	// 尝试委托给父部件
	const parentPath = path.dirname(partpath)
	const partname = path.basename(partpath)
	if (parentPath !== '.' && parentPath !== '/')
		try {
			if (isPartLoaded(username, parentPath)) {
				const parentPart = await loadPart(username, parentPath)
				if (parentPart?.interfaces?.parts?.unloadSubPart) {
					const pathGetter = options?.pathGetter || (() => GetPartPath(username, partpath))
					await parentPart.interfaces.parts.unloadSubPart([pathGetter()], username, partname)
					return
				}
			}
		} catch (e) { /* ignore */ }

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
		const parts_details_cache = loadData(username, 'parts_details_cache')
		delete parts_details_cache[partpath]
		saveData(username, 'parts_details_cache')
		reportPluginStatus(partpath, "load-error", e?.message || String(e));
		sendEventToUser(username, "part-load-error", { partpath, status: "load-error", detail: e?.message || String(e) });
		throw e
	})
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
				baseloadPart(user.username, partpath).catch(e => { wbDetect(null, "startup", "shallowLoadDefaultParts:load_failed", false, "默认部件浅加载失败", { username: user.username, partpath, err: e?.message || String(e) }); reportPluginStatus(partpath, "shallow-load-error", e?.message); sendEventToUser(user.username, "part-load-error", { partpath, status: "shallow-load-error", detail: e?.message || String(e) }); return 0; })
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
 * 完整预加载单用户的全部功能插件 + defaultParts 记录的部件（loadPart 完整生命周期：Init+Load+SetData 进 parts_set）。
 * why：浅加载只 import 暖 V8 模块缓存，部件首次被面板/对话触碰仍要在请求路径上跑 Init/Load（重插件秒级等待）。
 *   本函数把这段成本移到启动后台；用户之后打开任何功能命中 loadPart 缓存前置（本文件 472 行 isPartLoaded 分支）即时返回。
 * 覆盖面 = 已安装插件全集（getPartList 'plugins'，含未进 defaultParts 的新插件）∪ defaultParts 全部记录（shells 等）。
 * 并发安全：parts_init / parts_set 均以 in-flight Promise 兼作并发守卫（loadPartBase），与请求路径懒加载并跑无双初始化。
 * @param {object | string} user - 用户对象或用户名。
 * @returns {Promise<void>}
 */
async function fullLoadAllPartsForUser(user) {
	if (Object(user) instanceof String) user = getUserByUsername(user)
	const partpaths = new Set(getPartList(user.username, 'plugins').map(name => 'plugins/' + name))
	const defaultParts = user.defaultParts ?? {}
	for (const parent in defaultParts)
		for (const child of defaultParts[parent] ?? [])
			partpaths.add(parent + '/' + child)
	wbTrace(null, "startup", "fullLoadAllParts:user", { username: user.username, count: partpaths.size })
	await Promise.allSettled([...partpaths].map(partpath => {
		if (!fs.existsSync(GetPartPath(user.username, partpath) + '/main.mjs')) return Promise.resolve()
		return loadPart(user.username, partpath, { username: user.username })
			// 顺手预热详情缓存（parts_details_cache）：getAllCachedPartDetails 只回已缓存项，
			// 不预热则插件列表等消费者对从未打开过的插件拿不到 info.json 文案（描述空白）。部件已在内存，此调用零重载成本。
			.then(() => getPartDetails(user.username, partpath))
			.catch(e => {
			wbDetect(null, "startup", "fullLoadAllParts:load_failed", false, "部件启动全量预加载失败", { username: user.username, partpath, err: e?.message || String(e) })
			reportPluginStatus(partpath, "preload-error", e?.message)
			sendEventToUser(user.username, "part-load-error", { partpath, status: "preload-error", detail: e?.message || String(e) })
		})
	}))
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
		try {
			const part = await baseMjsPartLoader(path)
			await part.Load?.(Initargs)
			return part
		}
		catch (e) {
			wbDetect(null, "parts", "loadPartBase:part_Load_failed", false, "部件 Load 失败（已回滚卸载）", { username, partpath, path, err: e?.message || String(e) })
			await baseMjsPartUnloader(path).catch(() => 0)
			throw e
		}
	},
	afterLoad = part => { },
	Initer = async (path, Initargs) => {
		const part = await baseMjsPartLoader(path)
		await part.Init?.(Initargs)
		notifyPartInstall(username, partpath)
		return part
	},
	afterInit = part => { },
} = {}) {
	// 已加载（内存中 part 实例已存在且非 Promise）时跳过 trace，避免每次请求路由都刷屏
	if (!(parts_set[username]?.[partpath]) || parts_set[username][partpath] instanceof Promise)
		wbTrace(null, "parts", "loadPartBase:enter", { username, partpath })
	Initargs = {
		router: getPartRouter(username, partpath),
		username,
		...Initargs
	}
	parts_set[username] ??= {}
	const parts_init = loadData(username, 'parts_init')
	const parts_config = loadData(username, 'parts_config')
	// ★ D1：worker isolate 走 per-isolate 内存门跑 part.Init（不碰磁盘 parts_init，主进程语义不变）
	const _inWorker = !!globalThis.__BEILU_WORKER_ISOLATE
	try {
		if (_inWorker) {
			// worker isolate：本 isolate 没跑过该 part 的 Init 才跑（in-flight Promise 兼作并发守卫）。
			//   不回写磁盘 parts_init、不抢 install-once 记录（install 由主进程一次性完成）。
			const _isoMap = (_isolateInited[username] ??= {})
			if (!_isoMap[partpath])
				_isoMap[partpath] = initPart(username, partpath, Initargs, { pathGetter, Initer, afterInit })
			try { await _isoMap[partpath] }
			catch (error) { delete _isoMap[partpath]; throw error } // init 失败清缓存 Promise，允许重试
		}
		// 只认 true=已初始化、Promise=正在初始化（并发守卫）；其余值（如 Promise 落盘残骸 {}）一律重新 init
		else if (parts_init[partpath] !== true && !(parts_init[partpath] instanceof Promise)) {
			try {
				const profile = await doProfile(async () => {
					parts_init[partpath] = initPart(username, partpath, Initargs, { pathGetter, Initer, afterInit })
					parts_init[partpath] = await parts_init[partpath]
				})
				console.logI18n('beiluConsole.partManager.partInited', {
					partpath
				})
				console.log(profile)
				reportPluginStatus(partpath, "inited", { profile });
				parts_init[partpath] = true
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
						Loader: async path => await Loader(path, Initargs)
					})
					try {
						await part.interfaces?.config?.SetData?.(parts_config[partpath] ?? {})
					}
					catch (error) {
						wbDetect(null, "parts", "loadPartBase:setdata_failed", false, "部件 config.SetData 失败", { username, partpath, err: error?.message || String(error) })
						console.error(`Failed to set data for part ${partpath}: ${error.message}\n${error.stack}`)
					}
					await afterLoad(part)
					return part
				})()
				try {
					parts_set[username][partpath] = await parts_set[username][partpath]
				} catch (loadErr) {
					// rejected Promise 残留在 parts_set 会让后续所有调用卡死——清掉允许重试
					delete parts_set[username][partpath]
					throw loadErr
				}
			})
			console.logI18n('beiluConsole.partManager.partLoaded', {
				partpath
			})
			console.log(profile)
			events.emit('part-loaded', { username, partpath })
			wbTrace(null, "parts", "loadPartBase:loaded", { username, partpath })
			reportPluginStatus(partpath, "loaded");
		}
		if (parts_set[username][partpath] instanceof Promise)
			parts_set[username][partpath] = await parts_set[username][partpath]
	}
	finally {
		setDefaultStuff()
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
} = {}) {
	const part = await Initer(pathGetter(), Initargs)
	await afterInit(part)
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
	unLoader = part => part.Unload?.(unLoadargs),
	afterUnload = baseMjsPartUnloader
} = {}) {
	/** @type {T} */
	const part = parts_set[username]?.[partpath]
	if (!part) return
	try {
		await unLoader(part)
		await deletePartRouter(username, partpath)
	}
	catch (error) {
		wbDetect(null, "parts", "unloadPartBase:unload_failed", false, "部件卸载失败", { username, partpath, err: error?.message || String(error) })
		console.error(error)
		reportPluginStatus(partpath, "unload-error", error?.message || String(error));
	}
	await afterUnload(pathGetter(), unLoadargs)
	delete parts_set[username][partpath]
	if (!Object.keys(parts_set[username]).length) delete parts_set[username]
	delete parts_load_results[username][partpath]
	if (!Object.keys(parts_load_results[username]).length) delete parts_load_results[username]
	reportPluginStatus(partpath, "unloaded");
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
	try {
		await unloadPartBase(username, partpath, unLoadargs, { unLoader })
	} catch (error) { console.error(error) }
	try {
		part ??= await baseloadPart(username, partpath, { Loader, pathGetter })
	} catch (error) { console.error(error) }
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

events.on('AfterUserDeleted', async ({ username }) => {
	if (parts_set[username]) {
		for (const partpath of Object.keys(parts_set[username])) {
			try { await unloadPart(username, partpath) } catch {}
		}
	}
	delete parts_set[username]
	delete _isolateInited[username]
	delete parts_load_results[username]
})

// 改名传导链（20260706）：旧名的已加载 part 实例必须卸载——实例内部捕获的是旧用户名，
//   残留会内存泄漏且后续写盘经 getUserDictionary(旧名) 兜底路径重建已挪走的旧目录。
//   挂 Before（非 After）：此刻用户目录还在旧位置、config 里用户还在，part.Unload 的落盘
//   写到正确的旧目录，随后被 renameUser 整体搬到新名下=状态无损迁移。新名首次请求懒加载重建。
events.on('BeforeUserRenamed', async ({ oldUsername }) => {
	if (parts_set[oldUsername]) {
		for (const partpath of Object.keys(parts_set[oldUsername])) {
			// 0715(近期diff审计后端#6):原 catch{} 静默吞错——卸载失败=旧实例残留(内存泄漏+旧目录重建风险),
			//   走本文件既有 wbDetect 留痕收口(同 :297/:441/:499),不新造通道;失败不中断其余 part 卸载。
			try { await unloadPart(oldUsername, partpath) } catch (e) { wbDetect(null, "parts", "BeforeUserRenamed:unload_failed", false, "改名前卸载 part 失败(旧实例可能残留)", { oldUsername, partpath, err: e?.message || String(e) }) }
		}
	}
	delete parts_set[oldUsername]
	delete _isolateInited[oldUsername]
	delete parts_load_results[oldUsername]
})

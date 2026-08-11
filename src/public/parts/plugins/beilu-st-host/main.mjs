/**
 * [beilu-st-host] 酒馆插件接口（宿主 + 转移层）— 一期后端实现体。
 *
 * 【定位】让用户对酒馆第三方插件（浏览器端 js + manifest.json 生态）完成"下载 → 转移 → 使用"。
 *   本文件是后端半区 + 域收口：安装（git clone → manifest 校验 → 失败回滚）/ 发现 / 启停 / 删除 /
 *   插件静态文件服务 / extension_settings 单源存储。安装入口有二：
 *   ① ImportHandlers/STPlugin（用户在导入界面贴 git 仓库 URL，识别后委托本文件 installFromGitUrl）
 *   ② POST st-plugins/install 端点（宿主管理面板按钮，同一函数收口）
 *   前端半区（host-loader / getContext 145 键 / 三容器 / 错误面板）由本 part 的 public/ 提供（后续批次）。
 *
 * 【设计依据】beilu的工作日志和项目日志\酒馆插件接口_宿主与转移层_20260806\设计_酒馆插件接口第一期.md（T1-T3）
 *   转换表：酒馆插件系统调查_20260806_1800\转换表_酒馆插件到beilu.md §1.1 加载链 / §1.4 安装禁用卸载语义
 *
 * 【红线】（设计 §3，逐条对应）
 *   1. 启停必须落后端且是加载前门槛——enabled 存 settings/st_plugins.json，前端 loader 对禁用插件根本不注入 js；
 *      全程无 localStorage 开关（EJS 0731 翻过车：本地开关=摆设，后端照跑）。
 *   2. 失败可见——manifest 损坏的插件仍进 discover 列表并带 error 字段（不学 ST 静默丢弃）。
 *   3. 删除可恢复——进 .trash/<name>_<时间戳>，不学 ST 裸 rm -rf（守则：能删必须能恢复）。
 *   4. 安全——ST 插件是任意 js 将跑在主页面：导入链带 needsConsent 提醒（仿角色卡导入范式）；
 *      files 端点 confinePath 防穿越 + authenticate 鉴权 + .git 目录不对外。
 *
 * 【功能链】ImportHandlers/STPlugin(识别 URL) → installFromGitUrl（本文件）→ data/users/<u>/st-plugins/<name>/
 *   → GET st-plugins/discover（前端管理面 + host-loader 数据源）→ toggle 落盘 → host-loader 只注入 enabled 项
 *   → 插件 js/css 经 GET st-plugins/files/<name>/* 回浏览器。
 *
 * 【存储】per-user：插件文件 data/users/<u>/st-plugins/<name>/；状态 settings/st_plugins.json
 *   （{hostEnabled, enabled:{name:bool}, settings:{extKey:object}}，经 loadData/saveData 单源，含内存缓存）。
 *   settings 即 ST extension_settings 的后端对等物——按顶层 key 粒度写，不整库覆盖（ST 已知瑕疵不继承）。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import fs from 'npm:fs-extra'

import { setDefaultPart } from '../../../../server/parts_loader.mjs'
import { loadData, saveData } from '../../../../server/setting_loader.mjs'
import { wbT, wbD } from '../../../../server/wbStub.mjs'
import { authenticate, getUserByReq, getUserDictionary } from '../../../../yonban/core/functions/security/auth.mjs'
import { confinePath, confineSegment } from '../../../../yonban/core/functions/security/path_confine.mjs'

import info from './info.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const API = '/api/parts/plugins\\:beilu-st-host'

/** 插件文件落盘根（per-user，随用户数据走，不进代码树） */
function stPluginsRoot(username) {
	return path.join(getUserDictionary(username), 'st-plugins')
}

/** 状态单源（loadData 带内存缓存；改完必须 saveData 落盘） */
function _store(username) {
	const data = loadData(username, 'st_plugins')
	data.hostEnabled ??= false
	data.enabled ??= {}
	data.settings ??= {}
	return data
}

/**
 * 判定一行文本是否像"git 仓库 URL"（酒馆插件的安装载体）。
 * 域收口：识别规则放宿主而不是 ImportHandler——文件类 URL（png/json/zip = 角色卡等其他导入器的输入）
 * 必须让位，否则会抢走 SillyTavern 角色卡导入器的输入（Installer 按 order 轮询，先认先得）。
 */
export function looksLikeGitRepoUrl(line) {
	const t = String(line || '').trim()
	if (!/^https?:\/\/\S+$/i.test(t)) return false
	if (/\.(png|jpg|jpeg|webp|gif|json|zip|charx|card)([#?]|$)/i.test(t)) return false
	if (/\.git([#?]\S*)?$/i.test(t)) return true
	// 常见托管站的 /owner/repo 两段形（不含更深路径——/raw/、/releases/ 等文件页不是仓库根）
	return /^https?:\/\/(www\.)?(github\.com|gitlab\.com|gitee\.com|codeberg\.org|bitbucket\.org)\/[^/\s]+\/[^/\s#?]+\/?([#?]\S*)?$/i.test(t)
}

/**
 * 安装：git clone → manifest 校验 → 失败回滚删除（照 ST src/endpoints/extensions.js 安装形状）。
 * URL 尾部 #<branch> 指定分支。新装默认禁用（启用是显式动作，红线1）。
 * @returns {Promise<{name: string, manifest: object}>}
 */
export async function installFromGitUrl(username, rawUrl) {
	let url = String(rawUrl || '').trim()
	let branch = ''
	const hashAt = url.indexOf('#')
	if (hashAt > 0) {
		branch = url.slice(hashAt + 1).trim()
		url = url.slice(0, hashAt)
	}
	const base = url.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '') || ''
	const name = confineSegment(base)
	if (!name) throw new Error(`[beilu-st-host] 无法从 URL 提取合法插件目录名：${rawUrl}`)

	const root = stPluginsRoot(username)
	const target = path.join(root, name)
	if (await fs.pathExists(target))
		throw new Error(`[beilu-st-host] 插件 "${name}" 已存在。如需重装请先在管理面删除（删除会进回收站，可恢复）`)

	await fs.ensureDir(root)
	try {
		await execFileAsync('git', ['clone', '--depth', '1', ...branch ? ['--branch', branch] : [], '--', url, target], { timeout: 120_000 })
	} catch (err) {
		await fs.remove(target).catch(() => {})
		wbD(null, 'st-host', 'install:clone_failed', false, '酒馆插件 git clone 失败', { username, url, branch, err: err?.message || String(err) })
		throw new Error(`[beilu-st-host] git clone 失败：${err?.message || err}。请确认 URL 是可公开访问的 git 仓库、网络可达、环境已装 git`)
	}

	let manifest
	try {
		manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf-8'))
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json 不是 JSON 对象')
	} catch (err) {
		// 坏 manifest = 不是酒馆插件仓库 → 整目录回滚删除，不留残目录（ST 同语义）
		await fs.remove(target).catch(() => {})
		wbD(null, 'st-host', 'install:bad_manifest', false, '仓库缺失/损坏 manifest.json，已回滚', { username, url, err: err?.message || String(err) })
		throw new Error(`[beilu-st-host] 仓库不是合法的酒馆插件（${err?.message || err}），已回滚删除`)
	}

	const store = _store(username)
	store.enabled[name] ??= false
	saveData(username, 'st_plugins')
	wbT(null, 'st-host', 'install_ok', { username, name, url, branch, displayName: manifest.display_name })
	return { name, manifest }
}

/**
 * 发现已安装插件。manifest 损坏的项不隐藏——带 error 字段进列表（红线2：失败可见）。
 * @returns {Promise<Array<{name:string, enabled:boolean, manifest:object|null, error:string|null}>>}
 */
export async function discoverStPlugins(username) {
	const root = stPluginsRoot(username)
	if (!await fs.pathExists(root)) return []
	const store = _store(username)
	const out = []
	for (const ent of await fs.readdir(root, { withFileTypes: true })) {
		if (!ent.isDirectory() || ent.name.startsWith('.')) continue
		const item = { name: ent.name, enabled: store.enabled[ent.name] === true, manifest: null, error: null }
		try {
			const manifest = JSON.parse(await fs.readFile(path.join(root, ent.name, 'manifest.json'), 'utf-8'))
			if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json 不是 JSON 对象')
			item.manifest = manifest
		} catch (err) {
			item.error = `manifest 读取失败：${err?.message || err}`
		}
		out.push(item)
	}
	return out
}

/** 启停（落后端 = 加载前门槛，红线1）。目录不存在时报错而不是静默记账。 */
export async function setStPluginEnabled(username, name, enabled) {
	const seg = confineSegment(String(name || ''))
	if (!seg || seg !== name) throw new Error(`[beilu-st-host] 非法插件名：${name}`)
	if (!await fs.pathExists(path.join(stPluginsRoot(username), seg)))
		throw new Error(`[beilu-st-host] 插件 "${seg}" 不存在，无法${enabled ? '启用' : '禁用'}`)
	const store = _store(username)
	store.enabled[seg] = !!enabled
	saveData(username, 'st_plugins')
	wbT(null, 'st-host', 'toggle', { username, name: seg, enabled: !!enabled })
	return { name: seg, enabled: !!enabled }
}

/** 删除 → .trash/<name>_<时间戳>（可恢复）。settings 保留（恢复后设置还在），enabled 记录移除。 */
export async function deleteStPlugin(username, name) {
	const seg = confineSegment(String(name || ''))
	if (!seg || seg !== name) throw new Error(`[beilu-st-host] 非法插件名：${name}`)
	const root = stPluginsRoot(username)
	const target = path.join(root, seg)
	if (!await fs.pathExists(target)) throw new Error(`[beilu-st-host] 插件 "${seg}" 不存在`)
	const ts = new Date().toISOString().replace(/[:.]/g, '-')
	const trash = path.join(root, '.trash', `${seg}_${ts}`)
	await fs.ensureDir(path.dirname(trash))
	await fs.move(target, trash)
	const store = _store(username)
	delete store.enabled[seg]
	saveData(username, 'st_plugins')
	wbT(null, 'st-host', 'delete_to_trash', { username, name: seg, trash })
	return { name: seg, trash }
}

const pluginExport = {
	info,
	Init: async () => {},
	Load: async ({ router, username } = {}) => {
		// 照 beilu-era 范式：Load 时自动注册为默认插件（保证多用户下端点随启动就位）
		try { setDefaultPart(username, 'plugins', 'beilu-st-host') } catch { /* 配置写失败不阻断加载 */ }
		if (!router) return

		// 破口B（照 beilu-files）：多用户共进程时按每请求解析 username，auth 异常回退 part-owner
		const reqUser = async (req) => {
			try { return (await getUserByReq(req)).username } catch { return username || '_default' }
		}

		router.get(`${API}/config/getdata`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const store = _store(u)
				res.json({ hostEnabled: store.hostEnabled, plugins: await discoverStPlugins(u) })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		router.post(`${API}/config/setdata`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const store = _store(u)
				if (req.body?.hostEnabled !== undefined) store.hostEnabled = !!req.body.hostEnabled
				saveData(u, 'st_plugins')
				res.json({ success: true, hostEnabled: store.hostEnabled })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		// discover：hostEnabled=false 时也返回列表（管理面要能看到并开启），host-loader 侧负责"禁用不注入"
		router.get(`${API}/st-plugins/discover`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				res.json({ hostEnabled: _store(u).hostEnabled, plugins: await discoverStPlugins(u) })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		router.post(`${API}/st-plugins/install`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const { url } = req.body || {}
				if (!url) return res.status(400).json({ error: '缺少 url' })
				res.json({ success: true, ...await installFromGitUrl(u, url) })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		router.post(`${API}/st-plugins/toggle`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const { name, enabled } = req.body || {}
				res.json({ success: true, ...await setStPluginEnabled(u, name, enabled) })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		router.post(`${API}/st-plugins/delete`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				res.json({ success: true, ...await deleteStPlugin(u, req.body?.name) })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		// extension_settings 后端单源：按顶层 key 粒度写（不整库覆盖——ST settings/save 零校验整体覆盖是已知瑕疵，不继承）
		router.get(`${API}/st-plugins/settings/getdata`, authenticate, async (req, res) => {
			try { res.json(_store(await reqUser(req)).settings) } catch (err) { res.status(500).json({ error: err.message }) }
		})

		router.post(`${API}/st-plugins/settings/setdata`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const { key, value } = req.body || {}
				if (!key || typeof key !== 'string') return res.status(400).json({ error: '缺少 key' })
				const store = _store(u)
				store.settings[key] = value
				saveData(u, 'st_plugins')
				res.json({ success: true })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})

		// ST 目录树镜像（一条路由收口全部插件静态文件 + 宿主 shim）。
		// 为什么要镜像树：酒馆插件 js 按 ST 的文件布局做相对 ESM 导入（`import ... from '../../../../script.js'`，
		// 6/6 样本插件如此，转换表§三第一必须项）——只有把插件挂在
		//   ${API}/st-mirror/scripts/extensions/third-party/<name>/<file>
		// 且宿主 shim（script.js / scripts/extensions.js 等）挂在同一棵树的对应位置，相对导入才能解析到 shim。
		//   - third-party 段 → 用户 st-plugins 目录（confinePath 防穿越；.git 不对外）
		//   - 其余路径     → part 自带 public/st-mirror/（shim 模块；缺失 = 404 带明确路径，帮助定位插件还需要哪个 shim）
		// Express 5（path-to-regexp v8）：裸 `*` 不再合法，必须命名通配 `*splat`，参数值是分段数组。
		// （2026-08-06 沙盒 1315 实测抓获：裸 `*` 在 Load 注册时抛 TypeError → 整 part 进加载退避。）
		// third-party 插件文件 serve 单源（st-mirror 树 与 页面根别名 两条路由共用；防散拼两份穿越防护）
		const serveThirdPartyFile = async (u, name, relFile, res) => {
			const seg = confineSegment(name)
			if (!seg || seg !== name || /^\.git([\\/]|$)/i.test(relFile)) return res.status(404).json({ error: 'not found' })
			const dir = path.join(stPluginsRoot(u), seg)
			if (!await fs.pathExists(dir)) return res.status(404).json({ error: `插件 "${seg}" 不存在` })
			const abs = confinePath(dir, relFile)
			if (!await fs.pathExists(abs)) return res.status(404).json({ error: 'not found' })
			return res.sendFile(abs)
		}

		router.get(`${API}/st-mirror/*splat`, authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const sp = req.params.splat
				const rel = Array.isArray(sp) ? sp.join('/') : String(sp || '')
				if (!rel || rel === '/') return res.status(404).json({ error: 'not found' })
				const tp = rel.match(/^scripts\/extensions\/third-party\/([^/]+)\/(.+)$/)
				if (tp) return await serveThirdPartyFile(u, tp[1], tp[2], res)
				const mirrorRoot = path.join(import.meta.dirname, 'public', 'st-mirror')
				const abs = confinePath(mirrorRoot, rel)
				if (!await fs.pathExists(abs)) return res.status(404).json({ error: `[beilu-st-host] 镜像树缺失：/${rel}（宿主 shim 未覆盖此路径，插件依赖的这个 ST 模块尚未提供）` })
				// [0807 拉线断点D] shim 段不再本路由 sendFile，307 转 /parts 静态树同路径。
				//   why：浏览器 ESM 的模块 base=响应最终 URL。shim 若从本 /api 前缀 serve，其内部相对
				//   import（extensions.js 的 `../../st-settings.mjs` 等）解析成 /api/parts/<part>/st-settings.mjs
				//   ——该 URL 无路由=404，整条 ESM 链断（沙盒 1315 拉线实测确诊；0806 E2E 样本插件无 shim
				//   import 故未暴露）。307 后 base 落 /parts/<part>/st-mirror/...（parts 静态树），二跳相对
				//   import 全在 /parts 树内闭合（st-settings.mjs 等实测 200）。third-party 段仍本路由
				//   serve（用户 data 目录，静态树够不到），其四级相对 import 解析回本路由 shim 路径→307→闭合。
				return res.redirect(307, `/parts/plugins:beilu-st-host/st-mirror/${rel.split('/').map(encodeURIComponent).join('/')}`)
			} catch (err) { res.status(err?.message?.includes('confinement') ? 403 : 500).json({ error: err.message }) }
		})

		// [0807 拉线断点B] 页面根相对路径资源别名：ST 官方模板插件用页面根相对路径拉自己的资源
		//   （st-input-helper index.js:12 `extensionFolderPath = "scripts/extensions/third-party/<name>"`
		//   → `$.get(extensionFolderPath + '/settings.html')`，官方模板形态）。ST 页面根真有 /scripts/*，
		//   beilu 页面根没有 → 404（沙盒 1315 后端拉线实测确诊）。补 1:1 别名——**只镜像 third-party 段**
		//   （不放开整个 /scripts 命名空间，防路由空间污染），serve 走上面单源函数（同一套穿越防护）。
		router.get('/scripts/extensions/third-party/*splat', authenticate, async (req, res) => {
			try {
				const u = await reqUser(req)
				const sp = req.params.splat
				const rel = Array.isArray(sp) ? sp.join('/') : String(sp || '')
				const mm = rel.match(/^([^/]+)\/(.+)$/)
				if (!mm) return res.status(404).json({ error: 'not found' })
				return await serveThirdPartyFile(u, mm[1], mm[2], res)
			} catch (err) { res.status(err?.message?.includes('confinement') ? 403 : 500).json({ error: err.message }) }
		})
	},
	Unload: async () => {},
	interfaces: {
		config: {
			// GetData/SetData 走 part 通用配置面（额外插件平台等消费）；与上面的 HTTP 端点同一 _store 单源。
			// [T065/T074 同款坑] 第二参 ctx.username 必须消费——漏了就读写 _default 桶（错用户）
			GetData: async (args, ctx) => {
				const u = ctx?.username || ''
				const store = _store(u)
				return { hostEnabled: store.hostEnabled, plugins: await discoverStPlugins(u) }
			},
			SetData: async (data, ctx) => {
				const u = ctx?.username || ''
				const store = _store(u)
				if (data?.hostEnabled !== undefined) store.hostEnabled = !!data.hostEnabled
				saveData(u, 'st_plugins')
				return { success: true }
			},
		},
	},
}

export default pluginExport

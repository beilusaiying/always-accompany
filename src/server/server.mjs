/**
 * Server 主模块 — 进程入口 init() 所在地，编排启动序列。不管路由注册（那是 web_server/index.mjs 的事），
 * 不管部件生命周期（那是 parts_loader.mjs 的事）。
 *
 * 链路：index.mjs → init() → 认证(initAuth) → IPC Server → Web Server(http/https.createServer) → 延迟加载默认部件
 * 影响：写 config.json（堆内存 EMA）、设终端标题、注册全局错误处理器、启动心跳/空闲检测
 * 相交：← index.mjs(唯一调用 init)  → auth.mjs(initAuth) / web_server/index.mjs(Express app) / parts_loader.mjs(shallowLoadAllDefaultParts)
 *
 * 启动时序关键约束：
 *   shallowLoadAllDefaultParts 不在 init 中直接 await，而是通过 setTimeout 2s + setInterval 1s 延迟轮询触发——
 *   条件为"启动超过 13s 或最近 1s 无 web 请求"，目的是让 web server 先就绪响应首批请求，不被批量加载阻塞。
 *   Web Server 启动使用临时 requestListener/upgradeListener 代理，getApp 懒加载 Express app 就绪后替换为真实 handler。
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { on_shutdown, unset_shutdown_listener } from 'npm:on-shutdown'
import supportsAnsi from 'npm:supports-ansi'

// beilu: 移除了 discordrpc / tray / autoupdate 的import
import { getMemoryUsage } from '../scripts/gc.mjs'
import { console } from '../scripts/i18n_core.mjs' // [0722 解环] console 改 i18n_core 叶子（i18n.mjs 上钻 auth/setting_loader，环成员禁引）
import { notify } from '../scripts/notify.mjs'
import { runSimpleWorker } from '../workers/index.mjs'

import { initAuth } from '../yonban/core/functions/security/auth.mjs'
import { __dirname, startTime } from './base.mjs'
import idleManager from './idle.mjs'
import { ReStartJobs } from './jobs.mjs'
import { shallowLoadAllDefaultParts, fullLoadAllParts, migrateStaleShells } from './parts_loader.mjs'
// [0722 解环] 环境态（config/data_path/save_config/restartor/skip_report/setDefaultStuff/setWindowTitle）
//   下沉 svr_state.mjs 叶子：下层模块（ratelimit/timers/jobs/auth/parts_loader）改引叶子，不再 import
//   本编排者文件——11 成员启动环因此解开。本处 re-export 保环外旧 import 路径（server.mjs 面）不断。
import { _initServerState, loadServerConfig, config, save_config, setDefaultStuff, setWindowTitle } from './svr_state.mjs'
export { config, data_path, restartor, save_config, setDefaultStuff, skip_report } from './svr_state.mjs'
import { startTimerHeartbeat } from './timers.mjs'
import { wbTrace, wbDetect, setAuditConfig } from './whitebox.mjs'
import { runEnvCheck } from './envCheck.mjs'

/**
 * 正在运行的服务器的基本 URL（如 http://localhost:1314）。
 * @type {string}
 */
export let hosturl
/**
 * 系统托盘对象。
 * @type {object}
 */
export let tray

/**
 * 上次 Web 请求的时间戳。
 * @type {number}
 */
export let lastWebRequestTime = 0
/**
 * 标记上次 Web 请求的时间戳。
 * @returns {void}
 */
export function webRequestHappend() {
	lastWebRequestTime = Date.now()
}

/**
 * 处理错误。
 * @param {Error} err - 错误对象。
 * @returns {void}
 */
function handleError(err) {
	notify('Error', err.message)
	console.error(err)
}

/**
 * 初始化并启动应用程序服务器及其组件。
 * @param {object} start_config - 用于启动应用程序的配置对象。
 * @returns {Promise<boolean>} 如果初始化成功，则解析为 true，否则为 false。
 */
export async function init(start_config) {
	_initServerState({ data_path: start_config.data_path, restartor: start_config.restartor })
	const starts = start_config.starts ??= {}
	for (const start of ['Base', 'IPC', 'Web']) starts[start] ??= true
	if (starts.Web) starts.Web = Object.assign({ mDNS: true }, starts.Web)
	let logoPromise
	if (starts.Base) {
		for (const event of ['error', 'unhandledRejection', 'uncaughtException']) {
			unset_shutdown_listener(event)
			process.on(event, handleError)
		}
		if (start_config.needs_output) logoPromise = runSimpleWorker('logogener')
		starts.Base = Object(starts.Base)
		for (const base of ['Jobs', 'Timers', 'Idle']) starts.Base[base] ??= true
		console.freshLineI18n('server start', 'beiluConsole.server.start')
	}

	loadServerConfig()
	// 存量迁移：一次性幂等修复老用户 config 里指向废弃 shell（beilu-home 等）的 defaultParts.shells。
	// why 位置：config 刚加载进内存、对外服务前 —— 改的是权威内存对象，随后 save_config 落盘，
	// 不存在"盘改被 live 内存回写覆盖"问题。幂等：已迁移用户再扫为 no-op。
	try {
		const _shellMig = migrateStaleShells()
		if (_shellMig.total) console.warn(`[server] 废弃 shell 迁移完成：${_shellMig.total} 个用户`, _shellMig.migrated)
	} catch (e) { console.warn('[server] 废弃 shell 迁移失败（不阻断启动）:', e?.message) }
	// SEC-AL: 安全审计日志装配（可配开关，默认关闭）
	const _auditEnvOn = String(globalThis.Deno?.env?.get?.("BEILU_AUDIT_LOG") || process.env.BEILU_AUDIT_LOG || "").toLowerCase() === "on";
	setAuditConfig({
		enabled: config.auditLog?.enabled === true || _auditEnvOn,
		dir: __dirname + "/data/audit",
	});
	if (starts.Base) await initAuth()

	if (starts.IPC) {
		const { IPCManager } = await import('./ipc_server/index.mjs')
		if (!await new IPCManager().startServer()) return false
	}
	let iconPromise
	if (starts.Tray || starts.Web || !fs.existsSync(__dirname + '/src/public/pages/favicon.ico'))
		iconPromise = runSimpleWorker('icongener').catch(console.error)

	let getApp
	if (starts.Web) try {
		const { port, https: httpsConfig, trust_proxy, mdns: mdnsConfig } = config // 获取 HTTPS 配置
		hosturl = (httpsConfig?.enabled ? 'https' : 'http') + '://localhost:' + port
		let server

		console.freshLineI18n('server start', 'beiluConsole.server.starting')
		const { initMdns } = starts.Web?.mDNS ? await import('./web_server/mdns.mjs') : {}
		let appPromise
		/**
		 * 懒加载地获取 Express 应用程序实例。
		 * @returns {Promise<import('npm:express').Application>} Express 应用程序实例。
		 */
		getApp = () => appPromise ??= import('./web_server/index.mjs').then(({ app }) => {
			app.set('trust proxy', trust_proxy ?? 'loopback')
			server.removeListener('request', requestListener)
			server.on('request', app)
			server.removeListener('upgrade', upgradeListener)
			server.on('upgrade', app.ws_on_upgrade)
			return app
		})
		/**
		 * 处理 HTTP 请求。
		 * @param {import('http').IncomingMessage} req - HTTP 请求对象。
		 * @param {import('http').ServerResponse} res - HTTP 响应对象。
		 * @returns {Promise<void>}
		 */
		const requestListener = async (req, res) => {
			try {
				const app = await getApp()
				return app(req, res)
			}
			catch (e) {
				console.error(e)
				res.statusCode = 500
				res.end('Internal Server Error: Could not load web server.')
			}
		}
		/**
		 * 处理 WebSocket 升级请求。
		 * @param {import('http').IncomingMessage} req - HTTP 请求对象。
		 * @param {import('net').Socket} socket - 客户端和服务器之间的网络套接字。
		 * @param {Buffer} head - 已升级流的第一个数据包。
		 * @returns {Promise<void>}
		 */
		const upgradeListener = async (req, socket, head) => {
			try {
				const app = await getApp()
				return app.ws_on_upgrade(req, socket, head)
			}
			catch (e) {
				console.error(e)
				socket.end()
			}
		}

		/**
		 * 监听特定地址
		 * @param {String} listenAddress 要监听的地址
		 * @returns {Promise<Boolean>} 是否本地
		 */
		const listen = async (listenAddress) => await new Promise((resolve, reject) => {
			const ansi_hosturl = supportsAnsi ? `\x1b]8;;${hosturl}\x1b\\${hosturl}\x1b]8;;\x1b\\` : hosturl

			const listen = [port, listenAddress].filter(Boolean)
			if (httpsConfig?.enabled)
				server = https.createServer({
					key: fs.readFileSync(path.resolve(httpsConfig.keyFile, __dirname)),
					cert: fs.readFileSync(path.resolve(httpsConfig.certFile, __dirname)),
				}, requestListener).listen(...listen, async () => {
					console.logI18n('beiluConsole.server.showUrl.https', { url: ansi_hosturl })
					if (starts.Web?.mDNS) initMdns(port, 'https', mdnsConfig)
					resolve(listenAddress == 'localhost')
				})
			else
				server = http.createServer(requestListener).listen(...listen, async () => {
					console.logI18n('beiluConsole.server.showUrl.http', { url: ansi_hosturl })
					if (starts.Web?.mDNS) initMdns(port, 'http', mdnsConfig)
					resolve(listenAddress == 'localhost')
				})

			// keep-alive 超时设 120 秒：Deno 默认 5s 导致 YonBan 30s 心跳间隔内连接被关闭，
			// 客户端复用已关闭 TCP 连接 → endReadableNT/fetch failed。120s 覆盖所有客户端心跳周期。
			server.keepAliveTimeout = 120_000;
			server.headersTimeout = 125_000;
			server.on('upgrade', upgradeListener)
			server.on('error', (err) => {
				// EADDRINUSE 判读:最常见成因=双开实例(exe 连点两次/旧黑窗没关)。裸打 Error 栈用户读不懂,
				// 换成可行动的一行;其余错误保留完整对象(栈进 errors 监控)。
				if (err?.code === 'EADDRINUSE')
					console.error(`端口 ${port} 已被占用——通常是已有一个 always accompany 在运行(旧的黑色窗口没关?)。请关闭旧窗口后重试;确要双开请改 data/config.json 的 port。`)
				else
					console.error(err)
				server.close(() => {
					server = null
					reject(err)
				})
			})
		})
		// beilu SEC-T3：监听地址安全默认。
		// 优先级：env BEILU_LISTEN > config.listen > 默认 'localhost'(loopback)。
		// 安全默认：未显式配置时仅绑 127.0.0.1，不对全网卡(0.0.0.0)暴露。
		// owner 放宽：设 config.listen 或 env BEILU_LISTEN（如 '0.0.0.0' / 具体网卡 IP）即按其绑定，
		// 此时下方 LAN IP 提示逻辑(!is_localhost)自然生效。空字符串视为未设。
		const listenAddress = (process.env.BEILU_LISTEN || '').trim() || config.listen || 'localhost'
		let is_localhost
		try {
			is_localhost = await listen(listenAddress)
		}
		catch (error) {
			if (error.code === 'EACCES')
				is_localhost = await listen('localhost')
			else throw error
		}

		// beilu: 打印局域网访问地址 + 自动加入Host白名单
		if (!is_localhost) {
			const lanIps = getLanIPs()
			if (lanIps.length > 0) {
				// 自动将局域网IP加入运行时白名单（不持久化）
				if (!config.hostWhitelist) config.hostWhitelist = []
				for (const ip of lanIps) {
					if (!config.hostWhitelist.includes(ip)) config.hostWhitelist.push(ip)
				}
				const protocol = httpsConfig?.enabled ? 'https' : 'http'
				console.log('')
				console.log('  📱 局域网访问地址:')
				for (const ip of lanIps) {
					const lanUrl = `${protocol}://${ip}:${port}`
					console.log(`     ${lanUrl}`)
				}
				console.log('')
			}
		}
	} catch (e) {
		// Web 启动失败=服务不可用(浏览器 UI 是唯一用户界面),不得继续宣布"服务器已启动"制造僵尸态
		// (2026-07-20 全链审计:此前吞错继续跑,端口被占等场景用户看到"已启动"但浏览器永远打不开)。
		// 明示+非零退出:run.bat 对非 131/255 退出码 pause 保窗,错误可读。
		console.error(e)
		console.error('[server] Web 服务启动失败,进程退出——上方错误即原因(常见:端口被占/证书文件缺失)。')
		process.exit(1)
	}

	// beilu: 移除了Tray创建
	if (starts.Base) {
		console.freshLineI18n('server start', 'beiluConsole.server.ready')
		const titleBackup = process.title
		on_shutdown(() => setWindowTitle(titleBackup))
		setDefaultStuff()
		// beilu: 自定义品牌输出（替换原logo和统计信息）
		if (start_config.needs_output) {
			console.log('')
			console.log('  always accompany')
			console.log('  永远在你身边')
			console.log('')
		}
		runEnvCheck().catch((e) => console.warn('[envCheck] 环境检查失败（不影响运行）:', e?.message))
	}
	// 启动时全量预加载（同步 await）：组件在接受首个用户请求前全部加载完毕。
	// 原延迟方案（setTimeout 2s + setInterval 1s + 13s 强制超时）导致首个用户连接时触发懒加载，
	// 前端同时启动轮询 → 请求打到空后端 → 超时级联。改为同步预加载：启动多 1-2 秒，但用户打开时一切就绪。
	// 后续除非有新部件/代码变动，不重新加载（懒更新）。
	getApp?.()
	if (starts.Base) {
		if (starts.Base.Jobs) await ReStartJobs().catch(e => console.warn("[startup] ReStartJobs 失败:", e?.message))
		wbTrace(null, "startup", "shallowLoadAllDefaultParts:begin", null)
		await shallowLoadAllDefaultParts().catch(e => { wbDetect(null, "startup", "shallowLoadAllDefaultParts:failed", false, "启动期默认部件批量加载抛错", { err: e?.message || String(e) }); throw e })
		wbTrace(null, "startup", "shallowLoadAllDefaultParts:done", null)
		wbTrace(null, "startup", "fullLoadAllParts:begin", null)
		await fullLoadAllParts().catch(e => wbDetect(null, "startup", "fullLoadAllParts:failed", false, "启动期部件全量完整预加载抛错", { err: e?.message || String(e) }))
		wbTrace(null, "startup", "fullLoadAllParts:done", null)
		if (starts.Base.Timers) startTimerHeartbeat()
		if (starts.Base.Idle) idleManager.start()
		// beilu: 自动更新已禁用
		idleManager.onIdle(setDefaultStuff)
		idleManager.onIdle(() => {
			config.prelaunch ??= {}
			const currentHeap = getMemoryUsage()
			const oldHeap = config.prelaunch.heapSize / 1.5 || currentHeap
			config.prelaunch.heapSize = Math.round((oldHeap * 12 + currentHeap) / 13 * 1.5)
			save_config()
		})
	}
	// beilu: Discord RPC 已移除
	if (!fs.existsSync(__dirname + '/src/public/pages/favicon.ico')) await iconPromise

	return true
}

/**
	* 获取本机局域网 IP 地址列表
	* @returns {string[]} IPv4 局域网地址数组
	*/
export function getLanIPs() {
	const interfaces = os.networkInterfaces()
	const ips = []
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === 'IPv4' && !iface.internal) {
				ips.push(iface.address)
			}
		}
	}
	return ips
}


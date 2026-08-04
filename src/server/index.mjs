/**
 * index.mjs — 进程入口点（Deno 启动的第一个文件）。不管 Express 路由/中间件装配（那是 web_server/index.mjs 的事）。
 *
 * 职责：
 *   1. 构建 beilu_config（restartor 退出码/data_path/starts 开关）
 *   2. fs.watch 监听 .nojobs/.notimers/.noidle/.noupdate 热开关文件
 *   3. 解析命令行参数（run/shutdown/reboot）
 *   4. 调用 init(beilu_config) 启动服务器（唯一调用点）
 *   5. 命令行命令通过 IPC 发送
 *
 * 链路：Deno → 本文件 → server.mjs init()（唯一调用点）
 * 影响：process.exit（启动失败/命令执行后退出）；fs.watch 文件监听器
 * 相交：→ server.mjs(init) / jobs.mjs(PauseAllJobs/ReStartJobs) / timers.mjs(startTimerHeartbeat/stopTimerHeartbeat)
 *       → idle.mjs(idleManager.start/stop) / autoupdate.mjs(enableAutoUpdate/disableAutoUpdate) / ipc_server
 */
import fs from 'node:fs'
import process from 'node:process'

import { console } from '../scripts/i18n.mjs'

import { disableAutoUpdate, enableAutoUpdate } from './autoupdate.mjs'
import { __dirname, set_start } from './base.mjs'
import idleManager from './idle.mjs'
import { PauseAllJobs, ReStartJobs } from './jobs.mjs'
import { init } from './server.mjs'
import { startTimerHeartbeat, stopTimerHeartbeat } from './timers.mjs'

// beilu: Sentry 已完全移除
export let sentry_enabled = false
console.noBreadcrumb = {
	log: (...args) => console.log(...args)
}

set_start()

console.logI18n('beiluConsole.server.standingBy')

let args = process.argv.slice(2)

/**
 * 应用程序的主配置对象。
 * @type {object}
 */
const beilu_config = {
	restartor: () => process.exit(131),
	// beilu-sandbox: 支持通过环境变量 BEILU_DATA_DIR 指定独立 data 路径（沙箱隔离用）
	data_path: process.env.BEILU_DATA_DIR || __dirname + '/data',
	needs_output: process.stdout.writable && process.stdout.isTTY,
	starts: {
		Base: {
			Jobs: !fs.existsSync(__dirname + '/.nojobs'),
			Timers: !fs.existsSync(__dirname + '/.notimers'),
			Idle: !fs.existsSync(__dirname + '/.noidle'),
			AutoUpdate: !fs.existsSync(__dirname + '/.noupdate'),
		}
	}
}

// [0722 排雷] fs.watch 包 try：网络盘/受限文件系统上 watch 可 throw，原顶层裸调=启动即崩。
//   降级=运行期 .nojobs/.notimers/.noidle/.noupdate 旗标热切换失效（可见 warn），启动时旗标仍生效（:52 读一次）。
try {
	fs.watch(__dirname, (event, filename) => {
		// beilu: .noerrorreport 监听已移除（无Sentry）
		if (filename == '.nojobs')
			if (fs.existsSync(__dirname + '/.nojobs')) PauseAllJobs().catch(console.error)
			else ReStartJobs().catch(console.error)
		if (filename == '.notimers')
			if (fs.existsSync(__dirname + '/.notimers')) stopTimerHeartbeat()
			else startTimerHeartbeat()
		if (filename == '.noidle')
			if (fs.existsSync(__dirname + '/.noidle')) idleManager.stop()
			else idleManager.start()
		if (filename == '.noupdate')
			if (fs.existsSync(__dirname + '/.noupdate')) disableAutoUpdate()
			else enableAutoUpdate()
	})
} catch (e) {
	console.warn('[server] 旗标文件热监听不可用（.nojobs/.notimers/.noidle/.noupdate 热切换失效，启动态旗标不受影响）:', e?.message || e)
}

let command_obj

// 解析命令行参数。
if (args.length) {
	const command = args[0]
	args = args.slice(1)

	if (command == 'run') {
		const username = args[0]
		const partpath = args[1]
		args = args.slice(2) // 透传参数从 index 2 起（[0]=username [1]=partpath）；原 slice(3) 会吞掉首个透传参数

		command_obj = {
			type: 'runpart',
			data: { username, partpath, args },
		}
	}
	else if (command == 'shutdown' || command == 'reboot') {
		command_obj = {
			type: command,
		}
		beilu_config.starts = {
			Base: false,
			Web: false,
		}
	}
	else {
		console.errorI18n('beiluConsole.ipc.invalidCommand')
		process.exit(1)
	}
}
// 初始化应用程序。
const okey = await init(beilu_config)

// 自动更新只在服务器成功进入服务态后启用。此前仅有 .noupdate 的热切换分支，
// 首次启动时 starts.Base.AutoUpdate=true 却没有实际定时器，形成“配置显示开启、机制未运行”的假状态。
if (okey && beilu_config.starts?.Base?.AutoUpdate) enableAutoUpdate()

// 如果提供了命令，则通过 IPC 发送。
if (command_obj) try {
	if (!beilu_config.starts.IPC) throw new Error('cannot send command when IPC not enabled')
	const { IPCManager } = await import('./ipc_server/index.mjs')
	const result = await IPCManager.sendCommand(command_obj.type, command_obj.data)
	switch (command_obj.type) {
		case 'runpart': {
			const { outputs } = result
			console.log(outputs)
		}
	}
} catch (err) {
	if (['shutdown', 'reboot'].includes(command_obj.type) && String(err.message).endsWith('read ECONNRESET')) process.exit(0)
	console.errorI18n('beiluConsole.ipc.sendCommandFailed', { error: err })
	throw err
}
// 如果初始化失败则退出。
if (!okey) process.exit(0)

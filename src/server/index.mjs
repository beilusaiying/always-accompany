/**
 * beilu-always accompany 服务器主入口点。
 * 已移除 Sentry 错误报告。
 */
import fs from 'node:fs'
import process from 'node:process'

import { console } from '../scripts/i18n.mjs'

import { disableAutoUpdate, enableAutoUpdate } from './autoupdate.mjs'
import { __dirname, set_start } from './base.mjs'
import { IdleManager } from './idle.mjs'
import { PauseAllJobs, ReStartJobs } from './jobs.mjs'
import { init } from './server.mjs'
import { startTimerHeartbeat, stopTimerHeartbeat } from './timers.mjs'

// beilu: Sentry 已完全移除
export let sentry_enabled = false
console.noBreadcrumb = {
	log: (...args) => console.log(...args)
}

set_start()

console.logI18n('fountConsole.server.standingBy')

let args = process.argv.slice(2)

/**
 * 应用程序的主配置对象。
 * @type {object}
 */
const beilu_config = {
	restartor: () => process.exit(131),
	data_path: __dirname + '/data',
	needs_output: process.stdout.writable && process.stdout.isTTY,
	starts: {
		Base: {
			Jobs: !fs.existsSync(__dirname + '/.nojobs'),
			Timers: !fs.existsSync(__dirname + '/.notimers'),
			Idle: !fs.existsSync(__dirname + '/.noidle'),
			AutoUpdate: false, // beilu: 自动更新永久禁用
		}
	}
}

fs.watch(__dirname, (event, filename) => {
	// beilu: .noerrorreport 监听已移除（无Sentry）
	if (filename == '.nojobs')
		if (fs.existsSync(__dirname + '/.nojobs')) PauseAllJobs().catch(console.error)
		else ReStartJobs().catch(console.error)
	if (filename == '.notimers')
		if (fs.existsSync(__dirname + '/.notimers')) stopTimerHeartbeat()
		else startTimerHeartbeat()
	if (filename == '.noidle')
		if (fs.existsSync(__dirname + '/.noidle')) IdleManager.stop()
		else IdleManager.start()
	if (filename == '.noupdate')
		if (fs.existsSync(__dirname + '/.noupdate')) disableAutoUpdate()
		else enableAutoUpdate()
})

let command_obj

// 解析命令行参数。
if (args.length) {
	const command = args[0]
	args = args.slice(1)

	if (command == 'run') {
		const username = args[0]
		const partpath = args[1]
		args = args.slice(3)

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
		console.errorI18n('fountConsole.ipc.invalidCommand')
		process.exit(1)
	}
}
// 初始化应用程序。
const okey = await init(beilu_config)

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
	console.errorI18n('fountConsole.ipc.sendCommandFailed', { error: err })
	throw err
}
// 如果初始化失败则退出。
if (!okey) process.exit(0)

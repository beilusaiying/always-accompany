import { gc } from '../scripts/gc.mjs'
import { console } from '../scripts/i18n_core.mjs' // [0722 解环] console 叶子

import { getUserByUsername, getAllUserNames } from '../yonban/core/functions/security/auth.mjs'
import { events } from './events.mjs'
import {
	loadPart,
	enableLoadPartRecording,
	disableLoadPartRecording,
	getLoadPartCallRecords,
} from './parts_loader.mjs'
import { config, save_config } from './svr_state.mjs' // [0722 解环] 环境态叶子

/**
 * 启动一个新作业并保存其状态。
 * @param {string} username - 拥有该作业的用户的用户名。
 * @param {string} partpath - 作业所属部件的路径。
 * @param {string} uid - 作业的唯一标识符。
 * @param {any} [data=null] - 与作业关联的可选数据。
 * @returns {void}
 */
export function StartJob(username, partpath, uid, data = null) {
	const jobs = getUserByUsername(username).jobs ??= {}
	jobs[partpath] ??= {}
	jobs[partpath][uid] = data
	try {
		save_config()
	}
	catch (err) {
		console.error(err)
		EndJob(username, partpath, uid)
	}
}
/**
 * 结束一个作业并移除其状态。
 * @param {string} username - 拥有该作业的用户的用户名。
 * @param {string} partpath - 作业所属部件的路径。
 * @param {string} uid - 作业的唯一标识符。
 * @returns {void}
 */
export function EndJob(username, partpath, uid) {
	const jobs = getUserByUsername(username).jobs ??= {}
	if (jobs?.[partpath]?.[uid] !== undefined) {
		delete jobs[partpath][uid]
		if (!Object.keys(jobs[partpath]).length)
			delete jobs[partpath]

		save_config()
	}
	else {
		console.warn('Job not found:', { username, partpath, uid })
		throw new Error('Job not found')
	}
}
/**
 * 重新启动特定用户的所有作业。
 * @param {string} username - 应重新启动其作业的用户的用户名。
 * @returns {Promise<number>} 一个解析为已重新启动作业数量的承诺。
 */
// [0804 根因修·B4] 单个 job 的启动 await 上限。ReStartJob 的实现体在各平台 bot 插件里，
//   对永久平台错误可能 while(true) 无期限重试且从不 resolve promise；startJobsOfUser 又被
//   ReStartJobs → server.mjs:288 `await ReStartJobs()` 串在启动链上 → 单个 bot 卡住 = 整个
//   服务器启动无限等待（03 §九.5 真启动永久等待风险）。给每个 job 的 restart 加 deadline：
//   到期不再 await（转后台继续重试，不阻塞 boot；不 cancel——bot 内部循环归 B5 backlog 单独治）。
const JOB_RESTART_STARTUP_DEADLINE_MS = Math.max(
	1000,
	parseInt(process.env.BEILU_JOB_RESTART_STARTUP_DEADLINE_MS, 10) || 30000,
)

async function startJobsOfUser(username) {
	const jobs = getUserByUsername(username).jobs ?? {}
	const promises = []
	for (const partpath in jobs)
		for (const uid in jobs[partpath])
			promises.push((async () => {
				console.logI18n('beiluConsole.jobs.restartingJob', { username, partpath, uid })
				const part = await loadPart(username, partpath)
				// 有界 await：restart 与 deadline 竞速。超时 → 不再阻塞启动，restart 在后台继续
				//   （其内部重试循环不受影响），并留可见告警，不静默吞。
				const _restart = Promise.resolve(part.interfaces.jobs.ReStartJob(username, jobs[partpath][uid] ?? uid))
				let _timer
				const _deadline = new Promise((resolve) => {
					_timer = setTimeout(() => resolve('__job_restart_deadline__'), JOB_RESTART_STARTUP_DEADLINE_MS)
				})
				const _r = await Promise.race([_restart.then(() => '__done__'), _deadline])
				clearTimeout(_timer)
				if (_r === '__job_restart_deadline__') {
					console.warn(`[startup] 作业重启超过 ${JOB_RESTART_STARTUP_DEADLINE_MS}ms 未完成，转后台继续（不阻塞启动）: ${username}/${partpath}/${uid}`)
					// 后台继续，吞其后续 reject（已脱离启动 await，避免 unhandledRejection）
					_restart.catch(console.error)
				}
			})().catch(console.error))
	await Promise.all(promises)
	return promises.length
}

/**
 * 从config.prelaunch.jobparts预加载所有记录的部件。
 * @returns {Promise<void>}
 */
function preloadPartsFromConfig() {
	const prelaunchParts = config.prelaunch?.jobparts || []
	if (!prelaunchParts.length) return

	console.logI18n('beiluConsole.jobs.preloadingParts', { count: prelaunchParts.length })
	prelaunchParts.map(async (record) => {
		const [username, partpath] = record.split(':')
		if (!username || !partpath) return
		try {
			await loadPart(username, partpath, { username })
		} catch (error) {
			console.error(`Failed to preload part ${partpath} for user ${username}:`, error)
		}
	})
}
/**
 * 暂停指定用户的所有作业（停止运行中的实例，但保留 config 中的作业数据以便恢复）。
 * @param {string} username - 用户名。
 * @returns {Promise<number>} 解析为已暂停作业数量的 Promise。
 */
async function pauseJobsOfUser(username) {
	const jobs = getUserByUsername(username).jobs ?? {}
	const promises = []
	for (const partpath in jobs)
		for (const uid in jobs[partpath])
			promises.push((async () => {
				console.logI18n('beiluConsole.jobs.pausingJob', { username, partpath, uid })
				const part = await loadPart(username, partpath)
				await part.interfaces.jobs.PauseJob(username, uid)
			})().catch(console.error))
	await Promise.all(promises)
	return promises.length
}

/**
 * 暂停所有用户的所有作业。
 * @returns {Promise<void>}
 */
export async function PauseAllJobs() {
	await Promise.all(getAllUserNames().map(pauseJobsOfUser))
}

/**
 * 重新启动所有用户的所有作业。
 * @returns {Promise<void>}
 */
export async function ReStartJobs() {
	preloadPartsFromConfig()
	enableLoadPartRecording()
	try {
		const count = (await Promise.all(getAllUserNames().map(startJobsOfUser))).reduce((a, b) => a + b, 0)
		if (count) gc()
	}
	finally {
		(config.prelaunch ??= {}).jobparts = getLoadPartCallRecords()
		disableLoadPartRecording()
		save_config()
	}
}

events.on('AfterUserRenamed', async ({ oldUsername, newUsername }) => {
	await startJobsOfUser(newUsername)
})

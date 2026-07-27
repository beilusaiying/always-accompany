import { clearInterval, setInterval } from 'node:timers'

import { async_eval } from 'npm:@steve02081504/async-eval'
import { getAllContextData, runWithContexts } from 'npm:als-registry'

import { getAllUserNames, getUserByUsername } from '../yonban/core/functions/security/auth.mjs'
import { loadPart } from './parts_loader.mjs'
import { deployGatedAllow } from '../yonban/core/functions/security/path_confine.mjs'
import { save_config } from './svr_state.mjs' // [0722 解环] 环境态叶子

// SEC-R6：timer.trigger 经 async_eval 在【服务端进程】跑任意 JS（与 change-prompt T12 同 RCE 类原语，
//   无沙箱、心跳每 500ms 触发）。本 fork 虽无 setTimer 调用者(dormant)，但 timer 持久化于 config，
//   一旦被写入(未来 part / 攻击者写 user.timers)即服务端 RCE。框架级正解：所有服务端字符串 eval sink
//   统一纳入 deployGatedAllow —— local 放行；server 默认不 eval（trigger 视为不触发），
//   owner 显式 env BEILU_TIMER_EVAL=on 或 config.allowTimerEval=true 才放行。
let _timerEvalWarned = false

/**
 * 为用户设置一个新计时器。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {string} uid - 计时器的唯一标识符。
 * @param {object} options - 计时器选项。
 * @param {string} options.trigger - 计时器的触发条件。
 * @param {any} options.callbackdata - 传递给回调函数的数据。
 * @param {boolean} [options.repeat=false] - 计时器是否应重复。
 * @returns {void}
 */
export function setTimer(username, partpath, uid, { trigger, callbackdata, repeat }) {
	const timers = getUserByUsername(username).timers ??= {}
	timers[partpath] ??= {}
	timers[partpath][uid] = {
		trigger,
		callbackdata,
		repeat: repeat ?? false,
		asynccontexts: getAllContextData()
	}
	try {
		save_config()
	}
	catch (err) {
		console.error(err)
		removeTimer(username, partpath, uid)
	}
}

/**
 * 为用户移除一个计时器。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @param {string} uid - 计时器的唯一标识符。
 * @returns {void}
 */
export function removeTimer(username, partpath, uid) {
	const timers = getUserByUsername(username).timers ?? {}
	if (timers[partpath]?.[uid]) {
		delete timers[partpath][uid]
		if (!Object.keys(timers[partpath]).length)
			delete timers[partpath]

		save_config()
	}
	else {
		console.warn('Timer not found:', { username, partpath, uid })
		throw new Error('Timer not found')
	}
}

/**
 * 获取特定部件的所有计时器。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {object} 包含指定部件的计时器的对象。
 */
export function getTimers(username, partpath) {
	const timers = getUserByUsername(username).timers ?? {}
	return timers[partpath] ?? {}
}

// 心跳重入守卫：setInterval(TimerHeartbeat, 500) 不等待上一次 async 体完成即再次触发。
//   若某 timer 的 loadPart / TimerCallback 耗时 > 500ms，第二次心跳与第一次并发交错——
//   两次都遍历同一批 config 持久化的 timer 对象、读改 timer.triggered（边沿触发状态），
//   造成 triggered 竞态（重复触发 / 漏触发）。单线程 JS 跨 await 点仍存在此交错（非 CPU 竞争而是调度交错）。
//   守卫使同一时刻至多一次心跳在跑，overlap 直接跳过（下一 tick 再来），不改触发语义。
let _heartbeatRunning = false

/**
 * 检查并触发计时器的主心跳函数。
 * @returns {Promise<void>}
 */
async function TimerHeartbeat() {
	if (_heartbeatRunning) return
	_heartbeatRunning = true
	try {
		await _timerHeartbeatBody()
	} finally {
		_heartbeatRunning = false
	}
}

/**
 * 心跳主体（被重入守卫包裹）。
 * @returns {Promise<void>}
 */
async function _timerHeartbeatBody() {
	const users = getAllUserNames()
	let need_save = false
	// SEC-R6：本心跳内 trigger eval 是否放行（每心跳算一次，避免逐 timer 反复读盘）。
	const evalAllowed = deployGatedAllow('allowTimerEval', 'BEILU_TIMER_EVAL')
	if (!evalAllowed && !_timerEvalWarned) {
		_timerEvalWarned = true
		console.warn('[SEC-R6] server 部署模式下 timer.trigger 的 ${} eval 默认关闭（防服务端 RCE）；owner 可设 env BEILU_TIMER_EVAL=on 或 config.allowTimerEval=true 开启。')
	}
	for (const user of users) {
		// 心跳遍历内含 await，期间用户可能被删除（deleteUserAccount）→ getUserByUsername 返回 undefined，
		// 不加 ?. 会 TypeError 中断整个心跳，使所有用户的计时器停摆
		const timers = getUserByUsername(user)?.timers ?? {}
		for (const partpath in timers)
			for (const uid in timers[partpath]) {
				const timer = timers[partpath][uid]
				// 边沿触发：条件 false→true 跳变时触发一次
				// SEC-R6：server 未授权时不 eval trigger（视为不触发），防服务端 RCE。
				const fire = evalAllowed ? !!await async_eval(timer.trigger).then(v => v.result).catch(e => { if (!timer._triggerErrLogged) { timer._triggerErrLogged = true; console.warn(`[timers] trigger eval error (${uid}):`, e?.message); } return false; }) : false
				if (fire && !timer.triggered) {
					timer.triggered = true
					if (!timer.repeat) removeTimer(user, partpath, uid) // 先移除避免重复触发
					try {
						const part = await loadPart(user, partpath)
						await runWithContexts(timer.asynccontexts, () =>
							part.interfaces.timers.TimerCallback(user, uid, timer.callbackdata)
						)
						need_save = true
					} catch (err) { console.error(err) }
				} else if (!fire && timer.triggered && timer.repeat) {
					// 重复计时器：条件回落后重新武装，使下次跳变可再触发（修复原短路导致 repeat 只触发一次）
					timer.triggered = false
					need_save = true
				}
			}
	}
	if (need_save) save_config()
}

/**
 * 计时器心跳的定时器。
 * @type {number}
 */
let timer_heartbeat_interval = null
/**
 * 启动计时器心跳。
 * @returns {void}
 */
export function startTimerHeartbeat() {
	timer_heartbeat_interval ??= setInterval(TimerHeartbeat, 500).unref()
}
/**
 * 停止计时器心跳。
 * @returns {void}
 */
export function stopTimerHeartbeat() {
	if (timer_heartbeat_interval) clearInterval(timer_heartbeat_interval)
	timer_heartbeat_interval = null
}
/**
 * 重启计时器心跳。
 * @returns {void}
 */
export function restartTimerHeartbeat() {
	stopTimerHeartbeat()
	startTimerHeartbeat()
}

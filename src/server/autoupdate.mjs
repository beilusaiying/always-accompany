/**
 * autoupdate.mjs — Git 版本检测与用户确认后的安全快进更新。
 *
 * 定时器只检测，不再自行 pull/重启。应用更新必须经 owner API 明确确认，并在本模块
 * 重新校验工作区、目标提交与快进关系；本模块是更新状态与 apply single-flight 的唯一所有者。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { __dirname } from './base.mjs'
import { restartor } from './svr_state.mjs'

export let currentGitCommit = null

const execFileAsync = promisify(execFile)
const isGitRepo = existsSync(join(__dirname, '.git'))
const P1_RESTART_MARKER = join(__dirname, 'data', 'p1', '.service-restart-required.json')
let _initialCheckTimer = null
let _checking = false
let _enabled = false
let _restartScheduled = false
let _applyPromise = null
let _status = {
	phase: isGitRepo ? 'idle' : 'disabled', progress: 0,
	currentCommit: null, availableCommit: null, expectedCommit: null,
	message: isGitRepo ? '等待检查更新' : '当前安装不是 Git 仓库，无法在线更新', error: null,
}

function git(args) {
	try {
		return execFileSync('git', args, {
			cwd: __dirname, encoding: 'utf-8', timeout: 30000,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim()
	} catch { return null }
}

// 发行版的应用内更新只跟随公共仓库 origin/main；私人维护仓不进入运行时更新链。
const UPDATE_REMOTE = 'origin'

async function gitAsync(args) {
	try {
		const { stdout = '' } = await execFileAsync('git', args, {
			cwd: __dirname, encoding: 'utf-8', timeout: 30000,
			windowsHide: true, maxBuffer: 4 * 1024 * 1024,
		})
		return String(stdout).trim()
	} catch { return null }
}

function initCommitHash() {
	if (!isGitRepo) return
	currentGitCommit = git(['rev-parse', 'HEAD'])
	_status.currentCommit = currentGitCommit
}

// event_dispatcher 在完整服务态之前即可接受连接；模块加载时先建立真实版本基线，
// 避免首个 server-reconnected 因 enableAutoUpdate 尚未执行而携带空 commit。
initCommitHash()

async function publishStatus(phase, progress, patch = {}, eventName = 'update-progress') {
	_status = { ..._status, ...patch, phase, progress, updatedAt: new Date().toISOString() }
	try {
		const { sendEventToAll } = await import('./web_server/event_dispatcher.mjs')
		sendEventToAll(eventName, getUpdateStatus())
	} catch (e) {
		console.warn(`[更新] 状态通知失败（可由 /api/update/status 恢复）: ${e?.message || e}`)
	}
}

function failMessage(message) {
	return publishStatus('failed', 0, {
		availableCommit: null, expectedCommit: null, message, error: message,
	}, 'update-result')
}

function markP1RestartAfterUpdate(targetCommit) {
	try {
		mkdirSync(join(__dirname, 'data', 'p1'), { recursive: true })
		writeFileSync(P1_RESTART_MARKER, JSON.stringify({
			reason: 'application-update', targetCommit, createdAt: new Date().toISOString(),
		}), 'utf-8')
		return true
	} catch (e) {
		console.warn(`[更新] 无法写入 P1 重启标记，已取消更新以保持版本一致: ${e?.message || e}`)
		return false
	}
}

function clearP1RestartAfterFailedUpdate() {
	try {
		rmSync(P1_RESTART_MARKER, { force: true })
		return true
	} catch (e) {
		console.warn(`[更新] 更新未生效且无法撤销 P1 重启标记，请人工检查: ${e?.message || e}`)
		return false
	}
}

export function getUpdateStatus() {
	return { ..._status, enabled: _enabled, isGitRepo, busy: Boolean(_applyPromise), restartScheduled: _restartScheduled }
}

export async function detectRemoteUpdate() {
	if (!isGitRepo || !_enabled || _checking || _restartScheduled || _applyPromise) return getUpdateStatus()
	_checking = true
	await publishStatus('checking', 10, { message: '正在检查仓库版本', error: null })
	try {
		const trackedChanges = await gitAsync(['status', '--porcelain=v1', '--untracked-files=no'])
		if (trackedChanges == null) { await failMessage('无法读取工作区状态，已保持当前版本'); return getUpdateStatus() }
		if (trackedChanges) { await failMessage('检测到本地代码改动，更新已停止；不会覆盖这些文件'); return getUpdateStatus() }
		if (await gitAsync(['fetch', UPDATE_REMOTE, 'main', '--quiet']) == null) {
			await failMessage('连接更新仓库失败，可稍后重新检查')
			return getUpdateStatus()
		}
		const local = await gitAsync(['rev-parse', 'HEAD'])
		const remote = await gitAsync(['rev-parse', `${UPDATE_REMOTE}/main`])
		if (!local || !remote) { await failMessage('无法确认本地或仓库版本，已保持当前版本'); return getUpdateStatus() }
		currentGitCommit = local
		if (local === remote) {
			await publishStatus('up-to-date', 100, {
				currentCommit: local, availableCommit: null, expectedCommit: null,
				message: '当前已是最新版本', error: null,
			}, 'update-result')
			return getUpdateStatus()
		}
		if (await gitAsync(['merge-base', '--is-ancestor', local, remote]) == null) {
			await failMessage('本地版本与仓库已分叉或领先，不能自动快进，请人工处理')
			return getUpdateStatus()
		}
		await publishStatus('available', 20, {
			currentCommit: local, availableCommit: remote, expectedCommit: null,
			message: `发现新版本 ${remote.slice(0, 7)}，等待用户确认`, error: null,
		}, 'update-available')
		return getUpdateStatus()
	} finally {
		_checking = false
	}
}

async function applyAvailableUpdate(expectedCommit) {
	await publishStatus('preflight', 30, { expectedCommit, message: '正在重新校验更新条件', error: null })
	const trackedChanges = await gitAsync(['status', '--porcelain=v1', '--untracked-files=no'])
	if (trackedChanges == null) throw new Error('无法读取工作区状态，更新未开始')
	if (trackedChanges) throw new Error('本地代码已有改动，更新已停止；不会覆盖这些文件')
	if (await gitAsync(['fetch', UPDATE_REMOTE, 'main', '--quiet']) == null) throw new Error('连接更新仓库失败，更新未开始')
	const local = await gitAsync(['rev-parse', 'HEAD'])
	const remote = await gitAsync(['rev-parse', `${UPDATE_REMOTE}/main`])
	if (!local || !remote) throw new Error('无法确认本地或仓库版本，更新未开始')
	if (remote !== expectedCommit) throw new Error('仓库版本在确认后已变化，请重新检查并确认')
	if (local === remote) throw new Error('当前已经是该版本，无需重复更新')
	if (await gitAsync(['merge-base', '--is-ancestor', local, remote]) == null) throw new Error('本地版本与仓库已分叉或领先，不能自动快进')
	if (existsSync(P1_RESTART_MARKER)) throw new Error('上一次更新的 P1 状态恢复尚未完成，请稍后重试')

	if (!markP1RestartAfterUpdate(remote)) throw new Error('无法准备 P1 重启恢复，更新已取消')
	await publishStatus('marker-written', 45, { message: '已建立 P1 状态恢复标记' })
	await publishStatus('pulling', 65, { message: '正在安全快进代码，用户数据不会被清理' })
	const pullResult = await gitAsync(['pull', '--ff-only', UPDATE_REMOTE, 'main'])
	const appliedCommit = await gitAsync(['rev-parse', 'HEAD'])
	if (!appliedCommit) {
		throw new Error('更新后无法读取 HEAD，已保留 P1 恢复标记；请勿强制启动旧 P1，并人工检查版本')
	}
	if (appliedCommit !== remote) {
		if (appliedCommit === local) {
			clearP1RestartAfterFailedUpdate()
			throw new Error('快进更新失败，当前版本已保留；请检查未跟踪同名文件或网络')
		}
		throw new Error('更新停在非预期提交，已保留 P1 恢复标记；请人工检查版本后再启动')
	}
	if (pullResult == null) console.warn('[更新] git pull 返回异常，但 HEAD 已核验到达目标版本')
	await publishStatus('verified', 90, { currentCommit: appliedCommit, message: '代码已核验，正在安排重启' })
	_restartScheduled = true
	await publishStatus('restart-scheduled', 95, { message: '服务端即将重启；重连后确认更新完成' }, 'update-result')
	setTimeout(restartor, 2000)
	return getUpdateStatus()
}

export function startAvailableUpdate(expectedCommit) {
	if (!_enabled || !isGitRepo) return { accepted: false, status: getUpdateStatus(), message: '当前环境未启用 Git 更新' }
	if (_restartScheduled) return { accepted: false, status: getUpdateStatus(), message: '更新已完成，正在等待服务重启' }
	if (_applyPromise) return { accepted: false, status: getUpdateStatus(), message: '更新已经在进行中' }
	if (!/^[0-9a-f]{40}$/i.test(String(expectedCommit || ''))) return { accepted: false, status: getUpdateStatus(), message: '更新目标无效，请重新检查版本' }
	if (_status.phase !== 'available' || _status.availableCommit !== expectedCommit) {
		return { accepted: false, status: getUpdateStatus(), message: '可用版本已变化，请重新检查后再确认' }
	}
	_applyPromise = applyAvailableUpdate(expectedCommit)
		.catch(async (e) => { await failMessage(e?.message || String(e)); return getUpdateStatus() })
		.finally(() => { _applyPromise = null })
	return { accepted: true, status: getUpdateStatus(), message: '更新任务已开始' }
}

export function enableAutoUpdate() {
	if (_enabled) return
	// 更新由启动器在 Deno 进程启动前完成；运行中的服务不再创建检查定时器，
	// 也不再向前端暴露“确认并重启”的更新链，避免代码与 P1 状态并行变化。
	_enabled = false
	initCommitHash()
	if (!isGitRepo) {
		_status = { ..._status, phase: 'disabled', message: '当前安装不是 Git 仓库，无法在线更新' }
		console.log('[更新] 非 git 仓库，在线更新不可用')
		return
	}
	_status = { ..._status, phase: 'disabled', message: '更新由启动器在服务启动前检查，运行中不再更新' }
	console.log('[更新] 运行时更新已关闭；请在启动器控制台完成启动前检查')
}

export function disableAutoUpdate() {
	if (_initialCheckTimer) { clearTimeout(_initialCheckTimer); _initialCheckTimer = null }
	_enabled = false
}

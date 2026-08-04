/**
 * autoupdate.mjs — 启动时自动检查+拉取 git 更新，有新版自动重启。
 *
 * 链路：index.mjs starts.Base.AutoUpdate → server.mjs enableAutoUpdate() →
 *   本模块定时 git fetch + 比对 → 有新 commit → git pull → restartor(exit 131)
 *   → PS1 keepalive 循环重启 deno。
 * 无 git 环境（exe 安装包）降级为版本号通知（GitHub API）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { __dirname } from './base.mjs'
import { restartor } from './svr_state.mjs'

export let currentGitCommit = null

const isGitRepo = existsSync(join(__dirname, '.git'))
const CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟
const P1_RESTART_MARKER = join(__dirname, 'data', 'p1', '.service-restart-required.json')
let _timer = null
let _initialCheckTimer = null
let _checking = false
let _enabled = false
let _restartScheduled = false

/**
 * 执行 git 子命令。参数数组避免把仓库/分支信息拼进 shell；失败一律返回 null，
 * 由调用链显式决定“保留当前版本”而不是把失败伪装成更新成功。
 */
function git(args) {
	try {
		return execFileSync('git', args, {
			cwd: __dirname,
			encoding: 'utf-8',
			timeout: 30000,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim()
	} catch { return null }
}

function initCommitHash() {
	if (!isGitRepo) return
	currentGitCommit = git(['rev-parse', 'HEAD'])
}

/**
 * P1 是独立进程，主服务重启不会自然替换它。标记写入失败就不应用源码更新，
 * 以免留下“新本体 + 旧 P1”的混合版本。标记由新 P1 健康后删除。
 */
function markP1RestartAfterUpdate(targetCommit) {
	try {
		mkdirSync(join(__dirname, 'data', 'p1'), { recursive: true })
		writeFileSync(P1_RESTART_MARKER, JSON.stringify({
			reason: 'application-update', targetCommit, createdAt: new Date().toISOString(),
		}), 'utf-8')
		return true
	} catch (e) {
		console.warn(`[自动更新] 无法写入 P1 重启标记，已取消更新以保持版本一致: ${e?.message || e}`)
		return false
	}
}

async function checkAndUpdate() {
	if (!isGitRepo || !_enabled || _checking || _restartScheduled) return
	_checking = true
	try {
		// 用户或运行期写入通常是 untracked 文件；ff-only 本身不会清理它们。
		// 但任何已跟踪的改动都意味着代码/配置契约已偏离发布版本，绝不能擅自覆盖。
		const trackedChanges = git(['status', '--porcelain=v1', '--untracked-files=no'])
		if (trackedChanges == null) {
			console.warn('[自动更新] 无法读取工作区状态，本次保持当前版本')
			return
		}
		if (trackedChanges) {
			console.warn('[自动更新] 检测到本地已跟踪改动，已跳过更新；不会覆盖用户或开发中的文件')
			return
		}

		if (git(['fetch', 'origin', 'main', '--quiet']) == null) {
			console.warn('[自动更新] git fetch 失败，本次保持当前版本')
			return
		}
		const local = git(['rev-parse', 'HEAD'])
		const remote = git(['rev-parse', 'origin/main'])
		if (!local || !remote) {
			console.warn('[自动更新] 无法确认本地或远端版本，本次保持当前版本')
			return
		}
		if (local === remote) return

		console.log(`[自动更新] 检测到新版本: ${local.slice(0, 7)} → ${remote.slice(0, 7)}，正在 fast-forward 更新...`)
		if (!markP1RestartAfterUpdate(remote)) return
		if (git(['pull', '--ff-only', 'origin', 'main']) == null) {
			console.warn('[自动更新] fast-forward 更新失败（可能与未跟踪用户文件冲突），当前版本未被覆盖')
			return
		}
		currentGitCommit = git(['rev-parse', 'HEAD']) || remote
		if (!_enabled) return
		_restartScheduled = true
		console.log('[自动更新] 更新完成，重启中...')
		setTimeout(restartor, 2000)
	} finally {
		_checking = false
	}
}

export function enableAutoUpdate() {
	if (_enabled) return
	_enabled = true
	initCommitHash()
	if (!isGitRepo) {
		console.log('[自动更新] 非 git 仓库，自动更新不可用')
		return
	}
	console.log(`[自动更新] 已启用（当前 ${currentGitCommit?.slice(0, 7) || '?'}，每 ${CHECK_INTERVAL_MS / 60000} 分钟检查）`)
	_timer = setInterval(checkAndUpdate, CHECK_INTERVAL_MS)
	_initialCheckTimer = setTimeout(checkAndUpdate, 30000) // 启动 30s 后首次检查
}

export function disableAutoUpdate() {
	if (_timer) { clearInterval(_timer); _timer = null }
	if (_initialCheckTimer) { clearTimeout(_initialCheckTimer); _initialCheckTimer = null }
	_enabled = false
}

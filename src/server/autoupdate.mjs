/**
 * autoupdate.mjs — 启动时自动检查+拉取 git 更新，有新版自动重启。
 *
 * 链路：index.mjs starts.Base.AutoUpdate → server.mjs enableAutoUpdate() →
 *   本模块定时 git fetch + 比对 → 有新 commit → git pull → restartor(exit 131)
 *   → PS1 keepalive 循环重启 deno。
 * 无 git 环境（exe 安装包）降级为版本号通知（GitHub API）。
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { __dirname } from './base.mjs'
import { restartor } from './svr_state.mjs'

export let currentGitCommit = null

const isGitRepo = existsSync(join(__dirname, '.git'))
const CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟
let _timer = null

function git(cmd) {
	try {
		return execSync(`git ${cmd}`, { cwd: __dirname, encoding: 'utf-8', timeout: 30000 }).trim()
	} catch { return null }
}

function initCommitHash() {
	if (!isGitRepo) return
	currentGitCommit = git('rev-parse HEAD')
}

async function checkAndUpdate() {
	if (!isGitRepo) return
	git('fetch origin main --quiet')
	const local = git('rev-parse HEAD')
	const remote = git('rev-parse origin/main')
	if (!local || !remote || local === remote) return
	console.log(`[自动更新] 检测到新版本: ${local.slice(0, 7)} → ${remote.slice(0, 7)}，正在更新...`)
	const pullResult = git('pull origin main --ff-only')
	if (!pullResult) {
		console.warn('[自动更新] git pull 失败，跳过本次更新')
		return
	}
	console.log(`[自动更新] 更新完成，重启中...`)
	setTimeout(restartor, 2000)
}

export function enableAutoUpdate() {
	initCommitHash()
	if (!isGitRepo) {
		console.log('[自动更新] 非 git 仓库，自动更新不可用')
		return
	}
	console.log(`[自动更新] 已启用（当前 ${currentGitCommit?.slice(0, 7) || '?'}，每 ${CHECK_INTERVAL_MS / 60000} 分钟检查）`)
	_timer = setInterval(checkAndUpdate, CHECK_INTERVAL_MS)
	setTimeout(checkAndUpdate, 30000) // 启动 30s 后首次检查
}

export function disableAutoUpdate() {
	if (_timer) { clearInterval(_timer); _timer = null }
}

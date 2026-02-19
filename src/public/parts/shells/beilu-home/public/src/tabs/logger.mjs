/**
 * beilu-home 日志面板模块
 * 查询 beilu-logger 后端 API，显示服务器日志
 *
 * 功能：
 * - 级别筛选（全部/警告/错误）
 * - 自动刷新（可选，默认关闭）
 * - 复制全部日志
 * - 清空日志
 */

const LOG_API = '/api/parts/plugins:beilu-logger/logs'
const CLEAR_API = '/api/parts/plugins:beilu-logger/clear'

// ============================================================
// 状态
// ============================================================

let currentLevel = 'all'
let autoRefreshTimer = null
let lastFetchTime = null

// DOM 引用
let dom = {}

// ============================================================
// API 通信
// ============================================================

async function fetchLogs() {
	const params = new URLSearchParams()
	if (currentLevel !== 'all') params.set('level', currentLevel)
	if (lastFetchTime && autoRefreshTimer) params.set('since', lastFetchTime)
	params.set('limit', '300')

	const url = `${LOG_API}?${params.toString()}`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`获取日志失败: ${res.statusText}`)
	return res.json()
}

async function clearLogs() {
	const res = await fetch(CLEAR_API, { method: 'POST' })
	if (!res.ok) throw new Error(`清空日志失败: ${res.statusText}`)
	return res.json()
}

// ============================================================
// 渲染
// ============================================================

/**
 * 格式化 ISO 时间为 HH:MM:SS
 * @param {string} isoTime
 * @returns {string}
 */
function formatTime(isoTime) {
	try {
		const d = new Date(isoTime)
		return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	} catch {
		return isoTime
	}
}

/**
 * 转义 HTML
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

/**
 * 渲染日志列表
 * @param {Array} logs
 */
function renderLogs(logs) {
	if (!dom.output) return

	if (!logs || logs.length === 0) {
		dom.output.innerHTML = '<p class="text-xs text-base-content/30 text-center py-8">暂无日志记录</p>'
		return
	}

	const html = logs.map(entry => {
		const levelIcon = entry.level === 'error' ? '❌' : '⚠️'
		return `<div class="beilu-log-entry ${entry.level}">
	<span class="beilu-log-time">${formatTime(entry.time)}</span>
	<span class="beilu-log-level">${levelIcon}</span>
	<span class="beilu-log-message">${escapeHtml(entry.message)}</span>
</div>`
	}).join('')

	dom.output.innerHTML = html
	// 滚动到底部
	dom.output.scrollTop = dom.output.scrollHeight
}

/**
 * 更新统计信息
 * @param {object} data - { total, counts, startTime }
 */
function updateStats(data) {
	if (!dom.stats) return
	const parts = []
	if (data.counts) {
		parts.push(`❌${data.counts.error || 0}`)
		parts.push(`⚠️${data.counts.warn || 0}`)
	}
	parts.push(`共 ${data.total || 0} 条`)
	dom.stats.textContent = parts.join(' · ')
}

// ============================================================
// 操作
// ============================================================

async function handleRefresh() {
	try {
		const data = await fetchLogs()
		renderLogs(data.logs)
		updateStats(data)
		lastFetchTime = new Date().toISOString()
	} catch (err) {
		console.error('[beilu-home/logger] 刷新日志失败:', err)
		if (dom.output) {
			dom.output.innerHTML = `<p class="text-xs text-error text-center py-4">加载失败: ${escapeHtml(err.message)}</p>`
		}
	}
}

function handleFilterClick(level) {
	currentLevel = level
	// 更新按钮状态
	document.querySelectorAll('.logger-filter-btn').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.level === level)
		// 非激活按钮恢复 outline 样式
		if (btn.dataset.level !== level) {
			btn.classList.add('btn-outline')
		} else {
			btn.classList.remove('btn-outline')
		}
	})
	// 重新加载（不用 since，全量获取当前级别）
	lastFetchTime = null
	handleRefresh()
}

function toggleAutoRefresh(enabled) {
	if (autoRefreshTimer) {
		clearInterval(autoRefreshTimer)
		autoRefreshTimer = null
	}
	if (enabled) {
		autoRefreshTimer = setInterval(handleRefresh, 5000) // 每 5 秒
		handleRefresh() // 立即刷新一次
	}
}

async function handleCopy() {
	try {
		const data = await fetchLogs()
		if (!data.logs || data.logs.length === 0) {
			alert('没有日志可复制')
			return
		}
		const text = data.logs.map(entry => {
			const levelTag = entry.level === 'error' ? '[ERROR]' : '[WARN]'
			return `${entry.time} ${levelTag} ${entry.message}`
		}).join('\n')

		await navigator.clipboard.writeText(text)
		// 简单反馈
		if (dom.copyBtn) {
			const orig = dom.copyBtn.textContent
			dom.copyBtn.textContent = '✅'
			setTimeout(() => { dom.copyBtn.textContent = orig }, 1500)
		}
	} catch (err) {
		console.error('[beilu-home/logger] 复制失败:', err)
		alert('复制失败: ' + err.message)
	}
}

async function handleClear() {
	if (!confirm('确定清空所有服务器日志？')) return
	try {
		await clearLogs()
		renderLogs([])
		updateStats({ total: 0, counts: { error: 0, warn: 0 } })
	} catch (err) {
		console.error('[beilu-home/logger] 清空失败:', err)
		alert('清空失败: ' + err.message)
	}
}

// ============================================================
// 初始化
// ============================================================

export async function init() {
	dom = {
		output: document.getElementById('logger-output'),
		stats: document.getElementById('logger-stats'),
		refreshBtn: document.getElementById('logger-refresh-btn'),
		autoRefreshCb: document.getElementById('logger-auto-refresh'),
		copyBtn: document.getElementById('logger-copy-btn'),
		clearBtn: document.getElementById('logger-clear-btn'),
	}

	// 事件绑定
	dom.refreshBtn?.addEventListener('click', handleRefresh)

	dom.autoRefreshCb?.addEventListener('change', () => {
		toggleAutoRefresh(dom.autoRefreshCb.checked)
	})

	dom.copyBtn?.addEventListener('click', handleCopy)
	dom.clearBtn?.addEventListener('click', handleClear)

	// 级别筛选按钮
	document.querySelectorAll('.logger-filter-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			handleFilterClick(btn.dataset.level)
		})
	})

	// 首次加载
	await handleRefresh()
}
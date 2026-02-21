/**
 * beilu-home 调试面板 — 诊断系统控制模块
 *
 * 功能：
 * - 前端诊断模块开关（读写 localStorage 'beilu-diag-modules'）
 * - 前端日志级别控制（读写 localStorage 'beilu-diag-level'）
 * - 后端诊断模块开关（通过 /api/diag/* 端点）
 * - 状态快照查看器
 * - 诊断报告导出
 */

const STORAGE_KEY = 'beilu-diag-modules'
const STORAGE_LEVEL_KEY = 'beilu-diag-level'
const BACKEND_DIAG_API = '/api/diag'

// DOM 引用
let dom = {}

// ============================================================
// 前端诊断状态读取
// ============================================================

function getFrontendModules() {
	try {
		const val = localStorage.getItem(STORAGE_KEY)
		if (!val) return new Set()
		if (val.trim() === '*') return '*'
		return new Set(val.split(',').map(s => s.trim()).filter(Boolean))
	} catch {
		return new Set()
	}
}

function getFrontendLevel() {
	return localStorage.getItem(STORAGE_LEVEL_KEY) || 'info'
}

function setFrontendModules(modules) {
	if (modules === '*') {
		localStorage.setItem(STORAGE_KEY, '*')
	} else if (modules instanceof Set) {
		if (modules.size === 0) {
			localStorage.removeItem(STORAGE_KEY)
		} else {
			localStorage.setItem(STORAGE_KEY, Array.from(modules).join(','))
		}
	}
}

function setFrontendLevel(level) {
	localStorage.setItem(STORAGE_LEVEL_KEY, level)
}

// ============================================================
// UI 状态同步
// ============================================================

function refreshFrontendUI() {
	const modules = getFrontendModules()
	const level = getFrontendLevel()

	// 状态徽章
	if (dom.statusBadge) {
		if (modules === '*') {
			dom.statusBadge.textContent = '✅ 全部启用'
			dom.statusBadge.className = 'badge badge-sm badge-outline badge-success'
		} else if (modules.size > 0) {
			dom.statusBadge.textContent = `✅ ${modules.size} 个模块`
			dom.statusBadge.className = 'badge badge-sm badge-outline badge-warning'
		} else {
			dom.statusBadge.textContent = '未激活'
			dom.statusBadge.className = 'badge badge-sm badge-outline'
		}
	}

	// 级别下拉框
	if (dom.levelSelect) {
		dom.levelSelect.value = level
	}

	// 模块按钮高亮
	document.querySelectorAll('.diag-module-btn').forEach(btn => {
		const mod = btn.dataset.module
		const isEnabled = modules === '*' || (modules instanceof Set && modules.has(mod))
		btn.classList.toggle('btn-outline', !isEnabled)
		btn.classList.toggle('btn-active', isEnabled)
		if (isEnabled) {
			btn.style.background = 'oklch(var(--wa) / 0.3)'
			btn.style.borderColor = 'oklch(var(--wa))'
			btn.style.color = ''
		} else {
			btn.style.background = ''
			btn.style.borderColor = ''
			btn.style.color = ''
		}
	})

	// 快照计数
	refreshSnapshotCount()
}

function refreshSnapshotCount() {
	if (!dom.snapshotCount) return
	// 通过 window.beiluDiag 获取（聊天页面中的 diagLogger 挂载到 window）
	// 但在 home 页面中，diagLogger 可能不存在，需要通过 localStorage 间接判断
	// 这里仅显示前端控制状态
	try {
		if (window.beiluDiag) {
			// diagLogger 已加载（如果在同一页面）
			dom.snapshotCount.textContent = `beiluDiag 可用`
		} else {
			dom.snapshotCount.textContent = '诊断模块未加载'
		}
	} catch {
		dom.snapshotCount.textContent = '—'
	}
}

// ============================================================
// 前端操作
// ============================================================

function handleEnableAll() {
	setFrontendModules('*')
	setFrontendLevel('debug')
	refreshFrontendUI()
	showToast('已启用所有前端诊断模块 + debug 级别')
	// 同步到 beiluDiag（如果存在）
	try { window.beiluDiag?.all?.() } catch { /* 不在聊天页 */ }
}

function handleDisableAll() {
	setFrontendModules(new Set())
	refreshFrontendUI()
	showToast('已禁用所有前端诊断模块')
	try { window.beiluDiag?.disable?.('*') } catch { /* */ }
}

function handleModuleToggle(moduleName) {
	const modules = getFrontendModules()
	if (modules === '*') {
		// 从全选切换到去掉一个
		const allModules = getAllFrontendModules()
		const newSet = new Set(allModules.filter(m => m !== moduleName))
		setFrontendModules(newSet)
	} else {
		if (modules.has(moduleName)) {
			modules.delete(moduleName)
		} else {
			modules.add(moduleName)
		}
		setFrontendModules(modules)
	}
	refreshFrontendUI()
}

function handleLevelChange(level) {
	setFrontendLevel(level)
	showToast(`前端日志级别: ${level}`)
	try { window.beiluDiag?.setLevel?.(level) } catch { /* */ }
}

function handleExport() {
	try {
		if (window.beiluDiag?.export) {
			window.beiluDiag.export()
			showToast('诊断报告已复制到剪贴板')
		} else {
			// 没有 beiluDiag，手动构建基础报告
			const report = {
				timestamp: new Date().toISOString(),
				userAgent: navigator.userAgent,
				url: window.location.href,
				frontend: {
					modules: (() => {
						const m = getFrontendModules()
						return m === '*' ? '*' : Array.from(m)
					})(),
					level: getFrontendLevel(),
				},
				localStorage: {
					'beilu-diag-modules': localStorage.getItem(STORAGE_KEY),
					'beilu-diag-level': localStorage.getItem(STORAGE_LEVEL_KEY),
				},
			}
			const json = JSON.stringify(report, null, 2)
			navigator.clipboard.writeText(json).then(() => {
				showToast('诊断报告已复制到剪贴板')
			}).catch(() => {
				console.log('[diag] 报告:', json)
				showToast('报告已输出到控制台')
			})
		}
	} catch (err) {
		console.error('[diag] 导出失败:', err)
		showToast('导出失败: ' + err.message)
	}
}

function getAllFrontendModules() {
	return [
		'template', 'displayRegex', 'messageList', 'streamRenderer',
		'virtualQueue', 'websocket', 'iframeRenderer',
		'sidebar', 'fileExplorer', 'layout',
		'config', 'api', 'dom', 'perf',
	]
}

// ============================================================
// 后端诊断控制
// ============================================================

async function fetchBackendStatus() {
	try {
		const res = await fetch(`${BACKEND_DIAG_API}/status`)
		if (!res.ok) {
			if (dom.backendStatus) dom.backendStatus.textContent = `后端API不可用 (${res.status})`
			return null
		}
		return await res.json()
	} catch (err) {
		if (dom.backendStatus) dom.backendStatus.textContent = `后端连接失败: ${err.message}`
		return null
	}
}

async function refreshBackendUI() {
	const data = await fetchBackendStatus()
	if (!data) return

	const modules = data.modules === '*' ? '*' : new Set(data.modules || [])

	// 更新后端模块按钮
	document.querySelectorAll('.diag-backend-module-btn').forEach(btn => {
		const mod = btn.dataset.module
		const isEnabled = modules === '*' || (modules instanceof Set && modules.has(mod))
		btn.classList.toggle('btn-outline', !isEnabled)
		btn.classList.toggle('btn-active', isEnabled)
		if (isEnabled) {
			btn.style.background = 'oklch(var(--wa) / 0.3)'
			btn.style.borderColor = 'oklch(var(--wa))'
			btn.style.color = ''
		} else {
			btn.style.background = ''
			btn.style.borderColor = ''
			btn.style.color = ''
		}
	})

	// 更新后端级别
	if (dom.backendLevelSelect) {
		dom.backendLevelSelect.value = data.level || 'info'
	}

	// 状态文本
	if (dom.backendStatus) {
		const modStr = modules === '*' ? '全部' : (modules.size ? `${modules.size} 个` : '无')
		dom.backendStatus.textContent = `模块: ${modStr} | 级别: ${data.level} | 快照: ${data.snapshots}/${data.maxSnapshots}`
	}
}

async function sendBackendCommand(action, body = {}) {
	try {
		const res = await fetch(`${BACKEND_DIAG_API}/${action}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (!res.ok) {
			showToast(`后端命令失败: ${res.status}`)
			return false
		}
		return true
	} catch (err) {
		showToast(`后端连接失败: ${err.message}`)
		return false
	}
}

async function handleBackendEnableAll() {
	if (await sendBackendCommand('enable', { modules: '*' })) {
		await sendBackendCommand('level', { level: 'debug' })
		showToast('已启用所有后端诊断模块')
		refreshBackendUI()
	}
}

async function handleBackendDisableAll() {
	if (await sendBackendCommand('disable', { modules: '*' })) {
		showToast('已禁用所有后端诊断模块')
		refreshBackendUI()
	}
}

async function handleBackendModuleToggle(moduleName) {
	const data = await fetchBackendStatus()
	if (!data) return

	const currentModules = data.modules === '*' ? new Set(data.availableModules || []) : new Set(data.modules || [])
	const isEnabled = data.modules === '*' || currentModules.has(moduleName)

	if (isEnabled) {
		await sendBackendCommand('disable', { modules: moduleName })
	} else {
		await sendBackendCommand('enable', { modules: moduleName })
	}
	refreshBackendUI()
}

async function handleBackendLevelChange(level) {
	if (await sendBackendCommand('level', { level })) {
		showToast(`后端日志级别: ${level}`)
		refreshBackendUI()
	}
}

// ============================================================
// 快照查看器
// ============================================================

function handleViewSnapshots() {
	if (!dom.snapshotsOutput) return
	dom.snapshotsOutput.style.display = dom.snapshotsOutput.style.display === 'none' ? 'block' : 'none'

	if (dom.snapshotsOutput.style.display === 'block') {
		// 尝试从 beiluDiag 获取快照
		try {
			if (window.beiluDiag) {
				// 这里直接读取，因为 beiluDiag.snapshots() 只是 console.table
				dom.snapshotsOutput.innerHTML = '<p class="text-xs text-base-content/50 text-center py-2">快照在控制台中查看: <code>beiluDiag.snapshots()</code></p>'
			} else {
				dom.snapshotsOutput.innerHTML = '<p class="text-xs text-base-content/30 text-center py-4">诊断模块未在当前页面加载</p>'
			}
		} catch {
			dom.snapshotsOutput.innerHTML = '<p class="text-xs text-base-content/30 text-center py-4">无法获取快照数据</p>'
		}

		// 同时获取后端快照
		fetchBackendSnapshots()
	}
}

async function fetchBackendSnapshots() {
	try {
		const res = await fetch(`${BACKEND_DIAG_API}/snapshots?count=20`)
		if (!res.ok) return
		const data = await res.json()
		if (data.snapshots && data.snapshots.length > 0 && dom.snapshotsOutput) {
			const rows = data.snapshots.map(s => {
				const time = new Date(s.t).toLocaleTimeString()
				return `<div class="flex gap-2 text-xs py-0.5 border-b border-base-content/5">
					<span class="text-base-content/30 w-16 shrink-0">${time}</span>
					<span class="text-amber-500 w-16 shrink-0">${s.module}</span>
					<span class="text-base-content/60 w-24 shrink-0">${s.label}</span>
					<span class="text-base-content/40 truncate">${JSON.stringify(s.data).substring(0, 80)}</span>
				</div>`
			}).join('')
			dom.snapshotsOutput.innerHTML += `
				<div class="mt-2 pt-2 border-t border-base-content/10">
					<div class="text-xs font-medium text-base-content/50 mb-1">🖧 后端快照 (最近 ${data.snapshots.length} 条)</div>
					${rows}
				</div>`
		}
	} catch { /* 后端 API 不可用 */ }
}

function handleClearSnapshots() {
	try { window.beiluDiag?.clearSnapshots?.() } catch { /* */ }
	// 同时清空后端快照
	fetch(`${BACKEND_DIAG_API}/clear-snapshots`, { method: 'POST' }).catch(() => {})
	if (dom.snapshotsOutput) {
		dom.snapshotsOutput.innerHTML = '<p class="text-xs text-base-content/30 text-center py-4">快照已清空</p>'
	}
	showToast('快照已清空')
}

// ============================================================
// 工具函数
// ============================================================

function showToast(message) {
	// 简单的通知反馈
	if (dom.backendStatus) {
		const origText = dom.backendStatus.textContent
		dom.backendStatus.textContent = `✓ ${message}`
		dom.backendStatus.style.color = 'oklch(var(--su))'
		setTimeout(() => {
			dom.backendStatus.textContent = origText
			dom.backendStatus.style.color = ''
		}, 2000)
	}
}

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

// ============================================================
// 初始化
// ============================================================

export async function init() {
	dom = {
		statusBadge: document.getElementById('diag-status-badge'),
		refreshBtn: document.getElementById('diag-refresh-btn'),
		enableAllBtn: document.getElementById('diag-enable-all'),
		disableAllBtn: document.getElementById('diag-disable-all'),
		exportBtn: document.getElementById('diag-export-btn'),
		levelSelect: document.getElementById('diag-level-select'),
		backendEnableAllBtn: document.getElementById('diag-backend-enable-all'),
		backendDisableAllBtn: document.getElementById('diag-backend-disable-all'),
		backendLevelSelect: document.getElementById('diag-backend-level-select'),
		backendStatus: document.getElementById('diag-backend-status'),
		snapshotCount: document.getElementById('diag-snapshot-count'),
		viewSnapshotsBtn: document.getElementById('diag-view-snapshots'),
		clearSnapshotsBtn: document.getElementById('diag-clear-snapshots'),
		snapshotsOutput: document.getElementById('diag-snapshots-output'),
	}

	// 前端控制事件
	dom.enableAllBtn?.addEventListener('click', handleEnableAll)
	dom.disableAllBtn?.addEventListener('click', handleDisableAll)
	dom.exportBtn?.addEventListener('click', handleExport)

	dom.levelSelect?.addEventListener('change', () => {
		handleLevelChange(dom.levelSelect.value)
	})

	dom.refreshBtn?.addEventListener('click', () => {
		refreshFrontendUI()
		refreshBackendUI()
	})

	// 前端模块按钮
	document.querySelectorAll('.diag-module-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			handleModuleToggle(btn.dataset.module)
		})
	})

	// 后端控制事件
	dom.backendEnableAllBtn?.addEventListener('click', handleBackendEnableAll)
	dom.backendDisableAllBtn?.addEventListener('click', handleBackendDisableAll)

	dom.backendLevelSelect?.addEventListener('change', () => {
		handleBackendLevelChange(dom.backendLevelSelect.value)
	})

	document.querySelectorAll('.diag-backend-module-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			handleBackendModuleToggle(btn.dataset.module)
		})
	})

	// 快照查看器
	dom.viewSnapshotsBtn?.addEventListener('click', handleViewSnapshots)
	dom.clearSnapshotsBtn?.addEventListener('click', handleClearSnapshots)

	// 初始状态刷新
	refreshFrontendUI()
	refreshBackendUI()

	console.log('[beilu-home] 诊断控制面板已加载')
}
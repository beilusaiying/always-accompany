// ============================================================
// AI诊断面板 - 实时查看记忆AI运行输出和注入状态
// ============================================================

/** @type {string|null} 上次获取到的最新输出ID */
let lastOutputId = null

/** @type {number|null} 轮询定时器ID */
let pollTimer = null

/** @type {boolean} 面板是否已激活（可见） */
let isActive = false

/** @type {HTMLElement} */
let containerEl = null

/**
 * 调用 beilu-memory 后端 setdata API
 * @param {object} body
 * @returns {Promise<object>}
 */
async function callMemoryAPI(body) {
	const resp = await fetch('/api/parts/plugins:beilu-memory/config/setdata', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!resp.ok) throw new Error(`API错误: ${resp.status}`)
	return resp.json()
}

/**
 * 调用 beilu-memory 后端 getdata API
 * @param {object} [params]
 * @returns {Promise<object>}
 */
async function callMemoryGetAPI(params = {}) {
	const qs = new URLSearchParams(params).toString()
	const url = '/api/parts/plugins:beilu-memory/config/getdata' + (qs ? '?' + qs : '')
	const resp = await fetch(url)
	if (!resp.ok) throw new Error(`API错误: ${resp.status}`)
	return resp.json()
}

/**
 * 格式化时间戳
 * @param {string} iso
 * @returns {string}
 */
function fmtTime(iso) {
	if (!iso) return '--'
	try {
		const d = new Date(iso)
		return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
	} catch { return iso }
}

/**
 * 状态徽章 HTML
 * @param {string} status
 * @returns {string}
 */
function statusBadge(status) {
	const map = {
		running: '<span class="badge badge-warning badge-sm">⏳ 运行中</span>',
		done: '<span class="badge badge-success badge-sm">✅ 完成</span>',
		error: '<span class="badge badge-error badge-sm">❌ 错误</span>',
	}
	return map[status] || `<span class="badge badge-ghost badge-sm">${status}</span>`
}

/**
 * 渲染系统状态卡片
 * @param {object} snapshot
 */
function renderStatusCards(snapshot) {
	const statusArea = containerEl.querySelector('#aiDiag-status')
	if (!statusArea) return

	const pluginOk = snapshot.pluginEnabled
	const autoTrigger = snapshot.autoTrigger
	const hasP1Cache = snapshot.hasP1Cache
	const p1CacheLen = snapshot.p1CacheLength || 0
	const p1CacheTime = snapshot.p1CacheTimestamp
	const enabledPresets = snapshot.enabledPresets || []
	const enabledInjections = snapshot.enabledInjections || []

	statusArea.innerHTML = `
		<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
			<div class="stat bg-base-200 rounded-lg p-3">
				<div class="stat-title text-xs">插件状态</div>
				<div class="stat-value text-lg">${pluginOk ? '🟢 启用' : '🔴 禁用'}</div>
			</div>
			<div class="stat bg-base-200 rounded-lg p-3">
				<div class="stat-title text-xs">P1 自动触发</div>
				<div class="stat-value text-lg">${autoTrigger ? '🟢 开启' : '⚪ 关闭'}</div>
			</div>
			<div class="stat bg-base-200 rounded-lg p-3">
				<div class="stat-title text-xs">P1 缓存</div>
				<div class="stat-value text-lg">${hasP1Cache ? `📋 ${p1CacheLen}字` : '⚪ 无'}</div>
				${p1CacheTime ? `<div class="stat-desc text-xs">${fmtTime(p1CacheTime)}</div>` : ''}
			</div>
			<div class="stat bg-base-200 rounded-lg p-3">
				<div class="stat-title text-xs">活跃预设/注入</div>
				<div class="stat-value text-lg">${enabledPresets.length}P / ${enabledInjections.length}I</div>
				<div class="stat-desc text-xs">${enabledPresets.join(', ') || '无'}</div>
			</div>
		</div>
	`
}

/**
 * 渲染单条AI输出记录
 * @param {object} output
 * @returns {string} HTML
 */
function renderOutputEntry(output) {
	const time = fmtTime(output.timestamp)
	const badge = statusBadge(output.status)
	const presetLabel = `<span class="font-bold text-primary">${output.presetId}</span> ${output.presetName || ''}`

	let details = ''

	if (output.status === 'error') {
		details = `<div class="text-error text-sm mt-1">❌ ${output.error || '未知错误'}</div>`
	}

	if (output.thinking) {
		const thinkingPreview = output.thinking.length > 200
			? output.thinking.substring(0, 200) + '...'
			: output.thinking
		details += `
			<details class="mt-1">
				<summary class="text-xs text-base-content/60 cursor-pointer">🧠 思考过程 (${output.thinking.length}字)</summary>
				<pre class="text-xs bg-base-300 rounded p-2 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">${escapeHtml(thinkingPreview)}</pre>
			</details>
		`
	}

	if (output.reply) {
		const replyPreview = output.reply.length > 300
			? output.reply.substring(0, 300) + '...'
			: output.reply
		details += `
			<details class="mt-1" ${output.status === 'done' ? 'open' : ''}>
				<summary class="text-xs text-base-content/60 cursor-pointer">📝 输出内容 (${output.reply.length}字)</summary>
				<pre class="text-xs bg-base-300 rounded p-2 mt-1 whitespace-pre-wrap max-h-60 overflow-y-auto">${escapeHtml(replyPreview)}</pre>
			</details>
		`
	}

	if (output.operations && output.operations.length > 0) {
		details += `
			<div class="text-xs text-base-content/60 mt-1">
				🔧 操作: ${output.operations.map(op => `${op.type}(轮${op.round})`).join(', ')}
			</div>
		`
	}

	let meta = ''
	if (output.totalRounds) meta += `${output.totalRounds}轮 `
	if (output.totalTimeMs) meta += `${output.totalTimeMs}ms`

	return `
		<div class="border border-base-300 rounded-lg p-3 mb-2 ${output.status === 'running' ? 'border-warning animate-pulse' : ''}">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					${badge}
					<span class="text-sm">${presetLabel}</span>
				</div>
				<div class="text-xs text-base-content/50">
					${time}
					${meta ? `<span class="ml-2">${meta}</span>` : ''}
				</div>
			</div>
			${details}
		</div>
	`
}

/**
 * HTML 转义
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	if (!str) return ''
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/**
 * 轮询获取新的AI输出
 */
async function pollOutputs() {
	if (!isActive) return

	try {
		const result = await callMemoryAPI({
			_action: 'getMemoryAIOutput',
			sinceId: lastOutputId,
		})

		if (result.success && result.outputs && result.outputs.length > 0) {
			const logArea = containerEl.querySelector('#aiDiag-log')
			if (!logArea) return

			for (const output of result.outputs) {
				// 检查是否是已有 running 条目的更新
				const existingEl = logArea.querySelector(`[data-preset-running="${output.presetId}"]`)
				if (existingEl && output.status !== 'running') {
					existingEl.remove()
				}

				const div = document.createElement('div')
				div.innerHTML = renderOutputEntry(output)
				if (output.status === 'running') {
					div.firstElementChild?.setAttribute('data-preset-running', output.presetId)
				}
				// 新条目插入到顶部
				logArea.prepend(div.firstElementChild || div)

				lastOutputId = output.id
			}

			// 限制显示条数
			while (logArea.children.length > 50) {
				logArea.removeChild(logArea.lastChild)
			}
		}
	} catch (e) {
		console.warn('[aiDiag] 轮询失败:', e.message)
	}
}

/**
 * 刷新系统诊断快照
 */
async function refreshSnapshot() {
	try {
		const result = await callMemoryAPI({ _action: 'getDiagSnapshot' })
		if (result.success || result.pluginEnabled !== undefined) {
			renderStatusCards(result)
		}
	} catch (e) {
		console.warn('[aiDiag] 获取诊断快照失败:', e.message)
		// 回退：从 getdata 获取基本信息
		try {
			const data = await callMemoryGetAPI()
			renderStatusCards({
				pluginEnabled: data.enabled,
				autoTrigger: data.config?.retrieval?.auto_trigger || false,
				hasP1Cache: false,
				enabledPresets: (data.memory_presets || []).filter(p => p.enabled).map(p => p.id),
				enabledInjections: (data.injection_prompts || []).filter(p => p.enabled).map(p => p.id),
			})
		} catch (e2) {
			console.warn('[aiDiag] 回退获取也失败:', e2.message)
		}
	}
}

/**
 * 渲染 GetPrompt 注入日志
 */
async function refreshInjectionLog() {
	try {
		const result = await callMemoryAPI({ _action: 'getDiagSnapshot' })
		const logArea = containerEl.querySelector('#aiDiag-injection')
		if (!logArea) return

		const injLog = result.injectionLog || []

		if (injLog.length === 0) {
			logArea.innerHTML = '<div class="text-sm text-base-content/50 p-2">暂无注入记录（发送消息后会出现）</div>'
			return
		}

		let html = ''
		for (const entry of injLog.slice(-10).reverse()) {
			const time = fmtTime(entry.timestamp)
			const injCount = entry.injectionCount || 0
			const p1Injected = entry.p1Injected ? '✅' : '⚪'
			const hotMemLen = entry.hotMemoryLength || 0
			const tableLen = entry.tableDataLength || 0

			html += `
				<div class="border border-base-300 rounded p-2 mb-1 text-xs">
					<div class="flex justify-between">
						<span>${time}</span>
						<span>注入${injCount}条 | P1:${p1Injected} | 热记忆:${hotMemLen}字 | 表格:${tableLen}字</span>
					</div>
					${entry.error ? `<div class="text-error mt-1">❌ ${entry.error}</div>` : ''}
				</div>
			`
		}
		logArea.innerHTML = html
	} catch (e) {
		console.warn('[aiDiag] 获取注入日志失败:', e.message)
	}
}

/**
 * 清空输出日志
 */
async function clearOutputs() {
	try {
		await callMemoryAPI({ _action: 'clearMemoryAIOutput' })
		const logArea = containerEl.querySelector('#aiDiag-log')
		if (logArea) logArea.innerHTML = '<div class="text-sm text-base-content/50 p-2">已清空</div>'
		lastOutputId = null
	} catch (e) {
		console.error('[aiDiag] 清空失败:', e.message)
	}
}

/**
 * 初始化面板
 */
export async function init() {
	containerEl = document.getElementById('section-aiDiag')
	if (!containerEl) {
		console.error('[aiDiag] 找不到 section-aiDiag 容器')
		return
	}

	// 渲染面板骨架
	containerEl.innerHTML = `
		<div class="p-4 space-y-4">
			<!-- 标题栏 -->
			<div class="flex items-center justify-between">
				<h2 class="text-lg font-bold">🔬 AI诊断面板</h2>
				<div class="flex gap-2">
					<button id="aiDiag-btnRefresh" class="btn btn-sm btn-ghost">🔄 刷新状态</button>
					<button id="aiDiag-btnClear" class="btn btn-sm btn-ghost text-error">🗑️ 清空日志</button>
				</div>
			</div>

			<!-- 系统状态 -->
			<div class="card bg-base-100 shadow-sm">
				<div class="card-body p-3">
					<h3 class="card-title text-sm">📊 系统状态</h3>
					<div id="aiDiag-status">
						<div class="flex justify-center p-4">
							<span class="loading loading-spinner loading-md"></span>
						</div>
					</div>
				</div>
			</div>

			<!-- GetPrompt 注入记录 -->
			<div class="card bg-base-100 shadow-sm">
				<div class="card-body p-3">
					<div class="flex items-center justify-between">
						<h3 class="card-title text-sm">💉 注入记录 (GetPrompt)</h3>
						<button id="aiDiag-btnRefreshInj" class="btn btn-xs btn-ghost">🔄</button>
					</div>
					<div id="aiDiag-injection" class="max-h-40 overflow-y-auto">
						<div class="text-sm text-base-content/50 p-2">加载中...</div>
					</div>
				</div>
			</div>

			<!-- 记忆AI输出日志 -->
			<div class="card bg-base-100 shadow-sm">
				<div class="card-body p-3">
					<div class="flex items-center justify-between">
						<h3 class="card-title text-sm">🤖 记忆AI运行日志</h3>
						<div class="flex items-center gap-2">
							<label class="label cursor-pointer gap-1">
								<span class="label-text text-xs">自动刷新</span>
								<input type="checkbox" id="aiDiag-autoPoll" class="toggle toggle-xs toggle-primary" checked>
							</label>
						</div>
					</div>
					<div id="aiDiag-log" class="max-h-96 overflow-y-auto">
						<div class="text-sm text-base-content/50 p-2">等待记忆AI运行...</div>
					</div>
				</div>
			</div>

			<!-- 手动操作 -->
			<div class="card bg-base-100 shadow-sm">
				<div class="card-body p-3">
					<h3 class="card-title text-sm">🛠️ 手动操作</h3>
					<div class="flex flex-wrap gap-2">
						<button id="aiDiag-btnTestP1" class="btn btn-sm btn-outline btn-primary">
							🔍 手动触发P1检索 (DryRun)
						</button>
						<button id="aiDiag-btnCheckP1Cache" class="btn btn-sm btn-outline">
							📋 查看P1缓存内容
						</button>
					</div>
					<div id="aiDiag-manualResult" class="mt-2 max-h-60 overflow-y-auto"></div>
				</div>
			</div>
		</div>
	`

	// 绑定事件
	containerEl.querySelector('#aiDiag-btnRefresh')?.addEventListener('click', () => {
		refreshSnapshot()
		refreshInjectionLog()
	})

	containerEl.querySelector('#aiDiag-btnClear')?.addEventListener('click', clearOutputs)

	containerEl.querySelector('#aiDiag-btnRefreshInj')?.addEventListener('click', refreshInjectionLog)

	containerEl.querySelector('#aiDiag-autoPoll')?.addEventListener('change', (e) => {
		if (e.target.checked) {
			startPolling()
		} else {
			stopPolling()
		}
	})

	containerEl.querySelector('#aiDiag-btnTestP1')?.addEventListener('click', async () => {
		const resultArea = containerEl.querySelector('#aiDiag-manualResult')
		if (!resultArea) return
		resultArea.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 构建P1 Prompt (DryRun)...'

		try {
			const result = await callMemoryAPI({
				_action: 'runMemoryPreset',
				presetId: 'P1',
				dryRun: true,
				chatHistory: '(诊断面板 DryRun 测试)',
			})
			if (result.success && result.dryRun) {
				const msgs = result.messages || []
				let html = `<div class="text-xs text-success mb-1">✅ DryRun 成功 - ${msgs.length} 条消息</div>`
				for (const msg of msgs) {
					const contentPreview = (msg.content || '').substring(0, 200)
					html += `
						<details class="mb-1">
							<summary class="text-xs cursor-pointer">
								<span class="badge badge-xs ${msg.role === 'system' ? 'badge-info' : 'badge-ghost'}">${msg.role}</span>
								${contentPreview.substring(0, 60)}...
							</summary>
							<pre class="text-xs bg-base-300 rounded p-1 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">${escapeHtml(contentPreview)}</pre>
						</details>
					`
				}
				resultArea.innerHTML = html
			} else {
				resultArea.innerHTML = `<div class="text-error text-sm">${result.error || JSON.stringify(result)}</div>`
			}
		} catch (e) {
			resultArea.innerHTML = `<div class="text-error text-sm">❌ ${e.message}</div>`
		}
	})

	containerEl.querySelector('#aiDiag-btnCheckP1Cache')?.addEventListener('click', async () => {
		const resultArea = containerEl.querySelector('#aiDiag-manualResult')
		if (!resultArea) return
		resultArea.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 查询P1缓存...'

		try {
			const result = await callMemoryAPI({ _action: 'getDiagSnapshot' })
			if (result.hasP1Cache) {
				resultArea.innerHTML = `
					<div class="text-xs text-success mb-1">📋 P1缓存内容 (${result.p1CacheLength}字, ${fmtTime(result.p1CacheTimestamp)})</div>
					<pre class="text-xs bg-base-300 rounded p-2 whitespace-pre-wrap max-h-60 overflow-y-auto">${escapeHtml(result.p1CacheContent || '')}</pre>
				`
			} else {
				resultArea.innerHTML = '<div class="text-sm text-base-content/50">P1缓存为空 — 没有待注入的检索结果</div>'
			}
		} catch (e) {
			resultArea.innerHTML = `<div class="text-error text-sm">❌ ${e.message}</div>`
		}
	})

	// 初始加载
	isActive = true
	await refreshSnapshot()
	await refreshInjectionLog()
	await pollOutputs()
	startPolling()

	// 监听面板可见性变化
	const observer = new MutationObserver(() => {
		const nowActive = containerEl.classList.contains('active')
		if (nowActive && !isActive) {
			isActive = true
			startPolling()
			refreshSnapshot()
			refreshInjectionLog()
		} else if (!nowActive && isActive) {
			isActive = false
			stopPolling()
		}
	})
	observer.observe(containerEl, { attributes: true, attributeFilter: ['class'] })

	console.log('[aiDiag] AI诊断面板初始化完成')
}

function startPolling() {
	stopPolling()
	pollTimer = setInterval(pollOutputs, 3000)
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer)
		pollTimer = null
	}
}
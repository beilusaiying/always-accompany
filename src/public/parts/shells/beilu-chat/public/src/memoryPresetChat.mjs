/**
 * memoryPresetChat.mjs — 记忆AI预设交互模块 v2
 *
 * 布局：
 * - 活动栏（最左边）：P2-P6 预设切换按钮 + 底部文件树按钮
 * - 主区域：消息流界面（chat-messages 风格气泡）+ 底部输入区
 * - 侧边栏：文件树（默认隐藏，点击文件树按钮时展开）
 *
 * 负责：
 * - 活动栏预设切换渲染
 * - AI 对话面板（消息气泡、用户输入、运行预设）
 * - 文件树/消息流视图切换
 * - 与后端 beilu-memory 插件通信
 */

import { currentChatId } from './endpoints.mjs'

const MEMORY_API = '/api/parts/plugins:beilu-memory/config/setdata'

// ============================================================
// 状态
// ============================================================

let presets = []            // P1-P6 预设列表（从后端加载）
let selectedPresetId = null // 当前选中的预设ID
let isRunning = false       // 预设是否正在运行
let pollTimer = null        // 输出轮询定时器
let lastOutputId = 0        // 上次获取的输出ID
let messages = []           // 对话面板消息记录
let fileTreeVisible = false // 文件树是否可见

// ============================================================
// DOM 引用
// ============================================================

const els = {}

function cacheDom() {
	// 活动栏
	els.presetSwitcher = document.getElementById('mem-preset-switcher')
	els.fileTreeBtn = document.getElementById('mem-file-tree-btn')
	els.exportBtn = document.getElementById('mem-export-btn')
	els.importBtn = document.getElementById('mem-import-btn')
	els.importFileInput = document.getElementById('mem-import-file-input')
	els.togglePromptBtn = document.getElementById('mem-ai-toggle-prompt')
	els.promptPreview = document.getElementById('mem-ai-prompt-preview')
	els.promptContent = document.getElementById('mem-ai-prompt-content')

	// 侧边栏
	els.sidebar = document.getElementById('mem-sidebar')

	// 主区域 - 消息流视图
	els.chatView = document.getElementById('mem-chat-view')
	els.aiCurrentPreset = document.getElementById('mem-ai-current-preset')
	els.aiPresetDesc = document.getElementById('mem-ai-preset-desc')
	els.aiMessages = document.getElementById('mem-ai-messages')
	els.aiInput = document.getElementById('mem-ai-input')
	els.aiSendBtn = document.getElementById('mem-ai-send-btn')
	els.aiRunBtn = document.getElementById('mem-ai-run-btn')
	els.aiClearBtn = document.getElementById('mem-ai-clear-btn')

	// 主区域 - 文件视图
	els.fileView = document.getElementById('mem-file-view')
}

// ============================================================
// API 通信
// ============================================================

async function memoryPost(data) {
	const res = await fetch(MEMORY_API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) throw new Error(`API error: ${res.status}`)
	return res.json()
}

async function fetchPresets() {
	try {
		const res = await fetch('/api/parts/plugins:beilu-memory/config/getdata')
		if (!res.ok) throw new Error(`API error: ${res.status}`)
		const result = await res.json()
		return result?.memory_presets || []
	} catch (err) {
		console.error('[memoryPresetChat] 获取预设列表失败:', err)
		return []
	}
}

async function runPreset(presetId, userMessage) {
	// 获取当前角色名和用户名
	const charName = document.getElementById('char-name-display')?.textContent?.trim() || '角色'
	const userName = '用户'

	// 获取聊天历史（最近的消息）
	let chatHistory = ''
	try {
		const chatMessages = document.querySelectorAll('#chat-messages .chat-message .message-content')
		const recentMessages = Array.from(chatMessages).slice(-10)
		chatHistory = recentMessages.map(el => el.textContent?.trim()).filter(Boolean).join('\n---\n')
	} catch { /* ignore */ }

	const payload = {
		_action: 'runMemoryPreset',
		presetId,
		charDisplayName: charName,
		userDisplayName: userName,
		chatHistory: userMessage ? `${chatHistory}\n\n[用户额外要求]: ${userMessage}` : chatHistory,
		dryRun: false,
	}

	return memoryPost(payload)
}

async function getAIOutput(sinceId) {
	return memoryPost({
		_action: 'getMemoryAIOutput',
		sinceId,
	})
}

// ============================================================
// 活动栏：预设切换器渲染
// ============================================================

const TRIGGER_LABELS = {
	auto_on_message: '自动',
	auto_on_threshold: '阈值',
	manual_button: '手动',
	manual_or_auto: '手动/自动',
}

function renderPresetSwitcher() {
	if (!els.presetSwitcher) return

	// 只显示 P2-P6（P1 是自动检索，不需要手动操作）
	const manualPresets = presets.filter(p => p.id !== 'P1')

	if (manualPresets.length === 0) {
		els.presetSwitcher.innerHTML = '<div class="text-[10px] text-center opacity-30 py-2">无预设</div>'
		return
	}

	els.presetSwitcher.innerHTML = manualPresets.map(p => {
		const isActive = p.id === selectedPresetId && !fileTreeVisible
		const triggerLabel = TRIGGER_LABELS[p.trigger] || ''
		return `
			<button class="mem-switcher-btn ${isActive ? 'mem-switcher-active' : ''}"
					data-preset-id="${p.id}"
					title="${p.name || p.id}${p.description ? '\n' + p.description : ''}${triggerLabel ? '\n触发: ' + triggerLabel : ''}">
				<span class="mem-switcher-id">${p.id}</span>
			</button>
		`
	}).join('')

	// 绑定点击事件
	els.presetSwitcher.querySelectorAll('.mem-switcher-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			selectPreset(btn.dataset.presetId)
			showChatView()
		})
	})
}

// ============================================================
// 预设选择
// ============================================================

function selectPreset(presetId) {
	selectedPresetId = presetId
	const preset = presets.find(p => p.id === presetId)
	if (!preset) return

	// 更新活动栏高亮
	renderPresetSwitcher()

	// 更新标题栏
	if (els.aiCurrentPreset) {
		els.aiCurrentPreset.textContent = `${preset.id} ${preset.name || ''}`
	}
	if (els.aiPresetDesc) {
		els.aiPresetDesc.textContent = preset.description || ''
	}

	// 更新提示词预览
	updatePromptPreview(preset)
}

/** 当前提示词预览的标签页：'formatted' | 'rawjson' */
let promptPreviewTab = 'formatted'
/** 最近一次 fake-send 获取的完整结果 */
let lastFakeSendResult = null

function updatePromptPreview(preset) {
	if (!els.promptContent) return
	if (!preset) {
		els.promptContent.textContent = '(未选择预设)'
		return
	}
	// 如果预览面板可见，自动加载 fake-send
	if (els.promptPreview && !els.promptPreview.classList.contains('hidden')) {
		loadFakeSendPreview()
	} else {
		els.promptContent.textContent = '(点击 📝 按钮展开查看完整 Chat Completion request)'
	}
}

/** 调用 fake-send API 获取完整的聊天 AI request */
async function loadFakeSendPreview() {
	if (!els.promptContent) return
	if (!currentChatId) {
		els.promptContent.innerHTML = '<p class="text-xs text-error py-2">❌ 当前没有活跃的聊天（chatId 为空）</p>'
		return
	}

	els.promptContent.innerHTML = '<p class="text-xs text-base-content/40 text-center py-2">⏳ 正在构建 Chat Completion request...</p>'

	try {
		const url = `/api/parts/shells:chat/${currentChatId}/fake-send`
		const res = await fetch(url)
		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			throw new Error(err.error || `HTTP ${res.status}`)
		}
		const result = await res.json()
		lastFakeSendResult = result
		renderFakeSendPreview(result)
	} catch (err) {
		console.error('[memoryPresetChat] fake-send 加载失败:', err)
		els.promptContent.innerHTML = `<p class="text-xs text-error py-2">❌ 构建失败: ${escapeHtml(err.message)}</p>`
	}
}

/** 渲染 fake-send 结果（和 promptViewer 一样的效果） */
function renderFakeSendPreview(result) {
	if (!els.promptContent) return
	els.promptContent.innerHTML = ''

	const messages = result.messages || []
	const meta = result._meta || {}
	const totalChars = meta.total_chars ?? messages.reduce((sum, m) => sum + (m.content || '').length, 0)

	// 统计栏
	const statsDiv = document.createElement('div')
	statsDiv.className = 'text-xs text-base-content/40 mb-2 flex flex-wrap gap-x-3'
	const parts = [
		`${messages.length} 条消息`,
		`${totalChars.toLocaleString()} 字符`,
		`≈${(meta.estimated_tokens || Math.round(totalChars / 3.5)).toLocaleString()} tokens`,
	]
	if (meta.commander_mode) parts.push('🎖️ 司令员模式')
	if (result.model || meta.model) parts.push(`模型: ${result.model || meta.model}`)
	statsDiv.textContent = parts.join(' · ')
	els.promptContent.appendChild(statsDiv)

	// 标签页栏
	const tabBar = document.createElement('div')
	tabBar.className = 'flex gap-1 mb-2'
	tabBar.innerHTML = `
		<button class="btn btn-xs mem-prompt-tab ${promptPreviewTab === 'formatted' ? '' : 'btn-outline'}" data-tab="formatted">📝 消息列表</button>
		<button class="btn btn-xs mem-prompt-tab ${promptPreviewTab === 'rawjson' ? '' : 'btn-outline'}" data-tab="rawjson">📋 原始 JSON</button>
	`
	els.promptContent.appendChild(tabBar)

	tabBar.querySelectorAll('.mem-prompt-tab').forEach(btn => {
		btn.addEventListener('click', () => {
			promptPreviewTab = btn.dataset.tab
			renderFakeSendPreview(result)
		})
	})

	if (promptPreviewTab === 'rawjson') {
		renderFakeSendRawJson(result)
	} else {
		renderFakeSendMessages(messages)
	}
}

/** 消息列表视图（和 promptViewer 一致的可折叠消息卡片） */
function renderFakeSendMessages(messages) {
	if (!messages.length) {
		const p = document.createElement('p')
		p.className = 'text-xs text-base-content/40 text-center py-4'
		p.textContent = '没有消息'
		els.promptContent.appendChild(p)
		return
	}

	// 检测是否有 _source 标记（commanderMode）
	const hasSourceInfo = messages.some(m => m._source)
	const hasSectionInfo = messages.some(m => m._section)

	const sectionLabels = {
		beforeChat: '── ▼ 头部预设 (beforeChat) ▼ ──',
		injectionAbove: '── ▼ 注入上方 (@D≥1) ▼ ──',
		chatHistory: '── ▼ 聊天记录 ▼ ──',
		injectionBelow: '── ▼ 注入下方 (@D=0) ▼ ──',
		afterChat: '── ▼ 尾部预设 (afterChat) ▼ ──',
		before: '── ▼ 预设(头) ▼ ──',
		chat: '── ▼ 聊天记录 ▼ ──',
		after: '── ▼ 预设(尾) ▼ ──',
	}

	let currentSection = null

	messages.forEach((msg, idx) => {
		// section 分隔线
		if (hasSectionInfo && msg._section && msg._section !== currentSection) {
			const divider = document.createElement('div')
			divider.className = 'text-[10px] text-center text-base-content/30 py-1 my-1'
			divider.style.cssText = 'border-top: 1px dashed oklch(var(--bc) / 0.1);'
			divider.textContent = sectionLabels[msg._section] || `── ▼ ${msg._section} ▼ ──`
			els.promptContent.appendChild(divider)
			currentSection = msg._section
		}

		const card = document.createElement('div')
		card.className = 'rounded-md border border-base-content/10 overflow-hidden mb-1'
		if (msg._is_marker) card.style.opacity = '0.5'

		const roleColor = msg.role === 'system' ? 'text-blue-400' : msg.role === 'user' ? 'text-green-400' : 'text-purple-400'
		const roleBg = msg.role === 'system' ? 'bg-blue-500/5' : msg.role === 'user' ? 'bg-green-500/5' : 'bg-purple-500/5'
		const content = msg.content || ''
		const preview = content.substring(0, 80).replace(/\n/g, ' ')

		// source 标签
		let sourceTag = ''
		if (hasSourceInfo && msg._source) {
			const sourceMap = {
				preset: '📋预设', injection: '💉注入', chat_log: '💬对话',
			}
			sourceTag = `<span class="text-[9px] opacity-50">${sourceMap[msg._source] || msg._source}</span>`
		}

		// identifier 标签
		const identTag = msg._identifier ? `<span class="text-[9px] opacity-40 font-mono">${escapeHtml(msg._identifier)}</span>` : ''

		const header = document.createElement('div')
		header.className = `flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer ${roleBg}`
		header.innerHTML = `
			<span class="text-[10px] text-base-content/30">#${idx + 1}</span>
			<span class="badge badge-xs ${roleColor} font-mono">${escapeHtml(msg.role)}</span>
			${sourceTag}
			${identTag}
			<span class="flex-grow truncate text-base-content/50 text-[10px]">${escapeHtml(preview)}${content.length > 80 ? '...' : ''}</span>
			<span class="text-base-content/30 text-[10px] shrink-0">${content.length.toLocaleString()}</span>
			<span class="text-base-content/30 text-[10px] mem-msg-chevron">▶</span>
		`

		const body = document.createElement('pre')
		body.className = 'text-xs font-mono whitespace-pre-wrap p-2 max-h-64 overflow-y-auto'
		body.style.cssText = 'background: oklch(var(--bc) / 0.03); margin: 0; display: none;'
		body.textContent = content

		// 点击展开/折叠
		header.addEventListener('click', () => {
			const isOpen = body.style.display !== 'none'
			body.style.display = isOpen ? 'none' : ''
			header.querySelector('.mem-msg-chevron').textContent = isOpen ? '▶' : '▼'
		})

		card.appendChild(header)
		card.appendChild(body)
		els.promptContent.appendChild(card)
	})
}

/** 原始 JSON 视图 — 显示完整 JSON（不截断） */
function renderFakeSendRawJson(result) {
	const copyBar = document.createElement('div')
	copyBar.className = 'flex justify-end mb-1'
	const copyBtn = document.createElement('button')
	copyBtn.className = 'btn btn-xs btn-outline'
	copyBtn.textContent = '📋 复制完整 JSON'
	copyBar.appendChild(copyBtn)
	els.promptContent.appendChild(copyBar)

	const jsonStr = JSON.stringify(result, null, 2)
	const pre = document.createElement('pre')
	pre.className = 'text-xs font-mono whitespace-pre-wrap p-3 rounded-md overflow-y-auto select-all'
	pre.style.cssText = 'background: oklch(var(--bc) / 0.05); border: 1px solid oklch(var(--bc) / 0.1); max-height: 60vh;'
	pre.textContent = jsonStr
	els.promptContent.appendChild(pre)

	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(jsonStr)
			copyBtn.textContent = '✅ 已复制'
			setTimeout(() => { copyBtn.textContent = '📋 复制完整 JSON' }, 1500)
		} catch (err) { console.error('[memoryPresetChat] 复制失败:', err) }
	})
}

function togglePromptPreview() {
	if (!els.promptPreview) return
	const isHidden = els.promptPreview.classList.contains('hidden')
	els.promptPreview.classList.toggle('hidden')
	if (els.togglePromptBtn) {
		els.togglePromptBtn.title = isHidden ? '收起提示词' : '查看提示词'
	}
	// 展开时自动加载 fake-send
	if (isHidden) {
		loadFakeSendPreview()
	}
}

// ============================================================
// 视图切换
// ============================================================

function showChatView() {
	if (els.chatView) els.chatView.style.display = ''
	if (els.fileView) els.fileView.style.display = 'none'
	if (els.sidebar) els.sidebar.style.display = 'none'
	fileTreeVisible = false
	els.fileTreeBtn?.classList.remove('ide-activity-active')
}

function toggleFileTree() {
	fileTreeVisible = !fileTreeVisible
	if (fileTreeVisible) {
		// 显示文件树侧边栏 + 文件视图
		if (els.sidebar) els.sidebar.style.display = ''
		if (els.fileView) els.fileView.style.display = ''
		if (els.chatView) els.chatView.style.display = 'none'
		els.fileTreeBtn?.classList.add('ide-activity-active')
		// 更新活动栏（取消预设高亮）
		renderPresetSwitcher()
	} else {
		showChatView()
		renderPresetSwitcher()
	}
}

// ============================================================
// 消息面板
// ============================================================

function addMessage(role, content, meta) {
	const msg = { role, content, meta, timestamp: Date.now() }
	messages.push(msg)
	renderMessages()
	scrollToBottom()
}

function addSystemMessage(text) {
	addMessage('system', text)
}

function addUserMessage(text) {
	addMessage('user', text)
}

function addAIMessage(text, meta) {
	addMessage('ai', text, meta)
}

function renderMessages() {
	if (!els.aiMessages) return

	if (messages.length === 0) {
		els.aiMessages.innerHTML = '<p class="text-xs text-base-content/40 text-center py-4">选择一个预设并运行，AI输出将显示在这里</p>'
		return
	}

	els.aiMessages.innerHTML = messages.map(msg => {
		const isUser = msg.role === 'user'
		const isSystem = msg.role === 'system'
		const isAI = msg.role === 'ai'

		// 系统消息：居中简短提示
		if (isSystem) {
			return `<div class="mem-msg-system text-xs text-center text-base-content/50 py-1 my-1">${escapeHtml(msg.content)}</div>`
		}

		// 头像和名称
		const avatarIcon = isUser ? '👤' : '🧠'
		const name = isUser ? '用户' : (msg.meta?.presetName || '记忆AI')
		const avatarBg = isUser ? 'bg-base-300' : 'bg-amber-900/30'
		const nameColor = isUser ? 'text-base-content' : 'text-amber-700'

		// AI 状态标签
		let statusHtml = ''
		if (isAI && msg.meta) {
			const parts = []
			if (msg.meta.status === 'running') parts.push('⏳ 处理中...')
			if (msg.meta.status === 'done') parts.push('✅ 完成')
			if (msg.meta.status === 'error') parts.push('❌ 错误')
			if (msg.meta.rounds) parts.push(`${msg.meta.rounds}轮`)
			if (msg.meta.timeMs) parts.push(`${msg.meta.timeMs}ms`)
			if (parts.length) {
				statusHtml = `<span class="text-[10px] opacity-40 ml-2">${parts.join(' · ')}</span>`
			}
		}

		return `
			<div class="chat-message mb-3 group" data-template-type="memory-message">
				<div class="message-header flex items-center gap-2 px-1 mb-1">
					<div class="message-avatar w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ${avatarBg} flex items-center justify-center text-lg">
						${avatarIcon}
					</div>
					<span class="char-name text-sm font-bold ${nameColor}">${escapeHtml(name)}</span>
					<span class="message-timestamp text-xs opacity-40">${formatTime(msg.timestamp)}</span>
					${statusHtml}
				</div>
				<div class="chat-bubble relative p-[15px] ml-10 rounded-lg">
					<div class="message-content markdown-body text-sm whitespace-pre-wrap break-words">${escapeHtml(msg.content)}</div>
				</div>
			</div>
		`
	}).join('')
}

function scrollToBottom() {
	if (els.aiMessages) {
		requestAnimationFrame(() => {
			els.aiMessages.scrollTop = els.aiMessages.scrollHeight
		})
	}
}

function clearMessages() {
	messages = []
	renderMessages()
}

// ============================================================
// 运行预设
// ============================================================

async function handleRun() {
	if (!selectedPresetId) {
		addSystemMessage('⚠️ 请先在左侧选择一个预设')
		return
	}
	if (isRunning) {
		addSystemMessage('⚠️ 正在运行中，请等待完成')
		return
	}

	const preset = presets.find(p => p.id === selectedPresetId)
	const presetName = preset?.name || selectedPresetId

	isRunning = true
	updateRunButton()
	addAIMessage('正在运行...', { presetName, status: 'running' })

	// 开始轮询输出
	startOutputPolling()

	try {
		const result = await runPreset(selectedPresetId)

		// 更新最后一条AI消息
		const lastAI = messages.filter(m => m.role === 'ai').pop()
		if (lastAI) {
			lastAI.content = result?.reply || '(无输出)'
			lastAI.meta = {
				presetName,
				status: result?.error ? 'error' : 'done',
				rounds: result?.totalRounds,
				timeMs: result?.totalTimeMs,
			}
		}
		renderMessages()
		scrollToBottom()
	} catch (err) {
		const lastAI = messages.filter(m => m.role === 'ai').pop()
		if (lastAI) {
			lastAI.content = `运行失败: ${err.message}`
			lastAI.meta = { presetName, status: 'error' }
		}
		renderMessages()
	} finally {
		isRunning = false
		updateRunButton()
		stopOutputPolling()
	}
}

async function handleSend() {
	const text = els.aiInput?.value?.trim()
	if (!text) return

	if (!selectedPresetId) {
		addSystemMessage('⚠️ 请先在左侧选择一个预设')
		return
	}
	if (isRunning) {
		addSystemMessage('⚠️ 正在运行中，请等待完成')
		return
	}

	// 显示用户消息
	addUserMessage(text)
	els.aiInput.value = ''

	const preset = presets.find(p => p.id === selectedPresetId)
	const presetName = preset?.name || selectedPresetId

	isRunning = true
	updateRunButton()
	addAIMessage('正在处理...', { presetName, status: 'running' })

	startOutputPolling()

	try {
		const result = await runPreset(selectedPresetId, text)

		const lastAI = messages.filter(m => m.role === 'ai').pop()
		if (lastAI) {
			lastAI.content = result?.reply || '(无输出)'
			lastAI.meta = {
				presetName,
				status: result?.error ? 'error' : 'done',
				rounds: result?.totalRounds,
				timeMs: result?.totalTimeMs,
			}
		}
		renderMessages()
		scrollToBottom()
	} catch (err) {
		const lastAI = messages.filter(m => m.role === 'ai').pop()
		if (lastAI) {
			lastAI.content = `运行失败: ${err.message}`
			lastAI.meta = { presetName, status: 'error' }
		}
		renderMessages()
	} finally {
		isRunning = false
		updateRunButton()
		stopOutputPolling()
	}
}

function updateRunButton() {
	if (els.aiRunBtn) {
		els.aiRunBtn.disabled = isRunning
		els.aiRunBtn.textContent = isRunning ? '⏳ 运行中...' : '▶ 运行当前预设'
	}
	if (els.aiSendBtn) {
		els.aiSendBtn.disabled = isRunning
	}
}

// ============================================================
// 输出轮询
// ============================================================

function startOutputPolling() {
	stopOutputPolling()
	lastOutputId = 0
	pollTimer = setInterval(async () => {
		try {
			const result = await getAIOutput(lastOutputId)
			if (result?.outputs?.length) {
				for (const output of result.outputs) {
					if (output.id > lastOutputId) lastOutputId = output.id
					// 更新正在运行的AI消息的内容
					const lastAI = messages.filter(m => m.role === 'ai' && m.meta?.status === 'running').pop()
					if (lastAI && output.content) {
						lastAI.content = output.content
						renderMessages()
						scrollToBottom()
					}
				}
			}
		} catch { /* ignore polling errors */ }
	}, 2000)
}

function stopOutputPolling() {
	if (pollTimer) {
		clearInterval(pollTimer)
		pollTimer = null
	}
}

// ============================================================
// 导入导出
// ============================================================

async function handleExport() {
	addSystemMessage('📤 正在导出记忆文件...')
	try {
		// 获取当前角色 ID（从 data-char-id 属性读取，而非显示名）
		const charName = document.getElementById('char-name-display')?.dataset?.charId || ''
		const result = await memoryPost({ _action: 'exportMemory', charName })
		if (!result?.success) {
			addSystemMessage('❌ 导出失败: ' + (result?.error || '未知错误'))
			return
		}

		if (result.zipBase64) {
			// zip 格式导出：解码 base64 → Blob → 下载
			const binaryStr = atob(result.zipBase64)
			const bytes = new Uint8Array(binaryStr.length)
			for (let i = 0; i < binaryStr.length; i++) {
				bytes[i] = binaryStr.charCodeAt(i)
			}
			const blob = new Blob([bytes], { type: 'application/zip' })
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = result.fileName || `beilu-memory_${charName || 'export'}.zip`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
			addSystemMessage(`✅ 导出成功: ${result.fileCount} 个文件 → ${a.download}`)
		} else {
			addSystemMessage('❌ 导出失败: 未知响应格式')
		}
	} catch (err) {
		addSystemMessage('❌ 导出失败: ' + err.message)
	}
}

function handleImportClick() {
	els.importFileInput?.click()
}

async function handleImportFile(e) {
	const file = e.target.files?.[0]
	if (!file) return
	e.target.value = '' // 清空以允许重复选择同一文件

	addSystemMessage(`📥 正在读取 ${file.name}...`)

	try {
		// 获取当前角色 ID（从 data-char-id 属性读取，而非显示名）
		const charName = document.getElementById('char-name-display')?.dataset?.charId || ''

		if (file.name.endsWith('.zip')) {
			// ZIP 格式导入：读取为 base64 发送给后端
			const arrayBuffer = await file.arrayBuffer()
			const bytes = new Uint8Array(arrayBuffer)
			let binary = ''
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i])
			}
			const zipBase64 = btoa(binary)

			const confirmMsg = `确认导入 zip 记忆文件？\n文件: ${file.name}\n大小: ${(file.size / 1024).toFixed(1)} KB\n\n现有文件将被备份为 .import_bak`
			if (!confirm(confirmMsg)) {
				addSystemMessage('⏹ 已取消导入')
				return
			}

			addSystemMessage('📥 正在导入记忆文件 (zip)...')
			const result = await memoryPost({
				_action: 'importMemory',
				charName,
				zipBase64,
				backupExisting: true,
			})

			if (result?.success) {
				addSystemMessage(`✅ 导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`)
				if (result.errors?.length) {
					addSystemMessage('⚠️ 部分错误:\n' + result.errors.join('\n'))
				}
			} else {
				addSystemMessage('❌ 导入失败: ' + (result?.error || '未知错误'))
			}
		} else {
			// JSON 格式导入（旧格式兼容）
			const text = await file.text()
			let importData
			try {
				importData = JSON.parse(text)
			} catch {
				addSystemMessage('❌ 文件不是有效的 JSON 或 ZIP')
				return
			}

			if (importData._format !== 'beilu-memory-export') {
				addSystemMessage('❌ 文件格式不正确（缺少 beilu-memory-export 标识）')
				return
			}

			const fileCount = Object.keys(importData.files || {}).length
			const source = importData.charName || '未知角色'
			const exportedAt = importData.exportedAt || '未知时间'
			const confirmMsg = `确认导入 ${fileCount} 个记忆文件？\n来源: ${source}\n导出时间: ${exportedAt}\n\n现有文件将被备份为 .import_bak`

			if (!confirm(confirmMsg)) {
				addSystemMessage('⏹ 已取消导入')
				return
			}

			addSystemMessage('📥 正在导入记忆文件...')
			const result = await memoryPost({
				_action: 'importMemory',
				charName,
				importData,
				backupExisting: true,
			})

			if (result?.success) {
				addSystemMessage(`✅ 导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`)
				if (result.errors?.length) {
					addSystemMessage('⚠️ 部分错误:\n' + result.errors.join('\n'))
				}
			} else {
				addSystemMessage('❌ 导入失败: ' + (result?.error || '未知错误'))
			}
		}
	} catch (err) {
		addSystemMessage('❌ 导入失败: ' + err.message)
	}
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(text) {
	if (!text) return ''
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function formatTime(ts) {
	if (!ts) return ''
	const d = new Date(ts)
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

// ============================================================
// 初始化
// ============================================================

export async function initMemoryPresetChat() {
	cacheDom()

	// 绑定事件
	els.aiRunBtn?.addEventListener('click', handleRun)
	els.aiSendBtn?.addEventListener('click', handleSend)
	els.aiClearBtn?.addEventListener('click', clearMessages)
	els.fileTreeBtn?.addEventListener('click', toggleFileTree)
	els.exportBtn?.addEventListener('click', handleExport)
	els.importBtn?.addEventListener('click', handleImportClick)
	els.importFileInput?.addEventListener('change', handleImportFile)
	els.togglePromptBtn?.addEventListener('click', togglePromptPreview)

	// 输入框回车发送
	els.aiInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSend()
		}
	})

	// 加载预设列表
	presets = await fetchPresets()
	renderPresetSwitcher()

	// 默认选中第一个可用预设（P2）
	const firstManual = presets.find(p => p.id !== 'P1')
	if (firstManual) {
		selectPreset(firstManual.id)
	}

	console.log('[memoryPresetChat] 记忆AI预设交互模块已初始化')
}
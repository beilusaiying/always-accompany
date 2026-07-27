/**
 * promptViewer.mjs — 提示词查看器悬浮窗
 *
 * 功能：
 * - 可拖动/缩放的悬浮窗
 * - 调用 fake-send API 获取完整 Chat Completion request 预览
 * - 消息列表（可折叠）、模型参数网格、原始 JSON
 */
import { currentChatId } from '../../shared/transport/endpoints.mjs' // 6c尾·根级散件归位
import { escapeHtml, copyWithFeedback } from '../../shared/state/utils.mjs' // 6c尾·根级散件归位；[合并批 0714·二] 复制✅反馈收口单源
import { wbDetect } from '../../shared/widgets/whitebox.mjs' // 6c尾·根级散件归位
import { sendAction } from '../../shared/transport/sendAction.mjs' // 6c尾·根级散件归位 // T6b：出向统一门面（verb=真动作，getFakeSend 复用批K注册路由）

// ============================================================
// DOM 引用
// ============================================================

const win = () => document.getElementById('prompt-viewer-window')
const header = () => document.getElementById('prompt-viewer-header')
const resizeHandle = () => document.getElementById('pv-resize-handle')
const statusEl = () => document.getElementById('pv-status')
const buildBtn = () => document.getElementById('pv-build-btn')
const copyBtn = () => document.getElementById('pv-copy-btn')
const statsBar = () => document.getElementById('pv-stats')

// 统计元素
const statMsgs = () => document.getElementById('pv-stat-msgs')
const statSystem = () => document.getElementById('pv-stat-system')
const statTotal = () => document.getElementById('pv-stat-total')
const statTokens = () => document.getElementById('pv-stat-tokens')
const statModel = () => document.getElementById('pv-stat-model')

// 输出区域
const messagesOutput = () => document.getElementById('pv-messages-output')
const contextOutput = () => document.getElementById('pv-context-output')
const paramsOutput = () => document.getElementById('pv-params-output')
const rawOutput = () => document.getElementById('pv-raw-output')

// ============================================================
// 状态
// ============================================================

let lastResult = null
let isMaximized = false
let savedPosition = null // 最大化前保存的位置

// ============================================================
// 悬浮窗拖动
// ============================================================

function initDrag() {
	const el = win()
	const hdr = header()
	if (!el || !hdr) return

	let isDragging = false
	let startX, startY, startLeft, startTop

	hdr.addEventListener('mousedown', (e) => {
		// 不拖动控制按钮
		if (e.target.closest('.fw-controls')) return
		if (isMaximized) return

		isDragging = true
		el.classList.add('fw-dragging')

		const rect = el.getBoundingClientRect()
		startX = e.clientX
		startY = e.clientY
		startLeft = rect.left
		startTop = rect.top

		// 切换到绝对定位模式（取消 transform: translate(-50%, -50%)）
		el.style.transform = 'none'
		el.style.left = startLeft + 'px'
		el.style.top = startTop + 'px'

		e.preventDefault()
	})

	document.addEventListener('mousemove', (e) => {
		if (!isDragging) return
		const dx = e.clientX - startX
		const dy = e.clientY - startY
		el.style.left = (startLeft + dx) + 'px'
		el.style.top = (startTop + dy) + 'px'
	})

	document.addEventListener('mouseup', () => {
		if (isDragging) {
			isDragging = false
			el.classList.remove('fw-dragging')
		}
	})

	// FT-D8(凛倾批「做」): 触屏拖拽
	hdr.addEventListener('touchstart', (e) => {
		if (e.target.closest('.fw-controls') || isMaximized) return
		const t = e.touches[0]
		isDragging = true
		el.classList.add('fw-dragging')
		const rect = el.getBoundingClientRect()
		startX = t.clientX
		startY = t.clientY
		startLeft = rect.left
		startTop = rect.top
		el.style.transform = 'none'
		el.style.left = startLeft + 'px'
		el.style.top = startTop + 'px'
		e.preventDefault()
	}, { passive: false })
	document.addEventListener('touchmove', (e) => {
		if (!isDragging) return
		const t = e.touches[0]
		el.style.left = (startLeft + (t.clientX - startX)) + 'px'
		el.style.top = (startTop + (t.clientY - startY)) + 'px'
		e.preventDefault()
	}, { passive: false })
	document.addEventListener('touchend', () => {
		if (isDragging) {
			isDragging = false
			el.classList.remove('fw-dragging')
		}
	})
}

// ============================================================
// 悬浮窗缩放
// ============================================================

function initResize() {
	const el = win()
	const handle = resizeHandle()
	if (!el || !handle) return

	let isResizing = false
	let startX, startY, startW, startH

	handle.addEventListener('mousedown', (e) => {
		if (isMaximized) return
		isResizing = true
		startX = e.clientX
		startY = e.clientY
		startW = el.offsetWidth
		startH = el.offsetHeight
		e.preventDefault()
		e.stopPropagation()
	})

	document.addEventListener('mousemove', (e) => {
		if (!isResizing) return
		const newW = Math.max(360, startW + (e.clientX - startX))
		const newH = Math.max(300, startH + (e.clientY - startY))
		el.style.width = newW + 'px'
		el.style.height = newH + 'px'
	})

	document.addEventListener('mouseup', () => {
		isResizing = false
	})
}

// ============================================================
// 窗口控制
// ============================================================

/** 打开悬浮窗 */
export function openPromptViewer() {
	const el = win()
	if (!el) return
	el.classList.remove('hidden')
	if (isMaximized) return
	// 重置居中（无位置）或钳制（之前拖/缩到视口外/超大时重置）——
	// 防内联 left/top/width/height 残留导致标题栏跑到视口外、超大内容当 overlay 盖住整页（严重bug 001431）。
	let _bad = !el.style.left
	if (!_bad) {
		const r = el.getBoundingClientRect()
		const vw = window.innerWidth, vh = window.innerHeight
		// 出界（标题栏不可见/拖出屏）或尺寸超视口 → 判坏
		if (r.top < 0 || r.left < 0 || r.left > vw - 80 || r.top > vh - 40 || r.width > vw || r.height > vh) _bad = true
	}
	if (_bad) {
		el.style.transform = 'translate(-50%, -50%)'
		el.style.top = '50%'
		el.style.left = '50%'
		el.style.width = ''   // 回 CSS 默认尺寸
		el.style.height = ''
	}
}

/** 关闭悬浮窗 */
export function closePromptViewer() {
	const el = win()
	if (el) el.classList.add('hidden')
}

/** 最小化（暂时关闭） */
function minimizeWindow() {
	closePromptViewer()
}

/** 最大化/还原 */
function toggleMaximize() {
	const el = win()
	if (!el) return

	if (isMaximized) {
		// 还原
		el.classList.remove('fw-maximized')
		if (savedPosition) {
			el.style.left = savedPosition.left
			el.style.top = savedPosition.top
			el.style.width = savedPosition.width
			el.style.height = savedPosition.height
			el.style.transform = savedPosition.transform
		}
		isMaximized = false
	} else {
		// 保存当前位置
		savedPosition = {
			left: el.style.left,
			top: el.style.top,
			width: el.style.width,
			height: el.style.height,
			transform: el.style.transform,
		}
		el.classList.add('fw-maximized')
		isMaximized = true
	}
}

// ============================================================
// 选项卡切换
// ============================================================

function initTabs() {
	const el = win()
	if (!el) return

	el.querySelectorAll('.fw-tab-btn[data-pv-tab]').forEach(btn => {
		btn.addEventListener('click', () => {
			const tabName = btn.dataset.pvTab
			// 更新按钮状态
			el.querySelectorAll('.fw-tab-btn[data-pv-tab]').forEach(b => b.classList.remove('fw-tab-active'))
			btn.classList.add('fw-tab-active')
			// 切换内容
			el.querySelectorAll('.pv-tab-content').forEach(tc => tc.classList.add('hidden'))
			const target = document.getElementById(`pv-tab-${tabName}`)
			if (target) target.classList.remove('hidden')
		})
	})
}

// ============================================================
// 数据加载
// ============================================================

async function fetchFakeSend() {
	if (!currentChatId) {
		throw new Error('当前没有活跃的聊天（chatId 为空）')
	}
	// 门面 getFakeSend：scope.chatId 进 URL；!ok 由 apiFetch 抛错（含 body.error），走 handleBuildRequest catch。
	return sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId: currentChatId } })
}

async function handleBuildRequest() {
	const btn = buildBtn()
	const status = statusEl()
	if (btn) {
		btn.disabled = true
		btn.textContent = '构建中...'
	}
	if (status) status.textContent = '正在构建...'

	try {
		lastResult = await fetchFakeSend()
		renderResult(lastResult)
		if (status) status.textContent = `✅ ${new Date().toLocaleTimeString()}`
	} catch (err) {
		wbDetect("prompt", "buildPreview", false, err?.message)
		console.error('[promptViewer] fetchFakeSend error:', err)
		if (status) status.textContent = `❌ ${err.message}`
		const out = messagesOutput()
		if (out) out.innerHTML = `<p class="pv-placeholder" style="color:var(--beilu-error);">构建失败: ${escapeHtml(err.message)}</p>`
	} finally {
		if (btn) {
			btn.disabled = false
			btn.textContent = '🚀 构建请求'
		}
	}
}

// ============================================================
// 渲染
// ============================================================

function renderResult(result) {
	renderStats(result)
	renderMessages(result.messages || [])
	renderContext(result._meta?.context_parts)
	renderParams(result)
	renderRawJSON(result)
}

function renderStats(result) {
	const bar = statsBar()
	if (!bar) return
	bar.classList.remove('hidden')

	const msgs = result.messages || []
	const meta = result._meta || {}

	const sEl = statMsgs()
	if (sEl) {
		if (meta.commander_mode) {
			const presetCount = meta.preset_entry_count || msgs.filter(m => m._source === 'preset').length
			const chatCount = meta.chat_message_count || msgs.filter(m => m._source === 'chat_log').length
			const injCount = meta.injection_count || msgs.filter(m => m._source === 'injection').length
			sEl.textContent = `${msgs.length} 条 (预设${presetCount} 聊天${chatCount} 注入${injCount})`
		} else {
			sEl.textContent = `${msgs.length} 条消息`
		}
	}

	const systemChars = meta.system_chars ?? msgs
		.filter(m => m.role === 'system')
		.reduce((sum, m) => sum + (m.content?.length || 0), 0)
	const sysEl = statSystem()
	if (sysEl) sysEl.textContent = `系统 ${systemChars.toLocaleString()} 字符`

	const totalChars = meta.total_chars ?? msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0)
	const totEl = statTotal()
	if (totEl) totEl.textContent = `总计 ${totalChars.toLocaleString()} 字符`

	const tokEl = statTokens()
	if (tokEl) tokEl.textContent = `≈ ${meta.estimated_tokens?.toLocaleString() || Math.round(totalChars / 3.5).toLocaleString()} tokens`

	const modEl = statModel()
	if (modEl) modEl.textContent = meta.commander_mode ? '🎖️ 司令员模式' : `模型: ${result.model || meta.model || '-'}`
}

function renderMessages(messages) {
	const out = messagesOutput()
	if (!out) return

	if (!messages.length) {
		out.innerHTML = '<p class="pv-placeholder">没有消息</p>'
		return
	}

	out.innerHTML = ''

	// 检测是否有 _source 标记（commanderMode 返回的数据）
	const hasSourceInfo = messages.some(m => m._source)
	// 检测是否有 _section 标记（before/chat/after 分割）
	const hasSectionInfo = messages.some(m => m._section)

	// 5 段式 section 标签映射
	const sectionLabels = {
		beforeChat: '── ▼ 头部预设 (beforeChat) ▼ ──',
		injectionAbove: '── ▼ 注入上方 (@D≥1) ▼ ──',
		chatHistory: '── ▼ 聊天记录 ▼ ──',
		injectionBelow: '── ▼ 注入下方 (@D=0) ▼ ──',
		afterChat: '── ▼ 尾部预设 (afterChat) ▼ ──',
		// 向后兼容旧的 section 名称
		before: '── ▼ 预设(头) ▼ ──',
		chat: '── ▼ 聊天记录 ▼ ──',
		after: '── ▼ 预设(尾) ▼ ──',
	}

	// 跟踪当前 section，用于插入分隔线
	let currentSection = null

	messages.forEach((msg, i) => {
		// 在 section 切换时插入分隔线
		if (hasSectionInfo && msg._section && msg._section !== currentSection) {
			const divider = document.createElement('div')
			divider.className = 'pv-section-divider'
			// 根据 section 类型添加额外样式
			if (msg._section === 'injectionAbove' || msg._section === 'injectionBelow') {
				divider.classList.add('pv-section-injection')
			} else if (msg._section === 'chatHistory' || msg._section === 'chat') {
				divider.classList.add('pv-section-chat')
			}
			divider.textContent = sectionLabels[msg._section] || `── ▼ ${msg._section} ▼ ──`
			out.appendChild(divider)
			currentSection = msg._section
		}

		const card = document.createElement('div')
		card.className = 'pv-message'

		const role = msg.role || 'unknown'
		const content = msg.content || ''
		const preview = content.substring(0, 80).replace(/\n/g, ' ')
		const charCount = content.length
		const source = msg._source || ''
		const section = msg._section || ''

		// 角色样式
		const roleClass = role === 'system' ? 'pv-role-system' :
			role === 'user' ? 'pv-role-user' :
				role === 'assistant' ? 'pv-role-assistant' : ''

		// 来源标签（仅 commanderMode 下显示）
		let sourceTag = ''
		let sourceClass = ''
		if (hasSourceInfo) {
			if (source === 'preset') {
				if (section === 'beforeChat' || section === 'before') {
					sourceTag = msg._is_marker ? '<i data-ic="pin"></i> Marker' : '<i data-ic="clipboard"></i> 预设(头)'
					sourceClass = 'pv-source-preset'
				} else if (section === 'afterChat' || section === 'after') {
					sourceTag = msg._is_marker ? '<i data-ic="pin"></i> Marker' : '<i data-ic="clipboard"></i> 预设(尾)'
					sourceClass = 'pv-source-preset-after'
				} else {
					sourceTag = msg._is_marker ? '<i data-ic="pin"></i> Marker' : '<i data-ic="clipboard"></i> 预设'
					sourceClass = 'pv-source-preset'
				}
			} else if (source === 'injection') {
				if (section === 'injectionAbove') {
					sourceTag = '<i data-ic="syringe"></i> 注入↑'
					sourceClass = 'pv-source-injection-above'
				} else if (section === 'injectionBelow') {
					sourceTag = '<i data-ic="syringe"></i> 注入↓'
					sourceClass = 'pv-source-injection-below'
				} else {
					sourceTag = '<i data-ic="syringe"></i> 注入'
					sourceClass = 'pv-source-injection'
				}
			} else if (source === 'chat_log') {
				sourceTag = '<i data-ic="message"></i> 对话'
				sourceClass = 'pv-source-chat'
			}
		}

		// 标识符标签
		const identTag = msg._identifier ? `<span class="pv-ident-tag">${escapeHtml(msg._identifier)}</span>` : ''
		// 名称标签
		const nameTag = msg.name ? `<span class="pv-name-tag">${escapeHtml(msg.name)}</span>` : ''

		card.innerHTML = `
			<div class="pv-message-header">
				<span class="pv-msg-index">#${i + 1}</span>
				<span class="pv-role-badge ${roleClass}">${escapeHtml(role)}</span>
				${sourceTag ? `<span class="pv-source-badge ${sourceClass}">${sourceTag}</span>` : ''}
				${nameTag}
				${identTag}
				<span class="pv-message-preview">${escapeHtml(preview)}${charCount > 80 ? '...' : ''}</span>
				<span class="pv-message-chars">${charCount.toLocaleString()}</span>
				<span class="pv-message-chevron">▶</span>
			</div>
			<div class="pv-message-body">${escapeHtml(content)}</div>
		`

		// Marker 消息默认折叠且样式灰化
		if (msg._is_marker) {
			card.classList.add('pv-marker')
		}

		// 点击展开/折叠
		const headerEl = card.querySelector('.pv-message-header')
		headerEl.addEventListener('click', () => {
			card.classList.toggle('pv-expanded')
		})

		out.appendChild(card)
	})
}

// ============================================================
// 上下文总览
// ============================================================

function renderContext(contextParts) {
	const out = contextOutput()
	if (!out) return

	if (!contextParts) {
		out.innerHTML = '<p class="pv-placeholder">没有上下文数据</p>'
		return
	}

	out.innerHTML = ''

	const sections = [
		{ key: 'char', icon: '<i data-ic="drama"></i>', label: '角色描述', name: contextParts.char?.name },
		{ key: 'user', icon: '<i data-ic="person"></i>', label: '用户描述', name: contextParts.user?.name },
		{ key: 'world', icon: '<i data-ic="earth"></i>', label: '世界/场景', name: null },
	]

	// 主要部分
	for (const sec of sections) {
		const data = contextParts[sec.key]
		if (!data?.texts?.length) continue
		renderContextSection(out, sec.icon, sec.label, sec.name, data.texts)
	}

	// 其他角色
	const otherChars = contextParts.other_chars || {}
	for (const [charId, data] of Object.entries(otherChars)) {
		if (!data?.texts?.length) continue
		renderContextSection(out, '<i data-ic="drama"></i>', `其他角色: ${charId}`, null, data.texts)
	}

	// 插件
	const plugins = contextParts.plugins || {}
	for (const [pluginId, data] of Object.entries(plugins)) {
		if (!data?.texts?.length) continue
		renderContextSection(out, '<i data-ic="puzzle"></i>', `插件: ${pluginId}`, null, data.texts)
	}

	if (!out.children.length) {
		out.innerHTML = '<p class="pv-placeholder">所有上下文部分为空</p>'
	}
}

function renderContextSection(container, icon, label, name, texts) {
	const section = document.createElement('div')
	section.className = 'pv-ctx-section'

	const totalChars = texts.reduce((sum, t) => sum + (t.content?.length || 0), 0)

	const headerHtml = `
		<div class="pv-ctx-header">
			<span class="pv-ctx-icon">${icon}</span>
			<span class="pv-ctx-label">${escapeHtml(label)}</span>
			${name ? `<span class="pv-ctx-name">${escapeHtml(name)}</span>` : ''}
			<span class="pv-ctx-chars">${totalChars.toLocaleString()} 字符</span>
			<span class="pv-ctx-count">${texts.length} 段</span>
			<span class="pv-ctx-chevron">▶</span>
		</div>
	`
	section.innerHTML = headerHtml

	const body = document.createElement('div')
	body.className = 'pv-ctx-body'

	texts.forEach((t, i) => {
		const item = document.createElement('div')
		item.className = 'pv-ctx-item'
		const preview = (t.content || '').substring(0, 120).replace(/\n/g, ' ')
		item.innerHTML = `
			<div class="pv-ctx-item-header">
				<span class="pv-ctx-item-idx">#${i + 1}</span>
				<span class="pv-ctx-item-preview">${escapeHtml(preview)}${(t.content?.length || 0) > 120 ? '...' : ''}</span>
				<span class="pv-ctx-item-chars">${(t.content?.length || 0).toLocaleString()}</span>
			</div>
			<div class="pv-ctx-item-body">${escapeHtml(t.content || '')}</div>
		`
		// 点击展开/折叠
		const itemHeader = item.querySelector('.pv-ctx-item-header')
		itemHeader.addEventListener('click', () => item.classList.toggle('pv-ctx-expanded'))
		body.appendChild(item)
	})

	section.appendChild(body)

	// 点击 section header 展开/折叠
	const sectionHeader = section.querySelector('.pv-ctx-header')
	sectionHeader.addEventListener('click', () => section.classList.toggle('pv-ctx-open'))

	// 默认展开
	section.classList.add('pv-ctx-open')

	container.appendChild(section)
}

function renderParams(result) {
	const out = paramsOutput()
	if (!out) return

	const meta = result._meta || {}
	const params = []

	// 基本信息
	if (meta.charname) params.push(['角色', meta.charname])
	params.push(['模式', meta.commander_mode ? '🎖️ 司令员模式' : '标准模式'])
	params.push(['来源', meta.source || '-'])

	// commanderMode 下显示模型参数（来自预设）
	if (meta.commander_mode && meta.model_params) {
		const mp = meta.model_params
		params.push(['---', '--- 模型参数 ---'])
		if (mp.temperature != null) params.push(['temperature', mp.temperature])
		if (mp.top_p != null) params.push(['top_p', mp.top_p])
		if (mp.top_k != null) params.push(['top_k', mp.top_k])
		if (mp.min_p != null) params.push(['min_p', mp.min_p])
		if (mp.max_tokens != null) params.push(['max_tokens', mp.max_tokens])
		if (mp.frequency_penalty != null) params.push(['frequency_penalty', mp.frequency_penalty])
		if (mp.presence_penalty != null) params.push(['presence_penalty', mp.presence_penalty])
		if (mp.repetition_penalty != null) params.push(['repetition_penalty', mp.repetition_penalty])
	} else {
		params.push(['model', result.model || '-'])
		params.push(['temperature', result.temperature ?? '-'])
		params.push(['top_p', result.top_p ?? '-'])
		params.push(['max_tokens', result.max_tokens ?? '-'])
	}

	// 分段统计
	params.push(['---', '--- 统计 ---'])
	if (meta.chat_log_count != null) params.push(['聊天记录条数', meta.chat_log_count])
	if (meta.preset_entry_count != null) params.push(['预设条目数', meta.preset_entry_count])
	if (meta.chat_message_count != null) params.push(['对话消息数', meta.chat_message_count])
	if (meta.injection_above_count != null) params.push(['注入上方条目', meta.injection_above_count])
	if (meta.injection_below_count != null) params.push(['注入下方条目', meta.injection_below_count])
	if (meta.injection_count != null) params.push(['注入总条目数', meta.injection_count])
	if (meta.total_chars != null) params.push(['总字符数', meta.total_chars.toLocaleString()])
	if (meta.system_chars != null) params.push(['系统区字符', meta.system_chars.toLocaleString()])
	if (meta.chat_chars != null) params.push(['对话区字符', meta.chat_chars.toLocaleString()])
	if (meta.injection_chars != null) params.push(['注入区字符', meta.injection_chars.toLocaleString()])
	if (meta.estimated_tokens != null) params.push(['预估 tokens', meta.estimated_tokens.toLocaleString()])

	out.innerHTML = `
		<div class="pv-params-grid">
			${params.map(([label, value]) => {
				if (label === '---') {
					return `<div class="pv-param-divider">${escapeHtml(String(value))}</div>`
				}
				return `
				<div class="pv-param-item">
					<div class="pv-param-label">${escapeHtml(label)}</div>
					<div class="pv-param-value">${escapeHtml(String(value))}</div>
				</div>
			`}).join('')}
		</div>
	`
}

function renderRawJSON(result) {
	const out = rawOutput()
	if (!out) return

	// 截断 messages 内容防止 JSON 太长，但保留元数据字段
	const display = { ...result }
	if (display.messages) {
		display.messages = display.messages.map(m => {
			const entry = {
				role: m.role,
				content: m.content?.length > 200
					? m.content.substring(0, 200) + `... [共 ${m.content.length} 字符]`
					: m.content,
			}
			if (m.name) entry.name = m.name
			if (m._source) entry._source = m._source
			if (m._section) entry._section = m._section
			if (m._identifier) entry._identifier = m._identifier
			if (m._depth != null) entry._depth = m._depth
			if (m._injection_depth != null) entry._injection_depth = m._injection_depth
			if (m._is_marker) entry._is_marker = m._is_marker
			return entry
		})
	}

	out.innerHTML = `<pre class="pv-raw-json">${escapeHtml(JSON.stringify(display, null, 2))}</pre>`
}

// ============================================================
// 复制
// ============================================================

async function handleCopy() {
	if (!lastResult) return
	await copyWithFeedback(JSON.stringify(lastResult, null, 2), copyBtn())
}

// ============================================================
// 工具
// ============================================================

// ============================================================
// 初始化
// ============================================================

export function initPromptViewer() {
	initDrag()
	initResize()
	initTabs()

	// 窗口控制按钮
	document.getElementById('pv-minimize')?.addEventListener('click', minimizeWindow)
	document.getElementById('pv-maximize')?.addEventListener('click', toggleMaximize)
	document.getElementById('pv-close')?.addEventListener('click', closePromptViewer)

	// 构建和复制
	buildBtn()?.addEventListener('click', handleBuildRequest)
	copyBtn()?.addEventListener('click', handleCopy)

	// B3修复→T3修2: ESC 关闭提示词查看器走中央仲裁注册表（浮窗 priority 20），不再自注册 document keydown
	{
		const reg = (window._beiluEscRegistry = window._beiluEscRegistry || [])
		if (!reg.some((r) => r && r._id === 'prompt-viewer')) {
			reg.push({
				_id: 'prompt-viewer',
				priority: 20,
				isOpen: () => { const el = win(); return el && !el.classList.contains('hidden') },
				close: () => closePromptViewer(),
			})
		}
	}

	console.log('[promptViewer] 提示词查看器已初始化')
}
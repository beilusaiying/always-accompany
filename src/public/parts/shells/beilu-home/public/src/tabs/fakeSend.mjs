/**
 * beilu-home 伪发送（Fake Send）模块
 * 模拟完整的 AI 调用链路，生成 Chat Completion request 预览
 * 不实际发送给 AI
 *
 * 功能：
 * - 选择聊天 → 构建完整 messages[] + 模型参数
 * - 消息列表（可折叠展开每条消息）
 * - 模型参数面板
 * - 原始 JSON 查看 + 复制
 * - Token 统计
 */

const CHATLIST_API = '/api/parts/shells:chat/getchatlist'

// ============================================================
// DOM 引用
// ============================================================

let dom = {}

// ============================================================
// API 通信
// ============================================================

async function fetchChatList() {
	const res = await fetch(CHATLIST_API)
	if (!res.ok) throw new Error(`获取聊天列表失败: ${res.statusText}`)
	return res.json()
}

async function fetchFakeSend(chatid) {
	const res = await fetch(`/api/parts/shells:chat/${chatid}/fake-send`)
	if (!res.ok) {
		const errData = await res.json().catch(() => ({}))
		throw new Error(errData.error || `伪发送失败: ${res.statusText}`)
	}
	return res.json()
}

// ============================================================
// 渲染辅助
// ============================================================

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

function formatChars(chars) {
	if (chars > 10000) return `${(chars / 1000).toFixed(1)}K`
	return String(chars)
}

// ============================================================
// 渲染聊天列表
// ============================================================

async function loadChatList() {
	try {
		const chatList = await fetchChatList()
		if (!dom.chatSelect) return

		// 保留当前选中值
		const currentVal = dom.chatSelect.value

		dom.chatSelect.innerHTML = '<option value="">选择一个聊天...</option>'
		for (const chat of chatList) {
			const charNames = (chat.chars || []).join(', ') || '无角色'
			const preview = (chat.lastMessageContent || '').slice(0, 40)
			const opt = document.createElement('option')
			opt.value = chat.chatid
			opt.textContent = `[${charNames}] ${preview}${preview.length >= 40 ? '...' : ''}`
			dom.chatSelect.appendChild(opt)
		}

		// 恢复之前选中
		if (currentVal) dom.chatSelect.value = currentVal
	} catch (err) {
		console.error('[fakeSend] 加载聊天列表失败:', err)
	}
}

// ============================================================
// 渲染伪发送结果
// ============================================================

let lastResult = null

function renderResult(result) {
	lastResult = result

	// 统计栏
	if (dom.stats) {
		dom.stats.style.display = ''
		dom.msgCount.textContent = result._meta?.message_count || result.messages?.length || 0
		dom.sysChars.textContent = formatChars(result._meta?.system_prompt_chars || 0)
		dom.totalChars.textContent = formatChars(result._meta?.total_chars || 0)
		dom.estTokens.textContent = formatChars(result._meta?.estimated_tokens || 0)
		dom.model.textContent = result.model || '(未配置)'
	}

	// 消息列表
	renderMessages(result.messages || [])

	// 模型参数
	renderParams(result)

	// 原始 JSON
	renderRawJSON(result)

	// 状态
	if (dom.status) {
		const time = result._meta?.timestamp
		dom.status.textContent = time
			? `生成于 ${new Date(time).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
			: '已生成'
	}
}

function renderMessages(messages) {
	if (!dom.messagesOutput) return

	if (!messages.length) {
		dom.messagesOutput.innerHTML = '<p class="text-xs text-base-content/30 text-center py-8">无消息</p>'
		return
	}

	const parts = []
	messages.forEach((msg, idx) => {
		const role = msg.role || 'unknown'
		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		const preview = content.slice(0, 80).replace(/\n/g, ' ')
		const chars = content.length

		parts.push(`<div class="beilu-fs-message" data-idx="${idx}">`)
		parts.push(`  <div class="beilu-fs-message-header" onclick="this.parentElement.classList.toggle('expanded')">`)
		parts.push(`    <span class="role-badge ${role}">${role}</span>`)
		parts.push(`    <span class="msg-preview">${escapeHtml(preview)}${content.length > 80 ? '...' : ''}</span>`)
		parts.push(`    <span class="msg-chars">${formatChars(chars)}字</span>`)
		parts.push(`    <span class="toggle-icon">▶</span>`)
		parts.push(`  </div>`)
		parts.push(`  <div class="beilu-fs-message-body">${escapeHtml(content)}</div>`)
		parts.push(`</div>`)
	})

	dom.messagesOutput.innerHTML = parts.join('\n')
}

function renderParams(result) {
	if (!dom.paramsOutput) return

	const paramKeys = ['model', 'temperature', 'max_tokens', 'stream', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'stop']
	const parts = ['<div class="beilu-fs-params-grid">']

	for (const key of paramKeys) {
		const value = result[key]
		if (value === undefined || value === null) continue

		let displayVal
		if (typeof value === 'boolean') displayVal = value ? '✅ true' : '❌ false'
		else if (Array.isArray(value)) displayVal = JSON.stringify(value)
		else displayVal = String(value)

		parts.push(`<div class="beilu-fs-param-item">`)
		parts.push(`  <span class="param-name">${key}</span>`)
		parts.push(`  <span class="param-value">${escapeHtml(displayVal)}</span>`)
		parts.push(`</div>`)
	}

	parts.push('</div>')

	// 元信息
	if (result._meta) {
		parts.push('<div class="text-xs text-base-content/40 mt-3 p-2 space-y-1">')
		parts.push(`  <div>角色: <strong class="text-base-content/60">${escapeHtml(result._meta.char_display_name || '-')}</strong></div>`)
		parts.push(`  <div>用户: <strong class="text-base-content/60">${escapeHtml(result._meta.user_display_name || '-')}</strong></div>`)
		parts.push(`  <div>聊天记录条目: <strong class="text-base-content/60">${result._meta.chat_log_entries || 0}</strong></div>`)
		parts.push(`  <div>消息总数: <strong class="text-base-content/60">${result._meta.message_count || 0}</strong></div>`)
		parts.push('</div>')
	}

	dom.paramsOutput.innerHTML = parts.join('\n')
}

function renderRawJSON(result) {
	if (!dom.rawOutput) return

	try {
		// 为了可读性，messages 内容截断显示
		const displayObj = { ...result }
		if (displayObj.messages) {
			displayObj.messages = displayObj.messages.map((m, i) => ({
				...m,
				content: m.content?.length > 200
					? m.content.slice(0, 200) + `... (${m.content.length} 字符，展开消息列表查看完整内容)`
					: m.content,
			}))
		}
		dom.rawOutput.textContent = JSON.stringify(displayObj, null, 2)
	} catch {
		dom.rawOutput.textContent = '无法序列化结果'
	}
}

// ============================================================
// 子选项卡切换
// ============================================================

function setupSubTabs() {
	const tabBtns = document.querySelectorAll('.fs-sub-tab')
	tabBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			const tabId = btn.dataset.fsTab

			tabBtns.forEach(b => {
				b.classList.toggle('active', b === btn)
				if (b !== btn) b.classList.add('btn-outline')
				else b.classList.remove('btn-outline')
			})

			document.querySelectorAll('.fs-tab-content').forEach(c => {
				c.style.display = c.id === `fs-tab-${tabId}` ? '' : 'none'
				c.classList.toggle('active', c.id === `fs-tab-${tabId}`)
			})
		})
	})
}

// ============================================================
// 操作
// ============================================================

async function handleBuildRequest() {
	const chatid = dom.chatSelect?.value
	if (!chatid) {
		alert('请先选择一个聊天')
		return
	}

	if (dom.status) dom.status.textContent = '构建中...'
	if (dom.buildBtn) dom.buildBtn.disabled = true

	try {
		const result = await fetchFakeSend(chatid)
		renderResult(result)
	} catch (err) {
		console.error('[fakeSend] 构建请求失败:', err)
		if (dom.messagesOutput) {
			dom.messagesOutput.innerHTML = `<p class="text-xs text-error text-center py-4">构建失败: ${escapeHtml(err.message)}</p>`
		}
		if (dom.status) dom.status.textContent = '构建失败'
	} finally {
		if (dom.buildBtn) dom.buildBtn.disabled = false
	}
}

function handleCopyRaw() {
	if (!lastResult) return
	try {
		const json = JSON.stringify(lastResult, null, 2)
		navigator.clipboard.writeText(json).then(() => {
			const btn = dom.copyRawBtn
			if (btn) {
				const orig = btn.textContent
				btn.textContent = '✅ 已复制'
				setTimeout(() => { btn.textContent = orig }, 1500)
			}
		})
	} catch {
		// fallback
	}
}

// ============================================================
// 初始化
// ============================================================

export async function init() {
	dom = {
		chatSelect: document.getElementById('fake-send-chat-select'),
		buildBtn: document.getElementById('fake-send-btn'),
		refreshChatsBtn: document.getElementById('fake-send-refresh-chats'),
		status: document.getElementById('fake-send-status'),
		stats: document.getElementById('fake-send-stats'),
		msgCount: document.getElementById('fs-msg-count'),
		sysChars: document.getElementById('fs-sys-chars'),
		totalChars: document.getElementById('fs-total-chars'),
		estTokens: document.getElementById('fs-est-tokens'),
		model: document.getElementById('fs-model'),
		messagesOutput: document.getElementById('fs-messages-output'),
		paramsOutput: document.getElementById('fs-params-output'),
		rawOutput: document.getElementById('fs-raw-output'),
		copyRawBtn: document.getElementById('fs-copy-raw'),
	}

	// 事件绑定
	dom.buildBtn?.addEventListener('click', handleBuildRequest)
	dom.refreshChatsBtn?.addEventListener('click', loadChatList)
	dom.copyRawBtn?.addEventListener('click', handleCopyRaw)

	// 子选项卡
	setupSubTabs()

	// 加载聊天列表
	await loadChatList()
}
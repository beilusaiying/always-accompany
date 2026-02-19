/**
 * beilu-home 插件配置面板模块
 * 处理 beilu-files 可展开配置面板的交互和 API 调用
 */

const API_BASE = '/api/parts/plugins:beilu-files/config'

// ============================================================
// API 通信
// ============================================================

async function getConfig() {
	const res = await fetch(`${API_BASE}/getdata`)
	if (!res.ok) throw new Error(`获取配置失败: ${res.statusText}`)
	return res.json()
}

async function setConfig(data) {
	const res = await fetch(`${API_BASE}/setdata`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) throw new Error(`保存失败: ${res.statusText}`)
	return res.json()
}

// ============================================================
// DOM 引用
// ============================================================

let dom = {}

function getDom() {
	return {
		expandable: document.getElementById('plugin-beilu-files'),
		header: document.querySelector('#plugin-beilu-files .beilu-part-item-header'),
		configPanel: document.getElementById('beilu-files-config'),
		autoRead: document.getElementById('bf-auto-read'),
		autoAll: document.getElementById('bf-auto-all'),
		allowExec: document.getElementById('bf-allow-exec'),
		customPromptToggle: document.getElementById('bf-custom-prompt-toggle'),
		customPrompt: document.getElementById('bf-custom-prompt'),
		allowedPaths: document.getElementById('bf-allowed-paths'),
		blockedPaths: document.getElementById('bf-blocked-paths'),
		newAllowed: document.getElementById('bf-new-allowed'),
		newBlocked: document.getElementById('bf-new-blocked'),
		addAllowed: document.getElementById('bf-add-allowed'),
		addBlocked: document.getElementById('bf-add-blocked'),
		activeMode: document.getElementById('bf-active-mode'),
		saveBtn: document.getElementById('bf-save-config'),
	}
}

// ============================================================
// 渲染路径列表
// ============================================================

function renderPathList(container, paths, type) {
	if (!container) return
	container.innerHTML = ''
	if (!paths || paths.length === 0) {
		container.innerHTML = '<span class="text-xs text-base-content/30">（空）</span>'
		return
	}
	paths.forEach(p => {
		const tag = document.createElement('div')
		tag.className = 'beilu-path-tag'
		tag.innerHTML = `<span>${escapeHtml(p)}</span><span class="path-remove" data-path="${escapeHtml(p)}" data-type="${type}">✕</span>`
		container.appendChild(tag)
	})
}

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

// ============================================================
// 加载配置到 UI
// ============================================================

async function loadConfig() {
	try {
		const data = await getConfig()

		if (dom.autoRead) dom.autoRead.checked = data.autoApproveRead ?? true
		if (dom.autoAll) dom.autoAll.checked = data.autoApprove ?? false
		if (dom.allowExec) dom.allowExec.checked = data.allowExec ?? false
		if (dom.customPromptToggle) dom.customPromptToggle.checked = data.customPromptEnabled ?? false
		if (dom.customPrompt) {
			dom.customPrompt.value = data.customPrompt || ''
			dom.customPrompt.disabled = !data.customPromptEnabled
		}
		if (dom.activeMode) dom.activeMode.textContent = data.activeMode || 'chat'

		renderPathList(dom.allowedPaths, data.allowedPaths, 'allowed')
		renderPathList(dom.blockedPaths, data.blockedPaths, 'blocked')
	} catch (err) {
		console.error('[pluginConfig] 加载配置失败:', err)
	}
}

// ============================================================
// 保存配置
// ============================================================

async function saveConfig() {
	try {
		await setConfig({
			autoApproveRead: dom.autoRead?.checked ?? true,
			autoApproveList: true, // 始终自动批准 list
			autoApprove: dom.autoAll?.checked ?? false,
			allowExec: dom.allowExec?.checked ?? false,
			customPromptEnabled: dom.customPromptToggle?.checked ?? false,
			customPrompt: dom.customPrompt?.value || '',
		})
		// 视觉反馈
		if (dom.saveBtn) {
			const orig = dom.saveBtn.textContent
			dom.saveBtn.textContent = '✅ 已保存'
			setTimeout(() => { dom.saveBtn.textContent = orig }, 1500)
		}
	} catch (err) {
		console.error('[pluginConfig] 保存配置失败:', err)
		if (dom.saveBtn) {
			dom.saveBtn.textContent = '❌ 保存失败'
			setTimeout(() => { dom.saveBtn.textContent = '💾 保存配置' }, 2000)
		}
	}
}

// ============================================================
// 路径管理
// ============================================================

async function addPath(type) {
	const input = type === 'allowed' ? dom.newAllowed : dom.newBlocked
	const path = input?.value?.trim()
	if (!path) return
	try {
		await setConfig({ _action: type === 'allowed' ? 'addAllowedPath' : 'addBlockedPath', path })
		input.value = ''
		await loadConfig()
	} catch (err) {
		console.error(`[pluginConfig] 添加${type}路径失败:`, err)
	}
}

async function removePath(type, path) {
	try {
		await setConfig({ _action: type === 'allowed' ? 'removeAllowedPath' : 'removeBlockedPath', path })
		await loadConfig()
	} catch (err) {
		console.error(`[pluginConfig] 移除${type}路径失败:`, err)
	}
}

// ============================================================
// 初始化
// ============================================================

export async function init() {
	dom = getDom()
	if (!dom.expandable || !dom.header) {
		console.warn('[pluginConfig] beilu-files 展开面板 DOM 未找到')
		return
	}

	// 展开/折叠交互
	dom.header.addEventListener('click', (e) => {
		// 避免点击 toggle 开关时触发展开
		if (e.target.closest('.toggle')) return

		const isExpanded = dom.expandable.classList.toggle('expanded')
		if (dom.configPanel) {
			dom.configPanel.style.display = isExpanded ? 'block' : 'none'
		}
		// 首次展开时加载配置
		if (isExpanded) {
			loadConfig()
		}
	})

	// 自定义提示词 toggle
	dom.customPromptToggle?.addEventListener('change', () => {
		if (dom.customPrompt) {
			dom.customPrompt.disabled = !dom.customPromptToggle.checked
		}
	})

	// 路径管理
	dom.addAllowed?.addEventListener('click', () => addPath('allowed'))
	dom.addBlocked?.addEventListener('click', () => addPath('blocked'))

	// Enter 快捷键
	dom.newAllowed?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPath('allowed') })
	dom.newBlocked?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPath('blocked') })

	// 路径删除（事件委托）
	dom.allowedPaths?.addEventListener('click', (e) => {
		const rm = e.target.closest('.path-remove')
		if (rm) removePath('allowed', rm.dataset.path)
	})
	dom.blockedPaths?.addEventListener('click', (e) => {
		const rm = e.target.closest('.path-remove')
		if (rm) removePath('blocked', rm.dataset.path)
	})

	// 保存
	dom.saveBtn?.addEventListener('click', saveConfig)

	console.log('[pluginConfig] beilu-files 配置面板已初始化')
}
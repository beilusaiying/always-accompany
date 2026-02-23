/**
 * memoryPreset.mjs — 记忆预设管理模块
 *
 * 通过 beilu-memory 插件的 config 接口管理6个内置记忆预设。
 * 每个预设控制记忆系统某个环节（检索/总结/归档/修复）的AI行为。
 */

// ===== API 通信 =====

import { getAllCachedPartDetails } from '/scripts/parts.mjs'

const PLUGIN_NAME = 'beilu-memory'
const SSM_API_BASE = '/api/parts/shells:serviceSourceManage'

async function getPluginData() {
	try {
		let url = `/api/parts/plugins:${PLUGIN_NAME}/config/getdata`
		if (currentCharId) url += `?char_id=${encodeURIComponent(currentCharId)}`
		const resp = await fetch(url)
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
		return await resp.json()
	} catch (e) {
		console.error('[memoryPreset] getPluginData 失败:', e)
		return null
	}
}

/** 从 serviceSourceManage 获取已配置的 AI 服务源名称列表 */
async function fetchAISourceList() {
	try {
		const resp = await fetch(`${SSM_API_BASE}/AI`)
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
		return await resp.json() // string[]
	} catch (e) {
		console.error('[memoryPreset] 获取 AI 服务源列表失败:', e)
		return []
	}
}

/**
 * 加载指定源的模型列表并填充到 datalist
 * @param {string} sourceName
 */
async function loadModelsForSource(sourceName) {
	if (!sourceName) return
	
	// 同时更新 datalist 和 select
	const datalist = document.getElementById('model-list')
	const select = dom.apiModelSelect
	const input = dom.apiModel
	let originalPlaceholder = input ? input.placeholder : '输入或选择模型'

	try {
		// UI 反馈：显示加载中
		if (input) {
			input.placeholder = '正在加载模型列表...'
			input.classList.add('loading-input')
		}
		if (select) {
			select.style.display = ''
			select.innerHTML = '<option>正在加载模型...</option>'
			select.disabled = true
		}

		// 先从 serviceSourceManage 获取源的完整配置（含 url/key）
		let sourceUrl = '', sourceKey = ''
		try {
			const configResp = await fetch(`${SSM_API_BASE}/AI/${encodeURIComponent(sourceName)}`)
			if (configResp.ok) {
				const sourceConfig = await configResp.json()
				sourceUrl = sourceConfig.config?.url || sourceConfig.config?.base_url || ''
				sourceKey = sourceConfig.config?.apikey || ''
			}
		} catch (e) {
			console.warn('[memoryPreset] 获取源配置失败，回退到 sourceName 方式:', e.message)
		}

		// 优先通过 apiConfig 分支（携带 url/key），避免 username 路径问题
		let payload
		if (sourceUrl) {
			payload = { _action: 'getModels', apiConfig: { url: sourceUrl, key: sourceKey } }
		} else {
			// 回退：旧方式（可能因 username 不对而失败）
			payload = { _action: 'getModels', sourceName: sourceName }
			if (currentUsername) payload.username = currentUsername
		}

		const res = await setPluginData(payload)

		if (res.success && Array.isArray(res.models)) {
			// 1. 更新 datalist
			if (datalist) {
				datalist.innerHTML = ''
				res.models.forEach(model => {
					const option = document.createElement('option')
					option.value = model
					datalist.appendChild(option)
				})
			}

			// 2. 更新 select
			if (select) {
				select.innerHTML = '<option value="" disabled selected>▼ 点击选择模型 (或在上方直接输入)</option>'
				res.models.forEach(model => {
					const option = document.createElement('option')
					option.value = model
					option.textContent = model
					select.appendChild(option)
				})
				select.disabled = false
				select.style.display = '' // 显示下拉框
			}

			console.log(`[memoryPreset] 已加载 ${res.models.length} 个模型`)
			
			// 加载成功提示
			if (input) {
				input.placeholder = `已加载 ${res.models.length} 个模型`
				input.classList.add('input-success')
				setTimeout(() => input.classList.remove('input-success'), 1000)
			}
		} else {
			console.warn('[memoryPreset] 加载模型失败:', res.error)
			if (input) input.placeholder = '加载模型失败'
			if (select) {
				select.innerHTML = '<option disabled>加载失败</option>'
				setTimeout(() => { select.style.display = 'none' }, 2000)
			}
		}
	} catch (e) {
		console.error('[memoryPreset] 加载模型出错:', e)
		if (dom.apiModel) dom.apiModel.placeholder = '加载出错'
		if (select) select.style.display = 'none'
	} finally {
		if (dom.apiModel) {
			dom.apiModel.classList.remove('loading-input')
			setTimeout(() => {
				if (dom.apiModel && !dom.apiModel.value) dom.apiModel.placeholder = originalPlaceholder || '输入或选择模型'
			}, 2000)
		}
	}
}

async function setPluginData(payload) {
	try {
		// 自动注入当前选中的角色ID和显示名
		if (currentCharId && !payload.charName && !payload.char_id) {
			payload.charName = currentCharId
		}
		if (currentCharDisplayName && !payload.charDisplayName) {
			payload.charDisplayName = currentCharDisplayName
		}
		const resp = await fetch(`/api/parts/plugins:${PLUGIN_NAME}/config/setdata`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
		return await resp.json() // 修改为返回 json 以便获取 getModels 的结果
	} catch (e) {
		console.error('[memoryPreset] setPluginData 失败:', e)
		return { success: false, error: e.message }
	}
}

// ===== DOM 引用 =====

const dom = {}

function cacheDom() {
	dom.loading = document.getElementById('mp-loading')
	dom.main = document.getElementById('mp-main')
	dom.presetList = document.getElementById('mp-preset-list')
	dom.detail = document.getElementById('mp-detail')

	// 详情区域
	dom.detailId = document.getElementById('mp-detail-id')
	dom.detailName = document.getElementById('mp-detail-name')
	dom.detailToggle = document.getElementById('mp-detail-toggle')
	dom.detailDesc = document.getElementById('mp-detail-desc')
	dom.detailTrigger = document.getElementById('mp-detail-trigger')

	// API 配置
	dom.apiCustom = document.getElementById('mp-api-custom')
	dom.apiFields = document.getElementById('mp-api-fields')
	dom.apiSource = document.getElementById('mp-api-source')
	dom.apiModel = document.getElementById('mp-api-model')
	// 动态创建模型选择下拉框（辅助 Input）
	if (dom.apiModel && !document.getElementById('mp-model-select')) {
		const select = document.createElement('select')
		select.id = 'mp-model-select'
		select.className = 'select select-bordered select-xs w-full mt-1'
		select.style.display = 'none'
		select.innerHTML = '<option value="" disabled selected>选择模型...</option>'
		dom.apiModel.parentNode.appendChild(select)
		dom.apiModelSelect = select
	} else {
		dom.apiModelSelect = document.getElementById('mp-model-select')
	}

	dom.apiTemperature = document.getElementById('mp-api-temperature')
	dom.apiMaxTokens = document.getElementById('mp-api-max-tokens')

	// 提示词
	dom.promptList = document.getElementById('mp-prompt-list')
	dom.addPrompt = document.getElementById('mp-add-prompt')

	// 操作
	dom.previewPresetBtn = document.getElementById('mp-preview-preset-btn')
	dom.saveBtn = document.getElementById('mp-save-btn')
	dom.status = document.getElementById('mp-status')

	// 预设预览面板
	dom.presetPreviewPanel = document.getElementById('mp-preset-preview-panel')
	dom.presetPreviewStats = document.getElementById('mp-preset-preview-stats')
	dom.presetPreviewContent = document.getElementById('mp-preset-preview-content')
	dom.presetPreviewCopy = document.getElementById('mp-preset-preview-copy')
	dom.presetPreviewClose = document.getElementById('mp-preset-preview-close')

	// 记忆AI运行面板
	dom.runPresetBtn = document.getElementById('mp-run-preset-btn')
	dom.runResultPanel = document.getElementById('mp-run-result-panel')
	dom.runResultTime = document.getElementById('mp-run-result-time')
	dom.runResultCopy = document.getElementById('mp-run-result-copy')
	dom.runResultClose = document.getElementById('mp-run-result-close')
	dom.runThinking = document.getElementById('mp-run-thinking')
	dom.runThinkingHeader = document.getElementById('mp-run-thinking-header')
	dom.runThinkingArrow = document.getElementById('mp-run-thinking-arrow')
	dom.runThinkingContent = document.getElementById('mp-run-thinking-content')
	dom.runOperations = document.getElementById('mp-run-operations')
	dom.runOperationsList = document.getElementById('mp-run-operations-list')
	dom.runReply = document.getElementById('mp-run-reply')
	dom.runReplyContent = document.getElementById('mp-run-reply-content')
	dom.runError = document.getElementById('mp-run-error')
	dom.runErrorContent = document.getElementById('mp-run-error-content')

	// 记忆维护
	dom.endDayBtn = document.getElementById('mp-end-day-btn')
	dom.archiveTempBtn = document.getElementById('mp-archive-temp-btn')
	dom.archiveHotBtn = document.getElementById('mp-archive-hot-btn')
	dom.archiveColdBtn = document.getElementById('mp-archive-cold-btn')
	dom.maintenanceStatus = document.getElementById('mp-maintenance-status')
	dom.endDayResult = document.getElementById('mp-end-day-result')

	// 注入提示词面板
	dom.injectionList = document.getElementById('mp-injection-list')

	// 记忆检索配置面板
	dom.cfgAutoTrigger = document.getElementById('mp-cfg-auto-trigger')
	dom.cfgChatHistoryCount = document.getElementById('mp-cfg-chat-history-count')
	dom.cfgMaxSearchRounds = document.getElementById('mp-cfg-max-search-rounds')
	dom.cfgTimeout = document.getElementById('mp-cfg-timeout')
	dom.cfgSaveBtn = document.getElementById('mp-cfg-save-btn')
	dom.cfgStatus = document.getElementById('mp-cfg-status')

	// 冷却轮次
	dom.cfgCooldownRounds = document.getElementById('mp-cfg-cooldown-rounds')

	// 可用宏参考面板
	dom.macroRefHeader = document.getElementById('mp-macro-ref-header')
	dom.macroRefArrow = document.getElementById('mp-macro-ref-arrow')
	dom.macroRefBody = document.getElementById('mp-macro-ref-body')

	// 角色选择器
	dom.charSelect = document.getElementById('mp-char-select')
	dom.charStatus = document.getElementById('mp-char-status')

	// 预设导出/导入
	dom.exportPresetsBtn = document.getElementById('mp-export-presets')
	dom.importPresetsBtn = document.getElementById('mp-import-presets')
}

// ===== 状态 =====

let presets = []
let injectionPrompts = []
let currentConfig = null // 记忆系统配置（retrieval/injection/archive）
let selectedPresetId = null
let aiSourceList = [] // 实际可用的 AI 服务源名称列表
let currentUsername = null
let currentCharName = null
let currentCharId = '' // 角色选择器选中的角色卡ID
let currentCharDisplayName = '' // 角色选择器选中的角色卡显示名
let availablePresets = [] // beilu-preset 中已配置的聊天预设列表（供P1预设切换管理使用）

// ===== 触发方式的中文映射 =====

const TRIGGER_LABELS = {
	auto_on_message: '每次消息自动',
	auto_on_threshold: '阈值自动触发',
	manual_button: '手动按钮',
	manual_or_auto: '手动/自动',
}

// ===== 渲染：预设列表 =====

function renderPresetList() {
	if (!dom.presetList) return

	dom.presetList.innerHTML = ''

	for (const preset of presets) {
		const item = document.createElement('div')
		item.className = 'beilu-preset-entry-item' + (preset.id === selectedPresetId ? ' active' : '')
		item.dataset.presetId = preset.id

		const enabledDot = preset.enabled
			? '<span class="inline-block w-2 h-2 rounded-full bg-success mr-2" title="已启用"></span>'
			: '<span class="inline-block w-2 h-2 rounded-full bg-base-content/20 mr-2" title="已禁用"></span>'

		item.innerHTML = `
			<div class="flex items-center gap-2 w-full">
				${enabledDot}
				<span class="badge badge-xs badge-outline badge-warning font-mono">${preset.id}</span>
				<span class="text-sm flex-grow truncate">${preset.name}</span>
				<span class="text-xs text-base-content/30">${TRIGGER_LABELS[preset.trigger] || preset.trigger}</span>
			</div>
		`

		item.addEventListener('click', () => {
			selectedPresetId = preset.id
			renderPresetList()
			renderDetail()
		})

		dom.presetList.appendChild(item)
	}
}

// ===== 渲染：预设详情 =====

function renderDetail() {
	const preset = presets.find(p => p.id === selectedPresetId)
	if (!preset) {
		dom.detail.style.display = 'none'
		return
	}
dom.detail.style.display = ''
dom.detailId.textContent = preset.id
dom.detailName.textContent = preset.name
dom.detailToggle.checked = preset.enabled
dom.detailDesc.value = preset.description || ''
dom.detailTrigger.value = preset.trigger || 'manual_button'

// API 配置
const api = preset.api_config || {}
dom.apiCustom.checked = !!api.use_custom
dom.apiFields.style.display = api.use_custom ? '' : 'none'

// 动态填充服务源下拉框
// 确保先填充选项，再设置选中值
populateSourceSelect(api.source || '')

// 强制设置选中值，即使 populateSourceSelect 内部已经尝试设置
// 这是为了防止 populateSourceSelect 中的逻辑未能正确匹配
if (api.source) {
	// 检查该值是否在选项中，如果不在（可能是自定义输入或未加载），添加一个临时选项
	let optionExists = false
	for (let i = 0; i < dom.apiSource.options.length; i++) {
		if (dom.apiSource.options[i].value === api.source) {
			optionExists = true
			break
		}
	}
	if (!optionExists) {
		const opt = document.createElement('option')
		opt.value = api.source
		opt.textContent = api.source + ' (未安装/未知)'
		dom.apiSource.appendChild(opt)
	}
	dom.apiSource.value = api.source
}

dom.apiModel.value = api.model || ''
dom.apiTemperature.value = api.temperature ?? 0.3
dom.apiMaxTokens.value = api.max_tokens ?? 2000

// 尝试加载模型列表
if (api.use_custom && api.source) {
	loadModelsForSource(api.source)
}

// P1 专属：渲染预设切换管理区域
renderPresetSwitchSection(preset)

// 提示词列表
renderPromptList(preset)

// 清除状态
showStatus('')
	showStatus('')
}

// ===== 渲染：提示词条目列表 =====

/** 记录每个 prompt 的展开状态（按 identifier） */
const expandedPrompts = new Set()

/** 当前拖拽的 prompt identifier */
let draggedPromptId = null

function renderPromptList(preset) {
	if (!dom.promptList) return

	dom.promptList.innerHTML = ''

	if (!preset.prompts || preset.prompts.length === 0) {
		dom.promptList.innerHTML = '<p class="text-xs text-base-content/40 text-center py-4">暂无提示词条目</p>'
		return
	}

	preset.prompts.forEach((prompt, idx) => {
		const identifier = prompt.identifier || `prompt_${idx}`
		const isExpanded = expandedPrompts.has(identifier)
		const isBuiltinMacro = prompt.builtin && ['{{chat_history}}', '{{presetList}}'].includes(prompt.content)

		// 角色emoji
		const roleEmoji = prompt.role === 'system' ? '🔧' : prompt.role === 'user' ? '👤' : '🤖'

		// 角色标签CSS类
		const roleClass = prompt.role === 'system' ? 'system' : prompt.role === 'user' ? 'user' : 'assistant'

		// 条目容器 — 复用 .beilu-preset-entry 样式族
		const item = document.createElement('div')
		item.className = `beilu-preset-entry mp-prompt-entry ${prompt.enabled ? '' : 'disabled'} ${isExpanded ? 'expanded' : ''}`
		item.dataset.identifier = identifier
		item.dataset.idx = idx
		item.draggable = true

		// 标题行
		const headerHTML = `
			<span class="beilu-preset-entry-drag" title="拖拽排序">⠿</span>
			<input type="checkbox" class="checkbox checkbox-xs checkbox-warning mp-prompt-toggle"
				data-idx="${idx}" ${prompt.enabled ? 'checked' : ''} ${isBuiltinMacro ? 'disabled' : ''} />
			<span class="beilu-preset-entry-role">${roleEmoji}</span>
			<span class="beilu-preset-entry-name mp-prompt-title">${isBuiltinMacro ? prompt.content : (prompt.identifier || `条目 #${idx}`)}</span>
			<span class="beilu-preset-entry-type ${roleClass}">${prompt.role}</span>
			${prompt.builtin ? '<span class="badge badge-xs badge-ghost">内置</span>' : ''}
			<span class="mp-prompt-expand-arrow ${isExpanded ? 'expanded' : ''}">${isExpanded ? '▼' : '▶'}</span>
		`
		item.innerHTML = headerHTML

		// 展开内容区
		const contentDiv = document.createElement('div')
		contentDiv.className = 'mp-prompt-content-area'
		contentDiv.style.display = isExpanded ? '' : 'none'

		if (isBuiltinMacro) {
			const builtinDescs = {
				'{{chat_history}}': '聊天记录注入占位符 — 此位置将插入实际对话记录，不可编辑',
				'{{presetList}}': '预设列表宏占位符 — 运行时将替换为可用预设的描述列表，不可编辑',
			}
			contentDiv.innerHTML = `<div class="text-xs text-base-content/40 italic py-2 px-1">${builtinDescs[prompt.content] || '内置宏占位符，不可编辑'}</div>`
		} else {
			contentDiv.innerHTML = `
				<textarea class="textarea textarea-bordered w-full text-xs font-mono mp-prompt-content" data-idx="${idx}" rows="4"
					placeholder="输入提示词内容...">${prompt.content || ''}</textarea>
				<div class="flex items-center justify-between mt-1">
					<div class="flex items-center gap-2">
						<select class="select select-xs select-bordered mp-prompt-role" data-idx="${idx}">
							<option value="system" ${prompt.role === 'system' ? 'selected' : ''}>system</option>
							<option value="user" ${prompt.role === 'user' ? 'selected' : ''}>user</option>
							<option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>assistant</option>
						</select>
					</div>
					${prompt.deletable ? `<button class="btn btn-xs btn-ghost btn-error mp-prompt-delete" data-idx="${idx}" title="删除条目">🗑️ 删除</button>` : ''}
				</div>
			`
		}

		item.appendChild(contentDiv)
		dom.promptList.appendChild(item)
	})

	// ===== 事件绑定 =====

	// 点击展开/收起（排除 checkbox、drag handle、button、textarea、select）
	dom.promptList.querySelectorAll('.mp-prompt-entry').forEach(el => {
		el.addEventListener('click', (e) => {
			const tag = e.target.tagName.toLowerCase()
			if (tag === 'input' || tag === 'button' || tag === 'textarea' || tag === 'select') return
			if (e.target.classList.contains('beilu-preset-entry-drag')) return

			const identifier = el.dataset.identifier
			const contentArea = el.querySelector('.mp-prompt-content-area')
			const arrow = el.querySelector('.mp-prompt-expand-arrow')
			if (!contentArea) return

			if (expandedPrompts.has(identifier)) {
				expandedPrompts.delete(identifier)
				contentArea.style.display = 'none'
				el.classList.remove('expanded')
				if (arrow) { arrow.textContent = '▶'; arrow.classList.remove('expanded') }
			} else {
				expandedPrompts.add(identifier)
				contentArea.style.display = ''
				el.classList.add('expanded')
				if (arrow) { arrow.textContent = '▼'; arrow.classList.add('expanded') }
			}
		})
	})

	// 开关
	dom.promptList.querySelectorAll('.mp-prompt-toggle').forEach(el => {
		el.addEventListener('change', (e) => {
			e.stopPropagation()
			const idx = parseInt(e.target.dataset.idx, 10)
			if (preset.prompts[idx]) {
				preset.prompts[idx].enabled = e.target.checked
				// 更新条目样式
				const entry = e.target.closest('.mp-prompt-entry')
				if (entry) entry.classList.toggle('disabled', !e.target.checked)
			}
		})
	})

	// 内容编辑
	dom.promptList.querySelectorAll('.mp-prompt-content').forEach(el => {
		el.addEventListener('input', (e) => {
			const idx = parseInt(e.target.dataset.idx, 10)
			if (preset.prompts[idx]) {
				preset.prompts[idx].content = e.target.value
			}
		})
	})

	// 角色选择
	dom.promptList.querySelectorAll('.mp-prompt-role').forEach(el => {
		el.addEventListener('change', (e) => {
			const idx = parseInt(e.target.dataset.idx, 10)
			if (preset.prompts[idx]) {
				preset.prompts[idx].role = e.target.value
			}
		})
	})

	// 删除
	dom.promptList.querySelectorAll('.mp-prompt-delete').forEach(el => {
		el.addEventListener('click', async (e) => {
			e.stopPropagation()
			const idx = parseInt(e.target.dataset.idx, 10)
			if (!confirm(`确定删除提示词条目 #${idx}？`)) return

			const ok = await setPluginData({
				_action: 'removePresetPrompt',
				presetId: preset.id,
				promptIndex: idx,
			})
			if (ok) {
				await refreshPresets()
				showStatus('✅ 已删除', 2000)
			} else {
				showStatus('❌ 删除失败', 3000)
			}
		})
	})

	// ===== 拖拽排序 =====
	dom.promptList.querySelectorAll('.mp-prompt-entry').forEach(el => {
		el.addEventListener('dragstart', (e) => {
			draggedPromptId = el.dataset.identifier
			el.classList.add('dragging')
			e.dataTransfer.effectAllowed = 'move'
			e.dataTransfer.setData('text/plain', el.dataset.identifier)
		})

		el.addEventListener('dragend', () => {
			draggedPromptId = null
			el.classList.remove('dragging')
			dom.promptList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(d => {
				d.classList.remove('drag-over-top', 'drag-over-bottom')
			})
		})

		el.addEventListener('dragover', (e) => {
			e.preventDefault()
			e.dataTransfer.dropEffect = 'move'
			if (!draggedPromptId || draggedPromptId === el.dataset.identifier) return

			const rect = el.getBoundingClientRect()
			const midY = rect.top + rect.height / 2
			el.classList.remove('drag-over-top', 'drag-over-bottom')
			if (e.clientY < midY) {
				el.classList.add('drag-over-top')
			} else {
				el.classList.add('drag-over-bottom')
			}
		})

		el.addEventListener('dragleave', () => {
			el.classList.remove('drag-over-top', 'drag-over-bottom')
		})

		el.addEventListener('drop', async (e) => {
			e.preventDefault()
			el.classList.remove('drag-over-top', 'drag-over-bottom')

			if (!draggedPromptId || draggedPromptId === el.dataset.identifier) return

			const rect = el.getBoundingClientRect()
			const midY = rect.top + rect.height / 2
			const insertBefore = e.clientY < midY

			// 重排 preset.prompts
			const dragIdx = preset.prompts.findIndex(p => (p.identifier || `prompt_${preset.prompts.indexOf(p)}`) === draggedPromptId)
			if (dragIdx === -1) return

			const [draggedItem] = preset.prompts.splice(dragIdx, 1)
			const targetIdentifier = el.dataset.identifier
			let targetIdx = preset.prompts.findIndex(p => (p.identifier || `prompt_${preset.prompts.indexOf(p)}`) === targetIdentifier)
			if (!insertBefore) targetIdx++
			preset.prompts.splice(targetIdx, 0, draggedItem)

			// 重新渲染
			renderPromptList(preset)

			// 保存新顺序到后端
			const newOrder = preset.prompts.map(p => p.identifier).filter(Boolean)
			try {
				await setPluginData({
					_action: 'reorderPresetPrompts',
					presetId: preset.id,
					order: newOrder,
				})
			} catch (err) {
				showStatus('排序保存失败', 3000)
				await refreshPresets()
			}
		})
	})
}

// ===== 渲染：注入提示词列表 =====

/** autoMode 的中文标签 */
const AUTO_MODE_LABELS = {
	always: '始终跟随启用状态',
	file: '文件/记忆模式自动启用',
	manual: '仅手动控制',
}

/** 记录每个注入条目内容区的展开状态 */
const expandedInjections = new Set()

function renderInjectionList() {
	if (!dom.injectionList) return

	dom.injectionList.innerHTML = ''

	if (!injectionPrompts || injectionPrompts.length === 0) {
		dom.injectionList.innerHTML = '<p class="text-xs text-base-content/40 text-center py-2">暂无注入提示词</p>'
		return
	}

	for (const inj of injectionPrompts) {
		const isExpanded = expandedInjections.has(inj.id)

		const card = document.createElement('div')
		card.className = 'beilu-config-section mp-injection-card'
		card.dataset.injId = inj.id

		// 标题行
		const headerDiv = document.createElement('div')
		headerDiv.className = 'flex items-center justify-between cursor-pointer mp-injection-header'
		headerDiv.innerHTML = `
			<div class="flex items-center gap-2">
				<span class="mp-injection-expand-arrow text-xs text-base-content/30">${isExpanded ? '▼' : '▶'}</span>
				<span class="badge badge-xs badge-outline badge-warning font-mono">${inj.id}</span>
				<span class="text-sm font-medium">${inj.name}</span>
				<span class="text-xs text-base-content/40">${inj.description || ''}</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="badge badge-xs badge-ghost">${AUTO_MODE_LABELS[inj.autoMode] || inj.autoMode}</span>
				<label class="cursor-pointer label gap-1 p-0" title="启用/禁用">
					<input type="checkbox" class="toggle toggle-xs toggle-warning mp-injection-toggle" data-inj-id="${inj.id}" ${inj.enabled ? 'checked' : ''} />
				</label>
			</div>
		`

		// 展开内容区
		const contentDiv = document.createElement('div')
		contentDiv.className = 'mp-injection-content-area mt-2'
		contentDiv.style.display = isExpanded ? '' : 'none'
		contentDiv.innerHTML = `
			<div class="flex items-center gap-3 mb-2 text-xs flex-wrap">
				<div class="flex items-center gap-1">
					<span class="text-base-content/50">角色:</span>
					<select class="select select-xs select-bordered mp-injection-role" data-inj-id="${inj.id}">
						<option value="system" ${inj.role === 'system' ? 'selected' : ''}>system</option>
						<option value="user" ${inj.role === 'user' ? 'selected' : ''}>user</option>
						<option value="assistant" ${inj.role === 'assistant' ? 'selected' : ''}>assistant</option>
					</select>
				</div>
				<div class="flex items-center gap-1">
					<span class="text-base-content/50">@D深度:</span>
					<input type="number" class="input input-xs input-bordered w-16 mp-injection-depth" data-inj-id="${inj.id}" min="0" value="${inj.depth ?? 0}" title="0=消息序列底部, 999=顶部" />
				</div>
				<div class="flex items-center gap-1">
					<span class="text-base-content/50">排序:</span>
					<input type="number" class="input input-xs input-bordered w-16 mp-injection-order" data-inj-id="${inj.id}" min="0" value="${inj.order ?? 0}" title="同深度下的排列顺序（数值越小越靠前）" />
				</div>
				<div class="flex items-center gap-1">
					<span class="text-base-content/50">自动模式:</span>
					<select class="select select-xs select-bordered mp-injection-automode" data-inj-id="${inj.id}">
						<option value="always" ${inj.autoMode === 'always' ? 'selected' : ''}>always</option>
						<option value="file" ${inj.autoMode === 'file' ? 'selected' : ''}>file</option>
						<option value="manual" ${inj.autoMode === 'manual' ? 'selected' : ''}>manual</option>
					</select>
				</div>
			</div>
			<textarea class="textarea textarea-bordered w-full text-xs font-mono mp-injection-content" data-inj-id="${inj.id}" rows="6"
					placeholder="注入提示词内容...">${inj.content || ''}</textarea>
				<div class="flex justify-end gap-2 mt-1">
					<button class="btn btn-xs btn-outline mp-injection-preview" data-inj-id="${inj.id}">👁️ 预览</button>
					<button class="btn btn-xs bg-amber-700 hover:bg-amber-800 text-white border-amber-700 mp-injection-save" data-inj-id="${inj.id}">💾 保存此条</button>
				</div>
				<div class="mp-injection-preview-area" data-inj-id="${inj.id}" style="display:none;">
					<div class="flex items-center justify-between mt-2 mb-1">
						<span class="text-xs font-medium text-amber-600">📝 宏替换后预览</span>
						<div class="flex items-center gap-2">
							<span class="text-xs text-base-content/40 mp-preview-stats" data-inj-id="${inj.id}"></span>
							<button class="btn btn-xs btn-ghost mp-preview-copy" data-inj-id="${inj.id}" title="复制预览内容">📋</button>
							<button class="btn btn-xs btn-ghost mp-preview-close" data-inj-id="${inj.id}" title="关闭预览">✕</button>
						</div>
					</div>
					<pre class="mp-preview-content text-xs font-mono whitespace-pre-wrap p-3 rounded-md max-h-96 overflow-y-auto" data-inj-id="${inj.id}" style="background: oklch(var(--bc) / 0.05); border: 1px solid oklch(var(--bc) / 0.1);"></pre>
					<div class="mp-preview-hot-section" data-inj-id="${inj.id}" style="display:none;">
						<div class="flex items-center justify-between mt-2 mb-1">
							<span class="text-xs font-medium text-amber-600">🔥 热记忆层数据</span>
							<span class="text-xs text-base-content/40 mp-preview-hot-stats" data-inj-id="${inj.id}"></span>
						</div>
						<pre class="mp-preview-hot-content text-xs font-mono whitespace-pre-wrap p-3 rounded-md max-h-48 overflow-y-auto" data-inj-id="${inj.id}" style="background: oklch(var(--bc) / 0.05); border: 1px solid oklch(var(--bc) / 0.1);"></pre>
					</div>
				</div>
		`

		card.appendChild(headerDiv)
		card.appendChild(contentDiv)
		dom.injectionList.appendChild(card)
	}

	// ===== 事件绑定 =====

	// 展开/收起
	dom.injectionList.querySelectorAll('.mp-injection-header').forEach(header => {
		header.addEventListener('click', (e) => {
			// 跳过 toggle checkbox 的点击
			if (e.target.tagName.toLowerCase() === 'input') return
			const card = header.closest('.mp-injection-card')
			const injId = card.dataset.injId
			const contentArea = card.querySelector('.mp-injection-content-area')
			const arrow = header.querySelector('.mp-injection-expand-arrow')
			if (!contentArea) return

			if (expandedInjections.has(injId)) {
				expandedInjections.delete(injId)
				contentArea.style.display = 'none'
				if (arrow) arrow.textContent = '▶'
			} else {
				expandedInjections.add(injId)
				contentArea.style.display = ''
				if (arrow) arrow.textContent = '▼'
			}
		})
	})

	// 启用开关
	dom.injectionList.querySelectorAll('.mp-injection-toggle').forEach(toggle => {
		toggle.addEventListener('change', async (e) => {
			e.stopPropagation()
			const injId = e.target.dataset.injId
			const inj = injectionPrompts.find(i => i.id === injId)
			if (inj) inj.enabled = e.target.checked

			// 即时保存启用状态
				await setPluginData({
					_action: 'updateInjectionPrompt',
					injectionId: injId,
					enabled: e.target.checked,
				})
		})
	})

	// 预览注入条目
	dom.injectionList.querySelectorAll('.mp-injection-preview').forEach(btn => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation()
			const injId = e.target.dataset.injId
			const previewArea = dom.injectionList.querySelector(`.mp-injection-preview-area[data-inj-id="${injId}"]`)
			if (!previewArea) return

			// 如果已经打开，关闭
			if (previewArea.style.display !== 'none') {
				previewArea.style.display = 'none'
				return
			}

			// 设置加载状态
			const contentEl = previewArea.querySelector(`.mp-preview-content[data-inj-id="${injId}"]`)
			const statsEl = previewArea.querySelector(`.mp-preview-stats[data-inj-id="${injId}"]`)
			if (contentEl) contentEl.textContent = '加载中...'
			if (statsEl) statsEl.textContent = ''
			previewArea.style.display = ''

			try {
					// 使用 setPluginData 发送请求（自动注入 charName / charDisplayName）
					const result = await setPluginData({
						_action: 'previewInjectionPrompt',
						injectionId: injId,
					})

				if (result.error) {
					if (contentEl) contentEl.textContent = `❌ ${result.error}`
					return
				}

				// 渲染预览内容
				if (contentEl) contentEl.textContent = result.preview || '（空内容）'
				if (statsEl) statsEl.textContent = `${(result.charCount || 0).toLocaleString()} 字符 · ≈${(result.estimatedTokens || 0).toLocaleString()} tokens`

				// 热记忆部分
				const hotSection = previewArea.querySelector(`.mp-preview-hot-section[data-inj-id="${injId}"]`)
				const hotContent = previewArea.querySelector(`.mp-preview-hot-content[data-inj-id="${injId}"]`)
				const hotStats = previewArea.querySelector(`.mp-preview-hot-stats[data-inj-id="${injId}"]`)

				if (result.hotMemoryPreview && result.hotMemoryCharCount > 0) {
					if (hotSection) hotSection.style.display = ''
					if (hotContent) hotContent.textContent = result.hotMemoryPreview
					if (hotStats) hotStats.textContent = `${result.hotMemoryCharCount.toLocaleString()} 字符`
				} else {
					if (hotSection) hotSection.style.display = 'none'
				}
			} catch (err) {
				console.error('[memoryPreset] 预览失败:', err)
				if (contentEl) contentEl.textContent = `❌ 预览失败: ${err.message}`
			}
		})
	})

	// 关闭预览
	dom.injectionList.querySelectorAll('.mp-preview-close').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const injId = e.target.dataset.injId
			const previewArea = dom.injectionList.querySelector(`.mp-injection-preview-area[data-inj-id="${injId}"]`)
			if (previewArea) previewArea.style.display = 'none'
		})
	})

	// 复制预览内容
	dom.injectionList.querySelectorAll('.mp-preview-copy').forEach(btn => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation()
			const injId = e.target.dataset.injId
			const contentEl = dom.injectionList.querySelector(`.mp-preview-content[data-inj-id="${injId}"]`)
			if (!contentEl) return
			try {
				await navigator.clipboard.writeText(contentEl.textContent)
				const orig = e.target.textContent
				e.target.textContent = '✅'
				setTimeout(() => { e.target.textContent = orig }, 1500)
			} catch (err) {
				console.error('[memoryPreset] 复制失败:', err)
			}
		})
	})

	// 保存单个注入条目
	dom.injectionList.querySelectorAll('.mp-injection-save').forEach(btn => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation()
			const injId = e.target.dataset.injId
			const card = e.target.closest('.mp-injection-card')
			if (!card) return

			const roleEl = card.querySelector('.mp-injection-role')
			const depthEl = card.querySelector('.mp-injection-depth')
			const orderEl = card.querySelector('.mp-injection-order')
			const autoModeEl = card.querySelector('.mp-injection-automode')
			const contentEl = card.querySelector('.mp-injection-content')

			const ok = await setPluginData({
					_action: 'updateInjectionPrompt',
					injectionId: injId,
					role: roleEl?.value || 'system',
					depth: parseInt(depthEl?.value, 10) || 0,
					order: parseInt(orderEl?.value, 10) || 0,
					autoMode: autoModeEl?.value || 'always',
					content: contentEl?.value || '',
					enabled: card.querySelector('.mp-injection-toggle')?.checked ?? true,
				})

			if (ok) {
				showStatus('✅ 注入条目已保存', 2000)
				// 更新本地状态
				const inj = injectionPrompts.find(i => i.id === injId)
				if (inj) {
					inj.role = roleEl?.value || 'system'
					inj.depth = parseInt(depthEl?.value, 10) || 0
					inj.order = parseInt(orderEl?.value, 10) || 0
					inj.autoMode = autoModeEl?.value || 'always'
					inj.content = contentEl?.value || ''
				}
			} else {
				showStatus('❌ 保存失败', 3000)
			}
		})
	})
}

// ===== 状态提示 =====

function showStatus(msg, autoClearMs = 0) {
	if (dom.status) {
		dom.status.textContent = msg
		if (autoClearMs > 0) {
			setTimeout(() => { dom.status.textContent = '' }, autoClearMs)
		}
	}
}

// ===== 服务源下拉框 =====

/** 用实际 AI 服务源列表填充 #mp-api-source 下拉框 */
function populateSourceSelect(currentValue) {
	if (!dom.apiSource) return

	dom.apiSource.innerHTML = ''

	// 移除旧的引导提示（如果有）
	const oldHint = dom.apiSource.parentNode?.querySelector('.mp-no-source-hint')
	if (oldHint) oldHint.remove()

	if (aiSourceList.length === 0) {
		// 没有服务源时给个提示
		const opt = document.createElement('option')
		opt.value = ''
		opt.textContent = '（无可用服务源）'
		dom.apiSource.appendChild(opt)

		// 添加引导提示
		const hint = document.createElement('div')
		hint.className = 'mp-no-source-hint'
		hint.style.cssText = 'font-size:0.7rem;color:#d97706;margin-top:4px;padding:4px 6px;background:rgba(217,119,6,0.08);border-radius:4px;border:1px dashed rgba(217,119,6,0.3);'
		hint.innerHTML = '⚠️ 请先在 <a href="/parts/shells:beilu-home/#system" style="color:#d97706;text-decoration:underline;font-weight:500;">系统设置 → AI 服务源</a> 中添加服务源，记忆AI才能正常工作'
		dom.apiSource.parentNode?.appendChild(hint)
		return
	}

	for (const name of aiSourceList) {
		const opt = document.createElement('option')
		opt.value = name
		opt.textContent = name
		dom.apiSource.appendChild(opt)
	}

	// 选中当前值（如果存在于列表中）
	if (currentValue && aiSourceList.includes(currentValue)) {
		dom.apiSource.value = currentValue
	} else if (aiSourceList.length > 0) {
		dom.apiSource.value = aiSourceList[0]
	}
}

// ===== 角色卡选择器 =====

async function loadCharList() {
	if (!dom.charSelect) return
	try {
		const result = await getAllCachedPartDetails('chars')
		const cachedDetails = result?.cachedDetails || {}
		const uncachedNames = result?.uncachedNames || []
		const charKeys = [...Object.keys(cachedDetails), ...uncachedNames]

		dom.charSelect.innerHTML = '<option value="">选择角色卡查看宏数据...</option>'
		for (const key of charKeys) {
			const opt = document.createElement('option')
			opt.value = key
			const details = cachedDetails[key]
			const displayName = details?.info?.display_name || details?.DisplayName || key
			opt.textContent = displayName
			dom.charSelect.appendChild(opt)
		}

		if (dom.charStatus) dom.charStatus.textContent = `${charKeys.length} 个角色卡`
	} catch (err) {
		console.error('[memoryPreset] 获取角色卡列表失败:', err)
		if (dom.charStatus) dom.charStatus.textContent = '获取角色卡失败'
	}
}

// ===== 数据刷新 =====

async function refreshPresets() {
	const data = await getPluginData()
	
	if (data) {
		if (data.username) currentUsername = data.username
		if (data.charName) currentCharName = data.charName
		
		if (data.memory_presets) {
			presets = data.memory_presets
		} else {
			presets = []
		}

		// 加载注入提示词
		if (data.injection_prompts) {
			injectionPrompts = data.injection_prompts
		} else {
			injectionPrompts = []
		}

		// 加载配置
		if (data.config) {
			currentConfig = data.config
		}

		// 加载可用预设列表（用于P1预设切换管理）
		if (data.available_presets) {
			availablePresets = data.available_presets
		}
	}

	renderInjectionList()
	renderRetrievalConfig()
	renderPresetList()

	// 如果当前选中的预设还在列表中，重新渲染详情
	if (selectedPresetId && presets.find(p => p.id === selectedPresetId)) {
		renderDetail()
	} else if (presets.length > 0) {
		// 默认选中第一个
		selectedPresetId = presets[0].id
		renderPresetList()
		renderDetail()
	}
}

// ===== 事件绑定 =====

function bindEvents() {
	// 角色卡选择
	dom.charSelect?.addEventListener('change', async () => {
		currentCharId = dom.charSelect.value
		currentCharDisplayName = dom.charSelect.selectedOptions[0]?.textContent || ''
		if (dom.charStatus) dom.charStatus.textContent = currentCharId ? `已选: ${currentCharDisplayName || currentCharId}` : ''
		await refreshPresets()
	})

	// API 自定义开关
	dom.apiCustom?.addEventListener('change', () => {
		dom.apiFields.style.display = dom.apiCustom.checked ? '' : 'none'
		const useCustom = dom.apiCustom.checked
		if (!useCustom) {
			dom.apiSource.value = ''
			// 清空模型列表
			const datalist = document.getElementById('model-list')
			if (datalist) datalist.innerHTML = ''
		} else {
			// 如果选中了源，尝试加载模型
			if (dom.apiSource.value) {
				loadModelsForSource(dom.apiSource.value)
			}
		}
	})

	// 源选择变化时加载模型
	dom.apiSource?.addEventListener('change', () => {
		if (dom.apiCustom.checked && dom.apiSource.value) {
			loadModelsForSource(dom.apiSource.value)
		}
	})

	// 添加 datalist 用于模型自动补全
	// 确保 datalist 存在且已连接到 input
	let datalist = document.getElementById('model-list')
	if (!datalist) {
		datalist = document.createElement('datalist')
		datalist.id = 'model-list'
		document.body.appendChild(datalist)
	}
	if (dom.apiModel) {
		dom.apiModel.setAttribute('list', 'model-list')
	}

	// 绑定 Select 辅助选择事件
	if (dom.apiModelSelect) {
		dom.apiModelSelect.addEventListener('change', () => {
			if (dom.apiModelSelect.value && dom.apiModel) {
				dom.apiModel.value = dom.apiModelSelect.value
				// 触发 input 事件以便保存逻辑感知（如果有）
				dom.apiModel.dispatchEvent(new Event('input'))
				// 选完后重置 select 选中状态，方便下次再选
				dom.apiModelSelect.value = ''
			}
		})
	}

	// 添加提示词
	dom.addPrompt?.addEventListener('click', async () => {
		if (!selectedPresetId) return

		const ok = await setPluginData({
			_action: 'addPresetPrompt',
			presetId: selectedPresetId,
			role: 'system',
			content: '',
		})
		if (ok) {
			await refreshPresets()
			showStatus('✅ 已添加新条目', 2000)
		} else {
			showStatus('❌ 添加失败', 3000)
		}
	})

	// 保存按钮
	dom.saveBtn?.addEventListener('click', async () => {
		if (!selectedPresetId) return

		const preset = presets.find(p => p.id === selectedPresetId)
		if (!preset) return

		showStatus('保存中...')

		// 1. 保存预设元数据
		const metaPayload = {
			_action: 'updateMemoryPreset',
			presetId: selectedPresetId,
			enabled: dom.detailToggle.checked,
			description: dom.detailDesc.value,
			trigger: dom.detailTrigger.value,
			api_config: {
				use_custom: dom.apiCustom.checked,
				source: dom.apiSource.value,
				model: dom.apiModel.value,
				temperature: parseFloat(dom.apiTemperature.value) || 0.3,
				max_tokens: parseInt(dom.apiMaxTokens.value, 10) || 2000,
			},
		}

		// P1 专属：追加预设切换配置
		if (selectedPresetId === 'P1') {
			const autoToggle = document.getElementById('mp-ps-auto-toggle')
			if (autoToggle) metaPayload.preset_switch_auto = autoToggle.checked

			// 收集预设切换条目
			const entryRows = document.querySelectorAll('.mp-ps-entry-row')
			const entries = []
			entryRows.forEach(row => {
				const name = row.dataset.presetName
				const descInput = row.querySelector('.mp-ps-entry-desc')
				if (name) {
					entries.push({ preset_name: name, description: descInput?.value || '' })
				}
			})
			metaPayload.preset_switch_entries = entries
		}

		const metaOk = await setPluginData(metaPayload)

		// 2. 保存每个 prompt 的内容
		let allOk = metaOk && metaOk.success !== false
		for (let i = 0; i < preset.prompts.length; i++) {
			const p = preset.prompts[i]
			// 跳过内置宏条目（{{chat_history}}、{{presetList}} 等）
			if (p.builtin && ['{{chat_history}}', '{{presetList}}'].includes(p.content)) continue

			const pOk = await setPluginData({
					_action: 'updatePresetPrompt',
					presetId: selectedPresetId,
					promptIndex: i,
					content: p.content,
					enabled: p.enabled,
					role: p.role,
				})
			if (!pOk || pOk.success === false) allOk = false
		}

		if (allOk) {
			await refreshPresets()
			showStatus('✅ 保存成功', 2000)
		} else {
			showStatus('⚠️ 部分保存失败', 3000)
		}
	})

	// ===== 记忆维护按钮 =====

	// 🌙 结束今天
	dom.endDayBtn?.addEventListener('click', async () => {
		if (!confirm('确定要执行日终归档吗？\n\n这将：\n• 将今日事件总结写入温层\n• 归档临时记忆和热记忆\n• 清空当天表格\n\n此操作不可撤销。')) return

		dom.endDayBtn.disabled = true
		dom.endDayBtn.textContent = '⏳ 归档中...'
		showMaintenanceStatus('正在执行日终归档...')

		try {
			const resp = await fetch(`/api/parts/plugins:${PLUGIN_NAME}/config/setdata`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ _action: 'endDay' }),
			})
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
			const result = await resp.json()

			// 显示结果
			if (dom.endDayResult) {
				dom.endDayResult.style.display = ''
				const steps = result.steps || []
				const doneCount = steps.filter(s => s.status === 'done').length
				const todoCount = steps.filter(s => s.status === 'TODO_AI').length
				const skipCount = steps.filter(s => s.status === 'skipped').length
				dom.endDayResult.innerHTML = `
					<div class="p-2 rounded-md bg-success/10 text-success">
						✅ 日终归档完成（${result.date || ''}）<br/>
						<span class="text-base-content/60">完成: ${doneCount} 步 · TODO: ${todoCount} 步 · 跳过: ${skipCount} 步</span>
					</div>
				`
			}
			showMaintenanceStatus('✅ 日终归档完成', 5000)
		} catch (e) {
			console.error('[memoryPreset] 日终归档失败:', e)
			showMaintenanceStatus('❌ 日终归档失败: ' + e.message, 5000)
			if (dom.endDayResult) {
				dom.endDayResult.style.display = ''
				dom.endDayResult.innerHTML = `<div class="p-2 rounded-md bg-error/10 text-error">❌ 归档失败: ${e.message}</div>`
			}
		} finally {
			dom.endDayBtn.disabled = false
			dom.endDayBtn.textContent = '🌙 结束今天'
		}
	})

	// 📦 归档临时记忆
	dom.archiveTempBtn?.addEventListener('click', async () => {
		dom.archiveTempBtn.disabled = true
		showMaintenanceStatus('正在归档临时记忆...')
		try {
			const result = await triggerMaintenanceAction('archiveTempMemory')
			showMaintenanceStatus(`✅ 归档了 ${result.archived || 0} 条临时记忆`, 4000)
		} catch (e) {
			showMaintenanceStatus('❌ ' + e.message, 4000)
		} finally {
			dom.archiveTempBtn.disabled = false
		}
	})

	// 🔥 归档热记忆
	dom.archiveHotBtn?.addEventListener('click', async () => {
		dom.archiveHotBtn.disabled = true
		showMaintenanceStatus('正在归档热记忆...')
		try {
			const result = await triggerMaintenanceAction('archiveHotToWarm')
			showMaintenanceStatus(`✅ #7归档: ${result.remember_archived || 0} · #8归档: ${result.forever_archived || 0}`, 4000)
		} catch (e) {
			showMaintenanceStatus('❌ ' + e.message, 4000)
		} finally {
			dom.archiveHotBtn.disabled = false
		}
	})

	// ❄️ 温→冷归档
	dom.archiveColdBtn?.addEventListener('click', async () => {
		dom.archiveColdBtn.disabled = true
		showMaintenanceStatus('正在执行温→冷归档...')
		try {
			const result = await triggerMaintenanceAction('archiveWarmToCold')
			showMaintenanceStatus(`✅ 移动了 ${result.moved || 0} 个文件到冷层`, 4000)
		} catch (e) {
			showMaintenanceStatus('❌ ' + e.message, 4000)
		} finally {
			dom.archiveColdBtn.disabled = false
		}
	})

	// 👁️ 查看提示词 (Dry Run)
	dom.previewPresetBtn?.addEventListener('click', async () => {
		if (!selectedPresetId) return

		const panel = dom.presetPreviewPanel
		if (!panel) return

		// 切换面板显示
		if (panel.style.display !== 'none') {
			panel.style.display = 'none'
			return
		}

		// 加载中
		if (dom.presetPreviewContent) dom.presetPreviewContent.innerHTML = '<p class="text-xs text-base-content/40 text-center py-4">正在构建发送给AI的提示词...</p>'
		if (dom.presetPreviewStats) dom.presetPreviewStats.textContent = ''
		panel.style.display = ''

		try {
			// 使用 setPluginData 发送 dryRun 请求（自动注入 charName / charDisplayName）
			const result = await setPluginData({
				_action: 'runMemoryPreset',
				presetId: selectedPresetId,
				dryRun: true,
				chatHistory: 'User: (模拟的最近对话记录)\nChar: (模拟的最近回复)', // 提供一个模拟上下文以便查看效果
			})

			if (result.error) {
				if (dom.presetPreviewContent) dom.presetPreviewContent.innerHTML = `<p class="text-xs text-error py-4">❌ ${escapeHtml(result.error)}</p>`
				return
			}

			renderDryRunPreview(result)
		} catch (err) {
			console.error('[memoryPreset] 预设预览失败:', err)
			if (dom.presetPreviewContent) dom.presetPreviewContent.innerHTML = `<p class="text-xs text-error py-4">❌ 预览失败: ${escapeHtml(err.message)}</p>`
		}
	})

	// 关闭预设预览
	dom.presetPreviewClose?.addEventListener('click', () => {
		if (dom.presetPreviewPanel) dom.presetPreviewPanel.style.display = 'none'
	})

	// 复制预设预览
	dom.presetPreviewCopy?.addEventListener('click', async () => {
		if (!dom.presetPreviewContent) return
		// 拼接所有预览条目的文本
		const allText = Array.from(dom.presetPreviewContent.querySelectorAll('.mp-preset-preview-text'))
			.map(el => `[${el.dataset.role}] ${el.textContent}`)
			.join('\n\n---\n\n')
		try {
			await navigator.clipboard.writeText(allText)
			const btn = dom.presetPreviewCopy
			if (btn) {
				const orig = btn.textContent
				btn.textContent = '✅'
				setTimeout(() => { btn.textContent = orig }, 1500)
			}
		} catch (err) {
			console.error('[memoryPreset] 复制失败:', err)
		}
	})

	// ===== 运行记忆AI =====

	dom.runPresetBtn?.addEventListener('click', async () => {
		if (!selectedPresetId) return

		dom.runPresetBtn.disabled = true
		dom.runPresetBtn.textContent = '⏳ 运行中...'

		// 显示面板、清空旧内容
		if (dom.runResultPanel) dom.runResultPanel.style.display = ''
		if (dom.runThinking) dom.runThinking.style.display = 'none'
		if (dom.runOperations) dom.runOperations.style.display = 'none'
		if (dom.runError) dom.runError.style.display = 'none'
		if (dom.runReplyContent) dom.runReplyContent.textContent = '正在调用记忆AI...'
		if (dom.runResultTime) dom.runResultTime.textContent = ''

		try {
			// 使用 setPluginData 发送请求（自动注入 charName / charDisplayName）
			const result = await setPluginData({
				_action: 'runMemoryPreset',
				presetId: selectedPresetId,
			})

			if (result.error) {
				renderRunError(result.error)
				return
			}

			renderRunResult(result)
		} catch (err) {
			console.error('[memoryPreset] 运行记忆AI失败:', err)
			renderRunError(err.message)
		} finally {
			dom.runPresetBtn.disabled = false
			dom.runPresetBtn.textContent = '🚀 运行记忆AI'
		}
	})

	// 关闭运行结果面板
	dom.runResultClose?.addEventListener('click', () => {
		if (dom.runResultPanel) dom.runResultPanel.style.display = 'none'
	})

	// 复制运行结果
	dom.runResultCopy?.addEventListener('click', async () => {
		const parts = []
		if (dom.runThinkingContent?.textContent) parts.push(`[思维链]\n${dom.runThinkingContent.textContent}`)
		if (dom.runReplyContent?.textContent) parts.push(`[AI回复]\n${dom.runReplyContent.textContent}`)
		if (dom.runOperationsList?.textContent) parts.push(`[操作]\n${dom.runOperationsList.textContent}`)
		try {
			await navigator.clipboard.writeText(parts.join('\n\n---\n\n'))
			const btn = dom.runResultCopy
			if (btn) { const orig = btn.textContent; btn.textContent = '✅'; setTimeout(() => { btn.textContent = orig }, 1500) }
		} catch (err) {
			console.error('[memoryPreset] 复制失败:', err)
		}
	})

	// 思维链展开/折叠
	dom.runThinkingHeader?.addEventListener('click', () => {
		const content = dom.runThinkingContent
		const arrow = dom.runThinkingArrow
		if (!content) return
		if (content.style.display === 'none') {
			content.style.display = ''
			if (arrow) arrow.textContent = '▼'
		} else {
			content.style.display = 'none'
			if (arrow) arrow.textContent = '▶'
		}
	})

	// ===== 记忆检索配置保存 =====

	dom.cfgSaveBtn?.addEventListener('click', async () => {
		const retrieval = {
			auto_trigger: dom.cfgAutoTrigger?.checked ?? true,
			chat_history_count: parseInt(dom.cfgChatHistoryCount?.value, 10) || 5,
			max_search_rounds: parseInt(dom.cfgMaxSearchRounds?.value, 10) || 5,
			timeout_ms: parseInt(dom.cfgTimeout?.value, 10) || 60000,
		}

		const preset_switch = {
			cooldown_rounds: parseInt(dom.cfgCooldownRounds?.value, 10) || 5,
		}

		showCfgStatus('保存中...')
		try {
			const result = await setPluginData({ _action: 'updateConfig', retrieval, preset_switch })
			if (result && result.success) {
				currentConfig = result.config
				showCfgStatus('✅ 配置已保存', 2000)
			} else {
				showCfgStatus('❌ 保存失败: ' + (result?.error || '未知错误'), 3000)
			}
		} catch (e) {
			showCfgStatus('❌ 保存出错: ' + e.message, 3000)
		}
	})

	// ===== 可折叠面板 =====
	setupCollapsiblePanel('mp-maintenance-header', 'mp-maintenance-arrow')
	setupCollapsiblePanel('mp-injection-header', 'mp-injection-arrow')
	setupCollapsiblePanel('mp-retrieval-header', 'mp-retrieval-arrow')

	// ===== 可用宏参考面板折叠 =====

	dom.macroRefHeader?.addEventListener('click', () => {
		if (!dom.macroRefBody) return
		if (dom.macroRefBody.style.display === 'none') {
			dom.macroRefBody.style.display = ''
			if (dom.macroRefArrow) dom.macroRefArrow.textContent = '▼'
		} else {
			dom.macroRefBody.style.display = 'none'
			if (dom.macroRefArrow) dom.macroRefArrow.textContent = '▶'
		}
	})

	// ===== 预设导出/导入 =====

	dom.exportPresetsBtn?.addEventListener('click', () => {
		exportPresets()
	})

	dom.importPresetsBtn?.addEventListener('click', () => {
		importPresets()
	})

	// 启用开关即时保存
	dom.detailToggle?.addEventListener('change', async () => {
		if (!selectedPresetId) return
		await setPluginData({
			_action: 'updateMemoryPreset',
			presetId: selectedPresetId,
			enabled: dom.detailToggle.checked,
		})
		// 刷新列表中的状态点
		const preset = presets.find(p => p.id === selectedPresetId)
		if (preset) preset.enabled = dom.detailToggle.checked
		renderPresetList()
	})
}

// ===== 记忆检索配置渲染 =====

function renderRetrievalConfig() {
	if (!currentConfig) return
	const retrieval = currentConfig.retrieval || {}

	if (dom.cfgAutoTrigger) dom.cfgAutoTrigger.checked = retrieval.auto_trigger !== false
	if (dom.cfgChatHistoryCount) dom.cfgChatHistoryCount.value = retrieval.chat_history_count ?? 5
	if (dom.cfgMaxSearchRounds) dom.cfgMaxSearchRounds.value = retrieval.max_search_rounds ?? 5
	if (dom.cfgTimeout) dom.cfgTimeout.value = retrieval.timeout_ms ?? 60000

	// 预设切换冷却
	const ps = currentConfig.preset_switch || {}
	if (dom.cfgCooldownRounds) dom.cfgCooldownRounds.value = ps.cooldown_rounds ?? 5
}

/** 通用可折叠面板设置 */
function setupCollapsiblePanel(headerId, arrowId) {
	const header = document.getElementById(headerId)
	const arrow = document.getElementById(arrowId)
	if (!header) return

	header.addEventListener('click', () => {
		const panel = header.closest('.beilu-config-section')
		if (!panel) return

		const isCollapsing = arrow?.textContent === '▼'
		let afterHeader = false

		for (const child of panel.children) {
			if (child === header) { afterHeader = true; continue }
			if (afterHeader) {
				child.style.display = isCollapsing ? 'none' : ''
			}
		}

		if (arrow) arrow.textContent = isCollapsing ? '▶' : '▼'
	})
}

function showCfgStatus(msg, autoClearMs = 0) {
	if (dom.cfgStatus) {
		dom.cfgStatus.textContent = msg
		if (autoClearMs > 0) {
			setTimeout(() => { dom.cfgStatus.textContent = '' }, autoClearMs)
		}
	}
}

// ===== 维护操作辅助 =====

function showMaintenanceStatus(msg, autoClearMs = 0) {
	if (dom.maintenanceStatus) {
		dom.maintenanceStatus.textContent = msg
		if (autoClearMs > 0) {
			setTimeout(() => { dom.maintenanceStatus.textContent = '' }, autoClearMs)
		}
	}
}

async function triggerMaintenanceAction(action, extraData = {}) {
	const resp = await fetch(`/api/parts/plugins:${PLUGIN_NAME}/config/setdata`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ _action: action, ...extraData }),
	})
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
	return await resp.json()
}

// ===== 预设预览渲染 (Dry Run) =====

/** 最近一次 dryRun 的原始 messages 数据，用于 JSON 视图 */
let lastDryRunMessages = null

/** 当前预览标签页：'formatted' | 'rawjson' */
let previewActiveTab = 'formatted'

function renderDryRunPreview(result) {
	if (!dom.presetPreviewContent) return

	const messages = result.messages || []
	lastDryRunMessages = messages
	const totalChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0)

	// 统计
	if (dom.presetPreviewStats) {
		dom.presetPreviewStats.textContent = `${messages.length} 条消息 · ${totalChars.toLocaleString()} 字符 · ≈${Math.round(totalChars / 3.5).toLocaleString()} tokens`
	}

	dom.presetPreviewContent.innerHTML = ''

	// === 标签页栏 ===
	const tabBar = document.createElement('div')
	tabBar.className = 'flex gap-1 mb-2'
	tabBar.innerHTML = `
		<button class="btn btn-xs mp-preview-tab ${previewActiveTab === 'formatted' ? '' : 'btn-outline'}" data-tab="formatted">📝 格式化视图</button>
		<button class="btn btn-xs mp-preview-tab ${previewActiveTab === 'rawjson' ? '' : 'btn-outline'}" data-tab="rawjson">📋 原始 JSON</button>
	`
	dom.presetPreviewContent.appendChild(tabBar)

	// 标签页事件
	tabBar.querySelectorAll('.mp-preview-tab').forEach(btn => {
		btn.addEventListener('click', () => {
			previewActiveTab = btn.dataset.tab
			renderDryRunPreview(result) // 重新渲染
		})
	})

	if (previewActiveTab === 'rawjson') {
		renderDryRunRawJson(messages)
	} else {
		renderDryRunFormatted(messages)
	}
}

/** 格式化卡片视图 */
function renderDryRunFormatted(messages) {
	messages.forEach((msg, idx) => {
		const card = document.createElement('div')
		card.className = 'rounded-md border border-base-content/10 overflow-hidden mb-2'

		// 角色颜色
		const roleColor = msg.role === 'system' ? 'text-blue-400' : msg.role === 'user' ? 'text-green-400' : 'text-purple-400'
		const roleBg = msg.role === 'system' ? 'bg-blue-500/5' : msg.role === 'user' ? 'bg-green-500/5' : 'bg-purple-500/5'
		
		// 标题行
		const headerDiv = document.createElement('div')
		headerDiv.className = `flex items-center gap-2 px-3 py-1.5 text-xs ${roleBg}`
		headerDiv.innerHTML = `
			<span class="badge badge-xs ${roleColor} font-mono">${escapeHtml(msg.role)}</span>
			<span class="text-base-content/30 text-[10px]">#${idx + 1}</span>
			<span class="flex-grow"></span>
			<span class="text-base-content/30">${(msg.content || '').length} chars</span>
		`

		// 内容区
		const bodyDiv = document.createElement('div')
		const pre = document.createElement('pre')
		pre.className = 'mp-preset-preview-text text-xs font-mono whitespace-pre-wrap p-3 max-h-96 overflow-y-auto'
		pre.dataset.role = msg.role
		pre.style.cssText = 'background: oklch(var(--bc) / 0.03); margin: 0;'
		pre.textContent = msg.content
		bodyDiv.appendChild(pre)

		card.appendChild(headerDiv)
		card.appendChild(bodyDiv)
		dom.presetPreviewContent.appendChild(card)
	})
}

/** 原始 JSON 视图 */
function renderDryRunRawJson(messages) {
	const wrapper = document.createElement('div')

	// 复制按钮
	const copyBar = document.createElement('div')
	copyBar.className = 'flex justify-end mb-1'
	const copyBtn = document.createElement('button')
	copyBtn.className = 'btn btn-xs btn-outline'
	copyBtn.textContent = '📋 复制 JSON'
	copyBtn.title = '复制完整 JSON 到剪贴板'
	copyBar.appendChild(copyBtn)
	wrapper.appendChild(copyBar)

	const jsonStr = JSON.stringify(messages, null, 2)

	const pre = document.createElement('pre')
	pre.className = 'text-xs font-mono whitespace-pre-wrap p-3 rounded-md overflow-y-auto select-all'
	pre.style.cssText = 'background: oklch(var(--bc) / 0.05); border: 1px solid oklch(var(--bc) / 0.1); max-height: 70vh;'
	pre.textContent = jsonStr
	wrapper.appendChild(pre)

	// 复制事件
	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(jsonStr)
			copyBtn.textContent = '✅ 已复制'
			setTimeout(() => { copyBtn.textContent = '📋 复制 JSON' }, 1500)
		} catch (err) {
			console.error('[memoryPreset] 复制 JSON 失败:', err)
		}
	})

	dom.presetPreviewContent.appendChild(wrapper)
}

// ===== 运行结果渲染 =====

function renderRunResult(result) {
	// 时间戳
	if (dom.runResultTime) {
		const ts = result.timestamp ? new Date(result.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()
		dom.runResultTime.textContent = `${result.presetName || result.presetId || ''} · ${ts}`
	}

	// 思维链
	if (result.thinking) {
		if (dom.runThinking) dom.runThinking.style.display = ''
		if (dom.runThinkingContent) dom.runThinkingContent.textContent = result.thinking
		if (dom.runThinkingArrow) dom.runThinkingArrow.textContent = '▶'
		if (dom.runThinkingContent) dom.runThinkingContent.style.display = 'none'
	} else {
		if (dom.runThinking) dom.runThinking.style.display = 'none'
	}

	// 操作列表
	if (result.operations && result.operations.length > 0) {
		if (dom.runOperations) dom.runOperations.style.display = ''
		if (dom.runOperationsList) {
			dom.runOperationsList.innerHTML = ''
			for (const op of result.operations) {
				const opEl = document.createElement('div')
				opEl.className = 'flex items-center gap-2 text-xs p-1.5 rounded-md'
				opEl.style.cssText = 'background: oklch(var(--bc) / 0.03);'

				const statusIcon = op.success ? '✅' : '❌'
				const tagName = op.tag || op.type || 'unknown'
				const opType = op.opType || op.action || ''

				opEl.innerHTML = `
					<span>${statusIcon}</span>
					<span class="badge badge-xs badge-outline font-mono">${escapeHtml(tagName)}</span>
					<span class="font-mono text-base-content/60">${escapeHtml(opType)}</span>
					${op.path ? `<span class="text-base-content/40 truncate">${escapeHtml(op.path)}</span>` : ''}
					${op.error ? `<span class="text-error text-xs">${escapeHtml(op.error)}</span>` : ''}
				`
				dom.runOperationsList.appendChild(opEl)
			}
		}
	} else {
		if (dom.runOperations) dom.runOperations.style.display = 'none'
	}

	// AI 回复
	if (dom.runReply) dom.runReply.style.display = ''
	if (dom.runReplyContent) dom.runReplyContent.textContent = result.reply || '（无回复内容）'

	// 清除错误
	if (dom.runError) dom.runError.style.display = 'none'
}

function renderRunError(errorMsg) {
	if (dom.runError) dom.runError.style.display = ''
	if (dom.runErrorContent) dom.runErrorContent.textContent = `❌ ${errorMsg}`
	if (dom.runReply) dom.runReply.style.display = 'none'
	if (dom.runThinking) dom.runThinking.style.display = 'none'
	if (dom.runOperations) dom.runOperations.style.display = 'none'
}

/** HTML 转义 */
function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
}

// ===== P1 预设切换管理区域 =====

/**
 * 渲染 P1 专属的"预设切换管理"区域
 * 仅当选中的预设是 P1 时调用
 * @param {object} preset - P1 预设对象
 */
function renderPresetSwitchSection(preset) {
	// 清除旧的预设切换区域
	const oldSection = document.getElementById('mp-preset-switch-section')
	if (oldSection) oldSection.remove()

	// 仅 P1 显示
	if (preset.id !== 'P1') return

	// 在提示词列表之前插入预设切换区域
	const targetContainer = dom.promptList?.parentElement
	if (!targetContainer) return

	const section = document.createElement('div')
	section.id = 'mp-preset-switch-section'
	section.className = 'beilu-config-section mt-3 mb-3'
	section.style.cssText = 'border: 1px solid oklch(var(--bc) / 0.1); border-radius: 8px; padding: 12px;'

	const isAutoEnabled = preset.preset_switch_auto !== false // 默认 true
	const entries = preset.preset_switch_entries || []

	section.innerHTML = `
		<div class="flex items-center justify-between mb-3 cursor-pointer" id="mp-ps-header">
			<div class="flex items-center gap-2">
				<span id="mp-ps-arrow" class="text-xs text-base-content/30">▼</span>
				<span class="text-sm font-semibold">🔄 预设切换管理</span>
				<span class="badge badge-xs badge-outline badge-warning">P1 专属</span>
			</div>
			<label class="cursor-pointer label gap-2 p-0" title="启用/禁用自动预设切换">
				<span class="text-xs text-base-content/50">自动切换</span>
				<input type="checkbox" id="mp-ps-auto-toggle" class="toggle toggle-xs toggle-warning" ${isAutoEnabled ? 'checked' : ''} />
			</label>
		</div>
		<div id="mp-ps-body">
			<p class="text-xs text-base-content/40 mb-2">
				配置 P1 检索AI 可以切换的聊天预设。为每个预设编写描述，帮助AI判断何时切换。
				<br/>关闭"自动切换"后，<code>{{presetList}}</code> 宏将不注入，AI不会输出切换标签。
			</p>
			<div id="mp-ps-entry-list" class="space-y-2"></div>
			<div class="flex items-center gap-2 mt-2">
				<select id="mp-ps-add-select" class="select select-xs select-bordered flex-grow">
					<option value="" disabled selected>选择要添加的预设...</option>
				</select>
				<button id="mp-ps-add-btn" class="btn btn-xs btn-outline btn-warning">+ 添加</button>
			</div>
		</div>
	`

	// 插入到提示词标题之前
	const promptHeader = targetContainer.querySelector('#mp-prompt-list')?.previousElementSibling
	if (promptHeader) {
		targetContainer.insertBefore(section, promptHeader)
	} else {
		targetContainer.insertBefore(section, dom.promptList)
	}

	// 渲染已有条目
	const entryList = document.getElementById('mp-ps-entry-list')
	for (const entry of entries) {
		appendPresetSwitchEntryRow(entryList, entry.preset_name, entry.description)
	}

	// 填充可添加的预设下拉框（排除已添加的）
	refreshPresetSwitchAddSelect(entries)

	// 事件绑定
	// 折叠/展开
	document.getElementById('mp-ps-header')?.addEventListener('click', (e) => {
		if (e.target.tagName.toLowerCase() === 'input') return // 跳过 toggle
		const body = document.getElementById('mp-ps-body')
		const arrow = document.getElementById('mp-ps-arrow')
		if (!body) return
		if (body.style.display === 'none') {
			body.style.display = ''
			if (arrow) arrow.textContent = '▼'
		} else {
			body.style.display = 'none'
			if (arrow) arrow.textContent = '▶'
		}
	})

	// 添加按钮
	document.getElementById('mp-ps-add-btn')?.addEventListener('click', () => {
		const select = document.getElementById('mp-ps-add-select')
		const name = select?.value
		if (!name) return

		appendPresetSwitchEntryRow(entryList, name, '')
		refreshPresetSwitchAddSelect()
		select.value = ''
	})
}

/**
 * 往预设切换条目列表中追加一行
 * @param {HTMLElement} container - 条目列表容器
 * @param {string} presetName - 预设名称
 * @param {string} description - 描述文本
 */
function appendPresetSwitchEntryRow(container, presetName, description) {
	if (!container) return

	// 检查是否已有同名条目（防重复）
	if (container.querySelector(`.mp-ps-entry-row[data-preset-name="${presetName}"]`)) return

	// 查看此预设是否是当前激活的
	const ap = availablePresets.find(p => p.name === presetName)
	const isActive = ap?.active

	const row = document.createElement('div')
	row.className = 'mp-ps-entry-row flex items-start gap-2 p-2 rounded-md'
	row.dataset.presetName = presetName
	row.style.cssText = 'background: oklch(var(--bc) / 0.03); border: 1px solid oklch(var(--bc) / 0.06);'

	row.innerHTML = `
		<div class="flex flex-col flex-grow gap-1">
			<div class="flex items-center gap-2">
				<span class="badge badge-xs ${isActive ? 'badge-success' : 'badge-outline'} font-mono">${escapeHtml(presetName)}</span>
				${isActive ? '<span class="text-[10px] text-success/60">[当前]</span>' : ''}
			</div>
			<textarea class="textarea textarea-bordered textarea-xs w-full text-xs mp-ps-entry-desc" rows="2"
				placeholder="为AI描述此预设的适用场景，如「日常聊天/轻松对话时使用」">${escapeHtml(description)}</textarea>
		</div>
		<button class="btn btn-xs btn-ghost btn-error mp-ps-entry-delete" title="移除">✕</button>
	`

	// 删除按钮
	row.querySelector('.mp-ps-entry-delete')?.addEventListener('click', () => {
		row.remove()
		refreshPresetSwitchAddSelect()
	})

	container.appendChild(row)
}

/**
 * 刷新"添加预设"下拉框（排除已在条目列表中的预设）
 * @param {Array} [currentEntries] - 当前条目列表（省略时从 DOM 读取）
 */
function refreshPresetSwitchAddSelect(currentEntries) {
	const select = document.getElementById('mp-ps-add-select')
	if (!select) return

	// 获取已有的预设名称
	let existingNames
	if (currentEntries) {
		existingNames = new Set(currentEntries.map(e => e.preset_name))
	} else {
		existingNames = new Set()
		document.querySelectorAll('.mp-ps-entry-row').forEach(row => {
			existingNames.add(row.dataset.presetName)
		})
	}

	select.innerHTML = '<option value="" disabled selected>选择要添加的预设...</option>'
	for (const ap of availablePresets) {
		if (existingNames.has(ap.name)) continue
		const opt = document.createElement('option')
		opt.value = ap.name
		opt.textContent = ap.name + (ap.active ? ' [当前]' : '') + (ap.description ? ` - ${ap.description}` : '')
		select.appendChild(opt)
	}
}

// ===== 预设导出/导入 =====

/** 导出 INJ + P1-P6 预设为 JSON 文件下载 */
function exportPresets() {
	if (!presets || presets.length === 0) {
		showStatus('❌ 没有可导出的预设数据', 3000)
		return
	}

	// 深拷贝后清洗敏感信息（api_config 中的 source 可能泄露用户私有服务器名称）
	const cleanPresets = structuredClone(presets)
	for (const preset of cleanPresets) {
		if (preset.api_config) {
			// 只保留模型参数，清除服务源信息
			preset.api_config = {
				use_custom: false,
				source: '',
				model: preset.api_config.model || '',
				temperature: preset.api_config.temperature ?? 0.3,
				max_tokens: preset.api_config.max_tokens ?? 2000,
			}
		}
		// 导出时清除预设切换配置（用户私有数据，不应带走）
		delete preset.preset_switch_entries
		delete preset.preset_switch_auto
	}

	const exportData = {
		_format: 'beilu-memory-presets-export',
		_version: 1,
		_exported_at: new Date().toISOString(),
		presets: cleanPresets,
		injection_prompts: structuredClone(injectionPrompts),
	}

	const jsonStr = JSON.stringify(exportData, null, '\t')
	const blob = new Blob([jsonStr], { type: 'application/json' })
	const url = URL.createObjectURL(blob)

	const dateStr = new Date().toISOString().slice(0, 10)
	const fileName = `beilu-presets_${dateStr}.json`

	const a = document.createElement('a')
	a.href = url
	a.download = fileName
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)

	showStatus(`✅ 已导出 ${presets.length} 个预设 + ${injectionPrompts.length} 个注入条目`, 3000)
}

/** 导入预设 JSON 文件 */
function importPresets() {
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = '.json'
	input.style.display = 'none'

	input.addEventListener('change', async (e) => {
		const file = e.target.files[0]
		if (!file) return

		try {
			const text = await file.text()
			let importData
			try {
				importData = JSON.parse(text)
			} catch {
				showStatus('❌ 文件不是有效的 JSON', 3000)
				return
			}

			// 格式验证
			if (importData._format !== 'beilu-memory-presets-export') {
				showStatus('❌ 不是有效的预设导出文件', 3000)
				return
			}
			if (!Array.isArray(importData.presets) || !Array.isArray(importData.injection_prompts)) {
				showStatus('❌ 文件缺少 presets 或 injection_prompts', 3000)
				return
			}

			// 确认导入
			const presetNames = importData.presets.map(p => `${p.id}(${p.name})`).join(', ')
			const injNames = importData.injection_prompts.map(p => `${p.id}(${p.name})`).join(', ')
			const msg = `确定导入以下预设吗？\n\n预设: ${presetNames}\n注入: ${injNames}\n\n⚠️ 这将覆盖当前所有预设配置（原配置会备份）。`
			if (!confirm(msg)) return

			showStatus('⏳ 导入中...')

			const result = await setPluginData({
				_action: 'importPresets',
				importData: importData,
				backupExisting: true,
			})

			if (result && result.success) {
				await refreshPresets()
				showStatus(`✅ 导入成功: ${result.presetsCount} 个预设, ${result.injectionCount} 个注入条目`, 4000)
			} else {
				showStatus(`❌ 导入失败: ${result?.error || '未知错误'}`, 5000)
			}
		} catch (err) {
			console.error('[memoryPreset] 导入预设失败:', err)
			showStatus(`❌ 导入出错: ${err.message}`, 5000)
		}
	})

	document.body.appendChild(input)
	input.click()
	document.body.removeChild(input)
}

// ===== 初始化 =====

export async function init() {
	console.log('[memoryPreset] 初始化记忆预设管理...')

	cacheDom()
	bindEvents()

	// 先加载 AI 服务源列表
	aiSourceList = await fetchAISourceList()
	console.log(`[memoryPreset] 获取到 ${aiSourceList.length} 个 AI 服务源`)

	// 加载角色卡列表
	await loadCharList()

	await refreshPresets()

	// 隐藏 loading，显示主内容
	if (dom.loading) dom.loading.style.display = 'none'
	if (dom.main) dom.main.style.display = ''

	// ===== 监听资源变更事件，自动刷新相关数据 =====
	window.addEventListener('resource:api-changed', async () => {
		console.log('[memoryPreset] 检测到 API 配置变更，刷新服务源列表')
		aiSourceList = await fetchAISourceList()
		// 如果当前有选中的预设，刷新详情中的服务源下拉框
		if (selectedPresetId) renderDetail()
	})

	window.addEventListener('resource:char-changed', async () => {
		console.log('[memoryPreset] 检测到角色卡变更，刷新角色卡列表')
		await loadCharList()
	})

	window.addEventListener('resource:preset-changed', async () => {
		console.log('[memoryPreset] 检测到预设变更，刷新数据')
		await refreshPresets()
	})

	console.log(`[memoryPreset] 加载了 ${presets.length} 个记忆预设`)
}
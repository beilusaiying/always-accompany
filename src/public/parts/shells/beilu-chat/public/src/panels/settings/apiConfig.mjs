/**
 * API 配置管理模块
 *
 * 在 beilu-chat 管理面板中提供简化的 API 服务源配置表单，
 * 复用 serviceSourceManage 后端 API，无需自定义后端路由。
 */

import { sendAction } from '../../shared/transport/sendAction.mjs' // 6c尾·根级散件归位 // T6b：出向统一门面（serviceSourceManage AI 源 CRUD；getAISources 列表复用批3 注册）
import { storage, KEYS } from "../../shared/state/storage.mjs" // 6c尾·根级散件归位; // R2: localStorage 集中
import { beiluChoice, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs" // 6c尾·根级散件归位; // T026: confirm→choice（删除去向询问）
import { loadChannels } from "./apiChannels.mjs" // 0711 渠道下拉恢复：渠道表单源（后端 PROVIDER_META）
import { assertApiSourceReadback, isApiSourceMarkedUsable } from "./apiSourceContract.mjs"

// ============================================================
// API 通信层（T6b：全走 sendAction 门面，verb=真动作，name/generator/data 进 payload）
// ============================================================

async function fetchApiList() {
	return sendAction({ verb: 'getAISources', target: 'shells:serviceSourceManage', source: 'web' })
}

async function fetchApiConfig(name) {
	return sendAction({ verb: 'getAISource', target: 'shells:serviceSourceManage', source: 'web', payload: { name } })
}

async function saveApiSource(name, data) {
	return sendAction({ verb: 'saveAISource', target: 'shells:serviceSourceManage', source: 'web', payload: { name, data } })
}

async function deleteApiSource(name, mode) {
	// T026: mode=trash(默认,进回收站可找回)|permanent(彻底删,防留痕)——后端 deleteServiceSourceFile 按此分流
	return sendAction({ verb: 'deleteAISource', target: 'shells:serviceSourceManage', source: 'web', payload: { name, mode } })
}

async function fetchConfigTemplate(generator) {
	try {
		return await sendAction({ verb: 'getGeneratorTemplate', target: 'shells:serviceSourceManage', source: 'web', payload: { generator } })
	} catch (err) {
		window._reportError?.(`[apiConfig] fetchConfigTemplate(${generator}): ${err.message}`, err.stack);
		throw err;
	}
}

// ============================================================
// API 类型定义
// ============================================================

// API 渠道表（0711 渠道下拉恢复）：类型=渠道，表由 apiChannels.loadChannels() 从后端
// PROVIDER_META 单源构建；旧 API_TYPES 硬编码两项表已删（前端另建枚举=违反 apiAdapters.mjs:29 裁决）。
// 本模块同时服务主页面右栏与 api-config 独立页（两处 DOM id 相同），改一处两页生效。
let CH = null
// 未知生成器（claude-api/grok/polling…）的临时渠道项：保存不动 generator/provider
// （修 0711 前旧病：未知生成器被 `generator in API_TYPES ? : 'proxy'` 强转 proxy=错绑）
let _tempEntry = null
// 「用户没改过 URL」判据：空或仍等于上个渠道默认 → 切渠道才自动换新默认
let _lastDefaultUrl = ''

async function ensureChannels() {
	if (!CH) CH = await loadChannels()
	return CH
}

// 幂等重建渠道选项（保留当前选中值与临时项）。initApiConfig 与 loadApiSource 并发首跑时
// 谁先拿到渠道表谁建，后到方检测到已建（选项数>1）跳过，消竞态。
function _rebuildTypeOptions() {
	if (!apiTypeSelect || !CH) return
	if (apiTypeSelect.dataset.chBuilt === '1') return
	const prevValue = apiTypeSelect.value
	apiTypeSelect.innerHTML = ''
	for (const c of CH.channels) {
		const opt = document.createElement('option')
		opt.value = c.value
		opt.textContent = c.label
		apiTypeSelect.appendChild(opt)
	}
	if (_tempEntry) _ensureTempOption(_tempEntry)
	if (prevValue && CH.byValue.has(prevValue)) apiTypeSelect.value = prevValue
	apiTypeSelect.dataset.chBuilt = '1'
}

export function getCurrentChannelEntry() {
	const v = apiTypeSelect?.value
	if (!v) return null
	if (_tempEntry && _tempEntry.value === v) return _tempEntry
	return CH?.byValue.get(v) || null
}

// ============================================================
// 状态
// ============================================================

// P2（一致性审计②）：野键收编 KEYS——旧下划线名逃逸 beilu- 前缀域（删号 clearAll 清不掉）
const STORAGE_KEY = KEYS.BEILU_API_SOURCE
// 旧键一次性迁移（保用户已选 API 源），迁完即删旧键
{
	const _legacy = storage.get('beilu_current_api_source')
	if (_legacy !== null) {
		if (storage.get(STORAGE_KEY) === null) storage.set(STORAGE_KEY, _legacy)
		storage.remove('beilu_current_api_source')
	}
}

let currentApiName = null
let apiSources = []

// ============================================================
// DOM 引用
// ============================================================

let apiSelect, apiNameInput, apiTypeSelect, apiUrlInput, apiKeyInput, apiModelInput
let apiSaveBtn, apiDeleteBtn, apiNewBtn, apiStatus

// ============================================================
// 初始化（绑定 DOM 和事件，只调用一次）
// ============================================================

export function getCurrentApiType() {
	return apiTypeSelect?.value || ''
}

// resource:api-changed 自触发抑制：本面板派发该事件时跳过自身监听器重载（dispatchEvent 同步，
//   抑制窗口覆盖监听器执行；外部监听者 banner/tokenProgressBar 不受影响）。
let _suppressApiReload = false
function _emitApiChanged() {
	_suppressApiReload = true
	try { window.dispatchEvent(new CustomEvent('resource:api-changed')) }
	finally { _suppressApiReload = false }
}

export async function initApiConfig() {
	apiSelect = document.getElementById('api-select')
	apiNameInput = document.getElementById('api-name')
	apiTypeSelect = document.getElementById('api-type')
	apiUrlInput = document.getElementById('api-url')
	apiKeyInput = document.getElementById('api-key')
	apiModelInput = document.getElementById('api-model')
	apiSaveBtn = document.getElementById('api-save-btn')
	apiDeleteBtn = document.getElementById('api-delete-btn')
	apiNewBtn = document.getElementById('api-new-btn')
	apiStatus = document.getElementById('api-status')

	// 渠道下拉选项运行时重建（后端 PROVIDER_META 单源；HTML 静态项只是 JS 未就绪占位）
	await ensureChannels()
	_rebuildTypeOptions()
	// 渠道坑提示区 + URL「恢复默认」按钮动态注入（主页面与 api-config 独立页共用，免双份 HTML）
	if (apiTypeSelect && !document.getElementById('api-channel-hint')) {
		const hintEl = document.createElement('div')
		hintEl.id = 'api-channel-hint'
		hintEl.className = 'hidden text-[11px] text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1 my-1'
		;(apiTypeSelect.closest('.form-control') || apiTypeSelect).after(hintEl)
	}
	if (apiUrlInput && !document.getElementById('api-url-reset')) {
		const resetBtn = document.createElement('button')
		resetBtn.id = 'api-url-reset'
		resetBtn.type = 'button'
		resetBtn.className = 'btn btn-xs btn-outline mt-1'
		resetBtn.textContent = '恢复默认地址'
		resetBtn.title = '回填该渠道的默认端点（可随意修改或清空，此按钮随时可恢复）'
		resetBtn.addEventListener('click', () => {
			const e = getCurrentChannelEntry()
			if (!e) return
			if (apiUrlInput) apiUrlInput.value = e.defaultUrl || ''
			_lastDefaultUrl = e.defaultUrl || ''
		})
		apiUrlInput.after(resetBtn)
	}

	// [0727 并发闸] 全局 AI 并发上限（用户级总闸，非 per-源参数）：后端 yonban_config.ai_max_concurrent 单源，
	//   前端只展示/调节（操作界面三原则：值域校验在后端 endpoints，改动即时生效不需重启）
	const concInput = document.getElementById('ai-concurrency-input')
	const concStatus = document.getElementById('ai-concurrency-status')
	if (concInput && concInput.dataset.bound !== '1') {
		concInput.dataset.bound = '1'
		try {
			const r = await sendAction({ verb: 'getAiConcurrency', target: 'shells:chat', source: 'web' })
			concInput.value = String(r?.limit ?? 0)
		} catch { /* 读失败保持占位（0=不限），不阻断面板初始化 */ }
		concInput.addEventListener('change', async () => {
			const n = Math.max(0, Math.min(99, parseInt(concInput.value, 10) || 0))
			concInput.value = String(n)
			try {
				const r = await sendAction({ verb: 'setAiConcurrency', target: 'shells:chat', source: 'web', payload: { limit: n } })
				if (concStatus) {
					concStatus.textContent = (r?.limit ?? n) > 0 ? `已生效: ${r.limit}` : '不限'
					setTimeout(() => { if (concStatus) concStatus.textContent = '' }, 3000)
				}
			} catch (err) {
				if (concStatus) concStatus.textContent = '保存失败'
				window._reportError?.(`[apiConfig] setAiConcurrency: ${err.message}`, err.stack)
			}
		})
	}

	apiSelect?.addEventListener('change', () => loadApiSource(apiSelect.value))
	apiTypeSelect?.addEventListener('change', () => {
		// 用户没改过 URL（空或=上个渠道默认）才自动换新默认；改过的值不动（凛倾：可删可改）
		const e = getCurrentChannelEntry()
		if (!e) return
		if (apiUrlInput && (!apiUrlInput.value || apiUrlInput.value === _lastDefaultUrl))
			apiUrlInput.value = e.defaultUrl || ''
		_lastDefaultUrl = e.defaultUrl || ''
		syncUrlLabel()
	})
	apiSaveBtn?.addEventListener('click', handleSave)
	apiDeleteBtn?.addEventListener('click', handleDelete)
	apiNewBtn?.addEventListener('click', handleNew)

	// 参与 resource:api-changed 事件契约：外部(设置弹窗 settingsSlots / layout)改 API 源 → 刷新本面板下拉，
	//   即使设置页当前隐藏也必须消费事件：resource 事件不是可重放状态，隐藏时丢弃会让下次打开仍显示旧库存。
	//   本面板自身派发仍由同步抑制窗跳过，避免保存/删除/新建后重复重载。
	window.addEventListener('resource:api-changed', () => { if (!_suppressApiReload) void loadApiConfig() })
}

// ============================================================
// 加载（切换到 API 选项卡时调用）
// ============================================================

// N29：绑定指示行——本面板的下拉=「编辑哪份源配置」（localStorage 记忆上次编辑项），
// 与角色实际绑定源（parts_config AIsource）是两回事，此前无任何提示=展示层误导（全局测试轮 #5：
// 面板显示 ds 而角色实际绑定/生成走 mock 源）。只加只读指示，不改选择/CRUD 语义（解耦专项另排）。
async function _renderBindingIndicator() {
	if (!apiSelect) return
	let el = document.getElementById('api-binding-indicator')
	if (!el) {
		el = document.createElement('div')
		el.id = 'api-binding-indicator'
		el.style.cssText = 'font-size:11px;opacity:0.75;margin-bottom:4px;line-height:1.4'
		const flexRow = apiSelect.parentElement
		flexRow?.parentElement?.insertBefore(el, flexRow)
	}
	try {
		const { getCharId } = await import('../../shared/state/sharedState.mjs') // 6c尾·根级散件归位（动态 import 形态——批量切漏网，探针 404 抓回）
		const charName = getCharId?.()
		if (!charName) { el.textContent = ''; return }
		// 门面 getCharAISource：charName 进 URL；!ok 由 apiFetch 抛错走 catch（el.textContent=''）。
		const data = await sendAction({ verb: 'getCharAISource', target: 'shells:chat', source: 'web', payload: { charName } })
		el.textContent = data.AIsource
			? `当前角色「${charName}」生成实际使用：${data.AIsource} ｜ 下方下拉=选择要编辑的配置，不切换绑定`
			: `当前角色「${charName}」未绑定 AI 源 ｜ 下方下拉=选择要编辑的配置，不切换绑定`
	} catch { el.textContent = '' }
}

export async function loadApiConfig({ preferredName = '' } = {}) {
	if (!apiSelect) return false
	// 绑定真值与源列表/详情同属 API 就绪层：并行读取，但返回前共同收口，避免子模式抢跑。
	const bindingIndicatorPromise = _renderBindingIndicator()
	try {
		const list = await fetchApiList()
		apiSources = list
		renderApiSelect(list)
		let loaded = true
		if (list.length > 0) {
			// 显式目标（如刚创建的源）优先，其次当前源，最后才是 localStorage 历史选择。
			const saved = storage.get(STORAGE_KEY)
			const defaultName = (preferredName && list.includes(preferredName)) ? preferredName
				: (currentApiName && list.includes(currentApiName)) ? currentApiName
					: (saved && list.includes(saved)) ? saved
				: list[0]
			loaded = await loadApiSource(defaultName)
		} else {
			clearForm()
		}
		await bindingIndicatorPromise
		return loaded
	} catch (err) {
		await bindingIndicatorPromise
		console.error('[beilu-chat] 加载 API 配置列表失败:', err)
		showApiStatus('加载失败: ' + err.message, 'error')
		return false
	}
}

// ============================================================
// 渲染
// ============================================================

function renderApiSelect(list) {
	if (!apiSelect) return
	apiSelect.innerHTML = ''
	if (list.length === 0) {
		const opt = document.createElement('option')
		opt.value = ''
		opt.textContent = '（无配置）'
		apiSelect.appendChild(opt)
		return
	}
	list.forEach(name => {
		const opt = document.createElement('option')
		opt.value = name
		opt.textContent = name
		if (name === currentApiName) opt.selected = true
		apiSelect.appendChild(opt)
	})
}

function clearForm() {
	currentApiName = null
	_removeTempOption()
	_lastDefaultUrl = ''
	if (apiNameInput) apiNameInput.value = ''
	if (apiUrlInput) apiUrlInput.value = ''
	if (apiKeyInput) apiKeyInput.value = ''
	var _clrM = window._beiluSetModel; if (_clrM) _clrM(''); else if (apiModelInput) apiModelInput.value = ''
	if (apiDeleteBtn) apiDeleteBtn.disabled = true
	syncUrlLabel()
}

function _removeTempOption() {
	_tempEntry = null
	apiTypeSelect?.querySelector('option[data-temp]')?.remove()
}

function _ensureTempOption(entry) {
	_removeTempOption()
	_tempEntry = entry
	const opt = document.createElement('option')
	opt.value = entry.value
	opt.textContent = entry.label
	opt.dataset.temp = '1'
	apiTypeSelect?.appendChild(opt)
}

function syncUrlLabel() {
	const e = getCurrentChannelEntry()
	const label = document.getElementById('api-url-label')
	if (label) label.textContent = e?.urlLabel || 'API URL'
	if (apiUrlInput) apiUrlInput.placeholder = e?.defaultUrl || ''
	const hintEl = document.getElementById('api-channel-hint')
	if (hintEl) {
		hintEl.textContent = e?.hint || ''
		hintEl.classList.toggle('hidden', !e?.hint)
	}
	document.getElementById('api-url-reset')?.classList.toggle('hidden', !e?.defaultUrl)
}

// ============================================================
// 加载单个配置
// ============================================================

async function loadApiSource(name) {
	if (!name) return false
	currentApiName = name
	storage.set(STORAGE_KEY, name)
	if (apiSelect) apiSelect.value = name
	try {
		const data = await fetchApiConfig(name)
		// [0716 竞态修] 乱序覆盖守卫：快速切源 A→B 时 A 的慢响应后至会覆盖 B 的整套表单
		//   （url/key/model 全被旧值填回）。currentApiName 在 :307 请求前同步先写=天然令牌
		//   （与 subModePanel._modelSelectReqId 同语义，复用既有单源零新状态），
		//   await 后不等=用户已切走，丢弃本响应。ensureChannels 后同判（它也 await）。
		if (currentApiName !== name) return
		const generator = typeof data?.generator === 'string' ? data.generator.trim() : ''
		const config = data?.config && typeof data.config === 'object' && !Array.isArray(data.config) ? data.config : {}
		await ensureChannels()
		if (currentApiName !== name) return
		_rebuildTypeOptions()

		if (apiNameInput) apiNameInput.value = config.name || name
		if (!generator) {
			// 旧空壳必须可见并可由用户明确选择渠道后修复，不能把它静默解释为 proxy。
			_removeTempOption()
			if (apiUrlInput) apiUrlInput.value = config.url || config.base_url || config.host || ''
			if (apiKeyInput) apiKeyInput.value = config.apikey || ''
			const setModel = window._beiluSetModel
			if (setModel) setModel(config.model || '')
			else if (apiModelInput) apiModelInput.value = config.model || ''
			_lastDefaultUrl = ''
			syncUrlLabel()
			if (apiDeleteBtn) apiDeleteBtn.disabled = false
			showApiStatus('该配置缺少渠道；请选择渠道后重新保存。', 'error')
			return
		}
		const chValue = CH.valueFor(generator, config)
		let entry
		if (chValue) {
			_removeTempOption()
			if (apiTypeSelect) apiTypeSelect.value = chValue
			entry = getCurrentChannelEntry()
		} else {
			// 未知生成器：按配置实有键探测地址字段，保存时保留原 generator（不再强转 proxy）
			const urlField = ['url', 'base_url', 'host'].find((k) => k in config) || 'url'
			_ensureTempOption({
				value: `__gen:${generator}`, label: `${generator}（其他生成器）`, generator, provider: '',
				urlField, urlLabel: `API 地址（字段：${urlField}）`, defaultUrl: '',
				hint: '此生成器的专项参数请在服务源管理页配置；这里保存只更新名称/地址/密钥/模型',
			})
			if (apiTypeSelect) apiTypeSelect.value = `__gen:${generator}`
			entry = _tempEntry
		}
		if (apiUrlInput) apiUrlInput.value = config[entry.urlField] || ''
		_lastDefaultUrl = entry.defaultUrl || ''
		if (apiKeyInput) apiKeyInput.value = config.apikey || ''
		var _setM = window._beiluSetModel
		if (_setM) _setM(config.model || '')
		else if (apiModelInput) { apiModelInput.value = config.model || ''; apiModelInput.dispatchEvent(new Event('change')) }

		syncUrlLabel()
		if (apiDeleteBtn) apiDeleteBtn.disabled = false

		// [0717 链路修·模型列表跟随源] 原 W54 一次性门闩（window._beiluModelsFetched 只在首次
		//   加载源时拉一次）→ 切源后 #api-model-select 永远停在第一个源的列表（凛倾截图：源=gemini
		//   下拉全是 claude 模型），且全智能右栏 smart-api-model / 底栏选择器全镜像此 select=整链失真。
		//   改为每次加载源都静默重拉（乱序守卫在 fetchModels 内部 _fetchModelsSeq，后发压前发）。
		//   先把列表重置为本源已存模型（config.model）：fetch 失败/URL 空时不残留上个源的列表，
		//   诚实降级显示本源真值（同 fetchModels B1 fallback 语义）。
		const _mSel = document.getElementById('api-model-select')
		if (_mSel) {
			_mSel.innerHTML = '<option value="" disabled selected>选择模型...</option>'
			if (config.model) {
				const _mOpt = document.createElement('option')
				_mOpt.value = config.model
				_mOpt.textContent = config.model
				_mOpt.selected = true
				_mSel.appendChild(_mOpt)
			}
		}
		setTimeout(() => {
			if (currentApiName !== name) return // 已切走：由最新源的加载轮触发，本轮不重复拉
			const fetchBtn = document.getElementById('api-fetch-models')
			if (fetchBtn) {
				fetchBtn.dataset.silent = "1"
				fetchBtn.click()
			}
		}, 100)
		return true
	} catch (err) {
		console.error('[beilu-chat] 加载 API 配置失败:', err)
		showApiStatus('加载失败: ' + err.message, 'error')
		return false
	}
}

// ============================================================
// 保存
// ============================================================

async function handleSave() {
	if (!currentApiName) {
		showApiStatus('请先选择或新建一个配置', 'error')
		return
	}
	const sourceName = currentApiName
	// 点击瞬间冻结表单与渠道；等待旧配置读回期间切换到别的源，不能把新 DOM 值写回旧源。
	const channelValue = apiTypeSelect?.value || ''
	const isTempEntrySnapshot = _tempEntry?.value === channelValue
	const tempEntrySnapshot = isTempEntrySnapshot ? { ..._tempEntry } : null
	const formSnapshot = {
		name: (apiNameInput?.value || '').trim(),
		apikey: (apiKeyInput?.value || '').trim(),
		model: (apiModelInput?.value || '').trim(),
		url: (apiUrlInput?.value || '').trim(),
	}
	await ensureChannels()
	const entry = tempEntrySnapshot || CH?.byValue.get(channelValue) || null
	if (!entry) {
		showApiStatus('请先选择一个 API 渠道', 'error')
		return
	}
	const generator = entry.generator

	// 获取现有配置作为基础，保留高级字段不被覆盖
	let baseConfig = {}
	try {
		const existing = await fetchApiConfig(sourceName)
		baseConfig = existing.config || {}
	} catch (err) {
		// 已有源读取失败时禁止拿模板冒充原配置继续保存：这会丢失高级字段，
		// 也会把后端刚刚显式报告的损坏配置覆盖成“看似成功”的新空壳。
		showApiStatus('无法读取现有配置，已停止保存: ' + err.message, 'error')
		return
	}

	// 更新表单中的字段（0714 trim：脏 URL 曾致后端 getModels 解析炸=模型下拉静默空，全字段去首尾空白）
	baseConfig.name = formSnapshot.name || sourceName
	baseConfig.apikey = formSnapshot.apikey
	baseConfig.model = formSnapshot.model
	if (isTempEntrySnapshot) {
		// 未知生成器：只写探测到的地址字段，不清理其他键、不写 provider（保留原生成器语义）
		baseConfig[entry.urlField] = formSnapshot.url
	} else {
		// 渠道选中即声明：URL 字段互斥清理 + proxy 渠道写 convert_config.provider（保留其他键）
		CH.applyToConfig(entry, baseConfig, formSnapshot.url)
	}

	try {
		const saveResult = await saveApiSource(sourceName, { generator, config: baseConfig })
		// POST 成功后必须从后端权威读回，不能只凭请求未报错就显示保存成功。
		const persisted = await fetchApiConfig(sourceName)
		assertApiSourceReadback(persisted, { generator, config: baseConfig }, '保存')
		// 保存期间用户若已切换到另一源，不把旧请求结果反向覆盖当前表单。
		if (currentApiName === sourceName && !await loadApiSource(sourceName))
			throw new Error('保存已完成，但界面刷新失败；请重新打开 API 设置')
		const usable = isApiSourceMarkedUsable(saveResult, sourceName)
		showApiStatus(usable ? '✅ 已保存' : '已保存草稿；请补全 API 地址和模型后再次保存。', usable ? 'success' : 'warning')
		_emitApiChanged()
	} catch (err) {
		showApiStatus('❌ ' + err.message, 'error')
	}
}

// ============================================================
// 删除
// ============================================================

async function handleDelete() {
	if (!currentApiName) return
	// T026 凛倾原话：「删除的用户文件是进回收站，同时还需要询问用户是否让api等的数据进回收站还是说直接完全删除，防止留痕」
	const mode = await beiluChoice(
		`删除 API 配置「${currentApiName}」？\n该配置可能包含 API 密钥等敏感数据，请选择删除方式：`,
		[
			{ label: '进回收站（可找回）', value: 'trash', className: 'btn-warning' },
			{ label: '彻底删除（防留痕）', value: 'permanent', className: 'btn-error' },
		],
		{ title: '删除 API 配置' },
	)
	if (!mode) return
	try {
		await deleteApiSource(currentApiName, mode)
		showApiStatus(mode === 'permanent' ? '已彻底删除' : '已移入回收站', 'success')
		currentApiName = null
		await loadApiConfig()
		_emitApiChanged()
	} catch (err) {
		showApiStatus('删除失败: ' + err.message, 'error')
	}
}

// ============================================================
// 新建
// ============================================================

async function handleNew() {
	const name = await beiluPrompt('输入新 API 配置名称：')
	if (!name?.trim()) return
	const safeName = name.trim()

	if (apiSources.includes(safeName)) {
		showApiStatus('该名称已存在', 'error')
		return
	}

	await ensureChannels()
	const entry = getCurrentChannelEntry()
	if (!entry) {
		showApiStatus('请先选择一个 API 渠道', 'error')
		return
	}

	// 新建时以用户当前可见的渠道为准；不把新源隐式写成 proxy。
	let defaultConfig
	try {
		defaultConfig = await fetchConfigTemplate(entry.generator)
	} catch (err) {
		// 新建必须以生成器真实模板为基线；模板链失败时不创建空 config 假成功。
		showApiStatus('无法读取渠道模板，已停止创建: ' + err.message, 'error')
		return
	}
	CH.applyToConfig(entry, defaultConfig, entry.defaultUrl || '')

	try {
		const saveResult = await saveApiSource(safeName, { generator: entry.generator, config: defaultConfig })
		const persisted = await fetchApiConfig(safeName)
		assertApiSourceReadback(persisted, { generator: entry.generator, config: defaultConfig }, '创建')
		currentApiName = safeName
		storage.set(STORAGE_KEY, safeName)
		if (!await loadApiConfig({ preferredName: safeName })) {
			showApiStatus('创建已完成，但界面刷新失败；请重新打开 API 设置。', 'error')
			_emitApiChanged()
			return
		}
		const usable = isApiSourceMarkedUsable(saveResult, safeName)
		showApiStatus(usable ? '✅ 已创建并可用' : '已创建配置草稿；请填写 API 地址、密钥和模型后保存。', usable ? 'success' : 'warning')
		_emitApiChanged()
	} catch (err) {
		showApiStatus('创建失败: ' + err.message, 'error')
	}
}

// ============================================================
// 状态提示
// ============================================================

function showApiStatus(msg, type = 'info') {
	if (!apiStatus) return
	apiStatus.textContent = msg
	const colorClass = type === 'success' ? 'text-success' : type === 'error' ? 'text-error' : 'text-warning'
	apiStatus.className = `text-xs text-center mt-1 ${colorClass}`
	apiStatus.classList.remove('hidden')
	if (type === 'success') {
		setTimeout(() => apiStatus?.classList.add('hidden'), 2000)
	}
}

// ============================================================
// API 渠道表（beilu-chat「API 类型」下拉的单一构建器）
//
// why：2026-07-11 渠道下拉恢复——v5.8 前端重设计谱系把旧 claude/deepseek 选项整合丢失
//   （无删除 commit），且旧前端把选项/URL/文案硬编码成第二份枚举。本模块把「取数」收口：
//   值域/label/默认URL/坑提示全部来自后端 apiAdapters.PROVIDER_META（经 serviceSourceManage
//   providermeta 路由），前端只决定排列顺序与面板级文案，不定义任何渠道数据。
// 语义：「API 类型」= 渠道（凛倾 0711 定调）。除 Google Gemini（原生）→ generator=gemini、
//   Ollama（本地原生）→ generator=ollama 外，其余全为 generator=proxy，选中项即声明 →
//   写 convert_config.provider（后端 resolveProvider 显式声明制，0708 裁决）。
// 功能链：initApiSlot(settingsSlots.mjs) / apiConfig.mjs 面板 → loadChannels() → 下拉构建
//   → 保存 applyToConfig() → serviceSourceManage 落盘 → httpFetch resolveProvider 消费。
// 影响范围：仅 beilu-chat 两个 API 配置面板；serviceSourceManage 完整管理页（display.mjs）
//   走生成器自有 UI，不经此表。
// ============================================================
import { sendAction } from '../../shared/transport/sendAction.mjs'
export { modelsRequestFor } from '/scripts/modelListRequest.mjs'

// 面板级 URL 字段说明文案（属面板措辞非渠道数据；渠道数据一律后端下发）
const URL_LABELS = {
	url: 'API URL（完整端点地址，或中转/反代地址）',
	base_url: 'Base URL（留空使用默认）',
	host: 'Host 地址（Ollama 服务地址）',
}

let _cache = null
let _inflight = null

/**
 * 拉取后端渠道元数据并组装渠道表（进程内缓存一次；失败降级基础两项=0711 前行为，错误进报错系统）。
 * 单飞：initApiConfig 与 loadApiSource/initApiSlot 并发首调时共享同一 promise，防双请求双缓存。
 * @returns {Promise<{channels: Array, byValue: Map, valueFor: Function, applyToConfig: Function}>}
 */
export function loadChannels() {
	if (!_inflight) _inflight = _buildChannels()
	return _inflight
}

async function _buildChannels() {
	if (_cache) return _cache
	let meta = null
	try {
		meta = await sendAction({ verb: 'getProviderMetaQuiet', target: 'shells:serviceSourceManage', source: 'web' })
	} catch (err) {
		window._reportError?.(`[apiChannels] 渠道元数据拉取失败，降级基础渠道表: ${err.message}`, err.stack)
	}
	const channels = []
	const pmeta = meta?.meta || {}
	const penum = Array.isArray(meta?.enum) ? meta.enum : []
	const pushProxy = (provider, labelOverride) => {
		const m = pmeta[provider] || {}
		channels.push({
			// provider="gemini"（OpenAI 兼容端点）与原生 gemini 生成器同名，下拉值错开为 gemini-compat
			value: provider === '' ? 'proxy' : provider === 'gemini' ? 'gemini-compat' : provider,
			label: labelOverride || m.label || provider,
			generator: 'proxy',
			provider,
			urlField: 'url',
			urlLabel: URL_LABELS.url,
			defaultUrl: m.defaultUrl || '',
			hint: m.hint || '',
		})
	}
	if (penum.length) {
		// 排列顺序=0711 预览稿凛倾确认序（纯 UI 排列）；后端新增 provider 未列入时自动补尾不丢项
		pushProxy('', 'OpenAI 兼容（自动检测）')
		for (const p of ['claude', 'deepseek', 'deepseek-r1', 'qwen']) if (penum.includes(p)) pushProxy(p)
		channels.push({
			value: 'gemini', label: 'Google Gemini（原生）', generator: 'gemini', provider: '',
			urlField: 'base_url', urlLabel: URL_LABELS.base_url,
			defaultUrl: meta?.generators?.gemini?.defaultUrl || '', hint: '',
		})
		if (penum.includes('gemini')) pushProxy('gemini')
		for (const p of ['openai', 'openai-reasoning', 'openrouter', 'openrouter-claude']) if (penum.includes(p)) pushProxy(p)
		channels.push({
			value: 'ollama', label: 'Ollama（本地原生）', generator: 'ollama', provider: '',
			urlField: 'host', urlLabel: URL_LABELS.host,
			defaultUrl: meta?.generators?.ollama?.defaultUrl || '', hint: '',
		})
		if (penum.includes('generic')) pushProxy('generic')
		const listed = new Set(['', 'claude', 'deepseek', 'deepseek-r1', 'qwen', 'gemini', 'openai', 'openai-reasoning', 'openrouter', 'openrouter-claude', 'generic'])
		for (const p of penum) if (!listed.has(p)) pushProxy(p)
	} else {
		channels.push({ value: 'proxy', label: 'OpenAI 兼容', generator: 'proxy', provider: '', urlField: 'url', urlLabel: URL_LABELS.url, defaultUrl: '', hint: '' })
		channels.push({ value: 'gemini', label: 'Google Gemini', generator: 'gemini', provider: '', urlField: 'base_url', urlLabel: URL_LABELS.base_url, defaultUrl: '', hint: '' })
	}
	const byValue = new Map(channels.map((c) => [c.value, c]))
	_cache = {
		channels,
		byValue,
		/**
		 * 已保存源 → 下拉值。未知生成器（claude-api/grok/polling…）返回 null，
		 * 调用方追加临时选项且保存时不动 generator/provider（修 0711 前旧病：未知一律强转 proxy=错绑）。
		 */
		valueFor(generator, cfg) {
			if (generator === 'gemini' && byValue.has('gemini')) return 'gemini'
			if (generator === 'ollama' && byValue.has('ollama')) return 'ollama'
			if (generator === 'proxy') {
				const p = cfg?.convert_config?.provider || ''
				if (!p) return 'proxy'
				if (p === 'gemini') return 'gemini-compat'
				return byValue.has(p) ? p : 'proxy'
			}
			return null
		},
		/** 按选中渠道写配置：URL 字段互斥清理 + proxy 渠道写 provider 声明（保留 convert_config 其他键） */
		applyToConfig(entry, baseCfg, urlValue) {
			for (const f of ['url', 'base_url', 'host']) if (f !== entry.urlField) delete baseCfg[f]
			// 0714 trim 根修（凛倾「子模式不自动请求模型」案）：粘贴带前导空格的 URL 落盘后，
			//   后端 getModels `url.startsWith("http")` 判假 → 强拼 https:// 前缀 → new URL 必炸
			//   → success:false → 前端下拉静默空（实证：claude 源 " http://localhost:3456/v1"）。
			//   写点统一 trim，脏值不落盘。
			baseCfg[entry.urlField] = String(urlValue ?? '').trim()
			if (entry.generator === 'proxy')
				baseCfg.convert_config = { ...(baseCfg.convert_config || {}), provider: entry.provider }
			return baseCfg
		},
	}
	return _cache
}

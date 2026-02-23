/* global geti18n */

let last_apikey = ''
let last_base_url = ''

/**
 * 检测 base_url 是否为非 Google 官方域名（即反代/中转地址）
 * @param {string} url - base_url 值
 * @returns {boolean} 是否为反代地址
 */
const isProxyUrl = (url) => {
	if (!url) return false
	try {
		const hostname = new URL(url).hostname
		// Google 官方域名
		return !hostname.endsWith('.googleapis.com') && !hostname.endsWith('.google.com')
	} catch {
		return true // 解析失败的 URL 也视为非官方
	}
}

return async ({ data, containers }) => {
	const div = containers.generatorDisplay
	const { apikey, base_url } = data
	if (!apikey) {
		div.innerHTML = /* html */ '<div class="text-warning" data-i18n="serviceSource_manager.common_config_interface.apiKeyRequired"></div>'
		return
	}

	if (apikey === last_apikey && (base_url || '') === (last_base_url || '')) return
	last_apikey = apikey
	last_base_url = base_url || ''

	// 反代/中转地址红色警告
	const proxyWarning = isProxyUrl(base_url) ? /* html */ `\
<div style="background: #dc262615; border: 2px solid #dc2626; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px;">
  <div style="color: #dc2626; font-weight: bold; font-size: 14px; margin-bottom: 6px;">⚠️ 检测到反代/中转地址</div>
  <div style="color: #dc2626; font-size: 13px; line-height: 1.5;">
    使用反代/中转站时请选择「<b>OpenAI 自定义</b>」类型配置 API，而非 Gemini 类型。<br/>
    Gemini 类型仅适用于直连 Google API（使用官方 API Key）。<br/>
    <span style="opacity: 0.8;">反代地址请填入 OpenAI 自定义的 URL 中，格式如：<code style="background:#dc262620; padding:2px 4px; border-radius:3px;">http://127.0.0.1:7861/v1/chat/completions</code></span>
  </div>
</div>
` : ''

	div.innerHTML = proxyWarning + /* html */ '<div data-i18n="serviceSource_manager.common_config_interface.loadingModels"></div>'

	try {
		const { GoogleGenAI } = await import('https://esm.sh/@google/genai')

		const ai = new GoogleGenAI({
			apiKey: apikey,
			httpOptions: base_url ? {
				baseUrl: base_url
			} : undefined
		})

		const modelInfo = await ai.models.list()
		const models = []

		for await (const model of modelInfo)
			models.push(model.name)

		const model_ids = models.map(m => m.replace(/^models\//, '')).sort()
		const copied_text = geti18n('serviceSource_manager.common_config_interface.copied')
		div.innerHTML = /* html */ `\
<h3 class="text-lg font-semibold" data-i18n="serviceSource_manager.common_config_interface.availableModels"></h3>
<p class="text-sm opacity-70" data-i18n="serviceSource_manager.common_config_interface.copyModelIdTooltip"></p>
<div class="flex flex-wrap gap-2 mt-2">
${model_ids.map(id => /* html */ `\
<code class="p-1 bg-base-300 rounded cursor-pointer hover:bg-primary hover:text-primary-content" title="${geti18n('serviceSource_manager.common_config_interface.copyModelIdTooltip')}" onclick="navigator.clipboard.writeText('${id}'); this.innerText='${copied_text}'; setTimeout(()=>this.innerText='${id}', 1000)">${id}</code>
`
	).join('')
}
</div>
`
	}
	catch (error) {
		console.error('Failed to fetch models:', error)
		div.innerHTML = /* html */ `
<div class="text-error" style="overflow-wrap: break-word;">${geti18n('serviceSource_manager.common_config_interface.loadModelsFailed', { message: error.message })}</div>
`
	}
}

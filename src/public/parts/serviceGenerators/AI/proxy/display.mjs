/* global geti18n */

let last_url = ''
let last_apikey = ''
/**
 * 规范化 URL。
 * @param {string} url - URL。
 * @returns {string|null} 规范化的 URL。
 */
const normalizeUrl = url => {
	let urlObj
	try {
		urlObj = new URL(url)
	}
	catch {
		if (!url.startsWith('http'))
			try {
				urlObj = new URL('https://' + url)
			}
			catch {
				try {
					urlObj = new URL('http://' + url)
				}
				catch {
					return null
				}
			}
		else return null
	}
	if (urlObj.pathname.includes('/chat/completions'))
		urlObj.pathname = urlObj.pathname.replace(/\/chat\/completions.*$/, '/models')
	else {
		let path = urlObj.pathname

		if (path.endsWith('/')) path = path.slice(0, -1)

		if (path.endsWith('/v1'))
			urlObj.pathname = path + '/models'
		else
			urlObj.pathname = path + '/v1/models'
	}

	return urlObj.toString()
}
return async ({ data, containers, editors }) => {
	console.log('[proxy/display] Rendering...', { url: data.url, model: data.model })
	const div = containers.generatorDisplay
	const { url, apikey, model } = data
	if (!url) {
		console.log('[proxy/display] No URL provided')
		return div.innerHTML = ''
	}
	const modelsUrl = normalizeUrl(url)
	if (!modelsUrl) {
		console.log('[proxy/display] Invalid URL')
		return div.innerHTML = ''
	}
	
	console.log('[proxy/display] Models URL:', modelsUrl)

	// 如果 URL/Key 没变，但 model 变了，尝试更新 select 的选中状态（如果 select 存在）
	if (modelsUrl === last_url && apikey === last_apikey) {
		console.log('[proxy/display] URL/Key unchanged, updating select value only')
		const select = div.querySelector('#model-picker')
		if (select && model) {
			select.value = model
		}
		return
	}

	last_url = modelsUrl
	last_apikey = apikey
	div.innerHTML = /* html */ '<div data-i18n="serviceSource_manager.common_config_interface.loadingModels">Loading models...</div>'
	try {
		console.log('[proxy/display] Fetching models...')
		let models = []
		
		// 1. 尝试直接请求 (Direct Fetch)
		try {
			const response = await fetch(modelsUrl, {
				headers: { Authorization: apikey ? 'Bearer ' + apikey : undefined }
			})
			if (response.ok) {
				const result = await response.json()
				models = result.data || result
			} else {
				throw new Error(`Direct fetch failed: ${response.status}`)
			}
		} catch (directError) {
			console.warn('[proxy/display] Direct fetch failed, trying proxy...', directError)
			
			// 2. 尝试通过 beilu-memory 代理请求 (Proxy Fetch)
			// 这是一个 fallback 机制，用于解决 CORS 问题
			try {
				const proxyResp = await fetch('/api/parts/plugins:beilu-memory/config/setdata', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						_action: 'getModels',
						apiConfig: { url: url, key: apikey } // 使用原始 url，后端会处理
					})
				})
				if (proxyResp.ok) {
					const proxyResult = await proxyResp.json()
					if (proxyResult.success && Array.isArray(proxyResult.models)) {
						// 构造符合格式的对象数组
						models = proxyResult.models.map(id => ({ id }))
					} else {
						throw new Error(proxyResult.error || 'Proxy returned invalid data')
					}
				} else {
					throw new Error(`Proxy fetch failed: ${proxyResp.status}`)
				}
			} catch (proxyError) {
				console.error('[proxy/display] Proxy fetch also failed:', proxyError)
				// 抛出原始错误或代理错误
				throw new Error(`Failed to fetch models (CORS/Network): ${directError.message}`)
			}
		}

		if (!Array.isArray(models))
			throw new Error('Response is not an array of models.')

		const model_ids = models.map(m => m.id).sort()
		const copied_text = geti18n('serviceSource_manager.common_config_interface.copied')
		
		const prefillChecked = data.convert_config?.prefill_enabled ? 'checked' : ''
		const claudePrefillChecked = data.convert_config?.claude_prefill_enabled ? 'checked' : ''
		const currentPostProcessing = data.convert_config?.prompt_post_processing || 'none'
		div.innerHTML = /* html */ `\
<h3 class="text-lg font-semibold" data-i18n="serviceSource_manager.common_config_interface.availableModels"></h3>
<div class="form-control w-full max-w-xs mb-4">
		<label class="label">
		  <span class="label-text">选择模型 (Select Model)</span>
		</label>
		<select id="model-picker" class="select select-bordered">
		  <option disabled selected value="">请选择...</option>
		  ${model_ids.map(id => `<option value="${id}" ${id === model ? 'selected' : ''}>${id}</option>`).join('')}
		</select>
</div>
<div class="divider my-2"></div>
<h4 class="text-md font-semibold mb-2">预填充 & 后处理</h4>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label cursor-pointer justify-start gap-3">
		  <input type="checkbox" id="prefill-toggle" class="toggle toggle-sm toggle-primary" ${prefillChecked} />
		  <span class="label-text">通用预填充</span>
		</label>
		<p class="text-xs opacity-50 ml-1 mt-1">开启：预设尾部 assistant 条目以 assistant 身份发送（预填充）。关闭：转为 system 身份。</p>
</div>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label cursor-pointer justify-start gap-3">
		  <input type="checkbox" id="claude-prefill-toggle" class="toggle toggle-sm toggle-primary" ${claudePrefillChecked} />
		  <span class="label-text">Claude 预填充</span>
		</label>
		<p class="text-xs opacity-50 ml-1 mt-1">启用时自动切换后处理为严格模式。</p>
</div>
<div class="form-control w-full max-w-xs mb-2">
		<label class="label">
		  <span class="label-text">提示词后处理</span>
		</label>
		<select id="post-processing-select" class="select select-sm select-bordered w-full">
		  <option value="none" ${currentPostProcessing === 'none' ? 'selected' : ''}>无</option>
		  <option value="merge" ${currentPostProcessing === 'merge' ? 'selected' : ''}>合并相同角色连续发言</option>
		  <option value="semi" ${currentPostProcessing === 'semi' ? 'selected' : ''}>半严格（合并+system转user交替）</option>
		  <option value="strict" ${currentPostProcessing === 'strict' ? 'selected' : ''}>严格（合并+user在前+system仅一条）</option>
		</select>
		<p class="text-xs opacity-50 ml-1 mt-1">部分API要求严格角色交替，按需选择。</p>
</div>
<div class="divider my-2"></div>
<p class="text-sm opacity-70" data-i18n="serviceSource_manager.common_config_interface.copyModelIdTooltip"></p>
<div class="flex flex-wrap gap-2 mt-2">
${model_ids.map(id => /* html */ `\
<code class="p-1 bg-base-300 rounded cursor-pointer hover:bg-primary hover:text-primary-content" title="${geti18n('serviceSource_manager.common_config_interface.copyModelIdTooltip')}" onclick="navigator.clipboard.writeText('${id}'); this.innerText='${copied_text}'; setTimeout(()=>this.innerText='${id}', 1000)">${id}</code>
`
	).join('')
}
</div>
`
		// 绑定 change 事件
		const select = div.querySelector('#model-picker')
		if (select && editors && editors.json) {
			select.addEventListener('change', (e) => {
				const newModel = e.target.value
				if (!newModel) return
				
				try {
					let currentContent = editors.json.get()
					let currentJson = currentContent.json || (currentContent.text ? JSON.parse(currentContent.text) : {})
					currentJson.model = newModel
					if (editors.json.update) editors.json.update({ json: currentJson })
					else editors.json.set({ json: currentJson })
					console.log('[proxy/display] Model updated to:', newModel)
				} catch (err) {
					console.error('Failed to update model in editor:', err)
				}
			})
		}

		// 绑定提示词后处理下拉框
		const postProcessSelect = div.querySelector('#post-processing-select')
		if (postProcessSelect && editors && editors.json) {
			postProcessSelect.addEventListener('change', (e) => {
				updateConvertConfig('prompt_post_processing', e.target.value)
			})
		}

		// 辅助函数：更新 convert_config 中的字段
		const updateConvertConfig = (key, value) => {
			if (!editors?.json) return
			try {
				let currentContent = editors.json.get()
				let currentJson = currentContent.json || (currentContent.text ? JSON.parse(currentContent.text) : {})
				if (!currentJson.convert_config) currentJson.convert_config = {}
				currentJson.convert_config[key] = value
				if (editors.json.update) editors.json.update({ json: currentJson })
				else editors.json.set({ json: currentJson })
				console.log(`[proxy/display] ${key}:`, typeof value === 'string' ? (value.length > 50 ? value.slice(0, 50) + '...' : value) : value)
			} catch (err) {
				console.error(`Failed to update ${key} in editor:`, err)
			}
		}

		// 绑定通用预填充开关
		const prefillToggle = div.querySelector('#prefill-toggle')
		if (prefillToggle) {
			prefillToggle.addEventListener('change', (e) => {
				updateConvertConfig('prefill_enabled', e.target.checked)
			})
		}

		// 绑定 Claude 预填充开关
		const claudePrefillToggle = div.querySelector('#claude-prefill-toggle')
		if (claudePrefillToggle) {
			claudePrefillToggle.addEventListener('change', (e) => {
				updateConvertConfig('claude_prefill_enabled', e.target.checked)
				// Claude 预填充启用时自动切换后处理为严格模式
				if (e.target.checked && postProcessSelect) {
					if (postProcessSelect.value !== 'strict' && postProcessSelect.value !== 'semi') {
						postProcessSelect.value = 'strict'
						updateConvertConfig('prompt_post_processing', 'strict')
					}
				}
			})
		}
	}
	catch (error) {
		console.error('Failed to fetch models:', error)
		div.innerHTML = /* html */ `
<div class="alert alert-error shadow-lg">
  <div>
    <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current flex-shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    <span>${geti18n('serviceSource_manager.common_config_interface.loadModelsFailed', { message: error.message })}</span>
  </div>
</div>
`
	}
}

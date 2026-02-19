import info from './info.json' with { type: 'json' }

// ============================================================
// 系统信息收集
// ============================================================

/**
 * 获取当前系统信息
 * @returns {Object} 系统信息对象
 */
function collectSystemInfo() {
	const now = new Date()

	const sysInfo = {
		// 时间信息
		datetime: now.toISOString(),
		localDate: now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
		localTime: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		timestamp: now.getTime(),

		// 运行环境 (Deno)
		runtime: typeof Deno !== 'undefined' ? 'Deno' : typeof process !== 'undefined' ? 'Node.js' : 'Browser',
	}

	// Deno 环境特有信息
	if (typeof Deno !== 'undefined') {
		try {
			sysInfo.os = Deno.build?.os || 'unknown'
			sysInfo.arch = Deno.build?.arch || 'unknown'
			sysInfo.denoVersion = Deno.version?.deno || 'unknown'
			sysInfo.hostname = (() => { try { return Deno.hostname() } catch { return 'unknown' } })()
			sysInfo.cwd = (() => { try { return Deno.cwd() } catch { return 'unknown' } })()
			sysInfo.homeDir = (() => {
				try {
					return Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || 'unknown'
				} catch { return 'unknown' }
			})()
			sysInfo.username = (() => {
				try {
					return Deno.env.get('USER') || Deno.env.get('USERNAME') || 'unknown'
				} catch { return 'unknown' }
			})()
			sysInfo.memoryUsage = (() => {
				try {
					const mem = Deno.memoryUsage()
					return {
						rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
						heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
						heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
					}
				} catch { return null }
			})()
		} catch {
			// 权限不足时静默处理
		}
	}

	return sysInfo
}

/**
 * 格式化系统信息为注入文本
 * @param {Object} sysInfo - 系统信息对象
 * @param {Object} options - 格式选项
 * @returns {string} 格式化后的文本
 */
function formatSystemInfo(sysInfo, options = {}) {
	const { includeTime = true, includeOS = true, includeMemory = false, customFields = [] } = options

	let text = '[System Context]\n'

	if (includeTime) {
		text += `Current Time: ${sysInfo.localDate} ${sysInfo.localTime}\n`
		text += `Timezone: ${sysInfo.timezone}\n`
	}

	if (includeOS) {
		if (sysInfo.os) text += `OS: ${sysInfo.os} (${sysInfo.arch || 'unknown'})\n`
		if (sysInfo.hostname && sysInfo.hostname !== 'unknown') text += `Hostname: ${sysInfo.hostname}\n`
		if (sysInfo.username && sysInfo.username !== 'unknown') text += `Username: ${sysInfo.username}\n`
	}

	if (includeMemory && sysInfo.memoryUsage) {
		text += `Memory: RSS ${sysInfo.memoryUsage.rss}, Heap ${sysInfo.memoryUsage.heapUsed}/${sysInfo.memoryUsage.heapTotal}\n`
	}

	// 自定义字段
	for (const field of customFields) {
		if (field.key && field.value) {
			text += `${field.key}: ${field.value}\n`
		}
	}

	return text
}

// ============================================================
// 插件数据
// ============================================================

let pluginData = {
	enabled: true,
	includeTime: true,
	includeOS: true,
	includeMemory: false,
	customFields: [],  // { key: string, value: string }[]
	refreshInterval: 0, // 0 = 每次生成时刷新，>0 = 缓存秒数
	_cachedInfo: null,
	_cachedAt: 0,
}

// ============================================================
// beilu-sysinfo 插件导出
// ============================================================

/**
 * beilu-sysinfo 插件 — 系统信息注入
 *
 * 职责：
 * - 收集运行环境信息 (OS、时间、用户名等)
 * - GetPrompt: 将系统上下文注入到提示词中
 * - 让 AI 知道当前运行环境，以便更好地执行文件操作等任务
 */
export default {
	info,
	Load: async () => {},
	Unload: async () => {},
	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginData.enabled,
				includeTime: pluginData.includeTime,
				includeOS: pluginData.includeOS,
				includeMemory: pluginData.includeMemory,
				customFields: pluginData.customFields,
				refreshInterval: pluginData.refreshInterval,
				// 提供当前系统信息预览
				_preview: formatSystemInfo(collectSystemInfo(), pluginData),
				_currentInfo: collectSystemInfo(),
			}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						case 'addCustomField': {
							pluginData.customFields.push({
								key: data.field?.key || '',
								value: data.field?.value || '',
							})
							break
						}
						case 'removeCustomField': {
							pluginData.customFields = pluginData.customFields.filter(
								(_, i) => i !== data.index
							)
							break
						}
						case 'refreshCache': {
							pluginData._cachedInfo = null
							pluginData._cachedAt = 0
							break
						}
						default:
							break
					}
					return
				}

				if (data.enabled !== undefined) pluginData.enabled = data.enabled
				if (data.includeTime !== undefined) pluginData.includeTime = data.includeTime
				if (data.includeOS !== undefined) pluginData.includeOS = data.includeOS
				if (data.includeMemory !== undefined) pluginData.includeMemory = data.includeMemory
				if (data.customFields !== undefined) pluginData.customFields = data.customFields
				if (data.refreshInterval !== undefined) pluginData.refreshInterval = data.refreshInterval
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入系统上下文信息
			 */
			GetPrompt: async (arg) => {
				if (!pluginData.enabled) return null

				// 检查缓存
				let sysInfo
				const now = Date.now()
				if (
					pluginData.refreshInterval > 0 &&
					pluginData._cachedInfo &&
					(now - pluginData._cachedAt) < pluginData.refreshInterval * 1000
				) {
					sysInfo = pluginData._cachedInfo
				} else {
					sysInfo = collectSystemInfo()
					pluginData._cachedInfo = sysInfo
					pluginData._cachedAt = now
				}

				const text = formatSystemInfo(sysInfo, {
					includeTime: pluginData.includeTime,
					includeOS: pluginData.includeOS,
					includeMemory: pluginData.includeMemory,
					customFields: pluginData.customFields,
				})

				return {
					text,
					role: 'system',
					name: 'beilu-sysinfo',
				}
			},
		},
	},
}
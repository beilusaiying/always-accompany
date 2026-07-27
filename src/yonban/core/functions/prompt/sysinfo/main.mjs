// [yonban T3d 迁移] 实现体从 plugins/beilu-sysinfo/main.mjs 迁入 functions/prompt/sysinfo/main.mjs（5 级到 src）。
//   纯搬家零逻辑改动。info.json 留旧位指回；wbStub server 5 级。配置持久化=data/beilu-sysinfo-settings.json（相对路径锚 CWD，0710 补）。
import info from '../../../../../public/parts/plugins/beilu-sysinfo/info.json' with { type: 'json' }
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { authenticate } from "../../security/auth.mjs"; // config REST 端点鉴权（范式同 memory/main.mjs）
import { getInjectText, fillInjectText } from "../../injectTexts/main.mjs"; // 注入文本单源（铁律：进 messages 的文本用户可配置，代码只持默认值——默认值在 injectTexts CATALOG）

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

	// 各行文案走 injectTexts 单源（sysinfo.* 键）；条件开关/结构换行留代码（机制），文字归用户可配置域
	let text = getInjectText('sysinfo.header') + '\n'

	if (includeTime) {
		text += fillInjectText('sysinfo.line_time', { date: sysInfo.localDate, time: sysInfo.localTime }) + '\n'
		text += fillInjectText('sysinfo.line_timezone', { tz: sysInfo.timezone }) + '\n'
	}

	if (includeOS) {
		if (sysInfo.os) text += fillInjectText('sysinfo.line_os', { os: sysInfo.os, arch: sysInfo.arch || 'unknown' }) + '\n'
		if (sysInfo.hostname && sysInfo.hostname !== 'unknown') text += fillInjectText('sysinfo.line_hostname', { hostname: sysInfo.hostname }) + '\n'
		if (sysInfo.username && sysInfo.username !== 'unknown') text += fillInjectText('sysinfo.line_username', { username: sysInfo.username }) + '\n'
	}

	if (includeMemory && sysInfo.memoryUsage) {
		text += fillInjectText('sysinfo.line_memory', { rss: sysInfo.memoryUsage.rss, heapUsed: sysInfo.memoryUsage.heapUsed, heapTotal: sysInfo.memoryUsage.heapTotal }) + '\n'
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
// 持久化（0710 断链修复：原 pluginData 纯内存，前端「保存配置」重启即丢——UI 语义与行为矛盾）
//   范式照 beilu-files PERSIST_FILE（相对路径锚 CWD=项目根；防抖写；损坏/缺失静默用默认）。
//   sysinfo 无凭据字段且全局单例（Load 注释「不消费身份」），单文件全局桶即可，不做 per-user。
// ============================================================
const PERSIST_FILE = 'data/beilu-sysinfo-settings.json'
const PERSIST_KEYS = ['enabled', 'includeTime', 'includeOS', 'includeMemory', 'customFields', 'refreshInterval']
let _persistTimer = null
function _savePersisted() {
	if (typeof Deno === 'undefined') return
	if (_persistTimer) clearTimeout(_persistTimer)
	_persistTimer = setTimeout(async () => {
		_persistTimer = null
		try {
			const out = {}
			for (const k of PERSIST_KEYS) out[k] = pluginData[k]
			await Deno.mkdir('data', { recursive: true }).catch(() => {})
			await Deno.writeTextFile(PERSIST_FILE, JSON.stringify(out, null, 2))
		} catch (err) {
			console.warn('[beilu-sysinfo] 持久化设置失败:', err.message)
		}
	}, 100)
}
async function _loadPersisted() {
	if (typeof Deno === 'undefined') return
	try {
		const saved = JSON.parse(await Deno.readTextFile(PERSIST_FILE))
		for (const k of PERSIST_KEYS) if (saved[k] !== undefined) pluginData[k] = saved[k]
	} catch { /* 首装无文件/损坏 → 默认值 */ }
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
const pluginExport = {
	info,
	Load: async ({ router } = {}) => {
		// config REST 自注册（范式=memory/main.mjs Load）：parts_loader:787 传 part 作用域 router，
		// 前端 settings 槽位(settingsSlots.mjs initSysinfoConfigSlot)走 /api/parts/plugins:beilu-sysinfo/config/*——
		// 此前 Load 为空=端点从未注册，前端恒 404。单源复用 interfaces.config（不消费身份，pluginData 全局单例）。
		await _loadPersisted()
		if (!router) return
		router.get(/\/config\/getdata$/, authenticate, async (req, res) => {
			try { res.json(await pluginExport.interfaces.config.GetData()) }
			catch (err) { res.status(500).json({ error: err.message }) }
		})
		router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
			try {
				await pluginExport.interfaces.config.SetData(req.body)
				res.json({ success: true })
			} catch (err) { res.status(500).json({ error: err.message }) }
		})
	},
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
							_savePersisted()
							break
						}
						case 'removeCustomField': {
							pluginData.customFields = pluginData.customFields.filter(
								(_, i) => i !== data.index
							)
							_savePersisted()
							break
						}
						case 'refreshCache': {
							// 只清运行时缓存，不动配置——不落盘
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
				_savePersisted()
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入系统上下文信息
			 */
			GetPrompt: async (arg) => {
				const _cid = arg?.chatid || arg?.chat_name?.replace('common_chat_', '') || null
				wbT(_cid, 'sysinfo:getprompt', 'enter', { enabled: pluginData.enabled })
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
					wbT(_cid, 'sysinfo:getprompt/gather', 'cache_hit', { ageMs: now - pluginData._cachedAt })
				} else {
					wbT(_cid, 'sysinfo:getprompt/gather', 'collect_start', { refreshInterval: pluginData.refreshInterval })
					sysInfo = collectSystemInfo()
					pluginData._cachedInfo = sysInfo
					pluginData._cachedAt = now
					wbT(_cid, 'sysinfo:getprompt/gather', 'collect_done', { runtime: sysInfo?.runtime, hasOs: !!sysInfo?.os, fieldCount: sysInfo ? Object.keys(sysInfo).length : 0 })
				}

				wbD(_cid, 'sysinfo:getprompt/gather', 'sysinfo_present', !!sysInfo, '系统信息采集为空', { isNull: sysInfo == null })
				if (pluginData.includeTime) wbD(_cid, 'sysinfo:getprompt/gather', 'time_field', !!(sysInfo && sysInfo.localTime), '时间字段缺失', { localTime: sysInfo?.localTime })
				if (pluginData.includeOS) wbD(_cid, 'sysinfo:getprompt/gather', 'os_field', !!(sysInfo && sysInfo.os), 'OS字段缺失', { os: sysInfo?.os })

				const text = formatSystemInfo(sysInfo, {
					includeTime: pluginData.includeTime,
					includeOS: pluginData.includeOS,
					includeMemory: pluginData.includeMemory,
					customFields: pluginData.customFields,
				})

				wbD(_cid, 'sysinfo:getprompt/inject', 'text_built', !!(text && text.length), '注入文本为空', { len: text ? text.length : 0, customFields: pluginData.customFields?.length || 0 })

				// [0727 契约修] text 契约=数组[{content,important}]（decl/prompt_struct.ts，全部下游按数组 .sort 消费）。
				//   原返回裸字符串——fake-send 的 change-prompt build_prompt 分支炸 "plugin.sort is not a function"
				//   （0727 实证），且 beilu-airp 注释自认照抄本处=错误形状被复制。空文本给空数组不给空串元素。
				return {
					text: text ? [{ content: text, important: 0 }] : [],
					role: 'system',
					name: 'beilu-sysinfo',
				}
			},
		},
	},
}

export default pluginExport
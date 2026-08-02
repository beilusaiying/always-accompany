/**
 * beilu-era — ERA 文字画引擎插件（自包含，凛倾 0801「提取插件放到外部,独立的」）。
 *
 * 分层：
 *   py/era_pipeline.py = 管线唯一权威（解析→布局→落盘→摘要），Python CLI 可独立运行。
 *   core.mjs = JS→Python 薄桥（spawnSync）+ 显示态剥标签。
 *   mapStore.mjs = 只读侧（GetRenderView 读盘）。
 *   capabilities.mjs = 能力谱三层合并。
 *   本文件 = 集成层：per-user config + REST 路由(auth) + setDefaultPart 自注册 + chat 接口薄包装。
 *
 * 框架接触点（auth/parts_loader）只住本文件，不下渗核心。
 */
import fs from 'node:fs'
import { dirname } from 'node:path'
import info from './info.json' with { type: 'json' }
import { resolveEffectiveEra } from './capabilities.mjs'
import { loadMap, listMapIds, getActiveId } from './mapStore.mjs'
import { processEraContent, hideEraCommands, regenerateAllSummaries, eraDataRoot, eraConfigFileFor } from './core.mjs'
import { authenticate, getUserByReq } from '../../../../yonban/core/functions/security/auth.mjs'
import { setDefaultPart } from '../../../../server/parts_loader.mjs'

// ============================================================
// per-user 配置
// ============================================================

function configFileFor(username) {
	return eraConfigFileFor(username)
}

function nicerWriteFileSync(file, text) {
	const tmp = file + '.tmp'
	fs.writeFileSync(tmp, text, 'utf-8')
	fs.renameSync(tmp, file)
}

function saveConfigToDisk(username, data) {
	try {
		const f = configFileFor(username)
		const dir = dirname(f)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		nicerWriteFileSync(f, JSON.stringify(data, null, 2), 'utf-8')
	} catch (e) {
		console.warn('[beilu-era] 保存配置失败:', e.message)
	}
}

function loadConfigFromDisk(username) {
	try {
		const f = configFileFor(username)
		if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'))
	} catch (e) {
		console.warn('[beilu-era] 读取配置失败:', e.message)
	}
	return null
}

function _freshStore() {
	return { enabled: false, config: {} }
}

const perUserStore = new Map()

function _normUser(username) {
	return (typeof username === 'string' && username) ? username : '_default'
}

function getStore(username) {
	const key = _normUser(username)
	let data = perUserStore.get(key)
	if (data) return data
	data = _freshStore()
	perUserStore.set(key, data)
	try {
		const saved = loadConfigFromDisk(key)
		if (saved && typeof saved === 'object') {
			if (typeof saved.enabled === 'boolean') data.enabled = saved.enabled
			if (saved.config && typeof saved.config === 'object' && !Array.isArray(saved.config)) data.config = saved.config
		}
	} catch (e) {
		console.warn(`[beilu-era] getStore("${key}") 首访加载失败:`, e.message)
	}
	return data
}

// ============================================================
// 插件导出
// ============================================================

const pluginExport = {
	info,
	Load: async ({ username, router }) => {
		console.log('[beilu-era] 插件加载中...')
		// 暂停自注册：代码质量待审，不作为功能发布（凛倾 0802）
		// if (username) {
		// 	setDefaultPart(username, 'plugins', 'beilu-era')
		// }
		router.get('/api/parts/plugins\\:beilu-era/config/getdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				res.json(await pluginExport.interfaces.config.GetData({ username: _u }))
			} catch (err) {
				console.error('[beilu-era] GetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})
		router.post('/api/parts/plugins\\:beilu-era/config/setdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				res.json(await pluginExport.interfaces.config.SetData(req.body, { username: _u }) || { success: true })
			} catch (err) {
				console.error('[beilu-era] SetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: async () => {
		console.log('[beilu-era] 插件卸载')
	},
	interfaces: {
		config: {
			GetData: async (ctx) => {
				const store = getStore(ctx?.username)
				const capabilities = resolveEffectiveEra(eraDataRoot(), store.config)
				return {
					enabled: store.enabled,
					config: store.config,
					capabilities,
					meta: [
						{ key: 'enabled', group: '基础设置', type: 'toggle', label: '启用 ERA 渲染', desc: 'AI 给拓扑 → 算法排几何 → 符号地图渲染与持久化' },
					],
				}
			},
			SetData: async (data, args) => {
				if (!data || typeof data !== 'object') return
				const _user = _normUser(args?.username)
				const store = getStore(_user)
				if (typeof data.enabled === 'boolean') store.enabled = data.enabled
				if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) store.config = data.config
				saveConfigToDisk(_user, store)
				regenerateAllSummaries(_user, resolveEffectiveEra(eraDataRoot(), store.config), store.enabled)
				return { success: true }
			},
		},

		chat: {
			GetPrompt: async () => ({ text: [], additional_chat_log: [], extension: {} }),

			ReplyHandler: (result, request) => {
				const store = getStore(request?.username)
				if (!store.enabled) return false
				const content = result?.content
				if (!content || typeof content !== 'string') return false
				if (!/<era-(map|patch|ui)\b/.test(content)) return false

				const { touched, errors } = processEraContent(content, {
					username: _normUser(request?.username),
					charName: request?.char_id || '_global',
					caps: resolveEffectiveEra(eraDataRoot(), store.config),
					enabled: store.enabled,
				})

				if (touched || errors.length) {
					result.extension = result.extension || {}
					result.extension.era_map = { ...(touched || {}), ...(errors.length ? { errors } : {}) }
				}

				result.content_for_show = hideEraCommands(result.content_for_show || content)
				result.content_for_edit = result.content_for_edit || content
				return false
			},

			GetRenderView: (arg) => {
				const store = getStore(arg?.username)
				if (!store.enabled) return { caps: null, map: null, activeId: null, mapIds: [] }
				const username = _normUser(arg?.username)
				const charName = arg?.char_id || '_global'
				const caps = resolveEffectiveEra(eraDataRoot(), store.config)
				const activeId = getActiveId(username, charName)
				const map = activeId ? loadMap(username, charName, activeId) : null
				return { caps, map, activeId, mapIds: listMapIds(username, charName) }
			},
		},
	},
}

export default pluginExport

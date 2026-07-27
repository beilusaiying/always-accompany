/**
 * beilu-airp — AIRP 符号渲染插件后端。
 *
 * 职责（三条链）：
 *   - config 链：AIRP 渲染配置（配色谱/DSL标签集/动态效果开关/自适应参数）per-user 持久化 + REST 端点
 *     /api/parts/plugins:beilu-airp/config/{getdata,setdata}（设置面板读写用，见 Load :146/:158）。
 *   - 生成链：interfaces.chat.GetPrompt（注入 dslGuide + 累积态）/ ReplyHandler（解析 <airp-patch> 写数值态）。
 *     经 Load 内 setDefaultPart 自注册进 defaultParts 才会被生成链遍历到。
 *   - 渲染链：interfaces.chat.GetRenderView（渲染期视图，产物只进 DOM 不进 chatLog/messages）。
 *
 * 存储：per-user 分桶 data/users/<user>/airp/config.json（照 beilu-regex T077 per-user 范式，防跨用户串台）。
 *   config 只存 per-user 个人差异，消费时叠加在出厂谱上（capabilities.mjs resolveEffectiveAirp 单源）；
 *   不硬编码任何进对话链的文本（凛倾铁律：参数可配置，代码只持默认值）。
 *
 * 链路（两条前端入口，勿混）：
 *   配置读写：设置面板 → /api/parts/plugins:beilu-airp/config/{getdata,setdata} → interfaces.config.{GetData,SetData}
 *   渲染取数：displayRegex.loadAirpCaps → sendAction shells:chat#getAirpView
 *     → GET /api/parts/shells:chat/{chatid}/airp/view（endpoints.mjs:1540，shell 层取可见 chat_log 单源）
 *     → loadPart → interfaces.chat.GetRenderView → {caps, blocks}
 *   [框架 v6 §十一章4] 前端渲染取数不走 plugins:beilu-airp 直连（sendAction 无该 target 路由，属设计非遗漏）。
 *
 * 相范式：beilu-regex/main.mjs（getStore/configFileFor/_normUser/saveConfigToDisk 同型，per-user 惰性桶）。
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import info from '../../../../public/parts/plugins/beilu-airp/info.json' with { type: 'json' } // part 元数据留 parts 目录（GetPartPath 硬映射范式，同 regex info 留原位）
import { nicerWriteFileSync } from '../../../../scripts/nicerWriteFile.mjs'
// [per-user] 用户数据目录权威范式（与 regex T077 / preset T065 / worldbook T074 同款 getUserDataDir）
// __projectRoot：项目根权威单源（storage.mjs:67 导出）——仅在函数体内(GetData 运行时)读，不在模块顶层读，避开 TDZ(storage.mjs:37 警告的 0722 事故)。
import { getUserDataDir, __projectRoot } from '../memory/storage_mod/storage.mjs'
// [能力谱单源] 配色/标签集/动态效果/自适应默认的唯一出厂来源；本文件 config 只存 per-user 个人差异，消费时叠加在谱上。
import { resolveEffectiveAirp } from './capabilities.mjs'
// [数值状态机] 确定性 JS 层：解析 <airp-patch> 指令 / 累积状态 / 剥显示态。数值不交 LLM，可复现(第3章)。
import { parseAirpCommands, accumulateAirpState, hideAirpCommands } from './stateMachine.mjs'
// HTTP 端点鉴权 + 身份解析（authenticate 未认证→401；getUserByReq→username），与 regex/preset REST 薄壳同型
import { authenticate, getUserByReq } from '../security/auth.mjs'
// [进生成链] 自注册进 defaultParts，使 requestBuilder(defaultPluginNames 遍历:91) 把 airp 纳入插件链 → GetReply 内调 interfaces.chat.ReplyHandler。
//   照 beilu-mvu/main.mjs:24+539 范式：Load 时 setDefaultPart(username,"plugins","beilu-airp")。缺此=airp 的 ReplyHandler/GetPrompt 永不被生成链调用。
import { setDefaultPart } from '../../../../server/parts_loader.mjs'

// ============================================================
// 持久化（per-user：路径/内存均按 username 分桶）
// ============================================================

/**
 * 某 user 的 airp 配置磁盘路径。空 username 回退 "_default" 桶（getUserDataDir 内部同款兜底）。
 * @param {string} username
 * @returns {string}
 */
function configFileFor(username) {
	return join(getUserDataDir(username || '_default'), 'airp', 'config.json')
}

/**
 * 保存某 user 的 airp 配置到磁盘（首次为新用户写时 mkdir recursive）。
 * @param {string} username
 * @param {object} data - 该 user 的 store 数据
 */
function saveConfigToDisk(username, data) {
	try {
		const f = configFileFor(username)
		const dir = dirname(f)
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		nicerWriteFileSync(f, JSON.stringify(data, null, 2), 'utf-8')
	} catch (e) {
		console.warn('[beilu-airp] 保存配置到磁盘失败:', e.message)
	}
}

/**
 * 从某 user 的磁盘文件读取配置。
 * @param {string} username
 * @returns {object|null}
 */
function loadConfigFromDisk(username) {
	try {
		const f = configFileFor(username)
		if (fs.existsSync(f)) {
			return JSON.parse(fs.readFileSync(f, 'utf-8'))
		}
	} catch (e) {
		console.warn('[beilu-airp] 从磁盘读取配置失败:', e.message)
	}
	return null
}

// ============================================================
// per-user store（惰性建桶，照 beilu-regex perUserStore 范式）
// ============================================================

/** 某 user 的默认（空）store 形状。config 内容第2章填充（配色谱/标签集/动态效果/自适应）。 */
function _freshStore() {
	return {
		enabled: true, // AIRP 渲染总开关
		config: {},    // 配色谱 palette / DSL标签集 tagSpec / 动态效果 dynEffects / 自适应 layout —— 第2章填充
	}
}

/** @type {Map<string, object>} username → store */
const perUserStore = new Map()

/** 归一 username：空/未定义 → "_default" 桶（匿名/主链无 user 时的回退桶，同 regex _normUser）。 */
function _normUser(username) {
	return (typeof username === 'string' && username) ? username : '_default'
}

/**
 * 惰性取某 user 的 store：首访建桶 + loadConfigFromDisk 恢复。
 * @param {string} username
 * @returns {object} 该 user 的 store（enabled/config）
 */
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
			console.log(`[beilu-airp] getStore("${key}") 已恢复 airp 配置`)
		}
	} catch (e) {
		console.warn(`[beilu-airp] getStore("${key}") 首访加载失败:`, e.message)
	}

	return data
}

// ============================================================
// beilu-airp 插件导出
// ============================================================

const pluginExport = {
	info,
	Load: async ({ username, router }) => {
		console.log('[beilu-airp] 插件加载中...')

		// ★ 自注册为默认插件，确保 getAllDefaultParts/requestBuilder(defaultPluginNames) 能发现它 → ReplyHandler 进生成链（照 beilu-mvu:538-541）。
		//   if(username) 守卫：某些 Load 时机无 user 上下文（username 空），此时跳过自注册不报错（同 mvu）。
		if (username) {
			setDefaultPart(username, 'plugins', 'beilu-airp')
			console.log('[beilu-airp] 已自动注册为默认插件 (plugins/beilu-airp)')
		}

		// ---- 注册 HTTP API 端点（同 regex A2-3：authenticate 补鉴权 + getUserByReq 解析身份透传 username）----
		router.get('/api/parts/plugins\\:beilu-airp/config/getdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const data = await pluginExport.interfaces.config.GetData({ username: _u })
				res.json(data)
			} catch (err) {
				console.error('[beilu-airp] GetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-airp/config/setdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const result = await pluginExport.interfaces.config.SetData(req.body, { username: _u })
				res.json(result || { success: true })
			} catch (err) {
				console.error('[beilu-airp] SetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: async () => {
		console.log('[beilu-airp] 插件卸载')
	},
	interfaces: {
		config: {
			/**
			 * 读某 user 的 airp 配置。verb getData 透传 context.user；HTTP getdata 透传 getUserByReq(req).username；缺失回退 _default 桶。
			 * @param {{username?:string}} ctx
			 */
			GetData: async (ctx) => {
				const store = getStore(ctx?.username)
				// 单源收口：有效谱 = 全局出厂谱(← data/airp_config.json) 深merge 本 user 个人差异层(store.config)。
				// 配色/标签集/动态效果/自适应默认唯一来源=capabilities.mjs，前端零副本、改单色不丢其余出厂色。
				const capabilities = resolveEffectiveAirp(__projectRoot, store.config)
				return {
					enabled: store.enabled,   // 渲染总开关(per-user 布尔)
					config: store.config,     // 个人差异层原样回传(前端编辑器回填"我改了哪些"用)
					capabilities,             // 有效能力谱(渲染器实际消费这个：palette/tagSpec/dynEffects/layout/fallback)
				}
			},
			/**
			 * 写某 user 的 airp 配置。args.username 分桶。data 支持 { enabled?, config? } 部分更新。
			 * @param {{enabled?:boolean, config?:object}} data
			 * @param {{username?:string}} args
			 */
			SetData: async (data, args) => {
				if (!data || typeof data !== 'object') return
				const _user = _normUser(args?.username)
				const store = getStore(_user)

				if (typeof data.enabled === 'boolean') store.enabled = data.enabled
				if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) store.config = data.config

				saveConfigToDisk(_user, store)
				return { success: true }
			},
		},

		chat: {
			/**
			 * GetPrompt — ①注入 DSL 操作说明(dslGuide)告诉 LLM 能输出哪些标签(第5章·002原话"inj 让 ai 知道怎么操作")；
			 *   ②从 chatLog 累积当前 airp 数值状态，通过 extension 传出(供后续消费)。
			 * 说明文本走能力谱 dslGuide(单源=capabilities.mjs 默认值，data 全局/per-user 可改，设空串=关闭)，非硬编码。
			 * text 契约=数组[{content,important}]（decl/prompt_struct.ts；0727 修：原照 beilu-sysinfo 抄了裸字符串
			 * 形态，两处同病在 fake-send 的 change-prompt .sort 处炸——sysinfo 同批已修）；extension 照 beilu-mvu(传累积态)。
			 * @param {object} arg - chatReplyRequest_t（含 chat_log/username）
			 * @returns {object|null} 注入对象；enabled=false 时 null
			 */
			GetPrompt: async (arg) => {
				const store = getStore(arg?.username)
				if (!store.enabled) return null

				// 有效谱(全局出厂 ← data 全局 ← per-user 深merge)——dslGuide 从此取，单源不自持默认。
				const caps = resolveEffectiveAirp(__projectRoot, store.config)
				const guide = (typeof caps.dslGuide === 'string') ? caps.dslGuide.trim() : ''

				// 累积当前数值态(首轮可能为空)——供后续消费，独立于说明注入。
				const currentState = accumulateAirpState(arg?.chat_log || [])
				const extension = currentState?.stat_data ? { airp_accumulated: currentState } : {}

				// guide 为空(用户关闭)则不注入文本；仅传 extension。
				if (!guide) {
					return { text: [], additional_chat_log: [], extension }
				}
				return {
					text: [{ content: guide, important: 0 }], // DSL 操作说明注入提示词（契约=数组，与上方空分支 text:[] 同形）
					role: 'system',
					name: 'beilu-airp',
					additional_chat_log: [],
					extension,
				}
			},

			/**
			 * ReplyHandler — 解析 AI 输出里的 <airp-patch> 数值指令(确定性 JS，LLM 不管计算)。
			 * 链路：replyHandler.mjs 生成链 → 本函数
			 *   → parseAirpCommands(content, currentState) 应用 set/delta/remove
			 *   → result.extension.airp_state = newState（BuildChatLogEntryFromCharReply 随 chatLog 持久化）
			 *   → hideAirpCommands → result.content_for_show（剥数值指令，保留 scene/sym/char/desc 视觉标签）
			 * 影响：修改 result.extension / result.content_for_show / result.content_for_edit
			 * 照 beilu-mvu ReplyHandler 范式(currentState 取自 accumulate 或退回 GetPrompt 累积态；return false 不触发重生成)。
			 * @param {object} result - 回复结果对象(content/extension/content_for_show)
			 * @param {object} request - chatReplyRequest_t(chat_log/username/prompt_struct)
			 * @returns {boolean} false — 不触发重新生成
			 */
			ReplyHandler: (result, request) => {
				const store = getStore(request?.username)
				if (!store.enabled) return false

				const content = result?.content
				if (!content || typeof content !== 'string') return false
				if (!/<airp-patch>/.test(content)) return false

				// 当前状态基点：优先 chat_log 累积态，退回本轮 GetPrompt 累积态，仍空则空 stat_data 起步(首轮也能落盘)。
				const currentState =
					accumulateAirpState(request?.chat_log || []) ||
					(request?.prompt_struct?.plugin_prompts?.['beilu-airp']?.extension?.airp_accumulated) ||
					{ stat_data: {} }

				const { newState, hasChanges } = parseAirpCommands(content, currentState)

				if (hasChanges) {
					// 写完整更新后状态，随 chatLog 持久化(存 extension.airp_state)。
					result.extension = result.extension || {}
					result.extension.airp_state = newState
				}

				// 显示态：保留视觉标签(scene/char/desc)，只剥 <airp-patch> 数值指令。
				result.content_for_show = hideAirpCommands(result.content_for_show || content)
				result.content_for_edit = result.content_for_edit || content // 编辑态保留原文(含数值指令，供查看编辑)

				return false // 不触发重新生成
			},

			/**
			 * GetRenderView — 渲染期视图产出（框架 v6 §三 P0 章2）。
			 * 只在渲染期被 shell 端点调用（GET :chatid/airp/view），产物只进 DOM——
			 *   不写 chatLog、不进 messages（002原话「符号画不要出现在 ai 的上下文」）。
			 * 范式：对齐 worldbook.interfaces.chat.GetRenderEntries（endpoints.mjs:1511 同款挂法：
			 *   shell 后端 loadPart → 取 interfaces.chat.<方法> → 调用）。同步函数（与 ReplyHandler 一致，
			 *   端点侧不 await，同 render/entries :1515）。
			 * P0 只产 state 块（数值态快照）；布局/几何块（type:'map'）属 P2，由算法层产出后在此并列追加。
			 * @param {object} arg - { username?, chat_log?, chatid?, char_id? }（由 shell 端点组装）
			 * @returns {{caps: object|null, blocks: Array<{type:string, data:object, order:number}>}}
			 *   caps=null（插件禁用）→ 前端不渲染 airp，诚实降级不报错
			 */
			GetRenderView: (arg) => {
				const store = getStore(arg?.username)
				if (!store.enabled) return { caps: null, blocks: [] }

				// 有效谱单源：与 config.GetData 同一解析函数，前端零副本零默认
				const caps = resolveEffectiveAirp(__projectRoot, store.config)

				// 当前数值态：从可见 chat_log 累积（shell 端点已喂 getVisibleChatLog 单源）
				const state = accumulateAirpState(arg?.chat_log || [])
				const blocks = state?.stat_data
					? [{ type: 'state', data: state.stat_data, order: 0 }]
					: []

				return { caps, blocks }
			},
		},
	},
}

export default pluginExport
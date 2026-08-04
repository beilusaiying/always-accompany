/**
 * beilu-live — 直播弹幕接入插件后端。
 *
 * 职责（图纸 v2 §二 D1，仅三件事）：
 *   ① 连上直播间，把弹幕归一化成统一对象（章3 adapters/）
 *   ② 确定性初筛：黑名单/关键词/长度/冷却/去重（章4 filter.mjs）
 *   ③ 攒够 + 到间隔 → 拼成上下文 → 交给【既有】主对话链（章5 runtime.mjs）
 *
 * 架构定位（002 亲笔 `beilu提示词理论/底部功能层.txt`）：
 *   直播 = 第四条【传导线路】（AIRP/Code/Work 之外的那个 n），不是新功能层。
 *   → 主线 api 传导 / 预设 / 记忆板块 / 提示词 / 流式渲染【全部复用】既有功能层，本插件零重建。
 *   ⚠ 红线：任何"直播专用的 api 调用 / 预设体系 / 记忆存储 / 渲染器"都违背此定位。
 *
 * 已建 config 链（章1 骨架 + 章2 能力谱接入）：
 *   设置面板 → /api/parts/plugins:beilu-live/config/{getdata,setdata}
 *     → interfaces.config.{GetData,SetData} → data/users/<user>/live/config.json
 *   GetData 返回 {enabled, config, capabilities, rules} 四字段——
 *     capabilities/rules 由 ./capabilities.mjs 三层解析（出厂 ← data/live_capabilities.json ← per-user）后下发，
 *     前端零默认副本、零提取逻辑（002 铁律：参数只是参照，禁止硬编码，用户需要可以设置一切）。
 *
 * 与 beilu-airp 的形态差异（照图纸，非疏漏）：
 *   1. enabled 出厂默认 = false（airp 是 true）——装上插件 ≠ 要开播，图纸 §3.3 用户配置 schema 明确。
 *   2. 【无 interfaces.chat 任何方法】——airp 是渲染插件要挂生成链(GetPrompt/ReplyHandler/GetRenderView)；
 *      live 是【输入侧】插件：弹幕经 chatOps.addUserReply 进承载对话、triggerCharReply 走既有主链，
 *      既不经 GetPrompt 注入提示词，也不解析 AI 输出 → 无需 chat 接口（图纸 §3.3 能力谱亦无 guide 字段）。
 *   3. setDefaultPart 仍调用（见 Load :88）——照图纸章1 要求保留。当前无 chat 接口时它不产生实际效果
 *      （其作用是让 requestBuilder 遍历到本插件并调 interfaces.chat.*，见 airp/main.mjs:37-38），
 *      为后续章节若挂接口预留，且对生成链无副作用（取不到 chat 方法即跳过）。
 *
 * 存储：per-user 分桶 data/users/<user>/live/config.json（照 airp/beilu-regex per-user 范式，防跨用户串台）。
 *   config 只存 per-user 个人差异；有效值 = 出厂谱 ← data/live_capabilities.json 全局 ← per-user（章2 接入）。
 *   不硬编码任何进对话链的文本（002 铁律：参数只是参照，禁止硬编码，用户需要可以设置一切）。
 *
 * 相范式：yonban/core/functions/airp/main.mjs（getStore/configFileFor/_normUser/saveConfigToDisk 同型）。
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import info from '../../../../public/parts/plugins/beilu-live/info.json' with { type: 'json' } // part 元数据留 parts 目录（GetPartPath 硬映射范式，同 airp/regex info 留原位）
import { nicerWriteFileSync } from '../../../../scripts/nicerWriteFile.mjs'
// [per-user] 用户数据目录权威范式（与 airp/regex T077 / preset T065 同款 getUserDataDir）
// __projectRoot：项目根权威单源（storage.mjs:67 导出）——仅在函数体内(GetData 运行时)读，不在模块顶层读。
// ⚠ 禁止项16(TDZ,0722 全插件 load_failed 事故)：import 进来的函数【只在函数体内调用】，模块顶层零调用。
import { getUserDataDir, __projectRoot } from '../memory/storage_mod/storage.mjs'
// 能力谱三层解析（出厂 LIVE_CAPABILITIES ← data/live_capabilities.json ← per-user config）+ 运行值摊平
import { resolveEffectiveLive, resolveLiveRules } from './capabilities.mjs'
// 平台注册表的【前端投影】（只出 label/tier/msgTypes/credentials/credentialHelp，不出 module 等后端实现细节）
import { listPlatformsForUI } from './registry.mjs'
// HTTP 端点鉴权 + 身份解析（authenticate 未认证→401；getUserByReq→username），与 airp/regex REST 薄壳同型
import { authenticate, getUserByReq } from '../security/auth.mjs'
// [进生成链预留] 自注册进 defaultParts。当前本插件无 interfaces.chat.* → 实际不参与生成链遍历，
//   保留调用照图纸章1 要求（副作用：仅使本插件出现在 defaultParts 列表；无 chat 方法则遍历时跳过）。
import { setDefaultPart } from '../../../../server/parts_loader.mjs'
// [章5] 运行时：弹幕连接 + 初筛调度 + 节奏控制 + 接主链。本文件只做 HTTP 薄壳，逻辑全在 runtime。
import { startLive, stopLive, getLiveStatus, stopAllSessions } from './runtime.mjs'

// ============================================================
// 持久化（per-user：路径/内存均按 username 分桶）
// ============================================================

/**
 * 某 user 的 live 配置磁盘路径。空 username 回退 "_default" 桶（getUserDataDir 内部同款兜底）。
 * @param {string} username
 * @returns {string}
 */
function configFileFor(username) {
	return join(getUserDataDir(username || '_default'), 'live', 'config.json')
}

/**
 * 保存某 user 的 live 配置到磁盘（首次为新用户写时 mkdir recursive）。
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
		console.warn('[beilu-live] 保存配置到磁盘失败:', e.message)
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
		console.warn('[beilu-live] 从磁盘读取配置失败:', e.message)
	}
	return null
}

// ============================================================
// per-user store（惰性建桶，照 airp perUserStore 范式）
// ============================================================

/**
 * 某 user 的默认（空）store 形状。
 * enabled 出厂默认 false（图纸 §3.3）：装上插件不自动连弹幕，需用户在「直播设计」面板显式开启。
 * config 内容章2 起填充（platform/roomId/credentials/chatid/filter/pool/selector/pacing/assistant 差异层）。
 */
function _freshStore() {
	return {
		enabled: false, // 直播接入总开关（出厂关闭，与 airp 的 true 不同：见文件头形态差异 #1）
		config: {},     // per-user 个人差异层 —— 章2 起填充
	}
}

/** @type {Map<string, object>} username → store */
const perUserStore = new Map()

/** 归一 username：空/未定义 → "_default" 桶（匿名/主链无 user 时的回退桶，同 airp _normUser）。 */
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
			console.log(`[beilu-live] getStore("${key}") 已恢复 live 配置`)
		}
	} catch (e) {
		console.warn(`[beilu-live] getStore("${key}") 首访加载失败:`, e.message)
	}

	return data
}

/**
 * 解析直播轮的承载对话。直播显式绑定拥有最高优先级；未显式绑定时只读取正在运行的
 * gameCompanion session.chatid，不把它复制进 live/config.json。这样陪伴的专门对话解析仍由
 * gameCompanion 单独拥有，直播只是消费同一个运行期真值；浏览器当前 hash 不再成为第二默认源。
 */
export async function resolveLiveChatTarget(username, explicitChatid) {
	const bound = String(explicitChatid || '').trim()
	if (bound) return { chatid: bound, source: 'live_binding' }
	try {
		const { getGameCompanionStatus } = await import('../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs')
		const status = getGameCompanionStatus(_normUser(username))
		const companionChatid = String(status?.running ? (status.chatid || '') : '').trim()
		if (companionChatid) return { chatid: companionChatid, source: 'companion_session' }
	} catch (error) {
		return { chatid: '', source: 'none', error: error?.message || String(error) }
	}
	return { chatid: '', source: 'none' }
}

/** 字段级递归合并 live 配置；数组/原子值按 patch 整体替换，对象保留未触及兄弟字段。 */
export function mergeLiveConfigPatch(base, patch) {
	const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {}
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
	for (const [key, value] of Object.entries(patch)) {
		out[key] = (value && typeof value === 'object' && !Array.isArray(value))
			? mergeLiveConfigPatch(out[key], value)
			: value
	}
	return out
}

// ============================================================
// beilu-live 插件导出
// ============================================================

const pluginExport = {
	info,
	Load: async ({ username, router }) => {
		console.log('[beilu-live] 插件加载中...')

		// ★ 自注册进 defaultParts（照图纸章1；当前无 interfaces.chat.* 故对生成链无实际作用，见文件头形态差异 #3）。
		//   if(username) 守卫：某些 Load 时机无 user 上下文（username 空），此时跳过自注册不报错（同 airp/mvu）。
		if (username) {
			setDefaultPart(username, 'plugins', 'beilu-live')
			console.log('[beilu-live] 已自动注册为默认插件 (plugins/beilu-live)')
		}

		// ---- 注册 HTTP API 端点（同 airp：authenticate 补鉴权 + getUserByReq 解析身份透传 username）----
		//   路径里的 `\\:` 是 Express 参数冒号转义（partpath 形如 plugins:beilu-live，见 SKILL.md 1.2）。
		//   ⚠ POST config/setdata 另受 parts_router SEC-R1 owner 闸约束（安全敏感写强制 owner），属既有框架机制。
		router.get('/api/parts/plugins\\:beilu-live/config/getdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const data = await pluginExport.interfaces.config.GetData({ username: _u })
				res.json(data)
			} catch (err) {
				console.error('[beilu-live] GetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-live/config/setdata', authenticate, async (req, res) => {
			try {
				let _u = ''
				try { _u = (await getUserByReq(req)).username || '' } catch { /* 匿名→_default 桶 */ }
				const result = await pluginExport.interfaces.config.SetData(req.body, { username: _u })
				res.json(result || { success: true })
			} catch (err) {
				console.error('[beilu-live] SetData error:', err)
				res.status(500).json({ error: err.message })
			}
		})

		// ---- 运行控制三端点（章5）----
		//   【为什么是三个独立端点而非塞进 config/setdata 的 payload】
		//     config 端点的职责是"读写配置"，动作端点的职责是"控制运行"，两者生命周期完全不同
		//     （配置持久化到磁盘，运行状态只在内存）。塞进同一个端点会让它承担两种职责，
		//     且 SetData 的"部分更新"语义与"执行动作"语义冲突。
		//   对齐项目既有形状：一个动作一个端点（同 airp/main.mjs:151/163 的 getdata/setdata 分立范式）。
		//   ⚠ enabled（插件总开关）与"运行中"（session 存在）是【两个开关】——
		//     002 亲笔 `底部功能层.txt`：「a开关-b执行，但是我们有很多开关，每个开关的需求不一样」。
		//     enabled=false 时拒绝启动并诚实报错，不静默放行（下方 start 端点首行守卫）。
		const _reqUser = async (req) => {
			try { return (await getUserByReq(req)).username || '' } catch { return '' /* 匿名→_default 桶 */ }
		}

		router.post('/api/parts/plugins\\:beilu-live/live/start', authenticate, async (req, res) => {
			try {
				const _u = await _reqUser(req)
				const store = getStore(_u)
				if (!store.enabled) {
					// 诚实拒绝：面板能显示"为什么没启动"，而不是点了没反应
					return res.json({ success: false, error: '直播接入未启用：请先在「直播接入」段打开总开关' })
				}
				const cfg = store.config || {}
				const carrier = await resolveLiveChatTarget(_u, req.body?.chatid ?? cfg.chatid)
				const result = await startLive(_u, {
					// 平台/房间/承载对话：显式请求参数优先，缺省回落 per-user 配置
					platform: req.body?.platform ?? cfg.platform,
					roomId: req.body?.roomId ?? cfg.roomId,
					chatid: carrier.chatid,
					targetSource: carrier.source,
					credentials: cfg.credentials || {},
					// getConfig 注入：runtime 每轮对表最新配置，但不直接依赖 main 的 store（单向依赖）
					getConfig: () => getStore(_u).config || {},
				})
				res.json(result)
			} catch (err) {
				console.error('[beilu-live] startLive error:', err)
				res.status(500).json({ success: false, error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-live/live/stop', authenticate, async (req, res) => {
			try {
				res.json(stopLive(await _reqUser(req)))
			} catch (err) {
				console.error('[beilu-live] stopLive error:', err)
				res.status(500).json({ success: false, error: err.message })
			}
		})

		router.get('/api/parts/plugins\\:beilu-live/live/status', authenticate, async (req, res) => {
			try {
				res.json(getLiveStatus(await _reqUser(req)))
			} catch (err) {
				console.error('[beilu-live] getLiveStatus error:', err)
				res.status(500).json({ running: false, error: err.message })
			}
		})
	},
	Unload: async () => {
		// 停掉全部运行中的弹幕连接与定时器 —— 不留后台 socket/timer（章1 留痕点，章5 兑现）。
		// ⚠ Deno 无热卸载，reloadPart 实为重启进程（parts_loader.mjs:600）；此处仍显式清理，
		//   覆盖"进程存活但插件被卸载"的路径，避免孤儿连接持续收弹幕。
		try { stopAllSessions() } catch (e) { console.warn('[beilu-live] 卸载时停止会话异常:', e.message) }
		console.log('[beilu-live] 插件卸载')
	},
	interfaces: {
		config: {
			/**
			 * 读某 user 的 live 配置 + 有效能力谱。
			 * verb getData 透传 context.user；HTTP getdata 透传 getUserByReq(req).username；缺失回退 _default 桶。
			 *
			 * 【五字段各自的消费方】（前端零默认副本、零提取逻辑，全部后端下发——002 铁律 + 禁止项8）：
			 *   enabled      → 直播接入总开关(per-user 布尔)。⚠ 与 capabilities.assistant.enabled 是两个开关，见 capabilities.mjs 注释
			 *   config       → per-user 差异层【原样】回传：前端知道"我改过哪些键"，也是 SetData 回写的对象形状
			 *   capabilities → 有效能力谱 {default,min,max,options} 控件描述：前端渲染 input 的 min/max、select 的 options
			 *   rules        → 摊平运行值 {minLength:2,...}：前端回填 input.value；后端 filter/runtime/assistant 消费
			 *   platforms    → 平台注册表投影：前端渲染平台下拉 + 【按 credentials[] 动态渲染凭据控件】
			 *                  （图纸章5 落点5.2 要求"不逐平台手写区块"，前端据此循环渲染，加平台零前端改动）
			 *
			 * ⚠ platforms 与 capabilities 是【两个域】，刻意并列不合并：
			 *   platforms(registry.mjs owner)    = 有哪些平台、各自要什么凭据 —— 加平台改 registry
			 *   capabilities(capabilities.mjs owner) = 阈值/开关/值域 —— 调参数改 capabilities
			 *   合并成一个对象会让"改平台"和"改参数"落到同一个 owner，是双域同源的起点。
			 *
			 * ⚠ capabilities/rules 是【合并态】(出厂 ← 全局 ← per-user)，禁被前端整个回传进 SetData——
			 *   那会把出厂默认烙进 per-user 文件，以后改出厂默认对老用户零生效（见 SetData 注释）。
			 * @param {{username?:string}} ctx
			 * @returns {{enabled:boolean, config:object, capabilities:object, rules:object, platforms:Array<object>}}
			 */
			GetData: async (ctx) => {
				const store = getStore(ctx?.username)
				const carrier = await resolveLiveChatTarget(ctx?.username, store.config?.chatid)
				// 惰性在函数体内读 __projectRoot 与磁盘覆盖层（模块顶层零调用，避 TDZ）
				const capabilities = resolveEffectiveLive(__projectRoot, store.config)
				return {
					enabled: store.enabled,             // 直播接入总开关(per-user 布尔)
					config: store.config,               // 个人差异层原样回传(前端回填"我改了哪些" + SetData 形状参照)
					carrier,                            // 有效承载目标：显式 live 绑定 > 正在运行的陪伴 session
					capabilities,                       // 有效能力谱(控件描述形态，渲染 min/max/options 用)
					rules: resolveLiveRules(capabilities), // 摊平运行值(回填 value / 后端消费用)
					platforms: listPlatformsForUI(),    // 平台声明投影(下拉选项 + 凭据控件动态渲染)
				}
			},
			/**
			 * 写某 user 的 live 配置。args.username 分桶。data 支持 { enabled?, config? } 部分更新。
			 * @param {{enabled?:boolean, config?:object}} data
			 * @param {{username?:string}} args
			 */
			SetData: async (data, args) => {
				if (!data || typeof data !== 'object') return
				const _user = _normUser(args?.username)
				const store = getStore(_user)

				if (typeof data.enabled === 'boolean') store.enabled = data.enabled
				// 前端每次只发送一个字段 patch（例如 {config:{filter:{minLength:3}}}）。
				// 写端必须递归合并到 per-user 差异层；旧的整对象替换会在改一个控件时抹掉其余
				// 平台凭据/过滤/节奏字段，造成 GetData 读回对象与用户刚才看到的对象分叉。
				if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) {
					store.config = mergeLiveConfigPatch(store.config, data.config)
				}

				saveConfigToDisk(_user, store)
				return { success: true }
			},
		},
	},
}

export default pluginExport

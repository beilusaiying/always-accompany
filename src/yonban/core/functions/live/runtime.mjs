/**
 * runtime.mjs — 直播接入运行时：把弹幕流接进【既有】主对话链。
 *
 * 【职责边界】本文件是【接线员】不是功能层（002 亲笔 `底部功能层.txt`：
 *   直播 = 第四条【传导线路】，不是新功能层）：
 *     ✅ 做：连接管理、初筛调度、节奏控制、上下文成型后交给主链
 *     ❌ 不做：AI 调用、提示词拼装、记忆读写、渲染 —— 全部复用既有功能层
 *   ⚠ 本文件出现任何"直播专用的 api 调用/预设/记忆/渲染器"，即违背架构定位。
 *
 * 【两级节奏（图纸 D4 + 雷区7 的落点）】
 *   第一级 onMessage（高频，同步，每秒可能几十条）：只做 screenMessage 初筛 + pool.push。
 *     ⚠ 绝不在此触发 AI —— 爆场时每条弹幕起一轮 = token 爆炸 + 生成锁互撞。
 *   第二级 定时器轮（低频，pacing.minRoundIntervalMs）：取池 → 选择 → 成型 → 进主链。
 *
 * 【链路（一轮的完整路径）】
 *   adapter.connect(onMessage)                    ← 章3 adapters/bilibili.mjs
 *     → filter.screenMessage(msg, rules, state)   ← 章4 filter.mjs（不通过返 reason，记账不丢弃）
 *     → pool.push(msg)                            ← 章4 pool.mjs（环形，满了挤最旧）
 *   ── 定时器到点 ──
 *     → pool.take() → selectForRound() → formatForContext()   ← 章4 pool.mjs
 *     → chatOps.addUserReply(chatid, {content})   ← 【既有】主链，先落盘
 *     → generation.triggerCharReply(chatid, ...)  ← 【既有】主链，全量管线（预设/记忆/API/流式渲染全继承）
 *
 * 【与 gameCompanion.mjs 的关系】借【范式】不借代码，刻意不提炼共用基类：
 *   借：_sessions Map / inFlight 重入闸 / 无 chatid 诚实拒启 / stopAll / 主链两步调用
 *   不借：它的 session 字段是"截图轮 + 频率自适应"语义（baseInterval/silenceMultiplier/
 *         consecutiveIgnores），直播一个都不需要；两者共同点只剩"Map+定时器+闸"这一 JS 通用模式，
 *         不是业务逻辑。强行抽 SessionManager 基类会把两个不同生命周期的东西绑死，
 *         是"为复用而复用"的过度抽象 —— 故各自持有，注释互指。
 *
 * 【状态只在内存】进程重启后需重新 startLive（同 gameCompanion:37 语义）。
 *   不新建任何存储 —— 002「其他的我们已经有了」，配置存 main.mjs 的 per-user store，
 *   对话内容存承载对话文件，本文件零落盘。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url' // 主链模块按绝对路径动态 import（同 replyHandler 范式）

// __projectRoot：项目根【绝对锚点】。
//   ⚠ 刻意不用 `join(import.meta.dirname, '..','..','..','..')` 相对上溯 ——
//     相对上溯依赖"本文件在第几层"，文件一旦被移动/重组即断（002 存档
//     `反思_文件重组为什么炸了.md` / `分析_404链路断裂.md` 记录的正是此类事故）。
//   ⚠ 禁止项16(TDZ)：import 的绑定只在函数体内读，模块顶层零调用。
import { __projectRoot } from '../memory/storage_mod/storage.mjs'
import { resolveEffectiveLive, resolveLiveRules } from './capabilities.mjs'
import { getPlatformEntry } from './registry.mjs'
import { screenMessage, createScreenState, assertFilterRules, SCREEN_REASONS } from './filter.mjs'
import { createPool, selectForRound, formatForContext, assertPoolRules } from './pool.mjs'

/**
 * 活跃直播会话 Map<username, session>。
 *
 * 【键为什么是 username 而非 username/platform/roomId】
 *   一个用户同一时刻只连一个直播间 —— 这是当前的产品判断，不是技术限制。
 *   多房间同时接入需要解决"多路弹幕混进同一条对话时谁是谁"的语义问题（图纸未规定），
 *   现在做 = 过度设计。将来要支持时，改本 Map 的键 + session 增 roomId 维度即可，
 *   调用方（startLive/stopLive/getLiveStatus）签名不变。
 * @type {Map<string, object>}
 */
const _sessions = new Map()

/** 归一 username（与 main.mjs _normUser 同语义，空 → _default 桶）。 */
function _normUser(username) {
	return (typeof username === 'string' && username) ? username : '_default'
}

/**
 * 解析当前有效 rules（三层：出厂 ← data/live_capabilities.json ← per-user config）。
 *
 * 【为什么每轮重解析而非启动时快照】用户在面板改了阈值/间隔要【立即生效】，
 *   而不是"改完得重启直播"（同 gameCompanion._syncFreqFromConfig:299 的运行中对表语义）。
 *   代价 = 每轮一次磁盘 JSON 读，定时器轮是分钟级，可忽略。
 * 【为什么不缓存进 session】缓存 = 同一份 rules 有两个副本（session 一份、capabilities 一份），
 *   用户改配置后两者分叉，且分叉点极难查。单源取用，不留副本。
 *
 * @param {object} perUserConfig - main.mjs store.config（per-user 差异层）
 * @returns {object} 摊平运行值 {filter, pool, selector, pacing, connection, platformProtocol, contextTemplate, assistant}
 */
function _resolveRules(perUserConfig) {
	return resolveLiveRules(resolveEffectiveLive(__projectRoot, perUserConfig || {}))
}

/**
 * 动态 import 主链两模块（chatOps / generation）。
 *
 * 【为什么动态 import 而非顶层静态】主链模块位于 shells/beilu-chat 下，
 *   与本文件分属不同 part；顶层静态 import 会在插件加载期就拉起整条主链依赖，
 *   放大 TDZ/循环依赖面（0722 全插件 load_failed 事故的成因族）。
 *   动态 import 让依赖只在【真正开播时】建立，且失败可被 catch 成诚实降级。
 *   —— 同 gameCompanion:415-417 / replyHandler 既有范式。
 *
 * @returns {Promise<{chatOps:object, generation:object}>}
 * @throws {Error} 主链模块不可达时抛（调用方转成用户可见的诚实错误）
 */
async function _loadMainChain() {
	const libDir = join(__projectRoot, 'src', 'public', 'parts', 'shells', 'beilu-chat', 'src', 'lib')
	const chatOps = await import(pathToFileURL(join(libDir, 'chatOps.mjs')).href)
	const generation = await import(pathToFileURL(join(libDir, 'generation.mjs')).href)
	return { chatOps, generation }
}

/**
 * 新建一份统计对象。面板消费（图纸 DONE WHEN #4「本场通过 N 条 / 拦截 M 条，各因为什么」）。
 * byReason 的键来自 filter.SCREEN_REASONS —— 单源，新增拦截原因时此处零改动。
 */
function _freshStats() {
	const byReason = {}
	for (const r of Object.values(SCREEN_REASONS)) byReason[r] = 0
	return {
		received: 0,   // adapter 送来的原始消息总数
		passed: 0,     // 通过初筛入池的
		blocked: 0,    // 被初筛拦下的（= byReason 各项之和）
		evicted: 0,    // 因池满被挤出的（进了池但没轮到就被新弹幕挤掉）
		injected: 0,   // 真正拼进上下文送进主链的
		rounds: 0,     // 已执行的轮次数
		skippedIdle: 0,   // 因池空跳过的轮（pacing.idleSkip）
		skippedInFlight: 0, // 因上一轮未完成跳过的轮（重入闸）
		byReason,
	}
}

/**
 * 执行一轮：取池 → 选择 → 成型 → 进主链。
 *
 * 【重入闸】triggerCharReply 是异步的且【不 await】（AI 生成可能几十秒），
 *   单轮耗时可能 > minRoundIntervalMs → 定时器到点会重入。
 *   闸门收口在本函数入口单点（同 gameCompanion:338-344 范式）。
 *   ⚠ 闸的释放在 finally，与加闸同判据，不在中途 return 处散写解锁。
 *
 * @param {object} session
 */
async function _executeRound(session) {
	if (session.stopped) return
	if (session.inFlight) {
		session.stats.skippedInFlight += 1
		return
	}
	session.inFlight = true
	try {
		// 每轮对表配置（用户改了阈值/间隔立即生效，见 _resolveRules 注释）
		let rules
		try {
			rules = _resolveRules(session.getConfig())
		} catch (e) {
			console.warn('[beilu-live] 规则解析失败，本轮跳过:', e.message)
			return
		}

		// 过期清理：超过 ttlSec 的弹幕不再有注入价值（直播是即时场景，旧弹幕注入=答非所问）
		session.pool.prune(rules.pool.ttlSec)

		const candidates = session.pool.take()
		if (!candidates.length) {
			// 池空：idleSkip=true 时不打扰主链（不发空轮），false 时也无内容可发 —— 两种情况都跳过，
			// 但只在 idleSkip 语义下计数，让面板能区分"没弹幕"和"有弹幕但被拦光"
			session.stats.skippedIdle += 1
			return
		}

		const selected = selectForRound(candidates, rules, session.lastRepliedUid)
		if (!selected.length) return

		const text = formatForContext(selected, rules, session.lastRepliedUid)
		if (!text) return // 模板全空 = 用户把 header/line/footer 都设成了空串，视为不注入

		// ── 交给【既有】主链：先落盘（addUserReply），后触发生成（triggerCharReply）──
		const { chatOps, generation } = await _loadMainChain()

		// ⚠ content 是 formatForContext 的产出 —— 全部文案来自 contextTemplate（用户可配），
		//   本文件【零硬编码进 messages 的文本】（禁止项7）。
		await chatOps.addUserReply(session.chatid, {
			content: text,
			files: [],
			// 产者标记：将来若要做"只修剪直播条目"的历史清理，凭此标记定位（同 gameCompanionShot 范式）
			extension: { beiluLiveRound: true },
		})

		// 记录本轮"被回复的对象"，供下一轮 selector.includeLastReplied 使用。
		// ⚠ 这【不是】"AI 真正回复了谁" —— triggerCharReply 是异步的、回复由 ReplyHandler
		//   落盘，runtime 拿不到完成回调（gameCompanion:472-474 注释记录了同一处境）。
		//   此处取本轮注入内容里【权重最高/最新的那条】的 uid 作为近似：
		//   它是本轮最可能被 AI 回应的对象，也是「注入刚刚回复的用户」这条需求在可实现范围内的最佳落点。
		session.lastRepliedUid = selected[selected.length - 1]?.uid || session.lastRepliedUid

		session.stats.injected += selected.length
		session.stats.rounds += 1
		session.lastRoundAt = Date.now()

		// 不 await：AI 生成耗时不该阻塞定时器轮（同 gameCompanion:476 范式）。
		// 失败只留痕不重试 —— 重试会在主链已受理的情况下产生重复轮。
		// [0727] windowMode:'live' 让主链 resolveGenerationMode 选 live 模式
		//   → aiRunner prompts 分组选 prompts_live（P1 辅助 AI 按 activeMode 选组）
		//   → INJ autoMode 域也走 live 分支（如有）
		//   链路：triggerCharReply options.windowMode → getChatRequest → requestBuilder:144
		//         → request.mode='live' → resolveGenerationMode 第一优先级命中
		generation.triggerCharReply(session.chatid, undefined, {
			userInitiated: false,
			sourceChannel: 'beiluLive',
			windowMode: 'live',
		}).catch((e) => {
			console.warn(`[beilu-live] 主链生成触发失败(第${session.stats.rounds}轮):`, e.message)
		})
	} catch (e) {
		console.error('[beilu-live] 轮次执行失败:', e.message)
	} finally {
		// 与入口同判据释放（不在中途 return 处散写解锁 —— 加锁/放锁判据必须同源）
		session.inFlight = false
	}
}

/**
 * 启动一个直播接入会话。
 *
 * @param {string} username
 * @param {{platform:string, roomId:string, chatid:string, credentials?:object, getConfig:Function}} opts
 *   getConfig: 取 per-user config 的函数（由 main.mjs 注入 —— runtime 不直接碰 store，
 *              避免 runtime 与 main 双向依赖）
 * @returns {Promise<{success:boolean, sessionId?:string, error?:string}>}
 */
export async function startLive(username, opts) {
	const user = _normUser(username)
	if (_sessions.has(user)) {
		return { success: false, error: '直播接入已在运行（同一用户同时只能连一个直播间）' }
	}

	const platformId = String(opts?.platform || '').trim()
	const roomId = String(opts?.roomId || '').trim()
	const chatid = String(opts?.chatid || '').trim()

	// ── 前置校验：诚实拒启，不静默空转（同 gameCompanion:97-99 语义）──
	if (!platformId) return { success: false, error: '未选择直播平台' }
	if (!roomId) return { success: false, error: '未填写直播间房间号' }
	// 无承载对话 = 弹幕无处落盘、AI 回复无处显示 —— 拒启而非"先跑着"
	if (!chatid) return { success: false, error: '需要一个承载对话：请先打开一个对话，或在设置里选择承载对话' }

	const platform = getPlatformEntry(platformId)
	if (!platform) return { success: false, error: `未知平台: ${platformId}` }

	// ── 规则解析 + 完整性校验（启动期一次，不进热路径）──
	let rules
	try {
		rules = _resolveRules(typeof opts.getConfig === 'function' ? opts.getConfig() : {})
		assertFilterRules(rules)
		assertPoolRules(rules)
	} catch (e) {
		return { success: false, error: `配置校验失败: ${e.message}` }
	}
	const proto = rules.platformProtocol?.[platformId]
	if (!proto) {
		return { success: false, error: `缺少平台协议配置: capabilities.platformProtocol.${platformId}` }
	}

	// ── 装载 adapter（动态 import：加平台零本文件改动）──
	let adapter
	try {
		const mod = await import(pathToFileURL(join(import.meta.dirname, platform.module)).href)
		adapter = mod.default
		if (!adapter || typeof adapter.connect !== 'function') {
			return { success: false, error: `平台 ${platformId} 的 adapter 未导出 connect()` }
		}
	} catch (e) {
		return { success: false, error: `装载 ${platformId} adapter 失败: ${e.message}` }
	}

	const session = {
		id: `live_${Date.now().toString(36)}`,
		username: user,
		platform: platformId,
		roomId,
		chatid,
		getConfig: typeof opts.getConfig === 'function' ? opts.getConfig : () => ({}),
		startedAt: Date.now(),
		lastRoundAt: null,
		lastRepliedUid: '',
		stopped: false,   // ★ close() 之后 adapter 可能还有迟到回调；onMessage 首行据此止步
		inFlight: false,  // 重入闸（见 _executeRound）
		connState: 'connecting', // connecting / authed / retrying / closed —— adapter onState 推送
		connDetail: '',
		pool: createPool(rules.pool.capacity),
		screenState: createScreenState(),
		stats: _freshStats(),
		handle: null,
		timer: null,
	}

	// ── 第一级：弹幕到达（高频同步，只做初筛+入池，绝不碰 AI）──
	const onMessage = (msg) => {
		if (session.stopped) return // 迟到回调止步
		session.stats.received += 1
		let r
		try {
			// 初筛用【启动期解析的 rules】（闭包捕获），不在此处重解析：
			//   本函数是热路径（爆场时每秒几十次），每次读磁盘 JSON 不可接受。
			//   代价：用户改了初筛阈值要等到下一次 startLive 才生效——
			//   而 _executeRound 的 pool/selector/pacing 参数是每轮对表的（见 _resolveRules 注释）。
			//   ⚠ 这是两级节奏的固有差异，不是遗漏；黑名单/关键词表走 getConfig() 实时读，改了立即生效。
			r = screenMessage(msg, rules, session.screenState, session.getConfig()?.filter)
		} catch (e) {
			console.warn('[beilu-live] 初筛异常，本条跳过:', e.message)
			return
		}
		if (!r.pass) {
			session.stats.blocked += 1
			if (r.reason && session.stats.byReason[r.reason] !== undefined) session.stats.byReason[r.reason] += 1
			return
		}
		session.stats.passed += 1
		const evicted = session.pool.push(msg)
		if (evicted) session.stats.evicted += 1
	}

	const onError = (err) => {
		session.connDetail = err?.message || String(err)
		console.warn(`[beilu-live] 连接错误 (${user}/${platformId}/${roomId}):`, session.connDetail)
	}

	const onState = ({ state, detail }) => {
		session.connState = state
		session.connDetail = detail || ''
	}

	// ── 建立连接（rules 整份传入，不逐字段手拼 —— 章3 adapter 的契约）──
	try {
		session.handle = adapter.connect(
			{ roomId, credentials: opts.credentials || {} },
			onMessage,
			onError,
			{ connection: rules.connection, protocol: proto, onState },
		)
	} catch (e) {
		return { success: false, error: `连接失败: ${e.message}` }
	}

	// ── 第二级：定时器轮（低频，节奏由 pacing.minRoundIntervalMs 控制）──
	session.timer = setInterval(() => {
		_executeRound(session).catch((e) => {
			console.error(`[beilu-live] 轮次异常 (${user}):`, e.message)
		})
	}, rules.pacing.minRoundIntervalMs)

	_sessions.set(user, session)
	console.log(`[beilu-live] 已启动: ${user} → ${platformId}/${roomId}, 承载对话=${chatid}, 轮间隔=${Math.round(rules.pacing.minRoundIntervalMs / 1000)}秒`)

	return { success: true, sessionId: session.id }
}

/**
 * 停止直播接入。
 *
 * 【清理顺序】stopped 标志 → 关连接 → 停定时器 → 清池。
 *   ⚠ 顺序不可换：先停定时器再关连接，会留下"轮已停但弹幕还在进池"的窗口（内存只涨不消）。
 *   stopped 置首位是为了让在途的 onMessage/轮次立刻止步。
 *
 * @param {string} username
 * @returns {{success:boolean, error?:string, stats?:object}}
 */
export function stopLive(username) {
	const user = _normUser(username)
	const session = _sessions.get(user)
	if (!session) return { success: false, error: '没有运行中的直播接入' }

	session.stopped = true
	try { session.handle?.close() } catch (e) { console.warn('[beilu-live] 关闭连接异常:', e.message) }
	if (session.timer) { clearInterval(session.timer); session.timer = null }
	session.pool.clear()
	_sessions.delete(user)

	console.log(`[beilu-live] 已停止: ${user}, 共 ${session.stats.rounds} 轮, 注入 ${session.stats.injected} 条`)
	return { success: true, stats: session.stats }
}

/**
 * 查询运行状态（面板轮询消费）。
 *
 * 返回的每一项都有前端落点（图纸 DONE WHEN #4 + 面板状态条）：
 *   running/connState → 状态灯；roomId/chatid → 当前接入目标；
 *   stats.byReason    → 「拦截 M 条，各因为什么」的分类明细；
 *   poolSize          → 待处理弹幕数（能看出"攒着没发"还是"根本没收到"）
 *
 * @param {string} username
 * @returns {object}
 */
export function getLiveStatus(username) {
	const session = _sessions.get(_normUser(username))
	if (!session) return { running: false }
	return {
		running: true,
		sessionId: session.id,
		platform: session.platform,
		roomId: session.roomId,
		chatid: session.chatid,
		connState: session.connState,
		connDetail: session.connDetail,
		startedAt: session.startedAt,
		lastRoundAt: session.lastRoundAt,
		poolSize: session.pool.size(),
		lastRepliedUid: session.lastRepliedUid,
		stats: session.stats,
	}
}

/**
 * 停止全部会话（进程退出 / 插件卸载时调用）。
 * 同 gameCompanion.stopAllSessions:509 语义 —— 不留后台定时器与 socket。
 */
export function stopAllSessions() {
	for (const [user, session] of _sessions) {
		session.stopped = true
		try { session.handle?.close() } catch { /* 退出路径不级联 */ }
		if (session.timer) clearInterval(session.timer)
		console.log(`[beilu-live] 进程退出，停止: ${user}`)
	}
	_sessions.clear()
}
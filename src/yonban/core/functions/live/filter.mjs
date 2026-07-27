/**
 * filter.mjs — 弹幕初筛（确定性算法，零 AI 调用）。
 *
 * 002 原话：「同时进行筛选也就是算法初筛」——筛选是纯算法的事，不烧 token。
 *
 * 【职责边界】本文件只做【淘汰判定】：这条弹幕要不要进池。
 *   选择哪些进上下文、怎么拼成文本 → pool.mjs（selectForRound / formatForContext）。
 *
 * 【诚实降级（图纸雷区8）】不通过【不静默丢弃】，返回 reason 枚举——
 *   面板要能显示「本场通过 N 条 / 拦截 M 条，各因为什么」（图纸 DONE WHEN #4）。
 *
 * 【关于"纯函数"】screenMessage 会【mutate 传入的 state】（记录通过项的 uid/文本时间戳），
 *   严格说不是纯函数。这是刻意的："判定 + 记账"一体，避免调用方在外面散拼记账逻辑
 *   （散拼 = 冷却/去重的记账规则出现第二份实现）。
 *   → 测试时传一个新建的 state 即可完全复现，不依赖任何模块级可变状态。
 *
 * 【零默认值】所有阈值从 rules.filter 取，本文件【不写 `?? 兜底`】——
 *   单源 = capabilities.mjs LIVE_CAPABILITIES.filter。给兜底 = 第二份默认值 = 改了配置却仍走旧值。
 *   启动时调一次 assertFilterRules(rules) 做完整性校验；screenMessage 是热路径不重复校验。
 */

/**
 * @typedef {Object} LiveMessage 见 adapters/*.mjs 产出（图纸 v2 §3.1）
 * @property {string} platform
 * @property {string} roomId
 * @property {string} uid    发送者平台唯一 id（冷却的分区键）
 * @property {string} user   发送者显示名
 * @property {string} text   弹幕文本
 * @property {number} ts     到达时间戳(ms)
 * @property {'danmaku'|'gift'|'enter'|'superchat'} type
 * @property {number} [weight]
 * @property {object} [raw]
 */

/**
 * 初筛判定结果。
 * @typedef {Object} ScreenResult
 * @property {boolean} pass
 * @property {string|null} reason - null=通过；否则为下列枚举之一
 */

/**
 * 拦截原因枚举（面板统计按此分类展示；新增原因必须同步加进本表）。
 * @type {Readonly<Record<string,string>>}
 */
export const SCREEN_REASONS = Object.freeze({
	TOO_SHORT: 'too_short',           // 短于 filter.minLength
	TOO_LONG: 'too_long',             // 长于 filter.maxLength
	BLACKLIST: 'blacklist',           // 命中黑名单（用户名/uid/词）
	KEYWORD_MISS: 'keyword_miss',     // keywordMode=include 时未命中任一关键词
	KEYWORD_HIT: 'keyword_hit',       // keywordMode=exclude 时命中了排除词
	USER_COOLDOWN: 'user_cooldown',   // 同一 uid 距上次通过不足 filter.userCooldownSec
	DUPLICATE: 'duplicate',           // dedupWindowSec 窗口内出现过完全相同的文本
	EMPTY: 'empty',                   // 无文本内容（如 enter 类进场消息）
})

/** filter 组必需的键（缺任一 → 启动期报错，不进热路径才发现）。 */
const _REQUIRED_FILTER_KEYS = [
	'minLength', 'maxLength', 'userCooldownSec', 'dedupWindowSec', 'blacklistEnabled', 'keywordMode',
]

/**
 * 启动期校验 filter 规则完整性。runtime 启动一次即可，screenMessage 不重复校验（热路径）。
 * @param {object} rules - resolveLiveRules 的返回值
 * @throws {Error} 缺键时抛，附键路径
 */
export function assertFilterRules(rules) {
	const f = rules?.filter
	if (!f || typeof f !== 'object') {
		throw new Error('[beilu-live/filter] 缺 rules.filter（单源=capabilities.mjs LIVE_CAPABILITIES.filter，本模块不持默认值）')
	}
	for (const k of _REQUIRED_FILTER_KEYS) {
		if (f[k] === undefined || f[k] === null) throw new Error(`[beilu-live/filter] 缺 rules.filter.${k}`)
	}
	for (const k of ['minLength', 'maxLength', 'userCooldownSec', 'dedupWindowSec']) {
		if (!Number.isFinite(f[k])) throw new Error(`[beilu-live/filter] rules.filter.${k} 必须是数字，实际: ${typeof f[k]}`)
	}
}

/**
 * 新建一份初筛状态。由调用方（runtime 的 session）持有，随会话生命周期存亡。
 *
 * @returns {{lastByUid: Map<string,number>, recentTexts: Map<string,number>}}
 *   lastByUid   : uid → 上次【通过】的时间戳（冷却判定用；被拦的不记账，否则被拦一次要等两轮）
 *   recentTexts : 文本 → 上次【通过】的时间戳（去重判定用）
 */
export function createScreenState() {
	return {
		lastByUid: new Map(),
		recentTexts: new Map(),
	}
}

/**
 * 惰性清理过期记账项，防长跑内存泄漏。
 *
 * 【为什么必需】直播跑几小时，recentTexts 每条通过的弹幕记一项——不清就是几万条常驻。
 * 【为什么惰性】不额外起定时器：screenMessage 每次调用顺带清一次，清理频率天然跟随弹幕频率。
 *
 * @param {{lastByUid:Map, recentTexts:Map}} state
 * @param {number} now
 * @param {number} cooldownSec - lastByUid 的保留窗口
 * @param {number} dedupSec    - recentTexts 的保留窗口
 */
function _pruneState(state, now, cooldownSec, dedupSec) {
	const coolCut = now - cooldownSec * 1000
	const dedupCut = now - dedupSec * 1000
	for (const [k, ts] of state.lastByUid) {
		if (ts < coolCut) state.lastByUid.delete(k)
	}
	for (const [k, ts] of state.recentTexts) {
		if (ts < dedupCut) state.recentTexts.delete(k)
	}
}

/**
 * 判断文本/用户是否命中黑名单。
 *
 * 黑名单【名单本身】住 per-user config（capabilities 只管开关），形状：
 *   config.filter.blacklist = { uids: string[], users: string[], words: string[] }
 * 三类都可缺省（缺 = 该类不参与判定）。
 *
 * @param {LiveMessage} msg
 * @param {object} blacklist
 * @returns {boolean}
 */
function _hitBlacklist(msg, blacklist) {
	if (!blacklist || typeof blacklist !== 'object') return false
	const uids = Array.isArray(blacklist.uids) ? blacklist.uids : null
	if (uids && uids.includes(msg.uid)) return true
	const users = Array.isArray(blacklist.users) ? blacklist.users : null
	if (users && users.includes(msg.user)) return true
	const words = Array.isArray(blacklist.words) ? blacklist.words : null
	if (words && words.some((w) => w && msg.text.includes(w))) return true
	return false
}

/**
 * 单条弹幕初筛。
 *
 * 判定顺序（先便宜后昂贵，先确定性强后弱）：
 *   ① 空文本 → ② 长度 → ③ 黑名单 → ④ 关键词 → ⑤ 用户冷却 → ⑥ 文本去重
 *   ⚠ 顺序影响 reason 的归因：一条既超长又在黑名单的弹幕，reason 报 too_long。
 *     这是刻意的——面板统计想看"最主要的拦截原因是什么"，先报最便宜那层更有信息量。
 *
 * @param {LiveMessage} msg
 * @param {object} rules - resolveLiveRules 返回值（用 rules.filter；调用前 assertFilterRules 过一次）
 * @param {{lastByUid:Map<string,number>, recentTexts:Map<string,number>}} state - createScreenState() 产出，本函数会 mutate
 * @param {object} [userConfig] - per-user config.filter（黑名单/关键词表住这里，非 capabilities）
 * @returns {ScreenResult}
 */
export function screenMessage(msg, rules, state, userConfig) {
	const f = rules.filter
	const now = Number.isFinite(msg?.ts) ? msg.ts : Date.now()

	// 顺带清理过期记账（惰性 GC，见 _pruneState）
	_pruneState(state, now, f.userCooldownSec, f.dedupWindowSec)

	const text = typeof msg?.text === 'string' ? msg.text.trim() : ''

	// ① 空文本（enter 类进场消息天然无文本）
	if (!text) return { pass: false, reason: SCREEN_REASONS.EMPTY }

	// ② 长度
	if (text.length < f.minLength) return { pass: false, reason: SCREEN_REASONS.TOO_SHORT }
	if (text.length > f.maxLength) return { pass: false, reason: SCREEN_REASONS.TOO_LONG }

	// ③ 黑名单（开关在 capabilities，名单在 per-user config）
	if (f.blacklistEnabled && _hitBlacklist(msg, userConfig?.blacklist)) {
		return { pass: false, reason: SCREEN_REASONS.BLACKLIST }
	}

	// ④ 关键词（模式在 capabilities，词表在 per-user config）
	if (f.keywordMode === 'include' || f.keywordMode === 'exclude') {
		const words = Array.isArray(userConfig?.keywords) ? userConfig.keywords.filter(Boolean) : []
		// 词表为空 = 用户开了模式但没填词 → 不做判定（诚实降级：不因为空词表把所有弹幕拦光）
		if (words.length) {
			const hit = words.some((w) => text.includes(w))
			if (f.keywordMode === 'include' && !hit) return { pass: false, reason: SCREEN_REASONS.KEYWORD_MISS }
			if (f.keywordMode === 'exclude' && hit) return { pass: false, reason: SCREEN_REASONS.KEYWORD_HIT }
		}
	}

	// ⑤ 用户冷却（同一 uid 距上次【通过】不足 N 秒）
	if (f.userCooldownSec > 0) {
		const last = state.lastByUid.get(msg.uid)
		if (Number.isFinite(last) && now - last < f.userCooldownSec * 1000) {
			return { pass: false, reason: SCREEN_REASONS.USER_COOLDOWN }
		}
	}

	// ⑥ 文本去重（窗口内完全相同的文本只放行一次——刷屏跟风的"哈哈哈"只进一条）
	if (f.dedupWindowSec > 0) {
		const lastSame = state.recentTexts.get(text)
		if (Number.isFinite(lastSame) && now - lastSame < f.dedupWindowSec * 1000) {
			return { pass: false, reason: SCREEN_REASONS.DUPLICATE }
		}
	}

	// —— 通过：记账（只记通过项，见 createScreenState 注释）——
	state.lastByUid.set(msg.uid, now)
	state.recentTexts.set(text, now)
	return { pass: true, reason: null }
}
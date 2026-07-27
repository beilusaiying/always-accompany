/**
 * pool.mjs — 候选缓冲区 + 选择器 + 上下文成型（存 → 取 → 成型，一条流水线）。
 *
 * 【为什么这三个住一起】它们是同一条数据流的三段：
 *   push(初筛通过的弹幕) → selectForRound(选出本轮要注入的) → formatForContext(拼成一段文本)
 *   而 filter.mjs 是流水线【入口的闸门】（要不要进来），职责不同故独立成文件。
 *
 * 【两级设计的第一级】（图纸 D4 + 雷区7）：
 *   adapter 的 onMessage 回调只做「初筛 + push 入池」——轻量同步，不碰 AI。
 *   起不起 AI 轮由 runtime 的定时器按 pacing.minRoundIntervalMs 决定（章5）。
 *   ⚠ 爆场时每秒几十条弹幕，每条触发一次 AI = token 爆炸 + 生成锁互撞。
 *
 * 【零默认值】容量/TTL/选择参数全部从 rules 取，本文件【不写 `?? 兜底`】——
 *   单源 = capabilities.mjs LIVE_CAPABILITIES.{pool,selector,contextTemplate}。
 */

/**
 * @typedef {import('./filter.mjs').LiveMessage} LiveMessage
 */

/** pool/selector/contextTemplate 三组的必需键。 */
const _REQUIRED = {
	pool: ['capacity', 'ttlSec'],
	selector: ['recentUserCount', 'includeLastReplied', 'weightByGift'],
	contextTemplate: ['header', 'line', 'giftLine', 'lastRepliedMark', 'separator', 'footer'],
}

/**
 * 启动期校验本模块用到的三组规则。runtime 启动一次即可。
 * @param {object} rules - resolveLiveRules 返回值
 * @throws {Error} 缺键时抛，附键路径
 */
export function assertPoolRules(rules) {
	for (const [group, keys] of Object.entries(_REQUIRED)) {
		const g = rules?.[group]
		if (!g || typeof g !== 'object') {
			throw new Error(`[beilu-live/pool] 缺 rules.${group}（单源=capabilities.mjs LIVE_CAPABILITIES.${group}，本模块不持默认值）`)
		}
		for (const k of keys) {
			if (g[k] === undefined || g[k] === null) throw new Error(`[beilu-live/pool] 缺 rules.${group}.${k}`)
		}
	}
	if (!Number.isFinite(rules.pool.capacity) || rules.pool.capacity < 1) {
		throw new Error(`[beilu-live/pool] rules.pool.capacity 必须是 ≥1 的数字，实际: ${rules.pool.capacity}`)
	}
}

/**
 * 建一个候选缓冲区（环形：满了挤掉最旧的）。
 *
 * 【为什么要挤而不是拒】直播场景下"最新的弹幕"比"最早的弹幕"有价值——
 *   主播看到的是当下的互动。满了拒收新的 = 池子被开播时的旧弹幕永久占满。
 *
 * @param {number} capacity - 池容量（条）。来自 rules.pool.capacity
 * @returns {{push:Function, take:Function, size:Function, prune:Function, snapshot:Function, clear:Function}}
 */
export function createPool(capacity) {
	if (!Number.isFinite(capacity) || capacity < 1) {
		throw new Error(`[beilu-live/pool] createPool(capacity) 需要 ≥1 的数字，实际: ${capacity}`)
	}
	/** @type {LiveMessage[]} 按入池顺序（旧 → 新） */
	let buf = []

	return {
		/**
		 * 入池。满了挤掉最旧的。
		 * @param {LiveMessage} msg
		 * @returns {LiveMessage|null} 被挤出的那条（无则 null，供调用方统计"因池满丢弃"）
		 */
		push(msg) {
			buf.push(msg)
			if (buf.length > capacity) return buf.shift() || null
			return null
		},

		/**
		 * 取出【全部】并清空（一轮消费完就清——已注入过的不该再注入第二次）。
		 * @returns {LiveMessage[]}
		 */
		take() {
			const out = buf
			buf = []
			return out
		},

		/** 当前条数。 */
		size() { return buf.length },

		/**
		 * 清理过期项（超过 ttlSec 的弹幕不再有注入价值）。
		 * @param {number} ttlSec
		 * @param {number} [now=Date.now()]
		 * @returns {number} 清掉的条数
		 */
		prune(ttlSec, now = Date.now()) {
			if (!Number.isFinite(ttlSec) || ttlSec <= 0) return 0
			const cut = now - ttlSec * 1000
			const before = buf.length
			buf = buf.filter((m) => Number.isFinite(m?.ts) && m.ts >= cut)
			return before - buf.length
		},

		/** 只读快照（不清空，面板展示/调试用）。 */
		snapshot() { return buf.slice() },

		/** 清空（停止会话时用）。 */
		clear() { buf = [] },
	}
}

/**
 * 从一批候选里选出本轮要注入上下文的弹幕。
 *
 * 002 原话：「每次对话完注入刚刚回复的用户 + 最近10条用户的上下文选择回复」
 *   → recentUserCount（默认 10，可调）= "最近N条"
 *   → includeLastReplied = "刚刚回复的用户"（其弹幕优先保留，即使超出 N 条名额）
 *
 * 【选择规则】
 *   1. 若 includeLastReplied 且 lastRepliedUid 有值：该 uid 的弹幕【全部】先入选（保连续性——
 *      主播刚回过这个人，他的后续话不该被截断）
 *   2. 其余按【优先级】排序后取满 recentUserCount：
 *      weightByGift=true 时，有 weight 的（礼物/SC）排在前；同档内按时间【新的在前】
 *   3. 最终输出按【时间正序】（旧→新）——上下文里对话顺序要自然
 *
 * @param {LiveMessage[]} candidates - 通常来自 pool.take()
 * @param {object} rules - resolveLiveRules 返回值（用 rules.selector）
 * @param {string} [lastRepliedUid] - 上一轮 AI 回复针对的 uid（无则不启用规则1）
 * @returns {LiveMessage[]} 选中的弹幕（时间正序）
 */
export function selectForRound(candidates, rules, lastRepliedUid) {
	const s = rules.selector
	const list = Array.isArray(candidates) ? candidates.slice() : []
	if (!list.length) return []

	const limit = s.recentUserCount

	// 规则1：刚回复过的用户，其弹幕全部先入选
	let priority = []
	let rest = list
	if (s.includeLastReplied && lastRepliedUid) {
		priority = list.filter((m) => m.uid === lastRepliedUid)
		rest = list.filter((m) => m.uid !== lastRepliedUid)
	}

	// 规则2：其余按优先级排序取满名额
	const slots = Math.max(0, limit - priority.length)
	if (slots > 0 && rest.length) {
		rest.sort((a, b) => {
			if (s.weightByGift) {
				const wa = Number.isFinite(a.weight) ? a.weight : 0
				const wb = Number.isFinite(b.weight) ? b.weight : 0
				if (wa !== wb) return wb - wa // 权重高的在前
			}
			return (b.ts || 0) - (a.ts || 0)   // 同档内新的在前
		})
		priority = priority.concat(rest.slice(0, slots))
	}

	// 规则3：最终按时间正序输出（上下文里对话顺序要自然）
	return priority.sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

/**
 * 占位符字面替换。未知占位符【原样保留】（用户写错时看得见，而不是静默变空）。
 * @param {string} tpl
 * @param {Record<string,string|number>} vars
 * @returns {string}
 */
function _fill(tpl, vars) {
	if (typeof tpl !== 'string' || !tpl) return ''
	return tpl.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole))
}

/**
 * 把选中的弹幕拼成一条【用户侧消息文本】，交给主链的 addUserReply。
 *
 * ⚠⚠ 【禁止项7 的落点】进 messages 的文本【必须来自用户可配置项】——
 *   本函数的全部文案来自 rules.contextTemplate（capabilities 三层可覆盖），
 *   代码里【零硬编码文案】。后续维护者禁在此处写死任何提示语/前缀/标点。
 *
 * @param {LiveMessage[]} messages - selectForRound 的产出
 * @param {object} rules - resolveLiveRules 返回值（用 rules.contextTemplate）
 * @param {string} [lastRepliedUid] - 该 uid 的行会带上 lastRepliedMark 标记
 * @returns {string} 拼好的文本（无消息时返回空串——调用方据此跳过本轮）
 */
export function formatForContext(messages, rules, lastRepliedUid) {
	const t = rules.contextTemplate
	const list = Array.isArray(messages) ? messages : []
	if (!list.length) return ''

	const mark = t.lastRepliedMark || ''

	const lines = list.map((m) => {
		const isGift = m.type === 'gift' || m.type === 'superchat'
		const tpl = isGift ? t.giftLine : t.line
		return _fill(tpl, {
			user: m.user || '',
			text: m.text || '',
			weight: Number.isFinite(m.weight) ? m.weight : 0,
			mark: (lastRepliedUid && m.uid === lastRepliedUid) ? mark : '',
		})
	})

	const body = lines.join(t.separator || '')
	const header = _fill(t.header, { count: list.length })
	const footer = _fill(t.footer, { count: list.length })
	const sep = t.separator || ''

	// header/footer 为空串时不产生多余分隔符
	return [header, body, footer].filter(Boolean).join(sep)
}
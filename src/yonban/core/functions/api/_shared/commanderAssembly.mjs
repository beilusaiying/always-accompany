// ============================================================================
// _shared/commanderAssembly.mjs
// H1 司令员 commander_mode 五段拼装共享层（A6 共享层推广 2026-06-10）
// !!!禁止放入提示词!!! 提示词文本只允许住 INJ 条目和预设（凛倾 0722）。本层只做五段排序拼装，
//   禁止硬编码任何进 messages 的文本；动态内容必须在 below 段（尾部），混进 before/above=缓存前缀失效。
// ----------------------------------------------------------------------------
// 背景：proxy/gemini/grok/claude/claude-api/ollama 六家 provider 各自有物理复制的
//       commander 五段拼装分支（A6 复核坐实 6/6 真分支）。本模块把公共的「五段排序
//       + 缓存边界优化 + Anthropic 顶层 system 提取」收敛为单一权威源，六家改调本层。
//
// 设计基准：proxy/main.mjs:152-194 的五段语义（before + above + chat + below + after），
//       其中 above=@D>=1（聊天上方）、below=@D=0（聊天下方），保留 U 形位置控制。
//       缓存边界优化 = proxy:174-186 的「>1000 字 below[0]（memory_data）移到 chat 倒数
//       第 1 条前，贴缓存边界，不变时缓存命中」——A6 报告「缓存优化」即指此项（非结果记忆化）。
//
// 为什么参数化而非「一个函数返回最终 messages」：六家在三个不同层、产出三种不同形状：
//   - proxy：最终 API messages（toApiMsg 保留 _identifier/_section/_name/_source）
//   - grok/claude/ollama：简单 {role,content}（ollama 复用已转换 messages 含图片）
//   - gemini：Gemini parts 形状（role→model，system 前缀 `system:\n`）
//   - claude-api：原始 chat-log entry + 顶层 params.system 提取（Anthropic 协议约束）
// 形状不可直接互换，否则会改字节输出。故共享层只收敛「五段排序逻辑 + 缓存边界 + system
// 提取」这三条所有 provider 共享的语义，by 把「段消息形状映射」(mapMsg) 与「聊天段」
// (chatSegment) 留给各 provider 注入——这样六家字节等价，公共逻辑单一权威。
// ============================================================================

// 司令员期望的四段字段（canonical）。preset 改字段名/类型 → 各 provider `?.`+`||[]` 静默退化为
// 空段、门控双值 `&&` 静默转 false，全程无告警。P-E：在共享层集中做一次 schema 校验，命中异常
// 只告警不 throw（不改产出），对齐 beilu-preset FT8-2 逐条校验范式。

const _COMMANDER_SEGMENT_FIELDS = ['beilu_preset_before', 'beilu_injection_above', 'beilu_injection_below', 'beilu_preset_after']

/**
 * 校验 commander preset 段字段的存在性 + 类型。被 assemble* 调用 = 走到这里说明门控已过、本应有段内容。
 * 命中异常用 onWarn（缺省 console.warn）告警，绝不 throw。
 * @param {object} presetExt
 * @param {(msg:string, issues:string[])=>void} [onWarn]
 * @returns {string[]} issues（空=正常）
 */
export function validateCommanderPreset(presetExt, onWarn) {
	const issues = []
	if (!presetExt || typeof presetExt !== 'object') {
		issues.push('presetExt 缺失或非对象')
	} else {
		for (const f of _COMMANDER_SEGMENT_FIELDS) {
			const v = presetExt[f]
			if (v !== undefined && v !== null && !Array.isArray(v))
				issues.push(`${f} 应为数组，实为 ${typeof v}`)
		}
		const _nonEmpty = _COMMANDER_SEGMENT_FIELDS.filter(f => Array.isArray(presetExt[f]) && presetExt[f].length > 0)
		if (_nonEmpty.length === 0)
			issues.push(`四段(${_COMMANDER_SEGMENT_FIELDS.join('/')})全空或缺席——门控已过却无段内容，疑似 preset 字段改名/结构漂移，commander 将产出空段`)
	}
	if (issues.length > 0) {
		const msg = `[commanderAssembly] preset schema 异常: ${issues.join('; ')}`
		if (typeof onWarn === 'function') { try { onWarn(msg, issues) } catch { /* 遥测失败不影响主逻辑 */ } }
		else console.warn(msg)
	}
	return issues
}

/**
 * 司令员模式五段消息拼装（共享层）。
 *
 * 段序（canonical，对齐 02_设计总图 5.1）：
 *   beforeChat(头部预设) + injectionAbove(@D>=1) + chatSegment(聊天) + injectionBelow(@D=0) + afterChat(尾部预设)
 *
 * @param {object} presetExt - prompt_struct.plugin_prompts['beilu-preset'].extension
 *   读取 beilu_preset_before / beilu_injection_above / beilu_injection_below / beilu_preset_after
 * @param {object} opts
 * @param {(m:any)=>any} opts.mapMsg     - 把预设/注入段的原始 msg 映射为 provider 目标形状（必填）
 * @param {any[]}        opts.chatSegment - provider 已构建好的聊天段（已是目标形状，必填）
 * @param {boolean}      [opts.extractSystem=false] - 是否抽取 before+after 为顶层 system（claude-api/Anthropic 语义）；
 *                                                    为 true 时 before/after 不进 messages 序列
 * @param {string}       [opts.systemJoiner='\n\n'] - extractSystem 时拼接 before/after 文本的分隔符
 * @param {(content:any)=>number} [opts.contentLen] - 取 mapMsg 产物的 content 长度（缓存边界判定用）；
 *                                                    默认按 String/Array 自适应
 * @param {{fn:Function,mode:string}} [opts.postProcess] - 可选 postProcessMessages 透传（mode!=='none' 才应用）
 * @returns {{messages:any[], systemOverride:string}}
 *   messages: 拼好的五段（extractSystem 时不含 before/after）
 *   systemOverride: extractSystem 时为 before+after 拼接文本，否则 ''
 */
export function assembleCommanderMessages(presetExt, opts = {}) {
	const {
		mapMsg,
		chatSegment = [],
		extractSystem = false,
		systemJoiner = '\n\n',
		contentLen,
		postProcess,
	} = opts
	if (typeof mapMsg !== 'function')
		throw new TypeError('[commanderAssembly] opts.mapMsg 必填（provider 段形状映射）')
	validateCommanderPreset(presetExt, opts.onWarn) // P-E：集中 schema 校验，异常只告警不 throw

	// [0807 EJS 链收尾·凛倾"怎么控制实际内容输出"最后一环] 空 content 过滤：EJS 条件门控
	//   （<% if(stat_data.x>=N){ %>…<% } %>）不满足时条目渲染成空串/纯空白——此前会以
	//   {role, content:""} 空消息进 messages（发给 API=渣，部分渠道 400）。判据含 trim：
	//   if 块不成立时 EJS 常留换行空白。系统段（extractSystem 分支）原有 .filter(Boolean)
	//   只滤全空不滤空白，此处统一在段源头过滤=两分支同得干净零输出语义。
	const _nonEmpty = (arr) => (arr || []).filter((m) => {
		const c = m?.content
		if (typeof c === 'string') return c.trim().length > 0
		return !!c // 多模态数组等非字符串形态保留（由 provider 层自校验）
	})
	const _before = _nonEmpty(presetExt?.beilu_preset_before)
	const _above = _nonEmpty(presetExt?.beilu_injection_above)
	const _below = _nonEmpty(presetExt?.beilu_injection_below)
	const _after = _nonEmpty(presetExt?.beilu_preset_after)

	// 内容长度取值：默认 String 取 .length，Array（多模态 parts）取各 text 之和，其它 0。
	const _len = typeof contentLen === 'function'
		? contentLen
		: (c) => {
			if (typeof c === 'string') return c.length
			if (Array.isArray(c)) return c.reduce((s, p) => s + (typeof p?.text === 'string' ? p.text.length : 0), 0)
			return 0
		}

	// 聊天段做本地副本，缓存边界移动只动临时数组，绝不碰 chat_log / 调用方原数组。
	let _chatMsgs = chatSegment.slice()
	let _belowMsgs = _below.map(mapMsg)

	// [0722 凛倾定案「宏在哪里，位置就在那里」] 原"缓存边界优化"（把 below 中 >1000 字 data 块
	//   搬进 chatMsgs 倒数第 1 条前）已连根删除：data 每轮变 + 插入点随聊天增长每轮移 =
	//   历史区内容逐轮改写 = 提示词缓存击穿（I2 跨天确诊的搬移病根，与设计初衷相反）。
	//   -data 条目今后固定留在 below 段（条目声明的 depth:0 位置=聊天下方），断点由消费方
	//   打在 volatileStart 前 = 聊天尾部，数据变化不再波及历史区。

	let systemOverride = ''
	let messages
	// 易变区起点（0716 缓存断点对齐反代）：below 段（@D=0 注入，-data/记忆等每轮变）在 messages 中的
	// 起点下标 = chat 段结束点（0722 起 data 块不再前移，边界即段边界）。
	// 消费方（claude-api 等官方直连渠道）据此打 bp2=volatileStart-2——providerPatch 在事后靠
	// _identifier/-data 元数据反推同一边界，本层在组装现场直接知道段边界（mapMsg 产物无元数据也可用）。
	let volatileStart
	if (extractSystem) {
		// Anthropic 约束：system 独立顶层、messages 仅 user/assistant。
		// before/after（系统段）→ systemOverride；above + chat + below → messages。
		systemOverride = [..._before, ..._after]
			.map(m => m.content || '')
			.filter(Boolean)
			.join(systemJoiner)
		messages = [
			..._above.map(mapMsg),
			..._chatMsgs,
			..._belowMsgs,
		]
		volatileStart = _above.length + _chatMsgs.length
	} else {
		messages = [
			..._before.map(mapMsg),
			..._above.map(mapMsg),
			..._chatMsgs,
			..._belowMsgs,
			..._after.map(mapMsg),
		]
		volatileStart = _before.length + _above.length + _chatMsgs.length
	}

	// 可选 postProcess 透传（provider 各自传入自家 postProcessMessages，mode!=='none' 才应用）。
	if (postProcess && typeof postProcess.fn === 'function' && postProcess.mode && postProcess.mode !== 'none') {
		messages = postProcess.fn(messages, postProcess.mode)
		volatileStart = -1 // postProcess 可 merge/增删消息，段边界失准——消费方回退位置启发式
	}

	return { messages, systemOverride, volatileStart }
}

// [0722 审计 M5] R6 dedup 残留死代码已删除：assembleCommanderSegments / simpleRoleMapper /
//   buildPlainChatSegment 三个 export 全库零调用方（各家 generator 已改走 buildMessagesFromPromptStruct，
//   共享函数收敛后无人接线）。恢复参照备份 audit_fix_20260722_2110/_shared_commanderAssembly.mjs。

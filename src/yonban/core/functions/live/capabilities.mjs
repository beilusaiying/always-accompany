/**
 * capabilities.mjs — 直播接入能力谱（全局出厂默认 + data/live_capabilities.json 覆盖）。
 *
 * 单源权威（002 禁硬编码范式，照 airp/capabilities.mjs:30 AIRP_CAPABILITIES / :97 loadAirpCapabilities）：
 *   初筛规则 / 缓冲区 / 选择策略 / 节奏 / 辅助AI 的【唯一出厂默认】住这里的 LIVE_CAPABILITIES 常量。
 *   全局覆盖：data/live_capabilities.json 顶层键 merge（改阈值/加平台/调值域=改数据文件，不改源码）。
 *   个人覆盖：per-user 层在 main.mjs（data/users/<user>/live/config.json），消费时叠加在本谱之上。
 *   → 有效值 = LIVE_CAPABILITIES ← data/live_capabilities.json（全局） ← per-user config（个人）。任何消费方零本地副本。
 *
 * 铁律(002)：「我说的参数只是参照，禁止硬编码，用户需要可以设置一切」。
 *   ↳ 常量=代码持出厂默认(合规)；全局 data 文件可改；per-user 可改。三层皆非写死。
 *   ↳ 002 原话"最近10条用户"落为 selector.recentUserCount.default=10（带 min/max），不是写死的 10。
 *
 * 【两种形态，别混】——本文件同时提供：
 *   ① 能力谱形态 {default, min, max, options}：控件描述。前端据此渲染 input 的 min/max、select 的 options。
 *   ② 运行值形态 {minLength: 2, ...}：扁平实际值。filter/runtime/assistant 等后端消费方据此工作。
 *   ①→② 的转换收口在本文件 resolveLiveRules()，【消费方禁自行 `.default ?? 兜底`】——散写=同一默认值多处副本。
 */
import fs from 'node:fs'
import { join } from 'node:path'

/**
 * 直播接入能力出厂默认。
 * 每项为【控件描述】：number 类给 {default,min,max}，boolean 类给 {default}，枚举类给 {options,default}。
 * 全部为【示意默认】——002 玩起来后按体验调，改这里、改 data/live_capabilities.json、或在面板改 per-user 均可。
 * @type {{
 *   filter: {
 *     minLength: {default:number,min:number,max:number},
 *     maxLength: {default:number,min:number,max:number},
 *     userCooldownSec: {default:number,min:number,max:number},
 *     dedupWindowSec: {default:number,min:number,max:number},
 *     blacklistEnabled: {default:boolean},
 *     keywordMode: {options:string[], default:string}
 *   },
 *   pool: {capacity:{default:number,min:number,max:number}, ttlSec:{default:number,min:number,max:number}},
 *   selector: {
 *     recentUserCount:{default:number,min:number,max:number},
 *     includeLastReplied:{default:boolean},
 *     weightByGift:{default:boolean}
 *   },
 *   pacing: {minRoundIntervalMs:{default:number,min:number,max:number}, idleSkip:{default:boolean}},
 *   connection: {
 *     heartbeatMs:{default:number,min:number,max:number},
 *     maxRetries:{default:number,min:number,max:number},
 *     retryBaseMs:{default:number,min:number,max:number},
 *     retryFactor:{default:number,min:number,max:number},
 *     retryMaxMs:{default:number,min:number,max:number},
 *     httpTimeoutMs:{default:number,min:number,max:number}
 *   },
 *   platformProtocol: Record<string, {
 *     apiRoomInit:string, apiDanmuInfo:string, okCode:number, fallbackHost:string, wsPath:string,
 *     userAgent:string, referer:string, headerLen:number,
 *     ops:{heartbeat:number,heartbeatReply:number,message:number,auth:number,authReply:number},
 *     protovers:{json:number,heartbeat:number,zlib:number,brotli:number},
 *     auth:{uid:number,platform:string,type:number,protover:number,sequence:number},
 *     cmds:{danmaku:string,gift:string,superchat:string,enter:string},
 *     cookieMap:Record<string,string>
 *   }>,
 *   assistant: {
 *     enabled:{default:boolean},
 *     everyNRounds:{default:number,min:number,max:number},
 *     sourceName:{default:string}
 *   }
 * }}
 * ⚠ platformProtocol 【不用】{default,...} 控件描述形态——它是嵌套协议规格，
 *   resolveLiveRules 对它整组透传不做摊平（见 _PASSTHROUGH_GROUPS）。
 */
export const LIVE_CAPABILITIES = {
	// 初筛规则（章4 filter.mjs 消费）：纯算法零 AI 调用，不通过返回 reason 不静默丢弃。
	filter: {
		minLength: { default: 2, min: 0, max: 50 },          // 弹幕最短字数(短于此丢弃，滤掉"6"/"?"类噪声)
		maxLength: { default: 100, min: 10, max: 500 },      // 弹幕最长字数(长于此丢弃，防刷屏长文)
		userCooldownSec: { default: 30, min: 0, max: 600 },  // 同一 uid 冷却秒数(0=不限，防单人刷屏霸屏)
		dedupWindowSec: { default: 60, min: 0, max: 600 },   // 重复文本去重窗口秒数(0=不去重)
		blacklistEnabled: { default: true },                 // 黑名单开关(名单本身住 per-user config，非本谱)
		keywordMode: { options: ['off', 'include', 'exclude'], default: 'off' }, // 关键词模式(词表住 per-user config)
	},

	// 候选缓冲区（章4）：环形缓冲，满了挤掉最旧的。
	pool: {
		capacity: { default: 200, min: 20, max: 2000 },  // 池容量(条)
		ttlSec: { default: 300, min: 30, max: 3600 },    // 候选过期秒数(超时的弹幕不再进上下文)
	},

	// 选择策略（章4 选择器）：决定每轮把哪些弹幕拼进上下文。
	selector: {
		recentUserCount: { default: 10, min: 1, max: 50 }, // ← 002原话"最近10条用户的上下文"落为默认值(可调)
		includeLastReplied: { default: true },             // ← 002原话"注入刚刚回复的用户"
		weightByGift: { default: true },                   // 礼物/SC(LiveMessage.weight)加权优先选中
	},

	// 节奏（章5 runtime.mjs）：两级设计的第二级——弹幕入池是轻量同步，起 AI 轮由本组节流。
	//   ⚠ 不做 gameCompanion 的频率自适应(silence/close 降频)：那是截图打扰场景的语义，直播无对应(图纸 D4)。
	pacing: {
		minRoundIntervalMs: { default: 3000, min: 500, max: 60000 }, // 两轮 AI 生成的最小间隔(防爆场 token 爆炸)
		idleSkip: { default: true },                                 // 池空则跳过本轮(不调 AI，省 token)
	},

	// 连接行为（章3 adapter 消费）：重连退避与心跳的【行为参数】。
	//   图纸章3 原文要求「重连退避照 websocket.mjs:699 既有范式 Math.min(3000*1.5^(fails-1),30000)，
	//   MAX_RETRIES 走 capabilities 可配」——本组即该要求的落点（图纸 §3.3 schema 未列此组，属图纸内部缺口，此处补齐）。
	//   与 platformProtocol 组的分工见该组注释（行为参数 vs 协议参数，两组都可配，改的东西不同）。
	connection: {
		heartbeatMs: { default: 30000, min: 5000, max: 30000 },  // 心跳间隔(毫秒)。⚠ B站协议要求 ≤30s 否则服务器断连，故 max 封顶 30000
		maxRetries: { default: 10, min: 0, max: 100 },           // 断线重连最大次数(0=不重连)。照 websocket.mjs:699 既有 MAX_RETRIES=10
		retryBaseMs: { default: 3000, min: 500, max: 60000 },    // 退避基数(毫秒)：Math.min(base * factor^(fails-1), retryMaxMs)
		retryFactor: { default: 1.5, min: 1, max: 5 },           // 退避指数因子
		retryMaxMs: { default: 30000, min: 1000, max: 300000 },  // 单次退避上限(毫秒)
		httpTimeoutMs: { default: 15000, min: 3000, max: 60000 },// 建连前两个 HTTP 接口(房间信息/弹幕token)的超时
	},

	// ============================================================
	// 平台协议参数（章3 adapter 消费）——002 于 2026-07-25 拍板：「协议常量…这些需要可以配置」
	// ============================================================
	//
	// 【为什么可配（002 的判断，工程上也成立）】：
	//   平台改协议（换 API 路径 / 加 op 码 / 改 cmd 名）时，改 data/live_capabilities.json 即可，
	//   不必改源码 + 重启后端（Deno 无热卸载，改后端 = reloadPart 重启进程，parts_loader.mjs:600）。
	//
	// 【与 connection 组的分工】：两组都可配，改的东西不同——
	//   connection      = 行为参数：心跳多久发一次 / 断线重连几次 / 超时多久（用户按网络状况调）
	//   platformProtocol = 协议参数：接口地址 / 操作码 / 包头长度 / 消息类型名（平台改协议时调）
	//
	// 【形态：本组【不用】{default,min,max} 控件描述形态】
	//   其余六组是「一个参数 = 一个控件」，故带 min/max 供前端渲染 input。
	//   本组是「一份协议规格」，结构是嵌套对象（ops/protovers/auth/cmds/cookieMap），
	//   前端若要做协议编辑界面，形态是 JSON 编辑框而非 input 组，不需要 min/max。
	//   → resolveLiveRules 对本组【整组原样透传】不做摊平（见该函数 _PASSTHROUGH_GROUPS）。
	//
	// 【单源约束】：adapter（adapters/bilibili.mjs）【零协议常量、零兜底默认值】——
	//   它的 _assertProtocol 校验本组的 12 个必需键，缺任一即拒绝连接并报出键路径。
	//   ⚠ 后续维护者禁在 adapter 里写 `?? 默认值`：那会造出第二份默认值，
	//     出现"改了配置却仍走旧值"的分叉，且分叉点极难查（配置读对了，但被兜底覆盖）。
	//
	// ⚠⚠ 【跨文件隐式契约】cookieMap 的【左侧 key】必须与 registry.mjs 该平台
	//   credentials[].key 严格一致（当前：biliSessdata / biliBuvid3）。
	//   改一处不改另一处的后果：用户在面板填了凭据 → adapter 读不到 → 静默降级成未登录，
	//   表现是"填了 SESSDATA 但还是只收到部分弹幕"，不报错、极难查。
	//
	// ⚠ 【反向回灌风险】本组值一旦被整份写进 per-user config（data/users/<u>/live/config.json），
	//   平台改协议时出厂默认的新值会被用户文件里的旧值覆盖 → 永久连不上。
	//   SetData 只收差异层（main.mjs SetData 注释同款约束），前端禁把 GetData 的 capabilities 整个回传。
	//
	// ⚠ 【当前值的可信度】以下 bilibili 协议值来自设计推导，**尚未经真实连接实测验证**
	//   （图纸 §3.4 断言 A1：Deno 原生 WebSocket 可连 B 站弹幕服务器 —— 待证）。
	//   实测与此不符时，改本组的值（不改 adapter 源码），这正是本组可配的价值。
	platformProtocol: {
		bilibili: {
			// —— HTTP 前置两接口（roomId 拼在 URL 末尾，故以 = 结尾）——
			apiRoomInit: 'https://api.live.bilibili.com/room/v1/Room/room_init?id=',
			//   ⚠ getDanmuInfo 走 WBI 签名时【不带 query】，参数由 _wbiSign 统一排序后拼接，故此项以 ? 结尾
			apiDanmuInfo: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?',
			danmuInfoParams: { type: 0 },                 // getDanmuInfo 的固定参数（id 由代码填真实 room_id）
			okCode: 0,                                    // 业务成功码（json.code === okCode 才算成功）

			// —— WBI 风控签名（2026-07-25 实测：不签名一律 -352，签名+真buvid3 才 code=0）——
			//   实测矩阵（房间 5440，见本会话探针）：
			//     只带 UA/Referer/Origin        → -352
			//     + 自生成 buvid3               → -352
			//     + 页面 set-cookie             → -352（直播页不下发 cookie）
			//     + 真 buvid3(finger/spi)       → -352
			//     + WBI 签名，无 cookie         → -352
			//     + WBI 签名 + 真 buvid3        → ✅ code=0，token 248 字符，6 个 host
			//   → 两个凭据【同时】具备才放行，缺一不可。
			wbiEnabled: true,                             // 关掉=不签名（若平台未来取消风控，改这里而非改源码）
			apiNav: 'https://api.bilibili.com/x/web-interface/nav',        // 取 wbi_img.img_url / sub_url
			apiFingerSpi: 'https://api.bilibili.com/x/frontend/finger/spi', // 取真 buvid3(b_3) / buvid4(b_4)
			navReferer: 'https://www.bilibili.com/',      // nav/finger 用主站 Referer（非直播站）
			wbiCacheTtlMs: 21600000,                      // wbi key 与 buvid 的缓存时长(6h)。平台 key 约每日更新，取其 1/4 留足余量
			//   mixin 重排表：img_key+sub_key 拼成 64 字符原串后，按本表的下标顺序取字符，前 32 位即 mixin_key。
			//   这是平台前端 JS 里的固定表（实测有效）。表变了改这里。
			wbiMixinTab: [
				46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
				27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
				37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
				22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
			],
			fallbackHost: 'broadcastlv.chat.bilibili.com', // getDanmuInfo 未返回 host_list 时的兜底弹幕服务器
			wsPath: '/sub',                               // wss://{host}{wsPath}

			// —— 请求头（缺 UA/Referer 会被平台风控拦截）——
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			referer: 'https://live.bilibili.com/',

			// —— 包头布局：totalLen(u32) headerLen(u16) protover(u16) operation(u32) sequence(u32) ——
			headerLen: 16,

			// —— 操作码 ——
			ops: {
				heartbeat: 2,       // 客户端 → 服务端：心跳
				heartbeatReply: 3,  // 服务端 → 客户端：人气值（心跳回复，不产出消息）
				message: 5,         // 服务端 → 客户端：业务消息（弹幕/礼物/进场…）
				auth: 7,            // 客户端 → 服务端：认证
				authReply: 8,       // 服务端 → 客户端：认证结果
			},

			// —— 协议版本（包头 offset 6, uint16）：决定 body 怎么解 ——
			protovers: {
				json: 0,       // body 是裸 JSON
				heartbeat: 1,  // body 是人气值 int32（op=3 时）
				zlib: 2,       // body 是 deflate 压缩的【多个完整包】
				brotli: 3,     // body 是 brotli 压缩的【多个完整包】
			},

			// —— 认证包字段（op=7 的 body JSON）——
			auth: {
				uid: 0,          // 0=游客身份（可见范围由 getDanmuInfo 返回的 token 决定，非此字段）
				platform: 'web',
				type: 2,
				protover: 3,     // 向服务端声明客户端支持 brotli（服务端据此选压缩方式）
				sequence: 1,     // 上行包 sequence（协议要求 ≥1，服务端不校验具体值）
			},

			// —— 业务消息类型名（adapter 据此判定该产出哪种 LiveMessage.type）——
			//   danmaku 用【前缀】匹配（实际 cmd 常带后缀，如 DANMU_MSG:4:0:2:2:2:0）；其余为全等匹配。
			cmds: {
				danmaku: 'DANMU_MSG',
				gift: 'SEND_GIFT',
				superchat: 'SUPER_CHAT_MESSAGE',
				enter: 'INTERACT_WORD',
			},

			// —— 凭据 key → 平台 Cookie 字段名 ——
			//   左侧 = registry.mjs credentials[].key（用户在面板填的那个格子）
			//   右侧 = 平台 Cookie 里的字段名（拼进 HTTP 请求头）
			//   ⚠ 左侧改名必须同步 registry.mjs，见本组顶部「跨文件隐式契约」
			cookieMap: {
				biliSessdata: 'SESSDATA',
				biliBuvid3: 'buvid3',
			},
		},
	},

	// 上下文拼装模板（章4 pool.formatForContext 消费）——图纸章4 原文：
	//   「上下文拼装：选出的弹幕拼成一条用户侧消息文本，格式走 capabilities 里的模板
	//     （**不在代码里写死文案**——撞禁止项7「禁对话链任何硬编码文本」）」
	//   ⚠ 图纸 §3.3 schema 未列本组（属图纸内部缺口，同 connection 组），此处补齐。
	//
	// 【为什么必须可配（禁止项7 + 002 铁律）】：
	//   本组的字符串会【进入 messages 进对话链】——这正是禁止项7 管的东西：
	//   「进 messages 的文本必须来自用户可配置项，代码只持默认值」。
	//   在 filter/pool/runtime 里写死 `用户${user}说：${text}` = 直接违规。
	//
	// 【占位符】（formatForContext 做字面替换，不实现表达式求值）：
	//   {user}   发送者显示名
	//   {text}   弹幕文本
	//   {weight} 礼物/SC 的价值权重（仅 giftLine 用；普通弹幕无此值）
	//   {count}  本轮选中的弹幕条数（仅 header/footer 用）
	//   {mark}   "刚回复过"标记（仅 lastRepliedMark 命中的那行用；未命中时替换为空串）
	//   ⚠ 未知占位符【原样保留】不报错（用户写错时看得见自己写了什么，而不是静默变空）。
	//
	// 【空串=关闭】header/footer/lastRepliedMark 设为 '' 即不输出该部分（不额外加开关，最小）。
	contextTemplate: {
		// 整段开头。{count}=本轮条数。
		header: { default: '[直播弹幕 · 本轮 {count} 条]' },
		// 普通弹幕行。{user}/{text}/{mark}
		line: { default: '{mark}{user}: {text}' },
		// 礼物/SC 行（LiveMessage.type 为 gift/superchat 时用）。{weight}=价值权重
		giftLine: { default: '{mark}{user} [{weight}]: {text}' },
		// 「刚回复过的用户」的标记文本（002原话「注入刚刚回复的用户」的可见落点）。
		//   命中该 uid 的行，{mark} 替换为本值；未命中替换为空串。设为 '' 即不标记。
		lastRepliedMark: { default: '★' },
		// 行间分隔符（默认换行）
		separator: { default: '\n' },
		// 整段结尾（默认空=不输出）
		footer: { default: '' },
	},

	// 辅助AI（章6）：接【既有】引擎 aiRunner.runMemoryPresetAI，不新建 AI 调用逻辑。
	//   ⚠ enabled 与 main.mjs store.enabled 是【两个不同开关】：
	//       store.enabled            = 直播接入总开关(连不连弹幕)
	//       assistant.enabled.default = 辅助AI开关(理不理对话链路)
	//     同名不同义，消费方按路径取值，禁按名字猜。
	assistant: {
		enabled: { default: false },                     // 出厂关(002说"直接用p系列"是回答用什么，非必开)
		everyNRounds: { default: 3, min: 1, max: 20 },   // 每 N 轮主AI后跑一次辅助AI
		sourceName: { default: '' },                     // ''=用记忆AI系统默认源；非空=指定 serviceSources/AI/<name>
		//                                                  ⚠ 非空时调用方必须同传 api_config.use_custom:true，
		//                                                    否则 aiRunner.mjs:397 双条件不成立→静默走默认源(图纸雷区2c)
	},
}

/**
 * 读全局 live 能力谱：出厂默认 LIVE_CAPABILITIES ← data/live_capabilities.json 键级深合并。
 * 惰性读文件(函数体内)，模块顶层零调用——避开 TDZ(禁止项16，0722 全插件 load_failed 事故)。
 * @param {string} projectRoot - 项目根(用于定位 data/live_capabilities.json)
 * @returns {typeof LIVE_CAPABILITIES} 合并后的全局能力谱(键级递归，未提供的键保出厂默认)
 */
export function loadLiveCapabilities(projectRoot) {
	let user = {}
	try {
		const f = join(projectRoot, 'data', 'live_capabilities.json')
		if (fs.existsSync(f)) {
			const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed
		}
	} catch (e) {
		console.warn('[beilu-live] 读取 data/live_capabilities.json 失败，用出厂默认:', e.message)
	}
	// 键级深合并：全局文件覆盖出厂默认(改 minLength.default 不丢 minLength.max 与其余组)
	return _deepMerge(LIVE_CAPABILITIES, user)
}

/**
 * live 私有键级深合并：普通对象递归合并；数组/原始值整体替换（覆盖非累加）。
 * 项目内无通用后端 deepMerge —— 本会话 grep 全项目 `deepMerge|deep_merge|mergeDeep` 得 9 处：
 *   前端 messageList.mjs:432 deepMergeVars(前端+mvu 专用，不跨端) + airp/capabilities.mjs:119 私有一份。
 * 故此处就地私有实现，不导出公共域（与 airp 那份互不引用）。
 * ⚠ 这是后端第【二】份同款实现。若出现第三份，应提炼为公共模块而非再造第四份（单源收口）。
 * @param {object} base - 出厂/全局默认（不被改动）
 * @param {object} override - 覆盖层（用户/个人差异，只需存差异键）
 * @returns {object} 合并后的新对象（base 与 override 均不被 mutate）
 */
function _deepMerge(base, override) {
	if (!override || typeof override !== 'object' || Array.isArray(override)) return base
	const out = Array.isArray(base) ? [...base] : { ...base }
	for (const k of Object.keys(override)) {
		const bv = out[k]
		const ov = override[k]
		if (bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv) && !Array.isArray(ov)) {
			out[k] = _deepMerge(bv, ov) // 普通对象：递归键级合并
		} else {
			out[k] = ov // 数组/原始值/新键：整体替换
		}
	}
	return out
}

/**
 * 解析某 user 的【有效 live 能力谱】= 全局谱(出厂默认 ← data/live_capabilities.json) 深merge 个人覆盖层。
 * 单源收口：初筛/池/选择/节奏/辅助AI 默认值唯一来源=本文件 LIVE_CAPABILITIES；main.mjs 只存/传个人差异，不自持默认。
 * ⚠ 返回的是【合并态】，禁把它整个回写进 per-user config —— 那会把出厂默认烙进用户文件，
 *   以后改出厂默认对老用户零生效。SetData 只收差异层(main.mjs SetData 注释同款约束)。
 * @param {string} projectRoot - 项目根(定位 data/live_capabilities.json)
 * @param {object} [userConfig] - 该 user 的个人覆盖(main.mjs getStore(user).config，只含差异键)
 * @returns {typeof LIVE_CAPABILITIES} 有效能力谱(仍是 {default,min,max} 控件描述形态)
 */
export function resolveEffectiveLive(projectRoot, userConfig) {
	const global = loadLiveCapabilities(projectRoot)
	return _deepMerge(global, userConfig || {})
}

/**
 * 不参与摊平、整组原样透传的组名。
 *
 * 【为什么需要显式声明，而不是靠"它恰好没有 default 键"】：
 *   platformProtocol 的结构是三层（组 → 平台 id → 具体键），且值本身就是嵌套对象
 *   （ops/protovers/auth/cmds/cookieMap）。摊平逻辑只处理两层，对它靠"没有 default 键 → 走
 *   原样透传分支"这个【偶然行为】才恰好正确。
 *   那是隐式契约：哪天有人往协议配置里加一个恰好叫 `default` 的键（比如某平台的默认房间号），
 *   整份协议配置就会被摊成那一个值，adapter 拿到残缺配置 → _assertProtocol 报缺键。
 *   → 显式列出来，把契约写死在代码里。
 */
const _PASSTHROUGH_GROUPS = new Set(['platformProtocol'])

/**
 * 能力谱 → 运行值：把 {default,min,max,options} 控件描述摊平成扁平实际值。
 *
 * 【为什么存在】(图纸未规定此转换住哪，实现层收口决定)：
 *   章4 filter.screenMessage(msg, rules, state) 的 rules 要的是 {minLength:2,...} 扁平值，
 *   章5 前端回填 input.value 要的也是扁平值，章6 取 assistant.everyNRounds 同理。
 *   若各消费方自行 `caps.filter.minLength.default ?? 2`，同一默认值就有了 N 份副本(散拼上下文)。
 *   → 转换唯一住此处，消费方只取结果。
 *
 * 【规则】
 *   - 组名在 _PASSTHROUGH_GROUPS 里 → 整组原样透传（不进摊平循环）
 *   - 其余组的每个键：值是 {default:...} 形态 → 取 .default；已是裸值 → 原样透传（容错，不炸）
 *   ⚠ 不做 min/max 钳位：钳位属写入侧职责(SetData/前端 input)，此处只做形态转换，保持纯粹。
 *
 * @param {typeof LIVE_CAPABILITIES} effective - resolveEffectiveLive 的返回值
 * @returns {{filter:object, pool:object, selector:object, pacing:object, connection:object, platformProtocol:object, assistant:object}}
 *   扁平运行值（platformProtocol 保持嵌套原形，供 adapter 整份取用）
 */
export function resolveLiveRules(effective) {
	const src = (effective && typeof effective === 'object') ? effective : {}
	const out = {}
	for (const group of Object.keys(src)) {
		const g = src[group]
		if (!g || typeof g !== 'object' || Array.isArray(g)) { out[group] = g; continue }
		// 协议类组：结构是嵌套规格不是控件描述，整组透传（见 _PASSTHROUGH_GROUPS 注释）
		if (_PASSTHROUGH_GROUPS.has(group)) { out[group] = g; continue }
		const flat = {}
		for (const key of Object.keys(g)) {
			const spec = g[key]
			// {default:...} 形态取 default；已是裸值则原样透传(per-user 直接写裸值的容错路径)
			flat[key] = (spec && typeof spec === 'object' && !Array.isArray(spec) && 'default' in spec)
				? spec.default
				: spec
		}
		out[group] = flat
	}
	return out
}
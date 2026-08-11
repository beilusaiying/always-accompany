// Bot 出站内容清洗共享层（Bot-1）。
// 单一真相源：9 个 bot shell（0716 删 kookbot）的 extractPlatformContent 统一转调此处，
// 避免各自维护漂移的 strip 列表把内部协议标签原样发给用户。
// 新增内部协议标签 → 只改 INTERNAL_PROTOCOL_TAG_PATTERNS；新增平台 → 只改 PLATFORM_DISPLAY_TAGS。

// SEC-PI：入站消息 sanitize 复用 untrusted_content 的 Unicode 剥除单源判据
//（与 api_v1_router _sanitizeExternalInput 同一份，禁各写一份/漏一份）。
import { stripInvisibleUnicode } from "../yonban/core/functions/security/untrusted_content.mjs";
// 内容过滤读侧：user.contentFilter（前端设置/bot 面板经 server:user setSetting 同步的同一份用户级配置）
import { getUserByUsername } from "../yonban/core/functions/security/auth.mjs";
// T9 件3（loadOwnerPersona）：各 bot 请求构造里逐字一致的 owner persona 加载段收口到此，
// 依赖与各 bot main.mjs 同一份 parts_loader（运行时求值，无循环加载问题）。
import { getAllDefaultParts, getAnyPreferredDefaultPart, loadPart } from "../server/parts_loader.mjs"; // getAllDefaultParts=件10 插件全量加载

// 内部协议标签清理规则。与 beilu-memory/lib/replyHandler.mjs 的 _stripAllTags 同源，
// 外加 bot 侧需要的 thinking/think。任一标签出站都不应露给用户。
export const INTERNAL_PROTOCOL_TAG_PATTERNS = [
	/<thinking>[\s\S]*?<\/thinking>/gi,
	/<think>[\s\S]*?<\/think>/gi,
	// [2026-08-10] beilu_thinking 内置思维链标签：bot 出站是无折叠 UI 的纯文本面，恒清洗（不受「对 AI 隐藏」开关影响）
	/<beilu_thinking>[\s\S]*?<\/beilu_thinking>/gi,
	/<tableEdit>[\s\S]*?<\/tableEdit>/gi,
	/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi,
	/<memorySearch>[\s\S]*?<\/memorySearch>/gi,
	/<needWebSearch>[\s\S]*?<\/needWebSearch>/gi,
	/<memoryNote[^>]*>[\s\S]*?<\/memoryNote>/gi,
	/<codeMemoryWrite[^>]*>[\s\S]*?<\/codeMemoryWrite>/gi,
	/<workMemoryWrite[^>]*>[\s\S]*?<\/workMemoryWrite>/gi,
	/<modeSwitch>[\s\S]*?<\/modeSwitch>/gi,
	/<subModeSwitch>[\s\S]*?<\/subModeSwitch>/gi,
	/<ideToolCall\s[^>]*?\/>|<ideToolCall\s[^>]*?>[\s\S]*?<\/ideToolCall>/gi,
	/<scheduleTask>[\s\S]*?<\/scheduleTask>/gi,
	/<delegate\s[^>]*>[\s\S]*?<\/delegate>/gi,
	/<parallelDelegate>[\s\S]*?<\/parallelDelegate>/gi,
	/<report[\s\S]*?<\/report>/gi,
	/<approval[\s\S]*?<\/approval>/gi,
	/<createFlowGroup>[\s\S]*?<\/createFlowGroup>/gi,
	/<contextClean>[\s\S]*?<\/contextClean>/gi,
	/<captureControl>[\s\S]*?<\/captureControl>/gi,
	/<browserAction>[\s\S]*?<\/browserAction>/gi,
	/<mcpConnect>[\s\S]*?<\/mcpConnect>/gi,
	/<分身\d+>[\s\S]*?<\/分身\d+>/gi,
	/<stopContinue\s*\/?>/gi,
	/<scheduleWakeup\s[^>]*?\/?>/gi,
	/<progress[\s\S]*?<\/progress>/gi,
	/<needHelp[\s\S]*?<\/needHelp>/gi,
	/<file_op\s[^>]*>[\s\S]*?<\/file_op>/gi,
	/<search>[\s\S]*?<\/search>/gi,
	/<bot_reply>[\s\S]*?<\/bot_reply>/gi,
	/<toggle>[\s\S]*?<\/toggle>/gi,
	/<orbMessage>[\s\S]*?<\/orbMessage>/gi,
	/<emotion>[\s\S]*?<\/emotion>/gi,
	/<completionVerify(?:\s[^>]*)?\/>|<completionVerify(?:\s[^>]*)?>[\s\S]*?<\/completionVerify>/gi,
	/<sendToWindow\s[^>]*?>[\s\S]*?<\/sendToWindow>/gi,
	/<taskPlan>[\s\S]*?<\/taskPlan>/gi,
	/<taskCheck\s[^>]*?\/>|<taskCheck>[\s\S]*?<\/taskCheck>/gi,
	/<wakeWindow\s[^>]*?\/?>/gi,
	/<fileDelivery>[\s\S]*?<\/fileDelivery>/gi,
	/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi,
	/<(?:beilu|work|ide|clone|memory)-[\w]+[^>]*>[\s\S]*?<\/(?:beilu|work|ide|clone|memory)-[\w]+>/gi,
	/<(?:beilu|work|ide|clone|memory)-[\w]+\s[^>]*?\/>/gi,
];

// 平台专属展示标签全集。降级清洗时所有平台块都要剥（含非本平台的，防串台）。
// 与各 bot 的 extractPlatformContent(rawContent, "<tag>") 调用签名一致。
export const PLATFORM_DISPLAY_TAGS = [
	"discord", "telegram", "web", "xbot", "wecom",
	"dingtalk", "wechat", "slack", "line", "lark",
];

/**
 * 提取某平台应展示的内容，并清理所有内部协议标签 + 跨平台块。
 * @param {string} rawContent - AI 完整回复。
 * @param {string} displayTag - 本平台展示标签名（如 "discord"、"telegram"、"wecom"）。
 * @returns {string} 该平台应显示的纯净内容。
 */
// ===================== Bot 触发白名单 + 来源访问档位 L0-L3（C6）=====================
// 单一真相源：9 个 bot shell 的「用户级触发判定」与「访问档位解析」统一转调此处，
// 避免各壳分叉。各壳只负责把平台 API 的 author 归一成 { authorId, isOwner }，
// 触发/访问档位「语义」全部在本文件，新增策略只改这里。
//
// 设计依据（02_设计总图+原话 batch31，凛倾"频率限制加上就是只有主用户可以触发ai回复，或者特定用户"）：
//   · 触发白名单：默认 [OwnerUserID] + 扩展 AllowedUserIDs；非白名单消息忽略不消耗 Token 但记日志。
//     触发模式三选一：仅主用户(owner) / 白名单(whitelist) / 所有人(all，不限制)。
//   · 来源访问档位 L0 只读 / L1 读 / L2 读写需确认 / L3 完整+白名单命令；不继承用户设置；全用 author.id。
//
// ★ [P0-B 2026-08-03 fail-closed 收口，任务 MD「缺失/非法策略 fail-closed；不得默认为 all/L3」]
//   旧基线（TriggerMode 缺省 "all" + 非 owner 缺省 L3）= fail-open：默认配置下任意平台用户可触发
//   并获得全通道权限（Fable 审查阻断4）。现：
//   · 缺失 → 安全默认（owner 触发 / 非 owner L1 读）；非法值 → 更严（owner 触发 / L0）+ warn 可见。
//   · 用户已显式保存的合法值（含旧模板持久化的 "all"/3）原样尊重——不覆盖用户明确保存的旧配置。
//   · host_control（IDE/宿主能力）与档位数字解耦：HostControlEnabled 单独开关默认 false，
//     且仅 owner 可获得（见 buildBotSourceMeta / operationRegistry）；L3 数字不再自动等于宿主能力。
//   · 迁移记录：PermissionPolicyRevision=2 随模板补齐；旧条目缺 _isOwner/_hostControl 时
//     消费端按非 owner/无宿主能力 fail-closed 解析（resolveRequestBotPermission）。

/** 合法访问档位集合。 */
export const BOT_PERMISSION_LEVELS = [0, 1, 2, 3];

/** Bot 权限策略修订号（P0-B 2026-08-03 引入；随 buildBotSourceMeta 持久化进条目供事后对账）。 */
export const BOT_PERMISSION_POLICY_REVISION = 2;

/**
 * 触发模式默认值。[P0-B] "owner"=仅主用户（fail-closed 安全默认）。
 * 可选 "all"=所有人可触发，"whitelist"=主用户 + AllowedUserIDs。
 * 旧配置已持久化 TriggerMode 的不受影响；缺失该键的配置从"全放行"收紧为"仅主用户"。
 */
export const BOT_DEFAULT_TRIGGER_MODE = "owner";

/**
 * 判定某外部用户是否被允许触发 bot（用户级触发策略，叠加在各壳已有的频道/@/私聊触发判定之后）。
 * 返回 false 时各壳应忽略该消息（不生成回复、不消耗 Token），由各壳负责记日志。
 *
 * @param {object} config - bot 配置对象（含 TriggerMode / OwnerUserId / AllowedUserIDs）。
 * @param {string} authorId - 已归一化的发送者平台用户 ID（用 author.id，非用户名）。
 * @param {boolean} isOwner - 各壳已算好的 owner 判定结果。
 * @returns {boolean} 是否允许触发。
 */
export function checkBotTriggerAllowed(config, authorId, isOwner) {
	// 入口归一：TriggerMode 概念域 = all/owner/whitelist 三值。
	// [P0-B fail-closed] 缺失 → 安全默认 "owner"；非法值（用户配置笔误）→ "owner" 并 warn 可见
	// （旧实现非法/缺失一律回落 "all" = fail-open，任务 MD 明令禁止）。下方分支穷尽三值，无尾部放行兜底。
	let mode = (config && config.TriggerMode) || BOT_DEFAULT_TRIGGER_MODE;
	if (mode !== "all" && mode !== "owner" && mode !== "whitelist") {
		console.warn(`[botContentShared] TriggerMode 非法值 "${mode}"，fail-closed 按 "owner" 处理（合法值: all/owner/whitelist）`);
		mode = "owner";
	}
	if (mode === "all") return true;         // 所有人可触发
	if (isOwner) return true;                // owner 永远可触发
	if (mode === "owner") return false;      // 仅主用户
	// whitelist：主用户 + AllowedUserIDs
	const list = Array.isArray(config && config.AllowedUserIDs)
		? config.AllowedUserIDs.map(String)
		: [];
	return list.includes(String(authorId));
}

/**
 * 解析某用户对应的 bot 访问档位 L0-L3。owner 用 OwnerPermissionLevel，其余用 DefaultPermissionLevel。
 * 该档位以 _permissionLevel 标记到 chat_log entry 上，供下游消费端（file_op/delegate/ide 确认门）按档位裁决。
 * ★ N42 已接线：消费端经 resolveRequestBotPermission（本文件下方）读取——
 *   beilu-files file_op 策略点 + beilu-memory ideToolCall/分身/delegate/modeSwitch 策略点。
 *
 * @param {object} config - bot 配置对象。
 * @param {string} _authorId - 发送者 ID（保留，未来可做 per-user 覆盖）。
 * @param {boolean} isOwner - 是否 owner。
 * @returns {0|1|2|3} 访问档位。
 */
export function resolveBotPermissionLevel(config, _authorId, isOwner) {
	// [P0-B fail-closed] 缺失/非法分流（旧实现二者一律回落默认 3 = 非 owner fail-open）：
	//   owner：缺失/非法 → 3（owner 即用户本人，完整档合理）；
	//   非 owner：缺失 → 1（读，安全新默认，不再默认 L3）；非法值 → 0（只读，配置笔误从严）。
	//   用户已显式保存的合法档位（0-3）原样尊重。
	const _lvl = (v, dfltMissing, dfltInvalid) => {
		if (v === undefined || v === null) return dfltMissing;
		const n = Number(v);
		return BOT_PERMISSION_LEVELS.includes(n) ? n : dfltInvalid;
	};
	if (isOwner)
		return _lvl(config && config.OwnerPermissionLevel, 3, 3);
	return _lvl(config && config.DefaultPermissionLevel, 1, 0);
}

/**
 * [P0-B 2026-08-03] Bot 条目来源元数据构造单源——壳侧构造触发条目时用 `...buildBotSourceMeta(...)`
 * 替代散写 `_sourceType/_permissionLevel` 两字段。新增持久化字段（Fable 审查阻断4：
 * 「sender id / isOwner 依据 / 配置版本均未持久化，事后无法回答这条 L3 是谁、凭什么」）：
 *   _senderId：平台发送者 ID（审计锚）
 *   _isOwner：壳判定瞬间的 owner 结论（host_control 裁决消费；缺失=非 owner fail-closed）
 *   _hostControl：策略快照 = config.HostControlEnabled===true 且 isOwner（宿主能力与 L 数字解耦，
 *                 默认关闭、owner-only；L3 不再自动获得 host_control）
 *   _policyRev：BOT_PERMISSION_POLICY_REVISION（对账用）
 * @param {object} config - bot 配置。
 * @param {string|number} authorId - 平台发送者 ID。
 * @param {boolean} isOwner - 壳已算好的 owner 判定。
 * @returns {object} 展开进条目的元字段集。
 */
export function buildBotSourceMeta(config, authorId, isOwner) {
	return {
		_sourceType: "bot",
		_permissionLevel: resolveBotPermissionLevel(config, authorId, isOwner),
		_senderId: authorId === undefined || authorId === null ? "" : String(authorId),
		_isOwner: isOwner === true,
		_hostControl: (config && config.HostControlEnabled === true) && isOwner === true,
		_policyRev: BOT_PERMISSION_POLICY_REVISION,
	};
}

/**
 * [P0-B] 从既有条目摘取来源元字段（壳侧 appendBotChatEntry 转发点用 `...pickBotSourceMeta(entry)`
 * 替代散写两字段转发，保证新旧字段整组同行——防"构造点带了、转发点漏了"的半接线）。
 */
export function pickBotSourceMeta(entry) {
	if (!entry || entry._sourceType !== "bot") return {};
	const meta = { _sourceType: "bot" };
	if (Number.isFinite(entry._permissionLevel)) meta._permissionLevel = entry._permissionLevel;
	if (entry._senderId !== undefined) meta._senderId = entry._senderId;
	if (entry._isOwner !== undefined) meta._isOwner = entry._isOwner === true;
	if (entry._hostControl !== undefined) meta._hostControl = entry._hostControl === true;
	if (Number.isFinite(entry._policyRev)) meta._policyRev = entry._policyRev;
	return meta;
}

/**
 * N42（K7 接线）：从请求 chat_log 解析"本轮触发者"的 Bot 访问档位。
 * 触发者 = chat_log 最后一条 entry：各壳串行队列把触发消息 push 入链后立即 GetReply
 *（discord HandleMessageQueue :386-452 / telegram :274→:307→:417 同构），调用时刻尾条必为触发消息。
 * ★ 不能按 role==="user" 倒序找：壳的 role 判定里只有 owner 才是 "user"，非 owner 外部用户
 *   role==="char"（discord :283-288 / telegram :214）——按 user 倒序会跳过触发者、误取到 owner
 *   历史消息的档位（档位取值错位，低档位用户会读到 owner 的 L3），所以改取尾条=触发者本人。
 * 消费端：beilu-files file_op 策略点 / beilu-memory ideToolCall·分身·delegate·parallelDelegate·modeSwitch 策略点。
 * 非 Bot 来源（尾条无 _sourceType 标记 = 本地用户/其他调用方）返回 null = 消费端零行为变化。
 * @param {Array} chatLog - GetReply 请求的 args.chat_log
 * @returns {{isBot:true, level:0|1|2|3}|null}
 */
export function resolveRequestBotPermission(chatLog) {
	if (!Array.isArray(chatLog) || chatLog.length === 0) return null;
	const e = chatLog[chatLog.length - 1];
	if (e && e._sourceType === "bot" && BOT_PERMISSION_LEVELS.includes(Number(e._permissionLevel))) {
		// [P0-B] 扩展身份字段：旧条目缺新字段 → isOwner:false / hostControl:false（fail-closed，
		// 宿主能力在旧条目上不可证明即不授予）；senderId/policyRev 供审计（可为空）。
		return {
			isBot: true,
			level: Number(e._permissionLevel),
			isOwner: e._isOwner === true,
			hostControl: e._hostControl === true,
			senderId: e._senderId !== undefined ? String(e._senderId) : "",
			policyRev: Number.isFinite(e._policyRev) ? Number(e._policyRev) : 1,
		};
	}
	return null;
}

/**
 * 给 bot 配置模板补齐 C6 触发白名单 + 权限字段的默认值（各壳 GetBotConfigTemplate 调用，单点维护字段集）。
 * [P0-B 2026-08-03] 缺失键默认已收紧为 fail-closed：owner 触发 + owner L3 / 非 owner L1 / HostControl 关。
 * 已持久化的用户配置值原样保留不覆盖。
 * @param {object} base - 各壳已有的配置模板对象。
 * @returns {object} 补齐 C6 字段后的模板（原字段不覆盖）。
 */
export function withBotPermissionDefaults(base) {
	const tpl = base || {};
	return {
		...tpl,
		// ---- C6 触发白名单 ----
		// [P0-B fail-closed] 新配置默认 "owner"（旧配置已持久化的值原样保留，不覆盖用户已保存配置）
		TriggerMode: tpl.TriggerMode ?? BOT_DEFAULT_TRIGGER_MODE, // "all" | "owner" | "whitelist"
		AllowedUserIDs: Array.isArray(tpl.AllowedUserIDs) ? tpl.AllowedUserIDs : [], // 平台用户ID白名单（whitelist 模式生效）
		// ---- C6 独立权限 L0-L3 ----
		OwnerPermissionLevel: tpl.OwnerPermissionLevel ?? 3,     // 主用户权限等级，默认 L3 完整
		DefaultPermissionLevel: tpl.DefaultPermissionLevel ?? 1, // [P0-B] 非主用户默认 L1 读（不再默认 L3；放开由用户显式配置）
		// ---- P0-B 宿主能力与策略修订 ----
		HostControlEnabled: tpl.HostControlEnabled === true,     // 宿主能力（IDE 工具/弹窗/感知控制等）单独开关：默认关闭、且仅 owner 生效
		PermissionPolicyRevision: tpl.PermissionPolicyRevision ?? BOT_PERMISSION_POLICY_REVISION, // 策略修订对账
	};
}

// ===================== Bot 委派回程唤醒注册表 =====================
// 凛倾 07-09「发指令→其他窗口工作→工作完需要有注入通知→AI 去看→发送」的回程触发件。
// 单一真相源：9 壳在 client 就绪后注册唤醒回调；replyHandler <report> 落队列后按
// platform+username+charname 通知。报告内容【不】经此处传递——唤醒只触发一轮 bot 生成，
// 报告由 getPromptHandler H2（DELEGATE_REPORT，reportInjected consume-once + V1_CONST 截断压缩）
// 注入提示词，与 web 端同一注入/压缩机制，无双源。
const _botDelegateWakers = new Map(); // key `${platform}|${username}|${charname}` → Set<fn({channelId,delegateId})>

/**
 * 注册 bot 委派唤醒回调（壳侧 OnceClientReady 时调用）。
 * @returns {Function} 注销函数（壳停机可调；未调也有 notify 侧失败自愈摘除兜底）。
 */
export function registerBotDelegateWaker(platform, username, charname, fn) {
	const key = `${platform}|${username}|${charname}`;
	// T9 替换语义（原 Set.add 累加）：接口对象是 per-char 单例（char.interfaces.<platform>），同 key 的
	// 合法 waker 恒只有一份。累加语义下 char 缓存被清重建接口（parts_loader delete → createSimple 重跑
	// → 新闭包注册）会把旧接口的僵尸闭包留在 Set 里 → 一次委派报告触发 N 轮生成（S19-1e 确诊：
	// _wakerRegistered 挂在闭包函数对象上，重建即重置，防不住）。新注册=替换同 key 全部旧回调。
	_botDelegateWakers.set(key, new Set([fn]));
	return () => {
		const s = _botDelegateWakers.get(key);
		if (s) { s.delete(fn); if (!s.size) _botDelegateWakers.delete(key); }
	};
}

/**
 * 委派报告完成 → 唤醒来源 bot 出一轮主动生成并发回来源频道。
 * 回调抛错=僵尸（bot 已停/client 已销毁）即摘除自愈，不影响报告落盘主链。
 * @returns {Promise<number>} 成功唤醒的回调数。
 */
export async function notifyBotDelegateReport({ platform, username, charname, channelId, delegateId }) {
	const s = _botDelegateWakers.get(`${platform}|${username}|${charname}`);
	if (!s || !s.size) return 0;
	let n = 0;
	for (const fn of [...s]) {
		try { await fn({ channelId, delegateId }); n++; }
		catch (e) {
			s.delete(fn);
			console.warn(`[botContentShared] 委派唤醒回调失败已摘除 (${platform}/${charname}):`, e?.message || e);
		}
	}
	return n;
}

// ===================== bot 对话线 chatid 收口（9 壳统一）=====================
/** chatOps 模块缓存（跨壳共用；动态 import 防 scripts→shells 静态循环依赖，同 handleBotChatCommand 范式）。 */
let _chatOpsModShared = null;

/**
 * 取（无则建）某平台 bot 的对话线 chatid —— **9 壳唯一取法**（原 discordbot 壳私有 _ensureBotChatId 迁入收口）。
 *
 * 【why 必须每壳都传】生成读侧 `_cid = arg.chatid || arg.chat_name.replace("common_chat_","")`
 *   （getPromptHandler:208 / replyHandler:731 / getDataHandler:84）。壳不传 chatid 时 _cid 退化成
 *   **平台聊天名字符串**，而线级状态的写侧——`!skill use`→`active_preset_map[真chatid:bot]`
 *   （handleBotChatCommand）、bot 子模式面板→`active_sub_modes_map[真chatid]`
 *   （discordBotPanel:939 `_bsmLineChatId`，取自 newBotChat peek）——用的全是 ensureBotChat 的真 chatid。
 *   两者永不相交 ⇒ 命令能执行、回执说"已切换"，但下一轮生成读不到 = 半接线。
 *   0716 把 handleBotChatCommand 推全 9 壳时只推了命令、没推 chatid，本函数补齐另一半。
 *
 * 【失败语义】沿用 discord 既有拍板：**禁回退空 chatid 静默降级**——丢线=模式/预设/记忆隔离悄悄失效
 *   + 消息不落对话文件，「对话文件=上下文载体」（凛倾 07-09）目的静默不成立。抛错由各壳既有
 *   catch（broadcastBotError + 错误回复 / 唤醒轮 diag+broadcast）外显。
 *
 * @param {string} username - owner 用户名（各壳 ownerUsername）
 * @param {string} charName - 绑定角色名（各壳 botCharname）
 * @param {string} platform - 平台标识，与 extension.platform 同值（telegram/discord/slack/...）
 * @returns {Promise<string>} 该平台线 chatid（非空）
 */
export async function resolveBotChatId(username, charName, platform) {
	_chatOpsModShared ||= await import(new URL("../public/parts/shells/beilu-chat/src/lib/chatOps.mjs", import.meta.url).href);
	const _r = await _chatOpsModShared.ensureBotChat(username, charName, platform);
	if (!_r?.chatid) throw new Error(`ensureBotChat 未返回 chatid（${platform} bot 对话线不可用）`);
	return _r.chatid;
}

/**
 * 向 bot 对话线追加一条消息 —— chatOps.appendBotChatEntry 的 9 壳共用适配（与 resolveBotChatId 共用模块缓存）。
 *
 * 【why 收口】原 discordbot 壳直接持 chatOps 模块引用（`_chatOpsMod?.appendBotChatEntry` 三处），
 *   模块句柄的生命周期与 _ensureBotChatId 隐式耦合（"chatid 存在=已加载"）。收口后壳不再碰
 *   chatOps 模块本身，加载时机由本模块负责，其余壳接线时也不必各自再 import 一遍。
 *
 * 【语义保持】fire-and-forget 由**调用方**决定（本函数只返回 Promise，不吞错）——
 *   discord 既有形态是 `.catch(diag.warn)`，写失败不影响平台回复，语义原样保留在壳侧。
 *
 * @param {string} chatid - bot 对话线 id（空则直接跳过，返回 null）
 * @param {{role:"user"|"char", name:string, content:string, content_for_show?:string, charName?:string, files?:Array, extension?:object}} msg
 * @returns {Promise<object|null>} 追加的 entry；chatid 为空时 null
 */
export async function appendBotChatEntry(chatid, msg) {
	if (!chatid) return null;
	_chatOpsModShared ||= await import(new URL("../public/parts/shells/beilu-chat/src/lib/chatOps.mjs", import.meta.url).href);
	return await _chatOpsModShared.appendBotChatEntry(chatid, msg);
}

/**
 * 从**对话文件**构建 bot 生成用 chat_log —— 与 web 端同源。
 *
 * 【why 换源】原形态：各壳内存 `ChatLogs[平台会话id]` 环形缓冲（深度 20）当上下文，进程一停即清，
 *   而对话文件只被写不被读（单向）。于是「有对话文件」与「AI 记得」是两回事：重启后 AI 从零开始，
 *   用户却在 web 面板看得到完整记录。换源后两者合一，且重启自动续上。
 *
 * 【同源依据】web 正线 `requestBuilder.mjs:142`：
 *   `chat_log: _applyContentFilter(await getVisibleChatLog(chatid, chatMetadata), username)`
 *   本函数即该式的 bot 侧对应物——同一个 `getVisibleChatLog`（loadChat → filter(isActiveEntry) → 克隆），
 *   过滤器换成 bot 侧的 `applyBotContentFilter`（bot 无显示层，语义见其注释）。
 *   条目形状天然正确：文件里的条目本就由 `BuildChatLogEntryFromUserMessage/FromCharReply` 生成，
 *   与 web 走同一套构建器，不需要任何形状适配。
 *
 * 【隔离粒度=角色卡级】一个平台×一个角色 = 一条线（`bot_chat_bindings` 现有语义），
 *   与架构基准「角色卡级别:每个角色卡都有 data,记忆,对话文件,世界书」一致——
 *   记忆侧 `getMemoryDir(username, charName)` 早就是角色卡级，本函数让对话侧与之对齐。
 *   故同平台不同频道/私聊共用一条线是**设计**：角色卡是一个人格，它记得自己经历的全部对话。
 *
 * 【深度】沿用各壳既有 MaxMessageDepth 语义（取最近 N 条）。深度之外的历史不是丢失——
 *   仍在文件里，由 getPromptHandler 的记忆/摘要链按需消费。
 *
 * @param {string} chatid - bot 对话线 id（resolveBotChatId 产物）
 * @param {string} username - owner 用户名（内容过滤配置属主）
 * @param {{maxDepth?: number}} [opts]
 * @returns {Promise<Array|null>} chat_log 数组；chatid 为空返回 null（调用方回退壳内存=诚实降级）
 */
export async function buildBotChatLogFromFile(chatid, username, { maxDepth = BOT_DEFAULT_MAX_MESSAGE_DEPTH } = {}) {
	if (!chatid) return null;
	_chatOpsModShared ||= await import(new URL("../public/parts/shells/beilu-chat/src/lib/chatOps.mjs", import.meta.url).href);
	const log = await _chatOpsModShared.getVisibleChatLog(chatid);
	const sliced = (maxDepth > 0 && log.length > maxDepth) ? log.slice(-maxDepth) : log;
	return applyBotContentFilter(sliced, username);
}

// ===================== bot 侧对话线管理命令（凛倾 07-09「在bot那边新建对话文件,然后切换」）=====
// owner 在平台聊天里直接管理上下文线（新建/列出/切换），与 web 面板切换器同一指针权威
// （chatOps ensureBotChat / bot_chat_bindings），双入口即改即生效。
// 命令词单源：[0726 收口后校准] 真源已从两个散常量升级为下方 BOT_COMMAND_REGISTRY——
//   改注册表即全平台生效（协议契约，同 <report> 标签性质），旧的 BOT_CHAT/SKILL_COMMAND_PREFIX
//   现为派生导出，只为兼容既有引用，禁当真源改。
// 回执文本=系统诊断面（bot 对用户的机制反馈，不进 AI 生成，不是提示词注入）。
/** 命令引导符单源：改这里即全平台命令词与全部回执/前端展示同步（禁在任何地方再写字面 "!"）。 */
export const BOT_COMMAND_SIGIL = "!";

/**
 * bot 侧命令注册表 —— **唯一真源**（件14 BOT_CONFIG_FIELD_META「后端 schema 携带 label」同范式）。
 *
 * 【why】原形态：命令词两个散常量 + handleBotChatCommand 里 if/else 串 + 每个分支手写用法回执文案
 *   （"对话线命令：!chat new（新建并切换）| ..."），加一条命令要改解析、改路由、改三处文案；
 *   前端 bot 界面则完全不知道有哪些命令（零展示）。收单源后：路由（parseBotCommand）、
 *   用法回执（botCommandUsage）、前端命令面板（getBotCommandMeta → /getcommandmeta 端点）
 *   全部由本表派生，加一条命令只改本表 + 加一个执行分支。
 *
 * 【与 INJ 范式对齐】值域/清单由后端下发、前端零镜像渲染（injectionSystem.getInjectionAutoModeMeta
 *   → getData injection_automode_meta → panels.mjs 禁硬编码清单）。本表走 bot 域自己的
 *   getconfigfieldmeta 同款端点通道，前端拉不到时降级为"不展示命令区"（诚实降级非断链）。
 *
 * 【文案边界】desc/args 是**系统诊断面**（bot 对用户的机制反馈 + 前端展示），不进 chat_log、
 *   不进 AI 上下文，故不受「代码禁产生进对话的文本」铁律约束——与本文件既有回执文案同性质
 *   （见 BOT_COMMAND_SIGIL 上方 07-09 注释）。凡将来要进 messages 的文本，一律走 injectTexts。
 *
 * 【传导位置——加命令前必读】命令在各壳的 **_mq 串行队列内** await 执行（telegram :449-467 等 9 壳同构），
 *   即：bot 正在为上一条消息生成时，新到的命令排在其后，生成完才执行。
 *   这是**刻意取舍**：`!chat use`/`!skill use` 是「切上下文/切预设」，必须与消息顺序一致——
 *   若插队提前生效，它前面那条还没处理的消息就会用上新线/新预设，语义错乱。
 *   ⚠️ 但该取舍**只对"改状态且要求顺序一致"的命令成立**。将来若加控制类命令
 *   （`!stop` 停生成、`!status` 查在飞状态），排队会让它们失去意义——`!stop` 排在它要停的那次生成后面
 *   =永远停不掉。hermes 对此有成文规则与事故背书（`hermes_cli/commands.py:388 should_bypass_active_session`：
 *   「任何可解析的 slash 都绕过排队直接分发」，理由是排队路径会丢弃命令文本 → 命令既打断 agent 又被丢，
 *   产出零字符响应，见其 issue #5057 / PR #6252）。
 *   故：**加控制类命令时不能只往本表加一行**，必须同时在 9 壳的队列入口做「命令先行分发」，
 *   否则就是静默失效。本表当前 2 条都属"改状态"类，不需要绕队，因而未预留 bypass 字段
 *   （无消费方的声明字段=死声明，本项目已有先例教训）。
 *
 * 字段：name=命令词（不含引导符）/ label=前端标题 / desc=一句话说明 / ownerOnly=仅主用户 /
 *       subs=[{name, args, desc}]（args 为占位提示，空串=无参数）
 */
export const BOT_COMMAND_REGISTRY = [
	{
		name: "chat",
		label: "对话线管理",
		desc: "在平台侧新建/列出/切换 bot 对话线（对话文件=上下文载体，凛倾 07-09）",
		ownerOnly: true,
		subs: [
			{ name: "new", args: "", desc: "新建并切换到新线（旧线保留，可 list 查看/切回）" },
			{ name: "list", args: "", desc: "列出本平台全部对话线并标记当前线" },
			{ name: "use", args: "<序号>", desc: "切换到第 n 条线（序号取自 list）" },
		],
	},
	{
		// 技能式预设切换（凛倾 07-09「可以绑定不同的预设,类似于skill」）：预设=技能集，owner 在平台里
		// 按线切换（switchPresetViaAPI 权威写口→active_preset_map[线cid:bot] 线级真值，即改即生效）。
		// AI 自切通道现状（注释校准 2026-07-27：preset_switch_to 穿生成链机制已于 0717 串联收口删除，
		//   见 getPromptHandler.mjs:61/2238 自证注释）——
		//   P1 侧：<presetSwitch> 由 aiRunner.parsePresetSwitchTag 解析后，getPromptHandler.mjs:1441
		//     直调 switchPresetViaAPI（权威写口），不再经 TweakPrompt/extension 穿生成链写 map 键；
		//   主AI侧：<presetSwitch> 已废弃（统一用 <subModeSwitch>），replyHandler.mjs:4025 仅清理标签不再执行切换。
		name: "skill",
		label: "技能（预设）切换",
		desc: "按线切换绑定预设——预设=技能集，切换即改本线 AI 行为",
		ownerOnly: true,
		subs: [
			{ name: "list", args: "", desc: "列出可用预设并标记本线当前预设" },
			{ name: "use", args: "<序号或名>", desc: "本线切换到该预设（下条消息生效）" },
			{ name: "clear", args: "", desc: "回退到全平台默认预设" },
		],
	},
];

/** 命令词全称（含引导符）。派生自注册表，禁再写字面量。 */
export function botCommandWord(name) {
	return `${BOT_COMMAND_SIGIL}${name}`;
}

/** 兼容导出（原散常量，现由注册表派生——保留是因外部可能已引用；新代码用 botCommandWord）。 */
export const BOT_CHAT_COMMAND_PREFIX = botCommandWord("chat");
export const BOT_SKILL_COMMAND_PREFIX = botCommandWord("skill");

/**
 * 解析一条平台消息是否命中某条注册命令。
 * @param {string} text - 原始消息文本（调用方已剥平台 @mention）
 * @returns {{def: object, sub: string, args: string[], raw: string}|null} 未命中返回 null
 */
export function parseBotCommand(text) {
	const t = String(text || "").trim();
	const low = t.toLowerCase();
	for (const def of BOT_COMMAND_REGISTRY) {
		const word = botCommandWord(def.name).toLowerCase();
		// 命中判据=以命令词开头且其后是空白或结束（防 !chatx 误判为 !chat）
		if (!low.startsWith(word)) continue;
		const rest = t.slice(word.length);
		if (rest && !/^\s/.test(rest)) continue;
		const args = rest.trim().split(/\s+/).filter(Boolean);
		return { def, sub: (args[0] || "").toLowerCase(), args: args.slice(1), raw: rest.trim() };
	}
	return null;
}

/**
 * 文本是否「长得像一条命令」但未必存在（未知命令判据）。
 *
 * 【why】参考 hermes-agent `gateway/run.py:10177-10197` 的成文规则：不认识的 `/xxx` **宁可回
 *   "Unknown command" 也不当自由文本转发给 LLM**，其注释给的理由是模型收到疑似指令的自由文本会
 *   「发明工具调用」（silent-failure）。beilu 原行为：`!skil list`（拼错）直接当聊天内容进 AI 上下文，
 *   AI 多半会假装执行了切换——用户以为切了、其实没切，比报错更坏。
 *
 * 【判据收窄，防误伤】必须是 引导符 + ASCII 起首词（字母开头，后接字母数字/连字符/下划线）+ 词边界。
 *   于是 `!!!`、`!注意`、`! hi`、`!`（裸引导符）都**不**算命令形——群里常见的感叹号开头中文消息不会被拦。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeBotCommand(text) {
	const t = String(text || "").replace(/<@!?\d+>/g, "").trim();
	if (!t.startsWith(BOT_COMMAND_SIGIL)) return false;
	return new RegExp(`^\\${BOT_COMMAND_SIGIL}[A-Za-z][A-Za-z0-9_-]*(\\s|$)`).test(t);
}

/**
 * 单条子命令的用法串（如 `!skill use <序号或名>`）——列表回执里的行内提示由此取，
 * 防子命令名在文案里二次硬编码后与注册表漂移。
 * @param {object} def - 注册表条目
 * @param {string} subName - 子命令名
 * @returns {string} 用法串；子命令不存在时退化为命令词本身（诚实降级，不抛）
 */
export function botSubUsage(def, subName) {
	const s = def?.subs?.find((x) => x.name === subName);
	const w = botCommandWord(def?.name ?? "");
	return s ? `${w} ${s.name}${s.args ? " " + s.args : ""}` : w;
}

/** 用法回执文案（派生自注册表，替原各分支手写字符串）。 */
export function botCommandUsage(def) {
	const w = botCommandWord(def.name);
	return `${def.label}：` + def.subs.map((s) => `${w} ${s.name}${s.args ? " " + s.args : ""}（${s.desc}）`).join(" | ");
}

/**
 * 前端命令面板的唯一数据源（经 /getcommandmeta 端点下发；前端禁硬编码命令清单）。
 * @returns {{sigil: string, commands: Array<object>}}
 */
export function getBotCommandMeta() {
	return {
		sigil: BOT_COMMAND_SIGIL,
		commands: BOT_COMMAND_REGISTRY.map((d) => ({
			name: d.name,
			word: botCommandWord(d.name),
			label: d.label,
			desc: d.desc,
			ownerOnly: !!d.ownerOnly,
			subs: d.subs.map((s) => ({ name: s.name, args: s.args, desc: s.desc, usage: `${botCommandWord(d.name)} ${s.name}${s.args ? " " + s.args : ""}` })),
		})),
	};
}

/** 按平台前缀列出 bot 对话线（确定性排序：名字→chatid，list/use 两次调用序号一致）。 */
async function _listBotChats(chatOpsMod, settingMod, username, platform) {
	const names = settingMod.loadShellData(username, "chat", "chat_names") || {};
	const prefix = `${chatOpsMod.BOT_CHAT_SYMBOL}[${platform}]`;
	return Object.entries(names)
		.filter(([, n]) => String(n || "").startsWith(prefix))
		.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : String(a[1]).localeCompare(String(b[1]))))
		.map(([cid, n]) => ({ chatid: cid, name: n }));
}

/**
 * 解析并执行 bot 侧对话线命令。非命令返回 null（调用方继续正常 AI 流程）；
 * 命中返回回执文本（调用方发回平台并【跳过】AI 生成）。
 * 子命令：`new`=新建线并切 / `list`=列出线+当前标记 / `use <序号>`=切到第 n 条 / 其他=用法提示。
 * @param {{username: string, charName: string, platform: string, text: string, isOwner: boolean}} p
 * @returns {Promise<string|null>}
 */
export async function handleBotChatCommand({ username, charName, platform, text, isOwner }) {
	const t = String(text || "").replace(/<@!?\d+>/g, "").trim(); // 剥平台 @mention 记号
	// 路由由注册表派生（原「两个 startsWith + 各分支手写 split」纯删）：加命令只改 BOT_COMMAND_REGISTRY。
	const _hit = parseBotCommand(t);
	if (!_hit) {
		// 未知命令兜底（参考 hermes gateway/run.py:10177-10197）：只对 owner 回执——
		//   ①命令面本就只对 owner 开放，非 owner 回"未知命令"零收益；
		//   ②群里多 bot 共用 `!` 引导符是常态（别家 bot 的 `!roll` 不该被我们抢答），
		//     限 owner 把误伤面压到最小。非 owner / 非命令形 → 返回 null 走正常 AI 流程（行为不变）。
		// 回执给出可操作出路（同 hermes「resend without the leading slash」）：去掉引导符即当普通消息。
		if (isOwner && looksLikeBotCommand(t)) {
			const _all = BOT_COMMAND_REGISTRY.map((d) => botCommandWord(d.name)).join(" / ");
			return `未知命令。可用：${_all}（发命令词本身可看用法）。若本就想说这句话，去掉开头的 ${BOT_COMMAND_SIGIL} 重发即可。`;
		}
		return null;
	}
	const _isSkillCmd = _hit.def.name === "skill";
	if (_hit.def.ownerOnly && !isOwner) return "仅主用户可管理对话线/技能。";
	const chatOpsMod = await import(new URL("../public/parts/shells/beilu-chat/src/lib/chatOps.mjs", import.meta.url).href);
	const settingMod = await import(new URL("../server/setting_loader.mjs", import.meta.url).href);
	// ---- !skill 分支：线级预设=技能（list/use/clear），写口=presetBridge 单源 ----
	if (_isSkillCmd) {
		const bridge = await import(new URL("../yonban/core/functions/memory/ai/presetBridge.mjs", import.meta.url).href);
		const sArgs = [_hit.sub, ..._hit.args]; // 解析已收口 parseBotCommand，此处只做既有下标语义的薄适配
		const sSub = _hit.sub;
		try {
			// 技能作用线=当前平台线（无则建：切技能隐含需要线承载）
			const line = await chatOpsMod.ensureBotChat(username, charName, platform);
			if (sSub === "list") {
				const all = bridge.listPresets(username).map(p => p.name).sort((a, b) => a.localeCompare(b));
				if (!all.length) return "没有可用预设。";
				const cur = bridge.getActivePresetName(username, line.chatid, "bot");
				return "技能（预设）列表：\n" + all.map((n, i) =>
					`${i + 1}. ${n.replace(/\.json$/i, "")}${n === cur ? "　← 当前线" : ""}`).join("\n") +
					`\n切换：${botSubUsage(_hit.def, "use")}；回退默认：${botSubUsage(_hit.def, "clear")}`;
			}
			if (sSub === "use") {
				const all = bridge.listPresets(username).map(p => p.name).sort((a, b) => a.localeCompare(b));
				const raw = sArgs.slice(1).join(" ");
				const idx = parseInt(raw, 10);
				const target = (Number.isFinite(idx) && idx >= 1 && idx <= all.length)
					? all[idx - 1]
					: all.find(n => n === raw || n.replace(/\.json$/i, "") === raw);
				if (!target) return `未找到预设「${raw}」，先 ${botSubUsage(_hit.def, "list")} 查看。`;
				const ok = await bridge.switchPresetViaAPI(target, { username }, line.chatid, "bot");
				return ok
					? `本线技能已切换：${target.replace(/\.json$/i, "")}（下条消息生效）`
					: `切换失败（预设引擎未响应），请稍后再试。`;
			}
			if (sSub === "clear") {
				// [P2 2026-08-03 诚实性] 原文案恒报"已回退全平台默认预设"——但清除线级覆盖后 resolver
				//   可能解析为"无预设"（全局默认未配置时）。改为清除后读回真实生效值再回执，不虚构状态。
				const ok = await bridge.clearPresetOverrideViaAPI({ username }, line.chatid, "bot");
				if (!ok) return "回退失败（预设引擎未响应）。";
				const eff = bridge.getActivePresetName(username, line.chatid, "bot");
				return eff
					? `已清除本线技能覆盖，当前生效：${String(eff).replace(/\.json$/i, "")}（全平台默认）。`
					: "已清除本线技能覆盖；当前没有全平台默认预设（本线暂无预设生效）。";
			}
			return botCommandUsage(_hit.def); // 用法文案派生自注册表（原手写串纯删）
		} catch (e) {
			return `技能操作失败：${e?.message || e}`;
		}
	}
	const args = [_hit.sub, ..._hit.args]; // 同上薄适配：保留既有 args[1]=第一参数 的下标语义
	const sub = _hit.sub;
	try {
		if (sub === "new") {
			const r = await chatOpsMod.ensureBotChat(username, charName, platform, { fresh: true });
			return `已新建并切换对话线：${r.name}（旧线保留，${botSubUsage(_hit.def, "list")} 可查看/切回）`;
		}
		if (sub === "list") {
			const list = await _listBotChats(chatOpsMod, settingMod, username, platform);
			if (!list.length) return "当前平台还没有对话线（发任意消息将自动创建）。";
			const cur = await chatOpsMod.ensureBotChat(username, charName, platform, { peek: true });
			return "对话线列表：\n" + list.map((c, i) =>
				`${i + 1}. ${c.name}${c.chatid === cur.chatid ? "　← 当前" : ""}`).join("\n") +
				`\n切换：${botSubUsage(_hit.def, "use")}`;
		}
		if (sub === "use") {
			const idx = parseInt(args[1], 10);
			const list = await _listBotChats(chatOpsMod, settingMod, username, platform);
			if (!Number.isFinite(idx) || idx < 1 || idx > list.length)
				return `序号无效（1-${list.length}），先 ${botSubUsage(_hit.def, "list")} 查看。`;
			const target = list[idx - 1];
			await chatOpsMod.ensureBotChat(username, charName, platform, { chatid: target.chatid });
			return `已切换对话线：${target.name}（下条消息生效）`;
		}
		return botCommandUsage(_hit.def); // 用法文案派生自注册表（原手写串纯删）
	} catch (e) {
		return `对话线操作失败：${e?.message || e}`;
	}
}

/**
 * 尝试执行一个函数几次，如果失败则等待一段时间后重试。
 * @param {Function} func - 要执行的异步函数。
 * @param {object} [options] - 选项对象。
 * @param {number} [options.times=3] - 重试次数。
 * @param {number} [options.WhenFailsWaitFor=2000] - 失败后等待的毫秒数。
 * @returns {Promise<any>} 函数执行结果的 Promise。
 */
export async function tryFewTimes(func, { times = 3, WhenFailsWaitFor = 2000 } = {}) {
	let lastError;
	for (let i = 0; i < times; i++)
		try {
			return await func();
		} catch (error) {
			lastError = error;
			if (i < times - 1)
				await new Promise((resolve) => setTimeout(resolve, WhenFailsWaitFor));
		}
	throw lastError;
}

export const BOT_MSG_TRUNCATE_LENGTH = 2000;
export const BOT_MSG_MERGE_WINDOW_MS = 3 * 60000;
export const BOT_DEFAULT_MAX_MESSAGE_DEPTH = 20;
export const BOT_DEFAULT_MESSAGE_LOG_SIZE = 20;
export const BOT_RECONNECT_STEP_MS = 1000;
export const BOT_RECONNECT_MAX_MS = 30000;

/**
 * 外部用户消息 sanitize：角括号全角转义 + 长度截断 + external_user 标签包裹。
 * @param {string} rawContent - 原始消息内容。
 * @param {string} displayName - 发送者显示名。
 * @param {string} platform - 平台标识（"telegram"/"discord"/...）。
 * @param {{ maxLen?: number }} [options] - 可选配置。
 * @returns {string} sanitized 后的内容。
 */
export function sanitizeExternalMessage(rawContent, displayName, platform, { maxLen = BOT_MSG_TRUNCATE_LENGTH } = {}) {
	let s = String(rawContent || '')
	// SEC-PI：先剥不可见 Unicode（零宽/Tag 字符等隐形注入 payload），再做尖括号中性化。
	//   对人不可见但 tokenizer 可读，不剥则含 U+200B/U+E0000 的注入绕过尖括号防线。
	s = stripInvisibleUnicode(s)
	s = s.replace(/</g, '＜').replace(/>/g, '＞')
	if (s.length > maxLen) s = s.slice(0, maxLen) + '...[消息过长,已截断]'
	const safeName = String(displayName || 'unknown').replace(/[<>&"']/g, '').slice(0, 64)
	return `<external_user name="${safeName}" platform="${platform}">${s}</external_user>`
}

/**
 * 合并连续同人消息（同 role+name、时间窗口内合并 content）。T9 五件套公共骨架：
 * 10 个 bot 曾各写一份 MargeChatLog/MergeChatLog（拼写/命名漂移），逻辑近逐字重复，
 * 差异仅两点——① 是否保留平台专属 extension 消息 ID；② 无。统一收口到本函数，
 * 平台差异用 mergeExtensionKeys 承载（各 bot 传自己的 extension 键名）。
 *
 * ★ 融合各家已修边界（统一时不得回退）：
 *   · 深拷贝 files/extension（防合并后修改污染原 chat_log 引用）。
 *   · `!last.files?.length` 守卫：带附件的上一条不再吸并后续文本（保住附件独立成条的展示）。
 *   · 合并时把后续条目的 files 追加到 last.files（不丢附件）。
 *   · 保留平台 extension 消息 ID（mergeExtensionKeys 指定的键，用后者覆盖前者=指向合并块最新消息）。
 * 早期共享版是简化变体（无 files 处理），彼时零消费者，升级不破坏现有行为。
 *
 * @param {Array} log - 聊天记录数组。
 * @param {{ mergeWindowMs?: number, mergeExtensionKeys?: string[] }} [options] - 可选配置。
 *   mergeExtensionKeys: 合并时需从后续条目保留到 last.extension 的平台键名（如 ["discord_message_id"]）。
 * @returns {Array} 合并后的聊天记录（全新对象，不复用入参条目引用）。
 */
export function mergeChatLog(log, { mergeWindowMs = BOT_MSG_MERGE_WINDOW_MS, mergeExtensionKeys = [] } = {}) {
	if (!log?.length) return []
	const newlog = []
	let last = null
	for (const currentEntry of log) {
		const entry = { ...currentEntry } // 浅拷贝，防止修改原数组条目
		if (entry.files) entry.files = [...entry.files] // 深拷贝文件数组
		if (entry.extension) entry.extension = { ...entry.extension } // 深拷贝 extension

		if (
			last &&
			last.name === entry.name &&
			last.role === entry.role &&
			entry.time_stamp - last.time_stamp < mergeWindowMs &&
			!last.files?.length // 上一条带附件则不吸并（保附件独立展示）
		) {
			last.content = (last.content || '') + '\n' + (entry.content || '')
			if (entry.files?.length)
				last.files = [...(last.files || []), ...entry.files]
			last.time_stamp = entry.time_stamp
			for (const k of mergeExtensionKeys)
				if (entry.extension?.[k] !== undefined)
					last.extension = { ...last.extension, [k]: entry.extension[k] }
		} else {
			if (last) newlog.push(last)
			last = entry
		}
	}
	if (last) newlog.push(last)
	return newlog
}

/**
 * 内容过滤（bot 提示词侧）：mode=both 时从出站 chat_log 移除命中黑名单关键词/用户名的条目。
 * 功能层单源=user.contentFilter（与 beilu-chat requestBuilder._applyContentFilter 同语义同数据源，
 * 前端设置面板与 bot 面板写同一份）；mode=display 只影响 beilu-chat 显示，bot 无显示层故不动。
 * 消费点=9 壳 default_interface 的 generateChatReplyRequest chat_log 构建（主回复+wake 两处）。
 * @param {Array} chatLog - 出站 chat_log（各壳已浅拷贝的新数组）。
 * @param {string} username - bot 归属用户（ownerUsername）。
 * @returns {Array} 过滤后的 chat_log（未启用/未命中时原样返回）。
 */
export function applyBotContentFilter(chatLog, username) {
	const cf = getUserByUsername(username)?.contentFilter
	if (!cf || cf.mode !== 'both') return chatLog
	const msgKw = Array.isArray(cf.msgKeywords) ? cf.msgKeywords.filter(Boolean) : []
	const userBl = Array.isArray(cf.userNames) ? cf.userNames.filter(Boolean) : []
	if (!msgKw.length && !userBl.length) return chatLog
	return chatLog.filter(entry => {
		if (userBl.length && entry.name && userBl.some(u => String(entry.name).includes(u))) return false
		if (msgKw.length && msgKw.some(kw => String(entry.content || '').includes(kw))) return false
		return true
	})
}

export function extractPlatformContentShared(rawContent, displayTag) {
	if (!rawContent) return "";
	// 1. 优先提取本平台专属块。
	const tagRegex = new RegExp(`<${displayTag}>([\\s\\S]*?)<\\/${displayTag}>`, "gi");
	const matches = [...rawContent.matchAll(tagRegex)];
	if (matches.length > 0)
		return matches.map((m) => m[1].trim()).join("\n");

	// 2. 降级：无本平台块 → 剥所有内部协议标签 + 所有平台块，保留 <content> 内文。
	let result = rawContent;
	for (const pat of INTERNAL_PROTOCOL_TAG_PATTERNS)
		result = result.replace(pat, "");
	result = result.replace(/<content>([\s\S]*?)<\/content>/gi, "$1");
	for (const tag of PLATFORM_DISPLAY_TAGS)
		result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
	return result.trim();
}

// ===================== T9 bot 五件套公共骨架 =====================
// 五件套 = mergeChatLog(上方已收口) / 消息日志 / DoMessageReply 逐字段 / DoDelegateWakeReply 骨架 / splitReply。
// 原则：只收各 bot 间逐字/近逐字重复块（对比数据：T9_splitReply对比_report.md + T9_DoReply系对比_report.md），
// 平台特异（触发语义/发送 API/supported_functions/上下文缓存策略）留在各 bot 薄适配层。

/**
 * 件2：bot 管理面板消息日志（环形缓冲）。原 10 个 bot 各持一份逐字相同的
 * messageLog/messageLogMaxSize/pushMessageLog/GetMessageLog/SetMessageLogSize。
 * @param {number} [initialMaxSize]
 */
export function createBotMessageLog(initialMaxSize = BOT_DEFAULT_MESSAGE_LOG_SIZE) {
	let maxSize = initialMaxSize
	const log = []
	return {
		push(entry) {
			log.push({
				id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
				timestamp: Date.now(),
				...entry,
			})
			while (log.length > maxSize) log.shift()
		},
		/** GetMessageLog 形状：{ logs, maxSize }（since=timestamp 过滤，缺省全量副本） */
		get(since) {
			const logs = since ? log.filter((e) => e.timestamp > since) : [...log]
			return { logs, maxSize }
		},
		/** SetMessageLogSize 形状：{ maxSize }（1..200 归一，非法回落 20，与原各 bot 逐字同） */
		setSize(size) {
			const n = Math.max(1, Math.min(200, parseInt(size) || 20))
			maxSize = n
			while (log.length > n) log.shift()
			return { maxSize: n }
		},
		/** ClearContext 路径用（原各 bot `messageLog.length = 0`） */
		clear() {
			log.length = 0
		},
	}
}

/**
 * 件3：AI 请求构造里 10 bot 逐字一致的 owner persona 加载段（原各 bot 内联 IIFE）。
 * @param {string} ownerUsername
 */
export async function loadOwnerPersona(ownerUsername) {
	const n = getAnyPreferredDefaultPart(ownerUsername, "personas")
	if (n) return loadPart(ownerUsername, "personas/" + n)
	return null
}

/**
 * 件4：DoDelegateWakeReply 的独占槽骨架（等占用者完成 + 槽登记 + finally 释放），9 个 bot 逐字重复段。
 * 等待是事件驱动的：槽里存的就是占用者的 promise，settle 即醒（原各 bot 为 30×2s sleep 自旋轮询，
 * 属民间锁，统一时改为直接 await 占用者；timeoutMs 保留原 60s 总预算语义）。
 * 唤醒后循环再查——占用者完成到本轮接管之间可能有新消息抢占，逐个等到槽空或超时。
 * run 内部必须自带 try/catch（平台特异的 diag/broadcastBotError 留在各 bot）——run 抛出的异常会原样
 * 冒泡给调用方（notifyBotDelegateReport 会按僵尸摘除该 waker），与各 bot 原"catch 后不外抛"语义对齐
 * 的前提是 run 不外抛。
 * @param {Object} handlers - 各 bot 的会话串行处理 Map（ChannelHandlers/ChatHandlers/...）。
 * @param {string} key - 会话键。
 * @param {() => Promise<void>} run - 唤醒轮主体。
 * @param {{ timeoutMs?: number, onBusy?: Function }} [options]
 */
export async function runExclusiveWakeSlot(handlers, key, run, { timeoutMs = 60000, onBusy } = {}) {
	const _deadline = Date.now() + timeoutMs
	while (handlers[key]) {
		const _remain = _deadline - Date.now()
		if (_remain <= 0) { onBusy?.(); return }
		await Promise.race([
			Promise.resolve(handlers[key]).catch(() => { }), // 占用者失败也算释放，错误归它自己的链路
			new Promise((r) => setTimeout(r, _remain)),
		])
	}
	const _run = (async () => {
		try { await run() }
		finally { delete handlers[key] }
	})()
	handlers[key] = _run
	await _run
}
// ---------- 件5：splitBotReply 消息分段（全 bot 单一实现，无变体参数） ----------
// 病6 的病根是「同一功能多份、质量不齐」：四阶段家族(Line/Discord/DingTalk，原含 Kook——0716 凛倾拍板删 kookbot)里也各自漂移
// （有无代码块保围栏拆、直/弯引号正则），簇B(Slack/Telegram/Wechat)缺代码块处理与相邻合并，
// xbot/wecom 是更简陋的定长/换行切。统一取各家最优合集为唯一路径：
//   ① 合并 ``` 围栏之间的行为整块（防代码块被腰斩）
//   ② 超长块智能分割：``` 块用保围栏拆分器（每段自带首尾围栏行），普通文本按句读标点切
//      （标点字符类=直引号∪弯引号超集，原 Discord 弯引号版与其余直引号版的并集）
//   ③ 硬切兜底  ④ 相邻块贪心合并到上限内  ⑤ trim+去空
// 平台差异只允许是物理约束：split_length（各平台消息长度上限），由调用方传入。
// 禁止再给本函数加行为开关参数——发现某平台"需要"不同行为时，先追链确认是真平台协议约束
// 还是历史漂移；协议约束写进本注释并全员适用性复核，漂移=统一到本实现。

/** 句读分割点：空格 + 半角标点 + 直/弯引号 + CJK 句读（各 bot 历史正则的并集） */
const _SPLIT_PUNCT_REGEX = /(?<=[ !"');?\]}'"’”。》！）：；？])/

/** ``` 代码块保围栏拆分：每段带上首尾围栏行，段内容不超预算 */
function _splitCodeBlock(code_block, split_length) {
	const lines = code_block.trim().split('\n')
	// ≤2 行（空块/单行块）无内容可按行拆；仍超长则硬切保长度契约（原实现此处原样放行=超限段流出）
	if (lines.length <= 2)
		return code_block.length > split_length
			? (code_block.match(new RegExp(`[^]{1,${split_length}}`, 'g')) || [])
			: [code_block]

	const block_begin = lines.shift() + '\n'
	const block_end = '\n' + lines.pop()
	const max_content_length = split_length - block_begin.length - block_end.length
	// 预算被围栏行吃穿（首/尾行本身逼近或超过上限，如未闭合块把长内容行当了尾行）：
	// 保围栏拆分在数学上不可行，诚实退化为整块硬切——契约是零丢字，不是永远保围栏。
	// （原 Discord/DingTalk 实现此处会产出 {1,负数} 失配正则 → 整段内容静默丢失，统一时一并根治。）
	if (max_content_length < 1)
		return code_block.match(new RegExp(`[^]{1,${split_length}}`, 'g')) || []

	const results = []
	let current_chunk = ''

	for (const line of lines) {
		if (line.length > max_content_length) {
			if (current_chunk) results.push(block_begin + current_chunk.trim() + block_end)
			current_chunk = ''
			const hard_splits = line.match(new RegExp(`[\\s\\S]{1,${max_content_length}}`, 'g')) || []
			for (const part of hard_splits) results.push(block_begin + part + block_end)
			continue
		}

		if ((current_chunk.length + line.length + 1) > max_content_length) {
			results.push(block_begin + current_chunk.trim() + block_end)
			current_chunk = line
		} else {
			if (current_chunk) current_chunk += '\n' + line
			else current_chunk = line
		}
	}

	if (current_chunk) results.push(block_begin + current_chunk.trim() + block_end)
	return results
}

/**
 * 消息分段唯一实现。
 * @param {string} reply - 待分段文本。
 * @param {number} split_length - 平台消息长度上限（唯一合法的平台差异）。
 * @returns {string[]} 每段 ≤ split_length 的消息数组（已 trim、去空段）。
 */
export function splitBotReply(reply, split_length) {
	if (!reply) return []
	let slices = reply.split('\n')

	// ① 合并 ``` 围栏之间的行
	let out = []
	let last = ''
	for (const s of slices)
		if (s.startsWith('```'))
			if (last) {
				out.push(last + '\n' + s)
				last = ''
			} else last = s
		else if (last) last += '\n' + s
		else out.push(s)
	if (last) out.push(last)
	slices = out

	// ② 超长块智能分割（代码块保围栏 / 普通文本按句读）
	out = []
	for (const s of slices)
		if (s.length > split_length)
			if (s.startsWith('```')) out.push(..._splitCodeBlock(s, split_length))
			else {
				const parts = s.split(_SPLIT_PUNCT_REGEX)
				let chunk = ''
				for (const p of parts) {
					if (chunk.length + p.length > split_length) {
						out.push(chunk)
						chunk = ''
					}
					chunk += p
				}
				if (chunk) out.push(chunk)
			}
		else out.push(s)
	slices = out

	// ③ 硬切兜底（智能分割后仍超长的段，如单句超长）
	out = []
	for (const s of slices)
		if (s.length > split_length)
			if (s.startsWith('```')) out.push(..._splitCodeBlock(s, split_length))
			else out.push(...(s.match(new RegExp(`[^]{1,${split_length}}`, 'g')) || []))
		else out.push(s)
	slices = out

	// ④ 相邻块贪心合并到上限内
	out = []
	last = ''
	for (const s of slices) {
		if (!last) {
			last = s
			continue
		}
		if (last.length + s.length + 1 < split_length) last += '\n' + s
		else {
			out.push(last)
			last = s
		}
	}
	if (last) out.push(last)

	// ⑤ trim + 去空
	return out.map((e) => e.trim()).filter((e) => e)
}

// ===================== 件6：bot 壳入口骨架（0716 P1 收口，凛倾「一个一个做」批）=====================
// 9 壳 main.mjs 归一平台名+剥注释后唯一差异=import 行序/分号风格（md5 三组实证），逻辑逐字同构。
// 消费契约面（亲核 0716）：parts_loader 调 Load({router})；ipc_server/index.mjs:43/50 调
// interfaces.invokes.ArgumentsHandler/IPCInvokeHandler；server/jobs.mjs:68/106 调
// interfaces.jobs.ReStartJob/PauseJob——工厂产同形 shell_t 对象，契约面零变化。
// loadActions 为壳侧懒加载闭包（原 handleAction 内 await import('./src/actions.mjs') 是壳相对
// 路径，共享层不可达；闭包保留原懒加载语义——actions 链只在首个动作时求值）。
import { wbT as _wbT, wbD as _wbD } from "../server/wbStub.mjs";

export function createBotShellMain(platform, { info, runBot, pauseBot, setEndpoints, loadActions }) {
	const tag = `bot:${platform}`;
	async function handleAction(user, action, params) {
		_wbT(null, tag, "handleAction:enter", { user, action, botname: params?.botname });
		const { actions } = await loadActions();
		if (!actions[action]) {
			_wbD(null, tag, "handleAction:unknownAction", false, "Unknown action", { action });
			throw new Error(`Unknown action: ${action}. Available actions: ${Object.keys(actions).join(", ")}`);
		}
		_wbT(null, tag, "actions:invoke", { action });
		return actions[action]({ user, ...params });
	}
	return {
		info,
		Load: async ({ router }) => {
			_wbT(null, tag, "Load:enter", {});
			setEndpoints(router);
		},
		Unload: async () => { },
		interfaces: {
			web: {},
			invokes: {
				ArgumentsHandler: async (user, args) => {
					_wbT(null, tag, "ArgumentsHandler:enter", { user, args });
					const [action, name, jsonData] = args;
					const params = {
						botname: name,
						charname: name,
						configData: jsonData ? JSON.parse(jsonData) : undefined,
					};
					await handleAction(user, action, params);
				},
				IPCInvokeHandler: async (user, data) => {
					_wbT(null, tag, "IPCInvokeHandler:enter", { user, action: data?.action });
					const { action, ...params } = data;
					return handleAction(user, action, params);
				},
			},
			jobs: {
				PauseJob: async (user, botname) => {
					_wbT(null, tag, "PauseJob:enter", { user, botname });
					await pauseBot(user, botname);
				},
				ReStartJob: async (user, botname) => {
					_wbT(null, tag, "ReStartJob:enter", { user, botname });
					let sleep_time = 0;
					while (true) try {
						_wbT(null, tag, "runBot:attempt", { botname, sleep_time });
						await runBot(user, botname);
						_wbT(null, tag, "runBot:exit", { botname });
						break;
					} catch (error) {
						_wbD(null, tag, "runBot:error", false, error?.message, { botname, sleep_time });
						console.error(error);
						await new Promise((resolve) => setTimeout(resolve, sleep_time));
						sleep_time = Math.min(sleep_time + BOT_RECONNECT_STEP_MS, BOT_RECONNECT_MAX_MS);
					}
				},
			},
		},
	};
}

// ===================== 件7：bot 动作字典（0716 P1 收口）=====================
// 9 壳 actions.mjs 归一后差异仅=import 折行/空行/错误文案长短/wecom config 同步版（md5 四组 diff 实证，
// 8 动作全同构：list/create/delete/config/get-config/get-template/start/stop）。统一 async+await 形状
// 对 wecom 同步 setBotConfig 等价（await 非 Promise=原值）；错误文案统一 discord 长版（非契约面，
// 前端不解析）。botModule=各壳 ./bot.mjs 命名空间（7 个同名导出，9 壳一致）。
export function createBotActions({ runBot, stopBot, getBotList, setBotConfig, deleteBotConfig, getBotConfig, getBotConfigTemplate }) {
	return {
		list: ({ user }) => getBotList(user),
		create: ({ user, botname }) => {
			if (!botname) throw new Error('Bot name is required for create action.')
			setBotConfig(user, botname, {})
			return `Bot '${botname}' created.`
		},
		delete: async ({ user, botname }) => {
			if (!botname) throw new Error('Bot name is required for delete action.')
			await deleteBotConfig(user, botname)
			return `Bot '${botname}' deleted.`
		},
		config: async ({ user, botname, configData }) => {
			if (!botname) throw new Error('Bot name is required for config action.')
			await setBotConfig(user, botname, configData)
			return `Bot '${botname}' configured.`
		},
		'get-config': ({ user, botname }) => {
			if (!botname) throw new Error('Bot name is required for get-config action.')
			return getBotConfig(user, botname)
		},
		'get-template': ({ user, charname }) => {
			if (!charname) throw new Error('Char name is required for get-template action.')
			return getBotConfigTemplate(user, charname)
		},
		start: async ({ user, botname }) => {
			if (!botname) throw new Error('Bot name is required for start action.')
			await runBot(user, botname)
			return `Bot '${botname}' started.`
		},
		stop: async ({ user, botname }) => {
			if (!botname) throw new Error('Bot name is required for stop action.')
			await stopBot(user, botname)
			return `Bot '${botname}' stopped.`
		},
	}
}

// ===================== 件8：bot HTTP 端点注册器（0716 P1 收口）=====================
// 9 壳 endpoints.mjs 的 15 个标准端点空白归一 diff 实证语义同构（差异=引号/折行/lark unmask 内联形）。
// 行为变化（收口时一并根治，凛倾拍板「名字用 discord 系列」）：
//   ① 活跃会话端点统一 /activechannels——原 telegram/line/lark/wechat/wecom 用 /activechats，而前端
//     sendAction getActiveChannels 只拼 /activechannels = 这 5 壳监控面板活跃列表恒 404（0716 确诊，
//     activechats 全库零其他消费方）；② xbot 原缺该端点，统一后天然补上（iface 无 GetActiveChannels
//     → 空数组，与 discord 兜底同语义）。
// 特异端点（line webhook+tempfile / wecom webhook GET+POST / wechat webhook）不进本注册器，
// 留壳侧 setEndpoints 原文（平台回调无 authenticate 是正确形，不套标准骨架）。
export function createBotEndpoints(shellname, { botModule, getBotInterface }) {
	const { runBot, stopBot, getBotList, getRunningBotList, getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig } = botModule
	return function setStandardEndpoints(router) {
		// 路径转义链（0716 断链教训）：源码 `\\:` → JS cooked `\:` → Express 视为转义冒号=字面 ":"
		// 路由段。写单 `\:` 会被模板串 cook 成裸 ":" → Express 把 ":shellname" 解析成路径参数=路由变形。
		const p = `/api/parts/shells\\:${shellname}`
		router.post(p + "/start", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.body
			await runBot(username, botname)
			res.status(200).json({ message: "start ok", botname })
		})
		router.post(p + "/stop", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.body
			await stopBot(username, botname)
			res.status(200).json({ message: "stop ok", botname })
		})
		router.get(p + "/getbotlist", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			res.status(200).json(getBotList(username))
		})
		router.get(p + "/getrunningbotlist", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			res.status(200).json(getRunningBotList(username))
		})
		router.get(p + "/getbotconfig", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.query
			const config = await getBotConfig(username, botname)
			res.status(200).json(maskBotConfig(config)) // B-3：密钥字段回前端脱敏
		})
		router.get(p + "/getbotConfigTemplate", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { charname } = req.query
			const config = await getBotConfigTemplate(username, charname)
			res.status(200).json(config)
		})
		// 件14：配置字段元数据下发（BOT_CONFIG_FIELD_META 全局单源，前端预取渲染 label/hint）
		router.get(p + "/getconfigfieldmeta", authenticate, async (_req, res) => {
			res.status(200).json(BOT_CONFIG_FIELD_META)
		})
		// 命令注册表下发（同 getconfigfieldmeta 的「后端权威清单下发」范式）：前端 bot 界面的命令区
		// 唯一数据源，禁前端另存一份命令清单——加命令只改 BOT_COMMAND_REGISTRY，界面自动跟随。
		// 与 meta 一样是全局静态（与壳/角色无关），任一壳拉取即可。
		router.get(p + "/getcommandmeta", authenticate, async (_req, res) => {
			res.status(200).json(getBotCommandMeta())
		})
		router.post(p + "/setbotconfig", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname, config } = req.body
			const _existing = await getBotConfig(username, botname) // B-3：回传若为掩码占位则保留原值，不覆盖真 token
			setBotConfig(username, botname, unmaskBotConfig(config, _existing))
			res.status(200).json({ message: "config saved" })
		})
		router.post(p + "/deletebotconfig", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.body
			deleteBotConfig(username, botname)
			res.status(200).json({ message: "bot deleted" })
		})
		router.post(p + "/newbotconfig", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.body
			setBotConfig(username, botname, {})
			res.status(200).json({ message: "bot created" })
		})
		router.post(p + "/clearcontext", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.body
			try {
				const iface = await getBotInterface(username, botname)
				if (!iface?.ClearContext)
					return res.status(400).json({ error: "Bot not running or no ClearContext method" })
				const result = iface.ClearContext()
				res.status(200).json({ message: "context cleared", ...result })
			} catch (error) {
				res.status(500).json({ error: error.message })
			}
		})
		router.get(p + "/activechannels", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname } = req.query
			try {
				const iface = await getBotInterface(username, botname)
				if (!iface?.GetActiveChannels)
					return res.status(200).json([])
				res.status(200).json(iface.GetActiveChannels())
			} catch (error) {
				res.status(500).json({ error: error.message })
			}
		})
		router.get(p + "/messagelog", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname, since } = req.query
			try {
				const iface = await getBotInterface(username, botname)
				if (!iface?.GetMessageLog)
					return res.status(200).json({ logs: [], maxSize: 20 })
				const sinceTs = since ? parseInt(since) : undefined
				res.status(200).json(iface.GetMessageLog(sinceTs))
			} catch (error) {
				res.status(500).json({ error: error.message })
			}
		})
		router.post(p + "/setlogsize", authenticate, async (req, res) => {
			const { username } = await getUserByReq(req)
			const { botname, size } = req.body
			try {
				const iface = await getBotInterface(username, botname)
				if (!iface?.SetMessageLogSize)
					return res.status(400).json({ error: "Bot not running or no SetMessageLogSize method" })
				res.status(200).json(iface.SetMessageLogSize(size))
			} catch (error) {
				res.status(500).json({ error: error.message })
			}
		})
	}
}
import { authenticate, getUserByReq } from "../yonban/core/functions/security/auth.mjs";
import { maskBotConfig, unmaskBotConfig } from "../yonban/core/functions/security/secret_box.mjs";

// ===================== 件9：bot 生命周期骨架（0716 P1 收口，L4）=====================
// 9 壳 bot.mjs 逐份亲读（telegram/discord 全文，slack/line/xbot/lark/dingtalk/wecom/wechat runBot~pause
// 段+startBot），骨架完全同构：config CRUD / 接口 ensure+cache / runBot 缓存查重+启动编排+StartJob+
// 错误外显 / stop+pause / on_shutdown / 用户删除·改名事件钩 / list·getter。平台特异收敛为两钩子：
//   connect(config, char, ctx) → handle（各壳原 startBot/内联段：discord Client+login、telegram
//   Bot+start、slack App(socketMode)、line createLineClient+OnBotReady、xbot 轮询 stopPolling 句柄、
//   lark WSClient、dingtalk Stream client、wecom OnBotReady(无长连)、wechat Init(桥接)）
//   disconnect(handle, ctx)（destroy/stop/stopPolling/wsClient.stop/disconnect/cleanup/Destroy）
// line 原「接口装配在 startBot 内」= 位置漂移，归一到骨架 ensure（同语义：ensure+create+缓存）。
// 壳侧保留：平台私有导出（line createLineClient/getBotClientAndMiddleware、
// wechat pushWebhookMessage）+ getBotXxxInterface 别名（= 工厂 getBotInterface，保外部契约）。
import { getAllUserNames as _lcGetAllUserNames } from "../yonban/core/functions/security/auth.mjs";
import { createDiag as _lcCreateDiag } from "../server/diagLogger.mjs";
import { events as _lcEvents } from "../server/events.mjs";
import { EndJob as _lcEndJob, StartJob as _lcStartJob } from "../server/jobs.mjs";
import { loadShellData as _lcLoadShellData, loadTempData as _lcLoadTempData, saveShellData as _lcSaveShellData } from "../server/setting_loader.mjs";
import { broadcastBotError as _lcBroadcastBotError } from "../public/parts/shells/botErrorBroadcast.mjs";

export function createBotLifecycle(shellname, { interfaceKey, createInterface, connect, disconnect }) {
	const diag = _lcCreateDiag(interfaceKey);
	const ifaceCache = new Map(); // key: "username/botname" → 接口引用（ClearContext 等操作用）
	const cacheName = `${shellname}_cache`;

	function getBotsData(username) {
		return _lcLoadShellData(username, shellname, "bot_configs");
	}
	function getBotConfig(username, botname) {
		const botsData = getBotsData(username);
		return botsData[botname] || {};
	}
	async function ensureInterface(char, username, charname) {
		if (!char.interfaces[interfaceKey]) {
			diag.debug(`ensureInterface: char="${charname}" 无自定义接口，使用默认接口`);
			char.interfaces[interfaceKey] = await createInterface(char, username, charname);
		}
		return char.interfaces[interfaceKey];
	}
	async function getBotConfigTemplate(username, charname) {
		const { loadPart } = await import("../server/parts_loader.mjs");
		const char = await loadPart(username, "chars/" + charname);
		await ensureInterface(char, username, charname);
		return (await char.interfaces[interfaceKey]?.GetBotConfigTemplate?.()) || {};
	}
	function setBotConfig(username, botname, config) {
		const botsData = getBotsData(username);
		botsData[botname] = config;
		_lcSaveShellData(username, shellname, "bot_configs");
	}
	function deleteBotConfig(username, botname) {
		const botsData = getBotsData(username);
		delete botsData[botname];
		_lcSaveShellData(username, shellname, "bot_configs");
	}
	async function runBot(username, botname) {
		diag.time(`runBot:${botname}`);
		diag.log(`runBot: user="${username}", bot="${botname}"`);
		const botCache = _lcLoadTempData(username, cacheName);
		if (botCache[botname]) {
			diag.debug(`runBot: bot="${botname}" 已在运行，跳过`);
			return;
		}
		botCache[botname] = (async () => {
			const config = getBotConfig(username, botname);
			if (!Object.keys(config).length)
				throw new Error(`Bot ${botname} not found`);
			const { loadPart } = await import("../server/parts_loader.mjs");
			const char = await loadPart(username, "chars/" + config.char);
			await ensureInterface(char, username, config.char);
			const cacheKey = `${username}/${botname}`;
			if (char.interfaces[interfaceKey])
				ifaceCache.set(cacheKey, char.interfaces[interfaceKey]);
			return await connect(config, char, { username, botname, diag });
		})();
		try {
			botCache[botname] = await botCache[botname];
			_lcStartJob(username, `shells/${shellname}`, botname);
			diag.timeEnd(`runBot:${botname}`);
			diag.snapshot(`runBot:${botname}`, { username, botname, status: "running" });
		} catch (error) {
			delete botCache[botname];
			diag.error(`runBot: bot="${botname}" 启动失败`, error);
			// BR2: 启动失败外显到前端 [O] 监控红点（phase=start）
			_lcBroadcastBotError({ username, platform: shellname, botname, phase: "start", error });
			throw error;
		}
	}
	async function stopBot(username, botname) {
		diag.log(`stopBot: user="${username}", bot="${botname}"`);
		const botCache = _lcLoadTempData(username, cacheName);
		const cacheKey = `${username}/${botname}`;
		if (botCache[botname])
			try {
				const handle = await botCache[botname];
				await disconnect(handle, { username, botname, iface: ifaceCache.get(cacheKey), diag });
				diag.log(`stopBot: bot="${botname}" 已停止`);
			} finally {
				delete botCache[botname];
				ifaceCache.delete(cacheKey);
			}
		_lcEndJob(username, `shells/${shellname}`, botname);
	}
	async function pauseBot(username, botname) {
		diag.debug(`pauseBot: user="${username}", bot="${botname}"`);
		const botCache = _lcLoadTempData(username, cacheName);
		if (!botCache[botname]) return;
		try {
			const handle = await botCache[botname];
			await disconnect(handle, { username, botname, iface: ifaceCache.get(`${username}/${botname}`), diag });
			diag.debug(`pauseBot: bot="${botname}" 已暂停`);
		} finally {
			delete botCache[botname];
		}
	}
	function getRunningBotList(username) {
		return Object.keys(_lcLoadTempData(username, cacheName));
	}
	function getBotList(username) {
		return Object.keys(getBotsData(username));
	}
	function getBotInterface(username, botname) {
		return ifaceCache.get(`${username}/${botname}`) || null;
	}

	// 关停/用户生命周期钩（原各壳模块顶层注册，工厂调用时机=壳模块加载时机，注册份数与时点等价）
	import("npm:on-shutdown").then(({ on_shutdown }) => {
		on_shutdown(async () => {
			for (const username of _lcGetAllUserNames())
				for (const botname of Object.keys(_lcLoadTempData(username, cacheName)))
					await pauseBot(username, botname).catch(console.error);
		});
	});
	_lcEvents.on("BeforeUserDeleted", async ({ username }) => {
		const runningBots = getRunningBotList(username);
		diag.log(`BeforeUserDeleted: user="${username}", 运行中bot数=${runningBots.length}`);
		for (const botname of runningBots)
			try { await stopBot(username, botname); }
			catch (error) { diag.error(`BeforeUserDeleted: 停止 bot="${botname}" 失败`, error); }
	});
	_lcEvents.on("BeforeUserRenamed", async ({ oldUsername }) => {
		const runningBots = getRunningBotList(oldUsername);
		diag.log(`BeforeUserRenamed: "${oldUsername}", 运行中bot数=${runningBots.length}`);
		for (const botname of runningBots)
			try { await stopBot(oldUsername, botname); }
			catch (error) { diag.error(`BeforeUserRenamed: 停止 bot="${botname}" 失败`, error); }
	});

	return { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList, getBotInterface };
}

// ===================== 件10：默认插件全量加载（0716 P3 收口，di 骨架第一件）=====================
// 9 壳 default_interface 的 allPlugins 加载段语义全同（哈希差异=日志文案/花括号风格），收口单源。
// 与 beilu-chat 一致的完整消息管线依赖此插件集；单插件失败仅 warn 跳过（原语义），列表失败返回空集。
export async function loadAllDefaultPlugins(ownerUsername, diag) {
	const allPlugins = {};
	try {
		const pluginNames = getAllDefaultParts(ownerUsername, "plugins");
		for (const pluginName of pluginNames) {
			try {
				allPlugins[pluginName] = await loadPart(ownerUsername, "plugins/" + pluginName);
			} catch (e) {
				diag?.warn?.(`加载插件 ${pluginName} 失败:`, e.message);
			}
		}
		diag?.log?.(`已加载 ${Object.keys(allPlugins).length} 个默认插件`);
	} catch (e) {
		diag?.error?.("加载默认插件列表失败:", e.message);
	}
	return allPlugins;
}

/**
 * 件11：消息队列生命周期骨架（P3 di 深层骨架第一件，命名统一 discord 系）。
 * 收口 8 壳（xbot=轮询范式不适用）逐字重复的队列三元组：
 *   Queues map + Handlers map + HandleMessageQueue(try/while-shift/catch/finally 释放槽) + 入队三行式。
 * 时序契约（与原各壳逐字同语义，勿改）：
 *   ① enqueue：push 后仅当槽空才创建 handler——同会话严格串行，无并发处理器；
 *   ② handler 持有队列数组引用，运行期间新 push 的消息会被同一 while 捡走；
 *   ③ 槽释放在 finally——异常也不漏（wecom 原版无 try/finally=异常漏释放死锁，统一时一并根治）；
 *   ④ 槽同时是委派唤醒的互斥闸：runExclusiveWakeSlot(runtime.handlers, id, fn) 直接复用。
 * 平台差异全部收敛为两个注入点（后端功能复用，前端和储存做差异）：
 *   processItem(item, channelId)——单条处理（平台转换→记日志→触发判定→回复），队列元素形状由壳自定；
 *   onQueueStart(channelId, firstItem)——可选，handler 启动钩（discord 用于首次历史消息加载，壳自判条件）。
 * 二者内部异常会被骨架 catch 记 diag.error 并结束本轮排队（原各壳同语义：单条出错=整轮排队终止，
 * 残余消息留在队列由下一条新消息触发的 handler 接续）。
 * @param {object} opts
 * @param {object} opts.diag - 壳诊断器（time/timeEnd/debug/error）。
 * @param {string} [opts.label] - 日志标签，默认 'HandleMessageQueue'。
 * @param {(item: object, channelId: string) => Promise<void>} opts.processItem
 * @param {(channelId: string, firstItem: object) => Promise<void>} [opts.onQueueStart]
 * @returns {{ enqueue: (channelId: string, item: object) => void, queues: Record<string, object[]>, handlers: Record<string, Promise<void>> }}
 */
export function createMessageQueueRuntime({ diag, label = "HandleMessageQueue", processItem, onQueueStart }) {
	const ChannelMessageQueues = {}; // Record<string, object[]>
	const ChannelHandlers = {}; // Record<string, Promise<void>>

	async function HandleMessageQueue(channelId) {
		diag.time(`${label}:${channelId}`);
		diag.debug(
			`${label}: channel="${channelId}", 队列长度=${ChannelMessageQueues[channelId]?.length || 0}`,
		);
		const myQueue = ChannelMessageQueues[channelId];
		try {
			if (onQueueStart) await onQueueStart(channelId, myQueue[0]);
			while (myQueue.length) {
				const item = myQueue.shift();
				if (!item) continue;
				// meta.pending=本条处理时队列中的后续消息数（连发防抖判据：>0=还有后续，壳可选
				// 跳过本条生成只入上下文，由末条触发——beilu 有串行队列，防抖无需计时器，
				// openclaw/LangBot 的 debounceMs 形是因为它们无 per-channel 队列）。不消费=零行为变化。
				await processItem(item, channelId, { pending: myQueue.length });
			}
		} catch (error) {
			diag.error(`${label}: channel="${channelId}" 处理出错`, error);
		} finally {
			diag.timeEnd(`${label}:${channelId}`);
			delete ChannelHandlers[channelId];
		}
	}

	function enqueue(channelId, item) {
		(ChannelMessageQueues[channelId] ??= []).push(item);
		if (!ChannelHandlers[channelId])
			ChannelHandlers[channelId] = HandleMessageQueue(channelId);
	}

	return { enqueue, queues: ChannelMessageQueues, handlers: ChannelHandlers };
}

// ===================== 件12：触发判定单源（0716，业界四家共识形）=====================
// 五框架对照（总表_五框架bot协议对照_20260716.md）：openclaw(facts/policy 纯函数)/AstrBot/LangBot(统一
// 管线阶段)/koishi(中间件层)四家均把触发判定收统一层、平台只产事实——beilu P4 归一键名后判定逻辑仍
// 8 壳散写（结构同构、微差=历史漂移质量不齐），本件收单源。语义基准=discord（凛倾拍板「名字用
// discord系列」的延伸），统一时抹平的漂移微差（均为放宽，无收紧）：
//   ① dingtalk 群 @ 触发原带白名单门（白名单外群被 @ 不回）→ 基准 @ 触发无白名单门（discord 形）
//   ② telegram 说话触发原限 group/supergroup / line 原限 group|room → 域语义交 facts.canGroupTrigger 由壳定
// 平台差异全部收敛为 facts（壳采集的客观事实）+opts（旧键回退映射/特异 mention 键）：
//   facts.isDM         私聊会话
//   facts.isMentioned  被 @ / 回复 bot（壳按平台协议采集；无 @ 概念的平台恒 false，如 wecom）
//   facts.canGroupTrigger 说话触发（白名单模式）适用域（discord/slack/lark=true 原语义无门；
//                      telegram/line/wechat/wecom=isGroup，平台会话类型语义属物理域）
//   facts.whitelistId  白名单匹配键（频道id/群id/会话id，平台各异）
//   facts.senderId     发送者 id（C6 用户白名单判定键）
//   facts.isOwner      发送者是否主人（各壳 owner 字段语义不同，判定留壳）
//   facts.isSelf / facts.isFromBot  自身/其他 bot 消息（不回；在入站层已过滤的壳传 false 即可）
// P4 旧键回退（存量兼容，dingtalk 0716 先例范式）也收进本函数：opts.legacy 声明平台旧键名，
// 统一键 undefined 时降级读旧键。判定树（discord 基准）：
//   ReplyToAllMessages(旧全回键) ∨ (isDM ∧ 私聊开) ∨ (被@ ∧ @开) ∨ (canGroupTrigger ∧ 说话开 ∧ 白名单命中)
//   → 叠加 C6 checkBotTriggerAllowed → 排除 isSelf/isFromBot
/**
 * @param {object} facts - 平台事实（见上）。
 * @param {object} config - bot 配置（P4 统一键 + 可能残留的平台旧键）。
 * @param {object} [opts]
 * @param {{privateKey?: string, groupKey?: string, whitelistKey?: string, mentionLegacyKey?: string}} [opts.legacy] - 旧键回退映射。
 * @param {string} [opts.mentionKey] - @ 触发读键（默认 TriggerOnMention；wechat 特异=TriggerOnGroupMention）。
 * @param {object} [opts.diag] - 壳诊断器（C6 忽略时记日志）。
 * @param {string} [opts.logContext] - 日志上下文尾串（如 `channel="xxx"`）。
 * @returns {boolean} 是否应触发回复。
 */
export function resolveBotTrigger(facts, config, { legacy = {}, mentionKey = "TriggerOnMention", diag, logContext = "" } = {}) {
	const privateEnabled = config.PrivateChatEnabled !== undefined
		? config.PrivateChatEnabled !== false
		: (legacy.privateKey ? config[legacy.privateKey] !== false : true);
	const mentionEnabled = config[mentionKey] !== undefined
		? config[mentionKey] !== false
		: (legacy.mentionLegacyKey ? config[legacy.mentionLegacyKey] !== false : true);
	const groupMsgEnabled = config.TriggerOnMessage !== undefined
		? config.TriggerOnMessage
		: (legacy.groupKey ? config[legacy.groupKey] : false);
	const whitelist = (config.TriggerChannels && config.TriggerChannels.length)
		? config.TriggerChannels
		: (legacy.whitelistKey ? (config[legacy.whitelistKey] || []) : []);
	const whitelistHit = whitelist.length === 0 || whitelist.includes(facts.whitelistId);

	let shouldReply = false;
	if (config.ReplyToAllMessages)
		shouldReply = true;
	else if (facts.isDM && privateEnabled)
		shouldReply = true;
	else if (facts.isMentioned && mentionEnabled)
		shouldReply = true;
	else if (facts.canGroupTrigger && groupMsgEnabled && whitelistHit)
		shouldReply = true;

	// C6: 用户级触发白名单（叠加在私聊/@/说话触发判定之后）。非白名单忽略不消耗 Token 但记日志。
	if (shouldReply && !checkBotTriggerAllowed(config, facts.senderId, !!facts.isOwner)) {
		diag?.log?.(`触发白名单已忽略: user="${facts.senderId}"${logContext ? `, ${logContext}` : ""}`);
		shouldReply = false;
	}
	if (shouldReply && (facts.isSelf || facts.isFromBot))
		shouldReply = false;
	return shouldReply;
}

// ===================== 件14：配置字段元数据单源（0716，业界四家共识形=schema 携带 label）=====================
// 五框架对照：openclaw configSchema+UI hint/koishi Schemastery/AstrBot CONFIG_METADATA/LangBot yaml manifest
// 均由后端 schema 携带 label——原 beilu label 在前端 VC_FIELD_META 字典（与后端模板键集可漂移：新键加了
// 模板没加 meta=裸键显示）。收单源于此，经 getconfigfieldmeta 端点下发，前端预取缓存+裸键兜底。
// 键=全局唯一语义（同名键跨壳同义），值={label, type, hint?, placeholder?, min?, max?}。
export const BOT_CONFIG_FIELD_META = {
	OwnerUserName: { label: "主人用户名", type: "text", hint: "身份识别（显示/回退）" },
	OwnerUserId: { label: "主人用户ID（鉴权优先）", type: "text", hint: "平台数字 ID，优先于用户名" },
	OwnerWxid: { label: "主人 wxid（鉴权优先）", type: "text", hint: "稳定 wxid，优先于昵称" },
	MaxMessageDepth: { label: "最大历史深度", type: "number", min: 1, max: 100 },
	MaxFetchCount: { label: "启动拉取历史条数", type: "number", min: 1, max: 200 },
	ReplyToAllMessages: { label: "回复所有消息（旧）", type: "bool" },
	TriggerOnMention: { label: "@触发", type: "bool" },
	TriggerOnGroupMention: { label: "群内@触发", type: "bool" },
	TriggerOnMessage: { label: "消息触发（白名单频道）", type: "bool" },
	TriggerOnGroupMessage: { label: "群消息触发（白名单群）", type: "bool" },
	TriggerOnChannel: { label: "频道消息触发（白名单）", type: "bool" },
	TriggerOnGroup: { label: "群消息触发（白名单群）", type: "bool" },
	PrivateChatEnabled: { label: "允许私聊", type: "bool" },
	TriggerOnPrivate: { label: "允许私聊", type: "bool" },
	TriggerOnDM: { label: "允许私信", type: "bool" },
	TriggerChannels: { label: "触发频道白名单（频道ID，逗号分隔）", type: "array", placeholder: "频道ID1, 频道ID2..." },
	TriggerGroups: { label: "触发群白名单（群ID，逗号分隔）", type: "array", placeholder: "群ID1, 群ID2..." },
	PollIntervalMs: { label: "轮询间隔（毫秒）", type: "number" },
	MaxTweetLength: { label: "推文最大长度", type: "number" },
	publicBaseUrl: { label: "公网基础 URL（文件发送）", type: "text", placeholder: "https://..." },
	StreamReplyEnabled: { label: "流式回复（滚动编辑）", type: "bool", hint: "生成中滚动更新消息；关=生成完一次性发送" },
	BurstDebounceEnabled: { label: "连发吸收", type: "bool", hint: "连发多条只回最后一条；命令/附件消息不吸收" },
	DailyPostBudget: { label: "每日发帖预算", type: "number", min: 0, hint: "X Free 层官方 50/天；0=禁发帖，DM 不占额度" },
};

// ===================== 件13：流式回复编辑骨架（0716 凛倾拍板「按照官方的来」）=====================
// 生成侧正主=既有 generation_options.replyPreviewUpdater 链（AIsource 全线 use_stream→角色模板装饰链，
// 零新生成机制）；本件只收"平台滚动编辑一条消息"的时序骨架，平台差异=sendInitial/editMessage 两注入点。
// 官方编辑通道（官方规则调研 0716）：Telegram editMessageText（≥1s 间隔安全）/Slack chat.update/
// Discord message.edit；LINE/X 无编辑能力=不接本件（能力缺省诚实降级）。
// 时序契约（「注意时序和异步问题」）：
//   ① update 同步入口（replyPreviewUpdater 是同步签名），内部单泵异步投递——in-flight 未完成时新
//      update 只覆盖 pending，完成后投递最新一版（尾随合并，绝不并发编辑同一消息）；
//   ② minIntervalMs 节流对齐官方编辑限速；
//   ③ 任一投递失败=置死+warn，后续 update 静默丢弃——流式是增强面，失败不影响主回复全量路径；
//   ④ finalize 等 in-flight 排空后把预览消息编辑为最终首段：返回消息句柄=首段已投递（调用方跳过
//      首段只补余段/文件），返回 null=全量降级（调用方按原路径完整发送）。
/**
 * @param {object} opts
 * @param {object} [opts.diag] - 壳诊断器。
 * @param {(text: string) => Promise<any>} opts.sendInitial - 发送首条预览消息，返回消息句柄（id 等）。
 * @param {(handle: any, text: string) => Promise<void>} opts.editMessage - 编辑该消息为新文本。
 * @param {number} [opts.maxLen] - 平台单条消息长度上限（预览截断）。
 * @param {number} [opts.minIntervalMs] - 两次投递最小间隔（对齐官方编辑限速）。
 */
/**
 * 件13 配套：把流式编辑器包成 chatRequest.generation_options（三壳逐字同构段收单源，防散写）。
 * 角色模板 beilu-char-template :293-305 会以 ??= 保留并装饰链尾调用本回调；AI 源 partial.content
 * 为全量累积（claude-api :381 result.content += delta 实证），滚动编辑语义正确。
 * @param {ReturnType<typeof createBotStreamEditor>|null} stream - 流式编辑器（null=返回 undefined 走全量）。
 * @param {string} displayTag - 平台标签（extractPlatformContentShared 提取键）。
 * @returns {object|undefined}
 */
export function makeStreamGenerationOptions(stream, displayTag) {
	if (!stream) return undefined;
	return {
		replyPreviewUpdater: (partial) => stream.update(
			extractPlatformContentShared(partial?.content_for_show || partial?.content || "", displayTag),
		),
	};
}

/**
 * #9 配套：连发吸收判定（三壳逐字同构段收单源，防散写）。true=本条只入上下文不生成，由末条触发。
 * openclaw 三不合并同义：控制命令必须立即（!chat/!skill 在 DoMessageReply 内处理，吸收=命令丢失）、
 * 带媒体不吸收、开关（BurstDebounceEnabled 默认关）。
 * @param {{config: object, pending: number, text: string, hasMedia: boolean}} p
 * @returns {boolean}
 */
export function shouldAbsorbBurst({ config, pending, text, hasMedia }) {
	if (!config?.BurstDebounceEnabled || !(pending > 0) || hasMedia) return false;
	// 命令豁免判据收口 parseBotCommand（原为两个前缀常量各 startsWith——命令识别的**第二个散点**：
	// 注册表新增第三条命令时这里不认识它 → 该命令被连发吸收「只入上下文由末条触发」= 静默吞掉永不执行）。
	return parseBotCommand(text) === null;
}

export function createBotStreamEditor({ diag, sendInitial, editMessage, maxLen = 4000, minIntervalMs = 1200, opTimeoutMs = 15000 }) {
	let _handle = null, _lastText = "", _pendingText = null, _busy = false, _dead = false, _timer = null, _nextAllowedAt = 0;
	// [0804 根因修·B5] 平台 sendInitial/editMessage 无自带超时时可无期限挂起 → _busy 永不清 →
	//   finalize 的 while(_busy) 死等（03 §九.6 finalize 无 deadline）。用超时竞速包裹平台调用，
	//   保证 _busy 必清、finalize 必返；超时按失败处理走全量降级（下方去重逻辑防重复补发）。
	async function _withTimeout(promise, label) {
		let _t;
		const _timeout = new Promise((_, reject) => { _t = setTimeout(() => reject(new Error(`${label} 超时 ${opTimeoutMs}ms`)), opTimeoutMs); });
		try { return await Promise.race([promise, _timeout]); }
		finally { clearTimeout(_t); }
	}
	async function _pump() {
		if (_busy || _dead || _pendingText === null) return;
		const now = Date.now();
		if (now < _nextAllowedAt) {
			if (!_timer) _timer = setTimeout(() => { _timer = null; _pump(); }, _nextAllowedAt - now);
			return;
		}
		const text = _pendingText;
		_pendingText = null;
		_busy = true;
		try {
			if (_handle === null) _handle = await _withTimeout(Promise.resolve(sendInitial(text)), "sendInitial");
			else if (text !== _lastText) await _withTimeout(Promise.resolve(editMessage(_handle, text)), "editMessage");
			_lastText = text;
			_nextAllowedAt = Date.now() + minIntervalMs;
		} catch (e) {
			_dead = true;
			diag?.warn?.(`streamEditor: 流式编辑失败，走全量降级: ${e.message}`);
		} finally {
			_busy = false;
			if (!_dead && _pendingText !== null) _pump();
		}
	}
	return {
		update(text) {
			if (_dead) return;
			const t = String(text || "").slice(0, maxLen);
			if (!t.trim() || t === _lastText) return;
			_pendingText = t;
			_pump();
		},
		async finalize(finalText) {
			_pendingText = null;
			if (_timer) { clearTimeout(_timer); _timer = null; }
			// [0804 B5] 有界等待 in-flight 排空（原 while(_busy) 无 deadline）：_pump 已有超时保证
			//   _busy 会清，这里再设兜底上限（略大于单次 op 超时），到点强制继续，绝不永久卡回复管线。
			const _waitDeadline = Date.now() + opTimeoutMs + 2000;
			while (_busy && Date.now() < _waitDeadline) await new Promise((r) => setTimeout(r, 50));
			const handle = _handle;
			_dead = true; // 停收后续 update
			if (handle === null) return null; // 从未投递过预览=全量路径（无重复风险）
			const t = String(finalText || "").slice(0, maxLen);
			if (!t.trim()) { diag?.warn?.("streamEditor: 最终首段为空，预览消息保留末态"); return null; }
			if (t === _lastText) return handle; // 预览末态已=最终首段，无需编辑
			// [0804 B5] 最终编辑失败原直接返 null → 调用方补发【完整】回复叠在已可见预览上 = 重复。
			//   瞬时失败（限速/网络抖）占多数：单次退避重试削减重复触发。真失败仍返 null 走全量降级——
			//   重复代价 < 内容丢失代价（改返 handle 让调用方跳首段会丢失预览未覆盖的首段尾部内容）；
			//   彻底去重（删除陈旧预览 / 只补 delta）需调用方 redesign + delete 能力，留 B5 backlog。
			for (let _attempt = 0; _attempt < 2; _attempt++) {
				try { await _withTimeout(Promise.resolve(editMessage(handle, t)), "finalEdit"); return handle; }
				catch (e) {
					if (_attempt === 0) { diag?.warn?.(`streamEditor: 最终编辑失败（${e.message}），退避重试一次`); await new Promise((r) => setTimeout(r, minIntervalMs)); continue; }
					diag?.warn?.(`streamEditor: 最终编辑重试仍失败（${e.message}），全量降级（内容完整；预览陈旧的彻底去重留 B5 backlog）`);
					return null;
				}
			}
			return null;
		},
	};
}

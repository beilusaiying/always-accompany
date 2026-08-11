/**
 * [beilu-st-host · 前端宿主层] st-context.mjs —— SillyTavern.getContext() 145 键骨架（一期）
 *
 * ═══ 这是什么 ═══
 * 复刻酒馆 `public/scripts/st-context.js:114-307` 的 `getContext()`：向第三方酒馆插件
 * 暴露一个 145 键的上下文对象。插件通过 `SillyTavern.getContext().<键>` 拿到聊天数据 /
 * 生成函数 / 事件总线 / 设置存储等接入面。本文件是"宿主层"（globalThis.SillyTavern.getContext），
 * 由 st-globals.mjs 挂到 globalThis 后供插件 js 调用。
 *
 * ═══ 键清单来源（逐键抄录核对，不凭记忆）═══
 *  · 145 键名与出现顺序：上游一手源 `SillyTavern/public/scripts/st-context.js:114-306`
 *    （grep 精确计数 = 145 顶层键；首键 accountStorage，尾键 constants）。
 *  · 逐键签名 / 值键 vs 函数键判定：调查报告
 *      ST-P7《getContext145键逐键签名》（酒馆完整系统调查_20260806_1657）
 *      ST-P6《getContext145键签名》（酒馆插件系统调查_20260806_1800，含 10 处 JSDoc↔实现更正，冲突以"实现侧"为准）。
 *  · event_types 91→实为 104：见下方 EVENT_TYPES 段注释与 report_B。
 *
 * ═══ 实现 / stub 划分依据 ═══
 *  · 一期只实现"beilu 今天就有真实语义"的最小集，其余一律"诚实抛错 stub"。
 *  · 红线（设计_酒馆插件接口第一期.md §3.2）：未实现键 = 调用即抛含键名的明确错误，
 *    绝不返回 undefined / 空对象 / 空实现（避免半真半假语义误导插件）。
 *  · 优先级依据：转换表§三（真实插件依赖频次）—— eventSource / event_types / extension_settings /
 *    i18n(t/translate) / uuidv4 是高频刚需，先做；其余按域二期逐键升级。
 *
 * ═══ 一期实现集（只做这些，其余全 stub）═══
 *   1. eventSource                    ← import './st-events.mjs'（另分身编写，契约：export const eventSource，具 on/off/once/emit）
 *   2. eventTypes / event_types       ← 本文件 EVENT_TYPES（宿主自己的 104 键全表）
 *   3. extensionSettings + saveSettingsDebounced ← import './st-settings.mjs'（另分身编写）
 *   4. t / translate / getCurrentLocale ← 一期恒等/固定实现（首次调用 warn 一次）
 *   5. uuidv4                          ← crypto.randomUUID
 *   其余 ~136 键 → 抛错 stub（哪怕看起来简单，如 getThumbnailUrl/substituteParams，也不做，防半真语义）。
 *
 * ═══ 层级边界（务必区分，互不引用）═══
 *   本文件 = 宿主层 getContext()，145 键，服务"下载转移进来的第三方酒馆插件"。
 *   卡内脚本层 window.SillyTavern（beilu-chat 的 stCompat/runtime/stContext.mjs，约 20 属性）
 *   是另一层不同的东西，服务"角色卡内嵌脚本"。两层同名不同物，本文件不 import、不引用 stCompat 任何内容。
 *   本文件的 EVENT_TYPES(104) 与 stCompat/runtime/eventConstants.mjs 的 44 键旧表也是两回事，互不引用。
 *
 * @see 内部调查报告 `report_B_getContext145键.md`
 */

// ── 一期实现集依赖（外部文件，由并行分身编写；本文件只 import 引用，不创建）──
import { eventSource } from './st-events.mjs';
import { extension_settings, saveSettingsDebounced } from './st-settings.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// EVENT_TYPES —— 宿主自己的事件常量表
// 来源（逐字抄录）：上游一手源 `SillyTavern/public/scripts/events.js:3-111`
// 键数：104（grep 精确计数 = 104 键，103 个唯一字符串值）。
//   注意：调查报告 ST-P7《91事件参数形状》自称 91，实为该报告 count 口径错误——
//   一手 events.js 实际是 104 个常量键。本表以一手源为准，逐字写全 104 键，保证与酒馆逐字一致。
// 唯一同值别名对：SMOOTH_STREAM_TOKEN_RECEIVED 与 STREAM_TOKEN_RECEIVED 值都是 'stream_token_received'
//   （events.js:72-74，前者 @deprecated 别名，emit 一次两个键的监听器都触发，不是两个独立事件）。
// 命名不一致点（酒馆原样保留，勿"修正"）：CHAT_CHANGED='chat_id_changed'、CHAT_LOADED='chatLoaded'、
//   GENERATION_AFTER_COMMANDS='GENERATION_AFTER_COMMANDS'（全大写）、CHARACTER_DELETED='characterDeleted'、
//   CHARACTER_MANAGEMENT_DROPDOWN='charManagementDropdown'（驼峰）。
// 与 stCompat/runtime/eventConstants.mjs 的 44 键旧表无关，互不引用。
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_TYPES = {
	APP_INITIALIZED: 'app_initialized',
	APP_READY: 'app_ready',
	EXTRAS_CONNECTED: 'extras_connected',
	MESSAGE_SWIPED: 'message_swiped',
	MESSAGE_SENT: 'message_sent',
	MESSAGE_RECEIVED: 'message_received',
	MESSAGE_EDITED: 'message_edited',
	MESSAGE_DELETED: 'message_deleted',
	MESSAGE_UPDATED: 'message_updated',
	MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
	MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
	MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
	MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
	MORE_MESSAGES_LOADED: 'more_messages_loaded',
	IMPERSONATE_READY: 'impersonate_ready',
	CHAT_CHANGED: 'chat_id_changed',
	CHAT_LOADED: 'chatLoaded',
	GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
	GENERATION_STARTED: 'generation_started',
	GENERATION_STOPPED: 'generation_stopped',
	GENERATION_ENDED: 'generation_ended',
	SD_PROMPT_PROCESSING: 'sd_prompt_processing',
	EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
	EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
	SETTINGS_LOADED: 'settings_loaded',
	SETTINGS_UPDATED: 'settings_updated',
	GROUP_UPDATED: 'group_updated',
	MOVABLE_PANELS_RESET: 'movable_panels_reset',
	SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
	SETTINGS_LOADED_AFTER: 'settings_loaded_after',
	CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
	CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
	OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
	OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
	OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
	OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
	WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
	WORLDINFO_UPDATED: 'worldinfo_updated',
	CHARACTER_EDITOR_OPENED: 'character_editor_opened',
	CHARACTER_EDITED: 'character_edited',
	CHARACTER_PAGE_LOADED: 'character_page_loaded',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE: 'character_group_overlay_state_change_before',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after',
	USER_MESSAGE_RENDERED: 'user_message_rendered',
	CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
	FORCE_SET_BACKGROUND: 'force_set_background',
	CHAT_DELETED: 'chat_deleted',
	CHAT_CREATED: 'chat_created',
	CHAT_RENAMED: 'chat_renamed',
	GROUP_CHAT_DELETED: 'group_chat_deleted',
	GROUP_CHAT_CREATED: 'group_chat_created',
	GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
	GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
	GENERATE_AFTER_DATA: 'generate_after_data',
	GROUP_MEMBER_DRAFTED: 'group_member_drafted',
	GROUP_WRAPPER_STARTED: 'group_wrapper_started',
	GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
	WORLD_INFO_ACTIVATED: 'world_info_activated',
	TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
	CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
	CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
	CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
	CHARACTER_DELETED: 'characterDeleted',
	CHARACTER_DUPLICATED: 'character_duplicated',
	CHARACTER_RENAMED: 'character_renamed',
	CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
	// @deprecated 别名，与 STREAM_TOKEN_RECEIVED 同值 'stream_token_received'
	SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
	STREAM_TOKEN_RECEIVED: 'stream_token_received',
	STREAM_REASONING_DONE: 'stream_reasoning_done',
	FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
	WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
	OPEN_CHARACTER_LIBRARY: 'open_character_library',
	ONLINE_STATUS_CHANGED: 'online_status_changed',
	IMAGE_SWIPED: 'image_swiped',
	CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
	CONNECTION_PROFILE_CREATED: 'connection_profile_created',
	CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
	CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
	TOOL_CALLS_PERFORMED: 'tool_calls_performed',
	TOOL_CALLS_RENDERED: 'tool_calls_rendered',
	CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
	SECRET_WRITTEN: 'secret_written',
	SECRET_DELETED: 'secret_deleted',
	SECRET_ROTATED: 'secret_rotated',
	SECRET_EDITED: 'secret_edited',
	PRESET_CHANGED: 'preset_changed',
	PRESET_DELETED: 'preset_deleted',
	PRESET_RENAMED: 'preset_renamed',
	PRESET_RENAMED_BEFORE: 'preset_renamed_before',
	MAIN_API_CHANGED: 'main_api_changed',
	WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
	WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
	MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
	PERSONA_CHANGED: 'persona_changed',
	PERSONA_CREATED: 'persona_created',
	PERSONA_UPDATED: 'persona_updated',
	PERSONA_RENAMED: 'persona_renamed',
	PERSONA_DELETED: 'persona_deleted',
	TTS_JOB_STARTED: 'tts_job_started',
	TTS_AUDIO_READY: 'tts_audio_ready',
	TTS_JOB_COMPLETE: 'tts_job_complete',
	ITEMIZED_PROMPTS_LOADED: 'itemized_prompts_loaded',
	ITEMIZED_PROMPTS_SAVED: 'itemized_prompts_saved',
	ITEMIZED_PROMPTS_DELETED: 'itemized_prompts_deleted',
};

// ─────────────────────────────────────────────────────────────────────────────
// stub 工具：诚实抛错（红线 §3.2 —— 未实现键调用即抛含键名的明确错误）
// ─────────────────────────────────────────────────────────────────────────────

/** 未实现的错误消息（统一格式，必含真实键名/路径，便于二期定位升级） */
function unimplementedError(displayName) {
	return new Error(`[beilu宿主] getContext().${displayName} 尚未实现`);
}

/** 函数键 stub：调用即抛。displayName 用完整路径（如 'swipe.left'）。 */
function stubFn(displayName) {
	return () => { throw unimplementedError(displayName); };
}

/** 值键 stub：以 getter 定义，"访问即抛"（存在性/枚举检查不触发，符合"绝不 undefined"红线）。 */
function defineThrowingValue(obj, key, displayName = key) {
	Object.defineProperty(obj, key, {
		enumerable: true,
		configurable: true,
		get() { throw unimplementedError(displayName); },
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 一期实现：i18n 恒等层（t / translate / getCurrentLocale）
// ST 侧签名：ST-P7 报告"四、i18n 域" —— t(i18n.js:81 模板标签)/translate(i18n.js:101)/getCurrentLocale(i18n.js:15)。
// 一期语义：恒等返回原文、locale 固定 'zh-cn'；首次任一调用 warn 一次，提示 i18n 尚未真正接入。
// ─────────────────────────────────────────────────────────────────────────────
let _i18nWarned = false;
function warnI18nOnce() {
	if (!_i18nWarned) {
		_i18nWarned = true;
		console.warn('[beilu宿主] i18n 一期未接：t/translate 恒等返回原文，getCurrentLocale 固定返回 zh-cn');
	}
}

/** t：模板字符串标签函数（`t`Hello ${x}``），一期还原拼接原文；容错非模板用法直接返回原值。 */
function hostT(strings, ...values) {
	warnI18nOnce();
	if (Array.isArray(strings)) {
		return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');
	}
	return String(strings);
}

/** translate(text, key?)：一期恒等返回原文。 */
function hostTranslate(text, _key = null) {
	warnI18nOnce();
	return text;
}

/** getCurrentLocale()：一期固定返回 'zh-cn'。 */
function hostGetCurrentLocale() {
	warnI18nOnce();
	return 'zh-cn';
}

/** uuidv4()：一期用 crypto.randomUUID（前端全局 crypto，语义与 ST utils.js:1961 优先分支一致）。 */
function hostUuidv4() {
	return crypto.randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// getContext() 单例上下文对象
// 键顺序严格照 st-context.js:115-306（145 顶层键）。每个键标注：[实现]/[值键stub]/[函数键stub]。
// ─────────────────────────────────────────────────────────────────────────────
let _context = null;

function buildContext() {
	const ctx = {};

	// ═══ 域一：聊天数据 / 角色卡 / 会话状态（ST-P7 §一「聊天数据域」，定义处 script.js/group-chats.js）═══
	defineThrowingValue(ctx, 'accountStorage');   // 值键：AccountStorage 单例（util/AccountStorage.js:145）
	defineThrowingValue(ctx, 'chat');             // 值键：聊天消息活引用数组（script.js:410）
	defineThrowingValue(ctx, 'characters');       // 值键：全角色卡数组（script.js:426）
	defineThrowingValue(ctx, 'groups');           // 值键：群组数组（group-chats.js:114）
	defineThrowingValue(ctx, 'name1');            // 值键：用户名（script.js:407）
	defineThrowingValue(ctx, 'name2');            // 值键：角色名（script.js:408）
	defineThrowingValue(ctx, 'characterId');      // 值键：当前角色下标 this_chid（script.js:431）
	defineThrowingValue(ctx, 'groupId');          // 值键：当前群组 selected_group（group-chats.js:116）
	defineThrowingValue(ctx, 'chatId');           // 值键：当前聊天 id 计算值（st-context.js:124-126）
	ctx.getCurrentChatId = stubFn('getCurrentChatId');       // 函数：script.js:540
	ctx.getRequestHeaders = stubFn('getRequestHeaders');     // 函数：script.js:645
	ctx.reloadCurrentChat = stubFn('reloadCurrentChat');     // 函数：script.js:1676（SimpleMutex 包装）
	ctx.renameChat = stubFn('renameChat');                   // 函数：script.js:10671
	ctx.saveSettingsDebounced = saveSettingsDebounced;       // [实现] ← st-settings.mjs（防抖持久化设置）
	defineThrowingValue(ctx, 'onlineStatus');     // 值键：online_status（script.js:600）
	defineThrowingValue(ctx, 'maxContext');       // 值键：Number(max_context)（st-context.js:133）
	defineThrowingValue(ctx, 'chatMetadata');     // 值键：chat_metadata（script.js:453）
	ctx.saveMetadataDebounced = stubFn('saveMetadataDebounced'); // 函数：extensions.js:89
	defineThrowingValue(ctx, 'streamingProcessor'); // 值键：StreamingProcessor 实例|null（script.js:455）

	// ═══ 域二：事件总线（ST-P7 §六 + 91事件表；一期核心实现）═══
	ctx.eventSource = eventSource;   // [实现] ← st-events.mjs（on/off/once/emit）；ST 真源 events.js:113
	ctx.eventTypes = EVENT_TYPES;    // [实现] 本文件 104 键全表；ST 真源 events.js:3-111

	// ═══ 域三：消息渲染 / 增删（ST-P7 §一）═══
	ctx.addOneMessage = stubFn('addOneMessage');         // 函数：script.js:2492（只渲染不写 chat 数组）
	ctx.deleteLastMessage = stubFn('deleteLastMessage'); // 函数：script.js:1605
	ctx.deleteMessage = stubFn('deleteMessage');         // 函数：script.js:1618

	// ═══ 域四：生成域（ST-P7 §二「生成域」，重中之重，定义处 script.js）═══
	ctx.generate = stubFn('generate');                       // 函数：Generate（script.js:4231）
	ctx.sendStreamingRequest = stubFn('sendStreamingRequest'); // 函数：script.js:6088
	ctx.sendGenerationRequest = stubFn('sendGenerationRequest'); // 函数：script.js:6057
	ctx.stopGeneration = stubFn('stopGeneration');           // 函数：script.js:5548

	// ═══ 域五：token（ST-P7 §四「token 域」，定义处 tokenizers.js）═══
	defineThrowingValue(ctx, 'tokenizers');          // 值键：tokenizer 枚举对象（tokenizers.js:16）
	ctx.getTextTokens = stubFn('getTextTokens');     // 函数：tokenizers.js:1157
	ctx.getTokenCount = stubFn('getTokenCount');     // 函数（@deprecated）：tokenizers.js:499
	ctx.getTokenCountAsync = stubFn('getTokenCountAsync'); // 函数：tokenizers.js:443

	// ═══ 域六：提示词注入 / 元数据 / 存档（ST-P7 §一 + §六）═══
	defineThrowingValue(ctx, 'extensionPrompts');    // 值键：extension_prompts（script.js:625）
	// [0807 转接二期#8 二期升级·凛倾定案] setExtensionPrompt（ST 签名 script.js:8866
	// (key,value,position,depth,scan,role,filter)）→ 落 INJ 常驻可编辑条目（EXT-<key>，
	// inj-edit tab 可编辑/可删/可启禁）。只做「历史对话之前/之后」二区+order 排序，
	// scan/filter 不支持。实现单源在 beilu-chat 主页面（iframeRenderer 挂
	// window.__beiluUpsertExtensionPrompt 运行时桥）——宿主与 stCompat 互不 import 红线不破，
	// 插件 js 与主页面同 window（host-loader 直接 <script> 注入）直取桥即可。
	// 桥未挂（beilu-chat 未初始化完）→ 按红线诚实抛错，不静默吞。
	ctx.setExtensionPrompt = function (key, value, position, depth, scan, role, filter) {
		const bridge = globalThis.window?.__beiluUpsertExtensionPrompt;
		if (typeof bridge !== 'function') throw new Error('[beilu宿主] setExtensionPrompt 桥未就绪（beilu-chat iframeRenderer 未初始化）');
		return bridge(key, value, position, depth, scan, role, filter);
	};
	ctx.updateChatMetadata = stubFn('updateChatMetadata'); // 函数：script.js:8918
	ctx.saveChat = stubFn('saveChat');                     // 函数：saveChatConditional（script.js:9352）
	ctx.openCharacterChat = stubFn('openCharacterChat');   // 函数：script.js:7685
	ctx.openGroupChat = stubFn('openGroupChat');           // 函数：group-chats.js:2194
	ctx.saveMetadata = stubFn('saveMetadata');             // 函数：script.js:9348（实为 saveChatConditional 别名）
	ctx.sendSystemMessage = stubFn('sendSystemMessage');   // 函数：system-messages.js:158
	ctx.activateSendButtons = stubFn('activateSendButtons');   // 函数：script.js:7016
	ctx.deactivateSendButtons = stubFn('deactivateSendButtons'); // 函数：script.js:7026
	ctx.saveReply = stubFn('saveReply');                   // 函数：script.js:6583

	// ═══ 域七：宏替换（ST-P7 §六「宏」，定义处 script.js/macros）═══
	ctx.substituteParams = stubFn('substituteParams');             // 函数：script.js:2922
	ctx.substituteParamsExtended = stubFn('substituteParamsExtended'); // 函数（@deprecated）：script.js:2756

	// ═══ 域八：斜杠命令族（ST-P7 §六「斜杠命令」，定义处 slash-commands*）═══
	defineThrowingValue(ctx, 'SlashCommandParser');       // 值键：类
	defineThrowingValue(ctx, 'SlashCommand');             // 值键：类
	defineThrowingValue(ctx, 'SlashCommandArgument');     // 值键：类
	defineThrowingValue(ctx, 'SlashCommandNamedArgument'); // 值键：类
	defineThrowingValue(ctx, 'SlashCommandEnumValue');    // 值键：类
	defineThrowingValue(ctx, 'ARGUMENT_TYPE');            // 值键：枚举对象
	ctx.executeSlashCommandsWithOptions = stubFn('executeSlashCommandsWithOptions'); // 函数
	ctx.registerSlashCommand = stubFn('registerSlashCommand'); // 函数（@deprecated）
	ctx.executeSlashCommands = stubFn('executeSlashCommands');  // 函数（@deprecated）

	// ═══ 域九：时间 / 已废弃钩子 / 宏与工具注册（ST-P7 §四、§六）═══
	ctx.timestampToMoment = stubFn('timestampToMoment');   // 函数：utils.js:1079
	// registerHelper：ST 侧是 deprecated no-op（Handlebars 不再支持，st-context.js:177 = () => {}）。
	// [0806 主AI裁决] 照"复刻机制"原则复刻 ST 真实行为=no-op：在 ST 里调用它不炸，在我们这也不能炸
	//（抛错 stub 针对的是"ST 有真功能我们没实现"，而这里 ST 的真功能就是什么都不做）。warn 一次留观测。
	let _registerHelperWarned = false;
	ctx.registerHelper = () => {
		if (!_registerHelperWarned) {
			_registerHelperWarned = true;
			console.warn('[beilu宿主] registerHelper 在 ST 侧已废弃为 no-op，本宿主同样忽略此调用');
		}
	};
	ctx.registerMacro = stubFn('registerMacro');           // 函数（@deprecated）：MacrosParser.registerMacro
	ctx.unregisterMacro = stubFn('unregisterMacro');       // 函数（@deprecated）
	ctx.registerFunctionTool = stubFn('registerFunctionTool');     // 函数：ToolManager.registerFunctionTool
	ctx.unregisterFunctionTool = stubFn('unregisterFunctionTool'); // 函数
	ctx.isToolCallingSupported = stubFn('isToolCallingSupported'); // 函数：tool-calling.js:608
	ctx.canPerformToolCalls = stubFn('canPerformToolCalls');       // 函数：tool-calling.js:682
	defineThrowingValue(ctx, 'ToolManager');         // 值键：静态方法门面类
	ctx.registerDebugFunction = stubFn('registerDebugFunction');   // 函数：power-user.js:1466

	// ═══ 域十：扩展模板 / 数据库抓取（ST-P7 §四「misc」，定义处 extensions.js/scrapers.js）═══
	ctx.renderExtensionTemplate = stubFn('renderExtensionTemplate');       // 函数（@deprecated）：extensions.js:125
	ctx.renderExtensionTemplateAsync = stubFn('renderExtensionTemplateAsync'); // 函数：extensions.js:137
	ctx.registerDataBankScraper = stubFn('registerDataBankScraper');       // 函数：scrapers.js:40

	// ═══ 域十一：弹窗族（ST-P7 §一「Popup 族」，定义处 popup.js/script.js）═══
	ctx.callPopup = stubFn('callPopup');             // 函数（@deprecated）：script.js:9007
	ctx.callGenericPopup = stubFn('callGenericPopup'); // 函数：popup.js:909

	// ═══ 域十二：加载器（ST-P7 §四「misc」，定义处 loader.js/action-loader.js）═══
	ctx.showLoader = stubFn('showLoader');           // 函数（@deprecated）：loader.js:23
	ctx.hideLoader = stubFn('hideLoader');           // 函数（@deprecated）：loader.js:52

	// ═══ 域十三：设置 / API 引用（ST-P7 §五「设置域」；extensionSettings 一期实现）═══
	defineThrowingValue(ctx, 'mainApi');             // 值键：main_api（script.js:627）
	ctx.extensionSettings = extension_settings;      // [实现] ← st-settings.mjs（各扩展私有设置命名空间根）
	defineThrowingValue(ctx, 'ModuleWorkerWrapper'); // 值键：类（实为 SimpleMutex 重导出，util/SimpleMutex.js:4）
	ctx.getTokenizerModel = stubFn('getTokenizerModel'); // 函数：tokenizers.js:569

	// ═══ 域十四：静默生成 / 原始生成（ST-P7 §二）═══
	ctx.generateQuietPrompt = stubFn('generateQuietPrompt'); // 函数：script.js:3025
	ctx.generateRaw = stubFn('generateRaw');                 // 函数：script.js:4063
	ctx.generateRawData = stubFn('generateRawData');         // 函数：script.js:3941

	// ═══ 域十五：角色扩展字段 / 缩略图 / 角色操作（ST-P7 §一 + 待决3）═══
	ctx.writeExtensionField = stubFn('writeExtensionField');       // 函数：extensions.js:2061
	ctx.writeExtensionFieldBulk = stubFn('writeExtensionFieldBulk'); // 函数：extensions.js:2143
	ctx.getThumbnailUrl = stubFn('getThumbnailUrl');       // 函数：script.js:7489（纯 URL 拼接，但一期仍 stub）
	ctx.selectCharacterById = stubFn('selectCharacterById'); // 函数：script.js:873
	ctx.messageFormatting = stubFn('messageFormatting');   // 函数：script.js:1753

	// ═══ 域十六：环境判定（ST-P7 §四「misc」，定义处 RossAscends-mods.js）═══
	ctx.shouldSendOnEnter = stubFn('shouldSendOnEnter');   // 函数：RossAscends-mods.js:149
	ctx.isMobile = stubFn('isMobile');                     // 函数：RossAscends-mods.js:143

	// ═══ 域十七：i18n（ST-P7 §四「i18n 域」；t/translate/getCurrentLocale 一期实现，addLocaleData stub）═══
	ctx.t = hostT;                             // [实现] 恒等模板标签（i18n.js:81 对应）
	ctx.translate = hostTranslate;            // [实现] 恒等返回原文（i18n.js:101 对应）
	ctx.getCurrentLocale = hostGetCurrentLocale; // [实现] 固定 'zh-cn'（i18n.js:15 对应）
	ctx.addLocaleData = stubFn('addLocaleData'); // 函数：i18n.js:22（追加式合并，一期未实现）

	// ═══ 域十八：标签 / 菜单 / 角色草稿数据（ST-P7 §一）═══
	defineThrowingValue(ctx, 'tags');                // 值键：标签数组（tags.js）
	defineThrowingValue(ctx, 'tagMap');              // 值键：tag_map 角色-标签映射（tags.js）
	defineThrowingValue(ctx, 'menuType');            // 值键：menu_type（script.js:564）
	defineThrowingValue(ctx, 'createCharacterData'); // 值键：create_save（script.js:569）

	// event_types（snake_case @deprecated 别名，st-context.js:222）—— 与 eventTypes 同一引用 [实现]
	ctx.event_types = EVENT_TYPES;

	// ═══ 域十九：弹窗枚举（ST-P7 §一「Popup 族」，定义处 popup.js）═══
	defineThrowingValue(ctx, 'Popup');               // 值键：类
	defineThrowingValue(ctx, 'POPUP_TYPE');          // 值键：枚举对象
	defineThrowingValue(ctx, 'POPUP_RESULT');        // 值键：枚举对象

	// ═══ 域二十：三大 API 设置引用（ST-P7 §五）═══
	defineThrowingValue(ctx, 'chatCompletionSettings'); // 值键：oai_settings（openai.js:511）
	defineThrowingValue(ctx, 'textCompletionSettings'); // 值键：textgenerationwebui_settings
	defineThrowingValue(ctx, 'powerUserSettings');      // 值键：power_user（power-user.js:116）

	// ═══ 域二十一：角色加载 / 卡片字段 / 来源（ST-P7 §一）═══
	ctx.getCharacters = stubFn('getCharacters');             // 函数：script.js:1292
	ctx.getOneCharacter = stubFn('getOneCharacter');         // 函数：script.js:1221
	ctx.getCharacterCardFields = stubFn('getCharacterCardFields'); // 函数：script.js:3417
	ctx.getCharacterSource = stubFn('getCharacterSource');   // 函数：script.js:1245
	ctx.importFromExternalUrl = stubFn('importFromExternalUrl'); // 函数：utils.js:2977
	ctx.importTags = stubFn('importTags');                   // 函数：tags.js:970

	// ═══ 域二十二：工具函数 uuid/时间（ST-P7 §四；uuidv4 一期实现，humanizedDateTime stub）═══
	ctx.uuidv4 = hostUuidv4;                                 // [实现] crypto.randomUUID（utils.js:1961 对应）
	ctx.humanizedDateTime = stubFn('humanizedDateTime');     // 函数：RossAscends-mods.js:169

	// ═══ 域二十三：消息 DOM / 媒体 / 滚动（ST-P7 §四「UI 域」，定义处 script.js）═══
	ctx.updateMessageBlock = stubFn('updateMessageBlock');     // 函数：script.js:1974
	ctx.appendMediaToMessage = stubFn('appendMediaToMessage'); // 函数：script.js:2157
	ctx.ensureMessageMediaIsArray = stubFn('ensureMessageMediaIsArray'); // 函数：script.js:1991
	ctx.getMediaDisplay = stubFn('getMediaDisplay');           // 函数：script.js:2130
	ctx.getMediaIndex = stubFn('getMediaIndex');               // 函数：script.js:2140
	ctx.scrollChatToBottom = stubFn('scrollChatToBottom');     // 函数：script.js:2714
	ctx.scrollOnMediaLoad = stubFn('scrollOnMediaLoad');       // 函数：script.js:1532

	// ═══ 域二十四：宏系统对象 / 加载器对象（ST-P6 §C3 macros；action-loader.js loader）═══
	defineThrowingValue(ctx, 'macros');  // 值键：复合对象 {engine,registry,...}（macro-system.js:44）
	defineThrowingValue(ctx, 'loader');  // 值键：加载器门面对象（action-loader.js:328）

	// ═══ 子命名空间 swipe（ST-P7 §三「swipe 域」，8 成员全函数，定义处 script.js）═══
	// 子对象本身存在，成员逐个抛错（错误消息含完整路径 swipe.<成员>）。
	ctx.swipe = {
		left: stubFn('swipe.left'),           // swipe_left（@deprecated，script.js:10377）
		right: stubFn('swipe.right'),         // swipe_right（@deprecated，script.js:10391）
		to: stubFn('swipe.to'),               // swipe（script.js:9894）
		show: stubFn('swipe.show'),           // showSwipeButtons（script.js:9253）
		hide: stubFn('swipe.hide'),           // hideSwipeButtons（script.js:9263）
		refresh: stubFn('swipe.refresh'),     // refreshSwipeButtons（script.js:9190）
		isAllowed: stubFn('swipe.isAllowed'), // isSwipingAllowed（script.js:9102）
		state: stubFn('swipe.state'),         // () => swipeState（st-context.js:254）
	};

	// ═══ 子命名空间 variables（ST-P7 §三「变量域」，local/global 各 7 成员全函数，定义处 variables.js）═══
	ctx.variables = {
		local: {
			get: stubFn('variables.local.get'),   // getLocalVariable（variables.js:22）
			set: stubFn('variables.local.set'),   // setLocalVariable（variables.js:48）
			del: stubFn('variables.local.del'),   // deleteLocalVariable（variables.js:592）
			add: stubFn('variables.local.add'),   // addLocalVariable（variables.js:136）
			inc: stubFn('variables.local.inc'),   // incrementLocalVariable（variables.js:196）
			dec: stubFn('variables.local.dec'),   // decrementLocalVariable（variables.js:204）
			has: stubFn('variables.local.has'),   // existsLocalVariable（variables.js:422）
		},
		global: {
			get: stubFn('variables.global.get'),  // getGlobalVariable（variables.js:83）
			set: stubFn('variables.global.set'),  // setGlobalVariable（variables.js:105）
			del: stubFn('variables.global.del'),  // deleteGlobalVariable（variables.js:608）
			add: stubFn('variables.global.add'),  // addGlobalVariable（variables.js:166）
			inc: stubFn('variables.global.inc'),  // incrementGlobalVariable（variables.js:200）
			dec: stubFn('variables.global.dec'),  // decrementGlobalVariable（variables.js:208）
			has: stubFn('variables.global.has'),  // existsGlobalVariable（variables.js:431）
		},
	};

	// ═══ 域二十五：世界书（ST-P7 §三「世界书域」，定义处 world-info.js）═══
	ctx.loadWorldInfo = stubFn('loadWorldInfo');             // 函数：world-info.js:2036
	ctx.saveWorldInfo = stubFn('saveWorldInfo');             // 函数：world-info.js:4097
	ctx.reloadWorldInfoEditor = stubFn('reloadWorldInfoEditor'); // 函数：reloadEditor（world-info.js:1040）
	ctx.updateWorldInfoList = stubFn('updateWorldInfoList'); // 函数：world-info.js:2061
	ctx.convertCharacterBook = stubFn('convertCharacterBook'); // 函数：world-info.js:5498
	ctx.getWorldInfoPrompt = stubFn('getWorldInfoPrompt');   // 函数：world-info.js:892
	ctx.getWorldInfoNames = stubFn('getWorldInfoNames');     // 函数：st-context.js:282（内联箭头）

	// ═══ 域二十六：连接 API 映射 / 生成服务（ST-P7 §二）═══
	defineThrowingValue(ctx, 'CONNECT_API_MAP');     // 值键：运行时填充对象（slash-commands.js:141）
	ctx.getTextGenServer = stubFn('getTextGenServer');       // 函数：textgen-settings.js:351
	ctx.extractMessageFromData = stubFn('extractMessageFromData'); // 函数：script.js:6217
	ctx.getPresetManager = stubFn('getPresetManager');       // 函数：preset-manager.js:83
	ctx.getChatCompletionModel = stubFn('getChatCompletionModel'); // 函数：openai.js:1698
	ctx.printMessages = stubFn('printMessages');             // 函数：script.js:1475
	ctx.clearChat = stubFn('clearChat');                     // 函数：script.js:1584

	// ═══ 域二十七：请求服务类（ST-P7 §二「请求服务类」，定义处 custom-request.js/shared.js）═══
	defineThrowingValue(ctx, 'ChatCompletionService');           // 值键：静态类（custom-request.js:421）
	defineThrowingValue(ctx, 'TextCompletionService');           // 值键：静态类（custom-request.js:79）
	defineThrowingValue(ctx, 'ConnectionManagerRequestService'); // 值键：静态类（extensions/shared.js:388）

	// ═══ 域二十八：推理（reasoning）（ST-P7 §四，定义处 reasoning.js）═══
	ctx.updateReasoningUI = stubFn('updateReasoningUI');         // 函数：reasoning.js:234
	ctx.parseReasoningFromString = stubFn('parseReasoningFromString'); // 函数：reasoning.js:1421
	ctx.getReasoningTemplateByName = stubFn('getReasoningTemplateByName'); // 函数：reasoning.js:1404

	// ═══ 域二十九：影子角色补全 / 扩展 manifest / 第三方扩展菜单（ST-P7 §一、§四）═══
	ctx.unshallowCharacter = stubFn('unshallowCharacter');       // 函数：script.js:7548
	ctx.unshallowGroupMembers = stubFn('unshallowGroupMembers'); // 函数：group-chats.js:1378
	ctx.getExtensionManifest = stubFn('getExtensionManifest');   // 函数：extensions.js:524
	ctx.openThirdPartyExtensionMenu = stubFn('openThirdPartyExtensionMenu'); // 函数：extensions.js:2223

	// ═══ 子命名空间 symbols（ST-P6 §C3，值成员，定义处 constants.js）═══
	// 子对象存在，成员 ignore 是 Symbol 值 → getter 访问即抛。
	ctx.symbols = {};
	defineThrowingValue(ctx.symbols, 'ignore', 'symbols.ignore'); // IGNORE_SYMBOL（constants.js:25）

	// ═══ 子命名空间 constants（ST-P6 §C1，值成员，定义处 extensions.js）═══
	// 子对象存在，成员 unset 是字符串常量 → getter 访问即抛。
	ctx.constants = {};
	defineThrowingValue(ctx.constants, 'unset', 'constants.unset'); // UNSET_VALUE（extensions.js:2052）

	return ctx;
}

/**
 * getContext()：返回单例上下文对象（145 键全在）。
 * 复刻 SillyTavern.getContext()。首次调用构造并缓存，后续返回同一实例
 * （值键为 getter，函数键为闭包，均无状态，单例缓存安全）。
 */
export function getContext() {
	if (_context === null) {
		_context = buildContext();
	}
	return _context;
}

export default getContext;

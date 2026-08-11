/**
 * 事件类型常量
 *
 * 定义 iframe_events（6 个）和 tavern_events（ST 完整子集）
 * 从 polyfills.mjs generateEventConstantsScript 拆出
 * 2026-08-07 对齐上游 JS-Slash-Runner event.ts 82 键（逐字）
 * 上游: SillyTavern/.../JS-Slash-Runner/src/function/event.ts:181-264
 * 怪值是上游原样: CHARACTER_DELETED='characterDeleted', GENERATION_AFTER_COMMANDS='GENERATION_AFTER_COMMANDS',
 *   CHARACTER_MANAGEMENT_DROPDOWN='charManagementDropdown', SMOOTH_STREAM_TOKEN_RECEIVED 与 STREAM_TOKEN_RECEIVED 同值='stream_token_received'
 */

export function generateEventConstantsScript() {
	return `
/* === ST Compat: Event Constants === */
window.iframe_events = {
	MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
	MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
	GENERATION_STARTED: 'js_generation_started',
	STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
	STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
	GENERATION_ENDED: 'js_generation_ended'
};

window.tavern_events = {
	APP_READY: 'app_ready',
	MESSAGE_SWIPED: 'message_swiped',
	MESSAGE_SENT: 'message_sent',
	MESSAGE_RECEIVED: 'message_received',
	MESSAGE_EDITED: 'message_edited',
	MESSAGE_DELETED: 'message_deleted',
	MESSAGE_UPDATED: 'message_updated',
	CHAT_CHANGED: 'chat_id_changed',
	GENERATION_STARTED: 'generation_started',
	GENERATION_STOPPED: 'generation_stopped',
	GENERATION_ENDED: 'generation_ended',
	CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
	USER_MESSAGE_RENDERED: 'user_message_rendered',
	WORLDINFO_UPDATED: 'worldinfo_updated',
	GENERATE_AFTER_DATA: 'generate_after_data',
	CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
	CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
	OAI_BEFORE_CHATCOMPLETION: 'oai_before_chatcompletion',
	IMPERSONATE_READY: 'impersonate_ready',
	GROUP_MEMBER_DRAFTED: 'group_member_drafted',
	WORLD_INFO_ACTIVATED: 'world_info_activated',
	TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
	LLM_FUNCTION_TOOL_REGISTER: 'llm_function_tool_register',
	FORCE_SET_BACKGROUND: 'force_set_background',
	CHAT_DELETED: 'chat_deleted',
	GROUP_CHAT_DELETED: 'group_chat_deleted',
	GROUP_CHAT_CREATED: 'group_chat_created',
	CHAT_CREATED: 'chat_created',
	CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
	CHARACTER_DELETED: 'characterDeleted', // 上游原样：驼峰值非 snake_case
	CHARACTER_DUPLICATED: 'character_duplicated',
	CHARACTER_PAGE_LOADED: 'character_page_loaded',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE: 'character_group_overlay_state_change_before',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after',
	SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received', // 上游原样：与 STREAM_TOKEN_RECEIVED 同值（别名对）
	FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
	WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
	OPEN_CHARACTER_LIBRARY: 'open_character_library',
	ONLINE_STATUS_CHANGED: 'online_status_changed',
	IMAGE_SWIPED: 'image_swiped',
	CHAT_MANAGER_OPENED: 'chat_manager_opened',
	GLOBAL_CONTEXT_MENU: 'global_context_menu',
	TOOL_CALLS_PERFORMED: 'tool_calls_performed',
	TOOL_CALLS_RENDERED: 'tool_calls_rendered',

	/* ── 2026-08-07 补齐上游 82 键中缺失的 47 键 ── */
	EXTRAS_CONNECTED: 'extras_connected',
	MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
	MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
	MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
	MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
	MORE_MESSAGES_LOADED: 'more_messages_loaded',
	GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', // 上游原样：值全大写非 snake_case
	SD_PROMPT_PROCESSING: 'sd_prompt_processing',
	EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
	EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
	SETTINGS_LOADED: 'settings_loaded',
	SETTINGS_UPDATED: 'settings_updated',
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
	CHARACTER_EDITOR_OPENED: 'character_editor_opened',
	CHARACTER_EDITED: 'character_edited',
	GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
	GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
	CHARACTER_RENAMED: 'character_renamed',
	CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
	STREAM_TOKEN_RECEIVED: 'stream_token_received', // 上游原样：与 SMOOTH_STREAM_TOKEN_RECEIVED 同值（别名对）
	STREAM_REASONING_DONE: 'stream_reasoning_done',
	CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
	CONNECTION_PROFILE_CREATED: 'connection_profile_created',
	CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
	CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
	CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown', // 上游原样：驼峰值非 snake_case
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

	/* ── beilu 专属事件常量（设计 渲染方案_设计.md §4.5）──
	 * 这些是 beilu 框架规划的事件契约。常量先就位（让美化代码能写 eventOn(tavern_events.EMOTION_CHANGED, ...)
	 * 而不报 undefined），但父页面是否广播取决于后端是否落地对应检测：
	 *   EMOTION_CHANGED  — 父页面检测到 [情感] 标签时广播 { emotion, message_id }
	 *                       后端情感检测落地后调 window.emitEmotionChanged() 触发（见 websocket.mjs 生产者）
	 *   MODE_CHANGED     — 切换模式时广播 { mode }（当前无 producer）
	 *   CHARACTER_CHANGED— 切换角色时广播 { charName }（N49 producer=loadCharInfo）
	 *   VARIABLE_UPDATED — MVU 变量写入时广播 { index, variables }（N49 producer=_syncMvuVariablesToStore）
	 * N49 起 CHAT/MODE/CHARACTER/VARIABLE 四 producer 已接通（见各 emit 收口）；emotion 渲染端捕获待接。 */
	EMOTION_CHANGED: 'emotion_changed',
	MODE_CHANGED: 'mode_changed',
	CHARACTER_CHANGED: 'character_changed',
	VARIABLE_UPDATED: 'variable_updated'
};
`
}
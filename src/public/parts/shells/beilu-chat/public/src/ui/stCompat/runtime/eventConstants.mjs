/**
 * 事件类型常量
 *
 * 定义 iframe_events（6 个）和 tavern_events（ST 完整子集）
 * 从 polyfills.mjs generateEventConstantsScript 拆出
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
	CHARACTER_DELETED: 'character_deleted',
	CHARACTER_DUPLICATED: 'character_duplicated',
	CHARACTER_PAGE_LOADED: 'character_page_loaded',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE: 'character_group_overlay_state_change_before',
	CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after',
	SMOOTH_STREAM_TOKEN_RECEIVED: 'smooth_stream_token_received',
	FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
	WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
	OPEN_CHARACTER_LIBRARY: 'open_character_library',
	ONLINE_STATUS_CHANGED: 'online_status_changed',
	IMAGE_SWIPED: 'image_swiped',
	CHAT_MANAGER_OPENED: 'chat_manager_opened',
	GLOBAL_CONTEXT_MENU: 'global_context_menu',
	TOOL_CALLS_PERFORMED: 'tool_calls_performed',
	TOOL_CALLS_RENDERED: 'tool_calls_rendered'
};
`
}
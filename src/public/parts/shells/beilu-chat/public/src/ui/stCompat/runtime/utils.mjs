/**
 * 工具函数 shim
 *
 * 实现 errorCatched / getLastMessageId / getMessageId /
 * substitudeMacros / getIframeName / getScriptId / reloadIframe
 * 从 polyfills.mjs generateUtilsScript 拆出
 */

export function generateUtilsScript() {
	return `
/* === ST Compat: Utility Functions === */
window.errorCatched = function(fn) {
	return function() {
		try { return fn.apply(this, arguments); }
		catch(e) { console.error('[errorCatched]', e); }
	};
};

window.getLastMessageId = function() {
	try {
		var chat = window.SillyTavern && window.SillyTavern.chat;
		if (chat && chat.length > 0) return chat.length - 1;
	} catch(e) {}
	return 0;
};

window.getMessageId = function(el) {
	/* Not applicable in beilu context, return 0 */
	return 0;
};

window.substitudeMacros = function(str) {
	/* Macro substitution — 酒馆宏替换 */
	if (!str) return str;
	try {
		var st = window.SillyTavern || {};
		str = str.replace(/{{user}}/gi, st.name1 || 'User');
		str = str.replace(/{{char}}/gi, st.name2 || 'Character');
		/* {{avatar}} — 角色卡头像 URL（beilu 通过 parts 系统提供） */
		var avatarUrl = st._avatarUrl || '';
		str = str.replace(/{{avatar}}/gi, avatarUrl);
		/* {{input}} — 用户最近输入 */
		str = str.replace(/{{input}}/gi, '');
		/* {{lastMessage}} — 最后一条消息 */
		var lastMsg = '';
		if (st.chat && st.chat.length > 0) {
			var last = st.chat[st.chat.length - 1];
			lastMsg = (last.mes || last.message || '').substring(0, 500);
		}
		str = str.replace(/{{lastMessage}}/gi, lastMsg);
		/* {{lastMessageId}} — 最后消息 ID */
		str = str.replace(/{{lastMessageId}}/gi, st.chat ? String(st.chat.length - 1) : '0');
	} catch(e) {}
	return str;
};

window.getIframeName = function() {
	try { return window.frameElement ? (window.frameElement.id || 'beilu-iframe') : 'beilu-iframe'; }
	catch(e) { return 'beilu-iframe'; }
};

window.getScriptId = function() {
	return 'beilu-script-' + Date.now();
};

window.reloadIframe = function() {
	try { window.location.reload(); } catch(e) {}
};
`
}
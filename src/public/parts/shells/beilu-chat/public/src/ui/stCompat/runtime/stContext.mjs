/**
 * SillyTavern 对象增强
 *
 * 在 earlyScript 已注入的基础 SillyTavern 对象上添加更多属性
 * 从 polyfills.mjs generateSTContextEnhancementScript 拆出
 */

/**
 * 转义 JavaScript 字符串中的特殊字符
 * @param {string} str
 * @returns {string}
 */
function escapeJsString(str) {
	return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/**
 * @param {object} [options]
 * @param {string} [options.userName='User'] - 用户名
 * @param {string} [options.charName='Character'] - 角色名
 * @param {number} [options.messageId=0] - 当前消息 ID
 * @returns {string} JavaScript 代码
 */
export function generateSTContextEnhancementScript(options = {}) {
	const userName = escapeJsString(options.userName || 'User')
	const charName = escapeJsString(options.charName || 'Character')
	const messageId = options.messageId || 0

	return `
/* === ST Compat: SillyTavern Object Enhancement === */
(function() {
	var st = window.SillyTavern || {};

	/* Basic properties */
	if (!st.name1) st.name1 = '${userName}';
	if (!st.name2) st.name2 = '${charName}';
	if (!st.characterId) st.characterId = '';
	if (!st.chatId) st.chatId = '';
	if (!st.maxContext) st.maxContext = 8192;
	if (!st.chatMetadata) st.chatMetadata = {};
	if (!st.characters) st.characters = [];
	if (!st.extensionPrompts) st.extensionPrompts = {};

	/* Functions */
	if (!st.getCurrentChatId) st.getCurrentChatId = function() { return st.chatId || ''; };
	if (!st.stopGeneration) st.stopGeneration = function() { return false; };
	if (!st.saveChat) st.saveChat = function() { return Promise.resolve(); };
	if (!st.reloadCurrentChat) st.reloadCurrentChat = function() { return Promise.resolve(); };
	if (!st.saveSettingsDebounced) st.saveSettingsDebounced = function() { /* no-op in beilu */ };
	if (!st.saveSettings) st.saveSettings = function() { return Promise.resolve(); };

	/* setExtensionPrompt — store locally, no backend effect in Phase 1 */
	if (!st.setExtensionPrompt) {
		st.setExtensionPrompt = function(id, content, position, depth, scan, role, filter) {
			st.extensionPrompts[id] = { content: content, position: position, depth: depth, role: role };
			return Promise.resolve();
		};
	}

	/* Popup stubs */
	if (!st.POPUP_TYPE) st.POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
	if (!st.POPUP_RESULT) st.POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
	if (!st.callGenericPopup) {
		st.callGenericPopup = function(content, type) {
			if (type === 2) return Promise.resolve(confirm(content) ? 1 : 0);
			if (type === 3) return Promise.resolve(prompt(content));
			alert(content);
			return Promise.resolve(1);
		};
	}

	/* Event source (proxy to our event system) */
	if (!st.eventSource) {
		st.eventSource = {
			on: function(type, listener) { return window.eventOn ? window.eventOn(type, listener) : null; },
			once: function(type, listener) { return window.eventOnce ? window.eventOnce(type, listener) : null; },
			emit: function(type) {
				if (window.eventEmit) {
					var args = Array.prototype.slice.call(arguments);
					return window.eventEmit.apply(null, args);
				}
			},
			removeListener: function(type, listener) { if (window.eventRemoveListener) window.eventRemoveListener(type, listener); }
		};
	}
	if (!st.eventTypes) st.eventTypes = window.tavern_events || {};

	/* Generate stub */
	if (!st.generate) st.generate = function() { console.warn('[ST Compat] generate() not implemented'); return Promise.resolve(''); };
	if (!st.addOneMessage) st.addOneMessage = function() { return null; };
	if (!st.deleteLastMessage) st.deleteLastMessage = function() { return Promise.resolve(); };
	if (!st.substituteParams) st.substituteParams = function(str) { return Promise.resolve(window.substitudeMacros ? window.substitudeMacros(str) : str); };

	/* World info stubs */
	if (!st.loadWorldInfo) st.loadWorldInfo = function() { return Promise.resolve(null); };
	if (!st.saveWorldInfo) st.saveWorldInfo = function() { return Promise.resolve(); };
	if (!st.getWorldInfoPrompt) st.getWorldInfoPrompt = function() { return Promise.resolve({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '' }); };

	/* Tool stubs */
	if (!st.registerFunctionTool) st.registerFunctionTool = function() {};
	if (!st.unregisterFunctionTool) st.unregisterFunctionTool = function() {};

	window.SillyTavern = st;

	/* Update getCurrentMessageId to use messageId */
	window.getCurrentMessageId = function() { return ${messageId}; };
})();
`
}
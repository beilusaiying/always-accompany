/**
 * BeiluHelper — beilu 规范命名空间 + 情感读取契约（注入到消息 iframe）
 *
 * 设计来源：渲染方案_设计.md §4.4 / §4.5；@types/README.md「window.BeiluHelper」。
 *
 * 两件事：
 *  ① getCurrentEmotion()：iframe 内读「当前情感」。唯一来源 = 父页面
 *     window.parent.__beiluEmotionState（由 websocket.mjs emitEmotionChanged 写入）。
 *     后端情感检测未落地前父页面不写它 → 一律返回 null（绝不造假）。
 *  ② window.BeiluHelper：beilu 规范入口，归集 beilu 专属/增补 API。
 *     与 TavernHelper 并存——平铺到 window 的别名全部保留（向后兼容）。
 *     BeiluHelper.x 在调用时实时委托到 window.x，两种写法等价。
 *
 * 依赖：需在 eventSystem / variableSystem / tavernHelper 之后注入（委托是惰性的，
 *   即使顺序靠前也只在调用时取 window 函数，但语义上归在 API 层之后）。
 */

/** 生成 BeiluHelper + getCurrentEmotion 注入脚本 */
export function generateBeiluHelperScript() {
	return `
// ── BeiluHelper 命名空间 + 情感读取契约 ──
(function() {
	// ① getCurrentEmotion：无来源返回 null，有来源返回 { emotion, message_id, timestamp }
	if (typeof window.getCurrentEmotion !== 'function') {
		window.getCurrentEmotion = function() {
			try {
				var s = window.parent && window.parent.__beiluEmotionState;
				return s ? { emotion: s.emotion, message_id: s.message_id, timestamp: s.timestamp } : null;
			} catch (e) { return null; }
		};
	}

	// ② BeiluHelper：实时委托到 window 上的平铺函数（两种写法等价）
	var _api = [
		// 事件
		'eventOn','eventOnce','eventMakeLast','eventMakeFirst','eventEmit','eventEmitAndWait',
		'eventRemoveListener','eventClearEvent','eventClearListener','eventClearAll',
		// 全局对象
		'initializeGlobal','waitGlobalInitialized',
		// 变量
		'getVariables','replaceVariables','updateVariablesWith','insertOrAssignVariables',
		'insertVariables','deleteVariable','getAllVariables',
		// 工具
		'errorCatched','getLastMessageId','getCurrentMessageId','substitudeMacros',
		'getIframeName','getScriptId','reloadIframe',
		// 楼层
		'getChatMessages','setChatMessages','createChatMessages','deleteChatMessages',
		'sendChoice','getUserName','getCurrentCharacterName','reloadMessages',
		// 世界书
		'getCurrentCharPrimaryLorebook','getLorebookEntries','getCharWorldbookNames','getLorebookSettings',
		// beilu 增补
		'getCurrentEmotion','triggerSlash'
	];
	window.BeiluHelper = window.BeiluHelper || {};
	_api.forEach(function(name) {
		if (window.BeiluHelper[name]) return;
		window.BeiluHelper[name] = function() {
			return typeof window[name] === 'function' ? window[name].apply(null, arguments) : undefined;
		};
	});
	// 聚合对象直接引用（非平铺函数）
	if (!window.BeiluHelper.TavernHelper && window.TavernHelper) window.BeiluHelper.TavernHelper = window.TavernHelper;
	if (!window.BeiluHelper.beiluAudio && window.beiluAudio) window.BeiluHelper.beiluAudio = window.beiluAudio;
})();`;
}

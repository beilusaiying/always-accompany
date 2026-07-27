/**
 * beiluDebug — iframe 内调试对象（注入到消息 iframe）
 *
 * 设计来源：渲染方案_设计.md §4.6 调试支持。
 * 用户在 iframe 的 DevTools Console 里调 `beiluDebug.*` 排查美化/脚本问题。
 *
 * 只读「已存在的真实符号」，不依赖未落地的情感/模式检测：
 *   - listListeners → 父页面事件总线 __beiluEventBus._listeners
 *   - dumpVariables → getAllVariables()（变量系统已注入）
 *   - fakeEvent     → eventEmit()（手动派发，调试监听器）
 *   - getParentState→ chatId / charName / userName / messageId（均有来源）
 *     ⚠ mode / emotion 检测链路 0% 落地，故 getParentState 不含这两项。
 *
 * 依赖：必须在 eventSystem / variableSystem / stContext 之后注入。
 */

/** 生成 beiluDebug 注入脚本 */
export function generateBeiluDebugScript() {
	return `
// ── beiluDebug：iframe 内调试对象（只读真实符号）──
(function() {
	function _bus() {
		try { return window.parent.__beiluEventBus || { _listeners: new Map() }; }
		catch (e) { return { _listeners: new Map() }; }
	}
	window.beiluDebug = {
		/** 查看事件总线上所有 type → 监听器数量 */
		listListeners: function() {
			var out = {};
			try {
				_bus()._listeners.forEach(function(arr, type) {
					out[type] = Array.isArray(arr) ? arr.length : 0;
				});
			} catch (e) {}
			return out;
		},
		/** 合并后的全部变量（= getAllVariables） */
		dumpVariables: function() {
			try {
				return typeof window.getAllVariables === 'function'
					? window.getAllVariables() : {};
			} catch (e) { return {}; }
		},
		/** 手动派发事件，调试监听器（= eventEmit） */
		fakeEvent: function(name, data) {
			try {
				if (typeof window.eventEmit === 'function') return window.eventEmit(name, data);
			} catch (e) {}
			return undefined;
		},
		/** 父页面状态：chatId / charName / userName / messageId
		 *  注：mode / emotion 检测未落地，故此处不含这两项 */
		getParentState: function() {
			var st = window.SillyTavern || {};
			return {
				chatId: (typeof st.getCurrentChatId === 'function' ? st.getCurrentChatId() : (st.chatId || '')),
				charName: (typeof window.getCurrentCharacterName === 'function' ? window.getCurrentCharacterName() : (st.name2 || '')),
				userName: (typeof window.getUserName === 'function' ? window.getUserName() : (st.name1 || '')),
				messageId: (typeof window.getCurrentMessageId === 'function' ? window.getCurrentMessageId() : null)
				// mode / emotion: 检测链路未实现，刻意省略
			};
		}
	};
})();`;
}

/**
 * TavernHelper 对象
 *
 * 将所有已注入的全局函数汇总到 window.TavernHelper 对象上，
 * 并添加酒馆助手 chat_message API（setChatMessages / getChatMessages 等）
 *
 * 从 polyfills.mjs generateTavernHelperScript 拆出
 */

export function generateTavernHelperScript() {
	return `
/* === ST Compat: Chat Message API + TavernHelper Object === */
(function() {
	/* ============================================================
	 * Chat Message API — 操作 SillyTavern.chat 数组
	 * 参考: JS-Slash-Runner/src/function/chat_message.ts
	 * ============================================================ */

	/** 解析 range 字符串为 { start, end } */
	function _parseRange(range, max) {
		if (max < 0) return null;
		var rangeStr = String(range);

		function clampVal(v) {
			if (v < 0) v = max + v + 1;
			return Math.max(0, Math.min(v, max));
		}

		var singleMatch = rangeStr.match(/^(-?\\d+)$/);
		if (singleMatch) {
			var val = clampVal(Number(singleMatch[1]));
			return { start: val, end: val };
		}

		var rangeMatch = rangeStr.match(/^(-?\\d+)-(-?\\d+)$/);
		if (rangeMatch) {
			var a = clampVal(Number(rangeMatch[1]));
			var b = clampVal(Number(rangeMatch[2]));
			return { start: Math.min(a, b), end: Math.max(a, b) };
		}

		return null;
	}

	/** 获取消息的 role */
	function _getMsgRole(msg) {
		if (msg.role) return msg.role;
		if (msg.is_user) return 'user';
		if (msg.extra && msg.extra.type === 'narrator') return 'system';
		return 'assistant';
	}

	/**
	 * getChatMessages(range, options?)
	 * 读取聊天消息，支持 range 和过滤
	 */
	window.getChatMessages = function(range, options) {
		options = options || {};
		var role = options.role || 'all';
		var hide_state = options.hide_state || 'all';
		var include_swipes = options.include_swipes || false;

		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		if (!chatArr.length) return [];

		// 如果没传 range，返回全部
		if (range === undefined || range === null) {
			range = '0-' + (chatArr.length - 1);
		}

		var parsed = _parseRange(range, chatArr.length - 1);
		if (!parsed) return [];

		var results = [];
		for (var i = parsed.start; i <= parsed.end; i++) {
			var msg = chatArr[i];
			if (!msg) continue;

			var msgRole = _getMsgRole(msg);
			if (role !== 'all' && msgRole !== role) continue;
			if (hide_state !== 'all') {
				if (hide_state === 'hidden' && !msg.is_system) continue;
				if (hide_state === 'unhidden' && msg.is_system) continue;
			}

			var swipeId = msg.swipe_id || 0;
			var swipes = msg.swipes || [msg.mes || msg.message || ''];
			var variables = msg.variables || [{}];
			var swipeInfo = msg.swipe_info || [msg.extra || {}];
			// 确保数组长度足够
			var swipeLen = swipes.length;
			while (variables.length < swipeLen) variables.push({});
			while (swipeInfo.length < swipeLen) swipeInfo.push({});

			if (include_swipes) {
				results.push({
					message_id: i,
					name: msg.name || '',
					role: msgRole,
					is_hidden: msg.is_system || false,
					swipe_id: swipeId,
					swipes: swipes.slice(),
					swipes_data: variables.map(function(v) { return v ? JSON.parse(JSON.stringify(v)) : {}; }),
					swipes_info: swipeInfo.map(function(v) { return v ? JSON.parse(JSON.stringify(v)) : {}; }),
				});
			} else {
				results.push({
					message_id: i,
					name: msg.name || '',
					role: msgRole,
					is_hidden: msg.is_system || false,
					message: msg.mes || msg.message || '',
					data: variables[swipeId] ? JSON.parse(JSON.stringify(variables[swipeId])) : {},
					extra: swipeInfo[swipeId] ? JSON.parse(JSON.stringify(swipeInfo[swipeId])) : {},
					// 兼容字段
					swipe_id: swipeId,
					swipes: swipes.slice(),
					swipes_data: variables.map(function(v) { return v ? JSON.parse(JSON.stringify(v)) : {}; }),
				});
			}
		}

		return results;
	};

	/**
	 * setChatMessages(chat_messages, options?)
	 * 修改聊天消息的内容/变量/元信息
	 * 这是 MVU bundle 的核心依赖 — 写入楼层变量
	 */
	window.setChatMessages = function(chat_messages, options) {
		options = options || {};
		if (!Array.isArray(chat_messages)) return Promise.resolve();

		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		if (!chatArr.length) {
			console.warn('[TH compat] setChatMessages: SillyTavern.chat is empty');
			return Promise.resolve();
		}

		// 合并相同 message_id 的条目
		var merged = {};
		chat_messages.forEach(function(cm) {
			var id = cm.message_id;
			if (id < 0) id = chatArr.length + id;
			if (id < 0 || id >= chatArr.length) return;
			if (!merged[id]) merged[id] = {};
			Object.keys(cm).forEach(function(k) {
				if (k !== 'message_id') merged[id][k] = cm[k];
			});
			merged[id]._resolvedId = id;
		});

		Object.keys(merged).forEach(function(idStr) {
			var cm = merged[idStr];
			var msgId = cm._resolvedId;
			var data = chatArr[msgId];
			if (!data) return;

			// 确保 variables 是数组格式
			if (data.variables && !Array.isArray(data.variables)) {
				var swipeLen = (data.swipes && data.swipes.length) || 1;
				var newVars = [];
				for (var vi = 0; vi < swipeLen; vi++) {
					newVars.push(data.variables[vi] || {});
				}
				data.variables = newVars;
			}

			// 更新基本字段
			if (cm.name !== undefined) data.name = cm.name;
			if (cm.role !== undefined) {
				data.is_user = cm.role === 'user';
				data.role = cm.role;
				if (cm.role === 'system') {
					if (!data.extra) data.extra = {};
					data.extra.type = 'narrator';
				}
			}
			if (cm.is_hidden !== undefined) {
				data.is_hidden = cm.is_hidden;
				data.is_system = cm.is_hidden;
			}

			// 检测是 ChatMessage 格式还是 ChatMessageSwiped 格式
			var isChatMessage = ('message' in cm) || ('data' in cm && !('swipes' in cm));

			if (isChatMessage) {
				// ChatMessage 格式 — 更新当前 swipe 的 message 和 data
				var swipeId = data.swipe_id || 0;

				if (cm.message !== undefined) {
					data.mes = cm.message;
					data.message = cm.message;
					if (data.swipes) {
						data.swipes[swipeId] = cm.message;
					}
				}
				if (cm.data !== undefined) {
					if (!data.variables) {
						var sLen = (data.swipes && data.swipes.length) || 1;
						data.variables = [];
						for (var j = 0; j < sLen; j++) data.variables.push({});
					}
					data.variables[swipeId] = cm.data;
					data.data = cm.data; // API 层同步
				}
				if (cm.extra !== undefined) {
					data.extra = cm.extra;
					if (data.swipe_info) {
						data.swipe_info[swipeId] = cm.extra;
					}
				}
			} else if (cm.swipe_id !== undefined || cm.swipes !== undefined || cm.swipes_data !== undefined || cm.swipes_info !== undefined) {
				// ChatMessageSwiped 格式 — 更新 swipe 相关字段
				var maxLen = Math.max(
					cm.swipes ? cm.swipes.length : 0,
					cm.swipes_data ? cm.swipes_data.length : 0,
					cm.swipes_info ? cm.swipes_info.length : 0,
					(data.swipes && data.swipes.length) || 1
				);

				var newSwipeId = cm.swipe_id !== undefined ? cm.swipe_id : (data.swipe_id || 0);
				newSwipeId = Math.max(0, Math.min(newSwipeId, maxLen - 1));

				var newSwipes = cm.swipes || data.swipes || [data.mes || ''];
				var newSwipesData = cm.swipes_data || data.variables || [{}];
				var newSwipesInfo = cm.swipes_info || data.swipe_info || [{}];

				// 补齐长度
				while (newSwipes.length < maxLen) newSwipes.push('');
				while (newSwipesData.length < maxLen) newSwipesData.push({});
				while (newSwipesInfo.length < maxLen) newSwipesInfo.push({});

				data.swipes = newSwipes;
				data.variables = newSwipesData;
				data.swipe_info = newSwipesInfo;
				data.swipe_id = newSwipeId;
				data.mes = newSwipes[newSwipeId] || '';
				data.message = data.mes;
				data.extra = newSwipesInfo[newSwipeId] || {};
				data.data = newSwipesData[newSwipeId] || {};
			}
		});

		// ★ 同步楼层变量到父页面 variableStore（通过 replaceVariables 的 beilu-var-replace 通道）
		// 这样 beilu 的变量管理器 UI 能读取到更新后的楼层变量数据
		Object.keys(merged).forEach(function(idStr) {
			var cm = merged[idStr];
			var msgId = cm._resolvedId;
			var msgData = chatArr[msgId];
			if (!msgData) return;
			var swipeId = msgData.swipe_id || 0;
			var varData = (msgData.variables && msgData.variables[swipeId]) || {};
			// 通过 variableSystem 的 replaceVariables 通道同步到父页面
			if (typeof window.replaceVariables === 'function' && Object.keys(varData).length > 0) {
				window.replaceVariables(varData, {type: 'message', message_id: msgId});
			}
		});

		console.log('[TH compat] setChatMessages: updated', Object.keys(merged).length, 'messages, synced to parent');
		return Promise.resolve();
	};

	/**
	 * setChatMessage (deprecated — 旧版 API，转发给 setChatMessages)
	 */
	window.setChatMessage = function(field_values, message_id, options) {
		options = options || {};
		if (typeof field_values === 'string') field_values = { message: field_values };
		var entry = { message_id: message_id };
		if (field_values.message !== undefined) entry.message = field_values.message;
		if (field_values.data !== undefined) entry.data = field_values.data;
		return window.setChatMessages([entry], { refresh: options.refresh || 'none' });
	};

	/**
	 * createChatMessages(chat_messages, options?)
	 * 创建新消息并插入到 chat 数组
	 */
	window.createChatMessages = function(chat_messages, options) {
		options = options || {};
		var insertBefore = options.insert_at !== undefined ? options.insert_at : (options.insert_before !== undefined ? options.insert_before : 'end');

		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];

		var newMsgs = chat_messages.map(function(cm) {
			var role = cm.role || 'assistant';
			return {
				name: cm.name || (role === 'user' ? (window.SillyTavern.name1 || 'User') : (window.SillyTavern.name2 || 'Character')),
				role: role,
				is_user: role === 'user',
				is_system: cm.is_hidden || false,
				is_hidden: cm.is_hidden || false,
				mes: cm.message || '',
				message: cm.message || '',
				data: cm.data || {},
				extra: cm.extra || {},
				swipe_id: 0,
				swipes: [cm.message || ''],
				variables: [cm.data || {}],
				swipe_info: [cm.extra || {}],
			};
		});

		if (insertBefore === 'end') {
			Array.prototype.push.apply(chatArr, newMsgs);
		} else {
			var pos = typeof insertBefore === 'number' ? Math.max(0, Math.min(insertBefore, chatArr.length)) : chatArr.length;
			Array.prototype.splice.apply(chatArr, [pos, 0].concat(newMsgs));
		}

		// 更新 message_id
		for (var i = 0; i < chatArr.length; i++) {
			chatArr[i].message_id = i;
		}

		console.log('[TH compat] createChatMessages: added', newMsgs.length, 'messages, total:', chatArr.length);
		return Promise.resolve();
	};

	/**
	 * deleteChatMessages(message_ids, options?)
	 * 删除指定消息
	 */
	window.deleteChatMessages = function(message_ids, options) {
		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		if (!Array.isArray(message_ids) || !chatArr.length) return Promise.resolve();

		// 从后往前删除
		var sorted = message_ids.slice().sort(function(a, b) { return b - a; });
		sorted.forEach(function(id) {
			if (id >= 0 && id < chatArr.length) {
				chatArr.splice(id, 1);
			}
		});

		// 更新 message_id
		for (var i = 0; i < chatArr.length; i++) {
			chatArr[i].message_id = i;
		}

		return Promise.resolve();
	};

	/**
	 * rotateChatMessages(begin, middle, end, options?)
	 */
	window.rotateChatMessages = function(begin, middle, end, options) {
		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		if (!chatArr.length) return Promise.resolve();

		begin = Math.max(0, Math.min(begin, chatArr.length));
		end = Math.max(0, Math.min(end, chatArr.length));
		middle = Math.max(begin, Math.min(middle, end));

		var rightPart = chatArr.splice(middle, end - middle);
		Array.prototype.splice.apply(chatArr, [begin, 0].concat(rightPart));

		return Promise.resolve();
	};

	/**
	 * substitudeMacros / getMessageId / refreshOneMessage / formatAsDisplayedMessage
	 */
	window.substitudeMacros = window.substitudeMacros || function(text) { return text; };
	window.getMessageId = window.getMessageId || window.getCurrentMessageId || function() { return -1; };
	window.refreshOneMessage = window.refreshOneMessage || function() { return Promise.resolve(); };
	window.formatAsDisplayedMessage = window.formatAsDisplayedMessage || function(msg) { return msg; };
	window.retrieveDisplayedMessage = window.retrieveDisplayedMessage || function() { return []; };

	/* ============================================================
	 * TavernHelper 对象
	 * ============================================================ */
	window.TavernHelper = {
		/* Variables */
		getVariables: window.getVariables,
		replaceVariables: window.replaceVariables,
		updateVariablesWith: window.updateVariablesWith,
		insertOrAssignVariables: window.insertOrAssignVariables,
		insertVariables: window.insertVariables,
		deleteVariable: window.deleteVariable,
		registerVariableSchema: window.registerVariableSchema,
		getAllVariables: window.getAllVariables,

		/* Events */
		eventOn: window.eventOn,
		eventOnce: window.eventOnce,
		eventMakeLast: window.eventMakeLast,
		eventMakeFirst: window.eventMakeFirst,
		eventEmit: window.eventEmit,
		eventEmitAndWait: window.eventEmitAndWait,
		eventRemoveListener: window.eventRemoveListener,
		eventClearEvent: window.eventClearEvent,
		eventClearListener: window.eventClearListener,
		eventClearAll: window.eventClearAll,

		/* Global */
		initializeGlobal: window.initializeGlobal,
		waitGlobalInitialized: window.waitGlobalInitialized,

		/* Chat Message API（完整实现） */
		getChatMessages: window.getChatMessages,
		setChatMessages: window.setChatMessages,
		setChatMessage: window.setChatMessage,
		createChatMessages: window.createChatMessages,
		deleteChatMessages: window.deleteChatMessages,
		rotateChatMessages: window.rotateChatMessages,
		getCurrentMessageId: window.getCurrentMessageId,
		refreshOneMessage: window.refreshOneMessage,
		formatAsDisplayedMessage: window.formatAsDisplayedMessage,
		retrieveDisplayedMessage: window.retrieveDisplayedMessage,

		/* Slash */
		triggerSlash: window.triggerSlash,
		triggerSlashWithResult: window.triggerSlash,

		/* Utils */
		errorCatched: window.errorCatched,
		getLastMessageId: window.getLastMessageId,
		getMessageId: window.getMessageId,
		substitudeMacros: window.substitudeMacros,
		getIframeName: window.getIframeName,
		getScriptId: window.getScriptId,
		reloadIframe: window.reloadIframe,

		/* Tavern Regex API */
		getTavernRegexes: function() { return []; },
		replaceTavernRegexes: function() { return Promise.resolve(); },
		updateTavernRegexesWith: function(updater) { return Promise.resolve([]); },
		isCharacterTavernRegexesEnabled: function() { return false; },
		formatAsTavernRegexedString: function(text) { return text; },

		/* Stubs for less common APIs */
		generate: function() { return Promise.resolve(''); },
		generateRaw: function() { return Promise.resolve(''); },
		stopGenerationById: function() {},
		stopAllGeneration: function() {},
		getModelList: function() { return Promise.resolve([]); },
		injectPrompts: function() {},
		uninjectPrompts: function() {},
		playAudio: function() {},
		pauseAudio: function() {},
		getAudioList: function() { return []; },
		replaceAudioList: function() {},
		appendAudioList: function() {},
		getAudioSettings: function() { return {}; },
		setAudioSettings: function() {},
		getCharacterNames: function() { return []; },
		getCurrentCharacterName: function() { return window.SillyTavern ? window.SillyTavern.name2 : ''; },
		getPresetNames: function() { return []; },
		getPreset: function() { return {}; },
		getAllEnabledScriptButtons: function() { return []; },
		importRawCharacter: function() { return Promise.resolve(); },
		importRawPreset: function() { return Promise.resolve(); },
		importRawChat: function() { return Promise.resolve(); },
		importRawWorldbook: function() { return Promise.resolve(); },
		importRawTavernRegex: function() { return Promise.resolve(); },
		getTavernHelperVersion: function() { return '4.7.9-compat'; },
		getFrontendVersion: function() { return '4.7.9-compat'; },
		getTavernHelperExtensionId: function() { return 'beilu-st-compat'; },
		getTavernVersion: function() { return 'beilu-always-accompany'; },
		getExtensionType: function() { return 'local'; },
		isAdmin: function() { return true; },
		isInstalledExtension: function() { return true; },

		/* _th_impl for predefine.js compat */
		_th_impl: {
			_init: function() {},
			_log: function() {},
			_clearLog: function() {},
			writeExtensionField: function() {},
		},
	};

	/* ★ 展开 TavernHelper 到 window（仿酒馆 predefine.js 的 _.merge(window, _.omit(TavernHelper, '_bind'))）
	   这样脚本可以直接调用 setChatMessages() 而不需要 TavernHelper.setChatMessages()
	   ★ 注意：强制覆盖所有 TavernHelper 函数到 window，确保 earlyScript 的简单 stub 被替换 */
	var keys = Object.keys(window.TavernHelper);
	for (var i = 0; i < keys.length; i++) {
		var k = keys[i];
		if (k === '_bind' || k === '_th_impl') continue;
		// ★ 移除 typeof 检查 — 强制覆盖 earlyScript 的 stub
		window[k] = window.TavernHelper[k];
	}
})();
`
}
/**
 * TavernHelper 对象
 *
 * 将所有已注入的全局函数汇总到 window.TavernHelper 对象上，
 * 并添加酒馆助手 chat_message API（setChatMessages / getChatMessages 等）
 *
 * 从 polyfills.mjs generateTavernHelperScript 拆出
 */

import { assessRegexComplexity, REGEX_COMPLEXITY_DEFAULTS, REGEX_MAX_INPUT_LENGTH } from '../../shared/regex-core/regexCore.mjs'

export function generateTavernHelperScript() {
	// #ReDoS-FE：本脚本注入到角色卡 iframe（无 ESM，不能 import）。把 regexCore.assessRegexComplexity
	//   的【源码本体】.toString() 嵌进 iframe 脚本 = 与后端/主线程同一份启发式，零副本漂移。
	//   契约：assessRegexComplexity 必须自包含（除随它一起嵌入的 REGEX_COMPLEXITY_DEFAULTS 外不引模块作用域标识符）。
	const _assessSrc = assessRegexComplexity.toString()
	const _defaultsSrc = JSON.stringify(REGEX_COMPLEXITY_DEFAULTS)
	// R1-SKIP: 下方 return 的是注入角色卡 iframe 的脚本字符串(无 ESM,不能 import apiFetch)；其内全部 fetch(/api/...,{credentials:include}) 必须保留 raw fetch。
	return `
/* === ST Compat: Chat Message API + TavernHelper Object === */
(function() {
	/* #ReDoS-FE: 同源静态护栏（regexCore.assessRegexComplexity 源码本体内联，与主线程/后端同闸，零漂移） */
	var REGEX_COMPLEXITY_DEFAULTS = ${_defaultsSrc};
	var REGEX_MAX_INPUT_LENGTH = ${REGEX_MAX_INPUT_LENGTH};
	var assessRegexComplexity = ${_assessSrc};

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

	/* ============================================================
	 * F-T3: BeiluHelper 增补 API (只做框架,不做映射/词典 — 用户代码自己解释语义)
	 *   sendChoice          — 选项按钮回传聊天输入(postMessage 桥接)
	 *   getUserName         — 读 SillyTavern.name1
	 *   getCurrentCharacterName — 读 SillyTavern.name2
	 * 不提供情感/映射表等语义层 API,用户美化代码自己从消息内容做解析
	 * ============================================================ */
	window.sendChoice = window.sendChoice || function(text, options) {
		options = options || {};
		if (!text) return;
		try {
			window.parent.postMessage({
				type: 'beilu-chat-message',
				messages: [{ message: String(text) }],
				autoSend: options.autoSend !== false,
			}, '*');
		} catch (e) { console.warn('[BeiluHelper] sendChoice failed:', e); }
	};
	window.getUserName = window.getUserName || function() {
		return (window.SillyTavern && window.SillyTavern.name1) || '';
	};
	window.getCurrentCharacterName = window.getCurrentCharacterName || function() {
		return (window.SillyTavern && window.SillyTavern.name2) || '';
	};

	/* ============================================================
	 * 情感系统前端契约（设计 §4.3 P1 / §4.4 / §4.5）
	 *
	 * 当前状态：情感检测链路 0% 落地，父页面无情感来源。
	 * 这里只把「前端契约」就位，后端检测落地后即插即用：
	 *
	 *   ① getCurrentEmotion() — 读父页面 window.parent.__beiluEmotionState
	 *      后端检测到情感标签后由 websocket.mjs 的 emitEmotionChanged() 写入。
	 *      没有来源时返回 null（★ 绝不造假数据，宁缺勿假，与 beiluDebug 同原则）。
	 *      返回形状：{ emotion: string, message_id: number, timestamp: number } | null
	 *
	 *   ② EMOTION_CHANGED 事件 — 监听管道复用现有 eventOn（事件总线已就位）：
	 *        eventOn(tavern_events.EMOTION_CHANGED, ({ emotion, message_id }) => { ... });
	 *      事件分发（producer）在父页面：emitEmotionChanged() 写 __beiluEmotionState
	 *      + 走 _emitEventBus('emotion_changed', ...) 广播给所有 iframe。
	 *      producer 未落地前监听不会触发——契约就位，不阻塞。
	 * ============================================================ */
	window.getCurrentEmotion = window.getCurrentEmotion || function() {
		try {
			var st = window.parent && window.parent.__beiluEmotionState;
			// 无来源（后端情感检测未落地）→ 返回 null，不造假
			if (!st || typeof st.emotion !== 'string' || !st.emotion) return null;
			return {
				emotion: st.emotion,
				message_id: typeof st.message_id === 'number' ? st.message_id : -1,
				timestamp: st.timestamp || 0,
			};
		} catch (e) {
			// 跨域/父页面不可达 → 同样按"无来源"处理
			return null;
		}
	};
	// R-HR: 美化热重载 — iframe 可主动触发父页面重渲染最近 N 条消息
	//   场景:开发美化代码时保存后立刻看到效果
	//   父页面侧:iframeRenderer.mjs 的 beilu-reload-beautify case → virtualQueue.reloadBeautify()
	window.reloadMessages = window.reloadMessages || function(limit) {
		try {
			window.parent.postMessage({ type: 'beilu-reload-beautify', limit: Number(limit) || 10 }, '*');
		} catch (e) { console.warn('[reloadMessages] postMessage failed:', e); }
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

		/* F-T3: BeiluHelper 增补 */
		sendChoice: window.sendChoice,
		getUserName: window.getUserName,
		/* 情感系统契约（无来源时 getCurrentEmotion 返回 null） */
		getCurrentEmotion: window.getCurrentEmotion,
		/* R-HR: 美化热重载 */
		reloadMessages: window.reloadMessages,

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

		/* =======================================================
		 * R6: Tavern Regex CRUD — 真实现,桥接到 beilu-regex 插件
		 *
		 * 酒馆助手的 TavernRegex 和 beilu-regex 规则结构相近但字段名有差异。
		 * 这里直接透传 beilu 原生字段给用户脚本,不做 schema 翻译(避免"映射表")。
		 * 用户脚本读到的是 beilu 规则,写入也按 beilu 字段(id/enabled/scope/
		 * findRegex/replaceString/placement/boundCharName/boundPresetName 等)。
		 *
		 * iframe 在 sandbox="allow-scripts allow-same-origin" 下可直接 fetch 同源 API,
		 * 不走父页面 postMessage 中介,更简单。
		 * ======================================================= */

		/**
		 * 读取全部 display 规则。
		 * @returns {Promise<Array>} beilu-regex 原生规则数组
		 */
		getTavernRegexes: async function() {
			try {
				var r = await fetch('/api/parts/plugins:beilu-regex/config/getdata', { credentials: 'include' });
				if (!r.ok) return [];
				var data = await r.json();
				return Array.isArray(data.rules) ? data.rules : [];
			} catch (e) {
				console.warn('[getTavernRegexes] fetch failed:', e);
				return [];
			}
		},

		/**
		 * 全量替换规则集。
		 * 实现:先读老规则,按 id diff 出 add/update/remove 三类,分别调对应 action。
		 * 注意:beilu-regex 没有 replaceAll 原子操作,这里是多次 HTTP 请求,不保证原子性。
		 * @param {Array} newRules 新规则数组
		 * @returns {Promise<Array>} 新规则数组(echo 回调用方)
		 */
		replaceTavernRegexes: async function(newRules) {
			if (!Array.isArray(newRules)) return [];
			var SET_API = '/api/parts/plugins:beilu-regex/config/setdata';
			try {
				// 1. 读老规则
				var oldRules = await window.TavernHelper.getTavernRegexes();
				var oldIds = new Set(oldRules.map(function(r) { return r.id; }));
				var newIds = new Set(newRules.filter(function(r) { return r && r.id; }).map(function(r) { return r.id; }));

				// 2. 删除:老有新无
				for (var _i = 0; _i < oldRules.length; _i++) {
					var oldR = oldRules[_i];
					if (!newIds.has(oldR.id)) {
						await fetch(SET_API, {
							method: 'POST', credentials: 'include',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ _action: 'removeRule', ruleId: oldR.id }),
						});
					}
				}

				// 3. 更新/新增
				for (var _j = 0; _j < newRules.length; _j++) {
					var nR = newRules[_j];
					if (!nR) continue;
					if (nR.id && oldIds.has(nR.id)) {
						// 已存在 → updateRule
						await fetch(SET_API, {
							method: 'POST', credentials: 'include',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ _action: 'updateRule', rule: nR }),
						});
					} else {
						// 新规则 → addRule(id 由后端生成,忽略调用方传的 id)
						await fetch(SET_API, {
							method: 'POST', credentials: 'include',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ _action: 'addRule', rule: nR }),
						});
					}
				}

				return newRules;
			} catch (e) {
				console.warn('[replaceTavernRegexes] failed:', e);
				return [];
			}
		},

		/**
		 * 函数式更新:读 → updater(rules) → 写回
		 * @param {Function} updater (rules) => rules
		 * @returns {Promise<Array>} 更新后的规则数组
		 */
		updateTavernRegexesWith: async function(updater) {
			if (typeof updater !== 'function') return [];
			var rules = await window.TavernHelper.getTavernRegexes();
			var next = updater(rules);
			if (!Array.isArray(next)) return rules;
			return await window.TavernHelper.replaceTavernRegexes(next);
		},

		/**
		 * 当前角色是否启用了规则(beilu-regex 全局配置 enabled 字段)
		 * @returns {Promise<boolean>}
		 */
		isCharacterTavernRegexesEnabled: async function() {
			try {
				var r = await fetch('/api/parts/plugins:beilu-regex/config/getdata', { credentials: 'include' });
				if (!r.ok) return false;
				var data = await r.json();
				return !!data.enabled;
			} catch { return false; }
		},

		/**
		 * 对文本应用所有 display 正则(仅做字符串替换,不改后端规则)。
		 * 最小可用:不做复杂 placement/深度筛选,由调用方自己决定是否叠加应用。
		 * @param {string} text 原文本
		 * @returns {Promise<string>} 替换后的文本
		 */
		formatAsTavernRegexedString: async function(text) {
			if (!text) return text;
			try {
				var rules = await window.TavernHelper.getTavernRegexes();
				var result = String(text);
				for (var _i = 0; _i < rules.length; _i++) {
					var rule = rules[_i];
					if (!rule || rule.disabled || !rule.findRegex) continue;
					try {
						// 解析 /pattern/flags 形式的 findRegex（模板字面量内须 \\/ 才能在注入脚本里产出 \/，否则 \/ 塌成 / 致正则破损）
						var m = rule.findRegex.match(/^\\/(.+)\\/([gimsuy]*)$/);
						var re = m ? new RegExp(m[1], m[2]) : new RegExp(rule.findRegex);
						// #ReDoS-FE：findRegex 来自可导入角色卡，跑前过同源静态护栏 + 长度上限，命中即跳过该规则。
						if (!assessRegexComplexity(re.source).ok) continue;
						if (result.length > REGEX_MAX_INPUT_LENGTH) continue;
						result = result.replace(re, rule.replaceString || '');
					} catch { /* ignore per-rule errors */ }
				}
				return result;
			} catch { return text; }
		},

		/* Stubs for less common APIs */
		/* =======================================================
		 * R4: generate / generateRaw — iframe 调 AI 的"小工具"接口
		 *
		 * 用途:脚本/美化代码需要调 AI 做"额外处理"(翻译/摘要/小任务),
		 *       不触发聊天主流程(不记录到 chat_log,不走 P1/INJ/世界书)。
		 *
		 * 实现:走 beilu-memory 的 testAuxiliary action(setDataActions.mjs),
		 *       后端接 runMemoryPresetAI 引擎单轮调用系统默认 AI 服务源
		 *       (use_custom:false → loadAnyPreferredDefaultPart),独立于聊天主流程。
		 *       注:旧"辅助 AI"独立配置(yonban_config.auxiliaryAI)已删,
		 *          现直接复用系统默认 AI 源,无需单独配置。
		 *
		 * 失败:后端返回 {success:false,error} 时,generate 抛错(不再静默空串),
		 *       generateRaw 返回 {content:'',error} 含真实原因。
		 *
		 * 参数:可以是字符串(直接作为 user message) 或对象 {user_input/prompt:string}
		 * 返回:
		 *   generate     — Promise<string>  纯文本回复
		 *   generateRaw  — Promise<{content, reasoning?, model?}>  含元信息的对象
		 * ======================================================= */
		generate: async function(config) {
			var text = typeof config === 'string' ? config : (config && (config.user_input || config.prompt || config.content)) || '';
			if (!text) return '';
			try {
				var r = await fetch('/api/parts/plugins:beilu-memory/config/setdata', {
					method: 'POST', credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ _action: 'testAuxiliary', content: String(text) }),
				});
				var j = await r.json();
				if (!j.success) {
					// 诚实报错:STScript 调用方能看到失败原因(不再静默空串)。
					throw new Error('辅助 AI 调用失败: ' + (j.error || 'unknown'));
				}
				return j.reply || '';
			} catch (e) {
				console.warn('[generate] 辅助 AI 调用失败:', e && e.message || e);
				throw e;
			}
		},
		generateRaw: async function(config) {
			var text = typeof config === 'string' ? config : (config && (config.user_input || config.prompt || config.content)) || '';
			if (!text) return { content: '' };
			try {
				var r = await fetch('/api/parts/plugins:beilu-memory/config/setdata', {
					method: 'POST', credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ _action: 'testAuxiliary', content: String(text) }),
				});
				var j = await r.json();
				if (!j.success) return { content: '', error: j.error || 'unknown' };
				return { content: j.reply || '', model: j.model || '' };
			} catch (e) {
				return { content: '', error: e.message };
			}
		},
		stopGenerationById: function() {},
		stopAllGeneration: function() {},
		getModelList: function() { return Promise.resolve([]); },
		// R5: 通过 postMessage 桥接到父页面 beilu-memory addInjectionPrompt
		//   prompts: [{id?, role, content, depth?, order?, description?}]
		//   一次性注入,generation_ended 后自动清除
		injectPrompts: function(prompts) {
			try {
				window.parent.postMessage({
					type: 'beilu-inject-prompts',
					prompts: Array.isArray(prompts) ? prompts : [],
				}, '*');
			} catch (e) { console.warn('[injectPrompts] postMessage failed:', e); }
		},
		uninjectPrompts: function(ids) {
			try {
				window.parent.postMessage({
					type: 'beilu-uninject-prompts',
					ids: Array.isArray(ids) ? ids : [],
				}, '*');
			} catch (e) { console.warn('[uninjectPrompts] postMessage failed:', e); }
		},
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

	/* ============================================================
	 * window.BeiluHelper — beilu 正式命名空间（设计 §4.4）
	 *
	 * 定位：BeiluHelper 是 beilu 的【规范入口】，归集 beilu 专属/增补 API。
	 *   - 它是【新增】的命名对象，不是 TavernHelper 的替换。
	 *   - window.TavernHelper 及其平铺到 window 的别名【全部保留不动】，
	 *     现有美化/角色卡脚本不会被破坏（向后兼容）。
	 *   - 这里引用上面已定义好的同名 window 函数（事件/全局/变量/楼层/工具
	 *     由前序 shim 注入，TavernHelper.* 已就位），不重复实现，只做归集。
	 *
	 * 用户既可写 BeiluHelper.eventOn(...)（规范风格），
	 * 也可继续直接写 eventOn(...)（酒馆平铺风格），两者等价。
	 * ============================================================ */
	window.BeiluHelper = window.BeiluHelper || {
		/* —— 事件系统（设计 §4.3 P0）—— */
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
		/* 事件常量（含 beilu 专属 EMOTION_CHANGED 等，见 eventConstants.mjs） */
		tavern_events: window.tavern_events,
		iframe_events: window.iframe_events,

		/* —— 用户交互回传（设计 §4.3 P0）—— */
		sendChoice: window.sendChoice,
		triggerSlash: window.triggerSlash,

		/* —— 变量系统（设计 §4.3 P1）—— */
		getVariables: window.getVariables,
		replaceVariables: window.replaceVariables,
		updateVariablesWith: window.updateVariablesWith,
		insertOrAssignVariables: window.insertOrAssignVariables,
		insertVariables: window.insertVariables,
		deleteVariable: window.deleteVariable,
		getAllVariables: window.getAllVariables,

		/* —— 全局对象 / iframe 间通信（设计 §4.3 P2）—— */
		initializeGlobal: window.initializeGlobal,
		waitGlobalInitialized: window.waitGlobalInitialized,

		/* —— 楼层消息（设计 §4.3 P1）—— */
		getChatMessages: window.getChatMessages,
		setChatMessages: window.setChatMessages,
		createChatMessages: window.createChatMessages,
		deleteChatMessages: window.deleteChatMessages,
		getCurrentMessageId: window.getCurrentMessageId,
		getLastMessageId: window.getLastMessageId,

		/* —— 角色/用户信息 —— */
		getUserName: window.getUserName,
		getCurrentCharacterName: window.getCurrentCharacterName,

		/* —— 提示词注入（设计 §4.3 P2）—— */
		injectPrompts: window.TavernHelper.injectPrompts,
		uninjectPrompts: window.TavernHelper.uninjectPrompts,

		/* —— 音频桥（如果 beiluAudio 已注入）—— */
		audio: window.beiluAudio,

		/* —— 情感系统契约（设计 §4.3 P1 / §4.5）——
		 * getCurrentEmotion 无来源时返回 null；
		 * EMOTION_CHANGED 监听复用 eventOn(tavern_events.EMOTION_CHANGED, cb)。 */
		getCurrentEmotion: window.getCurrentEmotion,

		/* —— 开发体验 —— */
		reloadMessages: window.reloadMessages,
		reloadIframe: window.reloadIframe,

		/* 版本标识 */
		version: '1.0-contract',
	};
})();
`
}
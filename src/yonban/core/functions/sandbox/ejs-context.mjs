/**
 * beilu-ejs — 共享纯函数模块（主线程 / Worker 单一来源）
 *
 * 从 main.mjs 抽出，杜绝 buildEjsContext / _substituteMacros 双份维护漂移。
 * 这两个函数都是纯函数：不依赖 whitebox / info.json / 插件状态 / 外部 I/O。
 *
 * 注意：buildEjsContext 接收的 `arg` 在 worker 侧是轻量对象
 *   { chat_id, chat_log:[{role,content}], Charname, UserCharname }
 * 在主线程侧（若仍调用）是完整 chatReplyRequest_t。两侧 getter 逻辑一致。
 */

/**
 * 替换酒馆宏标记 —— 对标 SillyTavern substituteParams
 *   {{user}} → 用户名 / {{char}} → 角色名 / {{currentCharacter}} → MVU 当前角色 / {{// ...}} → 移除注释
 */
export function _substituteMacros(text, charName, userName, vars) {
	if (typeof text !== 'string') return text;
	let result = text;
	result = result.replace(/\{\{user\}\}/gi, userName || '');
	result = result.replace(/\{\{char\}\}/gi, charName || '');
	result = result.replace(/\{\{currentCharacter\}\}/gi, vars?.currentCharacter || charName || '');
	result = result.replace(/\{\{\/\/[^}]*\}\}/g, ''); // 移除注释 {{// ... }}
	return result;
}

/**
 * 构建 EJS 上下文 —— 对标 ST-Prompt-Template prepareContext
 *
 * @param {object} _ - lodash-es（由调用方注入，避免本模块对 npm:lodash-es 的静态依赖）
 * @param {object} statData - 当前 stat_data 对象（MVU 变量）
 * @param {object} arg - chatReplyRequest_t（或 worker 轻量等价对象）
 * @param {object} prompt_struct - prompt_struct_t（仅用于 Charname/UserCharname 回退）
 * @returns {object} EJS 上下文
 */
export function buildEjsContext(_, statData, arg, prompt_struct) {
	// 变量快照（EJS 渲染期间的临时工作副本）
	const vars = _.cloneDeep(statData || {});

	const charName = arg.Charname || prompt_struct?.Charname || 'Character';
	const userName = arg.UserCharname || prompt_struct?.UserCharname || 'User';

	const context = {
		// ---- 变量系统 (对标 ST-Prompt-Template variables.ts) ----
		get variables() { return vars; },
		stat_data: vars,

		getvar: (path, defaults) => {
			if (path == null) return vars;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			return _.get(vars, cleanPath, defaults);
		},

		// EJS 渲染期间的修改是临时的，不持久化到 chatLog
		setvar: (path, value) => {
			if (path == null) return;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			_.set(vars, cleanPath, value);
			return value;
		},

		getLocalVar: (path, defaults) => _.get(vars, path, defaults),
		setLocalVar: (path, value) => { _.set(vars, path, value); return value; },
		getGlobalVar: (path, defaults) => _.get(vars, path, defaults),
		setGlobalVar: (path, value) => { _.set(vars, path, value); return value; },
		getMessageVar: (path, defaults) => _.get(vars, path, defaults),
		setMessageVar: (path, value) => { _.set(vars, path, value); return value; },

		incvar: (path, amount = 1) => {
			const cleanPath = String(path).replace(/^stat_data\./, '');
			const current = _.get(vars, cleanPath, 0);
			const _inc = Number(amount); const newVal = (Number(current) || 0) + (Number.isFinite(_inc) ? _inc : 1);
			_.set(vars, cleanPath, newVal);
			return newVal;
		},

		decvar: (path, amount = 1) => {
			const cleanPath = String(path).replace(/^stat_data\./, '');
			const current = _.get(vars, cleanPath, 0);
			const _dec = Number(amount); const newVal = (Number(current) || 0) - (Number.isFinite(_dec) ? _dec : 1);
			_.set(vars, cleanPath, newVal);
			return newVal;
		},

		delvar: (path) => {
			if (path == null) return;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			_.unset(vars, cleanPath);
		},

		// ---- 角色/用户信息 ----
		currentCharacter: vars?.currentCharacter || '',
		charName: charName,
		assistantName: charName,
		userName: userName,
		user: userName,
		char: charName,
		name1: userName,
		name2: charName,

		// ---- 聊天信息 ----
		get chatId() { return arg.chat_id || ''; },
		get lastMessageId() {
			const chatLog = arg.chat_log || [];
			return chatLog.length > 0 ? chatLog.length - 1 : -1;
		},
		get lastUserMessage() {
			const chatLog = arg.chat_log || [];
			for (let i = chatLog.length - 1; i >= 0; i--) {
				if (chatLog[i]?.role === 'user') return chatLog[i].content || '';
			}
			return '';
		},
		get lastCharMessage() {
			const chatLog = arg.chat_log || [];
			for (let i = chatLog.length - 1; i >= 0; i--) {
				if (chatLog[i]?.role === 'char') return chatLog[i].content || '';
			}
			return '';
		},

		// ---- 工具库 (对标 SHARE_CONTEXT) ----
		_: _,
		console: console,

		// ---- define 全局定义 ----
		define: (name, value) => {
			_.set(context, name, value);
		},

		// 同步桩（保持与原 main.mjs 一致）
		execute: () => '',
		substitudeMacros: (text) => _substituteMacros(text, charName, userName, vars),
	};

	return context;
}

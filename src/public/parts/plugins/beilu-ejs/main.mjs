/**
 * beilu-ejs — EJS 模板渲染插件
 *
 * 对标 ST-Prompt-Template (https://github.com/knifeayumu/ST-Prompt-Template)
 *
 * 功能：
 *   1. 在提示词发送前渲染世界书条目和提示词中的 EJS 模板语法
 *   2. 构建与 ST-Prompt-Template 兼容的 EJS 上下文
 *   3. 支持 getvar/setvar/incvar/decvar 等变量操作 API
 *   4. 支持 {{user}}/{{char}} 宏替换
 *
 * 执行时机：
 *   - TweakPrompt(detail_level=0)：在所有其他插件注入完毕后（最后一轮）
 *   - 此时世界书条目(detail_level=2)和 MVU 变量(detail_level=1)都已注入
 *
 * 对标关系：
 *   - prepareContext → buildEjsContext()
 *   - evalTemplate → renderEjsTemplate()
 *   - processGenerateAfter → renderEjsInPromptStruct()
 *   - SHARE_CONTEXT → 上下文中的 _, console 等
 */

import ejs from 'npm:ejs';
import _ from 'npm:lodash-es';
import YAML from 'npm:yaml';
import info from './info.json' with { type: 'json' };

let pluginEnabled = true;

// ============================================================
// §1 EJS 上下文构建 — 对标 ST-Prompt-Template ejs.ts prepareContext
// ============================================================

/**
 * 构建 EJS 上下文
 *
 * 对标 ST-Prompt-Template prepareContext 中的上下文结构:
 * - variables: STATE.cacheVars getter — 当前变量快照
 * - getvar: getVariable.bind(context) — 用 _.get 读取路径
 * - setvar: setVariable.bind(context) — 用 _.set 写入路径
 * - incvar: increaseVariable.bind(context) — 变量自增
 * - decvar: decreaseVariable.bind(context) — 变量自减
 * - _: lodash
 * - charName, userName, assistantName 等
 *
 * @param {object} statData - 当前 stat_data 对象（MVU 变量）
 * @param {object} arg - chatReplyRequest_t
 * @param {object} prompt_struct - prompt_struct_t（用于提取额外信息）
 * @returns {object} EJS 上下文
 */
function buildEjsContext(statData, arg, prompt_struct) {
	// 变量快照（EJS 渲染期间的临时工作副本）
	const vars = _.cloneDeep(statData || {});

	const charName = arg.Charname || prompt_struct?.Charname || 'Character';
	const userName = arg.UserCharname || prompt_struct?.UserCharname || 'User';

	const context = {
		// ---- 变量系统 (对标 ST-Prompt-Template variables.ts) ----

		// 对标 get variables() { return STATE.cacheVars }
		get variables() { return vars; },
		stat_data: vars,

		// 对标 getvar = getVariable.bind(context)
		// ST-Prompt-Template 中 getVariable 底层用 _.get()
		getvar: (path, defaults) => {
			if (path == null) return vars;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			return _.get(vars, cleanPath, defaults);
		},

		// 对标 setvar = setVariable.bind(context)
		// ST-Prompt-Template 中 setVariable 底层用 _.set()
		// EJS 渲染期间的修改是临时的，不持久化到 chatLog
		setvar: (path, value) => {
			if (path == null) return;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			_.set(vars, cleanPath, value);
			return value;
		},

		// 对标 getLocalVar / setLocalVar / getGlobalVar / setGlobalVar
		// beilu 中没有 local/global 变量分层，统一操作 stat_data
		getLocalVar: (path, defaults) => _.get(vars, path, defaults),
		setLocalVar: (path, value) => { _.set(vars, path, value); return value; },
		getGlobalVar: (path, defaults) => _.get(vars, path, defaults),
		setGlobalVar: (path, value) => { _.set(vars, path, value); return value; },
		getMessageVar: (path, defaults) => _.get(vars, path, defaults),
		setMessageVar: (path, value) => { _.set(vars, path, value); return value; },

		// 对标 incvar = increaseVariable.bind(context)
		incvar: (path, amount = 1) => {
			const cleanPath = String(path).replace(/^stat_data\./, '');
			const current = _.get(vars, cleanPath, 0);
			const newVal = (Number(current) || 0) + (Number(amount) || 1);
			_.set(vars, cleanPath, newVal);
			return newVal;
		},

		// 对标 decvar = decreaseVariable.bind(context)
		decvar: (path, amount = 1) => {
			const cleanPath = String(path).replace(/^stat_data\./, '');
			const current = _.get(vars, cleanPath, 0);
			const newVal = (Number(current) || 0) - (Number(amount) || 1);
			_.set(vars, cleanPath, newVal);
			return newVal;
		},

		// 对标 delvar = removeVariable.bind(context)
		delvar: (path) => {
			if (path == null) return;
			const cleanPath = String(path).replace(/^stat_data\./, '');
			_.unset(vars, cleanPath);
		},

		// ---- 角色/用户信息 (对标 prepareContext) ----
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

		// ---- define 全局定义 (对标 boundedDefine) ----
		define: (name, value) => {
			_.set(context, name, value);
		},

		// ---- 杂项 ----
		// 对标 ST-Prompt-Template execute (slash command)
		execute: async () => '',
		// 对标 substitudeMacros — 在 EJS 内部再次替换宏
		substitudeMacros: (text) => _substituteMacros(text, charName, userName, vars),
	};

	return context;
}

// ============================================================
// §2 宏替换 — 对标 ST-Prompt-Template substituteParams
// ============================================================

/**
 * 替换酒馆宏标记
 *
 * 对标 SillyTavern 的 substituteParams：
 * - {{user}} → 用户名
 * - {{char}} → 角色名
 * - {{currentCharacter}} → 当前角色名（MVU 变量）
 * - {{// comment}} → 移除注释
 *
 * @param {string} text - 原始文本
 * @param {string} charName - 角色名
 * @param {string} userName - 用户名
 * @param {object} vars - 变量对象
 * @returns {string} 替换后的文本
 */
function _substituteMacros(text, charName, userName, vars) {
	if (typeof text !== 'string') return text;
	let result = text;
	result = result.replace(/\{\{user\}\}/gi, userName || '');
	result = result.replace(/\{\{char\}\}/gi, charName || '');
	result = result.replace(/\{\{currentCharacter\}\}/gi, vars?.currentCharacter || charName || '');
	result = result.replace(/\{\{\/\/[^}]*\}\}/g, ''); // 移除注释 {{// ... }}
	return result;
}

// ============================================================
// §3 EJS 渲染 — 对标 ST-Prompt-Template evalTemplate
// ============================================================

/**
 * 渲染单个 EJS 模板
 *
 * 对标 ST-Prompt-Template evalTemplate:
 * 1. 检测 <% 标记 — 无标记则直接返回（跳过无模板内容）
 * 2. 预处理宏替换 ({{user}} 等)
 * 3. 使用 ejs.render() 渲染
 * 4. 错误时返回原文（不崩溃）
 *
 * EJS 选项对标：
 * - async: true（支持 await）
 * - outputFunctionName: 'print'（<% print('text') %> 语法）
 * - _with: true（允许直接使用上下文变量名）
 *
 * @param {string} template - 含 EJS 标记的模板
 * @param {object} context - EJS 上下文
 * @param {string} [where=''] - 错误定位标识
 * @returns {string} 渲染后的文本
 */
function renderEjsTemplate(template, context, where = '') {
	// 对标 evalTemplate: 无 <% 标记时跳过
	if (typeof template !== 'string') return template;
	if (!template.includes('<%')) return template;

	try {
		// 预处理: 替换酒馆宏 — 对标 substituteParams
		const processed = _substituteMacros(
			template,
			context.charName,
			context.userName,
			context.variables,
		);

		// 对标 ST-Prompt-Template evalTemplate 的 ejs.compile 选项
		const result = ejs.render(processed, context, {
			async: false,
			outputFunctionName: 'print',
			rmWhitespace: false,
		});

		return result;
	} catch (e) {
		// 对标 ST-Prompt-Template: 渲染失败时 console.error + 返回原模板
		console.error(`[beilu-ejs] EJS 渲染失败 (${where}):`, e.message);
		if (e.message) {
			// 打印模板片段用于调试（前200字符）
			console.error(`[beilu-ejs] 模板片段:`, template.substring(0, 200));
		}
		return template;
	}
}

// ============================================================
// §4 批量渲染 — 对标 ST-Prompt-Template processGenerateAfter
// ============================================================

/**
 * 遍历 prompt_struct 中所有文本，执行 EJS 渲染
 *
 * 对标 ST-Prompt-Template handler.ts processGenerateAfter:
 * 对每条 prompt 内容执行 EJS 渲染（仅当包含 <% 标记时）
 *
 * 渲染范围:
 * 1. char_prompt.text — 角色描述（世界书 before/after 条目已注入此处）
 * 2. user_prompt.text — 用户人设
 * 3. world_prompt.text — 世界观
 * 4. plugin_prompts.*.text — 各插件提示词
 * 5. other_chars_prompt.*.text — 其他角色
 * 6. chat_log — 聊天记录（世界书 @depth 条目已注入此处）
 *
 * @param {object} prompt_struct - prompt_struct_t
 * @param {object} context - EJS 上下文
 * @returns {{ rendered: number, skipped: number }} 渲染统计
 */
function renderEjsInPromptStruct(prompt_struct, context) {
	let rendered = 0;
	let skipped = 0;

	const renderTextArray = (textArr, source) => {
		if (!Array.isArray(textArr)) return;
		for (const item of textArr) {
			if (typeof item.content !== 'string') continue;
			if (!item.content.includes('<%')) {
				skipped++;
				continue;
			}
			const before = item.content;
			item.content = renderEjsTemplate(item.content, context, source);
			if (item.content !== before) rendered++;
		}
	};

	// 1. char_prompt.text
	renderTextArray(prompt_struct.char_prompt?.text, 'char_prompt');

	// 2. user_prompt.text
	renderTextArray(prompt_struct.user_prompt?.text, 'user_prompt');

	// 3. world_prompt.text
	renderTextArray(prompt_struct.world_prompt?.text, 'world_prompt');

	// 4. plugin_prompts.*.text
	if (prompt_struct.plugin_prompts) {
		for (const [pName, prompt] of Object.entries(prompt_struct.plugin_prompts)) {
			renderTextArray(prompt?.text, `plugin:${pName}`);
		}
	}

	// 5. other_chars_prompt.*.text
	if (prompt_struct.other_chars_prompt) {
		for (const [cName, prompt] of Object.entries(prompt_struct.other_chars_prompt)) {
			renderTextArray(prompt?.text, `other_char:${cName}`);
		}
	}

	// 6. chat_log（世界书 @depth 条目和 MVU 变量 YAML 都在此）
	if (Array.isArray(prompt_struct.chat_log)) {
		for (let i = 0; i < prompt_struct.chat_log.length; i++) {
			const entry = prompt_struct.chat_log[i];
			if (typeof entry.content !== 'string') continue;
			if (!entry.content.includes('<%')) {
				skipped++;
				continue;
			}
			const before = entry.content;
			entry.content = renderEjsTemplate(entry.content, context, `chat_log[${i}]`);
			if (entry.content !== before) rendered++;
		}
	}

	return { rendered, skipped };
}

// ============================================================
// §5 变量源获取
// ============================================================

/**
 * 从 prompt_struct 中获取 MVU 变量数据
 *
 * 查找顺序:
 * 1. beilu-mvu 插件的 extension.mvu_accumulated.stat_data
 * 2. chat_log 中最新的 extension.mvu_variables.stat_data
 *
 * @param {object} prompt_struct - prompt_struct_t
 * @param {object} arg - chatReplyRequest_t
 * @returns {object|null} stat_data 对象或 null
 */
function getVariablesFromContext(prompt_struct, arg) {
	// 方式1: 从 beilu-mvu 的 GetPrompt 返回值读取
	const mvuPrompt = prompt_struct?.plugin_prompts?.['beilu-mvu'];
	const mvuAccumulated = mvuPrompt?.extension?.mvu_accumulated;
	if (mvuAccumulated?.stat_data) {
		return mvuAccumulated.stat_data;
	}

	// 方式2: 从 chatLog 倒序查找
	const chatLog = arg?.chat_log || [];
	for (let i = chatLog.length - 1; i >= 0; i--) {
		const vars = chatLog[i]?.extension?.mvu_variables;
		if (vars?.stat_data && typeof vars.stat_data === 'object') {
			return vars.stat_data;
		}
		// 兼容：变量直接存储在 mvu_variables 中（无 stat_data 层级）
		if (vars && typeof vars === 'object' && Object.keys(vars).length > 0 && !vars.stat_data) {
			return vars;
		}
	}

	return null;
}

// ============================================================
// §6 插件主体
// ============================================================

const pluginExport = {
	info,

	Load: async () => {
		console.log('[beilu-ejs] EJS 模板渲染插件加载中...');
		console.log('[beilu-ejs] EJS 模板渲染插件已加载');
	},

	Unload: async () => {
		console.log('[beilu-ejs] EJS 模板渲染插件已卸载');
	},

	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginEnabled,
			}),

			SetData: async (data) => {
				if (data?.enabled !== undefined) {
					pluginEnabled = !!data.enabled;
					console.log(`[beilu-ejs] 插件${pluginEnabled ? '已启用' : '已禁用'}`);
				}
			},
		},

		chat: {
			/**
			 * GetPrompt — 不产生额外提示词
			 *
			 * beilu-ejs 不需要向 AI 注入自己的内容，
			 * 它只负责渲染其他插件（尤其是 beilu-worldbook）注入的 EJS 模板。
			 */
			GetPrompt: async () => {
				return { text: [], additional_chat_log: [], extension: {} };
			},

			/**
			 * TweakPrompt — EJS 模板渲染
			 *
			 * 执行时机:
			 * - detail_level=2: beilu-worldbook 注入世界书条目
			 * - detail_level=1: beilu-mvu 注入变量 YAML
			 * - detail_level=0: beilu-ejs 执行 EJS 渲染 ← 这里
			 *
			 * 对标: ST-Prompt-Template handler.ts processGenerateAfter
			 *
			 * 流程:
			 * 1. 从 beilu-mvu 的 extension 或 chatLog 获取变量数据
			 * 2. 构建 EJS 上下文（对标 prepareContext）
			 * 3. 遍历 prompt_struct 所有文本执行 EJS 渲染
			 */
			TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
				// 在 detail_level=0 执行（最后一轮，所有注入已完成）
				if (detail_level !== 0 || !pluginEnabled) return;

				// 获取变量数据
				const statData = getVariablesFromContext(prompt_struct, arg);

				// 即使没有 MVU 变量，也可能有纯 EJS 模板（如条件判断、循环等）
				// 此时 statData 为空对象，EJS 模板中的 getvar 会返回 defaults
				const effectiveData = statData || {};

				// 构建 EJS 上下文
				const ejsContext = buildEjsContext(effectiveData, arg, prompt_struct);

				// 执行 EJS 渲染
				const stats = renderEjsInPromptStruct(prompt_struct, ejsContext);

				if (stats.rendered > 0) {
					console.log(`[beilu-ejs] EJS 渲染完成: ${stats.rendered} 个模板已渲染, ${stats.skipped} 个无模板跳过`);
				}
			},
		},
	},
};

export default pluginExport;
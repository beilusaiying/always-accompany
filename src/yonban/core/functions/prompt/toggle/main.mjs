// [yonban T3d 迁移] 实现体从 plugins/beilu-toggle/main.mjs 迁入 functions/prompt/toggle/main.mjs（5 级到 src）。
//   纯搬家零逻辑改动。info.json 留旧位指回；wbStub server 5 级。
//   toggle 数据经 setToggleableEntries/pluginData 按 username keyed（非 import.meta.url），无路径锚需求。
import info from '../../../../../public/parts/plugins/beilu-toggle/info.json' with { type: 'json' };
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { fillInjectText } from "../../injectTexts/main.mjs"; // 注入文本单源（铁律：进 messages 的文本用户可配置，默认值在 injectTexts CATALOG）

// ============================================================
// 常量
// ============================================================

/**
 * AI 回复中的 toggle 标签正则
 * 支持格式：
 *   <toggle type="preset" identifier="main" enabled="true" />
 *   <toggle type="preset" identifier="xxx" enabled="false"/>
 *   <toggle type="worldinfo" entry="条目名" enabled="true" />
 */
const TOGGLE_TAG_REGEX = /<toggle\s+([^>]*?)\/?\s*>/gi;

/**
 * 属性提取正则
 */
const ATTR_REGEX = /(\w+)\s*=\s*"([^"]*)"/g;

// ============================================================
// 插件状态
// ============================================================

/**
 * @type {{
 *   overrides: Record<string, boolean>,   // identifier → enabled
 *   history: Array<{time: number, identifier: string, enabled: boolean, source: string}>,
 * }}
 */
let pluginData = {
	overrides: {},
	history: [],
};

/** 缓存的条目列表（从 beilu-preset 获取） */
let cachedEntries = [];

// ============================================================
// beilu-toggle 插件
// ============================================================

/**
 * beilu-toggle — AI 条目控制
 *
 * 【闭环已接通·20260607】两处断点已修：
 *   ① 条目列表：getToggleableEntries 直接读 beilu-preset GetPrompt extension 的 toggleable_entries
 *      （beilu-preset/main.mjs GetPrompt 暴露 slim 列表），cachedEntries 每轮同步，AI 看得到可控条目。
 *   ② 应用翻转：applyToggle 调 beilu-preset 单例 config.SetData({toggle_entry}) → engine.toggleEntry
 *      + syncActivePresetToConfig，enabled 翻转持久到 active preset，下一轮组装生效。
 *
 * 职责：
 * - 向 AI 注入可控条目列表和 toggle 标签格式说明
 * - 解析 AI 回复中的 <toggle> 标签
 * - 通过 beilu-preset 的 config.SetData 修改条目 enabled 状态
 * - 记录操作历史
 *
 * @returns {import('../../../../../decl/pluginAPI.ts').PluginAPI_t}
 */
export default {
	info,

	Load: async (api) => {
		console.log('[beilu-toggle] 插件加载中...');

		try {
			const saved = await api?.config?.GetData?.();
			if (saved) {
				pluginData = { ...pluginData, ...saved };
				console.log(`[beilu-toggle] 已恢复 ${Object.keys(pluginData.overrides).length} 个 override 状态`);
			}
		} catch (e) {
			wbD(null, "toggle:load", "config_restore_fail", false, "load config failed", { err: e && e.message });
			console.warn('[beilu-toggle] 加载配置失败:', e.message);
		}
	},

	Unload: async () => {
		console.log('[beilu-toggle] 插件卸载');
	},

	interfaces: {
		config: {
			GetData: async () => {
				wbT(null, 'toggle:get', 'getdata_entry', { overrides: Object.keys(pluginData.overrides).length, history: pluginData.history.length });
				return {
					overrides: { ...pluginData.overrides },
					history: [...pluginData.history],
				};
			},

			SetData: async (data, ctx) => {
				if (!wbD(null, 'toggle:set', 'setdata_entry', !!data, 'SetData 收到空 data', null)) return;
				// [T065] manual_toggle 持久到 per-user 预设：username 从 ctx（verb toggleSetData 盖章 context.user）
				const _tgUser = ctx?.username || "";

				if (data.overrides) {
					pluginData.overrides = { ...pluginData.overrides, ...data.overrides };
					wbT(null, 'toggle:set', 'overrides_merged', { count: Object.keys(pluginData.overrides).length });
				}
				if (data.history) {
					pluginData.history = data.history;
					wbT(null, 'toggle:set', 'history_replaced', { len: pluginData.history.length });
				}
				// 手动触发 toggle
				if (data.manual_toggle) {
					const { identifier, enabled } = data.manual_toggle;
					wbT(null, 'toggle:set', 'manual_toggle', { identifier, enabled });
					await applyToggle(identifier, enabled, 'user', _tgUser);
				}
				// 清除所有 override
				if (data.clear_overrides) {
					pluginData.overrides = {};
					pluginData.history = [];
					wbT(null, 'toggle:set', 'clear_overrides', null);
				}
			},
		},

		chat: {
			/**
			 * GetPrompt — 向 AI 注入 toggle 使用说明
			 *
			 * 告诉 AI：
			 * 1. 有哪些可控条目（名称 + identifier + 当前状态）
			 * 2. <toggle> 标签的使用格式
			 * 3. 使用场景和注意事项
			 */
			GetPrompt: (arg) => {
				// ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText（用户可配），操作说明走 INJ 条目。shadowBuild 会检测并隐藏 >200 字符的非宏内容。
				// 尝试从 prompt_struct 的 plugin_prompts 中获取 beilu-preset 的条目信息
				const _chatid = arg && (arg.chat_id != null ? arg.chat_id : arg.chatid) || null;
				wbT(_chatid, "toggle:gate", "getprompt_entry", null);
				const entries = getToggleableEntries(arg);

				if (entries.length === 0) {
					wbT(_chatid, "toggle:gate", "no_entries_skip", null);
					return { text: [], additional_chat_log: [], extension: {} };
				}

				wbT(_chatid, "toggle:gate", "inject_toggle_list", { total: entries.length, enabled: entries.filter(e => e.enabled).length, disabled: entries.filter(e => !e.enabled).length });

				// 构建条目列表文本
				const entryList = entries
					.map(e => `  - [${e.enabled ? '✓' : '✗'}] "${e.name}" (id: ${e.identifier})`)
					.join('\n');

				// 引导块全文走 injectTexts 单源（toggle.system_prompt 键，{entryList} 占位）；
				// 条目列表是数据由代码生成，文字模板归用户可配置域
				const promptText = fillInjectText('toggle.system_prompt', { entryList });

				return {
					text: [{
						content: promptText,
						description: 'toggle 条目控制系统',
						important: false,
					}],
					additional_chat_log: [],
					extension: {},
				};
			},

			/**
			 * ReplyHandler — 解析 AI 回复中的 toggle 标签
			 *
			 * @param {string} reply - AI 回复文本
			 * @param {object} args - { prompt_struct, AddLongTimeLog, ... }
			 * @returns {boolean} 是否修改了回复
			 */
			ReplyHandler: async (reply, args) => {
				if (!reply || !reply.content) return false;

				const toggleActions = parseToggleTags(reply.content);
				if (toggleActions.length === 0) return false;

				// [T065] AI toggle 也需 per-user：username 从 args（reply 流盖章）或 prompt_struct，缺失=_default 桶
				const _tgReplyUser = args?.username || args?.prompt_struct?.username || "";
				const results = [];
				for (const action of toggleActions) {
					const ok = await applyToggle(action.identifier, action.enabled, 'ai', _tgReplyUser);
					results.push({ ...action, success: ok });
				}

				if (args?.AddLongTimeLog) {
					const successActions = results.filter(r => r.success);
					if (successActions.length > 0) {
						args.AddLongTimeLog({
							name: 'beilu-toggle',
							time_stamp: Date.now(),
							role: 'system',
							content: successActions.map(a => `[toggle] ${a.identifier} → ${a.enabled ? '启用' : '禁用'}`).join('\n'),
							files: [],
							extension: { source: 'beilu-toggle', ephemeral: false },
						});
					}
				}

				const cleaned = reply.content.replace(TOGGLE_TAG_REGEX, '').trim();
				if (cleaned !== reply.content) {
					reply.content = cleaned;
				}

				return false;
			},
		},
	},
};

// ============================================================
// 内部函数
// ============================================================

/**
 * 从参数中获取可 toggle 的条目列表
 * @param {object} arg - chatReplyRequest_t 或包含 prompt_struct 的对象
 * @returns {Array}
 */
function getToggleableEntries(arg) {
	// 从 prompt_struct 的 plugin_prompts 读 beilu-preset 暴露的 toggleable_entries（slim 列表）。
	// beilu-preset GetPrompt 的 extension 带 toggleable_entries（见 beilu-preset/main.mjs GetPrompt）。
	const presetExtension = arg?.prompt_struct?.plugin_prompts?.['beilu-preset']?.extension;
	if (presetExtension?.preset_source === 'beilu-preset' && Array.isArray(presetExtension.toggleable_entries)) {
		cachedEntries = presetExtension.toggleable_entries;
	}

	// 用缓存的条目列表（含本轮刚同步的）。叠加本插件 overrides，展示 AI 最新视图。
	if (cachedEntries.length > 0) {
		return cachedEntries
			.filter(e => !e.marker && !e.is_comment && e.has_content && !e.is_builtin)
			.map(e => (e.identifier in pluginData.overrides ? { ...e, enabled: pluginData.overrides[e.identifier] } : e));
	}

	return [];
}

/**
 * 解析 AI 回复中的 toggle 标签
 * @param {string} text
 * @returns {Array<{type: string, identifier: string, enabled: boolean}>}
 */
function parseToggleTags(text) {
	const actions = [];
	let match;

	TOGGLE_TAG_REGEX.lastIndex = 0;
	while ((match = TOGGLE_TAG_REGEX.exec(text)) !== null) {
		const attrString = match[1];
		const attrs = {};

		let attrMatch;
		ATTR_REGEX.lastIndex = 0;
		while ((attrMatch = ATTR_REGEX.exec(attrString)) !== null) {
			attrs[attrMatch[1]] = attrMatch[2];
		}

		// 验证必要属性
		if (!attrs.identifier && !attrs.entry) continue;
		if (attrs.enabled === undefined) continue;

		actions.push({
			type: attrs.type || 'preset',
			identifier: attrs.identifier || attrs.entry,
			enabled: attrs.enabled === 'true' || attrs.enabled === '1',
		});
	}

	// 限制单次最多处理 5 个 toggle
	return actions.slice(0, 5);
}

/**
 * 执行 toggle 操作
 * @param {string} identifier
 * @param {boolean} enabled
 * @param {'ai'|'user'} source
 * @returns {boolean} 是否成功
 */
async function applyToggle(identifier, enabled, source, username) {
	// 记录到 overrides
	if (!wbD(null, "toggle:apply", "apply_entry", !!identifier, "applyToggle empty identifier", { source })) {
		// identifier 为空：不写 overrides（否则写出 overrides[""] 脏键并误报成功），直接拒绝。
		return false;
	}
	wbT(null, "toggle:apply", "apply_entry", { identifier, enabled, source });
	pluginData.overrides[identifier] = enabled;

	// 记录到历史
	pluginData.history.push({
		time: Date.now(),
		identifier,
		enabled,
		source,
	});

	// 限制历史记录条数
	if (pluginData.history.length > 100) {
		pluginData.history = pluginData.history.slice(-50);
		wbT(null, "toggle:apply", "history_trim", { kept: pluginData.history.length });
	}

	console.log(`[beilu-toggle] ${source === 'ai' ? 'AI' : '用户'} toggle: ${identifier} → ${enabled ? '启用' : '禁用'}`);

	// 把 enabled 翻转持久到 beilu-preset：调其 config.SetData({toggle_entry})（内部 engine.toggleEntry + syncActivePresetToConfig）。
	// [T065] beilu-preset 已 per-user（perUserStore），toggle_entry 现在依赖 username——不传则落 _default 桶=改错用户的激活预设。
	//   故把 username 透传进 SetData 的 args.username（同 setData 盖章链）。username 缺省=_default 桶（匿名回退）。
	// 全程 guard：失败只记录、不抛，overrides 已写本插件可作下轮 getToggleableEntries 的展示兜底。
	let _persisted = false;
	try {
		const _presetMod = await import(new URL("../preset/main.mjs", import.meta.url).href);
		const _setData = _presetMod?.default?.interfaces?.config?.SetData;
		if (typeof _setData === "function") {
			await _setData({ toggle_entry: { identifier, enabled } }, { username: username || "" });
			_persisted = true;
		}
	} catch (e) {
		wbD(null, "toggle:apply", "persist_to_preset_fail", false, "调 beilu-preset SetData 失败", { err: e && e.message });
		console.warn(`[beilu-toggle] 持久到 beilu-preset 失败: ${e.message}`);
	}

	wbT(null, "toggle:apply", "applied", { identifier, enabled, persisted: _persisted, overrides: Object.keys(pluginData.overrides).length });

	return true;
}
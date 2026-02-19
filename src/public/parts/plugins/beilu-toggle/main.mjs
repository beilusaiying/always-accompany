import info from './info.json' with { type: 'json' };

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
 * 职责：
 * - 向 AI 注入可控条目列表和 toggle 标签格式说明
 * - 解析 AI 回复中的 <toggle> 标签
 * - 通过 beilu-preset 的 config.SetData 修改条目 enabled 状态
 * - 记录操作历史
 *
 * @returns {import('../../../../src/decl/pluginAPI.ts').PluginAPI_t}
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
			console.warn('[beilu-toggle] 加载配置失败:', e.message);
		}
	},

	Unload: async () => {
		console.log('[beilu-toggle] 插件卸载');
	},

	interfaces: {
		config: {
			GetData: async () => ({
				overrides: { ...pluginData.overrides },
				history: [...pluginData.history],
			}),

			SetData: async (data) => {
				if (!data) return;

				if (data.overrides) {
					pluginData.overrides = { ...pluginData.overrides, ...data.overrides };
				}
				if (data.history) {
					pluginData.history = data.history;
				}
				// 手动触发 toggle
				if (data.manual_toggle) {
					const { identifier, enabled } = data.manual_toggle;
					await applyToggle(identifier, enabled, 'user');
				}
				// 清除所有 override
				if (data.clear_overrides) {
					pluginData.overrides = {};
					pluginData.history = [];
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
				// 尝试从 prompt_struct 的 plugin_prompts 中获取 beilu-preset 的条目信息
				const entries = getToggleableEntries(arg);

				if (entries.length === 0) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				// 构建条目列表文本
				const entryList = entries
					.map(e => `  - [${e.enabled ? '✓' : '✗'}] "${e.name}" (id: ${e.identifier})`)
					.join('\n');

				const promptText = [
					'<toggle_system>',
					'你可以通过在回复中插入 <toggle> 标签来控制预设条目的启用/禁用。',
					'',
					'格式：',
					'  <toggle type="preset" identifier="条目ID" enabled="true或false" />',
					'',
					'当前可控条目列表：',
					entryList,
					'',
					'注意事项：',
					'- toggle 标签会在处理后从回复中移除，用户不会看到',
					'- 修改会在下一轮对话中生效',
					'- 只有在剧情需要时才使用此功能（如切换文风、开启/关闭特定规则）',
					'- 不要频繁切换，一次回复中最多 3 个 toggle',
					'</toggle_system>',
				].join('\n');

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
				if (!reply || typeof reply !== 'string') return false;

				// 查找所有 toggle 标签
				const toggleActions = parseToggleTags(reply);

				if (toggleActions.length === 0) return false;

				// 执行 toggle 操作
				const results = [];
				for (const action of toggleActions) {
					const ok = await applyToggle(action.identifier, action.enabled, 'ai');
					results.push({
						...action,
						success: ok,
					});
				}

				// 记录到聊天日志
				if (args?.AddLongTimeLog) {
					const successActions = results.filter(r => r.success);
					if (successActions.length > 0) {
						const logContent = successActions
							.map(a => `[toggle] ${a.identifier} → ${a.enabled ? '启用' : '禁用'}`)
							.join('\n');

						// 先记录 AI 的 toggle 消息
						args.AddLongTimeLog({
							name: 'beilu-toggle',
							time_stamp: Date.now(),
							role: 'system',
							content: logContent,
							files: [],
							extension: { source: 'beilu-toggle', ephemeral: false },
						});
					}
				}

				// 从回复中移除 toggle 标签
				const cleanedReply = reply.replace(TOGGLE_TAG_REGEX, '').trim();

				// 如果回复被修改了，需要通知框架
				if (cleanedReply !== reply) {
					// 通过修改 reply 内容实现
					// 注意：Fount 的 ReplyHandler 返回 boolean
					// true = 已处理完毕不需要其他 handler
					// false = 继续传递给其他 handler
					// 回复文本的修改通过 args 中的机制实现
					if (args?.updateReply) {
						args.updateReply(cleanedReply);
					}
				}

				return false; // 继续传递给其他 handler
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
	// 尝试从 prompt_struct 的 plugin_prompts 中读取 beilu-preset 的数据
	const presetExtension = arg?.prompt_struct?.plugin_prompts?.['beilu-preset']?.extension;

	if (presetExtension?.preset_source === 'beilu-preset') {
		// 从缓存更新
		// 实际条目列表需要通过其他方式获取（config.GetData）
	}

	// 使用缓存的条目列表
	if (cachedEntries.length > 0) {
		return cachedEntries.filter(e =>
			!e.marker &&
			!e.is_comment &&
			e.has_content &&
			!e.is_builtin
		);
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
async function applyToggle(identifier, enabled, source) {
	// 记录到 overrides
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
	}

	console.log(`[beilu-toggle] ${source === 'ai' ? 'AI' : '用户'} toggle: ${identifier} → ${enabled ? '启用' : '禁用'}`);

	// 注意：实际的 preset 条目修改需要在下一轮 GetPrompt 之前
	// 通过 beilu-preset 的 config.SetData({ toggle_entry: { identifier, enabled } }) 实现
	// 这里先记录状态，在 GetPrompt 阶段应用

	return true;
}

/**
 * 更新缓存的条目列表
 * 由外部调用（如 beilu-chat 或定时刷新）
 * @param {Array} entries
 */
export function updateCachedEntries(entries) {
	cachedEntries = entries || [];
}
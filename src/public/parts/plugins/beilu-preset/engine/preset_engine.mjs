// preset_engine.mjs
// ST 预设引擎 — 处理 SillyTavern 预设格式的加载、排序和提示词构建
// 这是 beilu-preset 的核心引擎

import { evaluateMacros } from './marco.mjs';

// ============================================================
// 常量定义
// ============================================================

/** 12 个 ST 内置 Marker 标识符 */
const BUILTIN_MARKERS = new Set([
	'main', 'nsfw', 'jailbreak', 'chatHistory',
	'worldInfoBefore', 'worldInfoAfter', 'enhanceDefinitions',
	'charDescription', 'charPersonality', 'scenario',
	'personaDescription', 'dialogueExamples'
]);

/** Marker → 宏变量名的映射（用于司令员模式展开 marker 为模块内容） */
const MARKER_MAPPING = {
	charDescription: 'char_prompt',
	charPersonality: 'char_prompt',
	scenario: 'char_prompt',
	personaDescription: 'user_prompt',
	worldInfoBefore: 'world_prompt',
	worldInfoAfter: 'world_prompt',
	dialogueExamples: 'char_prompt',
	chatHistory: '_chat_log',     // 特殊处理：标记聊天历史分割点
	enhanceDefinitions: null,      // 可选增强
};

/** Marker 对应的宏变量名（用于 buildAllEntries 展开） */
const MARKER_TO_MACRO = {
	charDescription: 'char_prompt',
	charPersonality: 'char_personality',
	scenario: 'scenario',
	personaDescription: 'user_prompt',
	worldInfoBefore: 'world_prompt',
	worldInfoAfter: 'world_prompt_after',
	dialogueExamples: 'dialogue_examples',
};

/** ST prompt_order 中的 character_id 常量 */
const SYSTEM_LEVEL_ID = 100000;
const USER_LEVEL_ID = 100001;

// ============================================================
// PresetEngine 类
// ============================================================

/**
 * ST 预设引擎
 *
 * 职责：
 * 1. 解析 ST 预设 JSON（prompts[] + prompt_order[]）
 * 2. 按 prompt_order 排列系统级条目 → 生成 single_part_prompt_t.text[]
 * 3. 按 injection_depth/order 排列用户级条目 → 在 TweakPrompt 阶段注入 chat_log
 * 4. 管理条目的启用/禁用状态
 * 5. 提供条目列表供 UI 展示和 beilu-toggle 操控
 */
export class PresetEngine {

	constructor() {
		/** @type {object|null} 原始预设 JSON */
		this.presetData = null;

		/** @type {Map<string, object>} identifier → prompt entry */
		this.promptEntries = new Map();

		/** @type {Array} prompt_order for character_id: 100000（系统级） */
		this.systemOrder = [];

		/** @type {Array} prompt_order for character_id: 100001（用户级） */
		this.userOrder = [];

		/** @type {object} 提取的模型参数 */
		this.modelParams = {};

		/** @type {string} 预设名称（用于 UI 展示） */
		this.presetName = '';

		/** @type {object} 预设中的特殊提示模板 */
		this.templates = {};
	}

	// --------------------------------------------------------
	// 加载与序列化
	// --------------------------------------------------------

	/**
	 * 加载 ST 预设 JSON 数据
	 * @param {object} presetJson - ST 预设 JSON 对象
	 * @param {string} [name] - 预设名称
	 */
	load(presetJson, name) {
		this.presetData = presetJson;
		this.presetName = name || '未命名预设';

		// 提取模型参数
		this.modelParams = extractModelParams(presetJson);

		// 提取特殊提示模板
		this.templates = {
			impersonation_prompt: presetJson.impersonation_prompt || '',
			new_chat_prompt: presetJson.new_chat_prompt || '',
			new_group_chat_prompt: presetJson.new_group_chat_prompt || '',
			new_example_chat_prompt: presetJson.new_example_chat_prompt || '',
			continue_nudge_prompt: presetJson.continue_nudge_prompt || '',
			group_nudge_prompt: presetJson.group_nudge_prompt || '',
			wi_format: presetJson.wi_format || '{0}',
			scenario_format: presetJson.scenario_format || '{{scenario}}',
			personality_format: presetJson.personality_format || '{{personality}}',
		};

		// 索引所有条目
		this.promptEntries.clear();
		for (const entry of (presetJson.prompts || [])) {
			if (entry.identifier) {
				this.promptEntries.set(entry.identifier, { ...entry });
			}
		}

		// 解析 prompt_order
		this.systemOrder = [];
		this.userOrder = [];
		for (const group of (presetJson.prompt_order || [])) {
			if (group.character_id === SYSTEM_LEVEL_ID) {
				this.systemOrder = (group.order || []).map(o => ({ ...o }));
			} else if (group.character_id === USER_LEVEL_ID) {
				this.userOrder = (group.order || []).map(o => ({ ...o }));
			}
		}

		return this;
	}

	/**
	 * 检查是否已加载预设
	 */
	isLoaded() {
		return this.presetData !== null;
	}

	/**
	 * 导出当前预设状态为 JSON（含修改后的启用状态和模型参数）
	 * @returns {object|null}
	 */
	toJSON() {
		if (!this.presetData) return null;

		const promptOrder = [];
		if (this.systemOrder.length > 0) {
			promptOrder.push({ character_id: SYSTEM_LEVEL_ID, order: this.systemOrder });
		}
		if (this.userOrder.length > 0) {
			promptOrder.push({ character_id: USER_LEVEL_ID, order: this.userOrder });
		}

		// 重建 prompts 数组（包含可能被修改的条目）
		const prompts = [];
		for (const [, entry] of this.promptEntries) {
			prompts.push({ ...entry });
		}

		return {
			...this.presetData,
			prompts,
			prompt_order: promptOrder,
			// 同步模型参数
			temperature: this.modelParams.temperature,
			frequency_penalty: this.modelParams.frequency_penalty,
			presence_penalty: this.modelParams.presence_penalty,
			top_p: this.modelParams.top_p,
			top_k: this.modelParams.top_k,
			top_a: this.modelParams.top_a,
			min_p: this.modelParams.min_p,
			repetition_penalty: this.modelParams.repetition_penalty,
			openai_max_context: this.modelParams.max_context,
			openai_max_tokens: this.modelParams.max_tokens,
			stream_openai: this.modelParams.stream,
			seed: this.modelParams.seed,
		};
	}

	// --------------------------------------------------------
	// 条目查询
	// --------------------------------------------------------

	/**
	 * 获取按 prompt_order 排列的启用条目
	 *
	 * v14.3 修正：分类逻辑改为基于 system_prompt + injection_position
	 * - system 级别（GetPrompt）：
	 *   1. system_prompt: true 的条目（4个内置 + markers）
	 *   2. system_prompt: false 但 injection_position === 0 的用户条目（相对位置 = 系统区域）
	 * - user 级别（TweakPrompt 注入）：
	 *   仅 injection_position === 1 的条目（in-chat injection）
	 *
	 * @param {'system'|'user'} level
	 * @returns {Array<object>} 排好序、启用且有实际内容的条目
	 */
	getEnabledEntries(level) {
		const result = [];

		if (level === 'system') {
			// 系统级：先从 systemOrder 中取，再从 userOrder 中补充
			const seen = new Set();

			for (const orderItem of this.systemOrder) {
				if (!orderItem.enabled) continue;
				const entry = this.promptEntries.get(orderItem.identifier);
				if (!entry) continue;
				if (entry.marker === true) continue;
				if (!entry.content || entry.content.trim() === '') continue;
				if (isCommentOnly(entry.content)) continue;
				seen.add(orderItem.identifier);
				result.push(entry);
			}

			// 从 userOrder 中取：system_prompt=true 或 injection_position===0 的条目
			// 这些都应该放在系统提示词区域（GetPrompt）
			for (const orderItem of this.userOrder) {
				if (!orderItem.enabled) continue;
				if (seen.has(orderItem.identifier)) continue;
				const entry = this.promptEntries.get(orderItem.identifier);
				if (!entry) continue;
				if (entry.marker === true) continue;
				// injection_position === 1 的条目走注入，不在这里
				if ((entry.injection_position ?? 0) === 1) continue;
				if (!entry.content || entry.content.trim() === '') continue;
				if (isCommentOnly(entry.content)) continue;
				result.push(entry);
			}
		} else {
			// 用户级（注入式）：仅 injection_position === 1 的条目
			for (const orderItem of this.userOrder) {
				if (!orderItem.enabled) continue;
				const entry = this.promptEntries.get(orderItem.identifier);
				if (!entry) continue;
				if (entry.marker === true) continue;
				// 只取 injection_position === 1（in-chat injection）
				if ((entry.injection_position ?? 0) !== 1) continue;
				if (!entry.content || entry.content.trim() === '') continue;
				if (isCommentOnly(entry.content)) continue;
				result.push(entry);
			}
		}

		return result;
	}

	/**
	 * 获取所有条目的完整列表（用于 UI 展示）
	 * @returns {Array<object>}
	 */
	getAllEntries() {
		const result = [];
		const seen = new Set();

		// 优先使用用户级排序（包含所有条目的完整列表）
		for (const orderItem of this.userOrder) {
			const entry = this.promptEntries.get(orderItem.identifier);
			if (!entry) continue;
			seen.add(orderItem.identifier);

			result.push(formatEntryForUI(entry, orderItem.enabled));
		}

		// 补充未在用户级排序中出现的条目
		for (const [id, entry] of this.promptEntries) {
			if (seen.has(id)) continue;

			// 检查系统级排序中的启用状态
			const sysOrder = this.systemOrder.find(o => o.identifier === id);
			const enabled = sysOrder ? sysOrder.enabled : false;

			result.push(formatEntryForUI(entry, enabled));
		}

		return result;
	}

	/**
	 * 根据 identifier 获取单个条目
	 * @param {string} identifier
	 * @returns {object|undefined}
	 */
	getEntry(identifier) {
		return this.promptEntries.get(identifier);
	}

	// --------------------------------------------------------
	// 条目修改（供 beilu-toggle 和 UI 使用）
	// --------------------------------------------------------

	/**
	 * 切换条目启用/禁用
	 * @param {string} identifier
	 * @param {boolean} enabled
	 * @returns {boolean} 是否找到并修改成功
	 */
	toggleEntry(identifier, enabled) {
		// 确认条目存在于 promptEntries 中
		if (!this.promptEntries.has(identifier)) {
			return false;
		}

		let foundInUser = false;
		let foundInSystem = false;

		for (const item of this.userOrder) {
			if (item.identifier === identifier) {
				item.enabled = enabled;
				foundInUser = true;
				break;
			}
		}

		// 同时更新系统级（双份保险）
		for (const item of this.systemOrder) {
			if (item.identifier === identifier) {
				item.enabled = enabled;
				foundInSystem = true;
			}
		}

		// 兜底：条目存在于 promptEntries 但不在任何 order 中
		// 将其插入到 userOrder 末尾
		if (!foundInUser && !foundInSystem) {
			this.userOrder.push({ identifier, enabled });
		}

		return true;
	}

	/**
	 * 批量切换条目
	 * @param {Array<{identifier: string, enabled: boolean}>} changes
	 * @returns {number} 成功修改的数量
	 */
	batchToggle(changes) {
		let count = 0;
		for (const { identifier, enabled } of changes) {
			if (this.toggleEntry(identifier, enabled)) count++;
		}
		return count;
	}

	/**
	 * 修改条目内容
	 * @param {string} identifier
	 * @param {string} newContent
	 * @returns {boolean}
	 */
	updateEntryContent(identifier, newContent) {
		const entry = this.promptEntries.get(identifier);
		if (!entry) return false;
		entry.content = newContent;
		return true;
	}

	/**
	 * 新增条目
	 * @param {object} entryData - 条目数据（至少需要 identifier）
	 * @returns {boolean} 是否成功
	 */
	addEntry(entryData) {
		if (!entryData?.identifier) return false;

		// 如果已存在同 identifier 的条目，拒绝添加
		if (this.promptEntries.has(entryData.identifier)) return false;

		// 构建完整条目（用默认值填充缺失字段）
		const entry = {
			...entryData,
			identifier: entryData.identifier,
			name: entryData.name || entryData.identifier,
			system_prompt: entryData.system_prompt ?? true,
			role: entryData.role || 'system',
			content: entryData.content || '',
			marker: false,
			enabled: entryData.enabled ?? true,
			injection_position: entryData.injection_position ?? 0,
			injection_depth: entryData.injection_depth ?? 4,
			injection_order: entryData.injection_order ?? 100,
			injection_trigger: entryData.injection_trigger || [],
			forbid_overrides: entryData.forbid_overrides ?? false,
		};

		// 添加到 promptEntries
		this.promptEntries.set(entry.identifier, entry);

		// 添加到 userOrder 末尾
		this.userOrder.push({
			identifier: entry.identifier,
			enabled: entry.enabled,
		});

		// 如果是系统级条目，也添加到 systemOrder
		if (entry.system_prompt) {
			this.systemOrder.push({
				identifier: entry.identifier,
				enabled: entry.enabled,
			});
		}

		return true;
	}

	/**
	 * 删除条目
	 * @param {string} identifier
	 * @returns {boolean} 是否成功（内置 Marker 不允许删除）
	 */
	deleteEntry(identifier) {
		if (!identifier) return false;

		// 内置 Marker 不允许删除
		if (BUILTIN_MARKERS.has(identifier)) return false;

		// 从 promptEntries 中移除
		if (!this.promptEntries.delete(identifier)) return false;

		// 从 userOrder 中移除
		this.userOrder = this.userOrder.filter(o => o.identifier !== identifier);

		// 从 systemOrder 中移除
		this.systemOrder = this.systemOrder.filter(o => o.identifier !== identifier);

		return true;
	}

	/**
	 * 修改条目属性（role, injection_depth 等）
	 * @param {string} identifier
	 * @param {object} updates
	 * @returns {boolean}
	 */
	updateEntryProps(identifier, updates) {
		const entry = this.promptEntries.get(identifier);
		if (!entry) return false;

		const allowedKeys = [
			'role', 'injection_depth', 'injection_order',
			'injection_position', 'name', 'forbid_overrides',
			'system_prompt'
		];

		for (const key of allowedKeys) {
			if (key in updates) {
				entry[key] = updates[key];
			}
		}

		return true;
	}

	// --------------------------------------------------------
	// 提示词构建（核心功能）
	// --------------------------------------------------------

	/**
	 * 构建系统级提示词（用于 Plugin.GetPrompt）
	 *
	 * 将系统级（prompt_order character_id=100000）中启用的非 Marker 条目
	 * 按顺序排列，执行宏替换后返回 single_part_prompt_t
	 *
	 * @param {object} env - 宏替换环境 { user, char, group, model, ... }
	 * @param {object} memory - 宏替换记忆 { variables, globalVariables }
	 * @param {Array} chatLog - 聊天记录（供宏引用）
	 * @returns {object} single_part_prompt_t
	 */
	buildSystemPrompts(env, memory, chatLog) {
		const entries = this.getEnabledEntries('system');
		const textParts = [];

		for (const entry of entries) {
			let content = entry.content;

			// 宏替换
			try {
				content = evaluateMacros(content, env, memory, chatLog);
			} catch (e) {
				console.warn(`[beilu-preset] 宏替换失败 (${entry.name}):`, e.message);
			}

			textParts.push({
				content,
				description: entry.name || entry.identifier,
				important: isImportantEntry(entry),
			});
		}

		return {
			text: textParts,
			additional_chat_log: [],
			extension: {
				preset_source: 'beilu-preset',
				preset_name: this.presetName,
				model_params: { ...this.modelParams },
			},
		};
	}

	/**
	 * 构建注入式条目列表（用于 Plugin.TweakPrompt）
	 *
	 * 将用户级（prompt_order character_id=100001）中启用的条目
	 * 按 injection_depth + injection_order 排序，执行宏替换
	 *
	 * @param {object} env
	 * @param {object} memory
	 * @param {Array} chatLog
	 * @returns {Array<object>} 注入条目列表
	 */
	buildInjectionEntries(env, memory, chatLog) {
		const entries = this.getEnabledEntries('user');
		const injections = [];

		for (const entry of entries) {
			let content = entry.content;

			try {
				content = evaluateMacros(content, env, memory, chatLog);
			} catch (e) {
				console.warn(`[beilu-preset] 宏替换失败 (${entry.name}):`, e.message);
			}

			injections.push({
				content,
				role: entry.role || 'system',
				name: entry.name || entry.identifier,
				identifier: entry.identifier,
				depth: entry.injection_depth ?? 0,
				order: entry.injection_order ?? 100,
			});
		}

		// 排序：按 depth 升序，同 depth 按 order 升序
		injections.sort((a, b) => {
			if (a.depth !== b.depth) return a.depth - b.depth;
			return a.order - b.order;
		});

		return injections;
	}

	/**
	 * 将注入式条目插入到聊天记录中
	 *
	 * 按 injection_depth 从大到小处理（避免插入导致索引偏移）
	 * depth=0 → 插入到最末尾（最新消息之后）
	 * depth=N → 从末尾往前数 N 条处插入
	 *
	 * @param {Array} chatLog - prompt_struct.chat_log（原地修改）
	 * @param {Array} injections - buildInjectionEntries 的结果
	 */
	injectIntoChatLog(chatLog, injections) {
		// 按 depth 从大到小排序
		const sorted = [...injections].sort((a, b) => b.depth - a.depth);

		for (const injection of sorted) {
			const insertIdx = Math.max(0, chatLog.length - injection.depth);

			chatLog.splice(insertIdx, 0, {
				name: injection.name,
				time_stamp: Date.now(),
				role: injection.role,
				content: injection.content,
				files: [],
				extension: {
					source: 'beilu-preset-injection',
					identifier: injection.identifier,
					ephemeral: true,  // 标记为临时注入，不持久化到聊天记录
				},
			});
		}
	}

	/**
	 * 根据新的 identifier 顺序重建 userOrder
	 * @param {Array<string>} newOrder - 新的 identifier 顺序
	 * @returns {boolean}
	 */
	reorderEntries(newOrder) {
		if (!Array.isArray(newOrder) || newOrder.length === 0) return false;

		// 构建 identifier → 现有 orderItem 的映射
		const userMap = new Map();
		for (const item of this.userOrder) {
			userMap.set(item.identifier, item);
		}
		const sysMap = new Map();
		for (const item of this.systemOrder) {
			sysMap.set(item.identifier, item);
		}

		// 按新顺序重建 userOrder
		const newUserOrder = [];
		for (const id of newOrder) {
			if (userMap.has(id)) {
				newUserOrder.push(userMap.get(id));
			} else if (sysMap.has(id)) {
				// 条目在 systemOrder 但不在 userOrder，创建对应项
				newUserOrder.push({ identifier: id, enabled: sysMap.get(id).enabled });
			} else if (this.promptEntries.has(id)) {
				// 条目存在但不在任何 order 中
				newUserOrder.push({ identifier: id, enabled: false });
			}
		}

		// 补充 newOrder 中没有但 userOrder 中有的条目（保留在末尾）
		for (const item of this.userOrder) {
			if (!newOrder.includes(item.identifier)) {
				newUserOrder.push(item);
			}
		}

		this.userOrder = newUserOrder;
		return true;
	}

	// --------------------------------------------------------
	// 司令员模式：统一构建所有条目
	// --------------------------------------------------------

	/**
	 * 构建所有预设条目的统一消息序列（司令员模式核心方法）
	 *
	 * 合并 systemOrder 和 userOrder 为单一序列，按 prompt_order 顺序处理所有 enabled 条目。
	 * 每个条目生成一条消息 {role, content, identifier, name, order}。
	 * Marker 条目展开为对应的宏变量内容。
	 *
	 * chatHistory marker 作为分割点：
	 * - beforeChat: chatHistory 之前的条目（头部预设，使用条目自身 role，默认 system）
	 * - afterChat: chatHistory 之后的条目（尾部预设，使用条目自身 role，默认 system）
	 * - injectionAbove: injection_position=1 且 depth>=1 的条目（聊天记录上方，可选 role）
	 * - injectionBelow: injection_position=1 且 depth=0 的条目（聊天记录下方，可选 role）
	 *
	 * 实际发送顺序 = beforeChat + injectionAbove + 聊天记录 + injectionBelow + afterChat
	 *
	 * @param {object} env - 宏替换环境（需包含 char_prompt, user_prompt, world_prompt 等模块内容）
	 * @param {object} memory - 宏替换记忆
	 * @param {Array} chatLog - 聊天记录（供宏引用）
	 * @returns {{ beforeChat: Array<object>, afterChat: Array<object>, injectionAbove: Array<object>, injectionBelow: Array<object> }}
	 *   - beforeChat: chatHistory marker 之前的预设区条目（使用条目自身 role，默认 system）
	 *   - afterChat: chatHistory marker 之后的预设区条目（使用条目自身 role，默认 system）
	 *   - injectionAbove: depth>=1 的注入条目（聊天记录上方，可选 role）
	 *   - injectionBelow: depth=0 的注入条目（聊天记录下方，可选 role）
	 */
	buildAllEntries(env, memory, chatLog) {
		const beforeChat = [];
		const afterChat = [];
		const injectionAbove = [];  // @D>=1: 聊天记录上方
		const injectionBelow = [];  // @D=0: 聊天记录下方
		const seen = new Set();

		// 标记 chatHistory 分割点是否已遇到
		let chatHistorySeen = false;

		// 合并两个序列：先 userOrder（包含完整排列），再补充 systemOrder 中遗漏的
		const mergedOrder = [];
		for (const item of this.userOrder) {
			mergedOrder.push(item);
			seen.add(item.identifier);
		}
		for (const item of this.systemOrder) {
			if (!seen.has(item.identifier)) {
				mergedOrder.push(item);
				seen.add(item.identifier);
			}
		}

		for (const orderItem of mergedOrder) {
			if (!orderItem.enabled) continue;
			const entry = this.promptEntries.get(orderItem.identifier);
			if (!entry) continue;

			// 处理 Marker 条目
			if (entry.marker === true) {
				// chatHistory marker：标记分割点，不生成内容
				if (entry.identifier === 'chatHistory') {
					chatHistorySeen = true;
					continue;
				}

				const macroName = MARKER_TO_MACRO[entry.identifier];
				if (!macroName) continue; // 其他无内容的 marker 跳过

				const macroContent = env[macroName];
				if (!macroContent || (typeof macroContent === 'string' && macroContent.trim() === '')) continue;

				// Marker 展开的条目放入当前区域（chatHistory 前/后），role 强制 system
				const msg = {
					role: 'system',
					content: typeof macroContent === 'string' ? macroContent : String(macroContent),
					identifier: entry.identifier,
					name: entry.name || entry.identifier,
					is_marker: true,
					order: entry.injection_order ?? 100,
				};
				(chatHistorySeen ? afterChat : beforeChat).push(msg);
				continue;
			}

			// 普通条目：检查是否有实际内容
			if (!entry.content || entry.content.trim() === '') continue;
			if (isCommentOnly(entry.content)) continue;

			// 宏替换
			let content = entry.content;
			try {
				content = evaluateMacros(content, env, memory, chatLog);
			} catch (e) {
				console.warn(`[beilu-preset] 宏替换失败 (${entry.name}):`, e.message);
			}

			// 跳过替换后为空的条目
			if (!content || content.trim() === '') continue;

			// 判断条目位置：injection_position=1 → 注入式；否则 → 预设区（system only）
			const isInjection = (entry.injection_position ?? 0) === 1;
			const depth = isInjection ? (entry.injection_depth ?? 0) : null;

			if (isInjection) {
				// 注入条目：可选 role
				const msg = {
					role: entry.role || 'system',
					content,
					identifier: entry.identifier,
					name: entry.name || entry.identifier,
					order: entry.injection_order ?? 100,
					depth,
				};

				if (depth >= 1) {
					// @D>=1: 聊天记录上方
					injectionAbove.push(msg);
				} else {
					// @D=0: 聊天记录下方
					injectionBelow.push(msg);
				}
			} else {
				// 预设条目：使用条目自身的 role（默认 system）
				const msg = {
					role: entry.role || 'system',
					content,
					identifier: entry.identifier,
					name: entry.name || entry.identifier,
					order: entry.injection_order ?? 100,
				};
				// 根据 chatHistory 分割点放入前区或后区
				(chatHistorySeen ? afterChat : beforeChat).push(msg);
			}
		}

		// 注入式条目按 order 排序（同一区域内）
		injectionAbove.sort((a, b) => a.order - b.order);
		injectionBelow.sort((a, b) => a.order - b.order);

		return { beforeChat, afterChat, injectionAbove, injectionBelow };
	}

	// --------------------------------------------------------
	// 正则脚本
	// --------------------------------------------------------

	/**
	 * 获取预设中的正则脚本列表
	 * @returns {Array}
	 */
	getRegexScripts() {
		return this.presetData?.extensions?.regex_scripts || [];
	}

	/**
	 * 获取启用的正则脚本
	 * @returns {Array}
	 */
	getActiveRegexScripts() {
		return this.getRegexScripts().filter(s => !s.disabled);
	}
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 从 ST 预设 JSON 中提取模型参数
 * @param {object} json
 * @returns {object}
 */
function extractModelParams(json) {
	return {
		temperature: json.temperature ?? 1,
		frequency_penalty: json.frequency_penalty ?? 0,
		presence_penalty: json.presence_penalty ?? 0,
		top_p: json.top_p ?? 1,
		top_k: json.top_k ?? 0,
		top_a: json.top_a ?? 0,
		min_p: json.min_p ?? 0,
		repetition_penalty: json.repetition_penalty ?? 1,
		max_context: json.openai_max_context ?? 4096,
		max_tokens: json.openai_max_tokens ?? 2048,
		stream: json.stream_openai ?? true,
		seed: json.seed ?? -1,
		n: json.n ?? 1,
		// API 行为参数
		names_behavior: json.names_behavior ?? 0,
		wrap_in_quotes: json.wrap_in_quotes ?? false,
		max_context_unlocked: json.max_context_unlocked ?? false,
		squash_system_messages: json.squash_system_messages ?? false,
		// 高级参数
		function_calling: json.function_calling ?? false,
		show_thoughts: json.show_thoughts ?? false,
		reasoning_effort: json.reasoning_effort ?? 'auto',
		image_inlining: json.image_inlining ?? false,
		continue_prefill: json.continue_prefill ?? false,
	};
}

/**
 * 判断内容是否为纯 ST 注释
 * ST 注释语法：{{// ... }}（整条内容都是注释则跳过）
 * @param {string} content
 * @returns {boolean}
 */
function isCommentOnly(content) {
	if (!content) return true;
	const stripped = content.replace(/\{\{\/\/[\s\S]*?\}\}/g, '').trim();
	return stripped.length === 0;
}

/**
 * 判断条目是否为重要条目（影响 Fount 的 important 标记）
 * @param {object} entry
 * @returns {boolean}
 */
function isImportantEntry(entry) {
	const id = entry.identifier;
	return id === 'main' || id === 'jailbreak' || id === 'nsfw';
}

/**
 * 格式化条目为 UI 展示格式
 * @param {object} entry
 * @param {boolean} enabled
 * @returns {object}
 */
function formatEntryForUI(entry, enabled) {
	return {
		identifier: entry.identifier,
		name: entry.name || entry.identifier,
		role: entry.role || 'system',
		enabled: !!enabled,
		system_prompt: !!entry.system_prompt,
		marker: !!entry.marker,
		injection_position: entry.injection_position ?? 0,  // v14.3: 传给前端用于分类显示
		injection_depth: entry.injection_depth ?? 0,
		injection_order: entry.injection_order ?? 100,
		content_length: entry.content ? entry.content.length : 0,
		content_preview: entry.content ? entry.content.substring(0, 120) : '',
		has_content: !!(entry.content && entry.content.trim()),
		is_comment: entry.content ? isCommentOnly(entry.content) : true,
		is_builtin: BUILTIN_MARKERS.has(entry.identifier),
		forbid_overrides: !!entry.forbid_overrides,
	};
}

// ============================================================
// 宏环境构建工具（供 main.mjs 调用）
// ============================================================

/**
 * 从 Fount 的 prompt_struct 构建宏替换所需的环境变量
 * @param {object} promptStruct - Fount prompt_struct_t
 * @returns {object} 宏替换 env
 */
export function buildMacroEnv(promptStruct) {
	const chatLog = promptStruct.chat_log || [];
	return {
		user: promptStruct.UserCharname || 'User',
		char: promptStruct.Charname || 'Character',
		group: '',
		model: '',
		lastMessage: findLastContent(chatLog, null),
		lastUserMessage: findLastContent(chatLog, 'user'),
		lastCharMessage: findLastContent(chatLog, 'assistant'),
		// ST 需要的其他环境变量由 evaluateMacros 内部处理默认值
	};
}

/**
 * 构建默认的宏记忆对象
 * @returns {object}
 */
export function buildDefaultMemory() {
	return {
		variables: {},
		globalVariables: {},
	};
}

/**
 * 在聊天记录中查找最后一条指定角色的消息内容
 * @param {Array} chatLog
 * @param {string|null} role - null 表示任意角色
 * @returns {string}
 */
function findLastContent(chatLog, role) {
	if (!chatLog || chatLog.length === 0) return '';
	for (let i = chatLog.length - 1; i >= 0; i--) {
		const msg = chatLog[i];
		// 跳过临时注入的消息
		if (msg.extension?.ephemeral) continue;
		if (role === null || msg.role === role) {
			return msg.content || '';
		}
	}
	return '';
}

// ============================================================
// 导出常量（供其他模块使用）
// ============================================================

export { BUILTIN_MARKERS, MARKER_MAPPING, SYSTEM_LEVEL_ID, USER_LEVEL_ID };


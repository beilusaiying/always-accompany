// st_import.mjs
// ST 预设导入/导出工具
// 处理 SillyTavern 预设 JSON 文件的验证、清洗和格式转换

import { BUILTIN_MARKERS, SYSTEM_LEVEL_ID, USER_LEVEL_ID } from './preset_engine.mjs';

// ============================================================
// 导入功能
// ============================================================

/**
 * 验证并导入 ST 预设 JSON
 *
 * @param {string|object} input - JSON 字符串或已解析的对象
 * @param {string} [fileName] - 文件名（用于提取预设名称）
 * @returns {{ success: boolean, data?: object, name?: string, error?: string, warnings?: string[] }}
 */
export function importSTPreset(input, fileName) {
	const warnings = [];

	// 1. 解析 JSON
	let json;
	if (typeof input === 'string') {
		try {
			json = JSON.parse(input);
		} catch (e) {
			return { success: false, error: `JSON 解析失败: ${e.message}` };
		}
	} else if (typeof input === 'object' && input !== null) {
		json = input;
	} else {
		return { success: false, error: '输入必须是 JSON 字符串或对象' };
	}

	// 2. 验证基本结构
	const validation = validateSTPreset(json);
	if (!validation.valid) {
		return { success: false, error: validation.error };
	}
	warnings.push(...validation.warnings);

	// 3. 清洗和标准化
	const cleaned = cleanPresetData(json, warnings);

	// 4. 提取预设名称
	const name = extractPresetName(json, fileName);

	return {
		success: true,
		data: cleaned,
		name,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

/**
 * 验证 ST 预设 JSON 的基本结构
 * @param {object} json
 * @returns {{ valid: boolean, error?: string, warnings: string[] }}
 */
function validateSTPreset(json) {
	const warnings = [];

	// 必须有 prompts 数组
	if (!json.prompts) {
		return { valid: false, error: '缺少 prompts 字段', warnings };
	}
	if (!Array.isArray(json.prompts)) {
		return { valid: false, error: 'prompts 必须是数组', warnings };
	}

	// prompts 不能为空
	if (json.prompts.length === 0) {
		warnings.push('prompts 数组为空，预设没有任何条目');
	}

	// 每个条目必须有 identifier
	let missingId = 0;
	for (const entry of json.prompts) {
		if (!entry.identifier) {
			missingId++;
		}
	}
	if (missingId > 0) {
		warnings.push(`${missingId} 个条目缺少 identifier，将被跳过`);
	}

	// prompt_order 不是必须的，但缺少会影响排序
	if (!json.prompt_order) {
		warnings.push('缺少 prompt_order，条目将按原始顺序排列');
	} else if (!Array.isArray(json.prompt_order)) {
		warnings.push('prompt_order 格式异常，将使用默认排序');
	}

	// 模型参数检查
	if (json.temperature === undefined) {
		warnings.push('未指定 temperature，将使用默认值 1');
	}

	return { valid: true, warnings };
}

/**
 * 清洗和标准化预设数据
 * @param {object} json
 * @param {string[]} warnings
 * @returns {object}
 */
function cleanPresetData(json, warnings) {
	const cleaned = { ...json };

	// 清洗 prompts：确保每个条目有必要的字段
	// D4.2: 透传策略 — 先保留原始条目的所有字段，再覆盖我们需要确保的字段
	cleaned.prompts = [];
	for (const entry of (json.prompts || [])) {
		if (!entry.identifier) continue;

		// system_prompt 判定逻辑（v14.3 修正）：
		// 直接保留 ST 原始 JSON 中的 system_prompt 字段值
		// ST 中 system_prompt: true 仅标记4个内置系统默认条目（main/nsfw/jailbreak/enhanceDefinitions + markers）
		// 用户创建的条目统一为 system_prompt: false，无论 injection_position 是 0 还是 1
		// injection_position 决定的是条目在 prompt 中的位置方式（相对/注入），不是 system_prompt 的分类

		cleaned.prompts.push({
			...entry,  // D4.2: 先展开原始条目的所有字段（包含未知字段）
			// 再覆盖我们需要确保存在/标准化的字段
			identifier: entry.identifier,
			name: entry.name || entry.identifier,
			system_prompt: entry.system_prompt ?? false,  // 直接保留原值，默认 false
			role: entry.role || 'system',
			content: entry.content || '',
			marker: entry.marker ?? false,
			enabled: entry.enabled ?? true,
			injection_position: entry.injection_position ?? 0,
			injection_depth: entry.injection_depth ?? 4,
			injection_order: entry.injection_order ?? 100,
			injection_trigger: entry.injection_trigger || [],
			forbid_overrides: entry.forbid_overrides ?? false,
		});
	}

	// 清洗 prompt_order：如果缺少则自动生成
	if (!cleaned.prompt_order || !Array.isArray(cleaned.prompt_order)) {
		cleaned.prompt_order = generateDefaultOrder(cleaned.prompts);
		warnings.push('已自动生成 prompt_order');
	} else {
		// 验证 prompt_order 中的引用是否有效
		const validIds = new Set(cleaned.prompts.map(p => p.identifier));
		for (const group of cleaned.prompt_order) {
			if (group.order) {
				const before = group.order.length;
				group.order = group.order.filter(o => validIds.has(o.identifier));
				const removed = before - group.order.length;
				if (removed > 0) {
					warnings.push(`prompt_order 中移除了 ${removed} 个无效引用`);
				}
			}
		}
	}

	// 确保正则脚本格式正确
	if (cleaned.extensions?.regex_scripts) {
		cleaned.extensions.regex_scripts = cleaned.extensions.regex_scripts.map(script => ({
			id: script.id || crypto.randomUUID?.() || `regex_${Date.now()}`,
			scriptName: script.scriptName || '未命名脚本',
			findRegex: script.findRegex || '',
			replaceString: script.replaceString || '',
			trimStrings: script.trimStrings || [],
			placement: script.placement || [2],
			disabled: script.disabled ?? false,
			markdownOnly: script.markdownOnly ?? false,
			promptOnly: script.promptOnly ?? false,
			runOnEdit: script.runOnEdit ?? true,
			substituteRegex: script.substituteRegex ?? 0,
			minDepth: script.minDepth ?? null,
			maxDepth: script.maxDepth ?? null,
		}));
	}

	return cleaned;
}

/**
 * 为缺少 prompt_order 的预设自动生成排序
 * @param {Array} prompts
 * @returns {Array}
 */
function generateDefaultOrder(prompts) {
	const systemEntries = [];
	const userEntries = [];

	for (const entry of prompts) {
		const orderItem = {
			identifier: entry.identifier,
			enabled: entry.enabled ?? !entry.marker,
		};

		if (entry.system_prompt) {
			systemEntries.push(orderItem);
		}
		// 所有条目都放入用户级（完整列表）
		userEntries.push({ ...orderItem });
	}

	const result = [];
	if (systemEntries.length > 0) {
		result.push({ character_id: SYSTEM_LEVEL_ID, order: systemEntries });
	}
	if (userEntries.length > 0) {
		result.push({ character_id: USER_LEVEL_ID, order: userEntries });
	}

	return result;
}

/**
 * 从文件名或预设内容中提取名称
 * @param {object} json
 * @param {string} [fileName]
 * @returns {string}
 */
function extractPresetName(json, fileName) {
	// 优先使用文件名
	if (fileName) {
		// 去掉扩展名和路径
		let name = fileName.replace(/\\/g, '/');
		const lastSlash = name.lastIndexOf('/');
		if (lastSlash >= 0) name = name.substring(lastSlash + 1);
		const dotIdx = name.lastIndexOf('.');
		if (dotIdx > 0) name = name.substring(0, dotIdx);
		// 去掉 (1), (2) 等副本后缀
		name = name.replace(/\s*\(\d+\)\s*$/, '').trim();
		if (name) return name;
	}

	// 尝试从条目中找名称线索
	const mainEntry = json.prompts?.find(p => p.identifier === 'main');
	if (mainEntry?.name && mainEntry.name !== 'Main Prompt') {
		return mainEntry.name;
	}

	return '导入的预设';
}

// ============================================================
// 导出功能
// ============================================================

/**
 * 将预设数据导出为 ST 兼容的 JSON 字符串
 * @param {object} presetJson - 预设引擎的 toJSON() 结果
 * @param {object} [options]
 * @param {boolean} [options.pretty=true] - 是否美化输出
 * @param {boolean} [options.includeDisabled=true] - 是否包含禁用条目
 * @returns {string}
 */
export function exportSTPreset(presetJson, options = {}) {
	const { pretty = true, includeDisabled = true } = options;

	const exported = { ...presetJson };

	// D4.1: 从 prompt_order 同步 enabled 状态到 prompts[]
	// prompt_order 是运行时启用/禁用的权威来源，prompts[] 中的 enabled 可能过时
	const enabledMap = new Map();
	for (const group of (exported.prompt_order || [])) {
		for (const item of (group.order || [])) {
			if (item.identifier) {
				// 用户级 prompt_order 优先（后写入覆盖系统级）
				enabledMap.set(item.identifier, !!item.enabled);
			}
		}
	}

	// 同步到每个 prompt 条目
	if (exported.prompts) {
		for (const prompt of exported.prompts) {
			if (enabledMap.has(prompt.identifier)) {
				prompt.enabled = enabledMap.get(prompt.identifier);
			}
		}
	}

	// 如果不包含禁用条目，过滤掉
	if (!includeDisabled) {
		const enabledIds = new Set();

		for (const [id, enabled] of enabledMap) {
			if (enabled) enabledIds.add(id);
		}

		// 内置 Marker 始终保留
		for (const marker of BUILTIN_MARKERS) {
			enabledIds.add(marker);
		}

		exported.prompts = (exported.prompts || []).filter(
			p => enabledIds.has(p.identifier) || p.marker
		);
	}

	return pretty
		? JSON.stringify(exported, null, 4)
		: JSON.stringify(exported);
}

/**
 * 生成预设的摘要信息
 * @param {object} presetJson
 * @returns {object}
 */
export function getPresetSummary(presetJson) {
	const prompts = presetJson.prompts || [];

	let enabledCount = 0;
	let disabledCount = 0;
	let markerCount = 0;
	let systemCount = 0;
	let userCount = 0;
	let totalContentLength = 0;

	for (const entry of prompts) {
		if (entry.marker) {
			markerCount++;
		} else {
			if (entry.system_prompt) systemCount++;
			else userCount++;

			totalContentLength += (entry.content || '').length;
		}
	}

	// 从 prompt_order 中统计启用数
	for (const group of (presetJson.prompt_order || [])) {
		for (const item of (group.order || [])) {
			if (item.enabled) enabledCount++;
			else disabledCount++;
		}
	}

	const regexScripts = presetJson.extensions?.regex_scripts || [];

	return {
		total_entries: prompts.length,
		markers: markerCount,
		system_entries: systemCount,
		user_entries: userCount,
		enabled_in_order: enabledCount,
		disabled_in_order: disabledCount,
		total_content_chars: totalContentLength,
		regex_scripts: regexScripts.length,
		active_regex_scripts: regexScripts.filter(s => !s.disabled).length,
		model_params: {
			temperature: presetJson.temperature,
			top_p: presetJson.top_p,
			top_k: presetJson.top_k,
			max_context: presetJson.openai_max_context,
			max_tokens: presetJson.openai_max_tokens,
		},
	};
}

// ============================================================
// 预设合并工具
// ============================================================

/**
 * 将一个预设的条目合并到另一个预设中
 * 用于从多个预设中组合条目
 *
 * @param {object} basePreset - 基础预设
 * @param {object} sourcePreset - 要合并的预设
 * @param {object} [options]
 * @param {boolean} [options.overwriteExisting=false] - 是否覆盖已有同 ID 条目
 * @param {boolean} [options.mergeRegex=true] - 是否合并正则脚本
 * @returns {object} 合并后的预设
 */
export function mergePresets(basePreset, sourcePreset, options = {}) {
	const { overwriteExisting = false, mergeRegex = true } = options;
	const merged = JSON.parse(JSON.stringify(basePreset));

	const existingIds = new Set(merged.prompts.map(p => p.identifier));

	// 合并条目
	for (const entry of (sourcePreset.prompts || [])) {
		if (!entry.identifier) continue;

		if (existingIds.has(entry.identifier)) {
			if (overwriteExisting) {
				const idx = merged.prompts.findIndex(p => p.identifier === entry.identifier);
				if (idx >= 0) merged.prompts[idx] = { ...entry };
			}
			// 不覆盖则跳过
		} else {
			merged.prompts.push({ ...entry });
			existingIds.add(entry.identifier);

			// 将新条目添加到用户级 prompt_order 末尾
			const userGroup = merged.prompt_order?.find(g => g.character_id === USER_LEVEL_ID);
			if (userGroup?.order) {
				userGroup.order.push({
					identifier: entry.identifier,
					enabled: false, // 默认禁用，由用户手动启用
				});
			}
		}
	}

	// 合并正则脚本
	if (mergeRegex) {
		if (!merged.extensions) merged.extensions = {};
		if (!merged.extensions.regex_scripts) merged.extensions.regex_scripts = [];

		const existingScriptNames = new Set(
			merged.extensions.regex_scripts.map(s => s.scriptName)
		);

		for (const script of (sourcePreset.extensions?.regex_scripts || [])) {
			if (!existingScriptNames.has(script.scriptName)) {
				merged.extensions.regex_scripts.push({ ...script });
			}
		}
	}

	return merged;
}
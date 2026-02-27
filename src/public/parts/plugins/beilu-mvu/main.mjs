/**
 * beilu-mvu — MVU 变量系统插件
 *
 * 兼容目标：
 *   - JS-Slash-Runner (酒馆助手) 的变量存储格式 (chat[].variables[swipeId])
 *   - MVU 变量累积、初始化、命令解析、持久化
 *
 * 功能：
 *   1. GetPrompt: 从 chatLog 累积变量 → 通过 extension 传递
 *   2. TweakPrompt: 变量 YAML 注入 chat_log
 *   3. ReplyHandler: 解析 AI 输出中的变量更新命令 → 持久化到 extension
 *
 * 注意：EJS 模板渲染由独立的 beilu-ejs 插件处理
 */

import _ from 'npm:lodash-es';
import YAML from 'npm:yaml';
import info from './info.json' with { type: 'json' };

let pluginEnabled = true;

// ============================================================
// §1 变量累积 — 对标 ST-Prompt-Template precacheVariables
// ============================================================

/**
 * 从 chatLog 中找到最新的变量状态
 *
 * 对标 JS-Slash-Runner 的 chat[].variables[swipe_id]
 * 在 beilu 中存储于 chatLogEntry.extension.mvu_variables
 *
 * @param {Array} chatLog - beilu chatLog 数组
 * @returns {object|null} { stat_data: {...} } 或 null
 */
function accumulateVariables(chatLog) {
	for (let i = chatLog.length - 1; i >= 0; i--) {
		const vars = chatLog[i]?.extension?.mvu_variables;
		if (vars && typeof vars === 'object' && Object.keys(vars).length > 0) {
			return _.cloneDeep(vars);
		}
	}
	return null;
}

// ============================================================
// §2 变量初始化 — 对标 ST-Prompt-Template initial-variables
// ============================================================

/**
 * 从世界书读取 [InitVar] 条目并解析 YAML
 *
 * 对标酒馆中的 [InitialVariables] / [InitVar] 世界书条目
 * 条目特征：comment 或 key 中包含 [InitVar]，条目通常是 disabled 状态
 *
 * @param {object} arg - chatReplyRequest_t
 * @returns {Promise<object|null>} { stat_data: {...} } 或 null
 */
async function initFromWorldBook(arg) {
	const wbPlugin = arg.plugins?.['beilu-worldbook'];
	if (!wbPlugin?.interfaces?.config?.GetData) return null;

	try {
		const wbData = await wbPlugin.interfaces.config.GetData();
		const entries = wbData.entries || [];

		for (const entry of entries) {
			const commentMatch = (entry.comment || '').toLowerCase().includes('[initvar]');
			const keyMatch = Array.isArray(entry.key) &&
				entry.key.some(k => (k || '').toLowerCase().includes('[initvar]'));

			if (!commentMatch && !keyMatch) continue;

			const content = entry.content;
			if (!content || typeof content !== 'string') continue;

			try {
				const parsed = YAML.parse(content);
				if (parsed && typeof parsed === 'object') {
					console.log('[beilu-mvu] InitVar 条目解析成功，变量结构:', Object.keys(parsed).join(', '));
					return { stat_data: parsed };
				}
			} catch (yamlErr) {
				console.error('[beilu-mvu] InitVar YAML 解析失败:', yamlErr.message);
			}
		}
	} catch (err) {
		console.error('[beilu-mvu] 读取世界书失败:', err.message);
	}

	return null;
}

// ============================================================
// §3 JSON Patch — 严格对标 ST-Prompt-Template json-patch.ts
// ============================================================

/**
 * 将 JSON Pointer (RFC 6901) 转换为 lodash 路径数组
 *
 * 对标 ST-Prompt-Template convertJsonPointerToLodashPath
 * @see https://tools.ietf.org/html/rfc6901
 *
 * @param {string} pointer - JSON Pointer 字符串 (如 "/a/b/0")
 * @returns {string[]} lodash 路径数组 (如 ['a', 'b', '0'])
 */
function convertJsonPointerToLodashPath(pointer) {
	if (typeof pointer !== 'string') {
		throw new Error('Path must be a string.');
	}
	if (pointer === '') return [];
	if (pointer.charAt(0) !== '/') {
		throw new Error('Invalid JSON Pointer: must start with "/".');
	}
	// RFC 6901: ~1 → /, ~0 → ~
	return pointer.substring(1).split('/').map(segment =>
		segment.replace(/~1/g, '/').replace(/~0/g, '~')
	);
}

/**
 * 应用 JSON Patch (RFC 6902)
 *
 * 严格对标 ST-Prompt-Template jsonPatch 函数
 * 支持: add, replace, remove, move, copy, test, set, assign
 *
 * @param {object} doc - 原始文档
 * @param {Array} patches - RFC 6902 操作数组
 * @returns {object} 应用补丁后的新文档
 */
function applyJsonPatch(doc, patches) {
	const newDoc = _.cloneDeep(doc);

	for (const patch of patches) {
		const { op, path, value } = patch;
		const fromPath = patch.from ? convertJsonPointerToLodashPath(patch.from) : undefined;
		const lodashPath = convertJsonPointerToLodashPath(path);

		switch (op) {
			// 对标 ST-Prompt-Template: 同时支持 set/assign 别名
			case 'set':
			case 'assign':
			case 'add':
			case 'replace': {
				const lastSegment = lodashPath[lodashPath.length - 1];
				if (lastSegment === '-') {
					// 数组末尾追加: /path/to/array/-
					const parentPath = lodashPath.slice(0, -1);
					const parent = _.get(newDoc, parentPath);
					if (Array.isArray(parent)) {
						parent.push(value);
					} else {
						console.warn(`[beilu-mvu] jsonPatch: Cannot push to non-array at: ${parentPath.join('.')}`);
					}
				} else {
					_.set(newDoc, lodashPath, value);
				}
				break;
			}

			case 'remove': {
				if (!_.unset(newDoc, lodashPath)) {
					console.warn(`[beilu-mvu] jsonPatch: Path "${path}" could not be removed.`);
				}
				break;
			}

			case 'move': {
				const valueToMove = _.get(newDoc, fromPath);
				if (_.isUndefined(valueToMove)) {
					console.error(`[beilu-mvu] jsonPatch: Cannot move from non-existent path: "${patch.from}"`);
					break;
				}
				// 对标 ST-Prompt-Template: remove *before* set
				_.unset(newDoc, fromPath);
				_.set(newDoc, lodashPath, valueToMove);
				break;
			}

			case 'copy': {
				const valueToCopy = _.get(newDoc, fromPath);
				if (_.isUndefined(valueToCopy)) {
					console.error(`[beilu-mvu] jsonPatch: Cannot copy from non-existent path: "${patch.from}"`);
					break;
				}
				_.set(newDoc, lodashPath, _.cloneDeep(valueToCopy));
				break;
			}

			case 'test': {
				const existingValue = _.get(newDoc, lodashPath);
				if (!_.isEqual(existingValue, value)) {
					console.warn(`[beilu-mvu] jsonPatch: Test failed at "${path}"`);
				}
				break;
			}

			default:
				console.warn(`[beilu-mvu] jsonPatch: Unsupported operation: "${op}"`);
		}
	}

	return newDoc;
}

// ============================================================
// §4 变量命令解析 — 对标 JS-Slash-Runner Mvu.parseMessage
// ============================================================

/**
 * 从 AI 输出中解析变量更新命令
 *
 * 支持三种格式:
 * 1. _.set('path', value) — MVU 原始格式
 * 2. <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable> — 主要格式
 * 3. 独立 <JSONPatch>[...]</JSONPatch>
 *
 * @param {string} content - AI 原始输出
 * @param {object} currentState - 当前变量状态 { stat_data: {...} }
 * @returns {{ newState: object, hasChanges: boolean }}
 */
function parseVariableCommands(content, currentState) {
	let newState = _.cloneDeep(currentState);
	let hasChanges = false;

	if (!newState.stat_data) newState.stat_data = {};

	// 格式1: _.set('path', value) — 对标 mvuPolyfill.mjs
	const setRegex = /_.set\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\s\S]+?)\s*\)/g;
	let match;
	while ((match = setRegex.exec(content)) !== null) {
		let path = match[1];
		const valueStr = match[2].trim();

		// 移除 stat_data. 前缀
		path = path.replace(/^stat_data\./, '');

		try {
			const value = JSON.parse(valueStr);
			_.set(newState.stat_data, path, value);
			hasChanges = true;
		} catch {
			// 非合法 JSON，尝试作为字符串处理（去除引号）
			let value = valueStr;
			if ((value.startsWith("'") && value.endsWith("'")) ||
				(value.startsWith('"') && value.endsWith('"'))) {
				value = value.slice(1, -1);
			}
			_.set(newState.stat_data, path, value);
			hasChanges = true;
		}
	}

	// 格式2 & 3: <JSONPatch>[...]</JSONPatch>
	// 对标 ST-Prompt-Template json-patch.ts
	const patchRegex = /<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/g;
	while ((match = patchRegex.exec(content)) !== null) {
		try {
			const patches = JSON.parse(match[1]);
			if (Array.isArray(patches) && patches.length > 0) {
				newState.stat_data = applyJsonPatch(newState.stat_data, patches);
				hasChanges = true;
			}
		} catch (e) {
			console.error('[beilu-mvu] JSONPatch 解析失败:', e.message);
		}
	}

	return { newState, hasChanges };
}

// ============================================================
// §5 content_for_show — 隐藏变量命令
// ============================================================

/**
 * 生成 content_for_show，隐藏变量更新命令
 *
 * 需要隐藏:
 * - <UpdateVariable>...</UpdateVariable> 整块（含 <Analysis> 和 <JSONPatch>）
 * - 独立 <JSONPatch>...</JSONPatch>
 * - _.set(...) 命令
 *
 * @param {string} content - AI 原始输出
 * @returns {string} 清理后的显示内容
 */
function hideVariableCommands(content) {
	let cleaned = content;
	// 隐藏 <UpdateVariable>...</UpdateVariable>
	cleaned = cleaned.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, '');
	// 隐藏独立 <JSONPatch>...</JSONPatch>
	cleaned = cleaned.replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/g, '');
	// 隐藏 _.set(...) 命令
	cleaned = cleaned.replace(/_.set\s*\(\s*['"][^'"]+['"]\s*,\s*[\s\S]+?\s*\)\s*/g, '');
	// 清理多余空行
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
	return cleaned;
}

// ============================================================
// §6 插件主体
// ============================================================

const pluginExport = {
	info,

	Load: async ({ router }) => {
		console.log('[beilu-mvu] MVU 变量系统插件加载中...');

		// 注册 HTTP API 端点
		router.get('/api/parts/plugins\\:beilu-mvu/config/getdata', async (req, res) => {
			try {
				const data = await pluginExport.interfaces.config.GetData();
				res.json(data);
			} catch (err) {
				console.error('[beilu-mvu] GetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		router.post('/api/parts/plugins\\:beilu-mvu/config/setdata', async (req, res) => {
			try {
				await pluginExport.interfaces.config.SetData(req.body);
				res.json({ success: true });
			} catch (err) {
				console.error('[beilu-mvu] SetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		console.log('[beilu-mvu] MVU 变量系统插件已加载');
	},

	Unload: async () => {
		console.log('[beilu-mvu] MVU 变量系统插件已卸载');
	},

	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginEnabled,
			}),

			SetData: async (data) => {
				if (data?.enabled !== undefined) {
					pluginEnabled = !!data.enabled;
					console.log(`[beilu-mvu] 插件${pluginEnabled ? '已启用' : '已禁用'}`);
				}
			},
		},

		chat: {
			/**
			 * GetPrompt — 从 chatLog 累积变量，必要时初始化
			 *
			 * 返回值通过 extension.mvu_accumulated 传递给 TweakPrompt
			 * 不在此处注入文本 — 文本注入由 TweakPrompt 完成
			 */
			GetPrompt: async (arg) => {
				if (!pluginEnabled) return { text: [], additional_chat_log: [], extension: {} };

				const chatLog = arg.chat_log || [];

				// 1. 累积变量 — 对标 precacheVariables
				let currentState = accumulateVariables(chatLog);

				// 2. 无变量时从世界书初始化 — 对标 initial-variables.ts
				if (!currentState) {
					currentState = await initFromWorldBook(arg);
					if (currentState && chatLog.length > 0) {
						// 写入第一条消息的 extension（随 chatLog 持久化）
						chatLog[0].extension = chatLog[0].extension || {};
						chatLog[0].extension.mvu_variables = currentState;
						console.log('[beilu-mvu] 变量已初始化并写入第一条消息');
					}
				}

				if (!currentState?.stat_data) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				// 通过 extension 传递给 TweakPrompt，不在此处注入文本
				return {
					text: [],
					additional_chat_log: [],
					extension: {
						mvu_accumulated: currentState,
					},
				};
			},

			/**
				 * TweakPrompt — 变量 YAML 注入
				 *
				 * 执行时机:
				 * - detail_level=2: beilu-worldbook 注入世界书条目
				 * - detail_level=1: beilu-mvu 注入变量 YAML ← 这里
				 * - detail_level=0: beilu-ejs 执行 EJS 渲染
				 *
				 * 对标: JS-Slash-Runner setExtensionPrompt (at depth)
				 */
				TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
					// 在 detail_level=1 执行（世界书在 detail_level=2 已注入完毕）
					if (detail_level !== 1 || !pluginEnabled) return;
	
					const currentState = my_prompt?.extension?.mvu_accumulated;
					if (!currentState?.stat_data) {
						console.log('[beilu-mvu] TweakPrompt: 无变量数据，跳过 YAML 注入');
						return;
					}
	
					// 注入变量 YAML 到 chat_log (at depth)
					const yamlText = YAML.stringify(currentState.stat_data);
					const depth = 4;
					if (prompt_struct.chat_log && Array.isArray(prompt_struct.chat_log)) {
						const insertIndex = Math.max(0, prompt_struct.chat_log.length - depth);
						prompt_struct.chat_log.splice(insertIndex, 0, {
							role: 'system',
							content: `<status_current_variables>\n${yamlText}</status_current_variables>`,
							name: 'mvu_variables',
							extension: { ephemeral: true },
						});
						console.log('[beilu-mvu] YAML 变量已注入 chat_log, 位置:', insertIndex, ', 变量 keys:', Object.keys(currentState.stat_data).join(', '));
					}
				},

			/**
			 * ReplyHandler — 解析 AI 输出中的变量更新命令
			 *
			 * 对标:
			 * - JS-Slash-Runner Mvu.parseMessage (_.set 格式)
			 * - ST-Prompt-Template json-patch.ts (JSONPatch 格式)
			 *
			 * 更新后的完整变量状态写入 result.extension.mvu_variables
			 * 通过 content_for_show 隐藏变量命令
			 *
			 * @returns {boolean} false — 不触发重新生成
			 */
			ReplyHandler: (result, request) => {
				if (!pluginEnabled) return false;

				const content = result.content;
				if (!content || typeof content !== 'string') return false;

				// 获取当前变量状态
				const currentState = accumulateVariables(request.chat_log);
				if (!currentState) return false;

				// 解析变量更新命令
				const { newState, hasChanges } = parseVariableCommands(content, currentState);

				if (!hasChanges) return false;

				// 写入完整的更新后状态到 result.extension
				// BuildChatLogEntryFromCharReply 会将 result.extension 持久化
				result.extension = result.extension || {};
				result.extension.mvu_variables = newState;

				// 生成 content_for_show — 隐藏变量命令
				result.content_for_show = hideVariableCommands(content);

				console.log('[beilu-mvu] 变量已更新并持久化');

				return false; // 不触发重新生成
			},
		},
	},
};

export default pluginExport;
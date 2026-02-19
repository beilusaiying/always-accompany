import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// ST 枚举常量（内联，消除对 Fount 内部 charData.mjs 的依赖）
const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 };

// 注意: GetActivedWorldInfoEntries 仍依赖 Fount 内部模块
// 路径: 从 plugins/beilu-worldbook/ 退两级到 parts/，再进入 ImportHandlers/
// 如果 Fount 更新重构了 ImportHandlers 路径，需要同步调整
import { GetActivedWorldInfoEntries } from '../../ImportHandlers/SillyTavern/engine/world_info.mjs';
import info from './info.json' with { type: 'json' };

// ============================================================
// 持久化
// ============================================================

const __pluginDir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__pluginDir, 'config_data.json');

function saveConfigToDisk() {
	try {
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf-8');
	} catch (e) {
		console.warn('[beilu-worldbook] 保存配置到磁盘失败:', e.message);
	}
}

function loadConfigFromDisk() {
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
		}
	} catch (e) {
		console.warn('[beilu-worldbook] 从磁盘读取配置失败:', e.message);
	}
	return null;
}

// ============================================================
// 插件状态
// ============================================================

/**
 * 配置数据结构（多世界书）
 * @type {{
 *   active_worldbook: string,
 *   worldbooks: Object<string, {
 *     entries: Object<string, WorldInfoEntry>
 *   }>
 * }}
 */
let configData = {
	active_worldbook: '',
	worldbooks: {},
};

/**
 * 创建一个空的 WorldInfoEntry
 * @param {number} uid
 * @returns {object}
 */
function createBlankEntry(uid) {
	return {
		uid,
		key: [],
		keysecondary: [],
		comment: '',
		content: '',
		constant: false,
		vectorized: false,
		selective: true,
		selectiveLogic: 0,
		addMemo: true,
		order: 100,
		position: 0,
		disable: false,
		ignoreBudget: false,
		excludeRecursion: false,
		preventRecursion: false,
		delayUntilRecursion: false,
		probability: 100,
		useProbability: true,
		depth: 4,
		group: '',
		groupOverride: false,
		groupWeight: 100,
		scanDepth: null,
		caseSensitive: null,
		matchWholeWords: null,
		useGroupScoring: null,
		automationId: '',
		role: null,
		sticky: 0,
		cooldown: 0,
		delay: 0,
		triggers: [],
		displayIndex: uid,
		outletName: '',
		characterFilter: { isExclude: false, names: [], tags: [] },
	};
}

/**
 * 获取当前激活世界书的 entries 对象（用于 UI 编辑）
 * @returns {object|null}
 */
function getActiveEntries() {
	const wb = configData.worldbooks[configData.active_worldbook];
	return wb?.entries || null;
}

/**
 * 获取当前激活世界书的 entries 数组（用于 UI 编辑）
 * @returns {Array}
 */
function getActiveEntriesArray() {
	const entries = getActiveEntries();
	if (!entries) return [];
	return Object.values(entries).sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
}

/**
 * 获取所有启用的世界书的条目（用于 GetPrompt）
 * @param {string} [currentCharName=''] - 当前角色名，用于过滤角色绑定的世界书
 * @returns {Array} 所有启用世界书中的非禁用条目
 */
function getAllEnabledEntries(currentCharName = '') {
	const allEntries = [];
	for (const [name, wb] of Object.entries(configData.worldbooks)) {
		if (wb.enabled === false) continue;
		// 如果世界书绑定了角色，只对该角色生效
		if (wb.boundCharName && currentCharName && wb.boundCharName !== currentCharName) continue;
		if (!wb.entries) continue;
		for (const entry of Object.values(wb.entries)) {
			if (!entry.disable) allEntries.push(entry);
		}
	}
	return allEntries;
}

/**
 * 计算下一个可用的 uid
 * @param {object} entries
 * @returns {number}
 */
function getNextUid(entries) {
	if (!entries || Object.keys(entries).length === 0) return 0;
	const maxUid = Math.max(...Object.values(entries).map(e => e.uid || 0));
	return maxUid + 1;
}

// ============================================================
// beilu-worldbook 插件
// ============================================================

const pluginExport = {
	info,

	Load: async ({ router }) => {
		console.log('[beilu-worldbook] 插件加载中...');

		// 从磁盘恢复数据
		try {
			const saved = loadConfigFromDisk();
			if (saved?.worldbooks) {
				configData = {
					active_worldbook: saved.active_worldbook || '',
					worldbooks: saved.worldbooks || {},
				};
				// 数据迁移：为旧世界书添加 enabled 和 boundCharName 字段
				for (const [name, wb] of Object.entries(configData.worldbooks)) {
					if (wb.enabled === undefined) wb.enabled = true;
					if (wb.boundCharName === undefined) wb.boundCharName = '';
				}
				const count = Object.keys(configData.worldbooks).length;
				const active = configData.active_worldbook;
				const activeEntryCount = getActiveEntries() ? Object.keys(getActiveEntries()).length : 0;
				console.log(`[beilu-worldbook] 已恢复 ${count} 个世界书, 激活: "${active}" (${activeEntryCount} 条目)`);
			} else {
				console.log('[beilu-worldbook] 无已保存世界书，等待导入');
			}
		} catch (e) {
			console.warn('[beilu-worldbook] 加载配置失败:', e.message);
		}

		// ---- 注册 HTTP API 端点 ----
		router.get('/api/parts/plugins\\:beilu-worldbook/config/getdata', async (req, res) => {
			try {
				const data = await pluginExport.interfaces.config.GetData();
				res.json(data);
			} catch (err) {
				console.error('[beilu-worldbook] GetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		router.post('/api/parts/plugins\\:beilu-worldbook/config/setdata', async (req, res) => {
			try {
				await pluginExport.interfaces.config.SetData(req.body);
				res.json({ success: true });
			} catch (err) {
				console.error('[beilu-worldbook] SetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});
	},

	Unload: async () => {
		console.log('[beilu-worldbook] 插件卸载');
	},

	interfaces: {
		config: {
			/**
			 * 获取插件配置数据
			 */
			GetData: async () => {
				const entries = getActiveEntriesArray();
				// 构建世界书列表（含 enabled/boundCharName 信息）
				const worldbook_details = {};
				for (const [name, wb] of Object.entries(configData.worldbooks)) {
					worldbook_details[name] = {
						enabled: wb.enabled !== false,
						boundCharName: wb.boundCharName || '',
						entry_count: wb.entries ? Object.keys(wb.entries).length : 0,
					};
				}
				return {
					active_worldbook: configData.active_worldbook,
					worldbook_list: Object.keys(configData.worldbooks),
					worldbook_details,
					entry_count: entries.length,
					entries: entries,
				};
			},

			/**
			 * 设置插件配置
			 *
			 * 支持的操作：
			 * - import_worldbook: 导入 ST 世界书 JSON
			 * - switch_worldbook: 切换激活世界书
			 * - delete_worldbook: 删除指定世界书
			 * - rename_worldbook: 重命名世界书
			 * - create_worldbook: 新建空白世界书
			 * - toggle_entry: 切换条目启用/禁用
			 * - update_entry: 修改条目属性
			 * - add_entry: 新增条目
			 * - delete_entry: 删除条目
			 * - reorder_entries: 重排序条目
			 */
			SetData: async (data) => {
				if (!data) return;

				// 导入世界书
					if (data.import_worldbook) {
						const { json, name, boundCharName } = data.import_worldbook;
						if (json?.entries) {
							configData.worldbooks[name] = {
								entries: json.entries,
								enabled: true,
								boundCharName: boundCharName || '',
							};
							configData.active_worldbook = name;
							const count = Object.keys(json.entries).length;
							console.log(`[beilu-worldbook] 世界书已导入: "${name}" (${count} 条目${boundCharName ? ', 绑定: ' + boundCharName : ''})`);
						}
					}

				// 切换激活世界书
				if (data.switch_worldbook) {
					const { name } = data.switch_worldbook;
					if (configData.worldbooks[name]) {
						configData.active_worldbook = name;
						console.log(`[beilu-worldbook] 已切换到世界书: "${name}"`);
					}
				}

				// 删除世界书
				if (data.delete_worldbook) {
					const { name } = data.delete_worldbook;
					if (configData.worldbooks[name]) {
						delete configData.worldbooks[name];
						console.log(`[beilu-worldbook] 已删除世界书: "${name}"`);
						// 如果删除的是当前激活的，自动切换到其他世界书
						if (name === configData.active_worldbook) {
							const remaining = Object.keys(configData.worldbooks);
							configData.active_worldbook = remaining.length > 0 ? remaining[0] : '';
							console.log(`[beilu-worldbook] 已自动切换到: "${configData.active_worldbook || '(无)'}"`)
						}
					}
				}

				// 重命名世界书
				if (data.rename_worldbook) {
					const { old_name, new_name } = data.rename_worldbook;
					if (configData.worldbooks[old_name] && !configData.worldbooks[new_name]) {
						configData.worldbooks[new_name] = configData.worldbooks[old_name];
						delete configData.worldbooks[old_name];
						if (configData.active_worldbook === old_name) {
							configData.active_worldbook = new_name;
						}
						console.log(`[beilu-worldbook] 世界书已重命名: "${old_name}" → "${new_name}"`);
					}
				}

				// 新建空白世界书
				if (data.create_worldbook) {
					const { name } = data.create_worldbook;
					if (!name) {
						console.warn('[beilu-worldbook] create_worldbook: 缺少名称');
					} else if (configData.worldbooks[name]) {
						console.warn(`[beilu-worldbook] 世界书 "${name}" 已存在`);
					} else {
						configData.worldbooks[name] = { entries: {}, enabled: true, boundCharName: '' };
						if (!configData.active_worldbook) {
							configData.active_worldbook = name;
						}
						console.log(`[beilu-worldbook] 空白世界书已创建: "${name}"`);
					}
				}

				// 启用/禁用世界书
				if (data.toggle_worldbook) {
					const { name, enabled } = data.toggle_worldbook;
					if (configData.worldbooks[name]) {
						configData.worldbooks[name].enabled = !!enabled;
						console.log(`[beilu-worldbook] 世界书 "${name}" 已${enabled ? '启用' : '禁用'}`);
					}
				}

				// 绑定世界书到角色
				if (data.bind_worldbook) {
					const { name, charName } = data.bind_worldbook;
					if (configData.worldbooks[name]) {
						configData.worldbooks[name].boundCharName = charName || '';
						console.log(`[beilu-worldbook] 世界书 "${name}" ${charName ? '已绑定到角色: ' + charName : '已解除角色绑定'}`);
					}
				}

				// 按角色名清理绑定的世界书（删除角色卡时调用）
				if (data.removeByChar) {
					const { charName } = data.removeByChar;
					if (charName) {
						const toRemove = [];
						for (const [name, wb] of Object.entries(configData.worldbooks)) {
							if (wb.boundCharName === charName) toRemove.push(name);
						}
						for (const name of toRemove) {
							delete configData.worldbooks[name];
							if (configData.active_worldbook === name) {
								const remaining = Object.keys(configData.worldbooks);
								configData.active_worldbook = remaining.length > 0 ? remaining[0] : '';
							}
						}
						if (toRemove.length > 0) {
							console.log(`[beilu-worldbook] 已清理角色 "${charName}" 绑定的 ${toRemove.length} 个世界书: ${toRemove.join(', ')}`);
						}
					}
				}

				// 切换条目启用/禁用
				if (data.toggle_entry) {
					const { uid, disabled } = data.toggle_entry;
					const entries = getActiveEntries();
					if (entries) {
						const key = String(uid);
						if (entries[key]) {
							entries[key].disable = disabled;
						}
					}
				}

				// 修改条目
				if (data.update_entry) {
					const { uid, props } = data.update_entry;
					const entries = getActiveEntries();
					if (entries && props) {
						const key = String(uid);
						if (entries[key]) {
							// 逐个字段更新，防止覆盖整个条目
							for (const [prop, value] of Object.entries(props)) {
								entries[key][prop] = value;
							}
						}
					}
				}

				// 新增条目
				if (data.add_entry) {
					const entries = getActiveEntries();
					if (entries) {
						const uid = getNextUid(entries);
						const newEntry = createBlankEntry(uid);
						// 合并自定义属性
						if (data.add_entry.props) {
							Object.assign(newEntry, data.add_entry.props);
							newEntry.uid = uid; // 确保 uid 不被覆盖
						}
						entries[String(uid)] = newEntry;
						console.log(`[beilu-worldbook] 新条目已添加: uid=${uid}`);
					}
				}

				// 删除条目
				if (data.delete_entry) {
					const { uid } = data.delete_entry;
					const entries = getActiveEntries();
					if (entries) {
						const key = String(uid);
						if (entries[key]) {
							delete entries[key];
							console.log(`[beilu-worldbook] 条目已删除: uid=${uid}`);
						}
					}
				}

				// 重排序条目（更新 displayIndex）
				if (data.reorder_entries) {
					const { order } = data.reorder_entries; // order: uid[]
					const entries = getActiveEntries();
					if (entries && Array.isArray(order)) {
						order.forEach((uid, index) => {
							const key = String(uid);
							if (entries[key]) {
								entries[key].displayIndex = index;
							}
						});
					}
				}

				// 持久化到磁盘
				saveConfigToDisk();
			},
		},

		chat: {
			/**
			 * GetPrompt — 将所有启用的世界书条目构建为提示词
			 *
			 * 常驻条目（constant=true）直接注入
			 * 关键词匹配条目由 world_info.mjs 引擎处理
			 * 支持多世界书并行：遍历所有 enabled=true 且角色匹配的世界书
			 *
			 * @param {object} arg - chatReplyRequest_t
			 * @returns {object} single_part_prompt_t
			 */
			GetPrompt: (arg) => {
				const currentCharName = arg?.Charname || '';
				const entryArray = getAllEnabledEntries(currentCharName);
				if (entryArray.length === 0) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				// 将 ST 格式的 key/keysecondary 转换为引擎期望的格式
				const wiEntries = entryArray.map(e => ({
					...e,
					keys: Array.isArray(e.key) ? [...e.key] : (e.key ? [e.key] : []),
					secondary_keys: Array.isArray(e.keysecondary) ? [...e.keysecondary] : (e.keysecondary ? [e.keysecondary] : []),
					enabled: !e.disable,
					extensions: {
						position: e.position,
						role: e.role ?? extension_prompt_roles.SYSTEM,
						selectiveLogic: e.selectiveLogic ?? 0,
						case_sensitive: e.caseSensitive,
						match_whole_words: e.matchWholeWords,
						exclude_recursion: e.excludeRecursion,
						prevent_recursion: e.preventRecursion,
						delay_until_recursion: e.delayUntilRecursion ? 1 : 0,
						delay: e.delay,
						sticky: e.sticky,
						cooldown: e.cooldown,
						useProbability: e.useProbability,
						probability: e.probability,
					},
				}));

				// 构建环境变量
				const chatLog = arg.chat_log || [];
				const env = {
					user: arg.UserCharname || 'User',
					char: arg.Charname || 'Character',
				};

				// 使用聊天级别的内存
				const memory = arg.extension?.worldbook_memory || {};

				try {
					// 调用 ST 世界书激活引擎
					const activated = GetActivedWorldInfoEntries(wiEntries, chatLog, env, memory);

					// 保存内存状态
					if (arg.extension) {
						arg.extension.worldbook_memory = memory;
					}

					if (activated.length === 0) {
						return { text: [], additional_chat_log: [], extension: {} };
					}

					// 按 position 分类构建提示词
					const textEntries = [];
					const chatLogInjections = [];
					const charInjections = []; // before/after 角色描述的条目
	
					for (const entry of activated) {
						const pos = entry.extensions?.position ?? entry.position ?? world_info_position.before;
						const role = entry.extensions?.role ?? extension_prompt_roles.SYSTEM;
						const depth = entry.depth ?? 4;
						const order = entry.order ?? 100;
	
						const roleMap = {
							[extension_prompt_roles.SYSTEM]: 'system',
							[extension_prompt_roles.USER]: 'user',
							[extension_prompt_roles.ASSISTANT]: 'assistant',
						};
	
						if (pos === 4) {
							// @depth 注入到聊天记录中
							chatLogInjections.push({
								content: entry.content,
								role: roleMap[role] || 'system',
								depth: depth,
							});
						} else if (pos === world_info_position.before || pos === world_info_position.after) {
							// 角色之前 / 角色之后：通过 TweakPrompt 注入到 char_prompt.text
							charInjections.push({
								content: entry.content,
								position: pos,
								order: order,
							});
						} else {
							// 其他位置（ANTop, ANBottom 等）：作为插件文本
							textEntries.push({
								content: entry.content,
								important: 0,
							});
						}
					}
	
					return {
						text: textEntries,
						additional_chat_log: [],
						extension: {
							worldbook_injections: chatLogInjections,
							worldbook_char_injections: charInjections,
						},
					};
				} catch (err) {
					console.error('[beilu-worldbook] GetPrompt error:', err);
					return { text: [], additional_chat_log: [], extension: {} };
				}
			},

			/**
			 * TweakPrompt — 将条目注入到正确的位置
			 *
			 * 1. before/after 条目 → 注入到 prompt_struct.char_prompt.text
			 *    - before (position=0): important = -1000 + order，排在角色描述之前
			 *    - after  (position=1): important =  1000 + order，排在角色描述之后
			 * 2. @depth 条目 → 注入到 prompt_struct.chat_log
			 */
			TweakPrompt: (arg, prompt_struct, my_prompt) => {
				// ---- 1. before/after 角色描述注入 ----
				const charInjections = my_prompt?.extension?.worldbook_char_injections;
				if (charInjections?.length && prompt_struct?.char_prompt?.text) {
					for (const injection of charInjections) {
						const important = injection.position === world_info_position.before
							? -1000 + (injection.order || 0)   // before: 非常小的 important → 排在最前面
							: 1000 + (injection.order || 0);    // after: 非常大的 important → 排在最后面
						prompt_struct.char_prompt.text.push({
							content: injection.content,
							important: important,
						});
					}
				}
	
				// ---- 2. @depth 聊天记录注入 ----
				const injections = my_prompt?.extension?.worldbook_injections;
				if (!injections || !Array.isArray(injections) || injections.length === 0) return;
				if (!prompt_struct?.chat_log) return;
	
				const chatLog = prompt_struct.chat_log;
	
				for (const injection of injections) {
					const depth = injection.depth ?? 4;
					// 计算注入位置：从末尾往前数 depth 条
					const insertIndex = Math.max(0, chatLog.length - depth);
	
					chatLog.splice(insertIndex, 0, {
						role: injection.role || 'system',
						content: injection.content,
						name: 'world_info',
						extension: { ephemeral: true },
					});
				}
			},
		},
	},
};

export default pluginExport;
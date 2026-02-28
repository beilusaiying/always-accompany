import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiag } from '../../../../server/diagLogger.mjs';

const diag = createDiag('worldbook');

// ST 枚举常量（内联，消除对 Fount 内部 charData.mjs 的依赖）
const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 };

// ============================================================
// 世界书动态注入标记处理（Phase 2E）
// ============================================================

/** 匹配 [GENERATE:identifier] 标记 */
const GENERATE_TAG_RE = /\[GENERATE:([^\]]+)\]/gi;

/** 匹配 [RENDER:identifier] 标记 */
const RENDER_TAG_RE = /\[RENDER:([^\]]+)\]/gi;

/**
 * 从内容中移除所有阶段标记
 * @param {string} content
 * @returns {string}
 */
function stripPhaseTags(content) {
	if (!content) return content;
	return content
		.replace(GENERATE_TAG_RE, '')
		.replace(RENDER_TAG_RE, '')
		.trim();
}

/**
 * 根据当前阶段过滤世界书条目
 *
 * 条目的 key 或 content 中包含 [GENERATE:*] 的仅在 generate 阶段注入。
 * 包含 [RENDER:*] 的仅在 render 阶段注入。
 * 不含任何标记的条目在所有阶段注入。
 *
 * @param {Array<object>} entries - 世界书条目列表
 * @param {string} phase - 'generate' | 'render' | 'all'
 * @returns {Array<object>}
 */
function filterEntriesByPhase(entries, phase = 'all') {
	if (!entries || !Array.isArray(entries) || phase === 'all') return entries || [];

	const result = [];
	let filtered = 0;

	for (const entry of entries) {
		const keyStr = Array.isArray(entry.key) ? entry.key.join(' ') : (entry.key || '');
		const content = entry.content || '';
		const combined = keyStr + ' ' + content;

		GENERATE_TAG_RE.lastIndex = 0;
		const hasGenerateTag = GENERATE_TAG_RE.test(combined);

		RENDER_TAG_RE.lastIndex = 0;
		const hasRenderTag = RENDER_TAG_RE.test(combined);

		if (!hasGenerateTag && !hasRenderTag) {
			result.push(entry);
			continue;
		}

		if (phase === 'generate' && hasGenerateTag) {
			result.push({ ...entry, content: stripPhaseTags(content) });
		} else if (phase === 'render' && hasRenderTag) {
			result.push({ ...entry, content: stripPhaseTags(content) });
		} else {
			filtered++;
		}
	}

	if (filtered > 0) {
		console.log(`[beilu-worldbook] 世界书过滤: ${entries.length} 条目, ${phase} 阶段, 过滤 ${filtered} 条`);
	}

	return result;
}

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
// 项目根目录（从 plugins/beilu-worldbook/ 向上5级到项目根）
const __projectRoot = join(__pluginDir, '..', '..', '..', '..', '..');

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
		activationMode: 'regex',
		dynamicConfig: {
			columnName: '',
			matchType: 'range',
			rangeMin: 0,
			rangeMax: 0,
			exactValue: '',
		},
	};
}

/**
 * 将 ST 世界书原始格式的条目转换为 beilu 内部格式
 * ST 格式使用 id/keys/secondary_keys/enabled/extensions.* 等字段
 * beilu 内部格式使用 uid/key/keysecondary/disable/顶层字段 等
 * @param {object} raw - ST 格式的原始条目
 * @param {number} fallbackUid - 当无法从原始数据获取 uid 时的备用值
 * @returns {object} beilu 内部格式的条目
 */
function convertSTEntry(raw, fallbackUid = 0) {
	const uid = raw.uid ?? raw.id ?? fallbackUid;
	const ext = raw.extensions || {};
	return {
		...createBlankEntry(uid),
		uid,
		comment: raw.comment || '',
		content: raw.content || '',
		key: raw.key || raw.keys || [],
		keysecondary: raw.keysecondary || raw.secondary_keys || [],
		constant: !!raw.constant,
		selective: raw.selective !== false,
		order: raw.order ?? raw.insertion_order ?? 100,
		disable: raw.disable ?? (raw.enabled === false),
		position: (typeof raw.position === 'number') ? raw.position : (ext.position ?? 0),
		depth: raw.depth ?? ext.depth ?? 4,
		role: raw.role ?? ext.role ?? null,
		selectiveLogic: raw.selectiveLogic ?? ext.selectiveLogic ?? 0,
		excludeRecursion: raw.excludeRecursion ?? ext.exclude_recursion ?? false,
		preventRecursion: raw.preventRecursion ?? ext.prevent_recursion ?? false,
		delayUntilRecursion: raw.delayUntilRecursion ?? ext.delay_until_recursion ?? false,
		displayIndex: raw.displayIndex ?? ext.display_index ?? uid,
		probability: raw.probability ?? ext.probability ?? 100,
		useProbability: raw.useProbability ?? ext.useProbability ?? true,
		group: raw.group ?? ext.group ?? '',
		groupOverride: raw.groupOverride ?? ext.group_override ?? false,
		groupWeight: raw.groupWeight ?? ext.group_weight ?? 100,
		scanDepth: raw.scanDepth ?? ext.scan_depth ?? null,
		caseSensitive: raw.caseSensitive ?? ext.case_sensitive ?? null,
		matchWholeWords: raw.matchWholeWords ?? ext.match_whole_words ?? null,
		useGroupScoring: raw.useGroupScoring ?? ext.use_group_scoring ?? null,
		automationId: raw.automationId ?? ext.automation_id ?? '',
		sticky: raw.sticky ?? ext.sticky ?? 0,
		cooldown: raw.cooldown ?? ext.cooldown ?? 0,
		delay: raw.delay ?? ext.delay ?? 0,
		// 激活模式：保留已有值，或根据 constant 推断
		activationMode: raw.activationMode || (raw.constant ? 'constant' : 'regex'),
		dynamicConfig: raw.dynamicConfig || {
			columnName: '',
			matchType: 'range',
			rangeMin: 0,
			rangeMax: 0,
			exactValue: '',
		},
	};
}

/**
 * 将 entries（数组或对象）统一转换为 beilu 内部格式的对象
 * @param {Array|object} rawEntries - ST 格式的 entries（数组或对象形式）
 * @returns {object} uid 为 key 的内部格式对象
 */
function convertSTEntries(rawEntries) {
	const rawList = Array.isArray(rawEntries)
		? rawEntries
		: Object.values(rawEntries);
	const converted = {};
	for (let i = 0; i < rawList.length; i++) {
		const entry = convertSTEntry(rawList[i], i);
		converted[String(entry.uid)] = entry;
	}
	return converted;
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
// 动态提示词：读取记忆表格数据
// ============================================================

/**
 * 加载指定角色的记忆表格数据
 * @param {string} username - 用户名
 * @param {string} charName - 角色名
 * @returns {Array|null} 表格数组，失败返回 null
 */
function loadTablesForDynamic(username, charName) {
	if (!charName) return null;
	const user = username || '_default';
	const tablesPath = join(__projectRoot, 'data', 'users', user, 'chars', charName, 'memory', 'tables.json');
	try {
		if (!fs.existsSync(tablesPath)) {
			diag.debug('动态模式: tables.json 不存在:', tablesPath);
			return null;
		}
		const raw = JSON.parse(fs.readFileSync(tablesPath, 'utf-8'));
		return raw?.tables || null;
	} catch (e) {
		diag.warn('动态模式: 读取 tables.json 失败:', e.message);
		return null;
	}
}

/**
 * 检查动态条目是否应该激活
 * @param {object} entry - 世界书条目（含 dynamicConfig）
 * @param {Array} tables - 记忆表格数组
 * @returns {boolean}
 */
function checkDynamicEntry(entry, tables) {
	const config = entry.dynamicConfig;
	if (!config?.columnName) return false;
	for (const table of tables) {
		if (table.enabled === false) continue;
		const colIndex = (table.columns || []).indexOf(config.columnName);
		if (colIndex === -1) continue;
		for (const row of (table.rows || [])) {
			const cellValue = row[colIndex];
			if (cellValue == null || cellValue === '') continue;
			if (config.matchType === 'exact') {
				if (String(cellValue).trim() === String(config.exactValue).trim()) return true;
			} else {
				// range 模式
				const numVal = parseFloat(cellValue);
				if (!isNaN(numVal) && numVal >= config.rangeMin && numVal <= config.rangeMax) return true;
			}
		}
	}
	return false;
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
				let migrated = false;
				for (const [name, wb] of Object.entries(configData.worldbooks)) {
					if (wb.enabled === undefined) wb.enabled = true;
					if (wb.boundCharName === undefined) wb.boundCharName = '';
					// 数据迁移：将旧的 ST 格式 entries 转换为 beilu 内部格式
					if (!wb.entries) continue;
					const entriesValues = Array.isArray(wb.entries) ? wb.entries : Object.values(wb.entries);
					const needsMigration = Array.isArray(wb.entries) ||
						(entriesValues.length > 0 && entriesValues[0].uid === undefined && entriesValues[0].id !== undefined);
					if (needsMigration) {
							diag.log(`迁移世界书 "${name}" 的条目格式 (ST → beilu)...`);
							wb.entries = convertSTEntries(wb.entries);
							migrated = true;
						}
						// 数据迁移：为旧条目添加 activationMode 字段
						if (wb.entries) {
							for (const entry of Object.values(wb.entries)) {
								if (!entry.activationMode) {
									entry.activationMode = entry.constant ? 'constant' : 'regex';
									migrated = true;
								}
								if (!entry.dynamicConfig) {
									entry.dynamicConfig = {
										columnName: '',
										matchType: 'range',
										rangeMin: 0, rangeMax: 0,
										exactValue: '',
									};
									migrated = true;
								}
							}
						}
				}
				if (migrated) {
					saveConfigToDisk();
					console.log('[beilu-worldbook] 旧格式数据迁移完成，已保存');
				}
				const count = Object.keys(configData.worldbooks).length;
				const active = configData.active_worldbook;
				const activeEntryCount = getActiveEntries() ? Object.keys(getActiveEntries()).length : 0;
				// 统计各模式分布
				const allEntries = Object.values(configData.worldbooks).flatMap(wb => wb.entries ? Object.values(wb.entries) : []);
				const modeStats = { constant: 0, regex: 0, dynamic: 0 };
				for (const e of allEntries) {
					const m = e.activationMode || (e.constant ? 'constant' : 'regex');
					modeStats[m] = (modeStats[m] || 0) + 1;
				}
				diag.log(`初始化完成: ${count} 个世界书, 激活: "${active}" (${activeEntryCount} 条目), 模式分布: 常驻=${modeStats.constant} 正则=${modeStats.regex} 动态=${modeStats.dynamic}`);
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

		// ---- Lorebook API 端点（供前端 stCompat 世界书 polyfill 使用） ----
		// 支持两种查询方式：
		//   ?book=世界书名称  — 按名称查找
		//   ?charName=角色名  — 按角色绑定查找（优先，更可靠）
		router.get('/api/parts/plugins\\:beilu-worldbook/lorebook/entries', async (req, res) => {
			try {
				const bookName = req.query.book;
				const charName = req.query.charName;

				let wb = null;
				let resolvedName = '';

				// 策略1：通过角色名查绑定的世界书（最可靠）
				if (charName) {
					for (const [name, candidate] of Object.entries(configData.worldbooks)) {
						if (candidate.boundCharName === charName) {
							wb = candidate;
							resolvedName = name;
							console.log(`[beilu-worldbook] lorebook/entries: 通过角色 "${charName}" 找到绑定世界书 "${name}"`);
							break;
						}
					}
				}

				// 策略2：精确名称匹配
				if (!wb && bookName) {
					wb = configData.worldbooks[bookName];
					if (wb) resolvedName = bookName;
				}

				// 策略3：模糊名称匹配（角色卡中的 world 名称可能与导入的世界书名不同）
				if (!wb && bookName) {
					const allNames = Object.keys(configData.worldbooks);
					const fuzzyMatch = allNames.find(name =>
						name.includes(bookName) || bookName.includes(name) ||
						name.replace(/[\s世界书]/g, '').includes(bookName.replace(/[\d.]/g, '')) ||
						bookName.replace(/[\d.]/g, '').includes(name.replace(/[\s世界书]/g, ''))
					);
					if (fuzzyMatch) {
						console.log(`[beilu-worldbook] lorebook/entries: 模糊匹配 "${bookName}" → "${fuzzyMatch}"`);
						wb = configData.worldbooks[fuzzyMatch];
						resolvedName = fuzzyMatch;
					}
				}

				if (!wb) {
					const queryDesc = charName ? `角色="${charName}"` : `名称="${bookName}"`;
					console.warn(`[beilu-worldbook] lorebook/entries: 未找到世界书 (${queryDesc})，可用: [${Object.keys(configData.worldbooks).join(', ')}]`);
					return res.json({ entries: [], resolvedName: '' });
				}

				// 返回所有条目（含禁用条目），MVU 需要读取 [initvar] 条目（通常是禁用的）
				const entries = wb.entries ? Object.values(wb.entries) : [];
				// 按 displayIndex 排序
				entries.sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
				console.log(`[beilu-worldbook] lorebook/entries: "${resolvedName}" → ${entries.length} 条目`);
				res.json({ entries, resolvedName });
			} catch (err) {
				console.error('[beilu-worldbook] lorebook/entries error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		router.get('/api/parts/plugins\\:beilu-worldbook/lorebook/char-books', async (req, res) => {
			try {
				const charName = req.query.charName;
				const result = { primary: '', books: [] };
				if (charName) {
					for (const [name, wb] of Object.entries(configData.worldbooks)) {
						if (wb.boundCharName === charName) {
							result.books.push(name);
							if (!result.primary) result.primary = name;
						}
					}
				}
				res.json(result);
			} catch (err) {
				console.error('[beilu-worldbook] lorebook/char-books error:', err);
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

				// 导入世界书（ST 格式 → beilu 内部格式）
					if (data.import_worldbook) {
						const { json, name, boundCharName } = data.import_worldbook;
						if (json?.entries) {
							const convertedEntries = convertSTEntries(json.entries);
							configData.worldbooks[name] = {
								entries: convertedEntries,
								enabled: true,
								boundCharName: boundCharName || '',
							};
							configData.active_worldbook = name;
							const count = Object.keys(convertedEntries).length;
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
								diag.log(`条目${disabled ? '禁用' : '启用'}: uid=${uid}, "${entries[key].comment || ''}"`);
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
								diag.log(`条目更新: uid=${uid}, 字段=[${Object.keys(props).join(',')}]`);
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
							diag.log(`条目新增: uid=${uid}, "${newEntry.comment || ''}"`);
						}
					}
	
					// 删除条目
					if (data.delete_entry) {
						const { uid } = data.delete_entry;
						const entries = getActiveEntries();
						if (entries) {
							const key = String(uid);
							if (entries[key]) {
								const comment = entries[key].comment || '';
								delete entries[key];
								diag.log(`条目删除: uid=${uid}, "${comment}"`);
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
			 * 3种激活模式：
			 * - constant: 常驻条目，直接注入
			 * - regex: 关键词匹配，由 world_info.mjs 引擎处理
			 * - dynamic: 动态提示词，检测记忆表格数据决定是否激活
			 *
			 * 支持多世界书并行：遍历所有 enabled=true 且角色匹配的世界书
			 *
			 * @param {object} arg - chatReplyRequest_t
			 * @returns {object} single_part_prompt_t
			 */
			GetPrompt: (arg) => {
			 // char_id 是 part 目录名（用于路径和绑定匹配），Charname 是显示名
			 const charId = arg?.char_id || '';
			 const username = arg?.username || '_default';
			 let entryArray = getAllEnabledEntries(charId);
				if (entryArray.length === 0) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				// Phase 2E: 按阶段过滤条目（GetPrompt 在生成阶段调用）
				entryArray = filterEntriesByPhase(entryArray, 'generate');
				if (entryArray.length === 0) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				// ---- 3模式分流 ----
				const constantEntries = [];
				const regexEntries = [];
				const dynamicEntries = [];

				for (const entry of entryArray) {
					const mode = entry.activationMode || (entry.constant ? 'constant' : 'regex');
					if (mode === 'constant') {
						constantEntries.push(entry);
					} else if (mode === 'dynamic') {
						dynamicEntries.push(entry);
					} else {
						regexEntries.push(entry);
					}
				}

				diag.debug(`GetPrompt 3模式分流: charId="${charId}", constant=${constantEntries.length}, regex=${regexEntries.length}, dynamic=${dynamicEntries.length}`);

				// ---- 常驻条目：直接激活 ----
				const activated = [...constantEntries];
				if (constantEntries.length > 0) {
					diag.debug(`常驻条目激活: ${constantEntries.length} 条 [${constantEntries.map(e => e.comment || e.uid).join(', ')}]`);
				}

				// ---- 正则条目：送入 ST 世界书激活引擎 ----
				if (regexEntries.length > 0) {
					const wiEntries = regexEntries.map(e => ({
						...e,
						keys: Array.isArray(e.key) ? [...e.key] : (e.key ? [e.key] : []),
						secondary_keys: Array.isArray(e.keysecondary) ? [...e.keysecondary] : (e.keysecondary ? [e.keysecondary] : []),
						enabled: !e.disable,
						constant: false, // 强制关闭，常驻模式已在上方处理
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

					const chatLog = arg.chat_log || [];
					const env = {
						user: arg.UserCharname || 'User',
						char: arg.Charname || 'Character',
					};
					const memory = arg.extension?.worldbook_memory || {};

					try {
						const regexActivated = GetActivedWorldInfoEntries(wiEntries, chatLog, env, memory);
						if (arg.extension) {
							arg.extension.worldbook_memory = memory;
						}
						activated.push(...regexActivated);
						diag.debug(`正则引擎激活: ${regexActivated.length} 条`);
					} catch (err) {
						diag.error('正则引擎错误:', err);
					}
				}

				// ---- 动态条目：检查记忆表格 ----
				if (dynamicEntries.length > 0) {
					diag.time('dynamicCheck');
					const tables = loadTablesForDynamic(username, charId);
					if (tables) {
						for (const entry of dynamicEntries) {
							if (checkDynamicEntry(entry, tables)) {
								activated.push(entry);
								diag.debug(`动态条目激活: "${entry.comment}" (列: ${entry.dynamicConfig?.columnName})`);
							}
						}
					} else {
						diag.debug('动态模式: 无法加载表格数据，跳过动态条目');
					}
					diag.timeEnd('dynamicCheck');
				}

				if (activated.length === 0) {
					return { text: [], additional_chat_log: [], extension: {} };
				}

				diag.log(`GetPrompt 总激活: ${activated.length} 条`);
	
				// 按 position 分类构建提示词
				const textEntries = [];
				const chatLogInjections = [];
				const charInjections = [];
				let beforeCount = 0, afterCount = 0, depthCount = 0, otherCount = 0;

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
						chatLogInjections.push({
							content: entry.content,
							role: roleMap[role] || 'system',
							depth: depth,
						});
						depthCount++;
					} else if (pos === world_info_position.before || pos === world_info_position.after) {
						charInjections.push({
							content: entry.content,
							position: pos,
							order: order,
						});
						if (pos === world_info_position.before) beforeCount++;
						else afterCount++;
					} else {
						textEntries.push({
							content: entry.content,
							important: 0,
						});
						otherCount++;
					}
				}

				diag.debug(`注入构建: before=${beforeCount}, after=${afterCount}, @depth=${depthCount}, other=${otherCount}`);
	
				return {
					text: textEntries,
					additional_chat_log: [],
					extension: {
						worldbook_injections: chatLogInjections,
						worldbook_char_injections: charInjections,
					},
				};
			},

			/**
			 * TweakPrompt — 将条目注入到正确的位置
			 *
			 * 1. before/after 条目 → 注入到 prompt_struct.char_prompt.text
			 *    - before (position=0): important = -1000 + order，排在角色描述之前
			 *    - after  (position=1): important =  1000 + order，排在角色描述之后
			 * 2. @depth 条目 → 注入到 prompt_struct.chat_log
			 */
			TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
				// 只在第一轮（detail_level=2）执行，避免三轮重复注入
				if (detail_level !== undefined && detail_level !== 2) return;
	
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
					diag.debug(`TweakPrompt char注入: ${charInjections.length} 条 (before/after → char_prompt.text)`);
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
				diag.debug(`TweakPrompt @depth注入: ${injections.length} 条 → chat_log (共${chatLog.length}条)`);
			},
		},
	},
};

export default pluginExport;
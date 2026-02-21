import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMacros } from './engine/marco.mjs';
import { PresetEngine, buildDefaultMemory } from './engine/preset_engine.mjs';
import info from './info.json' with { type: 'json' };

// ============================================================
// 持久化
// ============================================================

const __pluginDir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__pluginDir, 'config_data.json');

/**
 * 将 configData 保存到磁盘（插件目录下的 config_data.json）
 */
function saveConfigToDisk() {
	try {
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf-8');
	} catch (e) {
		console.warn('[beilu-preset] 保存配置到磁盘失败:', e.message);
	}
}

/**
 * 从磁盘读取配置
 * @returns {object|null}
 */
function loadConfigFromDisk() {
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
		}
	} catch (e) {
		console.warn('[beilu-preset] 从磁盘读取配置失败:', e.message);
	}
	return null;
}

// ============================================================
// 插件状态
// ============================================================

/** 预设引擎实例（加载当前激活预设） */
const engine = new PresetEngine();

/** 宏记忆（跨回合持久化） */
let macroMemory = buildDefaultMemory();

/**
 * 最近一次提示词快照（内存中，不持久化）
 * 在 TweakPrompt 最后一轮（detail_level===0）时捕获
 * @type {object|null}
 */
let lastPromptSnapshot = null;

/**
 * 运行时参数（不持久化到磁盘）
 * 由前端通过 update_runtime_params 设置，用于瞬时控制
 * @type {{
 *   context_msg_limit: number,           // 上下文消息条数限制，0=不限制
 *   stream: boolean,                     // 流式输出开关
 *   prompt_post_processing: string,      // 提示词后处理: 'none'|'merge'|'semi'|'strict'
 *   prefill_enabled: boolean,            // 通用预填充开关（尾部 assistant 保持身份）
 *   claude_prefill_enabled: boolean,     // Claude 预填充开关（+自动严格角色）
 *   continue_prefill: boolean,           // 继续预填充（继续时以 assistant 身份发送）
 * }}
 */
let runtimeParams = {
	context_msg_limit: 0,
	stream: true,
	prompt_post_processing: 'none',
	prefill_enabled: false,
	claude_prefill_enabled: false,
	continue_prefill: false,
};

/**
 * 配置数据结构（多预设）
 * @type {{
 *   active_preset: string,       // 当前激活的预设名称
 *   presets: Object<string, {    // 预设名称 → 预设数据
 *     preset_json: object,
 *     model_params: object,
 *     macro_variables: object,
 *   }>
 * }}
 */
let configData = {
	active_preset: '',
	presets: {},
};

// ============================================================
// beilu-preset 插件
// ============================================================

/**
 * beilu-preset — 预设管理引擎
 *
 * 职责：
 * - 兼容 ST 预设格式（prompts[] + prompt_order[]）
 * - 双层排序：系统级 prompt_order → GetPrompt; 注入式 injection_depth → TweakPrompt
 * - 宏替换（复用 Fount ST 宏引擎 marco.mjs）
 * - 管理条目启用/禁用状态（供 beilu-toggle 操控）
 * - 提供预设数据给 UI 面板展示
 *
 * @returns {import('../../../../src/decl/pluginAPI.ts').PluginAPI_t}
 */
const pluginExport = {
	info,

	// --------------------------------------------------------
	// 生命周期
	// --------------------------------------------------------

	Load: async ({ router }) => {
		console.log('[beilu-preset] 插件加载中...');

		// 从磁盘文件恢复预设数据（替代 Fount 的 api.config.GetData）
		try {
			const saved = loadConfigFromDisk();
			if (saved) {
				// 向后兼容：检测旧格式并迁移
				if (saved.preset_json && !saved.presets) {
					console.log('[beilu-preset] 检测到旧格式，迁移为多预设结构...');
					const name = saved.preset_name || '已保存预设';
					configData = {
						active_preset: name,
						presets: {
							[name]: {
								preset_json: saved.preset_json,
								model_params: saved.model_params || {},
								macro_variables: saved.macro_variables || {},
							},
						},
					};
				} else if (saved.presets) {
					configData = {
						active_preset: saved.active_preset || '',
						presets: saved.presets || {},
					};
				}

				// 加载当前激活预设到引擎
				const activeData = configData.presets[configData.active_preset];
				if (activeData?.preset_json) {
					engine.load(activeData.preset_json, configData.active_preset);

					// 同步独立修改过的模型参数
					if (activeData.model_params && Object.keys(activeData.model_params).length > 0) {
						Object.assign(engine.modelParams, activeData.model_params);
					}

					// 恢复宏变量
					if (activeData.macro_variables) {
						macroMemory.variables = { ...activeData.macro_variables };
					}

					console.log(`[beilu-preset] 预设已恢复: "${engine.presetName}" (${engine.promptEntries.size} 条目)`);
				} else {
					console.log('[beilu-preset] 无激活预设，等待导入或切换');
				}
			} else {
				console.log('[beilu-preset] 无已保存预设，等待导入');
			}
		} catch (e) {
			console.warn('[beilu-preset] 加载配置失败:', e.message);
		}

		// ---- 注册 HTTP API 端点 ----
		// 前端通过这些端点与插件通信，替代不可用的 shells:config 路径

		router.get('/api/parts/plugins\\:beilu-preset/config/getdata', async (req, res) => {
			try {
				const data = await pluginExport.interfaces.config.GetData();
				res.json(data);
			} catch (err) {
				console.error('[beilu-preset] GetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		// ---- 提示词快照 API ----
		router.get('/api/parts/plugins\\:beilu-preset/prompt-snapshot', async (_req, res) => {
			try {
				if (!lastPromptSnapshot) {
					res.json({ available: false, message: '尚无快照，请先发送一条消息' });
				} else {
					res.json({ available: true, snapshot: lastPromptSnapshot });
				}
			} catch (err) {
				console.error('[beilu-preset] prompt-snapshot error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		// ---- 运行时参数 API（不持久化） ----
		router.get('/api/parts/plugins\\:beilu-preset/config/runtime-params', async (_req, res) => {
			res.json({ ...runtimeParams });
		});

		router.post('/api/parts/plugins\\:beilu-preset/config/runtime-params', async (req, res) => {
			try {
				if (req.body) {
						if (req.body.context_msg_limit !== undefined) {
							runtimeParams.context_msg_limit = parseInt(req.body.context_msg_limit, 10) || 0;
						}
						if (req.body.stream !== undefined) {
							runtimeParams.stream = !!req.body.stream;
						}
						if (req.body.prompt_post_processing !== undefined) {
							const valid = ['none', 'merge', 'semi', 'strict'];
							runtimeParams.prompt_post_processing = valid.includes(req.body.prompt_post_processing)
								? req.body.prompt_post_processing : 'none';
						}
						if (req.body.prefill_enabled !== undefined) {
							runtimeParams.prefill_enabled = !!req.body.prefill_enabled;
						}
						if (req.body.claude_prefill_enabled !== undefined) {
							runtimeParams.claude_prefill_enabled = !!req.body.claude_prefill_enabled;
						}
						if (req.body.continue_prefill !== undefined) {
							runtimeParams.continue_prefill = !!req.body.continue_prefill;
						}
					}
				res.json({ success: true, params: { ...runtimeParams } });
			} catch (err) {
				console.error('[beilu-preset] runtime-params error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		router.post('/api/parts/plugins\\:beilu-preset/config/setdata', async (req, res) => {
			try {
				const result = await pluginExport.interfaces.config.SetData(req.body);
				res.json(result);
			} catch (err) {
				console.error('[beilu-preset] SetData error:', err);
				res.status(500).json({ error: err.message });
			}
		});
	},

	Unload: async () => {
		console.log('[beilu-preset] 插件卸载');
	},

	// --------------------------------------------------------
	// 接口
	// --------------------------------------------------------

	interfaces: {
		config: {
			/**
			 * 获取插件配置数据
			 * 返回预设信息、条目列表、模型参数等供 UI 和其他插件使用
			 */
			GetData: async () => {
				return {
					// 多预设管理
					active_preset: configData.active_preset,
					preset_list: Object.keys(configData.presets),

					// 当前激活预设的信息
					preset_name: engine.presetName,
					preset_loaded: engine.isLoaded(),

					// 所有条目列表（供 UI 和 beilu-toggle 使用）
					entries: engine.getAllEntries(),

					// 模型参数
					model_params: { ...engine.modelParams },

					// 预设模板
					templates: { ...engine.templates },

					// 正则脚本
					regex_scripts: engine.getRegexScripts(),

					// 宏变量
					macro_variables: { ...macroMemory.variables },

					// 完整预设 JSON（用于导出）
					preset_json: engine.toJSON(),

					// 司令员模式标记
					commander_mode: true,
				};
			},

			/**
			 * 设置插件配置
			 *
			 * 支持的操作：
			 * - import_preset: 导入新的 ST 预设 JSON（存入 presets，自动激活）
			 * - switch_preset: 切换激活预设
			 * - delete_preset: 删除指定预设
			 * - rename_preset: 重命名预设
			 * - toggle_entry: 切换条目启用/禁用
			 * - batch_toggle: 批量切换
			 * - update_entry: 修改条目内容或属性
			 * - update_model_params: 修改模型参数
			 * - update_macro_vars: 修改宏变量
			 * - clear_preset: 清除当前预设（从列表中移除）
			 */
			SetData: async (data) => {
				if (!data) return { success: true };

				// 导入预设（存入 presets，自动激活）
				if (data.import_preset) {
					let { json, name } = data.import_preset;
					const forceOverwrite = data.import_preset.force_overwrite || false;

					// 重名检测：如果已存在同名预设且不是强制覆盖
					if (configData.presets[name] && !forceOverwrite) {
						// 返回重名提示，让前端决定
						console.log(`[beilu-preset] 预设重名: "${name}"，等待前端确认`);
						return {
							success: false,
							duplicate: true,
							existing_name: name,
							message: `预设 "${name}" 已存在，是否覆盖？`,
						};
					} else {
						engine.load(json, name);

						// 存入多预设结构
						configData.presets[name] = {
							preset_json: json,
							model_params: { ...engine.modelParams },
							macro_variables: {},
						};
						configData.active_preset = name;

						console.log(`[beilu-preset] 预设已导入并激活: "${name}"`);
					}
				}

				// 切换激活预设
				if (data.switch_preset) {
					const { name } = data.switch_preset;
					const presetData = configData.presets[name];
					if (presetData?.preset_json) {
						// 先保存当前预设状态
						syncActivePresetToConfig();

						// 加载新预设
						engine.load(presetData.preset_json, name);
						if (presetData.model_params && Object.keys(presetData.model_params).length > 0) {
							Object.assign(engine.modelParams, presetData.model_params);
						}
						macroMemory.variables = { ...(presetData.macro_variables || {}) };
						configData.active_preset = name;

						console.log(`[beilu-preset] 已切换到预设: "${name}"`);
					}
				}

				// 删除指定预设（允许删除激活的预设）
				if (data.delete_preset) {
					const { name } = data.delete_preset;
					if (configData.presets[name]) {
						delete configData.presets[name];
						console.log(`[beilu-preset] 已删除预设: "${name}"`);
	
						// 如果删除的是当前激活预设，需要切换
						if (name === configData.active_preset) {
							const remaining = Object.keys(configData.presets);
							if (remaining.length > 0) {
								// 自动切换到剩余的第一个预设
								const nextName = remaining[0];
								const nextData = configData.presets[nextName];
								engine.load(nextData.preset_json, nextName);
								if (nextData.model_params && Object.keys(nextData.model_params).length > 0) {
									Object.assign(engine.modelParams, nextData.model_params);
								}
								macroMemory.variables = { ...(nextData.macro_variables || {}) };
								configData.active_preset = nextName;
								console.log(`[beilu-preset] 自动切换到预设: "${nextName}"`);
							} else {
								// 没有剩余预设，清空引擎
								engine.load({}, '');
								configData.active_preset = '';
								macroMemory.variables = {};
								console.log('[beilu-preset] 所有预设已删除，引擎已清空');
							}
						}
					}
				}

				// 新建空白预设
				if (data.create_preset) {
					const { name } = data.create_preset;
					if (!name) {
						console.warn('[beilu-preset] create_preset: 缺少名称');
					} else if (configData.presets[name]) {
						console.warn(`[beilu-preset] 预设 "${name}" 已存在`);
					} else {
						const defaultOrder = [
								{ identifier: 'main', enabled: true },
								{ identifier: 'personaDescription', enabled: true },
								{ identifier: 'worldInfoBefore', enabled: true },
								{ identifier: 'charDescription', enabled: true },
								{ identifier: 'charPersonality', enabled: true },
								{ identifier: 'scenario', enabled: true },
								{ identifier: 'nsfw', enabled: true },
								{ identifier: 'worldInfoAfter', enabled: true },
								{ identifier: 'dialogueExamples', enabled: true },
								{ identifier: 'chatHistory', enabled: true },
								{ identifier: 'jailbreak', enabled: true },
							];
							const blankPreset = {
								prompts: [
									// 3 个内置非 Marker 条目（内容为空，用户可编辑）
									{
										name: 'Main Prompt',
										system_prompt: true,
										role: 'system',
										content: '',
										identifier: 'main',
										forbid_overrides: false,
										injection_position: 0,
										injection_depth: 4,
										injection_order: 100,
										injection_trigger: [],
									},
									{
										name: 'NSFW Prompt',
										system_prompt: true,
										role: 'system',
										content: '',
										identifier: 'nsfw',
										forbid_overrides: false,
										injection_position: 0,
										injection_depth: 4,
										injection_order: 100,
										injection_trigger: [],
									},
									{
										name: 'Jailbreak',
										system_prompt: true,
										role: 'system',
										content: '',
										identifier: 'jailbreak',
										forbid_overrides: false,
										injection_position: 0,
										injection_depth: 4,
										injection_order: 100,
										injection_trigger: [],
									},
									// 8 个 Marker 条目（占位符，由引擎展开为模块内容）
									{ identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
									{ identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
									{ identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
									{ identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
									{ identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
									{ identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
									{ identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
									{ identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
								],
								prompt_order: [
									{ character_id: 100000, order: defaultOrder.map(o => ({ ...o })) },
									{ character_id: 100001, order: defaultOrder.map(o => ({ ...o })) },
								],
							};
						configData.presets[name] = {
							preset_json: blankPreset,
							model_params: {},
							macro_variables: {},
						};

						// 如果没有激活预设，自动激活新建的
						if (!configData.active_preset) {
							engine.load(blankPreset, name);
							configData.active_preset = name;
						}

						console.log(`[beilu-preset] 空白预设已创建: "${name}"`);
					}
				}

				// 重命名预设
				if (data.rename_preset) {
					const { old_name, new_name } = data.rename_preset;
					if (configData.presets[old_name] && !configData.presets[new_name]) {
						configData.presets[new_name] = configData.presets[old_name];
						delete configData.presets[old_name];
						if (configData.active_preset === old_name) {
							configData.active_preset = new_name;
							engine.presetName = new_name;
						}
						console.log(`[beilu-preset] 预设已重命名: "${old_name}" → "${new_name}"`);
					}
				}

				// 重新排序条目
				if (data.reorder_entries) {
					const { order } = data.reorder_entries;
					const ok = engine.reorderEntries(order);
					if (ok) {
						syncActivePresetToConfig();
					}
				}

				// 切换单个条目
				if (data.toggle_entry) {
					const { identifier, enabled } = data.toggle_entry;
					const ok = engine.toggleEntry(identifier, enabled);
					if (ok) {
						syncActivePresetToConfig();
					}
				}

				// 批量切换
				if (data.batch_toggle) {
					const count = engine.batchToggle(data.batch_toggle);
					if (count > 0) {
						syncActivePresetToConfig();
					}
				}

				// 新增条目
				if (data.add_entry) {
					const entryData = data.add_entry;
					if (!entryData.identifier) {
						console.warn('[beilu-preset] add_entry: 缺少 identifier');
					} else {
						const ok = engine.addEntry(entryData);
						if (ok) {
							syncActivePresetToConfig();
							console.log(`[beilu-preset] 条目已新增: "${entryData.identifier}"`);
						} else {
							console.warn(`[beilu-preset] 条目新增失败: "${entryData.identifier}" (可能已存在)`);
						}
					}
				}
	
				// 删除条目
				if (data.delete_entry) {
					const { identifier } = data.delete_entry;
					if (!identifier) {
						console.warn('[beilu-preset] delete_entry: 缺少 identifier');
					} else {
						const ok = engine.deleteEntry(identifier);
						if (ok) {
							syncActivePresetToConfig();
							console.log(`[beilu-preset] 条目已删除: "${identifier}"`);
						} else {
							console.warn(`[beilu-preset] 条目删除失败: "${identifier}" (可能是内置Marker或不存在)`);
						}
					}
				}
	
				// 修改条目内容
				if (data.update_entry) {
					const { identifier, content, props } = data.update_entry;
					if (content !== undefined) {
						engine.updateEntryContent(identifier, content);
					}
					if (props) {
						engine.updateEntryProps(identifier, props);
					}
					syncActivePresetToConfig();
				}

				// 修改模型参数
				if (data.update_model_params) {
					Object.assign(engine.modelParams, data.update_model_params);
					syncActivePresetToConfig();
				}

				// 修改宏变量
				if (data.update_macro_vars) {
					Object.assign(macroMemory.variables, data.update_macro_vars);
					syncActivePresetToConfig();
				}

				// 清除当前预设（从列表移除）
				if (data.clear_preset) {
					const activeName = configData.active_preset;
					if (activeName && configData.presets[activeName]) {
						delete configData.presets[activeName];
					}
					engine.load({}, '');
					configData.active_preset = '';
					macroMemory.variables = {};
				}

				// 持久化到磁盘
				saveConfigToDisk();
				return { success: true };
			},
		},

		chat: {
			/**
			 * GetPrompt — 司令员模式下，GetPrompt 只返回空壳
			 *
			 * 所有实际内容在 TweakPrompt 阶段通过三轮机制组装。
			 * GetPrompt 返回空的 single_part_prompt_t，仅保留 extension 字段
			 * 作为后续 TweakPrompt 的数据通道。
			 *
			 * @param {object} arg - chatReplyRequest_t
			 * @returns {object} single_part_prompt_t
			 */
			GetPrompt: (arg) => {
				return {
					text: [],
					additional_chat_log: [],
					extension: {
						preset_source: 'beilu-preset',
						preset_name: engine.presetName,
						commander_mode: engine.isLoaded(),
					},
				};
			},

			/**
			 * TweakPrompt — 司令员模式：三轮接管
			 *
			 * Round 1 (detail_level=2): 收集 — 读取所有模块内容到宏环境，清空原始模块
			 * Round 2 (detail_level=1): 重建 — 用预设条目重新组装消息序列，写入 extension
			 * Round 3 (detail_level=0): 注入 — 将 depth 条目注入 chat_log + 快照捕获
			 *
			 * @param {object} arg - chatReplyRequest_t
			 * @param {object} prompt_struct - prompt_struct_t（可修改）
			 * @param {object} my_prompt - 本插件的 single_part_prompt_t
			 * @param {number} detail_level - 细节级别 (2→1→0)
			 */
			TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
				if (!engine.isLoaded()) return;
				if (!prompt_struct) return;

				// ================================================================
				// Round 1 (detail_level=2): 收集所有模块内容到宏环境
				// ================================================================
				if (detail_level === 2) {
					// 构建基础宏环境
					const env = buildMacroEnvFromPromptStruct(prompt_struct);

					// 收集各模块内容到宏环境（同步块，保证原子性）
					env.char_prompt = flattenPromptTexts(prompt_struct.char_prompt);
					env.char_personality = ''; // Fount 不区分，合并在 char_prompt 中
					env.scenario = '';          // 同上
					env.user_prompt = flattenPromptTexts(prompt_struct.user_prompt);
					env.world_prompt = flattenPromptTexts(prompt_struct.world_prompt);
					env.world_prompt_after = ''; // Fount 不区分 before/after
					env.dialogue_examples = '';  // Fount 不单独提供
	
					// ---- 从 beilu-worldbook 插件 extension 中提取世界书内容 ----
					// beilu-worldbook 是 plugin 不是 world 部件，所以 world_prompt 为空
					// 需要从它的 extension 中读取分类后的世界书条目
					const wbPrompt = prompt_struct.plugin_prompts?.['beilu-worldbook'];
					if (wbPrompt?.extension) {
						// before/after 位置的世界书条目 → 填充 {{worldInfoBefore}} / {{worldInfoAfter}} 宏
						const charInjections = wbPrompt.extension.worldbook_char_injections;
						if (Array.isArray(charInjections) && charInjections.length > 0) {
							const beforeContent = charInjections
								.filter(inj => inj.position === 0)
								.map(inj => inj.content)
								.filter(Boolean)
								.join('\n');
							const afterContent = charInjections
								.filter(inj => inj.position === 1)
								.map(inj => inj.content)
								.filter(Boolean)
								.join('\n');
							if (beforeContent) env.world_prompt = beforeContent;
							if (afterContent) env.world_prompt_after = afterContent;
						}
	
						// @depth 注入的世界书条目 → 暂存，在 Round 2 中处理
						const depthInjections = wbPrompt.extension.worldbook_injections;
						if (Array.isArray(depthInjections) && depthInjections.length > 0) {
							my_prompt.extension._worldbook_depth_injections = depthInjections;
						}
	
						// ANTop/ANBottom/EMTop/EMBottom 位置的条目已在 text 中，
						// 会被 flattenPromptTexts 收集到 env.plugin_beilu-worldbook
					}

					// 收集其他插件的输出
					for (const [name, prompt] of Object.entries(prompt_struct.plugin_prompts || {})) {
						if (name === 'beilu-preset') continue;
						const pluginContent = flattenPromptTexts(prompt);
						if (pluginContent) {
							env[`plugin_${name}`] = pluginContent;
						}
						// 从插件 extension 中提取宏变量（不用 truthy 判断，允许空字符串）
						if (prompt?.extension) {
							if (prompt.extension.workspace_root !== undefined) {
								env.workspace_root = prompt.extension.workspace_root;
							}
							if (prompt.extension.workspace_tree !== undefined) {
								env.workspace_tree = prompt.extension.workspace_tree;
							}
						}
					}
					// 诊断日志：确认宏变量是否被收集
					if (env.workspace_root !== undefined || env.workspace_tree !== undefined) {
						console.log(`[beilu-preset] Round 1: workspace_root="${env.workspace_root || ''}", workspace_tree=${env.workspace_tree ? env.workspace_tree.length + '字符' : '(空)'}`);
					}

					// 清空原始模块（预设将完全接管）
					if (prompt_struct.char_prompt) {
						prompt_struct.char_prompt.text = [];
						prompt_struct.char_prompt.additional_chat_log = [];
					}
					if (prompt_struct.user_prompt) {
						prompt_struct.user_prompt.text = [];
						prompt_struct.user_prompt.additional_chat_log = [];
					}
					if (prompt_struct.world_prompt) {
						prompt_struct.world_prompt.text = [];
						prompt_struct.world_prompt.additional_chat_log = [];
					}
					// 清空其他插件的 text（但保留 extension）
					for (const [name, prompt] of Object.entries(prompt_struct.plugin_prompts || {})) {
						if (name === 'beilu-preset') continue;
						if (prompt) {
							prompt.text = [];
							prompt.additional_chat_log = [];
						}
					}

					// 将收集到的 env 存入 extension，供 Round 2 使用
					my_prompt.extension = my_prompt.extension || {};
					my_prompt.extension._collected_env = env;

					return;
				}

				// ================================================================
				// Round 2 (detail_level=1): 用预设条目重建消息序列
				// ================================================================
				if (detail_level === 1) {
					const env = my_prompt.extension?._collected_env;
					if (!env) {
						console.warn('[beilu-preset] Round 2: 未找到 Round 1 收集的环境数据');
						return;
					}

					// 检查其他插件是否在 Round 1 之后写入了新内容（处理并行竞态）
					for (const [name, prompt] of Object.entries(prompt_struct.plugin_prompts || {})) {
						if (name === 'beilu-preset') continue;
						const newContent = flattenPromptTexts(prompt);
						if (newContent && !env[`plugin_${name}`]) {
							env[`plugin_${name}`] = newContent;
							// 清空新写入的内容
							if (prompt) {
								prompt.text = [];
								prompt.additional_chat_log = [];
							}
						}
					}

					// 上下文屏蔽：根据运行时参数截取 chat_log
					let chatLog = prompt_struct.chat_log || [];
					if (runtimeParams.context_msg_limit > 0 && chatLog.length > runtimeParams.context_msg_limit) {
						chatLog = chatLog.slice(-runtimeParams.context_msg_limit);
						prompt_struct.chat_log = chatLog;
						console.log(`[beilu-preset] 上下文屏蔽: 保留最近 ${runtimeParams.context_msg_limit} 条消息（原 ${prompt_struct.chat_log?.length || 0} 条）`);
					}
	
					// 调用引擎的 buildAllEntries
					const { beforeChat, afterChat, injectionAbove, injectionBelow } = engine.buildAllEntries(
						env, macroMemory, chatLog
					);
	
					// ---- 处理 beilu-worldbook 的 @depth 注入条目 ----
					const wbDepthInjections = my_prompt.extension?._worldbook_depth_injections;
					if (Array.isArray(wbDepthInjections) && wbDepthInjections.length > 0) {
						for (const inj of wbDepthInjections) {
							const msg = {
								role: inj.role || 'system',
								name: 'world_info',
								identifier: 'worldbook_depth',
								content: inj.content,
								depth: inj.depth ?? 4,
							};
							if ((inj.depth ?? 4) >= 1) {
								injectionAbove.push(msg);
							} else {
								injectionBelow.push(msg);
							}
						}
					}

					// 将其他插件的内容（Round 1 收集的 env.plugin_* ）追加到注入区域
						// buildAllEntries 只处理 ST 预设条目，不处理 plugin_* 键
						// 不追加则这些内容会在 Round 1 清空后彻底丢失
						for (const [key, value] of Object.entries(env)) {
							if (key.startsWith('plugin_') && value && value.trim()) {
								// 检查 beilu-memory 是否提供了 depth 注入信息
								const pluginName = key.replace('plugin_', '')
								const pluginPrompt = prompt_struct.plugin_prompts?.[pluginName]
								const memoryDepthInjections = pluginPrompt?.extension?.memory_depth_injections
	
								if (pluginName === 'beilu-memory' && memoryDepthInjections && memoryDepthInjections.length > 0) {
									// beilu-memory 提供了带 depth 的注入条目
									// 按 depth 分配到 injectionAbove (depth>=1) 或 injectionBelow (depth=0)
									// 先按 order 排序
									const sorted = [...memoryDepthInjections].sort((a, b) => (a.order || 0) - (b.order || 0))
									for (const depthInj of sorted) {
										// 对注入内容执行宏替换（支持 {{workspace_tree}} 等自定义宏）
										let injContent = depthInj.content
										try {
											injContent = evaluateMacros(injContent, env, macroMemory, chatLog)
										} catch (e) {
											console.warn(`[beilu-preset] 记忆注入宏替换失败 (${depthInj.id}):`, e.message)
										}
										const msg = {
											role: depthInj.role || 'system',
											name: `memory_${depthInj.id}`,
											identifier: `memory_${depthInj.id}`,
											content: injContent,
											depth: depthInj.depth ?? 0,
										}
										if (depthInj.depth >= 1) {
											injectionAbove.push(msg)
										} else {
											injectionBelow.push(msg)
										}
									}
								} else {
									// 其他插件：全部放入 injectionBelow（保持原有行为）
									injectionBelow.push({
										role: 'system',
										name: pluginName,
										identifier: key,
										content: value,
									});
								}
							}
						}
	
					// 将结果写入 extension（供 Gemini/Proxy StructCall 读取）
					// beforeChat: chatHistory marker 之前的预设条目（头部，system only）
					// afterChat: chatHistory marker 之后的预设条目（尾部，system only）
					// injectionAbove: @D>=1 的注入条目（聊天记录上方，可选 role）
					// injectionBelow: @D=0 的注入条目（聊天记录下方，可选 role）
					my_prompt.extension.beilu_preset_before = beforeChat;
					my_prompt.extension.beilu_preset_after = afterChat;
					my_prompt.extension.beilu_injection_above = injectionAbove;
					my_prompt.extension.beilu_injection_below = injectionBelow;
					// 向后兼容：beilu_preset_messages 合并 before+after
					my_prompt.extension.beilu_preset_messages = [...beforeChat, ...afterChat];
					// 向后兼容：beilu_injection_messages 合并 above+below
					my_prompt.extension.beilu_injection_messages = [...injectionAbove, ...injectionBelow];
					my_prompt.extension.beilu_model_params = {
							...engine.modelParams,
							stream: runtimeParams.stream,
							prompt_post_processing: runtimeParams.prompt_post_processing,
							prefill_enabled: runtimeParams.prefill_enabled,
							claude_prefill_enabled: runtimeParams.claude_prefill_enabled,
							continue_prefill: runtimeParams.continue_prefill,
						};

					return;
				}

				// ================================================================
				// Round 3 (detail_level=0): 注入 + 快照
				// ================================================================
				if (detail_level === 0) {
					// 注入简化方案：不再按细粒度 depth 插入 chat_log
					// injectionAbove 和 injectionBelow 作为独立区域传递给 serviceGenerator
					// serviceGenerator 负责将它们放在聊天记录的上方/下方
					// 这里不再修改 chat_log，避免 ephemeral 条目的复杂性

					// 捕获提示词快照
					try {
						lastPromptSnapshot = buildCommanderSnapshot(
							prompt_struct, my_prompt, engine
						);
					} catch (e) {
						console.warn('[beilu-preset] 快照捕获失败:', e.message);
					}
				}
			},
		},
	},
};

export default pluginExport;

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 将当前引擎状态同步到 configData 的激活预设
 */
function syncActivePresetToConfig() {
	const name = configData.active_preset;
	if (!name) return;

	if (!configData.presets[name]) {
		configData.presets[name] = {};
	}

	configData.presets[name].preset_json = engine.toJSON();
	configData.presets[name].model_params = { ...engine.modelParams };
	configData.presets[name].macro_variables = { ...macroMemory.variables };
}

/**
 * 从 prompt_struct_t 构建宏替换环境（基础字段）
 * 注意：司令员模式下，模块内容宏（char_prompt 等）在 TweakPrompt Round 1 中添加
 * @param {object} ps
 * @returns {object}
 */
function buildMacroEnvFromPromptStruct(ps) {
	const chatLog = ps.chat_log || [];
	return {
		user: ps.UserCharname || 'User',
		char: ps.Charname || 'Character',
		group: '',
		model: '',
		lastMessage: findLast(chatLog, null),
		lastUserMessage: findLast(chatLog, 'user'),
		lastCharMessage: findLast(chatLog, 'assistant'),
	};
}

/**
 * 将 single_part_prompt_t 的 text[] 扁平化为单个字符串
 * @param {object} prompt - single_part_prompt_t
 * @returns {string}
 */
function flattenPromptTexts(prompt) {
	if (!prompt?.text || !Array.isArray(prompt.text)) return '';
	return prompt.text
		.filter(t => t.content)
		.map(t => t.content)
		.join('\n');
}

/**
 * 查找聊天记录中最后一条匹配角色的消息
 * @param {Array} chatLog
 * @param {string|null} role
 * @returns {string}
 */
function findLast(chatLog, role) {
	if (!chatLog?.length) return '';
	for (let i = chatLog.length - 1; i >= 0; i--) {
		const msg = chatLog[i];
		if (msg.extension?.ephemeral) continue;
		if (role === null || msg.role === role) {
			return msg.content || '';
		}
	}
	return '';
}

// ============================================================
// 司令员模式快照构建
// ============================================================

/**
 * 构建司令员模式的调试快照
 * @param {object} ps - prompt_struct_t（TweakPrompt 最后一轮结束后的状态）
 * @param {object} myPrompt - beilu-preset 的 single_part_prompt_t
 * @param {object} engineRef - PresetEngine 实例
 * @returns {object} 快照数据
 */
function buildCommanderSnapshot(ps, myPrompt, engineRef) {
	const now = new Date();
	const beforeChat = myPrompt.extension?.beilu_preset_before || [];
	const afterChat = myPrompt.extension?.beilu_preset_after || [];
	const injectionAbove = myPrompt.extension?.beilu_injection_above || [];
	const injectionBelow = myPrompt.extension?.beilu_injection_below || [];
	const allPresetMessages = [...beforeChat, ...afterChat];
	const allInjectionMessages = [...injectionAbove, ...injectionBelow];

	// ---- 预设区条目统计 ----
	const presetEntries = allPresetMessages.map(msg => ({
		name: msg.name,
		role: msg.role,
		identifier: msg.identifier,
		chars: msg.content?.length || 0,
		is_marker: !!msg.is_marker,
		preview: (msg.content || '').substring(0, 120),
	}));
	const presetTotalChars = presetEntries.reduce((sum, e) => sum + e.chars, 0);

	// ---- 注入式条目统计（分上下） ----
	const injAboveEntries = injectionAbove.map(msg => ({
		name: msg.name,
		role: msg.role,
		position: 'above',
		identifier: msg.identifier,
		chars: msg.content?.length || 0,
		preview: (msg.content || '').substring(0, 120),
	}));
	const injBelowEntries = injectionBelow.map(msg => ({
		name: msg.name,
		role: msg.role,
		position: 'below',
		identifier: msg.identifier,
		chars: msg.content?.length || 0,
		preview: (msg.content || '').substring(0, 120),
	}));
	const injectionTotalChars = allInjectionMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

	// ---- 聊天记录统计 ----
	const chatLog = ps.chat_log || [];
	const chatLogChars = chatLog.reduce((sum, m) => sum + (m.content?.length || 0), 0);

	// ---- 汇总 ----
	const totalChars = presetTotalChars + injectionTotalChars + chatLogChars;

	return {
		timestamp: now.toISOString(),
		charname: ps.Charname || '',
		username: ps.UserCharname || '',
		preset_name: engineRef.presetName || '',
		commander_mode: true,

		// 预设区条目
		preset_entries: presetEntries,
		preset_total_chars: presetTotalChars,
		preset_count: presetEntries.length,

		// 注入式条目（分上下）
		injection_above_entries: injAboveEntries,
		injection_below_entries: injBelowEntries,
		injection_above_count: injAboveEntries.length,
		injection_below_count: injBelowEntries.length,
		injection_total_chars: injectionTotalChars,

		// 聊天记录统计
		chat_log: {
			total: chatLog.length,
			recent: chatLog.slice(-5).map(m => ({
				role: m.role,
				name: m.name || '',
				preview: (m.content || '').substring(0, 80),
			})),
		},

		// 汇总
		total_chars: totalChars,
		chat_log_chars: chatLogChars,
		estimated_tokens: Math.round(totalChars / 3.5),

		// 模型参数
		model_params: myPrompt.extension?.beilu_model_params || {},

		// 分段统计
		before_chat_count: beforeChat.length,
		after_chat_count: afterChat.length,
		injection_above_count_stat: injectionAbove.length,
		injection_below_count_stat: injectionBelow.length,
	};
}
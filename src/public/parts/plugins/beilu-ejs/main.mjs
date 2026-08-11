/**
 * beilu-ejs — EJS 模板渲染插件（对标 ST-Prompt-Template）。不管变量累积/解析（那是 beilu-mvu 的事）。
 *
 * [2026-08-06 框架化] 实现体从 yonban/core/functions/sandbox/main.mjs 迁回本 part 目录（凛倾拍板
 *   "改成框架,而不是耦合核心"）。改动仅 5 处 import 路径（path_confine/auth 指 yonban 绝对层级、
 *   info 改同目录、safeJsonIO/wbStub 层级恰好相同零改动），其余逐字保持。
 *   core 侧 functions/sandbox/index.mjs 保留为 dispatch 收口 facade，改指本文件（单实例：同一物理 URL）。
 *   partpath 'plugins/beilu-ejs' 不变 → security_policy.mjs owner 闸键继续命中。
 *
 * 链路：
 *   TweakPrompt(dl=0, 最后一轮) → getVariablesFromContext(读 mvu_accumulated 或 chatLog)
 *     → renderEjsInPromptStruct → 收集六大来源所有含 '<% ' 的模板
 *     → runEjsInWorker（权限全关 Deno Worker）/ renderOptOutMainThread（owner opt-out）
 *     → 回填结果
 *
 * 影响：直接修改 prompt_struct 内各处 content（原地回填渲染结果）；worker 失败/超时 → 保持原文
 * 相交：← beilu-mvu GetPrompt 传 extension.mvu_accumulated.stat_data
 *       ← beilu-worldbook TweakPrompt(dl=2) 已注入世界书条目（含 EJS 模板）
 *       → ejs-context.mjs buildEjsContext / _substituteMacros（主线程 opt-out 与 worker 单源）
 *       → ejs-worker.mjs（权限全关 Worker 沙箱）
 *
 * 安全模型：
 *   默认：per-call Worker(permissions:'none') → SSTI 无法落地 I/O，超时 terminate 强杀
 *   opt-out：owner 级 sandboxOptOut + deployGatedAllow → 主线程 ejs.render（有 RCE 风险）
 *
 * 对标：prepareContext→buildEjsContext / evalTemplate→renderEjsTemplate / processGenerateAfter→renderEjsInPromptStruct
 */

import YAML from 'npm:yaml';
import { writeFile, mkdir } from 'node:fs/promises'; // [0731 根修] 配置落盘（范式同 beilu-browser）
import { readJsonSafeSync } from '../../../../scripts/safeJsonIO.mjs'; // [0731 根修] 配置读回（损坏备份后抛）

import { deployGatedAllow } from '../../../../yonban/core/functions/security/path_confine.mjs';
import { authenticate } from '../../../../yonban/core/functions/security/auth.mjs'; // A2-3：HTTP 端点鉴权中间件（未认证→401），与全站 router.get/post(path, authenticate, handler) 同型
import info from './info.json' with { type: 'json' };
import { wbT, wbD } from "../../../../server/wbStub.mjs";

// SEC-R1/A3：sandboxOptOut 经 config.SetData 可被任一登录用户翻（part 配置端点无 owner 闸），
//   翻成 true 即全员主线程 ejs.render = SSTI→RCE 复活。框架级中和：opt-out 的【生效】走
//   deployGatedAllow —— local（owner 自己机器）放行；server 多用户下，除非 owner 显式设
//   config.allowEjsSandboxOptOut=true（或 env BEILU_EJS_OPTOUT=on），否则沙箱强制保持开，
//   非 owner 经 setdata 翻的 sandboxOptOut 不生效。与 T12/T13 同一单一权威闸。
const _ejsOptOutEffective = () => sandboxOptOut && deployGatedAllow('allowEjsSandboxOptOut', 'BEILU_EJS_OPTOUT');

// ============================================================
// §0 SSTI 沙箱配置（凛倾要求：全部安全行为可用户自己设置；沙箱默认必开）
// ============================================================
// 渲染整段在权限全关的 Deno Worker 内执行，主线程不再执行 ejs.render。
// 这些值可经 config.SetData 调整；sandboxOptOut 默认 false（安全）。
let sandboxTimeoutMs = 3000;   // worker 超时（默认 3000ms）；正常 ST 模板 <50ms
let sandboxOptOut = false;     // owner 级关闭沙箱开关；默认 false=沙箱开。开启需显式且 console 警告。

// [0731 凛倾拍板"这两个默认关闭"] EJS/MVU 是酒馆角色卡适配件，默认关闭（opt-in）：
//   不用 ST 卡的用户零渲染零日志；需要时在 AIRP 脚本插件管理打开（落盘持久）。
let pluginEnabled = false;

// 【红线·0731 凛倾"我ejs都关闭了哪来的ejs/哪里来的硬开启"】enabled 等配置禁止纯内存态：
//   SetData 只改内存变量=重启即回默认 true=硬开启，用户关了照样每轮渲染 chat_log（含 <% 的聊天
//   内容被当模板改写=污染发给 AI 的正文）。配置必须落盘+模块加载读回（范式同 beilu-browser
//   data/browser-config.json）。开关唯一 UI=AIRP 脚本插件管理（pluginManager.mjs）。
const CONFIG_PERSIST_FILE = 'data/ejs-config.json';
try {
	const _saved = readJsonSafeSync(CONFIG_PERSIST_FILE, {});
	if (typeof _saved.enabled === 'boolean') pluginEnabled = _saved.enabled;
	if (Number.isFinite(Number(_saved.sandboxTimeoutMs)) && Number(_saved.sandboxTimeoutMs) >= 100) sandboxTimeoutMs = Number(_saved.sandboxTimeoutMs);
	if (typeof _saved.sandboxOptOut === 'boolean') sandboxOptOut = _saved.sandboxOptOut;
} catch (e) {
	console.warn(`[beilu-ejs] ${CONFIG_PERSIST_FILE} 损坏（已备份 .corrupt.bak，用默认值继续）:`, e?.message || e);
}
let _cfgPersistTimer = null;
function _persistConfig() {
	if (_cfgPersistTimer) clearTimeout(_cfgPersistTimer);
	_cfgPersistTimer = setTimeout(async () => {
		_cfgPersistTimer = null;
		try {
			await mkdir('data', { recursive: true }).catch(() => {});
			await writeFile(CONFIG_PERSIST_FILE, JSON.stringify({ enabled: pluginEnabled, sandboxTimeoutMs, sandboxOptOut }, null, 2), 'utf8');
		} catch (err) {
			console.warn('[beilu-ejs] 配置持久化失败:', err?.message || err);
		}
	}, 100);
}

// ============================================================
// §1 SSTI 沙箱：Worker 调用器（渲染整段在权限全关的 Deno Worker 内执行）
// ============================================================
//
// 安全模型：
//   - 模板渲染（含 ejs.render）一律移进 permissions:'none' 的 Deno Worker。
//     模板内 globalThis.Deno.* 调用全部 PermissionDenied，SSTI 无法落地 I/O。
//   - per-call worker：每次 TweakPrompt 新建一个、用完 terminate。
//     超时 terminate 强杀整线程，连带杀死死循环 / ReDoS 卡死的同步代码。
//   - 安全降级：worker 不可用 / 超时 / 出错 → 返回原模板文本（不渲染），
//     **绝不自动 fallback 主线程执行**（那等于漏洞复活）。
//
// buildEjsContext / _substituteMacros 已抽到 ejs-context.mjs（主线程 opt-out 与 worker 单源）。

/**
 * 在权限全关 Worker 内批量渲染模板。
 *
 * 链路：renderEjsInPromptStruct → 本函数 → new Worker(ejs-worker.mjs, {permissions:'none'})
 * 影响：per-call worker（每次新建、用完 terminate），不留驻
 * 约束：
 *   - 超时(sandboxTimeoutMs, 默认 3000ms) → terminate 强杀 → 返回 null → 上层保持原文
 *   - Worker 构造失败 → 返回 null → 上层保持原文（绝不自动 fallback 主线程）
 *   - 需运行时带 --unstable-worker-options 才能使 deno.permissions 生效（D1 实测）
 *
 * @param {{templates:{content:string,where:string}[], statData:object, charName:string, userName:string, chatId:string, chatLogLite:{role,content}[]}} input
 * @returns {Promise<string[]|null>} 渲染结果数组；null 表示 worker 失败/超时（上层降级原文）。
 */
function runEjsInWorker(input) {
	return new Promise((resolve) => {
		let worker = null;
		let done = false;
		const finish = (val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { worker && worker.terminate(); } catch {}
			resolve(val);
		};
		const timer = setTimeout(() => {
			// 超时（死循环 / ReDoS / 卡死）→ terminate 强杀，降级原文
			console.error(`[beilu-ejs] EJS 沙箱 worker 超时 ${sandboxTimeoutMs}ms，已 terminate，模板返回原文`);
			finish(null);
		}, sandboxTimeoutMs);
		try {
			// 注意：deno.permissions 需运行时带 --unstable-worker-options 才生效（D1 实测，Deno 2.8.3）。
			worker = new Worker(new URL('./ejs-worker.mjs', import.meta.url).href, {
				type: 'module',
				deno: { permissions: 'none' },
			});
			worker.onmessage = (e) => {
				const data = e?.data || {};
				finish(data.error ? null : (Array.isArray(data.results) ? data.results : null));
			};
			worker.onerror = () => finish(null);      // 降级
			worker.postMessage(input);
		} catch (err) {
			console.error('[beilu-ejs] EJS 沙箱 worker 构造失败，模板返回原文:', err?.message || err);
			finish(null);
		}
	});
}

// ---- owner 级 opt-out：显式关闭沙箱后的主线程渲染（默认关闭，开启需 console 警告）----
// 仅当 sandboxOptOut===true 时使用。此路径会在主进程执行 ejs.render（有 RCE 风险），
// 故默认禁用、开启时已在 SetData 打出醒目警告。失败/未启用一律不走此路径。
let _otIn = false, _otEjs = null, _otLo = null, _otCtx = null;
async function _ensureOptOutDeps() {
	if (_otEjs && _otLo && _otCtx) return;
	const [ejsMod, loMod, ctxMod] = await Promise.all([
		import('npm:ejs'), import('npm:lodash-es'), import('./ejs-context.mjs'),
	]);
	_otEjs = ejsMod.default || ejsMod;
	_otLo = loMod.default || loMod;
	_otCtx = ctxMod;
}
async function renderOptOutMainThread(input) {
	await _ensureOptOutDeps();
	const lightArg = { chat_id: input.chatId, chat_log: input.chatLogLite, Charname: input.charName, UserCharname: input.userName };
	const context = _otCtx.buildEjsContext(_otLo, input.statData, lightArg, undefined);
	return input.templates.map((t) => {
		const tpl = t?.content;
		if (typeof tpl !== 'string' || !tpl.includes('<%')) return tpl;
		try {
			const processed = _otCtx._substituteMacros(tpl, context.charName, context.userName, context.variables);
			return _otEjs.render(processed, context, { async: false, outputFunctionName: 'print', rmWhitespace: false });
		} catch (e) {
			console.error(`[beilu-ejs] (opt-out 主线程) EJS 渲染失败 (${t?.where}):`, e?.message);
			return tpl;
		}
	});
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
 * 两段式（async）：
 *   1. 收集阶段：遍历六大来源，凡 content.includes('<%') 的 item 推入 jobs（保留 item 引用）；无 '<%' 计 skipped。
 *   2. 渲染阶段：一次性把所有模板送进权限全关 Worker（或 opt-out 时主线程），按序回填。
 *      worker 失败/超时/缺结果 → 该 item 保持原文（降级，不渲染）。
 *
 * @param {object} prompt_struct - prompt_struct_t
 * @param {object} renderInputs - { statData, charName, userName, chatId, chatLogLite }
 * @returns {Promise<{ rendered: number, skipped: number }>} 渲染统计
 */
async function renderEjsInPromptStruct(prompt_struct, renderInputs) {
	let rendered = 0;
	let skipped = 0;
	// [0807 白盒] 分源计数：where 首段分桶（commander:* 四段=司令员载体；全 0=收集扑空可定位断源）
	const bySource = {};

	// ---- 1. 收集阶段 ----
	const jobs = []; // { ref, key, where }，ref 为含 content 的对象（item 或 chat_log entry）

	const collect = (textArr, source) => {
		if (!Array.isArray(textArr)) return;
		for (const item of textArr) {
			if (typeof item.content !== 'string') continue;
			if (!item.content.includes('<%')) { skipped++; continue; }
			jobs.push({ ref: item, key: 'content', where: source });
			const bucket = source.split('[')[0];
			bySource[bucket] = (bySource[bucket] || 0) + 1;
		}
	};

	collect(prompt_struct.char_prompt?.text, 'char_prompt');                 // 1. char_prompt.text
	collect(prompt_struct.user_prompt?.text, 'user_prompt');                 // 2. user_prompt.text
	collect(prompt_struct.world_prompt?.text, 'world_prompt');               // 3. world_prompt.text
	if (prompt_struct.plugin_prompts) {                                      // 4. plugin_prompts.*.text
		for (const [pName, prompt] of Object.entries(prompt_struct.plugin_prompts))
			collect(prompt?.text, `plugin:${pName}`);
	}
	// 7. [0807 司令员链修复] 司令员模式最终载体：preset Round1(dl=2) 清空上面六大来源的 text 收进
	//   宏环境，Round2(dl=1) 把世界书条目/预设条目重建进这四段（元素 {role,name,identifier,content,...}，
	//   commanderAssembly 按 before→above→chat→below→after 拼最终 messages）——EJS 只扫旧六源=司令员下
	//   恒扑空（rendered=0，世界书 EJS 门控字面全量透传="全部都有"，凛倾 0807 真卡实测确诊）。
	//   collect 复用（元素带 content 字段形状兼容）；渲染后无 '<%' → 重复扫描天然幂等。
	{
		const _presetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension;
		if (_presetExt) {
			collect(_presetExt.beilu_preset_before, 'commander:before');
			collect(_presetExt.beilu_injection_above, 'commander:above');
			collect(_presetExt.beilu_injection_below, 'commander:below');
			collect(_presetExt.beilu_preset_after, 'commander:after');
		}
	}
	if (prompt_struct.other_chars_prompt) {                                  // 5. other_chars_prompt.*.text
		for (const [cName, prompt] of Object.entries(prompt_struct.other_chars_prompt))
			collect(prompt?.text, `other_char:${cName}`);
	}
	// 【红线·0731 凛倾"完全没有按照角色卡和世界书进行隔离"】chat_log 只许渲染【本轮注入】的条目
	//   （worldbook @depth / MVU YAML，注入时带 extension.ephemeral:true——worldbook/main.mjs:1696、
	//   mvu/main.mjs:684），真实聊天正文（用户/AI 历史消息）禁止当模板渲染：聊天里出现 <% 的代码
	//   讨论会被 EJS 改写后发给 AI = 污染正文（0731 事故：无世界书角色卡每轮"1 个模板已渲染"，
	//   渲染对象就是 chat_log[6]/[37] 聊天内容）。EJS 渲染成立条件=①世界书有 EJS 条目②开关开
	//   ③是当前角色卡主世界书——③①由"只收注入条目"结构保证（没绑主世界书就没有注入），②由
	//   pluginEnabled 门控（落盘持久，见 §0）。
	if (Array.isArray(prompt_struct.chat_log)) {                             // 6. chat_log（仅 @depth 注入条目 + MVU YAML）
		for (let i = 0; i < prompt_struct.chat_log.length; i++) {
			const entry = prompt_struct.chat_log[i];
			if (typeof entry.content !== 'string') continue;
			if (entry.extension?.ephemeral !== true) { continue; }  // 真实聊天条目：不渲染也不计 skipped（它们不是模板候选）
			if (!entry.content.includes('<%')) { skipped++; continue; }
			jobs.push({ ref: entry, key: 'content', where: `chat_log[${i}]` });
			bySource['chat_log'] = (bySource['chat_log'] || 0) + 1; // [0807 白盒] ephemeral 注入桶
		}
	}

	if (jobs.length === 0) return { rendered, skipped, bySource };

	// ---- 2. 渲染阶段 ----
	const workerInput = {
		templates: jobs.map((j) => ({ content: j.ref[j.key], where: j.where })),
		statData: renderInputs.statData,
		charName: renderInputs.charName,
		userName: renderInputs.userName,
		chatId: renderInputs.chatId,
		chatLogLite: renderInputs.chatLogLite,
	};

	let results = null;
	if (_ejsOptOutEffective()) {
		// owner 显式关闭沙箱 + 部署模式允许 → 主线程渲染（有 RCE 风险，已在 SetData 警告）。失败仍降级原文。
		try { results = await renderOptOutMainThread(workerInput); } catch { results = null; }
	} else {
		results = await runEjsInWorker(workerInput); // null=失败/超时 → 全部保持原文；沙箱强制开（server 非 owner）
	}

	// ---- 3. 回填阶段 ----
	if (Array.isArray(results)) {
		for (let k = 0; k < jobs.length; k++) {
			const out = results[k];
			if (typeof out !== 'string') continue;        // 缺结果 → 保持原文
			const j = jobs[k];
			const before = j.ref[j.key];
			if (out !== before) { j.ref[j.key] = out; rendered++; }
		}
	}
	// results 为 null：worker 失败/超时 → 不回填，全部保持原文（安全降级）

	return { rendered, skipped, bySource };
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
	// [0807 白盒] 返回 {statData, source}：来源标签进 wbT，实测时"变量从哪来/有没有"直接可见
	// 方式1: 从 beilu-mvu 的 GetPrompt 返回值读取
	const mvuPrompt = prompt_struct?.plugin_prompts?.['beilu-mvu'];
	const mvuAccumulated = mvuPrompt?.extension?.mvu_accumulated;
	if (mvuAccumulated?.stat_data) {
		return { statData: mvuAccumulated.stat_data, source: 'mvu_accumulated' };
	}

	// 方式2: 从 chatLog 倒序查找
	const chatLog = arg?.chat_log || [];
	for (let i = chatLog.length - 1; i >= 0; i--) {
		const vars = chatLog[i]?.extension?.mvu_variables;
		if (vars?.stat_data && typeof vars.stat_data === 'object') {
			return { statData: vars.stat_data, source: `chat_log[${i}]` };
		}
		// 兼容：变量直接存储在 mvu_variables 中（无 stat_data 层级）
		if (vars && typeof vars === 'object' && Object.keys(vars).length > 0 && !vars.stat_data) {
			return { statData: vars, source: `chat_log[${i}]:flat` };
		}
	}

	return { statData: null, source: 'none' };
}

// ============================================================
// §6 插件主体
// ============================================================

const pluginExport = {
	info,

	Load: async ({ router }) => {
		console.log('[beilu-ejs] EJS 模板渲染插件加载中...');

		router.get("/api/parts/plugins\\:beilu-ejs/config/getdata", authenticate, async (_req, res) => { // A2-3：补鉴权——杜绝匿名读 EJS 沙箱配置
			try { res.json(await pluginExport.interfaces.config.GetData()); }
			catch (err) { res.status(500).json({ error: err.message }); }
		});

		router.post("/api/parts/plugins\\:beilu-ejs/config/setdata", authenticate, async (req, res) => { // A2-3：补鉴权——杜绝匿名写 EJS 沙箱配置（sandboxOptOut 等安全项）
			try { res.json(await pluginExport.interfaces.config.SetData(req.body) || { success: true }); }
			catch (err) { res.status(500).json({ error: err.message }); }
		});

		console.log('[beilu-ejs] EJS 模板渲染插件已加载');
	},

	Unload: async () => {
		console.log('[beilu-ejs] EJS 模板渲染插件已卸载');
	},

	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginEnabled,
				// SSTI 沙箱配置（凛倾：全部安全行为可用户自己设置；沙箱默认必开）
				sandboxTimeoutMs,
				sandboxOptOut,
				// 控件元数据单源下发（0722 凛倾拍板"ejs做"）：前端设置面纯渲染。
				// sandboxOptOut 的【生效】仍受 deployGatedAllow 单一权威闸（:35）——前端翻开关
				// 只改配置值；server 多用户下非 owner 翻了不生效，安全语义不因暴露 UI 而改变。
				meta: [
					{ key: 'enabled', group: '基础设置', type: 'toggle', label: '启用 EJS 模板渲染', desc: '渲染世界书/角色卡等注入内容里的 EJS 模板（SillyTavern Prompt-Template 兼容）' },
					{ key: 'sandboxTimeoutMs', group: '沙箱', type: 'number', label: '沙箱超时 (ms)', desc: '模板渲染 Worker 的最大执行时间，超时强杀并保持原文', min: 100, max: 60000, step: 100 },
					{ key: 'sandboxOptOut', group: '沙箱', type: 'toggle', label: '关闭沙箱（危险）', desc: '⚠ 关闭后模板在主进程执行，恶意世界书/角色卡可读写文件、执行命令（RCE）。仅在完全信任所有模板来源时开启；多用户部署下非拥有者开启不生效' },
				],
			}),

			SetData: async (data) => {
				if (data?.enabled !== undefined) {
					pluginEnabled = !!data.enabled;
					console.log(`[beilu-ejs] 插件${pluginEnabled ? '已启用' : '已禁用'}`);
				}
				// worker 超时（默认 3000ms），下限 100ms 防误设 0 导致永远超时
				if (data?.sandboxTimeoutMs !== undefined) {
					const t = Number(data.sandboxTimeoutMs);
					if (Number.isFinite(t) && t >= 100) {
						sandboxTimeoutMs = t;
						console.log(`[beilu-ejs] EJS 沙箱 worker 超时已设为 ${sandboxTimeoutMs}ms`);
					} else {
						console.warn(`[beilu-ejs] 忽略非法 sandboxTimeoutMs=${data.sandboxTimeoutMs}（需 >=100 的数字），保持 ${sandboxTimeoutMs}ms`);
					}
				}
				// owner 级 opt-out：默认 false=沙箱开。开启需显式 true 且打醒目警告。
				if (data?.sandboxOptOut !== undefined) {
					sandboxOptOut = !!data.sandboxOptOut;
					if (sandboxOptOut) {
						console.warn('================ [beilu-ejs] 安全警告 ================');
						console.warn('[beilu-ejs] EJS 沙箱已被显式关闭（sandboxOptOut=true）！');
						console.warn('[beilu-ejs] 模板将在主进程执行，存在 SSTI→RCE 风险，');
						console.warn('[beilu-ejs] 恶意世界书/角色卡可读写文件、执行命令。仅在完全信任所有模板来源时使用。');
						console.warn('=====================================================');
					} else {
						console.log('[beilu-ejs] EJS 沙箱已启用（sandboxOptOut=false，安全默认）');
					}
				}
				// [0731 根修] 每次 SetData 落盘（防重启回默认=硬开启，红线见 §0 CONFIG_PERSIST_FILE 处）
				_persistConfig();
			},
		},

		chat: {
			/**
			 * GetPrompt — 不产生额外提示词
			 *
			 * beilu-ejs 不需要向 AI 注入自己的内容，
			 * 它只负责渲染其他插件（尤其是 beilu-worldbook）注入的 EJS 模板。
			 * ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText，操作说明走 INJ 条目。
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
			 * 流程（沙箱化，async）:
			 * 1. 从 beilu-mvu 的 extension 或 chatLog 获取变量数据 + 拆 worker 输入字段
			 * 2. 把所有含 <% 的模板送进权限全关 Worker 渲染（对标 prepareContext + evalTemplate）
			 * 3. 回填结果；worker 失败/超时 → 保持原文（安全降级）
			 *
			 * 改 async：prompt_struct.mjs 的 Promise.all 会 await 各插件 TweakPrompt 返回值，
			 * 渲染完成才进下一 detail_level 轮（beilu-regex 已是 async 先例）。
			 */
			TweakPrompt: async (arg, prompt_struct, my_prompt, detail_level) => {
				// 在 detail_level=0 执行（最后一轮，所有注入已完成）
				// [2026-08-01 批① sandbox 零失效修] worker isolate 的 pluginEnabled 是 import 时快照，
				//   主 isolate SetData 改了 let 变量 + 落盘，worker 的 let 不更新 = 关了照渲染（EJS 红线复发口）。
				//   每轮渲染前从盘文件读一次 enabled 同步本 isolate 的 let（1次 JSON.parse 开销 < 渲染本身万分之一）。
				try { const _diskCfg = readJsonSafeSync(CONFIG_PERSIST_FILE, {}); if (typeof _diskCfg.enabled === 'boolean') pluginEnabled = _diskCfg.enabled; } catch {}
				if (detail_level !== 0 || !pluginEnabled) return;

				const _wbChatId = arg?.chat_id || null;
				wbT(_wbChatId, 'ejs:tweakprompt', 'enter', { detail_level });

				// 获取变量数据（[0807 白盒] 带来源标签）
				const { statData, source: statSource } = getVariablesFromContext(prompt_struct, arg);
				// 顶层键名前 8 个：实测时"好感度在不在变量里"直接可见
				const statKeys = statData ? Object.keys(statData).slice(0, 8) : [];

				// 拆出 worker 输入：context 构建移入 worker（buildEjsContext 不在主线程调用）。
				// 即使没有 MVU 变量也可能有纯 EJS 模板，statData 空对象时 getvar 返回 defaults。
				const renderInputs = {
					statData: statData || {},
					charName: arg.Charname || prompt_struct?.Charname || 'Character',
					userName: arg.UserCharname || prompt_struct?.UserCharname || 'User',
					chatId: arg.chat_id || '',
					// 只传 role+content 两字段（getter 仅用这两项）；非字符串 content 归一为 ''，保证可结构化克隆
					chatLogLite: (arg.chat_log || []).map((m) => ({ role: m?.role, content: typeof m?.content === 'string' ? m.content : '' })),
				};

				// 执行 EJS 渲染（沙箱）
				wbT(_wbChatId, 'ejs:tweakprompt', 'render_start', { hasStatData: !!statData, statSource, statKeys });
				const stats = await renderEjsInPromptStruct(prompt_struct, renderInputs);
				wbT(_wbChatId, 'ejs:tweakprompt', 'render_done', { rendered: stats.rendered, skipped: stats.skipped, bySource: stats.bySource, statSource });
				// [0807 白盒] no_change 带全量定位信息：bySource 全 0=收集扑空（源断）；有收集但 rendered=0=渲染层失败
				if (stats.rendered === 0) wbT(_wbChatId, 'ejs:tweakprompt', 'no_change', { skipped: stats.skipped, bySource: stats.bySource, statSource, statKeys });

				if (stats.rendered > 0) {
					console.log(`[beilu-ejs] EJS 渲染完成: ${stats.rendered} 个模板已渲染, ${stats.skipped} 个无模板跳过`);
				}
			},
		},
	},
};

export default pluginExport;

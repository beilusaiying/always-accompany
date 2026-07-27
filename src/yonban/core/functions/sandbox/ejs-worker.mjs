/**
 * beilu-ejs — SSTI 沙箱 Worker
 *
 * 在权限全关（permissions:'none'）的 Deno Worker 内执行 ejs.render。
 * 模板内任何 `globalThis.Deno.*` 调用都会触发 PermissionDenied，
 * SSTI 无法落地 I/O —— 这是隔离的本质（不是过滤 context 字段）。
 *
 * 关键 runtime 事实（D1 实测，Deno 2.8.3 + nodeModulesDir:auto）：
 *   - 顶层静态 `import x from 'npm:ejs'` 在 worker 初始模块图阶段会 HANG（不报错、不完成）。
 *   - 改用 **动态** `await import('npm:ejs')` 则 permissions:'none' 下正常加载并缓存。
 *   故此处一律用动态 import，模块级缓存，首条消息加载、后续走缓存。
 *
 * 渲染语义与原 main.mjs renderEjsTemplate 逐条对齐：
 *   - !includes('<%') 跳过
 *   - _substituteMacros 预处理
 *   - ejs.render(processed, context, {async:false, outputFunctionName:'print', rmWhitespace:false})
 *   - 单条失败 try/catch 回退该条原文
 */

import { buildEjsContext, _substituteMacros } from './ejs-context.mjs';

let _ejs = null;
let _lodash = null;

async function ensureDeps() {
	if (_ejs && _lodash) return;
	// 动态 import（见文件头：静态 import 在 worker 会 hang）。permissions:'none' 下仍可加载初始静态图依赖。
	const [ejsMod, loMod] = await Promise.all([
		import('npm:ejs'),
		import('npm:lodash-es'),
	]);
	_ejs = ejsMod.default || ejsMod;
	_lodash = loMod.default || loMod;
}

function renderOne(_, ejs, template, context, where) {
	if (typeof template !== 'string') return template;
	if (!template.includes('<%')) return template;
	try {
		const processed = _substituteMacros(template, context.charName, context.userName, context.variables);
		return ejs.render(processed, context, {
			async: false,
			outputFunctionName: 'print',
			rmWhitespace: false,
		});
	} catch (e) {
		// 对标原 main.mjs:258 —— 单条失败回退原文
		try { console.error(`[beilu-ejs:worker] EJS 渲染失败 (${where}):`, e?.message); } catch {}
		return template;
	}
}

onmessage = async (e) => {
	const msg = e?.data || {};
	try {
		await ensureDeps();
		const _ = _lodash;
		const ejs = _ejs;

		const { templates = [], statData = {}, charName = 'Character', userName = 'User', chatId = '', chatLogLite = [] } = msg;

		// worker 侧轻量 arg：getter(:chatId/lastMessageId/...) 逻辑与主线程完全一致
		const lightArg = {
			chat_id: chatId,
			chat_log: chatLogLite,
			Charname: charName,
			UserCharname: userName,
		};
		// prompt_struct 传 undefined：buildEjsContext 对它仅用 ?.Charname（已被 lightArg 覆盖）
		const context = buildEjsContext(_, statData, lightArg, undefined);

		const results = new Array(templates.length);
		for (let i = 0; i < templates.length; i++) {
			const t = templates[i] || {};
			results[i] = renderOne(_, ejs, t.content, context, t.where || `t${i}`);
		}
		postMessage({ results });
	} catch (err) {
		postMessage({ error: String(err?.message || err) });
	}
};

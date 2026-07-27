/**
 * modeDef.schema.mjs — ModeDef 校验（T5，设计① §二 schema 的落地版）
 *
 * 【功能链】
 *   loadModeDefs()（runner.mjs）读 modes/*.json → 逐份 validateModeDef(def, registry)
 *   → 不合法=fail loud 抛错（坏 ModeDef 不得进点菜表——静默跳过会让自定义模式"扔进去没反应"无从排查）。
 *
 * 【why】
 *   隐藏任务①（T5 任务 md §九）：「模式不能点没注册的功能」是安全边界不是防御补丁——
 *   ModeDef 是用户可投放的数据（modes/<custom>.json 约定式发现），必须在装载点验 target 在 registry。
 *   校验只管结构与边界，不管业务值（features.config 的键由各功能组自己消费，本层不枚举）。
 *
 * 【影响范围】纯函数，无 IO。
 */

const VALID_HOOK_KEYS = new Set(["request"]); // T5 首版只接请求流；操作/调度流后续批扩展

/**
 * @param {object} def - 一份 modes/<id>.json 的解析结果
 * @param {Map<string, object>} registry - core/dispatch/registry.mjs 的注册表（验 target 存在）
 * @returns {{ok: true} } 合法返回；不合法直接 throw（fail loud）
 */
export function validateModeDef(def, registry) {
	const fail = (msg) => { throw new Error(`[modeDef] ${def?.id ?? "(无id)"}: ${msg}`); };

	if (!def || typeof def !== "object") fail("不是对象");
	if (!def.id || typeof def.id !== "string" || !/^[\w-]+$/.test(def.id)) fail("id 缺失或含非法字符");
	if (def.features && typeof def.features !== "object") fail("features 必须是对象");
	// inj 识别系统 2026-07-13：可选字段——本模式接收哪些 autoMode 注入域（缺省=只吃自己 id 域）
	if (def.injectionScopes !== undefined) {
		if (!Array.isArray(def.injectionScopes) || def.injectionScopes.some((s) => typeof s !== "string" || !/^[\w-]+$/.test(s))) {
			fail("injectionScopes 必须是 [\\w-]+ 字符串数组");
		}
	}
	for (const [lib, f] of Object.entries(def.features ?? {})) {
		if (typeof f !== "object" || typeof f.enabled !== "boolean") fail(`features.${lib} 需要 {enabled:boolean}`);
	}

	if (!def.hooks || typeof def.hooks !== "object") fail("hooks 缺失");
	for (const key of Object.keys(def.hooks)) {
		if (!VALID_HOOK_KEYS.has(key)) fail(`hooks.${key} 不在支持集 ${[...VALID_HOOK_KEYS]}（T5 首版只接请求流）`);
	}
	const req = def.hooks.request;
	if (!Array.isArray(req) || req.length === 0) fail("hooks.request 必须是非空数组");

	for (const [i, step] of req.entries()) {
		// 两种条目：单菜 {target,verb} / tweak 相位 {phase:"tweak", dl:[...], steps:[{target,verb}]}
		const flat = step.phase === "tweak" ? (Array.isArray(step.steps) ? step.steps : fail(`request[${i}] tweak 相位需要 steps 数组`)) : [step];
		if (step.phase === "tweak" && (!Array.isArray(step.dl) || step.dl.some((d) => !Number.isInteger(d)))) {
			fail(`request[${i}] tweak 相位需要整数 dl 数组`);
		}
		for (const s of flat) {
			if (!s.target || !s.verb) fail(`request[${i}] 缺 target/verb`);
			const entry = registry.get(s.target);
			if (!entry) fail(`request[${i}] 点了未注册功能 "${s.target}"（模式只能组合已注册功能——安全边界）`);
			if (entry.transport === "local" && typeof entry.handlers?.[s.verb] !== "function") {
				fail(`request[${i}] "${s.target}" 无 verb "${s.verb}"`);
			}
		}
	}
	return { ok: true };
}

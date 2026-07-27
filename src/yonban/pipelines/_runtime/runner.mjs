/**
 * runner.mjs — 模式层通用执行器（T5，裁决1「内置也数据化」：内置与自定义模式共用本 runner，无 per-mode pipeline.mjs）
 *
 * 【功能链】
 *   激活{scope.mode} → getModeDef(mode)（modes/*.json 约定式发现+schema 校验）
 *   → runRequest(def, ctx)：按 hooks.request 有序清单逐道菜
 *     dispatch({verb, target, source:"pipeline:<mode>", payload, scope}) → 功能节点（不感知模式）
 *   tweak 相位：dl 外层循环（[2,1,0] 司令员三轮）× steps 内层（worldbook/preset 每轮各过一次）。
 *
 * 【why】
 *   模式差异从 getPromptHandler 21 步 if 散点 → 声明式 ModeDef（散点清单 §A~H，14 处真收敛）。
 *   影子期铁则：runner 走【同一批现状函数】（经 facade 转调，零重写）——菜序即现状序，
 *   缓存断点位置由菜序决定（任务 §八专项：乱序=缓存全灭）。features.config 首版只是声明表，
 *   差异行为仍由功能层内部驱动（scope.mode 传入）；切流量批才逐项把 if 移到 config 消费。
 *
 * 【隐藏任务②】pipeline 级缓存只存编排态（本 runner 每次激活重读 def=无常驻编排态；
 *   点菜单快照/步进游标留 cache.mjs 后续批，不复制功能层缓存）。
 *
 * 【影响范围】零流量影子件：无人 import 则啥也不发生；runRequest 的副作用=被点功能自身的副作用。
 */
import fs from "node:fs";
import path from "node:path";
import { dispatch } from "../../core/dispatch/dispatcher.mjs";
import { registry } from "../../core/dispatch/registry.mjs";
import { validateModeDef } from "./modeDef.schema.mjs";

const MODES_DIR = path.join(import.meta.dirname, "../modes");

let _defs = null;

/** 扫 modes/*.json（约定式发现：扔一份 <custom>.json 即被发现）。坏文件 fail loud。 */
export function loadModeDefs({ reload = false } = {}) {
	if (_defs && !reload) return _defs;
	const defs = new Map();
	for (const f of fs.readdirSync(MODES_DIR).filter((n) => n.endsWith(".json")).sort()) {
		const def = JSON.parse(fs.readFileSync(path.join(MODES_DIR, f), "utf-8"));
		validateModeDef(def, registry);
		if (defs.has(def.id)) throw new Error(`[runner] 模式 id 重复: ${def.id}（${f}）`);
		defs.set(def.id, def);
	}
	_defs = defs;
	// T5 收尾：把发现的模式 id 注入 storage 合法集（自定义模式经 bindChatMode/getActiveMode 被认的前提）。
	// fire-and-forget 动态 import：不把 memory 组静态拖进 runner 加载序；注册幂等失败仅告警。
	import("../../core/functions/memory/storage_mod/storage.mjs")
		.then((m) => {
			m.registerModeIds?.([...defs.keys()]);
			// 0716 接线批：同批注入 features 只读镜像（modeFeature 通用读口——功能层硬编码模式门的声明表消费源）
			m.registerModeFeatures?.([...defs.values()]);
		})
		.catch((e) => console.warn(`[runner] registerModeIds/Features 失败: ${e?.message}`));
	// inj 识别系统 2026-07-13：同批把 ModeDef.injectionScopes 注入注入系统注册表
	// （自定义模式声明"我接收哪些 autoMode 域"的数据入口；内置模式已在 injectionSystem 初始表）
	import("../../core/functions/memory/storage_mod/injectionSystem.mjs")
		.then((m) => m.registerInjectionScopes?.([...defs.values()]))
		.catch((e) => console.warn(`[runner] registerInjectionScopes 失败: ${e?.message}`));
	return defs;
}

export function getModeDef(mode) {
	let defs = loadModeDefs();
	// 约定式发现语义：缓存 miss 时重扫一次——运行中扔进 modes/ 的新文件即插即用（步骤6 冒烟实抓）
	if (!defs.has(mode)) defs = loadModeDefs({ reload: true });
	return defs.get(mode) ?? null;
}

/**
 * 按 ModeDef.hooks.request 执行一次请求流点菜。
 * @param {object} def - ModeDef（loadModeDefs 产物）
 * @param {object} ctx - { arg, prompt_struct?, my_prompt?, scope }
 *   arg=GetPrompt 入参（现状 handleGetPrompt(arg) 契约）；tweak 相位需要 prompt_struct/my_prompt。
 * @returns {Promise<{ok:boolean, results:Array<{target,verb,dl?,ok,error?}>, data:object}>}
 *   data 按 verb 收集各菜产物（getPrompt→data.memoryPrompt 等，影子 diff 的对照物）。
 */
export async function runRequest(def, ctx) {
	const results = [];
	const data = {};
	const scope = ctx.scope ?? {};
	const source = `pipeline:${def.id}`;

	const dishEnabled = (target) => {
		// features 开关：菜条目可声明 feature 归属；未声明或未在 features 登记=默认上菜（照抄现状恒跑）
		return (feature) => feature ? def.features?.[feature]?.enabled !== false : true;
	};
	const isOn = dishEnabled();

	for (const step of def.hooks.request) {
		if (step.phase === "tweak") {
			for (const dl of step.dl) {
				for (const s of step.steps) {
					if (!isOn(s.feature)) continue;
					const r = await dispatch({
						verb: s.verb, target: s.target, source,
						payload: { arg: ctx.arg, prompt_struct: ctx.prompt_struct, my_prompt: ctx.my_prompt, detail_level: dl },
						scope,
					});
					results.push({ target: s.target, verb: s.verb, dl, ok: r.ok !== false, error: r.error });
					if (r.ok === false) return { ok: false, results, data }; // fail loud：组装链断一环即停，不带病出站
				}
			}
			continue;
		}
		if (!isOn(step.feature)) continue;
		const r = await dispatch({ verb: step.verb, target: step.target, source, payload: { arg: ctx.arg }, scope });
		results.push({ target: step.target, verb: step.verb, ok: r.ok !== false, error: r.error });
		if (r.ok === false) return { ok: false, results, data };
		if (r.data !== undefined) data[`${step.target}.${step.verb}`] = r.data;
	}
	return { ok: true, results, data };
}

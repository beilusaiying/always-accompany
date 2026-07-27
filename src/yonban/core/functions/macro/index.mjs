/**
 * functions/macro/index.mjs — 宏系统节点 facade（T3a·3.1 已入住：实现体在本组 ./marco.mjs）
 *
 * 【功能链】
 *   dispatch({target:"functions:macro", verb:"evaluateMacros", payload:{content,env,memory?,chatLog?}})
 *   → ./marco.mjs evaluateMacros（ST 兼容宏：{{user}}/{{time}}/{{roll}}/变量宏…）
 *   → { ok, data: 替换后字符串 }。
 *   旧线路：preset_engine.buildSystemPrompts 同步直调 evaluateMacros——经旧位 re-export 薄壳
 *   （plugins/beilu-preset/engine/marco.mjs）到达同一实现，行为等价；T8 消费方切净后删壳。
 *
 * 【why】
 *   凛倾迁移范式：「把相关文件移进去、写一个 index.mjs 做 facade、在旧位置留一个 re-export 做兼容」。
 *   macro = 组13 练手批：纯函数、无状态、零相对依赖（只 npm:crypto-js/droll/moment/seedrandom）。
 *   ST 导入侧 SillyTavern/engine/marco.mjs 功能同类但 stCompat 不可动——只标注归属，不迁不合并。
 *
 * 【影响范围】
 *   纯函数包装，无 IO。消费方（preset_engine.mjs:5 / beilu-preset/main.mjs:27）经旧位薄壳到达本组实现。
 */
import { evaluateMacros } from "./marco.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:macro", {
	transport: "local",
	handlers: {
		async evaluateMacros(payload, _context) {
			const { content, env, memory = {}, chatLog = [] } = payload ?? {};
			return { ok: true, data: evaluateMacros(content, env ?? {}, memory, chatLog) };
		},
	},
});

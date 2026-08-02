/**
 * t1_dispatch_test.mjs — T1 dispatch 通路真单测（Deno 直跑，打印实际输出内容）
 *
 * 跑法：deno run --allow-all src/yonban/_test/t1_dispatch_test.mjs
 * 覆盖：dispatcher 单独导入即自举内建出口 / E_NODE / macro 影子节点真输出 / image 影子节点真输出 /
 *       store:persist 真落盘读回 / handler 抛错→E_INVOKE / subprocess 档 E_TRANSPORT_TODO / lookupByTag。
 * 不覆盖（有意）：bus:broadcast/feed/activate 的 handler 执行——它们懒加载 beilu-chat/beilu-memory
 * 模块链，脱离 app bootstrap 不可 import（受控验证边界，见记忆"后端 live 链路卡 init 全量 bootstrap"）；
 * 其注册存在性 + 包装正确性由代码审 + 后续沙盒拉线批验证。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../core/dispatch/dispatcher.mjs";
import { lookupByTag, register, registry } from "../core/dispatch/registry.mjs";
import "../core/functions/macro/index.mjs";
import "../core/functions/image/index.mjs";

let pass = 0, failCount = 0;
function check(name, cond, actual) {
	if (cond) { pass++; console.log(`  PASS ${name}`); }
	else { failCount++; console.log(`  FAIL ${name} — 实际:`, actual); }
}

console.log("== 注册表现状 ==");
console.log("  targets:", [...registry.keys()].join(", "));

// 1. 未注册 target → E_NODE
{
	const r = await dispatch({ verb: "x", target: "no:such", source: "test", payload: {}, scope: {} });
	console.log("\n[1] 未注册 target 实际输出:", JSON.stringify(r));
	check("E_NODE", r.ok === false && r.error?.code === "E_NODE", r);
}

// 2. macro 影子节点：真实宏替换输出
{
	const r = await dispatch({
		verb: "evaluateMacros", target: "functions:macro", source: "test",
		payload: { content: "你好{{user}}，我是{{char}}。掷骰:{{roll:1d1}}，反转:{{reverse::abc}}", env: { user: "凛倾", char: "beilu", group: "beilu" } },
		scope: { chatId: null },
	});
	console.log("\n[2] macro 实际输出:", JSON.stringify(r));
	check("macro 宏替换", r.ok === true && r.data === "你好凛倾，我是beilu。掷骰:1，反转:cba", r);
}

// 3. image 影子节点：PNG magic bytes 真检测
{
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const r = await dispatch({ verb: "detectMime", target: "functions:image", source: "test", payload: { buf: png }, scope: {} });
	console.log("\n[3] image detectMime 实际输出:", JSON.stringify(r));
	check("image PNG 检测", r.ok === true && r.data === "image/png", r);
}

// 4. store:persist：真落盘 + 读回对照
{
	const f = path.join(os.tmpdir(), `yonban_t1_persist_${Date.now()}.txt`);
	const r = await dispatch({ verb: "persist", target: "store:persist", source: "test", payload: { filePath: f, data: "yonban-t1-真实落盘" }, scope: {} });
	const back = fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "(不存在)";
	console.log("\n[4] store:persist 实际输出:", JSON.stringify(r), "| 读回:", back);
	check("persist 落盘读回", r.ok === true && back === "yonban-t1-真实落盘", back);
	try { fs.rmSync(f); } catch { /* 清理失败不影响判定 */ }
}

// 5. handler 抛错 → E_INVOKE（边不外抛）
{
	register("test:boom", { transport: "local", handlers: { go() { throw new Error("炸"); } } });
	const r = await dispatch({ verb: "go", target: "test:boom", source: "test", payload: {}, scope: {} });
	console.log("\n[5] handler 抛错实际输出:", JSON.stringify(r));
	check("E_INVOKE", r.ok === false && r.error?.code === "E_INVOKE" && r.error?.msg === "炸", r);
}

// 6. subprocess 档 → E_TRANSPORT_TODO
{
	register("test:sub", { transport: "subprocess", handlers: {}, spawn: { cmd: "x" } });
	const r = await dispatch({ verb: "run", target: "test:sub", source: "test", payload: {}, scope: {} });
	console.log("\n[6] subprocess 档实际输出:", JSON.stringify(r));
	check("E_TRANSPORT_TODO", r.ok === false && r.error?.code === "E_TRANSPORT_TODO", r);
}

// 7. lookupByTag 反查
{
	register("test:tagged", { transport: "local", handlers: {}, contributes: { tags: ["myTag"] } });
	const hit = lookupByTag("myTag"), miss = lookupByTag("noTag");
	console.log("\n[7] lookupByTag 实际输出: hit=", hit, "miss=", miss);
	check("tag 反查", hit.length === 1 && hit[0] === "test:tagged" && miss.length === 0, { hit, miss });
}

// 8. 出口节点注册存在性（没有显式 import exits；由 dispatcher 自举）
{
	const want = ["bus:broadcast", "bus:feed", "bus:activate", "store:persist"];
	const got = want.filter((t) => registry.has(t));
	console.log("\n[8] 出口节点注册:", got.join(", "));
	check("dispatcher 自举 4 个出口节点", got.length === 4, got);
}

console.log(`\n== 结果: ${pass} PASS / ${failCount} FAIL ==`);
if (failCount) Deno.exit(1);

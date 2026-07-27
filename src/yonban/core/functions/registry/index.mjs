/**
 * functions/registry/index.mjs — 功能注册表自省节点 facade（只读元数据面，25 批12 入住 2026-07-03）
 *
 * 【功能链】
 *   dispatch({target:"functions:registry", verb:"inspect"})
 *   → 合成 registry 只读快照 inspectRegistry()（core/dispatch/registry.mjs）
 *     + dispatch 活跃度聚合 getDispatchStats()（core/dispatch/stats.mjs，读白盒 RING）
 *   → 返回 {ok:true, data:{ nodes, dispatchStats, functions, exits, bridge }}
 *   → consumer = 前端「功能层运行状态总面板」（设计_功能层展示面板_20260703.md §四路径 A）：
 *     面板经桥 sendAction({verb:"inspect",target:"functions:registry"}) 拿这份 → 渲染节点卡片网格 +
 *     汇总条 + 桥入口状态行。面板本身是 dispatch 的一个消费方，展示的正是它自己走过的那条线路（吃狗粮）。
 *
 * 【why】
 *   registry 无 list/inspect 导出（原 registry.mjs 只有 register/lookupByTag），面板需要"节点表 + 活跃度"
 *   只读元数据，故本批加 inspectRegistry()/getDispatchStats() 两个只读读取器 + 本 facade 把它们经 dispatch
 *   暴露。凛倾意图「每个模式其实都可以看做一个接口，前端就是展示」——注册表自省也走 dispatch 接口面。
 *
 * 【handler 纯只读铁则】
 *   inspect handler 零副作用：只读 registry Map + RING 快照，不 register、不写盘、不广播、不改任何状态。
 *   返回体全部可 JSON 序列化（inspectRegistry 已剔除 handler 函数本体；dispatchStats 是纯数值/字符串聚合）。
 *
 * 【关联链】
 *   ← functions/all.mjs（import 副作用注册本节点，装载单点）
 *   → core/dispatch/registry.mjs（inspectRegistry 只读快照）
 *   → core/dispatch/stats.mjs（getDispatchStats 读白盒 RING 聚合）
 *
 * 【影响范围】
 *   import 本文件 = register("functions:registry") 进 Map（纯内存）；inspect 被 dispatch 时才读取聚合，
 *   零业务副作用。本节点只读，不参与操作流/生成链，无 contributes.tags（不进标签反查）。
 */
import { register, inspectRegistry } from "../../dispatch/registry.mjs";
import { getDispatchStats } from "../../dispatch/stats.mjs";

// 桥入口静态事实（all.mjs:13-14 头注释 / yonban_bridge 按命名空间放行）：
//   桥只放行 functions:* 命名空间；remote:yonban 不进 all.mjs（IDE 通道自治装载）。
const BRIDGE_ALLOW_NAMESPACE = "functions:*";

register("functions:registry", {
	transport: "local",
	handlers: {
		// 只读自省：合成 registry 节点快照 + dispatch 活跃度聚合 + 出口/功能库分组 + 桥入口信息。
		// 面板经此一次取全量元数据（节点表 + 每节点窗口内调用/错误/最近活跃）。纯读，无副作用。
		async inspect(_payload, _context) {
			const nodes = inspectRegistry();                       // 全节点只读快照（含本节点自身）
			const dispatchStats = getDispatchStats();              // {windowSize,totalSpans,byTarget}
			// 分组视图（前端信息架构：functions 库节点 vs bus/store 出口节点）——从 nodes 派生，不硬编码。
			const functions = nodes.filter((n) => typeof n.target === "string" && n.target.startsWith("functions:")).map((n) => n.target);
			const exits = nodes.filter((n) => typeof n.target === "string" && (n.target.startsWith("bus:") || n.target.startsWith("store:"))).map((n) => n.target);
			return {
				ok: true,
				data: {
					nodes,                                             // [{target,transport,verbs,verbCount,contributes}]
					dispatchStats,                                     // 活跃度聚合（如实带 windowSize=500 滑动窗口口径）
					functions,                                         // functions:* 节点 target 列表（功能库分区）
					exits,                                             // bus:*/store:* 出口节点 target 列表（出口分区）
					bridge: { allowNamespace: BRIDGE_ALLOW_NAMESPACE, ringWindowSize: dispatchStats.windowSize },
					nodeCount: nodes.length,                           // 注册节点总数（含本自省节点）
				},
			};
		},
	},
});

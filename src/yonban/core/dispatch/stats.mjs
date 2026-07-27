/**
 * stats.mjs — dispatch 边活跃度聚合（白盒 RING 的只读派生视图）
 *
 * 【功能链】
 *   数据进：getWhiteboxRing()（server/whitebox.mjs:87 → RING.slice()，500 条环形滑动窗口）。
 *   过滤：只取 dispatcher 打的 span——`entry.line === "dispatch"`（dispatcher.mjs:51 wbSpan 第二参=line="dispatch"，
 *        node=`${target}.${verb}`；字段名是 line 不是 layer——whitebox.mjs:122/131/138 emit 的键为 line）。
 *   聚合：按 target（= entry.data.target，回退 node 的 "." 前缀）汇总 → {calls, errors, lastTs}。
 *   数据出：`{ windowSize, totalSpans, byTarget:{ [target]:{calls,errors,lastTs} } }`
 *          → consumer = functions:registry#inspect handler（core/functions/registry/index.mjs）
 *          → 前端「功能层运行状态总面板」渲染每卡片的调用数/最近活跃/错误计数。
 *
 * 【why】
 *   dispatcher.mjs 每次 dispatch 必打一条 dispatch span（全流量必经，:51），RING 里天然含
 *   ts(最近活跃)/条数(调用数)/错误信号三要素——无需新埋点，只做只读聚合读取面（设计 §2.2/§四路径A 第2步）。
 *   放 dispatch/stats.mjs（非 whitebox）：本聚合是 dispatch 域概念（按 target 汇总 dispatch 边），
 *   whitebox 是零下游依赖的中立底座（whitebox.mjs:27），不宜塞 dispatch 专用聚合；依赖方向
 *   dispatch → server/whitebox 与 dispatcher.mjs:32 同向，正确。
 *
 * 【错误计数口径（如实标注）】
 *   dispatch span 的失败由 dispatcher 记为 `data.ok === false`（dispatcher.mjs:54 fail→end({ok:false,code})
 *   / :71 end({ok: result?.ok!==false})）——**dispatch span 不带 detect 字段**（detect 是 wbDetect 专用，
 *   whitebox.mjs:138，dispatcher 不调 wbDetect）。故 errors 主口径 = `data.ok === false` 计数；
 *   同时兼容 `entry.detect === true`（若未来 dispatch 线补 wbDetect 也纳入），两者取或。
 *
 * 【影响范围】
 *   纯读 RING 快照副本（getWhiteboxRing 返回 slice，不改原 RING），无写、无 IO、无广播。
 *   RING 是 500 条环形滑动窗口 → calls 是【窗口内】计数非累计总量，返回体带 windowSize 字段
 *   供前端如实标注"近 N 条窗口内"，不误导为总量（设计 §六风险3）。
 *
 * 【关联链】
 *   ← core/functions/registry/index.mjs（inspect handler 合成 nodes+stats）
 *   → server/whitebox.mjs（getWhiteboxRing 只读快照）
 */
import { getWhiteboxRing } from "../../../server/whitebox.mjs";

/** RING 环形缓冲容量（whitebox.mjs:37 RING_MAX）——如实回报窗口大小，供前端标注滑动窗口口径。 */
const RING_WINDOW_SIZE = 500;

/**
 * 聚合当前 RING 内 dispatch span → 每 target 的活跃度。
 * @returns {{
 *   windowSize:number,                // RING 环形窗口容量（滑动窗口，calls 非累计）
 *   totalSpans:number,                // 本次快照内 line==="dispatch" 的 span 总数
 *   byTarget: Record<string, { calls:number, errors:number, lastTs:number|null }>
 * }}
 */
export function getDispatchStats() {
	const ring = getWhiteboxRing(); // RING.slice() 只读快照
	const byTarget = {};
	let totalSpans = 0;
	for (const e of ring) {
		if (e?.line !== "dispatch") continue; // 只聚合 dispatch 边的 span
		totalSpans++;
		// target 优先取 span data 里 dispatcher 显式写入的 target（dispatcher.mjs:52），
		// 回退 node 的 "." 前缀（node=`${target}.${verb}`，target 本身可能含 ":" 但不含首个 "." 前的 verb 分隔）。
		const target = e?.data?.target ?? (typeof e?.node === "string" ? e.node.split(".")[0] : null);
		if (!target) continue;
		const agg = byTarget[target] ?? (byTarget[target] = { calls: 0, errors: 0, lastTs: null });
		agg.calls++;
		// 错误口径：dispatch span 失败=data.ok===false（主口径）；兼容 detect===true（wbDetect 线，当前 dispatch 不产）。
		if (e?.detect === true || e?.data?.ok === false) agg.errors++;
		if (typeof e?.ts === "number" && (agg.lastTs === null || e.ts > agg.lastTs)) agg.lastTs = e.ts;
	}
	return { windowSize: RING_WINDOW_SIZE, totalSpans, byTarget };
}

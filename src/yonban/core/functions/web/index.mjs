/**
 * functions/web/index.mjs — 联网系统节点 facade（第 15 组，T3a·3.8 已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:web", verb:"search", payload:{query,...}})
 *   → ./webSearch.mjs executeWebSearch（P8 联网搜索，出站过 assertSafeOutboundInServerMode 安全横切）
 *   → 结果（可经 formatSearchResultsForP8 注入提示词）。
 *   旧线路：memory aiRunner/replyHandler 与 beilu-web part 经旧位薄壳到达同一实现，行为等价。
 *
 * 【why】
 *   裁决8（0_总架构 §七）：p8 联网独立成第 15 组，不并入 api/memory。
 *   从 beilu-memory 迁出（3_功能层 §三迁出表）——memory 侧消费方走旧位壳，T3e memory 批一并切净。
 *   离线约束：无网时 executeWebSearch 失败不阻塞生成（beilu 硬约束：核心能离线启动），
 *   该退化逻辑在实现内，本 facade 不加防御。
 *
 * 【影响范围】
 *   出站网络请求（经 safe_fetch SSRF 闸）；无本地状态。
 */
import { executeWebSearch, formatSearchResultsForP8 } from "./webSearch.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:web", {
	transport: "local",
	handlers: {
		async search(payload, _context) {
			const data = await executeWebSearch(payload?.query, payload?.options ?? {});
			return { ok: true, data };
		},
		async formatForP8(payload, _context) {
			return { ok: true, data: formatSearchResultsForP8(payload?.results) };
		},
	},
});

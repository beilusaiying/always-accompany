/**
 * functions/security/index.mjs — 安全系统节点 facade（T3a·3.6 第一步：gate 逻辑已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:security", verb:"gateTool|checkCommand|evaluateWriteGate|evaluateRule", payload})
 *   → ./commandGate.mjs（从 ideClient.mjs 抽出的 557 行命令安全域：黑/灰名单、D3 统一执行闸、
 *   审批双档门、B3 三态规则引擎）。
 *   横切定位：security 是贯穿层不按 intent 分发（3_功能层 组7）——本 facade 是 dispatch 侧入口，
 *   现有调用方（ideClient.callTool / replyHandler 审批门）经 ideClient re-export 直调同一实现。
 *
 * 【why】
 *   「唯一逻辑移动」（T3a §3.6）：gate 归 security 组、ideClient 本体归 transport（后续批标注）。
 *   fail-closed 语义一字未改，抽出后已真跑拦截行为逐项验证（rm -rf 永禁/未知 forced ask/
 *   B 通道默认拦/…见 T3a 执行记录批3）。
 *   6 个 server 文件（auth/path_confine/security_policy/safe_fetch/secret_box/untrusted_content）
 *   物理迁移 = 本组第二步（进行中，见 00_索引）。
 *
 * 【影响范围】
 *   本文件仅注册节点；拦截行为在 commandGate（改它=改三通道拦截，高危）。
 */
import {
	checkCommandSecurity,
	evaluateRuleDecision,
	evaluateWriteApprovalGate,
	gateToolExecution,
} from "./commandGate.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:security", {
	transport: "local",
	contributes: {
		// 跨库交界点标注：YonBan tool-infra.ts COMMAND_BLACKLIST 为独立副本（纵深防御 by-design），
		// 本体 commandGate 默认清单是权威源（0715 重分级：两侧对齐同一「严重破坏类」永禁集），
		// 维护规则=先改本体默认清单再手动同步 YonBan 副本。
		remoteCounterpart: ["YonBan/src/services/tool-infra.ts"],
	},
	handlers: {
		async gateTool(payload, _context) {
			return { ok: true, data: gateToolExecution(payload ?? {}) };
		},
		async checkCommand(payload, _context) {
			return { ok: true, data: checkCommandSecurity(payload?.command, payload?.userConfig) };
		},
		async evaluateWriteGate(payload, _context) {
			return { ok: true, data: evaluateWriteApprovalGate(payload ?? {}) };
		},
		async evaluateRule(payload, _context) {
			return { ok: true, data: evaluateRuleDecision(payload?.toolCall, payload?.rules, payload?.workspaceRoot, payload?.options) };
		},
	},
});

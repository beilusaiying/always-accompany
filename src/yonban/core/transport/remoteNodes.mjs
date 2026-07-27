/**
 * remoteNodes.mjs — remote 档节点注册（对接批 2026-07-02）
 *
 * 【功能链】
 *   import 本文件 → register("remote:yonban", {transport:"remote"})
 *   → dispatch({target:"remote:yonban", verb:<toolName>, payload:<params>, scope:{chatId}})
 *   → dispatcher switch case "remote" → transport/index.mjs remoteInvoke → ideClient.callToolAndStore
 *   → YonBan WS 8931（信封 {type:"tool_call", payload:{tool,params}}）。
 *
 * 【why】
 *   3 交界点之一（0_总架构 §八）：YonBan 是 remote 对端不是本体内部组。verb=tool 名（41 个收敛于
 *   tool_call 一种消息型——分身I协议对照表），故 handlers 无本地实现、verb 白名单由 YonBan 侧
 *   ToolExecutor._handlers 单一权威（本体不复刻名单防双源漂移；未知 tool 由对端返错，fail loud）。
 *
 * 【影响范围】import 仅注册（纯内存）；调用时副作用=ideClient 全语义（写锁/安全闸/审批）。
 */
import { register } from "../dispatch/registry.mjs";

register("remote:yonban", {
	transport: "remote",
	remote: { kind: "yonban", endpoint: "ws:8931(ideClient 单例既有连接)" },
	contributes: {
		flows: ["operation"],
		desc: "YonBan VSCode IDE 工具面（read_file/write_file/run_command/lint/checkpoint 等 41 tool，名单权威=YonBan ToolExecutor._handlers）",
	},
});

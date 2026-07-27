/**
 * functions/mcp/index.mjs — MCP 系统节点 facade（T3a·3.5 已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:mcp", verb:"createClient", payload:{config}})
 *   → ./mcp_client.mjs createMCPClient（Stdio 子进程 / SSE / WS / StreamableHTTP 多传输；
 *   连接超时 30s、请求 60s；出站过 assertSafeOutboundInServerMode，MCP_DEFAULT_ENV_ALLOWLIST env 闸）
 *   → client 实例（listTools/callTool 在实例上，由持有方【已部署用户插件】调用）。
 *   导入链：用户导入 MCP 配置 → ./main.mjs（ImportHandler part，经旧位薄壳加载）→ copy Template/
 *   （留原位的部署资产）到 data/users/<u>/plugins/<x>/ → 用户插件实例经 engine 旧位【永久壳】用 mcp_client。
 *
 * 【why】
 *   Template/main.mjs 未迁：它是部署资产，内部 '../../../../../src/...' 路径专为用户目录位设计
 *   （原位 deno check 本就不过，预先存在）；已部署实例（实测 data/users/凛倾/plugins/mcp_browsermcp）
 *   硬编码 engine/mcp_client.mjs 旧位 → 该壳永不删（用户数据不迁不改）。
 *   listTools/callTool 不做成节点 verb：它们属于持 client 的插件实例（有连接态），
 *   功能库无状态原则——节点只暴露 createClient 纯能力。
 *
 * 【影响范围】
 *   createClient 起子进程/外连（与旧线路同一实现同一门禁）。
 */
import { createMCPClient } from "./mcp_client.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:mcp", {
	transport: "local",
	handlers: {
		async createClient(payload, _context) {
			const client = await createMCPClient(payload?.config ?? {});
			return { ok: true, data: client };
		},
	},
});

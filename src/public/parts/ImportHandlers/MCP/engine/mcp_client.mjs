// mcp_client.mjs — 兼容 re-export 薄壳（T3a·3.5 mcp 组迁移，2026-07-02）
// 实现体已迁：src/yonban/core/functions/mcp/mcp_client.mjs（Stdio/SSE/WS/StreamableHTTP 多传输 MCP 客户端；
// 出站仍过 assertSafeOutboundInServerMode，MCP_DEFAULT_ENV_ALLOWLIST env 闸在实现内未动）。
// ⚠ 本壳【永不删】：用户目录已部署插件实例硬编码本路径（实测 data/users/凛倾/plugins/mcp_browsermcp/main.mjs:4
// 以及 Template/main.mjs 模板本身）——用户数据不迁不改，本壳是它们的永久入口。
export * from "../../../../../yonban/core/functions/mcp/mcp_client.mjs";

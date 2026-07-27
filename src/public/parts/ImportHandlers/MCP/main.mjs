/**
 * main.mjs — 兼容 re-export 薄壳（T3a·3.5 mcp 组迁移，2026-07-02）
 * 实现体已迁：src/yonban/core/functions/mcp/main.mjs（MCP 导入器：copy Template 到用户目录生成插件；
 * 适配=templateDir/info.json 指回原位）。Template/ 是部署资产留原位未迁。
 * P 型薄壳（beilu-part.json + GetPartPath('ImportHandlers/MCP')）——永不删。
 */
export { default } from "../../../../yonban/core/functions/mcp/main.mjs";

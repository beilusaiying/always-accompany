/**
 * main.mjs — MCP 插件实例薄壳（导入时被拷贝到 data/users/<u>/plugins/mcp_x/main.mjs）
 *
 * 【why 薄壳】原来这里是 393 行完整实现，每导入一个 MCP 就整份拷贝一次——修一个 bug 要挨个
 *   同步 N 份拷贝，漏一份就是长期潜伏的旧版实例（本文件旧注释记过这个坑）。现实现体收进本体
 *   src/yonban/core/functions/mcp/instance.mjs，此处只传实例目录（data.json 与本文件同目录），
 *   以后任何修复对**所有已导入实例自动生效**。范式同 beilu-regex/main.mjs 薄壳 re-export。
 *
 * 【路径约定】相对层级按**部署位**算：data/users/<u>/plugins/mcp_x/ 上 5 级 = 仓库根
 *   （与旧版本文件内 authenticate/ideClient 等 import 同一约定，未改变）。
 */
import { createMcpPart } from '../../../../../src/yonban/core/functions/mcp/instance.mjs'

export default createMcpPart(import.meta.dirname)

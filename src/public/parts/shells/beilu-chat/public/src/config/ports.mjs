/**
 * [ports.mjs] — 前端端口/主机集中常量（脚本生成镜像，禁手改）
 *
 * 功能链：tools/extract_config_ports.mjs 从后端权威源抽值 → 生成本文件（冻结导出）
 *   → 前端消费方 import { IDE_WS_PORT, WS_HOST, wsUrl } 拼连接串 → new WebSocket(...)。
 *
 * why：前端跨 part 不可 import 后端（storage-keys.mjs 同款约束）→ 端口值只能镜像；
 *   手写双份必漂移（改一边忘另一边 → IDE 连不上）。本文件由脚本生成，改后端跑脚本即同步。
 *
 * sync：镜像 yonban/core/transport/ideClient.mjs DEFAULT_PORT（T066：ideClient 迁 transport，原 plugins/beilu-memory/lib/tools 位已换 re-export 薄壳）。
 *   改端口 → 改后端 ideClient.mjs → 跑 tools/extract_config_ports.mjs 重新生成本文件。
 *
 * 影响范围：ideConnPanel（IDE 连接面板默认端口 + WS 连接串）。
 */

/** IDE WS 桥默认端口（YonBan 插件侧监听；镜像后端 ideClient.mjs DEFAULT_PORT） */
export const IDE_WS_PORT = 8931;

/** 本机 WS/HTTP 主机名（IDE 桥仅监听回环，契约③§四） */
export const WS_HOST = "localhost";

/**
 * 拼 WS 连接串：ws://<host>:<port><path>[?token=...]
 * @param {number|string} port
 * @param {string} wsPath - 如 "/ide"
 * @param {string} [token]
 * @returns {string}
 */
export function wsUrl(port, wsPath, token) {
	return token
		? `ws://${WS_HOST}:${port}${wsPath}?token=${encodeURIComponent(token)}`
		: `ws://${WS_HOST}:${port}${wsPath}`;
}

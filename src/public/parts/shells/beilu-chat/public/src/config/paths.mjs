/**
 * [paths.mjs] — 前端 API 路径前缀 + URL 构造器（单一权威源）
 *
 * 功能链：消费方 import { partUrl, shellUrl, virtualFileUrl } → 拼出 /api/parts/... URL
 *   → apiFetch 发请求 → 后端 parts_router 懒加载分发。
 *
 * why：44+ 散 URL 各文件手写 "/api/parts/..." 前缀（endpoints.mjs/featureControls.mjs/shared/widgets/*），
 *   前缀改动要全局搜改。本文件只收【前缀 + 构造器】——不把 87 条路由塞成一个表
 *   （具体 endpoint 仍由各消费方用构造器拼，设计⑤§5.2 边界，防过度收口）。
 *   逐库把散 URL 切到构造器 = T6 阶段 6b（sendAction 渐进收口）的活，本文件先就位供其消费。
 *
 * 真实形状锚点（grep 实测）：
 *   POST /api/parts/shells:chat/:chatid/<endpoint>（endpoints.mjs:57）
 *   POST /api/parts/plugins:beilu-memory/config/setdata（featureControls 等）
 *   GET  /virtual_files/parts/shells:chat/:chatid（conversationManager.mjs:734）
 *   WS   /ide（ideConnPanel IDE_PROFILES.wsPath）
 *
 * 影响范围：纯常量+纯函数，无 IO；被 T6 各库收口批逐步 import。
 */

/** parts API 前缀 */
export const API_BASE = "/api/parts";

/** WS 路径表 */
export const WS_PATHS = Object.freeze({ ide: "/ide" });

/**
 * 部件 API URL：/api/parts/<type>:<part>/<sub>
 * @param {string} type - "plugins" | "shells" | "serviceGenerators" | ...
 * @param {string} part - 如 "beilu-memory"
 * @param {string} sub  - 如 "config/setdata"
 */
export function partUrl(type, part, sub) {
	return `${API_BASE}/${type}:${part}/${sub}`;
}

/**
 * chat shell 会话 URL：/api/parts/shells:chat/<chatid>/<sub>（chatid 可为 "new" 等字面量）
 * @param {string} chatid
 * @param {string} sub
 */
export function shellUrl(chatid, sub) {
	return sub ? `${API_BASE}/shells:chat/${chatid}/${sub}` : `${API_BASE}/shells:chat/${chatid}`;
}

/**
 * 对话导出虚拟文件 URL：/virtual_files/parts/shells:chat/<chatid>
 * @param {string} chatid
 */
export function virtualFileUrl(chatid) {
	return `/virtual_files/parts/shells:chat/${encodeURIComponent(chatid)}`;
}

/**
 * [api-client.mjs] — 前端全局 HTTP 请求基座。不管 chat 端点路由（那是 endpoints.mjs:callApi 的事），
 *   不管 WS 通信（那是 websocket.mjs 的事）。
 *
 * 功能链：前端所有模块 → apiFetch(url, opts) → AbortController 超时守卫 → 浏览器 fetch → 后端 HTTP 路由
 *   → 响应解析（JSON/text/raw）→ 错误格式化（含 401 跳转）→ 返回数据给调用方。
 *   renameChat() 是对话改名的单一权威收口，三套对话管理 UI 共用，消除手抄逻辑。
 *
 * why：历史上前端有 277 处裸 fetch，全无超时控制，导致网络抖动时连接永挂、页面假死。
 *   401 处理也散落各处，行为不一致。本模块将所有 /api/* 请求收口为统一封装，
 *   让超时 abort、401 跳登录、错误格式化等横切逻辑只写一次、不可绕过（W72 #fetch / P2大重构 R1 step①）。
 *
 * 关联链：
 *   被 import → chat.mjs / endpoints.mjs / sharedState.mjs / diagLogger.mjs / index*.mjs 等全前端模块
 *   → 浏览器原生 fetch（本模块是 fetch 的唯一权威封装，traceFetch 除外——见 diagLogger.mjs）
 *   边界：chat 端点专用 wrapper 见 endpoints.mjs:callApi（带 currentChatId 前缀）；本模块面向通用 /api/* 路径。
 *
 * 影响范围：
 *   - 改动超时值 DEFAULT_TIMEOUT_MS → 影响全前端所有 /api/* 请求的挂起时间
 *   - 改动 401 处理 → 影响所有未登录用户的跳转行为（页面强制导航）
 *   - 改动 JSON 序列化逻辑 → 影响全前端请求 body 格式
 *   - 改动 renameChat() → 影响 conversationManager / index-chatmgmt / workPanel 三处改名 UI
 *
 * 使用效果：
 *   - 用户操作触发 API 调用时：30 秒无响应自动中断并提示超时，不会永久加载转圈
 *   - 用户登录态过期时：任意操作触发请求 → 401 → 自动跳转到 /login 页面
 *   - 用户对话改名时：输入新名称确认 → renameChat() → POST /rename → 服务端持久化
 *
 * 复用：import { apiFetch } from "./api-client.mjs"; const data = await apiFetch("/api/xxx", { method, body, raw, timeout })
 */

import { DEFAULTS } from "../../config/defaults.mjs"; // T2 config 收口：数值缺省单源
// 诊断 api 模块常驻埋点。循环 import（diagLogger→api-client→diagLogger）安全前提：
//   createDiag 只在首次 apiFetch 运行时调用（模块求值期不碰 diagLogger 内部 const，避 TDZ）。
import { createDiag } from "../state/diagLogger.mjs";

let _diagInst = null;
const _diag = () => (_diagInst ??= createDiag("api"));

const DEFAULT_TIMEOUT_MS = DEFAULTS.request.timeoutMs;

// HTTP 并发限流（全局单源）：浏览器同源限制 6 连接（含 2 WS），HTTP 最多同时 4 个，多的排队。
// 所有前端 HTTP 请求（sendAction/callApi/直接 apiFetch）统一经此限流，
// 防 char-changed/mode-switched/tab 切换等事件扇出 18+ 监听者各自独立发 HTTP 堵死连接池。
const _HTTP_MAX_CONCURRENT = 4;
let _httpActive = 0;
const _httpQueue = [];

/**
 * 通用 API 请求：超时 abort + 401 跳转 + 统一错误格式。
 * @param {string} url - 完整路径（如 "/api/xxx"）。
 * @param {object} [opts]
 * @param {string} [opts.method="GET"] - HTTP 方法。
 * @param {*} [opts.body] - 非 string/FormData 时自动 JSON.stringify + 设 Content-Type。
 * @param {object} [opts.headers] - 额外头。
 * @param {boolean} [opts.raw=false] - true 返原始 Response（流/blob/需自管解析）；false 解析 json/text。
 * @param {number} [opts.timeout] - 毫秒，缺省 DEFAULTS.request.timeoutMs（config/defaults.mjs）；超时 abort 抛错（防半死连接永挂）。
 * @param {RequestCredentials} [opts.credentials] - 透传 fetch credentials（"include"/"same-origin"/"omit"）；省略=fetch 默认(same-origin)。迁移 /api/eye·/api/security 等带 credentials 的站点用，保语义不变。
 * @param {RequestCache} [opts.cache] - 透传 fetch cache（如 "no-store"）；省略=fetch 默认。
 * @returns {Promise<any>} raw=false 返解析后的 body；raw=true 返 Response。
 */
export async function apiFetch(url, opts = {}) {
	// 并发限流：超过 4 个同时 HTTP 请求时排队等待
	if (_httpActive >= _HTTP_MAX_CONCURRENT) {
		await new Promise(resolve => _httpQueue.push(resolve));
	}
	_httpActive++;
	try { return await _apiFetchInner(url, opts); } finally {
		_httpActive--;
		if (_httpQueue.length > 0) _httpQueue.shift()();
	}
}

async function _apiFetchInner(url, opts = {}) {
	const { method = "GET", body, headers = {}, raw = false, timeout = DEFAULT_TIMEOUT_MS, credentials, cache } = opts;
	const _ac = new AbortController();
	const _t = setTimeout(() => _ac.abort(), timeout);
	const _isForm = typeof FormData !== "undefined" && body instanceof FormData;
	const _h = { ...headers };
	let _b = body;
	if (body !== undefined && body !== null && !_isForm && typeof body !== "string") {
		_b = JSON.stringify(body);
		if (!_h["Content-Type"]) _h["Content-Type"] = "application/json";
	}
	const _opts = { method, headers: _h, body: _b, signal: _ac.signal };
	if (credentials !== undefined) _opts.credentials = credentials;
	if (cache !== undefined) _opts.cache = cache;
	const _t0 = performance.now();
	_diag().debug(`${method} ${url}`);
	let resp;
	try {
		resp = await fetch(url, _opts);
	} catch (e) {
		clearTimeout(_t);
		// 埋点用 warn 不用 error（error 不受模块过滤始终输出，高频请求失败会双倍刷屏——调用方已有报错链）
		if (e && e.name === "AbortError") {
			_diag().warn(`${method} ${url} → TIMEOUT ${timeout}ms`);
			throw new Error(`[apiFetch] 请求超时 (${timeout}ms): ${method} ${url}`);
		}
		_diag().warn(`${method} ${url} → NETWORK FAIL (${(performance.now() - _t0).toFixed(0)}ms):`, e?.message);
		throw e;
	}
	clearTimeout(_t);
	// 401 → 登录跳转（单一权威，避免各处各写 401 处理）
	if (resp.status === 401) {
		_diag().warn(`${method} ${url} → 401（将跳登录）`);
		try { if (typeof window !== "undefined" && !location.pathname.includes("/login")) location.href = "/login"; } catch { /* 跳转失败不掩盖 401 */ }
		throw new Error(`[apiFetch] 401 未认证: ${method} ${url}`);
	}
	_diag().debug(`${method} ${url} → ${resp.status} (${(performance.now() - _t0).toFixed(0)}ms)`);
	if (raw) return resp;
	if (!resp.ok) {
		let _msg = `${resp.status} ${resp.statusText}`;
		try { const _j = await resp.clone().json(); if (_j && _j.error) _msg = _j.error; } catch { /* 非 json 错误体，保留状态码 */ }
		_diag().warn(`${method} ${url} → ${resp.status}:`, _msg);
		throw new Error(`[apiFetch] ${method} ${url} 失败: ${_msg}`);
	}
	const _ct = resp.headers.get("content-type") || "";
	return _ct.includes("application/json") ? resp.json() : resp.text();
}

/**
 * 对话改名单一权威（N39·查重C-P0-A 收口）：POST /rename 持久化到服务端 chat_names。
 * conversationManager / index-chatmgmt / workPanel 三套对话管理 UI 共用，消除 rename apiFetch 逻辑三处手抄。
 * 各 UI 自留的 Enter+blur 去重守卫 / 本地 label 离线兜底 / toast 文案不进本函数（是 UI 局部差异）。
 * @param {string} chatid
 * @param {string} name
 * @returns {Promise<{ok:boolean, status:number, message?:string}>} ok=服务端持久化成功；失败时 message 供 toast
 */
export async function renameChat(chatid, name) {
	try {
		const res = await apiFetch(
			"/api/parts/shells:chat/" + encodeURIComponent(chatid) + "/rename",
			{ method: "POST", raw: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) },
		);
		const data = await res.json().catch(() => null);
		if (res.ok && data?.success) return { ok: true, status: res.status };
		return { ok: false, status: res.status, message: data?.message || String(res.status) };
	} catch (e) {
		return { ok: false, status: 0, message: e.message };
	}
}

/**
 * 对话模式徽标单一权威（对齐 renameChat/N39 范式）：POST /mode 持久化到服务端 chat_modes。
 * 【why】徽标原只写前端 localStorage convMeta.mode，换窗口/清缓存即丢；服务端权威后各窗口列表一致。
 * @param {string} chatid
 * @param {string} mode - "chat"|"smart"|"code"|"work"，空串=清除徽标
 * @returns {Promise<{ok:boolean, status:number, message?:string}>}
 */
/**
 * 模式窗口在用指针单一权威（对齐 setChatMode 范式）：POST /using 持久化到服务端 mode_active_chats。
 * 【why】「XX窗口在用」原只有前端 localStorage 模式线指针——单浏览器视角，换窗口标签残缺。
 * R1 0713：不再报送 charName——服务端按对话 primaryCharName 权威定键。前端 charName 源
 *   （BEILU_LAST_CHAR 仅 charsel 选卡时写）常空 → 报送链双闸静默拒写=「在用」徽标冻结案根因。
 * @param {string} chatid
 * @param {string} mode - "chat"|"smart"|"code"|"work"
 * @returns {Promise<{ok:boolean, status:number, message?:string}>}
 */
export async function setModeActiveChat(chatid, mode) {
	try {
		const res = await apiFetch(
			"/api/parts/shells:chat/" + encodeURIComponent(chatid) + "/using",
			{ method: "POST", raw: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
		);
		const data = await res.json().catch(() => null);
		if (res.ok && data?.success) return { ok: true, status: res.status };
		return { ok: false, status: res.status, message: data?.message || String(res.status) };
	} catch (e) {
		return { ok: false, status: 0, message: e.message };
	}
}

/**
 * 收藏/置顶标记单一权威（对齐 setChatMode/N39 范式）：POST /flags 持久化到服务端 chat_flags。
 * 【why · 0715 LS-4】starred/pinned 原只存前端 localStorage convMeta——多窗口整对象
 *   read-modify-write 互覆盖丢标记。服务端 per-chatid 单键写无竞态，各窗口列表一致。
 * @param {string} chatid
 * @param {{starred?:boolean, pinned?:boolean}} flags - 只传要改的键（服务端浅合并）
 * @returns {Promise<{ok:boolean, status:number, message?:string}>}
 */
export async function setChatFlags(chatid, flags) {
	try {
		const res = await apiFetch(
			"/api/parts/shells:chat/" + encodeURIComponent(chatid) + "/flags",
			{ method: "POST", raw: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(flags || {}) },
		);
		const data = await res.json().catch(() => null);
		if (res.ok && data?.success) return { ok: true, status: res.status };
		return { ok: false, status: res.status, message: data?.message || String(res.status) };
	} catch (e) {
		return { ok: false, status: 0, message: e.message };
	}
}

export async function setChatMode(chatid, mode) {
	try {
		const res = await apiFetch(
			"/api/parts/shells:chat/" + encodeURIComponent(chatid) + "/mode",
			{ method: "POST", raw: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
		);
		const data = await res.json().catch(() => null);
		if (res.ok && data?.success) return { ok: true, status: res.status };
		return { ok: false, status: res.status, message: data?.message || String(res.status) };
	} catch (e) {
		return { ok: false, status: 0, message: e.message };
	}
}

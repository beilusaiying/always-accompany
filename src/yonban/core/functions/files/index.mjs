/**
 * functions/files/index.mjs — 文件操作组节点 facade（五插件全过桥后最后一块，2026-07-03）
 *
 * 【功能链】
 *   dispatch({target:"functions:files", verb:"getData|setData", payload}) → _als.run({username}, …)
 *   → beilu-files/main.mjs interfaces.config.GetData/SetData（同一 pluginExport ESM 单例，与 REST
 *   端点 :2325/:2339 到达同一实现——行为等价铁则）。
 *
 * 【why · 身份换算面=ALS run 包裹（分身 W3 专项调查 + 主 AI 设计）】
 *   beilu-files 身份不走参数：pluginData 是 Proxy（main.mjs:2078-2091），除 workspaceRoot(s) 外
 *   全字段经 _curUser()（:2023-2026 读 AsyncLocalStorage）按用户分区——SetData(data) 单参无身份位。
 *   facade 直调（无 run 包裹）= 全量用户级配置/安全闸（allowedPaths/permissions）/fileHistory/gitHub
 *   token 串 "_default"+"" 双桶 = 真回归。故换算面唯一等价形态 = 与 REST 线同机制：
 *   `_filesAls.run({username: context.user}, () => SetData(...))`（main.mjs 已 export 别名，仅此用途）。
 *   有身份才 run；无身份直调 = chatStorage.mjs:934 forgetChatState 先例的 _default 语义，零新增行为。
 *   身份权威序：context.user（桥 session 盖章）> payload.username 自报（主链/内部调用），同标量换算面惯例。
 *
 * 【影响范围】
 *   import 本文件仅注册节点（纯内存）；无 WS 广播副作用（W3 复核 grep 0 命中）。
 *   登记（预存疑似，非本批引入）：activeModes/pendingOpResults 运行时态桶分裂待核（W3 报告 §待核）。
 */
import { register } from "../../dispatch/registry.mjs";
import filesPlugin, { _filesAls } from "../../../../public/parts/plugins/beilu-files/main.mjs";

const ROOT_MUTATION_SOURCES = new Set(["web", "ws"]);
const FILE_PATH_ACTIONS = new Set([
	"readFile", "readFileAuto", "readFileBase64", "readFileExtract",
	"writeFile", "listDir", "createFile", "deleteFile", "createDir",
	"rename", "move", "moveFile", "searchFiles",
]);
// SetData 是兼容总入口，动作级 scope 契约必须在 facade 单源声明：
// 前端和其它调用方只传 context.chatId，不再各自维护 payload chatid 名单。
const CHAT_SCOPED_STATE_ACTIONS = new Set([
	"approveOp", "rejectOp", "approveAll", "rejectAll",
	"getPendingErrors", "consumePendingErrors",
	"setMode", "getCleanupInfo",
	"getFileVersions", "revertFileVersion", "getFileDiff", "manualBackup",
	"listChatBackups", "restoreChatBackup",
]);
const _hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// [D6 §3 2026-08-04] browse 授权动作：与根变更同级权威（只许已认证 web/ws 发起）。
//   grant 是工作区外列举的唯一通行证（beilu-files _browseGrants owner-bound 短期），
//   签发面必须锁在 facade 的 dispatchSource+context.user 闸后，AI/调度器路径不可达。
//   getIdeRootCandidate=IDE 确认链的前置只读（同闸：候选/路由快照只给认证 web 用户）。
const BROWSE_GRANT_ACTIONS = new Set(["requestBrowseGrant", "releaseBrowseGrant", "adoptLegacyWorkspaceRoots", "getIdeRootCandidate"]);

function _isRootMutation(data) {
	return !!data && typeof data === "object" && (
		data._action === "setWorkspaceRoot"
		// [D6 §2.4] IDE 根确认=根变更同级（web/ws+认证+可信 chatId 闸全套适用）
		|| data._action === "confirmIdeWorkspaceRoot"
		|| _hasOwn(data, "rootPath")
		|| _hasOwn(data, "workspaceRoot")
	);
}

function _authorityError(code, msg) {
	return { ok: false, error: { code, msg } };
}

function _bindTrustedChatId(data, context, errorCode, { required = false } = {}) {
	if (!data || typeof data !== "object") return { ok: true, data };
	const trustedChatId = typeof context?.chatId === "string" ? context.chatId.trim() : "";
	const hasClientClaim = data.chatid != null || data.chatId != null;
	if (!trustedChatId) {
		if (required || hasClientClaim)
			return _authorityError("E_FILES_CHAT_REQUIRED", "文件操作需要明确的发起窗口会话");
		return { ok: true, data };
	}
	for (const key of ["chatid", "chatId"]) {
		if (data[key] != null && data[key] !== trustedChatId)
			return _authorityError(errorCode, `文件请求 ${key} 与可信会话不一致`);
	}
	// SetData 旧契约只消费 chatid；下沉前去掉客户端 chatId 别名，不把双键带入业务层。
	const { chatId: _discardedClientAlias, ...rest } = data;
	return { ok: true, data: { ...rest, chatid: trustedChatId } };
}

function _withUser(context, payload, fn) {
	const username = context?.user ?? payload?.username;
	const store = {
		...(username ? { username } : {}),
		dispatchSource: context?.dispatchSource,
		chatId: context?.chatId,
	};
	return (username || context?.dispatchSource !== undefined || context?.chatId !== undefined)
		? _filesAls.run(store, fn)
		: fn();
}

register("functions:files", {
	transport: "local",
	contributes: {
		flows: ["operation"],
		tags: ["fileOps", "workspace", "gitHub"],
	},
	handlers: {
		async getData(payload, context) {
			return {
				ok: true,
				data: await _withUser(context, payload, () => filesPlugin.interfaces.config.GetData({ chatid: context?.chatId })),
			};
		},
		async setData(payload, context) {
			let data = payload?.data;
			const rootMutation = _isRootMutation(data);
			if (rootMutation) {
				if (!ROOT_MUTATION_SOURCES.has(context?.dispatchSource) || !context?.user)
					return _authorityError("E_FILES_ROOT_AUTHORITY", "工作区根只能由已认证的 Web 请求修改");
				const bound = _bindTrustedChatId(data, context, "E_FILES_ROOT_AUTHORITY");
				if (!bound.ok) return bound;
				data = bound.data;
			} else if (BROWSE_GRANT_ACTIONS.has(data?._action)) {
				// [D6 §3.2] browse 授权/旧根认领：authenticated context.user + 可信 web/ws 来源硬性要求
				if (!ROOT_MUTATION_SOURCES.has(context?.dispatchSource) || !context?.user)
					return _authorityError("E_BROWSE_SCOPE", "browse 授权只能由已认证的 Web 请求发起");
				const bound = _bindTrustedChatId(data, context, "E_FILES_CHAT_AUTHORITY");
				if (!bound.ok) return bound;
				data = bound.data;
			} else if (FILE_PATH_ACTIONS.has(data?._action) || CHAT_SCOPED_STATE_ACTIONS.has(data?._action)) {
				const bound = _bindTrustedChatId(data, context, "E_FILES_CHAT_AUTHORITY", { required: true });
				if (!bound.ok) return bound;
				data = bound.data;
			}
			return { ok: true, data: await _withUser(context, payload, () => filesPlugin.interfaces.config.SetData(data)) };
		},
	},
});

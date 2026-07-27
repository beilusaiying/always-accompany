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

function _withUser(context, payload, fn) {
	const username = context?.user ?? payload?.username;
	return username ? _filesAls.run({ username }, fn) : fn();
}

register("functions:files", {
	transport: "local",
	contributes: {
		flows: ["operation"],
		tags: ["fileOps", "workspace", "gitHub"],
	},
	handlers: {
		async getData(payload, context) {
			return { ok: true, data: await _withUser(context, payload, () => filesPlugin.interfaces.config.GetData()) };
		},
		async setData(payload, context) {
			return { ok: true, data: await _withUser(context, payload, () => filesPlugin.interfaces.config.SetData(payload?.data)) };
		},
	},
});

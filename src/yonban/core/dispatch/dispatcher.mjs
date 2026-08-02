/**
 * dispatcher.mjs — yonban 计算图·边（唯一派发函数，已接生产流量：桥 POST /api/yonban/dispatch + 前端 sendAction + ModeDef runner 正线，T5/T6/中间站桥切流量后 T1"影子接入"已成历史）
 *
 * 【YonBan 定位铁律（凛倾 2026-07-16 定案，全 yonban 树适用，详见 yonban/README.md）】
 *   yonban 只是插件/扩展，不是本体。禁以「YonBan 已有/已替代」为由自行下线/查封/注释掉 shells 侧本体功能；
 *   查封/下线必须凛倾拍板且注释带拍板日期与恢复条件（提示词查看器案：0714 凛倾令查封→0716 凛倾令回补，
 *   查封注释没写出处差点被当永久下线）。本体 vs yonban 疑似重复 → 默认保本体。
 *
 * 【功能链】
 *   调用方构造 message{verb,target,source,payload,scope} → dispatch(message)
 *   ① registry.get(target) 查表（找节点）
 *   ② resolveScope(scope) 装冻结 context（用谁的数据）
 *   ③ switch(entry.transport) 选通道：local 直调 handlers[verb] / subprocess / remote
 *   → result{ok,data,error} 回调用方；副作用 = 节点内显式 dispatch 到出口节点（exits.mjs），
 *     不设中央 resultSink（凛倾 07-02 校准砍简，0_总架构 §五）。
 *
 * 【why】
 *   凛倾 07-02 原话：「Map 注册表 + dispatch 派发 + switch 传输适配，message = {verb, target, source,
 *   payload, scope}，transport 归 registry，复杂度全外置」+ 计算图：「定义节点和边，数据沿着边流动，
 *   到达节点时执行操作…JS 原生能力就够了」。
 *   dispatcher 零业务：无 intent 分支、无特判 target——发现想加业务分支 = 停手，业务归节点（T1 任务 md §九）。
 *
 * 【白盒】
 *   每次 dispatch 在边上打统一 span（wbSpan，line="dispatch"）：requestId/target/verb/source/耗时/ok
 *   → server/whitebox.mjs RING 环形缓冲(500) + console 去重 + WS wb_trace → 前端 backendMonitor 面板。
 *   复用现有白盒骨干，不另造环形内存（0_总架构 §六"span 是骨干新增不是替换"——wbSpan 即骨干）。
 *
 * 【关联链】
 *   ← 生产调用方：web_server/yonban_bridge.mjs（桥入口，前端 sendAction 经它过来）/ pipelines/_runtime/runner.mjs（ModeDef 正线）/ endpoints·chatStorage·parts_loader·watcher 等（grep "dispatcher.mjs" 为准）
 *   → registry.mjs（查表）/ scopeResolver.mjs（装 context）/ ../transport/index.mjs（subprocess/remote 档）
 *   → server/whitebox.mjs（wbSpan 埋点）
 *
 * 【影响范围】
 *   本文件自身无 IO 副作用；副作用全在节点 handler 内。异常收敛为 E_INVOKE 错误 result（不外抛，
 *   边上不留未捕获 Promise）。
 */
import { wbSpan } from "../../../server/whitebox.mjs";
import { registry } from "./registry.mjs";
import { resolveScope } from "./scopeResolver.mjs";
import { remoteInvoke, subprocessInvoke } from "../transport/index.mjs";
// dispatcher 是所有节点派发的唯一入口；内建出口必须随入口自举，不能依赖调用方碰巧先 import functions/all。
// exits 只向 registry 注册节点，不反向导入 dispatcher，故这里不会形成派发循环。
import "./exits.mjs";

let _reqSeq = 0;

/**
 * 唯一派发入口。
 * @param {object} msg
 * @param {string} msg.verb    - 节点上的操作名（GetPrompt / 标签名 / setData action 名 / …）
 * @param {string} msg.target  - 节点名（"functions:macro" / "bus:broadcast" / …）
 * @param {string} msg.source  - 源节点（"web" / "ai" / "scheduler" / "bot:discord" / "yonban" / "test"）
 * @param {object} [msg.payload] - 异构载荷，形状由 target+verb 定（契约②）
 * @param {object} [msg.scope]   - { user, card, chatId, mode, … }（契约④）
 * @returns {Promise<{ok:boolean, data?:any, error?:{code:string, msg:string}}>}
 */
export async function dispatch(msg) {
	const requestId = `d${++_reqSeq}-${Date.now().toString(36)}`;
	const end = wbSpan(msg?.scope?.chatId ?? null, "dispatch", `${msg?.target}.${msg?.verb}`, {
		requestId, target: msg?.target, verb: msg?.verb, source: msg?.source,
	});
	const fail = (code, m) => { end({ ok: false, code }); return { ok: false, error: { code, msg: m } }; };

	const entry = registry.get(msg?.target);                          // ① 查表（找节点）
	if (!entry) return fail("E_NODE", `${msg?.target} 未注册`);
	const fn = entry.handlers?.[msg?.verb];
	if (!fn && entry.transport === "local")
		return fail("E_NODE", `${msg?.target}.${msg?.verb} 未注册`);

	const context = await resolveScope(msg?.scope);                   // ② scope→context（card→user→default 写死那层）
	try {
		let result;
		switch (entry.transport) {                                      // ③ 选通道（边的物理类型，节点属性）
			case "local":      result = await fn(msg.payload, context); break;
			case "subprocess": result = await subprocessInvoke(entry, msg, context); break;
			case "remote":     result = await remoteInvoke(entry, msg, context); break;
			default:           return fail("E_TRANSPORT", `未知 transport: ${entry.transport}`);
		}
		end({ ok: result?.ok !== false });
		return result;
	} catch (e) {
		return fail("E_INVOKE", String(e?.message ?? e));
	}
}

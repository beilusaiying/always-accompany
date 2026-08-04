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
import { wbSpan, runWithAmbientChatId } from "../../../server/whitebox.mjs";
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

	const scopeContext = await resolveScope(msg?.scope);              // ② scope→context（card→user→default 写死那层）
	// source 是入口服务端盖章的请求事实，必须晚于 scope 合并并再次冻结，防 scope/payload 冒充来源。
	const context = Object.freeze({ ...scopeContext, dispatchSource: msg?.source });
	if (entry.transport !== "local" && entry.transport !== "subprocess" && entry.transport !== "remote")
		return fail("E_TRANSPORT", `未知 transport: ${entry.transport}`);
	try {
		// ALS ambient chatid 装配（凛倾 0804 批准）：原本只有 generation 回合体包 runWithAmbientChatId，
		// SetData/GetData 等派发路径上插件打的 wbD/wbT(null,…) 因 _cid=null 不广播、前端实时面板看不到
		// （只能走 /api/v1/monitor/whitebox 环读出）。dispatch 是所有节点派发唯一入口，在边上单点装配：
		// 带 scope.chatId 的派发内，全部下游 null-cid 白盒事件自动映射到该 chat 的前端面板。
		// chatId 缺省（falsy）时 runWithAmbientChatId 直通 fn() 并继承外层 ALS——嵌套派发不丢回合归属。
		// 信任级与 :59 wbSpan 同源（scope.chatId 由入口盖章）；ALS 只用于观测映射，不进任何授权判定。
		const result = await runWithAmbientChatId(msg?.scope?.chatId ?? null, async () => {
			switch (entry.transport) {                                    // ③ 选通道（边的物理类型，节点属性）
				case "local":      return await fn(msg.payload, context);
				case "subprocess": return await subprocessInvoke(entry, msg, context);
				case "remote":     return await remoteInvoke(entry, msg, context);
			}
		});
		end({ ok: result?.ok !== false });
		return result;
	} catch (e) {
		return fail("E_INVOKE", String(e?.message ?? e));
	}
}

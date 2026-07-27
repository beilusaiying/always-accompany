/**
 * transport/index.mjs — 三档传输适配（T1：local 通；subprocess/remote 留接口，T3.5/T3.7 接）
 *
 * 【功能链】
 *   dispatcher switch(entry.transport) → 本模块 subprocessInvoke/remoteInvoke →（目标批次接入后）
 *   子进程桥（eye/plugin-host 现状机制收敛；graphrag 已删 2026-07-22 凛倾拍板）/ 远程 WS（YonBan 8931 / bot）。
 *   local 档零适配：dispatcher 直调 handlers[verb]，不经本模块（0_总架构 §三 switch 里 local 直调，
 *   「本地库不背跨进程握手复杂度，零序列化开销」契约③§二）。
 *
 * 【why】
 *   「逻辑一条线，物理三档，不把本地调用和跨进程握手压成同一机制」（契约③）。
 *   T1 只建边机制不接桥——subprocess 成员（eye/plugin-host；原第三成员 graphrag 已删）各自硬编码握手是现状，
 *   收敛到统一子进程适配器发生在 T3.5(mcp)/T3.7(screenshot) 迁移批；remote 在 rollback 标注批/YonBan 交界。
 *   未接前调用返回 E_TRANSPORT_TODO 错误 result（不 throw——dispatch 对外 result 形状统一 {ok,data,error}）。
 *
 * 【影响范围】
 *   T1 无任何 IO；返回错误对象纯内存。
 */

/** 子进程档调用（T3.5/T3.7 接：Deno.Command + IPC + 令牌闸 + 进程对账，契约③§三） */
export async function subprocessInvoke(entry, msg, _context) {
	return {
		ok: false,
		error: { code: "E_TRANSPORT_TODO", msg: `subprocess 档未接入（T3.5/T3.7）: ${msg?.target}.${msg?.verb}` },
	};
}

/**
 * 远程档调用（对接批实装 2026-07-02，契约③§四）——YonBan WS 8931。
 *
 * 【复用不重写】remote 的物理层不是新建：进程级 ideClient 单例（T066 迁入 transport/ideClient.mjs，同库同级）
 *   已承载全部 WS 流量（信封 {type,id,payload}，41 tool 收敛于 type=tool_call——分身I协议对照表）。
 *   本函数只做【换算面】：msg{verb,target,payload} → callToolAndStore(tool=verb, params=payload)
 *   → tool_result{success,result,error} → result{ok,data,error}。
 * 【语义完整性】走 callToolAndStore 而非裸 callTool：写锁/多窗口协调/写后激活是 remote 调用的
 *   既有行为面；D3 安全闸在 callTool 内（单一 choke point，source 未预检=fail-closed 拦命令类）——
 *   dispatch 边来的调用不带 replyHandler 预检，被闸拦=正确安全语义非缺陷。
 * 【错误面】未连接 → {ok:false, E_REMOTE "IDE 未连接"}（真实状态，fail loud 非 TODO）；
 *   闸拦 → E_GATE 带 needsApproval/riskLevel 透传（审批流上游可消费）。
 * 【bot 平台对端】后续批按 entry.remote.kind 扩展（本版 entry 默认=yonban 通道）。
 * 【消费方须知（实测 wb:pendingResults:push 坐实）】callToolAndStore 的 Store=结果自动入
 *   enqueuePendingResult 续喂队列（下轮 GetPrompt 注入）——与 AI 标签线同语义。这与出口节点
 *   bus:feed 存在职责重叠（既有机制,行为等价原则本批不拆）；纯调用不要续喂的场景待后续批
 *   把写锁下沉 callTool 后改走裸调用（记 T8 优化清单,不在本批擅自重构 ideClient）。
 */
export async function remoteInvoke(entry, msg, context) {
	// T066：ideClient 已迁入本目录（transport/），同库同域，直接静态 import 同级实现体（原跨 part 动态 import 范式作废）。
	const { ideClient } = await import("./ideClient.mjs");
	const chatid = context?.chatId ?? msg?.scope?.chatId ?? null;
	const r = await ideClient.callToolAndStore(msg?.verb, msg?.payload ?? {}, chatid);
	if (r?.success === false) {
		return {
			ok: false,
			error: {
				code: r.gateBlocked ? "E_GATE" : "E_REMOTE",
				msg: r.error || `remote 调用失败: ${msg?.target}.${msg?.verb}`,
				...(r.needsApproval !== undefined ? { needsApproval: r.needsApproval, riskLevel: r.riskLevel } : {}),
			},
		};
	}
	return { ok: true, data: r?.result !== undefined ? r.result : r };
}

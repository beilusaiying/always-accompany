/**
 * functions/screenshot/index.mjs — 截图/感知系统节点 facade（T3a·3.7 已入住）
 *
 * 【功能链】
 *   传导链：eye 子进程（Python 截图/Electron 桌宠，./main.mjs 管理：3s 自启+4s reconcile）
 *   → POST /api/eye/inject 带 x-pet-token → 令牌闸反解 username → ./injection_state.mjs
 *   setPendingInjection 按 username 单槽暂存（最新截图语义）→ 别组 GetPrompt 消费注入 AI。
 *   dispatch({target:"functions:screenshot", verb:"inject|consume|hasPending", payload})
 *   → injection_state 同一实现。
 *   旧线路：part 加载（GetPartPath('plugins/beilu-eye')）经旧位薄壳；HTTP 路由由 part Load 挂载照旧。
 *
 * 【why】
 *   组14：eye = 子进程适配器成员（契约③§三）；统一子进程适配器收敛（eye/plugin-host 共性；graphrag 已删）
 *   是 core/transport 的后续实装项——本批行为等价优先，子进程管理留实现内不抽（mcp 批同判断）。
 *   injection_state 路径锚全参数传入零适配；main 的 projectRoot 5 级回溯新旧位相同零适配。
 *   browser（网页感知）机制同构但裁决10：不合并，并列节点（T3 后续或标注）。
 *
 * 【影响范围】
 *   inject/consume 读写内存单槽 + data/users/<u>/screenshots 归档（与旧线路同一实现）。
 */
import {
	consumePendingInjection,
	hasPendingInjection,
	setPendingInjection,
} from "./injection_state.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:screenshot", {
	transport: "local",
	handlers: {
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，覆盖 payload 自报。
		// 主链 scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。
		async inject(payload, context) {
			// 真实签名 setPendingInjection(data, username)——injection_state.mjs:78，勿反序
			return { ok: true, data: setPendingInjection(payload?.data, context?.user ?? payload?.username) };
		},
		async consume(payload, context) {
			return { ok: true, data: consumePendingInjection(context?.user ?? payload?.username) };
		},
		async hasPending(payload, context) {
			return { ok: true, data: hasPendingInjection(context?.user ?? payload?.username) };
		},
	},
});

/**
 * yonban_bridge.mjs — 中间站桥：前端→后端统一 dispatch 入口（HTTP 过桥段）
 *
 * 【功能链】
 *   前端 sendAction 粒子 {verb,target,payload,scope} → POST /api/yonban/dispatch（原样过桥不翻译）
 *   → auth 正门（auth_request+getUserByReq，parts_router 同款）→ 三条服务端强制（见下）
 *   → dispatch(message)（计算图的边，wbSpan 白盒既有埋点自动有痕）→ {ok,data,error} 原样回前端。
 *   设计原话锚：驱动文件第三部分「调用方永远用同一个 dispatch(message) 函数」。
 *
 * 【三条服务端强制（不信客户端）】
 *   ① source="web" 服务端定死（body 的 source 丢弃）
 *   ② scope.user = session 身份（getUserByReq 服务端事实，覆盖客户端值——节点 facade 换算面
 *      以 context.user 为身份权威，联动 SEC-T1 收口，杜绝 payload 冒充横向越权）
 *   ③ target 只放行 functions: 命名空间（bus: 与 store: 出口节点=内部副作用面、
 *      remote: 有 D3 闸自治——结构性拒绝，非逐节点配置；securityClass 预留位留细粒度未来）
 *
 * 【零业务红线】（dispatcher 同款纪律）
 *   桥不解析 payload、不认识具体 target、无 verb 分支——业务归节点，发现想加=停手。
 *   不可序列化载荷（如 functions:api structCall 的 source 实例）过桥后调用自炸
 *   → dispatch E_INVOKE fail loud，桥不做特判。
 *
 * 【关联链】
 *   ← web_server/index.mjs 主组装区挂载
 *   → yonban/core/functions/all.mjs（首请求惰性 import：全量注册自举，经验13）
 *   → yonban/core/dispatch/dispatcher.mjs（唯一派发）
 *
 * 【影响范围】
 *   新增路由，不动既有任何端点；惰性 import 保证 web_server 启动期与 yonban 树零静态耦合
 *   （与 prompt_struct.mjs 切流量同款）。回滚=删 index.mjs 挂载行。
 */
import { auth_request, getUserByReq } from "../../yonban/core/functions/security/auth.mjs";

export function registerYonbanBridge(router) {
	router.post("/api/yonban/dispatch", async (req, res) => {
		if (!(await auth_request(req, res))) {
			// auth_request false 时不保证已写响应（parts_router 是 return next() 走 404 兜底；
			// 桥是终端路由无下游，必须自己收口——否则请求悬空挂死连接）
			if (!res.headersSent)
				res.status(401).json({ ok: false, error: { code: "E_AUTH", msg: "未认证" } });
			return;
		}
		const { username } = await getUserByReq(req);
		if (!username)
			return res.status(401).json({ ok: false, error: { code: "E_AUTH", msg: "未登录" } });

		const { verb, target, payload, scope } = req.body ?? {};
		if (typeof target !== "string" || !target.startsWith("functions:"))
			return res.json({
				ok: false,
				error: { code: "E_BRIDGE_TARGET", msg: `桥只暴露 functions:* 节点（收到 "${target}"）` },
			});

		// 惰性自举：首请求装载全量节点 + dispatch（启动期零耦合；模块缓存使后续请求零开销）
		const [{ dispatch }] = await Promise.all([
			import("../../yonban/core/dispatch/dispatcher.mjs"),
			import("../../yonban/core/functions/all.mjs"),
		]);

		const result = await dispatch({
			verb,
			target,
			source: "web",                                   // 强制①
			payload,
			scope: { ...(scope ?? {}), user: username },     // 强制②：session 身份覆盖
		});
		res.json(result);
	});
}

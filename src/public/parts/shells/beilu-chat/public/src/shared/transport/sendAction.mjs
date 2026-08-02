/**
 * [sendAction.mjs] — 前端统一出向出口（T6·6a 起步 2026-07-02，现已过 6b 全量收口）。
 *   不管 WS 回向/事件分发（那是 websocket.mjs 的事）、不管超时/401（那是 api-client.mjs 的事）。
 *
 * 【0802 校验·状态更新】头注释原描述"6a 门面壳阶段·零消费方零流量"已腐烂——实测现状：
 *   82 个前端文件调用 sendAction()，本文件内建约 140 条 registerAction/registerBridgeAction
 *   路由注册（覆盖 shells:chat / plugins:全部 / server:全部），是事实上的全出向单一收口；
 *   路由登记方式与原设想也有出入：并非"各库文件 import 本壳后各自 registerAction"，
 *   而是集中写死在本文件内（registerAction 本身仍从未被外部文件调用过）。
 *
 * 功能链：用户点/开/切 → panels 面板构造 message{verb,target,source:'web',payload,scope:{chatId}}
 *   → sendAction(message) 单一出口 → scope.chatId 单点盖章（_beiluCurWinChatId 优先/hash 兜底）
 *   → 请求去重（inflight 共享 + 2s TTL 缓存，键=buildUrl+body）→ 查路由映射（精确 target#verb
 *   优先，miss 回退通配 target#*）→ WS dispatch 优先（桥路由，走 websocket.mjs dispatchViaWs）
 *   失败/不适用则 HTTP 兜底（apiFetch）→ 失败统一弹报错（含 target+verb 定位，notify 分级
 *   toast/report）→ 后端 dispatch → 节点 → WS 回向照旧（websocket.mjs 事件，不动）→ 渲染。
 *
 * 两类路由：直连 REST（buildUrl 指向各库 /api/parts/... 端点）/ 桥路由（registerBridgeAction，
 *   统一转 POST /api/yonban/dispatch，回包 {ok,data,error} 由 unwrap 还原成旧 REST 裸数据形状）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（超时+401 统一层，本壳不重复实现）
 *   → shared/transport/websocket.mjs dispatchViaWs（动态 import，防循环依赖）
 *   ← 82 处前端调用方（panels/* 全域 + shared/chat-core·render·widgets 等）
 *
 * 影响范围：本文件是全出向调用点的单一收口；改动 _routes 匹配/去重/WS-HTTP 切换逻辑影响全站请求。
 */
import { apiFetch } from "./api-client.mjs";

/** 路由映射：`${target}#${verb}` → { method, buildUrl(message), buildBody?(message) }（6b 逐库注册） */
const _routes = new Map();

// WS dispatch 动态 import（避免 sendAction↔websocket 静态循环依赖）。
// null=未尝试, undefined=加载失败(不重试), function=可用。
let _dispatchViaWs = null;

// 请求去重（统一出向层，凛倾 0718「为什么不做一个统一的」定案件）：
// [0727 凛倾「出现重复的直接变成一条」] 从 GET-only 扩展到全方法：
//   GET 键 = buildUrl 产物（天然含 chatId/查询参数）；POST/PUT/DELETE 键 = URL + body 序列化
//   （不同 payload 的 mutation 天然分键，同 payload 的重复调用合并）。
// inflight 阶段：同键后续调用共享同一 Promise。
// TTL 阶段：成功响应缓存 _DEDUP_TTL ms，同键后续调用直接返回缓存（解轮询重叠）；失败不缓存。
// [0719 键修正] scope 盖章之后取键（原实现在盖章前取键=跨管线串数据）。
const _dedup = new Map(); // dedup key → Promise (inflight pending 或 TTL 期间的 resolved)
const _DEDUP_TTL = 2000;

async function _getWsDispatch() {
	if (_dispatchViaWs === undefined) return null; // 已尝试加载但失败，不重试
	if (_dispatchViaWs) return _dispatchViaWs;
	try {
		const mod = await import("./websocket.mjs");
		_dispatchViaWs = mod.dispatchViaWs || null;
	} catch {
		_dispatchViaWs = undefined; // 标记加载失败，不重试
	}
	return _dispatchViaWs || null;
}

/**
 * 注册一个出向路由（6b 各库收口时调用；同 key 覆盖）。
 * @param {string} target - 如 "plugins:beilu-memory"
 * @param {string} verb - 如 "switchMode"
 * @param {{method?:string, buildUrl:(m:object)=>string, buildBody?:(m:object)=>any, buildHeaders?:(m:object)=>object}} route
 */
export function registerAction(target, verb, route) {
	_routes.set(`${target}#${verb}`, route);
}

/**
 * 唯一出向出口。
 * @param {object} message - {verb, target, source?, payload?, scope?:{chatId?,...}}
 * @returns {Promise<any>} 后端响应；失败统一报错后 rethrow（调用方可再处理，但用户已可见）
 */
export async function sendAction(message) {
	const { verb, target } = message ?? {};
	// [键收口 2026-07-13] 会话上下文单点盖章：本文件头功能链设计态 message.scope:{chatId} 从未被调用方填过，
	//   导致各面板各自往 payload 手拼 chatid/chatId（漏拼=后端落 "_default" 键，2026-07-13 子模式多出口
	//   不同步确诊病根）。此处统一从守卫单源 _beiluGetChatId 盖章（非法 hash 返 ""），调用方显式给 scope 优先。
	//   下游消费：dispatcher.mjs:51 遥测、桥映射 scope.chatId→args.chatid（与既有 scope.charId→args.char_id 同构）。
	//   [0727 多窗口窗口化] 盖章值升级为**可见窗口优先**（_beiluCurWinChatId，lineManager 单源）、hash 兜底：
	//   副窗口显示时 hash 仍是主窗口 a 的指针（切窗刻意不写 hash），按 hash 盖章=把 b 里发起的请求
	//   全部记到 a 名下（A5 审计确诊的最大杠杆泄漏点）。无窗口体系时桥不存在，行为与原来逐字相同。
	if (message && (message.scope?.chatId == null)) message.scope = { ...(message.scope ?? {}), chatId: (() => { try { return window._beiluCurWinChatId?.() || ""; } catch { return ""; } })() || window._beiluGetChatId?.() || "" };
	// 精确路由优先，miss 回退该库通配路由（`target#*`，6b：一库一条 setdata 通配+特例精确注册）
	const route = _routes.get(`${target}#${verb}`) ?? _routes.get(`${target}#*`);
	if (!route) {
		// fail loud：未注册=链路断裂，即时感知不静默（06-03 原话）
		const msg = `[sendAction] 未注册的出向路由: ${target}#${verb}`;
		_report(msg, message);
		throw new Error(msg);
	}
	// 请求去重（全方法，键含 body；见文件头 _dedup 注释）
	let _dk = null;
	try {
		_dk = route.buildUrl(message);
		if (route.method && route.method !== "GET") {
			const _body = route.buildBody ? route.buildBody(message) : message.payload;
			_dk += "\0" + JSON.stringify(_body);
		}
	} catch { _dk = null; }
	if (_dk) {
		const _existing = _dedup.get(_dk);
		if (_existing) return _existing;
		const _p = _sendActionInner(message, verb, target, route).then(
			result => {
				const _resolved = Promise.resolve(result);
				_dedup.set(_dk, _resolved);
				setTimeout(() => { if (_dedup.get(_dk) === _resolved) _dedup.delete(_dk); }, _DEDUP_TTL);
				return result;
			},
			err => { _dedup.delete(_dk); throw err; },
		);
		_dedup.set(_dk, _p);
		return _p;
	}
	return _sendActionInner(message, verb, target, route);
}

async function _sendActionInner(message, verb, target, route) {
	try {
		// 1. WS 双向 dispatch 优先：中间层走 WS 不占 HTTP 连接槽（浏览器 HTTP/1.1 同源 6 连接限制）。
		//    只对桥路由生效：buildBody 翻译前端 target（plugins:beilu-memory）→ 后端 target（functions:memory），
		//    非桥路由的 buildBody 不产出 dispatch 格式（无 target/verb 字段）→ 直接走 HTTP。
		const _wsFn = await _getWsDispatch();
		if (_wsFn) {
			const _wsBody = route.buildBody ? route.buildBody(message) : null;
			if (_wsBody && _wsBody.target && _wsBody.verb) {
				const _wsP = _wsFn({ target: _wsBody.target, verb: _wsBody.verb, payload: _wsBody.payload, scope: _wsBody.scope }, route.timeout);
				if (_wsP) {
					try {
						const _wsRes = await _wsP;
						return route.unwrap ? route.unwrap(_wsRes) : _wsRes;
					} catch {
						// WS dispatch 失败（超时/断连）→ fall through 到 HTTP 兜底
					}
				}
			}
		}
		// 2. HTTP 兜底（WS 不可用或 WS dispatch 失败时）— 并发限流在 apiFetch 层统一做
		const _opts = {
			method: route.method ?? "POST",
			body: route.buildBody ? route.buildBody(message) : message.payload,
		};
		if (route.buildHeaders) _opts.headers = route.buildHeaders(message);
		if (route.timeout != null) _opts.timeout = route.timeout;
		const res = await apiFetch(route.buildUrl(message), _opts);
		return route.unwrap ? route.unwrap(res) : res;
	} catch (e) {
		// 失败统一可见：含 target+verb 定位信息（诊断面职责——显示真实错误+定位，不装饰）
		// notify 分级（凛倾拍板「读路失败降 toast 不降显示」）：route.notify==="report" 时失败仍可见
		//   （console.error + window._reportError 进后端报错中心）但跳过 toast 弹窗——解「诊断面/后台轮询
		//   读路失败递归弹 toast」而不完全静默。缺省="toast"=现行为（三路全走）。
		_report(`[sendAction] ${target}#${verb} 失败: ${e?.message ?? e}`, message, route.notify);
		throw e;
	}
}

// ============================================================
// 6b 首批内置注册（featureControls 收口涉及的四库路由；后续库逐批追加）
// verb 语义=真动作（后端 setdata 的 _action 提升为 verb——对齐粒子契约），通配路由负责组装 _action。
// ============================================================

/** plugins 的 config/setdata 通配路由（verb→_action；payload 其余字段平铺进 body） */
function _registerPluginSetdata(pluginName) {
	registerAction(`plugins:${pluginName}`, "*", {
		method: "POST",
		buildUrl: () => `/api/parts/plugins:${pluginName}/config/setdata`,
		buildBody: (m) => ({ _action: m.verb, ...(m.payload ?? {}) }),
	});
}
_registerPluginSetdata("beilu-memory");
_registerPluginSetdata("beilu-reach");
// beilu-cli：CLI 工具后端插件（无头 YonBan 宿主）。写路走通配（verb=start/stop/restart/setConfig
//   → SetData switch）；读路精确注册 getData（GET getdata，回 {status,config} 聚合快照——
//   前端 CLI 设置区单次拉全，值单源在后端，ideConnPanel 零硬编码）。
_registerPluginSetdata("beilu-cli")
// P1 自驱动召回（2026-07-31 改造：Deno 插件 → 独立 Python 服务，002 拍板"单独/可插拔/可独立运行"）：
//   target 名保持 plugins:beilu-p1-selfdriven（前端三面板/typingSuggest 零改动），路由单点重定向到
//   shells/p1 薄壳 → Python 服务（verb 名=服务路由名一一对应：updateConfig/runP1/getStats/unloadCaches/
//   listVocabs/atSearch/atBrowse/getUserVocab/saveUserVocab/toggleUserVocab/deleteUserVocab/
//   getP9Prompts/saveP9Prompts/resetP9Prompts）。旧插件通配注册已停用（服务不在→薄壳 503 明确报错）。
registerAction("plugins:beilu-p1-selfdriven", "*", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:p1/service/${m.verb}`,
	buildBody: (m) => ({ ...(m.payload ?? {}) }),
});
registerAction("plugins:beilu-p1-selfdriven", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/shells:p1/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-cli", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-cli/config/getdata",
	buildBody: () => undefined,
});
// P1-2（一致性审计②）：beilu-mvu config 读/写收口（原 pluginManager.mjs apiFetch 直连、门面零覆盖）。
//   精确注册而非 _action 通配：mvu 后端 SetData(req.body) 直收 {enabled}（prompt/mvu/main.mjs setdata 路由），
//   套 _action 模板会把 _action 字段一并写成配置污染。URL 用字面量 ':'（Express 注册的 '\\:' 只是转义）。
registerAction("plugins:beilu-mvu", "getConfig", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-mvu/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-mvu", "setConfig", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-mvu/config/setdata",
	buildBody: (m) => (m.payload ?? {}),
});
// [0731 EJS 门控断链根修] beilu-ejs config 读/写（同 mvu 精确注册形状；后端路由=sandbox/main.mjs Load）。
//   此前门面零注册 + pluginManager 的 beilu-ejs 条目无 backendApiBase → 前端开关只写 localStorage、
//   后端 pluginEnabled 永远默认 true =「我 ejs 都关闭了哪来的 ejs」事故（0731 凛倾）。
registerAction("plugins:beilu-ejs", "getConfig", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-ejs/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-ejs", "setConfig", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-ejs/config/setdata",
	buildBody: (m) => (m.payload ?? {}),
});

// [退役] beilu-preset updatePresetConfig REST 注册已被下方桥段 registerBridgeAction 切桥覆盖（字段写
//   raw 语义保留：桥 payload={data:前端payload,args:{}}，不注入 _action）。

// [退役] beilu-files 通配+updateFilesConfig REST 注册已被下方桥段 registerBridgeAction 切桥覆盖
//   （混合分发语义保形：通配注 _action 走 switch / raw 字段写不注入进 field-update 分支）。

// ============================================================
// 中间站桥通道（统一 dispatch 入口 /api/yonban/dispatch，粒子原样过桥不翻译——
// 驱动文件第三部分「调用方永远用同一个 dispatch(message)」）。
// 桥回包 {ok,data,error}；unwrap 还原成旧 REST 裸数据形状=调用方零改动；
// ok:false 时抛 error（dispatch E_NODE/E_INVOKE fail loud 透传到统一报错面）。
// 身份：桥服务端 session 盖章（scope.user 客户端值被覆盖），payload 不必带 username。
// ============================================================
// backendVerb：前端 verb（REST _action 名）≠ 节点 verb 时的映射（如 setActiveSubMode→facade setData，
// _action 进 payload.data）；缺省=前端 verb 同名直通（getData 先例）。
function registerBridgeAction(frontTarget, verb, backendTarget, mapPayload, backendVerb) {
	registerAction(frontTarget, verb, {
		method: "POST",
		buildUrl: () => "/api/yonban/dispatch",
		buildBody: (m) => ({
			verb: backendVerb ?? verb,
			target: backendTarget,
			payload: mapPayload ? mapPayload(m) : m.payload,
			scope: m.scope,
		}),
		unwrap: (res) => {
			if (res?.ok === false) throw new Error(`${res.error?.code ?? "E"}: ${res.error?.msg ?? "dispatch 失败"}`);
			return res?.data;
		},
	});
}

// beilu-memory 读路——【桥试点·首条退役】原 REST：GET /config/getdata（旧端点 args={...query,username}，
// 桥等价：payload.args=前端参数、username 由桥 session 盖章+facade 换算面注入，到达同一 handleGetData）。
// [键收口补全 2026-07-16] args.chatid=scope.chatId 会话上下文注入（镜像 :152/:161 setData 线同范式）：
//   getDataHandler:83-85 通道本就预留（"前端带 chatid 时按本窗口模式读表格/状态，与 GetPrompt 注入同一权威"），
//   0713 键收口只接了 setData 线、getData 线漏接 → _cid 恒 undefined → 隔离模式(code/work)读 char 级
//   空模板而 AI 写 `<mode>_ctx/<chatId>/`（读A写B，UI 恒显示 0 行）。scope 铺在 payload 前=调用方显式 chatid 优先。
registerBridgeAction("plugins:beilu-memory", "getData", "functions:memory", (m) => ({ args: { ...(m.scope?.chatId ? { chatid: m.scope.chatId } : {}), ...(m.payload ?? {}) } }));

// beilu-memory 写路首条过桥：setActiveSubMode（前置已闭环：_subModeSwitch 广播副作用迁 facade→bus:broadcast
// 出口，exits.mjs emit 透传 event+memory/index.mjs setData 挂副作用，与 REST main.mjs:97-110 同语义双线并存至退役）。
// 旧 REST：POST setdata body={_action:"setActiveSubMode", id, chatId}（该 verb 调用方无 char_id query）；
// 桥等价：payload.data=同 body、args={}，到达同一 handleSetData(data,args)（setDataActions.mjs:3159 返回
// {success, active_sub_mode…, _subModeSwitch}——unwrap 后与旧 REST 裸返回体等形，调用方零改动）。
// [键收口 2026-07-13] args.chatid=scope.chatId 会话上下文注入（镜像 :161-169 scope.charId→args.char_id 既有范式）：
//   后端 case 普遍已读 `args?.chatid` 兜底（setActiveSubMode:3698 / flowGroup 族 :3898,:3944,:4012,:4033,:4048）——
//   通道本就预留，前端从未填过=各面板散拼 chatid 的病根。payload 显式键仍按各 case 原精度优先（data 先于 args）。
registerBridgeAction("plugins:beilu-memory", "setActiveSubMode", "functions:memory", (m) => ({ data: { _action: "setActiveSubMode", ...(m.payload ?? {}) }, args: { ...(m.scope?.chatId ? { chatid: m.scope.chatId } : {}) } }), "setData");

// beilu-memory 写路【通配过桥】——覆盖上方 _registerPluginSetdata("beilu-memory") 的 REST 通配（Map 同键
// `plugins:beilu-memory#*` 后注册者胜）：全部 setdata _action 族 verb 一次切桥。
// 等价根基：REST P 型壳 beilu-memory/main.mjs:168 SetData=(data,args)=>handleSetData(data,args) 与
// facade setData 到达【同一 handleSetData】；身份=桥 session 盖章+facade 换算面（SEC-T1 联动）；
// _subModeSwitch 副作用已在 facade 挂 bus:broadcast（setActiveSubMode 首条端到端 PASS 含 WS 回程实证）。
// 精确注册优先命中不受影响（getData 桥版/getDataSystem+addRouteNote 等 char_id 特例仍走各自路由，
// 路由 miss 才回退本通配）。m.verb=运行时真 verb（注册形参 verb="*" 只作键）。
registerBridgeAction("plugins:beilu-memory", "*", "functions:memory", (m) => ({ data: { _action: m.verb, ...(m.payload ?? {}) }, args: { ...(m.scope?.chatId ? { chatid: m.scope.chatId } : {}) } }), "setData");

// 记忆快照系（memtool 运维 Tab）char 上下文精确桥注入（修5 断链 20260716）：
//   后端三 case 全按 charName 落域（setDataActions:911 charName=data.charName||args?.char_id||"_global"，
//   快照对象=该 char 的记忆目录），memtool 调用方从未带 charName → 整套快照系统性锚 `_global`——
//   用户以为在给当前角色卡拍/恢复快照，实际拍/恢复的是全局记忆目录（视图与动作不同域）。
//   修法复用既有板块：精确注册 + charName=payload 显式优先 ?? _beiluGetCharId 单源（镜像 beilu-preset
//   getData 桥 :248 同款注入；⚠不落通配——通配盲注 char_id 会把检索配置等【合法 _global 域】verb
//   一并搬家，同 :170「不能落上方通配」判据）。无角色绑定时 _beiluGetCharId 空 → undefined → 后端
//   落 _global（旧快照仍可见，优雅退化）。
for (const _snapVerb of ["createSnapshot", "listSnapshots", "restoreSnapshot"]) {
	registerBridgeAction("plugins:beilu-memory", _snapVerb, "functions:memory", (m) => ({
		data: { _action: _snapVerb, ...(m.payload ?? {}), charName: m?.payload?.charName ?? (window._beiluGetCharId?.() || undefined) },
		args: { ...(m.scope?.chatId ? { chatid: m.scope.chatId } : {}) },
	}), "setData");
}

// dataSystem char_id 特例族过桥（分身 W1 功能链调查全程举证：前端 verb 经 scope.charId 传 char_id
// [dataSystemPanel refreshDataSystem/_ackWarning/_addRouteNote]→桥 args→消费点 args?.char_id
// [getDataHandler/setDataActions addRouteNote/ackDataWarning]——桥 payload.args 与旧 REST query 逐字段
// 等价到达同一消费点，无 query/args 分叉。⚠ 不能落上方通配（args 写死空 char_id 会丢），精确注册
// 优先命中；映射=scope.charId→args.char_id。旧 REST 精确注册（下方 :400 区）被同键覆盖退役。
// （2026-07-16 凛倾拍板去重：saveFramework/saveIssues 桥注册已随后端 case 删除——框架/问题
//   与 code 记忆表格 #3/#4 概念重复，归记忆表格单源；线路/警告独有机制保留。）
registerBridgeAction("plugins:beilu-memory", "getDataSystem", "functions:memory", (m) => {
	const cid = m?.scope?.charId ?? m?.payload?.charId;
	return { args: { ...(cid ? { char_id: cid } : {}) } };
}, "getData");
for (const v of ["addRouteNote", "ackDataWarning"])
	registerBridgeAction("plugins:beilu-memory", v, "functions:memory", (m) => {
		const cid = m?.scope?.charId ?? m?.payload?.charId;
		const { charId: _drop, ...rest } = m?.payload ?? {};
		return { data: { _action: v, ...rest }, args: { ...(cid ? { char_id: cid } : {}) } };
	}, "setData");

// beilu-browser 桥注册已删（2026-07-16）：仅删的是本文件的前端 sendAction 桥注册 + functions:browser
//   facade；插件本体 src/public/parts/plugins/beilu-browser/（main.mjs 745 行 + driver/ 完整 CDP 驱动）
//   在盘活跃未删，勿泛化误判"插件已删"（与 messageList.mjs 同源注释已同步校准）。

// beilu-regex 同构切桥（节点已入住 functions:regex[index.mjs:23]+all.mjs:20，无需建节点）。
// 功能链（W1 清单③ + 本批 Read 原文举证）：前端调用方 getData[regexEditor:58/displayRegex:421]/
//   写 verb 族[regexEditor:63 setRegexData/preset:91 syncPresetRegex/:116 removeByPreset/panels:621]
//   → 旧 REST getdata/setdata[functions/regex/main.mjs:577/587]→ interfaces.config.GetData()/SetData(req.body)。
// 等价根基（T077 后更新）：旧"模块级 pluginData 单例"已 per-user 化为 perUserStore Map（regex/main.mjs getStore），
//   REST 路由已加 authenticate+getUserByReq，SetData 改双参 (data,args) 消费 args.username 分桶；
//   桥线身份=yonban_bridge:64 session 强制盖章 scope.user → facade context.user 透传，本处 mapPayload 无需带身份。
// ⚠ 契约差异（对比 memory/browser）：regex facade setData 收【整 payload】平铺 {_action,...payload}，
//   不带 .data 包裹（username 由 facade 层注入 args，非 payload 携带）。
// 读路 getData：GetData() 无参 → 桥 payload={}，backendVerb=getData（同名直通可省，显式写对齐 browser 先例）。
registerBridgeAction("plugins:beilu-regex", "getData", "functions:regex", () => ({}), "getData");
// 写路通配：覆盖下方 :400 区旧 REST 通配（Map 同键 `plugins:beilu-regex#*` 后注册胜 → 旧注册须删退役防同键覆盖桥版）。
//   全 setdata _action 族（addRule/removeRule/updateRule/toggleAll/setRenderMode/setGuardConfig/importST/
//   syncPresetRegex/removeByPreset/moveScope/duplicateRule/… main.mjs:627-）一次切桥。平铺 {_action:verb,...payload}
//   = 旧 REST buildBody[原 :415]逐字段等形，unwrap 还原裸返回体（{_result:{id}} / {rules,enabled,…}）调用方零改动。
registerBridgeAction("plugins:beilu-regex", "*", "functions:regex", (m) => ({ _action: m.verb, ...(m.payload ?? {}) }), "setData");

// ---- beilu-worldbook 切桥（W2 调查+主 AI 核原文）----
// 节点=functions:prompt（早已装载 all.mjs:17，无 prod 窗口——但换算面本批补：facade wbSetData 原丢
// _context，ctx.username 被 dynamic 激活表格联动消费[worldbook/main.mjs:1150-1154]，不注入=静默回归，
// 已改盖章模式+prod 后端先行重启）。字段路由禁 _action 注入：桥 payload={data:{[字段名]:前端payload}, ctx:{}}
// 对齐 facade wbSetData→SetData(payload.data, payload.ctx)。旧 REST 工厂注册删除退役（时序防覆盖）。
registerBridgeAction("plugins:beilu-worldbook", "getData", "functions:prompt", () => ({}), "wbGetData");
// 孤儿verb期3：补 rename_worldbook / export_worldbook——后端 SetData 有 case（worldbook/main.mjs:1045 data.rename_worldbook / :979 data.export_worldbook），
//   前端 panels.mjs 世界书编辑器工具栏新增重命名/导出入口，但原桥白名单漏注这两 verb → 无路由=功能断链。
//   同 {data:{[v]:payload},ctx:{}} 字段写形（username 由 wbSetData facade 盖章 context.user，与 create_worldbook 同源 per-user store）。
//   注：wbSetData facade（prompt/index.mjs:111）不 unwrap _result（不同于 regex 桥），worldbook SetData 全族返回 {_result:{...}}
//   （export 早 return / SetData 尾部统一磁盘写结果上浮，行号随文件漂移锚功能不锚行）；本桥 unwrap 只取 res.data → 调用方拿 {_result:{...}}，消费侧自读 res._result（panels.mjs 世界书导出/重命名已如此）。
// 使用链审计0706：补 import_worldbook / delete_worldbook——后端 SetData 有 case（worldbook/main.mjs:975 data.import_worldbook / :1006 data.delete_worldbook），
//   旧壳 beilu-home 有入口（tabs/worldbook.mjs:581/:640）而 beilu-chat 零入口=功能未迁移（用户在新壳无法导入独立世界书JSON、无法删世界书）。
//   导入导出聚合面板（importExport.mjs 世界书卡）跳转目标=内联编辑器，本批在其工具栏补两入口，桥路由此处同步补齐。
//   契约（亲读后端）：import 重名=静默覆盖（:983 直接赋值，前端须 confirm）、json.entries 缺失=静默 no-op（:977，前端先校验）、导入后自动激活（:988）；
//   delete 不存在=静默 no-op，删激活书后端自动切换剩余第一本。两者均落 SetData 尾部统一磁盘写结果上浮 return {_result:{success}}（锚功能不锚行）。
// 契约对账0706：补 reorder_entries——后端有实现（worldbook/main.mjs:1207 data.reorder_entries {order:uid[]}）
//   白名单漏注=桥路不通（与孤儿verb期3 rename/export 漏注同型同根）；前端排序 UI 未建（UI 候选登记），先通桥供 REST/AI 侧与后续 UI。
for (const v of ["toggle_worldbook", "switch_worldbook", "bind_worldbook", "create_worldbook", "update_entry", "add_entry", "delete_entry", "toggle_entry", "rename_worldbook", "export_worldbook", "import_worldbook", "delete_worldbook", "reorder_entries"])
	registerBridgeAction("plugins:beilu-worldbook", v, "functions:prompt", (m) => ({ data: { [v]: m.payload ?? {} }, ctx: {} }), "wbSetData");

// ---- beilu-preset 切桥（W2 调查+主 AI 核原文）----
// 节点=functions:prompt 同上；换算面本批补（facade setData 原丢 _context，消费链 preset/main.mjs:1167
// args?.username||data?.username||"_default"——不注入落错用户+自报越权洞，已改盖章模式）。
// preset 纯字段路由禁通配禁 _action：updatePresetConfig=raw 字段写，桥 payload={data:前端payload, args:{}}
// 对齐 facade setData→SetData(payload.data, payload.args)。switch_preset 广播 preset_changed 在 SetData
// 内部（:1140 区）→桥自动等价触发免前置。runtime-params 独立端点（get/setRuntimeParams）保留 REST（facade
// 无对应 handler，方向性待定）。旧 getData GET/updatePresetConfig REST 注册删除退役。
// 2026-07-09 收口审计：chatid 桥层统一注入（单点收口，7 个调用点免改）——后端 GetData 据此下发
//   active_preset_resolved（权威解析，精确键>裸键与生成链同源），resolveActivePresetFor 优先消费。
//   window._beiluGetChatId 由 sharedState.mjs:127 暴露（禁 import：sharedState→sendAction 已有依赖，反向 import 成环）。
// [预设隔离 2026-07-11] charName 同批注入：线级 active_modes_map 落 per-char _config.json（storage.mjs setActiveMode），
//   GetData 解析 resolved 的 getActiveMode 原硬编码 "_global" 桶 → 选了角色时读写分桶，线级模式恒 miss。
registerBridgeAction("plugins:beilu-preset", "getData", "functions:prompt", (m) => ({ requestedPreset: m?.payload?.requestedPreset, chatid: m?.payload?.chatid ?? (window._beiluGetChatId?.() || undefined), charName: m?.payload?.charName ?? (window._beiluGetCharId?.() || undefined) }), "getData");
// [隔离架构 2026-07-24] args 坐标注入（镜像 :211/:221 memory 线与下方 getData 线既有键收口范式）：
//   原 args:{} = setdata 线零坐标——import_preset 等按坐标二分激活的动作，凡调用方没在 payload
//   手拼 chatid（settings/panels.mjs、importExport.mjs 两入口实证）就落全局分支夺全局默认槽
//   （0724 四格齐变总病根之一）。后端语义：payload 显式坐标 > args 注入坐标；无坐标动作（如 bot
//   面板显式全局 switch_preset）后端只读 data.switch_preset.chatid 不吃 args 兜底，语义不受影响。
registerBridgeAction("plugins:beilu-preset", "updatePresetConfig", "functions:prompt", (m) => ({ data: m.payload ?? {}, args: { ...(m.scope?.chatId ? { chatid: m.scope.chatId } : {}), ...(window._beiluGetCharId?.() ? { charName: window._beiluGetCharId() } : {}) } }), "setData");

// ---- beilu-files 切桥（W3 ALS 专项调查+主 AI 设计，五插件后最后一块→六库全过桥）----
// 节点=functions:files（本批新建）：身份换算面=ALS run 包裹（pluginData 是 Proxy 全字段 per-user
// [main.mjs:2078-2091]，SetData(data) 单参无身份位——facade import _filesAls 有身份才 run({username})，
// 与 REST 端点 :2331/:2345 同机制同 store 形状；无身份直调=forgetChatState 先例 _default 语义）。
// 混合分发保形：有 _action 走 switch（通配注 _action）；无 _action 字段写（updateFilesConfig raw 不注入）。
// facade setData→SetData(payload.data)——data 即旧 REST body。无 WS 广播副作用（W3 复核）。
registerBridgeAction("plugins:beilu-files", "getData", "functions:files", () => ({}), "getData");
registerBridgeAction("plugins:beilu-files", "*", "functions:files", (m) => ({ data: { _action: m.verb, ...(m.payload ?? {}) } }), "setData");
registerBridgeAction("plugins:beilu-files", "updateFilesConfig", "functions:files", (m) => ({ data: m.payload ?? {} }), "setData");

// [退役] beilu-files getData GET REST 已被上方 registerBridgeAction("plugins:beilu-files","getData",…) 切桥覆盖（时序防覆盖删除）。

// ---- beilu-web / beilu-sysinfo 纯 REST 配置槽（T2批1收口，2026-07-09）----
//   后端 functions/web/main.mjs Load + functions/prompt/sysinfo/main.mjs Load 已注册 /config/getdata|setdata
//   （authenticate + interfaces.config 全局单例），functions 节点【未入住 /api/yonban/dispatch 桥】→ 用 REST
//   精确注册（对照 plugins:beilu-preset#getDataForPreset 同款 REST 先例），非 registerBridgeAction。
//   前端 URL /api/parts/plugins:beilu-web|beilu-sysinfo/config/getdata|setdata 直接命中后端 part 作用域 router。
//   settingsSlots initWebConfigSlot / initSysinfoConfigSlot 收口。字段整表直写（无 _action），回包=解析体裸体。
registerAction("plugins:beilu-reach", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-reach/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-web", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-web/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-web", "updateWebConfig", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-web/config/setdata",
	buildBody: (m) => m.payload ?? {}, // 字段直写，无 _action（后端 web/main.mjs 字段分支）
});
registerAction("plugins:beilu-sysinfo", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-sysinfo/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-sysinfo", "updateSysinfoConfig", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-sysinfo/config/setdata",
	buildBody: (m) => m.payload ?? {}, // 字段直写（含 customFields 整表），无 _action
});

// [退役] beilu-preset getData GET REST 已被上方 registerBridgeAction("plugins:beilu-preset","getData",…) 切桥覆盖（时序防覆盖删除）。

// beilu-preset 运行时参数（A2 过桥，07-03）：REST 独立端点→functions:prompt get/setRuntimeParams verb。
//   后端=preset main 纯函数单源（buildRuntimeParamsView/applyRuntimeParams，REST 薄壳同源）；
//   返回等形：get=merged 裸对象 / set={success,params}（桥 unwrap 还原）。身份=桥 session 盖章（context.user 标量直传）。
//   旧 REST 注册删除退役（时序防覆盖）；REST 端点本体保留双线至消费面消亡。
// [P3 参数分母 2026-07-13] chatid+charName 桥层统一注入（对齐 :235 getData 同款收口，3 个调用点免改）：
//   后端 buildRuntimeParamsView 据此走 per-chat/per-mode 精确解析 _effective_max_context——原空 payload
//   = resolveEffectiveMaxContextLive 全 null best-effort（扫首个子模式/全局预设）= token 条 238%/2% 双报盘、
//   切模式分母漂移根因。不带时后端行为同旧（零回归）。
registerBridgeAction("plugins:beilu-preset", "getRuntimeParams", "functions:prompt", (m) => ({ chatid: m?.payload?.chatid ?? (window._beiluGetChatId?.() || undefined), charName: m?.payload?.charName ?? (window._beiluGetCharId?.() || undefined) }), "getRuntimeParams");
registerBridgeAction("plugins:beilu-preset", "setRuntimeParams", "functions:prompt", (m) => (m.payload ?? {}), "setRuntimeParams");

// [2026-08-01 W6] toggle 手动控制面：前端读/写桥（prompt/index.mjs toggleGetData/toggleSetData verb）
registerBridgeAction("plugins:beilu-toggle", "getData", "functions:prompt", () => ({}), "toggleGetData");
registerBridgeAction("plugins:beilu-toggle", "setData", "functions:prompt", (m) => ({ data: m.payload ?? {} }), "toggleSetData");

// hide 思维链配置写路（24批1，07-03）：原写路只经 memory#updateConfig（读 hide/写 memory 门面分裂="只有airp能改"根因）——
//   补 functions:hide#setReasoningTags 直达桥（纯桥新增无旧 REST；返回 {success,config}；写后端会同步清 hide TTL 缓存+memoryCache）。
registerBridgeAction("functions:hide", "setReasoningTags", "functions:hide", (m) => (m.payload ?? {}), "setReasoningTags");

// AI 注入文本配置链（0710 铁律【代码禁产生进对话文本】收口专项，纯桥新增无旧 REST）：
//   读路 getData → 目录+覆盖+生效值全量；写路 setData payload={overrides:{key:string|null}}（null=恢复默认）。
//   后端节点 functions/injectTexts/index.mjs；消费方 settingsSlots.initInjectTextsSlot。
registerBridgeAction("functions:injectTexts", "getData", "functions:injectTexts", () => ({}), "getData");
registerBridgeAction("functions:injectTexts", "setData", "functions:injectTexts", (m) => ({ data: m.payload ?? {} }), "setData");

// server 级用户设置（后端白名单校验 key；T6b 批2：settingsSlots 语言同步收口）
registerAction("server:user", "setSetting", {
	method: "POST",
	buildUrl: () => "/api/setusersetting",
	buildBody: (m) => m.payload ?? {},
});

// chat 壳只读：对话长度（scope.chatId 进 URL）
registerAction("shells:chat", "getLogLength", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}/log/length`,
	buildBody: () => undefined,
});

// chat 壳：新建对话（T6b 批3：workPanel _renderHistoryPanel 新建按钮）
registerAction("shells:chat", "new", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/new",
	buildBody: () => undefined,
});

// chat 壳：确保角色卡四窗口对话（0802 四窗口对话收口：resolveChatIdForChar/initializeChat 调用，
//   单源=后端 ensureModeChatsForChar，幂等）。body {charname}，返回 {modeChats: {chat,smart,code,work}}。
registerAction("shells:chat", "ensureModeChats", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/ensure-mode-chats",
	buildBody: (m) => m.payload ?? {},
});

// chat 壳：对话列表（T6b 批3：workPanel _loadHistoryList）
registerAction("shells:chat", "getChatList", {
	method: "GET",
	buildUrl: () => "/api/parts/shells:chat/getchatlist",
	buildBody: () => undefined,
});

// chat 壳：删除对话（DELETE + body {chatids:[...]}；T6b 批3：workPanel 删除按钮）
registerAction("shells:chat", "deleteChat", {
	method: "DELETE",
	buildUrl: () => "/api/parts/shells:chat/delete",
	buildBody: (m) => m.payload ?? {},
});

// serviceSourceManage 壳：AI 源列表（T6b 批3：subModePanel 获取 AI 源）
registerAction("shells:serviceSourceManage", "getAISources", {
	method: "GET",
	buildUrl: () => "/api/parts/shells:serviceSourceManage/AI",
	buildBody: () => undefined,
});

// ============================================================
// 分身K 注册（T6b 批·shared-ui/ 目录收口，2026-07-02）
// 覆盖 13 文件：backendMonitor/extendMenuW28/dataSystemPanel/tokenProgressBar/permissionPanel/
//   mobileAdaptation/iframeRenderer/groupPanel/groupRuntimePanel/tempConversation/（skillInjectBar 已 0706 D6 整删）
//   mcpPanel/skillPicker（featureControls/settingsSlots 已在批1、批2 完成）。
// verb=真动作；plugins:_dynamic=运行时插件名动态场景（mcpPanel 详情/工具展开/testTool）。
// ============================================================

// plugins:_dynamic = 运行时插件名动态场景（mcpPanel loadPluginDetails/工具展开/testTool 等）。
//   payload._pluginName 提供实际插件名；verb=真动作（如 listTools/testTool），后端 _action 由通配组装。
//   为什么不复用 plugins:beilu-memory 类通配：这些场景插件名来自后端返回的 partName（未知集合），
//   注册每个插件名不现实——用一个"动态 target"承载所有非固定插件的出向。
registerAction("plugins:_dynamic", "getConfig", {
	method: "GET",
	buildUrl: (m) => `/api/parts/plugins:${encodeURIComponent(m?.payload?._pluginName ?? "")}/config/getdata`,
	buildBody: () => undefined,
});
registerAction("plugins:_dynamic", "*", {
	method: "POST",
	buildUrl: (m) => `/api/parts/plugins:${encodeURIComponent(m?.payload?._pluginName ?? "")}/config/setdata`,
	buildBody: (m) => {
		const { _pluginName, ...rest } = m?.payload ?? {};
		return { _action: m.verb, ...rest };
	},
});

// shells:chat 只读/写路合集（scope.chatId 进 URL；shared-ui 迁移侧重）
registerAction("shells:chat", "loadChatData", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "getLogLengthVisible", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}/log/length?visible=1`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "getLog", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}/log?start=${m?.payload?.start ?? 0}&end=${m?.payload?.end ?? 0}`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "getFakeSend", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}/fake-send`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "sendMessage", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${m?.scope?.chatId}/message`,
	buildBody: (m) => m.payload ?? {},
});
registerAction("shells:chat", "getChatPlugins", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/plugins`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "removePlugin", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/plugin/${encodeURIComponent(m?.payload?.pluginName ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "mountPlugin", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/plugin`,
	buildBody: (m) => m.payload ?? {},
});

// shells:chat groups 系（groupPanel/groupRuntimePanel 共用）
registerAction("shells:chat", "getGroups", {
	method: "GET",
	buildUrl: () => `/api/parts/shells:chat/groups`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "createGroup", {
	method: "POST",
	buildUrl: () => `/api/parts/shells:chat/groups`,
	buildBody: (m) => m.payload ?? {},
});
registerAction("shells:chat", "removeGroup", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/shells:chat/groups/${encodeURIComponent(m?.payload?.gid ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "bindGroupRole", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/groups/${encodeURIComponent(m?.payload?.gid ?? "")}/role`,
	buildBody: (m) => {
		const { gid, ...rest } = m?.payload ?? {};
		return rest;
	},
});
registerAction("shells:chat", "unbindGroupRole", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/shells:chat/groups/${encodeURIComponent(m?.payload?.gid ?? "")}/role/${encodeURIComponent(m?.payload?.role ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "executeGroup", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/groups/${encodeURIComponent(m?.payload?.gid ?? "")}/execute`,
	buildBody: () => ({}),
});
registerAction("shells:chat", "getGroupsEngine", {
	method: "GET",
	buildUrl: () => `/api/parts/shells:chat/groups/engine`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "setGroupsEngine", {
	method: "POST",
	buildUrl: () => `/api/parts/shells:chat/groups/engine`,
	buildBody: (m) => m.payload ?? {},
});
// [0727 并发闸] 用户级 AI 并发上限（设置面板 API 区旋钮，消费方 apiConfig.mjs）
registerAction("shells:chat", "getAiConcurrency", {
	method: "GET",
	buildUrl: () => `/api/parts/shells:chat/ai-concurrency`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "setAiConcurrency", {
	method: "POST",
	buildUrl: () => `/api/parts/shells:chat/ai-concurrency`,
	buildBody: (m) => m.payload ?? {},
});

// server-level 端点（非 part 层）：security / monitor / chars-cache
registerAction("server:security", "getMcpServers", {
	method: "GET",
	buildUrl: () => `/api/security/mcp-servers`,
	buildBody: () => undefined,
});
registerAction("server:security", "approveMcp", {
	method: "POST",
	buildUrl: () => `/api/security/mcp-approve`,
	buildBody: (m) => m.payload ?? {},
});
// 命令执行闸 commandGate 段（0714：capabilities/failClosedUnknown/allowChannelBExec 前端承载，
//   原本后端可调但零 UI = 前端丧失后端可调项；消费方=permissionPanel 详细规则窗）。
registerAction("server:security", "getCommandGate", {
	method: "GET",
	buildUrl: () => `/api/security/command-gate`,
	buildBody: () => undefined,
});
registerAction("server:security", "setCommandGate", {
	method: "POST",
	buildUrl: () => `/api/security/command-gate`,
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:security", "getCommandRules", {
	method: "GET",
	buildUrl: () => `/api/security/command-rules`,
	buildBody: () => undefined,
});
// 0715 硬编码改选项：黑/灰名单+git push 远程白名单写入（owner；键=null 恢复代码默认，数组=整体覆盖）
registerAction("server:security", "setCommandRules", {
	method: "POST",
	buildUrl: () => `/api/security/command-rules`,
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:monitor", "getPlugins", {
	method: "GET",
	notify: "report",
	buildUrl: () => `/api/v1/monitor/plugins`,
	buildBody: () => undefined,
});
// ---- 报错中心/诊断面监控读路（T2批23，2026-07-09）----
//   凛倾拍板：诊断面/后台轮询读路失败不弹 toast（否则报错中心自己拉错误会递归弹窗打扰），但必须仍可见
//   （console.error + window._reportError 进后端报错系统）——故读路 verb 全带 notify:"report"。
//   toggleWhitebox 是交互写按钮（用户手动切白盒开关），失败应弹 toast 让用户知道没生效 → 缺省 notify（toast）。
//   后端端点（server/monitor.mjs registerMonitorRoutes，authenticate 走同源 cookie）：
//     GET /api/v1/monitor/errors?limit= / /health / /whitebox；POST /whitebox/toggle。
registerAction("server:monitor", "getErrors", {
	method: "GET",
	notify: "report",
	// limit 走 payload.limit 进 query（后端 :315 parseInt(req.query.limit)||100，上限 1000）；
	// source 过滤（fetchLogs 错误来源）同走 payload.source（后端 /errors 支持 source 参数）。
	// dedupe（导出去重）：后端同指纹折叠为一条（monitor.mjs /errors dedupe=1），面板列表不带。
	buildUrl: (m) => {
		const q = new URLSearchParams();
		if (m?.payload?.limit != null) q.set("limit", String(m.payload.limit));
		if (m?.payload?.source) q.set("source", m.payload.source);
		if (m?.payload?.dedupe) q.set("dedupe", "1");
		const qs = q.toString();
		return `/api/v1/monitor/errors${qs ? "?" + qs : ""}`;
	},
	buildBody: () => undefined,
});
registerAction("server:monitor", "getHealth", {
	method: "GET",
	notify: "report",
	buildUrl: () => "/api/v1/monitor/health",
	buildBody: () => undefined,
});
registerAction("server:monitor", "getWhitebox", {
	method: "GET",
	notify: "report",
	buildUrl: () => "/api/v1/monitor/whitebox",
	buildBody: () => undefined,
});
registerAction("server:monitor", "toggleWhitebox", {
	method: "POST",
	// 交互写按钮：缺省 toast（失败让用户可见没生效）。body {enabled}。
	buildUrl: () => "/api/v1/monitor/whitebox/toggle",
	buildBody: (m) => m.payload ?? {},
});
// ---- beilu-logger 运行时日志（T2批23）：读 getLogs 走 report（诊断面轮询），交互写 clearLogs 缺省 toast ----
//   后端 plugins/beilu-logger/main.mjs：GET .../logs?since=&level=&limit=（:138）/ POST .../clear（:181）。
registerAction("plugins:beilu-logger", "getLogs", {
	method: "GET",
	notify: "report",
	// query 由 payload 组装：level（缺省 'all'）/limit（后端上限 LOG_BUFFER_SIZE）/since（增量）。
	buildUrl: (m) => {
		const q = new URLSearchParams();
		if (m?.payload?.level) q.set("level", m.payload.level);
		if (m?.payload?.limit != null) q.set("limit", String(m.payload.limit));
		if (m?.payload?.since) q.set("since", m.payload.since);
		const qs = q.toString();
		return `/api/parts/plugins:beilu-logger/logs${qs ? "?" + qs : ""}`;
	},
	buildBody: () => undefined,
});
registerAction("plugins:beilu-logger", "clearLogs", {
	method: "POST",
	// 交互按钮（清空日志确认后）：缺省 toast。
	buildUrl: () => "/api/parts/plugins:beilu-logger/clear",
	buildBody: () => undefined,
});
// ---- shells:chat 初始数据校验（T2批23）：/new 页 initial-data 存在性探测，带 timeout:8000 快速失败跳转 ----
//   scope.chatId 进 URL；notify:"report"（后台校验读路失败不弹 toast，进报错系统）。
registerAction("shells:chat", "getInitialData", {
	method: "GET",
	notify: "report",
	timeout: 8000,
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/initial-data`,
	buildBody: () => undefined,
});
// ---- chat 读路静默兜底专用 verb（T2批23，C1/C2）----
//   C1（settingsSlots 插件活跃标记读）/C2（fake-send 下拉对话列表读）原为 catch{} 静默降级（空列表/次要 UI）。
//   getChatPlugins/getChatList 已有缺省注册，供 workPanel 等"期望可见"的调用用——禁降它们的 toast，
//   故单独注册 *Quiet 版带 notify:"report"（URL/body 与缺省版逐字等价，仅 notify 分级不同）。
registerAction("shells:chat", "getChatPluginsQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/plugins`,
	buildBody: () => undefined,
});
registerAction("shells:chat", "getChatListQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: () => "/api/parts/shells:chat/getchatlist",
	buildBody: () => undefined,
});
// D1（charscript _loadScriptsForChar 读 chardata）：外层 catch=console.warn 静默降级（加载脚本失败=次要，不打扰）。
//   现状已迁 getCharData（缺省 toast，T6b批7）——本批按凛倾「读路降 toast」精神降级为 Quiet（方案 MD 描述的
//   apiFetch+diag.warn 现状与 live 冲突，以 live 代码为准：只把 getCharData→getCharDataQuiet）。
//   getCharData 缺省版供 chatmgmt 存在性校验等"期望可见"的读用，禁降其 toast，故单独 Quiet 版。
registerAction("shells:chat", "getCharDataQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: (m) => `/api/parts/shells:chat/char-data/${encodeURIComponent(m?.payload?.charId ?? "")}`,
	buildBody: () => undefined,
});
registerAction("server:chars", "listAllCached", {
	method: "GET",
	buildUrl: () => `/api/getallcacheddetails/chars`,
	buildBody: () => undefined,
});

// shells:install 文本导入（mcpPanel MCP 导入按钮点击）
registerAction("shells:install", "importText", {
	method: "POST",
	buildUrl: () => `/api/parts/shells:install/text`,
	buildBody: (m) => m.payload ?? {},
});

// beilu-memory dataSystem 特例族（getDataSystem/addRouteNote/ackDataWarning；saveFramework/saveIssues
// 已 2026-07-16 去重删除）：原 REST 精确注册（GET/POST ?char_id= query）已退役——桥版精确注册见上方桥段
// （scope.charId→args.char_id，W1 调查证等价；Map 同键序=此处旧版删除防覆盖桥版）。路由表逐条退役第一批。

// ===== 分身R（T6b批7 init/chat/memory/task/regex）注册 =====
// verb=真动作；已注册的库路由（beilu-memory#* / beilu-files#* / beilu-preset#* / shells:chat#* / server:user 等）直接复用不重复。
// 本段只补本批 grep 出的、此前未注册的缺口路由。

// [退役] beilu-regex getData GET REST 已被上方 registerBridgeAction("plugins:beilu-regex","getData",…) 切桥覆盖（regex 同构入住 functions:regex）。
// [退役] beilu-regex 写路通配 setdata 已被上方 registerBridgeAction("plugins:beilu-regex","*",…) 切桥覆盖。
//   删除主因=时序陷阱：此二注册在桥段（:181 区）之后，Map 同键会同键覆盖桥版 → 必须删除退役（§七范式）。路由表逐条退役续批。


// beilu-eye 自定义服务端路由（beilu 框架未给 beilu-eye 注册 part HTTP 路由，改用 endpoints.mjs 的 /api/eye/*——
//   见 panels/companion/eye.mjs 注释）。故用 server:eye target 而非 plugins:beilu-eye。verb=真动作。
registerAction("server:eye", "getData", {
	method: "GET",
	buildUrl: () => "/api/eye/getdata",
	buildBody: () => undefined,
});
registerAction("server:eye", "getStatus", {
	method: "GET",
	buildUrl: () => "/api/eye/status",
	buildBody: () => undefined,
});
registerAction("server:eye", "consume", {
	method: "POST",
	buildUrl: () => "/api/eye/consume",
	buildBody: () => undefined,
});
// eye setdata 写路通配（restart/stop/clear）：POST /api/eye/setdata，body 组装 {_action:verb, ...payload}。
registerAction("server:eye", "*", {
	method: "POST",
	buildUrl: () => "/api/eye/setdata",
	buildBody: (m) => ({ _action: m.verb, ...(m.payload ?? {}) }),
});

// chat 壳：读角色卡完整 chardata（GET /char-data/:charId；panels/airp/chatmgmt.handleNewChat 存在性校验 + panels/airp/charscript._loadScriptsForChar 取 chardata）。
//   charId 走 payload.charId（非 scope.chatId——这是角色维度不是对话维度）。
registerAction("shells:chat", "getCharData", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/char-data/${encodeURIComponent(m?.payload?.charId ?? "")}`,
	buildBody: () => undefined,
});
// chat 壳：把角色绑定到新建对话（POST /:chatId/char，body {charname}；panels/airp/chatmgmt.handleNewChat）。chatId 进 URL，charname 进 body。
registerAction("shells:chat", "bindCharToChat", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/char`,
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：bot 对话文件 ensure（凛倾 07-09「当前角色卡新建对话+绑定」，幂等，一个平台一个；
//   body {charname, platform}；bot 面板按钮 + 命名带 BOT_CHAT_SYMBOL 供列表屏蔽）。
registerAction("shells:chat", "newBotChat", {
	method: "POST",
	buildUrl: () => `/api/parts/shells:chat/newbotchat`,
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：更新人设描述（PUT /persona/:name/update，body=FormData；panels/airp/persona 保存按钮）。
//   personaName 进 URL，payload.formData 为 FormData 原样透传（apiFetch 检测 FormData 不 JSON.stringify、不设 Content-Type）。
registerAction("shells:chat", "updatePersona", {
	method: "PUT",
	buildUrl: (m) => `/api/parts/shells:chat/persona/${encodeURIComponent(m?.payload?.personaName ?? "")}/update`,
	buildBody: (m) => m?.payload?.formData,
});
// chat 壳：更新角色卡描述（PUT /update-char/:charId，JSON body {description}；panels/airp/charinfo 保存按钮）。
//   charId 进 URL，其余字段进 body（剥离 charId meta）。
registerAction("shells:chat", "updateChar", {
	method: "PUT",
	buildUrl: (m) => `/api/parts/shells:chat/update-char/${encodeURIComponent(m?.payload?.charId ?? "")}`,
	buildBody: (m) => {
		const { charId, ...rest } = m?.payload ?? {};
		return rest;
	},
});
// chat 壳：新建对话并带 body（POST /new，body=payload，如 {charName}；shared/transport/endpoints.createNewChat）。
//   与既有 shells:chat#new（无 body）区分：createChat 透传 payload 到 /new（后端可选消费 charName）。
registerAction("shells:chat", "createChat", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/new",
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：分叉对话（POST /branch，body {chatid,messageIndex}；shared/chat-core/conversationManager.branchConversation）。
registerAction("shells:chat", "branch", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/branch",
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：全文搜索（POST /search，body {query,limit,charName?}；shared/chat-core/conversationManager._doFulltextSearch）。
registerAction("shells:chat", "search", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/search",
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：批量删除消息范围（POST /:chatId/messages/delete-range，body {startIndex,endIndex}；shared/transport/endpoints.deleteMessagesRange）。
registerAction("shells:chat", "deleteMessagesRange", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/messages/delete-range`,
	buildBody: (m) => m.payload ?? {},
});
// chat 壳：渲染条目（GET /:chatId/render/entries?charId&charName；shared/render/messageList.fetchRenderEntries 世界书渲染）。
//   chatId 进 URL，charId/charName 进 query（payload 取值，缺省不带）。
registerAction("shells:chat", "getRenderEntries", {
	method: "GET",
	buildUrl: (m) => {
		const q = new URLSearchParams();
		if (m?.payload?.charId) q.set("charId", m.payload.charId);
		if (m?.payload?.charName) q.set("charName", m.payload.charName);
		const qs = q.toString();
		return `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/render/entries${qs ? "?" + qs : ""}`;
	},
	buildBody: () => undefined,
});
// chat 壳：AIRP 渲染期视图（GET /:chatId/airp/view?charId；shared/render/displayRegex.loadAirpCaps 消费）。
//   与上方 getRenderEntries 同构：chatId 进 URL，charId 进 query。返回 {caps, blocks}——
//   一次拉取即得能力谱+渲染块，故不再需要 plugins:beilu-airp 直连路由（框架 v6 §十一章4）。
//   REST 直连（buildBody 返 undefined → 不产 dispatch 格式 → 不走 WS 桥，天然避开 WS 不注入 scope.user 的落桶问题）。
registerAction("shells:chat", "getAirpView", {
	method: "GET",
	buildUrl: (m) => {
		const q = new URLSearchParams();
		if (m?.payload?.charId) q.set("charId", m.payload.charId);
		const qs = q.toString();
		return `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/airp/view${qs ? "?" + qs : ""}`;
	},
	buildBody: () => undefined,
});

// ===== 分身S（T6b批8 ide/panels/bot/根）注册 =====
// verb=真动作；已注册库路由（beilu-memory#* / beilu-files#* / shells:chat#getFakeSend|getLog|... /
//   shells:serviceSourceManage#getAISources 等）直接复用，本段只补本批 grep 出的、此前未注册的缺口路由。

// chat 壳：触发角色回复（file_op 审批后踢续轮——传导链修：手动批准的结果进 pendingOpResults 后，
//   续轮生成的 GetPrompt 才 drain 注入给 AI；无此踢则 AI 挂等到用户下次说话）。POST /:chatid/trigger-reply。
registerAction("shells:chat", "triggerReply", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/trigger-reply`,
	buildBody: (m) => m.payload ?? {},
});

// chat 壳：隐藏消息（不发送）——idePanel「手动清理当前文件对话」：POST {startIndex}，scope.chatId 进 URL。
//   后端按 chatid 定位并隐藏 startIndex 起的消息（getCleanupInfo 已按 chatid 分区，见 idePanel N6 注释）。
registerAction("shells:chat", "hideMessages", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/messages/hide`,
	buildBody: (m) => m.payload ?? {},
});

// chat 壳：IDE 手动工具调用（gitPanel git_* / ideConnPanel 手动发工具调用）——统一执行闸+审批门，
//   经后端 ideClient.callTool 走 WS 发 YonBan 扩展。body {chatid, tool, params}（chatid 在 body 非 URL）。
registerAction("shells:chat", "ideManualToolCall", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/ide/manual-tool-call",
	buildBody: (m) => m.payload ?? {},
});

// chat 壳：IDE 公开工具清单（ideConnPanel 手动工具调用下拉；单源=后端 ideClient.availableTools）：GET，回包 {tools}。
registerAction("shells:chat", "ideToolList", {
	method: "GET",
	buildUrl: () => "/api/parts/shells:chat/ide/tool-list",
	buildBody: () => undefined,
});

// chat 壳：IDE WS token 代读（ideConnPanel 连接前取 YonBan 服务端要求的 ?token=）：GET，回包 {token,port}。
registerAction("shells:chat", "ideWsToken", {
	method: "GET",
	buildUrl: () => "/api/parts/shells:chat/ide/wstoken",
	buildBody: () => undefined,
});
// chat 壳：踢后端 ideClient 立即连一次（ideConnPanel onopen 后绕开退避窗口）：POST，回包 {connected}。
registerAction("shells:chat", "ideConnect", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/ide/connect",
	buildBody: () => undefined,
});

// chat 壳：查角色实际绑定 AI 源（apiConfig 绑定指示行 _renderBindingIndicator）：GET，charName 进 URL。
registerAction("shells:chat", "getCharAISource", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/char-aisource/${encodeURIComponent(m?.payload?.charName ?? m?.scope?.charName ?? "")}`,
	buildBody: () => undefined,
});

// ---- beilu-worldbook（worldbookEditor：世界书列表/条目 CRUD）----
// 后端 setdata 语义特殊：不消费 _action，而是按 body 顶层字段名分派（toggle_worldbook/switch_worldbook/
//   update_entry/add_entry/... 见 beilu-worldbook main handleSetData 字段路由）。与 beilu-files 字段写同类，
//   故 verb=真动作=后端字段名，buildBody 组装 { [verb]: payload }（不注入 _action，避免走错分支）。
// [退役] beilu-worldbook getData GET + 字段写工厂（toggle_worldbook/switch_worldbook/bind_worldbook/
//   create_worldbook/update_entry/add_entry/delete_entry/toggle_entry 8 verb）REST 注册已被上方
//   registerBridgeAction 切桥覆盖（字段名映射 {data:{[verb]:payload},ctx:{}}；时序防覆盖删除）。

// ---- shells:_bot：动态 bot 壳（discordBotPanel/botSidePanels 的 10 平台同构端点）----
// bot 壳名（discordbot/telegrambot/slackbot/...）由前端按当前平台运行时决定（非固定集合），
//   与 mcpPanel 的 plugins:_dynamic 同款「动态 target」模式：payload._shell 携带真实壳名，verb=真动作。
//   端点在 /api/parts/shells:<shell>/... 下；各 verb 映射到对应路径+方法（GET 读/POST 写）。
const _botBase = (m) => `/api/parts/shells:${m?.payload?._shell ?? "discordbot"}`;
// 剥离 meta 字段 _shell，返回真实 body。
const _botBody = (m) => { const { _shell, ...rest } = m?.payload ?? {}; return rest; };
registerAction("shells:_bot", "getBotList", {
	method: "GET", buildUrl: (m) => `${_botBase(m)}/getbotlist`, buildBody: () => undefined,
});
registerAction("shells:_bot", "getRunningBotList", {
	method: "GET", buildUrl: (m) => `${_botBase(m)}/getrunningbotlist`, buildBody: () => undefined,
});
registerAction("shells:_bot", "getBotConfig", {
	method: "GET",
	buildUrl: (m) => `${_botBase(m)}/getbotconfig?botname=${encodeURIComponent(m?.payload?.botname ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:_bot", "getBotConfigTemplate", {
	method: "GET",
	buildUrl: (m) => `${_botBase(m)}/getbotConfigTemplate?charname=${encodeURIComponent(m?.payload?.charname ?? "")}`,
	buildBody: () => undefined,
});
// 件14：配置字段元数据（BOT_CONFIG_FIELD_META 后端单源，label/hint 随 schema 下发——业界四家共识形）
registerAction("shells:_bot", "getConfigFieldMeta", {
	method: "GET", buildUrl: (m) => `${_botBase(m)}/getconfigfieldmeta`, buildBody: () => undefined,
});
// bot 命令注册表（BOT_COMMAND_REGISTRY 后端单源，命令词/子命令/用法随注册表下发——
// 前端命令区禁硬编码清单，同 injection_automode_meta 的「后端权威清单下发」范式）
registerAction("shells:_bot", "getBotCommandMeta", {
	method: "GET", buildUrl: (m) => `${_botBase(m)}/getcommandmeta`, buildBody: () => undefined,
});
registerAction("shells:_bot", "getMessageLog", {
	method: "GET",
	buildUrl: (m) => {
		const name = encodeURIComponent(m?.payload?.botname ?? "");
		const since = m?.payload?.since;
		return `${_botBase(m)}/messagelog?botname=${name}${since ? `&since=${since}` : ""}`;
	},
	buildBody: () => undefined,
});
registerAction("shells:_bot", "getActiveChannels", {
	method: "GET",
	buildUrl: (m) => `${_botBase(m)}/activechannels?botname=${encodeURIComponent(m?.payload?.botname ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:_bot", "setBotConfig", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/setbotconfig`, buildBody: _botBody,
});
registerAction("shells:_bot", "newBotConfig", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/newbotconfig`, buildBody: _botBody,
});
registerAction("shells:_bot", "deleteBotConfig", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/deletebotconfig`, buildBody: _botBody,
});
registerAction("shells:_bot", "startBot", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/start`, buildBody: _botBody,
});
registerAction("shells:_bot", "stopBot", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/stop`, buildBody: _botBody,
});
registerAction("shells:_bot", "clearContext", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/clearcontext`, buildBody: _botBody,
});
registerAction("shells:_bot", "setMessageLogSize", {
	method: "POST", buildUrl: (m) => `${_botBase(m)}/setlogsize`, buildBody: _botBody,
});

// ---- shells:serviceSourceManage：AI 源单项 CRUD（apiConfig 面板；getAISources 列表已在批3 注册，复用）----
registerAction("shells:serviceSourceManage", "getAISource", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/${encodeURIComponent(m?.payload?.name ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:serviceSourceManage", "saveAISource", {
	method: "POST",
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/${encodeURIComponent(m?.payload?.name ?? "")}`,
	buildBody: (m) => m?.payload?.data ?? {},
});
registerAction("shells:serviceSourceManage", "deleteAISource", {
	method: "DELETE",
	// T026: mode=trash|permanent 走 query（DELETE 无 body），后端删除路由按此选回收站/彻底删
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/${encodeURIComponent(m?.payload?.name ?? "")}${m?.payload?.mode ? `?mode=${encodeURIComponent(m.payload.mode)}` : ""}`,
	buildBody: () => undefined,
});
registerAction("shells:serviceSourceManage", "getGeneratorTemplate", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/generators/${encodeURIComponent(m?.payload?.generator ?? "")}/template`,
	buildBody: () => undefined,
});
// ---- 静默兜底预读专用读 verb（T2批23）----
//   凛倾拍板：A3（save 前 baseCfg 预读）/A7（new 前 template 预读）原为 catch{} 静默兜底——失败不该打扰用户
//   （baseCfg={}/tmpl={} 继续），迁 sendAction 后不能弹 toast。故单独精确注册 *Quiet 读 verb 带 notify:"report"，
//   不改 getAISource/getGeneratorTemplate 缺省档（那两个供 A2/A6 等"期望可见提示"的读用，禁降它们的 toast）。
//   URL/body 与非 Quiet 版逐字等价，仅 notify 分级不同。
registerAction("shells:serviceSourceManage", "getAISourceQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/${encodeURIComponent(m?.payload?.name ?? "")}`,
	buildBody: () => undefined,
});
registerAction("shells:serviceSourceManage", "getGeneratorTemplateQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: (m) => `/api/parts/shells:serviceSourceManage/AI/generators/${encodeURIComponent(m?.payload?.generator ?? "")}/template`,
	buildBody: () => undefined,
});
// 渠道元数据（2026-07-11 渠道下拉恢复）：provider 枚举+label+默认URL+坑提示，单源=后端 apiAdapters
//   PROVIDER_META（经 serviceSourceManage providermeta 路由转发）。面板初始化静默拉取，失败降级
//   基础渠道表（proxy/gemini）继续可用，故 notify:"report" 进报错系统不弹 toast。
registerAction("shells:serviceSourceManage", "getProviderMetaQuiet", {
	method: "GET",
	notify: "report",
	buildUrl: () => "/api/parts/shells:serviceSourceManage/AI/generators/providermeta",
	buildBody: () => undefined,
});

// ============================================================
// ===== 分身Q（T6b批6 layout/ 目录）注册 =====
// verb=真动作；已注册库路由（beilu-memory#* / beilu-preset#getData|updatePresetConfig / beilu-worldbook#字段写 /
//   beilu-regex#* / server:chars#listAllCached / server:eye#getStatus|* / shells:chat#new|getChatList|getLogLength|
//   bindCharToChat|updatePersona|getCharData / shells:_bot#getRunningBotList / shells:serviceSourceManage#saveAISource 等）
//   直接复用不重复。本段只补本批 grep 出的、此前未注册的缺口路由。
// ============================================================

// ---- server 级列表/详情端点（bot.getPartList / smart 人设列表 / layout getloadedlist / panels 人设缓存）----
registerAction("server:list", "getList", {
	method: "GET",
	buildUrl: (m) => `/api/getlist/${encodeURIComponent(m?.payload?.type ?? "")}`,
	buildBody: () => undefined,
});
registerAction("server:list", "getLoadedList", {
	method: "GET",
	buildUrl: (m) => `/api/getloadedlist/${encodeURIComponent(m?.payload?.type ?? "")}`,
	buildBody: () => undefined,
});
registerAction("server:details", "getDetails", {
	method: "GET",
	buildUrl: (m) => `/api/getdetails/${encodeURIComponent(m?.payload?.type ?? "")}/${encodeURIComponent(m?.payload?.name ?? "")}`,
	buildBody: () => undefined,
});
registerAction("server:details", "getAllCached", {
	method: "GET",
	buildUrl: (m) => `/api/getallcacheddetails/${encodeURIComponent(m?.payload?.type ?? "")}`,
	buildBody: () => undefined,
});

// ---- server:ping（settings 外部集成面板取端口/地址）----
registerAction("server:ping", "get", {
	method: "GET",
	buildUrl: () => "/api/ping",
	buildBody: () => undefined,
	buildHeaders: () => ({ "X-Beilu-Request-Source": "chat-settings-ping" }),
});

// ---- server:apikey（settings 外部应用 API Key 管理）----
registerAction("server:apikey", "getAvailableScopes", {
	method: "GET",
	buildUrl: () => "/api/apikey/available-scopes",
	buildBody: () => undefined,
});
registerAction("server:apikey", "create", {
	method: "POST",
	buildUrl: () => "/api/apikey/create",
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:apikey", "list", {
	method: "GET",
	buildUrl: () => "/api/apikey/list",
	buildBody: () => undefined,
});
registerAction("server:apikey", "revoke", {
	method: "POST",
	buildUrl: () => "/api/apikey/revoke",
	buildBody: (m) => m.payload ?? {},
});

// ---- server:security 补充（getStatus/csp/安全控件动态端点；getMcpServers/approveMcp 分身K 已注册，不重复）----
// 安全中心状态采集（security._loadSecurityStatus）。
registerAction("server:security", "getStatus", {
	method: "GET",
	buildUrl: () => "/api/security/status",
	buildBody: () => undefined,
});
// 安全控件读/写：端点由后端 control 描述符运行时提供（c.endpoint/endpointGet/endpointSet），是动态 URL。
//   payload._endpoint 携带真实端点；其余字段进 body（POST）。与 plugins:_dynamic 同款「动态 URL」模式。
registerAction("server:security", "ctrlGet", {
	method: "GET",
	buildUrl: (m) => m?.payload?._endpoint ?? "",
	buildBody: () => undefined,
});
registerAction("server:security", "ctrlPost", {
	method: "POST",
	buildUrl: (m) => m?.payload?._endpoint ?? "",
	buildBody: (m) => { const { _endpoint, ...rest } = m?.payload ?? {}; return rest; },
});
// CSP 开关（settings UI 设置节；后端 config.csp_enabled 持久化）。
registerAction("server:security", "getCsp", {
	method: "GET",
	buildUrl: () => "/api/security/csp",
	buildBody: () => undefined,
});
registerAction("server:security", "setCsp", {
	method: "POST",
	buildUrl: () => "/api/security/csp",
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:diagnostics", "getRequestLogConfig", {
	method: "GET",
	buildUrl: () => "/api/diagnostics/request-log",
	buildBody: () => undefined,
});
registerAction("server:diagnostics", "setRequestLogConfig", {
	method: "POST",
	buildUrl: () => "/api/diagnostics/request-log",
	buildBody: (m) => m.payload ?? {},
});

// ---- server:eye 补充（/api/eye/config 与 /api/eye/screenshots 等 —— 精确路由，优先于既有 server:eye#* 通配）----
//   注意：server:eye#* 通配（→ /api/eye/setdata）会吞未注册的 eye verb，故 config/screenshots/pet-settings/usermodel-dict
//   这些走独立端点的读写必须以精确 verb 注册（查表精确优先命中，见 sendAction:45）。
registerAction("server:eye", "getEyeConfig", {
	method: "GET",
	buildUrl: () => "/api/eye/config",
	buildBody: () => undefined,
});
registerAction("server:eye", "setEyeConfig", {
	method: "POST",
	buildUrl: () => "/api/eye/config",
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:eye", "getScreenshots", {
	method: "GET",
	buildUrl: (m) => {
		const lim = m?.payload?.limit;
		return lim != null ? `/api/eye/screenshots?limit=${encodeURIComponent(lim)}` : "/api/eye/screenshots";
	},
	buildBody: () => undefined,
});
registerAction("server:eye", "getUserModelDict", {
	method: "GET",
	buildUrl: () => "/api/eye/usermodel-dict",
	buildBody: () => undefined,
});
registerAction("server:eye", "getPetSettings", {
	method: "GET",
	buildUrl: () => "/api/eye/pet-settings",
	buildBody: () => undefined,
});
registerAction("server:eye", "setPetSettings", {
	method: "POST",
	buildUrl: () => "/api/eye/pet-settings",
	buildBody: (m) => m.payload ?? {},
});
registerAction("server:eye", "getPetCapabilities", {
	method: "GET",
	buildUrl: () => "/api/eye/pet-capabilities",
	buildBody: () => undefined,
});
registerAction("server:eye", "getPetMacros", {
	method: "GET",
	buildUrl: () => "/api/eye/pet-macros",
	buildBody: () => undefined, // 表情宏当前值(面板展示/复制;与 preset_engine 宏注入同源)
});
// ---- 图片包(图片模式,任务②③ 2026-07-09):独立端点,必须精确 verb 注册(否则被 server:eye#* 通配吞进 /api/eye/setdata) ----
registerAction("server:eye", "saveUserModel", {
	method: "POST",
	buildUrl: () => "/api/eye/usermodel-save",
	buildBody: (m) => m.payload ?? {}, // entry {name, scale?, xShiftRatio?, yShiftRatio?, ...}(端点字段级 merge)
});
registerAction("server:eye", "scanUserModels", {
	method: "GET",
	buildUrl: () => "/api/eye/usermodel-scan",
	buildBody: () => undefined, // 深扫描:每模型 parameterIds/expressions/motions(待机表情候选等前端读真实集)
});
registerAction("server:eye", "getImagepacks", {
	method: "GET",
	buildUrl: () => "/api/eye/imagepacks",
	buildBody: () => undefined,
});
registerAction("server:eye", "saveImagepack", {
	method: "POST",
	buildUrl: () => "/api/eye/imagepack-save",
	buildBody: (m) => m.payload ?? {}, // {pack, json}
});
registerAction("server:eye", "uploadImagepackImage", {
	method: "POST",
	buildUrl: () => "/api/eye/imagepack-upload",
	buildBody: (m) => m.payload ?? {}, // {pack, filename, dataBase64}
});
registerAction("server:eye", "uploadUserModelFile", {
	method: "POST",
	buildUrl: () => "/api/eye/usermodel-upload",
	buildBody: (m) => m.payload ?? {}, // {model, relPath, dataBase64}(Live2D 文件选择式导入,0722)
});

// ---- beilu-preset 补充：按 preset 名取 entries（panels 预设浏览 getEngineFor 懒加载，不改全局态）----
//   getData（无 query）分身已注册；此路带 ?preset= query，故独立 verb。
registerAction("plugins:beilu-preset", "getDataForPreset", {
	method: "GET",
	buildUrl: (m) => `/api/parts/plugins:beilu-preset/config/getdata?preset=${encodeURIComponent(m?.payload?.preset ?? "")}`,
	buildBody: () => undefined,
});

// ---- shells:chat 补充：人设读写 / 角色卡 FormData 更新·删除 / 导入·建角色（bindCharToChat/updatePersona/getCharData 分身S 已注册，复用）----
// 读当前对话人设（smart 人设下拉初值）：GET /:chatId/persona，scope.chatId 进 URL。
registerAction("shells:chat", "getPersona", {
	method: "GET",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/persona`,
	buildBody: () => undefined,
});
// 切换当前对话人设（smart 人设下拉 change）：PUT /:chatId/persona，body {personaname}。
registerAction("shells:chat", "setPersona", {
	method: "PUT",
	buildUrl: (m) => `/api/parts/shells:chat/${encodeURIComponent(m?.scope?.chatId ?? "")}/persona`,
	buildBody: (m) => m.payload ?? {},
});
// 删除人设（panels 人设编辑删除按钮）：DELETE /persona/:name，payload._name 进 URL。
registerAction("shells:chat", "deletePersona", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/shells:chat/persona/${encodeURIComponent(m?.payload?._name ?? "")}`,
	buildBody: () => undefined,
});
// 新建人设（panels 新建人设 / smart 无）：POST /persona/create，payload._form=FormData 直传（apiFetch 识别不 JSON 化）。
registerAction("shells:chat", "createPersona", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/persona/create",
	buildBody: (m) => m?.payload?._form,
});
// 角色卡完整更新（panels 角色卡编辑，含头像文件）：PUT /update-char/:charId，payload._form=FormData 直传。
//   区别于分身S 的 updateChar（JSON body，仅描述字段）——此为 multipart FormData 变体（avatar/多字段）。
registerAction("shells:chat", "updateCharForm", {
	method: "PUT",
	buildUrl: (m) => `/api/parts/shells:chat/update-char/${encodeURIComponent(m?.payload?.charId ?? "")}`,
	buildBody: (m) => m?.payload?.formData,
});
// 删除角色卡（panels 角色卡编辑删除）：DELETE /delete-char/:charId，body {deleteChats}（剥离 _key meta）。
registerAction("shells:chat", "deleteChar", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/shells:chat/delete-char/${encodeURIComponent(m?.payload?._key ?? "")}`,
	buildBody: (m) => { const { _key, ...rest } = m?.payload ?? {}; return rest; },
});
// 导入角色卡（charsel 导入按钮）：POST /import-char，payload._form=FormData 直传。
registerAction("shells:chat", "importChar", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/import-char",
	buildBody: (m) => m?.payload?._form,
});
// 新建角色卡（charsel 新建按钮）：POST /create-char，body {name}。
registerAction("shells:chat", "createChar", {
	method: "POST",
	buildUrl: () => "/api/parts/shells:chat/create-char",
	buildBody: (m) => m.payload ?? {},
});

// ---- 教程/视觉小说插件(beilu-tutorial, 凛倾 2026-07-14) ----
registerAction("plugins:beilu-tutorial", "listTutorials", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-tutorial/tutorials",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-tutorial", "getTutorial", {
	method: "GET",
	buildUrl: (m) => `/api/parts/plugins:beilu-tutorial/tutorials/${encodeURIComponent(m?.payload?.id ?? "")}`,
	buildBody: () => undefined,
});
registerAction("plugins:beilu-tutorial", "saveTutorial", {
	method: "PUT",
	buildUrl: (m) => `/api/parts/plugins:beilu-tutorial/tutorials/${encodeURIComponent(m?.payload?.id ?? "")}`,
	buildBody: (m) => m.payload ?? {},
});
registerAction("plugins:beilu-tutorial", "deleteTutorial", {
	method: "DELETE",
	buildUrl: (m) => `/api/parts/plugins:beilu-tutorial/tutorials/${encodeURIComponent(m?.payload?.id ?? "")}`,
	buildBody: () => undefined,
});
// listImagepacks: 图包列表唯一权威=/api/eye/imagepacks(含自动物化), 教程域不自设副本
registerAction("server:eye", "listImagepacks", {
	method: "GET",
	buildUrl: () => "/api/eye/imagepacks",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-tutorial", "getTutorialDefaults", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-tutorial/defaults",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-tutorial", "listSounds", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-tutorial/sounds",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-tutorial", "downloadSounds", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-tutorial/sounds-download",
	buildBody: () => ({}),
	timeout: 60000, // 33个文件×节流, 远超缺省超时
});

// ---- 直播接入插件 beilu-live（章5，2026-07-26）----
//   为什么用【五条精确注册】而非 _registerPluginSetdata 通配：
//     该通配只会拼 `/config/setdata` 并注入 `_action`，而本插件的运行控制走【自定义路径】
//     （live/start|stop|status，后端 functions/live/main.mjs Load 注册），不经 SetData 的
//     _action 分发。套通配 = 请求打到 config/setdata 且把 _action 字段落进配置文件（同
//     beilu-mvu :162 的「_action 污染配置」判据）。
//   读写分工（后端 functions/live/main.mjs interfaces.config）：
//     getData  → {enabled, config, capabilities, rules, platforms} 五字段一次拉全
//                （前端零默认值副本：min/max/选项/平台/凭据控件全从此包取，HTML 不写死）
//     setData  → 【差异层】写入，后端 _deepMerge 落 per-user config.json
//                ⚠ 调用方禁把 getData 的响应整包回传：capabilities 是【出厂默认】，
//                  整包回传会把它写进 per-user 差异层 → 日后改出厂默认被用户文件里的旧值
//                  覆盖（反向回灌，见 live/capabilities.mjs platformProtocol 组同款警告）。
registerAction("plugins:beilu-live", "getData", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-live/config/getdata",
	buildBody: () => undefined,
});
registerAction("plugins:beilu-live", "setData", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-live/config/setdata",
	buildBody: (m) => m.payload ?? {}, // 字段直写（后端 SetData 收 {enabled?, config?} 差异层），无 _action
});
// 运行控制三条：start/stop 写路，status 读路。
//   start 的 body 可带 {platform, roomId, chatid} 覆盖配置；缺省时后端回落 per-user config
//   （后端 :211 `req.body?.platform ?? cfg.platform`）。前端只在 chatid 上用这条覆盖——
//   chatid 是【当前打开的对话】属运行时上下文，不是持久配置（同 gameCompanion 启动传 chatid 范式）。
registerAction("plugins:beilu-live", "startLive", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-live/live/start",
	buildBody: (m) => m.payload ?? {},
});
registerAction("plugins:beilu-live", "stopLive", {
	method: "POST",
	buildUrl: () => "/api/parts/plugins:beilu-live/live/stop",
	buildBody: () => ({}),
});
// 面板轮询读路：notify:"report" —— 后台轮询失败不弹 toast 递归打扰，但仍进报错中心
//   （同 :1279 凛倾拍板「读路失败降 toast 不降显示」；未运行时后端返 {running:false} 属正常态）。
registerAction("plugins:beilu-live", "getStatus", {
	method: "GET",
	buildUrl: () => "/api/parts/plugins:beilu-live/live/status",
	buildBody: () => undefined,
	notify: "report",
});

/**
 * 失败统一报错（三路：console.error + window._reportError + toast）。
 * @param {string} msg - 报错串（含 target#verb 定位）
 * @param {object} message - 原 message（供 _reportError 取 target/verb 上下文）
 * @param {string} [notify="toast"] - 报错分级（凛倾拍板「读路失败降 toast 不降显示」）：
 *   "toast"（缺省，现行为）=三路全走，失败弹 UI toast；
 *   "report"=只走 console.error + window._reportError（进后端报错中心/报错系统），**跳过 toast**——
 *   给「诊断面/后台轮询读路」用：失败不弹 toast 递归打扰，但绝不完全静默（报错中心仍能看到）。
 */
function _report(msg, message, notify = "toast") {
	try { console.error(msg, message); } catch { /* 静默保护 console 不可用场景 */ }
	try { window._reportError?.(msg, null, { target: message?.target, verb: message?.verb }); } catch { /* 同上 */ }
	// notify:"report" 跳过 toast 动态 import（读路失败降 toast 不降显示——console+report 两路已保证可见）。
	if (notify === "report") return;
	try {
		// toast 动态引入（避免本壳静态耦合 UI 层；toast 不在=console 已兜底）
		// 预设链修（凛倾07-05截图裸"error"toast确诊）：pages/scripts/toast.mjs 签名是 type-first
		// showToast(type,message)——原 (msg,"error") 参数错位=真实诊断串落 type 槽丢失、toast 恒显字面"error"
		import("../../../../../../scripts/toast.mjs").then((m) => m.showToast?.("error", msg)).catch(() => {});
	} catch { /* 同上 */ }
}

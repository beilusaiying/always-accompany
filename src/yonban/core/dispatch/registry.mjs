/**
 * registry.mjs — yonban 计算图·节点表（T1 影子接入，不接生产流量）
 *
 * 【功能链】
 *   功能库注册 register(target, entry) → Map 存 entry{transport, handlers, contributes}
 *   → dispatcher 查表 registry.get(target) 定"派给谁 + 走哪档传输"
 *   → 操作流 AI 标签经 lookupByTag(tag) 反查"认领此标签的节点"（替代 replyHandler 硬编码标签分派的目标形态）。
 *
 * 【why】
 *   凛倾 07-02 极简校准：「Map 注册表 + dispatch 派发 + switch 传输适配…transport 归 registry（不在 message）」。
 *   传输是节点的属性（节点物理在哪），不是每条消息要带的——调用方永远 dispatch(message) 不感知物理档。
 *   registry 是纯内存派生视图（0_总架构 §七裁决6）：不持久化，启动/首用时由注册方（各库 index.mjs）
 *   import 时自行 register；物理发现仍归 parts_loader walkBeiluPartFiles，本表不取代它（设计② §4.3）。
 *
 * 【关联链】
 *   ← core/functions/<组>/index.mjs（各功能节点注册自己）
 *   ← core/dispatch/exits.mjs（4 个出口节点注册）
 *   → core/dispatch/dispatcher.mjs（唯一查表消费方）
 *
 * 【影响范围】
 *   纯内存 Map，无磁盘写、无网络、无全局副作用。重复注册同 target = 覆盖（后注册为准，与 Map.set 语义一致）。
 */

/** 节点表：target → { transport, handlers, contributes?, spawn?, connect? } */
export const registry = new Map();

/** 操作流标签反查索引：tag → Set<target>（由 contributes.tags 声明构建） */
const tagIndex = new Map();

/**
 * 注册一个节点。
 * @param {string} target - 节点名，如 "functions:macro" / "bus:broadcast" / "plugins:beilu-memory"
 * @param {object} entry
 * @param {"local"|"subprocess"|"remote"} entry.transport - 边的物理类型（节点属性，契约③§六）
 * @param {Record<string, Function>} entry.handlers - verb → 处理函数 (payload, context) => result
 * @param {object} [entry.contributes] - 声明式贡献：{ tags?:[...], streams?:[...], securityClass? }
 * @param {object} [entry.spawn] - subprocess 档额外：{cmd, args, env}
 * @param {object} [entry.connect] - remote 档额外：{url, tokenSource}
 */
export function register(target, entry) {
	if (!target || typeof target !== "string") throw new Error("register: target 必须是非空字符串");
	if (!entry?.transport) throw new Error(`register(${target}): entry.transport 必填 (local|subprocess|remote)`);
	// 覆盖注册时先摘旧 tag 索引，防重复注册后索引残留旧引用
	const prev = registry.get(target);
	if (prev?.contributes?.tags) for (const t of prev.contributes.tags) tagIndex.get(t)?.delete(target);
	registry.set(target, entry);
	if (entry.contributes?.tags)
		for (const t of entry.contributes.tags) {
			if (!tagIndex.has(t)) tagIndex.set(t, new Set());
			tagIndex.get(t).add(target);
		}
}

/**
 * AI 标签 → 认领节点列表（操作流 verb=标签名 时 dispatcher/调用方用它定 target）。
 * @param {string} tag
 * @returns {string[]} target 列表（无认领 = 空数组）
 */
export function lookupByTag(tag) {
	return [...(tagIndex.get(tag) ?? [])];
}

/**
 * 只读快照：把内存 registry Map 派生成【可序列化】的节点元数据视图。
 *
 * 【功能链】
 *   consumer = functions:registry#inspect handler（core/functions/registry/index.mjs）→ 经桥/HTTP
 *   给前端「功能层运行状态总面板」渲染节点卡片（transport 徽章 / verb 数 / 标签摘要）。
 *   数据进：遍历本模块的 registry Map（各库 index.mjs import 时 register 进来的全部节点）。
 *   数据出：`[{target, transport, verbs, verbCount, contributes}]` 数组——**不含 handler 函数本体**
 *          （函数不可 JSON 序列化，且面板只需元数据形状），contributes 是纯声明式对象可原样带出。
 *
 * 【why】
 *   registry 定位 = 纯内存派生视图（0_总架构 §七裁决6），本函数是它的【只读读取器】，
 *   零副作用、不改 Map、不触发注册——符合"派生视图可被只读观测"定位。面板作为 dispatch 的
 *   一个消费方经 functions:registry#inspect 拿这份数据（吃自己狗粮，设计 §四路径 A）。
 *
 * 【影响范围】
 *   纯读 registry Map，无写、无 IO、无广播。verbs 用 Object.keys(handlers) 派生（remote/subprocess
 *   档 entry 可能无 handlers → 回退空数组，verbCount=0，不抛错）。
 *
 * @returns {Array<{target:string, transport:string, verbs:string[], verbCount:number, contributes:object|null}>}
 */
export function inspectRegistry() {
	const out = [];
	for (const [target, entry] of registry) {
		const verbs = entry?.handlers ? Object.keys(entry.handlers) : [];
		out.push({
			target,
			transport: entry?.transport ?? null,
			verbs,
			verbCount: verbs.length,
			// contributes 是声明式纯对象（tags/flows/streams/securityClass/remoteCounterpart 等），可序列化直接带出
			contributes: entry?.contributes ?? null,
		});
	}
	return out;
}

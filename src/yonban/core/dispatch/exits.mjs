/**
 * exits.mjs — 4 个出口节点（resultSink 的替代：收口点从派发器移到节点，0_总架构 §五）
 *
 * 【功能链】
 *   功能节点产生副作用 = 显式 dispatch 一条 message 到出口节点：
 *   bus:broadcast.emit   → broadcastChatEvent(chatid,{type,payload})  WS 176 事件（chatId 从 context 取）
 *   bus:feed.feed        → ideClient.enqueuePendingResult(entry)      续喂当前生成线（单源入队，CAP200 会话感知截断）
 *   bus:activate.activate→ dispatchActivation(intent)                 产生新激活线（auto_reply/wake/message）
 *   store:persist.persist→ nicerWriteFileSync(filePath,data)          原子写落盘（tmp+rename 契约）
 *
 * 【why】
 *   现状病 =「操作流三去向 + ≥18 文件散落落盘，库各自 import broadcast 各自解析 chatId」（设计②§〇）。
 *   凛倾校准砍掉中央 resultSink 后，每类去向包装成一个出口节点（各一处实现）——收口度等价，
 *   派发器零业务，复杂度外置到图结构（ADR-1「一切外置」）。
 *   全部是对现状机制的【薄包装】，被包装者一行不改（T1 任务 md §五）；行为等价硬闸——
 *   T3 各批把散点副作用逐处对到这 4 个节点（全入口扫防半修）。
 *
 * 【两类再激活原语别混（串号根源，设计②§六）】
 *   bus:feed     = 续喂【当前生成线】：工具结果经 enqueuePendingResult 单源入队 → 下轮
 *                  generation.consumePendingResults(chatid) 取出注入——不是新调度。
 *                  ⚠ M-05 防线：enqueuePendingResult 是唯一入队口（禁 .pendingResults.push 绕过），
 *                  bus:feed 是它唯一新增调用方，不开第二入口（T1 隐藏任务②）。
 *   bus:activate = 产生【新激活线】：跨窗口传话/定时唤醒，经 dispatchActivation 装成
 *                  auto_reply/wake/message 触发新一轮生成——不是续喂。
 *   混用后果：续喂当新调度 → 重复触发生成/串号；新调度当续喂 → 丢跨窗口目标。
 *
 * 【为什么动态 import 被包装者】
 *   broadcast.mjs 在 beilu-chat 壳内、ideClient/dispatchActivation 在 beilu-memory 内——静态 import 会把
 *   影子层耦合进 parts 的加载时序（且 dispatchActivation.mjs 自身就用跨 part 动态 import 防循环依赖，
 *   同范式）。首调懒加载 + 模块级缓存。nicerWriteFile 是零依赖共享原语（node:fs/path），静态 import。
 *
 * 【影响范围】
 *   import 本文件仅注册 4 节点（纯内存）；副作用只在节点被 dispatch 且 handler 执行时产生，
 *   与直调被包装函数完全一致（薄包装不加逻辑、不吞错、不加回退）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nicerWriteFileSync } from "../../../scripts/nicerWriteFile.mjs";
import { register } from "./registry.mjs";

const _partsRoot = path.join(import.meta.dirname, "../../../public/parts");
const _lazy = {};
async function _mod(rel) {
	return _lazy[rel] ??= await import(pathToFileURL(path.join(_partsRoot, rel)).href);
}

// ── bus:broadcast ── WS 事件广播（broadcast.mjs:250/222）。chatId 从 context 取（库不再自解析）。
//   event 透传：WS 55+ 存量事件形状是历史契约（如 subModeSwitched 顶层带 subModeSwitch 字段，
//   subModePanel 消费 data.subModeSwitch.to）——出口不重组形状，payload.event 原样进 WS。
//   [0716 T3对接首批] yonban 侧全部广播 producer（setDataActions×5 / memory main×2 / replyHandler×10 /
//   preset main×8 / ideClient._broadcastApprovalCount）已接本出口，动态 import broadcast.mjs 散拼镜像删除；
//   worker isolate 语义不变（broadcast.mjs 内建 publishFromWorker 桥，出口只是薄包装）。
register("bus:broadcast", {
	transport: "local",
	handlers: {
		async emit(payload, context) {
			const chatid = context?.chatId ?? payload?.chatid;
			if (!chatid) return { ok: false, error: { code: "E_ARGS", msg: "bus:broadcast 需要 context.chatId 或 payload.chatid" } };
			if (!payload?.event?.type) return { ok: false, error: { code: "E_ARGS", msg: "bus:broadcast.emit 需要 payload.event{type,…}" } };
			const { broadcastChatEvent } = await _mod("shells/beilu-chat/src/lib/broadcast.mjs");
			broadcastChatEvent(chatid, payload.event);
			return { ok: true };
		},
		// 全广播（无 chatId 的旧/全局路径，对应 memory/main.mjs REST 线 broadcastAllChatUi 回退语义）
		async emitAll(payload, context) {
			if (!payload?.event?.type) return { ok: false, error: { code: "E_ARGS", msg: "bus:broadcast.emitAll 需要 payload.event{type,…}" } };
			const { broadcastAllChatUi } = await _mod("shells/beilu-chat/src/lib/broadcast.mjs");
			const accepted = broadcastAllChatUi(payload.event, context?.user ?? payload?.username);
			if (accepted === false) return { ok: false, error: { code: "E_OWNER", msg: "用户级广播缺少可用 owner 索引" } };
			return { ok: true };
		},
		// 无 chatId 但有认证 owner 的用户级事件。与 emitAll 分开成 fail-closed 入口：
		// 调用方遗漏 username 时不得退化成全用户广播。
		async emitOwner(payload, context) {
			if (!payload?.event?.type) return { ok: false, error: { code: "E_ARGS", msg: "bus:broadcast.emitOwner 需要 payload.event{type,…}" } };
			const username = context?.user ?? payload?.username;
			if (typeof username !== "string" || !username) {
				return { ok: false, error: { code: "E_OWNER", msg: "bus:broadcast.emitOwner 需要 username" } };
			}
			const { broadcastAllChatUi } = await _mod("shells/beilu-chat/src/lib/broadcast.mjs");
			const accepted = broadcastAllChatUi(payload.event, username);
			if (accepted === false) return { ok: false, error: { code: "E_OWNER", msg: "bus:broadcast.emitOwner 无法解析用户 socket 范围" } };
			return { ok: true };
		},
		// 跨窗口广播（broadcast.mjs:340 broadcastCrossChatEvent：按 username fan-out、源 chatid 被跳过）。
		// sourceChatId 允许空=按 username 全投（_broadcastDataSystemUpdate null 语义），故不像 emit 强制 chatid。
		// [0716 T3 对接首批] 与 emit/emitAll 同批服务 setDataActions _broadcastTaskUpdate/_broadcastDataSystemUpdate
		//   的 cross 需求——原 bus:broadcast 只有 emit/emitAll，cross 缺出口=两副本无法接线的硬缺口。
		async emitCross(payload, context) {
			if (!payload?.event?.type) return { ok: false, error: { code: "E_ARGS", msg: "bus:broadcast.emitCross 需要 payload.event{type,…}" } };
			const { broadcastCrossChatEvent } = await _mod("shells/beilu-chat/src/lib/broadcast.mjs");
			const sourceChatId = context?.chatId ?? payload?.chatid ?? null;
			const username = context?.user ?? payload?.username ?? null;
			const accepted = broadcastCrossChatEvent(sourceChatId, payload.event, username);
			if (accepted === false) {
				return { ok: false, error: { code: "E_OWNER", msg: "bus:broadcast.emitCross 无法解析用户广播范围" } };
			}
			return { ok: true };
		},
	},
});

// ── bus:feed ── 续喂当前生成线（ideClient.mjs:569 单源入队；⚠ 非 dispatchActivation）。
register("bus:feed", {
	transport: "local",
	handlers: {
		async feed(payload, _context) {
			// payload = entry{tool, params, result, chatid, timestamp}（ideClient.enqueuePendingResult 契约）
			// T066：ideClient 已迁 transport（离开 public/parts，_mod parts 根解析不到），改直接 import 同库 ../transport/。
			const { ideClient } = await import("../transport/ideClient.mjs");
			ideClient.enqueuePendingResult(payload);
			return { ok: true };
		},
	},
});

// ── bus:activate ── 产生新激活线（dispatchActivation.mjs:72；⚠ 非续喂）。
register("bus:activate", {
	transport: "local",
	handlers: {
		async activate(payload, _context) {
			// payload = intent{source, action:{type,target?,content?}, chatid?, charname?}
			const { dispatchActivation } = await _mod("plugins/beilu-memory/lib/tools/dispatchActivation.mjs");
			const r = await dispatchActivation(payload);
			return { ok: true, data: r };
		},
	},
});

// ── store:persist ── 原子写落盘（nicerWriteFile.mjs:33，tmp+rename 重试契约；储存契约层不动）。
register("store:persist", {
	transport: "local",
	handlers: {
		async persist(payload, _context) {
			// payload = { filePath, data, encoding? }。T7 批接 resolvePath 后支持 {dataType,scope} 寻址。
			if (!payload?.filePath) return { ok: false, error: { code: "E_ARGS", msg: "store:persist 需要 payload.filePath" } };
			nicerWriteFileSync(payload.filePath, payload.data, payload.encoding);
			return { ok: true };
		},
	},
});

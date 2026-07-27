/**
 * functions/memory/index.mjs — 记忆组节点 facade（T5 补 T3e 欠账：memory 组入住时整树平移未注册 dispatch 节点，
 * T5 runner 点菜需要它——runner 只能点 registry 里注册过的功能，隐藏任务①安全边界）
 *
 * 【功能链】
 *   dispatch({target:"functions:memory", verb:"getPrompt|setData|getData", payload})
 *   → handler/ 三处理器（21 步请求流 / setdata 操作 / getdata 读）——与旧线路（P 型壳 main.mjs
 *   经 parts 加载走 interfaces）到达同一实现，零流量影子注册，行为等价。
 *
 * 【why】
 *   T5 模式层 runner 逐道菜 dispatch，memory 是各模式（modes/*.json 全部 6 份）都点的第一道菜（散点清单 §A）。
 *   replyHandler 属操作流不在 T5 请求流范围，暂不挂 verb（挂了也零消费，防误用先不开）。
 *
 * 【影响范围】
 *   import 本文件仅注册节点（纯内存）；副作用只在 verb 被 dispatch 时产生，与直调 handler 一致。
 */
import { register } from "../../dispatch/registry.mjs";
import { dispatch } from "../../dispatch/dispatcher.mjs";
import { handleGetPrompt } from "./handler/getPromptHandler.mjs";
import { handleSetData } from "./handler/setDataActions.mjs";
import { handleGetData } from "./handler/getDataHandler.mjs";

register("functions:memory", {
	transport: "local",
	contributes: {
		flows: ["request", "operation"],
		tags: ["tableEdit", "memoryArchive", "memorySearch", "scheduleTask"],
	},
	handlers: {
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，
		// 覆盖 payload 自报——联动 SEC-T1（setDataActions.mjs:567 args.username→data.username）。
		// 主链（runner/shadowBuild）scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。
		async getPrompt(payload, context) {
			if (context?.user && payload?.arg) payload.arg.username = context.user;
			return { ok: true, data: await handleGetPrompt(payload?.arg) };
		},
		async setData(payload, context) {
			// args 缺失也必须盖章（否则 SEC-T1 的 args?.username 门不触发，data.username 自报生效=越权洞）
			const _args = context?.user ? { ...payload?.args, username: context.user } : payload?.args;
			const result = await handleSetData(payload?.data, _args);
			// 子模式切换广播副作用（setData 过桥前置：REST 线 memory/main.mjs:97-110 的同一副作用在
			// dispatch 线的对应实现——功能节点显式 dispatch 到出口节点，exits.mjs 架构形）。
			// 带 chatId → scope 到该对话（防多窗口串台，同 main.mjs 修法）；无 chatId → 全广播回退。
			// 同一次操作只走一条线（REST 或桥），副作用跟线走，不双发；主链（runner）请求流不产生
			// _subModeSwitch，此分支对主链恒空操作。
			if (result?._subModeSwitch) {
				const event = { type: "subModeSwitched", subModeSwitch: result._subModeSwitch };
				const _swChatId = result._subModeSwitch.chatId;
				try {
					if (_swChatId) await dispatch({ verb: "emit", target: "bus:broadcast", source: "functions:memory", payload: { event }, scope: { chatId: _swChatId } });
					else await dispatch({ verb: "emitAll", target: "bus:broadcast", source: "functions:memory", payload: { event, username: context?.user ?? _args?.username }, scope: {} });
				} catch { /* 广播不可用不阻塞写入结果——与 main.mjs:109 同语义（现状平移，非新增吞错） */ }
			}
			// [0717 桥线补漏] REST 线（memory/main.mjs:115/:119+）有 _subModesChanged/_webSearchConfigChanged
			//   中继而桥线没有——前端全走 sendAction 桥，0710 的 subModesConfigChanged 同步修复在真实路径上
			//   从未生效（半修：修复只落 REST 线）。两信号补齐，与 _subModeSwitch 同 try 语义。
			if (result?._subModesChanged) {
				try {
					await dispatch({ verb: "emitAll", target: "bus:broadcast", source: "functions:memory", payload: { event: { type: "subModesConfigChanged" }, username: context?.user ?? _args?.username }, scope: {} });
				} catch { /* 同上静默语义 */ }
			}
			if (result?._webSearchConfigChanged) {
				try {
					await dispatch({ verb: "emitAll", target: "bus:broadcast", source: "functions:memory", payload: { event: { type: "webSearchConfigChanged", charName: result._webSearchConfigChanged.charName }, username: context?.user ?? _args?.username }, scope: {} });
				} catch { /* 同上静默语义 */ }
			}
			return { ok: true, data: result };
		},
		async getData(payload, context) {
			const _args = context?.user ? { ...payload?.args, username: context.user } : payload?.args;
			return { ok: true, data: await handleGetData(_args) };
		},
	},
});

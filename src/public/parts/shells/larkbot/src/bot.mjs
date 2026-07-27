import * as lark from "npm:@larksuiteoapi/node-sdk@^1.60.0";

import { console } from "../../../../../scripts/i18n.mjs";
import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { broadcastBotError } from "../../botErrorBroadcast.mjs";

const diag = createDiag("lark");

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余飞书传输实现：connect=Client+WSClient 构造+OnceClientReady+wsClient.start（句柄=
// {client, wsClient}）；disconnect=wsClient.stop()。
const _lc = createBotLifecycle("larkbot", {
	interfaceKey: "lark",
	createInterface: async (char, username, charname) => {
		const { createSimpleLarkInterface } = await import("./default_interface/main.mjs");
		return createSimpleLarkInterface(char, username, charname);
	},
	connect: async (config, char, { botname }) => {
		diag.log(`startBot: 启动 bot="${config.char}", appId="${config.appId}"`);
		const client = new lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			loggerLevel: lark.LoggerLevel.warn,
		});
		const wsClient = new lark.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			loggerLevel: lark.LoggerLevel.warn,
		});
		// 调用角色接口的 OnceClientReady（如果有）
		if (char.interfaces.lark?.OnceClientReady)
			await char.interfaces.lark.OnceClientReady(client, wsClient, config.config);
		diag.log(`startBot: 开始连接 WebSocket, char="${config.char}"`);
		console.log(`[LarkBot] 飞书 bot 已启动, char="${config.char}"`);
		// wsClient.start() 是异步的，它会在内部持续运行，通过 eventDispatcher 分发消息事件
		const eventDispatcher = char.interfaces.lark?._eventDispatcher;
		if (!eventDispatcher)
			throw new Error("lark interface must provide _eventDispatcher");
		// BR2 runtime：lark WSClient 的 onError(SDK 文档支持)在重连耗尽/运行时连接错误时触发 → 外显红点(phase=runtime，补齐 M8 半修：原仅 start 阶段有 producer)
		wsClient.start({
			eventDispatcher,
			onError: (error) => { try { broadcastBotError({ platform: "larkbot", botname, phase: "runtime", error }); } catch { /* 外显失败不阻断 bot 主流程 */ } },
		});
		return { client, wsClient };
	},
	disconnect: async (clientSet) => {
		// WSClient 没有官方 close() 但可以通过停止事件分发来中止
		if (clientSet?.wsClient?.stop)
			await clientSet.wsClient.stop();
	},
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotLarkInterface = _lc.getBotInterface;

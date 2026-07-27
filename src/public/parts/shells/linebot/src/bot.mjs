import { messagingApi, middleware } from "npm:@line/bot-sdk@^10.6.0";

import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { loadTempData } from "../../../../../server/setting_loader.mjs";

const diag = createDiag("linebot");

/** @typedef {import('../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */

export function createLineClient(config) {
	const client = new messagingApi.MessagingApiClient({
		channelAccessToken: config.channelAccessToken,
	});
	const middlewareFn = middleware({ channelSecret: config.channelSecret });
	return { client, middlewareFn };
}

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余 LINE 传输实现：connect=createLineClient+OnBotReady（webhook 被动模型无长连接，句柄=
// {client, middlewareFn}，webhook 路由经 getBotClientAndMiddleware 消费）；disconnect=OnBotStop。
// 原「接口装配在 startBot 内」位置漂移已归一到骨架 ensure（同语义）。
const _lc = createBotLifecycle("linebot", {
	interfaceKey: "line",
	createInterface: async (char, username, charname) => {
		const { createSimpleLineInterface } = await import("./default_interface/main.mjs");
		return createSimpleLineInterface(char, username, charname);
	},
	connect: async (config, char, { botname }) => {
		diag.log(`startBot: 启动 bot="${botname}", char="${config.char}", token长度=${config.channelAccessToken?.length || 0}`);
		if (!config.channelAccessToken || !config.channelSecret)
			throw new Error(`Bot ${botname} 缺少 channelAccessToken 或 channelSecret 配置`);
		const { client, middlewareFn } = createLineClient(config);
		// 初始化接口（传入 client 和 config）
		await char.interfaces.line?.OnBotReady?.(client, config);
		diag.log(`startBot: bot="${botname}" LINE client 创建成功`);
		return { client, middlewareFn, lineInterface: char.interfaces.line };
	},
	disconnect: async (cached) => {
		// LINE Bot 无长连接，停止时只需清理接口状态
		await cached?.lineInterface?.OnBotStop?.();
	},
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotLineInterface = _lc.getBotInterface;

/**
 * 供 webhook 路由取运行中 bot 的 client 与签名中间件（平台私有导出，端点层消费）。
 * cache 句柄形状=connect 返回值 {client, middlewareFn, lineInterface}。
 */
export async function getBotClientAndMiddleware(username, botname) {
	const botCache = loadTempData(username, "linebot_cache");
	if (!botCache[botname]) return null;
	const cached = await botCache[botname];
	if (!cached?.client) return null;
	return { client: cached.client, middlewareFn: cached.middlewareFn };
}

import { console } from "../../../../../scripts/i18n.mjs";
import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";

const diag = createDiag("wecombot");

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余企微传输实现：connect=OnBotReady(config)（webhook 被动模型无长连接，句柄=接口自身）；
// disconnect=iface.cleanup?.()。
const _lc = createBotLifecycle("wecombot", {
	interfaceKey: "wecom",
	createInterface: async (char, username, charname) => {
		const { createSimpleWecomInterface } = await import("./default_interface/main.mjs");
		return createSimpleWecomInterface(char, username, charname);
	},
	connect: async (config, char) => {
		if (char.interfaces.wecom?.OnBotReady)
			await char.interfaces.wecom.OnBotReady(config);
		console.log(`[WecomBot] 企业微信 bot 已就绪: "${config.char}", 等待回调消息`);
		return char.interfaces.wecom;
	},
	disconnect: async (iface) => {
		if (iface?.cleanup) await iface.cleanup();
	},
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotWecomInterface = _lc.getBotInterface;
// 原 findBotByCorpAndAgent 已删（0716 件9 收口时全库 grep 零消费=死导出；webhook 回调路由实际
// 走 endpoints.mjs 内联遍历 getRunningBotList+getBotConfig 匹配 corpId/agentId，不经此函数）。

import { Bot } from "npm:grammy@^1.35.0";

import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { broadcastBotError } from "../../botErrorBroadcast.mjs";

const diag = createDiag("telegram");

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删
//（config CRUD/接口 ensure+cache/runBot 编排/StartJob/错误外显/on_shutdown/用户删除·改名钩全在骨架）。
// 壳侧只余 telegram 传输实现：connect=grammy Bot 构造+OnBotReady+catch 挂钩+长轮询启动；disconnect=bot.stop()。
const _lc = createBotLifecycle("telegrambot", {
	interfaceKey: "telegram",
	createInterface: async (char, username, charname) => {
		const { createSimpleTelegramInterface } = await import("./default_interface/main.mjs");
		return createSimpleTelegramInterface(char, username, charname);
	},
	connect: async (config, char, { username, botname }) => {
		const bot = new Bot(config.token);
		await char.interfaces.telegram.OnBotReady(bot, config.config);
		bot.catch((err) => {
			diag.error(`bot="${botname}" 运行时错误`, err);
			// BR2: 运行时错误外显到前端 [O] 监控红点（phase=runtime）
			broadcastBotError({ username, platform: "telegrambot", botname, phase: "runtime", error: err });
		});
		bot.start({
			onStart: () => {
				diag.log(`runBot: bot="${botname}" 长轮询已启动`);
			},
		});
		return bot;
	},
	disconnect: async (bot) => {
		await bot.stop();
	},
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotTelegramInterface = _lc.getBotInterface;

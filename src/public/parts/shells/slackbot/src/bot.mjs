import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { broadcastBotError } from "../../botErrorBroadcast.mjs";

const diag = createDiag("slack");

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余 slack 传输实现：connect=Bolt App(Socket Mode)+app.error 挂钩+OnBotReady+app.start；
// disconnect=app.stop()。
const _lc = createBotLifecycle("slackbot", {
	interfaceKey: "slack",
	createInterface: async (char, username, charname) => {
		const { createSimpleSlackInterface } = await import("./default_interface/main.mjs");
		return createSimpleSlackInterface(char, username, charname);
	},
	connect: async (config, char, { botname }) => {
		const { App } = await import("npm:@slack/bolt@^4.6.0");
		const app = new App({
			token: config.token,
			appToken: config.appToken,
			socketMode: true,
		});
		// BR2: 运行时错误外显到前端 [O] 监控红点（phase=runtime），对齐 telegram bot.catch
		app.error(async (error) => {
			diag.error(`bot="${botname}" 运行时错误`, error);
			broadcastBotError({ platform: "slackbot", botname, phase: "runtime", error });
		});
		await char.interfaces.slack.OnBotReady(app, config.config);
		await app.start();
		diag.log(`runBot: bot="${botname}" Socket Mode 已启动`);
		return app;
	},
	disconnect: async (app) => {
		await app.stop();
	},
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotSlackInterface = _lc.getBotInterface;

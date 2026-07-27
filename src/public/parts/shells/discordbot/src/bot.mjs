import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "npm:discord.js@^14.25.0";

import { console } from "../../../../../scripts/i18n.mjs";
import { createBotLifecycle } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { broadcastBotError } from "../../botErrorBroadcast.mjs";

const diag = createDiag("discord");

/** @typedef {import('../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */

/**
 * 启动 Discord Bot（connect 钩子实现体：Client 构造/Intents/ClientReady→OnceClientReady/login）。
 * @param {{ token: string, config: any, char: string }} config - 机器人配置
 * @param {CharAPI_t} char - 角色 API
 * @returns {Promise<import('npm:discord.js').Client>} - Discord 客户端实例
 */
async function startBot(config, char) {
  diag.time("startBot");
  diag.log(
    `startBot: 启动 bot="${config.char}", token长度=${config.token?.length || 0}`,
  );
  const client = new Client({
    intents: char.interfaces.discord?.Intents || [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessageTyping,
    ],
    partials: char.interfaces.discord?.Partials || [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.GuildMember,
      Partials.Reaction,
    ],
  });

  client.once(Events.ClientReady, async (client) => {
    await char.interfaces.discord?.OnceClientReady(client, config.config);
    diag.log(
      `startBot: ClientReady, bot="${client.user.username}", char="${config.char}"`,
    );
    console.infoI18n("beiluConsole.discordbot.botStarted", {
      botusername: client.user.username,
      charname: config.char,
    });
  });

  await client.login(config.token);
  diag.timeEnd("startBot");

  return client;
}

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余 discord 传输实现：connect=startBot+Events.Error 挂钩；disconnect=client.destroy()。
const _lc = createBotLifecycle("discordbot", {
  interfaceKey: "discord",
  createInterface: async (char, username, charname) => {
    const { createSimpleDiscordInterface } = await import("./default_interface/main.mjs");
    return createSimpleDiscordInterface(char, username, charname);
  },
  connect: async (config, char, { botname }) => {
    const client = await startBot(config, char);
    // BR2: 运行时错误外显到前端 [O] 监控红点（phase=runtime），对齐 telegram bot.catch
    client.on(Events.Error, (err) => {
      diag.error(`bot="${botname}" 运行时错误`, err);
      broadcastBotError({ platform: "discordbot", botname, phase: "runtime", error: err });
    });
    return client;
  },
  disconnect: async (client) => {
    await client.destroy();
  },
});

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc;
export const getBotDiscordInterface = _lc.getBotInterface;

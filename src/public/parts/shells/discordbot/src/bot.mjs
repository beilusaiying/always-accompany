import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "npm:discord.js@^14.25.0";
import { on_shutdown } from "npm:on-shutdown";

import { console } from "../../../../../scripts/i18n.mjs";
import { getAllUserNames } from "../../../../../server/auth.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { events } from "../../../../../server/events.mjs";
import { EndJob, StartJob } from "../../../../../server/jobs.mjs";
import { loadPart } from "../../../../../server/parts_loader.mjs";
import {
  loadShellData,
  loadTempData,
  saveShellData,
} from "../../../../../server/setting_loader.mjs";
// achievements shell 在 beilu 中不存在，使用动态导入避免启动报错
const unlockAchievement = (...args) => {
  import("../../achievements/src/api.mjs")
    .then((mod) => mod.unlockAchievement(...args))
    .catch(() => {
      /* achievements shell 不可用，静默跳过 */
    });
};
const diag = createDiag("discord");

/** @typedef {import('../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */

/** 缓存运行中 bot 的 Discord 接口引用（用于上下文清除等操作） */
const botDiscordInterfaceCache = new Map(); // key: "username/botname", value: discord interface object

/**
 * 启动 Discord Bot
 * @param {{
 * 	token: string,
 * 	config: any
 * }} config - 机器人配置
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
    console.infoI18n("fountConsole.discordbot.botStarted", {
      botusername: client.user.username,
      charname: config.char,
    });
  });

  await client.login(config.token);
  diag.timeEnd("startBot");

  return client;
}

/**
 * 获取机器人数据。
 * @param {string} username - 用户名。
 * @returns {object} - 机器人数据。
 */
function getBotsData(username) {
  return loadShellData(username, "discordbot", "bot_configs");
}

/**
 * 获取机器人配置。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {object} - 机器人配置。
 */
export function getBotConfig(username, botname) {
  const botsData = getBotsData(username);
  return botsData[botname] || {};
}

/**
 * 获取机器人配置模板。
 * @param {string} username - 用户名。
 * @param {string} charname - 角色名称。
 * @returns {Promise<object>} - 机器人配置模板。
 */
export async function getBotConfigTemplate(username, charname) {
  const char = await loadPart(username, "chars/" + charname);
  if (!char.interfaces.discord) {
    const { createSimpleDiscordInterface } =
      await import("./default_interface/main.mjs");
    char.interfaces.discord = await createSimpleDiscordInterface(
      char,
      username,
      charname,
    );
  }
  return (await char.interfaces.discord?.GetBotConfigTemplate?.()) || {};
}

/**
 * 设置机器人配置。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @param {object} config - 配置。
 * @returns {void}
 */
export function setBotConfig(username, botname, config) {
  const botsData = getBotsData(username);
  botsData[botname] = config;
  saveShellData(username, "discordbot", "bot_configs");
}

/**
 * 删除机器人配置。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {void}
 */
export function deleteBotConfig(username, botname) {
  const botsData = getBotsData(username);
  delete botsData[botname];
  saveShellData(username, "discordbot", "bot_configs");
}

/**
 * 运行机器人。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {Promise<void>}
 */
export async function runBot(username, botname) {
  diag.time(`runBot:${botname}`);
  diag.log(`runBot: user="${username}", bot="${botname}"`);
  const botCache = loadTempData(username, "discordbot_cache");
  if (botCache[botname]) {
    diag.debug(`runBot: bot="${botname}" 已在运行，跳过`);
    return;
  }
  botCache[botname] = (async (_) => {
    const config = getBotConfig(username, botname);
    if (!Object.keys(config).length)
      throw new Error(`Bot ${botname} not found`);
    const char = await loadPart(username, "chars/" + config.char);
    if (!char.interfaces.discord) {
      diag.debug(`runBot: bot="${botname}" 无自定义接口，使用默认接口`);
      const { createSimpleDiscordInterface } =
        await import("./default_interface/main.mjs");
      char.interfaces.discord = await createSimpleDiscordInterface(
        char,
        username,
        config.char,
      );
    }
    // 缓存 discord 接口引用（用于 ClearContext 等操作）
    const cacheKey = `${username}/${botname}`;
    if (char.interfaces.discord) {
      botDiscordInterfaceCache.set(cacheKey, char.interfaces.discord);
    }
    const client = await startBot(config, char);
    return client;
  })();

  try {
    botCache[botname] = await botCache[botname];
    StartJob(username, "shells/discordbot", botname);
    unlockAchievement(username, "shells/discordbot", "start_bot");
    diag.timeEnd(`runBot:${botname}`);
    diag.snapshot(`runBot:${botname}`, {
      username,
      botname,
      status: "running",
    });
  } catch (error) {
    delete botCache[botname];
    diag.error(`runBot: bot="${botname}" 启动失败`, error);
    throw error;
  }
}

/**
 * 停止机器人。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {Promise<void>}
 */
export async function stopBot(username, botname) {
  diag.log(`stopBot: user="${username}", bot="${botname}"`);
  const botCache = loadTempData(username, "discordbot_cache");

  if (botCache[botname])
    if (botCache[botname])
      try {
        const client = await botCache[botname];
        await client.destroy();
        diag.log(`stopBot: bot="${botname}" 已停止`);
      } finally {
        delete botCache[botname];
        botDiscordInterfaceCache.delete(`${username}/${botname}`);
      }

  EndJob(username, "shells/discordbot", botname);
}

/**
 * 暂停机器人（停止运行但不从 config 中移除，以便 PauseAllJobs 后可通过 ReStartJobs 恢复）。
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {Promise<void>}
 */
export async function pauseBot(username, botname) {
  diag.debug(`pauseBot: user="${username}", bot="${botname}"`);
  const botCache = loadTempData(username, "discordbot_cache");
  if (!botCache[botname]) return;

  try {
    const client = await botCache[botname];
    await client.destroy();
    diag.debug(`pauseBot: bot="${botname}" 已暂停`);
  } finally {
    delete botCache[botname];
  }
}
on_shutdown(async () => {
  for (const username of getAllUserNames())
    for (const botname of Object.keys(
      loadTempData(username, "discordbot_cache"),
    ))
      await pauseBot(username, botname).catch(console.error);
});

/**
 * 获取正在运行的机器人列表。
 * @param {string} username - 用户名。
 * @returns {Array<string>} - 正在运行的机器人列表。
 */
export function getRunningBotList(username) {
  return Object.keys(loadTempData(username, "discordbot_cache"));
}

/**
 * 获取机器人列表。
 * @param {string} username - 用户名。
 * @returns {Array<string>} - 机器人列表。
 */
export function getBotList(username) {
  return Object.keys(getBotsData(username));
}

/**
 * 获取运行中机器人的 Discord 接口对象（含 ClearContext 等方法）
 * @param {string} username - 用户名。
 * @param {string} botname - 机器人名称。
 * @returns {object|null} Discord 接口对象或 null
 */
export function getBotDiscordInterface(username, botname) {
  return botDiscordInterfaceCache.get(`${username}/${botname}`) || null;
}

// Event Handlers
events.on("BeforeUserDeleted", async ({ username }) => {
  const runningBots = getRunningBotList(username);
  diag.log(
    `BeforeUserDeleted: user="${username}", 运行中bot数=${runningBots.length}`,
  );
  for (const botname of runningBots)
    try {
      await stopBot(username, botname);
      diag.log(
        `BeforeUserDeleted: 已停止 bot="${botname}", user="${username}"`,
      );
    } catch (error) {
      diag.error(
        `BeforeUserDeleted: 停止 bot="${botname}" 失败, user="${username}"`,
        error,
      );
    }
});

events.on("BeforeUserRenamed", async ({ oldUsername, newUsername }) => {
  const runningBotsOldUser = getRunningBotList(oldUsername);
  diag.log(
    `BeforeUserRenamed: "${oldUsername}" → "${newUsername}", 运行中bot数=${runningBotsOldUser.length}`,
  );
  for (const botname of runningBotsOldUser)
    try {
      await stopBot(oldUsername, botname);
      diag.log(
        `BeforeUserRenamed: 已停止 bot="${botname}", oldUser="${oldUsername}"`,
      );
    } catch (error) {
      diag.error(
        `BeforeUserRenamed: 停止 bot="${botname}" 失败, oldUser="${oldUsername}"`,
        error,
      );
    }
});

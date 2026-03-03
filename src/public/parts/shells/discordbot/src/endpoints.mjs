import { authenticate, getUserByReq } from "../../../../../server/auth.mjs";

import {
  deleteBotConfig,
  getBotConfig,
  getBotConfigTemplate,
  getBotDiscordInterface,
  getBotList,
  getRunningBotList,
  runBot,
  setBotConfig,
  stopBot,
} from "./bot.mjs";

/**
 * 为Discord机器人功能设置API端点。
 * @param {object} router - Express的路由实例。
 */
export function setEndpoints(router) {
  router.post(
    "/api/parts/shells\\:discordbot/start",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.body;
      await runBot(username, botname);
      res.status(200).json({ message: "start ok", botname });
    },
  );

  router.post(
    "/api/parts/shells\\:discordbot/stop",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.body;
      await stopBot(username, botname);
      res.status(200).json({ message: "stop ok", botname });
    },
  );

  router.get(
    "/api/parts/shells\\:discordbot/getbotlist",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      res.status(200).json(getBotList(username));
    },
  );

  router.get(
    "/api/parts/shells\\:discordbot/getrunningbotlist",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      res.status(200).json(getRunningBotList(username));
    },
  );

  router.get(
    "/api/parts/shells\\:discordbot/getbotconfig",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.query;
      const config = await getBotConfig(username, botname);
      res.status(200).json(config);
    },
  );

  router.get(
    "/api/parts/shells\\:discordbot/getbotConfigTemplate",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { charname } = req.query;
      const config = await getBotConfigTemplate(username, charname);
      res.status(200).json(config);
    },
  );

  router.post(
    "/api/parts/shells\\:discordbot/setbotconfig",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname, config } = req.body;
      setBotConfig(username, botname, config);
      res.status(200).json({ message: "config saved" });
    },
  );

  router.post(
    "/api/parts/shells\\:discordbot/deletebotconfig",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.body;
      deleteBotConfig(username, botname);
      res.status(200).json({ message: "bot deleted" });
    },
  );

  router.post(
    "/api/parts/shells\\:discordbot/newbotconfig",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.body;
      setBotConfig(username, botname, {});
      res.status(200).json({ message: "bot created" });
    },
  );

  // 清除机器人上下文（保留记忆表格）
  router.post(
    "/api/parts/shells\\:discordbot/clearcontext",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.body;
      try {
        const discordInterface = await getBotDiscordInterface(
          username,
          botname,
        );
        if (!discordInterface?.ClearContext) {
          return res
            .status(400)
            .json({ error: "Bot not running or no ClearContext method" });
        }
        const result = discordInterface.ClearContext();
        res.status(200).json({ message: "context cleared", ...result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  // 获取机器人活跃频道列表
  router.get(
    "/api/parts/shells\\:discordbot/activechannels",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname } = req.query;
      try {
        const discordInterface = await getBotDiscordInterface(
          username,
          botname,
        );
        if (!discordInterface?.GetActiveChannels) {
          return res.status(200).json([]);
        }
        res.status(200).json(discordInterface.GetActiveChannels());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  // 获取消息日志（支持增量轮询）
  router.get(
    "/api/parts/shells\\:discordbot/messagelog",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname, since } = req.query;
      try {
        const discordInterface = await getBotDiscordInterface(
          username,
          botname,
        );
        if (!discordInterface?.GetMessageLog) {
          return res.status(200).json({ logs: [], maxSize: 20 });
        }
        const sinceTs = since ? parseInt(since) : undefined;
        res.status(200).json(discordInterface.GetMessageLog(sinceTs));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  // 设置消息日志最大条数
  router.post(
    "/api/parts/shells\\:discordbot/setlogsize",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const { botname, size } = req.body;
      try {
        const discordInterface = await getBotDiscordInterface(
          username,
          botname,
        );
        if (!discordInterface?.SetMessageLogSize) {
          return res
            .status(400)
            .json({ error: "Bot not running or no SetMessageLogSize method" });
        }
        res.status(200).json(discordInterface.SetMessageLogSize(size));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );
}

import { Buffer } from "node:buffer";
import { clearInterval, setInterval, setTimeout } from "node:timers";

import {
  ChannelType,
  Events,
  GatewayIntentBits,
  Partials,
  escapeMarkdown,
} from "npm:discord.js";

import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
import {
  getAllDefaultParts,
  getAnyPreferredDefaultPart,
  loadPart,
} from "../../../../../../server/parts_loader.mjs";

import { getMessageFullContent, splitDiscordReply } from "./tools.mjs";

const diag = createDiag("discord");

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "discord"、"telegram"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
  if (!content) return "";
  // 1. 尝试提取平台专属标签
  const tagRegex = new RegExp(
    `<${displayTag}>([\\s\\S]*?)<\\/${displayTag}>`,
    "gi",
  );
  const matches = [...content.matchAll(tagRegex)];
  if (matches.length > 0) {
    return matches.map((m) => m[1].trim()).join("\n");
  }
  // 2. 降级：清理所有内部标签后返回
  return content
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "")
    .replace(/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi, "")
    .replace(/<memorySearch>[\s\S]*?<\/memorySearch>/gi, "")
    .replace(/<memoryNote[^>]*>[\s\S]*?<\/memoryNote>/gi, "")
    .replace(/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi, "")
    .replace(/<file_op[^>]*>[\s\S]*?<\/file_op>/gi, "")
    .replace(/<content>([\s\S]*?)<\/content>/gi, "$1") // 保留内容，去掉标签
    .replace(/<discord>[\s\S]*?<\/discord>/gi, "")
    .replace(/<telegram>[\s\S]*?<\/telegram>/gi, "")
    .replace(/<web>[\s\S]*?<\/web>/gi, "")
    .trim();
}

/** @typedef {import('npm:discord.js').Message} Message */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatLogEntry_t} FountChatLogEntryBase */
/**
 *  @typedef { (FountChatLogEntryBase & {
 *	extension?: {discord_message_id?: string, [key: string]: any }
 * })} chatLogEntry_t_simple
 */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatReply_t} ChatReply_t */

/**
 * 尝试执行一个函数几次，如果失败则等待一段时间后重试。
 * @param {Function} func - 要执行的异步函数。
 * @param {object} [options] - 选项对象。
 * @param {number} [options.times=3] - 重试次数。
 * @param {number} [options.WhenFailsWaitFor=2000] - 失败后等待的毫秒数。
 * @returns {Promise<any>} 函数执行结果的 Promise。
 */
async function tryFewTimes(func, { times = 3, WhenFailsWaitFor = 2000 } = {}) {
  let lastError;
  for (let i = 0; i < times; i++)
    try {
      return await func();
    } catch (error) {
      lastError = error;
      if (i < times - 1)
        await new Promise((resolve) => setTimeout(resolve, WhenFailsWaitFor));
    }

  throw lastError;
}

/**
 * 创建一个简单的 Discord 接口。
 * @param {import('../../../../../../decl/charAPI.ts').CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含 Discord 接口方法的 Promise。
 */
export async function createSimpleDiscordInterface(
  charAPI,
  ownerUsername,
  botCharname,
) {
  if (!charAPI?.interfaces?.chat?.GetReply)
    throw new Error(
      "charAPI.interfaces.chat.GetReply is required for SimpleDiscordInterface.",
    );

  /**
   * @returns {{OwnerUserName: string, MaxMessageDepth: number, MaxFetchCount: number, ReplyToAllMessages: boolean}} 返回一个包含简单机器人配置模板的对象。
   */
  function GetSimpleBotConfigTemplate() {
    return {
      OwnerUserName: "your_discord_username", // Discord 用户名, 不是Fount用户名
      MaxMessageDepth: 20,
      MaxFetchCount: 30,
      ReplyToAllMessages: false, // 若开启则对所有消息做出回复（旧选项，兼容保留）
      // ---- 触发模式配置 ----
      TriggerOnMention: true, // @触发：被@时回复
      TriggerOnMessage: false, // 说话触发：白名单频道中所有消息都回复
      TriggerChannels: [], // 说话触发的频道白名单（频道ID数组），空=所有频道
      PrivateChatEnabled: true, // 私聊模式：私聊中用户说话即触发
    };
  }

  /**
   * Discord 机器人的主函数。
   * @param {import('npm:discord.js').Client} client - Discord 客户端实例。
   * @param {object} config - 机器人配置。
   * @returns {Promise<void>}
   */
  // 提升到闭包级别，使 ClearContext 方法可以访问
  const ChannelChatLogs = {}; // Record<string, chatLogEntry_t_simple[]>
  const chat_scoped_char_memory = {}; // AI的上下文记忆

  // ---- 加载所有默认 plugin（与 beilu-chat 一致的完整消息管线） ----
  const allPlugins = {};
  try {
    const pluginNames = getAllDefaultParts(ownerUsername, "plugins");
    for (const pluginName of pluginNames) {
      try {
        allPlugins[pluginName] = await loadPart(
          ownerUsername,
          "plugins/" + pluginName,
        );
      } catch (e) {
        diag.warn(`加载插件 ${pluginName} 失败:`, e.message);
      }
    }
    diag.log(
      `已加载 ${Object.keys(allPlugins).length} 个默认插件: ${Object.keys(allPlugins).join(", ")}`,
    );
  } catch (e) {
    diag.error("加载默认插件列表失败:", e.message);
  }

  // ---- 消息日志环形缓冲区 ----
  let messageLogMaxSize = 20; // 默认保留最近20条
  const messageLog = []; // { id, timestamp, type, channelId, channelName, author, content, thinking, fullContent, files }

  /**
   * 向消息日志追加一条记录（环形缓冲区）
   * @param {object} entry - 日志条目
   */
  function pushMessageLog(entry) {
    messageLog.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      ...entry,
    });
    while (messageLog.length > messageLogMaxSize) {
      messageLog.shift();
    }
  }

  async function SimpleDiscordBotMain(client, config) {
    const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || 20;
    const MAX_FETCH_COUNT =
      config.MaxFetchCount ||
      Math.max(MAX_MESSAGE_DEPTH, Math.floor(MAX_MESSAGE_DEPTH * 1.5));

    const userInfoCache = {}; // Record<string, string> 用户ID到显示名称

    const ChannelMessageQueues = {}; // Record<string, Message<boolean>[]>
    const ChannelHandlers = {}; // Record<string, Promise<void>>

    /** @type {Record<string, ChatReply_t>} 键为 bot 发出的 Discord 消息 ID，值为对应 AI 回复对象。 */
    const aiReplyObjectCache = {};

    /**
     * 将 Discord 消息转换为 fount 聊天日志条目。
     * @param {Message} discordMessage - Discord 消息对象。
     * @returns {Promise<chatLogEntry_t_simple>} 转换后的 fount 聊天日志条目。
     */
    async function DiscordMessageToFountChatLogEntry(discordMessage) {
      let fullMessage = discordMessage;
      if (fullMessage.partial)
        try {
          fullMessage = await tryFewTimes(() => discordMessage.fetch());
        } catch (error) {
          diag.error(
            `DiscordMessageToFountChatLogEntry: 获取部分消息 ${discordMessage.id} 失败`,
            error,
          );
          return null;
        }

      const { author } = fullMessage;
      if (!userInfoCache[author.id] || Math.random() < 0.1)
        try {
          const fetchedUser = await tryFewTimes(() => author.fetch());
          let displayName = fetchedUser.globalName || fetchedUser.username;
          if (fullMessage.guild && fullMessage.member) {
            const member = fullMessage.member.partial
              ? await tryFewTimes(() => fullMessage.member.fetch())
              : fullMessage.member;
            displayName = member.displayName || displayName;
          }
          userInfoCache[author.id] = displayName;
        } catch (e) {
          if (!userInfoCache[author.id])
            userInfoCache[author.id] =
              author.globalName || author.username || `User_${author.id}`;
        }

      const finalDisplayName =
        userInfoCache[author.id] || author.globalName || author.username;

      const content = await getMessageFullContent(fullMessage, client);
      const files = [];
      const attachmentSources = [
        fullMessage.attachments.values(),
        ...(fullMessage.messageSnapshots?.flatMap((s) =>
          s.attachments.values(),
        ) || []),
      ];
      for (const source of attachmentSources)
        for (const attachment of source)
          if (attachment.url)
            try {
              const buffer = Buffer.from(
                await tryFewTimes(() =>
                  fetch(attachment.url).then((r) => r.arrayBuffer()),
                ),
              );
              files.push({
                name: attachment.name,
                buffer,
                description: attachment.description,
                mime_type: attachment.contentType,
              });
            } catch (error) {
              diag.error(
                `DiscordMessageToFountChatLogEntry: 获取附件 ${attachment.name} 失败`,
                error,
              );
            }

      for (const embed of fullMessage.embeds)
        if (embed.image?.url)
          try {
            const { url } = embed.image;
            files.push({
              name:
                url.substring(url.lastIndexOf("/") + 1) || "embedded_image.png",
              buffer: Buffer.from(
                await tryFewTimes(() =>
                  fetch(url).then((r) => r.arrayBuffer()),
                ),
              ),
              description: embed.title || embed.description || "",
              mime_type: "image/png",
            });
          } catch (error) {
            diag.error(
              `DiscordMessageToFountChatLogEntry: 获取embed图片 ${embed.image.url} 失败`,
              error,
            );
          }

      const cachedAIReply = aiReplyObjectCache[fullMessage.id];
      /** @type {chatLogEntry_t_simple} */
      const entry = {
        ...cachedAIReply,
        time_stamp: fullMessage.createdTimestamp,
        role:
          author.id === client.user.id
            ? "char"
            : author.username === config.OwnerUserName
              ? "user"
              : "char",
        name:
          author.id === client.user.id
            ? client.user.displayName || client.user.username
            : finalDisplayName,
        content,
        files: files.filter(Boolean),
        extension: {
          ...cachedAIReply?.extension,
          discord_message_id: fullMessage.id,
        },
      };
      if (cachedAIReply) delete aiReplyObjectCache[fullMessage.id];

      return entry;
    }

    /**
     * 合并聊天日志。
     * @param {chatLogEntry_t_simple[]} log - 聊天日志条目数组。
     * @returns {chatLogEntry_t_simple[]} 合并后的聊天日志条目数组。
     */
    function MargeChatLog(log) {
      if (!log?.length) return [];
      const newlog = [];
      let last = null;
      for (const currentEntry of log) {
        const entry = { ...currentEntry }; //浅拷贝，防止修改原数组
        if (entry.files) entry.files = [...entry.files]; // 深拷贝文件数组
        if (entry.extension) entry.extension = { ...entry.extension }; // 深拷贝extension

        if (
          last &&
          last.name === entry.name &&
          last.role === entry.role &&
          entry.time_stamp - last.time_stamp < 3 * 60000 &&
          !last.files?.length
        ) {
          last.content += "\n" + entry.content;
          if (entry.files?.length)
            last.files = [...(last.files || []), ...entry.files];
          last.time_stamp = entry.time_stamp;
          if (entry.extension?.discord_message_id)
            last.extension = {
              ...last.extension,
              discord_message_id: entry.extension.discord_message_id,
            };
        } else {
          if (last) newlog.push(last);
          last = entry;
        }
      }
      if (last) newlog.push(last);
      return newlog;
    }

    /**
     * 处理消息队列。
     * @param {string} channelId - 频道 ID。
     * @returns {Promise<void>}
     */
    async function HandleMessageQueue(channelId) {
      diag.time(`HandleMessageQueue:${channelId}`);
      diag.debug(
        `HandleMessageQueue: channel="${channelId}", 队列长度=${ChannelMessageQueues[channelId]?.length || 0}`,
      );
      const myQueue = ChannelMessageQueues[channelId];
      try {
        if (!ChannelChatLogs[channelId]) {
          diag.debug(
            `HandleMessageQueue: channel="${channelId}" 首次处理，加载历史消息`,
          );
          const firstMessageInQueue = myQueue[0];
          const fetchedMessages = await tryFewTimes(() =>
            firstMessageInQueue.channel.messages.fetch({
              limit: MAX_FETCH_COUNT,
              before: firstMessageInQueue.id,
            }),
          );
          const historicalMessages = Array.from(
            fetchedMessages.values(),
          ).reverse();
          const entries = (
            await Promise.all(
              historicalMessages.map((msg) =>
                DiscordMessageToFountChatLogEntry(msg),
              ),
            )
          ).filter(Boolean);
          ChannelChatLogs[channelId] = MargeChatLog(entries);
          diag.debug(
            `HandleMessageQueue: channel="${channelId}" 历史消息加载完成，${entries.length} 条`,
          );
        }

        while (myQueue.length) {
          const currentMessage = myQueue.shift();
          if (!currentMessage) continue;

          const newUserEntry =
            await DiscordMessageToFountChatLogEntry(currentMessage);
          if (newUserEntry) {
            ChannelChatLogs[channelId].push(newUserEntry);
            ChannelChatLogs[channelId] = MargeChatLog(
              ChannelChatLogs[channelId],
            );
            while (ChannelChatLogs[channelId].length > MAX_MESSAGE_DEPTH) {
              const removed = ChannelChatLogs[channelId].shift();
              delete aiReplyObjectCache[removed?.extension?.discord_message_id];
            }
          } else continue;

          let triggerMessage = currentMessage;
          if (triggerMessage.partial)
            triggerMessage = await tryFewTimes(() => triggerMessage.fetch());

          // 触发模式判定
          const isDM = triggerMessage.channel.type === ChannelType.DM;
          const isMentioned = triggerMessage.mentions.users.has(client.user.id);
          const channelId_trigger = triggerMessage.channel.id;

          let shouldReply = false;

          // 旧配置兼容
          if (config.ReplyToAllMessages) {
            shouldReply = true;
          }
          // 私聊模式
          else if (isDM && config.PrivateChatEnabled !== false) {
            // 私聊中用户说话即触发（不限制必须是 OwnerUserName）
            shouldReply = true;
          }
          // @触发
          else if (isMentioned && config.TriggerOnMention !== false) {
            shouldReply = true;
          }
          // 说话触发（频道白名单模式）
          else if (config.TriggerOnMessage) {
            const whitelist = config.TriggerChannels || [];
            // 白名单为空 = 所有频道都触发
            if (
              whitelist.length === 0 ||
              whitelist.includes(channelId_trigger)
            ) {
              shouldReply = true;
            }
          }

          if (
            shouldReply &&
            triggerMessage.author.id !== client.user.id &&
            !triggerMessage.author.bot
          )
            await DoMessageReply(triggerMessage, channelId);
        }
      } catch (error) {
        diag.error(
          `HandleMessageQueue: channel="${channelId}" 处理出错`,
          error,
        );
      } finally {
        diag.timeEnd(`HandleMessageQueue:${channelId}`);
        delete ChannelHandlers[channelId];
      }
    }

    /**
     * 处理消息回复。
     * @param {Message} triggerMessage - 触发回复的 Discord 消息对象。
     * @param {string} channelId - 频道 ID。
     * @returns {Promise<void>}
     */
    async function DoMessageReply(triggerMessage, channelId) {
      diag.time(`DoMessageReply:${triggerMessage.id}`);
      diag.log(
        `DoMessageReply: msgId="${triggerMessage.id}", channel="${channelId}", author="${triggerMessage.author?.username}"`,
      );
      let typingInterval = setInterval(() => {
        triggerMessage.channel.sendTyping().catch((_) => 0);
      }, 7000).unref();

      /**
       * 发送消息并缓存AI原始回复对象 (如果提供了)
       * @param {import('npm:discord.js').MessagePayload | string} payload - 消息负载或字符串。
       * @param {ChatReply_t} originalAIReply - 原始 AI 回复对象。
       * @returns {Promise<Message>} 发送的 Discord 消息。
       */
      async function sendAndCache(payload, originalAIReply) {
        try {
          const sentDiscordMessage = await tryFewTimes(() =>
            triggerMessage.channel.send(payload),
          );
          if (sentDiscordMessage && originalAIReply)
            aiReplyObjectCache[sentDiscordMessage.id] = originalAIReply;

          return sentDiscordMessage;
        } catch (error) {
          diag.error(
            `DoMessageReply: 发送消息失败, payload长度=${payload?.content?.length}`,
            error,
          );
          return null;
        }
      }

      /**
       * 发送分割回复。
       * @param {ChatReply_t} fountReply - fount 聊天回复对象。
       * @returns {Promise<void>}
       */
      async function sendSplitReply(fountReply) {
        const MAX_FILES_PER_MESSAGE = 10;
        const filesToSend = (fountReply.files || []).map((f) => ({
          attachment: f.buffer,
          name: f.name,
          description: f.description,
        }));

        // ★ 平台标签过滤：提取 <discord> 标签内容，清理内部标签
        const rawContent =
          fountReply.content_for_show || fountReply.content || "";
        const displayContent = extractPlatformContent(rawContent, "discord");
        const textChunks = splitDiscordReply(displayContent);

        const fileChunks = [];
        for (let i = 0; i < filesToSend.length; i += MAX_FILES_PER_MESSAGE)
          fileChunks.push(filesToSend.slice(i, i + MAX_FILES_PER_MESSAGE));

        if (!textChunks.length && !fileChunks.length) return;

        for (let i = 0; i < textChunks.length; i++) {
          const isLastTextMessage = i === textChunks.length - 1;
          const payload = { content: textChunks[i] };
          if (isLastTextMessage && fileChunks.length)
            payload.files = fileChunks.shift();

          const isLastOverallMessage = isLastTextMessage && !fileChunks.length;
          await sendAndCache(
            payload,
            isLastOverallMessage ? fountReply : undefined,
          );
        }

        for (let i = 0; i < fileChunks.length; i++) {
          const payload = { files: fileChunks[i] };
          const isLastOverallMessage = i === fileChunks.length - 1;
          await sendAndCache(
            payload,
            isLastOverallMessage ? fountReply : undefined,
          );
        }
      }

      try {
        /**
         * 添加聊天日志条目。
         * @param {ChatReply_t} replyFromChar - 角色回复对象。
         * @returns {Promise<null>} 一个不返回任何值的 Promise。
         */
        const AddChatLogEntry = async (replyFromChar) => {
          if (
            replyFromChar &&
            (replyFromChar.content || replyFromChar.files?.length)
          )
            await sendSplitReply(replyFromChar);

          return null;
        };

        /**
         * 生成聊天回复请求。
         * @returns {Promise<object>} 返回一个聊天回复请求对象。
         */
        const generateChatReplyRequest = async () => ({
          supported_functions: {
            markdown: true,
            files: true,
            add_message: true,
          },
          username: ownerUsername,
          chat_name:
            triggerMessage.channel.type === ChannelType.DM
              ? `DM with ${triggerMessage.author.tag}`
              : `${triggerMessage.guild?.name || "N/A"}: #${triggerMessage.channel.name}`,
          char_id: botCharname,
          Charname: client.user.displayName || client.user.username,
          UserCharname: config.OwnerUserName,
          ReplyToCharname:
            userInfoCache[triggerMessage.author.id] ||
            triggerMessage.author.username,
          locales: localhostLocales,
          time: new Date(),
          world: null,
          user: await (async () => {
            const n = getAnyPreferredDefaultPart(ownerUsername, "personas");
            if (n) return loadPart(ownerUsername, "personas/" + n);
            return null;
          })(),
          char: charAPI,
          other_chars: [],
          plugins: allPlugins,
          chat_scoped_char_memory,
          chat_log: ChannelChatLogs[channelId].map((e) => ({ ...e })),
          AddChatLogEntry /**
           * @returns {Promise<object>} 返回一个更新后的聊天回复请求对象。
           */,
          Update: async () => await generateChatReplyRequest(),
          extension: {
            platform: "discord",
            trigger_message_id: triggerMessage.id,
            channel_id: channelId,
            guild_id: triggerMessage.guild?.id,
          },
        });

        // 记录用户消息到消息日志
        const userLogContent = await getMessageFullContent(
          triggerMessage,
          client,
        );
        const isDMLog = triggerMessage.channel.type === ChannelType.DM;
        pushMessageLog({
          type: "user",
          channelId,
          channelName: isDMLog
            ? `DM: ${triggerMessage.author.tag}`
            : `#${triggerMessage.channel.name || channelId}`,
          author:
            userInfoCache[triggerMessage.author.id] ||
            triggerMessage.author.username,
          content: userLogContent,
          files: triggerMessage.attachments?.size || 0,
        });

        const chatRequest = await generateChatReplyRequest();
        const aiFinalReply =
          await charAPI.interfaces.chat.GetReply(chatRequest);

        // ---- 调用所有 plugin 的 ReplyHandler（记忆表格操作、归档等） ----
        if (aiFinalReply) {
          for (const [pluginName, plugin] of Object.entries(allPlugins)) {
            if (plugin?.interfaces?.chat?.ReplyHandler) {
              try {
                await plugin.interfaces.chat.ReplyHandler(
                  aiFinalReply,
                  chatRequest,
                );
              } catch (err) {
                diag.warn(
                  `Plugin ${pluginName} ReplyHandler error:`,
                  err.message,
                );
              }
            }
          }
        }

        if (
          aiFinalReply &&
          (aiFinalReply.content || aiFinalReply.files?.length)
        ) {
          diag.debug(
            `DoMessageReply: AI回复完成, 内容长度=${aiFinalReply.content?.length || 0}, 文件数=${aiFinalReply.files?.length || 0}`,
          );
          // 记录 AI 回复到消息日志（含思维链和完整内容）
          const rawContent =
            aiFinalReply.content_for_show || aiFinalReply.content || "";
          const thinkMatch = rawContent.match(
            /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i,
          );
          pushMessageLog({
            type: "ai",
            channelId,
            channelName: isDMLog
              ? `DM: ${triggerMessage.author.tag}`
              : `#${triggerMessage.channel.name || channelId}`,
            author: client.user.displayName || client.user.username,
            content: extractPlatformContent(rawContent, "discord"),
            thinking: thinkMatch ? thinkMatch[1].trim() : "",
            fullContent: rawContent,
            files: aiFinalReply.files?.length || 0,
          });
          await sendSplitReply(aiFinalReply);
        }
        diag.timeEnd(`DoMessageReply:${triggerMessage.id}`);
      } catch (error) {
        diag.error(
          `DoMessageReply: msgId="${triggerMessage.id}", channel="${channelId}" 处理失败`,
          error,
        );
        // 记录错误到消息日志
        const isDMErr = triggerMessage.channel.type === ChannelType.DM;
        pushMessageLog({
          type: "error",
          channelId,
          channelName: isDMErr
            ? `DM: ${triggerMessage.author.tag}`
            : `#${triggerMessage.channel.name || channelId}`,
          author: "System",
          content: `回复失败: ${error.message || "Unknown error"}`,
        });
        try {
          const errorMessage = `Sorry, an error occurred while replying to your message: ${escapeMarkdown(error.message || "Unknown error")}`;
          await triggerMessage.channel.send(errorMessage);
        } catch (sendError) {
          diag.error(
            `DoMessageReply: 发送错误回复也失败, msgId="${triggerMessage.id}"`,
            sendError,
          );
        }
      } finally {
        if (typingInterval) clearInterval(typingInterval);
        typingInterval = null;
      }
    }

    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      try {
        const fetchedNewMessage = await tryFewTimes(() =>
          newMessage.fetch().catch((e) => {
            if (e.code === 10008) return null;
            throw e;
          }),
        );
        if (!fetchedNewMessage) {
          diag.debug(`MessageUpdate: msgId="${newMessage.id}" 已删除，跳过`);
          return;
        }

        const channelId = fetchedNewMessage.channel.id;
        const channelLogs = ChannelChatLogs[channelId];
        if (!channelLogs) return;

        const fountEntry =
          await DiscordMessageToFountChatLogEntry(fetchedNewMessage);
        if (!fountEntry) return;

        const messageId = fetchedNewMessage.id;
        const existingIndex = channelLogs.findIndex(
          (entry) => entry.extension?.discord_message_id === messageId,
        );

        if (existingIndex >= 0) {
          channelLogs[existingIndex] = fountEntry;
          ChannelChatLogs[channelId] = MargeChatLog(channelLogs);
        } else {
          channelLogs.push(fountEntry);
          const merged = MargeChatLog(channelLogs);
          ChannelChatLogs[channelId] = merged;
          while (merged.length > MAX_MESSAGE_DEPTH) {
            const removed = merged.shift();
            delete aiReplyObjectCache[removed?.extension?.discord_message_id];
          }
        }
      } catch (error) {
        diag.error(`MessageUpdate: msgId="${newMessage.id}" 处理失败`, error);
      }
    });

    client.on(Events.MessageDelete, async (message) => {
      try {
        if (!message.id || !message.channelId) {
          diag.warn("MessageDelete: 收到缺少 id 或 channelId 的事件");
          return;
        }

        const { channelId } = message;
        const channelLogs = ChannelChatLogs[channelId];
        if (!channelLogs) return;

        const messageId = message.id;
        const indexToRemove = channelLogs.findIndex(
          (entry) => entry.extension?.discord_message_id === messageId,
        );

        if (indexToRemove >= 0) {
          const removed = channelLogs.splice(indexToRemove, 1)[0];
          delete aiReplyObjectCache[removed?.extension?.discord_message_id];
          diag.debug(`MessageDelete: 已从日志移除 msgId="${messageId}"`);
        }
      } catch (error) {
        diag.error(`MessageDelete: msgId="${message.id}" 处理失败`, error);
      }
    });

    client.on(Events.MessageCreate, async (message) => {
      let fullMessage = message;
      if (fullMessage.partial)
        try {
          fullMessage = await tryFewTimes(() => message.fetch());
        } catch (error) {
          diag.error(`MessageCreate: 获取部分消息 ${message.id} 失败`, error);
          return;
        }

      const channelId = fullMessage.channel.id;
      (ChannelMessageQueues[channelId] ??= []).push(fullMessage);
      if (!ChannelHandlers[channelId])
        ChannelHandlers[channelId] = HandleMessageQueue(channelId);
    });
  }

  return {
    Intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
    ],
    Partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.GuildMember,
    ],
    OnceClientReady: SimpleDiscordBotMain,
    GetBotConfigTemplate: GetSimpleBotConfigTemplate,
    /**
     * 清除所有频道的上下文（只保留记忆表格）
     * @returns {{clearedChannels: number}} 清除的频道数
     */
    ClearContext: () => {
      const count = Object.keys(ChannelChatLogs).length;
      for (const key of Object.keys(ChannelChatLogs)) {
        delete ChannelChatLogs[key];
      }
      // 清除 AI 的 scoped 记忆
      for (const key of Object.keys(chat_scoped_char_memory)) {
        delete chat_scoped_char_memory[key];
      }
      // 清除消息日志
      messageLog.length = 0;
      diag.log(`ClearContext: 已清除 ${count} 个频道的上下文和消息日志`);
      return { clearedChannels: count };
    },
    /**
     * 获取当前活跃频道列表（供后台管理显示）
     * @returns {Array<{channelId: string, messageCount: number}>}
     */
    GetActiveChannels: () => {
      return Object.entries(ChannelChatLogs).map(([channelId, logs]) => ({
        channelId,
        messageCount: logs.length,
      }));
    },
    /**
     * 获取消息日志（供后台管理界面显示）
     * @param {number} [since] - 只返回此时间戳之后的记录（可选）
     * @returns {{logs: Array, maxSize: number}}
     */
    GetMessageLog: (since) => {
      const logs = since
        ? messageLog.filter((e) => e.timestamp > since)
        : [...messageLog];
      return { logs, maxSize: messageLogMaxSize };
    },
    /**
     * 设置消息日志最大条数
     * @param {number} size - 最大条数（1-200）
     */
    SetMessageLogSize: (size) => {
      const n = Math.max(1, Math.min(200, parseInt(size) || 20));
      messageLogMaxSize = n;
      while (messageLog.length > n) messageLog.shift();
      return { maxSize: n };
    },
  };
}

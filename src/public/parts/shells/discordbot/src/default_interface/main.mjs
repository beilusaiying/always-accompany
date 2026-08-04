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
import { fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, createBotStreamEditor, makeStreamGenerationOptions, shouldAbsorbBurst, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'

import { getMessageFullContent, splitDiscordReply } from "./tools.mjs";

const diag = createDiag("discord");

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "discord"、"telegram"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
  return extractPlatformContentShared(content, displayTag);
}

/** @typedef {import('npm:discord.js').Message} Message */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatLogEntry_t} BeiluChatLogEntryBase */
/**
 *  @typedef { (BeiluChatLogEntryBase & {
 *	extension?: {discord_message_id?: string, [key: string]: any }
 * })} chatLogEntry_t_simple
 */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatReply_t} ChatReply_t */

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
   * @returns {{OwnerUserName: string, OwnerUserId: string, MaxMessageDepth: number, MaxFetchCount: number, ReplyToAllMessages: boolean, TriggerOnMention: boolean, TriggerOnMessage: boolean, TriggerChannels: string[], PrivateChatEnabled: boolean}} 返回一个包含简单机器人配置模板的对象。
   */
  function GetSimpleBotConfigTemplate() {
    return {
      OwnerUserName: "your_discord_username", // Discord 用户名（仅做显示用, 不再用于身份判断）
      OwnerUserId: "", // Discord 用户 ID（右键用户→复制用户ID, 用于安全身份识别）
      MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
      MaxFetchCount: 30,
      ReplyToAllMessages: false, // 若开启则对所有消息做出回复（旧选项，兼容保留）
      // ---- 触发模式配置 ----
      TriggerOnMention: true, // @触发：被@时回复
      TriggerOnMessage: false, // 说话触发：白名单频道中所有消息都回复
      TriggerChannels: [], // 说话触发的频道白名单（频道ID数组），空=所有频道
      PrivateChatEnabled: true, // 私聊模式：私聊中用户说话即触发
      StreamReplyEnabled: true, // 件13 流式回复（官方 message.edit 滚动编辑,1.2s 节流;关=生成完一次性发送）
      BurstDebounceEnabled: false, // 连发吸收（openclaw/LangBot 双实证形）：队列有后续时本条只入上下文由末条触发；命令/带附件消息不吸收
      ...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
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
  // [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
  const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

  // ---- 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）----
  // 条目形状 { id, timestamp, type, channelId, channelName, author, content, thinking, fullContent, files }
  const _msgLog = createBotMessageLog();
  const pushMessageLog = (entry) => _msgLog.push(entry);

  async function SimpleDiscordBotMain(client, config) {
    const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
    const MAX_FETCH_COUNT =
      config.MaxFetchCount ||
      Math.max(MAX_MESSAGE_DEPTH, Math.floor(MAX_MESSAGE_DEPTH * 1.5));

    const userInfoCache = {}; // Record<string, string> 用户ID到显示名称

    // 件11：队列三元组（Queues/Handlers/HandleMessageQueue 生命周期）收骨架 createMessageQueueRuntime
    // （botContentShared）——原逐字声明+入队三行式+try/while/finally 纯删，本壳只保 discord 特异段：
    // LoadChannelHistoryOnce（首次历史加载）/ ProcessDiscordQueueItem（单条处理）。
    const _mq = createMessageQueueRuntime({
      diag,
      processItem: ProcessDiscordQueueItem,
      onQueueStart: LoadChannelHistoryOnce,
    });

    /** @type {Record<string, ChatReply_t>} 键为 bot 发出的 Discord 消息 ID，值为对应 AI 回复对象。 */
    const aiReplyObjectCache = {};

    /**
     * 将 Discord 消息转换为 beilu 聊天日志条目。
     * @param {Message} discordMessage - Discord 消息对象。
     * @returns {Promise<chatLogEntry_t_simple>} 转换后的 beilu 聊天日志条目。
     */
    async function DiscordMessageToBeiluChatLogEntry(discordMessage) {
      let fullMessage = discordMessage;
      if (fullMessage.partial)
        try {
          fullMessage = await tryFewTimes(() => discordMessage.fetch());
        } catch (error) {
          diag.error(
            `DiscordMessageToBeiluChatLogEntry: 获取部分消息 ${discordMessage.id} 失败`,
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
                `DiscordMessageToBeiluChatLogEntry: 获取附件 ${attachment.name} 失败`,
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
              `DiscordMessageToBeiluChatLogEntry: 获取embed图片 ${embed.image.url} 失败`,
              error,
            );
          }

      const cachedAIReply = aiReplyObjectCache[fullMessage.id];
      /** @type {chatLogEntry_t_simple} */
      // F-T7: 外部用户输入 sanitize + 身份识别标记
      //   bot 自己  → 优先用 cachedAIReply.content (AI 真实回复)
      //   owner    → 原文直入
      //   其他用户 → 字符转义 + 长度限制 + <external_user name="..."> 包裹,让 AI 能分辨多用户身份
      const _isBot = author.id === client.user.id;
      const _isOwner = config.OwnerUserId
        ? author.id === config.OwnerUserId
        : author.username === config.OwnerUserName;
      let _finalContent;
      if (_isBot) {
        _finalContent = (cachedAIReply && cachedAIReply.content !== undefined) ? cachedAIReply.content : content;
      } else if (_isOwner) {
        _finalContent = content;
      } else {
        _finalContent = sanitizeExternalMessage(content, finalDisplayName, 'discord');
      }

      const entry = {
        ...cachedAIReply,
        time_stamp: fullMessage.createdTimestamp,
        role:
          author.id === client.user.id
            ? "char"
            : (config.OwnerUserId ? author.id === config.OwnerUserId : author.username === config.OwnerUserName)
              ? "user"
              : "char",
        name:
          author.id === client.user.id
            ? client.user.displayName || client.user.username
            : finalDisplayName,
        content: _finalContent,
        files: files.filter(Boolean),
        // C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
        _sourceType: "bot",
        ...buildBotSourceMeta(config, author.id, _isOwner),
        extension: {
          ...cachedAIReply?.extension,
          discord_message_id: fullMessage.id,
        },
      };
      if (cachedAIReply) delete aiReplyObjectCache[fullMessage.id];

      return entry;
    }

    // T9：MargeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架，含 files 守卫+深拷贝+extension 键保留）。
    // discord 平台差异=保留 discord_message_id，经 mergeExtensionKeys 传入。
    const MargeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: ["discord_message_id"] });

    /**
     * 发送消息到指定频道并缓存 AI 原始回复对象（如果提供了）。
     * 闭包级单源（凛倾 07-09 委派回程唤醒需要脱离 triggerMessage 的频道级发送；
     * DoMessageReply 内部经薄包装复用，防同逻辑双份散写）。
     * @param {import('npm:discord.js').TextBasedChannel} channel - 目标频道。
     * @param {import('npm:discord.js').MessagePayload | string} payload - 消息负载或字符串。
     * @param {ChatReply_t} originalAIReply - 原始 AI 回复对象。
     * @returns {Promise<Message|null>} 发送的 Discord 消息。
     */
    async function sendAndCacheTo(channel, payload, originalAIReply) {
      try {
        const sentDiscordMessage = await tryFewTimes(() => channel.send(payload));
        if (sentDiscordMessage && originalAIReply)
          aiReplyObjectCache[sentDiscordMessage.id] = originalAIReply;
        return sentDiscordMessage;
      } catch (error) {
        diag.error(
          `sendAndCacheTo: 发送消息失败, payload长度=${payload?.content?.length}`,
          error,
        );
        return null;
      }
    }

    /**
     * 发送分割回复到指定频道（平台标签提取 + 2000 字分段 + 附件分批）。
     * @param {import('npm:discord.js').TextBasedChannel} channel - 目标频道。
     * @param {ChatReply_t} beiluReply - beilu 聊天回复对象。
     * @returns {Promise<void>}
     */
    async function sendSplitReplyTo(channel, beiluReply, stream) {
      const MAX_FILES_PER_MESSAGE = 10;
      const filesToSend = (beiluReply.files || []).map((f) => ({
        attachment: f.buffer,
        name: f.name,
        description: f.description,
      }));

      // ★ 平台标签过滤：提取 <discord> 标签内容，清理内部标签
      const rawContent =
        beiluReply.content_for_show || beiluReply.content || "";
      const displayContent = extractPlatformContent(rawContent, "discord");
      const textChunks = splitDiscordReply(displayContent);

      const fileChunks = [];
      for (let i = 0; i < filesToSend.length; i += MAX_FILES_PER_MESSAGE)
        fileChunks.push(filesToSend.slice(i, i + MAX_FILES_PER_MESSAGE));

      if (!textChunks.length && !fileChunks.length) return;

      // 件13：流式预览已投递首段时，finalize 把预览消息编辑为最终首段并跳过首段发送；
      // finalize 返回 null=全量降级。单段+带附件时附件仍走下方 files 循环（不挂流式消息）。
      let startIdx = 0;
      if (stream && textChunks.length) {
        const _msg = await stream.finalize(textChunks[0]);
        if (_msg != null) {
          startIdx = 1;
          if (textChunks.length === 1 && !fileChunks.length && _msg.id)
            aiReplyObjectCache[_msg.id] = beiluReply;
        }
      }

      for (let i = startIdx; i < textChunks.length; i++) {
        const isLastTextMessage = i === textChunks.length - 1;
        const payload = { content: textChunks[i] };
        if (isLastTextMessage && fileChunks.length)
          payload.files = fileChunks.shift();

        const isLastOverallMessage = isLastTextMessage && !fileChunks.length;
        await sendAndCacheTo(
          channel,
          payload,
          isLastOverallMessage ? beiluReply : undefined,
        );
      }

      for (let i = 0; i < fileChunks.length; i++) {
        const payload = { files: fileChunks[i] };
        await sendAndCacheTo(
          channel,
          payload,
          i === fileChunks.length - 1 ? beiluReply : undefined,
        );
      }
    }

    /**
     * 首次处理某频道时加载历史消息（件11 onQueueStart 钩子；ChannelChatLogs 已有则跳过）。
     * @param {string} channelId - 频道 ID。
     * @param {Message} firstMessageInQueue - 本轮队列首条消息（历史拉取锚点）。
     * @returns {Promise<void>}
     */
    async function LoadChannelHistoryOnce(channelId, firstMessageInQueue) {
      if (ChannelChatLogs[channelId]) return;
      diag.debug(
        `HandleMessageQueue: channel="${channelId}" 首次处理，加载历史消息`,
      );
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
            DiscordMessageToBeiluChatLogEntry(msg),
          ),
        )
      ).filter(Boolean);
      ChannelChatLogs[channelId] = MargeChatLog(entries);
      diag.debug(
        `HandleMessageQueue: channel="${channelId}" 历史消息加载完成，${entries.length} 条`,
      );
    }

    /**
     * 处理单条队列消息（件11 processItem：转换→追加日志→触发判定→回复）。
     * @param {Message} currentMessage - Discord 消息对象。
     * @param {string} channelId - 频道 ID。
     * @returns {Promise<void>}
     */
    async function ProcessDiscordQueueItem(currentMessage, channelId, meta) {
      const newUserEntry =
        await DiscordMessageToBeiluChatLogEntry(currentMessage);
      if (!newUserEntry) return;
      ChannelChatLogs[channelId].push(newUserEntry);
      ChannelChatLogs[channelId] = MargeChatLog(
        ChannelChatLogs[channelId],
      );
      while (ChannelChatLogs[channelId].length > MAX_MESSAGE_DEPTH) {
        const removed = ChannelChatLogs[channelId].shift();
        delete aiReplyObjectCache[removed?.extension?.discord_message_id];
      }

      let triggerMessage = currentMessage;
      if (triggerMessage.partial)
        triggerMessage = await tryFewTimes(() => triggerMessage.fetch());

      // 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实。
      const shouldReply = resolveBotTrigger({
        isDM: triggerMessage.channel.type === ChannelType.DM,
        isMentioned: triggerMessage.mentions.users.has(client.user.id),
        canGroupTrigger: true, // discord 原语义：说话触发无会话类型门
        whitelistId: triggerMessage.channel.id,
        senderId: triggerMessage.author.id,
        isOwner: config.OwnerUserId
          ? triggerMessage.author.id === config.OwnerUserId
          : triggerMessage.author.username === config.OwnerUserName,
        isSelf: triggerMessage.author.id === client.user.id,
        isFromBot: !!triggerMessage.author.bot,
      }, config, { diag, logContext: `channel="${channelId}"` });
      // #9 连发吸收（判定单源 shouldAbsorbBurst：开关/命令/媒体三不合并;吸收=只入上下文由末条触发）
      if (shouldReply && shouldAbsorbBurst({
        config, pending: meta?.pending,
        text: triggerMessage.content,
        hasMedia: !!triggerMessage.attachments?.size,
      })) {
        diag.debug(`ProcessDiscordQueueItem: 连发吸收，跳过本条生成（pending=${meta.pending}）`);
        return;
      }
      if (shouldReply)
        await DoMessageReply(triggerMessage, channelId);
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

      // 发送函数已提升为闭包级单源 sendAndCacheTo/sendSplitReplyTo（委派回程唤醒共用），
      // 此处薄包装绑定 triggerMessage.channel，下方调用点零改动。
      const sendSplitReply = (beiluReply) =>
        sendSplitReplyTo(triggerMessage.channel, beiluReply);

      // 件13：流式回复编辑器（生成侧走既有 generation_options.replyPreviewUpdater 链）
      let _stream = null;

      try {
        // bot 侧对话线管理命令（凛倾 07-09「在bot那边新建对话文件,然后切换」）：owner 专用，
        // 命中即执行+回执并【跳过 AI 生成】。命令词/逻辑单源=botContentShared handleBotChatCommand，
        // 与 web 面板切换器同一指针权威（bot_chat_bindings），双入口即改即生效。
        {
          const _cmdIsOwner = config.OwnerUserId
            ? triggerMessage.author.id === config.OwnerUserId
            : triggerMessage.author.username === config.OwnerUserName;
          const _cmdReply = await handleBotChatCommand({
            username: ownerUsername,
            charName: botCharname,
            platform: "discord",
            text: triggerMessage.content || "",
            isOwner: _cmdIsOwner,
          });
          if (_cmdReply) {
            await sendAndCacheTo(triggerMessage.channel, { content: _cmdReply });
            diag.timeEnd(`DoMessageReply:${triggerMessage.id}`);
            return;
          }
        }

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
        const generateChatReplyRequest = async () => {
          // 线 id 本轮取一次：chatid 字段与 chat_log 读源共用，避免同一请求解析两遍。
          const _lineId = await _ensureBotChatId();
          return {
          supported_functions: {
            markdown: true,
            files: true,
            add_message: true,
          },
          username: ownerUsername,
          // bot 对话文件线（凛倾 07-09）：chatid=per-chatId 隔离载体；ensure 失败冒泡本函数 catch 外显
          chatid: _lineId,
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
          user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
          char: charAPI,
          other_chars: [],
          plugins: allPlugins,
          chat_scoped_char_memory,
          // [0726 上下文换源] 优先取对话文件（与 web 正线 requestBuilder:142 同源 getVisibleChatLog）——
          //   进程重启后 AI 自动续上；?? 兜底壳内存=无线/读盘失败时退化为原行为（诚实降级不断链）。
          chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: MAX_MESSAGE_DEPTH }))
            ?? applyBotContentFilter(ChannelChatLogs[channelId].map((e) => ({ ...e })), ownerUsername),
          AddChatLogEntry /**
           * @returns {Promise<object>} 返回一个更新后的聊天回复请求对象。
           */,
          // 件13：流式预览回调（构造单源 makeStreamGenerationOptions,编辑时序由骨架泵串行化）
          generation_options: makeStreamGenerationOptions(_stream, "discord"),
          Update: async () => await generateChatReplyRequest(),
          extension: {
            platform: "discord",
            trigger_message_id: triggerMessage.id,
            channel_id: channelId,
            guild_id: triggerMessage.guild?.id,
          },
          };
        };

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

        // 件13：命令回执已 early-return，此处才进 AI 生成=创建流式编辑器（StreamReplyEnabled 可关）
        if (config.StreamReplyEnabled !== false)
          _stream = createBotStreamEditor({
            diag,
            maxLen: 2000, // discord 官方单条消息上限
            minIntervalMs: 1200, // 普通消息 edit 常规限速安全间隔
            sendInitial: async (text) => await tryFewTimes(() => triggerMessage.channel.send({ content: text })),
            editMessage: async (msg, text) => { await tryFewTimes(() => msg.edit({ content: text })); },
          });

        // 上下文实体（凛倾 07-09「目的是上下文」）：平台用户消息写进 bot 对话文件。
        // 身份与壳内存日志同规则（owner=user 其余=char，显示名经 result.name 覆盖）。
        // [0726 上下文换源] 调序到 generateChatReplyRequest **之前**并改为 await：
        //   chat_log 现在从对话文件读，构建后再落盘会让本轮少掉当前这条触发消息（AI 看不到用户刚说的话）。
        //   写失败不抛（catch 降级），本轮 chat_log 由 ?? 兜底回壳内存。
        //   _sourceType/_permissionLevel 一并带上：N42 档位门取尾条判定，见 chatOps.appendBotChatEntry。
        {
          const _isOwnerMsg = config.OwnerUserId
            ? triggerMessage.author.id === config.OwnerUserId
            : triggerMessage.author.username === config.OwnerUserName;
          try {
            await appendBotChatEntry(await _ensureBotChatId(), {
              role: _isOwnerMsg ? "user" : "char",
              name: userInfoCache[triggerMessage.author.id] || triggerMessage.author.username,
              content: userLogContent,
              _sourceType: "bot",
              ...buildBotSourceMeta(config, triggerMessage.author.id, _isOwnerMsg),
            });
          } catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
        }
        const chatRequest = await generateChatReplyRequest();
        const aiFinalReply =
          await charAPI.interfaces.chat.GetReply(chatRequest);

        // ★ Phase 4: ReplyHandler 已在模板 GetReply 内部统一调用（含 regen 循环）
        // 此处不再重复调用，避免带副作用的插件（如 beilu-memory）被执行两次

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
          await sendSplitReplyTo(triggerMessage.channel, aiFinalReply, _stream);
          // 上下文实体：AI 回复双写进 bot 对话文件（同上 fire-and-forget）
          if (chatRequest.chatid) {
            await appendBotChatEntry(chatRequest.chatid, {
              role: "char",
              name: client.user.displayName || client.user.username,
              charName: botCharname,
              content: aiFinalReply.content || "",
              content_for_show: aiFinalReply.content_for_show,
            }).catch((e) => diag.warn(`bot 对话文件 AI 回复双写失败: ${e?.message || e}`));
          }
        }
        diag.timeEnd(`DoMessageReply:${triggerMessage.id}`);
      } catch (error) {
        diag.error(
          `DoMessageReply: msgId="${triggerMessage.id}", channel="${channelId}" 处理失败`,
          error,
        );
        // BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
        broadcastBotError({ username: ownerUsername, platform: 'discordbot', botname: botCharname, phase: 'runtime', error })
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
          // 出错文案走 injectTexts 单源（bots.error_reply 键，家族统一；escapeMarkdown 是 discord 平台机制留代码）
          const errorMessage = fillInjectText("bots.error_reply", { error: escapeMarkdown(error.message || "Unknown error") });
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

        const beiluEntry =
          await DiscordMessageToBeiluChatLogEntry(fetchedNewMessage);
        if (!beiluEntry) return;

        const messageId = fetchedNewMessage.id;
        const existingIndex = channelLogs.findIndex(
          (entry) => entry.extension?.discord_message_id === messageId,
        );

        if (existingIndex >= 0) {
          channelLogs[existingIndex] = beiluEntry;
          ChannelChatLogs[channelId] = MargeChatLog(channelLogs);
        } else {
          channelLogs.push(beiluEntry);
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
      _mq.enqueue(channelId, fullMessage);
    });

    // bot 对话文件 chatid（凛倾 07-09「一个平台一个」+「如果创建新对话呢」）：per-platform
    // 对话线=多平台并发的 per-chatId 隔离载体（模式/预设/pendingResults/记忆缓存键按线隔离）。
    // 每条消息按后端指针取（bot_chat_bindings 单一权威），【不缓存 chatid】——面板「新建对话」
    // 切指针后 bot 下条消息即走新线。只缓存模块引用（dynamic import 一次）。
    // ensure 失败直接冒泡调用方既有错误路径（DoMessageReply catch→broadcastBotError+错误回复/
    // 唤醒轮 catch→diag+broadcast）——禁回退空 chatid 静默降级：丢线=模式/预设/记忆隔离悄悄
    // 失效+消息不落对话文件，「对话文件=上下文载体」（凛倾 07-09）目的静默不成立。
    // [收口 0726] 实现体已迁 botContentShared.resolveBotChatId（9 壳统一取法，原本壳私有版
    // 是唯一实现、其余 8 壳零接线=半接线）。本函数保留为薄适配：只闭包住 ownerUsername/botCharname，
    // 3 处调用点不变。禁在此重新长出私有实现。
    async function _ensureBotChatId() {
      return await resolveBotChatId(ownerUsername, botCharname, "discord");
    }

    /**
     * 委派回程唤醒轮（凛倾 07-09「工作完需要有注入通知,然后ai去看,然后发送」）：
     * <report> 落队列后 replyHandler 经 notifyBotDelegateReport 调到此处 →
     * 出一轮无触发消息的主动生成——该轮 GetPrompt 走 H2 注入工作报告（consume-once），
     * AI 读报告后组织回复 → sendSplitReplyTo 发回委派发起频道。
     * 串行闸：复用件11 _mq.handlers 槽，与用户消息处理互斥（同频道不并发 GetReply）。
     * @param {string} channelId - 委派发起时记录的来源频道（_delegateCtx.sourceChannelId）。
     */
    async function DoDelegateWakeReply(channelId) {
      // 频道正忙（用户消息处理中）→ 等它排空再唤醒，最长 60s 后放弃
      //（放弃无害：报告仍在队列，用户下条消息的生成照样注入）
      // T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
      await runExclusiveWakeSlot(_mq.handlers, channelId, async () => {
        try {
          const channel = await tryFewTimes(() => client.channels.fetch(channelId));
          if (!channel || typeof channel.send !== "function") {
            diag.warn(`DoDelegateWakeReply: channel="${channelId}" 不可达/不可发送，跳过`);
            return;
          }
          const isDM = channel.type === ChannelType.DM;
          const wakeRequest = async () => {
            // 与消息链同构：线 id 本轮取一次，chatid 与 chat_log 读源共用。
            const _lineId = await _ensureBotChatId();
            return {
            supported_functions: { markdown: true, files: true, add_message: true },
            username: ownerUsername,
            // bot 对话文件线（凛倾 07-09）：与消息链同一 chatid，唤醒轮同线隔离；失败冒泡唤醒轮 catch
            chatid: _lineId,
            chat_name: isDM
              ? `DM with ${channel.recipient?.tag || "user"}`
              : `${channel.guild?.name || "N/A"}: #${channel.name}`,
            char_id: botCharname,
            Charname: client.user.displayName || client.user.username,
            UserCharname: config.OwnerUserName,
            ReplyToCharname: config.OwnerUserName,
            locales: localhostLocales,
            time: new Date(),
            world: null,
            user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
            char: charAPI,
            other_chars: [],
            plugins: allPlugins,
            chat_scoped_char_memory,
            // [0726 上下文换源] 与消息链同源，防唤醒轮与消息轮看到两份不同上下文
            chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: MAX_MESSAGE_DEPTH }))
              ?? applyBotContentFilter((ChannelChatLogs[channelId] || []).map((e) => ({ ...e })), ownerUsername),
            AddChatLogEntry: async (replyFromChar) => {
              if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
                await sendSplitReplyTo(channel, replyFromChar);
              return null;
            },
            Update: wakeRequest,
            extension: {
              platform: "discord",
              channel_id: channelId,
              guild_id: channel.guild?.id,
              delegate_wake: true,
            },
            };
          };
          const _wakeReq = await wakeRequest();
          const aiReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
          if (aiReply && (aiReply.content || aiReply.files?.length)) {
            const rawContent = aiReply.content_for_show || aiReply.content || "";
            pushMessageLog({
              type: "ai",
              channelId,
              channelName: isDM ? `DM: ${channel.recipient?.tag || channelId}` : `#${channel.name || channelId}`,
              author: client.user.displayName || client.user.username,
              content: extractPlatformContent(rawContent, "discord"),
              fullContent: rawContent,
              files: aiReply.files?.length || 0,
            });
            await sendSplitReplyTo(channel, aiReply);
            // 上下文实体：唤醒轮 AI 回复同样双写进 bot 对话文件（fire-and-forget）
            if (_wakeReq.chatid) {
              await appendBotChatEntry(_wakeReq.chatid, {
                role: "char",
                name: client.user.displayName || client.user.username,
                charName: botCharname,
                content: aiReply.content || "",
                content_for_show: aiReply.content_for_show,
              }).catch((e) => diag.warn(`bot 对话文件唤醒回复双写失败: ${e?.message || e}`));
            }
          }
        } catch (error) {
          diag.error(`DoDelegateWakeReply: channel="${channelId}" 失败`, error);
          broadcastBotError({ username: ownerUsername, platform: 'discordbot', botname: botCharname, phase: 'runtime', error });
        }
      }, { onBusy: () => diag.warn(`DoDelegateWakeReply: channel="${channelId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
    }

    // 注册委派回程唤醒（key=platform+owner+char，与 _delegateCtx.sourceChannel 派生一致）。
    // 不显式注销：bot 停机后 client 销毁，回调抛错由 notify 侧自愈摘除。
    registerBotDelegateWaker("discord", ownerUsername, botCharname, async ({ channelId }) => {
      if (!channelId) {
        diag.warn("DelegateWaker: 委派条目无 sourceChannelId，无法定位回程频道，跳过（报告等下轮注入）");
        return;
      }
      await DoDelegateWakeReply(channelId);
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
      _msgLog.clear();
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
    GetMessageLog: (since) => _msgLog.get(since),
    /**
     * 设置消息日志最大条数
     * @param {number} size - 最大条数（1-200）
     */
    SetMessageLogSize: (size) => _msgLog.setSize(size),
  };
}

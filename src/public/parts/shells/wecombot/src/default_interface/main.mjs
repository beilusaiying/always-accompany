import { setTimeout } from "node:timers";

import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { applyBotContentFilter, loadAllDefaultPlugins, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog as mergeChatLogShared, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
import { getInjectText, fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from "../../../botErrorBroadcast.mjs";

import {
	downloadMedia,
	extractPlatformContent,
	getAccessToken,
	getUserInfo,
	sendFileMessage,
	sendImageMessage,
	sendTextMessage,
	splitWecomMessage,
	uploadMedia,
} from "./tools.mjs";

const diag = createDiag("wecombot");

/** @typedef {import('../../../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../chat/decl/chatLog.ts').chatLogEntry_t} BeiluChatLogEntryBase */
/**
 * @typedef {BeiluChatLogEntryBase & {
 *   extension?: { wecom_msg_id?: string, [key: string]: any }
 * }} chatLogEntry_t_wecom
 */
/** @typedef {import('../../../../chat/decl/chatLog.ts').chatReply_t} ChatReply_t */

/**
 * 创建简单的企业微信接口（默认消息管线）。
 * @param {CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者用户名。
 * @param {string} botCharname - 机器人角色名称。
 * @returns {Promise<object>} 包含企业微信接口方法的对象。
 */
export async function createSimpleWecomInterface(
	charAPI,
	ownerUsername,
	botCharname,
) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error(
			"charAPI.interfaces.chat.GetReply is required for SimpleWecomInterface.",
		);

	/**
	 * 返回默认配置模板。
	 * @returns {object}
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			corpId: "",          // 企业微信 corpId
			agentId: 0,          // 应用 agentId
			secret: "",          // 应用 Secret
			token: "",           // 回调验证 token（43字符）
			encodingAESKey: "",  // 回调消息加密 key（43字符）
			OwnerUserName: "",   // 主人的企业微信 userId（用于安全身份识别；非主人输入会被转义隔离）
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH, // 最大保留消息条数
			// ---- 触发模式配置（照 discord 模板适配企业微信）----
			// 企业微信自建应用回调只有「成员→应用」私聊语义，无频道/@提及概念，
			// 故 discord 的 TriggerOnMention/TriggerChannels 无对应入站源；
			// 群聊相关字段为前向兼容（若回调投递群标识则生效），标准自建应用回调下不触发。
			// P4 键名归一（discord 系统一命名）：旧键 TriggerOnPrivate/TriggerOnGroup/TriggerGroups 停发
			//（dingtalk 0716 病征3先例），读侧保留旧键回退以兼容存量配置。
			PrivateChatEnabled: true, // 私聊触发：成员对应用说话即触发
			TriggerOnMessage: false,  // 群聊触发：群消息是否回复（需回调投递群标识，标准自建应用不投递）
			TriggerChannels: [],      // 群聊白名单（群 ID 数组），空=所有群；仅 TriggerOnMessage=true 时生效
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		};
	}

	// ---- 状态 ----

	/** 当前 bot 配置（OnBotReady 时写入） */
	let botConfig = {};

	/** 用户会话聊天日志，key: userId 或 groupId */
	const ChatLogs = {}; // Record<string, chatLogEntry_t_wecom[]>

	/** AI 上下文记忆 */
	const chat_scoped_char_memory = {};

	// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared，命名统一 discord 系:原
	// activeHandlers/messageQueues/handleMessageQueue 三元组纯删）。wecom 触发判定在入队前的
	// handleMessage 侧（本壳原状），队列内单条处理=doMessageReply 直连；原 handleMessageQueue
	// 无 try/finally（processItem 异常会漏释放槽），统一到骨架顺带根治。
	const _mq = createMessageQueueRuntime({
		diag,
		processItem: (msg, chatId) => doMessageReply(msg, chatId),
	});

	/** 用户信息缓存，key: userId */
	const userInfoCache = {}; // Record<string, { name: string, expireAt: number }>

	/** 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删） */
	const _msgLog = createBotMessageLog();

	// ---- 加载默认插件 ----

	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

	// ---- 辅助函数 ----

	/**
	 * 向消息日志追加一条记录（T9 件2 薄适配）。
	 * @param {object} entry - 日志条目。
	 */
	const pushMessageLog = (entry) => _msgLog.push(entry);

	/**
	 * 获取用户显示名称（带缓存，10 分钟 TTL）。
	 * @param {string} userId - 企业微信 userId。
	 * @returns {Promise<string>} 显示名称。
	 */
	async function getDisplayName(userId) {
		const cached = userInfoCache[userId];
		if (cached && cached.expireAt > Date.now()) return cached.name;
		try {
			const token = await getAccessToken(botConfig.corpId, botConfig.secret);
			const info = await getUserInfo(token, userId);
			const name = info.name || info.alias || userId;
			userInfoCache[userId] = { name, expireAt: Date.now() + 10 * 60_000 };
			return name;
		} catch (e) {
			diag.warn(`getDisplayName: userId="${userId}" 获取失败: ${e.message}`);
			return userId;
		}
	}

	/**
	 * 将企业微信消息转换为 beilu 聊天日志条目。
	 * @param {object} msg - 企业微信消息对象（parseXml 结果）。
	 * @param {boolean} isBot - 是否是 bot 自己的消息。
	 * @param {string} [displayName] - 发送者显示名称。
	 * @returns {chatLogEntry_t_wecom}
	 */
	async function wecomMsgToLogEntry(msg, isBot, displayName) {
		const userId = msg.FromUserName || "";
		const name = displayName || (isBot ? botCharname : await getDisplayName(userId));
		const role = isBot ? "char" : (userId === botConfig.OwnerUserName ? "user" : "char");
		const msgType = (msg.MsgType || "").toLowerCase();
		let content = msg.Content || "";

		// 非文本消息：补充占位内容描述
		if (!isBot) {
			if (msgType === "image" && !content) content = getInjectText("bots.image_placeholder");
			else if (msgType === "voice" && !content) content = getInjectText("bots.voice_placeholder");
			else if (msgType === "video" && !content) content = getInjectText("bots.video_placeholder");
			else if (msgType === "file" && !content) content = fillInjectText("bots.file_placeholder", { name: msg.FileName || "" });
		}

		// 对外部非主人用户做安全处理
		if (!isBot && userId !== botConfig.OwnerUserName) {
			content = sanitizeExternalMessage(content, name, 'wecom');
		}

		// 下载媒体文件（图片/语音/视频/文件）
		const files = [];
		if (!isBot && msg.MediaId) {
			try {
				const buf = await downloadMedia(botConfig.corpId, botConfig.secret, msg.MediaId);
				let fileName = msg.FileName || "media";
				let mimeType = "application/octet-stream";
				if (msgType === "image") { fileName = msg.FileName || "image.jpg"; mimeType = "image/jpeg"; }
				else if (msgType === "voice") { fileName = `voice.${msg.Format || "amr"}`; mimeType = "audio/amr"; }
				else if (msgType === "video") { fileName = msg.FileName || "video.mp4"; mimeType = "video/mp4"; }
				files.push({ name: fileName, buffer: buf, mime_type: mimeType });
			} catch (e) {
				diag.warn(`wecomMsgToLogEntry: 下载媒体失败, MediaId="${msg.MediaId}": ${e.message}`);
			}
		}
		// PicUrl 图片直接下载（无需 media API）
		if (!isBot && msgType === "image" && msg.PicUrl && files.length === 0) {
			try {
				const buf = Buffer.from(await fetch(msg.PicUrl).then(r => r.arrayBuffer()));
				files.push({ name: "image.jpg", buffer: buf, mime_type: "image/jpeg" });
			} catch (e) {
				diag.warn(`wecomMsgToLogEntry: 下载 PicUrl 失败: ${e.message}`);
			}
		}

		return {
			time_stamp: Number(msg.CreateTime) * 1000 || Date.now(),
			role,
			name,
			content,
			files,
			// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
			_sourceType: "bot",
			...buildBotSourceMeta(botConfig, userId, !isBot && userId === botConfig.OwnerUserName),
			extension: { wecom_msg_id: msg.MsgId || "" },
		};
	}

	/**
	 * 合并连续同名同角色消息（3 分钟内）。
	 * @param {chatLogEntry_t_wecom[]} log - 日志数组。
	 * @returns {chatLogEntry_t_wecom[]}
	 */
	// T9：mergeChatLog 抽到 botContentShared.mjs（公共骨架）。wecom entry 带 files（用户图片/语音等媒体 buffer）
	// 和 extension.wecom_msg_id——原本地版是简化变体（无 files 守卫/不保留 extension 键），统一到完整版即
	// 修正 wecom 侧漏修的边界：带附件消息不再被错误吸并（保住 files），且合并保留 wecom_msg_id。
	const mergeChatLog = (log) => mergeChatLogShared(log, { mergeExtensionKeys: ["wecom_msg_id"] });

	/**
	 * 发送文本消息并处理分段。
	 * @param {string} userId - 接收方 userId。
	 * @param {string} text - 消息文本。
	 * @returns {Promise<void>}
	 */
	async function sendReply(userId, text) {
		if (!text?.trim()) return;
		const token = await getAccessToken(botConfig.corpId, botConfig.secret);
		const chunks = splitWecomMessage(text);
		for (const chunk of chunks) {
			await tryFewTimes(() =>
				sendTextMessage(token, botConfig.agentId, userId, chunk),
			);
		}
	}

	/**
	 * 发送文件/图片消息（先上传临时素材，再发送）。
	 * 失败时降级为文本提示。
	 * @param {string} userId - 接收方 userId。
	 * @param {{ name: string, buffer: Buffer, mime_type?: string }} file - 文件对象。
	 * @returns {Promise<void>}
	 */
	async function sendFileReply(userId, file) {
		const isImage = (file.mime_type || "").startsWith("image/");
		const isVoice = (file.mime_type || "").startsWith("audio/");
		const isVideo = (file.mime_type || "").startsWith("video/");
		const mediaType = isImage ? "image" : isVoice ? "voice" : isVideo ? "video" : "file";
		try {
			const mediaId = await uploadMedia(botConfig.corpId, botConfig.secret, file.buffer, file.name, mediaType);
			const token = await getAccessToken(botConfig.corpId, botConfig.secret);
			if (isImage) {
				await sendImageMessage(token, botConfig.agentId, userId, mediaId);
			} else {
				await sendFileMessage(token, botConfig.agentId, userId, mediaId);
			}
			diag.log(`sendFileReply: 发送成功, type="${mediaType}", file="${file.name}"`);
		} catch (e) {
			diag.warn(`sendFileReply: 发送失败, 降级为文本提示: ${e.message}`);
			const label = isImage ? `[图片: ${file.name}]` : `[文件: ${file.name}]`;
			await sendReply(userId, label);
		}
	}

	/**
	 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
	 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
	 * （GetPrompt H2 注入工作报告 consume-once）→ 应用推送 API（sendReply 本就是主动接口）发回委派发起会话。
	 * chatId 即发送目标（userId/groupId）。
	 */
	async function DoDelegateWakeReply(chatId) {
		if (!botConfig || !botConfig.corpId) {
			diag.warn(`DoDelegateWakeReply: botConfig 未就绪，放弃唤醒（报告等下轮注入）`);
			return;
		}
		// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
		await runExclusiveWakeSlot(_mq.handlers, chatId, async () => {
			try {
				const wakeRequest = async () => {
					// 与消息链同构：线 id 本轮取一次；深度就地取
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, "wecom");
					const _maxDepth = botConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
					return {
					supported_functions: { markdown: false, files: true, add_message: true },
					username: ownerUsername,
					// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
					chatid: _lineId,
					chat_name: `WeCom: ${chatId}`,
					char_id: botCharname,
					Charname: botCharname,
					UserCharname: botConfig.OwnerUserName || chatId,
					ReplyToCharname: botConfig.OwnerUserName || chatId,
					locales: localhostLocales,
					time: new Date(),
					world: null,
					user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
					char: charAPI,
					other_chars: [],
					plugins: allPlugins,
					chat_scoped_char_memory,
					// [0726 上下文换源] 与消息链同源，防唤醒轮与消息轮看到两份不同上下文
					chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: _maxDepth }))
						?? applyBotContentFilter((ChatLogs[chatId] || []).map((e) => ({ ...e })), ownerUsername),
					AddChatLogEntry: async (replyFromChar) => {
						if (replyFromChar?.content || replyFromChar?.files?.length) {
							const rawContent = replyFromChar.content_for_show || replyFromChar.content || "";
							const displayContent = extractPlatformContent(rawContent, "wecom");
							if (displayContent.trim()) await sendReply(chatId, displayContent);
							if (replyFromChar.files?.length) {
								for (const file of replyFromChar.files) {
									if (file?.buffer) await sendFileReply(chatId, file);
								}
							}
						}
						return null;
					},
					Update: wakeRequest,
					extension: { platform: "wecom", chat_id: chatId, delegate_wake: true },
					};
				};
				// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
				const _wakeReq = await wakeRequest();
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
				if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
					const displayContent = extractPlatformContent(rawContent, "wecom");
					pushMessageLog({
						type: "ai",
						chatId,
						author: botCharname,
						content: displayContent,
						fullContent: rawContent,
					});
					if (displayContent.trim()) await sendReply(chatId, displayContent);
					// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
					await appendBotChatEntry(_wakeReq.chatid, {
						role: "char", name: botCharname, charName: botCharname,
						content: aiFinalReply.content || "",
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`));
					if (aiFinalReply.files?.length) {
						for (const file of aiFinalReply.files) {
							if (file?.buffer) await sendFileReply(chatId, file);
						}
					}
				}
			} catch (error) {
				diag.error(`DoDelegateWakeReply: chat="${chatId}" 失败`, error);
				broadcastBotError({ username: ownerUsername, platform: 'wecombot', botname: botCharname, phase: 'runtime', error });
			}
		}, { onBusy: () => diag.warn(`DoDelegateWakeReply: chat="${chatId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
	}

	/**
	 * 处理单条触发消息，生成 AI 回复并发送。
	 * @param {object} msg - 企业微信消息对象。
	 * @param {string} chatId - 会话 ID（userId 或 groupId）。
	 * @returns {Promise<void>}
	 */
	async function doMessageReply(msg, chatId) {
		diag.time(`doMessageReply:${chatId}`);
		const fromUser = msg.FromUserName || "";
		const displayName = await getDisplayName(fromUser);

		diag.log(
			`doMessageReply: chatId="${chatId}", from="${fromUser}", name="${displayName}"`,
		);

		// 记录用户消息日志
		pushMessageLog({
			type: "user",
			chatId,
			author: displayName,
			content: msg.Content || "",
		});

		try {
			const MAX_DEPTH = botConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;

			// 构造用户日志条目并追加
			const userEntry = await wecomMsgToLogEntry(msg, false, displayName);
			if (!ChatLogs[chatId]) ChatLogs[chatId] = [];
			// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
			//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
			try {
				await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, "wecom"), {
					role: userEntry.role, name: userEntry.name, content: userEntry.content,
					files: userEntry.files, extension: userEntry.extension,
					...pickBotSourceMeta(userEntry),
				});
			} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
			ChatLogs[chatId].push(userEntry);
			ChatLogs[chatId] = mergeChatLog(ChatLogs[chatId]);
			while (ChatLogs[chatId].length > MAX_DEPTH) ChatLogs[chatId].shift();

			/**
			 * 生成聊天回复请求。
			 * @returns {Promise<object>}
			 */
			const generateChatReplyRequest = async () => {
				// 线 id 本轮取一次；深度就地取（MAX_DEPTH 在更外层块作用域，此处重算保证可达）
				const _lineId = await resolveBotChatId(ownerUsername, botCharname, "wecom");
				const _maxDepth = botConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
				return {
				supported_functions: {
					markdown: false, // 企业微信不支持 markdown
					files: true,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				chatid: _lineId,
				chat_name: `WeCom: ${displayName}`,
				char_id: botCharname,
				Charname: botCharname,
				UserCharname: botConfig.OwnerUserName || fromUser,
				ReplyToCharname: displayName,
				locales: localhostLocales,
				time: new Date(),
				world: null,
				user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
				char: charAPI,
				other_chars: [],
				plugins: allPlugins,
				chat_scoped_char_memory,
				// [0726 上下文换源] 优先取对话文件（与 web 正线 requestBuilder:142 同源）；?? 兜底壳内存
				chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: _maxDepth }))
					?? applyBotContentFilter(ChatLogs[chatId].map((e) => ({ ...e })), ownerUsername),
				AddChatLogEntry: async (replyFromChar) => {
					if (replyFromChar?.content || replyFromChar?.files?.length) {
						const rawContent = replyFromChar.content_for_show || replyFromChar.content || "";
						const displayContent = extractPlatformContent(rawContent, "wecom");
						if (displayContent.trim()) await sendReply(fromUser, displayContent);
						// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
						await appendBotChatEntry(chatRequest.chatid, {
							role: "char", name: botCharname, charName: botCharname,
							content: aiFinalReply.content || "",
							content_for_show: aiFinalReply.content_for_show,
							files: aiFinalReply.files || [],
						}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`));
						if (replyFromChar.files?.length) {
							for (const file of replyFromChar.files) {
								if (file?.buffer) await sendFileReply(fromUser, file);
							}
						}
					}
					return null;
				},
				Update: async () => await generateChatReplyRequest(),
				extension: {
					platform: "wecom",
					from_user: fromUser,
					chat_id: chatId,
					msg_id: msg.MsgId,
				},
				};
			};

			// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
			// 命中即回执并跳过 AI 生成）。owner 判定=入站归一侧 :158 同式（wecom OwnerUserName 承载 userId）。
			{
				const _cmdIsOwner = !!(botConfig.OwnerUserName && fromUser === botConfig.OwnerUserName);
				const _cmdReply = await handleBotChatCommand({
					username: ownerUsername,
					charName: botCharname,
					platform: "wecom",
					text: msg.Content || "",
					isOwner: _cmdIsOwner,
				});
				if (_cmdReply) {
					await sendReply(fromUser, _cmdReply);
					diag.timeEnd(`doMessageReply:${chatId}`);
					return;
				}
			}

			const chatRequest = await generateChatReplyRequest();
			const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest);

			if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
				const displayContent = extractPlatformContent(rawContent, "wecom");

				// 记录 AI 回复到消息日志
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
				pushMessageLog({
					type: "ai",
					chatId,
					author: botCharname,
					content: displayContent,
					thinking: thinkMatch ? thinkMatch[1].trim() : "",
					fullContent: rawContent,
				});

				// 追加 AI 回复到会话日志
				const aiEntry = {
					time_stamp: Date.now(),
					role: "char",
					name: botCharname,
					content: aiFinalReply.content || "",
					files: [],
					extension: { wecom_msg_id: "" },
				};
				ChatLogs[chatId].push(aiEntry);
				ChatLogs[chatId] = mergeChatLog(ChatLogs[chatId]);
				while (ChatLogs[chatId].length > MAX_DEPTH) ChatLogs[chatId].shift();

				// 发送文本
				if (displayContent.trim()) {
					await sendReply(fromUser, displayContent);
				}

				// 发送文件
				if (aiFinalReply.files?.length) {
					for (const file of aiFinalReply.files) {
						if (file?.buffer) await sendFileReply(fromUser, file);
					}
				}

				diag.log(
					`doMessageReply: 回复完成, chatId="${chatId}", 内容长度=${displayContent.length}`,
				);
			}

			diag.timeEnd(`doMessageReply:${chatId}`);
		} catch (error) {
			diag.error(`doMessageReply: chatId="${chatId}" 处理失败`, error);
			// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
			broadcastBotError({ username: ownerUsername, platform: "wecombot", botname: botCharname, phase: "runtime", error });
			pushMessageLog({
				type: "error",
				chatId,
				author: "System",
				content: `回复失败: ${error.message || "Unknown error"}`,
			});
			try {
				await sendReply(fromUser, `处理消息时发生错误: ${error.message || "未知错误"}`);
			} catch (sendErr) {
				diag.error(`doMessageReply: 发送错误回复也失败, chatId="${chatId}"`, sendErr);
			}
		}
		// 串行闸 _mq.handlers[chatId] 由队列所有者（件11 骨架 HandleMessageQueue）排空后统一释放：
		// doMessageReply 是队列内的单条处理单元，若在此提前 delete，队列仍在循环时锁被释放，
		// 同会话新消息会误判"无活动处理器"而启动第二个 handler → 两个处理器并发
		// 抢排同一 _mq.queues[chatId] + 交错读写 ChatLogs[chatId]（A 类重入竞态）。
	}


	// ---- 公开接口 ----

	return {
		/**
		 * 初始化，写入配置（由 bot.mjs 的 runBot 调用）。
		 * @param {object} config - 完整机器人配置。
		 */
		OnBotReady: async (config) => {
			botConfig = config;
			diag.log(`OnBotReady: corpId="${config.corpId}", agentId="${config.agentId}", char="${config.char}"`);
			// 注册委派回程唤醒。registerBotDelegateWaker 是同 key 替换语义（幂等），重入重复注册无害，不加守卫。
			registerBotDelegateWaker("wecom", ownerUsername, botCharname, async ({ channelId }) => {
				if (!channelId) return;
				await DoDelegateWakeReply(channelId);
			});
		},

		GetBotConfigTemplate: GetSimpleBotConfigTemplate,

		/**
		 * 处理来自 webhook 的消息（由 endpoints.mjs 调用）。
		 * @param {object} msg - 解析后的企业微信消息对象。
		 * @param {object} config - 机器人配置（endpoints 传入）。
		 * @returns {Promise<void>}
		 */
		handleMessage: async (msg, config) => {
			// 更新配置（以最新为准）
			botConfig = config;

			const fromUser = msg.FromUserName || "";
			const msgType = msg.MsgType || "";

			// 处理文本/图片/语音/视频/文件消息
			const supportedMsgTypes = new Set(["text", "image", "voice", "video", "file"]);
			if (!supportedMsgTypes.has(msgType)) {
				diag.debug(`handleMessage: 忽略不支持的消息类型 MsgType="${msgType}"`);
				return;
			}

			// 过滤 bot 自身消息（企业微信一般不会推送 bot 自己发的消息）
			if (fromUser === config.corpId) return;

			// ---- 触发判定（照 discord L426-463 / telegram L304-313 适配企业微信）----
			// 企业微信自建应用回调只有「成员→应用」私聊语义：无频道/@提及概念，
			// 故 discord 的 TriggerOnMention（@触发）/ TriggerChannels（频道白名单）无入站源。
			// 群聊字段为前向兼容：仅当回调真带群标识（ChatId/AppChatId）时才走群路径。
			const groupId = msg.ChatId || msg.AppChatId || "";
			const isGroup = !!groupId;
			const isPrivate = !isGroup; // 无群标识即视为私聊（成员 → 应用）

			// 会话 ID：群聊用群 ID，私聊用 userId
			const chatId = isGroup ? groupId : fromUser;

			// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实；
			// P4 旧键回退经 legacy 映射同收。企业微信无 @ 概念 → isMentioned 恒 false。
			const shouldReply = resolveBotTrigger({
				isDM: isPrivate,
				isMentioned: false,
				canGroupTrigger: isGroup,
				whitelistId: String(groupId),
				senderId: fromUser,
				isOwner: fromUser === config.OwnerUserName,
				isSelf: false, // :546 已按 corpId 过滤 bot 自身
				isFromBot: false,
			}, config, {
				legacy: { privateKey: 'TriggerOnPrivate', groupKey: 'TriggerOnGroup', whitelistKey: 'TriggerGroups' },
				diag,
			});
			if (!shouldReply) {
				diag.debug(
					`handleMessage: 未命中触发条件，跳过 (isPrivate=${isPrivate}, isGroup=${isGroup})`,
				);
				return;
			}

			// 入队+串行处理（件11 _mq.enqueue）
			_mq.enqueue(chatId, msg);
		},

		/**
		 * 清除所有会话上下文。
		 * @returns {{ clearedChannels: number }}
		 */
		ClearContext: () => {
			const count = Object.keys(ChatLogs).length;
			for (const key of Object.keys(ChatLogs)) delete ChatLogs[key];
			for (const key of Object.keys(chat_scoped_char_memory)) delete chat_scoped_char_memory[key];
			_msgLog.clear();
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文和消息日志`);
			return { clearedChannels: count };
		},

		/**
		 * 获取活跃会话列表。
		 * @returns {Array<{ chatId: string, messageCount: number }>}
		 */
		// [0716 链路归一] GetActiveChats→GetActiveChannels + chatId→channelId（discord 系统一契约，
		// 三层断链修复详注见 telegrambot 同位）。
		GetActiveChannels: () =>
			Object.entries(ChatLogs).map(([channelId, logs]) => ({
				channelId,
				messageCount: logs.length,
			})),

		/**
		 * 获取消息日志。
		 * @param {number} [since] - 只返回此时间戳之后的记录。
		 * @returns {{ logs: Array, maxSize: number }}
		 */
		GetMessageLog: (since) => _msgLog.get(since),

		/**
		 * 设置消息日志最大条数。
		 * @param {number} size - 最大条数（1-200）。
		 * @returns {{ maxSize: number }}
		 */
		SetMessageLogSize: (size) => _msgLog.setSize(size),
	};
}

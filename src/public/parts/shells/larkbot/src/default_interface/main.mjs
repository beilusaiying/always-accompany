import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";

import * as lark from "npm:@larksuiteoapi/node-sdk@^1.60.0";

import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'

import { formatLarkMessageContent, parseMentions, splitLarkReply } from "./tools.mjs";

const diag = createDiag("larkbot");

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "lark"、"discord"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag);
}

/** @typedef {import('../../../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../chat/decl/chatLog.ts').chatLogEntry_t} BeiluChatLogEntryBase */
/**
 * @typedef { (BeiluChatLogEntryBase & {
 *   extension?: {lark_message_id?: string, [key: string]: any}
 * })} chatLogEntry_t_lark
 */
/** @typedef {import('../../../../chat/decl/chatLog.ts').chatReply_t} ChatReply_t */

/**
 * 创建一个简单的飞书接口。
 * @param {CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含飞书接口方法的 Promise。
 */
export async function createSimpleLarkInterface(
	charAPI,
	ownerUsername,
	botCharname,
) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error(
			"charAPI.interfaces.chat.GetReply is required for SimpleLarkInterface.",
		);

	/**
	 * @returns {{appId: string, appSecret: string, OwnerUserName: string, MaxMessageDepth: number, PrivateChatEnabled: boolean, TriggerOnMention: boolean, TriggerOnMessage: boolean, TriggerChannels: string[]}} 配置模板
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			appId: "",
			appSecret: "",
			OwnerUserName: "",            // 飞书用户标识（open_id 或 user_id），用于安全身份识别（owner 原文直入）
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// ---- 触发模式配置（字段名与 discord/telegram Shell 对齐）----
			PrivateChatEnabled: true,     // 私聊模式：私聊（p2p）中用户说话即触发
			TriggerOnMention: true,       // @触发：群聊中被 @ 时回复
			TriggerOnMessage: false,      // 说话触发：白名单群聊中所有消息都回复
			TriggerChannels: [],          // 说话触发的群聊 chat_id 白名单（空=所有群）
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		};
	}

	// 提升到闭包级别，使 ClearContext 方法可以访问
	const ChatChatLogs = {}; // Record<chatId, chatLogEntry_t_lark[]>
	const chat_scoped_char_memory = {}; // AI 的上下文记忆

	// ---- 加载所有默认 plugin ----
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

	// 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）
	const _msgLog = createBotMessageLog();

	/** 向消息日志追加一条记录（T9 件2 薄适配） */
	const pushMessageLog = (entry) => _msgLog.push(entry);

	// 消息处理队列（每个 chatId 一个队列）
	// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared）——原逐字声明+入队三行式+
	// try/while/finally 纯删，本壳只保 lark 特异段 ProcessLarkQueueItem（单条处理；client/config/botOpenId
	// 由模块级 _client/_config/_botOpenId 取当前值，bindClient 后固定，与原入队时穿传语义等价）。
	const _mq = createMessageQueueRuntime({
		diag,
		processItem: ProcessLarkQueueItem,
	});

	// 用户信息缓存
	const userInfoCache = {}; // open_id → displayName

	// AI 回复对象缓存（messageId → ChatReply_t）
	const aiReplyObjectCache = {};

	// T9：MargeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架）。lark 平台差异=保留 lark_message_id。
	const MargeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: ["lark_message_id"] });

	/**
	 * 构建飞书消息的 chatLogEntry
	 * @param {object} eventData - im.message.receive_v1 事件数据
	 * @param {lark.Client} client - 飞书 client（用于下载图片等）
	 * @param {object} config - bot 配置
	 * @param {string} botOpenId - bot 自身的 open_id
	 * @returns {Promise<chatLogEntry_t_lark|null>}
	 */
	async function LarkMessageToBeiluChatLogEntry(eventData, client, config, botOpenId) {
		const msg = eventData.message;
		const sender = eventData.sender;
		const senderOpenId = sender?.sender_id?.open_id || "";
		const msgId = msg.message_id;
		const msgType = msg.message_type;

		// 获取发送者名称（缓存）
		if (!userInfoCache[senderOpenId]) {
			userInfoCache[senderOpenId] = sender?.sender_id?.user_id || senderOpenId;
		}
		const senderName = userInfoCache[senderOpenId];

		// 解析内容
		const textContent = formatLarkMessageContent(msg);

		// 下载图片附件
		const files = [];
		if (msgType === "image") {
			try {
				const rawContent = msg.content ? JSON.parse(msg.content) : {};
				const imageKey = rawContent.image_key;
				if (imageKey) {
					const resp = await tryFewTimes(() =>
						client.im.messageResource.get({
							path: { message_id: msgId, file_key: imageKey },
							params: { type: "image" },
						})
					);
					if (resp?.data) {
						// resp.data 是 ReadableStream 或 Buffer
						let buf;
						if (typeof resp.data.arrayBuffer === "function") {
							buf = Buffer.from(await resp.data.arrayBuffer());
						} else if (Buffer.isBuffer(resp.data)) {
							buf = resp.data;
						}
						if (buf) {
							files.push({
								name: `image_${imageKey}.jpg`,
								buffer: buf,
								mime_type: "image/jpeg",
								description: "",
							});
						}
					}
				}
			} catch (e) {
				diag.warn(`下载图片失败 msgId="${msgId}":`, e.message);
			}
		}

		const cachedAIReply = aiReplyObjectCache[msgId];
		const isBot = senderOpenId === botOpenId;
		const isOwner = config.OwnerUserName &&
			(senderOpenId === config.OwnerUserName ||
				sender?.sender_id?.user_id === config.OwnerUserName ||
				sender?.sender_id?.open_id === config.OwnerUserName);

		let finalContent;
		if (isBot) {
			finalContent = (cachedAIReply && cachedAIReply.content !== undefined)
				? cachedAIReply.content
				: textContent;
		} else if (isOwner) {
			finalContent = textContent;
		} else {
			finalContent = sanitizeExternalMessage(textContent, senderName, 'lark');
		}

		/** @type {chatLogEntry_t_lark} */
		const entry = {
			...cachedAIReply,
			time_stamp: msg.create_time ? parseInt(msg.create_time) : Date.now(),
			role: isBot ? "char" : (isOwner ? "user" : "char"),
			name: isBot ? (botCharname) : senderName,
			content: finalContent,
			files: files.filter(Boolean),
			// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
			_sourceType: "bot",
			...buildBotSourceMeta(config, senderOpenId, !!isOwner),
			extension: {
				...cachedAIReply?.extension,
				lark_message_id: msgId,
			},
		};
		if (cachedAIReply) delete aiReplyObjectCache[msgId];
		return entry;
	}

	/**
	 * 处理消息队列（串行，每个 chatId 一个）
	 * @param {string} chatId
	 * @param {lark.Client} client
	 * @param {object} config
	 * @param {string} botOpenId
	 */
	/**
	 * 处理单条队列消息（件11 processItem：转换→追加日志→触发判定→回复）。
	 * @param {object} eventData - im.message.receive_v1 事件数据。
	 * @param {string} chatId - 会话 ID。
	 * @returns {Promise<void>}
	 */
	async function ProcessLarkQueueItem(eventData, chatId) {
		const client = _client, config = _config, botOpenId = _botOpenId;
		// 初始化聊天日志（飞书不提供拉取历史消息的简易接口，初始为空）
		if (!ChatChatLogs[chatId]) {
			ChatChatLogs[chatId] = [];
		}

		const newEntry = await LarkMessageToBeiluChatLogEntry(eventData, client, config, botOpenId);
		if (!newEntry) return;
		// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
		//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
		try {
			await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, "lark"), {
				role: newEntry.role, name: newEntry.name, content: newEntry.content,
				files: newEntry.files, extension: newEntry.extension,
				...pickBotSourceMeta(newEntry),
			});
		} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
		ChatChatLogs[chatId].push(newEntry);
		ChatChatLogs[chatId] = MargeChatLog(ChatChatLogs[chatId]);
		const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
		while (ChatChatLogs[chatId].length > MAX_MESSAGE_DEPTH) {
			const removed = ChatChatLogs[chatId].shift();
			delete aiReplyObjectCache[removed?.extension?.lark_message_id];
		}

		// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实。
		const msg = eventData.message;
		const sender = eventData.sender;
		const senderOpenId = sender?.sender_id?.open_id || "";
		const shouldReply = resolveBotTrigger({
			isDM: msg.chat_type === "p2p",
			isMentioned: parseMentions(msg).some(m => m.open_id === botOpenId),
			canGroupTrigger: true, // lark 原语义：说话触发无会话类型门
			whitelistId: msg.chat_id,
			senderId: senderOpenId,
			isOwner: !!config.OwnerUserName &&
				(senderOpenId === config.OwnerUserName ||
					sender?.sender_id?.user_id === config.OwnerUserName ||
					sender?.sender_id?.open_id === config.OwnerUserName),
			isSelf: senderOpenId === botOpenId,
			isFromBot: false,
		}, config, { diag, logContext: `chatId="${chatId}"` });
		if (shouldReply) {
			await DoMessageReply(eventData, chatId, client, config, botOpenId);
		}
	}

	/**
	 * 执行消息回复
	 * @param {object} eventData - 事件数据
	 * @param {string} chatId
	 * @param {lark.Client} client
	 * @param {object} config
	 * @param {string} botOpenId
	 */
	/**
	 * 发送文本并缓存 AI 回复对象（接口级单源：DoMessageReply 与委派回程唤醒共用）。
	 * @param {object} client - Lark client。
	 * @param {string} chatId - 会话 ID。
	 * @param {string} text
	 * @param {ChatReply_t} [originalAIReply]
	 * @returns {Promise<string|null>} 发出的消息 ID
	 */
	async function sendTextAndCacheTo(client, chatId, text, originalAIReply) {
		try {
			const resp = await tryFewTimes(() =>
				client.im.message.create({
					data: {
						receive_id: chatId,
						msg_type: "text",
						content: JSON.stringify({ text }),
					},
					params: { receive_id_type: "chat_id" },
				})
			);
			const sentMsgId = resp?.data?.message_id;
			if (sentMsgId && originalAIReply) {
				aiReplyObjectCache[sentMsgId] = originalAIReply;
			}
			return sentMsgId || null;
		} catch (error) {
			diag.error(`sendTextAndCacheTo: 发送消息失败`, error);
			return null;
		}
	}

	/**
	 * 发送分割回复到指定会话（接口级单源，防散写）。
	 * @param {object} client - Lark client。
	 * @param {string} chatId - 会话 ID。
	 * @param {ChatReply_t} beiluReply
	 */
	async function sendSplitReplyTo(client, chatId, beiluReply) {
		const rawContent = beiluReply.content_for_show || beiluReply.content || "";
		const displayContent = extractPlatformContent(rawContent, "lark");
		const textChunks = splitLarkReply(displayContent);

		// 发送文本块
		for (let i = 0; i < textChunks.length; i++) {
			const isLast = i === textChunks.length - 1;
			await sendTextAndCacheTo(client, chatId, textChunks[i], isLast ? beiluReply : undefined);
		}

		// 发送图片文件（飞书图片需要先上传，此处简化：仅记录日志）
		if (beiluReply.files?.length) {
			for (const file of beiluReply.files) {
				if (file.mime_type?.startsWith("image/")) {
					try {
						// 上传图片
						const uploadResp = await tryFewTimes(() =>
							client.im.image.create({
								data: {
									image_type: "message",
									image: file.buffer,
								},
							})
						);
						const imageKey = uploadResp?.data?.image_key;
						if (imageKey) {
							await tryFewTimes(() =>
								client.im.message.create({
									data: {
										receive_id: chatId,
										msg_type: "image",
										content: JSON.stringify({ image_key: imageKey }),
									},
									params: { receive_id_type: "chat_id" },
								})
							);
						}
					} catch (e) {
						diag.warn(`发送图片失败:`, e.message);
					}
				}
			}
		}
	}

	/**
	 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
	 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
	 * （GetPrompt H2 注入工作报告 consume-once）→ _client 主动发回委派发起会话。
	 * 依赖 bindClient 已设 _client/_config（OnceClientReady），未绑定时跳过无害。
	 */
	async function DoDelegateWakeReply(chatId) {
		if (!_client || !_config) {
			diag.warn(`DoDelegateWakeReply: client 未绑定（bot 未就绪），放弃唤醒（报告等下轮注入）`);
			return;
		}
		// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
		await runExclusiveWakeSlot(_mq.handlers, chatId, async () => {
			try {
				const client = _client;
				const config = _config;
				const wakeRequest = async () => {
					// 与消息链同构：线 id 本轮取一次；深度就地取（MAX_MESSAGE_DEPTH 只在 ProcessLarkQueueItem 作用域内）
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, "lark");
					const _maxDepth = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
					return {
					supported_functions: { markdown: false, files: true, add_message: true },
					username: ownerUsername,
					// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
					chatid: _lineId,
					chat_name: `Lark: ${chatId}`,
					char_id: botCharname,
					Charname: botCharname,
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
					chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: _maxDepth }))
						?? applyBotContentFilter((ChatChatLogs[chatId] || []).map(e => ({ ...e })), ownerUsername),
					AddChatLogEntry: async (replyFromChar) => {
						if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
							await sendSplitReplyTo(client, chatId, replyFromChar);
						return null;
					},
					Update: wakeRequest,
					extension: { platform: "lark", chat_id: chatId, delegate_wake: true },
					};
				};
				// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
				const _wakeReq = await wakeRequest();
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
				if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
					pushMessageLog({
						type: "ai",
						chatId,
						author: botCharname,
						content: extractPlatformContent(rawContent, "lark"),
						fullContent: rawContent,
						files: aiFinalReply.files?.length || 0,
					});
					await sendSplitReplyTo(client, chatId, aiFinalReply);
					// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
					await appendBotChatEntry(_wakeReq.chatid, {
						role: "char", name: botCharname, charName: botCharname,
						content: aiFinalReply.content || "",
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`));
				}
			} catch (error) {
				diag.error(`DoDelegateWakeReply: chat="${chatId}" 失败`, error);
				broadcastBotError({ username: ownerUsername, platform: 'larkbot', botname: botCharname, phase: 'runtime', error });
			}
		}, { onBusy: () => diag.warn(`DoDelegateWakeReply: chat="${chatId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
	}

	async function DoMessageReply(eventData, chatId, client, config, botOpenId) {
		const msg = eventData.message;
		const sender = eventData.sender;
		const senderOpenId = sender?.sender_id?.open_id || "";
		const senderName = userInfoCache[senderOpenId] || senderOpenId;

		diag.time(`DoMessageReply:${msg.message_id}`);
		diag.log(
			`DoMessageReply: msgId="${msg.message_id}", chatId="${chatId}", sender="${senderName}"`,
		);

		// 发送函数已提升为接口级单源 sendSplitReplyTo（委派回程唤醒共用），薄包装零改调用点
		const sendSplitReply = (beiluReply) => sendSplitReplyTo(client, chatId, beiluReply);

		try {
			const AddChatLogEntry = async (replyFromChar) => {
				if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
					await sendSplitReply(replyFromChar);
				return null;
			};

			const generateChatReplyRequest = async () => {
				// 线 id 本轮取一次；深度就地取（MAX_MESSAGE_DEPTH 只在 ProcessLarkQueueItem 作用域内）
				const _lineId = await resolveBotChatId(ownerUsername, botCharname, "lark");
				const _maxDepth = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
				return {
				supported_functions: {
					markdown: false, // 飞书 text 类型不支持 markdown
					files: true,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				chatid: _lineId,
				chat_name: msg.chat_type === "p2p"
					? `Lark DM with ${senderName}`
					: `Lark Group: ${chatId}`,
				char_id: botCharname,
				Charname: botCharname,
				UserCharname: config.OwnerUserName || senderName,
				ReplyToCharname: senderName,
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
					?? applyBotContentFilter(ChatChatLogs[chatId].map(e => ({ ...e })), ownerUsername),
				AddChatLogEntry,
				Update: async () => await generateChatReplyRequest(),
				extension: {
					platform: "lark",
					trigger_message_id: msg.message_id,
					chat_id: chatId,
					chat_type: msg.chat_type,
					sender_open_id: senderOpenId,
				},
				};
			};

			// 记录用户消息到消息日志
			const userContent = formatLarkMessageContent(msg);
			pushMessageLog({
				type: "user",
				chatId,
				chatType: msg.chat_type,
				author: senderName,
				content: userContent,
				files: 0,
			});

			// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
			// 命中即回执并跳过 AI 生成）。owner 判定=入站归一侧 :179 同式（open_id/user_id 多形匹配 OwnerUserName）。
			{
				const _cmdIsOwner = !!(config.OwnerUserName &&
					(senderOpenId === config.OwnerUserName ||
						sender?.sender_id?.user_id === config.OwnerUserName ||
						sender?.sender_id?.open_id === config.OwnerUserName));
				const _cmdReply = await handleBotChatCommand({
					username: ownerUsername,
					charName: botCharname,
					platform: "lark",
					text: userContent || "",
					isOwner: _cmdIsOwner,
				});
				if (_cmdReply) {
					await sendTextAndCacheTo(client, chatId, _cmdReply, null);
					diag.timeEnd(`DoMessageReply:${msg.message_id}`);
					return;
				}
			}

			const chatRequest = await generateChatReplyRequest();
			const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest);

			if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
				diag.debug(
					`DoMessageReply: AI回复完成, 内容长度=${aiFinalReply.content?.length || 0}`,
				);
				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
				pushMessageLog({
					type: "ai",
					chatId,
					chatType: msg.chat_type,
					author: botCharname,
					content: extractPlatformContent(rawContent, "lark"),
					thinking: thinkMatch ? thinkMatch[1].trim() : "",
					fullContent: rawContent,
					files: aiFinalReply.files?.length || 0,
				});
				await sendSplitReply(aiFinalReply);
				// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: "char", name: botCharname, charName: botCharname,
					content: aiFinalReply.content || "",
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`));
			}
			diag.timeEnd(`DoMessageReply:${msg.message_id}`);
		} catch (error) {
			diag.error(`DoMessageReply: msgId="${msg.message_id}" 处理失败`, error);
			broadcastBotError({ username: ownerUsername, platform: 'larkbot', botname: botCharname, phase: 'runtime', error });
			pushMessageLog({
				type: "error",
				chatId,
				chatType: msg.chat_type,
				author: "System",
				content: `回复失败: ${error.message || "Unknown error"}`,
			});
			try {
				const errText = `抱歉，处理消息时发生错误: ${error.message || "Unknown error"}`;
				await client.im.message.create({
					data: {
						receive_id: chatId,
						msg_type: "text",
						content: JSON.stringify({ text: errText }),
					},
					params: { receive_id_type: "chat_id" },
				});
			} catch (sendError) {
				diag.error(`DoMessageReply: 发送错误回复也失败`, sendError);
			}
		}
	}

	// 构建事件分发器（在闭包外部，供 bot.mjs 使用）
	// 注意：eventDispatcher 需要在 client 构建之后 + 消息到来时知道 botOpenId
	// 我们在首次收到消息时通过查询自身信息确认 botOpenId
	let _client = null;
	let _config = null;
	let _botOpenId = null;

	/**
	 * 绑定 client 和 config（由 bot.mjs 的 OnceClientReady 调用）
	 */
	async function bindClient(client, config) {
		_client = client;
		_config = config;
		// 注册委派回程唤醒。registerBotDelegateWaker 是同 key 替换语义（幂等），startBot 重入重复注册无害，不加守卫。
		registerBotDelegateWaker("lark", ownerUsername, botCharname, async ({ channelId }) => {
			if (!channelId) return;
			await DoDelegateWakeReply(channelId);
		});
		// 获取 bot 自身 open_id。它是 @触发识别与自身消息过滤的判据——取失败回退空串会让
		// 这两个功能静默残废（群聊 @不触发/可能回自己），所以瞬断走 tryFewTimes 重试，
		// 仍失败则抛错让启动失败可见（诚实失败，不带残废身份上线）。
		const meResp = await tryFewTimes(() => client.bot.info.get());
		_botOpenId = meResp?.data?.bot?.open_id;
		if (!_botOpenId) throw new Error("bindClient: bot info 响应缺 open_id，无法建立自身身份");
		diag.log(`bindClient: bot open_id="${_botOpenId}"`);
	}

	/**
	 * 处理收到的飞书消息事件
	 * @param {object} data - im.message.receive_v1 事件数据
	 */
	async function onMessageReceive(data) {
		const chatId = data.message?.chat_id;
		if (!chatId) return;
		_mq.enqueue(chatId, data);
	}

	// 构建 EventDispatcher，供 bot.mjs 中 wsClient.start() 使用
	const eventDispatcher = new lark.EventDispatcher({}).register({
		"im.message.receive_v1": async (data) => {
			try {
				await onMessageReceive(data);
			} catch (e) {
				diag.error("im.message.receive_v1 处理异常:", e.message);
			}
		},
	});

	return {
		// bot.mjs 的 startBot 调用此方法绑定 client + config
		OnceClientReady: async (client, _wsClient, config) => {
			await bindClient(client, config);
		},
		GetBotConfigTemplate: GetSimpleBotConfigTemplate,
		// eventDispatcher 供 bot.mjs 的 wsClient.start() 使用
		_eventDispatcher: eventDispatcher,
		/**
		 * 清除所有会话的上下文
		 * @returns {{clearedChannels: number}}
		 */
		ClearContext: () => {
			const count = Object.keys(ChatChatLogs).length;
			for (const key of Object.keys(ChatChatLogs))
				delete ChatChatLogs[key];
			for (const key of Object.keys(chat_scoped_char_memory))
				delete chat_scoped_char_memory[key];
			_msgLog.clear();
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文和消息日志`);
			return { clearedChannels: count };
		},
		/**
		 * 获取当前活跃会话列表
		 * @returns {Array<{chatId: string, messageCount: number}>}
		 */
		// [0716 链路归一] GetActiveChats→GetActiveChannels + chatId→channelId（discord 系统一契约，
		// 三层断链修复详注见 telegrambot 同位）。
		GetActiveChannels: () => {
			return Object.entries(ChatChatLogs).map(([channelId, logs]) => ({
				channelId,
				messageCount: logs.length,
			}));
		},
		/**
		 * 获取消息日志
		 * @param {number} [since] - 只返回此时间戳之后的记录
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

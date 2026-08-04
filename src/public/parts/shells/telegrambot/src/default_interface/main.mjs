import { Buffer } from "node:buffer";
import { clearInterval, setInterval } from "node:timers";

import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, createBotStreamEditor, makeStreamGenerationOptions, shouldAbsorbBurst, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'
import { fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）

import {
	splitTelegramReply,
	getMessageFullContent,
	getUserDisplayName,
	getChatName,
} from "./tools.mjs";

const diag = createDiag("telegram");

function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag);
}

/**
 * 创建 Telegram 接口。
 * @param {import('../../../../../../decl/charAPI.ts').CharAPI_t} charAPI
 * @param {string} ownerUsername
 * @param {string} botCharname
 */
export async function createSimpleTelegramInterface(charAPI, ownerUsername, botCharname) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error("charAPI.interfaces.chat.GetReply is required for SimpleTelegramInterface.");

	function GetSimpleBotConfigTemplate() {
		return {
			OwnerUserName: "",
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// MaxFetchCount 已删（0716 病征5假可调项）：telegram Bot API 无拉历史接口，该字段系复制
			// discord 模板带入、全壳零消费——模板下发=前端渲染出永不生效的输入框。
			// P4 键名归一（discord 系统一命名，凛倾拍板「名字用discord系列」）：旧键
			// TriggerOnPrivate/TriggerOnGroupMessage/TriggerGroups 停发（dingtalk 0716 病征3先例——
			// 双发=前端模板驱动渲染出同语义双控件），读侧保留旧键回退以兼容存量配置。
			PrivateChatEnabled: true,
			TriggerOnMention: true,
			TriggerOnMessage: false,
			TriggerChannels: [],
			// 件13 流式回复（官方 editMessageText 滚动编辑,≥1.2s 节流;关=生成完一次性发送）
			StreamReplyEnabled: true,
			// 连发吸收（openclaw/LangBot 双实证形）：队列有后续时本条只入上下文由末条触发；命令/带附件消息不吸收
			BurstDebounceEnabled: false,
			OwnerUserId: "", // Telegram 用户数字 ID
			...withBotPermissionDefaults({}), // C6
		};
	}

	const ChatLogs = {};
	const chat_scoped_char_memory = {};

	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

	// 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）
	const _msgLog = createBotMessageLog();

	/** 向消息日志追加一条记录（T9 件2 薄适配） */
	const pushMessageLog = (entry) => _msgLog.push(entry);

	/** @type {import('npm:grammy').Bot} */
	let botInstance = null;

	async function TelegramBotMain(bot, config) {
		botInstance = bot;
		const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;

		// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared）——原逐字声明+入队三行式+
		// try/while/finally 纯删，本壳只保 telegram 特异段 ProcessTelegramQueueItem（单条处理）。
		const _mq = createMessageQueueRuntime({
			diag,
			processItem: ProcessTelegramQueueItem,
		});
		const aiReplyObjectCache = {};

		async function downloadFile(bot, fileId) {
			try {
				const file = await tryFewTimes(() => bot.api.getFile(fileId));
				const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
				const buffer = Buffer.from(
					await tryFewTimes(() => fetch(url).then((r) => r.arrayBuffer()))
				);
				const ext = file.file_path?.split('.').pop() || 'bin';
				const name = `${fileId.slice(-8)}.${ext}`;
				return { name, buffer, mime_type: guessMime(ext) };
			} catch (error) {
				diag.error(`下载文件 ${fileId} 失败`, error);
				return null;
			}
		}

		function guessMime(ext) {
			const map = {
				jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
				gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
				mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg',
				webm: 'video/webm', pdf: 'application/pdf',
			};
			return map[ext] || 'application/octet-stream';
		}

		async function TelegramMessageToBeiluEntry(msg) {
			const from = msg.from;
			const displayName = getUserDisplayName(from);
			const isBot = from?.id === bot.botInfo.id;
			const isOwner = (config.OwnerUserId && String(from?.id) === String(config.OwnerUserId)) || from?.username === config.OwnerUserName;

			let content = msg.text || msg.caption || '';

			if (msg.reply_to_message) {
				const ref = msg.reply_to_message;
				const refAuthor = getUserDisplayName(ref.from);
				const refText = ref.text || ref.caption || '';
				if (refText)
					content = `${fillInjectText("bots.reply_quote_with_text", { author: refAuthor, text: refText.slice(0, 200) })}\n${content}`;
			}

			if (msg.forward_from || msg.forward_from_chat) {
				const fwdName = msg.forward_from
					? getUserDisplayName(msg.forward_from)
					: msg.forward_from_chat?.title || '未知';
				content = `（转发自 ${fwdName}）\n${content}`;
			}

			const files = [];
			const photoSizes = msg.photo;
			if (photoSizes?.length) {
				const largest = photoSizes[photoSizes.length - 1];
				const file = await downloadFile(bot, largest.file_id);
				if (file) files.push(file);
			}
			if (msg.document) {
				const file = await downloadFile(bot, msg.document.file_id);
				if (file) {
					file.name = msg.document.file_name || file.name;
					file.mime_type = msg.document.mime_type || file.mime_type;
					files.push(file);
				}
			}
			if (msg.voice) {
				const file = await downloadFile(bot, msg.voice.file_id);
				if (file) { file.name = 'voice.ogg'; file.mime_type = 'audio/ogg'; files.push(file); }
			}
			if (msg.audio) {
				const file = await downloadFile(bot, msg.audio.file_id);
				if (file) {
					file.name = msg.audio.file_name || 'audio.mp3';
					file.mime_type = msg.audio.mime_type || 'audio/mpeg';
					files.push(file);
				}
			}
			if (msg.video) {
				const file = await downloadFile(bot, msg.video.file_id);
				if (file) {
					file.name = msg.video.file_name || 'video.mp4';
					file.mime_type = msg.video.mime_type || 'video/mp4';
					files.push(file);
				}
			}
			if (msg.sticker) {
				if (!msg.sticker.is_animated && !msg.sticker.is_video) {
					const file = await downloadFile(bot, msg.sticker.file_id);
					if (file) { file.name = 'sticker.webp'; file.mime_type = 'image/webp'; files.push(file); }
				}
				if (!content) content = `[贴纸: ${msg.sticker.emoji || ''}]`;
			}

			let _finalContent;
			const cachedAIReply = aiReplyObjectCache[msg.message_id];
			if (isBot) {
				_finalContent = (cachedAIReply && cachedAIReply.content !== undefined) ? cachedAIReply.content : content;
			} else if (isOwner) {
				_finalContent = content;
			} else {
				_finalContent = sanitizeExternalMessage(content, displayName, 'telegram');
			}

			const entry = {
				...cachedAIReply,
				time_stamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
				role: isBot ? "char" : (isOwner ? "user" : "char"),
				name: isBot ? (bot.botInfo.first_name || bot.botInfo.username) : displayName,
				content: _finalContent,
				files: files.filter(Boolean),
				_sourceType: "bot",
				...buildBotSourceMeta(config, from?.id, isOwner),
				extension: {
					...cachedAIReply?.extension,
					telegram_message_id: msg.message_id,
				},
			};
			if (cachedAIReply) delete aiReplyObjectCache[msg.message_id];

			return entry;
		}

		// T9：MergeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架）。telegram 平台差异=保留 telegram_message_id。
		const MergeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: ["telegram_message_id"] });

		/**
		 * 处理单条队列消息（件11 processItem：转换→追加日志→触发判定→回复）。
		 * @param {object} currentMsg - Telegram 消息对象。
		 * @param {string} chatId - chat ID。
		 * @returns {Promise<void>}
		 */
		async function ProcessTelegramQueueItem(currentMsg, chatId, meta) {
			if (!ChatLogs[chatId])
				ChatLogs[chatId] = [];

			const newEntry = await TelegramMessageToBeiluEntry(currentMsg);
			if (!newEntry) return;
			// [0726 上下文换源] 每条平台消息落对话文件——上下文载体从壳内存改为对话文件（凛倾
			//   「对话文件直接上下文注入」）。必须在构建请求**之前**落，否则本轮 chat_log 缺当前这条。
			//   fire-and-forget 不阻断平台回复；写失败=本轮退化用壳内存（下方 chat_log 有 ?? 兜底）。
			//   _sourceType/_permissionLevel 一并带上：N42 档位门取尾条判定，见 chatOps.appendBotChatEntry。
			try {
				await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, "telegram"), {
					role: newEntry.role, name: newEntry.name, content: newEntry.content,
					files: newEntry.files, extension: newEntry.extension,
					...pickBotSourceMeta(newEntry),
				});
			} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
			ChatLogs[chatId].push(newEntry);
			ChatLogs[chatId] = MergeChatLog(ChatLogs[chatId]);
			while (ChatLogs[chatId].length > MAX_MESSAGE_DEPTH) {
				const removed = ChatLogs[chatId].shift();
				delete aiReplyObjectCache[removed?.extension?.telegram_message_id];
			}

			// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实；
			// P4 旧键回退经 legacy 映射同收（TriggerOnPrivate/TriggerOnGroupMessage/TriggerGroups）。
			const shouldReply = resolveBotTrigger({
				isDM: currentMsg.chat.type === 'private',
				isMentioned: currentMsg.entities?.some(e =>
					e.type === 'mention' &&
					currentMsg.text?.substring(e.offset, e.offset + e.length) === `@${bot.botInfo.username}`
				) || currentMsg.reply_to_message?.from?.id === bot.botInfo.id,
				// telegram 说话触发限群域（channel 帖子不触发，平台会话类型语义）
				canGroupTrigger: currentMsg.chat.type === 'group' || currentMsg.chat.type === 'supergroup',
				whitelistId: String(currentMsg.chat.id),
				senderId: currentMsg.from?.id,
				isOwner: (config.OwnerUserId && String(currentMsg.from?.id) === String(config.OwnerUserId)) || currentMsg.from?.username === config.OwnerUserName,
				isSelf: currentMsg.from?.id === bot.botInfo.id,
				isFromBot: !!currentMsg.from?.is_bot,
			}, config, {
				legacy: { privateKey: 'TriggerOnPrivate', groupKey: 'TriggerOnGroupMessage', whitelistKey: 'TriggerGroups' },
				diag,
			});
			// #9 连发吸收（判定单源 shouldAbsorbBurst：开关/命令/媒体三不合并;吸收=只入上下文由末条触发）
			if (shouldReply && shouldAbsorbBurst({
				config, pending: meta?.pending,
				text: currentMsg.text || currentMsg.caption,
				hasMedia: !!(currentMsg.photo?.length || currentMsg.document || currentMsg.audio || currentMsg.video || currentMsg.voice),
			})) {
				diag.debug(`ProcessTelegramQueueItem: 连发吸收，跳过本条生成（pending=${meta.pending}）`);
				return;
			}
			if (shouldReply)
				await DoMessageReply(currentMsg, chatId);
		}

		/**
		 * 发送分割回复到指定 chat（闭包级单源：DoMessageReply 与委派回程唤醒共用，防散写）。
		 * @param {string} chatId - Telegram chat id。
		 * @param {ChatReply_t} beiluReply - beilu 聊天回复对象。
		 */
		async function sendSplitReplyTo(chatId, beiluReply, stream) {
			const rawContent = beiluReply.content_for_show || beiluReply.content || "";
			const displayContent = extractPlatformContent(rawContent, "telegram");
			const textChunks = splitTelegramReply(displayContent);

			const filesToSend = (beiluReply.files || []).filter(f => f.buffer);

			// 件13：流式预览已投递首段时，finalize 把预览消息编辑为最终首段并跳过首段发送；
			// finalize 返回 null=全量降级（预览从未投递/编辑失败），照原路径完整发送。
			let startIdx = 0;
			if (stream) {
				const _mid = await stream.finalize(textChunks[0] || "");
				if (_mid != null && textChunks.length) {
					startIdx = 1;
					if (textChunks.length === 1 && !filesToSend.length)
						aiReplyObjectCache[_mid] = beiluReply;
				}
			}

			if (!textChunks.length && !filesToSend.length) return;

			for (let i = startIdx; i < textChunks.length; i++) {
				try {
					const sent = await tryFewTimes(() =>
						bot.api.sendMessage(chatId, textChunks[i])
					);
					if (i === textChunks.length - 1 && !filesToSend.length)
						aiReplyObjectCache[sent.message_id] = beiluReply;
				} catch (error) {
					diag.error(`发送文本消息失败`, error);
				}
			}

			for (let i = 0; i < filesToSend.length; i++) {
				try {
					const file = filesToSend[i];
					const inputFile = new (await import("npm:grammy@^1.35.0")).InputFile(file.buffer, file.name);
					let sent;
					if (file.mime_type?.startsWith('image/'))
						sent = await tryFewTimes(() => bot.api.sendPhoto(chatId, inputFile));
					else if (file.mime_type?.startsWith('audio/'))
						sent = await tryFewTimes(() => bot.api.sendAudio(chatId, inputFile));
					else if (file.mime_type?.startsWith('video/'))
						sent = await tryFewTimes(() => bot.api.sendVideo(chatId, inputFile));
					else
						sent = await tryFewTimes(() => bot.api.sendDocument(chatId, inputFile));

					if (i === filesToSend.length - 1)
						aiReplyObjectCache[sent.message_id] = beiluReply;
				} catch (error) {
					diag.error(`发送文件失败: ${filesToSend[i].name}`, error);
				}
			}
		}

		/**
		 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
		 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
		 * （GetPrompt H2 注入工作报告 consume-once）→ 发回委派发起 chat。
		 * 串行闸复用件11 _mq.handlers 槽，与用户消息处理互斥。
		 */
		async function DoDelegateWakeReply(chatId) {
			// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
			await runExclusiveWakeSlot(_mq.handlers, chatId, async () => {
				try {
					const chat = await tryFewTimes(() => bot.api.getChat(chatId));
					const chatName = getChatName(chat);
					const wakeRequest = async () => {
						// 与消息链同构：线 id 本轮取一次，chatid 与 chat_log 读源共用。
						const _lineId = await resolveBotChatId(ownerUsername, botCharname, "telegram");
						return {
						supported_functions: { markdown: true, files: true, add_message: true },
						username: ownerUsername,
						// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
						chatid: _lineId,
						chat_name: chatName,
						char_id: botCharname,
						Charname: bot.botInfo.first_name || bot.botInfo.username,
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
							?? applyBotContentFilter((ChatLogs[chatId] || []).map((e) => ({ ...e })), ownerUsername),
						AddChatLogEntry: async (replyFromChar) => {
							if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
								await sendSplitReplyTo(chatId, replyFromChar);
							return null;
						},
						Update: wakeRequest,
						extension: { platform: "telegram", chat_id: chatId, delegate_wake: true },
						};
					};
					// 接住请求对象（同 discordbot 唤醒轮 _wakeReq 范式）：落盘需要本轮 chatid
					const _wakeReq = await wakeRequest();
					const aiReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
					if (aiReply && (aiReply.content || aiReply.files?.length)) {
						const rawContent = aiReply.content_for_show || aiReply.content || "";
						pushMessageLog({
							type: "ai",
							chatId: String(chatId),
							chatName,
							author: bot.botInfo.first_name || bot.botInfo.username,
							content: extractPlatformContent(rawContent, "telegram"),
							fullContent: rawContent,
							files: aiReply.files?.length || 0,
						});
						await sendSplitReplyTo(chatId, aiReply);
						// [0726 上下文换源] 唤醒轮回复同样落盘（与消息轮同构，防两轮上下文分叉）
						await appendBotChatEntry(_wakeReq.chatid, {
							role: "char",
							name: bot.botInfo.first_name || bot.botInfo.username,
							charName: botCharname,
							content: aiReply.content || "",
							content_for_show: aiReply.content_for_show,
							files: aiReply.files || [],
						}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`));
					}
				} catch (error) {
					diag.error(`DoDelegateWakeReply: chat="${chatId}" 失败`, error);
					broadcastBotError({ username: ownerUsername, platform: 'telegrambot', botname: botCharname, phase: 'runtime', error });
				}
			}, { onBusy: () => diag.warn(`DoDelegateWakeReply: chat="${chatId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
		}

		// 注册委派回程唤醒（不显式注销：bot 停机后回调抛错由 notify 侧自愈摘除）
		registerBotDelegateWaker("telegram", ownerUsername, botCharname, async ({ channelId }) => {
			if (!channelId) return;
			await DoDelegateWakeReply(channelId);
		});

		async function DoMessageReply(triggerMsg, chatId) {
			diag.time(`DoMessageReply:${triggerMsg.message_id}`);
			diag.log(`DoMessageReply: msgId="${triggerMsg.message_id}", chat="${chatId}"`);

			let typingInterval = setInterval(() => {
				bot.api.sendChatAction(chatId, "typing").catch(() => 0);
			}, 4000).unref();

			// 发送函数已提升为闭包级单源 sendSplitReplyTo（委派回程唤醒共用），薄包装零改调用点
			const sendSplitReply = (beiluReply) => sendSplitReplyTo(chatId, beiluReply);

			// 件13：流式回复编辑器（生成侧走既有 generation_options.replyPreviewUpdater 链；
			// 官方 editMessageText 滚动编辑,4096=官方单条上限,1.2s 节流对齐官方编辑限速）。
			// 命令回执 early-return 在编辑器创建前不受影响；失败=骨架内置死+全量降级。
			let _stream = null;

			try {
				const AddChatLogEntry = async (replyFromChar) => {
					if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
						await sendSplitReply(replyFromChar);
					return null;
				};

				const chatName = getChatName(triggerMsg.chat);

				const generateChatReplyRequest = async () => {
					// 线 id 本轮取一次：chatid 字段与 chat_log 读源共用，避免同一请求解析两遍。
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, "telegram");
					return {
					supported_functions: { markdown: true, files: true, add_message: true },
					username: ownerUsername,
					// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
					// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
					chatid: _lineId,
					chat_name: chatName,
					char_id: botCharname,
					Charname: bot.botInfo.first_name || bot.botInfo.username,
					UserCharname: config.OwnerUserName,
					ReplyToCharname: getUserDisplayName(triggerMsg.from),
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
						?? applyBotContentFilter(ChatLogs[chatId].map((e) => ({ ...e })), ownerUsername),
					AddChatLogEntry,
					// 件13：流式预览回调（构造单源 makeStreamGenerationOptions,编辑时序由骨架泵串行化）
					generation_options: makeStreamGenerationOptions(_stream, "telegram"),
					Update: async () => await generateChatReplyRequest(),
					extension: {
						platform: "telegram",
						trigger_message_id: triggerMsg.message_id,
						chat_id: chatId,
					},
					};
				};

				pushMessageLog({
					type: "user",
					chatId: String(chatId),
					chatName,
					author: getUserDisplayName(triggerMsg.from),
					content: triggerMsg.text || triggerMsg.caption || '',
					files: (triggerMsg.photo?.length ? 1 : 0) + (triggerMsg.document ? 1 : 0),
				});

				// !chat/!skill 对话线管理命令（0716 推全壳：07-09 拍板「命令词单源改 BOT_CHAT_COMMAND_PREFIX
				// 即全平台生效」而实现仅 discord 接线=半接线）。命中即回执并【跳过 AI 生成】；与 web 面板
				// 切换器同一指针权威（bot_chat_bindings）。在件11 _mq 串行队列内 await（时序：命令
				// 生效顺序与消息顺序一致，禁 fire-and-forget）；早 return 走 :472 finally 清 typingInterval。
				{
					const _cmdIsOwner = (config.OwnerUserId && String(triggerMsg.from?.id) === String(config.OwnerUserId)) || triggerMsg.from?.username === config.OwnerUserName;
					const _cmdReply = await handleBotChatCommand({
						username: ownerUsername,
						charName: botCharname,
						platform: "telegram",
						text: triggerMsg.text || triggerMsg.caption || "",
						isOwner: _cmdIsOwner,
					});
					if (_cmdReply) {
						await bot.api.sendMessage(chatId, _cmdReply);
						diag.timeEnd(`DoMessageReply:${triggerMsg.message_id}`);
						return;
					}
				}

				// 件13：命令回执已 early-return，此处才进 AI 生成=创建流式编辑器（StreamReplyEnabled 可关）
				if (config.StreamReplyEnabled !== false)
					_stream = createBotStreamEditor({
						diag,
						maxLen: 4096, // 官方单条消息上限
						minIntervalMs: 1200, // 官方编辑限速安全间隔（≥1s）
						sendInitial: async (text) => (await tryFewTimes(() => bot.api.sendMessage(chatId, text))).message_id,
						editMessage: async (mid, text) => { await tryFewTimes(() => bot.api.editMessageText(chatId, mid, text)); },
					});

				const chatRequest = await generateChatReplyRequest();
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest);

				if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
					const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
					pushMessageLog({
						type: "ai",
						chatId: String(chatId),
						chatName,
						author: bot.botInfo.first_name || bot.botInfo.username,
						content: extractPlatformContent(rawContent, "telegram"),
						thinking: thinkMatch ? thinkMatch[1].trim() : "",
						fullContent: rawContent,
						files: aiFinalReply.files?.length || 0,
					});
					await sendSplitReplyTo(chatId, aiFinalReply, _stream);
					// [0726 上下文换源] AI 回复同样落对话文件——否则文件里只有用户消息，
					//   换源后 AI 看不到自己上一轮说过什么（比原壳内存更糟）。fire-and-forget 不阻断平台发送。
					await appendBotChatEntry(chatRequest.chatid, {
						role: "char",
						name: bot.botInfo.first_name || bot.botInfo.username,
						charName: botCharname,
						content: aiFinalReply.content || "",
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`));
				}
				diag.timeEnd(`DoMessageReply:${triggerMsg.message_id}`);
			} catch (error) {
				diag.error(`DoMessageReply: chat="${chatId}" 处理失败`, error);
				// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
				broadcastBotError({ username: ownerUsername, platform: 'telegrambot', botname: botCharname, phase: 'runtime', error })
				pushMessageLog({
					type: "error",
					chatId: String(chatId),
					chatName: getChatName(triggerMsg.chat),
					author: "System",
					content: `回复失败: ${error.message || "Unknown error"}`,
				});
				try {
					await bot.api.sendMessage(chatId,
						fillInjectText("bots.error_reply", { error: (error.message || "Unknown error").slice(0, 200) })
					);
				} catch (sendError) {
					diag.error(`发送错误回复也失败`, sendError);
				}
			} finally {
				if (typingInterval) clearInterval(typingInterval);
				typingInterval = null;
			}
		}

		bot.on("message", async (ctx) => {
			const msg = ctx.message;
			if (!msg) return;
			const chatId = String(msg.chat.id);
			_mq.enqueue(chatId, msg);
		});

		bot.on("edited_message", async (ctx) => {
			const msg = ctx.editedMessage;
			if (!msg) return;
			const chatId = String(msg.chat.id);
			const chatLogs = ChatLogs[chatId];
			if (!chatLogs) return;

			try {
				const beiluEntry = await TelegramMessageToBeiluEntry(msg);
				if (!beiluEntry) return;
				const existingIndex = chatLogs.findIndex(
					(entry) => entry.extension?.telegram_message_id === msg.message_id
				);
				if (existingIndex >= 0) {
					chatLogs[existingIndex] = beiluEntry;
					ChatLogs[chatId] = MergeChatLog(chatLogs);
				}
			} catch (error) {
				diag.error(`edited_message 处理失败`, error);
			}
		});
	}

	return {
		OnBotReady: TelegramBotMain,
		GetBotConfigTemplate: GetSimpleBotConfigTemplate,
		ClearContext: () => {
			const count = Object.keys(ChatLogs).length;
			for (const key of Object.keys(ChatLogs)) delete ChatLogs[key];
			for (const key of Object.keys(chat_scoped_char_memory)) delete chat_scoped_char_memory[key];
			_msgLog.clear();
			diag.log(`ClearContext: 已清除 ${count} 个聊天的上下文和消息日志`);
			return { clearedChannels: count };
		},
		// [0716 链路归一] GetActiveChats→GetActiveChannels + chatId→channelId（凛倾拍板 discord 系）：
		// 三层断链确诊——前端拼 /activechannels(旧端点 activechats=404)、统一 handler 调 GetActiveChannels
		//（旧名=undefined 恒空集）、前端读 c.channelId??c.id（旧字段 chatId 双落空=显示空串）。
		// 端点已由件8 统一，此处补齐方法名+契约字段（channelId 语义=平台会话标识）。
		GetActiveChannels: () => {
			return Object.entries(ChatLogs).map(([channelId, logs]) => ({
				channelId,
				messageCount: logs.length,
			}));
		},
		GetMessageLog: (since) => _msgLog.get(since),
		SetMessageLogSize: (size) => _msgLog.setSize(size),
	};
}

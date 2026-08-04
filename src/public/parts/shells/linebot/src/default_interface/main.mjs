import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from "../../../botErrorBroadcast.mjs";
import { fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）

import {
	extractLineTextContent,
	getLineSessionId,
	splitLineReply,
} from "./tools.mjs";

import { storeTempFile } from "../endpoints.mjs";

const diag = createDiag("linebot");

/** @typedef {import('../../../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签。
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "line"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag);
}

/**
 * 创建一个简单的 LINE 接口。
 * @param {CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名（beilu 用户名）。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含 LINE 接口方法的 Promise。
 */
export async function createSimpleLineInterface(
	charAPI,
	ownerUsername,
	botCharname,
) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error(
			"charAPI.interfaces.chat.GetReply is required for SimpleLineInterface.",
		);

	/**
	 * @returns {object} 简单机器人配置模板
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			channelAccessToken: "",
			channelSecret: "",
			OwnerUserName: "",
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// P4 键名归一（discord 系统一命名）：旧键 TriggerOnPrivate/TriggerOnGroup/TriggerGroups 停发
			//（dingtalk 0716 病征3先例），读侧保留旧键回退以兼容存量配置。
			PrivateChatEnabled: true,
			TriggerOnMention: true,
			TriggerOnMessage: false,
			TriggerChannels: [],
			// 公网基础 URL（如 ngrok / cloudflare tunnel），用于向 LINE 发送文件/图片
			// 示例: "https://xxxx.ngrok.io" 或 "https://yourdomain.com"
			// 留空则文件降级为纯文本提示
			publicBaseUrl: "",
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		};
	}

	// ---- 状态 ----
	const SessionChatLogs = {}; // Record<sessionId, chatLogEntry[]>
	const chat_scoped_char_memory = {};

	// ---- 消息队列（每个 session 一个队列，串行处理） ----
	// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared，命名统一 discord 系:原
	// SessionQueues/SessionHandlers/HandleSessionQueue 三元组纯删）——本壳只保 line 特异段
	// ProcessLineQueueItem（单条处理；会话键=sessionId,骨架形参名 channelId 仅为统一签名）。
	const _mq = createMessageQueueRuntime({
		diag,
		processItem: ProcessLineQueueItem,
	});

	// 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）
	const _msgLog = createBotMessageLog();

	// ---- 加载所有默认 plugin ----
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

	// 当前 bot 配置和 LINE client（通过 OnBotReady 注入）
	let _client = null;
	let _config = null;

	/** 向消息日志追加一条记录（T9 件2 薄适配） */
	const pushMessageLog = (entry) => _msgLog.push(entry);

	// LINE 消息类型 → MIME 类型映射（用于下载二进制内容）
	const LINE_MEDIA_MIME = {
		image: "image/jpeg",
		video: "video/mp4",
		audio: "audio/m4a",
	};

	/**
	 * 下载 LINE 媒体消息内容，返回 { name, buffer, mime_type } 或 null。
	 * @param {object} message - LINE message 对象
	 * @returns {Promise<{name: string, buffer: Buffer, mime_type: string}|null>}
	 */
	async function downloadLineMediaContent(message) {
		if (!_client) return null;
		const mediaTypes = ["image", "video", "audio", "file"];
		if (!mediaTypes.includes(message.type)) return null;

		try {
			const stream = await _client.getMessageContent(message.id);
			const chunks = [];
			for await (const chunk of stream) chunks.push(chunk);
			const buffer = Buffer.concat(chunks);

			let mime_type = LINE_MEDIA_MIME[message.type] || "application/octet-stream";
			let name;
			if (message.type === "file") {
				name = message.fileName || `file_${message.id}`;
				// LINE file 消息无 mime 字段，依文件名后缀推断（见下方 extMimeMap）
				if (message.fileName) {
					const ext = message.fileName.split(".").pop()?.toLowerCase();
					const extMimeMap = {
						pdf: "application/pdf",
						png: "image/png",
						jpg: "image/jpeg",
						jpeg: "image/jpeg",
						gif: "image/gif",
						webp: "image/webp",
						mp4: "video/mp4",
						mp3: "audio/mpeg",
						m4a: "audio/m4a",
						txt: "text/plain",
						zip: "application/zip",
					};
					if (ext && extMimeMap[ext]) mime_type = extMimeMap[ext];
				}
			} else if (message.type === "image") {
				name = `image_${message.id}.jpg`;
			} else if (message.type === "video") {
				name = `video_${message.id}.mp4`;
			} else if (message.type === "audio") {
				name = `audio_${message.id}.m4a`;
			} else {
				name = `file_${message.id}`;
			}

			return { name, buffer, mime_type };
		} catch (e) {
			diag.warn(`downloadLineMediaContent: 下载失败 msgId=${message.id}`, e.message);
			return null;
		}
	}

	/**
	 * 将 LINE event 转换为 beilu chatLogEntry 格式。
	 * @param {object} event - LINE webhook event
	 * @param {string} sessionId - 会话 ID
	 * @returns {Promise<object|null>} beilu chatLogEntry
	 */
	async function lineEventToBeiluEntry(event, sessionId) {
		if (!event.source) return null;

		const textContent = extractLineTextContent(event);
		if (!textContent) return null;

		const userId = event.source.userId || "unknown";
		const isOwner = _config?.OwnerUserName && userId === _config.OwnerUserName;

		let finalContent;
		if (isOwner) {
			finalContent = textContent;
		} else {
			finalContent = sanitizeExternalMessage(textContent, userId, 'line');
		}

		// 下载媒体内容（image/video/audio/file）
		const files = [];
		const message = event.message;
		if (message && ["image", "video", "audio", "file"].includes(message.type)) {
			const mediaFile = await downloadLineMediaContent(message);
			if (mediaFile) files.push(mediaFile);
		}

		return {
			time_stamp: event.timestamp || Date.now(),
			role: isOwner ? "user" : "char",
			name: userId,
			content: finalContent,
			files,
			// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
			_sourceType: "bot",
			...buildBotSourceMeta(_config, userId, !!isOwner),
			extension: {
				line_session_id: sessionId,
				line_user_id: userId,
				line_source_type: event.source.type,
				line_reply_token: event.replyToken,
			},
		};
	}

	// T9：MargeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架）。line entry 不带 files 字段，
	// 且本地版原不保留平台 extension 键 → mergeExtensionKeys 空数组，与原逻辑严格等价。
	const MargeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: [] });

	/**
	 * 判断此事件是否应该触发 AI 回复。
	 * @param {object} event - LINE webhook event
	 * @param {string} sessionId - 会话 ID
	 * @returns {boolean}
	 */
	/**
	 * 判断此事件是否应该触发 AI 回复（件12：判定收单源 resolveBotTrigger，本函数只采集平台事实；
	 * P4 旧键回退经 legacy 映射同收）。
	 * @param {object} event - LINE webhook event
	 * @param {string} sessionId - 会话 ID
	 * @returns {boolean}
	 */
	function shouldTriggerReply(event, sessionId) {
		if (!_config) return false;
		const sourceType = event.source?.type;
		const isGroupish = sourceType === "group" || sourceType === "room";
		const mentionees = event.message?.mention?.mentionees || [];
		const _lineUserId = event.source?.userId || "unknown";
		return resolveBotTrigger({
			isDM: sourceType === "user",
			isMentioned: isGroupish && mentionees.some((m) => m.type === "user" && m.isSelf),
			canGroupTrigger: isGroupish, // LINE 说话触发限 group/room 域（平台会话类型语义）
			whitelistId: event.source.groupId || event.source.roomId,
			senderId: _lineUserId,
			isOwner: !!_config?.OwnerUserName && _lineUserId === _config.OwnerUserName,
			isSelf: false, // LINE webhook 不推送 bot 自身消息
			isFromBot: false,
		}, _config, {
			legacy: { privateKey: "TriggerOnPrivate", groupKey: "TriggerOnGroup", whitelistKey: "TriggerGroups" },
			diag, logContext: `session="${sessionId}"`,
		});
	}

	/**
	 * 处理单个 session 的消息队列（串行）。
	 * @param {string} sessionId
	 * @returns {Promise<void>}
	 */
	/**
	 * 处理单条队列事件（件11 processItem：转换→追加日志→触发判定→回复）。
	 * @param {object} event - LINE webhook event。
	 * @param {string} sessionId - 会话 ID。
	 * @returns {Promise<void>}
	 */
	async function ProcessLineQueueItem(event, sessionId) {
		const MAX_MESSAGE_DEPTH = _config?.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
		if (event.type !== "message") return;

		const entry = await lineEventToBeiluEntry(event, sessionId);
		if (!entry) return;

		if (!SessionChatLogs[sessionId]) SessionChatLogs[sessionId] = [];
		// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
		//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
		try {
			await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, "line"), {
				role: entry.role, name: entry.name, content: entry.content,
				files: entry.files, extension: entry.extension,
				...pickBotSourceMeta(entry),
			});
		} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
		SessionChatLogs[sessionId].push(entry);
		SessionChatLogs[sessionId] = MargeChatLog(SessionChatLogs[sessionId]);
		while (SessionChatLogs[sessionId].length > MAX_MESSAGE_DEPTH) {
			SessionChatLogs[sessionId].shift();
		}

		// 记录用户消息
		pushMessageLog({
			type: "user",
			sessionId,
			author: event.source?.userId || "unknown",
			content: extractLineTextContent(event),
		});

		// C6 用户白名单已收进 shouldTriggerReply 内的件12 resolveBotTrigger（原独立段纯删，防双判）
		if (!shouldTriggerReply(event, sessionId)) return;

		await DoMessageReply(event, sessionId);
	}

	/**
	 * 执行 AI 回复并通过 LINE push message API 发送。
	 * @param {object} triggerEvent - 触发事件
	 * @param {string} sessionId - 会话 ID
	 * @returns {Promise<void>}
	 */
	async function DoMessageReply(triggerEvent, sessionId) {
		diag.time(`DoMessageReply:${sessionId}`);
		diag.log(
			`DoMessageReply: session="${sessionId}", user="${triggerEvent.source?.userId}"`,
		);

		try {
			// 确定推送目标（私聊 → userId；群 → groupId/roomId）
			const source = triggerEvent.source;
			let pushTarget;
			if (source.type === "group") pushTarget = source.groupId;
			else if (source.type === "room") pushTarget = source.roomId;
			else pushTarget = source.userId;

			// 官方 replyToken 一次性（30 秒/用一次）：本轮回复内谁先发谁用掉，取走即置空，
			// 后续发送自动落 push（sendLineReply 无 token=纯 push）。
			let _pendingReplyToken = triggerEvent.replyToken;
			const _takeReplyToken = () => { const t = _pendingReplyToken; _pendingReplyToken = undefined; return t; };

			const generateChatReplyRequest = async () => {
				// 线 id 本轮取一次；深度就地取（MAX_MESSAGE_DEPTH 只在 ProcessLineQueueItem 作用域内）
				const _lineId = await resolveBotChatId(ownerUsername, botCharname, "line");
				const _maxDepth = _config?.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
				return {
				supported_functions: {
					markdown: false, // LINE 不支持 Markdown
					files: true,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				chatid: _lineId,
				chat_name: `LINE:${sessionId}`,
				char_id: botCharname,
				Charname: botCharname,
				UserCharname: _config?.OwnerUserName || "user",
				ReplyToCharname: triggerEvent.source?.userId || "user",
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
					?? applyBotContentFilter((SessionChatLogs[sessionId] || []).map((e) => ({ ...e })), ownerUsername),
				AddChatLogEntry: async (replyFromChar) => {
					if (replyFromChar && replyFromChar.content) {
						await sendLineReply(replyFromChar, pushTarget, _takeReplyToken());
					}
					return null;
				},
				Update: async () => await generateChatReplyRequest(),
				extension: {
					platform: "line",
					session_id: sessionId,
					source_type: source.type,
					trigger_user_id: source.userId,
				},
				};
			};

			// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
			// 命中即回执并跳过 AI 生成）。owner 判定=入站归一侧 :186 同式（LINE 无稳定昵称，OwnerUserName 承载 userId）。
			{
				const _cmdUserId = triggerEvent.source?.userId || "";
				const _cmdIsOwner = !!(_config?.OwnerUserName && _cmdUserId === _config.OwnerUserName);
				const _cmdReply = await handleBotChatCommand({
					username: ownerUsername,
					charName: botCharname,
					platform: "line",
					text: triggerEvent.message?.text || "",
					isOwner: _cmdIsOwner,
				});
				if (_cmdReply) {
					await sendLineReply({ content: _cmdReply }, pushTarget, _takeReplyToken());
					diag.timeEnd(`DoMessageReply:${sessionId}`);
					return;
				}
			}

			const chatRequest = await generateChatReplyRequest();
			const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest);

			if (aiFinalReply && aiFinalReply.content) {
				diag.debug(
					`DoMessageReply: AI回复完成, 内容长度=${aiFinalReply.content.length}`,
				);

				const rawContent =
					aiFinalReply.content_for_show || aiFinalReply.content || "";
				const thinkMatch = rawContent.match(
					/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i,
				);
				pushMessageLog({
					type: "ai",
					sessionId,
					author: botCharname,
					content: extractPlatformContent(rawContent, "line"),
					thinking: thinkMatch ? thinkMatch[1].trim() : "",
					fullContent: rawContent,
				});

				await sendLineReply(aiFinalReply, pushTarget, _takeReplyToken());
				// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: "char", name: botCharname, charName: botCharname,
					content: aiFinalReply.content || "",
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`));
			}

			diag.timeEnd(`DoMessageReply:${sessionId}`);
		} catch (error) {
			diag.error(
				`DoMessageReply: session="${sessionId}" 处理失败`,
				error,
			);
			// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
			broadcastBotError({ username: ownerUsername, platform: "linebot", botname: botCharname, phase: "runtime", error });
			pushMessageLog({
				type: "error",
				sessionId,
				author: "System",
				content: `回复失败: ${error.message || "Unknown error"}`,
			});
		}
	}

	/**
	 * 将 AI 回复拆分并发送到 LINE。官方双通道（0716 官方规则调研拍板「按照官方的来」）：
	 * reply（replyToken，官方免费通道，30 秒内一次性，单请求 ≤5 message objects）优先，
	 * push（按接收人数计费）承接余量与无 token 场景（委派唤醒/中途 AddChatLogEntry token 已用）。
	 * reply 失败（token 过期/已用 = 官方 400 Invalid reply token）→ 全量兜底 push，消息零丢失。
	 * 支持文本和文件（图片/视频/音频）发送。
	 * @param {object} beiluReply - beilu chatReply 对象
	 * @param {string} pushTarget - LINE 推送目标 ID（userId/groupId/roomId）
	 * @param {string} [replyToken] - webhook event 的 replyToken（可选；无则纯 push=原行为）
	 */
	async function sendLineReply(beiluReply, pushTarget, replyToken) {
		if (!_client) {
			diag.error("sendLineReply: LINE client 未初始化");
			return;
		}

		// ---- 构造消息列表（文本分段 + 文件）----
		const messages = [];
		const rawContent = beiluReply.content_for_show || beiluReply.content || "";
		const displayContent = extractPlatformContent(rawContent, "line");
		if (displayContent)
			for (const chunk of splitLineReply(displayContent)) {
				if (!chunk.trim()) continue;
				messages.push({ type: "text", text: chunk });
			}

		// ---- 文件/图片（需要 publicBaseUrl 配置）----
		const replyFiles = beiluReply.files || [];
		const bufferFiles = replyFiles.filter((f) => f && f.buffer);
		const publicBaseUrl = _config?.publicBaseUrl?.replace(/\/$/, "");

		for (const file of bufferFiles) {
			if (!publicBaseUrl) {
				// 降级：发纯文本提示
				const hint = `[文件: ${file.name || "unnamed"} (${file.mime_type || "unknown"}), 未配置 publicBaseUrl，无法发送]`;
				diag.warn(`sendLineReply: 未配置 publicBaseUrl，降级为文本提示: ${file.name}`);
				messages.push({ type: "text", text: hint });
				continue;
			}

			try {
				const key = storeTempFile(file.buffer, file.mime_type || "application/octet-stream");
				const fileUrl = `${publicBaseUrl}/api/parts/shells:linebot/tempfile/${key}`;
				const mime = file.mime_type || "";

				let lineMessage;
				if (mime.startsWith("image/")) {
					lineMessage = {
						type: "image",
						originalContentUrl: fileUrl,
						previewImageUrl: fileUrl,
					};
				} else if (mime.startsWith("video/")) {
					// LINE video 需要 previewImageUrl（缩略图）；无法提供时降级文本
					lineMessage = {
						type: "video",
						originalContentUrl: fileUrl,
						previewImageUrl: fileUrl, // 实际应是图片，此处复用（非正式但可用）
						trackingId: key,
					};
				} else if (mime.startsWith("audio/")) {
					// LINE audio 需要 duration（毫秒），未知时传 0
					lineMessage = {
						type: "audio",
						originalContentUrl: fileUrl,
						duration: 0,
					};
				} else {
					// 其他文件类型：LINE 不支持直接发送，降级为文本链接（前缀走 bots.file_placeholder 同键，
					// 防与 tools.mjs 入向占位同形不同源；URL 是数据留代码。publicBaseUrl 缺失提示
					// 是诊断文案=诊断面职责，不入配置链）
					const hint = `${fillInjectText("bots.file_placeholder", { name: file.name || "unnamed" })}\n${fileUrl}`;
					lineMessage = { type: "text", text: hint };
				}
				messages.push(lineMessage);
				diag.log(`sendLineReply: 已构造文件消息 ${file.name} (${mime}) -> ${fileUrl}`);
			} catch (e) {
				diag.error(`sendLineReply: 构造文件消息失败 ${file.name}`, e.message);
			}
		}

		if (!messages.length) return;

		// ---- 发送：reply 首批（官方免费，≤5 objects）→ push 余量；reply 失败全量兜底 push ----
		let rest = messages;
		if (replyToken) {
			const firstBatch = messages.slice(0, 5);
			try {
				await tryFewTimes(() =>
					_client.replyMessage({ replyToken, messages: firstBatch }),
				);
				rest = messages.slice(5);
			} catch (e) {
				diag.warn(`sendLineReply: replyMessage 失败（token 过期/已用），全量兜底 push: ${e.message}`);
			}
		}
		for (const m of rest)
			await tryFewTimes(() =>
				_client.pushMessage({
					to: pushTarget,
					messages: [m],
				}),
			).catch((e) => diag.error("sendLineReply: push 发送失败", e.message));
	}

	/**
	 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
	 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
	 * （GetPrompt H2 注入工作报告 consume-once）→ sendLineReply push API 发回委派发起会话。
	 * sessionId 即 push 目标本身（getLineSessionId=groupId/roomId/userId）。
	 */
	async function DoDelegateWakeReply(sessionId) {
		if (!_client || !_config) {
			diag.warn(`DoDelegateWakeReply: client 未绑定（bot 未就绪），放弃唤醒（报告等下轮注入）`);
			return;
		}
		// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
		await runExclusiveWakeSlot(_mq.handlers, sessionId, async () => {
			try {
				const wakeRequest = async () => {
					// 与消息链同构：线 id 本轮取一次；深度就地取
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, "line");
					const _maxDepth = _config?.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
					return {
					supported_functions: { markdown: false, files: true, add_message: true },
					username: ownerUsername,
					// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
					chatid: _lineId,
					chat_name: `LINE:${sessionId}`,
					char_id: botCharname,
					Charname: botCharname,
					UserCharname: _config?.OwnerUserName || "user",
					ReplyToCharname: _config?.OwnerUserName || "user",
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
						?? applyBotContentFilter((SessionChatLogs[sessionId] || []).map((e) => ({ ...e })), ownerUsername),
					AddChatLogEntry: async (replyFromChar) => {
						if (replyFromChar && replyFromChar.content)
							await sendLineReply(replyFromChar, sessionId);
						return null;
					},
					Update: wakeRequest,
					extension: { platform: "line", session_id: sessionId, delegate_wake: true },
					};
				};
				// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
				const _wakeReq = await wakeRequest();
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
				if (aiFinalReply && aiFinalReply.content) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
					pushMessageLog({
						type: "ai",
						sessionId,
						author: botCharname,
						content: extractPlatformContent(rawContent, "line"),
						fullContent: rawContent,
					});
					await sendLineReply(aiFinalReply, sessionId);
					// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
					await appendBotChatEntry(_wakeReq.chatid, {
						role: "char", name: botCharname, charName: botCharname,
						content: aiFinalReply.content || "",
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`));
				}
			} catch (error) {
				diag.error(`DoDelegateWakeReply: session="${sessionId}" 失败`, error);
				broadcastBotError({ username: ownerUsername, platform: "linebot", botname: botCharname, phase: "runtime", error });
			}
		}, { onBusy: () => diag.warn(`DoDelegateWakeReply: session="${sessionId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
	}

	return {
		/**
		 * Bot 启动时由 bot.mjs 调用，注入 LINE client 和配置。
		 * @param {import('npm:@line/bot-sdk').messagingApi.MessagingApiClient} client
		 * @param {object} config
		 */
		OnBotReady: async (client, config) => {
			_client = client;
			_config = config;
			diag.log("SimpleLineInterface: OnBotReady 已接收 client 和 config");
			// 注册委派回程唤醒。registerBotDelegateWaker 是同 key 替换语义（幂等），重启重入重复注册无害，不加守卫。
			registerBotDelegateWaker("line", ownerUsername, botCharname, async ({ channelId }) => {
				if (!channelId) return;
				await DoDelegateWakeReply(channelId);
			});
		},

		/**
		 * Bot 停止时由 bot.mjs 调用。
		 */
		OnBotStop: async () => {
			_client = null;
			_config = null;
			diag.log("SimpleLineInterface: OnBotStop 清理完成");
		},

		/**
		 * 处理来自 webhook 的 LINE events 数组。
		 * 按 sessionId 分队列，串行处理每个 session。
		 * @param {object[]} lineEvents - LINE webhook events
		 * @param {import('npm:@line/bot-sdk').messagingApi.MessagingApiClient} client - LINE client（由 webhook 传入，与 _client 相同）
		 */
		HandleWebhookEvents: async (lineEvents, client) => {
			// 确保 client 是最新的（webhook 也会传来）
			if (client && !_client) _client = client;

			for (const event of lineEvents) {
				if (event.type !== "message") continue;
				const sessionId = getLineSessionId(event);
				_mq.enqueue(sessionId, event);
			}
		},

		GetBotConfigTemplate: GetSimpleBotConfigTemplate,

		/**
		 * 清除所有会话的上下文（只保留记忆表格）
		 * @returns {{clearedChannels: number}}
		 */
		ClearContext: () => {
			const count = Object.keys(SessionChatLogs).length;
			for (const key of Object.keys(SessionChatLogs)) {
				delete SessionChatLogs[key];
			}
			for (const key of Object.keys(chat_scoped_char_memory)) {
				delete chat_scoped_char_memory[key];
			}
			_msgLog.clear();
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文和消息日志`);
			return { clearedChannels: count };
		},

		/**
		 * 获取当前活跃会话列表（供后台管理显示）
		 * @returns {Array<{sessionId: string, messageCount: number}>}
		 */
		// [0716 链路归一] GetActiveChats→GetActiveChannels + sessionId→channelId（discord 系统一契约，
		// 三层断链修复详注见 telegrambot 同位；channelId 语义=平台会话标识，line 即 sessionId 值）。
		GetActiveChannels: () => {
			return Object.entries(SessionChatLogs).map(([channelId, logs]) => ({
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

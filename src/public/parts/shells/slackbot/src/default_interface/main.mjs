import { Buffer } from "node:buffer";
import { clearInterval, setInterval } from "node:timers";

import { localhostLocales } from "../../../../../../scripts/i18n.mjs";
import { fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, createBotStreamEditor, makeStreamGenerationOptions, shouldAbsorbBurst, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from "../../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'
import { splitSlackReply } from "./tools.mjs";

const diag = createDiag("slack");

function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag);
}

export async function createSimpleSlackInterface(charAPI, ownerUsername, botCharname) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error("charAPI.interfaces.chat.GetReply is required.");

	function GetSimpleBotConfigTemplate() {
		return {
			OwnerUserName: "",
			OwnerUserId: "",
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// P4 键名归一（discord 系统一命名）：旧键 TriggerOnDM/TriggerOnChannel 停发
			//（dingtalk 0716 病征3先例），读侧保留旧键回退以兼容存量配置。
			PrivateChatEnabled: true,
			TriggerOnMention: true,
			TriggerOnMessage: false,
			TriggerChannels: [],
			// 件13 流式回复（官方 chat.update 滚动编辑,1.2s 节流;关=生成完一次性发送）
			StreamReplyEnabled: true,
			// 连发吸收（openclaw/LangBot 双实证形）：队列有后续时本条只入上下文由末条触发；命令/带附件消息不吸收
			BurstDebounceEnabled: false,
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		};
	}

	const ChatLogs = {};
	const chat_scoped_char_memory = {};
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag);

	// 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）
	const _msgLog = createBotMessageLog();
	const pushMessageLog = (entry) => _msgLog.push(entry);

	let botUserId = null;
	const userNameCache = {};

	async function SlackBotMain(app, config) {
		const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH;
		// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared）——原逐字声明+入队三行式+
		// try/while/finally 纯删，本壳只保 slack 特异段 ProcessSlackQueueItem（单条处理；队列元素={event,client}）。
		const _mq = createMessageQueueRuntime({
			diag,
			processItem: ProcessSlackQueueItem,
		});
		// 键为 bot 发出的 Slack 消息 ts，值为对应 AI 回复对象。Slack 会把 bot 自己发的消息以 message 事件回灌，
		// 这里用缓存让 bot 自身消息回填 AI 真实回复内容(而非展示文本)，与 discord/telegram 模板对齐。
		const aiReplyObjectCache = {};

		async function resolveUserName(client, userId) {
			if (userNameCache[userId]) return userNameCache[userId];
			try {
				const result = await tryFewTimes(() => client.users.info({ user: userId }));
				const name = result.user?.profile?.display_name || result.user?.real_name || result.user?.name || userId;
				userNameCache[userId] = name;
				return name;
			} catch { return userId; }
		}

		async function SlackMessageToBeiluEntry(event, client) {
			const userId = event.user;
			const displayName = await resolveUserName(client, userId);
			const isBot = userId === botUserId || event.bot_id;
			const isOwner = displayName === config.OwnerUserName || event.user === config.OwnerUserId;

			let content = event.text || '';
			content = content.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userNameCache[id] || id}`);

			const files = [];
			if (event.files?.length) {
				for (const f of event.files) {
					if (f.url_private_download) {
						try {
							const buf = Buffer.from(await tryFewTimes(() =>
								fetch(f.url_private_download, {
									headers: { 'Authorization': `Bearer ${app.client.token}` }
								}).then(r => r.arrayBuffer())
							));
							files.push({ name: f.name || 'file', buffer: buf, mime_type: f.mimetype || 'application/octet-stream' });
						} catch (e) { diag.error(`下载Slack文件失败: ${f.name}`, e); }
					}
				}
			}

			// F-T7: 外部用户输入 sanitize + 身份识别标记
			//   bot 自己  → 优先用 cachedAIReply.content (AI 真实回复)
			//   owner    → 原文直入
			//   其他用户 → 全角转义 + 长度限制 + <external_user name="..." platform="slack"> 包裹
			const cachedAIReply = aiReplyObjectCache[event.ts];
			let _finalContent;
			if (isBot) {
				_finalContent = (cachedAIReply && cachedAIReply.content !== undefined) ? cachedAIReply.content : content;
			} else if (isOwner) {
				_finalContent = content;
			} else {
				_finalContent = sanitizeExternalMessage(content, displayName, 'slack');
			}

			const entry = {
				...cachedAIReply,
				time_stamp: parseFloat(event.ts) * 1000,
				role: isBot ? "char" : (isOwner ? "user" : "char"),
				name: isBot ? (botCharname || "Bot") : displayName,
				content: _finalContent,
				files: files.filter(Boolean),
				// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
				_sourceType: "bot",
				_permissionLevel: resolveBotPermissionLevel(config, userId, isOwner),
				extension: { ...cachedAIReply?.extension, slack_ts: event.ts },
			};
			if (cachedAIReply) delete aiReplyObjectCache[event.ts];

			return entry;
		}

		// T9：MergeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架）。slack 平台差异=保留 slack_ts。
		const MergeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: ["slack_ts"] });

		/**
		 * 处理单条队列消息（件11 processItem：转换→追加日志→触发判定→回复）。
		 * @param {{event: object, client: object}} item - 队列元素（Slack 事件+WebClient）。
		 * @param {string} channelId - 频道 ID。
		 * @returns {Promise<void>}
		 */
		async function ProcessSlackQueueItem({ event, client }, channelId, meta) {
			if (!ChatLogs[channelId]) ChatLogs[channelId] = [];
			const entry = await SlackMessageToBeiluEntry(event, client);
			if (!entry) return;
			// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
			//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
			try {
				await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, "slack"), {
					role: entry.role, name: entry.name, content: entry.content,
					files: entry.files, extension: entry.extension,
					_sourceType: entry._sourceType, _permissionLevel: entry._permissionLevel,
				});
			} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`); }
			ChatLogs[channelId].push(entry);
			ChatLogs[channelId] = MergeChatLog(ChatLogs[channelId]);
			while (ChatLogs[channelId].length > MAX_MESSAGE_DEPTH) {
				const removed = ChatLogs[channelId].shift();
				if (removed?.extension?.slack_ts) delete aiReplyObjectCache[removed.extension.slack_ts];
			}

			// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实；
			// P4 旧键回退经 legacy 映射同收（TriggerOnDM/TriggerOnChannel）。
			const shouldReply = resolveBotTrigger({
				isDM: event.channel_type === 'im',
				isMentioned: !!(botUserId && event.text?.includes(`<@${botUserId}>`)),
				canGroupTrigger: true, // slack 原语义：说话触发无会话类型门
				whitelistId: channelId,
				senderId: event.user,
				isOwner: !!config.OwnerUserId && event.user === config.OwnerUserId,
				isSelf: event.user === botUserId,
				isFromBot: !!event.bot_id,
			}, config, {
				legacy: { privateKey: 'TriggerOnDM', groupKey: 'TriggerOnChannel' },
				diag, logContext: `channel="${channelId}"`,
			});
			// #9 连发吸收（判定单源 shouldAbsorbBurst：开关/命令/媒体三不合并;吸收=只入上下文由末条触发）
			if (shouldReply && shouldAbsorbBurst({
				config, pending: meta?.pending,
				text: event.text,
				hasMedia: !!event.files?.length,
			})) {
				diag.debug(`ProcessSlackQueueItem: 连发吸收，跳过本条生成（pending=${meta.pending}）`);
				return;
			}
			if (shouldReply)
				await DoMessageReply(event, client, channelId);
		}

		/**
		 * 分块发送回复到指定频道（闭包级单源：原 AddChatLogEntry 与主发送路径重复两份，
		 * 收口于此并供委派回程唤醒共用，防散写）。
		 * @param {object} client - Slack WebClient。
		 * @param {string} channelId - 频道 ID。
		 * @param {object} replyObj - beilu 聊天回复对象。
		 */
		async function postSplitTo(client, channelId, replyObj, stream) {
			const display = extractPlatformContent(replyObj.content_for_show || replyObj.content, "slack");
			const chunks = splitSlackReply(display);
			// 件13：流式预览已投递首段时，finalize 把预览消息编辑为最终首段并跳过首段发送；
			// finalize 返回 null=全量降级（预览从未投递/编辑失败），照原路径完整发送。
			let startIdx = 0;
			if (stream) {
				const _ts = await stream.finalize(chunks[0] || "");
				if (_ts != null && chunks.length) {
					startIdx = 1;
					if (chunks.length === 1) aiReplyObjectCache[_ts] = replyObj;
				}
			}
			for (let i = startIdx; i < chunks.length; i++) {
				const posted = await tryFewTimes(() => client.chat.postMessage({ channel: channelId, text: chunks[i] }));
				// 仅最后一条挂缓存,使 bot 自身回灌消息能取回 AI 真实回复对象
				if (i === chunks.length - 1 && posted?.ts) aiReplyObjectCache[posted.ts] = replyObj;
			}
		}

		/**
		 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
		 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
		 * （GetPrompt H2 注入工作报告 consume-once）→ app.client 主动 postMessage 发回发起频道。
		 */
		async function DoDelegateWakeReply(channelId) {
			// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
			await runExclusiveWakeSlot(_mq.handlers, channelId, async () => {
				try {
					const client = app.client;
					const chatName = `#${channelId}`;
					const wakeRequest = async () => {
						// 与消息链同构：线 id 本轮取一次，chatid 与 chat_log 读源共用。
						const _lineId = await resolveBotChatId(ownerUsername, botCharname, "slack");
						return {
						supported_functions: { markdown: true, files: true, add_message: true },
						username: ownerUsername,
						// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
						chatid: _lineId,
						chat_name: chatName,
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
						chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: MAX_MESSAGE_DEPTH }))
							?? applyBotContentFilter((ChatLogs[channelId] || []).map(e => ({ ...e })), ownerUsername),
						AddChatLogEntry: async (reply) => {
							if (reply?.content) await postSplitTo(client, channelId, reply);
							return null;
						},
						Update: wakeRequest,
						extension: { platform: "slack", channel_id: channelId, delegate_wake: true },
						};
					};
					// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
					const _wakeReq = await wakeRequest();
					const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq);
					if (aiFinalReply?.content) {
						const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
						pushMessageLog({ type: "ai", chatId: channelId, chatName, author: botCharname, content: extractPlatformContent(rawContent, "slack") });
						await postSplitTo(client, channelId, aiFinalReply);
						// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
						await appendBotChatEntry(_wakeReq.chatid, {
							role: "char", name: botCharname, charName: botCharname,
							content: aiFinalReply.content || "",
							content_for_show: aiFinalReply.content_for_show,
							files: aiFinalReply.files || [],
						}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`));
					}
				} catch (e) {
					diag.error(`DoDelegateWakeReply: channel="${channelId}" 失败`, e);
					broadcastBotError({ username: ownerUsername, platform: 'slackbot', botname: botCharname, phase: 'runtime', error: e });
				}
			}, { onBusy: () => diag.warn(`DoDelegateWakeReply: channel="${channelId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) });
		}

		// 注册委派回程唤醒（不显式注销：bot 停机后回调抛错由 notify 侧自愈摘除）
		registerBotDelegateWaker("slack", ownerUsername, botCharname, async ({ channelId }) => {
			if (!channelId) return;
			await DoDelegateWakeReply(channelId);
		});

		async function DoMessageReply(event, client, channelId) {
			diag.log(`DoMessageReply: channel="${channelId}", user="${event.user}"`);
			// 件13：流式回复编辑器（生成侧走既有 generation_options.replyPreviewUpdater 链）
			let _stream = null;
			try {
				const chatName = event.channel_type === 'im'
					? `DM with ${await resolveUserName(client, event.user)}`
					: `#${channelId}`;

				const generateChatReplyRequest = async () => {
					// 线 id 本轮取一次：chatid 字段与 chat_log 读源共用，避免同一请求解析两遍。
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, "slack");
					return {
					supported_functions: { markdown: true, files: true, add_message: true },
					username: ownerUsername,
					// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
					// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
					chatid: _lineId,
					chat_name: chatName,
					char_id: botCharname,
					Charname: botCharname,
					UserCharname: config.OwnerUserName,
					ReplyToCharname: await resolveUserName(client, event.user),
					locales: localhostLocales,
					time: new Date(),
					world: null,
					user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
					char: charAPI,
					other_chars: [],
					plugins: allPlugins,
					chat_scoped_char_memory,
					// [0726 上下文换源] 优先取对话文件（与 web 正线 requestBuilder:142 同源）；?? 兜底壳内存
					chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth: MAX_MESSAGE_DEPTH }))
						?? applyBotContentFilter(ChatLogs[channelId].map(e => ({ ...e })), ownerUsername),
					AddChatLogEntry: async (reply) => {
						if (reply?.content) await postSplitTo(client, channelId, reply);
						return null;
					},
					// 件13：流式预览回调（构造单源 makeStreamGenerationOptions,编辑时序由骨架泵串行化）
					generation_options: makeStreamGenerationOptions(_stream, "slack"),
					Update: async () => await generateChatReplyRequest(),
					extension: { platform: "slack", channel_id: channelId, slack_ts: event.ts },
					};
				};

				pushMessageLog({ type: "user", chatId: channelId, chatName, author: await resolveUserName(client, event.user), content: event.text || '' });

				// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
				// 命中即回执并跳过 AI 生成）。owner 判定=事件消费侧 :76 同式（OwnerUserId/OwnerUserName 双认）。
				{
					const _cmdIsOwner = event.user === config.OwnerUserId || (await resolveUserName(client, event.user)) === config.OwnerUserName;
					const _cmdReply = await handleBotChatCommand({
						username: ownerUsername,
						charName: botCharname,
						platform: "slack",
						text: event.text || "",
						isOwner: _cmdIsOwner,
					});
					if (_cmdReply) {
						await tryFewTimes(() => client.chat.postMessage({ channel: channelId, text: _cmdReply }));
						return;
					}
				}

				// 件13：命令回执已 early-return，此处才进 AI 生成=创建流式编辑器（StreamReplyEnabled 可关）
				if (config.StreamReplyEnabled !== false)
					_stream = createBotStreamEditor({
						diag,
						maxLen: 4000, // slack 单条建议上限（官方 4 万字符硬限，4000=分段器同步值）
						minIntervalMs: 1200, // chat.update tier3 限速安全间隔
						sendInitial: async (text) => (await tryFewTimes(() => client.chat.postMessage({ channel: channelId, text }))).ts,
						editMessage: async (ts, text) => { await tryFewTimes(() => client.chat.update({ channel: channelId, ts, text })); },
					});

				const chatRequest = await generateChatReplyRequest();
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest);

				if (aiFinalReply?.content) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || "";
					const display = extractPlatformContent(rawContent, "slack");
					const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
					pushMessageLog({ type: "ai", chatId: channelId, chatName, author: botCharname, content: display, thinking: thinkMatch?.[1]?.trim() || "" });

					await postSplitTo(client, channelId, aiFinalReply, _stream);
					// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
					await appendBotChatEntry(chatRequest.chatid, {
						role: "char", name: botCharname, charName: botCharname,
						content: aiFinalReply.content || "",
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`));

					if (aiFinalReply.files?.length) {
						for (const f of aiFinalReply.files.filter(f => f.buffer))
							try {
								await tryFewTimes(() => client.files.uploadV2({
									channel_id: channelId,
									file: f.buffer,
									filename: f.name || 'file',
								}));
							} catch (e) { diag.error(`上传Slack文件失败`, e); }
					}
				}
			} catch (e) {
				diag.error(`DoMessageReply失败`, e);
				// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
				broadcastBotError({ username: ownerUsername, platform: 'slackbot', botname: botCharname, phase: 'runtime', error: e })
				pushMessageLog({ type: "error", chatId: channelId, author: "System", content: `回复失败: ${e.message}` });
				try { await client.chat.postMessage({ channel: channelId, text: fillInjectText("bots.error_reply", { error: (e.message || '').slice(0, 200) }) }); } catch { }
			}
		}

		app.event("message", async ({ event, client }) => {
			if (event.subtype && event.subtype !== 'file_share') return;
			const channelId = event.channel;
			_mq.enqueue(channelId, { event, client });
		});

		const authResult = await app.client.auth.test();
		botUserId = authResult.user_id;
		diag.log(`Slack Bot 已就绪, userId=${botUserId}`);
	}

	return {
		OnBotReady: SlackBotMain,
		GetBotConfigTemplate: GetSimpleBotConfigTemplate,
		ClearContext: () => {
			const count = Object.keys(ChatLogs).length;
			for (const key of Object.keys(ChatLogs)) delete ChatLogs[key];
			for (const key of Object.keys(chat_scoped_char_memory)) delete chat_scoped_char_memory[key];
			_msgLog.clear();
			return { clearedChannels: count };
		},
		GetActiveChannels: () => Object.entries(ChatLogs).map(([id, logs]) => ({ channelId: id, messageCount: logs.length })),
		GetMessageLog: (since) => _msgLog.get(since),
		SetMessageLogSize: (size) => _msgLog.setSize(size),
	};
}

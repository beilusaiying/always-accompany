import { setTimeout } from 'node:timers'

import { EventAck, TOPIC_ROBOT } from 'npm:dingtalk-stream@^2.1.0' // 2.x:DWClientDownStream 改 type-only，状态枚举 SUCCESS 移到 EventAck

import { localhostLocales } from '../../../../../../scripts/i18n.mjs'
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, mergeChatLog, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from '../../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../../server/diagLogger.mjs'
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'

import { splitDingTalkReply } from './tools.mjs'

const diag = createDiag('dingtalk')

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "dingtalk"、"discord"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag)
}

/** @typedef {import('../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatLogEntry_t} BeiluChatLogEntryBase */
/**
 * @typedef {(BeiluChatLogEntryBase & {
 *   extension?: { dingtalk_msg_id?: string, [key: string]: any }
 * })} chatLogEntry_t_simple
 */
/** @typedef {import('../../../chat/decl/chatLog.ts').chatReply_t} ChatReply_t */

/**
 * 通过 sessionWebhook 发送钉钉消息（支持重试）
 * @param {string} sessionWebhook - 回调 webhook URL（有效期2小时）
 * @param {object} payload - 钉钉消息体
 * @returns {Promise<void>}
 */
async function sendViaWebhook(sessionWebhook, payload) {
	await tryFewTimes(() =>
		fetch(sessionWebhook, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}).then((r) => {
			if (!r.ok) throw new Error(`DingTalk webhook returned ${r.status}`)
			return r
		}),
	)
}

// ---- 官方主动发兜底（0716 官方规则调研拍板「按照官方的来」）----
// sessionWebhook 短时效（官方 sessionWebhookExpiredTime），AI 生成慢=webhook 过期回复静默丢失。
// 官方兜底通道：accessToken 主动发——群聊 POST /v1.0/robot/groupMessages/send（orgGroupSend）、
// 单聊 POST /v1.0/robot/oToMessages/batchSend（batchSendOTO）；robotCode=企业内部机器人 AppKey（=clientId）。

/** accessToken 缓存（官方 /v1.0/oauth2/accessToken，有效期取官方 expireIn 字段，提前 200s 刷新） */
const _dtTokenCache = {} // Record<clientId, {token, expireAt}>
async function getDingTalkAccessToken(config) {
	const cached = _dtTokenCache[config.clientId]
	if (cached && cached.expireAt > Date.now()) return cached.token
	const r = await tryFewTimes(() =>
		fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ appKey: config.clientId, appSecret: config.clientSecret }),
		}).then((res) => {
			if (!res.ok) throw new Error(`DingTalk accessToken returned ${res.status}`)
			return res.json()
		}),
	)
	if (!r?.accessToken) throw new Error('DingTalk accessToken 响应缺 accessToken 字段')
	_dtTokenCache[config.clientId] = { token: r.accessToken, expireAt: Date.now() + (Number(r.expireIn) || 0) * 1000 - 200000 }
	return r.accessToken
}

/**
 * 官方主动发（webhook 过期兜底线）。payload=webhook 线的 msgtype 形，此处转官方主动发 msgKey/msgParam 形
 *（sampleText/sampleMarkdown，官方消息模板键）。
 * @param {object} config - bot 配置（clientId/clientSecret）。
 * @param {{conversationType: string, openConversationId: string, userId: string}} route - 会话路由。
 * @param {object} payload - webhook 形消息体（msgtype: text|markdown）。
 */
async function sendViaProactiveApi(config, route, payload) {
	const token = await getDingTalkAccessToken(config)
	const isMarkdown = payload.msgtype === 'markdown'
	const msgKey = isMarkdown ? 'sampleMarkdown' : 'sampleText'
	const msgParam = isMarkdown
		? JSON.stringify({ title: payload.markdown.title, text: payload.markdown.text })
		: JSON.stringify({ content: payload.text.content })
	const isGroup = route.conversationType === '2'
	const url = isGroup
		? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
		: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
	const body = isGroup
		? { robotCode: config.clientId, openConversationId: route.openConversationId, msgKey, msgParam }
		: { robotCode: config.clientId, userIds: [route.userId], msgKey, msgParam }
	await tryFewTimes(() =>
		fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
			body: JSON.stringify(body),
		}).then((r) => {
			if (!r.ok) throw new Error(`DingTalk proactive send returned ${r.status}`)
			return r
		}),
	)
}

/**
 * 钉钉发送双通道单源：sessionWebhook 未过期（官方 sessionWebhookExpiredTime 判据）走 webhook（免 API 计费），
 * 过期走官方主动发兜底。路由不足（无 userId 的单聊等）时诚实抛错，由调用方错误面外显。
 * @param {{sessionWebhook: string, expiredTime: number, conversationType: string, openConversationId: string, userId: string, config: object}} ctx
 * @param {object} payload - webhook 形消息体。
 */
async function sendDingTalk(ctx, payload) {
	if (ctx.sessionWebhook && ctx.expiredTime > Date.now())
		return await sendViaWebhook(ctx.sessionWebhook, payload)
	if (!ctx.config?.clientId || !ctx.config?.clientSecret)
		throw new Error('sessionWebhook 已过期且缺 clientId/clientSecret，无法走官方主动发兜底')
	if (ctx.conversationType !== '2' && !ctx.userId)
		throw new Error('sessionWebhook 已过期且单聊缺 senderStaffId，无法走官方主动发兜底')
	return await sendViaProactiveApi(ctx.config, ctx, payload)
}

/**
 * 创建一个简单的钉钉接口。
 * @param {CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名（beilu 账号）。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含钉钉接口方法的 Promise。
 */
export async function createSimpleDingTalkInterface(charAPI, ownerUsername, botCharname) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error('charAPI.interfaces.chat.GetReply is required for SimpleDingTalkInterface.')

	/**
	 * @returns {object} 简单机器人配置模板
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			clientId: '',        // 钉钉 AppKey
			clientSecret: '',    // 钉钉 AppSecret
			OwnerUserName: '',   // 机器人主人的钉钉昵称（仅做显示用，不再用于身份判断）
			OwnerUserId: '',     // 机器人主人的钉钉 userId（senderStaffId，用于安全身份识别）
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// ---- 触发模式配置（与 discord/telegram 模板对齐的统一命名） ----
			PrivateChatEnabled: true, // 私聊模式：私聊中用户说话即触发
			TriggerOnMention: true,   // @触发：群聊中被 @机器人 时回复
			TriggerOnMessage: false,  // 说话触发：白名单群中所有消息都回复（不要求 @）
			TriggerChannels: [],      // 说话触发的群白名单（conversationId 数组），空=所有群
			// 旧版钉钉命名（TriggerOnPrivate/TriggerOnGroup/TriggerGroups）已不再下发（0716 病征3双键收敛）：
			// 消费侧 :493-501 的旧键回退读保留（存量配置仍生效），但模板同时下发新旧两套=前端模板驱动
			// 渲染会出同语义双控件（PrivateChatEnabled 与 TriggerOnPrivate 并排），新建配置只落统一命名。
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		}
	}

	// 会话聊天日志：key = conversationId，value = chatLogEntry_t_simple[]
	const ConversationChatLogs = {}
	const chat_scoped_char_memory = {}

	// ---- 加载所有默认 plugin（与 beilu-chat 一致的完整消息管线） ----
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag)

	// 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）
	const _msgLog = createBotMessageLog()

	/** 向消息日志追加一条记录（T9 件2 薄适配） */
	const pushMessageLog = (entry) => _msgLog.push(entry)

	// ---- 消息队列：每个会话独立串行处理 ----
	// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared，命名统一 discord 系:原
	// ConversationQueues/ConversationHandlers/HandleConversationQueue 三元组纯删）——本壳只保 dingtalk
	// 特异段 ProcessDingTalkQueueItem。config/botUserId 原经 handler 参数穿传，改为随队列元素携带
	//（入队时刻闭包值，Stream 连接期间固定，与原 handler 创建时刻捕获语义等价）。
	const _mq = createMessageQueueRuntime({
		diag,
		processItem: ProcessDingTalkQueueItem,
	})

	/**
	 * 将钉钉消息数据转换为 beilu 聊天日志条目。
	 * @param {object} data - 钉钉消息数据（来自 Stream 回调的 res.data）
	 * @param {string} botUserId - 机器人自身的 userId（用于识别自己）
	 * @param {object} config - 机器人配置
	 * @returns {chatLogEntry_t_simple} 转换后的 beilu 聊天日志条目
	 */
	function DingTalkMessageToBeiluEntry(data, botUserId, config) {
		const isPrivate = data.conversationType === '1'
		const senderId = data.senderId
		// 钉钉稳定身份 ID：优先 senderStaffId（企业内唯一 userId），降级 senderId
		const senderStaffId = data.senderStaffId || senderId
		const senderNick = data.senderNick || `User_${senderId}`

		// 去除 @机器人 部分，获取纯文本
		let rawText = data.text?.content || ''
		rawText = rawText.replace(/@\S+\s?/g, '').trim()

		// F-T7: 外部用户输入 sanitize + 身份识别标记
		//   owner    → 原文直入（用 OwnerUserId 做安全身份识别，降级 OwnerUserName）
		//   其他用户 → 字符转义 + 长度限制 + <external_user platform="dingtalk"> 包裹
		//   （钉钉 Stream 模式机器人自身消息不会回调进来，无需 bot 自身分支）
		const isOwner = config.OwnerUserId
			? senderStaffId === config.OwnerUserId
			: (config.OwnerUserName && senderNick === config.OwnerUserName)
		let finalContent
		if (isOwner) {
			finalContent = rawText
		} else {
			finalContent = sanitizeExternalMessage(rawText, senderNick, 'dingtalk')
		}

		return {
			time_stamp: data.createAt || Date.now(),
			role: 'user',
			name: senderNick,
			content: finalContent,
			files: [],
			// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
			_sourceType: 'bot',
			...buildBotSourceMeta(config, senderStaffId, isOwner),
			extension: {
				dingtalk_msg_id: data.msgId,
				conversationType: data.conversationType,
				conversationId: data.conversationId,
				senderId,
				senderStaffId,
			},
		}
	}

	// T9：MargeChatLog 已抽到 botContentShared.mjs mergeChatLog（公共骨架）。原本地版与共享版逐字同构，
	// dingtalk 平台差异=保留 dingtalk_msg_id，经 mergeExtensionKeys 传入。
	// （审计 BR6-1 记录的"import mergeChatLog + 本地 MargeChatLog 两份共存"歧义就此消解。）
	const MargeChatLog = (log) => mergeChatLog(log, { mergeExtensionKeys: ["dingtalk_msg_id"] })

	/**
	 * 处理会话消息队列（串行）。
	 * @param {string} conversationId - 会话 ID。
	 * @param {object} config - 机器人配置。
	 * @param {string} botUserId - 机器人 userId（占位，Stream 模式暂不直接提供）。
	 * @returns {Promise<void>}
	 */
	/**
	 * 处理单条队列消息（件11 processItem：转换→追加日志→回复；触发判定在入队前的回调侧，本壳原状）。
	 * @param {{data: object, sessionWebhook: string, config: object, botUserId: string}} item - 队列元素。
	 * @param {string} conversationId - 会话 ID。
	 * @returns {Promise<void>}
	 */
	async function ProcessDingTalkQueueItem(item, conversationId) {
		const { data, sessionWebhook, config, botUserId } = item

		const userEntry = DingTalkMessageToBeiluEntry(data, botUserId, config)

		if (!ConversationChatLogs[conversationId])
			ConversationChatLogs[conversationId] = []

		// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
		//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
		try {
			await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, 'dingtalk'), {
				role: userEntry.role, name: userEntry.name, content: userEntry.content,
				files: userEntry.files, extension: userEntry.extension,
				...pickBotSourceMeta(userEntry),
			})
		} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`) }
		ConversationChatLogs[conversationId].push(userEntry)
		ConversationChatLogs[conversationId] = MargeChatLog(ConversationChatLogs[conversationId])

		const MAX_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
		while (ConversationChatLogs[conversationId].length > MAX_DEPTH)
			ConversationChatLogs[conversationId].shift()

		await DoMessageReply(data, sessionWebhook, conversationId, config)
	}

	/**
	 * 生成并发送 AI 回复。
	 * @param {object} data - 钉钉消息数据。
	 * @param {string} sessionWebhook - 回复用 webhook URL。
	 * @param {string} conversationId - 会话 ID。
	 * @param {object} config - 机器人配置。
	 * @returns {Promise<void>}
	 */
	async function DoMessageReply(data, sessionWebhook, conversationId, config) {
		diag.time(`DoMessageReply:${data.msgId}`)
		diag.log(`DoMessageReply: msgId="${data.msgId}", conv="${conversationId}", sender="${data.senderNick}"`)

		const isPrivate = data.conversationType === '1'
		const channelName = isPrivate
			? `DM: ${data.senderNick}`
			: (data.conversationTitle || conversationId)

		// 发送上下文（双通道 sendDingTalk）：过期判据/路由全取官方回调字段
		const _sendCtx = {
			sessionWebhook,
			expiredTime: Number(data.sessionWebhookExpiredTime) || 0,
			conversationType: data.conversationType,
			openConversationId: conversationId,
			userId: data.senderStaffId || '',
			config,
		}

		// 记录用户消息到日志
		let rawText = data.text?.content || ''
		rawText = rawText.replace(/@\S+\s?/g, '').trim()
		pushMessageLog({
			type: 'user',
			channelId: conversationId,
			channelName,
			author: data.senderNick || data.senderId,
			content: rawText,
			files: 0,
		})

		try {
			/**
			 * AddChatLogEntry 回调：将 AI 回复发送出去（流式多段）
			 * @param {ChatReply_t} replyFromChar - 角色回复对象。
			 * @returns {Promise<null>}
			 */
			const AddChatLogEntry = async (replyFromChar) => {
				if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
					await sendDingTalkReply(_sendCtx, replyFromChar, conversationId, config)
				return null
			}

			/**
			 * 生成聊天回复请求。
			 * @returns {Promise<object>}
			 */
			const generateChatReplyRequest = async () => {
				// 线 id 本轮取一次；深度就地取（MAX_DEPTH 只在 ProcessDingTalkQueueItem 作用域内）
				const _lineId = await resolveBotChatId(ownerUsername, botCharname, 'dingtalk')
				const _maxDepth = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
				return {
				supported_functions: {
					markdown: true,
					files: false,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				chatid: _lineId,
				chat_name: channelName,
				char_id: botCharname,
				Charname: botCharname,
				UserCharname: config.OwnerUserName || data.senderNick,
				ReplyToCharname: data.senderNick || data.senderId,
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
					?? applyBotContentFilter((ConversationChatLogs[conversationId] || []).map((e) => ({ ...e })), ownerUsername),
				AddChatLogEntry,
				Update: async () => await generateChatReplyRequest(),
				extension: {
					platform: 'dingtalk',
					trigger_msg_id: data.msgId,
					conversation_id: conversationId,
					conversation_type: data.conversationType,
					sender_id: data.senderId,
				},
				}
			}

			// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
			// 命中即回执并跳过 AI 生成）。owner 判定=入站归一侧 :141 同式（OwnerUserId 优先，降级 OwnerUserName）。
			{
				const _cmdIsOwner = config.OwnerUserId
					? data.senderStaffId === config.OwnerUserId
					: !!(config.OwnerUserName && data.senderNick === config.OwnerUserName)
				const _cmdReply = await handleBotChatCommand({
					username: ownerUsername,
					charName: botCharname,
					platform: 'dingtalk',
					text: rawText,
					isOwner: _cmdIsOwner,
				})
				if (_cmdReply) {
					await sendDingTalkReply(_sendCtx, { content: _cmdReply }, conversationId, config)
					diag.timeEnd(`DoMessageReply:${data.msgId}`)
					return
				}
			}

			const chatRequest = await generateChatReplyRequest()
			const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest)

			if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)
				pushMessageLog({
					type: 'ai',
					channelId: conversationId,
					channelName,
					author: botCharname,
					content: extractPlatformContent(rawContent, 'dingtalk'),
					thinking: thinkMatch ? thinkMatch[1].trim() : '',
					fullContent: rawContent,
					files: aiFinalReply.files?.length || 0,
				})

				// 将 AI 回复追加到对话日志
				const aiEntry = {
					time_stamp: Date.now(),
					role: 'char',
					name: botCharname,
					content: extractPlatformContent(rawContent, 'dingtalk'),
					files: [],
					extension: { dingtalk_msg_id: null },
				}
				ConversationChatLogs[conversationId].push(aiEntry)
				ConversationChatLogs[conversationId] = MargeChatLog(ConversationChatLogs[conversationId])
				const MAX_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
				while (ConversationChatLogs[conversationId].length > MAX_DEPTH)
					ConversationChatLogs[conversationId].shift()

				await sendDingTalkReply(_sendCtx, aiFinalReply, conversationId, config)
				// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: 'char', name: botCharname, charName: botCharname,
					content: aiFinalReply.content || '',
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`))
			}
			diag.timeEnd(`DoMessageReply:${data.msgId}`)
		} catch (error) {
			diag.error(`DoMessageReply: msgId="${data.msgId}" 处理失败`, error)
			// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
			broadcastBotError({ username: ownerUsername, platform: 'dingtalkbot', botname: botCharname, phase: 'runtime', error })
			pushMessageLog({
				type: 'error',
				channelId: conversationId,
				channelName,
				author: 'System',
				content: `回复失败: ${error.message || 'Unknown error'}`,
			})
			try {
				await sendDingTalk(_sendCtx, {
					msgtype: 'text',
					text: { content: `抱歉，回复时出错：${error.message || 'Unknown error'}` },
				})
			} catch (sendError) {
				diag.error(`DoMessageReply: 发送错误回复也失败, msgId="${data.msgId}"`, sendError)
			}
		}
	}

	/**
	 * 将 AI 回复发送到钉钉（分段、Markdown/文本自动选择；双通道 sendDingTalk=webhook 优先+官方主动发兜底）
	 * @param {object} ctx - 发送上下文（sessionWebhook/expiredTime/conversationType/openConversationId/userId/config）
	 * @param {ChatReply_t} beiluReply - beilu 回复对象
	 * @param {string} conversationId - 会话 ID（供日志使用）
	 * @param {object} config - 机器人配置
	 * @returns {Promise<void>}
	 */
	async function sendDingTalkReply(ctx, beiluReply, conversationId, config) {
		const rawContent = beiluReply.content_for_show || beiluReply.content || ''
		let displayContent = extractPlatformContent(rawContent, 'dingtalk')

		// 钉钉不支持直接发送文件/图片附件，在文本末尾降级提示
		const files = beiluReply.files || []
		if (files.length) {
			const names = files.map(f => f.name || '未知文件').join('、')
			const notice = `\n\n[附件: ${names} 等 ${files.length} 个文件无法在钉钉显示]`
			displayContent = displayContent + notice
			diag.warn(`sendDingTalkReply: 钉钉不支持文件发送，共 ${files.length} 个文件已降级为文本提示`)
		}

		if (!displayContent.trim()) return

		const chunks = splitDingTalkReply(displayContent)
		for (const chunk of chunks) {
			if (!chunk.trim()) continue
			// 检测是否含 Markdown 语法，选择消息类型
			const hasMarkdown = /[*_`#\[\]\-]/.test(chunk)
			const payload = hasMarkdown
				? { msgtype: 'markdown', markdown: { title: botCharname, text: chunk } }
				: { msgtype: 'text', text: { content: chunk } }

			await sendDingTalk(ctx, payload)
		}
	}

	/**
	 * 钉钉 Stream 主函数，注册消息回调并启动。
	 * @param {import('npm:dingtalk-stream').DWClient} client - 钉钉 Stream 客户端。
	 * @param {object} config - 机器人配置。
	 * @returns {Promise<void>}
	 */
	async function SimpleDingTalkBotMain(client, config) {
		// 钉钉 Stream 模式没有"自己的 userId"通过 ready 事件提供，暂用空字符串
		const botUserId = ''

		// 委派回程唤醒的回程通道缓存：钉钉 Stream 模式无主动推送 API，唯一出口=消息附带的
		// sessionWebhook。过期判据=官方回调自带的 sessionWebhookExpiredTime 字段（毫秒时间戳，官方明说
		// "临时地址，过期时间对应该字段"）——原自造 2h 常量是错的（2h 是 accessToken 有效期，官方规则
		// 调研 0716 纠正；实际 webhook 有效期短得多，2h 窗=长期向过期地址发送静默失败）。
		// 每条入站消息刷新缓存；唤醒时取未过期 webhook 发回。过期/无缓存=放弃唤醒（报告仍在队列，
		// 用户下条消息注入，双保险）。字段缺失时保守视为已过期（诚实降级，不猜窗口）。
		const _webhookCache = {} // Record<conversationId, {webhook, expiredTime}>

		/**
		 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）。
		 * 回程通道=双通道 sendDingTalk：缓存 webhook 未过期直回，过期走官方主动发兜底
		 *（batchSendOTO/orgGroupSend）——仅"该会话从未来过消息（无缓存=无路由）"才放弃。
		 */
		async function DoDelegateWakeReply(conversationId) {
			const _cached = _webhookCache[conversationId]
			if (!_cached) {
				diag.warn(`DoDelegateWakeReply: conv="${conversationId}" 无会话路由缓存（该会话未收到过消息），放弃唤醒（报告等下轮注入）`)
				return
			}
			const _wakeCtx = {
				sessionWebhook: _cached.webhook,
				expiredTime: _cached.expiredTime,
				conversationType: _cached.conversationType,
				openConversationId: conversationId,
				userId: _cached.senderStaffId,
				config,
			}
			// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
			await runExclusiveWakeSlot(_mq.handlers, conversationId, async () => {
				try {
					const wakeRequest = async () => {
						// 与消息链同构：线 id 本轮取一次；深度就地取
						const _lineId = await resolveBotChatId(ownerUsername, botCharname, 'dingtalk')
						const _maxDepth = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
						return {
						supported_functions: { markdown: true, files: false, add_message: true },
						username: ownerUsername,
						// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
						chatid: _lineId,
						chat_name: `DingTalk: ${conversationId}`,
						char_id: botCharname,
						Charname: botCharname,
						UserCharname: config.OwnerUserName || 'user',
						ReplyToCharname: config.OwnerUserName || 'user',
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
							?? applyBotContentFilter((ConversationChatLogs[conversationId] || []).map((e) => ({ ...e })), ownerUsername),
						AddChatLogEntry: async (replyFromChar) => {
							if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
								await sendDingTalkReply(_wakeCtx, replyFromChar, conversationId, config)
							return null
						},
						Update: wakeRequest,
						extension: { platform: 'dingtalk', conversation_id: conversationId, delegate_wake: true },
						}
					}
					// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
					const _wakeReq = await wakeRequest()
					const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq)
					if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
						const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
						pushMessageLog({
							type: 'ai',
							channelId: conversationId,
							channelName: `DingTalk: ${conversationId}`,
							author: botCharname,
							content: extractPlatformContent(rawContent, 'dingtalk'),
							fullContent: rawContent,
						})
						// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
						await appendBotChatEntry(_wakeReq.chatid, {
							role: 'char', name: botCharname, charName: botCharname,
							content: aiFinalReply.content || '',
							content_for_show: aiFinalReply.content_for_show,
							files: aiFinalReply.files || [],
						}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`))
						// AI 回复追加到会话日志（与 DoMessageReply 同构：钉钉不回灌自身消息，需手动记）
						if (!ConversationChatLogs[conversationId]) ConversationChatLogs[conversationId] = []
						ConversationChatLogs[conversationId].push({
							time_stamp: Date.now(),
							role: 'char',
							name: botCharname,
							content: extractPlatformContent(rawContent, 'dingtalk'),
							files: [],
							extension: { dingtalk_msg_id: null },
						})
						ConversationChatLogs[conversationId] = MargeChatLog(ConversationChatLogs[conversationId])
						await sendDingTalkReply(_wakeCtx, aiFinalReply, conversationId, config)
					}
				} catch (error) {
					diag.error(`DoDelegateWakeReply: conv="${conversationId}" 失败`, error)
					broadcastBotError({ username: ownerUsername, platform: 'dingtalkbot', botname: botCharname, phase: 'runtime', error })
				}
			}, { onBusy: () => diag.warn(`DoDelegateWakeReply: conv="${conversationId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) })
		}

		// 注册委派回程唤醒（不显式注销：bot 停机后回调抛错由 notify 侧自愈摘除）
		registerBotDelegateWaker('dingtalk', ownerUsername, botCharname, async ({ channelId }) => {
			if (!channelId) return
			await DoDelegateWakeReply(channelId)
		})

		client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
			try {
				const data = JSON.parse(res.data)
				diag.log(`收到消息: msgId="${data.msgId}", type="${data.conversationType}", sender="${data.senderNick}"`)

				const conversationId = data.conversationId || data.senderId
				const sessionWebhook = data.sessionWebhook
				// 委派回程通道：每条入站消息刷新该会话的 sessionWebhook（触发与否都缓存，扩大可回程窗口）；
				// 过期时间取官方 sessionWebhookExpiredTime 字段（缺失=0=视为已过期，不猜窗口）；
				// conversationType/senderStaffId 一并缓存=官方主动发兜底的会话路由（webhook 过期时唤醒仍可达）
				if (conversationId && sessionWebhook)
					_webhookCache[conversationId] = {
						webhook: sessionWebhook,
						expiredTime: Number(data.sessionWebhookExpiredTime) || 0,
						conversationType: data.conversationType,
						senderStaffId: data.senderStaffId || '',
					}
				const isPrivate = data.conversationType === '1'
				const isGroup = data.conversationType === '2'

				// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实；
				// P4 旧键回退经 legacy 映射同收（TriggerOnPrivate/TriggerOnGroup→mention/TriggerGroups）。
				// 语义对齐 discord 基准的行为变化（质量不齐漂移抹平，件12 注释①有案）：原 @ 触发带
				// 白名单门（白名单外群被 @ 不回）→ 基准 @ 触发无白名单门，白名单只辖说话触发。
				const _dtSenderStaffId = data.senderStaffId || data.senderId
				const shouldReply = resolveBotTrigger({
					isDM: isPrivate,
					// Stream 模式群聊中 @机器人 后内容自动带 @ 前缀；私聊无 @ 概念（isGroup 前提留采集侧）
					isMentioned: isGroup && (data.text?.content || '').includes('@'),
					canGroupTrigger: isGroup,
					whitelistId: conversationId,
					senderId: _dtSenderStaffId,
					isOwner: !!(config.OwnerUserId
						? _dtSenderStaffId === config.OwnerUserId
						: (config.OwnerUserName && data.senderNick === config.OwnerUserName)),
					isSelf: false, // 钉钉 Stream 不推送 bot 自身消息
					isFromBot: false,
				}, config, {
					legacy: { privateKey: 'TriggerOnPrivate', mentionLegacyKey: 'TriggerOnGroup', whitelistKey: 'TriggerGroups' },
					diag, logContext: `conversation="${conversationId}"`,
				})

				if (!shouldReply)
					return { status: EventAck.SUCCESS }

				// 入队，串行处理（件11 _mq.enqueue；config/botUserId 随元素携带见 _mq 声明处注释）
				_mq.enqueue(conversationId, { data, sessionWebhook, config, botUserId })

				return { status: EventAck.SUCCESS }
			} catch (error) {
				diag.error('TOPIC_ROBOT 回调处理失败', error)
				return { status: EventAck.SUCCESS }
			}
		})
	}

	return {
		OnceClientReady: SimpleDingTalkBotMain,
		GetBotConfigTemplate: GetSimpleBotConfigTemplate,
		/**
		 * 清除所有会话的上下文（只保留记忆表格）
		 * @returns {{clearedChannels: number}} 清除的会话数
		 */
		ClearContext: () => {
			const count = Object.keys(ConversationChatLogs).length
			for (const key of Object.keys(ConversationChatLogs))
				delete ConversationChatLogs[key]
			for (const key of Object.keys(chat_scoped_char_memory))
				delete chat_scoped_char_memory[key]
			_msgLog.clear()
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文和消息日志`)
			return { clearedChannels: count }
		},
		/**
		 * 获取当前活跃会话列表（供后台管理显示）
		 * @returns {Array<{channelId: string, messageCount: number}>}
		 */
		GetActiveChannels: () =>
			Object.entries(ConversationChatLogs).map(([channelId, logs]) => ({
				channelId,
				messageCount: logs.length,
			})),
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
	}
}

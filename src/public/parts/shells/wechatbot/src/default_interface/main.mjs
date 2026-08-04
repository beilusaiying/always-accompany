import { setTimeout } from 'node:timers'

import { localhostLocales } from '../../../../../../scripts/i18n.mjs'
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, resolveBotPermissionLevel, buildBotSourceMeta, pickBotSourceMeta, withBotPermissionDefaults, tryFewTimes, sanitizeExternalMessage, registerBotDelegateWaker, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, mergeChatLog as mergeChatLogShared, createBotMessageLog, loadOwnerPersona, runExclusiveWakeSlot, createMessageQueueRuntime, resolveBotTrigger, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from '../../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../../server/diagLogger.mjs'
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'

import {
	formatWechatMessage,
	isGroupMessage,
	isMentioned,
	splitWechatReply,
	stripMention,
} from './tools.mjs'

const diag = createDiag('wechatbot')

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "wechat"、"discord"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag)
}

/**
 * 通过第三方桥接服务 HTTP API 发送微信消息。
 * @param {object} config - bot 配置（含 apiUrl, apiToken）。
 * @param {string} toUser - 接收方 wxid 或群 ID。
 * @param {string} content - 消息文本内容。
 * @returns {Promise<void>}
 */
async function sendWechatMessage(config, toUser, content) {
	if (!config.apiUrl) {
		diag.warn('sendWechatMessage: apiUrl 未配置，无法发送消息')
		return
	}
	const url = config.apiUrl.replace(/\/$/, '') + '/message/send'
	const body = {
		toUser,
		content,
		msgType: 1,
	}
	if (config.apiToken)
		body.token = config.apiToken

	await tryFewTimes(async () => {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (!resp.ok)
			throw new Error(`sendWechatMessage HTTP ${resp.status}: ${await resp.text()}`)
	})
}

/**
 * 通过第三方桥接服务发送图片/文件（base64 方式）。
 * 先尝试 POST apiUrl/message/send with msgType=image；
 * 如果失败，降级为文本提示。
 * @param {object} config - bot 配置（含 apiUrl, apiToken）。
 * @param {string} toUser - 接收方 wxid 或群 ID。
 * @param {{ name: string, buffer: Buffer, mime_type?: string }} file - 文件对象。
 * @returns {Promise<void>}
 */
async function sendWechatFile(config, toUser, file) {
	if (!config.apiUrl) {
		diag.warn('sendWechatFile: apiUrl 未配置，跳过')
		return
	}
	const base = config.apiUrl.replace(/\/$/, '')
	const imageBase64 = file.buffer.toString('base64')
	const isImage = (file.mime_type || '').startsWith('image/')

	// 尝试发送图片
	if (isImage) {
		try {
			const body = { toUser, msgType: 'image', imageBase64 }
			if (config.apiToken) body.token = config.apiToken
			const resp = await fetch(base + '/message/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})
			if (resp.ok) {
				const data = await resp.json().catch(() => ({}))
				if (data.errcode === 0 || data.success || data.code === 0) {
					diag.log(`sendWechatFile: 图片发送成功, file="${file.name}"`)
					return
				}
			}
			diag.warn(`sendWechatFile: 桥接服务不支持图片发送，降级为文本提示`)
		} catch (e) {
			diag.warn(`sendWechatFile: 图片发送异常, 降级: ${e.message}`)
		}
	}

	// 降级：文本提示
	const label = isImage ? `[图片: ${file.name}]` : `[文件: ${file.name}]`
	await sendWechatMessage(config, toUser, label)
}

/**
 * 创建一个简单的微信接口（Webhook 模式）。
 * @param {import('../../../../../../decl/charAPI.ts').CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含微信接口方法的对象。
 */
export async function createSimpleWechatInterface(
	charAPI,
	ownerUsername,
	botCharname,
) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error(
			'charAPI.interfaces.chat.GetReply is required for SimpleWechatInterface.',
		)

	/**
	 * 获取默认 bot 配置模板。
	 * @returns {object}
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			apiUrl: 'http://localhost:8849',       // 第三方桥接服务地址
			apiToken: '',                           // 认证 token（可选）
			OwnerWxid: '',                          // 主人的微信 wxid（稳定 ID, 用于安全身份识别; 昵称可被冒充, 优先用此项）
			OwnerUserName: '',                      // 主人的微信昵称（仅做显示用; OwnerWxid 为空时退化为按昵称判断）
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// P4 键名归一（discord 系统一命名）：旧键 TriggerOnPrivate/TriggerOnGroup/TriggerGroups 停发
			//（dingtalk 0716 病征3先例），读侧保留旧键回退以兼容存量配置。TriggerOnGroupMention=wechat
			// 特异键保留（群内@触发，非本轮拍板三组范围）。
			PrivateChatEnabled: true,               // 私聊触发：私聊中用户说话即触发
			TriggerOnMessage: false,                // 群聊全量触发：白名单群里所有消息都回复
			TriggerOnGroupMention: true,            // 群里@机器人触发：被@时回复
			TriggerChannels: [],                    // 群聊白名单（空=全部群），群 chatroom ID 数组
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		}
	}

	// ---- 闭包级共享状态 ----
	/** Record<chatId, chatLogEntry[]>  chatId = wxid 或 roomId */
	const ChatLogs = {}
	const chat_scoped_char_memory = {}

	// 运行时 config（Init 时写入）
	let runtimeConfig = {}

	// ---- 加载默认 plugins ----
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag)

	// ---- 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）----
	const _msgLog = createBotMessageLog()
	const pushMessageLog = (entry) => _msgLog.push(entry)

	// ---- 消息处理队列（按 chatId 串行处理） ----
	// 件11：队列三元组收骨架 createMessageQueueRuntime（botContentShared，命名统一 discord 系:原
	// MessageQueues/MessageHandlers/handleMessageQueue 三元组纯删）——本壳只保 wechat 特异段
	// ProcessWechatQueueItem（单条处理；队列元素=WechatMessage）。
	const _mq = createMessageQueueRuntime({
		diag,
		processItem: ProcessWechatQueueItem,
	})

	/**
	 * 将 Webhook 消息转换为 beilu 聊天日志条目。
	 * @param {object} message - Webhook 推送的微信消息。
	 * @param {boolean} isBot - 是否为机器人自己发出的消息。
	 * @param {string} [botReplyContent] - 机器人回复的原始内容（供日志记录）。
	 * @returns {Promise<object>} beilu 聊天日志条目。
	 */
	async function wechatMessageToLogEntry(message, isBot = false, botReplyContent = undefined) {
		const content = formatWechatMessage(message)
		const isGroup = isGroupMessage(message)
		// 主人身份识别：优先用稳定的 wxid（OwnerWxid），不可冒充；退化时才用昵称（OwnerUserName，可被冒充）
		const isOwner = runtimeConfig.OwnerWxid
			? message.fromUser === runtimeConfig.OwnerWxid
			: message.fromUserName === runtimeConfig.OwnerUserName

		// F-T7: 外部用户输入 sanitize + 身份识别标记
		//   bot 自己  → 优先用 botReplyContent (AI 真实回复)
		//   owner    → 原文直入
		//   其他用户 → 全角转义 + 长度限制 + <external_user name="..." platform="wechat"> 包裹,让 AI 能分辨多用户身份
		let finalContent
		if (isBot) {
			finalContent = botReplyContent !== undefined ? botReplyContent : content
		} else if (isOwner) {
			finalContent = content
		} else {
			// 外部用户：全角转义（防 beilu 内部协议标签被注入）+ 长度限制 + 包裹身份标签
			finalContent = sanitizeExternalMessage(content, message.fromUserName || message.fromUser, 'wechat')
		}

		// 下载附件（图片/文件）
		const files = []
		if (!isBot) {
			if (message.imageUrl) {
				try {
					const buf = Buffer.from(await fetch(message.imageUrl).then(r => r.arrayBuffer()))
					files.push({ name: 'image.jpg', buffer: buf, mime_type: 'image/jpeg' })
				} catch (e) {
					diag.warn('wechatMessageToLogEntry: 下载图片失败', e.message)
				}
			} else if (message.fileUrl) {
				try {
					const buf = Buffer.from(await fetch(message.fileUrl).then(r => r.arrayBuffer()))
					const fileName = message.fileName || 'file'
					files.push({ name: fileName, buffer: buf, mime_type: 'application/octet-stream' })
				} catch (e) {
					diag.warn('wechatMessageToLogEntry: 下载文件失败', e.message)
				}
			}
		}

		return {
			time_stamp: (message.timestamp || Date.now() / 1000) * 1000,
			role: isBot ? 'char' : (isOwner ? 'user' : 'char'),
			name: isBot
				? (runtimeConfig.BotNickname || botCharname)
				: (message.fromUserName || 'unknown'),
			content: finalContent,
			files,
			// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
			_sourceType: 'bot',
			...buildBotSourceMeta(runtimeConfig, message.fromUser, isOwner),
		}
	}

	// T9：mergeChatLog 抽到 botContentShared.mjs（公共骨架）。wechat entry 带 files（用户图片/文件 buffer），
	// 无 extension 字段。原本地版是简化变体（无 files 守卫），统一到完整版即修正 wechat 侧漏修的边界：
	// 带附件消息不再被后续同人消息错误吸并（保住 files）。无平台 extension 键 → mergeExtensionKeys 空。
	const mergeChatLog = (log) => mergeChatLogShared(log, { mergeExtensionKeys: [] })

	/**
	 * 处理一个 chatId 的消息队列。
	 * @param {string} chatId - 会话 ID（wxid 或 roomId）。
	 * @returns {Promise<void>}
	 */
	/**
	 * 处理单条队列消息（件11 processItem：转换→追加日志→触发判定→回复）。
	 * @param {object} message - Webhook 推送的微信消息。
	 * @param {string} chatId - 会话 ID（wxid 或 roomId）。
	 * @returns {Promise<void>}
	 */
	async function ProcessWechatQueueItem(message, chatId) {
		const MAX_DEPTH = runtimeConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH

		// 初始化 ChatLog
		if (!ChatLogs[chatId]) ChatLogs[chatId] = []

		// 将新消息追加到日志
		const userEntry = await wechatMessageToLogEntry(message, false)
		// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
		//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
		try {
			await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, 'wechat'), {
				role: userEntry.role, name: userEntry.name, content: userEntry.content,
				files: userEntry.files, extension: userEntry.extension,
				...pickBotSourceMeta(userEntry),
			})
		} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`) }
		ChatLogs[chatId].push(userEntry)
		ChatLogs[chatId] = mergeChatLog(ChatLogs[chatId])
		while (ChatLogs[chatId].length > MAX_DEPTH)
			ChatLogs[chatId].shift()

		// 件12：触发判定收单源 resolveBotTrigger（botContentShared），本壳只采集平台事实；
		// P4 旧键回退经 legacy 映射同收；@ 触发读键=wechat 特异 TriggerOnGroupMention（mentionKey 参数）。
		// 原"群白名单∨群@"的 if+if 与基准 elif 链为同一 ∨ 语义（顺序不影响布尔结果）。
		const isGroup = isGroupMessage(message)
		const shouldReply = resolveBotTrigger({
			isDM: !isGroup,
			isMentioned: isGroup && isMentioned(message, runtimeConfig.BotWxid, runtimeConfig.BotNickname),
			canGroupTrigger: isGroup,
			whitelistId: chatId,
			senderId: message.fromUser,
			isOwner: !!(runtimeConfig.OwnerWxid
				? message.fromUser === runtimeConfig.OwnerWxid
				: message.fromUserName === runtimeConfig.OwnerUserName),
			isSelf: false, // 桥接层不推送 bot 自身消息
			isFromBot: false,
		}, runtimeConfig, {
			legacy: { privateKey: 'TriggerOnPrivate', groupKey: 'TriggerOnGroup', whitelistKey: 'TriggerGroups' },
			mentionKey: 'TriggerOnGroupMention',
			diag, logContext: `chatId="${chatId}"`,
		})
		if (shouldReply)
			await doMessageReply(message, chatId)
	}

	/**
	 * 分段发送回复文本+文件到指定目标（接口级单源：原 AddChatLogEntry 与主发送路径重复两份，
	 * 收口于此并供委派回程唤醒共用，防散写）。
	 * @param {string} replyTo - 发送目标（群=roomId，私聊=wxid，与 chatId 同值）。
	 * @param {object} replyObj - beilu 聊天回复对象。
	 * @returns {Promise<string>} displayContent（供调用方记日志）。
	 */
	async function sendWechatReplyTo(replyTo, replyObj) {
		const rawContent = replyObj.content_for_show || replyObj.content || ''
		const displayContent = extractPlatformContent(rawContent, 'wechat')
		if (displayContent.trim()) {
			const chunks = splitWechatReply(displayContent)
			for (const chunk of chunks)
				await sendWechatMessage(runtimeConfig, replyTo, chunk)
		}
		if (replyObj.files?.length) {
			for (const file of replyObj.files) {
				if (file?.buffer)
					await sendWechatFile(runtimeConfig, replyTo, file)
			}
		}
		return displayContent
	}

	/**
	 * 委派回程唤醒轮（凛倾 07-09，与 discordbot DoDelegateWakeReply 同构）：
	 * <report> 落队列 → notifyBotDelegateReport → 此处出一轮无触发消息的主动生成
	 * （GetPrompt H2 注入工作报告 consume-once）→ 网关 message/send 主动发回委派发起会话。
	 * chatId 即发送目标本身（群=roomId，私聊=wxid）。依赖网关支持主动发送（sendWechatMessage 本就是主动接口）。
	 */
	async function DoDelegateWakeReply(chatId) {
		if (!runtimeConfig || !runtimeConfig.apiUrl) {
			diag.warn(`DoDelegateWakeReply: 网关未配置（bot 未就绪），放弃唤醒（报告等下轮注入）`)
			return
		}
		// T9 件4：自旋+独占槽骨架收口 botContentShared.runExclusiveWakeSlot（9 bot 逐字段）；try/catch 留 run 内（平台特异报错面）
		await runExclusiveWakeSlot(_mq.handlers, chatId, async () => {
			try {
				const chatName = `WeChat: ${chatId}`
				const wakeRequest = async () => {
					// 与消息链同构：线 id 本轮取一次，chatid 与 chat_log 读源共用。
					const _lineId = await resolveBotChatId(ownerUsername, botCharname, 'wechat')
					// 深度就地取：MAX_DEPTH 常量只存在于 ProcessWechatQueueItem/doMessageReply 各自作用域内，
					// 本唤醒轮函数拿不到（引用即 ReferenceError），故按同一表达式重算。
					const _maxDepth = runtimeConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
					return {
					supported_functions: { markdown: false, files: true, add_message: true },
					username: ownerUsername,
					// 与消息链同一 chatid，唤醒轮同线隔离（同 discordbot DoDelegateWakeReply 范式）
					chatid: _lineId,
					chat_name: chatName,
					char_id: botCharname,
					Charname: runtimeConfig.BotNickname || botCharname,
					UserCharname: runtimeConfig.OwnerUserName || 'user',
					ReplyToCharname: runtimeConfig.OwnerUserName || 'user',
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
						if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length))
							await sendWechatReplyTo(chatId, replyFromChar)
						return null
					},
					Update: wakeRequest,
					extension: { platform: 'wechat', chat_id: chatId, delegate_wake: true },
					}
				}
				// 接住请求对象（同 discordbot _wakeReq 范式）：落盘需要本轮 chatid
				const _wakeReq = await wakeRequest()
				const aiFinalReply = await charAPI.interfaces.chat.GetReply(_wakeReq)
				if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
					const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
					pushMessageLog({
						type: 'ai',
						chatId,
						chatName,
						author: runtimeConfig.BotNickname || botCharname,
						content: extractPlatformContent(rawContent, 'wechat'),
						fullContent: rawContent,
					})
					await sendWechatReplyTo(chatId, aiFinalReply)
					// [0726 上下文换源] 唤醒轮回复落盘（与消息轮同构，防两轮上下文分叉）
					await appendBotChatEntry(_wakeReq.chatid, {
						role: 'char', name: botCharname, charName: botCharname,
						content: aiFinalReply.content || '',
						content_for_show: aiFinalReply.content_for_show,
						files: aiFinalReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`))
				}
			} catch (error) {
				diag.error(`DoDelegateWakeReply: chat="${chatId}" 失败`, error)
				broadcastBotError({ username: ownerUsername, platform: 'wechatbot', botname: botCharname, phase: 'runtime', error })
			}
		}, { onBusy: () => diag.warn(`DoDelegateWakeReply: chat="${chatId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) })
	}

	/**
	 * 生成并发送 AI 回复。
	 * @param {object} message - 触发回复的微信消息对象。
	 * @param {string} chatId - 会话 ID。
	 * @returns {Promise<void>}
	 */
	async function doMessageReply(message, chatId) {
		diag.time(`doMessageReply:${message.msgId}`)
		diag.log(
			`doMessageReply: msgId="${message.msgId}", chatId="${chatId}", from="${message.fromUserName}"`,
		)

		const isGroup = isGroupMessage(message)
		// 确定回复目标（群聊回复群，私聊回复个人）
		const replyTo = isGroup ? message.chatRoom : message.fromUser

		const chatName = isGroup
			? `WeChat Group: ${message.chatRoom}`
			: `WeChat: ${message.fromUserName || message.fromUser}`

		try {
			const AddChatLogEntry = async (replyFromChar) => {
				if (replyFromChar && (replyFromChar.content || replyFromChar.files?.length)) {
					// 发送（文本分段+文件）走接口级单源 sendWechatReplyTo
					await sendWechatReplyTo(replyTo, replyFromChar)

					// 记录到 ChatLog
					const botEntry = await wechatMessageToLogEntry(
						{ msgId: `bot_${Date.now()}`, fromUserName: runtimeConfig.BotNickname || botCharname, timestamp: Date.now() / 1000 },
						true,
						replyFromChar.content,
					)
					if (!ChatLogs[chatId]) ChatLogs[chatId] = []
					ChatLogs[chatId].push(botEntry)
					ChatLogs[chatId] = mergeChatLog(ChatLogs[chatId])
					const MAX_DEPTH = runtimeConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
					while (ChatLogs[chatId].length > MAX_DEPTH)
						ChatLogs[chatId].shift()
				}
				return null
			}

			const generateChatReplyRequest = async () => {
				// 线 id 本轮取一次；深度就地取（MAX_DEPTH 常量在更深的块作用域内，此处拿不到）
				const _lineId = await resolveBotChatId(ownerUsername, botCharname, 'wechat')
				const _maxDepth = runtimeConfig.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
				return {
				supported_functions: {
					markdown: false, // 微信不支持 markdown
					files: true,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				chatid: _lineId,
				chat_name: chatName,
				char_id: botCharname,
				Charname: runtimeConfig.BotNickname || botCharname,
				UserCharname: runtimeConfig.OwnerUserName || message.fromUserName,
				ReplyToCharname: message.fromUserName,
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
					?? applyBotContentFilter((ChatLogs[chatId] || []).map((e) => ({ ...e })), ownerUsername),
				AddChatLogEntry,
				Update: async () => await generateChatReplyRequest(),
				extension: {
					platform: 'wechat',
					trigger_message_id: message.msgId,
					chat_id: chatId,
					is_group: isGroup,
				},
				}
			}

			// 记录用户消息到消息日志
			pushMessageLog({
				type: 'user',
				chatId,
				chatName,
				author: message.fromUserName || message.fromUser,
				content: formatWechatMessage(message),
			})

			// !chat/!skill 对话线管理命令（0716 推全壳，同 discord/telegram 接线形状；串行队列内 await，
			// 命中即回执并跳过 AI 生成）。owner 判定=入站归一侧 :192 同式（OwnerWxid 稳定 ID 优先，降级昵称）。
			{
				const _cmdIsOwner = runtimeConfig.OwnerWxid
					? message.fromUser === runtimeConfig.OwnerWxid
					: !!(runtimeConfig.OwnerUserName && (message.fromUserName || '') === runtimeConfig.OwnerUserName)
				const _cmdReply = await handleBotChatCommand({
					username: ownerUsername,
					charName: botCharname,
					platform: 'wechat',
					text: message.content || '',
					isOwner: _cmdIsOwner,
				})
				if (_cmdReply) {
					await sendWechatReplyTo(replyTo, { content: _cmdReply })
					diag.timeEnd(`doMessageReply:${message.msgId}`)
					return
				}
			}

			const chatRequest = await generateChatReplyRequest()
			const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest)

			if (aiFinalReply && (aiFinalReply.content || aiFinalReply.files?.length)) {
				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
				const displayContent = extractPlatformContent(rawContent, 'wechat')
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)

				// 记录 AI 回复到消息日志
				pushMessageLog({
					type: 'ai',
					chatId,
					chatName,
					author: runtimeConfig.BotNickname || botCharname,
					content: displayContent,
					thinking: thinkMatch ? thinkMatch[1].trim() : '',
					fullContent: rawContent,
				})

				// 发送（文本分段+文件）走接口级单源 sendWechatReplyTo
				await sendWechatReplyTo(replyTo, aiFinalReply)
				// [0726 上下文换源] 主轮 AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: 'char', name: botCharname, charName: botCharname,
					content: aiFinalReply.content || '',
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`))
			}

			diag.timeEnd(`doMessageReply:${message.msgId}`)
		} catch (error) {
			diag.error(`doMessageReply: msgId="${message.msgId}" 处理失败`, error)
			// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
			broadcastBotError({ username: ownerUsername, platform: 'wechatbot', botname: botCharname, phase: 'runtime', error })
			pushMessageLog({
				type: 'error',
				chatId,
				chatName,
				author: 'System',
				content: `回复失败: ${error.message || 'Unknown error'}`,
			})
			// 向用户发送错误提示
			try {
				await sendWechatMessage(runtimeConfig, replyTo, `[系统] 回复出现错误，请稍后再试。`)
			} catch (sendErr) {
				diag.error(`doMessageReply: 发送错误通知也失败`, sendErr)
			}
		}
	}

	return {
		/**
		 * 初始化接口，写入运行时配置。
		 * @param {object} config - bot 配置。
		 */
		Init: async (config) => {
			runtimeConfig = { ...config }
			diag.log(`SimpleWechatInterface.Init: apiUrl="${config.apiUrl}", char="${botCharname}"`)
			// 注册委派回程唤醒。registerBotDelegateWaker 是同 key 替换语义（幂等），Init 重入重复注册无害，不加守卫。
			registerBotDelegateWaker('wechat', ownerUsername, botCharname, async ({ channelId }) => {
				if (!channelId) return
				await DoDelegateWakeReply(channelId)
			})
		},

		/**
		 * 销毁接口，清理状态。
		 */
		Destroy: async () => {
			diag.log('SimpleWechatInterface.Destroy')
			runtimeConfig = {}
		},

		/**
		 * 处理一条 Webhook 推送的微信消息（由 bot.mjs 调用）。
		 * @param {object} message - Webhook 消息对象。
		 * @returns {Promise<void>}
		 */
		HandleMessage: async (message) => {
			diag.debug(`HandleMessage: msgId="${message.msgId}", type=${message.msgType}`)

			// 处理文本/图片/语音/视频/文件类型（msgType=1/3/34/43/49）
			const supportedTypes = new Set([1, 3, 34, 43, 49])
			if (!supportedTypes.has(message.msgType)) {
				diag.debug(`HandleMessage: msgType=${message.msgType} 暂不处理`)
				return
			}

			// 确定 chatId（群聊用 roomId，私聊用 fromUser）
			const chatId = isGroupMessage(message)
				? message.chatRoom
				: (message.fromUser || message.fromUserName)

			if (!chatId) {
				diag.warn('HandleMessage: 无法确定 chatId，忽略消息')
				return
			}

			// 群聊中去掉 @机器人 部分
			if (isGroupMessage(message) && message.content) {
				message = {
					...message,
					content: stripMention(message.content, runtimeConfig.BotNickname),
				}
			}

			_mq.enqueue(chatId, message)
		},

		GetBotConfigTemplate: GetSimpleBotConfigTemplate,

		/**
		 * 清除所有会话的上下文（只保留记忆表格）。
		 * @returns {{clearedChannels: number}}
		 */
		ClearContext: () => {
			const count = Object.keys(ChatLogs).length
			for (const key of Object.keys(ChatLogs))
				delete ChatLogs[key]
			for (const key of Object.keys(chat_scoped_char_memory))
				delete chat_scoped_char_memory[key]
			_msgLog.clear()
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文`)
			return { clearedChannels: count }
		},

		/**
		 * 获取当前活跃会话列表。
		 * @returns {Array<{chatId: string, messageCount: number}>}
		 */
		// [0716 链路归一] GetActiveChats→GetActiveChannels + chatId→channelId（discord 系统一契约，
		// 三层断链修复详注见 telegrambot 同位）。
		GetActiveChannels: () => {
			return Object.entries(ChatLogs).map(([channelId, logs]) => ({
				channelId,
				messageCount: logs.length,
			}))
		},

		/**
		 * 获取消息日志。
		 * @param {number} [since] - 只返回此时间戳之后的记录（可选）。
		 * @returns {{logs: Array, maxSize: number}}
		 */
		GetMessageLog: (since) => _msgLog.get(since),

		/**
		 * 设置消息日志最大条数。
		 * @param {number} size - 最大条数（1-200）。
		 * @returns {{maxSize: number}}
		 */
		SetMessageLogSize: (size) => _msgLog.setSize(size),
	}
}

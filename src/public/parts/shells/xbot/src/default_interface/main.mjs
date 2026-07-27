import { clearInterval, setInterval } from 'node:timers'

import { localhostLocales } from '../../../../../../scripts/i18n.mjs'
import { applyBotContentFilter, loadAllDefaultPlugins, extractPlatformContentShared, checkBotTriggerAllowed, resolveBotPermissionLevel, withBotPermissionDefaults, sanitizeExternalMessage, createBotMessageLog, loadOwnerPersona, registerBotDelegateWaker, runExclusiveWakeSlot, handleBotChatCommand, resolveBotChatId, appendBotChatEntry, buildBotChatLogFromFile, BOT_MSG_MERGE_WINDOW_MS, BOT_DEFAULT_MAX_MESSAGE_DEPTH } from '../../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../../server/diagLogger.mjs'
// BR2: runtime 错误外显——GetReply 失败时广播到前端红点
import { broadcastBotError } from '../../../botErrorBroadcast.mjs'

import { splitXReply, splitDMReply, formatDMEventContent, formatMentionContent } from './tools.mjs'

const diag = createDiag('xbot')

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签
 * @param {string} content - AI 完整回复
 * @param {string} displayTag - 平台标签名（如 "discord"、"telegram"、"xbot"）
 * @returns {string} 该平台应显示的内容
 */
function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag)
}

/**
 * 创建一个简单的 X Bot 接口。
 * @param {import('../../../../../../decl/charAPI.ts').CharAPI_t} charAPI - 角色 API 对象。
 * @param {string} ownerUsername - 所有者的用户名（beilu 用户名）。
 * @param {string} botCharname - 机器人角色的名称。
 * @returns {Promise<object>} 返回一个包含 X Bot 接口方法的 Promise。
 */
export async function createSimpleXBotInterface(charAPI, ownerUsername, botCharname) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error('charAPI.interfaces.chat.GetReply is required for SimpleXBotInterface.')

	/**
	 * @returns {object} 简单 Bot 配置模板（行为平层键，9 壳统一形）
	 * P4 凭据外层归一（0716）：原 xbot 独有包装形 {appKey..., char, config:{行为}} 纯删——
	 * 该形是 config.config.config 错位存量病的病根（前端 _applyTemplate 把整模板铺进 config 子对象）。
	 * 凭据（appKey/appSecret/accessToken/accessSecret）与 char 归其正主：前端 schema.conn 静态字段
	 * + char 选择器管理，存储在 bot 配置顶层（bot.mjs :19-21 读 config.appKey 不变）；模板只下发
	 * 行为键（前端 _vcBehaviorRoot 对平层形原样透传，存量错位配置仍由其读侧下钻自愈）。
	 */
	function GetSimpleBotConfigTemplate() {
		return {
			OwnerUserName: '',       // 主人的 X 用户名（不含 @，用于身份识别：匹配则原文直入，否则按外部用户 sanitize）
			MaxMessageDepth: BOT_DEFAULT_MAX_MESSAGE_DEPTH,
			// ---- 触发模式配置 ----
			// X 平台只有 DM 与 @提及 两种进站途径，没有 discord 的"频道/服务器"概念，
			// 因此 discord 模板里的 TriggerOnMessage / TriggerChannels(白名单) 在 X 上不适用(N/A)。
			// P4 键名归一（discord 系统一命名）：旧键 TriggerOnDM 停发（dingtalk 0716 病征3先例），
			// 读侧保留旧键回退以兼容存量配置。
			PrivateChatEnabled: true, // 私信触发（discord 系统一命名）
			TriggerOnMention: true,  // @提及触发（等价 discord TriggerOnMention）
			PollIntervalMs: 30000,   // 轮询间隔（毫秒）
			MaxTweetLength: 280,     // 推文最大长度（普通账号 280，Premium 10000）
			// 每日发帖预算（官方 X API Free 层 50 posts/天，回复也计数；0716 官方规则调研）。
			// 默认 45 留官方余量；0=禁发帖（DM 回复不占此额度）。付费层用户可上调。
			DailyPostBudget: 45,
			...withBotPermissionDefaults({}), // C6: TriggerMode / AllowedUserIDs / Owner+Default PermissionLevel
		}
	}

	// ---- 加载所有默认 plugin（与 beilu-chat 一致的完整消息管线） ----
	// [0716 P3 件10] 插件全量加载收口 loadAllDefaultPlugins（botContentShared）——原 9 壳同构段纯删。
	const allPlugins = await loadAllDefaultPlugins(ownerUsername, diag)

	// ---- 每日发帖预算护栏（官方 X API Free 层 50 posts/天，回复也计数；「按照官方的来」0716）----
	// 单源计数：所有 client.tweet 调用点发前取额，超限=跳过发送记 warn（诚实降级可见，防超限违规/封号）。
	// UTC 日窗与官方额度重置对齐；DM（sendDmInConversation）不占发帖额度。
	let _postCount = 0, _postCountDay = ''
	function takePostBudget(config) {
		const day = new Date().toISOString().slice(0, 10)
		if (day !== _postCountDay) { _postCountDay = day; _postCount = 0 }
		const budget = Number(config?.DailyPostBudget ?? 45)
		if (_postCount >= budget) {
			diag.warn(`takePostBudget: 今日发帖预算已用尽（${_postCount}/${budget}，官方 Free 层 50/天），跳过本次发帖`)
			return false
		}
		_postCount++
		return true
	}

	// ---- 上下文存储 ----
	// DM 会话: key = conversationId
	// mention 会话: key = "mention:" + authorId
	const chatLogs = {}      // Record<string, chatLogEntry[]>
	const chat_scoped_char_memory = {}

	// ---- 消息日志环形缓冲区（T9 件2：收口 botContentShared.createBotMessageLog，原逐字私有实现纯删）----
	const _msgLog = createBotMessageLog()
	const pushMessageLog = (entry) => _msgLog.push(entry)

	// ---- 轮询状态 ----
	let lastDmEventId = null
	let lastMentionId = null

	/**
	 * X Bot 主轮询函数，由 bot.mjs 的 startBot 调用。
	 * @param {import('npm:twitter-api-v2').TwitterApi} twitterClient - twitter-api-v2 客户端（内部用 .v2 / .v1 accessor）
	 * @param {{id: string, username: string, name: string}} me - Bot 自身信息
	 * @param {object} config - 行为配置（来自 botConfig.config）
	 * @returns {Promise<Function>} stopPolling - 停止轮询的函数（async，调用方需 await）
	 */
	async function OnBotReady(twitterClient, me, config) {
		const client = twitterClient.v2
		const MAX_MESSAGE_DEPTH = config.MaxMessageDepth || BOT_DEFAULT_MAX_MESSAGE_DEPTH
		const POLL_MS = config.PollIntervalMs || 30000
		const MAX_TWEET_LENGTH = config.MaxTweetLength || 280
		// P4 键名归一：PrivateChatEnabled ← TriggerOnDM（dingtalk 先例同式，读侧回退保存量；两读点单源防散写）
		const _dmEnabled = () => config.PrivateChatEnabled !== undefined
			? config.PrivateChatEnabled !== false
			: config.TriggerOnDM !== false

		diag.log(`OnBotReady: botId="${me.id}", @${me.username}, pollInterval=${POLL_MS}ms`)

		// ---- 初始化：获取最新 DM event ID 和 mention ID，避免启动时重复处理历史消息 ----
		try {
			if (_dmEnabled()) {
				const initDm = await client.listDmEvents({ max_results: 1 })
				if (initDm?.data?.length)
					lastDmEventId = initDm.data[0].id
				diag.debug(`OnBotReady: 初始化 lastDmEventId="${lastDmEventId}"`)
			}
		} catch (e) {
			diag.warn('OnBotReady: 初始化 DM since_id 失败（可能无权限）:', e.message)
		}

		try {
			if (config.TriggerOnMention !== false) {
				const initMentions = await client.userMentionTimeline(me.id, { max_results: 5 })
				if (initMentions?.data?.data?.length)
					lastMentionId = initMentions.data.data[0].id
				diag.debug(`OnBotReady: 初始化 lastMentionId="${lastMentionId}"`)
			}
		} catch (e) {
			diag.warn('OnBotReady: 初始化 mention since_id 失败（可能无权限）:', e.message)
		}

		// ---- 轮询 DM 事件 ----
		async function pollDMs() {
			try {
				const params = {
					max_results: 50,
					'dm_event.fields': ['id', 'text', 'created_at', 'sender_id', 'dm_conversation_id', 'attachments'],
					expansions: ['sender_id'],
					'user.fields': ['username', 'name'],
				}
				if (lastDmEventId) params.since_id = lastDmEventId

				const result = await client.listDmEvents(params)
				if (!result?.data?.length) return

				// API 返回最新在前，我们需要从旧到新处理
				const events = [...result.data].reverse()
				const usersMap = {}
				for (const u of result.includes?.users || [])
					usersMap[u.id] = u

				for (const dmEvent of events) {
					// 跳过自己发出的消息
					if (dmEvent.sender_id === me.id) {
						if (!lastDmEventId || BigInt(dmEvent.id) > BigInt(lastDmEventId))
							lastDmEventId = dmEvent.id
						continue
					}

					const sender = usersMap[dmEvent.sender_id] || { username: `user_${dmEvent.sender_id}`, name: `User` }
					const convId = dmEvent.dm_conversation_id
					const text = formatDMEventContent(dmEvent)

					diag.debug(`pollDMs: 新DM from @${sender.username}, convId="${convId}", text="${text.slice(0, 50)}"`)

					// 记录用户消息到上下文
					const convKey = `dm:${convId}`
					if (!chatLogs[convKey]) chatLogs[convKey] = []

					const userEntry = {
						time_stamp: new Date(dmEvent.created_at).getTime() || Date.now(),
						role: sender.username === config.OwnerUserName ? 'user' : 'char',
						name: sender.name || sender.username,
						content: sender.username === config.OwnerUserName
							? text
							: sanitizeExternalMessage(text, sender.name || sender.username, 'x'),
						files: [],
						// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
						_sourceType: 'bot',
						_permissionLevel: resolveBotPermissionLevel(config, dmEvent.sender_id, sender.username === config.OwnerUserName),
						extension: { xbot_dm_event_id: dmEvent.id, xbot_conv_id: convId },
					}

					// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
					//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
					try {
						await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, 'x'), {
							role: userEntry.role, name: userEntry.name, content: userEntry.content,
							files: userEntry.files, extension: userEntry.extension,
							_sourceType: userEntry._sourceType, _permissionLevel: userEntry._permissionLevel,
						})
					} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`) }
					chatLogs[convKey].push(userEntry)
					while (chatLogs[convKey].length > MAX_MESSAGE_DEPTH)
						chatLogs[convKey].shift()

					pushMessageLog({
						type: 'user',
						channelId: convId,
						channelName: `DM: @${sender.username}`,
						author: sender.name || sender.username,
						content: text,
					})

					// 更新游标
					if (!lastDmEventId || BigInt(dmEvent.id) > BigInt(lastDmEventId))
						lastDmEventId = dmEvent.id

					// C6: 用户级触发白名单（叠加在 DM 触发之后）。非白名单忽略不消耗 Token 但记日志。
					if (!checkBotTriggerAllowed(config, dmEvent.sender_id, sender.username === config.OwnerUserName)) {
						diag.log(`触发白名单已忽略: DM from @${sender.username} (id=${dmEvent.sender_id})`)
						continue
					}

					// !chat/!skill 对话线管理命令（0716 推全壳，同 discord 接线形状）。接线点在 poll 循环内
					//（原始 text 只在此处可得，doDMReply 不接收文本）；for-await 串行=命令生效顺序与消息顺序一致。
					{
						const _cmdReply = await handleBotChatCommand({
							username: ownerUsername,
							charName: botCharname,
							platform: 'x',
							text,
							isOwner: sender.username === config.OwnerUserName,
						})
						if (_cmdReply) {
							await client.sendDmInConversation(convId, { text: _cmdReply })
							continue
						}
					}

					// 触发回复
					await doDMReply(client, convId, convKey, sender, me, config, MAX_MESSAGE_DEPTH, MAX_TWEET_LENGTH)
				}
			} catch (e) {
				diag.error('pollDMs: 轮询失败', e)
			}
		}

		// ---- 轮询 @提及 ----
		async function pollMentions() {
			try {
				const params = {
					max_results: 10,
					'tweet.fields': ['id', 'text', 'created_at', 'author_id', 'in_reply_to_user_id'],
					expansions: ['author_id'],
					'user.fields': ['username', 'name'],
				}
				if (lastMentionId) params.since_id = lastMentionId

				const result = await client.userMentionTimeline(me.id, params)
				if (!result?.data?.data?.length) return

				const tweets = [...result.data.data].reverse()
				const usersMap = {}
				for (const u of result.data.includes?.users || [])
					usersMap[u.id] = u

				for (const tweet of tweets) {
					// 跳过自己的推文
					if (tweet.author_id === me.id) {
						if (!lastMentionId || BigInt(tweet.id) > BigInt(lastMentionId))
							lastMentionId = tweet.id
						continue
					}

					const author = usersMap[tweet.author_id] || { username: `user_${tweet.author_id}`, name: 'User' }
					const text = formatMentionContent(tweet, me.username)

					diag.debug(`pollMentions: 新@提及 from @${author.username}, tweetId="${tweet.id}", text="${text.slice(0, 50)}"`)

					// 使用 authorId 作为 mention 会话 key
					const convKey = `mention:${tweet.author_id}`
					if (!chatLogs[convKey]) chatLogs[convKey] = []

					const userEntry = {
						time_stamp: new Date(tweet.created_at).getTime() || Date.now(),
						role: author.username === config.OwnerUserName ? 'user' : 'char',
						name: author.name || author.username,
						content: author.username === config.OwnerUserName
							? text
							: sanitizeExternalMessage(text, author.name || author.username, 'x'),
						files: [],
						// C6: bot 来源标记 + 独立权限等级（供下游消费端按 L0-L3 裁决；接入能力裁决属 K7 未接）
						_sourceType: 'bot',
						_permissionLevel: resolveBotPermissionLevel(config, tweet.author_id, author.username === config.OwnerUserName),
						extension: { xbot_tweet_id: tweet.id },
					}

					// [0726 上下文换源] 每条平台消息落对话文件，且必须在构建请求**之前**（否则本轮 chat_log 缺当前这条）。
					//   _sourceType/_permissionLevel 一并带：N42 档位门取尾条判定（chatOps.appendBotChatEntry 透传）。
					try {
						await appendBotChatEntry(await resolveBotChatId(ownerUsername, botCharname, 'x'), {
							role: userEntry.role, name: userEntry.name, content: userEntry.content,
							files: userEntry.files, extension: userEntry.extension,
							_sourceType: userEntry._sourceType, _permissionLevel: userEntry._permissionLevel,
						})
					} catch (e) { diag.warn(`bot 对话文件用户消息落盘失败（本轮回退壳内存）: ${e?.message || e}`) }
					chatLogs[convKey].push(userEntry)
					while (chatLogs[convKey].length > MAX_MESSAGE_DEPTH)
						chatLogs[convKey].shift()

					pushMessageLog({
						type: 'user',
						channelId: `mention:${tweet.author_id}`,
						channelName: `@提及: @${author.username}`,
						author: author.name || author.username,
						content: text,
					})

					if (!lastMentionId || BigInt(tweet.id) > BigInt(lastMentionId))
						lastMentionId = tweet.id

					// C6: 用户级触发白名单（叠加在 @提及 触发之后）。非白名单忽略不消耗 Token 但记日志。
					if (!checkBotTriggerAllowed(config, tweet.author_id, author.username === config.OwnerUserName)) {
						diag.log(`触发白名单已忽略: @提及 from @${author.username} (id=${tweet.author_id})`)
						continue
					}

					// !chat/!skill 对话线管理命令（0716 推全壳，同 DM 侧；回执=回推文成线程）。
					{
						const _cmdReply = await handleBotChatCommand({
							username: ownerUsername,
							charName: botCharname,
							platform: 'x',
							text,
							isOwner: author.username === config.OwnerUserName,
						})
						if (_cmdReply) {
							try {
								if (takePostBudget(config))
								await client.tweet(_cmdReply.slice(0, MAX_TWEET_LENGTH), { reply: { in_reply_to_tweet_id: tweet.id } })
							} catch (e) { diag.error('命令回执回推失败', e) }
							continue
						}
					}

					// 触发回复
					await doMentionReply(client, tweet, convKey, author, me, config, MAX_MESSAGE_DEPTH, MAX_TWEET_LENGTH)
				}
			} catch (e) {
				diag.error('pollMentions: 轮询失败', e)
			}
		}

		// ---- DM 回复处理 ----
		async function doDMReply(client, convId, convKey, sender, me, config, maxDepth, maxLen) {
			diag.time(`doDMReply:${convId}`)
			try {
				const chatRequest = await buildChatRequest({
					chatName: `X DM with @${sender.username}`,
					replyToName: sender.name || sender.username,
					convKey,
					platform: 'x',
					channelType: 'x_dm',
					convId,
					maxDepth,
				})

				const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest)
				if (!aiFinalReply?.content) {
					diag.debug(`doDMReply: AI无回复内容，跳过`)
					return
				}

				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
				const displayContent = extractPlatformContent(rawContent, 'xbot')
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)

				pushMessageLog({
					type: 'ai',
					channelId: convId,
					channelName: `DM: @${sender.username}`,
					author: me.name || me.username,
					content: displayContent,
					thinking: thinkMatch ? thinkMatch[1].trim() : '',
					fullContent: rawContent,
				})

				// 上传图片附件（仅支持图片，其他文件类型跳过）
				const mediaIds = []
				for (const file of (aiFinalReply.files || [])) {
					const mime = (file.mime_type || '').toLowerCase()
					if (!mime.startsWith('image/')) {
						diag.warn(`doDMReply: 跳过非图片文件 "${file.name}" (${mime})`)
						continue
					}
					try {
						const mediaId = await twitterClient.v1.uploadMedia(Buffer.from(file.buffer), { mimeType: mime || 'image/png' })
						mediaIds.push(mediaId)
						diag.debug(`doDMReply: 已上传图片 "${file.name}", mediaId="${mediaId}"`)
					} catch (e) {
						diag.error(`doDMReply: 上传图片 "${file.name}" 失败`, e)
					}
				}

				// DM 无字数限制问题（10000字），按 10000 拆分
				const chunks = splitDMReply(displayContent, 10000)
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]
					if (!chunk.trim()) continue
					// 仅在最后一段附带媒体
					const isLast = i === chunks.length - 1
					const dmPayload = { text: chunk }
					if (isLast && mediaIds.length)
						dmPayload.attachments = mediaIds.map(id => ({ media_id: id }))
					await client.sendDmInConversation(convId, dmPayload)
					diag.debug(`doDMReply: 已发送 DM chunk, convId="${convId}", len=${chunk.length}${isLast && mediaIds.length ? `, mediaIds=${mediaIds.join(',')}` : ''}`)
				}

				// 将 AI 回复也加入上下文
				const aiEntry = {
					...aiFinalReply,
					time_stamp: Date.now(),
					role: 'char',
					name: me.name || me.username,
					content: displayContent,
					files: [],
					extension: { xbot_sent: true },
				}
				// [0726 上下文换源] AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: 'char', name: aiEntry.name, charName: botCharname,
					content: aiFinalReply.content || '',
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`))
				chatLogs[convKey].push(aiEntry)
				while (chatLogs[convKey].length > maxDepth)
					chatLogs[convKey].shift()

			} catch (e) {
				diag.error(`doDMReply: convId="${convId}" 处理失败`, e)
				// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
				broadcastBotError({ platform: 'xbot', botname: botCharname, phase: 'runtime', error: e })
			} finally {
				diag.timeEnd(`doDMReply:${convId}`)
			}
		}

		// ---- @提及回复处理 ----
		async function doMentionReply(client, tweet, convKey, author, me, config, maxDepth, maxLen) {
			diag.time(`doMentionReply:${tweet.id}`)
			try {
				const chatRequest = await buildChatRequest({
					chatName: `X @提及 from @${author.username}`,
					replyToName: author.name || author.username,
					convKey,
					platform: 'x',
					channelType: 'x_mention',
					convId: tweet.id,
					maxDepth,
				})

				const aiFinalReply = await charAPI.interfaces.chat.GetReply(chatRequest)
				if (!aiFinalReply?.content) {
					diag.debug(`doMentionReply: AI无回复内容，跳过`)
					return
				}

				const rawContent = aiFinalReply.content_for_show || aiFinalReply.content || ''
				const displayContent = extractPlatformContent(rawContent, 'xbot')
				const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)

				pushMessageLog({
					type: 'ai',
					channelId: `mention:${tweet.author_id}`,
					channelName: `@提及: @${author.username}`,
					author: me.name || me.username,
					content: displayContent,
					thinking: thinkMatch ? thinkMatch[1].trim() : '',
					fullContent: rawContent,
				})

				// 上传图片附件（仅支持图片，其他文件类型跳过）
				const mediaIds = []
				for (const file of (aiFinalReply.files || [])) {
					const mime = (file.mime_type || '').toLowerCase()
					if (!mime.startsWith('image/')) {
						diag.warn(`doMentionReply: 跳过非图片文件 "${file.name}" (${mime})`)
						continue
					}
					try {
						const mediaId = await twitterClient.v1.uploadMedia(Buffer.from(file.buffer), { mimeType: mime || 'image/png' })
						mediaIds.push(mediaId)
						diag.debug(`doMentionReply: 已上传图片 "${file.name}", mediaId="${mediaId}"`)
					} catch (e) {
						diag.error(`doMentionReply: 上传图片 "${file.name}" 失败`, e)
					}
				}

				// 推文按 maxLen 拆分，形成回复线程
				const chunks = splitXReply(displayContent, maxLen)
				let replyToId = tweet.id
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]
					if (!chunk.trim()) continue
					if (!takePostBudget(config)) break // 预算尽=后续分段同样发不了，整线程止于此
					// 仅在最后一段附带媒体（最多4张）
					const isLast = i === chunks.length - 1
					const tweetPayload = { reply: { in_reply_to_tweet_id: replyToId } }
					if (isLast && mediaIds.length)
						tweetPayload.media = { media_ids: mediaIds.slice(0, 4) }
					const sent = await client.tweet(chunk, tweetPayload)
					replyToId = sent?.data?.id || replyToId
					diag.debug(`doMentionReply: 已回复推文, replyToId="${replyToId}", len=${chunk.length}${isLast && mediaIds.length ? `, mediaIds=${mediaIds.slice(0, 4).join(',')}` : ''}`)
				}

				// 将 AI 回复也加入上下文
				const aiEntry = {
					...aiFinalReply,
					time_stamp: Date.now(),
					role: 'char',
					name: me.name || me.username,
					content: displayContent,
					files: [],
					extension: { xbot_sent: true, xbot_tweet_id: replyToId },
				}
				// [0726 上下文换源] AI 回复落盘——否则文件里只有用户消息，AI 看不到自己上一轮说过什么
				await appendBotChatEntry(chatRequest.chatid, {
					role: 'char', name: aiEntry.name, charName: botCharname,
					content: aiFinalReply.content || '',
					content_for_show: aiFinalReply.content_for_show,
					files: aiFinalReply.files || [],
				}).catch((e) => diag.warn(`bot 对话文件 AI 回复落盘失败: ${e?.message || e}`))
				chatLogs[convKey].push(aiEntry)
				while (chatLogs[convKey].length > maxDepth)
					chatLogs[convKey].shift()

			} catch (e) {
				diag.error(`doMentionReply: tweetId="${tweet.id}" 处理失败`, e)
				// BR2: runtime 错误外显到前端 [O] 监控红点（phase=runtime）
				broadcastBotError({ platform: 'xbot', botname: botCharname, phase: 'runtime', error: e })
			} finally {
				diag.timeEnd(`doMentionReply:${tweet.id}`)
			}
		}

		// ---- 构建聊天请求 ----
		async function buildChatRequest({ chatName, replyToName, convKey, platform, channelType, convId, maxDepth }) {
			// 线 id 本轮取一次：chatid 字段与 chat_log 读源共用，避免同一请求解析两遍。
			const _lineId = await resolveBotChatId(ownerUsername, botCharname, 'x')
			return {
				supported_functions: {
					markdown: false, // X 不支持 markdown 渲染
					files: true,
					add_message: true,
				},
				username: ownerUsername,
				// bot 对话文件线（凛倾 07-09）：chatid=线级状态（预设/子模式/记忆）读侧键，与
				// !skill/!chat 命令与 bot 面板的写侧同源；缺它则读侧退化成 chat_name 字符串=半接线。
				// buildChatRequest 是本壳唯一请求构建点（消息链与唤醒轮共用），故只此一处。
				chatid: _lineId,
				chat_name: chatName,
				char_id: botCharname,
				Charname: me.name || me.username,
				UserCharname: config.OwnerUserName || ownerUsername,
				ReplyToCharname: replyToName,
				locales: localhostLocales,
				time: new Date(),
				world: null,
				user: await loadOwnerPersona(ownerUsername), // T9 件3：10 bot 逐字段收口 botContentShared
				char: charAPI,
				other_chars: [],
				plugins: allPlugins,
				chat_scoped_char_memory,
				// [0726 上下文换源] 优先取对话文件（与 web 正线 requestBuilder:142 同源）；?? 兜底壳内存
				chat_log: (await buildBotChatLogFromFile(_lineId, ownerUsername, { maxDepth }))
					?? applyBotContentFilter((chatLogs[convKey] || []).map(e => ({ ...e })), ownerUsername),
				AddChatLogEntry: async () => null,
				Update: async () => buildChatRequest({ chatName, replyToName, convKey, platform, channelType, convId, maxDepth }),
				extension: {
					platform,
					channel_type: channelType,
					conv_id: convId,
				},
			}
		}

		// ---- 启动定时轮询 ----
		let stopped = false
		// 单飞闸：一轮 poll（网络 + AI GetReply）可能远超 POLL_MS，setInterval 不等上一轮完成即触发下一轮，
		// 两轮并发共享 lastDmEventId/lastMentionId 游标（尚未推进）会用同一 since_id 重复拉取 → 重复回复。
		// in-flight 时跳过本 tick，游标推进串行化，根治重入竞态（非吞错补丁：漏拉的消息下一 tick 照常拉）。
		// [0716 委派回程接线] 原 `let polling` 布尔闸改为 XHandlers 槽（runExclusiveWakeSlot 共享件同款
		//   形状）：xbot 的串行域=全局（poll 循环内 for-await 串行，非 telegram 的 per-chat 队列），
		//   waker 与轮询共用 'poll:global' 槽即得与用户消息处理互斥——等价 telegram ChatHandlers 语义。
		const XHandlers = {}
		const POLL_SLOT = 'poll:global'
		const pollOnce = async () => {
			if (stopped || XHandlers[POLL_SLOT]) return
			const _run = (async () => {
				try {
					if (_dmEnabled()) await pollDMs()
					if (config.TriggerOnMention !== false) await pollMentions()
				} finally {
					delete XHandlers[POLL_SLOT]
				}
			})()
			XHandlers[POLL_SLOT] = _run
			await _run
		}

		/**
		 * 委派回程唤醒轮（与 telegram/discord DoDelegateWakeReply 同构；xbot 原为 10 壳唯一漏接线——
		 * replyHandler sourceChannelId 提取清单含 x=conv_id、后端登记侧早已备好，壳侧不注册=回程死路）：
		 * <report> 落队列 → notifyBotDelegateReport(platform='x'，extension.platform 原值) → 此处出一轮
		 * 无触发消息的主动生成（GetPrompt H2 注入工作报告 consume-once）→ 发回委派发起会话。
		 * channelId=委派发起轮的 extension.conv_id：DM 轮=dm_conversation_id，@提及轮=tweet.id，
		 * 两者同为数字串无法从形状区分 → 按 chatLogs 反查（dm:<id> 键直存；mention 会话从
		 * entries.extension.xbot_tweet_id/xbot_conv_id 反查，发起轮消息必已入上下文）。
		 */
		async function DoDelegateWakeReply(channelId) {
			await runExclusiveWakeSlot(XHandlers, POLL_SLOT, async () => {
				try {
					let convKey = chatLogs[`dm:${channelId}`] ? `dm:${channelId}` : null
					if (!convKey)
						for (const k of Object.keys(chatLogs)) {
							if (!k.startsWith('mention:')) continue
							if ((chatLogs[k] || []).some(e => e?.extension?.xbot_tweet_id === channelId || e?.extension?.xbot_conv_id === channelId)) { convKey = k; break }
						}
					if (!convKey) {
						diag.warn(`DoDelegateWakeReply: channelId="${channelId}" 未匹配任何会话（上下文已清/bot 重启丢内存态），报告等下轮注入`)
						return
					}
					const isDM = convKey.startsWith('dm:')
					const _entries = chatLogs[convKey] || []
					const _lastUser = [..._entries].reverse().find(e => e?.role === 'user' || e?._sourceType === 'bot')
					const replyToName = _lastUser?.name || config.OwnerUserName || 'User'
					const chatRequest = await buildChatRequest({
						chatName: isDM ? `X DM with @${replyToName}` : `X @提及 from @${replyToName}`,
						replyToName,
						convKey,
						platform: 'x',
						channelType: isDM ? 'x_dm' : 'x_mention',
						convId: channelId,
						maxDepth: MAX_MESSAGE_DEPTH,
					})
					chatRequest.extension.delegate_wake = true
					const aiReply = await charAPI.interfaces.chat.GetReply(chatRequest)
					if (!aiReply?.content) {
						diag.debug('DoDelegateWakeReply: AI无回复内容，跳过')
						return
					}
					const rawContent = aiReply.content_for_show || aiReply.content || ''
					const displayContent = extractPlatformContent(rawContent, 'xbot')
					const thinkMatch = rawContent.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)
					pushMessageLog({
						type: 'ai',
						channelId: isDM ? channelId : convKey,
						channelName: isDM ? `DM: @${replyToName}` : `@提及: @${replyToName}`,
						author: me.name || me.username,
						content: displayContent,
						thinking: thinkMatch ? thinkMatch[1].trim() : '',
						fullContent: rawContent,
					})
					if (isDM) {
						const chunks = splitDMReply(displayContent, 10000)
						for (const chunk of chunks) {
							if (!chunk.trim()) continue
							await client.sendDmInConversation(channelId, { text: chunk })
						}
					} else {
						// @提及会话：回到该会话最近一条推文，形成线程延续
						const _lastTweet = [..._entries].reverse().find(e => e?.extension?.xbot_tweet_id)
						let replyToId = _lastTweet?.extension?.xbot_tweet_id || channelId
						const chunks = splitXReply(displayContent, MAX_TWEET_LENGTH)
						for (const chunk of chunks) {
							if (!chunk.trim()) continue
							if (!takePostBudget(config)) break // 预算尽=后续分段同样发不了
							const sent = await client.tweet(chunk, { reply: { in_reply_to_tweet_id: replyToId } })
							replyToId = sent?.data?.id || replyToId
						}
					}
					const aiEntry = {
						...aiReply,
						time_stamp: Date.now(),
						role: 'char',
						name: me.name || me.username,
						content: displayContent,
						files: [],
						extension: { xbot_sent: true },
					}
					// [0726 上下文换源] 唤醒轮回复落盘（本函数的回复变量名是 aiReply，非 aiFinalReply）
					await appendBotChatEntry(chatRequest.chatid, {
						role: 'char', name: aiEntry.name, charName: botCharname,
						content: aiReply.content || '',
						content_for_show: aiReply.content_for_show,
						files: aiReply.files || [],
					}).catch((e) => diag.warn(`bot 对话文件唤醒回复落盘失败: ${e?.message || e}`))
					chatLogs[convKey].push(aiEntry)
					while (chatLogs[convKey].length > MAX_MESSAGE_DEPTH)
						chatLogs[convKey].shift()
				} catch (error) {
					diag.error(`DoDelegateWakeReply: channelId="${channelId}" 失败`, error)
					broadcastBotError({ platform: 'xbot', botname: botCharname, phase: 'runtime', error })
				}
			}, { onBusy: () => diag.warn(`DoDelegateWakeReply: channelId="${channelId}" 持续繁忙，放弃本次唤醒（报告等下轮注入）`) })
		}

		// 注册委派回程唤醒（不显式注销：bot 停机后回调抛错由 notify 侧自愈摘除；platform 键='x' 与
		// buildChatRequest extension.platform 一致——replyHandler 按 sourceChannel="bot:x" slice 回 'x'）
		registerBotDelegateWaker('x', ownerUsername, botCharname, async ({ channelId }) => {
			if (!channelId || stopped) return
			await DoDelegateWakeReply(String(channelId))
		})

		// 不立即执行，等第一个轮询周期再拉取，避免启动瞬间与初始化游标的竞态
		const intervalHandle = setInterval(pollOnce, POLL_MS)

		diag.log(`OnBotReady: 轮询已启动，间隔 ${POLL_MS}ms`)

		return function stopPolling() {
			stopped = true
			clearInterval(intervalHandle)
			diag.log('stopPolling: X Bot 轮询已停止')
		}
	}

	return {
		GetBotConfigTemplate: GetSimpleBotConfigTemplate,
		OnBotReady,
		/**
		 * 清除所有会话的上下文（只保留记忆表格）
		 * @returns {{clearedChannels: number}}
		 */
		ClearContext: () => {
			const count = Object.keys(chatLogs).length
			for (const key of Object.keys(chatLogs))
				delete chatLogs[key]
			for (const key of Object.keys(chat_scoped_char_memory))
				delete chat_scoped_char_memory[key]
			_msgLog.clear()
			diag.log(`ClearContext: 已清除 ${count} 个会话的上下文和消息日志`)
			return { clearedChannels: count }
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
	}
}

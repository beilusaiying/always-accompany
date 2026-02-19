import info from './info.json' with { type: 'json' }

// ============================================================
// Bot 适配器抽象
// ============================================================

/**
 * @typedef {Object} BotAdapter
 * @property {string} id - 适配器 ID
 * @property {string} platform - 平台 ('discord' | 'qq' | 'telegram' | 'custom')
 * @property {string} name - 显示名称
 * @property {boolean} enabled - 是否启用
 * @property {Object} config - 平台配置 (token、webhook 等)
 * @property {string} status - 状态 ('disconnected' | 'connecting' | 'connected' | 'error')
 * @property {string} [errorMessage] - 错误信息
 * @property {number} messageCount - 已处理消息数
 * @property {number} lastActiveAt - 最后活跃时间
 */

/**
 * @typedef {Object} BotMessage
 * @property {string} platform - 来源平台
 * @property {string} adapterId - 适配器 ID
 * @property {string} userId - 用户 ID
 * @property {string} userName - 用户名
 * @property {string} channelId - 频道/群组 ID
 * @property {string} content - 消息内容
 * @property {string[]} [attachments] - 附件 URL 列表
 * @property {number} timestamp - 时间戳
 */

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

/**
 * 创建默认适配器配置
 * @param {string} platform
 * @returns {BotAdapter}
 */
function createAdapter(platform) {
	const templates = {
		discord: {
			token: '',
			prefix: '!',
			allowedChannels: [],
			allowedUsers: [],
		},
		qq: {
			protocol: 'ws',       // ws | http
			endpoint: 'ws://127.0.0.1:8080',
			selfId: '',
			prefix: '/',
			allowedGroups: [],
		},
		telegram: {
			token: '',
			prefix: '/',
			allowedChats: [],
		},
		custom: {
			webhookUrl: '',
			secret: '',
			format: 'json',
		},
	}

	return {
		id: generateId(),
		platform,
		name: `${platform} Bot`,
		enabled: false,
		config: templates[platform] || templates.custom,
		status: 'disconnected',
		errorMessage: '',
		messageCount: 0,
		lastActiveAt: 0,
	}
}

// ============================================================
// 消息桥接核心
// ============================================================

/**
 * 消息队列 — 存储来自各平台的待处理消息
 * 由后端 (endpoints.mjs) 推入，由 GetPrompt 消费
 * @type {BotMessage[]}
 */
let incomingQueue = []

/**
 * 回复队列 — 存储 AI 回复中要发给各平台的消息
 * 由 ReplyHandler 推入，由后端分发
 * @type {Object[]}
 */
let outgoingQueue = []

/**
 * 解析 AI 回复中的跨平台消息指令
 * @param {string} content - AI 回复内容
 * @returns {Object[]} 操作列表
 */
function parseBotOperations(content) {
	const ops = []

	// <bot_reply platform="discord" channel="123">content</bot_reply>
	const replyRegex = /<bot_reply\s+platform="(\w+)"(?:\s+channel="([^"]*)")?(?:\s+user="([^"]*)")?>([\s\S]*?)<\/bot_reply>/gi
	let match
	while ((match = replyRegex.exec(content)) !== null) {
		ops.push({
			type: 'reply',
			platform: match[1],
			channelId: match[2] || '',
			userId: match[3] || '',
			content: match[4].trim(),
			timestamp: Date.now(),
		})
	}

	return ops
}

// ============================================================
// 插件数据
// ============================================================

let pluginData = {
	enabled: false,             // 默认关闭，需要手动配置后启用
	adapters: [],               // BotAdapter[]
	messageHistory: [],         // 最近的跨平台消息记录
	maxHistory: 50,
	bridgeMode: 'selective',    // 'all' | 'selective' — 是否转发所有消息
	injectContext: true,        // 是否在 GetPrompt 中注入跨平台消息
	maxInjectMessages: 5,       // 最多注入多少条跨平台消息
}

// ============================================================
// beilu-agents 插件导出
// ============================================================

/**
 * beilu-agents 插件 — 跨应用 Bot 桥接
 *
 * 架构说明：
 * - 本插件定义适配器配置和消息桥接协议
 * - 实际的 WebSocket/HTTP 连接由 Shell 后端 (endpoints.mjs) 管理
 * - 本插件通过 GetPrompt 将跨平台消息注入对话
 * - 通过 ReplyHandler 解析 AI 回复中的 <bot_reply> 指令
 * - 后端轮询 outgoingQueue 并分发到各平台
 *
 * 数据流：
 * 平台消息 → endpoints.mjs → incomingQueue → GetPrompt → AI
 * AI → ReplyHandler → outgoingQueue → endpoints.mjs → 平台
 */
export default {
	info,
	Load: async () => {},
	Unload: async () => {},
	interfaces: {
		config: {
			GetData: async () => ({
				enabled: pluginData.enabled,
				adapters: pluginData.adapters,
				bridgeMode: pluginData.bridgeMode,
				injectContext: pluginData.injectContext,
				maxInjectMessages: pluginData.maxInjectMessages,
				maxHistory: pluginData.maxHistory,
				messageHistory: pluginData.messageHistory.slice(-10),
				// 供后端消费的队列
				_outgoingQueue: outgoingQueue,
				_incomingQueueLength: incomingQueue.length,
				_stats: {
					totalAdapters: pluginData.adapters.length,
					connectedAdapters: pluginData.adapters.filter(a => a.status === 'connected').length,
					totalMessages: pluginData.adapters.reduce((sum, a) => sum + a.messageCount, 0),
					pendingOutgoing: outgoingQueue.length,
				},
			}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						case 'addAdapter': {
							const adapter = createAdapter(data.platform || 'custom')
							if (data.config) adapter.config = { ...adapter.config, ...data.config }
							if (data.name) adapter.name = data.name
							pluginData.adapters.push(adapter)
							break
						}
						case 'removeAdapter': {
							pluginData.adapters = pluginData.adapters.filter(a => a.id !== data.adapterId)
							break
						}
						case 'updateAdapter': {
							const idx = pluginData.adapters.findIndex(a => a.id === data.adapter?.id)
							if (idx !== -1) {
								pluginData.adapters[idx] = { ...pluginData.adapters[idx], ...data.adapter }
							}
							break
						}
						case 'toggleAdapter': {
							const adapter = pluginData.adapters.find(a => a.id === data.adapterId)
							if (adapter) {
								adapter.enabled = !adapter.enabled
								if (!adapter.enabled) adapter.status = 'disconnected'
							}
							break
						}
						// 后端调用: 推入收到的消息
						case 'pushIncoming': {
							if (data.message) {
								incomingQueue.push(data.message)
								pluginData.messageHistory.push(data.message)
								// 更新适配器统计
								const adapter = pluginData.adapters.find(a => a.id === data.message.adapterId)
								if (adapter) {
									adapter.messageCount++
									adapter.lastActiveAt = Date.now()
								}
								// 限制队列和历史长度
								if (incomingQueue.length > 20) incomingQueue = incomingQueue.slice(-20)
								if (pluginData.messageHistory.length > pluginData.maxHistory) {
									pluginData.messageHistory = pluginData.messageHistory.slice(-pluginData.maxHistory)
								}
							}
							break
						}
						// 后端调用: 消费发出的消息
						case 'consumeOutgoing': {
							const consumed = [...outgoingQueue]
							outgoingQueue = []
							// 通过 _consumedMessages 返回
							pluginData._consumedMessages = consumed
							break
						}
						// 后端调用: 更新适配器状态
						case 'updateAdapterStatus': {
							const adapter = pluginData.adapters.find(a => a.id === data.adapterId)
							if (adapter) {
								if (data.status) adapter.status = data.status
								if (data.errorMessage !== undefined) adapter.errorMessage = data.errorMessage
							}
							break
						}
						case 'clearHistory': {
							pluginData.messageHistory = []
							incomingQueue = []
							break
						}
						default:
							break
					}
					return
				}

				if (data.enabled !== undefined) pluginData.enabled = data.enabled
				if (data.bridgeMode !== undefined) pluginData.bridgeMode = data.bridgeMode
				if (data.injectContext !== undefined) pluginData.injectContext = data.injectContext
				if (data.maxInjectMessages !== undefined) pluginData.maxInjectMessages = data.maxInjectMessages
				if (data.maxHistory !== undefined) pluginData.maxHistory = data.maxHistory
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入跨平台消息上下文
			 */
			GetPrompt: async (arg) => {
				if (!pluginData.enabled) return null
				if (!pluginData.injectContext) return null
				if (incomingQueue.length === 0) return null

				// 取出队列中的消息
				const messages = incomingQueue.splice(0, pluginData.maxInjectMessages)

				let text = '[Cross-Platform Messages]\n'
				text += 'The following messages were received from external platforms:\n\n'

				for (const msg of messages) {
					text += `[${msg.platform}] ${msg.userName} (${msg.channelId}): ${msg.content}\n`
				}

				text += '\nYou can reply to specific platforms using:\n'
				text += '<bot_reply platform="discord" channel="channel_id">Your reply</bot_reply>\n'

				return {
					text,
					role: 'system',
					name: 'beilu-agents',
				}
			},

			/**
			 * ReplyHandler: 解析 <bot_reply> 指令并加入发送队列
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const ops = parseBotOperations(reply.content)
				if (ops.length === 0) return false

				// 加入发送队列
				outgoingQueue.push(...ops)

				// 清除回复中的 bot_reply 标签
				reply.content = reply.content
					.replace(/<bot_reply[\s\S]*?<\/bot_reply>/gi, '')
					.trim()

				return false
			},
		},
	},
}
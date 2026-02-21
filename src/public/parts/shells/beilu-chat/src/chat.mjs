/**
 * beilu 聊天引擎 — 简化版
 * 基于 Fount chat.mjs 重写，去掉不必要的复杂性
 *
 * 去掉: is_VividChat / handleAutoReply / 频率系统 / 成就系统 / 通知系统
 *       world 劫持(AddChatLogEntry/MessageDelete/MessageEdit/GetChatLogForCharname)
 *       group greeting / copyChat / importChat
 * 修复: addchar Bug(getChatRequest在try外/char未加到LastTimeSlice/greeting不保存/30分钟删除)
 */

/** @typedef {import('../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../decl/worldAPI.ts').WorldAPI_t} WorldAPI_t */
/** @typedef {import('../../../../decl/userAPI.ts').UserAPI_t} UserAPI_t */
/** @typedef {import('../../../../decl/pluginAPI.ts').PluginAPI_t} PluginAPI_t */

import { Buffer } from 'node:buffer'
import fs from 'node:fs'

import { loadJsonFile, saveJsonFile } from '../../../../../scripts/json_loader.mjs'
import { getPartInfo } from '../../../../../scripts/locale.mjs'
import { getAllUserNames, getUserByUsername, getUserDictionary } from '../../../../../server/auth.mjs'
import { events } from '../../../../../server/events.mjs'
import { getAllDefaultParts, getAnyDefaultPart, getPartDetails, loadPart } from '../../../../../server/parts_loader.mjs'
import { skip_report } from '../../../../../server/server.mjs'
import { loadShellData, saveShellData } from '../../../../../server/setting_loader.mjs'

import { addfile, getfile } from './files.mjs'
import { buildPromptStruct, margeStructPromptChatLog, structPromptToSingleNoChatLog } from './prompt_struct.mjs'
import { createBufferedSyncPreviewUpdater, generateDiff } from './stream.mjs'

// ============================================================
// StreamManager — 流式生成任务管理（保留原样）
// ============================================================

const activeStreams = new Map()
const StreamManager = {
	create(chatId, messageId) {
		const streamId = crypto.randomUUID()
		const controller = new AbortController()

		const context = {
			chatId,
			messageId,
			lastMessage: { content: '', files: [] },
			controller,
		}

		activeStreams.set(streamId, context)

		const syncUpdate = createBufferedSyncPreviewUpdater((newMessage) => {
			if (context.controller.signal.aborted) return
			const slices = generateDiff(context.lastMessage, newMessage)
			if (slices.length > 0) {
				context.lastMessage = structuredClone(newMessage)
				broadcastChatEvent(chatId, {
					type: 'stream_update',
					payload: { messageId, slices },
				})
			}
		})

		return {
			id: streamId,
			signal: controller.signal,

			update(newMessage) {
				if (context.controller.signal.aborted) return
				syncUpdate(newMessage)
			},

			done() {
				activeStreams.delete(streamId)
			},

			abort(reason = 'User Aborted') {
				if (context.controller.signal.aborted) return
				const error = new Error(reason)
				error.name = 'AbortError'
				context.controller.abort(error)
				activeStreams.delete(streamId)
			},
		}
	},

	abortByMessageId(messageId) {
		for (const [id, ctx] of activeStreams)
			if (ctx.messageId === messageId) {
				if (ctx.controller.signal.aborted) continue
				const error = new Error('User Aborted')
				error.name = 'AbortError'
				ctx.controller.abort(error)
				activeStreams.delete(id)
				break
			}
	},

	abortAll(chatId) {
		for (const [id, ctx] of activeStreams)
			if (ctx.chatId === chatId) {
				if (ctx.controller.signal.aborted) continue
				const error = new Error('User Aborted')
				error.name = 'AbortError'
				ctx.controller.abort(error)
				activeStreams.delete(id)
			}
	},
}

// ============================================================
// 全局状态
// ============================================================

/** @type {Map<string, { username: string, primaryCharName: string, chatMetadata: chatMetadata_t | null }>} */
const chatMetadatas = new Map()
const chatUiSockets = new Map()
const typingStatus = new Map()

function updateTypingStatus(chatid, charname, delta) {
	if (!typingStatus.has(chatid)) typingStatus.set(chatid, new Map())
	const chatMap = typingStatus.get(chatid)
	const current = chatMap.get(charname) || 0
	const next = current + delta
	if (next <= 0) chatMap.delete(charname)
	else chatMap.set(charname, next)

	const typingList = Array.from(chatMap.keys())
	broadcastChatEvent(chatid, { type: 'typing_status', payload: { typingList } })
}

function getTypingList(chatid) {
	const chatMap = typingStatus.get(chatid)
	return chatMap ? Array.from(chatMap.keys()) : []
}

// ============================================================
// WebSocket 管理（修复：关闭时保存而非删除）
// ============================================================

export function registerChatUiSocket(chatid, ws) {
	if (!chatUiSockets.has(chatid))
		chatUiSockets.set(chatid, new Set())

	const socketSet = chatUiSockets.get(chatid)
	socketSet.add(ws)

	// 发送初始 typing 状态
	const typingList = getTypingList(chatid)
	if (typingList.length > 0)
		ws.send(JSON.stringify({ type: 'typing_status', payload: { typingList } }))

	ws.on('message', (message) => {
		try {
			const msg = JSON.parse(message)
			if (msg.type === 'stop_generation' && msg.payload?.messageId)
				StreamManager.abortByMessageId(msg.payload.messageId)
		} catch (e) {
			console.error('Error processing client websocket message:', e)
		}
	})

	ws.on('close', () => {
		socketSet.delete(ws)
		if (!socketSet.size && chatUiSockets.delete(chatid)) {
			StreamManager.abortAll(chatid)
			// 修复：关闭时保存并卸载内存，不再删除聊天
			const chatData = chatMetadatas.get(chatid)
			if (chatData?.chatMetadata) {
				saveChat(chatid).then(() => {
					chatData.chatMetadata = null // 卸载内存，下次访问时重新加载
				}).catch(err => console.error(`Failed to save chat ${chatid} on close:`, err))
			}
		}
	})
}

// ============================================================
// 广播 + 初始化
// ============================================================

function broadcastChatEvent(chatid, event) {
	const sockets = chatUiSockets.get(chatid)
	if (!sockets?.size) return

	const message = JSON.stringify(event)
	for (const ws of sockets)
		if (ws.readyState === ws.OPEN)
			ws.send(message)
}

function initializeChatMetadatas() {
	const users = getAllUserNames()
	for (const user of users) {
		const userDir = getUserDictionary(user)
		const charsDir = userDir + '/chars/'
		if (!fs.existsSync(charsDir)) continue

		// 扫描所有角色目录下的 chats/ 子目录
		const charDirs = fs.readdirSync(charsDir, { withFileTypes: true })
			.filter(d => d.isDirectory())
		for (const charDir of charDirs) {
			const chatsPath = charsDir + charDir.name + '/chats/'
			if (!fs.existsSync(chatsPath)) continue

			const chatFiles = fs.readdirSync(chatsPath).filter(file => file.endsWith('.json'))
			for (const file of chatFiles) {
				const chatid = file.replace('.json', '')
				if (!chatMetadatas.has(chatid))
					chatMetadatas.set(chatid, { username: user, primaryCharName: charDir.name, chatMetadata: null })
			}
		}

		// 兼容：扫描旧路径 shells/chat/chats/，自动迁移到 chars/{charName}/chats/
		const oldChatsDir = userDir + '/shells/chat/chats/'
		if (fs.existsSync(oldChatsDir)) {
			const chatFiles = fs.readdirSync(oldChatsDir).filter(file => file.endsWith('.json'))
			for (const file of chatFiles) {
				const chatid = file.replace('.json', '')
				if (chatMetadatas.has(chatid)) continue // 新路径已有，跳过

				// 尝试从聊天文件中提取角色名，进行自动迁移
				const oldPath = oldChatsDir + file
				let primaryCharName = ''
				try {
					const rawData = loadJsonFile(oldPath)
					// 从最后一条 chatLog 的 timeSlice.chars 提取第一个角色名
					const chatLog = rawData.chatLog || []
					if (chatLog.length > 0) {
						const lastEntry = chatLog[chatLog.length - 1]
						const chars = lastEntry.timeSlice?.chars || []
						if (Array.isArray(chars) && chars.length > 0) {
							primaryCharName = chars[0]
						}
					}
				} catch (e) {
					console.warn(`[chat] 读取旧聊天文件失败: ${oldPath}`, e.message)
				}

				if (primaryCharName) {
					// 迁移到新路径
					const newDir = userDir + '/chars/' + primaryCharName + '/chats'
					fs.mkdirSync(newDir, { recursive: true })
					const newPath = newDir + '/' + file
					try {
						fs.renameSync(oldPath, newPath)
						console.log(`[chat] 启动迁移: ${oldPath} → ${newPath}`)
						chatMetadatas.set(chatid, { username: user, primaryCharName, chatMetadata: null })
					} catch (e) {
						console.warn(`[chat] 启动迁移失败: ${oldPath}`, e.message)
						chatMetadatas.set(chatid, { username: user, primaryCharName: '', chatMetadata: null })
					}
				} else {
					// 无法提取角色名，保留在旧路径
					chatMetadatas.set(chatid, { username: user, primaryCharName: '', chatMetadata: null })
				}
			}
		}
	}
}

initializeChatMetadatas()

// ============================================================
// 数据结构：timeSlice_t（简化：去掉 chars_speaking_frequency）
// ============================================================

class timeSlice_t {
	/** @type {Record<string, CharAPI_t>} */
	chars = {}
	/** @type {Record<string, PluginAPI_t>} */
	plugins = {}
	/** @type {WorldAPI_t} */
	world
	/** @type {string} */
	world_id
	/** @type {UserAPI_t} */
	player
	/** @type {string} */
	player_id
	/** @type {Record<string, any>} */
	chars_memories = {}

	/** @type {string} 当前发言角色ID（临时） */
	charname
	/** @type {string} 当前发言玩家ID（临时） */
	playername
	/** @type {string} greeting 类型标记（临时，用于重新生成） */
	greeting_type

	copy() {
		return Object.assign(new timeSlice_t(), this, {
			charname: undefined,
			playername: undefined,
			greeting_type: undefined,
			chars_memories: structuredClone(this.chars_memories)
		})
	}

	toJSON() {
		return {
			chars: Object.keys(this.chars),
			plugins: Object.keys(this.plugins),
			world: this.world_id,
			player: this.player_id,
			chars_memories: this.chars_memories,
			charname: this.charname
		}
	}

	async toData() {
		return {
			chars: Object.keys(this.chars),
			plugins: Object.keys(this.plugins),
			world: this.world_id,
			player: this.player_id,
			chars_memories: this.chars_memories,
			charname: this.charname
		}
	}

	static async fromJSON(json, username) {
		return Object.assign(new timeSlice_t(), {
			...json,
			chars: Object.fromEntries(await Promise.all(
				(json.chars || []).map(async charname => [charname, await loadPart(username, 'chars/' + charname).catch(() => { })])
			)),
			plugins: Object.fromEntries(await Promise.all(
				(json.plugins || []).map(async plugin => [plugin, await loadPart(username, 'plugins/' + plugin).catch(() => { })])
			)),
			world_id: json.world,
			world: json.world ? await loadPart(username, 'worlds/' + json.world).catch(() => { }) : undefined,
			player_id: json.player,
			player: json.player ? await loadPart(username, 'personas/' + json.player).catch(() => { }) : undefined,
		})
	}
}

// ============================================================
// 数据结构：chatLogEntry_t（保留原样）
// ============================================================

class chatLogEntry_t {
	/** @type {string} */
	id
	name
	avatar
	time_stamp
	role
	content
	content_for_show
	content_for_edit
	timeSlice = new timeSlice_t()
	files = []
	extension = {}
	/** @type {boolean} */
	is_generating = false

	constructor() {
		this.id = crypto.randomUUID()
	}

	toJSON() {
		return {
			...this,
			timeSlice: this.timeSlice.toJSON(),
			files: this.files.map(file => ({
				...file,
				buffer: file.buffer.toString('base64')
			}))
		}
	}

	async toData(username) {
		return {
			...this,
			timeSlice: await this.timeSlice.toData(),
			files: await Promise.all(this.files.map(async file => ({
				...file,
				buffer: 'file:' + await addfile(username, file.buffer)
			})))
		}
	}

	static async fromJSON(json, username) {
		const instance = Object.assign(new chatLogEntry_t(), {
			...json,
			timeSlice: await timeSlice_t.fromJSON(json.timeSlice, username),
			files: await Promise.all((json.files || []).map(async file => ({
				...file,
				buffer: file.buffer.startsWith('file:') ? await getfile(username, file.buffer.slice(5)) : Buffer.from(file.buffer, 'base64')
			})))
		})
		if (!instance.id)
			instance.id = crypto.randomUUID()
		return instance
	}
}

// ============================================================
// 数据结构：chatMetadata_t（保留原样）
// ============================================================

class chatMetadata_t {
	username
	/** @type {chatLogEntry_t[]} */
	chatLog = []
	/** @type {chatLogEntry_t[]} */
	timeLines = []
	/** @type {number} */
	timeLineIndex = 0
	/** @type {timeSlice_t} */
	LastTimeSlice = new timeSlice_t()

	constructor(username) {
		this.username = username
	}

	static async StartNewAs(username) {
		const metadata = new chatMetadata_t(username)

		metadata.LastTimeSlice.player_id = getAnyDefaultPart(username, 'personas')
		if (metadata.LastTimeSlice.player_id)
			metadata.LastTimeSlice.player = await loadPart(username, 'personas/' + metadata.LastTimeSlice.player_id).catch(() => { })

		metadata.LastTimeSlice.world_id = getAnyDefaultPart(username, 'worlds')
		if (metadata.LastTimeSlice.world_id)
			metadata.LastTimeSlice.world = await loadPart(username, 'worlds/' + metadata.LastTimeSlice.world_id).catch(() => { })

		metadata.LastTimeSlice.plugins = Object.fromEntries(await Promise.all(
			getAllDefaultParts(username, 'plugins').map(async plugin => [
				plugin,
				await loadPart(username, 'plugins/' + plugin).catch(() => { })
			])
		))

		return metadata
	}

	toJSON() {
		return {
			username: this.username,
			chatLog: this.chatLog.map(log => log.toJSON()),
			timeLines: this.timeLines.map(entry => entry.toJSON()),
			timeLineIndex: this.timeLineIndex,
		}
	}

	async toData() {
		return {
			username: this.username,
			chatLog: await Promise.all(this.chatLog.map(async log => {
				if (typeof log?.toData === 'function') return log.toData(this.username)
				console.warn('[chat] chatLog entry missing toData method, using fallback')
				if (typeof log?.toJSON === 'function') return log.toJSON()
				return log
			})),
			timeLines: await Promise.all(this.timeLines.map(async entry => {
				if (typeof entry?.toData === 'function') return entry.toData(this.username)
				console.warn('[chat] timeLines entry missing toData method, using fallback')
				if (typeof entry?.toJSON === 'function') return entry.toJSON()
				return entry
			})),
			timeLineIndex: this.timeLineIndex,
		}
	}

	static async fromJSON(json) {
		const chatLog = await Promise.all(json.chatLog.map(data => chatLogEntry_t.fromJSON(data, json.username)))
		const timeLines = await Promise.all(json.timeLines.map(entry => chatLogEntry_t.fromJSON(entry, json.username)))

		// 清理上次崩溃残留的 generating 状态
		for (const entry of chatLog)
			if (entry.is_generating) entry.is_generating = false
		for (const entry of timeLines)
			if (entry.is_generating) entry.is_generating = false

		return Object.assign(new chatMetadata_t(), {
			username: json.username,
			chatLog,
			timeLines,
			timeLineIndex: json.timeLineIndex ?? 0,
			LastTimeSlice: chatLog.length ? chatLog[chatLog.length - 1].timeSlice : new timeSlice_t()
		})
	}

	copy() {
		return chatMetadata_t.fromJSON(this.toJSON())
	}
}

// ============================================================
// 聊天 CRUD
// ============================================================

export async function newMetadata(chatid, username) {
	chatMetadatas.set(chatid, { username, primaryCharName: '', chatMetadata: await chatMetadata_t.StartNewAs(username) })
}

export function findEmptyChatid() {
	while (true) {
		const uuid = Math.random().toString(36).substring(2, 15)
		if (!chatMetadatas.has(uuid)) return uuid
	}
}

export async function newChat(username) {
	const chatid = findEmptyChatid()
	await newMetadata(chatid, username)
	await saveChat(chatid) // 保存到磁盘，确保出现在聊天列表中
	return chatid
}

// 修改：去掉 is_VividChat 过滤，支持空聊天
function getSummaryFromMetadata(chatid, chatMetadata) {
	const lastEntry = chatMetadata?.chatLog?.[chatMetadata.chatLog.length - 1]
	if (!lastEntry) {
		// 空聊天也返回摘要，不过滤
		return {
			chatid,
			chars: Object.keys(chatMetadata?.LastTimeSlice?.chars || {}),
			lastMessageSender: '',
			lastMessageSenderAvatar: null,
			lastMessageContent: '(新聊天)',
			lastMessageTime: new Date(),
		}
	}
	return {
		chatid,
		chars: Object.keys(chatMetadata.LastTimeSlice.chars),
		lastMessageSender: lastEntry.name,
		lastMessageSenderAvatar: lastEntry.avatar || null,
		lastMessageContent: lastEntry.content,
		lastMessageTime: lastEntry.time_stamp,
	}
}

async function updateChatSummary(chatid, chatMetadata) {
	const { username } = chatMetadatas.get(chatid)
	if (!chatMetadata) chatMetadata = await loadChat(chatid)

	const summary = getSummaryFromMetadata(chatid, chatMetadata)
	const summariesCache = loadShellData(username, 'chat', 'chat_summaries_cache')
	if (summary) summariesCache[chatid] = summary
	else delete summariesCache[chatid]

	saveShellData(username, 'chat', 'chat_summaries_cache')
}

/**
 * 获取聊天存储目录路径
 * 新路径: chars/{primaryCharName}/chats/
 * 旧路径兼容: shells/chat/chats/（primaryCharName 为空时）
 */
function getChatStorageDir(username, primaryCharName) {
	const userDir = getUserDictionary(username)
	if (primaryCharName) {
		return userDir + '/chars/' + primaryCharName + '/chats'
	}
	// 兼容旧路径
	return userDir + '/shells/chat/chats'
}

export async function saveChat(chatid) {
	const chatData = chatMetadatas.get(chatid)
	if (!chatData || !chatData.chatMetadata) return

	const { username, primaryCharName, chatMetadata } = chatData
	const chatDir = getChatStorageDir(username, primaryCharName)
	fs.mkdirSync(chatDir, { recursive: true })
	saveJsonFile(chatDir + '/' + chatid + '.json', await chatMetadata.toData())
	await updateChatSummary(chatid, chatMetadata)
}

export async function loadChat(chatid) {
	const chatData = chatMetadatas.get(chatid)
	if (!chatData) return undefined

	if (!chatData.chatMetadata) {
		const { username, primaryCharName } = chatData
		const chatDir = getChatStorageDir(username, primaryCharName)
		const filepath = chatDir + '/' + chatid + '.json'
		if (!fs.existsSync(filepath)) return undefined
		chatData.chatMetadata = await chatMetadata_t.fromJSON(loadJsonFile(filepath))
		chatMetadatas.set(chatid, chatData)
	}
	return chatData.chatMetadata
}

// ============================================================
// 请求构建（简化：去掉 world.GetChatLogForCharname 劫持）
// ============================================================

async function getChatRequest(chatid, charname) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const { username, LastTimeSlice: timeSlice } = chatMetadata
	const { locales } = getUserByUsername(username)
	const userinfo = await getPartInfo(timeSlice.player, locales) || {}
	const charinfo = await getPartInfo(timeSlice.chars[charname], locales) || {}
	const UserCharname = userinfo.name || timeSlice.player_id || username

	const other_chars = { ...timeSlice.chars }
	delete other_chars[charname]

	/** @type {import('../decl/chatLog.ts').chatReplyRequest_t} */
	const result = {
		supported_functions: {
			markdown: true,
			mathjax: true,
			html: true,
			unsafe_html: true,
			files: true,
			add_message: true,
			fount_assets: true,
			fount_i18nkeys: true,
		},
		chat_name: 'common_chat_' + chatid,
		char_id: charname,
		username,
		UserCharname,
		Charname: charinfo.name || charname,
		locales,
		chat_log: chatMetadata.chatLog,
		Update: () => getChatRequest(chatid, charname),
		AddChatLogEntry: async entry => {
			if (!chatMetadata.LastTimeSlice.chars[charname]) throw new Error('Char not in this chat')
			return addChatLogEntry(chatid, await BuildChatLogEntryFromCharReply(
				entry,
				chatMetadata.LastTimeSlice.copy(),
				chatMetadata.LastTimeSlice.chars[charname],
				charname,
				chatMetadata.username
			))
		},
		world: timeSlice.world,
		char: timeSlice.chars[charname],
		user: timeSlice.player,
		other_chars,
		chat_scoped_char_memory: timeSlice.chars_memories[charname] ??= {},
		plugins: timeSlice.plugins,
		extension: {},
	}

	// 去掉 world.GetChatLogForCharname 劫持，直接使用 chatLog

	return result
}

// ============================================================
// 人设 & 世界（简化）
// ============================================================

export async function setPersona(chatid, personaname) {
	const chatMetadata = await loadChat(chatid)
	const { LastTimeSlice: timeSlice, username } = chatMetadata
	if (!personaname) {
		timeSlice.player = undefined
		timeSlice.player_id = undefined
	} else {
		timeSlice.player = await loadPart(username, `personas/${personaname}`)
		timeSlice.player_id = personaname
	}

	saveChat(chatid) // 始终保存
	broadcastChatEvent(chatid, { type: 'persona_set', payload: { personaname } })
}

// 简化：去掉 world greeting 逻辑
export async function setWorld(chatid, worldname) {
	const chatMetadata = await loadChat(chatid)
	if (!worldname) {
		chatMetadata.LastTimeSlice.world = undefined
		chatMetadata.LastTimeSlice.world_id = undefined
	} else {
		const { username } = chatMetadata
		chatMetadata.LastTimeSlice.world = await loadPart(username, `worlds/${worldname}`)
		chatMetadata.LastTimeSlice.world_id = worldname
	}

	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'world_set', payload: { worldname: worldname || null } })
	return null
}

// ============================================================
// 角色管理（修复核心 Bug）
// ============================================================

export async function addchar(chatid, charname) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const { username } = chatMetadata

	// 已存在则跳过
	if (chatMetadata.LastTimeSlice.chars[charname]) return null

	// 修复Bug2：先加到 LastTimeSlice，再调 getChatRequest
	const char = chatMetadata.LastTimeSlice.chars[charname] = await loadPart(username, `chars/${charname}`)
	broadcastChatEvent(chatid, { type: 'char_added', payload: { charname } })

	// 如果是第一个角色，设定 primaryCharName 并迁移存储位置
	const chatData = chatMetadatas.get(chatid)
	if (chatData && !chatData.primaryCharName) {
		const oldDir = getChatStorageDir(username, '')
		const oldPath = oldDir + '/' + chatid + '.json'

		chatData.primaryCharName = charname

		// 如果旧路径存在文件，迁移到新路径
		if (fs.existsSync(oldPath)) {
			const newDir = getChatStorageDir(username, charname)
			fs.mkdirSync(newDir, { recursive: true })
			const newPath = newDir + '/' + chatid + '.json'
			try {
				fs.renameSync(oldPath, newPath)
				console.log(`[chat] 聊天文件迁移: ${oldPath} → ${newPath}`)
			} catch (e) {
				console.warn(`[chat] 聊天文件迁移失败:`, e.message)
			}
		}
	}

	// 准备 greeting 时间切片
	const isFirstChar = Object.keys(chatMetadata.LastTimeSlice.chars).length === 1
	const timeSlice = chatMetadata.LastTimeSlice.copy()
	timeSlice.chars[charname] = char
	if (isFirstChar) timeSlice.greeting_type = 'single'

	try {
		// 修复Bug1：getChatRequest 在 try 内
		const request = await getChatRequest(chatid, charname)

		let result = null
		if (isFirstChar && char.interfaces.chat?.GetGreeting)
			result = await char.interfaces.chat.GetGreeting(request, 0)

		if (!result) {
			// 没有 greeting，直接保存
			saveChat(chatid)
			return null
		}

		const greeting_entry = await BuildChatLogEntryFromCharReply(result, timeSlice, char, charname, username)
		await addChatLogEntry(chatid, greeting_entry)

		// ★ P6-3 修复：预加载所有 alternate_greetings 到 timeLines
		// 酒馆行为：新建聊天时将 [first_mes, ...alternate_greetings] 全部填入 swipes 数组
		// fount 行为（修复后）：将所有 greetings 预加载到 timeLines，显示 1/N
		if (isFirstChar && char.interfaces.chat?.GetGreeting) {
			let greetingIndex = 1
			while (true) {
				try {
					const altResult = await char.interfaces.chat.GetGreeting(request, greetingIndex)
					if (!altResult) break
					const altTimeSlice = timeSlice.copy()
					altTimeSlice.greeting_type = 'single'
					altTimeSlice.charname = charname
					const altEntry = await BuildChatLogEntryFromCharReply(altResult, altTimeSlice, char, charname, username)
					chatMetadata.timeLines.push(altEntry)
					greetingIndex++
				} catch (e) {
					break
				}
			}
			if (chatMetadata.timeLines.length > 1) {
				broadcastChatEvent(chatid, {
					type: 'timeline_info',
					payload: { timeLineIndex: 0, timeLinesCount: chatMetadata.timeLines.length },
				})
				await saveChat(chatid)
			}
		}

		return greeting_entry
	} catch (error) {
		console.error('addchar greeting error:', error)
		// 修复Bug3+4：错误时也保存（角色已经加入了）
		saveChat(chatid)
		return null
	}
}

export async function removechar(chatid, charname) {
	const chatMetadata = await loadChat(chatid)
	delete chatMetadata.LastTimeSlice.chars[charname]
	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'char_removed', payload: { charname } })
}

// ============================================================
// 插件管理（简化）
// ============================================================

export async function addplugin(chatid, pluginname) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const { username } = chatMetadata
	if (chatMetadata.LastTimeSlice.plugins[pluginname]) return

	chatMetadata.LastTimeSlice.plugins[pluginname] = await loadPart(username, `plugins/${pluginname}`)
	broadcastChatEvent(chatid, { type: 'plugin_added', payload: { pluginname } })
	saveChat(chatid)
}

export async function removeplugin(chatid, pluginname) {
	const chatMetadata = await loadChat(chatid)
	delete chatMetadata.LastTimeSlice.plugins[pluginname]
	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'plugin_removed', payload: { pluginname } })
}

// ============================================================
// 查询接口
// ============================================================

export async function getCharListOfChat(chatid) {
	const chatMetadata = await loadChat(chatid)
	return Object.keys(chatMetadata.LastTimeSlice.chars)
}

export async function getPluginListOfChat(chatid) {
	const chatMetadata = await loadChat(chatid)
	return Object.keys(chatMetadata.LastTimeSlice.plugins)
}

export async function GetChatLog(chatid, start, end) {
	const chatMetadata = await loadChat(chatid)
	return chatMetadata.chatLog.slice(start, end)
}

export async function GetChatLogLength(chatid) {
	const chatMetadata = await loadChat(chatid)
	return chatMetadata.chatLog.length
}

export async function GetUserPersonaName(chatid) {
	const chatMetadata = await loadChat(chatid)
	return chatMetadata.LastTimeSlice.player_id
}

export async function GetWorldName(chatid) {
	const chatMetadata = await loadChat(chatid)
	return chatMetadata.LastTimeSlice.world_id
}

// ============================================================
// addChatLogEntry（大幅简化：去掉 world 劫持/成就/通知/自动回复）
// ============================================================

async function addChatLogEntry(chatid, entry) {
	const chatMetadata = await loadChat(chatid)

	// 直接 push，不经过 world 劫持
	chatMetadata.chatLog.push(entry)

	// 更新时间线
	chatMetadata.timeLines = [entry]
	chatMetadata.timeLineIndex = 0
	chatMetadata.LastTimeSlice = entry.timeSlice

	// 始终保存
	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'message_added', payload: await entry.toData(chatMetadata.username) })

	return entry
}

// ============================================================
// 消息构建
// ============================================================

async function BuildChatLogEntryFromCharReply(result, new_timeSlice, char, charname, username) {
	new_timeSlice.charname = charname
	const { info } = await getPartDetails(username, `chars/${charname}`) || {}

	const entry = new chatLogEntry_t()
	Object.assign(entry, {
		name: result.name || info?.name || charname || 'Unknown',
		avatar: result.avatar || info?.avatar || `/parts/chars:${encodeURIComponent(charname)}/image.png`,
		content: result.content,
		content_for_show: result.content_for_show,
		content_for_edit: result.content_for_edit,
		timeSlice: new_timeSlice,
		role: 'char',
		time_stamp: new Date(),
		files: result.files || [],
		extension: result.extension || {},
		logContextBefore: result.logContextBefore,
		logContextAfter: result.logContextAfter
	})
	return entry
}

async function BuildChatLogEntryFromUserMessage(result, new_timeSlice, user, personaname, username) {
	new_timeSlice.playername = new_timeSlice.player_id
	const { info } = (personaname ? await getPartDetails(username, `personas/${personaname}`) : undefined) || {}
	const entry = new chatLogEntry_t()
	Object.assign(entry, {
		name: result.name || info?.name || new_timeSlice.player_id || username,
		avatar: result.avatar || info?.avatar,
		content: result.content,
		timeSlice: new_timeSlice,
		role: 'user',
		time_stamp: new Date(),
		files: result.files || [],
		extension: result.extension || {}
	})
	return entry
}

// ============================================================
// 流式生成（微调：去掉 handleAutoReply / world.AfterAddChatLogEntry）
// ============================================================

async function executeGeneration(chatid, request, stream, placeholderEntry, chatMetadata) {
	const entryId = placeholderEntry.id

	const finalizeEntry = async (finalEntry, isError = false) => {
		stream.done()
		finalEntry.id = entryId
		finalEntry.is_generating = false

		let idx = chatMetadata.chatLog.findIndex(e => e.id === entryId)
		if (idx === -1) {
			chatMetadata.chatLog.push(finalEntry)
			idx = chatMetadata.chatLog.length - 1
			chatMetadata.timeLines = [finalEntry]
			chatMetadata.timeLineIndex = 0
		} else {
			chatMetadata.chatLog[idx] = finalEntry
			const timelineIdx = chatMetadata.timeLines.findIndex(e => e.id === entryId)
			if (timelineIdx !== -1)
				chatMetadata.timeLines[timelineIdx] = finalEntry
		}

		chatMetadata.LastTimeSlice = finalEntry.timeSlice

		broadcastChatEvent(chatid, {
			type: 'message_replaced',
			payload: { index: idx, entry: await finalEntry.toData(chatMetadata.username) },
		})

		if (!isError) {
			try {
				await saveChat(chatid)
			} catch (saveErr) {
				console.error('[chat] saveChat failed in finalizeEntry:', saveErr.message)
			}
		}
		return finalEntry
	}

	try {
		broadcastChatEvent(chatid, {
			type: 'stream_start',
			payload: { messageId: entryId },
		})

		request.generation_options = {
			replyPreviewUpdater: reply => stream.update(reply),
			signal: stream.signal,
		}

		const result = await request.char.interfaces.chat.GetReply(request)

		if (result === null) {
			stream.abort('Generation result was null.')
			const idx = chatMetadata.chatLog.findIndex(e => e.id === entryId)
			if (idx !== -1) await deleteMessage(chatid, idx)
			return
		}

		// 调用插件的 ReplyHandler（如 beilu-files 解析 <file_op> 标签）
		const timeSlice = placeholderEntry.timeSlice
		if (timeSlice.plugins) {
			for (const [pluginName, plugin] of Object.entries(timeSlice.plugins)) {
				if (plugin?.interfaces?.chat?.ReplyHandler) {
					try {
						await plugin.interfaces.chat.ReplyHandler(result, request)
					} catch (err) {
						console.warn(`[chat] Plugin ${pluginName} ReplyHandler error:`, err.message)
					}
				}
			}
		}

		const finalEntry = await BuildChatLogEntryFromCharReply(
			result,
			placeholderEntry.timeSlice,
			request.char,
			request.char_id,
			chatMetadata.username,
		)

		await finalizeEntry(finalEntry, false)
		// 去掉 handleAutoReply / world.AfterAddChatLogEntry
	} catch (e) {
		if (e.name === 'AbortError') {
			console.log(`Generation aborted for message ${entryId}: ${e.message}`)
			placeholderEntry.is_generating = false
			placeholderEntry.extension = { ...placeholderEntry.extension, aborted: true }
			await finalizeEntry(placeholderEntry, false)
		} else {
			stream.abort(e.message)
			placeholderEntry.content = `\`\`\`\nError:\n${e.stack || e.message}\n\`\`\``
			await finalizeEntry(placeholderEntry, true)
		}
	} finally {
		updateTypingStatus(chatid, request.char_id, -1)
	}
}

// ============================================================
// 时间线切换 / 重新生成（简化 greeting 分支）
// ============================================================

export async function modifyTimeLine(chatid, delta, absoluteIndex) {
	StreamManager.abortAll(chatid)

	const chatMetadata = await loadChat(chatid)
	let newTimeLineIndex
	if (absoluteIndex !== undefined && absoluteIndex !== null) {
		// 绝对索引模式（用于 iframe 内美化代码的 switchSwipe 调用）
		newTimeLineIndex = absoluteIndex
	} else {
		newTimeLineIndex = chatMetadata.timeLineIndex + delta
	}

	// 向左循环
	if (newTimeLineIndex < 0)
		newTimeLineIndex = chatMetadata.timeLines.length - 1

	let entry

	if (newTimeLineIndex >= chatMetadata.timeLines.length) {
		// 需要生成新消息
		const previousEntry = chatMetadata.chatLog[chatMetadata.chatLog.length - 1]
		const { timeSlice } = previousEntry
		const { greeting_type } = timeSlice

		const newEntry = new chatLogEntry_t()
		newEntry.id = crypto.randomUUID()
		newEntry.timeSlice = timeSlice.copy()
		newEntry.timeSlice.greeting_type = greeting_type
		newEntry.role = previousEntry.role
		newEntry.name = previousEntry.name
		newEntry.avatar = previousEntry.avatar
		newEntry.is_generating = true
		newEntry.content = ''
		newEntry.files = []
		newEntry.time_stamp = new Date()

		chatMetadata.timeLines.push(newEntry)
		newTimeLineIndex = chatMetadata.timeLines.length - 1
		chatMetadata.timeLineIndex = newTimeLineIndex
		chatMetadata.chatLog[chatMetadata.chatLog.length - 1] = newEntry
		entry = newEntry

		// 广播 UI 更新
		broadcastChatEvent(chatid, {
			type: 'message_replaced',
			payload: { index: chatMetadata.chatLog.length - 1, entry: await newEntry.toData(chatMetadata.username) },
		})

		if (greeting_type === 'single') {
			// 重新生成开场白（同步）
			try {
				const { charname } = timeSlice
				const request = await getChatRequest(chatid, charname || undefined)
				const char = charname ? timeSlice.chars[charname] : null

				let result = null
				if (char?.interfaces?.chat?.GetGreeting)
					result = await char.interfaces.chat.GetGreeting(request, newTimeLineIndex)

				if (!result) throw new Error('No greeting result')

				const newTimeSlice = timeSlice.copy()
				newTimeSlice.greeting_type = greeting_type

				const finalEntry = await BuildChatLogEntryFromCharReply(result, newTimeSlice, char, charname, chatMetadata.username)
				Object.assign(newEntry, finalEntry)
				newEntry.is_generating = false
				newEntry.id = entry.id

				chatMetadata.timeLines[newTimeLineIndex] = newEntry
				chatMetadata.chatLog[chatMetadata.chatLog.length - 1] = newEntry
				chatMetadata.LastTimeSlice = newEntry.timeSlice

				saveChat(chatid)

				broadcastChatEvent(chatid, {
					type: 'message_replaced',
					payload: { index: chatMetadata.chatLog.length - 1, entry: await newEntry.toData(chatMetadata.username) },
				})
			} catch (e) {
				console.error('Greeting generation failed:', e)
				newEntry.content = `\`\`\`\nError generating greeting:\n${e.message}\n\`\`\``
				newEntry.is_generating = false
				newEntry.id = entry.id
				newEntry.timeSlice = timeSlice
				broadcastChatEvent(chatid, {
					type: 'message_replaced',
					payload: { index: chatMetadata.chatLog.length - 1, entry: await newEntry.toData(chatMetadata.username) },
				})
			}
		} else {
			// 普通回复（流式）
			const { charname } = timeSlice
			const request = await getChatRequest(chatid, charname)
			const stream = StreamManager.create(chatid, newEntry.id)
			executeGeneration(chatid, request, stream, newEntry, chatMetadata)
		}
	} else {
		// 简单切换（无生成）
		entry = chatMetadata.timeLines[newTimeLineIndex]
		chatMetadata.timeLineIndex = newTimeLineIndex
		chatMetadata.LastTimeSlice = entry.timeSlice
		chatMetadata.chatLog[chatMetadata.chatLog.length - 1] = entry

		saveChat(chatid)

		broadcastChatEvent(chatid, {
			type: 'message_replaced',
			payload: { index: chatMetadata.chatLog.length - 1, entry: await entry.toData(chatMetadata.username) }
		})
	}

	// 广播当前 timeline 信息（用于前端 swipe 计数器显示）
	broadcastChatEvent(chatid, {
		type: 'timeline_info',
		payload: { timeLineIndex: chatMetadata.timeLineIndex, timeLinesCount: chatMetadata.timeLines.length },
	})

	return entry
}

// ============================================================
// 触发回复（简化：去掉频率系统）
// ============================================================

export async function triggerCharReply(chatid, charname) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	// 如果没有指定角色，取第一个角色
	if (!charname) {
		const chars = Object.keys(chatMetadata.LastTimeSlice.chars)
		if (chars.length === 0) return
		charname = chars[0]
	}

	const char = chatMetadata.LastTimeSlice.chars[charname]
	if (!char) throw new Error('char not found')

	// 创建 placeholder
	const placeholder = new chatLogEntry_t()
	placeholder.role = 'char'
	placeholder.is_generating = true
	placeholder.timeSlice = chatMetadata.LastTimeSlice.copy()
	placeholder.time_stamp = new Date()
	const { info } = await getPartDetails(chatMetadata.username, `chars/${charname}`) || {}
	placeholder.name = info?.name || charname
	placeholder.avatar = info?.avatar || `/parts/chars:${encodeURIComponent(charname)}/image.png`
	placeholder.timeSlice.charname = charname
	placeholder.content = ''

	// 广播 placeholder
	broadcastChatEvent(chatid, {
		type: 'message_added',
		payload: await placeholder.toData(chatMetadata.username),
	})

	// 创建 request & stream
	const request = await getChatRequest(chatid, charname)
	const stream = StreamManager.create(chatid, placeholder.id)

	updateTypingStatus(chatid, charname, 1)

	// 后台执行
	executeGeneration(chatid, request, stream, placeholder, chatMetadata)
}

// ============================================================
// 用户回复（简化：去掉成就系统）
// ============================================================

export async function addUserReply(chatid, object) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const timeSlice = chatMetadata.LastTimeSlice
	const new_timeSlice = timeSlice.copy()
	const user = timeSlice.player

	return addChatLogEntry(chatid, await BuildChatLogEntryFromUserMessage(object, new_timeSlice, user, new_timeSlice.player_id, chatMetadata.username))
}

// ============================================================
// 聊天列表
// ============================================================

async function loadChatSummary(username, chatid, primaryCharName) {
	const chatDir = getChatStorageDir(username, primaryCharName || '')
	const filepath = chatDir + '/' + chatid + '.json'
	if (!fs.existsSync(filepath)) return null

	try {
		const rawChatData = loadJsonFile(filepath)
		// 处理空聊天（无消息）
		if (!rawChatData.chatLog || rawChatData.chatLog.length === 0) {
			return {
				chatid,
				chars: [],
				lastMessageSender: '',
				lastMessageSenderAvatar: null,
				lastMessageContent: '(新聊天)',
				lastMessageTime: new Date(),
			}
		}
		const lastEntry = rawChatData.chatLog[rawChatData.chatLog.length - 1]
		const chars = lastEntry.timeSlice?.chars || []
		return {
			chatid,
			chars,
			lastMessageSender: lastEntry.name || 'Unknown',
			lastMessageSenderAvatar: lastEntry.avatar || null,
			lastMessageContent: lastEntry.content || '',
			lastMessageTime: new Date(lastEntry.time_stamp),
		}
	} catch (error) {
		console.error(`Failed to load summary for chat ${chatid}:`, error)
		return null
	}
}

export async function getChatList(username) {
	const summariesCache = loadShellData(username, 'chat', 'chat_summaries_cache')

	await Promise.all(Array.from(chatMetadatas.entries()).map(async ([chatid, value]) => {
		if (value.username === username)
			summariesCache[chatid] ??= await loadChatSummary(username, chatid, value.primaryCharName)
	}))

	const chatList = Object.values(summariesCache).filter(Boolean)
	return chatList.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime))
}

// ============================================================
// 删除聊天
// ============================================================

export async function deleteChat(chatids, username) {
	const summariesCache = loadShellData(username, 'chat', 'chat_summaries_cache')
	const deletePromises = chatids.map(async chatid => {
		try {
			const chatData = chatMetadatas.get(chatid)
			const primaryCharName = chatData?.primaryCharName || ''
			const chatDir = getChatStorageDir(username, primaryCharName)
			const filepath = chatDir + '/' + chatid + '.json'

			if (fs.existsSync(filepath)) await fs.promises.unlink(filepath)
			chatMetadatas.delete(chatid)
			delete summariesCache[chatid]
			return { chatid, success: true, message: 'Chat deleted successfully' }
		} catch (error) {
			console.error(`Error deleting chat ${chatid}:`, error)
			return { chatid, success: false, message: 'Error deleting chat', error: error.message }
		}
	})

	const results = await Promise.all(deletePromises)
	saveShellData(username, 'chat', 'chat_summaries_cache')
	return results
}

// ============================================================
// 导出聊天（保留，virtual_files 端点需要）
// ============================================================

/**
 * 获取指定角色的所有聊天 ID
 * @param {string} username
 * @param {string} charName - 角色卡名称（Fount part 目录名）
 * @returns {string[]} chatid 列表
 */
export function getChatIdsByCharName(username, charName) {
	const ids = []
	for (const [chatid, data] of chatMetadatas.entries()) {
		if (data.username === username && data.primaryCharName === charName) {
			ids.push(chatid)
		}
	}
	return ids
}

export async function exportChat(chatids) {
	const exportPromises = chatids.map(async chatid => {
		try {
			const chat = await loadChat(chatid)
			if (!chat) return { chatid, success: false, message: 'Chat not found', error: 'Chat not found' }
			return { chatid, success: true, data: chat }
		} catch (error) {
			console.error(`Error exporting chat ${chatid}:`, error)
			return { chatid, success: false, message: 'Error exporting chat', error: error.message }
		}
	})
	return Promise.all(exportPromises)
}

// ============================================================
// 批量删除消息范围（文件模式隔离用）
// ============================================================

/**
 * 批量删除指定范围的消息（从 startIndex 到末尾）
 * 用于文件模式退出时清理文件操作对话
 * @param {string} chatid
 * @param {number} startIndex - 起始索引（含）
 * @param {number} [endIndex] - 结束索引（不含），默认到末尾
 * @returns {Promise<{deleted: number}>}
 */
export async function deleteMessagesRange(chatid, startIndex, endIndex) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const start = Math.max(0, startIndex)
	const end = endIndex != null ? Math.min(chatMetadata.chatLog.length, endIndex) : chatMetadata.chatLog.length

	if (start >= end) return { deleted: 0 }

	// 停止该范围内所有生成
	for (let i = start; i < end; i++) {
		const entry = chatMetadata.chatLog[i]
		if (entry) StreamManager.abortByMessageId(entry.id)
	}

	// 批量删除
	const deletedCount = end - start
	chatMetadata.chatLog.splice(start, deletedCount)

	// 更新 LastTimeSlice
	const last = chatMetadata.chatLog[chatMetadata.chatLog.length - 1]
	if (chatMetadata.chatLog.length) {
		chatMetadata.timeLines = [last]
		chatMetadata.timeLineIndex = 0
		chatMetadata.LastTimeSlice = last.timeSlice
	} else {
		chatMetadata.timeLines = []
		chatMetadata.timeLineIndex = 0
		chatMetadata.LastTimeSlice = new timeSlice_t()
	}

	saveChat(chatid)
	broadcastChatEvent(chatid, {
		type: 'messages_range_deleted',
		payload: { startIndex: start, count: deletedCount },
	})

	console.log(`[chat] 批量删除消息: chatid=${chatid}, range=[${start}, ${end}), deleted=${deletedCount}`)
	return { deleted: deletedCount }
}

// ============================================================
// 删除消息（简化：去掉 world/char 代理）
// ============================================================

export async function deleteMessage(chatid, index) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')
	if (!chatMetadata.chatLog[index]) throw new Error('Invalid index')

	const entry = chatMetadata.chatLog[index]
	if (entry)
		StreamManager.abortByMessageId(entry.id)

	// 直接删除，不经过 world/char 代理
	chatMetadata.chatLog.splice(index, 1)

	const last = chatMetadata.chatLog[chatMetadata.chatLog.length - 1]

	if (index == chatMetadata.chatLog.length) {
		chatMetadata.timeLines = [last].filter(Boolean)
		chatMetadata.timeLineIndex = 0
	}

	if (chatMetadata.chatLog.length)
		chatMetadata.LastTimeSlice = last.timeSlice
	else
		chatMetadata.LastTimeSlice = new timeSlice_t()

	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'message_deleted', payload: { index } })
}

// ============================================================
// 编辑消息（简化：去掉 world/char 代理）
// ============================================================

export async function editMessage(chatid, index, new_content) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')
	if (!chatMetadata.chatLog[index]) throw new Error('Invalid index')

	const { timeSlice } = chatMetadata.chatLog[index]
	let entry
	if (timeSlice.charname) {
		const char = timeSlice.chars[timeSlice.charname]
		entry = await BuildChatLogEntryFromCharReply(new_content, timeSlice, char, timeSlice.charname, chatMetadata.username)
	} else {
		entry = await BuildChatLogEntryFromUserMessage(new_content, timeSlice, timeSlice.player, timeSlice.player_id, chatMetadata.username)
	}

	chatMetadata.chatLog[index] = entry
	if (index == chatMetadata.chatLog.length - 1)
		chatMetadata.timeLines[chatMetadata.timeLineIndex] = entry

	saveChat(chatid)
	broadcastChatEvent(chatid, { type: 'message_edited', payload: { index, entry: await entry.toData(chatMetadata.username) } })

	return entry
}

// ============================================================
// 初始数据（简化：去掉 frequency_data）
// ============================================================

export async function getInitialData(chatid) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw skip_report(new Error('Chat not found'))
	const timeSlice = chatMetadata.LastTimeSlice
	return {
		charlist: Object.keys(timeSlice.chars),
		pluginlist: Object.keys(timeSlice.plugins),
		worldname: timeSlice.world_id,
		personaname: timeSlice.player_id,
		logLength: chatMetadata.chatLog.length,
		initialLog: await Promise.all(chatMetadata.chatLog.slice(-20).map(x => {
			if (typeof x?.toData === 'function') return x.toData(chatMetadata.username)
			console.warn('[chat] getInitialData: chatLog entry missing toData, using fallback')
			if (typeof x?.toJSON === 'function') return x.toJSON()
			return x
		})),
		timeLineIndex: chatMetadata.timeLineIndex,
		timeLinesCount: chatMetadata.timeLines.length,
	}
}

// ============================================================
// 事件处理器
// ============================================================

events.on('AfterUserDeleted', async payload => {
	const { username } = payload
	const chatIdsToDeleteFromCache = []
	for (const [chatId, data] of chatMetadatas.entries())
		if (data.username === username)
			chatIdsToDeleteFromCache.push(chatId)
	chatIdsToDeleteFromCache.forEach(chatId => chatMetadatas.delete(chatId))
})

events.on('AfterUserRenamed', async ({ oldUsername, newUsername }) => {
	for (const [chatId, data] of chatMetadatas.entries())
		if (data.username === oldUsername) {
			data.username = newUsername
			if (data.chatMetadata && data.chatMetadata.username === oldUsername)
				data.chatMetadata.username = newUsername
			saveChat(chatId)
		}
})

// ============================================================
// 伪发送：构建完整的 Chat Completion request 预览
// ============================================================

export async function buildFakeSendRequest(chatid, charname) {
	const chatMetadata = await loadChat(chatid)
	if (!chatMetadata) throw new Error('Chat not found')

	const { LastTimeSlice: timeSlice } = chatMetadata

	if (!charname) {
		const chars = Object.keys(timeSlice.chars)
		if (chars.length === 0) throw new Error('No characters in this chat')
		charname = chars[0]
	}

	// 步骤 1：构建 chatReplyRequest_t
	const request = await getChatRequest(chatid, charname)
	request.isFakeSend = true // 标记为伪发送，插件可据此跳过耗时操作（如 P1 检索）

	// 步骤 2：构建 prompt_struct
	const prompt_struct = await buildPromptStruct(request)

	// 步骤 2.5：检测司令员模式
	const presetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
	const commanderMode = presetExt?.commander_mode && (presetExt?.beilu_preset_before || presetExt?.beilu_preset_messages)

	let messages
	let modelParams = {}

	if (commanderMode) {
		// 读取 5 段式数据
		const beforeChat = presetExt.beilu_preset_before || presetExt.beilu_preset_messages || []
		const afterChat = presetExt.beilu_preset_after || []
		const injectionAbove = presetExt.beilu_injection_above || []
		const injectionBelow = presetExt.beilu_injection_below || []
		modelParams = presetExt.beilu_model_params || {}

		const toMsg = (m, section, source = 'preset') => ({
			role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
			content: m.content || '',
			_identifier: m.identifier,
			_name: m.name,
			_source: source,
			_section: section,
		})

		// 1. 头部预设（beforeChat）
		const beforeSection = beforeChat.map(m => toMsg(m, 'beforeChat'))

		// 2. 注入上方（injectionAbove, @D>=1）
		const aboveSection = injectionAbove.map(m => toMsg(m, 'injectionAbove', 'injection'))

		// 3. 聊天记录
		const chatLogMsgs = (prompt_struct.chat_log || [])
			.map(e => ({
				role: e.role === 'user' ? 'user' : e.role === 'system' ? 'system' : 'assistant',
				content: e.content || '',
				_name: e.name,
				_source: 'chat_log',
				_section: 'chatHistory',
				_files: e.files?.length ? e.files.map(f => ({
					name: f.name, mime_type: f.mime_type, size: f.buffer?.length || 0,
				})) : undefined,
			}))

		// 4. 注入下方（injectionBelow, @D=0）
		const belowSection = injectionBelow.map(m => toMsg(m, 'injectionBelow', 'injection'))

		// 5. 尾部预设（afterChat）
		const afterSection = afterChat.map(m => toMsg(m, 'afterChat'))

		messages = [...beforeSection, ...aboveSection, ...chatLogMsgs, ...belowSection, ...afterSection]
	} else {
		const chatLogEntries = margeStructPromptChatLog(prompt_struct)
		messages = chatLogEntries.map(chatLogEntry => {
			const uid = Math.random().toString(36).slice(2, 10)
			const textContent = `<message "${uid}">\n<sender>${chatLogEntry.name}</sender>\n<content>\n${chatLogEntry.content}\n</content>\n</message "${uid}">\n`

			const message = {
				role: chatLogEntry.role === 'user' ? 'user' : chatLogEntry.role === 'system' ? 'system' : 'assistant',
				content: textContent,
			}

			if (chatLogEntry.files?.length)
				message._files = chatLogEntry.files.map(f => ({
					name: f.name, mime_type: f.mime_type, size: f.buffer?.length || 0,
				}))

			return message
		})

		const system_prompt = structPromptToSingleNoChatLog(prompt_struct)
		messages.unshift({
			role: 'system',
			content: system_prompt,
		})

		const isMutiChar = new Set(prompt_struct.chat_log.map(e => e.name).filter(Boolean)).size > 2
		if (isMutiChar) {
			messages.push({
				role: 'system',
				content: `现在请以${prompt_struct.Charname}的身份续写对话。`,
			})
		}

		try {
			const presetPlugin = timeSlice.plugins['beilu-preset']
			if (presetPlugin?.interfaces?.config?.GetData) {
				const presetData = await presetPlugin.interfaces.config.GetData()
				modelParams = presetData.model_params || {}
			}
		} catch (e) {
			console.warn('[fake-send] 获取模型参数失败:', e.message)
		}
	}

	const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)

	// 提取各系统组件的原始内容（用于上下文总览视图）
	const context_parts = {
		char: {
			name: prompt_struct.Charname || charname,
			texts: (prompt_struct.char_prompt?.text || []).map(t => ({
				content: t.content || '',
				important: t.important,
			})),
		},
		user: {
			name: prompt_struct.UserCharname || chatMetadata.username,
			texts: (prompt_struct.user_prompt?.text || []).map(t => ({
				content: t.content || '',
				important: t.important,
			})),
		},
		world: {
				texts: (() => {
					// 优先从 world_prompt 获取
					const worldTexts = (prompt_struct.world_prompt?.text || []).map(t => ({
						content: t.content || '',
						important: t.important,
					}));
					if (worldTexts.length > 0) return worldTexts;
	
					// 回退：从 beilu-worldbook 插件的 extension 中提取世界书内容
					const wbExt = prompt_struct.plugin_prompts?.['beilu-worldbook']?.extension;
					if (wbExt) {
						const wbTexts = [];
						// before/after 位置的条目
						const charInj = wbExt.worldbook_char_injections;
						if (Array.isArray(charInj)) {
							for (const inj of charInj) {
								if (inj.content) {
									wbTexts.push({
										content: inj.content,
										important: 0,
										_position: inj.position === 0 ? 'before' : 'after',
									});
								}
							}
						}
						// @depth 位置的条目
						const depthInj = wbExt.worldbook_injections;
						if (Array.isArray(depthInj)) {
							for (const inj of depthInj) {
								if (inj.content) {
									wbTexts.push({
										content: inj.content,
										important: 0,
										_position: `@depth=${inj.depth ?? 4}`,
									});
								}
							}
						}
						if (wbTexts.length > 0) return wbTexts;
					}
					return worldTexts;
				})(),
			},
		other_chars: Object.fromEntries(
			Object.entries(prompt_struct.other_chars_prompt || {})
				.filter(([, v]) => v?.text?.length)
				.map(([k, v]) => [k, {
					texts: v.text.map(t => ({
						content: t.content || '',
						important: t.important,
					})),
				}])
		),
		plugins: Object.fromEntries(
			Object.entries(prompt_struct.plugin_prompts || {})
				.filter(([, v]) => v?.text?.length)
				.map(([k, v]) => [k, {
					texts: v.text.map(t => ({
						content: t.content || '',
						important: t.important,
					})),
				}])
		),
	}

	return {
		messages,
		model: modelParams.model || '(未配置)',
		temperature: modelParams.temperature,
		max_tokens: modelParams.max_tokens,
		stream: modelParams.stream ?? true,
		presence_penalty: modelParams.presence_penalty,
		frequency_penalty: modelParams.frequency_penalty,
		top_p: modelParams.top_p,
		top_k: modelParams.top_k,
		stop: modelParams.stop,

		_meta: {
			timestamp: new Date().toISOString(),
			chatid,
			charname,
			char_display_name: prompt_struct.Charname,
			user_display_name: prompt_struct.UserCharname,
			message_count: messages.length,
			total_chars: totalChars,
			estimated_tokens: Math.round(totalChars / 3.5),
			commander_mode: !!commanderMode,
			context_parts,
		},
	}
}

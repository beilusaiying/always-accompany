import { Buffer } from 'node:buffer'

import { authenticate, getUserByReq } from '../../../../../server/auth.mjs'
import { processImageFiles } from './imageProcessing.mjs'

import {
  addchar,
  addplugin,
  addUserReply,
  buildFakeSendRequest,
  deleteChat,
  deleteMessage,
  deleteMessagesRange,
  editMessage,
  exportChat,
  getCharListOfChat,
  getChatList,
  GetChatLog,
  GetChatLogLength,
  getInitialData,
  getPluginListOfChat,
  GetUserPersonaName,
  GetWorldName,
  modifyTimeLine,
  newChat,
  registerChatUiSocket,
  removechar,
  removeplugin,
  setPersona,
  setWorld,
  triggerCharReply
} from './chat.mjs'
import { addfile, getfile } from './files.mjs'

/**
 * 为聊天功能设置API端点。
 *
 * @param {import('npm:websocket-express').Router} router - Express路由实例，用于附加端点。
 */
export function setEndpoints(router) {
	router.ws('/ws/parts/shells\\:chat/ui/:chatid', authenticate, async (ws, req) => {
		const { chatid } = req.params
		registerChatUiSocket(chatid, ws)
	})

	router.get('/api/parts/shells\\:chat/:chatid/initial-data', authenticate, async (req, res) => {
		const { chatid } = req.params
		try {
			const data = await getInitialData(chatid)
			res.status(200).json(data)
		} catch (err) {
			// Chat not found → 404（不是 500），前端可据此清除无效 chatid
			if (err.message === 'Chat not found') {
				return res.status(404).json({ error: 'Chat not found', chatid })
			}
			console.error(`[chat/endpoints] ★ initial-data 失败: chatid=${chatid}`, err.message)
			res.status(500).json({
				error: err.message,
				_diag: 'initial-data endpoint caught error'
			})
		}
	})

	router.get('/api/parts/shells\\:chat/:chatid/chars', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			res.status(200).json(await getCharListOfChat(chatid))
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/api/parts/shells\\:chat/:chatid/plugins', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			res.status(200).json(await getPluginListOfChat(chatid))
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/api/parts/shells\\:chat/:chatid/log', authenticate, async (req, res) => {
		const { params: { chatid }, query: { start, end } } = req
		const { username } = await getUserByReq(req)
		const log = await GetChatLog(chatid, parseInt(start, 10), parseInt(end, 10))
		// ★ DIAG P0: 记录原始 log entries 的类型
		console.log(`[chat/endpoints DIAG] /log chatid=${chatid} start=${start} end=${end} entries=${log.length}`)
		for (let i = 0; i < log.length; i++) {
			const e = log[i]
			console.log(`  [${i}] constructor=${e?.constructor?.name} hasToData=${typeof e?.toData === 'function'} id=${e?.id} role=${e?.role}`)
		}
		const serialized = await Promise.all(log.map(async (entry, i) => {
			let result
			try {
				if (typeof entry?.toData === 'function') {
					result = await entry.toData(username)
				}
			} catch (err) {
				console.warn('[chat/endpoints] toData failed for log entry:', err.message)
			}
			if (!result) {
				console.warn(`[chat/endpoints] log entry[${i}] missing toData, using fallback. id=${entry?.id}`)
				try {
					if (typeof entry?.toJSON === 'function') result = entry.toJSON()
				} catch (err2) {
					console.warn('[chat/endpoints] toJSON also failed:', err2.message)
				}
			}
			if (!result) {
				// 最终 fallback：确保至少有 id、content、role
				result = {
					id: entry?.id || crypto.randomUUID(),
					content: entry?.content || '',
					role: entry?.role || 'char',
					name: entry?.name || 'Unknown',
					time_stamp: entry?.time_stamp || new Date(),
					files: [],
					timeSlice: { chars: [], plugins: [] },
				}
			}
			// ★ DIAG P0: 检查序列化后是否有 id
			if (!result.id) {
				console.error(`[chat/endpoints DIAG] ★ 序列化后 entry[${i}] 缺少 id! keys:`, Object.keys(result).join(','))
			}
			return result
		}))
		// ★ DIAG P0: 最终响应检查
		console.log(`[chat/endpoints DIAG] 响应 ${serialized.length} 条, ids:`, serialized.map(e => e.id).join(','))
		res.status(200).json(serialized)
	})

	router.get('/api/parts/shells\\:chat/:chatid/log/length', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			res.status(200).json(await GetChatLogLength(chatid))
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/api/parts/shells\\:chat/:chatid/persona', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			res.status(200).json(await GetUserPersonaName(chatid))
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/api/parts/shells\\:chat/:chatid/world', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			res.status(200).json(await GetWorldName(chatid))
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			res.status(500).json({ error: err.message })
		}
	})

	router.put('/api/parts/shells\\:chat/:chatid/timeline', authenticate, async (req, res) => {
		try {
			const { params: { chatid }, body: { delta, absoluteIndex } } = req
			const entry = await modifyTimeLine(chatid, delta, absoluteIndex)
			res.status(200).json({ success: true, entry: await entry.toData((await getUserByReq(req)).username) })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/timeline] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.delete('/api/parts/shells\\:chat/:chatid/message/:index', authenticate, async (req, res) => {
		try {
			const { chatid, index } = req.params
			await deleteMessage(chatid, parseInt(index, 10))
			res.status(200).json({ success: true })
		} catch (err) {
			console.error('[chat/deleteMessage] Error:', err)
			res.status(500).json({ error: err.message })
		}
	})

	router.put('/api/parts/shells\\:chat/:chatid/message/:index', authenticate, async (req, res) => {
		const { params: { chatid, index }, body: { content } } = req
		content.files = content?.files?.map(file => ({
			...file,
			buffer: Buffer.from(file.buffer, 'base64')
		}))
		// 图片格式校验 + 压缩
		if (content.files?.length) {
			content.files = await processImageFiles(content.files)
		}
		const entry = await editMessage(chatid, parseInt(index, 10), content)
		res.status(200).json({ success: true, entry: await entry.toData((await getUserByReq(req)).username) })
	})

	router.post('/api/parts/shells\\:chat/:chatid/message', authenticate, async (req, res) => {
		const { params: { chatid }, body: { reply, autoReply } } = req
		reply.files = reply?.files?.map(file => ({
			...file,
			buffer: Buffer.from(file.buffer, 'base64')
		}))
		// 图片格式校验 + 压缩
		if (reply.files?.length) {
			reply.files = await processImageFiles(reply.files)
		}
		const entry = await addUserReply(chatid, reply)
		const username = (await getUserByReq(req)).username

		// autoReply: 保存用户消息后自动触发AI回复（避免前端分两次请求导致双重触发）
		if (autoReply !== false) {
			// 异步触发，不阻塞响应
			triggerCharReply(chatid).catch(err => {
				console.warn('[chat/POST message] autoReply triggerCharReply 失败:', err.message)
			})
		}

		res.status(200).json({ success: true, entry: await entry.toData(username) })
	})

	router.post('/api/parts/shells\\:chat/:chatid/trigger-reply', authenticate, async (req, res) => {
		const { params: { chatid }, body: { charname } } = req
		await triggerCharReply(chatid, charname)
		res.status(200).json({ success: true })
	})

	router.put('/api/parts/shells\\:chat/:chatid/world', authenticate, async (req, res) => {
		try {
			const { params: { chatid }, body: { worldname } } = req
			await setWorld(chatid, worldname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/setWorld] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.put('/api/parts/shells\\:chat/:chatid/persona', authenticate, async (req, res) => {
		try {
			const { params: { chatid }, body: { personaname } } = req
			await setPersona(chatid, personaname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/setPersona] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.post('/api/parts/shells\\:chat/:chatid/char', authenticate, async (req, res) => {
		try {
			const { params: { chatid }, body: { charname } } = req
			await addchar(chatid, charname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/addchar] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.delete('/api/parts/shells\\:chat/:chatid/char/:charname', authenticate, async (req, res) => {
		try {
			const { chatid, charname } = req.params
			await removechar(chatid, charname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/removechar] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.post('/api/parts/shells\\:chat/:chatid/plugin', authenticate, async (req, res) => {
		try {
			const { params: { chatid }, body: { pluginname } } = req
			await addplugin(chatid, pluginname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/addplugin] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.delete('/api/parts/shells\\:chat/:chatid/plugin/:pluginname', authenticate, async (req, res) => {
		try {
			const { chatid, pluginname } = req.params
			await removeplugin(chatid, pluginname)
			res.status(200).json({ success: true })
		} catch (err) {
			if (err.message === 'Chat not found') return res.status(404).json({ error: 'Chat not found' })
			console.error('[chat/removeplugin] Error:', err.message)
			res.status(500).json({ error: err.message })
		}
	})

	router.post('/api/parts/shells\\:chat/new', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).json({ chatid: await newChat(username) })
	})

	router.get('/api/parts/shells\\:chat/getchatlist', authenticate, async (req, res) => {
		res.status(200).json(await getChatList((await getUserByReq(req)).username))
	})

	router.delete('/api/parts/shells\\:chat/delete', authenticate, async (req, res) => {
		const result = await deleteChat(req.body.chatids, (await getUserByReq(req)).username)
		res.status(200).json(result)
	})

	router.post('/api/parts/shells\\:chat/addfile', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const data = req.files
		for (const file of Object.values(data))
			await addfile(username, file.data)
		res.status(200).json({ message: 'files added' })
	})

	router.get('/api/parts/shells\\:chat/getfile', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { hash } = req.query
		const data = await getfile(username, hash)
		res.status(200).send(data)
	})

	// ---- 批量删除消息范围 API（文件模式隔离用） ----
	router.post('/api/parts/shells\\:chat/:chatid/messages/delete-range', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			const { startIndex, endIndex } = req.body
			if (startIndex == null) return res.status(400).json({ error: 'Missing startIndex' })
			const result = await deleteMessagesRange(chatid, parseInt(startIndex, 10), endIndex != null ? parseInt(endIndex, 10) : undefined)
			res.status(200).json({ success: true, ...result })
		} catch (err) {
			console.error('[chat/deleteMessagesRange] Error:', err)
			res.status(500).json({ error: err.message })
		}
	})

	// ---- 伪发送 API ----
	router.get('/api/parts/shells\\:chat/:chatid/fake-send', authenticate, async (req, res) => {
		try {
			const { chatid } = req.params
			const charname = req.query.charname || undefined
			const result = await buildFakeSendRequest(chatid, charname)
			res.status(200).json(result)
		} catch (err) {
			console.error('[chat/fake-send] Error:', err)
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/virtual_files/parts/shells\\:chat/:chatid', authenticate, async (req, res) => {
		const { chatid } = req.params
		const exportResult = await exportChat([chatid])
		if (!exportResult[0]?.success)
			return res.status(500).json({ message: exportResult[0]?.message || 'Failed to export chat' })

		const chatData = exportResult[0].data
		const filename = `chat-${chatid}.json`
		const fileContents = JSON.stringify(chatData, null, '\t')

		res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.send(fileContents)
	})
}

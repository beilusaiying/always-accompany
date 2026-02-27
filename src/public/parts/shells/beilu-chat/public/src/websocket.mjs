import { onServerEvent } from '../../../../../scripts/server_events.mjs'

import { createDiag } from './diagLogger.mjs'
import { currentChatId } from './endpoints.mjs'

const diag = createDiag('websocket')

// ============================================================
// EventBus 事件桥接 — 对标 JS-Slash-Runner event.ts
// ============================================================

/**
 * 通过父页面 EventBus 发送事件
 *
 * 对标 JS-Slash-Runner 的 iframe_events / tavern_events：
 * - iframe_events.GENERATION_STARTED = 'js_generation_started'
 * - iframe_events.GENERATION_ENDED = 'js_generation_ended'
 * - tavern_events.GENERATION_STARTED = 'generation_started'
 * - tavern_events.MESSAGE_RECEIVED = 'message_received'
 * - tavern_events.MESSAGE_SENT = 'message_sent'
 * - tavern_events.GENERATION_ENDED = 'generation_ended'
 *
 * @param {string} eventName - 事件名（与 eventConstants.mjs 中定义一致）
 * @param  {...any} args - 事件参数
 */
function _emitEventBus(eventName, ...args) {
	const bus = window.__beiluEventBus
	if (!bus || !bus._listeners) return
	const listeners = bus._listeners.get(eventName)
	if (!listeners || listeners.length === 0) return
	const copy = listeners.slice()
	for (const cb of copy) {
		try { cb(...args) } catch (e) {
			console.error('[websocket EventBridge]', eventName, e)
		}
	}
}

/**
 * 更新脚本 iframe 中的 SillyTavern.chat 数组
 *
 * 当 message_replaced 到来时，需要同步更新脚本 iframe 的 chat 数组，
 * 确保 getAllVariables() 能读到最新的变量数据。
 *
 * @param {number} index - 消息在 chatLog 中的索引
 * @param {object} entry - 更新后的消息条目
 */
function _updateScriptIframeChat(index, entry) {
	const iframe = document.querySelector('.beilu-script-iframe')
	if (!iframe?.contentWindow?.SillyTavern) return

	try {
		const stChat = iframe.contentWindow.SillyTavern.chat
		if (!stChat) return

		// beilu role → 酒馆 role
		const stRole = entry.role === 'user' ? 'user' : 'assistant'
		const msgText = entry.content_for_show || entry.content || ''

		// 构建酒馆格式消息
		const stMsg = {
			message_id: index,
			name: entry.name || (stRole === 'user' ? 'User' : 'Character'),
			role: stRole,
			is_hidden: false,
			is_user: stRole === 'user',
			message: msgText,
			data: {},
			extra: {},
			is_system: false,
			mes: msgText,
			swipe_id: 0,
			swipes: [msgText],
			// ★ MVU 变量映射：extension.mvu_variables → variables[swipe_id]
			variables: [entry.extension?.mvu_variables || {}],
			swipe_info: [{}],
		}

		// 更新或追加
		if (index < stChat.length) {
			stChat[index] = stMsg
		} else {
			// 可能有间隔，用空对象填充
			while (stChat.length < index) {
				stChat.push({ variables: [{}], swipe_id: 0 })
			}
			stChat.push(stMsg)
		}
	} catch (e) {
		// iframe 可能已销毁或跨域
	}
}

import {
  addPartToSelect,
  handleCharAdded,
  handleCharFrequencySet,
  handleCharRemoved,
  handlePersonaSet,
  handlePluginAdded,
  handlePluginRemoved,
  handleWorldSet,
  removePartFromSelect,
} from './ui/sidebar.mjs'
import { handleTypingStatus } from './ui/typingIndicator.mjs'
import { handleMessageAdded, handleMessageDeleted, handleMessageReplaced, handleMessagesRangeDeleted, handleStreamUpdate, handleTimelineInfo } from './ui/virtualQueue.mjs'

let ws = null

/**
 * Sends a message through the WebSocket.
 * @param {object} message - The message object to send.
 */
export function sendWebsocketMessage(message) {
	if (ws && ws.readyState === WebSocket.OPEN)
		ws.send(JSON.stringify(message))
	else
		console.error('WebSocket is not connected.')
}

/**
 * 连接到WebSocket。
 */
function connect() {
	if (!currentChatId) return

	const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const wsUrl = `${wsProtocol}//${window.location.host}/ws/parts/shells:chat/ui/${currentChatId}`
	ws = new WebSocket(wsUrl)

	/**
	 * WebSocket收到消息时的回调。
	 * @param {MessageEvent} event - 消息事件。
	 */
	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data)
			// Handle broadcast events
			handleBroadcastEvent(msg)
		}
		catch (error) {
			console.error('Error processing WebSocket message:', error)
		}
	}

	/**
	 * WebSocket关闭时的回调。
	 */
	ws.onclose = () => {
		const RECONNECT_DELAY = 3000
		console.log(`Chat UI WebSocket disconnected. Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`)
		ws = null
		setTimeout(connect, RECONNECT_DELAY)
	}

	/**
	 * WebSocket出错时的回调。
	 * @param {Event} err - 错误事件。
	 */
	ws.onerror = (err) => {
		console.error('Chat UI WebSocket error:', err)
	}
}

/**
 * 处理广播事件。
 * @param {object} event - 事件。
 * @returns {Promise<void>}
 */
async function handleBroadcastEvent(event) {
	const { type, payload } = event
	switch (type) {
		case 'message_added':
			console.log('[websocket DIAG] message_added received:',
				'id:', payload?.id,
				'is_generating:', payload?.is_generating,
				'role:', payload?.role,
				'avatar:', payload?.avatar?.substring?.(0, 50),
				'content.len:', payload?.content?.length,
				'name:', payload?.name)
			await handleMessageAdded(payload)
				// ★ EventBus 桥接: 用户发送消息 → MESSAGE_SENT
				// 对标 JS-Slash-Runner tavern_events.MESSAGE_SENT
				if (payload?.role === 'user') {
					_emitEventBus('message_sent')
				}
				break
			case 'message_replaced':
			// ★ DIAG: 追踪 message_replaced 事件的 payload
			console.log('[websocket DIAG] message_replaced received:',
				'index:', payload.index,
				'entry.id:', payload.entry?.id,
				'entry.is_generating:', payload.entry?.is_generating,
				'entry.avatar:', payload.entry?.avatar?.substring?.(0, 50),
				'entry.content_len:', payload.entry?.content?.length)
			await handleMessageReplaced(payload.index, payload.entry)
				// ★ EventBus 桥接: 更新脚本 iframe 中的 SillyTavern.chat（含 MVU 变量）
				_updateScriptIframeChat(payload.index, payload.entry)
				// ★ EventBus 桥接: AI 生成完成 → MESSAGE_RECEIVED + GENERATION_ENDED
				// 对标 JS-Slash-Runner tavern_events + iframe_events
				if (!payload.entry?.is_generating && payload.entry?.role !== 'user') {
					_emitEventBus('message_received', payload.index)
					_emitEventBus('generation_ended', payload.index)
					_emitEventBus('js_generation_ended', payload.index)
				}
				break
			case 'message_deleted':
			await handleMessageDeleted(payload.index)
			break
		case 'messages_range_deleted':
			await handleMessagesRangeDeleted(payload.startIndex, payload.count)
			break
		case 'message_edited':
			await handleMessageReplaced(payload.index, payload.entry)
			break
		case 'timeline_info':
			handleTimelineInfo(payload)
			break
		case 'persona_set':
			await handlePersonaSet(payload.personaname)
			break
		case 'world_set':
			await handleWorldSet(payload.worldname)
			break
		case 'char_added':
			await handleCharAdded(payload.charname)
			break
		case 'char_removed':
			await handleCharRemoved(payload.charname)
			break
		case 'char_frequency_set':
			await handleCharFrequencySet(payload.charname, payload.frequency)
			break
		case 'plugin_added':
			await handlePluginAdded(payload.pluginname)
			break
		case 'plugin_removed':
			await handlePluginRemoved(payload.pluginname)
			break
		case 'typing_status':
			await handleTypingStatus(payload.typingList)
			break
		case 'stream_start':
			console.log('[websocket DIAG] stream_start:', 'messageId:', payload.messageId)
				// ★ EventBus 桥接: 生成开始 → GENERATION_STARTED
				// 对标 JS-Slash-Runner iframe_events + tavern_events
				_emitEventBus('js_generation_started')
				_emitEventBus('generation_started')
				break
		case 'stream_update':
			// 只记首次和每50次
			if (!window._streamUpdateCount) window._streamUpdateCount = {}
			if (!window._streamUpdateCount[payload.messageId]) window._streamUpdateCount[payload.messageId] = 0
			window._streamUpdateCount[payload.messageId]++
			if (window._streamUpdateCount[payload.messageId] === 1 || window._streamUpdateCount[payload.messageId] % 50 === 0) {
				console.log('[websocket DIAG] stream_update:',
					'messageId:', payload.messageId,
					'count:', window._streamUpdateCount[payload.messageId],
					'slices:', payload.slices?.length)
			}
			await handleStreamUpdate(payload)
			break
		default:
			console.warn(`Unknown broadcast event type: ${type}`)
	}
}

/**
 * 初始化WebSocket。
 */
export function initializeWebSocket() {
	if (ws) return
	connect()

	onServerEvent('part-installed', ({ parttype, partname }) => {
		addPartToSelect(parttype, partname)
	})

	onServerEvent('part-uninstalled', ({ parttype, partname }) => {
		removePartFromSelect(parttype, partname)
	})
}

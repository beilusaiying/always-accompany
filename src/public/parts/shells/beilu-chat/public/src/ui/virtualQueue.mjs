import { createVirtualList } from '../../../../../scripts/virtualList.mjs'
import { getChatLog, getChatLogLength } from '../../src/endpoints.mjs'
import { modifyTimeLine } from '../endpoints.mjs'
import { applySlice } from '../stream.mjs'

import { disableSwipe, enableSwipe, renderMessage } from './messageList.mjs'
import { streamRenderer } from './StreamRenderer.mjs'

const chatMessagesContainer = document.getElementById('chat-messages')
let virtualList = null
let currentSwipableElement = null
let currentTimeLineInfo = { timeLineIndex: 0, timeLinesCount: 1 }
const deletionListeners = []

// This map holds the full message object for streaming messages,
// which is necessary for applying slices correctly.
const streamingMessages = new Map()


/**
 * 添加一个在从 UI 中删除消息后将被调用的监听器。
 * @param {Function} callback - 要调用的函数。
 */
export function addDeletionListener(callback) {
	deletionListeners.push(callback)
}

/**
 * 通知所有已注册的删除监听器。
 */
function notifyDeletionListeners() {
	while (deletionListeners.length) deletionListeners.pop()()
}

/**
 * 更新最后一个 'char' 消息的左右箭头和滑动功能。
 */
function updateLastCharMessageArrows() {
	// 移除旧箭头、滑动功能和计数器
	chatMessagesContainer.querySelectorAll('.arrow').forEach(arrow => arrow.remove())
	chatMessagesContainer.querySelectorAll('.swipe-counter').forEach(c => c.remove())
	if (currentSwipableElement) {
		disableSwipe(currentSwipableElement)
		currentSwipableElement = null
	}

	const queue = virtualList.getQueue()
	if (!queue.length) return

	const lastMessageIndexInQueue = queue.length - 1
	const lastMessage = queue[lastMessageIndexInQueue]

	if (lastMessage && lastMessage.role === 'char' && !lastMessage.is_generating) {
		// Use the unique ID to find the element
		const lastMessageElement = document.getElementById(lastMessage.id)

		if (lastMessageElement) {
			currentSwipableElement = lastMessageElement
			const messageContent = lastMessageElement.querySelector('.message-content')

			if (messageContent) {
				enableSwipe(lastMessageElement)

				const leftArrow = document.createElement('div')
				leftArrow.classList.add('arrow', 'left')
				leftArrow.textContent = '❮'
				messageContent.after(leftArrow)

				const rightArrow = document.createElement('div')
				rightArrow.classList.add('arrow', 'right')
				rightArrow.textContent = '❯'
				leftArrow.after(rightArrow)

				// Swipe 计数器（显示当前时间线索引 / 总数）
				const counter = document.createElement('div')
				counter.classList.add('swipe-counter')
				counter.textContent = `${currentTimeLineInfo.timeLineIndex + 1}/${currentTimeLineInfo.timeLinesCount}`
				counter.style.opacity = currentTimeLineInfo.timeLinesCount > 1 ? '1' : '0.3'
				rightArrow.after(counter)

				/**
				 * 移除左右箭头和计数器
				 */
				const removeArrows = () => { leftArrow.remove(); rightArrow.remove(); counter.remove() }
				leftArrow.addEventListener('click', async () => { removeArrows(); await modifyTimeLine(-1) })
				rightArrow.addEventListener('click', async () => { removeArrows(); await modifyTimeLine(1) })
			}
		}
	}
}

/**
 * 初始化虚拟队列。
 * @param {object} initialData - 初始数据 (不再使用，但保留函数签名以防万一).
 * @returns {Promise<void>} - 无返回值。
 */
export async function initializeVirtualQueue(initialData) {
	// 初始化 timeline 信息（用于 swipe 计数器显示）
	if (initialData?.timeLineIndex !== undefined) {
		currentTimeLineInfo = {
			timeLineIndex: initialData.timeLineIndex,
			timeLinesCount: initialData.timeLinesCount || 1,
		}
	}

	if (virtualList)
		virtualList.destroy()

	streamingMessages.clear()
	if (streamRenderer)
		streamRenderer.streamingMessages.clear()


	let total = await getChatLogLength()

	// 消息加载限制：从 localStorage 读取用户设置的限制值
	const msgLoadLimit = parseInt(localStorage.getItem('beilu-msg-load-limit') || '0', 10)
	let effectiveTotal = total
	let offsetShift = 0
	if (msgLoadLimit > 0 && total > msgLoadLimit) {
		offsetShift = total - msgLoadLimit
		effectiveTotal = msgLoadLimit
	}

	virtualList = createVirtualList({
		container: chatMessagesContainer,
		/**
		 * 异步函数，用于获取数据块。
		 * @param {number} offset - 数据块的起始偏移量。
		 * @param {number} limit - 数据块的大小。
		 * @returns {Promise<{items: Array<object>, total: number}>} - 包含项目数组和总数的对象。
		 */
		fetchData: async (offset, limit) => {
			const actualOffset = offset + offsetShift
			const items = await getChatLog(actualOffset, actualOffset + limit)
			return { items, total: effectiveTotal }
		},
		renderItem: renderMessage,
		initialIndex: effectiveTotal > 0 ? effectiveTotal - 1 : 0,
		onRenderComplete: updateLastCharMessageArrows,
		itemIdKey: 'id', // Use the unique 'id' property as the key
	})
}

/**
 * 替换队列中的消息。
 * @param {number} queueIndex - 队列中要替换的消息的索引。
 * @param {object} message - 新的消息对象。
 */
export async function replaceMessageInQueue(queueIndex, message) {
	if (!virtualList) return
	const logIndex = virtualList.getChatLogIndexByQueueIndex(queueIndex)
	await virtualList.replaceItem(logIndex, message)
}

/**
 * 获取给定元素的队列索引。
 * @param {HTMLElement} element - 要获取索引的 DOM 元素。
 * @returns {number} 元素的队列索引，如果不是有效消息元素则返回 -1。
 */
export function getQueueIndex(element) {
	return virtualList ? virtualList.getQueueIndex(element) : -1
}

/**
 * 根据队列索引获取聊天日志索引。
 * @param {number} queueIndex - 队列中的索引。
 * @returns {number} 聊天日志中的索引，如果索引无效则返回 -1。
 */
export function getChatLogIndexByQueueIndex(queueIndex) {
	return virtualList ? virtualList.getChatLogIndexByQueueIndex(queueIndex) : -1
}

/**
 * 根据队列索引获取消息元素。
 * @param {number} queueIndex - 队列中的索引。
 * @returns {HTMLElement|null} 对应的消息 DOM 元素，如果不存在则为 null。
 */
export function getMessageElementByQueueIndex(queueIndex) {
	if (!virtualList) return null
	const item = virtualList.getQueue()[queueIndex]
	if (!item) return null
	return document.getElementById(item.id)
}

/**
 * 清理虚拟队列的观察者。
 */
export function cleanupVirtualQueueObserver() {
	if (virtualList) {
		virtualList.destroy()
		virtualList = null
	}
	if (currentSwipableElement) {
		disableSwipe(currentSwipableElement)
		currentSwipableElement = null
	}
	streamingMessages.clear()
	if (streamRenderer)
		streamRenderer.streamingMessages.clear()
}

// --- Handlers for websocket events ---

/**
 * 处理消息添加事件。
 * @param {object} message - 要添加的消息对象。
 */
export async function handleMessageAdded(message) {
	if (!virtualList) return

	// 使用事件队列确保顺序处理
	await enqueueMessageEvent(message.id, 'message_added', async () => {
		if (message.is_generating) {
			// 如果是正在生成的消息，先不添加到列表（避免显示空气泡）
			// 标记为 pendingRender，等待第一次 stream_update 或 message_replaced 时再渲染
			const itemState = {
				messageData: message,
				pendingRender: true
			}
			streamingMessages.set(message.id, itemState)

			// 设置 200ms 超时，如果超时还没收到 stream_update，强制渲染骨架屏
			setTimeout(async () => {
				if (itemState.pendingRender) {
					itemState.pendingRender = false
					const shouldScroll = chatMessagesContainer.scrollTop >= chatMessagesContainer.scrollHeight - chatMessagesContainer.clientHeight - 20
					await virtualList.appendItem(message, shouldScroll)
					// 这里不注册 streamRenderer，因为内容为空，等待真正的 stream_update 更新内容
				}
			}, 500)
		} else {
			// 普通消息直接添加
			const shouldScroll = chatMessagesContainer.scrollTop >= chatMessagesContainer.scrollHeight - chatMessagesContainer.clientHeight - 20
			await virtualList.appendItem(message, shouldScroll)
		}
	})
}

/**
 * 处理消息替换事件。
 * @param {number} index - 被替换消息的日志索引。
 * @param {object} message - 新的消息对象。
 */
export async function handleMessageReplaced(index, message) {
	if (!virtualList) return

	// 使用事件队列确保顺序处理
	await enqueueMessageEvent(message.id, 'message_replaced', async () => {
		const itemState = streamingMessages.get(message.id)

		// 如果消息处于 pendingRender 状态（说明是非流式角色，或者流式角色生成极快直接完成了）
		// 此时直接作为新消息添加到列表底部
		if (itemState?.pendingRender) {
			itemState.pendingRender = false
			const shouldScroll = chatMessagesContainer.scrollTop >= chatMessagesContainer.scrollHeight - chatMessagesContainer.clientHeight - 20
			await virtualList.appendItem(message, shouldScroll)
			streamingMessages.delete(message.id)
			updateLastCharMessageArrows()
			return
		}

		// Find the item in the queue by its log index before it gets replaced
		const queue = virtualList.getQueue()
		for (let i = 0; i < queue.length; i++) {
			const logIndex = virtualList.getChatLogIndexByQueueIndex(i)
			if (logIndex === index) {
				const oldItem = queue[i]
				if (oldItem && streamingMessages.has(oldItem.id)) {
					streamRenderer.stop(oldItem.id)
					streamingMessages.delete(oldItem.id)
				}
				break
			}
		}

		await virtualList.replaceItem(index, message)

		// If the newly replaced message is a generating one
		if (message.is_generating) {
			streamingMessages.set(message.id, { messageData: message })
			streamRenderer.register(message.id, message.content)
		}

		updateLastCharMessageArrows()
	})
}

/**
 * 处理消息移除事件。
 * @param {number} index - 被移除消息的日志索引。
 */
export async function handleMessageDeleted(index) {
	if (!virtualList) return

	// Find the item in the queue by its log index before it gets deleted
	const queue = virtualList.getQueue()
	for (let i = 0; i < queue.length; i++) {
		const logIndex = virtualList.getChatLogIndexByQueueIndex(i)
		if (logIndex === index) {
			const itemToDelete = queue[i]
			if (itemToDelete && streamingMessages.has(itemToDelete.id)) {
				streamRenderer.stop(itemToDelete.id)
				streamingMessages.delete(itemToDelete.id)
			}
			break
		}
	}


	await virtualList.deleteItem(index)
	notifyDeletionListeners()
}

/**
 * 处理批量消息删除事件（文件模式退出时的清理）。
 * @param {number} startIndex - 起始索引（含）
 * @param {number} count - 删除数量
 */
export async function handleMessagesRangeDeleted(startIndex, count) {
	if (!virtualList || count <= 0) return

	// 从后往前逐个删除，避免索引移位
	for (let i = startIndex + count - 1; i >= startIndex; i--) {
		// 清理可能的流式状态
		const queue = virtualList.getQueue()
		for (let j = 0; j < queue.length; j++) {
			const logIndex = virtualList.getChatLogIndexByQueueIndex(j)
			if (logIndex === i) {
				const item = queue[j]
				if (item && streamingMessages.has(item.id)) {
					streamRenderer.stop(item.id)
					streamingMessages.delete(item.id)
				}
				break
			}
		}

		try {
			await virtualList.deleteItem(i)
		} catch (err) {
			console.warn(`[virtualQueue] 批量删除索引 ${i} 失败:`, err.message)
		}
	}

	notifyDeletionListeners()
	updateLastCharMessageArrows()
}

/**
 * 获取当前渲染的消息队列。
 * @returns {Array<object>} 当前队列数组。
 */
export function getQueue() {
	return virtualList ? virtualList.getQueue() : []
}

// Message event queue system to handle race conditions elegantly
// Each message ID has its own queue that processes events sequentially
const messageEventQueues = new Map()

/**
 * 将消息事件加入队列并按顺序处理。
 * @param {string} messageId - 消息的唯一ID。
 * @param {string} eventType - 事件类型（用于日志）。
 * @param {Function} handler - 处理该事件的异步函数。
 * @returns {Promise<void>}
 */
async function enqueueMessageEvent(messageId, eventType, handler) {
	if (!messageEventQueues.has(messageId))
		messageEventQueues.set(messageId, {
			queue: [],
			processing: false
		})

	const queueData = messageEventQueues.get(messageId)
	queueData.queue.push({ eventType, handler })

	// 如果当前没有在处理队列，开始处理
	if (!queueData.processing)
		processMessageEventQueue(messageId)
}

/**
 * 处理消息的事件队列。
 * @param {string} messageId - 消息的唯一ID。
 * @returns {Promise<void>}
 */
async function processMessageEventQueue(messageId) {
	const queueData = messageEventQueues.get(messageId)
	if (!queueData || queueData.processing) return

	queueData.processing = true

	while (queueData.queue.length > 0) {
		const { eventType, handler } = queueData.queue.shift()
		try {
			await handler()
		} catch (error) {
			console.error(`[EventQueue] Error processing ${eventType} for message ${messageId}:`, error)
		}
	}

	queueData.processing = false
	messageEventQueues.delete(messageId) // 处理完成后清理队列
}

/**
 * 处理流式更新。
 * @param {object} payload - 更新数据。
 * @param {string} payload.messageId - 消息的唯一ID。
 * @param {Array<object>} payload.slices - 要应用的切片数组。
 */
/**
 * 处理 timeline_info 事件（更新 swipe 计数器）。
 * @param {object} info - { timeLineIndex, timeLinesCount }
 */
export function handleTimelineInfo(info) {
	if (info) {
		currentTimeLineInfo = {
			timeLineIndex: info.timeLineIndex ?? 0,
			timeLinesCount: info.timeLinesCount ?? 1,
		}
		updateLastCharMessageArrows()
	}
}

export async function handleStreamUpdate({ messageId, slices }) {
	// 使用事件队列确保顺序处理
	await enqueueMessageEvent(messageId, 'stream_update', async () => {
		const itemState = streamingMessages.get(messageId)
		if (!itemState) return

		// 如果消息处于 pendingRender 状态，说明是第一次收到流更新
		// 此时才将消息添加到列表（开始渲染）
		if (itemState.pendingRender) {
			const shouldScroll = chatMessagesContainer.scrollTop >= chatMessagesContainer.scrollHeight - chatMessagesContainer.clientHeight - 20
			await virtualList.appendItem(itemState.messageData, shouldScroll)
			itemState.pendingRender = false
			// 注册到 streamRenderer
			streamRenderer.register(messageId, itemState.messageData.content)
		} else if (!streamRenderer.streamingMessages.has(messageId)) {
			// 500ms 超时已渲染骨架屏，但 streamRenderer 还未注册
			// 此处补注册，使后续 updateTarget 生效，启动逐字渲染
			streamRenderer.register(messageId, itemState.messageData.content || '')
		}

		// Apply patches to the data model
		for (const slice of slices)
			applySlice(itemState.messageData, slice)

		// Notify the renderer of the new target content
		streamRenderer.updateTarget(messageId, itemState.messageData.content)
	})
}

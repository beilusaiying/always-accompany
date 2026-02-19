import { confirmI18n, geti18n, main_locale } from '../../../../../scripts/i18n.mjs'
import { renderMarkdownAsStandAloneHtmlString, renderMarkdownAsString } from '../../../../../scripts/markdown.mjs'
import { onElementRemoved } from '../../../../../scripts/onElementRemoved.mjs'
import { renderTemplate, renderTemplateAsHtmlString, renderTemplateNoScriptActivation } from '../../../../../scripts/template.mjs'
import { showToast, showToastI18n } from '../../../../../scripts/toast.mjs'
import { stopGeneration } from '../chat.mjs'
import { activateScriptsInElement, applyBuiltinProcessors, applyDisplayRules, detectContentType, getRenderMode, restorePlaceholders } from '../displayRegex.mjs'
import {
  deleteMessage,
  editMessage,
  modifyTimeLine,
} from '../endpoints.mjs'
import { handleFilesSelect, renderAttachmentPreview } from '../fileHandling.mjs'
import { getfile } from '../files.mjs'
import { createShareLink } from '../share.mjs'
import { DEFAULT_AVATAR, SWIPE_THRESHOLD, TRANSITION_DURATION, arrayBufferToBase64 } from '../utils.mjs'

import { addDragAndDropSupport } from './dragAndDrop.mjs'
import { renderAsIframe } from './iframeRenderer.mjs'
import {
  addDeletionListener,
  getChatLogIndexByQueueIndex,
  getMessageElementByQueueIndex,
  getQueueIndex,
  replaceMessageInQueue,
} from './virtualQueue.mjs'

// 用于存储滑动事件监听器的 Map
const swipeListenersMap = new WeakMap()
const deletionQueue = []

/**
 * 为每个消息对象存储其专属的 markdown 渲染缓存
 * @type {WeakMap<object, object>}
 */
const messageRenderCacheMap = new WeakMap()

/**
 * 获取或创建消息的渲染缓存对象
 * @param {object} message - 消息对象
 * @returns {object} 缓存对象
 */
function getMessageCache(message) {
	let cache = messageRenderCacheMap.get(message)
	if (!cache) messageRenderCacheMap.set(message, cache = {})
	return cache
}

/**
 * 按顺序处理删除队列。
 */
async function processDeletionQueue() {
	const messageElement = deletionQueue.shift()
	if (!messageElement) return
	try {
		const queueIndex = getQueueIndex(messageElement)
		if (queueIndex === -1) return
		const chatLogIndex = getChatLogIndexByQueueIndex(queueIndex)
		const uiUpdated = new Promise(resolve => addDeletionListener(resolve))
		await deleteMessage(chatLogIndex)
		await uiUpdated
	}
	catch (error) {
		console.error('Error processing deletion:', error)
		showToast('error', error.stack || error.message || error)
	}
}
setTimeout(async () => {
	while (true) {
		await processDeletionQueue()
		await new Promise(resolve => setTimeout(resolve, 1000))
	}
})

/**
 * 将消息元素添加到删除队列。
 * @param {HTMLElement} messageElement - 要删除的消息元素。
 */
function enqueueDeletion(messageElement) {
	deletionQueue.push(messageElement)
}

/**
 * 为消息生成完整的 HTML 文档，包括样式表和附件以正确呈现。
 * 如果消息内容包含 H1 标签，其文本将用作文档标题。
 * @param {object} message - 消息对象。
 * @param {object} cache - 缓存对象（与普通渲染共享）。
 * @returns {Promise<string>} 完整的 HTML 字符串。
 */
async function generateFullHtmlForMessage(message, cache) {
	return renderTemplateAsHtmlString('standalone_message', {
		main_locale,
		message,
		/**
		 * 渲染 Markdown 为 HTML 字符串（带缓存复用）
		 * @param {string} markdown - Markdown 文本
		 * @returns {Promise<string>} HTML 字符串
		 */
		renderMarkdownAsStandAloneHtmlString: markdown => renderMarkdownAsStandAloneHtmlString(markdown, cache),
		geti18n,
		getfile,
		arrayBufferToBase64,
	})
}

/**
 * 渲染单条消息元素。
 * @param {object} message - 消息对象。
 * @returns {Promise<HTMLElement>} - 渲染好的消息 DOM 元素。
 */
export async function renderMessage(message) {
	const cache = getMessageCache(message)

	// 获取原始内容，先应用内置处理器（思维链折叠等），再应用 display regex
	const rawContent = message.content_for_show || message.content
	const builtinProcessed = applyBuiltinProcessors(rawContent)
	// 传入消息角色，用户消息不应用 display regex（防止内容消失）
	const messageRole = message.role || (message.is_user ? 'user' : '')
	const { text: displayProcessed, placeholders } = applyDisplayRules(builtinProcessed, { role: messageRole })

	// ★ 内容类型检测：决定走哪条渲染路径
	const contentType = detectContentType(displayProcessed)
	const currentRenderMode = getRenderMode()

	let renderedContent
	if (contentType === 'full-html') {
		if (currentRenderMode === 'sandbox') {
			// 沙盒模式：跳过 markdown 渲染，后续由 iframeRenderer 处理
			renderedContent = '<div class="iframe-placeholder">正在加载美化视图...</div>'
		} else {
			// 自由模式：直接注入 HTML，跳过 markdown 渲染
			renderedContent = displayProcessed
		}
	} else {
		// 普通 markdown 或脚本片段 → 走原有 markdown 管线
		renderedContent = await renderMarkdownAsString(displayProcessed, cache)
		if (placeholders.size > 0) {
			renderedContent = restorePlaceholders(renderedContent, placeholders)
		}
	}

	// ★ 预计算 media 判断，避免在模板中对 content 做 match（模板引擎会解析 content 中的 ${} 导致卡死）
	const contentHasMedia = /<(?:video|iframe)\b[^>]*>[\s\S]*?<\/(?:video|iframe)>/gi.test(renderedContent)

	// 预处理 avatar，确保它是有效的 URL 字符串，避免模板引擎解析错误
	// 如果 avatar 包含 '}' 等特殊字符，可能会干扰模板解析
	let safeAvatar = message.avatar || DEFAULT_AVATAR;
	// 简单的转义，防止模板注入
	if (typeof safeAvatar === 'string') {
		safeAvatar = safeAvatar.replace(/"/g, '"');
	}

	const preprocessedMessage = {
		...message,
		avatar: safeAvatar,
		time_stamp: new Date(message.time_stamp).toLocaleString(),
		content: '',              // ★ 空占位：不通过模板 ${content} 传递，避免模板引擎解析 HTML 中的 ${}
		contentHasMedia,          // ★ 预计算的 media 标志，供模板判断 w-full class
	}

	if (message.is_generating) {
		const messageElement = await renderTemplateNoScriptActivation('message_generating_view', preprocessedMessage)
		// Add stop button listener
		const stopButton = messageElement.querySelector('.stop-generating-button')
		if (stopButton)
			stopButton.addEventListener('click', () => {
				stopGeneration(message.id)
			})

		const skeleton = messageElement.querySelector('.skeleton-loader')
		const contentEl = messageElement.querySelector('.message-content')
		if (skeleton && contentEl) {
			if (!renderedContent || !renderedContent.trim()) {
				skeleton.classList.remove('hidden')
				contentEl.classList.add('hidden')
			} else {
				skeleton.classList.add('hidden')
				contentEl.classList.remove('hidden')
			}
		}

		// ★ 通过 DOM 注入内容，绕过模板引擎
		if (contentEl && renderedContent) {
			contentEl.innerHTML = renderedContent
		}

		return messageElement
	}

	const messageElement = await renderTemplate('message_view', preprocessedMessage)
	const messageContentElement = messageElement.querySelector('.message-content')
	// ★ 通过 DOM 注入内容，绕过模板引擎的 ${} 解析器
	if (messageContentElement && renderedContent) {
		messageContentElement.innerHTML = renderedContent
	}
	const messageMarkdownContent = message.content_for_show || message.content

	// --- 拖放下载功能 ---
	// ★ 延迟生成 standaloneMessage：standalone_message 模板含 ${messageHtml}，
	//   如果消息内容含 ${ 字符，模板引擎会无限循环。改为按需生成，不阻塞消息渲染。
	let standaloneMessageUrl = ''
	let standaloneGenerated = false

	/**
	 * 按需生成 standalone HTML（仅在拖拽/下载/分享时才调用）
	 * @returns {Promise<string>} blob URL
	 */
	async function ensureStandaloneUrl() {
		if (standaloneGenerated) return standaloneMessageUrl
		standaloneGenerated = true
		try {
			const html = await generateFullHtmlForMessage(message, cache)
			standaloneMessageUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
		} catch (err) {
			console.warn('[messageList] generateFullHtmlForMessage failed:', err.message)
		}
		return standaloneMessageUrl
	}

	onElementRemoved(messageElement, () => {
		if (standaloneMessageUrl) URL.revokeObjectURL(standaloneMessageUrl)
	})

	messageElement.addEventListener('mousedown', e => {
		// If the mousedown is on an interactive part, don't make the message draggable.
		// This allows text selection, button clicks, etc.
		if (e.target.closest('.message-content, textarea'))
			messageElement.draggable = false
		else // Otherwise, allow dragging the whole message.
			messageElement.draggable = true
	})

	/**
	 * 清理可拖拽状态以防止意外行为。
	 * @returns {void}
	 */
	const cleanupDraggable = () => { messageElement.draggable = false }
	messageElement.addEventListener('mouseup', cleanupDraggable)
	messageElement.addEventListener('mouseleave', cleanupDraggable)
	messageElement.addEventListener('dragend', cleanupDraggable)

	messageElement.addEventListener('dragstart', async event => {
		const fileName = `message-${message.id}.html`
		const url = await ensureStandaloneUrl()

		event.dataTransfer.setData('DownloadURL', `text/html:${fileName}:${url}`)
		event.dataTransfer.effectAllowed = 'copy'

		event.dataTransfer.setData('text/plain', messageContentElement.textContent.trim())
		event.dataTransfer.setData('text/markdown', message.content)
		event.dataTransfer.setData('text/html', renderedContent)
	})

	// --- 删除按钮 ---
	const deleteButtons = messageElement.querySelectorAll('.delete-button')
	deleteButtons.forEach(deleteButton => {
		deleteButton.addEventListener('click', () => {
			// Count lines in the message content
			const lineCount = messageMarkdownContent.split('\n').length
			// Skip confirmation for messages with less than 30 lines
			const needsConfirmation = lineCount >= 30

			if (!needsConfirmation || confirmI18n('chat.messageList.confirmDeleteMessage')) {
				deleteButtons.forEach(btn => btn.disabled = true)
				enqueueDeletion(messageElement)
			}
		})
	})

	// --- Shift key detection for button visibility ---
	const buttonGroup = messageElement.querySelector('.button-group')
	const normalButtons = buttonGroup.querySelector('.normal-buttons')
	const shiftButtons = buttonGroup.querySelector('.shift-buttons')

	let isShiftPressed = false

	/**
	 * 更新按钮可见性
	 */
	const updateButtonVisibility = () => {
		if (isShiftPressed) {
			normalButtons.style.display = 'none'
			shiftButtons.style.display = 'flex'
		} else {
			normalButtons.style.display = 'flex'
			shiftButtons.style.display = 'none'
		}
	}

	/**
	 * 处理按下 Shift 键
	 * @param {KeyboardEvent} e 事件
	 */
	const handleKeyDown = (e) => {
		if (e.key === 'Shift' && !isShiftPressed) {
			isShiftPressed = true
			updateButtonVisibility()
		}
	}

	/**
	 * 处理松开 Shift 键
	 * @param {KeyboardEvent} e 事件
	 */
	const handleKeyUp = (e) => {
		if (e.key === 'Shift' && isShiftPressed) {
			isShiftPressed = false
			updateButtonVisibility()
		}
	}

	// Add keyboard event listeners
	document.addEventListener('keydown', handleKeyDown)
	document.addEventListener('keyup', handleKeyUp)

	// Clean up listeners when element is removed
	onElementRemoved(messageElement, () => {
		document.removeEventListener('keydown', handleKeyDown)
		document.removeEventListener('keyup', handleKeyUp)
	})

	// Initialize button visibility
	updateButtonVisibility()

	// --- Direct Download HTML button (shift mode) ---
	const downloadHtmlButtonDirect = messageElement.querySelector('.download-html-button-direct')
	downloadHtmlButtonDirect.addEventListener('click', async () => {
		try {
			const url = await ensureStandaloneUrl()
			const a = document.createElement('a')
			a.href = url
			a.download = `message-${message.id}.html`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
		}
		catch (error) {
			showToast('error', error.stack || error.message || error)
		}
	})

	// 获取 dropdown 菜单元素
	const dropdownMenu = messageElement.querySelector('.dropdown')
	messageElement.addEventListener('mouseleave', () => dropdownMenu.hidePopover())

	// 获取 dropdown items
	dropdownMenu.querySelector('.copy-markdown-button').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(messageMarkdownContent)
		} catch (error) { showToast('error', error.stack || error.message || error) }
		dropdownMenu.hidePopover()
	})
	dropdownMenu.querySelector('.copy-text-button').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(messageContentElement.textContent.trim())
		} catch (error) { showToast('error', error.stack || error.message || error) }
		dropdownMenu.hidePopover()
	})
	dropdownMenu.querySelector('.copy-html-button').addEventListener('click', async () => {
		try {
			const fullHtml = await generateFullHtmlForMessage(message)
			await navigator.clipboard.writeText(fullHtml)
		} catch (error) { showToast('error', error.stack || error.message || error) }
		dropdownMenu.hidePopover()
	})

	// --- Download as HTML button ---
	const downloadHtmlButton = dropdownMenu.querySelector('.download-html-button')
	downloadHtmlButton.addEventListener('click', async () => {
		try {
			const url = await ensureStandaloneUrl()
			const a = document.createElement('a')
			a.href = url
			a.download = `message-${message.id}.html`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
		}
		catch (error) {
			showToast('error', error.stack || error.message || error)
		}
		dropdownMenu.hidePopover()
	})

	// --- Share buttons ---
	const shareButtons = dropdownMenu.querySelectorAll('.share-button')
	shareButtons.forEach(button => {
		button.addEventListener('click', async () => {
			try {
				const { time } = button.dataset
				showToastI18n('info', 'chat.messageView.share.uploading')
				const blob = new Blob([await generateFullHtmlForMessage(message)], { type: 'text/html' })
				const link = await createShareLink(blob, `message-${message.id}.html`, time)

				await navigator.clipboard.writeText(link)
				showToastI18n('success', 'chat.messageView.share.success', {
					provider: 'litterbox.moe',
					sponsorLink: 'https://store.catbox.moe/'
				})
			}
			catch (error) {
				showToast('error', error.stack || error.message || error)
			}
			dropdownMenu.hidePopover()
		})
	})

	// --- 编辑按钮 ---
	const editButton = messageElement.querySelector('.edit-button')
	editButton.addEventListener('click', async () => {
		const queueIndex = getQueueIndex(messageElement)
		if (queueIndex === -1) return
		const chatLogIndex = getChatLogIndexByQueueIndex(queueIndex)
		if (chatLogIndex === -1) return
		await editMessageStart(message, queueIndex, chatLogIndex) // 显示编辑界面
	})

	// --- iframe 渲染（完整 HTML 文档 + 沙盒模式） ---
	if (contentType === 'full-html' && currentRenderMode === 'sandbox') {
		renderAsIframe(displayProcessed, messageElement)
	}

	// --- 自由模式：直接激活 full-html 中的脚本 ---
	if (contentType === 'full-html' && currentRenderMode === 'free') {
		const messageContentElement2 = messageElement.querySelector('.message-content')
		if (messageContentElement2) {
			await activateScriptsInElement(messageContentElement2)
		}
	}

	// --- 激活 display regex 注入的脚本（非 full-html 模式） ---
	if (contentType !== 'full-html' && displayProcessed !== rawContent) {
		// display regex 做了替换，可能注入了 <script> 标签
		const messageContentElement2 = messageElement.querySelector('.message-content')
		if (messageContentElement2) {
			await activateScriptsInElement(messageContentElement2)
		}
	}

	// --- 渲染附件 ---
	if (message.files?.length) {
		const attachmentsContainer = messageElement.querySelector('.attachments')
		if (attachmentsContainer) {
			if (message.files.length === 1)
				attachmentsContainer.classList.add('is-single-attachment')

			attachmentsContainer.innerHTML = ''
			const attachmentPromises = message.files.map((file, index) =>
				renderAttachmentPreview(file, index, null)
			)
			const renderedAttachments = await Promise.all(attachmentPromises)
			renderedAttachments.forEach(attachmentElement => {
				if (attachmentElement) attachmentsContainer.appendChild(attachmentElement)
			})
		}
	}

	return messageElement
}

/**
 * 开始编辑指定消息。
 * @param {object} message - 原始消息。
 * @param {number} queueIndex - 在队列中的索引。
 * @param {number} chatLogIndex - 在聊天记录中的绝对索引。
 */
export async function editMessageStart(message, queueIndex, chatLogIndex) {
	const selectedFiles = [...message.files || []] // 文件副本
	const editRenderedMessage = {
		...message,
		avatar: message.avatar || DEFAULT_AVATAR,
		time_stamp: new Date(message.time_stamp).toLocaleString(),
		content_for_edit: message.content_for_edit || message.content, // 编辑专用内容
	}

	const messageElement = await getMessageElementByQueueIndex(queueIndex)
	if (!messageElement) return

	// 平滑过渡：淡出
	messageElement.style.transition = `opacity ${TRANSITION_DURATION / 1000}s ease-in-out`
	messageElement.style.opacity = '0'
	await new Promise(resolve => setTimeout(resolve, TRANSITION_DURATION))

	// 渲染编辑视图并替换
	const editViewHtml = await renderTemplateAsHtmlString('message_edit_view', editRenderedMessage)
	messageElement.innerHTML = editViewHtml

	// 获取编辑视图元素
	const fileEditInput = messageElement.querySelector(`#file-edit-input-${message.id}`)
	const attachmentPreview = messageElement.querySelector(`#attachment-edit-preview-${message.id}`)
	const editInput = messageElement.querySelector(`#edit-input-${message.id}`)
	const confirmButton = messageElement.querySelector(`#confirm-button-${message.id}`)
	const cancelButton = messageElement.querySelector(`#cancel-button-${message.id}`)
	const uploadButton = messageElement.querySelector(`#upload-edit-button-${message.id}`)

	// 添加拖拽上传支持
	addDragAndDropSupport(editInput, selectedFiles, attachmentPreview)

	// keyboard shortcuts for editing
	editInput.addEventListener('keydown', event => {
		if (event.key === 'Enter' && event.ctrlKey) {
			event.preventDefault() // Prevent newline
			event.stopPropagation() // Prevent bubbling
			confirmButton.click()
		}
		else if (event.key === 'Escape') {
			event.preventDefault() // Prevent default action
			event.stopPropagation() // Prevent bubbling
			cancelButton.click()
		}
	})

	// --- 确认编辑 ---
	confirmButton.addEventListener('click', async () => {
		const newMessage = { ...message, content: editInput.value, files: selectedFiles }
		await editMessage(chatLogIndex, newMessage) // 后端编辑
	})

	// --- 取消编辑 ---
	cancelButton.addEventListener('click', async () => {
		await replaceMessageInQueue(queueIndex, message) // 恢复原始消息视图
	})

	// --- 渲染编辑状态的附件 ---
	attachmentPreview.innerHTML = ''
	const attachmentPromises = selectedFiles.map((file, i) =>
		renderAttachmentPreview(file, i, selectedFiles) // 传入 selectedFiles 以支持删除
	)
	const renderedAttachments = await Promise.all(attachmentPromises)
	renderedAttachments.forEach(el => { if (el) attachmentPreview.appendChild(el) })

	// --- 编辑状态上传按钮 ---
	uploadButton.addEventListener('click', () => fileEditInput.click())

	// --- 文件选择处理 ---
	fileEditInput.addEventListener('change', event =>
		handleFilesSelect(event, selectedFiles, attachmentPreview) // 更新 selectedFiles 和预览
	)

	// 平滑过渡：淡入
	messageElement.style.opacity = '1'

	// 自动聚焦并移动光标到末尾
	editInput.focus()
	editInput.setSelectionRange(editInput.value.length, editInput.value.length)
}

/**
 * 公开接口：替换指定索引的消息。
 * @param {number} index - 队列索引 (queueIndex)。
 * @param {object} message - 新消息对象。
 */
export async function replaceMessage(index, message) {
	await replaceMessageInQueue(index, message)
}

/**
 * 为消息元素启用左右滑动切换时间线的功能。
 * @param {HTMLElement} messageElement - 需要启用滑动的消息 DOM 元素。
 */
export function enableSwipe(messageElement) {
	if (swipeListenersMap.has(messageElement)) disableSwipe(messageElement) // 防重复添加

	let touchStartX = 0, touchStartY = 0, isDragging = false, swipeHandled = false

	// --- 定义命名的监听器函数 ---
	/**
	 * 处理触摸开始事件。
	 * @param {TouchEvent} event - 触摸事件对象。
	 */
	const handleTouchStart = event => {
		if (event.touches.length !== 1) return
		touchStartX = event.touches[0].clientX
		touchStartY = event.touches[0].clientY
		isDragging = true
		swipeHandled = false
	}
	/**
	 * 处理触摸移动事件。
	 * @param {TouchEvent} event - 触摸事件对象。
	 */
	const handleTouchMove = event => {
		if (!isDragging || event.touches.length !== 1) return
		const deltaX = event.touches[0].clientX - touchStartX
		const deltaY = event.touches[0].clientY - touchStartY
		if (Math.abs(deltaY) > Math.abs(deltaX)) isDragging = false // 垂直滚动优先
	}
	/**
	 * 处理触摸结束事件。
	 * @param {TouchEvent} event - 触摸事件对象。
	 */
	const handleTouchEnd = async event => {
		if (!isDragging || swipeHandled || event.changedTouches.length !== 1) { isDragging = false; return }
		const deltaX = event.changedTouches[0].clientX - touchStartX
		const deltaY = event.changedTouches[0].clientY - touchStartY
		isDragging = false

		if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
			const targetElement = event.target
			if (checkForHorizontalScrollbar(targetElement)) return // 忽略带水平滚动的元素

			swipeHandled = true
			const direction = deltaX > 0 ? -1 : 1 // 右滑-1(后退), 左滑+1(前进)
			await modifyTimeLine(direction)
		}
	}
	/**
	 * 处理触摸取消事件。
	 */
	const handleTouchCancel = () => { isDragging = false }
	/**
	 * 检查元素是否包含水平滚动条。
	 * @param {HTMLElement} element - 要检查的 DOM 元素。
	 * @returns {boolean} 如果元素包含水平滚动条则为 true，否则为 false。
	 */
	function checkForHorizontalScrollbar(element) {
		if (!element || !element.scrollWidth || !element.clientWidth) return false
		if (element.scrollWidth > element.clientWidth) return true
		for (let i = 0; i < element.children.length; i++)
			if (checkForHorizontalScrollbar(element.children[i])) return true

		return false
	}
	// --- 监听器定义结束 ---

	const listeners = { touchstart: handleTouchStart, touchmove: handleTouchMove, touchend: handleTouchEnd, touchcancel: handleTouchCancel }
	swipeListenersMap.set(messageElement, listeners) // 存储监听器引用

	// 添加事件监听
	messageElement.addEventListener('touchstart', listeners.touchstart, { passive: true })
	messageElement.addEventListener('touchmove', listeners.touchmove, { passive: true })
	messageElement.addEventListener('touchend', listeners.touchend, { passive: true })
	messageElement.addEventListener('touchcancel', listeners.touchcancel, { passive: true })
}

/**
 * 从消息元素移除左右滑动功能。
 * @param {HTMLElement} messageElement - 需要禁用滑动的消息 DOM 元素。
 */
export function disableSwipe(messageElement) {
	const listeners = swipeListenersMap.get(messageElement)
	if (!listeners) return
	// 移除事件监听
	messageElement.removeEventListener('touchstart', listeners.touchstart)
	messageElement.removeEventListener('touchmove', listeners.touchmove)
	messageElement.removeEventListener('touchend', listeners.touchend)
	messageElement.removeEventListener('touchcancel', listeners.touchcancel)
	swipeListenersMap.delete(messageElement) // 清除引用
}

/**
 * beilu-chat 悬浮球模块
 *
 * 功能：
 * 1. 可拖动琥珀色悬浮球（✦）
 * 2. 点击弹出上传面板（拖入/选择/粘贴图片+文字）
 * 3. 截图功能（框选截图 + 整页截图，使用 html2canvas）
 * 4. 通过 chat shell 的 addUserReply 发送给 AI
 *
 * 参考：贝露互动脚本.js 模块18 imageUploadModule
 */

import { addUserReply } from './endpoints.mjs'

// ============================================================
// html2canvas 动态加载
// ============================================================

let html2canvasLoaded = false
let html2canvasModule = null

async function ensureHtml2Canvas() {
	if (html2canvasLoaded) return html2canvasModule
	try {
		const script = document.createElement('script')
		script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
		await new Promise((resolve, reject) => {
			script.onload = resolve
			script.onerror = reject
			document.head.appendChild(script)
		})
		html2canvasModule = window.html2canvas
		html2canvasLoaded = true
		return html2canvasModule
	} catch (e) {
		console.warn('[floatingOrb] html2canvas 加载失败:', e)
		return null
	}
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
	const d = document.createElement('div')
	d.textContent = str
	return d.innerHTML
}

/**
 * 将 ArrayBuffer 转为 base64
 */
function arrayBufferToBase64(buffer) {
	let binary = ''
	const bytes = new Uint8Array(buffer)
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

/**
 * 将 data URL 转为 { mime_type, buffer(base64) }
 */
function dataUrlToFileData(dataUrl) {
	const [header, data] = dataUrl.split(',')
	const mime = header.match(/data:(.*?);/)?.[1] || 'image/jpeg'
	return { mime_type: mime, buffer: data }
}

/**
 * canvas 转 base64 data URL（限制尺寸 + 压缩）
 */
function canvasToDataUrl(canvas, maxWidth = 1600) {
	if (canvas.width > maxWidth) {
		const ratio = maxWidth / canvas.width
		const resized = document.createElement('canvas')
		resized.width = maxWidth
		resized.height = Math.round(canvas.height * ratio)
		const ctx = resized.getContext('2d')
		ctx.drawImage(canvas, 0, 0, resized.width, resized.height)
		canvas = resized
	}
	let dataUrl = canvas.toDataURL('image/jpeg', 0.75)
	// 超过 4MB 降质
	if (dataUrl.length > 4 * 1024 * 1024) {
		dataUrl = canvas.toDataURL('image/jpeg', 0.4)
	}
	if (dataUrl.length > 4 * 1024 * 1024) {
		console.warn('[floatingOrb] 截图超过 4MB')
		return null
	}
	return dataUrl
}

/**
 * 简易 Toast
 */
function showOrbToast(msg, duration = 3000) {
	let toast = document.getElementById('orb-toast')
	if (!toast) {
		toast = document.createElement('div')
		toast.id = 'orb-toast'
		toast.className = 'orb-toast'
		document.body.appendChild(toast)
	}
	toast.textContent = msg
	toast.classList.add('orb-toast-visible')
	clearTimeout(toast._timer)
	toast._timer = setTimeout(() => toast.classList.remove('orb-toast-visible'), duration)
}

/**
	* 设置悬浮球发送状态（旋转图标 + 禁用）
	*/
function setOrbSending(isSending) {
	if (!orbElement) return
	if (isSending) {
		orbElement.classList.add('orb-sending')
		orbElement.textContent = '⟳'
	} else {
		orbElement.classList.remove('orb-sending')
		orbElement.textContent = '✦'
	}
}

// ============================================================
// iframe 临时移除/恢复（html2canvas 兼容）
// ============================================================

/**
 * 临时从 DOM 中移除所有 iframe/object/embed 元素
 * html2canvas 在克隆 DOM 时会尝试访问 iframe.contentDocument，
 * 对跨域或动态 iframe 会抛出 "Unable to find element in cloned iframe"。
 * 物理移除是最可靠的规避方式。
 * @returns {Function} 调用后恢复所有被移除的元素
 */
function removeIframesTemporarily() {
	const removed = []
	document.querySelectorAll('iframe, object, embed').forEach(el => {
		const parent = el.parentNode
		const next = el.nextSibling
		if (parent) {
			parent.removeChild(el)
			removed.push({ el, parent, next })
		}
	})
	return function restoreIframes() {
		removed.forEach(({ el, parent, next }) => {
			try {
				if (parent) parent.insertBefore(el, next)
			} catch { /* 父节点可能已被移除 */ }
		})
	}
}

// ============================================================
// 状态
// ============================================================

/** @type {HTMLElement|null} */
let orbElement = null
/** @type {HTMLElement|null} */
let panelOverlay = null
/** @type {{ type: 'image'|'text', data: string, name: string }|null} */
let pendingFile = null

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
const TEXT_EXTENSIONS = ['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.mjs']

// ============================================================
// 悬浮球
// ============================================================

function createOrb() {
	if (orbElement) return

	const orb = document.createElement('div')
	orb.id = 'beilu-floating-orb'
	orb.className = 'floating-orb'
	orb.textContent = '✦'
	orb.title = '截图/上传给 AI'

	// 读取保存的位置
	const pos = getSavedPosition()
	orb.style.right = pos.right + 'px'
	orb.style.bottom = pos.bottom + 'px'

	// 拖拽
	let isDragging = false
	let hasMoved = false
	let dragStartTime = 0
	let offsetX = 0, offsetY = 0

	orb.addEventListener('mousedown', (e) => {
		if (e.button !== 0) return
		e.preventDefault()
		isDragging = true
		hasMoved = false
		dragStartTime = Date.now()
		const rect = orb.getBoundingClientRect()
		offsetX = e.clientX - rect.left
		offsetY = e.clientY - rect.top
		orb.style.transition = 'none'
	})

	document.addEventListener('mousemove', (e) => {
		if (!isDragging) return
		hasMoved = true
		orb.style.left = (e.clientX - offsetX) + 'px'
		orb.style.top = (e.clientY - offsetY) + 'px'
		orb.style.right = 'auto'
		orb.style.bottom = 'auto'
	})

	document.addEventListener('mouseup', () => {
		if (!isDragging) return
		isDragging = false
		orb.style.transition = ''

		const elapsed = Date.now() - dragStartTime
		if (!hasMoved || elapsed < 200) {
			// 短按 = 点击 → 显示菜单
			showCaptureMenu()
		} else {
			// 拖拽结束 → 保存位置
			const rect = orb.getBoundingClientRect()
			const right = Math.max(0, window.innerWidth - rect.right)
			const bottom = Math.max(0, window.innerHeight - rect.bottom)
			savePosition(right, bottom)
			orb.style.right = right + 'px'
			orb.style.bottom = bottom + 'px'
			orb.style.left = 'auto'
			orb.style.top = 'auto'
		}
	})

	// 触摸支持
	orb.addEventListener('touchstart', (e) => {
		const touch = e.touches[0]
		isDragging = true
		hasMoved = false
		dragStartTime = Date.now()
		const rect = orb.getBoundingClientRect()
		offsetX = touch.clientX - rect.left
		offsetY = touch.clientY - rect.top
		orb.style.transition = 'none'
	}, { passive: true })

	document.addEventListener('touchmove', (e) => {
		if (!isDragging) return
		hasMoved = true
		const touch = e.touches[0]
		orb.style.left = (touch.clientX - offsetX) + 'px'
		orb.style.top = (touch.clientY - offsetY) + 'px'
		orb.style.right = 'auto'
		orb.style.bottom = 'auto'
	}, { passive: true })

	document.addEventListener('touchend', () => {
		if (!isDragging) return
		isDragging = false
		orb.style.transition = ''

		const elapsed = Date.now() - dragStartTime
		if (!hasMoved || elapsed < 200) {
			showCaptureMenu()
		} else {
			const rect = orb.getBoundingClientRect()
			const right = Math.max(0, window.innerWidth - rect.right)
			const bottom = Math.max(0, window.innerHeight - rect.bottom)
			savePosition(right, bottom)
			orb.style.right = right + 'px'
			orb.style.bottom = bottom + 'px'
			orb.style.left = 'auto'
			orb.style.top = 'auto'
		}
	})

	document.body.appendChild(orb)
	orbElement = orb
}

function getSavedPosition() {
	try {
		const s = localStorage.getItem('beilu-orb-position')
		if (s) return JSON.parse(s)
	} catch { /* ignore */ }
	return { right: 20, bottom: 80 }
}

function savePosition(right, bottom) {
	try {
		localStorage.setItem('beilu-orb-position', JSON.stringify({ right, bottom }))
	} catch { /* ignore */ }
}

// ============================================================
// 全局粘贴监听（Win+Shift+S 截图 → Ctrl+V 自动弹出上传面板）
// ============================================================

/**
 * 全局粘贴：在任何位置 Ctrl+V 粘贴图片时，自动弹出上传面板
 * 只拦截图片类型的粘贴，文本粘贴不受影响
 */
function handleGlobalPaste(e) {
	// 如果上传面板已打开，面板内有自己的粘贴处理器
	if (panelOverlay) return

	const items = e.clipboardData?.items
	if (!items) return

	// 只处理剪贴板中的图片（不影响文本粘贴）
	for (let i = 0; i < items.length; i++) {
		if (items[i].type.startsWith('image/')) {
			e.preventDefault()
			e.stopPropagation()
			const file = items[i].getAsFile()
			if (file) handleClipboardImage(file)
			return
		}
	}
}

/**
 * 处理剪贴板图片：重编码 → 设为 pendingFile → 弹出上传面板
 */
function handleClipboardImage(file) {
	const reader = new FileReader()
	reader.onload = (ev) => {
		const img = new Image()
		img.onload = () => {
			const canvas = document.createElement('canvas')
			const MAX_DIM = 1600
			let w = img.width, h = img.height
			if (w > MAX_DIM || h > MAX_DIM) {
				const ratio = Math.min(MAX_DIM / w, MAX_DIM / h)
				w = Math.round(w * ratio)
				h = Math.round(h * ratio)
			}
			canvas.width = w
			canvas.height = h
			const ctx = canvas.getContext('2d')
			ctx.fillStyle = '#ffffff'
			ctx.fillRect(0, 0, w, h)
			ctx.drawImage(img, 0, 0, w, h)
			let dataUrl = canvas.toDataURL('image/jpeg', 0.85)
			if (dataUrl.length > 4 * 1024 * 1024) {
				dataUrl = canvas.toDataURL('image/jpeg', 0.5)
			}
			if (dataUrl.length > 4 * 1024 * 1024) {
				showOrbToast('图片太大，无法处理')
				return
			}
			const fileData = dataUrlToFileData(dataUrl)
			pendingFile = {
				type: 'image',
				data: fileData.buffer,
				mime: fileData.mime_type,
				name: `clipboard_${Date.now()}.jpg`,
			}
			showOrbToast('已捕获剪贴板截图 ✦')
			openUploadPanel()
		}
		img.onerror = () => showOrbToast('图片加载失败')
		img.src = ev.target.result
	}
	reader.readAsDataURL(file)
}

// ============================================================
// 截图模式选择菜单（在悬浮球上方弹出）
// ============================================================

function showCaptureMenu() {
	// 移除已有菜单
	const existing = document.getElementById('orb-capture-menu')
	if (existing) { existing.remove(); return }

	const menu = document.createElement('div')
	menu.id = 'orb-capture-menu'
	menu.className = 'orb-capture-menu'

	const items = [
		{ icon: '✂', label: '框选截图', action: () => { closeMenu(); startCropMode() } },
		{ icon: '📄', label: '整页截图', action: () => { closeMenu(); handleFullPageCapture() } },
		{ icon: '📁', label: '上传文件', action: () => { closeMenu(); openUploadPanel() } },
	]

	items.forEach(({ icon, label, action }) => {
		const item = document.createElement('div')
		item.className = 'orb-menu-item'
		item.innerHTML = `<span class="orb-menu-icon">${icon}</span><span>${label}</span>`
		item.addEventListener('click', action)
		menu.appendChild(item)
	})

	document.body.appendChild(menu)

	// 定位在悬浮球上方
	if (orbElement) {
		const rect = orbElement.getBoundingClientRect()
		menu.style.right = (window.innerWidth - rect.right) + 'px'
		menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px'
	}

	requestAnimationFrame(() => menu.classList.add('orb-menu-visible'))

	// 点击外部关闭
	function onClickOutside(e) {
		if (!menu.contains(e.target) && e.target !== orbElement) {
			closeMenu()
		}
	}
	setTimeout(() => document.addEventListener('click', onClickOutside, true), 0)

	function closeMenu() {
		document.removeEventListener('click', onClickOutside, true)
		menu.classList.remove('orb-menu-visible')
		setTimeout(() => { if (menu.parentNode) menu.remove() }, 200)
	}
}

// ============================================================
// 框选截图
// ============================================================

function startCropMode() {
	const existing = document.getElementById('orb-crop-overlay')
	if (existing) existing.remove()

	const overlay = document.createElement('div')
	overlay.id = 'orb-crop-overlay'
	overlay.className = 'orb-crop-overlay'

	const hint = document.createElement('div')
	hint.className = 'orb-crop-hint'
	hint.textContent = '拖拽选择截图区域 · 按 Esc 取消'
	overlay.appendChild(hint)

	const selection = document.createElement('div')
	selection.className = 'orb-crop-selection'
	selection.style.display = 'none'
	overlay.appendChild(selection)

	const sizeLabel = document.createElement('div')
	sizeLabel.className = 'orb-crop-size'
	sizeLabel.style.display = 'none'
	overlay.appendChild(sizeLabel)

	document.body.appendChild(overlay)

	let startX = 0, startY = 0, isDragging = false, hasMoved = false

	overlay.addEventListener('mousedown', (e) => {
		if (e.button !== 0) return
		e.preventDefault()
		startX = e.clientX
		startY = e.clientY
		isDragging = true
		hasMoved = false
		selection.style.display = 'block'
		selection.style.left = startX + 'px'
		selection.style.top = startY + 'px'
		selection.style.width = '0'
		selection.style.height = '0'
		sizeLabel.style.display = 'none'
	})

	overlay.addEventListener('mousemove', (e) => {
		if (!isDragging) return
		e.preventDefault()
		hasMoved = true
		const curX = e.clientX, curY = e.clientY
		const left = Math.min(startX, curX)
		const top = Math.min(startY, curY)
		const w = Math.abs(curX - startX)
		const h = Math.abs(curY - startY)
		selection.style.left = left + 'px'
		selection.style.top = top + 'px'
		selection.style.width = w + 'px'
		selection.style.height = h + 'px'
		sizeLabel.textContent = w + ' × ' + h
		sizeLabel.style.display = 'block'
		sizeLabel.style.left = (left + w + 5) + 'px'
		sizeLabel.style.top = (top + h + 5) + 'px'
	})

	overlay.addEventListener('mouseup', (e) => {
		if (!isDragging) return
		isDragging = false
		if (!hasMoved) { cleanupCrop(); return }

		const curX = e.clientX, curY = e.clientY
		const left = Math.min(startX, curX)
		const top = Math.min(startY, curY)
		const w = Math.abs(curX - startX)
		const h = Math.abs(curY - startY)

		if (w < 20 || h < 20) {
			showOrbToast('选区太小，请重新框选')
			cleanupCrop()
			return
		}
		cleanupCrop()
		handleCropCapture({ x: left + window.scrollX, y: top + window.scrollY, width: w, height: h })
	})

	function onKeyDown(e) {
		if (e.key === 'Escape') cleanupCrop()
	}
	document.addEventListener('keydown', onKeyDown)

	overlay.addEventListener('contextmenu', (e) => {
		e.preventDefault()
		cleanupCrop()
	})

	function cleanupCrop() {
		document.removeEventListener('keydown', onKeyDown)
		if (overlay.parentNode) overlay.remove()
	}
}

async function handleCropCapture(cropRect) {
	setOrbSending(true)
	showOrbToast('正在截取选区...')
	const h2c = await ensureHtml2Canvas()
	if (!h2c) {
		setOrbSending(false)
		showOrbToast('截图库加载失败')
		return
	}
	const restoreIframes = removeIframesTemporarily()
	try {
		const canvas = await h2c(document.body, {
			scale: 1,
			x: cropRect.x,
			y: cropRect.y,
			width: cropRect.width,
			height: cropRect.height,
			windowWidth: document.body.scrollWidth,
			logging: false,
			useCORS: true,
			allowTaint: true,
			foreignObjectRendering: false,
			ignoreElements: (el) => {
				if (el.id?.startsWith('beilu-floating') || el.id?.startsWith('orb-')) return true
				try {
					const s = window.getComputedStyle(el)
					if (s.backgroundColor?.includes('oklch') || s.color?.includes('oklch')) return true
				} catch { /* ignore */ }
				return false
			},
		})
		const dataUrl = canvasToDataUrl(canvas)
		setOrbSending(false)
		if (dataUrl) {
			proceedWithScreenshot(dataUrl, '框选截图')
		} else {
			showOrbToast('截图失败（图片太大）')
		}
	} catch (err) {
		setOrbSending(false)
		console.error('[floatingOrb] 框选截图失败:', err)
		showOrbToast('截图失败')
	} finally {
		restoreIframes()
	}
}

// ============================================================
// 整页截图
// ============================================================

async function handleFullPageCapture() {
	setOrbSending(true)
	showOrbToast('正在捕获整页...')
	const h2c = await ensureHtml2Canvas()
	if (!h2c) {
		setOrbSending(false)
		showOrbToast('截图库加载失败')
		return
	}
	const restoreIframes = removeIframesTemporarily()
	try {
		const canvas = await h2c(document.body, {
			scale: 0.8,
			windowWidth: Math.min(document.body.scrollWidth, 1920),
			height: Math.min(document.documentElement.scrollHeight, 5000),
			logging: false,
			useCORS: true,
			allowTaint: true,
			foreignObjectRendering: false,
			ignoreElements: (el) => {
				if (el.id?.startsWith('beilu-floating') || el.id?.startsWith('orb-')) return true
				try {
					const s = window.getComputedStyle(el)
					if (s.backgroundColor?.includes('oklch') || s.color?.includes('oklch')) return true
				} catch { /* ignore */ }
				return false
			},
		})
		const dataUrl = canvasToDataUrl(canvas)
		setOrbSending(false)
		if (dataUrl) {
			proceedWithScreenshot(dataUrl, '整页截图')
		} else {
			showOrbToast('截图失败（图片太大）')
		}
	} catch (err) {
		setOrbSending(false)
		console.error('[floatingOrb] 整页截图失败:', err)
		showOrbToast('截图失败')
	} finally {
		restoreIframes()
	}
}

/**
 * 截图完成后 → 打开上传面板（预填截图）
 */
function proceedWithScreenshot(dataUrl, label) {
	const fileData = dataUrlToFileData(dataUrl)
	pendingFile = {
		type: 'image',
		data: fileData.buffer,    // base64
		mime: fileData.mime_type,
		name: `${label}_${Date.now()}.jpg`,
	}
	openUploadPanel()
}

// ============================================================
// 上传面板
// ============================================================

function openUploadPanel() {
	if (panelOverlay) return

	const overlay = document.createElement('div')
	overlay.id = 'orb-upload-overlay'
	overlay.className = 'orb-upload-overlay'

	const panel = document.createElement('div')
	panel.className = 'orb-upload-panel'

	// 标题
	const title = document.createElement('h3')
	title.className = 'orb-panel-title'
	title.textContent = '✦ 分享给 AI'
	panel.appendChild(title)

	// 提示
	const hint = document.createElement('p')
	hint.className = 'orb-panel-hint'
	hint.textContent = pendingFile
		? (pendingFile.type === 'image'
			? '已截图。输入文字发送，或点击"仅分享"直接发送。'
			: '已选择文件。输入文字描述后发送。')
		: '拖入文件、点击选择，或粘贴图片'
	panel.appendChild(hint)

	// 截图/文件信息区
	if (pendingFile) {
		const infoArea = document.createElement('div')
		infoArea.className = 'orb-info-area'
		infoArea.textContent = pendingFile.type === 'image'
			? `📷 ${pendingFile.name}`
			: `📄 ${pendingFile.name}`
		panel.appendChild(infoArea)
	}

	// 拖拽区域
	const dropZone = document.createElement('div')
	dropZone.className = 'orb-dropzone'

	const dropIcon = document.createElement('div')
	dropIcon.className = 'orb-drop-icon'
	dropIcon.textContent = pendingFile ? (pendingFile.type === 'image' ? '🖼️' : '📄') : '📁'
	dropZone.appendChild(dropIcon)

	const dropText = document.createElement('div')
	dropText.className = 'orb-drop-text'
	dropText.textContent = pendingFile ? `已选择: ${pendingFile.name}` : '拖入文件或点击选择'
	dropZone.appendChild(dropText)

	// 图片预览
	const preview = document.createElement('div')
	preview.className = 'orb-preview'
	if (pendingFile?.type === 'image') {
		const img = document.createElement('img')
		img.src = `data:${pendingFile.mime};base64,${pendingFile.data}`
		img.className = 'orb-preview-img'
		preview.appendChild(img)
		preview.style.display = 'block'
	}
	dropZone.appendChild(preview)

	// 隐藏 file input
	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = 'image/*,.txt,.md,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.mjs'
	fileInput.style.display = 'none'
	panel.appendChild(fileInput)

	dropZone.addEventListener('click', () => fileInput.click())

	fileInput.addEventListener('change', () => {
		if (fileInput.files?.[0]) {
			handleOrbFileSelected(fileInput.files[0], dropIcon, dropText, preview)
		}
	})

	// 拖拽事件
	dropZone.addEventListener('dragover', (e) => {
		e.preventDefault(); e.stopPropagation()
		dropZone.classList.add('orb-dropzone-active')
	})
	dropZone.addEventListener('dragleave', (e) => {
		e.preventDefault(); e.stopPropagation()
		dropZone.classList.remove('orb-dropzone-active')
	})
	dropZone.addEventListener('drop', (e) => {
		e.preventDefault(); e.stopPropagation()
		dropZone.classList.remove('orb-dropzone-active')
		if (e.dataTransfer.files?.[0]) {
			handleOrbFileSelected(e.dataTransfer.files[0], dropIcon, dropText, preview)
		}
	})

	// 粘贴监听
	overlay.addEventListener('paste', (e) => {
		const items = e.clipboardData?.items
		if (!items) return
		for (let i = 0; i < items.length; i++) {
			if (items[i].type.indexOf('image') !== -1) {
				e.preventDefault()
				const file = items[i].getAsFile()
				if (file) handleOrbFileSelected(file, dropIcon, dropText, preview)
				break
			}
		}
	})
	overlay.setAttribute('tabindex', '-1')

	panel.appendChild(dropZone)

	// 文本输入
	const textarea = document.createElement('textarea')
	textarea.className = 'orb-textarea'
	textarea.placeholder = '想对 AI 说什么？（附带文件一起发送）'
	panel.appendChild(textarea)

	// 按钮行（三按钮：取消 / 仅分享 / 发送）
	const btnRow = document.createElement('div')
	btnRow.className = 'orb-btn-row'

	const cancelBtn = createPanelBtn('取消', 'orb-btn-cancel')
	cancelBtn.addEventListener('click', () => closeUploadPanel())

	const passiveBtn = createPanelBtn('仅分享', 'orb-btn-secondary')
	passiveBtn.addEventListener('click', () => handleOrbSubmit('', 'passive'))

	const sendBtn = createPanelBtn('发送 ✦', 'orb-btn-primary')
	sendBtn.addEventListener('click', () => {
		const userMessage = textarea.value.trim()
		if (!userMessage) {
			// 没有输入时，提示用户使用"仅分享"
			textarea.style.borderColor = '#e74c3c'
			textarea.setAttribute('placeholder', '请输入要对 AI 说的话，\n或者点击"仅分享"')
			setTimeout(() => { textarea.style.borderColor = '' }, 2000)
			return
		}
		handleOrbSubmit(userMessage, 'active')
	})

	// Enter 发送（Shift+Enter 换行）
	textarea.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			sendBtn.click()
		}
	})

	btnRow.appendChild(cancelBtn)
	btnRow.appendChild(passiveBtn)
	btnRow.appendChild(sendBtn)
	panel.appendChild(btnRow)

	// 点击遮罩关闭
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) closeUploadPanel()
	})

	overlay.appendChild(panel)
	document.body.appendChild(overlay)
	panelOverlay = overlay

	requestAnimationFrame(() => {
		overlay.classList.add('orb-overlay-visible')
		overlay.focus()
		textarea.focus()
	})
}

function createPanelBtn(text, className) {
	const btn = document.createElement('button')
	btn.textContent = text
	btn.className = `orb-btn ${className}`
	return btn
}

function closeUploadPanel() {
	if (!panelOverlay) return
	const el = panelOverlay
	panelOverlay = null
	pendingFile = null
	el.classList.remove('orb-overlay-visible')
	setTimeout(() => { if (el.parentNode) el.remove() }, 300)
}

// ============================================================
// 文件处理
// ============================================================

function handleOrbFileSelected(file, dropIcon, dropText, previewContainer) {
	const fileName = file.name || 'unknown'
	const ext = '.' + fileName.split('.').pop().toLowerCase()

	if (IMAGE_EXTENSIONS.includes(ext) || file.type.indexOf('image') !== -1) {
		// 图片 → canvas 重编码为 JPEG
		const reader = new FileReader()
		reader.onload = (e) => {
			const img = new Image()
			img.onload = () => {
				const canvas = document.createElement('canvas')
				const MAX_DIM = 1600
				let w = img.width, h = img.height
				if (w > MAX_DIM || h > MAX_DIM) {
					const ratio = Math.min(MAX_DIM / w, MAX_DIM / h)
					w = Math.round(w * ratio)
					h = Math.round(h * ratio)
				}
				canvas.width = w
				canvas.height = h
				const ctx = canvas.getContext('2d')
				ctx.fillStyle = '#ffffff'
				ctx.fillRect(0, 0, w, h)
				ctx.drawImage(img, 0, 0, w, h)
				let dataUrl = canvas.toDataURL('image/jpeg', 0.85)
				if (dataUrl.length > 4 * 1024 * 1024) {
					dataUrl = canvas.toDataURL('image/jpeg', 0.5)
				}
				if (dataUrl.length > 4 * 1024 * 1024) {
					showOrbToast('图片太大，无法处理')
					return
				}
				const fileData = dataUrlToFileData(dataUrl)
				pendingFile = {
					type: 'image',
					data: fileData.buffer,
					mime: fileData.mime_type,
					name: fileName,
				}
				dropIcon.textContent = '🖼️'
				dropText.textContent = `已选择: ${fileName}`
				// 显示预览
				previewContainer.innerHTML = ''
				const prevImg = document.createElement('img')
				prevImg.src = dataUrl
				prevImg.className = 'orb-preview-img'
				previewContainer.appendChild(prevImg)
				previewContainer.style.display = 'block'
			}
			img.onerror = () => showOrbToast('图片加载失败')
			img.src = e.target.result
		}
		reader.readAsDataURL(file)

	} else if (TEXT_EXTENSIONS.includes(ext)) {
		// 文本文件
		const reader = new FileReader()
		reader.onload = (e) => {
			let content = e.target.result
			if (content.length > 5000) {
				content = content.substring(0, 5000) + '\n... (截断，原文 ' + e.target.result.length + ' 字符)'
			}
			pendingFile = {
				type: 'text',
				data: content,
				name: fileName,
			}
			dropIcon.textContent = '📄'
			dropText.textContent = `已选择: ${fileName} (${Math.round(file.size / 1024)}KB)`
			previewContainer.innerHTML = ''
			previewContainer.style.display = 'none'
		}
		reader.readAsText(file, 'UTF-8')
	} else {
		showOrbToast('不支持的文件类型: ' + ext)
	}
}

// ============================================================
// 提交（通过 chat shell 的 addUserReply 发送）
// ============================================================

async function handleOrbSubmit(userMessage, mode = 'active') {
	if (!pendingFile && !userMessage) {
		showOrbToast('请选择文件或输入文字')
		return
	}

	closeUploadPanel()
	setOrbSending(true)

	try {
		const files = []
		let messageText = userMessage || ''

		if (pendingFile) {
			if (pendingFile.type === 'image') {
				// 图片 → 作为附件发送
				files.push({
					name: pendingFile.name,
					mime_type: pendingFile.mime,
					buffer: pendingFile.data,  // base64
					description: userMessage || '',
				})
				// passive 模式：无文字时用默认标记
				if (!messageText) messageText = '[图片]'
			} else if (pendingFile.type === 'text') {
				// 文本文件 → 内容拼入消息
				messageText = userMessage
					? `${userMessage}\n\n[文件: ${pendingFile.name}]\n${pendingFile.data}`
					: `[文件: ${pendingFile.name}]\n${pendingFile.data}`
			}
		}

		showOrbToast('正在发送...')
		await addUserReply({ content: messageText, files })

		// 根据模式显示不同的完成提示
		if (mode === 'passive') {
			showOrbToast('✦ 已分享给 AI')
		} else {
			showOrbToast('已发送 ✦ 等待 AI 回复...')
		}

	} catch (err) {
		console.error('[floatingOrb] 发送失败:', err)
		showOrbToast('发送失败: ' + (err.message || err))
	} finally {
		setOrbSending(false)
	}
}

// ============================================================
// 初始化导出
// ============================================================

/**
 * 显示悬浮球
 */
export function showOrb() {
	if (orbElement) orbElement.style.display = 'flex'
}

/**
 * 隐藏悬浮球
 */
export function hideOrb() {
	if (orbElement) orbElement.style.display = 'none'
	// 关闭可能打开的菜单/面板
	const menu = document.getElementById('orb-capture-menu')
	if (menu) menu.remove()
	closeUploadPanel()
}

/**
 * 初始化悬浮球模块
 */
export function initFloatingOrb() {
	createOrb()

	// 全局粘贴监听（Ctrl+V 粘贴图片 → 自动弹出上传面板）
	document.addEventListener('paste', handleGlobalPaste)

	// 从 localStorage 读取开关状态
	const saved = localStorage.getItem('beilu-orb-enabled')
	if (saved === 'false') hideOrb()

	console.log('[floatingOrb] 悬浮球已初始化（全局粘贴已启用）')
}
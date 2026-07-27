import { svgInliner } from '../../../../../../scripts/svgInliner.mjs' // 6c尾·根级散件归位
import { renderTemplate } from '../../../../../../scripts/template.mjs' // 6c尾·根级散件归位

import { getfile } from '../transport/files.mjs' // 6c尾·根级散件归位
import { openModal } from '../widgets/modal.mjs' // 6c尾·根级散件归位
import { processTimeStampForId, arrayBufferToBase64, downloadUrl } from '../state/utils.mjs' // 6c尾·根级散件归位；0716 下载基元收口

// U05（T049）附件大小上限：附件以 base64 塞进消息 POST body 全程驻内存，
//   base64 编码使体积膨胀 ~33%，超大文件 readAsArrayBuffer 会数秒卡死甚至 OOM 崩标签页。
//   25MB 为聊天附件常见上限（对齐 Discord 免费档心智），超限即时提示、不入内存不读取。
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** 字节数 → 人类可读（用于超限提示，与 beilu-files/main.mjs:407 humanSize 语义一致）。 */
function _humanSize(bytes) {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * 处理文件选择。
 * @param {Event} event - 事件。
 * @param {Array<object>} selectedFiles - 已选择的文件。
 * @param {HTMLElement} attachmentPreviewContainer - 附件预览容器。
 * @returns {Promise<void>}
 */
export async function handleFilesSelect(event, selectedFiles, attachmentPreviewContainer) {
	const files = event.target.files || event.dataTransfer.files
	if (!files) return

	for (const file of files) {
		// U05：超限文件即时提示并跳过——不 new FileReader、不 readAsArrayBuffer，杜绝超大文件驻内存 OOM。
		if (file.size > MAX_ATTACHMENT_BYTES) {
			window._beiluToast?.(
				`附件「${file.name}」${_humanSize(file.size)} 超过上限 ${_humanSize(MAX_ATTACHMENT_BYTES)}，未添加`,
				'error'
			)
			continue
		}
		const reader = new FileReader()
		// U05：大文件读取进度——读取数秒时给可见反馈，避免用户以为没选上重复拖拽。
		//   进度条挂在附件预览区顶部，onload/onerror 结束时移除。仅对较大文件显示（小文件秒读无需）。
		let progressEl = null
		if (file.size > 512 * 1024 && attachmentPreviewContainer) {
			progressEl = document.createElement('div')
			progressEl.className = 'attachment-read-progress'
			progressEl.style.cssText = 'font-size:12px;color:var(--beilu-muted);padding:2px 6px;'
			progressEl.textContent = `读取「${file.name}」… 0%`
			attachmentPreviewContainer.appendChild(progressEl)
			reader.onprogress = ev => {
				if (progressEl && ev.lengthComputable) {
					const pct = Math.round((ev.loaded / ev.total) * 100)
					progressEl.textContent = `读取「${file.name}」… ${pct}%`
				}
			}
		}
		const _clearProgress = () => { if (progressEl) { progressEl.remove(); progressEl = null } }
		/**
		 * 文件读取完成后的回调。
		 * @param {ProgressEvent<FileReader>} e - 事件。
		 */
		reader.onload = async e => {
			_clearProgress()
			try {
				const newFile = {
					name: file.name,
					mime_type: file.type,
					buffer: arrayBufferToBase64(e.target.result),
					description: '',
				}
				selectedFiles.push(newFile)
				const attachmentElement = await renderAttachmentPreview(
					newFile,
					selectedFiles.length - 1,
					selectedFiles
				)
				if (attachmentElement && attachmentPreviewContainer) {
					attachmentElement.classList.add('attachment-entering')
					attachmentPreviewContainer.appendChild(attachmentElement)
					requestAnimationFrame(() => {
						attachmentElement.classList.remove('attachment-entering')
					})
				}
			} catch (err) {
				console.error('[fileHandling] reader.onload 处理失败:', err)
				window._beiluToast?.(`附件「${file.name}」处理失败`, 'error')
			}
		}
		// FileReader 读取失败兜底：原代码无 onerror，文件读不出时静默吞掉
		// （selectedFiles 不入、预览不出、无任何提示）→ 用户以为没选上。
		reader.onerror = () => {
			_clearProgress()
			console.error('[fileHandling] reader 读取失败:', file.name, reader.error)
			window._beiluToast?.(`附件「${file.name}」读取失败`, 'error')
		}
		reader.readAsArrayBuffer(file)
	}
}

/**
 * 处理粘贴事件，将剪贴板中的图片添加到附件列表。
 *
 * @param {ClipboardEvent} event - 粘贴事件对象。
 * @param {Array} selectedFiles - 已选择的文件数组，用于存储新添加的文件。
 * @param {HTMLElement} attachmentPreviewContainer - 附件预览区域的 DOM 元素，用于显示新添加的附件。
 */
export async function handlePaste(event, selectedFiles, attachmentPreviewContainer) {
	const { items } = event.clipboardData || window.clipboardData
	for (const item of items)
		if (!item.type.indexOf('image')) {
			const blob = item.getAsFile()
			if (blob) {
				// 为 blob 创建一个唯一的文件名，例如使用时间戳和随机数
				const fileName = `pasted-image-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`

				// 将 Blob 转换为 File 对象
				const file = new File([blob], fileName, { type: blob.type })

				// 创建一个假的 event 对象，模拟 file input 的 change 事件
				const fakeEvent = {
					target: {
						files: [file],
					},
				}
				// 使用 handleFilesSelect 函数处理图片文件
				await handleFilesSelect(fakeEvent, selectedFiles, attachmentPreviewContainer)
			}
		}
}

const PREVIEWABLE_MIME_TYPES = ['image/', 'video/', 'audio/']

/**
 * 渲染附件预览。
 * @param {object} file - 文件。
 * @param {number} index - 索引。
 * @param {Array<object>} selectedFiles - 已选择的文件。
 * @returns {Promise<HTMLElement>} - 附件元素。
 */
export async function renderAttachmentPreview(file, index, selectedFiles) {
	let attachmentElement = await renderTemplate('attachment_preview', {
		file,
		index,
		safeName: processTimeStampForId(file.name),
		showDownloadButton: !selectedFiles,
		showDeleteButton: selectedFiles,
	})

	const _mimeType = file.mime_type || file.type || ""
	const isPreviewable = PREVIEWABLE_MIME_TYPES.some(type => _mimeType.startsWith(type))

	if (file.buffer.startsWith('file:') && isPreviewable) {
		file = { ...file }
		file.buffer = arrayBufferToBase64(await getfile(`/api/parts/shells:chat/getfile?hash=${file.buffer.slice(5)}`))
	}

	const previewContainer = attachmentElement.querySelector('.preview-container')
	if (!previewContainer) return attachmentElement

	// 占位图标内联为 SVG data URI（零成本本地优先：避免外链 CDN，离线时占位本身也裂）。
	const _ICON_IMAGE_OFF = 'data:image/svg+xml,' + encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/><path d="M3 7v12a2 2 0 0 0 2 2h12"/><path d="M9 9l-3 4 2 2"/></svg>'
	)
	const _ICON_FILE = 'data:image/svg+xml,' + encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
	)
	// 媒体加载失败兜底：buffer 为空（如 getfile 失败返回空 ArrayBuffer → 空 base64）
	// 或数据损坏时，原生 img/video/audio 会静默破图/无反馈。替换为可见的「加载失败」占位图标。
	const _renderBrokenMedia = label => {
		const broken = document.createElement('img')
		broken.classList.add('preview', 'icon', 'media-load-failed')
		broken.src = _ICON_IMAGE_OFF
		broken.alt = `${label}加载失败: ${file.name}`
		broken.title = broken.alt
		broken.width = broken.height = 40
		previewContainer.appendChild(broken)
	}
	const _hasBuffer = typeof file.buffer === 'string' && file.buffer.length > 0 && !file.buffer.startsWith('file:')

	if (_mimeType.startsWith('image/')) {
		if (!_hasBuffer) {
			_renderBrokenMedia('图片')
		} else {
			const previewImg = document.createElement('img')
			previewImg.classList.add('preview-img')
			const base64Data = `data:${_mimeType};base64,${file.buffer}`
			previewImg.alt = file.name
			previewImg.addEventListener('error', () => {
				if (!previewImg.dataset.broken) {
					previewImg.dataset.broken = '1'
					previewImg.remove()
					_renderBrokenMedia('图片')
				}
			})
			previewImg.src = base64Data
			previewImg.addEventListener('click', () => {
				openModal(base64Data, 'image')
			})
			previewContainer.appendChild(previewImg)
		}
	}
	else if (_mimeType.startsWith('video/')) {
		if (!_hasBuffer) {
			_renderBrokenMedia('视频')
		} else {
			const preview = document.createElement('video')
			preview.classList.add('preview')
			const videoSrc = `data:${_mimeType};base64,${file.buffer}`
			preview.controls = true
			preview.autoplay = false
			preview.addEventListener('error', () => {
				if (!preview.dataset.broken) {
					preview.dataset.broken = '1'
					preview.remove()
					_renderBrokenMedia('视频')
				}
			})
			preview.src = videoSrc
			preview.addEventListener('click', () => {
				openModal(videoSrc, 'video')
			})
			previewContainer.appendChild(preview)
		}
	}
	else if (_mimeType.startsWith('audio/')) {
		if (!_hasBuffer) {
			_renderBrokenMedia('音频')
		} else {
			const audio = document.createElement('audio')
			audio.controls = true
			audio.addEventListener('error', () => {
				if (!audio.dataset.broken) {
					audio.dataset.broken = '1'
					audio.remove()
					_renderBrokenMedia('音频')
				}
			})
			audio.src = `data:${_mimeType};base64,${file.buffer}`
			previewContainer.appendChild(audio)
		}
	}
	else {
		const preview = document.createElement('img')
		preview.classList.add('preview', 'icon')
		preview.src = _ICON_FILE
		preview.alt = file.name
		preview.width = preview.height = 40
		previewContainer.appendChild(preview)
	}
	attachmentElement = await svgInliner(attachmentElement)

	attachmentElement
		.querySelector('.download-button')
		?.addEventListener('click', () => downloadFile(file))
	attachmentElement
		.querySelector('.delete-button')
		?.addEventListener('click', () => {
			const itemIndex = selectedFiles.indexOf(file)
			if (itemIndex > -1)
				selectedFiles.splice(itemIndex, 1)

			attachmentElement.classList.add('attachment-removing')

			/**
			 * 移除元素的回退函数。
			 */
			const removeWithFallback = () => {
				if (attachmentElement.parentNode)
					attachmentElement.remove()
			}

			attachmentElement.addEventListener('transitionend', removeWithFallback, { once: true })
		})

	return attachmentElement
}

/**
 * 下载文件。
 * @param {object} file - 文件。
 */
export function downloadFile(file) {
	// 0716 轮子收口：触发下载步骤 → utils.downloadUrl 基元；本函数保留附件特化语义（hash/dataURL 分支）
	const _dlMime = file.mime_type || file.type || "application/octet-stream"
	const _href = file.buffer.startsWith('file:')
		? `/api/parts/shells:chat/getfile?hash=${file.buffer.slice(5)}`
		: `data:${_dlMime};base64,${file.buffer}`
	downloadUrl(_href, file.name)
}

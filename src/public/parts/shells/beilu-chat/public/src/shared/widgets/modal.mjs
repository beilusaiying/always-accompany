/**
 * modal.mjs — 媒体灯箱（图片/视频全屏预览弹窗）
 *
 * 功能链：
 *   调用方 openModal(src, type) → 动态创建 <div class="modal modal-open">
 *   → 按 type 注入 <img> 或 <video> → append body → 显示
 *   → 点击遮罩 / ESC → 视频 pause + DOM remove + _beiluEscRegistry 自清
 *
 * why：
 *   消息列表中的图片/视频需要全屏查看；原生无此机制；
 *   ESC 关闭走 window._beiluEscRegistry 中央仲裁（priority 30），与其它浮层统一 ESC 优先级；
 *   每次 openModal 创建新节点、关闭即移除，避免事件/状态残留（self-cleaning）。
 *
 * 关联链：
 *   ← messageList.mjs 或其它渲染消息中图片/视频点击处（调用 openModal）
 *   → window._beiluEscRegistry（ESC 中央仲裁注册）
 *   无后端请求，纯 DOM 操作。
 *
 * 影响范围：
 *   DOM：动态 append/remove body 下全屏 div；
 *   视频：关闭时强制 pause，防止后台静默播放；
 *   支持类型：image / video（其它类型 console.error 后直接 return，不打开弹窗）。
 *
 * 使用效果：
 *   openModal(url, "image") → 全屏显示图片，点击遮罩或按 ESC 关闭；
 *   openModal(url, "video") → 自动播放视频，关闭时暂停。
 */
export function openModal(contentSrc, contentType) {
	const modal = document.createElement('div')
	modal.classList.add('modal', 'modal-open')

	let modalContentElement

	if (contentType === 'image') {
		modalContentElement = document.createElement('img')
		modalContentElement.src = contentSrc
		modalContentElement.classList.add('modal-img')
	}
	else if (contentType === 'video') {
		modalContentElement = document.createElement('video')
		modalContentElement.src = contentSrc
		modalContentElement.controls = true
		modalContentElement.autoplay = true
		modalContentElement.classList.add('modal-video')
	}
	else {
		console.error('Unsupported content type for modal:', contentType)
		return // Don't open modal for unsupported types
	}

	modalContentElement.style.maxWidth = '90vw'
	modalContentElement.style.maxHeight = '90vh'
	modal.appendChild(modalContentElement)

	modal.addEventListener('click', e => {
		// Close only if the modal background (not the content itself) is clicked
		if (e.target === modal) {
			// If it's a video, pause it before removing the modal
			if (contentType === 'video' && modalContentElement)
				modalContentElement.pause()

			modal.remove()
		}
	})

	// T3修2: ESC 关闭走中央仲裁注册表（modal priority 30）。每次打开注册一项，关闭即自移除（self-cleaning）。
	const reg = (window._beiluEscRegistry = window._beiluEscRegistry || [])
	const _entry = {
		_id: "modal-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
		priority: 30,
		isOpen: () => modal.isConnected,
		close: () => {
			if (contentType === 'video' && modalContentElement) modalContentElement.pause()
			modal.remove()
			const i = reg.indexOf(_entry)
			if (i >= 0) reg.splice(i, 1)
		},
	}
	reg.push(_entry)
	// 点击遮罩关闭时也从注册表清理
	modal.addEventListener('click', (e) => {
		if (e.target === modal) { const i = reg.indexOf(_entry); if (i >= 0) reg.splice(i, 1) }
	})
	document.body.appendChild(modal)
}

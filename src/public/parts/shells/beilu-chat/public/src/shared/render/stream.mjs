/**
 * [stream.mjs] — 流式消息切片应用层。只处理切片类型分发，不管 DOM 渲染（那是 StreamRenderer.mjs 的事），
 *   不管 WS 连接（那是 websocket.mjs 的事），不管队列调度（那是 virtualQueue.mjs 的事）。
 *
 * 职责：
 *   applySlice(message, slice)：把后端 stream_update 推来的切片合并进消息对象，支持三种切片类型：
 *     - append：在 message.content 末尾追加新增内容，合并 files
 *     - rewrite_tail：从 slice.index 处截断，重写尾部（用于后端回退/纠错场景）
 *     - set_files：整体替换 message.files 附件列表
 *
 * 链路：websocket.mjs handleBroadcastEvent → virtualQueue.mjs handleStreamUpdate
 *       → applySlice(streamingMessages.get(id), slice) → 返回更新后的 message 对象
 *       → StreamRenderer.updateTarget(el, message.content) → DOM 逐字渲染
 * 影响：纯数据层——只修改传入的 message 对象（content / files），不触碰 DOM，不发网络请求
 * 相交：← virtualQueue.mjs（唯一调用方）→ whitebox.mjs（wbTrace/wbDetect 链路追踪）
 *
 * 点击后发生什么（完整流式链路）：
 *   后端推 stream_update SSE → websocket → virtualQueue.handleStreamUpdate
 *   → applySlice 更新内存中的 message.content → StreamRenderer 把新 content 渲染进 DOM
 */
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";

/**
 * 将流切片应用到消息对象上，更新消息内容和文件。
 * @param {object} message - 消息对象，将被修改。
 * @param {object} slice - 流切片对象。
 * @returns {object} - 更新后的消息对象。
 */
export function applySlice(message, slice) {
	message.content = message.content || ''

	switch (slice.type) {
		case 'append':
			wbTrace('stream', 'applySlice.append', { addLen: slice.add?.content?.length, hasFiles: !!slice.add?.files })
			message.content += slice.add.content
			if (slice.add.files)
				message.files = (message.files || []).concat(slice.add.files)

			break
		case 'rewrite_tail': {
			// 健壮处理：如果 index 超出范围，回退到追加
			wbDetect('stream', 'applySlice.rewrite_tail', slice.index <= message.content.length, 'rewrite_tail index 越界', { index: slice.index, contentLen: message.content.length })
			const safeIndex = Math.min(slice.index, message.content.length)
			message.content = message.content.substring(0, safeIndex) + slice.content
			break
		}
		case 'set_files':
			wbTrace('stream', 'applySlice.set_files', { fileCount: slice.files?.length })
			message.files = slice.files
			break
	}
	return message
}

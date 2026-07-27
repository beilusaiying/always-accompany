import { getInjectText, fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { splitBotReply } from "../../../../../../scripts/botContentShared.mjs" // T9 件5：消息分段唯一实现

/**
 * 分割 LINE 回复（LINE 单条消息上限 5000 字符）。
 * @param {string} reply - 要分割的回复字符串。
 * @param {number} split_length - 分割长度，默认 4800 留出余量。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitLineReply(reply, split_length = 4800) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（较原版补上代码块保围栏拆分=质量升级）。
	return splitBotReply(reply, split_length)
}

/**
 * 格式化 LINE source 来源信息为可读字符串。
 * @param {object} source - LINE event source 对象。
 * @returns {string}
 */
export function formatLineSource(source) {
	if (!source) return 'unknown'
	if (source.type === 'user') return `user:${source.userId}`
	if (source.type === 'group') return `group:${source.groupId}`
	if (source.type === 'room') return `room:${source.roomId}`
	return `${source.type}:unknown`
}

/**
 * 获取 LINE event 的会话 ID（用于聊天日志分组）。
 * 私聊 → userId；群 → groupId；聊天室 → roomId。
 * @param {object} event - LINE webhook event。
 * @returns {string}
 */
export function getLineSessionId(event) {
	const { source } = event
	if (!source) return 'unknown'
	if (source.type === 'group') return source.groupId
	if (source.type === 'room') return source.roomId
	return source.userId
}

/**
 * 从 LINE message event 提取纯文本内容。
 * @param {object} event - LINE webhook message event。
 * @returns {string}
 */
export function extractLineTextContent(event) {
	const msg = event.message
	if (!msg) return ''
	if (msg.type === 'text') return msg.text || ''
	if (msg.type === 'image') return getInjectText('bots.image_placeholder')
	if (msg.type === 'video') return getInjectText('bots.video_placeholder')
	if (msg.type === 'audio') return getInjectText('bots.voice_placeholder')
	if (msg.type === 'file') return fillInjectText('bots.file_placeholder', { name: msg.fileName || '' })
	if (msg.type === 'location')
		return `[位置: ${msg.title || ''} ${msg.address || ''} (${msg.latitude},${msg.longitude})]`
	if (msg.type === 'sticker') return `[贴图: ${msg.packageId}/${msg.stickerId}]`
	return `[${msg.type}]`
}

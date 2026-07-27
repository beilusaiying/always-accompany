import { getInjectText, fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { splitBotReply } from '../../../../../../scripts/botContentShared.mjs' // T9 件5：消息分段唯一实现

/**
 * 分割飞书回复文本（单条消息建议不超过 4000 字符）。
 * @param {string} reply - 要分割的回复字符串。
 * @param {number} split_length - 分割长度，默认 4000。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitLarkReply(reply, split_length = 4000) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（原"先合并后硬切"两阶段为历史漂移，统一到全量管线=质量升级）。
	return splitBotReply(reply, split_length)
}

/**
 * 格式化飞书消息内容（text 类型）。
 * @param {object} larkMessage - 飞书消息对象（data.message）。
 * @returns {string} 格式化后的纯文本内容。
 */
export function formatLarkMessageContent(larkMessage) {
	let content = ''

	try {
		const msgType = larkMessage.message_type
		const rawContent = larkMessage.content ? JSON.parse(larkMessage.content) : {}

		if (msgType === 'text') {
			content = rawContent.text || ''
			// 原文照取，@提及标记（如 @_user_1）由 parseMentions 单独解析，此处不处理
		} else if (msgType === 'post') {
			// 富文本：提取所有 text 内容
			const postContent = rawContent.zh_cn || rawContent.en_us || rawContent
			if (postContent?.content) {
				const lines = postContent.content
				content = lines.map(line =>
					line.map(seg => seg.text || '').join('')
				).join('\n')
			}
		} else if (msgType === 'image') {
			content = getInjectText('bots.image_placeholder')
		} else if (msgType === 'file') {
			content = fillInjectText('bots.file_placeholder', { name: rawContent.file_name || '未知文件' })
		} else if (msgType === 'audio') {
			content = getInjectText('bots.voice_placeholder')
		} else if (msgType === 'media') {
			content = getInjectText('bots.video_placeholder')
		} else if (msgType === 'sticker') {
			content = '[表情包]'
		} else if (msgType === 'interactive') {
			content = '[卡片消息]'
		} else {
			content = `[${msgType} 消息]`
		}
	} catch (e) {
		content = larkMessage.content || ''
	}

	return content
}

/**
 * 解析飞书消息中的 @提及信息。
 * @param {object} larkMessage - 飞书消息对象（data.message）。
 * @returns {Array<{key: string, open_id: string, name: string}>} 提及列表。
 */
export function parseMentions(larkMessage) {
	if (!larkMessage.mentions) return []
	return larkMessage.mentions.map(m => ({
		key: m.key,
		open_id: m.id?.open_id || '',
		name: m.name || '',
	}))
}

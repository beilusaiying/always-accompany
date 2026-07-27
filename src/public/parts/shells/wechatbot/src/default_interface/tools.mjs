import { getInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { splitBotReply } from "../../../../../../scripts/botContentShared.mjs";

/**
 * 分割微信回复文本（微信单条消息建议不超过 1000 字符）。
 * T9 件5：收口 botContentShared.splitBotReply 单一实现（原 trimShortInput 短输入语义为历史漂移，统一即升级）。
 * @param {string} reply - 要分割的回复字符串。
 * @param {number} split_length - 分割长度，默认 1000。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitWechatReply(reply, split_length = 1000) {
	return splitBotReply(reply, split_length)
}

/**
 * 格式化微信消息内容（去除无法显示的协议字段，保留纯文本）。
 * @param {object} message - Webhook 推送的微信消息对象。
 * @returns {string} 格式化后的消息内容。
 */
export function formatWechatMessage(message) {
	if (!message) return ''
	let content = message.content || ''

	// 附图消息（msgType=3）：标注图片
	if (message.msgType === 3) {
		if (message.imageUrl)
			content = content ? `${content}\n${getInjectText('bots.image_placeholder')} ${message.imageUrl}` : `${getInjectText('bots.image_placeholder')} ${message.imageUrl}`
		else if (!content)
			content = getInjectText('bots.image_placeholder')
	}

	// 语音消息（msgType=34）
	if (message.msgType === 34 && !content)
		content = getInjectText('bots.voice_placeholder')

	// 视频消息（msgType=43）
	if (message.msgType === 43 && !content)
		content = '[视频消息]'

	// 链接/卡片消息（msgType=49）
	if (message.msgType === 49 && !content)
		content = '[链接/卡片消息]'

	return content
}

/**
 * 判断是否为群聊消息。
 * @param {object} message - Webhook 推送的微信消息对象。
 * @returns {boolean}
 */
export function isGroupMessage(message) {
	return Boolean(message.chatRoom && message.chatRoom.endsWith('@chatroom'))
}

/**
 * 判断消息是否@了机器人（群聊中）。
 * @param {object} message - Webhook 推送的微信消息对象。
 * @param {string} botWxid - 机器人的微信 ID。
 * @param {string} botNickname - 机器人的昵称。
 * @returns {boolean}
 */
export function isMentioned(message, botWxid, botNickname) {
	const content = message.content || ''
	if (botWxid && content.includes(`@${botWxid}`)) return true
	if (botNickname && content.includes(`@${botNickname}`)) return true
	// 协议层通常会在 content 里直接有 @昵称
	return false
}

/**
 * 从群聊消息内容中去掉 @ 机器人的部分，得到干净的文本。
 * @param {string} content - 原始消息内容。
 * @param {string} botNickname - 机器人昵称。
 * @returns {string}
 */
export function stripMention(content, botNickname) {
	if (!content) return ''
	let result = content
	if (botNickname)
		result = result.replace(new RegExp(`@${botNickname}\\s*`, 'g'), '')
	// 通用 @wxid_ 格式
	result = result.replace(/@[a-zA-Z0-9_-]+\s*/g, '')
	return result.trim()
}

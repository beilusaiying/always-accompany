import { splitBotReply } from '../../../../../../scripts/botContentShared.mjs' // T9 件5：消息分段唯一实现

/**
 * 将文本拆分为适合 X (Twitter) 发送的块。
 * 按换行优先，超限则硬切，保留整词。
 * @param {string} text - 要拆分的文本。
 * @param {number} [maxLength=280] - 每块的最大字符数。
 * @returns {string[]} 拆分后的字符串数组。
 */
export function splitXReply(text, maxLength = 280) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（原硬切不 trim 为历史漂移，统一即升级）。
	return splitBotReply(text, maxLength)
}

/**
 * 将文本拆分为适合 X DM 发送的块（DM 限制 10000 字符）。
 * @param {string} text - 要拆分的文本。
 * @param {number} [maxLength=10000] - 每块的最大字符数。
 * @returns {string[]} 拆分后的字符串数组。
 */
export function splitDMReply(text, maxLength = 10000) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（原纯定长切片为历史简陋实现，统一即升级）。
	return splitBotReply(text, maxLength)
}

/**
 * 格式化 X DM 事件为可读文本。
 * @param {object} dmEvent - twitter-api-v2 返回的 dm_event 对象。
 * @returns {string} 格式化后的消息文本。
 */
export function formatDMEventContent(dmEvent) {
	let content = dmEvent.text || ''
	// 附件（media 等）暂只记录类型提示
	if (dmEvent.attachments?.media_keys?.length)
		content += (content ? '\n' : '') + `[媒体附件 x${dmEvent.attachments.media_keys.length}]`
	return content
}

/**
 * 格式化推文提及为可读文本。
 * @param {object} tweet - twitter-api-v2 返回的 tweet 对象。
 * @param {string} botUsername - Bot 自身的用户名，用于清理多余的@。
 * @returns {string} 格式化后的推文文本。
 */
export function formatMentionContent(tweet, botUsername) {
	let content = tweet.text || ''
	// 清理开头的 @botUsername（X 回复时会自动加上）
	if (botUsername)
		content = content.replace(new RegExp(`^@${botUsername}\\s*`, 'i'), '').trim()
	return content
}

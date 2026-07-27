import { getInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { splitBotReply } from "../../../../../../scripts/botContentShared.mjs"; // T9 件5：消息分段唯一实现

/**
 * 分割 Discord 回复。
 * @param {string} reply - 要分割的回复字符串。
 * @param {number} split_length - 分割长度。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitDiscordReply(reply, split_length = 2000) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（弯引号句读已并入共享超集正则）。平台差异只剩长度上限。
	return splitBotReply(reply, split_length)
}

/**
 * 格式化嵌入内容。
 * @param {import('npm:discord.js').Embed} embed - 嵌入对象。
 * @returns {string} 格式化后的字符串。
 */
function formatEmbed(embed) {
	let embedContent = ''
	if (embed.data)
		if (embed.data?.author?.name)
			embedContent += embed.data.author.name + '\n'
	if (embed.title) embedContent += embed.title + '\n'
	if (embed.description) embedContent += embed.description + '\n'
	for (const field of embed.fields || []) {
		if (field.name) embedContent += field.name + '\n'
		if (field.value) embedContent += field.value + '\n'
	}
	if (embed.footer?.text) embedContent += embed.footer.text + '\n'
	return embedContent ? '```\n' + embedContent + '```\n' : ''
}

/**
 * 从 Discord 消息的 components（如 ContainerComponent、TextDisplayComponent 等）中递归提取文本。
 * 用于处理 content 为空但内容在 components 中的消息（如共享协议询问等新 UI 消息）。
 * @param {import('npm:discord.js').Component[]} components - 消息的 components 数组。
 * @returns {string} - 提取出的文本，用换行拼接。
 */
function extractTextFromComponents(components) {
	if (!Array.isArray(components) || !components.length) return ''
	const parts = []
	for (const comp of components) {
		if (!comp) continue
		if (comp.data?.content) parts.push(comp.data.content)
		if (comp.data?.label) parts.push(comp.data.label)
		if (comp.components?.length)
			parts.push(extractTextFromComponents(comp.components))
		if (comp.accessory)
			parts.push(extractTextFromComponents([comp.accessory]))
	}
	return parts.filter(Boolean).join('\n')
}

/**
 * 格式化消息内容。
 * @param {import('npm:discord.js').Message} message - Discord 消息对象。
 * @returns {string} 格式化后的消息内容字符串。
 */
function formatMessageContent(message) {
	let content = message.content || ''

	// 1. 先处理用户提及（mention用半角<@id>匹配，必须在转义之前）
	for (const [_, value] of message.mentions?.users || new Map()) {
		const mentionTag = `<@${value.id}>`
		if (content.includes(mentionTag))
			content = content.replaceAll(mentionTag, `@${value.username}`)
		else
			content = `@${value.username} ${content}`
	}

	// 2. ★ 安全：转义XML标签，防止外部用户注入内部指令（mention之后）
	content = content.replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E')
	// 长度限制（Discord本身限制2000，但embed/附件会追加）
	if (content.length > 4000) {
		content = content.substring(0, 4000) + '[...]'
	}

	// 添加 embed
	for (const embed of message.embeds || []) {
		const embedText = formatEmbed(embed)
		if (embedText) {
			if (content) content += '\n'
			content += embedText
		}
	}

	// 如果有附件，添加附件的信息 (这里假设附件类型有 url 属性)
	for (const attachment of message.attachments || [])
		if (attachment.url) {
			if (content) content += '\n'
			content += `${getInjectText('bots.attachment_placeholder')} ${attachment.url}\n`
		}

	// 若存在 components（如共享协议询问等新 UI 消息），从 components 提取文本
	if (message.components?.length) {
		const componentText = extractTextFromComponents(message.components)
		if (componentText) {
			if (content) content += '\n\n'
			content += componentText
		}
	}

	// 如果已编辑
	if (message.edited_timestamp) content += '（已编辑）'

	return content
}

/**
 * 获取完整的消息内容，包括附件和嵌入。
 * @param {import('npm:discord.js').Message} message - Discord 消息对象。
 * @param {import('npm:discord.js').Client} client - Discord 客户端实例。
 * @returns {Promise<string>} 完整的消息内容字符串。
 */
export async function getMessageFullContent(message, client) {
	let fullContent = formatMessageContent(message)

	// 处理转发消息
	const referencedMessages = message.messageSnapshots.map(t => t)
	for (const referencedMessage of referencedMessages) {
		const refContent = formatMessageContent(referencedMessage, client)
		const authorName = referencedMessage.author?.username || '未知用户'
		if (fullContent) fullContent += '\n\n'
		fullContent += `（转发消息）\n${authorName}：${refContent}`
	}

	return fullContent
}

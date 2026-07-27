import { fillInjectText } from "../../../../../../yonban/core/functions/injectTexts/main.mjs"; // 注入文本单源（铁律：进 chat_log 的文本用户可配置）
import { splitBotReply } from "../../../../../../scripts/botContentShared.mjs"; // T9 件5：消息分段唯一实现

/**
 * 分割 Telegram 回复（Telegram 限制 4096 字符）。
 * @param {string} reply
 * @param {number} split_length
 * @returns {string[]}
 */
export function splitTelegramReply(reply, split_length = 4096) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（较原版补上代码块保围栏+句读智能切+相邻合并=质量升级）。
	return splitBotReply(reply, split_length);
}

/**
 * 从 Telegram 消息中提取完整文本内容。
 * @param {import('npm:grammy').Context} ctx
 * @returns {string}
 */
export function getMessageFullContent(ctx) {
	const msg = ctx.message || ctx.editedMessage;
	if (!msg) return '';

	let content = msg.text || msg.caption || '';

	if (msg.reply_to_message) {
		const ref = msg.reply_to_message;
		const refAuthor = ref.from?.first_name || ref.from?.username || '未知用户';
		const refContent = ref.text || ref.caption || '';
		if (refContent)
			content = `${fillInjectText("bots.reply_quote", { author: refAuthor })}\n${content}`;
	}

	if (msg.forward_from || msg.forward_from_chat) {
		const fwdName = msg.forward_from?.first_name ||
			msg.forward_from_chat?.title || '未知';
		content = `（转发自 ${fwdName}）\n${content}`;
	}

	return content;
}

/**
 * 获取 Telegram 用户的显示名称。
 * @param {object} user - Telegram User 对象
 * @returns {string}
 */
export function getUserDisplayName(user) {
	if (!user) return '未知用户';
	if (user.first_name && user.last_name)
		return `${user.first_name} ${user.last_name}`;
	return user.first_name || user.username || `User_${user.id}`;
}

/**
 * 获取聊天的名称标识。
 * @param {object} chat - Telegram Chat 对象
 * @returns {string}
 */
export function getChatName(chat) {
	if (!chat) return 'Unknown';
	if (chat.type === 'private')
		return `DM with ${chat.first_name || chat.username || chat.id}`;
	return chat.title || `Group_${chat.id}`;
}

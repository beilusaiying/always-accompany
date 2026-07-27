import { splitBotReply } from '../../../../../../scripts/botContentShared.mjs' // T9 件5：消息分段唯一实现

/**
 * 分割钉钉回复文本。
 * 钉钉 Markdown 消息最大约 20000 字符，文本消息建议 5000 以内。
 * @param {string} reply - 要分割的回复字符串。
 * @param {number} split_length - 分割长度，默认 4800（文本模式安全上限）。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitDingTalkReply(reply, split_length = 4800) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（代码块保围栏拆分已是共享默认行为）。
	return splitBotReply(reply, split_length)
}

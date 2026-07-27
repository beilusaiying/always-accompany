import { splitBotReply } from "../../../../../../scripts/botContentShared.mjs";

// T9 件5：收口 botContentShared.splitBotReply 单一实现（较原版补上代码块保围栏+句读智能切+相邻合并=质量升级）。默认 3000 保持。
export function splitSlackReply(reply, split_length = 3000) {
	return splitBotReply(reply, split_length);
}

export function getUserDisplayName(event) {
	return event.user_profile?.display_name ||
		event.user_profile?.real_name ||
		event.username ||
		event.user ||
		'未知用户';
}

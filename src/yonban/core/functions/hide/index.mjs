/**
 * functions/hide/index.mjs — 隐藏/剥离系统节点 facade（T3b·组10 已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:hide", verb:"stripThinking|getReasoningTags|isHidden|isVisibleToUser|filterVisible", payload})
 *   → ./stripThinking.mjs（thinking 剥离单源：per-user 配置+闭合/未闭合，8 入口共用——
 *     regex 组 TweakPrompt 已改调合一，api proxy 出站×2 组内自用，memory/chat 4 宿主经
 *     messageTransform re-export 到达，T8 统一切 import）
 *   → ./chatEntryUtils.mjs（可见性判定：isDeleted/isHidden/isVisibleToUser/filterActive——
 *     消费方 replyHandler/endpoints/chatOps/chatStorage/generation/models 经旧位壳到达）。
 *
 * 【why】
 *   凛倾 05-18：thinking 用户可见可复制、出站给 AI 前剥离；06-25：隐藏策略要可设置、各处共用
 *   ——本组是"策略单源"，各宿主调本组而非各自实现。
 *   范围裁决（T3b 执行记录批1 详述）：content_for_show 生产（mvu/replyHandler）与 stCompat 消费、
 *   defineInlineToolUses 两壳分叉副本、T09 压缩（memory 域）——本批标注不抽（宿主改动风险>收益，
 *   压缩并入 T3e 考虑；两壳合并属框架残骸清理另案）。
 *   剥离正则"可设置接口"（06-25）留 T6 前端批（隐藏任务①：抽取批不顺手加功能）。
 *
 * 【影响范围】
 *   本文件仅注册节点；剥离行为在 stripThinking（改它=改全部出站剥离）。
 */
import { getReasoningTags, stripReasoningTags, setReasoningTags } from "./stripThinking.mjs";
import {
	filterVisibleToUser,
	isDeleted,
	isHidden,
	isVisibleToUser,
} from "./chatEntryUtils.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:hide", {
	transport: "local",
	handlers: {
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，覆盖 payload 自报。
		// 主链（runner/shadowBuild）scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。
		async stripThinking(payload, context) {
			const _u = context?.user ?? payload?.username;
			return { ok: true, data: stripReasoningTags(payload?.text, _u, payload?.extraTags) };
		},
		async getReasoningTags(payload, context) {
			// context.user 存在则以其为权威身份（覆盖 payload.username/config 二选一分支）
			return { ok: true, data: getReasoningTags(context?.user ?? payload?.username ?? payload?.config) };
		},
		async setReasoningTags(payload, context) {
			// 24批1（07-03）：写侧收口——原写路只有 memory#updateConfig（"只有airp能改"根因=hide 无写 verb）。
			// 身份=桥盖章唯一权威；charName 从 payload（与 memory updateConfig 卡定位同语义）。
			const _u = context?.user ?? payload?.username;
			// charName 回退 "_global"=与 memory updateConfig 落卡三段回退（setDataActions:713）同锚——读侧跨卡扫描命中同一份
			// [0720 硬化] reasoning_builtin 不再透传：内置 think/thinking 恒剥离（凛倾硬性核心）,写单点顺手清存量键
			// [2026-08-10] beilu_thinking_strip 透传：payload 无该字段时值为 undefined，setReasoningTags 按 patch 语义跳过不写盘
			//   （保持盘上开关现值）；reasoning_tags 同理——只带一个字段的写路不会清掉另一个字段。
			return { ok: true, data: setReasoningTags(_u, payload?.charName || "_global", { reasoning_tags: payload?.reasoning_tags, beilu_thinking_strip: payload?.beilu_thinking_strip }) };
		},
		async isHidden(payload, _context) {
			return { ok: true, data: isHidden(payload?.entry) };
		},
		async isDeleted(payload, _context) {
			return { ok: true, data: isDeleted(payload?.entry) };
		},
		async isVisibleToUser(payload, _context) {
			return { ok: true, data: isVisibleToUser(payload?.entry) };
		},
		async filterVisible(payload, _context) {
			return { ok: true, data: filterVisibleToUser(payload?.chatLog ?? []) };
		},
	},
});

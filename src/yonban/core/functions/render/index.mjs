/**
 * functions/render/index.mjs — 渲染系统节点 facade（T3b·组4 已入住，抽取型）
 *
 * 【功能链】
 *   dispatch({target:"functions:render", verb:"extractEmotion|extractMotion|extractOrbMessage", payload:{content}})
 *   → ./emotionExtract.mjs 三纯函数 → 值；宿主 replyHandler 拿值后自做副作用
 *   （emotion_changed/motion_triggered WS 广播 + orb 双投）——去向属出口节点域不进本组。
 *
 * 【why】
 *   组4 render：界面/字符/Live2D 渲染在前端（live2dRenderer/StreamRenderer/messageList——frontend 层），
 *   后端可抽的纯逻辑只有标签解析。「音乐播放分支」：545 backend 未命中独立文件（T3b 步骤4 只核不造，
 *   核查结论见执行记录——前端 grep 待 T6 批一并核，未落地则记录不实现）。
 *
 * 【影响范围】
 *   纯函数零副作用。
 */
import { extractEmotion, extractMotion, extractOrbMessage } from "./emotionExtract.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:render", {
	transport: "local",
	handlers: {
		async extractEmotion(payload, _context) {
			return { ok: true, data: extractEmotion(payload?.content) };
		},
		async extractMotion(payload, _context) {
			return { ok: true, data: extractMotion(payload?.content) };
		},
		async extractOrbMessage(payload, _context) {
			return { ok: true, data: extractOrbMessage(payload?.content) };
		},
	},
});

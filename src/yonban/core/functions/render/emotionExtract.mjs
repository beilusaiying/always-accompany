/**
 * emotionExtract.mjs — 情绪/动作/悬浮球标签抽取纯逻辑（T3b·render 组，2026-07-02 从 replyHandler 抽出）
 *
 * 【功能链】
 *   AI 回复含 <emotion>/<motion>/<orbMessage> 标签 → replyHandler 调本组三函数抽值（纯解析+卫生校验）
 *   → 副作用留宿主：emotion_changed / motion_triggered WS 广播（Live2D/桌面精灵消费）+
 *   orb 双投（WS toast + injection_state 桌宠队列）。
 *
 * 【why】
 *   3_功能层 组4 render 抽取目标：把 replyHandler 内嵌的"解析情绪标签"纯逻辑抽成独立食材，
 *   功能库无状态化，前端渲染器订阅结果不变。副作用（广播去向）不进本组——去向属出口节点域。
 *   卫生校验语义一字未改（框架层归位注释保留在宿主）：情绪合法性只有模型/渲染层知道，
 *   此处只做限长+字符集卫生，防任意内容进广播。
 *
 * 【影响范围】
 *   纯函数零副作用。宿主 replyHandler 改调本组（同一正则同一校验，行为等价）。
 */

// 标签名卫生(凛倾 2026-07-09"禁止硬编码,包括标签"):标签名可经 pet_settings 配置传入,
// 进正则前白检(词字符/中文/连字符,与 strip_tags_custom.json 同一字符集),不合法回退默认——防配置值注入正则。
function _safeTag(name, def) {
	return (typeof name === "string" && /^[\w\u4e00-\u9fff-]+$/.test(name)) ? name : def;
}

/** <emotion> 抽取(标签名可配置,缺省 "emotion"):限长 64 + 中英文词字符集卫生。无命中/不合法 → ""。 */
export function extractEmotion(content, tagName) {
	try {
		const t = _safeTag(tagName, "emotion");
		const m = content && content.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, "i"));
		const raw = m ? m[1].trim().toLowerCase() : "";
		if (raw && raw.length <= 64 && /^[\w\u4e00-\u9fa5][\w\s,\u4e00-\u9fa5-]*$/.test(raw)) return raw;
	} catch { /* 抽取失败不影响主回复 */ }
	return "";
}

/** <motion> 抽取(标签名可配置,缺省 "motion")：支持 <motion>group</motion> 与 <motion name="group"/> 两种写法。 */
export function extractMotion(content, tagName) {
	try {
		const t = _safeTag(tagName, "motion");
		const m = content && content.match(new RegExp(`<${t}(?:\\s+name="([^"]+)")?\\s*\\/?>([^<]*?)(?:<\\/${t}>)?`, "i"));
		const raw = m ? (m[1] || m[2] || "").trim() : "";
		if (raw && raw.length <= 64 && /^[\w][\w\s-]*$/.test(raw)) return raw;
	} catch { /* 抽取失败不影响主回复 */ }
	return "";
}

/** <orbMessage> 抽取(标签名可配置,缺省 "orbMessage")：悬浮球/桌宠文本（内容清洗由展示侧 strip 负责，此处只取原文 trim）。
 *  2026-07-09 收口审计：同组 extractEmotion/extractMotion 已走 _safeTag 可配置范式，唯本函数漏配——补齐
 *  （凛倾"禁止硬编码,包括标签"）。配置键=pet_settings.orbMessageTag，改名后 strip 补剥同 emotionTag（strip_tags_custom.json）。 */
export function extractOrbMessage(content, tagName) {
	try {
		const t = _safeTag(tagName, "orbMessage");
		const m = content && content.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, "i"));
		return m ? m[1].trim() : "";
	} catch { /* 抽取失败不影响主回复 */ }
	return "";
}

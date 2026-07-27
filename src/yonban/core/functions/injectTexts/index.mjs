/**
 * functions/injectTexts/index.mjs — AI 注入文本配置链节点 facade
 *
 * 【功能链】
 *   前端 settingsSlots.initInjectTextsSlot → sendAction 桥（/api/yonban/dispatch）
 *   → dispatch({target:"functions:injectTexts", verb:"getData|setData"}) → main.mjs GetData/SetData
 *   → 覆盖层 data/inject-texts.json。producer 侧不经本节点（直 import main.mjs getInjectText）。
 *
 * 【why】
 *   注册进 all.mjs 全量装载清单后桥可达（桥只放行 functions:* 命名空间）。
 *   全局配置不消费身份（范式同 sysinfo），context.user 不参与换算。
 */
import { register } from "../../dispatch/registry.mjs";
import { GetData, SetData } from "./main.mjs";

register("functions:injectTexts", {
	transport: "local",
	contributes: {
		flows: ["operation"],
		tags: [],
	},
	handlers: {
		async getData() {
			return { ok: true, data: await GetData() };
		},
		async setData(payload) {
			return { ok: true, data: await SetData(payload?.data) };
		},
	},
});

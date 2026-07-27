/**
 * functions/api/index.mjs — api（AI provider）组节点 facade（T3c 已入住：实现体在本组各 provider）
 *
 * 【功能链】
 *   一次生成的出站段（3_功能层 §组3 传导链）：
 *     preset TweakPrompt×3 → GetReply → AIsource.StructCall（本组入口）
 *       → commanderAssembly 五段 → applyModelParams 按 provider 映射形状
 *       → 缓存断点落位（proxy: bp1 锚 system / bp2 锚 </chat_history>）→ httpFetch 出站
 *       → provider → 流式回传 StreamPayload → stream 渲染 + 落盘。
 *
 *   api 组=被调型节点（无 chat 四钩子，设计 §四矩阵：api 行全 —）。它是 intent=请求的**下游执行端**。
 *   dispatch({target:"functions:api", verb, payload}) verb ∈:
 *     - getConfigTemplate({provider})      → 该 provider 的配置模板（静态 part 接口，纯函数可达）
 *     - getSource({provider,config,opts})  → 构造一个 AIsource 实例（provider.GetSource(config,opts)）
 *     - structCall({source,prompt_struct,options}) → 转调**已构造 source 实例**的 StructCall（司令员五段/applyModelParams/缓存断点全在实例内）
 *     - call({source,prompt,...})          → 转调已构造 source 实例的 Call
 *
 * 【why — 为何 structCall/call 不能像 image 组那样绑纯函数（重要设计约束，落报告）】
 *   provider 的 StructCall/Call 是 **AIsource 实例方法**，不是模块级导出（claude/main.mjs:85 等：
 *   StructCall 定义在 GetSource(config) 返回的 result 对象内，闭包持 config/claudeAPI 实例/Cookie 轮换态）。
 *   生产链路真实入口是 serviceSources/AI/main.mjs 的 loadPartBase → part.interfaces.serviceGenerator.GetSource(config)
 *   → 得到带 .StructCall/.Call 的 source 实例（keyed by source config，Cookie 轮换/并发锁=源属性）。
 *   本 facade 不重写该生命周期（serviceSources 容器骨架不迁，见报告待决段），故 structCall/call
 *   handler 接收调用方已持有的 source 实例并转调其方法——facade 是「调用形态适配」不是「实例托管」。
 *   getConfigTemplate/getSource 是可静态绑定的最小可用集（part default → interfaces.serviceGenerator）。
 *
 * 【签名核对（T3a·3.7 教训：转调签名逐个核原文，禁凭惯例）】
 *   - GetConfigTemplate: async () => template（无参）— claude/main.mjs:27 / claude-api:55 / proxy:48
 *   - GetSource(config, {SaveConfig,username})：claude/main.mjs:51 / claude-api:79（仅 config）/ fallback:50 / polling:52
 *   - source.StructCall(prompt_struct, options={})：claude/main.mjs:85 / claude-api:160
 *   - source.Call(prompt)：claude/main.mjs:67 / claude-api:118
 *
 * 【影响范围】
 *   请求流出站段全部 + bot（IM 平台经同一生成链）。迁移只动文件位置 + facade，链上 payload 字节零变化
 *   （缓存断点/司令员五段/max_tokens 二分截断逻辑一字未改，仅 import 级数/info.json 回指旧位适配）。
 *   注册为 registry 节点 functions:api（transport:local）；T5/T6 接线前为影子节点，不接生产流量。
 */
import claudePart from "./claude/main.mjs";
import claudeApiPart from "./claude-api/main.mjs";
import geminiPart from "./gemini/main.mjs";
import grokPart from "./grok/main.mjs";
import ollamaPart from "./ollama/main.mjs";
import proxyPart from "./proxy/main.mjs";
import emptyPart from "./empty/main.mjs";
import fallbackPart from "./fallback/main.mjs";
import pollingPart from "./polling/main.mjs";
import changePromptPart from "./change-prompt/main.mjs";
import { register } from "../../dispatch/registry.mjs";

/** provider 名 → part 对象（part.interfaces.serviceGenerator.{GetConfigTemplate,GetSource}）。 */
const PROVIDERS = {
	claude: claudePart,
	"claude-api": claudeApiPart,
	gemini: geminiPart,
	grok: grokPart,
	ollama: ollamaPart,
	proxy: proxyPart,
	empty: emptyPart,
	fallback: fallbackPart,
	polling: pollingPart,
	"change-prompt": changePromptPart,
};

/**
 * 取 provider part 的 serviceGenerator 接口，未知 provider 抛错。
 * @param {string} provider - provider 名（PROVIDERS 键）。
 * @returns {object} part.interfaces.serviceGenerator。
 */
function _sg(provider) {
	const part = PROVIDERS[provider];
	if (!part) throw new Error(`[functions:api] 未知 provider: ${String(provider)}（须为 ${Object.keys(PROVIDERS).join("/")}）`);
	return part.interfaces?.serviceGenerator ?? {};
}

register("functions:api", {
	transport: "local",
	handlers: {
		/** 取指定 provider 的配置模板（静态 part 接口，无参）。payload:{provider} */
		async getConfigTemplate(payload, _context) {
			return { ok: true, data: await _sg(payload?.provider).GetConfigTemplate() };
		},
		/** 用 provider.GetSource(config, opts) 构造一个 AIsource 实例。payload:{provider,config,opts} */
		async getSource(payload, _context) {
			return { ok: true, data: await _sg(payload?.provider).GetSource(payload?.config ?? {}, payload?.opts ?? {}) };
		},
		/** 转调调用方已持有的 source 实例的 StructCall（source 由 getSource 或 serviceSources 容器构造）。payload:{source,prompt_struct,options} */
		async structCall(payload, _context) {
			return { ok: true, data: await payload.source.StructCall(payload?.prompt_struct, payload?.options ?? {}) };
		},
		/** 转调调用方已持有的 source 实例的 Call。payload:{source,prompt} */
		async call(payload, _context) {
			return { ok: true, data: await payload.source.Call(payload?.prompt) };
		},
	},
});

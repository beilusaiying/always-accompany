/**
 * functions/sandbox/index.mjs — 沙箱系统节点 facade（T3a·3.3 已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:sandbox", verb:"tweakPrompt|setConfig", payload})
 *   → ./main.mjs part 接口（interfaces.chat.TweakPrompt dl=0 EJS 渲染 / interfaces.config.SetData）
 *   → ejs-worker.mjs（Deno Worker permissions:'none'，超时默认 3000ms 下限 100ms）→ 渲染结果回填。
 *   旧线路：part 加载链 GetPartPath('plugins/beilu-ejs') → 旧位 main.mjs 薄壳 → 本组实现，
 *   prompt_struct 组装对 part 的 TweakPrompt 调用照旧，行为等价。
 *
 * 【why】
 *   组9：Worker isolate 天然隔离（不自造隔离墙）。part 元数据 info.json 留原位（part 身份归 parts 树），
 *   实现体三文件同迁（main 的 Worker URL './ejs-worker.mjs' 与动态 import './ejs-context.mjs'
 *   均为同目录相对引用，同迁零适配；到 server/ 的 path_confine/wbStub 新旧位同为 4 级回溯，零适配）。
 *   前端 stCompat/ejsEngine.mjs 不可动——只标注归属，不迁。
 *
 * 【影响范围】
 *   本文件仅注册节点（纯内存）；渲染副作用在 part 接口内（与旧线路同一实现）。
 */
import part from "./main.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:sandbox", {
	transport: "local",
	handlers: {
		async tweakPrompt(payload, _context) {
			// payload = { arg, prompt_struct, my_prompt, detail_level }（part TweakPrompt 原签名透传）
			const { arg, prompt_struct, my_prompt, detail_level } = payload ?? {};
			await part.interfaces?.chat?.TweakPrompt?.(arg, prompt_struct, my_prompt, detail_level);
			return { ok: true, data: prompt_struct };
		},
		async setConfig(payload, _context) {
			await part.interfaces?.config?.SetData?.(payload ?? {});
			return { ok: true };
		},
	},
});

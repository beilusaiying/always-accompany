/**
 * functions/sandbox/index.mjs — 沙箱系统节点 facade（收口层，仅此一文件）
 *
 * 【功能链】
 *   dispatch({target:"functions:sandbox", verb:"tweakPrompt|setConfig", payload})
 *   → part 实现体 interfaces（TweakPrompt dl=0 EJS 渲染 / config.SetData）
 *   → ejs-worker.mjs（Deno Worker permissions:'none'，超时默认 3000ms 下限 100ms）→ 渲染结果回填。
 *   主线路：part 加载链 GetPartPath('plugins/beilu-ejs') → part main.mjs（实现体），
 *   prompt_struct 组装对 part 的 TweakPrompt 调用照旧，行为等价。
 *
 * 【why · 2026-08-06 框架化】凛倾拍板"改成框架,而不是耦合核心"：实现体
 *   （main/ejs-context/ejs-worker 三文件）已迁回 public/parts/plugins/beilu-ejs/，
 *   core 侧只留本收口 facade。本文件 import 与 parts_loader 加载的是**同一物理 URL**
 *   （ESM 按解析后 URL 缓存）→ 全进程单实例，无"关了照跑"双实例风险。
 *   partpath 'plugins/beilu-ejs' 不变 → security_policy.mjs owner 闸键继续命中。
 *
 * 【影响范围】
 *   本文件仅注册节点（纯内存）；渲染副作用在 part 接口内（与主线路同一实现）。
 */
import { register } from "../../dispatch/registry.mjs";

// [2026-08-07 插件化解耦] 同 prompt/index.mjs mvu 同款：0806 框架化的顶层静态 import part 物理路径
//   会在 part 目录被删时炸掉本 facade 加载（假插件化）。改惰性动态 import：同 URL 单实例语义不变；
//   part 不可用 → verbs 明确报缺席不崩；失败不缓存，装回即恢复无需重启。
let _ejsPartCache = null;
async function _getEjsPart() {
	if (_ejsPartCache) return _ejsPartCache;
	try {
		_ejsPartCache = (await import("../../../../public/parts/plugins/beilu-ejs/main.mjs")).default;
		return _ejsPartCache;
	} catch (e) {
		console.warn("[functions:sandbox] beilu-ejs part 不可用（已卸载或未安装）:", e?.message);
		return null;
	}
}

register("functions:sandbox", {
	transport: "local",
	handlers: {
		async tweakPrompt(payload, _context) {
			// payload = { arg, prompt_struct, my_prompt, detail_level }（part TweakPrompt 原签名透传）
			const { arg, prompt_struct, my_prompt, detail_level } = payload ?? {};
			const part = await _getEjsPart();
			if (!part) return { ok: false, error: { msg: "beilu-ejs part 不可用（已卸载或未安装），EJS 渲染缺席" } };
			await part.interfaces?.chat?.TweakPrompt?.(arg, prompt_struct, my_prompt, detail_level);
			return { ok: true, data: prompt_struct };
		},
		async setConfig(payload, _context) {
			const part = await _getEjsPart();
			if (!part) return { ok: false, error: { msg: "beilu-ejs part 不可用（已卸载或未安装）" } };
			await part.interfaces?.config?.SetData?.(payload ?? {});
			return { ok: true };
		},
	},
});

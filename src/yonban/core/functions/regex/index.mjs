/**
 * functions/regex/index.mjs — 正则系统节点 facade（T3a·3.4 已入住，按 B1_regex_归档任务.md）
 *
 * 【功能链】
 *   dispatch({target:"functions:regex", verb:"tweakPrompt|replyHandler|setData|getData", payload})
 *   → ./main.mjs part 接口（TweakPrompt dl0 对 user_input+world_info 应用规则 / ReplyHandler 对
 *   ai_output+output_filter 应用规则+剥思维链 / SetData addRule|removeRule|updateRule|importST|
 *   testRule|setGuardConfig|reorder / GetData 规则快照）
 *   → ./regexGuard.mjs（ReDoS 护栏：RE2 线性引擎优先）→ 结果。
 *   旧线路：preset 管线/replyHandler/前端正则面板（HTTP setdata）经旧位薄壳到达同一实现，行为等价。
 *
 * 【why】
 *   B1：regex 是通用食材被任意模式激活；facade 只转调不改逻辑（发现想加 if/回退=停手）。
 *   三处适配均为"数据/共享物留原位"：info.json（part 元数据）、regexCore（前端共享，B1 隐藏任务
 *   归 shared 非本组）、CONFIG_FILE 用户规则数据（迁走=已有规则静默丢失，实测指回原位命中）。
 *
 * 【影响范围】
 *   SetData 写 plugins/beilu-regex/config_data.json（原位，数据不迁）；无其他状态。
 */
import part from "./main.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:regex", {
	transport: "local",
	handlers: {
		// [T077 per-user] 四 verb 均按 context.user 盖章透传 username（桥 session 身份收口，同 T065 preset / T074 worldbook facade）。
		//   前端 regexEditor 经 sendAction(plugins:beilu-regex) 不带 username → 靠桥 session 盖章；缺失回退 _default 桶。
		async tweakPrompt(payload, context) {
			// TweakPrompt 从 arg.username 取用户 → 补 context.user 到缺 username 的 arg（不覆盖已有主链盖章值）。
			const { arg, prompt_struct, my_prompt, detail_level } = payload ?? {};
			const _arg = (arg && !arg.username && context?.user) ? { ...arg, username: context.user } : arg;
			await part.interfaces?.chat?.TweakPrompt?.(_arg, prompt_struct, my_prompt, detail_level);
			return { ok: true, data: prompt_struct };
		},
		async replyHandler(payload, context) {
			// ReplyHandler 从 args.username 取用户 → 补 context.user 到缺 username 的 args。
			const { reply, args } = payload ?? {};
			const _args = (args && !args.username && context?.user) ? { ...args, username: context.user } : args;
			const data = await part.interfaces?.chat?.ReplyHandler?.(reply, _args);
			return { ok: true, data };
		},
		async setData(payload, context) {
			// SetData 第二参 args.username 分桶；无条件盖章 context.user（存在时）=桥 session 唯一权威，防 payload 自报越权。
			const _args = context?.user ? { username: context.user } : undefined;
			const data = await part.interfaces?.config?.SetData?.(payload ?? {}, _args);
			return { ok: true, data };
		},
		async getData(_payload, context) {
			const data = await part.interfaces?.config?.GetData?.({ username: context?.user || "" });
			return { ok: true, data };
		},
	},
});

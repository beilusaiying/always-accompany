/**
 * functions/prompt/index.mjs — 提示词组节点 facade（T3d 已入住：preset+worldbook+mvu+toggle+sysinfo 7 文件）
 *
 * 【功能链】
 *   本组是 intent=请求（GetPrompt+TweakPrompt×3）+ 改动（SetData）+ 展示读（GetData）+ 部分操作（ReplyHandler）
 *   的提示词工程中枢。真实运行线路仍是 parts_loader 发现各 part（经旧位 re-export 薄壳到本组实现）→
 *   prompt_struct.buildPromptStruct 调 part.interfaces.chat.{GetPrompt/TweakPrompt}、前端面板调 interfaces.config
 *   .{GetData/SetData}。本 facade 是 yonban 计算图节点视图：把「按 verb dispatch」映射到各 part 真实 interfaces。
 *
 *   dispatch({target:"functions:prompt", verb, payload}) 路由：
 *     getData/setData      → preset interfaces.config.{GetData(requestedPreset)/SetData(data,args)}（预设 CRUD/切换）
 *     getPrompt/tweakPrompt→ preset interfaces.chat.{GetPrompt(arg)/TweakPrompt(arg,promptStruct,myPrompt,dl)}（司令员三轮 dl=2/1/0）
 *     worldInfo            → worldbook interfaces.chat.GetPrompt(arg)（激活注入，TweakPrompt dl=2 非司令员）
 *     wbGetData/wbSetData  → worldbook interfaces.config.{GetData()/SetData(data,ctx)}
 *     mvuGetPrompt/mvuTweak/mvuReply → mvu interfaces.chat.{GetPrompt/TweakPrompt/ReplyHandler(result,request)}（dl=1 YAML）
 *     mvuGetData/mvuSetData→ mvu interfaces.config.{GetData()/SetData(data)}
 *     toggleGetPrompt/toggleReply → toggle interfaces.chat.{GetPrompt(arg)/ReplyHandler(reply,args)}
 *     sysinfoGetPrompt     → sysinfo interfaces.chat.GetPrompt(arg)
 *
 * 【why】
 *   凛倾迁移范式：把相关文件移进 functions/<组>/、写 index.mjs 做 facade、旧位留 re-export 薄壳。
 *   prompt 组 = 3_功能层 组2（预设+世界书+INJ+变量+条目开关+系统信息）。
 *   verb 转调**逐个照各 part 真实 interfaces 签名原文**（本文件顶部注释已核对每个方法的真实参数），
 *   不凭"钩子惯例"编造参数顺序（T3a screenshot facade 曾因假设 setPendingInjection 参数顺序翻车）。
 *   payload 直传各方法的真实入参形状；调用方按目标方法签名组织 payload（透明转调，不在 facade 重塑参数）。
 *
 * 【最高禁区（本批零改）】
 *   preset 全局 engine 单槽 / runtimeParams / macroMemory / _engineCache / getEngineFor 读写同实例传导链
 *   是 T4 去常驻批的靶点——本 facade 只做 verb→interface 转调，不碰 preset 的态管理，不注入 context 覆盖。
 *   INJ「注入提示词」跨 memory storage(DEFAULT_INJECTION_PROMPTS)+preset engine 深度+前端 injectionEditor，
 *   无独立文件——facade 不为它造 verb，靠 context 串联（设计 §二组2 标注）。
 *   ST 组装 SillyTavern/engine/{prompt_builder,world_info} 功能属 prompt 但 stCompat 不可动，不进本组。
 *
 * 【关联链】
 *   ← 各 part default（组内实现体；toggle 经 ../preset 动态 import 拿同一 preset 单例，engine 身份不变）
 *   ← ../../dispatch/registry.mjs register
 *   → prompt_struct（真实消费方，经 parts_loader，不经本 facade——facade 是 T5/T6 接线前的影子节点视图）
 *
 * 【影响范围】
 *   纯内存注册 + 转调，无独立 IO（IO 全在各 part 实现体，数据路径经 import.meta 锚回旧位）。
 *   T3a 批2 结论：新组 index.mjs 暂未被任何运行时 import（影子），接线在 T5/T6。
 */
import presetPart from "./preset/main.mjs";
import worldbookPart from "./worldbook/main.mjs";
import mvuPart from "./mvu/main.mjs";
import togglePart from "./toggle/main.mjs";
import sysinfoPart from "./sysinfo/main.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:prompt", {
	transport: "local",
	contributes: {
		// 操作流标签：mvu 解析变量命令、toggle <toggle> 翻转（真实标签在各 part ReplyHandler 内识别，此处声明归属）
		tags: ["toggle"],
		// INJ 跨组特性标注（无独立文件）：数据在 memory storage、深度在 preset engine、编辑在前端 injectionEditor
		crossGroup: ["inj: memory-storage + preset-engine-depth + frontend-injectionEditor"],
		// stCompat 不可动（功能属 prompt，物理不迁）
		stCompat: ["ImportHandlers/SillyTavern/engine/prompt_builder.mjs", "ImportHandlers/SillyTavern/engine/world_info.mjs"],
	},
	handlers: {
		// ---- preset（预设 CRUD/切换 + 司令员三轮）----
		async getData(payload, context) {
			// [T065 洞①修] context.user 盖章透传（前端 preset.mjs getPresetData 不带 username，靠桥 session）——
			//   预设内容池已 per-user，不透传则读 _default 桶=看不到自己的预设。同 setData:70 盖章范式。
			// [预设隔离 2026-07-11] charName 透传：GetData 解析 resolved 的线级模式记录在 per-char 桶，缺省 "_global"
			return { ok: true, data: await presetPart.interfaces.config.GetData(payload?.requestedPreset, context?.user || "", payload?.chatid, payload?.charName) };
		},
		async setData(payload, context) {
			// 换算面（桥身份收口，同 memory setData 模式）：context.user 存在=桥 session 盖章唯一权威，
			// 无条件合成 args——消费链 preset/main.mjs:1167 args?.username||data?.username||"_default"：
			// 不注入则桥线落 "_default" 错用户；不无条件盖则 data.username 自报生效=SEC-T1 同型越权洞。
			// 主链（runner）scope 无 user → 恒空操作零漂移。
			const _args = context?.user ? { ...payload?.args, username: context.user } : payload?.args;
			return { ok: true, data: await presetPart.interfaces.config.SetData(payload?.data, _args) };
		},
		// ---- runtime-params（A2 过桥，07-03）：REST /config/runtime-params 薄壳与本 verb 共用纯函数单源 ----
		async getRuntimeParams(payload, context) {
			// [P3 参数分母 2026-07-13] chatid/charName 透传（桥层注入，sendAction.mjs:283）→ per-chat 精确分母；
			//   缺省=旧 best-effort 行为（零回归）。
			const { buildRuntimeParamsView } = await import("./preset/main.mjs");
			return { ok: true, data: buildRuntimeParamsView(context?.user || "", { chatId: payload?.chatid || null, charName: payload?.charName || null }) };
		},
		async setRuntimeParams(payload, context) {
			// 身份换算面=标量参数（username 直传纯函数；桥 session 盖章=唯一权威，主链 scope 无 user 恒空串零漂移）
			const { applyRuntimeParams } = await import("./preset/main.mjs");
			return { ok: true, data: await applyRuntimeParams(payload ?? {}, context?.user || "") };
		},
		async getPrompt(payload, context) {
			// [T065 洞①修] 引擎 GetPrompt 按 arg.username 分桶取该 user 的预设。主链 shadowBuild 已在 args.username 盖章；
			//   此处对缺 username 的 arg 补 context.user（桥线/预览调用），缺失则引擎回退 _default 桶。不覆盖已有 arg.username。
			const _arg = (payload?.arg && !payload.arg.username && context?.user) ? { ...payload.arg, username: context.user } : payload?.arg;
			return { ok: true, data: presetPart.interfaces.chat.GetPrompt(_arg) };
		},
		async tweakPrompt(payload, context) {
			// [T065 洞①修] 同 getPrompt：TweakPrompt 三轮按 arg.username 分桶。补 context.user 到缺 username 的 arg。
			const _arg = (payload?.arg && !payload.arg.username && context?.user) ? { ...payload.arg, username: context.user } : payload?.arg;
			return { ok: true, data: await presetPart.interfaces.chat.TweakPrompt(_arg, payload?.prompt_struct, payload?.my_prompt, payload?.detail_level) };
		},
		// ---- worldbook（激活注入）----
		async worldInfo(payload, _context) {
			return { ok: true, data: worldbookPart.interfaces.chat.GetPrompt(payload?.arg) };
		},
		async wbTweakPrompt(payload, _context) {
			return { ok: true, data: worldbookPart.interfaces.chat.TweakPrompt(payload?.arg, payload?.prompt_struct, payload?.my_prompt, payload?.detail_level) };
		},
		async wbGetData(_payload, context) {
			// [T074 洞①修复] 透传桥 session 盖章 context.user → GetData 按用户隔离（原不传 → 读全局单例 → 新用户看到别人全部世界书）。
			return { ok: true, data: await worldbookPart.interfaces.config.GetData({ username: context?.user }) };
		},
		async wbSetData(payload, context) {
			// 换算面：ctx.username 被 dynamic 激活表格联动消费（worldbook/main.mjs:1150-1154
			// loadTablesForDynamic(ctx.username,…)），桥线不注入=该联动静默失效（条件短路）。盖章模式同上。
			const _ctx = context?.user ? { ...payload?.ctx, username: context.user } : payload?.ctx;
			return { ok: true, data: await worldbookPart.interfaces.config.SetData(payload?.data, _ctx) };
		},
		// ---- mvu（变量系统）----
		async mvuGetPrompt(payload, _context) {
			return { ok: true, data: await mvuPart.interfaces.chat.GetPrompt(payload?.arg) };
		},
		async mvuTweakPrompt(payload, _context) {
			return { ok: true, data: mvuPart.interfaces.chat.TweakPrompt(payload?.arg, payload?.prompt_struct, payload?.my_prompt, payload?.detail_level) };
		},
		async mvuReply(payload, _context) {
			return { ok: true, data: mvuPart.interfaces.chat.ReplyHandler(payload?.result, payload?.request) };
		},
		async mvuGetData(_payload, _context) {
			return { ok: true, data: await mvuPart.interfaces.config.GetData() };
		},
		async mvuSetData(payload, _context) {
			return { ok: true, data: await mvuPart.interfaces.config.SetData(payload?.data) };
		},
		// ---- toggle（条目开关）----
		async toggleGetPrompt(payload, _context) {
			return { ok: true, data: togglePart.interfaces.chat.GetPrompt(payload?.arg) };
		},
		async toggleReply(payload, context) {
			// [T065] toggle 持久到 per-user 预设：补 context.user 到 args.username（缺失时），供 applyToggle 分桶
			const _args = (payload?.args && !payload.args.username && context?.user) ? { ...payload.args, username: context.user } : payload?.args;
			return { ok: true, data: await togglePart.interfaces.chat.ReplyHandler(payload?.reply, _args) };
		},
		async toggleGetData(_payload, _context) {
			return { ok: true, data: await togglePart.interfaces.config.GetData() };
		},
		async toggleSetData(payload, context) {
			// [T065] context.user 盖章透传（manual_toggle 落 per-user 预设）
			return { ok: true, data: await togglePart.interfaces.config.SetData(payload?.data, context?.user ? { username: context.user } : undefined) };
		},
		// ---- sysinfo（env 上下文注入）----
		async sysinfoGetPrompt(payload, _context) {
			return { ok: true, data: await sysinfoPart.interfaces.chat.GetPrompt(payload?.arg) };
		},
		async sysinfoGetData(_payload, _context) {
			return { ok: true, data: await sysinfoPart.interfaces.config.GetData() };
		},
		async sysinfoSetData(payload, _context) {
			return { ok: true, data: await sysinfoPart.interfaces.config.SetData(payload?.data) };
		},
	},
});

/**
 * shadowBuild.mjs — 影子孪生组装器（T5 步骤4：影子逐字节 diff 的"新线"侧，零生产流量）
 *
 * 【功能链】
 *   buildPromptStructShadow(args)：逐字复刻 prompt_struct.mjs buildPromptStruct 的骨架与相位——
 *   ① 同一 result 骨架 ② world/user/char/other GetPrompt 直调（非模式层职责，与旧线同形）
 *   ③ 插件相：slot ∈ ModeDef 菜单 → dispatch({verb,target}) 经计算图的边到同一实现；
 *      slot ∉ 菜单（beilu-files/browser/plugin-host 等未迁插件）→ 直调 interfaces（与旧线同形）
 *   ④ Tweak 相 while(detail_level--)：每轮 世界/用户/角色/其他 直调 + 插件按菜/直调混合。
 *
 * 【why】
 *   影子等价的对照物 = 同一 args 下 buildPromptStruct 的产物。等价约束只在相位边界
 *   （GetPrompt 相并发各写各槽/Tweak 轮内并发——顺序化是合法线性化，diff 是最终裁判）。
 *   ⚠ 只可用 isFakeSend=true 的 args 重复调用（副作用注入 P1/问候/搜索会互污两遍产物）。
 *
 * 【影响范围】
 *   无人 import 则零影响；被调时副作用=各 part GetPrompt/TweakPrompt 自身（isFakeSend 面近零）。
 */
import { dispatch } from "../../core/dispatch/dispatcher.mjs";
import { getModeDef } from "./runner.mjs";
import { wbT } from "../../../server/wbStub.mjs"; // [0807 EJS 终步白盒] preset/worldbook 同款轻桩
// 影子自包含 bootstrap：facade 注册靠 import 副作用，影子期零流量=服务进程不 import 它们，
// 孪生必须自带依赖注册（否则 ModeDef 校验"未注册功能"必炸——沙盒第一跑实抓）。
import "../../core/functions/memory/index.mjs";
import "../../core/functions/prompt/index.mjs";

function getSinglePartPrompt() {
	return { text: [], additional_chat_log: [], extension: {} };
}

/** 与 buildPromptStruct(args, detail_level=3) 逐相位等价的孪生。mode 取 ModeDef 用。
 *  （T8 07-03 转正声明：本函数=生产正线实现体——下方 ViaModes 是其 mode 自解析包装，prompt_struct.buildPromptStruct 主链经它组装每一次生成。
 *   名字里的 shadow 是 T5 影子期历史命名；_t5shadow 对照端点与 Legacy 旧线已同批删除。） */
export async function buildPromptStructShadow(args, mode, detail_level = 3) {
	const { char_id, char, user, world, other_chars, plugins, chat_log, UserCharname, ReplyToCharname, Charname } = args;
	const def = getModeDef(mode);
	if (!def) throw new Error(`[shadowBuild] 无 ModeDef: ${mode}`);

	const result = {
		char_id,
		chatid: args?.extension?.activation?.chatid ?? args?.chatid,
		username: args.username,
		UserCharname, ReplyToCharname, Charname,
		char_prompt: getSinglePartPrompt(),
		user_prompt: getSinglePartPrompt(),
		other_chars_prompt: {},
		world_prompt: getSinglePartPrompt(),
		plugin_prompts: {},
		chat_log,
	};

	// ── section_headers 填充（2026-07-08 链路3·拼接骨架段标题用户可控）：
	//    per-char _config.json 的 section_headers 字段 → prompt_struct 携带 →
	//    structPromptToSingleNoChatLog 按键覆盖默认标题（空串=不输出该段标题行）。
	//    单点填充=7 个消费点（requestBuilder+6 generator）零改动；
	//    loadMemoryData 同轮 getPromptHandler 也调、memoryCache 命中=零额外 IO。
	//    读取失败=回退默认标题不阻断组装（console.error 保诊断面，同 _safeGetPrompt 降级风格）。
	try {
		const { loadMemoryData } = await import("../../core/functions/memory/storage_mod/storage.mjs");
		const _memData = loadMemoryData(args.username, char_id, null, args?.chatid ?? null);
		const _sh = _memData?.config?.section_headers;
		if (_sh && typeof _sh === "object" && !Array.isArray(_sh)) result.section_headers = _sh;
	} catch (e) {
		console.error(`[shadowBuild] section_headers 读取异常(回退默认标题): ${e?.message}`);
	}

	// ── GetPrompt 相：与旧线同构【并发发起 → 统一 await】（时延等价——P1 等耗时检索与其他插件重叠，
	//    顺序化会把并发变串行拖慢每轮生成；产物等价已由顺序版影子 diff 三模式零 diff 证过，
	//    并发结构=旧线本来的结构，产物不变）──
	const _safeGetPrompt = (part, label) => {
		try { return part.interfaces.chat.GetPrompt(args); }
		catch (e) { console.error(`[shadowBuild] ${label} GetPrompt 异常(降级跳过): ${e?.message}`); return null; }
	};
	if (world?.interfaces?.chat) result.world_prompt = _safeGetPrompt(world, "world");
	if (user?.interfaces?.chat) result.user_prompt = _safeGetPrompt(user, "user/persona");
	if (char?.interfaces?.chat) result.char_prompt = _safeGetPrompt(char, "char");
	for (const oc of Object.keys(other_chars ?? {})) {
		result.other_chars_prompt[oc] = other_chars[oc]?.interfaces?.chat?.GetPromptForOther?.(args);
	}

	// 插件相：菜单内 dispatch / 菜单外直调，全部并发发起（槽里先存 promise）
	const dishes = def.hooks.request.filter((s) => s.phase !== "tweak");
	const dishBySlot = new Map(dishes.map((s) => [s.slot, s]));
	const pluginNames = Object.keys(plugins ?? {}).filter((k) => plugins[k]);
	for (const name of pluginNames) {
		const dish = dishBySlot.get(name);
		if (dish && def.features?.[dish.feature]?.enabled !== false) {
			result.plugin_prompts[name] = dispatch({
				verb: dish.verb, target: dish.target, source: `pipeline:${mode}`,
				payload: { arg: args }, scope: { chatId: args?.chatid ?? null, mode },
			}).then((r) => {
				if (r.ok === false) throw new Error(`[shadowBuild] ${dish.target}.${dish.verb} 失败: ${r.error?.msg}`);
				return r.data;
			});
		} else {
			// 未迁插件（files/browser/plugin-host…）或菜单未覆盖：与旧线【完全同形】直调——
			// 旧线对插件无 try-catch 无 _safeAwait（:71-73/:86-87 异常外抛），此处不加降级（加了=吞错=行为漂移）
			result.plugin_prompts[name] = plugins[name]?.interfaces?.chat?.GetPrompt?.(args);
		}
	}

	// 统一 await（旧线 :80-87 同构：world/user/char 走 _safeAwait 降级，插件裸 await 异常外抛；
	// 菜单内 dispatch 失败=组装链断环 fail loud 外抛——与旧线"插件异常炸链"同语义）
	result.world_prompt = await _safeAwait(result.world_prompt, "world");
	result.user_prompt = await _safeAwait(result.user_prompt, "user/persona");
	result.char_prompt = await _safeAwait(result.char_prompt, "char");
	for (const oc of Object.keys(result.other_chars_prompt)) {
		result.other_chars_prompt[oc] = await result.other_chars_prompt[oc];
	}
	for (const name of Object.keys(result.plugin_prompts)) {
		result.plugin_prompts[name] = await result.plugin_prompts[name];
		// [0727 契约收口] plugin_prompts[name].text 契约=数组[{content,important}]，全部下游按数组消费
		//   （change-prompt main.mjs:179 的 .sort / structPromptToSingleNoChatLog / 六个 generator）。
		//   某插件把 text 给成字符串时，会在离产地很远的下游炸出 "plugin.sort is not a function"
		//   （0727 fake-send 实证），且报错里没有插件名=无法归因。本处是全部插件提示词的唯一装配落点，
		//   在这里归一 + 点名：字符串 → 单元素数组（自愈，语义等价）；其他非法类型 → 置空并点名
		//   （内容缺失可见地降级，不静默编造）。修根还是要修那个插件——点名日志就是修理单。
		const _pp = result.plugin_prompts[name];
		if (_pp && _pp.text != null && !Array.isArray(_pp.text)) {
			if (typeof _pp.text === "string") {
				console.warn(`[shadowBuild][契约] 插件 ${name} 的 GetPrompt 返回 text 是字符串（契约=数组[{content,important}]），已归一为单元素数组——请修该插件的返回形状`);
				_pp.text = [{ content: _pp.text, important: 0 }];
			} else {
				console.warn(`[shadowBuild][契约] 插件 ${name} 的 GetPrompt 返回 text 类型非法（${typeof _pp.text}），该插件提示词本轮置空——请修该插件的返回形状`);
				_pp.text = [];
			}
		}
		// 硬编码检测已移除（误杀 beilu-web/reach 的 getInjectText 合法内容）。
		// 防线改为 GetPrompt 函数体注释（12个插件已加铁律警告）+ 代码审查。
	}

	// user_prompt 兜底（旧线 :90-95 同语义）
	if (result.user_prompt.text.length === 0 && args.user_description) {
		result.user_prompt.text.push({ content: args.user_description, important: 5 });
	}

	// ── Tweak 相：与旧线 :97-133 同构【轮内 Promise.all 并发】，dl 递减轮 ──
	const tweakPhase = def.hooks.request.find((s) => s.phase === "tweak");
	const tweakBySlot = new Map((tweakPhase?.steps ?? []).map((s) => [s.slot, s]));
	while (detail_level--) {
		await Promise.all([
			world?.interfaces?.chat?.TweakPrompt?.(args, result, result.world_prompt, detail_level),
			user?.interfaces?.chat?.TweakPrompt?.(args, result, result.user_prompt, detail_level),
			char?.interfaces?.chat?.TweakPrompt?.(args, result, result.char_prompt, detail_level),
			...Object.keys(other_chars ?? {}).map((oc) =>
				other_chars[oc]?.interfaces?.chat?.TweakPromptForOther?.(args, result, result.other_chars_prompt[oc], detail_level),
			),
			...pluginNames.map((name) => {
				const step = tweakBySlot.get(name);
				if (step && def.features?.[step.feature]?.enabled !== false) {
					return dispatch({
						verb: step.verb, target: step.target, source: `pipeline:${mode}`,
						payload: { arg: args, prompt_struct: result, my_prompt: result.plugin_prompts[name], detail_level },
						scope: { chatId: args?.chatid ?? null, mode },
					}).then((r) => {
						if (r.ok === false) throw new Error(`[shadowBuild] ${step.target}.${step.verb}(dl=${detail_level}) 失败: ${r.error?.msg}`);
					});
				}
				return plugins[name]?.interfaces?.chat?.TweakPrompt?.(args, result, result.plugin_prompts[name], detail_level);
			}),
		]);
	}
	// ── [0807 EJS 司令员链修复] EJS 渲染串行终步 ──
	// why：EJS 依赖"全部内容已就位"（司令员四段在 dl=1 才产出），而轮内 Promise.all 并发使
	//   EJS(dl=0) 与 preset Round3 时序不可靠、且四段产出前的轮次恒扑空。终步在三轮全部落定后
	//   串行跑一次（EJS 内部 dl=0 才干活，签名同轮内直调）——零竞态、司令员/非司令员双正确；
	//   轮内三次直调保留（渲染后模板已无 '<%'，重复扫描幂等）。part 缺席 → facade 报 ok:false，
	//   只 warn 不阻断主链（"删了还能跑"）。fake-send 同链受益=提示词查看器同根因自动修。
	try {
		wbT(args?.chatid ?? null, "shadowBuild", "ejs_final:enter", { mode });
		const _ejsFinal = await dispatch({
			verb: "tweakPrompt", target: "functions:sandbox", source: `pipeline:${mode}`,
			payload: { arg: args, prompt_struct: result, my_prompt: result.plugin_prompts["beilu-ejs"], detail_level: 0 },
			scope: { chatId: args?.chatid ?? null, mode },
		});
		if (_ejsFinal?.ok === false) {
			// [0807 白盒] 缺席/失败可见：实测时"终步到底跑没跑"直接看 ejs_final:* 三态
			wbT(args?.chatid ?? null, "shadowBuild", "ejs_final:absent", { msg: _ejsFinal.error?.msg });
			console.warn(`[shadowBuild] EJS 终步缺席/失败(不阻断): ${_ejsFinal.error?.msg}`);
		} else {
			wbT(args?.chatid ?? null, "shadowBuild", "ejs_final:done", {});
		}
	} catch (e) {
		wbT(args?.chatid ?? null, "shadowBuild", "ejs_final:error", { msg: e?.message });
		console.warn(`[shadowBuild] EJS 终步异常(不阻断): ${e?.message}`);
	}
	return result;
}

/**
 * 切流量入口（T5 步骤5）：mode 自解析（resolveGenerationMode 单源，N38 语义），
 * 调用方把 buildPromptStruct(args) 换成本函数即切到 ModeDef+dispatch 线，签名不变。
 * 动态 import storage 防静态耦合（同 exits/dispatchActivation 跨 part 范式）。
 * [0715 双判定链收口] 原直调 getActiveMode（纯 config 读，不看 extension.platform）——bot 壳
 *   请求的 ModeDef 骨架随 web 端 active_mode 漂移（多为 chat.json），bot.json hooks 从不被
 *   消费，而 INJ 门控/preset 绑定已按 platform 判 bot=同一请求两套模式语义。改走
 *   resolveGenerationMode 后 A/B 链同源：bot 壳请求的编排骨架=bot.json。
 */
export async function buildPromptStructViaModes(args, detail_level = 3) {
	// [T1 激活层 2026-07-19] 激活备料优先：getChatRequest 入口已按同一单源（resolveGenerationMode）
	//   解析并冻结本条激活线的 mode（extension.activation），此处消费同一份——ModeDef 骨架与
	//   preset/INJ 判定链同源同值。注意此前 args.chatid 恒 undefined（载体只埋 chat_name 前缀），
	//   本函数实际恒按 char 级 active_mode 选 ModeDef=per-chat 模式绑定（N38）在编排层从不生效；
	//   载体补 chatid 后回退链也已 per-chat 正确。无 activation 的入口（bot 壳等）走回退链。
	if (args?.extension?.activation?.mode) return buildPromptStructShadow(args, args.extension.activation.mode, detail_level);
	const { resolveGenerationMode } = await import("../../core/functions/memory/storage_mod/storage.mjs");
	// [多窗口审计 2026-07-11 B6] 补 ||"_global" 兜底：全链读点（GetData/P1/switch_preset/getSubModes）
	//   均有该兜底，此处原是唯一例外——args.char_id undefined 时落空桶 chars/（非 _global），口径对齐。
	const mode = resolveGenerationMode(args, args.username, args.char_id || "_global", args?.chatid ?? null);
	return buildPromptStructShadow(args, mode, detail_level);
}

// 与旧线 _safeAwait(:76-79) 逐字同语义：async rejection → null（不回退空骨架——降级值是产物一部分）
async function _safeAwait(p, label) {
	try { return await p; }
	catch (e) { console.error(`[shadowBuild] ${label} GetPrompt async 异常(降级跳过): ${e?.message}`); return null; }
}

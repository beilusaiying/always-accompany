/**
 * scopeResolver.mjs — scope → 冻结 context（T1 骨架版：base 件；解析件随 T3d/T7 接入）
 *
 * 【功能链】
 *   dispatch(message) → resolveScope(message.scope) → 冻结 context（一个激活一份，跑完蒸发）
 *   → 节点 handlers[verb](payload, context) 读 context 不读全局（去常驻，设计⑤/05 请求态外置）。
 *
 * 【why】
 *   「scopeResolver 管用谁的数据」（0_总架构 §三三文件分工）。card→user→default 三级回退写死这一层，
 *   功能库不感知层级（契约④）。
 *   T1 阶段只做 base 件冻结（scope 字段原样进 context）——解析件（presetName/engineInstance/memoryDir）
 *   必须复用 beilu-preset/beilu-memory 现有函数（resolveActivePresetName / getEngineFor / ensureMemoryDir，
 *   0_总架构 §三注释"复用不重写"），而这些库 T3d/T3e 才迁入注册——提前 import 会把影子层静态耦合进
 *   未迁移的库，故留接入锚点（下方 TODO），T3d 批按 buildPresetContext(chatId,mode) 封装接入（裁决7）。
 *
 * 【关联链】
 *   ← core/dispatch/dispatcher.mjs（唯一调用方）
 *   → (T3d 接) plugins/beilu-preset buildPresetContext；(T7 接) resolvePath card→user→default
 *
 * 【影响范围】
 *   纯函数，无副作用。context 为浅冻结——scope 内嵌对象由调用方保证不可变（一个激活一份）。
 */

/**
 * message.scope → 冻结 context。
 * @param {object} [scope] - { user, card, chatId, mode, presetName?, subModeId?, taskId?, filePath? }（契约④）
 * @returns {Promise<Readonly<object>>}
 */
export async function resolveScope(scope) {
	// T1：base 件 = scope 字段原样。
	// TODO(T3d)：presetName ?? buildPresetContext(chatId,mode)（beilu-preset 封装，不 export 私有函数）；
	// TODO(T3e)：memoryDir = ensureMemoryDir(user, card)（storage.mjs:1260）；
	// ✅ runtimeParamsSnapshot 两步装配已落（07-03，设计②§3.4）——不经本层：激活载体=chatReplyRequest_t，
	//   第1步 requestBuilder.getChatRequest 入口拍冻结快照挂 extension.runtime_params_snapshot（惰性桥接 preset.snapshotRuntimeParams），
	//   第2步 preset TweakPrompt Round2 因子 ext 齐后 mergeRuntimeParams 纯函数从快照算出站参数。
	//   dispatch 线的 prompt verbs 经 payload.arg 传导同一载体，context 无需单独装配。
	return Object.freeze({ ...(scope || {}) });
}

/**
 * 数据路径三级回退（card→user→default，命中即止）——唯一权威（T7 实装，设计④§二伪代码照抄）。
 *
 * 【功能链】resolvePath(dataType, ctx{user,char,chatId,mode,presetName}) → 候选路径序列
 *   card 级（getMemoryDir confinePath 防穿越 SEC-T2 保留）→ user 级 → default 级 → 命中即止；
 *   全空 → null（该 dataType 对本次激活无数据——不造防御 fallback，凛倾 05-31）。
 * 【边界（设计④§四）】worldbook/INJ/regex/preset 属「全局共享+运行时选择」不进三级回退——
 *   本函数不收它们（preset 解析走 beilu-preset buildPresetContext，裁决7）。
 *   tables 的 per-chatId ctx 优先于卡级 = 已落地机制照抄（getModeCtxDir + getCacheKey #mode@chatId）。
 * 【复用不重写】getMemoryDir/getModeCtxDir/getTablesFileName/getUserDataDir 全部 import memory 组实现。
 */
import fs from "node:fs";
import path from "node:path";
import {
	getMemoryDir,
	getModeCtxDir,
	getTablesFileName,
	getUserDataDir,
	getYonbanConfigPath,
	getEyeConfigPath,
	getCommandConfigPath,
	getGameCompanionConfigPath,
	getWebhooksPath,
	getCloneResumeDir,
	getWorkConfigPath,
	getCodeConfigPath,
	getScreenshotsDir,
	getGcCaptureRequestPath,
} from "../functions/memory/storage_mod/storage.mjs";

export function resolvePath(dataType, ctx) {
	const { user, char, chatId, mode } = ctx ?? {};
	const cand = [];
	const memDir = () => getMemoryDir(user, char); // 惰性：user 级 dataType 不需要 char

	switch (dataType) {
		// ── card 级 ──
		case "tables": {
			const md = memDir();
			cand.push(path.join(getModeCtxDir(md, mode, chatId), getTablesFileName(mode))); // {mode}_ctx/<chatId>/ 优先
			cand.push(path.join(md, getTablesFileName(mode)));                              // 卡级回退
			break;
		}
		case "chat":
			cand.push(path.join(getUserDataDir(user), "chars", String(char ?? ""), "chats", `${chatId}.json`));
			break;
		case "memoryHot":  cand.push(path.join(memDir(), "hot")); break;
		case "memoryWarm": cand.push(path.join(memDir(), "warm")); break;
		case "memoryCold": cand.push(path.join(memDir(), "cold")); break;
		case "cardConfig": cand.push(path.join(memDir(), "_config.json")); break;
		case "workConfig": cand.push(getWorkConfigPath(user, char)); break; // 卡级 work 模式配置（T7 尾段收口，读写单点 storage.getWorkConfigPath）
		case "codeConfig": cand.push(getCodeConfigPath(user, char)); break; // 卡级 code 模式配置（T7 尾段收口，读写单点 storage.getCodeConfigPath）
		// ── user 级 ──
		case "apiSource":  cand.push(path.join(getUserDataDir(user), "serviceSources", "AI")); break;
		case "persona":    cand.push(path.join(getUserDataDir(user), "personas")); break;
		case "userMemory": cand.push(path.join(getUserDataDir(user), "memory")); break;
		case "presetList": cand.push(path.join(getMemoryDir(user, "_global"), "_memory_presets")); cand.push(path.join(getMemoryDir(user, "_global"), "_memory_presets.json")); break; // chars/_global=user 级共享桶（裁决13）; [0717 store v2] directory store first, legacy single file as fallback for un-migrated data
		case "settings":   cand.push(path.join(getUserDataDir(user), "settings")); break;
		case "yonbanConfig": cand.push(getYonbanConfigPath(user)); break; // 用户级运行态配置单文件（T7 收口：读写单点在 storage.getYonbanConfigPath，此处登记进路径权威线路）
		case "eyeConfig": cand.push(getEyeConfigPath(user)); break; // 用户级截图安全配置（T7 批2 收口，读写单点 storage.getEyeConfigPath）
		case "commandConfig": cand.push(getCommandConfigPath(user)); break; // 用户级命令白名单能力授权（T7 批2 收口，读写单点 storage.getCommandConfigPath）
		case "gameCompanionConfig": cand.push(getGameCompanionConfigPath(user)); break; // 用户级游戏陪伴配置（T7 批2 收口，读写单点 storage.getGameCompanionConfigPath）
		case "webhooks": cand.push(getWebhooksPath(user)); break; // 用户级 webhook 注册表（T7 批2 收口，读写单点 storage.getWebhooksPath）
		case "cloneResume": cand.push(getCloneResumeDir(user)); break; // 用户级分身续接上下文目录（T7 批2 收口，读写单点 storage.getCloneResumeDir）
		case "screenshots": cand.push(getScreenshotsDir(user)); break; // 用户级截图归档目录（T7 尾段收口，读写单点 storage.getScreenshotsDir）
		case "gcCaptureRequest": cand.push(getGcCaptureRequestPath(user)); break; // 用户级游戏陪伴截图请求标记（T7 尾段收口，读写删三端单点 storage.getGcCaptureRequestPath）
		default:
			// 未登记的 dataType = 调用方用错分类，fail loud 不静默（防「未知类型悄悄返回 null」掩盖接线错误）
			throw new Error(`resolvePath: 未登记的 dataType "${dataType}"（全局共享类 worldbook/INJ/regex/preset 不走三级回退，见设计④§四）`);
	}

	for (const p of cand) if (fs.existsSync(p)) return p;
	return null; // 全空=无数据（命中即止语义；调用方自行决定建目录/铺底）
}

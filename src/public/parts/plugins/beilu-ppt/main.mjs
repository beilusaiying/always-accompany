/**
 * [beilu-ppt] — 字符画 PPT 管线（ppt_ascii_pipeline）的本体侧原生插件桥。
 * 不管 spec 内容质量（那是 AI/预设的事），不管布局几何（那是管线 solver 的事），
 * 不做提示词内容（指令说明文案走 injectTexts CATALOG，用户可配置——凛倾预设域）。
 *
 * 链路：
 *   注入路: GetPrompt → work/code 模式门控 → fillInjectText("ppt.usage") 指令说明
 *     + extension.macro_env（{{ppt_usage}}/{{ppt_out_root}}/{{ppt_last_deck}} 宏，
 *     经 beilu-preset Round1 通用 macro_env 通路进宏环境，供预设取用）
 *   执行路: AI 回复 <ppt_op ...>{spec JSON}</ppt_op> → ReplyHandler 解析 →
 *     deployGatedAllow 闸 → spec 落盘 outDir/spec.json → Deno.Command 起 python
 *     跑 pipeline.run()（固定 runner 代码，argv 直传不走 shell）→ 解析 JSON 结果 →
 *     ideClient.enqueuePendingResult（[0717 范式迁移] IDE 范式：结果入池 → generation
 *     回合末落盘 system 条+scheduleAutoContinue 续轮，继承熔断/开关/压缩保护）→ return false；
 *     AI 在续轮按预览与信号（字符画/signals/产物路径）决定改 spec 重生成或交付
 *
 * 影响：磁盘写（spec.json + 管线产物落 outRoot）；Deno.Command 起 python 子进程
 * 相交：→ yonban/injectTexts (ppt.usage / ppt.result_instruction 键)
 *       → yonban/prompt/preset main.mjs Round1 (消费 extension.macro_env → 宏)
 *       → yonban/security/path_confine (deployGatedAllow: local 恒放行，
 *         server 需 owner config.allowPptPipeline=true / env BEILU_PPT_PIPELINE=on
 *         ——pipelineDir/pythonCmd 经 setdata 可被登录用户改，生效必须过此闸，
 *         范式同 beilu-files allowFileExec)
 *       → yonban/memory/storage_mod/storage.mjs getActiveMode (work/code 门控)
 *       ← 管线本体已内置 ./pipeline/（发布形态零本地依赖：字体/Chrome/素材库经 env 配置或探测，
 *         缺失优雅降级，见 pipeline/README.md；pipelineDir 默认指内置目录，可覆盖为外部目录），
 *         契约=pipeline.run(spec_path, out_dir, animate) → {layout,ascii,pngs,pptx,signals,resolve_log}
 *
 * 设置持久化：data/beilu-ppt-settings.json（CWD 锚，范式同 beilu-sysinfo PERSIST_FILE）
 */
import info from "./info.json" with { type: "json" };
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createDiag } from "../../../../server/diagLogger.mjs";
// [0717 范式迁移] 工具结果入 ideClient.pendingResults 池(IDE 范式),废弃 AddLongTimeLog+regen
import { ideClient } from "../../../../yonban/core/transport/ideClient.mjs";
import { getAmbientChatId } from "../../../../server/whitebox.mjs";
import { getInjectText, fillInjectText } from "../../../../yonban/core/functions/injectTexts/main.mjs";
import { getActiveMode, withFileLock } from "../../../../yonban/core/functions/memory/storage_mod/storage.mjs";
import { deployGatedAllow } from "../../../../yonban/core/functions/security/path_confine.mjs";

const diag = createDiag("ppt");

// ============================================================
// 设置（缺失=默认；pipelineDir 空 = 插件休眠，诚实降级不猜路径）
// ============================================================
const PERSIST_FILE = "data/beilu-ppt-settings.json";
// 管线已内置于插件目录（pipeline/，发布形态零本地依赖：素材/Chrome/字体经 env 配置或探测，缺失优雅降级）。
// 默认指向内置目录=开箱即用；用户设置可覆盖（外挂管线目录），显式置空=休眠。
const BUILTIN_PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "pipeline");
const DEFAULTS = {
	pipelineDir: BUILTIN_PIPELINE_DIR, // 内置管线目录（含 pipeline.py）；可覆盖为外部目录，置空=休眠
	pythonCmd: "",        // 空=自动（windows→python，其他→python3）
	outRoot: "",          // 空=<pipelineDir>/works/beilu_decks
	// [0718 归一 INJ·凛倾"把 ppt usage 删除,我们已经有 inj"] injectUsage/usageDepth/usageOrder 三键退役：
	// GetPrompt text 自动注入线已删——<ppt_system> 教学唯一入口=INJ-work-ppt/INJ-code-ppt 条目内挂
	// {{ppt_usage}} 宏（macro_env→preset env→INJ macro:true 二次求宏展开），开关/深度/排序全在 INJ 面板。
	maxAsciiChars: 20000, // 回喂字符画预览上限（超出截断，防撑爆上下文）
	timeoutMs: 300000,    // 管线子进程超时
	attachPngLimit: 12,   // 挂到回复气泡的 PNG 预览页数上限（pptx 恒附）
	// [0718 防循环] 连续无用户输入的 ppt_op 执行预算：自最后一条 user 消息起累计工具结果条数,
	// 达上限=本轮 op 不执行+停止自动继续(强制停点等用户)。0=关闭防御。
	// 背景: 凛倾实测五步工作流 AI 收回喂即自动推进 outline→draft→generate 不停等审查,
	// 续轮机制放大成循环——"呈用户审查停下等意见"是提示词引导, 熔断必须是系统机制(执行域铁律)。
	maxOpsPerUserTurn: 4,
	// v1.5 可选素材库（本地目录，缺省空=管线读系统 env / 无库优雅降级占位框）——
	// 设置值经子进程 env 传导（BEILU_PPT_UNDRAW/TABLER/PATTERNS/CHROME），管线侧契约单源不变
	assetUndrawDir: "",   // unDraw 插画 SVG 目录（image query 检索源）
	assetTablerDir: "",   // Tabler 图标 SVG 目录（image style="icon" 检索源）
	assetPatternsDir: "", // hero-patterns 背景纹理 SVG 目录
	chromePath: "",       // Chrome/Chromium 可执行文件（SVG→PNG 截图渲染；空=管线自动探测）
	// v1.9 主题覆盖层（凛倾0717"预设不硬编码,可编辑"）：JSON {"presets":{},"style_packs":{}}
	// 同名覆盖内置/新名扩展；空=自动探测 data/beilu-ppt-themes.json（存在才传导）
	themesFile: "",
	fetchImageKeepN: 4,   // v2.4 联网候选图防膨胀: 保留最近 N 条候选图轮的附件(0=不修剪)
};
// 数字键值域声明表（SetData 通道唯一消费, 通道零键名特判）：未列出=下限 1（旧 n>0 语义）。
// order 全区语义可为负、depth 0=below 区、attach/keepN/预算 0=关闭——值域由表声明, 加键只扩表。
const NUM_MIN = { attachPngLimit: 0, fetchImageKeepN: 0, maxOpsPerUserTurn: 0 };
let settings = { ...DEFAULTS };

function loadSettings() {
	try {
		const j = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf-8"));
		if (j && typeof j === "object") settings = { ...DEFAULTS, ...j };
	} catch { /* 缺失/损坏=默认，SetData 时重建 */ }
}
function saveSettings() {
	try {
		fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
		fs.writeFileSync(PERSIST_FILE, JSON.stringify(settings, null, 2));
	} catch (e) {
		diag.warn("设置落盘失败:", e && e.message);
	}
}
loadSettings();

/** 最近一次生成结果（宏 {{ppt_last_deck}} 消费） */
let lastResult = null; // { deck, outDir, time }

// ============================================================
// 模式门控：仅 work / code（=ide）模式生效
// ============================================================
// 注：INJ 的 autoMode="file" 不是独立后端模式，是 code 的推导态
// （injectionSystem.mjs filesActiveMode = activeMode==="code" ? "file" : "chat"）——
// 文件层场景 getActiveMode 返回 "code"，本门控天然覆盖，勿往 Set 加 "file"（死值，B 通道值域无此值）。
const ENABLED_MODES = new Set(["work", "code"]);

function resolveMode(arg) {
	const username = arg?.username || arg?.prompt_struct?.username || "";
	const charName = arg?.char_id || "_global";
	const cid = arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null;
	try {
		return getActiveMode(username, charName, cid);
	} catch (e) {
		diag.warn("getActiveMode 失败，按 chat 处理:", e && e.message);
		return "chat";
	}
}

// ============================================================
// <ppt_op> 指令解析
// ============================================================
// 双形式：<ppt_op ...>body</ppt_op> 与自闭合 <ppt_op ... />（list/load 无 body，范式同 beilu-files:172）
// [0717 吞噬事故] body 捕获加 (?!<ppt_op\b) 负向前瞻取最内层：AI 正文提及 `<ppt_op>` 字样
//   （散文句"通过 <ppt_op> 标签…"）曾被当开标签，body 吞成散文+真实 spec 整段，
//   JSON.parse 报 Unexpected token '`'——前瞻保证 body 不跨下一个开标签，散文起点配不出闭合即失配，
//   引擎自动前移到真实指令块。展示态剥离侧（replyHandler._stripAllTags）同款前瞻，两侧语义一致。
const PPT_OP_REGEX = /<ppt_op\b([^>]*?)(?:\/\s*>|>((?:(?!<ppt_op\b)[\s\S])*?)<\/ppt_op>)/gi;
const ATTR_REGEX = /(\w+)\s*=\s*"([^"]*)"/g;
const MAX_OPS_PER_REPLY = 3;

/** body 容错：AI 把 spec 包进 ```json 围栏时剥壳（围栏是 markdown 习惯高频错，剥后仍走严格 JSON.parse） */
function stripCodeFence(s) {
	let t = String(s || "").trim();
	if (t.startsWith("```")) {
		t = t.replace(/^```[\w-]*[ \t]*\r?\n?/, "").replace(/\r?\n?[ \t]*```$/, "").trim();
	}
	return t;
}

// ============================================================
// spec JSON 符号容错修复链（v1.7）
// ============================================================
// 严格 parse 失败才进；每步确定性重写+重试，命中项回喂给 AI 自纠（ppt.repair_note）。
// 字符串感知扫描（非全局 replace）：全角逗号/冒号只在字符串外归一，
// 内容文字里的中文标点绝不动（全局替换=改写用户内容，禁）。
const FW_STRUCT = { "，": ",", "：": ":", "；": ",", "｛": "{", "｝": "}", "［": "[", "］": "]", "　": " " };

/** 字符串感知重写：智能/单引号定界归一、串内裸双引号转义、串外全角结构符归一、注释剔除 */
function _rewriteJsonish(input, applied) {
	let out = "", i = 0, inStr = false, delim = '"';
	const n = input.length;
	while (i < n) {
		const c = input[i];
		if (inStr) {
			if (c === "\\" && i + 1 < n) { out += c + input[i + 1]; i += 2; continue; }
			if ((delim === '"' && c === '"') || (delim === "'" && c === "'")
				|| (delim === "\u201c" && (c === "\u201d" || c === "\u201c"))
				|| (delim === "\u2018" && (c === "\u2019" || c === "\u2018"))) {
				if (delim !== '"') applied.add("引号定界归一");
				out += '"'; inStr = false; i++; continue;
			}
			if (c === '"') { out += '\\"'; applied.add("串内引号转义"); i++; continue; }
			out += c; i++; continue;
		}
		if (c === '"' || c === "'" || c === "\u201c" || c === "\u2018") {
			if (c !== '"') applied.add("引号定界归一");
			inStr = true; delim = c; out += '"'; i++; continue;
		}
		if (FW_STRUCT[c]) { out += FW_STRUCT[c]; applied.add("全角结构符号"); i++; continue; }
		if (c === "/" && input[i + 1] === "/") { applied.add("注释剔除"); while (i < n && input[i] !== "\n") i++; continue; }
		if (c === "/" && input[i + 1] === "*") {
			applied.add("注释剔除"); i += 2;
			while (i + 1 < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i += 2; continue;
		}
		out += c; i++;
	}
	return out;
}

/** 尾逗号剔除（重写后引号已标准化，仍按字符串感知扫） */
function _stripTrailingCommas(input, applied) {
	let out = "", i = 0, inStr = false;
	const n = input.length;
	while (i < n) {
		const c = input[i];
		if (inStr) {
			if (c === "\\" && i + 1 < n) { out += c + input[i + 1]; i += 2; continue; }
			if (c === '"') inStr = false;
			out += c; i++; continue;
		}
		if (c === '"') { inStr = true; out += c; i++; continue; }
		if (c === ",") {
			let j = i + 1;
			while (j < n && /\s/.test(input[j])) j++;
			if (j < n && (input[j] === "}" || input[j] === "]")) { applied.add("尾逗号剔除"); i++; continue; }
		}
		out += c; i++;
	}
	return out;
}

/** 截断闭合：串未闭合补引号、按栈补 ]/}, 仍失败回退到上一个值边界重试（输出被截断的兜底） */
function _closeTruncated(input, applied) {
	let s = input;
	for (let attempt = 0; attempt < 30; attempt++) {
		let inStr = false, lastBoundary = -1;
		const stack = [];
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (inStr) {
				if (c === "\\") { i++; continue; }
				if (c === '"') { inStr = false; lastBoundary = i + 1; }
				continue;
			}
			if (c === '"') { inStr = true; continue; }
			if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); lastBoundary = i + 1; }
			else if (c === "}" || c === "]") { stack.pop(); lastBoundary = i + 1; }
			else if (c === ",") lastBoundary = i;
		}
		let cand = s + (inStr ? '"' : "");
		for (let k = stack.length - 1; k >= 0; k--) cand += stack[k];
		cand = _stripTrailingCommas(cand, new Set());
		try {
			const v = JSON.parse(cand);
			if (attempt > 0 || inStr || stack.length) applied.add("截断补闭合");
			return v;
		} catch { /* 回退到上一个值边界再试 */ }
		if (lastBoundary <= 0 || lastBoundary >= s.length + 1) return null;
		s = s.slice(0, lastBoundary === s.length ? lastBoundary - 1 : lastBoundary);
	}
	return null;
}

/** 修复链入口：返回 { spec|null, applied[] }。严格 parse 可过的不进这里。 */
function repairSpecJson(raw) {
	const applied = new Set();
	if (typeof raw !== "string" || raw.length > 512 * 1024) return { spec: null, applied: [] };
	let s = _rewriteJsonish(raw, applied);
	s = _stripTrailingCommas(s, applied);
	try { return { spec: JSON.parse(s), applied: [...applied] }; } catch { /* 继续 */ }
	// 夹带文字抠 JSON（参考 PPTAgent utils.py:258 范式）：取首 { 到末 } 最大区间重试
	const a = s.indexOf("{"), z = s.lastIndexOf("}");
	if (a >= 0 && z > a && (a > 0 || z < s.length - 1)) {
		applied.add("夹带文字剥离");
		s = s.slice(a, z + 1);
		try { return { spec: JSON.parse(s), applied: [...applied] }; } catch { /* 进截断闭合 */ }
	}
	const v = _closeTruncated(s, applied);
	return { spec: v, applied: [...applied] };
}

function parsePptOps(text) {
	const ops = [];
	PPT_OP_REGEX.lastIndex = 0;
	let m;
	while ((m = PPT_OP_REGEX.exec(text)) !== null) {
		const attrs = {};
		ATTR_REGEX.lastIndex = 0;
		let a;
		while ((a = ATTR_REGEX.exec(m[1])) !== null) attrs[a[1]] = a[2];
		const body = stripCodeFence(m[2] || "");
		// 散文提及判别：无任何属性 且 body 不以 JSON 开头（{/[）＝正文里提到标签名，不是指令。
		// 真实指令恒有 action/name 属性（提示词约定），或裸标签直含 spec JSON——两者都不落此分支。
		if (Object.keys(attrs).length === 0 && !/^[\[{]/.test(body)) continue;
		ops.push({
			fullMatch: m[0],
			action: attrs.action || "generate",
			name: attrs.name || "",
			// v2.3: 值域校验单源在管线 animate.MODES（未知→fade+信号回喂）, JS 只做字符清洗防注入
			animate: attrs.animate ? (String(attrs.animate).toLowerCase().replace(/[^\w-]/g, "").slice(0, 20) || null) : null,
			// v3 阶段2: page 单页 op 属性
			page: attrs.page || "",
			// v2.4 datafit/fetch_image 属性透传（存在性/闸/值域在各执行函数校验）
			file: attrs.file || "",
			sample: attrs.sample || "",
			full: attrs.full || "",
			url: attrs.url || "",
			query: attrs.query || "",
			body,
		});
	}
	return ops.slice(0, MAX_OPS_PER_REPLY);
}

// ============================================================
// [0718 防循环防御] 两道域内机制闸（chatLog 铁证: 条22 outline→24 draft→26 generate
// 全程零用户介入, AI 把"呈用户审查"在 taskPlan 自打勾后连发——引导拦不住, 机制才是防御）
// ============================================================
/** 自最后一条 user 消息起, 可见 chat_log 中 ppt_op 工具结果条数（ideToolEvents 结构化判定优先, 字面兜底） */
function countPptOpsSinceUser(chatLog) {
	let n = 0;
	const list = Array.isArray(chatLog) ? chatLog : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const e = list[i];
		if (e?.role === "user") break;
		const evs = e?.extension?.ideToolEvents;
		if (Array.isArray(evs)) n += evs.filter((t) => t?.tool === "ppt_op").length;
		else if (e?.extension?._opType === "ide_tool_result" && String(e?.content || "").includes("--- ppt_op")) n++;
	}
	return n;
}

/** 重复 op 拒绝的适用面：有 body 的确定性执行类（同 body 重跑=同产物；fetch_image 检索有随机性、list/load 只读，不拒） */
const DUP_GUARD_ACTIONS = new Set(["generate", "draft", "outline", "page", "edit", "datafit"]);
/** chatid → 上一条成功执行的 op 签名（进程内; 失败不记=允许对超时/文件锁类非确定错误原样重试一次） */
const _lastOpSig = new Map();
const _opSig = (op) => `${op.action}|${op.name}|${op.page}|${op.full}|${op.body}`;

/** deck 名清洗：只留字母数字下划线连字符与 CJK，防路径逃逸；空 → 时间戳名 */
function sanitizeDeckName(name) {
	const clean = String(name || "").replace(/[^\w\u4e00-\u9fff-]/g, "").slice(0, 40);
	return clean || "deck_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

function resolveOutRoot() {
	return settings.outRoot || (settings.pipelineDir ? path.join(settings.pipelineDir, "works", "beilu_decks") : "");
}

// ============================================================
// 管线执行（固定 runner 代码 + argv 直传，无 shell；结果走标记行防管线内部 print 污染）
// ============================================================
const RESULT_MARKER = "@@BEILU_PPT_RESULT@@";
const RUNNER_CODE = [
	"import json, sys",
	"sys.path.insert(0, sys.argv[1])",
	"import pipeline",
	"animate = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None",
	"draft = len(sys.argv) > 5 and sys.argv[5] == 'draft'",
	"res = pipeline.run(sys.argv[2], out_dir=sys.argv[3], animate=animate, draft=draft)",
	`print(${JSON.stringify(RESULT_MARKER)})`,
	"print(json.dumps(res, ensure_ascii=False))",
].join("\n");

async function runPipeline(op) {
	// ① 配置与文件存在性（诚实降级：值缺失=明说，不猜）
	if (!settings.pipelineDir) throw new Error("管线目录未配置（beilu-ppt settings.pipelineDir 为空）");
	if (!fs.existsSync(path.join(settings.pipelineDir, "pipeline.py")))
		throw new Error(`管线目录无 pipeline.py: ${settings.pipelineDir}`);

	// ② 执行闸（server 多用户下 pipelineDir/pythonCmd 可被 setdata 改，生效必须过 owner 闸）
	if (!deployGatedAllow("allowPptPipeline", "BEILU_PPT_PIPELINE"))
		throw new Error("PPT 管线执行未获授权（server 部署需 owner 开启 allowPptPipeline 或 env BEILU_PPT_PIPELINE=on）");

	// ③ spec 校验落盘（v1.7: 严格 parse 失败 → 符号容错修复链，修复项回喂 AI 自纠）
	let spec;
	let specRepairs = [];
	try {
		spec = JSON.parse(op.body);
	} catch (e) {
		const r = repairSpecJson(op.body);
		if (!r.spec)
			throw new Error(`spec JSON 解析失败: ${e.message}（容错修复链已尝试${r.applied.length ? "：" + r.applied.join("/") : ""}，仍无法解析）`);
		spec = r.spec;
		specRepairs = r.applied;
		diag.log("spec 容错修复命中:", specRepairs.join("/"));
	}
	if (!Array.isArray(spec?.slides) || spec.slides.length === 0)
		throw new Error("spec 缺少非空 slides 数组");

	const deckName = sanitizeDeckName(op.name);
	const outDir = path.join(resolveOutRoot(), deckName);
	fs.mkdirSync(outDir, { recursive: true });
	const specPath = path.join(outDir, "spec.json");
	fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

	// ④ 起 python（-X utf8 强制 UTF-8 模式，CJK 路径/输出双保险）
	const pythonCmd = settings.pythonCmd || (Deno.build.os === "windows" ? "python" : "python3");
	// v1.5: 素材库设置经 env 传导给管线（Deno env 与父进程合并；设置为空=不覆盖系统 env）
	const env = { PYTHONIOENCODING: "utf-8" };
	if (settings.assetUndrawDir) env.BEILU_PPT_UNDRAW = settings.assetUndrawDir;
	if (settings.assetTablerDir) env.BEILU_PPT_TABLER = settings.assetTablerDir;
	if (settings.assetPatternsDir) env.BEILU_PPT_PATTERNS = settings.assetPatternsDir;
	if (settings.chromePath) env.BEILU_PPT_CHROME = settings.chromePath;
	// v1.9: 主题覆盖层路径传导（themes.load_overlay 消费；文件不存在=不传, 管线退内置默认）
	const _themesFile = settings.themesFile || "data/beilu-ppt-themes.json";
	if (fs.existsSync(_themesFile)) env.BEILU_PPT_THEMES = path.resolve(_themesFile);
	const child = new Deno.Command(pythonCmd, {
		args: ["-X", "utf8", "-c", RUNNER_CODE, settings.pipelineDir, specPath, outDir, op.animate || "", op.action === "draft" ? "draft" : ""],
		cwd: settings.pipelineDir,
		stdout: "piped",
		stderr: "piped",
		env,
	}).spawn();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { child.kill(); } catch { /* 已退出 */ }
	}, settings.timeoutMs);
	const output = await child.output();
	clearTimeout(timer);

	const stdout = new TextDecoder().decode(output.stdout);
	const stderr = new TextDecoder().decode(output.stderr);
	if (timedOut) throw new Error(`管线超时（${settings.timeoutMs}ms）被终止`);
	const markerAt = stdout.lastIndexOf(RESULT_MARKER);
	if (output.code !== 0 || markerAt < 0)
		throw new Error(`管线退出码 ${output.code}，无结果标记。stderr 尾部:\n${stderr.slice(-2000)}`);

	const res = JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length).trim());

	// ⑤ 读字符画预览（回喂主体）
	let asciiText = "";
	try {
		asciiText = fs.readFileSync(res.ascii, "utf-8");
	} catch (e) {
		asciiText = `(字符画预览读取失败: ${e.message})`;
	}
	if (asciiText.length > settings.maxAsciiChars)
		asciiText = asciiText.slice(0, settings.maxAsciiChars) + `\n…(截断，完整预览: ${res.ascii})`;

	lastResult = { deck: res.pptx, outDir, time: Date.now() };

	// v2.0 阶段状态持久化（流程图状态机: draft=待用户审查 / final=已产成品; load/list 回读,
	// 旧 deck 回炉链=load → draft 重审 → generate 同名覆盖）
	try {
		fs.writeFileSync(path.join(outDir, "stage.json"),
			JSON.stringify({ stage: res.draft ? "draft" : "final", time: new Date().toISOString() }));
	} catch (e) { diag.warn("stage.json 落盘失败（不阻断）:", e && e.message); }

	// ⑥ 用户侧附件（显示/导出链）：PNG 预览 + pptx 挂到最终回复气泡 reply.files——
	//   前端 renderAttachmentPreview 内联渲染图片(点击放大)/其他 mime 给下载按钮(fileHandling.mjs:140)，
	//   保存时 chatLogEntry_t.toData 自动 Buffer→addfile→"file:<hash>" 落 hash 仓(models.mjs:225)，
	//   API 侧只嵌最后一条 user 的图片(imageInjection.mjs pickLastUserImages)——回复附件零 token 复发成本。
	//   附件读取失败不阻断：text 里已有磁盘路径，用户仍可自取。
	const attachments = [];
	try {
		for (const p of (res.pngs || []).slice(0, settings.attachPngLimit)) {
			attachments.push({
				name: `${deckName}_${path.basename(p)}`,
				mime_type: "image/png",
				buffer: fs.readFileSync(p),
				description: `PPT 页面预览（${deckName}）`,
			});
		}
		if (res.pptx && fs.existsSync(res.pptx)) {
			attachments.push({
				name: `${deckName}.pptx`,
				mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
				buffer: fs.readFileSync(res.pptx),
				description: `生成的 PPT（${deckName}）`,
			});
		}
		// v2.5 参数图互动 HTML 附件（浏览器打开即玩; pptx 内原生 chart 不受影响）
		for (const p of (res.interactive_charts || [])) {
			attachments.push({
				name: `${deckName}_${path.basename(p)}`,
				mime_type: "text/html",
				buffer: fs.readFileSync(p),
				description: `互动参数图（${deckName}, 浏览器打开）`,
			});
		}
	} catch (e) {
		diag.warn("附件读取失败（不阻断，text 含路径）:", e && e.message);
	}

	// [PPT 生成结果/草稿] 包裹与字段标签=结构标注留代码（beilu-files 同判例）；引导句走 injectTexts
	const signalsText = res.signals && res.signals.length ? JSON.stringify(res.signals) : "无";
	const text = (res.draft ? [
		// v2.0 草稿态: 纯结构标注（流程语义如"给用户审查"是提示词职责——凛倾0717,
		// 引导全在 ppt.draft_instruction/usage 工作流段, 系统只报事实）
		`[PPT 草稿] deck=${deckName} 阶段=draft`,
		`signals: ${signalsText}`,
		specRepairs.length ? `spec 容错修复: ${specRepairs.join("/")}\n${getInjectText("ppt.repair_note")}` : "",
		"--- 字符画草稿（定位+内容） ---",
		asciiText,
		getInjectText("ppt.draft_instruction"),
	] : [
		`[PPT 生成结果] deck=${deckName}`,
		`pptx: ${res.pptx}`,
		`layout: ${res.layout}`,
		`png 预览: ${(res.pngs || []).length} 张（${outDir}）`,
		`signals: ${signalsText}`,
		`resolve_log: ${res.resolve_log && res.resolve_log.length ? JSON.stringify(res.resolve_log) : "无"}`,
		// v1.7: 符号修复链命中时回喂（标签=结构标注留代码，引导句走 injectTexts 单源）
		specRepairs.length ? `spec 容错修复: ${specRepairs.join("/")}\n${getInjectText("ppt.repair_note")}` : "",
		"--- 字符画预览 ---",
		asciiText,
		getInjectText("ppt.result_instruction"),
	]).filter(Boolean).join("\n");
	return { text, files: attachments, deck: deckName };
}

// ============================================================
// datafit（v2.4 数据函数验证路, 流程图数据段）: AI 给数据文件+transform 函数 →
// 受限子进程先跑样本回喂核对 → full="true" 全量。执行 AI 代码=高危, 独立 owner 闸
// （allowPptDataFunc, 与固定管线代码的 allowPptPipeline 分键——风险不同级）。
// ============================================================
const DATAFIT_RUNNER = [
	"import json, sys",
	"sys.path.insert(0, sys.argv[1])",
	"import datafit",
	"res = datafit.run_datafit(sys.argv[2], sys.argv[3], sample_n=sys.argv[4] or 8, full=sys.argv[5] == 'true')",
	`print(${JSON.stringify(RESULT_MARKER)})`,
	"print(json.dumps(res, ensure_ascii=False))",
].join("\n");

async function runDatafit(op) {
	if (!settings.pipelineDir) throw new Error("管线目录未配置（beilu-ppt settings.pipelineDir 为空）");
	if (!deployGatedAllow("allowPptDataFunc", "BEILU_PPT_DATAFUNC"))
		throw new Error("数据函数执行未获授权（server 部署需 owner 开启 allowPptDataFunc 或 env BEILU_PPT_DATAFUNC=on）");
	const dataFile = String(op.file || "").trim();
	if (!dataFile || !fs.existsSync(dataFile))
		throw new Error(`数据文件不存在: ${dataFile || "(未给 file 属性)"}`);
	if (!op.body || !op.body.includes("transform"))
		throw new Error('标签体必须是含 def transform(rows): 的 python 函数代码');
	const deckName = sanitizeDeckName(op.name);
	const outDir = path.join(resolveOutRoot(), deckName);
	fs.mkdirSync(outDir, { recursive: true });
	const codePath = path.join(outDir, "datafit_fn.py");
	fs.writeFileSync(codePath, op.body);
	const pythonCmd = settings.pythonCmd || (Deno.build.os === "windows" ? "python" : "python3");
	const child = new Deno.Command(pythonCmd, {
		args: ["-X", "utf8", "-c", DATAFIT_RUNNER, settings.pipelineDir, dataFile, codePath,
			String(op.sample || ""), op.full === "true" ? "true" : "false"],
		cwd: settings.pipelineDir,
		stdout: "piped", stderr: "piped",
		env: { PYTHONIOENCODING: "utf-8" },
	}).spawn();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* 已退出 */ } }, settings.timeoutMs);
	const output = await child.output();
	clearTimeout(timer);
	if (timedOut) throw new Error(`数据函数执行超时（${settings.timeoutMs}ms）被终止`);
	const stdout = new TextDecoder().decode(output.stdout);
	const markerAt = stdout.lastIndexOf(RESULT_MARKER);
	if (output.code !== 0 || markerAt < 0)
		throw new Error(`datafit 退出码 ${output.code}。stderr 尾部:\n${new TextDecoder().decode(output.stderr).slice(-1500)}`);
	const res = JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length).trim());
	const text = [
		`[数据函数${res.full ? "全量" : "样本"}试跑] deck=${deckName} file=${res.file || dataFile}`,
		res.row_count !== undefined ? `总行数: ${res.row_count}` : "",
		res.error ? `error: ${res.error}` : "",
		!res.full && res.sample_rows ? `样本输入(${res.sample_rows.length} 行): ${JSON.stringify(res.sample_rows).slice(0, 2500)}` : "",
		res.result !== undefined ? `transform 输出: ${res.result}` : "",
		getInjectText("ppt.datafit_instruction"),
	].filter(Boolean).join("\n");
	return { text, files: [], deck: deckName };
}

// ============================================================
// fetch_image（v2.4, 流程图联网段"AI 需要可以看到联网的图片"）：url 直下(Deno fetch)
// 或 query 走管线 Commons 免 key 检索 → 候选图作为 user 消息落链
// （gameCompanion 截图轮同款范式, 侦察报告 code_imageInjection链路.md 候选1：
//   imageInjection 只认 user 图=既有硬门控, 落 user 条=零消费方改动进 AI 视觉）
// extension.pptFetchImage 标记 + trimEntryFiles 防膨胀（keep=settings.fetchImageKeepN）
// ============================================================
const FETCHQ_RUNNER = [
	"import json, sys",
	"sys.path.insert(0, sys.argv[1])",
	"import asset_lib",
	"p = asset_lib.get_photo_commons(sys.argv[2], sys.argv[3])",
	`print(${JSON.stringify(RESULT_MARKER)})`,
	"print(json.dumps({'path': p}))",
].join("\n");

async function fetchImage(op, chatid) {
	if (!chatid) throw new Error("无法定位当前对话, 候选图无处落链（chatid 为空）");
	const deckName = sanitizeDeckName(op.name);
	const outDir = path.join(resolveOutRoot(), deckName);
	fs.mkdirSync(outDir, { recursive: true });
	const url = String(op.url || "").trim();
	const query = String(op.query || "").trim();
	let localPath = null;
	let source = "";
	if (/^https?:\/\//i.test(url)) {
		// UA 必带（裸请求被 WAF 403, 环境实证）；只收 python-pptx 认的位图类型
		const resp = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 pptx-pipeline/2.4" },
			signal: AbortSignal.timeout(20000),
		});
		const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
		const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif" }[ct]
			|| (/\.(png|jpe?g|gif)$/i.exec(url.split("?")[0])?.[0].toLowerCase().replace(".jpeg", ".jpg") ?? null);
		if (!resp.ok || !ext) throw new Error(`下载失败: HTTP ${resp.status} / 类型 ${ct || "未知"}（只收 png/jpg/gif）`);
		const buf = new Uint8Array(await resp.arrayBuffer());
		if (buf.byteLength > 15 * 1024 * 1024 || buf.byteLength < 1024)
			throw new Error("图片超限(>15MB)或过小(<1KB, 疑似错误页)");
		localPath = path.join(outDir, `fetch_${Date.now() % 1000000}${ext}`);
		fs.writeFileSync(localPath, buf);
		source = url;
	} else if (query) {
		if (!settings.pipelineDir) throw new Error("管线目录未配置, query 检索不可用（可改用 url 直链）");
		const pythonCmd = settings.pythonCmd || (Deno.build.os === "windows" ? "python" : "python3");
		const child = new Deno.Command(pythonCmd, {
			args: ["-X", "utf8", "-c", FETCHQ_RUNNER, settings.pipelineDir, query,
				path.join(outDir, `fetch_${Date.now() % 1000000}.jpg`)],
			cwd: settings.pipelineDir, stdout: "piped", stderr: "piped",
			env: { PYTHONIOENCODING: "utf-8" },
		}).spawn();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* 已退出 */ } }, settings.timeoutMs);
		const output = await child.output();
		clearTimeout(timer);
		if (timedOut) throw new Error("检索超时被终止");
		const stdout = new TextDecoder().decode(output.stdout);
		const markerAt = stdout.lastIndexOf(RESULT_MARKER);
		if (output.code !== 0 || markerAt < 0)
			throw new Error(`检索进程失败(退出码 ${output.code})`);
		localPath = JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length).trim()).path;
		if (!localPath) throw new Error(`Commons 未检索到 "${query}" 的图片（换更通用的 2-4 个英文词, 或用 url 直链）`);
		source = `Commons 检索 "${query}"`;
	} else {
		throw new Error('需要 url="https://…" 或 query="2-4个英文词" 之一');
	}

	// [0717 时序断链修] 禁在此直调 addUserReply：ReplyHandler 跑在 GetReply 内部（generation.mjs:371）,
	// char 条落盘在其后(:247)——回合内落 user 条=时间线顺序颠倒+timeLines 覆盖分叉
	// （gameCompanion 先例安全是因为它在回合外触发, 抄范式必须抄时序前提）。
	// 正解: userImage 随 pendingResults 池进回合末——generation 在 system 工具结果条落盘后
	// 统一冲刷落 user 条（_flushPendingUserImages）, 天然成为续轮前最后一条 user 图。
	const mime = localPath.endsWith(".png") ? "image/png"
		: localPath.endsWith(".gif") ? "image/gif" : "image/jpeg";
	const keepN = Number(settings.fetchImageKeepN);
	return {
		text: `[候选图已获取] deck=${deckName} 本地路径=${localPath}${getInjectText("ppt.fetch_image_note")}`,
		files: [],
		deck: deckName,
		userImage: {
			// 结构标注留代码; 判读引导走 injectTexts（铁律: 进 messages 的引导句用户可配）
			content: `[PPT 候选图] deck=${deckName} 来源=${source} 本地路径=${localPath}\n${getInjectText("ppt.fetch_image_instruction")}`,
			files: [{ name: path.basename(localPath), mime_type: mime, buffer: fs.readFileSync(localPath) }],
			marker: "pptFetchImage",
			keepN: Number.isFinite(keepN) && keepN >= 0 ? keepN : 4,
		},
	};
}

// ============================================================
// v3 阶段2 多步工作流 op：outline（内容工件, 零 python）/ page（单页替换重渲）
// ============================================================
/** 标签体 JSON 解析（严格 parse → 符号容错修复链, 与 spec 同链） */
function parseBodyJson(body, what) {
	try {
		return { obj: JSON.parse(body), repairs: [] };
	} catch (e) {
		const r = repairSpecJson(body);
		if (!r.spec) throw new Error(`${what} JSON 解析失败: ${e.message}（容错修复链已尝试${r.applied.length ? "：" + r.applied.join("/") : ""}）`);
		return { obj: r.spec, repairs: r.applied };
	}
}

/**
 * outline — 内容层工件（v3 四步工作流第①步）：大纲 JSON 落盘 + stage=outline，
 * 零 python 零渲染。内容质量的检测点是用户审查，不是代码（凛倾 0717 铁律）。
 */
function outlineOp(op) {
	const deckName = sanitizeDeckName(op.name);
	const outDir = path.join(resolveOutRoot(), deckName);
	fs.mkdirSync(outDir, { recursive: true });
	const { obj: outline, repairs } = parseBodyJson(op.body, "outline");
	fs.writeFileSync(path.join(outDir, "outline.json"), JSON.stringify(outline, null, 2));
	try {
		fs.writeFileSync(path.join(outDir, "stage.json"),
			JSON.stringify({ stage: "outline", time: new Date().toISOString() }));
	} catch (e) { diag.warn("stage.json 落盘失败（不阻断）:", e && e.message); }
	const text = [
		`[PPT 内容大纲] deck=${deckName} 阶段=outline`,
		repairs.length ? `outline 容错修复: ${repairs.join("/")}\n${getInjectText("ppt.repair_note")}` : "",
		JSON.stringify(outline, null, 1).slice(0, 8000),
		getInjectText("ppt.outline_instruction"),
	].filter(Boolean).join("\n");
	return { text, files: [], deck: deckName };
}

/**
 * page — 单页替换重渲（v3"一张一张优化"）：读回 deck spec → 按 page id 替换该页 →
 * 走 generate 同链 → 附件只留该页 PNG + pptx（防逐页打磨时附件爆炸）。
 */
async function pageOp(op) {
	const deckName = sanitizeDeckName(op.name);
	const specPath = path.join(resolveOutRoot(), deckName, "spec.json");
	// [异步时序] spec 读改写+重渲全程按 specPath 串行（withFileLock 单进程 RMW 锁）：
	// 双窗口/多 op 并发改同 deck 时后读不会基于旧盘覆盖先写（edit 同锁，二者互斥）
	return withFileLock(specPath, () => _pageOpLocked(op, deckName, specPath));
}

async function _pageOpLocked(op, deckName, specPath) {
	if (!fs.existsSync(specPath))
		throw new Error(`deck "${deckName}" 无 spec.json——先 draft/generate 建 deck，或 action="list" 查看已有 deck`);
	const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
	const { obj: slide } = parseBodyJson(op.body, "page 标签体(单页 slide)");
	const pid = String(op.page || slide?.id || "").trim();
	if (!pid) throw new Error('需要 page="页id"（或标签体 slide 自带 id）');
	const idx = (spec.slides || []).findIndex((s) => s && s.id === pid);
	if (idx < 0)
		throw new Error(`页 "${pid}" 不存在。现有页: ${(spec.slides || []).map((s) => s && s.id).filter(Boolean).join(", ")}`);
	slide.id = pid;
	spec.slides[idx] = slide;
	const out = await runPipeline({ ...op, action: "generate", body: JSON.stringify(spec) });
	// [断链修] 附件页码按 layout 反查: 回程闭环会插续页(_cont), layout 页序≠spec 页序,
	//   按 spec 序取 preview_s{n}.png 会附错页。layout.json 由本次 python 运行刚写盘, id 是真值源;
	//   该页拆出的续页(pid_cont)一并附上。读取失败退 spec 序(层内无插页时两者一致)。
	let wantIdx = [idx];
	try {
		const lay = JSON.parse(fs.readFileSync(path.join(resolveOutRoot(), deckName, "layout.json"), "utf-8"));
		const found = [];
		(lay.slides || []).forEach((s, i2) => {
			if (s && (s.id === pid || s.id === `${pid}_cont`)) found.push(i2);
		});
		if (found.length) wantIdx = found;
	} catch (e) { diag.warn("layout.json 反查失败, 退 spec 页序:", e && e.message); }
	const wants = wantIdx.map((i2) => `preview_s${i2 + 1}.png`);
	// 互动图 HTML 附件保留（interactive chart 的交付件, 过滤丢弃=断链）
	out.files = (out.files || []).filter((f) =>
		f.name.endsWith(".pptx") || f.name.endsWith(".html") || wants.some((w) => f.name.endsWith(w)));
	out.text = `[PPT 单页更新] page=${pid}（附件仅该页预览+整本 pptx）\n` + out.text;
	return out;
}

// ============================================================
// v3.3 edit — spec 增量编辑（凛倾 0717"建立ppt之后直接保存为文件,然后ai后面更改
// 不需要全部输出,只需要插入行或者改变"——仿 IDE fuzzy_edit 范式的补丁 op）。
// 编辑粒度梯: edit(块/字段) < page(整页) < generate(整本)。
// 落盘 spec.json 是真源: 补丁在内存应用, 全部成功才交给管线(管线会写回 spec.json)——
// 任一条失败=整体不落盘不重渲, 报错回报现有结构（信号只报操作错误铁律: 只报路径
// 未命中/类型不符, 不评内容）。
// ============================================================
const MAX_EDIT_OPS = 40;

/** path 解析: "slides[s3].bullets[2]" → [{key:"slides",sel:"s3"},{key:"bullets",sel:2}]
 *  选择器: 纯数字=数组序号(0起), 其他=数组元素 id 匹配; 无 [] = 对象字段 */
function _editPathSegs(pathStr) {
	const segs = [];
	for (const part of String(pathStr || "").trim().split(".")) {
		if (!part) continue;
		const m = /^([\w$\u4e00-\u9fff-]+)(?:\[([^\]]*)\])?$/.exec(part);
		if (!m) throw new Error(`path 片段无法解析: "${part}"（合法形如 slides[s3].bullets[2] / meta.title）`);
		const seg = { key: m[1] };
		if (m[2] !== undefined) seg.sel = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
		segs.push(seg);
	}
	return segs;
}

/** 未命中时回报现有结构（数组=各元素 id 或序号, 对象=键名, 帮 AI 自纠不用重传） */
function _editDescribe(node) {
	if (Array.isArray(node)) {
		const ids = node.map((e, i) => (e && typeof e === "object" && e.id !== undefined) ? e.id : i);
		return `数组长度 ${node.length}, 元素: ${JSON.stringify(ids).slice(0, 400)}`;
	}
	if (node && typeof node === "object") return `对象键: ${Object.keys(node).join(", ").slice(0, 400)}`;
	return `标量值: ${String(JSON.stringify(node)).slice(0, 120)}`;
}

/** 数组内按选择器定位: 数字=序号, 字符串=按元素 .id；未命中返回 -1 */
function _editFindIdx(arr, sel) {
	if (typeof sel === "number") return sel >= 0 && sel < arr.length ? sel : -1;
	return arr.findIndex((e) => e && typeof e === "object" && String(e.id) === sel);
}

/**
 * 应用单条补丁 op 到 spec（原地）。返回触及的 slide id（非 slides 域返回 null=deck 级）。
 * op 形: {op:"set|insert|delete|move", path:"...", value:…, to:…}
 *  - set: 替换 path 处的值（对象字段不存在=新建; 数组元素必须命中）
 *  - insert: path 末段指数组——[序号]=插在该位前, [id]=插在该元素后, 无[]=追加
 *  - delete: 删对象字段 / 删数组元素
 *  - move: path 定位数组元素, to=目标序号或"插到 id 后"
 */
function _applyEditOp(spec, e, k) {
	const kind = String(e?.op || "");
	if (!["set", "insert", "delete", "move"].includes(kind))
		throw new Error(`ops[${k}] 未知 op "${kind}"（支持: set | insert | delete | move）`);
	const segs = _editPathSegs(e.path);
	if (!segs.length) throw new Error(`ops[${k}] 缺 path`);
	const miss = (msg, node) => new Error(`ops[${k}] ${kind} path="${e.path}" ${msg}。现有结构: ${_editDescribe(node)}`);

	// 走到末段的宿主对象
	let node = spec;
	for (let i = 0; i < segs.length - 1; i++) {
		const s = segs[i];
		if (!node || typeof node !== "object" || Array.isArray(node)) throw miss(`片段 "${s.key}" 的宿主不是对象`, node);
		let next = node[s.key];
		if (next === undefined) throw miss(`字段 "${s.key}" 不存在`, node);
		if (s.sel !== undefined) {
			if (!Array.isArray(next)) throw miss(`"${s.key}" 不是数组, 不能用 [${s.sel}]`, next);
			const idx = _editFindIdx(next, s.sel);
			if (idx < 0) throw miss(`"${s.key}[${s.sel}]" 未命中`, next);
			next = next[idx];
		}
		node = next;
	}

	const last = segs[segs.length - 1];
	if (!node || typeof node !== "object" || Array.isArray(node)) throw miss(`末段 "${last.key}" 的宿主不是对象`, node);
	// 触及页判定: path 首段为 slides[sel] → 报该页 id; 其余(meta/theme/整 slides 数组)=deck 级
	const touched = (segs[0].key === "slides" && segs[0].sel !== undefined)
		? (() => { const i2 = _editFindIdx(spec.slides || [], segs[0].sel); return i2 >= 0 ? (spec.slides[i2]?.id ?? null) : null; })()
		: null;

	if (last.sel === undefined) {
		// 对象字段级
		if (kind === "set") { node[last.key] = e.value; return touched; }
		if (kind === "delete") {
			if (!(last.key in node)) throw miss(`字段 "${last.key}" 不存在`, node);
			delete node[last.key]; return touched;
		}
		if (kind === "insert") {
			const arr = node[last.key];
			if (!Array.isArray(arr)) throw miss(`"${last.key}" 不是数组, insert 需数组（或用 set 建字段）`, node);
			arr.push(e.value); return _touchAfterArrayOp(spec, segs, touched, e.value);
		}
		throw miss(`move 需要数组元素选择器（如 ${last.key}[id]）`, node);
	}

	// 数组元素级
	const arr = node[last.key];
	if (!Array.isArray(arr)) throw miss(`"${last.key}" 不是数组, 不能用 [${last.sel}]`, node[last.key] ?? node);
	if (kind === "insert") {
		let at;
		if (typeof last.sel === "number") at = Math.min(Math.max(last.sel, 0), arr.length); // 序号=插在该位前
		else {
			const i2 = _editFindIdx(arr, last.sel);
			if (i2 < 0) throw miss(`"${last.key}[${last.sel}]" 未命中（insert 按 id=插到该元素后）`, arr);
			at = i2 + 1;
		}
		arr.splice(at, 0, e.value);
		return _touchAfterArrayOp(spec, segs, touched, e.value);
	}
	const idx = _editFindIdx(arr, last.sel);
	if (idx < 0) throw miss(`"${last.key}[${last.sel}]" 未命中`, arr);
	if (kind === "set") {
		// 按 id 寻址时保持 id 稳定（同 pageOp 的 slide.id=pid 语义, 防换值后寻址链断）
		if (typeof last.sel === "string" && e.value && typeof e.value === "object" && !Array.isArray(e.value) && e.value.id === undefined)
			e.value.id = arr[idx]?.id ?? last.sel;
		arr[idx] = e.value;
	} else if (kind === "delete") {
		arr.splice(idx, 1);
	} else { // move
		const [el] = arr.splice(idx, 1);
		let at;
		if (typeof e.to === "number") at = Math.min(Math.max(e.to, 0), arr.length);
		else if (typeof e.to === "string") {
			const i2 = _editFindIdx(arr, e.to);
			if (i2 < 0) { arr.splice(idx, 0, el); throw miss(`to="${e.to}" 未命中`, arr); }
			at = i2 + 1;
		} else { arr.splice(idx, 0, el); throw new Error(`ops[${k}] move 缺 to（目标序号 或 "插到其后"的元素 id）`); }
		arr.splice(at, 0, el);
	}
	return touched;
}

/** 数组级操作若发生在 slides 顶层（插页/删页），触及页=新元素 id；否则沿用 path 首段判定 */
function _touchAfterArrayOp(spec, segs, touched, value) {
	if (segs.length === 1 && segs[0].key === "slides")
		return (value && typeof value === "object" && value.id) ? value.id : null;
	return touched;
}

/**
 * edit — 增量编辑落盘 spec 后走 generate 同链重渲。
 * 附件策略同 pageOp: 只触及具体页时按 layout 反查只附那些页(+_cont)+pptx；
 * 含 deck 级改动(meta/theme/插删页未知序)=附全量。
 */
async function editOp(op) {
	const deckName = sanitizeDeckName(op.name);
	const specPath = path.join(resolveOutRoot(), deckName, "spec.json");
	// [异步时序] 与 pageOp 同锁键：spec 读-应用-重渲串行，防并发 RMW lost-update
	return withFileLock(specPath, () => _editOpLocked(op, deckName, specPath));
}

async function _editOpLocked(op, deckName, specPath) {
	if (!fs.existsSync(specPath))
		throw new Error(`deck "${deckName}" 无 spec.json——先 draft/generate 建 deck，或 action="list" 查看已有 deck`);
	const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
	const { obj: patch, repairs } = parseBodyJson(op.body, "edit 补丁");
	const opsList = Array.isArray(patch) ? patch : patch?.ops;
	if (!Array.isArray(opsList) || !opsList.length)
		throw new Error('edit 标签体需要 {"ops":[{"op":"set","path":"slides[s3].title","value":"…"},…]}（或裸 ops 数组）');
	if (opsList.length > MAX_EDIT_OPS)
		throw new Error(`edit 一次最多 ${MAX_EDIT_OPS} 条 op（收到 ${opsList.length}）——拆多次或改用 page/generate`);

	const touchedIds = new Set();
	let deckLevel = false;
	opsList.forEach((e, k) => {
		const t = _applyEditOp(spec, e, k);
		if (t === null) deckLevel = true; else touchedIds.add(String(t));
	});

	const out = await runPipeline({ ...op, action: "generate", body: JSON.stringify(spec) });
	if (!deckLevel && touchedIds.size) {
		// 附件瘦身: layout 页序是真值源（回程闭环插 _cont 续页, 同 pageOp 断链修）
		let wants = null;
		try {
			const lay = JSON.parse(fs.readFileSync(path.join(resolveOutRoot(), deckName, "layout.json"), "utf-8"));
			const found = [];
			(lay.slides || []).forEach((s, i2) => {
				const sid = s && String(s.id || "");
				if (touchedIds.has(sid) || (sid.endsWith("_cont") && touchedIds.has(sid.slice(0, -5)))) found.push(i2);
			});
			if (found.length) wants = found.map((i2) => `preview_s${i2 + 1}.png`);
		} catch (e) { diag.warn("layout.json 反查失败, 附全量:", e && e.message); }
		if (wants)
			out.files = (out.files || []).filter((f) =>
				f.name.endsWith(".pptx") || f.name.endsWith(".html") || wants.some((w) => f.name.endsWith(w)));
	}
	out.text = `[PPT 增量编辑] deck=${deckName} 应用 ${opsList.length} 条补丁`
		+ (touchedIds.size ? ` 触及页=${[...touchedIds].join(",")}` : "") + (deckLevel ? "（含 deck 级改动）" : "")
		+ (repairs.length ? `\n补丁 JSON 容错修复: ${repairs.join("/")}` : "")
		+ "\n" + out.text;
	return out;
}

// ============================================================
// 只读指令：load（跨会话修改链——读回 spec+字符画进上下文）/ list（枚举已有 deck）
// 纯磁盘读且路径经 sanitizeDeckName 锚在 outRoot 内，不过 exec 闸
// ============================================================
function loadDeck(op) {
	const deckName = sanitizeDeckName(op.name);
	const dir = path.join(resolveOutRoot(), deckName);
	const specPath = path.join(dir, "spec.json");
	if (!fs.existsSync(specPath)) {
		// [断链修] outline 态回炉: 大纲工件已存在但尚未 draft(无 spec)——load 应回大纲而不是报错
		const outlinePath = path.join(dir, "outline.json");
		if (fs.existsSync(outlinePath)) {
			const text = [
				`[PPT deck 载入] deck=${deckName} 阶段=outline（尚无 spec, 内容层待过稿）`,
				"outline.json:",
				fs.readFileSync(outlinePath, "utf-8"),
				getInjectText("ppt.outline_instruction"),
			].join("\n");
			return { text, files: [] };
		}
		throw new Error(`deck "${deckName}" 无 spec.json（${dir}）——用 action="list" 查看已有 deck`);
	}
	const specText = fs.readFileSync(specPath, "utf-8");
	let ascii = "";
	try { ascii = fs.readFileSync(path.join(dir, "preview_ascii.txt"), "utf-8"); } catch { /* 无预览=只回 spec */ }
	if (ascii.length > settings.maxAsciiChars)
		ascii = ascii.slice(0, settings.maxAsciiChars) + "\n…(截断)";
	// v2.0 状态机读侧: 回炉链入口——报当前阶段, AI 按协议决定重走 draft 审查还是直接改
	let stage = "";
	try { stage = JSON.parse(fs.readFileSync(path.join(dir, "stage.json"), "utf-8")).stage || ""; } catch { /* 旧 deck 无 stage=按 final 对待 */ }
	const text = [
		`[PPT deck 载入] deck=${deckName} 阶段=${stage || "final"}`,
		"spec.json:",
		specText,
		ascii ? "--- 字符画预览 ---\n" + ascii : "",
	].filter(Boolean).join("\n");
	return { text, files: [] };
}

function listDecks() {
	const root = resolveOutRoot();
	const rows = [];
	if (root && fs.existsSync(root))
		for (const d of fs.readdirSync(root, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const hasPptx = fs.existsSync(path.join(root, d.name, "deck.pptx"));
			let mtime = "";
			try { mtime = fs.statSync(path.join(root, d.name)).mtime.toISOString().slice(0, 16); } catch { /* 列表容错 */ }
			let stage = "";
			try { stage = JSON.parse(fs.readFileSync(path.join(root, d.name, "stage.json"), "utf-8")).stage || ""; } catch { /* 无 stage=旧 deck */ }
			rows.push(`- ${d.name} [${stage || (hasPptx ? "final" : "?")}]${hasPptx ? "" : "（无 deck.pptx）"} ${mtime}`);
		}
	const text = [`[PPT deck 列表] 根目录: ${root || "(未配置)"}`, ...(rows.length ? rows : ["(空)"])].join("\n");
	return { text, files: [] };
}

// ============================================================
// 插件导出
// ============================================================
const pluginExport = {
	info,

	Load: async ({ router } = {}) => {
		loadSettings();
		// config REST 端点（范式=web/main.mjs Load）：此前零 HTTP 门=前端无配置入口（0722 差集审计确诊）
		if (router) {
			const { authenticate } = await import("../../../../yonban/core/functions/security/auth.mjs");
			router.get(/\/config\/getdata$/, authenticate, async (_req, res) => {
				try { res.json(await pluginExport.interfaces.config.GetData()); }
				catch (e) { res.status(500).json({ error: e.message }); }
			});
			router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
				try { await pluginExport.interfaces.config.SetData(req.body); res.json({ success: true }); }
				catch (e) { res.status(500).json({ error: e.message }); }
			});
		}
	},

	Unload: async () => { /* 无常驻资源 */ },

	interfaces: {
		config: {
			GetData: async () => ({
				...settings, lastResult: lastResult ? { ...lastResult } : null,
				// 控件元数据单源下发（0722 禁前端硬编码）：前端设置面纯渲染。键集=DEFAULTS 全 13 键。
				meta: [
					{ key: "pipelineDir", group: "管线", type: "text", label: "管线目录", desc: "含 pipeline.py 的目录；默认内置管线，置空=休眠" },
					{ key: "pythonCmd", group: "管线", type: "text", label: "Python 命令", desc: "空=自动（按系统选 python/python3）" },
					{ key: "outRoot", group: "管线", type: "text", label: "输出根目录", desc: "空=管线目录下 works/beilu_decks" },
					{ key: "timeoutMs", group: "管线", type: "number", label: "管线超时 (ms)", desc: "子进程最大执行时间", min: 10000, max: 1800000, step: 10000 },
					{ key: "chromePath", group: "渲染", type: "text", label: "Chrome 路径", desc: "SVG→PNG 截图渲染；空=自动探测" },
					{ key: "maxAsciiChars", group: "回喂", type: "number", label: "字符画预览上限", desc: "回喂字符画的最大字符数（防撑爆上下文）", min: 1000, max: 200000, step: 1000 },
					{ key: "attachPngLimit", group: "回喂", type: "number", label: "PNG 预览页数上限", desc: "挂到回复气泡的预览页数（0=不挂）", min: 0, max: 100 },
					{ key: "fetchImageKeepN", group: "回喂", type: "number", label: "候选图保留轮数", desc: "联网候选图附件保留最近 N 轮（0=不修剪）", min: 0, max: 50 },
					{ key: "maxOpsPerUserTurn", group: "安全", type: "number", label: "单轮操作预算", desc: "连续无用户输入的 ppt_op 执行上限（防循环，0=关闭）", min: 0, max: 50 },
					{ key: "assetUndrawDir", group: "素材库", type: "text", label: "unDraw 插画目录", desc: "本地 SVG 插画检索源（可选）" },
					{ key: "assetTablerDir", group: "素材库", type: "text", label: "Tabler 图标目录", desc: "本地 SVG 图标检索源（可选）" },
					{ key: "assetPatternsDir", group: "素材库", type: "text", label: "背景纹理目录", desc: "hero-patterns SVG 纹理源（可选）" },
					{ key: "themesFile", group: "素材库", type: "text", label: "主题覆盖文件", desc: "JSON 主题覆盖层；空=自动探测 data/beilu-ppt-themes.json" },
				],
			}),
			SetData: async (data) => {
				if (!data || typeof data !== "object") return;
				for (const k of Object.keys(DEFAULTS)) {
					if (data[k] === undefined) continue;
					if (typeof DEFAULTS[k] === "number") {
						const n = Number(data[k]);
						if (Number.isFinite(n) && n >= (NUM_MIN[k] ?? 1)) settings[k] = n;
					} else if (typeof DEFAULTS[k] === "boolean") {
						settings[k] = !!data[k];
					} else {
						settings[k] = String(data[k]);
					}
				}
				saveSettings();
			},
		},

		chat: {
			/**
			 * GetPrompt — work/code 模式下注入 <ppt_op> 指令说明 + 宏变量。
			 * 未配置 pipelineDir = 休眠（不注入不产宏，功能对 AI 不可见）。
			 */
			GetPrompt: (arg) => {
				// ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText（用户可配），操作说明走 INJ 条目。shadowBuild 会检测并隐藏 >200 字符的非宏内容。
				// [0717 宏残留修] 门控只关"注入文本", 宏恒定义——预设 main 尾挂 {{ppt_usage}}
				// (preset 装配断链修), 非 work/code 模式若宏未定义会字面残留"{{ppt_usage}}"进上下文
				if (!ENABLED_MODES.has(resolveMode(arg)) || !settings.pipelineDir) {
					return { text: [], additional_chat_log: [], extension: { macro_env: { ppt_usage: "", ppt_out_root: "", ppt_last_deck: "" } } };
				}

				const outRoot = resolveOutRoot();
				const usage = fillInjectText("ppt.usage", { out_root: outRoot });
				// [0718 归一 INJ] text 自动注入线已删——教学唯一入口=INJ 条目内 {{ppt_usage}} 宏展开
				//   （INJ 可开关/可配 depth·order/随 autoMode 门控, 一处管理; 文本仍单源 injectTexts）
				return {
					text: [],
					additional_chat_log: [],
					extension: {
						macro_env: {
							ppt_usage: usage,
							ppt_out_root: outRoot,
							ppt_last_deck: lastResult?.deck || "",
						},
					},
				};
			},

			/**
			 * ReplyHandler — 解析并执行 <ppt_op>，MCP Template 范式：
			 * char 条目记工具调用原文 + tool 条目记结果，return true 续轮。
			 */
			ReplyHandler: async (reply, args) => {
				if (!reply?.content || !reply.content.includes("<ppt_op")) return false;
				if (!ENABLED_MODES.has(resolveMode(args))) return false;
				const _ownerUsername = args?.username || "";

				// chatid 解析上移：门 3 半失败反馈分支也需要（见下）
				let _chatid = null;
				try {
					const _cn = args?.chat_name || "";
					if (_cn.startsWith("common_chat_")) _chatid = _cn.slice("common_chat_".length);
					if (!_chatid) _chatid = getAmbientChatId?.() || null;
				} catch { /* chatid 解析失败 → null 广播项 */ }

				const ops = parsePptOps(reply.content);
				if (!ops.length) {
					// [0717 半失败反馈·凛倾"输出了正确格式没有执行"] 有 <ppt_op 字样但解析出 0 个完整指令
					//   （高频=缺 </ppt_op> 闭合/输出被截断）——原实现静默 return false 零反馈，AI 以为
					//   已执行、用户以为插件坏了。入池失败结果 → 回合末落盘+自动续轮 → AI 下轮自纠
					//   （同 fuzzy_edit 失败提示范式）。文案走 injectTexts 单源（ppt.op_incomplete，用户可配）。
					// [0717 吞噬事故配套] 只在"像指令的尝试"（带属性的 <ppt_op ...=）时反馈；
					//   正文散文提及裸 `<ppt_op>` 字样（parsePptOps 已按提及跳过）不触发，防误纠错进上下文。
					if (!/<ppt_op\b[^>]*\w+\s*=/i.test(reply.content)) return false;
					ideClient.enqueuePendingResult({ chatid: _chatid, ownerUsername: _ownerUsername, tool: "ppt_op", params: { action: "parse" }, timestamp: new Date().toISOString(), result: { success: false, error: getInjectText("ppt.op_incomplete") } });
					return false;
				}

				// [0718 防循环①] 连续无用户输入预算：自最后一条 user 消息起 ppt_op 结果条 ≥ 上限
				//   → 本轮全部 op 不执行 + _stopContinue 强制停轮（结果条照常注入, 不再续轮）。
				//   reply.extension 与落盘 finalEntry.extension 同引用（messageBuilder.mjs:159/199），
				//   generation.mjs:446 消费 _stopContinue；用户任意发言=计数从新 user 条起自然归零。
				const _budget = Number(settings.maxOpsPerUserTurn);
				if (_budget > 0 && countPptOpsSinceUser(args?.chat_log) >= _budget) {
					const _ranN = countPptOpsSinceUser(args?.chat_log);
					reply.extension ??= {};
					reply.extension._stopContinue = true;
					ideClient.enqueuePendingResult({ chatid: _chatid, ownerUsername: _ownerUsername, tool: "ppt_op", params: { action: ops[0].action, name: ops[0].name || "" }, timestamp: new Date().toISOString(), result: { success: false, error: fillInjectText("ppt.op_budget_paused", { n: _ranN }) } });
					diag.log(`防循环预算触发: ${_ranN}/${_budget} 连续无用户输入, 本轮 ${ops.length} 条 op 未执行`);
					return false;
				}

				// [0717 范式迁移·凛倾拍板] AddLongTimeLog+return true(模板内 regen) → IDE 范式：
				//   结果入 ideClient.pendingResults 池 → generation 回合末统一落盘 system 条
				//   (_opType=ide_tool_result) + scheduleAutoContinue 续轮——熔断/用户开关/工具结果
				//   代际隐藏/worker 池回灌(groupWorkerManager:148-151)全部继承，与 ideToolCall 同链。
				//   旧范式病(0717 事故确诊)：轨迹寄生 logContextBefore 落盘被 marge 跨轮重灌 +
				//   模板 while(true) 循环。工具调用原文(<ppt_op>)留在 reply.content 落盘，AI 下轮可见。
				// chatid：chat_name 单一产地 getChatRequest("common_chat_"+chatid)，主进程/worker 两形态
				//   都随 request 存在；ambient ALS 兜底(仅主进程回合内有效)；都取不到=null 广播项。
				//   （解析块已上移至门 3 之前，半失败反馈分支共用。）
				for (const op of ops) {
					let _entry;
					// [0718 防循环②] 重复 op 拒绝：与上一条成功执行的 op 完全相同（确定性执行类）
					//   =同产物重跑, 拒绝并回操作错误信号；AI 改动内容后重发即放行。
					if (DUP_GUARD_ACTIONS.has(op.action) && op.body && _chatid && _lastOpSig.get(_chatid) === _opSig(op)) {
						ideClient.enqueuePendingResult({ chatid: _chatid, ownerUsername: _ownerUsername, tool: "ppt_op", params: { action: op.action, name: op.name || "" }, timestamp: new Date().toISOString(), result: { success: false, error: getInjectText("ppt.op_duplicate") } });
						diag.log(`重复 op 拒绝: ${op.action}/${op.name}`);
						continue;
					}
					try {
						let out;
						if (op.action === "generate" || op.action === "draft") out = await runPipeline(op);
						else if (op.action === "outline") out = outlineOp(op);
						else if (op.action === "page") out = await pageOp(op);
						else if (op.action === "edit") out = await editOp(op);
						else if (op.action === "datafit") out = await runDatafit(op);
						else if (op.action === "fetch_image") out = await fetchImage(op, _chatid);
						else if (op.action === "load") out = loadDeck(op);
						else if (op.action === "list") out = listDecks();
						else throw new Error(`未知 action "${op.action}"（当前支持: outline | draft | generate | edit | page | datafit | fetch_image | load | list）`);
						// 用户可见面走最终回复气泡附件。同 deck 迭代重生成=覆盖语义（0715 定案原样保留）：
						// push 前先清退本 deck 的旧代附件（命名契约=`${deckName}_*` / `${deckName}.pptx`），
						// deck 名取 runPipeline 单源返回值（out.deck），防时间戳命名跨分钟漂移致清退失配。
						if (out.files?.length) {
							reply.files ??= [];
							if (out.deck) {
								reply.files = reply.files.filter((f) =>
									!(f?.name === `${out.deck}.pptx` || String(f?.name || "").startsWith(`${out.deck}_`)));
							}
							reply.files.push(...out.files);
						}
						_entry = { chatid: _chatid, tool: "ppt_op", params: { action: op.action, name: op.name || out.deck || "" }, timestamp: new Date().toISOString(), result: { success: true, result: out.text } };
						// 防循环②记账：成功才记（失败不记=允许对超时/文件锁类非确定错误原样重试）
						if (DUP_GUARD_ACTIONS.has(op.action) && op.body && _chatid) _lastOpSig.set(_chatid, _opSig(op));
						// v2.4 时序安全通道: 候选图经池进回合末落链（generation._flushPendingUserImages 消费）
						if (out.userImage) _entry.userImage = out.userImage;
					} catch (err) {
						diag.warn("ppt_op 执行失败:", err && err.message);
						_entry = { chatid: _chatid, tool: "ppt_op", params: { action: op.action, name: op.name || "" }, timestamp: new Date().toISOString(), result: { success: false, error: `[PPT 生成失败] ${err.message}` } };
					}
					ideClient.enqueuePendingResult({ ..._entry, ownerUsername: _ownerUsername });
				}

				return false;
			},
		},
	},
};

export default pluginExport;

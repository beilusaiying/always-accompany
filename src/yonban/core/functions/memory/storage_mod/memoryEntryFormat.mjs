/**
 * memoryEntryFormat.mjs — 记忆条目格式规范化（读写统一出入口，P1 自驱动前置）
 *
 * 功能链：archiver / p1_pipeline → normalizeEntry(entry) → 补字段标准化 → 写盘；读取时 normalizeEntry 自动补缺省字段
 * why：hot/warm/cold 各 JSON 文件由不同路径写入，字段参差不齐（旧格式 forever.json 只有 event/date，新格式含 keywords/type/weight）；
 *      在 IO 层统一规范化，使 P1 召回 + 打分算法始终能拿到完整字段，不用在每个消费方各自补丁。
 * 关联链：
 *   ← archiver.mjs（归档写入前规范化）
 *   ← p1_pipeline.mjs（读取条目时规范化）
 *   → nicerWriteFile.mjs（nicerWriteFileSync，安全写盘）
 * 影响范围：修改内存条目对象（补 timestamp/keywords/content/keyword_nodes/type/weight），不直接写盘
 * 使用效果：normalizeEntry 补缺省值；validateEntry 校验必填字段；旧格式自动向上兼容
 *
 * 统一格式 (按 P1 自驱动设计 MD §6.1):
 *   {
 *     timestamp:     ISO string       (必填)
 *     keywords:      string[]         (必填)
 *     content:       string           (必填)
 *     keyword_nodes: string[]         (推荐, 默认 = keywords, 自驱动 P1 生成归并节点时覆盖)
 *     type:          event|preference|fact|emotion  (推荐, 默认 event)
 *     weight:        number 0-1       (推荐, 默认 0.5)
 *   }
 *
 * 旧格式兼容:
 *   forever.json:     { event, date, weight, last_triggered }
 *   appointments.json:{ character, task, location, duration, completed_at }
 *   remember_about_user/*.json: 按日期存放
 *
 * 策略: 读取时自动补字段 (normalizeEntry), 写入时强制走 normalizeEntry
 */

import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs";

export const STANDARD_TYPES = ["event", "preference", "fact", "emotion"];
export const DEFAULT_TYPE = "event";
export const DEFAULT_WEIGHT = 0.5;

/** 默认字段 */
export function defaultFields() {
	return {
		type: DEFAULT_TYPE,
		weight: DEFAULT_WEIGHT,
		keyword_nodes: [],
	};
}

/**
 * 校验条目 (不修改)
 * @param {object} entry
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateEntry(entry) {
	const errors = [];
	const warnings = [];
	if (!entry || typeof entry !== "object") {
		return { valid: false, errors: ["不是有效对象"], warnings: [] };
	}
	// 必填
	if (!entry.timestamp && !entry.date && !entry.completed_at && !entry.last_triggered) {
		errors.push("缺少 timestamp (或旧字段 date/completed_at/last_triggered)");
	}
	if (!entry.content && !entry.event && !entry.task) {
		errors.push("缺少 content (或旧字段 event/task)");
	}
	// 推荐字段容错口径（T040 子项f，凛倾"格式检查容错低"）：
	//   根因=推荐字段(keywords/type/weight/keyword_nodes)"缺失"时也报 warning，
	//   但这些字段读取时 normalizeEntry 均有确定默认补全（:114-138 keywords 分词/type→event/weight→0.5/keyword_nodes→keywords），
	//   旧格式条目(forever {event,date} / appointments {character,task})必然缺这些字段→每条累积 4 条噪声 warning。
	//   放宽=只对"值真异常/损坏"报 warning，"缺失(undefined)且有确定默认补全"的不报（读时兼容，非用户可感问题）。
	//   保留报 warning 的真异常：显式空 keywords []（给了空值可疑）、type 有值但非法、weight 有值但越界。
	//   error(缺必填 content/时间)不变——那是真损坏。
	if (Array.isArray(entry.keywords) && entry.keywords.length === 0) {
		warnings.push("keywords 为空"); // 显式空数组=可疑（区别于缺失，缺失读时分词兜底不报）
	}
	if (entry.type !== undefined && !STANDARD_TYPES.includes(entry.type)) {
		warnings.push(`type 非法 (${entry.type}),应为 ${STANDARD_TYPES.join("/")}`); // 有值但非法=真异常
	}
	if (entry.weight !== undefined && typeof entry.weight !== "number") {
		warnings.push(`weight 类型异常 (${typeof entry.weight}: ${entry.weight})，读时按默认 0.5 处理`); // 有值但类型错=真异常（T040f 核验边界补齐：与"缺失不报/有值异常报"口径一致）
	} else if (typeof entry.weight === "number" && (entry.weight < 0 || entry.weight > 1)) {
		warnings.push(`weight 超出 0-1 范围 (${entry.weight})`); // 有值但越界=真异常
	}
	// keyword_nodes 缺失：读时默认=keywords，无独立异常态，不报。
	return { valid: errors.length === 0, errors, warnings };
}

/**
 * 规范化条目 (补默认值 + legacy→新格式),返回新对象
 * @param {object} entry
 * @param {string} [sourceHint] forever|appointments|items_archive|remember|warm|generic
 * @returns {object|null}
 */
export function normalizeEntry(entry, sourceHint = "generic") {
	if (!entry || typeof entry !== "object") return null;
	const out = { ...entry };

	// timestamp（修9 20260716：兜底链补 archived_at——表格/warm batch 归档条目主时间字段是 archived_at，
	//   原链 miss → 读回时序丢失回退当前时间。事件时间字段(date/completed_at)语义优先，archived_at 殿后）
	if (!out.timestamp) {
		out.timestamp =
			out.date ||
			out.completed_at ||
			out.last_triggered ||
			out.archived_at ||
			new Date().toISOString();
	}

	// content
	if (!out.content) {
		if (out.event) out.content = String(out.event);
		else if (out.task || out.character) {
			const parts = [out.character, out.task, out.location, out.duration].filter(Boolean);
			out.content = parts.join(" · ") || "(empty)";
		} else out.content = "";
	}

	// keywords
	if (!Array.isArray(out.keywords)) {
		// 粗略分词 (中文按标点切,每段长度 2~8 字符，最多取前 10 个关键词)
		const text = String(out.content || "");
		out.keywords = text
			.split(/[\s,，。、!！??;；:：\-—_\[\]()（）]+/)
			.map((s) => s.trim())
			.filter((s) => s.length >= 2 && s.length <= 8)
			.slice(0, 10);
	}

	// type
	if (!out.type || !STANDARD_TYPES.includes(out.type)) {
		out.type = DEFAULT_TYPE;
	}

	// weight
	if (typeof out.weight !== "number" || out.weight < 0 || out.weight > 1) {
		out.weight = DEFAULT_WEIGHT;
	}

	// keyword_nodes (自驱动 P1 生成归并节点前默认 = keywords)
	if (!Array.isArray(out.keyword_nodes)) {
		out.keyword_nodes = [...out.keywords];
	}

	// 字段序落地凛倾 2026-07-16 格式裁决「前面是关键词+时间，后面是内容」：
	//   JSON.stringify 按插入序输出 → 落盘条目头部=keywords+timestamp（检索键+时序键），内容与其余字段随后。
	//   只重排不改值，读侧按键取值零影响。
	const { keywords: _kw, timestamp: _ts, content: _ct, ..._rest } = out;
	return { keywords: _kw, timestamp: _ts, content: _ct, ..._rest };
}

/**
 * 扫描记忆目录,统计格式符合度
 * @param {string} memDir  data/users/<user>/memory/<char>/
 * @returns {{ total: number, valid: number, warnings: number, invalid: number, files: Array, issues: Array }}
 */
export function scanMemoryFormat(memDir) {
	const result = {
		total: 0,
		valid: 0,
		warnings: 0,
		invalid: 0,
		files: [],
		issues: [],
	};

	function scanFile(filepath, sourceHint) {
		try {
			const raw = fs.readFileSync(filepath, "utf-8");
			const data = JSON.parse(raw);
			const entries = Array.isArray(data?.entries) ? data.entries : [];
			let fileValid = 0, fileWarnings = 0, fileInvalid = 0;
			for (const [i, entry] of entries.entries()) {
				result.total++;
				const check = validateEntry(entry);
				if (!check.valid) {
					result.invalid++;
					fileInvalid++;
					result.issues.push({
						file: path.relative(memDir, filepath),
						index: i,
						level: "error",
						errors: check.errors,
						warnings: check.warnings,
					});
				} else if (check.warnings.length > 0) {
					result.warnings++;
					fileWarnings++;
					result.issues.push({
						file: path.relative(memDir, filepath),
						index: i,
						level: "warning",
						errors: [],
						warnings: check.warnings,
					});
				} else {
					result.valid++;
					fileValid++;
				}
			}
			result.files.push({
				file: path.relative(memDir, filepath),
				count: entries.length,
				valid: fileValid,
				warnings: fileWarnings,
				invalid: fileInvalid,
				sourceHint,
			});
		} catch (e) {
			result.issues.push({
				file: path.relative(memDir, filepath),
				level: "error",
				errors: [`解析失败: ${e.message}`],
				warnings: [],
			});
		}
	}

	if (!fs.existsSync(memDir)) return result;

	// hot/ 各 JSON 文件
	const hotDir = path.join(memDir, "hot");
	if (fs.existsSync(hotDir)) {
		for (const f of fs.readdirSync(hotDir)) {
			const p = path.join(hotDir, f);
			if (fs.statSync(p).isFile() && f.endsWith(".json")) {
				const hint = f.replace(".json", "");
				scanFile(p, hint);
			} else if (fs.statSync(p).isDirectory()) {
				// 比如 remember_about_user/
				for (const sf of fs.readdirSync(p)) {
					if (sf.endsWith(".json")) scanFile(path.join(p, sf), f);
				}
			}
		}
	}

	// warm/ 递归
	const warmDir = path.join(memDir, "warm");
	if (fs.existsSync(warmDir)) {
		function walk(dir) {
			for (const f of fs.readdirSync(dir)) {
				const p = path.join(dir, f);
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (f.endsWith(".json")) scanFile(p, "warm");
			}
		}
		walk(warmDir);
	}

	return result;
}

/**
 * 一键升级: 就地写回规范化后的 entries
 * @param {string} memDir
 * @returns {{ filesChanged: number, entriesChanged: number, errors: Array }}
 */
export function upgradeMemoryFormat(memDir) {
	const result = { filesChanged: 0, entriesChanged: 0, errors: [] };

	function upgradeFile(filepath, sourceHint) {
		try {
			const raw = fs.readFileSync(filepath, "utf-8");
			const data = JSON.parse(raw);
			if (!Array.isArray(data?.entries)) return;
			let changed = 0;
			for (let i = 0; i < data.entries.length; i++) {
				const before = JSON.stringify(data.entries[i]);
				data.entries[i] = normalizeEntry(data.entries[i], sourceHint);
				if (JSON.stringify(data.entries[i]) !== before) changed++;
			}
			if (changed > 0) {
				nicerWriteFileSync(filepath, JSON.stringify(data, null, 2));
				result.filesChanged++;
				result.entriesChanged += changed;
			}
		} catch (e) {
			result.errors.push({ file: path.relative(memDir, filepath), error: e.message });
		}
	}

	if (!fs.existsSync(memDir)) return result;

	const hotDir = path.join(memDir, "hot");
	if (fs.existsSync(hotDir)) {
		for (const f of fs.readdirSync(hotDir)) {
			const p = path.join(hotDir, f);
			if (fs.statSync(p).isFile() && f.endsWith(".json")) {
				upgradeFile(p, f.replace(".json", ""));
			} else if (fs.statSync(p).isDirectory()) {
				for (const sf of fs.readdirSync(p)) {
					if (sf.endsWith(".json")) upgradeFile(path.join(p, sf), f);
				}
			}
		}
	}

	const warmDir = path.join(memDir, "warm");
	if (fs.existsSync(warmDir)) {
		function walk(dir) {
			for (const f of fs.readdirSync(dir)) {
				const p = path.join(dir, f);
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (f.endsWith(".json")) upgradeFile(p, "warm");
			}
		}
		walk(warmDir);
	}

	return result;
}

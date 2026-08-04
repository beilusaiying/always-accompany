#!/usr/bin/env node
/**
 * inj_locale_check.mjs — INJ 版本化 locale 资源门禁（D3 2026-08-04）
 *
 * 【为什么存在】新用户重大 bug 根因之一：INJ「英文化/翻译」实际是大幅删减重写——identifier 与
 *   门控仍成功，所以呈现「基础功能在、示例/引导/code/work 能力死」。iter9-11 已把 zh 原文恢复进
 *   default_memory_presets.json（INJ-2 / INJ-2-code / INJ-2-work / INJ-1-chat 第一批）。本脚本
 *   把「同 {id,version} 的各 locale 文本必须语义等义（是覆盖不是删减）」变成可重跑的机器门禁，
 *   防止下一次"翻译"再静默削正文。
 *
 * 【机制】inj_locale_manifest.json 记录每条被跟踪 INJ 的：
 *   { version, locales: { "<locale>": { sha256, chars, lines, sections } } }
 *   sections = Markdown 标题结构指纹数组 [{level, ident}]：level=标题层级（# 的个数），
 *   ident=标题里第一个语言中立标识符（如 read_file / fuzzy_edit，跨 locale 不变），无则 null。
 *   跨 locale 校验只比结构指纹（标题文本本身允许翻译），小节数量/顺序/层级/工具名必须逐一相同；
 *   正文字数显著少于 zh-CN（阈值 0.9）判为删减嫌疑=失败。
 *
 * 【差量翻译】（0804 locale 解析器批）翻译单源=inj_locales/{locale}.json（格式见该目录 README）；
 *   运行时消费=injectionSystem.resolveInjectionContentForLocales（zh_sha256 精确匹配才覆盖）。
 *   校验模式对差量文件过四道闸：zh 锚对齐 / 小节结构指纹 / 字数阈值 / {{宏}} 集合一致；
 *   --write 把锚对齐的翻译登记进 manifest（TRACKED 集内）。
 *
 * 【运行】（工作目录任意，路径按本文件位置解析）
 *   node inj_locale_check.mjs           → 校验 live 模板+差量翻译 vs manifest；违规 exit 1（施工/审计门禁）
 *   node inj_locale_check.mjs --write   → 由 live 模板重建 manifest（+登记差量翻译）；已跟踪条目内容
 *                                         变化时 version+1（仅在【有意】修订后使用，随改动一并提交）
 *
 * 【边界】本脚本不改模板、不做运行时注入；(id,version,locale) 运行时解析器与 en 全文翻译是
 *   后续专项（现无 locale 选择入口，先建解析器=producer 无 consumer）。用户副本（data/users/
 *   <u>/.../_memory_presets.json）的迁移安全由 storage.mjs hash 白名单条件迁移负责，不归本脚本。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(_dir, "default_memory_presets.json");
const MANIFEST_PATH = path.join(_dir, "inj_locale_manifest.json");
const LOCALES_DIR = path.join(_dir, "inj_locales"); // 差量翻译目录（运行时消费=injectionSystem.resolveInjectionContentForLocales）
// 被跟踪的恢复 INJ（iter9-11 zh 恢复第一批）；后续恢复的条目在此追加即入门禁。
const TRACKED_IDS = ["INJ-2", "INJ-2-code", "INJ-2-work", "INJ-1-chat"];
const BASE_LOCALE = "zh-CN";
// 删减嫌疑阈值：等义翻译（尤其 zh→en）字符数通常不低于原文的 9 成（zh 信息密度更高，en 往往更长）。
const SHRINK_RATIO = 0.9;

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Markdown 标题结构指纹：[{level, ident}]（ident=标题内首个语言中立标识符，跨 locale 不变） */
function sectionManifest(content) {
  const out = [];
  for (const line of String(content).split("\n")) {
    const m = line.match(/^(#{1,4}) (.*)$/);
    if (!m) continue;
    const identMatch = m[2].match(/[A-Za-z][A-Za-z0-9_./-]{2,}/);
    out.push({ level: m[1].length, ident: identMatch ? identMatch[0] : null });
  }
  return out;
}

function localeRecord(content) {
  return {
    sha256: sha256(content),
    chars: content.length,
    lines: content.split("\n").length,
    sections: sectionManifest(content),
  };
}

const structureKey = (sections) => sections.map((s) => `${s.level}:${s.ident ?? ""}`).join("|");

/** 宏占位符集合（翻译必须逐一保留——丢宏=该功能死，正是"英文化能力死"根因形态的机器闸）。 */
const macroSet = (content) => new Set(String(content).match(/\{\{[^{}]+\}\}/g) || []);
const macroDiff = (a, b) => {
  const missing = [...a].filter((m) => !b.has(m));
  const extra = [...b].filter((m) => !a.has(m));
  return { missing, extra };
};

/** 读差量目录：{ locale: entriesObj }（目录缺失=空，翻译未落地非错误）。 */
function loadDeltaLocales() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json")); } catch { return out; }
  for (const f of files) {
    const locale = f.slice(0, -5);
    try { out[locale] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), "utf8"))?.entries || {}; }
    catch (e) { out[locale] = { __parse_error: e.message }; }
  }
  return out;
}

function loadTemplateEntries() {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));
  const byId = new Map();
  for (const e of tpl.injection_prompts || []) byId.set(e.id, e);
  return byId;
}

function main() {
  const write = process.argv.includes("--write");
  const byId = loadTemplateEntries();
  const prev = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) : null;
  const problems = [];

  if (write) {
    const manifest = {
      _comment:
        "INJ 版本化 locale 资源清单（生成器/校验器=同目录 inj_locale_check.mjs，手改无效请重跑 --write）。" +
        "语义资源以 {id,version} 为键；locale 文本是等义覆盖不是删减——跨 locale sections 结构指纹必须相同、" +
        "字数不得显著少于 zh-CN。模板 zh 正文有意修订时重跑 --write（version 自动 +1）并同批提交。",
      base_locale: BASE_LOCALE,
      entries: {},
    };
    for (const id of TRACKED_IDS) {
      const e = byId.get(id);
      if (!e) { problems.push(`[${id}] 模板中不存在，无法生成`); continue; }
      const rec = localeRecord(e.content || "");
      const prevEntry = prev?.entries?.[id];
      const prevBase = prevEntry?.locales?.[BASE_LOCALE];
      const version = prevEntry ? (prevBase && prevBase.sha256 !== rec.sha256 ? prevEntry.version + 1 : prevEntry.version) : 1;
      manifest.entries[id] = { version, locales: { [BASE_LOCALE]: rec } };
    }
    // 差量翻译目录自动登记（inj_locales/{locale}.json 是翻译单源，manifest 只做记录锚——
    // zh_sha256 不匹配 live 的翻译不登记（运行时 hash 闸也不会用它），警告可见）：
    const deltas = loadDeltaLocales();
    for (const [locale, entries] of Object.entries(deltas)) {
      if (entries.__parse_error) { problems.push(`[inj_locales/${locale}.json] JSON 损坏: ${entries.__parse_error}`); continue; }
      for (const [id, rec] of Object.entries(entries)) {
        const e = byId.get(id);
        if (!e) { console.warn(`  警告 [${locale}/${id}] 模板无此条目，跳过登记`); continue; }
        const liveSha = sha256(e.content || "");
        if (rec.zh_sha256 !== liveSha) { console.warn(`  警告 [${locale}/${id}] zh_sha256 与 live 模板不符（翻译过期/锚错），不登记（运行时也不会生效）`); continue; }
        if (!manifest.entries[id]) continue; // 非 TRACKED 条目：运行时可用（hash 闸保护），manifest 只锚跟踪集
        manifest.entries[id].locales[locale] = localeRecord(rec.content || "");
      }
    }
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`[inj_locale_check] manifest 已生成: ${MANIFEST_PATH}`);
    for (const [id, ent] of Object.entries(manifest.entries)) {
      const b = ent.locales[BASE_LOCALE];
      console.log(`  ${id} v${ent.version} ${BASE_LOCALE}: ${b.chars} chars / ${b.sections.length} sections / ${b.sha256.slice(0, 12)}…`);
    }
    return;
  }

  // 校验模式
  if (!prev) { console.error(`[inj_locale_check] 缺 manifest（先跑 --write 生成）: ${MANIFEST_PATH}`); process.exit(1); }
  for (const id of TRACKED_IDS) {
    const e = byId.get(id);
    const ent = prev.entries?.[id];
    if (!e) { problems.push(`[${id}] 模板中不存在（恢复正文被整条删除？）`); continue; }
    if (!ent) { problems.push(`[${id}] manifest 未登记（跑 --write 补齐）`); continue; }
    const live = localeRecord(e.content || "");
    const base = ent.locales?.[prev.base_locale || BASE_LOCALE];
    if (!base) { problems.push(`[${id}] manifest 缺 ${BASE_LOCALE} 基准`); continue; }
    if (live.sha256 !== base.sha256) {
      const shrink = live.chars < base.chars;
      problems.push(
        `[${id}] 模板正文与 manifest v${ent.version} 不符（${base.chars}→${live.chars} chars${shrink ? "，正文变短=删减嫌疑" : ""}）。` +
        `有意修订请跑 --write 升版并同批提交；无意=正文被静默改写，回查改动来源。`,
      );
      continue;
    }
  }
  // 差量翻译文件等义校验（inj_locales/ 实扫=翻译单源直接校 live 模板，覆盖 TRACKED 外条目）：
  //   四道闸：①zh_sha256 锚对齐（过期翻译=运行时静默失效，门禁强制同批更新）②小节结构指纹
  //   逐一相同 ③字数 ≥ zh×阈值（删减嫌疑）④{{宏}} 集合逐一相同（丢宏=该功能死）。
  const deltas = loadDeltaLocales();
  for (const [locale, entries] of Object.entries(deltas)) {
    if (entries.__parse_error) { problems.push(`[inj_locales/${locale}.json] JSON 损坏: ${entries.__parse_error}`); continue; }
    for (const [id, rec] of Object.entries(entries)) {
      const e = byId.get(id);
      if (!e) { problems.push(`[${locale}/${id}] 模板无此条目（翻译孤儿：条目已删或 id 拼错）`); continue; }
      if (typeof rec.content !== "string" || !rec.content) { problems.push(`[${locale}/${id}] 缺 content`); continue; }
      const zh = localeRecord(e.content || "");
      if (rec.zh_sha256 !== zh.sha256) {
        problems.push(`[${locale}/${id}] zh_sha256 锚与 live 模板不符——中文已修订而翻译未跟进（运行时该翻译已被 hash 闸拒用=静默失效）。重译/复核后更新 zh_sha256 并重跑 --write。`);
        continue; // 锚已断，后续等义比较无意义
      }
      const tr = localeRecord(rec.content);
      if (structureKey(tr.sections) !== structureKey(zh.sections)) {
        problems.push(`[${locale}/${id}] 小节结构与 ${BASE_LOCALE} 不同（数量/顺序/层级/标识符必须逐一相同）——翻译不得增删小节`);
      }
      if (tr.chars < zh.chars * SHRINK_RATIO) {
        problems.push(`[${locale}/${id}] 正文 ${tr.chars} chars < ${BASE_LOCALE} 的 ${Math.round(zh.chars * SHRINK_RATIO)}（阈值 ${SHRINK_RATIO}）——删减嫌疑，翻译必须语义等义`);
      }
      const md = macroDiff(macroSet(e.content), macroSet(rec.content));
      if (md.missing.length || md.extra.length) {
        problems.push(`[${locale}/${id}] 宏集合与 ${BASE_LOCALE} 不同${md.missing.length ? `，缺失: ${md.missing.join(" ")}` : ""}${md.extra.length ? `，多出: ${md.extra.join(" ")}` : ""}——{{宏}} 必须原样保留（丢宏=对应功能死）`);
      }
    }
  }
  if (problems.length) {
    console.error(`[inj_locale_check] 校验失败 ${problems.length} 项：`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log(`[inj_locale_check] OK：${TRACKED_IDS.length} 条 INJ 与 manifest 一致（locale 等义门禁通过）`);
}

main();

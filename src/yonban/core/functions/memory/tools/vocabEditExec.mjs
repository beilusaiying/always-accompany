/**
 * vocabEditExec.mjs — <vocab_edit> 执行层（P9 词库维护，2026-07-31 002拍板）
 *
 * 【功能链】
 *   AI 回复含 <vocab_edit>{file, content:{_meta,entries}, confirm?, reason?}</vocab_edit>
 *   → replyParser.parseVocabEditTags 解析（通用）
 *   → 本模块 executeVocabEditOps：格式校验 → 熔断（单次≤30 改动）→ 两态：
 *       首见/内容变化 = preview（登记 pending，返回 diff 摘要，等确认）
 *       confirm:true 且 hash 与 pending 一致 = 写入（p1Bridge.saveUserVocabFile → P1 服务原子写）
 *
 * 【why 独立模块（从 aiRunner.runMemoryPresetAI 闭包提升，0731 三次返工）】
 *   P9 已注册为子模式+预设（002"从子模式拉线"），运行走**正常对话链**（replyHandler.handleReply），
 *   不再只有 P 系列执行器一个消费方——执行层必须单点收口双方共享，否则正常对话里的
 *   <vocab_edit> 标签无人执行（断链）。
 *   pending 提为模块级：正常对话的 preview→confirm 跨两次请求，闭包态活不过一轮；
 *   多窗口对同一 file 的并发提案由 hash 校验兜底（confirm 时 hash 不符=降级为新 preview，不误写）。
 *
 * 【影响范围】消费方=aiRunner.runMemoryPresetAI（P 系列工具循环）+ replyHandler.handleReply（正常对话）；
 *   只写用户插拔词库（vocab/*.json），不碰 AT 主词库；写入校验最后防线在 P1 服务 saveUserVocab。
 */

import { getUserVocabFile, saveUserVocabFile, getP1Config } from "./p1Bridge.mjs";

// 单次改动条数熔断默认值：防 AI 失控大改。仅作无配置时兜底——生效值经 opts.maxChangesPerTag
// 由调用方从配置单源传入（P1 服务 config.vocabEditMaxChanges，前端参数面板可调）。
const DEFAULT_MAX_CHANGES_PER_TAG = 30;

// file → { hash, added, removed, modified, reason }（模块级：preview→confirm 跨请求存续）
const _vocabPending = new Map();

// hash 用 entries key 排序后 stringify（AI 二次复述 key 顺序差异不应被误判为新提案）
function _vocabHash(content) {
  const sorted = {};
  for (const k of Object.keys(content.entries).sort()) sorted[k] = content.entries[k];
  return JSON.stringify({ _meta: content._meta || null, entries: sorted });
}

function _diffVocabEntries(oldContent, newEntries) {
  const oldEntries = oldContent?.entries || {};
  const oldKeys = new Set(Object.keys(oldEntries));
  const newKeys = new Set(Object.keys(newEntries));
  let added = 0, removed = 0, modified = 0;
  for (const k of newKeys) {
    if (!oldKeys.has(k)) added++;
    else if (JSON.stringify(oldEntries[k]) !== JSON.stringify(newEntries[k])) modified++;
  }
  for (const k of oldKeys) if (!newKeys.has(k)) removed++;
  return { added, removed, modified, total: added + removed + modified };
}

/**
 * 执行一批 <vocab_edit> 块（原始 JSON 字符串数组）。
 * @param {Array<string>} blocks
 * @param {object} [opts] - {maxChangesPerTag}: 配置单源传入的熔断上限（缺省用兜底值）
 * @returns {Promise<Array>} 每块一条结果：{status:"preview"|"written"|"rejected_cap"|"error", file, ...diff, reason}
 */
export async function executeVocabEditOps(blocks, opts) {
  // 熔断上限单源=P1 服务 config.vocabEditMaxChanges（前端"词库管理"参数组可调）；
  // 显式 opts 传入恒优先；服务不可达时用代码兜底默认（诚实降级，不因取不到配置拒绝执行）。
  let _cap;
  if (Number.isFinite(Number(opts?.maxChangesPerTag))) {
    _cap = Math.max(1, Math.trunc(Number(opts.maxChangesPerTag)));
  } else {
    const _cfg = await getP1Config(opts?.username || "");
    const _cfgCap = Number(_cfg?.vocabEditMaxChanges);
    _cap = Number.isFinite(_cfgCap) && _cfgCap >= 1 ? Math.trunc(_cfgCap) : DEFAULT_MAX_CHANGES_PER_TAG;
  }
  const results = [];
  for (const raw of blocks) {
    let body;
    try { body = JSON.parse(raw); }
    catch (e) { results.push({ status: "error", reason: `JSON 解析失败: ${e.message}`, raw: raw.slice(0, 100) }); continue; }
    const file = String(body.file || "").replace(/[\\/]/g, "");
    if (!file.endsWith(".json")) { results.push({ status: "error", file, reason: "文件名必须 .json 结尾" }); continue; }
    const content = body.content;
    if (!content || typeof content !== "object" || !content.entries || typeof content.entries !== "object") {
      results.push({ status: "error", file, reason: '格式错误：需要 {file, content:{_meta, entries:{词:[关联词,...]}}}' }); continue;
    }
    // 与服务 saveUserVocab 同款格式校验先拦（减少一次跨模块往返；服务侧仍是最后防线）
    let fmtErr = null;
    for (const [k, v] of Object.entries(content.entries)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { fmtErr = `entries["${k}"] 必须是字符串数组`; break; }
    }
    if (fmtErr) { results.push({ status: "error", file, reason: fmtErr }); continue; }
    const username = String(opts?.username || "");
    const pendingKey = `${username}\0${file}`;
    const readResult = await getUserVocabFile(file, username);
    // 只有后端明确返回 E_P1_VOCAB_NOT_FOUND 才能进入新建语义。任何传输、HTTP、
    // JSON 解析或其他业务失败都必须在 diff/confirm/save 之前 fail-closed，避免以空文件
    // 作为旧内容覆盖已有用户词库；同时清掉旧 pending，恢复后必须重新 preview。
    if (readResult?.kind !== "found" && readResult?.kind !== "not_found") {
      _vocabPending.delete(pendingKey);
      const readError = readResult?.error || "P1 用户词库读取返回了未知状态";
      results.push({
        status: "error",
        file,
        code: readResult?.code || "E_P1_VOCAB_READ_STATE_INVALID",
        httpStatus: readResult?.status,
        error: readError,
        reason: `读取现有词库失败: ${readError}`,
      });
      continue;
    }
    const oldContent = readResult.kind === "found" ? readResult.content : null;
    const diff = _diffVocabEntries(oldContent, content.entries);
    if (diff.total > _cap) {
      _vocabPending.delete(pendingKey);
      results.push({ status: "rejected_cap", file, ...diff, reason: `改动 ${diff.total} 条超过单次上限 ${_cap}，请拆分为多次提交` });
      continue;
    }
    const contentHash = _vocabHash(content);
    const pending = _vocabPending.get(pendingKey);
    const isConfirmed = body.confirm === true && pending && pending.hash === contentHash;
    if (!isConfirmed) {
      _vocabPending.set(pendingKey, { hash: contentHash, ...diff, reason: String(body.reason || "") });
      results.push({ status: "preview", file, ...diff, reason: String(body.reason || "") });
      continue;
    }
    const saveRes = await saveUserVocabFile(file, content, username);
    _vocabPending.delete(pendingKey);
    if (saveRes?.success) results.push({ status: "written", file, ...diff, reason: String(body.reason || ""), entryCount: saveRes.entryCount });
    else {
      const writeError = saveRes?.error || "写入失败";
      results.push({
        status: "error",
        file,
        code: saveRes?.code,
        httpStatus: saveRes?.status,
        error: writeError,
        reason: writeError,
      });
    }
  }
  return results;
}

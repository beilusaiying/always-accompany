// textAttachment.mjs — 文本类附件内联共享层（provider 无关，单源收口）
//
// 【why】聊天附件传导链原状：各 provider 只嵌图片/音频，文本类文件（md/txt/json/代码等）在
//   proxy/grok/claude-api/ollama 全部被替换成 "can't show you" 占位或静默丢弃——AI 永远读不到
//   用户发的文档（凛倾 2026-07-16 实证：README_CN.md 附件在提示词查看器里 0 字符进上下文）。
//   gemini 走 Files API 上传是唯一健全源。本模块把「文本附件 → 可注入文本块」收口成单源，
//   各 provider 在自己的 chat_log→messages 组装点消费，禁再各自内联判定逻辑。
//
// 【判定=两段闸】① mime(text/* + 白名单) 或扩展名白名单初筛 ② 内容嗅探（前 8KB 无 NUL 字节）防伪装二进制。
// 【deref】复用 imageInjection.resolveFileBuffer（附件三态 Buffer/file:hash/base64 的既有正主）。
// 【消费方】proxy/lib/messageTransform.mjs（buildChatLogMessages + buildCompatMessages）等。
// 【截断闸】默认 30000 字符/文件，防超大文本炸 token；截断时尾部如实标注。

import { resolveFileBuffer } from "../../image/imageInjection.mjs";

export const DEFAULT_TEXT_FILE_MAX_CHARS = 30000;

// 附件占位/截断文案（0722 铁律迁移：进 messages 的文本必须用户可配，代码只持默认值——
//   覆盖链: convert_config.attachment_texts 逐键覆盖（buildMessages 沿 attachment_history 同通道下传）
//   → 本默认表。文本原样迁移未改一字；{name}/{total}/{max} 由消费点填充。
//   `[附件文件: ...]` 首尾界定符不在此表：注入结构留代码（与 XML 包裹同判据）。
export const DEFAULT_ATTACHMENT_TEXTS = {
  read_failed: "[附件: 文件 {name}（内容读取失败）]",
  history_omitted: "[附件: 文件 {name}（历史附件已省略）]",
  truncated_note: "\n[附件已截断: 原文 {total} 字符, 仅注入前 {max} 字符]",
};
/** 占位文案读取：texts 逐键覆盖 → 默认表；{k} 占位符插值 */
const _atText = (texts, key, params = {}) => {
  let t = texts?.[key] || DEFAULT_ATTACHMENT_TEXTS[key];
  for (const k in params) t = t.replaceAll(`{${k}}`, String(params[k]));
  return t;
};

const TEXT_MIME_EXACT = new Set([
  "application/json", "application/xml", "application/javascript",
  "application/x-javascript", "application/typescript", "application/x-yaml",
  "application/yaml", "application/toml", "application/x-sh", "application/sql",
  "application/csv", "image/svg+xml",
]);

const TEXT_EXT_RE = /\.(md|markdown|txt|text|json|jsonl|xml|yaml|yml|toml|csv|tsv|log|ini|cfg|conf|properties|env|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|lua|pl|r|sh|bash|zsh|bat|cmd|ps1|sql|html|htm|css|scss|less|vue|svelte|svg|tex|rst|adoc|diff|patch|gitignore|dockerfile|makefile)$/i;

/**
 * 初筛：按 mime / 扩展名判断是否文本类附件（不读内容）。
 * @param {object} file - { name?, mime_type?, type? }
 * @returns {boolean}
 */
export function isTextLikeFile(file) {
  if (!file) return false;
  const mime = (file.mime_type || file.type || "").toLowerCase().split(";")[0].trim();
  if (mime.startsWith("text/")) return true;
  if (mime && TEXT_MIME_EXACT.has(mime)) return true;
  const name = file.name || "";
  return TEXT_EXT_RE.test(name);
}

/**
 * 历史附件策略（凛倾 2026-07-16 定案）：附件全文只展示「最后一次」（最后一条 user 消息），
 * 之前轮的附件按用户配置处理——"hide"=名字占位（默认，AI 知道有附件但看不到内容，
 * 与图片"历史图片已省略"同范式）/ "block"=屏蔽无痕 / "inline"=历史也全文内联。
 * 图片历史维持既有省略策略，不归本模块管。
 *
 * @param {object} entry - chat_log 条目（{ role, files? }）
 * @param {object} opts
 * @param {boolean} opts.isLastUser - 该条目是否最后一条 user 消息（全文内联的唯一无条件对象）
 * @param {string} [opts.username] - file:hash 落盘 key
 * @param {string} [opts.historyMode] - "hide"(默认) | "block" | "inline"
 * @returns {string} 追加到该条正文尾部的文本（无内容时 ""，含前导 \n）
 */
export function buildEntryAttachmentText(entry, { isLastUser, username, historyMode = "hide", texts } = {}) {
  if (!entry?.files?.length) return "";
  const parts = [];
  for (const f of entry.files) {
    if (!isTextLikeFile(f)) continue; // 图片/音频/二进制归各源媒体路径，本函数只管文本类
    if (isLastUser || historyMode === "inline") {
      const blk = buildTextFileBlock(f, username, undefined, texts);
      if (blk) parts.push(blk);
      else parts.push(_atText(texts, "read_failed", { name: f.name || "unnamed" }));
    } else if (historyMode === "block") {
      // 屏蔽：无痕跳过
    } else {
      // hide（默认）：名字占位，与图片"历史图片已省略"同范式
      parts.push(_atText(texts, "history_omitted", { name: f.name || "unnamed" }));
    }
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}

/**
 * 找最后一条 user 消息下标（图片/音频媒体门控用——「只嵌最后一条 user 消息的媒体」维持既定语义，
 * 最后一条 user 无媒体时历史媒体照旧省略）。
 * @param {Array<object>} chatLog
 * @returns {number} 无 user 消息时 -1
 */
export function findLastUserIndex(chatLog) {
  if (!Array.isArray(chatLog)) return -1;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i]?.role === "user") return i;
  }
  return -1;
}

/**
 * 找最近一条「带文本类附件的 user 消息」下标（文本附件"最后一次全文"锚点，凛倾 0716 定案）。
 * 与媒体门控刻意不同：最后一条 user 消息可能没带附件（追问轮），此时"最后一次的附件"
 * = 更早那条带附件的消息，其全文仍应可见；若锚成纯"最后一条 user"，追问一轮后附件即降级历史。
 *
 * [0717 锚点修] 判据从「带任何附件」收紧为「带文本类附件」：本函数是文本附件的全文锚，
 *   原实现纯图/纯音频追问轮也会抢锚——用户先发 md+图、再发纯图追问时，锚落在纯图消息上
 *   （其无文本附件=锚位空耗），更早的 md 被降级历史→hide 占位（凛倾 0717 实证：README_CN.md
 *   显示"历史附件已省略"），违背上方自述的设计意图。图片/音频媒体门控走 findLastUserIndex，不受影响。
 * @param {Array<object>} chatLog
 * @returns {number} 无带文本附件 user 消息时 -1
 */
export function findLastUserFilesIndex(chatLog) {
  if (!Array.isArray(chatLog)) return -1;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i]?.role === "user" && chatLog[i]?.files?.some?.((f) => isTextLikeFile(f))) return i;
  }
  return -1;
}

/**
 * 把一个文本类附件转成可注入正文的文本块。
 * 非文本类 / deref 失败 / 内容含 NUL（伪装二进制）→ 返回 null，调用方按原媒体/占位路径处理。
 * @param {object} file - { name?, mime_type?, type?, buffer }
 * @param {string} [username] - file:hash 落盘 key（缺省仍回退 _default 桶）
 * @param {number} [maxChars] - 单文件注入上限（字符），超出截断并如实标注
 * @returns {string | null}
 */
export function buildTextFileBlock(file, username, maxChars = DEFAULT_TEXT_FILE_MAX_CHARS, texts) {
  if (!isTextLikeFile(file)) return null;
  const buf = resolveFileBuffer(file, username);
  if (!buf || buf.length === 0) return null;
  if (buf.subarray(0, 8192).includes(0)) return null;
  let text = buf.toString("utf-8");
  const total = text.length;
  let truncNote = "";
  if (total > maxChars) {
    text = text.slice(0, maxChars);
    truncNote = _atText(texts, "truncated_note", { total, max: maxChars });
  }
  const name = file.name || "unnamed";
  return `[附件文件: ${name}]\n${text}${truncNote}\n[附件文件结束: ${name}]`;
}

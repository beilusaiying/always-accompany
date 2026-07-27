// 图片注入共享层：统一 magic-bytes mime 检测 + file:hash 三态 deref + 最后一条 user 图片提取。
// 抽自 proxy/main.mjs + proxy/lib/messageTransform.mjs + grok/main.mjs 三处近乎逐字重复的实现。
// 各 provider 只需调此模块函数，不再各自内联。

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// 聊天附件实际落盘路径：data/users/{username}/shells/chat/files/{hash}（找不到回退 _default 用户）。
// 范式对齐 proxy/main.mjs:8-18 + grok/main.mjs:23-30（轻量直读磁盘，不引入 files.mjs 重型依赖）。
// 本模块位于 src/yonban/core/functions/image/（T3a·3.2 迁入），故 5 级 .. 回溯到仓库 data/
// （image→functions→core→yonban→src→仓库根；旧位 serviceGenerators/AI/_shared/ 是 6 级——搬家唯一逻辑适配点，已实测验证）。
function _readFileByHash(username, hash) {
  const _dataRoot = join(import.meta.dirname, "..", "..", "..", "..", "..", "data", "users");
  for (const u of [username, "_default"]) {
    if (!u) continue;
    const fp = join(_dataRoot, u, "shells", "chat", "files", hash);
    if (existsSync(fp)) return readFileSync(fp);
  }
  return null;
}

/**
 * 视觉模型支持的图片 MIME 集（Claude/OpenAI 视觉通道：jpeg/png/gif/webp）。
 * 语义与 claude-api/main.mjs defaultSupportedImageTypes 同源；嵌入 image_url 前必须过此闸——
 * 不支持的格式（svg/bmp/ico/avif/未知）发出去 = API 400 整轮报废
 * （0727 实证：SVG 字节被旧版 detectImageMime 兜底标成 png → Anthropic 400 → 空回复三连败）。
 */
export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

/** 该 MIME 能否作为 image_url 喂视觉模型。 */
export function isSupportedImageMime(mime) {
  return SUPPORTED_IMAGE_MIMES.has(String(mime || "").toLowerCase().split(";")[0].trim());
}

/**
 * 违规图片附件的"直接转"修复（凛倾 0727：历史上下文里已存在这种附件的会话必须能继续发）：
 * SVG 本质是 XML 文本 → 转成文本源码进上下文（AI 直接读代码，且请求不再 400）。
 * 同步实现（无 sharp 依赖）——buildCompatMessages 等消费方是同步函数。
 * 判据：mime 声明含 svg，或字节以 <svg / <?xml 开头（容忍 BOM/空白）。
 * @param {Buffer} buf
 * @param {string} mime - 存储的 mime（可能不实）
 * @returns {string | null} SVG 源码文本（超 16KB 截断），非 SVG 返回 null
 */
export function svgBufferToText(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const _mimeIsSvg = String(mime || "").toLowerCase().includes("svg");
  let head = "";
  try { head = buf.slice(0, 256).toString("utf-8").replace(/^﻿/, "").trimStart(); } catch { return null; }
  if (!_mimeIsSvg && !head.startsWith("<svg") && !head.startsWith("<?xml")) return null;
  // mime 声明 svg 但字节不像 XML → 不硬转（可能是错标的真二进制）
  if (_mimeIsSvg && !head.startsWith("<svg") && !head.startsWith("<?xml")) return null;
  const MAX = 16 * 1024;
  let text = buf.toString("utf-8");
  if (text.length > MAX) text = text.slice(0, MAX) + "\n<!-- [SVG 过长已截断] -->";
  return text;
}

/**
 * 从 Buffer magic bytes 检测实际图片 MIME（不信 mime_type 元数据）。
 * 匹配不到任何已知 magic → 返回 null（诚实降级，交调用方决策）。
 * 禁止兜底返回 "image/png"：把"检测失败"伪装成"是 png"会让 SVG/任意字节
 * 带着 png 标签发到 API 换 400（0727 空回复事故根因）。
 * @param {Buffer} buf
 * @returns {string | null}
 */
export function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length > 11 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4D) return "image/bmp";
  return null;
}

/**
 * 通用附件 buffer 三态 deref（不做图片 mime 检测——供文本附件等非图片域复用，
 * 本模块是附件落盘路径/三态解析的既有正主，故通用 deref 收口在此，不另起炉灶）。
 * 三态：① 已是 Buffer → 直接用 ② file:hash 字符串 → 从磁盘读 ③ base64 字符串 → decode
 * @param {object} file - { buffer, ... }
 * @param {string} username - file:hash 落盘 key（data/users/{username}/shells/chat/files/{hash}，回退 _default）
 * @returns {Buffer | null}
 */
export function resolveFileBuffer(file, username) {
  if (!file) return null;
  const buf = file.buffer;
  if (Buffer.isBuffer(buf)) return buf;
  if (typeof buf === "string") {
    if (buf.startsWith("file:")) return _readFileByHash(username, buf.slice(5));
    try {
      const b = Buffer.from(buf, "base64");
      return b.length > 0 ? b : null;
    } catch { return null; }
  }
  return null;
}

/**
 * file:hash 三态 deref：把 file 对象的 buffer 解析成真实 Buffer。
 * 三态：① 已是 Buffer → 直接用 ② file:hash 字符串 → 从磁盘读 ③ base64 字符串 → decode
 * @param {object} file - { buffer, mime_type?, type? }
 * @param {string} username - 用户名（file:hash 落盘 key，data/users/{username}/shells/chat/files/{hash}，回退 _default）
 * @returns {{ buffer: Buffer, mime: string } | null}
 */
export function resolveImageBuffer(file, username) {
  if (!file) return null;
  let buf = file.buffer;
  let mime = file.mime_type || file.type || "";

  if (Buffer.isBuffer(buf)) {
    mime = detectImageMime(buf) || mime;
    return { buffer: buf, mime };
  }

  if (typeof buf === "string") {
    if (buf.startsWith("file:")) {
      const hash = buf.slice(5);
      const fileBuf = _readFileByHash(username, hash);
      if (Buffer.isBuffer(fileBuf) && fileBuf.length > 0) {
        // detect null（非已知图片格式）→ 保留存储 mime 诚实透传，是否可嵌由嵌入层 isSupportedImageMime 裁决
        mime = detectImageMime(fileBuf) || mime;
        return { buffer: fileBuf, mime };
      }
      return null;
    }
    try {
      buf = Buffer.from(buf, "base64");
      if (buf.length > 0) {
        mime = detectImageMime(buf) || mime;
        return { buffer: buf, mime };
      }
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * 获取图片 MIME（兼容 mime_type / type 双字段）。
 * @param {object} file
 * @returns {string}
 */
export function getImageMime(file) {
  return file?.mime_type || file?.type || "image/png";
}

/**
 * 从消息数组中提取最后一条 user 消息的图片附件（只嵌最后一条 user，不回翻历史）。
 * @param {Array} messages - 聊天消息数组
 * @returns {{ files: Array, msgIndex: number } | null}
 */
export function pickLastUserImages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.files) && msg.files.length > 0) {
      const imgFiles = msg.files.filter(f => {
        const m = (f.mime_type || f.type || "").toLowerCase();
        return m.startsWith("image/");
      });
      if (imgFiles.length > 0) return { files: imgFiles, msgIndex: i };
    }
  }
  return null;
}

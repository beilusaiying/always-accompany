/**
 * beilu-chat 消息构建层
 * 包含：classifyApiError、sanitizeAvatar、hasMvuXmlTag、buildMvuXmlDiagSnapshot
 *       BuildChatLogEntryFromCharReply、BuildChatLogEntryFromUserMessage
 * 从 chat.mjs 拆分
 */

import { createDiag } from "../../../../../../server/diagLogger.mjs";
import { getPartDetails } from "../../../../../../server/parts_loader.mjs";

import { chatLogEntry_t } from "./models.mjs";
import { wbTrace, wbSpan, wbDetect } from "../../../../../../server/whitebox.mjs";

const diag = createDiag("chat");

// ============================================================
// API 错误友好化 — 将原始异常分类为用户可读的中文提示
// ============================================================

export function classifyApiError(e) {
  const msg = (e.message || "").toLowerCase();
  const status = e.status || e.statusCode || 0;
  const detail = e.message || String(e);
  wbDetect(null, "messageBuilder", "classifyApiError", false, detail, { status, name: e?.name });

  // 认证失败
  if (
    status === 401 ||
    status === 403 ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    (msg.includes("invalid") && msg.includes("key")) ||
    msg.includes("api key") ||
    msg.includes("apikey")
  ) {
    return `⚠️ **API 认证失败**\n\nAPI 密钥无效或已过期，请在「系统设置 → AI 服务源」中检查密钥配置。\n\n---\n*错误信息: ${detail}*`;
  }

  // 额度不足 / 频率限制
  if (
    status === 429 ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("insufficient") ||
    msg.includes("billing") ||
    msg.includes("exceeded")
  ) {
    return `⚠️ **额度不足或请求过于频繁**\n\n请检查 API 账户余额，或稍后再试。\n\n---\n*错误信息: ${detail}*`;
  }

  // 模型不存在
  if (
    status === 404 ||
    (msg.includes("model") &&
      (msg.includes("not found") || msg.includes("does not exist"))) ||
    msg.includes("no such model")
  ) {
    return `⚠️ **模型不可用**\n\n配置的模型名称可能有误或该模型不可用，请在「系统设置 → AI 服务源」中检查模型配置。\n\n---\n*错误信息: ${detail}*`;
  }

  // 连接失败
  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("socket hang up")
  ) {
    return `⚠️ **连接失败**\n\n无法连接到 API 服务器，请检查：\n- API 地址是否正确\n- 网络连接是否正常\n- 如使用代理，代理是否正常工作\n\n---\n*错误信息: ${detail}*`;
  }

  // 服务器错误
  if (status >= 500) {
    return `⚠️ **API 服务器错误 (${status})**\n\n远端服务暂时不可用，请稍后再试。\n\n---\n*错误信息: ${detail}*`;
  }

  // 通用错误（保留堆栈供调试）
  return `⚠️ **生成失败**\n\n${detail}\n\n---\n\`\`\`\n${e.stack || detail}\n\`\`\``;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 清理 avatar 字段中的未替换宏字符串（如 {{avatar}}）
 */
export function sanitizeAvatar(avatar) {
  if (!avatar || typeof avatar !== "string") return avatar;
  if (/\{\{.*\}\}/.test(avatar)) return undefined;
  return avatar;
}

function hasMvuXmlTag(text) {
  if (!text || typeof text !== "string") return false;
  return /<UpdateVariable>|<\/UpdateVariable(?:variable)?>|<JSONPatch>|<\/JSONPatch>/i.test(
    text,
  );
}

function buildMvuXmlDiagSnapshot(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: entry.id,
    role: entry.role,
    name: entry.name,
    contentLen: entry.content?.length || 0,
    showLen: entry.content_for_show?.length || 0,
    editLen: entry.content_for_edit?.length || 0,
    contentHasXml: hasMvuXmlTag(entry.content),
    showHasXml: hasMvuXmlTag(entry.content_for_show),
    editHasXml: hasMvuXmlTag(entry.content_for_edit),
    contentTail:
      typeof entry.content === "string" ? entry.content.slice(-160) : "",
    showTail:
      typeof entry.content_for_show === "string"
        ? entry.content_for_show.slice(-160)
        : "",
    editTail:
      typeof entry.content_for_edit === "string"
        ? entry.content_for_edit.slice(-160)
        : "",
  };
}

// ============================================================
// 消息构建
// ============================================================

export async function BuildChatLogEntryFromCharReply(
  result,
  new_timeSlice,
  char,
  charname,
  username,
) {
  new_timeSlice.charname = charname;
  wbTrace(null, "messageBuilder", "BuildFromCharReply:enter", { charname, contentLen: (result?.content || "").length, files: result?.files?.length || 0 });
  const { info } = (await getPartDetails(username, `chars/${charname}`)) || {};

  const entry = new chatLogEntry_t();
  Object.assign(entry, {
    name: result.name || info?.name || charname || "Unknown",
    avatar:
      sanitizeAvatar(result.avatar) ||
      sanitizeAvatar(info?.avatar) ||
      `/parts/chars:${encodeURIComponent(charname)}/image.png`,
    content: result.content,
    content_for_show: result.content_for_show,
    content_for_edit: result.content_for_edit ?? result.content,
    timeSlice: new_timeSlice,
    role: "char",
    time_stamp: new Date(),
    files: result.files || [],
    extension: result.extension || {},
    logContextBefore: result.logContextBefore,
    logContextAfter: result.logContextAfter,
  });
  const _mvuSnap = buildMvuXmlDiagSnapshot(entry);
  diag.warn(
    "[MVU XML DIAG] BuildChatLogEntryFromCharReply",
    _mvuSnap,
  );
  wbDetect(null, "messageBuilder", "BuildFromCharReply:mvuXmlLeak", !(_mvuSnap?.contentHasXml), "content 含未净化的 MVU XML 标签", _mvuSnap);
  wbTrace(null, "messageBuilder", "BuildFromCharReply:exit", { charname, contentLen: entry.content?.length || 0 });
  return entry;
}

export async function BuildChatLogEntryFromUserMessage(
  result,
  new_timeSlice,
  user,
  personaname,
  username,
) {
  new_timeSlice.playername = new_timeSlice.player_id;
  wbTrace(null, "messageBuilder", "BuildFromUserMessage:enter", { personaname, contentLen: (result?.content || "").length, files: result?.files?.length || 0 });
  const { info } =
    (personaname
      ? await getPartDetails(username, `personas/${personaname}`)
      : undefined) || {};
  const entry = new chatLogEntry_t();
  Object.assign(entry, {
    name: result.name || info?.name || new_timeSlice.player_id || username,
    avatar: sanitizeAvatar(result.avatar) || sanitizeAvatar(info?.avatar),
    content: result.content,
    // T009 B1-B4：与 BuildChatLogEntryFromCharReply 同构补设（原先两字段完全不设=用户消息编辑后恒 undefined 的病根之一）。
    // show 不用 content 兜底（用户消息无后端渲染产物，语义=无），toData 出口统一显式化。
    content_for_show: result.content_for_show,
    content_for_edit: result.content_for_edit ?? result.content,
    timeSlice: new_timeSlice,
    role: "user",
    time_stamp: new Date(),
    files: result.files || [],
    extension: result.extension || {},
  });
  return entry;
}

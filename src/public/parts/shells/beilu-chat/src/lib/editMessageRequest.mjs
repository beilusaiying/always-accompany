/**
 * 编辑消息 HTTP 契约单源。
 *
 * 两个入口（shell PUT 与 public v1 PUT）都必须在进入 chatOps 前经过这里：
 *   1. 校验稳定 editOperationId；
 *   2. 对客户端原始补丁计算稳定指纹；
 *   3. 按当前认证 username 解析附件引用/新上传字节。
 *
 * 图片格式、SVG 与压缩策略仍由既有 processImageFiles 承担；本模块不复制图片规则。
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { processImageFiles } from "../../../../../../yonban/core/functions/image/imageProcessing.mjs";
import { checkfile, getfile } from "../files.mjs";

function _requestError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function _stableJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw _requestError("edit payload contains a non-finite number", "E_EDIT_PAYLOAD_INVALID");
    return value;
  }
  if (Array.isArray(value)) return value.map(_stableJsonValue);
  if (!value || typeof value !== "object") {
    throw _requestError("edit payload contains a non-JSON value", "E_EDIT_PAYLOAD_INVALID");
  }
  const normalized = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    normalized[key] = _stableJsonValue(value[key]);
  }
  return normalized;
}

/** 对原始编辑补丁做顺序无关、表示敏感的 SHA-256 指纹。 */
export function fingerprintEditPayload(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw _requestError("edit content must be an object", "E_EDIT_CONTENT_INVALID");
  }
  const canonical = JSON.stringify(_stableJsonValue(content));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** editOperationId 是客户端一次编辑意图的稳定键；缺失时拒绝进入非幂等写链。 */
export function normalizeEditOperationId(value) {
  const operationId = typeof value === "string" ? value.trim() : "";
  if (!operationId) {
    throw _requestError("editOperationId is required", "E_EDIT_OPERATION_ID_REQUIRED");
  }
  if (operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
    throw _requestError("editOperationId format is invalid", "E_EDIT_OPERATION_ID_INVALID");
  }
  return operationId;
}

/** 只准备幂等身份，不解析附件；供响应丢失后的只读对账入口使用。 */
export function prepareEditOperationIdentity(rawContent, rawOperationId) {
  return {
    editOperationId: normalizeEditOperationId(rawOperationId),
    payloadFingerprint: fingerprintEditPayload(rawContent),
  };
}

async function _normalizeFiles(username, files) {
  if (!Array.isArray(files)) {
    throw _requestError("edit files must be an array", "E_EDIT_FILES_INVALID");
  }
  if (typeof username !== "string" || !username) {
    throw _requestError("authenticated username is required for edit attachments", "E_EDIT_FILE_OWNER_REQUIRED", 403);
  }

  const normalizedFiles = [];
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || typeof file.buffer !== "string" || !file.buffer) {
      throw _requestError(
        "edit file entry must contain a non-empty string buffer",
        "E_EDIT_FILE_INVALID",
      );
    }
    if (file.buffer.startsWith("file:")) {
      const hash = file.buffer.slice(5);
      if (!hash || !(await checkfile(username, hash))) {
        throw _requestError(
          `edit file reference does not exist for current user: ${file.name || hash || "(empty)"}`,
          "E_EDIT_FILE_REFERENCE_NOT_FOUND",
          404,
        );
      }
      normalizedFiles.push({ ...file, buffer: await getfile(username, hash) });
      continue;
    }

    const encoded = file.buffer.replace(/\s+/g, "");
    const validBase64 = encoded.length > 0
      && encoded.length % 4 === 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded);
    if (!validBase64) {
      throw _requestError(
        `edit file buffer is not valid base64: ${file.name || "(unnamed)"}`,
        "E_EDIT_FILE_BASE64_INVALID",
      );
    }
    // 新上传附件继续走原图片/SVG处理器；已有 file:hash 不重压缩。
    const processed = await processImageFiles([
      { ...file, buffer: Buffer.from(encoded, "base64") },
    ]);
    normalizedFiles.push(...processed);
  }
  return normalizedFiles;
}

/**
 * 为 HTTP 编辑入口准备 chatOps 参数。files 省略表示保留，[] 表示明确清空。
 */
export async function prepareEditMessageRequest(username, rawContent, rawOperationId) {
  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    throw _requestError("edit content must be an object", "E_EDIT_CONTENT_INVALID");
  }
  const { editOperationId, payloadFingerprint } = prepareEditOperationIdentity(
    rawContent,
    rawOperationId,
  );
  const content = { ...rawContent };
  if (Object.prototype.hasOwnProperty.call(content, "files")) {
    content.files = await _normalizeFiles(username, content.files);
  }
  return { content, editOperationId, payloadFingerprint };
}

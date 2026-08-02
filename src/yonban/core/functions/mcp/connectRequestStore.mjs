/**
 * mcpConnect 人工审查请求存储。
 *
 * 这里只登记 AI 提出的配置与用户审查流程状态；不导入、不挂载、不批准，也不连接 MCP。
 * requestConfig / normalizedConfig / requestText 在创建后不可由状态更新替换。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs";
import { getUserDataDir } from "../memory/storage_mod/storage.mjs";

const REQUEST_FILE = "_mcp_connect_requests.json";
const _requestFileLocks = new Map();

export const MCP_CONNECT_REQUEST_STATUSES = Object.freeze([
  "pending",
  "importing",
  "imported",
  "import_failed",
  "dismissed",
]);

const STATUS_TRANSITIONS = Object.freeze({
  pending: new Set(["importing", "dismissed"]),
  importing: new Set(["imported", "import_failed"]),
  imported: new Set(),
  import_failed: new Set(["importing", "dismissed"]),
  dismissed: new Set(),
});

function _isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function _hasTransport(config) {
  return _isPlainObject(config) && (
    (typeof config.command === "string" && config.command.trim() !== "") ||
    (typeof config.url === "string" && config.url.trim() !== "")
  );
}

function _safeServerName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return "";
  return name;
}

function _singleServerName(input) {
  return _safeServerName(input.serverName || input.name || input.server);
}

/**
 * 把可安全识别的输入转换为现有 ImportByText 接受的 {mcpServers:{...}}。
 * 标准 mcpServers 形状直接规范化；不确定的输入只返回 validationError，交给用户编辑。
 */
export function normalizeMcpConnectConfig(requestConfig) {
  if (!_isPlainObject(requestConfig)) {
    return {
      normalizedConfig: null,
      validationError: "请求必须是 JSON 对象；已保留原内容，可在导入前编辑。",
    };
  }

  if (Object.prototype.hasOwnProperty.call(requestConfig, "mcpServers")) {
    if (!_isPlainObject(requestConfig.mcpServers) || Object.keys(requestConfig.mcpServers).length === 0) {
      return {
        normalizedConfig: null,
        validationError: "mcpServers 必须是至少包含一个 server 的对象；可在导入前编辑。",
      };
    }
    const badEntry = Object.entries(requestConfig.mcpServers)
      .find(([name, config]) => !_safeServerName(name) || !_isPlainObject(config));
    if (badEntry) {
      return {
        normalizedConfig: null,
        validationError: `mcpServers 中的 server “${String(badEntry[0])}” 名称或配置形状无效；可在导入前编辑。`,
      };
    }
    return {
      normalizedConfig: { mcpServers: _cloneJson(requestConfig.mcpServers) },
      validationError: null,
    };
  }

  const entries = Object.entries(requestConfig);
  if (
    entries.length === 1 &&
    _safeServerName(entries[0][0]) &&
    _hasTransport(entries[0][1])
  ) {
    return {
      normalizedConfig: { mcpServers: { [entries[0][0]]: _cloneJson(entries[0][1]) } },
      validationError: null,
    };
  }

  const namedServer = _singleServerName(requestConfig);
  if (namedServer && _isPlainObject(requestConfig.config) && _hasTransport(requestConfig.config)) {
    return {
      normalizedConfig: { mcpServers: { [namedServer]: _cloneJson(requestConfig.config) } },
      validationError: null,
    };
  }

  if (namedServer && _hasTransport(requestConfig)) {
    const config = _cloneJson(requestConfig);
    delete config.serverName;
    delete config.name;
    delete config.server;
    return {
      normalizedConfig: { mcpServers: { [namedServer]: config } },
      validationError: null,
    };
  }

  return {
    normalizedConfig: null,
    validationError: "无法安全识别为标准 mcpServers 或具名的单 server 配置；已保留原内容，可在导入前编辑。",
  };
}

function _withRequestFileLock(filePath, fn) {
  const previous = _requestFileLocks.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  _requestFileLocks.set(filePath, current);
  return current.finally(() => {
    if (_requestFileLocks.get(filePath) === current) _requestFileLocks.delete(filePath);
  });
}

function _readQueue(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${REQUEST_FILE} 必须是数组`);
  }
  return parsed;
}

function _writeQueue(filePath, queue) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  nicerWriteFileSync(filePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

function _legacyRequestId(record, index) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([index, record]))
    .digest("hex")
    .slice(0, 24);
  return `mcp_legacy_${digest}`;
}

function _normalizeStoredRecord(record, index, username) {
  if (_isPlainObject(record) && typeof record.requestId === "string" && record.requestId) {
    return {
      requestId: record.requestId,
      username: typeof record.username === "string" ? record.username : username,
      chatId: typeof record.chatId === "string" ? record.chatId : "",
      requestedAt: typeof record.requestedAt === "string" ? record.requestedAt : "",
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (record.requestedAt || ""),
      status: MCP_CONNECT_REQUEST_STATUSES.includes(record.status) ? record.status : "pending",
      source: typeof record.source === "string" ? record.source : "ai:mcpConnect",
      requestText: typeof record.requestText === "string"
        ? record.requestText
        : JSON.stringify(record.requestConfig ?? null, null, 2),
      requestConfig: record.requestConfig ?? null,
      normalizedConfig: record.normalizedConfig ?? null,
      validationError: typeof record.validationError === "string" ? record.validationError : null,
      importError: typeof record.importError === "string" ? record.importError : null,
      importedParts: Array.isArray(record.importedParts) ? record.importedParts.map(String) : [],
    };
  }

  // 旧 producer 把配置字段铺在记录顶层。读侧给它稳定的确定性 ID；第一次状态更新时写回新结构。
  const legacy = _isPlainObject(record) ? record : { value: record };
  const {
    requestedAt = "",
    status = "pending",
    chatId = "",
    source = "ai:mcpConnect",
    ...requestConfig
  } = legacy;
  const normalized = normalizeMcpConnectConfig(requestConfig);
  return {
    requestId: _legacyRequestId(record, index),
    username,
    chatId: typeof chatId === "string" ? chatId : "",
    requestedAt: typeof requestedAt === "string" ? requestedAt : "",
    updatedAt: typeof requestedAt === "string" ? requestedAt : "",
    status: MCP_CONNECT_REQUEST_STATUSES.includes(status) ? status : "pending",
    source: typeof source === "string" ? source : "ai:mcpConnect",
    requestText: JSON.stringify(requestConfig, null, 2),
    requestConfig,
    normalizedConfig: normalized.normalizedConfig,
    validationError: normalized.validationError,
    importError: null,
    importedParts: [],
  };
}

export function getMcpConnectRequestPath(username, options = {}) {
  if (typeof username !== "string" || !username.trim()) {
    throw new Error("缺少 MCP 请求所属用户名");
  }
  if (username === "." || username === ".." || /[\\/:\0]/.test(username)) {
    throw new Error("非法 MCP 请求所属用户名");
  }
  if (options.usersRoot) {
    const usersRoot = path.resolve(options.usersRoot);
    const userDir = path.resolve(usersRoot, username);
    if (userDir !== usersRoot && !userDir.startsWith(`${usersRoot}${path.sep}`)) {
      throw new Error("MCP 请求用户路径越界");
    }
    return path.join(userDir, REQUEST_FILE);
  }
  // 与其它用户级配置共用同一路径权威，不能绕过 UserDictionary / BEILU_DATA_DIR。
  return path.join(path.resolve(getUserDataDir(username)), REQUEST_FILE);
}

/**
 * 登记 AI 请求。rawText 无论能否解析/规范化都会留档，供用户在现有导入框审查编辑。
 */
export async function createMcpConnectRequest({
  username,
  chatId,
  rawText,
  source = "ai:mcpConnect",
}, options = {}) {
  const filePath = options.filePath || getMcpConnectRequestPath(username, options);
  const requestText = typeof rawText === "string"
    ? rawText
    : JSON.stringify(rawText ?? null);
  let requestConfig = requestText;
  let parseError = null;
  try {
    requestConfig = JSON.parse(requestText.trim());
  } catch (error) {
    parseError = `JSON 解析失败: ${error.message}；已保留原文本，可在导入前编辑。`;
  }
  const normalized = parseError
    ? { normalizedConfig: null, validationError: parseError }
    : normalizeMcpConnectConfig(requestConfig);
  const now = new Date().toISOString();
  const record = {
    requestId: `mcp_${crypto.randomUUID()}`,
    username,
    chatId: typeof chatId === "string" ? chatId : "",
    requestedAt: now,
    updatedAt: now,
    status: "pending",
    source,
    requestText,
    requestConfig: _cloneJson(requestConfig),
    normalizedConfig: normalized.normalizedConfig,
    validationError: normalized.validationError,
    importError: null,
    importedParts: [],
  };

  await _withRequestFileLock(filePath, () => {
    const queue = _readQueue(filePath);
    queue.push(record);
    _writeQueue(filePath, queue);
  });
  return _cloneJson(record);
}

export function listMcpConnectRequests(username, { chatId, filePath, usersRoot } = {}) {
  const resolvedPath = filePath || getMcpConnectRequestPath(username, { usersRoot });
  const queue = _readQueue(resolvedPath)
    .map((record, index) => _normalizeStoredRecord(record, index, username));
  const filtered = typeof chatId === "string"
    ? queue.filter((record) => record.chatId === chatId)
    : queue;
  return filtered
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .map(_cloneJson);
}

/**
 * 只更新审查状态和导入结果元数据。不可接收或替换 requestConfig/normalizedConfig/requestText。
 */
export async function transitionMcpConnectRequest({
  username,
  requestId,
  chatId,
  nextStatus,
  importError = null,
  importedParts = [],
}, options = {}) {
  if (!MCP_CONNECT_REQUEST_STATUSES.includes(nextStatus)) {
    return { success: false, error: `非法 MCP 请求状态: ${String(nextStatus)}` };
  }
  const filePath = options.filePath || getMcpConnectRequestPath(username, options);
  return _withRequestFileLock(filePath, () => {
    const queue = _readQueue(filePath)
      .map((record, index) => _normalizeStoredRecord(record, index, username));
    const index = queue.findIndex((record) => record.requestId === requestId);
    if (index < 0) return { success: false, error: "MCP 请求不存在或不属于当前用户" };
    const current = queue[index];
    if (current.username !== username) {
      return { success: false, error: "MCP 请求不存在或不属于当前用户" };
    }
    if (typeof chatId === "string" && current.chatId !== chatId) {
      return { success: false, error: "MCP 请求不属于当前聊天" };
    }
    if (current.status === nextStatus) {
      if (nextStatus === "importing") {
        return {
          success: false,
          conflict: true,
          error: "MCP 请求正在由另一个操作处理",
          request: _cloneJson(current),
        };
      }
      return { success: true, unchanged: true, request: _cloneJson(current) };
    }
    if (!STATUS_TRANSITIONS[current.status]?.has(nextStatus)) {
      return {
        success: false,
        conflict: true,
        error: `MCP 请求状态已变更: ${current.status}，不能转为 ${nextStatus}`,
        request: _cloneJson(current),
      };
    }

    current.status = nextStatus;
    current.updatedAt = new Date().toISOString();
    current.importError = nextStatus === "import_failed"
      ? String(importError || "导入失败")
      : null;
    current.importedParts = nextStatus === "imported" && Array.isArray(importedParts)
      ? importedParts.map(String)
      : [];
    queue[index] = current;
    _writeQueue(filePath, queue);
    return { success: true, request: _cloneJson(current) };
  });
}

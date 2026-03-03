import info from "./info.json" with { type: "json" };

import { createDiag } from "../../../../server/diagLogger.mjs";

// ============================================================
// 后端诊断日志器
// ============================================================
const diag = createDiag("files");

// ============================================================
// 文件操作安全策略
// ============================================================

/**
 * @typedef {Object} FileOperation
 * @property {string} id - 操作 ID
 * @property {string} type - 操作类型 ('read' | 'write' | 'create' | 'delete' | 'list' | 'move' | 'exec')
 * @property {string} path - 文件路径
 * @property {string} [content] - 文件内容 (write/create 时)
 * @property {string} [destPath] - 目标路径 (move 时)
 * @property {string} [command] - 命令 (exec 时)
 * @property {string} status - 状态 ('pending' | 'approved' | 'rejected' | 'completed' | 'failed')
 * @property {string} [result] - 操作结果
 * @property {string} [error] - 错误信息
 * @property {number} timestamp - 时间戳
 */

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/**
 * 检查路径是否在允许列表中
 * @param {string} filePath - 待检查路径
 * @param {string[]} allowedPaths - 允许的路径前缀
 * @param {string[]} blockedPaths - 禁止的路径前缀
 * @returns {boolean}
 */
function isPathAllowed(filePath, allowedPaths, blockedPaths) {
  // 规范化路径
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  // 检查禁止列表
  for (const blocked of blockedPaths) {
    if (normalized.startsWith(blocked.replace(/\\/g, "/").toLowerCase())) {
      return false;
    }
  }

  // 如果允许列表为空，默认允许所有（除了被禁止的）
  if (allowedPaths.length === 0) return true;

  // 检查允许列表
  for (const allowed of allowedPaths) {
    if (normalized.startsWith(allowed.replace(/\\/g, "/").toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * 解析 AI 回复中的文件操作指令
 * @param {string} content - AI 回复内容
 * @returns {FileOperation[]} 解析到的操作列表
 */
function parseFileOperations(content) {
  const operations = [];

  // 从属性字符串中提取指定属性值（顺序无关，支持双引号和单引号）
  const getAttr = (attrs, name) => {
    const m = attrs.match(new RegExp(`${name}=["']([^"']*)["']`));
    return m ? m[1] : "";
  };

  // 解析 <file_op> 标签（属性顺序无关）
  // 同时匹配：<file_op ...>内容</file_op> 和自闭合 <file_op ... />
  const fileOpRegex = /<file_op\s+([\s\S]*?)(?:\/>|>([\s\S]*?)<\/file_op>)/gi;
  let match;

  while ((match = fileOpRegex.exec(content)) !== null) {
    const attrs = match[1].replace(/\/\s*$/, ""); // 去掉尾部可能残留的 /
    const body = match[2]?.trim() || "";
    const type = (getAttr(attrs, "type") || "").toLowerCase();
    if (!type) continue; // type 属性必须存在

    const op = {
      id: generateId(),
      type,
      path: getAttr(attrs, "path") || getAttr(attrs, "dir"), // 容错: dir 也接受
      destPath:
        getAttr(attrs, "dest") ||
        getAttr(attrs, "destination") ||
        getAttr(attrs, "to"), // 容错: destination/to
      command: getAttr(attrs, "command") || getAttr(attrs, "cmd"), // 容错: cmd
      content: body,
      status: "pending",
      result: "",
      error: "",
      timestamp: Date.now(),
    };

    // search 类型：宽松提取搜索词和模式
    if (op.type === "search") {
      const queryAttr =
        getAttr(attrs, "query") ||
        getAttr(attrs, "keyword") ||
        getAttr(attrs, "search"); // 容错
      const regexAttr = getAttr(attrs, "regex");
      const patternAttr = getAttr(attrs, "pattern");

      if (regexAttr && regexAttr !== "true" && regexAttr !== "false") {
        // regex 属性是实际的正则内容（不是布尔值）→ 当作搜索词 + 开启正则模式
        op.content = regexAttr;
        op.isRegex = true;
      } else {
        // query 属性 → 标签内容 → 兜底
        op.content = queryAttr || body;
        op.isRegex = regexAttr === "true";
      }
      op.filePattern =
        patternAttr || getAttr(attrs, "filter") || getAttr(attrs, "glob"); // 容错
    }

    // write/create 类型：content 属性也接受（AI 可能把内容写在属性里而非标签体内）
    if ((op.type === "write" || op.type === "create") && !body) {
      const contentAttr = getAttr(attrs, "content");
      if (contentAttr) op.content = contentAttr;
    }

    operations.push(op);
  }

  // 也支持 tool_call 格式 (类 function calling)
  const toolCallRegex =
    /<tool_call>\s*\{\s*"name"\s*:\s*"file_(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*<\/tool_call>/gi;
  while ((match = toolCallRegex.exec(content)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      operations.push({
        id: generateId(),
        type: match[1],
        path: args.path || "",
        content: args.content || "",
        destPath: args.dest || args.destPath || "",
        command: args.command || "",
        status: "pending",
        result: "",
        error: "",
        timestamp: Date.now(),
      });
    } catch {
      // JSON 解析失败，跳过
    }
  }

  return operations;
}

// ============================================================
// 辅助函数：目录树构建 & 内容签名
// ============================================================

/**
 * 构建工作区第一层目录树文本（带5秒缓存）
 * @param {string} rootPath - 根目录路径
 * @returns {Promise<string>} 目录树文本
 */
async function buildWorkspaceTree(rootPath) {
  if (typeof Deno === "undefined") return "";

  // 5秒缓存
  const now = Date.now();
  if (
    pluginData.workspaceTreeCache &&
    now - pluginData.workspaceTreeCacheTime < 5000
  ) {
    return pluginData.workspaceTreeCache;
  }

  try {
    const entries = [];
    for await (const entry of Deno.readDir(rootPath)) {
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
      });
    }

    // 排序：目录在前，文件在后
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    // 生成树形文本
    let tree = rootPath + "/\n";
    for (let i = 0; i < entries.length; i++) {
      const isLast = i === entries.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const suffix = entries[i].isDirectory ? "/" : "";
      tree += prefix + entries[i].name + suffix + "\n";
    }

    pluginData.workspaceTreeCache = tree;
    pluginData.workspaceTreeCacheTime = now;
    return tree;
  } catch (err) {
    console.log(`[beilu-files] 构建目录树失败: ${err.message}`);
    return "";
  }
}

/**
 * 生成文件操作内容的签名（用于防重复执行）
 * 仅提取 <file_op> 标签部分生成签名
 * @param {string} content - 回复内容
 * @returns {string|null} 签名字符串，无操作标签时返回 null
 */
function generateContentSignature(content) {
  const ops = content.match(/<file_op[\s\S]*?<\/file_op>/gi);
  if (!ops || ops.length === 0) return null;
  const combined = ops.join("|||");
  return "sig_" + simpleHash(combined);
}

/**
 * djb2 哈希函数
 * @param {string} str
 * @returns {string} 哈希值（16进制）
 */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

// ============================================================
// 文件内容搜索（递归）
// ============================================================

/**
 * 在指定目录中递归搜索文件内容
 * @param {string} rootDir - 搜索根目录
 * @param {string} query - 搜索关键词或正则表达式
 * @param {object} options - 搜索选项
 * @param {boolean} [options.isRegex=false] - 是否使用正则模式
 * @param {boolean} [options.caseSensitive=false] - 是否区分大小写
 * @param {string} [options.filePattern] - 文件名过滤（glob风格，如 "*.js"）
 * @param {number} [options.maxResults=50] - 最大结果数
 * @param {number} [options.maxFileSize=512000] - 跳过超过此大小的文件（字节）
 * @param {number} [options.contextLines=2] - 上下文行数
 * @param {number} [options.maxMatchesPerFile=10] - 每个文件最多匹配数
 * @returns {Promise<{matches: Array<{file: string, line: number, content: string, context: string}>, totalFiles: number, searchedFiles: number, truncated: boolean}>}
 */
async function searchFilesContent(rootDir, query, options = {}) {
  const {
    isRegex = false,
    caseSensitive = false,
    filePattern = null,
    maxResults = 50,
    maxFileSize = 512 * 1024,
    contextLines = 2,
    maxMatchesPerFile = 10,
  } = options;

  diag.time("searchFilesContent");
  diag.debug(
    `searchFilesContent: root="${rootDir}", query="${query}", isRegex=${isRegex}, filePattern=${filePattern || "(all)"}`,
  );

  if (typeof Deno === "undefined") {
    diag.warn("searchFilesContent: Deno runtime not available");
    return {
      matches: [],
      totalFiles: 0,
      searchedFiles: 0,
      truncated: false,
      error: "Requires Deno runtime",
    };
  }

  // 构建搜索模式
  let regex;
  try {
    const flags = caseSensitive ? "g" : "gi";
    regex = isRegex
      ? new RegExp(query, flags)
      : new RegExp(escapeRegExp(query), flags);
  } catch (e) {
    return {
      matches: [],
      totalFiles: 0,
      searchedFiles: 0,
      truncated: false,
      error: `Invalid regex: ${e.message}`,
    };
  }

  // 文件名过滤正则
  let fileFilterRegex = null;
  if (filePattern) {
    const escaped = filePattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    fileFilterRegex = new RegExp("^" + escaped + "$", "i");
  }

  // 二进制文件扩展名（跳过）
  const binaryExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".svg",
    ".webp",
    ".mp3",
    ".mp4",
    ".wav",
    ".avi",
    ".mkv",
    ".mov",
    ".zip",
    ".rar",
    ".7z",
    ".gz",
    ".tar",
    ".bz2",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".sqlite",
    ".db",
  ]);

  const matches = [];
  let totalFiles = 0;
  let searchedFiles = 0;
  let truncated = false;

  async function walk(dir) {
    if (truncated) return;
    let entries;
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch {
      return; // 无权限或不存在
    }

    for (const entry of entries) {
      if (truncated) return;
      const fullPath = dir + "/" + entry.name;

      if (entry.isDirectory) {
        // 跳过常见无用目录
        if (
          [
            ".git",
            "node_modules",
            ".svn",
            "__pycache__",
            ".cache",
            ".vscode",
          ].includes(entry.name)
        )
          continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile) continue;
      totalFiles++;

      // 扩展名检查：跳过二进制文件
      const extMatch = entry.name.match(/\.[^.]+$/);
      if (extMatch && binaryExts.has(extMatch[0].toLowerCase())) continue;

      // 文件名过滤
      if (fileFilterRegex && !fileFilterRegex.test(entry.name)) continue;

      // 文件大小检查
      try {
        const stat = await Deno.stat(fullPath);
        if (stat.size > maxFileSize) continue;
      } catch {
        continue;
      }

      // 读取文件内容
      try {
        const content = await Deno.readTextFile(fullPath);
        const lines = content.split("\n");
        let fileMatchCount = 0;
        searchedFiles++;

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          if (fileMatchCount >= maxMatchesPerFile) break;

          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            // 获取上下文
            const ctxStart = Math.max(0, i - contextLines);
            const ctxEnd = Math.min(lines.length - 1, i + contextLines);
            const contextArr = [];
            for (let j = ctxStart; j <= ctxEnd; j++) {
              const prefix = j === i ? "> " : "  ";
              contextArr.push(`${prefix}${j + 1} | ${lines[j]}`);
            }

            matches.push({
              file: fullPath,
              line: i + 1,
              content: lines[i].trim().substring(0, 200),
              context: contextArr.join("\n"),
            });
            fileMatchCount++;
          }
        }
      } catch {
        // 非文本文件或读取失败，跳过
      }
    }
  }

  await walk(rootDir.replace(/\/+$/, ""));
  diag.timeEnd("searchFilesContent");
  diag.debug(
    `searchFilesContent: ${matches.length} matches in ${searchedFiles}/${totalFiles} files, truncated=${truncated}`,
  );
  if (matches.length > 0) {
    diag.snapshot("searchFilesContent", {
      query,
      isRegex,
      filePattern: filePattern || "(all)",
      matchCount: matches.length,
      searchedFiles,
      totalFiles,
      truncated,
      topFiles: [...new Set(matches.map((m) => m.file))].slice(0, 5),
    });
  }
  return { matches, totalFiles, searchedFiles, truncated };
}

/**
 * 转义正则特殊字符
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// 文件操作执行器 (Deno 环境)
// ============================================================

/**
 * 执行文件操作
 * @param {FileOperation} op - 操作对象
 * @returns {Promise<FileOperation>} 执行后的操作对象
 */
async function executeFileOperation(op) {
  if (typeof Deno === "undefined") {
    op.status = "failed";
    op.error = "File operations require Deno runtime";
    return op;
  }

  try {
    switch (op.type) {
      case "read": {
        const content = await Deno.readTextFile(op.path);
        op.result = content;
        op.status = "completed";
        break;
      }
      case "write": {
        await Deno.writeTextFile(op.path, op.content);
        op.result = `Written ${op.content.length} chars to ${op.path}`;
        op.status = "completed";
        break;
      }
      case "create": {
        // 确保目录存在
        const dir = op.path
          .replace(/\\/g, "/")
          .split("/")
          .slice(0, -1)
          .join("/");
        if (dir) {
          try {
            await Deno.mkdir(dir, { recursive: true });
          } catch {
            /* 目录已存在 */
          }
        }
        await Deno.writeTextFile(op.path, op.content || "");
        op.result = `Created ${op.path}`;
        op.status = "completed";
        break;
      }
      case "delete": {
        await Deno.remove(op.path, { recursive: false });
        op.result = `Deleted ${op.path}`;
        op.status = "completed";
        break;
      }
      case "list": {
        const entries = [];
        for await (const entry of Deno.readDir(op.path || ".")) {
          entries.push({
            name: entry.name,
            isFile: entry.isFile,
            isDirectory: entry.isDirectory,
          });
        }
        op.result = JSON.stringify(entries, null, 2);
        op.status = "completed";
        break;
      }
      case "move": {
        await Deno.rename(op.path, op.destPath);
        op.result = `Moved ${op.path} → ${op.destPath}`;
        op.status = "completed";
        break;
      }
      case "search": {
        const query = op.content || op.command || "";
        if (!query) {
          op.status = "failed";
          op.error = "No search query specified";
          break;
        }
        const searchRoot = op.path || ".";
        const result = await searchFilesContent(searchRoot, query, {
          isRegex: op.isRegex || false,
          caseSensitive: op.caseSensitive || false,
          filePattern: op.filePattern || null,
          maxResults: 50,
          contextLines: 2,
        });
        if (result.error) {
          op.status = "failed";
          op.error = result.error;
        } else {
          const lines = [
            `Found ${result.matches.length} matches in ${result.searchedFiles}/${result.totalFiles} files`,
          ];
          if (result.truncated) lines.push("(results truncated)");
          lines.push("");
          for (const m of result.matches) {
            lines.push(`📄 ${m.file}:${m.line}`);
            lines.push(m.context);
            lines.push("");
          }
          op.result = lines.join("\n");
          op.status = "completed";
        }
        break;
      }
      case "exec": {
        const cmd = op.command || op.content;
        if (!cmd) {
          op.status = "failed";
          op.error = "No command specified";
          break;
        }
        const command = new Deno.Command(
          Deno.build.os === "windows" ? "cmd" : "sh",
          {
            args: Deno.build.os === "windows" ? ["/c", cmd] : ["-c", cmd],
            cwd: op.path || undefined,
            stdout: "piped",
            stderr: "piped",
          },
        );
        const output = await command.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);
        op.result = stdout + (stderr ? "\n[stderr] " + stderr : "");
        op.status = output.code === 0 ? "completed" : "failed";
        if (output.code !== 0) op.error = `Exit code: ${output.code}`;
        break;
      }
      default:
        op.status = "failed";
        op.error = `Unknown operation type: ${op.type}`;
    }
  } catch (err) {
    op.status = "failed";
    op.error = err.message || String(err);
  }

  return op;
}

// ============================================================
// 插件数据
// ============================================================

/**
 * 检查路径是否指向系统盘 (C:)，禁止访问
 * @param {string} filePath - 待检查路径
 * @returns {string|null} 如果被禁止返回错误消息，否则返回 null
 */
function checkSystemDriveBlock(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[cC]:[\\/]/.test(normalized) || /^[cC]:$/.test(normalized)) {
    return "出于安全考虑，不允许访问系统盘 (C:)";
  }
  return null;
}

let pluginData = {
  enabled: true,
  autoApprove: true, // 自动批准所有操作（AI 拥有完整文件操作权限，受沙箱限制）
  autoApproveRead: true, // 自动批准读取操作
  autoApproveList: true, // 自动批准列出目录操作
  allowExec: false, // 是否允许执行命令
  allowedPaths: [], // 允许的路径前缀 (空 = 全部允许)
  blockedPaths: [], // 禁止的路径前缀
  operationHistory: [], // FileOperation[] 操作历史
  maxHistory: 100, // 最大历史记录数
  pendingOperations: [], // 待批准的操作
  // ---- 层级权限 ----
  activeMode: "chat", // 当前 UI 模式 ('chat' | 'file' | 'memory')
  customPrompt: "", // 用户自定义提示词（文件操作场景）
  customPromptEnabled: false, // 是否启用自定义提示词
  // ---- 文件模式隔离 ----
  fileModeStartIndex: -1, // 进入文件模式时的聊天消息数量
  fileModeChat: "", // 进入文件模式时的 chatid
  // ---- IDE 工作区沙箱 ----
  workspaceRoot: "ai玩耍空间", // IDE 文件浏览器当前打开的根目录
  workspaceTreeCache: "", // 缓存的目录树文本（避免每次 GetPrompt 都读磁盘）
  workspaceTreeCacheTime: 0, // 缓存时间戳
  // ---- 已执行操作追踪（防重复执行）----
  executedOpSignatures: new Set(), // 已执行操作的签名集合
  // ---- 操作结果缓存（闭环注入）----
  pendingOpResults: [], // 待注入的操作结果（下轮 GetPrompt 注入后清空）——仅成功操作
  // ---- 操作错误队列（给用户看，不给 AI）----
  pendingErrors: [], // 失败操作的错误信息（供前端显示，触发停止自动回复）
  hasOperationErrors: false, // 是否有未处理的操作错误（前端轮询用）
  // ---- AI 文件处理能力权限开关 ----
  permissions: {
    file_read: true, // AI 是否可以读取文件
    file_write: true, // AI 是否可以写入文件
    file_delete: false, // AI 是否可以删除文件
    file_retry: true, // AI 是否可以重试操作
    mcp: false, // AI 是否可以使用 MCP
    questions: true, // AI 是否可以提问
    todo: false, // AI 是否可以管理待办
  },
};

// ============================================================
// 持久化：将权限和关键设置写入磁盘
// ============================================================

const PERSIST_FILE = "data/beilu-files-settings.json";

/** 需要持久化的字段 */
const PERSIST_KEYS = [
  "enabled",
  "autoApprove",
  "autoApproveRead",
  "autoApproveList",
  "allowExec",
  "allowedPaths",
  "blockedPaths",
  "maxHistory",
  "permissions",
  "customPrompt",
  "customPromptEnabled",
  "workspaceRoot",
];

/**
 * 从磁盘加载持久化设置，合并到 pluginData
 */
async function loadPersistedSettings() {
  if (typeof Deno === "undefined") return;
  try {
    const text = await Deno.readTextFile(PERSIST_FILE);
    const saved = JSON.parse(text);
    for (const key of PERSIST_KEYS) {
      if (saved[key] !== undefined) {
        if (key === "permissions") {
          pluginData.permissions = {
            ...pluginData.permissions,
            ...saved.permissions,
          };
        } else {
          pluginData[key] = saved[key];
        }
      }
    }
    console.log("[beilu-files] 已从磁盘恢复设置");
  } catch {
    // 文件不存在或解析失败，使用默认值
    console.log("[beilu-files] 无持久化设置文件，使用默认值");
  }
}

/**
 * 将当前设置写入磁盘（防抖：100ms 内多次调用只写一次）
 */
let _persistTimer = null;
function savePersistedSettings() {
  if (typeof Deno === "undefined") return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    try {
      const toSave = {};
      for (const key of PERSIST_KEYS) {
        toSave[key] = pluginData[key];
      }
      await Deno.writeTextFile(PERSIST_FILE, JSON.stringify(toSave, null, 2));
    } catch (err) {
      console.warn("[beilu-files] 持久化设置失败:", err.message);
    }
  }, 100);
}

// ============================================================
// beilu-files 插件导出
// ============================================================

/**
 * beilu-files 插件 — 文件操作能力
 *
 * 职责：
 * - 解析 AI 回复中的 <file_op> 标签或 tool_call
 * - 安全策略检查 (路径白名单/黑名单)
 * - 自动/手动批准文件操作
 * - 执行文件读写/创建/删除/移动/命令执行
 * - GetPrompt: 注入文件操作能力说明
 * - ReplyHandler: 解析并执行文件操作
 */
const pluginExport = {
  info,
  Load: async ({ router }) => {
    // 启动时恢复持久化设置
    await loadPersistedSettings();

    if (!router) return;

    router.get(
      "/api/parts/plugins\\:beilu-files/config/getdata",
      async (req, res) => {
        try {
          const data = await pluginExport.interfaces.config.GetData();
          res.json(data);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-files/config/setdata",
      async (req, res) => {
        try {
          const result = await pluginExport.interfaces.config.SetData(req.body);
          res.json(result || { success: true });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  },
  Unload: async () => {},
  interfaces: {
    config: {
      GetData: async () => ({
        enabled: pluginData.enabled,
        autoApprove: pluginData.autoApprove,
        autoApproveRead: pluginData.autoApproveRead,
        autoApproveList: pluginData.autoApproveList,
        allowExec: pluginData.allowExec,
        allowedPaths: pluginData.allowedPaths,
        blockedPaths: pluginData.blockedPaths,
        maxHistory: pluginData.maxHistory,
        pendingOperations: pluginData.pendingOperations,
        operationHistory: pluginData.operationHistory.slice(-20), // 只返回最近20条
        activeMode: pluginData.activeMode,
        customPrompt: pluginData.customPrompt,
        customPromptEnabled: pluginData.customPromptEnabled,
        permissions: pluginData.permissions,
        workspaceRoot: pluginData.workspaceRoot,
        _stats: {
          totalOps: pluginData.operationHistory.length,
          pendingCount: pluginData.pendingOperations.length,
          completedCount: pluginData.operationHistory.filter(
            (o) => o.status === "completed",
          ).length,
          failedCount: pluginData.operationHistory.filter(
            (o) => o.status === "failed",
          ).length,
        },
      }),
      SetData: async (data) => {
        if (!data) return;

        if (data._action) {
          switch (data._action) {
            // ======== 前端直接文件操作 ========
            case "readFile": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                const content = await Deno.readTextFile(data.path);
                return { _result: { content, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "writeFile": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                await Deno.writeTextFile(data.path, data.content || "");
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "listDir": {
              try {
                // 规范化路径：支持 Windows 绝对路径
                let dirPath = data.path || ".";
                // 将反斜杠统一为正斜杠
                dirPath = dirPath.replace(/\\/g, "/");
                // Windows 盘符根需要确保以 / 结尾 (D: → D:/)
                if (/^[a-zA-Z]:$/.test(dirPath)) dirPath += "/";

                // 安全策略：禁止访问系统盘 (C:)
                const blockMsg = checkSystemDriveBlock(dirPath);
                if (blockMsg)
                  return { _result: { error: blockMsg, path: data.path } };

                const entries = [];
                for await (const entry of Deno.readDir(dirPath)) {
                  const item = {
                    name: entry.name,
                    isFile: entry.isFile,
                    isDirectory: entry.isDirectory,
                  };
                  // 尝试获取文件信息
                  try {
                    // 拼接完整路径：盘符根 (D:/) 不要去掉尾部斜杠
                    const base = dirPath.replace(/\/+$/, "") || dirPath;
                    const fullPath = base + "/" + entry.name;
                    const stat = await Deno.stat(fullPath);
                    item.size = stat.size;
                    item.modified = stat.mtime?.toISOString() || null;
                  } catch {
                    /* 忽略 stat 失败 */
                  }
                  entries.push(item);
                }
                // 排序：目录在前，文件在后，各自按名称排序
                entries.sort((a, b) => {
                  if (a.isDirectory && !b.isDirectory) return -1;
                  if (!a.isDirectory && b.isDirectory) return 1;
                  return a.name.localeCompare(b.name);
                });
                return { _result: { entries, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "createFile": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                const dir = data.path
                  .replace(/\\/g, "/")
                  .split("/")
                  .slice(0, -1)
                  .join("/");
                if (dir) {
                  try {
                    await Deno.mkdir(dir, { recursive: true });
                  } catch {
                    /* 已存在 */
                  }
                }
                await Deno.writeTextFile(data.path, data.content || "");
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "deleteFile": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                await Deno.remove(data.path);
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "createDir": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                await Deno.mkdir(data.path, { recursive: true });
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            // ======== AI 操作审批 ========
            case "approveOp": {
              const op = pluginData.pendingOperations.find(
                (o) => o.id === data.opId,
              );
              if (op) {
                op.status = "approved";
                pluginData.pendingOperations =
                  pluginData.pendingOperations.filter(
                    (o) => o.id !== data.opId,
                  );
                const result = await executeFileOperation(op);
                pluginData.operationHistory.push(result);
                // 限制历史长度
                if (
                  pluginData.operationHistory.length > pluginData.maxHistory
                ) {
                  pluginData.operationHistory =
                    pluginData.operationHistory.slice(-pluginData.maxHistory);
                }
              }
              break;
            }
            case "rejectOp": {
              const op = pluginData.pendingOperations.find(
                (o) => o.id === data.opId,
              );
              if (op) {
                op.status = "rejected";
                pluginData.pendingOperations =
                  pluginData.pendingOperations.filter(
                    (o) => o.id !== data.opId,
                  );
                pluginData.operationHistory.push(op);
              }
              break;
            }
            case "approveAll": {
              for (const op of pluginData.pendingOperations) {
                op.status = "approved";
                const result = await executeFileOperation(op);
                pluginData.operationHistory.push(result);
              }
              pluginData.pendingOperations = [];
              break;
            }
            case "rejectAll": {
              for (const op of pluginData.pendingOperations) {
                op.status = "rejected";
                pluginData.operationHistory.push(op);
              }
              pluginData.pendingOperations = [];
              break;
            }
            case "searchFiles": {
              const blockMsg = checkSystemDriveBlock(data.path);
              if (blockMsg)
                return { _result: { error: blockMsg, path: data.path } };
              try {
                const result = await searchFilesContent(
                  data.path || ".",
                  data.query || "",
                  {
                    isRegex: data.isRegex || false,
                    caseSensitive: data.caseSensitive || false,
                    filePattern: data.filePattern || null,
                    maxResults: data.maxResults || 50,
                    contextLines: data.contextLines || 2,
                  },
                );
                return { _result: result };
              } catch (err) {
                return { _result: { error: err.message } };
              }
            }
            case "clearHistory": {
              pluginData.operationHistory = [];
              break;
            }
            case "getOperationHistory": {
              const history = pluginData.operationHistory
                .slice(-50)
                .map((op) => ({
                  operation: `${op.type} ${op.path || op.command || ""}`.trim(),
                  detail:
                    op.status === "completed"
                      ? op.type === "read"
                        ? `读取 ${op.path}`
                        : op.result?.substring(0, 100) || op.type
                      : `${op.type} ${op.path || ""} — ${op.error || op.status}`,
                  success: op.status === "completed",
                  timestamp: op.timestamp,
                }));
              const total = pluginData.operationHistory.length;
              const success = pluginData.operationHistory.filter(
                (o) => o.status === "completed",
              ).length;
              const failed = pluginData.operationHistory.filter(
                (o) => o.status === "failed",
              ).length;
              return {
                history,
                stats: { total, success, failed },
              };
            }
            case "clearOperationHistory": {
              pluginData.operationHistory = [];
              pluginData.pendingOpResults = [];
              return { success: true };
            }
            case "getPendingOpResults": {
              // 前端轮询：是否有待注入的操作结果
              return {
                hasPending: pluginData.pendingOpResults.length > 0,
                count: pluginData.pendingOpResults.length,
              };
            }
            case "consumePendingOpResults": {
              // 前端消费：返回完整结果文本并清空（一次性使用）
              if (pluginData.pendingOpResults.length === 0) {
                return { hasPending: false, resultsText: "" };
              }
              const resultsText = pluginData.pendingOpResults
                .map((r) => r.text)
                .join("\n\n");
              const count = pluginData.pendingOpResults.length;
              pluginData.pendingOpResults = [];
              console.log(
                `[beilu-files] consumePendingOpResults: 消费 ${count} 条操作结果`,
              );
              return { hasPending: true, count, resultsText };
            }
            case "getPendingErrors": {
              // 前端轮询：是否有操作错误需要显示
              return {
                hasErrors: pluginData.hasOperationErrors,
                count: pluginData.pendingErrors.length,
                errors: pluginData.pendingErrors,
              };
            }
            case "consumePendingErrors": {
              // 前端消费错误：返回错误信息并清空
              if (pluginData.pendingErrors.length === 0) {
                return { hasErrors: false, errors: [] };
              }
              const errors = [...pluginData.pendingErrors];
              const count = pluginData.pendingErrors.length;
              pluginData.pendingErrors = [];
              pluginData.hasOperationErrors = false;
              console.log(
                `[beilu-files] consumePendingErrors: 消费 ${count} 条操作错误`,
              );
              return { hasErrors: true, count, errors };
            }
            case "addAllowedPath": {
              if (data.path && !pluginData.allowedPaths.includes(data.path)) {
                pluginData.allowedPaths.push(data.path);
              }
              break;
            }
            case "removeAllowedPath": {
              pluginData.allowedPaths = pluginData.allowedPaths.filter(
                (p) => p !== data.path,
              );
              break;
            }
            case "addBlockedPath": {
              if (data.path && !pluginData.blockedPaths.includes(data.path)) {
                pluginData.blockedPaths.push(data.path);
              }
              break;
            }
            case "removeBlockedPath": {
              pluginData.blockedPaths = pluginData.blockedPaths.filter(
                (p) => p !== data.path,
              );
              break;
            }
            case "setMode": {
              const validModes = ["chat", "file", "memory"];
              if (validModes.includes(data.mode)) {
                const previousMode = pluginData.activeMode;
                pluginData.activeMode = data.mode;

                // 同步工作区根路径
                if (data.rootPath !== undefined) {
                  pluginData.workspaceRoot = data.rootPath || "ai玩耍空间";
                  // 清除目录树缓存，下次 GetPrompt 时重新读取
                  pluginData.workspaceTreeCache = "";
                  pluginData.workspaceTreeCacheTime = 0;
                  console.log(
                    `[beilu-files] 工作区根路径更新: ${pluginData.workspaceRoot}`,
                  );
                }

                // 进入文件/记忆模式：记录起始点
                if (
                  (data.mode === "file" || data.mode === "memory") &&
                  previousMode === "chat"
                ) {
                  pluginData.fileModeStartIndex =
                    data.currentMessageCount ?? -1;
                  pluginData.fileModeChat = data.chatid || "";
                  // 清除已执行操作签名（新会话不受旧签名影响）
                  pluginData.executedOpSignatures.clear();
                  console.log(
                    `[beilu-files] 进入${data.mode}模式, 起始索引=${pluginData.fileModeStartIndex}, chatid=${pluginData.fileModeChat}`,
                  );
                }

                // 退出文件/记忆模式：返回清理信息
                if (
                  data.mode === "chat" &&
                  (previousMode === "file" || previousMode === "memory")
                ) {
                  const cleanup =
                    pluginData.fileModeStartIndex >= 0 &&
                    pluginData.fileModeChat
                      ? {
                          _cleanup: {
                            chatid: pluginData.fileModeChat,
                            startIndex: pluginData.fileModeStartIndex,
                          },
                        }
                      : null;

                  pluginData.fileModeStartIndex = -1;
                  pluginData.fileModeChat = "";
                  console.log(
                    `[beilu-files] 退出${previousMode}模式, 清理信息:`,
                    cleanup,
                  );

                  if (cleanup) return cleanup;
                }
              }
              break;
            }
            case "getCleanupInfo": {
              // 返回当前文件模式的清理信息（供手动清理按钮使用）
              if (
                pluginData.fileModeStartIndex >= 0 &&
                pluginData.fileModeChat
              ) {
                return {
                  startIndex: pluginData.fileModeStartIndex,
                  chatid: pluginData.fileModeChat,
                  mode: pluginData.activeMode,
                };
              }
              return { startIndex: -1 };
            }
            case "setWorkspaceRoot": {
              pluginData.workspaceRoot = data.rootPath || "ai玩耍空间";
              pluginData.workspaceTreeCache = "";
              pluginData.workspaceTreeCacheTime = 0;
              console.log(
                `[beilu-files] 工作区根路径设置: ${pluginData.workspaceRoot}`,
              );
              break;
            }
            default:
              break;
          }
          return;
        }

        if (data.enabled !== undefined) pluginData.enabled = data.enabled;
        if (data.autoApprove !== undefined)
          pluginData.autoApprove = data.autoApprove;
        if (data.autoApproveRead !== undefined)
          pluginData.autoApproveRead = data.autoApproveRead;
        if (data.autoApproveList !== undefined)
          pluginData.autoApproveList = data.autoApproveList;
        if (data.allowExec !== undefined) pluginData.allowExec = data.allowExec;
        if (data.allowedPaths !== undefined)
          pluginData.allowedPaths = data.allowedPaths;
        if (data.blockedPaths !== undefined)
          pluginData.blockedPaths = data.blockedPaths;
        if (data.maxHistory !== undefined)
          pluginData.maxHistory = data.maxHistory;
        if (data.customPrompt !== undefined)
          pluginData.customPrompt = data.customPrompt;
        if (data.customPromptEnabled !== undefined)
          pluginData.customPromptEnabled = data.customPromptEnabled;
        if (data.permissions !== undefined) {
          pluginData.permissions = {
            ...pluginData.permissions,
            ...data.permissions,
          };
        }

        // 持久化设置到磁盘
        savePersistedSettings();
      },
    },
    chat: {
      /**
       * GetPrompt: 注入文件操作能力说明 + 工作区目录树
       *
       * 操作结果通过 text[] 返回，beilu-preset TweakPrompt Round 2
       * 会将其自动收集到 injectionBelow (@D0)
       */
      GetPrompt: async (arg) => {
        if (!pluginData.enabled) return null;

        // 层级权限：chat 模式下不注入任何内容
        if (pluginData.activeMode === "chat") return null;

        // beilu-files GetPrompt 不再注入文件操作说明（由 INJ-2 注入提示词负责）
        // 仅提供工作区元数据供 INJ-2 的宏 {{workspace_root}} / {{workspace_tree}} 使用
        const wsRoot = pluginData.workspaceRoot || "ai玩耍空间";
        const workspaceTree = await buildWorkspaceTree(wsRoot);

        // ---- 操作结果闭环注入 ----
        // 通过 text[] 返回，beilu-preset 在 TweakPrompt Round 2 中
        // 将其他插件的 text 内容自动收集到 injectionBelow (@D0)
        const textEntries = [];
        if (pluginData.pendingOpResults.length > 0) {
          const resultsText = pluginData.pendingOpResults
            .map((r) => r.text)
            .join("\n\n");
          textEntries.push({
            content: `[文件操作执行结果]\n${resultsText}\n\n请根据以上操作结果继续工作。如果所有操作都成功，请继续下一步。如果有失败的操作，请分析原因并尝试修复。`,
            role: "system",
          });
          console.log(
            `[beilu-files] GetPrompt: 通过 text[] 注入 ${pluginData.pendingOpResults.length} 条操作结果（beilu-preset 自动收集到 @D0 injectionBelow）`,
          );
          // 注入后清空（一次性使用）
          pluginData.pendingOpResults = [];
        }

        return {
          text: textEntries,
          extension: {
            workspace_root: wsRoot,
            workspace_tree: workspaceTree || "",
          },
        };
      },

      /**
       * ReplyHandler: 解析文件操作指令并执行
       * 包含：权限检查、工作区沙箱检查、防重复执行
       */
      ReplyHandler: async (reply, args) => {
        if (!pluginData.enabled) {
          console.log("[beilu-files] ReplyHandler: 插件已禁用，跳过");
          return false;
        }
        if (!reply || !reply.content) {
          console.log("[beilu-files] ReplyHandler: 无内容，跳过");
          return false;
        }

        const operations = parseFileOperations(reply.content);
        if (operations.length === 0) {
          // 静默：没有 file_op 标签时不输出日志
          return false;
        }
        console.log(
          `[beilu-files] ReplyHandler: 解析到 ${operations.length} 个文件操作`,
        );

        // ---- 防重复执行：生成内容签名 ----
        const contentSignature = generateContentSignature(reply.content);
        if (
          contentSignature &&
          pluginData.executedOpSignatures.has(contentSignature)
        ) {
          console.log(
            `[beilu-files] 跳过重复执行 (签名: ${contentSignature.substring(0, 20)}...)`,
          );
          // 仍然清除标签，但不执行操作
          reply.content = reply.content
            .replace(/<file_op[\s\S]*?<\/file_op>/gi, "")
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
            .trim();
          return false;
        }
        if (contentSignature) {
          pluginData.executedOpSignatures.add(contentSignature);
          // 限制签名集合大小（最多保留100个）
          if (pluginData.executedOpSignatures.size > 100) {
            const arr = Array.from(pluginData.executedOpSignatures);
            pluginData.executedOpSignatures = new Set(arr.slice(-50));
          }
        }

        // 权限映射：操作类型 → 权限 key
        const permissionMap = {
          read: "file_read",
          write: "file_write",
          create: "file_write", // create 归入 write 权限
          delete: "file_delete",
          list: "file_read", // list 归入 read 权限
          move: "file_write", // move 归入 write 权限
          search: "file_read", // search 归入 read 权限
          exec: "file_write", // exec 归入 write 权限
        };

        // 工作区沙箱根路径
        const wsRoot = pluginData.workspaceRoot || "ai玩耍空间";
        const wsRootNorm = wsRoot
          .replace(/\\/g, "/")
          .toLowerCase()
          .replace(/\/+$/, "");

        for (const op of operations) {
          // 安全检查: 权限开关 → 权限 OFF 时放入待审批队列（用户可手动批准）
          const requiredPermission = permissionMap[op.type];
          if (
            requiredPermission &&
            !pluginData.permissions[requiredPermission]
          ) {
            op.status = "pending";
            op.error = `需要审批: ${op.type} 操作 (${requiredPermission} 权限未开启)`;
            pluginData.pendingOperations.push(op);
            console.log(
              `[beilu-files] 操作需要审批: ${op.type} ${op.path} (${requiredPermission}=OFF) → 加入待审批队列`,
            );
            continue;
          }

          // 安全检查: exec 权限
          if (op.type === "exec" && !pluginData.allowExec) {
            op.status = "rejected";
            op.error = "Command execution is disabled";
            pluginData.operationHistory.push(op);
            continue;
          }

          // ---- 安全检查: 工作区沙箱 ----
          if (op.path && op.type !== "exec") {
            const opPathNorm = op.path
              .replace(/\\/g, "/")
              .toLowerCase()
              .replace(/\/+$/, "");
            if (
              !opPathNorm.startsWith(wsRootNorm + "/") &&
              opPathNorm !== wsRootNorm
            ) {
              op.status = "rejected";
              op.error = `Path outside workspace: "${op.path}" is not within "${wsRoot}"`;
              pluginData.operationHistory.push(op);
              console.log(
                `[beilu-files] 操作被沙箱拒绝: ${op.type} ${op.path} (工作区: ${wsRoot})`,
              );
              continue;
            }
          }
          // move 操作也检查目标路径
          if (op.destPath && op.type === "move") {
            const destNorm = op.destPath
              .replace(/\\/g, "/")
              .toLowerCase()
              .replace(/\/+$/, "");
            if (
              !destNorm.startsWith(wsRootNorm + "/") &&
              destNorm !== wsRootNorm
            ) {
              op.status = "rejected";
              op.error = `Destination outside workspace: "${op.destPath}" is not within "${wsRoot}"`;
              pluginData.operationHistory.push(op);
              console.log(
                `[beilu-files] 操作被沙箱拒绝: move dest ${op.destPath} (工作区: ${wsRoot})`,
              );
              continue;
            }
          }

          // 安全检查: 路径权限（原有白名单/黑名单）
          if (
            op.path &&
            !isPathAllowed(
              op.path,
              pluginData.allowedPaths,
              pluginData.blockedPaths,
            )
          ) {
            op.status = "rejected";
            op.error = `Path not allowed: ${op.path}`;
            pluginData.operationHistory.push(op);
            continue;
          }

          // 判断是否自动批准
          const shouldAutoApprove =
            pluginData.autoApprove ||
            (pluginData.autoApproveRead &&
              (op.type === "read" || op.type === "list")) ||
            false;

          if (shouldAutoApprove) {
            op.status = "approved";
            const result = await executeFileOperation(op);
            pluginData.operationHistory.push(result);
          } else {
            // 加入待批准队列
            pluginData.pendingOperations.push(op);
          }
        }

        // ---- 分离成功/失败操作结果 ----
        const successOps = operations.filter((op) => op.status === "completed");
        const failedOps = operations.filter((op) => op.status === "failed");

        // 成功操作 → pendingOpResults（注入给 AI 继续工作）
        if (successOps.length > 0) {
          const resultLines = successOps.map((op) => {
            const detail =
              op.type === "read"
                ? `文件内容 (${op.result?.length || 0} 字符):\n\`\`\`\n${(op.result || "").substring(0, 5000)}\n\`\`\``
                : op.type === "search"
                  ? op.result || "无匹配结果"
                  : op.result || "操作成功";
            return `✅ ${op.type} \`${op.path || op.command || ""}\`\n${detail}`;
          });

          pluginData.pendingOpResults.push({
            text: resultLines.join("\n\n"),
            timestamp: Date.now(),
            opCount: successOps.length,
          });

          console.log(
            `[beilu-files] ReplyHandler: 缓存 ${successOps.length} 条成功结果, 待下轮 GetPrompt 注入`,
          );
        }

        // 失败操作 → pendingErrors（给用户看，停止自动回复）
        if (failedOps.length > 0) {
          const errorLines = failedOps.map((op) => {
            return `❌ ${op.type} \`${op.path || op.command || ""}\`\n错误: ${op.error || "未知错误"}`;
          });

          pluginData.pendingErrors.push({
            text: errorLines.join("\n\n"),
            timestamp: Date.now(),
            opCount: failedOps.length,
            operations: failedOps.map((op) => ({
              type: op.type,
              path: op.path || "",
              error: op.error || "未知错误",
            })),
          });
          pluginData.hasOperationErrors = true;

          console.log(
            `[beilu-files] ReplyHandler: ${failedOps.length} 条操作失败, 已加入错误队列（将通知用户并停止自动回复）`,
          );
        }

        // 清除回复中的文件操作标签（包括自闭合标签）
        reply.content = reply.content
          .replace(/<file_op[\s\S]*?(?:\/>|<\/file_op>)/gi, "")
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
          .trim();

        // 操作执行后刷新目录树缓存
        pluginData.workspaceTreeCache = "";
        pluginData.workspaceTreeCacheTime = 0;

        // 限制历史长度
        if (pluginData.operationHistory.length > pluginData.maxHistory) {
          pluginData.operationHistory = pluginData.operationHistory.slice(
            -pluginData.maxHistory,
          );
        }

        return false;
      },
    },
  },
};

export default pluginExport;

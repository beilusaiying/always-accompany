/**
 * [beilu-files] — AI 文件操作的解析、安全校验、执行、审批管线。
 * 不管 AI 生成请求构建（那是 generation/getPromptHandler 的事），
 * 不管 IDE 侧工具执行（那是 YonBan/ToolExecutor 的事，本模块是本体侧对等实现），
 * 不管附件上传/下载/GC（那是 beilu-chat/files.mjs 的事）。
 *
 * 链路：
 *   AI 路径: AI 回复 → ReplyHandler → parseFileOperations() → N42 Bot 闸 →
 *     N46 always 规则 → 权限开关 → exec 闸 → validateOpSecurity() (四层纵深) →
 *     autoApprove/入待审批队列 → executeFileOperation() → pendingOpResults →
 *     GetPrompt 注入结果给 AI 继续工作
 *   前端路径: POST setdata {_action:"readFile"|"writeFile"|...} →
 *     _gateFrontendFileOp() → validateOpSecurity() → 磁盘操作
 *   审批路径: setdata {_action:"approveOp"|"approveAll"} →
 *     validateOpSecurity() (审批 ≠ 免检) → executeFileOperation()
 *
 * 影响：磁盘读写删（Deno.readTextFile/writeTextFile/remove/rename/mkdir）;
 *       Deno.Command 执行命令（exec 类型，经 deployGatedAllow 门控）;
 *       fileEditRegistry 多窗口停/激活通知;
 *       pendingOpResults/pendingErrors 队列（注入/通知）;
 *       workspaceTreeCache 刷新
 *
 * 相交：← replyHandler (调 ReplyHandler 解析 AI 回复中的 <file_op>/<tool_call>)
 *       ← getPromptHandler (调 GetPrompt, 返回值进 prompt_struct.plugin_prompts)
 *       ← beilu-preset TweakPrompt (消费 GetPrompt 返回的 text[] 到 injectionBelow)
 *       → server/path_confine.mjs (deployGatedAllow: exec/浏览器门控)
 *       → scripts/botContentShared.mjs (resolveRequestBotPermission: N42 Bot 档位)
 *       → scripts/fileEditRegistry.mjs (多开同文件停/激活: onWriteStart/onWriteComplete)
 *       → yonban/core/functions/rollback/fileHistory.mjs (文件历史,T8 壳删除后新位)
 *       → lib/gitHubIntegration.mjs (GitHub 集成)
 *
 * 安全三层架构（validateOpSecurity 四层纵深）：
 *   ① resolveCanonicalOpPath — 相对路径锚到工作区根，消化 ..
 *   ② checkSystemDriveBlock — blockedPaths + 敏感路径/扩展名/关键词
 *   ③ 工作区沙箱 — startsWith(wsRoot + "/") 边界判定
 *   ④ isPathAllowed — 白名单/黑名单边界形态比较 (=== 或 prefix + "/")
 *   三条路径（AI 主循环/前端直接 op/审批执行）共用同一闸。
 *
 * per-user 隔离（SEC 破口B）：
 *   pluginData 是 Proxy，沙箱根簇(workspaceRoot/workspaceRoots)全局共享，
 *   其余字段经 AsyncLocalStorage 按 username 隔离（163 个访问点零改动）。
 *
 * ⚠ 已知可疑点 1-C（R10 链路追踪确证）：前端直接 writeFile 不通知 fileEditRegistry
 *   (onWriteStart/onWriteComplete)，多开同文件时前端写不触发其他窗口重读。
 *   审批路径和 AI 路径已有此通知。
 */
import info from "./info.json" with { type: "json" };
import * as path from "node:path";
import fs from "node:fs"; // SEC 破口B：per-user 配置持久化（同步，F6 范式；node:fs 在 Deno 下可用，与 ideClient 同）
import { AsyncLocalStorage } from "node:async_hooks"; // SEC 破口B(T27)：per-user 上下文载体

import { createDiag } from "../../../../server/diagLogger.mjs";
// SEC-R1/审计：allowExec 经 config/setdata 可被任一登录用户翻 true（part 配置端点无 owner 闸）→ 开服务端命令执行。
//   框架级中和（与 beilu-ejs sandboxOptOut 同范式）：allowExec 的【生效】走 deployGatedAllow——
//   local（owner 自己机器）放行；server 多用户下除非 owner 显式 config.allowFileExec=true / env BEILU_FILE_EXEC=on，
//   否则非 owner 经 setdata 翻的 allowExec 不生效（exec 照常拒）。
import { deployGatedAllow } from "../../../../yonban/core/functions/security/path_confine.mjs";
// N42: Bot 来源访问档位（L0-3）单源解析——与 10 个 bot 壳共用 botContentShared
import { resolveRequestBotPermission } from "../../../../scripts/botContentShared.mjs";
import { readJsonSafe } from "../../../../scripts/safeJsonIO.mjs"; // T019：持久化设置损坏不静默重建，备份.corrupt.bak后抛错（node:fs在Deno下可用，同上F6范式）

// 操作结果回喂指令文案：0710 配置链专项收口——默认值迁入 injectTexts CATALOG（files.op_result_instruction 键），
// 用户覆盖通道落地（2026-07-08 注释挂账的「接覆盖待后批」即本批；[文件操作执行结果] 包裹=结构标注仍留代码）。
// 原 export const DEFAULT_OP_RESULT_INSTRUCTION 已删：唯一外部消费方 beilu-chat generation.mjs 前置落条
// 已改直调 injectTexts 同一键，读写同源（export 快照语义接不住运行时覆盖变更，故删非留）。
import { getInjectText } from "../../../../yonban/core/functions/injectTexts/main.mjs";
// 81: 多开同文件「主动停止+激活」单源注册表（与 beilu-memory/ideClient 共用）
import * as fileEditRegistry from "../../../../scripts/fileEditRegistry.mjs";
// A2-3：HTTP 端点鉴权中间件（未认证→401），与全站 router.get/post(path, authenticate, handler) 同型
import { authenticate } from "../../../../yonban/core/functions/security/auth.mjs";
import * as fileHistory from "../../../../yonban/core/functions/rollback/fileHistory.mjs"; // T8·回切：改指 yonban 新位实现体
import * as gitHub from "./lib/gitHubIntegration.mjs";
import { listAllChatBackups, loadChatLogSnapshot, loadChatAutoBackup, chatLogSnapshot, safeUnlink, safeTrash } from "../../../../yonban/core/functions/rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体 // T026: 删除收编回收站

// ============================================================
// 后端诊断日志器
// ============================================================
const diag = createDiag("files");

// ============================================================
// 文件操作安全策略
// ============================================================
const _fsCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
const _normCase = (s) => _fsCaseInsensitive ? s.toLowerCase() : s;

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
  // F7a：filePath 进入时已是 canonical 绝对路径（ReplyHandler 已 resolveCanonicalOpPath）。
  //   归一 + 边界形态比较（=== 或 prefix + "/"），防裸前缀误判兄弟目录
  //   （如 blocked "/a/b" 不应误拦 "/a/bc"；allowed 同理）。条目本身也 resolve+norm 同口径。
  const norm = (s) =>
    _normCase(String(s).replace(/\\/g, "/")).replace(/\/+$/, "");
  const normalized = norm(filePath);
  const within = (prefix) =>
    normalized === prefix || normalized.startsWith(prefix + "/");

  // 检查禁止列表（条目 resolve 到 canonical，与 filePath 同锚）
  for (const blocked of blockedPaths) {
    if (!blocked) continue;
    const nb = norm(path.resolve(blocked));
    if (within(nb)) return false;
  }

  // 如果允许列表为空，默认允许所有（除了被禁止的）
  if (allowedPaths.length === 0) return true;

  // 检查允许列表
  for (const allowed of allowedPaths) {
    if (!allowed) continue;
    const na = norm(path.resolve(allowed));
    if (within(na)) return true;
  }

  return false;
}

/**
 * 解析 AI 回复中的文件操作指令 — 两种协议格式。
 *
 * 链路：ReplyHandler → 本函数 → 返回 FileOperation[] 供安全校验+执行。
 *
 * 支持两种格式：
 *   1. <file_op type="..." path="..." ...>内容</file_op>（属性顺序无关，支持自闭合）
 *   2. <tool_call>{"name":"file_*","arguments":{...}}</tool_call>（类 function calling）
 *
 * 特殊类型处理：
 *   · fuzzy_edit: 子标签式 <old>...</old><new>...</new> 优先，属性式含双引号时标记
 *     _needSubtagFallback（K10/X2 协议层降级，不让截断值流到算法层）
 *   · edit_xlsx: 标签体 JSON 或属性式单格
 *   · search: 宽松提取 query/regex/pattern 属性
 *
 * @param {string} content - AI 回复内容（含 <file_op>/<tool_call> 标签）
 * @returns {FileOperation[]} 解析到的操作列表（status 均为 "pending"）
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

    // fuzzy_edit 类型：模糊匹配定位 + 替换（语义对齐 YonBan ToolExecutor.fuzzyEdit）。
    // old_string / new_string 两段文本的传递有两种写法（择一即可）：
    //   1) 属性式：<file_op type="fuzzy_edit" path="..." old_string="..." new_string="..." />
    //   2) 子标签式（推荐，含双引号/换行/尖括号一律用这个）：
    //      <file_op type="fuzzy_edit" path="..."><old>原文</old><new>新文</new></file_op>
    // 另支持 line_hint / strict 调参（与 YonBan 同名同义）。
    //
    // ★ K10/X2 协议层自动降级（凛倾 2026-06-10 拍板）：属性式传参时 getAttr 的
    //   `["']([^"']*)["']` 取值遇内容含双引号会在内层引号处截断（拿到残缺 old_string，
    //   下游静默失配或瞎改）。此处探测「属性式 old_string/new_string 含裸双引号」→
    //   不再让残缺值流到算法层硬拒，而是标记 op._needSubtagFallback，由执行层回报
    //   明确指引让 AI 下一轮改用子标签 <old>…</old><new>…</new> 重发（=协议层降级，
    //   不在算法层猜测原意）。子标签式天然规避此问题，故仅对属性式探测。
    if (op.type === "fuzzy_edit") {
      // 子标签优先（CDATA 友好），失配再回退属性。
      const oldTag = body.match(/<old>([\s\S]*?)<\/old>/i);
      const newTag = body.match(/<new>([\s\S]*?)<\/new>/i);
      // ★ 协议层降级探测：仅当某段未用子标签、且其属性值被内层双引号截断时触发。
      //   探针：属性名= 后开引号，到下一个属性边界/标签结束前，引号内含额外 " → 截断。
      const _attrTruncated = (name) => {
        const m = attrs.match(
          new RegExp(`${name}\\s*=\\s*"([^"]*)"([^\\s/>][^/>]*)`, "i"),
        );
        // m[2] 非空 = 闭引号后还粘着非空白内容（典型为内层 "code" 把真正内容切断）。
        return !!(m && m[2] && m[2].trim());
      };
      const _badOld = !oldTag && _attrTruncated("old_string");
      const _badNew = !newTag && _attrTruncated("new_string");
      if (_badOld || _badNew) {
        const _which = [_badOld && "old_string", _badNew && "new_string"]
          .filter(Boolean)
          .join(" / ");
        op._needSubtagFallback =
          `内容含双引号，属性式传参被截断（${_which}）。请改用子标签格式重发：` +
          `<file_op type="fuzzy_edit" path="${getAttr(attrs, "path") || "..."}">` +
          `<old>原文（可含任意引号/换行，无需转义）</old>` +
          `<new>新文</new></file_op>`;
      }
      op.oldString = oldTag ? oldTag[1] : getAttr(attrs, "old_string");
      op.newString = newTag ? newTag[1] : getAttr(attrs, "new_string");
      const lh = getAttr(attrs, "line_hint");
      if (lh && /^\d+$/.test(lh)) op.lineHint = parseInt(lh, 10);
      op.strict = getAttr(attrs, "strict") === "true";
      op.content = ""; // body 已被子标签消费，避免误当文件内容
    }

    // edit_xlsx 类型：xlsx 定点改公式（语义对齐 YonBan editXlsx）。edits 数组两种写法：
    //   1) 标签体放 JSON：<file_op type="edit_xlsx" path="...">[{"sheet":"Sheet1","cell":"B2","formula":"=A1+1"}]</file_op>
    //      （或 {"edits":[...]} 包一层；推荐，避免属性双引号截断）
    //   2) 单格属性式：<file_op type="edit_xlsx" path="..." cell="B2" formula="=A1+1" sheet="Sheet1" />
    if (op.type === "edit_xlsx") {
      op.edits = [];
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed)) op.edits = parsed;
          else if (parsed && Array.isArray(parsed.edits)) op.edits = parsed.edits;
          else if (parsed && parsed.cell) op.edits = [parsed];
        } catch {
          /* body 非 JSON → 落到属性式兜底 */
        }
      }
      if (op.edits.length === 0) {
        const cellAttr = getAttr(attrs, "cell");
        const formulaAttr = getAttr(attrs, "formula");
        if (cellAttr && formulaAttr) {
          const sheetAttr = getAttr(attrs, "sheet");
          op.edits = [
            sheetAttr
              ? { sheet: sheetAttr, cell: cellAttr, formula: formulaAttr }
              : { cell: cellAttr, formula: formulaAttr },
          ];
        }
      }
      op.content = ""; // body 已被 edits 消费，避免误当文件内容
    }

    // 任务C：read 分页参数（offset=起始行 0基 / limit=行数；缺省走执行层默认 2000 行）
    if (op.type === "read") {
      const _ofs = getAttr(attrs, "offset");
      const _lim = getAttr(attrs, "limit");
      if (_ofs && /^\d+$/.test(_ofs)) op.offset = parseInt(_ofs, 10);
      if (_lim && /^\d+$/.test(_lim)) op.limit = parseInt(_lim, 10);
    }
    // 任务C：insert（line=1基插入点，内容=标签体）
    if (op.type === "insert") {
      const _ln = getAttr(attrs, "line") || getAttr(attrs, "at"); // 容错: at
      if (_ln && /^\d+$/.test(_ln)) op.line = parseInt(_ln, 10);
    }
    // 任务C：replace_lines（start_line/end_line=1基闭区间，新内容=标签体）
    if (op.type === "replace_lines") {
      const _sl = getAttr(attrs, "start_line") || getAttr(attrs, "start");
      const _el = getAttr(attrs, "end_line") || getAttr(attrs, "end");
      if (_sl && /^\d+$/.test(_sl)) op.startLine = parseInt(_sl, 10);
      if (_el && /^\d+$/.test(_el)) op.endLine = parseInt(_el, 10);
    }

    operations.push(op);
  }

  // 也支持 tool_call 格式 (类 function calling)
  const toolCallRegex =
    /<tool_call>\s*\{\s*"name"\s*:\s*"file_(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*<\/tool_call>/gi;
  while ((match = toolCallRegex.exec(content)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      const op = {
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
      };
      // fuzzy_edit 经 tool_call JSON 传参：old_string/new_string/line_hint/strict
      if (op.type === "fuzzy_edit") {
        op.oldString = args.old_string ?? "";
        op.newString = args.new_string ?? "";
        if (typeof args.line_hint === "number") op.lineHint = args.line_hint;
        op.strict = args.strict === true;
      }
      // edit_xlsx 经 tool_call JSON 传参：edits 数组（[{sheet?,cell,formula}]）
      if (op.type === "edit_xlsx") {
        op.edits = Array.isArray(args.edits)
          ? args.edits
          : args.cell && args.formula
            ? [
                args.sheet
                  ? { sheet: args.sheet, cell: args.cell, formula: args.formula }
                  : { cell: args.cell, formula: args.formula },
              ]
            : [];
      }
      // 任务C：read 分页 / insert / replace_lines 经 tool_call JSON 传参（与标签式同义）
      if (op.type === "read") {
        if (typeof args.offset === "number") op.offset = args.offset;
        if (typeof args.limit === "number") op.limit = args.limit;
      }
      if (op.type === "insert" && typeof args.line === "number") op.line = args.line;
      if (op.type === "replace_lines") {
        if (typeof args.start_line === "number") op.startLine = args.start_line;
        if (typeof args.end_line === "number") op.endLine = args.end_line;
        if (typeof args.new_content === "string") op.content = args.new_content; // YonBan 同名参数容错
      }
      operations.push(op);
    } catch {
      // JSON 解析失败，跳过
    }
  }

  return operations;
}

// 默认工作区根路径（任务A防护，凛倾 2026-07-09）："ai玩耍空间"（CWD 相对，开源不锚单机绝对路径）。
// why：旧默认 "." = 整个 app 根，没用过编程软件的用户首开即暴露全部代码且 AI 沙箱兜底过宽；
//   收口到玩耍空间 = 默认防护。历史翻车点（旧值曾因目录不存在 → listDir NotFound 被回退成 "."）
//   由 Load 钩子启动时 mkdir recursive（幂等）根除——目录保证存在后此默认值才安全。
const DEFAULT_WORKSPACE_ROOT = "ai玩耍空间";

// 工作区根校验（2026-08-01 凛倾「不检测…直接创建一个」案根修——实证：YonBan 反向桥把按
//   GitHub 仓库名拼出的不存在路径 D:/…/always-accompany/ai玩耍空间 写进 canonical，
//   setWorkspaceRoot 零校验照单全收，重启后 mkdir recursive 整棵造出幽灵工作区）：
//   绝对路径根：本身存在（目录）合法；本身不存在但【父目录真实存在】也合法（=在真实项目下
//   新建玩耍空间，一层可建）；父链不存在=幽灵路径，一律拒绝且不落任何写。
//   相对路径（含默认玩耍空间）锚 CWD 恒合法。返回 null=合法，string=拒绝原因（可见报错）。
function validateWorkspaceRoot(p) {
  if (!p || !(p.startsWith("/") || /^[a-zA-Z]:/.test(p))) return null;
  try {
    if (Deno.statSync(p).isDirectory) return null;
    return `工作区根不是目录: ${p}`;
  } catch { /* 根不存在，继续查父目录 */ }
  const _norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = _norm.slice(0, _norm.lastIndexOf("/"));
  try {
    if (parent && Deno.statSync(parent).isDirectory) return null;
  } catch { /* 父目录也不存在 */ }
  return `工作区根及其父目录均不存在，拒绝创建幽灵工作区: ${p}`;
}

// ============================================================
// 辅助函数：目录树构建 & 内容签名
// ============================================================

/**
 * 将相对路径解析为绝对路径（基于Deno.cwd()）
 * @param {string} p - 路径
 * @returns {string} 绝对路径
 */
function resolveWorkspacePath(p) {
  if (!p) return p;
  // 已是绝对路径（/开头或盘符开头）
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return p;
  // 相对路径 → 拼接CWD
  try {
    return Deno.cwd().replace(/\\/g, "/") + "/" + p;
  } catch {
    return p;
  }
}

/**
 * F1/F2/F7 框架级修：单一路径解析函数（校验与执行共用同一 canonical 结果）。
 *
 * 旧 resolveOpPath 与沙箱校验各自解析（一套纯字符串拼接锚 workspaceRoot 不消化 `..`，
 * 一套 path.resolve 锚 CWD），导致「校验落点≠落盘落点」。本函数把两套合一：
 * - 根 = path.resolve(workspaceRoot)：默认值 "."（CWD）锚定到进程工作目录的绝对路径，
 *   校验与执行用同一锚（不再有"无根退回 CWD 相对"的分叉）。
 * - p 为绝对路径（/ 或 盘符开头）→ path.resolve(p)（消化 `..`）。
 * - p 为相对路径 → path.resolve(root, p)（消化 `..`，锚定 root）。
 * - 空 p → 根本身（如 list 不带 path = 列工作区根）。
 * 一律返回消化过 `..` 的绝对路径，沙箱 startsWith 与实际落盘必然一致。
 * @param {string} p
 * @returns {string} canonical 绝对路径
 */
// FT-multiwin：按会话键取工作区沙箱根。per-window 设过则用窗口根，否则回落全局 workspaceRoot（旧行为）。
function getWorkspaceRoot(sessionKey) {
  const k = sessionKey || "";
  if (k && pluginData.workspaceRoots.has(k)) return pluginData.workspaceRoots.get(k);
  return pluginData.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
}

function resolveCanonicalOpPath(p, sessionKey) {
  const root = path.resolve(getWorkspaceRoot(sessionKey));
  if (!p) return root;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return path.resolve(p);
  return path.resolve(root, p);
}

/**
 * 构建工作区第一层目录树文本（带5秒缓存）
 * @param {string} rootPath - 根目录路径
 * @returns {Promise<string>} 目录树文本
 */
function formatFileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

async function buildWorkspaceTree(rootPath) {
  if (typeof Deno === "undefined") return "";

  const now = Date.now();
  if (
    pluginData.workspaceTreeCache &&
    now - pluginData.workspaceTreeCacheTime < 5000
  ) {
    return pluginData.workspaceTreeCache;
  }

  const absRoot = resolveWorkspacePath(rootPath);
  const maxDepth = pluginData.treeDepth ?? 2;
  const showSize = pluginData.treeShowSize ?? true;
  const maxEntries = 200;
  let entryCount = 0;

  async function scanDir(dirPath, depth, prefix) {
    if (depth > maxDepth || entryCount >= maxEntries) return "";
    let result = "";
    try {
      const entries = [];
      for await (const entry of Deno.readDir(dirPath)) {
        entries.push({ name: entry.name, isDirectory: entry.isDirectory, isFile: entry.isFile });
      }
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < entries.length; i++) {
        if (entryCount >= maxEntries) { result += prefix + "└── ...(已截断)\n"; break; }
        entryCount++;
        const isLast = i === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        const e = entries[i];

        let sizeStr = "";
        if (showSize && e.isFile) {
          try {
            const stat = await Deno.stat(dirPath + "/" + e.name);
            sizeStr = " (" + formatFileSize(stat.size) + ")";
          } catch { /* ignore */ }
        }

        if (e.isDirectory) {
          result += prefix + connector + e.name + "/\n";
          if (depth < maxDepth) {
            result += await scanDir(dirPath + "/" + e.name, depth + 1, childPrefix);
          }
        } else {
          result += prefix + connector + e.name + sizeStr + "\n";
        }
      }
    } catch { /* permission denied etc */ }
    return result;
  }

  try {
    let tree = rootPath + "/\n";
    tree += await scanDir(absRoot, 1, "");
    pluginData.workspaceTreeCache = tree;
    pluginData.workspaceTreeCacheTime = now;
    return tree;
  } catch (err) {
    console.log(`[beilu-files] 构建目录树失败: ${err.message}`);
    return "";
  }
}

// 收口：file_op 标签匹配/剥离的单源正则工厂（parseFileOperations 解析口径同源——
//   自闭合 <file_op ... /> 与配对 <file_op ...>...</file_op> 都要覆盖）。
//   why：签名(防重执行)/去重剥离/主剥离原各写各的正则，签名与去重剥离漏了自闭合分支，
//   而解析器与主剥离已支持自闭合 → 只含自闭合 file_op 的回复会：签名返 null(去重完全失效可重复执行)
//   + 去重命中时残标签漏进正文。三处统一走此工厂根除口径分叉。每次 new 保证 lastIndex 干净（全局标志）。
function _fileOpTagRegex() {
  return /<file_op[\s\S]*?(?:\/>|<\/file_op>)/gi;
}

/**
 * 生成文件操作内容的签名（用于防重复执行）
 * 仅提取 <file_op> 标签部分生成签名
 * @param {string} content - 回复内容
 * @returns {string|null} 签名字符串，无操作标签时返回 null
 */
function generateContentSignature(content) {
  const ops = content.match(_fileOpTagRegex());
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

  // 任务C（对标 YonBan search-tools）：命中按文件 mtime 降序——最近改过的文件排前，
  //   AI/用户找「刚才改的东西」时命中前置。同文件内保持行号升序（稳定排序保证）。
  if (matches.length > 1) {
    const _mtimeCache = new Map();
    for (const _f of new Set(matches.map((m) => m.file))) {
      try { _mtimeCache.set(_f, (await Deno.stat(_f)).mtime?.getTime() || 0); } catch { _mtimeCache.set(_f, 0); }
    }
    matches.sort((a, b) => (_mtimeCache.get(b.file) || 0) - (_mtimeCache.get(a.file) || 0) || (a.file === b.file ? a.line - b.line : 0));
  }
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

// 收口: escapeRegExp 变体副本(字符类略异)→import 权威 scripts/escape.mjs(覆盖更全)
import { escapeRegExp } from "../../../../scripts/escape.mjs";
import { wbT, wbD } from "../../../../server/wbStub.mjs";

// ============================================================
// fuzzy_edit 辅助（语义对齐 YonBan ToolExecutor.fuzzyEdit）
// 本体不连 IDE/YonBan 时的本地模糊编辑：模糊匹配定位 + 替换。
// 失败语义与 YonBan 完全一致：
//   - 多处命中且无 line_hint → 报歧义 success:false，绝不擅自改第一处（防瞎改）。
//   - 找不到 → success:false + 返回最接近候选行 suggestions，让 AI read_file 重取。
//   - strict=true → 仅精确匹配，失败即报，不降级到容错策略。
// 降级策略链：精确 → 行 trim 容错 → 行内空白归一 → 首尾行锚点。
// 不放宽路径安全（沙箱/黑白名单/权限由上层管道统一把关，与 write 同框架）。
// ============================================================

/** 行内空白归一：连续空白压成单空格 + trim（缩进/对齐容忍） */
function _fzNormalizeInnerWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** LineTrimmed：返回所有匹配起始行下标（去前后空白逐行比对） */
function _fzFindAllTrimmedMatches(contentLines, oldLines) {
  const out = [];
  if (oldLines.length === 0) return out;
  const maxStart = contentLines.length - oldLines.length;
  for (let i = 0; i <= maxStart; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) { matched = false; break; }
    }
    if (matched) out.push(i);
  }
  return out;
}

/** 行内空白归一匹配：返回所有匹配起始行下标（比 trimmed 更宽） */
function _fzFindAllWsNormMatches(contentLines, oldLines) {
  const out = [];
  if (oldLines.length === 0) return out;
  const normOld = oldLines.map((l) => _fzNormalizeInnerWs(l));
  const maxStart = contentLines.length - oldLines.length;
  for (let i = 0; i <= maxStart; i++) {
    let matched = true;
    for (let j = 0; j < normOld.length; j++) {
      if (_fzNormalizeInnerWs(contentLines[i + j]) !== normOld[j]) { matched = false; break; }
    }
    if (matched) out.push(i);
  }
  return out;
}

/** BlockAnchor：首尾行锚点定位块（中段长度允许 ±2 行偏移） */
function _fzFindAllBlockAnchorMatches(contentLines, oldLines) {
  const out = [];
  const firstAnchor = oldLines[0];
  const lastAnchor = oldLines[oldLines.length - 1];
  const expectedLen = oldLines.length;
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstAnchor) continue;
    for (
      let endOffset = expectedLen - 2;
      endOffset <= expectedLen + 2 && i + endOffset < contentLines.length;
      endOffset++
    ) {
      if (endOffset < 1) continue;
      if (contentLines[i + endOffset].trim() === lastAnchor) {
        out.push({ start: i, length: endOffset + 1 });
        break;
      }
    }
  }
  return out;
}

/**
 * 唯一性消歧（防瞎改核心）：从多个候选起始行下标里定一个。
 * 0 个→{idx:-1}；1 个→{idx}；>1 且有 lineHint→选最近；>1 且无 hint→{idx:-1, ambiguous:[1基行号]}。
 */
function _fzPickUnique(starts, lineHint) {
  if (starts.length === 0) return { idx: -1 };
  if (starts.length === 1) return { idx: starts[0] };
  if (lineHint > 0) {
    const best = starts.reduce(
      (b, s) => (Math.abs(s + 1 - lineHint) < Math.abs(b + 1 - lineHint) ? s : b),
      starts[0],
    );
    return { idx: best };
  }
  return { idx: -1, ambiguous: starts.map((s) => s + 1) };
}

/** 简单行相似度（Jaccard），用于失配时给候选 */
function _fzLineSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 失配时返回最接近的候选位置（按首行相似度排序） */
function _fzFindClosestMatches(contentLines, oldLines, maxSuggestions) {
  if (oldLines.length === 0) return [];
  const firstLine = oldLines[0];
  const suggestions = [];
  for (let i = 0; i < contentLines.length; i++) {
    const sim = _fzLineSimilarity(contentLines[i].trim(), firstLine);
    if (sim > 0.5) {
      suggestions.push({
        line: i + 1,
        similarity: Math.round(sim * 100),
        preview: contentLines[i].trim().substring(0, 80),
      });
    }
  }
  suggestions.sort((a, b) => b.similarity - a.similarity);
  return suggestions.slice(0, maxSuggestions);
}

/**
 * 构建改动点相对上下文锚的注入文本（定点返回，抗行号漂移）。读改后文件，取改动块前 3 / 后 3 行
 * + 改动块首个非空行作 anchorText（AI 可正则回找）。机械按行切片，不解析语义（守"管道不做内容识别"）。
 * 与 YonBan ToolExecutor._buildContextAnchor 同算法口径；file_op 返回是字符串故拼成注入文本而非对象字段。
 * @param {string} absPath 改后文件绝对路径
 * @param {number} startLine 改动起始行（1-based）
 * @param {number} lineCount 改动块行数
 * @returns {Promise<string>} 注入文本（失败返空串）
 */
async function buildOpContextAnchor(absPath, startLine, lineCount) {
  try {
    const raw = (await Deno.readTextFile(absPath)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = raw.split("\n");
    const s0 = Math.max(0, startLine - 1);
    const e0 = Math.min(lines.length - 1, s0 + Math.max(1, lineCount) - 1);
    const before = lines.slice(Math.max(0, s0 - 3), s0).join(" ⏎ ");
    const after = lines.slice(e0 + 1, Math.min(lines.length, e0 + 4)).join(" ⏎ ");
    let anchorText = "";
    for (let i = s0; i <= e0 && i < lines.length; i++) {
      const t = (lines[i] || "").trim();
      if (t) { anchorText = t.slice(0, 120); break; }
    }
    let out = `📍上下文: …${before} ⟪改动⟫ ${after}…`;
    if (anchorText) out += `\n   定位锚(可正则搜): ${anchorText}`;
    return out;
  } catch {
    return "";
  }
}

/**
 * 写后回读校验（write/create/insert/replace_lines 共用）：读回全文与期望内容全等比对。
 * 对齐 YonBan 写工具 verified 语义（手册通用铁律「写操作后必查返回值」的数据源）：
 * 失败不置 failed（文件已落盘），返回标注字符串附进 op.result 让 AI 看到并自行决定重写。
 * fuzzy_edit 不走此函数——它有更细的目标行段定位校验（applyFuzzyEdit 内 verifyWrite）。
 * @param {string} absPath
 * @param {string} expected 刚写入的完整内容
 * @returns {Promise<string>} ""=校验通过；非空=⚠ 标注（附进结果）
 */
async function verifyWholeFileWrite(absPath, expected) {
  try {
    const written = await Deno.readTextFile(absPath);
    return written === expected ? "" : "\n⚠️ 写后校验失败：回读内容与写入不一致（可能被并发修改或写入不完整），请 read 确认";
  } catch (e) {
    return `\n⚠️ 写后校验异常: ${e?.message || e}`;
  }
}

/**
 * 模糊编辑执行（本地，无 IDE）。返回结果对象（含 success/strategy/message 或失败语义）。
 * 写后校验：读回目标行段逐行精确比对，确认落点正确且完整（对应 YonBan _verifyWrite 定位校验）。
 * 注：本体 beilu-files 链路现有 write/create 均无写后 syntaxCheck（node --check），
 * 故此处也不附加 syntaxCheck，保持与本体既有工具同框架（任务"若本体链已有则同样附上"——现状=无）。
 * @param {string} absPath 已解析的绝对路径
 * @param {string} oldString
 * @param {string} newString
 * @param {{lineHint?:number, strict?:boolean}} opts
 */
async function applyFuzzyEdit(absPath, oldString, newString, opts = {}) {
  const lineHint = typeof opts.lineHint === "number" ? opts.lineHint : 0;
  const strict = opts.strict === true;

  if (oldString === undefined || oldString === null)
    return { success: false, error: "缺少 old_string 参数" };
  if (!String(oldString).trim())
    return { success: false, error: "old_string 不能为空" };
  if (newString === undefined || newString === null)
    return { success: false, error: "缺少 new_string 参数" };

  const stat = await Deno.stat(absPath);
  if (stat.isDirectory) return { success: false, error: `路径是目录: ${absPath}` };
  if (stat.size > 2 * 1024 * 1024)
    return { success: false, error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)` };

  const content = await Deno.readTextFile(absPath);

  // 检测文件行尾风格（CRLF vs LF），规范化 old/new 与文件一致
  const isCRLF = content.includes("\r\n");
  const lineEnding = isCRLF ? "\r\n" : "\n";
  const normalizedOld = isCRLF
    ? oldString.replace(/\r?\n/g, "\r\n")
    : oldString.replace(/\r\n/g, "\n");
  const normalizedNew = isCRLF
    ? newString.replace(/\r?\n/g, "\r\n")
    : newString.replace(/\r\n/g, "\n");

  // 写后定位校验：读回目标行段逐行精确比对（仅归一行尾，不抹其它空白）。
  const verifyWrite = async (expectedLF, loc) => {
    try {
      const written = (await Deno.readTextFile(absPath)).replace(/\r\n/g, "\n");
      const expLF = expectedLF.replace(/\r\n/g, "\n");
      if (!expLF.trim()) return { ok: true };
      if (loc) {
        const wLines = written.split("\n");
        const region = wLines.slice(loc.startLine, loc.startLine + loc.lineCount).join("\n");
        return region === expLF
          ? { ok: true }
          : { ok: false, reason: "写入后定位校验失败：目标行段与替换内容不一致（落点错误或不完整）" };
      }
      return written.includes(expLF)
        ? { ok: true }
        : { ok: false, reason: "写入后验证失败：文件中找不到替换后的内容" };
    } catch (e) {
      return { ok: false, reason: `写入后验证异常: ${e?.message || e}` };
    }
  };

  // 策略1: 精确匹配（行尾规范化后）
  if (content.includes(normalizedOld)) {
    const allIdxs = [];
    let sf = 0;
    while (sf < content.length) {
      const fi = content.indexOf(normalizedOld, sf);
      if (fi < 0) break;
      allIdxs.push(fi);
      sf = fi + 1;
    }
    let matchIdx = allIdxs[0];
    if (allIdxs.length > 1) {
      if (lineHint > 0) {
        matchIdx = allIdxs.reduce((best, idx) => {
          const line = content.slice(0, idx).split("\n").length;
          const bestLine = content.slice(0, best).split("\n").length;
          return Math.abs(line - lineHint) < Math.abs(bestLine - lineHint) ? idx : best;
        }, allIdxs[0]);
      } else {
        const lines = allIdxs.map((idx) => content.slice(0, idx).split("\n").length);
        return {
          success: false,
          error: `匹配不唯一：old_string 精确匹配 ${allIdxs.length} 处（行 ${lines.join(", ")}）。请扩大 old_string 上下文使其唯一，或传 line_hint 指定目标行附近。绝不在歧义处瞎改。`,
          matchLines: lines,
        };
      }
    }
    const matchLine = content.slice(0, matchIdx).split("\n").length;
    const newContent = content.slice(0, matchIdx) + normalizedNew + content.slice(matchIdx + normalizedOld.length);
    await Deno.writeTextFile(absPath, newContent);
    const vr = await verifyWrite(normalizedNew);
    const oldLineCount = normalizedOld.split("\n").length;
    const newLineCount = normalizedNew.split("\n").length;
    return {
      success: true,
      strategy: "exact",
      matchLine,
      matchEnd: matchLine + newLineCount - 1,
      totalLines: newContent.split("\n").length,
      message: vr.ok ? `✓ L${matchLine} 替换${oldLineCount}→${newLineCount}行` : `✗ 写入异常: ${vr.reason}`,
      verified: vr.ok,
    };
  }

  const contentLF = isCRLF ? content.replace(/\r\n/g, "\n") : content;
  const oldLF = oldString.replace(/\r\n/g, "\n");
  const newLF = newString.replace(/\r\n/g, "\n");
  const oldLines = oldLF.split("\n").map((l) => l.trim());
  const contentLines = contentLF.split("\n");

  // strict 模式：精确失败即报，不降级
  if (strict) {
    const suggestions = _fzFindClosestMatches(contentLines, oldLines, 3);
    return {
      success: false,
      error: "strict模式：精确匹配失败，old_string在文件中不存在",
      suggestions,
    };
  }

  // 策略2: LineTrimmed（去行首尾空白）
  const trimStarts = _fzFindAllTrimmedMatches(contentLines, oldLines);
  const trimPick = _fzPickUnique(trimStarts, lineHint);
  if (trimPick.ambiguous) {
    return {
      success: false,
      error: `匹配不唯一：old_string 经空白容错后匹配 ${trimPick.ambiguous.length} 处（行 ${trimPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
      matchLines: trimPick.ambiguous,
    };
  }
  if (trimPick.idx >= 0) {
    const matchStart = trimPick.idx;
    contentLines.splice(matchStart, oldLines.length, ...newLF.split("\n"));
    await Deno.writeTextFile(absPath, contentLines.join(lineEnding));
    const newLineCount = newLF.split("\n").length;
    const vr = await verifyWrite(newLF, { startLine: matchStart, lineCount: newLineCount });
    return {
      success: true,
      strategy: "trimmed",
      matchLine: matchStart + 1,
      matchEnd: matchStart + newLineCount,
      totalLines: contentLines.length,
      message: vr.ok ? `✓ L${matchStart + 1} 空白容错替换${oldLines.length}→${newLineCount}行` : `✗ 写入异常: ${vr.reason}`,
      verified: vr.ok,
    };
  }

  // 策略2.5: 行内空白归一（缩进/对齐容忍）
  const wsStarts = _fzFindAllWsNormMatches(contentLines, oldLines);
  const wsPick = _fzPickUnique(wsStarts, lineHint);
  if (wsPick.ambiguous) {
    return {
      success: false,
      error: `匹配不唯一：old_string 经缩进/空白归一后匹配 ${wsPick.ambiguous.length} 处（行 ${wsPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
      matchLines: wsPick.ambiguous,
    };
  }
  if (wsPick.idx >= 0) {
    const wsStart = wsPick.idx;
    contentLines.splice(wsStart, oldLines.length, ...newLF.split("\n"));
    await Deno.writeTextFile(absPath, contentLines.join(lineEnding));
    const wsNewCount = newLF.split("\n").length;
    const vr = await verifyWrite(newLF, { startLine: wsStart, lineCount: wsNewCount });
    return {
      success: true,
      strategy: "ws_normalized",
      matchLine: wsStart + 1,
      matchEnd: wsStart + wsNewCount,
      totalLines: contentLines.length,
      message: vr.ok ? `✓ L${wsStart + 1} 缩进容错替换${oldLines.length}→${wsNewCount}行` : `✗ 写入异常: ${vr.reason}`,
      verified: vr.ok,
    };
  }

  // 策略3: BlockAnchor（首尾行锚定），仅 old 块 >=3 行时启用
  if (oldLines.length >= 3) {
    const anchorMatches = _fzFindAllBlockAnchorMatches(contentLines, oldLines);
    const anchorPick = _fzPickUnique(anchorMatches.map((m) => m.start), lineHint);
    if (anchorPick.ambiguous) {
      return {
        success: false,
        error: `匹配不唯一：首尾行锚点匹配 ${anchorPick.ambiguous.length} 处（行 ${anchorPick.ambiguous.join(", ")}）。请扩大 old_string 上下文，或传 line_hint 指定目标行。绝不在歧义处瞎改。`,
        matchLines: anchorPick.ambiguous,
      };
    }
    const anchorResult = anchorPick.idx >= 0
      ? anchorMatches.find((m) => m.start === anchorPick.idx) ?? { start: -1, length: 0 }
      : { start: -1, length: 0 };
    if (anchorResult.start >= 0) {
      contentLines.splice(anchorResult.start, anchorResult.length, ...newLF.split("\n"));
      await Deno.writeTextFile(absPath, contentLines.join(lineEnding));
      const anchorNewCount = newLF.split("\n").length;
      const vr = await verifyWrite(newLF, { startLine: anchorResult.start, lineCount: anchorNewCount });
      return {
        success: true,
        strategy: "anchor",
        matchLine: anchorResult.start + 1,
        matchEnd: anchorResult.start + anchorNewCount,
        totalLines: contentLines.length,
        message: vr.ok ? `✓ L${anchorResult.start + 1} 锚点替换${anchorResult.length}→${anchorNewCount}行` : `✗ 写入异常: ${vr.reason}`,
        verified: vr.ok,
      };
    }
  }

  // 全策略失配：返回最接近候选
  const suggestions = _fzFindClosestMatches(contentLines, oldLines, 3);
  return { success: false, error: "无法匹配旧内容", suggestions };
}

// ============================================================
// xlsx 能力（与 YonBan ToolExecutor 同口径，本体纯 jszip 实现）
//   读侧：read 命中 .xlsx → 每表 CSV(值) + 公式视图（公式权威从 sheet XML 抠，不依赖缓存值）。
//   写侧：edit_xlsx → zip 级定点改公式，只动目标 <c> 的 <f> 节点，其它 XML 字节原样回灌，
//         保条件格式/样式/未知扩展（openpyxl 整体重存会损坏，本法不会）。写盘前用 jszip
//         重解包+重解析修改过的 sheet XML 做完好性校验（损坏不写盘、原文件不动）。
//   依赖：仅 npm:jszip（本体已装 jszip@3.10.1，beilu-memory/lib/setDataActions.mjs 已用同款）。
//         不引入 SheetJS(xlsx)——本体未安装，值视图与校验均用 jszip 自解 XML 实现。
// ============================================================

/** 列字母→列号（A→1, AE→31）。 */
function _xlsxColToNum(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

/** 解 OOXML 内联 XML 实体（与 YonBan decodeXmlEntities 同口径）。 */
function _xlsxDecodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 解析 workbook 的 sheet 名 → worksheet xml 路径（容忍属性顺序，与 YonBan _mapXlsxSheets 同口径）。 */
function _xlsxMapSheets(wbXml, relsXml) {
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) {
      rels[id] = target.startsWith("/")
        ? target.slice(1)
        : "xl/" + target.replace(/^xl\//, "");
    }
  }
  const map = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    const rid = tag.match(/r:id="([^"]+)"/)?.[1];
    if (name && rid && rels[rid]) map[_xlsxDecodeXmlEntities(name)] = rels[rid];
  }
  return map;
}

/** 解析 sharedStrings.xml → 字符串数组（按 <si> 顺序，拼接其内全部 <t>，解实体）。 */
function _xlsxParseSharedStrings(sstXml) {
  const out = [];
  if (!sstXml) return out;
  for (const si of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const inner = si[1];
    let text = "";
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      text += _xlsxDecodeXmlEntities(t[1]);
    }
    out.push(text);
  }
  return out;
}

/**
 * 把一张 worksheet 的 XML 解成 CSV(值) + 公式列表。值优先取缓存 <v>（共享串据 t="s" 查表），
 * 公式从 <f> 抠（权威，不依赖缓存值）。机械解析不做语义识别（守"管道不做内容识别"）。
 * @returns {{ csv: string, formulas: string[] }}
 */
function _xlsxSheetToCsvAndFormulas(sheetXml, sharedStrings) {
  // 行 → { colNum → 值字符串 }
  const rows = [];
  const formulas = [];
  let maxCol = 0;
  for (const rowM of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = rowM[1];
    const rowInner = rowM[2];
    const rNum = parseInt(rowAttrs.match(/\br="(\d+)"/)?.[1] || "0", 10);
    const cells = {};
    // 单元格：带内容 <c ...>...</c> 与自闭合 <c .../>（自闭合无值，略）
    for (const cM of rowInner.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cAttrs = cM[1];
      const cInner = cM[2];
      const ref = cAttrs.match(/\br="([A-Z]+)(\d+)"/);
      if (!ref) continue;
      const colN = _xlsxColToNum(ref[1]);
      if (colN > maxCol) maxCol = colN;
      const type = cAttrs.match(/\bt="([^"]+)"/)?.[1] || "";
      // 公式（权威视图）
      const fM = cInner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
      if (fM) formulas.push(`${ref[1]}${ref[2]}: =${_xlsxDecodeXmlEntities(fM[1])}`);
      // 值（缓存）
      let val = "";
      const vM = cInner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      if (type === "inlineStr") {
        let s = "";
        for (const t of cInner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
          s += _xlsxDecodeXmlEntities(t[1]);
        }
        val = s;
      } else if (vM) {
        const raw = _xlsxDecodeXmlEntities(vM[1]);
        if (type === "s") {
          const idx = parseInt(raw, 10);
          val = Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : raw;
        } else {
          val = raw; // 数值/布尔/日期序列号等，机械原样（不做格式化）
        }
      }
      cells[colN] = val;
    }
    rows.push({ rNum, cells });
  }
  // 组 CSV：按行号顺序，列 1..maxCol 补空，CSV 转义（含逗号/引号/换行的字段加引号、内引号翻倍）
  const esc = (s) => {
    const str = String(s ?? "");
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  rows.sort((a, b) => a.rNum - b.rNum);
  const csvLines = [];
  for (const { cells } of rows) {
    const arr = [];
    for (let c = 1; c <= maxCol; c++) arr.push(esc(cells[c] ?? ""));
    // 去掉全空尾列（与 sheet_to_csv blankrows:false 行为近似：空行不输出）
    const line = arr.join(",");
    if (line.replace(/,/g, "").trim() !== "") csvLines.push(line);
  }
  return { csv: csvLines.join("\n"), formulas };
}

/**
 * 读 .xlsx → 文本视图：每表 `--- Sheet: 名 ---` + CSV(值) + `[公式 N格]` 列表。纯 jszip 解 XML。
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function extractXlsxText(absPath) {
  const { default: JSZip } = await import("npm:jszip");
  const data = await Deno.readFile(absPath); // Uint8Array
  const zip = await JSZip.loadAsync(data);
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!wbXml) throw new Error("非法 xlsx：缺 xl/workbook.xml");
  const relsXml =
    (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) || "";
  const sheetMap = _xlsxMapSheets(wbXml, relsXml); // name → path
  const sstXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = _xlsxParseSharedStrings(sstXml);

  let out = "";
  for (const [name, sp] of Object.entries(sheetMap)) {
    const sheetXml = await zip.file(sp)?.async("string");
    if (!sheetXml) continue;
    const { csv, formulas } = _xlsxSheetToCsvAndFormulas(sheetXml, sharedStrings);
    out += `--- Sheet: ${name} ---\n${csv}\n`;
    let fs2 = formulas;
    if (fs2.length > 2000) fs2 = fs2.slice(0, 2000).concat("[公式过多已截断]");
    if (fs2.length) out += `[公式 ${fs2.length}格]\n${fs2.join("\n")}\n`;
    out += "\n";
  }
  return out.trim();
}

/**
 * 任务C office 解析（凛倾 2026-07-09「还有ppt,xlsx等等…读取文件的返回」，对标 YonBan file-tools readDocument）：
 * pptx → 按 slide 顺序抽 <a:t> 文本（纯 jszip 解压，零新依赖，移植 YonBan extractPptx 同口径）。
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function extractPptxText(absPath) {
  const { default: JSZip } = await import("npm:jszip");
  const data = await Deno.readFile(absPath);
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const decodeXml = (s) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  let out = "";
  for (const n of slides) {
    const xml = await zip.file(n)?.async("string");
    if (!xml) continue;
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    out += `--- Slide ${n.match(/\d+/)[0]} ---\n${texts.join("\n")}\n\n`;
  }
  return out.trim() || "(空演示文稿)";
}

/** 可文本化解析的文档扩展名（AI read 分流 + 前端 readFileExtract 预览共用单源） */
const DOC_EXTRACT_EXTS = new Set([".xlsx", ".docx", ".pptx", ".pdf"]);

/**
 * 统一文档文本提取入口（xlsx 纯 jszip 既有实现；docx/pdf 惰性 npm import——
 * beilu 离线约束：核心启动不依赖它们，进到对应分支才加载，deno cache 后离线可用，
 * 加载失败返回明确错误提示=优雅退化不吞错）。
 * @param {string} absPath
 * @param {string} ext 含点小写扩展名（".docx"）
 * @returns {Promise<string>}
 */
async function extractDocumentText(absPath, ext) {
  switch (ext) {
    case ".xlsx":
      return await extractXlsxText(absPath);
    case ".pptx":
      return await extractPptxText(absPath);
    case ".docx": {
      const mammoth = (await import("npm:mammoth")).default;
      const data = await Deno.readFile(absPath);
      const r = await mammoth.extractRawText({ buffer: data });
      return (r?.value || "").trim() || "(空文档)";
    }
    case ".pdf": {
      // 锁 v1 子路径（对标 YonBan/Cline 同款）：v2 改 PDFParse class API 且底层 pdfjs v4 依赖 DOMMatrix；
      //   v1 函数式 + pdfjs v2.x 无 DOM 依赖，子路径绕开 index.js 启动读测试文件的 bug。Deno 实测可用。
      const pdfParse = (await import("npm:pdf-parse@1.1.1/lib/pdf-parse.js")).default;
      const data = await Deno.readFile(absPath);
      const r = await pdfParse(data);
      return (r?.text || "").trim() || "(PDF 无可提取文本)";
    }
    default:
      throw new Error(`不支持的文档格式: ${ext}`);
  }
}

/**
 * 在 sheet XML 里把某单元格设成公式：保留 s=样式属性，去 t=类型与缓存 <v>（Excel 重算）。
 * 不存在则按列/行序插入。与 YonBan _setCellFormula 同口径。
 */
function _xlsxSetCellFormula(xml, cell, formula) {
  const fEsc = formula
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const keepStyle = (attrs) => attrs.match(/\ss="\d+"/)?.[0] ?? "";
  const reFull = new RegExp(`<c r="${cell}"([^>]*?)>[\\s\\S]*?</c>`);
  const reSelf = new RegExp(`<c r="${cell}"([^>]*?)/>`);
  if (reFull.test(xml)) {
    return xml.replace(
      reFull,
      (_m, a) => `<c r="${cell}"${keepStyle(a)}><f>${fEsc}</f></c>`,
    );
  }
  if (reSelf.test(xml)) {
    return xml.replace(
      reSelf,
      (_m, a) => `<c r="${cell}"${keepStyle(a)}><f>${fEsc}</f></c>`,
    );
  }
  // 单元格不存在 → 插入
  const mm = cell.match(/^([A-Z]+)(\d+)$/);
  if (!mm) throw new Error(`非法单元格引用: ${cell}`);
  const col = mm[1];
  const rowNum = parseInt(mm[2], 10);
  const colN = _xlsxColToNum(col);
  const newCell = `<c r="${cell}"><f>${fEsc}</f></c>`;
  // 行存在（含自闭合）
  const reRow = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
  const reRowSelf = new RegExp(`<row r="${rowNum}"([^>]*)/>`);
  if (reRow.test(xml)) {
    return xml.replace(reRow, (_m, attrs, inner) => {
      const cellRe = /<c r="([A-Z]+)\d+"/g;
      let pos = -1;
      let c;
      while ((c = cellRe.exec(inner)) !== null) {
        if (_xlsxColToNum(c[1]) > colN) {
          pos = c.index;
          break;
        }
      }
      const ni =
        pos >= 0 ? inner.slice(0, pos) + newCell + inner.slice(pos) : inner + newCell;
      return `<row r="${rowNum}"${attrs}>${ni}</row>`;
    });
  }
  if (reRowSelf.test(xml)) {
    return xml.replace(
      reRowSelf,
      (_m, attrs) => `<row r="${rowNum}"${attrs}>${newCell}</row>`,
    );
  }
  // 行不存在 → 插入新 row 到 sheetData（按行号序）
  const sdRe = /(<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>)/;
  const sm = xml.match(sdRe);
  if (!sm) throw new Error("非法 sheet：缺 sheetData");
  const inner = sm[2];
  const rowRe = /<row r="(\d+)"/g;
  let pos = -1;
  let r;
  while ((r = rowRe.exec(inner)) !== null) {
    if (parseInt(r[1], 10) > rowNum) {
      pos = r.index;
      break;
    }
  }
  const newRow = `<row r="${rowNum}">${newCell}</row>`;
  const ni =
    pos >= 0 ? inner.slice(0, pos) + newRow + inner.slice(pos) : inner + newRow;
  return xml.replace(sdRe, `$1${ni}$3`);
}

/**
 * 安全改 xlsx 公式（zip 级定点改写）。edits=[{sheet?,cell,formula}]。与 YonBan editXlsx 同口径。
 * 写盘前用 jszip 重解包并重解析改过的 sheet XML 做完好性校验（损坏不写盘、原文件不动）。
 * @param {string} absPath
 * @param {Array<{sheet?:string,cell:string,formula:string}>} edits
 * @returns {Promise<{path:string,edited:string[],count:number,message:string}>}
 */
async function editXlsxFile(absPath, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("缺少 edits 参数（数组：[{sheet?,cell,formula}]）");
  }
  if (path.extname(absPath).toLowerCase() !== ".xlsx") {
    throw new Error("edit_xlsx 仅支持 .xlsx（OOXML），其它格式请用对应工具");
  }
  const { default: JSZip } = await import("npm:jszip");
  const data = await Deno.readFile(absPath);
  const zip = await JSZip.loadAsync(data);

  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!wbXml) throw new Error("非法 xlsx：缺 xl/workbook.xml");
  const relsXml =
    (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) || "";
  const sheetMap = _xlsxMapSheets(wbXml, relsXml);
  const defaultPath = Object.values(sheetMap)[0];
  if (!defaultPath) throw new Error("非法 xlsx：解析不到任何 worksheet");

  const bySheet = new Map();
  for (const e of edits) {
    const sp = e.sheet ? sheetMap[e.sheet] : defaultPath;
    if (!sp) {
      throw new Error(
        `找不到 sheet "${e.sheet}"（可用：${Object.keys(sheetMap).join(", ")}）`,
      );
    }
    if (!bySheet.has(sp)) bySheet.set(sp, []);
    bySheet.get(sp).push({
      cell: String(e.cell).toUpperCase(),
      formula: String(e.formula || "").replace(/^=/, ""),
    });
  }

  const applied = [];
  const touchedSheets = [];
  for (const [sp, cellEdits] of bySheet) {
    let xml = await zip.file(sp)?.async("string");
    if (!xml) throw new Error(`缺 worksheet ${sp}`);
    for (const { cell, formula } of cellEdits) {
      xml = _xlsxSetCellFormula(xml, cell, formula);
      applied.push(cell);
    }
    zip.file(sp, xml);
    touchedSheets.push(sp);
  }

  const outBuf = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });

  // ★ 容错闸（V1）：写盘前用 jszip 重解包+重解析改过的 sheet XML 做完好性校验。
  //   本体无 SheetJS，故以「能重解包 + 各改过 sheet 标签平衡」作 well-formed 判据，损坏不写盘。
  try {
    const verifyZip = await JSZip.loadAsync(outBuf);
    for (const sp of touchedSheets) {
      const vx = await verifyZip.file(sp)?.async("string");
      if (!vx) throw new Error(`重解包后丢失 worksheet ${sp}`);
      // 标签平衡 + sheetData 存在：检测明显的结构破坏（截断/未闭合）。
      const openC = (vx.match(/<c\b/g) || []).length;
      const closeC =
        (vx.match(/<\/c>/g) || []).length + (vx.match(/<c\b[^>]*\/>/g) || []).length;
      const openRow = (vx.match(/<row\b/g) || []).length;
      const closeRow =
        (vx.match(/<\/row>/g) || []).length +
        (vx.match(/<row\b[^>]*\/>/g) || []).length;
      if (openC !== closeC || openRow !== closeRow || !/<sheetData[\s>]/.test(vx)) {
        throw new Error(`worksheet ${sp} 结构校验失败（标签不平衡）`);
      }
    }
  } catch (e) {
    throw new Error(
      `定点改写后文件校验失败（未写盘，原文件未动）：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  await Deno.writeFile(absPath, outBuf);
  return {
    path: absPath,
    edited: applied,
    count: applied.length,
    message: `已定点写入 ${applied.length} 个单元格公式（样式/条件格式/扩展原样保留，已通过重解析校验）。Excel 打开会自动重算。`,
  };
}

// ============================================================
// 文件操作执行器 (Deno 环境)
// ============================================================

/**
 * ★ D3：把命令字符串解析为 argv 数组（供 exec 通道 argv 直传，不经 shell）。
 *   支持单/双引号包裹的参数（引号内空白不分词）；其余按空白分词。
 *   不展开任何 shell 元字符（$ ` * 等按字面），不识别管道/重定向/链接符——
 *   这正是安全意图：含 && | ; 的"链式命令"会被当作字面参数，无法注入第二条命令。
 * @param {string} cmd
 * @returns {string[]}
 */
function _parseExecArgv(cmd) {
  const out = [];
  let cur = "";
  let quote = null; // "'" | '"' | null
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; }
      else { cur += c; }
      has = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * 执行文件操作 — 实际磁盘 I/O 层。
 *
 * 链路：validateOpSecurity() 通过后 → 本函数 → Deno 磁盘 API。
 *       入口已经过安全校验，本函数不再做沙箱/黑名单检查。
 *
 * 支持类型：read/write/create/delete/list/move/fuzzy_edit/edit_xlsx/search/exec/insert/replace_lines。
 *
 * 影响：写类操作(write/create/delete/move/fuzzy_edit/edit_xlsx/insert/replace_lines)经 withFileWriteLock 串行；
 *       move 双键字典序加锁防 A→B/B→A 交叉死锁；
 *       exec 经 argv 直传 Deno.Command（不经 shell，D3 安全闸）；
 *       op.path/destPath 兜底再调 resolveCanonicalOpPath（幂等，兼容手动审批路径）。
 *
 * 约束：fuzzy_edit 的 _needSubtagFallback 标记会直接失败（K10/X2 协议层降级，不调算法层）；
 *       exec 拦截 shell 包装(cmd /c, sh -c, powershell -Command)；
 *       delete 不带 recursive（设计意图：防误删非空目录）。
 *
 * @param {FileOperation} op - 操作对象（path 应已 canonical）
 * @returns {Promise<FileOperation>} 执行后的操作对象（status/result/error 已填充）
 */
async function executeFileOperation(op) {
  if (typeof Deno === "undefined") {
    op.status = "failed";
    op.error = "File operations require Deno runtime";
    return op;
  }

  // F2 框架级修：主路径解析上移到 ReplyHandler 安全检查段之前（resolveCanonicalOpPath），
  //   自动批准路径进来时 op.path 已是 canonical（校验与执行同一值）。
  //   兜底：手动审批（approveOp/approveAll）路径的 op 可能来自「权限 OFF 早退队列」（尚未 canonical）——
  //   此处对非 exec 再调一次 resolveCanonicalOpPath。该函数幂等（已 canonical 的绝对路径 resolve 返回自身），
  //   不破坏已解析值；保持与旧 resolveOpPath「在执行点解析」对手动审批的等价行为。
  if (op.type !== "exec") {
    if (op.path) op.path = resolveCanonicalOpPath(op.path, op._cid);
    if (op.destPath) op.destPath = resolveCanonicalOpPath(op.destPath, op._cid);
  }

  // F6 写锁：write/create/delete/move/fuzzy_edit 是 read→modify→write 形态，同文件并发会 lost update。
  //   纯读（read/list/search/exec）直通不加锁。锁键 = canonical op.path（move 与目标键同步互斥另在下）。
  const _isWriteOp =
    op.type === "write" ||
    op.type === "create" ||
    op.type === "delete" ||
    op.type === "move" ||
    op.type === "fuzzy_edit" ||
    op.type === "edit_xlsx" ||
    op.type === "insert" ||        // 任务C：read→splice→write 形态，同锁
    op.type === "replace_lines";   // 任务C：同上

  const _runOpBody = async () => {
  try {
    switch (op.type) {
      case "read": {
        // 任务C read 返回优化（凛倾 2026-07-09「读取文件的返回」，对标 YonBan file-tools readFile）：
        //   office 分流 → 1MB 上限 → NUL 二进制检测 → BOM/行尾规整 → offset/limit 分页 → 行号 `N | 内容`。
        //   分流必须在大小/二进制检测之前：office 本质 ZIP/二进制且常 >1MB，走默认路必被弹掉（YonBan 同序）。
        const _rdExt = path.extname(op.path).toLowerCase();
        if (DOC_EXTRACT_EXTS.has(_rdExt)) {
          op.result = await extractDocumentText(op.path, _rdExt);
          op.status = "completed";
          break;
        }
        const _rdStat = await Deno.stat(op.path);
        if (_rdStat.size > 1024 * 1024) {
          op.status = "failed";
          op.error = `文件过大 (${(_rdStat.size / 1048576).toFixed(1)}MB)，最大 1MB。可用 search 定位后按 offset/limit 分段读取`;
          break;
        }
        // 二进制检测：前 512 字节含 NUL → 不当文本读（乱码注入无意义）
        {
          const _fh = await Deno.open(op.path, { read: true });
          const _head = new Uint8Array(Math.min(512, _rdStat.size));
          try { await _fh.read(_head); } finally { _fh.close(); }
          if (_head.includes(0)) {
            op.result = `[二进制文件, 大小: ${_rdStat.size} 字节, 路径: ${op.path}]`;
            op.status = "completed";
            break;
          }
        }
        const _rdRaw = await Deno.readTextFile(op.path);
        // BOM 去除 + CRLF/CR 统一 \n（仅用于展示，不写回磁盘）
        const _rdContent = _rdRaw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const _rdLines = _rdContent === "" ? [] : _rdContent.split("\n");
        const _rdTotal = _rdLines.length;
        // 分页：offset=起始行(0基)，limit=行数（默认 2000 行 + 24000 字符预算先到为准——
        //   对话注入场景必须有默认上限，旧 5000 字符注入硬截由此替代，见 :successOps 注入段）
        const _rdOffset = Math.max(0, Number(op.offset) || 0);
        const _rdLimit = Math.max(1, Number(op.limit) || 2000);
        const _CHAR_BUDGET = 24000;
        const _rdEndWanted = Math.min(_rdTotal, _rdOffset + _rdLimit);
        let _rdBody = "";
        let _rdEnd = _rdOffset;
        for (let _i = _rdOffset; _i < _rdEndWanted; _i++) {
          const _line = `${_i + 1} | ${_rdLines[_i]}\n`;
          if (_rdBody.length + _line.length > _CHAR_BUDGET && _rdEnd > _rdOffset) break;
          _rdBody += _line;
          _rdEnd = _i + 1;
        }
        const _rdTrunc = _rdEnd < _rdTotal;
        op.result =
          `共 ${_rdTotal} 行，显示 L${_rdOffset + 1}-${_rdEnd}${_rdTrunc ? `（未完，继续读传 offset="${_rdEnd}"）` : ""}\n` +
          _rdBody.replace(/\n$/, "");
        op.status = "completed";
        break;
      }
      case "insert": {
        // 任务C 插入指令（凛倾点名「插入」，schema/语义对齐 YonBan edit-tools insertAtLine）：
        //   line=1基插入点（内容插到该行位置，原行下移）；0/缺省/超界 → 追加文件末尾（带 ⚠ 提示）。
        //   保持原文件行尾风格（CRLF/LF），与 write 同框架（permissionMap insert→file_write，F6 写锁已含）。
        const _insStat = await Deno.stat(op.path).catch(() => null);
        if (!_insStat?.isFile) {
          op.status = "failed";
          op.error = `文件不存在: ${op.path}`;
          break;
        }
        if (op.content === undefined || op.content === null || op.content === "") {
          op.status = "failed";
          op.error = "缺少插入内容（标签体为空）";
          break;
        }
        const _insRaw = await Deno.readTextFile(op.path);
        const _insCRLF = _insRaw.includes("\r\n");
        const _insEol = _insCRLF ? "\r\n" : "\n";
        const _insLines = (_insCRLF ? _insRaw.replace(/\r\n/g, "\n") : _insRaw).split("\n");
        const _insNew = (_insCRLF ? op.content.replace(/\r\n/g, "\n") : op.content).split("\n");
        const _insLineArg = Number(op.line) || 0;
        let _insAt;
        let _insAdjusted = false;
        if (!_insLineArg || _insLineArg <= 0 || _insLineArg > _insLines.length + 1) {
          _insAt = _insLines.length;
          _insAdjusted = _insLineArg > 0;
        } else {
          _insAt = _insLineArg - 1;
        }
        _insLines.splice(_insAt, 0, ..._insNew);
        const _insOut = _insLines.join(_insEol);
        await Deno.writeTextFile(op.path, _insOut);
        const _insVerify = await verifyWholeFileWrite(op.path, _insOut);
        op.result = `L${_insAt + 1}-${_insAt + _insNew.length} 插入 ${_insNew.length} 行（共 ${_insLines.length} 行${_insVerify ? "" : "，已校验"}）${_insAdjusted ? ` ⚠️ 行号 ${_insLineArg} 超出范围，已追加到末尾` : ""}${_insVerify}`;
        try {
          const _insAnchor = await buildOpContextAnchor(op.path, _insAt + 1, _insNew.length);
          if (_insAnchor) op.result += `\n${_insAnchor}`;
        } catch { /* 锚尽力而为 */ }
        op.status = "completed";
        break;
      }
      case "replace_lines": {
        // 任务C 行区间替换（schema/语义对齐 YonBan edit-tools replaceLines）：
        //   start_line/end_line=1基闭区间；end 超界 clamp 到文件尾；old_content 回带进结果（AI 可核对删了什么）。
        const _rlStart = Number(op.startLine) || 0;
        const _rlEndArg = Number(op.endLine) || 0;
        if (_rlStart < 1 || _rlEndArg < _rlStart) {
          op.status = "failed";
          op.error = `行区间非法: start_line=${op.startLine} end_line=${op.endLine}（须 1 ≤ start ≤ end）`;
          break;
        }
        const _rlStat = await Deno.stat(op.path).catch(() => null);
        if (!_rlStat?.isFile) {
          op.status = "failed";
          op.error = `文件不存在: ${op.path}`;
          break;
        }
        const _rlRaw = await Deno.readTextFile(op.path);
        const _rlCRLF = _rlRaw.includes("\r\n");
        const _rlEol = _rlCRLF ? "\r\n" : "\n";
        const _rlLines = (_rlCRLF ? _rlRaw.replace(/\r\n/g, "\n") : _rlRaw).split("\n");
        if (_rlStart > _rlLines.length) {
          op.status = "failed";
          op.error = `start_line (${_rlStart}) 超出文件行数 (${_rlLines.length})`;
          break;
        }
        const _rlEnd = Math.min(_rlEndArg, _rlLines.length);
        const _rlNew = ((_rlCRLF ? (op.content || "").replace(/\r\n/g, "\n") : (op.content || ""))).split("\n");
        const _rlRemoved = _rlEnd - _rlStart + 1;
        const _rlOld = _rlLines.slice(_rlStart - 1, _rlStart - 1 + _rlRemoved).join("\n");
        _rlLines.splice(_rlStart - 1, _rlRemoved, ..._rlNew);
        const _rlOut = _rlLines.join(_rlEol);
        await Deno.writeTextFile(op.path, _rlOut);
        const _rlVerify = await verifyWholeFileWrite(op.path, _rlOut);
        op.result =
          `L${_rlStart}-${_rlEnd} → L${_rlStart}-${_rlStart + _rlNew.length - 1}（${_rlRemoved}→${_rlNew.length} 行，共 ${_rlLines.length} 行${_rlVerify ? "" : "，已校验"}）${_rlVerify}\n` +
          `被替换原文:\n\`\`\`\n${_rlOld.slice(0, 2000)}\n\`\`\``;
        try {
          const _rlAnchor = await buildOpContextAnchor(op.path, _rlStart, _rlNew.length);
          if (_rlAnchor) op.result += `\n${_rlAnchor}`;
        } catch { /* 锚尽力而为 */ }
        op.status = "completed";
        break;
      }
      case "write": {
        await Deno.writeTextFile(op.path, op.content);
        const _wVerify = await verifyWholeFileWrite(op.path, op.content);
        op.result = `Written ${op.content.length} chars to ${op.path}${_wVerify || "（已校验）"}`;
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
        const _cVerify = await verifyWholeFileWrite(op.path, op.content || "");
        op.result = `Created ${op.path}${_cVerify || "（已校验）"}`;
        op.status = "completed";
        break;
      }
      case "delete": {
        // T026 凛倾原话：「文件级别的删除是进电脑的回收站，而不是直接全部删除」——AI 删文件默认进系统回收站，
        // safeUnlink 失败自带 _trash_fallback 兜底；两者都失败才 throw（走外层 failed 上报，不静默）。
        const _delR = await safeUnlink(op.path, "ai_delete");
        if (!_delR?.success) throw new Error(`移入回收站失败: ${_delR?.error || "未知错误"}`);
        op.result = `Deleted ${op.path} (${_delR.method === "trash" ? "已进系统回收站" : "已移入 _trash_fallback"})`;
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
      case "fuzzy_edit": {
        // 本体本地模糊编辑（不连 IDE/YonBan 时）。路径已经过上层沙箱/黑白名单/权限把关
        // 与 write 同框架（permissionMap fuzzy_edit→file_write）。语义对齐 YonBan。
        // ★ K10/X2 协议层自动降级：属性式 old_string/new_string 被内层双引号截断时，
        //   不调算法层（残缺值必失配/误改），直接回报子标签指引让 AI 下轮降级重发。
        if (op._needSubtagFallback) {
          op.status = "failed";
          op.error = op._needSubtagFallback;
          break;
        }
        let exists = false;
        try {
          exists = (await Deno.stat(op.path)).isFile;
        } catch {
          exists = false;
        }
        if (!exists) {
          op.status = "failed";
          op.error = `文件不存在: ${op.path}`;
          break;
        }
        const fz = await applyFuzzyEdit(op.path, op.oldString, op.newString, {
          lineHint: op.lineHint,
          strict: op.strict,
        });
        if (fz.success) {
          op.status = "completed";
          // 结果文本含策略/落点/校验，注入给 AI 继续工作
          op.result = `${fz.message || "fuzzy_edit 成功"}（策略 ${fz.strategy}，L${fz.matchLine}-${fz.matchEnd}，共 ${fz.totalLines} 行${fz.verified ? "，已校验" : ""}）`;
          // ★ 定点返回（设计 §四焦点1）：把改动点相对上下文锚嵌进结果字符串（file_op 返回是字符串，直注 GetPrompt
          //   无白名单，嵌串即随注入）。机械按行切片，抗行号漂移让 AI 据 anchorText 正则回找。
          try {
            const _anchorTxt = await buildOpContextAnchor(op.path, fz.matchLine, (fz.matchEnd - fz.matchLine + 1));
            if (_anchorTxt) op.result += `\n${_anchorTxt}`;
          } catch { /* 锚尽力而为，不影响写结果 */ }
        } else {
          op.status = "failed";
          // 失败语义对齐 YonBan：歧义/失配各自带提示与候选，原样回报给 AI 重试
          let msg = fz.error || "fuzzy_edit 失败";
          if (Array.isArray(fz.matchLines) && fz.matchLines.length) {
            msg += ``; // matchLines 已含在 error 文案
          }
          if (Array.isArray(fz.suggestions) && fz.suggestions.length) {
            const sg = fz.suggestions
              .map((s) => `  L${s.line} (${s.similarity}%): ${s.preview}`)
              .join("\n");
            msg += `\n最接近的候选位置：\n${sg}`;
          }
          op.error = msg;
        }
        break;
      }
      case "edit_xlsx": {
        // 安全改 xlsx 公式（zip 级定点改写，保条件格式/样式）。与 write 同框架（permissionMap edit_xlsx→file_write）。
        //   edits 来自 tool_call 的 args.edits（已解析数组）或标签体 body 的 JSON（解析见 parseFileOperations）。
        let exists = false;
        try {
          exists = (await Deno.stat(op.path)).isFile;
        } catch {
          exists = false;
        }
        if (!exists) {
          op.status = "failed";
          op.error = `文件不存在: ${op.path}`;
          break;
        }
        try {
          const r = await editXlsxFile(op.path, op.edits);
          op.status = "completed";
          op.result = `${r.message}（${r.count} 格：${r.edited.join(", ")}）`;
        } catch (e) {
          op.status = "failed";
          op.error = e?.message || String(e);
        }
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
        // ★ D3 安全闸（2026-06-16，凛倾「危险命令到不了 YonBan」）：
        //   不再经 cmd /c / sh -c 走 shell（shell 会解释 && | ; > $() 等元字符 = 注入面 + 链式绕过命令闸）。
        //   改 argv 直传：argv[0]=可执行文件，argv[1..]=参数，Deno.Command 不经 shell 解析。
        //   shell 元字符（管道/重定向/子命令/链接符）一律按字面参数对待，无法注入第二条命令。
        const _argv = _parseExecArgv(cmd);
        if (!_argv.length) {
          op.status = "failed";
          op.error = "Empty command after parse";
          break;
        }
        // 拦截显式 shell 包装（cmd /c "..." / sh -c "..." / powershell -Command ...）——
        // 这类写法把整串交给 shell 解释，等同绕过 argv 直传的注入防护，直接拒。
        const _exe0 = _argv[0].toLowerCase().replace(/\.exe$/, "");
        if (
          (["cmd", "sh", "bash", "zsh", "powershell", "pwsh"].includes(_exe0)) &&
          _argv.slice(1).some((a) => /^(\/c|\/k|-c|-command|-encodedcommand|-enc)$/i.test(a))
        ) {
          op.status = "failed";
          op.error = "🛡️ 安全策略：禁止经 shell 包装(cmd /c, sh -c, powershell -Command)执行——请直接给出可执行文件与参数";
          break;
        }
        const command = new Deno.Command(
          _argv[0],
          {
            args: _argv.slice(1),
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
  };

  // ★ T017-2.3 回档基石不裸奔：AI 文件写操作前必先备份成功，否则回档系统无版本可回滚。
  //   原缺陷：backupBeforeWrite 返回值被忽略 + catch{} 空吞 → 备份失败仍继续裸写，errors 系统零记录。
  //   返回语义同 ideClient(:949)：{backed:false,error}=真失败(fail-closed 中止写)；{backed:false} 无 error=合法跳过放行。
  let _bkFailed = null;
  if (_isWriteOp) {
    const _bkUser = _als.getStore()?.username || "";
    if (op.path && _bkUser) {
      try {
        const _bk = await fileHistory.backupBeforeWrite(_bkUser, op.path, { chatid: op._cid, tool: "ai_" + op.type });
        if (_bk && _bk.backed === false && _bk.error) _bkFailed = _bk.error;
      } catch (e) { _bkFailed = e?.message || String(e); }
    }
    if (_bkFailed) {
      wbD(op._cid || null, "beilu-files", "runOp:backupFailed", false, `写前备份失败,fail-closed 中止写操作: ${_bkFailed}`, { type: op.type, path: op.path });
      diag.error(`[beilu-files] ★T017 写前备份失败,中止写操作 ${op.type} ${op.path}: ${_bkFailed}`);
      op.status = "failed";
      op.error = `🛡️ 写前备份失败,已中止写操作以保护可回档性: ${_bkFailed}`;
      return op;
    }
    // move 需同时互斥 src 与 dest 两键：按 canonical 键字典序固定加锁顺序（防 A→B 与 B→A 交叉死锁）；
    //   两键相同则退化为单锁。
    if (op.type === "move" && op.destPath) {
      const k1 = String(op.path).replace(/\\/g, "/").toLowerCase();
      const k2 = String(op.destPath).replace(/\\/g, "/").toLowerCase();
      if (k1 === k2) {
        await withFileWriteLock(op.path, _runOpBody);
      } else {
        const [lo, hi] = k1 < k2 ? [op.path, op.destPath] : [op.destPath, op.path];
        await withFileWriteLock(lo, () => withFileWriteLock(hi, _runOpBody));
      }
    } else {
      await withFileWriteLock(op.path, _runOpBody);
    }
  } else {
    await _runOpBody();
  }

  return op;
}

// ============================================================
// 插件数据
// ============================================================

/**
 * 检查路径是否被用户配置的 blockedPaths 或敏感路径规则禁止
 * @param {string} filePath - 待检查路径
 * @returns {string|{level:string,message:string}|null} string=硬拦(block) | {level:'warn'}=提醒放行 | null=通过
 * [0723 问题1.1] 返回类型扩展:checkSensitivePath 的 keywords 命中返回 warn 对象,此处原样透传,
 *   validateOpSecurity/_gateBrowseListing 按 typeof 区分处理。blockedPaths(用户黑名单)仍硬拦(string)。
 */
function checkSystemDriveBlock(filePath) {
  if (!filePath) return null;
  const normalized = _normCase(filePath.replace(/\\/g, "/"));
  // 用户配置的黑名单（前端可调）
  for (const bp of pluginData.blockedPaths || []) {
    const nbp = _normCase(bp.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (normalized === nbp || normalized.startsWith(nbp + "/")) {
      return `路径被禁止访问: ${bp}`;
    }
  }
  // W61: 敏感路径检查（W13/W36设计）—— 返回可能是 string(硬拦) 或 {level:'warn'}(提醒)，原样透传
  const sensitiveMsg = checkSensitivePath(normalized);
  if (sensitiveMsg) return sensitiveMsg;
  return null;
}

// W61: 敏感路径安全检查（W13 §6 / W36设计）
function checkSensitivePath(normalizedPath) {
  const lower = _normCase(normalizedPath);
  // 敏感目录
  const blockedDirs = [".ssh", ".gnupg", ".env", "appdata", "windows/system32", "program files"];
  for (const dir of blockedDirs) {
    if (lower.includes("/" + dir + "/") || lower.endsWith("/" + dir)) {
      return `安全策略：禁止访问敏感目录 (${dir})`;
    }
  }
  // 敏感扩展名
  const blockedExts = [".exe", ".dll", ".sys", ".bat", ".cmd", ".ps1", ".vbs", ".msi", ".scr"];
  for (const ext of blockedExts) {
    if (lower.endsWith(ext)) {
      return `安全策略：禁止操作敏感文件类型 (${ext})`;
    }
  }
  // 敏感文件名关键词 [0723 问题1.1] 降级为 warn（why: 002 原话「危险文件给提醒不是禁止,token 文件应能打开/改名」）。
  //   dirs/exts=真危险(系统目录/可执行文件)保持 string 硬拦; keywords(文件名含token等)=可能误伤普通文件→返回 warn 对象。
  //   返回类型契约: string=硬拦(block) | {level:'warn',message}=提醒放行(warn) | null=通过。
  //   下游 checkSystemDriveBlock 透传, validateOpSecurity 按 typeof 区分。
  const sensitiveKeywords = ["password", "credential", "secret", "token", "private_key", "id_rsa"];
  const fileName = lower.split("/").pop() || "";
  for (const keyword of sensitiveKeywords) {
    if (fileName.includes(keyword)) {
      return { level: "warn", message: `文件名含敏感词 (${keyword})，可能是密钥/凭证文件，请确认是否继续` };
    }
  }
  return null;
}

// ============================================================
// N2 框架级单源化：op 路径安全校验链（canonical 解析 + 系统盘拦截 + 工作区沙箱 + 黑白名单）
//   背景：原 ReplyHandler 主循环（resolveCanonicalOpPath → checkSystemDriveBlock → 沙箱 → isPathAllowed）
//   是路径校验的唯一落点，但「权限 OFF → 入待审批队列」分支在校验前 continue 早退，
//   入队 op 未经任何路径校验；用户手动 approveOp/approveAll 时直接 executeFileOperation，
//   于是审批路径完全旁路系统盘拦截/沙箱/黑白名单（审批=免检）。
//   此函数把这条校验链抽成单源，主循环与审批路径共用：审批≠路径免检，
//   用户明确批准的 op 仍执行，但路径必须过同一关卡。
//   原地改写 op.path/op.destPath 为 canonical 值（与主循环等价，下游 executeFileOperation 幂等再解析）。
//   返回 { ok:true } 或 { ok:false, error }（调用方负责置 op.status="rejected"/op.error）。
/**
 * 文件操作路径安全校验 — 单一权威闸（N2 单源化）。
 *
 * 三条路径共用：① AI ReplyHandler 主循环 ② 前端直接 op (_gateFrontendFileOp)
 *              ③ 审批执行 (approveOp/approveAll)
 *
 * 四层纵深校验（顺序不可调换）：
 *   1. resolveCanonicalOpPath — 相对路径锚到工作区根，绝对路径消化 ..
 *      FT-multiwin: 按 op._cid 取 per-window 隔离沙箱根
 *   2. checkSystemDriveBlock — 用户配置 blockedPaths + 敏感路径/扩展名/关键词
 *   3. 工作区沙箱 — opPath 必须在 wsRoot 内（startsWith + 边界 /）
 *   4. isPathAllowed — 允许/禁止列表边界形态比较
 *
 * 影响：原地改写 op.path/op.destPath 为 canonical 值（幂等，下游 executeFileOperation 再解析无害）。
 *       move 类型同时校验 destPath。exec 类型跳过路径锚定（沿用 cwd 语义）。
 *
 * @param {{ type: string, path?: string, destPath?: string, _cid?: string }} op - 操作对象
 * @returns {{ ok: boolean, error?: string }}
 */
function validateOpSecurity(op) {
  // 路径 canonical 化（exec 不锚，沿用 cwd 语义）。FT-multiwin：按 op 发起窗口 op._cid 取隔离沙箱根。
  const _sk = op._cid;
  if (op.type !== "exec") {
    if (op.path) op.path = resolveCanonicalOpPath(op.path, _sk);
    if (op.destPath) op.destPath = resolveCanonicalOpPath(op.destPath, _sk);
  }

  // 系统盘/敏感路径黑名单 [0723 问题1.1] typeof 区分:string=硬拦(block)/object=提醒(warn 收集不拦)
  const _warnings = [];
  if (op.path && op.type !== "exec") {
    const sysBlock = checkSystemDriveBlock(op.path);
    if (typeof sysBlock === "string") { wbD(_sk, "files", "validateOpSecurity:sysdrive_block", false, sysBlock, { type: op.type, path: op.path }); return { ok: false, error: sysBlock }; }
    else if (sysBlock && sysBlock.level === "warn") { _warnings.push(sysBlock.message); }
  }
  if (op.destPath && op.type === "move") {
    const sysBlockDest = checkSystemDriveBlock(op.destPath);
    if (typeof sysBlockDest === "string") { wbD(_sk, "files", "validateOpSecurity:sysdrive_block_dest", false, sysBlockDest, { type: op.type, destPath: op.destPath }); return { ok: false, error: sysBlockDest }; }
    else if (sysBlockDest && sysBlockDest.level === "warn") { _warnings.push(sysBlockDest.message); }
  }

  // 工作区沙箱（op.path 已 canonical；wsRoot 用 path.resolve 同锚，与主循环 F1 一致）
  const wsRoot = getWorkspaceRoot(_sk);
  const norm = (s) =>
    _normCase(String(s).replace(/\\/g, "/")).replace(/\/+$/, "");
  const wsRootNorm = norm(path.resolve(wsRoot));
  if (op.path && op.type !== "exec") {
    const opPathNorm = norm(op.path);
    if (!opPathNorm.startsWith(wsRootNorm + "/") && opPathNorm !== wsRootNorm) {
      wbD(_sk, "files", "validateOpSecurity:outside_workspace", false, "路径越界:超出会话沙箱根", { type: op.type, path: op.path, wsRoot });
      return {
        ok: false,
        error: `Path outside workspace: "${op.path}" is not within "${wsRoot}"`,
      };
    }
  }
  if (op.destPath && op.type === "move") {
    const destNorm = norm(op.destPath);
    if (!destNorm.startsWith(wsRootNorm + "/") && destNorm !== wsRootNorm) {
      wbD(_sk, "files", "validateOpSecurity:dest_outside_workspace", false, "目标路径越界:超出会话沙箱根", { type: op.type, destPath: op.destPath, wsRoot });
      return {
        ok: false,
        error: `Destination outside workspace: "${op.destPath}" is not within "${wsRoot}"`,
      };
    }
  }

  // 路径白名单/黑名单（F7a 边界形态在 isPathAllowed 内）
  if (
    op.path &&
    !isPathAllowed(op.path, pluginData.allowedPaths, pluginData.blockedPaths)
  ) {
    wbD(_sk, "files", "validateOpSecurity:path_not_allowed", false, "路径被黑白名单拦截", { type: op.type, path: op.path });
    return { ok: false, error: `Path not allowed: ${op.path}` };
  }

  // [0723 问题1.1] 通过校验,但可能带 warn(文件名含敏感词)→放行并透传 warnings 供前端 confirm
  return _warnings.length > 0 ? { ok: true, warnings: _warnings } : { ok: true };
}

// SEC-T2/RCE-3：前端"直接文件操作"(readFile/writeFile/createFile/deleteFile/createDir/listDir)
//   此前仅过 checkSystemDriveBlock，绕过了 AI op 路径已有的【工作区沙箱 + canonical + 黑白名单】，
//   导致任意非C盘读写删(落.mjs→RCE / 读他人 data 目录=跨账号)。此处统一改走同一单源闸 validateOpSecurity。
//   沙箱根 = pluginData.workspaceRoot（owner 可在配置里放宽/收紧 = 凛倾"安全行为可用户自设"）。
//   返回 { ok, path(canonical), error }。
// FT-multiwin：前端直接 file op 也带【发起窗口 chatid】(op._cid)，validateOpSecurity 据此取 per-window
//   隔离沙箱根（对齐 AI op 路径 replyHandler:2998 op._cid=_cid）。无 _cid 时回落全局根=旧行为不破坏。
//   原缺 _cid → 多窗设不同根时前端 op 一律按全局根(最后设置者)判沙箱 → A 窗可越界读写 B 窗工作区。
function _gateFrontendFileOp(type, p, _cid) {
  const op = { type, path: p, _cid };
  const v = validateOpSecurity(op);
  if (!v.ok) return { ok: false, error: v.error };
  // [0723 问题1.1] 透传 warnings(文件名含敏感词)→前端据此弹 confirm 提醒,用户确认后继续
  return v.warnings ? { ok: true, path: op.path, warnings: v.warnings } : { ok: true, path: op.path };
}

// M7：owner-gated 只读列举闸——专供 filePicker 浏览整机选 workspace 根（💻计算机/D:/任意目录）。
//   只读列举仅暴露目录项名字+size+mtime（不读内容、不写），是 validateOpSecurity 拦的三类(list/read/write)中最低危的一档，
//   故对【工作区沙箱根】放宽（跳过 :1785 的 startsWith(wsRoot) 判定），但【保留】系统盘拦截 checkSystemDriveBlock + 黑白名单 isPathAllowed
//   （C:/system32/blockedPaths 照拦）。与 validateOpSecurity 的差异仅在去掉工作区沙箱这一层。
//   只在 listDir(前端浏览)case 被 owner 闸命中时调用；AI op / read / write 一律不经此函数。
function _gateBrowseListing(p) {
  const op = { type: "list", path: resolveCanonicalOpPath(p, undefined) };
  // [0723 问题1.1] typeof 区分:只读列举对 warn(文件名含敏感词)放行(仅暴露名字/size/mtime,不读内容),只硬拦 string(系统目录/黑名单)
  const sysBlock = checkSystemDriveBlock(op.path);
  if (typeof sysBlock === "string") return { ok: false, error: sysBlock };
  if (!isPathAllowed(op.path, pluginData.allowedPaths, pluginData.blockedPaths)) {
    return { ok: false, error: `Path not allowed: ${op.path}` };
  }
  return { ok: true, path: op.path };
}

// ============================================================
// N46 审批三选一「总是允许」规则表（工作模式设计 :230，OpenClaw 式）
// 规则 = {type, pathPrefix, createdAt}，粒度 = 操作类型 + canonical 目录前缀。
// 命中 → 跳过两个审批入队口（权限 OFF 队列 / 非自动批准队列）直接执行；
// always ≠ 免检：exec 开关与 validateOpSecurity 照常生效。
// 叠加序：N42 Bot 闸 > always > 全局 autoApprove（L 档是上限，L2 写命中 always 仍强制审批）。
// ============================================================
/** 路径比较键：统一斜杠+小写+去尾斜杠（与 validateOpSecurity 内 norm 同范式）。 */
function _normPathKey(s) {
  return String(s).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * 判断一条 op 是否命中 always 规则。
 * exec 无路径锚（规则会退化成该 type 全放行），不参与 always。
 * 匹配在 canonical 域进行（op 可能尚未过 validateOpSecurity，这里只算不改 op.path）。
 */
function matchApprovalAlwaysRule(op) {
  const rules = pluginData.approvalAlwaysRules;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  if (op.type === "exec" || !op.path) return false;
  const opPath = _normPathKey(resolveCanonicalOpPath(op.path, op._cid));
  // move 写两端：目标路径也必须落在规则前缀内，否则借源路径规则把文件搬出授权目录。
  const opDest = op.destPath ? _normPathKey(resolveCanonicalOpPath(op.destPath, op._cid)) : null;
  const _inPrefix = (v, p) => v === p || v.startsWith(p + "/"); // 目录边界严格（防 sub 匹配 subevil）
  return rules.some((r) => {
    if (!r || r.type !== op.type) return false;
    const p = _normPathKey(r.pathPrefix || "");
    if (!p) return false; // 空前缀=全放行，不允许
    if (!_inPrefix(opPath, p)) return false;
    if (opDest && !_inPrefix(opDest, p)) return false;
    return true;
  });
}

/** 落一条 always 规则（去重）；持久化由 action 流程末尾的 savePersistedSettings 统一负责。 */
function addApprovalAlwaysRule(type, pathPrefix) {
  if (!Array.isArray(pluginData.approvalAlwaysRules)) pluginData.approvalAlwaysRules = [];
  const dup = pluginData.approvalAlwaysRules.some(
    (r) => r && r.type === type && _normPathKey(r.pathPrefix || "") === _normPathKey(pathPrefix),
  );
  if (!dup) {
    pluginData.approvalAlwaysRules.push({ type, pathPrefix, createdAt: new Date().toISOString() });
  }
}

// ============================================================
// F6: 同文件并发写串行锁（照 A3 / ideClient._withWriteLock 同型，本插件不跨 import，照型自建）
// 键 = canonical path 小写；链式 promise 队列，队尾是自己才 delete 防泄漏。
// 包住所有 read→modify→write 的 op（write/create/delete/move/fuzzy_edit）；纯读不加锁。
// ============================================================
const _fileWriteLocks = new Map();
async function withFileWriteLock(absPath, fn) {
  const key = String(absPath || "").replace(/\\/g, "/").toLowerCase();
  const prev = _fileWriteLocks.get(key) || Promise.resolve();
  let release;
  const myTurn = new Promise((res) => {
    release = res;
  });
  const chained = prev.then(() => myTurn).catch(() => myTurn);
  _fileWriteLocks.set(key, chained);
  try {
    await prev.catch(() => {}); // 等前序，前序失败不阻断本次
    return await fn();
  } finally {
    release();
    // 仅当队尾仍是自己（无后续排队者覆盖）时摘 key，防 Map 单调泄漏；
    // 有后续者会 set 新 promise → get(key)!==chained，不误删别人的链。
    if (_fileWriteLocks.get(key) === chained) _fileWriteLocks.delete(key);
  }
}

// ============================================================
// SEC 破口B per-user 重构（T27，凛倾决策：A 全量 + 多用户/公开部署 + workspaceRoot 保持全局）
// 原 `let pluginData = {...}` 是 module-level 全局单例 → ESM 跨用户共享 → 用户 A 的配置/操作历史/
// 待审批/错误队列泄漏给 B（I-01~I-10）。改为 per-user：
//   · 沙箱根簇 workspaceRoot/workspaceRoots 保持【全局】（凛倾指示，沙箱根本就是机器级）。
//   · 其余字段按 username 隔离（_userStores）。
//   · username 经 AsyncLocalStorage(_als) 从入口（router getUserByReq / GetData/SetData / GetPrompt/
//     ReplyHandler）携带；无上下文回退 "_default"。`pluginData` 改 Proxy，163 个访问点零改动透明路由。
// ============================================================
const _als = new AsyncLocalStorage();
function _curUser() {
  const u = _als.getStore()?.username;
  return (u && typeof u === "string") ? u : "_default";
}
// 全局沙箱根簇（不 per-user）：IDE 工作区根目录是机器/部署级，多窗口经 workspaceRoots(Map<chatid>) 再细分。
const _globalSandbox = {
  workspaceRoot: DEFAULT_WORKSPACE_ROOT, // IDE 文件浏览器当前打开的根目录（兜底键/前端焦点根，持久化）
  workspaceRoots: new Map(),   // Map<chatid|"", root>（FT-multiwin：AI op 经 op._cid 读隔离根，回落 workspaceRoot）
  _workspaceRootFromIDE: false, // IDE(YonBan) 设的根 → 防本体初始化用默认值覆盖
};
const _GLOBAL_FIELDS = new Set(["workspaceRoot", "workspaceRoots", "_workspaceRootFromIDE"]);
// per-user 数据工厂：除沙箱根簇外全部字段，每用户独立实例（含已 per-chatid 的 Map 字段，per-user 后变双层键）
function _makeUserData() {
  return {
    enabled: true,
    autoApprove: true,
    autoApproveRead: true,
    autoApproveList: true,
    allowExec: false,
    allowedPaths: [],
    blockedPaths: ["C:/"],
    operationHistory: [],
    maxHistory: 100,
    pendingOperations: [],
    approvalAlwaysRules: [], // N46 审批「总是允许」规则表
    activeModes: new Map(),  // N1 Map<chatid|"", mode>
    customPrompt: "",
    customPromptEnabled: false,
    fileModeSessions: new Map(), // N6 Map<chatid|"", {startIndex}>
    treeDepth: 2,
    treeShowSize: true,
    workspaceTreeCache: "",      // I-04：缓存改 per-user（防 A 的目录树缓存被 B 读到）
    workspaceTreeCacheTime: 0,
    executedOpSignatures: new Set(),
    pendingOpResults: new Map(), // F5 Map<sessionKey, []>
    pendingErrors: [],
    hasOperationErrors: false,
    permissions: {
      file_read: true,
      file_write: true,
      file_delete: false,
      file_retry: true,
      mcp: false,
      questions: true,
      todo: false,
    },
  };
}
const _userStores = new Map();
function _store(u) {
  let s = _userStores.get(u);
  if (!s) { s = _makeUserData(); _userStores.set(u, s); }
  return s;
}
// pluginData：透明 Proxy——沙箱根簇 → _globalSandbox，其余 → 当前 user store（ALS 解析）。
// 全文件 163 个 `pluginData.X` 读写零改动；无任何 ...pluginData/Object.keys(pluginData) 枚举（已核），故只需 get/set/has。
const pluginData = new Proxy(Object.create(null), {
  get(_t, p) {
    if (typeof p === "symbol") return undefined;
    return _GLOBAL_FIELDS.has(p) ? _globalSandbox[p] : _store(_curUser())[p];
  },
  set(_t, p, v) {
    if (_GLOBAL_FIELDS.has(p)) _globalSandbox[p] = v;
    else _store(_curUser())[p] = v;
    return true;
  },
  has(_t, p) {
    return _GLOBAL_FIELDS.has(p) || (typeof p !== "symbol" && p in _store(_curUser()));
  },
});

// ============================================================
/**
 * 单条 op 结果 → 注入文本行（✅成功/❌失败/🚫拒绝）。
 * 机制单源（凛倾 2026-07-09「优化机制」传导链修）：主循环自动批准路与手动审批路
 * （approveOp/approveAll/rejectOp/rejectAll）共用同一格式化——此前手动审批执行后结果只进
 * operationHistory 不进 pendingOpResults = 用户点了「允许」但 AI 永远收不到结果，链在审批处断。
 * read 无 5000 硬截：量已在 read case 由 offset/limit+字符预算控制，结果自带「共X行，续读 offset」头。
 */
function _formatOpResultLine(op) {
  if (op.status === "rejected") {
    return `🚫 ${op.type} \`${op.path || op.command || ""}\` 被拒绝: ${op.error || "用户拒绝"}`;
  }
  if (op.status === "failed") {
    return `❌ ${op.type} \`${op.path || op.command || ""}\`\n错误: ${op.error || "未知错误"}`;
  }
  const detail =
    op.type === "read"
      ? `文件内容:\n\`\`\`\n${op.result || ""}\n\`\`\``
      : op.type === "search"
        ? op.result || "无匹配结果"
        : op.result || "操作成功";
  return `✅ ${op.type} \`${op.path || op.command || ""}\`\n${detail}`;
}

// F5 pendingOpResults 会话隔离辅助（Map<sessionKey, []>）
// ============================================================
/** 入队：记录当时会话键（null/undefined → 兜底键 ""）。 */
function pushPendingOpResult(sessionKey, entry) {
  const k = sessionKey || "";
  let arr = pluginData.pendingOpResults.get(k);
  if (!arr) {
    arr = [];
    pluginData.pendingOpResults.set(k, arr);
  }
  arr.push(entry);
}
/** GetPrompt 注入：drain 自己键 + 兜底键 ""（无键的结果对所有会话可见），并清空这两键。 */
// E 机制统一：export 供 shell generation 生成前置 consume（调用方铺 _filesAls.run({username})，
//   同 hasPendingOpResultsForSession 先例）。主进程前置 drain 后池空 → 本次生成 GetPrompt drain
//   天然空=零双注入；worker 形态主池本就空 → 前置无害，worker 内 GetPrompt 瞬注旧路自洽保留。
export function drainPendingOpResultsForSession(sessionKey) {
  const k = sessionKey || "";
  const out = [];
  for (const key of k === "" ? [""] : [k, ""]) {
    const arr = pluginData.pendingOpResults.get(key);
    if (arr && arr.length) {
      out.push(...arr);
      pluginData.pendingOpResults.set(key, []);
    }
  }
  return out;
}
/**
 * 后端续轮判定（generation auto-continue 用）：本会话键(+兜底键 "")是否有待注入的 file_op 结果。
 * 非破坏性 peek（不 drain）。模式感知：chat 模式下 GetPrompt 不注入 file_op 结果（见 GetPrompt :2225），
 * 此时即使有残留结果也不该触发续轮（否则空轮烧熔断）→ 返回 false，对齐"有结果可注入才续轮"。
 * 修复：file_op 续轮原仅靠前端 pollFileOpResults（tab 绑定、无后端兜底），此 peek 让后端 generation 也能驱动。
 */
/**
 * 跨 isolate 模式同步原语（多卡 worker 用）：activeModes 是 per-isolate 纯运行时态、不持久化，
 * worker isolate 从不经 UI 的 setMode → 恒默认 "chat"，导致 worker 内 file/work/code 模式全失效
 * （file_op 执行/注入/续轮判定都按 chat 处理）。主进程读本会话模式 → 经 dispatch payload 传给
 * worker → worker GetReply 前设回本 isolate，使 worker 与主进程模式一致。
 */
// FT-multiwin 白盒钩子：暴露工作区隔离纯函数 + pluginData，供 verify_workspace_iso 验证沙箱根隔离逻辑（无副作用，不影响插件加载）。
export const __workspaceTestHooks = { pluginData, getWorkspaceRoot, resolveCanonicalOpPath, validateOpSecurity, executeFileOperation, parseFileOperations, extractDocumentText };

// yonban functions:files 节点身份换算面专用（与 REST 端点 :2331/:2345 同一 run 机制、同 store 形状
// {username}——facade 有身份才 run，无身份直调=chatStorage forgetChatState 先例的 _default 语义）。
// 仅此用途：其他调用方仍走 REST/named export，不开第二身份旁路。
export { _als as _filesAls };

export function getActiveModeForSession(sessionKey) { return getActiveMode(sessionKey); }
export function setActiveModeForSession(sessionKey, mode) { setActiveMode(sessionKey, mode); }

export function hasPendingOpResultsForSession(sessionKey) {
  if (getActiveMode(sessionKey) === "chat") return false;
  const k = sessionKey || "";
  for (const key of k === "" ? [""] : [k, ""]) {
    const arr = pluginData.pendingOpResults.get(key);
    if (arr && arr.length) return true;
  }
  return false;
}
/** 前端面板轮询：跨会话 flatten（UI 看全部，不按会话过滤）。 */
function flattenAllPendingOpResults() {
  const out = [];
  for (const arr of pluginData.pendingOpResults.values()) {
    if (arr && arr.length) out.push(...arr);
  }
  return out;
}
/** 前端消费 / 清空：清空所有会话键。 */
function clearAllPendingOpResults() {
  pluginData.pendingOpResults.clear();
}

// ============================================================
// N1 activeMode 会话隔离辅助（Map<chatid|"", mode>），范式同 pendingOpResults。
//   读：先查本会话键，缺失回落兜底键 ""，再缺失默认 "chat"。
//   写：按会话键存（null/undefined → 兜底键 ""）。
// ============================================================
/** 读本会话当前 UI 模式：本键 → 兜底键 "" → 默认 "chat"。 */
function getActiveMode(sessionKey) {
  const k = sessionKey || "";
  if (pluginData.activeModes.has(k)) return pluginData.activeModes.get(k);
  if (k !== "" && pluginData.activeModes.has("")) {
    return pluginData.activeModes.get("");
  }
  return "chat";
}
/** 写本会话当前 UI 模式（null/undefined → 兜底键 ""）。 */
function setActiveMode(sessionKey, mode) {
  pluginData.activeModes.set(sessionKey || "", mode);
}

// ============================================================
// N6 文件模式起始点会话隔离辅助（Map<chatid|"", { startIndex }>），范式同 activeModes。
//   读：先查本会话键，缺失回落兜底键 ""，再缺失返回 null。
//   写：按会话键存（null/undefined → 兜底键 ""）。
// ============================================================
/** 读本会话文件模式起始点：本键 → 兜底键 "" → null（未进文件模式）。 */
function getFileModeSession(sessionKey) {
  const k = sessionKey || "";
  if (pluginData.fileModeSessions.has(k)) {
    return pluginData.fileModeSessions.get(k);
  }
  if (k !== "" && pluginData.fileModeSessions.has("")) {
    return pluginData.fileModeSessions.get("");
  }
  return null;
}
/** 写本会话文件模式起始点（null/undefined → 兜底键 ""）。 */
function setFileModeSession(sessionKey, startIndex) {
  pluginData.fileModeSessions.set(sessionKey || "", { startIndex });
}
/** 清除本会话文件模式起始点（退出模式时调用；null/undefined → 兜底键 ""）。 */
function clearFileModeSession(sessionKey) {
  pluginData.fileModeSessions.delete(sessionKey || "");
}

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
  "approvalAlwaysRules",
  "customPrompt",
  "customPromptEnabled",
  "workspaceRoot",
  "treeDepth",
  "treeShowSize",
];
// 破口B：workspaceRoot 是全局沙箱根（持久化进 _global）；其余 14 项是 per-user 配置。
const _GLOBAL_PERSIST_KEYS = new Set(["workspaceRoot"]);
const _USER_PERSIST_KEYS = PERSIST_KEYS.filter((k) => !_GLOBAL_PERSIST_KEYS.has(k));
function _applyPersistKey(target, key, val) {
  if (key === "permissions") target.permissions = { ...target.permissions, ...val };
  else target[key] = val;
}

/**
 * 从磁盘加载持久化设置（破口B per-user 布局：{ _global:{workspaceRoot}, <username>:{...14项} }）。
 * 兼容旧单文件全局格式（顶层直接是键）：迁移 → workspaceRoot 进 _global，其余进 "_default" 桶（无 user 上下文的兜底）。
 * 老用户原全局配置因此落到 _default；具名用户首次访问得安全默认值（blockedPaths=["C:/"]/不可 exec），一次性重配即可。
 */
async function loadPersistedSettings() {
  if (typeof Deno === "undefined") return;
  try {
    const text = await Deno.readTextFile(PERSIST_FILE);
    const saved = JSON.parse(text);
    const isLegacy = saved._global === undefined &&
      (saved.workspaceRoot !== undefined || saved.enabled !== undefined || saved.permissions !== undefined);
    if (isLegacy) {
      if (saved.workspaceRoot !== undefined) _globalSandbox.workspaceRoot = saved.workspaceRoot;
      const d = _store("_default");
      for (const key of _USER_PERSIST_KEYS) if (saved[key] !== undefined) _applyPersistKey(d, key, saved[key]);
      console.log("[beilu-files] 已迁移旧全局设置 → _global + _default 桶（per-user）");
    } else {
      if (saved._global?.workspaceRoot !== undefined) _globalSandbox.workspaceRoot = saved._global.workspaceRoot;
      // 持久化根自愈（2026-08-01 幽灵工作区案）：盘上存的绝对根已不存在（或本就是幽灵路径）
      //   → 诚实告警并回落默认玩耍空间（锚 CWD，Load 钩子保证存在），下次 save 即持久化痊愈值。
      {
        const _vErrLoad = validateWorkspaceRoot(_globalSandbox.workspaceRoot);
        if (_vErrLoad) {
          console.warn(`[beilu-files] 持久化工作区根非法，回落默认玩耍空间: ${_vErrLoad}`);
          _globalSandbox.workspaceRoot = DEFAULT_WORKSPACE_ROOT;
        }
      }
      for (const [uname, bucket] of Object.entries(saved)) {
        if (uname === "_global" || !bucket || typeof bucket !== "object") continue;
        const d = _store(uname);
        for (const key of _USER_PERSIST_KEYS) if (bucket[key] !== undefined) _applyPersistKey(d, key, bucket[key]);
      }
      console.log("[beilu-files] 已从磁盘恢复设置(per-user)");
    }
  } catch {
    console.log("[beilu-files] 无持久化设置文件，使用默认值");
  }
}

/**
 * 将当前设置写入磁盘（防抖：100ms 内多次调用只写一次）
 */
const _persistTimers = new Map(); // username → timer（per-user 防抖，防多用户互相 clearTimeout 串）
function savePersistedSettings() {
  if (typeof Deno === "undefined") return;
  const u = _curUser(); // 同步捕获当前用户：setTimeout 回调内不依赖 ALS，且防抖按 user 隔离
  if (_persistTimers.get(u)) clearTimeout(_persistTimers.get(u));
  _persistTimers.set(u, setTimeout(async () => {
    _persistTimers.delete(u);
    try {
      // 读现有文件 → 只更新本 user 桶 + 全局沙箱根 → 整体写回（绝不丢别的 user 的设置）
      // T019：损坏→备份.corrupt.bak后抛错（外层catch warn），不空表顶上整体写回清空所有user设置；不存在→{}首装。
      let all = await readJsonSafe(PERSIST_FILE, {});
      if (all._global === undefined || typeof all._global !== "object") all = { _global: {} }; // 旧格式/空 → 重置为 per-user 结构（旧顶层键 load 时已迁进 _default）
      all._global.workspaceRoot = _globalSandbox.workspaceRoot;
      const d = _store(u); // 直接读 user store（非 Proxy/ALS），保证写的是 u 自己的数据
      const bucket = (all[u] && typeof all[u] === "object") ? all[u] : (all[u] = {});
      for (const key of _USER_PERSIST_KEYS) bucket[key] = d[key];
      const dir = PERSIST_FILE.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      if (dir) await Deno.mkdir(dir, { recursive: true }).catch(() => {});
      await Deno.writeTextFile(PERSIST_FILE, JSON.stringify(all, null, 2));
    } catch (err) {
      console.warn("[beilu-files] 持久化设置失败:", err.message);
    }
  }, 100));
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
 * - GetPrompt: 注入工作区目录树元数据 + 待处理操作结果（操作能力说明改由 INJ-2 提示词注入）
 * - ReplyHandler: 解析并执行文件操作
 */
const pluginExport = {
  info,
  Load: async ({ router, username }) => {
    // 启动时恢复持久化设置
    await loadPersistedSettings();

    // 任务A防护：默认工作区启动即保证存在（mkdir 幂等），listDir NotFound 翻车点根除；
    //   失败（只读盘等）出 warn 不阻断启动——此时前端 ensureDefaultWorkspace 会拿到同样错误可见报错。
    try {
      await Deno.mkdir(path.resolve(DEFAULT_WORKSPACE_ROOT), { recursive: true });
    } catch (err) {
      console.warn("[beilu-files] 默认工作区创建失败:", err?.message);
    }

    if (!router) return;

    // 破口B：解析每请求 username（多用户共进程时按 user 隔离配置/操作）；auth 不可用则回退 part-owner username 或 _default
    let _getUserByReq;
    try { _getUserByReq = (await import("../../../../yonban/core/functions/security/auth.mjs")).getUserByReq; } catch { /* 回退 */ }
    const _reqUser = async (req) => {
      if (_getUserByReq) { try { return (await _getUserByReq(req)).username; } catch { /* fallthrough */ } }
      return username || "_default";
    };

    router.get(
      "/api/parts/plugins\\:beilu-files/config/getdata",
      authenticate, // A2-3：补鉴权——杜绝匿名读文件权限/操作配置
      async (req, res) => {
        try {
          const _u = await _reqUser(req);
          const data = await _als.run({ username: _u }, () => pluginExport.interfaces.config.GetData());
          res.json(data);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-files/config/setdata",
      authenticate, // A2-3：补鉴权——杜绝匿名写文件权限/操作配置（含 allowExec 等高危项）
      async (req, res) => {
        try {
          const _u = await _reqUser(req);
          const result = await _als.run({ username: _u }, () => pluginExport.interfaces.config.SetData(req.body));
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
      GetData: async () => {
      // T060b：fileHistory 配置只是本聚合快照的一项，config.json 损坏时 loadConfig 抛 CorruptJsonError
      //   （已备份 .corrupt.bak）。局部承接为 {error} 对象——让配置面板知道该项损坏并留痕，而非让整个
      //   GetData 抛错导致 config 面板全空（其余 pluginData 字段仍正常返回）。
      let _fhCfg;
      try {
        _fhCfg = fileHistory.loadConfig(_als.getStore()?.username || "");
      } catch (e) {
        _fhCfg = { error: `文件历史配置损坏：${e.message}` };
      }
      return {
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
        // N1：GetData 无 chatid 上下文（前端 config 面板不按会话查；当前模式前端走 B 通道
        //   getCurrentMode/syncModeFromBackend，不消费此字段）→ 返回兜底键 "" 的值，等价旧全局行为。
        activeMode: getActiveMode(""),
        customPrompt: pluginData.customPrompt,
        customPromptEnabled: pluginData.customPromptEnabled,
        permissions: pluginData.permissions,
        approvalAlwaysRules: pluginData.approvalAlwaysRules,
        workspaceRoot: pluginData.workspaceRoot,
        treeDepth: pluginData.treeDepth,
        treeShowSize: pluginData.treeShowSize,
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
        fileHistory: _fhCfg,
        github: gitHub.getGitHubStatus(_als.getStore()?.username || ""),
      };
      },
      SetData: async (data) => {
        if (!data) return;

        if (data._action) {
          switch (data._action) {
            // ======== 前端直接文件操作 ========
            case "readFile": {
              const _rfPath = resolveWorkspacePath(data.path || "");
              const _g = _gateFrontendFileOp("read", _rfPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                const content = await Deno.readTextFile(_g.path);
                // [0723 问题1.1] 透传 warnings(文件名含敏感词)→前端据此弹 confirm 提醒,不拦读取
                return { _result: { content, path: data.path, warnings: _g.warnings } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "readFileBase64": {
              // 任务B多类型预览（凛倾 2026-07-09「打开更多种类的内容和优化显示」）：媒体文件
              //   （图片/音视频）字节读路——readFile 是 readTextFile 文本路，二进制走这里返 base64+mime
              //   给前端 <img>/<audio>/<video> data URL。stat 先行超限即拒（不读入内存），沙箱闸同 readFile。
              const _rbPath = resolveWorkspacePath(data.path || "");
              const _rbG = _gateFrontendFileOp("read", _rbPath, data.chatid);
              if (!_rbG.ok)
                return { _result: { error: _rbG.error, path: data.path } };
              try {
                const _rbStat = await Deno.stat(_rbG.path);
                const _RB_MAX = 20 * 1024 * 1024;
                if (_rbStat.size > _RB_MAX) {
                  return { _result: { error: `文件过大（${(_rbStat.size / 1048576).toFixed(1)}MB > 20MB），不支持预览`, path: data.path, size: _rbStat.size } };
                }
                const _rbBytes = await Deno.readFile(_rbG.path);
                // 分块转码：String.fromCharCode(...全量) 会超函数参数上限（>百KB 即爆）
                let _rbBin = "";
                for (let _i = 0; _i < _rbBytes.length; _i += 32768) {
                  _rbBin += String.fromCharCode(..._rbBytes.subarray(_i, _i + 32768));
                }
                const _rbExt = String(data.path || "").split(".").pop()?.toLowerCase() || "";
                const _rbMime = {
                  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
                  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
                  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
                  mp4: "video/mp4", webm: "video/webm",
                  pdf: "application/pdf", // 任务C：pdf 走 base64 → 前端 iframe data URL（浏览器内置查看器）
                }[_rbExt] || "application/octet-stream";
                return { _result: { base64: btoa(_rbBin), mime: _rbMime, size: _rbStat.size, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "readFileExtract": {
              // 任务C office 前端预览（凛倾「还有ppt,xlsx等等」）：xlsx/docx/pptx 提取文本给文件浏览预览面，
              //   与 AI read 分流共用 extractDocumentText 单源；沙箱闸同 readFile。
              const _rePath = resolveWorkspacePath(data.path || "");
              const _reG = _gateFrontendFileOp("read", _rePath, data.chatid);
              if (!_reG.ok)
                return { _result: { error: _reG.error, path: data.path } };
              try {
                const _reExt = path.extname(_reG.path).toLowerCase();
                if (!DOC_EXTRACT_EXTS.has(_reExt)) {
                  return { _result: { error: `不支持的文档格式: ${_reExt}`, path: data.path } };
                }
                const text = await extractDocumentText(_reG.path, _reExt);
                return { _result: { text, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "writeFile": {
              const _wfPath = resolveWorkspacePath(data.path || "");
              const _g = _gateFrontendFileOp("write", _wfPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                // M6：前端写盘走 withFileWriteLock（对齐 AI 路径 :1688），防多窗/AI 并发 lost-update。
                await withFileWriteLock(_g.path, () => Deno.writeTextFile(_g.path, data.content || ""));
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
                // 相对路径→拼接CWD
                dirPath = resolveWorkspacePath(dirPath);
                // Windows 盘符根需要确保以 / 结尾 (D: → D:/)
                if (/^[a-zA-Z]:$/.test(dirPath)) dirPath += "/";

                // SEC-T2/RCE-3：走统一沙箱闸（防列举工作区外/他人用户目录）
                // M7：沙箱内正常过闸；沙箱外目录（filePicker 浏览整机选 workspace 根）走 owner-gated 只读列举旁路。
                let _g = _gateFrontendFileOp("list", dirPath, data.chatid);
                if (!_g.ok) {
                  // 只读列举仅暴露文件名(不读内容/不写)=最低危；owner 边界经 deployGatedAllow
                  //   (local=owner 自己机器恒放行 / server 默认收紧、需 owner 显式开 config)；C:/敏感仍由 _gateBrowseListing 拦；AI op 不走本前端 case。
                  if (deployGatedAllow("allowComputerBrowse", "BEILU_COMPUTER_BROWSE")) {
                    const _gb = _gateBrowseListing(dirPath);
                    if (_gb.ok) _g = _gb;
                  }
                  if (!_g.ok)
                    return { _result: { error: _g.error, path: data.path } };
                }
                dirPath = _g.path;

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
              const _cfPath = resolveWorkspacePath(data.path || "");
              const _g = _gateFrontendFileOp("create", _cfPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                const dir = _g.path
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
                await withFileWriteLock(_g.path, () => Deno.writeTextFile(_g.path, data.content || "")); // M6：并发锁
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "deleteFile": {
              const _dfPath = resolveWorkspacePath(data.path || "");
              const _g = _gateFrontendFileOp("delete", _dfPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                // T026 凛倾原话：「文件级别的删除是进电脑的回收站，而不是直接全部删除」——
                // 前端文件浏览器删除进系统回收站（safeTrash 文件/目录通吃，失败自带 _trash_fallback 兜底）。
                const _dfR = await withFileWriteLock(_g.path, () => safeTrash(_g.path, "user_delete")); // M6：并发锁，防删与写竞态
                if (!_dfR?.success) return { _result: { error: `移入回收站失败: ${_dfR?.error || "未知错误"}`, path: data.path } };
                return { _result: { success: true, path: data.path, method: _dfR.method } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            case "createDir": {
              const _cdPath = resolveWorkspacePath(data.path || "");
              const _g = _gateFrontendFileOp("create", _cdPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                await withFileWriteLock(_g.path, () => Deno.mkdir(_g.path, { recursive: true })); // M6：并发锁
                return { _result: { success: true, path: data.path } };
              } catch (err) {
                return { _result: { error: err.message, path: data.path } };
              }
            }
            // N6/N22：前端直接 move/rename。rename=同目录改名（用 newName 拼同目录目标），move=跨目录（用 destPath）。
            //   两端各过统一沙箱闸：源走 delete 权限(移走)、目标走 create 权限(落新位)，复用 AI move 路径同款 Deno.rename。
            case "rename":
            case "move": {
              const _mvSrcPath = resolveWorkspacePath(data.path || "");
              const _srcG = _gateFrontendFileOp("delete", _mvSrcPath, data.chatid);
              if (!_srcG.ok)
                return { _result: { error: _srcG.error, path: data.path } };
              let destInput = data.destPath ? resolveWorkspacePath(data.destPath) : undefined;
              if (data._action === "rename") {
                if (!data.newName)
                  return { _result: { error: "缺少 newName", path: data.path } };
                const _srcNorm = _mvSrcPath.replace(/\\/g, "/");
                const _dir = _srcNorm.split("/").slice(0, -1).join("/");
                destInput = (_dir ? _dir + "/" : "") + data.newName;
              }
              if (!destInput)
                return { _result: { error: "缺少目标路径 destPath", path: data.path } };
              const _dstG = _gateFrontendFileOp("create", destInput, data.chatid);
              if (!_dstG.ok)
                return { _result: { error: _dstG.error, path: destInput } };
              try {
                // M6：rename/move 同时锁 src+dst 两键，按字典序固定加锁顺序防 A→B/B→A 交叉死锁（对齐 AI 路径 :1678-1686）。
                const _k1 = String(_srcG.path).replace(/\\/g, "/").toLowerCase();
                const _k2 = String(_dstG.path).replace(/\\/g, "/").toLowerCase();
                const _doRename = () => Deno.rename(_srcG.path, _dstG.path);
                if (_k1 === _k2) await withFileWriteLock(_srcG.path, _doRename);
                else { const [_lo, _hi] = _k1 <_k2 ? [_srcG.path, _dstG.path] : [_dstG.path, _srcG.path]; await withFileWriteLock(_lo, () => withFileWriteLock(_hi, _doRename)); }
                // [0723 问题1.1] 透传源/目标 warnings(改名时文件名含敏感词)→前端弹 confirm 提醒,不拦改名
                const _mvWarnings = [...(_srcG.warnings || []), ...(_dstG.warnings || [])];
                return { _result: { success: true, path: data.path, destPath: destInput, ...(_mvWarnings.length ? { warnings: _mvWarnings } : {}) } };
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
                // N2：审批≠路径免检。入队 op 在主循环权限 OFF 分支早退、未过路径校验，
                //   此处补走单源校验链（canonical+系统盘+沙箱+黑白名单），不通过则拒绝不执行。
                const sec = validateOpSecurity(op);
                if (!sec.ok) {
                  op.status = "rejected";
                  op.error = sec.error;
                  pluginData.operationHistory.push(op);
                  // 传导链修：拦截结果也要回注 AI（否则 AI 以为还在等审批，静默挂死）
                  pushPendingOpResult(op._cid, { text: _formatOpResultLine(op), timestamp: Date.now(), opCount: 1 });
                  console.log(
                    `[beilu-files] 手动审批 op 被路径校验拦截: ${op.type} ${op.path} (${sec.error})`,
                  );
                } else {
                  // N46 policy:"always"：sec.ok 后 op.path 已 canonical，据此落 always 规则
                  //（type+目录前缀），本条照常执行；持久化走 action 流程末尾统一落盘。
                  if (data.policy === "always" && op.type !== "exec" && op.path) {
                    addApprovalAlwaysRule(op.type, path.dirname(op.path));
                    console.log(
                      `[beilu-files] N46 落 always 规则: ${op.type} ${path.dirname(op.path)}`,
                    );
                  }
                  // 81：手动审批写路径同样停+激活其他窗口（用入队时记录的发起 chatid op._cid）。
                  const _apIsWrite = ["write", "create", "move", "fuzzy_edit", "edit_xlsx", "delete"].includes(op.type);
                  let _apStopped = [];
                  if (_apIsWrite && op.path) {
                    // [多开 0726] 注册表键归一为绝对路径（resolveCanonicalOpPath 与执行/沙箱同锚）：
                    // 多窗口不同工作区同名相对路径原会撞键→误停别的线；abs 后同名不同根不撞、真同文件（IDE↔file_op）仍协调
                    try { _apStopped = await fileEditRegistry.onWriteStart(resolveCanonicalOpPath(op.path, op._cid), op._cid); } catch { /* 不阻断 */ }
                  }
                  const result = await executeFileOperation(op);
                  pluginData.operationHistory.push(result);
                  // 传导链修（凛倾 2026-07-09）：手动批准的执行结果回注 AI——此前只进 operationHistory，
                  //   用户点了「允许」但结果永远到不了 pendingOpResults → GetPrompt 注入链在此断。
                  //   续轮由前端审批回调调 trigger-reply 踢（fileExplorer 审批按钮处）。
                  pushPendingOpResult(op._cid, { text: _formatOpResultLine(result || op), timestamp: Date.now(), opCount: 1 });
                  if (op.path && (result?.status || op.status) === "completed") {
                    try { fileEditRegistry.touch(resolveCanonicalOpPath(op.path, op._cid), op._cid); } catch { /* noop */ }
                    if (_apIsWrite) {
                      try { await fileEditRegistry.onWriteComplete(resolveCanonicalOpPath(op.destPath || op.path, op._cid), op._cid, _apStopped); } catch { /* 不阻断 */ }
                    }
                  }
                }
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
                if (!op.error) op.error = "用户拒绝了此操作";
                pluginData.pendingOperations =
                  pluginData.pendingOperations.filter(
                    (o) => o.id !== data.opId,
                  );
                pluginData.operationHistory.push(op);
                // 传导链修：拒绝也要告知 AI（对齐主循环 rejectedOps 注入——否则 AI 以为还在等审批）
                pushPendingOpResult(op._cid, { text: _formatOpResultLine(op), timestamp: Date.now(), opCount: 1 });
              }
              break;
            }
            case "approveAll": {
              // 多窗口隔离：只批本会话(op._cid===chatid)+无归属(!op._cid)的 op；
              //   无 data.chatid 时回退全量（兼容旧调用）。其他会话待审 op 留队不动。
              //   对齐 ideToolCall 侧 approveAll 的 sessionKey 隔离，杜绝 A 窗口「全部批准」批掉 B 的待审。
              const _aaCid = data.chatid;
              const _aaMatch = (o) => !_aaCid || o._cid === _aaCid || !o._cid;
              // 先认领（从待审队列摘走匹配项）再执行：approveAll 含 await，若循环后才移除，
              //   并发 approveAll（多窗口同时点全批）会对无归属 op(_cid=null) 双取双执行。先摘后执行根除。
              const _aaClaimed = pluginData.pendingOperations.filter(_aaMatch);
              pluginData.pendingOperations = pluginData.pendingOperations.filter((o) => !_aaMatch(o));
              for (const op of _aaClaimed) {
                op.status = "approved";
                // N2：同 approveOp，审批≠路径免检，批量审批每个 op 都过单源校验链。
                const sec = validateOpSecurity(op);
                if (!sec.ok) {
                  op.status = "rejected";
                  op.error = sec.error;
                  pluginData.operationHistory.push(op);
                  console.log(
                    `[beilu-files] 批量审批 op 被路径校验拦截: ${op.type} ${op.path} (${sec.error})`,
                  );
                  continue;
                }
                // 81：批量审批写路径同样停+激活其他窗口（用入队记录的发起 chatid op._cid）。
                const _aaIsWrite = ["write", "create", "move", "fuzzy_edit", "edit_xlsx", "delete"].includes(op.type);
                let _aaStopped = [];
                if (_aaIsWrite && op.path) {
                  try { _aaStopped = await fileEditRegistry.onWriteStart(resolveCanonicalOpPath(op.path, op._cid), op._cid); } catch { /* 不阻断 */ } // [多开 0726] abs 键归一（同上簇注释）
                }
                const result = await executeFileOperation(op);
                pluginData.operationHistory.push(result);
                // 传导链修：批量批准的执行结果同样回注 AI（逐 op 按其发起窗口 _cid 分桶推）
                pushPendingOpResult(op._cid, { text: _formatOpResultLine(result || op), timestamp: Date.now(), opCount: 1 });
                if (op.path && (result?.status || op.status) === "completed") {
                  try { fileEditRegistry.touch(resolveCanonicalOpPath(op.path, op._cid), op._cid); } catch { /* noop */ }
                  if (_aaIsWrite) {
                    try { await fileEditRegistry.onWriteComplete(resolveCanonicalOpPath(op.destPath || op.path, op._cid), op._cid, _aaStopped); } catch { /* 不阻断 */ }
                  }
                }
              }
              // 已处理项在认领时即从队列摘走（见上），此处无需再 filter。
              break;
            }
            case "rejectAll": {
              // 多窗口隔离 + 先认领后处理（同 approveAll）：只拒本会话+无归属 op，其他会话留队。
              const _raCid = data.chatid;
              const _raMatch = (o) => !_raCid || o._cid === _raCid || !o._cid;
              const _raClaimed = pluginData.pendingOperations.filter(_raMatch);
              pluginData.pendingOperations = pluginData.pendingOperations.filter((o) => !_raMatch(o));
              for (const op of _raClaimed) {
                op.status = "rejected";
                if (!op.error) op.error = "用户拒绝了此操作";
                pluginData.operationHistory.push(op);
                // 传导链修：批量拒绝同样告知 AI（逐 op 按发起窗口 _cid 分桶）
                pushPendingOpResult(op._cid, { text: _formatOpResultLine(op), timestamp: Date.now(), opCount: 1 });
              }
              break;
            }
            // N46：删一条 always 规则（按 {type,pathPrefix} 或 index）；落盘走 action 流程末尾。
            case "removeApprovalAlwaysRule": {
              if (!Array.isArray(pluginData.approvalAlwaysRules))
                pluginData.approvalAlwaysRules = [];
              if (data.index !== undefined) {
                pluginData.approvalAlwaysRules.splice(Number(data.index), 1);
              } else if (data.type) {
                pluginData.approvalAlwaysRules =
                  pluginData.approvalAlwaysRules.filter(
                    (r) =>
                      !(
                        r &&
                        r.type === data.type &&
                        String(r.pathPrefix || "") ===
                          String(data.pathPrefix || "")
                      ),
                  );
              }
              break;
            }
            // leak-fix（与 fileEditRegistry 发现1 同类）：会话删除时清本会话残留的 per-chatid 运行时态，
            // 防 activeModes/pendingOpResults/fileModeSessions 随 chatid 单调泄漏（三者只 set 无单删、deleteChat 原不通知）。
            // 经 SetData seam 调用（chatStorage deleteChat 反向桥），不造旁路；"" 全局兜底键不删。
            case "forgetChatState": {
              const _fcid = data.chatid;
              if (_fcid) {
                pluginData.activeModes.delete(_fcid);
                pluginData.pendingOpResults.delete(_fcid);
                pluginData.fileModeSessions.delete(_fcid);
              }
              break;
            }
            case "getFileHistoryConfig": {
              // T060b：loadConfig 损坏抛 CorruptJsonError（已备份 .corrupt.bak），转失败返回不静默返默认配置。
              try {
                return { _result: fileHistory.loadConfig(_als.getStore()?.username || "") };
              } catch (e) {
                return { _result: { success: false, error: `文件历史配置损坏：${e.message}` } };
              }
            }
            case "setFileHistoryConfig": {
              const _u = _als.getStore()?.username || "";
              // T060b：读旧配置合并新字段——若旧 config.json 损坏，loadConfig 抛错。此处必须报错而非吞：
              //   否则会用 DEFAULT_CONFIG 合并后 saveConfig 覆写，把损坏文件"洗成"默认+本次改动=静默丢原配置。
              let _cfg;
              try {
                _cfg = fileHistory.loadConfig(_u);
              } catch (e) {
                return { _result: { success: false, error: `文件历史配置损坏，已备份待修复，未覆写：${e.message}` } };
              }
              if (data.watchFolders !== undefined) _cfg.watchFolders = data.watchFolders;
              if (data.strategy !== undefined) _cfg.strategy = data.strategy;
              if (data.maxVersions !== undefined) _cfg.maxVersions = data.maxVersions;
              fileHistory.saveConfig(_u, _cfg);
              return { _result: { success: true } };
            }
            case "getFileVersions": {
              return { _result: fileHistory.getFileVersions(_als.getStore()?.username || "", data.path, data.chatid) };
            }
            case "revertFileVersion": {
              return { _result: fileHistory.revertToVersion(_als.getStore()?.username || "", data.path, data.timestamp, data.chatid) };
            }
            case "getFileDiff": {
              return { _result: fileHistory.diffVersions(_als.getStore()?.username || "", data.path, data.ts1, data.ts2, data.chatid) };
            }
            case "manualBackup": {
              return { _result: fileHistory.manualBackupAll(_als.getStore()?.username || "", data.chatid) };
            }
            case "listChatBackups": {
              if (!data.chatid) return { _result: { success: false, error: "缺少chatid" } };
              return { _result: { success: true, snapshots: listAllChatBackups(data.chatid) } };
            }
            case "restoreChatBackup": {
              if (!data.chatid || !data.file) return { _result: { success: false, error: "缺少chatid或file" } };
              const source = data.source || "undo";
              const chatLog = source === "auto"
                ? loadChatAutoBackup(data.chatid, data.file)
                : loadChatLogSnapshot(data.chatid, data.file);
              if (!chatLog) return { _result: { success: false, error: "快照不存在或已损坏" } };
              try {
                const { loadChat, saveChat } = await import("../../shells/beilu-chat/src/lib/chatStorage.mjs");
                const chatMeta = await loadChat(data.chatid);
                if (!chatMeta) return { _result: { success: false, error: "对话不存在" } };
                chatLogSnapshot(data.chatid, chatMeta.chatLog, "before_restore");
                const restoredLog = Array.isArray(chatLog) ? chatLog : (chatLog.chatLog || []);
                chatMeta.chatLog = restoredLog;
                if (restoredLog.length > 0) {
                  const last = restoredLog[restoredLog.length - 1];
                  if (last.timeSlice) chatMeta.LastTimeSlice = last.timeSlice;
                  chatMeta.timeLines = [last];
                  chatMeta.timeLineIndex = 0;
                }
                await saveChat(data.chatid);
                return { _result: { success: true, messageCount: restoredLog.length } };
              } catch (e) {
                return { _result: { success: false, error: e.message } };
              }
            }
            case "verifyGitHubToken": {
              return { _result: await gitHub.verifyToken(data.token) };
            }
            case "listGitHubRepos": {
              return { _result: await gitHub.listRepos(data.token, data.page, data.perPage) };
            }
            case "linkGitHub": {
              return { _result: await gitHub.linkGitHub(_als.getStore()?.username || "", { token: data.token, repo: data.repo, branch: data.branch }) };
            }
            case "unlinkGitHub": {
              const _ulUser = _als.getStore()?.username || "";
              // T060b：loadConfig 损坏抛错，转失败返回不静默按默认配置继续（默认 watchFolders=[] 会算错 workDir）。
              let _ulCfg;
              try {
                _ulCfg = fileHistory.loadConfig(_ulUser);
              } catch (e) {
                return { _result: { success: false, error: `文件历史配置损坏：${e.message}` } };
              }
              const _ulDir = pluginData.workspaceRoot || _ulCfg.watchFolders?.[0];
              return { _result: await gitHub.unlinkGitHub(_ulUser, _ulDir) };
            }
            case "getGitHubStatus": {
              return { _result: gitHub.getGitHubStatus(_als.getStore()?.username || "") };
            }
            case "testGitHubConnection": {
              return { _result: await gitHub.testConnection(_als.getStore()?.username || "") };
            }
            case "syncToGitHub": {
              const _syncUser = _als.getStore()?.username || "";
              // T060b：loadConfig 损坏抛错，转失败返回不静默按默认配置同步（默认 watchFolders=[] 会漏同步文件夹）。
              let _fhCfg;
              try {
                _fhCfg = fileHistory.loadConfig(_syncUser);
              } catch (e) {
                return { _result: { success: false, error: `文件历史配置损坏：${e.message}` } };
              }
              const _folders = _fhCfg.watchFolders || [];
              const _workDir = pluginData.workspaceRoot || _folders[0] || ".";
              return { _result: await gitHub.syncToGitHub(_syncUser, _workDir, data.message, _folders) };
            }
            case "searchFiles": {
              const _sfPath = resolveWorkspacePath(data.path || ".");
              const _g = _gateFrontendFileOp("list", _sfPath, data.chatid);
              if (!_g.ok)
                return { _result: { error: _g.error, path: data.path } };
              try {
                const result = await searchFilesContent(
                  _g.path,
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
              clearAllPendingOpResults();
              return { success: true };
            }
            case "getPendingOpResults": {
              // 前端轮询：是否有待注入的操作结果（UI 跨会话 flatten 看全部）
              const all = flattenAllPendingOpResults();
              return {
                hasPending: all.length > 0,
                count: all.length,
              };
            }
            case "consumePendingOpResults": {
              // 前端消费：返回完整结果文本并清空（一次性使用，跨会话 flatten）
              const all = flattenAllPendingOpResults();
              if (all.length === 0) {
                return { hasPending: false, resultsText: "" };
              }
              const resultsText = all.map((r) => r.text).join("\n\n");
              const count = all.length;
              clearAllPendingOpResults();
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
              // N1：值域补 "work"。前端 work tab（layout.mjs TAB_TO_MODE.work="work"）
              //   切换时 notifyActiveMode 发 mode:"work"，原 validModes 不含 work → 静默 break 不写，
              //   beilu-files activeMode 卡在上一个值，GetPrompt 门控（非 chat 才注入工作区）误判 → work 模式下
              //   IDE 工作区元数据可能不注入。补 work 后 work 与 file/memory 同样触发注入。
              const validModes = ["chat", "file", "memory", "work"];
              if (validModes.includes(data.mode)) {
                // N1：按会话键(chatid)分区，多窗口/多角色互不串台。
                const _cid = data.chatid || "";
                const previousMode = getActiveMode(_cid);
                setActiveMode(_cid, data.mode);

                // 同步工作区根路径（2026-08-01 幽灵根拒收：非法根保留旧值，模式切换本身不失败）
                if (data.rootPath !== undefined) {
                  const _vErr2 = validateWorkspaceRoot(data.rootPath || DEFAULT_WORKSPACE_ROOT);
                  if (_vErr2) { console.warn(`[beilu-files] setMode 携带非法工作区根，保留旧根: ${_vErr2}`); }
                  else {
                  pluginData.workspaceRoot = data.rootPath || DEFAULT_WORKSPACE_ROOT;
                  // FT-multiwin：同步写本窗口(_cid)隔离根，AI op 经 op._cid 锚到此根，多窗口不串台。
                  pluginData.workspaceRoots.set(_cid, pluginData.workspaceRoot);
                  // 清除目录树缓存，下次 GetPrompt 时重新读取
                  pluginData.workspaceTreeCache = "";
                  pluginData.workspaceTreeCacheTime = 0;
                  console.log(
                    `[beilu-files] 工作区根路径更新: ${pluginData.workspaceRoot}`,
                  );
                  }
                }

                // 进入文件/记忆模式：记录起始点（N6：按会话键 _cid 分区，与 setActiveMode 同键）
                if (
                  (data.mode === "file" || data.mode === "memory") &&
                  previousMode === "chat"
                ) {
                  const _startIndex = data.currentMessageCount ?? -1;
                  setFileModeSession(_cid, _startIndex);
                  // 清除已执行操作签名（新会话不受旧签名影响）
                  pluginData.executedOpSignatures.clear();
                  console.log(
                    `[beilu-files] 进入${data.mode}模式, 起始索引=${_startIndex}, chatid=${_cid}`,
                  );
                }

                // 退出文件/记忆模式：返回清理信息（N6：只读/清本会话键 _cid）
                if (
                  data.mode === "chat" &&
                  (previousMode === "file" || previousMode === "memory")
                ) {
                  const _sess = getFileModeSession(_cid);
                  const cleanup =
                    _sess && _sess.startIndex >= 0
                      ? {
                          _cleanup: {
                            chatid: _cid,
                            startIndex: _sess.startIndex,
                          },
                        }
                      : null;

                  clearFileModeSession(_cid);
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
              // 返回当前文件模式的清理信息（供手动清理按钮使用）。
              // N6：按调用方会话键(data.chatid)分区读，本键缺失回落兜底键 ""；
              //   前端 idePanel 手动清理已带 chatid（见 idePanel.mjs handleMenuAction/ide-manual-cleanup）。
              const _cid = data.chatid || "";
              const _sess = getFileModeSession(_cid);
              if (_sess && _sess.startIndex >= 0) {
                return {
                  startIndex: _sess.startIndex,
                  chatid: _cid,
                  // N1：返回该隔离会话的模式（按 chatid 分区读，缺失回落兜底/默认）
                  mode: getActiveMode(_cid),
                };
              }
              return { startIndex: -1 };
            }
            case "setWorkspaceRoot": {
              const _newRoot = data.rootPath || DEFAULT_WORKSPACE_ROOT;
              // 幽灵根拒收（2026-08-01，见 validateWorkspaceRoot 注释）：拒绝即返回错误，
              //   不改内存不落盘——调用方（YonBan 反向桥/前端）收到可见错误自行纠正。
              {
                const _vErr = validateWorkspaceRoot(_newRoot);
                if (_vErr) {
                  console.warn(`[beilu-files] setWorkspaceRoot 拒绝: ${_vErr}`);
                  return { _result: { error: _vErr } };
                }
              }
              // IDE 保护：IDE(YonBan) 已设非默认根 → 本体初始化试图用默认值覆盖时跳过
              if (_newRoot === DEFAULT_WORKSPACE_ROOT
                  && pluginData._workspaceRootFromIDE
                  && pluginData.workspaceRoot !== DEFAULT_WORKSPACE_ROOT) {
                console.log(
                  `[beilu-files] IDE 已设工作区根 ${pluginData.workspaceRoot}, 跳过默认值覆盖`,
                );
                break;
              }
              if (data._fromIDE) pluginData._workspaceRootFromIDE = true;
              pluginData.workspaceRoot = _newRoot;
              // FT-multiwin：同步写本窗口(data.chatid)隔离根（无 chatid → 兜底键 ""=全局默认）。
              pluginData.workspaceRoots.set(data.chatid || "", pluginData.workspaceRoot);
              pluginData.workspaceTreeCache = "";
              pluginData.workspaceTreeCacheTime = 0;
              console.log(
                `[beilu-files] 工作区根路径设置: ${pluginData.workspaceRoot}`,
              );
              break;
            }
            case "ensureDefaultWorkspace": {
              // 任务A防护：前端面板初始化时调用——创建（幂等 mkdir，用户删了下次进来自动重建）并返回
              //   默认「ai玩耍空间」【相对】路径（凛倾 2026-07-09「用相对空间」：随部署可移植，
              //   前端 rootPath/记忆存相对值，resolve 锚 CWD 由 resolveWorkspacePath/resolveCanonicalOpPath 统一做）。
              //   路径值单源在后端，前端禁硬编码；不在此写根：写根走前端既有 setFileExplorerRoot 单一路径。
              try {
                await Deno.mkdir(path.resolve(DEFAULT_WORKSPACE_ROOT), { recursive: true });
                return { _result: { path: DEFAULT_WORKSPACE_ROOT } };
              } catch (err) {
                return { _result: { error: err.message } };
              }
            }
            default:
              break;
          }
          // ★ 治 dir-bug（簇①）：action 分支（setWorkspaceRoot / setMode 带 rootPath）原直接 return，
          //   跳过下方 :savePersistedSettings → 内存改了、磁盘 beilu-files-settings.json 没改 →
          //   AI 侧 ideClient._readCanonicalWorkspace 读旧根（直到下次 field 式 SetData 才 persist）。
          //   此处补持久化：所有 action 式变更（含工作区根/模式）立即落盘。
          savePersistedSettings();
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
        if (data.treeDepth !== undefined) {
          pluginData.treeDepth = Math.max(1, Math.min(5, Number(data.treeDepth) || 2));
          pluginData.workspaceTreeCache = "";
          pluginData.workspaceTreeCacheTime = 0;
        }
        if (data.treeShowSize !== undefined) {
          pluginData.treeShowSize = !!data.treeShowSize;
          pluginData.workspaceTreeCache = "";
          pluginData.workspaceTreeCacheTime = 0;
        }
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
       * GetPrompt — 注入工作区元数据 + 待处理文件操作结果。
       *
       * 链路：getPromptHandler 21步 → 本函数 → 返回值写入
       *       prompt_struct.plugin_prompts["beilu-files"]，
       *       beilu-preset TweakPrompt Round 2 自动收集 text[] 到 injectionBelow (@D0)。
       *
       * 返回内容：
       *   · extension.workspace_root — 当前工作区根（FT-multiwin: 按 _cid 取隔离根）
       *   · extension.workspace_tree — 工作区目录树文本（5秒缓存）
       *   · text[] — ReplyHandler 执行的文件操作结果（drainPendingOpResultsForSession）
       *
       * 范围：chat 模式下返回 null（不注入任何内容）; file/memory/work 模式注入。
       *       文件操作能力说明由 INJ-2 注入提示词负责，本函数不注入。
       *
       * 影响：drain pendingOpResults（一次性消费，读后清空该会话键）
       */
      GetPrompt: async (arg) => {
        // ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText（用户可配），操作说明走 INJ 条目。shadowBuild 会检测并隐藏 >200 字符的非宏内容。
        return _als.run({ username: arg?.username || "_default" }, async () => { // 破口B: per-user 上下文（pluginData 透明路由）
        const _cid = arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null;
        wbT(_cid, "files", "GetPrompt:enter", {});
        if (!pluginData.enabled) return null;

        // 层级权限：chat 模式下不注入任何内容（N1：按本会话 chatid 分区读，非全局单值）
        //   file/memory/work 模式均注入工作区元数据；work 此前因 setMode 漏值域而注入丢失，已修。
        if (getActiveMode(_cid) === "chat") return null;

        // beilu-files GetPrompt 不再注入文件操作说明（由 INJ-2 注入提示词负责）
        // 仅提供工作区元数据供 INJ-2 的宏 {{workspace_root}} / {{workspace_tree}} 使用
        // FT-multiwin：按本会话 _cid 取隔离根，AI 看到的 workspace_root/tree 与其 op 落地根(op._cid)一致，多窗口不串。
        const wsRoot = getWorkspaceRoot(_cid);
        const workspaceTree = await buildWorkspaceTree(wsRoot);

        // ---- 操作结果闭环注入 ----
        // 通过 text[] 返回，beilu-preset 在 TweakPrompt Round 2 中
        // 将其他插件的 text 内容自动收集到 injectionBelow (@D0)
        // F5：只 drain 本会话键(_cid) + 兜底键 ""（无键的结果对所有会话可见），互不串吞。
        const textEntries = [];
        const myResults = drainPendingOpResultsForSession(_cid);
        if (myResults.length > 0) {
          const resultsText = myResults.map((r) => r.text).join("\n\n");
          textEntries.push({
            content: `[文件操作执行结果]\n${resultsText}\n\n${getInjectText("files.op_result_instruction")}`,
            role: "system",
          });
          console.log(
            `[beilu-files] GetPrompt: 通过 text[] 注入 ${myResults.length} 条操作结果（会话键=${_cid || "(全局)"}，beilu-preset 自动收集到 @D0 injectionBelow）`,
          );
        }

        return {
          text: textEntries,
          extension: {
            workspace_root: wsRoot,
            workspace_tree: workspaceTree || "",
          },
        };
        }); // 破口B: 关闭 GetPrompt 的 _als.run
      },

      /**
       * ReplyHandler — AI 回复中的文件操作解析+安全校验+执行主循环。
       *
       * 链路：generation executeGeneration → handleReply → 本函数
       *       → parseFileOperations() → for-each op 依次过:
       *         N42 Bot 闸(L0-L3) → N46 always 规则 → 权限开关 →
       *         exec 闸(deployGatedAllow) → validateOpSecurity(四层纵深) →
       *         shouldAutoApprove → executeFileOperation / pendingOperations 入队
       *       → 结果分流: successOps → pendingOpResults (注入给 AI)
       *                   failedOps → pendingErrors (通知用户)
       *                   rejectedOps → pendingOpResults (告知 AI 被拒原因)
       *
       * 影响：改 reply.content (清除 <file_op>/<tool_call> 标签);
       *       写磁盘(executeFileOperation); fileEditRegistry 停/激活通知;
       *       pluginData.operationHistory/pendingOperations/pendingErrors 队列;
       *       刷新 workspaceTreeCache
       *
       * 约束：contentSignature 去重防同一回复重复执行;
       *       叠加序: N42 Bot 闸 > N46 always 规则 > 全局 autoApprove
       *       (L2 写操作即使 always 命中仍强制审批);
       *       per-user 隔离经 _als.run 注入 username 上下文
       */
      ReplyHandler: async (reply, args) => {
        return _als.run({ username: args?.username || "_default" }, async () => { // 破口B: per-user 上下文（pluginData 透明路由）
        const _cid = args?.chatid || args?.chat_name?.replace("common_chat_", "") || null;
        wbT(_cid, "files", "ReplyHandler:enter", {});
        if (!pluginData.enabled) {
          return false;
        }
        if (!reply || !reply.content) {
          return false;
        }

        const operations = parseFileOperations(reply.content);
        wbT(_cid, "files", "parseFileOps", { n: operations.length });
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
          // 仍然清除标签，但不执行操作（收口：与主剥离同源正则，覆盖自闭合 <file_op ... />）
          reply.content = reply.content
            .replace(_fileOpTagRegex(), "")
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
          fuzzy_edit: "file_write", // 模糊编辑=写操作，归入 write 权限（与 IDE/YonBan 一致）
          edit_xlsx: "file_write", // xlsx 定点改公式=写操作，归入 write 权限（与 YonBan 一致）
          insert: "file_write", // 任务C：行锚插入=写操作（与 YonBan insert_at_line 一致）
          replace_lines: "file_write", // 任务C：行区间替换=写操作（与 YonBan replace_lines 一致）
          search: "file_read", // search 归入 read 权限
          exec: "file_write", // exec 归入 write 权限
        };

        // ---- N42 Bot 来源访问档位策略点（K7 接线，Bot设计 :470-489）----
        // 本轮触发者来自 Bot 外部用户时按 _permissionLevel 在服务端裁决（不依赖提示词约束）：
        //   L0=不放行任何操作 / L1=仅读 / L2=读放行+写升级到确认队列（优先级高于全局 autoApprove）/ L3=走现行规则。
        // 非 Bot 来源（本地用户）botPerm=null → 行为零变化。
        const botPerm = resolveRequestBotPermission(args?.chat_log);
        const _BOT_READ_TYPES = new Set(["read", "list", "search"]);

        // 工作区沙箱根路径归一（path.resolve 同锚，消除「校验落点≠落盘落点」，F1）
        //   已下沉到 validateOpSecurity 内（主循环与手动审批共用单源），此处不再重复计算。

        for (const op of operations) {
          // 81：记录发起窗口 chatid，供入队 op 在「手动审批执行时」也能停+激活其他窗口（autoApprove 关路径）。
          op._cid = _cid;
          // N42 Bot 访问档位策略（最先判，档位是上限）
          if (botPerm && botPerm.level <= 1) {
            const _botAllowed = botPerm.level === 1 && _BOT_READ_TYPES.has(op.type);
            if (!_botAllowed) {
              op.status = "rejected";
              op.error = `Bot 权限不足 (L${botPerm.level}): ${op.type} 被拒绝`;
              pluginData.operationHistory.push(op);
              wbD(_cid, "files", "bot_permission_block", false, op.error, { type: op.type, level: botPerm.level });
              console.warn(`[beilu-files] N42 Bot权限闸: L${botPerm.level} 拒绝 ${op.type} ${op.path || ""}`);
              continue;
            }
          }

          // N46「总是允许」规则命中：跳过两个审批入队口（权限 OFF 队列 + 非自动批准队列）直接执行。
          // 位置在 Bot 闸之后（L0/L1 上方已裁决；L2 写操作下方仍强制入确认队列=档位是上限）。
          // always ≠ 免检：exec 开关与 validateOpSecurity 照常生效。
          const _alwaysHit = matchApprovalAlwaysRule(op);
          if (_alwaysHit) {
            wbT(_cid, "files", "approval_always_hit", { type: op.type, path: op.path || "" });
            console.log(`[beilu-files] N46 always 规则命中: ${op.type} ${op.path || ""} → 免审`);
          }

          // 安全检查: 权限开关 → 权限 OFF 时放入待审批队列（用户可手动批准；always 命中除外）
          const requiredPermission = permissionMap[op.type];
          if (
            requiredPermission &&
            !pluginData.permissions[requiredPermission] &&
            !_alwaysHit
          ) {
            op.status = "pending";
            op.error = `需要审批: ${op.type} 操作 (${requiredPermission} 权限未开启)`;
            pluginData.pendingOperations.push(op);
            console.log(
              `[beilu-files] 操作需要审批: ${op.type} ${op.path} (${requiredPermission}=OFF) → 加入待审批队列`,
            );
            continue;
          }

          // 安全检查: exec 权限（SEC-R1/审计：生效经 deployGatedAllow，server 下非 owner 翻的 allowExec 不生效）
          if (op.type === "exec" && !(pluginData.allowExec && deployGatedAllow("allowFileExec", "BEILU_FILE_EXEC"))) {
            op.status = "rejected";
            op.error = "Command execution is disabled";
            pluginData.operationHistory.push(op);
            wbD(_cid, "files", "exec_gate_reject", false, "exec拒绝:allowExec关或server部署闸未开", { allowExec: pluginData.allowExec });
            continue;
          }

          // ---- 路径安全校验单源（N2）：canonical 解析 + 系统盘/敏感路径拦截 + 工作区沙箱 + 黑白名单。
          //   原 F2/F7a/F7b/沙箱四段在此内联，现抽成 validateOpSecurity 供主循环与手动审批路径共用，
          //   消除「审批旁路免检」与逻辑双套。op.path/op.destPath 在函数内被原地改写为 canonical 值。
          {
            const sec = validateOpSecurity(op);
            if (!sec.ok) {
              op.status = "rejected";
              op.error = sec.error;
              pluginData.operationHistory.push(op);
              console.log(
                `[beilu-files] 操作被路径安全校验拦截: ${op.type} ${op.path || op.destPath || ""} (${sec.error})`,
              );
              continue;
            }
          }

          // 判断是否自动批准（N46 always 命中=免审，等同自动批准）
          let shouldAutoApprove =
            pluginData.autoApprove ||
            (pluginData.autoApproveRead &&
              (op.type === "read" || op.type === "list")) ||
            _alwaysHit;

          // N42: Bot L2 写操作升级到确认队列——优先级高于全局 autoApprove（档位是上限，
          // 即使 N46 always 规则命中，Bot 写操作仍需确认）
          if (botPerm && botPerm.level === 2 && !_BOT_READ_TYPES.has(op.type)) {
            shouldAutoApprove = false;
            wbT(_cid, "files", "bot_permission_force_approval", { type: op.type });
            console.log(`[beilu-files] N42 Bot权限闸: L2 写操作强制审批 ${op.type} ${op.path || ""}`);
          }

          if (shouldAutoApprove) {
            op.status = "approved";
            // 81 多开同文件：写类操作执行前，停其他窗口对同文件的在飞生成（读类不停）。
            const _isWriteOp = ["write", "create", "move", "fuzzy_edit", "edit_xlsx", "delete"].includes(op.type);
            let _stoppedCids = [];
            if (_isWriteOp && op.path) {
              try { _stoppedCids = await fileEditRegistry.onWriteStart(resolveCanonicalOpPath(op.path, _cid), _cid); } catch { /* 停失败不阻断写，被动重读兜底 */ } // [多开 0726] abs 键归一
            }
            const result = await executeFileOperation(op);
            pluginData.operationHistory.push(result);
            // 81：登记本窗口为该文件编辑者（读/写都算在编辑）+ 写成功后【只激活刚被打断的窗口】重读续。
            const _opOk = (result?.status || op.status) === "completed";
            if (_opOk && op.path) {
              try { fileEditRegistry.touch(resolveCanonicalOpPath(op.path, _cid), _cid); } catch { /* noop */ }
              if (op.destPath) { try { fileEditRegistry.touch(resolveCanonicalOpPath(op.destPath, _cid), _cid); } catch { /* noop */ } }
              if (_isWriteOp) {
                try { await fileEditRegistry.onWriteComplete(resolveCanonicalOpPath(op.destPath || op.path, _cid), _cid, _stoppedCids); } catch { /* 激活失败不阻断，被动重读兜底 */ }
              }
            }
          } else {
            // 加入待批准队列
            pluginData.pendingOperations.push(op);
          }
        }

        // ---- 分离成功/失败/被拒操作结果 ----
        const successOps = operations.filter((op) => op.status === "completed");
        const failedOps = operations.filter((op) => op.status === "failed");
        // rejected（沙箱/黑名单/exec禁用/权限）此前两桶都不进=双向静默：AI 误以为操作成功盲继续、用户也看不到。
        const rejectedOps = operations.filter((op) => op.status === "rejected");

        // 成功操作 → pendingOpResults（注入给 AI 继续工作）
        if (successOps.length > 0) {
          const resultLines = successOps.map(_formatOpResultLine);

          pushPendingOpResult(_cid, {
            text: resultLines.join("\n\n"),
            timestamp: Date.now(),
            opCount: successOps.length,
          });

          wbT(_cid, "files", "fileop:success", { n: successOps.length });
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

          wbD(_cid, "files", "fileop:failed", false, "文件操作失败", { n: failedOps.length });
          console.log(
            `[beilu-files] ReplyHandler: ${failedOps.length} 条操作失败, 已加入错误队列（将通知用户并停止自动回复）`,
          );
        }

        // 被拒操作（沙箱/黑名单/exec禁用/权限）→ 注入给 AI（避免 AI 误以为成功盲继续）+ wbD 映射到前端面板（用户可见）。
        // 此前 rejected 既不进 pendingOpResults 也不进 pendingErrors，仅 console.log = 双向静默。
        if (rejectedOps.length > 0) {
          const rejLines = rejectedOps.map(
            (op) => `🚫 ${op.type} \`${op.path || op.command || ""}\` 被拒绝: ${op.error || "策略限制"}`,
          );
          pushPendingOpResult(_cid, {
            text: rejLines.join("\n\n"),
            timestamp: Date.now(),
            opCount: rejectedOps.length,
          });
          wbD(_cid, "files", "fileop:rejected", false, "文件操作被拒绝（沙箱/权限/黑名单）", { n: rejectedOps.length, reasons: rejectedOps.map((op) => op.error) });
          console.log(
            `[beilu-files] ReplyHandler: ${rejectedOps.length} 条操作被拒绝, 注入告知 AI + 映射前端面板`,
          );
        }

        // 清除回复中的文件操作标签（包括自闭合标签，收口：与签名/去重剥离同源正则）
        reply.content = reply.content
          .replace(_fileOpTagRegex(), "")
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

        wbT(_cid, "files", "ReplyHandler:exit", {});
        return false;
        }); // 破口B: 关闭 ReplyHandler 的 _als.run
      },
    },
  },
};

export default pluginExport;

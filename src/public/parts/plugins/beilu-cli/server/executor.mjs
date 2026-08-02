/**
 * executor.mjs — beilu-cli 工具执行器（路由中枢，无头 YonBan）
 *
 * 单层架构（凛倾 2026-07-22 拍板「CLI 只是工具插件」重构）：
 *   42 个工具全部由 CLI 自有实现执行（tools/*.mjs，从 YonBan tools/*.ts 移植），
 *   一张 _handlers 表制——与 YonBan ToolExecutor.ts:105-167 同构。
 *   原「beilu-files 桥」双层架构已删：CLI 子进程 import 本体插件 = 第二实例
 *   （审批队列/pendingOpResults/workspaceRoots/username ALS 全是空白副本，
 *   「四层安全纵深」在子进程里不存在），且 file_op 字符串结果丢 contextAnchor
 *   对象/old_content → 前端 diff 渲染断。安全裁决全在本体（tool_call 到达即已过审），
 *   本执行器只做执行 + 结构化返回。
 *
 * 接口契约（与 YonBan ToolCallResult 逐字段对齐，本体消费点见各字段注释）：
 *   execute({ id, tool, params, traceId }) →
 *     { id, success, result, resolvedPath, error?, failedFiles?, _debug? }
 *   result 内（本体 formatToolResultsForInjection 白名单 + 前端 diffRenderer 消费）：
 *     contextAnchor{before,after,anchorText} / old_content / matchLine / _hint / _debug / diagnostics
 */
import { FileCheckpoint } from "./checkpoint.mjs";
import {
  resolveWorkspacePath, ideOpLog, setWorkspaceRoot, getWorkspaceRoot,
  postWriteDiagnostics, buildContextAnchor,
} from "./infra.mjs";
import { getResultHint, getErrorHint } from "./hints.mjs";
import { buildDebugInfo } from "./infra.mjs";

// ── 工具模块 import（一表制，与 YonBan ToolExecutor 同构）──────
import { readFile, writeFile, listFiles } from "./tools/file-tools.mjs";
import { editXlsx } from "./tools/doc-tools.mjs";
import { searchFiles, searchByName } from "./tools/search-tools.mjs";
import { replaceLines, insertAtLine, fuzzyEdit } from "./tools/edit-tools.mjs";
import { runCommand, runScript, disposeShellSession } from "./tools/command-tools.mjs";
import { getDiagnostics, getStatus } from "./tools/diagnostic-tools.mjs";
import {
  gotoDefinition, findReferences, getProjectSummary,
  astSearch, smartSearch, validateHtml, lintCode,
} from "./tools/code-tools.mjs";
import {
  checkpointStart, checkpointCommit, checkpointRevert,
  checkpointRevertToMessage, checkpointRevertDiff,
  checkpointList, checkpointCanReplay,
  checkpointGetOps, checkpointGetDiff,
  getOpLog, _reveal,
} from "./tools/checkpoint-tools.mjs";
import { todoRead, todoWrite } from "./tools/todo-tools.mjs";
import {
  gitStatus, gitDiff, gitLog, gitAdd, gitCommit,
  gitBranch, gitCheckout, gitStash, gitMerge,
} from "./tools/git-tools.mjs";

export { getIdeOperationLog } from "./infra.mjs";
export { disposeShellSession };

// 写工具集合（与 YonBan ToolExecutor.WRITE_TOOLS 同源语义；edit_xlsx 走 checkpoint 但
// 诊断/锚按 YonBan 口径只挂四件套 + 锚只挂局部编辑三件套）
const WRITE_TOOLS = new Set(["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"]);
const CONTEXT_ANCHOR_TOOLS = new Set(["replace_lines", "insert_at_line", "fuzzy_edit"]);
const RUNTIME_POLICY_TOOLS = new Set([
  "read_file", "search_files", "search_by_name", "run_command", "run_script",
]);
const INTERNAL_LINE_SCOPED_TOOLS = new Set([
  "write_file", "edit_xlsx", "replace_lines", "insert_at_line", "fuzzy_edit",
  "run_command", "run_script",
  "_checkpoint_start", "_checkpoint_commit", "_checkpoint_revert",
  "_checkpoint_revert_to_message", "_checkpoint_revert_diff", "_checkpoint_list",
  "_checkpoint_can_replay", "_checkpoint_get_ops", "_checkpoint_get_diff",
]);
const RUNTIME_POLICY_KEYS = Object.freeze([
  "read_default_line_limit",
  "read_max_line_limit",
  "read_max_output_chars",
  "search_default_page_size",
  "search_max_page_size",
  "search_snapshot_ttl_ms",
  "search_max_snapshot_results",
  "search_timeout_ms",
  "search_snapshot_cache_max_entries",
  "search_snapshot_cache_max_results",
  "command_watchdog_enabled",
  "command_watchdog_action",
  "command_watchdog_stall_ms",
  "command_watchdog_sample_ms",
  "command_watchdog_cpu_delta_ms",
  "command_watchdog_rss_delta_bytes",
  "command_watchdog_progress_ms",
]);

function _transportContext(raw, {
  chatid = "",
  connectionId = "",
  signal = null,
  onProgress = null,
} = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const policySource = source.runtimePolicy && typeof source.runtimePolicy === "object"
    && !Array.isArray(source.runtimePolicy)
    ? source.runtimePolicy
    : {};
  const runtimePolicy = {};
  for (const key of RUNTIME_POLICY_KEYS) {
    if (Object.hasOwn(policySource, key)) runtimePolicy[key] = policySource[key];
  }
  const ownerUsername = typeof source.ownerUsername === "string" ? source.ownerUsername.trim() : "";
  const owner = {
    ...(ownerUsername ? { username: ownerUsername } : {}),
    ...(chatid ? { chatid } : {}),
    ...(connectionId ? { connectionId } : {}),
  };
  return {
    runtimePolicy,
    owner,
    username: ownerUsername,
    chatid,
    connectionId,
    ...(signal ? { signal } : {}),
    ...(typeof onProgress === "function" ? { onProgress } : {}),
  };
}

export class ToolExecutor {
  constructor(workspaceRoot) {
    if (workspaceRoot) setWorkspaceRoot(workspaceRoot);
    // ══ checkpoint 按窗口/线分池（凛倾 0727「直接做池，每个窗口的指令 id 不一样就行」）══
    // 【why】原来是**进程级唯一**一个 FileCheckpoint：一个 CLI 服务 N 条线（指令已按会话键分池，
    //   command-tools.mjs 会话池同范式），但快照/回档空间只有一份 → 线 A 的检查点会出现在线 B 的
    //   回档时间线里，用户在 A 点回档回的是 B 的状态（破坏性，taskItemPanel 全局列表即此链前端侧）。
    // 【key】池键 = params._window_id（execute 入口已由信封 chatid 统一注入，见下方 execute），
    //   与 shell 会话池的 session_key 同一个 id，不新造标识。无 id（旧调用/内部调用）→ __default__。
    // 【共用什么、不共用什么】工作区根仍是进程级单源（canonical 由文件面板决定，本体一个工作区），
    //   变更时给池内**每个** checkpoint 换根（见 setWorkspaceRoot）——分池分的是快照空间，不是工作区。
    this._checkpoints = new Map();
    this.checkpoint = this._checkpointFor(null); // 默认实例：兼容旧的 executor.checkpoint 外部引用
    // handler 里不再闭包捕获单例 cp，改成**按本次调用的窗口 id 现取**——闭包捕获会把
    //   "第一次构造时的那一个" 永久钉死在全部 42 个 handler 上，池就形同虚设。
    const cp = (p) => this._checkpointFor(p && p._window_id);

    this._handlers = {
      // ── 文件读写 ──
      read_file: (p, context) => readFile(p, context),
      write_file: (p) => writeFile(p, cp(p)),
      list_files: (p) => listFiles(p),

      // ── 文档编辑 ──
      edit_xlsx: (p) => editXlsx(p, cp(p)),

      // ── 搜索 ──
      search_files: (p, context) => searchFiles(p, context),
      search_by_name: (p, context) => searchByName(p, context),

      // ── 局部编辑 ──
      replace_lines: (p) => replaceLines(p, cp(p)),
      insert_at_line: (p) => insertAtLine(p, cp(p)),
      fuzzy_edit: (p) => fuzzyEdit(p, cp(p)),

      // ── 命令执行 ──
      run_command: (p, context) => runCommand(p, context),
      run_script: (p, context) => runScript(p, context),

      // ── 诊断 ──
      get_diagnostics: (p) => getDiagnostics(p),
      get_status: () => getStatus(),

      // ── 代码分析 ──
      goto_definition: (p) => gotoDefinition(p),
      find_references: (p) => findReferences(p),
      get_project_summary: () => getProjectSummary(),
      ast_search: (p) => astSearch(p),
      smart_search: (p) => smartSearch(p, searchFiles),
      validate_html: (p) => validateHtml(p),
      lint_code: (p) => lintCode(p),

      // ── 任务管理 ──
      todo_read: () => todoRead(),
      todo_write: (p) => todoWrite(p),

      // ── 检查点（内部工具，_ 前缀）──
      _checkpoint_start: (p) => checkpointStart(p, cp(p)),
      _checkpoint_commit: (p) => checkpointCommit(p, cp(p)),
      _checkpoint_revert: (p) => checkpointRevert(p, cp(p)),
      _checkpoint_revert_to_message: (p) => checkpointRevertToMessage(p, cp(p)),
      _checkpoint_revert_diff: (p) => checkpointRevertDiff(p, cp(p)),
      _checkpoint_list: (p) => checkpointList(cp(p)),
      _checkpoint_can_replay: (p) => checkpointCanReplay(p, cp(p)),
      _checkpoint_get_ops: (p) => checkpointGetOps(p, cp(p)),
      _checkpoint_get_diff: (p) => checkpointGetDiff(p, cp(p)),
      _get_operation_log: (p) => getOpLog(p),
      _reveal: (p) => _reveal(p),

      // ── 结构化 git ──
      git_status: (p) => gitStatus(p),
      git_diff: (p) => gitDiff(p),
      git_log: (p) => gitLog(p),
      git_add: (p) => gitAdd(p),
      git_commit: (p) => gitCommit(p),
      git_branch: (p) => gitBranch(p),
      git_checkout: (p) => gitCheckout(p),
      git_stash: (p) => gitStash(p),
      git_merge: (p) => gitMerge(p),
    };
  }

  /**
   * 取某条线的 checkpoint 实例（池，懒建）。键=窗口/线 id（= chatid，与 shell 会话池 session_key 同源）。
   * 无 id → __default__ 槽：内部调用/旧路径仍有确定归属，不会误落进某条线的快照空间。
   * 【为什么懒建而不是预建】线是用户随时拉起/关闭的，预建就得先知道有哪些线——那是把
   *   前端的线登记复制到 CLI 侧（第二份真相）。懒建让"谁来过谁就有槽"，无需同步线清单。
   */
  _checkpointFor(windowId) {
    const key = (typeof windowId === "string" && windowId) ? windowId : "__default__";
    let cp = this._checkpoints.get(key);
    if (!cp) {
      cp = new FileCheckpoint(getWorkspaceRoot());
      this._checkpoints.set(key, cp);
    }
    return cp;
  }

  /**
   * 执行工具调用（唯一入口）。前/后处理与 YonBan ToolExecutor.execute 同构：
   * checkpoint 钉住 → handler → hint/_debug → 写后诊断 → contextAnchor → resolvedPath → A2 去吞错。
   */
  async execute(req, lifecycle = null) {
    const params = req.params && typeof req.params === "object" && !Array.isArray(req.params)
      ? req.params
      : {};
    const handler = this._handlers[req.tool];

    if (!handler) {
      ideOpLog(req.tool, "unknown-tool", { id: req.id }, "fail");
      return { id: req.id, success: false, error: `未知工具: ${req.tool}` };
    }

    const chatid = typeof req.chatid === "string" ? req.chatid : "";
    const connectionId = typeof req.connectionId === "string" ? req.connectionId : "";
    const context = _transportContext(req.transport, {
      chatid,
      connectionId,
      signal: lifecycle?.signal || null,
      onProgress: lifecycle?.onProgress || null,
    });
    // per-line 命令只在内建 handler 边界获得内部窗口键；公开 params、第三方 handler 与日志均保持原样。
    const handlerParams = INTERNAL_LINE_SCOPED_TOOLS.has(req.tool) && chatid
      ? { ...params, _window_id: chatid }
      : params;

    // 审批路径：按 _checkpointId 钉住快照目标（finally 解钉），防审批挂起期间被其他轮劫持。
    // [池化 0727] 钉的必须是**本次调用这条线**的 checkpoint，不是默认实例——钉错实例等于
    //   给别的线上了锁而本线没上，审批挂起期间本线仍会被其他轮劫持（池化前后行为反而更糟）。
    //   checkpoint 池直接读信封 chatid，不再借公开 params 携带内部窗口身份。
    const _cpPin = params._checkpointId;
    const _cpInst = this._checkpointFor(chatid);
    if (_cpPin) _cpInst.pinTarget(_cpPin);

    const _t0 = Date.now();
    try {
      const result = RUNTIME_POLICY_TOOLS.has(req.tool)
        ? await handler(handlerParams, context)
        : await handler(handlerParams);
      const _ms = Date.now() - _t0;
      const _handlerSuccess = !(result && typeof result === "object" && result.success === false);

      // 日志（参数摘要，长字符串截断）
      const _paramSummary = {};
      for (const [k, v] of Object.entries(params)) {
        _paramSummary[k] = typeof v === "string" && v.length > 200 ? v.substring(0, 100) + `...(${v.length}chars)` : v;
      }
      ideOpLog(
        req.tool,
        "execute",
        { traceId: req.traceId, params: _paramSummary },
        _handlerSuccess ? "ok" : "fail",
        _ms,
      );

      // 结果提示 + 调试信息（本体 formatToolResultsForInjection 透出 _hint 给 AI）
      if (typeof result === "object" && result) {
        const _hint = getResultHint(req.tool, result, params);
        if (_hint) result._hint = _hint;
        result._debug = buildDebugInfo(
          req.tool,
          params,
          _ms,
          _handlerSuccess,
          _handlerSuccess ? undefined : result.error,
        );
      }

      // 写工具成功后诊断回注（tsc/eslint CLI 版，替代 YonBan LSP）
      if (WRITE_TOOLS.has(req.tool)) {
        const _wp = params.path;
        if (typeof _wp === "string" && _wp) {
          try {
            const _diags = await postWriteDiagnostics(resolveWorkspacePath(_wp));
            if (_diags?.length > 0 && typeof result === "object" && result) result.diagnostics = _diags;
          } catch { /* ignore */ }
        }
      }

      // 定点返回：局部编辑成功后附改动点上下文锚（对象形——前端 diffRenderer:107 与
      // 注入格式化器 ideTagParser:197 都按对象消费；原 beilu-files 桥的字符串结果即断在此）
      if (CONTEXT_ANCHOR_TOOLS.has(req.tool) && result && typeof result === "object") {
        const _cap = params.path;
        if (result.success !== false && result.preview !== true && typeof _cap === "string" && _cap) {
          let _startLine = 0, _lineCount = 1;
          if (typeof result.matchLine === "number") {
            _startLine = result.matchLine;
            _lineCount = typeof result.matchEnd === "number" ? Math.max(1, result.matchEnd - result.matchLine + 1) : 1;
          } else if (typeof result.insertedAt === "number") {
            _startLine = result.insertedAt;
            _lineCount = typeof result.insertedEnd === "number" ? Math.max(1, result.insertedEnd - result.insertedAt + 1) : 1;
          } else if (typeof result.newRange === "string") {
            const _mm = /^(\d+)-(\d+)$/.exec(result.newRange);
            if (_mm) { _startLine = Number(_mm[1]); _lineCount = Math.max(1, Number(_mm[2]) - Number(_mm[1]) + 1); }
          }
          if (_startLine > 0) {
            try {
              const _anchor = buildContextAnchor(resolveWorkspacePath(_cap), _startLine, _lineCount);
              if (_anchor) result.contextAnchor = _anchor;
            } catch { /* ignore */ }
          }
        }
      }

      // 权威解析路径（本体 _resolvedPathMap 消费：mtime/沙箱对齐真实工作区路径）
      let _resolvedPath;
      if (typeof params.path === "string" && params.path) {
        try { _resolvedPath = resolveWorkspacePath(params.path); } catch { /* ignore */ }
      }

      // A2 去吞错：内层 success===false 时外层也 false；errors 数组优先，回落单数 error 字符串
      let _outerSuccess = true;
      let _innerErrors, _innerFailedFiles;
      if (result && typeof result === "object" && "success" in result && result.success === false) {
        _outerSuccess = false;
        _innerErrors = Array.isArray(result.errors) && result.errors.length
          ? result.errors
          : (typeof result.error === "string" && result.error ? [result.error] : undefined);
        _innerFailedFiles = result.failedFiles;
      }

      return {
        id: req.id,
        success: _outerSuccess,
        result,
        resolvedPath: _resolvedPath,
        ...(_outerSuccess ? {} : {
          error: Array.isArray(_innerErrors) && _innerErrors.length
            ? _innerErrors.join("; ") : "操作部分失败（结果 success:false）",
          ...(Array.isArray(_innerFailedFiles) && _innerFailedFiles.length ? { failedFiles: _innerFailedFiles } : {}),
        }),
      };
    } catch (err) {
      const _ms = Date.now() - _t0;
      const message = err instanceof Error ? err.message : String(err);
      const _errHint = getErrorHint(req.tool, message, params);
      ideOpLog(req.tool, "execute:error", { traceId: req.traceId, error: message.substring(0, 200) }, "fail", _ms);
      return {
        id: req.id,
        success: false,
        error: message + (_errHint ? `\n💡 ${_errHint}` : ""),
        _debug: buildDebugInfo(req.tool, params, _ms, false, message),
      };
    } finally {
      if (_cpPin) _cpInst.unpinTarget(); // 与 pinTarget 配对同一实例（池化后不能再用默认实例解钉）
    }
  }

  /**
   * 工作区根热切收口（canonical 单源变更时 server.mjs 唯一调用点）：
   * infra 路径解析根 + checkpoint 快照根 + 持久 shell session（旧 cwd 失效销毁，
   * YonBan extension.ts:356 onDidChangeWorkspaceFolders 同款范式）一次到位，防三处根分叉。
   */
  setWorkspaceRoot(root) {
    if (!root) return;
    setWorkspaceRoot(root);
    // [池化 0727] 换根要遍历**整池**：只换默认实例=其余线的快照根还指着旧工作区，
    //   回档会往旧目录写（比不分池更危险）。工作区是进程级单源，所以所有线一起换根。
    for (const cp of this._checkpoints.values()) {
      try { cp.setWorkspaceRoot(root); } catch (e) { console.warn(`[executor] checkpoint 换根失败: ${e?.message || e}`); }
    }
    // 持久 shell 全部销毁：工作区是进程级的，换根后**每条线**的 shell cwd 都失效了，
    //   不是只有当前线（故此处无参全销毁是对的，不改成按键销毁）。
    try { disposeShellSession(); } catch { /* 无在跑 session 时 no-op */ }
  }

  getToolList() {
    return Object.keys(this._handlers);
  }

  static WRITE_TOOLS = WRITE_TOOLS;
}

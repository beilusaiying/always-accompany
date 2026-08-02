/**
 * ToolExecutor.ts -- IDE 工具执行器（路由中枢）。
 *
 * ═══════════════════════════════════════════════════════════════
 *  功能链：beilu AI 的 42 个 IDE 工具的唯一入口
 * ═══════════════════════════════════════════════════════════════
 *
 * 传导链路（完整 10 跳中的 Hop 5/6 节点）：
 *   beilu AI 决定操作用户的 IDE（读文件/写代码/跑命令/查 git 等）
 *     → beilu 后端 ideClient.mjs 发 WS {type:"tool_call", tool:"read_file", params:{path:"src/foo.ts"}}
 *     → IdeWsServer.handleMessage case "tool_call" → 校验 req
 *     → extension.ts 注入的 onToolCall 回调
 *       → 【本文件】execute(req) — 唯一入口
 *         → _checkpointId → pinTarget（钉住检查点归属）
 *         → _handlers[req.tool](params) — 路由到 tools/*.ts 的具体实现
 *         → 写后处理：LSP 诊断回注 + contextAnchor + revealAndHighlight
 *         → A2 去吞错：handler 自带 success===false 时外层也设 false
 *         → ideOpLog 操作日志 + _hint 结果提示 + _debug 调试信息
 *         → 回传 resolvedPath（权威解析路径）
 *       → ToolCallResult 回传给 IdeWsServer
 *     → WS tool_result → beilu 后端 → AI 看到结果
 *     → 写工具还推 editRecord 给前端 webview（用户看到 AI 改了哪里）
 *
 * 本文件只做三件事：
 *   1. 持有有状态依赖（FileCheckpoint 全局唯一 + _handlers 注册表）
 *   2. execute() 统一前/后处理（日志、诊断回注、锚点、提示、调试信息）
 *   3. WRITE_TOOLS 等静态集合供 extension.ts 引用
 *
 * 42 个工具的实际实现在 tools/*.ts：
 *   file-tools.ts    — read_file, write_file, list_files + 文档解析(xlsx/docx/pptx/pdf)
 *   doc-tools.ts     — edit_xlsx（zip 级定点改写 xlsx 公式）
 *   search-tools.ts  — search_files, search_by_name（优先 ripgrep）
 *   edit-tools.ts    — replace_lines, insert_at_line, fuzzy_edit（4 种容错策略）
 *   command-tools.ts — run_command, run_script + 持久 shell 会话
 *   diagnostic-tools.ts — get_diagnostics, get_status
 *   vscode-tools.ts  — goto_definition, find_references, get_project_summary, ast_search, smart_search, validate_html, lint_code
 *   git-tools.ts     — git_status/diff/log/add/commit/branch/checkout/stash/merge（结构化）
 *   checkpoint-tools.ts — _checkpoint_* 9个 + _get_operation_log + _reveal
 *   todo-tools.ts    — todo_read, todo_write
 *
 * 共享基础设施在 tool-infra.ts：路径安全 / 操作日志 / 写后验证 / LSP 诊断 / 上下文锚 / 结果提示
 *
 * 相交：
 *   ← IdeWsServer.ts（WS tool_call 消息路由到 execute）
 *   ← extension.ts（构造 + 注入 onToolCall 回调 + WRITE_TOOLS 引用 + disposeShellSession）
 *   → FileCheckpoint.ts（快照/回档/溯源）
 *   → EditorReveal.ts（写后自动打开+高亮）
 *   → tool-infra.ts（路径安全/日志/验证/诊断/提示）
 *   → tools/*.ts（42 个工具的实际实现）
 */
import type { ToolCallRequest, ToolCallResult } from "../types";
import { FileCheckpoint } from "./FileCheckpoint";
import { revealAndHighlight } from "./EditorReveal";
import {
  resolveWorkspacePath, ideOpLog,
  postWriteDiagnostics, buildContextAnchor,
  getResultHint, getErrorHint, buildDebugInfo,
} from "./tool-infra";

// ── 工具模块 import ──────────────────────────────────
import { readFile, writeFile, listFiles } from "./tools/file-tools";
import { editXlsx } from "./tools/doc-tools";
import { searchFiles, searchByName } from "./tools/search-tools";
import { replaceLines, insertAtLine, fuzzyEdit } from "./tools/edit-tools";
import { runCommand, runScript, disposeShellSession } from "./tools/command-tools";
import type { CommandWatchdogProgress } from "./tools/process-telemetry";
import { getDiagnostics, getStatus } from "./tools/diagnostic-tools";
import {
  gotoDefinition, findReferences, getProjectSummary,
  astSearch, smartSearch, validateHtml, lintCode,
} from "./tools/vscode-tools";
import {
  checkpointStart, checkpointCommit, checkpointRevert,
  checkpointRevertToMessage, checkpointRevertDiff,
  checkpointList, checkpointCanReplay,
  checkpointGetOps, checkpointGetDiff,
  getOpLog, _reveal,
} from "./tools/checkpoint-tools";
import { todoRead, todoWrite } from "./tools/todo-tools";
import {
  gitStatus, gitDiff, gitLog, gitAdd, gitCommit,
  gitBranch, gitCheckout, gitStash, gitMerge,
} from "./tools/git-tools";

/** 导出操作日志查询（IdeWsServer 等外部消费） */
export { getIdeOperationLog } from "./tool-infra";

type InternalTransportContext = {
  runtimePolicy: Record<string, unknown>;
  owner: {
    username?: string;
    chatid?: string;
    connectionId?: string;
  };
  username: string;
  chatid: string;
  connectionId: string;
  signal?: AbortSignal;
  onProgress?: (progress: CommandWatchdogProgress) => void;
};

export type ToolExecutionLifecycle = {
  signal?: AbortSignal;
  onProgress?: (progress: CommandWatchdogProgress) => void;
};

type ToolHandler = (
  params: Record<string, unknown>,
  context?: InternalTransportContext,
) => Promise<unknown>;

const RUNTIME_POLICY_TOOLS = new Set([
  "read_file", "search_files", "search_by_name", "run_command", "run_script",
]);
const INTERNAL_LINE_SCOPED_TOOLS = new Set(["run_command", "run_script"]);
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

function transportContext(
  raw: ToolCallRequest["transport"],
  {
    chatid = "",
    connectionId = "",
    signal,
    onProgress,
  }: {
    chatid?: string;
    connectionId?: string;
    signal?: AbortSignal;
    onProgress?: (progress: CommandWatchdogProgress) => void;
  } = {},
): InternalTransportContext {
  const source = raw && typeof raw === "object" ? raw : {};
  const policySource = source.runtimePolicy && typeof source.runtimePolicy === "object"
    && !Array.isArray(source.runtimePolicy)
    ? source.runtimePolicy
    : {};
  const runtimePolicy: Record<string, unknown> = {};
  for (const key of RUNTIME_POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(policySource, key)) runtimePolicy[key] = policySource[key];
  }
  const username = typeof source.ownerUsername === "string" ? source.ownerUsername.trim() : "";
  return {
    runtimePolicy,
    owner: {
      ...(username ? { username } : {}),
      ...(chatid ? { chatid } : {}),
      ...(connectionId ? { connectionId } : {}),
    },
    username,
    chatid,
    connectionId,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  };
}

/**
 * IDE 工具执行器 — 路由中枢。
 * 持有 FileCheckpoint（全局唯一）和 _handlers 注册表。
 * execute() 是唯一入口，所有前/后处理在此聚合。
 */
export class ToolExecutor {
  private _handlers: Record<string, ToolHandler>;
  public readonly checkpoint: FileCheckpoint;

  /** 写工具集合（单一定义点，extension.ts 引用判断是否推 editRecord） */
  static readonly WRITE_TOOLS = new Set(["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"]);
  private static readonly _POST_WRITE_DIAG_TOOLS = ToolExecutor.WRITE_TOOLS;
  private static readonly _CONTEXT_ANCHOR_TOOLS = new Set(["replace_lines", "insert_at_line", "fuzzy_edit"]);

  constructor() {
    this.checkpoint = new FileCheckpoint();
    const cp = this.checkpoint;

    this._handlers = {
      // ── 文件读写 ──
      read_file: (p, context) => readFile(p, context),
      write_file: (p) => writeFile(p, cp),
      list_files: (p) => listFiles(p),

      // ── 文档编辑 ──
      edit_xlsx: (p) => editXlsx(p, cp),

      // ── 搜索 ──
      search_files: (p, context) => searchFiles(p, context),
      search_by_name: (p, context) => searchByName(p, context),

      // ── 局部编辑 ──
      replace_lines: (p) => replaceLines(p, cp),
      insert_at_line: (p) => insertAtLine(p, cp),
      fuzzy_edit: (p) => fuzzyEdit(p, cp),

      // ── 命令执行 ──
      run_command: (p, context) => runCommand(p, context),
      run_script: (p, context) => runScript(p, context),

      // ── 诊断 ──
      get_diagnostics: (p) => getDiagnostics(p),
      get_status: () => getStatus(),

      // ── VSCode API 集成 ──
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

      // ── 检查点（内部工具，_ 前缀） ──
      _checkpoint_start: (p) => checkpointStart(p, cp),
      _checkpoint_commit: (p) => checkpointCommit(p, cp),
      _checkpoint_revert: (p) => checkpointRevert(p, cp),
      _checkpoint_revert_to_message: (p) => checkpointRevertToMessage(p, cp),
      _checkpoint_revert_diff: (p) => checkpointRevertDiff(p, cp),
      _checkpoint_list: () => checkpointList(cp),
      _checkpoint_can_replay: (p) => checkpointCanReplay(p, cp),
      _checkpoint_get_ops: (p) => checkpointGetOps(p, cp),
      _checkpoint_get_diff: (p) => checkpointGetDiff(p, cp),
      _get_operation_log: (p) => getOpLog(p),
      _reveal: (p) => _reveal(p),

      // ── 结构化 git（不含 push，远程推送走 run_command 受黑名单守） ──
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
   * 执行工具调用（Hop 5 核心）。IdeWsServer.onToolCall 的实际执行体。
   *
   * 链路：IdeWsServer case "tool_call" → extension.ts onToolCall → 本函数 → _handlers[tool] → ToolCallResult
   * 影响：
   *   - 审批路径：按 _checkpointId 钉住 FileCheckpoint 快照目标（finally 解钉）
   *   - 写工具：自动 LSP 诊断回注（postWriteDiagnostics）
   *   - 局部编辑器：自动附 contextAnchor + revealAndHighlight 跳转
   *   - A2 去吞错：内层 handler 返回 success===false 时外层也设 false，透传 errors/failedFiles
   *   - 回传 resolvedPath（权威解析路径，闭合跨进程路径盲区）
   *   - 写操作日志 ideOpLog
   */
  async execute(
    req: ToolCallRequest,
    lifecycle?: ToolExecutionLifecycle,
  ): Promise<ToolCallResult> {
    const handler = this._handlers[req.tool];
    if (!handler) {
      ideOpLog(req.tool, "unknown-tool", { id: req.id }, "fail");
      return { id: req.id, success: false, error: `未知工具: ${req.tool}` };
    }

    const params = req.params && typeof req.params === "object" && !Array.isArray(req.params)
      ? req.params
      : {};
    const chatid = typeof req.chatid === "string" ? req.chatid : "";
    const connectionId = typeof req.connectionId === "string" ? req.connectionId : "";
    const context = transportContext(req.transport, {
      chatid,
      connectionId,
      signal: lifecycle?.signal,
      onProgress: lifecycle?.onProgress,
    });
    // per-line 命令只在内建 handler 边界获得内部窗口键；公开 params、第三方 handler 与日志均保持原样。
    const handlerParams = INTERNAL_LINE_SCOPED_TOOLS.has(req.tool) && chatid
      ? { ...params, _window_id: chatid }
      : params;

    const _cpPin = params._checkpointId as string | undefined;
    if (_cpPin) this.checkpoint.pinTarget(_cpPin);

    const _t0 = Date.now();
    try {
      const result = RUNTIME_POLICY_TOOLS.has(req.tool)
        ? await handler(handlerParams, context)
        : await handler(handlerParams);
      const _ms = Date.now() - _t0;
      const _resultRecord = result && typeof result === "object"
        ? result as Record<string, unknown>
        : null;
      const _handlerSuccess = _resultRecord?.success !== false;

      // 记录参数摘要
      const _paramSummary: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string" && v.length > 200) {
          _paramSummary[k] = v.substring(0, 100) + `...(${v.length}chars)`;
        } else {
          _paramSummary[k] = v;
        }
      }
      const _resultStr = typeof result === "string" ? result : JSON.stringify(result);
      const _resultSummary = _resultStr.length > 300 ? _resultStr.substring(0, 200) + `...(${_resultStr.length}chars)` : _resultStr;
      ideOpLog(
        req.tool,
        "execute",
        { traceId: req.traceId, params: _paramSummary, resultLen: _resultStr.length, resultPreview: _resultSummary },
        _handlerSuccess ? "ok" : "fail",
        _ms,
      );

      // 附加结果提示 + 调试信息
      const _hint = getResultHint(req.tool, result, params);
      if (_hint) (result as Record<string, unknown>)._hint = _hint;
      (result as Record<string, unknown>)._debug = buildDebugInfo(
        req.tool,
        params,
        _ms,
        _handlerSuccess,
        _handlerSuccess
          ? undefined
          : (typeof _resultRecord?.error === "string" ? _resultRecord.error : undefined),
      );

      // 写工具成功后自动 LSP 诊断回注
      if (ToolExecutor._POST_WRITE_DIAG_TOOLS.has(req.tool)) {
        const _wp = params.path;
        if (typeof _wp === "string" && _wp) {
          try {
            const _diags = await postWriteDiagnostics(resolveWorkspacePath(_wp));
            if (_diags && _diags.length > 0) (result as Record<string, unknown>).diagnostics = _diags;
          } catch {}
        }
      }

      // 定点返回：局部编辑器成功后，附改动点上下文锚 + revealAndHighlight
      if (ToolExecutor._CONTEXT_ANCHOR_TOOLS.has(req.tool) && result && typeof result === "object") {
        const _r = result as Record<string, unknown>;
        const _cap = params.path;
        if (_r.success !== false && _r.preview !== true && typeof _cap === "string" && _cap) {
          let _startLine = 0;
          let _lineCount = 1;
          if (typeof _r.matchLine === "number") {
            _startLine = _r.matchLine;
            _lineCount = typeof _r.matchEnd === "number" ? Math.max(1, _r.matchEnd - _r.matchLine + 1) : 1;
          } else if (typeof _r.insertedAt === "number") {
            _startLine = _r.insertedAt;
            _lineCount = typeof _r.insertedEnd === "number" ? Math.max(1, _r.insertedEnd - _r.insertedAt + 1) : 1;
          } else if (typeof _r.newRange === "string") {
            const _mm = /^(\d+)-(\d+)$/.exec(_r.newRange);
            if (_mm) { _startLine = Number(_mm[1]); _lineCount = Math.max(1, Number(_mm[2]) - Number(_mm[1]) + 1); }
          }
          if (_startLine > 0) {
            try {
              const _absForAnchor = resolveWorkspacePath(_cap);
              const _anchor = buildContextAnchor(_absForAnchor, _startLine, _lineCount);
              if (_anchor) _r.contextAnchor = _anchor;
              const _revAnchor = (_anchor as { anchorText?: string } | null | undefined)?.anchorText;
              void revealAndHighlight(_absForAnchor, _startLine, _lineCount, _revAnchor);
            } catch {}
          }
        }
      }

      // 回传权威解析路径
      let _resolvedPath: string | undefined;
      const _pp = params.path;
      if (typeof _pp === "string" && _pp) {
        try { _resolvedPath = resolveWorkspacePath(_pp); } catch {}
      }

      // A2 去吞错：handler 返回对象自带 success===false 时外层也设 false
      let _outerSuccess = true;
      let _innerErrors: unknown;
      let _innerFailedFiles: unknown;
      if (result && typeof result === "object" && "success" in (result as Record<string, unknown>)) {
        const _r = result as Record<string, unknown>;
        if (_r.success === false) {
          _outerSuccess = false;
          // 0714 根因修（字段单复数错配吞真实错误）：此前只读 errors（复数数组），而 git-tools 等
          //   handler 失败用 error（单数字符串，装真实 stderr，git-tools.ts:41/67/76）——错配落到
          //   下方固定串「操作部分失败」，AI 拿不到根因（10:26 事故：git_status 失败原因「非 git 仓库」被吞）。
          //   errors 数组优先，缺失时回落单数 error 字符串。
          _innerErrors = Array.isArray(_r.errors) && _r.errors.length
            ? _r.errors
            : (typeof _r.error === "string" && _r.error ? [_r.error] : undefined);
          _innerFailedFiles = _r.failedFiles;
        }
      }

      return {
        id: req.id,
        success: _outerSuccess,
        result,
        resolvedPath: _resolvedPath,
        ...(_outerSuccess ? {} : {
          error: Array.isArray(_innerErrors) && _innerErrors.length
            ? (_innerErrors as unknown[]).join("; ")
            : "操作部分失败（结果 success:false）",
          ...(Array.isArray(_innerFailedFiles) && _innerFailedFiles.length
            ? { failedFiles: _innerFailedFiles }
            : {}),
        }),
      };
    } catch (err: unknown) {
      const _ms = Date.now() - _t0;
      const message = err instanceof Error ? err.message : String(err);
      const _errHint = getErrorHint(req.tool, message, params);
      const _debug = buildDebugInfo(req.tool, params, _ms, false, message);
      ideOpLog(req.tool, "execute", { traceId: req.traceId, params, error: message }, "fail", _ms);
      return { id: req.id, success: false, error: message + (_errHint ? `\n💡 ${_errHint}` : ""), _debug };
    } finally {
      if (_cpPin) this.checkpoint.unpinTarget();
    }
  }

  /** 销毁持久 shell 会话（插件 dispose / 切 workspace 时调用） */
  public disposeShellSession(): void {
    disposeShellSession();
  }
}

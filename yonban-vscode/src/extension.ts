/**
 * extension.ts -- YonBan VSCode 插件入口（IDE 工具闭环 10 跳中的组装节点）。
 * 不管具体工具怎么执行（那是 ToolExecutor 的事），不管 WS 协议细节（那是 IdeWsServer 的事），
 * 不管 webview 消息路由（那是 YonBanProvider 的事）。
 *
 * 链路：VSCode activate → 初始化全部服务 → 串联（ToolExecutor → IdeWsServer → YonBanProvider）
 * 影响：
 *   - 注册侧边栏 webview provider（yonban.panel）
 *   - 注册命令（connect/disconnect/showPanel/startWsServer/stopWsServer/toggleSandboxMode/showConnectionInfo）
 *   - 注入 wsServer.onToolCall 回调（串联 ToolExecutor.execute + 写工具 editRecord 推送给 webview）
 *   - 注入 wsServer.onGetStatus 回调（返回 IDE 状态快照）
 *   - 设置诊断变化监听 → WS 广播 diagnostics_changed（500ms 防抖）
 *   - 设置文件变更监听 → WS 广播 file_changed（2s 防抖）
 *   - 控制台捕获 → WS 广播 console 日志
 *   - 自动连接后端 + 自动启动 WS 服务器（按配置）
 *   - 状态栏指示器（沙箱/生产模式）
 *   - deactivate 时清理所有资源（disconnect + stop + dispose）
 * 相交：
 *   → ToolExecutor.ts（构造实例 + 引用 WRITE_TOOLS + 注入 onToolCall）
 *   → IdeWsServer.ts（构造实例 + start + 注入 onToolCall/onGetStatus）
 *   → YonBanProvider.ts（构造实例 + postMessage editRecord）
 *   → ConnectionService/AuthService/ChatService（构造实例）
 *   → ConsoleCapture.ts（构造实例 + start + 日志回放）
 */
import * as vscode from "vscode";
import * as cp from "child_process";
import { YonBanProvider } from "./YonBanProvider";
import { AuthService } from "./services/AuthService";
import { ChatService } from "./services/ChatService";
import { ConnectionService } from "./services/ConnectionService";
import { ConsoleCapture } from "./services/ConsoleCapture";
import { IdeWsServer } from "./services/IdeWsServer";
import { ToolExecutor } from "./services/ToolExecutor";
import { initI18n, t } from "./i18n";
import { DEFAULT_WS_PORT, DEFAULT_SANDBOX_WS_PORT, DEFAULT_SERVER_URL, DEFAULT_SANDBOX_SERVER_URL, DEFAULT_SERVER_PORT, DEFAULT_SANDBOX_SERVER_PORT, DIAG_DEBOUNCE_MS, DIAG_ERRORS_PER_FILE, FILE_CHANGE_DEBOUNCE_MS, CONSOLE_REPLAY_COUNT } from "./constants"; // T004 端口收口
export { ToolExecutor };

let connectionService: ConnectionService;
let authService: AuthService;
let chatService: ChatService;
let wsServer: IdeWsServer;
let toolExecutor: ToolExecutor;
let consoleCapture: ConsoleCapture;
let provider: YonBanProvider;

const ACTIVATE_TIME = Date.now();

/**
 * VSCode 插件激活入口。初始化全部服务并串联数据流。
 *
 * 步骤：
 *   1. 初始化核心服务（AuthService → ConnectionService → ChatService → IdeWsServer → ToolExecutor → ConsoleCapture）
 *   2. 注册 webview provider（yonban.panel 主面板）
 *   3. 注册命令（清单以 registerCommand 调用为准）
 *   4. 串联：ToolExecutor → IdeWsServer.onToolCall（含 editRecord 写操作推送给 webview）
 *   5. 串联：ConsoleCapture → IdeWsServer.broadcastConsole
 *   6. 设置诊断/文件变更监听 → WS 广播
 *   7. 自动连接后端 + 自动启动 WS（按 yonban.autoConnect/autoStartWs 配置）
 *   8. 注册资源到 subscriptions（dispose 时自动清理）
 * 不变量：onToolCall 串联必须在 wsServer.start 之前完成（否则早到的 tool_call 无 handler）
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("[YonBan] 插件激活");

  // 主进程 i18n 初始化（最早执行，后续 t() 才有字典）
  initI18n(context.extensionPath);

  // 版本号单一来源：package.json，消除散落的硬编码 "0.1.0"
  const extVersion = String(context.extension.packageJSON.version ?? "");

  // ── 初始化服务 ──────────────────────────────────────────
  authService = new AuthService(context);
  connectionService = new ConnectionService(authService);
  chatService = new ChatService(connectionService, authService);
  // 0720 抖动敏感修：HTTP 心跳判死前咨询聊天 WS 活性——WS 活着=本体没死（后端忙时
  // HTTP ping 先超时而 WS 75s 容忍还在），不因瞬时抖动拆连接。只用 chat WS 不用
  // notify WS：chat WS 有 pong 僵死检测（僵死 ≤75s 自闭，谎报窗口有界），notify 无。
  connectionService.setAuxLiveness(() => chatService.isChatConnected);
  wsServer = new IdeWsServer();
  wsServer.extensionVersion = extVersion;
  // [债#3 修 0726] 实例编号的工作区稳定段：存 workspaceState（per-工作区持久），同一工作区重开
  //   VSCode 时这一段不变 → 本体能认出「还是那个工作区的窗口」；编号的进程段仍每次新生成，
  //   所以同一工作区开两个窗口不会撞。没有工作区的窗口拿不到持久存储 → 留空退化为 "anon"。
  try {
    let _wsKey = context.workspaceState.get<string>("yonban.workspaceKey");
    if (!_wsKey) {
      _wsKey = Math.random().toString(36).slice(2, 10);
      void context.workspaceState.update("yonban.workspaceKey", _wsKey);
    }
    wsServer.workspaceKey = _wsKey;
  } catch (e) {
    console.warn("[YonBan] 工作区编号段初始化失败（实例编号退化为 anon）:", e);
  }
  toolExecutor = new ToolExecutor();
  consoleCapture = new ConsoleCapture();

  // ── 注册侧边栏 Webview Provider ────────────────────────
  provider = new YonBanProvider(
    context.extensionUri,
    connectionService,
    authService,
    wsServer,
    chatService,
    context.globalState,
    context.workspaceState, // 会话态 per-窗口：globalState 跨窗共享会让两个 VSCode 收敛到同一对话（0726 根因）
    extVersion,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("yonban.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── 注册命令 ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("yonban.connect", async () => {
      await connectionService.connect();
    }),
    vscode.commands.registerCommand("yonban.disconnect", () => {
      connectionService.disconnect();
    }),
    vscode.commands.registerCommand("yonban.showPanel", () => {
      vscode.commands.executeCommand("yonban.panel.focus");
    }),
    vscode.commands.registerCommand("yonban.startWsServer", async () => {
      await startWsServer();
    }),
    vscode.commands.registerCommand("yonban.stopWsServer", () => {
      wsServer.stop();
      vscode.window.showInformationMessage(t("YonBan: IDE 桥接服务已停止"));
    }),
  );

  // ── 串联：工具执行器注入到 WS 服务器 + ★ 功能C editRecord推送 ────
  // 写工具集合引用 ToolExecutor.WRITE_TOOLS（单一定义，新增工具只改一处）
  const WRITE_TOOLS = ToolExecutor.WRITE_TOOLS;
  wsServer.onToolCall = async (req, lifecycle) => {
    const result = await toolExecutor.execute(req, lifecycle);
    // execute() 返回 ToolCallResult { id, success, result }，工具真实返回体在 result.result（含 success/matchLine）
    const inner = result.result as { success?: boolean; matchLine?: number } | undefined;
    if (WRITE_TOOLS.has(req.tool) && result.success !== false && inner?.success !== false) {
      const params = (req.params || {}) as Record<string, unknown>;
      provider.postMessage({
        type: "editRecord",
        payload: {
          tool: req.tool,
          path: (params.path as string) || "",
          matchLine: (inner?.matchLine as number) || (params.line as number) || (params.start_line as number) || 1,
          lineCount: ((params.old_string as string) || "").split("\n").length || 1,
          oldString: ((params.old_string as string) || "").substring(0, 500),
          newString: ((params.new_string as string) || (params.content as string) || "").substring(0, 500),
          timestamp: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        },
      });
    }
    return result;
  };
  // ── AI 提问改道（0714，凛倾：不开悬浮窗，Kilo 式聊天流内选项/提醒）────
  // onQuestion 回调槽协议早已预留（IdeWsServer.ts:86）但从未注入 → 100% 走 vscode.window.showInputBox
  // 顶部模态输入框。现接线：聊天 webview 内 dock 答题 + 非模态通知提醒；webview 不可用时回退原 InputBox。
  wsServer.onQuestion = (id, text) => provider.handleAiQuestion(id, text);
  wsServer.onGetStatus = () => {
    const folders =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const allDiags = vscode.languages.getDiagnostics();
    let diagCount = 0;
    for (const [, diags] of allDiags) {
      diagCount += diags.length;
    }
    return {
      workspaceFolders: folders,
      activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath,
      diagnosticCount: diagCount,
      extensionVersion: extVersion,
      wsClients: wsServer.clientCount,
      uptime: Date.now() - ACTIVATE_TIME,
      appName: vscode.env.appName,
    };
  };

  // ── 串联：控制台捕获 → WS 广播 + webview 错误中心 ───────
  // 反馈系统（2026-07-13）：ConsoleCapture 原来只有一个消费者（beilu 网页端 ideConnPanel），
  // YonBan 自己的 webview 看不到宿主侧任何 console 错误（services 层 56 处 console.error 全盲）。
  // 现接第二消费者：warn/error 级实时转发给主面板错误中心（hostError），积压由 getHostErrors 补拉。
  consoleCapture.setOnEntry((entry) => {
    wsServer.broadcastConsole(entry);
    if (entry.level === "error" || entry.level === "warn") {
      provider.postMessage({ type: "hostError", payload: entry });
    }
  });
  // 捕获与 WS 服务器解耦：错误中心需要从激活起就有完整宿主日志（原只在 startWsServer 成功后 start，
  // WS 启动失败=全程零捕获，恰好丢掉最需要的启动期错误）
  consoleCapture.start();
  provider.consoleCapture = consoleCapture;

  // ── ★ 诊断变化监听 → WS广播编译错误给后端AI ─────────────
  let _diagDebounce: ReturnType<typeof setTimeout> | null = null;
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      // 防抖：500ms内多次变化只广播一次
      if (_diagDebounce) clearTimeout(_diagDebounce);
      _diagDebounce = setTimeout(() => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        const errors: Array<{ file: string; errors: Array<{ line: number; message: string }> }> = [];
        for (const uri of e.uris) {
          const diags = vscode.languages.getDiagnostics(uri);
          const errs = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
          if (errs.length > 0) {
            const relPath = wsRoot ? uri.fsPath.replace(wsRoot, "").replace(/\\/g, "/").replace(/^\//, "") : uri.fsPath;
            errors.push({
              file: relPath,
              errors: errs.slice(0, DIAG_ERRORS_PER_FILE).map((d) => ({
                line: d.range.start.line + 1,
                message: d.message,
              })),
            });
          }
        }
        if (errors.length > 0 && wsServer.clientCount > 0) {
          wsServer.broadcast({
            type: "diagnostics_changed",
            payload: { errors, totalErrors: errors.reduce((s, e) => s + e.errors.length, 0), timestamp: Date.now() },
          });
        }
      }, DIAG_DEBOUNCE_MS);
    }),
  );

  // ── ★ 文件变更监听 → WS通知后端AI ───────────────────────
  const _changedFiles = new Set<string>();
  let _fileChangeDebounce: ReturnType<typeof setTimeout> | null = null;
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{js,ts,mjs,cjs,jsx,tsx,json,css,html,md}");
  const handleFileChange = (uri: vscode.Uri) => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    const rel = wsRoot ? uri.fsPath.replace(wsRoot, "").replace(/\\/g, "/").replace(/^\//, "") : uri.fsPath;
    // 跳过node_modules/dist/data等（data是后端自己管理的，不是用户手动修改）
    if (rel.includes("node_modules") || rel.includes("/dist/") || rel.includes("/.") || rel.includes("/data/")) return;
    _changedFiles.add(rel);
    if (_fileChangeDebounce) clearTimeout(_fileChangeDebounce);
    _fileChangeDebounce = setTimeout(() => {
      if (_changedFiles.size > 0 && wsServer.clientCount > 0) {
        wsServer.broadcast({
          type: "file_changed",
          payload: {
            fileChanges: Array.from(_changedFiles),
            totalChanges: _changedFiles.size,
            timestamp: Date.now(),
          },
        });
        _changedFiles.clear();
      }
    }, FILE_CHANGE_DEBOUNCE_MS);
  };
  fileWatcher.onDidChange(handleFileChange);
  fileWatcher.onDidCreate(handleFileChange);
  fileWatcher.onDidDelete(handleFileChange);
  context.subscriptions.push(fileWatcher);

  // ── WS 客户端连接时，回放缓冲日志 ─────────────────────
  wsServer.onClientCountChange((count) => {
    if (count > 0) {
      // 新客户端连接，回放最近 CONSOLE_REPLAY_COUNT 条历史日志
      const buffer = consoleCapture.getBuffer().slice(-CONSOLE_REPLAY_COUNT);
      for (const entry of buffer) {
        wsServer.broadcastConsole(entry);
      }
    }
    // 通知 Webview 更新客户端数量
    provider.postWsClientCount(count);
  });

  // ── 自动连接后端 ───────────────────────────────────────
  const config = vscode.workspace.getConfiguration("yonban");
  if (config.get<boolean>("autoConnect", true)) {
    connectionService.connect().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[YonBan] 自动连接失败:", msg);
    });
  }

  // ── 自动启动 WS 服务器 ─────────────────────────────────
  if (config.get<boolean>("autoStartWs", true)) {
    startWsServer().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[YonBan] WS 服务器启动失败:", msg);
    });
  }

  // ── 监听配置变更 ────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yonban.serverUrl")) {
        connectionService.disconnect();
        // 报错兜底：原 .catch(()=>{}) 全吞——改 serverUrl 后重连失败用户无感。改为日志 + UI 警告。
        connectionService.connect().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[YonBan] serverUrl 变更后重连失败:", msg);
          vscode.window.showWarningMessage(t("YonBan: 重连失败 — ${msg}", { msg }));
        });
      }
      if (e.affectsConfiguration("yonban.wsPort")) {
        vscode.window.showInformationMessage(t("YonBan: WS端口已更改，需重启VSCode生效"));
      }
    }),
  );

  // ── 状态栏指示器（沙箱/生产模式） ────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const updateStatusBar = () => {
    const sandboxMode = vscode.workspace.getConfiguration("yonban").get<boolean>("sandboxMode", false);
    statusBarItem.text = sandboxMode ? `$(beaker) ${t("YonBan沙箱")}` : "$(plug) YonBan";
    statusBarItem.tooltip = sandboxMode
      ? t("沙箱模式：连接 ${port} 端口", { port: String(DEFAULT_SANDBOX_SERVER_PORT) })
      : t("生产模式：连接 ${port} 端口", { port: String(DEFAULT_SERVER_PORT) }); // T004/Y6：文案由常量拼，改端口不再漏改tooltip
    statusBarItem.command = "yonban.showConnectionInfo";
    statusBarItem.show();
  };
  updateStatusBar();
  context.subscriptions.push(
    statusBarItem,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("yonban.sandboxMode")) updateStatusBar();
    }),
  );

  // ── 切换沙箱模式命令 ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("yonban.toggleSandboxMode", async () => {
      const config = vscode.workspace.getConfiguration("yonban");
      const current = config.get<boolean>("sandboxMode", false);
      await config.update("sandboxMode", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        t("沙箱模式已${state}，重新连接后生效", { state: !current ? t("开启") : t("关闭") }),
      );
    }),
  );

  // ── 显示当前连接信息命令 ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("yonban.showConnectionInfo", async () => {
      const config = vscode.workspace.getConfiguration("yonban");
      const sandboxMode = config.get<boolean>("sandboxMode", false);
      const url = sandboxMode
        ? config.get<string>("sandboxServerUrl", DEFAULT_SANDBOX_SERVER_URL)
        : config.get<string>("serverUrl", DEFAULT_SERVER_URL);
      const wsPort = sandboxMode
        ? config.get<number>("sandboxWsPort", DEFAULT_SANDBOX_WS_PORT)
        : config.get<number>("wsPort", DEFAULT_WS_PORT);
      vscode.window.showInformationMessage(
        t("当前模式: ${mode}\n后端: ${url}\nWS端口: ${wsPort}", {
          mode: sandboxMode ? t("🧪沙箱") : t("✅生产"),
          url: url as string,
          wsPort: String(wsPort),
        }),
      );
    }),
  );

  // ── 资源注册到 subscriptions ────────────────────────
  context.subscriptions.push(
    { dispose: () => chatService.dispose() },
    { dispose: () => wsServer.dispose() },
    { dispose: () => consoleCapture.dispose() },
    { dispose: () => connectionService.dispose() },
    { dispose: () => toolExecutor.disposeShellSession() },
    // 切换 workspace 时：销毁持久 shell 会话（旧 cwd 失效，防僵尸进程）+ 立即推送 status 快照给本体
    // （0714 断链修：此前只销毁 shell 不广播，本体 workspaceRoot 停在旧 hello 快照——「VSCode 打开
    //  文件夹不传导到本体」病根；本体 ideClient case "status" 已有消费端并入 _ideInfo.status + reconcile）。
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      toolExecutor.disposeShellSession();
      wsServer.broadcastStatus();
    }),
  );

  // ── ast-grep 自动安装（ast_search/smart_search 依赖） ──
  _ensureAstGrep();

  console.log(`[YonBan] 插件初始化完成，WS 端口: ${wsServer.port}`);
}

/** 插件停用。按序清理：断开后端连接 → 停 WS 服务器 → 销毁控制台捕获 → 销毁持久 shell 会话 */
export function deactivate() {
  console.log("[YonBan] 插件停用");
  connectionService?.disconnect();
  wsServer?.stop();
  consoleCapture?.dispose();
  toolExecutor?.disposeShellSession();
}

/** 启动 WS 服务器（控制台捕获已在 activate 时无条件启动，与 WS 解耦） */
async function startWsServer(): Promise<void> {
  try {
    await wsServer.start();
    vscode.window.showInformationMessage(
      t("YonBan: IDE 桥接服务已启动 (ws://localhost:${port}/ide)", { port: String(wsServer.port) }),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(t("YonBan: WS 服务器启动失败 — ${msg}", { msg }));
  }
}

/** ast-grep 自动安装：激活时探测，不可用则后台 npm install -g @ast-grep/cli */
function _ensureAstGrep(): void {
  const candidates = process.platform === "win32"
    ? ["ast-grep", "ast-grep.cmd", "ast-grep.exe", "sg", "sg.cmd", "sg.exe"]
    : ["ast-grep", "sg"];
  for (const bin of candidates) {
    try {
      const r = cp.spawnSync(bin, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
      if (!r.error && r.status === 0) {
        console.log(`[YonBan] ast-grep 已就绪: ${bin} ${(r.stdout || "").trim()}`);
        return;
      }
    } catch { /* next */ }
  }
  console.log("[YonBan] ast-grep 未找到，正在后台安装 @ast-grep/cli …");
  const child = cp.spawn("npm", ["install", "-g", "@ast-grep/cli"], {
    shell: true, windowsHide: true, stdio: "pipe",
  });
  child.on("close", (code) => {
    if (code === 0) {
      console.log("[YonBan] ast-grep 安装成功");
      vscode.window.showInformationMessage("YonBan: ast-grep 已自动安装（ast_search/smart_search 可用）");
    } else {
      console.warn(`[YonBan] ast-grep 安装失败 (exit ${code})，可手动执行: npm install -g @ast-grep/cli`);
    }
  });
  child.on("error", (err) => {
    console.warn("[YonBan] ast-grep 安装进程启动失败:", err.message);
  });
}

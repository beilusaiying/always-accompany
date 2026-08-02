/**
 * IdeWsServer.ts — IDE WebSocket 服务器 — 本地端口监听，承接本体 ideClient.mjs 的 tool_call 请求 + 前端 ideConnPanel 连接。
 * 不管工具执行逻辑（那是 ToolExecutor 的事）、不管控制台日志采集（那是 ConsoleCapture 的事）。
 *
 * 链路：本体 ideClient.mjs WS 连接 ws://127.0.0.1:{port}/ide?token=...
 *       → 连接校验(路径+token) → hello 握手 → 消息循环(tool_call/question/ping)
 *       → tool_call: onToolCall(req) → ToolExecutor.execute(req) → tool_result 回传
 *       → question: 弹 VSCode InputBox → question_answer 回传
 * 影响：写 token 文件（~/.beilu/ide_ws_token, per-port token, 工作区 .beilu/_ws_token）；
 *       写活跃端口注册表（~/.beilu/ide_active_ports.json）；
 *       通过 onClientCountChange 事件广播客户端数量变化
 * 相交：← extension.ts 创建实例、注入 onToolCall / onGetStatus / onQuestion 回调
 *       ← ConsoleCapture 通过 broadcastConsole() 推送日志
 *       → ToolExecutor.execute()（通过 onToolCall 回调）
 *       → 本体 ideClient.mjs（WS 对端，发 tool_call / 收 tool_result）
 *       → 前端 ideConnPanel（WS 对端，收 console / status / hello）
 *
 * 协议消息类型（WsMessageType，全集见 types.ts 该联合类型）：
 *   收（client→server）：tool_call / question / ping
 *   发（server→client）：hello / tool_result / question_answer / console / status / pong / diagnostics_changed / file_changed
 *
 * 多窗口并存：端口冲突时自增重试（最多 10 次）；per-port token 文件互不覆盖；
 *   活跃端口注册表按 PID 存活过滤陈旧条目。
 * 沙箱模式：yonban.sandboxMode=true 时默认端口见 constants.ts DEFAULT_SANDBOX_WS_PORT（yonban.sandboxWsPort）。T004：注释不写死数字。
 *
 * 安全：仅监听 127.0.0.1（不暴露外网）；连接路径必须 /ide；token 必须匹配（否则 close 4001）。
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DEFAULT_WS_PORT, DEFAULT_SANDBOX_WS_PORT } from "../constants"; // T004 端口收口
import { t } from "../i18n";
import type {
  ConsoleEntry,
  IdeStatusPayload,
  ToolCallRequest,
  ToolCallResult,
  ToolProgressPayload,
  ToolStartedPayload,
  WsMessage,
} from "../types";
import type { CommandWatchdogProgress } from "./tools/process-telemetry";

export interface ToolCallLifecycle {
  signal: AbortSignal;
  onProgress: (progress: CommandWatchdogProgress) => void;
}

/**
 * IDE WebSocket 服务器 — 本地端口监听，承接本体 ideClient.mjs 的 tool_call 请求 + 前端 ideConnPanel 连接。
 * 不管工具执行逻辑（那是 ToolExecutor 的事）、不管控制台日志采集（那是 ConsoleCapture 的事）。
 *
 * 链路：本体 ideClient.mjs WS 连接 ws://127.0.0.1:{port}/ide?token=...
 *       → 连接校验(路径+token) → hello 握手 → 消息循环(tool_call/question/ping)
 *       → tool_call: onToolCall(req) → ToolExecutor.execute(req) → tool_result 回传
 *       → question: 弹 VSCode InputBox → question_answer 回传
 * 影响：写 token 文件（~/.beilu/ide_ws_token, per-port token, 工作区 .beilu/_ws_token）；
 *       写活跃端口注册表（~/.beilu/ide_active_ports.json）；
 *       通过 onClientCountChange 事件广播客户端数量变化
 * 相交：← extension.ts 创建实例、注入 onToolCall / onGetStatus / onQuestion 回调
 *       ← ConsoleCapture 通过 broadcastConsole() 推送日志
 *       → ToolExecutor.execute()（通过 onToolCall 回调）
 *       → 本体 ideClient.mjs（WS 对端，发 tool_call / 收 tool_result）
 *       → 前端 ideConnPanel（WS 对端，收 console / status / hello）
 *
 * 协议消息类型（WsMessageType，全集见 types.ts 该联合类型）：
 *   收（client→server）：tool_call / question / ping
 *   发（server→client）：hello / tool_result / question_answer / console / status / pong / diagnostics_changed / file_changed
 *
 * 多窗口并存：端口冲突时自增重试（最多 10 次）；per-port token 文件互不覆盖；
 *   活跃端口注册表按 PID 存活过滤陈旧条目。
 * 沙箱模式：yonban.sandboxMode=true 时默认端口见 constants.ts DEFAULT_SANDBOX_WS_PORT（yonban.sandboxWsPort）。T004：注释不写死数字。
 *
 * 安全：仅监听 127.0.0.1（不暴露外网）；连接路径必须 /ide；token 必须匹配（否则 close 4001）。
 */
export class IdeWsServer {
  private _wss: WebSocketServer | null = null;
  private _port: number;
  private _startTime = Date.now();
  private _wsToken: string = "";

  /** 扩展版本号，由 extension.ts 从 package.json 注入 */
  public extensionVersion: string = "";

  /**
   * 本 YonBan 实例编号（凛倾 0726：「yonban 就是我们的东西，直接做个小装置发送编号，本体识别」）。
   * 【why】原先本体靠「读注册表文件 + pid 探活 + 端口自增推断 + 15s 轮询重扫 + 拿 workspace 当身份」
   *   间接猜实例身份——pid 会复用、没开工作区的窗口没身份、重扫有延迟。实例身份本就该由实例自己声明：
   *   握手时报编号，本体记下即可，WS 连接本身就是活性证明，不需要探活也不需要轮询。
   * 【契约】两段式 `yb_<稳定段>_<进程段>`：
   *   · 稳定段 = 工作区身份（extension.ts 从 workspaceState 注入的持久 uuid），同一工作区重开 VSCode 不变
   *     → 本体可据此认出「还是那个工作区的窗口」，做绑定回迁；未注入（无工作区/旧版）时为 "anon"。
   *   · 进程段 = 本次扩展宿主随机值，保证同一工作区开两个窗口也是两个不同编号（不撞）。
   * 【债#3】原先只有进程段：唯一性够，但 VSCode 一重启编号全变、绑定只能作废重绑。
   */
  public get instanceId(): string {
    return `yb_${this.workspaceKey || "anon"}_${this._procSeg}`;
  }

  /** 工作区稳定段，由 extension.ts 在创建后注入（context.workspaceState 持久 uuid）。 */
  public workspaceKey = "";

  private readonly _procSeg: string = crypto.randomBytes(4).toString("hex");

  /** 工具执行回调，由 extension.ts 注入 */
  public onToolCall?: (
    req: ToolCallRequest,
    lifecycle: ToolCallLifecycle,
  ) => Promise<ToolCallResult>;

  /** 状态快照回调 */
  public onGetStatus?: () => IdeStatusPayload;

  /** question 提问回调，由 extension.ts 注入 */
  public onQuestion?: (id: string, text: string) => Promise<string | null>;

  private _onClientCountChange = new vscode.EventEmitter<number>();
  public readonly onClientCountChange = this._onClientCountChange.event;

  constructor() {
    const config = vscode.workspace.getConfiguration("yonban");
    const sandboxMode = config.get<boolean>("sandboxMode", false);
    if (sandboxMode) {
      this._port = config.get<number>("sandboxWsPort", DEFAULT_SANDBOX_WS_PORT);
    } else {
      this._port = config.get<number>("wsPort", DEFAULT_WS_PORT);
    }
  }

  get port(): number {
    return this._port;
  }

  get clientCount(): number {
    return this._wss?.clients.size ?? 0;
  }

  get isRunning(): boolean {
    return this._wss !== null;
  }

  /**
   * Y-2: 生成 WS token 并写入两处供本体读取：
   * 1. 工作区 .beilu/_ws_token（本体与工作区同目录时）
   * 2. 用户主目录 ~/.beilu/ide_ws_token（本体进程与工作区不同目录时的「传回」通道，
   *    同机进程都能用 os.homedir() 算出同一路径，与工作区位置无关）
   */
  /** 生成 token（连接校验需要，在建 server 前调用一次；retry 复用同一 token） */
  private _generateToken(): void {
    if (!this._wsToken) this._wsToken = crypto.randomBytes(16).toString("hex");
  }

  /**
   * 持久化 token/端口文件 —— 只在 `wss.on("listening")` 确认绑定端口后调用，
   * 绝不广播未真正绑定的端口（U2/D3 根因修：原在 listen 前写，端口重试/多窗口下
   * 全局 ide_ws_token 残留已退出实例端口，致 beilu 侧连死端口）。
   */
  private _generateAndSaveToken(port: number): void {
    this._generateToken();
    const beiluDir = path.join(os.homedir(), ".beilu");
    try {
      if (!fs.existsSync(beiluDir)) fs.mkdirSync(beiluDir, { recursive: true });
    } catch { /* ignore */ }

    const targets: { file: string; content: string }[] = [];
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // per-port token: 多窗口各自端口各自 token，不互相覆盖
    const portTokenFile = path.join(beiluDir, `ide_ws_token_${port}`);
    targets.push({ file: portTokenFile, content: this._wsToken });

    // 工作区 token（兼容旧路径）
    if (wsRoot) {
      targets.push({ file: path.join(wsRoot, ".beilu", "_ws_token"), content: `${port}:${this._wsToken}` });
    }

    // 主 token 文件：写 port:token 格式，beilu 侧解析
    targets.push({ file: path.join(beiluDir, "ide_ws_token"), content: `${port}:${this._wsToken}` });

    // 活跃端口注册表（beilu 侧用于发现所有活跃 YonBan 实例）
    this._registerActivePort(beiluDir, port);

    for (const { file, content } of targets) {
      try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content, "utf-8");
      } catch (e) {
        console.warn(`[YonBan/WS] 写入 WS token 失败 (${file}):`, (e as Error).message);
      }
    }
  }

  private _registerActivePort(beiluDir: string, port: number): void {
    const registryFile = path.join(beiluDir, "ide_active_ports.json");
    // [0727 并发写根修·lost-update] 多方（多 YonBan 窗口 + CLI，与 代码cli/server.mjs persistDiscovery 孪生同改）
    //   几乎同时启动时，无锁「整读→改→整写」会让后写者拿旧快照整体覆盖文件——先写者的条目丢失，
    //   本体池里"双开只见一个"的根源（A6 审计确诊）。Node 无内置跨进程文件锁，采用「写后核验+短重试」：
    //   写完立刻重读，自己的条目不在（被并发方覆盖）就重走一遍读改写，最多 3 次；每个写方都保留
    //   他人的活条目，各方同款自愈下收敛为全部在场。单进程场景一次通过，行为与原来等价。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let registry: { port: number; pid: number; time: number; workspace?: string; instanceId?: string; procStart?: number }[] = [];
        try {
          registry = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
          if (!Array.isArray(registry)) registry = [];
        } catch { /* new file */ }
        // 清除不再活跃的条目（进程不存在）+ 本进程旧条目（重试幂等，防自我重复）
        registry = registry.filter(entry => {
          if (!entry || entry.pid === process.pid) return false;
          try { process.kill(entry.pid, 0); return true; } catch { return false; }
        });
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // [债#9 修 0726] 补 instanceId + procStart（本进程启动时刻）：
        //   ① instanceId = 实例自报编号，本体据此认窗口（不再靠端口/pid 猜身份）；
        //   ② procStart 让 pid 探活成为双因子——裸 pid 会被系统复用，复用后旧条目会被误判成"还活着"，
        //      本体便去连一个早已不存在的实例。有 procStart 后可比对「同 pid 但启动时刻不同 = 不是同一个进程」。
        //   两字段都可选，旧本体读不到也不影响（向后兼容）。
        registry.push({
          port,
          pid: process.pid,
          time: Date.now(),
          workspace: wsRoot,
          instanceId: this.instanceId,
          procStart: Math.round(Date.now() - process.uptime() * 1000),
        });
        fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), "utf-8");
        // 写后核验：读回见到自己的条目 = 本轮没有被并发覆盖
        const check = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        if (Array.isArray(check) && check.some(e => e && e.pid === process.pid && e.port === port)) return;
        console.warn(`[YonBan/WS] 注册表被并发覆盖，第 ${attempt + 1} 次重写`);
      } catch (e) {
        console.warn(`[YonBan/WS] 注册活跃端口失败:`, (e as Error).message);
        return;
      }
    }
    console.warn(`[YonBan/WS] 注册表并发竞争 3 次重试后仍未确认自身条目在场（本体 15s 重扫仍可能发现本实例，必要时重开本窗口）`);
  }

  private _unregisterActivePort(): void {
    try {
      const registryFile = path.join(os.homedir(), ".beilu", "ide_active_ports.json");
      let registry: { port: number; pid: number }[] = [];
      try { registry = JSON.parse(fs.readFileSync(registryFile, "utf-8")); } catch { return; }
      registry = registry.filter(e => e.pid !== process.pid);
      fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), "utf-8");
    } catch { /* best effort */ }
  }

  get wsToken(): string { return this._wsToken; }

  private static readonly MAX_PORT_RETRIES = 10;

  /** 启动 WS 服务器（端口冲突时自增重试，支持多窗口并存） */
  start(): Promise<void> {
    if (this._wss) return Promise.resolve();
    return this._tryStart(this._port, 0);
  }

  private _tryStart(port: number, attempt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // 仅生成 token（连接校验需要）；文件/注册表持久化推迟到 listening 确认绑定端口后
      this._generateToken();

      try {
        const wss = new WebSocketServer({ host: "127.0.0.1", port });

        wss.on("listening", () => {
          this._wss = wss;
          this._port = port;
          // ★ 端口已确认绑定，此时才写 token 文件 + 注册活跃端口（绝不广播未绑定端口）
          this._generateAndSaveToken(port);
          this._setupConnectionHandler(wss);
          console.log(`[YonBan/WS] 服务器已启动，监听端口 ${this._port}，token=${this._wsToken.substring(0, 8)}...`);
          resolve();
        });

        wss.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < IdeWsServer.MAX_PORT_RETRIES) {
            const nextPort = port + 1;
            console.warn(`[YonBan/WS] 端口 ${port} 已被占用，尝试 ${nextPort} (${attempt + 1}/${IdeWsServer.MAX_PORT_RETRIES})`);
            wss.close();
            this._tryStart(nextPort, attempt + 1).then(resolve, reject);
          } else if (err.code === "EADDRINUSE") {
            console.error(`[YonBan/WS] 端口 ${port} 已被占用，${IdeWsServer.MAX_PORT_RETRIES} 次重试全部失败`);
            vscode.window.showErrorMessage(
              t("YonBan: 端口 ${portRange} 全部被占用，请在设置中修改 yonban.wsPort", { portRange: `${this._port}-${port}` }),
            );
            reject(err);
          } else {
            console.error(`[YonBan/WS] 服务器错误:`, err.message);
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private _setupConnectionHandler(wss: WebSocketServer): void {
    wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress || "unknown";

      const url = new URL(req.url || "/", `http://localhost:${this._port}`);

      if (url.pathname !== "/ide") {
        console.warn(`[YonBan/WS] 连接被拒绝: 非法路径 ${url.pathname} (from ${clientIp})`);
        ws.close(4003, "Invalid path");
        return;
      }

      const clientToken = url.searchParams.get("token");
      if (this._wsToken && clientToken !== this._wsToken) {
        console.warn(`[YonBan/WS] 连接被拒绝: token不匹配 (from ${clientIp})`);
        ws.close(4001, "Invalid token");
        return;
      }

      const connectionId = `yonban_ws_${crypto.randomUUID()}`;
      const activeToolCalls = new Map<string, AbortController>();
      console.log(`[YonBan/WS] 新连接: ${clientIp} (已认证)`);
      this._onClientCountChange.fire(this.clientCount);

      this.sendToClient(ws, {
        type: "hello",
        payload: {
          instanceId: this.instanceId, // 实例编号：本体据此认窗口（不再靠端口/pid/workspace 推断）
          extensionVersion: this.extensionVersion,
          appName: vscode.env.appName,
          port: this._port,
          uptime: Date.now() - this._startTime,
          status: this.onGetStatus?.() ?? null,
        },
      });

      ws.on("message", (raw) => {
        this.handleMessage(ws, raw, connectionId, activeToolCalls)
          .catch(err => console.error("[YonBan/WS] handleMessage unhandled:", err));
      });

      ws.on("close", () => {
        for (const controller of activeToolCalls.values()) {
          if (!controller.signal.aborted) controller.abort("ws_close");
        }
        console.log(`[YonBan/WS] 连接断开: ${clientIp}`);
        this._onClientCountChange.fire(this.clientCount);
      });

      ws.on("error", (err) => {
        for (const controller of activeToolCalls.values()) {
          if (!controller.signal.aborted) controller.abort("ws_error");
        }
        console.error(`[YonBan/WS] 客户端错误:`, err.message);
      });
    });
  }

  /** 停止 WS 服务器 */
  stop(): void {
    if (!this._wss) return;

    for (const client of this._wss.clients) {
      client.close(1000, "Server shutting down");
    }

    this._wss.close();
    this._wss = null;
    this._unregisterActivePort();
    // 清理 per-port token 文件
    try {
      const tokenFile = path.join(os.homedir(), ".beilu", `ide_ws_token_${this._port}`);
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
    } catch { /* best effort */ }
    console.log("[YonBan/WS] 服务器已停止");
  }

  /** 向所有已连接客户端广播消息 */
  broadcast(msg: WsMessage): void {
    if (!this._wss) return;
    const data = JSON.stringify(msg);
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** 广播控制台日志 */
  broadcastConsole(entry: ConsoleEntry): void {
    this.broadcast({ type: "console", payload: entry });
  }

  /** 广播 IDE 状态 */
  broadcastStatus(): void {
    if (!this.onGetStatus) return;
    this.broadcast({ type: "status", payload: this.onGetStatus() });
  }

  /** 向单个客户端发送消息 */
  private sendToClient(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** 处理客户端发来的消息 */
  private async handleMessage(
    ws: WebSocket,
    raw: RawData,
    connectionId: string,
    activeToolCalls: Map<string, AbortController>,
  ): Promise<void> {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw.toString()) as WsMessage;
    } catch {
      this.sendToClient(ws, {
        type: "tool_result",
        payload: {
          id: "parse_error",
          success: false,
          error: "无法解析 JSON 消息",
        } satisfies ToolCallResult,
      });
      return;
    }

    switch (msg.type) {
      case "ping":
        this.sendToClient(ws, { type: "pong", payload: { timestamp: Date.now() } });
        break;

      case "tool_call": {
        const req = msg.payload as ToolCallRequest;
        if (!req?.id || !req?.tool) {
          this.sendToClient(ws, {
            type: "tool_result",
            id: req?.id,
            payload: {
              id: req?.id || "unknown",
              success: false,
              error: "缺少 id 或 tool 字段",
            } satisfies ToolCallResult,
          });
          return;
        }

        if (!this.onToolCall) {
          this.sendToClient(ws, {
            type: "tool_result",
            id: req.id,
            payload: {
              id: req.id,
              success: false,
              error: "工具执行器未注册",
            } satisfies ToolCallResult,
          });
          return;
        }
        if (activeToolCalls.has(req.id)) {
          this.sendToClient(ws, {
            type: "tool_result",
            id: req.id,
            payload: {
              id: req.id,
              success: false,
              error: `duplicate_tool_call_id: ${req.id}`,
            } satisfies ToolCallResult,
          });
          return;
        }

        const startedAt = new Date();
        this.sendToClient(ws, {
          type: "tool_started",
          id: req.id,
          payload: {
            id: req.id,
            tool: req.tool,
            chatid: req.chatid ?? null,
            startedAt: startedAt.toISOString(),
          } satisfies ToolStartedPayload,
        });

        const start = startedAt.getTime();
        const lifecycleController = new AbortController();
        activeToolCalls.set(req.id, lifecycleController);
        try {
          // connectionId 由已认证 WS server 覆盖写入，不接受 payload 自报身份。
          const result = await this.onToolCall(
            { ...req, connectionId },
            {
              signal: lifecycleController.signal,
              onProgress: (progress) => {
                if (activeToolCalls.get(req.id) !== lifecycleController) return;
                this.sendToClient(ws, {
                  type: "tool_progress",
                  id: req.id,
                  payload: {
                    id: req.id,
                    tool: req.tool,
                    chatid: req.chatid ?? null,
                    progress,
                    occurredAt: new Date().toISOString(),
                  } satisfies ToolProgressPayload,
                });
              },
            },
          );
          result.duration = Date.now() - start;
          this.sendToClient(ws, {
            type: "tool_result",
            id: req.id,
            payload: result,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.sendToClient(ws, {
            type: "tool_result",
            id: req.id,
            payload: {
              id: req.id,
              success: false,
              error: errMsg,
              duration: Date.now() - start,
            } satisfies ToolCallResult,
          });
        } finally {
          if (activeToolCalls.get(req.id) === lifecycleController) {
            activeToolCalls.delete(req.id);
          }
        }
        break;
      }

      case "question": {
        // AI 通过后端发来提问请求 → 弹出 VSCode InputBox → 回传答案
        const qPayload = msg.payload as { id: string; text: string };
        if (!qPayload?.id || !qPayload?.text) {
          this.sendToClient(ws, {
            type: "question_answer",
            id: qPayload?.id,
            payload: { id: qPayload?.id || "unknown", answer: "", error: "缺少 id 或 text" },
          });
          return;
        }

        // 异步弹窗，不阻塞消息处理
        (async () => {
          try {
            let answer: string | null = null;
            if (this.onQuestion) {
              answer = await this.onQuestion(qPayload.id, qPayload.text);
            } else {
              // 默认使用 VSCode InputBox
              answer = await vscode.window.showInputBox({
                title: t("beilu AI 提问"),
                prompt: qPayload.text,
                placeHolder: t("请输入回答..."),
                ignoreFocusOut: true,
              }) ?? null;
            }
            this.sendToClient(ws, {
              type: "question_answer",
              id: qPayload.id,
              payload: { id: qPayload.id, answer: answer || "", answered: answer !== null },
            });
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.sendToClient(ws, {
              type: "question_answer",
              id: qPayload.id,
              payload: { id: qPayload.id, answer: "", error: errMsg },
            });
          }
        })();
        break;
      }

      default:
        console.warn(`[YonBan/WS] 未知消息类型: ${msg.type}`);
    }
  }

  dispose(): void {
    this.stop();
    this._onClientCountChange.dispose();
  }
}

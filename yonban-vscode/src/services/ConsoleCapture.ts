/**
 * ConsoleCapture.ts — 控制台捕获器 — 拦截 Extension Host 的 console.log/warn/error/info，
 * 通过回调推送给 IdeWsServer 广播到前端（beilu-chat ideConnPanel 控制台面板）。
 * 不管日志过滤/展示（那是前端 ideConnPanel 的事）。
 *
 * 链路：console.xxx(...) → 本模块拦截 → push() → _onEntry 回调 → IdeWsServer.broadcastConsole() → WS {type:"console"} → 前端
 * 影响：monkey-patch console.log/warn/error/info（start 时替换、stop 时还原）；维护最近 200 条内存缓冲
 * 相交：← extension.ts 创建实例并注入 setOnEntry(wsServer.broadcastConsole)
 *       → IdeWsServer.broadcastConsole()（通过回调，非直接依赖）
 *
 * 约束：start() 幂等（已启动则跳过）；stop() 还原原始方法引用。
 *       push 内部调原始 console 方法再转发，不会递归捕获。
 */
import type { ConsoleEntry } from "../types";
import { CONSOLE_BUFFER_MAX } from "../constants";

/**
 * 控制台捕获器 — 拦截 Extension Host 的 console.log/warn/error/info，
 * 通过回调推送给 IdeWsServer 广播到前端（beilu-chat ideConnPanel 控制台面板）。
 * 不管日志过滤/展示（那是前端 ideConnPanel 的事）。
 *
 * 链路：console.xxx(...) → 本模块拦截 → push() → _onEntry 回调 → IdeWsServer.broadcastConsole() → WS {type:"console"} → 前端
 * 影响：monkey-patch console.log/warn/error/info（start 时替换、stop 时还原）；维护最近 200 条内存缓冲
 * 相交：← extension.ts 创建实例并注入 setOnEntry(wsServer.broadcastConsole)
 *       → IdeWsServer.broadcastConsole()（通过回调，非直接依赖）
 *
 * 约束：start() 幂等（已启动则跳过）；stop() 还原原始方法引用。
 *       push 内部调原始 console 方法再转发，不会递归捕获。
 */
export class ConsoleCapture {
  private _onEntry?: (entry: ConsoleEntry) => void;
  private _active = false;
  private _startTime = Date.now();

  // 保存原始 console 方法
  private _origLog = console.log.bind(console);
  private _origWarn = console.warn.bind(console);
  private _origError = console.error.bind(console);
  private _origInfo = console.info.bind(console);

  /** 内存缓冲（最新 CONSOLE_BUFFER_MAX 条），用于新客户端连接时回放 */
  private _buffer: ConsoleEntry[] = [];
  private static readonly MAX_BUFFER = CONSOLE_BUFFER_MAX;

  /** 注册日志条目回调 */
  setOnEntry(cb: (entry: ConsoleEntry) => void): void {
    this._onEntry = cb;
  }

  /** 获取缓冲的历史日志 */
  getBuffer(): ConsoleEntry[] {
    return [...this._buffer];
  }

  /** 开始捕获 */
  start(): void {
    if (this._active) return;
    this._active = true;

    console.log = (...args: unknown[]) => {
      this._origLog(...args);
      this.push("log", args);
    };

    console.warn = (...args: unknown[]) => {
      this._origWarn(...args);
      this.push("warn", args);
    };

    console.error = (...args: unknown[]) => {
      this._origError(...args);
      this.push("error", args);
    };

    console.info = (...args: unknown[]) => {
      this._origInfo(...args);
      this.push("info", args);
    };

    this._origLog("[YonBan/ConsoleCapture] 日志捕获已启动");
  }

  /** 停止捕获，恢复原始 console */
  stop(): void {
    if (!this._active) return;
    console.log = this._origLog;
    console.warn = this._origWarn;
    console.error = this._origError;
    console.info = this._origInfo;
    this._active = false;
    this._origLog("[YonBan/ConsoleCapture] 日志捕获已停止");
  }

  private push(level: ConsoleEntry["level"], args: unknown[]): void {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

    // 从文本提取 [模块] 前缀
    const sourceMatch = text.match(/^\[([^\]]+)\]/);
    const source = sourceMatch ? sourceMatch[0] : undefined;

    const entry: ConsoleEntry = {
      level,
      text,
      time: this.timestamp(),
      source,
    };

    // 写入缓冲
    this._buffer.push(entry);
    if (this._buffer.length > ConsoleCapture.MAX_BUFFER) {
      this._buffer.splice(0, this._buffer.length - ConsoleCapture.MAX_BUFFER);
    }

    // 推送给 WS 服务器
    this._onEntry?.(entry);
  }

  private timestamp(): string {
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, "0");
    const mm = now.getMinutes().toString().padStart(2, "0");
    const ss = now.getSeconds().toString().padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  get uptime(): number {
    return Date.now() - this._startTime;
  }

  dispose(): void {
    this.stop();
    this._buffer.length = 0;
  }
}
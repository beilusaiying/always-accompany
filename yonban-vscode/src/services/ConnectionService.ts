/**
 * ConnectionService.ts — HTTP 连接管理 — ping 健康检查 + 自动登录 + 心跳保活 + 状态机广播。
 * 不管 WebSocket（那是 ChatService 和 IdeWsServer 的事）。
 *
 * 链路：用户点连接 / 扩展激活 → connect() → ping → login → startPing(30s心跳)
 *       心跳连续失败超过容忍次数 且 WS 旁证也死 → setState("error") → 指数退避自动重连
 *       （error 态心跳不停，单次 ping 恢复即原地回 connected，不必走完整 connect 管线）
 *       断开 → disconnect() → logout(吊销 refreshToken jti) → clearCookies
 * 影响：写 VSCode 状态栏消息（3s 自动消失）；通过 onStateChange 事件广播状态给 YonBanProvider
 * 相交：← extension.ts 创建实例  ← YonBanProvider 监听 onStateChange 推送 connectionState 给 webview
 *       → AuthService.login / .logout / .getSavedCredentials / .isAuthenticated / .getHeaders
 *
 * 状态机：disconnected → connecting → connected（正常） / error（心跳连续失败）
 *   connect() 幂等（connected/connecting 时跳过）
 *   disconnect() 取消所有定时器 + fire-and-forget logout
 *
 * 容错机制（0718 加，0720 抖动敏感修强化）：
 *   - 心跳容忍：连续 HEARTBEAT_MISS_TOLERANCE 次失败才判断连接（单次丢包不断）
 *   - WS 旁证（0720）：判死前咨询 setAuxLiveness 探针（extension.ts 接 chat WS）——
 *     后端忙时 HTTP ping 先超时而 WS(75s容忍)还活着，WS 活=本体没死，不判死
 *   - 心跳 ping 用 HEARTBEAT_PING_TIMEOUT_MS(15s)，connect() 交互路径保持 5s 快反馈
 *   - error 态心跳不停（0720）：原地恢复分支可达，恢复不必等指数退避
 *   - 指数退避重连：5s → 10s → 20s → 40s → 60s(上限)，成功后重置
 *   - connect() 失败自动调度重连（不再停死在 error 态）
 *
 * 沙箱模式：yonban.sandboxMode=true 时读 yonban.sandboxServerUrl（默认见 constants.ts DEFAULT_SANDBOX_SERVER_URL），
 *   否则读 yonban.serverUrl（默认 DEFAULT_SERVER_URL）。T004：默认值单源在 constants.ts，注释不再写死数字。
 */
import * as vscode from "vscode";
import type { ConnectionState } from "../types";
import { AuthService } from "./AuthService";
import { PING_TIMEOUT_MS, HEARTBEAT_PING_TIMEOUT_MS, HTTP_RECONNECT_DELAY_MS, HTTP_MAX_RECONNECT_DELAY_MS, HEARTBEAT_MISS_TOLERANCE, HEARTBEAT_INTERVAL_MS, DEFAULT_SERVER_URL, DEFAULT_SANDBOX_SERVER_URL } from "../constants";

export class ConnectionService {
  private _state: ConnectionState;
  private _onStateChange = new vscode.EventEmitter<ConnectionState>();
  public readonly onStateChange = this._onStateChange.event;

  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _authService: AuthService;
  private _consecutivePingFailures = 0;
  private _reconnectDelay = HTTP_RECONNECT_DELAY_MS;
  private _disposed = false;
  // 0720 抖动敏感修：第二活性证据（extension.ts 接线到 ChatService 的 WS 状态）。
  // HTTP ping 超时不等于本体死——后端忙时事件循环阻塞会让 HTTP 先超时而 WS（75s 容忍）还活着。
  // 判死裁决必须综合全部证据：WS 活着 → 只记失败不判死。
  private _auxLiveness: (() => boolean) | null = null;

  /** 注册辅助活性探针（WS 等旁路通道）。判死前咨询：探针返回 true 则本体未死，不进 error 态 */
  setAuxLiveness(probe: () => boolean): void {
    this._auxLiveness = probe;
  }

  constructor(authService: AuthService) {
    this._authService = authService;
    this._state = {
      status: "disconnected",
      serverUrl: this.getServerUrl(),
    };
  }

  get state(): ConnectionState {
    return { ...this._state };
  }

  /** 从 VSCode 配置读取后端地址（沙箱模式时返回沙箱地址） */
  getServerUrl(): string {
    const config = vscode.workspace.getConfiguration("yonban");
    const sandboxMode = config.get<boolean>("sandboxMode", false);
    if (sandboxMode) {
      return config.get<string>("sandboxServerUrl", DEFAULT_SANDBOX_SERVER_URL);
    }
    return config.get<string>("serverUrl", DEFAULT_SERVER_URL);
  }

  /** 连接后端：ping → 登录 → 启动心跳。失败自动调度指数退避重连。 */
  async connect(): Promise<void> {
    if (this._disposed) return;
    if (
      this._state.status === "connected" ||
      this._state.status === "connecting"
    ) {
      return;
    }

    this.setState({ status: "connecting", serverUrl: this.getServerUrl() });

    try {
      // Step 1: Ping
      const pingResult = await this.ping();
      if (!pingResult) {
        this.setState({ status: "error", error: "后端无响应" });
        this._scheduleReconnect();
        return;
      }

      // Step 2: 会话自愈优先（[0719 重连风暴修·诊断_YonBan通讯逐跳 跳4] 原每次重连无条件
      //   re-login：网络抖动触发重连风暴 → /api/login 撞后端限流 5/min → 429 拒绝 → 恶性循环。
      //   改为先经 fetchWithAuth 打轻鉴权端点 /api/whoami——cookie 活着=零 login 请求；
      //   401 时 fetchWithAuth 内置三级自愈（隐式 refresh → 账密重登）；全失败才走显式 login 兜底。）
      const credentials = await this._authService.getSavedCredentials();
      if (credentials) {
        let loginOk = false;
        try {
          const whoami = await this._authService.fetchWithAuth(
            this.getServerUrl(),
            `${this.getServerUrl()}/api/whoami`,
            { method: "GET", timeoutMs: 5000 },
          );
          loginOk = !!whoami && whoami.ok;
        } catch {
          loginOk = false;
        }
        if (!loginOk) {
          loginOk = await this._authService.login(
            this.getServerUrl(),
            credentials.username,
            credentials.password,
          );
        }
        if (loginOk) {
          this.setState({
            status: "connected",
            serverInfo: pingResult,
            username: credentials.username,
          });
        } else {
          // 登录失败但 ping 通了，提示需要重新登录。
          // username 显式清空：setState 是浅合并，不清会残留上次成功登录的用户名
          this.setState({
            status: "connected",
            serverInfo: pingResult,
            username: undefined,
            error: "登录凭据已失效，请重新登录",
          });
        }
      } else {
        this.setState({
          status: "connected",
          serverInfo: pingResult,
          error: "未登录",
        });
      }

      // 连接成功 → 重置退避延迟和失败计数
      this._reconnectDelay = HTTP_RECONNECT_DELAY_MS;
      this._consecutivePingFailures = 0;
      this.startPing();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: "error", error: message });
      this._scheduleReconnect();
    }
  }

  /**
   * 手动登录并同步状态机（webview 登录表单入口）。
   * 不能用 login+connect() 组合：connect() 在 connected/connecting 时幂等跳过，
   * 登录成功后状态机不刷新 → authenticated/username 不广播 → UI 停死在登录表单。
   */
  async loginAs(username: string, password: string): Promise<boolean> {
    const ok = await this._authService.login(this.getServerUrl(), username, password);
    if (ok) {
      this.setState({ status: "connected", username, error: undefined });
      this._reconnectDelay = HTTP_RECONNECT_DELAY_MS;
      this._consecutivePingFailures = 0;
      this.startPing();
    }
    return ok;
  }

  /** 断开连接 */
  disconnect(): void {
    this.stopPing();
    // A1-4 接通：主动登出让服务端吊销 refreshToken 的 jti（避免 jti 残留 30d），而非仅本地清 Cookie。
    this._authService.logout(this.getServerUrl()).catch(() => {});
    this.setState({ status: "disconnected" });
  }

  /** Ping 后端。timeoutMs：connect() 交互路径用默认 5s 快反馈；心跳活性探测传 15s（后端忙≠死） */
  async ping(timeoutMs: number = PING_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
    try {
      const url = `${this.getServerUrl()}/api/ping`;
      const resp = await fetch(url, {
        method: "GET",
        headers: this._authService.getHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        return (await resp.json()) as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 启动心跳（每 30s ping 一次，连续 N 次失败且 WS 旁证也死才判断连接）。
   *  0720 抖动敏感修（三点，原设计对瞬时抖动过敏——本体没断 UI 就拆）：
   *  ① 判死前咨询 _auxLiveness：WS 还活着=本体没死，只记失败继续探测，不进 error 态
   *  ② 判死后不再 stopPing——心跳继续跑，下方"瞬时恢复"分支才可达（原 stopPing 使其死代码，
   *     恢复被迫走完整 connect 管线+指数退避，UI 停死在连接错误最长 60s）
   *  ③ error 态只在跃迁时 setState，避免每 30s 重复广播打爆 webview 重渲染+状态栏 */
  private startPing(): void {
    this.stopPing();
    this._consecutivePingFailures = 0;
    this._pingTimer = setInterval(async () => {
      const result = await this.ping(HEARTBEAT_PING_TIMEOUT_MS);
      if (result) {
        this._consecutivePingFailures = 0;
        // 心跳恢复时如果之前处于 error 状态（瞬时恢复），重新标记为 connected；
        // 同时取消已排程的重连（不取消则残留 timer 稍后触发，把刚重置的退避延迟又翻倍）
        if (this._state.status === "error") {
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
          }
          this.setState({ status: "connected", error: undefined });
          this._reconnectDelay = HTTP_RECONNECT_DELAY_MS;
        }
      } else if (this._state.status === "connected" || this._state.status === "error") {
        this._consecutivePingFailures++;
        if (this._consecutivePingFailures >= HEARTBEAT_MISS_TOLERANCE) {
          if (this._auxLiveness?.()) {
            console.warn(`[ConnectionService] HTTP 心跳连续 ${this._consecutivePingFailures} 次丢失，但 WS 通道存活 → 本体未死，不判断连接`);
            return;
          }
          if (this._state.status !== "error") {
            this.setState({ status: "error", error: `心跳连续 ${this._consecutivePingFailures} 次丢失，后端无响应` });
          }
          this._scheduleReconnect();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** 指数退避调度重连（5s → 10s → 20s → 40s → 60s 上限） */
  private _scheduleReconnect(): void {
    if (this._disposed) return;
    if (this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    console.log(`[ConnectionService] ${delay / 1000}s 后重连...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, HTTP_MAX_RECONNECT_DELAY_MS);
      this.connect().catch(() => {});
    }, delay);
  }

  private stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /** 更新状态并触发事件 */
  private setState(partial: Partial<ConnectionState>): void {
    this._state = {
      ...this._state,
      ...partial,
      serverUrl: partial.serverUrl ?? this._state.serverUrl,
      authenticated: this._authService.isAuthenticated,
    };
    this._onStateChange.fire(this._state);

    const icon =
      this._state.status === "connected"
        ? "$(pass-filled)"
        : this._state.status === "error"
          ? "$(error)"
          : this._state.status === "connecting"
            ? "$(sync~spin)"
            : "$(circle-slash)";
    vscode.window.setStatusBarMessage(
      `${icon} YonBan: ${this._state.status}`,
      3000,
    );
  }

  dispose(): void {
    this._disposed = true;
    this.stopPing();
    this._onStateChange.dispose();
  }
}

/**
 * AuthService.ts — 认证服务（单一鉴权权威）— 登录、Cookie 管理、凭据持久化、统一 401-refresh-retry。
 * 不管连接状态机（那是 ConnectionService 的事）、不管业务 API 拼接（那是 ChatService 的事）。
 *
 * 链路：login → POST /api/login(body:{username,password,deviceid}) → 从 response body + Set-Cookie 取 token → _cookies Map
 *       fetchWithAuth → 发请求 + 解析 Set-Cookie → 401 时两轮恢复：① 重打(隐式 refresh) ② 账密重登
 *       logout → POST /api/logout(带 refreshToken cookie) → clearCookies
 * 影响：写 VSCode SecretStorage（凭据持久化）；内存 _cookies Map（accessToken / refreshToken）
 * 相交：← ConnectionService.connect / .disconnect 调 login / logout
 *       ← ChatService._fetchWithAuth 代理到 fetchWithAuth
 *       ← YonBanProvider 通过 fetchOk 直接调用（preset / runtime / files 等非 ChatService 覆盖的 API）
 *       → 本体 auth.mjs authenticate 中间件（隐式 refresh：带 refreshToken 重打即自动换新 token）
 *       → 本体 endpoints.mjs:375 login 端点（destructure username/password/deviceid）
 *       → 本体 endpoints.mjs:442 logout 端点（无 authenticate 中间件，靠 refreshToken cookie 识别）
 *
 * 设备绑定（A1-1）：login body 携带 deviceid（VSCode machineId），本体按此做单设备 token 绑定，
 *   不发 deviceid 时多 IDE 实例会互顶。
 */
import * as vscode from "vscode";
import { API_TIMEOUT_MS, LOGIN_TIMEOUT_MS, LOGOUT_TIMEOUT_MS } from "../constants";
import { t } from "../i18n";

/** 保存在 SecretStorage 中的凭据 */
interface SavedCredentials {
  username: string;
  password: string;
}

/**
 * 认证服务（单一鉴权权威）— 登录、Cookie 管理、凭据持久化、统一 401-refresh-retry。
 * 不管连接状态机（那是 ConnectionService 的事）、不管业务 API 拼接（那是 ChatService 的事）。
 *
 * 链路：login → POST /api/login(body:{username,password,deviceid}) → 从 response body + Set-Cookie 取 token → _cookies Map
 *       fetchWithAuth → 发请求 + 解析 Set-Cookie → 401 时两轮恢复：① 重打(隐式 refresh) ② 账密重登
 *       logout → POST /api/logout(带 refreshToken cookie) → clearCookies
 * 影响：写 VSCode SecretStorage（凭据持久化）；内存 _cookies Map（accessToken / refreshToken）
 * 相交：← ConnectionService.connect / .disconnect 调 login / logout
 *       ← ChatService._fetchWithAuth 代理到 fetchWithAuth
 *       ← YonBanProvider 通过 fetchOk 直接调用（preset / runtime / files 等非 ChatService 覆盖的 API）
 *       → 本体 auth.mjs authenticate 中间件（隐式 refresh：带 refreshToken 重打即自动换新 token）
 *       → 本体 endpoints.mjs:375 login 端点（destructure username/password/deviceid）
 *       → 本体 endpoints.mjs:442 logout 端点（无 authenticate 中间件，靠 refreshToken cookie 识别）
 *
 * 设备绑定（A1-1）：login body 携带 deviceid（VSCode machineId），本体按此做单设备 token 绑定，
 *   不发 deviceid 时多 IDE 实例会互顶。
 */
export class AuthService {
  private _context: vscode.ExtensionContext;
  /** 当前会话的 Cookie（accessToken + refreshToken） */
  private _cookies: Map<string, string> = new Map();

  private static readonly CREDENTIAL_KEY = "yonban.credentials";
  /**
   * 设备标识（A1-1）：本体 login 用 deviceid 做单设备 token 绑定（endpoints.mjs:375 小写 deviceid）。
   * 不发 deviceid 时多 IDE 实例会互顶。优先用 VSCode 稳定 machineId，取不到时回退常量。
   */
  private static readonly DEVICE_ID_FALLBACK = "yonban-vscode";
  private readonly _deviceId: string;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._deviceId = vscode.env.machineId || AuthService.DEVICE_ID_FALLBACK;
  }

  /** 获取已保存的凭据 */
  async getSavedCredentials(): Promise<SavedCredentials | null> {
    try {
      const raw = await this._context.secrets.get(AuthService.CREDENTIAL_KEY);
      if (raw) {
        return JSON.parse(raw) as SavedCredentials;
      }
    } catch {
      // 解析失败，清除损坏的数据
      await this._context.secrets.delete(AuthService.CREDENTIAL_KEY);
    }
    return null;
  }

  /** 保存凭据到 SecretStorage */
  async saveCredentials(username: string, password: string): Promise<void> {
    await this._context.secrets.store(
      AuthService.CREDENTIAL_KEY,
      JSON.stringify({ username, password }),
    );
  }

  /** 清除保存的凭据 */
  async clearCredentials(): Promise<void> {
    await this._context.secrets.delete(AuthService.CREDENTIAL_KEY);
  }

  /**
   * 执行登录请求。
   * 后端返回 Set-Cookie 设置 accessToken 和 refreshToken。
   */
  async login(
    serverUrl: string,
    username: string,
    password: string,
  ): Promise<boolean> {
    try {
      const resp = await fetch(`${serverUrl}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // 本体 destructure 的是小写 deviceid（endpoints.mjs:375），不是 deviceId。
        body: JSON.stringify({ username, password, deviceid: this._deviceId }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });

      if (!resp.ok) {
        return false;
      }

      const data = (await resp.json()) as Record<string, unknown>;

      // 后端在 body 中也返回 token（result.accessToken / result.refreshToken）。
      // 优先用 body：httpOnly cookie 在某些环境（如 webview 代理）不可读，body 更可靠。
      if (data.accessToken && typeof data.accessToken === "string") {
        this._cookies.set("accessToken", data.accessToken);
      }
      if (data.refreshToken && typeof data.refreshToken === "string") {
        this._cookies.set("refreshToken", data.refreshToken);
      }

      // Set-Cookie 头解析统一走 _updateCookiesFromResponse（与 fetchWithAuth 共用同一路径）
      this._updateCookiesFromResponse(resp);

      // 保存凭据
      await this.saveCredentials(username, password);
      return true;
    } catch (err) {
      console.error("[YonBan/Auth] 登录失败:", err);
      return false;
    }
  }

  /** 弹出输入框让用户手动登录 */
  async promptLogin(serverUrl: string): Promise<boolean> {
    const username = await vscode.window.showInputBox({
      prompt: t("beilu 用户名"),
      placeHolder: t("请输入用户名"),
    });
    if (!username) {
      return false;
    }

    const password = await vscode.window.showInputBox({
      prompt: t("beilu 密码"),
      placeHolder: t("请输入密码（可留空）"),
      password: true,
    });

    return this.login(serverUrl, username, password ?? "");
  }

  /** 构造带 Cookie 的请求头 */
  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this._cookies.size > 0) {
      const cookieStr = Array.from(this._cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      headers["Cookie"] = cookieStr;
    }
    return headers;
  }

  /**
   * 从任意 Response 的 Set-Cookie 头解析 accessToken / refreshToken 并更新 _cookies。
   * 本体的 token 刷新（auth.mjs:600-611 authenticate 中间件隐式 refresh）通过 Set-Cookie
   * 头 rotate 新 token——任何带 refreshToken cookie 的鉴权请求被中间件自动 refresh 后，
   * 新 token 只在响应的 Set-Cookie 里。所有发请求的路径（login / fetchWithAuth）都必须
   * 调用此方法，否则 rotate 后客户端仍持旧 token → 下次 401。
   */
  private _updateCookiesFromResponse(resp: Response): void {
    // getSetCookie 在 Node 18+（undici）支持；用 ?.() 保证缺失环境不崩。
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      const match = cookie.match(/^(accessToken|refreshToken)=([^;]+)/);
      if (match) {
        this._cookies.set(match[1], match[2]);
      }
    }
  }

  /**
   * 最后手段：用 SecretStorage 里保存的账密重新登录。
   *
   * 本体没有独立 refresh 端点——token 刷新是 authenticate 中间件隐式做的（带 refreshToken
   * cookie 重打原请求即可，见 auth.mjs:600-611）。所以本方法不再尝试任何 refresh 端点，
   * 只在「隐式 refresh 也失败（refreshToken 也过期/被吊销）」时，用存的密码重新登录，
   * 拿一对全新 token。
   */
  async refreshAccessToken(serverUrl: string): Promise<boolean> {
    const creds = await this.getSavedCredentials();
    if (creds) {
      return this.login(serverUrl, creds.username, creds.password);
    }
    return false;
  }

  /**
   * 统一鉴权请求（单一权威）。401 恢复分两轮，对齐本体的隐式 refresh 框架：
   *   ① 正常发 → 每次都解析 Set-Cookie（捕获中间件 rotate 的新 token）。
   *   ② 收 401 → 第一轮：直接重打原请求。带 refreshToken cookie 时，authenticate 中间件
   *      （auth.mjs:600-611）会隐式 refresh 并 Set-Cookie 新 token；buildInit() 重新读
   *      getHeaders() 用当前 cookie。
   *   ③ 仍 401 → 第二轮：refreshAccessToken（现在=用保存账密重登）→ 拿全新 token 再打一次。
   * 本体没有独立 refresh 端点——这是关键：旧实现 POST /api/login body:{refreshToken} 被
   * 端点当成 username=undefined → 必 401（endpoints.mjs:375 只 destructure username/password/deviceid）。
   *
   * 原 401-refresh 逻辑私有在 ChatService._fetchWithAuth，YonBanProvider 的 preset/runtime/files 裸 fetch 够不到 →
   * 全 API 401 收口只覆盖 ChatService（债务 D4）。下沉到 AuthService 这个鉴权权威,两侧共用,消除收口缺口。
   */
  async fetchWithAuth(
    serverUrl: string,
    url: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number; jsonBody?: boolean } = {},
  ): Promise<Response> {
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
    const hasBody = opts.body !== undefined && opts.body !== null;
    const buildInit = (): RequestInit => ({
      method,
      headers: {
        ...(opts.jsonBody ? { "Content-Type": "application/json" } : {}),
        ...this.getHeaders(),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    let resp: Response;
    try {
      resp = await fetch(url, buildInit());
    } catch (netErr) {
      // [0719 双发根因修·凛倾「只发送一次但ai看到了4次」确诊] 重试语义按错误类型分流：
      //   连接级失败（ECONNRESET/ECONNREFUSED/DNS——请求未上路）→ 重试一次安全（绕 stale keep-alive，原意保留）；
      //   超时（TimeoutError/AbortError——请求已上路、后端可能已处理落盘）→ 非幂等方法（POST/PUT/DELETE）
      //   绝不重试：原盲重试使「首发 15s 超时但后端已落盘 addUserReply」场景每次点击落 2 条消息，
      //   用户重点一次=4 条（后端 chatOps addChatLogEntry 无幂等键，重放即重复）。超时错误如实上抛
      //   → 调用方/UI 可见（同时消「发送失败没有提醒」的静默层之一）。
      const _isTimeout = (netErr as Error)?.name === "TimeoutError" || (netErr as Error)?.name === "AbortError";
      const _idempotent = method === "GET" || method === "HEAD";
      if (_isTimeout && !_idempotent) {
        throw netErr;
      }
      try {
        resp = await fetch(url, buildInit());
      } catch {
        throw netErr; // 二次失败抛原始错误
      }
    }
    this._updateCookiesFromResponse(resp);
    if (resp.status !== 401) {
      return resp;
    }

    // 第一轮 retry：重打原请求 → 让 authenticate 中间件用 refreshToken cookie 隐式 refresh。
    const retry1 = await fetch(url, buildInit());
    this._updateCookiesFromResponse(retry1);
    if (retry1.status !== 401) {
      return retry1;
    }

    // 仍 401（refreshToken 也失效）→ 第二轮：用保存的账密重新登录后再打一次。
    const relogged = await this.refreshAccessToken(serverUrl);
    if (relogged) {
      const retry2 = await fetch(url, buildInit());
      this._updateCookiesFromResponse(retry2);
      return retry2;
    }
    return retry1; // 返回 401 让调用方处理
  }

  /**
   * fail-loud 版鉴权请求（单一权威）：在 fetchWithAuth 基础上，`!resp.ok` 直接抛（带 status + body 摘要）。
   * 给「按钮动作」类调用方用——抛出的错由 YonBanProvider 顶层 onDidReceiveMessage 兜底 → operationError toast，
   * 不必每个 handler 各自 `if(!resp.ok)throw`（那是补丁）。需要业务态判断（如 404=未找到）的调用方仍用 fetchWithAuth。
   * @returns 已确认 resp.ok 的 Response（调用方可安全 .json()）
   */
  async fetchOk(
    serverUrl: string,
    url: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number; jsonBody?: boolean; action?: string } = {},
  ): Promise<Response> {
    const resp = await this.fetchWithAuth(serverUrl, url, opts);
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 200); } catch { /* body 读不到忽略 */ }
      throw new Error(`${opts.action ? opts.action + " " : ""}请求失败 (${resp.status})${detail ? ": " + detail : ""}`);
    }
    return resp;
  }

  /**
   * 主动登出（A1-4）：调本体 /api/logout 让服务端吊销 refreshToken 的 jti，避免 jti 残留 30d。
   * 端点无 authenticate 中间件（endpoints.mjs:442），靠 refreshToken cookie 识别，带 getHeaders() 即可。
   * 尽力而为——网络失败不阻断本地清理。注意：调用方（如 ConnectionService.disconnect）负责接线，
   * 本方法只在 AuthService 暴露能力，不在此改其它文件。
   */
  async logout(serverUrl: string): Promise<void> {
    try {
      await fetch(`${serverUrl}/api/logout`, {
        method: "POST",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
      });
    } catch {
      /* 尽力而为：服务端不可达时仍执行本地清理 */
    }
    this.clearCookies();
  }

  /** 清除当前会话的 Cookie */
  clearCookies(): void {
    this._cookies.clear();
  }

  /** 当前是否有有效的 Cookie */
  get isAuthenticated(): boolean {
    return this._cookies.has("accessToken");
  }
}

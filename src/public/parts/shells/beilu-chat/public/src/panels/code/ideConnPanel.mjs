/**
 * ideConnPanel.mjs — 后端管理面板（VSCode / Cursor WebSocket 连接）
 *
 * 功能链：
 *   initIdeConnPanel → 渲染 VSCode/Cursor 连接卡片 → 点「连接」按钮
 *     → new WebSocket(ws://localhost:<port>/ide) → 握手成功更新 connStates[id].status="connected"
 *     → 每 30s 发 ping 保活 / 断线自动重连
 *   点「断开」按钮 → ws.close() → 状态变 disconnected → 卡片 UI 更新
 *   点「刷新运行时状态」→ GET /api/parts/shells:chat/runtime-info → 展示当前模式/API/预设/Token
 *   已加载插件列表 → GET /api/parts/list → 渲染插件行
 *
 * why：
 *   浏览器前端不能直接读取 IDE WS 状态，需要由本面板维护 connStates 内存对象，
 *   并通过 ping/pong 心跳判断连接是否仍活跃，避免 IDE 重启后前端以为仍连着。
 *   默认端口取 config/ports.mjs IDE_WS_PORT（脚本从后端 ideClient.mjs 抽值生成镜像，T2 config 收口）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（运行时状态 / 插件列表）
 *   → shared/state/storage.mjs（连接配置持久化到 localStorage 的 beilu-ide-conn-settings）
 *   → panels/feature/featureControls.mjs getCurrentMode（当前模式展示）
 *   → shared/widgets/tokenProgressBar.mjs getTokenInfo（Token 使用展示）
 *   ← idePanel.mjs / layout.mjs（在 IDE 活动栏 [I] 接口按钮点击时挂载）
 *
 * 影响范围：
 *   #conn-cards 容器（连接卡片 DOM）、#ide-runtime-info 区域、connStates 内存对象、
 *   localStorage key "beilu-ide-conn-settings"。
 *
 * 使用效果：
 *   点「连接」→ WS 握手 → 卡片变绿"已连接 Xs"；点「断开」→ 变灰；
 *   连接后 AI 可通过 ideClient 发 IDE 工具调用（文件读写/git 等）到 VSCode/Cursor YonBan 扩展。
 */

import { getCurrentMode } from "../feature/featureControls.mjs";
import { getTokenInfo } from "../../shared/widgets/tokenProgressBar.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";
import { showToast } from "../../../../../../scripts/toast.mjs";
import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（ideWsToken/ideConnect/ideManualToolCall；WS 回向通道不收=登记）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { IDE_WS_PORT, wsUrl } from "../../config/ports.mjs"; // T2 config 收口：端口镜像单源（脚本从后端 ideClient.mjs 抽值生成，改端口跑 tools/extract_config_ports.mjs）

// ---- 连接状态存储 ----
const CONN_SETTINGS_KEY = KEYS.BEILU_IDE_CONN_SETTINGS;

function loadConnSettings() {
  try {
    return JSON.parse(storage.get(CONN_SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveConnSettings(settings) {
  try {
    storage.set(CONN_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

// ---- IDE 连接定义 ----
// VS Code 与 Cursor 合并为一张 YonBan 卡（凛倾 0722「把vs和cu那两个合成一个」）：
// 两者装的是同一个 YonBan 扩展、同一发现协议/端口/wsPath，前端连接行为完全一致，双卡=同物双显。
// id 保留 "vscode"（connStates/localStorage 存量键不迁移）。
const IDE_PROFILES = [
  {
    id: "vscode",
    name: "VS Code / Cursor",
    icon: '<i data-ic="vscode"></i>',
    // [0731 分发校准] 扩展未上架市场，以仓库内 yonban-vscode/ 的 vsix 分发（版本随构建产物走，不在此硬编码）
    extensionName: "YonBan 扩展（yonban）",
    version: "",
    defaultPort: IDE_WS_PORT,
    wsPath: "/ide",
  },
  {
    id: "cli",
    name: "CLI",
    icon: '<i data-ic="terminal"></i>',
    extensionName: "beilu-cli",
    version: "v1.0.0",
    defaultPort: IDE_WS_PORT,
    wsPath: "/ide",
  },
];

// 连接状态（内存中维护）
const connStates = {};
for (const p of IDE_PROFILES) {
  connStates[p.id] = {
    status: "disconnected", // disconnected | connecting | connected | error
    sessionStart: null,
    lastError: null,
    ws: null,
  };
}

// ---- 渲染 IDE 连接卡片 ----

/**
 * 「在线实例」区块（多开 0726 凛倾「进程显示分类」）：后端连接池里真实在线的执行端逐条列出。
 * 【why】上方两张卡是**前端自己直连 IDE**的手动连接器，profile 固定端口（IDE_WS_PORT），
 *   看不到多开产生的其他实例——实测在线 8932/8933 两个 YonBan 在面板上完全不可见，
 *   两张卡还都指向 8931 一个显示已连一个显示未连=同端口双语义。本区块与它们数据源不同：
 *   来自后端 ideClient 连接池快照（getIdeInstances），是「AI 的工具调用实际能打到哪些窗口」的真相。
 * 【显示】每实例：类型(本体CLI/VSCode) · 工作区 · 端口 · 实例编号 · 是否主连接 · 绑定线数。
 */
async function renderIdeInstances() {
  const box = document.getElementById("ide-instances-box");
  if (!box) return;
  let snap = null;
  try {
    snap = await sendAction({ verb: "getIdeInstances", target: "plugins:beilu-memory", source: "web" });
  } catch (e) {
    box.innerHTML = `<div style="font-size:0.62rem;opacity:0.6;">实例列表读取失败：${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const list = Array.isArray(snap?.instances) ? snap.instances : [];
  const bindings = snap?.bindings || {};
  if (!list.length) {
    box.innerHTML = `<div style="font-size:0.62rem;opacity:0.6;">后端连接池为空：当前没有任何执行端在线（AI 的工具调用无处可去）。</div>`;
    return;
  }
  let html = "";
  for (const inst of list) {
    const root = Array.isArray(inst.workspaceFolders) ? inst.workspaceFolders[0] : "";
    const seg = root ? String(root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
    const kind = inst.kind === "cli" ? "本体 CLI" : "VSCode";
    // 债#5：绑定来源可见——manual=用户在 ＋号 里指定（粘性，不被自动上报覆盖），auto=窗口打开即报。
    let lines = 0, manual = 0;
    for (const k of Object.keys(bindings)) {
      if (bindings[k]?.port !== inst.port) continue;
      lines++;
      if (bindings[k]?.source === "manual") manual++;
    }
    const dot = inst.connected ? "#22c55e" : "#9ca3af";
    html +=
      `<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;background:rgba(128,128,128,0.08);margin-bottom:3px;">` +
      `<span style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0;"></span>` +
      `<span style="flex:1;font-size:0.63rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">` +
      `<b>${escapeHtml(kind)}</b> · ${escapeHtml(seg || "未开工作区")} · :${inst.port}` +
      (inst.instanceId ? ` · <span style="opacity:0.6;">${escapeHtml(inst.instanceId)}</span>` : "") +
      `</span>` +
      (inst.primary ? `<span style="font-size:0.55rem;opacity:0.7;" title="未绑定执行端的会话默认走这条">主连接</span>` : "") +
      `<span style="font-size:0.55rem;opacity:0.7;" title="${manual} 条为用户手动指定（＋号选的，不会被自动上报覆盖），其余为窗口打开对话时自动上报">${lines} 条线${manual ? `（${manual} 手动）` : ""}</span>` +
      `</div>`;
  }
  box.innerHTML = html;
}

function renderConnCards() {
  const container = document.getElementById("conn-cards");
  if (!container) return;

  container.innerHTML = "";

  for (const profile of IDE_PROFILES) {
    const state = connStates[profile.id];
    // T-1：版本号优先取握手回包的真实 extensionVersion（YonBan hello.payload.extensionVersion，
    // 源 package.json），连接后不再显示写死的 profile.version；未连接时回退占位。
    const _hsVer = state.ideInfo?.extensionVersion;
    const _verLabel = _hsVer ? ("v" + String(_hsVer).replace(/^v/, "")) : profile.version;
    const card = document.createElement("div");
    card.className = "conn-card";
    card.innerHTML = `
      <div class="conn-card-header">
        <span style="font-size:1.2rem;">${profile.icon}</span>
        <div style="flex:1;">
          <div style="font-weight:600; font-size:0.82rem; color:var(--beilu-amber,#d4a017);">${profile.name}</div>
          <div style="font-size:0.6rem; opacity:0.5;">${profile.extensionName} ${_verLabel}</div>
        </div>
      </div>
      <div class="conn-card-status">
        <span class="conn-dot conn-dot-${state.status}"></span>
        <span style="font-size:0.72rem;">${getStatusText(state.status)}</span>
        <span class="conn-tag conn-tag-${state.status}" style="margin-left:auto;">${getStatusTag(state.status)}</span>
      </div>
      <div style="font-size:0.65rem; opacity:0.4; font-family:monospace;">
        ${wsUrl(profile.defaultPort, profile.wsPath)}
      </div>
      ${state.sessionStart ? `<div style="font-size:0.65rem; opacity:0.4; margin-top:2px;">会话时长: ${formatDuration(Date.now() - state.sessionStart)}</div>` : ""}
      ${state.lastError ? `<div style="font-size:0.65rem; color:var(--beilu-error); margin-top:2px;"><i data-ic="warning"></i> ${escapeHtml(state.lastError)}</div>` : ""}
      <div class="conn-card-actions">
        ${
          state.status === "connected"
            ? `<button class="conn-btn" data-action="reconnect" data-ide="${profile.id}"><i data-ic="refresh"></i> 重连</button>
             <button class="conn-btn conn-btn-danger" data-action="disconnect" data-ide="${profile.id}"><i data-ic="zap"></i> 断开</button>`
            : `<button class="conn-btn conn-btn-primary" data-action="connect" data-ide="${profile.id}"><i data-ic="plug"></i> 连接</button>
             <button class="conn-btn" data-action="guide" data-ide="${profile.id}"><i data-ic="book"></i> 指南</button>`
        }
      </div>
    `;
    container.appendChild(card);
  }

  // 绑定按钮事件
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const ideId = btn.dataset.ide;
      handleConnAction(action, ideId);
    });
  });
}

function getStatusText(status) {
  const map = {
    disconnected: "未连接",
    connecting: "连接中...",
    connected: "已连接",
    error: "连接失败",
  };
  return map[status] || status;
}

function getStatusTag(status) {
  const map = {
    disconnected: "OFFLINE",
    connecting: "CONNECTING",
    connected: "ACTIVE",
    error: "ERROR",
  };
  return map[status] || status;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

// ---- 连接操作 ----

function handleConnAction(action, ideId) {
  const profile = IDE_PROFILES.find((p) => p.id === ideId);
  if (!profile) return;

  switch (action) {
    case "connect":
      attemptConnect(profile);
      break;
    case "disconnect":
      disconnectIde(profile);
      break;
    case "reconnect":
      disconnectIde(profile);
      setTimeout(() => attemptConnect(profile), 500);
      break;
    case "guide":
      showSetupGuide(profile);
      break;
  }
}

async function attemptConnect(profile) {
  const state = connStates[profile.id];
  // 防重入/防孤儿：清掉待重连定时器，已在途连接直接返回，残留旧连接先关
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.status === "connecting") return;
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  const settings = loadConnSettings();
  let port = settings.port || profile.defaultPort;
  const timeout = settings.timeout || 5000;

  state.status = "connecting";
  state.lastError = null;
  renderConnCards();

  // G1: 取 IDE WS token（YonBan 服务端要求 ?token=，浏览器无文件系统访问 → 走后端代读端点）
  let token = "";
  try {
    // 门面 ideWsToken：回包 {token,port}；!ok 由 apiFetch 抛错走 catch（取 token 失败仍尝试连接）。
    const data = await sendAction({ verb: "ideWsToken", target: "shells:chat", source: "web" });
    token = data?.token || "";
    if (data?.port) port = data.port;
  } catch {
    // 取 token 失败仍尝试连接（旧版 YonBan 无 token 校验时可连）
  }

  try {
    // T6b 门面登记·不收：new WebSocket 是 IDE 回向通道（浏览器直连 YonBan 扩展 WS），非本体后端出向 HTTP，sendAction 门面不管辖。
    const ws = new WebSocket(wsUrl(port, profile.wsPath, token)); // T2：连接串拼接收口 config/ports.mjs wsUrl()

    const timeoutId = setTimeout(() => {
      if (state.status === "connecting") {
        ws.close();
        state.status = "error";
        state.lastError = `连接超时 (${timeout}ms)`;
        renderConnCards();
      }
    }, timeout);

    ws.onopen = () => {
      clearTimeout(timeoutId);
      state.status = "connected";
      state.sessionStart = Date.now();
      state.ws = ws;
      state.lastError = null;
      renderConnCards();
      console.log(`[ideConnPanel] ${profile.name} 已连接`);
      // 连接识别修复：浏览器连上≠后端 ideClient 连上（两条独立 WS，getPromptHandler 选 INJ 看后端那条）。
      // 踢后端立即连一次，绕开退避窗口，保证 INJ-2-code 等"需连 YonBan"的提示词被正确识别。
      sendAction({ verb: "ideConnect", target: "shells:chat", source: "web" })
        .then((d) => console.log(`[ideConnPanel] 后端 ideClient 连接态: ${d?.connected ? "已连接" : "未连接(将自动重连)"}`))
        .catch(() => { /* 后端踢连失败不影响前端 */ });
    };

    // ---- 处理来自 YonBan IDE 桥接的消息 ----
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(profile, msg);
      } catch {
        // 非 JSON 消息，忽略
      }
    };

    ws.onclose = () => {
      clearTimeout(timeoutId);
      if (state.status === "connected") {
        state.status = "disconnected";
        state.sessionStart = null;
        state.ws = null;
        renderConnCards();
        // BUG-02: dispatch断连事件供subModePanel等监听
        window.dispatchEvent(new CustomEvent("beilu:ide-disconnected", {
          detail: { profile: profile.name },
        }));

        // 自动重连（句柄存 state，手动断开/再次连接时可取消，避免重连风暴）
        if (settings.autoReconnect !== false) {
          state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; attemptConnect(profile); }, 3000);
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeoutId);
      state.status = "error";
      state.lastError = "WebSocket 连接失败";
      state.ws = null;
      renderConnCards();
    };
  } catch (err) {
    state.status = "error";
    state.lastError = err.message;
    renderConnCards();
  }
}

function disconnectIde(profile) {
  const state = connStates[profile.id];
  // 手动断开时取消待执行的自动重连，否则 3s 后会违背用户意图重连
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  state.status = "disconnected";
  state.sessionStart = null;
  renderConnCards();
  window.dispatchEvent(new CustomEvent("beilu:ide-disconnected", {
    detail: { profile: profile.name },
  }));
}

function showSetupGuide(profile) {
  if (profile.id === "cli") {
    showToast(
      "info",
      `📖 CLI 配置指南\n\n` +
        `CLI 后端随本体自动启动，无需手动操作。\n` +
        `工具集与 IDE 后端完全一致，不需要安装任何 IDE 或扩展。\n` +
        `端口 / 自动启动在下方「CLI 后端」区设置；工作区跟随文件面板。`,
    );
  } else {
    showToast(
      "info",
      `📖 ${profile.name} 配置指南\n\n` +
        `1. 找到本体目录下 yonban-vscode/ 内的 .vsix 安装包\n` +
        `2. 在 ${profile.name} 扩展面板选「从 VSIX 安装…」（Install from VSIX）选择该文件\n` +
        `3. 重启 ${profile.name}\n` +
        `4. 扩展会自动连接到 beilu (端口 ${profile.defaultPort})`,
    );
  }
}

/**
 * 把工具结果格式化成可读文本（截断防撑爆面板）。
 * @param {unknown} result
 * @returns {string}
 */
function _fmtToolResult(result) {
  if (result == null) return "(无返回)";
  let s;
  try { s = typeof result === "string" ? result : JSON.stringify(result, null, 2); }
  catch { s = String(result); }
  return s.length > 800 ? s.slice(0, 800) + "…(截断)" : s;
}

// ---- WS 消息处理 ----

/**
 * 处理从 YonBan IDE 桥接收到的 WS 消息。
 * 消息类型：hello | console | status | tool_result | pong
 */
function handleWsMessage(profile, msg) {
  switch (msg.type) {
    case "hello":
      // IDE 握手确认，更新版本信息
      if (msg.payload) {
        const p = msg.payload;
        console.log(
          `[ideConnPanel] ${profile.name} 握手成功 — 版本: ${p.extensionVersion || "?"}, 端口: ${p.port || "?"}`,
        );
        const state = connStates[profile.id];
        // [0716 识别问题修] 首连/重连事实由 producer 标注（本处唯一知道该区别）：
        //   autoReconnect 默认开（:280 断线 3s 自动重连）→ 每次网络抖动/后端重启的 hello 都会重发本事件。
        //   「重连=恢复既有连接」≠「用户新意图」——featureControls 的自动切 code 只该响应首连，
        //   否则用户手动切走（AIRP/工作）后被重连回声静默打回 IDE（凛倾 0716「从ide切换过来…识别问题」案）。
        //   判据=本页面生命周期内该 profile 是否已成功握手过（state.everConnected）。
        const _isReconnect = !!state?.everConnected;
        if (state) {
          state.ideInfo = p;
          state.everConnected = true;
        }
        // IDE连接成功 → 广播（首连时 featureControls 自动切编程模式；重连只刷新显示类订阅者）
        window.dispatchEvent(new CustomEvent("beilu:ide-connected", {
          detail: { profile: profile.name, appName: p.appName || profile.name, reconnect: _isReconnect },
        }));
      }
      break;

    case "console":
      // IDE 控制台日志 → 注入到浏览器 console（会被 backendMonitor 捕获并显示）
      if (msg.payload) {
        const entry = msg.payload;
        const prefix = `[IDE:${profile.name}]`;
        const text = `${prefix} ${entry.text || ""}`;
        switch (entry.level) {
          case "error":
            console.error(text);
            break;
          case "warn":
            console.warn(text);
            break;
          default:
            console.log(text);
            break;
        }
      }
      break;

    case "status":
      // IDE 状态快照
      if (msg.payload) {
        const s = msg.payload;
        console.log(
          `[ideConnPanel] ${profile.name} 状态: 工作区=${(s.workspaceFolders || []).length}个, 诊断=${s.diagnosticCount || 0}条, 客户端=${s.wsClients || 0}`,
        );
      }
      break;

    case "tool_result":
      // 工具执行结果（暂时只记录日志）
      if (msg.payload) {
        const r = msg.payload;
        if (r.success) {
          console.log(
            `[ideConnPanel] 工具执行成功 (id=${r.id}, ${r.duration || 0}ms)`,
          );
        } else {
          console.warn(
            `[ideConnPanel] 工具执行失败 (id=${r.id}): ${r.error || "未知错误"}`,
          );
        }
      }
      break;

    case "pong":
      // 心跳响应，不做处理
      break;

    default:
      // 未知消息类型
      break;
  }
}


/**
 * 获取指定 IDE 的连接状态。
 * @param {string} ideId
 * @returns {{ status: string, ws: WebSocket|null, ideInfo: object|null }}
 */
export function getIdeConnState(ideId) {
  return connStates[ideId] || null;
}

// ---- 渲染连接设置 ----

function renderConnSettings() {
  const container = document.getElementById("conn-settings");
  if (!container) return;

  const settings = loadConnSettings();

  container.innerHTML = `
    <div class="conn-setting-row">
      <label><i data-ic="refresh"></i> 自动重连</label>
      <input type="checkbox" class="conn-toggle" id="conn-auto-reconnect" ${settings.autoReconnect !== false ? "checked" : ""}>
    </div>
    <div class="conn-setting-row" style="margin-top:4px;">
      <span style="font-size:0.72rem;">端口:</span>
      <input type="number" class="conn-input" id="conn-port" value="${settings.port || IDE_WS_PORT}" style="width:60px;">
      <span style="font-size:0.72rem; margin-left:8px;">超时:</span>
      <input type="number" class="conn-input" id="conn-timeout" value="${settings.timeout || 5000}" style="width:60px;">
      <span style="font-size:0.6rem; opacity:0.4;">ms</span>
    </div>
  `;

  // 绑定变更事件
  container.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      const s = loadConnSettings();
      s.autoReconnect =
        document.getElementById("conn-auto-reconnect")?.checked !== false;
      s.port = parseInt(
        document.getElementById("conn-port")?.value || IDE_WS_PORT,
        10,
      );
      s.timeout = parseInt(
        document.getElementById("conn-timeout")?.value || "5000",
        10,
      );
      saveConnSettings(s);
    });
  });
}

// ---- 渲染 CLI 后端设置 ----
// 设置与管理层归本体（凛倾 2026-07-22）：值全部来自后端 getData {status,config} 单源，
// 前端零硬编码；写走 sendAction 门面（verb=setConfig/restart/stop/start → 插件 SetData）。
// status.port = 发现注册表按子进程 PID 反查的实际绑定端口（端口自增后的真值），非配置镜像。

let _cliData = null; // { status:{running,pid,port,workspace,uptime}, config:{port,autoStart,autoRestart,coexistWithYonban} }

async function _fetchCliData() {
  try {
    _cliData = await sendAction({ verb: "getData", target: "plugins:beilu-cli", source: "web" });
  } catch { /* 插件未装载/离线：保持旧值，UI 显示未运行 */ }
}

async function _cliAction(verb, payload, okMsg) {
  try {
    const d = await sendAction({ verb, target: "plugins:beilu-cli", source: "web", payload: payload || {} });
    if (d?.error) { showToast("error", `CLI ${verb} 失败: ${d.error}`); return null; }
    if (okMsg) showToast("success", okMsg);
    return d;
  } catch (e) {
    showToast("error", `CLI ${verb} 失败: ${e.message}`);
    return null;
  }
}

// CLI 单独后端显示+白盒（凛倾 0722）：日志源=beilu-cli 插件 stdout/stderr 环形缓冲（GetData.logs 尾窗 100 行），
// [wb:cli.*] 白盒行高亮。<details> open 态经 5s 重渲染保持（记内存标志）。
let _cliLogOpen = false;
function _renderCliLogBlock() {
  const logs = Array.isArray(_cliData?.logs) ? _cliData.logs : [];
  const rows = logs.map((e) => {
    const isWb = /^\[wb:cli\./.test(e.line);
    const ts = new Date(e.t).toTimeString().slice(0, 8);
    const color = e.level === "warn" ? "var(--beilu-warning,#fbbf24)" : isWb ? "var(--beilu-info,#7dd3fc)" : "inherit";
    return `<div style="color:${color};white-space:pre-wrap;word-break:break-all;">${ts} ${escapeHtml(e.line)}</div>`;
  }).join("");
  return `
    <details id="cli-log-details" ${_cliLogOpen ? "open" : ""} style="margin-top:4px;">
      <summary style="font-size:0.68rem;cursor:pointer;opacity:0.7;"><i data-ic="scroll-text"></i> CLI 后端日志 / 白盒（${logs.length} 行）</summary>
      <div style="max-height:180px;overflow-y:auto;font-family:monospace;font-size:0.6rem;line-height:1.5;background:rgba(0,0,0,0.12);border-radius:6px;padding:6px;margin-top:4px;">
        ${rows || '<div style="opacity:0.4;">暂无日志（CLI 后端未运行或刚启动）</div>'}
      </div>
    </details>`;
}

function renderCliSettings() {
  const container = document.getElementById("conn-cli-settings");
  if (!container) return;

  _fetchCliData(); // 异步刷新，下次 render（5s 周期）拿最新值

  const st = _cliData?.status || {};
  const cfg = _cliData?.config || {};
  const cliState = connStates.cli;
  const isWsConnected = cliState?.status === "connected"; // 浏览器直连 WS 态（与后端进程态是两回事）
  const running = !!st.running;

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div class="conn-setting-row">
        <span style="font-size:0.72rem;"><i data-ic="zap"></i> 后端进程</span>
        <span style="font-size:0.72rem;font-weight:600;color:${running ? "var(--beilu-success,#4ade80)" : "var(--beilu-text-muted,#888)"};">
          ${running ? `运行中${st.port ? " · 端口 " + st.port : ""}${st.pid ? " · PID " + st.pid : ""}` : "未运行"}
        </span>
      </div>
      ${isWsConnected ? `
      <div class="conn-setting-row">
        <span style="font-size:0.72rem;"><i data-ic="plug"></i> 浏览器直连</span>
        <span style="font-size:0.72rem;color:var(--beilu-success,#4ade80);">已连接</span>
      </div>` : ""}
      ${st.workspace ? `
      <div class="conn-setting-row">
        <span style="font-size:0.72rem;"><i data-ic="folder"></i> 工作区</span>
        <span style="font-size:0.65rem;opacity:0.6;font-family:monospace;word-break:break-all;">${escapeHtml(st.workspace)}</span>
      </div>
      ` : ""}
      <div class="conn-setting-row">
        <span style="font-size:0.72rem;">端口</span>
        <input type="number" class="conn-input" id="cli-port-input" value="${Number.isInteger(cfg.port) ? cfg.port : ""}" min="1" max="65535" style="width:70px;">
      </div>
      <div class="conn-setting-row">
        <label style="font-size:0.72rem;" for="cli-autostart-toggle">随本体自动启动</label>
        <input type="checkbox" class="conn-toggle" id="cli-autostart-toggle" ${cfg.autoStart !== false ? "checked" : ""}>
      </div>
      <div class="conn-setting-row">
        <label style="font-size:0.72rem;" for="cli-autorestart-toggle" title="CLI 异常退出后 1 秒自动重启；60 秒内崩溃超 3 次自动熔断，需手动重启">崩溃自动重启</label>
        <input type="checkbox" class="conn-toggle" id="cli-autorestart-toggle" ${cfg.autoRestart !== false ? "checked" : ""}>
      </div>
      <div class="conn-setting-row">
        <label style="font-size:0.72rem;" for="cli-coexist-toggle" title="开启后 CLI 与 YonBan 可同时在线并由每条对话线选择执行端；关闭后 YonBan 在线时 CLI 自动让位停机以节省资源">允许与 YonBan 并存</label>
        <input type="checkbox" class="conn-toggle" id="cli-coexist-toggle" ${cfg.coexistWithYonban !== false ? "checked" : ""}>
      </div>
      <div style="display:flex;gap:4px;margin-top:2px;">
        <button class="conn-btn conn-btn-primary" id="cli-restart-btn" style="flex:1;font-size:0.7rem;">
          <i data-ic="refresh"></i> ${running ? "重启" : "启动"}
        </button>
        <button class="conn-btn" id="cli-stop-btn" style="flex:1;font-size:0.7rem;" ${running ? "" : "disabled"}>
          <i data-ic="x"></i> 停止
        </button>
      </div>
      <div style="font-size:0.6rem;opacity:0.35;margin-top:2px;">
        工作区跟随文件面板「打开文件夹」（canonical 单源，改后自动热切）。改端口需重启 CLI 生效。
      </div>
      ${Object.keys(cfg.hintTexts || {}).length ? `
      <details style="margin-top:4px;">
        <summary style="font-size:0.68rem;cursor:pointer;opacity:0.7;"><i data-ic="message-square"></i> 工具提示文本（禁硬编码·可自定义）</summary>
        <div style="display:flex;flex-direction:column;gap:4px;padding:6px;margin-top:4px;background:oklch(var(--bc)/0.05);border-radius:6px;">
          ${Object.entries(cfg.hintTexts).map(([k, v]) =>
            `<div style="display:flex;flex-direction:column;gap:1px;">
              <label style="font-size:0.58rem;opacity:0.45;font-family:monospace;">${escapeHtml(k)}</label>
              <input class="conn-input cli-hint-input" data-hint-key="${escapeHtml(k)}" value="${escapeHtml(v)}" style="font-size:0.62rem;width:100%;">
            </div>`
          ).join("")}
          <div style="font-size:0.55rem;opacity:0.3;">改动即保存，重启 CLI 生效。留空=用内置默认值。</div>
        </div>
      </details>` : ""}
      ${_renderCliLogBlock()}
    </div>
  `;

  container.querySelector("#cli-log-details")?.addEventListener("toggle", (e) => { _cliLogOpen = e.target.open; });

  // 端口/自动启动 → setConfig 唯一写点（change 即保存；端口生效需重启，文案已示）
  container.querySelector("#cli-port-input")?.addEventListener("change", async (e) => {
    const port = parseInt(e.target.value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { showToast("error", "端口无效"); return; }
    const d = await _cliAction("setConfig", { port }, "端口已保存（重启 CLI 生效）");
    if (d?.config) _cliData = { ...(_cliData || {}), config: d.config };
  });
  container.querySelector("#cli-autostart-toggle")?.addEventListener("change", async (e) => {
    const d = await _cliAction("setConfig", { autoStart: !!e.target.checked }, "自动启动设置已保存");
    if (d?.config) _cliData = { ...(_cliData || {}), config: d.config };
  });
  container.querySelector("#cli-autorestart-toggle")?.addEventListener("change", async (e) => {
    const d = await _cliAction("setConfig", { autoRestart: !!e.target.checked }, "崩溃自动重启设置已保存（重启 CLI 生效）");
    if (d?.config) _cliData = { ...(_cliData || {}), config: d.config };
  });
  container.querySelector("#cli-coexist-toggle")?.addEventListener("change", async (e) => {
    const coexistWithYonban = !!e.target.checked;
    const d = await _cliAction(
      "setConfig",
      { coexistWithYonban },
      coexistWithYonban ? "CLI 与 YonBan 并存已开启" : "CLI 与 YonBan 互斥已开启（YonBan 在线时 CLI 自动让位）",
    );
    if (d?.config) _cliData = { ...(_cliData || {}), config: d.config };
  });

  // [0723] 提示文本编辑 → setConfig 唯一写点（禁硬编码,用户可自定义;每个 hint 独立 change 保存,重启 CLI 生效）
  //   走 saveConfig 的 hintTexts merge 校验(只接受 string),config→env→hints.mjs 读取的既有链路。
  container.querySelectorAll(".cli-hint-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const key = e.target.dataset.hintKey;
      if (!key) return;
      const d = await _cliAction("setConfig", { hintTexts: { [key]: e.target.value } }, `提示「${key}」已保存（重启 CLI 生效）`);
      if (d?.config) _cliData = { ...(_cliData || {}), config: d.config };
    });
  });

  container.querySelector("#cli-restart-btn")?.addEventListener("click", async () => {
    const d = await _cliAction(running ? "restart" : "start", {}, null);
    if (d) showToast("success", `CLI 后端${d.started ? "已启动" : d.already ? "已在运行" : "请求已发送"}`);
    setTimeout(async () => { await _fetchCliData(); renderCliSettings(); }, 2000);
  });

  container.querySelector("#cli-stop-btn")?.addEventListener("click", async () => {
    const d = await _cliAction("stop", {}, null);
    if (d) showToast("info", "CLI 后端已停止");
    if (cliState) { cliState.status = "disconnected"; cliState.ws = null; }
    renderConnCards();
    setTimeout(async () => { await _fetchCliData(); renderCliSettings(); }, 1000);
  });
}

// ---- 渲染运行时状态 ----

function formatTokenK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function renderRuntime() {
  const container = document.getElementById("conn-runtime");
  if (!container) return;

  const mode = getCurrentMode();

  // 获取 token 信息：直接取 tokenProgressBar 的状态源。
  // Drift 修复：原 `document.querySelector(".token-display")` 选错类名
  // （真实元素是 #token-progress-text / .token-progress-text），永远命中 null
  // → 运行时面板「上下文 Token」永久显示「—」，即使有真实用量。
  let tokenText = "—";
  try {
    const info = getTokenInfo();
    if (info.maxContext > 0) {
      const pct = (info.ratio * 100).toFixed(1);
      tokenText = `${formatTokenK(info.tokens)} / ${formatTokenK(info.maxContext)} (${pct}%)`;
    }
  } catch {
    /* 取不到时退化为占位 */
  }

  const items = [
    {
      label: "当前模式",
      value:
        mode === "code" ? '<i data-ic="code"></i> 编程' : mode === "work" ? '<i data-ic="clipboard"></i> 工作' : '<i data-ic="message"></i> 聊天',
      color:
        "var(--beilu-amber)",
    },
    { label: "上下文 Token", value: tokenText },
  ];

  container.innerHTML = items
    .map(
      (item) => `
    <div class="conn-runtime-row">
      <span class="conn-runtime-label">${item.label}</span>
      <span class="conn-runtime-value" ${item.color ? `style="color:${item.color}"` : ""}>${item.value}</span>
    </div>
  `,
    )
    .join("");
}

// ---- 渲染已加载插件列表 ----

function renderPlugins() {
  const container = document.getElementById("conn-plugins");
  if (!container) return;

  // 硬编码已知插件（动态获取作为增强）
  const knownPlugins = [
    { name: "beilu-preset", icon: '<i data-ic="clipboard"></i>', status: "running" },
    { name: "beilu-files", icon: '<i data-ic="folder"></i>', status: "running" },
    { name: "beilu-memory", icon: '<i data-ic="brain"></i>', status: "running" },
  ];

  container.innerHTML = knownPlugins
    .map(
      (p) => `
    <div class="conn-plugin-row">
      <span class="conn-plugin-icon">${p.icon}</span>
      <span class="conn-plugin-name">${p.name}</span>
      <span class="conn-plugin-tag conn-plugin-tag-${p.status}">${p.status === "running" ? "运行中" : "待机"}</span>
    </div>
  `,
    )
    .join("");
}

// ---- 渲染手动工具调用表单（M11：前端主动发 IDE 工具调用）----

// 2026-07-09 收口审计（D4）：工具下拉改拉后端单源（GET ide/tool-list ← ideClient.availableTools，
//   原硬编码 20 个落后实际工具集）。本静态清单降级为离线/后端旧版兜底，拉取成功即被替换。
let _TOOLCALL_TOOLS = [
  "read_file", "write_file", "list_files", "run_command", "get_diagnostics",
  "get_status", "search_files", "search_by_name", "replace_lines", "insert_at_line",
  "fuzzy_edit", "todo_read", "todo_write", "goto_definition", "find_references",
  "get_project_summary", "ast_search", "smart_search", "validate_html", "lint_code",
];
// 拉取时机=initIdeConnPanel（面板初始化，已登录语境）。原为模块顶层 IIFE——本模块被 layout.mjs 静态
//   import=页面加载即发请求，登录态未就绪时 401 会走 sendAction 统一报错面弹窗（07-09 传导链追踪抓出挪位）。
let _toolListFetched = false;
async function _fetchToolList() {
  if (_toolListFetched) return;
  _toolListFetched = true;
  try {
    const d = await sendAction({ verb: "ideToolList", target: "shells:chat", source: "web" });
    if (Array.isArray(d?.tools) && d.tools.length) {
      _TOOLCALL_TOOLS = d.tools;
      renderToolCallForm(); // 表单若已渲染，用真实清单重渲；未渲染则 getElementById miss 自然跳过
    }
  } catch { _toolListFetched = false; /* 离线/后端旧版：保留静态兜底，下次 init 重试（sendAction 已统一报错面） */ }
}

function renderToolCallForm() {
  const container = document.getElementById("conn-toolcall");
  if (!container) return;

  // 只列出已连接的 IDE
  const connectedIds = Object.keys(connStates).filter(
    (id) => connStates[id]?.status === "connected",
  );

  if (connectedIds.length === 0) {
    container.innerHTML = `<div style="font-size:0.68rem;opacity:0.4;padding:4px 0;">无已连接 IDE，连接后可手动发工具调用</div>`;
    return;
  }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <select id="conn-tc-ide" class="conn-input" style="font-size:0.72rem;">
        ${connectedIds.map((id) => `<option value="${id}">${id}</option>`).join("")}
      </select>
      <select id="conn-tc-tool" class="conn-input" style="font-size:0.72rem;">
        ${_TOOLCALL_TOOLS.map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <textarea id="conn-tc-params" class="conn-input" rows="2" placeholder='参数 JSON，如 {"path":"src/index.ts"}' style="font-size:0.7rem;font-family:monospace;resize:vertical;"></textarea>
      <button id="conn-tc-send" class="btn btn-xs btn-outline">发送工具调用</button>
      <div id="conn-tc-result" style="font-size:0.66rem;opacity:0.7;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;"></div>
    </div>
  `;

  const resultEl = container.querySelector("#conn-tc-result");
  container.querySelector("#conn-tc-send")?.addEventListener("click", async () => {
    const tool = container.querySelector("#conn-tc-tool")?.value;
    const raw = (container.querySelector("#conn-tc-params")?.value || "").trim();
    let params = {};
    if (raw) {
      try {
        params = JSON.parse(raw);
      } catch (e) {
        if (resultEl) resultEl.textContent = `❌ 参数 JSON 解析失败: ${e.message}`;
        return;
      }
    }
    if (!currentChatId) {
      if (resultEl) resultEl.textContent = "❌ 无当前会话，无法执行";
      return;
    }
    // D-4 路B：改走后端 ideClient（统一执行闸），结果作 _hidden 条目接入对话（仅你折叠可见、不喂 AI）。
    if (resultEl) resultEl.textContent = `⏳ 执行 ${tool} 中…`;
    try {
      // 门面 ideManualToolCall：body {chatid,tool,params}；桥回包 {ok,result}，!ok 由 apiFetch 抛错走 catch。
      const data = await sendAction({ verb: "ideManualToolCall", target: "shells:chat", source: "web", payload: { chatid: currentChatId, tool, params } });
      const ok = !!data?.ok;
      if (resultEl) {
        resultEl.textContent = ok
          ? `✅ ${tool} 成功（结果已折叠进对话，仅你可见、不喂 AI）\n${_fmtToolResult(data.result?.result)}`
          : `❌ ${tool} 失败：${data.result?.error || data.error || "未知错误"}`;
      }
      showToast(ok ? "success" : "error", `IDE 工具 ${tool}：${ok ? "成功" : "失败"}`);
    } catch (e) {
      if (resultEl) resultEl.textContent = `❌ 请求失败：${e.message}`;
    }
  });
}

// ---- 初始化 ----

export function initIdeConnPanel() {
  renderConnCards();
  renderIdeInstances(); // 多开：后端连接池真实在线实例（与上方手动连接卡不同源）
  renderConnSettings();
  renderCliSettings();
  renderRuntime();
  renderPlugins();
  renderToolCallForm();
  _fetchToolList();

  // 定期刷新运行时状态
  setInterval(() => {
    // 只在面板可见时刷新
    const panel = document.getElementById("ide-panel-connections");
    if (panel && !panel.classList.contains("hidden")) {
      renderRuntime();
      renderConnCards();
      renderIdeInstances(); // 新窗口上线/关闭最多 5s 反映到面板（后端重扫 15s 是另一层）
      renderCliSettings();
      renderToolCallForm();
    }
  }, 5000);

  // 监听模式切换
  window.addEventListener("beilu:mode-switched", () => {
    renderRuntime();
  });
}

/**
 * mcpPanel.mjs — MCP Server 管理面板（含命令型批准安全闸）
 *
 * 功能链：
 *   initMcpPanel() → GET /api/parts/shells:chat/:chatid/plugins → 渲染 MCP 插件列表
 *   → _loadMcpApprovalMap() → GET /api/security/mcp-servers（仅命令型）→ _mcpApprovalMap
 *   → 每个 Server 显示名称/状态/描述 + 命令型批准开关
 *   → 展开 → GET /api/parts/plugins:${name}/config/getdata → 工具详情（_pluginDetailsCache 缓存）
 *   → 添加新 Server → JSON 配置导入 → POST 插件 API
 *   → 移除 → beiluConfirm 确认 → shells:chat#removePlugin（仅从当前聊天移除，per-chat 语义；
 *     无卸载 server 入口——插件目录/defaultParts 保留是现状缺口非本面板职责，0716 链路走查记档）
 *   → 命令型批准开关 → POST /api/security/mcp-approve { approved } → 重启服务生效
 *   → 测试工具调用 → POST 插件 config API
 *
 * why（SEC-MCP）：
 *   命令型（stdio）MCP server 会 spawn 宿主进程（导入恶意配置 = RCE），默认拦截；
 *   后端 spawn 闸：config.command && _mcpApproved!==true → 不 spawn；
 *   批准入口归口本面板（用户实际管理 MCP 处），不混进「安全中心」概览；
 *   工具详情按插件名缓存（_pluginDetailsCache），避免反复展开重复请求后端。
 *
 * 关联链：
 *   ← layout.mjs / IDE 面板（initMcpPanel 调用）
 *   → /api/parts/shells:chat/:chatid/plugins（插件列表）
 *   → /api/parts/plugins:${name}/config/getdata（插件工具详情）
 *   → /api/security/mcp-servers（命令型批准态读取）
 *   → /api/security/mcp-approve（命令型批准写入）
 *   → beiluDialog.mjs（beiluConfirm：移除确认）
 *
 * 影响范围：
 *   当前对话加载的 MCP 插件集合（增删影响 AI 可用工具）；
 *   命令型 MCP 批准态影响后端是否 spawn 进程（安全关键）；
 *   DOM：IDE 面板内 MCP Server 列表区块。
 *
 * 使用效果：
 *   可视化管理当前对话的 MCP Server；命令型 Server 需手动批准后才能执行；
 *   展开查看各工具参数并可直接测试调用。
 */

import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（server:security/shells:chat/plugins:_dynamic 动态插件名）
import { showToast } from "../../../../../../scripts/toast.mjs";
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";

/** 缓存的插件详情 */
const _pluginDetailsCache = new Map();

/**
 * SEC-MCP：命令型 (stdio) MCP server 的批准态。
 * 命令型 MCP 会 spawn 宿主进程执行命令（导入恶意配置 = RCE），后端 spawn 闸
 * （ImportHandlers/MCP/Template/main.mjs：config.command && _mcpApproved!==true → 不 spawn）
 * 默认拦下，需 owner 批准。后端就绪：
 *   - 读：GET /api/security/mcp-servers → { servers:[{pluginName, name, command, args, approved}] }（仅命令型）。
 *   - 写：POST /api/security/mcp-approve { pluginName, approved }（置 data._mcpApproved + 重启服务生效）。
 * 命令型逐个批准开关归口本面板（用户实际管理 MCP 处），不再混进「安全中心」概览。
 * @type {Map<string, {approved:boolean, command:string, args:string[]}>}  键=插件名(mcp_*)
 */
let _mcpApprovalMap = new Map();

/**
 * 拉取命令型 MCP 批准态（专用端点，仅返回命令型）。
 * 失败静默：批准信息拿不到不影响 MCP 列表本身渲染。
 * @returns {Promise<void>}
 */
async function _loadMcpApprovalMap() {
  try {
    // T6b：raw+手 res.ok 语义并入门面（!ok → 抛错→catch 静默，同原 !ok return 语义）
    const data = await sendAction({ verb: "getMcpServers", target: "server:security", source: "web" });
    const next = new Map();
    for (const s of Array.isArray(data?.servers) ? data.servers : []) {
      if (!s?.pluginName) continue;
      next.set(s.pluginName, {
        approved: s.approved === true,
        command: s.command || "",
        args: Array.isArray(s.args) ? s.args : [],
      });
    }
    _mcpApprovalMap = next;
  } catch (_) {
    /* 批准态不可用不影响列表 */
  }
}

/**
 * 初始化 MCP 面板
 * @param {string} containerId - 面板容器DOM id
 */
export async function initMcpPanel(containerId, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // [0727] 宿主已有标题时不再自带一个（work 侧栏统一标题栏已写 "MCP Servers"，
  //   本模块再渲一个 h3 = 同一个标题嵌套显示两遍，凛倾 0727 截图实证）。
  //   刷新按钮保留：它是本面板的功能，不属于宿主标题栏。
  const _showTitle = opts.showTitle !== false;

  container.innerHTML = `
    <div class="mcp-panel-header">
      ${_showTitle ? "<h3>MCP Servers</h3>" : "<span></span>"}
      <button class="mcp-refresh-btn" title="刷新列表"><i data-ic="refresh"></i></button>
    </div>
    <div class="mcp-connect-request-section" style="margin-bottom:10px;">
      <div style="font-size:0.78rem;font-weight:600;margin-bottom:5px;">AI 提出的接入请求</div>
      <div id="${containerId}-request-list">
        <div class="mcp-loading">加载中...</div>
      </div>
    </div>
    <div class="mcp-server-list" id="${containerId}-list">
      <div class="mcp-loading">加载中...</div>
    </div>
    <div class="mcp-panel-footer">
      <button class="mcp-add-btn" title="添加MCP Server">+ 添加 Server</button>
    </div>

    <!-- 环境工具管理 (IDE-T3: 默认展开 + 标题加图标) -->
    <div class="envtools-section" style="margin-top:12px; border-top:2px solid oklch(var(--p) / 0.3); padding-top:12px;">
      <div class="mcp-panel-header" style="cursor:pointer; background:oklch(var(--p) / 0.05); padding:6px 8px; border-radius:6px;" id="${containerId}-envtools-toggle">
        <h3 style="font-size:0.95rem; font-weight:600; color: oklch(var(--p));"><i data-ic="wrench"></i> 环境工具</h3>
        <span class="mcp-server-chevron" id="${containerId}-envtools-chevron">▾</span>
      </div>
      <div id="${containerId}-envtools-body" style="padding:0 8px;">
        <!-- [上线引导 0727] 可见引导行+行级 title(参照 ST 原生 title 模式;i18n 覆盖式对 title 属性有效,
             文案键在 locales/*.json 九语言)。此前两个标签零说明+首屏不加载=用户误以为必须手动添加。 -->
        <p style="font-size:0.68rem; margin:2px 0 8px;" class="opacity-60">本区自动检测本机命令行工具并告知 AI;下方两项为可选的进阶配置,一般保持默认即可</p>
        <div id="${containerId}-envtools-detected" style="margin-bottom:8px;"></div>
        <div style="margin-bottom:8px;" title="让检测额外扫描这些目录里的工具(如项目 node_modules);结果并入上方检测列表;通常无需手动添加">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <span style="font-size:0.75rem; font-weight:600; cursor:help;">扫描目录</span>
            <button class="mcp-btn" style="font-size:0.7rem; padding:2px 8px;" id="${containerId}-envtools-add-dir">+ 添加</button>
          </div>
          <div id="${containerId}-envtools-dirs"></div>
        </div>
        <div style="margin-bottom:8px;" title="为某个工具补一句用途说明,随工具清单发给 AI,帮助它正确使用;通常无需手动添加">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <span style="font-size:0.75rem; font-weight:600; cursor:help;">工具说明</span>
            <button class="mcp-btn" style="font-size:0.7rem; padding:2px 8px;" id="${containerId}-envtools-add-desc">+ 添加</button>
          </div>
          <div id="${containerId}-envtools-descs"></div>
        </div>
        <button class="mcp-btn mcp-btn-confirm" style="width:100%; font-size:0.75rem; padding:4px 0;" id="${containerId}-envtools-save">保存</button>
        <div id="${containerId}-envtools-status" style="font-size:0.7rem; text-align:center; margin-top:4px; min-height:1em;"></div>
      </div>
    </div>
  `;

  // 绑定刷新按钮
  container
    .querySelector(".mcp-refresh-btn")
    ?.addEventListener("click", () => {
      _pluginDetailsCache.clear();
      _refreshMcpPanel(containerId);
    });

  // 绑定添加按钮
  container
    .querySelector(".mcp-add-btn")
    ?.addEventListener("click", () => showAddServerDialog(containerId));

  _mcpContainers.add(containerId);

  // 初次加载
  await _refreshMcpPanel(containerId);

  // Drift 修复：MCP 列表依赖当前 chatId（hash），但此前只在 init/手动刷新/增删后加载。
  // 切会话(hashchange)时列表残留旧 chat 的 MCP；或 init 时尚无 chat → 永久停在"请先打开聊天"。
  // 监听 hashchange，chatId 真变化才重载（防抖守卫避免重复拉取）。
  if (!_mcpHashListenerBound) {
    _mcpHashListenerBound = true;
    _mcpLastChatId = getCurrentChatId();
    window.addEventListener("hashchange", () => {
      const newId = getCurrentChatId();
      if (newId === _mcpLastChatId) return;
      _mcpLastChatId = newId;
      _pluginDetailsCache.clear();
      // 多实例（ide/work 各一容器）：重载所有仍在 DOM 中的已注册容器
      for (const cid of _mcpContainers) {
        if (document.getElementById(cid)) _refreshMcpPanel(cid);
      }
    });
  }
  if (!_mcpRequestListenerBound) {
    _mcpRequestListenerBound = true;
    window.addEventListener("beilu:mcp-connect-requests-changed", (event) => {
      const changedChatId = event?.detail?.chatId || "";
      const activeChatId = getCurrentChatId() || "";
      if (changedChatId && changedChatId !== activeChatId) return;
      for (const cid of _mcpContainers) {
        if (document.getElementById(cid)) loadMcpConnectRequests(cid);
      }
    });
  }

  // 环境工具面板
  _initEnvToolsPanel(containerId);
}

/** hashchange 监听只绑定一次（initMcpPanel 可能被重复调用）；容器集支撑 ide/work 多实例 */
let _mcpHashListenerBound = false;
let _mcpRequestListenerBound = false;
let _mcpLastChatId = null;
const _mcpContainers = new Set();

async function _refreshMcpPanel(containerId) {
  await Promise.all([
    loadMcpConnectRequests(containerId),
    loadMcpServers(containerId),
  ]);
}

/**
 * 获取当前聊天 ID（从多个来源尝试）
 * @returns {string|null}
 */
function getCurrentChatId() {
  // 项目用 hash 路由存 chatid。补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，
  //   内含 _CHATID_RE 校验）——非法 hash 返 "" 走下方 endpoints 回退，不裸读 substring 当 chatid。
  //   对齐 cardsPanel.mjs:62/idePanel.mjs:109 范式。
  const hash = window._beiluGetChatId?.() || "";
  if (hash) return hash;
  // 尝试从 endpoints.mjs 的导出变量获取
  try {
    const ep = document.querySelector('[data-current-chatid]');
    if (ep?.dataset.currentChatid) return ep.dataset.currentChatid;
  } catch (_) { /* ignore */ }
  return null;
}

const _requestLoadGen = new Map();

function _requestStatusLabel(status) {
  return {
    pending: "待审查",
    importing: "导入处理中",
    imported: "已导入",
    import_failed: "导入失败",
    dismissed: "已忽略",
  }[status] || String(status || "未知");
}

function _requestPrefillText(request) {
  if (request?.normalizedConfig) return JSON.stringify(request.normalizedConfig, null, 2);
  if (typeof request?.requestText === "string") return request.requestText;
  return JSON.stringify(request?.requestConfig ?? null, null, 2);
}

function _requestServerSummary(request) {
  const servers = request?.normalizedConfig?.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const names = Object.keys(servers);
    if (names.length) return names.join("、");
  }
  return "未识别配置";
}

function _requestRuntimeHtml(request, runtimes, runtimeError) {
  if (request?.status !== "imported") return "";
  const names = Object.keys(request?.normalizedConfig?.mcpServers || {});
  if (runtimeError) {
    return `<div class="mcp-error" style="font-size:0.68rem;margin-top:5px;">运行态读取失败: ${escapeHtml(runtimeError)}</div>`;
  }
  return names.map((name) => {
    const runtime = runtimes.find((entry) =>
      entry?.name === name || String(entry?.key || "").endsWith(`:${name}`));
    let label = "已导入，尚无运行实例";
    if (runtime?.connected) label = `已连接 · ${runtime.toolCount || 0} 个工具`;
    else if (runtime?.error) label = `连接异常 · ${runtime.error}`;
    else if (runtime?.configured && runtime?.approved === false) label = "已配置，等待用户批准";
    else if (runtime?.configured && runtime?.approved) label = "已批准，尚未连接";
    else if (runtime) label = "运行实例尚未完成配置";
    return `
      <div class="mcp-hint" style="display:flex;align-items:center;gap:5px;font-size:0.68rem;margin-top:4px;">
        <span class="mcp-status-dot ${runtime?.connected ? "connected" : "pending"}"></span>
        <span>${escapeHtml(name)}：${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");
}

async function loadMcpConnectRequests(containerId) {
  const listEl = document.getElementById(`${containerId}-request-list`);
  if (!listEl) return;
  const chatId = getCurrentChatId();
  const generation = (_requestLoadGen.get(containerId) || 0) + 1;
  _requestLoadGen.set(containerId, generation);

  if (!chatId) {
    listEl.innerHTML = '<div class="mcp-empty"><p class="mcp-hint">打开聊天后可查看该聊天的 AI 接入请求</p></div>';
    return;
  }
  listEl.innerHTML = '<div class="mcp-loading">加载中...</div>';
  try {
    const result = await sendAction({
      verb: "getMcpConnectRequests",
      target: "plugins:beilu-memory",
      source: "web",
      scope: { chatId },
      payload: { chatId },
    });
    if (getCurrentChatId() !== chatId) {
      if (_requestLoadGen.get(containerId) !== generation) return;
      return void loadMcpConnectRequests(containerId);
    }
    if (_requestLoadGen.get(containerId) !== generation) return;
    if (!result?.success) throw new Error(result?.error || "读取请求失败");
    const requests = Array.isArray(result.requests) ? result.requests : [];
    let runtimes = [];
    let runtimeError = "";
    try {
      const runtimeResult = await sendAction({
        verb: "getSystemRuntimeSnapshot",
        target: "plugins:beilu-memory",
        source: "web",
        scope: { chatId },
        payload: { chatId },
      });
      if (runtimeResult?.success === false) {
        throw new Error(runtimeResult.error || "MCP 运行态读取失败");
      }
      if (!Array.isArray(runtimeResult?.mcp)) {
        throw new Error("后端未返回 MCP 运行态列表");
      }
      runtimes = Array.isArray(runtimeResult?.mcp) ? runtimeResult.mcp : [];
    } catch (error) {
      runtimeError = String(error?.message || error || "未知错误");
    }
    if (getCurrentChatId() !== chatId || _requestLoadGen.get(containerId) !== generation) return;
    if (requests.length === 0) {
      listEl.innerHTML = '<div class="mcp-empty"><p class="mcp-hint">当前聊天没有 AI 提出的 MCP 接入请求</p></div>';
      return;
    }

    listEl.innerHTML = requests.map((request) => {
      const canReview = request.status === "pending" || request.status === "import_failed";
      const canDismiss = canReview;
      const errorText = request.importError || request.validationError || "";
      const requestedAt = request.requestedAt
        ? new Date(request.requestedAt).toLocaleString()
        : "";
      return `
        <div class="mcp-server-card" data-mcp-request="${escapeAttr(request.requestId)}"
          style="padding:8px;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="mcp-status-dot pending"></span>
            <strong style="font-size:0.78rem;flex:1;">${escapeHtml(_requestServerSummary(request))}</strong>
            <span class="mcp-tag">${escapeHtml(_requestStatusLabel(request.status))}</span>
          </div>
          <div class="mcp-hint" style="font-size:0.68rem;margin-top:4px;">
            ${escapeHtml(requestedAt)} · ${escapeHtml(request.source || "ai:mcpConnect")}
          </div>
          ${_requestRuntimeHtml(request, runtimes, runtimeError)}
          ${errorText ? `<div class="mcp-error" style="margin-top:5px;">${escapeHtml(errorText)}</div>` : ""}
          <details style="margin-top:5px;">
            <summary style="cursor:pointer;font-size:0.7rem;">查看原请求</summary>
            <pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:0.68rem;margin:4px 0 0;">${escapeHtml(request.requestText || JSON.stringify(request.requestConfig ?? null, null, 2))}</pre>
          </details>
          <div class="mcp-request-action-error mcp-error hidden" style="margin-top:5px;"></div>
          <div style="display:flex;gap:6px;margin-top:7px;">
            ${canReview ? `<button class="mcp-btn mcp-btn-confirm" data-request-review="${escapeAttr(request.requestId)}">审查并导入</button>` : ""}
            ${canDismiss ? `<button class="mcp-btn mcp-btn-remove" data-request-dismiss="${escapeAttr(request.requestId)}">忽略请求</button>` : ""}
            ${request.status === "importing" ? '<button class="mcp-btn" disabled>导入处理中</button>' : ""}
          </div>
        </div>
      `;
    }).join("");

    const byId = new Map(requests.map((request) => [request.requestId, request]));
    listEl.querySelectorAll("[data-request-review]").forEach((button) => {
      button.addEventListener("click", () => {
        const request = byId.get(button.dataset.requestReview);
        if (!request || request.chatId !== getCurrentChatId()) return;
        showAddServerDialog(containerId, {
          request,
          chatId: request.chatId,
          prefillText: _requestPrefillText(request),
        });
      });
    });
    listEl.querySelectorAll("[data-request-dismiss]").forEach((button) => {
      button.addEventListener("click", async () => {
        const request = byId.get(button.dataset.requestDismiss);
        if (!request || request.chatId !== getCurrentChatId()) return;
        const card = button.closest("[data-mcp-request]");
        const errorEl = card?.querySelector(".mcp-request-action-error");
        button.disabled = true;
        try {
          const result = await sendAction({
            verb: "dismissMcpConnectRequest",
            target: "plugins:beilu-memory",
            source: "web",
            scope: { chatId: request.chatId },
            payload: { requestId: request.requestId, chatId: request.chatId },
          });
          if (!result?.success) throw new Error(result?.error || "忽略请求失败");
          await loadMcpConnectRequests(containerId);
        } catch (error) {
          if (errorEl) {
            errorEl.textContent = error.message;
            errorEl.classList.remove("hidden");
          }
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    if (_requestLoadGen.get(containerId) !== generation) return;
    listEl.innerHTML = `<div class="mcp-error">接入请求加载失败: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * 加载 MCP Server 列表
 * @param {string} containerId - 面板容器DOM id
 */
/** 每容器的加载代号（同 chat.mjs _switchGen 范式）：并发/自愈重跑时只有最新一轮能写界面 */
const _loadGen = new Map();

async function loadMcpServers(containerId) {
  const listEl = document.getElementById(`${containerId}-list`);
  if (!listEl) return;

  const _gen = (_loadGen.get(containerId) || 0) + 1;
  _loadGen.set(containerId, _gen);

  const chatId = getCurrentChatId();
  if (!chatId) {
    listEl.innerHTML = `
      <div class="mcp-empty">
        <p>请先打开一个聊天</p>
        <p class="mcp-hint">MCP 插件列表依赖当前聊天上下文</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '<div class="mcp-loading">加载中...</div>';

  // SEC-MCP：先拉命令型 MCP 批准态，供卡片状态点 + 详情批准控件使用（失败静默）。
  await _loadMcpApprovalMap();

  try {
    // T6b：走 shells:chat#getChatPlugins（HTTP !ok → 门面抛错走 catch）
    const plugins = await sendAction({ verb: "getChatPlugins", target: "shells:chat", source: "web", scope: { chatId } });
    // [0717 async-order guard, audit H5] A->B->A chat switching: the dedupe in the
    // hashchange listener only blocks identical consecutive ids, so a slow response for
    // an older chat can land after the user returned - compare the live chat id and drop.
    // [0727 修·凛倾实测"work 的 MCP 永远加载中"] 原来这里裸 `return`：请求期间 hash 变了就
    //   静默丢弃**且不重来**，列表永久钉死在"加载中"，既不重试也不报错。而切到 work 模式时
    //   恰恰必然换 hash（各模式记各自的对话，layout._restoreModeChatId），于是必现。
    //   正解：丢弃旧响应的同时按新 id 自愈重跑；已有更新的加载在跑时才纯丢弃（界面归它管，防重入打架）。
    if (getCurrentChatId() !== chatId) {
      if (_loadGen.get(containerId) !== _gen) return; // 有更新的一轮在跑，本轮作废
      return void loadMcpServers(containerId);
    }
    if (_loadGen.get(containerId) !== _gen) return; // 同上：本轮已被更新的加载取代
    const mcpPlugins = (Array.isArray(plugins) ? plugins : []).filter((p) => {
      const name = (
        typeof p === "string" ? p : p.name || p.info?.name || ""
      ).toLowerCase();
      return name.includes("mcp");
    });

    if (mcpPlugins.length === 0) {
      listEl.innerHTML = `
        <div class="mcp-empty">
          <p>当前聊天暂无 MCP Server</p>
          <p class="mcp-hint">点击下方"+ 添加 Server"导入 MCP 配置，<br>或通过 beilu 的 MCP 导入器添加</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    for (const plugin of mcpPlugins) {
      const name =
        typeof plugin === "string"
          ? plugin
          : plugin.name || plugin.info?.name || "未知";
      const card = createServerCard(name, containerId);
      listEl.appendChild(card);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="mcp-error">加载失败: ${escapeHtml(err.message)}</div>`;
    console.warn("[mcpPanel] 加载MCP列表失败:", err.message);
  }
}

/**
 * 创建单个 Server 卡片
 * @param {string} pluginName - 插件名
 * @param {string} containerId - 面板容器 ID
 * @returns {HTMLElement}
 */
function createServerCard(pluginName, containerId) {
  const safeName = escapeAttr(pluginName);
  const displayName = pluginName.replace(/^mcp_/, "");

  const card = document.createElement("div");
  card.className = "mcp-server-card";
  card.dataset.plugin = safeName;

  // SEC-MCP：命令型未批准 → 黄点(被 spawn 闸拦下，不会启动)；已批准/url 型/非命令型 → 绿点。
  const _appr = _mcpApprovalMap.get(pluginName);
  const _needsApproval = !!_appr; // 仅命令型会出现在批准表中
  const _approved = _appr?.approved === true;
  const _dotClass = _needsApproval && !_approved ? "pending" : "connected";
  const _dotTitle = !_needsApproval
    ? "已加载"
    : _approved
      ? "已批准 · 会启动"
      : "未批准 · 不会启动";
  const _pendingBadge =
    _needsApproval && !_approved
      ? ` <span class="mcp-tag" style="background:var(--beilu-amber-15);color:var(--beilu-amber);">待批准</span>`
      : "";

  card.innerHTML = `
    <div class="mcp-server-header" data-expand="${safeName}">
      <span class="mcp-status-dot ${_dotClass}" title="${escapeAttr(_dotTitle)}"></span>
      <span class="mcp-server-name">${escapeHtml(displayName)}${_pendingBadge}</span>
      <span class="mcp-server-chevron">▸</span>
    </div>
    <div class="mcp-server-details hidden" id="mcp-details-${safeName}">
      <div class="mcp-details-loading">加载工具信息...</div>
    </div>
  `;

  // 展开/折叠 + 懒加载详情
  const header = card.querySelector("[data-expand]");
  header.addEventListener("click", async () => {
    const details = card.querySelector(".mcp-server-details");
    const chevron = header.querySelector(".mcp-server-chevron");
    const isHidden = details.classList.contains("hidden");

    details.classList.toggle("hidden");
    chevron.textContent = isHidden ? "▾" : "▸";

    // 首次展开时加载详情
    if (isHidden && !details.dataset.loaded) {
      await loadPluginDetails(pluginName, details, containerId);
      details.dataset.loaded = "true";
    }
  });

  return card;
}

/**
 * SEC-MCP：构建命令型 MCP 批准控件 HTML（仅命令型出现在批准表 _mcpApprovalMap 中）。
 *   只依赖 _mcpApprovalMap（来自 /api/security/status），不依赖 config/getdata —— 故即便
 *   mcp_X 的 config/getdata 拉取失败（部分 MCP 插件未注册该路由），批准控件仍可渲染/操作。
 * @param {string} pluginName - 插件名（mcp_*）
 * @param {object} [config] - 插件 config（可选，用于展示将执行的命令；拿不到则省略命令行）
 * @returns {string} 批准控件 HTML（非命令型 / 不在批准表 → 返回空串）
 */
function _approvalBlockHtml(pluginName, config = {}) {
  const _appr = _mcpApprovalMap.get(pluginName);
  if (!_appr) return "";
  if (_appr.approved) {
    return `
      <div class="mcp-approval approved">
        <div class="mcp-appr-ttl">✓ 已批准 · 可启动</div>
        <div class="mcp-appr-sub">已 owner 批准，服务（重）启动时会 spawn 宿主进程并加载其工具。</div>
        <button class="mcp-btn mcp-btn-remove mcp-btn-revoke" data-plugin="${escapeAttr(pluginName)}">撤销批准</button>
      </div>`;
  }
  // 命令行优先用详情 config，拿不到（config/getdata 404）则回退批准表自带的 command/args
  const _cmd = config?.command || _appr.command || "";
  const _args = Array.isArray(config?.args) && config.args.length
    ? config.args
    : Array.isArray(_appr.args)
      ? _appr.args
      : [];
  const _cmdLine = _cmd
    ? `${_cmd}${_args.length ? " " + _args.join(" ") : ""}`
    : "";
  return `
      <div class="mcp-approval blocked">
        <div class="mcp-appr-ttl"><i data-ic="warning"></i> 未批准 · 不会启动</div>
        <div class="mcp-appr-sub">命令型 (stdio) server 会 spawn 本机进程执行命令。安全默认不启动（工具列表为空），需 owner 批准。${_cmdLine ? `<br>将执行：<code>${escapeHtml(_cmdLine)}</code>` : ""}</div>
        <button class="mcp-btn mcp-btn-confirm mcp-btn-approve" data-plugin="${escapeAttr(pluginName)}">✓ 批准启动</button>
      </div>`;
}

/**
 * SEC-MCP：绑定批准 / 撤销按钮（try / catch 两条渲染路径共用）。
 * @param {HTMLElement} detailsEl - 详情容器
 * @param {string} pluginName - 插件名
 * @param {string} containerId - 面板容器 ID
 */
function _bindApprovalButtons(detailsEl, pluginName, containerId) {
  detailsEl
    .querySelector(".mcp-btn-approve")
    ?.addEventListener("click", () =>
      _setMcpApproval(pluginName, true, containerId),
    );
  detailsEl
    .querySelector(".mcp-btn-revoke")
    ?.addEventListener("click", () =>
      _setMcpApproval(pluginName, false, containerId),
    );
}

/**
 * 加载插件详情（工具列表等）
 * @param {string} pluginName - 插件名
 * @param {HTMLElement} detailsEl - 详情容器
 * @param {string} containerId - 面板容器 ID
 */
/**
 * 渲染「注入内容」展开区（凛倾 0727：一个是数据、一个是提示词，点击展开看实际内容）。
 *
 * 【数据页】= 后端 buildToolsData()：从 MCP server 实时拼的工具/Prompts/Resources 清单，只读——
 *   这是**数据**不是提示词，用户不需要维护（同 hermes-agent：工具 schema 走独立通道，与引导文案解耦）。
 * 【提示词页】= data.promptText：怎么调用的引导文案，用户自己填/自己从 MCP 官方说明粘进来。
 *   代码只持缺省值（后端 DEFAULT_PROMPT，经 _promptDefault 下发，面板不复制第二份）。
 *   写 {{mcp_tools}} 决定数据插在哪；不写则数据追加在后；清空=只注入数据。
 * 编辑框复用项目现成的 expandable 展开范式（⛶ 放大编辑）。
 * @param {HTMLElement} box - 展开区容器
 * @param {string} pluginName - 插件名
 * @param {object} cfg - 已拉取的插件配置（含 promptText/_promptDefault）
 */
async function _renderInjectBox(box, pluginName, cfg) {
  box.innerHTML = '<div class="mcp-tools-hint">正在获取实际注入内容...</div>';
  let dataText = "";
  let promptDefault = cfg?._promptDefault || "";
  try {
    const j = await sendAction({ verb: "previewInject", target: "plugins:_dynamic", source: "web", payload: { _pluginName: pluginName } });
    const r = j._result || j;
    if (r.success) {
      dataText = r.data || "";
      promptDefault = r.promptDefault || promptDefault;
    } else {
      dataText = `（未取到：${r.error || "未知错误"}）`;
    }
  } catch (err) {
    dataText = `（获取失败：${err.message}）`;
  }
  // undefined = 从没设置过（占位显示缺省值）；"" = 用户显式清空（尊重空）
  const promptVal = cfg?.promptText === undefined || cfg?.promptText === null ? "" : String(cfg.promptText);

  box.innerHTML = `
    <div class="mcp-inject-tabs" style="display:flex;gap:4px;padding:4px 8px;">
      <button class="mcp-btn mcp-inject-tab" data-tab="data" style="font-size:11px;">📦 数据</button>
      <button class="mcp-btn mcp-inject-tab" data-tab="prompt" style="font-size:11px;">📝 提示词</button>
    </div>
    <div data-pane="data" style="padding:4px 8px;">
      <div style="font-size:10px;opacity:0.55;margin-bottom:4px;">从 MCP Server 实时读取，代码自动拼装，无需维护（每轮注入时重新获取）</div>
      <pre style="max-height:220px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(128,128,128,0.08);padding:6px;border-radius:6px;">${escapeHtml(dataText)}</pre>
    </div>
    <div data-pane="prompt" class="hidden" style="padding:4px 8px;">
      <div style="font-size:10px;opacity:0.55;margin-bottom:4px;">调用引导文案由你来写（MCP 官方说明可直接粘进来）。<code>{{mcp_tools}}</code> = 上面那份数据的插入位；留空则只注入数据。</div>
      <div class="relative expandable-container">
        <textarea class="textarea textarea-bordered w-full text-xs" id="mcp-prompt-ta-${escapeAttr(pluginName)}" rows="6"
          data-expandable data-expand-title="MCP 提示词（${escapeAttr(pluginName)}）"
          placeholder="${escapeAttr(promptDefault)}">${escapeHtml(promptVal)}</textarea>
        <button class="expand-btn" title="放大编辑">⛶</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
        <button class="mcp-btn" data-act="save-prompt" style="font-size:11px;">保存</button>
        <button class="mcp-btn" data-act="use-default" style="font-size:11px;" title="把缺省文案填进编辑框（仍需保存）">用缺省文案</button>
        <span data-role="prompt-status" style="font-size:10px;opacity:0.6;"></span>
      </div>
    </div>`;
  box.dataset.loaded = "1";

  const _panes = box.querySelectorAll("[data-pane]");
  const _tabs = box.querySelectorAll(".mcp-inject-tab");
  const _activate = (name) => {
    _panes.forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
    // 选中态走内联样式：CSS 里没有 .mcp-btn-active 这个类（加类=造幽灵样式，选中永远看不出来）
    _tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.style.opacity = on ? "1" : "0.5";
      t.style.fontWeight = on ? "700" : "400";
    });
  };
  _tabs.forEach((t) => t.addEventListener("click", () => _activate(t.dataset.tab)));
  _activate("data");

  const _ta = box.querySelector("textarea");
  const _status = box.querySelector('[data-role="prompt-status"]');
  box.querySelector('[data-act="use-default"]')?.addEventListener("click", () => {
    if (_ta) { _ta.value = promptDefault; _ta.focus(); }
    if (_status) _status.textContent = "已填入缺省文案，记得保存";
  });
  box.querySelector('[data-act="save-prompt"]')?.addEventListener("click", async () => {
    if (!_ta) return;
    if (_status) _status.textContent = "保存中…";
    try {
      const j = await sendAction({ verb: "setPrompt", target: "plugins:_dynamic", source: "web", payload: { _pluginName: pluginName, promptText: _ta.value } });
      const r = j._result || j;
      if (r.success) {
        if (cfg) cfg.promptText = _ta.value; // 同步内存缓存，避免重开展开区显示旧值
        _pluginDetailsCache.delete(pluginName); // 下次详情从后端重取（落盘值为准）
        if (_status) _status.textContent = "已保存（下轮对话生效）";
      } else {
        if (_status) _status.textContent = "保存失败：" + (r.error || "未知错误");
      }
    } catch (err) {
      if (_status) _status.textContent = "保存失败：" + err.message;
    }
  });
}

async function loadPluginDetails(pluginName, detailsEl, containerId) {
  try {
    let data = _pluginDetailsCache.get(pluginName);
    if (!data) {
      // T6b：走 plugins:_dynamic#getConfig（payload._pluginName 提供实际插件名；HTTP !ok → 抛错走 catch）
      data = await sendAction({ verb: "getConfig", target: "plugins:_dynamic", source: "web", payload: { _pluginName: pluginName } });
      _pluginDetailsCache.set(pluginName, data);
    }

    const displayName = pluginName.replace(/^mcp_/, "");
    const description = data.description || data.description_markdown || "";
    const config = data.config || {};
    const tags = Array.isArray(data.tags) ? data.tags : [];

    // 构建描述区
    let html = "";

    if (description) {
      html += `<div class="mcp-detail-desc">${escapeHtml(description)}</div>`;
    }

    // 连接信息
    const connType = config.command ? "stdio" : config.url ? "SSE" : "未知";
    html += `<div class="mcp-detail-conn">连接方式: <strong>${escapeHtml(connType)}</strong>`;
    if (config.command) {
      html += ` — <code>${escapeHtml(config.command)}</code>`;
    } else if (config.url) {
      html += ` — <code>${escapeHtml(config.url)}</code>`;
    }
    html += `</div>`;

    if (tags.length > 0) {
      html += `<div class="mcp-detail-tags">${tags.map((t) => `<span class="mcp-tag">${escapeHtml(t)}</span>`).join("")}</div>`;
    }

    // SEC-MCP：命令型 MCP 批准控件（仅命令型出现在批准表中）。
    html += _approvalBlockHtml(pluginName, config);

    // 操作按钮区
    html += `
      <div class="mcp-detail-actions">
        <button class="mcp-btn mcp-btn-test" data-plugin="${escapeAttr(pluginName)}" title="测试工具调用"><i data-ic="flask"></i> 测试工具</button>
        <button class="mcp-btn mcp-btn-remove" data-plugin="${escapeAttr(pluginName)}" title="从聊天中移除"><i data-ic="trash"></i> 移除</button>
      </div>
    `;

    // 工具列表占位区
    html += `
      <div class="mcp-tools-section">
        <div class="mcp-tools-header" data-tools-toggle="${escapeAttr(pluginName)}">
          <i data-ic="package"></i> 工具列表 <span class="mcp-tools-chevron">▸</span>
        </div>
        <div class="mcp-tools-content hidden" id="mcp-tools-${escapeAttr(pluginName)}">
          <div class="mcp-tools-hint">点击展开从 MCP Server 获取工具列表...</div>
        </div>
      </div>
    `;

    // [0727 凛倾「mcp的实际内容和提示词点击展开…一个是数据,一个是提示词」]
    //   注入面板：展开后两页签——「数据」= 代码从 server 实时拼的工具清单（只读，用户不用维护）；
    //   「提示词」= 用户自己填的调用引导（可编辑落盘，代码只持缺省值 DEFAULT_PROMPT）。
    //   两页内容都由后端同一函数产（previewInject 动作），面板不自己拼第二份。
    html += `
      <div class="mcp-tools-section">
        <div class="mcp-tools-header" data-inject-toggle="${escapeAttr(pluginName)}">
          <i data-ic="wrench"></i> 注入内容（数据 / 提示词） <span class="mcp-inject-chevron">▸</span>
        </div>
        <div class="mcp-inject-content hidden" id="mcp-inject-${escapeAttr(pluginName)}">
          <div class="mcp-tools-hint">点击展开查看实际注入内容...</div>
        </div>
      </div>
    `;

    detailsEl.innerHTML = html;

    // 绑定工具列表展开（展开时从MCP Server拉取真实工具列表）
    detailsEl
      .querySelector("[data-tools-toggle]")
      ?.addEventListener("click", async (e) => {
        const toolsContent = detailsEl.querySelector(".mcp-tools-content");
        const toolsChevron = e.currentTarget.querySelector(
          ".mcp-tools-chevron",
        );
        if (toolsContent) {
          const wasHidden = toolsContent.classList.contains("hidden");
          toolsContent.classList.toggle("hidden");
          if (toolsChevron) {
            toolsChevron.textContent = toolsContent.classList.contains("hidden")
              ? "▸"
              : "▾";
          }
          if (wasHidden && !toolsContent.dataset.loaded) {
            toolsContent.innerHTML = '<div class="mcp-tools-hint">正在从 MCP Server 获取...</div>';
            try {
              // T6b：走 plugins:_dynamic#* 通配 setdata（verb=listTools → _action=listTools；payload._pluginName 提供实际插件名）
              const j = await sendAction({ verb: "listTools", target: "plugins:_dynamic", source: "web", payload: { _pluginName: pluginName } });
              const r = j._result || j;
              if (r.success && r.tools) {
                let html = "";
                if (r.tools.length > 0) {
                  html += r.tools.map(t =>
                    `<div class="mcp-tool-item" style="padding:4px 8px;border-bottom:1px solid var(--beilu-border,#333);font-size:12px;">
                      <strong>${escapeHtml(t.name)}</strong>
                      <div style="opacity:0.6;font-size:11px;">${escapeHtml(t.description || "")}</div>
                    </div>`
                  ).join("");
                } else {
                  html = '<div class="mcp-tools-hint">此 Server 未注册任何工具</div>';
                }
                if (r.prompts?.length) {
                  html += `<div style="padding:4px 8px;font-size:11px;opacity:0.5;border-top:1px solid var(--beilu-border,#333);">+ ${r.prompts.length} 个 Prompts, ${(r.resources || []).length} 个 Resources</div>`;
                }
                toolsContent.innerHTML = html;
                toolsContent.dataset.loaded = "1";
              } else {
                toolsContent.innerHTML = `<div class="mcp-tools-hint">${escapeHtml(r.error || "获取失败")}</div>`;
              }
            } catch (err) {
              toolsContent.innerHTML = `<div class="mcp-tools-hint">获取失败: ${escapeHtml(err.message)}</div>`;
            }
          }
        }
      });

    // [0727] 绑定「注入内容」展开（数据 / 提示词 两页签）
    detailsEl
      .querySelector("[data-inject-toggle]")
      ?.addEventListener("click", async (e) => {
        const box = detailsEl.querySelector(".mcp-inject-content");
        const chev = e.currentTarget.querySelector(".mcp-inject-chevron");
        if (!box) return;
        const wasHidden = box.classList.contains("hidden");
        box.classList.toggle("hidden");
        if (chev) chev.textContent = box.classList.contains("hidden") ? "▸" : "▾";
        if (wasHidden && !box.dataset.loaded) await _renderInjectBox(box, pluginName, data);
      });

    // SEC-MCP：绑定批准 / 撤销按钮
    _bindApprovalButtons(detailsEl, pluginName, containerId);

    // 绑定测试按钮
    detailsEl.querySelector(".mcp-btn-test")?.addEventListener("click", () => {
      showTestToolDialog(pluginName);
    });

    // 绑定移除按钮
    detailsEl
      .querySelector(".mcp-btn-remove")
      ?.addEventListener("click", async () => {
        if (!await beiluConfirm(`确定要从当前聊天中移除 "${displayName}" 吗？`)) return;
        await removePluginFromChat(pluginName, containerId);
      });
  } catch (err) {
    // 详情拉取失败（部分 MCP 插件未注册 config/getdata 路由）：批准控件不依赖详情，
    // 仍据 _mcpApprovalMap 渲染，保证命令型 MCP 在此仍可批准 / 撤销。
    const _apprHtml = _approvalBlockHtml(pluginName);
    detailsEl.innerHTML =
      _apprHtml +
      `<div class="mcp-error">加载详情失败: ${escapeHtml(err.message)}</div>`;
    if (_apprHtml) _bindApprovalButtons(detailsEl, pluginName, containerId);
    console.warn("[mcpPanel] 加载插件详情失败:", pluginName, err.message);
  }
}

/**
 * 从聊天中移除插件
 * @param {string} pluginName - 插件名
 * @param {string} containerId - 面板容器 ID
 */
async function removePluginFromChat(pluginName, containerId) {
  const chatId = getCurrentChatId();
  if (!chatId) return;

  try {
    // T6b：走 shells:chat#removePlugin（HTTP !ok → 门面抛错走 catch）
    await sendAction({ verb: "removePlugin", target: "shells:chat", source: "web", scope: { chatId }, payload: { pluginName } });

    _pluginDetailsCache.delete(pluginName);
    console.log(`[mcpPanel] 已移除插件: ${pluginName}`);

    // 刷新列表
    await loadMcpServers(containerId);
  } catch (err) {
    showToast("error", `移除失败: ${err.message}`);
    console.error("[mcpPanel] 移除插件失败:", err.message);
  }
}

/**
 * SEC-MCP：批准 / 撤销命令型 MCP server（写 data._mcpApproved，后端重启服务生效）。
 *   批准 = 允许该 server spawn 宿主进程执行命令（RCE 面），故批准前二次确认；
 *   撤销 = 下次（重）启动不再 spawn。复用后端已有 POST /api/security/mcp-approve，不新增端点。
 * @param {string} pluginName - 插件名（mcp_*）
 * @param {boolean} approved - true=批准，false=撤销
 * @param {string} containerId - 面板容器 ID
 */
async function _setMcpApproval(pluginName, approved, containerId) {
  const displayName = pluginName.replace(/^mcp_/, "");
  if (approved) {
    const ok = await beiluConfirm(
      `批准命令型 MCP server “${displayName}”？\n\n` +
        `批准后服务将重启以生效，并在启动时 spawn 宿主进程执行其配置的命令。\n` +
        `请确认来源可信 —— 恶意命令型 MCP 等同于远程代码执行 (RCE)。`,
    );
    if (!ok) return;
  }
  try {
    // T6b：走 server:security#approveMcp（HTTP !ok → 门面抛错；业务 success:false 仍手检抛）
    const r = await sendAction({ verb: "approveMcp", target: "server:security", source: "web", payload: { pluginName, approved } });
    if (r?.success === false) {
      throw new Error(r?.error || "未知错误");
    }
    showToast(
      approved ? 'success' : 'info',
      approved
        ? `已批准 “${displayName}”。服务将在约 1 秒后重启以生效。`
        : `已撤销 “${displayName}” 的批准。服务将重启，下次启动不再 spawn。`,
    );
    _pluginDetailsCache.delete(pluginName);
    await loadMcpServers(containerId);
  } catch (err) {
    showToast("error", `操作失败: ${err.message}`);
    console.error("[mcpPanel] 批准/撤销 MCP 失败:", pluginName, err.message);
  }
}

/**
 * 显示添加 MCP Server 对话框
 * @param {string} containerId - 面板容器 ID
 * @param {{request?:object,chatId?:string,prefillText?:string}} options - AI 请求审查时的原记录与预填内容
 */
function showAddServerDialog(containerId, options = {}) {
  // 移除已有对话框
  document.getElementById("mcp-add-dialog")?.remove();

  const request = options.request || null;
  const dialogChatId = options.chatId || getCurrentChatId();
  const prefillText = typeof options.prefillText === "string" ? options.prefillText : "";
  let dialogBusy = false;
  let requestImportStarted = false;
  let importCompleted = false;

  const dialog = document.createElement("div");
  dialog.id = "mcp-add-dialog";
  dialog.className = "mcp-dialog-overlay";
  dialog.innerHTML = `
    <div class="mcp-dialog">
      <div class="mcp-dialog-header">
        <h4>${request ? "审查 AI 提出的 MCP 接入请求" : "添加 MCP Server"}</h4>
        <button class="mcp-dialog-close" title="关闭">✕</button>
      </div>
      <div class="mcp-dialog-body">
        <p class="mcp-dialog-hint">${request
          ? "以下内容仅作预填。请审查并可直接编辑；只有你点击“导入”后才会进入现有导入流程。"
          : "粘贴 MCP 配置 JSON（标准 mcpServers 格式）："
        }</p>
        ${request?.validationError ? `<div class="mcp-error" style="margin-bottom:6px;">${escapeHtml(request.validationError)}</div>` : ""}
        <textarea class="mcp-dialog-textarea" placeholder='{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  }
}'>${escapeHtml(prefillText)}</textarea>
        <div class="mcp-dialog-error hidden" id="mcp-add-error"></div>
      </div>
      <div class="mcp-dialog-footer">
        <button class="mcp-btn mcp-btn-cancel">取消</button>
        <button class="mcp-btn mcp-btn-confirm">导入</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  // 关闭
  const close = () => {
    if (!dialogBusy) dialog.remove();
  };
  dialog.querySelector(".mcp-dialog-close")?.addEventListener("click", close);
  dialog.querySelector(".mcp-btn-cancel")?.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  const finishRequestImport = async (importSucceeded, importError, importedParts) => {
    if (!request || !requestImportStarted) return;
    const statusResult = await sendAction({
      verb: "finishMcpConnectRequestImport",
      target: "plugins:beilu-memory",
      source: "web",
      scope: { chatId: request.chatId },
      payload: {
        requestId: request.requestId,
        chatId: request.chatId,
        importSucceeded,
        importError,
        importedParts,
      },
    });
    if (!statusResult?.success) throw new Error(statusResult?.error || "请求状态写回失败");
    requestImportStarted = false;
  };

  // 导入
  dialog
    .querySelector(".mcp-btn-confirm")
    ?.addEventListener("click", async () => {
      const textarea = dialog.querySelector(".mcp-dialog-textarea");
      const errorEl = dialog.querySelector("#mcp-add-error");
      const text = textarea?.value?.trim();

      if (!text) {
        showDialogError(errorEl, "请输入配置内容");
        return;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(text); // 验证 JSON 格式
      } catch (e) {
        showDialogError(errorEl, `JSON 格式错误: ${e.message}`);
        return;
      }
      const mcpServers = parsedConfig && typeof parsedConfig === "object" && !Array.isArray(parsedConfig)
        ? parsedConfig.mcpServers
        : null;
      if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers) || Object.keys(mcpServers).length === 0) {
        showDialogError(errorEl, "请输入至少包含一个 server 的标准 mcpServers 配置");
        return;
      }

      try {
        const confirmBtn = dialog.querySelector(".mcp-btn-confirm");
        confirmBtn.textContent = "导入中...";
        confirmBtn.disabled = true;
        dialogBusy = true;

        if (request) {
          if (!dialogChatId || request.chatId !== dialogChatId || getCurrentChatId() !== dialogChatId) {
            throw new Error("当前聊天已变化，请回到该请求所属聊天后重新审查");
          }
          const beginResult = await sendAction({
            verb: "beginMcpConnectRequestImport",
            target: "plugins:beilu-memory",
            source: "web",
            scope: { chatId: request.chatId },
            payload: {
              requestId: request.requestId,
              chatId: request.chatId,
              importText: text,
            },
          });
          if (!beginResult?.success) {
            throw new Error(beginResult?.error || "请求已由其他窗口处理");
          }
          requestImportStarted = true;
        }

        // 真路由：install shell 的文本导入（importPartByText 自动遍历 ImportHandlers，含 MCP）。
        // 原 /api/import 是幻影路由（后端无注册）→ 点导入必 404。
        // T6b：走 shells:install#importText（HTTP !ok → 门面抛错走 catch）
        const result = await sendAction({ verb: "importText", target: "shells:install", source: "web", payload: { text } });
        const importedMcpParts = Array.isArray(result?.parts)
          ? result.parts.filter((part) => /^plugins\/mcp_[^/\\]+$/.test(String(part)))
          : [];
        if (
          importedMcpParts.length === 0 ||
          importedMcpParts.length !== result.parts.length
        ) {
          throw new Error("导入响应未包含有效 MCP 插件");
        }
        console.log("[mcpPanel] MCP 导入成功:", result);

        // 注意：不在此处 close()，待挂载到聊天确认后再关（失败需保留对话框显示错误）

        // 如果导入成功，尝试将新插件添加到打开对话框时确定的聊天。
        // Drift 修复：原代码挂载 POST 不查 res.ok，HTTP 4xx/5xx 仍 resolve →
        // 无脑 console.log "已添加" + 关闭对话框 = 假成功（插件实际没挂上，列表也不会出现它）。
        // 改为收集挂载失败项，有失败则不关对话框、提示用户。
        const chatId = dialogChatId;
        const mountFailures = [];
        if (chatId) {
          for (const partPath of importedMcpParts) {
            const pluginName = partPath.replace(/^plugins\//, "");
            try {
              // T6b：走 shells:chat#mountPlugin（HTTP !ok → 门面抛错走 catch；原分支 HTTP N 错误信息统一为 e.message）
              await sendAction({ verb: "mountPlugin", target: "shells:chat", source: "web", scope: { chatId }, payload: { pluginname: pluginName } });
              console.log(
                `[mcpPanel] 已将 ${pluginName} 添加到聊天 ${chatId}`,
              );
            } catch (e) {
              mountFailures.push(`${pluginName} (${e.message})`);
              console.warn(
                `[mcpPanel] 添加插件到聊天失败: ${pluginName}`,
                e.message,
              );
            }
          }
        }

        // 挂载有失败：保留对话框 + 显式报错（不假成功），仍刷新列表反映已成功项
        if (mountFailures.length > 0) {
          const mountError = `导入成功但挂载到聊天失败: ${mountFailures.join("，")}`;
          await finishRequestImport(false, mountError, importedMcpParts);
          showDialogError(
            errorEl,
            mountError,
          );
          if (confirmBtn) {
            confirmBtn.textContent = "导入";
            confirmBtn.disabled = false;
          }
          dialogBusy = false;
          _pluginDetailsCache.clear();
          await _refreshMcpPanel(containerId);
          return;
        }

        await finishRequestImport(true, null, importedMcpParts);
        importCompleted = true;
        dialogBusy = false;
        close();

        // SEC-T3: 命令型 MCP 导入后立即弹出批准确认，让 import → consent → approve 一气呵成。
        // 不批准也不阻塞——插件已导入+挂载，只是 spawn 闸拦住不启动（安全默认），
        // 用户后续可在卡片详情中随时批准。
        if (result.needsConsent && Array.isArray(result.consentItems) && result.consentItems.length > 0) {
          for (const item of result.consentItems) {
            const cmdLine = `${item.command || ""}${Array.isArray(item.args) && item.args.length ? " " + item.args.join(" ") : ""}`;
            const ok = await beiluConfirm(
              `命令型 MCP server "${item.serverName || item.pluginName}"` +
              `\n\n将执行命令：${cmdLine}` +
              `\n\n命令型 (stdio) MCP 会 spawn 本机进程执行命令，等同于远程代码执行 (RCE)。` +
              `\n请确认来源可信。是否批准启动？`,
            );
            if (ok) {
              try {
                // T6b：走 server:security#approveMcp（HTTP !ok → 抛错走 catch；success!==false 分支保留）
                const r = await sendAction({ verb: "approveMcp", target: "server:security", source: "web", payload: { pluginName: item.pluginName, approved: true } });
                if (r?.success !== false) {
                  showToast('success', `已批准 "${item.serverName || item.pluginName}"，服务将在约 1 秒后重启以生效。`);
                }
              } catch (e) {
                console.warn("[mcpPanel] 批准 MCP 失败:", item.pluginName, e.message);
              }
            }
          }
        }

        // 刷新列表
        _pluginDetailsCache.clear();
        await _refreshMcpPanel(containerId);
      } catch (err) {
        if (importCompleted) {
          console.warn("[mcpPanel] MCP 已导入，但后续界面刷新失败:", err.message);
          return;
        }
        let visibleError = err.message;
        if (requestImportStarted) {
          try {
            await finishRequestImport(false, visibleError, []);
          } catch (statusError) {
            visibleError += `；请求状态写回失败: ${statusError.message}`;
          }
        }
        dialogBusy = false;
        showDialogError(errorEl, `导入失败: ${visibleError}`);
        const confirmBtn = dialog.querySelector(".mcp-btn-confirm");
        if (confirmBtn) {
          confirmBtn.textContent = "导入";
          confirmBtn.disabled = false;
        }
        await loadMcpConnectRequests(containerId);
      }
    });
}

/**
 * 显示测试工具调用对话框
 * @param {string} pluginName - 插件名
 */
function showTestToolDialog(pluginName) {
  document.getElementById("mcp-test-dialog")?.remove();

  const displayName = pluginName.replace(/^mcp_/, "");

  const dialog = document.createElement("div");
  dialog.id = "mcp-test-dialog";
  dialog.className = "mcp-dialog-overlay";
  dialog.innerHTML = `
    <div class="mcp-dialog mcp-dialog-wide">
      <div class="mcp-dialog-header">
        <h4>测试工具 — ${escapeHtml(displayName)}</h4>
        <button class="mcp-dialog-close" title="关闭">✕</button>
      </div>
      <div class="mcp-dialog-body">
        <p class="mcp-dialog-hint">输入工具名和参数 JSON 直接测试：</p>
        <input class="mcp-dialog-textarea mcp-test-toolname" placeholder="工具名（如 get_weather）" style="width:100%;padding:6px;margin-bottom:4px;font-size:12px;" />
        <textarea class="mcp-dialog-textarea mcp-test-input" placeholder='参数 JSON（如 {"location":"Beijing"}）' style="height:60px;"></textarea>
        <div class="mcp-test-result hidden" id="mcp-test-result">
          <div class="mcp-test-result-header">执行结果：</div>
          <pre class="mcp-test-result-content"></pre>
        </div>
      </div>
      <div class="mcp-dialog-footer">
        <button class="mcp-btn mcp-btn-cancel">关闭</button>
        <button class="mcp-btn mcp-btn-confirm mcp-btn-run">▶ 执行</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const close = () => dialog.remove();
  dialog.querySelector(".mcp-dialog-close")?.addEventListener("click", close);
  dialog.querySelector(".mcp-btn-cancel")?.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  // 执行测试
  dialog.querySelector(".mcp-btn-run")?.addEventListener("click", async () => {
    const input = dialog.querySelector(".mcp-test-input")?.value?.trim();
    const resultEl = dialog.querySelector("#mcp-test-result");
    const resultContent = resultEl?.querySelector(
      ".mcp-test-result-content",
    );
    const runBtn = dialog.querySelector(".mcp-btn-run");

    if (!input) return;

    resultEl?.classList.remove("hidden");
    resultContent.textContent = "执行中...";
    runBtn.disabled = true;
    runBtn.innerHTML = '<i data-ic="hourglass"></i> 执行中...';

    const toolName = dialog.querySelector(".mcp-test-toolname")?.value?.trim();
    if (!toolName) { resultContent.textContent = "请输入工具名"; return; }
    let args = {};
    if (input) {
      try { args = JSON.parse(input); } catch { resultContent.textContent = "参数 JSON 格式错误"; runBtn.disabled = false; runBtn.textContent = "▶ 执行"; return; }
    }
    try {
      // T6b：走 plugins:_dynamic#* 通配 setdata（verb=testTool → _action=testTool；payload._pluginName 提供实际插件名）
      const j = await sendAction({ verb: "testTool", target: "plugins:_dynamic", source: "web", payload: { _pluginName: pluginName, toolName, args } });
      const r = j._result || j;
      if (r.success) {
        resultContent.textContent = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
      } else {
        resultContent.textContent = `错误: ${r.error || "执行失败"}`;
      }
    } catch (err) {
      resultContent.textContent = `执行失败: ${err.message}`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "▶ 执行";
    }
  });
}

/**
 * 在对话框中显示错误
 * @param {HTMLElement|null} errorEl - 错误容器
 * @param {string} message - 错误信息
 */
function showDialogError(errorEl, message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  setTimeout(() => errorEl.classList.add("hidden"), 5000);
}

// ---- 工具函数 ----

// 收口: escapeAttr 原为本地 5字符 map 手抄(口径同权威),改为 delegate 权威 utils.escapeHtml(已 import,全5字符 & < > " '),与 fileExplorer/regexEditor 同范式
function escapeAttr(str) {
  return escapeHtml(str);
}

// ============================================================
// 环境工具面板
// ============================================================

let _envToolsConfig = { descriptions: {}, scan_dirs: [] };
let _envToolsDetected = [];
let _envToolsNpmResults = [];

async function _initEnvToolsPanel(containerId) {
  const toggle = document.getElementById(`${containerId}-envtools-toggle`);
  const body = document.getElementById(`${containerId}-envtools-body`);
  const chevron = document.getElementById(`${containerId}-envtools-chevron`);
  if (!toggle || !body) return;

  toggle.addEventListener("click", async () => {
    const hidden = body.classList.toggle("hidden");
    if (chevron) chevron.textContent = hidden ? "▸" : "▾";
    if (!hidden) await _loadEnvTools(containerId);
  });

  // [上线引导 0727] 首屏即加载:body 默认展开(模板未带 hidden),但加载此前只挂在 toggle
  // 点击里 → 首屏三块全空,「扫描目录/工具说明」旁只剩 +添加,用户误以为功能要手动配置才能用。
  // 展开态直接拉一次数据;后续点击展开仍会重拉(刷新语义不变)。
  if (!body.classList.contains("hidden")) _loadEnvTools(containerId);

  // 添加扫描目录
  document.getElementById(`${containerId}-envtools-add-dir`)?.addEventListener("click", () => {
    _envToolsConfig.scan_dirs.push({ path: "", label: "" });
    _renderEnvToolsDirs(containerId);
  });

  // 添加工具说明
  document.getElementById(`${containerId}-envtools-add-desc`)?.addEventListener("click", () => {
    _envToolsConfig.descriptions[""] = "";
    _renderEnvToolsDescs(containerId);
  });

  // 保存
  document.getElementById(`${containerId}-envtools-save`)?.addEventListener("click", () => _saveEnvTools(containerId));
}

async function _loadEnvTools(containerId) {
  const statusEl = document.getElementById(`${containerId}-envtools-status`);
  if (statusEl) statusEl.textContent = "加载中...";
  try {
    // T6b：走 beilu-memory 通配 setdata（verb=getEnvTools → _action=getEnvTools）
    const result = await sendAction({ verb: "getEnvTools", target: "plugins:beilu-memory", source: "web" });
    if (!result?.success) throw new Error(result?.error || "加载失败");
    _envToolsConfig = result.config || { descriptions: {}, scan_dirs: [] };
    _envToolsDetected = result.detected || [];
    _envToolsNpmResults = result.npmResults || [];
    _renderEnvToolsDetected(containerId);
    _renderEnvToolsDirs(containerId);
    _renderEnvToolsDescs(containerId);
    if (statusEl) statusEl.textContent = "";
  } catch (e) {
    if (statusEl) statusEl.textContent = "加载失败: " + e.message;
  }
}

function _renderEnvToolsDetected(containerId) {
  const el = document.getElementById(`${containerId}-envtools-detected`);
  if (!el) return;
  if (_envToolsDetected.length === 0) {
    el.innerHTML = '<span style="font-size:0.7rem; opacity:0.4;">未检测到系统工具</span>';
    return;
  }
  const chips = _envToolsDetected.map(t => {
    const ver = t.version ? ` <span style="opacity:0.5">${escapeHtml(t.version)}</span>` : "";
    return `<span style="display:inline-block; font-size:0.65rem; padding:1px 6px; margin:1px; border-radius:4px; background:var(--fallback-b2,oklch(var(--b2)));border:1px solid var(--fallback-bc,oklch(var(--bc)/0.1));">${escapeHtml(t.cmd)}${ver}</span>`;
  }).join("");

  // npm 扫描结果
  let npmHtml = "";
  if (_envToolsNpmResults.length > 0) {
    npmHtml = _envToolsNpmResults.map(r => {
      if (r.error) return `<div style="font-size:0.65rem; color:var(--fallback-er,oklch(var(--er))); margin-top:4px;">${escapeHtml(r.label)}: ${escapeHtml(r.error)}</div>`;
      if (!r.packages || r.packages.length === 0) return "";
      const pkgChips = r.packages.map(p =>
        `<span style="display:inline-block; font-size:0.6rem; padding:0 4px; margin:1px; border-radius:3px; background:var(--fallback-b3,oklch(var(--b3)));border:1px solid var(--fallback-bc,oklch(var(--bc)/0.08));">${escapeHtml(p.name)} <span style="opacity:0.4">${escapeHtml(p.version)}</span></span>`
      ).join("");
      return `<div style="margin-top:4px;"><span style="font-size:0.65rem; font-weight:600;">${escapeHtml(r.label)}</span><div style="margin-top:2px;">${pkgChips}</div></div>`;
    }).join("");
  }

  el.innerHTML = `<div style="margin-bottom:4px;"><span style="font-size:0.7rem; font-weight:600;">系统工具 (${_envToolsDetected.length})</span></div>${chips}${npmHtml}`;
}

function _renderEnvToolsDirs(containerId) {
  const el = document.getElementById(`${containerId}-envtools-dirs`);
  if (!el) return;
  const dirs = _envToolsConfig.scan_dirs || [];
  if (dirs.length === 0) {
    el.innerHTML = '<span style="font-size:0.65rem;" class="opacity-40">未配置扫描目录(可选):默认只检测常用系统工具</span>';
    return;
  }
  el.innerHTML = dirs.map((d, i) => {
    const dirPath = typeof d === "string" ? d : (d.path || "");
    const label = typeof d === "string" ? "" : (d.label || "");
    return `<div style="display:flex; gap:4px; margin-bottom:3px; align-items:center;">
      <input type="text" placeholder="标签" value="${escapeAttr(label)}" data-envdir-idx="${i}" data-envdir-field="label"
        style="width:80px; font-size:0.7rem; padding:2px 4px; border:1px solid var(--fallback-bc,oklch(var(--bc)/0.15)); border-radius:4px; background:var(--fallback-b2,oklch(var(--b2)));" />
      <input type="text" placeholder="路径" value="${escapeAttr(dirPath)}" data-envdir-idx="${i}" data-envdir-field="path"
        style="flex:1; font-size:0.7rem; padding:2px 4px; border:1px solid var(--fallback-bc,oklch(var(--bc)/0.15)); border-radius:4px; background:var(--fallback-b2,oklch(var(--b2)));" />
      <button data-envdir-del="${i}" style="font-size:0.7rem; cursor:pointer; opacity:0.5; background:none; border:none; color:inherit;" title="删除">✕</button>
    </div>`;
  }).join("");

  // 绑定输入
  el.querySelectorAll("[data-envdir-idx]").forEach(input => {
    input.addEventListener("change", () => {
      const idx = parseInt(input.dataset.envdirIdx);
      const field = input.dataset.envdirField;
      if (idx >= 0 && idx < dirs.length) {
        if (typeof dirs[idx] === "string") dirs[idx] = { path: dirs[idx], label: "" };
        dirs[idx][field] = input.value;
      }
    });
  });
  el.querySelectorAll("[data-envdir-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.envdirDel);
      dirs.splice(idx, 1);
      _renderEnvToolsDirs(containerId);
    });
  });
}

function _renderEnvToolsDescs(containerId) {
  const el = document.getElementById(`${containerId}-envtools-descs`);
  if (!el) return;
  const descs = _envToolsConfig.descriptions || {};
  const entries = Object.entries(descs);
  if (entries.length === 0) {
    el.innerHTML = '<span style="font-size:0.65rem;" class="opacity-40">未添加工具说明(可选):AI 只会看到工具名与版本</span>';
    return;
  }
  el.innerHTML = entries.map(([name, desc], i) => {
    return `<div style="display:flex; gap:4px; margin-bottom:3px; align-items:center;">
      <input type="text" placeholder="工具名" value="${escapeAttr(name)}" data-envdesc-idx="${i}" data-envdesc-field="name"
        style="width:80px; font-size:0.7rem; padding:2px 4px; border:1px solid var(--fallback-bc,oklch(var(--bc)/0.15)); border-radius:4px; background:var(--fallback-b2,oklch(var(--b2)));" />
      <input type="text" placeholder="说明" value="${escapeAttr(desc)}" data-envdesc-idx="${i}" data-envdesc-field="desc"
        style="flex:1; font-size:0.7rem; padding:2px 4px; border:1px solid var(--fallback-bc,oklch(var(--bc)/0.15)); border-radius:4px; background:var(--fallback-b2,oklch(var(--b2)));" />
      <button data-envdesc-del="${i}" style="font-size:0.7rem; cursor:pointer; opacity:0.5; background:none; border:none; color:inherit;" title="删除">✕</button>
    </div>`;
  }).join("");

  // 绑定输入
  el.querySelectorAll("[data-envdesc-idx]").forEach(input => {
    input.addEventListener("change", () => {
      const idx = parseInt(input.dataset.envdescIdx);
      const field = input.dataset.envdescField;
      const oldEntries = Object.entries(_envToolsConfig.descriptions);
      if (idx < 0 || idx >= oldEntries.length) return;
      if (field === "name") {
        const oldName = oldEntries[idx][0];
        const val = _envToolsConfig.descriptions[oldName];
        delete _envToolsConfig.descriptions[oldName];
        _envToolsConfig.descriptions[input.value] = val;
        // 改名改变了 Object.entries 顺序，必须重渲染刷新 data-envdesc-idx，否则后续编辑写到错误工具
        _renderEnvToolsDescs(containerId);
      } else {
        const name = oldEntries[idx][0];
        _envToolsConfig.descriptions[name] = input.value;
      }
    });
  });
  el.querySelectorAll("[data-envdesc-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.envdescDel);
      const entries = Object.entries(_envToolsConfig.descriptions);
      if (idx >= 0 && idx < entries.length) {
        delete _envToolsConfig.descriptions[entries[idx][0]];
        _renderEnvToolsDescs(containerId);
      }
    });
  });
}

async function _saveEnvTools(containerId) {
  const statusEl = document.getElementById(`${containerId}-envtools-status`);
  if (statusEl) statusEl.textContent = "保存中...";
  try {
    // T6b：走 beilu-memory 通配 setdata（verb=saveEnvTools → _action=saveEnvTools）
    const result = await sendAction({
      verb: "saveEnvTools", target: "plugins:beilu-memory", source: "web",
      payload: { descriptions: _envToolsConfig.descriptions, scan_dirs: _envToolsConfig.scan_dirs },
    });
    if (!result?.success) throw new Error(result?.error || "保存失败");
    if (statusEl) statusEl.textContent = "已保存";
    // 重新扫描显示最新结果
    await _loadEnvTools(containerId);
    setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2000);
  } catch (e) {
    if (statusEl) statusEl.textContent = "保存失败: " + e.message;
  }
}

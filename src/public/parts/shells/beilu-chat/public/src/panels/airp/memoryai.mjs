/**
 * @file memoryai.mjs — 记忆AI面板（折叠控制 + 输出轮询渲染）cluster
 *
 * 【功能链】
 *   initMemoryAIPanelCollapse（绑定面板 header 折叠/展开 + 关闭按钮）
 *   → toggleMemoryAIPanel（从扩展菜单触发：显示/隐藏整个记忆AI面板）
 *   → updateMemoryAIToggleStatus（同步扩展菜单中 ON/OFF 文字）
 *   → loadInj2Status（GET beilu-memory/config/getdata → 读 inj2_enabled 初始化开关态）
 *   → handleToggleInj2（POST setdata 切换 INJ-2 文件层AI提示词开关，
 *       同时 window._beiluSyncInj2State 供 layout.mjs 跨模块读取）
 *   → startMemoryOutputPoll / pollMemoryAIOutput（setInterval 轮询后端记忆AI输出，
 *       GET getdata → renderMemoryAIOutputs → renderMemAiBubble 渲染气泡卡片）
 *
 * 【why】
 *   记忆AI是异步后台运行的，输出不随对话流同步返回，需要独立轮询通道；
 *   INJ-2 开关需要跨 layout.mjs 消费，通过 window._beiluSyncInj2State 桥接；
 *   面板折叠/关闭状态在模块内私有维护，不写 localStorage（会话级临时态）。
 *
 * 【关联链】
 *   上游：index.mjs（init 时调用各入口函数）、
 *         feature-toggles（调用 toggleMemoryAIPanel）、
 *         layout.mjs（经 window._beiluSyncInj2State 读取 INJ-2 状态）
 *   同层依赖：utils.mjs（showToast / getCurrentCharId）
 *   核心依赖：shared/render/memAiBubble.mjs（renderMemAiBubble 气泡渲染）、
 *             shared/transport/api-client.mjs（apiFetch）
 *   后端接口：beilu-memory /config/getdata（读输出 + 读 inj2 状态）、/config/setdata（切换 inj2）
 *
 * 【影响范围】
 *   记忆AI输出面板 DOM（memory-ai-output）；INJ-2 开关持久化状态；
 *   轮询启动后持续运行直到页面卸载，影响后端记忆AI输出消费节奏。
 *
 * 【使用效果】
 *   import { toggleMemoryAIPanel, startMemoryOutputPoll,
 *            loadInj2Status, handleToggleInj2 } from "./memoryai.mjs"
 *   初始化后记忆AI输出自动轮询渲染；INJ-2 开关状态与后端同步；
 *   扩展菜单可一键隐藏/显示整个记忆面板。
 */
import { showToast, getCurrentCharId } from "./utils.mjs";
import { renderMemAiBubble } from "../../shared/render/memAiBubble.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory getdata/setdata 收口

// ============================================================
// 记忆AI输出面板 — 折叠/展开控制
// ============================================================

/** 记忆AI面板是否被用户手动隐藏 */
let _memoryAIPanelHidden = false;
/** 记忆AI面板 body 是否折叠 */
let _memoryAIBodyCollapsed = false;

/**
 * 切换记忆AI面板的显示/隐藏（从扩展菜单触发）
 */
function toggleMemoryAIPanel() {
  const panel = document.getElementById("memory-ai-output");
  if (!panel) return;

  const isHidden = panel.style.display === "none";
  if (isHidden) {
    panel.style.display = "";
    _memoryAIPanelHidden = false;
    _memoryOutputDismissed = false;
  } else {
    panel.style.display = "none";
    _memoryAIPanelHidden = true;
  }
  updateMemoryAIToggleStatus();
}

/**
 * 更新扩展菜单中记忆AI菜单项的状态文字
 */
function updateMemoryAIToggleStatus() {
  const statusEl = document.getElementById("memory-ai-toggle-status");
  if (!statusEl) return;
  const panel = document.getElementById("memory-ai-output");
  const isVisible = panel && panel.style.display !== "none";
  statusEl.textContent = isVisible ? "ON" : "OFF";
}

/**
 * 初始化记忆AI面板的折叠交互
 */
function initMemoryAIPanelCollapse() {
  const headerToggle = document.getElementById(
    "memory-ai-output-header-toggle",
  );
  const body = document.getElementById("memory-ai-output-body");
  const chevron = document.getElementById("memory-ai-output-chevron");
  const closeBtn = document.getElementById("memory-ai-output-close");

  if (headerToggle && body) {
    headerToggle.addEventListener("click", (e) => {
      // 如果点击的是关闭按钮，不触发折叠
      if (e.target === closeBtn || closeBtn?.contains(e.target)) return;

      _memoryAIBodyCollapsed = !_memoryAIBodyCollapsed;
      body.style.display = _memoryAIBodyCollapsed ? "none" : "";
      if (chevron) {
        chevron.textContent = _memoryAIBodyCollapsed ? "▶" : "▼";
      }
    });
  }
}

// ============================================================
// INJ-2 文件层AI提示词 — 手动切换
// ============================================================

/** INJ-2 当前状态缓存（从后端读取，避免依赖 DOM 元素） */
let _inj2Enabled = null;

/**
 * 初始化时从后端读取 INJ-2 状态
 */
async function loadInj2Status() {
  try {
    const charId = getCurrentCharId();
    // T6b批7：getdata?char_id → sendAction beilu-memory#getData（桥路由，payload 平铺进 dispatch args；
    //   后端 getDataHandler `charName = args.char_id || args.charName`（getDataHandler.mjs:72）读到 char_id）。
    //   !ok 由门面抛错走 catch（原 !resp.ok return 等价：静默保持默认）。
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web", payload: charId ? { char_id: charId } : {} });
    const inj2 = (data.injection_prompts || []).find((p) => p.id === "INJ-2");
    if (inj2) {
      _inj2Enabled = inj2.enabled;
      const statusEl = document.getElementById("inj2-status");
      if (statusEl) statusEl.textContent = _inj2Enabled ? "ON" : "OFF";
    }
  } catch {
    /* 静默失败 */
  }
}

async function handleToggleInj2() {
  // 首次调用时从后端加载状态
  if (_inj2Enabled === null) {
    await loadInj2Status();
  }
  const newState = !_inj2Enabled;
  const charId = getCurrentCharId();
  try {
    // T6b批7：setdata {_action:updateInjectionPrompt} → sendAction beilu-memory#*（通配组装 {_action:verb,...payload}）。
    await sendAction({
      verb: "updateInjectionPrompt",
      target: "plugins:beilu-memory",
      source: "web",
      payload: { injectionId: "INJ-2", enabled: newState, charName: charId || "_global" },
    });
    _inj2Enabled = newState;
    const statusEl = document.getElementById("inj2-status");
    if (statusEl) statusEl.textContent = newState ? "ON" : "OFF";
    showToast(`文件层AI提示词: ${newState ? "已开启" : "已关闭"}`, "info");
  } catch (err) {
    showToast("切换失败: " + err.message, "error");
  }
}

// W33 BUG-3: 供 layout.mjs 的 tab 驱动 _updateInj2State 同步本模块缓存，
// 避免手动开关 handleToggleInj2 从陈旧 _inj2Enabled 翻转出错一拍
window._beiluSyncInj2State = (enabled) => {
  _inj2Enabled = !!enabled;
  const statusEl = document.getElementById("inj2-status");
  if (statusEl) statusEl.textContent = enabled ? "ON" : "OFF";
};

// ============================================================
// 记忆AI输出面板（轮询 + 渲染 + 自动清空）
// ============================================================

/** 轮询定时器 */
let _memoryOutputPollTimer = null;
/** 已渲染的最大 ID（增量获取） */
let _memoryOutputLastId = 0;
/** 面板是否被用户手动关闭 */
let _memoryOutputDismissed = false;
/** 当前状态（running/done/error/null） */
let _memoryOutputCurrentStatus = null;
/** 自动清空倒计时 ID */
let _memoryOutputClearTimeout = null;

/**
 * 启动记忆AI输出轮询
 */
function startMemoryOutputPoll() {
  if (_memoryOutputPollTimer) return;
  _memoryOutputPollTimer = setInterval(pollMemoryAIOutput, 2000);
  // 立即执行一次
  pollMemoryAIOutput();
}

/**
 * 停止轮询
 */
function stopMemoryOutputPoll() {
  if (_memoryOutputPollTimer) {
    clearInterval(_memoryOutputPollTimer);
    _memoryOutputPollTimer = null;
  }
}

/**
 * 轮询后端获取新的记忆AI输出
 */
async function pollMemoryAIOutput() {
  try {
    // T6b批7：setdata {_action:getMemoryAIOutput} → sendAction beilu-memory#*（通配组装）。!ok 由门面抛错走 catch（原 !resp.ok return 等价）。
    const data = await sendAction({
      verb: "getMemoryAIOutput",
      target: "plugins:beilu-memory",
      source: "web",
      payload: { sinceId: _memoryOutputLastId },
    });
    if (!data.outputs || data.outputs.length === 0) return;

    // 渲染新输出
    renderMemoryAIOutputs(data.outputs);

    // 更新 lastId
    const maxId = Math.max(...data.outputs.map((o) => o.id));
    if (maxId > _memoryOutputLastId) _memoryOutputLastId = maxId;

    // 检查状态 — 如果最后一条是 done/error，启动自动清空倒计时
    const lastOutput = data.outputs[data.outputs.length - 1];
    if (lastOutput.status) {
      _memoryOutputCurrentStatus = lastOutput.status;
      updateMemoryOutputStatusUI(lastOutput.status);

      if (lastOutput.status === "done" || lastOutput.status === "error") {
        // 任务完成/出错，停止轮询避免无意义请求
        stopMemoryOutputPoll();
        // 取消之前的倒计时（如果有）
        if (_memoryOutputClearTimeout) clearTimeout(_memoryOutputClearTimeout);
        // 5秒后自动清空面板
        _memoryOutputClearTimeout = setTimeout(() => {
          clearMemoryOutputPanel();
          _memoryOutputClearTimeout = null;
        }, 5000);
      } else if (lastOutput.status === "running") {
        // running 状态取消之前的清空倒计时
        if (_memoryOutputClearTimeout) {
          clearTimeout(_memoryOutputClearTimeout);
          _memoryOutputClearTimeout = null;
        }
      }
    }
  } catch {
    // 静默失败
  }
}

/**
 * 渲染记忆AI输出到面板
 * @param {Array<object>} outputs - 输出条目数组
 */
function renderMemoryAIOutputs(outputs) {
  const panel = document.getElementById("memory-ai-output");
  const body = document.getElementById("memory-ai-output-body");
  if (!panel || !body) return;

  // 面板不自动弹出。如果面板当前不可见（用户未手动打开），只静默更新数据不渲染
  if (
    _memoryOutputDismissed ||
    _memoryAIPanelHidden ||
    panel.style.display === "none"
  )
    return;

  // 合并 v4 ②：气泡绘制改用共享渲染器（与 #3 tokenProgressBar 同源消重）。
  // #1 是内联流式观察者，保留无展开（expandable:false）+ 显示 thinking/operations（有则显）。
  outputs.forEach((output) => {
    body.appendChild(renderMemAiBubble(output, { expandable: false }));
  });

  // 自动滚动到底部
  body.scrollTop = body.scrollHeight;
}

/**
 * 更新状态标签 UI
 * @param {string} status - running/done/error
 */
function updateMemoryOutputStatusUI(status) {
  const statusEl = document.getElementById("memory-ai-output-status");
  if (!statusEl) return;

  statusEl.className = "memory-ai-output-status";
  switch (status) {
    case "running":
      statusEl.innerHTML = '<i data-ic="hourglass"></i> 处理中';
      statusEl.classList.add("status-running");
      break;
    case "done":
      statusEl.innerHTML = '<i data-ic="check"></i> 完成';
      statusEl.classList.add("status-done");
      break;
    case "error":
      statusEl.innerHTML = '<i data-ic="cross"></i> 出错';
      statusEl.classList.add("status-error");
      break;
    default:
      statusEl.textContent = "";
  }
}

/**
 * 清空面板并隐藏（自动或手动）
 */
async function clearMemoryOutputPanel() {
  const panel = document.getElementById("memory-ai-output");
  const body = document.getElementById("memory-ai-output-body");
  if (body) body.innerHTML = "";
  if (panel) panel.style.display = "none";
  _memoryOutputCurrentStatus = null;

  // 通知后端清空队列
  try {
    // T6b批7：setdata {_action:clearMemoryAIOutput} → sendAction beilu-memory#*（通配组装）。
    await sendAction({ verb: "clearMemoryAIOutput", target: "plugins:beilu-memory", source: "web" });
  } catch {
    /* 静默 */
  }

  // 不重置 _memoryOutputLastId，避免下次轮询重新获取已显示的旧消息导致无限循环

  const statusEl = document.getElementById("memory-ai-output-status");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.className = "memory-ai-output-status";
  }
}

/**
 * 初始化记忆AI输出面板（事件绑定 + 启动轮询）
 */
function initMemoryOutputPanel() {
  // 关闭按钮
  document
    .getElementById("memory-ai-output-close")
    ?.addEventListener("click", () => {
      _memoryOutputDismissed = true;
      const panel = document.getElementById("memory-ai-output");
      if (panel) panel.style.display = "none";
    });

  // 轮询不在页面加载时自动启动，改为按需启动（记忆AI操作触发时）
  // startMemoryOutputPoll()
}

export { toggleMemoryAIPanel, initMemoryAIPanelCollapse, loadInj2Status, handleToggleInj2, startMemoryOutputPoll, initMemoryOutputPanel };
